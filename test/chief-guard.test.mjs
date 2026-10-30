// 비서실장 직접 실무 금지 장치(hooks/chief-guard.mjs, lib/chief-guard.mjs) 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKGROUND_DENY_MESSAGE, CHIEF_DENY_MESSAGE, PRE_TASK_DENY_MESSAGE, REJECT_LIMIT_MESSAGE, decideChiefGuard, isAllowedChiefWrite, isAllowedOfficeCommand, onDutyAgents, splitSafeCommand, summarizeAgents,
} from '../lib/chief-guard.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// 같은 부하에서 빈 node 프로세스를 띄우는 데 걸리는 시간(앞뒤로 재서 큰 값). 훅 2초 제한 검사에서 Node 기동 시간은 빼고 본다
// (전체 테스트를 병렬로 돌리면 기동만 수백 ms가 걸려 시간 검사가 흔들린다)
function nodeBootMs() {
  const t = Date.now();
  spawnSync(process.execPath, ['-e', '0']);
  return Date.now() - t;
}
const SID = '11111111-2222-3333-4444-555555555555';
const TASK = '2026-10-29/landing';
const ROOT = join(tmpdir(), 'office-guard-root');

const org = () => ({
  departments: [
    { id: 'marketing', name: '마케팅부', engine: 'claude', summary: '조사' },
    { id: 'dev', name: '개발부', engine: 'claude' },
    { id: 'verify', name: '검증실', engine: 'codex' },
    { id: 'closed', name: '휴업부', engine: 'claude', active: false },
  ],
  roster: [
    { id: 'marketing-1', name: '김팀장', department: 'marketing', title: '팀장', lead: true, rank: '팀장', specialty: '시장 조사' },
    { id: 'dev-2', name: '최대리', department: 'dev', title: '담당', rank: '대리', specialty: 'HTML 작성' },
    { id: 'dev-3', name: '박사원', department: 'dev', title: '담당', active: false },
    { id: 'verify-1', name: '이검증', department: 'verify', title: '담당' },
    { id: 'closed-1', name: '정주임', department: 'closed', title: '담당' },
  ],
});

const decide = (tool, toolInput = {}, extra = {}) => decideChiefGuard(
  { session_id: SID, hook_event_name: 'PreToolUse', cwd: ROOT, tool_name: tool, tool_input: toolInput, ...extra },
  { root: ROOT, sessions: { [SID]: TASK }, getOrg: org },
);

test('Claude JSON schema의 StructuredOutput은 업무 연결 전후 모두 응답 도구로 허용한다', () => {
  assert.equal(decide('StructuredOutput', { plan: { stages: [] } }), null);
  assert.equal(decideChiefGuard({ session_id: SID, tool_name: 'StructuredOutput', tool_input: { question: '예산 확인' } },
    { root: ROOT, sessions: {}, getOrg: org, chiefRun: true }), null);
  assert.ok(decide('Write', { file_path: join(ROOT, 'unassigned-result.html') }));
});

test('onDutyAgents: 근무중·운영 중 부서·claude 엔진 직원만', () => {
  assert.deepEqual(onDutyAgents(org()).map((a) => a.id), ['marketing-1', 'dev-2']);
  assert.deepEqual(onDutyAgents({}), []);
});

test('허용 매트릭스: 조회·조율 도구, 근무중 직원 Agent, office CLI, 허용 파일 쓰기', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'Skill', 'TodoWrite', 'ToolSearch', 'AskUserQuestion']) assert.equal(decide(tool), null, tool);
  assert.equal(decide('Agent', { subagent_type: 'dev-2', description: 'HTML 작성' }), null);
  assert.equal(decide('Task', { subagent_type: 'marketing-1' }), null, '예전 이름 Task도 같은 규칙');
  for (const cmd of [
    'node scripts/office.mjs task start "랜딩 조사" --slug landing',
    'node scripts/office.mjs plan validate 2026-10-29/landing',
    "node scripts/office.mjs flow 2026-10-29/landing review --verdict reject --to dev --reason '근거 부족; 표 보강 & 재작성'",
    'node ./scripts/codex-review.mjs --target outputs/2026-10-29/landing --task 2026-10-29/landing',
    `node "${join(ROOT, 'scripts', 'office.mjs')}" flow ${TASK} deliver`,
  ]) assert.equal(decide('Bash', { command: cmd }), null, cmd);
  for (const f of ['brief.md', 'meeting.md', 'report.md', 'review-notes.md', 'plan.json']) {
    assert.equal(decide('Write', { file_path: join(ROOT, 'outputs', '2026-10-29', 'landing', f) }), null, f);
    assert.equal(decide('Edit', { file_path: `outputs/${TASK}/${f}` }), null, `상대경로 ${f}`);
  }
});

