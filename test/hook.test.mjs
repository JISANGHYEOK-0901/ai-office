import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// 같은 부하에서 빈 node 프로세스를 띄우는 데 걸리는 시간(앞뒤로 재서 큰 값). 훅 2초 제한 검사에서 Node 기동 시간은 빼고 본다
// (전체 테스트를 병렬로 돌리면 기동만 수백 ms가 걸려 시간 검사가 흔들린다)
function nodeBootMs() {
  const t = Date.now();
  spawnSync(process.execPath, ['-e', '0']);
  return Date.now() - t;
}

// 레포 루트는 스크립트 위치 기준이므로 임시 루트에 훅과 이벤트 모듈을 복사해 실행한다
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'office-hook-'));
  mkdirSync(join(root, 'hooks'));
  mkdirSync(join(root, 'lib'));
  copyFileSync(join(REPO, 'hooks', 'office-event.mjs'), join(root, 'hooks', 'office-event.mjs'));
  for (const f of readdirSync(join(REPO, 'lib'))) if (f.endsWith('.mjs')) copyFileSync(join(REPO, 'lib', f), join(root, 'lib', f));
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

// 등록된 업무(.office/tasks.json)를 만든다. 훅은 tasks.json에 있는 업무에만 세션을 연결한다
function registerTasks(root, ids) {
  mkdirSync(join(root, '.office'), { recursive: true });
  writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify(ids.map((id) => ({ id, title: id, status: 'active', created: '2026-10-29T00:00:00Z' }))));
}

const sessionsOf = (root) => {
  const file = join(root, '.office', 'sessions.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};

test('PostToolUse(Bash)의 OFFICE_TASK 로 sessions.json 갱신, 이후 이벤트에 task 부착', () => {
  const root = makeRoot();
  registerTasks(root, ['2026-10-29/scan']);
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
  const bootBefore = nodeBootMs();
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
  const boot = Math.max(bootBefore, nodeBootMs());
  // 훅 자체 강제 종료는 1.9초. 기계 부하로 타이머가 늦게 깨는 여유 0.6초를 둔다
  assert.ok(elapsed - boot < 2500, `경과 ${elapsed}ms (기동 ${boot}ms 제외)`);
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

test('세션 연결은 실제 task start 실행 + 등록된 업무 id일 때만(cat·grep 출력, 미등록 id는 연결하지 않음)', () => {
  const root = makeRoot();
  registerTasks(root, ['2026-10-29/scan']);
  const post = (sid, command, stdout, tool = 'Bash') => runHook(root, {
    session_id: sid, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { command }, tool_response: { stdout, stderr: '' },
  });
  // 개발 세션이 테스트 파일을 grep한 출력에 OFFICE_TASK=가 보이는 경우
  post('dev1', "grep -rn 'OFFICE_TASK=' test/events.test.mjs", "test/events.test.mjs:193:  assert.equal(extractOfficeTask({ stdout: 'OFFICE_TASK=x' }), null);\nOFFICE_TASK=2026-10-29/scan");
  post('dev2', 'cat test/hook.test.mjs', 'OFFICE_TASK=2026-10-29/scan');
  post('dev3', 'node scripts/office.mjs task list', 'OFFICE_TASK=2026-10-29/scan');
  post('dev4', 'node scripts/office.mjs task start x ; echo OFFICE_TASK=2026-10-29/scan', 'OFFICE_TASK=2026-10-29/scan');
  // 형식이 맞지 않거나 등록되지 않은 업무 id
  post('dev5', 'node scripts/office.mjs task start x', 'OFFICE_TASK=x');
  post('dev6', 'node scripts/office.mjs task start x', 'OFFICE_TASK=2026-10-29/not-registered');
  assert.deepEqual(sessionsOf(root), {});
  // Windows PowerShell 도구로 실행한 task start도 연결한다
  post('ps1', 'node scripts/office.mjs task start "조사"', '등록\r\nOFFICE_TASK=2026-10-29/scan\r\n', 'PowerShell');
  assert.deepEqual(sessionsOf(root), { ps1: '2026-10-29/scan' });
  assert.equal(readLines(root).filter((e) => e.task === '2026-10-29/scan').length, 1, 'PowerShell 연결 이벤트에도 task가 붙는다');
});
