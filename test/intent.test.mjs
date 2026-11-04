import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAnswer, judgeCommand } from '../lib/intent.mjs';
import { evidenceIn } from '../lib/guardrails.mjs';
import { parseJudge } from '../lib/ai-judge.mjs';

const ai = (fields) => async () => ({ kind: 'task', kindEvidence: '', externalActions: [], delegated: false, delegatedEvidence: '', standing: 'none', standingEvidence: '',
  durationMinutes: 0, deadline: '', intervalMinutes: 0, scheduleTime: '', scheduleDate: '', scheduleTimes: 0, scheduleEvidence: '', outputDir: '', outputDirEvidence: '', ...fields });
const NOW = Date.parse('2026-11-03T09:00:00+09:00');

test('근거 문장은 앞말·따옴표를 걷어 내고 대표 원문에 실제로 있을 때만 인정한다', () => {
  assert.equal(evidenceIn('노트북 끌 거니까 하던 거 다 멈춰', '대표 지시: "노트북 끌 거니까 하던 거 다 멈춰"'), true);
  assert.equal(evidenceIn('보고서 써줘', '메일로 보내줘'), false);
  assert.equal(evidenceIn('보고서 써줘', ''), false);
});

test('AI가 판별한 일시정지·재개·외부 작업·위임은 근거가 원문에 있을 때만 쓴다', async () => {
  assert.equal((await judgeCommand('노트북 끌 거니까 하던 거 다 멈춰', { judge: ai({ kind: 'pause', kindEvidence: '하던 거 다 멈춰' }) })).kind, 'pause');
  // 정규식이 놓치는 표현도 AI가 알아본다
  assert.equal((await judgeCommand('오늘은 여기까지 하고 내일 마저 하자', { judge: ai({ kind: 'pause', kindEvidence: '오늘은 여기까지' }) })).kind, 'pause');
  const upload = await judgeCommand('만든 HTML을 ERP 제휴 페이지에 반영해 두고, 알아서 끝까지 해', { judge: ai({
    externalActions: [{ action: 'web', evidence: 'ERP 제휴 페이지에 반영해' }, { action: 'mail', evidence: '메일로 업체에 보내' }], delegated: true, delegatedEvidence: '알아서 끝까지 해' }) });
  assert.deepEqual([upload.actions, upload.delegated, upload.source], [['web'], true, 'ai'], '근거 없는 mail은 버린다');
  const invented = await judgeCommand('보고서만 써 줘', { judge: ai({ externalActions: [{ action: 'post', evidence: '블로그에 올려' }], delegated: true, delegatedEvidence: '끝까지' }) });
  assert.deepEqual([invented.actions, invented.delegated], [[], false], 'AI가 지어낸 허가는 인정하지 않는다');
  const paraphrased = await judgeCommand('꼬리별 관측소 내 글 업로드 부탁해', { judge: ai({ externalActions: [{ action: 'post', evidence: '카페에 글을 게시' }] }) });
  assert.deepEqual(paraphrased.actions, ['post'], '의역 근거라도 규칙이 같은 결론이면 글 게시로 인정한다');
  // 실행기가 붙인 저장 위치 안내는 판별 대상이 아니다
  const saved = await judgeCommand('ERP에서 상담사 리스트 정리해 줘\n\n[저장 위치] 이 작업의 산출물은 이 폴더에 저장하세요: x', { judge: ai({ externalActions: [{ action: 'web', evidence: '저장하세요' }] }) });
  assert.deepEqual(saved.actions, []);
});

test('대시보드 내역 지우기: 문장 형태와 근거가 맞을 때만 받고 다른 자료의 내역은 업무로 둔다', async () => {
  for (const text of ['작업 내역 지워줘', '작업내역 다 지워', '업무 기록 삭제해줘', '끝난 업무 내역 전부 지워 주세요', '실행 기록 초기화해줘', '내역 초기화해줘', '대화 기록 비워줘']) {
    assert.equal((await judgeCommand(text, { judge: ai({ kind: 'task' }) })).kind, 'clear_history', text);
  }
  for (const text of ['고객 상담 내역 지워줘', 'ERP에서 주문 내역 삭제해줘', '작업 내역을 표로 정리해서 보고서로 만들어줘', '카페 활동 기록 삭제 방법 알려줘']) {
    assert.equal((await judgeCommand(text, { judge: ai({ kind: 'task' }) })).kind, 'task', text);
  }
  // 규칙 형태가 아니어도 AI 판별과 근거, 대시보드 내역을 가리키는 말이 맞으면 받는다
  const said = '오늘 끝낸 작업 내역이 많으니까 지워 두자';
  assert.equal((await judgeCommand(said, { judge: ai({ kind: 'clear_history', kindEvidence: said }) })).kind, 'clear_history');
  assert.equal((await judgeCommand('주문 데이터 싹 지워', { judge: ai({ kind: 'clear_history', kindEvidence: '주문 데이터 싹 지워' }) })).kind, 'task', 'AI가 잘못 봐도 지우지 않는다');
  assert.equal((await judgeCommand(said, { judge: ai({ kind: 'clear_history', kindEvidence: '지어낸 근거 문장' }) })).kind, 'task');
});

