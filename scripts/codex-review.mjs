#!/usr/bin/env node
// Codex 검증 실행기: 검토자마다 `codex exec --json` 을 읽기 전용으로 띄우고
// JSON 스트림을 이벤트로 바꾸며, 마지막 답변을 <target>/reviews/<reviewer>.md 에 저장한다.
//
// 사용: node scripts/codex-review.mjs --target outputs/<날짜>/<slug> [--reviewers a,b|all] [--task <id>]
//        --reviewers 에는 직원 id(verify-1) 또는 직무 key(fact-checker)를 쓴다
//        [--model <slug>] [--effort low|medium|high|xhigh|max|ultra] [--dry-run]
// 모델 우선순위: OFFICE_CODEX_MODEL/OFFICE_CODEX_EFFORT 환경변수 > --model/--effort > 검증실 부서 codexModel/codexEffort > gpt-6.1-sol / max
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendEvent, normalizeCodexItem, redact } from '../lib/events.mjs';
import { loadOrg, loadPresets } from '../lib/org.mjs';
import { repoRoot } from '../lib/paths.mjs';
import { CODEX_EFFORTS, CODEX_MODEL_PATTERN, codexModelArgs, resolveCommand, spawnCli, writePrompt } from '../lib/cli.mjs';

const CONCURRENCY = 3;

export const REVIEW_RULES = `- 읽기 전용으로 검토한다. 파일을 만들거나 고치지 않는다.
- 대상 폴더의 산출물(brief.md, report.md 등)을 직접 열어 사실·숫자·출처·논리·문서 형식·코드 동작을 확인한다.
- 지적마다 근거 위치를 \`파일:줄\` 형식으로 적는다.
- 확인하지 못한 내용은 추정하지 말고 "미확인"으로 적는다.
- 사소한 표현 취향보다 결과를 바꾸는 오류를 먼저 적는다.`;

