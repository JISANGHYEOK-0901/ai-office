import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRunner } from '../dashboard/runner.mjs';
import { loadSettings, saveSettings } from '../lib/settings.mjs';
import { loadTasks, updateTask } from '../lib/tasks.mjs';
import { ConnectionRequired } from '../lib/browser-session.mjs';
import { threadOf, usageLabel } from '../dashboard/public/app.js';

const ORG = {
  departments: [
    { id: 'marketing', name: '마케팅부', engine: 'codex', codexRole: 'exec', codexModel: 'gpt-6.1-sol', codexEffort: 'high' },
    { id: 'dev', name: '개발부', engine: 'codex', codexRole: 'exec' },
    { id: 'verify', name: '검증실', engine: 'codex', codexRole: 'review' },
  ],
  roster: [
    { id: 'research-1', name: '김대리', department: 'marketing', codexModel: 'gpt-6-luna', codexEffort: 'medium' },
    { id: 'dev-1', name: '이대리', department: 'dev' },
    { id: 'review-1', name: '박과장', department: 'verify' },
  ],
};
const waitFor = async (fn) => {
  // 느린 CI(Windows)에서도 여러 업무 동시 실행이 끝나도록 넉넉히 기다린다(조건이 맞으면 바로 끝남)
  const until = Date.now() + 15000;
  while (!fn()) {
    if (Date.now() > until) throw new Error('가짜 실행 시간 초과');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-orchestration-'));
  mkdirSync(join(root, 'org'));
  const org = structuredClone(ORG);
  if (options.allClaude) org.departments.filter((d) => d.codexRole === 'exec').forEach((d) => { d.engine = 'claude'; });
  if (options.handoffRequired) Object.assign(org.departments[0], { handoffPolicy: 'required', handoffs: ['dev'] });
  if (options.delegate) { org.roster[0].lead = true; org.roster.push({ id: 'research-2', name: '박사원', department: 'marketing' }); }
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify(org.departments));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify(options.noReviewers ? org.roster.filter((a) => a.department !== 'verify') : org.roster));
  if (options.workspaceInput) {
    mkdirSync(join(root, '.office', 'simulation-inputs'), { recursive: true });
    writeFileSync(join(root, '.office', 'simulation-inputs', 'market.json'), '{"source":"fixture"}');
  }
  const calls = [];
  const counts = { plan: 0, review: 0, meeting: 0, a: 0, b: 0 };
  let paused = false;
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let input = '', closed = false;
    const finish = (text, code = 0) => {
      if (closed) return;
      closed = true;
      if (text !== null) {
        if (args.includes('--json-schema')) child.stdout.write(JSON.stringify({ type: 'result', structured_output: (() => { try { return JSON.parse(text); } catch { return { status: 'done', summary: text }; } })(), usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.01 }) + '\n');
        else {
        child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
        child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 2 } }) + '\n');
        }
      }
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    };
    child.kill = () => { finish(null, 1); return true; };
    const call = { args, opts, child, input: null, kind: null };
    calls.push(call);
    child.stdin.on('data', (data) => { input += data; });
    child.stdin.on('finish', () => setImmediate(() => {
      call.input = input;
      const schema = args.includes('--json-schema') ? (JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.plan ? 'plan.json' : JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.status ? 'stage.json' : JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.verdict ? 'review.json' : JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.revisedPlan ? 'progress.json' : 'route.json') : args[args.indexOf('--output-schema') + 1] || '';
      if (schema.endsWith('plan.json')) {
        call.kind = 'plan'; counts.plan++;
        const task = input.match(/업무 id: ([\d-]+\/run-[\w-]+)\./)?.[1];
        const stage = (id, dept, agent, dependsOn) => ({ id, dept, agent, title: id,
          inputs: dependsOn, output: `outputs/${task}/${dept}/${agent}-${id}.txt`, done: '내용을 작성한다', dependsOn });
        const plan = { version: 1, task, goal: '자료를 조사하고 HTML 초안을 작성한다',
          stages: [stage('a', 'marketing', 'research-1', []), stage('b', 'dev', 'dev-1', ['a'])],
          review: { by: options.reviewBy || 'chief', criteria: '근거와 산출물을 확인한다' }, gaps: [] };
        if (options.workspaceInput) plan.stages[0].inputs = ['.office/simulation-inputs/market.json'];
        if (options.publication) plan.publications = [{ id: 'publish', action: 'post', service: 'naver_blog', connection: '', agent: 'dev-1', target: 'https://blog.naver.com/fixture', recipients: [], subject: '자료', content: 'b' }];
        if (options.siteStage) Object.assign(plan.stages[0], { connection: 'erp-1', target: 'https://erp.example.com/erp' });
        if (options.webPublication) plan.publications = [{ id: 'upload', action: 'web', service: 'web', connection: 'erp-1', agent: 'dev-1', target: 'https://erp.example.com/erp/proposal-pages', recipients: [], subject: '', content: '', instructions: '업체 ai-office-test를 추가하고 HTML을 업로드한다', files: ['b'] }];
        if (options.independent) plan.stages.push(stage('c', 'dev', 'dev-1', []));
        if (options.relativePaths) for (const stage of plan.stages) stage.output = `${stage.dept}/${stage.agent}-${stage.id}.txt`;
        if (counts.plan <= (options.invalidPlans || 0)) plan.stages[0].agent = 'missing';
        finish(JSON.stringify({ plan, question: options.question || (options.planQuestion && counts.plan === 1 ? '대상 지역을 알려 주세요.' : ''),
          needsMeeting: options.meeting && counts.plan === 1, meetingAgents: ['research-1', 'dev-1'],
          rerunStages: counts.plan > 1 && options.feedback ? ['b'] : [] }));
      } else if (schema.endsWith('progress.json')) {
        call.kind = 'progress'; counts.progress = (counts.progress || 0) + 1;
        finish(JSON.stringify(options.progress ? options.progress(counts.progress, input) : { action: 'continue', reason: '계획대로 진행', question: '', revisedPlan: null }));
      } else if (schema.endsWith('route.json')) {
        call.kind = 'route'; finish(JSON.stringify({ department: 'dev', agent: 'dev-1', reason: '개발부 소관', question: '' }));
      } else if (schema.endsWith('review.json')) {
        call.kind = 'review'; counts.review++;
        if (options.review) { finish(JSON.stringify({ stage: '', stages: [], reason: '', report: '# 결과\n\n산출물과 근거를 확인했습니다.\n\n확인 필요: 없음', question: '', revisedPlan: null, ...options.review(counts.review, input) })); return; }
        const reject = counts.review <= (options.rejects || 0);
        finish(JSON.stringify({ verdict: options.reviewQuestion && counts.review === 1 ? 'question' : reject ? 'reject' : 'pass', stage: 'a', reason: '근거 확인',
          report: '# 결과\n\n산출물과 근거를 확인했습니다.\n\n확인 필요: 없음', question: options.reviewQuestion && counts.review === 1 ? '보고서 공개 범위를 알려 주세요.' : '' }));
      } else {
        const output = [...input.matchAll(/\n출력: ([^\n]+)/g)].at(-1)?.[1];
        if (output) {
          const id = /-a\.txt$/.test(output) ? 'a' : /-c\.txt$/.test(output) ? 'c' : 'b';
          counts[id] ||= 0;
          call.kind = id; counts[id]++;
          if (options.staffDecision && id === 'a' && counts.a === 1) { finish(JSON.stringify({ status: 'needs_decision', question: '대상 지역과 예산을 알려 주세요.', summary: '' })); return; }
          if (options.reroute && id === 'a' && counts.a === 1) { finish(JSON.stringify({ status: 'reroute', department: 'dev', agent: 'dev-1', reason: '개발부 업무가 오전달됨' })); return; }
          if (options.delegate && id === 'a' && counts.a === 1) {
            const task = output.match(/^outputs\/(.*)\/marketing\//)[1];
            finish(JSON.stringify({ status: 'delegate', assignments: [{ agent: options.invalidDelegate ? 'dev-1' : 'research-2', title: '기초 자료 수집', output: `outputs/${task}/marketing/research-2-c.txt`, done: '자료를 수집한다' }] })); return;
          }
          if (options.pauseB && id === 'b' && !paused) { paused = true; return; }
          if (!(options.missingFirst && counts[id] === 1)) {
            const file = join(root, output);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, options.empty ? '' : `완료 ${counts[id]}`);
          }
          finish(`결과: ${output} 작성 완료`);
        } else if (input.includes('첫 줄은 VERDICT:')) {
          call.kind = 'reviewer'; finish(`VERDICT: ${options.reviewerVerdict || 'PASS'}\n확인했습니다.`);
        } else {
          call.kind = 'meeting'; counts.meeting++; finish('범위·분담·출력을 제안합니다.');
        }
      }
    }));
    return child;
  };
  let runner = createRunner({ root, spawnImpl, maxConcurrent: options.maxConcurrent || 4, outbound: options.outbound, judge: options.judge || null,
    toolStatus: () => options.tools || null });
  t.after(async () => {
    await runner.stopAll({ graceMs: 10 });
    await new Promise((resolve) => setImmediate(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const final = async (run) => {
    await waitFor(() => !['running', 'queued'].includes(runner.list().find((r) => r.id === run.id)?.status));
    return runner.list().find((r) => r.id === run.id);
  };
  return { root, calls, counts, get runner() { return runner; }, final,
    restart: () => { runner = createRunner({ root, spawnImpl }); } };
}

test('Claude가 가능하면 계획·실무는 Claude, 저장된 Codex는 검토만 실행한다', async (t) => {
  const tools = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } };
  const f = fixture(t, { allClaude: true, tools });
  const result = await f.final(f.runner.start({ prompt: '마케팅부 조사 후 개발부 문서 작성' }));
  assert.equal(result.status, 'done');
  assert.equal(f.calls.find((c) => c.kind === 'plan').args.includes('--json-schema'), true);
  assert.equal(f.calls.find((c) => c.kind === 'plan').args.includes('opus'), true);
  for (const call of f.calls.filter((c) => ['a', 'b'].includes(c.kind))) assert.ok(call.args.includes('--agent'));
  assert.ok(f.calls.find((c) => c.kind === 'review').args.includes('--output-schema'));
  assert.ok(f.calls.find((c) => c.kind === 'review').args.includes('gpt-6.1-sol'));
});

test('Claude 미사용 환경은 Codex로 전체 실행하고 원본 경로는 질문 답변 뒤에도 전달한다', async (t) => {
  const f = fixture(t, { workspaceInput: true, planQuestion: true,
    tools: { claude: { installed: true, loggedIn: false }, codex: { installed: true, loggedIn: true } } });
  const first = f.runner.start({ prompt: '.office/simulation-inputs/market.json을 조사해 줘' });
  assert.equal((await f.final(first)).needsReply, true);
  const result = await f.final(f.runner.reply(first.id, { prompt: '기본값으로 진행' }));
  assert.equal(result.status, 'done'); assert.equal(result.needsReply, false);
  const staff = f.calls.find((c) => c.kind === 'a');
  const inputs = JSON.parse(staff.input.match(/\n입력: ([^\n]+)/)[1]);
  assert.ok(inputs.includes(join(f.root, '.office/simulation-inputs/market.json')));
  for (const call of f.calls) assert.ok(!call.args.includes('--json-schema'));
  assert.equal(loadTasks(f.root).find((task) => task.id === result.task).status, 'done');
});

test('Codex 최종 검토가 있으면 검증실 부서 없이 Codex 검토 요청을 충족한다', async (t) => {
  const f = fixture(t, { reviewBy: 'codex', noReviewers: true });
  const result = await f.final(f.runner.start({ prompt: '문서를 작성하고 Codex가 검토해 줘' }));
  assert.equal(result.needsReply, false);
  assert.equal(loadTasks(f.root).find((task) => task.id === result.task).status, 'done');
  assert.equal(f.calls.filter((call) => call.kind === 'review').length, 1);
});

test('비서실장 기본 Codex sol 6.1 max: 직원 배정·검토·사용자 확인과 사용량', async (t) => {
  const f = fixture(t);
  assert.deepEqual(loadSettings(f.root).chief, { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  const run = f.runner.start({ prompt: '자료를 조사하고 문서를 만들어 줘' });
  const result = await f.final(run);
  assert.equal(result.status, 'done');
  assert.deepEqual([result.engine, result.model, result.effort], ['codex', 'gpt-6.1-sol', 'high']);
  assert.equal(loadTasks(f.root).find((t) => t.id === run.task).status, 'done');
  assert.equal(result.canReply, true);
  assert.equal(result.usage.input, f.calls.length * 10);
  assert.equal(result.usage.costUsd, null);
  assert.match(usageLabel(result), /금액 미측정/);
  assert.deepEqual(threadOf(f.runner.list(), run.id).map((r) => r.id), [run.id]);
  const staff = f.calls.find((c) => c.kind === 'a');
  assert.equal(staff.args[staff.args.indexOf('-s') + 1], 'workspace-write');
  assert.equal(staff.args[staff.args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.ok(staff.args.includes('model_reasoning_effort="medium"'));
  for (const call of f.calls.filter((c) => ['plan', 'review', 'reviewer'].includes(c.kind))) assert.equal(call.args[call.args.indexOf('-s') + 1], 'read-only');
  const events = readFileSync(join(f.root, '.office/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.kind === 'flow.cooperate'));
  assert.ok(events.some((e) => e.kind === 'flow.deliver'));
});

test('회의·산출물 누락 1회 재시도·반려 후 원인과 후속 단계 재실행', async (t) => {
  const f = fixture(t, { meeting: true, missingFirst: true, rejects: 1, maxConcurrent: 1 });
  const run = f.runner.start({ prompt: '담당을 정해서 자료와 문서를 만들어 줘' });
  assert.equal((await f.final(run)).status, 'done');
  assert.equal(f.counts.meeting, 2);
  assert.equal(f.counts.plan, 2);
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.review], [3, 3, 2]);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('상대 산출물 경로와 입력 단계 id를 실제 업무 파일 경로로 전달한다', async (t) => {
  const f = fixture(t, { relativePaths: true });
  const run = f.runner.start({ prompt: '앞 단계 자료를 전달해 줘' });
  await f.final(run);
  assert.equal(loadTasks(f.root)[0].status, 'done');
  const second = f.calls.find((c) => c.kind === 'b');
  assert.match(second.input, new RegExp(`입력: \\["outputs/${run.task}/marketing/research-1-a.txt"\\]`));
});

test('중지·서버 재생성·이어서 재개는 완료된 단계를 건너뛴다', async (t) => {
  const f = fixture(t, { pauseB: true });
  const first = f.runner.start({ prompt: '두 단계 업무를 실행해 줘' });
  await waitFor(() => f.calls.some((c) => c.kind === 'b'));
  f.runner.stop(first.id);
  assert.equal((await f.final(first)).status, 'stopped');
  assert.ok(f.runner.list().every((r) => !['running', 'queued'].includes(r.status)));
  f.restart();
  const second = f.runner.reply(first.id, { prompt: '이어서 재개' });
  assert.equal((await f.final(second)).status, 'done');
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.plan], [1, 2, 1]);
});

test('일시정지는 진행 업무를 멈추고 정리 노트를 남기며 "이어서 해줘" 재개는 완료 단계를 건너뛴다', async (t) => {
  const f = fixture(t, { pauseB: true });
  const first = f.runner.start({ prompt: '두 단계 업무를 실행해 줘' });
  await waitFor(() => f.calls.some((c) => c.kind === 'b'));
  const { paused } = f.runner.pause();
  assert.deepEqual(paused.map((p) => p.id), [first.id]);
  const stopped = await f.final(first);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.paused, true);
  assert.ok(!stopped.userStopped);
  assert.match(stopped.summary, /일시정지했습니다.*pause-note\.md.*이어서 해줘/);
  const note = readFileSync(join(f.root, 'outputs', ...first.task.split('/'), 'pause-note.md'), 'utf8');
  assert.match(note, /1\/2 단계 완료/);
  assert.match(note, /\[남음\] b/);
  assert.ok(f.runner.list().every((r) => !['running', 'queued'].includes(r.status)));
  f.restart();
  const { resumed, skipped } = f.runner.resumeAll();
  assert.deepEqual(skipped, []);
  assert.equal(resumed.length, 1);
  assert.equal((await f.final({ id: resumed[0].id })).status, 'done');
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.plan], [1, 2, 1]);
  assert.deepEqual(f.runner.resumeAll(), { resumed: [], skipped: [] });
});

test('하루 넘게 끊긴 업무는 일괄 재개하지 않고 사유를 알리며, 대화 답장으로는 이어갈 수 있다', async (t) => {
  const f = fixture(t, { pauseB: true, independent: true });
  const first = f.runner.start({ prompt: '어제 맡긴 업무를 실행해 줘' });
  await waitFor(() => f.calls.some((c) => c.kind === 'b'));
  await f.runner.stopAll({ graceMs: 10 });
  assert.equal((await f.final(first)).interrupted, true);
  const file = join(f.root, '.office', 'runs.json');
  const at = new Date(Date.now() - 25 * 3600e3).toISOString();
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).map((r) => r.id === first.id ? { ...r, createdAt: at, startedAt: at } : r)));
  f.restart();
  const old = f.runner.resumeAll();
  assert.deepEqual(old.resumed, []);
  assert.equal(old.skipped[0].id, first.id);
  assert.match(old.skipped[0].reason, /하루 넘게 멈춘.*어제 맡긴 업무/);
  assert.equal(f.runner.list().find((r) => r.id === first.id).interrupted, true, '사유만 알리고 상태는 그대로 둔다');
  const replied = f.runner.reply(first.id, { prompt: '이어서 재개' });
  assert.equal((await f.final(replied)).status, 'done');
});

