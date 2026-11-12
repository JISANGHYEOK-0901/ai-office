import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../dashboard/runner.mjs';

// 비서실장은 Claude(구조화 응답), 최종 검토는 Codex, 직원 biz-1은 Aside(aside exec --json)로 응답하는 가짜 실행
function fixture(t, { plan: planOf, staff, publish, outbound: extraOutbound = {}, staffFile = '작성 완료' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-aside-orch-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'biz', name: '제휴사업부', engine: 'claude' }, { id: 'res', name: '리서치부', engine: 'claude' }]));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([
    { id: 'biz-1', name: '신제안', department: 'biz', engine: 'aside' },
    { id: 'res-1', name: '박조사', department: 'res' },
  ]));
  const fake = join(root, 'fake-aside.mjs'); writeFileSync(fake, '');
  const calls = [];
  let task = null;
  const spawnImpl = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    const end = (out, code = 0) => { child.stdout.end(out); child.stderr.end(); setImmediate(() => child.emit('close', code, null)); };
    // Aside 직원: 지시문은 마지막 인자다(표준 입력을 쓰지 않는다)
    if (args[0] === fake) {
      const prompt = args.at(-1);
      const call = { kind: args.includes('list') ? 'aside-list' : 'aside', args, input: prompt };
      calls.push(call);
      setImmediate(() => {
        if (call.kind === 'aside-list') return end(JSON.stringify({ sessions: [] }));
        const answer = /외부 작업 1건을 Aside 브라우저/.test(prompt) ? publish(prompt) : staff(prompt);
        end(JSON.stringify({ session: { id: 's' }, outcome: 'completed', answer, error: null }) + '\n');
      });
      return child;
    }
    let input = '';
    child.stdin.on('data', (d) => { input += d; });
    child.stdin.on('finish', () => setImmediate(() => {
      const schemaArg = args.includes('--json-schema') ? JSON.parse(args[args.indexOf('--json-schema') + 1]) : null;
      const schema = schemaArg ? (schemaArg.properties.plan ? 'plan' : schemaArg.properties.revisedPlan ? 'progress' : schemaArg.properties.verdict ? 'review' : 'other') : (args[args.indexOf('--output-schema') + 1] || '').replace(/.*[\\/]|\.json$/g, ''); // Windows 경로(\)도 파일 이름만 남긴다
      const call = { kind: schema || 'other', args, input };
      calls.push(call);
      let value;
      if (call.kind === 'plan') { task = input.match(/업무 id: ([\d-]+\/run-[\w-]+)\./)?.[1]; value = { plan: planOf(task), question: '', needsMeeting: false, meetingAgents: [], rerunStages: [] }; }
      else if (call.kind === 'progress') value = { action: 'continue', reason: '계획대로', question: '', revisedPlan: null };
      else if (call.kind === 'review') value = { verdict: 'pass', stage: '', reason: '확인', report: '# 결과\n\n확인했습니다.\n\n확인 필요: 없음', question: '' };
      else {
        // Claude 직원 단계: 지시의 출력 경로에 파일을 쓰고 끝낸다(실제 직원처럼 응답 전에 산출물이 있어야 한다)
        const output = [...input.matchAll(/\n출력: ([^\n]+)/g)].at(-1)?.[1];
        if (output && root) { const file = join(root, output); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, staffFile); }
        value = { status: 'done', summary: 'ok' };
      }
      const text = JSON.stringify(value);
      if (schemaArg) end(JSON.stringify({ type: 'result', structured_output: value, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      else end(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
    }));
    return child;
  };
  const delivered = [];
  const outbound = { connections: () => [], requestLogin: async () => ({ status: 'connected' }), asideCheckLogin: async ({ target }) => { calls.push({ kind: 'aside-login', target }); return { status: 'ok' }; },
    deliver: async (args) => { delivered.push(args); await args.execute(null, { files: [] }); return { status: 'confirmed', method: 'aside', resultUrl: args.publication.target }; },
    ...extraOutbound };
  const tools = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } };
  const runner = createRunner({ root, spawnImpl, outbound, toolStatus: () => tools, env: { ...process.env, ASIDE_BIN: fake }, aside: { stopSessions: async () => 0 } });
  t.after(() => runner.stopAll({ graceMs: 10 }));
  const final = async (run) => {
    const until = Date.now() + 15000;
    while (['running', 'queued'].includes(runner.list().find((r) => r.id === run.id)?.status)) {
      if (Date.now() > until) throw new Error('가짜 실행 시간 초과');
      await new Promise((r) => setTimeout(r, 10));
    }
    return runner.list().find((r) => r.id === run.id);
  };
  return { root, calls, delivered, runner, final, task: () => task };
}

const stage = (task, id, agent, dept, extra = {}) => ({ id, dept, agent, title: id, inputs: [], output: `outputs/${task}/${dept}/${agent}-${id}.md`, done: '목록을 정리한다', dependsOn: [], connection: '', target: '', ...extra });

