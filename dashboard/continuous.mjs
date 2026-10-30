import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrg, writeFileAtomic } from '../lib/org.mjs';
import { buildOrgMap } from '../lib/orgmap.mjs';
import { codexRole } from '../lib/settings.mjs';
import { appendEvent, redact, redactContext } from '../lib/events.mjs';
import { readPrivate, writePrivate } from '../lib/private-state.mjs';
import { loadTasks, updateTask, completeTask } from '../lib/tasks.mjs';
import { collectFinalOutputs } from '../lib/final-outputs.mjs';
import { waitUntil } from '../lib/continuous.mjs';
import { parseObject } from './orchestrator.mjs';

export const monitorFile = (root, id) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('감시 id가 올바르지 않습니다.');
  return join(root, '.office', 'continuous', `${id}.json`);
};
export async function runContinuous({ root, run, prompt, options, execute, dispatch, deliveryState, signal,
  progress = () => {}, onDecision = () => {}, now = Date.now, sleep = waitUntil }) {
  const file = monitorFile(root, run.rootId);
  const saved = readPrivate(file);
  if (saved.task && saved.task !== run.task) throw new Error('감시 업무가 원래 업무와 다릅니다.');
  const state = { version: 1, task: run.task, originalRequest: redactContext(prompt), options,
    startedAt: now(), deadlineAt: options.deadlineAt ?? (options.durationMs === null ? null : now() + options.durationMs),
    cycles: 0, cursor: '', seen: [], batches: [], pending: [], decisions: [], ...saved, desired: true, latestRun: run.id };
  if (saved.originalRequest && prompt !== saved.originalRequest && !/^(이어서\s*)?(재개|resume)$/i.test(prompt.trim())) state.decisions.push(redactContext(prompt));
  const persist = () => writePrivate(file, state);
  const emit = (kind, fields = {}) => appendEvent(root, { engine: run.engine, agent: state.agent || 'chief',
    session: `monitor-${run.id}`, instance: `monitor-${run.id}`, task: run.task, kind, ...fields });
  const publish = (status) => {
    state.status = status; persist();
    progress({ status, agent: state.agent || null, cycles: state.cycles, discoveries: state.seen.length,
      deliveries: state.batches.filter((b) => b.runId).length, pending: state.pending.length,
      intervalMs: state.options.intervalMs, deadlineAt: state.deadlineAt, nextAt: state.nextAt || null,
      lastCheckedAt: state.lastCheckedAt || null, error: state.lastError || '' });
  };
  const ask = (question) => {
    state.question = redactContext(question); publish('needs_decision'); onDecision();
    updateTask(root, run.task, (task) => { task.status = 'blocked'; return true; });
    return `지속 감시를 이어가기 위해 결정이 필요합니다.\n\n${state.question}`;
  };
  persist();
  const recordStop = () => {
    state.desired = signal.reason === 'server-shutdown';
    publish(state.desired ? 'suspended' : 'stopped');
    updateTask(root, run.task, (task) => { task.status = 'blocked'; return true; });
  };
  signal.addEventListener('abort', recordStop, { once: true });
  try {
    if (signal.aborted) recordStop();
    signal.throwIfAborted();
    const org = loadOrg(root);
    const active = (id) => org.roster.some((a) => a.id === id && a.active !== false && org.departments.some((d) => d.id === a.department && d.active !== false && !(d.engine === 'codex' && codexRole(d) === 'review')));
    const timeLeft = () => state.deadlineAt === null || now() < state.deadlineAt;
    if (!state.agent && timeLeft()) {
      if (options.agentId) state.agent = options.agentId;
      else {
        if (!org.roster.some((a) => active(a.id))) return ask('감시를 맡을 근무중 실행 직원을 추가하거나 근무 상태를 확인해 주세요.');
        while (!state.agent && timeLeft()) {
          try {
            signal.throwIfAborted();
            const selected = parseObject(await execute({ phase: 'watch-plan', deadlineAt: state.deadlineAt, prompt: [
              '지속 감시 업무의 담당을 정하는 비서실장입니다. JSON {agent,instructions,deliveryPrompt,question}만 응답하세요.',
              '근무중 실행 직원 1명을 agent로 지정하고, instructions에 조사 기준과 새 자료 판단 기준을 적으세요.',
              'deliveryPrompt에는 새 자료를 팀장이 취합하고 필요한 부서가 가공한 뒤 비서실장이 검토·보고할 1회 전달 절차를 적으세요. 감시 자체는 별도로 계속됩니다.',
              '실제 결정이 필요할 때만 question을 쓰고 그 외에는 빈 문자열. 별도 검증실은 필요하지 않습니다.',
              buildOrgMap(org), `대표 요청:\n${state.originalRequest}`, `추가 결정:\n${JSON.stringify(state.decisions)}`,
            ].join('\n\n') }));
            if (selected.question?.trim()) return ask(selected.question);
            if (!active(selected.agent)) throw new Error('근무중 실행 직원 id로 담당을 다시 지정해야 합니다.');
            state.agent = selected.agent; state.instructions = selected.instructions; state.deliveryPrompt = selected.deliveryPrompt;
            state.lastError = '';
          } catch (error) {
            signal.throwIfAborted(); if (!timeLeft()) break;
            state.planFailures = (state.planFailures || 0) + 1;
            state.lastError = redact(error.message); publish('retrying');
            await sleep(Math.min(state.options.intervalMs, 30000, (state.deadlineAt ?? Infinity) - now()), signal);
          }
        }
      }
    }
    if (timeLeft() && !active(state.agent)) return ask('감시를 맡을 근무중 실행 직원을 지정해 주세요.');
    const taskDir = join(root, 'outputs', ...run.task.split('/'));
    mkdirSync(join(taskDir, 'discoveries'), { recursive: true });
    const seen = new Set(state.seen);
    // 다른 부서의 보고가 끝나기를 기다리지 않고 감시를 계속한다. 동시에 보고는 두 묶음까지 진행한다.
    const drain = (flush = false) => {
      let inFlight = state.batches.filter((b) => b.runId && ['running', 'queued'].includes(deliveryState(b.runId)?.status)).length;
      if (!flush && state.batches.some((b) => b.runId && deliveryState(b.runId)?.needsReply)) return;
      for (const batch of state.batches) {
        const previous = batch.runId && deliveryState(batch.runId, batch.task);
        if (previous && ['failed', 'stopped'].includes(previous.status) && !previous.userStopped && previous.taskStatus !== 'done') {
          batch.runId = null; if (!state.pending.includes(batch.key)) state.pending.push(batch.key);
        }
        if (batch.runId || !flush && inFlight >= 2) continue;
        let child;
        try { child = dispatch({ key: batch.key, path: batch.path, prompt: [
          '이 실행은 지속 감시에서 발견한 새 자료를 처리하는 1회 업무입니다. 감시를 다시 시작하지 마세요.',
          `원래 업무 목적:\n${state.originalRequest}`, `전달 절차:\n${state.deliveryPrompt || '담당 팀장 취합 → 필요한 부서의 산출물 작성 → 비서실장 최종 검토·보고'}`,
          `새 자료 파일: ${batch.path}`, `추가 결정: ${JSON.stringify(state.decisions)}`,
          '위 파일의 새 자료를 입력으로 계획하세요. 이미 조사된 자료를 불필요하게 다시 수집하지 마세요.',
        ].join('\n\n') }); }
        catch (error) { batch.lastError = redact(error.message); persist(); continue; }
        batch.runId = child.id; batch.task = child.task;
        state.pending = state.pending.filter((key) => key !== batch.key);
        inFlight++; persist();
        emit('monitor.deliver', { summary: '새 자료를 후속 부서의 보고 업무로 전달했습니다.', relatedTask: child.task });
      }
    };
    while (state.deadlineAt === null || now() < state.deadlineAt) {
      signal.throwIfAborted(); drain();
      if (state.nextAt && state.nextAt > now()) {
        publish('waiting');
        await sleep(Math.min(state.nextAt, state.deadlineAt ?? Infinity) - now(), signal);
        if (state.deadlineAt !== null && now() >= state.deadlineAt) break;
      }
      publish('checking');
      let result;
      try {
        result = parseObject(await execute({ phase: 'watch', agentId: state.agent, deadlineAt: state.deadlineAt, prompt: [
          '지속 감시의 이번 확인 차례입니다. 직접 무한 반복하거나 다음 확인 시간을 기다리지 마세요. 새 자료 확인 후 JSON을 반환하면 실행기가 다음 차례를 이어갑니다.',
          'JSON {cursor,summary,question,items:[{key,title,url,summary,observedAt}]}입니다. 새 자료가 없으면 items:[]로 끝내세요.',
          'key는 같은 자료에서 바뀌지 않는 출처/게시 시각 기준의 식별자입니다. 같은 글의 요약 표현만 바뀐 것은 새 자료가 아닙니다.',
          '기존 자료를 새것처럼 만들지 말고 확인한 링크·게시/갱신 시각을 근거로 판단하세요. 질문은 대표 결정이 꼭 필요한 경우만 적으세요.',
          `대표 요청:\n${state.originalRequest}`, state.instructions || '', `추가 결정: ${JSON.stringify(state.decisions)}`,
          `지난 확인: ${state.lastCheckedAt || '최초'}`, `커서: ${state.cursor}`, `이미 전달한 최근 자료 키: ${JSON.stringify(state.recentKeys || [])}`,
        ].join('\n\n') }));
        if (!Array.isArray(result.items) || result.items.length > 100 || result.items.some((item) => !item || typeof item.key !== 'string' || !item.key.trim() || typeof item.summary !== 'string' || typeof item.title !== 'string')) throw new Error('자료 목록에 식별자·제목·내용이 필요합니다.');
      } catch (error) {
        signal.throwIfAborted();
        if (state.deadlineAt !== null && now() >= state.deadlineAt) break;
        state.failures = (state.failures || 0) + 1;
        state.lastError = redact(error.message);
        if (state.failures === 3 || state.failures % 12 === 0) emit('monitor.error', { summary: `자료 확인 일시 오류로 재시도를 유지합니다. ${redact(error.message)}` });
        state.nextAt = now() + Math.min(state.options.intervalMs * 2 ** Math.min(state.failures - 1, 5), 30 * 60000);
        publish('retrying'); continue;
      }
      signal.throwIfAborted();
      if (result.question?.trim()) return ask(result.question);
      const fresh = [];
      for (const item of result.items) {
        const key = createHash('sha256').update(item.key).digest('hex');
        if (seen.has(key)) continue;
        seen.add(key); fresh.push({ ...item, summary: redactContext(item.summary) });
      }
      state.seen = [...seen]; state.cursor = String(result.cursor || '').slice(0, 10000);
      state.recentKeys = [...(state.recentKeys || []), ...fresh.map((item) => item.key)].slice(-200);
      state.failures = 0; state.lastError = ''; state.cycles++; state.lastCheckedAt = new Date(now()).toISOString();
      state.nextAt = now() + state.options.intervalMs;
      if (fresh.length) {
        const key = createHash('sha256').update(fresh.map((i) => i.key).join('\n')).digest('hex').slice(0, 20);
        const path = `outputs/${run.task}/discoveries/${key}.json`;
        writeFileAtomic(join(root, path), JSON.stringify({ observedAt: state.lastCheckedAt, items: fresh }, null, 2) + '\n');
        state.batches.push({ key, path }); state.pending.push(key);
        emit('monitor.discovered', { summary: `새 자료 ${fresh.length}건을 확인했습니다.` });
      }
      publish('waiting'); drain();
    }
    // 수집 종료 직전 발견한 자료도 전역 CLI 대기열로 넘긴다. 수집 종료가 자료 폐기가 되지 않게 한다.
    state.desired = false; drain(true); publish('finished');
    const report = `# 지속 감시 종료\n\n확인 ${state.cycles}회 · 새 자료 ${state.seen.length}건\n\n` +
      state.batches.map((b) => `- ${b.task ? `후속 보고 업무: ${b.task}` : '전달 대기'} · 자료: ${b.path}${b.runId ? ` (${deliveryState(b.runId)?.status || '확인 필요'})` : ''}`).join('\n') +
      '\n\n진행 중이거나 대표 결정을 기다리는 후속 업무는 각 업무 카드에서 이어집니다.\n';
    writeFileAtomic(join(taskDir, 'report.md'), report);
    try { collectFinalOutputs(root, { task: run.task, title: loadTasks(root).find((t) => t.id === run.task)?.title || '지속 감시 종료' }); }
    catch { return ask('최종산출물을 저장하지 못했습니다. 회사 설정의 저장 위치·폴더 권한을 확인한 뒤 이어서 재개해 주세요.'); }
    completeTask(root, run.task);
    emit('flow.deliver', { agent: 'chief', summary: '지정 시간의 감시를 완료하고 결과를 전달했습니다.' });
    return report;
  } finally { signal.removeEventListener('abort', recordStop); }
}
