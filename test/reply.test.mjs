// 이어서 답하기: 세션 id 추출, 답변 전문 저장, 답변 필요 휴리스틱, reply 인자·상태 검사, API, 하위 호환
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, looksLikeQuestion, SESSION_PATTERN } from '../dashboard/runner.mjs';
import { buildState } from '../dashboard/state.mjs';
import { resolveCommand } from '../lib/cli.mjs';
import { latestNeedsReply, parseMarkdown, threadOf } from '../dashboard/public/app.js';

const POSIX = process.platform !== 'win32';
const SID = '534fe6fd-3f42-4ef6-a141-ec3025f2b33f';
const SID2 = '11111111-2222-4333-8444-555555555555';
const TID = '019a0000-1111-7222-8333-444444444444';
const QUESTION = [
  '중고명품 자료수집은 범위가 넓어서, 시작하기 전에 몇 가지만 확인하겠습니다.',
  '',
  '**1. 어떤 자료가 필요하세요?** (여러 개 가능)',
  '- 시장 규모와 동향',
  '',
  '**2. 지역 범위는요?** 국내만인지 알려 주세요.',
  '',
  '위 1~3번과 A/B 중 선택을 알려 주시면 바로 진행하겠습니다. 급하시면 "전부, 국내, B"처럼 짧게 답하셔도 됩니다.',
].join('\n');

const ORG = {
  departments: [
    { id: 'research', name: '리서치부', engine: 'claude', tools: ['Read', 'WebSearch'], permission: 'bypassPermissions' },
    { id: 'verify', name: '검증실', engine: 'codex' },
  ],
  roster: [
    { id: 'research-1', name: '김대리', department: 'research', title: '담당' },
    { id: 'research-2', name: '박사원', department: 'research', title: '담당' },
    { id: 'verify-1', name: '최과장', department: 'verify', title: '담당' },
  ],
};

function makeRoot(org = ORG) {
  const root = mkdtempSync(join(tmpdir(), 'office-reply-'));
  writeOrg(root, org);
  writeFileSync(join(root, 'org', 'company.json'), JSON.stringify({ chief: { engine: 'claude', model: 'sonnet', effort: 'high' } }));
  return root;
}

function writeOrg(root, { departments, roster }) {
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(roster));
}

function fakeSpawner() {
  const calls = [];
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.input = '';
    child.stdin.on('data', (c) => { child.input += c; });
    child.kill = () => true;
    child.finish = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    };
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { calls, spawnImpl };
}

const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const line = (obj) => `${JSON.stringify(obj)}\n`;

// claude stream-json 한 번 분량을 흘리고 끝낸다
async function finishClaude(runner, call, { sid = SID, text = '끝났습니다.', code = 0 } = {}) {
  call.child.stdout.write(line({ type: 'system', subtype: 'init', session_id: sid }));
  call.child.stdout.write(line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: sid }));
  call.child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid }));
  call.child.finish(code);
  await waitFor(() => runner.list().every((r) => r.status !== 'running' && r.status !== 'queued'));
}

test('looksLikeQuestion: 마지막 단락 물음표·요청 문구·번호 목록 질문, 맺음 인사는 제외', () => {
  assert.equal(looksLikeQuestion(QUESTION), true);
  assert.equal(looksLikeQuestion('조사를 마쳤습니다.\n\n진행할까요?'), true);
  assert.equal(looksLikeQuestion('초안을 만들었습니다.\n\n아래 중 하나를 선택해 주세요.'), true);
  assert.equal(looksLikeQuestion('몇 가지만 확인하겠습니다.'), true);
  assert.equal(looksLikeQuestion('1. 범위는 국내만인가요?\n2. 기한은 언제인가요?\n\n이상입니다.'), true);
  assert.equal(looksLikeQuestion("1. 범위 (권장 기본값: 국내)\n\n답장 또는 '기본값으로 진행'이라고 답하면 됩니다."), true);
  assert.equal(looksLikeQuestion('시장 규모는 3조 원입니다.'), false);
  assert.equal(looksLikeQuestion('보고서를 저장했습니다.\n\n추가로 필요한 것이 있으면 말씀해 주세요.'), false);
  assert.equal(looksLikeQuestion('출처: https://example.com/a?b=1'), false);
  assert.equal(looksLikeQuestion(''), false);
  assert.equal(looksLikeQuestion(null), false);
});

