import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { AccountProtected, accountProtected, createBrowserSessions, requiresLogin } from '../lib/browser-session.mjs';
import { createBrowserWork } from '../lib/browser-work.mjs';
import { createConnectionStore } from '../lib/connections.mjs';
import { verifyBrowserWork } from '../scripts/browser-fixture-checks.mjs';
import { verifyLogin } from '../scripts/login-fixture-checks.mjs';
import { verifyWebWork } from '../scripts/web-fixture-checks.mjs';
import { verifyCafeEditor, verifyMailAttachment, verifyMailEditor } from '../scripts/mail-fixture-checks.mjs';
test('실제 Playwright 브라우저: 로컬 가짜 사이트 발송·게시·댓글과 재실행 방지', async () => { await verifyBrowserWork(); });
test('실제 Playwright 브라우저: 직원 첫 로그인과 네이버웍스 단계형 인증', async () => { await verifyLogin(); });
test('실제 Playwright 브라우저: 일반 웹사이트 입력·파일 첨부·업로드 증표와 차단 규칙', async () => { await verifyWebWork(); });
test('실제 Playwright 브라우저: 메일 서명 유지와 보낸메일함 발송 확인', async () => { await verifyMailEditor(); });
test('실제 Playwright 브라우저: 카페 글쓰기 제목·게시판 선택·영상·장소 링크 카드', async () => { await verifyCafeEditor(); });
test('실제 Playwright 브라우저: 메일 지정 파일 첨부와 첨부 전 발송 거부', async () => { await verifyMailAttachment(); });

