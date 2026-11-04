// Codex 비서실장은 계획·검토만 한다. 배정·재시도·반려 한도·인계는 프로그램이 진행한다.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadOrg, writeFileAtomic } from '../lib/org.mjs';
import { buildOrgMap } from '../lib/orgmap.mjs';
import { validatePlan, compactPlan, normalizePlanInputs } from '../lib/plan.mjs';
import { appendEvent, redact, redactContext } from '../lib/events.mjs';
import { loadTasks, updateTask, completeTask } from '../lib/tasks.mjs';
import { insideRel } from '../lib/outputs.mjs';
import { codexRole, loadSettings } from '../lib/settings.mjs';
import { parseVerdict } from '../scripts/codex-review.mjs';
import { stageResult, outputIssues, HTML_BRIEF } from '../lib/work-result.mjs';
import { programRoot } from '../lib/paths.mjs';
import { BUDGET_WARN_RATIO, MAX_MAILS_PER_RUN, MAX_PLAN_REVISIONS, MAX_PROGRESS_CHECKS, externalActionPolicy, isDraftOnly } from '../lib/guardrails.mjs';
import { mailKey, preparePublications, splitMailBatch } from '../lib/publications.mjs';
import { attachmentQuestion, attachmentRef, pickChoices, resolveAttachments } from '../lib/attachments.mjs';
import { collectFinalOutputs } from '../lib/final-outputs.mjs';
import { judgeAnswer } from '../lib/intent.mjs';
import { CONNECTION_PROVIDERS, serviceProvider } from '../lib/connections.mjs';

const ACTION_LABEL = { mail: '메일 발송', post: '글 게시', comment: '댓글 등록', web: '웹사이트 작업' };

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

