// 이벤트 → 업무 흐름(업무 언어 피드). 순수 함수다(파일·시계·전역 상태를 읽지 않는다).
// 표준 흐름: 요청 → 내용 확인 → [회의] → 업무 하달 → 업무 전달받음 → 진행 중 → 작업 완료
//   → 업무 협조 요청(부서A→부서B, 비서실장 경유) → … → 검토 요청 → 검토 통과/반려 → 사용자 확인 대기 → 승인/반려
// 부서 이름·id를 하드코딩하지 않는다. 부서는 직원 정본(org.roster)의 department로만 정한다.

export const FLOW_STAGES = ['request', 'intake', 'meeting', 'kickoff', 'assign', 'accept', 'progress', 'done', 'cooperate',
  'review_request', 'review_pass', 'review_reject', 'deliver', 'user_approve', 'user_reject', 'codex_review', 'reply_wait'];

// 업무 카드의 단계 표시줄: 요청 → 확인 → 하달 → 진행 → 협조 → 검토 → 사용자 확인 → 완료
export const FLOW_STEPS = [
  { key: 'request', label: '요청', stages: ['request'] },
  { key: 'intake', label: '확인', stages: ['intake', 'meeting'] },
  { key: 'assign', label: '하달', stages: ['kickoff', 'assign'] },
  { key: 'progress', label: '진행', stages: ['accept', 'progress', 'done'] },
  { key: 'cooperate', label: '협조', stages: ['cooperate'] },
  { key: 'review', label: '검토', stages: ['review_request', 'review_pass', 'review_reject', 'codex_review'] },
  { key: 'user', label: '사용자 확인', stages: ['deliver'] },
  { key: 'done', label: '완료', stages: ['user_approve'] },
];

const STEP_INDEX = Object.fromEntries(FLOW_STEPS.map((st, i) => [st.key, i]));

export const CHIEF = 'chief';
export const USER = 'user';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const MEETING_TAG = '[회의]';
const REJECT_TAG = '[반려]';
// office.mjs·서버가 남기는 이벤트의 session 값(대화 세션이 아니다)
const isInternalSession = (s) => typeof s !== 'string' || s.startsWith('office-');
// 명시 이벤트가 자동 도출 항목을 대신할 때 거슬러 찾는 범위
const LOOKBACK_ITEMS = 20;
const LOOKBACK_MS = 10 * 60 * 1000;
// 하달 킥오프: 회의실 연출 시간
export const KICKOFF_MS = 8000;
// 계획표 없이 첫 배정으로 열린 킥오프는 이 시간 안의 배정(한 응답의 병렬 호출)을 참석자로 더한다
const KICKOFF_GATHER_MS = 3000;
// 끝 기록(meeting.end·[회의] 의견 제출)이 없는 실제 회의는 이 시간이 지나면 끝난 것으로 본다(회의실을 영구히 잡지 않게)
export const MEETING_STALE_MS = 30 * 60 * 1000;
// 계획표 단계가 완료됐지만 산출물 파일이 없는 상태(서버가 fs 확인 결과를 opts.outputs로 넣을 때만)
export const DONE_MISSING_OUTPUT = 'done_missing_output';

function clip(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

function baseName(p) {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean);
  return clip(parts.at(-1) ?? '', 40);
}

function firstSentence(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.+?[.!?。])(\s|$)/);
  return clip(m ? m[1] : s, 80);
}

// 직원 결과 첫 문장을 업무 언어로: Markdown 기호·표·코드 표시를 걷어내고, outputs/… 경로는 파일 이름만 남기고, 앞의 '결과:'를 뗀다
// (파일은 아래 파일 칩으로 따로 보여준다)
export function cleanResultText(text) {
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+>]|\d+\.)\s+/gm, '')
    .replace(/:?-{3,}:?/g, ' ')
    .replace(/\|/g, ' ');
  s = s.replace(/(?:\.{1,2}\/)?(?:[\w.-]+\/)*outputs\/[^\s'"(),]+/g, (p) => p.replace(/[.。]+$/, '').split('/').filter(Boolean).pop() || p);
  s = s.replace(/\s+/g, ' ').trim().replace(/^(?:결과|요약|완료)\s*[:：]\s*/, '');
  return firstSentence(s);
}

// 직원이 일을 끝내지 못했다고 보고한 결과(작업 완료로 표시하지 않는다)
const FAILURE_RESULT = /(하지 못했|하지 못하였|못했습니다|실패했|실패하였|막혀서|막혔|중단했|할 수 없었|권한이 없어)/;

function hostOf(url) {
  try {
    return new URL(String(url)).hostname || clip(url, 40);
  } catch {
    return clip(url, 40);
  }
}

// 도구 이벤트 → 업무 언어(명령어 원문은 숨긴다)
export function translateTool(tool, summary = '') {
  switch (tool) {
    case 'WebSearch': return summary ? `자료 검색 '${clip(summary, 40)}'` : '자료 검색';
    case 'WebFetch': return summary ? `웹페이지 확인 '${hostOf(summary)}'` : '웹페이지 확인';
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return summary ? `자료 확인 '${baseName(summary)}'` : '자료 확인';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return summary ? `문서 작성 '${baseName(summary)}'` : '문서 작성';
    case 'Bash':
    case 'PowerShell': {
      if (/\bpython[0-9.]*\b|\.py\b|\bRscript\b/i.test(summary)) return '분석 스크립트 실행';
      if (/\b(curl|wget)\b/i.test(summary)) return '웹 자료 수집';
      return '데이터 처리 중';
    }
    case 'Skill': return summary ? `양식 사용 '${clip(summary, 40)}'` : '양식 사용';
    case 'TodoWrite': return '할 일 정리';
    default: return `${clip(tool || '도구', 30)} 사용`;
  }
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const AGENT_SUMMARY = /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}): (.*)$/;