test('claude: session_id 추출·답변 전문 0600 저장·needsReply·답변 대기 이벤트, 목록에는 세션 값 대신 canReply', async () => {
  const root = makeRoot();
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  const run = runner.start({ agentId: 'research-1', prompt: '중고명품 자료수집해줘' });
  assert.equal(run.rootId, run.id);
  assert.equal(run.parentId, null);
  assert.equal(run.canReply, false);
  assert.ok(!('sessionId' in run), '응답에 세션 id 값을 내보내지 않는다');
  await finishClaude(runner, calls[0], { text: QUESTION });

  const [done] = runner.list();
  assert.equal(done.status, 'done');
  assert.equal(done.needsReply, true);
  assert.equal(done.canReply, true);
  assert.ok(!('sessionId' in done));
  assert.ok(done.summary.length <= 200, '요약은 기존처럼 짧게');

  const saved = JSON.parse(readFileSync(join(root, '.office', 'runs.json'), 'utf8'));
  assert.equal(saved[0].sessionId, SID);
  assert.equal(saved[0].rootId, run.id);
  assert.equal(saved[0].needsReply, true);

  const file = join(root, '.office', 'runs', `${run.id}.result.md`);
  assert.equal(readFileSync(file, 'utf8'), `${QUESTION}\n`);
  if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
  const r = runner.result(run.id);
  assert.equal(r.source, 'file');
  assert.equal(r.sessionId, SID);

  const events = readFileSync(join(root, '.office', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const wait = events.find((e) => e.kind === 'reply.wait');
  assert.ok(wait, '답변 대기 이벤트');
  assert.equal(wait.agent, 'research-1');
  assert.equal(wait.run, run.id);
  assert.match(wait.summary, /답하셔도 됩니다/);

  const state = buildState({ org: ORG, events, runs: runner.list(), now: Date.now() });
  assert.equal(state.metrics.needsReply, 1);
  assert.equal(state.runs[0].canReply, true);
});

test('reply(claude): 원래 직원·권한·도구·모델 유지 + --resume <uuid>, 답장에서 모델 덮어쓰기, 프롬프트는 stdin', async () => {
  const root = makeRoot();
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  const first = runner.start({ agentId: 'research-1', prompt: '조사해 줘', model: 'opus' });
  await finishClaude(runner, calls[0], { text: '범위를 정해 주세요?' });
  const cmd = resolveCommand('claude', 'CLAUDE_BIN');
  const base = [...cmd.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--agent', 'research-1', '--allowedTools', 'Read,WebSearch'];

  const second = runner.reply(first.id, { prompt: '국내만, 기본값으로 진행' });
  assert.deepEqual(calls[1].args, [...base, '--model', 'opus', '--resume', SID]);
  await tick();
  assert.equal(calls[1].child.input, '국내만, 기본값으로 진행');
  assert.equal(second.target, 'research-1');
  assert.equal(second.agentId, 'research-1');
  assert.equal(second.parentId, first.id);
  assert.equal(second.rootId, first.id);
  assert.equal(runner.list()[0].needsReply, false, '답장하면 원래 실행의 답변 필요가 풀린다');

  // 실행 중에는 같은 대화에 다시 답할 수 없다(원 실행에 답해도 409)
  assert.throws(() => runner.reply(second.id, { prompt: 'x' }), (e) => e.status === 409 && /이전 실행이 끝난 뒤/.test(e.message));
  assert.throws(() => runner.reply(first.id, { prompt: 'x' }), (e) => e.status === 409);

  // resume 이 새 세션으로 이어지면 새 id 를 쓴다
  await finishClaude(runner, calls[1], { sid: SID2, text: '진행했습니다.' });
  assert.equal(runner.list()[1].needsReply, false);
  const third = runner.reply(second.id, { prompt: '요약도 해 줘', model: 'haiku' });
  assert.deepEqual(calls[2].args, [...base, '--model', 'haiku', '--resume', SID2]);
  assert.equal(third.rootId, first.id);
  assert.equal(third.parentId, second.id);
  assert.deepEqual(threadOf(runner.list(), third.id).map((r) => r.id), [first.id, second.id, third.id]);
  assert.throws(() => runner.reply(first.id, { prompt: 'y', model: 'gpt-4' }), (e) => e.status === 400);
  calls[2].child.finish(0);
  await waitFor(() => runner.list()[2].status !== 'running');
});

test('reply(codex): codex exec -s read-only -C <root> resume --json … <thread_id> -, stdin 은 답장만', async () => {
  const root = makeRoot();
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  const first = runner.start({ agentId: 'verify-1', prompt: '합계 확인해 줘' });
  calls[0].child.stdout.write(line({ type: 'thread.started', thread_id: TID }));
  calls[0].child.stdout.write(line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'VERDICT: FIX\n원본 파일 위치를 알려 주세요.' } }));
  calls[0].child.finish(0);
  await waitFor(() => runner.list()[0].status === 'done');
  assert.equal(runner.list()[0].canReply, true);
  assert.equal(runner.list()[0].needsReply, true);
  assert.equal(JSON.parse(readFileSync(join(root, '.office', 'runs.json'), 'utf8'))[0].sessionId, TID);
  assert.match(readFileSync(join(root, '.office', 'runs', `${first.id}.result.md`), 'utf8'), /원본 파일 위치/);

  runner.reply(first.id, { prompt: 'ledger.xlsx 입니다' });
  const cmd = resolveCommand('codex', 'CODEX_BIN');
  const model = process.env.OFFICE_CODEX_MODEL || 'gpt-6.1-sol';
  const effort = process.env.OFFICE_CODEX_EFFORT || 'max';
  assert.deepEqual(calls[1].args, [...cmd.prefixArgs, 'exec', '--skip-git-repo-check', '-s', 'read-only', '-C', root, 'resume', '--json', '-m', model, '-c', `model_reasoning_effort="${effort}"`, TID, '-']);
  await tick();
  assert.equal(calls[1].child.input, 'ledger.xlsx 입니다');
  calls[1].child.finish(0);
  await waitFor(() => runner.list()[1].status !== 'running');
});

