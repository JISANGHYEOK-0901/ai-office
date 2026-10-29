// 대시보드 화면(dashboard/public)의 순수 로직과 정적 파일 계약을 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutOffice, routeBetween, hashString, lookFor, openReviewers } from '../dashboard/public/office.js';
import {
  normalizeState, planBulkAgents, agentPayloadFromPlan, kebab, validId, nextAgentId, titleFor,
  timeAgo, esc, findPresetFor, presetList, runAgentId,
} from '../dashboard/public/app.js';

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

test('layoutOffice: 부서 0개면 대표실·회의실만 있다', () => {
  const l = layoutOffice([]);
  assert.deepEqual(l.rooms.map((r) => r.kind), ['ceo', 'meeting']);
  assert.equal(l.seats.size, 0);
  assert.ok(l.width > 0 && l.height > 0);
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
  for (const from of depts) {
    for (const to of [l.ceo, l.meeting, ...depts]) {
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