test('거부 매트릭스: 실무 도구, 다른 명령, 연결·치환, 허용 밖 파일', () => {
  for (const tool of ['WebSearch', 'WebFetch', 'NotebookEdit', 'mcp__notion__search']) {
    const d = decide(tool, {});
    assert.ok(d, tool);
    assert.ok(d.reason.startsWith(CHIEF_DENY_MESSAGE), tool);
    assert.ok(d.reason.includes(TASK));
  }
  for (const cmd of [
    'curl https://example.com',
    'python3 analyze.py',
    'node analyze.mjs',
    'node scripts/sync-agents.mjs --write',
    'node scripts/office.mjs task list && curl https://example.com',
    'node scripts/office.mjs task list; rm -rf outputs',
    'node scripts/office.mjs task list | tee x.txt',
    'node scripts/office.mjs task list > outputs/x.md',
    'node scripts/office.mjs flow x review --reason "$(cat /etc/passwd)"',
    'node scripts/office.mjs flow x review --reason "`id`"',
    'node scripts/office.mjs task list\ncurl x',
    'cd outputs && node ../scripts/office.mjs task list',
    'AI_OFFICE_ROOT=/tmp node scripts/office.mjs task list',
    'node "scripts/office.mjs',
    '',
  ]) {
    const d = decide('Bash', { command: cmd });
    assert.ok(d, `거부되어야 함: ${JSON.stringify(cmd)}`);
    assert.ok(d.reason.includes('단독으로'), cmd);
  }
  assert.ok(decide('PowerShell', { command: 'Invoke-WebRequest https://example.com' }));
  for (const f of [`outputs/${TASK}/marketing/marketing-1-조사.md`, `outputs/${TASK}/index.html`, 'outputs/2026-10-29/other/report.md', 'AGENTS.md', `outputs/${TASK}/../other/brief.md`]) {
    assert.ok(decide('Write', { file_path: f }), f);
  }
  assert.ok(decide('Write', {}), 'file_path 없음');
});

test('Agent 거부: 미존재·휴무·휴업 부서·codex 직원·subagent_type 없음 → 사용 가능한 직원 요약 포함', () => {
  for (const type of ['ghost-9', 'dev-3', 'closed-1', 'verify-1', 'general-purpose', 'Explore']) {
    const d = decide('Agent', { subagent_type: type, description: 'x' });
    assert.ok(d, type);
    assert.ok(d.reason.includes(`'${type}'`), type);
    assert.ok(d.reason.includes('사용 가능한 직원: marketing-1(김팀장 팀장 · 마케팅부 · 시장 조사), dev-2(최대리 대리 · 개발부 · HTML 작성)'), d.reason);
    assert.ok(d.reason.includes('gaps'));
  }
  const none = decide('Agent', { description: 'x' });
  assert.ok(none.reason.includes('subagent_type이 없는'));
  const empty = decideChiefGuard(
    { session_id: SID, tool_name: 'Agent', tool_input: { subagent_type: 'a-1' } },
    { root: ROOT, sessions: { [SID]: TASK }, getOrg: () => ({ departments: [], roster: [] }) },
  );
  assert.ok(empty.reason.includes('근무중 직원이 없습니다'));
});

test('Agent 백그라운드 위임(run_in_background: true) 거부, false·생략은 허용', () => {
  for (const type of ['dev-2', 'ghost-9']) {
    const d = decide('Agent', { subagent_type: type, description: 'x', run_in_background: true });
    assert.ok(d, type);
    assert.ok(d.reason.startsWith(BACKGROUND_DENY_MESSAGE), d.reason);
  }
  assert.equal(decide('Agent', { subagent_type: 'dev-2', run_in_background: false }), null);
  assert.equal(decide('Task', { subagent_type: 'dev-2' }), null);
  // 업무 연결 전이나 직원 세션은 대상이 아니다
  assert.equal(decideChiefGuard({ session_id: 'x', tool_name: 'Agent', tool_input: { subagent_type: 'dev-2', run_in_background: true } },
    { root: ROOT, sessions: { [SID]: TASK }, getOrg: org }), null);
});

