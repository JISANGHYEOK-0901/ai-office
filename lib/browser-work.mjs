// 사용자 지시·검토한 원문에 묶인 브라우저 작업. 로그인 값/쿠키/임의 JS 실행은 도구에 노출하지 않는다.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';
import { allowedServiceUrl, serviceProvider } from './connections.mjs';
import { ConnectionRequired, requiresLogin } from './browser-session.mjs';
import { createVideoHistory, youtubeVideoIds } from './video-history.mjs';

class BrowserActionError extends Error { constructor(message) { super(message); this.code = 'BROWSER_ACTION'; } }
const ELEMENTS = 'a,button,label,input:not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"],[role="option"],[role="menuitem"],[role="tab"],[tabindex],[onclick]';
const FINAL = /보내기|발송|발행|게시|등록|작성\s*완료|^(?:send|publish|submit|post)$/i;
const FORBIDDEN = /삭제|탈퇴|로그아웃|결제|송금|이체|비밀번호|delete|remove account|log\s*out|purchase|payment/i;
const normalized = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '');
const hash = (s) => createHash('sha256').update(s).digest('hex');

// 발송 알림이 사라져도 실제 보낸 메일 상세의 계정·수신자·제목·원문을 대조한다.
export function sentMailReceipt({ attempted, url, text, subject, body, recipients, sender }) {
  if (!attempted || !sender || !body?.trim() || !recipients?.length) return null;
  let location;
  try { location = new URL(url); } catch { return null; }
  const messageId = location.searchParams.get('nMailId');
  if (!allowedServiceUrl('naverworks', url) || !/^\/read\/popup\/?$/.test(location.pathname) || !/^\d{1,30}$/.test(messageId || '')) return null;
  const content = normalized(text), expected = normalized(body), bodyAt = content.indexOf(expected);
  if (bodyAt < 0 || !content.includes(normalized(subject))) return null;
  const headers = content.slice(0, bodyAt).toLowerCase();
  const addresses = [...new Set(headers.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g) || [])];
  const wanted = [...new Set([sender, ...recipients].map((address) => address.toLowerCase()))];
  if (addresses.length !== wanted.length || !wanted.every((address) => addresses.includes(address))) return null;
  return { messageId, recipientCount: recipients.length, bodyHash: hash(expected), source: 'sent-message-detail' };
}
export const BROWSER_TOOLS = [
  ['browser_snapshot', '현재 서비스 화면·프레임과 조작 ref(r숫자)를 읽습니다. query의 여러 단어는 각각 검색합니다. 빈 query는 전체 목록입니다. 항목 이름을 ref로 쓰지 마세요.', { query: { type: 'string' } }],
  ['browser_navigate', '연결된 서비스의 주소로 이동합니다.', { url: { type: 'string' } }],
  ['browser_click', '화면 ref를 클릭합니다. 최종 발송·등록은 browser_submit을 사용합니다.', { ref: { type: 'string' } }],
  ['browser_fill_content', '검토된 원문의 제목·본문·수신자만 입력합니다.', { ref: { type: 'string' }, field: { type: 'string', enum: ['subject', 'body', 'recipients'] } }],
  ['browser_search', '검색 입력칸에 검색어를 입력합니다.', { ref: { type: 'string' }, query: { type: 'string' } }],
  ['browser_press_key', 'Tab·방향키·Escape 등 화면 조작 키를 누릅니다.', { key: { type: 'string' } }],
  ['browser_select', '선택 상자의 항목을 고릅니다.', { ref: { type: 'string' }, value: { type: 'string' } }],
  ['browser_scroll', '본문·댓글 영역을 찾도록 화면을 세로로 스크롤합니다.', { deltaY: { type: 'integer', minimum: -3000, maximum: 3000 } }],
  ['browser_tabs', '현재 계정 브라우저의 탭을 읽거나 선택합니다.', { index: { type: 'integer', minimum: -1 } }],
  ['browser_submit', '검토된 본문의 실제 발송·발행·등록 또는 최종 확인 버튼을 누릅니다.', { ref: { type: 'string' } }],
  ['browser_finish', '실제 전송 완료 또는 게시된 본문을 확인하고 결과 증표를 남깁니다.', {}],
].map(([name, description, properties]) => ({ name, description, inputSchema: { type: 'object', properties,
  required: name === 'browser_snapshot' ? [] : Object.keys(properties), additionalProperties: false }, annotations: { readOnlyHint: ['browser_snapshot', 'browser_tabs'].includes(name), destructiveHint: false } }));

