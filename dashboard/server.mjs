// AI Office 대시보드 HTTP + SSE 서버. 기본 127.0.0.1:4777
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ID_PATTERN, MAX_COMPANY_RULES, exportOrg, importOrg, loadCompanyRules, loadOrg, loadPresets, mutateOrg, saveCompanyRules, slugifyId, validateOrg } from '../lib/org.mjs';
import { quickToolCheck } from '../lib/doctor.mjs';
import { WORKSPACE_SOURCE_LABEL, WorkspaceError, kstDate, legacyItems, programRoot, resolveWorkspace, saveLocalWorkspace } from '../lib/paths.mjs';
import { ensureWorkspace, isCompatRoot } from '../lib/workspace.mjs';
import { acquireServerLock } from '../lib/server-lock.mjs';
import { appendEvent, readEvents, redact } from '../lib/events.mjs';
import { previewAgentFile } from '../lib/sync.mjs';
import { isOffplanCall } from '../lib/flow.mjs';
import { buildOrgMap } from '../lib/orgmap.mjs';
import { compactPlan, isTaskId } from '../lib/plan.mjs';
import { loadTasks as loadTaskList, updateTask } from '../lib/tasks.mjs';
import { createRunner } from './runner.mjs';
import { buildState } from './state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 1024 * 1024;
// 회사 구성 가져오기는 내보낸 파일 전체(지침 포함)를 받으므로 한도를 따로 둔다. 내보내기에는 크기 제한이 없어 1MB로는 큰 회사가 왕복되지 않는다
const IMPORT_BODY_LIMIT = 8 * 1024 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const BROADCAST_DEBOUNCE_MS = 300;
const PING_MS = 15_000;
const POLL_MS = 1000;
const RECOMPUTE_MS = 5000; // 시간 경과(90초 경계 등)로 바뀌는 상태를 반영하기 위한 주기
const KEEP_EVENTS_MS = 36 * 60 * 60 * 1000; // 오늘(KST) 집계와 미종료 시작 추적에 충분한 보관 기간
const MAX_PROMPT = 20_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const DEPT_FIELDS = ['id', 'name', 'en', 'color', 'engine', 'tools', 'model', 'summary', 'active', 'permission', 'order', 'instructions', 'codexModel', 'codexEffort', 'capabilities', 'handoffs'];
// 산출물 미리보기·목록 제한
const PREVIEW_LIMIT = 5 * 1024 * 1024;
const MAX_OUTPUT_FILES = 2000;
const MAX_OUTPUT_DEPTH = 6;
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.log', '.yaml', '.yml', '.xml', '.js', '.mjs', '.cjs', '.ts', '.py', '.sql', '.sh', '.css', '.toml', '.ini']);
const HTML_EXTS = new Set(['.html', '.htm']);
// html 미리보기 응답: 스크립트·외부 요청을 막는다(sandbox = 고유 출처·스크립트 비허용)
export const HTML_PREVIEW_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";
// 대시보드 화면 자체의 CSP. 스크립트는 같은 출처 파일만(인라인·eval 금지), 산출물 html 미리보기는 blob: iframe만 허용한다.
// 생성 HTML의 style 속성(부서색 변수) 때문에 style-src에 'unsafe-inline'을 둔다
export const DASHBOARD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NO_DESCRIPTION_WARNING = '비서실장이 배정 기준으로 쓸 설명이 없습니다. 담당 업무나 호출 설명을 채워 주세요.';
const AGENT_FIELDS = ['id', 'name', 'department', 'title', 'lead', 'specialty', 'description', 'instructions', 'active', 'model', 'rank', 'thoughts', 'role'];
const AUTH_COOKIE = 'office_auth';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

// 부분 수정: null이나 빈 문자열은 그 필드를 지운다(기본값으로 되돌림)
function applyPatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete target[k];
    else target[k] = v;
  }
  return target;
}

// 직원 응답에 붙이는 경고(저장은 허용). changeOrg가 붙인 sync 경고와 합친다
function withWarnings(agent) {
  const warnings = [...(agent.warnings ?? [])];
  if (!String(agent.description ?? '').trim() && !String(agent.specialty ?? '').trim()) warnings.push(NO_DESCRIPTION_WARNING);
  return warnings.length ? { ...agent, warnings } : agent;
}

// sync가 덮어쓰지 못한 파일(생성 표식 없는 사용자 파일과 이름이 겹침) → 화면에 보여줄 경고
function syncWarnings(sync) {
  const warnings = (sync?.conflicts ?? []).map((rel) =>
    `${rel} 파일은 직접 만든 파일(생성 표식 없음)이라 덮어쓰지 않았습니다. 이 직원의 지침이 반영되지 않으니 파일을 옮기거나 지운 뒤 다시 저장해 주세요.`);
  for (const e of sync?.errors ?? []) warnings.push(`에이전트 파일 생성 오류: ${e}`);
  return warnings;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, `요청 본문은 ${limit / (1024 * 1024)}MB 이하여야 합니다.`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolveBody({});
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return reject(new HttpError(400, '요청 본문이 올바른 JSON이 아닙니다.'));
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return reject(new HttpError(400, '요청 본문은 JSON 객체여야 합니다.'));
      }
      resolveBody(data);
    });
    req.on('error', reject);
  });
}

function readTail(file, maxBytes) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function hostWithPort(host, port) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
}

// 이 서버로 인정할 Host 값 목록. DNS 리바인딩으로 토큰이 담긴 index.html을 빼가지 못하게 한다.
function allowedHosts(host, port) {
  const names = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!isLoopback(host)) names.add(host);
  if (host === '0.0.0.0' || host === '::') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list ?? []) names.add(addr.address);
    }
    names.add(os.hostname());
  }
  return new Set([...names].map((h) => hostWithPort(h, port).toLowerCase()));
}

