// PowerPoint·Word·Excel·PDF 산출물의 코드 검사와 직원 안내. AI 호출 없이 파일 구조만 본다(내용의 옳고 그름은 최종 검토가 본다).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const KINDS = { '.pptx': 'PowerPoint', '.docx': 'Word', '.xlsx': 'Excel' };

export const officeKind = (path) => KINDS[extname(String(path)).toLowerCase()] || '';

// ZIP 끝의 목차를 읽는다. 잘린 파일이면 null
function readZip(buf) {
  for (let end = buf.length - 22; end >= 0 && end >= buf.length - 22 - 65535; end--) {
    if (buf.readUInt32LE(end) !== 0x06054b50) continue;
    const entries = new Map();
    let at = buf.readUInt32LE(end + 16);
    for (let i = 0, count = buf.readUInt16LE(end + 10); i < count; i++) {
      if (buf.readUInt32LE(at) !== 0x02014b50) return null;
      const nameLength = buf.readUInt16LE(at + 28);
      entries.set(buf.toString('utf8', at + 46, at + 46 + nameLength), { method: buf.readUInt16LE(at + 10), size: buf.readUInt32LE(at + 20), offset: buf.readUInt32LE(at + 42) });
      at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    }
    return entries;
  }
  return null;
}

function readEntry(buf, { method, size, offset }) {
  if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error('잘못된 항목');
  const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
  const data = buf.subarray(start, start + size);
  return (method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }) : data).toString('utf8');
}

const names = (zip, pattern) => [...zip.keys()].filter((name) => pattern.test(name));

// 열 수 없는 파일을 걸러 낸다. 있으면 다시 만들게 한다
export function officeIssues(path, content) {
  const ext = extname(String(path)).toLowerCase();
  if (ext === '.pdf') return content.subarray(0, 5).toString('latin1') === '%PDF-' ? [] : ['PDF 파일이 아닙니다.'];
  const kind = KINDS[ext];
  if (!kind) return [];
  const broken = [`${kind} 파일이 손상되어 열 수 없습니다. 다시 만드세요.`];
  try {
    const zip = readZip(content);
    if (!zip || !zip.has('[Content_Types].xml')) return broken;
    if (ext === '.pptx') {
      if (!zip.has('ppt/presentation.xml')) return broken;
      const slides = names(zip, /^ppt\/slides\/slide\d+\.xml$/);
      if (!slides.length) return ['슬라이드가 한 장도 없습니다.'];
      for (const slide of slides) readEntry(content, zip.get(slide));
    } else if (ext === '.docx') {
      if (!zip.has('word/document.xml')) return broken;
      if (!/<w:t\b[^>]*>\s*[^<\s]/.test(readEntry(content, zip.get('word/document.xml')))) return ['Word 문서에 본문이 없습니다.'];
    } else {
      if (!zip.has('xl/workbook.xml')) return broken;
      const sheets = names(zip, /^xl\/worksheets\/[^/]+\.xml$/);
      if (!sheets.length) return ['Excel 파일에 시트가 없습니다.'];
      for (const sheet of sheets) readEntry(content, zip.get(sheet));
    }
    return [];
  } catch { return broken; }
}

// 수식에 계산값이 없으면 Excel 밖의 미리보기·휴대폰 뷰어에서 빈칸으로 보인다
export function formulasWithoutValue(content) {
  const zip = readZip(content);
  if (!zip) return 0;
  let missing = 0;
  for (const sheet of names(zip, /^xl\/worksheets\/[^/]+\.xml$/)) {
    for (const [, cell] of readEntry(content, zip.get(sheet)).matchAll(/<c\b[^>]*?(?<!\/)>([\s\S]*?)<\/c>/g)) {
      if (/<f\b/.test(cell) && !/<v>[^<]/.test(cell)) missing++;
    }
  }
  return missing;
}

export const previewDirectory = (file) => join(dirname(file), `preview-${basename(file, extname(file))}`);

function hasFreshPreview(file) {
  const dir = previewDirectory(file);
  if (!existsSync(dir)) return false;
  const made = statSync(file).mtimeMs;
  return readdirSync(dir).some((name) => name.endsWith('.png') && statSync(join(dir, name)).mtimeMs >= made);
}

// 파일은 열리지만 고치면 좋은 점. 한 번 다시 시키고, 그래도 남으면 최종 검토에 알린다
export function officeNotices(file, { previewTool = true } = {}) {
  if (!officeKind(file)) return [];
  const notices = [];
  if (extname(file).toLowerCase() === '.xlsx') {
    const missing = formulasWithoutValue(readFileSync(file));
    if (missing) notices.push(`수식 ${missing}개에 계산값이 저장되지 않았습니다. 미리보기에서 빈칸으로 보이니 {formula, result}로 계산값을 함께 넣으세요.`);
  }
  if (previewTool && !hasFreshPreview(file)) notices.push('완성한 파일을 화면으로 확인한 기록이 없습니다. 화면 확인 명령을 실행하고 나온 이미지를 열어 보세요.');
  return notices;
}

export function officeGuide({ output, program }) {
  const kind = officeKind(output);
  if (!kind) return '';
  const lib = (name) => `require(${JSON.stringify(join(program, 'node_modules', name))})`;
  return [
    `이번 산출물은 ${kind} 파일입니다. Python 패키지를 설치하지 말고 프로그램에 들어 있는 Node 라이브러리를 쓰세요. 스크립트는 출력 파일과 같은 폴더에 .cjs로 두고 node로 실행합니다. 불러오는 법: PowerPoint ${lib('pptxgenjs')}, Word ${lib('docx')}, Excel ${lib('exceljs')}, ZIP 직접 수정 ${lib('jszip')}. 글꼴은 "Malgun Gothic"으로 지정하세요.`,
    kind === 'Excel' ? `Excel: 수식은 { formula: 'SUM(B2:B7)', result: 882 }처럼 스크립트에서 계산한 값을 함께 넣으세요. 인쇄가 잘리지 않게 pageSetup의 fitToPage·fitToWidth:1·fitToHeight:0을 지정하세요. exceljs는 차트를 못 만듭니다. 차트가 필요하면 파일을 저장한 뒤 이렇게 넣으세요: await require(${JSON.stringify(join(program, 'lib', 'xlsx-chart.cjs'))}).addChart(파일경로, { sheet: '시트', type: 'line', title: '제목', categories: 'A2:A13', series: [{ name: '합계', values: 'E2:E13' }], from: { col: 7, row: 1 }, to: { col: 15, row: 20 } }) (type은 line·bar·pie).` : '',
    '기존 파일을 고치는 일이면: 원본은 그대로 두고 출력 경로에 새 파일로 저장합니다. Word·PowerPoint는 jszip으로 해당 XML만 고쳐 나머지 서식을 보존하세요. Excel은 exceljs로 고치되, 원본에 차트·피벗이 있으면 exceljs가 지우므로 jszip으로 XML을 고치세요.',
    `파일을 쓴 뒤 반드시 화면을 확인하세요: node ${JSON.stringify(join(program, 'scripts', 'render-doc.mjs'))} ${JSON.stringify(output)} 나온 이미지를 열어 글자 겹침·잘림·깨진 글자·빈 페이지를 보고, 문제가 있으면 고쳐 다시 확인합니다. 도구가 없다고 나오면 보고에 화면 미확인이라고 적으세요.`,
  ].filter(Boolean).join('\n');
}
