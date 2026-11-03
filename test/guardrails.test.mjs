// 안전선 규칙을 한곳에서 고정한다. 규칙을 바꾸면 이 표도 함께 바꿔야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  CONTINUOUS_LIMITS, MAX_REVIEW_REJECTS, SECRET_MENTION, evidenceIn, externalActionPolicy,
  isFinalAction, isFinalConfirm, isForbiddenAction, isReadOnlyBlocked, secretLocations,
} from '../lib/guardrails.mjs';

test('금지 동작: 삭제·탈퇴·로그아웃·결제·송금·비밀번호 버튼은 위임이 있어도 누르지 않는다', () => {
  for (const label of ['게시글 삭제', '회원 탈퇴', '로그아웃', '결제하기', '송금', '계좌 이체', '비밀번호 변경', 'Delete', 'Log out', 'Purchase'])
    assert.equal(isForbiddenAction(label), true, label);
  for (const label of ['등록', '보내기', '게시판 선택', '검색', '']) assert.equal(isForbiddenAction(label), false, label);
});

test('되돌리기 어려운 버튼: 발송·게시·등록은 최종 버튼, 게시판 선택은 아니다. 일반 웹사이트는 업로드·저장도 포함', () => {
  for (const label of ['보내기', '발송', '발행', '게시', '등록', '작성 완료', 'Send', 'post'])
    assert.equal(isFinalAction(label), true, label);
  for (const label of ['게시판 선택', '별지기 쉼터 수다방 게시판', '업로드', '저장', '검색', '메일쓰기'])
    assert.equal(isFinalAction(label), false, label);
  for (const label of ['업로드', '저장', '제출', '적용', 'save', 'upload', '등록'])
    assert.equal(isFinalAction(label, { site: true }), true, label);
  assert.equal(isFinalAction('게시판 선택', { site: true }), false);
  assert.equal(isFinalConfirm('확인'), true);
  assert.equal(isFinalConfirm('취소'), false);
});

test('조회 단계 읽기 전용: 이름이 쓰기 동작 그 자체인 버튼만 막고, 등록일 같은 열 이름은 허용한다', () => {
  for (const label of ['등록', '저장하기', '삭제', '승인', 'submit', '작성 완료']) assert.equal(isReadOnlyBlocked(label), true, label);
  for (const label of ['등록일', '최근 저장 목록', '검색', '다음 페이지']) assert.equal(isReadOnlyBlocked(label), false, label);
});

test('외부 작업 허용·위임은 대표 원문에서만 나오고, 금지 문장은 허용을 지운다', () => {
  assert.deepEqual(externalActionPolicy(['카페에 글 올려줘. 끝까지 자동으로']), { actions: ['post'], delegated: true, allowResend: false, retryUncertain: false, confirmExisting: false });
  assert.deepEqual(externalActionPolicy(['메일 초안만 써줘']).actions, []);
  assert.deepEqual(externalActionPolicy(['메일로 보내줘', '발송은 하지 마']).actions, []);
  assert.equal(externalActionPolicy(['메일로 보내줘']).delegated, false);
});

test('AI 판별 근거는 대표 원문에 실제로 있어야 한다(앞말·따옴표는 걷어 낸다)', () => {
  assert.equal(evidenceIn('하던 거 다 멈춰', '대표 지시: "하던 거 다 멈춰"'), true);
  assert.equal(evidenceIn('보고서 써줘', '메일로 보내줘'), false);
  assert.equal(evidenceIn('보고서 써줘', '써'), false, '한 글자 근거는 인정하지 않는다');
});

test('한도와 비밀값 위치', () => {
  assert.deepEqual({ ...CONTINUOUS_LIMITS }, { minIntervalMs: 10000, maxIntervalMs: 86400000, maxSpanMs: 365 * 86400000 });
  assert.equal(MAX_REVIEW_REJECTS, 2);
  assert.deepEqual(secretLocations('/w', '/home/u'), [join('/w', '보관함', '계정.env'), join('/home/u', '.config', 'ai-office', 'private')]);
  assert.equal(SECRET_MENTION.test('cat 보관함/계정.env'), true);
  assert.equal(SECRET_MENTION.test('ls ~/.config/ai-office/private'), true);
  assert.equal(SECRET_MENTION.test('cat outputs/report.md'), false);
});
