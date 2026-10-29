#!/usr/bin/env node
// 업무 폴더·회사 구성 관리 CLI
//   node scripts/office.mjs task start "<제목>" [--slug x]
//   node scripts/office.mjs task status <id> blocked|active [--by-user]   done·review와 review·done에서의 변경은 --by-user(대표 직접)
//   node scripts/office.mjs task list [--json]
//   node scripts/office.mjs flow <업무> review-request|review|deliver|cooperate ...   업무 흐름 명시 기록
//   node scripts/office.mjs meeting <업무> start|end ...                            회의 기록
//   node scripts/office.mjs plan validate <업무>                                    작업 계획표 검사
//   node scripts/office.mjs org export <파일> [--yes]
//   node scripts/office.mjs org import <파일> [--yes]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { WorkspaceError, kstDate, officeDir, outputsDir, workspaceRoot } from '../lib/paths.mjs';
import { readEvents, redact } from '../lib/events.mjs';
import { checkOrgImport, exportOrg, importOrg, loadCompanyRules, loadOrg, writeFileAtomic } from '../lib/org.mjs';
import { TASK_STATUSES, loadTasks as loadTaskList, saveTasks as saveTaskList } from '../lib/tasks.mjs';
import { isTaskId, validatePlan } from '../lib/plan.mjs';
import { countReviewRejects } from '../lib/flow.mjs';
import { MAX_REVIEW_REJECTS } from '../lib/chief-guard.mjs';

const STATUSES = TASK_STATUSES;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USAGE = [
  '사용법:',
  '  node scripts/office.mjs task start "<제목>" [--slug x]',
  '  node scripts/office.mjs task status <id> blocked|active   (done·review 전환과 사용자 확인 대기·완료 업무 변경은 대표가 --by-user로)',
  '  node scripts/office.mjs task list [--json]',
  '  node scripts/office.mjs flow <업무> review-request --from <부서> [--note "…"]   검토 요청(부서 → 비서실장)',
  '  node scripts/office.mjs flow <업무> review --verdict pass|reject [--to <부서|직원>] [--stage <단계 id>] [--reason "…"]   검토 결과(반려는 --to 필요, 최대 2회)',
  '  node scripts/office.mjs flow <업무> deliver [--note "…"]   사용자 확인 대기로 전환(task status review)',
  '  node scripts/office.mjs flow <업무> cooperate --from <부서A> --to <부서B> [--note "…"]   업무 협조 요청(비서실장 전달)',
  '  node scripts/office.mjs meeting <업무> start --attendees a,b [--agenda "…"]   회의 시작(직원 id 또는 부서 id)',
  '  node scripts/office.mjs meeting <업무> end [--summary "…"]   회의 종료',
  '  node scripts/office.mjs plan validate <업무>   outputs/<업무>/plan.json 검사(통과하면 plan.set 기록, 실패하면 종료 코드 1)',
  '  node scripts/office.mjs org export <파일> [--yes]   회사 구성(부서·직원·회사 규칙) 내보내기',
  '  node scripts/office.mjs org import <파일> [--yes]   내보낸 파일로 현재 회사 구성을 덮어쓰기',
].join('\n');

class UsageError extends Error {}

// 데이터 위치는 작업 공간이다(AI_OFFICE_WORKSPACE > .office-local.json > 호환 모드 > ~/AIOffice).
// 작업 공간의 scripts/office.mjs(생성된 연결 파일)로 실행하면 그 작업 공간이 AI_OFFICE_WORKSPACE로 정해진다
let root;
try {
  root = workspaceRoot();
} catch (err) {
  if (!(err instanceof WorkspaceError)) throw err;
  console.error(`오류: ${err.message}`);
  process.exit(1);
}
const loadTasks = () => loadTaskList(root);
const saveTasks = (tasks) => saveTaskList(root, tasks);

// 정규화 이벤트 한 줄을 .office/events.jsonl에 추가한다.
function appendTaskEvent(kind, task, summary, extra = {}) {
  const ev = {
    v: 1,
    ts: new Date().toISOString(),
    engine: 'claude',
    session: 'office-cli',
    agent: 'chief',
    instance: 'office-cli',
    kind,
    task,
    ...(summary ? { summary: redact(summary) } : {}),
    ...extra,
  };
  appendFileSync(join(officeDir(root), 'events.jsonl'), JSON.stringify(ev) + '\n');
}

function slugFromTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

function briefText(task) {
  return [
    `# ${task.title}`,
    '',
    `- 업무 id: ${task.id}`,
    `- 등록: ${task.created}`,
    '- 상태: active',
    '',
    '## 요청 요지',
    '',
    '(비서실장이 대표의 요청을 한두 문장으로 정리한다. 비밀값은 적지 않는다.)',
    '',
    '## 완료 기준',
    '',
    '- ',
    '',
    '## 배정',
    '',
    '| 직원 id | 부서 | 맡은 일 | 산출물 경로 |',
    '|---|---|---|---|',
    '',
    '## 산출물 규칙',
    '',
    `- 직원 산출물: \`outputs/${task.id}/<부서id>/<직원id>-<내용>.md\``,
    `- 팀장 취합: \`outputs/${task.id}/<부서id>/dept-report.md\``,
    `- Codex 검증: \`node scripts/codex-review.mjs --target outputs/${task.id} --task ${task.id}\` → \`reviews/*.md\``,
    `- 최종 보고: \`outputs/${task.id}/report.md\` (완료 / 확인 필요 / 근거)`,
    '',
  ].join('\n');
}

function taskStart(args) {
  let slug = null;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--slug') {
      slug = args[++i];
      if (!slug) throw new UsageError('--slug 값이 없습니다.');
    } else if (args[i].startsWith('--slug=')) {
      slug = args[i].slice('--slug='.length);
    } else {
      words.push(args[i]);
    }
  }
  const title = words.join(' ').trim();
  if (!title) throw new UsageError('업무 제목이 필요합니다.');

  const date = kstDate();
  const tasks = loadTasks();
  const ids = new Set(tasks.map((t) => t.id));
  const dayDir = join(outputsDir(root), date);
  const taken = (s) => ids.has(`${date}/${s}`) || existsSync(join(dayDir, s));

  if (slug !== null) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new UsageError(`slug 형식이 올바르지 않습니다: ${slug} (영문 소문자·숫자·하이픈, 64자 이하)`);
    }
    if (taken(slug)) {
      // 기존 업무를 이어 쓰면 OFFICE_TASK 출력이 없어 세션이 업무에 연결되지 않는다(가드·피드 누락). 새 slug로 등록하게 안내한다
      let next = 2;
      while (taken(`${slug}-${next}`)) next++;
      throw new Error(`이미 있는 업무입니다: ${date}/${slug}. 새 요청이면 --slug ${slug}-${next}처럼 다른 slug로 다시 등록하세요. 기존 업무 폴더에 이어 쓰지 마세요(세션이 업무에 연결되지 않습니다).`);
    }
  } else {
    const base = slugFromTitle(title) || 'task';
    slug = base;
    for (let n = 2; taken(slug); n++) slug = `${base}-${n}`;
  }

  const task = { id: `${date}/${slug}`, title, status: 'active', created: new Date().toISOString() };
  const dir = join(dayDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.md'), briefText(task));
  tasks.push(task);
  saveTasks(tasks);
  appendTaskEvent('task.start', task.id, title);

  console.log(`업무를 등록했습니다: ${task.title}`);
  console.log(`업무 폴더: outputs/${task.id}/`);
  console.log(`브리프: outputs/${task.id}/brief.md`);
  console.log(`OFFICE_TASK=${task.id}`);
}