test('판정 대상 아님: task 미연결·서브에이전트(--agent 포함)·잘못된 입력 → 허용(null)', () => {
  const opts = { root: ROOT, sessions: { [SID]: TASK }, getOrg: org };
  assert.equal(decideChiefGuard({ session_id: 'other', tool_name: 'WebSearch' }, opts), null, '연결 없는 세션');
  assert.equal(decideChiefGuard({ session_id: SID, tool_name: 'WebSearch' }, { ...opts, sessions: {} }), null);
  assert.equal(decideChiefGuard({ session_id: SID, tool_name: 'WebSearch', agent_type: 'dev-2' }, opts), null, '직원');
  assert.equal(decideChiefGuard({ session_id: SID, tool_name: 'WebSearch', hook_event_name: 'PostToolUse' }, opts), null);
  for (const bad of [null, 'x', [], {}, { session_id: SID }, { tool_name: 'WebSearch' }]) assert.equal(decideChiefGuard(bad, opts), null);
});

test('splitSafeCommand·summarizeAgents 경계', () => {
  assert.deepEqual(splitSafeCommand(`node scripts/office.mjs meeting x start --agenda 'a; b' --attendees "a,b"`),
    ['node', 'scripts/office.mjs', 'meeting', 'x', 'start', '--agenda', 'a; b', '--attendees', 'a,b']);
  assert.equal(splitSafeCommand('echo "$HOME"'), null);
  assert.equal(splitSafeCommand("echo 'unterminated"), null);
  // Windows는 대소문자를 가리지 않는다(platform 인자로 비교 규칙만 바꾼다)
  assert.equal(isAllowedOfficeCommand('NODE.EXE Scripts/Office.mjs task list', { root: ROOT, platform: 'win32' }), true);
  assert.equal(isAllowedOfficeCommand('node Scripts/Office.mjs task list', { root: ROOT, platform: 'darwin' }), false);
  assert.equal(isAllowedChiefWrite(join(ROOT, 'outputs', '2026-10-29', 'landing', 'REPORT.md'), { root: ROOT, task: TASK, platform: 'win32' }), true);
  assert.equal(isAllowedChiefWrite(join(ROOT, 'outputs', '2026-10-29', 'landing', 'REPORT.md'), { root: ROOT, task: TASK, platform: 'darwin' }), false);
  assert.equal(isAllowedChiefWrite(join(ROOT, 'outputs', 'brief.md'), { root: ROOT, task: '../..', platform: 'darwin' }), false, '업무 id가 outputs 밖이면 거부');
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `dept-${i}`, name: '이름', rank: '', deptName: '부서', specialty: '담당 업무' }));
  const s = summarizeAgents(many);
  assert.ok(s.length < 1700 && /외 \d+명\.$/.test(s));
});

// ---- 실제 프로세스 실행 ----

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hooks'));
  cpSync(join(REPO, 'hooks', 'chief-guard.mjs'), join(root, 'hooks', 'chief-guard.mjs'));
  cpSync(join(REPO, 'lib'), join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'org'));
  const o = org();
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(o.departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(o.roster));
  mkdirSync(join(root, '.office'));
  writeFileSync(join(root, '.office', 'sessions.json'), JSON.stringify({ [SID]: TASK }));
  writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify([{ id: TASK, title: '랜딩', status: 'active', created: '2026-10-29T00:00:00Z' }]));
  return root;
}

function runGuard(root, input, env = {}) {
  const e = { ...process.env, ...env };
  if (!('CLAUDE_PROJECT_DIR' in env)) delete e.CLAUDE_PROJECT_DIR; // Claude 세션 안에서 테스트해도 실제 레포를 읽지 않게 한다
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(root, 'hooks', 'chief-guard.mjs')], {
    env: e, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  return { ...res, elapsed: Date.now() - started };
}

const pre = (root, tool, toolInput, extra = {}) => ({ session_id: SID, hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: toolInput, ...extra });

