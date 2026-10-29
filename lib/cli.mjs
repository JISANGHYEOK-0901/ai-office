// claude·codex CLI 실행 공용 함수: 실행 파일 탐색(PATH·PATHEXT), 셸 없는 spawn, 프로세스 트리 종료, 모델 인자 검증
import * as child_process from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

// Claude 모델 별칭(직원·부서·작업 지시에서 공통으로 쓴다)
export const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'inherit'];
// 작업 단위로 지정할 수 있는 모델(inherit은 메인 세션 값이라 작업 지시에는 쓰지 않는다)
export const RUN_MODELS = ['haiku', 'sonnet', 'opus'];
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const CODEX_MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/;
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
export const DEFAULT_CODEX_EFFORT = 'max';
export const TOOL_PATTERN = /^[A-Za-z0-9_*().:-]+$/;
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// PATH(와 Windows의 PATHEXT)를 직접 탐색해 실행 파일의 절대경로를 찾는다. 없으면 null
export function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  if (!name) return null;
  const win = platform === 'win32';
  const exts = win
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  const candidates = (base) => {
    if (!win) return [base];
    // 확장자가 이미 붙어 있으면 그대로도 시도한다
    return extname(base) ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e);
  };
  if (name.includes('/') || name.includes('\\') || isAbsolute(name)) {
    return candidates(resolve(name)).find(isFile) ?? null;
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(win ? ';' : delimiter)) {
    if (!dir) continue;
    const found = candidates(join(dir.replace(/^"|"$/g, ''), name)).find(isFile);
    if (found) return found;
  }
  return null;
}

// CLAUDE_BIN/CODEX_BIN 대체를 반영해 실제로 띄울 명령을 정한다.
// 반환: { command, prefixArgs, shell, display }
export function resolveCommand(name, envVar, { env = process.env, platform = process.platform } = {}) {
  const override = env[envVar];
  if (override && /\.(m?js|cjs)$/i.test(override)) {
    // 테스트용 가짜 바이너리: 두 OS에서 같은 방식으로 node가 실행한다
    return { command: process.execPath, prefixArgs: [resolve(override)], shell: false, display: override };
  }
  const wanted = override || name;
  const found = findExecutable(wanted, { env, platform });
  const command = found || wanted;
  // npm 전역 설치 shim(.cmd/.bat)은 Node 20.12+가 셸 없이 실행하지 않는다
  const shell = platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return { command, prefixArgs: [], shell, display: wanted };
}

// cmd.exe 셸로 넘길 인자 따옴표 처리. 인자는 검증된 토큰과 경로뿐이라 공백·따옴표만 다룬다
function quoteForCmd(arg) {
  const s = String(arg);
  return /[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 셸 없이(Windows .cmd만 예외) CLI를 띄운다. POSIX는 프로세스 그룹을 만들기 위해 detached로 띄운다.
export function spawnCli(resolved, args, { cwd, env = process.env, spawnImpl = child_process.spawn, platform = process.platform, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  const fullArgs = [...resolved.prefixArgs, ...args];
  const opts = { cwd, env, stdio, windowsHide: true };
  if (platform !== 'win32') opts.detached = true;
  if (resolved.shell) {
    opts.shell = true;
    return spawnImpl(quoteForCmd(resolved.command), fullArgs.map(quoteForCmd), opts);
  }
  return spawnImpl(resolved.command, fullArgs, opts);
}

// 프로세스 트리 종료. POSIX: 그룹(-pid)에 신호, Windows: taskkill /T /F
export function killTree(child, signal = 'SIGTERM', { platform = process.platform, spawnImpl = child_process.spawn } = {}) {
  const pid = child?.pid;
  if (platform === 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      const k = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on?.('error', () => {});
      return;
    } catch { /* 아래로 */ }
  }
  if (platform !== 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch { /* 그룹이 없으면 자식에게만 */ }
  }
  try { child?.kill?.(signal); } catch { /* 이미 끝남 */ }
}

// stdin으로 프롬프트를 넘기고 닫는다. 자식이 먼저 끝나 EPIPE가 나도 무시한다
export function writePrompt(child, prompt) {
  if (!child?.stdin) return;
  child.stdin.on?.('error', () => {});
  child.stdin.end(prompt);
}

// codex 모델·추론 강도 인자. 우선순위: 환경변수(일회성) > 명시값(부서 설정·CLI 옵션) > 기본값
export function codexModelArgs({ model, effort } = {}, env = process.env) {
  const m = env.OFFICE_CODEX_MODEL || model || DEFAULT_CODEX_MODEL;
  const e = env.OFFICE_CODEX_EFFORT || effort || DEFAULT_CODEX_EFFORT;
  if (!CODEX_MODEL_PATTERN.test(m)) throw new Error(`Codex 모델 이름이 올바르지 않습니다: ${m}`);
  if (!CODEX_EFFORTS.includes(e)) throw new Error(`Codex 추론 강도는 ${CODEX_EFFORTS.join('|')} 중 하나여야 합니다: ${e}`);
  return ['-m', m, '-c', `model_reasoning_effort="${e}"`];
}
