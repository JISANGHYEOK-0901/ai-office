// 메일 대량 발송 금지: 20통씩 보내고 남은 메일은 대표에게 다시 확인받는다(위임이 있어도 같음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_MAILS_PER_RUN } from '../lib/guardrails.mjs';
import { mailKey, preparePublications, splitMailBatch } from '../lib/publications.mjs';
import { orchestrate } from '../dashboard/orchestrator.mjs';

const addresses = (n, from = 0) => Array.from({ length: n }, (_, i) => `partner${from + i}@example.invalid`);
const messages = (list) => list.map((r) => ({ recipients: [r], subject: `${r} 제휴 제안`, body: `${r} 담당자님께 제휴를 제안드립니다.` }));

test('한도는 20통이고, 여러 문안·publication·직접 지정 수신자를 합쳐 수신자 기준으로 센다', () => {
  assert.equal(MAX_MAILS_PER_RUN, 20);
  const plan = { stages: [{ id: 'drafts', output: 'messages.json' }, { id: 'notice', output: 'notice.txt' }], publications: [
    { id: 'm1', action: 'mail', service: 'naverworks_mail', content: 'drafts', recipients: [], subject: '' },
    { id: 'm2', action: 'mail', service: 'naverworks_mail', content: 'notice', recipients: addresses(10, 100), subject: '공지' },
  ] };
  const prepared = preparePublications(plan, (path) => path === 'messages.json' ? JSON.stringify({ messages: messages(addresses(15)) }) : '공지 본문');
  assert.equal(prepared.jobs.length, 25);
  const first = splitMailBatch(prepared.jobs);
  assert.equal(first.run.length, 20); assert.equal(first.remaining.length, 5); assert.equal(first.sentCount, 0);
  assert.deepEqual(first.remaining.map((j) => j.publication.recipients[0]), addresses(5, 105));
  // 앞 20통을 보낸 뒤 다음 확인(허용 40통): 보낸 20통은 결과 보고용으로 남고 새로 보낼 것은 남은 5통이다
  const second = splitMailBatch(prepared.jobs, { sent: first.run.map(mailKey), allowance: 40 });
  assert.equal(second.sentCount, 20); assert.equal(second.run.length, 25); assert.equal(second.remaining.length, 0);
  // 허용을 늘리지 않으면 새로 보낼 메일이 없다
  assert.equal(splitMailBatch(prepared.jobs, { sent: first.run.map(mailKey), allowance: 20 }).remaining.length, 5);
});

test('메일이 아닌 작업은 한도와 무관하고, 같은 수신자라도 내용이 다르면 다른 메일로 센다', () => {
  const job = (action, r, body = '본문') => ({ publication: { action, recipients: r ? [r] : [], subject: '제목' }, body });
  const jobs = [job('post'), ...addresses(21).map((r) => job('mail', r))];
  const { run, remaining } = splitMailBatch(jobs);
  assert.equal(run.filter((j) => j.publication.action === 'post').length, 1);
  assert.equal(remaining.length, 1);
  assert.notEqual(mailKey(job('mail', 'a@example.invalid')), mailKey(job('mail', 'a@example.invalid', '수정본')));
});

