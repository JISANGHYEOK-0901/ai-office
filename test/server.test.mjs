import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 서버는 다른 구현자의 모듈(lib/org, lib/events, lib/sync, dashboard/runner)에 의존한다. 없으면 건너뛴다.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPS = ['lib/org.mjs', 'lib/events.mjs', 'lib/sync.mjs', 'dashboard/runner.mjs', 'dashboard/server.mjs'];
const missing = DEPS.filter((f) => !existsSync(join(REPO, f)));
const skip = missing.length ? `의존 모듈 없음: ${missing.join(', ')}` : false;

let root;
let handle;
let token;
let base;

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* JSON 아님 */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const authed = (extra = {}) => ({ 'X-Office-Token': token, Origin: base, 'Content-Type': 'application/json', ...extra });
const api = (method, path, body) => request(method, path, { body: body ?? {}, headers: authed() });
const tokenOnly = () => ({ 'X-Office-Token': token });

before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'ai-office-server-'));
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), '[]\n');
  writeFileSync(join(root, 'org', 'roster.json'), '[]\n');
  const publicDir = join(root, 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><meta name="office-token" content="__OFFICE_TOKEN__"><title>t</title>');
  writeFileSync(join(root, 'secret.txt'), 'SECRET');
  const { startServer } = await import('../dashboard/server.mjs');
  handle = await startServer({ root, port: 0, publicDir, quiet: true });
  base = `http://127.0.0.1:${handle.port}`;
  token = handle.token;
});

