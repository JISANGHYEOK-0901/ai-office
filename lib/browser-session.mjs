import { chromium } from 'playwright';
import { CUSTOM_PROVIDER, connectionAllowsUrl, connectionLoginUrl, firstLoginDone } from './connections.mjs';
import { readPrivate, writePrivate } from './private-state.mjs';
import { lookup } from 'node:dns/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivateAddress, isPublicWebUrl } from './source-check.mjs';

// 실행기가 대표의 로그인을 기다리는 시간. 지시하고 자리를 비워도 돌아와 로그인하면 답장 없이 이어 가도록 넉넉히 둔다
export const LOGIN_WAIT_MS = 30 * 60 * 1000;

export class ConnectionRequired extends Error {
  constructor(message = '계정 연결 화면에서 로그인 상태를 확인해 주세요.') { super(message); this.code = 'CONNECTION_REQUIRED'; }
}
// 사이트가 계정을 보호 조치한 경우: 자동 재시도는 상황을 악화시키므로 대표가 직접 풀 때까지 멈춘다
export class AccountProtected extends ConnectionRequired {
  constructor() { super('네이버 등 서비스가 계정 보호 조치를 건 것으로 보입니다. 자동 작업을 멈췄습니다. 서비스 공식 화면에서 직접 해제한 뒤 계정 연결에서 다시 로그인해 주세요. 해제 전에는 다시 시도하지 않습니다.'); this.protected = true; }
}
const PROTECTION_TEXT = /보호\s*조치|보호\s*모드|이용이\s*제한|비정상적인\s*(?:활동|접근|로그인)|부정\s*이용/;
// 글 본문의 같은 낱말에 반응하지 않도록 인증 화면에서만 본다
export async function accountProtected(page) {
  if (!loginPage(page.url())) return false;
  return PROTECTION_TEXT.test(await page.locator('body').innerText({ timeout: 2000 }).catch(() => ''));
}
export function loginPage(url) {
  try { const u = new URL(url); return /^(nid\.naver\.com|accounts\.kakao\.com|auth\.)/.test(u.hostname) || /\/(?:login|signin|authorize|oauth|captcha|challenge|nidlogin)(?:[/.?]|$)/i.test(u.pathname); }
  catch { return true; }
}
// connection: 연결 기록 또는 서비스 이름(예전 호출 호환). 일반 웹사이트는 연결에 저장한 도메인의 로그인 화면에만 입력한다.
const asConnection = (connection) => typeof connection === 'string' ? { provider: connection } : connection;
export function credentialLoginUrl(connection, value) {
  connection = asConnection(connection);
  if (connection?.provider === CUSTOM_PROVIDER) return connectionAllowsUrl(connection, value);
  const provider = connection?.provider;
  const hosts = { naver: ['nid.naver.com'], kakao: ['accounts.kakao.com'],
    naverworks: ['auth.worksmobile.com', 'login.worksmobile.com', 'auth.naverworks.com', 'login.naverworks.com'] };
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && hosts[provider]?.includes(url.hostname);
  } catch { return false; }
}
// 로그아웃된 네이버·카카오 화면은 비밀번호 칸 없이 로그인 링크만 보여 준다(실측: 로그인하면 이 링크가 사라진다)
const LOGGED_OUT_LINKS = 'a[href*="nid.naver.com/nidlogin.login"]:visible, a[href*="accounts.kakao.com/login"]:visible';
export async function requiresLogin(page) {
  if (loginPage(page.url())) return true;
  for (const frame of page.frames()) {
    if (await frame.locator('input[type="password"]:visible').count()) return true;
    if (await frame.locator(LOGGED_OUT_LINKS).count()) return true;
  }
  return false;
}

