import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg, loadPresets, mutateOrg, saveOrg, slugifyId, validateOrg } from '../lib/org.mjs';
import { kstDate, officeDir, repoRoot } from '../lib/paths.mjs';

const REPO = repoRoot();

function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-office-org-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const dept = (over = {}) => ({ id: 'research', name: '리서치부', en: 'RESEARCH', engine: 'claude', model: 'sonnet', ...over });
const agent = (over = {}) => ({ id: 'research-1', name: '김대리', department: 'research', title: '담당', lead: false, instructions: '조사한다.', ...over });

test('paths: kstDate는 한국 시간 기준 날짜', () => {
  assert.equal(kstDate(new Date('2026-10-28T15:30:00Z')), '2026-10-29');
  assert.equal(kstDate(new Date('2026-10-28T14:59:59Z')), '2026-10-28');
});

test('paths: officeDir는 .office를 만든다', (t) => {
  const root = tempRoot(t);
  const dir = officeDir(root);
  assert.equal(dir, join(root, '.office'));
  assert.ok(existsSync(dir));
});

test('loadOrg: 파일이 없으면 빈 배열', (t) => {
  assert.deepEqual(loadOrg(tempRoot(t)), { departments: [], roster: [] });
});

test('loadOrg: 배열이 아니면 예외', (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), '{}');
  assert.throws(() => loadOrg(root), /배열/);
});

// 실제로 쓰는 중인 레포에는 사용자 정본이 있을 수 있다. 처음 받은 상태(Git이 추적하는 파일만)를 기준으로 검사한다
test('저장소 초기 정본은 빈 회사', (t) => {
  const res = spawnSync('git', ['ls-files', '--', 'org/departments.json', 'org/roster.json', 'org/company.md'], { cwd: REPO, encoding: 'utf8' });
  if (res.error || res.status !== 0) t.diagnostic('git 저장소가 아니어서 추적 여부 검사는 건너뜀');
  else assert.equal(res.stdout.trim(), '', '정본 파일은 Git이 추적하지 않는다(받으면 빈 회사)');
  // 받은 직후와 같은 폴더(org/에 presets.json·templates만 있음)는 빈 회사로 읽힌다
  const root = tempRoot(t);
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'presets.json'), readFileSync(join(REPO, 'org', 'presets.json')));
  assert.deepEqual(loadOrg(root), { departments: [], roster: [] });
});

test('validateOrg: 정상 정본은 통과', () => {
  const r = validateOrg({ departments: [dept()], roster: [agent({ lead: true }), agent({ id: 'research-2' })] });
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

test('validateOrg: 검사 항목별 오류', () => {
  const cases = [
    [{ departments: [dept({ id: 'Bad_ID' })], roster: [] }, /id 형식/],
    [{ departments: [dept({ id: 'r' })], roster: [] }, /id 형식/],
    [{ departments: [dept(), dept()], roster: [] }, /부서 id가 중복/],
    [{ departments: [dept()], roster: [agent(), agent()] }, /직원 id가 중복/],
    [{ departments: [dept()], roster: [agent({ department: 'nope' })] }, /소속 부서가 없습니다/],
    [{ departments: [dept()], roster: [agent({ lead: true }), agent({ id: 'research-2', lead: true })] }, /팀장은 1명/],
    [{ departments: [dept({ engine: 'gpt' })], roster: [] }, /engine/],
    [{ departments: [dept({ permission: 'yolo' })], roster: [] }, /permission/],
    [{ departments: [dept({ name: '가'.repeat(41) })], roster: [] }, /40자/],
    [{ departments: [dept()], roster: [agent({ name: '' })] }, /이름이 비어/],
    [{ departments: [dept()], roster: [agent({ instructions: 'a'.repeat(4001) })] }, /4000자/],
    [{ departments: [dept({ tools: 'Read' })], roster: [] }, /tools/],
    [{ departments: {}, roster: [] }, /배열/],
  ];
  for (const [org, re] of cases) {
    const r = validateOrg(org);
    assert.equal(r.ok, false, `통과하면 안 됨: ${re}`);
    assert.ok(r.errors.some((e) => re.test(e)), `${re} 기대, 실제: ${r.errors.join(' | ')}`);
  }
});

test('validateOrg: permission 허용값과 팀장 없는 부서(chief 등)는 통과', () => {
  for (const permission of ['acceptEdits', 'bypassPermissions', 'default']) {
    assert.ok(validateOrg({ departments: [dept({ permission })], roster: [] }).ok);
  }
  assert.ok(validateOrg({ departments: [dept({ id: 'chief', name: '비서실' })], roster: [agent({ id: 'chief-1', department: 'chief' })] }).ok);
});

test('saveOrg: 검증 실패 시 예외를 던지고 파일을 쓰지 않는다', (t) => {
  const root = tempRoot(t);
  assert.throws(() => saveOrg(root, { departments: [dept({ id: 'X' })], roster: [] }), (err) => {
    assert.match(err.message, /검증 실패/);
    assert.ok(Array.isArray(err.errors) && err.errors.length > 0);
    return true;
  });
  assert.equal(existsSync(join(root, 'org', 'departments.json')), false);
});

test('saveOrg: 원자적으로 저장하고 sync 결과를 반환한다', (t) => {
  const root = tempRoot(t);
  const result = saveOrg(root, { departments: [dept()], roster: [agent()] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ['.claude/agents/research-1.md']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'org', 'roster.json'), 'utf8')), [agent()]);
  assert.ok(existsSync(join(root, '.claude', 'agents', 'research-1.md')));
  // 임시 파일이 남지 않는다
  assert.deepEqual(readdirSync(join(root, 'org')).filter((f) => f.endsWith('.tmp')), []);
});

