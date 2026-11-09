// 안전선: AI가 무엇을 판단하든 코드가 지키는 규칙을 한곳에 모은다.
// 여기 규칙을 바꾸면 브라우저 업무·의도 판별·비서실장 훅·상시 실행이 함께 바뀐다(test/guardrails.test.mjs).
//
// 다른 곳에 남긴 안전선(데이터·상태와 묶여 있어 옮기지 않음):
// - 허용 도메인: connections.mjs connectionAllowsUrl(연결 계정이 열 수 있는 주소)
// - 중복 실행 방지: browser-work.mjs 실행 원장(같은 계정·대상·내용), video-history.mjs(같은 영상 재게시)
// - 비밀값 차단 훅: chief-guard.mjs decideSecretGuard(아래 secretLocations·SECRET_MENTION 사용)
// - 직원·비서실장 도구 제한: chief-guard.mjs, browser-cli.mjs
import { join } from 'node:path';

// ── 금지 동작: 어떤 위임이 있어도 누르지 않는 버튼 ──
const FORBIDDEN = /삭제|탈퇴|로그아웃|결제|송금|이체|비밀번호|delete|remove account|log\s*out|purchase|payment/i;
export const isForbiddenAction = (label) => FORBIDDEN.test(String(label || ''));

// ── 되돌리기 어려운 동작: browser_submit으로만 누르고 기록을 남긴다 ──
// '게시판 선택'처럼 게시판 이름이 든 버튼은 최종 버튼이 아니다
const FINAL = /보내기|발송|발행|게시(?!판)|등록|작성\s*완료|^(?:send|publish|submit|post)$/i;
// 일반 웹사이트 업무에서는 업로드·저장·제출 등도 되돌리기 어려운 버튼이다
const FINAL_WEB = /보내기|발송|발행|게시(?!판)|등록|작성\s*완료|업로드|저장|제출|적용|반영|생성|추가|^(?:send|publish|submit|post|upload|save|apply|create)$/i;
export const isFinalAction = (label, { site = false } = {}) => (site ? FINAL_WEB : FINAL).test(String(label || ''));
// 최종 버튼을 누른 뒤 뜨는 확인 버튼
export const isFinalConfirm = (label) => /확인|완료|계속|확정|ok|confirm|yes/i.test(String(label || ''));
// 사이트 조회 단계(읽기 전용)에서 막는 버튼: 이름이 쓰기 동작 그 자체인 버튼만(정렬용 '등록일' 같은 열 이름은 허용)
const READ_ONLY_BLOCK = /^(?:보내기|발송|발행|게시|등록|작성\s*완료|업로드|저장|제출|반영|생성|추가|수정|변경|승인|반려|확정|삭제|send|publish|submit|post|upload|save|create|update|delete|approve)(?:하기)?$/i;
export const isReadOnlyBlocked = (label) => READ_ONLY_BLOCK.test(String(label || '').replace(/\s+/g, ''));

// ── 외부 작업 허용·위임: 대표 원문에서만 나온다(규칙 판별) ──
// 과거 미발송 상태와 재발송 금지는 최초 발송의 철회가 아니다.
function mailProhibited(value) {
  const text = String(value).replace(/재발송|다시\s*발송|다시\s*보내지/g, '재전송');
  return /발송(?:은|을|도)?\s*(?:하지\s*(?:마|말|않도록|않아\s*주|않는다|않습니다|않겠)|금지)|보내지\s*(?:마|말|않는다|않습니다)/.test(text)
    || /(?:메일(?:\s*발송)?|발송|전송)(?:[\s·,]|게시|발행|광고|집행|외부|은|는|도|을|와|과)*없(?:다|음|습니다)/.test(text)
    || /(?:메일|email|e-mail)[^.!?\n]{0,80}(?:발송|전송|집행)(?:은|을|도)?\s*없(?:다|음|습니다)/i.test(text);
}

// "초안만"은 외부 작업을 하지 말라는 대표의 명시 지시다
export const isDraftOnly = (text) => /초안만|draft\s+only/i.test(String(text || ''));

