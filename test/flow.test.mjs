// 업무 흐름(lib/flow.mjs): 서로 다른 조직 구성에서 하달·협조·반려·회의·진행 1줄 유지·계획표 매칭·계획 밖 호출
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanResultText, countReviewRejects, deriveFlow, deriveTaskFlows, isOffplanCall, translateTool } from '../lib/flow.mjs';
import { buildState } from '../dashboard/state.mjs';

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-9999-000000000000';
const TASK = '2026-10-29/html-page';

// 시간순 이벤트 생성기
function timeline(start = '2026-10-29T01:00:00.000Z') {
  let n = 0;
  const ts = () => new Date(Date.parse(start) + (n++) * 1000).toISOString();
  const ev = (o) => ({ v: 1, ts: ts(), engine: 'claude', session: SID, instance: SID, agent: 'chief', ...o });
  return {
    request: (summary, o = {}) => ev({ kind: 'request', summary, ...o }),
    chief: (tool, summary, task) => ev({ kind: 'tool.start', tool, summary, task }),
    taskStart: (task, title) => ev({ session: 'office-cli', instance: 'office-cli', kind: 'task.start', task, summary: title }),
    call: (target, desc, task, o = {}) => ev({ kind: 'tool.start', tool: 'Agent', task, summary: `${target}: ${desc}`, target, desc, ...o }),
    start: (agent, inst, task) => ev({ agent, instance: inst, kind: 'agent.start', task }),
    tool: (agent, inst, tool, summary, task) => ev({ agent, instance: inst, kind: 'tool.start', tool, summary, task }),
    stop: (agent, inst, summary, task) => ev({ agent, instance: inst, kind: 'agent.stop', summary, task }),
    cli: (kind, task, extra = {}) => ev({ session: 'office-cli', instance: 'office-cli', kind, task, ...extra }),
    raw: ev,
  };
}

const stagesOf = (items, task) => items.filter((i) => !task || i.task === task).map((i) => i.stage);

// 1) 마케팅부 + 개발부
const ORG_MKT_DEV = {
  departments: [
    { id: 'marketing', name: '마케팅부', engine: 'claude' },
    { id: 'dev', name: '개발부', engine: 'claude' },
  ],
  roster: [
    { id: 'marketing-1', name: '김팀장', department: 'marketing', lead: true },
    { id: 'dev-2', name: '최대리', department: 'dev' },
  ],
};

function mktDevEvents() {
  const t = timeline();
  return [
    t.request('중고명품 조사하고 HTML 페이지로 만들어줘'),
    t.chief('Read', 'org/roster.json'),
    t.taskStart(TASK, '중고명품 조사 HTML'),
    t.chief('Bash', 'node scripts/office.mjs task start', TASK),
    t.cli('plan.set', TASK, { plan: { task: TASK, goal: '조사 후 HTML', stages: [
      { id: 's1', title: '조사', dept: 'marketing', agent: 'marketing-1', dependsOn: [] },
      { id: 's2', title: 'HTML', dept: 'dev', agent: 'dev-2', dependsOn: ['s1'] },
    ], gaps: [] } }),
    t.call('marketing-1', '중고명품 시장 조사', TASK),
    t.start('marketing-1', 'a1', TASK),
    t.tool('marketing-1', 'a1', 'WebSearch', '중고명품 시장 규모 2026', TASK),
    t.tool('marketing-1', 'a1', 'WebFetch', 'https://news.example.com/a?b=1', TASK),
    t.tool('marketing-1', 'a1', 'Write', '/repo/outputs/2026-10-29/html-page/marketing/research.md', TASK),
    t.stop('marketing-1', 'a1', '조사를 마쳤습니다. 시장은 3조 원입니다.', TASK),
    t.call('dev-2', 'HTML 작성', TASK),
    t.start('dev-2', 'a2', TASK),
    t.tool('dev-2', 'a2', 'Bash', 'python3 build.py', TASK),
    t.tool('dev-2', 'a2', 'Write', '/repo/outputs/2026-10-29/html-page/dev/index.html', TASK),
    t.stop('dev-2', 'a2', 'HTML을 만들었습니다.', TASK),
    t.cli('flow.review_request', TASK, { from: 'dev' }),
    t.cli('flow.review', TASK, { verdict: 'pass' }),
    t.cli('flow.deliver', TASK),
  ];
}