test('reply 사전 검사: 없는 run 404, 실행 중·대기 409, 세션 없음 409, 직원 삭제·휴무 400, 빈 답장 400', async () => {
  const root = makeRoot();
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl, maxConcurrent: 1 });
  assert.throws(() => runner.reply('nope', { prompt: 'x' }), (e) => e.status === 404);
  const a = runner.start({ agentId: 'research-1', prompt: 'a' });
  const b = runner.start({ agentId: 'research-2', prompt: 'b' });
  assert.equal(b.status, 'queued');
  assert.throws(() => runner.reply(a.id, { prompt: 'x' }), (e) => e.status === 409 && e.message === '이전 실행이 끝난 뒤 답할 수 있습니다.');
  assert.throws(() => runner.reply(b.id, { prompt: 'x' }), (e) => e.status === 409);
  // 세션 id 없이 끝난 실행
  calls[0].child.stdout.write(line({ type: 'result', result: '끝' }));
  calls[0].child.finish(0);
  await waitFor(() => calls.length === 2);
  assert.equal(runner.list()[0].canReply, false);
  assert.throws(() => runner.reply(a.id, { prompt: 'x' }), (e) => e.status === 409 && /세션 정보가 없어/.test(e.message));
  await finishClaude(runner, calls[1], { text: '질문이 있나요?' });
  assert.throws(() => runner.reply(b.id, { prompt: '  ' }), (e) => e.status === 400);

  // 휴무 → 400
  writeOrg(root, { departments: ORG.departments, roster: ORG.roster.map((x) => (x.id === 'research-2' ? { ...x, active: false } : x)) });
  assert.throws(() => runner.reply(b.id, { prompt: 'x' }), (e) => e.status === 400 && /휴무/.test(e.message));
  // 삭제 → 400
  writeOrg(root, { departments: ORG.departments, roster: ORG.roster.filter((x) => x.id !== 'research-2') });
  assert.throws(() => runner.reply(b.id, { prompt: 'x' }), (e) => e.status === 400 && /research-2/.test(e.message));
  // 부서 엔진이 바뀌면 세션을 이을 수 없다
  writeOrg(root, { departments: ORG.departments.map((d) => (d.id === 'research' ? { ...d, engine: 'codex' } : d)), roster: ORG.roster });
  assert.throws(() => runner.reply(b.id, { prompt: 'x' }), (e) => e.status === 400 && /엔진/.test(e.message));
  assert.equal(calls.length, 2, '거부된 답장은 실행하지 않는다');
  assert.equal(runner.list()[1].needsReply, true, '거부되면 답변 필요가 그대로 남는다');
});

