// 조직 정본(org/departments.json, org/roster.json) 로드·검증·저장, 회사 구성 내보내기·가져오기
// 정본 파일은 사용자마다 달라 Git에서 제외한다. 파일이 없으면 빈 회사로 시작하고, 저장할 때 org/ 폴더를 만든다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncAgents } from './sync.mjs';
import { CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODEL_PATTERN } from './cli.mjs';
import { renameWithRetry } from './paths.mjs';

export const ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;
export const ENGINES = ['claude', 'codex'];
export const PERMISSIONS = ['acceptEdits', 'bypassPermissions', 'default'];
// 메인 세션(비서실장)의 이벤트 agent 값이라 직원 id로 쓸 수 없다
export const RESERVED_AGENT_IDS = ['chief'];
// 직무 프리셋 key(예: fact-checker). 직원의 role 필드에 남겨 codex-review --reviewers 에서 찾는다
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_NAME = 40;
const MAX_INSTRUCTIONS = 4000;
export const MAX_COMPANY_RULES = 8000;
// Claude 모델: 별칭 또는 전체 모델 id(claude-...)
const isClaudeModel = (m) => CLAUDE_MODELS.includes(m) || /^claude-[a-z0-9.-]{1,60}$/.test(m);

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`JSON을 읽을 수 없습니다: ${file} (${err.message})`);
  }
}

function readArray(file) {
  const data = readJson(file, []);
  if (!Array.isArray(data)) throw new Error(`배열 형식이어야 합니다: ${file}`);
  return data;
}

export function loadOrg(root) {
  return {
    departments: readArray(join(root, 'org', 'departments.json')),
    roster: readArray(join(root, 'org', 'roster.json')),
  };
}

export function loadPresets(root) {
  const data = readJson(join(root, 'org', 'presets.json'), { departments: [] });
  return { departments: Array.isArray(data.departments) ? data.departments : [] };
}