test('실제 브라우저: 로그인 창을 먼저 열고 대표가 로그인하면 창을 닫고 연결 완료로 이어 간다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-login-window-')), root = join(temp, 'workspace'); mkdirSync(root);
  let authenticated = false;
  const site = createServer((req, res) => {
    if (req.url.startsWith('/account')) authenticated = true;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(authenticated ? '<h1>내 정보</h1>' : '<form action="/account"><input type="password" name="p"><button>로그인</button></form>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const contexts = [];
  const browser = { launchPersistentContext: async (profile, options) => { const c = await chromium.launchPersistentContext(profile, { ...options, channel: undefined, headless: true }); contexts.push(c); return c; } };
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const sessions = createBrowserSessions({ store, browser, channel: null });
  t.after(async () => { await sessions.close(); await new Promise((resolve) => site.close(resolve)); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const work = createBrowserWork({ root, store, sessions });
  const waiting = work.requestLogin({ target: `http://localhost:${site.address().port}/`, pollMs: 50, timeoutMs: 30000 });
  while (!contexts[0]?.pages()[0]?.url().startsWith('http')) await new Promise((resolve) => setTimeout(resolve, 50));
  const page = contexts[0].pages()[0];
  await page.locator('input[type=password]').waitFor();
  await page.locator('#ai-office-login-banner').waitFor({ state: 'attached' });
  await page.locator('input[type=password]').fill('fixture');
  await page.locator('button').click();
  const result = await waiting;
  assert.equal(result.status, 'connected');
  assert.equal(store.list().find((c) => c.id === result.id).status, 'connected');
  assert.equal(contexts[0].pages().length, 0, '로그인을 마치면 창이 저절로 닫힌다');
});

test('실제 브라우저: 업무 시작 로그인 확인은 저장 상태가 연결됨이어도 풀린 창을 로그인 창으로 바꾸고, 대표가 로그인하면 연결 완료로 이어 간다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-login-check-')), root = join(temp, 'workspace'); mkdirSync(root);
  let authenticated = false;
  const site = createServer((req, res) => {
    if (req.url.startsWith('/account')) authenticated = true;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(authenticated ? '<h1>내 정보</h1>' : '<form action="/account"><input type="password" name="p"><button>로그인</button></form>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const contexts = [];
  const browser = { launchPersistentContext: async (profile, options) => { const c = await chromium.launchPersistentContext(profile, { ...options, channel: undefined, headless: true }); contexts.push(c); return c; } };
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const sessions = createBrowserSessions({ store, browser, channel: null });
  t.after(async () => { await sessions.close(); await new Promise((resolve) => site.close(resolve)); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const work = createBrowserWork({ root, store, sessions });
  const start = `http://localhost:${site.address().port}/`;
  // 어제 로그인해 '연결됨'으로 저장돼 있지만 사이트 로그인은 풀린 상태
  const saved = store.create({ provider: 'web', label: '사내', startUrl: start, hosts: [] });
  store.update(saved.id, { status: 'connected', manualLoginAt: '2026-11-09T00:00:00.000Z' });
  assert.equal((await work.checkLogin({ connection: saved.id, target: start })).status, 'needs_login');
  assert.equal(store.list().find((c) => c.id === saved.id).status, 'needs_login');
  const page = contexts[0].pages().at(-1);
  await page.locator('#ai-office-login-banner').waitFor({ state: 'attached' });
  // 실행기는 이어서 같은 창으로 대표의 로그인을 기다린다(새 창을 띄우지 않는다)
  const waiting = work.requestLogin({ connection: saved.id, pollMs: 50, timeoutMs: 30000 });
  await page.locator('input[type=password]').fill('fixture');
  await page.locator('button').click();
  assert.equal((await waiting).status, 'connected');
  assert.equal(contexts.length, 1, '확인한 창이 그대로 로그인 창이 된다');
  assert.equal(contexts[0].pages().length, 0, '창이 저장을 마치고 닫힌 뒤에 이어 간다(먼저 이어 가면 열린 로그인 창 때문에 다시 멈춘다)');
  assert.equal((await work.checkLogin({ connection: saved.id, target: start })).status, 'connected', '로그인한 뒤에는 로그인 창 없이 연결됨으로 확인한다');
});

test('실제 브라우저: 비밀번호 칸이 없어도 로그인 링크가 보이면 로그아웃으로 판정한다', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const shown = (html) => page.setContent(`<!doctype html><body>${html}</body>`).then(() => requiresLogin(page));
  assert.equal(await shown('<a href="https://nid.naver.com/nidlogin.login">로그인</a><p>지금 가입하고 댓글에 참여해보세요!</p>'), true);
  assert.equal(await shown('<a href="https://accounts.kakao.com/login/?continue=x">로그인</a>'), true);
  assert.equal(await shown('<a href="https://nid.naver.com/nidlogin.logout">로그아웃</a><textarea></textarea>'), false, '로그인 상태 화면');
  assert.equal(await shown('<a style="display:none" href="https://nid.naver.com/nidlogin.login">로그인</a><a href="https://nid.naver.com/nidlogin.logout">로그아웃</a>'), false, '숨겨진 로그인 링크는 보지 않는다');
  assert.equal(await shown('<input type="password">'), true);
  assert.equal(await shown('<a href="https://example.com/nidlogin.login">글 속 링크</a>'), false);
});

test('실제 브라우저: 공개 웹 조회는 쿠키 없는 임시 브라우저로 읽기만 하고, 사내 주소와 쓰기를 막는다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-public-')), root = join(temp, 'workspace'); mkdirSync(root);
  const seen = [];
  const site = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie || '' });
    if (req.url === '/to-inner') { res.writeHead(302, { location: `http://127.0.0.1:${site.address().port}/inner` }); res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url === '/inner' ? '<h1>사내 비밀</h1>' : '<title>공개</title><h1>조회수 1,234회</h1><button id="s">등록</button><a href="/to-inner">이동</a>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const base = `http://localhost:${site.address().port}`;
  const browser = { launchPersistentContext: (profile, options) => chromium.launchPersistentContext(profile, { ...options, channel: undefined, headless: true }) };
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const sessions = createBrowserSessions({ store, browser, channel: null });
  const work = createBrowserWork({ root, store, sessions });
  t.after(async () => { await work.close(); await new Promise((resolve) => site.close(resolve)); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const allowUrl = (url) => { const u = new URL(url); return u.hostname === 'localhost' && !u.pathname.startsWith('/inner'); };
  await assert.rejects(work.browsePublic({ target: 'http://192.168.0.1/', signal: new AbortController().signal, execute: async () => {} }), /공개 웹 주소/);
  await assert.rejects(work.browsePublic({ target: 'http://localhost:9/', signal: new AbortController().signal, execute: async () => {} }), /공개 웹 주소/);
  const result = await work.browsePublic({ target: `${base}/`, signal: new AbortController().signal, allowUrl, execute: async (b) => {
    assert.equal(b.publicWeb, true);
    const call = async (name, args = {}) => (await (await fetch(b.url, { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: JSON.stringify({ name, arguments: args }) })).json());
    const text = await call('browser_text');
    assert.match(text.result.text, /조회수 1,234회/);
    const shot = await call('browser_snapshot', { query: '등록' });
    const ref = shot.result.frames.flatMap((f) => f.controls).find((c) => c.label === '등록').ref;
    assert.match((await call('browser_submit', { ref })).error, /읽기 전용/);
    assert.match((await call('browser_click', { ref })).error, /읽기 전용/);
    assert.match((await call('browser_navigate', { url: `${base}/inner` })).error, /연결된 서비스/);
    // 허용 주소에서 사내 주소로 리디렉션돼도 내용을 읽을 수 없다
    const moved = await call('browser_navigate', { url: `${base}/to-inner` });
    const after = await call('browser_text');
    assert.doesNotMatch(JSON.stringify([moved, after]), /사내 비밀/);
    return 'ok';
  } });
  assert.equal(result, 'ok');
  assert.ok(seen.every((r) => !r.cookie), '쿠키를 보내지 않는다');
  assert.ok(!seen.some((r) => r.url === '/inner'), '막은 주소는 요청하지 않는다');
  assert.equal(store.list().length, 0, '연결 계정을 만들지 않는다');
});

test('실제 브라우저: 인증 화면의 보호 조치만 감지하고, 보호 상태 계정은 다시 열지 않는다', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const shown = async (url, html) => { await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><body>${html}</body>` })); await page.goto(url); const r = await accountProtected(page); await page.unrouteAll(); return r; };
  assert.equal(await shown('https://nid.naver.com/user2/help/idRelease', '<h1>회원님의 아이디를 보호조치 하였습니다</h1>'), true);
  assert.equal(await shown('https://nid.naver.com/nidlogin.login', '<h1>계정 보호모드</h1>'), true);
  assert.equal(await shown('https://nid.naver.com/nidlogin.login', '<input type="password">'), false);
  assert.equal(await shown('https://cafe.naver.com/a/1', '<p>게시글: 계정 보호조치 푸는 법</p>'), false, '글 본문에는 반응하지 않는다');
  const temp = mkdtempSync(join(tmpdir(), 'office-protect-')), root = join(temp, 'workspace'); mkdirSync(root);
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const account = store.create({ provider: 'naver', label: '' });
  store.update(account.id, { status: 'protected', manualLoginAt: 'x' });
  let launched = 0;
  const sessions = createBrowserSessions({ store, browser: { launchPersistentContext: async () => { launched++; throw new Error('열면 안 됨'); } }, channel: null });
  await assert.rejects(sessions.withSession(account.id, 'https://cafe.naver.com/a/1', new AbortController().signal, async () => {}), AccountProtected);
  assert.equal(launched, 0, '보호 상태에서는 브라우저를 띄우지 않는다');
});

test('실제 브라우저: 같은 계정의 작업은 한 창·한 탭에서 이어 가고 창이 닫혔을 때만 새로 띄운다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-reuse-')), root = join(temp, 'workspace'); mkdirSync(root);
  const site = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<h1>${req.url}</h1>`); });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const base = `http://localhost:${site.address().port}`;
  let launched = 0;
  const browser = { launchPersistentContext: async (profile, options) => { launched++; return chromium.launchPersistentContext(profile, { ...options, channel: undefined, headless: true }); } };
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const account = store.create({ provider: 'web', label: '사이트', startUrl: `${base}/`, hosts: [] });
  store.update(account.id, { status: 'connected', manualLoginAt: 'x' });
  const sessions = createBrowserSessions({ store, browser, channel: null });
  t.after(async () => { await sessions.close(); await new Promise((resolve) => site.close(resolve)); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const signal = new AbortController().signal;
  const seen = [];
  const job = (path) => sessions.withSession(account.id, `${base}${path}`, signal, async (context) => {
    seen.push({ context, tabs: context.pages().length, url: context.pages().at(-1).url() });
    return context;
  });
  const first = await job('/one');
  await first.newPage(); // 앞 작업이 탭을 더 열어 둔 경우
  const second = await job('/two');
  assert.equal(launched, 1, '창을 다시 띄우지 않는다');
  assert.equal(second, first);
  assert.equal(seen[1].tabs, 1, '탭 하나로 이어 간다');
  assert.ok(seen[1].url.endsWith('/two'));
  await first.close(); // 대표가 창을 닫음
  const third = await job('/three');
  assert.equal(launched, 2, '닫혔을 때만 새로 띄운다');
  assert.notEqual(third, first);
  // 탭만 닫혀도 같은 창에서 새 탭으로 이어 간다
  for (const page of third.pages()) await page.close();
  const fourth = await job('/four');
  assert.equal(fourth, third);
  assert.equal(launched, 2);
  assert.ok(seen.at(-1).url.endsWith('/four'));
});

test('실제 브라우저: 메일 본문은 화면이 다른 칸을 바꿔도 실패로 보지 않고, 중복 입력과 빈 본문 발송을 막는다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-mail-fill-')), root = join(temp, 'workspace'); mkdirSync(root);
  const sent = [];
  const COMPOSE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>메일 쓰기</title></head><body>
