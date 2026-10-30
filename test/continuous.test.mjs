import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuousRequest } from '../lib/continuous.mjs';
import { runContinuous, monitorFile } from '../dashboard/continuous.mjs';
import { addTask, loadTasks } from '../lib/tasks.mjs';

test('무기한/24시간·확인 간격을 구분하고 내부 후속 업무는 다시 감시로 만들지 않는다', () => {
  assert.deepEqual(continuousRequest('계속 대기하다 새로운 자료 뜨면 전달해 줘'), { durationMs: null, intervalMs: 300000 });
  assert.deepEqual(continuousRequest('24시간 동안 시장조사, 1분마다 확인'), { durationMs: 86400000, intervalMs: 60000 });
  assert.deepEqual(continuousRequest('every 5 minutes keep monitoring'), { durationMs: null, intervalMs: 300000 });
  assert.equal(continuousRequest('24시간 시장조사', false), null);
  assert.equal(continuousRequest('이번 자료만 정리해 줘'), null);
  assert.throws(() => continuousRequest('계속 감시해 줘', { intervalMs: 0 }), /간격/);
  assert.equal(continuousRequest('내일 9시까지 계속 감시', undefined, { now: Date.parse('2026-10-30T13:00:00+09:00') }).deadlineAt, Date.parse('2026-10-31T09:00:00+09:00'));
  assert.equal(continuousRequest('2026-10-31 18:30까지 시장조사', undefined, { now: Date.parse('2026-10-30T13:00:00+09:00') }).deadlineAt, Date.parse('2026-10-31T18:30:00+09:00'));
  assert.throws(() => continuousRequest('계속 조사', 'invalid'), /설정/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-continuous-'));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org/departments.json'), JSON.stringify([{ id: 'research', name: '리서치부', engine: 'codex', codexRole: 'exec' }]));
  writeFileSync(join(root, 'org/roster.json'), JSON.stringify([{ id: 'research-1', name: '김대리', department: 'research' }]));
  const run = { id: 'first', rootId: 'monitor', task: '2026-10-30/monitor-test', engine: 'codex' };
  addTask(root, { id: run.task, title: '지속 감시', status: 'active', created: new Date().toISOString() });
  const controller = new AbortController();
  let clock = 0;
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const deliveries = [], states = new Map();
  const options = { agentId: 'research-1', durationMs: 86400000, intervalMs: 43200000 };
  const params = { root, run, prompt: '24시간 자료 감시', options, signal: controller.signal,
    now: () => clock, sleep: async (ms) => { clock += ms; },
    dispatch: (batch) => { const child = { id: `child-${deliveries.length}`, task: `2026-10-30/report-${deliveries.length}`, status: 'running' }; deliveries.push(batch); states.set(child.id, child); return child; },
    deliveryState: (id) => states.get(id),
  };
  return { root, run, controller, deliveries, params, now: () => clock };
}

test('24시간 가상 시계: 보고가 진행 중이어도 계속 확인하고 같은 자료는 재전달하지 않는다', async (t) => {
  const f = fixture(t); let checks = 0;
  const report = await runContinuous({ ...f.params, execute: async () => { checks++; return JSON.stringify({ cursor: 'next', question: '', items: [{ key: 'news-1', title: '새 소식', summary: '원문 확인', url: 'https://example.invalid/news', observedAt: '2026-10-30' }] }); } });
  assert.equal(f.now(), 86400000);
  assert.equal(checks, 2);
  assert.equal(f.deliveries.length, 1);
  assert.match(report, /새 자료 1건/);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('수집 종료 직전 자료도 전달하고 무한 감시는 사용자 중지까지 유지한다', async (t) => {
  const f = fixture(t); let checks = 0;
  await runContinuous({ ...f.params, options: { ...f.params.options, durationMs: 30000, intervalMs: 10000 }, execute: async () => {
    checks++; if (checks === 3) assert.equal(f.deliveries.length, 2);
    return JSON.stringify({ cursor: '', question: '', items: [{ key: `news-${checks}`, title: '자료', summary: '내용' }] });
  } });
  assert.equal(f.deliveries.length, 3);
  const second = fixture(t); let rounds = 0;
  await assert.rejects(runContinuous({ ...second.params, options: { ...second.params.options, durationMs: null, intervalMs: 10000 }, execute: async () => {
    if (++rounds === 3) second.controller.abort('user-stop');
    return JSON.stringify({ question: '', items: [] });
  } }), (error) => error === 'user-stop');
  const saved = JSON.parse(readFileSync(monitorFile(second.root, second.run.rootId)));
  assert.equal(saved.desired, false);
  assert.equal(saved.status, 'stopped');
});

test('서버 종료 후 원래 종료 시각·커서·중복 제거 상태를 유지해 재개한다', async (t) => {
  const f = fixture(t); let rounds = 0;
  await assert.rejects(runContinuous({ ...f.params, execute: async () => {
    if (++rounds === 2) f.controller.abort('server-shutdown');
    return JSON.stringify({ cursor: 'saved-cursor', question: '', items: [{ key: 'one', title: '자료', summary: '내용' }] });
  } }), (error) => error === 'server-shutdown');
  const saved = JSON.parse(readFileSync(monitorFile(f.root, f.run.rootId)));
  assert.equal(saved.desired, true);
  assert.equal(saved.cursor, 'saved-cursor');
  const second = new AbortController();
  await runContinuous({ ...f.params, run: { ...f.run, id: 'second' }, prompt: '이어서 재개', signal: second.signal,
    execute: async ({ prompt }) => { assert.match(prompt, /saved-cursor/); return JSON.stringify({ question: '', items: [{ key: 'one', title: '자료', summary: '내용' }] }); } });
  const resumed = JSON.parse(readFileSync(monitorFile(f.root, f.run.rootId)));
  assert.equal(resumed.deadlineAt, saved.deadlineAt);
  assert.equal(f.deliveries.length, 1);
});

test('일시 확인 실패가 반복되어도 감시는 종료하지 않고 backoff 후 복구한다', async (t) => {
  const f = fixture(t); let calls = 0;
  await runContinuous({ ...f.params, options: { ...f.params.options, durationMs: 100000, intervalMs: 10000 }, execute: async () => {
    if (++calls < 4) throw new Error('일시 오류');
    return JSON.stringify({ question: '', items: [] });
  } });
  assert.ok(calls >= 4);
  const state = JSON.parse(readFileSync(monitorFile(f.root, f.run.rootId)));
  assert.equal(state.status, 'finished'); assert.ok(state.cycles > 0);
});

test('담당 계획 도중 중지해도 사용자 중지는 영구 보존한다', async (t) => {
  const f = fixture(t);
  await assert.rejects(runContinuous({ ...f.params, options: { ...f.params.options, agentId: null }, execute: async () => {
    f.controller.abort('user-stop'); throw new Error('중지됨');
  } }));
  const state = JSON.parse(readFileSync(monitorFile(f.root, f.run.rootId)));
  assert.equal(state.desired, false); assert.equal(state.status, 'stopped');
});
