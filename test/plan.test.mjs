// 작업 계획표 검사(lib/plan.mjs)와 office.mjs plan validate / flow / meeting CLI
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compactPlan, isTaskId, normalizePlanInputs, validatePlan } from '../lib/plan.mjs';
import { kstDate, repoRoot } from '../lib/paths.mjs';

const SCRIPT = join(repoRoot(), 'scripts', 'office.mjs');
const ROOT = resolve('/tmp/office-plan-root');
const TASK = '2026-10-29/html-page';

const ORG = {
  departments: [
    { id: 'marketing', name: '마케팅부' },
    { id: 'dev', name: '개발부' },
    { id: 'docs-team', name: '문서부' },
    { id: 'legal', name: '법무부', active: false },
    { id: 'verify', name: '검증실', engine: 'codex' },
  ],
  roster: [
    { id: 'marketing-1', name: '김팀장', department: 'marketing', lead: true },
    { id: 'dev-2', name: '최대리', department: 'dev' },
    { id: 'dev-3', name: '휴무씨', department: 'dev', active: false },
    { id: 'docs-1', name: '이주임', department: 'docs-team' },
    { id: 'legal-1', name: '오변호', department: 'legal' },
    { id: 'verify-1', name: '김검증', department: 'verify' },
  ],
};

const goodPlan = () => ({
  version: 1,
  task: TASK,
  goal: '중고명품 조사 후 HTML 페이지',
  stages: [
    { id: 's1', title: '시장 조사', dept: 'marketing', agent: 'marketing-1', inputs: [], output: 'marketing/research.md', done: '출처 5개 이상', dependsOn: [] },
    { id: 's2', title: 'HTML 작성', dept: 'dev', agent: 'dev-2', inputs: ['s1', `outputs/${TASK}/marketing/research.md`, 'brief.md'], output: `outputs/${TASK}/dev/index.html`, done: '브라우저에서 열림', dependsOn: ['s1'], parallelGroup: 'g1' },
  ],
  review: { by: 'chief', criteria: '출처·링크 확인' },
  gaps: [{ need: '디자인', suggestion: '크리에이티브부 추가 권장' }],
});

const existing = new Set([resolve(ROOT, 'outputs', '2026-10-29', 'html-page', 'brief.md')]);
const check = (plan, org = ORG, taskId = TASK) => validatePlan(plan, { org, taskId, root: ROOT, fileExists: (p) => existing.has(p) });

test('작업 공간의 실제 원본 상대 입력과 업무 상대·절대·앞 단계 입력을 함께 해석한다', () => {
  const p = goodPlan();
  const source = resolve(ROOT, '.office/simulation-inputs/2026-10-30/market.json');
  const files = new Set([...existing, source]);
  const options = { root: ROOT, taskId: TASK, org: ORG, fileExists: (path) => files.has(path) };
  p.stages[0].inputs = ['.office/simulation-inputs/2026-10-30/market.json', source];
  assert.equal(validatePlan(p, options).ok, true);
  const normalized = normalizePlanInputs(p, options);
  assert.deepEqual(normalized.stages[0].inputs, [source, source]);
  assert.deepEqual(normalized.stages[1].inputs, ['s1', resolve(ROOT, `outputs/${TASK}/marketing/research.md`), resolve(ROOT, `outputs/${TASK}/brief.md`)]);
  assert.equal(validatePlan(normalized, options).ok, true);
  assert.equal(p.stages[0].inputs[0], '.office/simulation-inputs/2026-10-30/market.json');
});

test('동명 원본은 기존 업무 상대 경로가 우선이며 없는 입력은 검사한 경로를 알린다', () => {
  const p = goodPlan(); p.stages[0].inputs = ['brief.md'];
  const files = new Set([...existing, resolve(ROOT, 'brief.md')]);
  const options = { root: ROOT, taskId: TASK, org: ORG, fileExists: (path) => files.has(path) };
  assert.deepEqual(normalizePlanInputs(p, options).stages[0].inputs, [resolve(ROOT, `outputs/${TASK}/brief.md`)]);
  p.stages[0].inputs = ['missing/source.json'];
  const diagnostic = validatePlan(p, options).errors.join('\n');
  const expected = `확인 경로: ${resolve(ROOT, `outputs/${TASK}/missing/source.json`)}, ${resolve(ROOT, 'missing/source.json')}`;
  assert.ok(diagnostic.includes(expected), diagnostic);
  p.stages[0].inputs = ['/outside/secret.json'];
  assert.match(validatePlan(p, options).errors.join('\n'), /레포 밖/);
});