export function requestedExternalActions(prompt) {
  // 실행기가 덧붙인 저장 위치 안내는 대표의 지시가 아니다
  const text = String(prompt || '').replace(/\[저장 위치\][^\n]*/g, '');
  if (isDraftOnly(text)) return [];
  const actions = [];
  if (/(?:메일|email|e-mail)[\s\S]{0,80}(?:보내|보내기|발송|send)|send[\s\S]{0,40}(?:mail)/i.test(text)) actions.push('mail');
  if (/(?:블로그|카페|게시글|포스팅|글)[\s\S]{0,80}(?:게시|발행|올려|올리기|등록|업로드)|(?:게시|발행)[\s\S]{0,40}(?:블로그|카페|글)|(?:블로그|카페)(?:에|에서)[\s\S]{0,80}(?:작성|써)/.test(text)) actions.push('post');
  if (/댓글[\s\S]{0,40}(?:작성|달아|등록|올려)|(?:작성|등록)[\s\S]{0,20}댓글/.test(text)) actions.push('comment');
  // 일반 웹사이트 업무: 연결한 사이트에 올리거나 입력·등록하는 지시
  if (/업로드|(?:사이트|페이지|관리자|어드민|ERP|admin)(?:에|에서|으로)[\s\S]{0,60}(?:올려|올리|등록해|등록하|입력해|입력하|제출|반영)/i.test(text)) actions.push('web');
  return actions.filter((action) => action === 'web' ? !/업로드\s*(?:하지|금지)|올리지\s*마/.test(text) : action === 'mail' ? !mailProhibited(text)
    : action === 'post' ? !/게시\s*(?:하지|금지)|발행\s*(?:하지|금지)|업로드\s*(?:하지|금지)|올리지\s*마/.test(text)
      : !/댓글[\s\S]{0,20}(?:하지\s*마|금지)|댓글\s*달지\s*마/.test(text));
}

export function externalActionPolicy(turns) {
  const actions = new Set();
  for (const text of turns) {
    if (isDraftOnly(text)) actions.clear();
    if (mailProhibited(text)) actions.delete('mail');
    if (/게시\s*(?:하지|금지)|발행\s*(?:하지|금지)|업로드\s*(?:하지|금지)|올리지\s*마/.test(text)) actions.delete('post');
    if (/댓글[\s\S]{0,20}(?:하지\s*마|금지)|댓글\s*달지\s*마/.test(text)) actions.delete('comment');
    for (const action of requestedExternalActions(text)) actions.add(action);
  }
  const latest = String(turns.at(-1) || '');
  const resendText = latest.split(/[.!?]\s+|\n/).filter((clause) => !/재(?:발송|게시)\s*(?:하지|금지)|다시[\s\S]{0,30}(?:보내지|(?:발송|게시|발행)\s*하지)|수정본[\s\S]{0,20}(?:발송|게시|발행)\s*하지/.test(clause)).join(' ');
  // 위임: 대표가 끝까지 맡기면 일반 웹사이트 업무를 확인 없이 진행한다. 위임이 없으면 실행 전에 묶어서 확인받는다.
  const delegated = turns.some((text) => /끝까지|자동으로|확인\s*없이|묻지\s*말고|알아서|전부\s*맡|위임/.test(String(text || '')));
  return { actions: [...actions], delegated, allowResend: /재발송|재게시|다시[\s\S]{0,30}(?:보내|발송|게시|발행)|수정본[\s\S]{0,20}(?:발송|게시|발행)/.test(resendText),
    retryUncertain: /미발송\s*확인|미게시\s*확인|발송되지\s*않.*확인|게시되지\s*않.*확인/.test(latest),
    confirmExisting: !/미발송|미게시|미등록/.test(latest) && (/(?:발송|게시|등록)[\s\S]{0,30}(?:됐|되었|됨|완료)[\s\S]{0,20}확인/.test(latest) || saysPosted(latest)),
    // 공식 API 게시가 실패했을 때 대표가 브라우저(Playwright) 우회를 고른 답. "브라우저로 하지 마"는 아니다
    viaBrowser: /브라우저로|플레이라이트|playwright/i.test(latest) && !/(?:브라우저|플레이라이트|playwright)[^.!?\n]{0,10}(?:하지\s*마|말고|금지|쓰지\s*마)/i.test(latest) };
}

// 사이트에서 본 게시 결과를 말한 답("글은 올라가 있는데", "올라간 내용 확인은 했어")을 확인으로 본다.
// "안·못 올라왔어", "올라왔는지·올라왔냐" 같은 질문, 물음표로 끝나는 문장("올라왔어?"), 뒤에서 부정한 말("올라가 있지 않아")은 아니다
const SEEN_POSTED = /(?<!안\s?|못\s?)(?:올라(?:가|와)\s*있|올라(?:갔|왔)|(?:게시|등록|발송)(?:돼|되어)\s*있)(?!는지|나|냐|니|을까)/g;
const CHECKED_POSTED = /(?<!안\s?|못\s?)(?:올라간|게시된|등록된|발송된)[^.!?？\n]{0,20}확인(?:은|을|도)?\s*(?:했|함|완료|됐)/;
function saysPosted(text) {
  return String(text).split(/(?<=[.!?？\n])/).some((clause) => !/[?？]\s*$/.test(clause)
    && (CHECKED_POSTED.test(clause)
      || [...clause.matchAll(SEEN_POSTED)].some((m) => !/^\S{0,2}\s*지\s*(?:않|못)/.test(clause.slice(m.index + m[0].length)))));
}

