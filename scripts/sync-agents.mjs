#!/usr/bin/env node
// 조직 정본 → 에이전트 파일 생성, 작업 공간 생성물(수칙·설정·스킬·스크립트 연결) 갱신.
// 사용법: node scripts/sync-agents.mjs --write | --check [--workspace <경로>]  (--write와 --check를 함께 주면 검사만 한다: npm run sync -- --check)
import { WorkspaceError, resolveWorkspace } from '../lib/paths.mjs';
import { syncAgents } from '../lib/sync.mjs';
import { isWorkspaceInitialized, syncWorkspace } from '../lib/workspace.mjs';

const USAGE = '사용법: node scripts/sync-agents.mjs --write | --check [--workspace <경로>]';
const args = process.argv.slice(2);
let write = false;
let check = false;
let workspace = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--write') write = true;
  else if (a === '--check') check = true;
  else if (a === '--workspace') workspace = args[++i];
  else if (a.startsWith('--workspace=')) workspace = a.slice('--workspace='.length);
  else {
    console.error(`알 수 없는 옵션입니다: ${a}\n${USAGE}`);
    process.exit(64);
  }
}
// npm run sync(= --write)에 -- --check를 붙이면 검사만 한다
if (check) write = false;
if ((!write && !check) || (workspace !== null && !workspace)) {
  console.error(USAGE);
  process.exit(64);
}

let root;
let result;
let ws = null;
try {
  ({ path: root } = resolveWorkspace({ workspace }));
  // 작업 공간 생성물: --write는 작업 공간을 초기화한다. --check는 초기화된 작업 공간만 본다(아직 없으면 서버 첫 실행이 만든다)
  if (write || isWorkspaceInitialized(root)) ws = syncWorkspace(root, { write });
  result = syncAgents(root, { write });
} catch (err) {
  console.error(err instanceof WorkspaceError ? `오류: ${err.message}` : `동기화 실패: ${err.message}`);
  process.exit(1);
}

if (result.errors.length) {
  console.error('조직 정본 검증 실패:');
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const LABEL = write
  ? { create: '생성', update: '갱신', remove: '삭제' }
  : { create: '생성 필요', update: '변경 필요', remove: '삭제 필요' };
const diffs = [...(ws?.diffs ?? []), ...result.diffs];
for (const d of diffs) {
  let line = `${LABEL[d.kind]}: ${d.path}`;
  if (d.kind === 'update' && d.line) line += ` (${d.line}행: ${JSON.stringify(d.before.slice(0, 80))} → ${JSON.stringify(d.after.slice(0, 80))})`;
  console.log(line);
}
for (const c of ws?.conflicts ?? []) {
  console.error(`보존: ${c} — 직접 만들거나 고친 파일(생성 표식 없음)이라 덮어쓰지 않았습니다. 프로그램 기본값을 쓰려면 파일을 옮기거나 지운 뒤 다시 실행하세요.`);
}
for (const c of result.conflicts) {
  console.error(`충돌: ${c} — 생성 표식이 없는 기존 파일이라 덮어쓰지 않았습니다. 파일 이름을 바꾸거나 직원 id를 바꾸세요.`);
}

const conflicts = (ws?.conflicts.length ?? 0) + result.conflicts.length;
const changed = (ws?.changed.length ?? 0) + result.changed.length;
console.log(`작업 공간: ${root}`);
if (!diffs.length && !conflicts) console.log('에이전트 파일·작업 공간 생성물이 정본과 일치합니다.');
else if (write) console.log(`완료: 생성·갱신 ${changed}개, 삭제 ${result.removed.length}개`);
else if (diffs.length) console.log('정본과 다릅니다. npm run sync 로 반영하세요.');

process.exit(result.ok && (ws ? ws.ok : true) ? 0 : 1);
