import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRunner } from '../dashboard/runner.mjs';
import { monitorFile } from '../dashboard/continuous.mjs';
import { loadTasks } from '../lib/tasks.mjs';
import { writePrivate } from '../lib/private-state.mjs';

const wait = async (fn) => { const deadline = Date.now() + 6000; while (!fn()) { if (Date.now() > deadline) throw new Error('감시 실행 대기 초과'); await new Promise((r) => setTimeout(r, 10)); } };
function fixture(t, discovery = false, question = '') {
  const root = mkdtempSync(join(tmpdir(), 'office-watch-runner-'));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org/departments.json'), JSON.stringify([{ id: 'research', name: '리서치', engine: 'codex', codexRole: 'exec' }, { id: 'dev', name: '개발', engine: 'codex', codexRole: 'exec' }]));
  writeFileSync(join(root, 'org/roster.json'), JSON.stringify([{ id: 'research-1', name: '김대리', department: 'research' }, { id: 'dev-1', name: '이팀장', department: 'dev' }]));
  const calls = [];
  const spawnImpl = (_bin, args, opts) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = '', closed = false;
    const finish = (result, code = 0) => {
      if (closed) return; closed = true;
      if (result) child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }) + '\n');
      child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code));
    };
    child.kill = () => { finish(null, 1); return true; };
    child.stdin.on('data', (c) => input += c);
    child.stdin.on('finish', () => setImmediate(() => {
      const schema = args[args.indexOf('--output-schema') + 1]; calls.push({ schema, input });
      if (schema.endsWith('watch-plan.json')) finish({ agent: 'research-1', instructions: '새 자료만 확인', deliveryPrompt: '개발부 정리 후 비서실장 검토', question: '' });
      else if (schema.endsWith('watch.json')) finish({ cursor: 'cursor-kept', question, items: discovery ? [{ key: 'news-1', title: '자료', summary: '새 자료', url: 'https://example.invalid' }] : [] });
      else if (schema.endsWith('plan.json')) {
        const task = input.match(/업무 id: ([\d-]+\/run-[\w-]+)\./)[1];
        finish({ question: '', plan: { version: 1, task, goal: '후속 보고', stages: [{ id: 'a', title: '정리', agent: 'dev-1', dept: 'dev', inputs: [], output: `outputs/${task}/dev/dev-1-data.txt`, done: '자료 정리', dependsOn: [] }], review: { by: 'chief', criteria: '확인' }, gaps: [] }, rerunStages: [] });
      } else if (schema.endsWith('stage.json')) {
        const path = join(opts.cwd, input.match(/\n출력: ([^\n]+)/)[1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '검토할 새 자료'); finish({ status: 'done', summary: '정리 완료' });
      } else finish({ verdict: 'pass', report: '# 완료\n\n후속 보고를 확인했습니다.', reason: '확인', question: '' });
    }));
    return child;
  };
  let runner = createRunner({ root, spawnImpl, killGraceMs: 5 });
  t.after(async () => { await runner.stopAll({ graceMs: 5 }); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { root, calls, get runner() { return runner; }, restart() { runner = createRunner({ root, spawnImpl, killGraceMs: 5 }); } };
}

test('감시 부모는 계속 실행되고 후속 보고는 별도 업무로 완료된다', async (t) => {
  const f = fixture(t, true);
  const run = f.runner.start({ prompt: '계속 감시하고 새 자료 뜨면 보고해 줘', continuous: { intervalMs: 10000 } });
  await wait(() => f.runner.list().some((r) => r.monitorId === run.rootId && !r.phase && r.status === 'done'));
  const current = f.runner.list().find((r) => r.id === run.id);
  assert.equal(current.status, 'running'); assert.equal(current.monitor.discoveries, 1);
  const report = f.runner.list().find((r) => r.monitorId === run.rootId);
  assert.equal(report.continuous, undefined);
  assert.equal(loadTasks(f.root).find((task) => task.id === report.task).status, 'done');
  f.runner.stop(run.id); await wait(() => f.runner.list().find((r) => r.id === run.id).status === 'stopped');
  assert.equal(JSON.parse(readFileSync(monitorFile(f.root, run.rootId))).desired, false);
});

test('서버 종료는 체크포인트를 남기고 재시작 후 같은 업무·커서로 자동 복구한다', async (t) => {
  const f = fixture(t);
  const run = f.runner.start({ agentId: 'research-1', prompt: '계속 조사해 줘', continuous: { intervalMs: 10000 } });
  await wait(() => f.runner.list().find((r) => r.id === run.id)?.monitor?.cycles === 1);
  await f.runner.stopAll({ graceMs: 5 });
  const file = monitorFile(f.root, run.rootId), saved = JSON.parse(readFileSync(file));
  assert.equal(saved.desired, true); assert.equal(saved.status, 'suspended');
  saved.nextAt = Date.now() - 1; writePrivate(file, saved);
  f.restart(); const resumed = f.runner.restoreContinuous(); assert.equal(resumed.length, 1);
  assert.equal(resumed[0].task, run.task);
  await wait(() => f.calls.filter((c) => c.schema.endsWith('watch.json')).length === 2);
  assert.match(f.calls.at(-1).input, /cursor-kept/);
  f.runner.stop(resumed[0].id); await wait(() => f.runner.list().find((r) => r.id === resumed[0].id).status === 'stopped');
  f.restart(); assert.equal(f.runner.restoreContinuous().length, 0);
});

test('대표 결정 대기 중에도 중지 명령으로 감시를 끝내며 재시작하지 않는다', async (t) => {
  const f = fixture(t, false, '조사 범위를 결정해 주세요.');
  const run = f.runner.start({ agentId: 'research-1', prompt: '계속 조사해 줘', continuous: { intervalMs: 10000 } });
  await wait(() => f.runner.list().find((r) => r.id === run.id)?.needsReply);
  assert.equal(f.runner.restoreContinuous().length, 0);
  f.runner.reply(run.id, { prompt: '중지' });
  const stopped = f.runner.list().find((r) => r.id === run.id);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.needsReply, false);
  assert.equal(JSON.parse(readFileSync(monitorFile(f.root, run.rootId))).desired, false);
  f.restart(); assert.equal(f.runner.restoreContinuous().length, 0);
});

test('대표 결정 중 지정 시간이 지나면 추가 AI 호출 없이 감시를 마감한다', async (t) => {
  const f = fixture(t, false, '조사 범위를 결정해 주세요.');
  const run = f.runner.start({ agentId: 'research-1', prompt: '24시간 조사해 줘', continuous: { intervalMs: 10000, durationMs: 86400000 } });
  await wait(() => f.runner.list().find((r) => r.id === run.id)?.needsReply);
  const file = monitorFile(f.root, run.rootId), state = JSON.parse(readFileSync(file));
  state.deadlineAt = Date.now() - 1; writePrivate(file, state);
  const calls = f.calls.length;
  const [ended] = f.runner.restoreContinuous({ expiredOnly: true });
  await wait(() => f.runner.list().find((r) => r.id === ended.id)?.status === 'done');
  assert.equal(f.calls.length, calls);
  assert.equal(JSON.parse(readFileSync(file)).desired, false);
  assert.equal(loadTasks(f.root).find((task) => task.id === run.task).status, 'done');
  assert.equal(f.runner.restoreContinuous().length, 0);
});
