// AGENT HQ 대시보드. 바닐라 ES 모듈, 빌드 없이 서버가 그대로 제공한다.
// 순수 함수는 export 해서 Node 테스트에서 쓰고, DOM 코드는 브라우저에서만 실행한다.
import { createOffice, avatarDataURL, ATTENTION_ICONS, meetingAttendees } from './office.js';

export const RANKS = ['사원', '주임', '대리', '과장', '차장', '부장', '팀장'];
export const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit', 'TodoWrite'];
export const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
export const COLORS = ['#38bdf8', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#fb7185', '#22d3ee', '#f97316', '#84cc16', '#e879f9'];
// idle(상단 IDLE)은 '근무 중이지만 오늘 활동 없음'이다. '근무중'은 휴무와 짝을 이루는 근무 상태라 쓰지 않는다
export const STATUS_LABEL = { working: '작업중', standby: '대기', idle: '오늘 활동 없음', 'off-duty': '휴무', offline: '오프라인' };
const RUN_LABEL = { running: '실행 중', queued: '대기열', done: '완료', failed: '실패', stopped: '중지됨' };
const TASK_LABEL = { active: '진행', review: '사용자 확인', done: '완료', blocked: '막힘' };
const KIND_LABEL = {
  'session.start': '세션 시작', request: '요청', 'agent.start': '업무 시작', 'agent.stop': '업무 완료',
  'tool.start': '도구', 'tool.end': '도구 완료', 'turn.end': '응답 완료', 'review.start': '리뷰 시작',
  'review.end': '리뷰 판정', 'task.start': '업무 등록', 'task.update': '업무 갱신', 'reply.wait': '답변 대기',
  'meeting.start': '회의 시작', 'meeting.end': '회의 종료', 'plan.set': '계획 확정',
};
export const VIEWS = ['control', 'office', 'org', 'outputs'];
const BASE_TITLE = 'AGENT HQ · AI Office';
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
    needsReply: m.needsReply ?? (raw.runs || []).filter((r) => r?.needsReply).length,
  };
  const feed = [...(raw.feed || [])].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const unregistered = (raw.unregistered || []).map((u) => (typeof u === 'string' ? { id: u } : u))
    .concat(all.filter((a) => a.department && !deptIds.has(a.department)).map((a) => ({ id: a.id, name: a.name })));
  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  return {
    departments, agents, metrics, feed, unregistered,
    people: departments.reduce((n, d) => n + d.memberCount, 0),
    runs,
    flow: normalizeFlow(raw.flow),
    hasFlow: raw.flow !== undefined && raw.flow !== null,
    attention: normalizeAttention(raw.attention, runs),
    meetings: normalizeMeetings(raw.meetings),
    gaps: collectGaps(raw),
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
// 실행 요청 요약. 예전 사용자 반려 실행은 시스템이 만든 프롬프트(업무 id·안내문)가 저장돼 있어 '사용자 반려'로만 보여준다
function runText(run) {
  const text = run.request ?? run.prompt ?? run.title ?? '';
  return /^\[사용자 반려\]/.test(text) ? '사용자 반려(피드백 전달)' : text;
}
function runResult(run) { return run.summary ?? run.result ?? run.lastOutput ?? ''; }
function runStart(run) { return run.startedAt ?? run.createdAt ?? run.started ?? run.created ?? null; }
function runWho(run) {
  const id = runAgentId(run);
  if (!id && (run.target === 'review' || run.engine === 'codex')) return '검증실 리뷰';
  return agentName(id);
}

// 같은 대화(rootId) 묶음을 시간순으로. 예전 run(rootId 없음)은 자기 자신이 묶음의 시작이다
export function threadOf(runs, runId) {
  const list = Array.isArray(runs) ? runs : [];
  const run = list.find((r) => r?.id === runId);
  if (!run) return [];
  const root = run.rootId || run.id;
  return list.filter((r) => r && (r.rootId || r.id) === root)
    .sort((a, b) => String(a.createdAt || runStart(a) || '').localeCompare(String(b.createdAt || runStart(b) || '')));
}

// 가장 최근에 답변을 기다리기 시작한 run(상단 '답변 필요' 칩에서 연다)
export function latestNeedsReply(runs) {
  return (Array.isArray(runs) ? runs : []).filter((r) => r?.needsReply && r.status !== 'running' && r.status !== 'queued')
    .sort((a, b) => String(b.endedAt || b.createdAt || '').localeCompare(String(a.endedAt || a.createdAt || '')))[0] || null;
}

// 답변 전문(마크다운) → 블록 목록. 화면은 이 결과를 textContent로만 그린다(원문을 innerHTML에 넣지 않는다).
// 블록: {type:'heading', level, inline} | {type:'para', inline} | {type:'list', ordered, items:[inline]} | {type:'code', text} | {type:'rule'}
// inline: [{t:'text'|'b'|'code', v}]
export function parseInline(text) {
  const out = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  for (const m of String(text ?? '').matchAll(re)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    out.push(m[0].startsWith('**') ? { t: 'b', v: m[0].slice(2, -2) } : { t: 'code', v: m[0].slice(1, -1) });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? '').length) out.push({ t: 'text', v: String(text).slice(last) });
  return out;
}

export function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) blocks.push({ type: 'para', inline: parseInline(para.join('\n')) });
    para = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]); i += 1) body.push(lines[i]);
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, inline: parseInline(h[2]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ type: 'rule' }); continue; }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = !li[1];
      if (para.length) { blocks.push({ type: 'para', inline: parseInline(para.join('\n')) }); para = []; }
      if (!list || list.ordered !== ordered) {
        if (list) blocks.push(list);
        list = { type: 'list', ordered, items: [], ...(ordered ? { start: Number(li[2]) || 1 } : {}) };
      }
      list.items.push(parseInline(li[3]));
      continue;
    }
    if (list) { blocks.push(list); list = null; }
    para.push(line.replace(/^>\s?/, ''));
  }
  flush();
  return blocks;
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

// 부서색 등 CSS 값에 넣는 색은 #hex만 받는다(그 밖은 기본색)
export function safeColor(value, fallback = '#38bdf8') {
  return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? value : fallback;
}

// ───────────────────── 업무 흐름(deriveFlow 항목) ─────────────────────
// 항목: {task, ts, stage, from, to, actor, dept, text, detail?, files?}
export const FLOW_STEPS = [
  { key: 'request', label: '요청' }, { key: 'intake', label: '확인' }, { key: 'assign', label: '하달' },
  { key: 'progress', label: '진행' }, { key: 'cooperate', label: '협조' }, { key: 'review', label: '검토' },
  { key: 'user', label: '사용자 확인' }, { key: 'done', label: '완료' },
];
const STAGE_STEP = {
  request: 'request', intake: 'intake', meeting: 'intake', kickoff: 'assign', assign: 'assign', accept: 'progress',
  progress: 'progress', done: 'progress', cooperate: 'cooperate',
  review_request: 'review', review_pass: 'review', review_reject: 'review', codex_review: 'review',
  deliver: 'user', user_reject: 'user', user_approve: 'done',
};
export const STAGE_LABEL = {
  request: '업무 요청', intake: '내용 확인', meeting: '회의', kickoff: '하달 킥오프', assign: '업무 하달', accept: '업무 전달받음',
  progress: '진행 중', done: '작업 완료', cooperate: '업무 협조 요청', review_request: '검토 요청',
  review_pass: '검토 통과', review_reject: '검토 반려', deliver: '사용자 확인 대기', user_approve: '사용자 승인',
  user_reject: '사용자 반려', codex_review: '검증실 검토', reply_wait: '답변 대기',
};
const STEP_INDEX = Object.fromEntries(FLOW_STEPS.map((s, i) => [s.key, i]));

export function stepIndexOf(stage) {
  const key = STAGE_STEP[stage];
  return key ? STEP_INDEX[key] : -1;
}

// /api/state의 flow: 배열(기본) · {items:[]} · {업무 id: [항목]} 형태를 모두 받아 시간순 배열로 만든다
export function normalizeFlow(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.items)) list = raw.items;
    else for (const [task, arr] of Object.entries(raw)) if (Array.isArray(arr)) list.push(...arr.map((it) => ({ task, ...it })));
  }
  return list.filter((it) => it && typeof it === 'object' && typeof it.stage === 'string')
    .map((it, i) => ({ it, i }))
    .sort((a, b) => String(a.it.ts || '').localeCompare(String(b.it.ts || '')) || a.i - b.i)
    .map(({ it }) => it);
}

export function flowForTask(flow, taskId) {
  return (Array.isArray(flow) ? flow : []).filter((it) => (it.task || '') === (taskId || ''));
}

// 받침에 따라 '으로'/'로'(ㄹ 받침은 '로')를 붙인다: 진행으로, 하달로, 사용자 확인으로
export function withRo(word) {
  const ch = String(word ?? '').trim().slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  if (!(code >= 0 && code <= 11171)) return `${word}(으)로`;
  const jong = code % 28;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

// 업무 카드의 단계 표시줄. 반려는 되돌아간 단계(검토 반려 → 진행, 사용자 반려 → 하달)와 횟수를 낸다
// 반환: {steps:[{key,label,state:'done'|'current'|'skip'|'todo'}], current, rejects, back:{from,to}|null}
export function taskSteps(task = {}, flow = []) {
  const items = flowForTask(flow, task.id);
  const visited = new Set();
  let cur = -1;
  let rejects = 0;
  let back = null;
  for (const it of items) {
    const i = stepIndexOf(it.stage);
    if (i < 0) continue;
    if (it.stage === 'review_reject' || it.stage === 'user_reject') {
      rejects += 1;
      const to = it.stage === 'user_reject' ? STEP_INDEX.assign : STEP_INDEX.progress;
      back = { from: i, to };
      visited.add(i);
      cur = to;
      continue;
    }
    visited.add(i);
    cur = Math.max(cur, i);
  }
  // 명시 단계(서버가 준 task.stage: 단계 key 또는 흐름 stage)가 더 앞서 있으면 그것을 쓴다
  const hinted = STEP_INDEX[task.stage] ?? stepIndexOf(task.stage);
  if (hinted > cur) { cur = hinted; visited.add(hinted); }
  if (task.status === 'review') { cur = Math.max(cur, STEP_INDEX.user); visited.add(STEP_INDEX.user); }
  const finished = task.status === 'done';
  if (finished) { cur = STEP_INDEX.done; visited.add(cur); }
  const serverRejects = (Number.isInteger(task.rejects) ? task.rejects : 0) + (Number.isInteger(task.userRejects) ? task.userRejects : 0);
  if (serverRejects > rejects) rejects = serverRejects;
  if (cur < 0 && items.length) cur = 0;
  let steps = FLOW_STEPS.map((s, i) => {
    let state = 'todo';
    if (i === cur) state = finished ? 'done' : 'current';
    else if (i < cur) state = visited.has(i) ? 'done' : 'skip';
    return { ...s, state };
  });
  // 서버(lib/flow.mjs)가 계산한 단계 상태가 있으면 그것을 정본으로 쓴다(최근 피드만 받는 화면보다 정확하다)
  const STATES = ['done', 'current', 'skip', 'todo'];
  if (Array.isArray(task.steps) && task.steps.length === FLOW_STEPS.length && task.steps.every((x) => STATES.includes(x?.state))) {
    const localCur = cur;
    steps = FLOW_STEPS.map((s, i) => ({ ...s, state: task.steps[i].state }));
    const c = steps.findIndex((x) => x.state === 'current');
    cur = c >= 0 ? c : steps.map((x) => x.state).lastIndexOf('done');
    // 서버 표시줄은 도달한 가장 먼 단계를 현재로 둔다. 반려로 되돌아가 다시 진행 중이면 되돌아간 단계를 현재로 보여준다
    if (back && !finished && task.status !== 'review' && localCur >= 0 && localCur < cur) {
      steps[cur] = { ...steps[cur], state: 'done' };
      steps[localCur] = { ...steps[localCur], state: 'current' };
      cur = localCur;
    }
  }
  return { steps, current: cur, rejects, back: rejects ? back || (task.userRejects ? { from: STEP_INDEX.user, to: STEP_INDEX.assign } : { from: STEP_INDEX.review, to: STEP_INDEX.progress }) : null };
}

// 실시간 피드(업무 언어): 업무별로 묶고, progress는 직원별 마지막 1줄만 남긴다.
// 직원의 done이 오면 그 직원의 진행 줄은 지운다(끝난 작업은 완료 줄로 대체). 최근 활동한 업무가 먼저 온다
export function groupFlowFeed(flow = [], { maxGroups = 12, maxItems = 30 } = {}) {
  const groups = new Map();
  const who = (it) => it.actor || it.from || it.agent || '';
  for (const it of flow) {
    const key = it.task || '';
    let g = groups.get(key);
    if (!g) { g = { task: key, items: [], last: '' }; groups.set(key, g); }
    if (it.stage === 'progress' || it.stage === 'done') {
      const id = who(it);
      g.items = g.items.filter((x) => !(x.stage === 'progress' && who(x) === id));
    }
    g.items.push(it);
    if (String(it.ts || '') > g.last) g.last = String(it.ts || '');
  }
  return [...groups.values()]
    .sort((a, b) => b.last.localeCompare(a.last))
    .slice(0, maxGroups)
    .map((g) => ({ ...g, hidden: Math.max(0, g.items.length - maxItems), items: g.items.slice(-maxItems) }));
}

const PLAN_STATUS = {
  wait: 'wait', pending: 'wait', todo: 'wait', 대기: 'wait',
  run: 'run', running: 'run', active: 'run', progress: 'run', 진행: 'run',
  done: 'done', complete: 'done', completed: 'done', 완료: 'done',
  reject: 'reject', rejected: 'reject', 반려: 'reject',
  done_missing_output: 'missing',
};
export const PLAN_STATUS_LABEL = { wait: '대기', run: '진행', done: '완료', reject: '반려', missing: '완료(산출물 없음)' };

// plan.json 단계별 상태. 서버가 stage.status를 주면 그대로 쓰고, 없으면 흐름 항목에서 stage.agent를 매칭해 도출한다
export function planStages(plan, flow = [], taskId) {
  const stages = Array.isArray(plan?.stages) ? plan.stages.filter((s) => s && typeof s === 'object') : [];
  const items = taskId ? flowForTask(flow, taskId) : flow;
  const status = new Map(stages.map((s) => [s.id, PLAN_STATUS[s.status] || null]));
  const derived = stages.filter((s) => !status.get(s.id));
  const touched = new Set();
  for (const it of items) {
    const ids = new Set([it.agent, it.to, it.actor, it.target].filter(Boolean));
    for (const s of derived) {
      const mine = (s.agent && ids.has(s.agent)) || (it.stageId && it.stageId === s.id);
      if (it.stage === 'review_reject') {
        const toDept = it.to && it.to === s.dept && touched.has(s.id);
        if ((mine && it.to === s.agent) || toDept) status.set(s.id, 'reject');
        continue;
      }
      if (!mine) continue;
      if (['assign', 'cooperate', 'accept', 'progress', 'meeting'].includes(it.stage)) {
        if (it.stage !== 'meeting') { status.set(s.id, 'run'); touched.add(s.id); }
      } else if (it.stage === 'done' && (it.actor === s.agent || it.agent === s.agent)) {
        status.set(s.id, 'done'); touched.add(s.id);
      }
    }
  }
  return stages.map((s) => ({ ...s, status: status.get(s.id) || 'wait' }));
}

// 회의실 상태(state.meetings): 진행 중인 하달 킥오프·실제 회의와 대기 중인 킥오프
export function normalizeMeetings(raw) {
  return (Array.isArray(raw) ? raw : []).filter((m) => m && typeof m === 'object' && typeof m.task === 'string'
    && (m.kind === 'kickoff' || m.kind === 'meeting') && typeof m.since === 'string')
    .map((m) => ({ ...m, attendees: Array.isArray(m.attendees) ? m.attendees.filter((a) => typeof a === 'string' && a) : [] }));
}

// 업무 묶음 머리의 회의실 표시: 킥오프 중 / 회의실 대기 / 회의 중(없으면 '')
export function meetingBadge(meetings = [], taskId, now = Date.now()) {
  let label = '';
  for (const m of meetings) {
    if (!m || m.task !== taskId) continue;
    const since = Date.parse(m.since);
    const until = Date.parse(m.until);
    if (m.kind === 'meeting' && !m.waiting) return '회의 중';
    if (m.kind !== 'kickoff') continue;
    if (Number.isFinite(until) && now >= until) continue;
    // 끝 기록 없는 회의 뒤에서 기다리는 킥오프는 until이 없고 since가 요청 시각(과거)이라, 여는 시각이 정해진(until 있음) 대기만 since로 승격한다(activeRoom과 같은 기준)
    if (!m.waiting || (Number.isFinite(since) && Number.isFinite(until) && since <= now)) return '킥오프 중';
    label = '회의실 대기';
  }
  return label;
}

// ───── 비서실장 입력창의 승인·반려 인식 ─────
// 사용자 확인 대기 업무가 있을 때 "승인"·"반려 …" 같은 입력을 새 비서실장 실행으로 보내지 않고 승인·반려 API로 처리한다.
// 승인은 입력 전체가 승인 표현일 때만(앞에 '좋아'·'네' 정도는 허용), 반려는 '반려'·'다시 해'·'수정해'로 시작할 때다.
// 질문(?로 끝남, '볼까'·'줄래'처럼 물음 어미로 끝남), 부정·취소('승인하지 마', '반려 안 해', '반려 취소'), 승인과 반려가 섞인 입력은 애매하므로 실행으로 보낸다
const APPROVE_INPUT = /^(?:(?:좋아요?|좋습니다|네|예|응|그래요?|확인했(?:어요|습니다)?)\s*[,.]?\s*)?(?:승인|통과|ok|okay|오케이)(?:\s*(?:해|해요|해\s*줘|해\s*주세요|합니다|할게|할게요|처리해|처리해\s*줘|처리해\s*주세요|시켜|시켜\s*줘|이요|입니다))?\s*[.!~]*$/i;
// 반려 표현 뒤의 말이 부정·취소로 시작하면(띄어 쓴 '반려 하지 마', '반려 안 해', '반려 취소'·'철회'·'보류', '반려. 아니 됐다') 애매하다
const REJECT_NEGATION = /^(?:하지|말고|말아|마(?:라|요|세요|십시오)?(?=$|[\s,.!~])|안\s*(?:해|하|할|함|돼|되|됨|된)|못\s*(?:해|하)|취소|철회|보류|아니|ㄴㄴ|금지|그만|됐)/;
// 물음표 없이 물음 어미로 끝나는 말('다시 해 볼까', '수정해 줄래')
const QUESTION_ENDING = /(?:까|래|나|니|냐)요?\s*[.!~]*$/;
const MIXED_APPROVE = /승인|통과|오케이|(?:^|[^a-z])ok(?:ay)?(?![a-z])/i;
const REJECT_INPUT = /^(?:반려(?:합니다|할게요?|해요|해\s*줘|해\s*주세요|해)?|다시\s*해(?:\s*줘|\s*주세요|요)?|수정해(?:\s*줘|\s*주세요|요)?)(?=$|[\s,.:;!~\u2014-])[\s,.:;!~\u2014-]*([\s\S]*)$/;

export function classifyChiefInput(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /[?？]\s*$/.test(s)) return { intent: null };
  if (APPROVE_INPUT.test(s)) return { intent: 'approve' };
  const m = s.match(REJECT_INPUT);
  if (m) {
    const feedback = m[1].trim();
    if (MIXED_APPROVE.test(feedback) || REJECT_NEGATION.test(feedback) || QUESTION_ENDING.test(feedback)) return { intent: null };
    return { intent: 'reject', feedback };
  }
  return { intent: null };
}

