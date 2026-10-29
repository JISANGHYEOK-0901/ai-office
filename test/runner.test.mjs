import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../dashboard/runner.mjs';
import { resolveCommand } from '../lib/cli.mjs';

function makeRoot({ departments = [], roster = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'office-runner-'));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(roster));
  return root;
}

const ORG = {
  departments: [
    { id: 'research', name: '리서치부', engine: 'claude', tools: ['Read', 'WebSearch'], permission: 'bypassPermissions' },
    { id: 'design', name: '디자인부', engine: 'claude' },
    { id: 'verify', name: '검증실', engine: 'codex' },
  ],
  roster: [
    { id: 'research-1', name: '김대리', department: 'research', title: '담당' },
    { id: 'design-1', name: '이주임', department: 'design', title: '담당' },
    { id: 'research-2', name: '박사원', department: 'research', title: '담당', active: false },
    { id: 'verify-1', name: '최과장', department: 'verify', title: '담당', instructions: '숫자를 다시 계산한다.' },
  ],
};

// spawnImpl 주입용 가짜 자식 프로세스. pid 는 주지 않아 실제 프로세스에 신호가 가지 않는다
function fakeSpawner() {
  const calls = [];
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.input = '';
    child.stdin.on('data', (c) => { child.input += c; });
    child.signals = [];
    child.kill = (sig) => { child.signals.push(sig); return true; };
    child.finish = (code, signal = null) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { calls, spawnImpl };
}

