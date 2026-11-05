// 문서를 이미지로 바꿔 직원이 눈으로 확인하게 한다. LibreOffice가 있을 때만 동작한다(선택 도구).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewDirectory } from './office-files.mjs';

const TIMEOUT_MS = 90000, MAX_PAGES = 20;

function onPath(names, env, platform) {
  for (const dir of String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return '';
}

export function findSoffice({ env = process.env, platform = process.platform } = {}) {
  if (env.SOFFICE_BIN) return existsSync(env.SOFFICE_BIN) ? env.SOFFICE_BIN : '';
  const known = platform === 'win32'
    ? [join(env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe')]
    : ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice'];
  return onPath(platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice', 'libreoffice'], env, platform) || known.find((p) => existsSync(p)) || '';
}

// 반환: { status: 'ok'|'no-tool'|'failed', images: [경로], message }
export function renderDocument(input, { env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const file = resolve(input);
  if (!existsSync(file)) return { status: 'failed', images: [], message: `파일이 없습니다: ${input}` };
  const soffice = findSoffice({ env, platform });
  if (!soffice) return { status: 'no-tool', images: [], message: '화면 확인 도구(LibreOffice)가 없어 확인하지 못했습니다. 보고에 화면 미확인이라고 적으세요.' };
  const out = previewDirectory(file);
  const work = mkdtempSync(join(tmpdir(), 'office-preview-'));
  try {
    // 동시에 여러 문서를 바꿔도 충돌하지 않게 프로필을 따로 쓴다
    const convert = (format) => run(soffice, [`-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`, '--headless', '--convert-to', format, '--outdir', work, file], { timeout: TIMEOUT_MS, env });
    const name = basename(file, extname(file));
    const pdftoppm = onPath(platform === 'win32' ? ['pdftoppm.exe'] : ['pdftoppm'], env, platform);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    if (pdftoppm) {
      convert('pdf');
      const pdf = join(work, `${name}.pdf`);
      if (!existsSync(pdf)) return { status: 'failed', images: [], message: '파일을 열 수 없습니다. 손상됐는지 확인하세요.' };
      run(pdftoppm, ['-r', '60', '-l', String(MAX_PAGES), '-png', pdf, join(out, 'page')], { timeout: TIMEOUT_MS });
    } else {
      convert('png');
      if (existsSync(join(work, `${name}.png`))) renameSync(join(work, `${name}.png`), join(out, 'page-1.png'));
    }
    const images = readdirSync(out).filter((f) => f.endsWith('.png')).sort().map((f) => join(out, f));
    if (!images.length) return { status: 'failed', images: [], message: '파일을 열 수 없습니다. 손상됐는지 확인하세요.' };
    return { status: 'ok', images, message: pdftoppm ? '' : '첫 페이지만 확인했습니다(pdftoppm이 없음).' };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
