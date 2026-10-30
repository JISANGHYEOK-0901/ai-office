// 조직 정본 → .claude/agents/*.md, .codex/agents/*.toml 생성
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadOrg, validateOrg } from './org.mjs';
import { programRoot } from './paths.mjs';
import { codexRole } from './settings.mjs';

export const CLAUDE_MARKER = '<!-- ai-office:generated';
export const CODEX_MARKER = '# ai-office:generated';
const CLAUDE_DIR = '.claude/agents';
const CODEX_DIR = '.codex/agents';
const NOTICE = '이 파일은 org/*.json 정본에서 자동 생성됩니다. 직접 고치지 말고 대시보드나 정본을 수정한 뒤 npm run sync를 실행하세요.';

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// YAML 값: 안전한 문자만 있으면 그대로, 아니면 큰따옴표 문자열(JSON 표기는 YAML에서도 유효)
function yamlValue(s) {
  return /^[A-Za-z0-9_][A-Za-z0-9_ ,.()*:/-]*$/.test(s) && !/: /.test(s) ? s : JSON.stringify(s);
}

// TOML 기본 문자열
function tomlString(s) {
  return '"' + tomlEscape(String(s).replace(/\r?\n/g, ' ')) + '"';
}

// TOML 여러 줄 기본 문자열
function tomlMultiline(s) {
  return '"""\n' + tomlEscape(s, true) + '\n"""';
}

function tomlEscape(s, keepNewlines = false) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n' && keepNewlines) out += '\n';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() : '';
}

// 부서 공통 지침: 부서 필드 instructions, 없으면 org/templates/<id>.md(하위 호환).
// 템플릿은 프로그램 레포에 있고, 작업 공간에 같은 이름의 템플릿을 두면 그것을 먼저 쓴다
function deptInstructions(root, dept) {
  if (typeof dept.instructions === 'string' && dept.instructions.trim()) return dept.instructions.trim();
  const own = join(root, 'org', 'templates', `${dept.id}.md`);
  return readText(existsSync(own) ? own : join(programRoot(), 'org', 'templates', `${dept.id}.md`));
}

// 모델 우선순위: 직원 model > (팀장이면 opus) > 부서 model > sonnet
export function resolveAgentModel(agent, dept) {
  if (agent.model) return agent.model;
  if (agent.lead) return 'opus';
  return dept?.model || 'sonnet';
}

function agentLabel(agent, dept) {
  const rank = agent.rank || agent.title || (agent.lead ? '팀장' : '담당');
  return `${dept.name} · ${rank} ${oneLine(agent.name)}`;
}

function describe(agent, dept) {
  return oneLine(`[${agentLabel(agent, dept)}] ${agent.description || agent.specialty || dept.summary || ''}`);
}

