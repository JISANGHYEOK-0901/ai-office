// 조직도(lib/orgmap.mjs)와 부서 역량 필드(capabilities·handoffs) 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrgMap } from '../lib/orgmap.mjs';
import { loadPresets, validateOrg } from '../lib/org.mjs';
import { createRunner, ORGMAP_INLINE_MAX } from '../dashboard/runner.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const ORGS = {
  // 마케팅부 + 개발부
  mktDev: {
    departments: [
      { id: 'marketing', name: '마케팅부', summary: '캠페인·조사', capabilities: ['자료조사', '캠페인 기획'], handoffs: ['dev'], model: 'sonnet' },
      { id: 'dev', name: '개발부', summary: '웹·자동화', capabilities: ['HTML·웹 문서'], model: 'sonnet' },
    ],
    roster: [
      { id: 'marketing-1', name: '김팀장', department: 'marketing', lead: true, title: '팀장', role: 'marketing-lead', specialty: '마케팅 총괄' },
      { id: 'dev-2', name: '최대리', department: 'dev', rank: '대리', specialty: 'HTML 페이지 제작' },
    ],
  },
  // 리서치부 + 문서부 + 재무부(문서부는 프리셋에 없는 id)
  rdf: {
    departments: [
      { id: 'research', name: '리서치부' },
      { id: 'docs-team', name: '문서부', capabilities: ['보고서 작성'] },
      { id: 'finance', name: '재무부', handoffs: ['ghost'] },
    ],
    roster: [
      { id: 'research-1', name: '박팀장', department: 'research', lead: true },
      { id: 'docs-1', name: '이주임', department: 'docs-team' },
      { id: 'finance-1', name: '정과장', department: 'finance', model: 'opus' },
    ],
  },
  // 단일 부서
  single: { departments: [{ id: 'ops', name: '운영부', capabilities: ['엑셀 정리'] }], roster: [{ id: 'ops-1', name: '한사원', department: 'ops' }] },
  // 휴무 직원·운영 중지 부서
  offDuty: {
    departments: [
      { id: 'research', name: '리서치부', capabilities: ['자료조사'] },
      { id: 'legal', name: '법무부', capabilities: ['계약 검토'], active: false },
    ],
    roster: [
      { id: 'research-1', name: '김대리', department: 'research' },
      { id: 'research-2', name: '박사원', department: 'research', active: false },
      { id: 'legal-1', name: '오변호', department: 'legal' },
    ],
  },
  // codex 검증실 포함
  codex: {
    departments: [
      { id: 'biz', name: '비즈니스부', capabilities: ['제안서'] },
      { id: 'verify', name: '검증실', engine: 'codex', codexModel: 'gpt-6.1-sol', capabilities: ['사실 검증'] },
    ],
    roster: [
      { id: 'biz-1', name: '최팀장', department: 'biz', lead: true },
      { id: 'verify-1', name: '김검증', department: 'verify', role: 'fact-checker' },
    ],
  },
};