function parseArgs(argv) {
  const opts = { target: null, reviewers: 'all', task: null, dryRun: false, model: null, effort: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 값이 필요합니다.`);
      return v;
    };
    if (a === '--target') opts.target = value();
    else if (a === '--reviewers') opts.reviewers = value();
    else if (a === '--task') opts.task = value();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--model') opts.model = value();
    else if (a === '--effort') opts.effort = value();
    else throw new Error(`알 수 없는 인자입니다: ${a}`);
  }
  if (!opts.target) throw new Error('--target 으로 검토할 산출물 폴더를 지정해 주세요.');
  if (opts.model && !CODEX_MODEL_PATTERN.test(opts.model)) throw new Error(`--model 값이 올바르지 않습니다: ${opts.model}`);
  if (opts.effort && !CODEX_EFFORTS.includes(opts.effort)) throw new Error(`--effort 는 ${CODEX_EFFORTS.join('|')} 중 하나여야 합니다.`);
  return opts;
}

const isVerifyDept = (d) => d && (d.id === 'verify' || d.engine === 'codex');

// 정본의 검증실 직원을 쓰고, 정본에 없으면 프리셋의 검증실 직무를 대신 쓴다
export function loadReviewers(root) {
  const { departments, roster } = loadOrg(root);
  const depts = new Map(departments.filter((d) => isVerifyDept(d) && d.active !== false).map((d) => [d.id, d]));
  const fromRoster = roster
    .filter((a) => depts.has(a.department) && a.active !== false)
    .map((a) => {
      const d = depts.get(a.department);
      return { id: a.id, role: a.role || null, name: a.name || a.id, specialty: a.specialty || '', instructions: a.instructions || '', codexModel: d.codexModel, codexEffort: d.codexEffort };
    });
  if (fromRoster.length) return { source: 'roster', reviewers: fromRoster };

  const preset = loadPresets(root).departments.find(isVerifyDept);
  const fromPresets = (preset?.roles || [])
    .filter((r) => r && typeof r.key === 'string')
    .map((r) => ({ id: r.key, role: r.key, name: r.name || r.key, specialty: r.specialty || '', instructions: r.instructions || '', codexModel: preset.codexModel, codexEffort: preset.codexEffort }));
  return { source: 'presets', reviewers: fromPresets };
}

// 검토 프롬프트. targetRel(레포 기준 산출물 경로)이나 request(대시보드에서 직접 지시한 요청) 중 하나 이상을 준다
export function buildPrompt(reviewer, targetRel, request = '') {
  return [
    `너는 AI Office 검증실의 ${reviewer.name}(${reviewer.id})이다.${reviewer.specialty ? ` 담당: ${reviewer.specialty}` : ''}`,
    '',
    '## 역할 지침',
    reviewer.instructions || '맡은 관점에서 산출물의 오류를 찾는다.',
    '',
    '## 공통 검토 기준',
    REVIEW_RULES,
    ...(targetRel ? ['', '## 검토 대상', `레포 기준 경로: ${targetRel}`] : []),
    ...(request ? ['', '## 요청', request] : []),
    '',
    '## 출력 형식',
    '첫 줄에 판정을 정확히 한 줄로 쓴다: `VERDICT: PASS` 또는 `VERDICT: FIX` 또는 `VERDICT: BLOCK`',
    '- PASS: 그대로 써도 된다 / FIX: 고쳐야 할 오류가 있다 / BLOCK: 중대한 오류로 쓰면 안 된다',
    '둘째 줄부터 Markdown 지적 목록을 쓴다. 형식: `- [심각도] 파일:위치 — 지적 내용과 근거`',
    '지적이 없으면 확인한 범위를 짧게 적는다.',
  ].join('\n');
}

// --reviewers 값(직원 id 또는 직무 key) → 검토자 목록. 직무 key는 같은 직무의 직원을 모두 고른다
export function pickReviewers(available, spec) {
  if (spec === 'all') return { reviewers: available, unknown: [] };
  const wanted = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  const matches = (r, key) => r.id === key || r.role === key;
  const unknown = wanted.filter((key) => !available.some((r) => matches(r, key)));
  if (!wanted.length) unknown.push('(비어 있음)');
  return { reviewers: available.filter((r) => wanted.some((key) => matches(r, key))), unknown };
}

// 검토 대상은 outputs/ 아래 폴더만 허용한다. 심볼릭 링크는 실제 위치로 판정한다
export function resolveTarget(root, target) {
  const abs = isAbsolute(target) ? target : resolve(root, target);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`검토 대상 폴더가 없습니다: ${target}`);
  const outputs = resolve(root, 'outputs');
  const rel = existsSync(outputs) ? relative(realpathSync(outputs), realpathSync(abs)) : '..';
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`검토 대상은 outputs/ 아래 폴더여야 합니다: ${target}`);
  return abs;
}

// 첫 몇 줄에서 VERDICT 를 찾는다. 없으면 FIX 로 본다
export function parseVerdict(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5);
  for (const line of lines) {
    const m = line.replace(/[*`#>_]/g, '').match(/^VERDICT\s*[:：]\s*(PASS|FIX|BLOCK)\b/i);
    if (m) return m[1].toUpperCase();
  }
  return 'FIX';
}

