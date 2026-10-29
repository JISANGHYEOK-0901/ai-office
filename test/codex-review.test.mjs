import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'codex-review.mjs');

// 실측 codex exec --json 스트림을 재생하는 가짜 바이너리.
// 프롬프트(stdin)에 든 검토자 id 로 판정을 바꾸고, 시작·종료 시각과 인자를 기록한다.
// .js 파일이라 CODEX_BIN 으로 주면 process.execPath 가 실행한다(두 OS 공통).
const FAKE_CODEX = `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const log = process.env.FAKE_LOG;
const id = (prompt.match(/\\(([a-z0-9-]+)\\)이다/) || [])[1] || 'unknown';
appendFileSync(log, JSON.stringify({ id, at: 'start', t: Date.now(), args, prompt }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (id === 'broken-1') { process.stderr.write('model error'); process.exit(3); }
out({ type: 'thread.started', thread_id: 'th-' + id });
out({ type: 'turn.started' });
out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'bash -lc "cat report.md"', status: 'in_progress' } });
setTimeout(() => {
  out({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'bash -lc "cat report.md"', status: 'completed' } });
  const verdict = id === 'blocker-1' ? 'BLOCK' : id === 'vague-1' ? null : 'PASS';
  const text = verdict ? 'VERDICT: ' + verdict + '\\n- [중] report.md:3 — 출처 누락' : '판정 줄 없이 쓴 답변';
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
  // 잘린 JSON 이나 모르는 type 은 무시돼야 한다
  out({ type: 'unknown.kind' });
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}');
  appendFileSync(log, JSON.stringify({ id, at: 'end', t: Date.now() }) + '\\n');
}, 250);
`;

function setup({ roster, departments, presets }) {
  const root = mkdtempSync(join(tmpdir(), 'office-review-'));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(departments ?? []));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(roster ?? []));
  if (presets) writeFileSync(join(root, 'org', 'presets.json'), JSON.stringify(presets));
  const target = join(root, 'outputs', '2026-10-29', 'scan');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'report.md'), '# 보고서\n');
  const bin = join(root, 'fake-codex.js');
  writeFileSync(bin, FAKE_CODEX);
  return { root, bin, target, log: join(root, 'fake.log') };
}