test('대표가 일시정지한 업무는 하루가 지나도 일괄 재개한다', async (t) => {
  const f = fixture(t, { pauseB: true, independent: true });
  const first = f.runner.start({ prompt: '오래 걸리는 업무를 실행해 줘' });
  await waitFor(() => f.calls.some((c) => c.kind === 'b'));
  f.runner.pause();
  await f.final(first);
  await f.runner.stopAll({ graceMs: 10 });
  const file = join(f.root, '.office', 'runs.json');
  const at = new Date(Date.now() - 72 * 3600e3).toISOString();
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).map((r) => r.id === first.id ? { ...r, createdAt: at, startedAt: at } : r)));
  f.restart();
  const { resumed, skipped } = f.runner.resumeAll();
  assert.deepEqual(skipped, []);
  assert.deepEqual(resumed.map((r) => r.from), [first.id]);
  await f.final({ id: resumed[0].id });
});

test('서버 종료로 끊긴 업무도 재개 대상이고, 대표가 직접 중지한 업무는 일괄 재개하지 않는다', async (t) => {
  const f = fixture(t, { pauseB: true, independent: true });
  const first = f.runner.start({ prompt: '두 단계 업무를 실행해 줘' });
  await waitFor(() => f.calls.some((c) => c.kind === 'b'));
  await f.runner.stopAll({ graceMs: 10 });
  assert.equal((await f.final(first)).interrupted, true);
  f.restart();
  const second = f.runner.start({ prompt: '다른 업무를 실행해 줘' });
  await waitFor(() => f.calls.filter((c) => c.kind === 'plan').length >= 2);
  f.runner.stop(second.id);
  await f.final(second);
  const { resumed } = f.runner.resumeAll();
  assert.deepEqual(resumed.map((r) => r.from), [first.id]);
  await f.final({ id: resumed[0].id });
  assert.ok(!f.runner.list().find((r) => r.id === first.id).interrupted);
});

test('완료한 업무는 승인 없이 닫히고 추가 수정은 새 업무로 시작한다', async (t) => {
  const f = fixture(t, { feedback: true });
  const first = f.runner.start({ prompt: '보고서를 작성해 줘' });
  await f.final(first);
  assert.throws(() => f.runner.reply(first.id, { prompt: '표를 추가해 줘' }), /완료된 업무|승인한 업무/);
  const second = f.runner.start({ prompt: '앞 보고서에 표를 추가한 새 보고서를 작성해 줘' });
  await f.final(second);
  assert.notEqual(first.task, second.task);
  assert.ok(loadTasks(f.root).every((task) => task.status === 'done'));
});

test('잘못된 계획은 1회 수정 요청하고, 계속 틀리면 업무를 막힘으로 남긴다', async (t) => {
  const f = fixture(t, { invalidPlans: 2 });
  const run = f.runner.start({ prompt: '계획을 만들어 줘' });
  await f.final(run);
  assert.equal(f.counts.plan, 2);
  assert.equal(f.counts.a, 0);
  assert.equal(loadTasks(f.root)[0].status, 'blocked');
});

test('검증실 BLOCK은 전달을 막는다', async (t) => {
  {
    const f = fixture(t, { reviewerVerdict: 'BLOCK', reviewBy: 'codex' });
    const run = f.runner.start({ prompt: '검토가 필요한 업무' });
    await f.final(run);
    assert.equal(loadTasks(f.root)[0].status, 'blocked');
    assert.ok(f.counts.review <= 3);
  }
});

test('최종 검토 재작업 한도: 외부 작업이 없으면 한 번만 다시 하고, 남은 지적을 숨기지 않고 보고한다', async (t) => {
  const f = fixture(t, { review: (n) => ({ verdict: 'reject', stages: [{ id: 'a', reason: `지적 ${n}: 3번 날짜가 원문과 다름` }], reason: `반려 ${n}`, report: '# 보고' }) });
  const run = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘' });
  await f.final(run);
  assert.equal(loadTasks(f.root)[0].status, 'done', f.runner.result(run.id).text);
  assert.deepEqual([f.counts.a, f.counts.review], [2, 2], '수집 재작업은 한 번, 검토는 두 번');
  const report = f.runner.result(run.id).text;
  assert.match(report, /재작업 한도로 고치지 못함/);
  assert.match(report, /지적 2: 3번 날짜가 원문과 다름/);
  assert.match(f.calls.filter((c) => c.kind === 'review').at(-1).input, /이번에는 반려·보완할 수 없으니/);
  assert.doesNotMatch(f.calls.filter((c) => c.kind === 'review')[0].input, /이번에는 반려·보완할 수 없으니/);
});

test('비서실장 설정은 재로딩 후 유지되고 잘못된 제공자·effort를 거부한다', async (t) => {
  const f = fixture(t);
  saveSettings(f.root, { chief: { engine: 'claude', model: 'sonnet', effort: 'high' } });
  assert.deepEqual(loadSettings(f.root).chief, { engine: 'claude', model: 'sonnet', effort: 'high' });
  assert.throws(() => saveSettings(f.root, { chief: { engine: 'claude', model: 'sonnet', effort: 'ultra' } }), /effort/);
  assert.throws(() => saveSettings(f.root, { chief: { engine: 'other', model: 'sonnet', effort: 'high' } }), /제공자/);
  assert.equal(loadSettings(f.root).chief.engine, 'claude');
});