function tokenMatches(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function kebab(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 산출물 파일 종류: text(미리보기) / html(sandbox 미리보기) / binary(다운로드)
function outputKind(name) {
  const ext = extname(name).toLowerCase();
  if (HTML_EXTS.has(ext)) return 'html';
  return TEXT_EXTS.has(ext) ? 'text' : 'binary';
}

// Content-Disposition 파일 이름: ASCII 대체 이름 + RFC 5987 UTF-8 이름(한글 파일명)
function attachmentHeader(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// "폴더 열기" 명령(인자 배열, 셸 없음): macOS open, Windows explorer, 그 밖은 xdg-open
export function openFolderCommand(dir, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [dir] };
  if (platform === 'win32') return { command: 'explorer', args: [dir] };
  return { command: 'xdg-open', args: [dir] };
}

function defaultOpenFolder(dir) {
  const { command, args } = openFolderCommand(dir);
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// /api/tasks/<날짜>/<slug>/<동작> 또는 /api/tasks/<날짜%2Fslug>/<동작> → 업무 id. 형식이 틀리면 null
function taskIdFromParts(parts, start, tail) {
  const n = parts.length - start - tail;
  const id = n === 1 ? parts[start] : n === 2 ? `${parts[start]}/${parts[start + 1]}` : null;
  return isTaskId(id) ? id : null;
}

function findRolePreset(presets, deptId, key) {
  const depts = presets.departments ?? [];
  const own = depts.find((d) => d.id === deptId)?.roles?.find((r) => r.key === key);
  if (own) return own;
  for (const d of depts) {
    const role = d.roles?.find((r) => r.key === key);
    if (role) return role;
  }
  return null;
}

// outputs/<날짜>/<slug> 대상 경로 검증. 레포 밖이나 outputs 밖은 거부한다.
// 심볼릭 링크가 outputs 밖을 가리키는 경우도 막기 위해 실제 경로(realpath)로 판정한다.
function resolveReviewTarget(root, target) {
  if (typeof target !== 'string' || !target.trim()) throw new HttpError(400, 'target(검토 대상 경로)이 필요합니다.');
  const outside = new HttpError(400, '검토 대상은 outputs/ 아래 폴더여야 합니다.');
  const outputs = resolve(root, 'outputs');
  const abs = resolve(root, target);
  const lexical = relative(outputs, abs);
  if (!lexical || lexical.startsWith('..') || isAbsolute(lexical)) throw outside;
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new HttpError(404, `검토 대상 폴더가 없습니다: ${target}`);
  const real = relative(realpathSync(outputs), realpathSync(abs));
  if (!real || real.startsWith('..') || isAbsolute(real)) throw outside;
  return abs;
}

/**
 * 서버를 띄운다. 테스트에서는 port 0과 임시 root(작업 공간)·publicDir를 쓴다.
 * root를 주지 않으면 작업 공간을 결정한다(AI_OFFICE_WORKSPACE > .office-local.json > 호환 모드 > ~/AIOffice).
 * @returns {Promise<{server, url, token, port, close: () => Promise<void>}>}
 */
export async function startServer({
  root = null,
  workspaceSource = null, // 작업 공간을 정한 근거(회사 설정 표시용). root를 주지 않으면 resolveWorkspace가 정한다
  program = programRoot(), // 프로그램 레포(테스트에서 바꿔 넣는다). 예전 데이터 확인·호환 모드 판정에 쓴다
  port = 4777,
  host = '127.0.0.1',
  demo = false,
  publicDir = join(HERE, 'public'),
  quiet = false,
  env = process.env, // 시작 때 빠른 점검(claude·codex 설치 여부)에 쓰는 환경. 테스트에서 CLAUDE_BIN/CODEX_BIN을 바꿔 넣는다
  openFolder = defaultOpenFolder, // "폴더 열기" 실행 함수(테스트에서 실제 탐색기를 띄우지 않도록 바꿔 넣는다)
} = {}) {
  if (!root) ({ path: root, source: workspaceSource } = resolveWorkspace({ env, program }));
  root = resolve(root);
  publicDir = resolve(publicDir);
  // 호환 모드: 예전 데이터가 프로그램 레포 안에 있어 레포를 그대로 데이터 위치로 쓴다(배너로 이전을 권한다)
  const compat = isCompatRoot(root, program);
  const legacyPending = legacyItems(program).length > 0;
  if (!workspaceSource) workspaceSource = compat ? 'compat' : 'arg';
  // 작업 공간이 없으면 만들고 생성물(수칙·설정·훅·스킬·스크립트 연결)과 에이전트 파일을 맞춘다(빈 회사로 시작)
  if (!demo && !compat) {
    try {
      const init = ensureWorkspace(root, { program });
      for (const rel of init.workspace.conflicts) {
        if (!quiet) console.error(`[ai-office] ${rel}: 직접 만들거나 고친 파일이라 덮어쓰지 않았습니다(작업 공간 생성물).`);
      }
      if (init.error && !quiet) console.error(`[ai-office] 에이전트 파일을 맞추지 못했습니다: ${init.error.message}`);
    } catch (err) {
      throw new Error(`작업 공간(${root})을 준비하지 못했습니다: ${err.message}`);
    }
  }
  // 루프백이 아닌 주소에 바인딩하면 index.html을 받을 수 있는 기기 누구나 토큰을 얻게 된다.
  // 그래서 원격 바인딩에서는 시작 때 출력하는 접속 주소(?key=)로 들어온 브라우저에만 HttpOnly 쿠키를 주고, 쿠키가 없으면 모든 요청을 거부한다.
  const remote = !isLoopback(host);
  const officePath = join(root, '.office');
  mkdirSync(officePath, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const eventsFile = join(officePath, demo ? 'demo-events.jsonl' : 'events.jsonl');
  const demoOrgFile = join(officePath, 'demo-org.json');
  const tasksFile = join(officePath, 'tasks.json');
  const orgFiles = [join(root, 'org', 'departments.json'), join(root, 'org', 'roster.json'), join(root, 'org', 'presets.json'), join(root, 'org', 'company.md'), demoOrgFile];

  // ---- 메모리 상태 ----
  let events = [];
  let eventsOffset = 0;
  let org = { departments: [], roster: [] };
  let presets = { departments: [] };
  let tasks = [];
  // 업무 id → 계획표 요약. planFiles: outputs/<업무>/plan.json(표시용), planEvents: 최신 plan.set 이벤트(검사 통과본)
  let planFiles = new Map();
  const planEvents = new Map();
  const offplanSeen = new Set(); // 이미 남긴 flow.offplan 경고(원 이벤트 기준, 중복 방지)
  let orgMtimes = '';
  let tasksMtime = -1;
  // 시작 때 빠른 점검 결과. 점검이 끝나기 전에는 installed: null(모름)
  let tools = { claude: { installed: null }, codex: { installed: null } };
  const sseClients = new Set();
  let lastSent = '';
  let broadcastTimer = null;
  let simulation = null;

  function warn(message, err) {
    if (!quiet) console.error(`[ai-office] ${message}${err ? `: ${err.message}` : ''}`);
  }

  function loadOrgState() {
    try {
      if (demo) {
        // 시뮬레이터가 실제로 쓰는 조직(정본이 비어 있으면 demo-org.json의 가상 조직)을 그대로 보여준다.
        const data = simulation?.org ?? readJsonSafe(demoOrgFile, null);
        org = data && Array.isArray(data.departments) && Array.isArray(data.roster) ? data : loadOrg(root);
      } else {
        org = loadOrg(root);
      }
    } catch (err) {
      warn('조직 정본을 읽지 못했습니다', err);
    }
    try {
      presets = loadPresets(root);
    } catch (err) {
      warn('프리셋을 읽지 못했습니다', err);
    }
  }

  // tasks.json + 산출물 폴더의 report.md / reviews/*.md 존재 여부
  // 데모 모드에서는 실제 업무를 섞지 않고 데모 이벤트의 task.start만 쓴다.
  function loadTasks() {
    if (demo) return;
    const raw = readJsonSafe(tasksFile, []);
    const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
    const plans = new Map();
    for (const t of list) {
      if (!t || !isTaskId(t.id)) continue;
      const plan = readJsonSafe(join(root, 'outputs', ...t.id.split('/'), 'plan.json'), null);
      if (plan && typeof plan === 'object' && Array.isArray(plan.stages)) {
        try { plans.set(t.id, compactPlan(plan, { taskId: t.id, root })); } catch { /* 형식이 깨진 계획표는 표시하지 않는다 */ }
      }
    }
    planFiles = plans;
    tasks = list
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => {
        const dir = resolve(root, 'outputs', t.id);
        if (!dir.startsWith(resolve(root, 'outputs') + sep)) return { ...t, hasReport: false, reviewFiles: [] };
        let reviewFiles = [];
        try {
          reviewFiles = readdirSync(join(dir, 'reviews')).filter((f) => f.endsWith('.md'));
        } catch {
          /* 리뷰 폴더 없음 */
        }
        return { ...t, hasReport: existsSync(join(dir, 'report.md')), reviewFiles };
      });
  }

  function pruneEvents() {
    if (events.length <= 200) return;
    const cutoff = Date.now() - KEEP_EVENTS_MS;
    const keepFrom = events.length - 200;
    events = events.filter((ev, i) => i >= keepFrom || !(Date.parse(ev.ts) < cutoff));
  }

  // events.jsonl tail: 증분만 읽는다. 파일이 줄어들면 처음부터 다시 읽는다.
  function tailEvents() {
    let result;
    try {
      result = readEvents(eventsFile, eventsOffset);
    } catch (err) {
      warn('이벤트 파일을 읽지 못했습니다', err);
      return;
    }
    if (result.offset < eventsOffset) events = [];
    eventsOffset = result.offset;
    if (result.events.length) {
      events.push(...result.events);
      pruneEvents();
      trackPlans(result.events);
      if (result.events.some((ev) => ['task.start', 'task.update', 'review.end', 'plan.set', 'flow.deliver'].includes(ev.kind))) loadTasks();
      scheduleBroadcast();
    }
  }

  // plan.set 이벤트를 기억하고, 계획표에 없는 직원 호출은 flow.offplan 경고 이벤트로 남긴다(데모 제외)
  function trackPlans(batch) {
    for (const ev of batch) {
      if (ev && ev.kind === 'flow.offplan' && typeof ev.ref === 'string') offplanSeen.add(ev.ref);
    }
    for (const ev of batch) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.kind === 'plan.set' && isTaskId(ev.task) && ev.plan && Array.isArray(ev.plan.stages)) {
        planEvents.set(ev.task, ev.plan);
        continue;
      }
      if (demo || !ev.task || !planEvents.has(ev.task) || !isOffplanCall(ev, planEvents.get(ev.task))) continue;
      const ref = `${ev.ts}|${ev.instance ?? ''}|${ev.target ?? ev.summary ?? ''}`;
      if (offplanSeen.has(ref)) continue;
      offplanSeen.add(ref);
      const target = typeof ev.target === 'string' ? ev.target : String(ev.summary ?? '').split(':')[0];
      try {
        appendEvent(root, { engine: 'claude', session: 'office-server', instance: 'office-server', kind: 'flow.offplan', task: ev.task, target, ref, summary: redact(`계획에 없는 직원 호출: ${target}`) });
      } catch (err) {
        warn('계획 밖 호출 경고를 남기지 못했습니다', err);
      }
    }
  }

  const currentPlans = () => new Map([...planFiles, ...planEvents]);

  function pollFiles() {
    tailEvents();
    const m = orgFiles.map(mtimeOf).join(',');
    if (m !== orgMtimes) {
      orgMtimes = m;
      loadOrgState();
      scheduleBroadcast();
    }
    const t = mtimeOf(tasksFile);
    if (t !== tasksMtime) {
      tasksMtime = t;
      loadTasks();
      scheduleBroadcast();
    }
  }

  const runner = demo ? null : createRunner({ root, onChange: () => scheduleBroadcast() });

  const allRuns = () => (runner ? runner.list() : []);

  function currentState() {
    return {
      ...buildState({ org, events, runs: allRuns(), tasks, plans: currentPlans(), now: Date.now(), demo }),
      presets,
      demo,
      tools,
      // 경로 값은 토큰이 필요한 /api/company에서만 준다(상태는 토큰 없이 읽힌다)
      workspace: { compat, legacyPending },
    };
  }

  function broadcast() {
    broadcastTimer = null;
    if (!sseClients.size) return;
    const payload = JSON.stringify(currentState());
    if (payload === lastSent) return;
    lastSent = payload;
    for (const res of sseClients) res.write(`event: state\ndata: ${payload}\n\n`);
  }

  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(broadcast, BROADCAST_DEBOUNCE_MS);
  }

  // ---- 조직 변경 ----
  async function changeOrg(fn) {
    if (demo) throw new HttpError(409, '데모 모드에서는 조직을 변경할 수 없습니다.');
    let out;
    let sync;
    try {
      ({ sync } = await mutateOrg(root, (o) => {
        out = fn(o);
        const check = validateOrg(o);
        if (!check.ok) throw new HttpError(400, check.errors.join(' / '));
      }));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (Array.isArray(err.errors)) throw new HttpError(400, err.errors.join(' / '));
      throw err;
    }
    loadOrgState();
    orgMtimes = orgFiles.map(mtimeOf).join(',');
    scheduleBroadcast();
    // 저장은 됐지만 에이전트 파일을 쓰지 못한 경우 응답에 warnings로 알린다
    const warnings = syncWarnings(sync);
    return warnings.length && out && typeof out === 'object' ? { ...out, warnings } : out;
  }

  const allIds = (o) => new Set([...o.departments.map((d) => d.id), ...o.roster.map((a) => a.id)]);

  function createDepartment(body) {
    return changeOrg((o) => {
      let dept = pick(body, DEPT_FIELDS);
      if (body.preset) {
        const preset = presets.departments.find((d) => d.id === body.preset);
        if (!preset) throw new HttpError(400, `부서 프리셋이 없습니다: ${body.preset}`);
        const { roles, ...fields } = preset;
        dept = { ...pick(fields, DEPT_FIELDS), ...dept };
        if (!body.id) delete dept.id;
      }
      const taken = allIds(o);
      if (dept.id !== undefined) {
        if (taken.has(dept.id)) throw new HttpError(409, `이미 있는 id입니다: ${dept.id}`);
      } else {
        // 프리셋으로 만들면 프리셋 id(예: verify)를 먼저 쓴다. 템플릿·검증실 규칙이 부서 id를 기준으로 하기 때문이다
        const candidates = [body.preset ? kebab(body.preset) : '', kebab(dept.en)].filter((c) => ID_PATTERN.test(c));
        const free = candidates.find((c) => !taken.has(c));
        dept.id = free || slugifyId(candidates[0] || 'dept', taken);
      }
      dept = {
        engine: 'claude',
        active: true,
        permission: 'acceptEdits',
        order: o.departments.reduce((m, d) => Math.max(m, Number(d.order) || 0), 0) + 1,
        ...dept,
      };
      o.departments.push(dept);
      return dept;
    }).then((dept) => withHandoffWarnings(dept, body));
  }

  // 부서 handoffs에 없는 부서가 있으면 저장은 하고 경고를 붙인다(직접 보낸 handoffs만 알린다)
  function withHandoffWarnings(dept, body) {
    if (!dept || !Array.isArray(body.handoffs)) return dept;
    const missing = body.handoffs.filter((h) => h !== dept.id && !org.departments.some((d) => d.id === h));
    if (!missing.length) return dept;
    const warnings = [...(dept.warnings ?? []), `결과를 넘길 부서가 조직에 없습니다: ${missing.join(', ')}. 부서를 추가하거나 handoffs에서 빼 주세요.`];
    return { ...dept, warnings };
  }

  function updateDepartment(id, body) {
    if (body.id !== undefined && body.id !== id) throw new HttpError(400, '부서 id는 바꿀 수 없습니다.');
    return changeOrg((o) => {
      const dept = o.departments.find((d) => d.id === id);
      if (!dept) throw new HttpError(404, `부서가 없습니다: ${id}`);
      applyPatch(dept, pick(body, DEPT_FIELDS));
      dept.id = id;
      return dept;
    }).then((dept) => withHandoffWarnings(dept, body));
  }

  function deleteDepartment(id, cascade) {
    return changeOrg((o) => {
      const dept = o.departments.find((d) => d.id === id);
      if (!dept) throw new HttpError(404, `부서가 없습니다: ${id}`);
      const members = o.roster.filter((a) => a.department === id);
      if (members.length && !cascade) {
        throw new HttpError(409, `소속 직원 ${members.length}명이 있어 삭제할 수 없습니다. 직원까지 함께 삭제하려면 cascade=1을 지정하세요.`);
      }
      o.departments = o.departments.filter((d) => d.id !== id);
      o.roster = o.roster.filter((a) => a.department !== id);
      return { ok: true, id, removedAgents: members.map((a) => a.id) };
    });
  }

  function createAgent(body) {
    return changeOrg((o) => {
      let agent = pick(body, AGENT_FIELDS);
      const dept = o.departments.find((d) => d.id === agent.department);
      if (!dept) throw new HttpError(400, `소속 부서가 없습니다: ${agent.department ?? '(지정 안 됨)'}`);
      if (body.preset) {
        const role = findRolePreset(presets, dept.id, body.preset);
        if (!role) throw new HttpError(400, `직무 프리셋이 없습니다: ${body.preset}`);
        const fromRole = pick(role, ['specialty', 'description', 'instructions', 'thoughts', 'lead', 'model']);
        if (role.name) fromRole.name = role.name;
        // 직무 key를 남겨 두면 codex-review --reviewers fact-checker 처럼 직무로 찾을 수 있다
        fromRole.role = role.key;
        agent = { ...fromRole, ...agent };
      }
      const taken = allIds(o);
      if (agent.id !== undefined) {
        if (taken.has(agent.id)) throw new HttpError(409, `이미 있는 id입니다: ${agent.id}`);
      } else {
        agent.id = slugifyId(dept.id, taken);
      }
      if (agent.lead === undefined) agent.lead = false;
      if (!agent.title) agent.title = agent.lead ? '팀장' : '담당';
      if (!agent.description && agent.specialty) agent.description = `${agent.specialty} 업무를 맡길 때 사용`;
      agent = { active: true, ...agent };
      for (const k of Object.keys(agent)) if (agent[k] === null || agent[k] === '') delete agent[k];
      o.roster.push(agent);
      return agent;
    }).then(withWarnings);
  }

  function updateAgent(id, body) {
    if (body.id !== undefined && body.id !== id) throw new HttpError(400, '직원 id는 바꿀 수 없습니다.');
    return changeOrg((o) => {
      const agent = o.roster.find((a) => a.id === id);
      if (!agent) throw new HttpError(404, `직원이 없습니다: ${id}`);
      const wasLead = agent.lead === true;
      applyPatch(agent, pick(body, AGENT_FIELDS));
      agent.id = id;
      // 팀장 여부만 바꾸고 직함을 안 보냈으면 직함을 맞춰 준다(팀장 ↔ 담당)
      if (typeof body.lead === 'boolean' && body.title === undefined && body.lead !== wasLead) {
        if (body.lead) agent.title = '팀장';
        else if (agent.title === '팀장' || !agent.title) agent.title = '담당';
      }
      return agent;
    }).then(withWarnings);
  }

  // ---- 회사 공통 규칙·지침 미리보기 ----
  async function putCompany(body) {
    if (demo) throw new HttpError(409, '데모 모드에서는 회사 설정을 바꿀 수 없습니다.');
    if (typeof body.rules !== 'string') throw new HttpError(400, 'rules(회사 공통 규칙 문자열)가 필요합니다.');
    if (body.rules.length > MAX_COMPANY_RULES) throw new HttpError(400, `회사 공통 규칙은 ${MAX_COMPANY_RULES}자 이하여야 합니다.`);
    // 조직 변경과 같은 큐에서 실행해 sync가 겹치지 않게 한다
    let sync;
    await mutateOrg(root, () => {
      sync = saveCompanyRules(root, body.rules);
    });
    scheduleBroadcast();
    return { rules: loadCompanyRules(root), sync: { changed: sync.changed, removed: sync.removed, ok: sync.ok } };
  }

  // ---- 회사 구성 내보내기·가져오기 ----
  function orgExport(res) {
    let data;
    try {
      data = exportOrg(root);
    } catch (err) {
      throw new HttpError(500, `회사 구성을 읽지 못했습니다: ${err.message}`);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ai-office-org-${kstDate()}.json"`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data, null, 2) + '\n');
  }

  async function orgImport(body) {
    if (demo) throw new HttpError(409, '데모 모드에서는 회사 구성을 가져올 수 없습니다.');
    const mode = body.mode ?? 'replace';
    if (mode !== 'replace') throw new HttpError(400, `가져오기 방식은 replace만 지원합니다: ${mode}`);
    if (body.data === undefined) throw new HttpError(400, 'data(내보낸 회사 구성 JSON)가 필요합니다.');
    let out;
    try {
      out = await importOrg(root, body.data, { mode });
    } catch (err) {
      if (Array.isArray(err.errors)) throw new HttpError(400, err.errors.join(' / '));
      throw err;
    }
    loadOrgState();
    orgMtimes = orgFiles.map(mtimeOf).join(',');
    scheduleBroadcast();
    const warnings = syncWarnings(out.sync);
    return { ok: true, ...out.summary, ...(warnings.length ? { warnings } : {}) };
  }

  function agentPreview(id) {
    const preview = previewAgentFile(root, id, org);
    if (!preview) throw new HttpError(404, `직원이 없습니다: ${id}`);
    return preview;
  }

  function deleteAgent(id) {
    return changeOrg((o) => {
      if (!o.roster.some((a) => a.id === id)) throw new HttpError(404, `직원이 없습니다: ${id}`);
      o.roster = o.roster.filter((a) => a.id !== id);
      return { ok: true, id };
    });
  }

  function setDuty(id, body) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'active는 true 또는 false여야 합니다.');
    return changeOrg((o) => {
      const agent = o.roster.find((a) => a.id === id);
      if (!agent) throw new HttpError(404, `직원이 없습니다: ${id}`);
      agent.active = body.active;
      return agent;
    });
  }

  // ---- 실행 ----
  async function startRun(body) {
    if (!runner) throw new HttpError(409, '데모 모드에서는 작업을 실행할 수 없습니다.');
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new HttpError(400, '요청 문장(prompt)이 필요합니다.');
    if (prompt.length > MAX_PROMPT) throw new HttpError(400, `요청 문장은 ${MAX_PROMPT}자 이하여야 합니다.`);
    const agentId = body.agentId || null;
    if (agentId !== null && typeof agentId !== 'string') throw new HttpError(400, 'agentId는 문자열이어야 합니다.');
    const model = body.model || null;
    if (model !== null && typeof model !== 'string') throw new HttpError(400, 'model은 문자열이어야 합니다.');
    const run = await callRunner(() => runner.start({ agentId, prompt, model }), '작업을 시작하지 못했습니다.');
    scheduleBroadcast();
    return run;
  }

  // runner 오류(err.status 포함)를 HTTP 오류로 바꾼다.
  async function callRunner(fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.statusCode;
      throw new HttpError(Number.isInteger(status) ? status : 400, err.message || fallback);
    }
  }

  // 끝난 실행의 세션을 이어서 답한다(runner.reply: 상태 409, 직원 삭제·휴무 400)
  async function replyRun(id, body) {
    if (!runner) throw new HttpError(409, '데모 모드에서는 답장을 보낼 수 없습니다.');
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new HttpError(400, '답장 내용(prompt)이 필요합니다.');
    if (prompt.length > MAX_PROMPT) throw new HttpError(400, `답장은 ${MAX_PROMPT}자 이하여야 합니다.`);
    const model = body.model || null;
    if (model !== null && typeof model !== 'string') throw new HttpError(400, 'model은 문자열이어야 합니다.');
    const run = await callRunner(() => runner.reply(id, { prompt, model }), '답장을 보내지 못했습니다.');
    scheduleBroadcast();
    return run;
  }

  async function stopRun(id) {
    if (!runner) throw new HttpError(404, `실행을 찾을 수 없습니다: ${id}`);
    const run = await callRunner(() => runner.stop(id), '작업을 중지하지 못했습니다.');
    scheduleBroadcast();
    return run;
  }

  // codex-review.mjs 실행은 runner.startReview가 맡는다(runs에 engine codex로 등록, 로그·중지 공통).
  async function startReview(body) {
    if (!runner) throw new HttpError(409, '데모 모드에서는 검증을 실행할 수 없습니다.');
    const abs = resolveReviewTarget(root, body.target);
    const target = abs.slice(root.length + 1).split(sep).join('/');
    let reviewers = body.reviewers ?? 'all';
    if (Array.isArray(reviewers)) reviewers = reviewers.join(',');
    if (typeof reviewers !== 'string' || !/^(all|[a-z][a-z0-9-]{1,47}(,[a-z][a-z0-9-]{1,47})*)$/.test(reviewers)) {
      throw new HttpError(400, "reviewers는 검토자 id 목록 또는 'all'이어야 합니다.");
    }
    if (!existsSync(join(program, 'scripts', 'codex-review.mjs'))) throw new HttpError(404, 'scripts/codex-review.mjs가 없습니다.');
    const taskId = target.slice('outputs/'.length);
    const task = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+$/.test(taskId) ? taskId : undefined;
    const run = await callRunner(() => runner.startReview({ target, reviewers, task }), '검증을 시작하지 못했습니다.');
    scheduleBroadcast();
    return run;
  }

  // ---- 사용자 확인(승인·반려) ----
  function serverEvent(kind, task, summary, extra = {}) {
    // 사용자 행동이라 agent를 붙이지 않는다(상태 리듀서가 직원으로 세지 않게)
    appendEvent(root, { engine: 'claude', session: 'office-server', instance: 'office-server', kind, task, ...(summary ? { summary: redact(summary) } : {}), ...extra });
  }

  function reviewTask(id) {
    if (!id) throw new HttpError(400, '업무 id 형식이 올바르지 않습니다(예: 2026-10-29/slug).');
    const task = loadTaskList(root).find((t) => t && t.id === id);
    if (!task) throw new HttpError(404, `업무를 찾을 수 없습니다: ${id}`);
    if (task.status !== 'review') throw new HttpError(409, `사용자 확인 대기 상태인 업무만 처리할 수 있습니다(현재: ${task.status ?? '알 수 없음'}).`);
    return task;
  }

  function approveTask(id) {
    if (demo) throw new HttpError(409, '데모 모드에서는 승인할 수 없습니다.');
    const task = reviewTask(id);
    const now = new Date().toISOString();
    const updated = updateTask(root, id, (t) => {
      if (t.status !== 'review') return false;
      t.status = 'done';
      t.updated = now;
      t.approvedAt = now;
      return true;
    });
    if (!updated || updated.status !== 'done') throw new HttpError(409, '업무 상태가 바뀌어 승인하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
    // 비서실장이 deliver 답변을 질문으로 끝냈어도 승인했으면 더 답할 필요가 없다
    try { runner?.clearNeedsReply(id, sessionsForTask(id)); } catch (err) { warn('답변 필요 표시를 끄지 못했습니다', err); }
    serverEvent('flow.user_approve', id, '사용자 승인');
    serverEvent('task.update', id, `${task.title ?? id}: review → done`, { status: 'done' });
    loadTasks();
    scheduleBroadcast();
    return { ok: true, task: updated };
  }

  // 그 업무에 연결된 세션(.office/sessions.json: 세션 → 업무)
  function sessionsForTask(id) {
    const map = readJsonSafe(join(officePath, 'sessions.json'), {});
    return map && typeof map === 'object' ? Object.keys(map).filter((s) => map[s] === id) : [];
  }

  function rejectPrompt(task, feedback, direct) {
    const lines = [
      `[사용자 반려] 업무 ${task.id} ('${redact(task.title ?? task.id, 80)}') 결과를 사용자가 반려했습니다.`,
      '',
      '피드백:',
      feedback,
      '',
    ];
    if (direct) {
      lines.push(`피드백을 반영해 수정하고 결과를 outputs/${task.id}/ 에 다시 저장하세요.`);
    } else {
      lines.push(
        `산출물 폴더: outputs/${task.id}/ (brief.md·plan.json·report.md 참고)`,
        '피드백의 원인이 된 단계의 담당 부서에 재배정하세요(비서실장은 직접 실무를 하지 않습니다).',
        `수정이 끝나면 다시 검토하고 \`node scripts/office.mjs flow ${task.id} deliver\`로 사용자 확인을 요청하세요.`,
      );
    }
    return lines.join('\n');
  }

  // 반려: 그 업무의 실행(비서실장 또는 직접 지시 직원)에 이어서 답하기로 피드백을 전달한다. 세션이 없으면 새 비서실장 실행
  async function rejectTask(id, body) {
    if (!runner) throw new HttpError(409, '데모 모드에서는 반려할 수 없습니다.');
    const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
    if (!feedback) throw new HttpError(400, '반려 사유(feedback)를 입력해 주세요.');
    if (feedback.length > MAX_PROMPT) throw new HttpError(400, `반려 사유는 ${MAX_PROMPT}자 이하여야 합니다.`);
    const task = reviewTask(id);
    const prev = runner.latestForTask(id, sessionsForTask(id));
    const direct = Boolean(task.run && task.agent);
    const prompt = rejectPrompt(task, feedback, direct || Boolean(prev?.agentId));
    // 실행 목록·대화 스레드에는 시스템 프롬프트 대신 대표의 피드백을 보여준다(프롬프트 원문은 stdin으로만 전달)
    const display = `사용자 반려: ${feedback}`;
    let run;
    let mode;
    if (prev && prev.canReply) {
      run = await callRunner(() => runner.reply(prev.id, { prompt, task: id, display }), '반려 내용을 전달하지 못했습니다.');
      mode = 'reply';
    } else {
      if (prev && (prev.status === 'running' || prev.status === 'queued')) throw new HttpError(409, '이전 실행이 끝난 뒤 반려할 수 있습니다.');
      run = await callRunner(() => runner.start({ prompt, task: id, display }), '반려 내용을 전달하지 못했습니다.');
      mode = 'new';
    }
    const now = new Date().toISOString();
    const updated = updateTask(root, id, (t) => {
      t.status = 'active';
      t.updated = now;
      t.userRejects = (Number(t.userRejects) || 0) + 1;
      return true;
    });
    serverEvent('flow.user_reject', id, feedback);
    serverEvent('task.update', id, `${task.title ?? id}: review → active (사용자 반려)`, { status: 'active' });
    loadTasks();
    scheduleBroadcast();
    return { ok: true, task: updated, run, mode };
  }

  // ---- 산출물(outputs/) ----
  const outputsBase = resolve(root, 'outputs');
  const outsideOutputs = () => new HttpError(400, '산출물 폴더(outputs/) 안의 경로만 열 수 있습니다.');
  const insideRel = (base, target) => {
    const rel = relative(base, target);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
  };

  // outputs 기준 상대경로 → 실제 경로. 글자 경로와 실제 경로(realpath, 심볼릭 링크 해석) 모두 outputs 안이어야 한다
  function resolveOutput(p, kind) {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new HttpError(400, 'path(산출물 경로)가 필요합니다.');
    const cleaned = p.replace(/^outputs[\\/]/, '');
    const abs = resolve(outputsBase, cleaned);
    if (!insideRel(outputsBase, abs)) throw outsideOutputs();
    if (!existsSync(abs)) throw new HttpError(404, `산출물이 없습니다: ${cleaned}`);
    let real;
    let baseReal;
    try {
      real = realpathSync(abs);
      baseReal = realpathSync(outputsBase);
    } catch {
      throw new HttpError(404, `산출물이 없습니다: ${cleaned}`);
    }
    const rel = insideRel(baseReal, real);
    if (!rel) throw outsideOutputs();
    const st = statSync(real);
    if (kind === 'file' && !st.isFile()) throw new HttpError(400, `파일이 아닙니다: ${cleaned}`);
    if (kind === 'dir' && !st.isDirectory()) throw new HttpError(404, `업무 폴더가 없습니다: ${cleaned}`);
    return { real, baseReal, rel: rel.split(sep).join('/'), size: st.size, mtime: st.mtime.toISOString() };
  }

  function verdictOf(file) {
    try {
      const fd = openSync(file, 'r');
      try {
        const buf = Buffer.alloc(300);
        const n = readSync(fd, buf, 0, buf.length, 0);
        const m = buf.subarray(0, n).toString('utf8').match(/VERDICT:\s*(PASS|FIX|BLOCK)/i);
        return m ? m[1].toUpperCase() : null;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  // 업무 폴더 아래 파일 목록. 심볼릭 링크는 실제 경로가 outputs 안일 때만 따라간다
  function walkOutputs(dir, relDir, baseReal, depth, out) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_OUTPUT_FILES) return;
      if (ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      let real = full;
      let st;
      try {
        if (ent.isSymbolicLink()) {
          real = realpathSync(full);
          if (!insideRel(baseReal, real)) continue;
        }
        st = statSync(real);
      } catch {
        continue;
      }
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (st.isDirectory()) {
        if (depth < MAX_OUTPUT_DEPTH) walkOutputs(real, rel, baseReal, depth + 1, out);
      } else if (st.isFile()) {
        out.push({ rel, name: ent.name, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }

  function fileGroup(rel) {
    const [head, ...rest] = rel.split('/');
    if (!rest.length) {
      return { 'report.md': 'report', 'meeting.md': 'meeting', 'plan.json': 'plan', 'brief.md': 'brief', 'review-notes.md': 'review-notes' }[head] ?? 'other';
    }
    return head === 'reviews' ? 'reviews' : head;
  }

  function listOutputs() {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const out = [];
    let baseReal;
    try {
      baseReal = realpathSync(outputsBase);
    } catch {
      return { outputs: [] };
    }
    let dates = [];
    try {
      dates = readdirSync(baseReal, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name);
    } catch { /* 폴더 없음 */ }
    for (const date of dates.sort().reverse()) {
      let slugs = [];
      try {
        slugs = readdirSync(join(baseReal, date), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch { continue; }
      for (const slug of slugs.sort()) {
        const id = `${date}/${slug}`;
        if (!isTaskId(id)) continue;
        const dir = join(baseReal, date, slug);
        const files = [];
        walkOutputs(dir, '', baseReal, 0, files);
        const reviews = files.filter((f) => f.rel.startsWith('reviews/') && f.name.endsWith('.md'));
        const verdicts = {};
        for (const r of reviews) verdicts[r.name.replace(/\.md$/, '')] = verdictOf(join(dir, ...r.rel.split('/'))) ?? 'FIX';
        const t = byId.get(id);
        const depts = [...new Set(files.map((f) => f.rel.split('/')).filter((p) => p.length > 1 && p[0] !== 'reviews').map((p) => p[0]))];
        out.push({
          id,
          date,
          slug,
          title: t?.title ?? slug,
          status: t?.status ?? null,
          hasReport: files.some((f) => f.rel === 'report.md'),
          hasMeeting: files.some((f) => f.rel === 'meeting.md'),
          hasPlan: files.some((f) => f.rel === 'plan.json'),
          verdicts,
          depts,
          fileCount: files.length,
          updated: files.reduce((m, f) => (f.mtime > m ? f.mtime : m), t?.updated ?? t?.created ?? ''),
          run: t?.run ?? null,
          agent: t?.agent ?? null,
        });
      }
    }
    return { outputs: out };
  }

  function outputFiles(id) {
    if (!id) throw new HttpError(400, '업무 id 형식이 올바르지 않습니다(예: 2026-10-29/slug).');
    // 데모 업무(시뮬레이터 이벤트에만 있다)는 산출물 폴더가 없다. 사용자 확인 모달이 404로 콘솔 오류를 내지 않게 빈 목록을 준다
    if (demo && isTaskId(id) && !existsSync(join(outputsBase, ...id.split('/')))) {
      return { task: { id, title: id.split('/')[1], status: null }, dir: `outputs/${id}/`, files: [], truncated: false, demo: true };
    }
    const dir = resolveOutput(id, 'dir');
    const files = [];
    walkOutputs(dir.real, '', dir.baseReal, 0, files);
    const t = tasks.find((x) => x.id === id);
    return {
      task: { id, title: t?.title ?? id.split('/')[1], status: t?.status ?? null },
      dir: `outputs/${id}/`,
      files: files.map((f) => ({
        path: `${id}/${f.rel}`,
        name: f.name,
        dir: f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '',
        group: fileGroup(f.rel),
        size: f.size,
        mtime: f.mtime,
        kind: outputKind(f.name),
      })),
      truncated: files.length >= MAX_OUTPUT_FILES,
    };
  }

  // 텍스트류는 text/plain 미리보기, html은 CSP sandbox 미리보기(as=text면 소스), 그 밖·download=1은 첨부 다운로드
  function sendOutputFile(res, url) {
    const info = resolveOutput(url.searchParams.get('path'), 'file');
    const name = info.rel.split('/').at(-1);
    const kind = outputKind(name);
    const download = ['1', 'true'].includes(url.searchParams.get('download') ?? '') || kind === 'binary';
    if (download) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': attachmentHeader(name),
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
      });
      const stream = createReadStream(info.real);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return undefined;
    }
    if (info.size > PREVIEW_LIMIT) throw new HttpError(413, `미리보기는 ${PREVIEW_LIMIT / (1024 * 1024)}MB 이하 파일만 됩니다. 다운로드해 주세요.`);
    const data = readFileSync(info.real);
    const headers = { 'Cache-Control': 'no-store', 'X-Output-Kind': kind };
    if (kind === 'html' && url.searchParams.get('as') !== 'text') {
      headers['Content-Type'] = 'text/html; charset=utf-8';
      headers['Content-Security-Policy'] = HTML_PREVIEW_CSP;
    } else {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    }
    res.writeHead(200, headers);
    return res.end(data);
  }

  // 회사 설정의 작업 공간 정보(경로는 토큰이 있는 요청에만)
  function workspaceInfo() {
    return { path: root, source: workspaceSource, label: WORKSPACE_SOURCE_LABEL[workspaceSource] ?? '', compat, legacyPending };
  }

  function openWorkspaceFolder() {
    try {
      openFolder(root);
    } catch (err) {
      throw new HttpError(500, `폴더를 열지 못했습니다: ${err.message}`);
    }
    return { ok: true };
  }

  function openOutputFolder(id) {
    if (!id) throw new HttpError(400, '업무 id 형식이 올바르지 않습니다(예: 2026-10-29/slug).');
    const dir = resolveOutput(id, 'dir');
    try {
      openFolder(dir.real);
    } catch (err) {
      throw new HttpError(500, `폴더를 열지 못했습니다: ${err.message}`);
    }
    return { ok: true, path: `outputs/${id}/` };
  }

  function runLog(id) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new HttpError(404, `실행 로그가 없습니다: ${id}`);
    const file = join(officePath, 'runs', `${id}.log`);
    if (!existsSync(file)) throw new HttpError(404, `실행 로그가 없습니다: ${id}`);
    return readTail(file, LOG_TAIL_BYTES);
  }

  // ---- 정적 파일 ----
  async function serveStatic(pathname, res) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(404, '파일을 찾을 수 없습니다.');
    }
    if (decoded.includes('\0')) throw new HttpError(404, '파일을 찾을 수 없습니다.');
    if (decoded.endsWith('/')) decoded += 'index.html';
    const file = resolve(publicDir, '.' + decoded);
    if (!file.startsWith(publicDir + sep)) throw new HttpError(404, '파일을 찾을 수 없습니다.');
    let data;
    try {
      if (!statSync(file).isFile()) throw new Error('not file');
      data = await readFile(file);
    } catch {
      throw new HttpError(404, '파일을 찾을 수 없습니다.');
    }
    const ext = extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
    if (ext === '.html') {
      data = Buffer.from(data.toString('utf8').replaceAll('__OFFICE_TOKEN__', token));
      headers['Cache-Control'] = 'no-store';
      headers['Content-Security-Policy'] = DASHBOARD_CSP;
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(currentState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  // ---- 라우팅 ----
  let hosts = new Set();
  let origins = new Set();

  function checkToken(req) {
    if (!tokenMatches(req.headers['x-office-token'], token)) throw new HttpError(403, '인증 토큰이 없거나 올바르지 않습니다. 대시보드를 새로고침하세요.');
  }

  // 원격 바인딩 인증. 처리를 끝냈으면(리디렉션) true를 반환한다
  function authorizeRemote(req, res, url) {
    if (tokenMatches(parseCookies(req.headers.cookie)[AUTH_COOKIE], token)) return false;
    const key = url.searchParams.get('key');
    if (key !== null && req.method === 'GET' && url.pathname.split('/')[1] !== 'api' && tokenMatches(key, token)) {
      // 키를 쿠키로 바꾸고, 주소창·기록에 키가 남지 않게 키 없는 주소로 보낸다
      url.searchParams.delete('key');
      res.writeHead(302, {
        'Set-Cookie': `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: (url.pathname.startsWith('//') ? '/' : url.pathname) + url.search,
        'Cache-Control': 'no-store',
      });
      res.end();
      return true;
    }
    throw new HttpError(401, '원격 접속 인증이 필요합니다. 서버를 띄운 터미널에 출력된 접속 주소(?key=…)로 열어 주세요.');
  }

  function checkMutation(req) {
    checkToken(req);
    const origin = String(req.headers.origin ?? '').toLowerCase();
    if (!origins.has(origin)) throw new HttpError(403, '허용되지 않은 출처(Origin)의 요청입니다.');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Content-Type은 application/json이어야 합니다.');
  }

  async function route(req, res) {
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    if (!hosts.has(hostHeader)) throw new HttpError(403, '허용되지 않은 Host 헤더입니다.');
    const url = new URL(req.url, 'http://localhost');
    if (remote && authorizeRemote(req, res, url)) return undefined;
    const parts = url.pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    const method = req.method;

    if (parts[0] !== 'api') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '허용되지 않은 메서드입니다.');
      return serveStatic(url.pathname, res);
    }

    if (method === 'GET') {
      if (parts.length === 2 && parts[1] === 'state') return sendJson(res, 200, currentState());
      if (parts.length === 2 && parts[1] === 'stream') return openStream(req, res);
      // 회사 규칙·지침 미리보기·실행 로그는 원문이 들어 있어 토큰을 요구한다(같은 기기의 다른 사용자·프로세스 차단)
      if (parts.length === 2 && parts[1] === 'company') {
        checkToken(req);
        return sendJson(res, 200, { rules: loadCompanyRules(root), workspace: workspaceInfo() });
      }
      if (parts.length === 4 && parts[1] === 'agents' && parts[3] === 'preview') {
        checkToken(req);
        const p = agentPreview(parts[2]);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Agent-File': p.path });
        return res.end(p.content);
      }
      if (parts.length === 3 && parts[1] === 'org' && parts[2] === 'export') {
        checkToken(req);
        return orgExport(res);
      }
      if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'result') {
        checkToken(req);
        if (!runner) throw new HttpError(404, `실행을 찾을 수 없습니다: ${parts[2]}`);
        const r = await callRunner(() => runner.result(parts[2]), '답변을 불러오지 못했습니다.');
        const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Result-Source': r.source };
        // 터미널에서 이어가기(claude --resume <id>) 안내용. 토큰이 있는 요청에만 준다
        if (r.sessionId) headers['X-Session-Id'] = r.sessionId;
        res.writeHead(200, headers);
        return res.end(r.text);
      }
      if (parts.length === 2 && parts[1] === 'orgmap') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(buildOrgMap(org, { presets }));
      }
      // 산출물: 원문이 들어 있어 토큰을 요구한다
      if (parts[1] === 'outputs') {
        checkToken(req);
        if (parts.length === 2) return sendJson(res, 200, listOutputs());
        if (parts.length === 3 && parts[2] === 'file') return sendOutputFile(res, url);
        if (parts.length >= 4 && parts.at(-1) === 'files') return sendJson(res, 200, outputFiles(taskIdFromParts(parts, 2, 1)));
        throw new HttpError(404, '없는 API입니다.');
      }
      if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'log') {
        checkToken(req);
        const text = runLog(parts[2]);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(text);
      }
      throw new HttpError(404, '없는 API입니다.');
    }

    if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') throw new HttpError(405, '허용되지 않은 메서드입니다.');
    checkMutation(req);
    const isImport = method === 'POST' && parts.length === 3 && parts[1] === 'org' && parts[2] === 'import';
    const body = await readBody(req, isImport ? IMPORT_BODY_LIMIT : BODY_LIMIT);
    const [, resource, id, action] = parts;

    if (resource === 'departments') {
      if (method === 'POST' && parts.length === 2) return sendJson(res, 201, await createDepartment(body));
      if (method === 'PUT' && parts.length === 3) return sendJson(res, 200, await updateDepartment(id, body));
      if (method === 'DELETE' && parts.length === 3) {
        const cascade = ['1', 'true'].includes(url.searchParams.get('cascade') ?? '');
        return sendJson(res, 200, await deleteDepartment(id, cascade));
      }
    }
    if (resource === 'agents') {
      if (method === 'POST' && parts.length === 2) return sendJson(res, 201, await createAgent(body));
      if (method === 'PUT' && parts.length === 3) return sendJson(res, 200, await updateAgent(id, body));
      if (method === 'DELETE' && parts.length === 3) return sendJson(res, 200, await deleteAgent(id));
      if (method === 'POST' && parts.length === 4 && action === 'duty') return sendJson(res, 200, await setDuty(id, body));
    }
    if (resource === 'runs') {
      if (method === 'POST' && parts.length === 2) return sendJson(res, 202, await startRun(body));
      if (method === 'POST' && parts.length === 4 && action === 'stop') return sendJson(res, 200, await stopRun(id));
      if (method === 'POST' && parts.length === 4 && action === 'reply') return sendJson(res, 202, await replyRun(id, body));
    }
    if (resource === 'tasks' && method === 'POST' && parts.length >= 4) {
      const taskAction = parts.at(-1);
      const taskId = taskIdFromParts(parts, 2, 1);
      if (taskAction === 'approve') return sendJson(res, 200, approveTask(taskId));
      if (taskAction === 'reject') return sendJson(res, 202, await rejectTask(taskId, body));
    }
    if (resource === 'outputs' && method === 'POST' && parts.length >= 4 && parts.at(-1) === 'open') {
      return sendJson(res, 200, openOutputFolder(taskIdFromParts(parts, 2, 1)));
    }
    if (resource === 'reviews' && method === 'POST' && parts.length === 2) return sendJson(res, 202, await startReview(body));
    if (resource === 'workspace' && id === 'open' && method === 'POST' && parts.length === 3) return sendJson(res, 200, openWorkspaceFolder());
    if (resource === 'company' && method === 'PUT' && parts.length === 2) return sendJson(res, 200, await putCompany(body));
    if (resource === 'org' && id === 'import' && method === 'POST' && parts.length === 3) return sendJson(res, 200, await orgImport(body));
    throw new HttpError(404, '없는 API입니다.');
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    route(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        // 원격 인증 실패로 페이지를 열면 JSON 대신 안내문을 보여준다
        if (err.status === 401 && !String(req.url).startsWith('/api/')) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(err.message);
        }
        return sendJson(res, err.status, { error: err.message });
      }
      warn('요청 처리 중 오류', err);
      sendJson(res, 500, { error: '서버 내부 오류가 발생했습니다.' });
    });
  });

  // ---- 시작 ----
  if (demo) {
    try {
      const sim = await import('../scripts/simulate-events.mjs');
      // startSimulation은 중지 함수를 반환하고, 사용한 조직을 stop.org에 둔다.
      simulation = sim.startSimulation({ root });
    } catch (err) {
      warn('데모 시뮬레이터를 시작하지 못했습니다', err);
    }
  }
  pollFiles();

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const actualPort = server.address().port;
  // 실행 표식: migrate가 서버가 켜진 채로 데이터를 옮기지 않도록 pid·포트를 남긴다(close에서 지운다)
  let releaseLock = null;
  try {
    releaseLock = acquireServerLock(root, { port: actualPort, host });
  } catch (err) {
    warn('실행 표식(.office/server.lock)을 남기지 못했습니다. 이 서버가 켜져 있는 동안 npm run migrate를 실행하지 마세요', err);
  }
  hosts = allowedHosts(host, actualPort);
  origins = new Set([...hosts].map((h) => `http://${h}`));

  // 빠른 점검(설치 여부만)은 서버 시작을 막지 않게 listen 뒤에 돌린다. 빠진 도구는 화면 상단 배너로 알린다
  const toolCheck = setImmediate(() => {
    try {
      tools = quickToolCheck({ env });
      if (!demo) {
        if (tools.claude.installed === false) warn('claude가 설치되지 않아 작업을 실행할 수 없습니다 — npm run doctor로 확인하세요');
        if (tools.codex.installed === false) warn('codex가 설치되지 않아 검증실을 실행할 수 없습니다 — npm run doctor로 확인하세요');
      }
    } catch (err) {
      warn('claude·codex 설치 여부를 확인하지 못했습니다', err);
    }
    scheduleBroadcast();
  });

  const timers = [
    setInterval(pollFiles, POLL_MS),
    setInterval(scheduleBroadcast, RECOMPUTE_MS),
    setInterval(() => {
      for (const res of sseClients) res.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }, PING_MS),
  ];
  for (const t of timers) t.unref();

  // fs.watch는 즉시 반응용이고, 놓친 변경은 1초 폴링이 잡는다.
  let watcher = null;
  try {
    watcher = watch(officePath, (_type, name) => {
      if (!name || name === 'demo-events.jsonl' || name === 'events.jsonl' || name === 'tasks.json' || name === 'demo-org.json') pollFiles();
    });
    watcher.on('error', () => {});
  } catch {
    watcher = null;
  }

  const displayHost = isLoopback(host) || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${hostWithPort(displayHost, actualPort)}/`;
  // 원격 바인딩에서 브라우저로 열 주소(일회 키 → 쿠키 교환)
  const accessUrl = remote ? `${url}?key=${token}` : url;

  async function close() {
    clearImmediate(toolCheck);
    for (const t of timers) clearInterval(t);
    // 서버가 꺼진 뒤 에이전트가 고아 프로세스로 남지 않게 실행 중인 그룹을 끝낸다
    try {
      await runner?.stopAll();
    } catch (err) {
      warn('실행 중인 작업을 정리하지 못했습니다', err);
    }
    if (broadcastTimer) clearTimeout(broadcastTimer);
    watcher?.close();
    for (const res of sseClients) res.end();
    sseClients.clear();
    if (simulation) {
      try {
        simulation();
      } catch (err) {
        warn('데모 시뮬레이터를 멈추지 못했습니다', err);
      }
    }
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
    releaseLock?.();
  }

  return { server, url, accessUrl, remote, token, port: actualPort, root, workspaceSource, compat, legacyPending, close };
}

function parseArgs(argv) {
  const opts = { demo: false, port: 4777, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [key, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (key === '--demo') opts.demo = true;
    else if (key === '--port') opts.port = Number(value());
    else if (key === '--host') opts.host = value();
    else if (key === '--workspace') {
      opts.workspace = value();
      if (!opts.workspace) throw new Error('--workspace 값이 비어 있습니다.');
    } else throw new Error(`알 수 없는 옵션입니다: ${arg} (사용법: node dashboard/server.mjs [--demo] [--port 4777] [--host 127.0.0.1] [--workspace <경로>])`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port는 0~65535 정수여야 합니다.');
  if (!opts.host) throw new Error('--host 값이 비어 있습니다.');
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // 작업 공간 결정. --workspace로 고른 경로는 .office-local.json에 기억해 다음 실행에도 쓴다
  let ws;
  try {
    ws = resolveWorkspace({ workspace: opts.workspace ?? null });
    if (opts.workspace) {
      saveLocalWorkspace(resolve(opts.workspace));
      if (ws.source === 'env') console.log('참고: 환경변수 AI_OFFICE_WORKSPACE가 있어 --workspace보다 우선합니다.');
    }
  } catch (err) {
    console.error(err instanceof WorkspaceError ? `오류: ${err.message}` : `작업 공간을 정하지 못했습니다: ${err.message}`);
    process.exit(1);
  }
  const { workspace: _ignored, ...serverOpts } = opts;
  let handle;
  try {
    handle = await startServer({ ...serverOpts, root: ws.path, workspaceSource: ws.source });
  } catch (err) {
    console.error(`서버를 시작하지 못했습니다: ${err.message}`);
    process.exit(1);
  }
  console.log(`AI Office 대시보드${opts.demo ? ' (DEMO)' : ''}: ${handle.accessUrl}`);
  console.log(`작업 공간: ${handle.root} (${WORKSPACE_SOURCE_LABEL[ws.source]})`);
  if (handle.compat) {
    console.log('호환 모드: 회사 데이터가 아직 프로그램 폴더 안에 있어 그대로 씁니다. 서버를 끄고 npm run migrate로 작업 공간에 옮기세요.');
  } else if (handle.legacyPending) {
    console.log('프로그램 폴더에 예전 회사 데이터가 남아 있습니다. 서버를 끄고 npm run migrate로 이 작업 공간에 옮기세요.');
  }
  if (handle.remote) {
    console.log(`주의: ${opts.host}에 바인딩했습니다. 같은 네트워크의 기기가 이 서버에 닿을 수 있습니다.`);
    console.log('위 주소의 key는 비밀번호와 같습니다. 이 주소로 연 브라우저만 쿠키로 인증되고, 키 없이 들어온 요청은 모두 거부합니다. 주소를 다른 사람과 공유하지 마세요.');
  }
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log('종료 중: 실행 중인 작업을 정리합니다…');
    handle.close().finally(() => process.exit(0));
  };
  for (const sig of shutdownSignals()) process.on(sig, shutdown);
}

// 정리 후 종료할 신호. Windows는 SIGTERM이 오지 않고 Ctrl+Break가 SIGBREAK, 콘솔 창 닫기가 SIGHUP으로 온다(등록 자체는 두 OS 모두 오류 없음).
// POSIX의 SIGHUP은 nohup 실행(무시 설정)을 덮어쓰지 않도록 기본 동작에 맡긴다.
export function shutdownSignals(platform = process.platform) {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
