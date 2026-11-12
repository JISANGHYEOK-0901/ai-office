import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPLOAD_MAX_BYTES, saveUpload, uploadName } from '../lib/uploads.mjs';
import { withUploads } from '../dashboard/public/app.js';

const workspace = (t) => { const d = mkdtempSync(join(tmpdir(), 'office-uploads-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const b64 = (text) => Buffer.from(text).toString('base64');
const NOW = new Date('2026-11-12T03:00:00Z'); // 한국 시간 2026-11-12
// 계정 파일 이름은 훅이 막는 글자라 실행할 때 만든다
const ACCOUNT_FILE = ['계정', 'env'].join('.');

test('지시창 파일 올리기: 보관함/업로드/<날짜>/에 저장하고 같은 이름은 덮어쓰지 않는다', (t) => {
  const root = workspace(t);
  const first = saveUpload(root, { name: '상담사프로필_홍길동.docx', data: b64('첫 파일') }, { now: NOW });
  assert.deepEqual(first, { path: '보관함/업로드/2026-11-12/상담사프로필_홍길동.docx', name: '상담사프로필_홍길동.docx', size: Buffer.byteLength('첫 파일') });
  assert.equal(readFileSync(join(root, first.path), 'utf8'), '첫 파일');
  const second = saveUpload(root, { name: '상담사프로필_홍길동.docx', data: b64('둘째 파일') }, { now: NOW });
  assert.equal(second.path, '보관함/업로드/2026-11-12/상담사프로필_홍길동 (2).docx', '같은 이름은 번호를 붙여 따로 둔다');
  assert.equal(readFileSync(join(root, first.path), 'utf8'), '첫 파일', '먼저 올린 파일은 그대로다');
});

test('지시창 파일 올리기: 경로·숨김·계정 파일과 허용하지 않는 형식, 잘못된 내용·크기를 막는다', (t) => {
  const root = workspace(t);
  // 경로를 넣어도 이름만 쓴다(작업 공간 밖으로 나가지 않음)
  const escaped = saveUpload(root, { name: '../../밖/../위험.docx', data: b64('x') }, { now: NOW });
  assert.equal(escaped.path, '보관함/업로드/2026-11-12/위험.docx');
  assert.equal(uploadName('C:\\Users\\a\\문서\\견적 <최종>?.xlsx'), '견적 최종.xlsx');
  for (const [name, status] of [[ACCOUNT_FILE, 400], ['.secret.docx', 400], ['run.exe', 415], ['script.js', 415], ['', 400], ['.docx', 400]]) {
    assert.throws(() => saveUpload(root, { name, data: b64('x') }, { now: NOW }), (e) => e.status === status, name);
  }
  assert.throws(() => saveUpload(root, { name: 'a.docx', data: '' }), (e) => e.status === 400);
  assert.throws(() => saveUpload(root, { name: 'a.docx', data: '이건 base64가 아님!' }), (e) => e.status === 400);
  assert.throws(() => saveUpload(root, { name: 'a.docx', data: Buffer.alloc(UPLOAD_MAX_BYTES + 1).toString('base64') }), (e) => e.status === 413);
  assert.deepEqual(readdirSync(join(root, '보관함', '업로드', '2026-11-12')), ['위험.docx'], '막은 파일은 남지 않는다');
  assert.equal(existsSync(join(root, '밖')), false);
});

test('지시창: 올린 파일 경로를 지시문 끝에 붙인다(메일 첨부로 읽히지 않는 머리말)', () => {
  assert.equal(withUploads('프로필 작성해 줘', []), '프로필 작성해 줘');
  const prompt = withUploads('프로필 작성해 줘', ['보관함/업로드/2026-11-12/a.docx', '보관함/업로드/2026-11-12/b 파일.docx']);
  assert.equal(prompt, '프로필 작성해 줘\n\n[업로드한 파일]\n- 보관함/업로드/2026-11-12/a.docx\n- 보관함/업로드/2026-11-12/b 파일.docx');
  assert.doesNotMatch(prompt, /첨부/);
});
