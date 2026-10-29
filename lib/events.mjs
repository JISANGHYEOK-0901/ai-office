// 정규화 이벤트 스키마: Claude 훅 입력·Codex JSON 스트림 → .office/*.jsonl 한 줄 JSON
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_KEY = '[A-Za-z0-9_-]*(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)[A-Za-z0-9_-]*';
// 따옴표로 감싼 값(n번째 캡처 그룹이 여는 따옴표): 같은 따옴표(JSON 안의 \" 포함)가 닫힐 때까지 전부 가린다
const quoted = (n) => `(\\\\?["'])((?:(?!\\${n}).)+)\\${n}`;
// 키: 값 / 키=값 / "키": "값" 형태. 키 뒤 닫는 따옴표(JSON)도 허용한다. Authorization 의 Bearer/Basic 스킴은 남긴다.
const SECRET_PAIR = new RegExp(
  `(${SECRET_KEY})(\\\\?["']?\\s*[:=]\\s*)(?:${quoted(3)}|(\\\\?["']?)((?:bearer|basic|token)\\s+)?[^\\s"'&;,\\\\]+)`, 'gi');
// --키 값 / 키 is 값 형태. 그냥 공백으로 이어진 단어(예: "password policy")는 가리지 않는다.
const SECRET_FLAG = new RegExp(
  `(-{1,2}${SECRET_KEY}\\s+|${SECRET_KEY}\\s+(?:is|was)\\s+)(?:${quoted(2)}|(?![-"'])[^\\s"'&;,]+)`, 'gi');
