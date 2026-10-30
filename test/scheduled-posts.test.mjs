import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrate } from '../dashboard/orchestrator.mjs';

for (const mode of ['normal', 'race', 'empty']) test(`예약 영상 게시: ${mode} — 중복 제외·실제 게시 수·후보 부족·완료 보고 연결`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-scheduled-posts-')), task = '2026-10-30/daily-posts';
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['org', '.office', `outputs/${task}`]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'org/departments.json'), JSON.stringify([{ id: 'ops', name: '운영', engine: 'claude' }]));
  writeFileSync(join(root, 'org/roster.json'), JSON.stringify([{ id: 'writer', name: '작성', department: 'ops' }]));
  writeFileSync(join(root, '.office/tasks.json'), JSON.stringify([{ id: task, title: '예약 영상 글', status: 'active' }]));
  const output = `outputs/${task}/ops/writer-posts.json`;
  const posts = ['AbCdEfGhI_1', 'ZyXwVuTsR_2', 'MnOpQrStU_3'].map((id) => ({ subject: `가상 검증 ${id}`, body: `확인한 가상 요약 https://www.youtube.com/shorts/${id}` }));
  const plan = { version: 1, task, goal: '가상 자료로 예약 게시 검증', stages: [{ id: 'drafts', title: '게시 문안', dept: 'ops', agent: 'writer', inputs: [], output, done: '원본 링크와 요약', dependsOn: [] }],
    review: { by: 'chief', criteria: '검토' }, gaps: [], publications: [{ id: 'daily', action: 'post', service: 'naver_cafe', connection: '', agent: 'writer', target: 'https://cafe.naver.com/fixture', recipients: [], subject: '', content: 'drafts' }] };
  const delivered = [], prompts = [];
  const result = await orchestrate({ root, run: { id: 'run', rootId: 'run', task, engine: 'codex', schedule: { id: 'daily', slot: '2026-10-30', uniqueYoutube: true, minPosts: 2, maxPosts: 3 } },
    prompt: '주제에 맞는 유튜브 숏츠를 카페에 게시해 줘', signal: new AbortController().signal,
    outbound: { connections: () => [], videoHistory: () => ['AbCdEfGhI_1'], deliver: async (request) => {
      assert.equal(request.schedule.maxPosts, 3);
      if (mode === 'race' && !delivered.length) { delivered.push('race-skip'); const error = new Error('다른 예약이 먼저 게시한 영상'); error.code = 'VIDEO_DUPLICATE'; throw error; }
      delivered.push(request.body); return { status: 'confirmed', resultUrl: `https://cafe.naver.com/fixture/${delivered.length}` };
    } },
    execute: async ({ phase, prompt }) => {
      prompts.push(prompt);
      if (phase === 'plan') return JSON.stringify({ plan, question: '', needsMeeting: false });
      if (phase === 'stage') { mkdirSync(join(root, `outputs/${task}/ops`), { recursive: true }); writeFileSync(join(root, output), JSON.stringify({ posts: mode === 'empty' ? [] : posts, skipped: mode === 'empty' ? ['확인한 신규 후보 없음'] : [] })); return JSON.stringify({ status: 'done', summary: '가상 게시 문안 작성' }); }
      if (phase === 'review') return JSON.stringify({ verdict: 'pass', report: '# 완료한 작업\n\n가상 원본 대조 완료', question: '' });
      throw new Error('예상 밖 실행: ' + phase);
    } });
  assert.equal(JSON.parse(readFileSync(join(root, '.office/tasks.json')))[0].status, 'done');
  assert.ok(prompts.every((prompt) => prompt.includes('video-exclusions.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(root, `outputs/${task}/video-exclusions.json`))).excludedVideoIds, ['AbCdEfGhI_1']);
  assert.doesNotMatch(delivered.join('\n'), /AbCdEfGhI_1/);
  assert.match(result, new RegExp(`영상 게시 ${mode === 'normal' ? 2 : mode === 'race' ? 1 : 0}건`));
  if (mode !== 'normal') assert.match(result, /부족/);
});