// 입력창 → 처리 방법. review 업무가 없거나 판정이 애매하면 {action:'run'}(기존대로 비서실장 실행).
// review 업무가 1건이면 taskId, 여러 건이면 choices(사용자가 고른다)
export function chiefInputAction(text, tasks = []) {
  const review = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.status === 'review' && typeof t.id === 'string');
  const c = classifyChiefInput(text);
  if (!c.intent || !review.length) return { action: 'run' };
  const base = c.intent === 'reject' ? { action: 'reject', feedback: c.feedback } : { action: 'approve' };
  return review.length === 1 ? { ...base, taskId: review[0].id } : { ...base, choices: review.map((t) => t.id) };
}

// ───────────────────── 사용자 의견 필요(attention) ─────────────────────
export const ATTENTION_KINDS = ['reply', 'approve', 'gap'];
const ATTN_PRIORITY = { approve: 0, reply: 1, gap: 2 };
export const ATTENTION_LABEL = { reply: '답변 필요', approve: '사용자 확인', gap: '역량 공백' };

// state.attention(since 오름차순). 서버가 아직 주지 않으면 needsReply run으로 reply 항목을 만든다
export function normalizeAttention(raw, runs = []) {
  const bySince = (a, b) => String(a.since || '').localeCompare(String(b.since || ''));
  if (Array.isArray(raw)) {
    return raw.filter((a) => a && ATTENTION_KINDS.includes(a.kind)).map((a) => ({ ...a, agent: a.agent || 'chief' })).sort(bySince);
  }
  return (Array.isArray(runs) ? runs : []).filter((r) => r?.needsReply && r.status !== 'running' && r.status !== 'queued')
    .map((r) => ({ kind: 'reply', agent: runAgentId(r) || 'chief', runId: r.id, since: r.endedAt || r.createdAt || '', text: r.summary || '' }))
    .sort(bySince);
}

export function attentionKey(a) {
  return [a?.kind, a?.agent, a?.runId || '', a?.task || '', a?.since || ''].join('|');
}

// 직원별 대표 아이콘: 사용자 확인 > 답변 > 공백, 같으면 오래된 것
export function attentionByAgent(list = []) {
  const map = new Map();
  for (const a of list) {
    const id = a.agent || 'chief';
    const entry = map.get(id) || { items: [], top: null };
    entry.items.push(a);
    if (!entry.top || ATTN_PRIORITY[a.kind] < ATTN_PRIORITY[entry.top.kind]
      || (ATTN_PRIORITY[a.kind] === ATTN_PRIORITY[entry.top.kind] && String(a.since || '') < String(entry.top.since || ''))) entry.top = a;
    map.set(id, entry);
  }
  return map;
}

export function titleWithAttention(base, count) {
  return count > 0 ? `(${count}) 답변 필요 · ${base}` : base;
}

// 처음 본 attention만 고른다(브라우저 알림은 항목마다 1회)
export function freshAttention(list, seen) {
  return list.filter((a) => !seen.has(attentionKey(a)));
}

// 역량 공백: state.gaps → task.gaps → task.plan.gaps 순서로 모은다
export function collectGaps(raw = {}) {
  const out = [];
  const push = (g, task) => {
    if (!g) return;
    const item = typeof g === 'string' ? { need: g } : g;
    if (!item.need && !item.text) return;
    const key = `${task || item.task || ''}|${item.need || item.text}`;
    if (!out.some((x) => x.key === key)) out.push({ ...item, task: task || item.task || '', key });
  };
  if (Array.isArray(raw.gaps)) raw.gaps.forEach((g) => push(g, g?.task));
  for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
    for (const g of [...(Array.isArray(t?.gaps) ? t.gaps : []), ...(Array.isArray(t?.plan?.gaps) ? t.plan.gaps : [])]) push(g, t.id);
  }
  return out;
}

// ───────────────────── 산출물 ─────────────────────
export const TASK_STATUS_LABEL = { active: '진행', review: '사용자 확인', done: '완료', blocked: '막힘' };

export function normalizeOutputs(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data?.outputs) ? data.outputs : [];
  return list.filter((t) => t && (t.id || t.taskId)).map((t) => {
    const id = t.id || t.taskId;
    const date = t.date || (/^\d{4}-\d{2}-\d{2}/.exec(id)?.[0] ?? '');
    return {
      ...t, id, date, title: t.title || id.split('/').pop(), status: t.status || 'active',
      departments: Array.isArray(t.departments) ? t.departments : Array.isArray(t.depts) ? t.depts : [],
    };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created || '').localeCompare(String(a.created || '')) || String(b.id).localeCompare(String(a.id)));
}

export function filterOutputs(list, { q = '', date = '', dept = '', status = '' } = {}) {
  const needle = String(q).trim().toLowerCase();
  return list.filter((t) => (!date || t.date === date)
    && (!dept || t.departments.includes(dept))
    && (!status || t.status === status)
    && (!needle || `${t.title} ${t.id}`.toLowerCase().includes(needle)));
}

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'toml', 'ini']);
// 'markdown' | 'json' | 'text' | 'html' | 'binary'
export function fileKind(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1]?.toLowerCase() || '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'json') return 'json';
  return TEXT_EXT.has(ext) ? 'text' : 'binary';
}

const ROOT_FILES = { 'report.md': 'report', 'meeting.md': 'meeting', 'plan.json': 'plan', 'brief.md': 'brief', 'review-notes.md': 'notes' };
// GET /api/outputs/:taskId/files 응답 → {report, meeting, plan, brief, notes, reviews:[], common:[], depts:[[부서 id, files]]}
export function groupOutputFiles(data, taskId = '') {
  const raw = Array.isArray(data) ? data : Array.isArray(data?.files) ? data.files : [];
  const files = raw.filter((f) => f && (f.path || f.name)).map((f) => {
    const p = String(f.path || `${taskId}/${f.name}`).replace(/\\/g, '/');
    const idx = taskId ? p.indexOf(`${taskId}/`) : -1;
    const rel = String(f.rel || (idx >= 0 ? p.slice(idx + taskId.length + 1) : f.name || p.split('/').pop()));
    return { ...f, path: p, rel, name: f.name || rel.split('/').pop() };
  });
  const out = { report: null, meeting: null, plan: null, brief: null, notes: null, reviews: [], common: [], depts: [] };
  const depts = new Map();
  for (const f of files) {
    const parts = f.rel.split('/');
    if (parts.length === 1 && ROOT_FILES[f.rel] && !out[ROOT_FILES[f.rel]]) { out[ROOT_FILES[f.rel]] = f; continue; }
    if (parts[0] === 'reviews' || f.kind === 'review') { out.reviews.push(f); continue; }
    const dept = f.dept || f.department || (parts.length > 1 ? parts[0] : '');
    if (!dept) { out.common.push(f); continue; }
    if (!depts.has(dept)) depts.set(dept, []);
    depts.get(dept).push(f);
  }
  out.depts = [...depts.entries()];
  return out;
}

