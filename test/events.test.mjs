import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  redact, normalizeClaudeHook, normalizeCodexItem, appendEvent, readEvents, extractOfficeTask,
} from '../lib/events.mjs';

const NOW = new Date('2026-10-29T05:00:00.000Z');
const SID = '5f1c2a9e-1111-4c3b-9d7e-abcdefabcdef';

// 실측 훅 입력 형태 그대로
const fixtures = {
  sessionStart: { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' },
  prompt: { session_id: SID, prompt_id: 'p-1', prompt: '경쟁사 가격을\n조사해 줘' },
  taskNotification: { session_id: SID, prompt_id: 'p-2', prompt: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' },
  preBash: {
    session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'curl -H "Authorization: Bearer abc.def.ghi" https://example.com/api/v1/items?limit=100&page=2&sort=desc', description: '목록 조회' },
    tool_use_id: 'toolu_01',
  },
  postBash: {
    session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'node scripts/office.mjs task start "경쟁사 조사"' },
    tool_use_id: 'toolu_02',
    tool_response: { stdout: '업무를 만들었습니다\nOFFICE_TASK=2026-10-29/competitor-scan\n', stderr: '', interrupted: false, isImage: false },
  },
  preAgent: {
    session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { description: '경쟁사 가격 조사', prompt: '아주 긴 원문 지시 '.repeat(50), subagent_type: 'market-researcher' },
    tool_use_id: 'toolu_03',
  },
  subPreTool: {
    session_id: SID, hook_event_name: 'PreToolUse', agent_id: 'a1b2c3', agent_type: 'market-researcher',
    tool_name: 'WebSearch', tool_input: { query: '2026 커피 시장 규모' }, tool_use_id: 'toolu_04',
  },
  subagentStart: { session_id: SID, hook_event_name: 'SubagentStart', agent_id: 'a1b2c3', agent_type: 'market-researcher' },
  subagentStop: {
    session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'a1b2c3', agent_type: 'market-researcher',
    last_assistant_message: '조사 결과\n시장 규모는 3조 원입니다. api_key=sk-abcdefghijklmnop1234 는 쓰지 않았습니다.',
    agent_transcript_path: '/Users/x/.claude/projects/p/a1b2c3.jsonl',
  },
  stop: { session_id: SID, hook_event_name: 'Stop', last_assistant_message: '보고서를 정리했습니다.', background_tasks: [] },
};

test('redact: 줄바꿈 정리, 비밀값 가림, 길이 제한', () => {
  assert.equal(redact('a\n\nb\tc'), 'a b c');
  assert.equal(redact(null), '');
  assert.equal(redact('password=hunter2 다음'), 'password=*** 다음');
  assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer ***');
  assert.equal(redact('export GITHUB_TOKEN=ghp_xxx; ls'), 'export GITHUB_TOKEN=***; ls');
  assert.equal(redact('cookie: sid=abc'), 'cookie: ***');
  assert.equal(redact('키는 sk-ABCDEFGHIJKLMNOPQRSTUV 입니다'), '키는 *** 입니다');
  const long = redact('가'.repeat(500));
  assert.equal(Array.from(long).length, 200);
  assert.ok(long.endsWith('…'));
  assert.equal(Array.from(redact('x'.repeat(100), 80)).length, 80);
});

test('SessionStart → session.start, 메인 세션은 chief', () => {
  const ev = normalizeClaudeHook(fixtures.sessionStart, { now: NOW });
  assert.deepEqual(ev, {
    v: 1, ts: '2026-10-29T05:00:00.000Z', engine: 'claude', session: SID, agent: 'chief',
    instance: SID, kind: 'session.start', summary: 'startup',
  });
});

