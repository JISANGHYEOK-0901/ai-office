// 사용자 확인: POST /api/tasks/:id/approve·reject(이어서 답하기 재사용, 세션 없으면 새 비서실장 실행),
// 직원 직접 지시의 산출물 폴더·업무 등록·세션 연결. 실제 claude 대신 가짜 CLAUDE_BIN(.js)을 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kstDate } from '../lib/paths.mjs';

const SID = '534fe6fd-3f42-4ef6-a141-ec3025f2b33f';
const SID2 = '11111111-2222-4333-8444-555555555555';
const TASK = '2026-10-29/html-page';

const ORG = {
  departments: [{ id: 'dev', name: '개발부', engine: 'claude', permission: 'acceptEdits', capabilities: ['HTML·웹 문서'] }],
  roster: [{ id: 'dev-2', name: '최대리', department: 'dev' }],
};

const FAKE = `const args = process.argv.slice(2);
const i = args.indexOf('--resume');
const sid = i >= 0 ? args[i + 1] : ${JSON.stringify(SID2)};
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: sid, args });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'INPUT:' + input, session_id: sid });
});
`;

function request(base, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 텍스트 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup(t, { tasks = [], runs = [], sessions = null, demo = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-approve-'));
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(ORG.departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(ORG.roster));
  mkdirSync(join(root, '.office', 'runs'), { recursive: true });
  writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify(tasks));
  writeFileSync(join(root, '.office', 'runs.json'), JSON.stringify(runs));
  if (sessions) writeFileSync(join(root, '.office', 'sessions.json'), JSON.stringify(sessions));
  mkdirSync(join(root, 'outputs', ...TASK.split('/')), { recursive: true });
  const bin = join(root, 'fake-claude.js');
  writeFileSync(bin, FAKE);
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  const { startServer } = await import('../dashboard/server.mjs');
  const handle = await startServer({ root, port: 0, quiet: true, demo, publicDir: join(root, 'public') });
  t.after(async () => {
    await handle.close();
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  assert.notEqual(handle.port, 4777);
  const base = `http://127.0.0.1:${handle.port}`;
  const auth = { 'X-Office-Token': handle.token, Origin: base, 'Content-Type': 'application/json' };
  const post = (path, body = {}, headers = auth) => request(base, 'POST', path, { body, headers });
  const read = (name) => JSON.parse(readFileSync(join(root, '.office', name), 'utf8'));
  const events = () => readFileSync(join(root, '.office', 'events.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  return { root, base, auth, post, read, events, handle };
}

const reviewTask = (o = {}) => ({ id: TASK, title: 'HTML 페이지', status: 'review', created: '2026-10-29T01:00:00.000Z', ...o });

test('approve: review → done, flow.user_approve·task.update 기록, 상태·토큰·Origin 검사', async (t) => {
  const { base, post, read, events } = await setup(t, { tasks: [reviewTask(), { id: '2026-10-29/active-one', title: 'x', status: 'active' }] });
  assert.equal((await post(`/api/tasks/${TASK}/approve`, {}, { Origin: base, 'Content-Type': 'application/json' })).status, 403);
  const before = await request(base, 'GET', '/api/state');
  assert.deepEqual(before.json.attention.map((a) => [a.kind, a.task]), [['approve', TASK]]);

  const ok = await post(`/api/tasks/${encodeURIComponent(TASK)}/approve`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.task.status, 'done');
  assert.equal(read('tasks.json')[0].status, 'done');
  const evs = events();
  assert.deepEqual(evs.map((e) => e.kind), ['flow.user_approve', 'task.update']);
  assert.equal(evs[1].status, 'done');
  assert.ok(evs.every((e) => e.agent === undefined), '사용자 행동 이벤트는 직원으로 세지 않는다');

  const again = await post(`/api/tasks/${TASK}/approve`);
  assert.equal(again.status, 409);
  assert.match(again.json.error, /사용자 확인 대기 상태인 업무만/);
  assert.equal((await post('/api/tasks/2026-10-29/active-one/approve')).status, 409);
  assert.equal((await post('/api/tasks/2026-10-29/none/approve')).status, 404);
  assert.equal((await post('/api/tasks/..%2F..%2Fx/approve')).status, 400);
  const after = await request(base, 'GET', '/api/state');
  assert.ok(!after.json.attention.some((a) => a.kind === 'approve'));
});

test('reject: 업무 세션의 비서실장 실행에 이어서 답하기(--resume)로 피드백 전달, 업무는 active로', async (t) => {
  const runs = [{ id: 'q-1', target: 'chief', agentId: null, engine: 'claude', request: '조사', status: 'done', createdAt: '2026-10-29T01:00:00.000Z', summary: '완료', sessionId: SID, rootId: 'q-1', parentId: null, needsReply: false, model: null }];
  const { root, post, read, events } = await setup(t, { tasks: [reviewTask()], runs, sessions: { [SID]: TASK } });
  assert.equal((await post(`/api/tasks/${TASK}/reject`, { feedback: '  ' })).status, 400);
  const r = await post(`/api/tasks/${TASK}/reject`, { feedback: '색을 바꿔 주세요. password=hunter2' });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.mode, 'reply');
  assert.equal(r.json.run.parentId, 'q-1');
  assert.equal(r.json.run.task, TASK);
  // 실행 목록·대화 스레드에는 시스템 프롬프트가 아니라 대표의 피드백 요약을 보여준다
  assert.match(r.json.run.request, /^사용자 반려: 색을 바꿔 주세요/);
  assert.doesNotMatch(r.json.run.request, /\[사용자 반려\]|업무 2026/);
  const id = r.json.run.id;
  await waitFor(() => existsSync(join(root, '.office', 'runs', `${id}.result.md`)));
  const log = readFileSync(join(root, '.office', 'runs', `${id}.log`), 'utf8');
  assert.match(log, new RegExp(`"--resume","${SID}"`));
  assert.match(log, /--append-system-prompt/, '비서실장 답장에도 현재 조직도를 주입한다');
  const result = readFileSync(join(root, '.office', 'runs', `${id}.result.md`), 'utf8');
  assert.match(result, /\[사용자 반려\] 업무 2026-10-29\/html-page/);
  assert.match(result, /색을 바꿔 주세요/);
  assert.match(result, new RegExp(`flow ${TASK} deliver`));
  const task = read('tasks.json')[0];
  assert.equal(task.status, 'active');
  assert.equal(task.userRejects, 1);
  const rej = events().find((e) => e.kind === 'flow.user_reject');
  assert.equal(rej.task, TASK);
  assert.match(rej.summary, /색을 바꿔 주세요/);
  assert.doesNotMatch(rej.summary, /hunter2/, '피드백 요약도 비밀값을 가린다');
  assert.equal((await post(`/api/tasks/${TASK}/reject`, { feedback: '다시' })).status, 409, '이미 active면 반려할 수 없다');
});

test('reject: 세션이 없으면 새 비서실장 실행을 띄우고 새 세션을 업무에 연결한다', async (t) => {
  const { root, post, read } = await setup(t, { tasks: [reviewTask()] });
  const r = await post(`/api/tasks/${TASK}/reject`, { feedback: '표를 추가해 주세요' });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.mode, 'new');
  assert.equal(r.json.run.target, 'chief');
  assert.equal(r.json.run.parentId, null);
  const id = r.json.run.id;
  await waitFor(() => existsSync(join(root, '.office', 'runs', `${id}.result.md`)));
  const log = readFileSync(join(root, '.office', 'runs', `${id}.log`), 'utf8');
  assert.doesNotMatch(log, /--resume/);
  assert.match(log, /--append-system-prompt/);
  assert.match(readFileSync(join(root, '.office', 'runs', `${id}.result.md`), 'utf8'), /산출물 폴더: outputs\/2026-10-29\/html-page\//);
  await waitFor(() => existsSync(join(root, '.office', 'sessions.json')));
  assert.equal(read('sessions.json')[SID2], TASK);
});

test('직원 직접 지시: outputs/<날짜>/run-<id>/ 생성·업무 등록·저장 경로 덧붙임·세션 연결', async (t) => {
  const { root, post, read, events } = await setup(t);
  const r = await post('/api/runs', { agentId: 'dev-2', prompt: '견적서 HTML 만들어 줘' });
  assert.equal(r.status, 202, r.text);
  const id = r.json.id;
  const taskId = `${kstDate()}/run-${id}`;
  assert.equal(r.json.task, taskId);
  assert.ok(existsSync(join(root, 'outputs', kstDate(), `run-${id}`)));
  const task = read('tasks.json').find((x) => x.id === taskId);
  assert.deepEqual([task.status, task.run, task.agent], ['active', id, 'dev-2']);
  assert.match(task.title, /^최대리: 견적서 HTML/);
  await waitFor(() => existsSync(join(root, '.office', 'runs', `${id}.result.md`)));
  const result = readFileSync(join(root, '.office', 'runs', `${id}.result.md`), 'utf8');
  assert.match(result, new RegExp(`^INPUT:견적서 HTML 만들어 줘\\n\\n\\[저장 위치\\] 이 작업의 산출물은 이 폴더에 저장하세요: outputs/${taskId}/`));
  assert.equal(read('sessions.json')[SID2], taskId);
  const start = events().find((e) => e.kind === 'task.start');
  assert.deepEqual([start.task, start.agent], [taskId, 'dev-2']);
  const log = readFileSync(join(root, '.office', 'runs', `${id}.log`), 'utf8');
  assert.doesNotMatch(log, /--append-system-prompt/, '직원 실행에는 조직도를 주입하지 않는다');
});

test('데모 모드에서는 승인·반려할 수 없다', async (t) => {
  const { post } = await setup(t, { tasks: [reviewTask()], demo: true });
  assert.equal((await post(`/api/tasks/${TASK}/approve`)).status, 409);
  assert.equal((await post(`/api/tasks/${TASK}/reject`, { feedback: 'x' })).status, 409);
});

test('approve: 그 업무에 연결된 실행의 답변 필요(needsReply)를 끄고 reply 아이콘을 지운다', async (t) => {
  const runs = [
    { id: 'q-1', target: 'chief', agentId: null, engine: 'claude', request: '조사', status: 'done', createdAt: '2026-10-29T01:00:00.000Z', endedAt: '2026-10-29T01:05:00.000Z', summary: '확인할까요?', sessionId: SID, rootId: 'q-1', parentId: null, needsReply: true, model: null, task: TASK },
    { id: 'q-2', target: 'chief', agentId: null, engine: 'claude', request: '다른 일', status: 'done', createdAt: '2026-10-29T01:00:00.000Z', endedAt: '2026-10-29T01:06:00.000Z', summary: '어느 쪽?', sessionId: SID2, rootId: 'q-2', parentId: null, needsReply: true, model: null },
  ];
  const { base, post, read } = await setup(t, { tasks: [reviewTask()], runs, sessions: { [SID]: TASK } });
  const before = await request(base, 'GET', '/api/state');
  assert.deepEqual(before.json.attention.map((a) => a.kind).sort(), ['approve', 'reply'], '확인 대기 업무의 reply는 approve가 대신 보여준다');
  assert.equal((await post(`/api/tasks/${TASK}/approve`)).status, 200);
  const stored = read('runs.json');
  assert.equal(stored.find((r) => r.id === 'q-1').needsReply, false);
  assert.equal(stored.find((r) => r.id === 'q-2').needsReply, true, '다른 업무의 실행은 그대로');
  const after = await request(base, 'GET', '/api/state');
  assert.deepEqual(after.json.attention.map((a) => [a.kind, a.runId]), [['reply', 'q-2']]);
});
