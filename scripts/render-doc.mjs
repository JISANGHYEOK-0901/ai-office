#!/usr/bin/env node
// 문서를 이미지로 바꿔 화면 확인에 쓴다: node scripts/render-doc.mjs <파일>
// 이미지는 파일 옆 preview-<이름>/ 폴더에 만들고 경로를 한 줄씩 출력한다. LibreOffice가 없으면 그 사실만 알리고 정상 종료한다.
import { renderDocument } from '../lib/doc-preview.mjs';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('사용법: node scripts/render-doc.mjs <파일>');
  process.exit(1);
}
const { status, images, message } = renderDocument(file);
for (const image of images) console.log(image);
if (message) console.log(message);
process.exit(status === 'failed' ? 1 : 0);