test('Claude 비서실장으로 바꿔도 Codex 직원의 배정과 검토를 끝까지 이어간다', async (t) => {
  const f = fixture(t);
  saveSettings(f.root, { chief: { engine: 'claude', model: 'sonnet', effort: 'high' } });
  const run = f.runner.start({ prompt: '자료를 조사하고 정리해 줘' });
  const result = await f.final(run);
  assert.equal(result.status, 'done');
  assert.equal(result.engine, 'claude');
  assert.equal(loadTasks(f.root)[0].status, 'done');
  for (const call of f.calls.filter((c) => ['plan', 'review'].includes(c.kind))) {
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
    assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
    assert.ok(call.args.includes('--json-schema'));
  }
});


test('별도 검증실이 있어도 기본 최종 검토는 비서실장 한 번', async (t) => {
  const f = fixture(t, { reviewerVerdict: 'BLOCK' });
  const run = f.runner.start({ prompt: '비서실장이 최종 검토하고 보고해 줘' });
  await f.final(run);
  assert.equal(f.calls.filter((c) => c.kind === 'reviewer').length, 0);
  assert.equal(f.counts.review, 1);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('계획 전 질문·답장·서버 재생성 후 최초 요청과 결정 이력을 비공개로 보존', async (t) => {
  const f = fixture(t, { planQuestion: true });
  const original = '제휴업체 조사와 HTML 보고서 작성\n출처와 날짜를 포함해 줘. api_key=sk-example-secret-value';
  const first = f.runner.start({ prompt: original });
  const paused = await f.final(first);
  assert.equal(paused.needsReply, true);
  assert.match(f.runner.result(first.id).text, /대상 지역/);
  f.restart();
  const second = f.runner.reply(first.id, { prompt: '국내 업체만 조사해 줘' });
  await f.final(second);
  const input = f.calls.filter((c) => c.kind === 'plan').at(-1).input;
  assert.match(input, /제휴업체 조사와 HTML 보고서 작성\n출처와 날짜를 포함/);
  assert.match(input, /국내 업체만/);
  const checkpoint = join(f.root, '.office', 'orchestrations', first.rootId + '.json');
  assert.doesNotMatch(readFileSync(checkpoint, 'utf8'), /sk-example-secret-value/);
  if (process.platform !== 'win32') assert.equal(statSync(checkpoint).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(f.runner.list()), /originalRequest|sk-example-secret-value/);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('Claude 부서만 있어도 직원 질문이 대표 알림으로 전달되고 답장 후 같은 단계를 재개', async (t) => {
  const f = fixture(t, { staffDecision: true, allClaude: true });
  saveSettings(f.root, { chief: { engine: 'claude', model: 'sonnet', effort: 'high' } });
  const first = f.runner.start({ prompt: '업체를 조사하고 문서를 만들어 줘' });
  const paused = await f.final(first);
  assert.equal(paused.needsReply, true);
  assert.equal(f.counts.a, 1);
  assert.equal(f.counts.b, 0);
  assert.match(f.runner.result(first.id).text, /대상 지역과 예산/);
  assert.equal(loadTasks(f.root)[0].status, 'blocked');
  const second = f.runner.reply(first.id, { prompt: '서울, 예산 100만원' });
  await f.final(second);
  assert.equal(f.counts.plan, 1);
  assert.deepEqual([f.counts.a, f.counts.b], [2, 1]);
  assert.match(f.calls.filter((c) => c.kind === 'a').at(-1).input, /서울, 예산 100만원/);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('오전달은 비서실장에게 재배정을 요청하고 새 담당에게 전달', async (t) => {
  const f = fixture(t, { reroute: true });
  const run = f.runner.start({ prompt: '개발부에서 정리해야 하는 자료' });
  const result = await f.final(run);
  assert.equal(result.needsReply, false);
  const plan = JSON.parse(readFileSync(join(f.root, 'outputs', run.task, 'plan.json')));
  assert.deepEqual([plan.stages[0].dept, plan.stages[0].agent], ['dev', 'dev-1']);
  assert.equal(f.calls.filter((c) => c.kind === 'route').length, 1);
  assert.match(f.calls.filter((c) => c.kind === 'a').at(-1).input, /출력: outputs\/.*\/dev\/dev-1-a.txt/);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('부서 팀장 분담 → 부서원 실행 → 팀장 취합 → 다음 부서 → 비서실장 검토', async (t) => {
  const f = fixture(t, { delegate: true });
  const run = f.runner.start({ prompt: '팀장이 부서원에게 분담해 조사하고 개발부에 전달해 줘' });
  await f.final(run);
  assert.deepEqual(f.calls.filter((c) => ['a', 'b', 'c', 'review'].includes(c.kind)).map((c) => c.kind), ['a', 'c', 'a', 'b', 'review']);
  assert.match(f.calls.filter((c) => c.kind === 'a').at(-1).input, /research-2-c.txt/);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('다른 부서 직원에게 잘못 분담하면 실행하지 않고 대표 결정 요청', async (t) => {
  const f = fixture(t, { delegate: true, invalidDelegate: true });
  const run = f.runner.start({ prompt: '팀장에게 배정' });
  const result = await f.final(run);
  assert.equal(result.needsReply, true);
  assert.equal(f.counts.b, 0);
  assert.match(f.runner.result(run.id).text, /같은 부서/);
});

test('빈 파일은 완료로 인정하지 않고 1회 재시도 후 차단', async (t) => {
  const f = fixture(t, { empty: true });
  const run = f.runner.start({ prompt: '빈 내용으로 완료하지 마' });
  await f.final(run);
  assert.equal(f.counts.a, 2);
  assert.equal(f.counts.review, 0);
  assert.equal(loadTasks(f.root)[0].status, 'blocked');
  assert.match(f.runner.result(run.id).text, /비어 있습니다/);
});

test('최종 검토 중 결정 요청에 답하면 완료된 부서는 반복 실행하지 않는다', async (t) => {
  const f = fixture(t, { reviewQuestion: true });
  const first = f.runner.start({ prompt: '보고서를 만들어 줘' });
  assert.equal((await f.final(first)).needsReply, true);
  const second = f.runner.reply(first.id, { prompt: '내부에만 공유해 줘' });
  await f.final(second);
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.plan, f.counts.review], [1, 1, 1, 2]);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('6개 업무를 동시에 지시하면 서로 다른 폴더에서 산출물과 최종 보고까지 진행', async (t) => {
  const f = fixture(t);
  const runs = Array.from({ length: 6 }, (_, i) => f.runner.start({ prompt: `동시 업무 ${i + 1}` }));
  const results = await Promise.all(runs.map(f.final));
  assert.equal(new Set(runs.map((r) => r.task)).size, 6);
  assert.ok(results.every((r) => r.status === 'done'));
  assert.ok(loadTasks(f.root).every((task) => task.status === 'done'));
  for (const run of runs) assert.match(readFileSync(join(f.root, 'outputs', run.task, 'report.md'), 'utf8'), /산출물과 근거/);
});


test('한 단계가 결정을 기다려도 독립 업무는 완료하고 의존 단계만 대기', async (t) => {
  const f = fixture(t, { staffDecision: true, independent: true });
  const first = f.runner.start({ prompt: '조사와 독립 자료 정리를 병렬로 진행' });
  assert.equal((await f.final(first)).needsReply, true);
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.c], [1, 0, 1]);
  const next = f.runner.reply(first.id, { prompt: '서울 업체, 예산 100만원' });
  await f.final(next);
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.c], [2, 1, 1]);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});


test('사이트 조회 단계는 연결 계정 브라우저(쓰기 가능)로 실행하고 연결 문제는 대표에게 묻는다', async (t) => {
  const browses = [];
  let fail = true;
  const permissionsFile = join(tmpdir(), 'office-fixture-permissions.json');
  const outbound = { connections: () => [{ id: 'erp-1', label: 'ERP', provider: 'web', status: 'connected' }], async deliver() { throw new Error('no'); },
    async browse(args) {
      browses.push(args);
      if (fail) { fail = false; throw Object.assign(new Error('계정 연결 화면에서 로그인 상태를 확인해 주세요.'), { code: 'CONNECTION_REQUIRED' }); }
      return args.execute({ url: 'http://127.0.0.1:9/tools', token: 't', permissionsFile, write: true });
    } };
  const f = fixture(t, { siteStage: true, outbound });
  const first = f.runner.start({ prompt: 'ERP에서 조건에 맞는 상담사를 찾아 연락처와 함께 리스트로 정리해 줘' });
  const asked = await f.final(first);
  assert.equal(asked.needsReply, true);
  assert.match(f.runner.result(first.id).text, /로그인 상태를 확인/);
  const second = f.runner.reply(first.id, { prompt: '연결 완료, 이어서 진행' });
  await f.final(second);
  assert.equal(loadTasks(f.root)[0].status, 'done', f.runner.result(second.id).text);
  assert.deepEqual(browses.map((b) => [b.connection, b.target]), [['erp-1', 'https://erp.example.com/erp'], ['erp-1', 'https://erp.example.com/erp']]);
  const stageCall = f.calls.filter((c) => c.kind === 'a').at(-1);
  assert.match(stageCall.input, /사이트 조회: 연결 계정 브라우저/);
  // 계정 브라우저 단계는 사이트 밖을 못 보므로, 공개 웹 자료는 별도 단계로 나누도록 계획 지침과 직원 안내에 알린다
  assert.match(stageCall.input, /연결 사이트 밖\(웹 검색·다른 사이트\)은 볼 수 없습니다/);
  assert.match(f.calls.find((c) => c.kind === 'plan').input, /다른 공개 웹 자료가 필요하면 connection 없는 별도 단계로 나누고/);
  // 대표가 정한 참고 범위 밖(공지·다른 게시판)을 조사에 넣거나 열지 않는다
  assert.match(f.calls.find((c) => c.kind === 'plan').input, /그 범위 밖의 조회\(공지·규칙·다른 게시판 둘러보기 등\)는 done에 넣지 마세요/);
  assert.match(stageCall.input, /대표가 범위를 정했으면 그 범위의 자료만 엽니다/);
  // 직원 지시는 목표 → 입력·출력·완료 기준 → 이 단계 안내 → 응답 형식 → 안전선 순서이고, HTML 안내는 HTML 산출물에만 붙는다
  const order = ['## 목표·대표 요청', '## 입력·출력·완료 기준', '## 이 단계 안내', '## 응답 형식', '## 안전선'].map((h) => stageCall.input.indexOf(h));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  assert.doesNotMatch(stageCall.input, /HTML은 비개발자가 읽는 보고서/, '.txt 산출물에는 HTML 안내를 붙이지 않는다');
  assert.match(stageCall.args.join(' '), /office_browser/);
  assert.equal(stageCall.args[stageCall.args.indexOf('-s') + 1], 'workspace-write', '조회 결과 파일을 쓸 수 있다');
  assert.ok(f.calls.filter((c) => c.kind === 'b').every((c) => !c.args.join(' ').includes('office_browser')), '일반 단계에는 브라우저를 붙이지 않는다');
});

test('일반 웹사이트 업무: 위임이 없으면 실행 전에 묶어서 확인하고, "진행"이면 첨부와 함께 실행한다', async (t) => {
  const calls = [];
  const f = fixture(t, { webPublication: true, outbound: { connections: () => [{ id: 'erp-1', label: '홍카페 ERP', provider: 'web', status: 'connected' }], async deliver(args) {
    calls.push(args); return { status: 'confirmed', resultUrl: 'https://erp.example.com/erp/proposal-pages/1', summary: '공개 주소 확인', evidence: 'upload-1.png' };
  } } });
  const first = f.runner.start({ prompt: '자료를 정리해 HTML로 만들고 ERP 제휴 제안 페이지에 업로드해 줘' });
  const asked = await f.final(first);
  assert.equal(asked.needsReply, true);
  assert.equal(calls.length, 0, '확인 전에는 실행하지 않는다');
  assert.match(f.runner.result(first.id).text, /웹사이트 작업을 실행할까요[\s\S]*홍카페 ERP[\s\S]*첨부: dev-1-b\.txt/);
  const second = f.runner.reply(first.id, { prompt: '진행해' });
  await f.final(second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].publication.action, 'web');
  assert.deepEqual(calls[0].files.map((file) => file.name), ['dev-1-b.txt']);
  assert.ok(calls[0].files[0].path.endsWith(join('dev', 'dev-1-b.txt')));
  assert.ok(calls[0].evidenceDir.endsWith('evidence'));
  assert.deepEqual([f.counts.plan, f.counts.review], [1, 1], '확인 답장 뒤 계획·검토를 반복하지 않는다');
  assert.equal(loadTasks(f.root)[0].status, 'done');
  assert.match(f.runner.result(second.id).text, /웹사이트 작업[\s\S]*직원 확인 완료[\s\S]*evidence\/upload-1\.png[\s\S]*확인 내용: 공개 주소 확인/);
});

test('출처가 어긋나면 담당에게 한 번만 되돌리고, 로그인 사이트 조회 업무는 확인하지 않는다', async (t) => {
  const { orchestrate } = await import('../dashboard/orchestrator.mjs');
  const run = async (stageExtra, label) => {
    const root = mkdtempSync(join(tmpdir(), 'office-source-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    mkdirSync(join(root, 'org'));
    writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'research', name: '리서치부', engine: 'claude' }]));
    writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'research-1', name: '김대리', department: 'research' }]));
    const task = '2026-11-04/run-source-' + label;
    mkdirSync(join(root, 'outputs', ...task.split('/')), { recursive: true });
    const prompts = [], reviews = [];
    const sourceCalls = [];
    const output = `outputs/${task}/research/research-1-a.md`;
    const plan = { version: 1, task, goal: '자료', deliverables: ['a'], review: { by: 'chief', criteria: '확인' }, gaps: [], publications: [],
      stages: [{ id: 'a', title: '자료', dept: 'research', agent: 'research-1', inputs: [], output, done: '작성', dependsOn: [], ...stageExtra }] };
    const execute = async ({ phase, prompt }) => {
      if (phase === 'plan') return JSON.stringify({ plan, question: '', needsMeeting: false, requestedActions: [] });
      if (phase === 'review') { reviews.push(prompt); return JSON.stringify({ verdict: 'pass', stages: [], reason: '', report: '# 결과\n\n확인했습니다.', question: '' }); }
      prompts.push(prompt);
      mkdirSync(join(root, dirname(output)), { recursive: true });
      writeFileSync(join(root, output), `완료 ${prompts.length} https://a.example/x`);
      return JSON.stringify({ status: 'done', summary: '작성' });
    };
    const outbound = { connections: () => [{ id: 'erp', label: 'ERP', provider: 'web', status: 'connected' }], browse: async ({ execute: go }) => go({}) };
    const report = await orchestrate({ root, run: { id: 'run-source-' + label, rootId: 'run-source-' + label, engine: 'claude', task }, prompt: '자료 정리', execute, signal: new AbortController().signal, outbound,
      sourceCheck: async (files) => { sourceCalls.push(files); return { checked: 1, broken: [{ url: 'https://a.example/x', stage: 'a', status: 404 }], mismatched: [], unknown: [], skipped: 0 }; } });
    return { report, prompts, reviews, sourceCalls, root, task };
  };
  const checked = await run({}, 'plain');
  assert.equal(checked.prompts.length, 2, '한 번만 되돌린다');
  assert.match(checked.prompts[1], /\[반려\][\s\S]*처음부터 다시 조사하지 말고[\s\S]*열리지 않음\(404\)/);
  assert.equal(checked.sourceCalls.length, 2);
  assert.equal(checked.reviews.length, 1);
  assert.match(checked.reviews[0], /출처 자동 확인[\s\S]*열리지 않음[\s\S]*a\.example/);
  assert.ok(existsSync(join(checked.root, 'outputs', ...checked.task.split('/'), 'source-check.json')));
  const site = await run({ connection: 'erp', target: 'https://erp.example.com' }, 'site');
  assert.equal(site.sourceCalls.length, 0, '내부 자료 주소를 밖으로 열지 않는다');
  assert.equal(site.prompts.length, 1);
});

