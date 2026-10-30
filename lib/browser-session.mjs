import { chromium } from 'playwright';
import { allowedServiceUrl, CONNECTION_PROVIDERS } from './connections.mjs';
import { readPrivate, writePrivate } from './private-state.mjs';

export class ConnectionRequired extends Error {
  constructor(message = '계정 연결 화면에서 로그인 상태를 확인해 주세요.') { super(message); this.code = 'CONNECTION_REQUIRED'; }
}
export function loginPage(url) {
  try { const u = new URL(url); return /^(nid\.naver\.com|accounts\.kakao\.com|auth\.)/.test(u.hostname) || /\/(?:login|signin|authorize|oauth|captcha|challenge|nidlogin)(?:[/.?]|$)/i.test(u.pathname); }
  catch { return true; }
}
export function credentialLoginUrl(provider, value) {
  const hosts = { naver: ['nid.naver.com'], kakao: ['accounts.kakao.com'],
    naverworks: ['auth.worksmobile.com', 'login.worksmobile.com', 'auth.naverworks.com', 'login.naverworks.com'] };
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && hosts[provider]?.includes(url.hostname);
  } catch { return false; }
}
export async function requiresLogin(page) {
  if (loginPage(page.url())) return true;
  for (const frame of page.frames()) {
    if (await frame.locator('input[type="password"]:visible').count()) return true;
  }
  return false;
}

// 자격 증명은 매 단계 공식 인증 호스트를 확인한 뒤 입력한다. 오류에 입력값을 싣지 않는다.
export async function automaticLogin({ page, provider, credentials }) {
  if (!credentials || !credentialLoginUrl(provider, page.url())) return false;
  try {
    await page.locator('input#user_id,input[type="email"],input[type="password"],input[name="id"],input#id_login').first()
      .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const username = page.locator('input[type="email"]:visible,input[name="id"]:visible,input[name="username"]:visible,input[name="loginId"]:visible,input[name="account"]:visible,input#id_login:visible,input#id:visible,input#user_id:visible').first();
    const password = () => page.locator('input[type="password"]:visible').first();
    if (await username.count()) await username.fill(credentials.username);
    else if (!await password().count()) return false;
    if (!await password().count()) {
      const next = page.getByRole('button', { name: /^(다음|계속|Next|Continue|로그인|Log\s*in|Sign\s*in)$/i }).first();
      if (!await next.count()) return false;
      await next.click();
      for (let i = 0; i < 80; i++) {
        if (!credentialLoginUrl(provider, page.url())) return allowedServiceUrl(provider, page.url()) && !await requiresLogin(page);
        if (await password().count()) break;
        await page.waitForTimeout(100);
      }
    }
    if (!credentialLoginUrl(provider, page.url()) || !await password().count()) return false;
    // CAPTCHA·추가 인증은 자동으로 제출하거나 해결하지 않는다.
    if (await page.locator('input[name*="captcha" i]:visible,input[name*="otp" i]:visible,input[autocomplete="one-time-code"]:visible').count()) return false;
    await password().fill(credentials.password);
    const submit = page.getByRole('button', { name: /^(로그인|Log\s*in|Sign\s*in|로그인하기)$/i }).first();
    if (await submit.count()) await submit.click();
    else await password().press('Enter');
    for (let i = 0; i < 100; i++) {
      if (!await requiresLogin(page)) return allowedServiceUrl(provider, page.url());
      await page.waitForTimeout(100);
    }
    return false;
  } catch { return false; }
}