function runReviewer({ root, cmd, modelArgs, reviewer, targetAbs, targetRel, task }) {
  const session = `codex-review-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const base = { engine: 'codex', session, agent: reviewer.id, instance: session };
  if (task) base.task = task;
  const emit = (ev) => { try { appendEvent(root, ev); } catch { /* 이벤트 기록 실패는 검증을 막지 않는다 */ } };
  emit({ ...base, kind: 'review.start', summary: redact(`검토 시작: ${targetRel}`) });

  return new Promise((done) => {
    let lastMessage = null;
    let stderr = '';
    let buffer = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const ev = { ...base, kind: 'review.end', verdict: result.verdict, summary: redact(result.reason || result.verdict) };
      emit(ev);
      done({ reviewer: reviewer.id, ...result });
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.type === 'item.completed' && msg.item?.type === 'agent_message' && typeof msg.item.text === 'string') {
        lastMessage = msg.item.text;
      }
      const ev = normalizeCodexItem(msg, { agent: reviewer.id, task: task || undefined, session });
      if (ev) emit(ev);
    };

    let child;
    try {
      // 프롬프트는 stdin(`-`)으로 넘긴다. 명령 인자에는 고정 옵션과 검증된 값만 들어간다
      child = spawnCli(cmd, ['exec', '--json', '-s', 'read-only', '-C', root, ...modelArgs, '-'], { cwd: root });
      writePrompt(child, buildPrompt(reviewer, targetRel));
    } catch (err) {
      finish({ verdict: 'ERROR', reason: `codex 실행 실패: ${err.message}` });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (err) => {
      const reason = err.code === 'ENOENT'
        ? `codex 실행 파일을 찾지 못했습니다(${cmd.display}). PATH 또는 CODEX_BIN 을 확인해 주세요.`
        : `codex 실행 실패: ${err.message}`;
      finish({ verdict: 'ERROR', reason });
    });
    child.on('close', (code, signal) => {
      if (buffer) handleLine(buffer);
      if (lastMessage === null) {
        const why = signal ? `신호 ${signal}` : `종료 코드 ${code}`;
        finish({ verdict: 'ERROR', reason: `codex 가 답변 없이 끝났습니다(${why}). ${redact(stderr, 300)}`.trim() });
        return;
      }
      const verdict = parseVerdict(lastMessage);
      const file = join(targetAbs, 'reviews', `${reviewer.id}.md`);
      try {
        mkdirSync(join(targetAbs, 'reviews'), { recursive: true });
        // reviews 가 대상 밖을 가리키는 링크면 쓰지 않는다
        const rel = relative(realpathSync(targetAbs), realpathSync(join(targetAbs, 'reviews')));
        if (rel !== 'reviews') throw new Error('reviews 폴더가 검토 대상 밖을 가리킵니다.');
        writeFileSync(file, lastMessage.endsWith('\n') ? lastMessage : lastMessage + '\n');
      } catch (err) {
        finish({ verdict: 'ERROR', reason: `리뷰 파일을 저장하지 못했습니다: ${err.message}` });
        return;
      }
      const note = code === 0 ? '' : ` (codex 종료 코드 ${code})`;
      finish({ verdict, reason: `${verdict}: ${relative(root, file)}${note}`, file });
    });
  });
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(lanes);
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`오류: ${err.message}`);
    return 1;
  }
  const root = repoRoot();
  let targetAbs;
  try {
    targetAbs = resolveTarget(root, opts.target);
  } catch (err) {
    console.error(`오류: ${err.message}`);
    return 1;
  }
  const targetRel = relative(root, targetAbs) || '.';

  let loaded;
  try {
    loaded = loadReviewers(root);
  } catch (err) {
    console.error(`오류: 검토자 정보를 읽지 못했습니다: ${err.message}`);
    return 1;
  }
  const available = loaded.reviewers;
  if (!available.length) {
    console.error('오류: 검증실 직원이 없습니다. 검증실(verify) 부서와 직원을 먼저 만들어 주세요.');
    return 1;
  }
  const { reviewers, unknown } = pickReviewers(available, opts.reviewers);
  if (unknown.length) {
    const names = available.map((r) => (r.role && r.role !== r.id ? `${r.id}(${r.role})` : r.id));
    console.error(`오류: 알 수 없는 검토자입니다: ${unknown.join(', ')}. 사용 가능(id 또는 직무 key): ${names.join(', ')}`);
    return 1;
  }

  // 검토자별 codex 모델 인자(잘못된 값은 실행 전에 막는다)
  const argsFor = new Map();
  try {
    for (const r of reviewers) {
      argsFor.set(r.id, codexModelArgs({ model: opts.model || r.codexModel, effort: opts.effort || r.codexEffort }));
    }
  } catch (err) {
    console.error(`오류: ${err.message}`);
    return 1;
  }

  if (opts.dryRun) {
    for (const r of reviewers) {
      console.log(`===== ${r.id} (${loaded.source}) =====`);
      console.log(`# codex exec --json -s read-only -C <repo> ${argsFor.get(r.id).join(' ')} -`);
      console.log(buildPrompt(r, targetRel));
      console.log('');
    }
    return 0;
  }

  const cmd = resolveCommand('codex', 'CODEX_BIN');
  const results = await runPool(reviewers, CONCURRENCY, (reviewer) =>
    runReviewer({ root, cmd, modelArgs: argsFor.get(reviewer.id), reviewer, targetAbs, targetRel, task: opts.task }));

  console.log(`Codex 검증 결과 (${targetRel})`);
  for (const r of results) console.log(`- ${r.reviewer}: ${r.verdict} — ${r.reason}`);
  const count = (v) => results.filter((r) => r.verdict === v).length;
  console.log(`종합: PASS ${count('PASS')} · FIX ${count('FIX')} · BLOCK ${count('BLOCK')} · ERROR ${count('ERROR')}`);
  if (count('BLOCK')) return 2;
  if (count('ERROR')) return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
