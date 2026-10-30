// Codex 비서실장은 계획·검토만 한다. 배정·재시도·반려 한도·인계는 프로그램이 진행한다.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadOrg, writeFileAtomic } from '../lib/org.mjs';
import { buildOrgMap } from '../lib/orgmap.mjs';
import { validatePlan, compactPlan, normalizePlanInputs } from '../lib/plan.mjs';
import { appendEvent, redact, redactContext } from '../lib/events.mjs';
import { loadTasks, updateTask, completeTask } from '../lib/tasks.mjs';
import { insideRel } from '../lib/outputs.mjs';
import { codexRole } from '../lib/settings.mjs';
import { parseVerdict } from '../scripts/codex-review.mjs';
import { stageResult, outputIssues, HTML_BRIEF } from '../lib/work-result.mjs';
import { programRoot } from '../lib/paths.mjs';
import { externalActionPolicy } from '../lib/browser-work.mjs';
import { preparePublications } from '../lib/publications.mjs';
import { collectFinalOutputs } from '../lib/final-outputs.mjs';

export function parseObject(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  const obj = JSON.parse(value);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('구조화된 JSON 응답이 필요합니다.');
  return obj;
}

export function checkpointFile(root, rootId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(rootId)) throw new Error('실행 id가 올바르지 않습니다.');
  return join(root, '.office', 'orchestrations', `${rootId}.json`);
}