// 공통 머리말: 이름·직급·부서·산출물 경로 규칙·보고 형식
function commonHeader(agent, dept, engine) {
  const name = oneLine(agent.name);
  const title = agent.title || (agent.lead ? '팀장' : '담당');
  const lines = [
    `# ${name} — ${dept.name}${dept.en ? ` (${dept.en})` : ''}`,
    '',
    `- 이름: ${name}`,
    `- 직급: ${agent.rank || '미지정'} / 직함: ${title}${agent.lead ? ' (부서 팀장)' : ''}`,
    `- 부서: ${dept.name} (id: ${dept.id})${dept.summary ? ` — ${oneLine(dept.summary)}` : ''}`,
    `- 담당: ${oneLine(agent.specialty || agent.description || '미지정')}`,
    `- 직원 id: ${agent.id}`,
    '',
  ];
  if (engine === 'codex' && codexRole(dept) === 'review') {
    lines.push(
      '## 검증실 근무 규칙',
      '- 당신은 AI Office 검증실의 검토자다. 대상 파일을 읽기 전용으로 검토하며 어떤 파일도 만들거나 고치지 않는다.',
      '- 답변 첫 줄은 반드시 `VERDICT: PASS`, `VERDICT: FIX`, `VERDICT: BLOCK` 중 하나다.',
      '  - PASS: 그대로 보고해도 된다. FIX: 고쳐야 할 지적이 있다. BLOCK: 사실 오류·숫자 불일치·법적 위험 등으로 보고하면 안 된다.',
      '- 둘째 줄부터 Markdown 지적 목록을 쓴다. 지적마다 근거 위치(`파일:줄` 또는 `파일:표/섹션`), 문제, 고칠 방향을 적는다.',
      '- 확인할 수 없는 내용은 추정하지 말고 "확인 불가"와 그 이유를 적는다. 비밀값이 보이면 값을 옮겨 적지 말고 위치만 알린다.',
      '',
    );
    return lines.join('\n');
  }
  lines.push(
    '## 근무 규칙',
    '- 다른 직원을 직접 호출하지 않는다. 대시보드의 구조화된 응답 지시가 있으면 needs_decision(대표 질문), reroute(오전달), delegate(팀장 분담) 상태로 실행기에 전달한다. 실제 실행·재개는 실행기가 담당한다.',
    `- 산출물은 비서실장이 지시에 적어 준 업무 폴더 \`outputs/YYYY-MM-DD/<slug>/\` 아래 \`${dept.id}/\` 하위에만 쓴다. 파일명은 \`${agent.id}-<내용>.md\`처럼 직원 id로 시작한다.`,
    '- 업무 폴더를 지시받지 못했으면 파일을 쓰기 전에 그 사실을 보고하고 멈춘다. 업무 폴더 밖의 파일은 지시 없이 고치지 않는다.',
    '- `.md` 파일 이름을 report·summary·findings·analysis로 시작하지 않는다(Claude Code가 서브에이전트의 그런 파일 쓰기를 막는다). 지시·지침에 그런 이름(예: `summary.md`)이 있으면 직원 id를 앞에 붙여(`<직원id>-summary.md`) 쓰고 보고에 실제 경로를 적는다.',
    '- 지시에 이번 단계의 입력·출력·완료 기준이 있으면 그대로 따른다. 입력(앞 단계 산출물 경로)을 먼저 읽고 근거로 쓰며, 출력은 지정된 경로에만 쓰고, 완료 기준을 모두 채운 뒤 끝낸다. 입력 파일이 없거나 읽을 수 없으면 지어내지 말고 보고의 "확인 필요"에 적는다.',
    '- 지시가 `[반려]`로 시작하면 재작업이다. 반려 사유와 수정 기준을 항목별로 모두 반영하고, 보고의 결과에 무엇을 어떻게 고쳤는지 적는다.',
    '- 지시가 `[회의]`로 시작하면 회의 참석이다. 파일을 만들지 말고 범위·산출물·분담(누가 무엇을 어떤 순서로)·가정을 보고로만 제안한다.',
    '- 확인한 사실, 추정, 제안을 구분해서 쓴다. 숫자와 인용에는 출처(파일 경로, URL, 원본 위치)를 붙인다.',
    '- 대시보드에서 단독(헤드리스)으로 실행될 수 있다. 위험이 낮은 모호함은 묻지 않고 합리적으로 가정해 `가정:`으로 밝히고 진행한다. 범위·비용·외부 영향이 큰 결정만 묻는다. 물을 때는 번호 목록으로 묶어 질문마다 권장 기본값을 붙이고 "답장 또는 \'기본값으로 진행\'이라고 답하면 됩니다."로 끝낸다. 비서실장이 부른 경우에는 같은 형식으로 보고의 "확인 필요"에 적는다.',
    '- 비밀번호·토큰·API 키·쿠키를 산출물과 답변에 옮겨 적지 않는다. 대표가 지시한 업체·수신자 연락처는 해당 업무의 비공개 문안·계획에 필요한 범위에서 사용한다.',
    '- 메일 발송·글/댓글 게시는 대표가 해당 업무에서 지시하고 실행기가 office_browser를 연결한 경우에만 검토된 원문으로 실행한다. 계정 비밀값은 읽지 않는다. 그 외에는 초안만 만든다. 송금·결제·계약 체결은 실행하지 않는다.',
  );
  if (agent.lead) {
    lines.push(
      `- 팀장 업무: \`${dept.id}/\` 아래 부서원 산출물을 읽고 취합·검토해서 부서 보고서 \`${dept.id}/dept-report.md\`를 쓴다. 누락·상충·근거 부족을 표시한다. 대시보드에서는 delegate 응답으로 같은 부서의 다른 근무중 직원 1~6명에게 분담할 수 있다. 분담 결과를 받으면 취합하며 다시 분담하지 않는다.`,
    );
  }
  lines.push(
    '',
    '## 보고 형식',
    '마지막 답변은 비서실장에게 보내는 보고다. 실행기가 구조화된 JSON 응답을 명시하면 그 계약을 우선하고, 그 외에는 아래 형식을 지킨다.',
    '',
    '```',
    '결과: 첫 문장에 산출물 경로를 넣어 한두 문장으로 요약 (예: `outputs/…/<부서id>/<파일>` 작성 완료 — 핵심 내용)',
    '산출물: 만든 파일 경로 목록',
    '근거: 핵심 근거와 출처',
    '확인 필요: 사실 확인·의사결정이 필요한 항목 (없으면 "없음")',
    '```',
    '',
  );
  return lines.join('\n');
}