test('최종 전달 목록은 계획의 단계 id·산출물만 허용하고 빈 첨부 목록도 저장한다', () => {
  for (const deliverables of [[], ['s2'], [`outputs/${TASK}/dev/index.html`]]) assert.equal(check({ ...goodPlan(), deliverables }).ok, true);
  for (const deliverables of [['없는단계'], ['../../비밀.txt'], 's2', [null]]) {
    const result = check({ ...goodPlan(), deliverables });
    assert.equal(result.ok, false); assert.ok(result.errors.some((message) => message.includes('deliverables')));
  }
});

test('단계 산출물 이름이 report·summary·findings·analysis로 시작하는 .md면 거부한다(서브에이전트 쓰기 차단)', () => {
  for (const name of ['summary.md', 'Report-final.md', 'findings.md', 'ANALYSIS_v2.md']) {
    const plan = goodPlan();
    plan.stages[0].output = `marketing/${name}`;
    const r = check(plan);
    assert.equal(r.ok, false, name);
    assert.ok(r.errors.some((e) => e.includes('Claude Code 제한') && e.includes(`marketing-1-${name}`)), r.errors.join('\n'));
  }
  // 직원 id를 앞에 붙이거나 .md가 아니면 통과
  for (const name of ['marketing-1-summary.md', 'dept-report.md', 'summary.html', 'research.md']) {
    const plan = goodPlan();
    plan.stages[0].output = `marketing/${name}`;
    plan.stages[1].inputs = ['s1'];
    assert.deepEqual(check(plan).errors, [], name);
  }
});

test('정상 계획표: 통과, 경로는 레포·업무 폴더 기준 모두 허용, 이벤트용 요약', () => {
  const r = check(goodPlan());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.plan.task, TASK);
  assert.deepEqual(r.plan.stages.map((s) => [s.id, s.agent, s.output]), [
    ['s1', 'marketing-1', `outputs/${TASK}/marketing/research.md`],
    ['s2', 'dev-2', `outputs/${TASK}/dev/index.html`],
  ]);
  assert.equal(r.plan.stages[1].parallelGroup, 'g1');
  assert.deepEqual(r.plan.gaps, [{ need: '디자인', suggestion: '크리에이티브부 추가 권장' }]);
});

test('실패 사유: 없는 직원·휴무·부서 불일치·운영 중지 부서', () => {
  const p = goodPlan();
  p.stages[0].agent = 'ghost-1';
  p.stages[1].agent = 'dev-3';
  let r = check(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /단계 s1: 직원 "ghost-1"가 조직에 없습니다\. 근무중 직원: marketing-1, dev-2, docs-1, verify-1/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /단계 s2: 직원 dev-3\(휴무씨\)는 휴무 중/.test(e)));
  const q = goodPlan();
  q.stages[1].dept = 'marketing';
  q.stages.push({ id: 's3', title: '법무', dept: 'legal', agent: 'legal-1', output: 'legal.md', done: 'x', dependsOn: ['s2'] });
  r = check(q);
  assert.ok(r.errors.some((e) => /단계 s2: 직원 dev-2는 marketing 소속이 아닙니다/.test(e)));
  assert.ok(r.errors.some((e) => /단계 s3: 부서 legal는 운영 중지/.test(e)));
});

test('실패 사유: 순환 의존, 없는 의존 단계, 자기 의존', () => {
  const p = goodPlan();
  p.stages[0].dependsOn = ['s2'];
  let r = check(p);
  assert.ok(r.errors.some((e) => /순환이 있습니다: s1 → s2 → s1|순환이 있습니다: s2 → s1 → s2/.test(e)), r.errors.join('\n'));
  const q = goodPlan();
  q.stages[1].dependsOn = ['s1', 'zz', 's2'];
  r = check(q);
  assert.ok(r.errors.some((e) => /dependsOn의 단계 zz가 없습니다/.test(e)));
  assert.ok(r.errors.some((e) => /자기 자신에 의존/.test(e)));
});

