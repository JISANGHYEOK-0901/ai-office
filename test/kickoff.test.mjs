// 회의실 연출(하달 킥오프·회의실 대기열)과 산출물 없는 완료 단계(done_missing_output)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DONE_MISSING_OUTPUT, KICKOFF_MS, MEETING_STALE_MS, deriveTaskFlows, scheduleMeetings } from '../lib/flow.mjs';
import { planOutputStatus } from '../lib/outputs.mjs';
import { compactPlan } from '../lib/plan.mjs';
import { buildState } from '../dashboard/state.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-10-29T01:00:00.000Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const TA = '2026-10-29/task-a';
const TB = '2026-10-29/task-b';

const ORG = {
  departments: [
    { id: 'marketing', name: '마케팅부', engine: 'claude' },
    { id: 'dev', name: '개발부', engine: 'claude' },
  ],
  roster: [
    { id: 'marketing-1', name: '김팀장', department: 'marketing', lead: true },
    { id: 'marketing-2', name: '이주임', department: 'marketing' },
    { id: 'dev-2', name: '최대리', department: 'dev' },
  ],
};

const sessionOf = (task) => `sess-${task.split('/')[1]}`;
const chiefEv = (sec, task, o) => ({ v: 1, ts: at(sec), engine: 'claude', session: sessionOf(task), instance: sessionOf(task), agent: 'chief', task, ...o });
const cliEv = (sec, task, o) => ({ v: 1, ts: at(sec), engine: 'claude', session: 'office-cli', instance: 'office-cli', agent: 'chief', task, ...o });
const call = (sec, task, target, desc) => chiefEv(sec, task, { kind: 'tool.start', tool: 'Agent', target, desc, summary: `${target}: ${desc}` });
const agentEv = (sec, task, agent, kind, o = {}) => ({ v: 1, ts: at(sec), engine: 'claude', session: sessionOf(task), instance: `${agent}-i`, agent, task, kind, ...o });
const plan = (task, stages) => ({ task, goal: '조사 후 HTML', stages, gaps: [] });
const STAGES = [
  { id: 's1', title: '조사', dept: 'marketing', agent: 'marketing-1', output: `outputs/${TA}/marketing/marketing-1-조사.md`, dependsOn: [] },
  { id: 's2', title: 'HTML', dept: 'dev', agent: 'dev-2', output: `outputs/${TA}/dev/index.html`, dependsOn: ['s1'] },
];

test('plan.set이 하달 킥오프를 연다: 참석은 계획의 모든 담당 + 비서실장, 피드 문구, 업무마다 한 번', () => {
  const events = [
    chiefEv(0, TA, { kind: 'request', summary: '조사하고 HTML로 만들어줘' }),
    cliEv(1, TA, { kind: 'task.start', summary: '중고명품 조사 HTML' }),
    cliEv(2, TA, { kind: 'plan.set', plan: plan(TA, STAGES) }),
    call(3, TA, 'marketing-1', '시장 조사'),
    cliEv(4, TA, { kind: 'plan.set', plan: plan(TA, STAGES) }), // 다시 검사해도 킥오프는 한 번
  ];
  const { items, meetings } = deriveTaskFlows(events, ORG, { tasks: [{ id: TA, title: '중고명품 조사 HTML', status: 'active' }] });
  const kick = items.filter((i) => i.stage === 'kickoff');
  assert.equal(kick.length, 1);
  assert.equal(kick[0].text, '비서실장: 중고명품 조사 HTML 업무 킥오프 — 참석 김팀장, 최대리');
  assert.deepEqual(kick[0].attendees, ['chief', 'marketing-1', 'dev-2']);
  assert.equal(kick[0].ts, at(2));
  // 하달보다 앞에 온다(단계 표시줄에서는 '하달')
  const stages = items.map((i) => i.stage);
  assert.ok(stages.indexOf('kickoff') < stages.indexOf('assign'));
  assert.deepEqual(meetings, [{ task: TA, kind: 'kickoff', attendees: ['chief', 'marketing-1', 'dev-2'], since: at(2) }]);
});