// 지침 조립 순서: 공통 머리말 → 회사 공통 규칙(org/company.md) → 부서 공통 지침 → 역할 지침
function body(root, agent, dept, engine, company) {
  const parts = [commonHeader(agent, dept, engine)];
  if (company) parts.push('## 회사 공통 규칙', '', company, '');
  const template = deptInstructions(root, dept);
  if (template) parts.push('## 부서 공통 지침', '', template, '');
  if (agent.instructions?.trim()) parts.push('## 역할 지침', '', agent.instructions.trim(), '');
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function agentInstructions(root, agent, dept, company = readText(join(root, 'org', 'company.md'))) {
  return body(root, agent, dept, dept.engine === 'codex' ? 'codex' : 'claude', company);
}

function claudeFile(root, agent, dept, company) {
  const model = resolveAgentModel(agent, dept);
  const fm = ['---', `name: ${agent.id}`, `description: ${JSON.stringify(describe(agent, dept))}`];
  if (Array.isArray(dept.tools) && dept.tools.length) fm.push(`tools: ${yamlValue(dept.tools.join(', '))}`);
  fm.push(`model: ${yamlValue(model)}`, '---', `${CLAUDE_MARKER} ${NOTICE} -->`, '', '');
  return fm.join('\n') + body(root, agent, dept, 'claude', company);
}

function codexFile(root, agent, dept, company) {
  return [
    `${CODEX_MARKER} ${NOTICE}`,
    `name = ${tomlString(agent.id)}`,
    `description = ${tomlString(describe(agent, dept))}`,
    `developer_instructions = ${tomlMultiline(body(root, agent, dept, 'codex', company).trimEnd())}`,
    '',
  ].join('\n');
}

function isGenerated(text, kind) {
  if (kind === 'codex') return text.startsWith(CODEX_MARKER);
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n(.*)/.exec(text);
  return Boolean(m && m[1].startsWith(CLAUDE_MARKER));
}

// 한 직원의 생성 파일 { path, content, engine }. engine이 codex인 부서는 .toml, 나머지는 .md
function agentFile(root, agent, dept, company) {
  if (dept.engine === 'codex') return { path: `${CODEX_DIR}/${agent.id}.toml`, content: codexFile(root, agent, dept, company), engine: 'codex' };
  return { path: `${CLAUDE_DIR}/${agent.id}.md`, content: claudeFile(root, agent, dept, company), engine: 'claude' };
}

// 정본 기준으로 생성되어야 할 파일 목록 { 상대경로: 내용 }
function desiredFiles(root, org) {
  const files = new Map();
  const company = readText(join(root, 'org', 'company.md'));
  const depts = new Map(org.departments.filter((d) => d.active !== false).map((d) => [d.id, d]));
  for (const agent of org.roster) {
    const dept = depts.get(agent.department);
    if (!dept || agent.active === false) continue;
    const f = agentFile(root, agent, dept, company);
    files.set(f.path, f.content);
  }
  return files;
}

// 생성될 지침 파일 미리보기. 휴무 직원·휴무 부서도 만든다. 직원이 없으면 null
export function previewAgentFile(root, agentId, org = loadOrg(root)) {
  const agent = org.roster.find((a) => a.id === agentId);
  if (!agent) return null;
  const dept = org.departments.find((d) => d.id === agent.department);
  if (!dept) return null;
  return agentFile(root, agent, dept, readText(join(root, 'org', 'company.md')));
}

function existingFiles(root, dir, ext) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);
}

function firstDiffLine(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, before: a[i] ?? '', after: b[i] ?? '' };
  }
  return null;
}

// 반환: { changed:[상대경로], removed:[상대경로], ok, diffs:[{path, kind, ...}], conflicts:[상대경로], errors:[string] }
// write=false면 파일을 건드리지 않고 무엇이 달라지는지만 계산한다.
// ok: 검사 모드에서는 변경이 필요 없을 때 true. 두 모드 모두 검증 오류나 충돌(표식 없는 파일과 이름이 겹침)이 있으면 false.
export function syncAgents(root, { write = false } = {}) {
  const org = loadOrg(root);
  const validation = validateOrg(org);
  if (!validation.ok) {
    return { changed: [], removed: [], ok: false, diffs: [], conflicts: [], errors: validation.errors };
  }
  const desired = desiredFiles(root, org);
  const changed = [];
  const removed = [];
  const diffs = [];
  const conflicts = [];

  for (const [rel, content] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = join(root, rel);
    const kind = rel.endsWith('.toml') ? 'codex' : 'claude';
    if (existsSync(abs)) {
      const current = readFileSync(abs, 'utf8');
      if (!isGenerated(current, kind)) {
        conflicts.push(rel);
        continue;
      }
      if (current === content) continue;
      diffs.push({ path: rel, kind: 'update', ...firstDiffLine(current, content) });
    } else {
      diffs.push({ path: rel, kind: 'create' });
    }
    changed.push(rel);
    if (write) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  const existing = [
    ...existingFiles(root, CLAUDE_DIR, '.md').map((p) => [p, 'claude']),
    ...existingFiles(root, CODEX_DIR, '.toml').map((p) => [p, 'codex']),
  ].sort(([a], [b]) => a.localeCompare(b));
  for (const [rel, kind] of existing) {
    if (desired.has(rel)) continue;
    if (!isGenerated(readFileSync(join(root, rel), 'utf8'), kind)) continue;
    removed.push(rel);
    diffs.push({ path: rel, kind: 'remove' });
    if (write) rmSync(join(root, rel));
  }

  const ok = conflicts.length === 0 && (write || diffs.length === 0);
  return { changed, removed, ok, diffs, conflicts, errors: [] };
}