test('하위 호환: sessionId 없는 기존 runs.json 은 답장 불가, 형식이 틀린 세션 값은 인자로 쓰지 않는다', () => {
  const root = makeRoot();
  mkdirSync(join(root, '.office'));
  writeFileSync(join(root, '.office', 'runs.json'), JSON.stringify([
    { id: 'old-1', target: 'chief', agentId: null, engine: 'claude', request: '예전 요청', status: 'done', summary: '예전 요약입니다?' },
    { id: 'old-2', target: 'chief', agentId: null, engine: 'claude', request: '조작', status: 'done', summary: 'x', sessionId: '--dangerously-skip-permissions' },
    { id: 'old-3', target: 'review', agentId: null, engine: 'codex', request: '검증', status: 'done', summary: 'y', sessionId: SID },
  ]));
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root, spawnImpl });
  const list = runner.list();
  assert.deepEqual(list.map((r) => [r.canReply, r.needsReply, r.parentId, r.rootId]), [
    [false, false, null, 'old-1'], [false, false, null, 'old-2'], [false, false, null, 'old-3']]);
  assert.ok(list.every((r) => !('sessionId' in r)));
  for (const id of ['old-1', 'old-2', 'old-3']) assert.throws(() => runner.reply(id, { prompt: 'x' }), (e) => e.status === 409);
  assert.equal(calls.length, 0);
  assert.deepEqual(runner.result('old-1'), { text: '예전 요약입니다?', source: 'summary', engine: 'claude', sessionId: null });
  assert.equal(SESSION_PATTERN.test('--resume'), false);
  assert.equal(buildState({ org: ORG, events: [], runs: list }).metrics.needsReply, 0);
});

test('화면 보조 함수: 대화 묶음·가장 최근 답변 필요·안전한 마크다운 블록', () => {
  const runs = [
    { id: 'a', createdAt: '2026-10-29T01:00:00Z', status: 'done', needsReply: false },
    { id: 'c', rootId: 'a', parentId: 'b', createdAt: '2026-10-29T03:00:00Z', status: 'done', needsReply: true, endedAt: '2026-10-29T03:01:00Z' },
    { id: 'b', rootId: 'a', parentId: 'a', createdAt: '2026-10-29T02:00:00Z', status: 'done' },
    { id: 'x', createdAt: '2026-10-29T00:00:00Z', status: 'done', needsReply: true, endedAt: '2026-10-29T00:01:00Z' },
    { id: 'y', createdAt: '2026-10-29T04:00:00Z', status: 'running', needsReply: true },
  ];
  assert.deepEqual(threadOf(runs, 'b').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(threadOf(runs, 'x').map((r) => r.id), ['x']);
  assert.deepEqual(threadOf(runs, 'none'), []);
  assert.equal(latestNeedsReply(runs).id, 'c');
  assert.equal(latestNeedsReply([]), null);
  const blocks = parseMarkdown('## 질문\n\n**1. 범위는요?** <img src=x onerror=alert(1)>\n- `국내`\n\n3. 셋\n4. 넷');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'para', 'list', 'list']);
  // 태그처럼 보이는 문자열도 그대로 텍스트 조각으로 남는다(화면은 textContent로 넣는다)
  assert.deepEqual(blocks[1].inline, [{ t: 'b', v: '1. 범위는요?' }, { t: 'text', v: ' <img src=x onerror=alert(1)>' }]);
  assert.deepEqual(blocks[2].items, [[{ t: 'code', v: '국내' }]]);
  assert.equal(blocks[3].start, 3);
});

