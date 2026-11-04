// 터미널 AI의 지시 넣기: 서버 접속 정보, 지시창과 같은 API 호출, 대시보드가 실행한 AI의 사용 차단
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_ACCESS, insideOfficeRun, readDashboardAccess, writeDashboardAccess } from '../lib/dashboard-access.mjs';
import { createClient, describe, parseArgs } from '../scripts/office-ask.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('접속 정보는 본인만 읽고, 서버가 꺼졌거나 다른 서버가 남긴 기록은 쓰지 않는다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-ask-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = writeDashboardAccess(root, { url: 'http://127.0.0.1:4777/', token: 'a'.repeat(64) });
  assert.deepEqual(readDashboardAccess(root), { url: 'http://127.0.0.1:4777/', token: 'a'.repeat(64) });
  if (process.platform !== 'win32') assert.equal(statSync(join(root, DASHBOARD_ACCESS)).mode & 0o777, 0o600);
  release();
  assert.equal(existsSync(join(root, DASHBOARD_ACCESS)), false);
  writeDashboardAccess(root, { url: 'http://127.0.0.1:1/', token: 'b', pid: 2 ** 22 + 12345 });
  assert.equal(readDashboardAccess(root), null, '꺼진 서버의 기록은 쓰지 않는다');
  assert.equal(insideOfficeRun({ OFFICE_AI_RUN: '1' }), true);
  assert.equal(insideOfficeRun({ OFFICE_CHIEF_RUN: '1' }), true);
  assert.equal(insideOfficeRun({ AI_OFFICE_WORKSPACE: '/w' }), false, '작업 공간 지정만으로는 막지 않는다');
});

test('명령 인자: 지시문·답장·대기 시간·작업 공간', () => {
  assert.deepEqual(parseArgs(['ask', '카페에', '글 올려줘']), { command: 'ask', args: ['카페에', '글 올려줘'], timeout: 600, workspace: null });
  assert.deepEqual(parseArgs(['wait', 'r1', '--timeout', '30', '--workspace=/w']), { command: 'wait', args: ['r1'], timeout: 30, workspace: '/w' });
});

test('실제 서버: 켜지면 접속 정보를 남기고, 지시창과 같은 API(토큰·Origin·JSON)로 부르며, 꺼지면 지운다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-ask-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), '[]\n');
  writeFileSync(join(root, 'org', 'roster.json'), '[]\n');
  const publicDir = join(root, 'public'); mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><meta name="office-token" content="__OFFICE_TOKEN__"><title>t</title>');
  const { startServer } = await import('../dashboard/server.mjs');
  const handle = await startServer({ root, port: 0, publicDir, quiet: true });
  try {
    const access = readDashboardAccess(root);
    assert.equal(access.url, handle.url); assert.equal(access.token, handle.token);
    const client = createClient(access);
    assert.ok(Array.isArray((await client.state()).runs));
    // 쓰기 요청이 Origin·Content-Type 검사를 통과해 실행기까지 간다(없는 실행이라 실행기가 거부)
    await assert.rejects(client.reply('missing-run', '진행'), (err) => !/403|415/.test(err.message) && /대시보드가 요청을 거부했습니다\(\d+\)/.test(err.message));
    await assert.rejects(createClient({ ...access, token: 'x'.repeat(64) }).result('missing-run'), /403/, '틀린 인증값은 거부된다');
    // 대화 목록 출력: 단계 실행(phase)은 숨기고 답변 필요·마지막 질문을 보여 준다
    const fake = { state: async () => ({ runs: [{ id: 'r1', request: '카페 글', status: 'done', needsReply: true }, { id: 'r1-stage', phase: 'stage', status: 'running' }] }), result: async () => '어느 게시판에 올릴까요?' };
    const shown = await describe(fake, 'r1');
    assert.match(shown.text, /\[답변 필요\] r1 · 카페 글/); assert.match(shown.text, /reply 하세요/); assert.match(shown.text, /어느 게시판/);
    await assert.rejects(describe(fake, 'r1-stage'), /찾을 수 없습니다/);
  } finally { await handle.close(); }
  assert.equal(readDashboardAccess(root), null);
  assert.equal(existsSync(join(root, DASHBOARD_ACCESS)), false, '서버가 꺼지면 접속 정보를 지운다');
});

test('대시보드가 실행한 AI(비서실장·직원)는 지시·답장을 넣지 못하고, 서버가 꺼져 있으면 켜라고 안내한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-ask-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (env) => spawnSync(process.execPath, [join(REPO, 'scripts/office-ask.mjs'), 'ask', '메일 보내줘', '--workspace', root], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const blocked = run({ OFFICE_AI_RUN: '1' });
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /업무 실행 중인 AI는/);
  const off = run({ OFFICE_AI_RUN: '', OFFICE_CHIEF_RUN: '', OFFICE_ORCHESTRATOR_CHILD: '' });
  assert.equal(off.status, 1); assert.match(off.stderr, /서버가 꺼져 있거나/);
  assert.ok(!readFileSync(join(REPO, 'lib/workspace.mjs'), 'utf8').includes("'office-ask.mjs'"), '작업 공간(비서실장)에는 연결 파일을 만들지 않는다');
});