// Agent 호출 대상·설명. 구조화 필드(target, desc)를 쓰고, 예전 이벤트는 summary("대상: 설명")로 보충한다
function agentCall(ev, rosterIds) {
  let target = typeof ev.target === 'string' ? ev.target : null;
  let desc = typeof ev.desc === 'string' ? ev.desc : null;
  if (!target || desc === null) {
    const m = typeof ev.summary === 'string' ? ev.summary.match(AGENT_SUMMARY) : null;
    if (m && (rosterIds.has(m[1]) || !target)) {
      target = target || m[1];
      if (desc === null) desc = m[2];
    }
  }
  if (desc === null) desc = typeof ev.summary === 'string' ? ev.summary : '';
  return { target, desc: desc.trim() };
}

function planOf(plans, task) {
  if (!plans || !task) return null;
  const p = plans instanceof Map ? plans.get(task) : plans[task];
  // 깨진 계획표(이벤트·파일)가 상태 계산 전체를 멈추지 않게 단계가 모두 id 있는 객체일 때만 쓴다
  return p && typeof p === 'object' && Array.isArray(p.stages) && p.stages.every((s) => s && typeof s === 'object' && typeof s.id === 'string') ? p : null;
}

/**
 * 이벤트를 업무 흐름 항목과 업무별 요약으로 바꾼다.
 * @param {any[]} events 정규화 이벤트(시간순)
 * @param {{departments:any[], roster:any[]}} org
 * @param {{plans?:Map|object, tasks?:any[], outputs?:Map|object}} [opts] plans: 업무 id → 계획표 요약(plan.json). plan.set 이벤트가 있으면 그것이 우선한다.
 *   outputs: 업무 id → {단계 id: 산출물 파일이 있는지}. 서버가 fs로 확인해 넣는다(이 함수는 파일을 읽지 않는다). 값이 false인 완료 단계는 'done_missing_output'
 * @returns {{items:object[], tasks:Object<string,object>, meetings:object[]}} meetings: 킥오프·실제 회의 기록(시간순, 대기열 계산 전 — scheduleMeetings로 현재 상태를 만든다)
 */
