// 대표 지시·답장의 의도를 AI가 판단하고, 코드는 안전선만 확인한다.
// 외부 작업 허용·위임·상시 실행처럼 행동 권한이 되는 판단은 근거 문장이 대표 원문에 실제로 있을 때만 인정한다.
// AI 판별이 실패하거나 시간을 넘기면 기존 문장 판별로 대신한다(노트북 종료 전 "멈춰"도 바로 처리).
import { followUpIntent, historyClearIntent, pauseIntent, resumeIntent } from './pause.mjs';
import { CONTINUOUS_LIMITS, evidenceIn, externalActionPolicy } from './guardrails.mjs';
import { continuousRequest } from './continuous.mjs';
import { MAX_SCHEDULE_TIMES, localDate, scheduleRequest } from './schedules.mjs';

const ACTIONS = ['mail', 'post', 'comment', 'web'];
const NEEDS_FULL_FLOW = /검증|꼼꼼|교차|대조|검토|분석|보고서|html|pdf|엑셀|초안|제안서|기획|파워포인트|ppt|슬라이드|(?<!키|패스)워드|docx|xlsx/i;
// 간단한 문서 수정의 안전선: 정밀 확인·새 작성·전체 수정이면 전체 절차로 간다
const EDIT_NEEDS_FULL_FLOW = /검증|꼼꼼|교차|대조|검토|분석|보고서|초안|제안서|기획|번역|요약|전체|새로|작성해|만들어/;
const OFFICE_FILE = /\.(?:pptx|docx|xlsx)(?![A-Za-z0-9])/gi;
const normalize = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
// 실행기가 덧붙인 저장 위치 안내는 대표 지시가 아니다
const userText = (text) => String(text ?? '').replace(/\[저장 위치\][^\n]*/g, '').trim();

