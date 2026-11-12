import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASIDE_CONNECTION, agentEngine, asideAdvice, asideExecArgs, browserWorkHistory, createAside, fallbackEngine, parseExecOutput, resolveAside } from '../lib/aside.mjs';
import { validateOrg } from '../lib/org.mjs';
import { createBrowserWork, sentMailReceipt } from '../lib/browser-work.mjs';
import { AccountProtected } from '../lib/browser-session.mjs';
import { createRunner } from '../dashboard/runner.mjs';
import { asideBanners } from '../dashboard/public/app.js';
import { asideCheck } from '../lib/doctor.mjs';

const temp = (t, prefix = 'aside-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
};

// CLI 한 번 실행을 흉내 내는 가짜 spawn: 인자·표준 입력을 기록하고 정해 둔 출력을 낸다
function fakeCli(respond) {
  const calls = [];
  const spawnImpl = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let input = '';
    child.stdin.on('data', (c) => { input += c; });
    child.stdin.on('finish', () => setImmediate(() => {
      const call = { bin, args, input };
      calls.push(call);
      const out = respond(call);
      child.stdout.end(out ?? '');
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    }));
    child.kill = () => true;
    return child;
  };
  return { calls, spawnImpl };
}
const replOut = (value) => JSON.stringify({ run: { content: [{ type: 'text', text: `✔︎ 탭\n__AIO__${JSON.stringify(value)}` }], error: null } });

test('직원 엔진: 직원 aside가 부서 엔진보다 먼저이고, 없을 때 대신할 엔진은 부서 엔진(aside 부서면 claude)', () => {
  assert.equal(agentEngine({ engine: 'aside' }, { engine: 'codex' }), 'aside');
  assert.equal(agentEngine({}, { engine: 'aside' }), 'aside');
  assert.equal(agentEngine({}, { engine: 'codex' }), 'codex');
  assert.equal(agentEngine({}, {}), 'claude');
  assert.equal(fallbackEngine({ engine: 'aside' }), 'claude');
  assert.equal(fallbackEngine({ engine: 'codex' }), 'codex');
});

test('조직 검증: 부서·직원 엔진 aside를 받고, 직원 단위에는 aside만 허용한다', () => {
  const base = { departments: [{ id: 'ops', name: '운영부', engine: 'aside' }, { id: 'biz', name: '제휴부', engine: 'claude' }],
    roster: [{ id: 'ops-1', name: '김', department: 'ops' }, { id: 'biz-1', name: '이', department: 'biz', engine: 'aside' }] };
  assert.equal(validateOrg(base).ok, true);
  const bad = structuredClone(base); bad.roster[1].engine = 'codex';
  assert.match(validateOrg(bad).errors.join('\n'), /직원 엔진은 비워 두거나/);
  const cleared = structuredClone(base); cleared.roster[1].engine = '';
  assert.equal(validateOrg(cleared).ok, true);
});

test('실행 파일 찾기와 exec 인자·출력 해석', (t) => {
  const dir = temp(t);
  const fake = join(dir, 'fake-aside.mjs'); writeFileSync(fake, '');
  assert.equal(resolveAside({ env: { ASIDE_BIN: fake, PATH: '' } }).found, true);
  assert.equal(resolveAside({ env: { PATH: '' }, home: dir, platform: 'linux' }).found, false);
  mkdirSync(join(dir, '.local', 'bin'), { recursive: true }); writeFileSync(join(dir, '.local', 'bin', 'aside'), '');
  assert.equal(resolveAside({ env: { PATH: '' }, home: dir, platform: 'linux' }).command, join(dir, '.local', 'bin', 'aside'));
  assert.deepEqual(asideExecArgs('일해 줘'), ['exec', '--json', '--timeout', '60m', '일해 줘']);
  assert.deepEqual(parseExecOutput('진행 중\n{"session":{"id":"x"},"outcome":"completed","answer":"끝","error":null}\n'), { session: { id: 'x' }, outcome: 'completed', answer: '끝', error: null });
  assert.equal(parseExecOutput('그냥 글자'), null);
});