test('프로세스: 거부는 PreToolUse deny JSON 한 개, 종료 코드 0, 2초 안', (t) => {
  const root = makeRoot(t);
  const bootBefore = nodeBootMs();
  const res = runGuard(root, pre(root, 'WebSearch', { query: 'x' }));
  const boot = Math.max(bootBefore, nodeBootMs());
  assert.equal(res.status, 0);
  assert.ok(res.elapsed - boot < 1900, `${res.elapsed}ms (기동 ${boot}ms 제외)`);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.startsWith(CHIEF_DENY_MESSAGE));

  const agent = JSON.parse(runGuard(root, pre(root, 'Agent', { subagent_type: 'dev-3', description: 'x', prompt: 'y' })).stdout);
  assert.match(agent.hookSpecificOutput.permissionDecisionReason, /'dev-3'.*사용 가능한 직원: marketing-1/);
  const bg = JSON.parse(runGuard(root, pre(root, 'Agent', { subagent_type: 'dev-2', prompt: 'y', run_in_background: true })).stdout);
  assert.equal(bg.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(bg.hookSpecificOutput.permissionDecisionReason.startsWith(BACKGROUND_DENY_MESSAGE));
});

test('프로세스: 허용·판정 대상 아님은 무출력·종료 코드 0', (t) => {
  const root = makeRoot(t);
  const cases = [
    pre(root, 'Agent', { subagent_type: 'dev-2' }),
    pre(root, 'Bash', { command: `node scripts/office.mjs flow ${TASK} deliver` }),
    pre(root, 'Write', { file_path: join(root, 'outputs', '2026-10-29', 'landing', 'plan.json') }),
    pre(root, 'WebSearch', { query: 'x' }, { session_id: 'not-linked' }),
    pre(root, 'WebSearch', { query: 'x' }, { agent_type: 'dev-2', agent_id: 'a1' }),
  ];
  for (const input of cases) {
    const res = runGuard(root, input);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', JSON.stringify(input));
  }
});

test('프로세스: 잘못된 입력·깨진 파일은 무출력 exit 0(안전하게 허용)', (t) => {
  const root = makeRoot(t);
  for (const raw of ['', 'not json', '[]', 'null', '{"tool_name":', '"x"']) {
    const res = runGuard(root, raw);
    assert.equal(res.status, 0, raw);
    assert.equal(res.stdout, '', raw);
  }
  // 정본이 깨져 있으면 Agent 판정 중 예외 → 허용
  writeFileSync(join(root, 'org', 'roster.json'), '{깨짐');
  const broken = runGuard(root, pre(root, 'Agent', { subagent_type: 'ghost' }));
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
  // sessions.json이 깨져 있으면 연결 없음으로 본다
  writeFileSync(join(root, '.office', 'sessions.json'), '{');
  assert.equal(runGuard(root, pre(root, 'WebSearch', {})).stdout, '');
});

test('프로세스: CLAUDE_PROJECT_DIR가 이 레포 구조면 그 루트를 쓴다', (t) => {
  const root = makeRoot(t);
  const res = runGuard(root, pre(root, 'WebFetch', { url: 'https://x' }), { CLAUDE_PROJECT_DIR: root });
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('.claude/settings.json: exec 형식으로 chief-guard(PreToolUse)·session-context(SessionStart) 등록, office-event 유지', () => {
  const settings = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
  const scripts = (ev) => settings.hooks[ev].flatMap((g) => g.hooks).map((h) => {
    assert.equal(h.type, 'command');
    assert.equal(h.command, 'node', '셸을 거치지 않는 exec 형식');
    return h.args[0];
  });
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
    assert.ok(scripts(ev).includes('${CLAUDE_PROJECT_DIR}/hooks/office-event.mjs'), ev);
  }
  assert.ok(scripts('PreToolUse').includes('${CLAUDE_PROJECT_DIR}/hooks/chief-guard.mjs'));
  assert.ok(scripts('SessionStart').includes('${CLAUDE_PROJECT_DIR}/hooks/session-context.mjs'));
  const preGroup = settings.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.args[0].endsWith('chief-guard.mjs')));
  assert.equal(preGroup.matcher, '*');
});

