// 메일 첨부 파일 찾기: 대표 원문 근거, 검색 범위, 여러 개·없음은 질문, 비밀·숨김 파일 차단
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, attachmentQuestion, blockedReason, pickChoices, resolveAttachments } from '../lib/attachments.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'office-attach-'))), home = join(base, 'home'), root = join(base, 'workspace');
  t.after(() => rm(base, { recursive: true, force: true }));
  const put = (path, content = 'x') => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); return path; };
  for (const dir of ['Downloads', 'Documents', 'Desktop', 'Music']) mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(join(root, '보관함'), { recursive: true });
  return { home, root, put, resolve: (refs, text, extra = {}) => resolveAttachments(refs, { text, root, home, ...extra }) };
}

test('파일 이름만 적어도 작업 공간·다운로드·문서·데스크톱에서 하나뿐이면 그 파일을 붙인다', (t) => {
  const f = fixture(t);
  const path = f.put(join(f.home, 'Downloads', '제휴제안서.pdf'));
  const result = f.resolve(['제휴제안서.pdf'], '제휴업체에 제휴제안서.pdf 첨부해서 메일 보내줘');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.files, [{ ref: '제휴제안서.pdf', name: '제휴제안서.pdf', path }]);
  // 보관함 안의 파일, 확장자 없이 쓴 이름, macOS의 자모 분리(NFD) 파일 이름도 찾는다
  const vault = f.put(join(f.root, '보관함', '회사소개서.pdf'.normalize('NFD')));
  assert.equal(f.resolve(['회사소개서'], '회사소개서 붙여서 보내줘').files[0].path, vault);
});

test('대표 지시문에 없는 파일 이름은 AI가 붙이지 못한다', (t) => {
  const f = fixture(t);
  f.put(join(f.home, 'Documents', '내부단가표.xlsx'));
  const result = f.resolve(['내부단가표.xlsx'], '제휴 메일 보내줘');
  assert.equal(result.files.length, 0);
  assert.match(result.problems[0].reason, /대표 지시문에 없는/);
});

test('같은 이름이 여러 개면 후보를 보여 주고 묻고, "2번" 답장으로 확정한다', (t) => {
  const f = fixture(t);
  const a = f.put(join(f.home, 'Downloads', '제안서.pdf')), b = f.put(join(f.home, 'Documents', '제휴', '제안서.pdf'));
  const text = '제안서.pdf 첨부해서 보내줘';
  const first = f.resolve(['제안서.pdf'], text);
  assert.equal(first.files.length, 0);
  assert.deepEqual(first.problems[0].candidates, [b, a].sort());
  const question = attachmentQuestion(first.problems, f.home);
  assert.match(question, /같은 이름의 파일이 2개/); assert.match(question, /1\. ~\/Documents\/제휴\/제안서\.pdf/); assert.match(question, /보내지 않습니다/);
  const chosen = pickChoices('2번으로 해줘', { '제안서.pdf': first.problems[0].candidates });
  assert.deepEqual(chosen, { '제안서.pdf': a });
  assert.equal(f.resolve(['제안서.pdf'], text, { chosen }).files[0].path, a);
  // 경로를 적은 답장도 된다(공백이 든 폴더 이름 포함)
  const spaced = f.put(join(f.home, 'Desktop', '제휴 자료', '제안서.pdf'));
  assert.equal(f.resolve(['제안서.pdf'], `${text}\n~/Desktop/제휴 자료/제안서.pdf 로 첨부해`).files[0].path, spaced);
  // 여러 파일을 물었으면 이름과 번호를 함께 적은 답장만 고른다
  assert.deepEqual(pickChoices('1번', { 'a.pdf': [a, b], 'b.pdf': [a, b] }), {});
  assert.deepEqual(pickChoices('b.pdf는 2번', { 'a.pdf': [a, b], 'b.pdf': [a, b] }), { 'b.pdf': b });
});

