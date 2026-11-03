import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchedules, dailyScheduleRequest, nextDailyTime, videoPostPolicy } from '../lib/schedules.mjs';

test('한국 시각 매일 예약은 오전/오후·분을 읽고 모호하거나 잘못된 시각은 실행하지 않는다', () => {
  assert.deepEqual(dailyScheduleRequest('매일 오전 11시에 여행 숏츠를 카페에 2~3개씩 올려줘'), { time: '11:00' });
  assert.deepEqual(dailyScheduleRequest('매일 오후 12시 30분에 보고해 줘'), { time: '12:30' });
  assert.deepEqual(dailyScheduleRequest('매일 오전 12시에 보고해 줘'), { time: '00:00' });
  assert.deepEqual(dailyScheduleRequest('매일 23:15에 보고해 줘'), { time: '23:15' });
  assert.equal(dailyScheduleRequest('매일 오전 11시에 할 수 있어?'), null);
  assert.equal(dailyScheduleRequest('지금 보고서를 써줘'), null);
  assert.throws(() => dailyScheduleRequest('매일 카페에 글을 올려줘'), /시각/);
  assert.throws(() => dailyScheduleRequest('매일 오후 13시에 올려줘'), /시각/);
  assert.throws(() => dailyScheduleRequest('매일 24:00에 보고해'), /시각/);
  assert.deepEqual(videoPostPolicy('여행 숏츠를 카페에 2~3개씩 게시'), { uniqueYoutube: true, minPosts: 2, maxPosts: 3 });
  assert.deepEqual(videoPostPolicy('유튜브 영상을 하루 1개 카페에 게시'), { uniqueYoutube: true, minPosts: 1, maxPosts: 1 });
  assert.throws(() => videoPostPolicy('카페에 유튜브를 3~2개 게시'), /게시 수/);
  assert.equal(new Date(nextDailyTime('11:00', Date.parse('2026-10-30T01:59:59Z'))).toISOString(), '2026-10-30T02:00:00.000Z');
  assert.equal(new Date(nextDailyTime('00:00', Date.parse('2026-12-31T15:00:00Z'))).toISOString(), '2027-01-01T15:00:00.000Z');
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-schedules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let stamp = Date.parse('2026-10-30T01:59:00Z'); const history = [], started = [];
  const options = { root, now: () => stamp, runs: () => history,
    start: (request) => { started.push(request); const id = `run-${started.length}`; const run = { id, rootId: id, schedule: request.schedule, status: 'running', task: `2026-10-30/${id}` }; history.push(run); return run; } };
  return { root, options, history, started, set: (value) => { stamp = Date.parse(value); } };
}

test('11시 정시 실행·동일 날짜 재시작 방지·답변 대기 중 겹침 방지·다음 날 재개', async (t) => {
  const f = await fixture(t); let store = createSchedules(f.options);
  const item = store.add({ time: '11:00', prompt: '주제에 맞는 유튜브 숏츠를 카페에 2~3개씩 게시해 줘' });
  store.tick(); assert.equal(f.started.length, 0);
  f.set('2026-10-30T02:00:00Z'); store.tick(); store.tick(); assert.equal(f.started.length, 1);
  assert.equal(f.started[0].continuous, false); assert.equal(f.started[0].schedule.maxPosts, 3);
  store = createSchedules(f.options); store.tick(); assert.equal(f.started.length, 1);
  f.history[0].status = 'done'; f.history[0].needsReply = true;
  f.set('2026-10-31T02:00:00Z'); store.tick(); assert.equal(f.started.length, 1);
  assert.match(store.list()[0].lastSkipped.reason, /답변/);
  f.history[0].needsReply = false;
  f.set('2026-11-01T02:00:00Z'); store.tick(); assert.equal(f.started.length, 2);
  assert.equal(store.list()[0].lastSlot, '2026-11-01');
  store.update(item.id, { enabled: false });
  f.set('2026-11-02T02:00:00Z'); store.tick(); assert.equal(f.started.length, 2);
});

test('앱 종료·절전으로 놓친 예약은 몰아 실행하지 않고 수정·재개·삭제는 미래 실행만 바꾼다', async (t) => {
  const f = await fixture(t); let store = createSchedules(f.options);
  const item = store.add({ time: '11:00', prompt: '시장 소식을 조사해 줘' });
  f.set('2026-11-03T05:00:00Z'); store = createSchedules(f.options); store.tick();
  assert.equal(f.started.length, 0); assert.equal(store.list()[0].nextAt, '2026-11-04T02:00:00.000Z');
  store.update(item.id, { time: '15:00', enabled: false });
  store.update(item.id, { enabled: true });
  assert.equal(store.list()[0].nextAt, '2026-11-03T06:00:00.000Z');
  f.set('2026-11-03T06:02:00Z'); store.tick(); assert.equal(f.started.length, 0);
  assert.equal(store.list()[0].nextAt, '2026-11-04T06:00:00.000Z');
  store.remove(item.id); assert.equal(store.list().length, 0);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.office/schedules.json'))).items.length, 0);
});

test('시작 오류도 날짜별로 기록하고 실패한 예약을 같은 날 무한 재시도하지 않는다', async (t) => {
  const f = await fixture(t); let calls = 0;
  const store = createSchedules({ ...f.options, start: () => { calls++; throw new Error('fixture unavailable'); } });
  store.add({ time: '11:00', prompt: '시장 소식을 조사해 줘' });
  f.set('2026-10-30T02:00:00Z'); store.tick(); store.tick();
  assert.equal(calls, 1); assert.equal(store.list()[0].lastRun.status, 'failed');
  assert.match(store.list()[0].lastRun.summary, /unavailable/);
});
