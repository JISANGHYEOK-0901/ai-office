#!/usr/bin/env node
// 예전 데이터 이전: 프로그램 폴더 안의 회사 데이터를 작업 공간으로 옮긴다.
// 사용법: node scripts/migrate.mjs [--workspace <경로>] [--yes] [--dry-run] [--force]
//   복사 → 검증(파일 수·크기) → 작업 공간 기억(.office-local.json) → 원본은 프로그램 폴더의 .office-migrated-<날짜>/로 보관(자동 삭제 없음).
//   확인(대화형 터미널의 y 또는 --yes) 없이는 아무것도 바꾸지 않는다. 대시보드 서버가 실행 중이면(.office/server.lock) 거부한다(--force로 무시).
//   중간에 끊겼으면 같은 명령을 다시 실행해 이어서 옮긴다(이미 복사된 같은 파일은 건너뛴다).
import { createInterface } from 'node:readline/promises';
import { LEGACY_ITEMS, LOCAL_CONFIG, WORKSPACE_SOURCE_LABEL, WorkspaceError, programRoot, resolveWorkspace } from '../lib/paths.mjs';
import { MigrateError, migrateLegacy, planMigration, runningServerNote } from '../lib/migrate.mjs';
import { ensureWorkspace } from '../lib/workspace.mjs';

const USAGE = '사용법: node scripts/migrate.mjs [--workspace <경로>] [--yes] [--dry-run] [--force]';

function parseArgs(argv) {
  const opts = { workspace: null, yes: false, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--workspace') opts.workspace = argv[++i];
    else if (a.startsWith('--workspace=')) opts.workspace = a.slice('--workspace='.length);
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`알 수 없는 옵션입니다: ${a}`);
  }
  if (opts.workspace !== null && !opts.workspace) throw new Error('--workspace 값이 비어 있습니다.');
  return opts;
}

const size = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes|예|네)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`오류: ${err.message}\n${USAGE}`);
    return 64;
  }
  const program = programRoot();
  let ws;
  try {
    // 이전 대상 위치를 정한다. 호환 모드(레포를 그대로 쓰는 것)는 고르지 않는다
    ws = resolveWorkspace({ workspace: opts.workspace, allowCompat: false });
  } catch (err) {
    console.error(err instanceof WorkspaceError ? `오류: ${err.message}` : `오류: 작업 공간을 정하지 못했습니다: ${err.message}`);
    return 1;
  }
  const plan = planMigration({ program, workspace: ws.path });
  console.log(`프로그램 폴더: ${program}`);
  console.log(`작업 공간:     ${ws.path} (${WORKSPACE_SOURCE_LABEL[ws.source]})`);
  if (!plan.items.length) {
    console.log(`옮길 예전 데이터가 없습니다(대상: ${LEGACY_ITEMS.map((i) => i.rel).join(', ')}).`);
    return 0;
  }
  console.log('옮길 항목:');
  for (const item of plan.items) console.log(`  - ${item.rel}: 파일 ${item.files}개, ${size(item.bytes)}`);
  console.log(`합계: 파일 ${plan.files}개, ${size(plan.bytes)}`);
  if (plan.copied.length) console.log(`이어서 진행: 작업 공간에 같은 복사본이 이미 있는 파일 ${plan.copied.length}개는 건너뜁니다(이전이 중간에 끊긴 흔적).`);
  if (plan.conflicts.length) {
    console.error(`작업 공간에 같은 이름의 파일이 있어 이전할 수 없습니다(${plan.conflicts.length}개): ${plan.conflicts.slice(0, 10).join(', ')}`);
    console.error('작업 공간의 해당 파일을 옮기거나 --workspace로 비어 있는 다른 경로를 지정하세요.');
    return 1;
  }
  console.log('방식: 복사 → 검증(파일 수·크기) → 작업 공간 경로 기억 → 원본은 프로그램 폴더의 .office-migrated-<날짜>/로 보관합니다. 자동으로 지우지 않습니다.');
  const busy = runningServerNote({ program, workspace: ws.path });
  if (opts.dryRun) {
    if (busy) console.log(`주의: ${busy} 실제로 옮기기 전에 서버를 끄세요.`);
    console.log('--dry-run: 아무것도 바꾸지 않았습니다.');
    return 0;
  }
  if (busy && !opts.force) {
    console.error(`오류: ${busy} 서버가 켜진 채로 옮기면 옮겨진 자리에 데이터를 다시 만들어 회사 데이터가 나뉩니다.`);
    console.error('서버(npm run office)를 끈 뒤 다시 실행하세요. 서버가 이미 꺼졌는데 이 안내가 나오면 --force를 붙이세요.');
    return 1;
  }
  if (!opts.yes && !(await confirm('작업 공간으로 옮길까요? (y/N) '))) {
    console.error('옮기지 않았습니다. 지금은 예전 위치를 계속 쓰는 호환 모드로 동작합니다. 확인 없이 진행하려면 --yes를 붙이세요.');
    return 1;
  }
  // 옮기는 동안 Ctrl+C·창 닫기는 끝난 뒤로 미룬다. 이전·생성물 갱신은 동기 작업이라 신호 처리기는 모두 끝난 뒤에야 불린다.
  // 강제 종료(kill -9·전원)로 끊겼으면 같은 명령을 다시 실행해 이어서 한다
  let notified = false;
  const onSignal = () => {
    if (notified) return;
    notified = true;
    console.error('중단 요청을 받았지만 회사 데이터가 나뉘지 않도록 이전을 끝까지 마쳤습니다.');
  };
  for (const sig of process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);
  console.log('옮기는 중입니다. 끝날 때까지 창을 닫지 마세요.');
  let result;
  try {
    result = migrateLegacy({ program, workspace: ws.path, force: opts.force });
  } catch (err) {
    if (!(err instanceof MigrateError || err instanceof WorkspaceError)) throw err;
    console.error(`오류: ${err.message}`);
    return 1;
  }
  // 옮긴 정본으로 작업 공간 생성물·에이전트 파일을 다시 만든다(훅 절대경로·수칙 갱신)
  const init = ensureWorkspace(ws.path, { program });
  console.log(`이전 완료: 파일 ${result.files}개, ${size(result.bytes)} → ${ws.path}${result.resumed ? ` (이미 복사돼 있던 ${result.resumed}개 포함)` : ''}`);
  console.log(`작업 공간 경로를 프로그램 폴더의 ${LOCAL_CONFIG}에 기억했습니다.`);
  console.log(`원본 보관: ${result.backup} (확인한 뒤 직접 지우세요. Git에서는 제외됩니다)`);
  for (const rel of init.workspace.conflicts) console.error(`주의: ${rel} — 직접 만든 파일이라 덮어쓰지 않았습니다.`);
  if (init.error) console.error(`주의: 에이전트 파일을 다시 만들지 못했습니다: ${init.error.message} (npm run sync로 다시 시도하세요)`);
  else if (init.agents && !init.agents.ok) for (const c of init.agents.conflicts ?? []) console.error(`주의: ${c} — 생성 표식 없는 파일이라 덮어쓰지 않았습니다.`);
  console.log('이제 npm run office로 대시보드를 띄우면 작업 공간을 씁니다.');
  return 0;
}

process.exitCode = await main();
