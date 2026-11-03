import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const until = Date.now() + 4000;
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
      const schema = args.includes('--json-schema') ? (JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.plan ? 'plan.json' : JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.status ? 'stage.json' : JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.verdict ? 'review.json' : 'route.json') : args[args.indexOf('--output-schema') + 1] || '';
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
      } else if (schema.endsWith('route.json')) {
        call.kind = 'route'; finish(JSON.stringify({ department: 'dev', agent: 'dev-1', reason: '개발부 소관', question: '' }));
      } else if (schema.endsWith('review.json')) {
        call.kind = 'review'; counts.review++;
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
  assert.deepEqual(loadSettings(f.root).chief, { engine: 'codex', model: 'gpt-6.1-sol', effort: 'max' });
  const run = f.runner.start({ prompt: '자료를 조사하고 문서를 만들어 줘' });
  const result = await f.final(run);
  assert.equal(result.status, 'done');
  assert.deepEqual([result.engine, result.model, result.effort], ['codex', 'gpt-6.1-sol', 'max']);
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

test('검증실 BLOCK과 반려 2회 한도는 전달을 막는다', async (t) => {
  for (const options of [{ reviewerVerdict: 'BLOCK', reviewBy: 'codex' }, { rejects: 10 }]) {
    const f = fixture(t, options);
    const run = f.runner.start({ prompt: '검토가 필요한 업무' });
    await f.final(run);
    assert.equal(loadTasks(f.root)[0].status, 'blocked');
    assert.ok(f.counts.review <= 3);
    assert.ok(f.counts.a <= 3);
  }
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

test('지시창 판별(근거 확인된 외부 작업·위임)이 업무 내내 쓰이고, 답장 뜻은 AI 판별로 알아본다', async (t) => {
  const calls = [];
  const outbound = { connections: () => [{ id: 'erp-1', label: 'ERP', provider: 'web', status: 'connected' }], async deliver(args) { calls.push(args); return { status: 'confirmed', summary: '완료' }; } };
  // 규칙으로는 업로드·위임으로 보지 않는 문장이지만, 지시창 판별이 근거와 함께 넘긴 값을 쓴다
  const delegated = fixture(t, { webPublication: true, outbound });
  const first = delegated.runner.start({ prompt: '자료를 HTML로 만들어 ERP 제휴 화면에 걸어 두고 마무리까지 맡길게', intent: { actions: ['web'], delegated: true, source: 'ai' } });
  assert.equal((await delegated.final(first)).needsReply, false);
  assert.equal(calls.length, 1);
  // 판별에 외부 작업이 없으면 계획의 웹 작업을 받아들이지 않는다(계획 재요청 뒤 막힘)
  const none = fixture(t, { webPublication: true, outbound });
  const blockedRun = none.runner.start({ prompt: '자료를 HTML로 만들어 줘', intent: { actions: [], delegated: false, source: 'ai' } });
  await none.final(blockedRun);
  assert.match(none.runner.result(blockedRun.id).text, /지시하지 않은 외부/);
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

test('필요한 계정이 없으면 작업 전에 묻고, 등록 뒤 이어서 진행한다(웹사이트 계정은 계획을 다시 세운다)', async (t) => {
  let accounts = [];
  const delivered = [];
  const outbound = { connections: () => accounts, async deliver(args) { delivered.push(args); return { status: 'confirmed', resultUrl: 'https://blog.naver.com/x/1' }; },
    browse: (args) => args.execute({ url: 'http://127.0.0.1:9/tools', token: 't', permissionsFile: join(tmpdir(), 'office-fixture-permissions.json'), write: true }) };
  const f = fixture(t, { publication: true, outbound });
  const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘' });
  assert.equal((await f.final(first)).needsReply, true);
  assert.match(f.runner.result(first.id).text, /네이버 블로그·카페 계정[\s\S]*보관함\/계정\.env/);
  assert.deepEqual([f.counts.a, f.counts.b], [0, 0], '계정 확인 전에는 작업을 시작하지 않는다');
  accounts = [{ id: 'naver-1', label: '홍보용', provider: 'naver', status: 'disconnected', hasCredentials: true, source: 'file' }];
  await f.final(f.runner.reply(first.id, { prompt: '계정 넣었어, 이어서 재개' }));
  assert.equal(delivered.length, 1);
  assert.deepEqual([f.counts.plan, f.counts.a, f.counts.b], [1, 1, 1], '블로그 계정은 계획을 다시 세우지 않는다');
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
  const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘' });
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
  const first = f.runner.start({ prompt: '자료를 정리하고 블로그에 게시해 줘' });
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