// 자격 증명은 매 단계 공식 인증 호스트를 확인한 뒤 입력한다. 오류에 입력값을 싣지 않는다.
export async function automaticLogin({ page, provider, connection = provider, credentials }) {
  connection = asConnection(connection);
  if (!credentials || !credentialLoginUrl(connection, page.url())) return false;
  try {
    // 화면 프레임워크(React 등)가 준비되기 전에 입력하면 준비 과정에서 값이 지워진 채 빈 칸으로 제출된다.
    // 로드를 기다리고, 입력값이 실제로 남았는지 확인한 뒤에만 제출한다.
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.locator('input#user_id,input[type="email"],input[type="password"],input[name="id"],input#id_login').first()
      .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const username = page.locator('input[type="email"]:visible,input[name="id"]:visible,input[name="username"]:visible,input[name="loginId"]:visible,input[name="account"]:visible,input#id_login:visible,input#id:visible,input#user_id:visible').first();
    const password = () => page.locator('input[type="password"]:visible').first();
    const kept = async (locator, value) => {
      for (let i = 0; i < 3; i++) {
        await locator.fill(value);
        await page.waitForTimeout(300);
        if (await locator.inputValue().catch(() => '') === value) return true;
      }
      return false;
    };
    if (await username.count()) { if (!await kept(username, credentials.username)) return false; }
    else if (!await password().count()) return false;
    if (!await password().count()) {
      const next = page.getByRole('button', { name: /^(다음|계속|Next|Continue|로그인|Log\s*in|Sign\s*in)$/i }).first();
      if (!await next.count()) return false;
      await next.click();
      for (let i = 0; i < 80; i++) {
        if (!credentialLoginUrl(connection, page.url())) return connectionAllowsUrl(connection, page.url()) && !await requiresLogin(page);
        if (await password().count()) break;
        await page.waitForTimeout(100);
      }
    }
    if (!credentialLoginUrl(connection, page.url()) || !await password().count()) return false;
    // CAPTCHA·추가 인증은 자동으로 제출하거나 해결하지 않는다.
    if (await page.locator('input[name*="captcha" i]:visible,input[name*="otp" i]:visible,input[autocomplete="one-time-code"]:visible').count()) return false;
    if (!await kept(password(), credentials.password)) return false;
    // 입력 직후 다시 그려져 값이 사라졌으면 제출하지 않는다(빈 칸 로그인 시도 방지)
    if (await username.count() && await username.inputValue().catch(() => '') !== credentials.username && !await kept(username, credentials.username)) return false;
    if (await password().inputValue().catch(() => '') !== credentials.password) return false;
    const submit = page.getByRole('button', { name: /^(로그인|Log\s*in|Sign\s*in|로그인하기)$/i }).first();
    if (await submit.count()) await submit.click();
    else await password().press('Enter');
    for (let i = 0; i < 100; i++) {
      if (!await requiresLogin(page)) return connectionAllowsUrl(connection, page.url());
      await page.waitForTimeout(100);
    }
    return false;
  } catch { return false; }
}

