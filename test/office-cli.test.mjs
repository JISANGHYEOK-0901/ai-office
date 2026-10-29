import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kstDate, repoRoot } from '../lib/paths.mjs';

const SCRIPT = join(repoRoot(), 'scripts', 'office.mjs');

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, AI_OFFICE_ROOT: root }, encoding: 'utf8' });
  return { root, run };
}

const lastLine = (s) => s.trimEnd().split('\n').at(-1);
const tasksOf = (root) => JSON.parse(readFileSync(join(root, '.office', 'tasks.json'), 'utf8'));
const eventsOf = (root) => readFileSync(join(root, '.office', 'events.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));

test('task start: brief.md, tasks.json, task.start 이벤트, 마지막 줄 OFFICE_TASK', (t) => {
  const { root, run } = setup(t);
  const p = run('task', 'start', '경쟁사 가격 조사', '--slug', 'competitor-scan');
  assert.equal(p.status, 0, p.stderr);
  const id = `${kstDate()}/competitor-scan`;
  assert.equal(lastLine(p.stdout), `OFFICE_TASK=${id}`);

  const brief = readFileSync(join(root, 'outputs', id, 'brief.md'), 'utf8');
  assert.match(brief, /^# 경쟁사 가격 조사/);
  assert.ok(brief.includes(`업무 id: ${id}`));

  const tasks = tasksOf(root);
  assert.equal(tasks.length, 1);
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['created', 'id', 'status', 'title']);
  assert.equal(tasks[0].id, id);
  assert.equal(tasks[0].status, 'active');
  assert.ok(!Number.isNaN(Date.parse(tasks[0].created)));

  const [ev] = eventsOf(root);
  assert.equal(ev.v, 1);
  assert.equal(ev.kind, 'task.start');
  assert.equal(ev.task, id);
  assert.equal(ev.agent, 'chief');
  assert.equal(ev.engine, 'claude');
  assert.equal(ev.summary, '경쟁사 가격 조사');
  assert.ok(ev.session && ev.instance && ev.ts);
});

test('task start: slug 자동 생성(영문 제목), 한글 제목은 task, 중복이면 번호', (t) => {
  const { root, run } = setup(t);
  const date = kstDate();
  assert.equal(lastLine(run('task', 'start', 'Q3 Sales Report').stdout), `OFFICE_TASK=${date}/q3-sales-report`);
  assert.equal(lastLine(run('task', 'start', '월간', '정산').stdout), `OFFICE_TASK=${date}/task`);
  assert.equal(lastLine(run('task', 'start', '계약 검토').stdout), `OFFICE_TASK=${date}/task-2`);
  // 폴더만 남아 있어도 겹치지 않게 피한다
  mkdirSync(join(root, 'outputs', date, 'task-3'), { recursive: true });
  assert.equal(lastLine(run('task', 'start', '견적 비교').stdout), `OFFICE_TASK=${date}/task-4`);
  assert.deepEqual(tasksOf(root).map((x) => x.title), ['Q3 Sales Report', '월간 정산', '계약 검토', '견적 비교']);
});

test('task start: 명시한 slug가 이미 있으면 오류, 형식 오류와 제목 누락도 거부', (t) => {
  const { root, run } = setup(t);
  assert.equal(run('task', 'start', '첫 업무', '--slug', 'dup').status, 0);
  const p = run('task', 'start', '둘째 업무', '--slug', 'dup');
  assert.equal(p.status, 1);
  assert.match(p.stderr, /이미 있는 업무/);
  // 기존 업무에 이어 쓰지 말고 새 slug를 쓰라고 안내한다(이어 쓰면 세션이 업무에 연결되지 않는다)
  assert.match(p.stderr, /--slug dup-2/);
  assert.equal(tasksOf(root).length, 1);

  assert.equal(run('task', 'start', '업무', '--slug', 'Bad Slug').status, 64);
  assert.equal(run('task', 'start', '업무', '--slug', '../escape').status, 64);
  assert.equal(run('task', 'start', '--slug', 'x').status, 64);
});

test('task start: 이벤트 summary는 비밀값을 가리고 200자로 자른다', (t) => {
  const { root, run } = setup(t);
  run('task', 'start', `배포 점검 token=abc123\n${'가'.repeat(300)}`, '--slug', 'secret');
  const [ev] = eventsOf(root);
  assert.ok(!ev.summary.includes('abc123'));
  assert.ok(!ev.summary.includes('\n'));
  assert.ok(ev.summary.length <= 200);
});

test('task status: 상태 변경과 task.update 이벤트, 잘못된 입력 거부', (t) => {
  const { root, run } = setup(t);
  run('task', 'start', '보고서 작성', '--slug', 'report');
  const id = `${kstDate()}/report`;

  let p = run('task', 'status', id, 'blocked');
  assert.equal(p.status, 0, p.stderr);
  assert.equal(tasksOf(root)[0].status, 'blocked');
  const ev = eventsOf(root).at(-1);
  assert.equal(ev.kind, 'task.update');
  assert.equal(ev.task, id);
  assert.equal(ev.status, 'blocked');
  assert.equal(run('task', 'status', id, 'active').status, 0);

  // 대표 직접(--by-user)은 done으로 바꿀 수 있다(대시보드 없이 터미널만 쓰는 경우)
  p = run('task', 'status', id, 'done', '--by-user');
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /report\.md가 없습니다/);
  assert.equal(tasksOf(root)[0].status, 'done');

  p = run('task', 'status', id, 'finished');
  assert.equal(p.status, 64);
  p = run('task', 'status', '2000-01-01/none', 'blocked');
  assert.equal(p.status, 1);
  assert.match(p.stderr, /찾을 수 없습니다/);
});

test('task status 전이 규칙: done·review는 비서실장이 못 바꾸고, 사용자 확인 대기·완료 업무는 되돌리지 못한다', (t) => {
  const { root, run } = setup(t);
  run('task', 'start', '보고서 작성', '--slug', 'report');
  const id = `${kstDate()}/report`;
  const status = () => tasksOf(root)[0].status;

  let p = run('task', 'status', id, 'done');
  assert.equal(p.status, 1);
  assert.match(p.stderr, /대시보드에서 승인/);
  p = run('task', 'status', id, 'review');
  assert.equal(p.status, 1);
  assert.match(p.stderr, /flow <업무> deliver/);
  assert.equal(status(), 'active');

  assert.equal(run('flow', id, 'deliver').status, 0);
  assert.equal(status(), 'review');
  for (const s of ['active', 'blocked']) {
    p = run('task', 'status', id, s);
    assert.equal(p.status, 1, s);
    assert.match(p.stderr, /승인·반려로만/);
  }
  p = run('flow', id, 'deliver');
  assert.equal(p.status, 1, '이미 사용자 확인 대기');
  assert.equal(status(), 'review');
  assert.equal(eventsOf(root).filter((e) => e.kind === 'flow.user_approve').length, 0);

  // 완료된 업무를 deliver로 되돌리지 못한다
  assert.equal(run('task', 'status', id, 'done', '--by-user').status, 0);
  p = run('flow', id, 'deliver');
  assert.equal(p.status, 1);
  assert.match(p.stderr, /이미 완료된 업무/);
  assert.equal(status(), 'done');
});

test('task list: 보고서·리뷰 존재 여부를 함께 보여준다', (t) => {
  const { root, run } = setup(t);
  assert.match(run('task', 'list').stdout, /등록된 업무가 없습니다/);
  run('task', 'start', '시장 조사', '--slug', 'market');
  const id = `${kstDate()}/market`;
  writeFileSync(join(root, 'outputs', id, 'report.md'), '# 보고\n');
  mkdirSync(join(root, 'outputs', id, 'reviews'));
  writeFileSync(join(root, 'outputs', id, 'reviews', 'fact-checker.md'), 'VERDICT: PASS\n');

  const p = run('task', 'list');
  assert.equal(p.status, 0);
  assert.match(p.stdout, new RegExp(`${id}\\tactive\\t시장 조사\\t보고서:있음\\t리뷰:1개`));

  const json = JSON.parse(run('task', 'list', '--json').stdout);
  assert.equal(json[0].id, id);
  assert.equal(json[0].report, true);
  assert.equal(json[0].reviews, 1);
});

test('알 수 없는 명령은 사용법과 함께 거부', (t) => {
  const { run } = setup(t);
  const p = run('task', 'remove');
  assert.equal(p.status, 64);
  assert.match(p.stderr, /사용법/);
  assert.equal(run().status, 64);
  assert.equal(existsSync(SCRIPT), true);
});
