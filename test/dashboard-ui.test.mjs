// 대시보드 화면(dashboard/public)의 순수 로직과 정적 파일 계약을 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutOffice, routeBetween, hashString, lookFor, openReviewers, meetingAttendees, iconScale, ATTENTION_ICONS, meetingSeats, activeRoom } from '../dashboard/public/office.js';
import {
  normalizeState, planBulkAgents, agentPayloadFromPlan, kebab, validId, nextAgentId, titleFor,
  timeAgo, esc, findPresetFor, presetList, runAgentId,
  normalizeFlow, taskSteps, groupFlowFeed, planStages, normalizeAttention, attentionByAgent, attentionKey,
  titleWithAttention, freshAttention, collectGaps, normalizeOutputs, filterOutputs, fileKind, groupOutputFiles,
  parseTags, safeColor, stepIndexOf, FLOW_STEPS, VIEWS,
  withRo, withPreviewCsp, PREVIEW_META_CSP,
  classifyChiefInput, chiefInputAction, normalizeMeetings, meetingBadge, STAGE_LABEL, PLAN_STATUS_LABEL,
} from '../dashboard/public/app.js';
import { FLOW_STAGES } from '../lib/flow.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'public');

function makeDepts(counts) {
  return counts.map((n, i) => ({
    id: `d${i}`, name: `부서${i}`, color: '#38bdf8',
    members: Array.from({ length: n }, (_, k) => ({ id: `d${i}-${k + 1}` })),
  }));
}

