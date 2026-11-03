// CLI가 보고한 값만 저장한다. 구독 요금이나 보고되지 않은 비용은 추정하지 않는다.
import { USAGE_ANOMALY } from './guardrails.mjs';
const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
export function cliUsage(engine, message) {
  const raw = message.usage;
  if (!raw || typeof raw !== 'object') return null;
  return { input: number(raw.input_tokens), output: number(raw.output_tokens),
    cachedInput: number(raw.cached_input_tokens ?? raw.cache_read_input_tokens),
    cacheCreation: number(raw.cache_creation_input_tokens),
    costUsd: engine === 'claude' ? number(message.total_cost_usd) : null };
}

export function addUsage(left, right) {
  if (!right) return left || null;
  if (!left) return { ...right };
  return Object.fromEntries(['input', 'output', 'cachedInput', 'cacheCreation', 'costUsd'].map((key) => [key,
    left[key] === null || right[key] === null ? null : (left[key] || 0) + (right[key] || 0)]));
}

// 날짜별 사용량(한국 시각 기준). AI 호출 1회마다 calls를 1 늘리고 보고된 토큰·금액을 더한다. 최근 14일만 남긴다
export const kstDay = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const ZERO = Object.freeze({ calls: 0, input: 0, output: 0, costUsd: 0 });
export function addDailyUsage(daily, usage, ms = Date.now(), keepDays = 14) {
  const day = kstDay(ms), next = { ...(daily || {}) };
  const prev = next[day] || ZERO;
  next[day] = { calls: prev.calls + 1, ...Object.fromEntries(['input', 'output', 'costUsd'].map((key) => [key, prev[key] + (Number.isFinite(usage?.[key]) ? usage[key] : 0)])) };
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)).slice(-keepDays));
}

// 상시 업무 하나(감시 실행·답장으로 이어진 실행·감시가 만든 후속 업무)의 오늘 사용량과 평소 대비 이상 여부
export function monitorUsage(runs, rootId, ms = Date.now()) {
  const days = {};
  for (const run of runs || []) {
    if (!run?.dailyUsage || run.rootId !== rootId && run.monitorId !== rootId) continue;
    for (const [day, value] of Object.entries(run.dailyUsage)) {
      const prev = days[day] || ZERO;
      days[day] = Object.fromEntries(Object.keys(ZERO).map((key) => [key, prev[key] + (Number(value?.[key]) || 0)]));
    }
  }
  const today = kstDay(ms);
  const since = kstDay(ms - USAGE_ANOMALY.baselineDays * 86400e3);
  const previous = Object.entries(days).filter(([day, value]) => day < today && day >= since && value.calls > 0).map(([, value]) => value.calls);
  const baseline = previous.length >= USAGE_ANOMALY.minBaselineDays ? previous.reduce((a, b) => a + b, 0) / previous.length : null;
  const current = days[today] || { ...ZERO };
  const ratio = baseline ? current.calls / baseline : null;
  return { day: today, today: current, baseline, ratio,
    anomaly: baseline !== null && current.calls >= USAGE_ANOMALY.minCalls && ratio >= USAGE_ANOMALY.ratio };
}
