// 이벤트 → 화면 상태 리듀서. 입력만으로 결과가 정해지는 순수 함수다(파일·시계·전역 상태를 읽지 않는다).
import { deriveTaskFlows, scheduleMeetings } from '../lib/flow.mjs';

// 이 시간 안에 tool 이벤트가 있으면 작업 중으로 본다(경계 포함: 정확히 90초 전도 작업 중).
export const WORKING_WINDOW_MS = 90_000;
// agent.start/review.start 후 stop이 없더라도 이 시간이 지나면 비정상 종료로 보고 작업 중에서 뺀다.
// 훅이 SubagentStop을 놓치면 영원히 작업 중으로 남는 것을 막기 위한 안전장치다.
export const STALE_START_MS = 6 * 60 * 60 * 1000;
export const FEED_LIMIT = 200;
// 업무 언어 피드(flow) 최근 항목 수
export const FLOW_LIMIT = 300;
export const CHIEF_ID = 'chief';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STOP_KINDS = new Set(['agent.stop', 'review.end', 'turn.end']);

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

// KST 기준 날짜(YYYY-MM-DD). '오늘'의 기준이다.
function kstDay(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function listOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

// run이 가리키는 에이전트 id. 대상이 없으면 비서실장, 단 codex 리뷰 run은 특정 에이전트에 붙이지 않는다.
function runAgentId(run) {
  const id = run.agentId ?? run.agent ?? null;
  if (id) return id;
  return run.engine === 'codex' ? null : CHIEF_ID;
}

function runStartMs(run) {
  return toMs(run.startedAt ?? run.started ?? run.start);
}

function runEndMs(run) {
  return toMs(run.endedAt ?? run.ended ?? run.end);
}

function newTrack() {
  return {
    lastEvent: null,
    lastTool: null,
    lastSummary: null,
    lastToolMs: -Infinity,
    lastStopMs: -Infinity,
    open: new Map(), // 진행 중인 agent.start/review.start: key → 시작 시각(ms)
    activeToday: false,
    stopsToday: 0,
  };
}

function compactEvent(ev) {
  const out = { ts: ev.ts, kind: ev.kind };
  if (ev.tool) out.tool = ev.tool;
  if (ev.summary) out.summary = ev.summary;
  if (ev.task) out.task = ev.task;
  if (ev.verdict) out.verdict = ev.verdict;
  return out;
}

function closeOpen(track, prefix, key) {
  if (track.open.has(key)) {
    track.open.delete(key);
    return;
  }
  // 짝이 맞는 시작이 없으면 같은 종류의 가장 오래된 시작을 닫는다.
  for (const k of track.open.keys()) {
    if (k.startsWith(prefix)) {
      track.open.delete(k);
      return;
    }
  }
}

// 데모 모드(실행기가 없다)에서 시뮬레이터의 reply.wait로 답장 대기 아이콘을 연출하는 시간(답장은 보낼 수 없다)
const DEMO_REPLY_MS = 3 * 60 * 1000;

/**
 * @param {{org:{departments:any[], roster:any[]}, events:any[], runs?:any[], tasks?:any[], plans?:Map|object, outputs?:Map|object, now?:Date|number|string, demo?:boolean}} input
 *   plans: 업무 id → 계획표 요약(outputs/<업무>/plan.json). plan.set 이벤트가 있으면 그것이 우선한다
 *   outputs: 업무 id → {단계 id: 산출물 파일이 있는지}(서버가 fs로 확인한 결과). 없으면 산출물 확인을 하지 않는다
 */
export function buildState({ org, events, runs = [], tasks = [], plans = null, outputs = null, now = Date.now(), demo = false } = {}) {
  const nowMs = toMs(now);
  const today = kstDay(nowMs);
  const departments = listOf(org?.departments);
  const roster = listOf(org?.roster);
  const eventList = Array.isArray(events) ? events : [];
  const runList = listOf(runs);

  const rosterById = new Map(roster.map((a) => [a.id, a]));
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const tracks = new Map();
  const trackOf = (id) => {
    let t = tracks.get(id);
    if (!t) {
      t = newTrack();
      tracks.set(id, t);
    }
    return t;
  };

  // runner가 직접 남긴 시작/종료 이벤트(instance = run-<id>)는 run 자체로 이미 집계하므로 진행·완료 수에서 뺀다
  const runInstances = new Set(runList.filter((r) => r && r.id).map((r) => `run-${r.id}`));

  let toolsToday = 0;
  let reviewsToday = 0;
  const taskVerdicts = new Map(); // task id → {reviewer: verdict}
  const taskLastActivity = new Map();
  const taskFromEvents = new Map(); // tasks.json에 없는 업무를 이벤트로 보충

  for (const ev of eventList) {
    if (!ev || typeof ev !== 'object') continue;
    const ms = toMs(ev.ts);
    const isToday = kstDay(ms) === today;

    if (isToday && ev.kind === 'tool.start') toolsToday += 1;
    if (isToday && ev.kind === 'review.end') reviewsToday += 1;

    if (ev.task) {
      taskLastActivity.set(ev.task, ev.ts);
      if (ev.kind === 'task.start' && !taskFromEvents.has(ev.task)) {
        taskFromEvents.set(ev.task, { id: ev.task, title: ev.summary || ev.task, status: 'active', created: ev.ts });
      }
      if (ev.kind === 'task.update' && ev.status && taskFromEvents.has(ev.task)) {
        taskFromEvents.get(ev.task).status = ev.status;
      }
      if (ev.kind === 'review.end' && ev.agent) {
        if (!taskVerdicts.has(ev.task)) taskVerdicts.set(ev.task, {});
        taskVerdicts.get(ev.task)[ev.agent] = ev.verdict ?? 'FIX';
      }
    }

    if (!ev.agent) continue;
    const t = trackOf(ev.agent);
    t.lastEvent = compactEvent(ev);
    if (ev.summary) t.lastSummary = ev.summary;
    if (isToday) t.activeToday = true;

    const instanceKey = String(ev.instance ?? ev.session ?? '');
    const fromRun = runInstances.has(instanceKey);
    switch (ev.kind) {
      case 'tool.start':
      case 'tool.end':
        if (ev.tool) t.lastTool = ev.tool;
        if (Number.isFinite(ms)) t.lastToolMs = Math.max(t.lastToolMs, ms);
        break;
      case 'agent.start':
        if (!fromRun) t.open.set(`a:${instanceKey}`, ms);
        break;
      case 'review.start':
        if (!fromRun) t.open.set(`r:${instanceKey}`, ms);
        break;
      case 'agent.stop':
        closeOpen(t, 'a:', `a:${instanceKey}`);
        break;
      case 'review.end':
        closeOpen(t, 'r:', `r:${instanceKey}`);
        break;
      default:
        break;
    }
    if (STOP_KINDS.has(ev.kind)) {
      if (Number.isFinite(ms)) t.lastStopMs = Math.max(t.lastStopMs, ms);
      if (isToday && ev.kind === 'agent.stop' && !fromRun) t.stopsToday += 1;
    }
  }

  // 에이전트별 run 정리: 진행 중 run, 가장 최근 run, 오늘 완료 run 수
  const runInfo = new Map();
  for (const run of runList) {
    if (!run || typeof run !== 'object') continue;
    const id = runAgentId(run);
    if (!id) continue;
    let info = runInfo.get(id);
    if (!info) {
      info = { running: null, queued: null, latest: null, latestMs: -Infinity, doneToday: 0 };
      runInfo.set(id, info);
    }
    if (run.status === 'running') info.running = run;
    if (run.status === 'queued') info.queued = run;
    const startMs = runStartMs(run);
    if (info.latest === null || startMs >= info.latestMs) {
      info.latest = run;
      info.latestMs = Number.isFinite(startMs) ? startMs : info.latestMs;
    }
    if (run.status === 'done' && kstDay(runEndMs(run)) === today) info.doneToday += 1;
    if (kstDay(startMs) === today) trackOf(id).activeToday = true;
  }

  const openCount = (t) => {
    let n = 0;
    for (const startMs of t.open.values()) {
      if (Number.isFinite(startMs) && nowMs - startMs <= STALE_START_MS) n += 1;
    }
    return n;
  };

  function statusOf(id, offDuty) {
    if (offDuty) return 'off-duty';
    const t = tracks.get(id) ?? newTrack();
    const info = runInfo.get(id);
    if (info?.running) return 'working';
    if (openCount(t) > 0) return 'working';
    // 마지막 tool 이벤트가 90초 안이고, 그 뒤에 종료 이벤트가 없으면 작업 중
    if (nowMs - t.lastToolMs <= WORKING_WINDOW_MS && t.lastToolMs > t.lastStopMs) return 'working';
    return t.activeToday ? 'standby' : 'idle';
  }

  function agentView(id, base, offDuty) {
    const t = tracks.get(id) ?? newTrack();
    const info = runInfo.get(id);
    return {
      ...base,
      id,
      status: statusOf(id, offDuty),
      lastEvent: t.lastEvent,
      lastTool: t.lastTool,
      lastSummary: t.lastSummary,
      // 동시 실행 제한으로 대기열에 있는 run이 있으면 true(상태 값은 그대로 두고 화면에서 따로 표시한다)
      queued: Boolean(info?.queued),
      // 진행 중 run이 있으면 그 id, 없으면 결과 확인용으로 가장 최근 run id
      runId: info?.running?.id ?? info?.latest?.id ?? null,
    };
  }

  const agents = {};
  for (const a of roster) {
    const dept = deptById.get(a.department);
    const offDuty = a.active === false || dept?.active === false;
    agents[a.id] = agentView(a.id, { ...a, unregistered: false }, offDuty);
  }
  agents[CHIEF_ID] = agentView(CHIEF_ID, { name: '비서실장', department: null, chief: true, unregistered: false }, false);

  // 정본에 없는 agent는 버리지 않고 '미등록'으로 표시한다.
  const unregistered = [];
  for (const id of new Set([...tracks.keys(), ...runInfo.keys()])) {
    if (rosterById.has(id) || id === CHIEF_ID) continue;
    unregistered.push(id);
    agents[id] = agentView(id, { name: id, department: null, label: '미등록', unregistered: true }, false);
  }

  // 부서별 집계.
  // 진행률(progress, 0~100 정수) = 오늘 완료 / (오늘 완료 + 진행 중) × 100.
  //   오늘 완료: 소속 직원의 오늘 agent.stop 수 + 오늘 끝난 done run 수
  //   진행 중: 소속 직원의 미종료 agent.start/review.start 수 + 실행 중 run 수
  //   둘 다 0이면 0.
  const deptViews = [...departments]
    .map((d, i) => ({ d, i }))
    .sort((x, y) => (x.d.order ?? Infinity) - (y.d.order ?? Infinity) || x.i - y.i)
    .map(({ d }) => {
      const members = roster.filter((a) => a.department === d.id).map((a) => a.id);
      let doneToday = 0;
      let inProgress = 0;
      const live = [];
      let idleCount = 0;
      for (const id of members) {
        const t = tracks.get(id);
        const info = runInfo.get(id);
        doneToday += (t?.stopsToday ?? 0) + (info?.doneToday ?? 0);
        inProgress += (t ? openCount(t) : 0) + (info?.running ? 1 : 0);
        const status = agents[id].status;
        if (status === 'working') live.push(id);
        else if (status === 'standby' || status === 'idle') idleCount += 1;
      }
      const total = doneToday + inProgress;
      return {
        ...d,
        members,
        activeCount: live.length,
        idleCount,
        progress: total === 0 ? 0 : Math.round((doneToday / total) * 100),
        doneToday,
        inProgress,
        live,
      };
    });

  // 지표: 정본 직원 + 미등록 인원 기준(비서실장 제외). offline은 휴무(off-duty) 인원 수다.
  // needsReply: 답변이 질문으로 끝나 사용자의 답장을 기다리는 실행 수(runner의 휴리스틱, 답장하면 false가 된다)
  const needsReply = runList.filter((r) => r && r.needsReply === true && r.status !== 'running' && r.status !== 'queued').length;
  const metrics = { active: 0, standby: 0, idle: 0, offline: 0, tasks: 0, reviews: reviewsToday, tools: toolsToday, needsReply };
  for (const id of [...roster.map((a) => a.id), ...unregistered]) {
    const status = agents[id].status;
    if (status === 'working') metrics.active += 1;
    else if (status === 'standby') metrics.standby += 1;
    else if (status === 'idle') metrics.idle += 1;
    else metrics.offline += 1;
  }

  // 업무 목록: tasks.json이 정본이고, 이벤트에만 있는 업무는 보충한다.
  const taskMap = new Map();
  for (const task of listOf(tasks)) {
    if (task && task.id) taskMap.set(task.id, { ...task });
  }
  for (const [id, task] of taskFromEvents) {
    if (!taskMap.has(id)) taskMap.set(id, task);
  }
  // 업무 흐름: 업무 언어 피드 항목과 업무별 단계 표시줄·계획표 단계 상태·역량 공백
  const flow = deriveTaskFlows(eventList, { departments, roster }, { plans, outputs, tasks: [...taskMap.values()] });
  const taskViews = [...taskMap.values()]
    .map((task) => {
      const f = flow.tasks[task.id];
      const { plan: _plan, ...rest } = task;
      return {
        ...rest,
        verdicts: { ...(task.verdicts ?? {}), ...(taskVerdicts.get(task.id) ?? {}) },
        lastActivity: taskLastActivity.get(task.id) ?? task.created ?? null,
        steps: f?.steps ?? null,
        stage: f?.current ?? null,
        rejects: f?.rejects ?? 0,
        userRejects: f?.userRejects ?? 0,
        depts: f?.depts ?? [],
        // 계획표: plan.json 형식({goal, stages, gaps})에 단계 상태(pending|active|done|done_missing_output|rejected)·반려 횟수를 붙인다
        plan: f?.plan ? { goal: f.goal, stages: f.plan, gaps: f.gaps } : null,
        // 완료로 표시됐지만 산출물 파일이 없는 계획 단계 id(서버가 파일을 확인했을 때만)
        missingOutputs: f?.missingOutputs ?? [],
        goal: f?.goal ?? null,
        gaps: f?.gaps ?? [],
      };
    })
    .sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')) || String(b.id).localeCompare(String(a.id)));
  metrics.tasks = taskViews.filter((t) => t.status === 'active' || t.status === 'review').length;

  // 사용자 의견 필요: 답장 대기(reply), 사용자 확인 대기(approve), 역량 공백(gap). since 오름차순
  const attention = [];
  // reply: 대화(rootId)마다 needsReply인 마지막 run 하나. 연결된 업무가 사용자 확인 대기(approve가 대신 보여준다)거나
  // 완료됐으면 뺀다(승인 뒤에도 💬가 남지 않게)
  const statusOfTask = new Map(taskViews.map((t) => [t.id, t.status]));
  const replyByThread = new Map();
  for (const r of runList) {
    if (!r || r.needsReply !== true || r.status === 'running' || r.status === 'queued') continue;
    const st = r.task ? statusOfTask.get(r.task) : null;
    if (st === 'review' || st === 'done') continue;
    const key = r.rootId || r.id;
    const prev = replyByThread.get(key);
    if (!prev || String(r.endedAt ?? r.startedAt ?? '') >= String(prev.endedAt ?? prev.startedAt ?? '')) replyByThread.set(key, r);
  }
  for (const r of replyByThread.values()) {
    attention.push({ kind: 'reply', agent: r.agentId || CHIEF_ID, runId: r.id, ...(r.task ? { task: r.task } : {}), since: r.endedAt ?? r.startedAt ?? null, text: r.summary || r.request || '' });
  }
  if (demo) {
    // 데모: 최근 3분 안의 reply.wait를 직원별 하나씩(완료된 업무 제외)
    const demoReply = new Map();
    for (const ev of eventList) {
      if (!ev || ev.kind !== 'reply.wait' || nowMs - toMs(ev.ts) > DEMO_REPLY_MS) continue;
      if (ev.task && statusOfTask.get(ev.task) === 'done') continue;
      demoReply.set(ev.agent || CHIEF_ID, ev);
    }
    for (const [agent, ev] of demoReply) attention.push({ kind: 'reply', agent, runId: null, ...(ev.task ? { task: ev.task } : {}), since: ev.ts, text: ev.summary || '' });
  }
  for (const t of taskViews) {
    if (t.status === 'review') {
      attention.push({ kind: 'approve', agent: CHIEF_ID, task: t.id, since: t.updated ?? t.lastActivity ?? t.created ?? null, text: `'${t.title ?? t.id}' 결과 확인 대기` });
    }
    if (t.gaps.length && t.status !== 'done') {
      const text = t.gaps.map((g) => `${g.need}${g.suggestion ? ` → ${g.suggestion}` : ''}`).join(' / ');
      attention.push({ kind: 'gap', agent: CHIEF_ID, task: t.id, since: t.created ?? t.lastActivity ?? null, text: `역량 공백: ${text}` });
    }
  }
  attention.sort((a, b) => (toMs(a.since) || 0) - (toMs(b.since) || 0));
  metrics.attention = attention.length;

  return {
    metrics,
    departments: deptViews,
    agents,
    unregistered,
    tasks: taskViews,
    runs: runList.map((r) => ({ ...r })),
    feed: eventList.slice(-FEED_LIMIT),
    flow: flow.items.slice(-FLOW_LIMIT),
    attention,
    // 회의실: 진행 중인 하달 킥오프(8초 연출)·실제 회의와 대기 중인 킥오프(waiting)
    meetings: scheduleMeetings(flow.meetings, nowMs),
  };
}
