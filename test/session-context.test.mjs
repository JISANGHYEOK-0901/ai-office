// SessionStart 조직도 주입 훅(hooks/session-context.mjs) 테스트: 실제 프로세스로 실행한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 같은 부하에서 빈 node 프로세스를 띄우는 데 걸리는 시간(앞뒤로 재서 큰 값). 훅 2초 제한 검사에서 Node 기동 시간은 빼고 본다
// (전체 테스트를 병렬로 돌리면 기동만 수백 ms가 걸려 시간 검사가 흔들린다)
function nodeBootMs() {
  const t = Date.now();
  spawnSync(process.execPath, ['-e', '0']);
  return Date.now() - t;
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeRoot(t, org) {
  const root = mkdtempSync(join(tmpdir(), 'office-ctx-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hooks'));
  cpSync(join(REPO, 'hooks', 'session-context.mjs'), join(root, 'hooks', 'session-context.mjs'));
  cpSync(join(REPO, 'lib'), join(root, 'lib'), { recursive: true });
  if (org) {
    mkdirSync(join(root, 'org'));
    writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(org.departments));
    writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(org.roster));
  }
  return root;
}

function run(root, input, env = {}) {
  const e = { ...process.env, ...env };
  delete e.CLAUDE_PROJECT_DIR;
  if (!('OFFICE_ORGMAP_INJECTED' in env)) delete e.OFFICE_ORGMAP_INJECTED;
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(root, 'hooks', 'session-context.mjs')], {
    env: e, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  return { ...res, elapsed: Date.now() - started };
}

const start = (extra = {}) => ({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: '/x', ...extra });

const sampleOrg = {
  departments: [
    { id: 'marketing', name: '마케팅부', engine: 'claude', summary: '시장 조사' },
    { id: 'dev', name: '개발부', engine: 'claude' },
  ],
  roster: [
    { id: 'marketing-1', name: '김팀장', department: 'marketing', title: '팀장', lead: true, specialty: '경쟁사 조사' },
    { id: 'dev-2', name: '최대리', department: 'dev', title: '담당', rank: '대리', specialty: 'HTML 작성' },
    { id: 'dev-3', name: '박사원', department: 'dev', title: '담당', active: false },
  ],
};

test('메인 세션 SessionStart: additionalContext JSON(공식 형식)으로 조직도 주입, 2초 안', (t) => {
  const root = makeRoot(t, sampleOrg);
  const bootBefore = nodeBootMs();
  const res = run(root, start());
  const boot = Math.max(bootBefore, nodeBootMs());
  assert.equal(res.status, 0);
  assert.ok(res.elapsed - boot < 1900, `${res.elapsed}ms (기동 ${boot}ms 제외)`);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  for (const s of ['비서실장', 'marketing-1', '김팀장', 'dev-2', '최대리', '마케팅부', '개발부', 'chief-guard']) assert.ok(ctx.includes(s), s);
  // 휴무 직원은 부를 수 있는 직원으로 보이면 안 된다(표시한다면 휴무 표시와 함께)
  for (const line of ctx.split('\n').filter((l) => l.includes('dev-3'))) assert.ok(line.includes('휴무'), line);
  assert.ok(ctx.length <= 10000, '공식 한도 10,000자 이내');
});

test('resume·compact에서도 주입한다', (t) => {
  const root = makeRoot(t, sampleOrg);
  for (const source of ['resume', 'compact', 'clear']) {
    assert.equal(JSON.parse(run(root, start({ source })).stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  }
});

test('빈 회사: 직원이 없다는 안내를 주입한다', (t) => {
  const root = makeRoot(t, null);
  const ctx = JSON.parse(run(root, start()).stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('대시보드'), ctx);
});

test('큰 조직도는 10,000자 안으로 자른다', (t) => {
  const departments = Array.from({ length: 20 }, (_, i) => ({ id: `dept-${i}`, name: `부서${i}`, engine: 'claude', summary: '가'.repeat(300) }));
  const roster = Array.from({ length: 400 }, (_, i) => ({ id: `dept-${i % 20}-${i}`, name: `직원${i}`, department: `dept-${i % 20}`, title: '담당', specialty: '나'.repeat(150) }));
  const root = makeRoot(t, { departments, roster });
  const ctx = JSON.parse(run(root, start()).stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 10000, String(ctx.length));
  assert.ok(ctx.includes('잘랐습니다'));
});

test('무출력 exit 0: 서브에이전트·--agent 세션, 다른 이벤트, 잘못된 입력, 대시보드 주입 표시, 깨진 정본', (t) => {
  const root = makeRoot(t, sampleOrg);
  const cases = [
    [start({ agent_type: 'dev-2' })],
    [start({ hook_event_name: 'PreToolUse' })],
    [''], ['not json'], ['[]'], ['null'],
    [start(), { OFFICE_ORGMAP_INJECTED: '1' }],
  ];
  for (const [input, env] of cases) {
    const res = run(root, input, env);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', JSON.stringify(input));
  }
  writeFileSync(join(root, 'org', 'roster.json'), '{깨짐');
  const broken = run(root, start());
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
});