export function deriveTaskFlows(events, org, { plans, tasks = [], outputs = null } = {}) {
  const list = Array.isArray(events) ? events : [];
  const roster = Array.isArray(org?.roster) ? org.roster : [];
  const departments = Array.isArray(org?.departments) ? org.departments : [];
  const agentById = new Map(roster.filter((a) => a && a.id).map((a) => [a.id, a]));
  const deptById = new Map(departments.filter((d) => d && d.id).map((d) => [d.id, d]));
  const rosterIds = new Set(agentById.keys());

  const deptOf = (agentId) => agentById.get(agentId)?.department ?? null;
  const deptName = (id) => {
    if (id === CHIEF) return '비서실장';
    if (id === USER) return '사용자';
    if (!id) return '미등록';
    return deptById.get(id)?.name || id;
  };
  const person = (agentId) => {
    if (agentId === CHIEF) return '비서실장';
    const a = agentById.get(agentId);
    if (!a) return `${agentId || '알 수 없음'}(미등록)`;
    return `${deptName(a.department)} ${a.name || a.id}`;
  };

  // 1) 대화 턴(요청 → 다음 요청) 단위로 업무를 정한다.
  // 요청 이벤트는 업무 등록(OFFICE_TASK)보다 먼저 나오고, 등록 전 이벤트에는 이전 업무가 붙어 있을 수 있어서
  // 같은 턴에서 마지막으로 보인 업무를 턴 전체의 업무로 본다.
  const turnOf = new Array(list.length);
  const turnTask = new Map();
  const curTurn = new Map();
  list.forEach((ev, i) => {
    if (!ev || typeof ev !== 'object' || isInternalSession(ev.session)) return;
    if (ev.kind === 'request') curTurn.set(ev.session, `${ev.session}#${i}`);
    let key = curTurn.get(ev.session);
    if (!key) {
      key = `${ev.session}#start`;
      curTurn.set(ev.session, key);
    }
    turnOf[i] = key;
    if (typeof ev.task === 'string' && ev.task) turnTask.set(key, ev.task);
  });
  const taskAt = (i, ev) => (turnOf[i] && turnTask.get(turnOf[i])) || (typeof ev.task === 'string' && ev.task ? ev.task : null);

  const items = [];
  const pendingIntake = new Set(); // 요청 뒤 비서실장의 첫 활동을 기다리는 턴
  const pendingCalls = new Map(); // `${task}|${target}` → [호출 정보] (Agent 호출 → SubagentStart 연결)
  const instanceCall = new Map(); // 실행 인스턴스 → 호출 정보
  const progressItem = new Map(); // 실행 인스턴스 → 진행 중 항목(직원별 한 줄 유지)
  const filesOf = new Map(); // 실행 인스턴스 → 작성 파일 basename
  const completed = new Map(); // task → [{dept, agent, ts}]
  const meetingOpen = new Set(); // 명시 회의(meeting.start~end) 진행 중인 업무
  const explicitPending = new Map(); // `${stage}|${task}|${dept}` → 남은 수(명시 이벤트가 먼저 온 경우 다음 자동 항목을 대신)
  const planState = new Map(); // task → {plan, fromEvent, stages: Map(id → {status, rejects})}
  const taskTitle = new Map((Array.isArray(tasks) ? tasks : []).filter((t) => t && t.id && t.title).map((t) => [t.id, t.title]));
  const meetings = []; // 회의실 사용 기록: {task, kind:'kickoff'|'meeting', attendees, since, until?}
  const kickoffs = new Map(); // task → {item, entry, ms, fromPlan}
  const openMeeting = new Map(); // task → 진행 중인 실제 회의 기록(meeting.start 또는 [회의] 호출)

  const setPlan = (task, plan, fromEvent) => {
    const prev = planState.get(task);
    const stages = new Map();
    for (const s of plan.stages) {
      const old = prev?.stages.get(s.id);
      stages.set(s.id, old ? { ...old } : { status: 'pending', rejects: 0 });
    }
    planState.set(task, { plan, fromEvent, stages, ts: null });
  };
  // 계획표 파일(plan.json)은 이벤트가 없을 때의 표시용 기본값이다. 계획 밖 경고는 plan.set 이벤트 이후 호출에만 단다
  if (plans) {
    const entries = plans instanceof Map ? [...plans.entries()] : Object.entries(plans);
    for (const [task, plan] of entries) if (planOf({ [task]: plan }, task)) setPlan(task, plan, false);
  }
  const planStage = (task, pred) => {
    const ps = planState.get(task);
    if (!ps) return null;
    for (const s of ps.plan.stages) if (pred(s, ps.stages.get(s.id))) return { s, st: ps.stages.get(s.id) };
    return null;
  };

  const push = (item) => {
    const clean = {};
    for (const [k, v] of Object.entries(item)) if (v !== undefined && v !== null && v !== '') clean[k] = v;
    items.push(clean);
    return clean;
  };

  // 명시 이벤트가 자동 도출 항목을 대신한다. 자동 항목이 이미 있으면 지우고, 없으면 다음 자동 항목을 건너뛰게 표시한다
  // afterMs: 이보다 앞선 자동 항목은 다른 단계의 정당한 하달이라 지우지 않는다(협조는 마지막 앞선 완료 이후의 호출만 대신한다)
  const supersede = (stages, task, to, ts, afterMs = -Infinity) => {
    const tsMs = Date.parse(ts);
    for (let i = items.length - 1, n = 0; i >= 0 && n < LOOKBACK_ITEMS; i--, n++) {
      const it = items[i];
      if (it._removed || !it._auto || it.task !== task || it.to !== to || !stages.includes(it.stage)) continue;
      if (Number.isFinite(tsMs) && tsMs - Date.parse(it.ts) > LOOKBACK_MS) break;
      if (Date.parse(it.ts) < afterMs) break;
      it._removed = true;
      return;
    }
    const key = `${stages[0]}|${task}|${to}`;
    explicitPending.set(key, (explicitPending.get(key) ?? 0) + 1);
  };
  const consumeExplicit = (stage, task, to) => {
    const key = `${stage}|${task}|${to}`;
    const n = explicitPending.get(key) ?? 0;
    if (!n) return false;
    if (n === 1) explicitPending.delete(key);
    else explicitPending.set(key, n - 1);
    return true;
  };

  // 반려된 계획 단계 표시. 단계 id(--stage) > 직원 id(--to 직원) > 부서(그 부서의 진행·완료 단계가 하나뿐일 때만) 순으로 고른다.
  // 단계를 특정하지 못하면 바꾸지 않고 이어지는 [반려] 호출(대상 직원)에 맡긴다
  const markRejected = (task, { dept = null, agent = null, stage = null } = {}) => {
    const ps = planState.get(task);
    if (!ps) return;
    const touched = (st) => st.status === 'done' || st.status === 'active';
    let hit = null;
    if (stage && ps.stages.has(stage)) hit = ps.stages.get(stage);
    else if (agent) {
      for (const s of ps.plan.stages) if (s.agent === agent && touched(ps.stages.get(s.id))) hit = ps.stages.get(s.id);
    } else if (dept) {
      const cands = ps.plan.stages.filter((s) => s.dept === dept && touched(ps.stages.get(s.id)));
      if (cands.length === 1) hit = ps.stages.get(cands[0].id);
    }
    if (hit) {
      hit.status = 'rejected';
      hit.rejects += 1;
    }
  };
  const lastCompletionMs = (task) => {
    const done = completed.get(task) ?? [];
    return done.length ? Date.parse(done[done.length - 1].ts) : -Infinity;
  };

  // 하달 킥오프: 업무가 하달되면 담당 인원이 회의실에 모인다. 트리거는 plan.set(참석: 계획의 모든 담당 + 비서실장),
  // 계획표가 없으면 그 업무의 첫 하달·협조 호출(참석: 그 시점까지 배정된 직원 + 비서실장). 업무마다 한 번이다
  const shortName = (id) => (id === CHIEF ? '비서실장' : agentById.get(id)?.name || id);
  const kickoffText = (task, attendees) => {
    const names = attendees.filter((a) => a !== CHIEF).map(shortName);
    const shown = names.length > 6 ? `${names.slice(0, 6).join(', ')} 외 ${names.length - 6}명` : names.join(', ');
    const title = clip(taskTitle.get(task) || planState.get(task)?.plan.goal || String(task).split('/').pop(), 40);
    return `비서실장: ${title} 업무 킥오프${shown ? ` — 참석 ${shown}` : ''}`;
  };
  const openKickoff = (task, ts, agents, fromPlan) => {
    if (!task || kickoffs.has(task)) return;
    const attendees = [...new Set([CHIEF, ...agents.filter((a) => typeof a === 'string' && a)])];
    const item = push({ task, ts, stage: 'kickoff', from: CHIEF, to: CHIEF, actor: CHIEF, attendees, text: kickoffText(task, attendees) });
    const entry = { task, kind: 'kickoff', attendees, since: ts };
    meetings.push(entry);
    kickoffs.set(task, { item, entry, ms: Date.parse(ts), fromPlan });
  };
  const joinKickoff = (task, ts, agent) => {
    const k = kickoffs.get(task);
    if (!k || k.fromPlan || !agent || k.entry.attendees.includes(agent)) return;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms) || !Number.isFinite(k.ms) || ms - k.ms > KICKOFF_GATHER_MS) return;
    k.entry.attendees.push(agent);
    k.item.text = kickoffText(task, k.entry.attendees);
  };
  // 실제 회의(meeting.start~end, [회의] 호출 ~ 참석자 의견 제출). meeting.start의 부서 id는 그 부서 팀장으로 바꾼다
  const attendeeIds = (list) => list.flatMap((a) => {
    if (agentById.has(a)) return [a];
    const lead = deptById.has(a) ? roster.find((r) => r && r.department === a && r.lead) : null;
    return lead ? [lead.id] : [];
  });

  list.forEach((ev, i) => {
    if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') return;
    const task = taskAt(i, ev);
    const ts = ev.ts;
    const actor = typeof ev.agent === 'string' && ev.agent ? ev.agent : CHIEF;
    const ik = `${ev.session ?? ''}|${ev.instance ?? ev.session ?? ''}`;
    const turn = turnOf[i];

    // 요청 직후 비서실장의 첫 활동 → 내용 확인
    if (actor === CHIEF && turn && pendingIntake.has(turn) && ev.kind !== 'request' && ev.kind !== 'session.start') {
      pendingIntake.delete(turn);
      push({ task, ts, stage: 'intake', from: CHIEF, to: CHIEF, actor: CHIEF, text: '비서실장: 요청 내용 확인' });
    }

    switch (ev.kind) {
      case 'request': {
        const what = clip(ev.summary, 80);
        if (actor === CHIEF) {
          pendingIntake.add(turn);
          push({ task, ts, stage: 'request', from: USER, to: CHIEF, actor: USER, text: `사용자 → 비서실장: 업무 요청 '${what}'`, detail: ev.summary });
        } else {
          // 대시보드에서 직원에게 직접 지시한 실행(claude -p --agent <id>)
          const dept = deptOf(actor);
          push({ task, ts, stage: 'request', from: USER, to: dept, actor: USER, dept, text: `사용자 → ${person(actor)}: 업무 요청 '${what}'`, detail: ev.summary });
        }
        return;
      }
      case 'task.start':
        if (actor !== CHIEF) {
          // 대시보드 직원 직접 지시: runner가 산출물 폴더를 업무로 등록했다
          const dept = deptOf(actor);
          push({ task, ts, stage: 'intake', from: USER, to: dept, actor, dept, text: `${person(actor)}: 업무 등록(직접 지시) '${clip(ev.summary || task, 60)}'` });
          return;
        }
        push({ task, ts, stage: 'intake', from: CHIEF, to: CHIEF, actor: CHIEF, text: `비서실장: 업무 등록 '${clip(ev.summary || task, 60)}'` });
        return;
      case 'plan.set': {
        if (!task || !planOf({ [task]: ev.plan }, task)) return;
        setPlan(task, ev.plan, true);
        const gaps = Array.isArray(ev.plan.gaps) ? ev.plan.gaps.filter((g) => g && g.need) : [];
        push({
          task, ts, stage: 'intake', from: CHIEF, to: CHIEF, actor: CHIEF,
          text: `비서실장: 작업 계획 확정 — 단계 ${ev.plan.stages.length}개${gaps.length ? `, 역량 공백 ${gaps.length}건` : ''}`,
          detail: gaps.length ? gaps.map((g) => `${g.need}${g.suggestion ? ` → ${g.suggestion}` : ''}`).join(' / ') : undefined,
        });
        openKickoff(task, ts, ev.plan.stages.map((s) => s.agent), true);
        return;
      }
      case 'tool.start':
        if (AGENT_TOOLS.has(ev.tool)) {
          handleAgentCall(ev, task, actor);
          return;
        }
        if (actor === CHIEF) return; // 비서실장 자신의 도구 사용은 업무 피드에 싣지 않는다(상세 보기에서 본다)
        handleProgress(ev, task, actor, ik);
        return;
      case 'agent.start': {
        if (actor === CHIEF) return;
        const key = `${task}|${actor}`;
        // 가장 최근 호출과 짝짓는다. 거부된 호출(chief-guard)은 SubagentStart 없이 남으므로 오래된 것은 버린다
        const nowMs = Date.parse(ts);
        const queue = (pendingCalls.get(key) ?? []).filter((c) => !Number.isFinite(nowMs) || !Number.isFinite(c.ms) || nowMs - c.ms <= LOOKBACK_MS);
        const call = queue.pop() ?? null;
        if (queue.length) pendingCalls.set(key, queue);
        else pendingCalls.delete(key);
        instanceCall.set(ik, call);
        const dept = deptOf(actor);
        const mode = call?.mode;
        const text = mode === 'meeting' ? `${person(actor)}: 회의 참석` : mode === 'reject' ? `${person(actor)}: 반려 사항 확인` : `${person(actor)}: 업무 전달받음`;
        push({ task, ts, stage: 'accept', from: call?.from ?? CHIEF, to: dept, actor, dept, text, mode: mode === 'meeting' || mode === 'reject' ? mode : undefined });
        return;
      }
      case 'agent.stop':
        if (actor === CHIEF) return;
        finishWork(ev, task, actor, ik, instanceCall.get(ik));
        return;
      case 'turn.end':
        // 직원 직접 지시 실행(메인 세션이 그 직원)의 끝
        if (actor !== CHIEF && ev.engine !== 'codex' && ev.instance === ev.session && agentById.has(actor)) {
          finishWork(ev, task, actor, ik, null);
        }
        return;
      case 'review.start': {
        const dept = deptOf(actor);
        // 계획에 검토 단계(Codex 검증실 직원)가 있으면 그 단계를 진행으로 표시한다
        const rh = task ? planStage(task, (s, st) => s.agent === actor && st.status !== 'done') : null;
        if (rh) rh.st.status = 'active';
        push({ task, ts, stage: 'codex_review', from: CHIEF, to: dept, actor, dept, text: `${person(actor)}: 검토 중`, _auto: true });
        return;
      }
      case 'review.end': {
        const dept = deptOf(actor);
        removeProgress(ik);
        const verdict = typeof ev.verdict === 'string' ? ev.verdict : 'FIX';
        const rh = task ? (planStage(task, (s, st) => s.agent === actor && st.status === 'active') ?? planStage(task, (s, st) => s.agent === actor && st.status !== 'done')) : null;
        if (rh) rh.st.status = 'done';
        push({ task, ts, stage: 'codex_review', from: dept, to: CHIEF, actor, dept, text: `${person(actor)}: 판정 ${verdict}`, verdict });
        return;
      }
      case 'flow.review_request': {
        const from = ev.from || deptOf(actor);
        push({ task, ts, stage: 'review_request', from, to: CHIEF, actor, dept: from, text: `${deptName(from)} → 비서실장: 검토 요청${ev.summary ? ` — ${clip(ev.summary)}` : ''}` });
        return;
      }
      case 'flow.review': {
        if (ev.verdict === 'reject') {
          const to = ev.to || null;
          supersede(['review_reject'], task, to, ts);
          markRejected(task, { dept: to, agent: typeof ev.target === 'string' ? ev.target : null, stage: typeof ev.stage === 'string' ? ev.stage : null });
          push({ task, ts, stage: 'review_reject', from: CHIEF, to, actor: CHIEF, dept: to, text: `비서실장 → ${deptName(to)}: 검토 반려${ev.summary ? ` — ${clip(ev.summary)}` : ''}` });
        } else {
          push({ task, ts, stage: 'review_pass', from: CHIEF, to: ev.to || CHIEF, actor: CHIEF, text: `비서실장: 검토 통과${ev.summary ? ` — ${clip(ev.summary)}` : ''}` });
        }
        return;
      }
      case 'flow.deliver':
        push({ task, ts, stage: 'deliver', from: CHIEF, to: USER, actor: CHIEF, text: `비서실장 → 사용자: 결과 확인 요청(사용자 확인 대기)${ev.summary ? ` — ${clip(ev.summary)}` : ''}` });
        return;
      case 'flow.cooperate': {
        const from = ev.from || null;
        const to = ev.to || null;
        supersede(['cooperate', 'assign'], task, to, ts, lastCompletionMs(task));
        push({ task, ts, stage: 'cooperate', from, to, actor: CHIEF, dept: to, text: `${deptName(from)} → ${deptName(to)}: 업무 협조 요청(비서실장 전달)${ev.summary ? ` — ${clip(ev.summary)}` : ''}` });
        return;
      }
      case 'flow.user_approve':
        push({ task, ts, stage: 'user_approve', from: USER, to: CHIEF, actor: USER, text: '사용자: 승인 — 업무 완료' });
        return;
      case 'flow.user_reject':
        push({ task, ts, stage: 'user_reject', from: USER, to: CHIEF, actor: USER, text: `사용자 → 비서실장: 반려${ev.summary ? ` — ${clip(ev.summary)}` : ''}`, detail: ev.summary });
        return;
      case 'meeting.start': {
        if (task) meetingOpen.add(task);
        const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
        if (task) {
          const prev = openMeeting.get(task);
          const ids = attendeeIds(attendees);
          if (prev) {
            // [회의] 호출이 먼저 와서 열린 회의는 명시 회의로 이어 쓴다
            delete prev.open;
            for (const id of ids) if (!prev.attendees.includes(id)) prev.attendees.push(id);
          } else {
            const entry = { task, kind: 'meeting', attendees: [...new Set([CHIEF, ...ids])], since: ts };
            meetings.push(entry);
            openMeeting.set(task, entry);
          }
        }
        const names = attendees.map((a) => (agentById.has(a) ? person(a) : deptName(a)));
        push({ task, ts, stage: 'meeting', from: CHIEF, to: CHIEF, actor: CHIEF, text: `비서실장: 회의 시작${ev.summary ? ` — ${clip(ev.summary)}` : ''}${names.length ? ` (참석: ${names.join(', ')})` : ''}`, attendees: attendees.length ? attendees : undefined });
        return;
      }
      case 'meeting.end':
        if (task) {
          meetingOpen.delete(task);
          const entry = openMeeting.get(task);
          if (entry) entry.until = ts;
          openMeeting.delete(task);
        }
        push({ task, ts, stage: 'meeting', from: CHIEF, to: CHIEF, actor: CHIEF, text: `비서실장: 회의 종료${ev.summary ? ` — ${clip(ev.summary)}` : ''}`, ended: true });
        return;
      case 'reply.wait': {
        // 이어서 답하기: 실행이 질문으로 끝나 대표의 답장을 기다린다(run으로 대화 창을 연다)
        const dept = actor === CHIEF ? null : deptOf(actor);
        push({ task, ts, stage: 'reply_wait', from: actor === CHIEF ? CHIEF : dept, to: USER, actor, dept, text: `${person(actor)} 님이 답변을 기다립니다${ev.summary ? ` — ${clip(ev.summary)}` : ''}`, run: typeof ev.run === 'string' ? ev.run : undefined });
        return;
      }
      default:
        return; // flow.offplan(Agent 호출 항목에 이미 표시), task.update 등은 업무 피드에 따로 싣지 않는다
    }
  });

  function handleAgentCall(ev, task, actor) {
    const { target, desc } = agentCall(ev, rosterIds);
    const dept = target ? deptOf(target) : null;
    const who = target ? person(target) : '(대상 미지정)';
    const from = actor === CHIEF ? CHIEF : deptOf(actor) ?? actor;
    let mode = 'assign';
    let text = desc;
    if (desc.startsWith(MEETING_TAG)) {
      mode = 'meeting';
      text = desc.slice(MEETING_TAG.length).trim();
    } else if (desc.startsWith(REJECT_TAG)) {
      mode = 'reject';
      text = desc.slice(REJECT_TAG.length).trim();
    }
    // 계획표 단계(회의 소집은 단계 진행으로 보지 않는다)
    const ps = task ? planState.get(task) : null;
    const hit = ps && target && mode !== 'meeting'
      ? (planStage(task, (s, st) => s.agent === target && st.status !== 'done' && st.status !== 'active') ?? planStage(task, (s) => s.agent === target))
      : null;

    // 협조: 계획 단계에 걸리면 그 단계의 앞 단계(dependsOn 전이)에 다른 부서 단계가 있을 때만이고, 요청 부서는 그 앞 단계 부서다.
    // 계획이 없으면 같은 업무에서 다른 부서 직원이 앞서 완료했을 때이고, 가장 최근에 완료한 다른 부서가 요청 부서다
    let coopFrom = null;
    if (mode === 'assign' && task && dept) {
      const done = completed.get(task) ?? [];
      if (hit) {
        const byId = new Map(ps.plan.stages.map((st) => [st.id, st]));
        const seen = new Set();
        const stack = [...(Array.isArray(hit.s.dependsOn) ? hit.s.dependsOn : [])];
        const upstream = [];
        while (stack.length) {
          const id = stack.shift();
          if (seen.has(id) || !byId.has(id)) continue;
          seen.add(id);
          upstream.push(byId.get(id));
          stack.push(...(Array.isArray(byId.get(id).dependsOn) ? byId.get(id).dependsOn : []));
        }
        const other = upstream.filter((st) => st.dept && st.dept !== dept);
        if (other.length) {
          const depts = new Set(other.map((st) => st.dept));
          for (let k = done.length - 1; k >= 0 && !coopFrom; k--) if (depts.has(done[k].dept)) coopFrom = done[k].dept;
          coopFrom = coopFrom ?? other[0].dept;
        }
      } else {
        for (let k = done.length - 1; k >= 0; k--) {
          if (done[k].dept && done[k].dept !== dept) {
            coopFrom = done[k].dept;
            break;
          }
        }
      }
      if (coopFrom) mode = 'cooperate';
    }
    const call = { mode, from: mode === 'cooperate' ? coopFrom : from, target, ms: Date.parse(ev.ts) };
    if (target) {
      const key = `${task}|${target}`;
      if (!pendingCalls.has(key)) pendingCalls.set(key, []);
      pendingCalls.get(key).push(call);
    }

    let offplan = false;
    let planHit = false;
    if (ps && target && mode !== 'meeting') {
      if (hit) {
        planHit = true;
        // 반려 재지시: 명시 반려(flow review)로 이미 '반려'가 된 단계는 횟수를 다시 세지 않는다
        if (mode === 'reject' && hit.st.status !== 'rejected') hit.st.rejects += 1;
        hit.st.status = 'active';
      } else if (ps.fromEvent && mode !== 'reject') {
        offplan = true;
      }
    }

    const suffix = text ? ` — ${clip(text)}` : '';
    if (mode === 'meeting' && task && target) {
      // [회의] 호출: 참석자가 의견을 낼 때까지 회의실을 쓴다(명시 회의가 열려 있으면 그 회의에 더한다)
      let entry = openMeeting.get(task);
      if (!entry) {
        entry = { task, kind: 'meeting', attendees: [CHIEF], since: ev.ts, open: new Set() };
        meetings.push(entry);
        openMeeting.set(task, entry);
      }
      if (!entry.attendees.includes(target)) entry.attendees.push(target);
      entry.open?.add(target);
    }
    if ((mode === 'assign' || mode === 'cooperate') && task && target) {
      const kp = planState.get(task);
      if (!kickoffs.has(task)) openKickoff(task, ev.ts, kp ? kp.plan.stages.map((s) => s.agent) : [target], Boolean(kp));
      else joinKickoff(task, ev.ts, target);
    }
    if (mode === 'meeting') {
      if (task && meetingOpen.has(task)) return; // 명시 회의 기록이 이미 있다
      push({ task, ts: ev.ts, stage: 'meeting', from: CHIEF, to: dept, actor: CHIEF, dept, text: `비서실장 → ${who}: 회의 소집${suffix}`, target, _auto: true });
      return;
    }
    if (mode === 'reject') {
      if (consumeExplicit('review_reject', task, dept)) return;
      if (!planHit) markRejected(task, { dept });
      push({ task, ts: ev.ts, stage: 'review_reject', from: CHIEF, to: dept, actor: CHIEF, dept, text: `비서실장 → ${who}: 검토 반려${suffix}`, target, _auto: true });
      return;
    }
    if (consumeExplicit('cooperate', task, dept)) return;
    const warn = offplan ? ' (계획에 없는 배정)' : '';
    if (mode === 'cooperate') {
      push({ task, ts: ev.ts, stage: 'cooperate', from: coopFrom, to: dept, actor: CHIEF, dept, text: `${deptName(coopFrom)} → ${who}: 업무 협조 요청(비서실장 전달)${suffix}${warn}`, target, offplan: offplan || undefined, _auto: true });
    } else {
      push({ task, ts: ev.ts, stage: 'assign', from, to: dept, actor: actor === CHIEF ? CHIEF : actor, dept, text: `${actor === CHIEF ? '비서실장' : person(actor)} → ${who}: 업무 하달${suffix}${warn}`, target, offplan: offplan || undefined, _auto: true });
    }
  }

  function handleProgress(ev, task, actor, ik) {
    const dept = deptOf(actor);
    if (WRITE_TOOLS.has(ev.tool) && ev.summary) {
      if (!filesOf.has(ik)) filesOf.set(ik, new Set());
      filesOf.get(ik).add(baseName(ev.summary));
    }
    const text = `${person(actor)}: 진행 중 — ${translateTool(ev.tool, ev.summary)}`;
    const existing = progressItem.get(ik);
    if (existing && !existing._removed) {
      existing.ts = ev.ts;
      existing.text = text;
      existing.tool = ev.tool;
      return;
    }
    progressItem.set(ik, push({ task, ts: ev.ts, stage: 'progress', from: dept, to: dept, actor, dept, text, tool: ev.tool }));
  }

  function removeProgress(ik) {
    const it = progressItem.get(ik);
    if (it) it._removed = true;
    progressItem.delete(ik);
  }

  function finishWork(ev, task, actor, ik, call) {
    removeProgress(ik);
    const dept = deptOf(actor);
    const files = [...(filesOf.get(ik) ?? [])].slice(0, 10);
    filesOf.delete(ik);
    instanceCall.delete(ik);
    const result = cleanResultText(ev.summary);
    const meeting = call?.mode === 'meeting';
    const failed = !meeting && FAILURE_RESULT.test(String(ev.summary ?? ''));
    const label = meeting ? '회의 의견 제출' : failed ? '작업 종료(확인 필요)' : '작업 완료';
    const text = `${person(actor)}: ${label}${result ? ` — ${result}` : ''}`;
    push({ task, ts: ev.ts, stage: 'done', from: dept, to: CHIEF, actor, dept, text, files: files.length ? files : undefined, mode: meeting ? 'meeting' : undefined, warn: failed || undefined });
    if (meeting && task) {
      const entry = openMeeting.get(task);
      if (entry?.open) {
        entry.open.delete(actor);
        if (!entry.open.size) {
          entry.until = ev.ts;
          openMeeting.delete(task);
        }
      }
    }
    if (meeting || !task) return;
    if (!completed.has(task)) completed.set(task, []);
    completed.get(task).push({ dept, agent: actor, ts: ev.ts });
    const hit = planStage(task, (s, st) => s.agent === actor && st.status === 'active') ?? planStage(task, (s, st) => s.agent === actor && st.status !== 'done');
    if (hit) hit.st.status = 'done';
  }

  const finalItems = items.filter((it) => !it._removed).map(({ _removed, _auto, ...rest }) => rest);

  // 2) 업무별 요약: 단계 표시줄, 반려 횟수, 참여 부서, 계획표 단계 상태, 역량 공백
  const taskStatus = new Map((Array.isArray(tasks) ? tasks : []).filter((t) => t && t.id).map((t) => [t.id, t.status]));
  const byTask = {};
  const summaryOf = (task) => {
    if (!byTask[task]) byTask[task] = { hits: [], rejects: 0, userRejects: 0, depts: new Set(), last: null, lastTs: null, lastDeliver: -1, lastUserReject: -1, lastReviewReject: -1, lastReviewOk: -1 };
    return byTask[task];
  };
  finalItems.forEach((it, idx) => {
    if (!it.task) return;
    const s = summaryOf(it.task);
    s.hits.push([it.stage, idx]);
    if (it.stage === 'deliver') s.lastDeliver = idx;
    if (it.stage === 'user_reject') s.lastUserReject = idx;
    if (it.stage === 'review_reject') { s.rejects += 1; s.lastReviewReject = idx; }
    if (it.stage === 'review_pass' || it.stage === 'deliver') s.lastReviewOk = idx;
    if (it.stage === 'user_reject') s.userRejects += 1;
    if (it.dept) s.depts.add(it.dept);
    s.last = it.text;
    s.lastTs = it.ts;
  });
  for (const task of planState.keys()) summaryOf(task);
  // 반려로 되돌아간 뒤에는 되돌아간 단계 앞까지만 지난 도달 기록을 남기고, 반려 이후 다시 도달한 단계만 더한다
  // (사용자 반려 → 하달, 검토 반려 → 진행이 현재 단계가 되어 반려 문구와 표시줄이 어긋나지 않게)
  const stepOf = (stage) => FLOW_STEPS.findIndex((st) => st.stages.includes(stage));
  const reachedSince = (s, cut, keepUpTo, anchor) => {
    const set = new Set([anchor]);
    for (const [stage, idx] of s.hits) {
      if (idx > cut || (idx < cut && stepOf(stage) <= keepUpTo)) set.add(stage);
    }
    return set;
  };
  const out = {};
  for (const [task, s] of Object.entries(byTask)) {
    const status = taskStatus.get(task);
    const open = status !== 'review' && status !== 'done';
    if (open && s.lastUserReject > s.lastDeliver) {
      s.reached = reachedSince(s, s.lastUserReject, STEP_INDEX.assign, 'assign');
    } else if (open && s.lastReviewReject > s.lastReviewOk && s.lastReviewReject > s.lastUserReject) {
      s.reached = reachedSince(s, s.lastReviewReject, STEP_INDEX.progress, 'progress');
    } else {
      s.reached = new Set(s.hits.map(([stage]) => stage));
    }
    if (status === 'done') s.reached.add('user_approve');
    if (status === 'review') s.reached.add('deliver');
    let reachedIdx = -1;
    FLOW_STEPS.forEach((step, idx) => {
      if (step.stages.some((st) => s.reached.has(st))) reachedIdx = idx;
    });
    const steps = FLOW_STEPS.map((step, idx) => {
      const hit = step.stages.some((st) => s.reached.has(st));
      let state = 'todo';
      if (hit) state = idx === reachedIdx && status !== 'done' ? 'current' : 'done';
      else if (idx < reachedIdx) state = 'skip';
      return { key: step.key, label: step.label, state };
    });
    const ps = planState.get(task);
    const exists = outputs ? (outputs instanceof Map ? outputs.get(task) : outputs[task]) : null;
    const stageStatus = (id) => {
      const st = ps.stages.get(id)?.status ?? 'pending';
      return st === 'done' && exists && exists[id] === false ? DONE_MISSING_OUTPUT : st;
    };
    out[task] = {
      steps,
      current: reachedIdx >= 0 ? FLOW_STEPS[reachedIdx].key : null,
      rejects: s.rejects,
      userRejects: s.userRejects,
      depts: [...s.depts],
      last: s.last,
      lastTs: s.lastTs,
      plan: ps ? ps.plan.stages.map((st) => ({
        id: st.id, title: st.title, dept: st.dept, agent: st.agent, output: st.output, dependsOn: st.dependsOn ?? [],
        ...(st.parallelGroup !== undefined ? { parallelGroup: st.parallelGroup } : {}),
        status: stageStatus(st.id),
        rejects: ps.stages.get(st.id)?.rejects ?? 0,
      })) : null,
      goal: ps?.plan.goal ?? null,
      gaps: ps && Array.isArray(ps.plan.gaps) ? ps.plan.gaps.filter((g) => g && g.need) : [],
    };
    out[task].missingOutputs = (out[task].plan ?? []).filter((st) => st.status === DONE_MISSING_OUTPUT).map((st) => st.id);
  }
  // 산출물 없이 완료된 단계는 비서실장 검토 요청 줄에 경고로 보인다(검토 때 놓치지 않게)
  for (const it of finalItems) {
    const missing = it.task && it.stage === 'review_request' ? out[it.task]?.missingOutputs : null;
    if (missing?.length) {
      it.warn = true;
      it.text = `${it.text} (산출물 없는 완료 단계: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' 외' : ''})`;
    }
  }
  return {
    items: finalItems,
    tasks: out,
    meetings: meetings.map(({ open: _open, ...m }) => ({ ...m, attendees: [...m.attendees] })),
  };
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/**
 * 회의실 대기열: deriveTaskFlows의 meetings를 now 기준 현재 상태로 바꾼다(순수 함수).
 * - 킥오프는 회의실이 비면 요청 순서대로 KICKOFF_MS(8초)씩 연다. since는 실제로 여는 시각, until = since + 8초.
 *   앞 회의 때문에 미뤄졌으면 requested(원래 요청 시각)를 붙이고, 아직 열리지 않았으면 waiting: true다.
 *   끝 기록이 없는 실제 회의 뒤라 여는 시각을 모르면 since는 요청 시각, waiting: true이고 until은 없다.
 * - 실제 회의는 미루지 않는다. 진행 중이면 until 없이 내고, 끝 기록이 없어도 MEETING_STALE_MS가 지나면 끝난 것으로 본다.
 * - 끝난 회의는 뺀다. 진행 중인 것이 먼저, 대기 중인 킥오프가 순서대로 뒤에 온다.
 */