// 상태 전이 규칙. 비서실장(가드가 막지 못한 경우 포함)은 active↔blocked만 바꾼다.
// done은 대표가 대시보드에서 승인할 때(서버), review는 flow deliver로만 바뀐다. 사용자 확인 대기·완료 업무를 되돌리는 것도 대표 몫이다.
// 터미널에서 대시보드 없이 쓰는 대표는 --by-user로 직접 바꿀 수 있다
function taskStatus(args) {
  const byUser = args.includes('--by-user');
  const [id, status, ...extra] = args.filter((a) => a !== '--by-user');
  if (!id || !status) throw new UsageError('업무 id와 상태가 필요합니다.');
  if (extra.length) throw new UsageError(`알 수 없는 인자입니다: ${extra.join(' ')}`);
  if (!STATUSES.includes(status)) throw new UsageError(`상태는 ${STATUSES.join('|')} 중 하나여야 합니다: ${status}`);
  if (byUser && process.env.OFFICE_CHIEF_RUN === '1') throw new Error('--by-user는 대표가 터미널에서 직접 실행할 때만 씁니다. 비서실장 실행에서는 쓸 수 없습니다.');
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`업무를 찾을 수 없습니다: ${id} (task list로 확인하세요)`);
  const before = task.status;
  if (!byUser) {
    if (status === 'done') throw new Error('완료(done)는 대표가 대시보드에서 승인할 때 기록됩니다. 결과 확인은 `flow <업무> deliver`로 요청하세요. (대시보드 없이 대표가 직접 완료하려면 --by-user)');
    if (status === 'review') throw new Error('사용자 확인 대기(review)는 `node scripts/office.mjs flow <업무> deliver`로 요청하세요.');
    if (before === 'review' || before === 'done') {
      throw new Error(`${before === 'review' ? '사용자 확인 대기' : '완료'} 업무는 대표의 승인·반려로만 바뀝니다(현재: ${before}). (대표가 직접 바꾸려면 --by-user)`);
    }
  }
  task.status = status;
  task.updated = new Date().toISOString();
  saveTasks(tasks);
  appendTaskEvent('task.update', id, `${task.title}: ${before} → ${status}`, { status });

  console.log(`업무 상태를 바꿨습니다: ${id} ${before} → ${status}`);
  if (status === 'done') {
    const { report, reviews } = artifacts(id);
    if (!report) console.error(`주의: outputs/${id}/report.md가 없습니다.`);
    if (!reviews) console.error(`주의: outputs/${id}/reviews/에 검증 결과가 없습니다.`);
  }
}

function artifacts(id) {
  const dir = join(outputsDir(root), id);
  const reviewsDir = join(dir, 'reviews');
  return {
    report: existsSync(join(dir, 'report.md')),
    reviews: existsSync(reviewsDir) ? readdirSync(reviewsDir).filter((f) => f.endsWith('.md')).length : 0,
  };
}

function taskList(args) {
  const tasks = loadTasks().map((t) => ({ ...t, ...artifacts(t.id) }));
  if (args.includes('--json')) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (!tasks.length) {
    console.log('등록된 업무가 없습니다.');
    return;
  }
  for (const t of tasks) {
    console.log(`${t.id}\t${t.status}\t${t.title}\t보고서:${t.report ? '있음' : '없음'}\t리뷰:${t.reviews}개`);
  }
}

