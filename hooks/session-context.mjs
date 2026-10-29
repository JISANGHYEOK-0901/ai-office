#!/usr/bin/env node
// SessionStart 훅: 레포에서 연 claude 메인 세션(비서실장)에 현재 조직도를 additionalContext로 주입한다.
// 출력 형식(공식 문서 https://code.claude.com/docs/en/hooks 확인, 2026-10-29):
//   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
//   additionalContext가 10,000자를 넘으면 Claude Code가 파일로 돌리고 앞 2,000자만 보여 주므로 그 안으로 줄인다.
// hooks/office-event.mjs는 stdout 무출력 원칙이라 이 훅을 따로 둔다. 서브에이전트·--agent 직원 세션, 잘못된 입력,
// 어떤 오류에서도 무출력·종료 코드 0으로 2초 안에 끝난다.
// 대시보드 비서실장 run은 runner가 --append-system-prompt로 같은 조직도를 넣으므로, OFFICE_ORGMAP_INJECTED=1이면 생략한다.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : null;
// 데이터 위치: CLAUDE_PROJECT_DIR가 AI Office 작업 공간(표식 .ai-office-workspace)이거나 예전 방식의 레포(hooks/가 있음)면 그곳,
// 아니면 이 파일 위치(프로그램 레포, 호환 모드). 작업 공간 설정의 훅은 프로그램 레포 훅의 절대경로로 불린다
const ROOT = ENV_ROOT && (existsSync(join(ENV_ROOT, '.ai-office-workspace')) || existsSync(join(ENV_ROOT, 'hooks', 'session-context.mjs'))) ? ENV_ROOT : HERE_ROOT;
const STDIN_TIMEOUT_MS = 1500;
const HARD_LIMIT_MS = 1900;
const MAX_CONTEXT = 9500;

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

// lib/orgmap.mjs가 없거나 실패할 때 쓰는 최소 조직도(근무중 직원만)
function fallbackOrgMap(org, onDutyAgents) {
  const agents = onDutyAgents(org);
  if (!agents.length) return '## 현재 조직\n\n근무중 직원이 없습니다. 대표에게 대시보드(조직 탭)에서 부서와 직원을 추가해 달라고 안내하세요.';
  const lines = ['## 현재 조직 (근무중 직원)', ''];
  for (const d of org.departments.filter((x) => x.active !== false)) {
    const members = agents.filter((a) => a.dept === d.id);
    if (!members.length) continue;
    lines.push(`### ${d.name || d.id} (id: ${d.id})${d.summary ? ` — ${String(d.summary).replace(/\s+/g, ' ')}` : ''}`);
    for (const a of members) lines.push(`- ${a.id}: ${a.name}${a.rank ? ` ${a.rank}` : ''}${a.specialty ? ` — ${a.specialty}` : ''}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function buildContext() {
  const { loadOrg, loadPresets } = await import('../lib/org.mjs');
  const { onDutyAgents } = await import('../lib/chief-guard.mjs');
  const org = loadOrg(ROOT);
  let map = null;
  try {
    const { buildOrgMap } = await import('../lib/orgmap.mjs');
    let presets;
    try { presets = loadPresets(ROOT); } catch { /* 프리셋이 없으면 부서 역량 기본값 없이 만든다 */ }
    if (typeof buildOrgMap === 'function') map = buildOrgMap(org, { presets });
  } catch { /* orgmap 모듈이 없거나 실패하면 최소 조직도로 대신한다 */ }
  if (typeof map !== 'string' || !map.trim()) map = fallbackOrgMap(org, onDutyAgents);

  const head = [
    '# AI Office 조직도 (SessionStart 훅이 정본에서 자동 주입)',
    '',
    '당신은 비서실장이다. 업무 배정은 아래 근무중 직원만 Agent(subagent_type=직원 id)로 한다. 휴무 직원·없는 직원은 부를 수 없다.',
    '업무가 연결된 뒤에는 직접 실무(웹 수집·스크립트 실행·산출물 작성)를 하지 않는다(hooks/chief-guard.mjs가 거부한다). 절차는 AGENTS.md와 office-task 스킬을 따른다.',
    '조직이 바뀌면 다음 세션부터 반영된다. 최신 정본은 org/departments.json·org/roster.json이다.',
    '',
    '',
  ].join('\n');
  let text = `${head}${map.trim()}\n`;
  if (text.length > MAX_CONTEXT) {
    const tail = '\n\n(조직도가 길어 잘랐습니다. 전체는 org/roster.json과 .claude/agents/*.md를 확인하세요.)\n';
    text = text.slice(0, MAX_CONTEXT - tail.length) + tail;
  }
  return text;
}

async function main() {
  if (process.env.OFFICE_ORGMAP_INJECTED === '1') return null;
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { return null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.hook_event_name !== 'SessionStart') return null;
  if (typeof input.agent_type === 'string' && input.agent_type) return null;
  const additionalContext = await buildContext();
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } };
}

main()
  .then((out) => {
    if (!out) return quit();
    process.stdout.write(JSON.stringify(out), quit);
  })
  .catch(quit);