// 과거 미발송 상태와 재발송 금지는 최초 발송의 철회가 아니다.
function mailProhibited(value) {
  const text = String(value).replace(/재발송|다시\s*발송|다시\s*보내지/g, '재전송');
  return /발송(?:은|을|도)?\s*(?:하지\s*(?:마|말|않도록|않아\s*주|않는다|않습니다|않겠)|금지)|보내지\s*(?:마|말|않는다|않습니다)/.test(text)
    || /(?:메일(?:\s*발송)?|발송|전송)(?:[\s·,]|게시|발행|광고|집행|외부|은|는|도|을|와|과)*없(?:다|음|습니다)/.test(text)
    || /(?:메일|email|e-mail)[^.!?\n]{0,80}(?:발송|전송|집행)(?:은|을|도)?\s*없(?:다|음|습니다)/i.test(text);
}

export function requestedExternalActions(prompt) {
  const text = String(prompt || '');
  if (/초안만|draft\s+only/i.test(text)) return [];
  const actions = [];
  if (/(?:메일|email|e-mail)[\s\S]{0,80}(?:보내|보내기|발송|send)|send[\s\S]{0,40}(?:mail)/i.test(text)) actions.push('mail');
  if (/(?:블로그|카페|게시글|포스팅|글)[\s\S]{0,80}(?:게시|발행|올려|올리기|등록)|(?:게시|발행)[\s\S]{0,40}(?:블로그|카페|글)|(?:블로그|카페)(?:에|에서)[\s\S]{0,80}(?:작성|써)/.test(text)) actions.push('post');
  if (/댓글[\s\S]{0,40}(?:작성|달아|등록|올려)|(?:작성|등록)[\s\S]{0,20}댓글/.test(text)) actions.push('comment');
  return actions.filter((action) => action === 'mail' ? !mailProhibited(text)
    : action === 'post' ? !/게시\s*(?:하지|금지)|발행\s*(?:하지|금지)|올리지\s*마/.test(text)
      : !/댓글[\s\S]{0,20}(?:하지\s*마|금지)|댓글\s*달지\s*마/.test(text));
}

export function externalActionPolicy(turns) {
  const actions = new Set();
  for (const text of turns) {
    if (/초안만|draft\s+only/i.test(text)) actions.clear();
    if (mailProhibited(text)) actions.delete('mail');
    if (/게시\s*(?:하지|금지)|발행\s*(?:하지|금지)|올리지\s*마/.test(text)) actions.delete('post');
    if (/댓글[\s\S]{0,20}(?:하지\s*마|금지)|댓글\s*달지\s*마/.test(text)) actions.delete('comment');
    for (const action of requestedExternalActions(text)) actions.add(action);
  }
  const latest = String(turns.at(-1) || '');
  const resendText = latest.split(/[.!?]\s+|\n/).filter((clause) => !/재(?:발송|게시)\s*(?:하지|금지)|다시[\s\S]{0,30}(?:보내지|(?:발송|게시|발행)\s*하지)|수정본[\s\S]{0,20}(?:발송|게시|발행)\s*하지/.test(clause)).join(' ');
  return { actions: [...actions], allowResend: /재발송|재게시|다시[\s\S]{0,30}(?:보내|발송|게시|발행)|수정본[\s\S]{0,20}(?:발송|게시|발행)/.test(resendText),
    retryUncertain: /미발송\s*확인|미게시\s*확인|발송되지\s*않.*확인|게시되지\s*않.*확인/.test(latest),
    confirmExisting: !/미발송|미게시|미등록/.test(latest) && /(?:발송|게시|등록)[\s\S]{0,30}(?:됐|되었|됨|완료)[\s\S]{0,20}확인/.test(latest) };
}