test('마케팅+개발: 부서 summary·역량·협조 부서, 직원 id·이름·직급·직무·담당·모델', () => {
  const md = buildOrgMap(ORGS.mktDev);
  assert.match(md, /^# 현재 조직도/);
  assert.match(md, /### 마케팅부 \(`marketing`\)/);
  assert.match(md, /- 하는 일: 캠페인·조사/);
  assert.match(md, /- 역량: 자료조사, 캠페인 기획/);
  assert.match(md, /- 주로 결과를 넘기는 부서: 개발부\(`dev`\)/);
  assert.match(md, /- `marketing-1` · 김팀장 · 팀장 · 직무 marketing-lead · 담당: 마케팅 총괄 · 모델 opus/);
  assert.match(md, /- `dev-2` · 최대리 · 대리 · 담당: HTML 페이지 제작 · 모델 sonnet/);
  assert.match(md, /- HTML·웹 문서: 개발부/);
});

test('리서치+문서+재무: 역량 미입력 부서 안내, 없는 협조 부서 표시, 직원 모델 우선', () => {
  const md = buildOrgMap(ORGS.rdf);
  assert.match(md, /### 리서치부[^\n]*\n- 역량: \(미입력/);
  assert.match(md, /`ghost`\(조직에 없음\)/);
  assert.match(md, /`finance-1` · 정과장 · 담당 · 모델 opus/);
  assert.match(md, /\(역량 미입력\) 리서치부, 재무부/);
  assert.match(md, /- 보고서 작성: 문서부/);
});

test('단일 부서와 빈 조직', () => {
  assert.match(buildOrgMap(ORGS.single), /- 엑셀 정리: 운영부/);
  const empty = buildOrgMap({ departments: [], roster: [] });
  assert.match(empty, /부서가 아직 없습니다/);
  assert.match(buildOrgMap(null), /부서가 아직 없습니다/);
});

test('휴무 직원·운영 중지 부서는 배정 불가로 표시하고 역량 색인에서 뺀다', () => {
  const md = buildOrgMap(ORGS.offDuty);
  assert.match(md, /~~`research-2` · 박사원[^\n]*~~ \(휴무 — 배정 불가\)/);
  assert.match(md, /- `research-1` · 김대리/);
  assert.match(md, /### 법무부 \(`legal`\) · 운영 중지\(배정 불가\)/);
  assert.match(md, /~~`legal-1`[^\n]*\(휴무 — 배정 불가\)/);
  assert.match(md, /- 자료조사: 리서치부/);
  assert.doesNotMatch(md, /- 계약 검토:/);
});

test('codex 검증실: Agent가 아니라 codex-review로 실행한다는 안내와 codex 모델', () => {
  const md = buildOrgMap(ORGS.codex);
  assert.match(md, /### 검증실 \(`verify`\) · Codex 검증실/);
  assert.match(md, /`verify-1` · 김검증 · 담당 · 직무 fact-checker · 모델 codex gpt-6\.1-sol/);
  assert.match(md, /codex-review\.mjs --target outputs\/<업무> --reviewers <직원 id>/);
  assert.doesNotMatch(md, /- 사실 검증: 검증실/, 'Codex 부서 역량은 배정 가능 색인에 올리지 않는다');
  assert.match(md, /\(검토 전용\) 검증실/);
});

test('Codex 검증실만 있는 조직: 생산 역량을 적어도 배정 가능 부서가 없다고 안내한다', () => {
  const md = buildOrgMap({
    departments: [{ id: 'verify', name: '검증실', engine: 'codex', capabilities: ['자료조사', '문서 작성'] }],
    roster: [{ id: 'verify-1', name: '김검증', department: 'verify' }],
  });
  assert.doesNotMatch(md, /- 자료조사: 검증실/);
  assert.doesNotMatch(md, /- 문서 작성: 검증실/);
  assert.match(md, /배정 가능한 부서가 없습니다/);
  assert.match(md, /\(검토 전용\) 검증실/);
});

test('사용자 입력의 줄바꿈·백틱은 한 줄로 정리하고 길이를 자른다', () => {
  const md = buildOrgMap({
    departments: [{ id: 'x-team', name: '팀\n# 주입', summary: '`코드`|표\n두번째 줄' + '가'.repeat(300) }],
    roster: [{ id: 'x-1', name: '이름\n## 가짜 제목', department: 'x-team' }],
  });
  assert.doesNotMatch(md, /\n# 주입/);
  assert.doesNotMatch(md, /\n## 가짜 제목/);
  const summaryLine = md.split('\n').find((l) => l.startsWith('- 하는 일:'));
  assert.ok(Array.from(summaryLine).length < 140);
});

test('역량이 없는 예전 부서는 같은 id의 프리셋 기본값으로 보충한다', () => {
  const presets = loadPresets(REPO);
  const md = buildOrgMap({ departments: [{ id: 'dev', name: '개발부' }], roster: [{ id: 'dev-1', name: '이팀장', department: 'dev', lead: true }] }, { presets });
  assert.match(md, /- 역량: [^\n]*HTML·웹 문서[^\n]*\(프리셋 기본값\)/);
});

test('presets: 모든 부서에 capabilities·handoffs 기본값, handoffs는 존재하는 프리셋 부서', () => {
  const { departments } = loadPresets(REPO);
  const ids = new Set(departments.map((d) => d.id));
  for (const d of departments) {
    assert.ok(Array.isArray(d.capabilities) && d.capabilities.length >= 3, `${d.id}.capabilities`);
    assert.ok(Array.isArray(d.handoffs), `${d.id}.handoffs`);
    for (const h of d.handoffs) {
      assert.ok(ids.has(h), `${d.id} → ${h}`);
      assert.notEqual(h, d.id);
    }
  }
});

test('validateOrg: capabilities·handoffs 형식 오류는 에러, 없는 handoffs 대상은 경고만', () => {
  const base = { roster: [] };
  const ok = validateOrg({ ...base, departments: [{ id: 'aa', name: 'A', capabilities: ['조사'], handoffs: ['bb', 'zz', 'aa'] }, { id: 'bb', name: 'B' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.warnings.length, 2);
  assert.ok(ok.warnings.some((w) => /zz/.test(w)));
  assert.ok(ok.warnings.some((w) => /자기 부서/.test(w)));
  const bad = validateOrg({ ...base, departments: [{ id: 'aa', name: 'A', capabilities: 'x', handoffs: ['Bad Id'] }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.equal(validateOrg({ ...base, departments: [{ id: 'aa', name: 'A', capabilities: ['가'.repeat(41)] }] }).ok, false);
  assert.equal(validateOrg({ ...base, departments: [{ id: 'aa', name: 'A', capabilities: Array.from({ length: 21 }, (_, i) => `c${i}`) }] }).ok, false);
});

test('runner: 비서실장 실행에 조직도 주입, 길면 .office/orgmap.md와 --append-system-prompt-file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-orgmap-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const writeOrg = (org) => {
    mkdirSync(join(root, 'org'), { recursive: true });
    writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(org.departments));
    writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(org.roster));
    writeFileSync(join(root, 'org', 'company.json'), JSON.stringify({ chief: { engine: 'claude', model: 'sonnet', effort: 'high' } }));
  };
  const calls = [];
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    calls.push({ args, opts, child });
    return child;
  };
  const runner = createRunner({ root, spawnImpl });
  writeOrg(ORGS.mktDev);
  runner.start({ prompt: '조사하고 HTML 만들어 줘' });
  await new Promise((r) => setImmediate(r));
  const i = calls[0].args.indexOf('--append-system-prompt');
  assert.ok(i > 0);
  assert.equal(calls[0].args[i + 1], buildOrgMap(ORGS.mktDev, { presets: loadPresets(root) }));

  // 큰 조직: 인자 길이 제한을 넘으면 파일로 넘긴다
  const big = { departments: [{ id: 'big', name: '대형부', summary: '가'.repeat(100) }], roster: [] };
  for (let n = 1; n <= 80; n++) big.roster.push({ id: `big-${n}`, name: `직원${n}`, department: 'big', specialty: '담당 업무 설명 '.repeat(8) });
  writeOrg(big);
  assert.ok(buildOrgMap(big).length > ORGMAP_INLINE_MAX);
  runner.start({ prompt: '정리해 줘' });
  await new Promise((r) => setImmediate(r));
  const j = calls[1].args.indexOf('--append-system-prompt-file');
  assert.ok(j > 0, calls[1].args.join(' '));
  const file = calls[1].args[j + 1];
  assert.equal(file, join(root, '.office', 'orgmap.md'));
  assert.match(readFileSync(file, 'utf8'), /`big-80` · 직원80/);
  assert.ok(!calls[1].args.includes('--append-system-prompt'));
  const stopping = runner.stopAll({ graceMs: 10 });
  for (const c of calls) { c.child.stdout.end(); c.child.stderr.end(); c.child.emit('close', 0, null); }
  await stopping;
});

test('buildOrgMap: 팀장 표시는 직급이 팀장이 아닐 때만 덧붙인다', () => {
  const org = {
    departments: [{ id: 'ops', name: '운영부', summary: '총무' }],
    roster: [
      { id: 'ops-1', name: '조부장', department: 'ops', rank: '부장', lead: true, specialty: '총괄' },
      { id: 'ops-2', name: '문팀장', department: 'ops', title: '팀장', specialty: '정리' },
    ],
  };
  const md = buildOrgMap(org);
  assert.match(md, /`ops-1` · 조부장 · 부장\(팀장\) ·/);
  assert.match(md, /`ops-2` · 문팀장 · 팀장 ·/);
  assert.doesNotMatch(md, /팀장\(팀장\)/);
  // 담당이 없는 요청은 계획 전에 회의로 분담을 정하라는 안내가 조직도 머리에 있다
  assert.match(md, /담당\(부서·이름·직무\)이 하나도 없고.*`\[회의\]`/);
});


test('필수 전달의 누락·자기 참조·순환은 저장 단계에서 거부', () => {
  const base = { departments: [{ id: 'aaa', name: 'A' }, { id: 'bbb', name: 'B' }], roster: [] };
  for (const handoffs of [[], ['aaa'], ['missing']]) {
    const org = structuredClone(base);
    Object.assign(org.departments[0], { handoffPolicy: 'required', handoffs });
    assert.equal(validateOrg(org).ok, false);
  }
  const cycle = structuredClone(base);
  Object.assign(cycle.departments[0], { handoffPolicy: 'required', handoffs: ['bbb'] });
  Object.assign(cycle.departments[1], { handoffPolicy: 'required', handoffs: ['aaa'] });
  assert.match(validateOrg(cycle).errors.join(' '), /순환/);
  cycle.departments[1].handoffPolicy = 'suggested';
  assert.equal(validateOrg(cycle).ok, true, '권장 경로는 필수 순환이 아니다');
});