test('Aside 직원의 사이트 조회: 대표 Aside 로그인을 확인하고, 응답 content를 실행기가 산출물로 저장한다', async (t) => {
  const f = fixture(t, {
    plan: (task) => ({ version: 1, task, goal: '회원 글 조회', stages: [stage(task, 'a', 'biz-1', 'biz', { connection: 'aside', target: 'https://cafe.naver.com/petdilab' })], review: { by: 'chief', criteria: '목록 확인' }, gaps: [], publications: [], deliverables: ['a'] }),
    staff: () => JSON.stringify({ status: 'done', summary: '3건', content: '# 회원 글\n\n- 글 1 (조회 1.3K)\n- 글 2\n- 글 3' }),
  });
  const result = await f.final(f.runner.start({ prompt: '꼬리별관측소 https://cafe.naver.com/petdilab 에서 아이스베어 회원 최근 글 3개 정리해줘' }));
  assert.equal(result.status, 'done', result.summary);
  const staffCall = f.calls.find((c) => c.kind === 'aside');
  assert.match(staffCall.input, /사이트 조회\(Aside\)/);
  assert.match(staffCall.input, /content에 출력 파일/);
  assert.doesNotMatch(staffCall.input, /office_browser/, 'Aside 직원에게 office_browser 도구 안내를 주지 않는다');
  assert.ok(f.calls.some((c) => c.kind === 'aside-login' && c.target === 'https://cafe.naver.com/petdilab'), '조회 전에 Aside 로그인을 확인한다');
  const plan = f.calls.find((c) => c.kind === 'plan');
  assert.match(plan.input, /Aside 브라우저 직원\(엔진 aside\)/);
  assert.equal(readFileSync(join(f.root, 'outputs', ...f.task().split('/'), 'biz', 'biz-1-a.md'), 'utf8'), '# 회원 글\n\n- 글 1 (조회 1.3K)\n- 글 2\n- 글 3\n');
});

test('Aside 직원에게 공개 웹 조사·파일 산출물을 배정하면 실행하지 않고 계획을 고치게 한다', async (t) => {
  let plans = 0;
  const f = fixture(t, {
    plan: (task) => { plans++; return plans === 1
      ? { version: 1, task, goal: '조사', stages: [stage(task, 'a', 'biz-1', 'biz', { connection: 'public', target: 'https://news.example.com/' })], review: { by: 'chief', criteria: 'x' }, gaps: [], publications: [], deliverables: ['a'] }
      : { version: 1, task, goal: '조사', stages: [stage(task, 'a', 'res-1', 'res')], review: { by: 'chief', criteria: 'x' }, gaps: [], publications: [], deliverables: ['a'] }; },
    staff: () => { throw new Error('Aside 직원이 실행되면 안 됨'); },
  });
  const result = await f.final(f.runner.start({ prompt: '뉴스 10개 수집해줘' }));
  assert.equal(f.calls.filter((c) => c.kind === 'aside').length, 0);
  assert.ok(plans >= 2, '계획을 다시 세운다');
  assert.ok(f.calls.filter((c) => c.kind === 'plan').at(-1).input.includes('Aside 직원이 맡지 않습니다'));
  assert.notEqual(result.status, 'running');
});

test('Aside 직원의 댓글: 실행기가 engine:aside로 전달하고, 검토된 원문을 그대로 넣는 Aside 지시문을 만든다', async (t) => {
  const target = 'https://cafe.naver.com/f-e/cafes/31520563/articles/10969';
  const f = fixture(t, {
    plan: (task) => ({ version: 1, task, goal: '댓글', stages: [stage(task, 'a', 'res-1', 'res', { output: `outputs/${task}/res/res-1-a.md` })], review: { by: 'chief', criteria: '문구 확인' }, gaps: [], deliverables: [],
      publications: [{ id: 'c1', action: 'comment', service: 'naver_cafe', connection: 'aside', agent: 'biz-1', target, recipients: [], subject: '', content: 'a', instructions: '', files: [], attachments: [] }] }),
    staff: () => { throw new Error('조사 단계는 Claude 직원'); },
    publish: () => JSON.stringify({ status: 'done', submitted: true, summary: '등록' }),
    // 조사 단계는 Claude 직원(res-1)이 댓글 원문 파일을 쓴다
    staffFile: '잘 보고 갑니다 :)',
  });
  const result = await f.final(f.runner.start({ prompt: `${target} 글에 "잘 보고 갑니다 :)" 댓글 달아줘. 끝까지 자동으로 진행해` }));
  const out = join(f.root, 'outputs', ...f.task().split('/'), 'res', 'res-1-a.md');
  assert.equal(f.delivered.length, 1, result.summary);
  assert.equal(f.delivered[0].engine, 'aside');
  const publishCall = f.calls.find((c) => c.kind === 'aside' && /외부 작업 1건/.test(c.input));
  assert.match(publishCall.input, /<<<본문\n잘 보고 갑니다 :\)\n본문>>>/);
  assert.match(publishCall.input, /정확히 한 번만/);
  assert.ok(existsSync(out));
});

test('빠른 조회가 로그인 서비스 주소를 다루면 처음부터 Aside 직원에게 맡긴다(다른 직원을 거치지 않음)', async (t) => {
  const f = fixture(t, {
    plan: () => { throw new Error('빠른 조회는 계획을 세우지 않는다'); },
    staff: () => JSON.stringify({ status: 'done', summary: '5건', content: '# 최근 글\n\n- 글 1' }),
  });
  const result = await f.final(f.runner.start({ prompt: 'https://cafe.naver.com/petdilab 에서 홍시주스 회원 최근 글 5개 정리해줘', intent: { quick: true, quickAgent: 'res-1', actions: [] } }));
  assert.equal(result.status, 'done', result.summary);
  assert.equal(f.calls.filter((c) => c.kind === 'plan').length, 0);
  const staffCall = f.calls.find((c) => c.kind === 'aside');
  assert.match(staffCall.input, /사이트 조회\(Aside\): .*https:\/\/cafe\.naver\.com\/petdilab/);
  assert.ok(!f.calls.some((c) => c.kind === 'other'), 'Claude 직원(res-1)을 먼저 부르지 않는다');
});

