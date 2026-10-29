import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState, FEED_LIMIT, STALE_START_MS } from '../dashboard/state.mjs';

// 2026-10-29 14:00 KST
const NOW = Date.parse('2026-10-29T05:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const org = {
  departments: [
    { id: 'research', name: '리서치부', engine: 'claude', order: 2 },
    { id: 'dev', name: '개발부', engine: 'claude', order: 1 },
    { id: 'closed', name: '휴업부', engine: 'claude', active: false },
  ],
  roster: [
    { id: 'research-1', name: '김대리', department: 'research', title: '팀장', lead: true },
    { id: 'research-2', name: '이주임', department: 'research', title: '담당' },
    { id: 'research-3', name: '박사원', department: 'research', title: '담당', active: false },
    { id: 'dev-1', name: '최과장', department: 'dev', title: '팀장', lead: true },
    { id: 'closed-1', name: '정차장', department: 'closed', title: '팀장', lead: true },
  ],
};

const ev = (agent, kind, msAgo, extra = {}) => ({ v: 1, ts: iso(msAgo), engine: 'claude', session: 's1', agent, instance: extra.instance ?? `${agent}-i`, kind, ...extra });

test('tool 이벤트 90초 경계: 정확히 90초 전은 작업 중, 그보다 오래되면 대기', () => {
  const at90 = buildState({ org, events: [ev('research-1', 'tool.start', 90_000, { tool: 'WebSearch' })], now: NOW });
  assert.equal(at90.agents['research-1'].status, 'working');
  assert.equal(at90.agents['research-1'].lastTool, 'WebSearch');

  const over = buildState({ org, events: [ev('research-1', 'tool.start', 90_001, { tool: 'WebSearch' })], now: NOW });
  assert.equal(over.agents['research-1'].status, 'standby');
});

test('tool 이벤트 뒤에 agent.stop이 오면 90초 안이어도 대기', () => {
  const s = buildState({
    org,
    events: [ev('research-1', 'agent.start', 30_000), ev('research-1', 'tool.end', 20_000, { tool: 'Read' }), ev('research-1', 'agent.stop', 10_000)],
    now: NOW,
  });
  assert.equal(s.agents['research-1'].status, 'standby');
});

test('agent.start 후 stop이 없으면 오래 지나도 작업 중, 짝이 맞으면 종료', () => {
  const open = buildState({ org, events: [ev('research-2', 'agent.start', 10 * 60_000)], now: NOW });
  assert.equal(open.agents['research-2'].status, 'working');
  assert.deepEqual(open.departments.find((d) => d.id === 'research').live, ['research-2']);

  const closed = buildState({
    org,
    events: [ev('research-2', 'agent.start', 10 * 60_000), ev('research-2', 'agent.stop', 5 * 60_000)],
    now: NOW,
  });
  assert.equal(closed.agents['research-2'].status, 'standby');

  // 두 인스턴스 중 하나만 끝나면 여전히 작업 중
  const twoInstances = buildState({
    org,
    events: [
      ev('research-2', 'agent.start', 60_000 * 3, { instance: 'a' }),
      ev('research-2', 'agent.start', 60_000 * 2, { instance: 'b' }),
      ev('research-2', 'agent.stop', 60_000, { instance: 'a' }),
    ],
    now: NOW,
  });
  assert.equal(twoInstances.agents['research-2'].status, 'working');

  // 비정상 종료로 stop이 영원히 없으면 STALE_START_MS 이후 작업 중에서 빠진다
  const stale = buildState({ org, events: [ev('research-2', 'agent.start', STALE_START_MS + 1)], now: NOW });
  assert.notEqual(stale.agents['research-2'].status, 'working');
});

test('진행 중인 run이 있으면 작업 중이고 runId가 붙는다', () => {
  const s = buildState({
    org,
    events: [],
    runs: [
      { id: 'r1', agentId: 'dev-1', status: 'done', startedAt: iso(60 * 60_000), endedAt: iso(50 * 60_000) },
      { id: 'r2', agentId: 'dev-1', status: 'running', startedAt: iso(60_000) },
      { id: 'r3', agentId: null, status: 'running', startedAt: iso(60_000) },
    ],
    now: NOW,
  });
  assert.equal(s.agents['dev-1'].status, 'working');
  assert.equal(s.agents['dev-1'].runId, 'r2');
  assert.equal(s.agents.chief.status, 'working');
  const dev = s.departments.find((d) => d.id === 'dev');
  assert.equal(dev.doneToday, 1);
  assert.equal(dev.inProgress, 1);
  assert.equal(dev.progress, 50);
});

