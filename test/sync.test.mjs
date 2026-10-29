import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewAgentFile, syncAgents } from '../lib/sync.mjs';
import { repoRoot } from '../lib/paths.mjs';

const SCRIPT = join(repoRoot(), 'scripts', 'sync-agents.mjs');

function setup(t, org) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeOrg(root, org);
  return root;
}

function writeOrg(root, { departments, roster }) {
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(roster));
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

const baseOrg = () => ({
  departments: [
    { id: 'research', name: '리서치부', en: 'RESEARCH', engine: 'claude', tools: ['Read', 'WebSearch'], model: 'sonnet', summary: '시장 조사' },
    { id: 'verify', name: '검증실', en: 'VERIFICATION', engine: 'codex', tools: ['Read'], model: '', permission: 'default' },
  ],
  roster: [
    { id: 'research-1', name: '박팀장', department: 'research', title: '팀장', rank: '팀장', lead: true, specialty: '취합', description: '리서치 결과 취합', instructions: '팀장 지침 본문' },
    { id: 'research-2', name: '김대리', department: 'research', title: '선임', rank: '대리', specialty: '시장 규모', description: '시장 규모 조사할 때 사용', instructions: '시장 지침 본문' },
    { id: 'verify-1', name: '이검증', department: 'verify', title: '담당', specialty: '사실 확인', description: '사실 확인할 때 사용', instructions: '첫 줄 VERDICT. 경로 C:\\temp "인용" 포함' },
  ],
});

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter 없음');
  return Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
}

test('Claude 에이전트 파일: frontmatter, 표식, 머리말 → 템플릿 → 지침 순서', (t) => {
  const root = setup(t, baseOrg());
  mkdirSync(join(root, 'org', 'templates'));
  writeFileSync(join(root, 'org', 'templates', 'research.md'), '부서 템플릿 본문\n');
  const r = syncAgents(root, { write: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, ['.claude/agents/research-1.md', '.claude/agents/research-2.md', '.codex/agents/verify-1.toml']);

  const text = read(root, '.claude/agents/research-2.md');
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, 'research-2');
  assert.equal(JSON.parse(fm.description), '[리서치부 · 대리 김대리] 시장 규모 조사할 때 사용');
  assert.equal(fm.tools, 'Read, WebSearch');
  assert.equal(fm.model, 'sonnet');
  // frontmatter 다음 줄이 생성 표식
  assert.match(text.split('\n---\n')[1], /^<!-- ai-office:generated .* -->\n/);
  for (const s of ['이름: 김대리', '직급: 대리', '부서: 리서치부', '`research/`', 'research-2-<내용>.md', '## 보고 형식', '다른 직원(서브에이전트)을 부를 수 없다',
    // 헤드리스 실행 질문 원칙: 낮은 위험은 가정, 큰 결정만 번호 목록 질문 + 권장 기본값 + 답장 안내
    '단독(헤드리스)으로 실행될 수 있다', '`가정:`', '권장 기본값', "답장 또는 '기본값으로 진행'이라고 답하면 됩니다.",
    // 업무 흐름: 단계 입력·출력·완료 기준 준수, 반려 반영, 회의 제안, 결과 첫 문장에 산출물 경로
    '입력·출력·완료 기준이 있으면 그대로 따른다', '출력은 지정된 경로에만 쓰고', '`[반려]`로 시작하면', '반려 사유와 수정 기준을 항목별로 모두 반영',
    '`[회의]`로 시작하면', '결과: 첫 문장에 산출물 경로를 넣어']) {
    assert.ok(text.includes(s), `머리말에 ${s} 없음`);
  }
  const iHeader = text.indexOf('## 근무 규칙');
  const iTemplate = text.indexOf('부서 템플릿 본문');
  const iInstr = text.indexOf('시장 지침 본문');
  assert.ok(iHeader > 0 && iHeader < iTemplate && iTemplate < iInstr, '본문 순서가 머리말 → 템플릿 → 지침이어야 함');
  assert.ok(!text.includes('dept-report.md`를 쓴다'), '팀장이 아닌 직원에게 팀장 업무가 들어가면 안 됨');
  // Claude Code가 서브에이전트의 report·summary·findings·analysis*.md 쓰기를 막으므로 이름 규칙을 알린다
  assert.ok(text.includes('report·summary·findings·analysis로 시작하지 않는다'));

  const lead = read(root, '.claude/agents/research-1.md');
  assert.equal(parseFrontmatter(lead).model, 'opus', '팀장 기본 모델은 opus');
  assert.ok(lead.includes('`research/dept-report.md`'));
});

