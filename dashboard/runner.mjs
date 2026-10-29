// 대시보드 작업 실행기: claude -p / codex exec 를 프로세스 그룹으로 띄우고 runs 를 관리한다
import * as child_process from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadOrg, loadPresets } from '../lib/org.mjs';
import { kstDate, renameWithRetry } from '../lib/paths.mjs';
import { buildOrgMap } from '../lib/orgmap.mjs';
import { addTask } from '../lib/tasks.mjs';
import { isTaskId } from '../lib/plan.mjs';
import { appendEvent, normalizeCodexItem, redact } from '../lib/events.mjs';
import { buildPrompt, parseVerdict } from '../scripts/codex-review.mjs';
import { AGENT_ID_PATTERN, RUN_MODELS, TOOL_PATTERN, codexModelArgs, killTree, resolveCommand, spawnCli, writePrompt } from '../lib/cli.mjs';

const PERMISSIONS = ['acceptEdits', 'bypassPermissions', 'default'];
const MAX_PROMPT = 20000;
const MAX_KEPT_RUNS = 200;
// claude session_id·codex thread_id 형식. 명령 인자로 넘기므로 이 형식만 받는다
export const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const BUSY = new Set(['running', 'queued']);
// 조직도를 명령 인자(--append-system-prompt)로 바로 넘기는 최대 길이. 더 길거나 Windows .cmd shim(셸 경유)이면
// 줄바꿈·길이 제한(cmd.exe 8191자) 때문에 .office/orgmap.md 파일로 쓰고 --append-system-prompt-file 로 넘긴다
// (claude 2.1.312 --help 의 --append-system-prompt[-file] 확인)
export const ORGMAP_INLINE_MAX = 6000;

// 화면·API 응답용 run: 세션 id 값은 내보내지 않고 이어서 답할 수 있는지(canReply)만 알린다.
// sessionId 가 없는 예전 run 은 canReply false 다
function publicRun(r) {
  const { resultError, lastText, sessionId, ...pub } = r;
  return {
    ...pub,
    canReply: r.target !== 'review' && typeof sessionId === 'string' && SESSION_PATTERN.test(sessionId),
    needsReply: r.needsReply === true,
    parentId: r.parentId ?? null,
    rootId: r.rootId || r.id,
  };
}

// 답변이 사용자에게 되묻는 것으로 끝나는지 보는 휴리스틱(대시보드 '답변 필요' 표시용).
// 1) 마지막 단락에 물음표가 있거나 2) 마지막 단락이 답을 요청하는 문구이거나
// 3) 번호 목록 질문이 2개 이상이거나 마지막 세 단락 안에 있으면 true.
// "필요하시면 말씀해 주세요" 같은 맺음 인사만 있는 경우는 질문으로 보지 않는다.
const ASK_PATTERN = /(확인하겠습니다|확인해\s?주세요|알려\s?주세요|알려\s?주시면|선택해\s?주세요|골라\s?주세요|말씀해\s?주세요|말씀해\s?주시면|답해\s?주세요|답변해\s?주세요|답하셔도|답장|정해\s?주세요|결정해\s?주세요|기본값으로 진행)/;
const COURTESY_PATTERN = /(있으시?면|필요하시면|원하시면|궁금하시면|있다면)[^.!?\n]{0,40}(말씀해|알려)\s?주세요/;
const NUMBERED_QUESTION = /^\s*(?:[*_]{1,2})?\s*(?:\d+|[①-⑳])[.)]?\s.*[?？]/;
export function looksLikeQuestion(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return false;
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = (paras.at(-1) || '').replace(/https?:\/\/\S+/g, '');
  if (/[?？]/.test(last)) return true;
  if (ASK_PATTERN.test(last) && !(COURTESY_PATTERN.test(last) && !/(확인하겠습니다|선택해|골라|답하셔도|답장|기본값으로 진행)/.test(last))) return true;
  const numbered = (chunk) => chunk.split('\n').filter((l) => NUMBERED_QUESTION.test(l)).length;
  if (numbered(body) >= 2) return true;
  return numbered(paras.slice(-3).join('\n')) >= 1;
}