test('계획표가 없으면 첫 하달이 킥오프를 연다: 그 시점까지 배정된 직원(같은 응답의 병렬 호출 포함)만 참석', () => {
  const events = [
    chiefEv(0, TA, { kind: 'request', summary: '조사해줘' }),
    cliEv(1, TA, { kind: 'task.start', summary: '조사' }),
    call(2, TA, 'marketing-1', '시장 조사'),
    call(3, TA, 'marketing-2', '경쟁사 조사'), // 병렬 호출(3초 안)
    agentEv(4, TA, 'marketing-1', 'agent.start'),
    agentEv(20, TA, 'marketing-1', 'agent.stop', { summary: '조사를 마쳤습니다.' }),
    call(30, TA, 'dev-2', 'HTML 작성'), // 나중 배정은 참석자가 아니다(협조 연출로 보인다)
  ];
  const { items, meetings } = deriveTaskFlows(events, ORG, { tasks: [{ id: TA, title: '시장 조사', status: 'active' }] });
  const kick = items.filter((i) => i.stage === 'kickoff');
  assert.equal(kick.length, 1);
  assert.equal(kick[0].ts, at(2));
  assert.deepEqual(kick[0].attendees, ['chief', 'marketing-1', 'marketing-2']);
  assert.equal(kick[0].text, '비서실장: 시장 조사 업무 킥오프 — 참석 김팀장, 이주임');
  assert.equal(meetings.length, 1);
  assert.ok(items.some((i) => i.stage === 'cooperate' && i.target === 'dev-2'));
});

test('plan.json 파일만 있고 plan.set이 없으면 첫 하달 때 계획 담당으로 킥오프한다', () => {
  const events = [
    chiefEv(0, TA, { kind: 'request', summary: '조사해줘' }),
    call(5, TA, 'marketing-1', '시장 조사'),
  ];
  const { items } = deriveTaskFlows(events, ORG, { plans: { [TA]: plan(TA, STAGES) } });
  const kick = items.find((i) => i.stage === 'kickoff');
  assert.equal(kick.ts, at(5));
  assert.deepEqual(kick.attendees, ['chief', 'marketing-1', 'dev-2']);
});

test('회의·반려 호출은 킥오프를 열지 않는다. [회의] 호출은 참석자가 의견을 낼 때까지 회의실을 쓴다', () => {
  const events = [
    chiefEv(0, TA, { kind: 'request', summary: '알아서 해줘' }),
    call(1, TA, 'marketing-1', '[회의] 범위 제안'),
    call(1, TA, 'dev-2', '[회의] 범위 제안'),
    agentEv(2, TA, 'marketing-1', 'agent.start'),
    agentEv(2, TA, 'dev-2', 'agent.start'),
    agentEv(10, TA, 'marketing-1', 'agent.stop', { summary: '조사부터 하자는 의견' }),
    agentEv(12, TA, 'dev-2', 'agent.stop', { summary: 'HTML은 한 쪽' }),
  ];
  const { items, meetings } = deriveTaskFlows(events, ORG);
  assert.ok(!items.some((i) => i.stage === 'kickoff'));
  assert.deepEqual(meetings, [{ task: TA, kind: 'meeting', attendees: ['chief', 'marketing-1', 'dev-2'], since: at(1), until: at(12) }]);
  // 진행 중(한 명만 의견 제출)이면 until이 없다
  const open = deriveTaskFlows(events.slice(0, 6), ORG).meetings;
  assert.equal(open[0].until, undefined);
  assert.deepEqual(scheduleMeetings(open, T0 + 11_000), [{ task: TA, kind: 'meeting', attendees: ['chief', 'marketing-1', 'dev-2'], since: at(1) }]);
});

test('명시 회의(meeting.start~end): 부서 id 참석자는 그 부서 팀장, 끝나면 until', () => {
  const events = [
    cliEv(0, TA, { kind: 'meeting.start', attendees: ['marketing', 'dev-2', 'nobody'], summary: '범위' }),
    call(1, TA, 'marketing-2', '[회의] 의견'),
    cliEv(9, TA, { kind: 'meeting.end', summary: '결정' }),
  ];
  const { meetings } = deriveTaskFlows(events, ORG);
  assert.deepEqual(meetings, [{ task: TA, kind: 'meeting', attendees: ['chief', 'marketing-1', 'dev-2', 'marketing-2'], since: at(0), until: at(9) }]);
});

