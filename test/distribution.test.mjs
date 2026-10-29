// 배포 방식(각자 로컬 실행) 회귀 테스트: 개인 데이터 파일 부재 시작, 회사 구성 내보내기·가져오기(lib·API·CLI·화면 로직), 서버 tools 필드
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOrgImport, exportOrg, importOrg, loadOrg, saveCompanyRules, saveOrg } from '../lib/org.mjs';
import { syncAgents } from '../lib/sync.mjs';
import { startServer } from '../dashboard/server.mjs';
import { summarizeOrgImport, toolBanners, normalizeState } from '../dashboard/public/app.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFICE = join(REPO, 'scripts', 'office.mjs');
const SYNC = join(REPO, 'scripts', 'sync-agents.mjs');

// org/ 폴더도, .claude/agents·.codex/agents도 없는 빈 레포(처음 clone한 상태와 같음)
function emptyRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-dist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const sampleOrg = () => ({
  departments: [
    { id: 'research', name: '리서치부', en: 'RESEARCH', engine: 'claude', model: 'sonnet', summary: '조사' },
    { id: 'verify', name: '검증실', en: 'VERIFY', engine: 'codex', summary: '검토' },
  ],
  roster: [
    { id: 'research-1', name: '김팀장', department: 'research', title: '팀장', lead: true, specialty: '취합' },
    { id: 'research-2', name: '이대리', department: 'research', title: '담당', lead: false, specialty: '시장 조사', active: false },
    { id: 'verify-1', name: '박과장', department: 'verify', title: '담당', lead: false, specialty: '사실 확인', role: 'fact-checker' },
  ],
});

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
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function withServer(root, fn, opts = {}) {
  const publicDir = join(mkdtempSync(join(tmpdir(), 'office-dist-public-')), 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><meta name="office-token" content="__OFFICE_TOKEN__"><title>t</title>');
  const handle = await startServer({ root, port: 0, publicDir, quiet: true, ...opts });
  const base = `http://127.0.0.1:${handle.port}`;
  const authed = { 'X-Office-Token': handle.token, Origin: base, 'Content-Type': 'application/json' };
  try {
    await fn({ handle, base, authed });
  } finally {
    await handle.close();
    rmSync(dirname(publicDir), { recursive: true, force: true });
  }
}

const runCli = (root, args, opts = {}) =>
  spawnSync(process.execPath, [OFFICE, ...args], { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8', cwd: root, ...opts });

// 개인 데이터 파일은 사용자 컴퓨터에는 있을 수 있다(실제로 쓰는 중인 레포). 그래서 파일 존재가 아니라 Git 추적 여부로 검사한다
function git(args) {
  const res = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return res.error ? null : res;
}

test('저장소에 개인 데이터 파일이 없고 .gitignore가 제외한다', (t) => {
  const personal = ['org/departments.json', 'org/roster.json', 'org/company.md'];
  const inRepo = git(['rev-parse', '--is-inside-work-tree']);
  if (!inRepo || inRepo.status !== 0) {
    t.diagnostic('git 저장소가 아니어서 추적 여부 검사는 건너뜀(.gitignore만 검사)');
  } else {
    const tracked = git(['ls-files', '--', ...personal, '.claude/agents', '.codex/agents']);
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.deepEqual(tracked.stdout.split(/\r?\n/).filter(Boolean), [], '개인 데이터·생성 파일은 Git이 추적하지 않는다');
    // 사용자 컴퓨터에 파일이 있어도 Git이 무시하는지(.gitignore 판정)
    for (const f of [...personal, '.claude/agents/x.md', '.codex/agents/x.toml']) {
      assert.equal(git(['check-ignore', '-q', '--', f]).status, 0, `${f}는 .gitignore로 제외되어야 한다`);
    }
    const kept = git(['ls-files', '--', 'org/presets.json', '.claude/settings.json', '.claude/skills/office-task/SKILL.md']);
    assert.equal(kept.stdout.split(/\r?\n/).filter(Boolean).length, 3, '프리셋·훅 설정·스킬은 추적한다');
  }
  assert.ok(existsSync(join(REPO, 'org', 'presets.json')));
  const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const entry of ['org/departments.json', 'org/roster.json', 'org/company.md', '.claude/agents/', '.codex/agents/']) {
    assert.ok(ignore.includes(entry), `.gitignore에 ${entry}가 있어야 한다`);
  }
  // 훅 설정·스킬은 계속 추적한다
  assert.ok(!ignore.includes('.claude/') && !ignore.includes('.claude'), '.claude 전체를 제외하면 훅 설정이 빠진다');
});

test('파일 부재: loadOrg·syncAgents(검사·쓰기)·exportOrg가 빈 회사로 동작한다', (t) => {
  const root = emptyRoot(t);
  assert.deepEqual(loadOrg(root), { departments: [], roster: [] });
  const check = syncAgents(root, { write: false });
  assert.equal(check.ok, true);
  assert.deepEqual(check.diffs, []);
  const write = syncAgents(root, { write: true });
  assert.equal(write.ok, true);
  assert.equal(existsSync(join(root, '.claude')), false, '만들 파일이 없으면 폴더도 만들지 않는다');
  assert.deepEqual(exportOrg(root), { version: 1, company: '', departments: [], roster: [] });
  // sync-agents --check CLI도 빈 레포에서 통과
  const p = spawnSync(process.execPath, [SYNC, '--check'], { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
});

test('파일 부재: 저장하면 org/·.claude/agents·.codex/agents 폴더를 자동으로 만든다', (t) => {
  const root = emptyRoot(t);
  saveCompanyRules(root, '회사 규칙');
  assert.ok(existsSync(join(root, 'org', 'company.md')));
  const sync = saveOrg(root, sampleOrg());
  assert.deepEqual(sync.changed, ['.claude/agents/research-1.md', '.codex/agents/verify-1.toml']);
  assert.ok(readFileSync(join(root, '.claude', 'agents', 'research-1.md'), 'utf8').includes('회사 규칙'));
});

test('exportOrg → importOrg 왕복: 다른 빈 레포에 같은 구성·회사 규칙·에이전트 파일이 생긴다', async (t) => {
  const src = emptyRoot(t);
  saveOrg(src, sampleOrg());
  saveCompanyRules(src, '보고서는 존댓말로 쓴다.');
  const data = exportOrg(src);
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data).sort(), ['company', 'departments', 'roster', 'version']);

  const dst = emptyRoot(t);
  // JSON 직렬화를 거쳐도 같아야 한다(파일 다운로드·업로드 경로)
  const out = await importOrg(dst, JSON.parse(JSON.stringify(data)));
  assert.deepEqual(out.summary, { departments: 2, roster: 3, company: true });
  assert.deepEqual(exportOrg(dst), data);
  // 휴무 직원(research-2)은 파일이 없고, codex 부서는 .toml
  assert.ok(existsSync(join(dst, '.claude', 'agents', 'research-1.md')));
  assert.ok(!existsSync(join(dst, '.claude', 'agents', 'research-2.md')));
  assert.ok(readFileSync(join(dst, '.codex', 'agents', 'verify-1.toml'), 'utf8').includes('보고서는 존댓말로 쓴다.'));
  assert.equal(syncAgents(dst, { write: false }).ok, true);
});

test('importOrg는 덮어쓰기: 이전 구성의 생성 파일은 지우고 표식 없는 사용자 파일은 보존한다', async (t) => {
  const root = emptyRoot(t);
  saveOrg(root, sampleOrg());
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', 'my-helper.md'), '내 개인 에이전트\n');
  const next = { version: 1, company: '', departments: [{ id: 'ops', name: '운영부' }], roster: [{ id: 'ops-1', name: '최사원', department: 'ops' }] };
  await importOrg(root, next);
  assert.deepEqual(loadOrg(root).departments.map((d) => d.id), ['ops']);
  assert.ok(!existsSync(join(root, '.claude', 'agents', 'research-1.md')));
  assert.ok(!existsSync(join(root, '.codex', 'agents', 'verify-1.toml')));
  assert.ok(existsSync(join(root, '.claude', 'agents', 'ops-1.md')));
  assert.equal(readFileSync(join(root, '.claude', 'agents', 'my-helper.md'), 'utf8'), '내 개인 에이전트\n');
});

test('잘못된 가져오기는 거부하고 아무것도 쓰지 않는다', async (t) => {
  const root = emptyRoot(t);
  saveOrg(root, sampleOrg());
  saveCompanyRules(root, '원래 규칙');
  const before = exportOrg(root);
  const bad = [
    null,
    [],
    { departments: [], roster: [] }, // version 없음
    { version: 2, company: '', departments: [], roster: [] },
    { version: 1, company: 5, departments: [], roster: [] },
    { version: 1, company: 'x'.repeat(8001), departments: [], roster: [] },
    { version: 1, company: '', departments: {}, roster: [] },
    { version: 1, company: '', departments: [{ id: 'Bad Id', name: 'x' }], roster: [] },
    { version: 1, company: '', departments: [{ id: 'ops', name: '운영' }], roster: [{ id: 'ops-1', name: 'a', department: 'nope' }] },
    { version: 1, company: '', departments: [{ id: 'ops', name: '운영' }], roster: [{ id: 'chief', name: 'a', department: 'ops' }] },
  ];
  for (const data of bad) {
    assert.equal(checkOrgImport(data).ok, false, JSON.stringify(data)?.slice(0, 80));
    await assert.rejects(importOrg(root, data), (err) => Array.isArray(err.errors) && err.errors.length > 0);
  }
  await assert.rejects(importOrg(root, before, { mode: 'merge' }), /replace만 지원/);
  assert.deepEqual(exportOrg(root), before, '실패한 가져오기는 정본과 회사 규칙을 바꾸지 않는다');
});

test('서버: 정본·에이전트 폴더가 없는 레포(처음 clone)에서 시작하고, 첫 저장 때 폴더를 만든다', async (t) => {
  const root = emptyRoot(t);
  // 처음 clone한 상태: org/에는 presets.json·templates만 있고 정본·에이전트 폴더는 없다
  mkdirSync(join(root, 'org'));
  copyFileSync(join(REPO, 'org', 'presets.json'), join(root, 'org', 'presets.json'));
  await withServer(root, async ({ base, authed }) => {
    const state = await request(base, 'GET', '/api/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.json.departments, []);
    assert.ok(state.json.presets.departments.length > 0);
    const dept = await request(base, 'POST', '/api/departments', { body: { name: '리서치부', en: 'RESEARCH' }, headers: authed });
    assert.equal(dept.status, 201, dept.text);
    const agent = await request(base, 'POST', '/api/agents', { body: { name: '김대리', department: 'research', specialty: '조사' }, headers: authed });
    assert.equal(agent.status, 201, agent.text);
    assert.ok(existsSync(join(root, 'org', 'departments.json')));
    assert.ok(existsSync(join(root, '.claude', 'agents', `${agent.json.id}.md`)));
  });
});

test('서버: GET /api/org/export(토큰 필요, 첨부 파일) → POST /api/org/import 왕복', async (t) => {
  const src = emptyRoot(t);
  saveOrg(src, sampleOrg());
  saveCompanyRules(src, '회사 규칙 본문');
  let exported;
  await withServer(src, async ({ handle, base }) => {
    assert.equal((await request(base, 'GET', '/api/org/export')).status, 403, '토큰 없이 내보낼 수 없다');
    const res = await request(base, 'GET', '/api/org/export', { headers: { 'X-Office-Token': handle.token } });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="ai-office-org-\d{4}-\d{2}-\d{2}\.json"$/);
    exported = res.json;
    assert.deepEqual(exported, exportOrg(src));
  });

  const dst = emptyRoot(t);
  await withServer(dst, async ({ base, authed }) => {
    const noToken = await request(base, 'POST', '/api/org/import', { body: { data: exported, mode: 'replace' }, headers: { Origin: base, 'Content-Type': 'application/json' } });
    assert.equal(noToken.status, 403);
    const badMode = await request(base, 'POST', '/api/org/import', { body: { data: exported, mode: 'merge' }, headers: authed });
    assert.equal(badMode.status, 400);
    const ok = await request(base, 'POST', '/api/org/import', { body: { data: exported, mode: 'replace' }, headers: authed });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.departments, 2);
    assert.equal(ok.json.roster, 3);
    assert.equal(ok.json.company, true);
    const state = await request(base, 'GET', '/api/state');
    assert.deepEqual(state.json.departments.map((d) => d.id).sort(), ['research', 'verify']);
    assert.deepEqual(exportOrg(dst), exported);
  });
});

test('서버: 1MB를 넘는 회사 구성도 가져올 수 있다(가져오기만 8MB 한도)', async (t) => {
  const root = emptyRoot(t);
  // 한글 지침 4000자(약 12KB) × 100개 부서 ≈ 1.2MB: 다른 API의 1MB 한도를 넘는다
  const departments = Array.from({ length: 100 }, (_, i) => ({ id: `dept-${i + 1}`, name: `부서${i + 1}`, instructions: '가'.repeat(4000) }));
  const data = { version: 1, company: '', departments, roster: [] };
  assert.ok(Buffer.byteLength(JSON.stringify({ data, mode: 'replace' })) > 1024 * 1024);
  await withServer(root, async ({ base, authed }) => {
    const res = await request(base, 'POST', '/api/org/import', { body: { data, mode: 'replace' }, headers: authed });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.departments, 100);
    // 다른 상태 변경 API의 1MB 한도는 그대로다
    const big = await request(base, 'PUT', '/api/company', { body: { rules: '가'.repeat(400_000) }, headers: authed });
    assert.equal(big.status, 413);
  });
  assert.equal(loadOrg(root).departments.length, 100);
});

