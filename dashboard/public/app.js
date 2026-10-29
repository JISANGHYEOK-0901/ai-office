// AGENT HQ 대시보드. 바닐라 ES 모듈, 빌드 없이 서버가 그대로 제공한다.
// 순수 함수는 export 해서 Node 테스트에서 쓰고, DOM 코드는 브라우저에서만 실행한다.
import { createOffice, avatarDataURL } from './office.js';

export const RANKS = ['사원', '주임', '대리', '과장', '차장', '부장', '팀장'];
export const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit', 'TodoWrite'];
export const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
export const COLORS = ['#38bdf8', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#fb7185', '#22d3ee', '#f97316', '#84cc16', '#e879f9'];
// idle(상단 IDLE)은 '근무 중이지만 오늘 활동 없음'이다. '근무중'은 휴무와 짝을 이루는 근무 상태라 쓰지 않는다
export const STATUS_LABEL = { working: '작업중', standby: '대기', idle: '오늘 활동 없음', 'off-duty': '휴무', offline: '오프라인' };
const RUN_LABEL = { running: '실행 중', queued: '대기열', done: '완료', failed: '실패', stopped: '중지됨' };
const TASK_LABEL = { active: '진행', done: '완료', blocked: '막힘' };
const KIND_LABEL = {
  'session.start': '세션 시작', request: '요청', 'agent.start': '업무 시작', 'agent.stop': '업무 완료',
  'tool.start': '도구', 'tool.end': '도구 완료', 'turn.end': '응답 완료', 'review.start': '리뷰 시작',
  'review.end': '리뷰 판정', 'task.start': '업무 등록', 'task.update': '업무 갱신',
};
const ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const NO_DESC_WARNING = '비서실장이 배정 기준으로 쓸 설명이 없습니다. 담당 업무나 호출 설명을 채워 주세요.';
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function validId(id) { return ID_RE.test(String(id || '')); }

// 영문 표기 → 부서 id 후보. 유효하지 않으면 빈 문자열(서버가 자동 생성)
export function kebab(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/g, '').slice(0, 48);
  return validId(s) ? s : '';
}

export function nextAgentId(deptId, taken) {
  const base = String(deptId || 'agent').slice(0, 40);
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// 이름 옆 직급·직함 표시. 이름이 직급으로 끝나면(김대리, 오유진 팀장) 직급을, 직급과 같은 직함은 직함을 생략한다
export function rankLabel(a) {
  const name = String(a?.name || '').trim();
  const rank = String(a?.rank || '').trim();
  const title = String(a?.title || '').trim();
  const parts = [];
  if (rank && !name.endsWith(rank)) parts.push(rank);
  if (title && title !== rank && !name.endsWith(title)) parts.push(title);
  return parts.join(' · ');
}

export function titleFor(rank, lead) {
  if (lead) return '팀장';
  return ['과장', '차장', '부장', '팀장'].includes(rank) ? '선임' : '담당';
}

export function presetList(presets) {
  if (Array.isArray(presets)) return presets;
  return Array.isArray(presets?.departments) ? presets.departments : [];
}

export function findPresetFor(dept, presets) {
  if (!dept) return null;
  const list = presetList(presets);
  const low = (v) => String(v || '').toLowerCase();
  return list.find((p) => p.id && p.id === dept.id)
    || list.find((p) => p.en && low(p.en) === low(dept.en))
    || list.find((p) => p.name && p.name === dept.name) || null;
}

function progressOf(value, working, onDuty) {
  // 서버는 0~100 정수(%)를 보낸다. 1 이하의 소수만 비율로 본다.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ratio = value > 1 || Number.isInteger(value) ? value / 100 : value;
    return Math.max(0, Math.min(1, ratio));
  }
  return onDuty ? working / onDuty : 0;
}

// 서버 상태(buildState + presets)를 화면용 모델로 정리한다. 필드가 일부 없어도 동작하도록 방어적으로 읽는다.
export function normalizeState(raw = {}) {
  raw = raw || {};
  const statusMap = raw.agents && !Array.isArray(raw.agents) ? raw.agents : {};
  const roster = new Map();
  const add = (a) => { if (a && typeof a === 'object' && a.id) roster.set(a.id, { ...(roster.get(a.id) || {}), ...a }); };
  (raw.roster || raw.org?.roster || []).forEach(add);
  if (Array.isArray(raw.agents)) raw.agents.forEach(add);
  for (const d of raw.departments || []) {
    if (Array.isArray(d.members)) d.members.forEach((m) => { if (m && typeof m === 'object') add({ department: d.id, ...m }); });
  }
  for (const [id, s] of Object.entries(statusMap)) if (s && (s.name || s.department)) add({ id, ...s });
  for (const id of Object.keys(statusMap)) if (!roster.has(id)) add({ id, name: id });

  const agents = {};
  for (const [id, a] of roster) {
    const s = statusMap[id] || {};
    const active = a.active !== false && s.active !== false;
    agents[id] = { ...a, ...s, id, active, status: s.status || a.status || (active ? 'idle' : 'off-duty') };
  }

  const deptIds = new Set((raw.departments || []).map((d) => d.id));
  const departments = (raw.departments || []).map((d) => {
    const ids = Array.isArray(d.members) ? d.members.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean) : [];
    for (const a of Object.values(agents)) if (a.department === d.id && !ids.includes(a.id)) ids.push(a.id);
    const members = ids.map((id) => {
      if (!agents[id]) agents[id] = { id, name: id, department: d.id, status: 'idle', active: true };
      if (!agents[id].department) agents[id].department = d.id;
      return agents[id];
    });
    const count = (st) => members.filter((m) => m.status === st).length;
    const working = count('working');
    const offDuty = count('off-duty');
    return {
      ...d,
      active: d.active !== false,
      members,
      memberCount: members.length,
      activeCount: typeof d.activeCount === 'number' ? d.activeCount : working,
      standbyCount: count('standby'),
      idleCount: typeof d.idleCount === 'number' ? d.idleCount : count('standby') + count('idle'),
      offCount: offDuty,
      progress: progressOf(d.progress, working, members.length - offDuty),
      live: Array.isArray(d.live) ? d.live : members.filter((m) => m.status === 'working').map((m) => m.id),
    };
  }).map((d, i) => ({ ...d, _i: i })).sort((a, b) => (a.order ?? a._i) - (b.order ?? b._i) || a._i - b._i);

  // 비서실장(chief)과 미등록 인원은 직원 수에서 뺀다
  const all = Object.values(agents).filter((a) => !a.chief && a.id !== 'chief' && !a.unregistered);
  const m = raw.metrics || {};
  const countAll = (st) => all.filter((a) => a.status === st).length;
  const metrics = {
    active: m.active ?? countAll('working'),
    standby: m.standby ?? countAll('standby'),
    idle: m.idle ?? countAll('idle'),
    off: m.offDuty ?? m.off ?? countAll('off-duty'),
    tasks: m.tasks ?? (raw.tasks || []).length,
    reviews: m.reviews ?? 0,
    tools: m.tools ?? 0,
  };
  const feed = [...(raw.feed || [])].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const unregistered = (raw.unregistered || []).map((u) => (typeof u === 'string' ? { id: u } : u))
    .concat(all.filter((a) => a.department && !deptIds.has(a.department)).map((a) => ({ id: a.id, name: a.name })));
  return {
    departments, agents, metrics, feed, unregistered,
    people: departments.reduce((n, d) => n + d.memberCount, 0),
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    presets: presetList(raw.presets),
    demo: !!raw.demo,
    tools: raw.tools && typeof raw.tools === 'object' ? raw.tools : {},
  };
}

// 서버 시작 때 빠른 점검 결과(tools) → 상단 배너 문구. installed가 false일 때만 알린다(null은 아직 모름)
export function toolBanners(tools, { demo = false } = {}) {
  if (demo || !tools) return [];
  const out = [];
  if (tools.claude?.installed === false) out.push({ key: 'claude', text: 'claude(Claude Code)가 설치되지 않아 직원·비서실장 작업을 실행할 수 없습니다 — npm run doctor로 확인하세요' });
  if (tools.codex?.installed === false) out.push({ key: 'codex', text: 'codex가 설치되지 않아 검증실을 실행할 수 없습니다 — npm run doctor로 확인하세요' });
  return out;
}

// 가져올 회사 구성 파일 미리보기. 형식만 가볍게 보고(최종 검증은 서버), 부서·직원 수를 센다
// 반환: { ok:true, departments, roster, company } | { ok:false, error }
export function summarizeOrgImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '회사 구성 파일(JSON 객체)이 아니에요.' };
  if (data.version !== 1) return { ok: false, error: `지원하지 않는 파일 버전이에요: ${JSON.stringify(data.version ?? null)}` };
  if (!Array.isArray(data.departments) || !Array.isArray(data.roster)) return { ok: false, error: 'departments·roster 배열이 없어요. "회사 구성 내보내기"로 만든 파일인지 확인해 주세요.' };
  if (data.company !== undefined && data.company !== null && typeof data.company !== 'string') return { ok: false, error: 'company(회사 공통 규칙)는 문자열이어야 해요.' };
  return { ok: true, departments: data.departments.length, roster: data.roster.length, company: Boolean(String(data.company ?? '').trim()) };
}