export async function orchestrate({ root, run, prompt, execute: runAI, signal, maxParallel = 4, resume = false, onDecision = () => {}, outbound = null, intent = null, judge = null, home = homedir() }) {
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
    rejects: saved.delivered ? 0 : saved.rejects || 0,
    // 진행 점검·계획 수정 횟수는 대표 피드백으로 새로 시작할 때 다시 센다. 수정 이력은 남긴다
    progressChecks: saved.delivered ? 0 : saved.progressChecks || 0, revisionCount: saved.delivered ? 0 : saved.revisionCount || 0,
    revisions: [...(saved.revisions || [])],
    // 메일 20통 단위 발송: 보낸 메일(내용 기준)은 대화 내내 기억하고, 허용 통수·남은 메일 거절은 대표 피드백으로 새로 시작할 때 다시 정한다
    mailSent: { ...(saved.mailSent || {}) }, ...(saved.delivered ? { mailAllowance: null, mailDeclined: false } : {}) };
  // 업무 예산(guardrails): AI 호출 수·작업 시간. 대표 피드백으로 새로 시작하면 다시 센다. 답장을 기다린 시간은 세지 않는다
  const unattended = Boolean(run.schedule || run.monitorId);
  if (!saved.budget || saved.delivered) {
    const { calls, minutes } = loadSettings(root).budget;
    state.budget = { calls: 0, activeMs: 0, limitCalls: calls, limitMs: minutes * 60000, stepCalls: calls, stepMs: minutes * 60000 };
  } else state.budget = { ...saved.budget };
  const sessionStart = Date.now(), activeBase = state.budget.activeMs;
  const activeMs = () => activeBase + (Date.now() - sessionStart);
  const execute = (args) => { state.budget.calls++; return runAI(args); };
  // 최초 지시의 외부 작업·위임 판별(지시창에서 AI가 근거와 함께 판단한 값)은 업무 내내 유지한다
  if (!saved.originalRequest && intent) state.intent = intent;
  let answer = null;
  if (saved.originalRequest && !resume) {
    // 대표 답장의 뜻은 AI가 판별한다(실패하면 규칙). 일반 웹사이트 작업 확인 답장도 같은 판별을 쓴다
    answer = await judgeAnswer(prompt, saved.pending || [], { judge });
    if (saved.pending?.some((q) => q.phase === 'web-confirm')) state.webDecision = answer.decision === 'decline' ? 'declined'
      : answer.decision === 'approve' || answer.delegated ? 'approved' : state.webDecision;
    // 남은 메일 확인 답장: "진행"이면 다음 20통을 허용하고, "하지 마"면 남은 메일은 보내지 않고 보고한다
    if (saved.pending?.some((q) => q.phase === 'mail-more')) {
      if (answer.decision === 'decline') state.mailDeclined = true;
      else if (answer.decision === 'approve' || answer.delegated) state.mailAllowance = (state.mailAllowance || 0) + MAX_MAILS_PER_RUN;
    }
    // 첨부 파일 확인 답장: 후보 번호("1번")를 고르면 그 파일로 확정한다. 경로를 적은 답장은 원문으로 다시 찾는다
    if (saved.pending?.some((q) => q.phase === 'attachment')) {
      state.attachmentChoices = { ...(state.attachmentChoices || {}), ...pickChoices(prompt, state.attachmentAsk) };
      state.attachmentAsk = {};
    }
    // 예산 확인 답장: "그만"이면 멈추고, 그 밖에는 처음 예산만큼 늘려 이어 간다
    if (saved.pending?.some((q) => q.phase === 'budget')) {
      if (answer.decision === 'decline') state.budgetStop = true;
      else { state.budget.limitCalls += state.budget.stepCalls; state.budget.limitMs += state.budget.stepMs; }
    }
    // 외부 작업 확인 답장: "진행"은 물어본 작업만 허용하고, "하지 마"면 초안까지만 만든다. 다른 답이면 계획 때 다시 묻는다
    const askedActions = (saved.pending || []).filter((q) => q.phase === 'action-confirm').flatMap((q) => q.actions || []);
    if (askedActions.length) {
      if (answer.decision === 'decline') state.declinedActions = [...new Set([...(state.declinedActions || []), ...askedActions])];
      else if (answer.decision === 'approve' || answer.delegated) {
        // 규칙 판별로 돌던 업무도 답장 허용이 이어지도록 지금 허용을 판별 값으로 옮긴다
        if (!state.intent) {
          const { actions, delegated } = externalActionPolicy([state.originalRequest, ...state.decisions.map((d) => d.answer)]);
          state.intent = { actions, delegated };
        }
        answer.add = [...new Set([...answer.add, ...askedActions])];
        state.declinedActions = (state.declinedActions || []).filter((action) => !askedActions.includes(action));
      }
    }
    state.decisions.push({ questions: saved.pending || [], answer: redactContext(prompt), intent: answer });
    state.pending = [];
  }
  const context = () => `대표 최초 요청:\n${state.originalRequest}\n\n추가 지시·결정:\n${JSON.stringify(state.decisions)}\n\n${videoBrief}`;
  const instructionKey = () => createHash('sha256').update(JSON.stringify([state.originalRequest, state.decisions])).digest('hex');
  // 외부 작업 허용: 판별 결과가 있으면 그것을, 없으면(예전 업무·판별 실패) 문장 규칙을 쓴다. 재발송·결과 확인 문구는 규칙 유지
  const policy = () => {
    const base = externalActionPolicy([state.originalRequest, ...state.decisions.map((d) => d.answer)]);
    if (!state.intent) return base;
    const actions = new Set(state.intent.actions);
    let delegated = state.intent.delegated === true;
    for (const d of state.decisions) {
      const judged = d.intent || { add: externalActionPolicy([d.answer]).actions, remove: [], delegated: externalActionPolicy([d.answer]).delegated };
      (judged.add || []).forEach((a) => actions.add(a)); (judged.remove || []).forEach((a) => actions.delete(a));
      delegated ||= judged.delegated === true;
    }
    return { ...base, actions: [...actions], delegated };
  };
  const allowedActions = () => policy().actions;
  const persist = () => {
    state.budget.activeMs = activeMs();
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
  if (state.budgetStop) {
    state.budgetStop = false;
    return blocked('대표 결정으로 업무를 멈췄습니다. 지금까지의 산출물은 업무 폴더에 남아 있습니다. 이어서 하려면 "이어서 해줘"라고 지시해 주세요.');
  }
  // 예산 점검: 80%를 쓰면 대표에게 계속할지 묻는다. 대표가 없는 예약·상시 감시 업무는 묻지 않고 100%에서 이 주기만 멈춘다
  const budgetText = () => `AI 호출 ${state.budget.calls}/${state.budget.limitCalls}회, 작업 ${Math.round(activeMs() / 60000)}/${Math.round(state.budget.limitMs / 60000)}분`;
  const overBudget = () => {
    const ratio = Math.max(state.budget.calls / state.budget.limitCalls, activeMs() / state.budget.limitMs);
    if (unattended) return ratio >= 1 ? blocked(`이번 회차 업무가 예산을 모두 써서 멈췄습니다(${budgetText()}). 다음 회차는 새 예산으로 진행합니다. 예산은 회사 설정에서 바꿀 수 있습니다.`) : null;
    if (ratio < BUDGET_WARN_RATIO) return null;
    return ask([{ phase: 'budget', question: `이 업무가 예산의 ${Math.min(999, Math.round(ratio * 100))}%를 썼습니다(${budgetText()}). 계속할까요? "계속"이면 처음 예산만큼 늘려 이어 가고, "그만"이면 지금까지의 결과로 멈춥니다.` }]);
  };
  const budgetLeft = () => `남은 예산: AI 호출 ${Math.max(0, state.budget.limitCalls - state.budget.calls)}회, 작업 ${Math.max(0, Math.round((state.budget.limitMs - activeMs()) / 60000))}분. 예산 안에서 반려·재배정·계획 수정 여부를 스스로 정하세요.`;
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
  // 외부 작업·전달 대상의 파일 경로를 단계 id로 맞추고, 메일 대상 주소가 비었으면 서비스 기본 주소로 채운다
  const normalizeRefs = (candidate) => {
    const ref = (value) => candidate.stages.find((s) => s.id === value || outputPath(s.output) === outputPath(value))?.id || value;
    return { ...candidate,
      ...(candidate.publications ? { publications: candidate.publications.map((publication) => ({ ...publication,
        ...(publication.action === 'mail' && !publication.target ? { target: CONNECTION_PROVIDERS[serviceProvider(publication.service)]?.loginUrl || publication.target } : {}),
        content: ref(publication.content),
        ...(Array.isArray(publication.files) ? { files: publication.files.map(ref) } : {}) })) } : {}),
      ...(candidate.deliverables ? { deliverables: candidate.deliverables.map(ref) } : {}) };
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
      '연결된 일반 웹사이트(관리자 화면 등)에서 자료를 조회·추출해야 하는 단계는 stage.connection에 그 연결 계정 id, stage.target에 시작 주소(대표가 준 링크 또는 연결의 시작 주소)를 넣으세요. 담당 직원이 읽기 전용 브라우저로 조회해 output 파일에 정리합니다. 이 단계에서는 그 연결 사이트 안의 화면만 볼 수 있고 웹 검색이나 다른 사이트(영상·기사·공개 자료 등)는 열 수 없습니다(로그인된 화면 내용이 밖으로 새지 않게). 다른 공개 웹 자료가 필요하면 connection 없는 별도 단계로 나누고 사이트 조회 결과를 inputs로 받게 하세요. 대표가 링크를 주면 허용 도메인이 맞는 연결 계정을 고르세요. 그 밖의 단계는 connection·target을 빈 문자열로 둡니다. done에는 대표가 요구한 항목과 그 목적(예: 연락하려면 연락처)에 필요한 항목을 빠짐없이 넣으세요. 대표가 조사·참고 범위를 정했으면(특정 회원의 글만, 특정 메뉴만 등) 그 범위 밖의 조회(공지·규칙·다른 게시판 둘러보기 등)는 done에 넣지 마세요. 글을 올릴 곳은 대표가 준 주소나 참고한 자료(예: 참고한 글이 있는 게시판)에서 정합니다.',
      '앞 단계 id를 inputs와 dependsOn에 넣으세요. report/summary/findings/analysis로 시작하는 .md 이름은 쓰지 마세요.',
      `파일 조회 기준 폴더는 작업 공간 ${root}입니다. .office/… 등 요청의 상대 원본 경로는 작업 공간 기준입니다. inputs에는 앞 단계 id 또는 작업 공간 내부 원본의 절대 경로를 쓰세요. 기존 업무 상대 입력도 지원합니다. 파일 부재를 묻기 전에 Read/Glob으로 작업 공간과 업무 폴더를 확인하세요. 경로 검사 실패는 먼저 계획을 수정하고 실제로 있는 원본의 복구를 대표에게 요구하지 마세요.`,
      'plan.goal은 업무를 알아보기 쉬운 짧은 한국어 이름으로 쓰세요(최종산출물 폴더 이름이 됩니다). 대표에게 전달할 단계의 title은 대표가 받는 파일 이름이 됩니다. 내용을 바로 알 수 있는 한국어 이름으로 지으세요(예: 업무 내용·대상·조건이 드러나게). 작업 파일 output 이름은 지금 규칙대로 둡니다.',
      'plan.deliverables에는 대표에게 최종 전달할 단계 id를 고르세요. 최종 HTML·문서·첨부 등 요청 결과만 포함하고 계획·중간 조사·검토용 문안은 제외하세요. 별도 첨부가 없으면 []. 실행기가 검토 후 최종산출물/날짜/업무명 폴더로 모읍니다.',
      '대표가 요청한 범위와 결과물만 계획하세요. 속도가 중요합니다. 자료 수집·뉴스 찾기는 대표가 말한 건수만 해당 부서 실무 직원 한 명의 한 단계로 끝냅니다(팀장 배정, 건수를 넘는 후보 수집, 재검증·취합 단계를 더하지 않음). HTML·보고서는 대표가 요청했을 때만 만들고, 아니면 결과를 md 파일 하나로 전달합니다. done에는 제목·출처 링크·날짜·요약처럼 요청에 필요한 항목만 쓰고, 건수를 채우면 바로 끝내게 하세요. 교차 검증 같은 정밀 확인은 대표가 요청했거나 외부 제출·재무·법률 자료일 때만 넣습니다.',
      '담당이 없어도 자료 수집·조사·글 작성처럼 한 부서가 끝낼 수 있는 일은 회의 없이 그 부서에 바로 배정하세요(needsMeeting:false). 여러 부서가 함께 해야 하고 분담을 정하기 어려운 일만 needsMeeting:true와 meetingAgents(2~4명). 회의 제안이 주어졌으면 반영하고 needsMeeting:false.',
      '피드백이면 rerunStages에 수정할 단계 id만 넣으세요. 후속 단계는 프로그램이 다시 실행합니다.',
      '부서 팀장에게 배정하면 팀장은 구조화된 delegate 응답으로 같은 부서 직원에게 분담할 수 있습니다. 전달 부서의 필수/권장을 확인하세요.',
      'plan.publications는 대표가 지시한 외부 작업 배열입니다. 외부 작업이 없으면 []. 각 항목은 {id,action,service,connection,agent,target,recipients,subject,content,instructions,files,attachments}입니다.',
      'action은 mail/post/comment/web입니다. mail/post/comment의 service는 naverworks_mail/naver_blog/naver_cafe/daum_cafe/tistory/brunch이고, content에는 검토할 본문 산출물 단계 id 또는 파일 경로를 씁니다. 메일은 recipients 배열을 채우고, 글은 target에 해당 블로그/게시판/댓글 원문 주소를 지정하세요. 이때 instructions는 빈 문자열, files는 []입니다.',
      '대표가 메일에 파일을 첨부하라고 했으면 그 메일의 attachments에 대표가 쓴 파일 이름이나 경로를 글자 그대로 적으세요(예: ["제휴제안서.pdf"]). 파일을 직접 찾거나 열지 마세요. 실행기가 작업 공간(보관함 포함)·다운로드·문서·데스크톱에서 찾아 모든 수신자 메일에 같은 파일로 붙이고, 못 찾거나 같은 이름이 여러 개면 대표에게 묻습니다. 첨부 지시가 없거나 메일이 아니면 attachments는 []입니다.',
      'web은 연결 계정의 일반 웹사이트(관리자 화면 등)에서 하는 작업입니다. service "web", connection에 연결된 일반 웹사이트 계정 id, target에 시작 화면 주소, instructions에 직원이 그 사이트에서 할 일(대표 지시 그대로 구체적으로), files에 첨부할 단계 id(예: 업로드할 HTML 산출물)를 씁니다. subject·content는 빈 문자열, recipients는 []입니다. 연결된 일반 웹사이트 계정이 없으면 connection을 빈 문자열로 두세요.',
      '글·댓글 하나를 올리는 것처럼 단순한 게시 업무는 조사·작성·게시를 같은 직원 한 명에게 맡기세요(단계마다 직원을 바꾸지 않음). 여러 부서의 전문성이 필요한 업무만 나눕니다.',
      '실제 외부 작업은 산출물 작성과 비서실장 검토를 마친 뒤 실행기가 브라우저로 진행합니다. 로그인 정보는 요청하거나 파일에 적지 마세요. 계정이 없으면 connection은 빈 문자열로 두고 자료 준비를 먼저 진행합니다. 연결 계정이 여러 개면 사용할 계정을 확인하세요.',
      `제휴업체 조사 후 주소를 알아내는 메일 업무는 조사 단계 다음에 개인별 발송 문안 JSON 단계를 두세요. {messages:[{recipients:["회사 메일"],subject:"제목",body:"양식을 채운 본문"}],skipped:["연락처 미확인 업체·이유"]}를 작성하고 publication.content에 그 단계 id, recipients에는 []를 씁니다. 검토 후 실행기가 문안별로 발송합니다. 대량 발송을 막기 위해 메일은 한 번에 ${MAX_MAILS_PER_RUN}통까지만 보내고 남은 메일은 대표에게 다시 확인받아 이어 보내므로, messages에는 확인한 대상을 모두 적으세요. 주소·출처를 확인하지 못한 업체에는 보내지 않습니다.`,
      '여러 게시글은 검토할 본문 JSON 단계에 {posts:[{subject,body,target}],skipped:[사유]}를 작성하고 publication.content에 그 단계 id를 지정하세요. 실행기가 글마다 별도로 게시합니다. 올릴 게시판이 앞 단계(사이트 조회 등)에서 정해지면 그 게시판 주소(대표가 준 주소와 같은 사이트)를 target에 넣게 하세요. 비우면 publication.target에 올립니다. 유튜브 링크의 영상 ID는 작업 공간 공통 이력과 대조해 재게시를 차단합니다.',
      `대표가 허용한 외부 작업: ${JSON.stringify(allowedActions())}. 초안만 요청한 업무를 외부에 게시하지 마세요.`,
      '대표가 이 목록에 없는 외부 작업의 실제 실행(글 올리기·업로드, 메일 발송, 댓글, 사이트 등록)을 시킨 것으로 보이면 초안으로 끝내거나 gaps에 적지 말고 plan은 null, requestedActions에 해당 action(mail/post/comment/web)을 넣어 응답하세요. 실행기가 대표에게 확인합니다. 조회·조사·작성만 시킨 업무면 requestedActions는 []입니다.',
      state.declinedActions?.length ? `대표가 확인 질문에서 거절한 외부 작업: ${JSON.stringify(state.declinedActions)}. publications와 requestedActions에 넣지 말고 초안까지만 만드세요.` : '',
      'plan.gaps는 필요한 역량의 근무중 직원·부서가 없을 때만 씁니다. 외부 작업 허용·계정 연결·로그인 부족은 실행기가 따로 확인하므로 gaps에 적지 마세요.',
      `연결된 계정: ${JSON.stringify(outbound?.connections() || [])}`,
      HTML_BRIEF,
      buildOrgMap(org), `대표 요청:\n${context()}`, saved.plan ? `이전 계획과 완료 상태:\n${JSON.stringify({ plan: saved.plan, completed: saved.completed })}` : '', extra,
    ].filter(Boolean).join('\n\n') });
    checkStop();
    return parseObject(text);
  };
  // 계획이 허용되지 않은 외부 작업을 요구하면 초안으로 조용히 끝내지 않고, 작업을 시작하기 전에 대표에게 묻는다.
  // 권한은 대표 답장으로만 생긴다. "초안만"이거나 이미 거절한 작업은 묻지 않고 기존 계획 검사로 막는다
  const confirmActions = (candidate) => {
    if (isDraftOnly(state.originalRequest)) return null;
    const wanted = [...new Set([...(Array.isArray(candidate.requestedActions) ? candidate.requestedActions : []),
      ...(candidate.plan?.publications || []).map((p) => p?.action)])]
      .filter((action) => ACTION_LABEL[action] && !allowedActions().includes(action) && !state.declinedActions?.includes(action));
    if (!wanted.length) return null;
    return ask([{ phase: 'action-confirm', actions: wanted, question: `이 지시는 ${wanted.map((action) => ACTION_LABEL[action]).join('·')} 실행까지 맡기신 것으로 보이지만 확정하지 못했습니다. 실제로 실행할까요? "진행"이면 필요한 계정부터 확인하고, "하지 마"면 초안까지만 만듭니다.` }]);
  };
  checkStop();
  let response;
  let plan;
  const publicationCorrection = answering && saved.pending?.some((q) => q.phase === 'publish')
    && (answer?.source === 'ai' ? ['modify', 'decline'].includes(answer.decision) : /수정|변경|바꿔|초안|수신자|하지\s*마/.test(prompt));
  // 옛 실행기는 검토 후 브라우저·전달 오류도 plan 질문으로 저장했다.
  // 명시 재개라면 승인된 계획을 재검사하며 완료 파일·검토를 재사용한다.
  // 계정이 비어 있던 계획은 계정을 등록한 뒤 다시 세워 새 계정을 쓰게 한다
  const accountReplan = answering && saved.pending?.some((q) => q.phase === 'account' && q.replan);
  // 외부 작업 확인 뒤에는 바뀐 허용 범위로 계획을 다시 세운다
  const actionReplan = answering && saved.pending?.some((q) => q.phase === 'action-confirm');
  if ((resume || answering) && saved.plan && !publicationCorrection && !accountReplan && !actionReplan
      && (resume && saved.approvedReview || !saved.pending?.some((q) => q.phase === 'plan'))) {
    response = { plan: saved.plan, rerunStages: [] };
    plan = saved.plan;
  } else {
    let error = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await planning(error);
        const confirmAsked = confirmActions(response);
        if (confirmAsked) return confirmAsked;
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
          const confirmAfterMeeting = confirmActions(response);
          if (confirmAfterMeeting) return confirmAfterMeeting;
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
  plan = normalizeRefs(plan);
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
  // 필요한 계정은 작업 전에 확인한다(조사·작성을 다 마친 뒤 마지막 게시 단계에서야 묻지 않게)
  {
    const list = outbound?.connections?.() || [];
    // 첫 로그인은 대표가 직접 한다: 연결됨이거나, 직접 로그인한 적이 있고 다시 로그인할 정보가 있을 때만 바로 쓸 수 있다
    const usable = (c) => Boolean(c) && (c.status === 'connected' || c.hasCredentials === true && c.firstLoginDone === true);
    const needs = [];
    let replan = false;
    for (const p of plan.publications || []) {
      if (!allowedActions().includes(p.action)) continue;
      if (p.action === 'web') {
        const chosen = list.find((c) => c.id === p.connection);
        if (!usable(chosen)) { needs.push(`${p.target} 웹사이트 작업용 계정`); replan ||= !chosen; }
        continue;
      }
      const provider = serviceProvider(p.service), name = CONNECTION_PROVIDERS[provider]?.name || p.service;
      const candidates = list.filter((c) => c.provider === provider);
      const chosen = p.connection ? list.find((c) => c.id === p.connection) : candidates.length === 1 ? candidates[0] : null;
      if (!chosen && candidates.length > 1) needs.push(`${name} 계정 ${candidates.length}개 중 사용할 계정(답장에 계정 이름을 적어 주세요)`);
      else if (!usable(chosen)) needs.push(`${name} 계정`);
    }
    for (const stage of plan.stages) {
      if (typeof stage.connection !== 'string' || !stage.connection.trim()) continue;
      const chosen = list.find((c) => c.id === stage.connection);
      if (!usable(chosen)) { needs.push(`${stage.target} 조회용 계정`); replan ||= !chosen; }
    }
    if (needs.length) return ask([{ phase: 'account', replan, question: `이 업무에는 다음 계정이 필요합니다: ${[...new Set(needs)].join(', ')}. 보관함/계정.env에 사이트 주소·아이디·비밀번호를 적거나 상단 '계정 연결'에서 계정을 추가한 뒤, '로그인 창 열기'로 처음 한 번 직접 로그인하고 "이어서 재개"라고 답해 주세요. 로그인을 마치면 창은 자동으로 닫힙니다.` }]);
  }
  // 메일 첨부: 대표가 지시문에 적은 파일을 서버가 찾는다(AI는 이름만 적음). 못 찾거나 여러 개면 조사·발송 전에 대표에게 묻는다
  const mailAttachmentRefs = () => [...new Set((plan.publications || []).filter((p) => p.action === 'mail' && allowedActions().includes('mail')).flatMap((p) => (p.attachments || []).map(attachmentRef)).filter(Boolean))];
  const resolveMailAttachments = () => {
    const refs = mailAttachmentRefs();
    if (!refs.length) return null;
    const result = resolveAttachments(refs, { text: [state.originalRequest, ...state.decisions.map((d) => d.answer)].join('\n'), root, home, chosen: state.attachmentChoices || {} });
    state.attachmentChoices = { ...(state.attachmentChoices || {}), ...Object.fromEntries(result.files.map((f) => [f.ref, f.path])) };
    if (!result.problems.length) { persist(); return null; }
    state.attachmentAsk = Object.fromEntries(result.problems.filter((p) => p.candidates.length).map((p) => [p.ref, p.candidates]));
    return ask([{ phase: 'attachment', question: attachmentQuestion(result.problems, home) }]);
  };
  // 확정하지 못한 첨부가 하나라도 있으면 첨부 없이 보내지 않는다
  const mailFiles = (publication) => (publication.attachments || []).map(attachmentRef).filter(Boolean).map((ref) => {
    const path = state.attachmentChoices?.[ref];
    if (!path) throw new Error(`첨부 파일 "${ref}"을(를) 확정하지 못해 메일을 보내지 않았습니다.`);
    return { name: basename(path), path };
  });
  {
    const asked = resolveMailAttachments();
    if (asked) return asked;
  }
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
    const site = typeof stage.connection === 'string' && stage.connection.trim();
    // 사이트 조회 단계는 연결 계정 브라우저(읽기 전용)를 붙여 실행한다
    const runStage = (args) => !site ? execute(args)
      : outbound?.browse ? outbound.browse({ connection: stage.connection, target: stage.target, signal, execute: (browser) => execute({ ...args, browser }) })
        : Promise.reject(Object.assign(new Error('사이트 조회를 위해 계정 연결을 먼저 완료해 주세요.'), { code: 'CONNECTION_REQUIRED' }));
    for (let attempt = 0; attempt < 2; attempt++) {
      checkStop();
      safeOutput(stage.output, true);
      const inputs = (stage.inputs || []).map((input) => plan.stages.find((s) => s.id === input)?.output || input);
      try {
        // 직원 지시: 목표 → 입력·출력·완료 기준 → 이 단계 안내 → 응답 형식 → 안전선 순서로 묶는다
        const html = /\.html?$/i.test(stage.output);
        const mailDraft = (plan.publications || []).some((p) => p.action === 'mail' && (p.content === stage.id || p.content === stage.output) && !p.recipients.length);
        const guide = [
          site ? `사이트 조회: 연결 계정 브라우저(office_browser 도구)로 ${stage.target}에서 시작해 필요한 자료를 조회하세요. 읽기 전용이라 저장·등록·수정·삭제는 하지 않습니다. 대표 요청의 의도에 맞는 메뉴·탭·필터를 사이트를 둘러보며 스스로 찾아 쓰고(대표가 범위를 정했으면 그 범위의 자료만 엽니다. 예: 특정 회원의 글이면 작성자 검색·필터를 먼저 쓰고 공지·다른 게시판은 열지 않음), 목록은 browser_text의 offset으로 끝까지 읽으세요. 결과는 출력 파일에 직접 작성하고, 대표가 요구한 항목(연락처 등)은 빠뜨리지 마세요. 조건에 맞는 항목이 없으면 그 사실과 확인한 화면·조건을 출력 파일에 적으세요. 이 단계에서는 연결 사이트 밖(웹 검색·다른 사이트)은 볼 수 없습니다. 그런 자료는 다른 단계가 맡으니 사이트 안 자료만 정리하고, 사이트 밖 자료가 없다는 이유로 대표에게 묻지 마세요.` : '',
          mailDraft ? '이번 산출물은 메일 문안 JSON입니다. 입력 조사 자료의 회사별 연락처·출처를 확인하고 대표 양식을 채운 messages:[{recipients:[주소],subject,body}]와 skipped:[미확인 업체·이유]를 작성하세요. 실제 메일은 지금 보내지 않습니다.' : '',
          html ? `${HTML_BRIEF}\nHTML 보고서 기본 양식: ${join(programRoot(), 'org/templates/report.html')}. 읽어서 정보 구조·스타일을 참고하고 업무에 맞게 작성하세요. {{REPORT_*}} 빈 항목은 모두 채우거나 불필요한 섹션과 함께 제거하세요. 근거가 없으면 꾸미기 위해 숫자·차트를 만들지 마세요.` : '',
          state.delegated[stage.id] ? '부서 직원의 분담 결과를 입력에서 읽고 취합하세요. 이미 분담했으므로 다시 delegate하지 마세요.' : '',
          issue ? `앞 실행의 산출물 검사 실패: ${issue}. 수정하여 지정된 파일을 작성하세요.` : '',
          '완료 기준을 채우면 바로 끝내세요. 기준에 없는 추가 조사·확인은 하지 않습니다.',
        ].filter(Boolean);
        text = await runStage({ phase: 'stage', agentId: stage.agent,
        prompt: [
          // 첫 줄은 단계 제목(재작업이면 [반려]로 시작: 직원 지침의 재작업 규칙과 맞춘다)
          `${desc}\n\n## 목표·대표 요청\n업무: ${task}\n${context()}`,
          `## 입력·출력·완료 기준\n입력: ${JSON.stringify(inputs)}\n출력: ${stage.output}\n완료 기준: ${stage.done}${reason ? `\n반려 사유(모두 반영): ${reason}` : ''}`,
          guide.length ? `## 이 단계 안내\n${guide.join('\n')}` : '',
          `## 응답 형식\n마지막 응답은 JSON입니다. status=done(작성 완료), needs_decision(대표 결정), reroute(부서 오전달), delegate(팀장 분담). summary/question/department/agent/reason/assignments 필드를 쓰세요.\n`
            + '질문이 필요하면 산출물을 억지로 쓰지 말고 question에 원문을 적으세요. 오전달이면 적합한 department/agent와 reason을 제안하세요.\n'
            + `팀장만 같은 부서의 근무중 직원에게 assignments:[{agent,title,output,done}]로 분담할 수 있습니다. 실행기는 분담 결과를 모아 팀장에게 다시 전달합니다. 직접 다른 직원을 호출하지 마세요.\n`
            + `부서 근무중 실행 직원: ${JSON.stringify(org.roster.filter((a) => available(a.id, stage.dept)).map((a) => ({ id: a.id, name: a.name, lead: a.lead, role: a.role, specialty: a.specialty || a.description })))}`,
          '## 안전선\n출력 파일에만 쓰고 업무 폴더 밖은 고치지 않습니다. 메일 발송·글/댓글 게시·사이트 업로드는 이 단계에서 하지 않습니다(검토 뒤 실행기가 처리). 비밀번호·쿠키·계정 파일은 읽거나 옮겨 적지 않습니다.',
        ].filter(Boolean).join('\n\n') });
      } catch (err) {
        emit('agent.pause', { engine, agent: stage.agent, instance: `${run.id}-${stage.id}`, summary: redact(err.message) });
        // 계정 연결·사이트 접근 문제는 대표가 해결할 수 있게 질문으로 넘긴다
        if (site && !signal.aborted && ['CONNECTION_REQUIRED', 'BROWSER_ACTION'].includes(err.code)) return { stage, result: { status: 'needs_decision', question: redactContext(err.message) } };
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
    candidate = normalizeRefs(normalizePlanInputs(candidate, { root, taskId: task, fileExists: existsSync }));
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
    // 재배정 횟수는 고정하지 않고 업무 예산이 막는다
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
  // 진행 점검: 단계 묶음이 끝날 때마다 비서실장이 결과를 보고 남은 계획을 그대로 갈지, 고칠지, 대표에게 물을지 정한다
  // 수정·거부·건너뜀 이력은 최근 50건만 남긴다(대표 피드백이 반복돼도 체크포인트가 커지지 않게)
  const note = (entry) => { state.revisions = [...state.revisions, { at: new Date().toISOString(), ...entry }].slice(-50); persist(); };
  const applyRevision = (candidate, reason) => {
    if (state.revisionCount >= MAX_PLAN_REVISIONS) throw new Error(`계획 수정은 업무당 ${MAX_PLAN_REVISIONS}회까지입니다. 남은 계획대로 진행합니다.`);
    if (!candidate || !Array.isArray(candidate.stages)) throw new Error('수정한 계획이 비어 있습니다.');
    if ((candidate.publications || []).some((p) => !allowedActions().includes(p.action))) throw new Error('대표가 지시하지 않은 외부 작업은 계획에 넣을 수 없습니다.');
    const previous = plan;
    savePlan({ ...candidate, task });
    // 완료된 단계는 지우거나 바꾸지 않는다(다시 해야 하면 새 단계를 추가). 어기면 원래 계획으로 되돌린다
    const same = (id) => JSON.stringify(plan.stages.find((s) => s.id === id)) === JSON.stringify(previous.stages.find((s) => s.id === id));
    const broken = Object.keys(state.completed).filter((id) => previous.stages.some((s) => s.id === id) && !same(id));
    if (broken.length) { savePlan(previous); throw new Error(`완료된 단계(${broken.join(', ')})는 바꾸거나 지울 수 없습니다.`); }
    const before = new Set(previous.stages.map((s) => s.id)), after = new Set(plan.stages.map((s) => s.id));
    const changed = plan.stages.filter((s) => before.has(s.id) && !same(s.id)).map((s) => s.id);
    clearDependents(new Set(changed));
    state.revisionCount++;
    note({ reason: redactContext(String(reason || '')).slice(0, 500),
      added: [...after].filter((id) => !before.has(id)), removed: [...before].filter((id) => !after.has(id)), changed });
  };
  const progress = async (finished) => {
    if (state.progressChecks >= MAX_PROGRESS_CHECKS) return null;
    state.progressChecks++;
    persist();
    const decision = parseObject(await execute({ phase: 'progress', prompt: [
      '당신은 비서실장입니다. 방금 끝난 단계의 산출물을 읽기 전용으로 확인하고, 남은 계획을 그대로 진행할지 판단하세요. 직접 실무·파일 작성은 하지 말고 JSON만 응답하세요.',
      '{action:"continue"|"revise"|"question",reason:"판단 근거",question:"대표 질문 또는 빈 문자열",revisedPlan:"수정한 전체 계획 또는 null"}',
      'continue: 남은 단계를 그대로 진행합니다(기본). revisedPlan은 null.',
      `revise: 결과가 부족하거나 방향을 바꿔야 할 때만 쓰고, 단계를 추가·변경·취소한 전체 계획(계획 형식과 같음)을 revisedPlan에 주세요. 완료된 단계는 지우거나 바꾸지 말고 그대로 두며, 다시 해야 하면 새 단계를 추가하세요. 대표가 허용한 외부 작업만 publications에 둡니다. 남은 수정 가능 횟수: ${MAX_PLAN_REVISIONS - state.revisionCount}회.`,
      'question: 대표 결정 없이는 더 진행할 수 없을 때만 question에 한 번에 묶어 쓰세요. revisedPlan은 null.',
      `대표가 허용한 외부 작업: ${JSON.stringify(allowedActions())}`,
      buildOrgMap(org), context(),
      `현재 계획: ${JSON.stringify(plan)}`,
      `완료된 단계: ${JSON.stringify(Object.keys(state.completed))}`,
      `방금 끝난 단계 산출물: ${JSON.stringify(finished.map((stage) => ({ id: stage.id, output: stage.output })))}`,
      budgetLeft(),
    ].join('\n\n') }));
    checkStop();
    return decision;
  };
  try {
    const waiting = new Map();
    while (true) {
      while (plan.stages.some((s) => !state.completed[s.id])) {
        checkStop();
        const stop = overBudget();
        if (stop) return stop;
        const ready = plan.stages.filter((s) => !state.completed[s.id] && !waiting.has(s.id) && (s.dependsOn || []).every((id) => state.completed[id]));
        if (!ready.length) {
          if (waiting.size) return ask([...waiting.values()]);
          throw new Error('진행할 수 있는 계획 단계가 없습니다.');
        }
        const results = await Promise.all(ready.slice(0, Math.max(1, maxParallel)).map((s) => executeStage(s, state.rejectionReasons?.[s.id] || state.rejectionReason || '')));
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
        // 남은 단계가 있으면 비서실장이 결과를 보고 다음 행동을 정한다(마지막 묶음 뒤는 최종 검토가 맡음)
        const finished = results.filter((r) => r.result.status === 'done').map((r) => r.stage);
        if (finished.length && !waiting.size && plan.stages.some((s) => !state.completed[s.id])) {
          // 진행 점검은 보조 판단이다. 응답이 깨지거나 실패하면(중지 요청 제외) 남은 계획대로 진행한다
          const stop = overBudget();
          if (stop) return stop;
          let decision = null;
          try { decision = await progress(finished); } catch (err) {
            checkStop();
            note({ skipped: redactContext(err.message).slice(0, 300) });
          }
          if (decision?.action === 'question' && decision.question?.trim()) return ask([{ phase: 'progress', question: decision.question }]);
          if (decision?.action === 'revise') {
            try {
              applyRevision(decision.revisedPlan, decision.reason);
            } catch (err) {
              // 받을 수 없는 수정은 버리고 남은 계획대로 진행한다(이유는 이력에 남김)
              note({ rejected: redactContext(err.message).slice(0, 300), reason: redactContext(String(decision.reason || '')).slice(0, 300) });
            }
          }
        }
      }
      checkStop();
      const stopBeforeReview = overBudget();
      if (stopBeforeReview) return stopBeforeReview;
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
          // 검증실은 계획의 검토 기준(기술·사실)을 보고, 대표 요청 충족은 비서실장이 본다(같은 항목 중복 검토 방지)
          prompt: `outputs/${task}/ 산출물과 plan.json을 읽기 전용으로 검토하세요. 첫 줄은 VERDICT: PASS|FIX|BLOCK입니다.\n검토 기준: ${plan.review?.criteria || '각 단계 산출물이 계획의 완료 기준을 충족하는지'}\n대표 요청 충족·전달 가능성은 비서실장이 따로 확인하니, 이 기준의 기술·사실 확인에 집중하고 FIX면 고칠 단계와 항목을 구체적으로 적으세요.` });
        checkStop();
        const verdict = parseVerdict(text);
        mkdirSync(join(taskDir, 'reviews'), { recursive: true });
        writeFileAtomic(join(taskDir, 'reviews', `${reviewer.id}.md`), text);
        evidence.push({ reviewer: reviewer.id, verdict, text });
      }
      let review = cached?.review || parseObject(await execute({ phase: 'review', prompt: [
        '비서실장으로서 산출물을 읽기 전용으로 검토하세요. JSON만 응답하세요.',
        '{verdict:"pass"|"reject"|"revise"|"block"|"question",stage:"빈 문자열(예전 형식)",stages:[{id:"고칠 단계 id",reason:"그 단계에서 고칠 점"}],reason:"근거",report:"보고서 Markdown",question:"질문 또는 빈 문자열",revisedPlan:null}',
        `reject: 산출물을 고치면 되는 단계를 stages에 모두 적고 단계마다 구체적인 수정 사항을 쓰세요(한 번에 묶어 반려). revise: 기존 단계로는 채울 수 없는 부족한 부분이 있으면 단계를 추가·변경한 전체 계획을 revisedPlan에 주세요. 완료된 단계는 그대로 두며, 남은 계획 수정 가능 횟수는 ${MAX_PLAN_REVISIONS - state.revisionCount}회입니다. 반려·보완을 할지, 확인 필요로 남기고 통과시킬지는 남은 예산을 보고 정하세요.`,
        `계획: ${JSON.stringify(plan)}`, `검증실 결과: ${JSON.stringify(evidence)}`,
        evidence.length ? '검증실이 이미 확인한 항목은 다시 검토하지 말고 그 결론을 반영하세요. 당신은 대표 요청 충족·전달 가능성, 그리고 검증실이 다루지 않은 부분을 확인합니다.' : '',
        context(), plan.stages.some((s) => /\.html?$/i.test(s.output)) ? HTML_BRIEF : '',
        `외부 작업 형식 검사: ${JSON.stringify(prepared.errors)}. 메일 문안은 수신자·출처·본문이 대표 지시와 맞는지 확인하세요. 아직 실제 전송 전이므로 보고서에서 발송·게시 완료로 쓰지 마세요. 실행기가 실제 결과를 별도로 붙입니다.`,
        `outputs/${task}/review-notes.md가 있으면 추가 검증 근거를 읽고 산출물·이미지와 대조하세요.`,
        budgetLeft(),
        '당신이 최종 검토자입니다. 별도 검증실 부재는 공백이 아니므로 대체 검토 알림을 만들지 마세요. 요청한 전문 검토에 FIX/BLOCK/ERROR가 있거나 산출물이 없으면 pass를 내리지 마세요. 보고서에는 결과·산출물 경로·근거·확인 필요·실제 역량 공백을 포함하세요.',
      ].filter(Boolean).join('\n\n') }));
      checkStop();
      if (review.verdict === 'pass' && prepared.errors.length) review = { verdict: 'reject', stage: prepared.errors[0].stage, reason: prepared.errors.map((e) => e.reason).join(' ') };
      if (review.verdict === 'question' && review.question?.trim()) return ask([{ phase: 'review', question: review.question }]);
      if (review.verdict === 'pass' && evidence.every((e) => e.verdict === 'PASS')
          && plan.stages.every((s) => fingerprint(s) === state.completed[s.id])) {
        if (typeof review.report !== 'string' || !review.report.trim()) throw new Error('검토 보고서가 비어 있습니다.');
        state.approvedReview = { signature: reviewSignature, review, evidence }; persist();
        // 계획 수정으로 첨부가 바뀌었을 수 있어 발송 전에 다시 확인한다(확정한 파일은 그대로 쓴다)
        const attachmentAsked = resolveMailAttachments();
        if (attachmentAsked) return attachmentAsked;
        // 메일 대량 발송 금지: 20통까지 보내고 남은 메일은 대표에게 다시 확인받는다("끝까지 자동으로" 위임이 있어도 같음)
        const isMail = (job) => job.publication.action === 'mail';
        const wasSent = (job) => isMail(job) && Boolean(state.mailSent[mailKey(job)]);
        const sentMails = () => prepared.jobs.filter(wasSent).length;
        if (state.mailAllowance == null) state.mailAllowance = sentMails() + MAX_MAILS_PER_RUN;
        const batch = splitMailBatch(prepared.jobs, { sent: Object.keys(state.mailSent), allowance: state.mailAllowance });
        const mailLine = ({ publication: p }) => `받는사람 ${p.recipients.join(', ')} · 제목: ${p.subject}`;
        const publications = [];
        let posted = 0;
        // 위임이 없으면 외부 작업(웹사이트·메일·글·댓글)을 실행 전에 한 번에 묶어 확인받는다.
        // 대표가 미리 등록한 예약·상시 감시 업무의 메일·글·댓글은 등록이 곧 지시이므로 묻지 않는다(웹사이트 작업은 기존대로 확인)
        const needsConfirm = (job) => job.publication.action === 'web' || !unattended;
        const confirmJobs = batch.run.filter((job) => needsConfirm(job) && !wasSent(job));
        if (confirmJobs.length && !policy().delegated && !state.webDecision) {
          const list = outbound?.connections() || [];
          // 계정이 계획에 비어 있으면 실행 때처럼 그 서비스의 유일한 계정을 보여 준다
          const label = (p) => {
            const chosen = p.connection ? list.find((c) => c.id === p.connection)
              : p.action === 'web' ? null : (({ length, 0: only }) => length === 1 ? only : null)(list.filter((c) => c.provider === serviceProvider(p.service)));
            return chosen?.label || p.connection || '연결 계정 미지정';
          };
          const kind = { web: '웹사이트 작업', mail: '메일', post: '글', comment: '댓글' };
          const what = confirmJobs.every((job) => job.publication.action === 'web') ? '웹사이트 작업' : '외부 작업';
          return ask([{ phase: 'web-confirm', question: `아래 ${what}을 실행할까요? ("진행" 또는 "하지 마"로 답하세요. 다음부터 확인 없이 하려면 지시에 "끝까지 자동으로"를 적어 주세요.)\n`
            + confirmJobs.map(({ publication: p, body, files = [] }, i) => { const attached = p.action === 'mail' ? mailFiles(p).map((f) => f.name) : files.map((f) => basename(f));
              return `${i + 1}. ${p.action === 'web' ? '' : `${kind[p.action] || p.action} `}[${label(p)}] ${p.recipients?.length ? `받는사람 ${p.recipients.join(', ')}` : p.target}${p.subject ? ` · 제목: ${p.subject}` : ''} — ${body.replace(/\s+/g, ' ').slice(0, 300)}${attached.length ? ` (첨부: ${attached.join(', ')})` : ''}`; }).join('\n')
            + (batch.remaining.length ? `\n\n메일은 대량 발송을 막기 위해 한 번에 ${MAX_MAILS_PER_RUN}통까지만 보냅니다. 남은 ${batch.remaining.length}통은 위 메일을 보낸 뒤 다시 묻습니다.` : '') }]);
        }
        // 웹사이트 작업 추정은 넓은 문장 판별이라, 계획에 외부 작업이 없으면 비서실장 계획을 따른다(메일·게시는 확인)
        if (allowedActions().some((action) => action !== 'web') && !(plan.publications || []).length) return ask([{ phase: 'plan', question: '요청하신 외부 작업의 대상·계정·본문을 계획에서 확인하지 못했습니다. 계정 연결과 대상 주소를 확인해 주세요.' }]);
        for (const job of batch.run) {
          const { publication, body, files = [] } = job;
          // 이미 보낸 메일은 다시 보내지 않고 앞서 확인한 결과만 보고한다
          if (wasSent(job)) { publications.push(state.mailSent[mailKey(job)]); continue; }
          if (state.webDecision === 'declined' && needsConfirm({ publication })) { publications.push(`- ${publication.action === 'web' ? '웹사이트 작업' : `${publication.service} ${publication.action}`} ${publication.target}: 대표 결정으로 실행하지 않음`); continue; }
          if (!outbound) return ask([{ phase: 'plan', question: '외부 작업을 위해 계정 연결을 먼저 완료해 주세요.' }]);
          const instance = `${run.id}-publish-${publication.id || publications.length}`;
          const engine = org.departments.find((d) => d.id === org.roster.find((a) => a.id === publication.agent)?.department)?.engine || 'claude';
          emit('agent.start', { engine, agent: publication.agent, instance, summary: '검토된 원문의 브라우저 업무를 시작합니다.' });
          try {
            const web = publication.action === 'web';
            const attachments = isMail(job) ? mailFiles(publication) : files.map((f) => ({ name: basename(f), path: safeOutput(f) }));
            const result = await outbound.deliver({ scope: run.rootId, publication, body, allowedActions: allowedActions(), instructionKey: instructionKey(), ...policy(), schedule: videoPolicy, signal,
              files: attachments, evidenceDir: join(taskDir, 'evidence'),
              execute: async (browser) => {
                const text = await execute({ phase: 'publish', agentId: publication.agent, browser,
                prompt: web ? [
                  '대표가 이번 업무에서 지시한 웹사이트 작업을 연결 계정의 브라우저로 실행합니다. 아래 지침대로 진행하고 지침에 없는 변경은 하지 마세요.',
                  `시작 주소: ${publication.target}`, `지침:\n${body}`,
                  attachments.length ? `첨부할 파일(browser_attach의 file 값): ${attachments.map((a) => a.name).join(', ')}` : '첨부 파일 없음',
                  'office_browser 도구만 사용해 화면을 읽고 조작하세요. browser_snapshot의 ref를 쓰고, 입력은 browser_type, 파일은 browser_attach로 넣습니다.',
                  '업로드·저장·제출·등록·추가처럼 되돌리기 어려운 버튼은 browser_submit으로 누릅니다. 같은 버튼을 다시 누르지 말고 결과 화면을 확인하세요.',
                  '파일 칸이 숨겨져 있으면 파일 선택 창을 여는 버튼("파일 선택" 등)의 ref로 browser_attach를 호출하세요.',
                  '마지막에 결과 화면에서 확인한 내용(만든 항목, 공개 주소, 하지 못한 일과 이유)을 summary에 적고, 지침을 끝까지 마쳤으면 completed:true, 아니면 completed:false로 browser_finish를 호출하세요. 그다음 끝까지 마쳤으면 status:done, 아니면 status:needs_decision과 질문을 JSON으로 보고하세요. 로그인·추가 인증·권한 문제나 지침이 모호해도 needs_decision입니다.',
                  '쿠키·비밀번호·개인 프로필 파일을 읽거나 출력하지 않습니다. 삭제·결제·계정 변경은 하지 않습니다.',
                ].join('\n\n') : ['대표가 이번 업무에서 지시하고 비서실장이 검토한 외부 작업을 실행합니다. 아래 원문의 내용과 대상을 바꾸지 마세요.',
                  // 이번 한 건만 알려 준다(여러 수신자 문안이 든 파일 경로를 주면 다른 사람 메일과 헷갈린다)
                  `이번 작업 한 건: ${JSON.stringify({ 종류: publication.action, 대상: publication.target, ...(publication.recipients?.length ? { 받는사람: publication.recipients } : {}), ...(publication.subject ? { 제목: publication.subject } : {}) })}`,
                  `본문 앞부분(확인용): ${JSON.stringify(String(body).slice(0, 80))}… 본문 전체는 browser_fill_content(field:"body")가 그대로 넣으니 파일을 읽거나 직접 타이핑하지 마세요.`,
                  attachments.length ? `첨부할 파일(browser_attach의 file 값): ${attachments.map((a) => a.name).join(', ')}. 받는사람·제목·본문을 넣은 뒤 파일 첨부 칸 또는 "파일 첨부"·"내 PC" 같은 버튼의 ref로 browser_attach를 파일마다 호출하고, 화면의 첨부 목록에 파일 이름이 보이는지 확인한 다음 보내세요. 첨부가 빠지면 browser_submit이 거부합니다. 첨부 한도 초과 등으로 붙이지 못하면 보내지 말고 needs_decision으로 보고하세요.` : '',
                  'office_browser 도구만 사용해 사이트의 화면을 읽고 조작하세요. 쿠키·비밀번호·로그인 코드·개인 프로필 파일을 읽거나 출력하지 않습니다.',
                  'browser_snapshot으로 칸을 확인하고 각 칸의 ref에 맞는 field로 browser_fill_content를 부르세요: 받는사람 칸 → recipients, 제목 칸 → subject, 본문 편집기(여러 줄) → body. 도구가 칸 종류가 맞지 않으면 거부하니 그때는 화면을 다시 읽고 맞는 칸을 고르세요. 마지막 발송·발행·등록은 browser_submit으로만 실행합니다.',
                  '전송 완료 또는 실제 게시된 본문을 확인해 browser_finish로 증표를 만든 뒤 status:done JSON으로 보고하세요. 로그인/추가 인증/쓰기 권한이 필요하면 status:needs_decision과 질문을 반환하세요.',
                  '이메일·글·댓글 작성 외의 삭제·결제·계정 변경은 하지 않습니다. 결과가 불확실한 전송을 다시 누르지 마세요.',
                ].filter(Boolean).join('\n\n') });
                const result = stageResult(text);
                if (result.status === 'needs_decision') throw new Error(result.question || '외부 작업에 필요한 계정·권한을 확인해 주세요.');
                return text;
              } });
            publications.push(web ? `- 웹사이트 작업 ${publication.target}: ${result.confirmedBy === 'user' ? '사용자 확인 완료' : '직원 확인 완료'}${result.resultUrl ? ` · ${result.resultUrl}` : ''}${result.evidence ? ` · 증거 evidence/${result.evidence}` : ''}${result.summary ? `\n  - 확인 내용: ${redactContext(result.summary)}` : ''}`
              : `- ${publication.service} ${publication.action}${isMail(job) ? ` (${mailLine(job)})` : ''}: ${result.confirmedBy === 'user' ? '사용자 확인 완료' : '브라우저 확인 완료'}${result.resultUrl ? ` · ${result.resultUrl}` : ''}`);
            if (isMail(job)) { state.mailSent[mailKey(job)] = publications.at(-1); persist(); }
            if (publication.action === 'post') posted++;
            emit('agent.stop', { engine, agent: publication.agent, instance, summary: '실제 외부 작업 결과를 확인했습니다.' });
          } catch (error) {
            checkStop();
            if (error.code === 'VIDEO_DUPLICATE') { prepared.skipped.push(error.message); emit('agent.stop', { engine, agent: publication.agent, instance, summary: '중복 또는 오늘 게시 한도에 따라 제외했습니다.' }); continue; }
            emit('agent.pause', { engine, agent: publication.agent, instance, summary: redactContext(error.message) });
            return ask([{ phase: 'publish', question: `외부 작업을 이어가기 위한 확인이 필요합니다. ${redactContext(error.message)}` }]);
          }
        }
        if (batch.remaining.length) {
          // 대표가 있으면 다음 20통을 보낼지 묻는다. 예약·상시 감시 회차는 묻지 않고 남은 메일을 미발송으로 보고한다
          if (!unattended && !state.mailDeclined && state.webDecision !== 'declined') {
            const next = batch.remaining.slice(0, MAX_MAILS_PER_RUN);
            return ask([{ phase: 'mail-more', question: `메일 ${sentMails()}통을 보냈습니다. 남은 메일이 ${batch.remaining.length}통 있습니다. 다음 ${next.length}통을 이어서 보낼까요? ("진행" 또는 "하지 마"로 답하세요. 대량 발송을 막기 위해 메일은 한 번에 ${MAX_MAILS_PER_RUN}통까지만 보내고, 끝까지 자동으로 맡긴 업무도 ${MAX_MAILS_PER_RUN}통마다 다시 묻습니다.)\n`
              + next.map((job, i) => `${i + 1}. ${mailLine(job)}`).join('\n') + (batch.remaining.length > next.length ? `\n그 뒤 ${batch.remaining.length - next.length}통은 이 메일을 보낸 뒤 다시 묻습니다.` : '') }]);
          }
          const why = unattended ? `메일 한도 ${MAX_MAILS_PER_RUN}통 초과로 이번 회차에 보내지 않음` : '대표 결정으로 보내지 않음';
          prepared.skipped.push(...batch.remaining.map((job) => `${why}: ${mailLine(job)}`));
        }
        const report = review.report + ((plan.publications || []).length ? '\n\n## 외부 작업 결과\n\n' + (publications.join('\n') || '- 실제 발송·게시 0건: 확인된 대상이 없습니다.')
          + (videoPolicy ? `\n\n영상 게시 ${posted}건 / 목표 ${videoPolicy.minPosts}~${videoPolicy.maxPosts}건.${posted < videoPolicy.minPosts ? ' 조건에 맞는 중복 없는 새 영상이 부족해 목표 수를 채우지 않았습니다.' : ''}` : '')
          + (prepared.skipped.length ? '\n\n확인 필요:\n' + prepared.skipped.map((s) => '- ' + redactContext(s)).join('\n') : '') : '');
        writeFileAtomic(join(taskDir, 'report.md'), report);
        // 최종산출물 폴더 이름은 비서실장이 정리한 업무 목표(지시문 원문보다 알아보기 쉬움)
        try { collectFinalOutputs(root, { task, title: plan.goal || loadTasks(root).find((t) => t.id === task)?.title, plan, directory: state.intent?.outputDir || null }); }
        catch (error) { return ask([{ phase: 'deliver', question: `최종산출물을 저장하지 못했습니다. 회사 설정의 저장 위치·폴더 권한을 확인한 뒤 이어서 재개해 주세요. ${redactContext(error.message)}` }]); }
        emit('flow.review', { verdict: 'pass', summary: redact(review.reason) });
        completeTask(root, task);
        state.delivered = true;
        persist();
        emit('flow.deliver', { summary: '최종 검토를 마쳐 업무를 완료하고 결과를 전달했습니다.' });
        return report;
      }
      // 반려·보완 횟수는 고정하지 않고 업무 예산 안에서 비서실장이 정한다(예산 점검이 매 회차 앞에서 멈춤)
      const hasTargets = Array.isArray(review.stages) && review.stages.length || review.stage;
      if (review.verdict === 'revise') {
        // 검토에서 부족한 부분을 채울 단계를 추가한다(진행 점검과 같은 안전선: 완료 단계 유지·수정 횟수)
        try {
          applyRevision(review.revisedPlan, review.reason);
          state.rejects++;
          state.rejectionReasons = {};
          state.rejectionReason = String(review.reason || '검토에서 계획을 보완했습니다.');
          persist();
          emit('flow.review', { verdict: 'reject', summary: redact(`계획 보완: ${state.rejectionReason}`) });
          continue;
        } catch (err) {
          note({ rejected: redactContext(err.message).slice(0, 300), reason: redactContext(String(review.reason || '')).slice(0, 300) });
          if (!hasTargets) return blocked(`검토에서 계획을 보완하지 못했습니다. ${err.message}`);
        }
      } else if (review.verdict !== 'reject') return blocked(`검토를 완료하지 못했습니다. ${review.reason || '판정 또는 산출물을 확인해 주세요.'}`);
      // 여러 단계를 한 번에, 단계마다 고칠 점과 함께 반려한다(예전 형식 stage·reason도 받는다)
      const targets = (Array.isArray(review.stages) && review.stages.length ? review.stages : [{ id: review.stage, reason: review.reason }])
        .map((t) => ({ stage: plan.stages.find((s) => s.id === t?.id), reason: String(t?.reason || review.reason || '검토 지적을 수정하세요.') }))
        .filter((t, i, list) => t.stage && list.findIndex((o) => o.stage === t.stage) === i);
      if (!targets.length) return blocked('반려할 단계가 명확하지 않습니다. ' + (review.reason || ''));
      state.rejects++;
      state.rejectionReasons = Object.fromEntries(targets.map((t) => [t.stage.id, t.reason]));
      state.rejectionReason = targets.length > 1 ? targets.map((t) => `[${t.stage.title}] ${t.reason}`).join('\n') : targets[0].reason;
      clearDependents(new Set(targets.map((t) => t.stage.id)));
      persist();
      for (const t of targets) emit('flow.review', { verdict: 'reject', to: t.stage.dept, target: t.stage.agent, stage: t.stage.id, summary: redact(t.reason) });
    }
  } catch (err) {
    checkStop();
    return blocked(`업무 진행이 중단됐습니다. ${err.message}`);
  }
}
