// 비서실장 직접 실무 금지 판정(순수 함수). hooks/chief-guard.mjs(PreToolUse)가 감싼다.
// 판정 대상: agent_type이 없는 메인 세션이 .office/sessions.json에 진행 중인 업무(tasks.json에 있고 done이 아님)가 연결된 상태에서
// 도구를 쓰려는 경우, 그리고 대시보드 비서실장 실행(OFFICE_CHIEF_RUN=1)이 업무 등록 전에 실무 도구를 쓰려는 경우.
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

// 실무 결과를 만들지 않는 조회·조율 도구. Agent/Task(서브에이전트 호출)는 아래에서 직원 여부를 따로 본다
export const CHIEF_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS',
  'Skill', 'ToolSearch', 'AskUserQuestion', 'SendMessage',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'EnterPlanMode', 'ExitPlanMode',
];
// 서브에이전트 호출 도구. 예전 버전은 이름이 Task였다
export const AGENT_TOOLS = ['Agent', 'Task'];
// 비서실장이 outputs/<task>/ 바로 아래에 직접 쓸 수 있는 파일
export const CHIEF_WRITABLE_FILES = ['brief.md', 'meeting.md', 'report.md', 'review-notes.md', 'plan.json'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const OFFICE_SCRIPTS = ['scripts/office.mjs', 'scripts/codex-review.mjs'];

export const CHIEF_DENY_MESSAGE = '비서실장은 직접 실무를 하지 않습니다. 담당 직원에게 Agent로 배정하세요.';
export const PRE_TASK_DENY_MESSAGE = '대시보드 업무는 먼저 `node scripts/office.mjs task start "<제목>"`로 등록해야 합니다. 등록 전에는 조회(Read/Glob/Grep)와 office.mjs 명령만 쓸 수 있습니다. 비서실장은 직접 실무를 하지 않습니다.';
// 비서실장 검토 반려 한도(같은 업무, 마지막 deliver·사용자 반려 이후)
export const MAX_REVIEW_REJECTS = 2;
export const REJECT_LIMIT_MESSAGE = `반려는 같은 업무에서 최대 ${MAX_REVIEW_REJECTS}회입니다. 남은 문제를 report.md의 "확인 필요"에 적고 \`node scripts/office.mjs flow <업무> deliver\`로 사용자 확인을 요청하세요.`;
export const BACKGROUND_DENY_MESSAGE = '대시보드 업무에서는 직원 작업이 끝날 때까지 기다려야 다음 단계로 넘길 수 있습니다. run_in_background 없이 호출하세요';

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// 근무중이고 Claude 서브에이전트로 부를 수 있는 직원(부서 운영 중, engine이 codex가 아님)
export function onDutyAgents(org) {
  const depts = new Map((org?.departments || []).filter((d) => d && d.active !== false).map((d) => [d.id, d]));
  const out = [];
  for (const a of org?.roster || []) {
    if (!a || typeof a.id !== 'string' || a.active === false) continue;
    const dept = depts.get(a.department);
    if (!dept || dept.engine === 'codex') continue;
    out.push({
      id: a.id,
      name: oneLine(a.name),
      rank: oneLine(a.rank || a.title || (a.lead ? '팀장' : '')),
      dept: dept.id,
      deptName: oneLine(dept.name || dept.id),
      specialty: oneLine(a.specialty || a.description || ''),
    });
  }
  return out;
}

// 사용 가능한 직원 요약. 거부 사유에 넣으므로 길이를 제한한다
export function summarizeAgents(agents, max = 1500) {
  if (!agents.length) return '근무중 직원이 없습니다. 대표에게 대시보드(조직 탭)에서 부서와 직원을 추가해 달라고 안내하세요.';
  const parts = [];
  let len = 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const label = [a.name && `${a.name}${a.rank ? ` ${a.rank}` : ''}`, a.deptName, a.specialty && clip(a.specialty, 40)].filter(Boolean).join(' · ');
    const item = `${a.id}(${label})`;
    if (len + item.length > max) {
      parts.push(`외 ${agents.length - i}명`);
      break;
    }
    parts.push(item);
    len += item.length + 2;
  }
  return `사용 가능한 직원: ${parts.join(', ')}.`;
}

