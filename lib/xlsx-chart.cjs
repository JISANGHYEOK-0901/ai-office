// exceljs는 차트를 만들지 못해, 저장한 xlsx에 차트 부품을 직접 넣는다(직원 스크립트가 require로 쓴다).
const fs = require('node:fs');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const FONT = '<a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/>';

function range(ws, ref) {
  const [from, to = from] = ref.replace(/\$/g, '').split(':');
  const parse = (cell) => {
    const m = cell.match(/^([A-Z]+)(\d+)$/i);
    if (!m) throw new Error(`셀 범위가 올바르지 않습니다: ${ref}`);
    return { col: [...m[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0), row: Number(m[2]), letters: m[1].toUpperCase() };
  };
  const a = parse(from), b = parse(to);
  const values = [];
  for (let row = a.row; row <= b.row; row++) for (let col = a.col; col <= b.col; col++) {
    const value = ws.getCell(row, col).value;
    values.push(value && typeof value === 'object' && 'result' in value ? value.result : value);
  }
  return { abs: `'${ws.name.replace(/'/g, "''")}'!$${a.letters}$${a.row}:$${b.letters}$${b.row}`, values };
}

const strRef = ({ abs, values }) => `<c:strRef><c:f>${esc(abs)}</c:f><c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
const numRef = ({ abs, values }) => `<c:numRef><c:f>${esc(abs)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (typeof v === 'number' ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : '')).join('')}</c:numCache></c:numRef>`;
const titleXml = (text) => `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:rPr lang="ko-KR">${FONT}</a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

function chartXml({ type, title, categories, series, xTitle, yTitle }) {
  const ser = series.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>${type === 'line' ? '<c:marker><c:symbol val="circle"/></c:marker>' : ''}<c:cat>${strRef(categories)}</c:cat><c:val>${numRef(s.values)}</c:val>${type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`).join('');
  const axes = '<c:axId val="111111111"/><c:axId val="222222222"/>';
  const plot = type === 'pie' ? `<c:pieChart><c:varyColors val="1"/>${ser}</c:pieChart>`
    : `${type === 'line' ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/>${axes}</c:lineChart>` : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}${axes}</c:barChart>`}`
      + `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${xTitle ? titleXml(xTitle) : ''}<c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
      + `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>${yTitle ? titleXml(yTitle) : ''}<c:numFmt formatCode="#,##0" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace ${NS}><c:chart>${title ? titleXml(title) : ''}<c:autoTitleDeleted val="${title ? 0 : 1}"/><c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

const anchorXml = ({ from, to, id, rel }) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${from.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="차트 ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rel}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
const REL_ROOT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const nextNumber = (zip, pattern) => Math.max(0, ...Object.keys(zip.files).map((n) => Number(n.match(pattern)?.[1] || 0))) + 1;
const addRel = (xml, id, type, target) => xml.replace('</Relationships>', `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`);
const nextRel = (xml) => `rId${Math.max(0, ...[...xml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;

async function addChart(file, { sheet, type = 'line', title = '', categories, series, xTitle = '', yTitle = '', from = { col: 7, row: 1 }, to = { col: 15, row: 20 } }) {
  if (!['line', 'bar', 'pie'].includes(type)) throw new Error('차트 종류는 line·bar·pie 중 하나입니다.');
  if (!categories || !Array.isArray(series) || !series.length) throw new Error('categories와 series를 지정하세요.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const ws = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
  if (!ws) throw new Error(`시트를 찾을 수 없습니다: ${sheet}`);
  const xml = chartXml({ type, title, xTitle, yTitle, categories: range(ws, categories), series: series.map((s) => ({ name: s.name, values: range(ws, s.values) })) });

  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const rid = [...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => ({ name: tag.match(/name="([^"]*)"/)?.[1], id: tag.match(/r:id="([^"]*)"/)?.[1] })).find((s) => s.name === esc(ws.name).replace(/&quot;/g, '&quot;'))?.id;
  const workbookRels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relTag = [...workbookRels.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(`Id="${rid}"`));
  const target = relTag?.match(/Target="([^"]*)"/)?.[1];
  if (!target) throw new Error('시트 파일을 찾을 수 없습니다.');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheetName = sheetPath.split('/').pop();
  const sheetRelsPath = `xl/worksheets/_rels/${sheetName}.rels`;

  const chartNo = nextNumber(zip, /^xl\/charts\/chart(\d+)\.xml$/);
  zip.file(`xl/charts/chart${chartNo}.xml`, xml);
  let types = await zip.file('[Content_Types].xml').async('string');
  types = types.replace('</Types>', `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);

  let sheetXml = await zip.file(sheetPath).async('string');
  let sheetRels = zip.file(sheetRelsPath) ? await zip.file(sheetRelsPath).async('string') : `${REL_ROOT}</Relationships>`;
  const existing = sheetXml.match(/<drawing\b[^>]*r:id="([^"]*)"/)?.[1];
  let drawingNo;
  if (existing) drawingNo = Number([...sheetRels.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(`Id="${existing}"`))?.match(/drawing(\d+)\.xml/)?.[1]);
  else {
    drawingNo = nextNumber(zip, /^xl\/drawings\/drawing(\d+)\.xml$/);
    const relId = nextRel(sheetRels);
    sheetRels = addRel(sheetRels, relId, 'drawing', `../drawings/drawing${drawingNo}.xml`);
    if (!/xmlns:r=/.test(sheetXml.slice(0, 1000))) sheetXml = sheetXml.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    // 표준이 정한 요소 순서를 지켜야 Excel이 복구 창 없이 연다
    const before = sheetXml.search(/<(?:legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/);
    sheetXml = `${sheetXml.slice(0, before)}<drawing r:id="${relId}"/>${sheetXml.slice(before)}`;
    types = types.replace('</Types>', `<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    zip.file(`xl/drawings/drawing${drawingNo}.xml`, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>');
  }
  const drawingPath = `xl/drawings/drawing${drawingNo}.xml`;
  const drawingRelsPath = `xl/drawings/_rels/drawing${drawingNo}.xml.rels`;
  let drawingRels = zip.file(drawingRelsPath) ? await zip.file(drawingRelsPath).async('string') : `${REL_ROOT}</Relationships>`;
  const chartRel = nextRel(drawingRels);
  drawingRels = addRel(drawingRels, chartRel, 'chart', `../charts/chart${chartNo}.xml`);
  const drawing = await zip.file(drawingPath).async('string');
  zip.file(drawingPath, drawing.replace('</xdr:wsDr>', `${anchorXml({ from, to, id: chartNo + 1, rel: chartRel })}</xdr:wsDr>`));
  zip.file(drawingRelsPath, drawingRels);
  zip.file(sheetRelsPath, sheetRels);
  zip.file(sheetPath, sheetXml);
  zip.file('[Content_Types].xml', types);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

module.exports = { addChart };