test('마케팅+개발: 요청 → 확인 → 하달 → 진행 → 협조 → 검토 → 사용자 확인 대기, 요청은 나중에 붙은 업무로 묶인다', () => {
  const events = mktDevEvents();
  const { items, tasks } = deriveTaskFlows(events, ORG_MKT_DEV, { tasks: [{ id: TASK, status: 'review' }] });
  assert.deepEqual(stagesOf(items), ['request', 'intake', 'intake', 'intake', 'kickoff', 'assign', 'accept', 'done', 'cooperate', 'accept', 'done', 'review_request', 'review_pass', 'deliver']);
  assert.ok(items.every((i) => i.task === TASK), '업무 등록 전 요청·확인도 같은 업무로 묶는다');
  assert.equal(items[0].text, "사용자 → 비서실장: 업무 요청 '중고명품 조사하고 HTML 페이지로 만들어줘'");
  assert.equal(items[1].text, '비서실장: 요청 내용 확인');
  assert.equal(items[2].text, "비서실장: 업무 등록 '중고명품 조사 HTML'");
  assert.match(items[3].text, /작업 계획 확정 — 단계 2개/);
  assert.equal(items[4].text, '비서실장: 조사 후 HTML 업무 킥오프 — 참석 김팀장, 최대리');
  const assign = items.find((i) => i.stage === 'assign');
  assert.equal(assign.text, '비서실장 → 마케팅부 김팀장: 업무 하달 — 중고명품 시장 조사');
  assert.deepEqual([assign.from, assign.to], ['chief', 'marketing']);
  assert.equal(items.find((i) => i.stage === 'accept').text, '마케팅부 김팀장: 업무 전달받음');
  const done = items.filter((i) => i.stage === 'done');
  assert.equal(done[0].text, '마케팅부 김팀장: 작업 완료 — 조사를 마쳤습니다.');
  assert.deepEqual(done[0].files, ['research.md']);
  assert.deepEqual(done[1].files, ['index.html']);
  const coop = items.find((i) => i.stage === 'cooperate');
  assert.equal(coop.text, '마케팅부 → 개발부 최대리: 업무 협조 요청(비서실장 전달) — HTML 작성');
  assert.deepEqual([coop.from, coop.to], ['marketing', 'dev']);
  assert.ok(!items.some((i) => i.stage === 'progress'), '작업 완료 뒤에는 진행 줄을 지운다');
  assert.ok(!items.some((i) => /python3|build\.py/.test(i.text)), '명령어 원문은 숨긴다');

  const s = tasks[TASK];
  assert.equal(s.current, 'user');
  assert.deepEqual(s.steps.map((x) => x.state), ['done', 'done', 'done', 'done', 'done', 'done', 'current', 'todo']);
  assert.deepEqual(s.depts.sort(), ['dev', 'marketing']);
  assert.deepEqual(s.plan.map((p) => [p.id, p.status]), [['s1', 'done'], ['s2', 'done']]);
  assert.equal(s.rejects, 0);
});

test('progress는 직원 실행마다 마지막 1줄만 유지한다', () => {
  const events = mktDevEvents().slice(0, 10); // research.md 작성까지
  const items = deriveFlow(events, ORG_MKT_DEV);
  const progress = items.filter((i) => i.stage === 'progress');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].text, "마케팅부 김팀장: 진행 중 — 문서 작성 'research.md'");
  assert.equal(progress[0].ts, events[9].ts, '시각은 마지막 도구 시각으로 갱신된다');
  const t = deriveTaskFlows(events, ORG_MKT_DEV).tasks[TASK];
  assert.deepEqual(t.plan.map((p) => p.status), ['active', 'pending']);
});

// 2) 리서치부 + 문서부 + 재무부 (프리셋에 없는 부서 id 포함: 부서 이름을 하드코딩하지 않는다)
const ORG_RDF = {
  departments: [
    { id: 'research', name: '리서치부' },
    { id: 'docs-team', name: '문서부' },
    { id: 'money', name: '재무부' },
  ],
  roster: [
    { id: 'research-1', name: '박팀장', department: 'research', lead: true },
    { id: 'docs-1', name: '이주임', department: 'docs-team' },
    { id: 'money-1', name: '정과장', department: 'money' },
  ],
};

