// Aside(로그인한 사이트를 직접 다루는 AI 브라우저, https://aside.com) 연동.
// - 직원 엔진 'aside': `aside exec --json`으로 Aside 에이전트가 업무를 처리한다(대표가 Aside에 연결한 구독과 Aside 브라우저의 로그인 사용).
// - 결과 재확인·로그인 확인: `aside repl --json --file -`로 화면 글자만 읽는다. 에이전트·구독을 쓰지 않는다.
// 비밀번호·쿠키는 다루지 않는다. 로그인은 대표가 Aside 브라우저에서 직접 하고 Aside가 유지한다.
// 실측(2026-11-12, CLI 1.26.1111): repl 탭은 화면에 보이지 않지만 같은 프로필 로그인을 쓴다. 에이전트 작업 폴더는 ~/.aside/u/<번호>이고
// 기본 권한(Guard)에서는 그 밖의 파일을 읽지 못한다(blocked by policy). CLI를 끝내도 세션은 계속 돈다(세션 중지는 따로).
import * as child_process from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { findExecutable, killTree, resolveCommand, spawnCli } from './cli.mjs';

// 계획에서 Aside 브라우저(대표 로그인)를 가리키는 연결 값. 공개 웹 조회의 'public'과 같은 예약어다
export const ASIDE_CONNECTION = 'aside';
export const ASIDE_HEALTH_URL = 'http://127.0.0.1:21420/health';
export const ASIDE_DOCS = 'https://docs.aside.com/help/developers.md';
const REPL_TIMEOUT_MS = 130 * 1000;
const MARK = '__AIO__';

// 화면 글자 비교용: 실행기(browser-work의 normalized)와 같은 기준(NFKC, 공백·폭 없는 문자 제거)
const squashText = (s) => String(s || '').normalize('NFKC').replace(/[\s\u200B-\u200D\u2060]+/g, '');

export class AsideError extends Error {
  constructor(message, code = 'ASIDE') { super(message); this.code = code; }
}

// 직원의 엔진: 직원에 aside를 지정했으면 aside, 아니면 부서 엔진
export function agentEngine(agent, dept) {
  if (agent?.engine === 'aside' || dept?.engine === 'aside') return 'aside';
  return dept?.engine === 'codex' ? 'codex' : 'claude';
}
// Aside가 없을 때 대신 쓸 엔진(부서 엔진. 부서가 aside면 claude)
export function fallbackEngine(dept) { return dept?.engine === 'codex' ? 'codex' : 'claude'; }

// 실행 파일: ASIDE_BIN > PATH > 설치 스크립트 기본 위치(~/.local/bin/aside, PATH에 없을 수 있다)
export function resolveAside({ env = process.env, platform = process.platform, home = env.HOME || env.USERPROFILE || homedir() } = {}) {
  const resolved = resolveCommand('aside', 'ASIDE_BIN', { env, platform });
  if (resolved.prefixArgs.length || findExecutable(resolved.command, { env, platform })) return { ...resolved, found: true };
  const fallback = platform === 'win32' ? null : join(home, '.local', 'bin', 'aside');
  if (fallback && existsSync(fallback)) return { command: fallback, prefixArgs: [], shell: false, display: fallback, found: true };
  return { ...resolved, found: false };
}

export const asideInstalled = (options) => resolveAside(options).found;

// 에이전트 실행 인자. 지시문은 인자로 넘긴다(CLI가 표준 입력 지시를 받지 않는다). 시간 초과는 실행기가 따로 끊는다
export function asideExecArgs(prompt, { timeout = '60m', effort = null } = {}) {
  return ['exec', '--json', '--timeout', timeout, ...(effort ? ['--effort', effort] : []), prompt];
}

// `aside exec --json`의 마지막 JSON 줄: { session:{id}, outcome, answer, error }
export function parseExecOutput(stdout) {
  for (const line of String(stdout || '').split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { const data = JSON.parse(trimmed); if (data && typeof data === 'object' && 'outcome' in data) return data; } catch { /* 다음 줄 */ }
  }
  return null;
}