test('mutateOrg: 동시 호출을 순서대로 직렬 처리한다', async (t) => {
  const root = tempRoot(t);
  saveOrg(root, { departments: [dept()], roster: [] });
  const jobs = Array.from({ length: 6 }, (_, i) =>
    mutateOrg(root, async (org) => {
      await new Promise((r) => setTimeout(r, 6 - i));
      const id = slugifyId('research', org.roster.map((a) => a.id));
      org.roster.push(agent({ id, name: `직원${i}` }));
      return id;
    }),
  );
  const results = await Promise.all(jobs);
  assert.deepEqual(results.map((r) => r.result), ['research-1', 'research-2', 'research-3', 'research-4', 'research-5', 'research-6']);
  assert.equal(loadOrg(root).roster.length, 6);
  assert.equal(results[5].sync.ok, true);
});

test('mutateOrg: fn이 실패하면 저장하지 않고 다음 작업은 계속된다', async (t) => {
  const root = tempRoot(t);
  saveOrg(root, { departments: [dept()], roster: [] });
  const bad = mutateOrg(root, (org) => {
    org.roster.push(agent());
    throw new Error('중단');
  });
  const invalid = mutateOrg(root, (org) => {
    org.roster.push(agent({ department: 'nope' }));
  });
  const good = mutateOrg(root, (org) => ({ ...org, departments: [...org.departments, dept({ id: 'finance', name: '재무부' })] }));
  await assert.rejects(bad, /중단/);
  await assert.rejects(invalid, /검증 실패/);
  const r = await good;
  assert.deepEqual(r.org.departments.map((d) => d.id), ['research', 'finance']);
  assert.equal(loadOrg(root).roster.length, 0);
});

test('slugifyId: 순번 부여, 한글 제거, 길이 제한', () => {
  assert.equal(slugifyId('research', []), 'research-1');
  assert.equal(slugifyId('research', ['research-1', 'research-2']), 'research-3');
  assert.equal(slugifyId('research', new Set(['research-1'])), 'research-2');
  assert.equal(slugifyId('Research 김대리', []), 'research-1');
  assert.equal(slugifyId('research-kim', []), 'research-kim-1');
  assert.equal(slugifyId('김대리', []), 'agent-1');
  assert.equal(slugifyId('2025 plan', []), 'a-2025-plan-1');
  const long = slugifyId('a'.repeat(80), []);
  assert.ok(long.length <= 48);
  assert.match(long, /^[a-z][a-z0-9-]{1,47}$/);
});

test('presets: 12개 부서와 직무 프리셋 규칙', () => {
  const { departments } = loadPresets(REPO);
  const ids = departments.map((d) => d.id);
  assert.deepEqual(ids, ['dev', 'creative', 'marketing', 'business', 'ops', 'review', 'research', 'legal', 'invest', 'life', 'finance', 'verify']);
  const keys = new Set();
  for (const d of departments) {
    for (const f of ['name', 'en', 'color', 'engine', 'tools', 'model', 'permission', 'summary']) {
      assert.ok(f in d, `${d.id}.${f} 누락`);
    }
    assert.match(d.color, /^#[0-9a-f]{6}$/i);
    assert.ok(d.roles.length >= 4 && d.roles.length <= 8, `${d.id} 직무 수 ${d.roles.length}`);
    assert.equal(d.roles.filter((r) => r.lead).length, 1, `${d.id} 팀장 프리셋은 1개`);
    for (const r of d.roles) {
      assert.match(r.key, /^[a-z][a-z0-9-]{1,47}$/);
      assert.ok(!keys.has(r.key), `직무 key 중복: ${r.key}`);
      keys.add(r.key);
      for (const f of ['specialty', 'description', 'instructions']) assert.ok(r[f]?.trim(), `${r.key}.${f} 누락`);
      assert.ok(r.instructions.length <= 4000);
      assert.ok(Array.isArray(r.thoughts) && r.thoughts.length >= 2 && r.thoughts.length <= 3, `${r.key}.thoughts`);
    }
  }
  const verify = departments.find((d) => d.id === 'verify');
  assert.equal(verify.engine, 'codex');
  assert.deepEqual(verify.roles.map((r) => r.key), ['verification-lead', 'fact-checker', 'number-auditor', 'document-qa', 'code-reviewer']);
  for (const r of verify.roles) {
    assert.match(r.instructions, /VERDICT: PASS/);
    assert.match(r.instructions, /읽기 전용/);
  }
  assert.ok(departments.filter((d) => d.id !== 'verify').every((d) => d.engine === 'claude'));
});

test('presets로 만든 전체 조직이 검증을 통과한다', () => {
  const { departments } = loadPresets(REPO);
  const org = { departments: [], roster: [] };
  for (const { roles, ...d } of departments) {
    org.departments.push(d);
    for (const r of roles) {
      const id = slugifyId(d.id, org.roster.map((a) => a.id));
      org.roster.push({ id, name: r.name, department: d.id, title: r.lead ? '팀장' : '담당', lead: Boolean(r.lead), specialty: r.specialty, description: r.description, instructions: r.instructions, thoughts: r.thoughts });
    }
  }
  assert.deepEqual(validateOrg(org), { ok: true, errors: [], warnings: [] });
});
