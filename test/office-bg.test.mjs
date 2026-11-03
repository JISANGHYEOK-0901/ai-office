// npm run office:start/stop/status: 서버를 세션과 분리해 띄우고, 실행 표식으로 상태를 보고 끈다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPidAlive, runningServer } from '../lib/server-lock.mjs';

const BG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'office-bg.mjs');

function freePort() {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
  });
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['AI_OFFICE_ROOT', 'CLAUDE_PROJECT_DIR', 'OFFICE_CHIEF_RUN', 'NODE_TEST_CONTEXT']) delete env[k];
  return env;
}

test('office-bg: start는 서버를 분리해 띄우고 주소를 알린 뒤 끝나며, 다시 start·status·stop이 실행 표식을 따른다', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'office-bg-ws-'));
  const logs = mkdtempSync(join(tmpdir(), 'office-bg-log-'));
  const port = await freePort();
  const env = cleanEnv({ AI_OFFICE_WORKSPACE: ws, AI_OFFICE_BG_LOG_DIR: logs, CLAUDE_BIN: join(ws, 'none'), CODEX_BIN: join(ws, 'none') });
  const run = (...args) => spawnSync(process.execPath, [BG, ...args], { env, encoding: 'utf8', timeout: 60000 });
  t.after(async () => {
    const info = runningServer(ws);
    if (info) try { process.kill(info.pid, 'SIGKILL'); } catch { /* 이미 종료 */ }
    await rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(logs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const started = run('start', '--port', String(port));
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.stdout, new RegExp(`서버를 켰습니다: http://127\\.0\\.0\\.1:${port}/`));
  const info = runningServer(ws);
  assert.ok(info && isPidAlive(info.pid), '시작 명령이 끝난 뒤에도 서버가 살아 있다');
  assert.equal(info.port, port);
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.status, 200);
  assert.ok(existsSync(join(logs, 'server.log')), '서버 기록은 지정한 폴더에 남는다');

  const again = run('start', '--port', String(port));
  assert.equal(again.status, 0);
  assert.match(again.stdout, /이미 실행 중입니다/);
  assert.equal(runningServer(ws).pid, info.pid, '두 번째 서버를 띄우지 않는다');

  assert.match(run('status').stdout, new RegExp(`실행 중: http://127\\.0\\.0\\.1:${port}/`));

  const stopped = run('stop');
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /서버를 껐습니다/);
  assert.equal(isPidAlive(info.pid), false);
  assert.equal(runningServer(ws), null);
  assert.match(run('status').stdout, /꺼져 있습니다/);
  assert.match(run('stop').stdout, /실행 중인 AI Office 서버가 없습니다/);
});

test('office-bg: 서버가 시작하지 못하면 기록 끝부분을 보여 주고 실패로 끝난다', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'office-bg-ws-'));
  const logs = mkdtempSync(join(tmpdir(), 'office-bg-log-'));
  t.after(async () => {
    await rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(logs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const res = spawnSync(process.execPath, [BG, 'start', '--port', 'abc'], { env: cleanEnv({ AI_OFFICE_WORKSPACE: ws, AI_OFFICE_BG_LOG_DIR: logs }), encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /서버를 켜지 못했습니다/);
  assert.match(res.stderr, /--port는 0~65535 정수여야 합니다/);
});

test('office-bg: 알 수 없는 명령은 사용법을 보여 준다', () => {
  const res = spawnSync(process.execPath, [BG, 'restart'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /사용법: node scripts\/office-bg\.mjs start\|stop\|status/);
});