// 직무 프리셋 묶음 → 일괄 추가할 직원 계획(이름은 한국 성 + 직급)
export function planBulkAgents(deptId, roles, existingAgents = [], takenIds = []) {
  const taken = new Set([...takenIds, ...existingAgents.map((a) => a.id)]);
  const inDept = existingAgents.filter((a) => a.department === deptId);
  const names = new Set(existingAgents.map((a) => a.name));
  let hasLead = inDept.some((a) => a.lead);
  const cycle = ['과장', '대리', '주임', '사원', '대리', '차장', '사원', '주임'];
  let si = inDept.length;
  let ci = 0;
  return roles.map((role) => {
    const lead = !!role.lead && !hasLead;
    if (lead) hasLead = true;
    const rank = lead ? '팀장' : cycle[ci++ % cycle.length];
    let name = '';
    for (let tries = 0; tries < SURNAMES.length; tries++) {
      name = SURNAMES[si++ % SURNAMES.length] + rank;
      if (!names.has(name)) break;
    }
    if (names.has(name)) name = `${name}${names.size + 1}`;
    names.add(name);
    const id = nextAgentId(deptId, taken);
    taken.add(id);
    return { role, name, rank, lead, id, title: titleFor(rank, lead) };
  });
}

export function agentPayloadFromPlan(deptId, plan) {
  const r = plan.role || {};
  const body = {
    id: plan.id, name: plan.name, rank: plan.rank, title: plan.title, lead: plan.lead, department: deptId,
    specialty: r.specialty || r.name || '', description: r.description || r.specialty || '',
    instructions: r.instructions || '', thoughts: Array.isArray(r.thoughts) ? r.thoughts : [], active: true,
  };
  if (r.model) body.model = r.model;
  // 직무 key: codex-review --reviewers fact-checker 처럼 직무로 검토자를 고를 때 쓴다
  if (r.key) body.role = r.key;
  return body;
}

// run 필드(runner.mjs): target('chief'|직원 id|'review'), agentId, request(요청 요약), summary(마지막 결과 요약)
export function runAgentId(run) {
  const id = run?.agentId ?? run?.agent ?? null;
  if (id) return id;
  return run?.target && run.target !== 'review' ? run.target : null;
}
function runText(run) { return run.request ?? run.prompt ?? run.title ?? ''; }
function runResult(run) { return run.summary ?? run.result ?? run.lastOutput ?? ''; }
function runStart(run) { return run.startedAt ?? run.createdAt ?? run.started ?? run.created ?? null; }
function runWho(run) {
  const id = runAgentId(run);
  if (!id && (run.target === 'review' || run.engine === 'codex')) return '검증실 리뷰';
  return agentName(id);
}

// stream-json(claude)·codex --json 로그 → 사람이 읽을 답변 텍스트. 읽을 내용이 없으면 빈 문자열
export function readableLog(text) {
  const out = [];
  let result = '';
  for (const line of String(text || '').split('\n')) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; } // 앞부분이 잘린 줄·stderr 줄은 건너뛴다
    if (msg?.type === 'assistant') {
      const t = (msg.message?.content || []).filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join('\n');
      if (t) out.push(t);
    } else if (msg?.type === 'result' && typeof msg.result === 'string') {
      result = msg.result;
    } else if (msg?.type === 'item.completed' && msg.item?.type === 'agent_message' && typeof msg.item.text === 'string') {
      out.push(msg.item.text);
    }
  }
  // 마지막 result는 보통 마지막 assistant 텍스트와 같으므로 겹치면 한 번만 보여준다
  if (result && out[out.length - 1] !== result) out.push(`── 최종 결과 ──\n${result}`);
  return out.join('\n\n');
}

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '기록 없음';
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '기록 없음';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function hms(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

function pad3(n) { return String(Math.max(0, Number(n) || 0)).padStart(3, '0'); }

// ───────────────────────── 브라우저 전용 ─────────────────────────
const $ = (id) => document.getElementById(id);
const ui = { view: 'control', theme: 'neon', drawer: null, patrol: false, previewOpen: null, dismissedBanners: new Set() };
let S = normalizeState({});
let office = null;
let token = '';
let lastRaw = null;

function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { /* 저장 불가 환경은 무시 */ }
  return null;
}

// 토큰이 필요한 읽기 요청(지침 미리보기·실행 로그·회사 규칙)
function authedGet(path, accept = 'text/plain') {
  return fetch(path, { headers: { 'X-Office-Token': token, Accept: accept } });
}