test('회의실 대기열: 동시에 하달된 업무는 순서대로 8초씩 킥오프하고, 대기 중이면 waiting', () => {
  const events = [
    cliEv(0, TA, { kind: 'plan.set', plan: plan(TA, STAGES) }),
    cliEv(1, TB, { kind: 'plan.set', plan: plan(TB, [{ id: 'x', title: '조사', dept: 'marketing', agent: 'marketing-2', output: `outputs/${TB}/m.md`, dependsOn: [] }]) }),
  ];
  const { meetings } = deriveTaskFlows(events, ORG);
  assert.equal(meetings.length, 2);
  const s3 = scheduleMeetings(meetings, T0 + 3000);
  assert.deepEqual(s3, [
    { task: TA, kind: 'kickoff', attendees: ['chief', 'marketing-1', 'dev-2'], since: at(0), until: at(KICKOFF_MS / 1000) },
    { task: TB, kind: 'kickoff', attendees: ['chief', 'marketing-2'], since: at(8), until: at(16), requested: at(1), waiting: true },
  ]);
  const s9 = scheduleMeetings(meetings, T0 + 9000);
  assert.deepEqual(s9.map((m) => [m.task, Boolean(m.waiting)]), [[TB, false]]);
  assert.deepEqual(scheduleMeetings(meetings, T0 + 16_000), [], '끝난 킥오프는 뺀다');
});

test('회의실 대기열: 진행 중인 실제 회의 뒤의 킥오프는 끝날 때까지 기다리고, 끝 기록 없는 회의는 30분 뒤 풀린다', () => {
  const open = [
    { task: TA, kind: 'meeting', attendees: ['chief', 'marketing-1'], since: at(0) },
    { task: TB, kind: 'kickoff', attendees: ['chief', 'dev-2'], since: at(5) },
  ];
  assert.deepEqual(scheduleMeetings(open, T0 + 60_000), [
    { task: TA, kind: 'meeting', attendees: ['chief', 'marketing-1'], since: at(0) },
    { task: TB, kind: 'kickoff', attendees: ['chief', 'dev-2'], since: at(5), waiting: true },
  ]);
  const ended = [{ ...open[0], until: at(20) }, open[1]];
  assert.deepEqual(scheduleMeetings(ended, T0 + 21_000), [
    { task: TB, kind: 'kickoff', attendees: ['chief', 'dev-2'], since: at(20), until: at(28), requested: at(5) },
  ]);
  // 끝 기록이 없어도 MEETING_STALE_MS가 지나면 회의실을 비우고 다음 킥오프를 연다(이미 끝난 시간대면 둘 다 빠진다)
  assert.deepEqual(scheduleMeetings(open, T0 + MEETING_STALE_MS + 1000).map((m) => m.kind), ['kickoff']);
  assert.deepEqual(scheduleMeetings(open, T0 + MEETING_STALE_MS + 9000), []);
});

test('buildState: meetings(대기열 적용)를 내고, 깨진 회의 기록은 무시한다', () => {
  const events = [cliEv(0, TA, { kind: 'plan.set', plan: plan(TA, STAGES) })];
  const s = buildState({ org: ORG, events, now: T0 + 2000 });
  assert.deepEqual(s.meetings, [{ task: TA, kind: 'kickoff', attendees: ['chief', 'marketing-1', 'dev-2'], since: at(0), until: at(8) }]);
  assert.deepEqual(scheduleMeetings([null, { kind: 'kickoff', since: 'x' }, 3], T0), []);
  assert.deepEqual(buildState({ org: ORG, events, now: T0 + 60_000 }).meetings, []);
});