test('화면 확인은 표준 입력으로 코드를 넘기고 결과 표식을 읽는다. 오류·빈 결과는 실패로 알린다', async (t) => {
  const dir = temp(t);
  const fake = join(dir, 'fake-aside.mjs'); writeFileSync(fake, '');
  let mode = 'ok';
  const cli = fakeCli(({ args }) => {
    if (mode === 'error') return JSON.stringify({ run: { content: [], error: 'Error: boom\n at x' } });
    if (mode === 'empty') return JSON.stringify({ run: { content: [{ type: 'text', text: '표식 없음' }], error: null } });
    return args.includes('repl') ? replOut({ url: 'https://cafe.naver.com/x', text: '잘 보고 갑니다 :)', needsLogin: false, protected: false }) : '';
  });
  const aside = createAside({ env: { ASIDE_BIN: fake }, spawnImpl: cli.spawnImpl });
  const page = await aside.readPage('https://cafe.naver.com/x', { hosts: ['naver.com'], waitFor: ['잘 보고'] });
  assert.equal(page.text, '잘 보고 갑니다 :)');
  assert.deepEqual(cli.calls[0].args.slice(-4), ['repl', '--json', '--file', '-']);
  assert.match(cli.calls[0].input, /openTab/); assert.match(cli.calls[0].input, /"waitFor":\["잘보고"\]/);
  assert.deepEqual(await aside.checkLogin('https://cafe.naver.com/x'), { status: 'ok', url: 'https://cafe.naver.com/x' });
  mode = 'error'; await assert.rejects(aside.readPage('https://cafe.naver.com/x'), /Aside 화면 확인 실패: Error: boom/);
  mode = 'empty'; await assert.rejects(aside.readPage('https://cafe.naver.com/x'), /비어 있습니다/);
  const missing = createAside({ env: { PATH: '' }, home: dir, platform: 'linux' });
  await assert.rejects(missing.readPage('https://x'), (e) => e.code === 'ASIDE_MISSING');
});

test('세션 정리는 이 실행 뒤 CLI로 시작해 아직 도는 세션만 멈춘다', async (t) => {
  const dir = temp(t);
  const fake = join(dir, 'fake-aside.mjs'); writeFileSync(fake, '');
  const since = '2026-11-12T08:00:00.000Z';
  const cli = fakeCli(({ args }) => args.includes('list') ? JSON.stringify({ sessions: [
    { id: 'run1', status: 'running', trigger: { source: 'cli' }, createdAt: '2026-11-12T08:00:03.000Z' },
    { id: 'idle1', status: 'idle', trigger: { source: 'cli' }, createdAt: '2026-11-12T08:00:03.000Z' },
    { id: 'old1', status: 'running', trigger: { source: 'cli' }, createdAt: '2026-11-12T07:00:00.000Z' },
    { id: 'app1', status: 'running', trigger: { source: 'app' }, createdAt: '2026-11-12T08:00:03.000Z' },
  ] }) : '');
  const aside = createAside({ env: { ASIDE_BIN: fake }, spawnImpl: cli.spawnImpl });
  assert.equal(await aside.stopSessions(since), 1);
  assert.deepEqual(cli.calls.filter((c) => c.args.includes('stop')).map((c) => c.args.at(-1)), ['run1']);
});

test('첨부 파일은 Aside 작업 폴더에 잠시 복사하고 끝나면 지운다', (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, '.aside', 'u', '0'), { recursive: true });
  writeFileSync(join(dir, '제안서.pdf'), 'PDF');
  const aside = createAside({ env: {}, home: dir });
  const staged = aside.stageFiles([{ name: '제안서.pdf', path: join(dir, '제안서.pdf') }]);
  assert.equal(readFileSync(staged.files[0].path, 'utf8'), 'PDF');
  assert.ok(staged.files[0].path.startsWith(join(dir, '.aside', 'u', '0', 'ai-office')));
  staged.cleanup();
  assert.equal(existsSync(staged.dir), false);
  assert.throws(() => createAside({ env: {}, home: join(dir, 'none') }).stageFiles([{ name: 'a', path: join(dir, '제안서.pdf') }]), /작업 폴더/);
});