const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('claude 실행 인자: 부서 권한·도구·--agent, prompt 는 stdin', async () => {
  const root = makeRoot(ORG);
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  const run = runner.start({ agentId: 'research-1', prompt: '-rf 같은 문자로 시작해도 안전해야 함' });
  assert.equal(run.status, 'running');
  assert.equal(run.target, 'research-1');
  assert.equal(calls.length, 1);
  const cmd = resolveCommand('claude', 'CLAUDE_BIN');
  assert.equal(calls[0].bin, cmd.command);
  assert.deepEqual(calls[0].args, [...cmd.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--agent', 'research-1', '--allowedTools', 'Read,WebSearch']);
  await tick();
  assert.equal(calls[0].child.input, '-rf 같은 문자로 시작해도 안전해야 함');
  assert.equal(calls[0].opts.cwd, root);
  assert.equal(calls[0].opts.windowsHide, true);
  if (process.platform !== 'win32') assert.equal(calls[0].opts.detached, true);
  assert.ok(!calls[0].opts.shell || /\.(cmd|bat)$/i.test(cmd.command));

  // 비서실장: --agent 없음, 기본 acceptEdits, 작업 단위 모델 지정
  runner.start({ prompt: '업무를 나눠 줘', model: 'opus' });
  assert.deepEqual(calls[1].args, [...cmd.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--model', 'opus']);
  assert.equal(runner.list()[1].target, 'chief');
  assert.throws(() => runner.start({ prompt: 'x', model: 'gpt-4' }), (e) => e.status === 400);

  // 도구 미지정 부서는 --allowedTools 없음
  runner.start({ agentId: 'design-1', prompt: '시안' });
  assert.ok(!calls[2].args.includes('--allowedTools'));
  for (const c of calls) c.child.finish(0);
  await tick();
});

test('stream-json 결과 요약 저장, stdout 원문 로그, runs.json 기록', async () => {
  const root = makeRoot(ORG);
  const { calls, spawnImpl } = fakeSpawner();
  const changes = [];
  const runner = createRunner({ root, spawnImpl, onChange: (r) => changes.push(r.status) });
  const run = runner.start({ agentId: 'research-1', prompt: '조사해 줘' });
  const { child } = calls[0];
  child.stdout.write('{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"진행 중"}]}}\n');
  child.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"시장 규모는\\n3조 원입니다."}');
  child.finish(0);
  await waitFor(() => runner.list()[0].status === 'done');
  const done = runner.list()[0];
  assert.equal(done.summary, '시장 규모는 3조 원입니다.');
  assert.ok(done.endedAt);
  assert.ok(!('resultError' in done) && !('lastText' in done));
  assert.deepEqual(changes.slice(0, 1), ['running']);
  assert.equal(changes.at(-1), 'done');

  await waitFor(() => readFileSync(join(root, '.office', 'runs', `${run.id}.log`), 'utf8').includes('"type":"result"'));
  const saved = JSON.parse(readFileSync(join(root, '.office', 'runs.json'), 'utf8'));
  assert.equal(saved[0].id, run.id);
  assert.equal(saved[0].status, 'done');
  assert.ok(!JSON.stringify(saved).includes('prompt'));
});

test('실패 처리: 종료 코드·is_error·실행 파일 없음', async () => {
  const root = makeRoot(ORG);
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  runner.start({ agentId: 'research-1', prompt: 'a' });
  runner.start({ agentId: 'research-1', prompt: 'b' });
  runner.start({ agentId: 'research-1', prompt: 'c' });
  calls[0].child.stderr.write('인증 오류');
  calls[0].child.finish(1);
  calls[1].child.stdout.write('{"type":"result","is_error":true,"result":"한도 초과"}\n');
  calls[1].child.finish(0);
  const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  calls[2].child.emit('error', err);
  calls[2].child.finish(-2);
  await waitFor(() => runner.list().every((r) => r.status !== 'running'));
  const [a, b, c] = runner.list();
  assert.equal(a.status, 'failed');
  assert.match(a.summary, /종료 코드 1 — 인증 오류/);
  assert.equal(b.status, 'failed');
  assert.match(b.summary, /한도 초과/);
  assert.equal(c.status, 'failed');
  assert.match(c.summary, /실행 파일을 찾지 못했습니다/);
});

test('사전 검사: 없는 직원 404, 휴무 409, 빈 요청 400', () => {
  const root = makeRoot(ORG);
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  assert.throws(() => runner.start({ agentId: 'ghost-1', prompt: 'x' }), (e) => e.status === 404 && /찾을 수 없습니다/.test(e.message));
  assert.throws(() => runner.start({ agentId: 'research-2', prompt: 'x' }), (e) => e.status === 409 && /휴무/.test(e.message));
  assert.throws(() => runner.start({ agentId: 'research-1', prompt: '  ' }), (e) => e.status === 400);
  assert.throws(() => runner.stop('none'), (e) => e.status === 404);
  assert.equal(calls.length, 0);
  assert.equal(runner.list().length, 0);
});

test('동시 4개 초과는 queued, 끝나면 순서대로 실행, 대기 중 중지', async () => {
  const root = makeRoot(ORG);
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  const runs = Array.from({ length: 6 }, (_, i) => runner.start({ agentId: 'design-1', prompt: `작업 ${i}` }));
  assert.deepEqual(runs.map((r) => r.status), ['running', 'running', 'running', 'running', 'queued', 'queued']);
  assert.equal(calls.length, 4);

  const cancelled = runner.stop(runs[5].id);
  assert.equal(cancelled.status, 'stopped');

  calls[0].child.finish(0);
  await waitFor(() => calls.length === 5);
  await tick();
  assert.equal(calls[4].child.input, '작업 4');
  assert.equal(runner.list()[4].status, 'running');
  for (const c of calls.slice(1)) c.child.finish(0);
  await waitFor(() => runner.list().filter((r) => r.status === 'done').length === 5);
  assert.equal(calls.length, 5, '취소된 실행은 시작하지 않는다');
});

test('codex 엔진 직원: codex exec --json -s read-only, 기본 모델·강도, 지침+요청은 stdin, 이벤트 기록', async () => {
  const root = makeRoot(ORG);
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  const run = runner.start({ agentId: 'verify-1', prompt: '합계 확인해 줘' });
  assert.equal(run.engine, 'codex');
  const { bin, args, child } = calls[0];
  const cmd = resolveCommand('codex', 'CODEX_BIN');
  assert.equal(bin, cmd.command);
  const env = process.env;
  const model = env.OFFICE_CODEX_MODEL || 'gpt-6.1-sol';
  const effort = env.OFFICE_CODEX_EFFORT || 'max';
  assert.deepEqual(args, [...cmd.prefixArgs, 'exec', '--json', '-s', 'read-only', '-C', root, '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-']);
  await tick();
  assert.match(child.input, /숫자를 다시 계산한다\./);
  // codex-review.mjs 와 같은 공통 검토 기준·VERDICT 형식에 요청을 붙인다
  assert.match(child.input, /## 공통 검토 기준/);
  assert.match(child.input, /## 요청\n합계 확인해 줘/);
  assert.match(child.input, /VERDICT: PASS/);
  child.stdout.write('{"type":"thread.started","thread_id":"t"}\n{"type":"item.started","item":{"id":"i","type":"command_execution","command":"ls","status":"in_progress"}}\n');
  child.stdout.write('{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"VERDICT: PASS\\n합계가 맞습니다."}}\n');
  child.finish(0);
  await waitFor(() => runner.list()[0].status === 'done');
  assert.equal(runner.list()[0].summary, 'VERDICT: PASS 합계가 맞습니다.');
  const events = readFileSync(join(root, '.office', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => `${e.engine}:${e.agent}:${e.kind}`), ['codex:verify-1:review.start', 'codex:verify-1:tool.start', 'codex:verify-1:review.end']);
  // REVIEWS 지표·업무 판정에 쓰이는 판정값
  assert.equal(events[2].verdict, 'PASS');
  assert.equal(events[2].instance, `run-${run.id}`);
});

test('재시작 시 이전 running/queued 실행은 정리된다', () => {
  const root = makeRoot(ORG);
  mkdirSync(join(root, '.office'));
  writeFileSync(join(root, '.office', 'runs.json'), JSON.stringify([
    { id: 'old-1', target: 'chief', status: 'running', pid: 999999 },
    { id: 'old-2', target: 'chief', status: 'queued' },
    { id: 'old-3', target: 'chief', status: 'done', summary: '끝' },
  ]));
  const runner = createRunner({ root, spawnImpl: fakeSpawner().spawnImpl });
  assert.deepEqual(runner.list().map((r) => r.status), ['failed', 'stopped', 'done']);
});

test('실제 프로세스: 가짜 CLAUDE_BIN 을 프로세스 그룹째 중지(SIGTERM 무시 시 SIGKILL)', async () => {
  const root = makeRoot(ORG);
  // .js 가짜 바이너리는 process.execPath 로 실행된다(두 OS 공통)
  const bin = join(root, 'fake-claude.js');
  // SIGTERM 을 무시하고 손자 프로세스까지 띄워 그룹 종료를 확인한다
  writeFileSync(bin, `const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'grandchild.pid'))}, String(grandchild.pid));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', args: process.argv.slice(2) }) + '\\n');
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'system', subtype: 'stdin', input }) + '\\n'));
setInterval(() => {}, 1000);
`);
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  try {
    const runner = createRunner({ root, killGraceMs: 300 });
    const run = runner.start({ agentId: 'research-1', prompt: '오래 걸리는 일' });
    assert.ok(Number.isInteger(run.pid));
    const pidFile = join(root, 'grandchild.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    runner.stop(run.id);
    await waitFor(() => runner.list()[0].status === 'stopped', 5000);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitFor(() => !alive(grandchild), 3000);
    const log = readFileSync(join(root, '.office', 'runs', `${run.id}.log`), 'utf8');
    assert.match(log, /"--agent","research-1"/);
    assert.match(log, /"input":"오래 걸리는 일"/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
  }
});