test('done_missing_output: 완료 단계의 산출물 파일이 없으면(서버 확인 결과) 경고 상태와 검토 요청 줄 경고', () => {
  const events = [
    cliEv(0, TA, { kind: 'plan.set', plan: plan(TA, STAGES) }),
    call(1, TA, 'marketing-1', '조사'),
    agentEv(2, TA, 'marketing-1', 'agent.start'),
    agentEv(5, TA, 'marketing-1', 'agent.stop', { summary: '조사를 마쳤습니다.' }),
    call(6, TA, 'dev-2', 'HTML'),
    agentEv(7, TA, 'dev-2', 'agent.start'),
    agentEv(9, TA, 'dev-2', 'agent.stop', { summary: 'HTML을 만들었습니다.' }),
    cliEv(10, TA, { kind: 'flow.review_request', from: 'dev' }),
  ];
  const outputs = { [TA]: { s1: false, s2: true } };
  const r = deriveTaskFlows(events, ORG, { outputs });
  assert.deepEqual(r.tasks[TA].plan.map((s) => [s.id, s.status]), [['s1', DONE_MISSING_OUTPUT], ['s2', 'done']]);
  assert.deepEqual(r.tasks[TA].missingOutputs, ['s1']);
  const rr = r.items.find((i) => i.stage === 'review_request');
  assert.equal(rr.warn, true);
  assert.match(rr.text, /산출물 없는 완료 단계: s1/);
  // 확인 결과가 없으면(데모·완료 업무) 그대로 완료다. 진행 중 단계는 파일이 없어도 경고하지 않는다
  assert.deepEqual(deriveTaskFlows(events, ORG).tasks[TA].plan.map((s) => s.status), ['done', 'done']);
  const running = deriveTaskFlows(events.slice(0, 5), ORG, { outputs: new Map([[TA, { s1: true, s2: false }]]) });
  assert.deepEqual(running.tasks[TA].plan.map((s) => s.status), ['done', 'active']);
  // buildState가 tasks[].plan.stages·missingOutputs로 전달한다
  const s = buildState({ org: ORG, events, tasks: [{ id: TA, title: '조사', status: 'active' }], outputs: new Map(Object.entries(outputs)), now: T0 + 60_000 });
  const t = s.tasks.find((x) => x.id === TA);
  assert.equal(t.plan.stages[0].status, DONE_MISSING_OUTPUT);
  assert.deepEqual(t.missingOutputs, ['s1']);
});

test('planOutputStatus: 업무 폴더 안 파일만 확인하고, 밖을 가리키는 경로·심볼릭 링크는 없음/확인 안 함', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-outputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'outputs', ...TA.split('/'));
  mkdirSync(join(dir, 'marketing'), { recursive: true });
  writeFileSync(join(dir, 'marketing', 'a.md'), '# a');
  mkdirSync(join(dir, 'dev', 'folder.html'), { recursive: true });
  writeFileSync(join(root, 'secret.txt'), 'x');
  let linked = true;
  try {
    symlinkSync(join(root, 'secret.txt'), join(dir, 'link.md'));
  } catch {
    linked = false; // Windows에서 심볼릭 링크 권한이 없으면 건너뛴다
  }
  const status = planOutputStatus(root, TA, { stages: [
    { id: 'ok', output: `outputs/${TA}/marketing/a.md` },
    { id: 'none', output: `outputs/${TA}/marketing/b.md` },
    { id: 'dir', output: `outputs/${TA}/dev/folder.html` },
    // validatePlan·compactPlan처럼 정규화 뒤 'outputs/'로 시작하지 않으면 업무 폴더 기준이라 outputs/<업무>/secret.txt(없음)를 뜻한다
    { id: 'escape', output: `outputs/${TA}/../../../secret.txt` },
    { id: 'up', output: '../../secret.txt' },
    { id: 'abs', output: join(root, 'secret.txt') },
    { id: 'other', output: 'outputs/2026-10-29/other/a.md' },
    { id: 'win', output: `outputs\\${TA.replace('/', '\\')}\\marketing\\a.md` },
    ...(linked ? [{ id: 'link', output: `outputs/${TA}/link.md` }] : []),
    { id: 'nul', output: 'outputs/a\0b' },
    { id: 'noout' },
  ] });
  assert.deepEqual(status, { ok: true, none: false, dir: false, escape: false, win: true, ...(linked ? { link: false } : {}) });
});