test('지침 계층: 머리말 → 회사 규칙 → 부서 instructions(템플릿보다 우선) → 역할 지침, 모델 우선순위', (t) => {
  const org = baseOrg();
  org.departments[0].instructions = '부서 필드 지침';
  org.departments[0].model = undefined;
  org.roster.push({ id: 'research-3', name: '최사원', department: 'research', title: '담당', model: 'haiku', instructions: '역할 지침 3' });
  const root = setup(t, org);
  mkdirSync(join(root, 'org', 'templates'));
  writeFileSync(join(root, 'org', 'templates', 'research.md'), '쓰이면 안 되는 템플릿\n');
  writeFileSync(join(root, 'org', 'company.md'), '회사 규칙 본문\n');
  syncAgents(root, { write: true });
  const text = read(root, '.claude/agents/research-2.md');
  const order = ['## 근무 규칙', '## 회사 공통 규칙', '회사 규칙 본문', '## 부서 공통 지침', '부서 필드 지침', '## 역할 지침', '시장 지침 본문'].map((s) => text.indexOf(s));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `순서 오류: ${order}`);
  assert.ok(!text.includes('쓰이면 안 되는 템플릿'));
  assert.equal(parseFrontmatter(text).model, 'sonnet', '부서 model이 없으면 sonnet');
  assert.equal(parseFrontmatter(read(root, '.claude/agents/research-3.md')).model, 'haiku', '직원 model 우선');
  assert.ok(read(root, '.codex/agents/verify-1.toml').includes('회사 규칙 본문'));

  // 미리보기: 휴무 직원도 만들 수 있다
  org.roster[1].active = false;
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(org.roster));
  const p = previewAgentFile(root, 'research-2');
  assert.equal(p.path, '.claude/agents/research-2.md');
  assert.ok(p.content.includes('부서 필드 지침'));
  assert.equal(previewAgentFile(root, 'ghost-1'), null);
});