test('서버: 잘못된 가져오기는 400이고 저장하지 않는다, 데모 모드는 409', async (t) => {
  const root = emptyRoot(t);
  saveOrg(root, sampleOrg());
  const before = exportOrg(root);
  await withServer(root, async ({ base, authed }) => {
    for (const data of [{ version: 9, departments: [], roster: [] }, { version: 1, departments: [{ id: 'x', name: '' }], roster: [] }, 'text']) {
      const res = await request(base, 'POST', '/api/org/import', { body: { data, mode: 'replace' }, headers: authed });
      assert.equal(res.status, 400, res.text);
      assert.ok(res.json.error);
    }
    const missing = await request(base, 'POST', '/api/org/import', { body: { mode: 'replace' }, headers: authed });
    assert.equal(missing.status, 400);
  });
  assert.deepEqual(exportOrg(root), before);

  await withServer(root, async ({ base, authed }) => {
    const res = await request(base, 'POST', '/api/org/import', { body: { data: before, mode: 'replace' }, headers: authed });
    assert.equal(res.status, 409);
  }, { demo: true });
});

test('서버: 시작 때 빠른 점검 결과를 /api/state의 tools로 알린다(설치 여부만)', async (t) => {
  const root = emptyRoot(t);
  const fake = join(root, 'fake-claude.js');
  writeFileSync(fake, 'process.exit(0)\n');
  const env = { ...process.env, CLAUDE_BIN: fake, CODEX_BIN: join(root, 'no-such-codex.js') };
  await withServer(root, async ({ base }) => {
    let tools;
    for (let i = 0; i < 40; i++) {
      tools = (await request(base, 'GET', '/api/state')).json.tools;
      if (tools?.claude?.installed !== null && tools?.codex?.installed !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(tools, { claude: { installed: true }, codex: { installed: false } });
  }, { env });
});

test('화면 로직: 도구 배너 문구와 가져오기 요약', () => {
  assert.deepEqual(toolBanners({ claude: { installed: true }, codex: { installed: true } }), []);
  assert.deepEqual(toolBanners({ claude: { installed: null }, codex: { installed: null } }), [], '점검 전(null)에는 알리지 않는다');
  const banners = toolBanners({ claude: { installed: true }, codex: { installed: false } });
  assert.equal(banners.length, 1);
  assert.match(banners[0].text, /codex가 설치되지 않아 검증실을 실행할 수 없습니다 — npm run doctor/);
  assert.equal(toolBanners({ claude: { installed: false }, codex: { installed: false } }).length, 2);
  assert.deepEqual(toolBanners({ codex: { installed: false } }, { demo: true }), [], '데모 모드에서는 배너를 띄우지 않는다');
  assert.deepEqual(normalizeState({ tools: { codex: { installed: false } } }).tools, { codex: { installed: false } });

  assert.deepEqual(summarizeOrgImport({ version: 1, company: '규칙', ...sampleOrg() }), { ok: true, departments: 2, roster: 3, company: true });
  for (const bad of [null, [], { version: 2, departments: [], roster: [] }, { version: 1, departments: [] }, { version: 1, departments: [], roster: [], company: 3 }]) {
    assert.equal(summarizeOrgImport(bad).ok, false);
  }
});

test('CLI: org export → import 왕복, --yes 없이는 덮어쓰지 않음, 잘못된 파일 거부', (t) => {
  const src = emptyRoot(t);
  saveOrg(src, sampleOrg());
  saveCompanyRules(src, '회사 규칙');
  const file = join(src, 'backup', 'org.json');
  let p = runCli(src, ['org', 'export', file]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /부서 2개 · 직원 3명 · 회사 공통 규칙 있음/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), exportOrg(src));
  // 이미 있는 파일은 --yes 없이 덮어쓰지 않는다
  p = runCli(src, ['org', 'export', file]);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /--yes/);
  assert.equal(runCli(src, ['org', 'export', file, '--yes']).status, 0);

  const dst = emptyRoot(t);
  p = runCli(dst, ['org', 'import', file], { input: '' }); // 대화형이 아니면 확인 없이 덮어쓰지 않는다
  assert.equal(p.status, 1);
  assert.match(p.stderr, /덮어쓰지 않았습니다/);
  assert.equal(existsSync(join(dst, 'org', 'departments.json')), false);

  p = runCli(dst, ['org', 'import', file, '--yes']);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(exportOrg(dst), exportOrg(src));
  assert.ok(existsSync(join(dst, '.claude', 'agents', 'research-1.md')));

  const badFile = join(dst, 'bad.json');
  writeFileSync(badFile, JSON.stringify({ version: 1, company: '', departments: [{ id: 'ops', name: '운영' }], roster: [{ id: 'ops-1', name: 'a', department: 'gone' }] }));
  p = runCli(dst, ['org', 'import', badFile, '--yes']);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /소속 부서가 없습니다/);
  writeFileSync(badFile, '{ not json');
  assert.equal(runCli(dst, ['org', 'import', badFile, '--yes']).status, 1);
  assert.equal(runCli(dst, ['org', 'import', join(dst, 'nope.json'), '--yes']).status, 1);
  assert.deepEqual(exportOrg(dst), exportOrg(src), '실패한 가져오기는 기존 구성을 바꾸지 않는다');

  assert.equal(runCli(dst, ['org', 'import']).status, 64);
  assert.equal(runCli(dst, ['org', 'remove', file]).status, 64);
});