test('planOutputStatus: plan.json 원본 경로로 확인해 공백 연속·비밀값 모양·긴 이름을 놓치지 않고, 비어 있지 않은 폴더 산출물은 있음', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-outputs-raw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'outputs', ...TA.split('/'));
  const long = `${'긴이름'.repeat(60)}.md`;
  mkdirSync(join(dir, 'marketing'), { recursive: true });
  mkdirSync(join(dir, 'dev', 'site', 'css'), { recursive: true });
  mkdirSync(join(dir, 'dev', 'empty'), { recursive: true });
  mkdirSync(join(dir, 'dev', 'hidden'), { recursive: true });
  writeFileSync(join(dir, 'marketing', 'a  b.md'), '# a');
  writeFileSync(join(dir, 'marketing', 'token=v2-notes.md'), '# t');
  writeFileSync(join(dir, 'marketing', long), '# l');
  writeFileSync(join(dir, 'dev', 'site', 'css', 'main.css'), 'body{}');
  writeFileSync(join(dir, 'dev', 'hidden', '.keep'), '');
  const raw = { stages: [
    { id: 'space', output: 'marketing/a  b.md' },
    { id: 'secret', output: `outputs/${TA}/marketing/token=v2-notes.md` },
    { id: 'long', output: `marketing/${long}` },
    { id: 'site', output: 'dev/site/' },
    { id: 'empty', output: 'dev/empty' },
    { id: 'hidden', output: 'dev/hidden/' },
  ] };
  // 요약(compactPlan)은 경로를 바꾼다: 이것으로 확인하면 있는 파일도 없음이 된다
  const compact = compactPlan(raw, { taskId: TA, root });
  assert.notEqual(compact.stages[0].output, `outputs/${TA}/marketing/a  b.md`);
  assert.match(compact.stages[1].output, /\*\*\*/);
  assert.deepEqual(planOutputStatus(root, TA, raw), { space: true, secret: true, long: true, site: true, empty: false, hidden: false });
});

test('task files: 계획 단계 산출물은 plan.json 원본 경로로 확인한다(공백 연속·폴더 산출물)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-taskfiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'outputs', ...TA.split('/'));
  mkdirSync(join(dir, 'marketing'), { recursive: true });
  mkdirSync(join(dir, 'dev', 'site'), { recursive: true });
  writeFileSync(join(dir, 'marketing', 'a  b.md'), '# a');
  writeFileSync(join(dir, 'dev', 'site', 'index.html'), '<p>');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ version: 1, task: TA, goal: 'g', stages: [
    { id: 's1', title: '조사', dept: 'marketing', agent: 'marketing-1', output: 'marketing/a  b.md' },
    { id: 's2', title: '사이트', dept: 'dev', agent: 'dev-2', output: 'dev/site/' },
    { id: 's3', title: '없음', dept: 'dev', agent: 'dev-2', output: 'dev/none.md' },
  ] }));
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'office.mjs'), 'task', 'files', TA, '--json'], { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.planOutputs.map((p) => [p.stage, p.exists]), [['s1', true], ['s2', true], ['s3', false]]);
});

test('서버: 상태를 만들 때 계획 단계 산출물 파일을 확인해 done_missing_output을 내고, meetings를 함께 준다', async (t) => {
  const { startServer } = await import('../dashboard/server.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ai-office-kickoff-server-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(ORG.departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(ORG.roster));
  const dir = join(root, 'outputs', ...TA.split('/'));
  mkdirSync(join(dir, 'marketing'), { recursive: true });
  writeFileSync(join(dir, 'marketing', 'marketing-1-조사.md'), '# 조사');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ version: 1, task: TA, goal: '조사 후 HTML', stages: STAGES.map((s) => ({ ...s, done: 'd' })) }));
  mkdirSync(join(root, '.office'), { recursive: true });
  writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify([{ id: TA, title: '조사 HTML', status: 'active', created: at(0) }]));
  const now = Date.now();
  const ts = (sec) => new Date(now - 60_000 + sec * 1000).toISOString();
  const evs = [
    { ...cliEv(0, TA, { kind: 'plan.set', plan: plan(TA, STAGES) }), ts: ts(0) },
    { ...call(1, TA, 'marketing-1', '조사'), ts: ts(1) },
    { ...agentEv(2, TA, 'marketing-1', 'agent.start'), ts: ts(2) },
    { ...agentEv(3, TA, 'marketing-1', 'agent.stop', { summary: '조사를 마쳤습니다.' }), ts: ts(3) },
    { ...call(4, TA, 'dev-2', 'HTML'), ts: ts(4) },
    { ...agentEv(5, TA, 'dev-2', 'agent.start'), ts: ts(5) },
    { ...agentEv(6, TA, 'dev-2', 'agent.stop', { summary: 'HTML을 만들었습니다.' }), ts: ts(6) },
  ];
  writeFileSync(join(root, '.office', 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const handle = await startServer({ root, port: 0, quiet: true, publicDir: join(root, 'public') });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    const state = await res.json();
    const task = state.tasks.find((x) => x.id === TA);
    assert.deepEqual(task.plan.stages.map((s) => [s.id, s.status]), [['s1', 'done'], ['s2', DONE_MISSING_OUTPUT]]);
    assert.deepEqual(task.missingOutputs, ['s2']);
    assert.ok(Array.isArray(state.meetings), 'meetings 배열');
    assert.equal(state.meetings.length, 0, '1분 전 킥오프는 이미 끝났다');
    assert.ok(state.flow.some((i) => i.stage === 'kickoff' && i.task === TA));
    // 파일이 생기면 다음 상태에서 경고가 사라진다
    mkdirSync(join(dir, 'dev'), { recursive: true });
    writeFileSync(join(dir, 'dev', 'index.html'), '<h1>hi</h1>');
    const again = await (await fetch(`http://127.0.0.1:${handle.port}/api/state`)).json();
    assert.deepEqual(again.tasks.find((x) => x.id === TA).missingOutputs, []);
  } finally {
    await handle.close();
  }
});