export async function orchestrate({ root, run, prompt, execute, signal, maxParallel = 4, resume = false, onDecision = () => {}, outbound = null }) {
  const task = run.task;
  const taskDir = join(root, 'outputs', ...task.split('/'));
  const file = checkpointFile(root, run.rootId);
  mkdirSync(taskDir, { recursive: true });
  const taskReal = realpathSync(taskDir);
  if (!insideRel(realpathSync(root), taskReal)) throw new Error('업무 폴더가 작업 공간 밖을 가리킵니다.');
  const org = loadOrg(root);
  const videoPolicy = run.schedule?.uniqueYoutube ? run.schedule : null;
  const videoExclusions = join(taskDir, 'video-exclusions.json');
  if (videoPolicy) writeFileAtomic(videoExclusions, JSON.stringify({ excludedVideoIds: outbound?.videoHistory?.(run.rootId) || [] }, null, 2));
  const videoBrief = videoPolicy ? `영상 게시 기준: 오늘 ${videoPolicy.minPosts}~${videoPolicy.maxPosts}개, 영상 1개당 게시글 1개입니다. ${videoExclusions}의 영상 ID는 사용하지 마세요. shorts/watch/youtu.be 주소가 달라도 ID가 같으면 같은 영상입니다. 주제에 맞는 영상을 실제로 확인해 원본 링크와 요약·선정 근거를 적으세요. 다른 채널의 재업로드로 확인되는 동일 영상도 제외하세요. 새 후보가 부족하면 중복으로 채우지 않고 실제 후보만 작성하며 skipped에 사유를 적으세요. 게시 본문 단계는 JSON {posts:[{subject,body}],skipped:[사유]}로 작성하고 각 body에 유튜브 원본 링크를 넣으세요. 실제 게시는 실행기가 검토 후 처리합니다.` : '';
  let saved = {};
  if (existsSync(file)) {
    saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.task !== task) throw new Error('재개할 업무가 원래 실행과 다릅니다.');
  }
  const answering = Boolean(saved.pending?.length);
  let state = { ...saved, version: 2, task,
    originalRequest: saved.originalRequest || redactContext(prompt),
    decisions: [...(saved.decisions || [])], completed: { ...(saved.completed || {}) },
    routes: { ...(saved.routes || {}) }, delegated: { ...(saved.delegated || {}) },
    rejects: saved.delivered ? 0 : saved.rejects || 0 };
  if (saved.originalRequest && !resume) {
    state.decisions.push({ questions: saved.pending || [], answer: redactContext(prompt) });
    state.pending = [];
  }
  const context = () => `대표 최초 요청:\n${state.originalRequest}\n\n추가 지시·결정:\n${JSON.stringify(state.decisions)}\n\n${videoBrief}`;
  const instructionKey = () => createHash('sha256').update(JSON.stringify([state.originalRequest, state.decisions])).digest('hex');
  const policy = () => externalActionPolicy([state.originalRequest, ...state.decisions.map((d) => d.answer)]);
  const allowedActions = () => policy().actions;
  const persist = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dirname(file), 0o700);
    writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  };
  const checkStop = () => signal.throwIfAborted();
  const emit = (kind, fields = {}) => appendEvent(root, { engine: run.engine, session: `office-orchestrator-${run.id}`,
    instance: `office-orchestrator-${run.id}`, agent: 'chief', task, kind, ...fields });
  const blocked = (text) => {
    updateTask(root, task, (t) => { t.status = 'blocked'; return true; });
    state.delivered = false;
    persist();
    return text;
  };
  const ask = (questions) => {
    state.pending = questions.map((q) => ({ ...q, question: redactContext(q.question) }));
    onDecision();
    return blocked('대표 결정이 필요합니다.\n\n' + state.pending.map((q, i) => `${i + 1}. ${q.stage ? `[${q.stage}] ` : ''}${q.question}`).join('\n\n'));
  };
  // 계획 전 질문으로 멈추더라도 최초 요청은 남긴다.
  persist();
  const outputPath = (value) => isAbsolute(value) ? resolve(value)
    : resolve(/^outputs[\\/]/.test(value) ? root : taskDir, value);
  const safeOutput = (value, create = false) => {
    const path = outputPath(value);
    if (!insideRel(taskDir, path)) throw new Error('단계 산출물은 해당 업무 폴더 안이어야 합니다.');
    let ancestor = path;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (realpathSync(ancestor) !== taskReal && !insideRel(taskReal, realpathSync(ancestor))) throw new Error('산출물 경로가 업무 폴더 밖을 가리킵니다.');
    if (create) mkdirSync(dirname(path), { recursive: true });
    return path;
  };
  const fingerprint = (stage) => {
    try {
      const path = safeOutput(stage.output);
      if (!statSync(path).isFile()) return null;
      const content = readFileSync(path);
      if (outputIssues(path, content).length) return null;
      return createHash('sha256').update(content).digest('hex');
    } catch { return null; }
  };
  const planning = async (extra = '') => {
    const text = await execute({ phase: 'plan', prompt: [
      '당신은 비서실장입니다. 직접 실무·파일 작성·도구 위임을 하지 말고 계획 JSON만 응답하세요.',
      '질문이 꼭 필요하면 question에 한 번에 묶고 plan은 null. 그 외에는 question은 빈 문자열입니다.',
      `업무 id: ${task}. 산출물은 outputs/${task}/<부서>/<직원id>-<이름>.<확장자>입니다.`,
      'plan은 {version:1,task,goal,stages:[{id,title,dept,agent,inputs,output,done,dependsOn,parallelGroup}],review:{by,criteria},gaps:[{need,suggestion}]}입니다.',
      'review.by는 기본 chief입니다. 비서실장이 최종 검토·보고하므로 검증실 부재는 공백이 아닙니다. 대표가 별도 전문 검토를 명시한 경우만 codex 또는 해당 검토 직원 id를 씁니다.',
      `현재 최종 검토 제공자는 ${run.engine}입니다. 이 제공자가 Codex면 대표의 일반적인 Codex 검토 요청은 review.by=chief로 충족합니다. 검증실 부서를 새로 요구하지 마세요. plan.task는 반드시 ${task} 그대로 쓰며 제목을 넣지 마세요.`,
      'done은 완료 기준 문자열입니다. 근무중 exec 직원에게만 생산 단계를 배정하고 검토 직원은 stages에 넣지 마세요.',
      '앞 단계 id를 inputs와 dependsOn에 넣으세요. report/summary/findings/analysis로 시작하는 .md 이름은 쓰지 마세요.',
      `파일 조회 기준 폴더는 작업 공간 ${root}입니다. .office/… 등 요청의 상대 원본 경로는 작업 공간 기준입니다. inputs에는 앞 단계 id 또는 작업 공간 내부 원본의 절대 경로를 쓰세요. 기존 업무 상대 입력도 지원합니다. 파일 부재를 묻기 전에 Read/Glob으로 작업 공간과 업무 폴더를 확인하세요. 경로 검사 실패는 먼저 계획을 수정하고 실제로 있는 원본의 복구를 대표에게 요구하지 마세요.`,
      'plan.deliverables에는 대표에게 최종 전달할 단계 id를 고르세요. 최종 HTML·문서·첨부 등 요청 결과만 포함하고 계획·중간 조사·검토용 문안은 제외하세요. 별도 첨부가 없으면 []. 실행기가 검토 후 최종산출물/날짜/업무명 폴더로 모읍니다.',
      '담당이 없고 관련 부서가 둘 이상이면 needsMeeting:true와 meetingAgents(2~4명). 회의 제안이 주어졌으면 반영하고 needsMeeting:false.',
      '피드백이면 rerunStages에 수정할 단계 id만 넣으세요. 후속 단계는 프로그램이 다시 실행합니다.',
      '부서 팀장에게 배정하면 팀장은 구조화된 delegate 응답으로 같은 부서 직원에게 분담할 수 있습니다. 전달 부서의 필수/권장을 확인하세요.',
      'plan.publications는 대표가 지시한 외부 작업 배열입니다. 외부 작업이 없으면 []. 각 항목은 {id,action,service,connection,agent,target,recipients,subject,content}입니다.',
      'action은 mail/post/comment, service는 naverworks_mail/naver_blog/naver_cafe/daum_cafe/tistory/brunch입니다. content에는 검토할 본문 산출물 단계 id 또는 파일 경로를 씁니다. 메일은 recipients 배열을 채우고, 글은 target에 해당 블로그/게시판/댓글 원문 주소를 지정하세요.',
      '실제 외부 작업은 산출물 작성과 비서실장 검토를 마친 뒤 실행기가 브라우저로 진행합니다. 로그인 정보는 요청하거나 파일에 적지 마세요. 계정이 없으면 connection은 빈 문자열로 두고 자료 준비를 먼저 진행합니다. 연결 계정이 여러 개면 사용할 계정을 확인하세요.',
      '제휴업체 조사 후 주소를 알아내는 메일 업무는 조사 단계 다음에 개인별 발송 문안 JSON 단계를 두세요. {messages:[{recipients:["회사 메일"],subject:"제목",body:"양식을 채운 본문"}],skipped:["연락처 미확인 업체·이유"]}를 작성하고 publication.content에 그 단계 id, recipients에는 []를 씁니다. 검토 후 실행기가 문안별로 자동 발송합니다. 주소·출처를 확인하지 못한 업체에는 보내지 않습니다.',
      '여러 게시글은 검토할 본문 JSON 단계에 {posts:[{subject,body}],skipped:[사유]}를 작성하고 publication.content에 그 단계 id를 지정하세요. 실행기가 글마다 별도로 게시합니다. 유튜브 링크의 영상 ID는 작업 공간 공통 이력과 대조해 재게시를 차단합니다.',
      `대표가 허용한 외부 작업: ${JSON.stringify(allowedActions())}. 초안만 요청한 업무를 외부에 게시하지 마세요.`,
      `연결된 계정: ${JSON.stringify(outbound?.connections() || [])}`,
      HTML_BRIEF,
      buildOrgMap(org), `대표 요청:\n${context()}`, saved.plan ? `이전 계획과 완료 상태:\n${JSON.stringify({ plan: saved.plan, completed: saved.completed })}` : '', extra,
    ].filter(Boolean).join('\n\n') });
    checkStop();
    return parseObject(text);
  };
  checkStop();
  let response;
  let plan;
  const publicationCorrection = answering && saved.pending?.some((q) => q.phase === 'publish') && /수정|변경|바꿔|초안|수신자|하지\s*마/.test(prompt);
  // 옛 실행기는 검토 후 브라우저·전달 오류도 plan 질문으로 저장했다.
  // 명시 재개라면 승인된 계획을 재검사하며 완료 파일·검토를 재사용한다.
  if ((resume || answering) && saved.plan && !publicationCorrection
      && (resume && saved.approvedReview || !saved.pending?.some((q) => q.phase === 'plan'))) {
    response = { plan: saved.plan, rerunStages: [] };
    plan = saved.plan;
  } else {
    let error = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await planning(error);
        if (typeof response.question === 'string' && response.question.trim()) return ask([{ phase: 'plan', question: response.question }]);
        if (response.needsMeeting) {
          const attendees = [...new Set(response.meetingAgents || [])];
          if (attendees.length < 2 || attendees.length > 4 || attendees.some((id) => {
            const agent = org.roster.find((a) => a.id === id && a.active !== false);
            const dept = org.departments.find((d) => d.id === agent?.department && d.active !== false);
            return !agent || !dept || (dept.engine === 'codex' && codexRole(dept) === 'review');
          })) throw new Error('회의에는 근무중 실행 직원 2~4명이 필요합니다.');
          emit('meeting.start', { attendees, summary: redact(state.originalRequest) });
          const suggestions = await Promise.all(attendees.map(async (agentId) => ({ agentId,
            text: await execute({ phase: 'meeting', agentId, readOnly: true,
              prompt: `[회의] ${context()}\n파일을 쓰지 말고 범위·산출물·분담·가정을 제안하세요.` }) })));
          checkStop();
          writeFileAtomic(join(taskDir, 'meeting.md'), suggestions.map((s) => `## ${s.agentId}\n${s.text}`).join('\n\n'));
          emit('meeting.end', { summary: '담당 직원의 제안을 받아 계획에 반영했습니다.' });
          response = await planning('회의 제안:\n' + JSON.stringify(suggestions));
          if (response.question?.trim()) return ask([{ phase: 'plan', question: response.question }]);
        }
        plan = response.plan;
        const check = validatePlan(plan, { root, org, taskId: task, fileExists: existsSync });
        if (!check.ok) throw new Error(check.errors.join('\n'));
        if ((plan.publications || []).some((p) => !allowedActions().includes(p.action))) throw new Error('대표가 지시하지 않은 외부 발송·게시를 계획에서 제거하세요.');
        for (const stage of plan.stages) safeOutput(stage.output, true);
        break;
      } catch (err) {
        checkStop();
        error = `계획 검사가 실패했습니다. 다음 오류를 고쳐 다시 응답하세요:\n${err.message}`;
        if (attempt === 1) return blocked(error);
      }
    }
  }
  const checked = validatePlan(plan, { root, org, taskId: task, fileExists: existsSync });
  if (!checked.ok) return blocked(checked.errors.join('\n'));
  // 직원에게 전달하는 경로는 표시용 compactPlan과 분리해 전체 실제 경로를 쓴다.
  plan = normalizePlanInputs(plan, { root, taskId: task, fileExists: existsSync });
  plan = { ...plan, stages: plan.stages.map((stage) => ({ ...stage,
    output: relative(root, outputPath(stage.output)).replace(/\\/g, '/') })) };
  if (plan.publications) plan.publications = plan.publications.map((publication) => ({ ...publication,
    content: plan.stages.find((s) => s.id === publication.content || outputPath(s.output) === outputPath(publication.content))?.id || publication.content }));
  if (plan.deliverables) plan.deliverables = plan.deliverables.map((ref) => plan.stages.find((s) => s.id === ref || outputPath(s.output) === outputPath(ref))?.id || ref);
  const invalidate = new Set(response.rerunStages || []);
  for (const stage of plan.stages) {
    const previous = saved.plan?.stages?.find((s) => s.id === stage.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(stage)
      || !state.completed[stage.id] || fingerprint(stage) !== state.completed[stage.id]) invalidate.add(stage.id);
  }
  // 피드백을 받았는데 수정 단계가 빠졌으면 이전 결과를 그대로 재승인하지 않는다.
  if (saved.delivered && !resume && !invalidate.size) plan.stages.forEach((s) => invalidate.add(s.id));
  const clearDependents = (ids) => {
    let size;
    do {
      size = ids.size;
      for (const stage of plan.stages) if ((stage.dependsOn || []).some((id) => ids.has(id))) ids.add(stage.id);
    } while (size !== ids.size);
    for (const id of ids) delete state.completed[id];
  };
  clearDependents(invalidate);
  state = { ...state, plan, delivered: false, reviewGeneration: (state.reviewGeneration || 0) + (invalidate.size ? 1 : 0) };
  writeFileAtomic(join(taskDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeFileAtomic(join(taskDir, 'brief.md'), `# ${redactContext(plan.goal)}\n\n${plan.stages.map((s) => `- ${s.id}: ${s.agent} / ${s.output} / ${s.done}`).join('\n')}`);
  persist();
  emit('plan.set', { plan: compactPlan(plan, { taskId: task, root }) });
  const executeStage = async (stage, reason = '') => {
    const desc = `${reason ? '[반려] ' : ''}${stage.title}`;
    const engine = org.departments.find((d) => d.id === stage.dept)?.engine || 'claude';
    emit('tool.start', { tool: 'Agent', target: stage.agent, desc, summary: redact(`${stage.agent}: ${desc}`) });
    emit('agent.start', { engine, agent: stage.agent, instance: `${run.id}-${stage.id}` });
    for (const dependency of stage.dependsOn || []) {
      const source = plan.stages.find((s) => s.id === dependency);
      if (source.dept !== stage.dept) emit('flow.cooperate', { from: source.dept, to: stage.dept, summary: redact(source.output) });
    }
    let text;
    let issue = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      checkStop();
      safeOutput(stage.output, true);
      const inputs = (stage.inputs || []).map((input) => plan.stages.find((s) => s.id === input)?.output || input);
      try {
        text = await execute({ phase: 'stage', agentId: stage.agent,
        prompt: `${desc}\n업무: ${task}\n${context()}\n입력: ${JSON.stringify(inputs)}\n출력: ${stage.output}\n완료 기준: ${stage.done}\n${reason}\n${HTML_BRIEF}\n` +
          `부서 근무중 실행 직원: ${JSON.stringify(org.roster.filter((a) => available(a.id, stage.dept)).map((a) => ({ id: a.id, name: a.name, lead: a.lead, role: a.role, specialty: a.specialty || a.description })))}\n` +
          ((plan.publications || []).some((p) => p.action === 'mail' && (p.content === stage.id || p.content === stage.output) && !p.recipients.length)
            ? '이번 산출물은 메일 문안 JSON입니다. 입력 조사 자료의 회사별 연락처·출처를 확인하고 대표 양식을 채운 messages:[{recipients:[주소],subject,body}]와 skipped:[미확인 업체·이유]를 작성하세요. 실제 메일은 지금 보내지 않습니다.\n' : '') +
          (/\.html?$/i.test(stage.output) ? `HTML 보고서 기본 양식: ${join(programRoot(), 'org/templates/report.html')}. 읽어서 정보 구조·스타일을 참고하고 업무에 맞게 작성하세요. {{REPORT_*}} 빈 항목은 모두 채우거나 불필요한 섹션과 함께 제거하세요. 근거가 없으면 꾸미기 위해 숫자·차트를 만들지 마세요.\n` : '') +
          `마지막 응답은 JSON입니다. status=done(작성 완료), needs_decision(대표 결정), reroute(부서 오전달), delegate(팀장 분담). summary/question/department/agent/reason/assignments 필드를 쓰세요.\n` +
          `질문이 필요하면 산출물을 억지로 쓰지 말고 question에 원문을 적으세요. 오전달이면 적합한 department/agent와 reason을 제안하세요.\n` +
          `팀장만 같은 부서의 근무중 직원에게 assignments:[{agent,title,output,done}]로 분담할 수 있습니다. 실행기는 분담 결과를 모아 팀장에게 다시 전달합니다. 직접 다른 직원을 호출하지 마세요.\n` +
          (state.delegated[stage.id] ? '부서 직원의 분담 결과를 입력에서 읽고 취합하세요. 이미 분담했으므로 다시 delegate하지 마세요.\n' : '') +
          (issue ? `앞 실행의 산출물 검사 실패: ${issue}. 수정하여 지정된 파일을 작성하세요.` : '') });
      } catch (err) {
        emit('agent.pause', { engine, agent: stage.agent, instance: `${run.id}-${stage.id}`, summary: redact(err.message) });
        throw err;
      }
      checkStop();
      const result = stageResult(text);
      if (result.status !== 'done') return { stage, result };
      const hash = fingerprint(stage);
      if (hash) {
        state.completed[stage.id] = hash;
        persist();
        emit('agent.stop', { engine, agent: stage.agent, instance: `${run.id}-${stage.id}`, summary: redact(result.summary || text), files: [relative(root, safeOutput(stage.output)).replace(/\\/g, '/')] });
        return { stage, result: { status: 'done' } };
      }
      try { issue = outputIssues(stage.output, readFileSync(safeOutput(stage.output))).join(' '); }
      catch { issue = '산출물이 없습니다'; }
    }
    emit('agent.pause', { engine, agent: stage.agent, instance: `${run.id}-${stage.id}`, summary: redact(issue) });
    throw new Error(`${stage.title}: ${issue || '산출물 검사 실패'}. 한 번 재시도했지만 완료하지 못했습니다.`);
  };
  const savePlan = (candidate) => {
    const check = validatePlan(candidate, { root, org, taskId: task, fileExists: existsSync });
    if (!check.ok) throw new Error(check.errors.join('\n'));
    candidate = normalizePlanInputs(candidate, { root, taskId: task, fileExists: existsSync });
    plan = { ...candidate, stages: candidate.stages.map((stage) => ({ ...stage,
      output: relative(root, safeOutput(stage.output, true)).replace(/\\/g, '/') })) };
    state.plan = plan;
    writeFileAtomic(join(taskDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    persist();
    emit('plan.set', { plan: compactPlan(plan, { taskId: task, root }) });
  };
  const available = (id, dept) => org.roster.some((a) => a.id === id && a.department === dept && a.active !== false)
    && org.departments.some((d) => d.id === dept && d.active !== false && !(d.engine === 'codex' && codexRole(d) === 'review'));
  const transfer = async (stage, result) => {
    if ((state.routes[stage.id] || 0) >= 2) throw new Error('자동 재배정 2회 후에도 담당을 정하지 못했습니다. 적합한 부서를 알려 주세요.');
    const route = parseObject(await execute({ phase: 'route', prompt: [
      '비서실장으로서 오전달된 단계의 담당을 정하세요. 직접 실무하지 마세요.',
      'JSON {department,agent,reason,question}. 근무중 실행 직원만 선택. 필수 전달 경로와 대표 지정 담당을 바꾸어야 하면 question에 결정을 요청하세요.',
      buildOrgMap(org), context(), `현재 계획: ${JSON.stringify(plan)}`, `오전달 단계: ${JSON.stringify(stage)}`, `직원 보고: ${JSON.stringify(result)}`,
    ].join('\n\n') }));
    checkStop();
    if (route.question?.trim()) throw new Error(route.question);
    if (!available(route.agent, route.department) || route.agent === stage.agent) throw new Error('오전달을 해결할 다른 근무중 실행 직원을 정해 주세요.');
    const extension = stage.output.match(/\.[a-z0-9]{1,10}$/i)?.[0] || '.txt';
    const output = `outputs/${task}/${route.department}/${route.agent}-${stage.id}${extension}`;
    const candidate = { ...plan, stages: plan.stages.map((s) => s.id === stage.id ? { ...s, dept: route.department, agent: route.agent, output }
      : { ...s, inputs: (s.inputs || []).map((input) => input === stage.output ? output : input) }) };
    savePlan(candidate);
    state.routes[stage.id] = (state.routes[stage.id] || 0) + 1;
    clearDependents(new Set([stage.id]));
    persist();
    emit('flow.cooperate', { from: stage.dept, to: route.department, summary: redact(`오전달 재배정: ${route.reason || result.reason}`) });
  };
  const delegate = (stage, result) => {
    if (!org.roster.find((a) => a.id === stage.agent)?.lead || state.delegated[stage.id]) throw new Error('부서 팀장만 한 번 분담할 수 있습니다. 담당을 확인해 주세요.');
    const assignments = result.assignments;
    if (!Array.isArray(assignments) || !assignments.length || assignments.length > 6) throw new Error('부서 분담은 1~6명에게 배정해야 합니다.');
    const children = assignments.map((a, i) => {
      if (a.agent === stage.agent || !available(a.agent, stage.dept)) throw new Error('부서 분담은 같은 부서의 다른 근무중 직원에게만 가능합니다.');
      if (typeof a.output !== 'string' || !relative(taskDir, safeOutput(a.output)).replace(/\\/g, '/').startsWith(`${stage.dept}/${a.agent}-`)) throw new Error('분담 산출물은 같은 부서 폴더 안에서 담당 직원 id로 시작해야 합니다.');
      const id = `${stage.id.slice(0, 27)}_d${i + 1}_${createHash('sha256').update(stage.id).digest('hex').slice(0, 5)}`;
      return { id, title: a.title, dept: stage.dept, agent: a.agent, output: a.output, done: a.done,
        inputs: [...(stage.inputs || [])], dependsOn: [...(stage.dependsOn || [])] };
    });
    savePlan({ ...plan, stages: [...plan.stages.map((s) => s.id === stage.id ? { ...s,
      inputs: [...new Set([...(s.inputs || []), ...children.map((c) => c.id)])],
      dependsOn: [...new Set([...(s.dependsOn || []), ...children.map((c) => c.id)])] } : s), ...children] });
    state.delegated[stage.id] = children.map((c) => c.id);
    persist();
  };
  try {
    const waiting = new Map();
    while (true) {
      while (plan.stages.some((s) => !state.completed[s.id])) {
        checkStop();
        const ready = plan.stages.filter((s) => !state.completed[s.id] && !waiting.has(s.id) && (s.dependsOn || []).every((id) => state.completed[id]));
        if (!ready.length) {
          if (waiting.size) return ask([...waiting.values()]);
          throw new Error('진행할 수 있는 계획 단계가 없습니다.');
        }
        const results = await Promise.all(ready.slice(0, Math.max(1, maxParallel)).map((s) => executeStage(s, state.rejectionReason || '')));
        for (const { stage, result } of results) {
          if (result.status === 'done') continue;
          // 질문/이관/분담은 완료 이벤트를 만들지 않는다.
          emit('agent.pause', { agent: stage.agent, instance: `${run.id}-${stage.id}`, summary: redact(result.question || result.reason || result.summary) });
          try {
            if (result.status === 'reroute') await transfer(stage, result);
            else if (result.status === 'delegate') delegate(stage, result);
            else waiting.set(stage.id, { phase: 'stage', stage: stage.id, question: result.question?.trim() || '진행에 필요한 결정을 알려 주세요.' });
          } catch (err) {
            checkStop();
            waiting.set(stage.id, { phase: 'plan', stage: stage.id, question: err.message });
          }
        }
      }
      checkStop();
      const prepared = preparePublications(plan, (path) => readFileSync(safeOutput(path), 'utf8'),
        { excludedVideos: outbound?.videoHistory?.(run.rootId) || [], videoPolicy });
      emit('flow.review_request', { summary: '단계 산출물 검토를 요청했습니다.' });
      const reviewSignature = createHash('sha256').update(JSON.stringify([plan, state.completed, state.reviewGeneration, state.rejects])).digest('hex');
      const cached = state.approvedReview?.signature === reviewSignature ? state.approvedReview : null;
      const reviewers = cached || plan.review?.by === 'chief' || !plan.review?.by ? [] : org.roster.filter((a) => a.active !== false
        && (plan.review.by === 'codex' || plan.review.by === a.id)
        && org.departments.some((d) => d.id === a.department && d.active !== false && d.engine === 'codex' && codexRole(d) === 'review'));
      if (!cached && plan.review?.by && plan.review.by !== 'chief' && !reviewers.length
          && !(plan.review.by === 'codex' && run.engine === 'codex')) return ask([{ phase: 'plan', question: '요청한 전문 검토 직원이 근무 중이 아닙니다. 비서실장 검토로 진행할지 알려 주세요.' }]);
      const evidence = cached ? [...cached.evidence] : [];
      for (const reviewer of reviewers) {
        const text = await execute({ phase: 'reviewer', agentId: reviewer.id, readOnly: true,
          prompt: `outputs/${task}/ 산출물과 plan.json을 읽기 전용으로 검토하세요. 첫 줄은 VERDICT: PASS|FIX|BLOCK입니다.` });
        checkStop();
        const verdict = parseVerdict(text);
        mkdirSync(join(taskDir, 'reviews'), { recursive: true });
        writeFileAtomic(join(taskDir, 'reviews', `${reviewer.id}.md`), text);
        evidence.push({ reviewer: reviewer.id, verdict, text });
      }
      let review = cached?.review || parseObject(await execute({ phase: 'review', prompt: [
        '비서실장으로서 산출물을 읽기 전용으로 검토하세요. JSON만 응답하세요.',
        '{verdict:"pass"|"reject"|"block"|"question",stage:"수정할 단계 id 또는 빈 문자열",reason:"근거",report:"보고서 Markdown",question:"질문 또는 빈 문자열"}',
        `계획: ${JSON.stringify(plan)}`, `검증실 결과: ${JSON.stringify(evidence)}`,
        context(), HTML_BRIEF,
        `외부 작업 형식 검사: ${JSON.stringify(prepared.errors)}. 메일 문안은 수신자·출처·본문이 대표 지시와 맞는지 확인하세요. 아직 실제 전송 전이므로 보고서에서 발송·게시 완료로 쓰지 마세요. 실행기가 실제 결과를 별도로 붙입니다.`,
        `outputs/${task}/review-notes.md가 있으면 추가 검증 근거를 읽고 산출물·이미지와 대조하세요.`,
        '당신이 최종 검토자입니다. 별도 검증실 부재는 공백이 아니므로 대체 검토 알림을 만들지 마세요. 요청한 전문 검토에 FIX/BLOCK/ERROR가 있거나 산출물이 없으면 pass를 내리지 마세요. 보고서에는 결과·산출물 경로·근거·확인 필요·실제 역량 공백을 포함하세요.',
      ].join('\n\n') }));
      checkStop();
      if (review.verdict === 'pass' && prepared.errors.length) review = { verdict: 'reject', stage: prepared.errors[0].stage, reason: prepared.errors.map((e) => e.reason).join(' ') };
      if (review.verdict === 'question' && review.question?.trim()) return ask([{ phase: 'review', question: review.question }]);
      if (review.verdict === 'pass' && evidence.every((e) => e.verdict === 'PASS')
          && plan.stages.every((s) => fingerprint(s) === state.completed[s.id])) {
        if (typeof review.report !== 'string' || !review.report.trim()) throw new Error('검토 보고서가 비어 있습니다.');
        state.approvedReview = { signature: reviewSignature, review, evidence }; persist();
        const publications = [];
        let posted = 0;
        if (allowedActions().length && !(plan.publications || []).length) return ask([{ phase: 'plan', question: '요청하신 외부 작업의 대상·계정·본문을 계획에서 확인하지 못했습니다. 계정 연결과 대상 주소를 확인해 주세요.' }]);
        for (const { publication, body, source: content } of prepared.jobs) {
          if (!outbound) return ask([{ phase: 'plan', question: '외부 작업을 위해 계정 연결을 먼저 완료해 주세요.' }]);
          const instance = `${run.id}-publish-${publication.id || publications.length}`;
          const engine = org.departments.find((d) => d.id === org.roster.find((a) => a.id === publication.agent)?.department)?.engine || 'claude';
          emit('agent.start', { engine, agent: publication.agent, instance, summary: '검토된 원문의 브라우저 업무를 시작합니다.' });
          try {
            const result = await outbound.deliver({ scope: run.rootId, publication, body, allowedActions: allowedActions(), instructionKey: instructionKey(), ...policy(), schedule: videoPolicy, signal,
              execute: async (browser) => {
                const text = await execute({ phase: 'publish', agentId: publication.agent, browser,
                prompt: ['대표가 이번 업무에서 지시하고 비서실장이 검토한 외부 작업을 실행합니다. 아래 원문의 내용과 대상을 바꾸지 마세요.',
                  `작업: ${JSON.stringify({ ...publication, content: undefined })}`, `본문 파일: ${content}`,
                  'office_browser 도구만 사용해 사이트의 화면을 읽고 조작하세요. 쿠키·비밀번호·로그인 코드·개인 프로필 파일을 읽거나 출력하지 않습니다.',
                  'browser_snapshot의 ref를 사용하고 제목/수신자/본문은 browser_fill_content로 입력합니다. 마지막 발송·발행·등록은 browser_submit으로만 실행합니다.',
                  '전송 완료 또는 실제 게시된 본문을 확인해 browser_finish로 증표를 만든 뒤 status:done JSON으로 보고하세요. 로그인/추가 인증/쓰기 권한이 필요하면 status:needs_decision과 질문을 반환하세요.',
                  '이메일·글·댓글 작성 외의 삭제·결제·계정 변경은 하지 않습니다. 결과가 불확실한 전송을 다시 누르지 마세요.',
                ].join('\n\n') });
                const result = stageResult(text);
                if (result.status === 'needs_decision') throw new Error(result.question || '외부 작업에 필요한 계정·권한을 확인해 주세요.');
                return text;
              } });
            publications.push(`- ${publication.service} ${publication.action}: ${result.confirmedBy === 'user' ? '사용자 확인 완료' : '브라우저 확인 완료'}${result.resultUrl ? ` · ${result.resultUrl}` : ''}`);
            if (publication.action === 'post') posted++;
            emit('agent.stop', { engine, agent: publication.agent, instance, summary: '실제 외부 작업 결과를 확인했습니다.' });
          } catch (error) {
            checkStop();
            if (error.code === 'VIDEO_DUPLICATE') { prepared.skipped.push(error.message); emit('agent.stop', { engine, agent: publication.agent, instance, summary: '중복 또는 오늘 게시 한도에 따라 제외했습니다.' }); continue; }
            emit('agent.pause', { engine, agent: publication.agent, instance, summary: redactContext(error.message) });
            return ask([{ phase: 'publish', question: `외부 작업을 이어가기 위한 확인이 필요합니다. ${redactContext(error.message)}` }]);
          }
        }
        const report = review.report + ((plan.publications || []).length ? '\n\n## 외부 작업 결과\n\n' + (publications.join('\n') || '- 실제 발송·게시 0건: 확인된 대상이 없습니다.')
          + (videoPolicy ? `\n\n영상 게시 ${posted}건 / 목표 ${videoPolicy.minPosts}~${videoPolicy.maxPosts}건.${posted < videoPolicy.minPosts ? ' 조건에 맞는 중복 없는 새 영상이 부족해 목표 수를 채우지 않았습니다.' : ''}` : '')
          + (prepared.skipped.length ? '\n\n확인 필요:\n' + prepared.skipped.map((s) => '- ' + redactContext(s)).join('\n') : '') : '');
        writeFileAtomic(join(taskDir, 'report.md'), report);
        try { collectFinalOutputs(root, { task, title: loadTasks(root).find((t) => t.id === task)?.title || plan.goal, plan }); }
        catch (error) { return ask([{ phase: 'deliver', question: `최종산출물을 저장하지 못했습니다. 회사 설정의 저장 위치·폴더 권한을 확인한 뒤 이어서 재개해 주세요. ${redactContext(error.message)}` }]); }
        emit('flow.review', { verdict: 'pass', summary: redact(review.reason) });
        completeTask(root, task);
        state.delivered = true;
        persist();
        emit('flow.deliver', { summary: '최종 검토를 마쳐 업무를 완료하고 결과를 전달했습니다.' });
        return report;
      }
      if (review.verdict !== 'reject' || state.rejects >= 2) return blocked(`검토를 완료하지 못했습니다. ${review.reason || '판정 또는 산출물을 확인해 주세요.'}`);
      const stage = plan.stages.find((s) => s.id === review.stage);
      if (!stage) return blocked('반려할 단계가 명확하지 않습니다. ' + (review.reason || ''));
      state.rejects++;
      state.rejectionReason = String(review.reason || '검토 지적을 수정하세요.');
      clearDependents(new Set([stage.id]));
      persist();
      emit('flow.review', { verdict: 'reject', to: stage.dept, target: stage.agent, stage: stage.id, summary: redact(state.rejectionReason) });
    }
  } catch (err) {
    checkStop();
    return blocked(`업무 진행이 중단됐습니다. ${err.message}`);
  }
}