async function api(method, path, body) {
  const init = { method, headers: { 'X-Office-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  else if (method === 'POST') init.body = '{}';
  let res;
  try { res = await fetch(path, init); } catch { throw new Error('서버에 연결할 수 없어요. 대시보드 서버가 켜져 있는지 확인해 주세요.'); }
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) {
    const err = new Error(data?.error || `요청이 실패했어요 (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refresh() {
  try {
    const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error();
    apply(await res.json());
  } catch {
    setConn('retry');
  }
}

function apply(raw) {
  lastRaw = raw;
  S = normalizeState(raw);
  render();
}

let stream = null;
function connect() {
  setConn('connecting');
  stream?.close();
  const es = new EventSource('/api/stream');
  stream = es;
  es.addEventListener('open', () => setConn('live'));
  es.addEventListener('state', (e) => {
    try { apply(JSON.parse(e.data)); setConn('live'); } catch { /* 깨진 메시지는 건너뜀 */ }
  });
  es.addEventListener('ping', () => setConn('live'));
  es.addEventListener('error', () => {
    setConn('retry');
    if (es.readyState === EventSource.CLOSED) { es.close(); setTimeout(() => { if (stream === es) { connect(); refresh(); } }, 3000); }
  });
}

function setConn(state) {
  const el = $('conn');
  const text = { live: '실시간 연결', connecting: '연결 중…', retry: '연결 끊김 · 재연결 중' }[state];
  el.dataset.state = state;
  if (el.lastChild.textContent !== text) el.lastChild.textContent = text;
}

function setHTML(el, html) {
  if (el._html === html) return;
  const active = document.activeElement;
  const key = active && el.contains(active) ? active.dataset.key : null;
  el.innerHTML = html;
  el._html = html;
  if (key) el.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

function toast(message, { type = 'info', action } = {}) {
  const box = document.createElement('div');
  box.className = `toast toast-${type}`;
  box.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = action.label;
    b.addEventListener('click', () => { box.remove(); action.fn(); });
    box.append(b);
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'icon-btn'; close.setAttribute('aria-label', '알림 닫기'); close.textContent = '✕';
  close.addEventListener('click', () => box.remove());
  box.append(close);
  const list = $('toasts');
  list.append(box);
  while (list.children.length > 3) list.firstElementChild.remove();
  setTimeout(() => box.remove(), action ? 9000 : 4500);
}

// 저장은 됐지만 확인이 필요한 경고(설명 없음, 에이전트 파일 충돌 등)
function showWarnings(data) {
  for (const w of data?.warnings || []) toast(w, { type: 'warn' });
}

function confirmBox(text, okLabel = '삭제') {
  const dlg = $('confirmDialog');
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

function avatar(id, cls = '') {
  return `<img class="ava ${cls}" src="${avatarDataURL(id)}" alt="" width="24" height="24">`;
}

function agentName(id) {
  if (!id || id === 'chief') return '비서실장';
  const a = S.agents[id];
  if (!a || a.unregistered) return `${id} (미등록)`;
  return a.name || id;
}

function deptOf(id) { return S.departments.find((d) => d.id === id); }

// 데모 모드에서는 서버가 쓰기를 거부하므로 쓰기 버튼을 미리 끈다(폼을 다 채운 뒤 409를 받지 않게)
const WRITE_ACTS = new Set(['new-dept', 'add-preset', 'add-agent', 'bulk', 'edit-agent', 'edit-dept', 'run-agent', 'stop-run', 'duty-agent', 'duty-dept', 'del-agent', 'del-dept']);
const DEMO_HINT = '데모 모드에서는 보기만 가능해요.';
function applyDemoLock() {
  if (!S.demo) return;
  for (const b of document.querySelectorAll('[data-act]')) {
    if (WRITE_ACTS.has(b.dataset.act) && !b.disabled) { b.disabled = true; b.title = DEMO_HINT; }
  }
  for (const id of ['addDeptBtn', 'chiefSubmit', 'chiefInput', 'chiefModel']) {
    const el = $(id);
    if (el && !el.disabled) { el.disabled = true; el.title = DEMO_HINT; }
  }
  $('chiefInput').placeholder = '데모 모드에서는 업무를 지시할 수 없어요(보기 전용). npm run office로 실행해 주세요.';
}

// ───── 렌더링 ─────
function render() {
  renderTop();
  const empty = S.departments.length === 0;
  $('viewOnboarding').hidden = !empty;
  $('viewControl').hidden = empty || ui.view !== 'control';
  $('viewOffice').hidden = empty || ui.view !== 'office';
  document.querySelector('.view-tabs').classList.toggle('is-disabled', empty);
  if (empty) renderOnboarding();
  renderOrg();
  renderControl();
  renderFeed();
  renderTasks();
  renderDrawer();
  if (office) {
    office.update({ departments: S.departments, feed: S.feed });
    office.setVisible(!empty && ui.view === 'office');
    office.setSelected(ui.drawer?.type === 'agent' ? ui.drawer.id : null);
    const working = S.departments.reduce((n, d) => n + d.activeCount, 0);
    $('officeCaption').textContent = `${S.departments.length}개 부서 · ${S.people}명 · 작업 중 ${working}명${ui.patrol ? ' · 자동 순찰 중' : ''}`;
  }
  applyDemoLock();
}

function renderTop() {
  const m = S.metrics;
  const chips = [['active', 'ACTIVE'], ['standby', 'STANDBY'], ['idle', 'IDLE'], ['off', 'OFF'], ['tasks', 'TASKS'], ['reviews', 'REVIEWS'], ['tools', 'TOOLS']];
  setHTML($('metrics'), chips.map(([k, label]) =>
    `<li class="metric m-${k}"><span class="metric-label">${label}</span><b class="metric-val">${pad3(m[k])}</b></li>`).join(''));
  $('demoBadge').hidden = !S.demo;
  renderBanners();
  $('brandSub').textContent = `${S.departments.length}개 부서 · ${S.people}명 에이전트`;
}

function renderBanners() {
  const list = toolBanners(S.tools, { demo: S.demo }).filter((b) => !ui.dismissedBanners.has(b.key));
  setHTML($('toolBanners'), list.map((b) => `
    <div class="tool-banner"><span>${esc(b.text)}</span>
      <button type="button" class="icon-btn" data-banner="${esc(b.key)}" data-key="banner-${esc(b.key)}" aria-label="알림 닫기">✕</button></div>`).join(''));
}

function renderOnboarding() {
  const cards = S.presets.map((p, i) => `
    <article class="preset-card" style="--dept:${esc(p.color || COLORS[i % COLORS.length])}">
      <div class="preset-top"><span class="dc-icon" aria-hidden="true">${esc((p.en || p.name || '?').slice(0, 1))}</span>
        <div><h4>${esc(p.name)}</h4><span class="dc-en">${esc(p.en || '')}</span></div>
        <span class="engine engine-${esc(p.engine || 'claude')}">${esc(p.engine || 'claude')}</span></div>
      <p>${esc(p.summary || '')}</p>
      <div class="preset-meta">직무 프리셋 ${(p.roles || []).length}개</div>
      <div class="preset-actions">
        <button type="button" class="btn btn-sm" data-act="add-preset" data-preset="${i}" data-key="pa-${i}" aria-label="${esc(p.name)} 부서만 추가">부서만 추가</button>
        <button type="button" class="btn btn-sm btn-primary" data-act="add-preset" data-preset="${i}" data-bulk="1" data-key="pb-${i}" aria-label="${esc(p.name)} 부서와 프리셋 인원 추가">인원까지 추가</button>
      </div>
    </article>`).join('');
  const ids = ['ceo-a', 'dev-b', 'mkt-c', 'res-d', 'ops-e'];
  setHTML($('viewOnboarding'), `
    <div class="onboarding win">
      <div class="win-bar"><h2>WELCOME · AI OFFICE</h2><span class="win-ctl" aria-hidden="true"></span></div>
      <div class="win-body">
        <div class="onb-hero">
          <div class="onb-crew" aria-hidden="true">${ids.map((id) => avatar(id, 'ava-xl')).join('')}</div>
          <h2 id="onbTitle">나의 AI 회사를 시작해 보세요</h2>
          <p>부서를 만들고 직원을 채용하면, 비서실장(Claude 메인 세션)이 업무를 나눠 맡기고 이 화면에서 실시간으로 지켜볼 수 있어요.</p>
          <ol class="onb-steps"><li><b>1</b> 부서 만들기</li><li><b>2</b> 직원 추가</li><li><b>3</b> 업무 지시</li></ol>
          <button type="button" class="btn btn-primary btn-lg" data-act="new-dept" data-key="onb-new">첫 부서 만들기</button>
        </div>
        <h3 class="section-title">프리셋 부서에서 고르기</h3>
        ${cards ? `<div class="preset-grid">${cards}</div>` : '<p class="empty">프리셋을 불러오지 못했어요. "첫 부서 만들기"에서 직접 입력해 주세요.</p>'}
      </div>
    </div>`);
}

function statusDot(status) {
  return `<i class="st st-${esc(status)}" title="${esc(STATUS_LABEL[status] || status)}"></i>`;
}

function renderOrg() {
  const total = S.people;
  const depts = S.departments.map((d) => `
    <li class="org-dept${d.active ? '' : ' is-off'}" style="--dept:${esc(d.color || '#38bdf8')}">
      <button type="button" class="org-dept-btn" data-act="open-dept" data-id="${esc(d.id)}" data-key="od-${esc(d.id)}">
        <i class="dept-dot" aria-hidden="true"></i><span class="org-name">${esc(d.name)}</span>
        <span class="org-count" aria-label="작업 ${d.activeCount}명, 전체 ${d.memberCount}명">${d.activeCount}/${d.memberCount}</span>
      </button>
      <ul class="org-members">${d.members.map((a) => `
        <li><button type="button" class="org-member" data-act="open-agent" data-id="${esc(a.id)}" data-key="oa-${esc(a.id)}">
          ${avatar(a.id)}<span class="om-name">${esc(a.name || a.id)}</span><small>${esc(rankLabel(a))}</small>${statusDot(a.status)}
        </button></li>`).join('')}
        <li><button type="button" class="org-add" data-act="add-agent" data-dept="${esc(d.id)}" data-key="oadd-${esc(d.id)}">+ 직원 추가</button></li>
      </ul>
    </li>`).join('');
  const unreg = S.unregistered.length ? `
    <div class="org-unreg"><h3>미등록 에이전트</h3><ul>${S.unregistered.map((u) => `<li>${esc(u.name || u.id)}</li>`).join('')}</ul></div>` : '';
  setHTML($('orgTree'), `
    <div class="org-head"><span>${S.departments.length}개 부서 · ${total}명</span>
      <button type="button" class="btn btn-sm" data-act="new-dept" data-key="org-new">+ 부서</button></div>
    ${S.departments.length ? `<ul class="org-list">${depts}</ul>` : '<p class="empty">아직 부서가 없어요.</p>'}${unreg}`);
}

// 직원의 현재 상태 한 줄. 대기열 실행이 있으면 함께 알린다
function statusLine(a) {
  let text;
  if (a.status === 'working') text = [a.lastTool, a.lastSummary].filter(Boolean).join(' · ') || '작업 중';
  else if (a.status === 'idle' || a.status === 'off-duty') text = STATUS_LABEL[a.status];
  else text = `${STATUS_LABEL[a.status] || a.status} · ${timeAgo(a.lastEvent?.ts || a.lastEvent)}`;
  return a.queued ? `실행 대기열 · ${text}` : text;
}

function liveRow(a) {
  const tool = statusLine(a);
  return `<li><button type="button" class="live-row" data-act="open-agent" data-id="${esc(a.id)}" data-key="lr-${esc(a.id)}">
    ${avatar(a.id)}<span class="lr-main"><b>${esc(a.name || a.id)}</b> <small>${esc(rankLabel(a))}</small><span class="lr-tool">${esc(tool)}</span></span>${statusDot(a.status)}
  </button></li>`;
}

function renderControl() {
  const total = S.people;
  $('controlSub').textContent = `${S.departments.length}개 부서 실시간 운영 · 총 ${total}명`;
  setHTML($('deptGrid'), S.departments.map((d) => {
    const pct = Math.round(d.progress * 100);
    const live = d.members.filter((m) => m.status === 'working');
    const rows = (live.length ? live.slice(0, 4) : d.members.filter((m) => m.status !== 'off-duty').slice(0, 3));
    const more = live.length > 4 ? `<li class="lr-more">외 ${live.length - 4}명 작업 중</li>` : '';
    return `
    <article class="dept-card${d.active ? '' : ' is-off'}${live.length ? ' is-live' : ''}" style="--dept:${esc(d.color || '#38bdf8')}" aria-labelledby="dc-${esc(d.id)}">
      <header class="dc-head">
        <span class="dc-icon" aria-hidden="true">${esc((d.en || d.name || '?').slice(0, 1))}</span>
        <div class="dc-title">
          <h3 id="dc-${esc(d.id)}"><button type="button" class="link" data-act="open-dept" data-id="${esc(d.id)}" data-key="dct-${esc(d.id)}">${esc(d.name)}</button></h3>
          <span class="dc-en">UNIT ${esc(d.en || d.id)} · ${esc(d.engine || 'claude')}${d.model ? ' · ' + esc(d.model) : ''}</span>
        </div>
        <span class="dc-total" aria-label="인원 ${d.memberCount}명">${d.memberCount}</span>
      </header>
      <div class="dc-badges">${d.active ? '' : '<span class="badge badge-off">휴무</span>'}${d.permission === 'bypassPermissions' ? '<span class="badge badge-warn" title="모든 확인 생략 모드">⚠ bypass</span>' : ''}${d.engine === 'codex' ? '<span class="badge">읽기 전용 검증</span>' : ''}</div>
      <div class="dc-stats">
        <div><b>${d.memberCount}</b><span>인원</span></div>
        <div><b class="c-work">${d.activeCount}</b><span>활동</span></div>
        <div><b class="c-standby">${d.standbyCount}</b><span>대기</span></div>
      </div>
      <div class="dc-progress">
        <div class="dc-progress-label"><span>진행률</span><span>${pct}%</span></div>
        <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(d.name)} 진행률"><i style="width:${pct}%"></i></div>
      </div>
      <div class="dc-live">
        <div class="dc-live-head"><span class="live-dot${live.length ? ' on' : ''}" aria-hidden="true"></span>LIVE AGENTS<span>${live.length ? `${live.length}명 작업 중` : '대기 중'}</span></div>
        ${rows.length ? `<ul>${rows.map(liveRow).join('')}${more}</ul>` : '<p class="empty">직원이 없어요. 아래에서 추가해 보세요.</p>'}
      </div>
      <footer class="dc-foot">
        <button type="button" class="btn btn-sm" data-act="add-agent" data-dept="${esc(d.id)}" data-key="dca-${esc(d.id)}">+ 직원 추가</button>
        ${findPresetFor(d, S.presets) ? `<button type="button" class="btn btn-sm" data-act="bulk" data-dept="${esc(d.id)}" data-key="dcb-${esc(d.id)}">프리셋 인원</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-act="open-dept" data-id="${esc(d.id)}" data-key="dcd-${esc(d.id)}">상세 ›</button>
      </footer>
    </article>`;
  }).join(''));
}

