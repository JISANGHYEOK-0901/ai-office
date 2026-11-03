// npm run doctor(scripts/doctor.mjs, lib/doctor.mjs) 테스트. 실제 claude·codex 대신 CLAUDE_BIN/CODEX_BIN 가짜 .js만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BILLING_ENV_VARS, findGitBash, formatDoctor, parseClaudeAuth, parseCodexLogin, quickToolCheck, runDoctor } from '../lib/doctor.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = join(REPO, 'scripts', 'doctor.mjs');
const EMAIL = 'leak-me@example.com';
const ORG_NAME = 'Secret Org Name';
const API_KEY_VALUE = 'sk-ant-should-never-print-1234';

// 가짜 claude: --version, auth status(FAKE_CLAUDE_AUTH=in|out|garbage|hang)
const FAKE_CLAUDE = `
const args = process.argv.slice(2).join(' ');
const mode = process.env.FAKE_CLAUDE_AUTH || 'in';
if (args === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args === 'auth status') {
  if (mode === 'hang') { setInterval(() => {}, 1000); }
  else if (mode === 'garbage') { console.log('unknown command'); process.exit(1); }
  else {
    const loggedIn = mode === 'in';
    console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty',
      email: loggedIn ? '${EMAIL}' : null, orgId: 'org-123', orgName: '${ORG_NAME}', subscriptionType: 'max' }, null, 2));
    process.exit(loggedIn ? 0 : 1);
  }
} else { process.exit(2); }
`;

// 가짜 codex: --version, login status(FAKE_CODEX_AUTH=in|out)
const FAKE_CODEX = `
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('codex-cli 1.2.3'); process.exit(0); }
if (args === 'login status') {
  if ((process.env.FAKE_CODEX_AUTH || 'in') === 'in') { console.log('Logged in using ChatGPT (${EMAIL})'); process.exit(0); }
  console.error('Not logged in'); process.exit(1);
}
process.exit(2);
`;

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'office-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, 'fake-claude.js');
  const codex = join(dir, 'fake-codex.mjs');
  writeFileSync(claude, FAKE_CLAUDE);
  writeFileSync(codex, FAKE_CODEX);
  return { dir, claude, codex, missing: join(dir, 'not-installed.js') };
}

// API 키 환경변수는 지운 깨끗한 환경
// 작업 공간도 임시 경로로 둬서 사용자 작업 공간(~/AIOffice 등)을 보지 않게 한다
const TEST_WORKSPACE = join(tmpdir(), 'ai-office-doctor-ws-none');
function cleanEnv(extra) {
  const env = { ...process.env };
  for (const n of [...BILLING_ENV_VARS, 'CLAUDE_CODE_GIT_BASH_PATH', 'FAKE_CLAUDE_AUTH', 'FAKE_CODEX_AUTH', 'AI_OFFICE_ROOT']) delete env[n];
  return { ...env, AI_OFFICE_WORKSPACE: TEST_WORKSPACE, ...extra };
}

// Git 탐색에 쓰이는 환경변수(PATH, Program Files, LOCALAPPDATA)를 대소문자 구분 없이 지운다
function withoutGitLocations(env) {
  const drop = new Set(['path', 'programfiles', 'programfiles(x86)', 'localappdata']);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k.toLowerCase())));
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function doctor(env, args = []) {
  const port = await freePort();
  const p = spawnSync(process.execPath, [DOCTOR, '--json', '--port', String(port), ...args], { env, encoding: 'utf8', timeout: 30_000 });
  return { status: p.status, stdout: p.stdout, stderr: p.stderr, json: JSON.parse(p.stdout), port };
}

const byId = (json, id) => json.checks.find((c) => c.id === id);

function assertNoSecrets(text) {
  assert.ok(!text.includes(EMAIL), '이메일이 출력에 있으면 안 된다');
  assert.ok(!text.includes(ORG_NAME), '조직 이름이 출력에 있으면 안 된다');
  assert.ok(!text.includes('org-123'), '조직 id가 출력에 있으면 안 된다');
  assert.ok(!text.includes(API_KEY_VALUE), 'API 키 값이 출력에 있으면 안 된다');
}