function run(args, env) {
  return new Promise((done) => {
    const base = { ...process.env };
    delete base.OFFICE_CODEX_MODEL;
    delete base.OFFICE_CODEX_EFFORT;
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

const verifyDept = { id: 'verify', name: '검증실', engine: 'codex' };
const member = (id) => ({ id, name: `${id} 담당`, department: 'verify', title: '담당', instructions: `${id} 관점 지침` });

test('검토자별 codex 실행: 이벤트 변환, 리뷰 파일 저장, BLOCK 이면 종료 코드 2', async () => {
  const env = setup({ departments: [verifyDept], roster: [member('fact-1'), member('blocker-1'), member('vague-1'), member('num-1')] });
  const res = await run(['--target', 'outputs/2026-10-29/scan', '--task', '2026-10-29/scan'],
    { AI_OFFICE_ROOT: env.root, CODEX_BIN: env.bin, FAKE_LOG: env.log });
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stdout, /fact-1: PASS/);
  assert.match(res.stdout, /blocker-1: BLOCK/);
  assert.match(res.stdout, /vague-1: FIX/); // 판정 파싱 실패 → FIX
  assert.match(res.stdout, /PASS 2 · FIX 1 · BLOCK 1 · ERROR 0/);

  const review = readFileSync(join(env.target, 'reviews', 'fact-1.md'), 'utf8');
  assert.ok(review.startsWith('VERDICT: PASS'));

  // codex 인자: exec --json -s read-only -C <root> -m <기본 모델> -c model_reasoning_effort="max" -  (프롬프트는 stdin)
  const calls = readFileSync(env.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const start = calls.find((c) => c.at === 'start');
  assert.deepEqual(start.args, ['exec', '--json', '-s', 'read-only', '-C', env.root, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="max"', '-']);
  assert.match(start.prompt, /VERDICT: PASS/);
  assert.match(start.prompt, /outputs\/2026-10-29\/scan/);

  // 동시 실행은 최대 3개
  let live = 0;
  let peak = 0;
  for (const c of calls.sort((a, b) => a.t - b.t || (a.at === 'end' ? -1 : 1))) {
    live += c.at === 'start' ? 1 : -1;
    peak = Math.max(peak, live);
  }
  assert.equal(peak, 3);

  const events = readFileSync(join(env.root, '.office', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const mine = events.filter((e) => e.agent === 'fact-1');
  assert.deepEqual(mine.map((e) => e.kind), ['review.start', 'tool.start', 'tool.end', 'turn.end', 'review.end']);
  assert.ok(mine.every((e) => e.engine === 'codex' && e.task === '2026-10-29/scan'));
  assert.equal(mine[1].tool, 'Bash');
  assert.equal(events.find((e) => e.agent === 'blocker-1' && e.kind === 'review.end').verdict, 'BLOCK');
});

test('codex 실패·실행 파일 없음 → verdict ERROR 와 이유', async () => {
  const env = setup({ departments: [verifyDept], roster: [member('broken-1')] });
  const res = await run(['--target', env.target], { AI_OFFICE_ROOT: env.root, CODEX_BIN: env.bin, FAKE_LOG: env.log });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /broken-1: ERROR/);
  const events = readFileSync(join(env.root, '.office', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const end = events.find((e) => e.kind === 'review.end');
  assert.equal(end.verdict, 'ERROR');
  assert.match(end.summary, /종료 코드 3/);

  const missing = await run(['--target', env.target], { AI_OFFICE_ROOT: env.root, CODEX_BIN: join(env.root, 'no-such-codex') });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /찾지 못했습니다/);
  assert.ok(!existsSync(join(env.target, 'reviews', 'broken-1.md')));
});

test('--dry-run: codex 를 실행하지 않고 프롬프트만, 정본이 없으면 프리셋 검증실 직무 사용', async () => {
  const env = setup({
    presets: { departments: [
      { id: 'research', name: '리서치부', engine: 'claude', roles: [{ key: 'market', specialty: '시장', instructions: '조사' }] },
      { id: 'verify', name: '검증실', engine: 'codex', roles: [
        { key: 'fact-checker', name: '사실 확인', specialty: '사실 검증', instructions: '주장마다 출처를 대조한다.' },
        { key: 'number-auditor', name: '숫자 감사', specialty: '숫자 검증', instructions: '합계를 다시 계산한다.' },
      ] },
    ] },
  });
  const res = await run(['--target', 'outputs/2026-10-29/scan', '--reviewers', 'number-auditor', '--dry-run'],
    { AI_OFFICE_ROOT: env.root, CODEX_BIN: env.bin, FAKE_LOG: env.log });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /===== number-auditor \(presets\) =====/);
  assert.match(res.stdout, /합계를 다시 계산한다/);
  assert.doesNotMatch(res.stdout, /fact-checker/);
  assert.ok(!existsSync(env.log), 'dry-run 은 codex 를 실행하지 않는다');
  assert.ok(!existsSync(join(env.root, '.office', 'events.jsonl')));
});

test('인자 오류: 대상 없음·알 수 없는 검토자·검토자 없음은 종료 코드 1', async () => {
  const env = setup({ departments: [verifyDept], roster: [member('fact-1')] });
  const base = { AI_OFFICE_ROOT: env.root, CODEX_BIN: env.bin, FAKE_LOG: env.log };
  const noTarget = await run([], base);
  assert.equal(noTarget.code, 1);
  assert.match(noTarget.stderr, /--target/);
  const missingDir = await run(['--target', 'outputs/none'], base);
  assert.equal(missingDir.code, 1);
  assert.match(missingDir.stderr, /검토 대상 폴더가 없습니다/);
  const unknown = await run(['--target', env.target, '--reviewers', 'ghost', '--dry-run'], base);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /알 수 없는 검토자입니다: ghost/);

  const empty = setup({});
  const none = await run(['--target', empty.target, '--dry-run'], { AI_OFFICE_ROOT: empty.root });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /검증실 직원이 없습니다/);
});

test('모델·추론 강도: 부서 codexModel/codexEffort < --effort < 환경변수, 잘못된 값은 거부', async () => {
  const dept = { ...verifyDept, codexModel: 'gpt-6.1-mini', codexEffort: 'high' };
  const env = setup({ departments: [dept], roster: [member('fact-1')] });
  const base = { AI_OFFICE_ROOT: env.root, CODEX_BIN: env.bin, FAKE_LOG: env.log };
  const fromDept = await run(['--target', env.target], base);
  assert.equal(fromDept.code, 0, fromDept.stderr);
  const flagged = await run(['--target', env.target, '--effort', 'low'], base);
  assert.equal(flagged.code, 0, flagged.stderr);
  const fromEnv = await run(['--target', env.target, '--effort', 'low'], { ...base, OFFICE_CODEX_MODEL: 'gpt-x', OFFICE_CODEX_EFFORT: 'medium' });
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  const starts = readFileSync(env.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.at === 'start');
  assert.deepEqual(starts.map((c) => c.args.slice(6, 10)), [
    ['-m', 'gpt-6.1-mini', '-c', 'model_reasoning_effort="high"'],
    ['-m', 'gpt-6.1-mini', '-c', 'model_reasoning_effort="low"'],
    ['-m', 'gpt-x', '-c', 'model_reasoning_effort="medium"'],
  ]);
  const bad = await run(['--target', env.target, '--effort', 'turbo'], base);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--effort/);
});