export function scheduleMeetings(meetings, now, { staleMs = MEETING_STALE_MS } = {}) {
  const nowMs = toMs(now);
  const list = (Array.isArray(meetings) ? meetings : [])
    .map((m, i) => ({ m, i, ms: Date.parse(m?.since) }))
    .filter(({ m, ms }) => m && typeof m === 'object' && Number.isFinite(ms))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const iso = (ms) => new Date(ms).toISOString();
  let freeAt = -Infinity;
  const active = [];
  const waiting = [];
  for (const { m, ms } of list) {
    const attendees = Array.isArray(m.attendees) ? [...m.attendees] : [];
    if (m.kind === 'kickoff') {
      if (freeAt === Infinity) {
        waiting.push({ task: m.task, kind: 'kickoff', attendees, since: m.since, waiting: true });
        continue;
      }
      const start = Math.max(ms, freeAt);
      const until = start + KICKOFF_MS;
      freeAt = until;
      if (until <= nowMs) continue;
      const entry = { task: m.task, kind: 'kickoff', attendees, since: iso(start), until: iso(until), ...(start > ms ? { requested: m.since } : {}) };
      if (start > nowMs) waiting.push({ ...entry, waiting: true });
      else active.push(entry);
      continue;
    }
    let end = m.until ? Date.parse(m.until) : Infinity;
    if (Number.isNaN(end) || (end === Infinity && nowMs - ms > staleMs)) end = ms + staleMs;
    freeAt = Math.max(freeAt, end);
    if (end <= nowMs) continue;
    active.push({ task: m.task, kind: 'meeting', attendees, since: m.since });
  }
  return [...active, ...waiting];
}