test('재작업 줄이기: 깨진 출처는 뒤 단계 전에 되돌리고, 재작업 중에는 진행 점검을 건너뛰며, 뒤 단계는 한 번만 돈다', async (t) => {
  const { orchestrate } = await import('../dashboard/orchestrator.mjs');
  const run = async (label, broken) => {
    const root = mkdtempSync(join(tmpdir(), 'office-rework-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    mkdirSync(join(root, 'org'));
    writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'research', name: '리서치부', engine: 'claude' }]));
    writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'research-1', name: '김대리', department: 'research' }]));
    const task = '2026-11-05/run-rework-' + label;
    mkdirSync(join(root, 'outputs', ...task.split('/')), { recursive: true });
    const a = `outputs/${task}/research/research-1-a.md`, b = `outputs/${task}/research/research-1-b.md`;
    const steps = [], sourceCalls = [];
    const execute = async ({ phase, prompt }) => {
      steps.push(phase === 'stage' ? (prompt.includes(a.split('/').pop()) && prompt.includes(`출력: ${a}`) ? 'a' : 'b') : phase);
      if (phase === 'plan') return JSON.stringify({ plan: { version: 1, task, goal: '자료', deliverables: [b], review: { by: 'chief', criteria: '확인' }, gaps: [], publications: [], stages: [
        { id: 'a', title: '수집', dept: 'research', agent: 'research-1', inputs: [], dependsOn: [], output: a, done: '수집', connection: '', target: '' },
        { id: 'b', title: '편집', dept: 'research', agent: 'research-1', inputs: ['a'], dependsOn: ['a'], output: b, done: '편집', connection: '', target: '' }] }, question: '' });
      if (phase === 'meeting') return '[]';
      if (phase === 'progress') return JSON.stringify({ action: 'continue', reason: '', question: '', revisedPlan: null });
      if (phase === 'review') return JSON.stringify({ verdict: 'pass', stage: '', stages: [], reason: '확인', report: '# 보고', question: '', revisedPlan: null });
      const output = prompt.includes(`출력: ${a}`) ? a : b;
      mkdirSync(join(root, dirname(output)), { recursive: true });
      writeFileSync(join(root, output), `내용 ${steps.length} https://a.example/x`);
      return JSON.stringify({ status: 'done', summary: '작성' });
    };
    await orchestrate({ root, run: { id: 'run-rework-' + label, rootId: 'run-rework-' + label, engine: 'claude', task }, prompt: '자료 정리', execute, signal: new AbortController().signal,
      sourceCheck: async (files) => { sourceCalls.push(files.map((f) => f.stage)); return { checked: 1, broken: broken && sourceCalls.length === 1 ? [{ url: 'https://a.example/x', stage: 'a', status: 404 }] : [], mismatched: [], unknown: [], skipped: 0 }; } });
    return { steps, sourceCalls };
  };
  const bad = await run('bad', true);
  assert.deepEqual(bad.steps.filter((p) => !['plan', 'meeting'].includes(p)), ['a', 'a', 'b', 'review'], '편집 전에 되돌리고 점검은 건너뛴다');
  assert.deepEqual(bad.sourceCalls[0], ['a'], '방금 끝난 단계만 먼저 확인한다');
  const good = await run('good', false);
  assert.deepEqual(good.steps.filter((p) => !['plan', 'meeting'].includes(p)), ['a', 'progress', 'b', 'review'], '문제가 없으면 기존 흐름 그대로다');
});

test('간단한 문서 수정: 계획·검토 없이 사본을 고치고, 바뀐 곳을 보고하며, 크게 바뀌면 검토를 받고, 못 찾으면 전체 절차로 간다', async (t) => {
  const { orchestrate } = await import('../dashboard/orchestrator.mjs');
  const { createRequire } = await import('node:module');
  const ExcelJS = createRequire(import.meta.url)('exceljs');
  const write = async (file, rows) => { const b = new ExcelJS.Workbook(); const w = b.addWorksheet('매출'); for (const r of rows) w.addRow(r); await b.xlsx.writeFile(file); };
  const rows = Array.from({ length: 8 }, (_, i) => [`${i + 1}월`, i + 1]);
  const run = async (label, request, edited) => {
    const root = mkdtempSync(join(tmpdir(), 'office-edit-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    mkdirSync(join(root, 'org')); mkdirSync(join(root, '보관함'));
    writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'docs', name: '문서제작부', engine: 'claude' }, { id: 'web', name: '조사부', engine: 'claude', tools: ['WebSearch'] }]));
    writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'web-1', name: '조사', department: 'web' }, { id: 'docs-1', name: '문서', department: 'docs' }]));
    await write(join(root, '보관함', '매출표.xlsx'), rows);
    mkdirSync(join(root, '.숨김')); await write(join(root, '.숨김', '표.xlsx'), rows);
    const original = readFileSync(join(root, '보관함', '매출표.xlsx'));
    const task = '2026-11-05/run-edit-' + label;
    mkdirSync(join(root, 'outputs', ...task.split('/')), { recursive: true });
    const phases = [], prompts = [];
    const execute = async ({ phase, prompt, agentId, effort }) => {
      phases.push(phase); prompts.push({ phase, prompt, agentId, effort });
      if (phase === 'plan') return JSON.stringify({ plan: null, question: '계획 질문' });
      if (phase === 'review') return JSON.stringify({ verdict: 'pass', stage: '', stages: [], reason: '확인', report: '# 검토 보고', question: '', revisedPlan: null });
      const output = prompt.match(/출력: (\S+)/)[1];
      mkdirSync(join(root, dirname(output)), { recursive: true });
      await write(join(root, output), edited);
      return JSON.stringify({ status: 'done', summary: '합계 행을 추가했습니다.' });
    };
    const report = await orchestrate({ root, run: { id: 'run-edit-' + label, rootId: 'run-edit-' + label, engine: 'claude', task }, prompt: request, execute, signal: new AbortController().signal, home: root,
      intent: { actions: [], delegated: false, source: 'ai', quickEdit: true, quickEditFile: request.match(/\S+?\.xlsx/)[0], quickAgent: '' } });
    return { report, phases, prompts, root, task, original };
  };
  // 화면 확인 도구 유무가 PC마다 달라 없는 것으로 고정한다
  const savedSoffice = process.env.SOFFICE_BIN;
  process.env.SOFFICE_BIN = join(tmpdir(), '없는-soffice');
  t.after(() => { if (savedSoffice === undefined) delete process.env.SOFFICE_BIN; else process.env.SOFFICE_BIN = savedSoffice; });
  const small = await run('small', '매출표.xlsx에 합계 행 추가해줘', [...rows, ['합계', 36]]);
  const relative = await run('relative', '보관함/매출표.xlsx에 합계 행 추가해줘', [...rows, ['합계', 36]]);
  assert.deepEqual(relative.phases, ['stage'], '작업 공간 기준 경로도 찾는다');
  assert.deepEqual(small.phases, ['stage'], '계획·진행 점검·최종 검토 없음');
  const stage = small.prompts[0];
  assert.equal(stage.agentId, 'docs-1', '셸을 쓸 수 있는 문서 담당');
  assert.equal(stage.effort, 'low');
  assert.match(stage.prompt, /간단한 문서 수정입니다/);
  assert.match(stage.prompt, /입력: \[".*source[\\/]+매출표\.xlsx"\]/);
  assert.match(stage.prompt, /exceljs/);
  assert.deepEqual(readFileSync(join(small.root, '보관함', '매출표.xlsx')), small.original, '원본은 그대로');
  assert.deepEqual(readFileSync(join(small.root, 'outputs', ...small.task.split('/'), 'source', '매출표.xlsx')), small.original, '사본도 그대로');
  assert.match(small.report, /간단한 수정 결과입니다/);
  assert.match(small.report, /추가 2곳, 삭제 0곳/);
  assert.match(small.report, /추가: A9: 합계/);
  assert.doesNotMatch(small.report, /출처 자동 확인/);

  const wiped = await run('wiped', '매출표.xlsx에 합계 행 추가해줘', [['합계', 36]]);
  assert.deepEqual(wiped.phases, ['stage', 'review'], '크게 지워지면 최종 검토를 받는다');
  assert.match(wiped.report, /검토 보고/);

  const missing = await run('missing', '없는파일.xlsx 고쳐줘', rows);
  assert.equal(missing.phases[0], 'plan', '파일을 못 찾으면 전체 절차');
  assert.doesNotMatch(missing.prompts[0].prompt, /간단한 문서 수정입니다/);
  const hidden = await run('hidden', '.숨김/표.xlsx 고쳐줘', rows);
  assert.equal(hidden.phases[0], 'plan', '숨김 폴더 파일은 빠른 경로로 읽지 않는다');
});