test('권장 안내: 지난 업무에서 브라우저 일을 맡은 직원을 찾아 Aside 엔진 변경을 권하고, 없으면 설치를 권한다', (t) => {
  const root = temp(t);
  mkdirSync(join(root, '.office', 'orchestrations'), { recursive: true });
  writeFileSync(join(root, '.office', 'orchestrations', 'r1.json'), JSON.stringify({ plan: {
    publications: [{ action: 'mail', agent: 'biz-1' }], stages: [{ agent: 'ops-1', connection: 'erp-1' }, { agent: 'res-1', connection: 'public' }] } }));
  const org = { departments: [{ id: 'biz', name: '제휴사업부' }, { id: 'ops', name: '운영부' }, { id: 'res', name: '리서치부' }],
    roster: [{ id: 'biz-1', name: '신제안 대리', department: 'biz' }, { id: 'ops-1', name: '정운영', department: 'ops', engine: 'aside' }, { id: 'res-1', name: '박조사', department: 'res' }] };
  assert.deepEqual([...browserWorkHistory(root).keys()].sort(), ['biz-1', 'ops-1']);
  const advice = asideAdvice({ org, root, installed: true });
  assert.equal(advice.level, 'warn');
  assert.deepEqual(advice.candidates.map((c) => c.id), ['biz-1']);
  assert.match(advice.message, /현재 브라우저 업무를 맡았던 직원이 있습니다: 제휴사업부 신제안 대리\(메일 발송\)\. 이 직원들은 엔진을 Aside로 바꾸길 권장드립니다/);
  const missing = asideAdvice({ org, root, installed: false });
  assert.equal(missing.installed, false);
  assert.match(missing.message, /설치돼 있지 않아 기존 브라우저\(Playwright\)로 실행합니다/);
  org.roster[0].engine = 'aside';
  assert.equal(asideAdvice({ org, root, installed: true }).level, 'ok');
  assert.deepEqual(asideBanners({ level: 'ok', message: 'x' }), []);
  assert.deepEqual(asideBanners({ level: 'info', message: '설치 권장' }), [], '바꿀 직원이 없으면 배너를 띄우지 않는다');
  assert.equal(asideBanners(advice)[0].text, advice.message);
  assert.deepEqual(asideBanners(advice, { demo: true }), []);
});

test('doctor: Aside 미설치는 선택 항목 경고와 설치 명령, 설치·로그인이면 직원 권장을 보여 준다', async (t) => {
  const program = temp(t, 'aside-program-');
  const ws = temp(t, 'aside-ws-');
  mkdirSync(join(ws, 'org'), { recursive: true });
  writeFileSync(join(ws, 'org', 'departments.json'), '[]'); writeFileSync(join(ws, 'org', 'roster.json'), '[]');
  const env = { AI_OFFICE_WORKSPACE: ws, PATH: '' };
  const missing = await asideCheck({ env, platform: 'darwin', program, aside: { installed: () => false, status: async () => ({ installed: false }) } });
  assert.equal(missing.status, 'warn'); assert.equal(missing.optional, true); assert.equal(missing.fixKey, 'asideInstall');
  const ready = await asideCheck({ env, platform: 'darwin', program, aside: { installed: () => true, status: async () => ({ installed: true, running: true, signedIn: true }) } });
  assert.match(ready.message, /설치됨·실행 중·로그인됨/);
  const signedOut = await asideCheck({ env, platform: 'darwin', program, aside: { installed: () => true, status: async () => ({ installed: true, running: true, signedIn: false }) } });
  assert.equal(signedOut.fixKey, 'asideLogin');
});

