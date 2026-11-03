// CLI가 저장한 공개 모델 메타데이터만 읽는다. 인증 파일·토큰은 읽지 않는다.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_EFFORTS, CODEX_MODEL_PATTERN, DEFAULT_CODEX_MODEL } from './cli.mjs';
import { CLAUDE_EFFORTS } from './settings.mjs';

export function modelCatalog({ env = process.env, home = homedir() } = {}) {
  let codex = [];
  try {
    const data = JSON.parse(readFileSync(join(env.CODEX_HOME || join(home, '.codex'), 'models_cache.json'), 'utf8'));
    codex = (Array.isArray(data.models) ? data.models : [])
      .filter((m) => m?.visibility === 'list' && CODEX_MODEL_PATTERN.test(m.slug))
      .map((m) => ({ id: m.slug, label: typeof m.display_name === 'string' ? m.display_name.slice(0, 80) : m.slug,
        efforts: (m.supported_reasoning_levels || []).map((l) => l?.effort).filter((e) => CODEX_EFFORTS.includes(e)) }))
      .filter((m) => m.efforts.length);
  } catch { /* 다른 컴퓨터·CLI 최초 실행 전에는 기본 목록을 쓴다 */ }
  const fallback = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
  if (!codex.length) codex = fallback.map((id) => ({ id, label: id, efforts: id === 'gpt-6-luna' ? CODEX_EFFORTS.filter((e) => e !== 'ultra') : [...CODEX_EFFORTS] }));
  if (!codex.some((m) => m.id === DEFAULT_CODEX_MODEL)) codex.unshift({ id: DEFAULT_CODEX_MODEL, label: DEFAULT_CODEX_MODEL, efforts: [...CODEX_EFFORTS] });
  return { codex, claude: ['haiku', 'sonnet', 'opus'].map((id) => ({ id, label: id, efforts: [...CLAUDE_EFFORTS] })) };
}
