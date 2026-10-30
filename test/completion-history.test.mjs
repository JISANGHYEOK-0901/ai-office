import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.mjs';
import { collectFinalOutputs } from '../lib/final-outputs.mjs';
import { historySelection } from '../lib/history.mjs';

const TASK = '2026-10-30/finished', PENDING = '2026-10-30/pending';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-completion-'));
  for (const path of ['org', '.office/runs', '.office/publications', '.office/orchestrations', `outputs/${TASK}`]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'org/departments.json'), '[]');
  writeFileSync(join(root, 'org/roster.json'), '[]');
  writeFileSync(join(root, 'outputs', TASK, 'report.md'), '# 완료한 업무\n\n원본을 대조했습니다.');
  writeFileSync(join(root, 'outputs', TASK, 'result.html'), '<!doctype html><html><head><title>최종 결과</title></head><body>확인한 결과입니다.</body></html>');
  writeFileSync(join(root, 'outputs', TASK, 'draft.json'), '{"intermediate":true}');
  const plan = { deliverables: ['final'], stages: [{ id: 'final', output: 'result.html', dependsOn: [] }] };
  writeFileSync(join(root, 'outputs', TASK, 'plan.json'), JSON.stringify(plan));
  collectFinalOutputs(root, { task: TASK, title: '검토한 결과', plan });
  const tasks = [{ id: TASK, title: '검토한 결과', status: 'review', updated: '2026-10-30T01:00:00Z' },
    { id: PENDING, title: '답변 기다리는 업무', status: 'blocked' }];
  writeFileSync(join(root, '.office/tasks.json'), JSON.stringify(tasks));
  writeFileSync(join(root, '.office/runs.json'), JSON.stringify([
    { id: 'finished-run', rootId: 'finished-run', task: TASK, status: 'done', sessionId: 'finished-session' },
    { id: 'pending-run', rootId: 'pending-run', task: PENDING, status: 'done', needsReply: true },
  ]));
  writeFileSync(join(root, '.office/runs/finished-run.log'), '완료 실행 로그');
  writeFileSync(join(root, '.office/runs/finished-run.result.md'), '완료한 답변');
  writeFileSync(join(root, '.office/runs/pending-run.log'), '결정 대기 로그');
  writeFileSync(join(root, '.office/orchestrations/finished-run.json'), '{}');
  writeFileSync(join(root, '.office/publications/sent.json'), '{"status":"confirmed","immutable":true}');
  writeFileSync(join(root, '.office/sessions.json'), JSON.stringify({ 'finished-session': TASK, 'pending-session': PENDING }));
  writeFileSync(join(root, '.office/events.jsonl'), [TASK, PENDING].map((task) => JSON.stringify({ ts: '2026-10-30T01:00:00Z', task, kind: 'task.start', session: 'office-fixture', agent: 'chief' })).join('\n') + '\n');
  const server = await startServer({ root, port: 0, quiet: true, env: { ...process.env, CLAUDE_BIN: join(root, 'no-claude'), CODEX_BIN: join(root, 'no-codex') } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (method, path, auth = true) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(auth ? { 'X-Office-Token': server.token } : {}) } });
    return { status: response.status, data: await response.json() };
  };
  return { root, api };
}

test('검토·최종 전달을 마친 옛 승인 대기를 완료로 바꾸고 읽음만 별도로 기록한다', async (t) => {
  const { root, api } = await fixture(t);
  const initial = (await api('GET', '/api/state')).data;
  assert.equal(initial.tasks.find((task) => task.id === TASK).status, 'done');
  assert.ok(initial.attention.some((item) => item.kind === 'complete' && item.task === TASK));
  assert.ok(!initial.attention.some((item) => item.kind === 'approve'));
  assert.equal((await api('POST', `/api/tasks/${encodeURIComponent(TASK)}/seen`, false)).status, 403);
  assert.equal((await api('POST', `/api/tasks/${encodeURIComponent(TASK)}/seen`)).status, 200);
  const viewed = (await api('GET', '/api/state')).data;
  assert.equal(viewed.tasks.find((task) => task.id === TASK).status, 'done');
  assert.ok(viewed.tasks.find((task) => task.id === TASK).resultSeenAt);
  assert.ok(!viewed.attention.some((item) => item.task === TASK));
  assert.doesNotMatch(readFileSync(join(root, '.office/events.jsonl'), 'utf8'), /flow.user_approve/);
});

test('종료 내역 초기화는 대화·로그만 정리하고 결정 대기·최종 파일·발송 증표를 보존한다', async (t) => {
  const { root, api } = await fixture(t);
  const sent = readFileSync(join(root, '.office/publications/sent.json'), 'utf8');
  assert.equal((await api('DELETE', '/api/history', false)).status, 403);
  assert.ok(existsSync(join(root, '.office/runs/finished-run.log')));
  const cleared = await api('DELETE', '/api/history');
  assert.equal(cleared.status, 200); assert.equal(cleared.data.removedTasks, 1); assert.equal(cleared.data.removedRuns, 1);
  const state = (await api('GET', '/api/state')).data;
  assert.deepEqual(state.runs.map((run) => run.id), ['pending-run']);
  assert.deepEqual(state.tasks.map((task) => task.id), [PENDING]);
  assert.ok(state.attention.some((item) => item.kind === 'reply'));
  assert.ok(!state.feed.some((event) => event.task === TASK));
  assert.ok(!existsSync(join(root, '.office/runs/finished-run.log')));
  assert.ok(!existsSync(join(root, '.office/runs/finished-run.result.md')));
  assert.ok(!existsSync(join(root, '.office/orchestrations/finished-run.json')));
  assert.ok(existsSync(join(root, '.office/runs/pending-run.log')));
  assert.equal(readFileSync(join(root, '.office/publications/sent.json'), 'utf8'), sent);
  const outputs = (await api('GET', '/api/outputs')).data.outputs;
  assert.ok(outputs.find((item) => item.id === TASK)?.finalOutput);
  const files = (await api('GET', `/api/outputs/${encodeURIComponent(TASK)}/files`)).data;
  assert.ok(files.final.files.some((file) => file.name === 'result.html'));
  assert.ok(!files.final.files.some((file) => file.name === 'draft.json'));
  assert.equal((await api('DELETE', '/api/history')).data.removedRuns, 0);
});

test('실행 중인 단계의 앞선 실행과 감시·후속 보고의 연결은 초기화하지 않는다', () => {
  const runs = [
    { id: 'monitor', rootId: 'monitor', task: 'M', status: 'done' },
    { id: 'report-old', rootId: 'report', monitorId: 'monitor', task: 'R', status: 'done' },
    { id: 'report-live', rootId: 'report', monitorId: 'monitor', task: 'R', status: 'running' },
    { id: 'finished', rootId: 'finished', task: 'F', status: 'done' },
  ];
  const selection = historySelection(runs, [{ id: 'M', status: 'done' }, { id: 'R', status: 'active' }, { id: 'F', status: 'done' }]);
  assert.deepEqual(selection.removed.map((run) => run.id), ['finished']);
  assert.deepEqual(selection.taskIds, ['F']);
  assert.equal(historySelection([{ id: 'monitor', continuous: true, status: 'done' }], [], new Set(['monitor'])).removed.length, 0);
});