async function fixture(t, { prompt, schedule = null }) {
  const root = mkdtempSync(join(tmpdir(), 'office-mail-batch-')), task = '2026-11-04/partner-mail';
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['org', '.office', `outputs/${task}`]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'org/departments.json'), JSON.stringify([{ id: 'ops', name: '운영', engine: 'claude' }]));
  writeFileSync(join(root, 'org/roster.json'), JSON.stringify([{ id: 'writer', name: '작성', department: 'ops' }]));
  writeFileSync(join(root, '.office/tasks.json'), JSON.stringify([{ id: task, title: '제휴 메일', status: 'active' }]));
  const output = `outputs/${task}/ops/writer-messages.json`;
  const plan = { version: 1, task, goal: '제휴 메일 발송', stages: [{ id: 'drafts', title: '메일 문안', dept: 'ops', agent: 'writer', inputs: [], output, done: '업체별 문안', dependsOn: [] }],
    review: { by: 'chief', criteria: '검토' }, gaps: [], publications: [{ id: 'mail', action: 'mail', service: 'naverworks_mail', connection: '', agent: 'writer', target: 'https://mail.worksmobile.com/', recipients: [], subject: '', content: 'drafts' }] };
  const sent = [], phases = [];
  const run = { id: 'run', rootId: 'mail-run', task, engine: 'codex', ...(schedule ? { schedule } : {}) };
  const call = (text) => orchestrate({ root, run, prompt: text, signal: new AbortController().signal,
    outbound: { connections: () => [{ id: 'works-1', label: '메일 계정', provider: 'naverworks', status: 'connected' }], deliver: async ({ publication }) => {
      sent.push(publication.recipients[0]); return { status: 'confirmed', resultUrl: `https://mail.worksmobile.com/read?nMailId=${sent.length}` };
    } },
    execute: async ({ phase }) => {
      phases.push(phase);
      if (phase === 'plan') return JSON.stringify({ plan, question: '', needsMeeting: false });
      if (phase === 'stage') { mkdirSync(join(root, `outputs/${task}/ops`), { recursive: true }); writeFileSync(join(root, output), JSON.stringify({ messages: messages(addresses(25)), skipped: [] })); return JSON.stringify({ status: 'done', summary: '문안 작성' }); }
      if (phase === 'review') return JSON.stringify({ verdict: 'pass', report: '# 제휴 메일\n\n문안 검토 완료', question: '' });
      throw new Error('예상 밖 실행: ' + phase);
    } });
  const status = () => JSON.parse(readFileSync(join(root, '.office/tasks.json')))[0].status;
  return { call: () => call(prompt), answer: call, sent, phases, status, root, task };
}

test('끝까지 자동으로 맡겨도 20통을 보낸 뒤 남은 메일을 묻고, "진행"이면 앞서 보낸 메일은 다시 보내지 않는다', async (t) => {
  const f = await fixture(t, { prompt: '제휴업체 25곳에 제휴 메일 보내줘. 끝까지 자동으로 진행해' });
  const asked = await f.call();
  assert.equal(f.sent.length, 20);
  assert.match(asked, /메일 20통을 보냈습니다\. 남은 메일이 5통 있습니다\. 다음 5통을 이어서 보낼까요\?/);
  assert.match(asked, /partner24@example\.invalid/);
  assert.equal(f.status(), 'blocked');
  const done = await f.answer('진행');
  assert.equal(f.sent.length, 25);
  assert.equal(new Set(f.sent).size, 25, '앞서 보낸 20통은 다시 보내지 않는다');
  assert.equal(f.phases.filter((p) => p === 'stage').length, 1, '이어 보낼 때 문안을 다시 만들지 않는다');
  assert.equal(f.status(), 'done');
  for (const address of addresses(25)) assert.ok(done.includes(address), address);
});

test('남은 메일 확인에 "하지 마"면 보내지 않고 보고서에 남긴 뒤 완료한다', async (t) => {
  const f = await fixture(t, { prompt: '제휴업체 25곳에 제휴 메일 보내줘. 끝까지 자동으로 진행해' });
  await f.call();
  const done = await f.answer('하지 마');
  assert.equal(f.sent.length, 20);
  assert.equal(f.status(), 'done');
  assert.match(done, /대표 결정으로 보내지 않음: 받는사람 partner20@example\.invalid/);
});

test('위임이 없으면 첫 확인에 20통만 보여 주고 남은 통수를 안내한다', async (t) => {
  const f = await fixture(t, { prompt: '제휴업체 25곳에 제휴 메일 보내줘' });
  const asked = await f.call();
  assert.equal(f.sent.length, 0);
  assert.match(asked, /20\. 메일 \[메일 계정\] 받는사람 partner19@example\.invalid/);
  assert.doesNotMatch(asked, /받는사람 partner20@example\.invalid/);
  assert.match(asked, /남은 5통은 위 메일을 보낸 뒤 다시 묻습니다/);
  assert.match(await f.answer('진행'), /남은 메일이 5통 있습니다/);
  assert.equal(f.sent.length, 20);
});

test('대표가 없는 예약 업무는 묻지 않고 20통만 보낸 뒤 남은 메일을 미발송으로 보고한다', async (t) => {
  const f = await fixture(t, { prompt: '제휴업체 25곳에 제휴 메일 보내줘', schedule: { id: 'weekly', slot: '2026-11-04' } });
  const report = await f.call();
  assert.equal(f.sent.length, 20);
  assert.equal(f.status(), 'done');
  assert.match(report, /메일 한도 20통 초과로 이번 회차에 보내지 않음: 받는사람 partner20@example\.invalid/);
});