test('못 찾으면 묻고, 검색 범위 밖·숨김 폴더·심볼릭 링크로는 찾아 들어가지 않는다', (t) => {
  const f = fixture(t);
  f.put(join(f.home, 'Music', '소개.pdf'));
  f.put(join(f.home, 'Documents', '.hidden', '소개.pdf'));
  const outside = f.put(join(f.home, '.ssh', 'keys', '소개.pdf'));
  symlinkSync(join(f.home, '.ssh', 'keys'), join(f.home, 'Downloads', 'link'));
  const result = f.resolve(['소개.pdf'], '소개.pdf 첨부');
  assert.equal(result.files.length, 0);
  assert.match(result.problems[0].reason, /찾지 못했습니다/);
  assert.match(attachmentQuestion(result.problems, f.home), /전체 경로로 답하거나/);
  // 범위 밖이라도 대표가 전체 경로를 적으면 그 파일을 쓴다(숨김 폴더는 제외)
  const music = join(f.home, 'Music', '소개.pdf');
  assert.equal(f.resolve(['소개.pdf'], `소개.pdf 첨부. 경로는 ${music}`).files[0].path, music);
  assert.match(f.resolve([outside], `${outside} 첨부해`).problems[0].reason, /숨김/);
});

test('계정 파일·비밀 폴더·키 파일·50MB 초과 파일은 대표가 지정해도 첨부하지 않는다', (t) => {
  const f = fixture(t);
  f.put(join(f.root, '보관함', '계정.env'), 'SITE_PASSWORD=x');
  assert.match(f.resolve(['계정.env'], '계정.env 첨부해서 보내').problems[0].reason, /계정 파일/);
  const privateFile = f.put(join(f.home, '.config', 'ai-office', 'private', 'state.pdf'));
  assert.match(blockedReason(privateFile, { root: f.root, home: f.home }), /비밀 폴더/);
  for (const name of ['server.pem', 'id_rsa', 'prod.env', 'cert.p12']) {
    const path = f.put(join(f.home, 'Downloads', name));
    assert.match(blockedReason(path, { root: f.root, home: f.home }), /키 파일/, name);
  }
  const big = f.put(join(f.home, 'Downloads', '영상.mp4'));
  truncateSync(big, MAX_ATTACHMENT_BYTES + 1);
  assert.match(f.resolve(['영상.mp4'], '영상.mp4 첨부').problems[0].reason, /50MB/);
});

test('서로 다른 파일이 같은 이름이면 메일에서 구분할 수 없어 묻는다', (t) => {
  const f = fixture(t);
  const a = f.put(join(f.home, 'Downloads', 'a', '자료.pdf')), b = f.put(join(f.home, 'Downloads', 'b', '자료.pdf'));
  const result = f.resolve([a, b], `${a}와 ${b} 둘 다 첨부`);
  assert.equal(result.files.length, 0);
  assert.match(result.problems[0].reason, /이름이 같습니다/);
});

import { readFileSync } from 'node:fs';
import { orchestrate } from '../dashboard/orchestrator.mjs';