export function commandPrompt(text, now = new Date(), staff = [], active = []) {
  const kst = new Date(now.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  return [
    '당신은 AI 사무실 비서실장입니다. 대표가 지시창에 쓴 문장의 의도를 판별해 JSON으로만 답하세요.',
    'kind: 진행 중인 업무를 멈추고 정리해 두라는 뜻이면 pause, 멈춘 업무를 이어서 하라는 뜻이면 resume, 이 대시보드의 끝난 업무·실행 내역을 지우라는 뜻이면 clear_history, 그 밖의 업무 지시는 task. 다른 사이트나 업체 자료의 내역을 지우는 일은 clear_history가 아닙니다.',
    `지금 진행 중인 업무: ${JSON.stringify(active)}. 대표 지시가 이 중 하나에 조건·정보를 덧붙이거나 고치는 말이면 kind는 follow_up, followUpRun에 그 업무 id를 쓰세요. 그 업무 없이는 뜻이 통하지 않는 말("아 참고로…", "그거 말고…")이 해당합니다. 독립된 새 일이면 task, followUpRun은 빈 문자열입니다.`,
    'externalActions: 대표가 이 지시에서 실제로 시킨 외부 작업만. mail(메일 발송), post(블로그·카페에 글 게시·올리기·업로드), comment(댓글), web(연결된 웹사이트·관리자 화면에 올리기·등록·입력·제출). 조회·정리·초안만이면 빈 배열.',
    'delegated: 대표가 확인 없이 끝까지 진행하라고 맡겼으면 true.',
    'standing: 멈출 때까지 계속이면 until_stop, 기간(예: 24시간 동안)이면 duration(durationMinutes), 종료 시각까지면 deadline(deadline=YYYY-MM-DD HH:MM, 한국 시간), 아니면 none. intervalMinutes는 확인 간격(없으면 0).',
    '예약: 지금이 아니라 정해진 시각에 시작하라는 지시면 scheduleTime=HH:MM(24시간제, 한국 시간), 아니면 빈 문자열. scheduleDate는 첫 실행 날짜 YYYY-MM-DD(날짜를 말하지 않았으면 빈 문자열, "내일"은 현재 시각 기준으로 계산). scheduleTimes는 한 번이면 1, 횟수 제한 없이 매일 반복이면 0, "3일간"·"5회"처럼 정한 횟수면 그 수. 시각이 업무 내용일 뿐이면(예: 내일 10시 회의 자료 준비) 예약이 아닙니다.',
    'outputDir: 대표가 결과·산출물을 저장할 폴더 경로를 지정했으면 그 경로(예: ~/Desktop/상담사 리스트), 아니면 빈 문자열.',
    'quick: 웹에서 자료·뉴스·정보를 찾아 정리하는 것처럼 직원 한 명이 한 번에 끝낼 수 있는 단순 조회면 true. 대표가 검증·분석·보고서·문서 제작·회사 사이트 조회·외부 작업·여러 단계를 요구하면 false.',
    'quickEdit: 대표가 이름을 적은 기존 PowerPoint·Word·Excel 파일 하나에서, 고칠 위치와 내용이 지시에 정해진 작은 수정(글자 교체, 행·문단·슬라이드 한두 개 추가·삭제)이면 true. 조사·새 작성·번역·요약·전체 수정·여러 파일·외부 자료가 필요하면 false. quick과 동시에 true로 하지 마세요.',
    'quickEditFile: quickEdit이면 대표가 적은 파일 이름이나 경로를 글자 그대로, 아니면 빈 문자열.',
    `quickAgent: quick이나 quickEdit이면 맡을 직원 id, 아니면 빈 문자열. 직원 목록: ${JSON.stringify(staff)}`,
    '각 *Evidence와 evidence에는 판단 근거가 된 대표 원문 일부를 그대로 복사하세요. 근거가 없으면 빈 문자열.',
    `현재 시각(한국): ${kst}`,
    `대표 지시:\n${userText(text)}`,
  ].join('\n');
}

export function answerPrompt(text, questions = []) {
  return [
    '당신은 AI 사무실 비서실장입니다. 대표가 질문에 답한 문장을 판별해 JSON으로만 답하세요.',
    'decision: 질문의 제안대로 진행하라면 approve, 하지 말라·취소면 decline, 내용·대상을 바꾸라면 modify, 그 밖은 other.',
    'addActions/removeActions: 대표가 이 답장에서 새로 시키거나 금지한 외부 작업(mail, post, comment, web).',
    'delegated: 이제부터 확인 없이 끝까지 진행하라고 맡겼으면 true.',
    '각 evidence에는 근거가 된 대표 답장 일부를 그대로 복사하세요. 근거가 없으면 빈 문자열.',
    `비서실장이 했던 질문:\n${questions.map((q, i) => `${i + 1}. ${String(q?.question || q).slice(0, 600)}`).join('\n') || '(없음)'}`,
    `대표 답장:\n${userText(text)}`,
  ].join('\n');
}

// 지시창 문장 → {kind, actions, delegated, continuous, schedule, source}
export async function judgeCommand(text, { judge = null, now = Date.now(), staff = [], active = [] } = {}) {
  const raw = userText(text);
  // 분명한 "멈춰"·"이어서 해줘"는 판별을 기다리지 않고 바로 처리한다(노트북 종료 직전 대기 방지)
  if (pauseIntent(raw)) return { kind: 'pause', actions: [], delegated: false, continuous: null, schedule: null, source: 'rule' };
  if (resumeIntent(raw)) return { kind: 'resume', actions: [], delegated: false, continuous: null, schedule: null, source: 'rule' };
  if (historyClearIntent(raw)) return { kind: 'clear_history', actions: [], delegated: false, continuous: null, schedule: null, source: 'rule' };
  const fallback = () => {
    // 진행 중인 업무가 하나뿐이고 덧붙이는 말로 시작하면 그 업무에 전달한다
    if (active.length === 1 && followUpIntent(raw)) return { kind: 'follow_up', followUpRun: active[0].id, actions: [], delegated: false, continuous: null, schedule: null, source: 'rule' };
    let continuous = null, schedule = null;
    try { continuous = continuousRequest(raw, undefined, { now }); } catch { continuous = null; }
    try { schedule = scheduleRequest(raw, now); } catch { schedule = null; }
    const policy = externalActionPolicy([raw]);
    return { kind: pauseIntent(raw) ? 'pause' : resumeIntent(raw) ? 'resume' : 'task', actions: policy.actions, delegated: policy.delegated, continuous, schedule, outputDir: null, source: 'rule' };
  };
  const ai = judge ? await judge('intent', commandPrompt(raw, new Date(now), staff, active)).catch(() => null) : null;
  // 형식이 맞지 않는 응답은 판별 실패로 본다
  if (!ai || typeof ai !== 'object' || typeof ai.kind !== 'string' || !Array.isArray(ai.externalActions) || typeof ai.standing !== 'string') return fallback();
  const ok = (evidence) => evidenceIn(raw, evidence);
  // 근거가 원문과 글자 그대로 맞지 않아도(예: 주소를 쉼표로 이어 씀) 규칙 판별이 같은 결론이면 인정한다.
  // 두 방식이 모두 같은 판단일 때만이라 AI가 지어낸 허가는 여전히 막힌다
  const rule = externalActionPolicy([raw]);
  if (ai.kind === 'follow_up' && active.some((run) => run.id === ai.followUpRun)) return { kind: 'follow_up', followUpRun: ai.followUpRun, actions: [], delegated: false, continuous: null, schedule: null, source: 'ai' };
  // 내역 삭제는 되돌릴 수 없어 지시에 대시보드 내역을 가리키는 말이 있을 때만 받는다
  const clearOk = ai.kind === 'clear_history' && ok(ai.kindEvidence) && /(?:작업|업무|실행|대화|대시보드)[^.!?\n]{0,12}(?:내역|기록|히스토리|목록)|내역\s*초기화/.test(raw);
  const kind = ['pause', 'resume'].includes(ai.kind) && ok(ai.kindEvidence) ? ai.kind : clearOk ? 'clear_history' : 'task';
  const actions = [...new Set((Array.isArray(ai.externalActions) ? ai.externalActions : [])
    .filter((a) => ACTIONS.includes(a?.action) && (ok(a.evidence) || rule.actions.includes(a.action))).map((a) => a.action))];
  const delegated = ai.delegated === true && (ok(ai.delegatedEvidence) || rule.delegated);
  let continuous = null;
  if (['until_stop', 'duration', 'deadline'].includes(ai.standing) && ok(ai.standingEvidence)) {
    const intervalMs = Number.isInteger(ai.intervalMinutes) && ai.intervalMinutes > 0 ? ai.intervalMinutes * 60000 : 5 * 60000;
    const deadlineAt = ai.standing === 'deadline' ? Date.parse(String(ai.deadline || '').replace(' ', 'T') + ':00+09:00') : null;
    const durationMs = ai.standing === 'duration' && Number.isInteger(ai.durationMinutes) && ai.durationMinutes > 0 ? ai.durationMinutes * 60000 : null;
    const { minIntervalMs, maxIntervalMs, maxSpanMs } = CONTINUOUS_LIMITS;
    const valid = intervalMs >= minIntervalMs && intervalMs <= maxIntervalMs
      && (ai.standing !== 'deadline' || Number.isFinite(deadlineAt) && deadlineAt > now && deadlineAt - now <= maxSpanMs)
      && (ai.standing !== 'duration' || durationMs !== null && durationMs <= maxSpanMs);
    if (valid) continuous = { intervalMs, durationMs, ...(ai.standing === 'deadline' ? { deadlineAt } : {}) };
  }
  // 예약: 시각 형식과 근거가 맞을 때만. 날짜는 오늘부터 1년 안, 횟수는 1~365(0은 무제한 매일)
  let schedule = null;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(ai.scheduleTime || '') && ok(ai.scheduleEvidence)) {
    const today = localDate(now), date = String(ai.scheduleDate || '');
    const dateOk = !date || /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today;
    const times = Number.isInteger(ai.scheduleTimes) && ai.scheduleTimes > 0 && ai.scheduleTimes <= MAX_SCHEDULE_TIMES ? ai.scheduleTimes : null;
    if (dateOk) schedule = { time: ai.scheduleTime, ...(date ? { startDate: date } : {}), ...(times ? { times } : {}) };
  }
  // 저장 위치는 전체 경로 형태이고 근거 문장(경로 포함)이 원문에 있을 때만 쓴다
  const dir = typeof ai.outputDir === 'string' ? ai.outputDir.trim() : '';
  const outputDir = /^(?:~[\\/]|\/|[A-Za-z]:[\\/])/.test(dir) && ok(ai.outputDirEvidence) && normalize(raw).includes(normalize(dir).replace(/^~/, '')) ? dir : null;
  // 빠른 경로는 대표가 정밀 확인·제작을 말하지 않은 단순 조회에만 쓴다(판별 실패·규칙 판별은 기존 흐름)
  const quick = ai.quick === true && kind === 'task' && !actions.length && !continuous && !schedule && !NEEDS_FULL_FLOW.test(raw);
  const editFile = typeof ai.quickEditFile === 'string' ? ai.quickEditFile.trim() : '';
  // 파일은 대표 원문에 있어야 하고, 지시에 문서 파일이 하나뿐이어야 한다
  const quickEdit = !quick && ai.quickEdit === true && kind === 'task' && !actions.length && !continuous && !schedule && !outputDir
    && !EDIT_NEEDS_FULL_FLOW.test(raw) && (raw.match(OFFICE_FILE) || []).length === 1 && Boolean(editFile) && evidenceIn(raw, editFile);
  return { kind, actions, delegated, continuous, schedule, outputDir, quick, quickEdit, quickEditFile: quickEdit ? editFile : '',
    quickAgent: (quick || quickEdit) && typeof ai.quickAgent === 'string' ? ai.quickAgent : '', source: 'ai' };
}

