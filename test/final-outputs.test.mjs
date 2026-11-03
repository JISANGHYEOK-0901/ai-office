import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectFinalOutputs, finalOutputSettings, resolveFinalOutput, saveFinalOutputSettings, selectedDeliverables } from '../lib/final-outputs.mjs';
import { startServer } from '../dashboard/server.mjs';
import { saveTasks } from '../lib/tasks.mjs';

const task = '2026-10-30/partner-research';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-final-'));
  const external = mkdtempSync(join(tmpdir(), 'office-final-destination-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await rm(external, { recursive: true, force: true }); });
  const write = (rel, value) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); return path; };
  write(`outputs/${task}/report.md`, `# 결과\n\n검토를 마쳤습니다. [최종 문서](outputs/${task}/dev/page.html#result)`);
  write(`outputs/${task}/research/raw.txt`, '중간 조사 자료');
  write(`outputs/${task}/dev/page.html`, '<!doctype html><html><head><link href="style.css" rel="stylesheet"></head><body>최종 자료<img src="image.svg"></body></html>');
  write(`outputs/${task}/dev/style.css`, 'body { color: black }');
  write(`outputs/${task}/dev/image.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const plan = { stages: [{ id: 'research', output: `outputs/${task}/research/raw.txt`, dependsOn: [] }, { id: 'html', output: `outputs/${task}/dev/page.html`, dependsOn: ['research'] }] };
  return { root, external, write, plan };
}

test('최종산출물/날짜/업무명에는 보고·최종 파일·참조 자산만 모으고 중간 자료는 보존한다', (t) => {
  const f = fixture(t);
  const result = collectFinalOutputs(f.root, { task, title: '제휴 업체 조사', plan: f.plan });
  assert.equal(result.directory, join(f.root, '최종산출물', '2026-10-30', '제휴 업체 조사--partner-research'));
  assert.deepEqual(result.files.map((f) => f.rel).sort(), ['dev/image.svg', 'dev/page.html', 'dev/style.css', '비서실장-보고.md'].sort());
  assert.equal(existsSync(join(result.directory, 'research/raw.txt')), false);
  assert.equal(readFileSync(join(f.root, `outputs/${task}/research/raw.txt`), 'utf8'), '중간 조사 자료');
  assert.match(readFileSync(join(result.directory, '비서실장-보고.md'), 'utf8'), /최종 전달 파일/);
  assert.match(readFileSync(join(result.directory, '비서실장-보고.md'), 'utf8'), /\[최종 문서\]\(dev\/page.html#result\)/);
  assert.equal(resolveFinalOutput(f.root, task, 'dev/page.html').real, realpathSync(join(result.directory, 'dev/page.html')));
  assert.deepEqual(selectedDeliverables({ ...f.plan, deliverables: [] }), []);
  assert.throws(() => selectedDeliverables({ ...f.plan, deliverables: ['없는 단계'] }), /단계 산출물/);
});

test('상위 폴더를 지정해 재사용하고 사용자가 수정한 최종 파일을 덮어쓰지 않는다', (t) => {
  const f = fixture(t);
  saveFinalOutputSettings(f.root, f.external);
  assert.equal(finalOutputSettings(f.root).directory, join(f.external, '최종산출물'));
  const first = collectFinalOutputs(f.root, { task, plan: f.plan });
  writeFileSync(join(first.directory, 'dev/page.html'), '사용자 편집');
  f.write(`outputs/${task}/dev/page.html`, '<html>반려 후 개선된 최종본</html>');
  const revised = collectFinalOutputs(f.root, { task, plan: f.plan });
  assert.equal(readFileSync(join(first.directory, 'dev/page.html'), 'utf8'), '사용자 편집');
  const updated = revised.files.find((file) => /page-.*\.html$/.test(file.rel));
  assert.ok(updated); assert.match(readFileSync(join(revised.directory, updated.rel), 'utf8'), /개선된 최종본/);
  assert.equal(collectFinalOutputs(f.root, { task, plan: f.plan }).files.find((file) => /page-.*\.html$/.test(file.rel)).rel, updated.rel);
  assert.throws(() => resolveFinalOutput(f.root, task, '../report.md'), /등록되지/);
  assert.throws(() => saveFinalOutputSettings(f.root, 'relative/path'), /절대 경로/);
  assert.throws(() => saveFinalOutputSettings(f.root, join(f.root, '.office')), /폴더 밖/);
});

test('등록 파일·보고서의 업무 폴더 밖 symlink를 따라 읽거나 전달하지 않는다', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const result = collectFinalOutputs(f.root, { task, plan: f.plan });
  const outside = join(f.external, 'secret.txt'); writeFileSync(outside, '업무와 무관한 파일');
  const dest = join(result.directory, 'dev/page.html'); rmSync(dest); symlinkSync(outside, dest);
  assert.throws(() => resolveFinalOutput(f.root, task, 'dev/page.html'), /경로/);
  const report = join(f.root, `outputs/${task}/report.md`); rmSync(report); symlinkSync(outside, report);
  assert.throws(() => collectFinalOutputs(f.root, { task, plan: f.plan }), /업무 폴더 밖/);
});

test('API는 저장 위치를 검증·보존하고 검토된 옛 업무의 최종 파일을 인증 후 제공한다', async (t) => {
  const f = fixture(t);
  f.write('org/departments.json', '[]'); f.write('org/roster.json', '[]');
  f.write(`outputs/${task}/plan.json`, JSON.stringify(f.plan));
  f.write('.office/tasks.json', '[]'); saveTasks(f.root, [{ id: task, title: '제휴 업체 조사', status: 'review' }]);
  const server = await startServer({ root: f.root, port: 0, quiet: true, connectionBase: join(f.external, 'account-data'),
    env: { ...process.env, CODEX_BIN: join(f.root, 'missing-codex'), CLAUDE_BIN: join(f.root, 'missing-claude') } });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}`;
  const api = (path, options = {}) => fetch(url + path, { ...options, headers: { 'X-Office-Token': server.token, Origin: url, 'Content-Type': 'application/json', ...options.headers } });
  assert.equal((await fetch(url + '/api/company')).status, 403);
  const invalid = await api('/api/company', { method: 'PUT', body: JSON.stringify({ rules: '저장되면 안 됨', finalOutputParent: 'relative/path' }) });
  assert.equal(invalid.status, 400);
  assert.equal((await (await api('/api/company')).json()).rules, '');
  assert.equal((await api('/api/company', { method: 'PUT', body: JSON.stringify({ rules: '', finalOutputParent: f.external }) })).status, 200);
  assert.equal((await (await api('/api/company')).json()).finalOutputs.directory, join(f.external, '최종산출물'));
  const list = await (await api('/api/outputs')).json(); assert.equal(list.outputs[0].finalOutput, true);
  const files = await (await api(`/api/outputs/${encodeURIComponent(task)}/files`)).json();
  assert.equal(files.final.files.length, 4); assert.ok(files.files.some((file) => file.name === 'raw.txt'));
  const html = files.final.files.find((file) => file.name === 'page.html');
  const res = await api('/api/outputs/file?path=' + encodeURIComponent(html.path));
  assert.equal(res.status, 200); assert.match(await res.text(), /최종 자료/);
  assert.equal((await api('/api/outputs/file?path=' + encodeURIComponent(`@final/${task}/../../secret.txt`))).status, 404);
});
