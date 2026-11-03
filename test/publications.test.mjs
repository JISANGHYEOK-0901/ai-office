import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePublications } from '../lib/publications.mjs';

const postPlan = { stages: [{ id: 'drafts', output: 'posts.json' }], publications: [{ id: 'daily', action: 'post', service: 'naver_cafe', content: 'drafts', subject: '', recipients: [] }] };
test('검토한 게시글 JSON을 글별로 나누고 기존 영상·묶음 내 같은 영상·일일 초과를 제외한다', () => {
  const body = (id) => ({ subject: id, body: `확인한 요약 https://youtu.be/${id}` });
  const result = preparePublications(postPlan, () => JSON.stringify({ posts: [body('AbCdEfGhI_1'), body('ZyXwVuTsR_2'), { subject: '주소만 다름', body: 'https://www.youtube.com/shorts/ZyXwVuTsR_2' }, body('MnOpQrStU_3'), body('VwXyZaBcD_4')], skipped: [] }),
    { excludedVideos: ['AbCdEfGhI_1'], videoPolicy: { uniqueYoutube: true, maxPosts: 2 } });
  assert.equal(result.jobs.length, 2); assert.equal(result.errors.length, 0); assert.equal(result.skipped.length, 3);
  assert.notEqual(result.jobs[0].publication.id, result.jobs[1].publication.id);
  assert.equal(result.jobs[0].body, '확인한 요약 https://youtu.be/ZyXwVuTsR_2');
});
test('영상 없는 문안은 반려하고 후보 부족 사유가 있으면 0건도 정직하게 전달한다', () => {
  const bad = preparePublications(postPlan, () => JSON.stringify({ posts: [{ subject: '자료', body: '링크 없음' }] }), { videoPolicy: { uniqueYoutube: true } });
  assert.match(bad.errors[0].reason, /영상 링크/);
  const titleOnly = preparePublications(postPlan, () => JSON.stringify({ posts: [{ subject: 'https://youtu.be/AbCdEfGhI_1', body: '본문에는 원본 링크가 없음' }] }), { videoPolicy: { uniqueYoutube: true } });
  assert.equal(titleOnly.jobs.length, 0); assert.match(titleOnly.errors[0].reason, /본문/);
  const empty = preparePublications(postPlan, () => JSON.stringify({ posts: [], skipped: ['주제에 맞는 새 영상 없음'] }));
  assert.equal(empty.jobs.length, 0); assert.equal(empty.errors.length, 0); assert.equal(empty.skipped[0], '주제에 맞는 새 영상 없음');
});
import { sentMailReceipt } from '../lib/browser-work.mjs';

test('보낸 메일 상세는 실제 시도·계정·수신자 전부·제목·본문 전체가 맞을 때만 증표로 인정한다', () => {
  const input = { attempted: true, url: 'https://mail.worksmobile.com/read/popup?nMailId=42', sender: 'sender@example.invalid',
    recipients: ['recipient@example.invalid'], subject: '협업 문의', body: '안녕하세요.\n협업 가능성을 문의합니다.\n김담당 드림',
    text: '제목 협업 문의\n보낸사람 sender@example.invalid\n받는사람 recipient@example.invalid\n안녕하세요. 협업 가능성을 문의합니다. 김담당 드림' };
  assert.equal(sentMailReceipt(input).messageId, '42');
  for (const update of [{ attempted: false }, { url: 'https://mail.worksmobile.com/write/popup?nMailId=42' },
    { body: input.body + ' 변경한 원문' }, { recipients: ['other@example.invalid'] }, { sender: 'other@example.invalid' },
    { text: input.text.replace('받는사람', '참조 extra@example.invalid 받는사람') }]) assert.equal(sentMailReceipt({ ...input, ...update }), null);
});

const plan = { stages: [{ id: 'drafts', output: 'marketing/messages.json' }], publications: [{ id: 'mail', content: 'drafts', action: 'mail', service: 'naverworks_mail', recipients: [], subject: '' }] };
test('조사 후 알게 된 수신자와 개인별 문안을 검토 산출물에서 자동 확정한다', () => {
  const result = preparePublications(plan, () => JSON.stringify({ messages: [
    { recipients: ['a@example.invalid'], subject: 'A 제휴 제안', body: 'A 회사 양식' },
    { recipients: ['b@example.invalid'], subject: 'B 제휴 제안', body: 'B 회사 양식' },
  ], skipped: ['C 회사: 연락처 미확인'] }));
  assert.equal(result.errors.length, 0); assert.equal(result.jobs.length, 2);
  assert.deepEqual(result.jobs.map((j) => j.publication.recipients), [['a@example.invalid'], ['b@example.invalid']]);
  assert.deepEqual(result.jobs.map((j) => j.body), ['A 회사 양식', 'B 회사 양식']);
  assert.equal(result.skipped.length, 1);
});
test('확인된 연락처가 없으면 메일을 만들지 않고 수신자를 지어내지 않는다', () => {
  const result = preparePublications(plan, () => JSON.stringify({ messages: [], skipped: ['공개 연락처 없음'] }));
  assert.equal(result.jobs.length, 0); assert.equal(result.skipped.length, 1);
  const bad = preparePublications(plan, () => JSON.stringify({ messages: [{ recipients: [], subject: '제목', body: '본문' }] }));
  assert.equal(bad.errors[0].stage, 'drafts');
});