test('off-duty: 직원 또는 부서가 active:false면 이벤트가 있어도 휴무', () => {
  const s = buildState({
    org,
    events: [ev('research-3', 'tool.start', 1000, { tool: 'Read' }), ev('closed-1', 'agent.start', 1000)],
    now: NOW,
  });
  assert.equal(s.agents['research-3'].status, 'off-duty');
  assert.equal(s.agents['closed-1'].status, 'off-duty');
  assert.equal(s.metrics.offline, 2);
});

test('오늘 활동이 없으면 idle, 어제(KST) 활동만 있어도 idle', () => {
  // NOW는 KST 14:00이므로 15시간 전은 KST 전날 23:00
  const s = buildState({ org, events: [ev('dev-1', 'tool.start', 15 * 60 * 60_000, { tool: 'Bash' })], now: NOW });
  assert.equal(s.agents['dev-1'].status, 'idle');
  assert.equal(s.agents['research-2'].status, 'idle');
  assert.equal(s.metrics.tools, 0);
});

test('미등록 agent는 버리지 않고 표시한다', () => {
  const s = buildState({ org, events: [ev('ghost-writer', 'tool.start', 1000, { tool: 'Write' })], now: NOW });
  assert.deepEqual(s.unregistered, ['ghost-writer']);
  assert.equal(s.agents['ghost-writer'].unregistered, true);
  assert.equal(s.agents['ghost-writer'].label, '미등록');
  assert.equal(s.agents['ghost-writer'].status, 'working');
  assert.equal(s.metrics.active, 1);
  // chief는 미등록이 아니다
  const c = buildState({ org, events: [ev('chief', 'request', 1000)], now: NOW });
  assert.deepEqual(c.unregistered, []);
  assert.equal(c.agents.chief.status, 'standby');
});

test('지표·부서 정렬·업무 목록·리뷰 판정', () => {
  const s = buildState({
    org,
    events: [
      ev('chief', 'task.start', 5000, { task: '2026-10-29/scan', summary: '경쟁사 조사' }),
      ev('research-1', 'tool.start', 4000, { tool: 'WebSearch', task: '2026-10-29/scan' }),
      ev('research-1', 'tool.end', 3000, { tool: 'WebSearch', task: '2026-10-29/scan' }),
      ev('fact-checker', 'review.start', 2000, { task: '2026-10-29/scan', engine: 'codex' }),
      ev('fact-checker', 'review.end', 1000, { task: '2026-10-29/scan', engine: 'codex', verdict: 'PASS' }),
    ],
    tasks: [{ id: '2026-10-28/old', title: '이전 업무', status: 'done', created: '2026-10-28T01:00:00.000Z' }],
    now: NOW,
  });
  assert.deepEqual(s.departments.map((d) => d.id), ['dev', 'research', 'closed']);
  assert.equal(s.metrics.tools, 1);
  assert.equal(s.metrics.reviews, 1);
  assert.equal(s.metrics.tasks, 1);
  assert.deepEqual(s.tasks.map((t) => t.id), ['2026-10-29/scan', '2026-10-28/old']);
  assert.deepEqual(s.tasks[0].verdicts, { 'fact-checker': 'PASS' });
  assert.equal(s.agents['fact-checker'].status, 'standby');
  const research = s.departments.find((d) => d.id === 'research');
  assert.deepEqual(research.members, ['research-1', 'research-2', 'research-3']);
  assert.equal(research.activeCount, 1);
  assert.equal(research.idleCount, 1);
});

test('feed는 최근 200개만 남기고 입력을 변경하지 않는다', () => {
  const events = Array.from({ length: 250 }, (_, i) => ev('dev-1', 'tool.start', (250 - i) * 1000, { tool: `T${i}` }));
  const snapshot = JSON.stringify(events);
  const s = buildState({ org, events, now: NOW });
  assert.equal(s.feed.length, FEED_LIMIT);
  assert.equal(s.feed.at(-1).tool, 'T249');
  assert.equal(s.feed[0].tool, 'T50');
  assert.equal(JSON.stringify(events), snapshot);
});

test('빈 입력에서도 동작한다', () => {
  const s = buildState({ org: { departments: [], roster: [] }, events: [], now: NOW });
  assert.deepEqual(s.metrics, { active: 0, standby: 0, idle: 0, offline: 0, tasks: 0, reviews: 0, tools: 0 });
  assert.deepEqual(s.departments, []);
  assert.deepEqual(s.feed, []);
});