test('리서치+문서+재무: [회의] 소집·참석·의견, 협조 체인, [반려]와 명시 반려는 한 번만, 계획표 반려 횟수', () => {
  const T = '2026-10-29/budget-report';
  const t = timeline();
  const events = [
    t.request('예산 보고서 만들어줘'),
    t.taskStart(T, '예산 보고서'),
    t.call('research-1', '[회의] 범위·분담 제안', T),
    t.call('money-1', '[회의] 범위·분담 제안', T),
    t.start('research-1', 'm1', T),
    t.start('money-1', 'm2', T),
    t.stop('research-1', 'm1', '조사는 리서치부가 맡겠습니다.', T),
    t.stop('money-1', 'm2', '수치 검토는 재무부가 맡겠습니다.', T),
    t.cli('meeting.start', T, { attendees: ['research-1', 'money'], summary: '분담 확정' }),
    t.call('docs-1', '[회의] 문서 형식', T), // 명시 회의 중의 [회의] 호출은 중복 기록하지 않는다
    t.cli('meeting.end', T, { summary: '리서치 → 재무 → 문서 순' }),
    t.cli('plan.set', T, { plan: { task: T, goal: '보고서', stages: [
      { id: 'r', title: '조사', dept: 'research', agent: 'research-1' },
      { id: 'f', title: '수치', dept: 'money', agent: 'money-1', dependsOn: ['r'] },
      { id: 'd', title: '문서', dept: 'docs-team', agent: 'docs-1', dependsOn: ['f'] },
    ] } }),
    t.call('research-1', '시장 자료 조사', T),
    t.start('research-1', 'r1', T),
    t.stop('research-1', 'r1', '자료를 모았습니다.', T),
    t.call('money-1', '수치 정리', T),
    t.start('money-1', 'f1', T),
    t.stop('money-1', 'f1', '수치를 정리했습니다.', T),
    t.call('docs-1', '보고서 작성', T),
    t.start('docs-1', 'd1', T),
    t.stop('docs-1', 'd1', '보고서 초안입니다.', T),
    t.cli('flow.review', T, { verdict: 'reject', to: 'docs-team', summary: '표 단위 누락' }),
    t.call('docs-1', '[반려] 표 단위 보완', T),
    t.start('docs-1', 'd2', T),
    t.stop('docs-1', 'd2', '보완했습니다.', T),
  ];
  const { items, tasks } = deriveTaskFlows(events, ORG_RDF);
  const meeting = items.filter((i) => i.stage === 'meeting');
  assert.deepEqual(meeting.map((m) => m.text), [
    '비서실장 → 리서치부 박팀장: 회의 소집 — 범위·분담 제안',
    '비서실장 → 재무부 정과장: 회의 소집 — 범위·분담 제안',
    '비서실장: 회의 시작 — 분담 확정 (참석: 리서치부 박팀장, 재무부)',
    '비서실장: 회의 종료 — 리서치 → 재무 → 문서 순',
  ]);
  assert.ok(items.some((i) => i.text === '리서치부 박팀장: 회의 참석'));
  assert.ok(items.some((i) => i.text === '재무부 정과장: 회의 의견 제출 — 수치 검토는 재무부가 맡겠습니다.'));
  // 회의 의견은 협조 판단의 '앞선 완료'로 세지 않는다 → 첫 배정은 하달
  const work = items.filter((i) => ['assign', 'cooperate'].includes(i.stage));
  assert.deepEqual(work.map((w) => [w.stage, w.from, w.to]), [
    ['assign', 'chief', 'research'],
    ['cooperate', 'research', 'money'],
    ['cooperate', 'money', 'docs-team'],
  ]);
  assert.equal(work[2].text, '재무부 → 문서부 이주임: 업무 협조 요청(비서실장 전달) — 보고서 작성');
  const rejects = items.filter((i) => i.stage === 'review_reject');
  assert.equal(rejects.length, 1, '명시 반려 뒤의 [반려] 호출은 같은 반려라 한 번만 싣는다');
  assert.equal(rejects[0].text, '비서실장 → 문서부: 검토 반려 — 표 단위 누락');
  assert.ok(items.some((i) => i.text === '문서부 이주임: 반려 사항 확인'));
  const s = tasks[T];
  assert.equal(s.rejects, 1);
  assert.deepEqual(s.plan.map((p) => [p.id, p.status, p.rejects]), [['r', 'done', 0], ['f', 'done', 0], ['d', 'done', 1]]);
});

test('[반려] 호출만 있으면 자동으로 검토 반려를 싣고, 반려 대기 중 단계 상태는 반려', () => {
  const T = '2026-10-29/rej';
  const t = timeline();
  const events = [
    t.taskStart(T, 'x'),
    t.cli('plan.set', T, { plan: { task: T, goal: 'g', stages: [{ id: 'd', title: '문서', dept: 'docs-team', agent: 'docs-1' }] } }),
    t.call('docs-1', '작성', T),
    t.start('docs-1', 'd1', T),
    t.stop('docs-1', 'd1', '초안', T),
  ];
  const explicit = [...events, t.cli('flow.review', T, { verdict: 'reject', to: 'docs-team', summary: '근거 부족' })];
  assert.deepEqual(deriveTaskFlows(explicit, ORG_RDF).tasks[T].plan.map((p) => [p.status, p.rejects]), [['rejected', 1]]);
  const auto = [...events, t.call('docs-1', '[반려] 근거 보강', T)];
  const r = deriveTaskFlows(auto, ORG_RDF);
  assert.equal(r.items.at(-1).text, '비서실장 → 문서부 이주임: 검토 반려 — 근거 보강');
  assert.deepEqual(r.tasks[T].plan.map((p) => [p.status, p.rejects]), [['active', 1]]);
});

// 3) 단일 부서
const ORG_SINGLE = {
  departments: [{ id: 'ops', name: '운영부' }],
  roster: [
    { id: 'ops-1', name: '한팀장', department: 'ops', lead: true },
    { id: 'ops-2', name: '오사원', department: 'ops' },
  ],
};