function renderFeed() {
  const items = S.feed.slice(0, 120);
  $('feedCount').textContent = items.length ? `최근 ${S.feed.length}건` : '';
  setHTML($('feed'), items.length ? items.map((e) => {
    const name = agentName(e.agent);
    const kind = KIND_LABEL[e.kind] || e.kind || '';
    const verdict = e.verdict ? `<span class="verdict v-${esc(String(e.verdict).toLowerCase())}">${esc(e.verdict)}</span>` : '';
    return `<li class="feed-item k-${esc(String(e.kind || '').replace('.', '-'))}">
      <time datetime="${esc(e.ts)}">${hms(e.ts)}</time>
      <div class="fi-body"><div class="fi-line">${e.agent && e.agent !== 'chief' ? avatar(e.agent, 'ava-sm') : '<span class="ava ava-sm ava-chief" aria-hidden="true">★</span>'}<b>${esc(name)}</b><span class="kind">${esc(kind)}</span>${e.tool ? `<code>${esc(e.tool)}</code>` : ''}${verdict}${e.engine === 'codex' ? '<span class="engine engine-codex">codex</span>' : ''}</div>
      ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}</div></li>`;
  }).join('') : '<li class="empty">아직 이벤트가 없어요. 업무를 지시하면 여기에 실시간으로 쌓여요.</li>');
}

// state.mjs의 verdicts({검토자: 판정}) + server.mjs의 reviewFiles(reviews/*.md) + 피드의 review.end
function taskReviews(task) {
  const list = [];
  const push = (reviewer, verdict) => {
    const hit = list.find((r) => r.reviewer === reviewer);
    if (hit) { if (!hit.verdict && verdict) hit.verdict = verdict; } else list.push({ reviewer, verdict: verdict || '' });
  };
  const map = task.verdicts || (task.reviews && !Array.isArray(task.reviews) ? task.reviews : null);
  if (map && typeof map === 'object') for (const [reviewer, verdict] of Object.entries(map)) push(reviewer, verdict);
  for (const r of [...(task.reviewFiles || []), ...(Array.isArray(task.reviews) ? task.reviews : [])]) {
    if (typeof r === 'string') push(r.replace(/\.md$/, ''), ''); else if (r?.reviewer) push(r.reviewer, r.verdict);
  }
  for (const e of S.feed) {
    if (e.kind === 'review.end' && e.task === task.id && !list.some((r) => r.reviewer === e.agent)) list.push({ reviewer: e.agent, verdict: e.verdict });
  }
  return list;
}

