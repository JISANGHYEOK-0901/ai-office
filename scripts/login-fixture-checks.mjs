// 공식 URL을 로컬 응답으로 가로채며 실제 계정·서비스에는 접속하지 않는다.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { automaticLogin, createBrowserSessions } from '../lib/browser-session.mjs';
import { createConnectionStore } from '../lib/connections.mjs';

export async function verifyLogin() {
  const temp = mkdtempSync(join(tmpdir(), 'office-login-'));
  const root = join(temp, 'workspace'); mkdirSync(root);
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const connection = store.create({ provider: 'naverworks', label: '가상 계정' });
  const credentials = { username: 'fixture@example.invalid', password: 'fixture-only-password' };
  store.saveCredentials(connection.id, credentials);
  const options = [];
  let authenticated = false, passwordSubmissions = 0, challenge = false;
  const contexts = [];
  const browser = { async launchPersistentContext(profile, requested) {
    options.push(requested);
    // 재사용 프로필의 시작 탭은 route 설치 전에 실제 URL을 열 수 있으므로 테스트 브라우저는 매번 새 프로필을 쓴다.
    const context = await chromium.launchPersistentContext(join(temp, `browser-${options.length}`), { ...requested, channel: undefined, headless: true });
    contexts.push(context);
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/complete') { authenticated = true; passwordSubmissions++; await route.fulfill({ contentType: 'text/html', body: '<script>location.href="https://mail.worksmobile.com/inbox"</script>' }); return; }
      if (url.hostname === 'mail.worksmobile.com') {
        await route.fulfill(authenticated ? { contentType: 'text/html; charset=utf-8', body: '<h1>Inbox</h1>' }
          : { status: 403, body: 'Fixture requires login' }); return;
      }
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: challenge
        ? '<input id="user_id"><input type="password"><input autocomplete="one-time-code"><button>로그인</button>' : url.pathname === '/login/login'
        ? '<input id="user_id"><button onclick="if(document.getElementById(\'user_id\').value)location.href=\'/login/password\'">Login</button>'
        : '<input type="password"><button onclick="if(document.querySelector(\'input\').value)location.href=\'/complete\'">Login</button>' });
    });
    // HTTP redirect 뒤의 요청이 mock을 벗어나지 않도록 테스트 전송 계층에서 인증 URL로 보낸다.
    const prepare = (page) => {
      const goto = page.goto.bind(page);
      page.goto = (url, options) => goto(!authenticated && new URL(url).hostname === 'mail.worksmobile.com'
        ? 'https://auth.worksmobile.com/login/login' : url, options);
    };
    context.pages().forEach(prepare); context.on('page', prepare);
    return context;
  } };
  const sessions = createBrowserSessions({ store, browser, channel: null });
  let standalone;
  try {
    assert.equal(store.list()[0].status, 'disconnected');
    await sessions.withSession(connection.id, 'https://mail.worksmobile.com/', new AbortController().signal, async (context) => {
      assert.equal(new URL(context.pages().at(-1).url()).hostname, 'mail.worksmobile.com');
      assert.equal(await context.pages().at(-1).locator('h1').innerText(), 'Inbox');
    });
    assert.equal(store.list()[0].status, 'connected');
    assert.equal(passwordSubmissions, 1);
    assert.equal(options[0].headless, false, '직원 업무 창은 기본 표시');
    await sessions.withSession(connection.id, 'https://mail.worksmobile.com/', new AbortController().signal, async (context) => {
      authenticated = false;
      await context.pages().at(-1).goto('https://auth.worksmobile.com/login/login');
      await sessions.ready(connection.id, context, 'https://mail.worksmobile.com/');
      assert.equal(await context.pages().at(-1).locator('h1').innerText(), 'Inbox');
    });
    assert.equal(passwordSubmissions, 2, '업무 도중 늦은 인증 이동도 저장된 계정으로 처리');
    authenticated = false; challenge = true;
    await assert.rejects(sessions.withSession(connection.id, 'https://mail.worksmobile.com/', new AbortController().signal, async () => {
      throw new Error('추가 인증 전 업무를 실행하면 안 됩니다.');
    }), { code: 'CONNECTION_REQUIRED' });
    const pending = contexts.at(-1);
    assert.ok(pending.pages().length, '추가 인증을 사용자가 마치도록 창을 유지한다');
    const challengePage = pending.pages().find((page) => page.url().startsWith('https://auth.worksmobile.com/'));
    assert.ok(challengePage, JSON.stringify(pending.pages().map((page) => page.url())));
    assert.equal(await challengePage.locator('input[type=password]').count(), 1);
    assert.equal(await challengePage.locator('input[type=password]').inputValue(), '');
    await assert.rejects(sessions.confirm(connection.id), { code: 'CONNECTION_REQUIRED' });
    authenticated = true; challenge = false;
    await challengePage.goto('https://mail.worksmobile.com/inbox');
    await sessions.confirm(connection.id);
    assert.equal(store.list()[0].status, 'connected');
    standalone = await chromium.launch();
    const page = await standalone.newPage();
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<input id="user_id"><input type="password"><button>로그인</button>' }));
    await page.goto('https://mail.worksmobile.com/fake-login');
    assert.equal(await automaticLogin({ page, provider: 'naverworks', credentials }), false);
    assert.equal(await page.locator('input[type=password]').inputValue(), '', '일반 서비스 문서에는 암호를 입력하지 않는다');
    await page.goto('https://auth.worksmobile.com.evil.invalid/login');
    assert.equal(await automaticLogin({ page, provider: 'naverworks', credentials }), false);
    assert.equal(await page.locator('input#user_id').inputValue(), '');
    return [{ name: '저장된 미연결 계정의 직원 첫 로그인·단계형 인증·보이는 창', interaction: 'click', passed: true },
      { name: '첫 업무 화면 이후 인증 이동도 같은 직원 브라우저에서 재로그인', interaction: 'click', passed: true },
      { name: '추가 인증을 자동 제출하지 않고 직원 창 유지·연결 완료로 재개', interaction: 'click', passed: true },
      { name: '서비스 문서·유사 인증 호스트에는 자격 증명 입력 차단', interaction: 'click', passed: true }];
  } finally {
    await standalone?.close(); await sessions.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