test('백슬래시 이스케이프 우회 거부: bash가 글자 따옴표로 읽는 \\\' \\" 뒤의 ; 를 따옴표 안으로 착각하지 않는다', () => {
  for (const cmd of [
    "node scripts/office.mjs \\' ; touch PWNED ; \\'",
    'node scripts/office.mjs \\" ; touch PWNED2 ; \\"',
    'node scripts/office.mjs task list "a\\" ; touch x ; \\""',
    'node scripts/office.mjs task list \\',
    'node scripts/office.mjs task\\ list',
    'node scripts/office.mjs flow x review --reason \u2018a\u2019 ; calc ; \u2018b\u2019',
  ]) {
    assert.equal(splitSafeCommand(cmd), null, cmd);
    assert.equal(isAllowedOfficeCommand(cmd, { root: ROOT }), false, cmd);
    assert.ok(decide('Bash', { command: cmd }), cmd);
  }
  // Windows 경로의 백슬래시(뒤에 영문·숫자·. _ -)는 그대로 받는다. 작은따옴표 안의 백슬래시는 bash도 글자로 읽는다
  assert.equal(isAllowedOfficeCommand('node scripts\\office.mjs task list', { root: ROOT, platform: 'win32' }), true);
  assert.deepEqual(splitSafeCommand("node scripts/office.mjs flow x review --reason 'a\\b; c'"), ['node', 'scripts/office.mjs', 'flow', 'x', 'review', '--reason', 'a\\b; c']);
});

test('office.mjs 하위 명령 허용 목록: org·task status done/review 거부, blocked·active·flow·meeting·plan 허용', () => {
  for (const cmd of [
    'node scripts/office.mjs org import outputs/2026-10-29/landing/plan.json --yes',
    'node scripts/office.mjs org export /tmp/victim.txt --yes',
    `node scripts/office.mjs task status ${TASK} done`,
    `node scripts/office.mjs task status ${TASK} review`,
    `node scripts/office.mjs task status ${TASK} active --by-user`,
    'node scripts/office.mjs plan show x',
    'node scripts/office.mjs',
  ]) {
    assert.equal(isAllowedOfficeCommand(cmd, { root: ROOT }), false, cmd);
    const d = decide('Bash', { command: cmd });
    assert.ok(d, cmd);
    assert.ok(d.reason.includes(TASK), cmd);
  }
  assert.match(decide('Bash', { command: 'node scripts/office.mjs org export x.json --yes' }).reason, /대표가 직접/);
  assert.match(decide('PowerShell', { command: `node scripts/office.mjs task status ${TASK} done` }).reason, /검토 통과와 보고서/);
  for (const cmd of [
    `node scripts/office.mjs task status ${TASK} blocked`,
    `node scripts/office.mjs task status ${TASK} active`,
    'node scripts/office.mjs task list --json',
    `node scripts/office.mjs task files ${TASK}`,
    `node scripts/office.mjs task files ${TASK} --json`,
    `node scripts/office.mjs meeting ${TASK} end --summary '정리'`,
  ]) assert.equal(decide('Bash', { command: cmd }), null, cmd);
  // task files도 단독 실행만: 파이프·리다이렉션으로 결과를 파일에 쓰거나 다른 명령을 잇지 못한다
  for (const cmd of [`node scripts/office.mjs task files ${TASK} > outputs/x.md`, `node scripts/office.mjs task files ${TASK} | tee x`]) {
    assert.ok(decide('Bash', { command: cmd }), cmd);
  }
  assert.equal(decide('PowerShell', { command: `node scripts/office.mjs task files ${TASK}` }), null);
});

test('업무가 tasks.json에 없거나 done이면 연결이 남아 있어도 제한하지 않는다(세션 영구 잠김 방지)', () => {
  const base = { root: ROOT, sessions: { [SID]: TASK }, getOrg: org };
  const input = { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'lib/flow.mjs' } };
  assert.ok(decideChiefGuard(input, { ...base, getTasks: () => [{ id: TASK, status: 'active' }] }), 'active면 거부');
  assert.ok(decideChiefGuard(input, { ...base, getTasks: () => [{ id: TASK, status: 'review' }] }), 'review(사용자 확인 대기)도 거부');
  assert.equal(decideChiefGuard(input, { ...base, getTasks: () => [{ id: TASK, status: 'done' }] }), null);
  assert.equal(decideChiefGuard(input, { ...base, getTasks: () => [] }), null, '등록되지 않은 업무');
  assert.equal(decideChiefGuard(input, { ...base, sessions: { [SID]: 'x' }, getTasks: () => [] }), null, '잘못 연결된 id');
});