test('빠른 조회: 계획·검토 없이 직원 한 명이 Sonnet/low로 끝내고 생략 사실을 보고한다', async (t) => {
  const f = fixture(t, { allClaude: true, handoffRequired: true });
  const run = f.runner.start({ prompt: '미국 중간선거 최신 자료 10건 수집해줘', intent: { actions: [], delegated: false, source: 'ai', quick: true, quickAgent: 'research-1' } });
  assert.equal((await f.final(run)).status, 'done');
  assert.deepEqual([f.counts.plan, f.counts.review], [0, 0], '계획·검토 호출 없음');
  const stage = f.calls.find((c) => /출력: /.test(c.input || ''));
  assert.equal(f.calls.filter((c) => /출력: /.test(c.input || '')).length, 1);
  assert.deepEqual([stage.args[stage.args.indexOf('--agent') + 1], stage.args[stage.args.indexOf('--model') + 1], stage.args[stage.args.indexOf('--effort') + 1]], ['research-1', 'sonnet', 'low']);
  assert.match(stage.input, /빠른 조회입니다/);
  assert.match(stage.input, /같은 사건은 1건으로/);
  assert.match(stage.input, /오늘은 \d{4}-\d{2}-\d{2}입니다/);
  assert.match(stage.input, /scripts[\\/]news-search\.mjs/, '뉴스 후보는 코드로 받는다');
  assert.match(stage.input, /scripts[\\/]check-links\.mjs/, '다른 자료는 링크를 코드로 확인한다');
  const report = f.runner.result(run.id).text;
  assert.match(report, /최종 검토를 거치지 않았습니다/);
  assert.equal(loadTasks(f.root)[0].status, 'done');
  assert.equal(loadTasks(f.root)[0].quick, true, '완료 창이 최종 검토 문구를 다르게 쓴다');
});

test('빠른 조회 직원이 없거나 계획을 만들 수 없으면 전체 흐름으로 간다', async (t) => {
  const f = fixture(t, { allClaude: true });
  const run = f.runner.start({ prompt: '자료 찾아줘', intent: { actions: ['web'], delegated: false, source: 'ai', quick: true, quickAgent: '' } });
  await f.final(run);
  assert.ok(f.counts.plan >= 1, '외부 작업이 허용된 지시는 빠른 경로를 쓰지 않는다');
});

test('도구 문제는 대표에게 묻지 않고 계획을 고쳐 다시 실행하며, 고쳐도 안 되면 대표에게 알린다', async (t) => {
  const { orchestrate } = await import('../dashboard/orchestrator.mjs');
  const run = async (label, stageReply) => {
    const root = mkdtempSync(join(tmpdir(), 'office-tools-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    mkdirSync(join(root, 'org'));
    writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'research', name: '리서치부', engine: 'claude' }]));
    writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'research-1', name: '김대리', department: 'research' }]));
    const task = '2026-11-04/run-tools-' + label;
    mkdirSync(join(root, 'outputs', ...task.split('/')), { recursive: true });
    const output = `outputs/${task}/research/research-1-a.md`;
    const plans = [], stages = [];
    const makePlan = (connection) => ({ version: 1, task, goal: '자료', deliverables: ['a'], review: { by: 'chief', criteria: '확인' }, gaps: [], publications: [],
      stages: [{ id: 'a', title: '자료', dept: 'research', agent: 'research-1', inputs: [], output, done: '작성', dependsOn: [], connection, target: connection ? 'https://erp.example.com' : '' }] });
    const execute = async ({ phase, prompt, browser }) => {
      if (phase === 'plan') { plans.push(prompt); return JSON.stringify({ plan: makePlan(plans.length > 1 ? 'erp' : ''), question: '', needsMeeting: false, requestedActions: [] }); }
      if (phase === 'review') return JSON.stringify({ verdict: 'pass', stages: [], reason: '', report: '# 결과\n\n확인했습니다.', question: '' });
      stages.push({ prompt, browser: Boolean(browser) });
      const reply = stageReply(stages.length, Boolean(browser));
      if (reply.status === 'done') { mkdirSync(join(root, dirname(output)), { recursive: true }); writeFileSync(join(root, output), '완료'); }
      return JSON.stringify(reply);
    };
    const outbound = { connections: () => [{ id: 'erp', label: 'ERP', provider: 'web', status: 'connected' }], browse: async ({ execute: go }) => go({ url: 'http://127.0.0.1:9/tools', token: 't', permissionsFile: join(tmpdir(), 'x.json'), write: true }) };
    const onDecision = () => {};
    const text = await orchestrate({ root, run: { id: 'run-tools-' + label, rootId: 'run-tools-' + label, engine: 'claude', task }, prompt: '사내 자료 정리', execute, signal: new AbortController().signal, outbound, onDecision, sourceCheck: async () => ({ checked: 0, broken: [], mismatched: [], unknown: [], skipped: 0 }) });
    return { text, plans, stages };
  };
  // 직원이 질문으로 보내도(옛 형식) 도구 문제면 대표에게 묻지 않는다
  const fixed = await run('fixed', (n, browser) => browser ? { status: 'done', summary: '작성' }
    : { status: 'needs_decision', summary: '', question: '1. 연결된 브라우저(office_browser)를 연결해 다시 실행해도 될까요?\n2. 권장 기본값: 예' });
  assert.equal(fixed.plans.length, 2, '계획을 고친다');
  assert.match(fixed.plans[1], /대표에게 묻지 말고 계획을 고치세요/);
  assert.deepEqual(fixed.stages.map((s) => s.browser), [false, true], '고친 단계는 브라우저를 받아 다시 실행한다');
  assert.doesNotMatch(fixed.text, /대표 결정이 필요합니다/);
  // 계획을 고쳐도 계속 안 되면 멈추고, 내부 id 없이 알린다
  const stuck = await run('stuck', () => ({ status: 'replan', summary: '', reason: '영상 화면을 보는 도구가 필요합니다.' }));
  assert.equal(stuck.plans.length, 3, '업무당 2회까지만 고친다');
  assert.match(stuck.text, /대표 결정이 필요합니다[\s\S]*지금 도구로 끝내지 못했습니다[\s\S]*영상 화면/);
  assert.doesNotMatch(stuck.text, /\[a\]|\n1\. /);
  // 도구와 무관한 대표 결정은 그대로 묻는다
  const decision = await run('decision', () => ({ status: 'needs_decision', summary: '', question: '대상 지역을 알려 주세요.' }));
  assert.match(decision.text, /대상 지역을 알려 주세요/);
  assert.equal(decision.plans.length, 1);
});

test('글·댓글 사이에 설정한 간격을 둔다', async (t) => {
  const { orchestrate } = await import('../dashboard/orchestrator.mjs');
  const root = mkdtempSync(join(tmpdir(), 'office-gap-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'biz', name: '제휴', engine: 'claude' }]));
  writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'biz-1', name: '김대리', department: 'biz' }]));
  saveSettings(root, { postGapSeconds: 90 });
  const task = '2026-11-04/run-gap';
  mkdirSync(join(root, 'outputs', ...task.split('/')), { recursive: true });
  const output = `outputs/${task}/biz/biz-1-a.json`;
  const plan = { version: 1, task, goal: '댓글', deliverables: [], review: { by: 'chief', criteria: '확인' }, gaps: [],
    publications: [{ id: 'c', action: 'post', service: 'naver_cafe', connection: 'n1', agent: 'biz-1', target: 'https://cafe.naver.com/a/1', recipients: [], subject: '', content: 'a', instructions: '', files: [], attachments: [] }],
    stages: [{ id: 'a', title: '문안', dept: 'biz', agent: 'biz-1', inputs: [], output, done: '작성', dependsOn: [], connection: '', target: '' }] };
  const posts = [{ subject: '첫 글', body: '첫 본문', target: 'https://cafe.naver.com/a/1' }, { subject: '둘째 글', body: '둘째 본문', target: 'https://cafe.naver.com/a/2' }, { subject: '셋째 글', body: '셋째 본문', target: 'https://cafe.naver.com/a/3' }];
  const waits = [], delivered = [];
  const execute = async ({ phase }) => {
    if (phase === 'plan') return JSON.stringify({ plan, question: '', needsMeeting: false, requestedActions: [] });
    if (phase === 'review') return JSON.stringify({ verdict: 'pass', stages: [], reason: '', report: '# 결과\n\n확인했습니다.', question: '' });
    mkdirSync(join(root, dirname(output)), { recursive: true }); writeFileSync(join(root, output), JSON.stringify({ posts, skipped: [] }));
    return JSON.stringify({ status: 'done', summary: '작성' });
  };
  const outbound = { connections: () => [{ id: 'n1', label: '네이버', provider: 'naver', status: 'connected' }], async deliver(args) { delivered.push(args.body); return { status: 'confirmed', resultUrl: 'https://cafe.naver.com/a/1' }; } };
  const text = await orchestrate({ root, run: { id: 'run-gap', rootId: 'run-gap', engine: 'claude', task }, prompt: '카페에 글 올려줘. 끝까지 자동으로', intent: { actions: ['post'], delegated: true, source: 'ai' }, execute, signal: new AbortController().signal, outbound,
    sourceCheck: async () => ({ checked: 0, broken: [], mismatched: [], unknown: [], skipped: 0 }), wait: async (ms) => { waits.push(ms); } });
  assert.equal(delivered.length, 3, text);
  assert.equal(waits.length, 2, '첫 게시 전에는 기다리지 않는다');
  assert.ok(waits.every((ms) => ms > 85000 && ms <= 90000));
  assert.throws(() => saveSettings(root, { postGapSeconds: -1 }), /간격/);
  assert.equal(loadSettings(root).postGapSeconds, 90);
});