export function validateOrg(org) {
  const errors = [];
  const departments = org?.departments;
  const roster = org?.roster;
  if (!Array.isArray(departments)) errors.push('departments는 배열이어야 합니다.');
  if (!Array.isArray(roster)) errors.push('roster는 배열이어야 합니다.');
  if (errors.length) return { ok: false, errors };

  const checkCommon = (item, label) => {
    if (typeof item?.id !== 'string' || !ID_PATTERN.test(item.id)) {
      errors.push(`${label} id 형식이 올바르지 않습니다: ${JSON.stringify(item?.id)} (영문 소문자로 시작, 소문자·숫자·하이픈 2~48자)`);
    }
    if (typeof item?.name !== 'string' || !item.name.trim()) {
      errors.push(`${label} ${item?.id ?? ''}: 이름이 비어 있습니다.`);
    } else if (item.name.length > MAX_NAME) {
      errors.push(`${label} ${item.id}: 이름은 ${MAX_NAME}자 이하여야 합니다.`);
    }
    if (item?.active !== undefined && typeof item.active !== 'boolean') {
      errors.push(`${label} ${item.id}: active는 true/false여야 합니다.`);
    }
    if (item?.instructions !== undefined) {
      if (typeof item.instructions !== 'string') errors.push(`${label} ${item.id}: instructions는 문자열이어야 합니다.`);
      else if (item.instructions.length > MAX_INSTRUCTIONS) errors.push(`${label} ${item.id}: 지침은 ${MAX_INSTRUCTIONS}자 이하여야 합니다.`);
    }
  };

  // 부서·직원 id는 조직 전체에서 유일해야 한다
  const allIds = new Set();
  const deptIds = new Set();
  for (const d of departments) {
    checkCommon(d, '부서');
    if (allIds.has(d?.id)) errors.push(`부서 id가 중복됩니다: ${d.id}`);
    allIds.add(d?.id);
    deptIds.add(d?.id);
    if (d?.engine !== undefined && !ENGINES.includes(d.engine)) {
      errors.push(`부서 ${d.id}: engine은 claude 또는 codex여야 합니다.`);
    }
    if (d?.permission !== undefined && !PERMISSIONS.includes(d.permission)) {
      errors.push(`부서 ${d.id}: permission은 ${PERMISSIONS.join('/')} 중 하나여야 합니다.`);
    }
    if (d?.tools !== undefined && !(Array.isArray(d.tools) && d.tools.every((t) => typeof t === 'string' && /^[A-Za-z0-9_*().:-]+$/.test(t)))) {
      errors.push(`부서 ${d.id}: tools는 도구 이름(영문·숫자·_*().:-) 문자열 배열이어야 합니다.`);
    }
    if (d?.model !== undefined && d.model !== '' && !(typeof d.model === 'string' && isClaudeModel(d.model))) {
      errors.push(`부서 ${d.id}: 기본 모델은 ${CLAUDE_MODELS.join('/')} 중 하나여야 합니다.`);
    }
    if (d?.codexModel !== undefined && d.codexModel !== '' && !(typeof d.codexModel === 'string' && CODEX_MODEL_PATTERN.test(d.codexModel))) {
      errors.push(`부서 ${d.id}: Codex 모델 이름 형식이 올바르지 않습니다(영문 소문자·숫자·.- 2~64자).`);
    }
    if (d?.codexEffort !== undefined && d.codexEffort !== '' && !CODEX_EFFORTS.includes(d.codexEffort)) {
      errors.push(`부서 ${d.id}: Codex 추론 강도는 ${CODEX_EFFORTS.join('/')} 중 하나여야 합니다.`);
    }
  }

  const leads = new Map();
  for (const a of roster) {
    checkCommon(a, '직원');
    if (RESERVED_AGENT_IDS.includes(a?.id)) {
      errors.push(`직원 id로 ${a.id}는 쓸 수 없습니다(비서실장 예약어).`);
    } else if (allIds.has(a?.id)) {
      errors.push(deptIds.has(a?.id) ? `직원 id가 부서 id와 겹칩니다: ${a.id}` : `직원 id가 중복됩니다: ${a.id}`);
    }
    allIds.add(a?.id);
    if (a?.role !== undefined && !(typeof a.role === 'string' && ROLE_PATTERN.test(a.role))) {
      errors.push(`직원 ${a?.id}: role(직무 key)은 영문 소문자·숫자·하이픈이어야 합니다.`);
    }
    if (!deptIds.has(a?.department)) {
      errors.push(`직원 ${a?.id}: 소속 부서가 없습니다: ${JSON.stringify(a?.department)}`);
    }
    if (a?.model !== undefined && a.model !== null && a.model !== '' && !(typeof a.model === 'string' && isClaudeModel(a.model))) {
      errors.push(`직원 ${a?.id}: 모델은 ${CLAUDE_MODELS.join('/')} 중 하나여야 합니다.`);
    }
    if (a?.lead === true) {
      if (leads.has(a.department)) {
        errors.push(`부서 ${a.department}: 팀장은 1명만 둘 수 있습니다 (${leads.get(a.department)}, ${a.id}).`);
      } else {
        leads.set(a.department, a.id);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// 임시 파일에 쓰고 rename해서 원자적으로 교체한다.
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameWithRetry(tmp, file);
}

function writeJsonAtomic(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

// 회사 공통 규칙(org/company.md). 없으면 빈 문자열
export function loadCompanyRules(root) {
  const file = join(root, 'org', 'company.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

// 회사 공통 규칙 형식 검사. 문제가 있으면 오류 메시지, 없으면 null
function companyRulesError(rules) {
  if (typeof rules !== 'string') return 'rules는 문자열이어야 합니다.';
  if (rules.length > MAX_COMPANY_RULES) return `회사 공통 규칙은 ${MAX_COMPANY_RULES}자 이하여야 합니다.`;
  return null;
}

// org/company.md만 원자적으로 쓴다(sync는 호출한 쪽이 한다)
function writeCompanyRules(root, rules) {
  mkdirSync(join(root, 'org'), { recursive: true });
  const text = rules.replace(/\r\n/g, '\n').trim();
  writeFileAtomic(join(root, 'org', 'company.md'), text ? text + '\n' : '');
}

// 회사 공통 규칙 저장 후 sync. 반환: syncAgents 결과
export function saveCompanyRules(root, rules) {
  const msg = companyRulesError(rules);
  if (msg) throw Object.assign(new Error(msg), { errors: [msg] });
  writeCompanyRules(root, rules);
  return syncAgents(root, { write: true });
}

export function saveOrg(root, org) {
  const result = validateOrg(org);
  if (!result.ok) {
    const err = new Error(`조직 정본 검증 실패: ${result.errors.join(' / ')}`);
    err.errors = result.errors;
    throw err;
  }
  mkdirSync(join(root, 'org'), { recursive: true });
  writeJsonAtomic(join(root, 'org', 'departments.json'), org.departments);
  writeJsonAtomic(join(root, 'org', 'roster.json'), org.roster);
  return syncAgents(root, { write: true });
}

// 같은 root에 대한 수정은 프로세스 안에서 순서대로 실행한다.
// fn(org)는 org를 직접 고치거나, {departments, roster}를 가진 새 객체를 반환할 수 있다.
// 반환값: { org: 저장된 정본, sync: syncAgents 결과, result: fn의 반환값 }
const queues = new Map();
export function mutateOrg(root, fn) {
  const prev = queues.get(root) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const org = loadOrg(root);
    const result = await fn(org);
    const next = result && Array.isArray(result.departments) && Array.isArray(result.roster) ? result : org;
    const sync = saveOrg(root, next);
    return { org: next, sync, result };
  });
  queues.set(root, run);
  const cleanup = () => {
    if (queues.get(root) === run) queues.delete(root);
  };
  run.then(cleanup, cleanup);
  return run;
}

// 영문·숫자만 남겨 kebab-case로 만들고 순번을 붙인다. 한글은 로마자로 바꾸지 않고 버린다.
// 예: slugifyId('research', ids) → 'research-1', slugifyId('research 김대리', ids) → 'research-1'
export function slugifyId(base, existingIds = []) {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds);
  let stem = String(base ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!stem) stem = 'agent';
  if (!/^[a-z]/.test(stem)) stem = `a-${stem}`;
  for (let n = 1; ; n++) {
    const suffix = `-${n}`;
    const head = stem.slice(0, 48 - suffix.length).replace(/-+$/, '');
    const id = `${head}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

// ---- 회사 구성 내보내기·가져오기(백업과 다른 컴퓨터로 이전) ----
export const ORG_EXPORT_VERSION = 1;

// 반환: { version, company, departments, roster }
export function exportOrg(root) {
  const { departments, roster } = loadOrg(root);
  return { version: ORG_EXPORT_VERSION, company: loadCompanyRules(root), departments, roster };
}

// 가져올 데이터의 형식과 조직 검증. 저장하지 않는다.
// 반환: { ok, errors:[string], org:{departments, roster}, company, summary:{departments, roster, company} }
export function checkOrgImport(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['회사 구성 파일은 JSON 객체여야 합니다.'] };
  }
  if (data.version !== ORG_EXPORT_VERSION) {
    errors.push(`지원하지 않는 회사 구성 파일 버전입니다: ${JSON.stringify(data.version ?? null)} (지원: ${ORG_EXPORT_VERSION})`);
  }
  const company = data.company ?? '';
  const companyError = companyRulesError(company);
  if (companyError) errors.push(`company: ${companyError}`);
  const org = { departments: data.departments, roster: data.roster };
  errors.push(...validateOrg(org).errors);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    org,
    company,
    summary: { departments: org.departments.length, roster: org.roster.length, company: Boolean(company.trim()) },
  };
}

// 현재 회사 구성을 가져온 데이터로 통째로 바꾸고 sync한다(mode는 'replace'만 지원).
// 검증에 실패하면 아무것도 쓰지 않고 err.errors가 붙은 예외를 던진다.
// 반환: { org, sync, summary }
export async function importOrg(root, data, { mode = 'replace' } = {}) {
  if (mode !== 'replace') {
    const msg = `가져오기 방식은 replace만 지원합니다: ${mode}`;
    throw Object.assign(new Error(msg), { errors: [msg] });
  }
  const check = checkOrgImport(data);
  if (!check.ok) {
    throw Object.assign(new Error(`회사 구성 파일 검증 실패: ${check.errors.join(' / ')}`), { errors: check.errors });
  }
  // 조직 변경과 같은 큐에서 실행한다. 회사 규칙을 먼저 써 두어야 saveOrg의 sync가 새 규칙으로 지침 파일을 만든다.
  const { org, sync } = await mutateOrg(root, () => {
    writeCompanyRules(root, check.company);
    return { departments: check.org.departments, roster: check.org.roster };
  });
  return { org, sync, summary: check.summary };
}