// 셸 명령을 따옴표만 해석해 토큰으로 나눈다. 연결·리다이렉션·치환·변수 확장이 있으면 null(거부).
// 백슬래시는 이스케이프로 해석하지 않는다(Windows 경로). 대신 bash가 이스케이프로 읽어 따옴표·공백·특수문자의 뜻을 바꿀 수 있는
// 경우(작은따옴표 밖의 백슬래시 뒤에 영문·숫자·`_` `.` `-`가 아닌 문자가 오거나 줄 끝)는 거부한다. `\'`를 bash는 글자 '로,
// 이 함수는 따옴표 시작으로 읽어 `;`를 따옴표 안으로 착각하는 우회를 막는다. PowerShell이 따옴표로 보는 유니코드 따옴표도 거부한다.
const ESCAPE_SAFE = /[A-Za-z0-9_.-]/;
const UNICODE_QUOTES = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/;
export function splitSafeCommand(command) {
  if (typeof command !== 'string') return null;
  if (UNICODE_QUOTES.test(command)) return null;
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  const chars = Array.from(command.trim());
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '\\' && !(i + 1 < chars.length && ESCAPE_SAFE.test(chars[i + 1]))) return null;
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '$' || ch === '`') return null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
    } else if (/[;&|<>()`$\r\n]/.test(ch)) {
      return null;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has) tokens.push(cur);
  return tokens;
}

// 심볼릭 링크를 푼 경로(macOS /var → /private/var 등). 아직 없는 파일은 있는 상위 폴더까지 풀고 나머지를 붙인다
function realish(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realish(parent), basename(p));
  }
}

const samePath = (a, b, platform) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const toSlash = (p) => p.split('\\').join('/');

// `node scripts/office.mjs …` 또는 `node scripts/codex-review.mjs …` 단독 실행이면 {script, args}, 아니면 null
export function parseOfficeCommand(command, { root, cwd = root, platform = process.platform } = {}) {
  const tokens = splitSafeCommand(command);
  if (!tokens || tokens.length < 2) return null;
  if (!/^node(\.exe)?$/i.test(tokens[0])) return null;
  const rel = toSlash(relative(realish(resolve(root)), realish(resolve(cwd, tokens[1]))));
  const script = OFFICE_SCRIPTS.find((s) => samePath(rel, s, platform));
  if (!script) return null;
  return { script: script === 'scripts/office.mjs' ? 'office' : 'codex-review', args: tokens.slice(2) };
}

// 업무 중인 비서실장이 쓸 수 있는 office.mjs 하위 명령. org(조직 정본 덮어쓰기·임의 경로 쓰기)와
// task status done·review(사용자 승인 우회)는 막는다. done은 대표가 대시보드에서 승인할 때만, review는 flow deliver로만 바뀐다
export function officeSubcommandDenial(args) {
  const [group, cmd, ...rest] = args;
  if (group === 'task' && (cmd === 'start' || cmd === 'list')) return null;
  if (group === 'task' && cmd === 'status') {
    if (rest.length === 2 && (rest[1] === 'blocked' || rest[1] === 'active')) return null;
    return '비서실장은 `task status <id> blocked|active`만 쓸 수 있습니다. 사용자 확인 대기는 `flow <id> deliver`로 요청하고, 완료(done)는 대표가 대시보드에서 승인할 때 기록됩니다.';
  }
  if (group === 'flow' || group === 'meeting') return null;
  if (group === 'plan' && cmd === 'validate') return null;
  if (group === 'org') return '회사 구성 내보내기·가져오기(org export|import)는 대표가 직접 실행합니다. 비서실장은 조직 정본을 바꾸지 않습니다.';
  return '허용되지 않은 office.mjs 명령입니다. task start|list|status(blocked·active), flow, meeting, plan validate만 쓸 수 있습니다.';
}

// 업무 중인 비서실장이 실행할 수 있는 셸 명령인가(위 두 스크립트 단독 실행 + 하위 명령 허용 목록)
export function isAllowedOfficeCommand(command, opts = {}) {
  const parsed = parseOfficeCommand(command, opts);
  if (!parsed) return false;
  return parsed.script === 'codex-review' || officeSubcommandDenial(parsed.args) === null;
}

// outputs/<task>/ 바로 아래의 허용 파일인가
export function isAllowedChiefWrite(filePath, { root, cwd = root, task, platform = process.platform } = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof task !== 'string') return false;
  const outputs = realish(join(resolve(root), 'outputs'));
  const taskDir = resolve(outputs, ...task.split('/'));
  const fromOutputs = relative(outputs, taskDir);
  if (!fromOutputs || fromOutputs.startsWith('..') || isAbsolute(fromOutputs)) return false;
  const rel = relative(taskDir, realish(resolve(cwd, filePath)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  return CHIEF_WRITABLE_FILES.some((f) => samePath(toSlash(rel), f, platform));
}

function allowedHint(task) {
  const files = CHIEF_WRITABLE_FILES.join('·');
  return `(업무 ${task} 진행 중. 허용: Read/Glob/Grep, 근무중 직원 Agent 호출, \`node scripts/office.mjs …\`·\`node scripts/codex-review.mjs …\` 단독 실행, outputs/${task}/의 ${files} 작성)`;
}

// 반환: null(허용 → 무출력) 또는 { reason }(거부)
// input: PreToolUse 훅 입력. sessions: .office/sessions.json 객체. getOrg: Agent 호출일 때만 부르는 정본 로더
// getTasks: .office/tasks.json 로더(주면 연결된 업무가 없거나 done이면 제한하지 않는다)
// chiefRun: 대시보드 비서실장 실행(runner가 OFFICE_CHIEF_RUN=1을 준다). 업무 연결 전에도 실무 도구를 막는다
// getRejectRounds: (task) → {flows, calls} 마지막 deliver·사용자 반려 뒤의 flow review 반려·[반려] 호출 수
export function decideChiefGuard(input, { root, sessions, getOrg, getTasks, chiefRun = false, getRejectRounds, platform = process.platform } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') return null;
  if (typeof input.agent_type === 'string' && input.agent_type) return null; // 서브에이전트·--agent 직원 실행
  if (typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') return null;
  let task = sessions && typeof sessions === 'object' ? sessions[input.session_id] : null;
  if (typeof task !== 'string' || !task) task = null;
  // 업무가 tasks.json에 없거나 이미 완료됐으면 연결이 남아 있어도 제한하지 않는다(세션이 영구히 잠기지 않게)
  if (task && typeof getTasks === 'function') {
    const found = (getTasks() || []).find((t) => t && t.id === task);
    if (!found || found.status === 'done') task = null;
  }

  const tool = input.tool_name;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : root;

  if (!task) {
    if (!chiefRun || CHIEF_ALLOWED_TOOLS.includes(tool)) return null; // 터미널 세션은 업무 연결 전에는 제한하지 않는다
    if (SHELL_TOOLS.includes(tool) && isAllowedOfficeCommand(toolInput.command, { root, cwd, platform })) return null;
    return { reason: PRE_TASK_DENY_MESSAGE };
  }

  if (CHIEF_ALLOWED_TOOLS.includes(tool)) return null;

  if (AGENT_TOOLS.includes(tool)) {
    // 백그라운드 위임은 헤드리스 run이 먼저 끝나 다음 단계가 멈춘다(SPEC "헤드리스 실행에서 백그라운드 위임 금지")
    if (toolInput.run_in_background === true) {
      return { reason: `${BACKGROUND_DENY_MESSAGE}. 병렬이 필요하면 한 응답에서 여러 Agent를 동시에 호출하고 모두 끝날 때까지 기다리세요.` };
    }
    const agents = onDutyAgents(getOrg());
    const type = toolInput.subagent_type;
    if (typeof type === 'string' && agents.some((a) => a.id === type)) {
      const desc = typeof toolInput.description === 'string' ? toolInput.description.trim() : '';
      if (desc.startsWith('[반려]') && typeof getRejectRounds === 'function') {
        const { flows = 0, calls = 0 } = getRejectRounds(task) || {};
        // 이 호출이 이미 기록된 flow review 반려의 재지시면 그 회차, 아니면 새 회차다
        if (Math.max(flows, calls + 1) > MAX_REVIEW_REJECTS) return { reason: REJECT_LIMIT_MESSAGE };
      }
      return null;
    }
    const who = typeof type === 'string' && type ? `'${clip(oneLine(type), 60)}'은(는)` : 'subagent_type이 없는 호출은';
    return {
      reason: `${who} 근무중 직원이 아니라 부를 수 없습니다. subagent_type에 근무중 직원 id를 쓰세요. ${summarizeAgents(agents)} 필요한 역량의 직원이 없으면 비서실장이 대신하지 말고 plan.json의 gaps에 적은 뒤 대표에게 대시보드에서 직원 추가를 안내하세요.`,
    };
  }

  if (SHELL_TOOLS.includes(tool)) {
    const parsed = parseOfficeCommand(toolInput.command, { root, cwd, platform });
    if (parsed?.script === 'codex-review') return null;
    if (parsed) {
      const denial = officeSubcommandDenial(parsed.args);
      return denial ? { reason: `${denial} ${allowedHint(task)}` } : null;
    }
    return {
      reason: `${CHIEF_DENY_MESSAGE} 셸에서는 \`node scripts/office.mjs …\`와 \`node scripts/codex-review.mjs …\`만 실행할 수 있습니다. cd·&&·;·|·리다이렉션·$ 없이 단독으로 실행하고, 값에 특수문자가 있으면 작은따옴표로 감싸세요. ${allowedHint(task)}`,
    };
  }

  if (WRITE_TOOLS.includes(tool)) {
    if (isAllowedChiefWrite(toolInput.file_path, { root, cwd, task, platform })) return null;
    return { reason: `${CHIEF_DENY_MESSAGE} 산출물 작성은 담당 직원의 일입니다. ${allowedHint(task)}` };
  }

  return { reason: `${CHIEF_DENY_MESSAGE} ${allowedHint(task)}` };
}