test('UserPromptSubmit → request(hook_event_name 없이도 추정), task-notification 은 무시', () => {
  const ev = normalizeClaudeHook(fixtures.prompt, { now: NOW });
  assert.equal(ev.kind, 'request');
  assert.equal(ev.summary, '경쟁사 가격을 조사해 줘');
  assert.equal(normalizeClaudeHook(fixtures.taskNotification), null);
  assert.equal(normalizeClaudeHook({ ...fixtures.taskNotification, hook_event_name: 'UserPromptSubmit', prompt: '  <task-notification>x' }), null);
});

test('PreToolUse(Bash) → tool.start, 명령은 80자·비밀값 가림, 도구 입력 전문은 저장 안 함', () => {
  const ev = normalizeClaudeHook(fixtures.preBash, { now: NOW });
  assert.equal(ev.kind, 'tool.start');
  assert.equal(ev.tool, 'Bash');
  assert.ok(Array.from(ev.summary).length <= 80);
  assert.ok(!ev.summary.includes('abc.def.ghi'));
  assert.ok(ev.summary.includes('Bearer ***'));
  assert.ok(!('tool_input' in ev));
});

test('PostToolUse → tool.end, 세션에 연결된 task 가 붙고 응답은 저장 안 함', () => {
  const sessionsMap = { [SID]: '2026-10-29/competitor-scan' };
  const ev = normalizeClaudeHook(fixtures.postBash, { sessionsMap, now: NOW });
  assert.equal(ev.kind, 'tool.end');
  assert.equal(ev.task, '2026-10-29/competitor-scan');
  assert.ok(!JSON.stringify(ev).includes('업무를 만들었습니다'));
  // hook_event_name 이 빠져도 tool_response 로 PostToolUse 를 추정한다
  const { hook_event_name, ...noName } = fixtures.postBash;
  assert.equal(normalizeClaudeHook(noName).kind, 'tool.end');
});

test('Agent 도구 → summary 에 subagent_type 과 description', () => {
  const ev = normalizeClaudeHook(fixtures.preAgent, { now: NOW });
  assert.equal(ev.tool, 'Agent');
  assert.equal(ev.summary, 'market-researcher: 경쟁사 가격 조사');
  assert.equal(ev.agent, 'chief');
});

test('서브에이전트 이벤트: agent 는 agent_type, instance 는 agent_id', () => {
  const tool = normalizeClaudeHook(fixtures.subPreTool, { now: NOW });
  assert.equal(tool.agent, 'market-researcher');
  assert.equal(tool.instance, 'a1b2c3');
  assert.equal(tool.summary, '2026 커피 시장 규모');

  const start = normalizeClaudeHook(fixtures.subagentStart, { now: NOW });
  assert.equal(start.kind, 'agent.start');
  assert.equal(start.agent, 'market-researcher');

  const stop = normalizeClaudeHook(fixtures.subagentStop, { now: NOW });
  assert.equal(stop.kind, 'agent.stop');
  assert.ok(stop.summary.startsWith('조사 결과 시장 규모는'));
  assert.ok(!stop.summary.includes('sk-abcdefghijklmnop1234'));
});

test('claude -p --agent X 메인 세션: agent_type 이 있으면 그 값을 쓴다', () => {
  const ev = normalizeClaudeHook({ session_id: SID, prompt_id: 'p', prompt: '해줘', agent_type: 'research-1' });
  assert.equal(ev.agent, 'research-1');
  assert.equal(ev.instance, SID);
});

test('Stop → turn.end, 알 수 없는 입력은 null', () => {
  assert.equal(normalizeClaudeHook(fixtures.stop, { now: NOW }).kind, 'turn.end');
  const { hook_event_name, ...noName } = fixtures.stop;
  assert.equal(normalizeClaudeHook(noName).kind, 'turn.end');
  assert.equal(normalizeClaudeHook({ session_id: SID, hook_event_name: 'Notification', message: 'x' }), null);
  assert.equal(normalizeClaudeHook(null), null);
  assert.equal(normalizeClaudeHook('문자열'), null);
});