// ── AI 판별 근거: 행동 권한이 되는 판단은 근거 문장이 대표 원문에 실제로 있을 때만 인정한다 ──
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

// ── 한도 ──
// 상시 실행(감시): 간격 10초~24시간, 기간·종료 시각은 1년 이내
export const CONTINUOUS_LIMITS = Object.freeze({ minIntervalMs: 10_000, maxIntervalMs: 86_400_000, maxSpanMs: 365 * 86_400_000 });
// 비서실장 검토 반려는 같은 업무에서 최대 2회
export const MAX_REVIEW_REJECTS = 2;
// 업무 예산: 업무 하나(상시 업무는 확인 주기 하나)가 쓸 수 있는 AI 호출 수·작업 시간. 회사 설정에서 바꾼다.
// 80%를 쓰면 대표에게 계속할지 묻는다(대표가 없는 예약·상시 감시 업무는 묻지 않고 100%에서 그 주기만 멈춘다).
// 대표 답장을 기다리는 시간은 세지 않는다
export const DEFAULT_TASK_BUDGET = Object.freeze({ calls: 40, minutes: 60 });
export const TASK_BUDGET_RANGE = Object.freeze({ calls: [5, 500], minutes: [5, 1440] });
export const BUDGET_WARN_RATIO = 0.8;
export function validateTaskBudget(value) {
  const budget = { ...DEFAULT_TASK_BUDGET, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  for (const [key, [min, max]] of Object.entries(TASK_BUDGET_RANGE)) {
    if (!Number.isInteger(budget[key]) || budget[key] < min || budget[key] > max) throw new Error(`업무 예산의 ${key === 'calls' ? 'AI 호출 수는' : '작업 시간(분)은'} ${min}~${max} 사이 정수여야 합니다.`);
  }
  return { calls: budget.calls, minutes: budget.minutes };
}
// 상시 업무 사용량 이상 알림: 오늘 AI 호출이 최근 7일(기록이 2일 이상) 하루 평균의 3배 이상이고 10회 이상이면 알린다(멈추지는 않음)
export const USAGE_ANOMALY = Object.freeze({ ratio: 3, baselineDays: 7, minBaselineDays: 2, minCalls: 10 });
// 비서실장 진행 점검: 업무당 계획 수정 3회, 점검 12회까지(넘으면 남은 계획대로 진행)
export const MAX_PLAN_REVISIONS = 3;
export const MAX_PROGRESS_CHECKS = 12;
// 서버 종료로 끊긴 지 오래된 업무는 일괄 재개("이어서 해줘")에 포함하지 않는다. 대표가 직접 일시정지한 업무는 기간과 무관하게 재개한다
export const AUTO_RESUME_MAX_AGE_MS = 24 * 3600e3;
// 메일 대량 발송 금지(대표 지시): 수신자 기준 20통까지 보내고, 남은 메일은 대표에게 다시 확인받아 20통씩 이어 보낸다.
// "끝까지 자동으로" 위임이 있어도 같다. 대표가 없는 예약·상시 감시 업무는 묻지 않고 그 회차에 20통만 보낸다
export const MAX_MAILS_PER_RUN = 20;
// 같은 업무의 글·댓글 사이 간격(초). 빠른 연속 게시는 계정 보호 조치를 부를 수 있다. 회사 설정에서 바꾼다(0이면 간격 없음)
export const DEFAULT_POST_GAP_SECONDS = 30;
export const POST_GAP_RANGE = Object.freeze([0, 3600]);
export function validatePostGap(value) {
  const gap = value ?? DEFAULT_POST_GAP_SECONDS;
  if (!Number.isInteger(gap) || gap < POST_GAP_RANGE[0] || gap > POST_GAP_RANGE[1]) throw new Error(`글·댓글 간격은 ${POST_GAP_RANGE[0]}~${POST_GAP_RANGE[1]}초 사이 정수여야 합니다.`);
  return gap;
}

// ── 비밀값: 계정 파일·계정 저장소는 서버 코드만 읽는다 ──
export const SECRET_MENTION = /계정\.env|ai-office[\\/]private/;
export const secretLocations = (root, home, joinPath = join) => [joinPath(root, '보관함', '계정.env'), joinPath(home, '.config', 'ai-office', 'private')];
