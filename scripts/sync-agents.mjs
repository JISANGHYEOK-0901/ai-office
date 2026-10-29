#!/usr/bin/env node
// 조직 정본 → 에이전트 파일 생성. 사용법: node scripts/sync-agents.mjs --write | --check
import { repoRoot } from '../lib/paths.mjs';
import { syncAgents } from '../lib/sync.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
if (!write && !args.includes('--check')) {
  console.error('사용법: node scripts/sync-agents.mjs --write | --check');
  process.exit(64);
}

let result;
try {
  result = syncAgents(repoRoot(), { write });
} catch (err) {
  console.error(`동기화 실패: ${err.message}`);
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
for (const d of result.diffs) {
  let line = `${LABEL[d.kind]}: ${d.path}`;
  if (d.kind === 'update' && d.line) line += ` (${d.line}행: ${JSON.stringify(d.before.slice(0, 80))} → ${JSON.stringify(d.after.slice(0, 80))})`;
  console.log(line);
}
for (const c of result.conflicts) {
  console.error(`충돌: ${c} — 생성 표식이 없는 기존 파일이라 덮어쓰지 않았습니다. 파일 이름을 바꾸거나 직원 id를 바꾸세요.`);
}

if (!result.diffs.length && !result.conflicts.length) console.log('에이전트 파일이 정본과 일치합니다.');
else if (write) console.log(`완료: 생성·갱신 ${result.changed.length}개, 삭제 ${result.removed.length}개`);
else if (result.diffs.length) console.log('정본과 다릅니다. npm run sync 로 반영하세요.');

process.exit(result.ok ? 0 : 1);