test('보낸 메일 확인: 보낸사람 주소를 모르면 받는사람 전원과 다른 주소 하나까지만 인정한다', () => {
  const url = 'https://mail.worksmobile.com/read/popup?nMailId=123';
  const text = '제휴 제안 보낸사람 나<me@corp.com> 받는사람 상대<you@partner.com> 안녕하세요 본문입니다';
  const base = { attempted: true, url, text, subject: '제휴 제안', body: '안녕하세요 본문입니다', recipients: ['you@partner.com'] };
  assert.equal(sentMailReceipt({ ...base, sender: null }), null, '보낸사람을 모르면 기본은 확인하지 않는다');
  assert.equal(sentMailReceipt({ ...base, unknownSender: true }).messageId, '123');
  assert.equal(sentMailReceipt({ ...base, unknownSender: true, text: text.replace('you@partner.com', 'other@x.com') }), null);
  assert.equal(sentMailReceipt({ ...base, unknownSender: true, text: '제휴 제안 a<a@x.com> b<b@x.com> 상대<you@partner.com> 안녕하세요 본문입니다' }), null);
  assert.equal(sentMailReceipt({ ...base, sender: 'me@corp.com' }).messageId, '123');
});

// ---- Aside 직원의 외부 작업(실행기가 실행 전후 화면을 읽어 대조) ----
function asideWork(t, { pages = {}, login = 'ok', sent = [[], ['900']], stageDir, readFail = 0, apiAccounts = [] } = {}) {
  const root = temp(t, 'aside-work-');
  const reads = [];
  let linkCall = 0;
  const aside = {
    checkLogin: async (url) => ({ status: typeof login === 'function' ? login(url) : login, url }),
    readPage: async (url, opts) => { reads.push({ url, opts }); if (reads.length <= readFail) throw new Error(`읽기 실패 ${reads.length}`); const value = typeof pages[url] === 'function' ? pages[url](reads.filter((r) => r.url === url).length) : pages[url]; return { url, text: value ?? '', needsLogin: false, protected: false }; },
    links: async () => ({ url: 'https://mail.worksmobile.com/w/sent', links: (sent[Math.min(linkCall++, sent.length - 1)] || []).map((id) => ({ text: '제휴 제안', href: `https://mail.worksmobile.com/read/popup?nMailId=${id}` })), needsLogin: false }),
    stageFiles: (files) => ({ files: files.map((f) => ({ name: f.name, path: join(stageDir || root, f.name) })), cleanup: () => { aside.cleaned = true; } }),
  };
  // 실제 연결 저장소처럼 없는 계정(aside 등)을 조회하면 오류를 낸다(2026-11-12 실사이트에서 글 결과 확인이 이 오류로 실패했다)
  const store = { list: () => apiAccounts.map((id) => ({ id, provider: 'naver' })), find: () => { throw new Error('연결 계정을 찾을 수 없습니다.'); }, credentials: () => { throw new Error('연결 계정을 찾을 수 없습니다.'); }, directory: root };
  const apiPosts = [];
  const cafeApi = { connected: (id) => apiAccounts.includes(id), post: async (id, args) => { apiPosts.push({ id, ...args }); return { articleId: '501', articleUrl: 'https://cafe.naver.com/petdilab/501' }; } };
  const work = createBrowserWork({ root, store, sessions: { close: async () => {} }, aside, cafeApi, readbackDelayMs: 1 });
  t.after(() => work.close());
  return { root, work, aside, reads, apiPosts };
}
const baseDeliver = { scope: 'scope-1', allowedActions: ['mail', 'post', 'comment', 'web'], instructionKey: 'k1', signal: new AbortController().signal, engine: 'aside' };
const records = (root) => { const dir = join(root, '.office', 'publications'); return existsSync(dir) ? readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []; };

