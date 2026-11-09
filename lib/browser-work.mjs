// 사용자 지시·검토한 원문에 묶인 브라우저 작업. 로그인 값/쿠키/임의 JS 실행은 도구에 노출하지 않는다.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';
import { allowedServiceUrl, connectionAllowsUrl, serviceProvider } from './connections.mjs';
import { isPublicWebUrl } from './source-check.mjs';
import { AccountProtected, accountProtected, ConnectionRequired, requiresLogin } from './browser-session.mjs';
import { createVideoHistory, youtubeVideoIds } from './video-history.mjs';
import { isFinalAction, isFinalConfirm, isForbiddenAction, isReadOnlyBlocked } from './guardrails.mjs';
import { blockedReason } from './attachments.mjs';
// 외부 작업 허용·위임 판별은 안전선 모듈로 옮겼다. 기존 가져오기 경로를 유지한다
export { externalActionPolicy, requestedExternalActions } from './guardrails.mjs';

class BrowserActionError extends Error { constructor(message) { super(message); this.code = 'BROWSER_ACTION'; } }
const ELEMENTS = 'a,button,label,input:not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"],[role="option"],[role="menuitem"],[role="tab"],[tabindex],[onclick]';
// 공백과 폭 없는 글자(U+200B~U+200D, U+2060)를 뺀다. 카페 편집기는 빈 줄을 U+200B만 든 문단으로 저장해 화면 글자에 섞인다
const squash = (s) => String(s || '').replace(/[\s\u200B-\u200D\u2060]+/g, '');
const normalized = (s) => squash(String(s || '').normalize('NFKC'));
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
// 글 편집기는 유튜브·네이버 지도(플레이스) 링크를 단독으로 붙여넣어야 영상·장소 카드로 바꾼다. 글과 링크를 나눠 순서대로 붙여넣는다
const CARD_LINK = /https?:\/\/(?:(?:www\.|m\.)?(?:youtube\.com|youtu\.be)|naver\.me|(?:[a-z0-9-]+\.)*(?:map|place)\.naver\.com)\/[^\s<>"')\]]+/g;
export function bodySegments(text) {
  const value = String(text), parts = [];
  let last = 0;
  for (const match of value.matchAll(CARD_LINK)) {
    const url = match[0].replace(/[.,;:!?…。，、]+$/, '');
    // 글과 카드 사이에 빈 줄을 둔다
    if (value.slice(last, match.index).trim()) parts.push({ text: `${value.slice(last, match.index).trim()}\n\n`, card: false });
    parts.push({ text: url, card: true });
    last = match.index + url.length;
  }
  if (value.slice(last).trim()) parts.push({ text: value.slice(last).trim(), card: false });
  return parts.length ? parts : [{ text: value, card: false }];
}

export const BROWSER_TOOLS = [
  ['browser_snapshot', '현재 서비스 화면·프레임과 조작 ref(r숫자)를 읽습니다. query의 여러 단어는 각각 검색합니다. 빈 query는 전체 목록입니다. 항목 이름을 ref로 쓰지 마세요.', { query: { type: 'string' } }],
  ['browser_navigate', '연결된 서비스의 주소로 이동합니다.', { url: { type: 'string' } }],
  ['browser_click', '화면 ref를 클릭합니다. 최종 발송·등록은 browser_submit을 사용합니다.', { ref: { type: 'string' } }],
  ['browser_fill_content', '검토된 원문의 제목·본문·수신자만 입력합니다.', { ref: { type: 'string' }, field: { type: 'string', enum: ['subject', 'body', 'recipients'] } }],
  ['browser_type', '일반 웹사이트 업무에서 입력칸에 글자를 입력합니다(기존 값은 바꿉니다). 메일·글·댓글은 browser_fill_content를 씁니다.', { ref: { type: 'string' }, text: { type: 'string' } }],
  ['browser_attach', '일반 웹사이트 업무 또는 첨부가 지정된 메일에서 업무에 지정된 첨부 파일을 첨부합니다. ref는 파일 칸 또는 파일 선택 창을 여는 버튼("파일 선택" 등)입니다. file은 첨부 목록의 파일 이름입니다.', { ref: { type: 'string' }, file: { type: 'string' } }],
  ['browser_text', '현재 화면에 보이는 글자를 순서대로 읽습니다. 긴 목록·표는 offset을 늘려 이어서 읽습니다(한 번에 최대 40000자).', { offset: { type: 'integer', minimum: 0 } }],
  ['browser_search', '검색 입력칸에 검색어를 입력합니다.', { ref: { type: 'string' }, query: { type: 'string' } }],
  ['browser_press_key', 'Tab·방향키·Escape 등 화면 조작 키를 누릅니다.', { key: { type: 'string' } }],
  ['browser_select', '선택 상자의 항목을 고릅니다.', { ref: { type: 'string' }, value: { type: 'string' } }],
  ['browser_scroll', '화면을 세로로 스크롤합니다. 표·목록처럼 안쪽에 스크롤이 있는 영역은 ref에 그 영역 안의 요소(예: 표의 한 행)를 주면 그 안을 스크롤합니다. 화면에 일부 행만 그리는 표는 스크롤한 뒤 다시 읽으세요.', { deltaY: { type: 'integer', minimum: -3000, maximum: 3000 }, ref: { type: 'string' } }],
  ['browser_tabs', '현재 계정 브라우저의 탭을 읽거나 선택합니다.', { index: { type: 'integer', minimum: -1 } }],
  ['browser_submit', '검토된 본문의 실제 발송·발행·등록, 일반 웹사이트의 업로드·저장·제출 같은 되돌리기 어려운 버튼 또는 그 최종 확인 버튼을 누릅니다.', { ref: { type: 'string' } }],
  ['browser_finish', '실제 전송 완료·게시된 본문 또는 일반 웹사이트 작업의 결과 화면을 확인하고 결과 증표를 남깁니다. 일반 웹사이트는 summary에 확인한 결과를, completed에 지침을 끝까지 마쳤는지(true/false)를 적습니다. 결과 화면 캡처는 자동으로 저장됩니다.', { summary: { type: 'string' }, completed: { type: 'boolean' } }],
].map(([name, description, properties]) => ({ name, description, inputSchema: { type: 'object', properties,
  required: ['browser_snapshot', 'browser_finish', 'browser_text'].includes(name) ? [] : name === 'browser_scroll' ? ['deltaY'] : Object.keys(properties), additionalProperties: false }, annotations: { readOnlyHint: ['browser_snapshot', 'browser_tabs', 'browser_text'].includes(name), destructiveHint: false } }));

export function createBrowserWork({ root, store, sessions, providersForTests = null }) {
  const videos = createVideoHistory(root);
  const capabilities = new Map(); let server, origin, serverReady;
  const allowed = (provider, url) => providersForTests ? providersForTests(provider, url) : allowedServiceUrl(provider, url);
  // 일반 웹사이트 업무는 연결에 저장한 도메인 기준, 그 밖은 서비스 고정 규칙
  const allowedFor = (job, url) => job.publicWeb ? (job.allowUrl || isPublicWebUrl)(url) : job.site ? connectionAllowsUrl(job.site, url) : allowed(job.provider, url);
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
    if (!page || !allowedFor(job, page.url())) throw new BrowserActionError('연결된 서비스의 업무 화면에서 진행해 주세요.');
    if (!job.publicWeb && await accountProtected(page)) {
      store.update(job.connection, { status: 'protected' });
      throw new AccountProtected();
    }
    if (!job.publicWeb && await requiresLogin(page)) {
      store.update(job.connection, { status: 'needs_login' });
      // 등록을 누른 뒤 로그인이 끊기면 보호 조치일 수 있다. 다시 로그인하거나 다시 누르지 않고 멈춘다
      if (job.committing) throw new ConnectionRequired('등록을 누른 뒤 로그인이 끊겼습니다. 계정 보호 조치일 수 있으니 서비스에서 계정 상태와 게시 여부를 직접 확인해 주세요. 자동으로 다시 시도하지 않습니다.');
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
  // 일반 웹사이트: 사이트마다 완료 화면이 달라 본문 대조 대신 결과 화면 주소·캡처·직원 확인 요약을 증표로 남긴다.
  const finishWeb = async (job, page, summary, completed) => {
    if (typeof summary !== 'string' || !summary.trim()) throw new BrowserActionError('확인한 결과를 summary에 적어 주세요.');
    if (typeof completed !== 'boolean') throw new BrowserActionError('지침을 끝까지 마쳤는지 completed(true/false)를 함께 적어 주세요.');
    let evidence = null;
    if (job.evidenceDir) {
      mkdirSync(job.evidenceDir, { recursive: true });
      evidence = join(job.evidenceDir, `${job.id || 'web'}-${Date.now().toString(36)}.png`);
      await page.screenshot({ path: evidence, fullPage: true }).catch(() => { evidence = null; });
    }
    const fields = { resultUrl: publicUrl(page.url()), summary: summary.trim().slice(0, 2000), ...(evidence ? { evidence: basename(evidence) } : {}), submits: job.submitted.length };
    // 끝내지 못했으면 완료로 닫지 않는다. 직원이 결과 화면을 확인한 보고이므로 불확실이 아니라 미완료로 남기고 대표 확인으로 넘긴다.
    if (!completed) { job.incomplete = fields.summary; persist(job, { ...fields, status: 'incomplete' }); return { completed: false, recorded: true }; }
    persist(job, { ...fields, status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedBy: 'staff-report' });
    job.confirmed = true;
    return { confirmed: true, url: job.record.resultUrl, evidence: evidence ? basename(evidence) : null };
  };
  const finish = async (job, page) => {
    if (!job.committing) throw new BrowserActionError('발송·등록 버튼을 누른 기록이 없습니다.');
    const text = normalized(await textOnPage(page, job.provider));
    // 글의 영상·장소 링크는 카드로 바뀌어 글자가 이어지지 않으므로 앞뒤 글 조각으로 확인한다
    const texts = job.action === 'post' ? bodySegments(job.body).filter((s) => !s.card).map((s) => normalized(s.text)) : [normalized(job.body)];
    const prefix = (texts[0] || '').slice(0, job.action === 'comment' ? 5000 : 70);
    const suffix = (texts.at(-1) || '').slice(-70);
    const count = prefix ? text.split(prefix).length - 1 : 0;
    const mailSent = /메일을?보냈|메일이?발송되었|발송(?:을)?완료|전송(?:을)?완료|messagesent|mailsent|successfullysent/i.test(text)
      // 보낸메일함 목록에 방금 보낸 제목과 수신자가 모두 보이면 발송 완료로 본다(완료 문구가 바로 사라지는 화면)
      || job.action === 'mail' && job.committing && /보낸메일함|보낸편지함|sentmail|sentbox|\/sent/i.test(text + new URL(page.url()).pathname + new URL(page.url()).hash)
        && Boolean(job.subject) && text.includes(normalized(job.subject))
        && job.recipients.every((address) => text.toLowerCase().includes(normalized(address).toLowerCase()));
    const mailReceipt = job.action === 'mail' ? sentMailReceipt({ attempted: job.committing, url: page.url(), text,
      subject: job.subject, body: job.body, recipients: job.recipients, sender: store.credentials(job.connection)?.username }) : null;
    // 영상 링크만 있는 글은 본문 글자가 없으니 제목과 결과 화면으로 확인한다
    const videoOnly = job.action === 'post' && !prefix && youtubeVideoIds(job.body).length > 0;
    const published = (videoOnly || prefix && text.includes(prefix) && text.includes(suffix) && count > job.beforeCount)
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
      if (!allowedFor(job, frame.url()) && frame.url() !== 'about:blank') continue;
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
    if (name === 'browser_text') {
      const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
      const text = (await Promise.all(page.frames().filter((f) => allowedFor(job, f.url()) || f.url() === 'about:blank').map((f) => f.locator('body').innerText().catch(() => '')))).join('\n');
      return { url: publicUrl(page.url()), total: text.length, offset, text: text.slice(offset, offset + 40000), next: offset + 40000 < text.length ? offset + 40000 : null };
    }
    if (job.readOnly && ['browser_submit', 'browser_attach', 'browser_fill_content'].includes(name)) throw new BrowserActionError('사이트 조회 단계는 읽기 전용입니다. 화면을 읽고 메뉴·검색·필터만 조작하세요. 사이트에 쓰는 작업은 검토 뒤 외부 작업으로 진행합니다.');
    if (job.readOnly && name === 'browser_finish') { job.confirmed = true; return { done: true }; }
    if (name === 'browser_scroll') {
      if (!Number.isInteger(args.deltaY) || Math.abs(args.deltaY) > 3000) throw new BrowserActionError('스크롤 범위를 확인해 주세요.');
      // 휠은 마우스 아래 요소를 스크롤한다. 지정한 영역 위(없으면 화면 가운데)로 옮긴 뒤 굴린다.
      if (args.ref) await (await target(job, args.ref)).hover();
      else { const size = page.viewportSize() || { width: 1440, height: 1000 }; await page.mouse.move(size.width / 2, size.height / 2); }
      await page.mouse.wheel(0, args.deltaY); await page.waitForTimeout(200); return { done: true };
    }
    if (name === 'browser_navigate') {
      if (!allowedFor(job, args.url)) throw new BrowserActionError('연결된 서비스 안의 주소만 열 수 있습니다.');
      await page.goto(args.url, { waitUntil: 'domcontentloaded' });
      // 다른 화면으로 옮기면 앞 화면에 넣은 값은 없다
      job.filled.clear();
      return snapshot(job, await pageCheck(job));
    }
    if (name === 'browser_tabs') {
      if (Number.isInteger(args.index) && args.index >= 0) {
        if (!job.context.pages()[args.index]) throw new BrowserActionError('해당 탭이 없습니다.');
        job.pageIndex = args.index; page = await pageCheck(job);
      }
      return { tabs: job.context.pages().map((p, index) => ({ index, url: allowedFor(job, p.url()) ? publicUrl(p.url()) : '(연결 서비스 밖)' })) };
    }
    if (name === 'browser_finish') {
      if (job.confirmed) return { confirmed: true, url: job.record.resultUrl };
      if (job.site) return finishWeb(job, current(job), args.summary, args.completed);
      for (let attempt = 0; ; attempt++) {
        try { return await finish(job, current(job)); }
        catch (error) { if (attempt >= 19 || !job.committing) throw error; await page.waitForTimeout(150); }
      }
    }
    if (name === 'browser_press_key') {
      if (!/^(?:Tab|Escape|Arrow(?:Up|Down|Left|Right)|Home|End|(?:ControlOrMeta|Control|Meta)\+(?:A|B|I|U)|Enter)$/i.test(args.key) || args.key === 'Enter' && !job.committing && !job.readOnly) throw new BrowserActionError('최종 전송은 browser_submit으로 실행하고, 허용된 화면 조작 키만 사용해 주세요.');
      await page.keyboard.press(args.key); return { done: true };
    }
    const locator = await target(job, args.ref);
    if (name === 'browser_type' || name === 'browser_attach') {
      // 메일은 대표가 지정한 첨부 파일만 붙일 수 있다(본문·수신자는 검토된 원문을 browser_fill_content로 넣음)
      const mailAttach = name === 'browser_attach' && job.action === 'mail' && job.files?.length;
      if (!job.site && !mailAttach) throw new BrowserActionError('자유 입력·파일 첨부는 일반 웹사이트 업무(메일은 대표가 지정한 첨부 파일)에서만 씁니다. 메일·글·댓글은 검토된 원문을 browser_fill_content로 입력하세요.');
      if (mailAttach && job.committing) throw new BrowserActionError('발송 버튼을 누른 뒤에는 첨부를 바꿀 수 없습니다.');
      if (name === 'browser_type') {
        if (typeof args.text !== 'string' || args.text.length > 20000) throw new BrowserActionError('입력할 글자를 확인해 주세요.');
        if (await locator.getAttribute('type') === 'file') throw new BrowserActionError('파일 칸에는 browser_attach를 쓰세요.');
        await locator.fill(args.text); return { done: true };
      }
      const file = job.files.find((f) => f.name === args.file);
      if (!file) throw new BrowserActionError(`업무에 지정된 첨부 파일만 첨부할 수 있습니다: ${job.files.map((f) => f.name).join(', ') || '없음'}`);
      if (await locator.getAttribute('type') === 'file') { await locator.setInputFiles(file.path); job.attached?.add(file.name); return { attached: file.name }; }
      // 숨긴 파일 칸을 버튼이 대신 여는 화면: 버튼을 눌러 열린 파일 선택 창에 지정 파일만 넣는다.
      const opener = [await locator.innerText().catch(() => ''), await locator.getAttribute('aria-label')].join(' ');
      if (isForbiddenAction(opener)) throw new BrowserActionError('계정 변경·삭제·결제·로그아웃 버튼은 실행할 수 없습니다.');
      const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
      await locator.click();
      let picker;
      try { picker = await chooser; } catch { throw new BrowserActionError('파일 선택 창이 열리지 않았습니다. 파일 칸 또는 "파일 선택" 버튼을 골라 주세요.'); }
      await picker.setFiles(file.path); job.attached?.add(file.name); return { attached: file.name };
    }
    if (name === 'browser_fill_content') {
      if (job.site) throw new BrowserActionError('일반 웹사이트 업무는 browser_type으로 입력합니다.');
      if (!['subject', 'body', 'recipients'].includes(args.field) || args.field === 'recipients' && job.action !== 'mail') throw new BrowserActionError('올바른 입력 항목을 선택해 주세요.');
      const value = args.field === 'body' ? job.body : args.field === 'subject' ? job.subject : job.recipients.join(', ');
      // 칸 종류를 확인한다: 본문은 여러 줄 편집기, 제목은 한 줄 칸, 받는사람은 받는사람 표시 칸에만(본문이 받는사람·제목에 섞이는 실수 방지)
      const kind = await locator.evaluate((el) => {
        const labels = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id, el.getAttribute('title'),
          ...[...(el.labels || [])].map((l) => l.textContent)].filter(Boolean).join(' ');
        const multi = el.isContentEditable || el.tagName === 'TEXTAREA' || el.getAttribute('role') === 'textbox' && el.getAttribute('aria-multiline') === 'true';
        const single = el.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'hidden', 'password', 'submit', 'button'].includes((el.getAttribute('type') || 'text').toLowerCase());
        return { multi, single, labels, textarea: el.tagName === 'TEXTAREA' };
      }).catch(() => ({ multi: false, single: false, labels: '', textarea: false }));
      const recipientHint = /받는|수신|받을|to\b|recipient|참조|cc\b|bcc|주소/i.test(kind.labels);
      const subjectHint = /제목|subject|title/i.test(kind.labels);
      if (args.field === 'body' && (!kind.multi || recipientHint || subjectHint)) throw new BrowserActionError('본문은 여러 줄 본문 편집기에만 넣습니다. 이 칸은 받는사람·제목 같은 다른 칸입니다. 화면을 다시 읽고 본문 편집기를 고르세요.');
      // 제목 칸이 여러 줄 입력(textarea)으로 된 사이트도 있다(예: 카페 글쓰기). 제목 단서가 있으면 인정한다
      if (args.field === 'subject' && (!(kind.single || kind.textarea && subjectHint) || recipientHint)) throw new BrowserActionError('제목은 한 줄 제목 칸에만 넣습니다. 화면을 다시 읽고 제목 칸을 고르세요.');
      if (args.field === 'recipients' && (!kind.single && !kind.multi || subjectHint || kind.multi && !recipientHint)) throw new BrowserActionError('받는사람은 받는사람(수신) 칸에만 넣습니다. 화면을 다시 읽고 받는사람 칸을 고르세요.');
      // 서식 편집기(메일·글 본문)는 기본 서명·명함 이미지가 들어 있을 수 있어 지우지 않고 맨 앞에 끼워 넣는다
      if (args.field === 'body' && await locator.evaluate((el) => el.isContentEditable).catch(() => false)) {
        // 입력 기록은 그 화면에서만 믿는다. 화면이 바뀌었거나 비어 있으면 다시 넣고, 이미 있으면 다시 넣지 않는다
        const editorHas = (text) => root.evaluate((el) => el.innerText).then((shown) => squash(shown).includes(text)).catch(() => false);
        // 서명 표 칸처럼 편집기 안의 일부를 골라도 그 부분을 감싸는 본문 편집기 전체의 맨 앞에 넣는다
        const root = (await locator.evaluateHandle((el) => { let r = el; while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement; return r; })).asElement();
        const prefix = squash(job.action === 'post' ? bodySegments(value).find((s) => !s.card)?.text || value : value).slice(0, 40);
        if (await editorHas(prefix)) { job.filled.add('body'); job.editorBody = prefix; return { filled: 'body', note: '본문을 이미 입력했습니다. 편집기에 있어 다시 넣지 않습니다.' }; }
        job.filled.delete('body');
        // 화면(모든 프레임)에 본문 앞부분이 몇 번 보이는지: 입력을 받는 칸과 보이는 칸이 다른 편집기(예: 카페 편집기)도 확인한다
        const shown = async () => squash((await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.body?.innerText || '').catch(() => '')))).join('')).split(prefix).length - 1;
        const shownBefore = await shown();
        const present = async () => await root.evaluate((el) => el.innerText).then((text) => squash(text).startsWith(prefix)).catch(() => false) || await shown() > shownBefore;
        const caretToStart = (el) => {
          el.focus();
          const range = el.ownerDocument.createRange(); range.setStart(el, 0); range.collapse(true);
          const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        };
        // 다른 칸(제목·받는사람 등)으로 새는지 보기 위해 입력 전 값을 기억한다
        const fields = async () => (await Promise.all(page.frames().map((frame) => frame.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea')].map((el, i) => [i, el.value])).catch(() => [])))).map((list) => JSON.stringify(list));
        const before = await fields();
        await root.focus().catch(() => {});
        // 1) 붙여넣기로 넣는다: 편집기가 링크를 영상·미리보기 카드로 바꾼다. 대표 컴퓨터의 클립보드는 쓰지 않는다
        const pasteOne = (text, first) => root.evaluate((el, [v, moveCaret]) => {
          el.focus();
          if (moveCaret) {
            const range = el.ownerDocument.createRange(); range.setStart(el, 0); range.collapse(true);
            const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          }
          const target = el.ownerDocument.activeElement?.isContentEditable ? el.ownerDocument.activeElement : el;
          const data = new DataTransfer(); data.setData('text/plain', v);
          const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
          return !target.dispatchEvent(event) || event.defaultPrevented;
        }, [text, first]).catch(() => false);
        const pageText = async () => (await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.body?.innerText || '').catch(() => '')))).join('\n');
        const textBefore = await pageText();
        // 글에 유튜브·장소 링크가 있으면 글과 링크를 나눠 붙여넣는다(메일·댓글은 전체를 한 번에)
        const segments = job.action === 'post' ? bodySegments(value) : [{ text: value, card: false }];
        let pasted = false;
        for (const [index, segment] of segments.entries()) {
          const handled = await pasteOne(segment.text, index === 0);
          if (index === 0) pasted = handled;
          if (!handled) break;
          await page.waitForTimeout(segment.card ? 2500 : segments.length > 1 ? 400 : 1500);
        }
        // 영상·장소 링크만 있는 글은 카드로 바뀌어 링크 글자가 안 보일 수 있다. 화면이 바뀌었으면 들어간 것으로 보고 다시 넣지 않는다
        const onlyCards = segments.every((s) => s.card);
        const presentAfterPaste = pasted && onlyCards && await pageText() !== textBefore;
        // 2) 편집기가 붙여넣기를 처리하지 않으면 편집기 문서 안에 직접 넣는다(키보드를 거치지 않아 다른 칸으로 새지 않음)
        if (!presentAfterPaste && !await present()) await root.evaluate((el, v) => {
          el.focus();
          const range = el.ownerDocument.createRange(); range.setStart(el, 0); range.collapse(true);
          const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          el.ownerDocument.execCommand('insertText', false, `${v}\n\n`);
        }, value).catch(() => {});
        // 3) 그래도 안 들어갔을 때만 편집기 전체에 초점을 준 뒤 키보드로 넣는다
        if (!presentAfterPaste && !await present()) { await root.focus().catch(() => {}); await root.evaluate(caretToStart); await page.keyboard.insertText(`${value}\n\n`); }
        const after = await fields();
        // 화면이 스스로 바꾸는 칸(임시 저장 값 등)은 무시하고, 본문이 실제로 들어간 칸만 본다
        const leaked = after.some((list, i) => list !== before[i] && squash(list).includes(prefix));
        if (leaked) {
          // 새어 들어간 칸은 원래 값으로 되돌리고 멈춘다
          await Promise.all(page.frames().map((frame, i) => frame.evaluate((saved) => {
            const list = JSON.parse(saved || '[]'); const els = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea')];
            for (const [index, value] of list) if (els[index] && els[index].value !== value) { els[index].value = value; els[index].dispatchEvent(new Event('input', { bubbles: true })); }
          }, before[i]).catch(() => {})));
          throw new BrowserActionError('본문이 다른 칸에 들어가 되돌렸습니다. 화면을 다시 읽고 본문 편집기 영역을 골라 다시 시도해 주세요.');
        }
        // 실제로 들어갔는지 확인한다. 안 들어갔으면 입력 완료로 치지 않아 발송 버튼도 누를 수 없다
        if (!presentAfterPaste && !await present()) throw new BrowserActionError('본문 편집기에 본문이 들어가지 않았습니다. 화면을 다시 읽고 본문 편집기를 골라 다시 시도해 주세요.');
        job.filled.add('body'); job.editorBody = prefix; return { filled: 'body', kept: '편집기의 기존 내용(서명·이미지 등)을 유지하고 본문을 앞에 넣었습니다(입력 확인됨).' };
      }
      await locator.fill(value); job.filled.add(args.field); return { filled: args.field };
    }
    if (name === 'browser_search') {
      const hint = [await locator.getAttribute('type'), await locator.getAttribute('aria-label'), await locator.getAttribute('placeholder'), await locator.getAttribute('name')].join(' ');
      if (!/search|검색|찾기/i.test(hint) || typeof args.query !== 'string' || args.query.length > 500) throw new BrowserActionError('검색 칸에만 검색어를 입력할 수 있습니다. 본문·수신자는 검토된 원문을 사용합니다.');
      await locator.fill(args.query); await locator.press('Enter'); return { done: true };
    }
    if (name === 'browser_select') { await locator.selectOption(args.value); return { done: true }; }
    const label = [await locator.innerText().catch(() => ''), await locator.getAttribute('aria-label'), await locator.getAttribute('value')].join(' ').trim();
    if (isForbiddenAction(label)) throw new BrowserActionError('계정 변경·삭제·결제·로그아웃 버튼은 실행할 수 없습니다.');
    if (name === 'browser_click') {
      if (job.readOnly && isReadOnlyBlocked(label)) throw new BrowserActionError('사이트 조회 단계는 읽기 전용이라 저장·등록·수정·삭제 버튼을 누를 수 없습니다.');
      if (!job.readOnly && isFinalAction(label, { site: job.site })) throw new BrowserActionError('실제 발송·등록·업로드·저장처럼 되돌리기 어려운 버튼은 browser_submit으로 실행해 주세요.');
      const href = await locator.getAttribute('href');
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href) && !allowedFor(job, new URL(href, page.url()).toString())) throw new BrowserActionError('연결 서비스 밖의 링크는 열 수 없습니다.');
      await locator.click(); return { done: true };
    }
    if (name === 'browser_submit' && job.site) {
      const handle = await locator.elementHandle();
      for (const previous of job.submitted) {
        if (await handle.evaluate((element, before) => element === before, previous).catch(() => false)) throw new BrowserActionError('이미 누른 버튼입니다. 결과를 확인해 주세요.');
      }
      job.submitted.push(handle);
      job.committing = true; persist(job, { status: 'committing', submits: job.submitted.length });
      await locator.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return { submitted: true, instruction: '결과 화면을 확인하고, 업무가 끝났으면 확인한 내용을 summary에 적어 browser_finish를 호출하세요.' };
    }
    if (name === 'browser_submit') {
      if (!job.filled.has('body') || job.action === 'mail' && (!job.filled.has('recipients') || !job.filled.has('subject'))
        || job.action === 'post' && !job.filled.has('subject')) throw new BrowserActionError('검토된 수신자·제목·본문을 먼저 입력해 주세요.');
      // 보내기 직전에 편집기 본문이 정확히 한 번 있는지 확인한다(빈 메일·중복 본문 방지)
      if (job.editorBody && !job.committing) {
        const count = squash((await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.body?.innerText || '').catch(() => '')))).join('')).split(job.editorBody).length - 1;
        if (count === 0) { job.filled.delete('body'); throw new BrowserActionError('편집기에 본문이 없어 보내지 않았습니다. 화면을 다시 읽고 본문을 넣어 주세요.'); }
        if (count > 1) throw new BrowserActionError('편집기에 본문이 두 번 들어 있어 보내지 않았습니다. 작성 화면을 새로 열어 다시 입력해 주세요.');
      }
      // 첨부를 지정한 메일은 모든 파일을 첨부하고 화면의 첨부 목록에 이름이 보일 때만 보낸다
      if (job.action === 'mail' && job.files.length && !job.committing) {
        const missing = job.files.filter((f) => !job.attached.has(f.name));
        if (missing.length) throw new BrowserActionError(`지정된 첨부 파일을 모두 browser_attach로 첨부한 뒤 보내세요. 남은 파일: ${missing.map((f) => f.name).join(', ')}`);
        const shown = normalized(await textOnPage(page, job.provider)).toLowerCase();
        const unseen = job.files.filter((f) => { const stem = normalized(f.name.replace(/\.[^.]+$/, '')).toLowerCase(); return !shown.includes(normalized(f.name).toLowerCase()) && !shown.includes(stem.slice(0, 12)); });
        if (unseen.length) throw new BrowserActionError(`화면의 첨부 목록에서 파일을 확인하지 못했습니다: ${unseen.map((f) => f.name).join(', ')}. 업로드가 끝났는지 화면을 다시 읽고 확인한 뒤 보내세요.`);
      }
      if (!isFinalAction(label) && !(job.committing && isFinalConfirm(label))) throw new BrowserActionError('발송·발행·등록 또는 그 최종 확인 버튼을 선택해 주세요.');
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
  // 일반 웹사이트 업무: 연결 계정의 허용 도메인 안에서 직원이 지침대로 입력·첨부·제출하고 결과 증표를 남긴다.
  // 같은 대화에서 같은 계정·주소·지침·첨부 내용이면 다시 실행하지 않고, 결과가 불확실하면 대표 확인 전까지 멈춘다.
  const deliverWeb = async ({ scope, publication, instructions, files, evidenceDir, instructionKey, allowResend, retryUncertain, confirmExisting, execute, signal }) => {
    if (!publication.connection) throw new ConnectionRequired('일반 웹사이트 업무에 사용할 연결 계정을 지정해 주세요.');
    const site = store.find(publication.connection);
    if (!connectionAllowsUrl(site, publication.target)) throw new BrowserActionError('연결 계정의 허용 도메인 밖 주소입니다. 계정 연결의 허용 도메인을 확인해 주세요.');
    if (typeof instructions !== 'string' || !instructions.trim()) throw new BrowserActionError('일반 웹사이트 업무의 지침(무엇을 할지)이 비어 있습니다.');
    const attachments = [];
    for (const file of files) {
      let st;
      try { st = statSync(file.path); } catch { throw new BrowserActionError(`첨부 파일이 없습니다: ${file.name}`); }
      if (!st.isFile() || st.size > 50 * 1024 * 1024) throw new BrowserActionError(`첨부 파일은 50MB 이하 파일이어야 합니다: ${file.name}`);
      if (attachments.some((a) => a.name === file.name)) throw new BrowserActionError(`첨부 파일 이름이 겹칩니다: ${file.name}`);
      attachments.push({ name: file.name, path: realpathSync(file.path), hash: hash(readFileSync(file.path)) });
    }
    const identity = [scope, 'web', site.id, publication.target, publication.id];
    const file = recordPath(scope, hash(JSON.stringify(identity)).slice(0, 24)), previous = readPrivate(file);
    const contentHash = hash(JSON.stringify([instructions, attachments.map((a) => [a.name, a.hash])]));
    if (['committing', 'uncertain'].includes(previous.status) && confirmExisting && previous.contentHash === contentHash) {
      const confirmed = { ...previous, status: 'confirmed', confirmedBy: 'user', confirmedAt: new Date().toISOString() };
      writePrivate(file, confirmed); return confirmed;
    }
    if (previous.status === 'confirmed' && previous.contentHash === contentHash && (!allowResend || previous.instructionKey === instructionKey)) return previous;
    if (['committing', 'uncertain'].includes(previous.status) && !(allowResend && retryUncertain)) throw new BrowserActionError('직전 웹사이트 작업 결과가 불확실합니다. 사이트에서 결과를 확인한 뒤 "반영 확인" 또는 "미반영 확인, 다시 진행"으로 지시해 주세요.');
    return sessions.withSession(site.id, publication.target, signal, async (context) => {
      await ensureServer();
      signal.throwIfAborted();
      const record = { status: 'prepared', action: 'web', service: 'web', connection: site.id, contentHash, instructionKey, target: publication.target };
      const job = { ...publication, provider: site.provider, site, files: attachments, body: instructions, recipients: [], scope, videoIds: [], context,
        pageIndex: context.pages().length - 1, refs: new Map(), filled: new Set(), submitted: [], token: randomBytes(32).toString('hex'), record, file, evidenceDir, beforeCount: 0 };
      const permissionsFile = join(store.directory, 'capabilities', randomBytes(16).toString('hex') + '.json');
      writePrivate(permissionsFile, { url: origin + '/tools', token: job.token });
      persist(job); capabilities.set(job.token, job);
      const revoke = () => { capabilities.delete(job.token); rmSync(permissionsFile, { force: true }); };
      signal.addEventListener('abort', revoke, { once: true });
      try {
        const result = await execute({ url: origin + '/tools', token: job.token, permissionsFile });
        if (job.incomplete) throw new BrowserActionError(`웹사이트 작업을 끝내지 못했습니다. 직원 보고: ${job.incomplete}`);
        if (!job.confirmed) throw new BrowserActionError('일반 웹사이트 작업의 결과 증표가 없습니다. 완료로 처리하지 않습니다.');
        return { ...job.record, report: result };
      } catch (error) {
        if (job.confirmed) return job.record;
        if (job.incomplete) {
          persist(job, { status: 'incomplete' });
          throw error instanceof BrowserActionError ? error : new BrowserActionError(`웹사이트 작업을 끝내지 못했습니다. 직원 보고: ${job.incomplete}`);
        }
        persist(job, { status: job.committing ? 'uncertain' : 'prepared' });
        throw error;
      } finally { signal.removeEventListener('abort', revoke); revoke(); }
    });
  };
  // 사이트 조회 단계: 연결 계정의 허용 도메인 안에서 읽기 전용으로 화면을 조회하고, 직원이 결과를 단계 산출물 파일로 쓴다.
  // 공개 웹 조회: 계정 없는 임시 브라우저라 로그인한 내용이 없고, 웹 도구를 함께 써도 내부 자료가 섞이지 않는다
  const browsePublic = async ({ target, signal, execute, allowUrl }) => {
    if (!(allowUrl || isPublicWebUrl)(target)) throw new BrowserActionError('공개 웹 주소만 열 수 있습니다.');
    return sessions.withPublic(target, signal, async (context) => {
      await ensureServer();
      signal.throwIfAborted();
      const job = { id: 'public', action: 'browse', provider: 'web', site: { provider: 'web' }, publicWeb: true, allowUrl, connection: null, target, readOnly: true, files: [], body: '', recipients: [], videoIds: [], context,
        pageIndex: context.pages().length - 1, refs: new Map(), filled: new Set(), submitted: [], token: randomBytes(32).toString('hex'),
        record: { status: 'browsing' }, file: null, beforeCount: 0 };
      const permissionsFile = join(store.directory, 'capabilities', randomBytes(16).toString('hex') + '.json');
      writePrivate(permissionsFile, { url: origin + '/tools', token: job.token });
      capabilities.set(job.token, job);
      const revoke = () => { capabilities.delete(job.token); rmSync(permissionsFile, { force: true }); };
      signal.addEventListener('abort', revoke, { once: true });
      try { return await execute({ url: origin + '/tools', token: job.token, permissionsFile, write: true, publicWeb: true }); }
      finally { signal.removeEventListener('abort', revoke); revoke(); }
    }, allowUrl ? { allowUrl } : {});
  };
  const browse = async ({ connection, target, signal, execute }) => {
    if (!connection) throw new ConnectionRequired('사이트 조회에 사용할 연결 계정을 지정해 주세요.');
    const site = store.find(connection);
    if (!connectionAllowsUrl(site, target)) throw new BrowserActionError('연결 계정의 허용 도메인 밖 주소입니다. 계정 연결의 허용 도메인을 확인해 주세요.');
    return sessions.withSession(site.id, target, signal, async (context) => {
      await ensureServer();
      signal.throwIfAborted();
      const job = { id: 'browse', action: 'browse', provider: site.provider, site, connection: site.id, target, readOnly: true, files: [], body: '', recipients: [], videoIds: [], context,
        pageIndex: context.pages().length - 1, refs: new Map(), filled: new Set(), submitted: [], token: randomBytes(32).toString('hex'),
        record: { status: 'browsing' }, file: null, beforeCount: 0 };
      const permissionsFile = join(store.directory, 'capabilities', randomBytes(16).toString('hex') + '.json');
      writePrivate(permissionsFile, { url: origin + '/tools', token: job.token });
      capabilities.set(job.token, job);
      const revoke = () => { capabilities.delete(job.token); rmSync(permissionsFile, { force: true }); };
      signal.addEventListener('abort', revoke, { once: true });
      try { return await execute({ url: origin + '/tools', token: job.token, permissionsFile, write: true }); }
      finally { signal.removeEventListener('abort', revoke); revoke(); }
    });
  };
  return {
    browse,
    browsePublic,
    connections: () => store.list(),
    // 대표가 직접 로그인할 창을 먼저 띄우고 끝날 때까지 기다린다(비밀번호는 다루지 않는다). 없는 연결은 만든다
    async requestLogin({ connection = '', provider = '', target = '', signal, timeoutMs = 5 * 60 * 1000, pollMs = 1000 } = {}) {
      const list = store.list();
      const item = list.find((c) => c.id === connection) || (provider ? list.find((c) => c.provider === provider) : null)
        || store.create(provider ? { provider, label: '' } : { provider: 'web', label: '', startUrl: target, hosts: [] });
      await sessions.open(item.id);
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        signal?.throwIfAborted();
        const current = store.list().find((c) => c.id === item.id);
        // 로그인 창이 완전히 닫혀 프로필이 풀린 뒤에 이어 간다
        if (current?.status === 'connected' && !sessions.loginOpen?.(item.id)) return { status: 'connected', id: item.id };
        if (!current || current.status === 'disconnected') return { status: 'closed', id: item.id };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return { status: 'timeout', id: item.id };
    },
    videoHistory: (scope) => videos.excluded(scope),
    async deliver({ scope, publication, body, allowedActions, instructionKey, allowResend = false, retryUncertain = false, confirmExisting = false, schedule = null, execute, signal, files = [], evidenceDir = null }) {
      if (!allowedActions.includes(publication.action)) throw new BrowserActionError('대표가 이 업무에서 지시한 외부 발송·게시·댓글 작업만 실행할 수 있습니다.');
      if (publication.action === 'web') return deliverWeb({ scope, publication, instructions: body, files, evidenceDir, instructionKey, allowResend, retryUncertain, confirmExisting, execute, signal });
      const provider = serviceProvider(publication.service);
      const matching = store.list().filter((c) => c.provider === provider);
      const connection = publication.connection ? store.find(publication.connection) : matching.length === 1 ? store.find(matching[0].id) : null;
      if (!connection) throw new ConnectionRequired(matching.length ? '사용할 연결 계정을 지정해 주세요.' : '계정 연결에서 해당 서비스의 계정을 처음 한 번 연결해 주세요.');
      if (!provider || connection.provider !== provider || !allowed(provider, publication.target)) throw new BrowserActionError('연결 계정과 대상 서비스·주소가 일치하지 않습니다.');
      if (!body.trim()) throw new BrowserActionError('외부 작업의 본문이 비어 있습니다.');
      const recipients = publication.recipients || [];
      if (publication.action === 'mail' && (!recipients.length || recipients.some((email) => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)))) throw new BrowserActionError('메일 수신자를 확인해 주세요.');
      if ((publication.action === 'mail') !== (publication.service === 'naverworks_mail')) throw new BrowserActionError('메일 서비스와 작업 종류가 일치하지 않습니다.');
      // 메일 첨부: 실행기가 찾아 확정한 파일만 받는다. 실행 직전에 비밀 위치·크기·이름 중복을 다시 확인한다
      if (files.length && publication.action !== 'mail') throw new BrowserActionError('첨부 파일은 일반 웹사이트 업무와 메일에서만 쓸 수 있습니다.');
      const attachments = [];
      for (const file of files) {
        const reason = blockedReason(file.path, { root, home: homedir() });
        if (reason) throw new BrowserActionError(`첨부할 수 없는 파일입니다(${file.name}): ${reason}`);
        if (attachments.some((a) => a.name === file.name)) throw new BrowserActionError(`첨부 파일 이름이 겹칩니다: ${file.name}`);
        attachments.push({ name: file.name, path: realpathSync(file.path), hash: hash(readFileSync(file.path)) });
      }
      const identity = [scope, publication.action, publication.service, publication.target, recipients];
      const legacyFile = recordPath(scope, hash(JSON.stringify(identity)).slice(0, 24));
      const logical = hash(JSON.stringify(publication.action === 'post' ? [...identity, publication.id] : identity)).slice(0, 24);
      const proposed = recordPath(scope, logical);
      const file = !existsSync(proposed) && existsSync(legacyFile) ? legacyFile : proposed, previous = readPrivate(file);
      const videoOwner = basename(file);
      const videoIds = publication.action === 'post' ? youtubeVideoIds(publication.subject + '\n' + body) : [];
      // 섞인 예약의 영상이 아닌 글(kind:"info", 링크 없음)은 영상 링크 검사를 하지 않는다. 개수는 preparePublications가 막는다
      const infoPost = publication.kind === 'info' && !videoIds.length;
      if (schedule?.uniqueYoutube && publication.action === 'post' && !infoPost && (videoIds.length !== 1 || youtubeVideoIds(body).length !== 1)) throw new BrowserActionError('예약 영상 게시글 본문마다 원본 유튜브 링크를 1개 넣어 주세요.');
      // 첨부가 있으면 첨부 내용까지 같은 메일이어야 같은 발송으로 본다(첨부 없는 메일의 기존 기록은 그대로 맞음)
      const contentHash = hash(JSON.stringify(attachments.length ? [publication.subject, body, attachments.map((a) => [a.name, a.hash])] : [publication.subject, body]));
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
          files: attachments, attached: new Set(), refs: new Map(), filled: new Set(), submitted: [], token: randomBytes(32).toString('hex'), record, file, beforeCount: prefix ? before.split(prefix).length - 1 : 0 };
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