export function createBrowserSessions({ store, browser = chromium, channel = process.env.AI_OFFICE_BROWSER_CHANNEL || 'chrome', workHeadless = false } = {}) {
  const interactive = new Map(), interactiveContexts = new Map(), tails = new Map(), contexts = new Set();
  // 업무 창: 같은 계정의 다음 작업이 다시 쓴다. 대표가 닫았을 때만 새로 띄운다
  const workWindows = new Map();
  const workWindow = async (id) => {
    const open = workWindows.get(id);
    if (open && contexts.has(open)) return open;
    const context = await launch(id, workHeadless);
    workWindows.set(id, context);
    context.on('close', () => { if (workWindows.get(id) === context) workWindows.delete(id); });
    return context;
  };
  // 재사용 전에 앞 작업이 연 탭을 닫아 탭 하나로 이어 간다
  const keepOneTab = async (context) => {
    for (const page of context.pages().slice(0, -1)) await page.close().catch(() => {});
  };
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
    const connection = store.find(id);
    // 첫 로그인은 대표가 직접 한다(사이트 보호 조치 방지). 그 전에는 저장 정보를 입력하지 않는다
    if (!firstLoginDone(connection)) return false;
    if (!credentialLoginUrl(connection, page.url())) return false;
    return automaticLogin({ page, connection, credentials: store.credentials(id) });
  };
  const ensureReady = async (id, context, url) => {
    const connection = store.find(id);
    if (!connectionAllowsUrl(connection, url)) throw new Error('연결 서비스 안의 주소만 열 수 있습니다.');
    const page = pageOf(context) || await context.newPage();
    // 이미 인증 화면으로 이동했으면 이를 먼저 마친다. 서비스 첫 화면으로 되돌려
    // 늦은 SSO 이동을 반복시키지 않는다.
    if (credentialLoginUrl(connection, page.url()) && await requiresLogin(page) && !await autoLogin(id, page)) {
      store.update(id, { status: 'needs_login' }); throw new ConnectionRequired('추가 인증이 필요합니다. 열린 직원 브라우저에서 로그인 상태를 확인해 주세요.');
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (await accountProtected(page)) { store.update(id, { status: 'protected' }); throw new AccountProtected(); }
    if (await requiresLogin(page)) {
      if (!await autoLogin(id, page)) { store.update(id, { status: 'needs_login' }); throw new ConnectionRequired('로그인이 만료됐거나 추가 인증이 필요합니다. 계정 연결 화면에서 재연결하면 업무를 이어갑니다.'); }
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
    if (await requiresLogin(page)) { store.update(id, { status: 'needs_login' }); throw new ConnectionRequired(); }
    store.update(id, { status: 'connected' });
    return page;
  };
  // 대표가 직접 로그인하는 창: 안내를 띄우고, 로그인이 끝난 화면을 두 번 연속 확인하면 저장하고 닫는다
  const BANNER = 'AI Office: 직접 로그인해 주세요. 로그인을 마치면 이 창은 자동으로 닫힙니다. 창을 직접 닫지 마세요.';
  const showBanner = (context) => context.addInitScript((text) => {
    const add = () => { if (document.getElementById('ai-office-login-banner')) return; const bar = document.createElement('div'); bar.id = 'ai-office-login-banner'; bar.textContent = text;
      bar.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 14px;background:#0b5;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none');
      document.documentElement.appendChild(bar); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  }, BANNER).catch(() => {});
  const confirmContext = async (id, context) => {
    const page = pageOf(context);
    if (!page || !connectionAllowsUrl(store.find(id), page.url()) || await requiresLogin(page)) throw new ConnectionRequired('로그인·추가 인증을 마친 뒤 연결 완료를 눌러 주세요.');
    store.update(id, { status: 'connected', manualLoginAt: store.find(id).manualLoginAt || new Date().toISOString() });
    await saveAuth(id, context);
    if (interactive.get(id) === context) interactive.delete(id);
    await context.close();
    return store.list().find((c) => c.id === id);
  };
  // 실행기가 로그인을 기다리는 시간보다 조금 더 지켜봐 마지막 순간의 로그인도 저장한다
  const watchLogin = (id, context, { intervalMs = 1500, timeoutMs = LOGIN_WAIT_MS + 5 * 60 * 1000 } = {}) => {
    let streak = 0, busy = false;
    const stop = () => { clearInterval(timer); clearTimeout(limit); };
    const timer = setInterval(async () => {
      if (busy) return;
      if (interactive.get(id) !== context) { stop(); return; }
      busy = true;
      try {
        const page = pageOf(context);
        const done = page && connectionAllowsUrl(store.find(id), page.url()) && !await requiresLogin(page);
        streak = done ? streak + 1 : 0;
        if (streak >= 2) { stop(); await confirmContext(id, context).catch(() => {}); }
      } catch { streak = 0; } finally { busy = false; }
    }, intervalMs);
    const limit = setTimeout(stop, timeoutMs);
    timer.unref?.(); limit.unref?.();
    context.on('close', stop);
  };
  return {
    ready: ensureReady,
    async open(id) {
      const connection = store.find(id);
      if (tails.has(id)) throw new Error('이 계정으로 업무가 진행 중입니다. 잠시 후 연결해 주세요.');
      let context = interactive.get(id);
      if (!context) {
        // 같은 프로필을 쓰므로 열어 둔 업무 창을 닫고 로그인 창을 띄운다
        await workWindows.get(id)?.close().catch(() => {});
        context = await launch(id, false); interactive.set(id, context); interactiveContexts.set(id, context);
        context.on('close', () => { interactive.delete(id); if (store.list().some((c) => c.id === id && c.status === 'connecting')) store.update(id, { status: 'disconnected' }); });
        await showBanner(context);
        const page = pageOf(context) || await context.newPage();
        await page.goto(connectionLoginUrl(connection), { waitUntil: 'domcontentloaded' });
        watchLogin(id, context);
      }
      await pageOf(context)?.bringToFront();
      return store.update(id, { status: 'connecting' });
    },
    async confirm(id) {
      const context = interactive.get(id);
      if (!context) throw new ConnectionRequired('먼저 로그인 창을 열어 주세요.');
      return confirmContext(id, context);
    },
    watchLogin,
    // 로그인 창의 브라우저가 프로필을 잡고 있는지(닫히기 전에 같은 프로필을 열면 실패한다)
    loginOpen: (id) => [...contexts].some((context) => context === interactiveContexts.get(id)),
    async disconnect(id) {
      if (tails.has(id)) throw new Error('진행 중인 계정 업무를 중지한 뒤 연결을 삭제해 주세요.');
      const context = interactive.get(id); interactive.delete(id); await context?.close(); await workWindows.get(id)?.close().catch(() => {}); store.remove(id);
    },
    async withSession(id, url, signal, action) {
      if (interactive.has(id)) throw new ConnectionRequired('열려 있는 로그인 창에서 연결 완료를 눌러 주세요.');
      const connection = store.find(id);
      if (connection.status === 'protected') throw new AccountProtected();
      // 직접 로그인한 적이 있고 다시 로그인할 정보가 있으면(로그인 창을 닫아 '연결 안 됨'이 된 경우 포함) 진행한다. 업무 시작 전 확인과 같은 기준
      const relogin = firstLoginDone(connection) && Boolean(connection.credentials || connection.source === 'file');
      if (!['connected', 'needs_login'].includes(connection.status) && !relogin) throw new ConnectionRequired('처음 한 번은 계정 연결에서 로그인 창을 열어 직접 로그인해 주세요. 그 뒤부터는 AI가 저장된 로그인 상태로 진행합니다.');
      const previous = tails.get(id) || Promise.resolve();
      const work = previous.catch(() => {}).then(async () => {
        signal.throwIfAborted();
        const context = await workWindow(id);
        await keepOneTab(context);
        const stop = () => context.close().catch(() => {});
        signal.addEventListener('abort', stop, { once: true });
        try { await ensureReady(id, context, url); await pageOf(context)?.bringToFront(); return await action(context); }
        catch (error) {
          if ((error instanceof ConnectionRequired || store.find(id).status === 'needs_login') && !workHeadless && !signal.aborted) {
            // 로그인 창으로 등록해야 실행기가 저장·닫힘이 끝날 때까지 기다린다(먼저 이어 가면 '열려 있는 로그인 창' 오류·프로필 잠금으로 다시 멈춘다)
            workWindows.delete(id); interactive.set(id, context); interactiveContexts.set(id, context);
            context.on('close', () => { if (interactive.get(id) === context) interactive.delete(id); });
            // 넘겨받은 직원 창에서도 안내를 띄우고 로그인을 마치면 자동으로 저장한다
            await showBanner(context); await pageOf(context)?.reload().catch(() => {}); watchLogin(id, context);
            await pageOf(context)?.bringToFront().catch(() => {});
          }
          throw error;
        }
        finally {
          signal.removeEventListener('abort', stop);
          if (store.find(id).status === 'connected') await saveAuth(id, context).catch(() => {});
        }
      });
      const tail = work.catch(() => {}); tails.set(id, tail);
      tail.finally(() => { if (tails.get(id) === tail) tails.delete(id); });
      let stop;
      try {
        return await Promise.race([work, new Promise((_, reject) => { stop = () => reject(signal.reason || new Error('중지됨')); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); })]);
      } finally { signal.removeEventListener('abort', stop); }
    },
    // 공개 웹 조회: 계정·쿠키가 없는 임시 프로필로 띄운다. 사내망 주소는 요청 단계에서 막고 끝나면 프로필을 지운다
    async withPublic(url, signal, action, { allowUrl = isPublicWebUrl, resolve = lookup } = {}) {
      const profile = mkdtempSync(join(tmpdir(), 'ai-office-public-'));
      const dns = new Map();
      const hostAllowed = (host) => {
        if (!dns.has(host)) dns.set(host, resolve(host, { all: true }).then((list) => !list.some((a) => isPrivateAddress(a.address))).catch(() => true));
        return dns.get(host);
      };
      const redirectsAllowed = async (start) => {
        let current = start;
        for (let hop = 0; hop < 5; hop++) {
          const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(5000) }).catch(() => null);
          await response?.body?.cancel?.().catch(() => {});
          const location = response && response.status >= 300 && response.status < 400 && response.headers.get('location');
          if (!location) return true;
          current = new URL(location, current).href;
          if (!allowUrl(current) || allowUrl === isPublicWebUrl && !await hostAllowed(new URL(current).hostname)) return false;
        }
        return true;
      };
      let context;
      try {
        const options = { headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: false };
        try { context = await browser.launchPersistentContext(profile, { ...options, ...(channel ? { channel } : {}) }); }
        catch { context = await browser.launchPersistentContext(profile, options); }
        contexts.add(context); context.on('close', () => contexts.delete(context));
        const stop = () => context.close().catch(() => {});
        signal.addEventListener('abort', stop, { once: true });
        await context.route('**/*', async (route) => {
          const target = route.request().url();
          if (target.startsWith('data:') || target.startsWith('blob:') || target === 'about:blank') return route.continue();
          if (!allowUrl(target)) return route.abort('blockedbyclient');
          if (allowUrl === isPublicWebUrl && !await hostAllowed(new URL(target).hostname)) return route.abort('blockedbyclient');
          // route는 리디렉션 요청을 다시 부르지 않는다. 화면 이동은 경로를 먼저 따라가 사내 주소로 가면 막는다
          if (route.request().isNavigationRequest() && !await redirectsAllowed(target)) return route.abort('blockedbyclient');
          return route.continue();
        });
        try {
          const page = context.pages()[0] || await context.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          signal.throwIfAborted();
          return await action(context);
        } finally { signal.removeEventListener('abort', stop); }
      } finally {
        await context?.close().catch(() => {});
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    async close() { for (const context of contexts) await context.close().catch(() => {}); interactive.clear(); },
  };
}