test('대시보드 비서실장 실행(chiefRun): 업무 등록 전에도 실무 도구·Agent를 거부하고 task start를 안내한다', () => {
  const opts = { root: ROOT, sessions: {}, getOrg: org, chiefRun: true };
  const d = (tool, ti = {}) => decideChiefGuard({ session_id: SID, tool_name: tool, tool_input: ti, cwd: ROOT }, opts);
  for (const [tool, ti] of [['Write', { file_path: 'outputs/x.md' }], ['WebSearch', { query: 'x' }], ['WebFetch', { url: 'https://x' }], ['Bash', { command: 'ls -R' }], ['Agent', { subagent_type: 'dev-2' }]]) {
    assert.equal(d(tool, ti)?.reason, PRE_TASK_DENY_MESSAGE, tool);
  }
  assert.equal(d('Read', { file_path: 'AGENTS.md' }), null);
  assert.equal(d('Bash', { command: 'node scripts/office.mjs task start "조사"' }), null);
  assert.ok(d('Bash', { command: 'node scripts/office.mjs org export x.json --yes' }), '등록 전에도 org는 거부');
  // 터미널 세션(chiefRun 아님)은 연결 전에는 제한하지 않는다
  assert.equal(decideChiefGuard({ session_id: SID, tool_name: 'WebSearch' }, { ...opts, chiefRun: false }), null);
});

test('[반려] Agent 호출은 같은 업무에서 최대 2회(마지막 deliver·사용자 반려 이후)', () => {
  const call = (rounds) => decideChiefGuard(
    { session_id: SID, tool_name: 'Agent', tool_input: { subagent_type: 'dev-2', description: '[반려] 표 보강' } },
    { root: ROOT, sessions: { [SID]: TASK }, getOrg: org, getRejectRounds: () => rounds },
  );
  assert.equal(call({ flows: 0, calls: 0 }), null);
  assert.equal(call({ flows: 1, calls: 0 }), null, 'flow review 반려를 먼저 기록한 첫 재지시');
  assert.equal(call({ flows: 2, calls: 1 }), null, '두 번째 반려');
  assert.equal(call({ flows: 3, calls: 2 })?.reason, REJECT_LIMIT_MESSAGE);
  assert.equal(call({ flows: 2, calls: 2 })?.reason, REJECT_LIMIT_MESSAGE, '기록 없이 세 번째 재지시');
});

test('프로세스: 연결된 업무가 done이면 허용, [반려] 3회째는 이벤트 기록으로 거부', (t) => {
  const root = makeRoot(t);
  const ev = (o) => appendFileSync(join(root, '.office', 'events.jsonl'), JSON.stringify({ v: 1, ts: '2026-10-29T01:00:00Z', task: TASK, ...o }) + '\n');
  for (let i = 0; i < 2; i++) {
    ev({ kind: 'flow.review', verdict: 'reject', to: 'dev' });
    ev({ kind: 'tool.start', tool: 'Agent', target: 'dev-2', desc: '[반려] 보강' });
  }
  const third = runGuard(root, pre(root, 'Agent', { subagent_type: 'dev-2', description: '[반려] 또 보강', prompt: 'x' }));
  assert.match(JSON.parse(third.stdout).hookSpecificOutput.permissionDecisionReason, /최대 2회/);
  ev({ kind: 'flow.user_reject' });
  assert.equal(runGuard(root, pre(root, 'Agent', { subagent_type: 'dev-2', description: '[반려] 사용자 피드백 반영', prompt: 'x' })).stdout, '', '사용자 반려 뒤에는 다시 센다');
  writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify([{ id: TASK, title: '랜딩', status: 'done' }]));
  assert.equal(runGuard(root, pre(root, 'WebSearch', { query: 'x' })).stdout, '');
  // 대시보드 비서실장 실행은 연결 전에도 판정한다
  const pretask = runGuard(root, pre(root, 'WebSearch', { query: 'x' }, { session_id: 'fresh' }), { OFFICE_CHIEF_RUN: '1' });
  assert.equal(JSON.parse(pretask.stdout).hookSpecificOutput.permissionDecisionReason, PRE_TASK_DENY_MESSAGE);
});