<input id="to" type="text" aria-label="받는사람"><input id="subject" type="text" aria-label="제목">
<input id="draft" type="hidden" value="0"><textarea id="note" aria-label="임시 메모" style="display:none"></textarea>
<div id="body" contenteditable="true" role="textbox" aria-label="본문 편집기" aria-multiline="true" style="min-height:100px"><p>서명: 운영팀</p></div>
<button id="send" type="button">보내기</button>
<script>
// 실제 메일 화면처럼 편집 중에 임시 저장 값이 스스로 바뀐다
document.getElementById('body').addEventListener('input',()=>{document.getElementById('draft').value=String(Date.now());});
document.getElementById('body').addEventListener('paste',(e)=>{e.preventDefault();const p=document.createElement('p');p.textContent=e.clipboardData.getData('text/plain');document.getElementById('body').prepend(p);document.getElementById('draft').value=String(Date.now());});
document.getElementById('send').onclick=async()=>{await fetch('/send',{method:'POST',body:document.getElementById('body').innerText});location.href='/done';};
</script></body></html>`;
  const site = createServer(async (req, res) => {
    if (req.url === '/send') { let b = ''; for await (const c of req) b += c; sent.push(b); res.end('ok'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url === '/done' ? '<h1>메일을 보냈습니다</h1>' : COMPOSE);
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${site.address().port}`;
  const browser = await chromium.launch();
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const account = store.create({ provider: 'naverworks', label: '메일' }); store.update(account.id, { status: 'connected' });
  const sessions = { async withSession(_id, target, _signal, action) {
    const context = await browser.newContext(); await context.newPage(); await context.pages()[0].goto(target);
    try { return await action(context); } finally { await context.close(); }
  }, close: async () => {} };
  const work = createBrowserWork({ root, store, sessions, providersForTests: (_provider, url) => new URL(url).origin === origin });
  t.after(async () => { await work.close(); await browser.close(); await new Promise((resolve) => site.close(resolve)); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const body = '안녕하세요 제휴 문의드립니다.';
  await work.deliver({ scope: 'mail-fill', allowedActions: ['mail'], instructionKey: 'k', signal: new AbortController().signal, body,
    publication: { id: 'm1', action: 'mail', service: 'naverworks_mail', connection: account.id, target: `${origin}/compose`, recipients: ['a@example.com'], subject: '제휴 문의' },
    execute: async ({ url, token }) => {
      const raw = async (name, args = {}) => (await (await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })).json());
      const call = async (name, args) => { const d = await raw(name, args); if (d.error) throw new Error(`${name}: ${d.error}`); return d.result; };
      const refs = async () => (await call('browser_snapshot')).frames.flatMap((f) => f.controls);
      const ref = async (pattern) => (await refs()).find((c) => pattern.test(c.label))?.ref;
      await call('browser_fill_content', { ref: await ref(/받는사람/), field: 'recipients' });
      await call('browser_fill_content', { ref: await ref(/^제목/), field: 'subject' });
      // 화면이 임시 저장 칸을 바꿔도 본문 입력은 성공이다
      assert.match((await call('browser_fill_content', { ref: await ref(/본문 편집기/), field: 'body' })).kept, /입력 확인됨/);
      // 다시 넣어도 중복되지 않는다
      assert.match((await call('browser_fill_content', { ref: await ref(/본문 편집기/), field: 'body' })).note, /이미 입력/);
      // 새 작성 화면에서는 입력 기록을 믿지 않는다: 보내기를 막고, 다시 넣을 수 있다
      await call('browser_navigate', { url: `${origin}/compose?new=1` });
      const emptySend = await raw('browser_submit', { ref: await ref(/보내기/) });
      assert.match(emptySend.error, /먼저 입력/, '빈 본문으로 보내지 않는다');
      await call('browser_fill_content', { ref: await ref(/받는사람/), field: 'recipients' });
      await call('browser_fill_content', { ref: await ref(/^제목/), field: 'subject' });
      assert.match((await call('browser_fill_content', { ref: await ref(/본문 편집기/), field: 'body' })).kept, /입력 확인됨/);
      await call('browser_submit', { ref: await ref(/보내기/) });
      await call('browser_finish');
      return 'done';
    } }).catch((err) => { if (!sent.length) throw err; });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].split(body).length - 1, 1, '본문은 정확히 한 번');
  assert.match(sent[0], /서명: 운영팀/);
});