test('doctor --json: claude·codex 모두 로그인 → 필수 통과, 종료 코드 0, 이메일 없음', async (t) => {
  const f = setup(t);
  const r = await doctor(cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.codex }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.platform, process.platform);
  assert.equal(byId(r.json, 'node').status, 'ok');
  assert.deepEqual(
    { status: byId(r.json, 'claude').status, version: byId(r.json, 'claude').version },
    { status: 'ok', version: '9.9.9 (Claude Code)' },
  );
  const auth = byId(r.json, 'claude-auth');
  assert.equal(auth.status, 'ok');
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.authMethod, 'claude.ai');
  assert.equal(byId(r.json, 'codex').version, 'codex-cli 1.2.3');
  assert.deepEqual({ s: byId(r.json, 'codex-auth').status, l: byId(r.json, 'codex-auth').loggedIn }, { s: 'ok', l: true });
  // 작업 공간 경로와 출처를 보여준다(필수 항목 아님)
  const ws = byId(r.json, 'workspace');
  assert.equal(ws.path, TEST_WORKSPACE);
  assert.equal(ws.source, 'env');
  assert.equal(ws.required, false);
  assert.equal(byId(r.json, 'api-env').status, 'ok');
  assert.equal(byId(r.json, 'port').status, 'ok');
  assert.equal(byId(r.json, 'port').label, `포트 ${r.port}`);
  assertNoSecrets(r.stdout + r.stderr);

  // 사람이 읽는 출력도 같은 원칙
  const human = spawnSync(process.execPath, [DOCTOR, '--port', String(await freePort())], { env: cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.codex }), encoding: 'utf8' });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^✔ claude 로그인 \(선택\): 로그인됨 \(방식: claude\.ai\)$/m);
  assert.match(human.stdout, /결과: 필수 항목 통과/);
  assertNoSecrets(human.stdout + human.stderr);
});

test('doctor --json: claude 미로그인 → ✖·종료 코드 1, 로그인 명령 안내', async (t) => {
  const f = setup(t);
  const r = await doctor(cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.codex, FAKE_CLAUDE_AUTH: 'out', FAKE_CODEX_AUTH: 'out' }));
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  const auth = byId(r.json, 'claude-auth');
  assert.equal(auth.status, 'fail');
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.fix.command, 'claude auth login');
  assert.equal(auth.fix.os, process.platform === 'win32' ? 'Windows PowerShell' : 'macOS');
  const codexAuth = byId(r.json, 'codex-auth');
  assert.equal(codexAuth.status, 'fail');
  assert.equal(codexAuth.required, false);
  assert.equal(codexAuth.fix.command, 'codex login');
  assertNoSecrets(r.stdout + r.stderr);
});

test('doctor --json: Codex 또는 Claude 하나만 로그인돼 있어도 종료 코드 0', async (t) => {
  const f = setup(t);
  let r = await doctor(cleanEnv({ CLAUDE_BIN: f.missing, CODEX_BIN: f.codex }));
  assert.equal(r.status, 0);
  assert.match(byId(r.json, 'ai-login').message, /Codex 전용 모드/);
  assert.equal(byId(r.json, 'claude').status, 'fail');
  assert.match(byId(r.json, 'claude').fix.command, /npm install -g @anthropic-ai\/claude-code/);
  assert.equal(byId(r.json, 'claude-auth').status, 'fail');

  r = await doctor(cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.missing }));
  assert.equal(r.status, 0, '선택 도구(codex)가 없어도 필수 항목은 통과');
  assert.equal(r.json.ok, true);
  const codex = byId(r.json, 'codex');
  assert.equal(codex.status, 'fail');
  assert.equal(codex.optional, true);
  assert.match(codex.message, /검증실/);
  assert.match(codex.fix.command, /npm install -g @openai\/codex/);
});

test('doctor: API 키 환경변수는 이름만 경고하고 값은 출력하지 않는다', async (t) => {
  const f = setup(t);
  const r = await doctor(cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.codex, ANTHROPIC_API_KEY: API_KEY_VALUE, CLAUDE_CODE_USE_BEDROCK: '1' }));
  assert.equal(r.status, 0);
  const env = byId(r.json, 'api-env');
  assert.equal(env.status, 'warn');
  assert.deepEqual(env.names, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']);
  assert.match(env.message, /API 과금/);
  assertNoSecrets(r.stdout + r.stderr);
});

test('doctor: 사용 중인 포트는 경고(종료 코드는 그대로 0)', async (t) => {
  const f = setup(t);
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const port = busy.address().port;
  const p = spawnSync(process.execPath, [DOCTOR, '--json', '--port', String(port)], { env: cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.codex }), encoding: 'utf8' });
  const json = JSON.parse(p.stdout);
  assert.equal(p.status, 0);
  const c = byId(json, 'port');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /사용 중/);
  assert.ok(c.fix.command.includes(String(port)), '해결 명령에 실제 포트가 들어간다');
});

test('doctor: 응답 없는 명령은 타임아웃 후 경고로 처리한다', async (t) => {
  // 제한 시간은 모든 점검 명령에 같이 걸린다. 너무 짧으면 전체 테스트 병렬 실행 중 가짜 바이너리의
  // 정상 응답(--version 등)까지 시간 초과로 떨어져 간헐 실패하므로 여유를 둔다(멈춘 명령은 어차피 끝까지 기다린다)
  const f = setup(t);
  const result = await runDoctor({ env: cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.codex, FAKE_CLAUDE_AUTH: 'hang' }), port: await freePort(), timeoutMs: 1500 });
  const auth = byId(result, 'claude-auth');
  assert.equal(auth.status, 'warn');
  assert.match(auth.message, /응답하지 않았습니다/);
  assert.equal(result.ok, true, '로그인 상태를 모르는 것은 실패로 단정하지 않는다');
});

