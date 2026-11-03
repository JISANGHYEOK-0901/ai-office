#!/usr/bin/env node
// Claude 훅 입력(stdin JSON) → .office/events.jsonl 정규화 이벤트 한 줄.
// 어떤 경우에도 종료 코드 0, stdout 무출력, 2초 안에 끝난다(stdout 은 Claude 컨텍스트에 섞인다).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 실행기가 업무 이벤트를 직접 기록하는 내부 계획·단계 실행은 중복 수집하지 않는다.
// chief-guard와 repo-guard의 권한 검사는 별도 훅이므로 계속 적용된다.
if (process.env.OFFICE_ORCHESTRATOR_CHILD === '1') process.exit(0);

const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : null;
// 데이터 위치: CLAUDE_PROJECT_DIR가 AI Office 작업 공간(표식 .ai-office-workspace)이거나 예전 방식의 레포(hooks/가 있음)면 그곳,
// 아니면 이 파일 위치(프로그램 레포, 호환 모드). 작업 공간 설정의 훅은 프로그램 레포 훅의 절대경로로 불린다
const ROOT = ENV_ROOT && (existsSync(join(ENV_ROOT, '.ai-office-workspace')) || existsSync(join(ENV_ROOT, 'hooks', 'office-event.mjs'))) ? ENV_ROOT : HERE_ROOT;
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

// Bash·PowerShell 응답은 {stdout, stderr, ...} 객체지만(공식 문서: PowerShell은 Bash와 같은 필드) 문자열로 오는 경우도 받아 준다
function shellStdout(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && typeof response.stdout === 'string') return response.stdout;
  return '';
}

const SHELL_TOOLS = ['Bash', 'PowerShell'];

// 세션 → 업무 연결은 이 세션이 실제로 `node scripts/office.mjs task start …`를 단독 실행했고, 출력의 업무 id가
// 형식에 맞으며 tasks.json에 등록돼 있을 때만 한다. 테스트 파일을 cat·grep한 출력에 OFFICE_TASK=가 보여도 연결하지 않는다
async function linkedTask(input) {
  if (!SHELL_TOOLS.includes(input.tool_name) || typeof input.session_id !== 'string') return null;
  if (input.hook_event_name !== 'PostToolUse' && !('tool_response' in input)) return null;
  const command = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input.command : null;
  if (typeof command !== 'string' || !/\btask\b/.test(command)) return null;
  const { parseOfficeCommand } = await import('../lib/chief-guard.mjs');
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : ROOT;
  const parsed = parseOfficeCommand(command, { root: ROOT, cwd });
  if (!parsed || parsed.script !== 'office' || parsed.args[0] !== 'task' || parsed.args[1] !== 'start') return null;
  const { extractOfficeTask } = await import('../lib/events.mjs');
  const { isTaskId } = await import('../lib/plan.mjs');
  const { loadTasks } = await import('../lib/tasks.mjs');
  const taskId = extractOfficeTask(shellStdout(input.tool_response));
  if (!isTaskId(taskId)) return null;
  try {
    return loadTasks(ROOT).some((t) => t && t.id === taskId) ? taskId : null;
  } catch {
    return null;
  }
}

async function main() {
  // 공용 모듈은 동적으로 불러온다. 모듈 로드 실패도 종료 코드 0으로 끝내기 위해서다
  const { appendEvent, normalizeClaudeHook } = await import('../lib/events.mjs');
  const { renameWithRetry } = await import('../lib/paths.mjs');
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (!input || typeof input !== 'object') return;

  const sessionsFile = join(ROOT, '.office', 'sessions.json');
  const sessionsMap = readSessions(sessionsFile);

  // office.mjs task start 결과를 세션에 연결해 이후 이벤트(이번 tool.end 포함)에 task 를 붙인다
  let taskId = null;
  try { taskId = await linkedTask(input); } catch { /* 연결 실패는 이벤트 기록을 막지 않는다 */ }
  if (taskId && sessionsMap[input.session_id] !== taskId) {
    sessionsMap[input.session_id] = taskId;
    try { writeSessions(sessionsFile, sessionsMap, renameWithRetry); } catch { /* 기록 실패는 무시 */ }
  }

  const ev = normalizeClaudeHook(input, { sessionsMap });
  if (ev) appendEvent(ROOT, ev);
}

main().catch(() => {}).finally(quit);