test('Aside 댓글: 실행 뒤 같은 문구가 늘었으면 확인 완료, 같은 대상은 다시 실행하지 않는다', async (t) => {
  const target = 'https://cafe.naver.com/f-e/cafes/1/articles/2';
  const f = asideWork(t, { pages: { [target]: (n) => n === 1 ? '댓글 하나' : '댓글 하나 잘 보고 갑니다 :)' } });
  let runs = 0;
  const publication = { id: 'c1', action: 'comment', service: 'naver_cafe', connection: ASIDE_CONNECTION, target, recipients: [], subject: '' };
  const result = await f.work.deliver({ ...baseDeliver, publication, body: '잘 보고 갑니다 :)', execute: async (browser, extra) => { runs++; assert.equal(browser, null); assert.deepEqual(extra.files, []); return '{"status":"done","submitted":true,"summary":"등록"}'; } });
  assert.equal(result.status, 'confirmed'); assert.equal(result.method, 'aside'); assert.equal(result.confirmedBy, 'aside-readback');
  assert.equal(f.reads[1].opts.waitFor[0], '잘보고갑니다:)');
  const again = await f.work.deliver({ ...baseDeliver, publication, body: '잘 보고 갑니다 :)', execute: async () => { runs++; return ''; } });
  assert.equal(again.status, 'confirmed'); assert.equal(runs, 1, '확인된 같은 댓글은 다시 실행하지 않는다');
});

test('Aside 결과가 안 보이면 불확실로 멈추고, 직원이 누르지 않았다고 하면 다시 할 수 있게 남긴다', async (t) => {
  const target = 'https://cafe.naver.com/f-e/cafes/1/articles/3';
  const f = asideWork(t, { pages: { [target]: '댓글 없음' } });
  const publication = { id: 'c2', action: 'comment', service: 'naver_cafe', connection: ASIDE_CONNECTION, target, recipients: [], subject: '' };
  await assert.rejects(f.work.deliver({ ...baseDeliver, publication, body: '안녕하세요', execute: async () => '{"status":"done","submitted":true}' }), /결과 화면에서 검토한 원문을 확인하지 못했습니다/);
  assert.equal(records(f.root)[0].status, 'uncertain');
  await assert.rejects(f.work.deliver({ ...baseDeliver, publication, body: '안녕하세요', execute: async () => { throw new Error('실행되면 안 됨'); } }), /불확실/);
  const g = asideWork(t, { pages: { [target]: '댓글 없음' } });
  await assert.rejects(g.work.deliver({ ...baseDeliver, publication, body: '안녕하세요', execute: async () => '{"status":"needs_decision","submitted":false,"question":"글 제목이 달라 등록하지 않았습니다"}' }), /Aside 직원 확인 필요: 글 제목이 달라/);
  assert.equal(records(g.root)[0].status, 'prepared');
});

test('Aside 글은 직원이 알려 준 게시 주소에서 제목·본문을 확인한다. 주소가 없거나 다른 사이트면 확인하지 않는다', async (t) => {
  const posted = 'https://cafe.naver.com/f-e/cafes/1/articles/77';
  const f = asideWork(t, { pages: { [posted]: '오늘의 소식 첫 문단입니다 끝' } });
  const publication = { id: 'p1', action: 'post', service: 'naver_cafe', connection: ASIDE_CONNECTION, target: 'https://cafe.naver.com/f-e/cafes/1/menus/2', recipients: [], subject: '오늘의 소식' };
  const result = await f.work.deliver({ ...baseDeliver, publication, body: '첫 문단입니다 끝', execute: async () => JSON.stringify({ status: 'done', submitted: true, resultUrl: posted }) });
  assert.equal(result.status, 'confirmed'); assert.equal(result.resultUrl, posted);
  const g = asideWork(t, { pages: { 'https://evil.example/x': '오늘의 소식 첫 문단입니다 끝' } });
  await assert.rejects(g.work.deliver({ ...baseDeliver, publication: { ...publication, id: 'p2' }, body: '첫 문단입니다 끝', execute: async () => JSON.stringify({ status: 'done', submitted: true, resultUrl: 'https://evil.example/x' }) }), /확인하지 못했습니다/);
});