test('화면 계약: 대화 모달·답장 입력·답변 필요 칩, 답변 전문은 innerHTML에 넣지 않는다', () => {
  const html = readFileSync(new URL('../dashboard/public/index.html', import.meta.url), 'utf8');
  for (const id of ['threadDialog', 'threadForm', 'threadList', 'threadPrompt', 'threadModel', 'threadSend', 'threadStatus']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} 없음`);
  }
  const src = readFileSync(new URL('../dashboard/public/app.js', import.meta.url), 'utf8');
  assert.match(src, /\/api\/runs\/\$\{encodeURIComponent\(latest\.id\)\}\/reply/);
  assert.match(src, /\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}\/result/);
  assert.match(src, /data-act="open-thread"/);
  assert.match(src, /님이 답변을 기다립니다/);
  assert.match(src, /'threadSend', 'threadPrompt', 'threadModel'/, '데모 모드에서 보내기 비활성');
  const thread = src.slice(src.indexOf('// ───── 대화 보기'), src.indexOf('// ───── 계정 연결'));
  assert.ok(thread.length > 0);
  assert.doesNotMatch(thread, /innerHTML/, '대화 영역은 DOM API(textContent)로만 그린다');
});

test('실제 프로세스: 가짜 CLAUDE_BIN 으로 첫 실행 → 답변 필요 → --resume 답장', async () => {
  const root = makeRoot();
  const bin = join(root, 'fake-claude.js');
  writeFileSync(bin, `const args = process.argv.slice(2);
const i = args.indexOf('--resume');
const sid = i >= 0 ? args[i + 1] : ${JSON.stringify(SID)};
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: sid, args });
  const text = i >= 0 ? '받은 답장: ' + input + '\\n\\n진행했습니다.' : '몇 가지만 확인하겠습니다.\\n\\n1. 범위는요? (권장 기본값: 국내)';
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
});
`);
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  try {
    const runner = createRunner({ root });
    const first = runner.start({ agentId: 'research-1', prompt: '자료 모아 줘' });
    await waitFor(() => runner.list()[0].status === 'done');
    assert.equal(runner.list()[0].needsReply, true);
    const second = runner.reply(first.id, { prompt: '기본값으로 진행' });
    await waitFor(() => runner.list()[1]?.status === 'done');
    const log = readFileSync(join(root, '.office', 'runs', `${second.id}.log`), 'utf8');
    assert.match(log, new RegExp(`"--resume","${SID}"`));
    assert.equal(runner.result(second.id).text, '받은 답장: 기본값으로 진행\n\n진행했습니다.\n');
    assert.equal(runner.list()[1].needsReply, false);
    assert.equal(runner.list()[1].canReply, true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
  }
});

// ---- HTTP API ----
function request(base, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 텍스트 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

test('API: GET /api/runs/:id/result(토큰), POST /api/runs/:id/reply(토큰·Origin), state 의 canReply·needsReply·metrics', async (t) => {
  const root = makeRoot();
  mkdirSync(join(root, '.office', 'runs'), { recursive: true });
  writeFileSync(join(root, '.office', 'runs.json'), JSON.stringify([
    { id: 'q-1', target: 'chief', agentId: null, engine: 'claude', request: '자료 모아 줘', status: 'done', createdAt: '2026-10-29T07:31:34.597Z', summary: '요약', sessionId: SID, rootId: 'q-1', parentId: null, needsReply: true, model: null },
    { id: 'old-1', target: 'chief', agentId: null, engine: 'claude', request: '예전', status: 'done', summary: '예전 요약' },
  ]));
  writeFileSync(join(root, '.office', 'runs', 'q-1.result.md'), QUESTION);
  const publicDir = join(root, 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><meta name="office-token" content="__OFFICE_TOKEN__"><title>t</title>');
  const bin = join(root, 'fake-claude.js');
  writeFileSync(bin, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:${JSON.stringify(SID)},args:process.argv.slice(2)})+'\\n');process.stdout.write(JSON.stringify({type:'result',result:'진행했습니다.',session_id:${JSON.stringify(SID)}})+'\\n');});`);
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  const { startServer } = await import('../dashboard/server.mjs');
  const handle = await startServer({ root, port: 0, publicDir, quiet: true });
  t.after(async () => {
    await handle.close();
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  assert.notEqual(handle.port, 4777);
  const base = `http://127.0.0.1:${handle.port}`;
  const auth = { 'X-Office-Token': handle.token, Origin: base, 'Content-Type': 'application/json' };

  const state = await request(base, 'GET', '/api/state');
  assert.equal(state.json.metrics.needsReply, 1);
  const [q, old] = state.json.runs;
  assert.deepEqual([q.canReply, q.needsReply, q.parentId, q.rootId], [true, true, null, 'q-1']);
  assert.deepEqual([old.canReply, old.needsReply, old.rootId], [false, false, 'old-1']);
  assert.ok(!state.text.includes(SID), '상태에는 세션 id 값을 싣지 않는다');

  assert.equal((await request(base, 'GET', '/api/runs/q-1/result')).status, 403);
  const res = await request(base, 'GET', '/api/runs/q-1/result', { headers: { 'X-Office-Token': handle.token } });
  assert.equal(res.status, 200);
  assert.equal(res.text, QUESTION);
  assert.equal(res.headers['x-session-id'], SID);
  assert.equal(res.headers['x-result-source'], 'file');
  const oldRes = await request(base, 'GET', '/api/runs/old-1/result', { headers: { 'X-Office-Token': handle.token } });
  assert.equal(oldRes.text, '예전 요약');
  assert.equal(oldRes.headers['x-session-id'], undefined);
  assert.equal((await request(base, 'GET', '/api/runs/zzz/result', { headers: { 'X-Office-Token': handle.token } })).status, 404);

  assert.equal((await request(base, 'POST', '/api/runs/q-1/reply', { body: { prompt: 'x' }, headers: { Origin: base, 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await request(base, 'POST', '/api/runs/q-1/reply', { body: { prompt: 'x' }, headers: { ...auth, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request(base, 'POST', '/api/runs/q-1/reply', { body: { prompt: ' ' }, headers: auth })).status, 400);
  assert.equal((await request(base, 'POST', '/api/runs/old-1/reply', { body: { prompt: 'x' }, headers: auth })).status, 409);
  assert.equal((await request(base, 'POST', '/api/runs/q-1/reply', { body: { prompt: 'x', model: 'gpt-4' }, headers: auth })).status, 400);

  const ok = await request(base, 'POST', '/api/runs/q-1/reply', { body: { prompt: '기본값으로 진행', model: 'sonnet' }, headers: auth });
  assert.equal(ok.status, 202);
  assert.equal(ok.json.parentId, 'q-1');
  assert.equal(ok.json.rootId, 'q-1');
  assert.ok(!('sessionId' in ok.json));
  await waitFor(() => existsSync(join(root, '.office', 'runs', `${ok.json.id}.result.md`)));
  const after = await request(base, 'GET', '/api/state');
  assert.equal(after.json.metrics.needsReply, 0);
  const log = readFileSync(join(root, '.office', 'runs', `${ok.json.id}.log`), 'utf8');
  assert.match(log, new RegExp(`"--model","sonnet","--effort","high","--resume","${SID}"`));
});