// 태그 입력(쉼표·줄바꿈 구분) → 중복 없는 배열
export function parseTags(text, max = 20) {
  const seen = new Set();
  const out = [];
  for (const t of String(text || '').split(/[,\n]/)) {
    const v = t.trim().slice(0, 40);
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out.slice(0, max);
}

function hms(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

function pad3(n) { return String(Math.max(0, Number(n) || 0)).padStart(3, '0'); }

// ───────────────────────── 브라우저 전용 ─────────────────────────
const $ = (id) => document.getElementById(id);
const ui = {
  view: 'control', theme: 'neon', drawer: null, patrol: false, previewOpen: null, dismissedBanners: new Set(),
  feedDetail: false, notify: false, approve: null, feedOpen: new Set(),
  out: { list: null, loading: false, error: '', sel: null, sig: '', loadedAt: 0, files: new Map() },
};
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
  // 다시 그려도 입력 중인 글자(조직 탭 태그 입력 등)는 유지한다
  const typed = [...el.querySelectorAll('input[data-key]')].filter((i) => i.value).map((i) => [i.dataset.key, i.value]);
  el.innerHTML = html;
  el._html = html;
  for (const [k, v] of typed) { const i = el.querySelector(`input[data-key="${CSS.escape(k)}"]`); if (i) i.value = v; }
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
const WRITE_ACTS = new Set(['new-dept', 'add-preset', 'add-agent', 'bulk', 'edit-agent', 'edit-dept', 'run-agent', 'stop-run', 'duty-agent', 'duty-dept', 'del-agent', 'del-dept',
  'approve-task', 'reject-task', 'cap-del', 'handoff-del']);
const DEMO_HINT = '데모 모드에서는 보기만 가능해요.';
function applyDemoLock() {
  if (!S.demo) return;
  for (const b of document.querySelectorAll('[data-act]')) {
    if (WRITE_ACTS.has(b.dataset.act) && !b.disabled) { b.disabled = true; b.title = DEMO_HINT; }
  }
  for (const el of document.querySelectorAll('[data-cap-input], [data-handoff-add]')) if (!el.disabled) { el.disabled = true; el.title = DEMO_HINT; }
  for (const id of ['addDeptBtn', 'chiefSubmit', 'chiefInput', 'chiefModel', 'threadSend', 'threadPrompt', 'threadModel']) {
    const el = $(id);
    if (el && !el.disabled) { el.disabled = true; el.title = DEMO_HINT; }
  }
  $('chiefInput').placeholder = '데모 모드에서는 업무를 지시할 수 없어요(보기 전용). npm run office로 실행해 주세요.';
}

// ───── 렌더링 ─────
function render() {
  renderTop();
  const empty = S.departments.length === 0;
  const v = ui.view;
  // 부서가 없으면 관제·사무실 자리에 온보딩을 보여준다. 조직·산출물 탭은 그대로 쓸 수 있다
  const onboarding = empty && (v === 'control' || v === 'office');
  $('viewOnboarding').hidden = !onboarding;
  $('viewControl').hidden = onboarding || v !== 'control';
  $('viewOffice').hidden = onboarding || v !== 'office';
  $('viewOrg').hidden = v !== 'org';
  $('viewOutputs').hidden = v !== 'outputs';
  if (onboarding) renderOnboarding();
  renderOrg();
  if (v === 'control') renderControl();
  if (v === 'org') renderOrgView();
  if (v === 'outputs') renderOutputs();
  renderFeed();
  renderTasks();
  renderDrawer();
  if (ui.thread) renderThread();
  if (ui.approve) renderApprove();
  if (office) {
    office.update({
      departments: S.departments, feed: S.feed, chief: S.agents.chief || null,
      attention: attentionIcons(), meeting: meetingAttendees(S.feed, S.flow), handoffs: handoffList(),
      meetings: S.meetings.map((m) => ({ ...m, title: taskTitle(m.task) })),
    });
    office.setVisible(!onboarding && v === 'office');
    office.setSelected(ui.drawer?.type === 'agent' || ui.drawer?.type === 'chief' ? ui.drawer.id : null);
    const working = S.departments.reduce((n, d) => n + d.activeCount, 0);
    $('officeCaption').textContent = `${S.departments.length}개 부서 · ${S.people}명 · 작업 중 ${working}명${S.attention.length ? ` · 의견 필요 ${S.attention.length}건` : ''}${ui.patrol ? ' · 자동 순찰 중' : ''}`;
  }
  updateTitle();
  notifyAttention();
  applyDemoLock();
}

// 사무실 캔버스용: 직원 id → 대표 아이콘 종류
function attentionIcons() {
  const map = new Map();
  for (const [id, entry] of attentionByAgent(S.attention)) map.set(id, entry.top.kind);
  return map;
}

// 협조 요청 항목 → 서류 전달 연출(부서 id 기준)
function deptIdOf(id, fallback) {
  if (!id) return fallback || '';
  if (deptOf(id)) return id;
  return S.agents[id]?.department || fallback || '';
}
// 넘기는 사람은 보낸 부서에서 그 업무를 마지막으로 끝낸 직원, 받는 사람은 협조 요청 대상 직원이다
function handoffList() {
  return S.flow.filter((it) => it.stage === 'cooperate').slice(-20).map((it) => {
    const from = deptIdOf(it.from);
    let giver = null;
    for (const x of S.flow) {
      if (String(x.ts || '') > String(it.ts || '')) break;
      if (x.stage === 'done' && x.mode !== 'meeting' && x.task === it.task && x.actor && deptIdOf(x.actor) === from) giver = x.actor;
    }
    return { key: `${it.ts}|${it.task}|${it.from}|${it.to}`, ts: it.ts, from, to: deptIdOf(it.to, it.dept), fromAgent: giver, toAgent: it.target || null };
  });
}

function updateTitle() {
  const title = titleWithAttention(BASE_TITLE, S.attention.length);
  if (document.title !== title) document.title = title;
}

// ───── 사용자 의견 필요(attention) ─────
const svgCache = {};
// 캔버스와 같은 픽셀 비트맵으로 SVG 아이콘을 만든다(이모지 대신, 두 테마에서 같은 모양)
function attnSvg(kind) {
  if (svgCache[kind]) return svgCache[kind];
  const bmp = ATTENTION_ICONS[kind] || ATTENTION_ICONS.reply;
  let rects = '';
  bmp.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c !== '.') rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" class="px-${c === '#' ? 'l' : c}"/>`;
    }
  });
  svgCache[kind] = `<svg class="px-icon" viewBox="0 0 ${bmp[0].length} ${bmp.length}" width="${bmp[0].length * 2}" height="${bmp.length * 2}" aria-hidden="true" focusable="false" shape-rendering="crispEdges">${rects}</svg>`;
  return svgCache[kind];
}

function clipText(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function attnLabel(a) {
  const who = agentName(a.agent);
  if (a.kind === 'approve') return `사용자 확인 대기: ${taskTitle(a.task)}`;
  if (a.kind === 'gap') return `역량 공백: ${clipText(a.text, 80)}`;
  return `${who}님이 답변을 기다립니다${a.text ? ` — ${clipText(a.text, 80)}` : ''}`;
}

function attnButton(a, key) {
  if (!a) return '';
  return `<button type="button" class="attn attn-${esc(a.kind)}" data-act="attn" data-attn="${esc(attentionKey(a))}" data-key="${esc(key)}" aria-label="${esc(attnLabel(a))}" title="${esc(attnLabel(a))}">${attnSvg(a.kind)}</button>`;
}

function attnFor(agentId) { return attentionByAgent(S.attention).get(agentId) || null; }

function taskTitle(id) {
  const t = S.tasks.find((x) => x.id === id);
  return t?.title || id || '업무';
}

function openAttention(a) {
  if (!a) return undefined;
  if (a.kind === 'reply') {
    if (a.runId && S.runs.some((r) => r.id === a.runId)) return openThread(a.runId);
    return a.agent === 'chief' ? openDrawer('chief', 'chief') : openDrawer('agent', a.agent);
  }
  if (a.kind === 'approve') {
    const id = a.task || S.tasks.find((t) => t.status === 'review')?.id;
    return id ? openApprove(id) : toast('확인할 업무를 찾지 못했어요.', { type: 'warn' });
  }
  return openGap(a);
}

function openAttentionByKey(key) {
  const a = S.attention.find((x) => attentionKey(x) === key);
  if (a) return openAttention(a);
  toast('이미 처리된 항목이에요.');
  return undefined;
}

// 브라우저 알림(기본 꺼짐): 새 attention마다 1회. 처음 받은 목록은 알리지 않는다
const seenAttention = new Set();
let attentionSeeded = false;
function notifyAttention() {
  const fresh = freshAttention(S.attention, seenAttention);
  for (const a of fresh) seenAttention.add(attentionKey(a));
  if (!attentionSeeded) { attentionSeeded = lastRaw !== null; return; }
  if (!ui.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const a of fresh.slice(0, 3)) {
    try {
      const n = new Notification(`AI Office · ${ATTENTION_LABEL[a.kind]}`, { body: attnLabel(a), tag: attentionKey(a) });
      n.onclick = () => { window.focus(); openAttention(a); n.close(); };
    } catch { /* 알림을 띄울 수 없는 환경 */ }
  }
}

function setNotify(on) {
  ui.notify = !!on;
  store('ai-office-notify', ui.notify ? '1' : '0');
  const btn = $('notifyBtn');
  btn.setAttribute('aria-pressed', String(ui.notify));
  btn.textContent = ui.notify ? '알림 켜짐' : '알림 꺼짐';
}

async function toggleNotify() {
  if (ui.notify) { setNotify(false); toast('브라우저 알림을 껐어요.'); return; }
  if (typeof Notification === 'undefined') { toast('이 브라우저는 알림을 지원하지 않아요.', { type: 'warn' }); return; }
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; } }
  if (perm !== 'granted') { toast('브라우저 설정에서 이 페이지의 알림을 허용해야 켤 수 있어요.', { type: 'warn' }); return; }
  setNotify(true);
  toast('새로 의견이 필요한 항목이 생기면 브라우저 알림으로 알려 드려요.');
}