// ---- 업무 흐름·회의·계획표 (비서실장이 기록, 자동 도출보다 우선) ----
// --키 값 / --키=값 옵션을 읽는다. allowed 밖의 옵션이나 값 없는 옵션은 사용법 오류다
function parseOptions(args, allowed) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (!allowed.includes(key)) throw new UsageError(`알 수 없는 옵션입니다: --${key}`);
    const value = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${key} 값이 없습니다.`);
    opts[key] = value;
  }
  return { opts, rest };
}

// 이미 등록된 업무인지 확인한다(경로로도 쓰므로 형식부터 검사)
function requireTask(id) {
  if (!id) throw new UsageError('업무 id가 필요합니다.');
  if (!isTaskId(id)) throw new UsageError(`업무 id 형식이 올바르지 않습니다: ${id} (예: 2026-10-29/competitor-scan)`);
  const task = loadTasks().find((t) => t.id === id);
  if (!task) throw new Error(`업무를 찾을 수 없습니다: ${id} (task list로 확인하세요)`);
  return task;
}

// 부서 id 또는 직원 id → 부서 id. 없으면 사용 가능한 부서 목록과 함께 오류
function resolveDept(value, label) {
  if (!value) throw new UsageError(`${label} 부서가 필요합니다.`);
  const { departments, roster } = loadOrg(root);
  if (departments.some((d) => d.id === value)) return value;
  const agent = roster.find((a) => a.id === value);
  if (agent) return agent.department;
  throw new Error(`${label} 부서를 찾을 수 없습니다: ${value}. 있는 부서: ${departments.map((d) => d.id).join(', ') || '(없음)'}`);
}

// 이 업무의 지금까지 이벤트(반려 횟수 계산용)
function taskEvents() {
  return readEvents(join(officeDir(root), 'events.jsonl')).events;
}

function flowCmd(args) {
  const [id, action, ...rest] = args;
  if (!action) throw new UsageError('flow 하위 동작이 필요합니다(review-request|review|deliver|cooperate).');
  const { opts, rest: extra } = parseOptions(rest, ['from', 'to', 'verdict', 'reason', 'note', 'stage']);
  if (extra.length) throw new UsageError(`알 수 없는 인자입니다: ${extra.join(' ')}`);
  const task = requireTask(id);
  if (action === 'review-request') {
    const from = resolveDept(opts.from, '--from');
    appendTaskEvent('flow.review_request', task.id, opts.note, { from });
    console.log(`검토 요청을 기록했습니다: ${from} → 비서실장 (${task.id})`);
    return;
  }
  if (action === 'review') {
    if (opts.verdict !== 'pass' && opts.verdict !== 'reject') throw new UsageError('--verdict는 pass 또는 reject여야 합니다.');
    const to = opts.verdict === 'reject' || opts.to ? resolveDept(opts.to, '--to') : undefined;
    // --to에 직원 id를 주면 그 직원의 단계만 반려로 표시한다(부서에 단계가 여럿일 때 엉뚱한 단계가 표시되지 않게)
    const agent = opts.to && opts.to !== to && loadOrg(root).roster.some((a) => a.id === opts.to) ? opts.to : undefined;
    if (opts.stage !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(opts.stage)) throw new UsageError(`--stage는 계획표 단계 id여야 합니다: ${opts.stage}`);
    if (opts.verdict === 'reject') {
      const { flows, calls } = countReviewRejects(taskEvents(), task.id);
      // 이번 기록이 이미 보낸 [반려] 재지시의 기록이면 그 회차, 아니면 새 회차다
      if (Math.max(flows + 1, calls) > MAX_REVIEW_REJECTS) {
        console.error(`오류: 반려는 같은 업무에서 최대 ${MAX_REVIEW_REJECTS}회입니다(이미 ${Math.max(flows, calls)}회). 남은 문제를 outputs/${task.id}/report.md의 "확인 필요"에 적고 \`node scripts/office.mjs flow ${task.id} deliver\`로 사용자 확인을 요청하세요.`);
        process.exitCode = 1;
        return;
      }
    }
    appendTaskEvent('flow.review', task.id, opts.reason, { verdict: opts.verdict, ...(to ? { to } : {}), ...(agent ? { target: agent } : {}), ...(opts.stage ? { stage: opts.stage } : {}) });
    if (opts.verdict === 'pass') {
      console.log(`검토 통과를 기록했습니다: ${task.id}. report.md를 쓰고 flow ${task.id} deliver를 실행하세요.`);
    } else {
      console.log(`검토 반려를 기록했습니다: 비서실장 → ${to} (${task.id}). [반려] Agent 호출로 사유와 수정 기준을 전달하세요(반려는 최대 2회).`);
    }
    return;
  }
  if (action === 'deliver') {
    const tasks = loadTasks();
    const t = tasks.find((x) => x.id === task.id);
    const before = t.status;
    // 사용자 확인 요청은 진행 중(active·blocked) 업무에서만 한다. 완료 업무를 되돌리거나 같은 요청을 겹쳐 보내지 않는다
    if (before === 'review') throw new Error(`이미 사용자 확인 대기 중입니다: ${task.id}. 대표의 승인·반려를 기다리세요.`);
    if (before === 'done') throw new Error(`이미 완료된 업무입니다: ${task.id}. 새 요청이면 task start로 새 업무를 등록하세요.`);
    t.status = 'review';
    t.updated = new Date().toISOString();
    saveTasks(tasks);
    appendTaskEvent('flow.deliver', task.id, opts.note);
    appendTaskEvent('task.update', task.id, `${t.title}: ${before} → review`, { status: 'review' });
    console.log(`사용자 확인 대기로 바꿨습니다: ${task.id} (${before} → review)`);
    if (!artifacts(task.id).report) console.error(`주의: outputs/${task.id}/report.md가 없습니다.`);
    return;
  }
  if (action === 'cooperate') {
    const from = resolveDept(opts.from, '--from');
    const to = resolveDept(opts.to, '--to');
    if (from === to) throw new UsageError('--from과 --to가 같은 부서입니다.');
    appendTaskEvent('flow.cooperate', task.id, opts.note, { from, to });
    console.log(`업무 협조 요청을 기록했습니다: ${from} → ${to} (${task.id})`);
    return;
  }
  throw new UsageError(`알 수 없는 flow 동작입니다: ${action}`);
}