// Cookie/Set-Cookie 헤더는 여러 쿠키가 이어지므로 따옴표나 문자열 끝까지 가린다
const COOKIE_HEADER = /((?:set-)?cookie\s*:\s*)(?!\\?["'])[^"'\\]+/gi;
// 키 이름 없이 드러난 대표적인 토큰 형태
const SECRET_LITERAL = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g;

// 한 줄 요약으로 만든다: 줄바꿈 → 공백, 비밀값 가림, max 자 이내로 자름
export function redact(text, max = 200) {
  if (text === undefined || text === null) return '';
  let s = String(text).replace(/\s+/g, ' ').trim();
  s = s.replace(COOKIE_HEADER, (_m, head) => `${head}***`);
  s = s.replace(SECRET_PAIR, (_m, key, sep, q, _v, q2 = '', scheme = '') => (q ? `${key}${sep}${q}***${q}` : `${key}${sep}${q2}${scheme}***`));
  s = s.replace(SECRET_FLAG, (_m, head, q) => (q ? `${head}${q}***${q}` : `${head}***`));
  s = s.replace(SECRET_LITERAL, '***');
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

// hook_event_name 이 빠진 입력은 필드 구성으로 종류를 추정한다
function hookEventName(input) {
  if (typeof input.hook_event_name === 'string') return input.hook_event_name;
  if (typeof input.prompt === 'string') return 'UserPromptSubmit';
  if (input.tool_name) return 'tool_response' in input ? 'PostToolUse' : 'PreToolUse';
  if (input.agent_transcript_path || (input.agent_id && 'last_assistant_message' in input)) return 'SubagentStop';
  if (input.agent_id && input.agent_type) return 'SubagentStart';
  if ('last_assistant_message' in input || 'background_tasks' in input) return 'Stop';
  if (input.source) return 'SessionStart';
  return null;
}

// 도구 입력 전문은 저장하지 않고 식별에 필요한 한 가지만 남긴다
function toolSummary(tool, toolInput) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (tool === 'Agent' || tool === 'Task') {
    return redact([ti.subagent_type, ti.description].filter(Boolean).join(': '));
  }
  if (tool === 'Bash') return redact(ti.command, 80);
  const key = ['description', 'file_path', 'notebook_path', 'path', 'pattern', 'query', 'url', 'skill']
    .find((k) => typeof ti[k] === 'string' && ti[k]);
  return key ? redact(ti[key]) : '';
}

function baseEvent(fields, opts) {
  const ev = { v: 1, ts: (opts.now ?? new Date()).toISOString(), ...fields };
  for (const k of ['task', 'tool', 'summary']) {
    if (ev[k] === undefined || ev[k] === null || ev[k] === '') delete ev[k];
  }
  return ev;
}

// Claude 훅 입력(객체) → 정규화 이벤트. 무시할 입력이면 null
export function normalizeClaudeHook(input, { sessionsMap = {}, now } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = hookEventName(input);
  const session = typeof input.session_id === 'string' ? input.session_id : 'unknown';
  // `claude -p --agent X` 메인 세션에도 agent_type 이 붙으므로 있으면 그 값을 쓴다
  const agent = typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : 'chief';
  const fields = {
    engine: 'claude',
    session,
    agent,
    instance: typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : session,
    kind: null,
    task: sessionsMap?.[session],
  };
  switch (name) {
    case 'SessionStart':
      fields.kind = 'session.start';
      fields.summary = redact(input.source);
      break;
    case 'UserPromptSubmit': {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      // 백그라운드 서브에이전트 완료 알림은 사용자 요청이 아니다
      if (prompt.trimStart().startsWith('<task-notification>')) return null;
      fields.kind = 'request';
      fields.summary = redact(prompt);
      break;
    }
    case 'PreToolUse':
    case 'PostToolUse':
      fields.kind = name === 'PreToolUse' ? 'tool.start' : 'tool.end';
      fields.tool = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
      fields.summary = toolSummary(fields.tool, input.tool_input);
      break;
    case 'SubagentStart':
      fields.kind = 'agent.start';
      break;
    case 'SubagentStop':
      fields.kind = 'agent.stop';
      fields.summary = redact(input.last_assistant_message);
      break;
    case 'Stop':
      fields.kind = 'turn.end';
      fields.summary = redact(input.last_assistant_message);
      break;
    default:
      return null;
  }
  return baseEvent(fields, { now });
}

// Codex item.type → 화면에 보일 도구명. 목록에 없으면 item.type 그대로 쓴다
const CODEX_TOOL = {
  command_execution: 'Bash',
  file_change: 'Edit',
  collab_tool_call: 'Agent',
  web_search: 'WebSearch',
  mcp_tool_call: 'MCP',
};
const CODEX_SKIP_ITEMS = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);

function codexItemSummary(item) {
  if (typeof item.command === 'string') return redact(item.command, 80);
  if (Array.isArray(item.changes)) return redact(item.changes.map((c) => c?.path).filter(Boolean).join(', '));
  for (const k of ['query', 'tool', 'description', 'prompt']) {
    if (typeof item[k] === 'string' && item[k]) return redact(item[k]);
  }
  return '';
}

// `codex exec --json` 한 줄(문자열 또는 객체) → 정규화 이벤트 또는 null
export function normalizeCodexItem(jsonLine, { agent, task, session, now } = {}) {
  let msg = jsonLine;
  if (typeof jsonLine === 'string') {
    try { msg = JSON.parse(jsonLine); } catch { return null; }
  }
  if (!msg || typeof msg !== 'object') return null;
  const sess = session || (typeof msg.thread_id === 'string' ? msg.thread_id : 'codex');
  const fields = { engine: 'codex', session: sess, agent: agent || 'codex', instance: sess, kind: null, task };
  if (msg.type === 'item.started' || msg.type === 'item.completed') {
    const item = msg.item;
    if (!item || typeof item !== 'object' || CODEX_SKIP_ITEMS.has(item.type)) return null;
    fields.kind = msg.type === 'item.started' ? 'tool.start' : 'tool.end';
    fields.tool = CODEX_TOOL[item.type] || String(item.type || 'unknown');
    fields.summary = codexItemSummary(item);
    if (msg.type === 'item.completed' && item.status && item.status !== 'completed') {
      fields.summary = redact(`${fields.summary} (${item.status})`.trim());
    }
  } else if (msg.type === 'turn.completed') {
    fields.kind = 'turn.end';
    const u = msg.usage || {};
    if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
      fields.summary = `입력 ${u.input_tokens ?? 0} · 출력 ${u.output_tokens ?? 0} 토큰`;
    }
  } else {
    return null;
  }
  return baseEvent(fields, { now });
}

// .office/<file> 에 한 줄 추가. v·ts 가 없으면 채운다
export function appendEvent(root, ev, { file = 'events.jsonl' } = {}) {
  const dir = join(root, '.office');
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ v: 1, ts: new Date().toISOString(), ...ev });
  appendFileSync(join(dir, file), line + '\n');
}

// fromOffset(바이트)부터 완결된 줄만 읽는다. 잘린 마지막 줄은 다음 호출로 넘긴다.
// 파일이 줄어들었으면(교체·초기화) 처음부터 다시 읽는다.
export function readEvents(file, fromOffset = 0) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { events: [], offset: fromOffset };
  }
  try {
    const size = fstatSync(fd).size;
    const start = fromOffset > size ? 0 : fromOffset;
    if (size === start) return { events: [], offset: start };
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const lastNl = buf.lastIndexOf(0x0a, read - 1);
    if (lastNl < 0) return { events: [], offset: start };
    const events = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 깨진 줄은 건너뛴다 */ }
    }
    return { events, offset: start + lastNl + 1 };
  } finally {
    closeSync(fd);
  }
}

// office.mjs task start 출력에서 마지막 OFFICE_TASK=<id> 를 찾는다
export function extractOfficeTask(stdoutText) {
  if (typeof stdoutText !== 'string' || !stdoutText.includes('OFFICE_TASK=')) return null;
  const matches = [...stdoutText.matchAll(/OFFICE_TASK=([A-Za-z0-9][A-Za-z0-9._/-]{0,199})/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
