// CLI가 보고한 값만 저장한다. 구독 요금이나 보고되지 않은 비용은 추정하지 않는다.
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