function meetingCmd(args) {
  const [id, action, ...rest] = args;
  const { opts, rest: extra } = parseOptions(rest, ['attendees', 'agenda', 'summary']);
  if (extra.length) throw new UsageError(`알 수 없는 인자입니다: ${extra.join(' ')}`);
  if (action !== 'start' && action !== 'end') throw new UsageError('meeting 동작은 start 또는 end여야 합니다.');
  const task = requireTask(id);
  if (action === 'start') {
    const list = String(opts.attendees ?? '').split(',').map((a) => a.trim()).filter(Boolean);
    if (!list.length) throw new UsageError('--attendees(참석 직원 id 또는 부서 id, 쉼표 구분)가 필요합니다.');
    const { departments, roster } = loadOrg(root);
    const known = new Set([...departments.map((d) => d.id), ...roster.map((a) => a.id)]);
    const unknown = list.filter((a) => !known.has(a));
    if (unknown.length) throw new Error(`조직에 없는 참석자입니다: ${unknown.join(', ')}`);
    appendTaskEvent('meeting.start', task.id, opts.agenda, { attendees: list.slice(0, 20) });
    console.log(`회의 시작을 기록했습니다: ${task.id} (참석 ${list.length}명). 결과는 outputs/${task.id}/meeting.md에 정리하세요.`);
    return;
  }
  appendTaskEvent('meeting.end', task.id, opts.summary);
  console.log(`회의 종료를 기록했습니다: ${task.id}`);
}

