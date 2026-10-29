// 코드 리뷰 지적 사항 회귀 테스트: 비밀값 가림, id 유일성, 검토자 직무 key, 실행 정리, 원격 인증, 경로 탈출 등
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, normalizeClaudeHook } from '../lib/events.mjs';
import { validateOrg } from '../lib/org.mjs';
import { buildState } from '../dashboard/state.mjs';
import { createRunner } from '../dashboard/runner.mjs';
import { startServer } from '../dashboard/server.mjs';
import { layoutOffice } from '../dashboard/public/office.js';
import { rankLabel, readableLog, agentPayloadFromPlan, STATUS_LABEL } from '../dashboard/public/app.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 25));
  }
};

function makeRoot({ departments = [], roster = [], presets = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'office-regress-'));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(roster));
  if (presets) copyFileSync(join(REPO, 'org', 'presets.json'), join(root, 'org', 'presets.json'));
  return root;
}

function request(base, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* JSON 아님 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withServer(root, fn, opts = {}) {
  const publicDir = join(root, 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><meta name="office-token" content="__OFFICE_TOKEN__"><title>t</title>');
  const handle = await startServer({ root, port: 0, publicDir, quiet: true, ...opts });
  const base = `http://127.0.0.1:${handle.port}`;
  const api = (method, path, body) => request(base, method, path, {
    body: body ?? {}, headers: { 'X-Office-Token': handle.token, Origin: base, 'Content-Type': 'application/json' },
  });
  try {
    return await fn({ handle, base, api });
  } finally {
    await handle.close();
  }
}

// ───── 비밀값 가림 ─────
test('redact: JSON 키, 따옴표 값, Cookie 헤더, --key 값, "is" 형태를 가린다', () => {
  assert.equal(redact('{"password":"hunter2"}'), '{"password":"***"}');
  assert.equal(redact('{"access_token": "ya29.SECRET"}'), '{"access_token": "***"}');
  assert.equal(redact('password: "correct horse battery"'), 'password: "***"');
  assert.equal(redact('{\\"password\\":\\"x y\\"}'), '{\\"password\\":\\"***\\"}');
  assert.equal(redact('curl -H "Cookie: theme=dark; sessionid=abc123SECRET" https://x'), 'curl -H "Cookie: ***" https://x');
  assert.equal(redact('Set-Cookie: a=b; Path=/'), 'Set-Cookie: ***');
  assert.equal(redact('tool --api-key sk_live_x --verbose'), 'tool --api-key *** --verbose');
  assert.equal(redact('DB 접속 정보: password is Hunter2! 정리'), 'DB 접속 정보: password is *** 정리');
  // 값이 아닌 일반 문장은 그대로 둔다
  assert.equal(redact('the password policy is strict'), 'the password policy is strict');
  const stop = redact('{"password":"hunter2","token":"ghs_shortTok"}');
  assert.ok(!stop.includes('hunter2') && !stop.includes('ghs_shortTok'), stop);
});

test('훅 Bash 명령의 JSON 비밀값도 events 요약에 남지 않는다', () => {
  const ev = normalizeClaudeHook({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash',
    tool_input: { command: 'curl -d {"api_key":"AKIAXYZSECRET"} https://x' } });
  assert.ok(!ev.summary.includes('AKIAXYZSECRET'), ev.summary);
});

// ───── 정본 검증 ─────
test('validateOrg: 부서·직원 id는 전체에서 유일하고 chief는 직원 id로 쓸 수 없다', () => {
  const dept = { id: 'research', name: '리서치부' };
  const agent = (id, extra = {}) => ({ id, name: '김대리', department: 'research', title: '담당', ...extra });
  const clash = validateOrg({ departments: [dept], roster: [agent('research')] });
  assert.equal(clash.ok, false);
  assert.match(clash.errors.join(' '), /부서 id와 겹칩니다/);
  const chief = validateOrg({ departments: [dept], roster: [agent('chief')] });
  assert.equal(chief.ok, false);
  assert.match(chief.errors.join(' '), /예약어/);
  assert.equal(validateOrg({ departments: [dept], roster: [agent('research-1', { role: 'Bad Role' })] }).ok, false);
  assert.ok(validateOrg({ departments: [dept], roster: [agent('research-1', { role: 'fact-checker' })] }).ok);
});

// ───── 상태 리듀서 ─────
test('buildState: runner가 남긴 run-<id> 이벤트와 run을 이중으로 세지 않고, 대기열 run을 표시한다', () => {
  const org = { departments: [{ id: 'verify', name: '검증실', engine: 'codex' }, { id: 'research', name: '리서치부' }],
    roster: [{ id: 'verify-1', name: '최과장', department: 'verify' }, { id: 'research-5', name: '김대리', department: 'research' }] };
  const now = Date.parse('2026-10-29T05:00:00.000Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const runEv = (kind, ms, extra = {}) => ({ v: 1, ts: at(ms), engine: 'codex', session: 'run-r1', instance: 'run-r1', agent: 'verify-1', kind, ...extra });
  const done = buildState({ org, now,
    events: [runEv('review.start', 5000), runEv('review.end', 1000, { verdict: 'PASS' })],
    runs: [{ id: 'r1', agentId: 'verify-1', engine: 'codex', status: 'done', startedAt: at(5000), endedAt: at(1000) }] });
  const verify = done.departments.find((d) => d.id === 'verify');
  assert.equal(verify.doneToday, 1);
  assert.equal(done.metrics.reviews, 1);
  const running = buildState({ org, now, events: [runEv('review.start', 5000)],
    runs: [{ id: 'r1', agentId: 'verify-1', engine: 'codex', status: 'running', startedAt: at(5000) }] });
  assert.equal(running.departments.find((d) => d.id === 'verify').inProgress, 1);
  const queued = buildState({ org, now, events: [], runs: [{ id: 'q1', agentId: 'research-5', status: 'queued', createdAt: at(1000) }] });
  assert.equal(queued.agents['research-5'].queued, true);
  assert.equal(queued.agents['verify-1'].queued, false);
});

// ───── 실행 정리 ─────
// 리더는 SIGTERM에 끝나고, 손자는 SIGTERM을 무시하며 stdio를 분리한다.
// 손자가 신호 처리기를 단 뒤에 직접 pid 파일을 써서, 준비 전에 신호가 가는 경쟁을 없앤다
const FAKE_CLAUDE = (root) => `const { spawn } = require('node:child_process');
const pidFile = ${JSON.stringify(join(root, 'grandchild.pid'))};
const code = 'process.on("SIGTERM",()=>{});require("fs").writeFileSync(' + JSON.stringify(pidFile) + ',String(process.pid));setInterval(()=>{},1000)';
spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
process.on('SIGTERM', () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1000);
`;

async function withFakeClaude(root, fn) {
  const bin = join(root, 'fake-claude.js');
  writeFileSync(bin, FAKE_CLAUDE(root));
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
  }
}

const ORG_ONE = { departments: [{ id: 'research', name: '리서치부' }], roster: [{ id: 'research-1', name: '김대리', department: 'research', title: '담당' }] };

test('중지: 리더가 SIGTERM으로 끝나도 SIGTERM을 무시한 손자는 유예 뒤 SIGKILL로 끝난다', { skip: !POSIX && 'POSIX 전용' }, async () => {
  const root = makeRoot(ORG_ONE);
  await withFakeClaude(root, async () => {
    const runner = createRunner({ root, killGraceMs: 400 });
    const run = runner.start({ agentId: 'research-1', prompt: '오래 걸리는 일' });
    const pidFile = join(root, 'grandchild.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    runner.stop(run.id);
    await waitFor(() => runner.list()[0].status === 'stopped');
    await waitFor(() => !alive(grandchild), 4000);
    // 로그는 본인만 읽을 수 있다
    assert.equal(statSync(join(root, '.office', 'runs', `${run.id}.log`)).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, '.office', 'runs')).mode & 0o777, 0o700);
  });
});

test('서버 종료(close)는 실행 중인 프로세스 그룹을 끝내고 대기열을 취소한다', { skip: !POSIX && 'POSIX 전용' }, async () => {
  const root = makeRoot(ORG_ONE);
  await withFakeClaude(root, async () => {
    const publicDir = join(root, 'public');
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, 'index.html'), '<title>t</title>');
    const handle = await startServer({ root, port: 0, publicDir, quiet: true });
    const base = `http://127.0.0.1:${handle.port}`;
    const headers = { 'X-Office-Token': handle.token, Origin: base, 'Content-Type': 'application/json' };
    const res = await request(base, 'POST', '/api/runs', { body: { agentId: 'research-1', prompt: '일' }, headers });
    assert.equal(res.status, 202);
    const pidFile = join(root, 'grandchild.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    const leader = res.json.pid;
    await handle.close();
    assert.ok(!alive(leader), '리더가 남으면 안 된다');
    await waitFor(() => !alive(grandchild), 2000);
    const runs = JSON.parse(readFileSync(join(root, '.office', 'runs.json'), 'utf8'));
    assert.equal(runs[0].status, 'stopped');
  });
});