test('normalizeCodexItem: 실측 codex exec --json 라인', () => {
  const opts = { agent: 'fact-checker', task: '2026-10-29/x', session: 'rev-1', now: NOW };
  assert.equal(normalizeCodexItem('{"type":"thread.started","thread_id":"t-1"}', opts), null);
  assert.equal(normalizeCodexItem('{"type":"turn.started"}', opts), null);
  const started = normalizeCodexItem(JSON.stringify({
    type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "rg -n 매출 outputs"', status: 'in_progress' },
  }), opts);
  assert.deepEqual(started, {
    v: 1, ts: '2026-10-29T05:00:00.000Z', engine: 'codex', session: 'rev-1', agent: 'fact-checker',
    instance: 'rev-1', kind: 'tool.start', task: '2026-10-29/x', tool: 'Bash', summary: 'bash -lc "rg -n 매출 outputs"',
  });
  const done = normalizeCodexItem({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', status: 'failed' } }, opts);
  assert.equal(done.kind, 'tool.end');
  assert.equal(done.summary, 'ls (failed)');
  assert.equal(normalizeCodexItem({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'VERDICT: PASS' } }, opts), null);
  assert.equal(normalizeCodexItem({ type: 'item.started', item: { id: 'i3', type: 'collab_tool_call', status: 'in_progress' } }, opts).tool, 'Agent');
  assert.equal(normalizeCodexItem({ type: 'item.started', item: { id: 'i4', type: 'file_change', status: 'in_progress' } }, opts).tool, 'Edit');
  const turn = normalizeCodexItem({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 10, output_tokens: 300 } }, opts);
  assert.equal(turn.kind, 'turn.end');
  assert.equal(turn.summary, '입력 1200 · 출력 300 토큰');
  assert.equal(normalizeCodexItem('{"type":"something.new"}', opts), null);
  assert.equal(normalizeCodexItem('깨진 줄', opts), null);
});

test('appendEvent / readEvents: 증분 읽기와 잘린 마지막 줄', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-events-'));
  appendEvent(root, { engine: 'claude', kind: 'request', agent: 'chief' });
  appendEvent(root, { engine: 'claude', kind: 'turn.end', agent: 'chief' });
  const file = join(root, '.office', 'events.jsonl');
  const first = readEvents(file);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].v, 1);
  assert.ok(first.events[0].ts);

  appendFileSync(file, '{"v":1,"kind":"tool.start","agent":"한글');
  const partial = readEvents(file, first.offset);
  assert.equal(partial.events.length, 0);
  assert.equal(partial.offset, first.offset);
  appendFileSync(file, '"}\n{"broken\n');
  const rest = readEvents(file, partial.offset);
  assert.deepEqual(rest.events, [{ v: 1, kind: 'tool.start', agent: '한글' }]);
  assert.equal(rest.offset, readFileSync(file).length);

  // 파일이 비워지면 처음부터 다시 읽는다
  writeFileSync(file, '{"kind":"a"}\n');
  assert.deepEqual(readEvents(file, rest.offset).events, [{ kind: 'a' }]);
  assert.deepEqual(readEvents(join(root, 'none.jsonl'), 5), { events: [], offset: 5 });

  appendEvent(root, { kind: 'x' }, { file: 'demo-events.jsonl' });
  assert.equal(readEvents(join(root, '.office', 'demo-events.jsonl')).events.length, 1);
});

test('extractOfficeTask', () => {
  assert.equal(extractOfficeTask('a\nOFFICE_TASK=2026-10-29/competitor-scan\n'), '2026-10-29/competitor-scan');
  assert.equal(extractOfficeTask('OFFICE_TASK=2026-10-28/a\nOFFICE_TASK=2026-10-29/b'), '2026-10-29/b');
  assert.equal(extractOfficeTask('없음'), null);
  assert.equal(extractOfficeTask(undefined), null);
  assert.equal(extractOfficeTask({ stdout: 'OFFICE_TASK=x' }), null);
});