test('여러 글의 댓글은 실행 전 확인에 대상 글을 보여 주고 글마다 따로 등록한다', async (t) => {
  const { orchestrate } = await import('../dashboard/orchestrator.mjs');
  for (const delegated of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'office-comments-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    mkdirSync(join(root, 'org'));
    writeFileSync(join(root, 'org', 'departments.json'), JSON.stringify([{ id: 'biz', name: '제휴', engine: 'claude' }]));
    writeFileSync(join(root, 'org', 'roster.json'), JSON.stringify([{ id: 'biz-1', name: '김대리', department: 'biz' }]));
    saveSettings(root, { postGapSeconds: 0 });
    const task = '2026-11-05/run-comments';
    mkdirSync(join(root, 'outputs', ...task.split('/')), { recursive: true });
    const output = `outputs/${task}/biz/biz-1-a.json`;
    const article = (n) => `https://m.cafe.naver.com/ca-fe/web/cafes/1/articles/${n}`;
    const plan = { version: 1, task, goal: '댓글', deliverables: [], review: { by: 'chief', criteria: '확인' }, gaps: [],
      publications: [{ id: 'c', action: 'comment', service: 'naver_cafe', connection: 'n1', agent: 'biz-1', target: 'https://cafe.naver.com/f-e/cafes/1/menus/44', recipients: [], subject: '', content: 'a', instructions: '', files: [], attachments: [] }],
      stages: [{ id: 'a', title: '문안', dept: 'biz', agent: 'biz-1', inputs: [], output, done: '작성', dependsOn: [], connection: '', target: '' }] };
    const comments = [{ target: article(1), body: '첫 댓글', subject: '첫 글', author: '회원A' }, { target: article(2), body: '둘째 댓글', subject: '둘째 글', author: '회원B' }];
    const delivered = [], prompts = [];
    const execute = async ({ phase, prompt }) => {
      if (phase === 'plan') return JSON.stringify({ plan, question: '', needsMeeting: false, requestedActions: [] });
      if (phase === 'review') return JSON.stringify({ verdict: 'pass', stages: [], reason: '', report: '# 결과\n\n확인했습니다.', question: '' });
      if (phase === 'publish') { prompts.push(prompt); return JSON.stringify({ status: 'done', summary: '등록' }); }
      mkdirSync(join(root, dirname(output)), { recursive: true }); writeFileSync(join(root, output), JSON.stringify({ comments, skipped: [] }));
      return JSON.stringify({ status: 'done', summary: '작성' });
    };
    const outbound = { connections: () => [{ id: 'n1', label: '네이버', provider: 'naver', status: 'connected' }],
      async deliver(args) { delivered.push([args.publication.target, args.body, args.publication.subject]); await args.execute({ url: '', token: '', permissionsFile: '' }); return { status: 'confirmed', resultUrl: args.publication.target }; } };
    const text = await orchestrate({ root, run: { id: 'run-comments', rootId: 'run-comments', engine: 'claude', task }, prompt: delegated ? '글마다 댓글 달아줘. 끝까지 자동으로' : '글마다 댓글 달아줘', intent: { actions: ['comment'], delegated, source: 'ai' }, execute, signal: new AbortController().signal, outbound,
      sourceCheck: async () => ({ checked: 0, broken: [], mismatched: [], unknown: [], skipped: 0 }), wait: async () => {} });
    if (!delegated) {
      assert.equal(delivered.length, 0, '확인 전에는 등록하지 않는다');
      assert.match(text, /1\. 댓글 \[네이버\] https:\/\/m\.cafe\.naver\.com\/ca-fe\/web\/cafes\/1\/articles\/1 · 대상 글: 첫 글 \(작성자 회원A\) — 첫 댓글/);
      assert.match(text, /2\. 댓글 \[네이버\] https:\/\/m\.cafe\.naver\.com\/ca-fe\/web\/cafes\/1\/articles\/2 · 대상 글: 둘째 글 \(작성자 회원B\) — 둘째 댓글/);
      continue;
    }
    assert.deepEqual(delivered, [[article(1), '첫 댓글', ''], [article(2), '둘째 댓글', '']]);
    assert.match(prompts[0], /"대상글제목":"첫 글","대상글작성자":"회원A"/);
    assert.match(prompts[0], /다르면 등록하지 말고 needs_decision/);
    assert.doesNotMatch(prompts[0], /둘째 댓글/, '이번 한 건만 알려 준다');
  }
});

test('실행 전 확인에 문안을 고치라고 답하면 올리지 않고 해당 단계를 다시 쓴 뒤 다시 확인받는다', async (t) => {
  let deliveries = 0;
  const f = fixture(t, { publication: true, feedback: true, outbound: { connections: () => [{ id: 'naver-1', label: '네이버', provider: 'naver', status: 'connected' }],
    async deliver() { deliveries++; return { status: 'confirmed', resultUrl: 'https://blog.naver.com/fixture/1' }; } } });
  const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘' });
  assert.equal((await f.final(first)).needsReply, true);
  const before = f.counts.b;
  const second = f.runner.reply(first.id, { prompt: '문안 수정해 줘' });
  assert.equal((await f.final(second)).needsReply, true);
  assert.equal(deliveries, 0, '고치라는 답은 승인이 아니다');
  assert.equal(f.counts.b, before + 1, '해당 단계를 다시 쓴다');
  assert.match(f.runner.result(second.id).text, /외부 작업을 실행할까요/);
  await f.final(f.runner.reply(second.id, { prompt: '진행' }));
  assert.equal(deliveries, 1);
});

test('진행 중에 받은 추가 지시는 새 업무 없이 다음 단계부터 반영하고, 끝난 업무에는 넘기지 않는다', async (t) => {
  let run, active = [], accepted = null;
  const f = fixture(t, { progress: () => {
    active = f.runner.activeOrchestrations().map((r) => r.id);
    accepted = f.runner.addNote(run.id, '아 참고로 영상이 보이게 해 줘');
    return { action: 'continue', reason: '계획대로', question: '', revisedPlan: null };
  } });
  run = f.runner.start({ prompt: '두 단계 업무를 실행해 줘' });
  assert.equal(f.runner.addNote('없는-id', 'x'), false);
  assert.equal((await f.final(run)).status, 'done');
  assert.deepEqual(active, [run.id]);
  assert.equal(accepted, true);
  assert.doesNotMatch(f.calls.find((c) => c.kind === 'a').input, /영상이 보이게/);
  assert.match(f.calls.find((c) => c.kind === 'b').input, /아 참고로 영상이 보이게 해 줘/, '다음 단계부터 반영한다');
  assert.match(f.calls.find((c) => c.kind === 'review').input, /아 참고로 영상이 보이게 해 줘/, '최종 검토도 본다');
  assert.equal(loadTasks(f.root).length, 1, '새 업무를 만들지 않는다');
  assert.equal(f.runner.addNote(run.id, '늦은 말'), false, '끝난 업무에는 넘기지 않는다');
});

test('계획과 직원 지시는 요청 범위만 처리하도록 안내한다', async (t) => {
  const f = fixture(t);
  await f.final(f.runner.start({ prompt: '자료 10건 수집해 줘' }));
  const plan = f.calls.find((c) => c.kind === 'plan').input;
  assert.match(plan, /대표가 요청한 범위와 결과물만 계획/);
  assert.match(plan, /한 부서가 끝낼 수 있는 일은 회의 없이/);
  assert.match(plan, /sonnet 이상인 실무 직원/);
  assert.match(plan, /본문 글을 먼저 쓰고 빈 줄 하나를 띄운 뒤 맨 아래에 유튜브 링크/);
  assert.match(plan, /같은 사건은 1건으로.*제목은 원문 그대로.*직접 연 페이지.*실제 건수와 부족 사유/);
  assert.match(f.calls.find((c) => c.kind === 'review').input, /표기·형식·추가 근거 보완은 보고서의 확인 필요/);
  assert.match(f.calls.find((c) => c.kind === 'a').input, /완료 기준을 채우면 바로 끝내세요/);
});

test('외부 작업 판별이 빠져도 계획이 실행 지시로 보면 작업 전에 묻고, 답장으로만 허용한다', async (t) => {
  const calls = [];
  const outbound = { connections: () => [], async deliver(args) { calls.push(args); return { status: 'confirmed', summary: '완료' }; } };
  // 계정이 없으면 허용 뒤 조사·작성 전에 계정을 묻는다(문안만 만든 뒤 역량 공백으로 끝나지 않음)
  const f = fixture(t, { publication: true, outbound });
  const prompt = '꼬리별 관측소 내 글 업로드 부탁해';
  const first = f.runner.start({ prompt, intent: { actions: [], delegated: false, source: 'ai' } });
  assert.equal((await f.final(first)).needsReply, true);
  assert.match(f.runner.result(first.id).text, /글 게시 실행까지 맡기신/);
  assert.equal(f.counts.a || 0, 0);
  const second = f.runner.reply(first.id, { prompt: '진행' });
  assert.equal((await f.final(second)).needsReply, true);
  assert.match(f.runner.result(second.id).text, /네이버 블로그 계정|계정이 필요/);
  assert.equal(f.counts.plan, 2, '허용 범위가 바뀌어 계획을 다시 세운다');
  assert.equal(f.counts.a || 0, 0, '계정 확인 전에는 단계를 실행하지 않는다');
  assert.equal(calls.length, 0);
  // 초안만 지시는 묻지 않고 기존 계획 검사로 막는다
  const draft = fixture(t, { publication: true, outbound });
  const draftRun = draft.runner.start({ prompt: '카페 글 초안만 써 줘', intent: { actions: [], delegated: false, source: 'ai' } });
  await draft.final(draftRun);
  assert.match(draft.runner.result(draftRun.id).text, /지시하지 않은 외부/);
  // 다른 답장은 허용으로 보지 않고 다시 묻는다
  const again = fixture(t, { publication: true, outbound });
  const asked = again.runner.start({ prompt, intent: { actions: [], delegated: false, source: 'ai' } });
  await again.final(asked);
  const unclear = again.runner.reply(asked.id, { prompt: '무슨 뜻이지' });
  assert.equal((await again.final(unclear)).needsReply, true);
  assert.match(again.runner.result(unclear.id).text, /글 게시 실행까지 맡기신/);
});

test('지시창 판별(근거 확인된 외부 작업·위임)이 업무 내내 쓰이고, 답장 뜻은 AI 판별로 알아본다', async (t) => {
  const calls = [];
  const outbound = { connections: () => [{ id: 'erp-1', label: 'ERP', provider: 'web', status: 'connected' }], async deliver(args) { calls.push(args); return { status: 'confirmed', summary: '완료' }; } };
  // 규칙으로는 업로드·위임으로 보지 않는 문장이지만, 지시창 판별이 근거와 함께 넘긴 값을 쓴다
  const delegated = fixture(t, { webPublication: true, outbound });
  const first = delegated.runner.start({ prompt: '자료를 HTML로 만들어 ERP 제휴 화면에 걸어 두고 마무리까지 맡길게', intent: { actions: ['web'], delegated: true, source: 'ai' } });
  assert.equal((await delegated.final(first)).needsReply, false);
  assert.equal(calls.length, 1);
  // 판별에 외부 작업이 없으면 계획의 웹 작업을 바로 실행하지 않고 작업 전에 묻는다. 거절하면 계획 재요청 뒤 막힌다
  const none = fixture(t, { webPublication: true, outbound });
  const blockedRun = none.runner.start({ prompt: '자료를 HTML로 만들어 줘', intent: { actions: [], delegated: false, source: 'ai' } });
  assert.equal((await none.final(blockedRun)).needsReply, true);
  assert.match(none.runner.result(blockedRun.id).text, /웹사이트 작업 실행까지 맡기신[\s\S]*"하지 마"면 초안까지만/);
  assert.equal(none.counts.a || 0, 0, '확인 전에는 단계를 실행하지 않는다');
  const declinedRun = none.runner.reply(blockedRun.id, { prompt: '하지 마' });
  await none.final(declinedRun);
  assert.match(none.runner.result(declinedRun.id).text, /지시하지 않은 외부/);
  assert.equal(calls.length, 1);
  // 규칙이 못 알아보는 거절 표현도 AI 판별로 거절 처리한다
  const judge = async (schema) => schema === 'intent-answer' ? { decision: 'decline', decisionEvidence: '이번엔 패스', addActions: [], removeActions: [], delegated: false, delegatedEvidence: '' } : null;
  const asked = fixture(t, { webPublication: true, outbound, judge });
  const run = asked.runner.start({ prompt: '자료를 HTML로 만들고 ERP 제휴 제안 페이지에 업로드해 줘' });
  assert.equal((await asked.final(run)).needsReply, true);
  const reply = asked.runner.reply(run.id, { prompt: '이번엔 패스' });
  await asked.final(reply);
  assert.equal(calls.length, 1);
  assert.match(asked.runner.result(reply.id).text, /대표 결정으로 실행하지 않음/);
});

