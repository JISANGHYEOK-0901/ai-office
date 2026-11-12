// 대시보드 지시창에서 올린 파일을 작업 공간 보관함/업로드/<날짜>/에 저장한다.
// 덮어쓰지 않고(같은 이름이면 " (2)"), 문서·한글·그림 파일만 받는다. 저장 경로는 지시문에 붙여 비서실장이 읽는다
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { kstDate } from './paths.mjs';

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_EXTS = ['.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt', '.pdf', '.txt', '.md', '.hwp', '.hwpx', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
export const UPLOAD_DIR = ['보관함', '업로드'];
const SECRET_NAME = /^\.|^계정\.env$|\.env(?:\.|$)/i;

const fail = (status, message) => Object.assign(new Error(message), { status });

// 경로·제어 문자를 뺀 파일 이름. 너무 길면 확장자를 두고 앞부분을 줄인다
export function uploadName(raw) {
  const name = String(raw ?? '').normalize('NFC').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') throw fail(400, '파일 이름이 비어 있습니다.');
  if (SECRET_NAME.test(name)) throw fail(400, '숨김 파일·계정 파일은 올릴 수 없습니다.');
  const ext = extname(name).toLowerCase();
  if (!UPLOAD_EXTS.includes(ext)) throw fail(415, `올릴 수 있는 파일은 ${UPLOAD_EXTS.join(' ')}입니다.`);
  const stem = [...name.slice(0, name.length - ext.length)].slice(0, 100).join('').trim();
  if (!stem) throw fail(400, '파일 이름이 비어 있습니다.');
  return stem + ext;
}

// data는 base64(브라우저 FileReader의 data URL에서 앞부분을 뗀 것)
export function saveUpload(root, { name, data } = {}, { now = new Date() } = {}) {
  const fileName = uploadName(name);
  if (typeof data !== 'string' || !data.trim()) throw fail(400, '파일 내용이 없습니다.');
  const compact = data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw fail(400, '파일 내용이 올바른 base64가 아닙니다.');
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length) throw fail(400, '빈 파일은 올릴 수 없습니다.');
  if (bytes.length > UPLOAD_MAX_BYTES) throw fail(413, `파일은 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
  const dir = join(root, ...UPLOAD_DIR, kstDate(now));
  mkdirSync(dir, { recursive: true });
  const ext = extname(fileName), stem = fileName.slice(0, -ext.length);
  for (let i = 1; i < 1000; i++) {
    const target = join(dir, i === 1 ? fileName : `${stem} (${i})${ext}`);
    try {
      writeFileSync(target, bytes, { flag: 'wx' });
      return { path: relative(root, target).split(sep).join('/'), name: basename(target), size: bytes.length };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw fail(409, '같은 이름의 파일이 너무 많습니다. 이름을 바꿔 올려 주세요.');
}