// 마지막 단락 요약(피드의 '답변 대기' 이벤트용)
function lastParagraph(text) {
  const paras = String(text ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/).filter((p) => p.trim());
  return paras.at(-1) || '';
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const newRunId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

// POSIX 프로세스 그룹이 아직 남아 있는지(리더가 끝나도 손자가 남을 수 있다)
function groupAlive(pid) {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function createRunner({ root, onChange, maxConcurrent = 4, spawnImpl = child_process.spawn, killGraceMs = 5000 }) {
  const officeDir = join(root, '.office');
  const runsFile = join(officeDir, 'runs.json');
  const logDir = join(officeDir, 'runs');
  const runs = loadRuns();
  const live = new Map(); // runId → { child, spec, log, killTimer }
  const queue = []; // { run, spec }

  // 이전 서버에서 넘어온 실행은 출력을 더 추적할 수 없으므로 끝난 것으로 정리한다
  function loadRuns() {
    let list = [];
    try {
      const data = JSON.parse(readFileSync(runsFile, 'utf8'));
      if (Array.isArray(data)) list = data;
    } catch { /* 없거나 깨졌으면 빈 목록 */ }
    const now = new Date().toISOString();
    for (const run of list) {
      if (run.status === 'running') {
        Object.assign(run, { status: 'failed', endedAt: run.endedAt || now, summary: '서버 재시작으로 실행 추적이 끊겼습니다.' });
      } else if (run.status === 'queued') {
        Object.assign(run, { status: 'stopped', endedAt: run.endedAt || now, summary: '서버 재시작으로 대기 중인 실행을 취소했습니다.' });
      }
    }
    return list;
  }

  function persist() {
    try {
      mkdirSync(officeDir, { recursive: true });
      while (runs.length > MAX_KEPT_RUNS) {
        const idx = runs.findIndex((r) => r.status !== 'running' && r.status !== 'queued');
        if (idx < 0) break;
        runs.splice(idx, 1);
      }
      const tmp = `${runsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(runs, null, 2) + '\n');
      renameWithRetry(tmp, runsFile);
    } catch { /* 기록 실패는 실행을 막지 않는다 */ }
  }

  function changed(run) {
    persist();
    try { onChange?.({ ...run }); } catch { /* 화면 갱신 오류는 무시 */ }
  }

  const runningCount = () => runs.filter((r) => r.status === 'running').length;

  // 대상 직원·부서 설정을 확인해 실행 명령을 만든다.
  // 명령 인자에는 검증된 토큰만 넣고, 프롬프트는 stdin으로 넘긴다(Windows .cmd shim을 셸로 실행해도 안전하도록).
  // resume: 이어서 답할 세션 id(SESSION_PATTERN 검증 후에만 넘긴다)
  function buildSpec(agentId, prompt, model, resume = null) {
    const org = loadOrg(root);
    if (!agentId) {
      const chiefDept = org.departments.find((d) => d.id === 'chief');
      const perm = PERMISSIONS.includes(chiefDept?.permission) ? chiefDept.permission : 'acceptEdits';
      return claudeSpec({ agentId: null, perm, tools: null, prompt, model, resume, orgmap: orgMapText(org) });
    }
    if (!AGENT_ID_PATTERN.test(agentId)) throw httpError(400, `직원 id 형식이 올바르지 않습니다: ${agentId}`);
    const agent = org.roster.find((a) => a.id === agentId);
    if (!agent) throw httpError(404, `직원을 찾을 수 없습니다: ${agentId}`);
    if (agent.active === false) throw httpError(409, `${agent.name || agentId} 님은 휴무 중이라 작업을 지시할 수 없습니다.`);
    const dept = org.departments.find((d) => d.id === agent.department);
    if (dept?.active === false) throw httpError(409, `${dept.name || dept.id} 부서가 운영 중지 상태라 작업을 지시할 수 없습니다.`);
    if (dept?.engine === 'codex') return codexSpec({ agent, dept, prompt, resume });
    const perm = PERMISSIONS.includes(dept?.permission) ? dept.permission : 'acceptEdits';
    const tools = Array.isArray(dept?.tools) && dept.tools.length ? dept.tools : null;
    if (tools && !tools.every((t) => TOOL_PATTERN.test(t))) {
      throw httpError(400, `${dept.name || dept.id} 부서의 허용 도구 이름에 쓸 수 없는 문자가 있습니다.`);
    }
    return claudeSpec({ agentId, perm, tools, prompt, model, resume });
  }

  function claudeSpec({ agentId, perm, tools, prompt, model, resume, orgmap = null }) {
    const cmd = resolveCommand('claude', 'CLAUDE_BIN');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', perm,
      ...(agentId ? ['--agent', agentId] : []),
      ...(tools ? ['--allowedTools', tools.join(',')] : []),
      ...(model ? ['--model', model] : []),
      ...(resume ? ['--resume', resume] : []),
      ...(orgmap ? orgMapArgs(orgmap, cmd) : [])];
    // 조직도를 인자로 넣었으면 SessionStart 훅(hooks/session-context.mjs)이 같은 내용을 또 넣지 않게 알린다.
    // 비서실장 실행이면 chief-guard 훅이 업무 등록(task start) 전에도 실무 도구를 막도록 OFFICE_CHIEF_RUN=1을 준다
    const env = agentId ? null : { OFFICE_CHIEF_RUN: '1', ...(orgmap ? { OFFICE_ORGMAP_INJECTED: '1' } : {}) };
    return { engine: 'claude', agentId, model: model || null, cmd, args, input: prompt, env };
  }

  // 비서실장 실행에 주입할 현재 조직도. 조직이 바뀌면 다음 실행부터 반영된다
  function orgMapText(org) {
    let presets;
    try { presets = loadPresets(root); } catch { presets = null; }
    return buildOrgMap(org, { presets });
  }

  function orgMapArgs(text, cmd) {
    if (!cmd.shell && text.length <= ORGMAP_INLINE_MAX) return ['--append-system-prompt', text];
    const file = join(officeDir, 'orgmap.md');
    try {
      mkdirSync(officeDir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameWithRetry(tmp, file);
    } catch (err) {
      throw httpError(500, `조직도 파일을 쓰지 못했습니다: ${err.message}`);
    }
    return ['--append-system-prompt-file', file];
  }

  // 직원 직접 지시: outputs/<날짜>/run-<id>/ 를 만들고 업무로 등록한다. 실패하면 업무 없이 실행한다
  function registerRunTask(runId, agentId, prompt) {
    const date = kstDate();
    const taskId = `${date}/run-${runId}`;
    const rel = `outputs/${taskId}/`;
    try {
      mkdirSync(join(root, 'outputs', date, `run-${runId}`), { recursive: true });
      const org = loadOrg(root);
      const name = org.roster.find((a) => a.id === agentId)?.name || agentId;
      const title = redact(`${name}: ${prompt}`, 80);
      addTask(root, { id: taskId, title, status: 'active', created: new Date().toISOString(), run: runId, agent: agentId });
      emit({ engine: 'claude', session: 'office-runner', agent: agentId, instance: 'office-runner', kind: 'task.start', task: taskId, summary: title });
    } catch {
      return null;
    }
    return { taskId, rel };
  }

  // .office/sessions.json 에서 세션에 연결된 업무 id(없거나 형식이 다르면 null)
  function sessionTask(sessionId) {
    try {
      const map = JSON.parse(readFileSync(join(officeDir, 'sessions.json'), 'utf8'));
      const id = map && typeof map === 'object' && !Array.isArray(map) ? map[sessionId] : null;
      return isTaskId(id) ? id : null;
    } catch {
      return null;
    }
  }

  // 세션 → 업무 연결(.office/sessions.json). 훅이 이후 이벤트에 task 를 붙인다
  function linkSession(sessionId, taskId) {
    if (!SESSION_PATTERN.test(sessionId) || !isTaskId(taskId)) return;
    const file = join(officeDir, 'sessions.json');
    try {
      let map = {};
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) map = data;
      } catch { /* 없거나 깨졌으면 새로 만든다 */ }
      if (map[sessionId] === taskId) return;
      map[sessionId] = taskId;
      mkdirSync(officeDir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
      renameWithRetry(tmp, file);
    } catch { /* 연결 실패는 실행을 막지 않는다 */ }
  }

  // codex 엔진(검증실) 직원: codex-review.mjs 와 같은 검토 프롬프트(공통 기준·VERDICT 형식)에 요청을 붙인다.
  // 대시보드 요청에는 산출물 폴더가 없어서 reviews/<id>.md 저장은 하지 않는다(산출물 검증은 POST /api/reviews).
  // resume 이면 `codex exec -s read-only -C <root> resume --json ... <thread_id> -` 형식으로 같은 대화를 잇는다.
  // 이어지는 대화에는 검토 지침이 이미 있으므로 stdin 에는 답장만 넣는다.
  function codexSpec({ agent, dept, prompt, resume }) {
    let modelArgs;
    try {
      modelArgs = codexModelArgs({ model: dept?.codexModel, effort: dept?.codexEffort });
    } catch (err) {
      throw httpError(400, err.message);
    }
    const cmd = resolveCommand('codex', 'CODEX_BIN');
    if (resume) {
      return { engine: 'codex', agentId: agent.id, model: null, cmd, args: ['exec', '-s', 'read-only', '-C', root, 'resume', '--json', ...modelArgs, resume, '-'], input: prompt };
    }
    const text = buildPrompt({ id: agent.id, name: agent.name || agent.id, specialty: agent.specialty || '', instructions: agent.instructions || '' }, null, prompt);
    return {
      engine: 'codex',
      agentId: agent.id,
      model: null,
      cmd,
      args: ['exec', '--json', '-s', 'read-only', '-C', root, ...modelArgs, '-'],
      input: text,
    };
  }

  // thread: 답장일 때 { parentId, rootId, sessionId }. sessionId 는 실행 출력에서 새 값이 오면 바뀐다
  // thread.id: 미리 정한 run id(직원 직접 지시는 산출물 폴더 이름에 쓰려고 먼저 정한다), thread.task: 연결할 업무 id
  function addRun(spec, target, request, thread = {}) {
    const id = thread.id ?? newRunId();
    const run = {
      id,
      target,
      agentId: spec.agentId ?? null,
      engine: spec.engine,
      request: redact(request, 120),
      pid: null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      summary: '',
      model: spec.model ?? null,
      sessionId: thread.sessionId ?? null,
      parentId: thread.parentId ?? null,
      rootId: thread.rootId ?? id,
      needsReply: false,
      task: thread.task ?? null,
    };
    if (run.task && run.sessionId) linkSession(run.sessionId, run.task);
    runs.push(run);
    if (runningCount() < maxConcurrent) launch(run, spec);
    else {
      queue.push({ run, spec });
      changed(run);
    }
    return publicRun(run);
  }

  // model: 작업 단위 모델 별칭(haiku|sonnet|opus). 없으면 직원·부서 설정을 따른다
  // task: 이 실행을 연결할 업무 id(사용자 반려로 새 비서실장 실행을 띄울 때). 직원 직접 지시는 runner가 업무를 만든다
  // display: 실행 목록·대화 스레드에 보일 요청 요약(사용자 반려처럼 시스템이 만든 프롬프트 대신 사용자의 말을 보여줄 때)
  function start({ agentId = null, prompt, model = null, task = null, display = null } = {}) {
    checkPrompt(prompt, model, '작업 요청');
    if (agentId !== null && (typeof agentId !== 'string' || !agentId)) throw httpError(400, '직원 id 형식이 올바르지 않습니다.');
    if (task !== null && !isTaskId(task)) throw httpError(400, '업무 id 형식이 올바르지 않습니다.');
    const spec = buildSpec(agentId, prompt, model || null);
    const id = newRunId();
    let taskId = task;
    // claude 직원 직접 지시: 산출물 폴더를 만들고 업무로 등록한 뒤 프롬프트 끝에 저장 위치를 덧붙인다.
    // codex(검증실)는 읽기 전용 실행이라 폴더를 만들지 않는다(답변 전문은 .office/runs/<id>.result.md)
    if (agentId && spec.engine === 'claude' && !taskId) {
      const reg = registerRunTask(id, agentId, prompt);
      if (reg) {
        taskId = reg.taskId;
        spec.input = `${prompt}\n\n[저장 위치] 이 작업의 산출물은 이 폴더에 저장하세요: ${reg.rel} (업무 id: ${reg.taskId})`;
      }
    }
    return addRun(spec, agentId || 'chief', typeof display === 'string' && display ? display : prompt, { id, task: taskId });
  }

  function checkPrompt(prompt, model, label) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw httpError(400, `${label} 내용을 입력해 주세요.`);
    if (prompt.length > MAX_PROMPT) throw httpError(400, `${label}은 ${MAX_PROMPT}자 이하로 입력해 주세요.`);
    if (model !== null && model !== '' && !RUN_MODELS.includes(model)) {
      throw httpError(400, `모델은 ${RUN_MODELS.join('/')} 중 하나여야 합니다.`);
    }
  }

  // 끝난 실행의 세션을 이어서 답한다. 같은 직원·부서 설정(권한·도구)과 원래 모델(답장에서 지정하면 그 모델)을 쓴다
  // task: 이 답장을 연결할 업무 id(사용자 반려). 없으면 원래 실행의 업무를 잇는다
  function reply(runId, { prompt, model = null, task = null, display = null } = {}) {
    checkPrompt(prompt, model, '답장');
    if (task !== null && !isTaskId(task)) throw httpError(400, '업무 id 형식이 올바르지 않습니다.');
    const parent = runs.find((r) => r.id === runId);
    if (!parent) throw httpError(404, `실행을 찾을 수 없습니다: ${runId}`);
    const rootId = parent.rootId || parent.id;
    if (BUSY.has(parent.status) || runs.some((r) => (r.rootId || r.id) === rootId && BUSY.has(r.status))) {
      throw httpError(409, '이전 실행이 끝난 뒤 답할 수 있습니다.');
    }
    if (parent.target === 'review' || !parent.sessionId || !SESSION_PATTERN.test(parent.sessionId)) {
      throw httpError(409, '이 실행은 세션 정보가 없어 이어서 답할 수 없습니다. 새 작업으로 지시해 주세요.');
    }
    const who = parent.agentId || null;
    let spec;
    try {
      spec = buildSpec(who, prompt, model || parent.model || null, parent.sessionId);
    } catch (err) {
      if (err.status === 404 || err.status === 409) {
        throw httpError(400, `원래 담당 직원(${who})이 삭제되었거나 휴무 중이라 이어서 답할 수 없습니다. ${err.message}`);
      }
      throw err;
    }
    if (spec.engine !== parent.engine) {
      throw httpError(400, '담당 부서의 실행 엔진이 바뀌어 이전 대화를 이어갈 수 없습니다. 새 작업으로 지시해 주세요.');
    }
    parent.needsReply = false;
    return addRun(spec, parent.target, typeof display === 'string' && display ? display : prompt, { parentId: parent.id, rootId, sessionId: parent.sessionId, task: task ?? parent.task ?? null });
  }

  // 답변 전문: .office/runs/<id>.result.md, 없으면 요약
  function result(runId) {
    const run = runs.find((r) => r.id === runId);
    if (!run || !RUN_ID_PATTERN.test(runId)) throw httpError(404, `실행을 찾을 수 없습니다: ${runId}`);
    const file = join(logDir, `${run.id}.result.md`);
    let text = null;
    try { if (existsSync(file)) text = readFileSync(file, 'utf8'); } catch { /* 요약으로 대신한다 */ }
    return {
      text: text ?? (run.summary || ''),
      source: text === null ? 'summary' : 'file',
      engine: run.engine,
      sessionId: run.sessionId && SESSION_PATTERN.test(run.sessionId) ? run.sessionId : null,
    };
  }

  // POST /api/reviews 용: codex-review.mjs 를 백그라운드로 실행하고 runs 에 engine codex 로 등록한다
  function startReview({ target, reviewers, task } = {}) {
    if (typeof target !== 'string' || !target.trim()) throw httpError(400, '검토할 산출물 폴더를 지정해 주세요.');
    const list = Array.isArray(reviewers) ? reviewers.join(',') : (reviewers || 'all');
    const args = [join(root, 'scripts', 'codex-review.mjs'), '--target', target, '--reviewers', String(list)];
    if (task) args.push('--task', String(task));
    const spec = { engine: 'codex', agentId: null, cmd: { command: process.execPath, prefixArgs: [], shell: false, display: 'codex-review' }, args, input: '', review: true };
    return addRun(spec, 'review', `검증: ${target} (${list})`);
  }

  function handleLine(run, spec, line) {
    if (!line.trim()) return;
    // codex-review.mjs 는 사람이 읽는 요약을 출력하므로 마지막 줄(종합)을 남긴다
    if (spec.review) { run.summary = redact(line); return; }
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (spec.engine === 'claude') {
      // 이어서 답하기용 세션 id: system(init)·result 줄에 있다
      if ((msg.type === 'system' || msg.type === 'result') && typeof msg.session_id === 'string') setSession(run, msg.session_id);
      if (msg.type === 'result') {
        if (typeof msg.result === 'string') {
          run.summary = redact(msg.result);
          spec.fullText = msg.result; // 답변 전문(.result.md 로 저장, runs.json에는 남기지 않는다)
        }
        if (msg.is_error) run.resultError = true;
      } else if (msg.type === 'assistant') {
        const text = (msg.message?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
        if (text) {
          spec.lastAssistant = text;
          if (!run.summary) run.lastText = redact(text);
        }
      }
      return;
    }
    if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') setSession(run, msg.thread_id);
    // codex 는 Claude 훅이 없으므로 JSON 스트림을 이벤트로 직접 남긴다
    if (msg.type === 'item.completed' && msg.item?.type === 'agent_message' && typeof msg.item.text === 'string') {
      run.summary = redact(msg.item.text);
      spec.lastMessage = msg.item.text; // 판정 파싱용 전문(runs.json에는 남기지 않는다)
      spec.fullText = msg.item.text;
    }
    const ev = normalizeCodexItem(msg, { agent: spec.agentId, session: `run-${run.id}` });
    if (ev) emit(ev);
  }

  function setSession(run, id) {
    if (!SESSION_PATTERN.test(id) || run.sessionId === id) return;
    run.sessionId = id;
    if (run.task) linkSession(id, run.task);
    persist(); // 서버가 도중에 꺼져도 이어서 답할 수 있게 바로 남긴다
  }

  // 답변 전문 저장(로그와 같이 본인만 읽게 0600)
  function saveResult(run, text) {
    try {
      const file = join(logDir, `${run.id}.result.md`);
      writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* 권한 변경 불가 환경은 무시 */ }
    } catch { /* 저장 실패는 실행 결과를 막지 않는다 */ }
  }

  function emit(ev) {
    try { appendEvent(root, ev); } catch { /* 이벤트 기록 실패는 무시 */ }
  }

  function launch(run, spec) {
    // 로그에는 도구 결과 원문이 들어가므로 본인만 읽게 만든다(Windows는 mode를 무시한다)
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    try { chmodSync(logDir, 0o700); } catch { /* 권한 변경 불가 환경은 무시 */ }
    const log = createWriteStream(join(logDir, `${run.id}.log`), { flags: 'a', mode: 0o600 });
    log.on('error', () => {});
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    const entry = { child: null, spec, log, killTimer: null, stderr: '', done: false };
    live.set(run.id, entry);

    const codexEvent = spec.engine === 'codex' && !spec.review && spec.agentId;
    const evBase = { engine: 'codex', session: `run-${run.id}`, agent: spec.agentId, instance: `run-${run.id}` };

    let child;
    try {
      child = spawnCli(spec.cmd, spec.args, { cwd: root, env: spec.env ? { ...process.env, ...spec.env } : process.env, spawnImpl });
    } catch (err) {
      finish(run, { status: 'failed', summary: `실행하지 못했습니다: ${err.message}` });
      return;
    }
    entry.child = child;
    writePrompt(child, spec.input);
    run.pid = Number.isInteger(child.pid) ? child.pid : null;
    if (codexEvent) emit({ ...evBase, kind: 'review.start', summary: run.request });
    changed(run);

    let buffer = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      log.write(text);
      buffer += text;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(run, spec, buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      log.write(`[stderr] ${text}`);
      entry.stderr = (entry.stderr + text).slice(-2000);
    });
    child.on('error', (err) => {
      const summary = err.code === 'ENOENT'
        ? `실행 파일을 찾지 못했습니다: ${spec.cmd.display}. 설치 여부와 PATH(또는 ${spec.engine === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN'})를 확인해 주세요.`
        : `실행 오류: ${err.message}`;
      finish(run, { status: 'failed', summary });
    });
    child.on('close', (code, signal) => {
      if (buffer) handleLine(run, spec, buffer);
      if (entry.stopRequested) {
        finish(run, { status: 'stopped', summary: run.summary || '사용자가 실행을 중지했습니다.' });
      } else if ((code === 0 || (spec.review && code === 2)) && !run.resultError) {
        // 검증의 종료 코드 2 는 BLOCK 판정이지 실행 실패가 아니다
        finish(run, { status: 'done', summary: run.summary || run.lastText || '' });
      } else {
        const why = signal ? `신호 ${signal}` : `종료 코드 ${code}`;
        const detail = run.summary || run.lastText || redact(entry.stderr) || '';
        finish(run, { status: 'failed', summary: redact(`${why}${detail ? ` — ${detail}` : ''}`) });
      }
    });

    function finish(r, { status, summary }) {
      if (entry.done) return;
      entry.done = true;
      // 중지 요청 뒤 리더만 끝났으면 SIGTERM을 무시한 손자가 남아 있을 수 있어 SIGKILL 타이머를 유지한다
      if (!(entry.stopRequested && groupAlive(child?.pid))) clearTimeout(entry.killTimer);
      live.delete(r.id);
      log.end();
      const verdict = status === 'done' ? parseVerdict(spec.lastMessage) : 'ERROR';
      delete r.resultError;
      delete r.lastText;
      const fullText = spec.review ? '' : (spec.fullText || spec.lastAssistant || '');
      if (fullText) saveResult(r, fullText);
      const needsReply = status === 'done' && Boolean(r.sessionId) && looksLikeQuestion(fullText);
      // 비서실장이 실행 중에 task start 로 만든 업무는 훅이 sessions.json 에만 연결한다. run 에도 남겨
      // 산출물 탭의 대화 스레드·사용자 반려(이어서 답하기)가 같은 업무의 run 을 찾게 한다
      if (!r.task && r.sessionId) {
        const linked = sessionTask(r.sessionId);
        if (linked) r.task = linked;
      }
      Object.assign(r, { status, summary, needsReply, endedAt: new Date().toISOString() });
      if (needsReply) {
        emit({ engine: spec.engine, session: `run-${r.id}`, instance: `run-${r.id}`, agent: spec.agentId || 'chief', kind: 'reply.wait', run: r.id, ...(r.task ? { task: r.task } : {}), summary: redact(lastParagraph(fullText), 160) });
      }
      // REVIEWS 지표·업무 판정에 잡히도록 codex-review.mjs 와 같은 review.end 이벤트를 남긴다
      if (codexEvent) emit({ ...evBase, kind: 'review.end', verdict, summary: redact(summary || verdict) });
      changed(r);
      entry.onDone?.();
      pump();
    }
  }

  function pump() {
    while (queue.length && runningCount() < maxConcurrent) {
      const { run, spec } = queue.shift();
      if (run.status === 'queued') launch(run, spec);
    }
  }

  // 프로세스 트리 전체를 끝낸다(POSIX: 그룹 신호, Windows: taskkill /T /F)
  function signal(entry, sig) {
    killTree(entry.child, sig);
  }

  function requestStop(entry) {
    if (entry.stopRequested) return;
    entry.stopRequested = true;
    signal(entry, 'SIGTERM');
    entry.killTimer = setTimeout(() => signal(entry, 'SIGKILL'), killGraceMs);
    entry.killTimer.unref?.();
  }

  // 서버 종료용: 대기열은 취소하고 실행 중인 프로세스 그룹은 모두 끝낸다.
  // SIGTERM 후 graceMs 안에 끝나지 않으면 SIGKILL을 보내고, 정리가 끝나면 resolve 한다.
  function stopAll({ graceMs = killGraceMs } = {}) {
    const now = new Date().toISOString();
    for (const { run } of queue.splice(0)) {
      if (run.status === 'queued') Object.assign(run, { status: 'stopped', endedAt: now, summary: '서버 종료로 대기 중인 실행을 취소했습니다.' });
    }
    persist();
    const entries = [...live.values()].filter((e) => e.child && !e.done);
    return Promise.all(entries.map((entry) => new Promise((resolveStop) => {
      let settled = false;
      let hardStop = null;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(entry.killTimer);
        clearTimeout(hardStop);
        resolveStop();
      };
      // 리더가 끝났어도 그룹(손자 프로세스)이 남아 있으면 SIGKILL 시점까지 기다린다
      entry.onDone = () => { if (!groupAlive(entry.child.pid)) done(); };
      requestStop(entry);
      clearTimeout(entry.killTimer);
      // 리더가 끝나도 그룹이 남을 수 있어 유예 시간 뒤에는 무조건 SIGKILL을 보낸다.
      // 종료 중 이벤트 루프가 먼저 비어 SIGKILL을 못 보내는 일이 없도록 unref 하지 않는다
      hardStop = setTimeout(() => {
        signal(entry, 'SIGKILL');
        setTimeout(done, 200);
      }, graceMs);
    })));
  }

  function stop(runId) {
    const run = runs.find((r) => r.id === runId);
    if (!run) throw httpError(404, `실행을 찾을 수 없습니다: ${runId}`);
    if (run.status === 'queued') {
      const idx = queue.findIndex((q) => q.run.id === runId);
      if (idx >= 0) queue.splice(idx, 1);
      Object.assign(run, { status: 'stopped', endedAt: new Date().toISOString(), summary: '대기 중에 취소했습니다.' });
      changed(run);
      return publicRun(run);
    }
    const entry = live.get(runId);
    if (run.status !== 'running' || !entry) return publicRun(run);
    requestStop(entry);
    return publicRun(run);
  }

  function list() {
    return runs.map(publicRun);
  }

  // 업무에 연결된 가장 최근 실행(사용자 반려 → 이어서 답하기 대상 찾기용). sessions: 그 업무에 연결된 세션 id 목록
  function latestForTask(taskId, sessions = []) {
    const ids = new Set(sessions);
    let best = null;
    for (const r of runs) {
      if (r.target === 'review') continue;
      if (r.task !== taskId && !(r.sessionId && ids.has(r.sessionId))) continue;
      if (!best || String(r.createdAt) >= String(best.createdAt)) best = r;
    }
    return best ? publicRun(best) : null;
  }

  // 업무가 승인(완료)되면 그 업무에 연결된 실행의 '답변 필요'를 끈다(승인 뒤에도 💬가 남지 않게). 반환: 바꾼 실행 수
  function clearNeedsReply(taskId, sessions = []) {
    const ids = new Set(sessions);
    let n = 0;
    for (const r of runs) {
      if (r.needsReply !== true) continue;
      if (r.task !== taskId && !(r.sessionId && ids.has(r.sessionId))) continue;
      r.needsReply = false;
      n += 1;
    }
    if (n) {
      persist();
      try { onChange?.(); } catch { /* 화면 갱신 오류는 무시 */ }
    }
    return n;
  }

  return { start, stop, stopAll, list, startReview, reply, result, latestForTask, clearNeedsReply };
}