function renderTasks() {
  const tasks = [...S.tasks].reverse().slice(0, 30);
  const runs = [...S.runs].sort((a, b) => String(runStart(b) || '').localeCompare(String(runStart(a) || ''))).slice(0, 30);
  const taskHtml = tasks.map((t) => {
    const reviews = taskReviews(t);
    const hasReport = t.report ?? t.hasReport;
    return `<li class="task">
      <div class="task-top"><span class="tag t-${esc(t.status)}">${esc(TASK_LABEL[t.status] || t.status || '진행')}</span><b>${esc(t.title || t.id)}</b></div>
      <div class="task-meta"><code>${esc(t.id)}</code>
        ${hasReport === undefined ? '' : `<span class="${hasReport ? 'ok' : 'muted'}">${hasReport ? '보고서 ✓' : '보고서 없음'}</span>`}
        ${reviews.map((r) => `<span class="verdict v-${esc(String(r.verdict || 'none').toLowerCase())}" title="${esc(agentName(r.reviewer))}">${esc(agentName(r.reviewer).replace(/ \(미등록\)$/, ''))} ${esc(r.verdict || '…')}</span>`).join('')}
      </div></li>`;
  }).join('');
  const runHtml = runs.map((r) => {
    const live = r.status === 'running' || r.status === 'queued';
    const who = runWho(r);
    return `<li class="run run-${esc(r.status)}">
      <div class="task-top"><span class="tag r-${esc(r.status)}">${esc(RUN_LABEL[r.status] || r.status)}</span><b>${esc(who)}</b>${r.engine === 'codex' ? '<span class="engine engine-codex">codex</span>' : ''}<time>${esc(timeAgo(runStart(r)))}</time></div>
      <p class="run-text">${esc(runText(r))}</p>
      ${runResult(r) && !live ? `<p class="run-result">${esc(String(runResult(r)).slice(0, 160))}</p>` : ''}
      <div class="run-actions">
        ${live ? `<button type="button" class="btn btn-sm btn-danger" data-act="stop-run" data-run="${esc(r.id)}" data-key="rs-${esc(r.id)}">중지</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-act="log-run" data-run="${esc(r.id)}" data-key="rl-${esc(r.id)}">로그</button>
      </div></li>`;
  }).join('');
  setHTML($('tasks'), `
    <h3 class="sub-title">업무 <span>${S.tasks.length}</span></h3>
    ${taskHtml ? `<ul class="task-list">${taskHtml}</ul>` : '<p class="empty">등록된 업무가 없어요.</p>'}
    <h3 class="sub-title">실행 <span>진행 ${S.runs.filter((r) => r.status === 'running').length}건${S.runs.some((r) => r.status === 'queued') ? ` · 대기 ${S.runs.filter((r) => r.status === 'queued').length}건` : ''}</span></h3>
    ${runHtml ? `<ul class="task-list">${runHtml}</ul>` : '<p class="empty">실행 기록이 없어요. 위 입력창이나 직원 프로필에서 작업을 지시해 보세요.</p>'}`);
}

function latestRun(agentId) {
  return S.runs.filter((r) => runAgentId(r) === agentId).sort((a, b) => String(runStart(b) || '').localeCompare(String(runStart(a) || '')))[0];
}

function renderDrawer() {
  const drawer = $('drawer');
  const d = ui.drawer;
  const target = d && (d.type === 'agent' ? S.agents[d.id] : deptOf(d.id));
  if (!d || !target) {
    if (d && !target) ui.drawer = null;
    drawer.hidden = true;
    document.body.classList.remove('has-drawer');
    return;
  }
  drawer.hidden = false;
  document.body.classList.add('has-drawer');
  if (d.type === 'agent') {
    $('drawerTitle').textContent = '직원 프로필';
    setHTML($('drawerBody'), agentProfile(target));
  } else {
    $('drawerTitle').textContent = '부서 상세';
    setHTML($('drawerBody'), deptDetail(target));
  }
}

function agentProfile(a) {
  const dept = deptOf(a.department);
  const run = latestRun(a.id);
  const running = run && (run.status === 'running' || run.status === 'queued');
  const off = a.status === 'off-duty' || a.active === false;
  const lastTs = a.lastEvent?.ts || a.lastEvent;
  const thoughts = Array.isArray(a.thoughts) ? a.thoughts : [];
  return `
  <div class="profile" style="--dept:${esc(dept?.color || '#38bdf8')}">
    <div class="profile-head">
      ${avatar(a.id, 'ava-lg')}
      <div>
        <h3>${esc(a.name || a.id)} <small>${esc(rankLabel(a))}</small></h3>
        <p class="chips">
          <span class="chip chip-dept">${esc(dept?.name || a.department || '부서 없음')}</span>
          <span class="st-badge st-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span>
          ${a.queued ? '<span class="badge badge-warn" title="동시 실행 제한으로 차례를 기다리는 중">실행 대기열</span>' : ''}
          ${a.lead ? '<span class="badge badge-lead">팀장</span>' : ''}
        </p>
      </div>
    </div>
    <dl class="kv">
      <dt>담당</dt><dd>${esc(a.specialty || '—')}</dd>
      <dt>현재</dt><dd>${esc(a.status === 'working' || a.queued ? statusLine(a) : STATUS_LABEL[a.status] || a.status)}</dd>
      <dt>마지막 활동</dt><dd>${esc(timeAgo(lastTs))}${a.lastSummary && a.status !== 'working' ? ` · ${esc(a.lastSummary)}` : ''}</dd>
      <dt>모델</dt><dd>${esc(dept?.engine === 'codex' ? `${dept.codexModel || 'gpt-6.1-sol'} (Codex)` : a.model || (a.lead ? 'opus (팀장 기본)' : dept?.model ? `${dept.model} (부서 기본)` : 'sonnet (기본)'))}</dd>
      <dt>id</dt><dd><code>${esc(a.id)}</code></dd>
    </dl>
    <div class="profile-actions">
      <button type="button" class="btn btn-primary" data-act="run-agent" data-id="${esc(a.id)}" data-key="pa-run" ${off ? 'disabled aria-describedby="offHint"' : ''}>작업 지시</button>
      <button type="button" class="btn btn-danger" data-act="stop-run" data-run="${esc(run?.id || '')}" data-key="pa-stop" ${running ? '' : 'disabled'}>중지</button>
      <button type="button" class="btn" data-act="duty-agent" data-id="${esc(a.id)}" data-key="pa-duty">${a.active === false ? '근무로 전환' : '휴무로 전환'}</button>
      <button type="button" class="btn" data-act="edit-agent" data-id="${esc(a.id)}" data-key="pa-edit">수정</button>
      <button type="button" class="btn btn-ghost btn-danger-text" data-act="del-agent" data-id="${esc(a.id)}" data-key="pa-del">삭제</button>
    </div>
    ${off ? `<p class="help" id="offHint">${a.active !== false && dept?.active === false ? '부서가 휴무 중이라' : '휴무 중인 직원은 에이전트 파일이 없어'} 작업을 받을 수 없어요.</p>` : ''}
    <h4 class="sub-title">최근 실행</h4>
    ${run ? `<div class="run-card run-${esc(run.status)}">
        <div class="task-top"><span class="tag r-${esc(run.status)}">${esc(RUN_LABEL[run.status] || run.status)}</span><time>${esc(timeAgo(runStart(run)))}</time></div>
        <p class="run-text">${esc(runText(run))}</p>
        ${runResult(run) ? `<pre class="run-output">${esc(runResult(run))}</pre>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-act="log-run" data-run="${esc(run.id)}" data-key="pa-log">전체 결과 보기</button>
      </div>` : '<p class="empty">아직 실행 기록이 없어요.</p>'}
    ${!a.unregistered && !String(a.description || '').trim() && !String(a.specialty || '').trim() ? `<p class="warn">${esc(NO_DESC_WARNING)}</p>` : ''}
    ${a.description ? `<h4 class="sub-title">호출 설명</h4><p class="muted-text">${esc(a.description)}</p>` : ''}
    ${a.instructions ? `<details class="more"><summary>상세 지침</summary><p>${esc(a.instructions)}</p></details>` : ''}
    ${thoughts.length ? `<details class="more"><summary>혼잣말 ${thoughts.length}개</summary><ul>${thoughts.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
    ${a.unregistered || S.demo ? '' : `<details class="more" data-preview="${esc(a.id)}" ${ui.previewOpen === a.id ? 'open' : ''}><summary>최종 지침 미리보기</summary><pre class="preview-box" data-preview-body>${esc(previewCache.get(a.id) || '불러오는 중…')}</pre></details>`}
  </div>`;
}

// 최종 지침 파일 미리보기(읽기 전용). 펼칠 때마다 서버에서 다시 받는다
const previewCache = new Map();
async function loadPreview(details) {
  const id = details.dataset.preview;
  const box = details.querySelector('[data-preview-body]');
  try {
    const res = await authedGet(`/api/agents/${encodeURIComponent(id)}/preview`);
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* 텍스트 그대로 */ }
      throw new Error(msg);
    }
    const file = res.headers.get('X-Agent-File');
    const full = `${file ? `# ${file}\n` : ''}${text}`;
    previewCache.set(id, full);
    box.textContent = full;
  } catch (e) {
    box.textContent = `미리보기를 불러오지 못했어요: ${e.message}`;
  }
}

function deptDetail(d) {
  const lead = d.members.find((m) => m.lead);
  return `
  <div class="profile" style="--dept:${esc(d.color || '#38bdf8')}">
    <div class="profile-head">
      <span class="dc-icon dc-icon-lg" aria-hidden="true">${esc((d.en || d.name || '?').slice(0, 1))}</span>
      <div>
        <h3>${esc(d.name)} <small>${esc(d.en || '')}</small></h3>
        <p class="chips"><span class="engine engine-${esc(d.engine || 'claude')}">${esc(d.engine || 'claude')}</span>
          ${d.active ? '<span class="st-badge st-working">운영중</span>' : '<span class="st-badge st-off-duty">휴무</span>'}
          ${d.permission === 'bypassPermissions' ? '<span class="badge badge-warn">⚠ bypassPermissions</span>' : ''}</p>
      </div>
    </div>
    ${d.permission === 'bypassPermissions' ? '<p class="warn">이 부서는 확인 없이 모든 도구를 실행합니다. 신뢰할 수 있는 작업에만 쓰세요.</p>' : ''}
    <p class="muted-text">${esc(d.summary || '설명이 없어요.')}</p>
    <dl class="kv">
      <dt>인원</dt><dd>${d.memberCount}명 · 작업 ${d.activeCount} · 대기 ${d.standbyCount} · 휴무 ${d.offCount}</dd>
      <dt>팀장</dt><dd>${lead ? esc(lead.name) : '없음'}</dd>
      ${d.engine === 'codex'
        ? `<dt>Codex 모델</dt><dd>${esc(d.codexModel || 'gpt-6.1-sol')} · 추론 ${esc(d.codexEffort || 'max')}</dd>`
        : `<dt>기본 모델</dt><dd>${esc(d.model || 'sonnet')}</dd>`}
      <dt>권한 모드</dt><dd>${esc(d.permission || 'acceptEdits')}</dd>
      <dt>허용 도구</dt><dd>${Array.isArray(d.tools) && d.tools.length ? d.tools.map((t) => `<code>${esc(t)}</code>`).join(' ') : '제한 없음'}</dd>
      <dt>id</dt><dd><code>${esc(d.id)}</code></dd>
    </dl>
    <div class="profile-actions">
      <button type="button" class="btn btn-primary" data-act="add-agent" data-dept="${esc(d.id)}" data-key="dd-add">+ 직원 추가</button>
      <button type="button" class="btn" data-act="bulk" data-dept="${esc(d.id)}" data-key="dd-bulk">프리셋 인원 일괄 추가</button>
      <button type="button" class="btn" data-act="edit-dept" data-id="${esc(d.id)}" data-key="dd-edit">수정</button>
      <button type="button" class="btn" data-act="duty-dept" data-id="${esc(d.id)}" data-key="dd-duty">${d.active ? '부서 휴무' : '부서 근무'}</button>
      <button type="button" class="btn" data-act="focus-room" data-id="${esc(d.id)}" data-key="dd-room">사무실에서 보기</button>
      <button type="button" class="btn btn-ghost btn-danger-text" data-act="del-dept" data-id="${esc(d.id)}" data-key="dd-del">삭제</button>
    </div>
    ${d.instructions ? `<details class="more"><summary>부서 공통 지침</summary><p>${esc(d.instructions)}</p></details>` : ''}
    <h4 class="sub-title">구성원 ${d.memberCount}명</h4>
    ${d.members.length ? `<ul class="member-list">${d.members.map(liveRow).join('')}</ul>` : '<p class="empty">아직 직원이 없어요.</p>'}
  </div>`;
}

let drawerOpener = null;
function openDrawer(type, id) {
  // 처음 열 때의 포커스 위치를 기억했다가 닫을 때 돌려준다(패널 안에서 다른 항목으로 바꿔 열 때는 유지)
  if (!ui.drawer) drawerOpener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  ui.drawer = { type, id };
  render();
  $('drawerTitle').setAttribute('tabindex', '-1');
  $('drawerTitle').focus({ preventScroll: true });
}

function closeDrawer({ restoreFocus = true } = {}) {
  const opener = drawerOpener;
  drawerOpener = null;
  ui.drawer = null;
  render();
  if (!restoreFocus) return;
  // 연 버튼이 다시 그려졌으면 같은 data-key 요소를 찾는다
  const key = opener?.dataset?.key;
  const target = opener?.isConnected ? opener : key ? document.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
  (target || $('main')).focus({ preventScroll: true });
}

// ───── 부서 대화상자 ─────
let deptEditing = null;
function fillDeptForm(values) {
  const f = $('deptForm');
  f.name.value = values.name || '';
  f.en.value = values.en || '';
  f.color.value = /^#[0-9a-f]{6}$/i.test(values.color || '') ? values.color : COLORS[0];
  f.summary.value = values.summary || '';
  f.instructions.value = values.instructions || '';
  f.engine.value = values.engine === 'codex' ? 'codex' : 'claude';
  f.codexModel.value = values.codexModel || '';
  f.codexEffort.value = CODEX_EFFORTS.includes(values.codexEffort) ? values.codexEffort : '';
  f.model.value = ['sonnet', 'opus', 'haiku', 'inherit'].includes(values.model) ? values.model : 'sonnet';
  f.permission.value = values.permission || 'acceptEdits';
  const tools = Array.isArray(values.tools) && values.tools.length ? values.tools : null;
  $('toolsAll').checked = !tools;
  for (const box of $('toolChecks').querySelectorAll('input')) { box.checked = tools ? tools.includes(box.value) : false; box.disabled = !tools; }
  if (!deptEditing) f.id.value = values.id && validId(values.id) ? values.id : kebab(values.en);
  syncDeptUi();
}

function syncDeptUi() {
  const f = $('deptForm');
  $('bypassWarn').hidden = f.permission.value !== 'bypassPermissions';
  const codex = f.engine.value === 'codex';
  $('codexFields').hidden = !codex;
  $('deptModelRow').hidden = codex;
  for (const b of $('deptSwatches').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.color === f.color.value));
}

function openDeptDialog(dept = null, presetIndex = '') {
  deptEditing = dept;
  const f = $('deptForm');
  f.reset();
  delete f.id.dataset.touched;
  $('deptError').hidden = true;
  $('deptDialogTitle').textContent = dept ? `${dept.name} 수정` : '부서 만들기';
  $('deptSubmit').textContent = dept ? '저장' : '만들기';
  $('deptPresetRow').hidden = !!dept;
  $('deptPreset').innerHTML = '<option value="">직접 입력</option>' + S.presets.map((p, i) => `<option value="${i}">${esc(p.name)} · ${esc(p.en || '')}</option>`).join('');
  f.id.readOnly = !!dept;
  if (dept) fillDeptForm(dept);
  else if (presetIndex !== '' && S.presets[presetIndex]) { $('deptPreset').value = String(presetIndex); fillDeptForm(S.presets[presetIndex]); } else {
    fillDeptForm({ color: COLORS[S.departments.length % COLORS.length], tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'] });
  }
  $('deptDialog').showModal();
  f.name.focus();
}

async function submitDept(ev) {
  ev.preventDefault();
  const f = $('deptForm');
  const err = $('deptError');
  const name = f.name.value.trim();
  const id = f.id.value.trim();
  const fail = (msg, field) => { err.textContent = msg; err.hidden = false; field?.focus(); };
  if (!name) return fail('부서 이름을 입력해 주세요.', f.name);
  if (!deptEditing && id && !validId(id)) return fail('부서 id는 영문 소문자로 시작하고 소문자·숫자·하이픈 2~48자여야 해요.', f.id);
  const tools = $('toolsAll').checked ? null : [...$('toolChecks').querySelectorAll('input:checked')].map((b) => b.value);
  if (tools && !tools.length) return fail('허용 도구를 하나 이상 고르거나 "제한 없음"을 선택해 주세요.', $('toolsAll'));
  const codexModel = f.codexModel.value.trim();
  if (f.engine.value === 'codex' && codexModel && !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(codexModel)) {
    return fail('Codex 모델 이름은 영문 소문자·숫자·점·하이픈 2~64자여야 해요.', f.codexModel);
  }
  const body = {
    name, en: f.en.value.trim(), color: f.color.value, summary: f.summary.value.trim(),
    instructions: f.instructions.value.trim(),
    engine: f.engine.value, model: f.model.value, permission: f.permission.value,
  };
  // 빈 값은 서버에서 필드 삭제(기본값 사용)로 처리된다
  if (f.engine.value === 'codex') Object.assign(body, { codexModel, codexEffort: f.codexEffort.value });
  else if (deptEditing && (deptEditing.codexModel || deptEditing.codexEffort)) Object.assign(body, { codexModel: '', codexEffort: '' });
  if (!deptEditing && !body.instructions) delete body.instructions;
  // 서버 검증은 tools: null을 거부한다. 빈 배열은 sync에서 '제한 없음'으로 처리된다.
  if (tools) body.tools = tools; else if (deptEditing && Array.isArray(deptEditing.tools) && deptEditing.tools.length) body.tools = [];
  const btn = $('deptSubmit');
  btn.disabled = true;
  try {
    previewCache.clear();
    if (deptEditing) {
      showWarnings(await api('PUT', `/api/departments/${encodeURIComponent(deptEditing.id)}`, body));
      toast(`${name} 부서를 저장했어요.`);
    } else {
      if (id) body.id = id;
      const created = await api('POST', '/api/departments', body);
      const pi = $('deptPreset').value;
      const preset = pi !== '' ? S.presets[pi] : null;
      const newId = created?.id || created?.department?.id || id;
      toast(`${name} 부서가 생겼어요.`, preset?.roles?.length && newId ? { action: { label: '프리셋 인원 추가', fn: () => openBulk(newId, Number(pi)) } } : {});
      showWarnings(created);
    }
    $('deptDialog').close();
    await refresh();
  } catch (e) {
    fail(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function addPresetDept(index, withPeople) {
  const p = S.presets[index];
  if (!p) return;
  const { roles, ...fields } = p;
  const body = { ...fields };
  if (p.id) body.preset = p.id;
  if (S.departments.some((d) => d.id === body.id)) delete body.id;
  try {
    const created = await api('POST', '/api/departments', body);
    const newId = created?.id || created?.department?.id || body.id;
    await refresh();
    toast(`${p.name} 부서가 생겼어요.`);
    showWarnings(created);
    if (withPeople && newId) openBulk(newId, index);
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

// ───── 직원 대화상자 ─────
let agentEditing = null;
let agentRoleKey = null; // 직무 프리셋을 고르면 그 key(직원 role 필드로 저장)
function rolesFor(deptId) { return findPresetFor(deptOf(deptId), S.presets)?.roles || []; }

function takenIds() {
  return new Set([...Object.keys(S.agents), ...S.departments.map((d) => d.id)]);
}

function suggestName(deptId, rank) {
  const used = new Set(Object.values(S.agents).map((a) => a.name));
  const start = (deptOf(deptId)?.members.length || 0) + S.people;
  for (let i = 0; i < SURNAMES.length; i++) {
    const name = SURNAMES[(start + i) % SURNAMES.length] + rank;
    if (!used.has(name)) return name;
  }
  return SURNAMES[start % SURNAMES.length] + rank;
}

function refreshAgentDeptUi() {
  const f = $('agentForm');
  const deptId = f.department.value;
  const roles = rolesFor(deptId);
  $('agentRole').innerHTML = '<option value="">직접 입력</option>' + roles.map((r, i) => `<option value="${i}">${esc(r.name || r.key)}${r.lead ? ' (팀장)' : ''}</option>`).join('');
  if (!agentEditing) {
    if (!f.id.dataset.touched) f.id.value = nextAgentId(deptId, takenIds());
    if (!f.name.dataset.touched) f.name.value = suggestName(deptId, f.rank.value);
  }
  syncLeadWarn();
}

function syncLeadWarn() {
  const f = $('agentForm');
  const dept = deptOf(f.department.value);
  const other = dept?.members.find((m) => m.lead && m.id !== agentEditing?.id);
  const show = f.lead.checked && other;
  $('leadWarn').hidden = !show;
  $('leadWarn').textContent = show ? `이미 팀장(${other.name || other.id})이 있어요. 부서당 팀장은 1명만 둘 수 있어요.` : '';
  return !show;
}

function openAgentDialog({ deptId, agent } = {}) {
  agentEditing = agent || null;
  agentRoleKey = null;
  const f = $('agentForm');
  f.reset();
  delete f.id.dataset.touched;
  delete f.name.dataset.touched;
  $('agentError').hidden = true;
  $('agentDialogTitle').textContent = agent ? `${agent.name || agent.id} 수정` : '직원 추가';
  $('agentSubmit').textContent = agent ? '저장' : '추가';
  $('agentDept').innerHTML = S.departments.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  f.department.value = agent?.department || deptId || S.departments[0]?.id || '';
  f.department.disabled = !!agent;
  f.id.readOnly = !!agent;
  if (agent) {
    f.name.value = agent.name || '';
    f.rank.value = RANKS.includes(agent.rank) ? agent.rank : '대리';
    f.specialty.value = agent.specialty || '';
    f.description.value = agent.description || '';
    f.instructions.value = agent.instructions || '';
    f.thoughts.value = (Array.isArray(agent.thoughts) ? agent.thoughts : []).join('\n');
    f.model.value = agent.model || '';
    f.id.value = agent.id;
    f.lead.checked = !!agent.lead;
    f.active.checked = agent.active !== false;
  }
  refreshAgentDeptUi();
  $('agentDialog').showModal();
  f.name.focus();
}

function applyRole() {
  const f = $('agentForm');
  const role = rolesFor(f.department.value)[Number($('agentRole').value)];
  agentRoleKey = role?.key || null;
  if (!role) return;
  f.specialty.value = role.specialty || role.name || '';
  f.description.value = role.description || '';
  f.instructions.value = role.instructions || '';
  f.thoughts.value = (Array.isArray(role.thoughts) ? role.thoughts : []).join('\n');
  if (role.model) f.model.value = role.model;
  const dept = deptOf(f.department.value);
  if (role.lead && !dept?.members.some((m) => m.lead && m.id !== agentEditing?.id)) {
    f.lead.checked = true;
    f.rank.value = '팀장';
    if (!f.name.dataset.touched && !agentEditing) f.name.value = suggestName(f.department.value, '팀장');
  }
  syncLeadWarn();
}

async function submitAgent(ev) {
  ev.preventDefault();
  const f = $('agentForm');
  const err = $('agentError');
  const fail = (msg, field) => { err.textContent = msg; err.hidden = false; field?.focus(); };
  const name = f.name.value.trim();
  const id = f.id.value.trim();
  if (!f.department.value) return fail('먼저 부서를 만들어 주세요.');
  if (!name) return fail('이름을 입력해 주세요.', f.name);
  if (!agentEditing && !validId(id)) return fail('직원 id는 영문 소문자로 시작하고 소문자·숫자·하이픈 2~48자여야 해요.', f.id);
  if (!agentEditing && takenIds().has(id)) return fail(`id "${id}"는 이미 쓰고 있어요.`, f.id);
  if (!syncLeadWarn()) return fail('팀장은 부서당 1명만 둘 수 있어요.', f.lead);
  const body = {
    name, rank: f.rank.value, lead: f.lead.checked, title: titleFor(f.rank.value, f.lead.checked),
    specialty: f.specialty.value.trim(), description: f.description.value.trim() || f.specialty.value.trim(),
    instructions: f.instructions.value.trim(),
    thoughts: f.thoughts.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5),
    active: f.active.checked,
  };
  if (f.model.value) body.model = f.model.value; else if (agentEditing?.model) body.model = null;
  if (agentRoleKey) body.role = agentRoleKey;
  const btn = $('agentSubmit');
  btn.disabled = true;
  try {
    let saved;
    if (agentEditing) {
      saved = await api('PUT', `/api/agents/${encodeURIComponent(agentEditing.id)}`, body);
      toast(`${name} 정보를 저장했어요.`);
    } else {
      saved = await api('POST', '/api/agents', { id, department: f.department.value, ...body });
      toast(`${name}님이 입사했어요.`);
    }
    showWarnings(saved);
    previewCache.delete(saved?.id || agentEditing?.id || id);
    $('agentDialog').close();
    await refresh();
  } catch (e) {
    fail(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ───── 프리셋 인원 일괄 추가 ─────
let bulkDept = null;
function bulkPlan() {
  const p = S.presets[Number($('bulkPreset').value)];
  const roles = p?.roles || [];
  const checked = new Set([...$('bulkList').querySelectorAll('input:checked')].map((b) => Number(b.value)));
  const picked = roles.map((r, i) => ({ r, i })).filter(({ i }) => checked.has(i));
  const existing = Object.values(S.agents);
  const plans = planBulkAgents(bulkDept, picked.map(({ r }) => r), existing, S.departments.map((d) => d.id));
  return { roles, plans, picked };
}

function renderBulkList() {
  const p = S.presets[Number($('bulkPreset').value)];
  const roles = p?.roles || [];
  // 이미 같은 담당 업무를 가진 직원이 있으면 기본으로 체크 해제
  const have = new Set((deptOf(bulkDept)?.members || []).map((m) => m.specialty).filter(Boolean));
  $('bulkList').innerHTML = roles.length ? roles.map((r, i) => `<label class="bulk-row"><input type="checkbox" value="${i}" ${have.has(r.specialty) ? '' : 'checked'}>
      <span class="br-role"><b>${esc(r.name || r.key)}</b>${r.lead ? ' <span class="badge badge-lead">팀장</span>' : ''}<small>${esc(r.specialty || '')}</small></span>
      <span class="br-plan" data-plan="${i}"></span></label>`).join('') : '<p class="empty">이 프리셋에는 직무가 없어요.</p>';
  updateBulkPlans();
}

// 체크 상태가 바뀌면 이름·id 제안만 다시 계산한다(체크박스 포커스 유지)
function updateBulkPlans() {
  const { plans, picked } = bulkPlan();
  const byIndex = new Map(picked.map(({ i }, k) => [i, plans[k]]));
  for (const span of $('bulkList').querySelectorAll('[data-plan]')) {
    const plan = byIndex.get(Number(span.dataset.plan));
    span.innerHTML = plan ? `${esc(plan.name)} <code>${esc(plan.id)}</code>` : '추가 안 함';
  }
  $('bulkSubmit').textContent = `${plans.length}명 추가`;
  $('bulkSubmit').disabled = !plans.length;
}

function openBulk(deptId, presetIndex) {
  const dept = deptOf(deptId);
  if (!dept && !S.departments.length) return;
  bulkDept = deptId;
  const match = findPresetFor(dept || { id: deptId }, S.presets);
  const idx = presetIndex ?? (match ? S.presets.indexOf(match) : 0);
  $('bulkTitle').textContent = `${dept?.name || deptId} · 프리셋 인원 일괄 추가`;
  $('bulkPreset').innerHTML = S.presets.map((p, i) => `<option value="${i}">${esc(p.name)} (${(p.roles || []).length}개 직무)</option>`).join('');
  $('bulkPreset').value = String(Math.max(0, idx));
  $('bulkError').hidden = true;
  renderBulkList();
  $('bulkDialog').showModal();
}

async function submitBulk(ev) {
  ev.preventDefault();
  const { plans } = bulkPlan();
  const btn = $('bulkSubmit');
  btn.disabled = true;
  let done = 0;
  try {
    for (const plan of plans) {
      btn.textContent = `추가 중 ${done + 1}/${plans.length}…`;
      showWarnings(await api('POST', '/api/agents', agentPayloadFromPlan(bulkDept, plan)));
      done++;
    }
    $('bulkDialog').close();
    toast(`${done}명을 한 번에 채용했어요.`);
  } catch (e) {
    $('bulkError').textContent = `${done}명 추가 후 멈췄어요: ${e.message}`;
    $('bulkError').hidden = false;
  } finally {
    btn.disabled = false;
    await refresh();
    if ($('bulkDialog').open) updateBulkPlans();
  }
}

// ───── 작업 지시 ─────
let runTarget = null;
function openRunDialog(agentId) {
  runTarget = agentId;
  const a = S.agents[agentId];
  $('runTitle').textContent = `${a?.name || agentId}에게 작업 지시`;
  $('runLabel').textContent = `${a?.specialty ? a.specialty + ' 담당 · ' : ''}요청 내용`;
  $('runPrompt').value = '';
  $('runModel').value = '';
  // codex 엔진(검증실) 직원은 Claude 모델 선택 대상이 아니다
  $('runModelRow').hidden = deptOf(a?.department)?.engine === 'codex';
  $('runError').hidden = true;
  $('runDialog').showModal();
  $('runPrompt').focus();
}

async function submitRun(ev) {
  ev.preventDefault();
  const prompt = $('runPrompt').value.trim();
  if (!prompt) { $('runError').textContent = '요청 내용을 입력해 주세요.'; $('runError').hidden = false; return; }
  try {
    const model = $('runModelRow').hidden ? '' : $('runModel').value;
    await api('POST', '/api/runs', { agentId: runTarget, prompt, ...(model ? { model } : {}) });
    $('runDialog').close();
    toast(`${agentName(runTarget)}에게 작업을 지시했어요.`);
    await refresh();
  } catch (e) {
    $('runError').textContent = e.message; $('runError').hidden = false;
  }
}

async function submitChief(ev) {
  ev.preventDefault();
  const input = $('chiefInput');
  const prompt = input.value.trim();
  if (!prompt) { input.focus(); return; }
  try {
    const model = $('chiefModel').value;
    await api('POST', '/api/runs', { prompt, ...(model ? { model } : {}) });
    input.value = '';
    // 데스크톱에서는 상세 패널이 실행 목록 자리를 가리므로 닫아서 시작된 실행을 바로 보이게 한다
    if (ui.drawer) closeDrawer({ restoreFocus: false });
    toast('비서실장에게 업무를 전달했어요. 업무를 나눠 직원들에게 배정합니다.');
    await refresh();
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

// 실행 로그: 기본은 답변·최종 결과만 추린 보기, '원문 보기'로 stream-json 원문을 본다
const logView = { raw: '', readable: '', showRaw: false };
function renderLog() {
  const fallback = logView.raw ? '(답변 텍스트가 없어요. 원문 보기로 확인해 주세요.)' : '(로그가 비어 있어요)';
  $('logText').textContent = logView.showRaw ? (logView.raw || '(로그가 비어 있어요)') : (logView.readable || fallback);
  $('logToggle').textContent = logView.showRaw ? '답변만 보기' : '원문 보기';
  $('logToggle').setAttribute('aria-pressed', String(logView.showRaw));
}

async function showLog(runId) {
  $('logTitle').textContent = `실행 결과 · ${runId}`;
  $('logText').textContent = '불러오는 중…';
  $('logToggle').disabled = true;
  $('logDialog').showModal();
  try {
    const res = await authedGet(`/api/runs/${encodeURIComponent(runId)}/log`);
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* 텍스트 그대로 */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    Object.assign(logView, { raw: text, readable: readableLog(text), showRaw: false });
    $('logToggle').disabled = false;
    renderLog();
  } catch (e) {
    $('logText').textContent = `로그를 불러오지 못했어요: ${e.message}`;
  }
}

// ───── 회사 설정 ─────
async function openCompany() {
  $('companyError').hidden = true;
  $('companyRules').value = '';
  $('companyRules').disabled = true;
  $('companySubmit').disabled = S.demo;
  $('orgImportBtn').disabled = S.demo;
  $('orgImportBtn').title = S.demo ? DEMO_HINT : '';
  $('companyDialog').showModal();
  try {
    const res = await authedGet('/api/company', 'application/json');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    $('companyRules').value = data.rules || '';
  } catch (e) {
    $('companyError').textContent = `불러오지 못했어요: ${e.message}`;
    $('companyError').hidden = false;
  } finally {
    $('companyRules').disabled = false;
    updateCompanyCount();
    $('companyRules').focus();
  }
}

function updateCompanyCount() {
  const n = $('companyRules').value.length;
  $('companyCount').textContent = `${n.toLocaleString()} / 8,000자${S.demo ? ' · 데모 모드에서는 저장할 수 없어요' : ''}`;
}

async function submitCompany(ev) {
  ev.preventDefault();
  const btn = $('companySubmit');
  btn.disabled = true;
  try {
    const out = await api('PUT', '/api/company', { rules: $('companyRules').value });
    previewCache.clear();
    $('companyDialog').close();
    toast(`회사 공통 규칙을 저장했어요. 에이전트 파일 ${out?.sync?.changed?.length ?? 0}개를 갱신했어요.`);
  } catch (e) {
    $('companyError').textContent = e.message;
    $('companyError').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// 회사 구성 내보내기: 토큰이 필요한 GET → 파일 다운로드
async function exportOrgFile() {
  const btn = $('orgExportBtn');
  btn.disabled = true;
  try {
    const res = await authedGet('/api/org/export', 'application/json');
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error; } catch { /* 본문 없음 */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'ai-office-org.json';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`회사 구성을 ${name} 파일로 내보냈어요.`);
  } catch (e) {
    toast(`내보내지 못했어요: ${e.message}`, { type: 'error' });
  } finally {
    btn.disabled = false;
  }
}

// 회사 구성 가져오기: 파일 선택 → 요약 미리보기 → 덮어쓰기 확인 → 저장(서버 검증) → 결과 알림
async function importOrgFile() {
  const input = $('orgImportFile');
  const file = input.files?.[0];
  input.value = ''; // 같은 파일을 다시 고를 수 있게 비운다
  if (!file) return;
  const fail = (msg) => {
    $('companyError').textContent = msg;
    $('companyError').hidden = false;
    toast(msg, { type: 'error' });
  };
  $('companyError').hidden = true;
  if (file.size > 8 * 1024 * 1024) return fail('파일이 너무 커요(최대 8MB).');
  let data;
  try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { return fail('JSON 파일이 아니에요. "회사 구성 내보내기"로 만든 파일을 골라 주세요.'); }
  const sum = summarizeOrgImport(data);
  if (!sum.ok) return fail(sum.error);
  const now = `부서 ${S.departments.length}개 · 직원 ${S.people}명`;
  const next = `부서 ${sum.departments}개 · 직원 ${sum.roster}명${sum.company ? ' · 회사 공통 규칙 포함' : ''}`;
  if (!(await confirmBox(`${file.name}\n가져올 구성: ${next}\n현재 구성(${now})과 회사 공통 규칙을 모두 덮어씁니다. 계속할까요?`, '덮어쓰기'))) return undefined;
  const btn = $('orgImportBtn');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/org/import', { data, mode: 'replace' });
    previewCache.clear();
    $('companyDialog').close();
    toast(`회사 구성을 가져왔어요: 부서 ${out?.departments ?? sum.departments}개 · 직원 ${out?.roster ?? sum.roster}명`);
    showWarnings(out);
    ui.drawer = null;
    await refresh();
  } catch (e) {
    fail(`가져오지 못했어요: ${e.message}`);
  } finally {
    btn.disabled = S.demo;
  }
  return undefined;
}

// ───── 공통 동작 ─────
async function act(btn) {
  const { act: action, id, dept, run } = btn.dataset;
  if (S.demo && WRITE_ACTS.has(action)) { toast(DEMO_HINT); return undefined; }
  try {
    switch (action) {
      case 'new-dept': return openDeptDialog();
      case 'add-preset': return addPresetDept(Number(btn.dataset.preset), btn.dataset.bulk === '1');
      case 'open-agent': return openDrawer('agent', id);
      case 'open-dept': return openDrawer('dept', id);
      case 'add-agent': return openAgentDialog({ deptId: dept });
      case 'bulk': return openBulk(dept);
      case 'edit-agent': return openAgentDialog({ agent: S.agents[id] });
      case 'edit-dept': return openDeptDialog(deptOf(id));
      case 'run-agent': return openRunDialog(id);
      case 'log-run': return showLog(run);
      case 'focus-room': setView('office'); office?.focusDept(id); return;
      case 'stop-run': {
        if (!run) return;
        await api('POST', `/api/runs/${encodeURIComponent(run)}/stop`);
        toast('중지 요청을 보냈어요.');
        return refresh();
      }
      case 'duty-agent': {
        const a = S.agents[id];
        const next = a.active === false;
        const saved = await api('POST', `/api/agents/${encodeURIComponent(id)}/duty`, { active: next });
        toast(`${a.name || id}: ${next ? '근무' : '휴무'}로 바꿨어요.`);
        showWarnings(saved);
        return refresh();
      }
      case 'duty-dept': {
        const d = deptOf(id);
        await api('PUT', `/api/departments/${encodeURIComponent(id)}`, { active: !d.active });
        toast(`${d.name}: ${d.active ? '휴무' : '근무'}로 바꿨어요.`);
        return refresh();
      }
      case 'del-agent': {
        const a = S.agents[id];
        if (!(await confirmBox(`${a?.name || id} 직원을 삭제할까요? 에이전트 파일도 함께 지워집니다.`))) return;
        await api('DELETE', `/api/agents/${encodeURIComponent(id)}`);
        ui.drawer = null;
        toast(`${a?.name || id} 직원을 삭제했어요.`);
        return refresh();
      }
      case 'del-dept': return deleteDept(id);
      default: return undefined;
    }
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
  return undefined;
}

async function deleteDept(id) {
  const d = deptOf(id);
  const n = d?.memberCount || 0;
  const msg = n ? `${d.name} 부서와 소속 직원 ${n}명을 모두 삭제할까요? 되돌릴 수 없어요.` : `${d?.name || id} 부서를 삭제할까요?`;
  if (!(await confirmBox(msg))) return;
  const path = `/api/departments/${encodeURIComponent(id)}${n ? '?cascade=1' : ''}`;
  try {
    await api('DELETE', path);
  } catch (e) {
    if (e.status !== 409) throw e;
    if (!(await confirmBox(`${e.message}\n소속 직원까지 함께 삭제할까요?`))) return;
    await api('DELETE', `/api/departments/${encodeURIComponent(id)}?cascade=1`);
  }
  ui.drawer = null;
  toast(`${d?.name || id} 부서를 삭제했어요.`);
  await refresh();
}

function setView(view) {
  ui.view = view === 'office' ? 'office' : 'control';
  store('ai-office-view', ui.view);
  for (const tab of document.querySelectorAll('.view-tabs [role="tab"]')) {
    const on = tab.dataset.view === ui.view;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  render();
}

function setTheme(theme) {
  ui.theme = theme === 'pastel' ? 'pastel' : 'neon';
  document.documentElement.dataset.theme = ui.theme;
  $('themeLabel').textContent = ui.theme === 'neon' ? 'NEON' : 'PASTEL';
  $('themeToggle').setAttribute('aria-label', `화면 테마 전환 (현재 ${ui.theme === 'neon' ? '네온' : '파스텔'})`);
  office?.setTheme(ui.theme);
  store('ai-office-theme', ui.theme);
}

function setPatrol(on) {
  ui.patrol = !!on;
  $('patrolBtn').setAttribute('aria-pressed', String(ui.patrol));
  office?.setPatrol(ui.patrol);
  render();
}

function tick() {
  const now = new Date();
  $('clock').textContent = now.toTimeString().slice(0, 8);
  $('clock').dateTime = now.toISOString();
}

function init() {
  token = document.querySelector('meta[name="office-token"]')?.content || '';
  setTheme(store('ai-office-theme') || 'neon');
  ui.view = store('ai-office-view') === 'office' ? 'office' : 'control';

  $('deptSwatches').innerHTML = COLORS.map((c) => `<button type="button" class="swatch" style="--c:${c}" data-color="${c}" aria-label="색 ${c}" aria-pressed="false"></button>`).join('');
  $('toolChecks').innerHTML = TOOLS.map((t) => `<label class="inline"><input type="checkbox" value="${t}"> ${t}</label>`).join('');

  office = createOffice($('officeCanvas'), {
    onAgentClick: (id) => openDrawer('agent', id),
    onRoomClick: (id) => openDrawer('dept', id),
    onAddAgent: (id) => (S.demo ? toast(DEMO_HINT) : openAgentDialog({ deptId: id })),
    onPatrolChange: (on) => { ui.patrol = on; $('patrolBtn').setAttribute('aria-pressed', String(on)); },
  });
  office.setTheme(ui.theme);

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (btn && !btn.disabled) act(btn);
    const close = ev.target.closest('[data-close]');
    if (close) close.closest('dialog')?.close();
    const banner = ev.target.closest('[data-banner]');
    if (banner) { ui.dismissedBanners.add(banner.dataset.banner); renderBanners(); }
  });
  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ui.drawer && !document.querySelector('dialog[open]')) closeDrawer();
  });
  $('drawerClose').addEventListener('click', () => closeDrawer());
  $('themeToggle').addEventListener('click', () => setTheme(ui.theme === 'neon' ? 'pastel' : 'neon'));
  $('addDeptBtn').addEventListener('click', () => openDeptDialog());
  $('companyBtn').addEventListener('click', openCompany);
  $('companyForm').addEventListener('submit', submitCompany);
  $('companyRules').addEventListener('input', updateCompanyCount);
  $('orgExportBtn').addEventListener('click', exportOrgFile);
  $('orgImportBtn').addEventListener('click', () => $('orgImportFile').click());
  $('orgImportFile').addEventListener('change', importOrgFile);
  // 지침 미리보기는 펼칠 때 불러온다(toggle 이벤트는 버블링되지 않아 캡처로 받는다)
  document.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!(d instanceof HTMLElement) || !d.matches('details[data-preview]')) return;
    ui.previewOpen = d.open ? d.dataset.preview : null;
    if (d.open && !previewCache.has(d.dataset.preview)) loadPreview(d);
  }, true);
  $('chiefForm').addEventListener('submit', submitChief);
  const tabs = [...document.querySelectorAll('.view-tabs [role="tab"]')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
    tab.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus(); setView(next.dataset.view);
    });
  });
  $('zoomIn').addEventListener('click', () => office.zoomIn());
  $('zoomOut').addEventListener('click', () => office.zoomOut());
  $('zoomFit').addEventListener('click', () => office.fit());
  $('patrolBtn').addEventListener('click', () => setPatrol(!ui.patrol));

  const df = $('deptForm');
  df.addEventListener('submit', submitDept);
  $('deptPreset').addEventListener('change', () => {
    const p = S.presets[Number($('deptPreset').value)];
    fillDeptForm(p || { color: df.color.value });
  });
  df.en.addEventListener('input', () => { if (!deptEditing && !df.id.dataset.touched) df.id.value = kebab(df.en.value); });
  df.id.addEventListener('input', () => { df.id.dataset.touched = '1'; });
  df.permission.addEventListener('change', syncDeptUi);
  for (const r of df.querySelectorAll('input[name="engine"]')) r.addEventListener('change', syncDeptUi);
  df.color.addEventListener('input', syncDeptUi);
  $('deptSwatches').addEventListener('click', (ev) => {
    const b = ev.target.closest('.swatch');
    if (b) { df.color.value = b.dataset.color; syncDeptUi(); }
  });
  $('toolsAll').addEventListener('change', () => {
    for (const box of $('toolChecks').querySelectorAll('input')) box.disabled = $('toolsAll').checked;
  });

  const af = $('agentForm');
  af.addEventListener('submit', submitAgent);
  af.department.addEventListener('change', refreshAgentDeptUi);
  $('agentRole').addEventListener('change', applyRole);
  af.lead.addEventListener('change', syncLeadWarn);
  af.id.addEventListener('input', () => { af.id.dataset.touched = '1'; });
  af.name.addEventListener('input', () => { af.name.dataset.touched = '1'; });
  af.rank.addEventListener('change', () => { if (!agentEditing && !af.name.dataset.touched) af.name.value = suggestName(af.department.value, af.rank.value); });

  $('bulkForm').addEventListener('submit', submitBulk);
  $('bulkPreset').addEventListener('change', renderBulkList);
  $('bulkList').addEventListener('change', updateBulkPlans);
  $('runForm').addEventListener('submit', submitRun);
  $('logToggle').addEventListener('click', () => { logView.showRaw = !logView.showRaw; renderLog(); });

  tick();
  setInterval(tick, 1000);
  setInterval(() => { if (lastRaw) render(); }, 15000);
  setView(ui.view);
  refresh().then(connect);
}

if (typeof document !== 'undefined' && document.getElementById('app')) init();