// 질문에 대한 답장 → {decision, add, remove, delegated, source}
export async function judgeAnswer(text, questions, { judge = null } = {}) {
  const raw = userText(text);
  const fallback = () => {
    const policy = externalActionPolicy([raw]);
    // 고치라는 답을 승인으로 읽으면 고치기 전 문안이 나간다. 승인 단어("해 줘" 등)보다 먼저 본다
    const decision = /하지\s*마|취소|중지|안\s*해|보류|그만/.test(raw) ? 'decline' : /수정|변경|바꿔|고쳐|다시\s*(?:써|작성)/.test(raw) ? 'modify' : /진행|승인|확인|좋아|ㅇㅋ|오케이|네|예|응|해\s*줘|끝까지|ok|go/i.test(raw) ? 'approve' : 'other';
    return { decision, add: policy.actions, remove: [], delegated: policy.delegated, source: 'rule' };
  };
  const ai = judge ? await judge('intent-answer', answerPrompt(raw, questions)).catch(() => null) : null;
  if (!ai || typeof ai !== 'object' || typeof ai.decision !== 'string') return fallback();
  const ok = (evidence) => evidenceIn(raw, evidence);
  const pick = (list) => [...new Set((Array.isArray(list) ? list : []).filter((a) => ACTIONS.includes(a?.action) && ok(a.evidence)).map((a) => a.action))];
  const decision = ['approve', 'decline', 'modify'].includes(ai.decision) && ok(ai.decisionEvidence) ? ai.decision : 'other';
  return { decision, add: pick(ai.addActions), remove: pick(ai.removeActions), delegated: ai.delegated === true && ok(ai.delegatedEvidence), source: 'ai' };
}
