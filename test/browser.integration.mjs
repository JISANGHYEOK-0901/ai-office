import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBrowserSessions, requiresLogin } from '../lib/browser-session.mjs';
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
test('실제 Playwright 브라우저: 카페 글쓰기 제목·게시판 선택·영상 링크 카드', async () => { await verifyCafeEditor(); });
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
