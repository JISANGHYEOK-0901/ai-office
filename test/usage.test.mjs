import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDailyUsage, kstDay, monitorUsage } from '../lib/usage.mjs';
import { buildState } from '../dashboard/state.mjs';
import { dailyUsageLabel, normalizeAttention } from '../dashboard/public/app.js';

// 2026-11-03 14:00 KST
const NOW = Date.parse('2026-11-03T05:00:00.000Z');
const DAY = 86400e3;
const daily = (entries) => Object.fromEntries(entries.map(([offset, calls]) => [kstDay(NOW - offset * DAY), { calls, input: calls * 100, output: calls * 10, costUsd: 0 }]));

test('날짜별 사용량은 한국 시각 날짜로 호출 수·토큰을 더하고 최근 14일만 남긴다', () => {
  let d;
  d = addDailyUsage(d, { input: 10, output: 2, costUsd: null }, NOW);
  d = addDailyUsage(d, null, NOW);
  assert.deepEqual(d[kstDay(NOW)], { calls: 2, input: 10, output: 2, costUsd: 0 });
  assert.equal(kstDay(Date.parse('2026-11-03T15:30:00.000Z')), '2026-11-04', '한국 시각 자정이 지나면 다음 날');
  for (let i = 1; i <= 20; i++) d = addDailyUsage(d, { input: 1 }, NOW + i * DAY);
  assert.equal(Object.keys(d).length, 14);
});

test('상시 업무 사용량: 감시 실행·답장 실행·후속 업무를 합치고, 평소의 3배 이상·10회 이상이면 이상으로 본다', () => {
  const runs = [
    { id: 'm1', rootId: 'root', continuous: true, dailyUsage: daily([[0, 6], [1, 3], [2, 4]]) },
    { id: 'm2', rootId: 'root', continuous: true, parentId: 'm1', dailyUsage: daily([[0, 4]]) },
    { id: 'd1', rootId: 'd1', monitorId: 'root', dailyUsage: daily([[0, 5], [1, 2]]) },
    { id: 'other', rootId: 'x', dailyUsage: daily([[0, 99]]) },
  ];
  const usage = monitorUsage(runs, 'root', NOW);
  assert.equal(usage.today.calls, 15);
  assert.equal(usage.baseline, 4.5, '어제 5회·그제 4회 평균');
  assert.equal(usage.anomaly, true);
  assert.equal(monitorUsage(runs.slice(0, 1), 'root', NOW).anomaly, false, '오늘 6회는 10회 미만이라 알리지 않는다');
  assert.equal(monitorUsage([{ rootId: 'root', dailyUsage: daily([[0, 50], [1, 2]]) }], 'root', NOW).baseline, null, '지난 기록이 2일 미만이면 판단하지 않는다');
  assert.equal(monitorUsage([{ rootId: 'root', dailyUsage: daily([[0, 12], [1, 5], [2, 5]]) }], 'root', NOW).anomaly, false, '2.4배는 알리지 않는다');
});

test('대시보드: 진행 중인 상시 업무가 평소보다 크게 많이 쓰면 사용량 이상 알림을 띄우고 카드에 오늘 사용량을 보여 준다', () => {
  const org = { departments: [], roster: [] };
  const monitor = { id: 'm1', rootId: 'root', continuous: true, status: 'running', request: '경쟁사 가격을 계속 감시해 줘', monitor: { status: 'waiting' },
    dailyUsage: daily([[0, 30], [1, 5], [2, 5]]) };
  const state = buildState({ org, events: [], runs: [monitor], tasks: [], now: NOW });
  const alert = state.attention.find((a) => a.kind === 'usage');
  assert.ok(alert);
  assert.match(alert.text, /오늘 AI 호출 30회 — 평소 하루 평균 5회의 6\.0배/);
  assert.equal(alert.runId, 'm1');
  assert.equal(normalizeAttention(state.attention).some((a) => a.kind === 'usage'), true, '화면도 이 알림 종류를 받는다');
  const view = state.runs.find((r) => r.id === 'm1');
  assert.match(dailyUsageLabel(view.monitorUsage), /^오늘 사용: AI 호출 30회 · 입력 3,000 · 출력 300 토큰 · 평소 하루 5회 · 평소의 6\.0배$/);
  const stopped = buildState({ org, events: [], runs: [{ ...monitor, status: 'stopped', userStopped: true, monitor: { status: 'stopped' } }], tasks: [], now: NOW });
  assert.equal(stopped.attention.some((a) => a.kind === 'usage'), false, '멈춘 상시 업무는 알리지 않는다');
});
