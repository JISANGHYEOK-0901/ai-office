// 시간 미지정 감시는 중지할 때까지, 명시 기간은 절대 종료 시각까지 유지한다.
export const DEFAULT_POLL_MS = 5 * 60 * 1000;
const units = { 초: 1000, 분: 60000, 시간: 3600000, 일: 86400000, second: 1000, minute: 60000, hour: 3600000, day: 86400000 };
export function continuousRequest(prompt, override, { now = Date.now() } = {}) {
  if (override === false) return null;
  if (override !== undefined && override !== true && (!override || typeof override !== 'object' || Array.isArray(override))) throw new Error('지속 감시 설정이 올바르지 않습니다.');
  const text = String(prompt || '');
  if (override === undefined && /가능한지|가능한가|가능해|할\s*수\s*있/.test(text) && !/진행해|시작해|감시해|조사해|수집해/.test(text)) return null;
  const interval = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(초|분|시간|일|seconds?|minutes?|hours?|days?)\s*(?:마다|간격|every)/gi)].at(-1)
    || text.match(/every\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)/i);
  const duration = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(시간|분|일|hours?|minutes?|days?)(?!\s*(?:마다|간격))/gi)]
    .find((m) => !/every\s*$|\d시\s*$/i.test(text.slice(0, m.index)) && !/^\s*(?:마다|간격)/.test(text.slice(m.index + m[0].length)));
  let deadlineAt = override?.deadlineAt ?? null;
  const absolute = text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})\s*까지/);
  const local = text.match(/(오늘|내일)?\s*(\d{1,2})시\s*(?:(\d{1,2})분\s*)?까지/);
  if (deadlineAt === null && (absolute || local)) {
    const date = absolute?.[1] || new Date(now + 9 * 3600000 + (local[1] === '내일' ? 86400000 : 0)).toISOString().slice(0, 10);
    const hour = Number(absolute?.[2] ?? local[2]), minute = Number(absolute?.[3] ?? local[3] ?? 0);
    if (hour > 23 || minute > 59) throw new Error('감시 종료 시각을 확인해 주세요.');
    deadlineAt = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`);
    if (Number.isFinite(deadlineAt) && new Date(deadlineAt + 9 * 3600000).toISOString().slice(0, 10) !== date) throw new Error('감시 종료 날짜를 확인해 주세요.');
    if (!absolute && !local[1] && deadlineAt <= now) deadlineAt += 86400000;
  }
  const aliasDuration = /하루\s*(?:동안|종일)|하루만/.test(text) ? 86400000 : null;
  const intent = /(?:계속|지속|무기한|무한|상시|항상)[\s\S]{0,35}(?:감시|모니터|조사|대기|폴링|수집)|(?:감시|모니터|조사|폴링|수집)[\s\S]{0,35}(?:계속|무기한)|새(?:로운)?\s*(?:자료|정보|소식|글|기사)[\s\S]{0,35}(?:나오면|뜨면|생기면)|keep\s+(?:watching|monitoring)|until\s+(?:I\s+)?stop/i.test(text);
  const timed = (duration || aliasDuration || deadlineAt !== null) && /조사|감시|모니터|수집|작업|대기|watch|research|monitor/i.test(text);
  if (!override && !intent && !timed) return null;
  const factor = (unit) => units[String(unit).toLowerCase().replace(/s$/, '')];
  const intervalMs = override?.intervalMs ?? (interval ? Number(interval[1]) * factor(interval[2]) : DEFAULT_POLL_MS);
  const durationMs = override && Object.hasOwn(override, 'durationMs') ? override.durationMs : deadlineAt !== null ? null
    : duration ? Number(duration[1]) * factor(duration[2]) : aliasDuration;
  if (!Number.isFinite(intervalMs) || intervalMs < 10000 || intervalMs > 86400000) throw new Error('감시 간격은 10초~24시간 사이여야 합니다.');
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 365 * 86400000)) throw new Error('감시 기간은 1년 이하의 양수여야 합니다.');
  if (deadlineAt !== null && (!Number.isFinite(deadlineAt) || deadlineAt <= now || deadlineAt - now > 365 * 86400000)) throw new Error('감시 종료 시각은 현재 이후 1년 이내로 지정해 주세요.');
  return { intervalMs, durationMs, ...(deadlineAt !== null ? { deadlineAt } : {}) };
}

export function waitUntil(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason || new Error('감시 중지')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', stop, { once: true });
  });
}