test('doctor: Windows에서는 PowerShell 해결 명령과 Git for Windows(선택) 항목을 보여준다', async (t) => {
  const f = setup(t);
  const bash = join(f.dir, 'bash.exe');
  writeFileSync(bash, '');
  // 실제 Windows CI에는 Git이 설치돼 있으므로 PATH·Program Files 위치를 비워 "Git 없음"을 재현한다(가짜 바이너리는 node 절대경로로 실행)
  const env = withoutGitLocations(cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.missing, OPENAI_API_KEY: API_KEY_VALUE }));
  let result = await runDoctor({ env, platform: 'win32', port: await freePort() });
  const git = byId(result, 'git-bash');
  assert.equal(git.status, 'warn');
  assert.equal(git.required, false);
  assert.equal(git.fix.command, 'winget install Git.Git');
  assert.equal(byId(result, 'codex').fix.os, 'Windows PowerShell');
  assert.match(byId(result, 'api-env').fix.command, /^Remove-Item Env:OPENAI_API_KEY$/);
  assertNoSecrets(formatDoctor(result).join('\n') + JSON.stringify(result));

  result = await runDoctor({ env: { ...env, CLAUDE_CODE_GIT_BASH_PATH: bash }, platform: 'win32', port: await freePort() });
  assert.equal(byId(result, 'git-bash').status, 'ok');
  // macOS·Linux에서는 Git for Windows 항목이 없다
  result = await runDoctor({ env, platform: 'darwin', port: await freePort() });
  assert.equal(byId(result, 'git-bash'), undefined);
  assert.equal(byId(result, 'api-env').fix.command, 'unset OPENAI_API_KEY');
});

test('doctor: Windows Git Bash 탐색 — git.exe 옆 bin\\bash.exe, Program Files, System32(WSL) 제외', (t) => {
  const f = setup(t);
  const gitRoot = join(f.dir, 'Git');
  mkdirSync(join(gitRoot, 'cmd'), { recursive: true });
  mkdirSync(join(gitRoot, 'bin'), { recursive: true });
  writeFileSync(join(gitRoot, 'cmd', 'git.exe'), '');
  writeFileSync(join(gitRoot, 'bin', 'bash.exe'), '');
  const base = { PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  // PATH의 <Git>\cmd\git.exe → <Git>\bin\bash.exe
  assert.equal(findGitBash({ env: { ...base, Path: join(gitRoot, 'cmd') }, platform: 'win32' }), join(gitRoot, 'bin', 'bash.exe'));
  // PATH에 없어도 Program Files\Git\bin\bash.exe를 찾는다
  assert.equal(findGitBash({ env: { ...base, PATH: '', ProgramFiles: f.dir }, platform: 'win32' }), join(gitRoot, 'bin', 'bash.exe'));
  // System32 아래 bash.exe(WSL)는 Git Bash가 아니다
  const sys = join(f.dir, 'Windows', 'System32');
  mkdirSync(sys, { recursive: true });
  writeFileSync(join(sys, 'git.exe'), '');
  writeFileSync(join(sys, 'bash.exe'), '');
  assert.equal(findGitBash({ env: { ...base, PATH: sys }, platform: 'win32' }), null);
});

test('파서·빠른 점검 단위 동작', (t) => {
  assert.deepEqual(parseClaudeAuth(`{"loggedIn":true,"authMethod":"claude.ai","email":"${EMAIL}"}`), { loggedIn: true, authMethod: 'claude.ai' });
  assert.deepEqual(parseClaudeAuth('경고 한 줄\n{"loggedIn":false}'), { loggedIn: false, authMethod: null });
  assert.deepEqual(parseClaudeAuth('not json'), { loggedIn: null, authMethod: null });
  assert.equal(parseClaudeAuth('{"loggedIn":true,"authMethod":"<script>"}').authMethod, null, '이상한 방식 문자열은 버린다');
  assert.equal(parseCodexLogin({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }), true);
  assert.equal(parseCodexLogin({ code: 1, stdout: '', stderr: 'Not logged in' }), false);
  assert.equal(parseCodexLogin({ code: 0, stdout: 'Not logged in', stderr: '' }), false);
  assert.equal(findGitBash({ env: {}, platform: 'darwin' }), null);

  const f = setup(t);
  assert.deepEqual(quickToolCheck({ env: cleanEnv({ CLAUDE_BIN: f.claude, CODEX_BIN: f.missing }) }), { claude: { installed: true }, codex: { installed: false } });
  // .js가 아닌 대체 경로도 PATH 탐색과 같은 규칙으로 판정한다
  assert.equal(quickToolCheck({ env: cleanEnv({ CLAUDE_BIN: join(f.dir, 'no-such-claude'), CODEX_BIN: f.codex }) }).claude.installed, false);
});

test('doctor: 잘못된 옵션은 64', () => {
  assert.equal(spawnSync(process.execPath, [DOCTOR, '--nope'], { encoding: 'utf8' }).status, 64);
  assert.equal(spawnSync(process.execPath, [DOCTOR, '--port', 'abc'], { encoding: 'utf8' }).status, 64);
});
