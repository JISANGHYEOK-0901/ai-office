import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createVideoHistory, youtubeVideoIds } from '../lib/video-history.mjs';

const A = 'AbCdEfGhI_1', B = 'ZyXwVuTsR_2';
test('shorts/watch/공유/임베드/인코딩 주소를 같은 영상 ID로 정규화한다', () => {
  assert.deepEqual(youtubeVideoIds(`https://www.youtube.com/shorts/${A}?feature=share https://youtu.be/${A}?si=abc https://m.youtube.com/watch?t=30&v=${A} https://www.youtube-nocookie.com/embed/${A} https://youtube.com/shorts/%41bCdEfGhI_1.`), [A]);
  assert.deepEqual(youtubeVideoIds(`https://youtube.com.evil.invalid/shorts/${A} https://notyoutube.com/watch?v=${A} https://youtube.com/shorts/nope`), []);
  assert.deepEqual(youtubeVideoIds(`[영상](https://youtu.be/${A}) <a href="https://www.youtube.com/watch?v=${B}&amp;t=1">보기</a>`), [A, B]);
});

test('작업·날짜·재시작과 무관하게 게시 ID를 보존하고 다른 소유자의 동시 게시를 차단한다', async (t) => {
  const root = mkdtempSync(tmpdir() + '/office-videos-'); t.after(() => rm(root, { recursive: true, force: true }));
  let store = createVideoHistory(root);
  const one = { ids: [A], owner: 'job-1', scope: 'day-1' };
  store.check(one); assert.deepEqual(store.excluded('day-2'), []);
  store.claim(one); assert.throws(() => store.claim({ ids: [A], owner: 'job-2', scope: 'day-1' }), /영상/);
  store = createVideoHistory(root); assert.deepEqual(store.excluded('day-2'), [A]);
  assert.deepEqual(store.excluded('day-1'), []);
  store.confirm({ ids: [A], owner: 'job-1', resultUrl: 'https://cafe.naver.com/fixture/1' });
  assert.throws(() => store.check({ ...one }), /영상/);
  assert.throws(() => store.check({ ids: [A], owner: 'tomorrow', scope: 'day-2' }), /영상/);
});

test('게시 시도·불명 결과도 일일 한도에 포함하며 같은 업무의 확인 단계는 추가 소비하지 않는다', async (t) => {
  const root = mkdtempSync(tmpdir() + '/office-video-quota-'); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createVideoHistory(root), schedule = { id: 'daily', slot: '2026-10-30', maxPosts: 1 };
  store.claim({ ids: [A], owner: 'one', scope: 'one', schedule });
  store.check({ ids: [A], owner: 'one', scope: 'one', schedule });
  assert.throws(() => store.claim({ ids: [B], owner: 'two', scope: 'two', schedule }), /최대/);
  store.claim({ ids: [B], owner: 'two', scope: 'two', schedule: { ...schedule, slot: '2026-10-31' } });
});