test('실패 사유: output이 업무 폴더 밖, inputs가 앞 단계 산출물도 기존 파일도 아님, 뒤 단계 산출물', () => {
  const p = goodPlan();
  p.stages[0].output = '../../../etc/passwd';
  p.stages[1].output = 'outputs/2026-10-29/other-task/x.md';
  let r = check(p);
  assert.ok(r.errors.some((e) => /단계 s1: output은 outputs\/2026-10-29\/html-page\/ 안이어야/.test(e)));
  assert.ok(r.errors.some((e) => /단계 s2: output은/.test(e)));
  const q = goodPlan();
  q.stages[1].inputs = ['missing.csv', '/etc/hosts'];
  q.stages[0].inputs = ['dev/index.html', 's2'];
  r = check(q);
  assert.ok(r.errors.some((e) => /입력 missing\.csv이 앞 단계 산출물도 아니고 존재하는 파일도 아닙니다/.test(e)));
  assert.ok(r.errors.some((e) => /입력 \/etc\/hosts은 레포 밖 경로/.test(e)));
  assert.ok(r.errors.some((e) => /단계 s1: 입력 dev\/index\.html은 단계 s2의 산출물입니다/.test(e)));
  assert.ok(r.errors.some((e) => /단계 s1: 입력 s2은 앞 단계가 아닙니다/.test(e)));
});

test('실패 사유: 형식(version·task·goal·stages·필수 필드·review·gaps)과 codex 직원 경고', () => {
  assert.deepEqual(check(null).errors, ['plan.json은 JSON 객체여야 합니다.']);
  assert.equal(validatePlan(goodPlan(), { org: ORG, taskId: '../x' }).ok, false);
  let r = check({ version: 2, task: 'x', goal: '', stages: [] });
  assert.ok(r.errors.some((e) => /version은 1/.test(e)));
  assert.ok(r.errors.some((e) => /task가 업무 id와 다릅니다/.test(e)));
  assert.ok(r.errors.some((e) => /goal/.test(e)));
  assert.ok(r.errors.some((e) => /stages/.test(e)));
  const p = goodPlan();
  delete p.stages[0].done;
  p.stages[0].title = ' ';
  p.stages[1].id = 's1';
  p.review = { by: 'nobody' };
  p.gaps = [{ suggestion: 'x' }];
  r = check(p);
  for (const re of [/title/, /done\(완료 기준\)/, /id가 중복/, /review\.by nobody/, /gaps는/]) assert.ok(r.errors.some((e) => re.test(e)), `${re}\n${r.errors.join('\n')}`);
  const c = goodPlan();
  c.stages.push({ id: 'v', title: '검증', dept: 'verify', agent: 'verify-1', output: 'reviews/v.md', done: 'PASS', dependsOn: ['s2'] });
  r = check(c);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /codex-review\.mjs --reviewers verify-1/.test(w)));
  // Codex 직원에게 산출물(생산) 단계를 맡기면 오류: 읽기 전용이라 output을 만들 수 없다
  const prod = goodPlan();
  prod.stages[0] = { ...prod.stages[0], dept: 'verify', agent: 'verify-1', output: 'verify/verify-1-notes.md' };
  r = check(prod);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /읽기 전용 검토.*산출물 단계를 맡을 수 없습니다/.test(e)), r.errors.join('\n'));
});

test('업무 id 형식과 요약(compactPlan)의 비밀값 가림', () => {
  assert.equal(isTaskId('2026-10-29/abc-1'), true);
  assert.equal(isTaskId('2026-10-29/../x'), false);
  assert.equal(isTaskId('x/y'), false);
  const c = compactPlan({ goal: 'token=abcd1234 로그인', stages: [] }, { taskId: TASK, root: ROOT });
  assert.doesNotMatch(c.goal, /abcd1234/);
});