export function createBrowserWork({ root, store, sessions, providersForTests = null }) {
  const videos = createVideoHistory(root);
  const capabilities = new Map(); let server, origin, serverReady;
  const allowed = (provider, url) => providersForTests ? providersForTests(provider, url) : allowedServiceUrl(provider, url);
  const recordPath = (scope, key) => join(root, '.office', 'publications', `${hash(scope).slice(0, 24)}-${key}.json`);
  const publicUrl = (value) => {
    const u = new URL(value); for (const key of [...u.searchParams.keys()]) if (/token|secret|password|code|auth|key/i.test(key)) u.searchParams.delete(key);
    if (/token|secret|password|code|auth|key/i.test(u.hash)) u.hash = ''; return u.toString();
  };
  const textOnPage = async (page, provider) => (await Promise.all(page.frames().filter((f) => allowed(provider, f.url()) || f.url() === 'about:blank').map((frame) => frame.locator('body').evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const text = [];
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!parent || parent.isContentEditable || parent.closest('input,textarea,script,style') || !parent.getClientRects().length) continue;
      text.push(node.textContent);
    }
    return text.join(' ');
  }).catch(() => '')))).join(' ');
  const current = (job) => job.context.pages()[job.pageIndex] || job.context.pages().at(-1);
  const pageCheck = async (job) => {
    let page = current(job);
    if (!page || !allowed(job.provider, page.url())) throw new BrowserActionError('연결된 서비스의 업무 화면에서 진행해 주세요.');
    if (await requiresLogin(page)) {
      store.update(job.connection, { status: 'needs_login' });
      // 첫 화면 이후의 SSO 이동도 직원의 같은 브라우저 흐름에서 처리한다.
      // 전송을 시도한 뒤에는 결과를 잃거나 다시 보내지 않도록 재로그인하지 않는다.
      if (!job.committing && !job.confirmed && sessions.ready) {
        page = await sessions.ready(job.connection, job.context, job.target);
        job.pageIndex = job.context.pages().indexOf(page);
        job.filled.clear(); job.refs.clear();
      } else throw new ConnectionRequired();
    }
    return page;
  };
  const persist = (job, fields = {}) => { Object.assign(job.record, fields, { updatedAt: new Date().toISOString() }); writePrivate(job.file, job.record); };
  const finish = async (job, page) => {
    if (!job.committing) throw new BrowserActionError('발송·등록 버튼을 누른 기록이 없습니다.');
    const text = normalized(await textOnPage(page, job.provider));
    const prefix = normalized(job.body).slice(0, job.action === 'comment' ? 5000 : 70);
    const suffix = normalized(job.body).slice(-70);
    const count = prefix ? text.split(prefix).length - 1 : 0;
    const mailSent = /메일을?보냈|메일이?발송되었|발송(?:을)?완료|전송(?:을)?완료|messagesent|mailsent|successfullysent/i.test(text);
    const mailReceipt = job.action === 'mail' ? sentMailReceipt({ attempted: job.committing, url: page.url(), text,
      subject: job.subject, body: job.body, recipients: job.recipients, sender: store.credentials(job.connection)?.username }) : null;
    const published = prefix && text.includes(prefix) && text.includes(suffix) && count > job.beforeCount
      && (job.action !== 'post' || text.includes(normalized(job.subject)))
      && !/write|editor|newpost|compose/i.test(new URL(page.url()).pathname + new URL(page.url()).search);
    if (job.action === 'mail' ? !mailSent && !mailReceipt : !published) throw new BrowserActionError('실제 발송 완료 또는 게시된 본문을 아직 확인하지 못했습니다. 결과 화면을 열어 다시 확인해 주세요.');
    persist(job, { status: 'confirmed', resultUrl: publicUrl(page.url()), confirmedAt: new Date().toISOString(), ...(mailReceipt ? { evidence: mailReceipt, confirmedBy: 'sent-message' } : {}) });
    videos.confirm({ ids: job.videoIds, owner: job.videoOwner, resultUrl: job.record.resultUrl });
    job.confirmed = true;
    return { confirmed: true, url: job.record.resultUrl };
  };
  const snapshot = async (job, page, query = '') => {
    job.refs.clear(); let serial = 0;
    const frames = [];
    for (const [frameIndex, frame] of page.frames().entries()) {
      if (!allowed(job.provider, frame.url()) && frame.url() !== 'about:blank') continue;
      const controls = await frame.locator(ELEMENTS).evaluateAll((elements, query) => {
        const all = elements.map((el, index) => {
        if (!el.getClientRects().length || el.getAttribute('type') === 'password') return null;
        const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0, 100) || el.getAttribute('name') || el.id || (el.isContentEditable ? '본문 편집기' : '');
        const description = [...(el.labels || [])].map((label) => label.textContent.trim()).join(' ').slice(0, 160);
        const signature = [el.tagName, el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('aria-label'), el.textContent?.trim().slice(0, 100)].join('|');
        return { index, label, description, editable: el.isContentEditable, tag: el.tagName, type: el.getAttribute('type'), signature };
        }).filter(Boolean);
        const normalize = (text) => String(text).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
        const words = query.split(/[\s,·]+/).map(normalize).filter(Boolean);
        const matches = words.length ? all.filter((control) => words.some((word) => normalize(control.label + ' ' + control.description).includes(word))) : all;
        return (matches.length ? matches : all).slice(0, 180);
      }, String(query).slice(0, 200));
      for (const control of controls) {
        control.ref = `r${++serial}`;
        job.refs.set(control.ref, { frame, locator: frame.locator(ELEMENTS).nth(control.index), signature: control.signature });
        delete control.signature; delete control.index;
      }
      frames.push({ index: frameIndex, url: publicUrl(frame.url()), controls,
        snapshot: (await frame.locator('body').ariaSnapshot().catch(() => '')).slice(0, 18000) });
    }
    return { url: publicUrl(page.url()), frames, action: job.action, status: job.record.status };
  };
  const target = async (job, ref) => {
    const item = job.refs.get(ref); if (!item) throw new BrowserActionError('화면을 다시 읽어 현재 ref를 선택해 주세요.');
    const signature = await item.locator.evaluate((el) => [el.tagName, el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('aria-label'), el.textContent?.trim().slice(0, 100)].join('|'));
    if (signature !== item.signature) throw new BrowserActionError('화면이 바뀌었습니다. snapshot으로 ref를 다시 읽어 주세요.');
    if (await item.locator.getAttribute('type') === 'password') throw new ConnectionRequired();
    return item.locator;
  };
  const call = async (job, name, args) => {
    let page = await pageCheck(job);
    if (job.confirmed && !['browser_snapshot', 'browser_tabs', 'browser_finish'].includes(name)) throw new BrowserActionError('이미 완료한 외부 작업입니다. 중복 발송·게시하지 않습니다.');
    if (name === 'browser_snapshot') return snapshot(job, page, args.query || '');
    if (name === 'browser_scroll') {
      if (!Number.isInteger(args.deltaY) || Math.abs(args.deltaY) > 3000) throw new BrowserActionError('스크롤 범위를 확인해 주세요.');
      await page.mouse.wheel(0, args.deltaY); return { done: true };
    }
    if (name === 'browser_navigate') {
      if (!allowed(job.provider, args.url)) throw new BrowserActionError('연결된 서비스 안의 주소만 열 수 있습니다.');
      await page.goto(args.url, { waitUntil: 'domcontentloaded' }); return snapshot(job, await pageCheck(job));
    }
    if (name === 'browser_tabs') {
      if (Number.isInteger(args.index) && args.index >= 0) {
        if (!job.context.pages()[args.index]) throw new BrowserActionError('해당 탭이 없습니다.');
        job.pageIndex = args.index; page = await pageCheck(job);
      }
      return { tabs: job.context.pages().map((p, index) => ({ index, url: allowed(job.provider, p.url()) ? publicUrl(p.url()) : '(연결 서비스 밖)' })) };
    }
    if (name === 'browser_finish') {
      if (job.confirmed) return { confirmed: true, url: job.record.resultUrl };
      for (let attempt = 0; ; attempt++) {
        try { return await finish(job, current(job)); }
        catch (error) { if (attempt >= 19 || !job.committing) throw error; await page.waitForTimeout(150); }
      }
    }
    if (name === 'browser_press_key') {
      if (!/^(?:Tab|Escape|Arrow(?:Up|Down|Left|Right)|Home|End|(?:ControlOrMeta|Control|Meta)\+(?:A|B|I|U)|Enter)$/i.test(args.key) || args.key === 'Enter' && !job.committing) throw new BrowserActionError('최종 전송은 browser_submit으로 실행하고, 허용된 화면 조작 키만 사용해 주세요.');
      await page.keyboard.press(args.key); return { done: true };
    }
    const locator = await target(job, args.ref);
    if (name === 'browser_fill_content') {
      if (!['subject', 'body', 'recipients'].includes(args.field) || args.field === 'recipients' && job.action !== 'mail') throw new BrowserActionError('올바른 입력 항목을 선택해 주세요.');
      const value = args.field === 'body' ? job.body : args.field === 'subject' ? job.subject : job.recipients.join(', ');
      await locator.fill(value); job.filled.add(args.field); return { filled: args.field };
    }
    if (name === 'browser_search') {
      const hint = [await locator.getAttribute('type'), await locator.getAttribute('aria-label'), await locator.getAttribute('placeholder'), await locator.getAttribute('name')].join(' ');
      if (!/search|검색|찾기/i.test(hint) || typeof args.query !== 'string' || args.query.length > 500) throw new BrowserActionError('검색 칸에만 검색어를 입력할 수 있습니다. 본문·수신자는 검토된 원문을 사용합니다.');
      await locator.fill(args.query); await locator.press('Enter'); return { done: true };
    }
    if (name === 'browser_select') { await locator.selectOption(args.value); return { done: true }; }
    const label = [await locator.innerText().catch(() => ''), await locator.getAttribute('aria-label'), await locator.getAttribute('value')].join(' ').trim();
    if (FORBIDDEN.test(label)) throw new BrowserActionError('이 작업은 메일 발송·글/댓글 작성만 허용합니다. 계정 변경·삭제·결제는 실행할 수 없습니다.');
    if (name === 'browser_click') {
      if (FINAL.test(label)) throw new BrowserActionError('실제 발송·등록 버튼은 browser_submit으로 실행해 주세요.');
      const href = await locator.getAttribute('href');
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href) && !allowed(job.provider, new URL(href, page.url()).toString())) throw new BrowserActionError('연결 서비스 밖의 링크는 열 수 없습니다.');
      await locator.click(); return { done: true };
    }
    if (name === 'browser_submit') {
      if (!job.filled.has('body') || job.action === 'mail' && (!job.filled.has('recipients') || !job.filled.has('subject'))
        || job.action === 'post' && !job.filled.has('subject')) throw new BrowserActionError('검토된 수신자·제목·본문을 먼저 입력해 주세요.');
      if (!FINAL.test(label) && !(job.committing && /확인|완료|계속|확정|ok|confirm|yes/i.test(label))) throw new BrowserActionError('발송·발행·등록 또는 그 최종 확인 버튼을 선택해 주세요.');
      const handle = await locator.elementHandle();
      for (const previous of job.submitted) {
        if (await handle.evaluate((element, before) => element === before, previous).catch(() => false)) throw new BrowserActionError('이미 누른 발송·등록 버튼입니다. 결과를 확인해 주세요.');
      }
      // 실제 게시 클릭 직전에 동기 기록해 서로 다른 계정의 동시 게시도 막는다.
      if (job.videoIds.length && !job.committing) videos.claim({ ids: job.videoIds, owner: job.videoOwner, scope: job.scope, schedule: job.schedule });
      job.submitted.push(handle);
      job.committing = true; persist(job, { status: 'committing' });
      await locator.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (job.action === 'mail') {
        await page.waitForTimeout(300);
        await finish(job, current(job)).catch(() => {});
      }
      return { submitted: true, confirmed: job.confirmed, instruction: '실제 발송 완료·게시된 본문을 확인하고 browser_finish를 호출하세요.' };
    }
    throw new BrowserActionError('지원하지 않는 브라우저 도구입니다.');
  };
  const ensureServer = () => {
    if (serverReady) return serverReady;
    serverReady = (async () => {
    server = createServer(async (req, res) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const job = capabilities.get(token);
      if (req.method !== 'POST' || req.url !== '/tools' || req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}` || !job
        || token.length !== job.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(job.token))) { res.writeHead(403); res.end(); return; }
      try {
        let input = ''; for await (const part of req) { input += part; if (input.length > 100000) throw new BrowserActionError('입력이 너무 큽니다.'); }
        const { name, arguments: args = {} } = JSON.parse(input);
        if (!BROWSER_TOOLS.some((tool) => tool.name === name)) throw new BrowserActionError('허용되지 않은 브라우저 도구입니다.');
        const result = await call(job, name, args);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error instanceof ConnectionRequired || error instanceof BrowserActionError ? error.message : '브라우저 동작을 완료하지 못했습니다. 현재 화면의 ref·필수 항목·결과를 다시 확인해 주세요.', code: error.code || 'BROWSER_ACTION' }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    })();
    serverReady.catch(() => { serverReady = null; });
    return serverReady;
  };
  return {
    connections: () => store.list(),
    videoHistory: (scope) => videos.excluded(scope),
    async deliver({ scope, publication, body, allowedActions, instructionKey, allowResend = false, retryUncertain = false, confirmExisting = false, schedule = null, execute, signal }) {
      if (!allowedActions.includes(publication.action)) throw new BrowserActionError('대표가 이 업무에서 지시한 외부 발송·게시·댓글 작업만 실행할 수 있습니다.');
      const provider = serviceProvider(publication.service);
      const matching = store.list().filter((c) => c.provider === provider);
      const connection = publication.connection ? store.find(publication.connection) : matching.length === 1 ? store.find(matching[0].id) : null;
      if (!connection) throw new ConnectionRequired(matching.length ? '사용할 연결 계정을 지정해 주세요.' : '계정 연결에서 해당 서비스의 계정을 처음 한 번 연결해 주세요.');
      if (!provider || connection.provider !== provider || !allowed(provider, publication.target)) throw new BrowserActionError('연결 계정과 대상 서비스·주소가 일치하지 않습니다.');
      if (!body.trim()) throw new BrowserActionError('외부 작업의 본문이 비어 있습니다.');
      const recipients = publication.recipients || [];
      if (publication.action === 'mail' && (!recipients.length || recipients.some((email) => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)))) throw new BrowserActionError('메일 수신자를 확인해 주세요.');
      if ((publication.action === 'mail') !== (publication.service === 'naverworks_mail')) throw new BrowserActionError('메일 서비스와 작업 종류가 일치하지 않습니다.');
      const identity = [scope, publication.action, publication.service, publication.target, recipients];
      const legacyFile = recordPath(scope, hash(JSON.stringify(identity)).slice(0, 24));
      const logical = hash(JSON.stringify(publication.action === 'post' ? [...identity, publication.id] : identity)).slice(0, 24);
      const proposed = recordPath(scope, logical);
      const file = !existsSync(proposed) && existsSync(legacyFile) ? legacyFile : proposed, previous = readPrivate(file);
      const videoOwner = basename(file);
      const videoIds = publication.action === 'post' ? youtubeVideoIds(publication.subject + '\n' + body) : [];
      if (schedule?.uniqueYoutube && publication.action === 'post' && (videoIds.length !== 1 || youtubeVideoIds(body).length !== 1)) throw new BrowserActionError('예약 영상 게시글 본문마다 원본 유튜브 링크를 1개 넣어 주세요.');
      const contentHash = hash(JSON.stringify([publication.subject, body]));
      if (['committing', 'uncertain'].includes(previous.status) && confirmExisting && previous.contentHash === contentHash) {
        const confirmed = { ...previous, status: 'confirmed', confirmedBy: 'user', confirmedAt: new Date().toISOString() };
        writePrivate(file, confirmed); videos.confirm({ ids: videoIds, owner: videoOwner, resultUrl: confirmed.resultUrl }); return confirmed;
      }
      if (previous.status === 'confirmed' && previous.contentHash === contentHash && (videoIds.length || !allowResend || previous.instructionKey === instructionKey)) return previous;
      if (['committing', 'uncertain'].includes(previous.status) && !(allowResend && retryUncertain)) throw new BrowserActionError('직전 발송·게시 결과가 불확실합니다. 사이트에서 확인한 뒤 미발송이면 “미발송 확인, 재발송”으로 지시해 주세요.');
      if (previous.status === 'confirmed' && (!allowResend || previous.instructionKey === instructionKey)) throw new BrowserActionError('이미 발송·게시한 대상의 수정본입니다. 재발송·재게시 지시가 필요합니다.');
      if (videoIds.length) videos.check({ ids: videoIds, owner: videoOwner, schedule });
      return sessions.withSession(connection.id, publication.target, signal, async (context) => {
        await ensureServer();
        signal.throwIfAborted();
        const latest = readPrivate(file);
        if (latest.status === 'confirmed' && latest.contentHash === contentHash && (videoIds.length || !allowResend || latest.instructionKey === instructionKey)) return latest;
        if (['committing', 'uncertain'].includes(latest.status) && !(allowResend && retryUncertain)) throw new BrowserActionError('직전 전송 결과를 먼저 확인해 주세요.');
        const page = context.pages().at(-1);
        const before = normalized(await textOnPage(page, provider)), prefix = normalized(body).slice(0, publication.action === 'comment' ? 5000 : 70);
        const record = { status: 'prepared', action: publication.action, service: publication.service, connection: connection.id,
          contentHash, instructionKey, target: publication.target };
        const job = { ...publication, provider, recipients, body, scope, schedule, videoIds, videoOwner, context, pageIndex: context.pages().length - 1,
          refs: new Map(), filled: new Set(), submitted: [], token: randomBytes(32).toString('hex'), record, file, beforeCount: prefix ? before.split(prefix).length - 1 : 0 };
        const permissionsFile = join(store.directory, 'capabilities', randomBytes(16).toString('hex') + '.json');
        writePrivate(permissionsFile, { url: origin + '/tools', token: job.token });
        persist(job); capabilities.set(job.token, job);
        const revoke = () => { capabilities.delete(job.token); rmSync(permissionsFile, { force: true }); };
        signal.addEventListener('abort', revoke, { once: true });
        try {
          const result = await execute({ url: origin + '/tools', token: job.token, permissionsFile });
          if (!job.confirmed) throw new BrowserActionError('실제 발송·게시 결과 증표가 없습니다. 완료로 처리하지 않습니다.');
          return { ...job.record, summary: result };
        } catch (error) {
          if (job.confirmed) return job.record;
          persist(job, { status: job.confirmed ? 'confirmed' : job.committing ? 'uncertain' : 'prepared' });
          if (videoIds.length && !job.committing) videos.check({ ids: videoIds, owner: videoOwner, schedule });
          throw error;
        } finally { signal.removeEventListener('abort', revoke); revoke(); }
      });
    },
    async close() { await sessions.close(); await serverReady?.catch(() => {}); if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); server = null; serverReady = null; } },
  };
}