test('Aside 메일은 새로 생긴 보낸 메일 상세에서 본문·받는사람을 확인하고, 첨부는 Aside 작업 폴더 경로로 넘긴다', async (t) => {
  const detail = 'https://mail.worksmobile.com/read/popup?nMailId=900';
  const f = asideWork(t, { pages: { [detail]: '제휴 제안 보낸사람 나<me@corp.com> 받는사람 상대<you@partner.com> 안녕하세요 제휴 문의입니다' } });
  const file = join(f.root, '제안서.pdf'); writeFileSync(file, 'PDF');
  let staged;
  const publication = { id: 'm1', action: 'mail', service: 'naverworks_mail', connection: ASIDE_CONNECTION, target: '', recipients: ['you@partner.com'], subject: '제휴 제안' };
  const result = await f.work.deliver({ ...baseDeliver, publication, body: '안녕하세요 제휴 문의입니다', files: [{ name: '제안서.pdf', path: file }],
    execute: async (_browser, extra) => { staged = extra.files; return '{"status":"done","submitted":true}'; } });
  assert.equal(result.status, 'confirmed'); assert.equal(result.evidence.messageId, '900');
  assert.equal(staged[0].name, '제안서.pdf'); assert.equal(f.aside.cleaned, true, '첨부 사본은 지운다');
});

test('Aside 로그인이 필요하면 실행 전에 알리고, 보호 조치면 멈춘다(기록을 남기지 않는다)', async (t) => {
  const target = 'https://cafe.naver.com/f-e/cafes/1/articles/4';
  const publication = { id: 'c3', action: 'comment', service: 'naver_cafe', connection: ASIDE_CONNECTION, target, recipients: [], subject: '' };
  const f = asideWork(t, { login: 'needs_login' });
  await assert.rejects(f.work.deliver({ ...baseDeliver, publication, body: '안녕', execute: async () => { throw new Error('실행되면 안 됨'); } }), (e) => e.code === 'ASIDE_LOGIN' && e.target === target);
  assert.deepEqual(records(f.root), []);
  const g = asideWork(t, { login: 'protected' });
  await assert.rejects(g.work.deliver({ ...baseDeliver, publication, body: '안녕', execute: async () => '' }), AccountProtected);
});

test('Aside 일반 웹사이트 작업은 직원 보고(완료·결과 주소)를 증표로 남기고, 미완료는 완료로 닫지 않는다', async (t) => {
  const f = asideWork(t);
  const publication = { id: 'w1', action: 'web', service: 'web', connection: ASIDE_CONNECTION, target: 'https://erp.example.com/admin' };
  const done = await f.work.deliver({ ...baseDeliver, publication, body: '업체를 추가한다', execute: async () => JSON.stringify({ status: 'done', completed: true, summary: '업체 추가함', resultUrl: 'https://erp.example.com/admin/1?token=abc' }) });
  assert.equal(done.status, 'confirmed'); assert.equal(done.confirmedBy, 'aside-staff-report'); assert.equal(done.resultUrl, 'https://erp.example.com/admin/1');
  const g = asideWork(t);
  await assert.rejects(g.work.deliver({ ...baseDeliver, publication, body: '업체를 추가한다', execute: async () => JSON.stringify({ status: 'done', completed: false, summary: '권한 없음' }) }), /끝내지 못했습니다.*권한 없음/);
});

test('Aside 로그인 대기: 로그인 화면을 대표 창에 열고 로그인되면 이어 간다', async (t) => {
  let checks = 0;
  const f = asideWork(t, { login: () => (++checks >= 2 ? 'ok' : 'needs_login') });
  f.aside.openVisible = async (url) => { f.aside.opened = url; return { opened: true, url }; };
  const result = await f.work.asideRequestLogin({ target: 'https://cafe.naver.com/petdilab', pollMs: 5, timeoutMs: 2000 });
  assert.deepEqual(result, { status: 'ok' });
  assert.match(f.aside.opened, /nid\.naver\.com\/nidlogin\.login/);
});

// ---- 실행기: Aside 직원 실행 명세 ----
function runnerRoot(t, { asideBin = true } = {}) {
  const root = temp(t, 'aside-runner-');
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'biz', name: '제휴부', engine: 'claude' }]));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'biz-1', name: '신제안', department: 'biz', engine: 'aside', instructions: '메일을 보낸다.' }]));
  const fake = join(root, 'fake-aside.mjs'); writeFileSync(fake, '');
  return { root, env: asideBin ? { ...process.env, ASIDE_BIN: fake } : { ...process.env, ASIDE_BIN: join(root, 'none', 'aside'), HOME: root, USERPROFILE: root } };
}