test('단일 부서: 같은 부서끼리는 협조가 아니라 하달, 계획에 없는 직원 호출은 경고 표시(회의 호출 제외)', () => {
  const T = '2026-10-29/ops-task';
  const t = timeline();
  const plan = { task: T, goal: 'g', stages: [{ id: 'a', title: '정리', dept: 'ops', agent: 'ops-1' }] };
  const events = [
    t.taskStart(T, '엑셀 정리'),
    t.call('ops-2', '[회의] 의견', T), // plan.set 전: 경고 대상 아님
    t.cli('plan.set', T, { plan }),
    t.call('ops-1', '엑셀 정리', T),
    t.start('ops-1', 'o1', T),
    t.stop('ops-1', 'o1', '정리했습니다.', T),
    t.call('ops-2', '서식 다듬기', T),
    t.call('ops-2', '[회의] 추가 의견', T),
  ];
  const items = deriveFlow(events, ORG_SINGLE);
  const work = items.filter((i) => i.stage === 'assign');
  assert.equal(work.length, 2);
  assert.ok(!items.some((i) => i.stage === 'cooperate'));
  assert.equal(work[0].offplan, undefined);
  assert.equal(work[1].offplan, true);
  assert.match(work[1].text, /\(계획에 없는 배정\)$/);
  assert.ok(items.filter((i) => i.stage === 'meeting').every((m) => !m.offplan));
  assert.equal(isOffplanCall(events[6], plan), true);
  assert.equal(isOffplanCall(events[3], plan), false);
  assert.equal(isOffplanCall(events[7], plan), false, '회의 호출은 계획 밖 경고에서 뺀다');
  // 계획표 파일만 있고 plan.set 이벤트가 없으면 단계 상태만 표시하고 경고는 달지 않는다
  const noEvent = events.filter((e) => e.kind !== 'plan.set');
  const r = deriveTaskFlows(noEvent, ORG_SINGLE, { plans: { [T]: plan } });
  assert.ok(!r.items.some((i) => i.offplan));
  assert.deepEqual(r.tasks[T].plan.map((p) => p.status), ['done']);
});

// 4) 휴무 직원·미등록 직원·예전 이벤트 형식
const ORG_OFFDUTY = {
  departments: [{ id: 'research', name: '리서치부' }, { id: 'biz', name: '비즈니스부' }],
  roster: [
    { id: 'research-1', name: '김대리', department: 'research' },
    { id: 'research-2', name: '박사원', department: 'research', active: false },
    { id: 'biz-1', name: '최팀장', department: 'biz', lead: true },
  ],
};

test('휴무 직원 포함: 예전 이벤트(summary만)도 대상 파싱, 미등록 대상 표시, 같은 세션의 다음 요청은 새 업무로 묶는다', () => {
  const A = '2026-10-29/first';
  const B = '2026-10-29/second';
  const t = timeline();
  const events = [
    t.request('첫 업무'),
    t.taskStart(A, '첫 업무'),
    t.raw({ kind: 'tool.start', tool: 'Agent', task: A, summary: 'research-1: 자료 조사' }), // target·desc 필드 없는 예전 형식
    t.start('research-1', 'x1', A),
    t.stop('research-1', 'x1', '끝', A),
    t.raw({ kind: 'tool.start', tool: 'Agent', task: A, summary: 'general-purpose: 아무거나' }),
    // 같은 세션에서 다음 요청: 업무 등록 전 이벤트에는 이전 업무(A)가 붙어 있다
    t.request('두 번째 업무', { task: A }),
    t.chief('Read', 'brief.md', A),
    t.taskStart(B, '두 번째 업무'),
    t.chief('Bash', 'node scripts/office.mjs task start', B),
    t.call('biz-1', '정리', B),
  ];
  const items = deriveFlow(events, ORG_OFFDUTY);
  assert.equal(items.find((i) => i.stage === 'assign').text, '비서실장 → 리서치부 김대리: 업무 하달 — 자료 조사');
  assert.ok(items.some((i) => i.text === '비서실장 → general-purpose(미등록): 업무 하달 — 아무거나'), '조직에 없는 대상은 협조가 아니라 미등록 하달로 표시');
  const second = items.filter((i) => i.task === B).map((i) => i.stage);
  assert.deepEqual(second.slice(0, 3), ['request', 'intake', 'intake'], '두 번째 요청과 확인은 새 업무(B)로 묶인다');
  assert.equal(items.filter((i) => i.task === A && i.stage === 'request').length, 1);
});

// 5) Codex 검증실 포함 + 직원 직접 지시
const ORG_CODEX = {
  departments: [
    { id: 'biz', name: '비즈니스부', engine: 'claude' },
    { id: 'verify', name: '검증실', engine: 'codex' },
  ],
  roster: [
    { id: 'biz-1', name: '최팀장', department: 'biz', lead: true },
    { id: 'verify-1', name: '김검증', department: 'verify' },
  ],
};