// ---- CLI ----
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(ORG.departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(ORG.roster));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });
  const events = () => readFileSync(join(root, '.office', 'events.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  return { root, run, events };
}

test('CLI plan validate: 실패하면 사유·종료 코드 1, 고치면 통과하고 plan.set 기록', (t) => {
  const { root, run, events } = setup(t);
  const start = run('task', 'start', 'HTML 페이지', '--slug', 'html-page');
  assert.equal(start.status, 0, start.stderr);
  const id = `${kstDate()}/html-page`;
  const dir = join(root, 'outputs', id);
  const plan = goodPlan();
  plan.task = id;
  plan.stages[1].inputs = ['s1', 'brief.md'];
  plan.stages[1].output = 'dev/index.html';
  plan.stages[1].agent = 'dev-3';
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  let r = run('plan', 'validate', id);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /계획표 검사 실패/);
  assert.match(r.stderr, /휴무 중/);
  assert.ok(!events().some((e) => e.kind === 'plan.set'));

  plan.stages[1].agent = 'dev-2';
  writeFileSync(join(dir, 'plan.json'), '﻿' + JSON.stringify(plan));
  r = run('plan', 'validate', id);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /계획표 검사 통과: 단계 2개, 역량 공백 1건/);
  const set = events().find((e) => e.kind === 'plan.set');
  assert.equal(set.task, id);
  assert.deepEqual(set.plan.stages.map((s) => s.agent), ['marketing-1', 'dev-2']);
  assert.equal(set.plan.gaps.length, 1);

  writeFileSync(join(dir, 'plan.json'), '{ 깨진');
  r = run('plan', 'validate', id);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /JSON 형식이 아닙니다/);
  assert.equal(run('plan', 'validate', '../etc').status, 64);
  assert.equal(run('plan', 'validate', `${kstDate()}/none`).status, 1);
});