test('index.html: 토큰 메타·모듈 스크립트·외부 리소스 없음', async () => {
  const html = await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<meta name="office-token" content="__OFFICE_TOKEN__">/);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
  for (const file of ['index.html', 'styles.css', 'app.js', 'office.js']) {
    const text = await readFile(path.join(PUBLIC, file), 'utf8');
    assert.doesNotMatch(text, /(src|href)=["']https?:\/\//i, `${file}에 외부 리소스가 있음`);
    assert.doesNotMatch(text, /@import|url\(\s*["']?https?:/i, `${file}에 외부 CSS가 있음`);
  }
});

test('app.js: 상태 변경 요청은 토큰과 JSON Content-Type 헤더를 보낸다', async () => {
  const src = await readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(src, /'X-Office-Token': token/);
  assert.match(src, /'Content-Type': 'application\/json'/);
  assert.match(src, /new EventSource\('\/api\/stream'\)/);
});

test('layoutOffice: 부서 0개면 대표실·비서실·회의실만 있고, 비서실은 대표실 옆에 비서실장 자리가 있다', () => {
  const l = layoutOffice([]);
  assert.deepEqual(l.rooms.map((r) => r.kind), ['ceo', 'chief', 'meeting']);
  assert.equal(l.seats.size, 0, '비서실장 자리는 직원 좌석 맵에 넣지 않는다');
  assert.ok(l.width > 0 && l.height > 0);
  assert.equal(l.chief.y, l.ceo.y);
  assert.ok(l.chief.x > l.ceo.x + l.ceo.w, '비서실은 대표실 오른쪽');
  assert.equal(l.chiefSeat.agentId, 'chief');
  const s = l.chiefSeat;
  assert.ok(s.x0 >= l.chief.x && s.x0 + 60 <= l.chief.x + l.chief.w && s.y0 + 66 <= l.chief.y + l.chief.h, '비서실장 자리는 비서실 안');
  // 좁은 화면(1열)에서는 회의실을 다음 줄로 내려 폭을 줄인다
  const narrow = layoutOffice([], { maxCols: 1 });
  assert.ok(narrow.meeting.y > narrow.ceo.y + narrow.ceo.h);
  assert.ok(narrow.width < l.width);
  for (const r of narrow.rooms) assert.ok(r.x + r.w <= narrow.width && r.y + r.h <= narrow.height);
});

test('layoutOffice: 6개 부서 40명 — 좌석 유일, 방 겹침 없음, 격자 3열', () => {
  const depts = makeDepts([12, 7, 6, 5, 4, 6]);
  const l = layoutOffice(depts);
  assert.equal(l.gridCols, 3);
  assert.equal(l.seats.size, 40);
  const rooms = l.rooms;
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]; const b = rooms[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.id}와 ${b.id}가 겹침`);
    }
  }
  for (const room of rooms) {
    assert.ok(room.x + room.w <= l.width && room.y + room.h <= l.height, `${room.id}가 월드 밖`);
    for (const s of room.seats || []) {
      assert.ok(s.x0 >= room.x && s.x0 + 60 <= room.x + room.w, '좌석이 방 밖');
    }
  }
  // 인원이 많은 방이 더 크다
  const big = rooms.find((r) => r.id === 'd0');
  const small = rooms.find((r) => r.id === 'd4');
  assert.ok(big.w * big.h > small.w * small.h);
});

test('layoutOffice: 부서 수 제한 없음(20개)과 빈 부서의 직원 추가 영역', () => {
  const l = layoutOffice(makeDepts(Array.from({ length: 20 }, (_, i) => i % 3)));
  assert.equal(l.rooms.filter((r) => r.kind === 'dept').length, 20);
  assert.equal(l.gridCols, 4);
  const empty = l.rooms.find((r) => r.id === 'd0');
  assert.ok(empty.addHint && empty.addHint.w > 0);
});

test('routeBetween: 목적지에서 끝나고, 세로 통로는 부서 방을 지나지 않는다', () => {
  const l = layoutOffice(makeDepts([8, 3, 5, 2, 9, 1, 4]));
  const depts = l.rooms.filter((r) => r.kind === 'dept');
  for (const from of [...depts, l.chief]) {
    for (const to of [l.ceo, l.chief, l.meeting, ...depts]) {
      const start = from.seats[0] || from.doorIn;
      const dest = to.spots ? to.spots[0] : (to.seats[0] || to.doorIn);
      const pts = routeBetween(start, from, dest, to);
      assert.deepEqual(pts.at(-1), { x: dest.x, y: dest.y });
      if (from === to) { assert.equal(pts.length, 1); continue; }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]; const b = pts[i + 1];
        if (a.x !== b.x || a.y === b.y) continue;
        // 세로 이동 구간(복도 통로)이 다른 방 내부를 관통하지 않는지
        for (const r of depts) {
          if (r === from || r === to) continue;
          const inside = a.x > r.x && a.x < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h;
          assert.ok(!inside, `${from.id}→${to.id} 경로가 ${r.id}를 관통`);
        }
      }
    }
  }
});

test('hashString/lookFor: 같은 id는 같은 외형', () => {
  assert.equal(hashString('research-1'), hashString('research-1'));
  assert.notEqual(hashString('research-1'), hashString('research-2'));
  assert.deepEqual(lookFor('a-1'), lookFor('a-1'));
  const look = lookFor('x-9');
  for (const key of ['hair', 'shirt', 'pants', 'skin']) assert.match(look[key], /^#[0-9a-f]{6}$/i);
});

test('openReviewers: review.start 후 end가 없는 검토자만', () => {
  const feed = [
    { ts: '2026-10-29T05:00:03Z', kind: 'review.end', agent: 'fact-checker', verdict: 'PASS' },
    { ts: '2026-10-29T05:00:01Z', kind: 'review.start', agent: 'fact-checker' },
    { ts: '2026-10-29T05:00:02Z', kind: 'review.start', agent: 'number-auditor' },
    { ts: '2026-10-29T05:00:04Z', kind: 'tool.start', agent: 'x' },
  ];
  assert.deepEqual([...openReviewers(feed)], ['number-auditor']);
});

test('normalizeState: 빈 입력도 안전하다', () => {
  const s = normalizeState(undefined);
  assert.deepEqual(s.departments, []);
  assert.deepEqual(s.presets, []);
  assert.equal(s.metrics.active, 0);
  assert.equal(s.demo, false);
});

test('normalizeState: roster + agents 상태 + 부서 members(id 배열)', () => {
  const raw = {
    metrics: { active: 1, standby: 0, idle: 1, offline: 0, tasks: 2, reviews: 1, tools: 9 },
    departments: [{ id: 'research', name: '리서치부', color: '#38bdf8', members: ['research-1', 'research-2', 'research-3'], progress: 50 }],
    roster: [
      { id: 'research-1', name: '김대리', department: 'research', rank: '대리', lead: true },
      { id: 'research-2', name: '이사원', department: 'research', rank: '사원' },
      { id: 'research-3', name: '박주임', department: 'research', rank: '주임', active: false },
    ],
    agents: { 'research-1': { status: 'working', lastTool: 'WebSearch' }, 'research-2': { status: 'idle' }, 'research-3': { status: 'off-duty' } },
    presets: { departments: [{ id: 'research', name: '리서치부', roles: [] }] },
    feed: [{ ts: '2026-10-29T05:00:00Z', kind: 'tool.start' }, { ts: '2026-10-29T06:00:00Z', kind: 'tool.end' }],
    demo: true,
  };
  const s = normalizeState(raw);
  const d = s.departments[0];
  assert.equal(d.memberCount, 3);
  assert.equal(d.members[0].name, '김대리');
  assert.equal(d.members[0].status, 'working');
  assert.equal(d.members[0].lastTool, 'WebSearch');
  assert.equal(d.offCount, 1);
  assert.equal(d.progress, 0.5);
  assert.equal(s.agents['research-3'].active, false);
  assert.equal(s.metrics.off, 1);
  assert.equal(s.metrics.tools, 9);
  assert.equal(s.presets.length, 1);
  assert.equal(s.feed[0].kind, 'tool.end', '피드는 최신순');
  assert.equal(s.demo, true);
});

test('normalizeState: roster 없이 agents 맵에 직원 필드가 있는 형태도 읽는다', () => {
  const s = normalizeState({
    departments: [{ id: 'dev', name: '개발부', members: 2 }],
    agents: {
      'dev-1': { name: '최과장', department: 'dev', status: 'standby' },
      'dev-2': { name: '정사원', department: 'dev', status: 'working' },
    },
  });
  assert.equal(s.departments[0].memberCount, 2);
  assert.equal(s.departments[0].activeCount, 1);
  assert.deepEqual(s.departments[0].live, ['dev-2']);
  assert.equal(s.metrics.standby, 1);
});

test('normalizeState: progress는 서버의 0~100 정수(%)로 해석하고, 1 이하 소수는 비율로 본다', () => {
  const p = (v) => normalizeState({ departments: [{ id: 'a', name: 'A', progress: v }] }).departments[0].progress;
  assert.equal(p(100), 1);
  assert.equal(p(1), 0.01);
  assert.equal(p(0), 0);
  assert.equal(p(0.25), 0.25);
  assert.equal(p(250), 1);
});

test('normalizeState: 비서실장·미등록 인원은 직원 수에서 빠진다', () => {
  const s = normalizeState({
    departments: [{ id: 'dev', name: '개발부', members: ['dev-1'] }],
    agents: {
      'dev-1': { id: 'dev-1', name: '김대리', department: 'dev', status: 'idle' },
      chief: { id: 'chief', name: '비서실장', department: null, chief: true, status: 'working' },
      ghost: { id: 'ghost', name: 'ghost', department: null, unregistered: true, status: 'standby' },
    },
    unregistered: ['ghost'],
  });
  assert.equal(s.people, 1);
  assert.equal(s.metrics.active, 0);
  assert.deepEqual(s.unregistered.map((u) => u.id), ['ghost']);
});

test('normalizeState: members가 객체 배열이어도 직원 정보를 합친다', () => {
  const s = normalizeState({
    departments: [{ id: 'ops', name: '운영부', members: [{ id: 'ops-1', name: '한대리' }] }],
    agents: { 'ops-1': { status: 'idle' } },
  });
  assert.equal(s.agents['ops-1'].name, '한대리');
  assert.equal(s.agents['ops-1'].department, 'ops');
});

test('planBulkAgents: id·이름 유일, 팀장 1명, 기존 팀장 존중', () => {
  const roles = [
    { key: 'lead', name: '팀장', lead: true, specialty: '취합' },
    { key: 'a', name: '분석', specialty: '분석' },
    { key: 'b', name: '조사', specialty: '조사' },
    { key: 'c', name: '작성', specialty: '작성', lead: true },
  ];
  const plans = planBulkAgents('research', roles, [], ['research']);
  assert.equal(plans.length, 4);
  assert.equal(new Set(plans.map((p) => p.id)).size, 4);
  assert.equal(new Set(plans.map((p) => p.name)).size, 4);
  assert.equal(plans.filter((p) => p.lead).length, 1);
  assert.equal(plans[0].rank, '팀장');
  assert.equal(plans[0].title, '팀장');
  for (const p of plans) assert.ok(validId(p.id), p.id);

  const existing = [{ id: 'research-1', name: '김팀장', department: 'research', lead: true }];
  const more = planBulkAgents('research', roles, existing);
  assert.equal(more.filter((p) => p.lead).length, 0, '이미 팀장이 있으면 추가 팀장 없음');
  assert.ok(!more.some((p) => p.id === 'research-1'));
  assert.ok(!more.some((p) => p.name === '김팀장'));

  const body = agentPayloadFromPlan('research', plans[1]);
  assert.equal(body.department, 'research');
  assert.equal(body.specialty, '분석');
  assert.equal(body.active, true);
  assert.ok(Array.isArray(body.thoughts));
});

test('id·직함 보조 함수', () => {
  assert.equal(kebab('Research Team'), 'research-team');
  assert.equal(kebab('리서치'), '');
  assert.equal(kebab('3D Lab'), 'd-lab');
  assert.ok(validId('research-3'));
  assert.ok(!validId('Research'));
  assert.ok(!validId('a'));
  assert.equal(nextAgentId('research', new Set(['research-1', 'research-2'])), 'research-3');
  assert.ok(nextAgentId('x'.repeat(60), new Set()).length <= 48);
  assert.equal(titleFor('대리', false), '담당');
  assert.equal(titleFor('과장', false), '선임');
  assert.equal(titleFor('사원', true), '팀장');
});

test('표시용 보조 함수', () => {
  const now = Date.parse('2026-10-29T05:10:00Z');
  assert.equal(timeAgo('2026-10-29T05:09:55Z', now), '방금');
  assert.equal(timeAgo('2026-10-29T05:05:00Z', now), '5분 전');
  assert.equal(timeAgo(null, now), '기록 없음');
  assert.equal(esc('<b a="1">&\''), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;');
  assert.deepEqual(presetList([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(presetList(null), []);
  const presets = [{ id: 'research', en: 'RESEARCH', name: '리서치부' }, { id: 'ops', en: 'OPERATIONS', name: '운영부' }];
  assert.equal(findPresetFor({ id: 'research-2', en: 'research' }, presets).id, 'research');
  assert.equal(findPresetFor({ id: 'x', name: '운영부' }, presets).id, 'ops');
  assert.equal(findPresetFor({ id: 'x', name: '없음' }, presets), null);
  assert.equal(runAgentId({ agentId: 'a' }), 'a');
  assert.equal(runAgentId({ target: 'b' }), 'b');
  assert.equal(runAgentId({ target: 'review', engine: 'codex' }), null);
  assert.equal(runAgentId({}), null);
});

test('routeBetween: 1열 배치에서도 윗줄 방 사이 경로에 NaN이 없다', () => {
  const l = layoutOffice(makeDepts([3, 2]), { maxCols: 1 });
  for (const [a, b] of [[l.chief, l.meeting], [l.ceo, l.meeting], [l.meeting, l.rooms.at(-1)]]) {
    const pts = routeBetween(a.doorIn, a, b.doorIn, b);
    for (const p of pts) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${a.id}→${b.id}`);
  }
});

test('meetingAttendees: meeting.start~end와 [회의] 흐름 항목(완료 전까지)', () => {
  const now = Date.parse('2026-10-29T05:10:00Z');
  const feed = [
    { ts: '2026-10-29T05:00:00Z', kind: 'meeting.start', task: 't1', attendees: ['mkt-1', 'dev-1'] },
    { ts: '2026-10-29T05:01:00Z', kind: 'meeting.start', task: 't2', attendees: 'res-1, res-2' },
    { ts: '2026-10-29T05:02:00Z', kind: 'meeting.end', task: 't2' },
    { ts: '2026-10-29T03:00:00Z', kind: 'meeting.start', task: 'old', attendees: ['stale-1'] },
  ];
  const flow = [
    { ts: '2026-10-29T05:03:00Z', task: 't3', stage: 'meeting', from: 'chief', to: 'finance', target: 'fin-1' },
    { ts: '2026-10-29T05:03:00Z', task: 't3', stage: 'meeting', from: 'chief', to: 'ops', target: 'ops-1' },
    { ts: '2026-10-29T05:05:00Z', task: 't3', stage: 'done', actor: 'ops-1' },
  ];
  assert.deepEqual([...meetingAttendees(feed, flow, now)].sort(), ['dev-1', 'fin-1', 'mkt-1']);
  assert.equal(meetingAttendees([], [], now).size, 0);
});

test('의견 필요 아이콘: 세 종류 비트맵은 행 길이가 같고, 크기는 1/z로 보정된다', () => {
  for (const [kind, rows] of Object.entries(ATTENTION_ICONS)) {
    assert.ok(rows.length >= 8, kind);
    assert.ok(rows.every((r) => r.length === rows[0].length), `${kind} 행 길이`);
    assert.ok(rows.every((r) => /^[#odk.]+$/.test(r)), `${kind} 문자`);
  }
  assert.deepEqual(Object.keys(ATTENTION_ICONS).sort(), ['approve', 'gap', 'reply']);
  assert.equal(iconScale(1), 1);
  assert.equal(iconScale(2), 1, '확대 시에는 원래 크기');
  assert.equal(iconScale(0.5), 2);
  assert.equal(iconScale(0.1), 3.2, '상한');
});

// SPEC "업무 흐름" 예시: 마케팅 조사 → 개발부 협조 → 비서실장 검토 통과 → 사용자 확인 대기
const FLOW_A = [
  { task: 'A', ts: '2026-10-29T05:00:00Z', stage: 'request', from: 'user', to: 'chief', text: "사용자 → 비서실장: 업무 요청 '랜딩'" },
  { task: 'A', ts: '2026-10-29T05:00:05Z', stage: 'intake', actor: 'chief', text: '비서실장: 요청 내용 확인' },
  { task: 'A', ts: '2026-10-29T05:00:10Z', stage: 'assign', from: 'chief', to: 'mkt-1', dept: 'marketing' },
  { task: 'A', ts: '2026-10-29T05:00:11Z', stage: 'accept', actor: 'mkt-1', dept: 'marketing' },
  { task: 'A', ts: '2026-10-29T05:00:20Z', stage: 'progress', actor: 'mkt-1', text: "자료 검색 '경쟁사'" },
  { task: 'A', ts: '2026-10-29T05:00:30Z', stage: 'progress', actor: 'mkt-1', text: "문서 작성 'research.md'" },
  { task: 'A', ts: '2026-10-29T05:00:40Z', stage: 'done', actor: 'mkt-1', files: ['research.md'] },
  { task: 'A', ts: '2026-10-29T05:00:50Z', stage: 'cooperate', from: 'marketing', to: 'dev-1', dept: 'dev' },
  { task: 'A', ts: '2026-10-29T05:01:00Z', stage: 'progress', actor: 'dev-1', text: "문서 작성 'index.html'" },
  { task: 'A', ts: '2026-10-29T05:01:30Z', stage: 'done', actor: 'dev-1' },
  { task: 'A', ts: '2026-10-29T05:01:40Z', stage: 'review_request', from: 'dev', to: 'chief' },
  { task: 'A', ts: '2026-10-29T05:01:50Z', stage: 'review_pass', actor: 'chief' },
  { task: 'A', ts: '2026-10-29T05:02:00Z', stage: 'deliver', actor: 'chief' },
];

test('normalizeFlow: 배열·{items}·업무별 맵을 시간순 배열로', () => {
  const shuffled = [FLOW_A[2], FLOW_A[0], FLOW_A[1]];
  assert.deepEqual(normalizeFlow(shuffled).map((x) => x.stage), ['request', 'intake', 'assign']);
  assert.equal(normalizeFlow({ items: FLOW_A }).length, FLOW_A.length);
  const byTask = normalizeFlow({ B: [{ ts: '2026-10-29T05:00:00Z', stage: 'request' }] });
  assert.equal(byTask[0].task, 'B');
  assert.deepEqual(normalizeFlow(null), []);
  assert.deepEqual(normalizeFlow([null, { ts: 'x' }, 3]), [], 'stage 없는 항목은 버린다');
});

test('taskSteps: 사용자 확인 대기 업무는 "사용자 확인"이 현재 단계이고 앞 단계는 모두 완료', () => {
  const st = taskSteps({ id: 'A', status: 'review' }, normalizeFlow(FLOW_A));
  assert.deepEqual(FLOW_STEPS.map((s) => s.label), ['요청', '확인', '하달', '진행', '협조', '검토', '사용자 확인', '완료']);
  assert.equal(st.steps[st.current].label, '사용자 확인');
  assert.deepEqual(st.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'done', 'current', 'todo']);
  assert.equal(st.rejects, 0);
  assert.equal(st.back, null);
  const done = taskSteps({ id: 'A', status: 'done' }, normalizeFlow(FLOW_A));
  assert.ok(done.steps.every((s) => s.state === 'done'));
});

test('taskSteps: 검토 반려는 진행으로, 사용자 반려는 하달로 되돌리고 횟수를 센다', () => {
  const flow = normalizeFlow([
    { task: 'B', ts: '1', stage: 'request' }, { task: 'B', ts: '2', stage: 'assign' }, { task: 'B', ts: '3', stage: 'done' },
    { task: 'B', ts: '4', stage: 'review_request' }, { task: 'B', ts: '5', stage: 'review_reject', to: 'dev-1' },
    { task: 'B', ts: '6', stage: 'progress', actor: 'dev-1' },
  ]);
  const st = taskSteps({ id: 'B', status: 'active' }, flow);
  assert.equal(st.rejects, 1);
  assert.equal(st.steps[st.current].label, '진행');
  assert.equal(st.back.to, stepIndexOf('progress'));
  assert.equal(st.back.from, stepIndexOf('review_reject'));
  assert.equal(st.steps[1].state, 'skip', '거치지 않은 확인 단계');
  const user = taskSteps({ id: 'C' }, normalizeFlow([{ task: 'C', ts: '1', stage: 'deliver' }, { task: 'C', ts: '2', stage: 'user_reject' }]));
  assert.equal(user.steps[user.current].label, '하달');
  assert.equal(user.rejects, 1);
  assert.equal(taskSteps({ id: 'Z' }, []).current, -1);
});

test('groupFlowFeed: 업무별 묶음, progress는 직원별 1줄, 완료되면 진행 줄을 지운다', () => {
  const live = normalizeFlow([...FLOW_A.slice(0, 6), { task: 'X', ts: '2026-10-29T06:00:00Z', stage: 'request' }]);
  const groups = groupFlowFeed(live);
  assert.deepEqual(groups.map((g) => g.task), ['X', 'A'], '최근 활동한 업무가 먼저');
  const a = groups[1];
  const progress = a.items.filter((x) => x.stage === 'progress');
  assert.equal(progress.length, 1, '진행은 누적하지 않는다');
  assert.match(progress[0].text, /research\.md/);
  const after = groupFlowFeed(normalizeFlow(FLOW_A))[0];
  assert.equal(after.items.filter((x) => x.stage === 'progress').length, 0);
  assert.deepEqual(after.items.map((x) => x.stage).slice(-3), ['review_request', 'review_pass', 'deliver']);
  const capped = groupFlowFeed(normalizeFlow(FLOW_A), { maxItems: 3 })[0];
  assert.equal(capped.items.length, 3);
  assert.ok(capped.hidden > 0);
});

test('planStages: stage.agent 매칭으로 대기·진행·완료·반려를 도출하고, 서버 status는 그대로 쓴다', () => {
  const plan = { version: 1, stages: [
    { id: 's1', title: '조사', dept: 'marketing', agent: 'mkt-1' },
    { id: 's2', title: 'HTML', dept: 'dev', agent: 'dev-1', dependsOn: ['s1'] },
    { id: 's3', title: '정리', dept: 'ops', agent: 'ops-1' },
  ] };
  const flow = normalizeFlow(FLOW_A.slice(0, 9));
  assert.deepEqual(planStages(plan, flow, 'A').map((s) => s.status), ['done', 'run', 'wait']);
  const rej = normalizeFlow([...FLOW_A, { task: 'A', ts: '2026-10-29T05:03:00Z', stage: 'review_reject', to: 'dev' }]);
  assert.equal(planStages(plan, rej, 'A')[1].status, 'reject', '부서 단위 반려');
  const explicit = { stages: [{ id: 'a', agent: 'x', status: '완료' }, { id: 'b', agent: 'y', status: 'running' }] };
  assert.deepEqual(planStages(explicit, [], 'A').map((s) => s.status), ['done', 'run']);
  assert.deepEqual(planStages(null, flow, 'A'), []);
});

test('attention: since 오름차순, 직원별 대표 아이콘(사용자 확인 > 답변 > 공백), 제목 접두', () => {
  const list = normalizeAttention([
    { kind: 'gap', agent: 'chief', task: 'A', since: '2026-10-29T05:00:00Z', text: 'HTML 작성 가능한 부서 없음' },
    { kind: 'reply', agent: 'dev-1', runId: 'r2', since: '2026-10-29T05:02:00Z', text: '어느 색?' },
    { kind: 'approve', agent: 'chief', task: 'A', since: '2026-10-29T05:01:00Z', text: '' },
    { kind: 'weird', agent: 'x' },
  ]);
  assert.deepEqual(list.map((a) => a.kind), ['gap', 'approve', 'reply']);
  const map = attentionByAgent(list);
  assert.equal(map.get('chief').top.kind, 'approve');
  assert.equal(map.get('chief').items.length, 2);
  assert.equal(map.get('dev-1').top.kind, 'reply');
  assert.equal(titleWithAttention('AGENT HQ', 3), '(3) 답변 필요 · AGENT HQ');
  assert.equal(titleWithAttention('AGENT HQ', 0), 'AGENT HQ');
  const seen = new Set([attentionKey(list[0])]);
  assert.deepEqual(freshAttention(list, seen).map((a) => a.kind), ['approve', 'reply']);
  // 서버가 attention을 주지 않으면 needsReply run으로 대신한다
  const fallback = normalizeAttention(undefined, [
    { id: 'r1', target: 'chief', needsReply: true, status: 'done', endedAt: '2026-10-29T05:00:00Z' },
    { id: 'r3', agentId: 'dev-1', needsReply: true, status: 'running' },
  ]);
  assert.deepEqual(fallback.map((a) => [a.kind, a.agent, a.runId]), [['reply', 'chief', 'r1']]);
});

test('normalizeState: flow·attention·gaps를 싣는다', () => {
  const s = normalizeState({
    flow: FLOW_A,
    attention: [{ kind: 'approve', agent: 'chief', task: 'A', since: '2026-10-29T05:02:00Z' }],
    tasks: [{ id: 'A', status: 'review', plan: { stages: [], gaps: [{ need: 'HTML 작성', suggestion: '개발부 추가 권장' }] } }],
  });
  assert.equal(s.flow.length, FLOW_A.length);
  assert.equal(s.hasFlow, true);
  assert.equal(s.attention.length, 1);
  assert.deepEqual(s.gaps.map((g) => [g.task, g.need, g.suggestion]), [['A', 'HTML 작성', '개발부 추가 권장']]);
  assert.equal(normalizeState({}).hasFlow, false);
  assert.deepEqual(collectGaps({ gaps: ['문자열 공백'], tasks: [{ id: 'B', gaps: [{ need: '문자열 공백' }] }] }).map((g) => g.need), ['문자열 공백', '문자열 공백']);
});

test('산출물: 목록 정규화·필터, 파일 분류(보고서·회의록·계획·부서별·검토)', () => {
  const list = normalizeOutputs({ tasks: [
    { id: '2026-10-28/old', title: '예전 업무', status: 'done', departments: ['research'] },
    { id: '2026-10-29/landing', title: '랜딩 페이지', status: 'review', departments: ['marketing', 'dev'] },
  ] });
  assert.deepEqual(list.map((t) => t.id), ['2026-10-29/landing', '2026-10-28/old']);
  assert.equal(list[0].date, '2026-10-29');
  assert.equal(filterOutputs(list, { q: '랜딩' }).length, 1);
  assert.equal(filterOutputs(list, { dept: 'research' })[0].id, '2026-10-28/old');
  assert.equal(filterOutputs(list, { status: 'review', date: '2026-10-29' }).length, 1);
  assert.equal(filterOutputs(list, { date: '2026-10-27' }).length, 0);
  assert.deepEqual(normalizeOutputs([{ id: 'a' }, null]).map((t) => t.title), ['a']);

  const g = groupOutputFiles({ files: [
    { path: 'outputs/2026-10-29/landing/report.md', name: 'report.md' },
    { path: 'outputs/2026-10-29/landing/meeting.md', name: 'meeting.md' },
    { path: 'outputs/2026-10-29/landing/plan.json', name: 'plan.json' },
    { path: 'outputs/2026-10-29/landing/brief.md', name: 'brief.md' },
    { path: 'outputs/2026-10-29/landing/marketing/research.md', name: 'research.md' },
    { path: 'outputs/2026-10-29/landing/dev/index.html', name: 'index.html' },
    { path: 'outputs/2026-10-29/landing/reviews/fact-checker.md', name: 'fact-checker.md' },
    { path: 'outputs/2026-10-29/landing/notes.txt', name: 'notes.txt' },
    { name: 'chart.png', dept: 'dev' },
  ] }, '2026-10-29/landing');
  assert.equal(g.report.name, 'report.md');
  assert.equal(g.meeting.name, 'meeting.md');
  assert.equal(g.plan.name, 'plan.json');
  assert.equal(g.brief.name, 'brief.md');
  assert.deepEqual(g.reviews.map((f) => f.name), ['fact-checker.md']);
  assert.deepEqual(g.common.map((f) => f.name), ['notes.txt']);
  assert.deepEqual(g.depts.map(([d, fs]) => [d, fs.map((f) => f.name)]), [['marketing', ['research.md']], ['dev', ['index.html', 'chart.png']]]);
  assert.equal(g.depts[1][1][1].path, '2026-10-29/landing/chart.png');
});

test('fileKind·parseTags·safeColor', () => {
  assert.equal(fileKind('a.md'), 'markdown');
  assert.equal(fileKind('A.HTML'), 'html');
  assert.equal(fileKind('x.json'), 'json');
  assert.equal(fileKind('t.csv'), 'text');
  assert.equal(fileKind('p.png'), 'binary');
  assert.equal(fileKind('noext'), 'binary');
  assert.deepEqual(parseTags(' 자료조사, HTML·웹 문서,,자료조사\n엑셀 '), ['자료조사', 'HTML·웹 문서', '엑셀']);
  assert.equal(safeColor('#38bdf8'), '#38bdf8');
  assert.equal(safeColor('red;background:url(x)'), '#38bdf8');
  assert.equal(safeColor(undefined, '#000000'), '#000000');
});

test('index.html: 뷰 탭 4개(관제·사무실·조직·산출물)와 패널·사용자 확인·역량 공백 대화상자', async () => {
  const html = await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.deepEqual(VIEWS, ['control', 'office', 'org', 'outputs']);
  const tabs = [...html.matchAll(/role="tab"[^>]*data-view="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tabs, [['control', '관제'], ['office', '사무실'], ['org', '조직'], ['outputs', '산출물']]);
  for (const v of ['viewControl', 'viewOffice', 'viewOrg', 'viewOutputs']) assert.match(html, new RegExp(`id="${v}" role="tabpanel"`));
  for (const id of ['approveDialog', 'approveOk', 'approveReject', 'approveFeedback', 'gapDialog', 'gapGoOrg', 'feedDetailBtn', 'notifyBtn', 'attnStrip', 'outQ', 'outDate', 'outDept', 'outStatus', 'handoffChecks']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="feedDetailBtn" aria-pressed="false"/, '상세 보기는 기본 꺼짐');
  assert.match(html, /id="notifyBtn" aria-pressed="false"/, '브라우저 알림은 기본 꺼짐');
  assert.match(html, /<label for="approveFeedback"/);
});

test('app.js: html 미리보기는 스크립트를 막은 sandbox iframe이고 srcdoc·원문 innerHTML을 쓰지 않는다', async () => {
  const src = await readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(src, /setAttribute\('sandbox', ''\)/);
  assert.doesNotMatch(src, /allow-scripts|allow-same-origin/);
  assert.doesNotMatch(src, /srcdoc/i);
  assert.doesNotMatch(src, /innerHTML\s*=\s*text\b/);
  // 마지막 탭·상세 보기·알림 선택은 localStorage(try/catch 래퍼)로만 기억한다
  assert.match(src, /store\('ai-office-view', ui\.view\)/);
  assert.match(src, /function store\(key, value\) \{\n {2}try \{/);
  assert.match(src, /store\('ai-office-notify'/);
  // 승인·반려 API(SPEC)
  assert.match(src, /\/api\/tasks\/\$\{encodeURIComponent\(st\.taskId\)\}\/approve/);
  assert.match(src, /\/api\/tasks\/\$\{encodeURIComponent\(st\.taskId\)\}\/reject`, \{ feedback \}/);
  assert.match(src, /\/api\/outputs\/file\?path=/);
});

test('taskSteps: 서버 단계 표시줄(task.steps)을 정본으로 쓰되, 반려 후 다시 진행 중이면 되돌아간 단계를 현재로', () => {
  const server = ['done', 'done', 'done', 'done', 'done', 'current', 'todo', 'todo'].map((state, i) => ({ key: FLOW_STEPS[i].key, state }));
  // 피드가 잘려 앞 단계 항목이 없어도 서버 상태를 그대로 쓴다
  const plain = taskSteps({ id: 'P', status: 'active', steps: server }, []);
  assert.deepEqual(plain.steps.map((s) => s.state), server.map((s) => s.state));
  assert.equal(plain.current, 5);
  const flow = normalizeFlow([
    { task: 'Q', ts: '1', stage: 'done', actor: 'dev-2' }, { task: 'Q', ts: '2', stage: 'review_reject', to: 'dev' },
    { task: 'Q', ts: '3', stage: 'accept', actor: 'dev-2' }, { task: 'Q', ts: '4', stage: 'progress', actor: 'dev-2' },
  ]);
  const st = taskSteps({ id: 'Q', status: 'active', steps: server, rejects: 1 }, flow);
  assert.equal(st.steps[st.current].label, '진행');
  assert.equal(st.steps[5].state, 'done', '이미 거친 검토는 완료로');
  assert.equal(st.rejects, 1);
  assert.equal(taskSteps({ id: 'R', stage: 'user' }, []).steps[6].state, 'current', 'task.stage는 단계 key도 받는다');
});

test('meetingAttendees: 흐름의 명시 회의(attendees·ended)와 [회의] 호출 대상(target)', () => {
  const now = Date.parse('2026-10-29T05:10:00Z');
  const flow = [
    { ts: '2026-10-29T05:00:00Z', task: 'm1', stage: 'meeting', from: 'chief', to: 'chief', attendees: ['mkt-1', 'dev-2'] },
    { ts: '2026-10-29T05:01:00Z', task: 'm2', stage: 'meeting', from: 'chief', to: 'chief', attendees: ['res-1'] },
    { ts: '2026-10-29T05:02:00Z', task: 'm2', stage: 'meeting', from: 'chief', to: 'chief', ended: true },
    { ts: '2026-10-29T05:03:00Z', task: 'm3', stage: 'meeting', from: 'chief', to: 'ops', target: 'ops-1' },
  ];
  assert.deepEqual([...meetingAttendees([], flow, now)].sort(), ['dev-2', 'mkt-1', 'ops-1']);
});

test('planStages: 서버 상태값(pending·active·done·rejected)을 화면 상태로', () => {
  const plan = { stages: ['pending', 'active', 'done', 'rejected'].map((status, i) => ({ id: `s${i}`, agent: `a${i}`, status })) };
  assert.deepEqual(planStages(plan, [], 'T').map((s) => s.status), ['wait', 'run', 'done', 'reject']);
});

test('반려 문구 조사: 받침이 있으면 으로, 없거나 ㄹ 받침이면 로', () => {
  assert.equal(withRo('진행'), '진행으로');
  assert.equal(withRo('하달'), '하달로');
  assert.equal(withRo('사용자 확인'), '사용자 확인으로');
  assert.equal(withRo('검토'), '검토로');
});

test('html 미리보기 blob: 맨 앞(doctype 뒤)에 CSP meta를 넣어 외부 요청·스크립트를 막는다', () => {
  assert.equal(withPreviewCsp('<p>x</p>'), `${PREVIEW_META_CSP}<p>x</p>`);
  assert.equal(withPreviewCsp('\uFEFF  <!DOCTYPE html><html><img src="http://x/b.png">'), `  <!DOCTYPE html>${PREVIEW_META_CSP}<html><img src="http://x/b.png">`);
  assert.match(PREVIEW_META_CSP, /default-src 'none'/);
  assert.doesNotMatch(PREVIEW_META_CSP.replace('http-equiv', ''), /script-src|https?:/);
});

// ───── 회의실 연출(하달 킥오프) ─────
test('meetingSeats: 참석자 수별 좌석 — 상석은 따로, 11명까지 테이블, 넘치면 방 안에 서고 그다음 복도, 자리보다 많으면 비켜 겹친다', () => {
  const room = layoutOffice(makeDepts([3])).meeting;
  const inRoom = (p) => p.x >= room.x && p.x <= room.x + room.w && p.y >= room.y && p.y <= room.y + room.h;
  const key = (p) => `${p.x},${p.y}`;
  const zero = meetingSeats(0, room);
  assert.deepEqual(zero.spots, []);
  assert.ok(inRoom(zero.head), '상석은 회의실 안');
  for (const n of [1, 2, 5, 11]) {
    const { head, spots } = meetingSeats(n, room);
    assert.equal(spots.length, n);
    assert.ok(spots.every((p) => p.kind === 'seat' && inRoom(p)), `${n}명: 모두 테이블 좌석`);
    assert.equal(new Set(spots.map(key)).size, n, `${n}명: 자리가 겹치지 않는다`);
    assert.ok(!spots.some((p) => key(p) === key(head)), '상석은 비서실장 몫');
  }
  // 상석 가까운 자리부터 채운다
  const two = meetingSeats(2, room).spots;
  assert.ok(two.every((p) => p.x < room.x + room.w / 2));
  const { spots: s20, capacity } = meetingSeats(20, room);
  assert.equal(s20.filter((p) => p.kind === 'seat').length, 11);
  assert.ok(s20.slice(11).every((p) => p.kind === 'stand' && inRoom(p)), '12번째부터는 방 안에 선다');
  assert.equal(new Set(s20.map(key)).size, 20);
  const full = meetingSeats(capacity, room).spots;
  assert.equal(new Set(full.map(key)).size, capacity, '수용 인원까지는 모두 다른 자리');
  assert.ok(full.some((p) => p.kind === 'hall' && p.y > room.y + room.h), '방이 차면 문 밖 복도에 선다');
  const over = meetingSeats(capacity + 3, room).spots;
  assert.equal(over.length, capacity + 3);
  assert.notDeepEqual([over[capacity].x, over[capacity].y], [full[0].x, full[0].y], '넘치면 같은 자리를 비켜 선다');
  // 좁은 화면(회의실이 다음 줄)에서도 같은 규칙
  const narrow = layoutOffice(makeDepts([3]), { maxCols: 1 }).meeting;
  assert.ok(meetingSeats(11, narrow).spots.every((p) => p.x >= narrow.x && p.x <= narrow.x + narrow.w));
});

test('activeRoom: 킥오프는 since~until 사이만(화면 시계), 실제 회의는 진행 중, 대기 수와 비서실장 참석', () => {
  const t0 = Date.parse('2026-10-29T01:00:00.000Z');
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();
  const meetings = [
    { task: 'a', kind: 'kickoff', attendees: ['chief', 'm-1', 'd-2'], since: iso(0), until: iso(8), title: '조사' },
    { task: 'b', kind: 'kickoff', attendees: ['chief', 'm-2'], since: iso(8), until: iso(16), waiting: true, title: 'HTML' },
  ];
  assert.deepEqual(activeRoom(meetings, t0 + 1000), { attendees: ['m-1', 'd-2'], chief: true, title: '조사', kind: 'kickoff', waiting: 1 });
  // 서버 상태가 늦게 와도 화면 시계로 다음 킥오프를 연다
  assert.deepEqual(activeRoom(meetings, t0 + 9000), { attendees: ['m-2'], chief: true, title: 'HTML', kind: 'kickoff', waiting: 0 });
  assert.deepEqual(activeRoom(meetings, t0 + 20_000), { attendees: [], chief: false, title: '', kind: null, waiting: 0 });
  const real = [{ task: 'c', kind: 'meeting', attendees: ['chief', 'm-1'], since: iso(0) }, { task: 'd', kind: 'kickoff', attendees: ['chief', 'x'], since: iso(3), waiting: true }];
  assert.deepEqual(activeRoom(real, t0 + 60_000), { attendees: ['m-1'], chief: true, title: 'c', kind: 'meeting', waiting: 1 });
  assert.deepEqual(activeRoom(null, t0), { attendees: [], chief: false, title: '', kind: null, waiting: 0 });
});

test('normalizeMeetings·meetingBadge: 업무 묶음 머리에 킥오프 중 / 회의실 대기 / 회의 중', () => {
  const t0 = Date.parse('2026-10-29T01:00:00.000Z');
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();
  const list = normalizeMeetings([
    { task: 'a', kind: 'kickoff', attendees: ['chief', 'm-1', 3], since: iso(0), until: iso(8) },
    { task: 'b', kind: 'kickoff', attendees: ['chief'], since: iso(8), until: iso(16), waiting: true },
    { task: 'c', kind: 'meeting', attendees: ['chief'], since: iso(0) },
    { task: 'd', kind: 'party', since: iso(0) }, null, { kind: 'kickoff' },
  ]);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0].attendees, ['chief', 'm-1']);
  assert.equal(meetingBadge(list, 'a', t0 + 1000), '킥오프 중');
  assert.equal(meetingBadge(list, 'b', t0 + 1000), '회의실 대기');
  assert.equal(meetingBadge(list, 'b', t0 + 9000), '킥오프 중');
  assert.equal(meetingBadge(list, 'a', t0 + 9000), '');
  assert.equal(meetingBadge(list, 'c', t0 + 9000), '회의 중');
  assert.equal(meetingBadge(list, 'zz', t0), '');
  // 끝 기록 없는 회의 뒤의 킥오프(scheduleMeetings가 until 없이 since=요청 시각, waiting으로 준다)는 시간이 지나도 대기다(activeRoom과 같은 기준)
  const queued = normalizeMeetings([
    { task: 'c', kind: 'meeting', attendees: ['chief'], since: iso(0) },
    { task: 'd', kind: 'kickoff', attendees: ['chief'], since: iso(3), waiting: true },
  ]);
  assert.equal(meetingBadge(queued, 'd', t0 + 60_000), '회의실 대기');
  assert.equal(meetingBadge(queued, 'c', t0 + 60_000), '회의 중');
  assert.deepEqual(normalizeState({ meetings: list }).meetings, list);
  assert.deepEqual(normalizeState({}).meetings, []);
});

test('화면 문구: 모든 흐름 단계에 이름표가 있고 킥오프는 하달 단계, 산출물 없는 완료 단계는 경고 상태', () => {
  for (const st of FLOW_STAGES) assert.ok(STAGE_LABEL[st], st);
  assert.equal(STAGE_LABEL.kickoff, '하달 킥오프');
  assert.equal(stepIndexOf('kickoff'), stepIndexOf('assign'));
  const stages = planStages({ stages: [{ id: 's1', agent: 'a', status: 'done_missing_output' }, { id: 's2', agent: 'b', status: 'done' }] });
  assert.deepEqual(stages.map((x) => x.status), ['missing', 'done']);
  assert.equal(PLAN_STATUS_LABEL.missing, '완료(산출물 없음)');
});

// ───── 비서실장 입력창의 승인·반려 인식 ─────
test('classifyChiefInput: 승인·반려 표현만 인식하고 질문·부정·혼합은 애매(실행으로)', () => {
  for (const t of ['승인', '승인해', '승인합니다', '통과', 'OK', 'ok.', '좋아 승인', '승인!', '네, 승인해 주세요', ' 승인해줘 ']) {
    assert.deepEqual(classifyChiefInput(t), { intent: 'approve' }, t);
  }
  assert.deepEqual(classifyChiefInput('반려 표가 틀렸어요'), { intent: 'reject', feedback: '표가 틀렸어요' });
  assert.deepEqual(classifyChiefInput('다시 해 경쟁사 2곳 추가'), { intent: 'reject', feedback: '경쟁사 2곳 추가' });
  assert.deepEqual(classifyChiefInput('수정해: 로고 색'), { intent: 'reject', feedback: '로고 색' });
  assert.deepEqual(classifyChiefInput('다시 해줘 표 기준일 넣어'), { intent: 'reject', feedback: '표 기준일 넣어' });
  assert.deepEqual(classifyChiefInput('반려합니다. 숫자 확인'), { intent: 'reject', feedback: '숫자 확인' });
  assert.deepEqual(classifyChiefInput('반려'), { intent: 'reject', feedback: '' });
  for (const t of ['', '   ', '승인하지 마', '승인 기준이 뭐야?', '반려할까?', '승인 말고 반려', '반려 말고 승인', '반려하지 마', '보고서 승인 요청서 작성해줘',
    '경쟁사 조사해서 승인 받을 보고서 만들어', '다시하자', '수정해야 할 문서 목록 정리해줘', 'OK 그럼 다음 업무로 마케팅 조사해줘', null, undefined]) {
    assert.deepEqual(classifyChiefInput(t), { intent: null }, String(t));
  }
  // 띄어 쓴 부정·취소, 물음 어미, ok와 섞인 반려도 애매(실행으로)
  for (const t of ['반려 하지 마', '반려 안 해', '반려 안해', '반려 취소', '반려 철회해', '반려 보류', '반려. 아니 됐다', '반려 ㄴㄴ', '반려 말고 그냥 둬',
    '반려 마', '다시 해 볼까', '수정해 줄래', '반려 할까요', '반려 하지 말고 그대로 OK', '반려 말고 오케이', '반려 okay']) {
    assert.deepEqual(classifyChiefInput(t), { intent: null }, t);
  }
  // 부정어처럼 시작하지만 피드백인 말은 그대로 반려
  assert.deepEqual(classifyChiefInput('반려 마케팅 자료 보강'), { intent: 'reject', feedback: '마케팅 자료 보강' });
  assert.deepEqual(classifyChiefInput('반려 안 맞는 숫자 고쳐'), { intent: 'reject', feedback: '안 맞는 숫자 고쳐' });
  assert.deepEqual(classifyChiefInput('반려 book 목록 정리'), { intent: 'reject', feedback: 'book 목록 정리' });
});

test('chiefInputAction: review 업무 1건이면 그 업무, 여러 건이면 고르기, 없거나 애매하면 기존대로 실행', () => {
  const one = [{ id: '2026-10-29/a', status: 'review' }, { id: '2026-10-29/b', status: 'active' }];
  const many = [{ id: '2026-10-29/a', status: 'review' }, { id: '2026-10-29/c', status: 'review' }];
  assert.deepEqual(chiefInputAction('승인', one), { action: 'approve', taskId: '2026-10-29/a' });
  assert.deepEqual(chiefInputAction('반려 표 기준일 추가', one), { action: 'reject', feedback: '표 기준일 추가', taskId: '2026-10-29/a' });
  assert.deepEqual(chiefInputAction('승인', many), { action: 'approve', choices: ['2026-10-29/a', '2026-10-29/c'] });
  assert.deepEqual(chiefInputAction('반려', many), { action: 'reject', feedback: '', choices: ['2026-10-29/a', '2026-10-29/c'] });
  assert.deepEqual(chiefInputAction('승인', [{ id: '2026-10-29/b', status: 'active' }]), { action: 'run' }, 'review 업무가 없으면 실행으로');
  assert.deepEqual(chiefInputAction('승인', []), { action: 'run' });
  assert.deepEqual(chiefInputAction('경쟁사 가격 조사해줘', one), { action: 'run' }, '승인·반려가 아니면 실행으로');
  assert.deepEqual(chiefInputAction('승인 기준이 뭐야?', one), { action: 'run' }, '애매하면 실행으로');
  assert.deepEqual(chiefInputAction('승인', null), { action: 'run' });
});

test('app.js·index.html: 입력창 승인·반려는 확인 대화상자를 거쳐 승인·반려 API로 보내고, 여러 건이면 대상 업무를 고른다', async () => {
  const src = await readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  const html = await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  const submit = src.slice(src.indexOf('async function submitChief'), src.indexOf('async function submitChief') + 900);
  assert.match(submit, /chiefInputAction\(prompt, S\.tasks\)/);
  assert.ok(submit.indexOf('chiefDecision') < submit.indexOf("'/api/runs'"), '승인·반려 판정이 실행 전송보다 먼저');
  const decision = src.slice(src.indexOf('async function chiefDecision'), src.indexOf('async function submitChief'));
  assert.match(decision, /업무를 승인할까요\?/);
  assert.match(decision, /confirmBox\(/);
  assert.match(decision, /pickTaskBox\(/);
  assert.match(decision, /\/approve`/);
  assert.match(decision, /\/reject`, \{ feedback: act\.feedback \}/);
  assert.match(html, /<dialog id="pickTaskDialog"/);
  assert.match(html, /id="pickTaskList"/);
});