test('업무 끝내기 문장은 업무를 가리키는 말이 있을 때만 받는다', async () => {
  const { taskCloseIntent, historyClearIntent } = await import('../lib/pause.mjs');
  for (const text of ['이 업무 끝내줘', '업무 종료', '이 작업 취소해줘', '이 일은 그만해', '작업 마무리해 줘']) assert.equal(taskCloseIntent(text), true, text);
  for (const text of ['그만', '하지 마', '끝까지 자동으로', '보고서 작업 끝내줘', '기본값으로 진행']) assert.equal(taskCloseIntent(text), false, text);
  assert.equal(historyClearIntent('작업 내역 없애줘'), true);
});

test('빠른 조회는 단순 조회에만 쓰고, 정밀 확인·제작·외부 작업·판별 실패는 전체 흐름으로 간다', async () => {
  const judge = (fields = {}) => ai({ quick: true, quickAgent: 'research-1', ...fields });
  const plain = await judgeCommand('미국 중간선거 최신 자료 10건 수집해줘', { judge: judge() });
  assert.deepEqual([plain.quick, plain.quickAgent], [true, 'research-1']);
  for (const text of ['중간선거 자료 10건 검증해서 수집해줘', '자료 찾아서 보고서로 만들어줘', '경쟁사 자료 찾아 분석해줘', '자료 찾아 HTML로 만들어줘']) {
    assert.equal((await judgeCommand(text, { judge: judge() })).quick, false, text);
  }
  assert.equal((await judgeCommand('자료 찾아서 카페에 글 올려줘', { judge: judge({ externalActions: [{ action: 'post', evidence: '카페에 글 올려줘' }] }) })).quick, false);
  assert.equal((await judgeCommand('자료 찾아줘', { judge: judge({ quick: false }) })).quick, false);
  assert.ok(!(await judgeCommand('자료 찾아줘', { judge: async () => null })).quick, '판별 실패');
  assert.match((await import('../lib/intent.mjs')).commandPrompt('자료', new Date(), [{ id: 'research-1' }]), /quickAgent.*research-1/);
});

test('상시 실행(멈출 때까지·기간·종료 시각)과 예약(매일·1회·N회)을 근거와 함께 판별한다', async () => {
  const forever = await judgeCommand('새 자료 나오면 알려 주고 내가 그만하라고 할 때까지 계속 봐', { now: NOW, judge: ai({ standing: 'until_stop', standingEvidence: '그만하라고 할 때까지 계속', intervalMinutes: 10 }) });
  assert.deepEqual(forever.continuous, { intervalMs: 600000, durationMs: null });
  const day = await judgeCommand('하루 종일 시장 동향 지켜봐', { now: NOW, judge: ai({ standing: 'duration', standingEvidence: '하루 종일', durationMinutes: 1440 }) });
  assert.deepEqual(day.continuous, { intervalMs: 300000, durationMs: 86400000 });
  const until = await judgeCommand('오늘 오후 6시까지 계속 확인해', { now: NOW, judge: ai({ standing: 'deadline', standingEvidence: '오후 6시까지', deadline: '2026-11-03 18:00' }) });
  assert.equal(until.continuous.deadlineAt, Date.parse('2026-11-03T18:00:00+09:00'));
  const past = await judgeCommand('어제 6시까지 확인해', { now: NOW, judge: ai({ standing: 'deadline', standingEvidence: '6시까지', deadline: '2026-11-02 18:00' }) });
  assert.equal(past.continuous, null, '지난 시각은 상시 실행으로 받지 않는다');
  const daily = await judgeCommand('평일 아침 9시마다 매일 뉴스 정리해 줘', { now: NOW, judge: ai({ scheduleTime: '09:00', scheduleEvidence: '아침 9시마다' }) });
  assert.deepEqual(daily.schedule, { time: '09:00' });
  const once = await judgeCommand('내일 오전 10시에 카페에 게시글 2개 올려줘', { now: NOW, judge: ai({ scheduleTime: '10:00', scheduleDate: '2026-11-04', scheduleTimes: 1, scheduleEvidence: '내일 오전 10시에' }) });
  assert.deepEqual(once.schedule, { time: '10:00', startDate: '2026-11-04', times: 1 });
  const three = await judgeCommand('내일부터 3일간 매일 9시에 뉴스 정리해 줘', { now: NOW, judge: ai({ scheduleTime: '09:00', scheduleDate: '2026-11-04', scheduleTimes: 3, scheduleEvidence: '내일부터 3일간 매일 9시에' }) });
  assert.deepEqual(three.schedule, { time: '09:00', startDate: '2026-11-04', times: 3 });
  // 근거가 원문에 없거나, 지난 날짜·범위를 넘는 횟수는 예약으로 받지 않는다(횟수만 틀리면 무제한 대신 버린다)
  assert.equal((await judgeCommand('뉴스 정리해 줘', { now: NOW, judge: ai({ scheduleTime: '09:00', scheduleEvidence: '매일 9시' }) })).schedule, null);
  assert.equal((await judgeCommand('어제 9시에 정리해 줘', { now: NOW, judge: ai({ scheduleTime: '09:00', scheduleDate: '2026-11-02', scheduleTimes: 1, scheduleEvidence: '어제 9시에' }) })).schedule, null);
  assert.deepEqual((await judgeCommand('매일 9시에 정리해 줘', { now: NOW, judge: ai({ scheduleTime: '09:00', scheduleTimes: 999, scheduleEvidence: '매일 9시에' }) })).schedule, { time: '09:00' });
});