test('codex 검증실 포함: 검토 중·판정 표시, 검토자 진행 줄은 판정 뒤 지움, 직원 직접 지시 실행의 완료', () => {
  const T = '2026-10-29/proposal';
  const R = '2026-10-29/run-abc-123456';
  const t = timeline();
  const cx = (o) => t.raw({ engine: 'codex', session: 'run-x', instance: 'run-x', agent: 'verify-1', task: T, ...o });
  const direct = (o) => t.raw({ session: SID2, instance: SID2, agent: 'biz-1', ...o });
  const events = [
    t.taskStart(T, '제안서'),
    t.call('biz-1', '제안서 작성', T),
    t.start('biz-1', 'b1', T),
    t.stop('biz-1', 'b1', '제안서를 썼습니다.', T),
    cx({ kind: 'review.start', summary: '검토' }),
    cx({ kind: 'tool.start', tool: 'Bash', summary: 'cat outputs/x/report.md' }),
    cx({ kind: 'review.end', verdict: 'PASS' }),
    direct({ kind: 'request', summary: '견적서 써줘' }),
    t.raw({ session: 'office-runner', instance: 'office-runner', agent: 'biz-1', kind: 'task.start', task: R, summary: '최팀장: 견적서 써줘' }),
    direct({ kind: 'tool.start', tool: 'Write', summary: '/r/outputs/2026-10-29/run-abc-123456/quote.md', task: R }),
    direct({ kind: 'turn.end', summary: '견적서를 저장했습니다.', task: R }),
  ];
  const items = deriveFlow(events, ORG_CODEX);
  const review = items.filter((i) => i.stage === 'codex_review');
  assert.deepEqual(review.map((r) => r.text), ['검증실 김검증: 검토 중', '검증실 김검증: 판정 PASS']);
  assert.equal(review[1].verdict, 'PASS');
  assert.ok(!items.some((i) => i.stage === 'progress' && i.actor === 'verify-1'));
  const run = items.filter((i) => i.task === R);
  assert.deepEqual(run.map((i) => i.stage), ['request', 'intake', 'done']);
  assert.equal(run[0].text, "사용자 → 비즈니스부 최팀장: 업무 요청 '견적서 써줘'");
  assert.match(run[1].text, /업무 등록\(직접 지시\)/);
  assert.deepEqual(run[2].files, ['quote.md']);
});

test('명시 협조 기록이 자동 도출보다 우선한다(먼저 와도, 나중에 와도 한 줄)', () => {
  const T = '2026-10-29/coop';
  const base = (t) => [t.taskStart(T, 'x'), t.call('marketing-1', '조사', T), t.start('marketing-1', 'q', T), t.stop('marketing-1', 'q', '끝', T)];
  let t = timeline();
  const first = [...base(t), t.cli('flow.cooperate', T, { from: 'marketing', to: 'dev', summary: '시안 전달' }), t.call('dev-2', 'HTML', T)];
  let coop = deriveFlow(first, ORG_MKT_DEV).filter((i) => i.stage === 'cooperate');
  assert.deepEqual(coop.map((c) => c.text), ['마케팅부 → 개발부: 업무 협조 요청(비서실장 전달) — 시안 전달']);
  t = timeline();
  const later = [...base(t), t.call('dev-2', 'HTML', T), t.cli('flow.cooperate', T, { from: 'marketing', to: 'dev', summary: '시안 전달' })];
  coop = deriveFlow(later, ORG_MKT_DEV).filter((i) => i.stage === 'cooperate');
  assert.deepEqual(coop.map((c) => c.text), ['마케팅부 → 개발부: 업무 협조 요청(비서실장 전달) — 시안 전달']);
});

test('사용자 반려 → 재배정 → 다시 확인 대기 → 승인', () => {
  const T = TASK;
  const t = timeline();
  const events = [
    ...mktDevEvents(),
    t.cli('flow.user_reject', T, { summary: '색을 바꿔 주세요' }),
  ];
  let r = deriveTaskFlows(events, ORG_MKT_DEV, { tasks: [{ id: T, status: 'active' }] });
  assert.equal(r.items.at(-1).text, '사용자 → 비서실장: 반려 — 색을 바꿔 주세요');
  assert.notEqual(r.tasks[T].current, 'user', '반려 뒤에는 사용자 확인 단계가 아니다');
  assert.equal(r.tasks[T].userRejects, 1);
  events.push(t.cli('flow.deliver', T), t.cli('flow.user_approve', T));
  r = deriveTaskFlows(events, ORG_MKT_DEV, { tasks: [{ id: T, status: 'done' }] });
  assert.equal(r.items.at(-1).text, '사용자: 승인 — 업무 완료');
  assert.ok(r.tasks[T].steps.every((s) => s.state === 'done'));
});

test('도구 번역: 명령 원문 없이 업무 언어로', () => {
  assert.equal(translateTool('WebSearch', '커피 시장'), "자료 검색 '커피 시장'");
  assert.equal(translateTool('WebFetch', 'https://www.example.co.kr/path?q=1'), "웹페이지 확인 'www.example.co.kr'");
  assert.equal(translateTool('Read', 'C:\\work\\outputs\\a\\brief.md'), "자료 확인 'brief.md'");
  assert.equal(translateTool('Grep', 'TODO'), "자료 확인 'TODO'");
  assert.equal(translateTool('Edit', '/x/report.md'), "문서 작성 'report.md'");
  assert.equal(translateTool('Bash', 'python3 analyze.py --in data.csv'), '분석 스크립트 실행');
  assert.equal(translateTool('Bash', 'curl -s https://x'), '웹 자료 수집');
  assert.equal(translateTool('Bash', 'ls -la && rm -rf tmp'), '데이터 처리 중');
  assert.equal(translateTool('Skill', 'office-task'), "양식 사용 'office-task'");
});

