import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSimulation } from '../scripts/simulate-events.mjs';
import { validateOrg } from '../lib/org.mjs';
import { buildState } from '../dashboard/state.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readDemo = (root) => readFileSync(join(root, '.office', 'demo-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('정본이 비면 데모 조직(부서 6~8, 40~50명)을 만들고 demo-events.jsonl 에만 기록', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-sim-'));
  const stop = startSimulation({ root, intervalMs: 10 });
  await wait(300);
  stop();
  const org = JSON.parse(readFileSync(join(root, '.office', 'demo-org.json'), 'utf8'));
  assert.ok(org.departments.length >= 6 && org.departments.length <= 8, `부서 ${org.departments.length}`);
  assert.ok(org.roster.length >= 40 && org.roster.length <= 50, `인원 ${org.roster.length}`);
  assert.deepEqual(validateOrg(org), { ok: true, errors: [], warnings: [] });
  assert.ok(org.roster.every((a) => /[가-힣]+ (사원|주임|대리|과장|차장|팀장|부장)$/.test(a.name)));
  assert.equal(stop.org.roster.length, org.roster.length);

  const events = readDemo(root);
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ['session.start', 'task.start', 'agent.start', 'tool.start', 'tool.end']) assert.ok(kinds.has(k), k);
  const ids = new Set(org.roster.map((a) => a.id));
  // 사용자 행동(승인)은 session office-server이고 agent를 붙이지 않는다(직원으로 세지 않게)
  assert.ok(events.every((e) => e.v === 1 && e.ts && (e.agent === 'chief' || ids.has(e.agent) || (e.session === 'office-server' && e.agent === undefined))));
  assert.ok(!existsSync(join(root, '.office', 'events.jsonl')), '실제 이벤트 파일에는 쓰지 않는다');

  // 중지 후에는 더 쓰지 않는다
  const count = events.length;
  await wait(80);
  assert.equal(readDemo(root).length, count);
});

test('전달한 조직을 그대로 쓰면 demo-org.json 을 만들지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-sim-'));
  mkdirSync(join(root, '.office'));
  writeFileSync(join(root, '.office', 'demo-events.jsonl'), '{"old":true}\n');
  const org = {
    departments: [{ id: 'research', name: '리서치부', engine: 'claude' }],
    roster: [{ id: 'research-1', name: '김대리', department: 'research' }, { id: 'research-2', name: '이주임', department: 'research' }],
  };
  const stop = startSimulation({ root, intervalMs: 10, org });
  await wait(150);
  stop();
  assert.ok(!existsSync(join(root, '.office', 'demo-org.json')));
  const events = readDemo(root);
  assert.ok(!events.some((e) => e.old), '시작할 때 이전 데모 기록을 비운다');
  assert.ok(events.some((e) => e.agent === 'research-1' || e.agent === 'research-2'));
});

test('데모: 사용자 확인 대기(deliver·review)와 답장 대기(reply.wait)를 만들어 attention 아이콘을 보여준다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-sim-'));
  const stop = startSimulation({ root, intervalMs: 60_000 });
  stop();
  const events = readDemo(root);
  for (const k of ['flow.review_request', 'flow.review', 'flow.deliver', 'reply.wait']) assert.ok(events.some((e) => e.kind === k), k);
  assert.ok(events.some((e) => e.kind === 'task.update' && e.status === 'review'));
  const state = buildState({ org: stop.org, events, demo: true });
  const kinds = new Set(state.attention.map((a) => a.kind));
  assert.ok(kinds.has('approve') && kinds.has('reply'), JSON.stringify(state.attention));
  assert.ok(state.tasks.some((t) => t.status === 'review' && t.stage === 'user'));
  // 데모가 아니면 reply.wait 이벤트만으로 답장 아이콘을 만들지 않는다(실제 화면은 run의 needsReply 기준)
  assert.ok(!buildState({ org: stop.org, events }).attention.some((a) => a.kind === 'reply'));
});
