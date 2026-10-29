import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// 레포 루트는 스크립트 위치 기준이므로 임시 루트에 훅과 이벤트 모듈을 복사해 실행한다
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'office-hook-'));
  mkdirSync(join(root, 'hooks'));
  mkdirSync(join(root, 'lib'));
  copyFileSync(join(REPO, 'hooks', 'office-event.mjs'), join(root, 'hooks', 'office-event.mjs'));
  copyFileSync(join(REPO, 'lib', 'events.mjs'), join(root, 'lib', 'events.mjs'));
  copyFileSync(join(REPO, 'lib', 'paths.mjs'), join(root, 'lib', 'paths.mjs'));
  return root;
}

function runHook(root, input) {
  const started = Date.now();
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR; // Claude 세션 안에서 테스트해도 실제 레포에 쓰지 않게 한다
  const res = spawnSync(process.execPath, [join(root, 'hooks', 'office-event.mjs')], {
    env,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { ...res, elapsed: Date.now() - started };
}

const readLines = (root) => {
  const file = join(root, '.office', 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('정상 입력: 이벤트 한 줄 추가, stdout 비어 있음, exit 0', () => {
  const root = makeRoot();
  const res = runHook(root, { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const lines = readLines(root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'session.start');
  assert.equal(lines[0].agent, 'chief');
});

test('잘못된 JSON·빈 입력·배열에도 exit 0, stdout 비어 있음, 기록 없음', () => {
  const root = makeRoot();
  for (const input of ['{깨진 json', '', '[1,2]', 'null']) {
    const res = runHook(root, input);
    assert.equal(res.status, 0, `입력 ${JSON.stringify(input)}`);
    assert.equal(res.stdout, '');
  }
  assert.equal(readLines(root).length, 0);
});

test('PostToolUse(Bash)의 OFFICE_TASK 로 sessions.json 갱신, 이후 이벤트에 task 부착', () => {
  const root = makeRoot();
  const res = runHook(root, {
    session_id: 's2', hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'node scripts/office.mjs task start "조사"' }, tool_use_id: 't1',
    tool_response: { stdout: '만들었습니다\nOFFICE_TASK=2026-10-29/scan\n', stderr: '' },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const sessions = JSON.parse(readFileSync(join(root, '.office', 'sessions.json'), 'utf8'));
  assert.deepEqual(sessions, { s2: '2026-10-29/scan' });

  runHook(root, { session_id: 's2', hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'market-researcher' });
  runHook(root, { session_id: 'other', hook_event_name: 'Stop', last_assistant_message: '끝' });
  const lines = readLines(root);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].task, '2026-10-29/scan');
  assert.equal(lines[1].task, '2026-10-29/scan');
  assert.equal(lines[1].agent, 'market-researcher');
  assert.equal(lines[2].task, undefined);
  // 응답 원문은 저장하지 않는다
  assert.ok(!readFileSync(join(root, '.office', 'events.jsonl'), 'utf8').includes('만들었습니다'));
});

test('task-notification 프롬프트는 기록하지 않는다', () => {
  const root = makeRoot();
  const res = runHook(root, { session_id: 's3', prompt_id: 'p', prompt: '<task-notification>done</task-notification>' });
  assert.equal(res.status, 0);
  assert.equal(readLines(root).length, 0);
});

test('stdin 이 닫히지 않아도 2초 안에 exit 0', async () => {
  const root = makeRoot();
  const started = Date.now();
  // stdin 을 열어 둔 채(입력 일부만 쓰고 끝내지 않음) 실행한다
  const child = spawn(process.execPath, [join(root, 'hooks', 'office-event.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: (({ CLAUDE_PROJECT_DIR, ...rest }) => rest)(process.env) });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stdin.write('{"session_id":"s5",');
  const code = await new Promise((done) => child.on('exit', done));
  const elapsed = Date.now() - started;
  child.stdin.destroy();
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.ok(elapsed < 2500, `경과 ${elapsed}ms`);
});

test('.office 쓰기 실패에도 exit 0', () => {
  const root = makeRoot();
  writeFileSync(join(root, '.office'), '파일로 막아 둔 경로');
  const res = runHook(root, { session_id: 's4', hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('공용 모듈이 없어도(로드 실패) exit 0, stdout 비어 있음', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-hook-nolib-'));
  mkdirSync(join(root, 'hooks'));
  copyFileSync(join(REPO, 'hooks', 'office-event.mjs'), join(root, 'hooks', 'office-event.mjs'));
  const res = runHook(root, { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});