test('일반 웹사이트 업무: "하지 마"면 실행하지 않고, 위임 표현이 있으면 확인 없이 실행한다', async (t) => {
  const calls = [];
  const outbound = { connections: () => [{ id: 'erp-1', label: 'ERP', provider: 'web', status: 'connected' }], async deliver(args) { calls.push(args); return { status: 'confirmed', summary: '완료' }; } };
  const f = fixture(t, { webPublication: true, outbound });
  const first = f.runner.start({ prompt: '자료를 정리해 HTML로 만들고 ERP 제휴 제안 페이지에 업로드해 줘' });
  await f.final(first);
  const second = f.runner.reply(first.id, { prompt: '이번엔 하지 마' });
  await f.final(second);
  assert.equal(calls.length, 0);
  assert.match(f.runner.result(second.id).text, /대표 결정으로 실행하지 않음/);
  const third = f.runner.start({ prompt: '자료를 정리해 HTML로 만들고 ERP 제휴 제안 페이지에 업로드해 줘. 끝까지 자동으로 해' });
  const done = await f.final(third);
  assert.equal(done.needsReply, false);
  assert.equal(calls.length, 1);
});

test('로그인 창: 링크가 있으면 계획 전에 열고, 로그인하면 답장 없이 이어 가며, 닫으면 답장으로 다시 연다', async (t) => {
  let accounts = [];
  const opened = [], delivered = [];
  let result = () => ({ status: 'connected', id: 'n1' });
  let planAtOpen = null;
  const f = fixture(t, { publication: true, outbound: { connections: () => accounts,
    requestLogin: async (args) => { opened.push(args); planAtOpen = f.counts.plan; const r = result(); if (r.status === 'connected') accounts = [{ id: 'n1', label: '네이버', provider: 'naver', status: 'connected' }]; return r; },
    async deliver(args) { delivered.push(args); return { status: 'confirmed', resultUrl: 'https://blog.naver.com/x/1' }; } } });
  const run = f.runner.start({ prompt: 'https://blog.naver.com/fixture 블로그에 글 게시해 줘. 끝까지 자동으로' });
  const done = await f.final(run);
  assert.equal(done.needsReply, false, '로그인하면 답장 없이 이어 간다');
  assert.equal(opened[0].provider, 'naver');
  assert.equal(planAtOpen, 0, '계획 전에 로그인 창을 연다');
  assert.equal(f.counts.plan, 1, '계획은 연결 계정을 알고 한 번만 세운다');
  assert.equal(delivered.length, 1);

  // 창을 닫으면 이유를 알리고, AI 판별 없이 답장으로 다시 연다
  accounts = []; opened.length = 0;
  result = () => ({ status: 'closed', id: 'n1' });
  const g = fixture(t, { publication: true, outbound: { connections: () => accounts,
    requestLogin: async (args) => { opened.push(args); const r = result(); if (r.status === 'connected') accounts = [{ id: 'n1', label: '네이버', provider: 'naver', status: 'connected' }]; return r; },
    async deliver() { return { status: 'confirmed', resultUrl: 'https://blog.naver.com/x/1' }; } } });
  const second = g.runner.start({ prompt: 'https://blog.naver.com/fixture 블로그에 글 게시해 줘. 끝까지 자동으로' });
  assert.equal((await g.final(second)).needsReply, true);
  assert.match(g.runner.result(second.id).text, /로그인 창이 닫혀[\s\S]*답장을 보내면 창을 다시 엽니다/);
  assert.equal(g.counts.plan, 0);
  result = () => ({ status: 'connected', id: 'n1' });
  const retried = g.runner.reply(second.id, { prompt: '웹을 네가 띄워 줘' });
  assert.equal((await g.final(retried)).needsReply, false);
  assert.equal(opened.length, 2);

  // 링크가 없으면 계획 뒤에 열고, 로그인 뒤 계획을 다시 세운다
  accounts = []; opened.length = 0;
  const h = fixture(t, { publication: true, outbound: { connections: () => accounts,
    requestLogin: async (args) => { opened.push(args); accounts = [{ id: 'n1', label: '네이버', provider: 'naver', status: 'connected' }]; return { status: 'connected', id: 'n1' }; },
    async deliver() { return { status: 'confirmed', resultUrl: 'https://blog.naver.com/x/1' }; } } });
  await h.final(h.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘. 끝까지 자동으로' }));
  assert.equal(opened.length, 1);
  assert.equal(h.counts.plan, 2);
  assert.equal(loadTasks(h.root)[0].status, 'done');

  // "하지 마"면 외부 작업 없이 초안까지만 마친다
  accounts = []; opened.length = 0;
  const calls = [];
  const d = fixture(t, { publication: true, outbound: { connections: () => accounts, requestLogin: async () => ({ status: 'closed', id: 'n1' }), async deliver(args) { calls.push(args); return { status: 'confirmed' }; } } });
  const declined = d.runner.start({ prompt: 'https://blog.naver.com/fixture 블로그에 글 게시해 줘' });
  await d.final(declined);
  const stop = d.runner.reply(declined.id, { prompt: '하지 마' });
  assert.equal((await d.final(stop)).status, 'done');
  assert.equal(calls.length, 0);
  assert.match(d.runner.result(stop.id).text, /대표 결정으로 실행하지 않음/);
});

test('필요한 계정이 없으면 작업 전에 묻고, 등록 뒤 이어서 진행한다(웹사이트 계정은 계획을 다시 세운다)', async (t) => {
  let accounts = [];
  const delivered = [];
  const outbound = { connections: () => accounts, async deliver(args) { delivered.push(args); return { status: 'confirmed', resultUrl: 'https://blog.naver.com/x/1' }; },
    browse: (args) => args.execute({ url: 'http://127.0.0.1:9/tools', token: 't', permissionsFile: join(tmpdir(), 'office-fixture-permissions.json'), write: true }) };
  const f = fixture(t, { publication: true, outbound });
  const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘. 끝까지 자동으로 진행해' });
  assert.equal((await f.final(first)).needsReply, true);
  assert.match(f.runner.result(first.id).text, /네이버 블로그·카페 계정[\s\S]*보관함\/계정\.env/);
  assert.deepEqual([f.counts.a, f.counts.b], [0, 0], '계정 확인 전에는 작업을 시작하지 않는다');
  // 계정 파일에 정보만 있고 한 번도 직접 로그인하지 않았으면 아직 쓰지 않는다(첫 로그인은 대표가 직접)
  accounts = [{ id: 'naver-1', label: '홍보용', provider: 'naver', status: 'disconnected', hasCredentials: true, firstLoginDone: false, source: 'file' }];
  const again = f.runner.reply(first.id, { prompt: '계정 넣었어, 이어서 재개' });
  assert.equal((await f.final(again)).needsReply, true);
  assert.match(f.runner.result(again.id).text, /처음 한 번 직접 로그인/);
  assert.deepEqual([f.counts.a, f.counts.b], [0, 0]);
  accounts = [{ id: 'naver-1', label: '홍보용', provider: 'naver', status: 'connected', hasCredentials: true, firstLoginDone: true, source: 'file' }];
  await f.final(f.runner.reply(again.id, { prompt: '로그인했어, 이어서 재개' }));
  assert.equal(delivered.length, 1);
  assert.deepEqual([f.counts.a, f.counts.b], [1, 1]);
  assert.ok(f.counts.plan >= 2, '계정 없이 세운 계획은 등록 뒤 다시 세운다(조회 단계에 브라우저를 붙이기 위해)');
  // 같은 서비스 계정이 여럿이면 어느 계정을 쓸지 묻는다
  accounts = [{ id: 'n1', label: 'A', provider: 'naver', status: 'connected' }, { id: 'n2', label: 'B', provider: 'naver', status: 'connected' }];
  const g = fixture(t, { publication: true, outbound });
  const second = g.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘' });
  await g.final(second);
  assert.match(g.runner.result(second.id).text, /계정 2개 중 사용할 계정/);
  // 웹사이트 계정이 계획에 없으면 등록 뒤 계획을 다시 세운다
  accounts = [];
  const h = fixture(t, { siteStage: true, outbound });
  const third = h.runner.start({ prompt: 'ERP에서 자료를 조회해 정리해 줘' });
  await h.final(third);
  assert.match(h.runner.result(third.id).text, /조회용 계정/);
  accounts = [{ id: 'erp-1', label: 'ERP', provider: 'web', status: 'connected' }];
  await h.final(h.runner.reply(third.id, { prompt: '이어서 재개' }));
  assert.equal(h.counts.plan, 2, '계획 당시 없던 계정 id라 등록 뒤 계획을 다시 세운다');
  assert.equal(loadTasks(h.root)[0].status, 'done');
});

test('계정 재연결은 검토된 원문을 그대로 이어 발행하고 비서실장 검토를 반복하지 않는다', async (t) => {
  let deliveries = 0;
  const f = fixture(t, { publication: true, outbound: { connections: () => [{ id: 'naver-1', label: '네이버', provider: 'naver', status: 'connected' }], async deliver() {
    if (++deliveries === 1) throw new ConnectionRequired('계정 연결이 필요합니다.');
    return { status: 'confirmed', resultUrl: 'https://blog.naver.com/fixture/1' };
  } } });
  const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘. 끝까지 자동으로 진행해' });
  assert.equal((await f.final(first)).needsReply, true);
  const second = f.runner.reply(first.id, { prompt: '계정 연결 완료, 이어서 진행' });
  await f.final(second);
  assert.deepEqual([f.counts.plan, f.counts.a, f.counts.b, f.counts.review], [1, 1, 1, 1]);
  assert.equal(deliveries, 2);
  assert.equal(loadTasks(f.root)[0].status, 'done');
  assert.match(f.runner.result(second.id).text, /외부 작업 결과/);
});

test('브라우저 도구 연결 실패를 복구하면 검토된 원문·완료 단계를 반복하지 않는다', async (t) => {
  let deliveries = 0;
  const f = fixture(t, { publication: true, outbound: { connections: () => [{ id: 'naver-1', label: '네이버', provider: 'naver', status: 'connected' }], async deliver() {
    if (++deliveries === 1) throw new Error('브라우저 실행 도구가 연결되지 않았습니다.');
    return { status: 'confirmed', resultUrl: 'https://blog.naver.com/fixture/1' };
  } } });
  const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘. 끝까지 자동으로 진행해' });
  assert.equal((await f.final(first)).needsReply, true);
  const file = join(f.root, '.office', 'orchestrations', `${first.rootId}.json`);
  const checkpoint = JSON.parse(readFileSync(file));
  checkpoint.pending[0].phase = 'plan'; // 이전 버전의 검토 후 오류 분류도 재개한다.
  writeFileSync(file, JSON.stringify(checkpoint));
  await f.final(f.runner.reply(first.id, { prompt: '이어서 재개' }));
  assert.deepEqual([f.counts.plan, f.counts.a, f.counts.b, f.counts.review], [1, 1, 1, 1]);
  assert.equal(deliveries, 2); assert.equal(loadTasks(f.root)[0].status, 'done');
});

test('최종 저장 위치 오류는 대표에게 알리고 복구 후 완료 단계·최종 검토를 반복하지 않는다', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, '보관함'), { recursive: true });
  const collision = join(f.root, '보관함', '최종산출물'); writeFileSync(collision, '기존 파일 보존');
  const first = f.runner.start({ prompt: '자료를 정리해 최종 보고' });
  assert.equal((await f.final(first)).needsReply, true);
  assert.equal(loadTasks(f.root)[0].status, 'blocked');
  assert.equal(readFileSync(collision, 'utf8'), '기존 파일 보존');
  rmSync(collision);
  const second = f.runner.reply(first.id, { prompt: '저장 위치 확인 완료, 이어서 재개' });
  await f.final(second);
  assert.deepEqual([f.counts.plan, f.counts.a, f.counts.b, f.counts.review], [1, 1, 1, 1]);
  assert.equal(loadTasks(f.root)[0].status, 'done');
});

