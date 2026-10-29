// 프로그램 레포·작업 공간 경로와 날짜 계산 공용 함수
// 프로그램 레포: 코드·프리셋·템플릿·훅 스크립트. 작업 공간(workspace): 회사 데이터(org/·outputs/·.office/)와 AI 실행 위치.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_ENV = 'AI_OFFICE_WORKSPACE';
// 예전 이름(테스트·내부 실행용 데이터 위치 지정). 사용자 셸의 AI_OFFICE_WORKSPACE가 테스트의 임시 작업 공간을
// 덮지 않도록 가장 앞 순위로 받는다. 사용자는 AI_OFFICE_WORKSPACE를 쓴다
export const LEGACY_ROOT_ENV = 'AI_OFFICE_ROOT';
// 프로그램 레포의 Git 제외 파일. --workspace로 고른 작업 공간을 기억한다
export const LOCAL_CONFIG = '.office-local.json';
// 작업 공간 표식 파일. 훅이 CLAUDE_PROJECT_DIR가 AI Office 작업 공간인지 판정할 때 쓴다
export const WORKSPACE_MARKER = '.ai-office-workspace';
export const DEFAULT_WORKSPACE_NAME = 'AIOffice';
// 예전 버전이 프로그램 레포 안에 두던 회사 데이터(작업 공간 이전 대상). kind: file | dir
export const LEGACY_ITEMS = [
  { rel: 'org/departments.json', kind: 'file' },
  { rel: 'org/roster.json', kind: 'file' },
  { rel: 'org/company.md', kind: 'file' },
  { rel: 'org/company.json', kind: 'file' },
  { rel: 'outputs', kind: 'dir' },
  { rel: '.office', kind: 'dir' },
  { rel: '.claude/agents', kind: 'dir' },
  { rel: '.codex/agents', kind: 'dir' },
];
// 이 항목이 있으면 "예전 회사 데이터가 레포 안에 있다"로 본다. .office만 있는 경우(레포에서 연 개발용 세션의 이벤트)는 세지 않는다
const LEGACY_DATA_ITEMS = LEGACY_ITEMS.filter((i) => i.rel !== '.office');

const HERE_PROGRAM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 프로그램 레포 루트(이 파일 위치 기준). 환경변수로 바꾸지 않는다
export function programRoot() {
  return HERE_PROGRAM_ROOT;
}

// 예전 이름(프로그램 레포 루트). 데이터 위치는 workspaceRoot()를 쓴다
export const repoRoot = programRoot;

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// 기본 작업 공간: ~/AIOffice (Windows는 %USERPROFILE%\AIOffice)
export function defaultWorkspace({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir;
  return pathFor(platform).join(home, DEFAULT_WORKSPACE_NAME);
}

export class WorkspaceError extends Error {}

function readLocalConfig(program) {
  const file = join(program, LOCAL_CONFIG);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (err) {
    throw new WorkspaceError(`${LOCAL_CONFIG}을 읽을 수 없습니다(${err.message}). 파일을 고치거나 지운 뒤 다시 실행하세요.`);
  }
}

// 심볼릭 링크를 푼 경로. 아직 없는 경로는 있는 상위 폴더까지 풀고 나머지를 붙인다
export function realish(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realish(parent), path.basename(p));
  }
}

// child가 parent와 같거나 그 안에 있는가(platform이 win32면 대소문자 무시)
export function isInside(parent, child, platform = process.platform) {
  const P = pathFor(platform);
  const rel = P.relative(parent, child);
  if (rel === '') return true;
  if (platform === 'win32' && /^[a-z]:/i.test(rel)) return false; // 다른 드라이브
  return !rel.startsWith('..') && !P.isAbsolute(rel);
}

// 작업 공간 경로 검사. 프로그램 레포와 같거나 그 안·그 상위면 오류(데이터가 레포에 섞이고 보호 가드·codex 쓰기 범위가 레포를 덮는다)
export function checkWorkspacePath(ws, program, platform = process.platform) {
  const a = platform === process.platform ? realish(ws) : ws;
  const b = platform === process.platform ? realish(program) : program;
  if (isInside(b, a, platform)) {
    throw new WorkspaceError(`작업 공간(${ws})이 프로그램 폴더(${program}) 안에 있습니다. 프로그램 폴더 밖의 경로를 지정하세요(예: ${defaultWorkspace({ platform })}).`);
  }
  if (isInside(a, b, platform)) {
    throw new WorkspaceError(`작업 공간(${ws})이 프로그램 폴더(${program})를 품고 있습니다. AI 직원이 프로그램을 고칠 수 없도록 프로그램 폴더를 포함하지 않는 경로를 지정하세요.`);
  }
}