export function createBrowserSessions({ store, browser = chromium, channel = process.env.AI_OFFICE_BROWSER_CHANNEL || 'chrome', workHeadless = false } = {}) {
  const interactive = new Map(), tails = new Map(), contexts = new Set();
  const launch = async (id, headless) => {
    const options = { headless, viewport: { width: 1440, height: 1000 }, acceptDownloads: false,
      args: ['--disable-save-password-bubble'], ...(channel ? { channel } : {}) };
    let context;
    try { context = await browser.launchPersistentContext(store.profile(id), options); }
    catch (error) {
      if (!channel || /SingletonLock|already in use|ProcessSingleton/i.test(error.message)) throw new Error('계정 브라우저가 사용 중입니다. 기존 연결 창을 닫고 다시 시도해 주세요.');
      try { context = await browser.launchPersistentContext(store.profile(id), { ...options, channel: undefined }); }
      catch { throw new Error('브라우저를 시작하지 못했습니다. Chrome 또는 Playwright 브라우저 설치 상태를 확인해 주세요.'); }
    }
    contexts.add(context); context.on('close', () => contexts.delete(context));
    try {
      // 브라우저 종료 때 사라지는 session cookie도 복원한다. 프로필의 더 최신 쿠키를 덮지 않는다.
      const saved = readPrivate(store.authFile(id), null);
      if (saved) {
        const current = await context.cookies();
        const missing = (saved.cookies || []).filter((c) => !current.some((p) => p.name === c.name && p.domain === c.domain && p.path === c.path));
        if (missing.length) await context.addCookies(missing);
        await context.addInitScript((origins) => {
          for (const origin of origins) if (location.origin === origin.origin) for (const item of origin.localStorage || []) if (localStorage.getItem(item.name) === null) localStorage.setItem(item.name, item.value);
        }, saved.origins || []);
      }
    } catch { await context.close(); throw new ConnectionRequired('저장된 로그인 상태를 다시 연결해 주세요.'); }
    return context;
  };
  const saveAuth = async (id, context) => writePrivate(store.authFile(id), await context.storageState({ indexedDB: true }));
  const pageOf = (context) => context.pages().at(-1);
  const autoLogin = async (id, page) => {
    // 사용자 작성 블로그/카페 문서의 가짜 로그인 폼에 계정 암호를 입력하지 않는다.
    if (!credentialLoginUrl(store.find(id).provider, page.url())) return false;
    return automaticLogin({ page, provider: store.find(id).provider, credentials: store.credentials(id) });
  };
  const ensureReady = async (id, context, url) => {
    const connection = store.find(id);
    if (!allowedServiceUrl(connection.provider, url)) throw new Error('연결 서비스 안의 주소만 열 수 있습니다.');
    const page = pageOf(context) || await context.newPage();
    // 이미 인증 화면으로 이동했으면 이를 먼저 마친다. 서비스 첫 화면으로 되돌려
    // 늦은 SSO 이동을 반복시키지 않는다.
    if (credentialLoginUrl(connection.provider, page.url()) && await requiresLogin(page) && !await autoLogin(id, page)) {
      store.update(id, { status: 'needs_login' }); throw new ConnectionRequired('추가 인증이 필요합니다. 열린 직원 브라우저에서 로그인 상태를 확인해 주세요.');
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (await requiresLogin(page)) {
      if (!await autoLogin(id, page)) { store.update(id, { status: 'needs_login' }); throw new ConnectionRequired('로그인이 만료됐거나 추가 인증이 필요합니다. 계정 연결 화면에서 재연결하면 업무를 이어갑니다.'); }
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
    if (await requiresLogin(page)) { store.update(id, { status: 'needs_login' }); throw new ConnectionRequired(); }
    store.update(id, { status: 'connected' });
    return page;
  };
  return {
    ready: ensureReady,
    async open(id) {
      const connection = store.find(id);
      if (tails.has(id)) throw new Error('이 계정으로 업무가 진행 중입니다. 잠시 후 연결해 주세요.');
      let context = interactive.get(id);
      if (!context) {
        context = await launch(id, false); interactive.set(id, context);
        context.on('close', () => { interactive.delete(id); if (store.list().some((c) => c.id === id && c.status === 'connecting')) store.update(id, { status: 'disconnected' }); });
        const page = pageOf(context) || await context.newPage();
        await page.goto(CONNECTION_PROVIDERS[connection.provider].loginUrl, { waitUntil: 'domcontentloaded' });
        await autoLogin(id, page);
      }
      await pageOf(context)?.bringToFront();
      return store.update(id, { status: 'connecting' });
    },
    async confirm(id) {
      const context = interactive.get(id);
      if (!context) throw new ConnectionRequired('먼저 로그인 창을 열어 주세요.');
      const page = pageOf(context);
      if (!allowedServiceUrl(store.find(id).provider, page.url()) || await requiresLogin(page)) throw new ConnectionRequired('로그인·추가 인증을 마친 뒤 연결 완료를 눌러 주세요.');
      store.update(id, { status: 'connected' });
      await saveAuth(id, context);
      interactive.delete(id); await context.close();
      return store.list().find((c) => c.id === id);
    },
    async disconnect(id) {
      if (tails.has(id)) throw new Error('진행 중인 계정 업무를 중지한 뒤 연결을 삭제해 주세요.');
      const context = interactive.get(id); interactive.delete(id); await context?.close(); store.remove(id);
    },
    async withSession(id, url, signal, action) {
      if (interactive.has(id)) throw new ConnectionRequired('열려 있는 로그인 창에서 연결 완료를 눌러 주세요.');
      const connection = store.find(id);
      if (!['connected', 'needs_login'].includes(connection.status) && !(connection.status === 'disconnected' && connection.credentials)) throw new ConnectionRequired();
      const previous = tails.get(id) || Promise.resolve();
      const work = previous.catch(() => {}).then(async () => {
        signal.throwIfAborted();
        const context = await launch(id, workHeadless);
        const stop = () => context.close().catch(() => {});
        signal.addEventListener('abort', stop, { once: true });
        let retained = false;
        try { await ensureReady(id, context, url); await pageOf(context)?.bringToFront(); return await action(context); }
        catch (error) {
          if ((error instanceof ConnectionRequired || store.find(id).status === 'needs_login') && !workHeadless && !signal.aborted) {
            retained = true; interactive.set(id, context);
            context.on('close', () => { if (interactive.get(id) === context) interactive.delete(id); });
            await pageOf(context)?.bringToFront().catch(() => {});
          }
          throw error;
        }
        finally {
          signal.removeEventListener('abort', stop);
          if (store.find(id).status === 'connected') await saveAuth(id, context).catch(() => {});
          if (!retained) await context.close();
        }
      });
      const tail = work.catch(() => {}); tails.set(id, tail);
      tail.finally(() => { if (tails.get(id) === tail) tails.delete(id); });
      let stop;
      try {
        return await Promise.race([work, new Promise((_, reject) => { stop = () => reject(signal.reason || new Error('중지됨')); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); })]);
      } finally { signal.removeEventListener('abort', stop); }
    },
    async close() { for (const context of contexts) await context.close().catch(() => {}); interactive.clear(); },
  };
}