// ───── 서버: 직무 key, sync 경고, 팀장 직함, 예약 id, 경로 탈출 ─────
test('프리셋으로 만든 검증실 직원은 직무 key(role)로 codex-review에서 찾을 수 있다', async () => {
  const root = makeRoot();
  await withServer(root, async ({ api }) => {
    assert.equal((await api('POST', '/api/departments', { preset: 'verify' })).status, 201);
    const created = await api('POST', '/api/agents', { department: 'verify', preset: 'fact-checker' });
    assert.equal(created.status, 201);
    assert.equal(created.json.id, 'verify-1');
    assert.equal(created.json.role, 'fact-checker');
  });
  mkdirSync(join(root, 'outputs', '2026-10-29', 't'), { recursive: true });
  const res = spawnSync(process.execPath, [join(REPO, 'scripts', 'codex-review.mjs'), '--target', 'outputs/2026-10-29/t', '--reviewers', 'fact-checker', '--dry-run'],
    { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /===== verify-1 \(roster\) =====/);
  const unknown = spawnSync(process.execPath, [join(REPO, 'scripts', 'codex-review.mjs'), '--target', 'outputs/2026-10-29/t', '--reviewers', 'ghost', '--dry-run'],
    { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /verify-1\(fact-checker\)/);
});

test('생성 표식 없는 파일과 겹치면 저장은 되지만 응답에 warnings가 붙는다', async () => {
  const root = makeRoot({ departments: [{ id: 'research', name: '리서치부' }] });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', 'mine-1.md'), '---\nname: mine-1\n---\n내 파일\n');
  await withServer(root, async ({ api }) => {
    const res = await api('POST', '/api/agents', { id: 'mine-1', name: '김대리', department: 'research', specialty: '조사' });
    assert.equal(res.status, 201);
    assert.ok(res.json.warnings?.some((w) => w.includes('.claude/agents/mine-1.md')), JSON.stringify(res.json));
    assert.equal(readFileSync(join(root, '.claude', 'agents', 'mine-1.md'), 'utf8'), '---\nname: mine-1\n---\n내 파일\n');
  });
});

test('팀장 여부만 바꾸면 직함을 맞추고, chief·부서 id와 같은 직원 id는 거부한다', async () => {
  const root = makeRoot({ departments: [{ id: 'research', name: '리서치부' }] });
  await withServer(root, async ({ api }) => {
    await api('POST', '/api/agents', { id: 'research-1', name: '김대리', department: 'research', specialty: '조사' });
    const up = await api('PUT', '/api/agents/research-1', { lead: true });
    assert.equal(up.json.title, '팀장');
    const down = await api('PUT', '/api/agents/research-1', { lead: false });
    assert.equal(down.json.title, '담당');
    assert.equal((await api('POST', '/api/agents', { id: 'chief', name: '가짜', department: 'research' })).status, 400);
    assert.equal((await api('POST', '/api/agents', { id: 'research', name: '가짜', department: 'research' })).status, 409);
  });
});

test('outputs 아래 심볼릭 링크가 밖을 가리키면 검토 대상으로 받지 않는다', { skip: !POSIX && '심볼릭 링크 권한 필요' }, async () => {
  const root = makeRoot();
  const outside = mkdtempSync(join(tmpdir(), 'office-outside-'));
  mkdirSync(join(root, 'outputs', '2026-10-29'), { recursive: true });
  symlinkSync(outside, join(root, 'outputs', '2026-10-29', 'link'));
  await withServer(root, async ({ api }) => {
    const res = await api('POST', '/api/reviews', { target: 'outputs/2026-10-29/link' });
    assert.equal(res.status, 400);
  });
  const cli = spawnSync(process.execPath, [join(REPO, 'scripts', 'codex-review.mjs'), '--target', 'outputs/2026-10-29/link', '--dry-run'],
    { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /outputs\/ 아래/);
  assert.ok(!existsSync(join(outside, 'reviews')));
});

test('원격 바인딩: 키 없는 요청은 401, 접속 주소의 키는 HttpOnly 쿠키로 바뀐다', async () => {
  const root = makeRoot();
  await withServer(root, async ({ handle, base }) => {
    assert.equal(handle.remote, true);
    assert.ok(handle.accessUrl.includes(`?key=${handle.token}`));
    const page = await request(base, 'GET', '/');
    assert.equal(page.status, 401);
    assert.ok(!page.text.includes(handle.token));
    assert.equal((await request(base, 'GET', '/api/state')).status, 401);
    assert.equal((await request(base, 'GET', '/?key=wrong')).status, 401);
    const login = await request(base, 'GET', `/?key=${handle.token}`);
    assert.equal(login.status, 302);
    assert.equal(login.headers.location, '/');
    const cookie = String(login.headers['set-cookie']);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const jar = cookie.split(';')[0];
    const authed = await request(base, 'GET', '/', { headers: { Cookie: jar } });
    assert.equal(authed.status, 200);
    assert.ok(authed.text.includes(handle.token));
    assert.equal((await request(base, 'GET', '/api/state', { headers: { Cookie: jar } })).status, 200);
  }, { host: '0.0.0.0' });
});

// ───── 화면 순수 함수 ─────
test('화면: 직급 중복 표시 생략, 로그 답변 추출, 직무 key 전달, 모바일 1열 배치', () => {
  assert.equal(rankLabel({ name: '오유진 팀장', rank: '팀장', title: '팀장' }), '');
  assert.equal(rankLabel({ name: '김대리', rank: '대리', title: '담당' }), '담당');
  assert.equal(rankLabel({ name: '김민준', rank: '대리', title: '담당' }), '대리 · 담당');
  const long = 'x'.repeat(500);
  const log = ['{"type":"system","subtype":"init"}', 'ated","text":"잘린 줄"}',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: long }] } }),
    JSON.stringify({ type: 'result', result: long }), '[stderr] 경고'].join('\n');
  assert.equal(readableLog(log), long, '마지막 답변과 같은 result는 한 번만');
  assert.equal(agentPayloadFromPlan('verify', { id: 'verify-1', name: '김대리', rank: '대리', title: '담당', lead: false, role: { key: 'fact-checker' } }).role, 'fact-checker');
  assert.notEqual(STATUS_LABEL.idle, '근무중');
  const depts = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, members: [{ id: `d${i}-1` }] }));
  assert.equal(layoutOffice(depts, { maxCols: 1 }).gridCols, 1);
  assert.equal(layoutOffice(depts).gridCols, 3);
});
