#!/usr/bin/env node
// Claude 훅 입력(stdin JSON) → .office/events.jsonl 정규화 이벤트 한 줄.
// 어떤 경우에도 종료 코드 0, stdout 무출력, 2초 안에 끝난다(stdout 은 Claude 컨텍스트에 섞인다).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 레포 루트: CLAUDE_PROJECT_DIR(이 레포의 hooks/가 있을 때만), 없으면 이 파일 위치 기준. 셸의 변수 확장에 의존하지 않는다
const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : null;
const ROOT = ENV_ROOT && existsSync(join(ENV_ROOT, 'hooks', 'office-event.mjs')) ? ENV_ROOT : HERE_ROOT;
const STDIN_TIMEOUT_MS = 1500;
const HARD_LIMIT_MS = 1900;

const quit = () => process.exit(0);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);
setTimeout(quit, HARD_LIMIT_MS).unref();

function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    const finish = () => done(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(() => { process.stdin.destroy(); finish(); }, STDIN_TIMEOUT_MS);
    timer.unref();
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

function readSessions(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeSessions(file, map, renameWithRetry) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
  renameWithRetry(tmp, file);
}

// Bash 응답은 {stdout, stderr, ...} 객체지만 문자열로 오는 경우도 받아 준다
function bashStdout(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && typeof response.stdout === 'string') return response.stdout;
  return '';
}

async function main() {
  // 공용 모듈은 동적으로 불러온다. 모듈 로드 실패도 종료 코드 0으로 끝내기 위해서다
  const { appendEvent, extractOfficeTask, normalizeClaudeHook } = await import('../lib/events.mjs');
  const { renameWithRetry } = await import('../lib/paths.mjs');
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (!input || typeof input !== 'object') return;

  const sessionsFile = join(ROOT, '.office', 'sessions.json');
  const sessionsMap = readSessions(sessionsFile);

  // office.mjs task start 결과를 세션에 연결해 이후 이벤트(이번 tool.end 포함)에 task 를 붙인다
  const isPostBash = input.tool_name === 'Bash' && (input.hook_event_name === 'PostToolUse' || 'tool_response' in input);
  if (isPostBash && typeof input.session_id === 'string') {
    const taskId = extractOfficeTask(bashStdout(input.tool_response));
    if (taskId && sessionsMap[input.session_id] !== taskId) {
      sessionsMap[input.session_id] = taskId;
      try { writeSessions(sessionsFile, sessionsMap, renameWithRetry); } catch { /* 기록 실패는 무시 */ }
    }
  }

  const ev = normalizeClaudeHook(input, { sessionsMap });
  if (ev) appendEvent(ROOT, ev);
}

main().catch(() => {}).finally(quit);