export function createAside({ env = process.env, platform = process.platform, home = env.HOME || env.USERPROFILE || homedir(), spawnImpl = child_process.spawn, fetchImpl = globalThis.fetch } = {}) {
  const command = () => resolveAside({ env, platform, home });
  // CLI 한 번 실행. 표준 입력을 넘기고 끝날 때까지 기다린다
  const run = (args, { input = null, timeoutMs = REPL_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
    const cmd = command();
    if (!cmd.found) { reject(new AsideError('Aside CLI를 찾지 못했습니다. Aside를 설치해 주세요.', 'ASIDE_MISSING')); return; }
    let child;
    try { child = spawnCli(cmd, args, { env, platform, spawnImpl }); }
    catch (error) { reject(new AsideError(`Aside를 실행하지 못했습니다: ${error.message}`)); return; }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { killTree(child, 'SIGTERM', { platform, spawnImpl }); reject(new AsideError('Aside 응답이 너무 늦습니다. 잠시 후 다시 시도해 주세요.')); }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(new AsideError(`Aside를 실행하지 못했습니다: ${error.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin?.on?.('error', () => {});
    child.stdin?.end(input ?? undefined);
  });

  // 화면 확인 코드 한 번 실행. 코드는 마지막에 console.log(MARK + JSON)으로 결과를 낸다
  const repl = async (code, { timeoutMs } = {}) => {
    const { stdout } = await run(['repl', '--json', '--file', '-'], { input: code, timeoutMs });
    let data;
    try { data = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).at(-1)); }
    catch { throw new AsideError('Aside 화면 확인 결과를 읽지 못했습니다. Aside 앱이 켜져 있는지 확인해 주세요.'); }
    if (data?.error && !data.run) throw new AsideError(`Aside 화면 확인 실패: ${String(data.error).split('\n')[0].slice(0, 300)}`);
    if (data?.run?.error) throw new AsideError(`Aside 화면 확인 실패: ${String(data.run.error).split('\n')[0].slice(0, 300)}`);
    const text = (data?.run?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
    const marked = text.split('\n').reverse().find((line) => line.startsWith(MARK));
    if (!marked) throw new AsideError('Aside 화면 확인 결과가 비어 있습니다.');
    return JSON.parse(marked.slice(MARK.length));
  };

  // 실행 중인지(앱을 띄우지 않고 확인). 꺼져 있어도 CLI가 필요할 때 켠다
  const health = async () => {
    try {
      const res = await fetchImpl(ASIDE_HEALTH_URL, { signal: AbortSignal.timeout(1500) });
      const data = await res.json().catch(() => ({}));
      return { running: res.ok, ready: Boolean(data.ready) };
    } catch { return { running: false, ready: false }; }
  };

  // 설치·실행·로그인 상태. 이메일은 싣지 않는다. 앱이 꺼져 있으면 계정 확인을 하지 않는다(확인만으로 앱을 띄우지 않기 위해)
  const status = async () => {
    const cmd = command();
    if (!cmd.found) return { installed: false, running: false, signedIn: null };
    const { running, ready } = await health();
    let signedIn = null;
    if (running) {
      try {
        const { stdout } = await run(['account', 'status'], { timeoutMs: 15000 });
        const line = String(stdout).split('\n').find((l) => /^\s*\*/.test(l)) || String(stdout);
        signedIn = /signed in/i.test(line) && !/signed out/i.test(line);
      } catch { signedIn = null; }
    }
    return { installed: true, running, ready, signedIn };
  };

  // 화면 글자 읽기(숨은 탭). hosts: 읽을 프레임의 도메인. waitFor: 이 글자(공백 제외)가 보일 때까지 기다림. settleMs: 화면이 멈출 때까지 기다리는 최대 시간
  const readPage = (url, { hosts = [], waitFor = [], settleMs = 4000 } = {}) => repl(`
const AIO = ${JSON.stringify({ url, hosts, waitFor: waitFor.map(squashText).filter(Boolean), settleMs })};
const aioTab = await openTab(AIO.url);
try {
  const allowed = (value) => { if (value === 'about:blank') return true; try { const h = new URL(value).hostname; return !AIO.hosts.length || AIO.hosts.some((x) => h === x || h.endsWith('.' + x)); } catch { return false; } };
  const read = async () => { const parts = []; for (const f of aioTab.frames()) { if (!allowed(f.url())) continue; parts.push(await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')); } return parts.join('\\n'); };
  ${PAGE_STATE}
  const until = Date.now() + AIO.settleMs;
  let text = await read(), last = '', stable = 0;
  while (Date.now() < until) {
    const squashed = text.normalize('NFKC').replace(/[\\s\\u200B-\\u200D\\u2060]+/g, '');
    if (AIO.waitFor.length && AIO.waitFor.some((s) => squashed.includes(s))) break;
    stable = text === last ? stable + 1 : 0;
    if (!AIO.waitFor.length && stable >= 2) break;
    last = text; await sleep(500); text = await read();
  }
  const state = await pageState(aioTab);
  console.log(${JSON.stringify(MARK)} + JSON.stringify({ url: aioTab.url(), text: text.slice(0, 400000), ...state }));
} finally { await closeTab(aioTab); }
`);

  // 링크 목록 읽기(숨은 탭): 글자에 match가 들어간 링크의 { text, href(절대 주소) }. ready 글자가 보이거나 settleMs가 지날 때까지 기다린다
  const links = (url, { match = '', ready = [], settleMs = 15000 } = {}) => repl(`
const AIO = ${JSON.stringify({ url, match: String(match), ready: ready.map((s) => String(s).replace(/\s+/g, '')), settleMs })};
const aioTab = await openTab(AIO.url);
try {
  const read = () => aioTab.evaluate((m) => [...document.querySelectorAll('a[href]')].map((a) => ({ text: (a.textContent || '').trim().slice(0, 300), href: a.href })).filter((a) => !m || a.text.includes(m)), AIO.match);
  const until = Date.now() + AIO.settleMs;
  let found = await read();
  while (Date.now() < until) {
    const body = (await aioTab.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')).replace(/\\s+/g, '');
    if (found.length || AIO.ready.some((s) => body.includes(s))) break;
    await sleep(500); found = await read();
  }
  ${PAGE_STATE}
  const state = await pageState(aioTab);
  console.log(${JSON.stringify(MARK)} + JSON.stringify({ url: aioTab.url(), links: found.slice(0, 200), ...state }));
} finally { await closeTab(aioTab); }
`);

  // 로그인 확인(숨은 탭): { status: 'ok' | 'needs_login' | 'protected', url }
  const checkLogin = async (url) => {
    const page = await repl(`
const aioTab = await openTab(${JSON.stringify(url)});
try {
  ${PAGE_STATE}
  await sleep(1200);
  const state = await pageState(aioTab);
  console.log(${JSON.stringify(MARK)} + JSON.stringify({ url: aioTab.url(), ...state }));
} finally { await closeTab(aioTab); }
`);
    return { status: page.protected ? 'protected' : page.needsLogin ? 'needs_login' : 'ok', url: page.url };
  };

  // 대표가 볼 수 있게 Aside 창의 현재 탭에 주소를 연다(로그인 안내). 맥은 창을 앞으로 가져온다
  const openVisible = async (url) => {
    if (platform === 'darwin') { try { const c = spawnImpl('open', ['-a', 'Aside'], { stdio: 'ignore' }); c.on?.('error', () => {}); } catch { /* 창을 못 띄워도 계속 */ } }
    try {
      const page = await repl(`
const aioView = await attachActiveBrowserTab();
await aioView.goto(${JSON.stringify(url)});
console.log(${JSON.stringify(MARK)} + JSON.stringify({ url: aioView.url() }));
`);
      return { opened: true, url: page.url };
    } catch (error) {
      return { opened: false, reason: error.message };
    }
  };

  // CLI로 시작한 세션 중 아직 도는 것을 멈춘다(실행 중지·시간 초과 뒤 Aside 쪽 작업이 계속되지 않게)
  const stopSessions = async (sinceIso) => {
    let list = [];
    try { list = JSON.parse((await run(['session', 'list', '--json'], { timeoutMs: 15000 })).stdout).sessions || []; } catch { return 0; }
    const since = Date.parse(sinceIso || 0) - 5000;
    const running = list.filter((s) => s?.trigger?.source === 'cli' && !['idle', 'stopped', 'completed', 'failed'].includes(s.status) && Date.parse(s.createdAt) >= since);
    for (const s of running) await run(['session', 'stop', s.id], { timeoutMs: 15000 }).catch(() => {});
    return running.length;
  };

  // 첨부 파일을 에이전트가 읽을 수 있는 Aside 작업 폴더로 잠시 복사한다. 업무가 끝나면 cleanup으로 지운다
  const stageFiles = (files = []) => {
    if (!files.length) return { files: [], cleanup: () => {} };
    const base = join(env.ASIDE_HOME || join(home, '.aside'), 'u', '0');
    if (!existsSync(base)) throw new AsideError('Aside 작업 폴더(~/.aside/u/0)를 찾지 못했습니다. Aside 앱에서 한 번 로그인한 뒤 다시 시도해 주세요.');
    const dir = join(base, 'ai-office', randomBytes(8).toString('hex'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const staged = files.map((f) => { const target = join(dir, basename(f.name)); copyFileSync(f.path, target); return { name: f.name, path: target }; });
    return { files: staged, dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 지우기 실패는 무시 */ } } };
  };

  return { command, installed: () => command().found, run, repl, health, status, readPage, links, checkLogin, openVisible, stopSessions, stageFiles };
}

// 화면 상태 판정(Aside 탭 안에서 실행). lib/browser-session.mjs의 loginPage·requiresLogin·accountProtected와 같은 기준이다
const PAGE_STATE = `
const pageState = async (tab) => {
  const u = (() => { try { return new URL(tab.url()); } catch { return null; } })();
  const loginUrl = !u || /^(nid\\.naver\\.com|accounts\\.kakao\\.com|auth\\.)/.test(u.hostname) || /\\/(?:login|signin|authorize|oauth|captcha|challenge|nidlogin)(?:[/.?]|$)/i.test(u.pathname);
  let needsLogin = loginUrl, protectedText = false;
  for (const f of tab.frames()) {
    const found = await f.evaluate(() => {
      const visible = (el) => el.getClientRects().length > 0;
      const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
      const loggedOut = [...document.querySelectorAll('a[href*="nid.naver.com/nidlogin.login"], a[href*="accounts.kakao.com/login"]')].some(visible);
      return { password, loggedOut, text: document.body ? document.body.innerText.slice(0, 20000) : '' };
    }).catch(() => ({ password: false, loggedOut: false, text: '' }));
    if (found.password || found.loggedOut) needsLogin = true;
    if (loginUrl && /보호\\s*조치|보호\\s*모드|이용이\\s*제한|비정상적인\\s*(?:활동|접근|로그인)|부정\\s*이용/.test(found.text)) protectedText = true;
  }
  return { needsLogin, protected: protectedText };
};
`;

// ---- 브라우저 업무 권장 안내 ----
const WORK_LABEL = { mail: '메일 발송', post: '글 게시', comment: '댓글', web: '웹사이트 작업', browse: '사이트 조회' };
// 지난 업무 계획에서 로그인한 사이트 업무(메일·글·댓글·웹사이트 작업·사이트 조회)를 맡았던 직원과 그 일
export function browserWorkHistory(root, { limit = 200 } = {}) {
  const dir = join(root, '.office', 'orchestrations');
  const found = new Map();
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).slice(-limit); } catch { return found; }
  const add = (agent, work) => { if (typeof agent !== 'string' || !agent) return; if (!found.has(agent)) found.set(agent, new Set()); found.get(agent).add(work); };
  for (const name of files) {
    let plan;
    try { plan = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.plan; } catch { continue; }
    for (const p of plan?.publications || []) if (WORK_LABEL[p?.action]) add(p.agent, WORK_LABEL[p.action]);
    for (const s of plan?.stages || []) if (typeof s?.connection === 'string' && s.connection.trim() && s.connection !== 'public') add(s.agent, WORK_LABEL.browse);
  }
  return found;
}

// 대시보드·doctor·터미널 AI가 대표에게 보여 줄 권장 안내. Aside가 있으면 브라우저 업무 직원의 엔진 변경을, 없으면 설치를 권한다
export function asideAdvice({ org, root, installed }) {
  const deptOf = (a) => org.departments.find((d) => d.id === a.department);
  const active = org.roster.filter((a) => a.active !== false && deptOf(a)?.active !== false);
  const asideStaff = active.filter((a) => agentEngine(a, deptOf(a)) === 'aside');
  const history = browserWorkHistory(root);
  const candidates = active.filter((a) => history.has(a.id) && agentEngine(a, deptOf(a)) !== 'aside')
    .map((a) => ({ id: a.id, name: a.name, department: deptOf(a)?.name || a.department, work: [...history.get(a.id)] }));
  const who = candidates.map((c) => `${c.department} ${c.name}(${c.work.join('·')})`).join(', ');
  if (!installed) {
    return { level: asideStaff.length || candidates.length ? 'warn' : 'info', installed: false, candidates, asideStaff: asideStaff.map((a) => a.id),
      message: asideStaff.length
        ? `Aside 엔진으로 지정한 직원이 있지만 Aside가 설치돼 있지 않아 기존 브라우저(Playwright)로 실행합니다. 가이드의 "Aside 설치·세팅"을 따라 설치하세요.`
        : `브라우저 업무(메일·카페·블로그·사이트 조회)는 Aside 직원을 권장합니다. 네이버 보호 조치를 줄이고 대표의 Aside 로그인을 그대로 씁니다. 가이드의 "Aside 설치·세팅"을 따라 설치하세요.${who ? ` 브라우저 업무를 맡았던 직원: ${who}.` : ''}` };
  }
  if (candidates.length) return { level: 'warn', installed: true, candidates, asideStaff: asideStaff.map((a) => a.id),
    message: `현재 브라우저 업무를 맡았던 직원이 있습니다: ${who}. 이 직원들은 엔진을 Aside로 바꾸길 권장드립니다(대시보드 → 직원 편집 → 엔진: Aside).` };
  if (!asideStaff.length) return { level: 'info', installed: true, candidates, asideStaff: [],
    message: 'Aside가 설치돼 있습니다. 메일 발송·카페 글·사이트 조회를 맡길 직원의 엔진을 Aside로 바꾸길 권장드립니다(대시보드 → 직원 편집 → 엔진: Aside).' };
  return { level: 'ok', installed: true, candidates, asideStaff: asideStaff.map((a) => a.id), message: `Aside 직원 ${asideStaff.length}명이 브라우저 업무를 맡습니다.` };
}

// ---- 외부 작업 지시문 ----
const PUBLISH_LABEL = { mail: '메일 발송', post: '글 게시', comment: '댓글 등록', web: '웹사이트 작업' };
// Aside 직원의 외부 작업 지시: 검토된 원문을 그대로 넣고 한 번만 실행하게 한다. 결과는 실행기가 화면을 다시 읽어 대조한다
export const asidePublishPrompt = ({ publication, body, web = publication.action === 'web', files = [] }) => [
  web ? '대표가 이번 업무에서 지시한 웹사이트 작업을 Aside 브라우저(대표 로그인)로 실행합니다. 아래 지침대로만 진행하고 지침에 없는 변경은 하지 마세요.'
    : '대표가 이번 업무에서 지시하고 비서실장이 검토한 외부 작업 1건을 Aside 브라우저(대표 로그인)로 실행합니다. 아래 원문과 대상을 바꾸지 마세요.',
  `이번 작업 한 건: ${JSON.stringify({ 종류: PUBLISH_LABEL[publication.action] || publication.action, 대상: publication.target || (publication.service === 'naverworks_mail' ? 'https://mail.worksmobile.com/' : ''), ...(publication.recipients?.length ? { 받는사람: publication.recipients } : {}), ...(publication.subject ? { 제목: publication.subject } : {}), ...(publication.targetTitle ? { 대상글제목: publication.targetTitle } : {}), ...(publication.targetAuthor ? { 대상글작성자: publication.targetAuthor } : {}) })}`,
  web ? `지침:\n${body}` : `본문: 아래 <<<본문 과 본문>>> 사이 전체를 한 글자도 바꾸지 말고 그대로 넣으세요. 편집기에 서명 등 기존 내용이 있으면 지우지 말고 그 앞에 넣습니다. 유튜브·지도 링크 줄은 붙여넣어 카드가 생기게 하세요.\n<<<본문\n${body}\n본문>>>`,
  files.length ? `첨부할 파일(이 경로의 파일을 파일 첨부로 올리고, 화면의 첨부 목록에 이름이 모두 보인 뒤에 보내세요. 붙이지 못하면 보내지 말고 needs_decision): ${files.map((f) => f.path).join(', ')}` : '',
  publication.action === 'comment' ? `댓글은 대상 글의 댓글 입력칸에 넣습니다.${publication.targetTitle || publication.targetAuthor ? ' 화면의 글 제목·작성자가 위 대상 글과 다르면 등록하지 말고 needs_decision으로 보고하세요.' : ''}` : '',
  '발송·등록·저장 버튼은 정확히 한 번만 누릅니다. 결과가 불확실하면 다시 누르지 말고 needs_decision으로 보고하세요. 다른 메일·글·설정은 열어 고치거나 지우지 않습니다. 삭제·결제·계정 변경은 하지 않습니다. 로그인 화면·추가 인증·보호 조치가 나오면 입력하지 말고 needs_decision으로 보고하세요.',
  '사용자가 볼 수 있게 보이는 탭에서 작업하세요. 보고·질문은 한국어로 씁니다.',
  '마지막 응답은 코드 블록 없이 JSON 하나입니다: {"status":"done" 또는 "needs_decision","summary":"확인한 결과","resultUrl":"게시된 글·결과 화면 주소","completed":true 또는 false,"submitted":발송·등록 버튼을 눌렀으면 true,"question":"needs_decision일 때 질문"}. 글을 올렸으면 게시된 글 주소를 resultUrl에 꼭 넣으세요.',
].filter(Boolean).join('\n\n');
