#!/usr/bin/env node
// PreToolUse 훅: 업무가 연결된 메인 세션(비서실장)이 직접 실무 도구를 쓰거나 근무중이 아닌 직원을 부르면 거부한다.
// 작업 공간에서 실행 중이면(데이터 위치가 프로그램 레포와 다르면) 모든 에이전트의 프로그램 레포 쓰기도 거부한다.
// 거부할 때만 stdout에 Claude Code PreToolUse 결정 JSON을 쓴다
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
// (공식 문서 https://code.claude.com/docs/en/hooks 확인, 2026-10-29: deny 사유는 Claude에게 전달되고, JSON은 종료 코드 0과 함께 쓴다)
// 그 밖의 경우와 어떤 오류에서도 무출력·종료 코드 0(허용)으로 2초 안에 끝난다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : null;
// 데이터 위치: CLAUDE_PROJECT_DIR가 AI Office 작업 공간(표식 .ai-office-workspace)이거나 예전 방식의 레포(hooks/가 있음)면 그곳,
// 아니면 이 파일 위치(프로그램 레포, 호환 모드). 작업 공간 설정의 훅은 프로그램 레포 훅의 절대경로로 불린다
const ROOT = ENV_ROOT && (existsSync(join(ENV_ROOT, '.ai-office-workspace')) || existsSync(join(ENV_ROOT, 'hooks', 'chief-guard.mjs'))) ? ENV_ROOT : HERE_ROOT;
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

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { return null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  // 프로그램 레포 보호: 작업 공간 세션이면 직원 포함 모든 에이전트에 적용한다(레포에서 연 세션·호환 모드는 대상이 아님)
  if (ROOT !== HERE_ROOT) {
    const { decideRepoGuard } = await import('../lib/chief-guard.mjs');
    const repo = decideRepoGuard(input, { program: HERE_ROOT, root: ROOT });
    if (repo) return deny(repo.reason);
  }

  if (typeof input.agent_type === 'string' && input.agent_type) return null; // 직원 세션은 정본을 읽지 않고 바로 끝낸다

  const sessions = readSessions(join(ROOT, '.office', 'sessions.json'));
  // 대시보드 비서실장 실행은 runner가 OFFICE_CHIEF_RUN=1을 준다(훅은 claude 프로세스의 환경을 물려받는다). 업무 연결 전에도 판정한다
  const chiefRun = process.env.OFFICE_CHIEF_RUN === '1';
  if (typeof input.session_id !== 'string' || (!sessions[input.session_id] && !chiefRun)) return null;

  // 공용 모듈은 동적으로 불러온다. 로드 실패도 허용(무출력)으로 끝내기 위해서다
  const { decideChiefGuard } = await import('../lib/chief-guard.mjs');
  const { loadOrg } = await import('../lib/org.mjs');
  const { loadTasks } = await import('../lib/tasks.mjs');
  const { countReviewRejects } = await import('../lib/flow.mjs');
  const { readTailEvents } = await import('../lib/events.mjs');
  // 정본을 읽지 못하면 예외 → 허용으로 끝난다(안전하게 실패)
  const decision = decideChiefGuard(input, {
    root: ROOT,
    sessions,
    chiefRun,
    getOrg: () => loadOrg(ROOT),
    getTasks: () => loadTasks(ROOT),
    // [반려] 호출일 때만 이벤트 끝부분(최대 4MB)을 읽어 반려 회차를 센다
    getRejectRounds: (task) => countReviewRejects(readTailEvents(join(ROOT, '.office', 'events.jsonl')), task),
  });
  if (!decision) return null;
  return deny(decision.reason);
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

main()
  .then((out) => {
    if (!out) return quit();
    process.stdout.write(JSON.stringify(out), quit);
  })
  .catch(quit);