test('서버: 산출물 확인은 plan.json 원본 경로로 하므로 공백 연속·폴더 산출물이 산출물 없음으로 잘못 뜨지 않고, 원본과 다른 단계는 확인하지 않는다', async (t) => {
  const { startServer } = await import('../dashboard/server.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ai-office-kickoff-raw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(ORG.departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(ORG.roster));
  const dir = join(root, 'outputs', ...TA.split('/'));
  mkdirSync(join(dir, 'marketing'), { recursive: true });
  mkdirSync(join(dir, 'dev', 'site'), { recursive: true });
  writeFileSync(join(dir, 'marketing', 'a  b.md'), '# 조사');
  writeFileSync(join(dir, 'dev', 'site', 'index.html'), '<h1>hi</h1>');
  const raw = { version: 1, task: TA, goal: '조사 후 사이트', stages: [
    { id: 's1', title: '조사', dept: 'marketing', agent: 'marketing-1', output: 'marketing/a  b.md', done: 'd', dependsOn: [] },
    { id: 's2', title: '사이트', dept: 'dev', agent: 'dev-2', output: 'dev/site/', done: 'd', dependsOn: ['s1'] },
    { id: 's3', title: '정리', dept: 'dev', agent: 'dev-2', output: 'dev/notes.md', done: 'd', dependsOn: ['s2'] },
  ] };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(raw));
  // plan.set 이벤트는 검사 때의 요약이다. s3는 그 뒤 plan.json에서 경로가 바뀐 경우(화면과 원본이 다르면 확인하지 않는다)
  const shown = compactPlan({ ...raw, stages: raw.stages.map((s) => (s.id === 's3' ? { ...s, output: 'dev/old-notes.md' } : s)) }, { taskId: TA, root });
  mkdirSync(join(root, '.office'), { recursive: true });
  writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify([{ id: TA, title: '조사 사이트', status: 'active', created: at(0) }]));
  const now = Date.now();
  const ts = (sec) => new Date(now - 60_000 + sec * 1000).toISOString();
  const evs = [
    { ...cliEv(0, TA, { kind: 'plan.set', plan: shown }), ts: ts(0) },
    ...[['marketing-1', 1], ['dev-2', 4], ['dev-2', 7]].flatMap(([agent, sec]) => [
      { ...call(sec, TA, agent, '작업'), ts: ts(sec) },
      { ...agentEv(sec + 1, TA, agent, 'agent.start'), ts: ts(sec + 1) },
      { ...agentEv(sec + 2, TA, agent, 'agent.stop', { summary: '마쳤습니다.' }), ts: ts(sec + 2) },
    ]),
  ];
  writeFileSync(join(root, '.office', 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const handle = await startServer({ root, port: 0, quiet: true, publicDir: join(root, 'public') });
  try {
    const state = await (await fetch(`http://127.0.0.1:${handle.port}/api/state`)).json();
    const task = state.tasks.find((x) => x.id === TA);
    assert.ok(!task.plan.stages.some((s) => s.status === DONE_MISSING_OUTPUT), JSON.stringify(task.plan.stages));
    assert.deepEqual(task.missingOutputs, []);
  } finally {
    await handle.close();
  }
});