test('buildState: flow·업무 단계·attention(reply·approve·gap, since 오름차순)', () => {
  const events = mktDevEvents();
  const T2 = '2026-10-29/gap-task';
  events.push({ v: 1, ts: '2026-10-29T00:30:00.000Z', session: 'office-cli', instance: 'office-cli', agent: 'chief', kind: 'plan.set', task: T2,
    plan: { task: T2, goal: 'g', stages: [{ id: 'a', title: 't', dept: 'marketing', agent: 'marketing-1' }], gaps: [{ need: 'HTML 작성', suggestion: '개발부 추가 권장' }] } });
  const tasks = [
    { id: TASK, title: '중고명품 조사 HTML', status: 'review', created: '2026-10-29T01:00:00.000Z', updated: '2026-10-29T02:00:00.000Z' },
    { id: T2, title: '공백 업무', status: 'active', created: '2026-10-29T00:10:00.000Z' },
  ];
  const runs = [
    { id: 'r1', agentId: null, target: 'chief', engine: 'claude', status: 'done', needsReply: true, endedAt: '2026-10-29T01:30:00.000Z', summary: '범위를 정해 주세요?' },
    { id: 'r2', agentId: 'dev-2', target: 'dev-2', engine: 'claude', status: 'running', needsReply: true, endedAt: null },
  ];
  const s = buildState({ org: ORG_MKT_DEV, events, runs, tasks, now: '2026-10-29T03:00:00.000Z' });
  assert.ok(Array.isArray(s.flow) && s.flow.length > 0);
  const task = s.tasks.find((x) => x.id === TASK);
  assert.equal(task.stage, 'user');
  assert.equal(task.steps.length, 8);
  assert.deepEqual(s.attention.map((a) => [a.kind, a.agent]), [['gap', 'chief'], ['reply', 'chief'], ['approve', 'chief']]);
  assert.equal(s.attention[0].task, T2);
  assert.match(s.attention[0].text, /HTML 작성 → 개발부 추가 권장/);
  assert.equal(s.attention[1].runId, 'r1');
  assert.equal(s.attention[2].task, TASK);
  assert.equal(s.metrics.attention, 3);
  assert.equal(s.metrics.tasks, 2, '사용자 확인 대기(review)도 진행 중 업무로 센다');
  // 승인되면 approve·gap(완료 업무) 항목이 사라진다
  const after = buildState({ org: ORG_MKT_DEV, events, runs: [], tasks: tasks.map((x) => ({ ...x, status: 'done' })), now: '2026-10-29T03:00:00.000Z' });
  assert.deepEqual(after.attention, []);
});

test('깨진 입력에도 멈추지 않는다: 이벤트가 아닌 값, 잘못된 계획표', () => {
  const T = '2026-10-29/broken';
  const events = [null, 3, 'x', {}, { kind: 'plan.set', task: T, plan: { stages: [null, { id: 1 }] } }, { kind: 'tool.start', tool: 'Agent', task: T }];
  const r = deriveTaskFlows(events, null, { plans: { [T]: { stages: 'nope' }, other: { stages: [null] } } });
  assert.ok(Array.isArray(r.items));
  assert.equal(r.items[0].text, '비서실장 → (대상 미지정): 업무 하달');
});

// ---- 리뷰 지적 회귀 ----
const ORG_RF = {
  departments: [
    { id: 'research', name: '리서치부', engine: 'claude' },
    { id: 'finance', name: '재무부', engine: 'claude' },
  ],
  roster: [
    { id: 'research-1', name: '박팀장', department: 'research', lead: true },
    { id: 'research-2', name: '이대리', department: 'research' },
    { id: 'finance-1', name: '정팀장', department: 'finance', lead: true },
  ],
};
const planSet = (t, stages) => t.cli('plan.set', TASK, { plan: { task: TASK, goal: '목표', stages, gaps: [] } });

test('flow cooperate는 앞서 다른 단계로 받은 정당한 하달을 지우지 않고 다음 호출만 대신한다', () => {
  const t = timeline();
  const events = [
    t.request('조사와 재무 분석'),
    t.taskStart(TASK, '조사·재무'),
    t.call('finance-1', '원가 자료 정리', TASK),
    t.call('research-1', '시장 조사', TASK),
    t.start('finance-1', 'f1', TASK), t.start('research-1', 'r1', TASK),
    t.stop('finance-1', 'f1', '원가 정리 완료.', TASK), t.stop('research-1', 'r1', '조사 완료.', TASK),
    t.cli('flow.cooperate', TASK, { from: 'research', to: 'finance' }),
    t.call('finance-1', '조사 결과로 수익성 분석', TASK),
  ];
  const items = deriveFlow(events, ORG_RF);
  assert.equal(items.filter((i) => i.stage === 'assign' && i.to === 'finance').length, 1, '01:01의 재무부 하달이 남아 있다');
  assert.equal(items.filter((i) => i.stage === 'cooperate').length, 1, '협조는 명시 기록 한 건만');
  // 명시 기록이 호출보다 나중에 오면(앞선 완료 이후의 자동 항목) 그 자동 항목을 대신한다
  const t2 = timeline();
  const late = deriveFlow([
    t2.taskStart(TASK, 'x'),
    t2.call('research-1', '조사', TASK), t2.start('research-1', 'r1', TASK), t2.stop('research-1', 'r1', '완료.', TASK),
    t2.call('finance-1', '분석', TASK),
    t2.cli('flow.cooperate', TASK, { from: 'research', to: 'finance' }),
  ], ORG_RF);
  assert.deepEqual(late.filter((i) => i.stage === 'cooperate').map((i) => i._auto ?? 'explicit'), ['explicit']);
});

