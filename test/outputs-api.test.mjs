// 산출물 API: 목록·파일 목록·파일 미리보기/다운로드·폴더 열기, 조직도 API
// 경로 탈출·심볼릭 링크·토큰·다운로드 헤더·html 미리보기 CSP sandbox
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTML_PREVIEW_CSP, openFolderCommand, startServer } from '../dashboard/server.mjs';

const TASK = '2026-10-29/html-page';
let root;
let outside;
let handle;
let base;
const opened = [];
let symlinks = true;

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* JSON 아님 */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), buf, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const tok = () => ({ 'X-Office-Token': handle.token });
const get = (path) => request('GET', path, { headers: tok() });
const post = (path, body = {}) => request('POST', path, { body, headers: { ...tok(), Origin: base, 'Content-Type': 'application/json' } });
const fileUrl = (p, extra = '') => `/api/outputs/file?path=${encodeURIComponent(p)}${extra}`;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ai-office-outputs-'));
  outside = mkdtempSync(join(tmpdir(), 'ai-office-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE SECRET');
  writeFileSync(join(root, 'secret.txt'), 'ROOT SECRET');
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'dev', name: '개발부', capabilities: ['HTML·웹 문서'] }]));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'dev-2', name: '최대리', department: 'dev' }]));
  const dir = join(root, 'outputs', ...TASK.split('/'));
  mkdirSync(join(dir, 'dev'), { recursive: true });
  mkdirSync(join(dir, 'reviews'), { recursive: true });
  writeFileSync(join(dir, 'brief.md'), '# 브리프');
  writeFileSync(join(dir, 'report.md'), '# 보고서\n완료');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ version: 1, goal: 'g', stages: [{ id: 's', title: 't', dept: 'dev', agent: 'dev-2' }] }));
  writeFileSync(join(dir, 'dev', 'index.html'), '<!doctype html><script>alert(1)</script><h1>hi</h1>');
  writeFileSync(join(dir, 'dev', '보고서 최종.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
  writeFileSync(join(dir, 'dev', 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
  writeFileSync(join(dir, 'reviews', 'fact-checker.md'), 'VERDICT: BLOCK\n- 숫자 오류');
  mkdirSync(join(root, '.office'), { recursive: true });
  writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify([{ id: TASK, title: 'HTML 페이지', status: 'review', created: '2026-10-29T01:00:00.000Z' }]));
  try {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'dev', 'leak.txt'));
    symlinkSync(outside, join(dir, 'leakdir'), 'dir');
    symlinkSync(join(dir, 'report.md'), join(dir, 'dev', 'report-link.md'));
  } catch {
    symlinks = false; // Windows에서 심볼릭 링크 권한이 없으면 해당 검사만 건너뛴다
  }
  handle = await startServer({ root, port: 0, quiet: true, publicDir: join(root, 'public'), openFolder: (p) => opened.push(p) });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('토큰 없으면 산출물 API 403, 폴더 열기는 Origin도 필요', async () => {
  for (const p of ['/api/outputs', `/api/outputs/${TASK}/files`, fileUrl(`${TASK}/report.md`)]) {
    assert.equal((await request('GET', p)).status, 403, p);
  }
  assert.equal((await request('POST', `/api/outputs/${TASK}/open`, { body: {}, headers: { ...tok(), 'Content-Type': 'application/json' } })).status, 403);
  assert.equal(opened.length, 0);
});

test('GET /api/outputs: 업무별 제목·상태·판정·참여 부서·보고서/계획표 여부', async () => {
  const r = await get('/api/outputs');
  assert.equal(r.status, 200);
  const [o] = r.json.outputs;
  assert.equal(o.id, TASK);
  assert.equal(o.title, 'HTML 페이지');
  assert.equal(o.status, 'review');
  assert.equal(o.hasReport, true);
  assert.equal(o.hasPlan, true);
  assert.equal(o.hasMeeting, false);
  assert.deepEqual(o.verdicts, { 'fact-checker': 'BLOCK' });
  assert.ok(o.depts.includes('dev'));
  assert.ok(!o.depts.includes('reviews'));
});

test('GET /api/outputs/:taskId/files: 그룹·종류, 밖을 가리키는 심볼릭 링크는 목록에서 뺀다', async () => {
  for (const p of [`/api/outputs/${TASK}/files`, `/api/outputs/${encodeURIComponent(TASK)}/files`]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const byName = Object.fromEntries(r.json.files.map((f) => [f.name, f]));
    assert.equal(byName['report.md'].group, 'report');
    assert.equal(byName['plan.json'].group, 'plan');
    assert.equal(byName['fact-checker.md'].group, 'reviews');
    assert.equal(byName['index.html'].group, 'dev');
    assert.equal(byName['index.html'].kind, 'html');
    assert.equal(byName['report.md'].kind, 'text');
    assert.equal(byName['보고서 최종.pdf'].kind, 'binary');
    assert.equal(byName['index.html'].path, `${TASK}/dev/index.html`);
    if (symlinks) {
      assert.ok(!byName['leak.txt'], '밖을 가리키는 파일 링크는 숨긴다');
      assert.ok(!r.json.files.some((f) => f.path.includes('leakdir')), '밖을 가리키는 폴더 링크는 따라가지 않는다');
      assert.ok(byName['report-link.md'], 'outputs 안을 가리키는 링크는 보여준다');
    }
  }
  assert.equal((await get('/api/outputs/2026-10-29/none/files')).status, 404);
  assert.equal((await get('/api/outputs/..%2F..%2Fetc/files')).status, 400);
});

test('경로 탈출은 400: 상위 경로, outputs/ 접두 뒤 상위, 절대경로, NUL, 빈 값', async () => {
  for (const p of ['../secret.txt', `${TASK}/../../../secret.txt`, 'outputs/../secret.txt', join(root, 'secret.txt'), '']) {
    const r = await get(fileUrl(p));
    assert.equal(r.status, 400, p);
    assert.doesNotMatch(r.text, /SECRET/);
  }
  assert.equal((await get('/api/outputs/file?path=a%00b')).status, 400);
  assert.equal((await get(fileUrl(`${TASK}/none.md`))).status, 404);
  assert.equal((await get(fileUrl(`${TASK}/dev`))).status, 400, '폴더는 파일이 아니다');
});

test('심볼릭 링크: outputs 밖을 가리키면 400, 안을 가리키면 허용', { skip: !symlinks && 'symlink 불가 환경' }, async () => {
  const leak = await get(fileUrl(`${TASK}/dev/leak.txt`));
  assert.equal(leak.status, 400);
  assert.doesNotMatch(leak.text, /OUTSIDE SECRET/);
  assert.equal((await get(fileUrl(`${TASK}/leakdir/secret.txt`))).status, 400);
  const inside = await get(fileUrl(`${TASK}/dev/report-link.md`));
  assert.equal(inside.status, 200);
  assert.match(inside.text, /보고서/);
});

test('텍스트 미리보기는 text/plain, html은 CSP sandbox(스크립트 비허용), as=text는 소스', async () => {
  const md = await get(fileUrl(`outputs/${TASK}/report.md`));
  assert.equal(md.status, 200);
  assert.equal(md.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(md.headers['cache-control'], 'no-store');
  assert.equal(md.headers['x-content-type-options'], 'nosniff');
  assert.match(md.text, /# 보고서/);
  const json = await get(fileUrl(`${TASK}/plan.json`));
  assert.equal(json.headers['content-type'], 'text/plain; charset=utf-8', 'json도 실행되지 않게 text/plain');

  const html = await get(fileUrl(`${TASK}/dev/index.html`));
  assert.equal(html.status, 200);
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
  const csp = html.headers['content-security-policy'];
  assert.equal(csp, HTML_PREVIEW_CSP);
  assert.match(csp, /^sandbox(;|$)/);
  assert.doesNotMatch(csp, /allow-scripts/);
  assert.match(csp, /default-src 'none'/);
  assert.equal(html.headers['x-frame-options'], 'DENY');
  const src = await get(fileUrl(`${TASK}/dev/index.html`, '&as=text'));
  assert.equal(src.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(src.headers['content-security-policy'], undefined);
  assert.match(src.text, /<script>/);
});

test('다운로드: 바이너리와 download=1은 attachment(한글 파일명 RFC 5987), 큰 파일 미리보기는 413', async () => {
  const pdf = await get(fileUrl(`${TASK}/dev/보고서 최종.pdf`));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/octet-stream');
  const cd = pdf.headers['content-disposition'];
  assert.match(cd, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.ok(cd.includes(encodeURIComponent('보고서 최종.pdf')));
  assert.equal(pdf.headers['content-length'], '6');
  assert.deepEqual([...pdf.buf], [0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
  const dl = await get(fileUrl(`${TASK}/report.md`, '&download=1'));
  assert.match(dl.headers['content-disposition'], /attachment; filename="report\.md"/);
  const big = await get(fileUrl(`${TASK}/dev/big.txt`));
  assert.equal(big.status, 413);
  const bigDl = await get(fileUrl(`${TASK}/dev/big.txt`, '&download=1'));
  assert.equal(bigDl.status, 200);
  assert.equal(bigDl.buf.length, 5 * 1024 * 1024 + 1);
});

test('POST /api/outputs/:taskId/open: 실제 경로로 폴더 열기 함수 호출, 없는 업무 404, 잘못된 id 400', async () => {
  const r = await post(`/api/outputs/${TASK}/open`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.path, `outputs/${TASK}/`);
  assert.deepEqual(opened, [realpathSync(join(root, 'outputs', ...TASK.split('/')))]);
  assert.equal((await post('/api/outputs/2026-10-29/none/open')).status, 404);
  assert.equal((await post('/api/outputs/..%2F..%2Fx/open')).status, 400);
  assert.equal(opened.length, 1);
});

test('폴더 열기 명령: 플랫폼별 인자 배열', () => {
  assert.deepEqual(openFolderCommand('/a b/c', 'darwin'), { command: 'open', args: ['/a b/c'] });
  assert.deepEqual(openFolderCommand('C:\\x y\\z', 'win32'), { command: 'explorer', args: ['C:\\x y\\z'] });
  assert.deepEqual(openFolderCommand('/a', 'linux'), { command: 'xdg-open', args: ['/a'] });
});

test('GET /api/orgmap: 현재 조직도 Markdown', async () => {
  const r = await request('GET', '/api/orgmap');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(r.text, /### 개발부 \(`dev`\)/);
  assert.match(r.text, /`dev-2` · 최대리/);
});

test('state: plan.json이 있으면 업무에 계획표 단계와 사용자 확인 대기 attention', async () => {
  const r = await request('GET', '/api/state');
  const task = r.json.tasks.find((t) => t.id === TASK);
  assert.deepEqual(task.plan.stages.map((p) => [p.id, p.status]), [['s', 'pending']]);
  assert.equal(task.plan.goal, 'g');
  assert.equal(task.stage, 'user');
  assert.deepEqual(r.json.attention.map((a) => a.kind), ['approve']);
});
