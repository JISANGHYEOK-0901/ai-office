import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPauseNote, pauseIntent, resumeIntent } from '../lib/pause.mjs';
import { chiefResultMessage, taskLabel } from '../dashboard/public/app.js';

test('일시정지 지시는 "멈추고 정리해 두었다가 이어서" 문장을 알아보고 새 업무 지시는 건드리지 않는다', () => {
  for (const text of ['지금까지 하던 작업 멈추고 자료 정리한 다음 다음에 이어갈 수 있게해줘', '일시정지', '작업 일시정지해줘',
    '노트북 끌 거니까 하던 업무 다 멈춰줘', '지금 작업 중단하고 내일 이어서 하자']) assert.equal(pauseIntent(text), true, text);
  for (const text of ['중단된 업무 정리 보고서 작성해줘', '시장 조사해줘', '계속 시장을 조사하고 새 자료가 나오면 팀장에게 전달해 줘',
    '업무 중지 사유를 정리해서 보내줘', '']) assert.equal(pauseIntent(text), false, text);
});

test('재개 지시는 짧은 재개 문장만 받고 "계속 …해 줘" 같은 새 지시는 업무로 둔다', () => {
  for (const text of ['이어서 해줘', '이어서 재개', '재개해줘', '하던 작업 이어서 진행해줘', '멈춘 작업 다시 시작해줘', '작업 계속해', 'resume'])
    assert.equal(resumeIntent(text), true, text);
  for (const text of ['계속 시장을 조사하고 새 자료가 나오면 팀장에게 전달해 줘', '이어서 보고서도 써줘', '1분마다 계속 확인해 줘'])
    assert.equal(resumeIntent(text), false, text);
});

test('정리 노트는 완료·남은 단계, 대표 결정 대기, 만든 파일, 재개 방법을 담고 비밀값을 가린다', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-pause-'));
  try {
    const taskDir = join(root, 'outputs', '2026-11-03', 'run-x');
    mkdirSync(join(taskDir, 'research'), { recursive: true });
    writeFileSync(join(taskDir, 'research', 'r-1-a.txt'), '자료');
    const note = buildPauseNote({ root, taskDir, title: '시장 조사', pausedAt: '2026-11-03T09:00:00.000Z',
      run: { task: '2026-11-03/run-x', request: '시장 조사' },
      checkpoint: { originalRequest: '시장 조사 password=hunter2', completed: { a: 'h' },
        plan: { stages: [{ id: 'a', title: '조사', agent: 'r-1', output: 'outputs/2026-11-03/run-x/research/r-1-a.txt' },
          { id: 'b', title: 'HTML', agent: 'd-1', output: 'outputs/2026-11-03/run-x/dev/d-1-b.html' }] },
        pending: [{ question: '예산을 알려 주세요.' }] } });
    assert.match(note, /1\/2 단계 완료/);
    assert.match(note, /\[완료\] 조사/);
    assert.match(note, /\[남음\] HTML/);
    assert.match(note, /예산을 알려 주세요/);
    assert.match(note, /research\/r-1-a\.txt/);
    assert.match(note, /2026-11-03 18:00 \(KST\)/);
    assert.match(note, /이어서 해줘/);
    assert.doesNotMatch(note, /hunter2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('지시창 안내는 일시정지·재개 결과 건수를 알려 준다', () => {
  assert.match(chiefResultMessage({ pauseRequested: true, paused: [{}, {}] }), /2건을 일시정지/);
  assert.match(chiefResultMessage({ pauseRequested: true, paused: [] }), /일시정지할 것이 없어요/);
  assert.match(chiefResultMessage({ resumeRequested: true, resumed: [{}], skipped: [{ reason: '다시 지시' }] }), /1건을 이어서.*이어가지 못한 1건: 다시 지시/);
  assert.match(chiefResultMessage({ id: 'r' }), /비서실장에게 업무를 전달/);
});

test('업무 카드는 마지막 실행이 일시정지·끊김이면 그 상태를, 다시 실행 중이면 원래 상태를 보여 준다', () => {
  const task = { id: 't1', status: 'active' };
  const run = (id, fields) => ({ id, task: 't1', createdAt: id, ...fields });
  assert.equal(taskLabel(task, [run('1', { status: 'stopped', paused: true })]), '일시정지');
  assert.equal(taskLabel({ ...task, status: 'blocked' }, [run('1', { status: 'failed', interrupted: true })]), '끊김·재개 가능');
  assert.equal(taskLabel(task, [run('1', { status: 'stopped', paused: true }), run('2', { status: 'running' })]), '진행');
  assert.equal(taskLabel({ ...task, status: 'done' }, [run('1', { status: 'stopped', paused: true })]), '완료');
  assert.equal(taskLabel(task, [run('1', { status: 'stopped', paused: true, phase: 'stage' })]), '진행');
});