async function office(t, { prompt, attachments }) {
  const f = fixture(t), task = '2026-11-04/partner-attach', root = f.root;
  for (const dir of ['org', '.office', `outputs/${task}`]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'org/departments.json'), JSON.stringify([{ id: 'ops', name: '운영', engine: 'claude' }]));
  writeFileSync(join(root, 'org/roster.json'), JSON.stringify([{ id: 'writer', name: '작성', department: 'ops' }]));
  writeFileSync(join(root, '.office/tasks.json'), JSON.stringify([{ id: task, title: '제휴 메일', status: 'active' }]));
  const output = `outputs/${task}/ops/writer-messages.json`;
  const plan = { version: 1, task, goal: '제휴 메일', stages: [{ id: 'drafts', title: '메일 문안', dept: 'ops', agent: 'writer', inputs: [], output, done: '업체별 문안', dependsOn: [] }],
    review: { by: 'chief', criteria: '검토' }, gaps: [], publications: [{ id: 'mail', action: 'mail', service: 'naverworks_mail', connection: '', agent: 'writer', target: 'https://mail.worksmobile.com/',
      recipients: [], subject: '', content: 'drafts', instructions: '', files: [], attachments }] };
  const delivered = [], phases = [], prompts = [];
  const call = (text) => orchestrate({ root, home: f.home, run: { id: 'run', rootId: 'attach-run', task, engine: 'codex' }, prompt: text, signal: new AbortController().signal,
    outbound: { connections: () => [{ id: 'works-1', label: '메일 계정', provider: 'naverworks', status: 'connected' }], deliver: async (request) => {
      delivered.push(request); return { status: 'confirmed' };
    } },
    execute: async ({ phase, prompt: input }) => {
      phases.push(phase); prompts.push(input);
      if (phase === 'plan') return JSON.stringify({ plan, question: '', needsMeeting: false });
      if (phase === 'stage') { mkdirSync(join(root, `outputs/${task}/ops`), { recursive: true }); writeFileSync(join(root, output), JSON.stringify({ messages: ['a@example.invalid', 'b@example.invalid'].map((r) => ({ recipients: [r], subject: '제휴 제안', body: `${r} 담당자님께` })) })); return JSON.stringify({ status: 'done', summary: '문안' }); }
      if (phase === 'review') return JSON.stringify({ verdict: 'pass', report: '# 제휴 메일\n\n검토 완료', question: '' });
      throw new Error('예상 밖 실행: ' + phase);
    } });
  const status = () => JSON.parse(readFileSync(join(root, '.office/tasks.json')))[0].status;
  return { ...f, call: () => call(prompt), answer: call, delivered, phases, prompts, status };
}

test('실행기: 같은 이름 첨부가 여러 개면 조사 전에 묻고, 고른 파일을 모든 수신자 메일에 같은 파일로 붙인다', async (t) => {
  const o = await office(t, { prompt: '제휴업체 2곳에 제안서.pdf 첨부해서 메일 보내줘. 끝까지 자동으로', attachments: ['제안서.pdf '] }); // AI가 이름 뒤에 공백을 붙여도 같은 첨부로 본다
  const inVault = o.put(join(o.root, '보관함', '제안서.pdf')); o.put(join(o.home, 'Downloads', '제안서.pdf'));
  const asked = await o.call();
  assert.match(asked, /메일에 첨부할 파일을 확인해 주세요/);
  assert.deepEqual(o.phases, ['plan'], '조사·작성 전에 묻는다');
  assert.equal(o.status(), 'blocked');
  const candidates = asked.match(/^ {2}\d\. .+$/gm);
  assert.equal(candidates.length, 2);
  const pick = candidates.findIndex((line) => line.includes('보관함')) + 1;
  await o.answer(`${pick}번`);
  assert.equal(o.delivered.length, 2);
  for (const request of o.delivered) assert.deepEqual(request.files, [{ name: '제안서.pdf', path: inVault }]);
  assert.ok(o.prompts.some((p) => p.includes('attachments에 대표가 쓴 파일 이름')), '계획 지시에 첨부 안내가 있다');
  assert.equal(o.status(), 'done');
});

test('실행기: 위임이 없으면 실행 전 확인 목록에 첨부 파일명을 보여 준다', async (t) => {
  const o = await office(t, { prompt: '제휴업체 2곳에 회사소개서.pdf 첨부해서 메일 보내줘', attachments: ['회사소개서.pdf'] });
  o.put(join(o.home, 'Desktop', '회사소개서.pdf'));
  const asked = await o.call();
  assert.match(asked, /받는사람 a@example\.invalid .*\(첨부: 회사소개서\.pdf\)/);
  assert.equal(o.delivered.length, 0);
});

test('실행기: 대표가 말하지 않은 파일을 계획에 넣으면 보내지 않고 묻는다', async (t) => {
  const o = await office(t, { prompt: '제휴업체 2곳에 메일 보내줘. 끝까지 자동으로', attachments: ['내부단가표.xlsx'] });
  o.put(join(o.home, 'Documents', '내부단가표.xlsx'));
  assert.match(await o.call(), /대표 지시문에 없는 파일 이름입니다/);
  assert.equal(o.delivered.length, 0);
});