test('Codex 파일은 codex 엔진 부서만, Claude 파일은 만들지 않는다', (t) => {
  const root = setup(t, baseOrg());
  syncAgents(root, { write: true });
  assert.equal(existsSync(join(root, '.claude/agents/verify-1.md')), false);
  const toml = read(root, '.codex/agents/verify-1.toml');
  const lines = toml.split('\n');
  assert.match(lines[0], /^# ai-office:generated /);
  assert.equal(lines[1], 'name = "verify-1"');
  assert.match(lines[2], /^description = "\[검증실 · 담당 이검증\] 사실 확인할 때 사용"$/);
  assert.equal(lines[3], 'developer_instructions = """');
  assert.ok(toml.includes('VERDICT: PASS'));
  assert.ok(toml.includes('C:\\\\temp \\"인용\\"'), '백슬래시와 따옴표는 TOML 이스케이프');
  assert.ok(toml.trimEnd().endsWith('"""'));
});

test('active:false 부서·직원은 생성하지 않고 기존 생성 파일을 지운다', (t) => {
  const org = baseOrg();
  const root = setup(t, org);
  syncAgents(root, { write: true });
  org.roster[1].active = false;
  org.departments[1].active = false;
  writeOrg(root, org);
  const r = syncAgents(root, { write: true });
  assert.deepEqual(r.removed, ['.claude/agents/research-2.md', '.codex/agents/verify-1.toml']);
  assert.equal(existsSync(join(root, '.claude/agents/research-2.md')), false);
  assert.ok(existsSync(join(root, '.claude/agents/research-1.md')));
});

test('표식 없는 기존 파일은 보존하고, 표식 있는 고아 파일만 삭제한다', (t) => {
  const root = setup(t, baseOrg());
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  mkdirSync(join(root, '.codex/agents'), { recursive: true });
  const handmade = '---\nname: my-helper\ndescription: 직접 만든 에이전트\n---\n직접 쓴 본문\n';
  writeFileSync(join(root, '.claude/agents/my-helper.md'), handmade);
  writeFileSync(join(root, '.codex/agents/manual.toml'), 'name = "manual"\n');
  writeFileSync(join(root, '.claude/agents/old-1.md'), '---\nname: old-1\n---\n<!-- ai-office:generated 예전 -->\n');
  writeFileSync(join(root, '.codex/agents/old-2.toml'), '# ai-office:generated 예전\nname = "old-2"\n');
  const r = syncAgents(root, { write: true });
  assert.deepEqual(r.removed, ['.claude/agents/old-1.md', '.codex/agents/old-2.toml']);
  assert.equal(read(root, '.claude/agents/my-helper.md'), handmade);
  assert.ok(existsSync(join(root, '.codex/agents/manual.toml')));
});

test('정본 id와 겹치는 표식 없는 파일은 덮어쓰지 않고 충돌로 보고한다', (t) => {
  const root = setup(t, baseOrg());
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  writeFileSync(join(root, '.claude/agents/research-2.md'), '손으로 쓴 파일\n');
  const r = syncAgents(root, { write: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, ['.claude/agents/research-2.md']);
  assert.equal(read(root, '.claude/agents/research-2.md'), '손으로 쓴 파일\n');
  assert.ok(existsSync(join(root, '.claude/agents/research-1.md')));
});

test('검사 모드: 파일을 건드리지 않고 차이만 계산, 반영 후에는 일치', (t) => {
  const org = baseOrg();
  const root = setup(t, org);
  let r = syncAgents(root, { write: false });
  assert.equal(r.ok, false);
  assert.equal(r.diffs.length, 3);
  assert.ok(r.diffs.every((d) => d.kind === 'create'));
  assert.equal(existsSync(join(root, '.claude')), false);

  syncAgents(root, { write: true });
  r = syncAgents(root, { write: false });
  assert.deepEqual({ ok: r.ok, changed: r.changed, removed: r.removed }, { ok: true, changed: [], removed: [] });

  // 두 번째 write는 아무것도 바꾸지 않는다(결정적 출력)
  assert.deepEqual(syncAgents(root, { write: true }).changed, []);

  org.roster[1].instructions = '바뀐 지침';
  writeOrg(root, org);
  r = syncAgents(root, { write: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, ['.claude/agents/research-2.md']);
  assert.equal(r.diffs[0].kind, 'update');
  assert.ok(r.diffs[0].line > 0);
});

test('정본 검증 실패면 아무것도 쓰지 않는다', (t) => {
  const org = baseOrg();
  org.roster[0].department = 'nope';
  const root = setup(t, org);
  const r = syncAgents(root, { write: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.equal(existsSync(join(root, '.claude')), false);
});

test('빈 정본은 생성 파일 없이 일치', (t) => {
  const root = setup(t, { departments: [], roster: [] });
  const r = syncAgents(root, { write: false });
  assert.deepEqual({ ok: r.ok, changed: r.changed, removed: r.removed }, { ok: true, changed: [], removed: [] });
});

test('sync-agents.mjs: --check는 차이가 있으면 종료 코드 1과 내용 출력, --write 후 0', (t) => {
  const root = setup(t, baseOrg());
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });

  let p = run('--check');
  assert.equal(p.status, 1);
  assert.match(p.stdout, /생성 필요: \.claude\/agents\/research-1\.md/);

  p = run('--write');
  assert.equal(p.status, 0, p.stderr);
  // 에이전트 파일 3개 + 작업 공간 생성물(표식·CLAUDE.md·AGENTS.md·스킬·설정·office/codex-review 연결 파일) 7개
  assert.match(p.stdout, /완료: 생성·갱신 10개/);
  assert.match(p.stdout, /생성: \.claude\/settings\.json/);

  p = run('--check');
  assert.equal(p.status, 0);
  assert.match(p.stdout, /일치합니다/);

  writeFileSync(join(root, '.claude/agents/research-2.md'), read(root, '.claude/agents/research-2.md').replace('시장 지침 본문', '손댄 본문'));
  p = run('--check');
  assert.equal(p.status, 1);
  assert.match(p.stdout, /변경 필요: \.claude\/agents\/research-2\.md \(\d+행/);

  p = run();
  assert.equal(p.status, 64);
});