/** 업무 흐름 항목 배열만 필요할 때(SPEC 계약: deriveFlow(events, org)) */
export function deriveFlow(events, org, opts = {}) {
  return deriveTaskFlows(events, org, opts).items;
}

// 계획에 없는 직원 호출인지(서버가 flow.offplan 경고 이벤트를 남길 때 쓴다). 회의·반려 호출과 대상 미지정은 제외한다
export function isOffplanCall(ev, plan) {
  if (!ev || ev.kind !== 'tool.start' || !AGENT_TOOLS.has(ev.tool) || !planOf({ t: plan }, 't')) return false;
  const { target, desc } = agentCall(ev, new Set());
  if (!target || desc.startsWith(MEETING_TAG) || desc.startsWith(REJECT_TAG)) return false;
  return !plan.stages.some((s) => s.agent === target);
}

// 같은 업무에서 마지막 결과 확인 요청(flow.deliver)·사용자 반려 뒤의 검토 반려 횟수.
// flows: flow.review reject 기록 수, calls: `[반려]` Agent 호출 수. 반려 한 번은 보통 두 이벤트(기록 + 재지시)라
// 회차는 두 값 중 큰 쪽으로 본다(office.mjs flow review·chief-guard가 반려 최대 2회를 강제할 때 쓴다)
export function countReviewRejects(events, task) {
  let flows = 0;
  let calls = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object' || ev.task !== task) continue;
    if (ev.kind === 'flow.deliver' || ev.kind === 'flow.user_reject') {
      flows = 0;
      calls = 0;
    } else if (ev.kind === 'flow.review' && ev.verdict === 'reject') {
      flows += 1;
    } else if (ev.kind === 'tool.start' && AGENT_TOOLS.has(ev.tool) && agentCall(ev, new Set()).desc.startsWith(REJECT_TAG)) {
      calls += 1;
    }
  }
  return { flows, calls };
}