// ───── 상단 ─────
function renderTop() {
  const m = S.metrics;
  const chips = [['active', 'ACTIVE'], ['standby', 'STANDBY'], ['idle', 'IDLE'], ['off', 'OFF'], ['tasks', 'TASKS'], ['reviews', 'REVIEWS'], ['tools', 'TOOLS']];
  const n = S.attention.length;
  // '답변 필요' 칩: attention 수. 누르면 가장 오래 기다린 항목부터 연다
  const replyChip = n ? `<li class="metric m-reply"><button type="button" class="metric-btn" data-act="attn" data-attn="${esc(attentionKey(S.attention[0]))}" data-key="m-reply" title="가장 오래 기다린 항목 열기: ${esc(attnLabel(S.attention[0]))}"><span class="metric-label">답변 필요</span><b class="metric-val">${esc(n)}</b></button></li>` : '';
  setHTML($('metrics'), replyChip + chips.map(([k, label]) =>
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

function presetCards(prefix) {
  return S.presets.map((p, i) => `
    <article class="preset-card" style="--dept:${esc(safeColor(p.color, COLORS[i % COLORS.length]))}">
      <div class="preset-top"><span class="dc-icon" aria-hidden="true">${esc((p.en || p.name || '?').slice(0, 1))}</span>
        <div><h4>${esc(p.name)}</h4><span class="dc-en">${esc(p.en || '')}</span></div>
        <span class="engine engine-${esc(p.engine === 'codex' ? 'codex' : 'claude')}">${esc(p.engine || 'claude')}</span></div>
      <p>${esc(p.summary || '')}</p>
      ${Array.isArray(p.capabilities) && p.capabilities.length ? `<p class="tags">${p.capabilities.slice(0, 5).map((c) => `<span class="tag-chip">${esc(c)}</span>`).join('')}</p>` : ''}
      <div class="preset-meta">직무 프리셋 ${(p.roles || []).length}개${S.departments.some((d) => d.id === p.id) ? ' · 이미 있음' : ''}</div>
      <div class="preset-actions">
        <button type="button" class="btn btn-sm" data-act="add-preset" data-preset="${i}" data-key="${prefix}a-${i}" aria-label="${esc(p.name)} 부서만 추가">부서만 추가</button>
        <button type="button" class="btn btn-sm btn-primary" data-act="add-preset" data-preset="${i}" data-bulk="1" data-key="${prefix}b-${i}" aria-label="${esc(p.name)} 부서와 프리셋 인원 추가">인원까지 추가</button>
      </div>
    </article>`).join('');
}

function renderOnboarding() {
  const cards = presetCards('p');
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
  const chiefAttn = attnFor('chief');
  const chief = S.agents.chief;
  const chiefRow = `<li class="org-dept org-chief" style="--dept:#fbbf24"><div class="row-with-attn">
      <button type="button" class="org-dept-btn" data-act="open-chief" data-key="od-chief"><i class="dept-dot" aria-hidden="true"></i><span class="org-name">비서실장</span>${statusDot(chief?.status || 'idle')}</button>
      ${attnButton(chiefAttn?.top, 'oat-chief')}</div></li>`;
  const depts = S.departments.map((d) => `
    <li class="org-dept${d.active ? '' : ' is-off'}" style="--dept:${esc(safeColor(d.color))}">
      <button type="button" class="org-dept-btn" data-act="open-dept" data-id="${esc(d.id)}" data-key="od-${esc(d.id)}">
        <i class="dept-dot" aria-hidden="true"></i><span class="org-name">${esc(d.name)}</span>
        <span class="org-count" aria-label="작업 ${d.activeCount}명, 전체 ${d.memberCount}명">${d.activeCount}/${d.memberCount}</span>
      </button>
      <ul class="org-members">${d.members.map((a) => `
        <li class="row-with-attn"><button type="button" class="org-member" data-act="open-agent" data-id="${esc(a.id)}" data-key="oa-${esc(a.id)}">
          ${avatar(a.id)}<span class="om-name">${esc(a.name || a.id)}</span><small>${esc(rankLabel(a))}</small>${statusDot(a.status)}
        </button>${attnButton(attnFor(a.id)?.top, `oat-${a.id}`)}</li>`).join('')}
        <li><button type="button" class="org-add" data-act="add-agent" data-dept="${esc(d.id)}" data-key="oadd-${esc(d.id)}">+ 직원 추가</button></li>
      </ul>
    </li>`).join('');
  const unreg = S.unregistered.length ? `
    <div class="org-unreg"><h3>미등록 에이전트</h3><ul>${S.unregistered.map((u) => `<li>${esc(u.name || u.id)}</li>`).join('')}</ul></div>` : '';
  setHTML($('orgTree'), `
    <div class="org-head"><span>${S.departments.length}개 부서 · ${total}명</span>
      <button type="button" class="btn btn-sm" data-act="new-dept" data-key="org-new">+ 부서</button></div>
    <ul class="org-list">${chiefRow}${depts}</ul>${S.departments.length ? '' : '<p class="empty">아직 부서가 없어요.</p>'}${unreg}`);
}

// 직원의 현재 상태 한 줄. 대기열 실행이 있으면 함께 알린다
function statusLine(a) {
  let text;
  if (a.status === 'working') text = [a.lastTool, a.lastSummary].filter(Boolean).join(' · ') || '작업 중';
  else if (a.status === 'idle' || a.status === 'off-duty') text = STATUS_LABEL[a.status];
  else text = `${STATUS_LABEL[a.status] || a.status} · ${timeAgo(a.lastEvent?.ts || a.lastEvent)}`;
  return a.queued ? `실행 대기열 · ${text}` : text;
}

function liveRow(a, prefix = 'lr') {
  const tool = statusLine(a);
  return `<li class="row-with-attn"><button type="button" class="live-row" data-act="open-agent" data-id="${esc(a.id)}" data-key="${prefix}-${esc(a.id)}">
    ${avatar(a.id)}<span class="lr-main"><b>${esc(a.name || a.id)}</b> <small>${esc(rankLabel(a))}</small><span class="lr-tool">${esc(tool)}</span></span>${statusDot(a.status)}
  </button>${attnButton(attnFor(a.id)?.top, `${prefix}a-${a.id}`)}</li>`;
}

// 관제 뷰 맨 위: 사용자 확인 대기·답변 필요·역량 공백 카드
function attentionCards() {
  const cards = [];
  for (const a of S.attention) {
    if (a.kind === 'gap') continue;
    const k = attentionKey(a);
    if (a.kind === 'approve') {
      const task = S.tasks.find((t) => t.id === a.task);
      cards.push(`<article class="attn-card ac-approve">
        <div class="ac-head">${attnSvg('approve')}<b>사용자 확인 대기</b><time>${esc(timeAgo(a.since))}</time></div>
        <p class="ac-title">${esc(task?.title || a.task || '업무')}</p>
        ${a.text ? `<p class="ac-text">${esc(clipText(a.text, 140))}</p>` : ''}
        <div class="ac-actions">
          <button type="button" class="btn btn-sm" data-act="out-show" data-task="${esc(a.task || '')}" data-key="aco-${esc(k)}">산출물 보기</button>
          <button type="button" class="btn btn-sm btn-primary" data-act="approve-task" data-task="${esc(a.task || '')}" data-key="aca-${esc(k)}">승인</button>
          <button type="button" class="btn btn-sm btn-danger" data-act="reject-task" data-task="${esc(a.task || '')}" data-key="acr-${esc(k)}">반려(피드백)</button>
        </div></article>`);
    } else {
      cards.push(`<article class="attn-card ac-reply">
        <div class="ac-head">${attnSvg('reply')}<b>${esc(agentName(a.agent))}님이 답변을 기다립니다</b><time>${esc(timeAgo(a.since))}</time></div>
        ${a.text ? `<p class="ac-text">${esc(clipText(a.text, 160))}</p>` : ''}
        <div class="ac-actions"><button type="button" class="btn btn-sm btn-primary" data-act="attn" data-attn="${esc(k)}" data-key="acy-${esc(k)}">대화 보기 · 답하기</button></div></article>`);
    }
  }
  const gaps = S.gaps.length ? S.gaps : S.attention.filter((a) => a.kind === 'gap').map((a) => ({ need: a.text, task: a.task, key: attentionKey(a) }));
  for (const g of gaps) cards.push(gapCard(g, 'acg'));
  return cards.join('');
}

function gapCard(g, prefix, withAction = true) {
  return `<article class="attn-card ac-gap">
    <div class="ac-head">${attnSvg('gap')}<b>역량 공백</b>${g.task ? `<span class="ac-task">${esc(taskTitle(g.task))}</span>` : ''}</div>
    <p class="ac-title">${esc(g.need || g.text || '')}${g.suggestion ? ` <span class="ac-arrow" aria-hidden="true">→</span> <span class="ac-sugg">${esc(g.suggestion)}</span>` : ''}</p>
    ${withAction ? `<div class="ac-actions"><button type="button" class="btn btn-sm" data-act="go-org" data-key="${prefix}-${esc(g.key || g.need || '')}">조직 탭으로</button></div>` : ''}</article>`;
}

function renderControl() {
  const total = S.people;
  $('controlSub').textContent = `${S.departments.length}개 부서 실시간 운영 · 총 ${total}명`;
  setHTML($('attnStrip'), attentionCards());
  setHTML($('deptGrid'), S.departments.map((d) => {
    const pct = Math.round(d.progress * 100);
    const live = d.members.filter((m) => m.status === 'working');
    const rows = (live.length ? live.slice(0, 4) : d.members.filter((m) => m.status !== 'off-duty').slice(0, 3));
    const more = live.length > 4 ? `<li class="lr-more">외 ${live.length - 4}명 작업 중</li>` : '';
    // 카드 머리: 구성원 중 가장 급한 의견 필요 아이콘
    const deptAttn = attentionByAgent(S.attention.filter((a) => d.members.some((m) => m.id === a.agent)));
    const topDept = [...deptAttn.values()].map((e) => e.top).sort((x, y) => String(x.since || '').localeCompare(String(y.since || '')))[0];
    // 의견이 필요한 직원은 LIVE 목록에 함께 보이게 한다
    for (const m of d.members) if (deptAttn.has(m.id) && !rows.includes(m)) rows.push(m);
    return `
    <article class="dept-card${d.active ? '' : ' is-off'}${live.length ? ' is-live' : ''}" style="--dept:${esc(safeColor(d.color))}" aria-labelledby="dc-${esc(d.id)}">
      <header class="dc-head">
        <span class="dc-icon" aria-hidden="true">${esc((d.en || d.name || '?').slice(0, 1))}</span>
        <div class="dc-title">
          <h3 id="dc-${esc(d.id)}"><button type="button" class="link" data-act="open-dept" data-id="${esc(d.id)}" data-key="dct-${esc(d.id)}">${esc(d.name)}</button></h3>
          <span class="dc-en">UNIT ${esc(d.en || d.id)} · ${esc(d.engine || 'claude')}${d.model ? ' · ' + esc(d.model) : ''}</span>
        </div>
        ${attnButton(topDept, `dch-${d.id}`)}
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
        ${rows.length ? `<ul>${rows.map((a) => liveRow(a)).join('')}${more}</ul>` : '<p class="empty">직원이 없어요. 아래에서 추가해 보세요.</p>'}
      </div>
      <footer class="dc-foot">
        <button type="button" class="btn btn-sm" data-act="add-agent" data-dept="${esc(d.id)}" data-key="dca-${esc(d.id)}">+ 직원 추가</button>
        ${findPresetFor(d, S.presets) ? `<button type="button" class="btn btn-sm" data-act="bulk" data-dept="${esc(d.id)}" data-key="dcb-${esc(d.id)}">프리셋 인원</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-act="open-dept" data-id="${esc(d.id)}" data-key="dcd-${esc(d.id)}">상세 ›</button>
      </footer>
    </article>`;
  }).join(''));
}

// ───── 실시간 피드 ─────
// 흐름 항목의 from/to/actor → 표시 이름과 부서색
function party(id) {
  if (!id) return null;
  if (id === 'user' || id === 'ceo') return { label: '대표', color: '#f472b6', title: '사용자(대표)' };
  if (id === 'chief') return { label: '비서실장', color: '#fbbf24', title: '비서실장(메인 세션)' };
  const d = deptOf(id);
  if (d) return { label: d.name, color: d.color, title: d.name };
  const a = S.agents[id];
  if (a && !a.unregistered && a.department) {
    const dd = deptOf(a.department);
    return { label: a.name || id, color: dd?.color, title: `${dd?.name || ''} ${a.name || id}`.trim() };
  }
  return { label: id, color: '#94a3b8', title: id };
}

// 부서 id → 이름(조직에 없으면 같은 id의 프리셋 이름, 그래도 없으면 id)
function deptLabel(id) {
  return deptOf(id)?.name || (Array.isArray(S.presets) ? S.presets.find((p) => p && p.id === id)?.name : null) || id;
}

function partyChip(id) {
  const p = party(id);
  return p ? `<span class="pchip" style="--dept:${esc(safeColor(p.color, '#94a3b8'))}" title="${esc(p.title)}">${esc(p.label)}</span>` : '';
}

function flowLine(it) {
  // 진행·완료·전달받음은 실제 직원(actor), 하달·협조·회의·반려는 대상 직원(target)이 있으면 그 직원을 보여준다
  const own = it.stage === 'progress' || it.stage === 'done' || it.stage === 'accept';
  const from = (own && it.actor) || it.from || '';
  const to = it.stage === 'progress' || it.stage === 'accept' ? '' : (it.target || it.to || '');
  const arrow = from && to && from !== to
    ? `${partyChip(from)}<span class="arrow" aria-label="에서">→</span>${partyChip(to)}`
    : partyChip(from || to || it.actor || it.dept);
  const files = Array.isArray(it.files) && it.files.length ? `<p class="fl-files">${it.files.slice(0, 4).map((f) => `<span class="tag-chip">${esc(String(f).split(/[\\/]/).pop())}</span>`).join('')}</p>` : '';
  // 답변 대기: 아직 답하지 않은 실행이면 대화 창을 여는 버튼을 단다
  const waiting = it.stage === 'reply_wait' && it.run && S.runs.some((r) => r.id === it.run && r.needsReply);
  const action = waiting ? `<button type="button" class="btn btn-sm fi-action" data-act="open-thread" data-run="${esc(it.run)}" data-key="flr-${esc(it.run)}">대화 보기</button>` : '';
  return `<li class="fl-item fs-${esc(it.stage)}${it.warn ? ' is-warn' : ''}">
    <time datetime="${esc(it.ts)}">${hms(it.ts)}</time>
    <div class="fi-body"><div class="fi-line">${arrow}<span class="fl-stage">${esc(STAGE_LABEL[it.stage] || it.stage)}</span></div>
      ${it.text ? `<p>${esc(it.text)}</p>` : ''}${files}${action}</div></li>`;
}

const FEED_GROUP_ITEMS = 6;

function renderFeed() {
  const btn = $('feedDetailBtn');
  btn.setAttribute('aria-pressed', String(ui.feedDetail));
  if (ui.feedDetail) return renderToolFeed();
  // 업무마다 최근 FEED_GROUP_ITEMS줄만 보여준다(최근 업무가 위, 업무 안의 최신 줄이 상자 위쪽에 보이게). 펼치면 30줄까지
  const groups = groupFlowFeed(S.flow, { maxItems: 30 }).map((g) => {
    const open = ui.feedOpen.has(g.task);
    const shown = open ? g.items : g.items.slice(-FEED_GROUP_ITEMS);
    return { ...g, open, folded: g.items.length - shown.length, items: shown };
  });
  $('feedCount').textContent = groups.length ? `업무 ${groups.filter((g) => g.task).length}건` : '';
  if (!groups.length) {
    const hint = S.hasFlow ? '아직 업무 흐름이 없어요. 비서실장에게 업무를 지시하면 요청 → 하달 → 진행 → 검토 순서로 여기에 쌓여요.'
      : '업무 흐름 정보를 받지 못했어요. "상세 보기"로 도구 이벤트를 볼 수 있어요.';
    setHTML($('feed'), `<li class="empty">${esc(hint)}</li>`);
    return undefined;
  }
  setHTML($('feed'), groups.map((g) => {
    const task = S.tasks.find((t) => t.id === g.task);
    const st = g.task ? taskSteps(task || { id: g.task }, S.flow) : null;
    const cur = st && st.current >= 0 ? FLOW_STEPS[st.current].label : '';
    const meet = g.task ? meetingBadge(S.meetings, g.task) : '';
    return `<li class="flow-group">
      <div class="fg-head">${g.task ? `<b>${esc(task?.title || g.task)}</b>${cur ? `<span class="fg-step">${esc(cur)}</span>` : ''}${meet ? `<span class="fg-meet${meet === '회의실 대기' ? ' is-wait' : ''}">${esc(meet)}</span>` : ''}${st?.rejects ? `<span class="fg-reject" title="반려 횟수">↩ ${st.rejects}</span>` : ''}` : '<b>업무 외 활동</b>'}</div>
      ${(g.open ? g.items.length > FEED_GROUP_ITEMS : g.folded) ? `<button type="button" class="btn btn-sm btn-ghost fg-more" data-act="feed-more" data-task="${esc(g.task)}" data-key="fm-${esc(g.task)}" aria-expanded="${g.open}">${g.open ? '최근 줄만 보기' : `이전 ${g.folded}건 보기`}</button>` : ''}
      ${g.hidden && g.open ? `<p class="help fg-more">그보다 이전 ${g.hidden}건은 생략</p>` : ''}
      <ol class="fg-items">${g.items.map(flowLine).join('')}</ol></li>`;
  }).join(''));
  return undefined;
}

function renderToolFeed() {
  const items = S.feed.slice(0, 120);
  $('feedCount').textContent = items.length ? `최근 ${S.feed.length}건` : '';
  setHTML($('feed'), items.length ? items.map((e) => {
    const name = agentName(e.agent);
    const kind = KIND_LABEL[e.kind] || e.kind || '';
    const verdict = e.verdict ? `<span class="verdict v-${esc(String(e.verdict).toLowerCase())}">${esc(e.verdict)}</span>` : '';
    if (e.kind === 'reply.wait') {
      const hasRun = e.run && S.runs.some((r) => r.id === e.run);
      return `<li class="feed-item k-reply-wait">
      <time datetime="${esc(e.ts)}">${hms(e.ts)}</time>
      <div class="fi-body"><div class="fi-line">${e.agent && e.agent !== 'chief' ? avatar(e.agent, 'ava-sm') : '<span class="ava ava-sm ava-chief" aria-hidden="true">★</span>'}<b>${esc(name)}</b><span class="kind">님이 답변을 기다립니다</span></div>
      ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
      ${hasRun ? `<button type="button" class="btn btn-sm fi-action" data-act="open-thread" data-run="${esc(e.run)}" data-key="fr-${esc(e.run)}">대화 보기</button>` : ''}</div></li>`;
    }
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

// 단계 표시줄: 요청 → 확인 → 하달 → 진행 → 협조 → 검토 → 사용자 확인 → 완료
function stepperHtml(task, compact = false) {
  const st = taskSteps(task, S.flow);
  const cur = st.current >= 0 ? FLOW_STEPS[st.current].label : '시작 전';
  const items = st.steps.map((s, i) => `<li class="step s-${s.state}${st.back && i === st.back.to ? ' is-back' : ''}"${s.state === 'current' ? ' aria-current="step"' : ''}><span class="step-dot" aria-hidden="true"></span><span class="step-label">${esc(s.label)}</span></li>`).join('');
  const back = st.rejects && st.back
    ? `<p class="reject-note"><span aria-hidden="true">↩</span> 반려 ${st.rejects}회 · ${esc(FLOW_STEPS[st.back.from].label)}에서 ${esc(withRo(FLOW_STEPS[st.back.to].label))} 되돌림</p>` : '';
  return `<ol class="stepper${compact ? ' is-compact' : ''}" aria-label="업무 단계 — 현재: ${esc(cur)}">${items}</ol>${back}`;
}

function planHtml(task, plan) {
  const stages = planStages(plan, S.flow, task.id);
  if (!stages.length) return '';
  return `<ol class="plan-line" aria-label="작업 계획 단계">${stages.map((s) => {
    const d = deptOf(s.dept);
    const who = s.agent ? agentName(s.agent) : '';
    return `<li class="ps ps-${esc(s.status)}" style="--dept:${esc(safeColor(d?.color, '#94a3b8'))}"><b>${esc(s.title || s.id)}</b><small>${esc([d?.name || s.dept, who].filter(Boolean).join(' · '))}</small><span class="ps-st">${esc(PLAN_STATUS_LABEL[s.status])}</span></li>`;
  }).join('')}</ol>`;
}

// 완료로 표시됐지만 산출물 파일이 없는 계획 단계(서버가 파일을 확인한 결과)
function missingOutputsHtml(task) {
  const ids = Array.isArray(task.missingOutputs) ? task.missingOutputs : [];
  if (!ids.length) return '';
  const titles = ids.map((id) => task.plan?.stages?.find((st) => st.id === id)?.title || id);
  return `<p class="warn missing-out" role="note">⚠ 산출물 없이 완료된 단계 ${ids.length}개: ${esc(titles.slice(0, 4).join(', '))}${ids.length > 4 ? ' 외' : ''} — 검토 전에 파일을 확인하세요.</p>`;
}

function renderTasks() {
  const tasks = [...S.tasks].sort((a, b) => (b.status === 'review') - (a.status === 'review')).slice(0, 30);
  const runs = [...S.runs].sort((a, b) => String(runStart(b) || '').localeCompare(String(runStart(a) || ''))).slice(0, 30);
  const taskHtml = tasks.map((t) => {
    const reviews = taskReviews(t);
    const hasReport = t.report ?? t.hasReport;
    const approve = S.attention.find((a) => a.kind === 'approve' && a.task === t.id);
    return `<li class="task task-${esc(t.status || 'active')}">
      <div class="task-top"><span class="tag t-${esc(t.status)}">${esc(TASK_LABEL[t.status] || t.status || '진행')}</span><b>${esc(t.title || t.id)}</b>${attnButton(approve, `ta-${t.id}`)}</div>
      ${stepperHtml(t, true)}
      ${t.plan ? planHtml(t, t.plan) : ''}
      ${missingOutputsHtml(t)}
      <div class="task-meta"><code>${esc(t.id)}</code>
        ${hasReport === undefined ? '' : `<span class="${hasReport ? 'ok' : 'muted'}">${hasReport ? '보고서 ✓' : '보고서 없음'}</span>`}
        ${reviews.map((r) => `<span class="verdict v-${esc(String(r.verdict || 'none').toLowerCase())}" title="${esc(agentName(r.reviewer))}">${esc(agentName(r.reviewer).replace(/ \(미등록\)$/, ''))} ${esc(r.verdict || '…')}</span>`).join('')}
      </div>
      <div class="run-actions">
        ${t.status === 'review' ? `<button type="button" class="btn btn-sm btn-primary" data-act="open-approve" data-task="${esc(t.id)}" data-key="tap-${esc(t.id)}">사용자 확인</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-act="out-show" data-task="${esc(t.id)}" data-key="tos-${esc(t.id)}">산출물</button>
      </div></li>`;
  }).join('');
  const runHtml = runs.map((r) => {
    const live = r.status === 'running' || r.status === 'queued';
    const who = runWho(r);
    return `<li class="run run-${esc(r.status)}${r.needsReply ? ' run-needs-reply' : ''}">
      <div class="task-top"><span class="tag r-${esc(r.status)}">${esc(RUN_LABEL[r.status] || r.status)}</span><b>${esc(who)}</b>${r.engine === 'codex' ? '<span class="engine engine-codex">codex</span>' : ''}${replyBadge(r, `rb-${r.id}`)}<time>${esc(timeAgo(runStart(r)))}</time></div>
      <p class="run-text">${r.parentId ? '<span class="reply-mark" title="이어서 답한 실행">↳ 답장</span> ' : ''}${esc(runText(r))}</p>
      ${runResult(r) && !live ? `<p class="run-result">${esc(String(runResult(r)).slice(0, 160))}</p>` : ''}
      <div class="run-actions">
        ${live ? `<button type="button" class="btn btn-sm btn-danger" data-act="stop-run" data-run="${esc(r.id)}" data-key="rs-${esc(r.id)}">중지</button>` : ''}
        ${r.canReply || r.parentId ? `<button type="button" class="btn btn-sm" data-act="open-thread" data-run="${esc(r.id)}" data-key="rt-${esc(r.id)}">대화</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-act="log-run" data-run="${esc(r.id)}" data-key="rl-${esc(r.id)}">로그</button>
      </div></li>`;
  }).join('');
  setHTML($('tasks'), `
    <h3 class="sub-title">업무 <span>${S.tasks.length}</span></h3>
    ${taskHtml ? `<ul class="task-list">${taskHtml}</ul>` : '<p class="empty">등록된 업무가 없어요.</p>'}
    <h3 class="sub-title">실행 <span>진행 ${S.runs.filter((r) => r.status === 'running').length}건${S.runs.some((r) => r.status === 'queued') ? ` · 대기 ${S.runs.filter((r) => r.status === 'queued').length}건` : ''}</span></h3>
    ${runHtml ? `<ul class="task-list">${runHtml}</ul>` : '<p class="empty">실행 기록이 없어요. 위 입력창이나 직원 프로필에서 작업을 지시해 보세요.</p>'}`);
}

// '답변 필요' 배지(누르면 대화 보기)
function replyBadge(run, key) {
  if (!run?.needsReply) return '';
  return `<button type="button" class="badge badge-reply" data-act="open-thread" data-run="${esc(run.id)}" data-key="${esc(key)}" title="대화 보기·이어서 답하기">답변 필요</button>`;
}

function latestRun(agentId) {
  return S.runs.filter((r) => runAgentId(r) === agentId).sort((a, b) => String(runStart(b) || '').localeCompare(String(runStart(a) || '')))[0];
}

function renderDrawer() {
  const drawer = $('drawer');
  const d = ui.drawer;
  const target = d && (d.type === 'chief' ? (S.agents.chief || { id: 'chief', name: '비서실장', status: 'idle' })
    : d.type === 'agent' ? S.agents[d.id] : deptOf(d.id));
  if (!d || !target) {
    if (d && !target) ui.drawer = null;
    drawer.hidden = true;
    document.body.classList.remove('has-drawer');
    return;
  }
  drawer.hidden = false;
  document.body.classList.add('has-drawer');
  if (d.type === 'chief') {
    $('drawerTitle').textContent = '비서실장';
    setHTML($('drawerBody'), chiefProfile(target));
  } else if (d.type === 'agent') {
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
      ${attnButton(attnFor(a.id)?.top, 'pa-attn-icon')}
    </div>
    ${attentionSection(a.id)}
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
        <div class="task-top"><span class="tag r-${esc(run.status)}">${esc(RUN_LABEL[run.status] || run.status)}</span>${replyBadge(run, 'pa-badge')}<time>${esc(timeAgo(runStart(run)))}</time></div>
        <p class="run-text">${esc(runText(run))}</p>
        ${runResult(run) ? `<pre class="run-output">${esc(runResult(run))}</pre>` : ''}
        <div class="run-actions">
          ${run.canReply || run.parentId ? `<button type="button" class="btn btn-sm${run.needsReply ? ' btn-primary' : ''}" data-act="open-thread" data-run="${esc(run.id)}" data-key="pa-thread">${run.needsReply ? '답하기' : '대화 보기'}</button>` : ''}
          <button type="button" class="btn btn-sm btn-ghost" data-act="log-run" data-run="${esc(run.id)}" data-key="pa-log">전체 결과 보기</button>
        </div>
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

// 직원·비서실장의 의견 필요 항목 목록
function attentionSection(agentId) {
  const entry = attnFor(agentId);
  if (!entry) return '';
  return `<section class="attn-list" aria-label="의견이 필요한 항목">${entry.items.map((a, i) => `
    <div class="attn-row ar-${esc(a.kind)}">${attnSvg(a.kind)}<div><b>${esc(ATTENTION_LABEL[a.kind])}</b><p>${esc(a.kind === 'approve' ? taskTitle(a.task) : clipText(a.text, 160) || '')}</p></div>
      <button type="button" class="btn btn-sm btn-primary" data-act="attn" data-attn="${esc(attentionKey(a))}" data-key="pal-${i}">${a.kind === 'reply' ? '답하기' : a.kind === 'approve' ? '확인하기' : '보기'}</button></div>`).join('')}</section>`;
}

function chiefProfile(a) {
  const runs = S.runs.filter((r) => !runAgentId(r) && r.target !== 'review' && r.engine !== 'codex')
    .sort((x, y) => String(runStart(y) || '').localeCompare(String(runStart(x) || ''))).slice(0, 5);
  return `
  <div class="profile" style="--dept:#fbbf24">
    <div class="profile-head">
      <span class="dc-icon dc-icon-lg" aria-hidden="true">★</span>
      <div>
        <h3>비서실장 <small>메인 세션</small></h3>
        <p class="chips"><span class="chip chip-dept">비서실</span><span class="st-badge st-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span></p>
      </div>
      ${attnButton(attnFor('chief')?.top, 'pc-attn-icon')}
    </div>
    ${attentionSection('chief')}
    <dl class="kv">
      <dt>현재</dt><dd>${esc(a.status === 'working' ? statusLine(a) : STATUS_LABEL[a.status] || a.status)}</dd>
      <dt>마지막 활동</dt><dd>${esc(timeAgo(a.lastEvent?.ts || a.lastEvent))}</dd>
      <dt>역할</dt><dd>업무를 나눠 부서에 하달하고, 협조 순서를 조율하고, 결과를 검토해 보고합니다. 직접 실무는 하지 않습니다.</dd>
    </dl>
    <p class="help">비서실장에게는 위쪽 입력창으로 업무를 지시합니다.</p>
    <h4 class="sub-title">최근 지시</h4>
    ${runs.length ? `<ul class="task-list">${runs.map((r) => `<li class="run run-${esc(r.status)}${r.needsReply ? ' run-needs-reply' : ''}">
      <div class="task-top"><span class="tag r-${esc(r.status)}">${esc(RUN_LABEL[r.status] || r.status)}</span>${replyBadge(r, `pcb-${r.id}`)}<time>${esc(timeAgo(runStart(r)))}</time></div>
      <p class="run-text">${esc(runText(r))}</p>
      <div class="run-actions">${r.canReply || r.parentId ? `<button type="button" class="btn btn-sm" data-act="open-thread" data-run="${esc(r.id)}" data-key="pct-${esc(r.id)}">대화 보기</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-act="log-run" data-run="${esc(r.id)}" data-key="pcl-${esc(r.id)}">로그</button></div></li>`).join('')}</ul>` : '<p class="empty">아직 지시한 업무가 없어요.</p>'}
  </div>`;
}

function tagList(list, cls = '') {
  return Array.isArray(list) && list.length ? list.map((t) => `<span class="tag-chip ${cls}">${esc(t)}</span>`).join('') : '<span class="muted">없음</span>';
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
      <dt>역량</dt><dd class="tags">${tagList(d.capabilities)}</dd>
      <dt>결과 전달</dt><dd class="tags">${Array.isArray(d.handoffs) && d.handoffs.length ? d.handoffs.map((h) => (deptOf(h) ? partyChip(h) : `<span class="pchip" title="조직에 없는 부서">${esc(deptLabel(h))} (조직에 없음)</span>`)).join('') : '<span class="muted">없음</span>'}</dd>
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
    ${d.members.length ? `<ul class="member-list">${d.members.map((m) => liveRow(m, 'dm')).join('')}</ul>` : '<p class="empty">아직 직원이 없어요.</p>'}
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
  f.capabilities.value = (Array.isArray(values.capabilities) ? values.capabilities : []).join(', ');
  // 협조 대상: 지금 있는 다른 부서만 체크박스로 보이고, 아직 없는 부서(프리셋 기본값)는 그대로 보존한다
  const handoffs = Array.isArray(values.handoffs) ? values.handoffs : [];
  const others = S.departments.filter((d) => d.id !== (deptEditing?.id || f.id.value));
  deptHandoffExtra = handoffs.filter((h) => !others.some((d) => d.id === h));
  $('handoffChecks').innerHTML = others.length
    ? others.map((d) => `<label class="inline"><input type="checkbox" value="${esc(d.id)}" ${handoffs.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')
    : '<span class="help">다른 부서가 생기면 고를 수 있어요.</span>';
  syncDeptUi();
}
let deptHandoffExtra = [];

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
  const capabilities = parseTags(f.capabilities.value);
  const handoffs = [...new Set([...$('handoffChecks').querySelectorAll('input:checked')].map((b) => b.value).concat(deptHandoffExtra))];
  if (deptEditing || capabilities.length) body.capabilities = capabilities;
  if (deptEditing || handoffs.length) body.handoffs = handoffs;
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
  // handoffs는 보내지 않는다: 서버가 프리셋 기본값으로 채우고, 직접 보낸 handoffs가 아니면 '없는 부서' 경고를 내지 않는다
  // (프리셋으로 부서를 만들 때마다 아직 없는 부서 경고가 뜨지 않게)
  const { roles, handoffs: _handoffs, ...fields } = p;
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

// 대상 업무 고르기(사용자 확인 대기 업무가 여러 건일 때). 고른 업무 id, 취소하면 null
function pickTaskBox(text, ids, okLabel) {
  const dlg = $('pickTaskDialog');
  $('pickTaskText').textContent = text;
  $('pickTaskOk').textContent = okLabel;
  const list = $('pickTaskList');
  list.replaceChildren(...ids.map((id, i) => {
    const label = el('label', 'pick-item');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'pickTask'; radio.value = id; radio.checked = i === 0;
    label.append(radio, el('b', '', taskTitle(id)), el('code', '', id));
    return label;
  }));
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    const picked = list.querySelector('input:checked');
    resolve(dlg.returnValue === 'ok' && picked ? picked.value : null);
  }, { once: true }));
}

// 입력창의 승인·반려: 확인 대화상자를 거쳐 승인·반려 API로 보낸다. 처리했으면 true(입력을 비운다)
async function chiefDecision(act) {
  const verb = act.action === 'approve' ? '승인' : '반려';
  let taskId = act.taskId;
  if (!taskId) {
    taskId = await pickTaskBox(`사용자 확인 대기 업무가 ${act.choices.length}건이에요. 어느 업무를 ${verb}할까요?`, act.choices, verb);
    if (!taskId) return false;
  }
  if (act.action === 'reject' && !act.feedback) {
    openApprove(taskId, { focusFeedback: true });
    toast('무엇을 고쳐야 하는지 반려 피드백을 적어 주세요. 비서실장이 이 내용으로 다시 배정합니다.');
    return true;
  }
  const title = taskTitle(taskId);
  const question = act.action === 'approve' ? `'${title}' 업무를 승인할까요? 완료로 바뀝니다.` : `'${title}' 업무를 반려할까요? 비서실장에게 전달할 피드백: ${act.feedback}`;
  if (!(await confirmBox(question, verb))) return false;
  if (act.action === 'approve') {
    await api('POST', `/api/tasks/${encodeURIComponent(taskId)}/approve`);
    toast(`'${title}' 업무를 승인했어요. 완료로 바꿨어요.`);
  } else {
    await api('POST', `/api/tasks/${encodeURIComponent(taskId)}/reject`, { feedback: act.feedback });
    toast('반려 피드백을 비서실장에게 전달했어요. 다시 배정합니다.');
  }
  await refresh();
  return true;
}

async function submitChief(ev) {
  ev.preventDefault();
  const input = $('chiefInput');
  const prompt = input.value.trim();
  if (!prompt) { input.focus(); return; }
  // 사용자 확인 대기 업무가 있으면 "승인"·"반려 …"는 새 실행이 아니라 승인·반려로 처리한다
  const act = chiefInputAction(prompt, S.tasks);
  if (act.action !== 'run') {
    try {
      if (await chiefDecision(act)) input.value = '';
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
    return;
  }
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

// ───── 대화 보기·이어서 답하기 ─────
// ui.thread = { rootId }. 답변 전문은 GET /api/runs/:id/result(토큰)로 받아 run별로 캐시한다
const resultCache = new Map(); // runId → { endedAt, text, sessionId, loading, error }
let threadSending = false;
let threadSig = '';

function openThread(runId) {
  const run = S.runs.find((r) => r.id === runId);
  if (!run) { toast('실행 기록을 찾을 수 없어요.', { type: 'error' }); return; }
  ui.thread = { rootId: run.rootId || run.id };
  threadSig = '';
  $('threadError').hidden = true;
  $('threadPrompt').value = '';
  $('threadModel').value = '';
  if (!$('threadDialog').open) $('threadDialog').showModal();
  renderThread();
  if (!$('threadPrompt').disabled) $('threadPrompt').focus();
}

async function loadResult(run) {
  const cached = resultCache.get(run.id);
  if (cached && (cached.loading || cached.endedAt === run.endedAt)) return;
  resultCache.set(run.id, { endedAt: run.endedAt, loading: true, text: cached?.text || '' });
  try {
    const res = await authedGet(`/api/runs/${encodeURIComponent(run.id)}/result`);
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* 텍스트 그대로 */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    resultCache.set(run.id, { endedAt: run.endedAt, text, sessionId: res.headers.get('X-Session-Id') || '' });
  } catch (e) {
    resultCache.set(run.id, { endedAt: run.endedAt, text: run.summary || '', error: e.message });
  }
  if (ui.thread) renderThread();
}

// 마크다운 블록을 DOM으로 그린다. 모든 문자열은 textContent로만 넣는다
function inlineNodes(parent, inline) {
  for (const seg of inline) {
    if (seg.t === 'text') parent.append(document.createTextNode(seg.v));
    else { const el = document.createElement(seg.t === 'b' ? 'strong' : 'code'); el.textContent = seg.v; parent.append(el); }
  }
}
function markdownNode(text) {
  const box = document.createElement('div');
  box.className = 'md';
  for (const b of parseMarkdown(text)) {
    let el;
    if (b.type === 'heading') { el = document.createElement('p'); el.className = `md-h md-h${Math.min(b.level, 3)}`; inlineNodes(el, b.inline); }
    else if (b.type === 'para') { el = document.createElement('p'); inlineNodes(el, b.inline); }
    else if (b.type === 'code') { el = document.createElement('pre'); el.className = 'md-code'; el.textContent = b.text; }
    else if (b.type === 'rule') { el = document.createElement('hr'); }
    else if (b.type === 'list') {
      el = document.createElement(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start > 1) el.start = b.start;
      for (const item of b.items) { const li = document.createElement('li'); inlineNodes(li, item); el.append(li); }
    }
    if (el) box.append(el);
  }
  return box;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderThread() {
  const dlg = $('threadDialog');
  if (!ui.thread || !dlg.open) return;
  const anchor = S.runs.find((r) => (r.rootId || r.id) === ui.thread.rootId);
  const runs = anchor ? threadOf(S.runs, anchor.id) : [];
  const latest = runs[runs.length - 1] || null;
  const busy = runs.some((r) => r.status === 'running' || r.status === 'queued');
  for (const r of runs) if (r.status !== 'running' && r.status !== 'queued') loadResult(r);

  const who = latest ? runWho(latest) : '';
  $('threadTitle').textContent = latest ? `대화 · ${who}` : '대화';
  $('threadSub').textContent = runs.length ? `${runs.length}번 주고받음` : '';

  // 바뀐 것이 있을 때만 다시 그린다(입력 중 깜빡임·스크롤 튐 방지)
  const sig = JSON.stringify(runs.map((r) => [r.id, r.status, r.needsReply, resultCache.get(r.id)?.text?.length ?? -1, resultCache.get(r.id)?.loading]));
  if (sig !== threadSig) {
    threadSig = sig;
    const list = $('threadList');
    list.replaceChildren();
    if (!runs.length) list.append(el('li', 'empty', '대화 기록을 찾을 수 없어요.'));
    for (const r of runs) {
      const ask = el('li', 'msg msg-user');
      const askHead = el('div', 'msg-head');
      askHead.append(el('b', '', r.parentId ? '대표 · 답장' : '대표 · 요청'), el('time', '', timeAgo(r.createdAt || runStart(r))));
      ask.append(askHead, el('p', 'msg-text', runText(r) || '(요청 요약 없음)'));
      const ans = el('li', `msg msg-agent msg-${r.status}`);
      const head = el('div', 'msg-head');
      head.append(el('b', '', runWho(r)), el('span', `tag r-${r.status}`, RUN_LABEL[r.status] || r.status));
      if (r.needsReply) head.append(el('span', 'badge badge-reply', '답변 필요'));
      ans.append(head);
      const cached = resultCache.get(r.id);
      if (r.status === 'running' || r.status === 'queued') {
        ans.append(el('p', 'msg-progress', r.status === 'queued' ? '차례를 기다리는 중…' : '답변을 작성하는 중…'));
      } else if (cached?.loading && !cached.text) {
        ans.append(el('p', 'muted-text', '답변을 불러오는 중…'));
      } else {
        const text = cached?.text || r.summary || '';
        ans.append(text ? markdownNode(text) : el('p', 'muted-text', '(답변 내용이 없어요)'));
        if (cached?.error) ans.append(el('p', 'help', `전문을 불러오지 못해 요약만 보여요: ${cached.error}`));
      }
      list.append(ask, ans);
    }
    const body = list.parentElement;
    body.scrollTop = body.scrollHeight;
  }

  // 답장 입력 상태
  const codex = latest?.engine === 'codex';
  $('threadModelRow').hidden = codex;
  let status = '';
  if (S.demo) status = DEMO_HINT;
  else if (!latest) status = '';
  else if (busy) status = '이전 실행이 끝난 뒤 답할 수 있어요.';
  else if (!latest.canReply) status = '이 실행은 세션 정보가 없어 이어서 답할 수 없어요. 새 작업으로 지시해 주세요.';
  else if (threadSending) status = '보내는 중…';
  const disabled = S.demo || !latest || busy || !latest.canReply || threadSending;
  $('threadSend').disabled = disabled;
  $('threadPrompt').disabled = S.demo || !latest?.canReply;
  $('threadModel').disabled = disabled;
  $('threadStatus').textContent = status;
  $('threadStatus').classList.toggle('is-busy', busy || threadSending);
  const sid = latest ? resultCache.get(latest.id)?.sessionId : '';
  const hint = $('threadHint');
  hint.replaceChildren();
  if (sid && !busy) {
    // 세션은 실행 폴더(이 저장소 루트) 기준으로 저장되므로 그 폴더에서 실행해야 찾는다.
    // 직원 실행은 --agent 를 붙여야 같은 직원 지침으로 이어진다(agentId 는 AGENT_ID_PATTERN 으로 검증된 값)
    const agentArg = !codex && latest.agentId && ID_RE.test(latest.agentId) ? ` --agent ${latest.agentId}` : '';
    hint.append('저장소 폴더의 터미널에서 이어가기: ', el('code', '', codex ? `codex exec resume ${sid}` : `claude --resume ${sid}${agentArg}`));
  }
  hint.hidden = !hint.childNodes.length;
}

async function submitThread(ev) {
  ev.preventDefault();
  if (!ui.thread || threadSending || S.demo) return;
  const runs = threadOf(S.runs, S.runs.find((r) => (r.rootId || r.id) === ui.thread.rootId)?.id);
  const latest = runs[runs.length - 1];
  const prompt = $('threadPrompt').value.trim();
  if (!latest) return;
  if (!prompt) { $('threadError').textContent = '답장 내용을 입력해 주세요.'; $('threadError').hidden = false; $('threadPrompt').focus(); return; }
  threadSending = true;
  $('threadError').hidden = true;
  renderThread();
  try {
    const model = $('threadModelRow').hidden ? '' : $('threadModel').value;
    await api('POST', `/api/runs/${encodeURIComponent(latest.id)}/reply`, { prompt, ...(model ? { model } : {}) });
    $('threadPrompt').value = '';
    toast(`${runWho(latest)}에게 답장을 보냈어요.`);
    await refresh();
  } catch (e) {
    $('threadError').textContent = e.message; $('threadError').hidden = false;
  } finally {
    threadSending = false;
    renderThread();
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

// ───── 조직 탭 ─────
function capEditor(d) {
  const caps = Array.isArray(d.capabilities) ? d.capabilities : [];
  const hand = Array.isArray(d.handoffs) ? d.handoffs : [];
  const others = S.departments.filter((x) => x.id !== d.id && !hand.includes(x.id));
  return `<div class="tag-edit">
      <span class="te-label" id="cap-l-${esc(d.id)}">역량</span>
      <div class="te-chips">${caps.map((c, i) => `<span class="tag-chip">${esc(c)}<button type="button" class="tag-x" data-act="cap-del" data-id="${esc(d.id)}" data-tag="${esc(c)}" data-key="capx-${esc(d.id)}-${i}" aria-label="역량 ${esc(c)} 빼기">✕</button></span>`).join('')}
        <input class="te-input" data-cap-input="${esc(d.id)}" data-key="capi-${esc(d.id)}" maxlength="40" placeholder="역량 입력 후 Enter" aria-labelledby="cap-l-${esc(d.id)}"></div>
    </div>
    <div class="tag-edit">
      <span class="te-label" id="hand-l-${esc(d.id)}">결과 전달</span>
      <div class="te-chips">${hand.map((h, i) => `<span class="tag-chip tag-dept" style="--dept:${esc(safeColor(deptOf(h)?.color, '#94a3b8'))}">${esc(deptOf(h)?.name || `${deptLabel(h)} (조직에 없음)`)}<button type="button" class="tag-x" data-act="handoff-del" data-id="${esc(d.id)}" data-tag="${esc(h)}" data-key="hx-${esc(d.id)}-${i}" aria-label="${esc(deptLabel(h))} 빼기">✕</button></span>`).join('')}
        ${others.length ? `<select class="te-select" data-handoff-add="${esc(d.id)}" data-key="hs-${esc(d.id)}" aria-labelledby="hand-l-${esc(d.id)}"><option value="">+ 넘길 부서</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>` : ''}</div>
    </div>`;
}

function memberRow(a) {
  const off = a.active === false || a.status === 'off-duty';
  return `<li class="om-row${off ? ' is-off' : ''}">
    <button type="button" class="om-who" data-act="open-agent" data-id="${esc(a.id)}" data-key="omw-${esc(a.id)}">${avatar(a.id)}<span><b>${esc(a.name || a.id)}</b> <small>${esc(rankLabel(a))}</small><span class="om-spec">${esc(a.specialty || '담당 업무 없음')}</span></span></button>
    <span class="om-status">${statusDot(a.status)} ${esc(STATUS_LABEL[a.status] || a.status)}</span>
    ${attnButton(attnFor(a.id)?.top, `oma-${a.id}`)}
    <span class="om-actions">
      <button type="button" class="btn btn-sm" data-act="run-agent" data-id="${esc(a.id)}" data-key="omr-${esc(a.id)}" ${off ? 'disabled title="휴무 중"' : ''}>작업 지시</button>
      <button type="button" class="btn btn-sm" data-act="duty-agent" data-id="${esc(a.id)}" data-key="omd-${esc(a.id)}">${a.active === false ? '근무로' : '휴무로'}</button>
      <button type="button" class="btn btn-sm" data-act="edit-agent" data-id="${esc(a.id)}" data-key="ome-${esc(a.id)}">수정</button>
      <button type="button" class="btn btn-sm btn-ghost btn-danger-text" data-act="del-agent" data-id="${esc(a.id)}" data-key="omx-${esc(a.id)}" aria-label="${esc(a.name || a.id)} 삭제">삭제</button>
    </span></li>`;
}

function renderOrgView() {
  const gaps = S.gaps.length ? S.gaps : S.attention.filter((a) => a.kind === 'gap').map((a) => ({ need: a.text, task: a.task, key: attentionKey(a) }));
  const deptCards = S.departments.map((d) => `
    <article class="org-card${d.active ? '' : ' is-off'}" style="--dept:${esc(safeColor(d.color))}" aria-labelledby="oc-${esc(d.id)}">
      <header class="oc-head">
        <span class="dc-icon" aria-hidden="true">${esc((d.en || d.name || '?').slice(0, 1))}</span>
        <div class="dc-title"><h3 id="oc-${esc(d.id)}">${esc(d.name)} <small class="dc-en-inline">${esc(d.en || d.id)}</small></h3>
          <span class="dc-en">${esc(d.engine || 'claude')} · ${d.memberCount}명 · 작업 ${d.activeCount}${d.active ? '' : ' · 휴무'}</span></div>
        <div class="oc-actions">
          <button type="button" class="btn btn-sm" data-act="add-agent" data-dept="${esc(d.id)}" data-key="oca-${esc(d.id)}">+ 직원</button>
          ${findPresetFor(d, S.presets) ? `<button type="button" class="btn btn-sm" data-act="bulk" data-dept="${esc(d.id)}" data-key="ocb-${esc(d.id)}">일괄 추가</button>` : ''}
          <button type="button" class="btn btn-sm" data-act="edit-dept" data-id="${esc(d.id)}" data-key="oce-${esc(d.id)}">수정</button>
          <button type="button" class="btn btn-sm" data-act="duty-dept" data-id="${esc(d.id)}" data-key="ocd-${esc(d.id)}">${d.active ? '부서 휴무' : '부서 근무'}</button>
          <button type="button" class="btn btn-sm btn-ghost btn-danger-text" data-act="del-dept" data-id="${esc(d.id)}" data-key="ocx-${esc(d.id)}" aria-label="${esc(d.name)} 삭제">삭제</button>
        </div>
      </header>
      ${d.summary ? `<p class="muted-text">${esc(d.summary)}</p>` : ''}
      ${capEditor(d)}
      ${d.members.length ? `<ul class="om-rows">${d.members.map(memberRow).join('')}</ul>` : '<p class="empty">아직 직원이 없어요. "+ 직원" 또는 "일괄 추가"로 채용해 보세요.</p>'}
    </article>`).join('');
  setHTML($('orgView'), `
    ${gaps.length ? `<section class="org-sec" id="orgGaps" aria-labelledby="orgGapTitle"><h3 class="section-title" id="orgGapTitle">역량 공백 ${gaps.length}건</h3>
      <p class="help">필요한 역량을 가진 근무중 부서가 없습니다. 아래 프리셋에서 부서를 추가하거나, 기존 부서의 역량을 채워 주세요.</p>
      <div class="attn-strip">${gaps.map((g) => gapCard(g, 'og', false)).join('')}</div></section>` : ''}
    <section class="org-sec" aria-labelledby="orgDeptTitle">
      <div class="org-sec-head"><h3 class="section-title" id="orgDeptTitle">부서 · 직원 <span>${S.departments.length}개 부서 · ${S.people}명</span></h3>
        <div class="org-sec-actions">
          <button type="button" class="btn btn-sm btn-primary" data-act="new-dept" data-key="ov-new">+ 직접 입력</button>
          <button type="button" class="btn btn-sm" data-act="company" data-key="ov-company">회사 설정</button>
        </div></div>
      ${deptCards || '<p class="empty">아직 부서가 없어요. 아래 프리셋에서 고르거나 "+ 직접 입력"으로 만들어 보세요.</p>'}
    </section>
    <section class="org-sec" id="orgPresets" aria-labelledby="orgPresetTitle">
      <h3 class="section-title" id="orgPresetTitle">부서 추가 · 프리셋</h3>
      ${S.presets.length ? `<div class="preset-grid">${presetCards('o')}</div>` : '<p class="empty">프리셋을 불러오지 못했어요.</p>'}
    </section>
    ${S.demo ? '' : `<section class="org-sec" aria-labelledby="orgMapTitle">
      <details class="more" data-orgmap ${ui.orgmapOpen ? 'open' : ''}><summary id="orgMapTitle">비서실장에게 전달되는 조직도 미리보기</summary>
        <p class="help">부서 역량·협조 관계·근무중 직원 목록이 다음 실행부터 비서실장 지침에 들어갑니다.</p>
        <pre class="preview-box" data-orgmap-body>${esc(orgmapCache || '불러오는 중…')}</pre></details></section>`}`);
}

let orgmapCache = '';
async function loadOrgmap(details) {
  const box = details.querySelector('[data-orgmap-body]');
  try {
    const res = await authedGet('/api/orgmap', 'text/markdown, text/plain, application/json');
    const text = await res.text();
    let data = null;
    if ((res.headers.get('Content-Type') || '').includes('json')) { try { data = JSON.parse(text); } catch { /* 텍스트로 본다 */ } }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    orgmapCache = (data ? data.markdown ?? data.text ?? data.orgmap ?? '' : text) || '(비어 있음)';
  } catch (e) {
    orgmapCache = `조직도를 불러오지 못했어요: ${e.message}`;
  }
  box.textContent = orgmapCache;
}

async function saveDeptTags(id, patch, message) {
  if (S.demo) { toast(DEMO_HINT); return; }
  try {
    showWarnings(await api('PUT', `/api/departments/${encodeURIComponent(id)}`, patch));
    orgmapCache = '';
    if (message) toast(message);
    await refresh();
  } catch (e) { toast(e.message, { type: 'error' }); }
}

function addCapability(input) {
  const d = deptOf(input.dataset.capInput);
  const add = parseTags(input.value);
  if (!d || !add.length) return;
  const caps = parseTags([...(d.capabilities || []), ...add].join(','));
  input.value = '';
  saveDeptTags(d.id, { capabilities: caps }, `${d.name} 역량: ${add.join(', ')} 추가`);
}

// ───── 산출물 탭 ─────
function outputUrl(taskId, suffix = '') { return `/api/outputs/${encodeURIComponent(taskId)}${suffix}`; }
function fileUrl(path) { return `/api/outputs/file?path=${encodeURIComponent(path)}`; }

async function loadOutputs(force = false) {
  const o = ui.out;
  if (o.loading || (!force && Date.now() - o.loadedAt < 2500)) return;
  o.loading = true;
  try {
    const res = await authedGet('/api/outputs', 'application/json');
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    o.list = normalizeOutputs(data);
    o.error = '';
  } catch (e) {
    // 산출물 API가 없거나 실패하면 현재 업무 목록으로 대신 보여준다
    o.list = normalizeOutputs(S.tasks);
    o.error = `산출물 목록을 불러오지 못해 업무 목록으로 보여줘요: ${e.message}`;
  } finally {
    o.loading = false;
    o.loadedAt = Date.now();
    o.sig = '';
    if (ui.view === 'outputs') renderOutputs();
  }
}

async function loadTaskFiles(taskId, force = false) {
  const o = ui.out;
  const cur = o.files.get(taskId);
  if (cur && (cur.loading || (!force && cur.data))) return cur;
  o.files.set(taskId, { loading: true });
  let entry;
  try {
    const res = await authedGet(outputUrl(taskId, '/files'), 'application/json');
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    entry = { data, groups: groupOutputFiles(data, taskId) };
  } catch (e) {
    entry = { error: e.message, groups: groupOutputFiles([], taskId) };
  }
  o.files.set(taskId, entry);
  o.sig = '';
  if (ui.view === 'outputs') renderOutputs();
  if (ui.approve?.taskId === taskId) { ui.approve.sig = ''; renderApprove(); }
  return entry;
}

function outputTask(id) {
  return (ui.out.list || []).find((t) => t.id === id) || S.tasks.find((t) => t.id === id) || { id, title: id, status: 'active' };
}

function renderOutputs() {
  const o = ui.out;
  if (!o.list && !o.loading) loadOutputs(true);
  const list = o.list || [];
  // 필터 선택지
  const dates = [...new Set(list.map((t) => t.date).filter(Boolean))];
  const dateSel = $('outDate');
  const keepDate = dateSel.value;
  const dateHtml = '<option value="">전체</option>' + dates.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  if (dateSel._html !== dateHtml) { dateSel.innerHTML = dateHtml; dateSel._html = dateHtml; dateSel.value = dates.includes(keepDate) ? keepDate : ''; }
  const deptSel = $('outDept');
  const keepDept = deptSel.value;
  const deptHtml = '<option value="">전체</option>' + S.departments.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  if (deptSel._html !== deptHtml) { deptSel.innerHTML = deptHtml; deptSel._html = deptHtml; deptSel.value = S.departments.some((d) => d.id === keepDept) ? keepDept : ''; }
  const filtered = filterOutputs(list, { q: $('outQ').value, date: dateSel.value, dept: deptSel.value, status: $('outStatus').value });
  $('outSub').textContent = o.list ? `업무 ${list.length}건${filtered.length !== list.length ? ` · ${filtered.length}건 표시` : ''}` : '불러오는 중…';
  setHTML($('outList'), (o.error ? `<li class="help out-note">${esc(o.error)}</li>` : '') + (filtered.length ? filtered.map((t) => {
    const task = S.tasks.find((x) => x.id === t.id) || t;
    const reviews = taskReviews({ ...t, ...task, verdicts: { ...(t.verdicts || {}), ...(task.verdicts || {}) } });
    return `<li><button type="button" class="out-item${o.sel === t.id ? ' is-sel' : ''}" data-act="out-open" data-task="${esc(t.id)}" data-key="oi-${esc(t.id)}" aria-current="${o.sel === t.id ? 'true' : 'false'}">
      <span class="oi-top"><span class="tag t-${esc(task.status || t.status)}">${esc(TASK_STATUS_LABEL[task.status || t.status] || task.status || t.status)}</span><b>${esc(t.title)}</b></span>
      <span class="oi-meta"><time>${esc(t.date || '')}</time>${t.departments.map((d) => partyChip(d)).join('')}${reviews.map((r) => `<span class="verdict v-${esc(String(r.verdict || 'none').toLowerCase())}">${esc(r.verdict || '…')}</span>`).join('')}</span>
    </button></li>`;
  }).join('') : `<li class="empty">${o.list ? (list.length ? '조건에 맞는 업무가 없어요.' : '아직 산출물이 없어요. 업무를 지시하면 outputs 폴더에 쌓여요.') : '불러오는 중…'}</li>`));
  $('outLayout').classList.toggle('has-sel', !!o.sel);
  renderOutDetail();
}

function renderOutDetail() {
  const o = ui.out;
  const box = $('outDetail');
  if (!o.sel) {
    if (box._sig !== 'none') { box.replaceChildren(el('p', 'empty', '왼쪽 목록에서 업무를 고르면 보고서·회의록·부서별 파일·검토 결과를 볼 수 있어요.')); box._sig = 'none'; }
    return;
  }
  const t = outputTask(o.sel);
  const files = o.files.get(o.sel);
  if (!files) loadTaskFiles(o.sel);
  const runs = S.runs.filter((r) => r.task === o.sel || r.taskId === o.sel);
  const sig = JSON.stringify([o.sel, t.status, t.title, !!files?.loading, files?.error, files?.data ? 1 : 0, runs.map((r) => [r.id, r.status, r.needsReply]),
    taskSteps(t, S.flow).current, t.plan ? planStages(t.plan, S.flow, t.id).map((s) => s.status) : 0, ui.view]);
  if (box._sig === sig) return;
  box._sig = sig;
  const g = files?.groups || groupOutputFiles([], o.sel);
  const frag = document.createDocumentFragment();

  const head = el('div', 'od-head');
  const back = el('button', 'btn btn-sm od-back', '‹ 목록');
  back.type = 'button'; back.dataset.act = 'out-back'; back.dataset.key = 'od-back';
  const title = el('h3', 'od-title', t.title || t.id);
  head.append(back, title);
  const meta = el('p', 'od-meta');
  meta.append(el('span', `tag t-${t.status}`, TASK_STATUS_LABEL[t.status] || t.status || '진행'), el('code', '', t.id));
  const acts = el('div', 'od-actions');
  const openBtn = el('button', 'btn btn-sm', '폴더 열기');
  openBtn.type = 'button'; openBtn.dataset.act = 'out-folder'; openBtn.dataset.task = t.id; openBtn.dataset.key = 'od-folder';
  acts.append(openBtn);
  if (t.status === 'review') {
    const ap = el('button', 'btn btn-sm btn-primary', '사용자 확인(승인·반려)');
    ap.type = 'button'; ap.dataset.act = 'open-approve'; ap.dataset.task = t.id; ap.dataset.key = 'od-approve';
    acts.append(ap);
  }
  frag.append(head, meta, acts);

  const steps = el('div', 'od-steps');
  steps.innerHTML = stepperHtml(t); // 단계 이름만 들어가는 고정 문구(esc 처리)
  frag.append(steps);

  // 계획(plan.json): 상태의 task.plan → 파일
  const planBox = el('section', 'od-sec');
  planBox.append(el('h4', 'sub-title', '작업 계획'));
  if (t.plan) { const p = el('div'); p.innerHTML = planHtml(t, t.plan); planBox.append(p); frag.append(planBox); }
  else if (g.plan) {
    const p = el('div', 'muted-text', '계획표를 불러오는 중…');
    planBox.append(p);
    frag.append(planBox);
    fetchFileText(g.plan.path).then(({ text }) => {
      try { const plan = JSON.parse(text); p.className = ''; p.innerHTML = planHtml(t, plan) || '<p class="muted-text">단계가 없어요.</p>'; } catch { p.textContent = 'plan.json을 해석하지 못했어요.'; }
    }).catch((e) => { p.textContent = `plan.json을 불러오지 못했어요: ${e.message}`; });
  }

  if (files?.loading) frag.append(el('p', 'muted-text', '파일 목록을 불러오는 중…'));
  if (files?.error) frag.append(el('p', 'help', `파일 목록을 불러오지 못했어요: ${files.error}`));

  const preview = el('div', 'file-preview');
  preview.id = 'outPreview';
  const docSec = (label, file) => {
    if (!file) return;
    const sec = el('section', 'od-sec');
    sec.append(el('h4', 'sub-title', label));
    const doc = el('div', 'doc-box');
    sec.append(doc);
    frag.append(sec);
    renderFileInto(doc, file, { compact: true });
  };
  docSec('보고서 · report.md', g.report);
  docSec('회의록 · meeting.md', g.meeting);

  const fileSec = el('section', 'od-sec');
  fileSec.append(el('h4', 'sub-title', '부서별 파일'));
  const groups = [...g.depts];
  if (g.brief || g.notes || g.common.length) groups.unshift(['__common', [g.brief, g.notes, ...g.common].filter(Boolean)]);
  if (!groups.length && !files?.loading) fileSec.append(el('p', 'muted-text', '부서별 파일이 없어요.'));
  for (const [dept, list] of groups) {
    const wrap = el('div', 'od-dept');
    const label = el('div', 'od-dept-head');
    if (dept === '__common') label.append(el('span', 'pchip', '공통'));
    else label.innerHTML = partyChip(dept);
    wrap.append(label, fileButtons(list, preview));
    fileSec.append(wrap);
  }
  frag.append(fileSec);

  if (g.reviews.length) {
    const rs = el('section', 'od-sec');
    rs.append(el('h4', 'sub-title', '검토 결과 · reviews'));
    const verdicts = Object.fromEntries(taskReviews(t).map((r) => [r.reviewer, r.verdict]));
    rs.append(fileButtons(g.reviews, preview, (f) => verdicts[f.name.replace(/\.md$/, '')] || ''));
    frag.append(rs);
  }

  const conv = el('section', 'od-sec');
  conv.append(el('h4', 'sub-title', '대화 스레드'));
  if (runs.length) {
    const ul = el('ul', 'od-runs');
    for (const r of runs) {
      const li = el('li');
      const b = el('button', 'btn btn-sm', `${runWho(r)} · ${clipText(runText(r), 40) || r.id}`);
      b.type = 'button'; b.dataset.act = r.canReply || r.parentId ? 'open-thread' : 'log-run'; b.dataset.run = r.id; b.dataset.key = `odr-${r.id}`;
      li.append(b);
      if (r.needsReply) li.append(el('span', 'badge badge-reply', '답변 필요'));
      ul.append(li);
    }
    conv.append(ul);
  } else conv.append(el('p', 'muted-text', '이 업무에 연결된 대화가 없어요.'));
  frag.append(conv);
  frag.append(preview);
  revokeBlobs(box);
  box.replaceChildren(frag);
}

function fileButtons(list, preview, badge) {
  const ul = el('ul', 'file-list');
  for (const f of list) {
    const li = el('li');
    const b = el('button', 'file-btn');
    b.type = 'button';
    b.dataset.key = `fb-${f.path}`;
    b.append(el('span', `fk fk-${fileKind(f.name)}`, (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] || 'file').toUpperCase().slice(0, 4)), el('span', 'fb-name', f.rel || f.name));
    const v = badge?.(f);
    if (v) b.append(el('span', `verdict v-${String(v).toLowerCase()}`, v));
    if (Number.isFinite(f.size)) b.append(el('small', '', formatSize(f.size)));
    b.addEventListener('click', () => {
      for (const x of ul.closest('.od-sec, .approve-grid, .out-detail')?.querySelectorAll('.file-btn.is-sel') || []) x.classList.remove('is-sel');
      b.classList.add('is-sel');
      renderFileInto(preview, f);
      preview.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    li.append(b);
    ul.append(li);
  }
  return ul;
}

function formatSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function fetchFile(path) {
  const res = await authedGet(fileUrl(path), '*/*');
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error; } catch { /* 본문 없음 */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res;
}

async function fetchFileText(path) {
  const res = await fetchFile(path);
  return { text: await res.text(), type: res.headers.get('Content-Type') || '' };
}

function revokeBlobs(box) {
  for (const f of box.querySelectorAll('iframe[data-blob]')) URL.revokeObjectURL(f.dataset.blob);
}

async function downloadFile(file) {
  try {
    const res = await authedGet(`${fileUrl(file.path)}&download=1`, 'application/octet-stream');
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error; } catch { /* 본문 없음 */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = file.name || 'output';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast(`내려받지 못했어요: ${e.message}`, { type: 'error' });
  }
}

const PREVIEW_MAX = 400000;
// html 미리보기 blob 문서 맨 앞에 CSP를 넣는다. 서버 미리보기 CSP는 blob 문서에 닿지 않고, blob URL을 최상위 창으로 열면
// sandbox도 풀리기 때문이다(외부 이미지·CSS 비콘과 스크립트 실행을 함께 막는다). <!doctype>이 있으면 그 뒤에 넣어 표준 모드를 지킨다
export const PREVIEW_META_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'">`;
export function withPreviewCsp(html) {
  const text = String(html ?? '').replace(/^\uFEFF/, '');
  const m = text.match(/^\s*<!doctype[^>]*>/i);
  return m ? `${m[0]}${PREVIEW_META_CSP}${text.slice(m[0].length)}` : `${PREVIEW_META_CSP}${text}`;
}

// 산출물 파일 미리보기. 텍스트는 textContent로, html은 스크립트를 막은 sandbox iframe(서버 미리보기 URL 또는 blob URL)으로 보여준다
async function renderFileInto(box, file, { compact = false } = {}) {
  revokeBlobs(box);
  const kind = fileKind(file.name);
  const head = el('div', 'fp-head');
  head.append(el('b', '', file.rel || file.name));
  const dl = el('button', 'btn btn-sm', '다운로드');
  dl.type = 'button';
  dl.addEventListener('click', () => downloadFile(file));
  const body = el('div', 'fp-body');
  if (!compact) box.replaceChildren(head, body); else box.replaceChildren(body);
  if (!compact) head.append(dl);
  if (kind === 'binary') {
    body.append(el('p', 'muted-text', '미리보기를 지원하지 않는 형식이에요. 내려받아 확인해 주세요.'));
    if (compact) { const b = dl; body.append(b); }
    return;
  }
  body.append(el('p', 'muted-text', '불러오는 중…'));
  let text;
  try {
    ({ text } = await fetchFileText(file.path));
  } catch (e) {
    body.replaceChildren(el('p', 'help', `불러오지 못했어요: ${e.message}`));
    return;
  }
  const cut = text.length > PREVIEW_MAX;
  if (cut) text = text.slice(0, PREVIEW_MAX);
  const source = () => el('pre', 'preview-box', text);
  let view;
  if (kind === 'markdown') view = markdownNode(text);
  else if (kind === 'json') {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 원문 그대로 */ }
    view = el('pre', 'preview-box', pretty);
  } else if (kind === 'html') {
    const frame = document.createElement('iframe');
    frame.className = 'html-frame';
    frame.setAttribute('sandbox', ''); // 스크립트·폼·팝업·같은 출처 접근 모두 막는다
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = `${file.name} 미리보기`;
    // iframe은 토큰 헤더를 실을 수 없고 서버는 X-Frame-Options DENY라, 토큰으로 받은 원문을 blob URL로 띄운다(iframe 문서 속성으로 원문을 넣지 않는다)
    const url = URL.createObjectURL(new Blob([withPreviewCsp(text)], { type: 'text/html;charset=utf-8' }));
    frame.dataset.blob = url;
    frame.src = url;
    view = frame;
  } else view = source();
  body.replaceChildren(view);
  if (kind === 'markdown' || kind === 'html') {
    const toggle = el('button', 'btn btn-sm', kind === 'html' ? '소스 보기' : '원문 보기');
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', 'false');
    let raw = false;
    toggle.addEventListener('click', () => {
      raw = !raw;
      toggle.setAttribute('aria-pressed', String(raw));
      body.replaceChildren(raw ? source() : view);
    });
    if (compact) { const bar = el('div', 'fp-tools'); bar.append(toggle); box.prepend(bar); } else head.append(toggle);
  }
  if (cut) box.append(el('p', 'help', `파일이 커서 앞부분 ${PREVIEW_MAX.toLocaleString()}자만 보여요. 전체는 내려받아 확인해 주세요.`));
}

function openOutputs(taskId) {
  ui.out.sel = taskId || null;
  ui.out.sig = '';
  setView('outputs');
  if (taskId) { loadTaskFiles(taskId); $('outDetail').focus({ preventScroll: true }); }
}

async function openFolder(taskId) {
  try {
    await api('POST', outputUrl(taskId, '/open'));
    toast('산출물 폴더를 열었어요.');
  } catch (e) { toast(e.message, { type: 'error' }); }
}

// ───── 사용자 확인(승인·반려) ─────
function openApprove(taskId, { focusFeedback = false } = {}) {
  if (!taskId) return;
  ui.approve = { taskId, sig: '', busy: false };
  $('approveFeedback').value = '';
  $('approveError').hidden = true;
  const dlg = $('approveDialog');
  if (!dlg.open) dlg.showModal();
  loadTaskFiles(taskId, true);
  renderApprove();
  (focusFeedback ? $('approveFeedback') : $('approveOk')).focus();
}

function renderApprove() {
  const st = ui.approve;
  const dlg = $('approveDialog');
  if (!st || !dlg.open) return;
  const t = outputTask(st.taskId);
  const files = ui.out.files.get(st.taskId);
  $('approveTitle').textContent = `사용자 확인 · ${t.title || t.id}`;
  $('approveSub').textContent = t.id;
  setHTML($('approveSteps'), stepperHtml(t) + (t.plan ? planHtml(t, t.plan) : '') + missingOutputsHtml(t));
  const waiting = t.status === 'review';
  const status = S.demo ? '데모 모드에서는 승인·반려를 보낼 수 없어요.' : st.busy ? '보내는 중…' : waiting ? '' : `이 업무는 지금 '${TASK_STATUS_LABEL[t.status] || t.status}' 상태예요.`;
  $('approveStatus').textContent = status;
  $('approveOk').disabled = S.demo || st.busy || !waiting;
  $('approveReject').disabled = S.demo || st.busy || !waiting;
  $('approveFeedback').disabled = S.demo || !waiting;
  const sig = JSON.stringify([st.taskId, !!files?.loading, files?.error, files?.data ? 1 : 0]);
  if (st.sig === sig) return;
  st.sig = sig;
  const g = files?.groups || groupOutputFiles([], st.taskId);
  const report = $('approveReport');
  revokeBlobs($('approvePreview'));
  if (files?.loading || !files) report.replaceChildren(el('p', 'muted-text', '불러오는 중…'));
  else if (g.report) renderFileInto(report, g.report, { compact: true });
  else report.replaceChildren(el('p', 'muted-text', files.error ? `불러오지 못했어요: ${files.error}` : '아직 report.md가 없어요.'));
  const all = [g.meeting, g.brief, g.notes, ...g.common, ...g.depts.flatMap(([, l]) => l), ...g.reviews].filter(Boolean);
  const preview = $('approvePreview');
  preview.replaceChildren(el('p', 'help', all.length ? '파일을 누르면 여기에서 미리 봅니다.' : ''));
  const list = $('approveFiles');
  list.replaceChildren(...(all.length ? [...fileButtons(all, preview).children] : [el('li', 'muted-text', files?.loading ? '불러오는 중…' : '산출물 파일이 없어요.')]));
}

async function submitApprove() {
  const st = ui.approve;
  if (!st || st.busy || S.demo) return;
  st.busy = true;
  renderApprove();
  try {
    await api('POST', `/api/tasks/${encodeURIComponent(st.taskId)}/approve`);
    toast(`'${taskTitle(st.taskId)}' 업무를 승인했어요. 완료로 바꿨어요.`);
    $('approveDialog').close();
    await refresh();
  } catch (e) {
    $('approveError').textContent = e.message; $('approveError').hidden = false;
  } finally {
    if (ui.approve) { ui.approve.busy = false; renderApprove(); }
  }
}

async function submitReject() {
  const st = ui.approve;
  if (!st || st.busy || S.demo) return;
  const feedback = $('approveFeedback').value.trim();
  if (!feedback) {
    $('approveError').textContent = '무엇을 고쳐야 하는지 피드백을 적어 주세요. 비서실장이 이 내용으로 다시 배정합니다.';
    $('approveError').hidden = false;
    $('approveFeedback').focus();
    return;
  }
  st.busy = true;
  renderApprove();
  try {
    await api('POST', `/api/tasks/${encodeURIComponent(st.taskId)}/reject`, { feedback });
    toast('반려 피드백을 비서실장에게 전달했어요. 다시 배정합니다.');
    $('approveDialog').close();
    await refresh();
  } catch (e) {
    $('approveError').textContent = e.message; $('approveError').hidden = false;
  } finally {
    if (ui.approve) { ui.approve.busy = false; renderApprove(); }
  }
}

// 관제 카드의 [승인]: 확인 후 바로 보낸다
async function quickApprove(taskId) {
  if (!taskId) return;
  if (!(await confirmBox(`'${taskTitle(taskId)}' 업무를 승인하고 완료로 바꿀까요?`, '승인'))) return;
  try {
    await api('POST', `/api/tasks/${encodeURIComponent(taskId)}/approve`);
    toast('승인했어요. 업무를 완료로 바꿨어요.');
    await refresh();
  } catch (e) { toast(e.message, { type: 'error' }); }
}

// ───── 역량 공백 ─────
function openGap(a) {
  const gaps = S.gaps.filter((x) => (a.task ? x.task === a.task : x.need === a.need));
  const text = gaps.length ? gaps.map((g) => `${g.need}${g.suggestion ? ` → ${g.suggestion}` : ''}`).join('\n') : (a.text || a.need || '필요한 역량을 가진 부서가 없습니다.');
  $('gapText').textContent = `${a.task ? `[${taskTitle(a.task)}]\n` : ''}${text}`;
  $('gapDialog').showModal();
  $('gapGoOrg').focus();
}

function goOrg() {
  setView('org');
  requestAnimationFrame(() => {
    const target = $('orgGaps') || $('orgPresets');
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('main').focus({ preventScroll: true });
  });
}

// ───── 공통 동작 ─────
async function act(btn) {
  const { act: action, id, dept, run, task } = btn.dataset;
  if (S.demo && WRITE_ACTS.has(action)) { toast(DEMO_HINT); return undefined; }
  try {
    switch (action) {
      case 'new-dept': return openDeptDialog();
      case 'add-preset': return addPresetDept(Number(btn.dataset.preset), btn.dataset.bulk === '1');
      case 'open-agent': return id === 'chief' ? openDrawer('chief', 'chief') : openDrawer('agent', id);
      case 'open-chief': return openDrawer('chief', 'chief');
      case 'attn': return openAttentionByKey(btn.dataset.attn);
      case 'open-approve': return openApprove(task);
      case 'approve-task': return quickApprove(task);
      case 'reject-task': return openApprove(task, { focusFeedback: true });
      case 'out-show': return openOutputs(task);
      case 'out-open': ui.out.sel = task; renderOutputs(); loadTaskFiles(task); $('outDetail').focus({ preventScroll: true }); return undefined;
      case 'out-back': { const sel = ui.out.sel; ui.out.sel = null; renderOutputs(); document.querySelector(`[data-key="oi-${CSS.escape(sel || '')}"]`)?.focus(); return undefined; }
      case 'out-folder': return openFolder(task);
      case 'go-org': return goOrg();
      case 'company': return openCompany();
      case 'cap-del': {
        const d = deptOf(id);
        if (!d) return undefined;
        return saveDeptTags(id, { capabilities: (d.capabilities || []).filter((c) => c !== btn.dataset.tag) }, `${d.name} 역량에서 '${btn.dataset.tag}'를 뺐어요.`);
      }
      case 'handoff-del': {
        const d = deptOf(id);
        if (!d) return undefined;
        return saveDeptTags(id, { handoffs: (d.handoffs || []).filter((h) => h !== btn.dataset.tag) }, `${d.name}의 결과 전달 대상에서 뺐어요.`);
      }
      case 'open-dept': return openDrawer('dept', id);
      case 'add-agent': return openAgentDialog({ deptId: dept });
      case 'bulk': return openBulk(dept);
      case 'edit-agent': return openAgentDialog({ agent: S.agents[id] });
      case 'edit-dept': return openDeptDialog(deptOf(id));
      case 'run-agent': return openRunDialog(id);
      case 'log-run': return showLog(run);
      case 'open-thread': return openThread(run);
      case 'feed-more': {
        const key = btn.dataset.task ?? '';
        if (ui.feedOpen.has(key)) ui.feedOpen.delete(key); else ui.feedOpen.add(key);
        return renderFeed();
      }
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
  const prev = ui.view;
  ui.view = VIEWS.includes(view) ? view : 'control';
  store('ai-office-view', ui.view);
  for (const tab of document.querySelectorAll('.view-tabs [role="tab"]')) {
    const on = tab.dataset.view === ui.view;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  if (ui.view === 'outputs' && prev !== 'outputs') loadOutputs(true);
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
  ui.view = VIEWS.includes(store('ai-office-view')) ? store('ai-office-view') : 'control';
  ui.feedDetail = store('ai-office-feed-detail') === '1';
  setNotify(store('ai-office-notify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted');

  $('deptSwatches').innerHTML = COLORS.map((c) => `<button type="button" class="swatch" style="--c:${c}" data-color="${c}" aria-label="색 ${c}" aria-pressed="false"></button>`).join('');
  $('toolChecks').innerHTML = TOOLS.map((t) => `<label class="inline"><input type="checkbox" value="${t}"> ${t}</label>`).join('');

  office = createOffice($('officeCanvas'), {
    onAgentClick: (id) => (id === 'chief' ? openDrawer('chief', 'chief') : openDrawer('agent', id)),
    onAttentionClick: (id) => openAttention(attentionByAgent(S.attention).get(id)?.top),
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
  document.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!(d instanceof HTMLElement) || !d.matches('details[data-orgmap]')) return;
    ui.orgmapOpen = d.open;
    if (d.open && !orgmapCache) loadOrgmap(d);
  }, true);
  $('chiefForm').addEventListener('submit', submitChief);
  $('notifyBtn').addEventListener('click', toggleNotify);
  $('feedDetailBtn').addEventListener('click', () => {
    ui.feedDetail = !ui.feedDetail;
    store('ai-office-feed-detail', ui.feedDetail ? '1' : '0');
    renderFeed();
  });
  $('approveOk').addEventListener('click', submitApprove);
  $('approveReject').addEventListener('click', submitReject);
  $('approveDialog').addEventListener('close', () => { ui.approve = null; revokeBlobs($('approvePreview')); revokeBlobs($('approveReport')); });
  $('gapGoOrg').addEventListener('click', () => { $('gapDialog').close(); goOrg(); });
  for (const id of ['outQ', 'outDate', 'outDept', 'outStatus']) $(id).addEventListener(id === 'outQ' ? 'input' : 'change', () => renderOutputs());
  $('outFilters').addEventListener('submit', (ev) => ev.preventDefault());
  // 조직 탭: 역량 태그(Enter·쉼표로 추가), 결과 전달 부서(선택 즉시 추가)
  document.addEventListener('keydown', (ev) => {
    const input = ev.target.closest?.('[data-cap-input]');
    if (input && (ev.key === 'Enter' || ev.key === ',') && !ev.isComposing) { ev.preventDefault(); addCapability(input); }
  });
  document.addEventListener('change', (ev) => {
    const sel = ev.target.closest?.('[data-handoff-add]');
    if (!sel || !sel.value) return;
    const d = deptOf(sel.dataset.handoffAdd);
    const add = sel.value;
    sel.value = '';
    if (d) saveDeptTags(d.id, { handoffs: [...new Set([...(d.handoffs || []), add])] }, `${d.name} → ${deptOf(add)?.name || add}: 결과 전달 대상을 추가했어요.`);
  });
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
  $('threadForm').addEventListener('submit', submitThread);
  $('threadPrompt').addEventListener('keydown', (ev) => {
    // Ctrl/⌘+Enter로 보내기
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); $('threadForm').requestSubmit(); }
  });
  $('threadDialog').addEventListener('close', () => { ui.thread = null; threadSig = ''; });
  $('logToggle').addEventListener('click', () => { logView.showRaw = !logView.showRaw; renderLog(); });

  tick();
  setInterval(tick, 1000);
  setInterval(() => { if (lastRaw) render(); }, 15000);
  setView(ui.view);
  refresh().then(connect);
}

if (typeof document !== 'undefined' && document.getElementById('app')) init();