after(async () => {
  if (handle) await handle.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test('index.html에 토큰이 주입되고 GET /api/state가 동작한다', { skip }, async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  const m = page.text.match(/name="office-token" content="([0-9a-f]+)"/);
  assert.ok(m, '토큰 자리표시자가 치환되어야 한다');
  assert.equal(m[1], handle.token);
  assert.ok(!page.text.includes('__OFFICE_TOKEN__'));


  const state = await request('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.json.departments, []);
  assert.ok(state.json.metrics);
  assert.ok(state.json.presets);
  assert.equal(state.json.demo, false);
});

test('토큰 없는 POST는 403', { skip }, async () => {
  const res = await request('POST', '/api/departments', {
    body: { name: '리서치부' },
    headers: { Origin: base, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 403);
  assert.ok(res.json.error);
});

test('잘못된 Origin은 403, Origin 누락도 403, 잘못된 Content-Type은 415', { skip }, async () => {
  const bad = await request('POST', '/api/departments', { body: { name: 'x' }, headers: authed({ Origin: 'http://evil.example' }) });
  assert.equal(bad.status, 403);
  const headers = authed();
  delete headers.Origin;
  const none = await request('POST', '/api/departments', { body: { name: 'x' }, headers });
  assert.equal(none.status, 403);
  const type = await request('POST', '/api/departments', { body: 'name=x', headers: authed({ 'Content-Type': 'application/x-www-form-urlencoded' }) });
  assert.equal(type.status, 415);
});

test('허용되지 않은 Host 헤더는 403(DNS 리바인딩 방지)', { skip }, async () => {
  const res = await request('GET', '/', { headers: { Host: `evil.example:${handle.port}` } });
  assert.equal(res.status, 403);
});

test('1MB를 넘는 본문은 413', { skip }, async () => {
  const res = await request('POST', '/api/departments', { body: { name: 'x', summary: 'a'.repeat(1024 * 1024 + 10) }, headers: authed() });
  assert.equal(res.status, 413);
});

test('부서 생성 → 직원 생성 → 에이전트 파일 생성 → 삭제 409/cascade', { skip }, async () => {
  const dept = await api('POST', '/api/departments', { name: '리서치부', en: 'RESEARCH', color: '#38bdf8', model: 'sonnet' });
  assert.equal(dept.status, 201, dept.text);
  assert.equal(dept.json.id, 'research');
  assert.equal(dept.json.engine, 'claude');
  assert.equal(dept.json.permission, 'acceptEdits');

  const dup = await api('POST', '/api/departments', { id: 'research', name: '중복' });
  assert.equal(dup.status, 409);

  const invalid = await api('POST', '/api/departments', { name: '엔진오류', en: 'BAD', engine: 'gpt' });
  assert.equal(invalid.status, 400);

  const agent = await api('POST', '/api/agents', {
    name: '김대리',
    department: 'research',
    rank: '대리',
    lead: true,
    specialty: '시장 조사',
    instructions: '출처와 함께 정리한다.',
  });
  assert.equal(agent.status, 201, agent.text);
  assert.equal(agent.json.id, 'research-1');
  assert.equal(agent.json.title, '팀장');

  const secondLead = await api('POST', '/api/agents', { name: '이과장', department: 'research', lead: true });
  assert.equal(secondLead.status, 400);

  const noDept = await api('POST', '/api/agents', { name: '박사원', department: 'nope' });
  assert.equal(noDept.status, 400);

  const agentFile = join(root, '.claude', 'agents', 'research-1.md');
  assert.ok(existsSync(agentFile), '저장 후 sync로 에이전트 파일이 생겨야 한다');
  assert.match(readFileSync(agentFile, 'utf8'), /name: research-1/);

  const roster = JSON.parse(readFileSync(join(root, 'org', 'roster.json'), 'utf8'));
  assert.equal(roster.length, 1);

  // 휴무 전환 시 에이전트 파일 제거
  const off = await api('POST', '/api/agents/research-1/duty', { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.active, false);
  assert.ok(!existsSync(agentFile), '휴무 직원은 에이전트 파일이 없어야 한다');
  const on = await api('POST', '/api/agents/research-1/duty', { active: true });
  assert.equal(on.status, 200);
  assert.ok(existsSync(agentFile));

  const renameId = await api('PUT', '/api/agents/research-1', { id: 'other' });
  assert.equal(renameId.status, 400);
  const updated = await api('PUT', '/api/agents/research-1', { specialty: '경쟁사 분석' });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.specialty, '경쟁사 분석');

  const state = await request('GET', '/api/state');
  assert.equal(state.json.departments[0].id, 'research');
  assert.deepEqual(state.json.departments[0].members, ['research-1']);
  assert.equal(state.json.agents['research-1'].status, 'idle');

  const conflict = await request('DELETE', '/api/departments/research', { headers: authed() });
  assert.equal(conflict.status, 409);
  assert.ok(conflict.json.error);

  const removed = await request('DELETE', '/api/departments/research?cascade=1', { headers: authed() });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(removed.json.removedAgents, ['research-1']);
  assert.ok(!existsSync(agentFile), 'cascade 삭제 후 에이전트 파일이 지워져야 한다');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'org', 'departments.json'), 'utf8')), []);

  const gone = await request('DELETE', '/api/departments/research', { headers: authed() });
  assert.equal(gone.status, 404);
});

test('정적 파일 경로 탈출은 404', { skip }, async () => {
  for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%2f..%2fetc%2fpasswd', '/%2e%2e%2fsecret.txt', '/nope.js']) {
    const res = await request('GET', path);
    assert.equal(res.status, 404, path);
    assert.ok(!res.text.includes('SECRET'), path);
  }
});

test('없는 run 로그와 중지는 404, 빈 prompt는 400', { skip }, async () => {
  assert.equal((await request('GET', '/api/runs/nope/log', { headers: tokenOnly() })).status, 404);
  assert.equal((await request('GET', '/api/runs/..%2f..%2fsecret/log', { headers: tokenOnly() })).status, 404);
  // 로그·지침 미리보기·회사 규칙은 원문이 들어 있어 토큰 없이 읽을 수 없다
  assert.equal((await request('GET', '/api/runs/nope/log')).status, 403);
  assert.equal((await request('GET', '/api/agents/nope-1/preview')).status, 403);
  assert.equal((await request('GET', '/api/company')).status, 403);
  assert.equal((await api('POST', '/api/runs/nope/stop')).status, 404);
  assert.equal((await api('POST', '/api/runs', { prompt: '  ' })).status, 400);
});