// 프로그램 레포 안에 예전 회사 데이터가 있는가. 반환: 있는 항목의 상대경로 목록(이전 대상 전체, .office 포함)
export function legacyItems(program = programRoot()) {
  const present = (item) => {
    const abs = join(program, ...item.rel.split('/'));
    if (!existsSync(abs)) return false;
    if (item.kind === 'file') return true;
    try {
      return readdirSync(abs).length > 0;
    } catch {
      return false;
    }
  };
  if (!LEGACY_DATA_ITEMS.some(present)) return [];
  return LEGACY_ITEMS.filter(present).map((i) => i.rel);
}

/**
 * 작업 공간 결정. 우선순위: (테스트·내부용 AI_OFFICE_ROOT) > AI_OFFICE_WORKSPACE > --workspace > .office-local.json > (레포 안 예전 데이터 → 호환 모드) > 기본값.
 * 반환: { path, source: 'env'|'arg'|'local'|'compat'|'default', compat, legacy:[상대경로] }
 * compat: 사용자가 따로 고르지 않았고 레포 안에 예전 데이터가 있어 프로그램 레포를 그대로 데이터 위치로 쓰는 호환 모드
 */
export function resolveWorkspace({ env = process.env, workspace = null, platform = process.platform, homedir = os.homedir(), program = programRoot(), cwd = process.cwd(), allowCompat = true } = {}) {
  const P = pathFor(platform);
  const legacy = legacyItems(program);
  let source = null;
  let raw = null;
  if (env[LEGACY_ROOT_ENV]) [source, raw] = ['env', env[LEGACY_ROOT_ENV]];
  else if (env[WORKSPACE_ENV]) [source, raw] = ['env', env[WORKSPACE_ENV]];
  else if (workspace) [source, raw] = ['arg', workspace];
  else {
    const local = readLocalConfig(program);
    if (local && local.workspace !== undefined) {
      if (typeof local.workspace !== 'string' || !local.workspace.trim()) throw new WorkspaceError(`${LOCAL_CONFIG}의 workspace 값이 올바르지 않습니다.`);
      [source, raw] = ['local', local.workspace];
    }
  }
  if (!source && allowCompat && legacy.length) {
    return { path: program, source: 'compat', compat: true, legacy };
  }
  if (!source) [source, raw] = ['default', defaultWorkspace({ platform, env, homedir })];
  const base = source === 'local' ? program : cwd;
  const abs = P.resolve(base, String(raw).trim());
  checkWorkspacePath(abs, program, platform);
  return { path: abs, source, compat: false, legacy };
}

// 작업 공간 경로만 필요할 때
export function workspaceRoot(opts) {
  return resolveWorkspace(opts).path;
}

// --workspace로 고른 경로를 프로그램 레포의 .office-local.json에 기억한다
export function saveLocalWorkspace(ws, program = programRoot()) {
  const file = join(program, LOCAL_CONFIG);
  const tmp = `${file}.${process.pid}.tmp`;
  const prev = (() => {
    try { return readLocalConfig(program) || {}; } catch { return {}; }
  })();
  writeFileSync(tmp, JSON.stringify({ ...prev, workspace: ws }, null, 2) + '\n');
  renameWithRetry(tmp, file);
}

// 출처 설명(doctor·화면 표시용)
export const WORKSPACE_SOURCE_LABEL = {
  env: `환경변수 ${WORKSPACE_ENV}`,
  arg: '--workspace 옵션',
  local: `${LOCAL_CONFIG}에 기억된 경로`,
  compat: '호환 모드(예전 데이터가 프로그램 폴더 안에 있음)',
  default: '기본값',
};

// 런타임 데이터 폴더(.office). 없으면 만든다.
export function officeDir(root) {
  const dir = join(root, '.office');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 업무 산출물 폴더(outputs). 만들지는 않는다.
export function outputsDir(root) {
  return join(root, 'outputs');
}

// 한국 시간 기준 날짜 YYYY-MM-DD
export function kstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// rename이 Windows에서 EPERM/EBUSY/EACCES로 실패하면 짧은 백오프로 최대 5회 다시 시도한다.
export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { rmSync(from, { force: true }); } catch { /* 임시 파일 정리 실패는 무시 */ }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