test('CLI flow·meeting: 이벤트 kind·필드, deliver는 task status review, 잘못된 부서·옵션은 오류', (t) => {
  const { root, run, events } = setup(t);
  run('task', 'start', '보고서', '--slug', 'report');
  const id = `${kstDate()}/report`;
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`);
    return r;
  };
  ok('meeting', id, 'start', '--attendees', 'marketing-1,dev', '--agenda', '분담 정하기');
  ok('meeting', id, 'end', '--summary', '마케팅 → 개발');
  ok('flow', id, 'cooperate', '--from', 'marketing', '--to', 'dev-2', '--note', '조사 결과 전달');
  ok('flow', id, 'review-request', '--from', 'dev');
  ok('flow', id, 'review', '--verdict', 'reject', '--to', 'dev', '--reason', '링크 깨짐');
  ok('flow', id, 'review', '--verdict=pass');
  writeFileSync(join(root, 'outputs', id, 'report.md'), '# 최종 검토 보고서');
  const d = ok('flow', id, 'deliver');
  assert.match(d.stdout, /업무를 완료/);
  const evs = events().filter((e) => e.task === id && e.kind !== 'task.start');
  assert.deepEqual(evs.map((e) => e.kind), ['meeting.start', 'meeting.end', 'flow.cooperate', 'flow.review_request', 'flow.review', 'flow.review', 'flow.deliver', 'task.update']);
  assert.deepEqual(evs[0].attendees, ['marketing-1', 'dev']);
  assert.equal(evs[0].summary, '분담 정하기');
  assert.deepEqual([evs[2].from, evs[2].to], ['marketing', 'dev'], '직원 id는 소속 부서로 바꾼다');
  assert.deepEqual([evs[4].verdict, evs[4].to, evs[4].summary], ['reject', 'dev', '링크 깨짐']);
  assert.equal(evs[5].verdict, 'pass');
  assert.equal(evs[7].status, 'done');
  const tasks = JSON.parse(readFileSync(join(root, '.office', 'tasks.json'), 'utf8'));
  assert.equal(tasks[0].status, 'done');

  assert.equal(run('flow', id, 'review', '--verdict', 'reject').status, 64, '반려는 --to 필요');
  assert.match(run('flow', id, 'cooperate', '--from', 'marketing', '--to', 'nope').stderr, /찾을 수 없습니다: nope\. 있는 부서: marketing, dev/);
  assert.equal(run('flow', id, 'review', '--verdict', 'maybe').status, 64);
  assert.equal(run('flow', id, 'unknown').status, 64);
  assert.equal(run('flow', id, 'deliver', '--bogus', 'x').status, 64);
  assert.equal(run('flow', `${kstDate()}/none`, 'deliver').status, 1);
  assert.match(run('meeting', id, 'start', '--attendees', 'ghost').stderr, /조직에 없는 참석자/);
  assert.equal(run('meeting', id, 'start').status, 64);
  assert.equal(run('task', 'status', id, 'review').status, 1, 'review는 flow deliver로만 바꾼다');
  assert.equal(run('task', 'status', id, 'review', '--by-user').status, 0, '대표 직접(--by-user)은 review도 받는다');
});

test('CLI flow review 반려는 최대 2회: 3번째는 종료 코드 1, 사용자 반려 뒤에는 다시 센다, --to 직원·--stage 기록', (t) => {
  const { root, run, events } = setup(t);
  run('task', 'start', '보고서', '--slug', 'report');
  const id = `${kstDate()}/report`;
  const reject = (...extra) => run('flow', id, 'review', '--verdict', 'reject', '--to', 'dev', ...extra);
  assert.equal(reject().status, 0);
  assert.equal(reject('--stage', 'html').status, 0);
  const third = reject();
  assert.equal(third.status, 1);
  assert.match(third.stderr, /최대 2회/);
  assert.match(third.stderr, /blocked/);
  assert.equal(events().filter((e) => e.kind === 'flow.review').length, 2, '3번째는 기록하지 않는다');
  assert.equal(events().filter((e) => e.kind === 'flow.review')[1].stage, 'html');
  // 사용자 반려(서버 이벤트) 뒤에는 재배정을 막지 않는다
  appendFileSync(join(root, '.office', 'events.jsonl'), JSON.stringify({ v: 1, ts: new Date().toISOString(), session: 'office-server', kind: 'flow.user_reject', task: id }) + '\n');
  assert.equal(reject().status, 0);
  const r = run('flow', id, 'review', '--verdict', 'reject', '--to', 'dev-2');
  assert.equal(r.status, 0, r.stderr);
  const last = events().filter((e) => e.kind === 'flow.review').at(-1);
  assert.deepEqual([last.to, last.target], ['dev', 'dev-2'], '직원 id는 부서로 바꾸고 target에 남긴다');
  assert.equal(run('flow', id, 'review', '--verdict', 'reject', '--to', 'dev', '--stage', '../x').status, 64);
});

test('CLI org export·import는 대시보드 비서실장 실행(OFFICE_CHIEF_RUN=1)에서 거부한다(가드와 이중 방어)', (t) => {
  const { root } = setup(t);
  const target = join(root, 'victim.json');
  const env = { ...process.env, AI_OFFICE_ROOT: root, OFFICE_CHIEF_RUN: '1' };
  const exp = spawnSync(process.execPath, [SCRIPT, 'org', 'export', target, '--yes'], { env, encoding: 'utf8' });
  assert.equal(exp.status, 1);
  assert.match(exp.stderr, /대표가 직접/);
  assert.equal(existsSync(target), false);
  writeFileSync(target, JSON.stringify({ version: 1, company: 'hijacked', departments: [], roster: [] }));
  const imp = spawnSync(process.execPath, [SCRIPT, 'org', 'import', target, '--yes'], { env, encoding: 'utf8' });
  assert.equal(imp.status, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'org', 'roster.json'), 'utf8')).length, ORG.roster.length, '조직 정본은 그대로');
});


test('필수 전달은 실제 후속 의존 경로를 요구하고 기존 권장은 생략 가능', () => {
  const plan = goodPlan();
  const org = structuredClone(ORG);
  org.departments[0].handoffs = ['dev'];
  const inspect = (value) => validatePlan(value, { root: ROOT, org, taskId: TASK, fileExists: (path) => existing.has(path) });
  const one = { ...plan, stages: [plan.stages[0]] };
  assert.equal(inspect(one).ok, true);
  org.departments[0].handoffPolicy = 'required';
  assert.equal(inspect(one).ok, false);
  assert.match(inspect(one).errors.join(' '), /필수 전달 부서 dev/);
  assert.equal(inspect(plan).ok, true);
  plan.stages[1].dependsOn = [];
  plan.stages[1].inputs = [];
  assert.equal(inspect(plan).ok, false, '부서가 계획에 존재해도 의존 경로가 없으면 전달한 것이 아니다');
});