test('명시 반려 --to 부서: 부서에 진행·완료 단계가 여럿이면 단계를 고르지 않고 [반려] 대상 직원 단계만 표시한다', () => {
  const t = timeline();
  const events = [
    t.taskStart(TASK, 'x'),
    planSet(t, [
      { id: 'a', title: 'A', dept: 'research', agent: 'research-1', dependsOn: [] },
      { id: 'b', title: 'B', dept: 'research', agent: 'research-2', dependsOn: ['a'] },
    ]),
    t.call('research-1', 'A', TASK), t.start('research-1', 'i1', TASK), t.stop('research-1', 'i1', '완료.', TASK),
    t.call('research-2', 'B', TASK), t.start('research-2', 'i2', TASK), t.stop('research-2', 'i2', '완료.', TASK),
    t.cli('flow.review', TASK, { verdict: 'reject', to: 'research', summary: 'A 단계 출처 누락' }),
    t.call('research-1', '[반려] A 출처 보강', TASK),
  ];
  const plan = Object.fromEntries(deriveTaskFlows(events, ORG_RF).tasks[TASK].plan.map((s) => [s.id, `${s.status}/${s.rejects}`]));
  assert.deepEqual(plan, { a: 'active/1', b: 'done/0' });
  // --stage(또는 --to 직원)를 주면 그 단계만 반려로 표시한다
  const withStage = [...events.slice(0, -1), t.raw({ session: 'office-cli', instance: 'office-cli', kind: 'flow.review', verdict: 'reject', to: 'research', stage: 'b', task: TASK })];
  const p2 = Object.fromEntries(deriveTaskFlows(withStage, ORG_RF).tasks[TASK].plan.map((s) => [s.id, `${s.status}/${s.rejects}`]));
  assert.deepEqual(p2, { a: 'done/0', b: 'rejected/1' });
});

test('계획이 있으면 협조 판정은 dependsOn 기준: 독립 단계는 하달, 앞 단계가 다른 부서면 그 부서가 요청 부서', () => {
  const t = timeline();
  const base = [
    t.taskStart(TASK, 'x'),
    planSet(t, [
      { id: 'a', title: 'A', dept: 'research', agent: 'research-1', dependsOn: [] },
      { id: 'b', title: 'B', dept: 'finance', agent: 'finance-1', dependsOn: [] },
    ]),
    t.call('research-1', 'A', TASK), t.start('research-1', 'i1', TASK), t.stop('research-1', 'i1', '완료.', TASK),
    t.call('finance-1', 'B', TASK),
  ];
  const r = deriveTaskFlows(base, ORG_RF);
  assert.equal(r.items.at(-1).stage, 'assign', '서로 독립인 단계는 협조가 아니다');
  assert.notEqual(r.tasks[TASK].current, 'cooperate');
  const t2 = timeline();
  const dep = deriveFlow([
    t2.taskStart(TASK, 'x'),
    planSet(t2, [
      { id: 'a', title: 'A', dept: 'research', agent: 'research-1', dependsOn: [] },
      { id: 'b', title: 'B', dept: 'finance', agent: 'finance-1', dependsOn: ['a'] },
    ]),
    t2.call('research-1', 'A', TASK), t2.start('research-1', 'i1', TASK), t2.stop('research-1', 'i1', '완료.', TASK),
    t2.call('finance-1', 'B', TASK),
  ], ORG_RF);
  assert.deepEqual([dep.at(-1).stage, dep.at(-1).from, dep.at(-1).to], ['cooperate', 'research', 'finance']);
});

test('계획의 Codex 검토 단계는 review.start/end로 진행·완료된다', () => {
  const org = { departments: [{ id: 'dev', name: '개발부' }, { id: 'verify', name: '검증실', engine: 'codex' }], roster: [{ id: 'dev-2', name: '최대리', department: 'dev' }, { id: 'verify-1', name: '이검증', department: 'verify' }] };
  const t = timeline();
  const events = [
    t.taskStart(TASK, 'x'),
    planSet(t, [
      { id: 'html', title: 'HTML', dept: 'dev', agent: 'dev-2', dependsOn: [] },
      { id: 'check', title: '검토', dept: 'verify', agent: 'verify-1', dependsOn: ['html'] },
    ]),
    t.call('dev-2', 'HTML', TASK), t.start('dev-2', 'i1', TASK), t.stop('dev-2', 'i1', '완료.', TASK),
    t.raw({ engine: 'codex', session: 'codex-x', instance: 'codex-x', agent: 'verify-1', kind: 'review.start', task: TASK }),
  ];
  const st = (evs) => Object.fromEntries(deriveTaskFlows(evs, org).tasks[TASK].plan.map((s) => [s.id, s.status]));
  assert.equal(st(events).check, 'active');
  assert.equal(st([...events, t.raw({ engine: 'codex', session: 'codex-x', instance: 'codex-x', agent: 'verify-1', kind: 'review.end', verdict: 'PASS', task: TASK })]).check, 'done');
});