test('SSE는 접속 즉시 state 이벤트를 보낸다', { skip }, async () => {
  const first = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/stream`, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        const m = buf.match(/event: state\ndata: (.*)\n\n/);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', reject);
  });
  assert.ok(first.metrics);
});

test('events.jsonl에 추가된 이벤트가 상태에 반영된다', { skip }, async () => {
  const ev = { v: 1, ts: new Date().toISOString(), engine: 'claude', session: 's', agent: 'ghost', instance: 's', kind: 'tool.start', tool: 'Read', summary: '읽기' };
  writeFileSync(join(root, '.office', 'events.jsonl'), JSON.stringify(ev) + '\n');
  let state;
  for (let i = 0; i < 30; i++) {
    state = (await request('GET', '/api/state')).json;
    if (state.feed.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state.feed.length, 1);
  assert.deepEqual(state.unregistered, ['ghost']);
});

test('회사 공통 규칙·부서 지침·최종 지침 미리보기·설명 없음 경고', { skip }, async () => {
  const dept = await api('POST', '/api/departments', { id: 'layer', name: '계층부', instructions: '부서 공통 지침 본문', model: 'haiku' });
  assert.equal(dept.status, 201, dept.text);
  assert.equal(dept.json.instructions, '부서 공통 지침 본문');
  const bad = await api('PUT', '/api/departments/layer', { codexEffort: 'turbo' });
  assert.equal(bad.status, 400);

  const agent = await api('POST', '/api/agents', { id: 'layer-1', name: '김대리', department: 'layer', instructions: '역할 지침 본문' });
  assert.equal(agent.status, 201, agent.text);
  assert.ok(agent.json.warnings?.some((w) => /배정 기준으로 쓸 설명이 없습니다/.test(w)));
  const fine = await api('PUT', '/api/agents/layer-1', { specialty: '시장조사' });
  assert.equal(fine.json.warnings, undefined);
  const badModel = await api('PUT', '/api/agents/layer-1', { model: 'gpt-4' });
  assert.equal(badModel.status, 400);

  const put = await api('PUT', '/api/company', { rules: '회사 공통 규칙 본문' });
  assert.equal(put.status, 200, put.text);
  assert.equal((await request('GET', '/api/company', { headers: tokenOnly() })).json.rules.trim(), '회사 공통 규칙 본문');
  const tooLong = await api('PUT', '/api/company', { rules: 'x'.repeat(8001) });
  assert.equal(tooLong.status, 400);
  const noToken = await request('PUT', '/api/company', { body: { rules: 'x' }, headers: { Origin: base, 'Content-Type': 'application/json' } });
  assert.equal(noToken.status, 403);

  const file = readFileSync(join(root, '.claude', 'agents', 'layer-1.md'), 'utf8');
  const order = ['## 근무 규칙', '회사 공통 규칙 본문', '부서 공통 지침 본문', '역할 지침 본문'].map((s) => file.indexOf(s));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `지침 순서: ${order}`);
  assert.match(file, /^model: haiku$/m);

  // 휴무 직원도 미리보기 가능
  await api('POST', '/api/agents/layer-1/duty', { active: false });
  assert.ok(!existsSync(join(root, '.claude', 'agents', 'layer-1.md')));
  const preview = await request('GET', '/api/agents/layer-1/preview', { headers: tokenOnly() });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['x-agent-file'], '.claude/agents/layer-1.md');
  assert.ok(preview.text.includes('역할 지침 본문'));
  assert.equal((await request('GET', '/api/agents/ghost-9/preview', { headers: tokenOnly() })).status, 404);

  await api('PUT', '/api/company', { rules: '' });
  await api('DELETE', '/api/departments/layer?cascade=1');
});
