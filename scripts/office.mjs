#!/usr/bin/env node
// 업무 폴더·회사 구성 관리 CLI
//   node scripts/office.mjs task start "<제목>" [--slug x]
//   node scripts/office.mjs task status <id> done|blocked|active
//   node scripts/office.mjs task list [--json]
//   node scripts/office.mjs org export <파일> [--yes]
//   node scripts/office.mjs org import <파일> [--yes]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { kstDate, officeDir, outputsDir, renameWithRetry, repoRoot } from '../lib/paths.mjs';
import { redact } from '../lib/events.mjs';
import { checkOrgImport, exportOrg, importOrg, loadCompanyRules, loadOrg, writeFileAtomic } from '../lib/org.mjs';

const STATUSES = ['active', 'done', 'blocked'];
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USAGE = [
  '사용법:',
  '  node scripts/office.mjs task start "<제목>" [--slug x]',
  '  node scripts/office.mjs task status <id> done|blocked|active',
  '  node scripts/office.mjs task list [--json]',
  '  node scripts/office.mjs org export <파일> [--yes]   회사 구성(부서·직원·회사 규칙) 내보내기',
  '  node scripts/office.mjs org import <파일> [--yes]   내보낸 파일로 현재 회사 구성을 덮어쓰기',
].join('\n');

class UsageError extends Error {}

const root = repoRoot();
const tasksFile = () => join(officeDir(root), 'tasks.json');

function loadTasks() {
  const file = tasksFile();
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`배열 형식이어야 합니다: ${file}`);
  return data;
}

function saveTasks(tasks) {
  const file = tasksFile();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(tasks, null, 2) + '\n');
  renameWithRetry(tmp, file);
}

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
    summary: redact(summary),
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
    `- 팀장 취합: \`outputs/${task.id}/<부서id>/summary.md\``,
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
      throw new Error(`이미 있는 업무입니다: ${date}/${slug}. 이어서 진행하려면 기존 업무를 쓰거나 다른 --slug를 주세요.`);
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

function taskStatus(args) {
  const [id, status] = args;
  if (!id || !status) throw new UsageError('업무 id와 상태가 필요합니다.');
  if (!STATUSES.includes(status)) throw new UsageError(`상태는 ${STATUSES.join('|')} 중 하나여야 합니다: ${status}`);
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`업무를 찾을 수 없습니다: ${id} (task list로 확인하세요)`);
  const before = task.status;
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

function orgExport(args) {
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