test('단계 표시줄: 사용자 반려 뒤에는 하달, 검토 반려 뒤에는 진행이 현재 단계이고 다시 진행하면 앞으로 간다', () => {
  const events = mktDevEvents();
  const t = timeline('2026-10-29T02:00:00.000Z');
  const rejected = [...events, t.raw({ session: 'office-server', instance: 'office-server', agent: undefined, kind: 'flow.user_reject', task: TASK, summary: '경쟁사 추가' })];
  let s = deriveTaskFlows(rejected, ORG_MKT_DEV, { tasks: [{ id: TASK, status: 'active' }] }).tasks[TASK];
  assert.equal(s.current, 'assign');
  assert.deepEqual(s.steps.map((x) => x.state), ['done', 'done', 'current', 'todo', 'todo', 'todo', 'todo', 'todo']);
  const again = [...rejected, t.call('marketing-1', '경쟁사 추가 조사', TASK), t.start('marketing-1', 'a9', TASK)];
  s = deriveTaskFlows(again, ORG_MKT_DEV, { tasks: [{ id: TASK, status: 'active' }] }).tasks[TASK];
  assert.equal(s.current, 'progress', '재배정 뒤 다시 진행');

  const t2 = timeline();
  const rr = deriveTaskFlows([
    t2.taskStart(TASK, 'x'),
    t2.call('dev-2', 'HTML', TASK), t2.start('dev-2', 'i1', TASK), t2.stop('dev-2', 'i1', '완료.', TASK),
    t2.cli('flow.review_request', TASK, { from: 'dev' }),
    t2.cli('flow.review', TASK, { verdict: 'reject', to: 'dev' }),
  ], ORG_MKT_DEV, { tasks: [{ id: TASK, status: 'active' }] }).tasks[TASK];
  assert.equal(rr.current, 'progress');
  assert.equal(rr.rejects, 1);
});

test('작업 완료 문구: Markdown·경로를 걷어내고, 끝내지 못한 보고는 작업 완료로 쓰지 않는다', () => {
  assert.equal(cleanResultText('결과: `outputs/2026-10-29/office-chair-launch/research/market.md` 작성 완료. 다음 단계'), 'market.md 작성 완료.');
  assert.equal(cleanResultText('**조건부 진행** | 산출물 | 내용 |\n|---|---|'), '조건부 진행 산출물 내용');
  const t = timeline();
  const items = deriveFlow([
    t.taskStart(TASK, 'x'),
    t.call('dev-2', '요약', TASK), t.start('dev-2', 'i1', TASK),
    t.stop('dev-2', 'i1', '`outputs/2026-10-29/html-page/dev/summary.md` 작성을 하지 못했습니다. 권한 문제입니다.', TASK),
  ], ORG_MKT_DEV);
  const done = items.at(-1);
  assert.equal(done.text, '개발부 최대리: 작업 종료(확인 필요) — summary.md 작성을 하지 못했습니다.');
  assert.equal(done.warn, true);
});

test('reply.wait는 업무 피드에 답변 대기 줄(run 포함)로 나온다', () => {
  const t = timeline();
  const items = deriveFlow([t.raw({ session: 'run-abc', instance: 'run-abc', agent: 'marketing-1', kind: 'reply.wait', run: 'abc', task: TASK, summary: '어느 지역을 볼까요?' })], ORG_MKT_DEV);
  assert.deepEqual(items.map((i) => [i.stage, i.run, i.task]), [['reply_wait', 'abc', TASK]]);
  assert.equal(items[0].text, '마케팅부 김팀장 님이 답변을 기다립니다 — 어느 지역을 볼까요?');
});

test('countReviewRejects: 마지막 deliver·사용자 반려 뒤의 flow review 반려·[반려] 호출 수', () => {
  const t = timeline();
  const evs = [
    t.cli('flow.review', TASK, { verdict: 'reject', to: 'dev' }),
    t.call('dev-2', '[반려] 보강', TASK),
    t.cli('flow.review', TASK, { verdict: 'pass' }),
    t.cli('flow.deliver', TASK),
    t.cli('flow.review', TASK, { verdict: 'reject', to: 'dev' }),
    t.call('dev-2', '[반려] 다시', TASK),
    t.call('dev-2', '[반려] 또', TASK),
    t.cli('flow.review', 'other/task', { verdict: 'reject' }),
  ];
  assert.deepEqual(countReviewRejects(evs, TASK), { flows: 1, calls: 2 });
});