function planCmd(args) {
  const [action, id, ...extra] = args;
  if (action !== 'validate') throw new UsageError('plan 하위 명령은 validate만 있습니다.');
  if (extra.length) throw new UsageError(`알 수 없는 인자입니다: ${extra.join(' ')}`);
  if (!id) throw new UsageError('업무 id가 필요합니다.');
  if (!isTaskId(id)) throw new UsageError(`업무 id 형식이 올바르지 않습니다: ${id} (예: 2026-10-29/competitor-scan)`);
  const rel = `outputs/${id}/plan.json`;
  const file = join(outputsDir(root), ...id.split('/'), 'plan.json');
  if (!existsSync(file)) throw new Error(`계획표가 없습니다: ${rel}`);
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    console.error(`계획표 검사 실패: ${rel}`);
    console.error(`  - JSON 형식이 아닙니다: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const fileExists = (p) => {
    try { return statSync(p).isFile(); } catch { return false; }
  };
  const result = validatePlan(plan, { org: loadOrg(root), taskId: id, root, fileExists });
  for (const w of result.warnings) console.error(`주의: ${w}`);
  if (!result.ok) {
    console.error(`계획표 검사 실패: ${rel}`);
    for (const e of result.errors) console.error(`  - ${e}`);
    console.error('고친 뒤 다시 실행하세요.');
    process.exitCode = 1;
    return;
  }
  if (!loadTasks().some((t) => t.id === id)) console.error(`주의: 등록되지 않은 업무입니다: ${id} (task start로 등록하세요)`);
  const gaps = result.plan.gaps.length;
  appendTaskEvent('plan.set', id, `계획 확정: 단계 ${result.plan.stages.length}개${gaps ? `, 역량 공백 ${gaps}건` : ''}`, { plan: result.plan });
  console.log(`계획표 검사 통과: 단계 ${result.plan.stages.length}개${gaps ? `, 역량 공백 ${gaps}건(보고서에 명시하세요)` : ''} (${rel})`);
}

// ---- 회사 구성 내보내기·가져오기 ----
function orgArgs(args) {
  const yes = args.includes('--yes') || args.includes('-y');
  const files = args.filter((a) => a !== '--yes' && a !== '-y');
  const unknown = files.find((a) => a.startsWith('-'));
  if (unknown) throw new UsageError(`알 수 없는 옵션입니다: ${unknown}`);
  if (files.length !== 1) throw new UsageError('파일 경로를 하나 지정하세요.');
  return { file: resolve(files[0]), yes };
}

const describeOrg = ({ departments, roster }, company) =>
  `부서 ${departments}개 · 직원 ${roster}명${company ? ' · 회사 공통 규칙 있음' : ''}`;

// 대시보드 비서실장 실행(OFFICE_CHIEF_RUN=1)에서는 조직 정본을 바꾸거나 임의 경로에 쓰지 않는다(chief-guard와 이중 방어)
function refuseInChiefRun() {
  if (process.env.OFFICE_CHIEF_RUN === '1') throw new Error('회사 구성 내보내기·가져오기는 대표가 직접 실행합니다(비서실장 실행에서는 쓸 수 없습니다).');
}

function orgExport(args) {
  refuseInChiefRun();
  const { file, yes } = orgArgs(args);
  if (existsSync(file) && !yes) throw new Error(`이미 있는 파일입니다: ${file}. 덮어쓰려면 --yes를 붙이세요.`);
  const data = exportOrg(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`회사 구성을 내보냈습니다: ${file}`);
  console.log(describeOrg({ departments: data.departments.length, roster: data.roster.length }, Boolean(data.company.trim())));
}

async function confirm(question) {
  // 대화형 터미널에서만 묻는다. 파이프·CI에서는 --yes 없이 덮어쓰지 않는다
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes|예|네)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function orgImport(args) {
  refuseInChiefRun();
  const { file, yes } = orgArgs(args);
  if (!existsSync(file)) throw new Error(`파일이 없습니다: ${file}`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`JSON 형식이 아닙니다: ${file} (${err.message})`);
  }
  const check = checkOrgImport(data);
  if (!check.ok) {
    console.error('회사 구성 파일 검증에 실패해 아무것도 바꾸지 않았습니다:');
    for (const e of check.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  const current = loadOrg(root);
  console.log(`가져올 파일: ${describeOrg(check.summary, check.summary.company)}`);
  console.log(`현재 구성:   ${describeOrg({ departments: current.departments.length, roster: current.roster.length }, Boolean(loadCompanyRules(root).trim()))}`);
  if (!yes && !(await confirm('현재 회사 구성을 모두 덮어씁니다. 계속할까요? (y/N) '))) {
    console.error('덮어쓰지 않았습니다. 확인 없이 진행하려면 --yes를 붙이세요.');
    process.exitCode = 1;
    return;
  }
  const { sync } = await importOrg(root, data, { mode: 'replace' });
  console.log(`회사 구성을 가져왔습니다: ${describeOrg(check.summary, check.summary.company)}`);
  console.log(`에이전트 파일: 생성·갱신 ${sync.changed.length}개, 삭제 ${sync.removed.length}개`);
  for (const c of sync.conflicts) console.error(`주의: ${c} — 생성 표식이 없는 기존 파일이라 덮어쓰지 않았습니다.`);
}

async function main(argv) {
  const [group, cmd, ...rest] = argv;
  if (group === 'task') {
    if (cmd === 'start') return taskStart(rest);
    if (cmd === 'status') return taskStatus(rest);
    if (cmd === 'list') return taskList(rest);
    throw new UsageError('알 수 없는 task 하위 명령입니다.');
  }
  if (group === 'flow') return flowCmd([cmd, ...rest]);
  if (group === 'meeting') return meetingCmd([cmd, ...rest]);
  if (group === 'plan') return planCmd([cmd, ...rest]);
  if (group === 'org') {
    if (cmd === 'export') return orgExport(rest);
    if (cmd === 'import') return orgImport(rest);
    throw new UsageError('알 수 없는 org 하위 명령입니다.');
  }
  throw new UsageError('알 수 없는 명령입니다.');
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`오류: ${err.message}`);
  if (err instanceof UsageError) {
    console.error(USAGE);
    process.exit(64);
  }
  process.exit(1);
}
