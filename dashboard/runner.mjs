// 대시보드 작업 실행기: claude -p / codex exec 를 프로세스 그룹으로 띄우고 runs 를 관리한다
import * as child_process from 'node:child_process';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadOrg } from '../lib/org.mjs';
import { renameWithRetry } from '../lib/paths.mjs';
import { appendEvent, normalizeCodexItem, redact } from '../lib/events.mjs';
import { buildPrompt, parseVerdict } from '../scripts/codex-review.mjs';
import { AGENT_ID_PATTERN, RUN_MODELS, TOOL_PATTERN, codexModelArgs, killTree, resolveCommand, spawnCli, writePrompt } from '../lib/cli.mjs';

const PERMISSIONS = ['acceptEdits', 'bypassPermissions', 'default'];
const MAX_PROMPT = 20000;
const MAX_KEPT_RUNS = 200;

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
  function buildSpec(agentId, prompt, model) {
    const org = loadOrg(root);
    if (!agentId) {
      const chiefDept = org.departments.find((d) => d.id === 'chief');
      const perm = PERMISSIONS.includes(chiefDept?.permission) ? chiefDept.permission : 'acceptEdits';
      return claudeSpec({ agentId: null, perm, tools: null, prompt, model });
    }
    if (!AGENT_ID_PATTERN.test(agentId)) throw httpError(400, `직원 id 형식이 올바르지 않습니다: ${agentId}`);
    const agent = org.roster.find((a) => a.id === agentId);
    if (!agent) throw httpError(404, `직원을 찾을 수 없습니다: ${agentId}`);
    if (agent.active === false) throw httpError(409, `${agent.name || agentId} 님은 휴무 중이라 작업을 지시할 수 없습니다.`);
    const dept = org.departments.find((d) => d.id === agent.department);
    if (dept?.active === false) throw httpError(409, `${dept.name || dept.id} 부서가 운영 중지 상태라 작업을 지시할 수 없습니다.`);
    if (dept?.engine === 'codex') return codexSpec({ agent, dept, prompt });
    const perm = PERMISSIONS.includes(dept?.permission) ? dept.permission : 'acceptEdits';
    const tools = Array.isArray(dept?.tools) && dept.tools.length ? dept.tools : null;
    if (tools && !tools.every((t) => TOOL_PATTERN.test(t))) {
      throw httpError(400, `${dept.name || dept.id} 부서의 허용 도구 이름에 쓸 수 없는 문자가 있습니다.`);
    }
    return claudeSpec({ agentId, perm, tools, prompt, model });
  }

  function claudeSpec({ agentId, perm, tools, prompt, model }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', perm,
      ...(agentId ? ['--agent', agentId] : []),
      ...(tools ? ['--allowedTools', tools.join(',')] : []),
      ...(model ? ['--model', model] : [])];
    return { engine: 'claude', agentId, cmd: resolveCommand('claude', 'CLAUDE_BIN'), args, input: prompt };
  }

  // codex 엔진(검증실) 직원: codex-review.mjs 와 같은 검토 프롬프트(공통 기준·VERDICT 형식)에 요청을 붙인다.
  // 대시보드 요청에는 산출물 폴더가 없어서 reviews/<id>.md 저장은 하지 않는다(산출물 검증은 POST /api/reviews).
  function codexSpec({ agent, dept, prompt }) {
    const text = buildPrompt({ id: agent.id, name: agent.name || agent.id, specialty: agent.specialty || '', instructions: agent.instructions || '' }, null, prompt);
    let modelArgs;
    try {
      modelArgs = codexModelArgs({ model: dept?.codexModel, effort: dept?.codexEffort });
    } catch (err) {
      throw httpError(400, err.message);
    }
    return {
      engine: 'codex',
      agentId: agent.id,
      cmd: resolveCommand('codex', 'CODEX_BIN'),
      args: ['exec', '--json', '-s', 'read-only', '-C', root, ...modelArgs, '-'],
      input: text,
    };
  }

  function addRun(spec, target, request) {
    const run = {
      id: newRunId(),
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
    };
    runs.push(run);
    if (runningCount() < maxConcurrent) launch(run, spec);
    else {
      queue.push({ run, spec });
      changed(run);
    }
    return { ...run };
  }

  // model: 작업 단위 모델 별칭(haiku|sonnet|opus). 없으면 직원·부서 설정을 따른다
  function start({ agentId = null, prompt, model = null } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw httpError(400, '작업 요청 내용을 입력해 주세요.');
    if (prompt.length > MAX_PROMPT) throw httpError(400, `작업 요청은 ${MAX_PROMPT}자 이하로 입력해 주세요.`);
    if (agentId !== null && (typeof agentId !== 'string' || !agentId)) throw httpError(400, '직원 id 형식이 올바르지 않습니다.');
    if (model !== null && model !== '' && !RUN_MODELS.includes(model)) {
      throw httpError(400, `모델은 ${RUN_MODELS.join('/')} 중 하나여야 합니다.`);
    }
    const spec = buildSpec(agentId, prompt, model || null);
    return addRun(spec, agentId || 'chief', prompt);
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
    if (spec.engine === 'claude') {
      if (msg.type === 'result') {
        if (typeof msg.result === 'string') run.summary = redact(msg.result);
        if (msg.is_error) run.resultError = true;
      } else if (msg.type === 'assistant' && !run.summary) {
        const text = (msg.message?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join(' ');
        if (text) run.lastText = redact(text);
      }
      return;
    }
    // codex 는 Claude 훅이 없으므로 JSON 스트림을 이벤트로 직접 남긴다
    if (msg.type === 'item.completed' && msg.item?.type === 'agent_message' && typeof msg.item.text === 'string') {
      run.summary = redact(msg.item.text);
      spec.lastMessage = msg.item.text; // 판정 파싱용 전문(runs.json에는 남기지 않는다)
    }
    const ev = normalizeCodexItem(msg, { agent: spec.agentId, session: `run-${run.id}` });
    if (ev) emit(ev);
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
      child = spawnCli(spec.cmd, spec.args, { cwd: root, env: process.env, spawnImpl });
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
      Object.assign(r, { status, summary, endedAt: new Date().toISOString() });
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
      return { ...run };
    }
    const entry = live.get(runId);
    if (run.status !== 'running' || !entry) return { ...run };
    requestStop(entry);
    return { ...run };
  }

  function list() {
    return runs.map((r) => {
      const { resultError, lastText, ...pub } = r;
      return pub;
    });
  }

  return { start, stop, stopAll, list, startReview };
}
