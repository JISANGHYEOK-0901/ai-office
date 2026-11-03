import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.mjs';
import { createScheduleFixture } from '../scripts/schedule-fixture-checks.mjs';

test('예약 HTTP: 인증·자연어 등록·정시 실행·재시작·내역 초기화·결과 연결', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-schedule-api-')), auth = mkdtempSync(join(tmpdir(), 'office-schedule-api-auth-'));
  const fixture = createScheduleFixture(root);
  let server = await startServer({ root, port: 0, quiet: true, env: fixture.env, scheduleNow: fixture.now, connectionBase: auth });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); await rm(auth, { recursive: true, force: true }); });
  const api = async (method, path, body, authenticated = true) => {
    const base = server.url.replace(/\/$/, '');
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(authenticated ? { 'X-Office-Token': server.token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await api('GET', '/api/schedules', undefined, false)).status, 403);
  assert.equal((await api('POST', '/api/schedules', { prompt: '자료 정리', time: '11:00' }, false)).status, 403);
  assert.equal((await api('POST', '/api/runs', { prompt: '매일 자료를 정리해 줘' })).status, 400);
  const created = await api('POST', '/api/runs', { prompt: '매일 오전 11시에 가상 소식 보고서를 작성해 줘' });
  assert.equal(created.status, 202); assert.equal(created.data.scheduled, true);
  assert.equal((await api('GET', '/api/state')).data.runs.length, 0);
  fixture.set('2026-10-30T02:00:00Z'); server.schedules.tick(); server.schedules.tick();
  const deadline = Date.now() + 20000;
  let current;
  while (Date.now() < deadline) {
    current = (await api('GET', '/api/state')).data;
    if (current.tasks.some((task) => task.status === 'done') && !current.runs.some((run) => ['running', 'queued'].includes(run.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(current.tasks[0].status, 'done');
  const roots = current.runs.filter((run) => !run.phase);
  assert.equal(roots.length, 1); assert.equal(roots[0].schedule.id, created.data.schedule.id);
  assert.equal(roots[0].schedule.slot, '2026-10-30');
  server.schedules.tick();
  assert.equal((await api('GET', '/api/schedules')).data.schedules[0].lastRun.status, 'done');
  await server.close(); server = await startServer({ root, port: 0, quiet: true, env: fixture.env, scheduleNow: fixture.now, connectionBase: auth });
  server.schedules.tick();
  assert.equal((await api('GET', '/api/state')).data.runs.filter((run) => !run.phase).length, 1);
  await api('DELETE', '/api/history');
  assert.equal((await api('GET', '/api/state')).data.runs.length, 0);
  assert.equal((await api('GET', '/api/schedules')).data.schedules[0].lastRun.status, 'done');
  assert.equal((await api('DELETE', '/api/schedules/' + created.data.schedule.id)).status, 200);
  assert.equal((await api('GET', '/api/schedules')).data.schedules.length, 0);

  // 1회 예약: "내일 오전 10시에 …"는 바로 실행하지 않고 그 시각에 한 번만 실행한다(지금: 10월 30일 11:00 한국)
  const once = await api('POST', '/api/runs', { prompt: '내일 오전 10시에 가상 카페에 게시글 2개를 올려줘' });
  assert.equal(once.status, 202); assert.equal(once.data.scheduled, true);
  assert.deepEqual([once.data.schedule.startDate, once.data.schedule.times, once.data.schedule.nextAt], ['2026-10-31', 1, '2026-10-31T01:00:00.000Z']);
  assert.equal((await api('POST', '/api/schedules', { prompt: '지난 날짜 업무', time: '10:00', startDate: '2026-10-29' })).status, 400);
  const runsBefore = (await api('GET', '/api/state')).data.runs.filter((run) => !run.phase && run.schedule).length;
  fixture.set('2026-10-31T01:00:00Z'); server.schedules.tick(); server.schedules.tick();
  fixture.set('2026-11-01T01:00:00Z'); server.schedules.tick();
  const scheduledRuns = (await api('GET', '/api/state')).data.runs.filter((run) => !run.phase && run.schedule?.id === once.data.schedule.id);
  assert.equal(runsBefore, 0); assert.equal(scheduledRuns.length, 1); assert.equal(scheduledRuns[0].schedule.slot, '2026-10-31');
  const finished = (await api('GET', '/api/schedules')).data.schedules.find((item) => item.id === once.data.schedule.id);
  assert.deepEqual([finished.enabled, finished.completed], [false, true]);
});
