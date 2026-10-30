// 비서실장 실행 설정. 직원 정본과 별도로 저장하며 기존 회사 파일은 그대로 둔다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODEL_PATTERN, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT } from './cli.mjs';
import { writeFileAtomic } from './org.mjs';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_CHIEF = Object.freeze({ engine: 'codex', model: DEFAULT_CODEX_MODEL, effort: DEFAULT_CODEX_EFFORT });
// 기존 Codex 부서는 읽기 전용이었다. 명시적으로 바꾸기 전에는 쓰기를 허용하지 않는다.
export const codexRole = (dept) => dept?.codexRole || 'review';

// 저장된 chief는 최종 검토 설정이다. 계획·조율에는 사용 가능한 Claude를 우선한다.
// tools=null은 CLI 상태를 주입하지 않는 기존 임베딩 호출과의 호환용이다.
export function resolveControlChief(chief, { phase, tools = null, mode = 'auto' } = {}) {
  if (phase === 'review' || !tools) return chief;
  if (mode !== 'codex' && tools.claude?.installed === true && tools.claude?.loggedIn === true) {
    return { engine: 'claude', model: 'opus', effort: 'high' };
  }
  if (tools.claude?.installed === false || tools.claude?.loggedIn === false || mode === 'codex') {
    return chief.engine === 'codex' ? chief : { ...DEFAULT_CHIEF };
  }
  throw new Error('Claude 로그인 상태를 확인 중입니다. 잠시 후 다시 지시해 주세요.');
}

export function validateChief(chief) {
  if (!chief || typeof chief !== 'object' || Array.isArray(chief)) throw new Error('비서실장 설정은 객체여야 합니다.');
  const { engine, model, effort } = chief;
  if (!['claude', 'codex'].includes(engine)) throw new Error('비서실장 제공자는 claude 또는 codex여야 합니다.');
  if (typeof model !== 'string' || !(engine === 'codex' ? CODEX_MODEL_PATTERN.test(model) && !CLAUDE_MODELS.includes(model)
    : CLAUDE_MODELS.filter((m) => m !== 'inherit').includes(model) || /^claude-[a-z0-9.-]{1,60}$/.test(model))) {
    throw new Error('선택한 제공자의 모델 이름이 올바르지 않습니다.');
  }
  if (!(engine === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS).includes(effort)) throw new Error('선택한 제공자가 지원하는 effort를 골라 주세요.');
  return { engine, model, effort };
}

export function validateSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('회사 실행 설정을 읽을 수 없습니다.');
  const mode = data.mode ?? 'auto';
  if (!['auto', 'claude', 'codex', 'mixed'].includes(mode)) throw new Error('회사 실행 모드가 올바르지 않습니다.');
  return { mode, chief: validateChief(data.chief ?? DEFAULT_CHIEF) };
}

export function loadSettings(root) {
  const file = join(root, 'org', 'company.json');
  return validateSettings(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
}

export function saveSettings(root, updates) {
  const file = join(root, 'org', 'company.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const current = loadSettings(root);
  const mode = updates.mode ?? current.mode;
  if (!['auto', 'claude', 'codex', 'mixed'].includes(mode)) throw new Error('회사 실행 모드가 올바르지 않습니다.');
  const chief = validateChief(updates.chief ?? current.chief);
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ ...previous, mode, chief }, null, 2) + '\n');
  return { mode, chief };
}

export function resolveChief(root, { engine, model, effort } = {}) {
  const saved = loadSettings(root).chief;
  const provider = engine || (model && CLAUDE_MODELS.includes(model) ? 'claude' : saved.engine);
  return validateChief({ engine: provider,
    model: model || (provider === saved.engine ? saved.model : provider === 'codex' ? DEFAULT_CODEX_MODEL : 'sonnet'),
    effort: effort || (provider === saved.engine ? saved.effort : provider === 'codex' ? DEFAULT_CODEX_EFFORT : 'high') });
}
