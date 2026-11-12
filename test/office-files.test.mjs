import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentDiff, documentPreview, formulasWithoutValue, officeGuide, officeIssues, officeKind, officeNotices, previewDirectory } from '../lib/office-files.mjs';
import { findSoffice, renderDocument } from '../lib/doc-preview.mjs';
import { outputIssues } from '../lib/work-result.mjs';

const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs'), docx = require('docx'), ExcelJS = require('exceljs'), JSZip = require('jszip');
const { addChart } = require('../lib/xlsx-chart.cjs');

const dir = (t) => { const d = mkdtempSync(join(tmpdir(), 'office-files-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
async function makeXlsx(file, { result = 3 } = {}) {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('매출 표');
  ws.addRow(['월', '값']); ws.addRow(['1월', 1]); ws.addRow(['2월', 2]);
  ws.getCell('A4').value = '합계';
  ws.getCell('B4').value = result === null ? { formula: 'SUM(B2:B3)' } : { formula: 'SUM(B2:B3)', result };
  await book.xlsx.writeFile(file);
}

test('문서 검사: 라이브러리로 만든 PPT·Word·Excel은 통과한다', async (t) => {
  const d = dir(t);
  const deck = new PptxGenJS(); deck.addSlide().addText('한글 제목', { x: 1, y: 1, w: 5, h: 1 });
  await deck.writeFile({ fileName: join(d, 'a.pptx') });
  const word = new docx.Document({ sections: [{ children: [new docx.Paragraph('한글 본문')] }] });
  writeFileSync(join(d, 'a.docx'), await docx.Packer.toBuffer(word));
  await makeXlsx(join(d, 'a.xlsx'));
  for (const name of ['a.pptx', 'a.docx', 'a.xlsx']) assert.deepEqual(outputIssues(name, readFileSync(join(d, name))), [], name);
});

test('문서 검사: 손상·빈 파일과 확장자만 바꾼 파일을 잡는다', async (t) => {
  const d = dir(t);
  await makeXlsx(join(d, 'a.xlsx'));
  const good = readFileSync(join(d, 'a.xlsx'));
  assert.match(outputIssues('a.xlsx', good.subarray(0, good.length / 2))[0], /손상/, '잘린 파일');
  assert.match(outputIssues('a.pptx', Buffer.from('글자만 있는 파일'))[0], /손상/, '확장자만 바꾼 파일');
  assert.match(outputIssues('a.docx', good)[0], /손상/, 'Excel을 docx로 이름만 바꿈');
  assert.match(outputIssues('a.pdf', Buffer.from('아님'))[0], /PDF/);
  assert.deepEqual(outputIssues('a.pdf', Buffer.from('%PDF-1.7 내용')), []);
  const empty = new docx.Document({ sections: [{ children: [new docx.Paragraph('')] }] });
  assert.match(outputIssues('a.docx', await docx.Packer.toBuffer(empty))[0], /본문이 없습니다/);
  const noSlides = new JSZip(); noSlides.file('[Content_Types].xml', '<x/>'); noSlides.file('ppt/presentation.xml', '<x/>');
  assert.match(outputIssues('a.pptx', await noSlides.generateAsync({ type: 'nodebuffer' }))[0], /슬라이드/);
  assert.deepEqual(outputIssues('a.md', Buffer.from('내용')), [], '다른 형식은 그대로');
});

test('Excel 수식 계산값: 없으면 한 번 다시 시키고, 있으면 통과한다', async (t) => {
  const d = dir(t);
  await makeXlsx(join(d, 'with.xlsx'));
  await makeXlsx(join(d, 'without.xlsx'), { result: null });
  assert.equal(formulasWithoutValue(readFileSync(join(d, 'with.xlsx'))), 0);
  assert.equal(formulasWithoutValue(readFileSync(join(d, 'without.xlsx'))), 1);
  assert.deepEqual(officeNotices(join(d, 'with.xlsx'), { previewTool: false }), []);
  assert.match(officeNotices(join(d, 'without.xlsx'), { previewTool: false })[0], /수식 1개에 계산값/);
});

test('화면 확인 기록: 파일보다 새 이미지가 있어야 하고, 도구가 없으면 요구하지 않는다', async (t) => {
  const d = dir(t), file = join(d, 'a.xlsx');
  await makeXlsx(file);
  assert.match(officeNotices(file)[0], /화면으로 확인한 기록이 없습니다/);
  assert.deepEqual(officeNotices(file, { previewTool: false }), []);
  const preview = previewDirectory(file);
  mkdirSync(preview);
  writeFileSync(join(preview, 'page-1.png'), 'x');
  const now = new Date();
  utimesSync(file, now, now); utimesSync(join(preview, 'page-1.png'), new Date(now.getTime() + 5000), new Date(now.getTime() + 5000));
  assert.deepEqual(officeNotices(file), []);
  utimesSync(file, new Date(now.getTime() + 60000), new Date(now.getTime() + 60000));
  assert.match(officeNotices(file)[0], /화면으로 확인한 기록이 없습니다/, '파일을 고친 뒤에는 다시 확인한다');
});

test('Excel 차트 도우미: 차트를 넣어도 수식·값이 남고 파일이 열리며, 두 번째 차트도 들어간다', async (t) => {
  const d = dir(t), file = join(d, 'c.xlsx');
  await makeXlsx(file);
  await addChart(file, { sheet: '매출 표', type: 'line', title: '월별 <값>', categories: 'A2:A3', series: [{ name: '값', values: 'B2:B3' }] });
  await addChart(file, { sheet: '매출 표', type: 'pie', categories: 'A2:A3', series: [{ name: '값', values: 'B2:B3' }], from: { col: 7, row: 22 }, to: { col: 15, row: 40 } });
  const content = readFileSync(file);
  assert.deepEqual(outputIssues('c.xlsx', content), []);
  assert.equal(formulasWithoutValue(content), 0);
  const zip = await JSZip.loadAsync(content);
  const chart = await zip.file('xl/charts/chart1.xml').async('string');
  assert.match(chart, /월별 &lt;값&gt;/);
  assert.match(chart, /'매출 표'!\$B\$2:\$B\$3/);
  assert.match(chart, /<c:v>2<\/c:v>/, '숫자 캐시');
  assert.ok(zip.file('xl/charts/chart2.xml'));
  assert.equal((await zip.file('xl/drawings/drawing1.xml').async('string')).match(/twoCellAnchor>/g).length, 4, '앵커 2개(여닫는 태그)');
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.equal(sheet.match(/<drawing /g).length, 1);
  assert.ok(sheet.indexOf('<pageMargins') < sheet.indexOf('<drawing '), '표준 요소 순서');
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.match(types, /charts\/chart2\.xml/);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.readFile(file);
  assert.deepEqual(reopened.getWorksheet('매출 표').getCell('B4').value, { formula: 'SUM(B2:B3)', result: 3 });
  await assert.rejects(addChart(file, { sheet: '없는 시트', categories: 'A2:A3', series: [{ name: '값', values: 'B2:B3' }] }), /시트를 찾을 수 없습니다/);
  await assert.rejects(addChart(file, { type: 'radar', categories: 'A2:A3', series: [{ name: '값', values: 'B2:B3' }] }), /차트 종류/);
});

test('직원 안내: 문서 형식에 맞는 도구를 알려 주고 다른 형식에는 넣지 않는다', () => {
  const program = '/p r/office';
  assert.equal(officeGuide({ output: 'a.md', program }), '');
  const excel = officeGuide({ output: 'outputs/t/a.xlsx', program });
  assert.match(excel, /Python 패키지를 설치하지 말고/);
  assert.match(excel, /formula: 'SUM/);
  assert.match(excel, /xlsx-chart\.cjs/);
  assert.match(excel, /render-doc\.mjs/);
  assert.match(excel, /"outputs\/t\/a\.xlsx"/);
  assert.doesNotMatch(officeGuide({ output: 'a.pptx', program }), /xlsx-chart/);
  assert.match(officeGuide({ output: 'a.docx', program }), /원본은 그대로 두고/);
  assert.deepEqual(['a.PPTX', 'a.docx', 'a.xlsx', 'a.txt'].map(officeKind), ['PowerPoint', 'Word', 'Excel', '']);
});

test('화면 확인 명령: 도구가 없으면 알리고, 변환 실패와 성공을 구분한다', (t) => {
  const d = dir(t), file = join(d, 'a.docx');
  writeFileSync(file, 'x');
  const none = { PATH: '' };
  assert.equal(findSoffice({ env: { SOFFICE_BIN: join(d, '없음') } }), '');
  const noTool = renderDocument(file, { env: { SOFFICE_BIN: join(d, '없음') } });
  assert.equal(noTool.status, 'no-tool');
  assert.match(noTool.message, /화면 미확인/);
  assert.equal(renderDocument(join(d, '없는파일.docx'), { env: none }).status, 'failed');
  const fake = join(d, 'soffice'); writeFileSync(fake, '');
  const failed = renderDocument(file, { env: { SOFFICE_BIN: fake, PATH: '' }, platform: 'linux', run: () => ({ status: 1 }) });
  assert.equal(failed.status, 'failed');
  const made = renderDocument(file, { env: { SOFFICE_BIN: fake, PATH: '' }, platform: 'linux', run: (cmd, args) => {
    writeFileSync(join(args[args.indexOf('--outdir') + 1], 'a.png'), 'x'); return { status: 0 };
  } });
  assert.equal(made.status, 'ok');
  assert.equal(made.images.length, 1);
  assert.match(made.message, /첫 페이지만/);
});

test('문서 대조: 바뀐 글자·값만 찾고, 크게 지워지면 표시한다', async (t) => {
  const d = dir(t);
  const word = async (lines) => docx.Packer.toBuffer(new docx.Document({ sections: [{ children: lines.map((l) => new docx.Paragraph(l)) }] }));
  const before = await word(['2026년 공지', '점검 안내입니다.', '메일을 쓸 수 없습니다.']);
  const small = documentDiff(before, await word(['2027년 공지', '점검 안내입니다.', '메일을 쓸 수 없습니다.', '담당자: [확인 필요]']), 'Word');
  assert.deepEqual([small.removed, small.added, small.large], [['2026년 공지'], ['2027년 공지', '담당자: [확인 필요]'], false]);
  const many = Array.from({ length: 10 }, (_, i) => `문단 ${i}`);
  assert.equal(documentDiff(await word(many), await word(many.slice(0, 2)), 'Word').large, true);

  await makeXlsx(join(d, 'a.xlsx'));
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(join(d, 'a.xlsx'));
  const ws = book.worksheets[0];
  ws.getCell('B2').value = 10;
  ws.getCell('A5').value = '평균';
  await book.xlsx.writeFile(join(d, 'b.xlsx'));
  const cells = documentDiff(readFileSync(join(d, 'a.xlsx')), readFileSync(join(d, 'b.xlsx')), 'Excel');
  assert.deepEqual(cells.removed, ['B2: 1']);
  assert.deepEqual(cells.added.sort(), ['A5: 평균', 'B2: 10']);

  const deck = async (titles) => { const p = new PptxGenJS(); for (const x of titles) p.addSlide().addText(x, { x: 1, y: 1, w: 5, h: 1 }); return Buffer.from(await p.write({ outputType: 'nodebuffer' })); };
  const slides = documentDiff(await deck(['표지', '일정']), await deck(['표지', '2027 일정', '담당자']), 'PowerPoint');
  assert.deepEqual([slides.removed, slides.added], [['일정'], ['2027 일정', '담당자']]);
});

test('계획용 문서 미리보기: 글자를 순서대로 보여 주고 연락처 칸·메일·긴 숫자는 가린다', async () => {
  // 회사 양식처럼 라벨 칸 다음에 값 칸이 오는 표
  const cell = (text) => new docx.TableCell({ children: [new docx.Paragraph(text)] });
  const row = (...texts) => new docx.TableRow({ children: texts.map(cell) });
  const table = new docx.Table({ rows: [
    row('아호(예명)', '가상별', '상담 스타일', '현실적이에요, 공감해요'),
    row('휴대폰 번호', '010-1234-5678', '연결 전화번호', '010 1234 5678'),
    row('이메일', 'rima@example.com'),
    row('주소', '서울시 가상구 가상로 12'),
    row('계좌번호', '은행명 : 가상은행 계좌번호: 123-456-789012 계좌주명 : 홍길동'),
  ] });
  const word = new docx.Document({ sections: [{ children: [new docx.Paragraph('상담사 프로필 소개서'), table, new docx.Paragraph('안녕하세요, 상담사 가상별입니다. 문의는 help@example.com')] }] });
  const preview = documentPreview(await docx.Packer.toBuffer(word), 'a.docx');
  assert.match(preview, /상담사 프로필 소개서\n아호\(예명\)\n가상별\n상담 스타일\n현실적이에요, 공감해요/);
  assert.match(preview, /휴대폰 번호\n\[가림\]\n연결 전화번호\n\[가림\]\n이메일\n\[가림\]\n주소\n\[가림\]\n계좌번호\n\[가림\]/);
  assert.match(preview, /상담사 가상별입니다\. 문의는 \[메일\]/);
  for (const secret of ['010', '1234', 'rima@', '가상로', '123-456', '홍길동']) assert.ok(!preview.includes(secret), secret);
  // 값이 빈 칸이면 다음 라벨을 가리지 않는다
  const empty = new docx.Document({ sections: [{ children: [new docx.Table({ rows: [row('휴대폰 번호', ''), row('이메일', 'x@y.kr')] })] }] });
  assert.equal(documentPreview(await docx.Packer.toBuffer(empty), 'b.docx'), '휴대폰 번호\n이메일\n[가림]');
  assert.equal(documentPreview(Buffer.from('글자'), 'c.txt'), '', 'Office 문서가 아니면 비운다');
  assert.equal(documentPreview(Buffer.from('깨진 파일'), 'd.docx'), '', '열 수 없으면 비운다');
  const long = new docx.Document({ sections: [{ children: Array.from({ length: 200 }, (_, i) => new docx.Paragraph(`문단 ${i}번 내용입니다`)) }] });
  const cut = documentPreview(await docx.Packer.toBuffer(long), 'e.docx', { maxChars: 100 });
  assert.equal(cut.length, 101);
  assert.ok(cut.endsWith('…'));
});