test('실행기: Aside 직원은 aside exec로 실행하고 답변(answer)을 결과로 쓴다. 실패면 세션을 정리한다', async (t) => {
  const { root, env } = runnerRoot(t);
  const spawned = [];
  const spawnImpl = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true; child.pid = undefined;
    spawned.push({ bin, args });
    setImmediate(() => {
      if (args.includes('list')) child.stdout.end(JSON.stringify({ sessions: [] }));
      else child.stdout.end(JSON.stringify({ session: { id: 's1' }, outcome: spawned.length === 1 ? 'completed' : 'failed', answer: spawned.length === 1 ? '보냈습니다' : '', error: spawned.length === 1 ? null : '실패' }) + '\n');
      child.stderr.end();
      setImmediate(() => child.emit('close', spawned.length === 1 ? 0 : 1, null));
    });
    return child;
  };
  const stopped = [];
  const runner = createRunner({ root, env, spawnImpl, aside: { stopSessions: async (since) => { stopped.push(since); return 0; } } });
  t.after(() => runner.stopAll({ graceMs: 10 }));
  const run = runner.start({ agentId: 'biz-1', prompt: '메일 보내 줘' });
  const until = Date.now() + 5000;
  while (['running', 'queued'].includes(runner.list().find((r) => r.id === run.id).status) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  const done = runner.list().find((r) => r.id === run.id);
  assert.equal(done.engine, 'aside'); assert.equal(done.status, 'done'); assert.equal(done.summary, '보냈습니다');
  const args = spawned[0].args;
  assert.deepEqual(args.slice(1, 5), ['exec', '--json', '--timeout', '60m']);
  assert.match(args.at(-1), /Aside 브라우저 직원이다/); assert.match(args.at(-1), /메일 보내 줘/);
  assert.doesNotMatch(args.at(-1), /office_browser|업무 폴더 `outputs/, 'Aside 직원에게 Claude 직원용 파일·도구 규칙을 주지 않는다');
  const second = runner.start({ agentId: 'biz-1', prompt: '다시' });
  const until2 = Date.now() + 5000;
  while (['running', 'queued'].includes(runner.list().find((r) => r.id === second.id).status) && Date.now() < until2) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.list().find((r) => r.id === second.id).status, 'failed');
  assert.equal(stopped.length, 1, '실패한 Aside 실행은 남은 세션을 정리한다');
});

test('실행기: Aside가 없으면 부서 엔진(Claude)으로 실행한다', async (t) => {
  const { root, env } = runnerRoot(t, { asideBin: false });
  const spawned = [];
  const spawnImpl = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    spawned.push({ bin, args });
    child.stdin.on('finish', () => setImmediate(() => { child.stdout.end(JSON.stringify({ type: 'result', result: '완료' }) + '\n'); child.stderr.end(); setImmediate(() => child.emit('close', 0, null)); }));
    return child;
  };
  const runner = createRunner({ root, env, spawnImpl, aside: { stopSessions: async () => 0 } });
  t.after(() => runner.stopAll({ graceMs: 10 }));
  const run = runner.start({ agentId: 'biz-1', prompt: '메일 보내 줘' });
  const until = Date.now() + 5000;
  while (['running', 'queued'].includes(runner.list().find((r) => r.id === run.id).status) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.list().find((r) => r.id === run.id).engine, 'claude');
  assert.ok(spawned[0].args.includes('--agent'));
});

test('Aside 결과 확인은 읽기가 실패하면 짧게 다시 읽고, 끝내 못 읽으면 이유를 불확실 기록에 남긴다', async (t) => {
  const posted = 'https://cafe.naver.com/f-e/cafes/1/articles/88';
  const publication = { id: 'p9', action: 'post', service: 'naver_cafe', connection: ASIDE_CONNECTION, target: 'https://cafe.naver.com/f-e/cafes/1/menus/2', recipients: [], subject: '집사 일기' };
  const execute = async () => JSON.stringify({ status: 'done', submitted: true, resultUrl: posted });
  // 첫 읽기만 실패: 다시 읽어 확인한다(직원은 한 번만 실행)
  const f = asideWork(t, { pages: { [posted]: '집사 일기 오늘의 이야기입니다' }, readFail: 1 });
  let runs = 0;
  const ok = await f.work.deliver({ ...baseDeliver, publication, body: '오늘의 이야기입니다', execute: async (...a) => { runs++; return execute(...a); } });
  assert.equal(ok.status, 'confirmed'); assert.equal(runs, 1); assert.equal(f.reads.length, 2);
  // 세 번 모두 실패: 불확실로 멈추고 이유·직원 보고 주소를 알린다
  const g = asideWork(t, { pages: { [posted]: '집사 일기 오늘의 이야기입니다' }, readFail: 99 });
  await assert.rejects(g.work.deliver({ ...baseDeliver, publication: { ...publication, id: 'p10' }, body: '오늘의 이야기입니다', execute }), /직원 보고 주소: https:\/\/cafe\.naver\.com\/f-e\/cafes\/1\/articles\/88.*올라간 것 확인했어/);
  const record = records(g.root)[0];
  assert.equal(record.status, 'uncertain'); assert.match(record.readbackError, /읽기 실패 3/);
  assert.equal(g.reads.length, 3);
});

test('Aside 직원도 카페 공식 API가 연결된 네이버 계정이 있으면 일반 글은 API로, 장소 카드 글만 Aside로 올린다', async (t) => {
  const board = 'https://cafe.naver.com/f-e/cafes/31520563/menus/44';
  const placeUrl = 'https://cafe.naver.com/f-e/cafes/31520563/articles/77';
  const f = asideWork(t, { apiAccounts: ['naver-1'], pages: { [placeUrl]: '성수 카페 소개 빵이 맛있어요' } });
  let asideRuns = 0;
  const execute = async () => { asideRuns++; return JSON.stringify({ status: 'done', submitted: true, resultUrl: placeUrl }); };
  const video = await f.work.deliver({ ...baseDeliver, publication: { id: 'v1', action: 'post', service: 'naver_cafe', connection: ASIDE_CONNECTION, target: board, recipients: [], subject: '댕댕이 귀환' },
    body: '문 열고 나갔다 돌아온 댕댕이\n\nhttps://www.youtube.com/shorts/jYsBJsmiOIc', execute });
  assert.equal(video.method, 'api'); assert.equal(video.connection, 'naver-1'); assert.equal(f.apiPosts.length, 1); assert.equal(asideRuns, 0, '일반 글은 Aside 직원을 띄우지 않는다');
  const place = await f.work.deliver({ ...baseDeliver, publication: { id: 'h1', action: 'post', service: 'naver_cafe', connection: ASIDE_CONNECTION, target: 'https://cafe.naver.com/f-e/cafes/31520563/menus/24', recipients: [], subject: '성수 카페' },
    body: '성수 카페 소개 빵이 맛있어요\n\nhttps://naver.me/abcd1234', execute });
  assert.equal(place.method, 'aside'); assert.equal(asideRuns, 1); assert.equal(f.apiPosts.length, 1, '장소 글은 API로 올리지 않는다');
  // API가 연결된 계정이 없으면 일반 글도 Aside로 올린다
  const g = asideWork(t, { pages: { [placeUrl]: '댕댕이 귀환 문 열고 나갔다 돌아온 댕댕이' } });
  const viaAside = await g.work.deliver({ ...baseDeliver, publication: { id: 'v2', action: 'post', service: 'naver_cafe', connection: ASIDE_CONNECTION, target: board, recipients: [], subject: '댕댕이 귀환' },
    body: '문 열고 나갔다 돌아온 댕댕이\n\nhttps://www.youtube.com/shorts/jYsBJsmiOIc', execute: async () => JSON.stringify({ status: 'done', submitted: true, resultUrl: placeUrl }) });
  assert.equal(viaAside.method, 'aside'); assert.equal(g.apiPosts.length, 0);
});
