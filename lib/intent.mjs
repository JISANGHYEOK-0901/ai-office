// 대표 지시·답장의 의도를 AI가 판단하고, 코드는 안전선만 확인한다.
// 외부 작업 허용·위임·상시 실행처럼 행동 권한이 되는 판단은 근거 문장이 대표 원문에 실제로 있을 때만 인정한다.
// AI 판별이 실패하거나 시간을 넘기면 기존 문장 판별로 대신한다(노트북 종료 전 "멈춰"도 바로 처리).
import { pauseIntent, resumeIntent } from './pause.mjs';
import { externalActionPolicy } from './browser-work.mjs';
import { continuousRequest } from './continuous.mjs';
import { dailyScheduleRequest } from './schedules.mjs';

const ACTIONS = ['mail', 'post', 'comment', 'web'];
const normalize = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
// AI가 근거 앞에 붙이는 "대표 지시:"·따옴표를 걷어 내고 원문에 있는지 본다
export function evidenceIn(text, evidence) {
  let quote = String(evidence ?? '').trim();
  const quoted = quote.match(/["“'‘]([^"”'’]{2,})["”'’]/);
  if (quoted) quote = quoted[1];
  quote = quote.replace(/^(?:대표\s*(?:지시|답장|요청)|원문|근거)\s*[:：]\s*/, '');
  const needle = normalize(quote);
  return needle.length >= 2 && normalize(text).includes(needle);
}

// 실행기가 덧붙인 저장 위치 안내는 대표 지시가 아니다
const userText = (text) => String(text ?? '').replace(/\[저장 위치\][^\n]*/g, '').trim();

export function commandPrompt(text, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  return [
    '당신은 AI 사무실 비서실장입니다. 대표가 지시창에 쓴 문장의 의도를 판별해 JSON으로만 답하세요.',
    'kind: 진행 중인 업무를 멈추고 정리해 두라는 뜻이면 pause, 멈춘 업무를 이어서 하라는 뜻이면 resume, 그 밖의 업무 지시는 task.',
    'externalActions: 대표가 이 지시에서 실제로 시킨 외부 작업만. mail(메일 발송), post(블로그·카페 글 게시), comment(댓글), web(연결된 웹사이트·관리자 화면에 올리기·등록·입력·제출). 조회·정리·초안만이면 빈 배열.',
    'delegated: 대표가 확인 없이 끝까지 진행하라고 맡겼으면 true.',
    'standing: 멈출 때까지 계속이면 until_stop, 기간(예: 24시간 동안)이면 duration(durationMinutes), 종료 시각까지면 deadline(deadline=YYYY-MM-DD HH:MM, 한국 시간), 아니면 none. intervalMinutes는 확인 간격(없으면 0).',
    'dailyTime: 매일 정해진 시각에 반복하라는 지시면 HH:MM(24시간제), 아니면 빈 문자열.',
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

// 지시창 문장 → {kind, actions, delegated, continuous, daily, source}
export async function judgeCommand(text, { judge = null, now = Date.now() } = {}) {
  const raw = userText(text);
  // 분명한 "멈춰"·"이어서 해줘"는 판별을 기다리지 않고 바로 처리한다(노트북 종료 직전 대기 방지)
  if (pauseIntent(raw)) return { kind: 'pause', actions: [], delegated: false, continuous: null, daily: null, source: 'rule' };
  if (resumeIntent(raw)) return { kind: 'resume', actions: [], delegated: false, continuous: null, daily: null, source: 'rule' };
  const fallback = () => {
    let continuous = null, daily = null;
    try { continuous = continuousRequest(raw, undefined, { now }); } catch { continuous = null; }
    try { daily = dailyScheduleRequest(raw); } catch { daily = null; }
    const policy = externalActionPolicy([raw]);
    return { kind: pauseIntent(raw) ? 'pause' : resumeIntent(raw) ? 'resume' : 'task', actions: policy.actions, delegated: policy.delegated, continuous, daily, source: 'rule' };
  };
  const ai = judge ? await judge('intent', commandPrompt(raw, new Date(now))).catch(() => null) : null;
  // 형식이 맞지 않는 응답은 판별 실패로 본다
  if (!ai || typeof ai !== 'object' || typeof ai.kind !== 'string' || !Array.isArray(ai.externalActions) || typeof ai.standing !== 'string') return fallback();
  const ok = (evidence) => evidenceIn(raw, evidence);
  const kind = ['pause', 'resume'].includes(ai.kind) && ok(ai.kindEvidence) ? ai.kind : 'task';
  const actions = [...new Set((Array.isArray(ai.externalActions) ? ai.externalActions : [])
    .filter((a) => ACTIONS.includes(a?.action) && ok(a.evidence)).map((a) => a.action))];
  const delegated = ai.delegated === true && ok(ai.delegatedEvidence);
  let continuous = null;
  if (['until_stop', 'duration', 'deadline'].includes(ai.standing) && ok(ai.standingEvidence)) {
    const intervalMs = Number.isInteger(ai.intervalMinutes) && ai.intervalMinutes > 0 ? ai.intervalMinutes * 60000 : 5 * 60000;
    const deadlineAt = ai.standing === 'deadline' ? Date.parse(String(ai.deadline || '').replace(' ', 'T') + ':00+09:00') : null;
    const durationMs = ai.standing === 'duration' && Number.isInteger(ai.durationMinutes) && ai.durationMinutes > 0 ? ai.durationMinutes * 60000 : null;
    const valid = intervalMs >= 10000 && intervalMs <= 86400000
      && (ai.standing !== 'deadline' || Number.isFinite(deadlineAt) && deadlineAt > now && deadlineAt - now <= 365 * 86400000)
      && (ai.standing !== 'duration' || durationMs !== null && durationMs <= 365 * 86400000);
    if (valid) continuous = { intervalMs, durationMs, ...(ai.standing === 'deadline' ? { deadlineAt } : {}) };
  }
  const daily = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(ai.dailyTime || '') && ok(ai.dailyEvidence) ? { time: ai.dailyTime } : null;
  return { kind, actions, delegated, continuous, daily, source: 'ai' };
}

// 질문에 대한 답장 → {decision, add, remove, delegated, source}
export async function judgeAnswer(text, questions, { judge = null } = {}) {
  const raw = userText(text);
  const fallback = () => {
    const policy = externalActionPolicy([raw]);
    const decision = /하지\s*마|취소|중지|안\s*해|보류|그만/.test(raw) ? 'decline' : /진행|승인|확인|좋아|ㅇㅋ|오케이|네|예|응|해\s*줘|끝까지|ok|go/i.test(raw) ? 'approve' : 'other';
    return { decision, add: policy.actions, remove: [], delegated: policy.delegated, source: 'rule' };
  };
  const ai = judge ? await judge('intent-answer', answerPrompt(raw, questions)).catch(() => null) : null;
  if (!ai || typeof ai !== 'object' || typeof ai.decision !== 'string') return fallback();
  const ok = (evidence) => evidenceIn(raw, evidence);
  const pick = (list) => [...new Set((Array.isArray(list) ? list : []).filter((a) => ACTIONS.includes(a?.action) && ok(a.evidence)).map((a) => a.action))];
  const decision = ['approve', 'decline', 'modify'].includes(ai.decision) && ok(ai.decisionEvidence) ? ai.decision : 'other';
  return { decision, add: pick(ai.addActions), remove: pick(ai.removeActions), delegated: ai.delegated === true && ok(ai.delegatedEvidence), source: 'ai' };
}