test('AI 판별이 실패하거나 형식이 틀리면 기존 규칙 판별로 대신한다', async () => {
  const none = await judgeCommand('하던 작업 멈추고 정리해 둬, 다음에 이어서 하자', { judge: async () => null });
  assert.deepEqual([none.kind, none.source], ['pause', 'rule']);
  const broken = await judgeCommand('만든 HTML을 ERP 제휴 제안 페이지에 업로드해 줘', { judge: async () => ({ verdict: 'pass' }) });
  assert.deepEqual([broken.actions, broken.source], [['web'], 'rule']);
  const noJudge = await judgeCommand('계속 시장을 조사하고 새 자료가 나오면 알려 줘', { now: NOW });
  assert.equal(noJudge.continuous.durationMs, null);
});

test('질문에 대한 답장을 승인·거절·수정으로 판별하고 근거 없는 판정은 기타로 둔다', async () => {
  const say = (fields) => async () => ({ decision: 'other', decisionEvidence: '', addActions: [], removeActions: [], delegated: false, delegatedEvidence: '', ...fields });
  assert.equal((await judgeAnswer('그렇게 하세요', [{ question: '실행할까요?' }], { judge: say({ decision: 'approve', decisionEvidence: '그렇게 하세요' }) })).decision, 'approve');
  assert.equal((await judgeAnswer('이번엔 올리지 말자', [], { judge: say({ decision: 'decline', decisionEvidence: '올리지 말자' }) })).decision, 'decline');
  assert.equal((await judgeAnswer('좋아요', [], { judge: say({ decision: 'decline', decisionEvidence: '취소합니다' }) })).decision, 'other');
  const rule = await judgeAnswer('진행해', [], { judge: async () => null });
  assert.deepEqual([rule.decision, rule.source], ['approve', 'rule']);
});

test('Claude·Codex 판별 응답에서 구조화 결과를 읽는다', () => {
  assert.deepEqual(parseJudge(JSON.stringify({ type: 'result', structured_output: { kind: 'pause' } })), { kind: 'pause' });
  assert.deepEqual(parseJudge([JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"kind":"resume"}' } }), JSON.stringify({ type: 'turn.completed' })].join('\n')), { kind: 'resume' });
  assert.equal(parseJudge('not json'), null);
});

test('지시에 적은 저장 폴더는 전체 경로이고 원문에 있을 때만 쓴다', async () => {
  const text = '리스트 만들어서 ~/Desktop/상담사 리스트 폴더에 저장해 줘';
  assert.equal((await judgeCommand(text, { judge: ai({ outputDir: '~/Desktop/상담사 리스트', outputDirEvidence: '~/Desktop/상담사 리스트 폴더에 저장해' }) })).outputDir, '~/Desktop/상담사 리스트');
  assert.equal((await judgeCommand(text, { judge: ai({ outputDir: '~/Documents/다른곳', outputDirEvidence: '~/Desktop/상담사 리스트 폴더에 저장해' }) })).outputDir, null, '원문에 없는 경로는 버린다');
  assert.equal((await judgeCommand('바탕화면에 저장해 줘', { judge: ai({ outputDir: '바탕화면', outputDirEvidence: '바탕화면에 저장해' }) })).outputDir, null, '전체 경로가 아니면 쓰지 않는다');
});

test('근거가 원문과 글자 그대로 맞지 않아도 규칙 판별이 같은 결론이면 외부 작업·위임을 인정한다(실발송 실측 결함)', async () => {
  const text = '네이버웍스 메일 계정으로 a@example.com 과 b@example.com 에 각각 메일을 한 통씩 보내줘. 끝까지 자동으로 진행해.';
  const r = await judgeCommand(text, { judge: ai({ externalActions: [{ action: 'mail', evidence: 'a@example.com, b@example.com 에 메일 보내기' }], delegated: true, delegatedEvidence: '자동 진행' }) });
  assert.deepEqual([r.actions, r.delegated], [['mail'], true]);
  // 규칙도 근거도 없는 허가는 여전히 버린다
  const none = await judgeCommand('보고서만 써 줘', { judge: ai({ externalActions: [{ action: 'mail', evidence: '메일 보내' }], delegated: true, delegatedEvidence: '자동' }) });
  assert.deepEqual([none.actions, none.delegated], [[], false]);
});