// ── 비서실장 진행 루프 ──
const currentPlan = (input) => JSON.parse(input.match(/현재 계획: (.*)/)[1]);
test('진행 점검: 비서실장이 결과를 보고 단계를 추가하면 새 단계를 실행하고, 완료 단계는 반복하지 않으며 수정 이력을 남긴다', async (t) => {
  const f = fixture(t, { progress: (n, input) => {
    if (n !== 1) return { action: 'continue', reason: '계획대로', question: '', revisedPlan: null };
    const plan = currentPlan(input);
    const a = plan.stages.find((s) => s.id === 'a');
    const c = { id: 'c', title: '보충 조사', dept: 'marketing', agent: 'research-1', inputs: ['a'], dependsOn: ['a'], output: a.output.replace(/-a\.txt$/, '-c.txt'), done: '부족한 근거를 보충한다', parallelGroup: '' };
    plan.stages = [...plan.stages.map((s) => s.id === 'b' ? { ...s, inputs: ['a', 'c'], dependsOn: ['a', 'c'] } : s), c];
    return { action: 'revise', reason: '근거가 부족해 보충 조사를 추가', question: '', revisedPlan: plan };
  } });
  const first = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘' });
  await f.final(first);
  assert.equal(loadTasks(f.root)[0].status, 'done', f.runner.result(first.id).text);
  assert.deepEqual([f.counts.a, f.counts.c, f.counts.b], [1, 1, 1]);
  const checkpoint = JSON.parse(readFileSync(join(f.root, '.office', 'orchestrations', `${first.rootId}.json`)));
  assert.equal(checkpoint.revisionCount, 1);
  assert.deepEqual(checkpoint.revisions[0].added, ['c']);
  assert.match(checkpoint.revisions[0].reason, /보충 조사/);
  assert.ok(checkpoint.plan.stages.some((s) => s.id === 'c'));
  assert.match(f.calls.find((c) => c.kind === 'plan').input, /단순한 게시 업무는 조사·작성·게시를 같은 직원 한 명에게/);
  assert.match(f.calls.find((c) => c.kind === 'progress').input, /완료된 단계는 지우거나 바꾸지 말고/);
});

test('진행 점검: 완료된 단계를 바꾸는 수정은 받지 않고 남은 계획대로 진행한다', async (t) => {
  const f = fixture(t, { progress: (n, input) => {
    const plan = currentPlan(input);
    plan.stages = plan.stages.map((s) => s.id === 'a' ? { ...s, done: '완료 기준을 몰래 바꿈' } : s);
    return { action: 'revise', reason: '완료 단계 수정 시도', question: '', revisedPlan: plan };
  } });
  const first = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘' });
  await f.final(first);
  assert.equal(loadTasks(f.root)[0].status, 'done');
  assert.deepEqual([f.counts.a, f.counts.b], [1, 1]);
  const checkpoint = JSON.parse(readFileSync(join(f.root, '.office', 'orchestrations', `${first.rootId}.json`)));
  assert.equal(checkpoint.revisionCount, 0);
  assert.match(checkpoint.revisions[0].rejected, /완료된 단계\(a\)/);
  assert.equal(checkpoint.plan.stages.find((s) => s.id === 'a').done, '내용을 작성한다');
});

test('진행 점검: 대표 결정이 필요하면 묻고, 답하면 완료 단계를 반복하지 않고 이어 간다', async (t) => {
  const f = fixture(t, { progress: (n) => n === 1 ? { action: 'question', reason: '방향 확인 필요', question: '보고서를 요약본으로 할까요, 상세본으로 할까요?', revisedPlan: null }
    : { action: 'continue', reason: '답을 반영', question: '', revisedPlan: null } });
  const first = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘' });
  const asked = await f.final(first);
  assert.equal(asked.needsReply, true);
  assert.match(f.runner.result(first.id).text, /요약본으로 할까요/);
  await f.final(f.runner.reply(first.id, { prompt: '상세본으로 해줘' }));
  assert.equal(loadTasks(f.root)[0].status, 'done');
  assert.deepEqual([f.counts.a, f.counts.b], [1, 1]);
});

test('외부 글은 위임이 없으면 실행 전에 한 번 확인하고, "진행"이면 올리고 "하지 마"면 올리지 않는다', async (t) => {
  for (const [answer, expected] of [['진행', 1], ['하지 마', 0]]) {
    let deliveries = 0;
    const f = fixture(t, { publication: true, outbound: { connections: () => [{ id: 'naver-1', label: '네이버', provider: 'naver', status: 'connected' }],
      async deliver() { deliveries++; return { status: 'confirmed', resultUrl: 'https://blog.naver.com/fixture/1' }; } } });
    const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘' });
    assert.equal((await f.final(first)).needsReply, true);
    assert.match(f.runner.result(first.id).text, /외부 작업을 실행할까요[\s\S]*글 \[네이버\] https:\/\/blog\.naver\.com\/fixture/);
    assert.equal(deliveries, 0, '확인 전에는 올리지 않는다');
    await f.final(f.runner.reply(first.id, { prompt: answer }));
    assert.equal(deliveries, expected, answer);
    assert.equal(loadTasks(f.root)[0].status, 'done');
    if (!expected) assert.match(readFileSync(join(f.root, 'outputs', ...loadTasks(f.root)[0].id.split('/'), 'report.md'), 'utf8'), /대표 결정으로 실행하지 않음/);
  }
});

// ── 업무 예산 ──
test('업무 예산 80%에서 계속할지 묻고, "계속"이면 처음 예산만큼 늘려 끝내고 "그만"이면 멈춘다', async (t) => {
  for (const [answer, done] of [['계속', true], ['그만', false]]) {
    const f = fixture(t);
    saveSettings(f.root, { budget: { calls: 5, minutes: 60 } });
    const first = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘' });
    assert.equal((await f.final(first)).needsReply, true);
    assert.match(f.runner.result(first.id).text, /예산의 80%를 썼습니다\(AI 호출 4\/5회/);
    assert.equal(f.counts.review, 0, '검토 전에 멈춘다');
    const next = f.runner.reply(first.id, { prompt: answer });
    await f.final(next);
    assert.equal(loadTasks(f.root)[0].status, done ? 'done' : 'closed', answer);
    assert.deepEqual([f.counts.a, f.counts.b], [1, 1], '완료 단계는 반복하지 않는다');
    if (!done) assert.match(f.runner.result(next.id).text, /대표 결정으로 업무를 끝냈습니다/);
    const checkpoint = JSON.parse(readFileSync(join(f.root, '.office', 'orchestrations', `${first.rootId}.json`)));
    assert.equal(checkpoint.budget.limitCalls, done ? 10 : 5);
    // 날짜별 사용량 기록의 호출 수는 업무 예산이 센 호출 수와 같다(상시 업무 하루 사용량 집계에 쓰임)
    const recorded = f.runner.list().filter((r) => r.rootId === first.rootId && !r.parentId || r.id === next.id)
      .reduce((sum, r) => sum + Object.values(r.dailyUsage || {}).reduce((n, d) => n + d.calls, 0), 0);
    assert.equal(recorded, checkpoint.budget.calls);
  }
});

test('예약 업무처럼 대표가 없는 업무는 예산을 묻지 않고, 다 쓰면 그 회차만 멈춘다', async (t) => {
  const f = fixture(t, { rejects: 100 });
  saveSettings(f.root, { budget: { calls: 5, minutes: 60 } });
  const run = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘', schedule: { id: 'daily-1', slot: '2026-11-03' } });
  await f.final(run);
  assert.equal(loadTasks(f.root)[0].status, 'blocked');
  assert.match(f.runner.result(run.id).text, /이번 회차 업무가 예산을 모두 써서 멈췄습니다\(AI 호출 5\/5회/);
  assert.doesNotMatch(f.runner.result(run.id).text, /계속할까요/);
});

// ── 검토 루프 ──
test('검토 루프: 여러 단계를 한 번에 단계별 수정 사항과 함께 반려하고, 각 단계는 자기 사유로 다시 작업한다', async (t) => {
  const f = fixture(t, { review: (n) => n === 1
    ? { verdict: 'reject', stages: [{ id: 'a', reason: '출처 확인일 추가' }, { id: 'b', reason: '요약 표 수정' }], reason: '두 단계 보완' }
    : { verdict: 'pass', reason: '보완 확인' } });
  const first = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘' });
  await f.final(first);
  assert.equal(loadTasks(f.root)[0].status, 'done', f.runner.result(first.id).text);
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.review], [2, 2, 2]);
  const redo = (id) => f.calls.filter((c) => c.kind === id).at(-1).input;
  assert.match(redo('a'), /(?:^|\n)\[반려\] a\n\n## 목표·대표 요청/, '재작업 지시는 [반려]로 시작한다(Codex 직원은 직원 지침 뒤)');
  assert.match(redo('a'), /반려 사유\(모두 반영\): 출처 확인일 추가/);
  assert.match(redo('b'), /반려 사유\(모두 반영\): 요약 표 수정/);
});

test('검토 루프: 기존 단계로 채울 수 없으면 검토에서 단계를 추가하고, 완료 단계는 반복하지 않는다', async (t) => {
  const f = fixture(t, { review: (n, input) => {
    if (n !== 1) return { verdict: 'pass', reason: '보완 확인' };
    const plan = JSON.parse(input.match(/계획: (.*)/)[1]);
    const b = plan.stages.find((s) => s.id === 'b');
    plan.stages.push({ id: 'c', title: '보충 분석', dept: 'dev', agent: 'dev-1', inputs: ['b'], dependsOn: ['b'], output: b.output.replace(/-b\.txt$/, '-c.txt'), done: '빠진 비교 분석을 추가한다', parallelGroup: '' });
    return { verdict: 'revise', reason: '비교 분석이 빠져 단계를 추가', revisedPlan: plan };
  } });
  const first = f.runner.start({ prompt: '자료를 조사해 보고서로 정리해 줘' });
  await f.final(first);
  assert.equal(loadTasks(f.root)[0].status, 'done', f.runner.result(first.id).text);
  assert.deepEqual([f.counts.a, f.counts.b, f.counts.c, f.counts.review], [1, 1, 1, 2]);
  const checkpoint = JSON.parse(readFileSync(join(f.root, '.office', 'orchestrations', `${first.rootId}.json`)));
  assert.deepEqual(checkpoint.revisions.at(-1).added, ['c']);
});

test('검토 루프: 검증실은 계획의 검토 기준을, 비서실장은 대표 요청 충족을 보며 같은 항목을 다시 검토하지 않는다', async (t) => {
  const f = fixture(t, { reviewBy: 'codex', reviewerVerdict: 'PASS' });
  const first = f.runner.start({ prompt: '검증실 검토가 필요한 업무' });
  await f.final(first);
  assert.equal(loadTasks(f.root)[0].status, 'done');
  assert.match(f.calls.find((c) => c.kind === 'reviewer').input, /검토 기준: 근거와 산출물을 확인한다[\s\S]*기술·사실 확인에 집중/);
  assert.match(f.calls.find((c) => c.kind === 'review').input, /검증실이 이미 확인한 항목은 다시 검토하지 말고/);
});
