// 예전 데이터 이전: 프로그램 레포 안의 회사 데이터(org 정본·outputs·.office·에이전트 파일)를 작업 공간으로 옮긴다.
// 방식: 복사 → 검증(파일 수·크기) → 원본은 레포의 .office-migrated-<날짜>/로 옮긴다. 아무것도 자동 삭제하지 않는다.
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkWorkspacePath, kstDate, legacyItems, programRoot } from './paths.mjs';

export class MigrateError extends Error {}

// 항목(파일 또는 폴더) 아래의 모든 항목. 반환: [{rel, type:'file'|'dir'|'link', size}]. 심볼릭 링크는 따라가지 않는다
function walk(base, rel, out = []) {
  const abs = join(base, ...rel.split('/'));
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return out;
  }
  if (st.isSymbolicLink()) out.push({ rel, type: 'link', size: 0 });
  else if (st.isDirectory()) {
    out.push({ rel, type: 'dir', size: 0 });
    for (const name of readdirSync(abs).sort()) walk(base, `${rel}/${name}`, out);
  } else if (st.isFile()) out.push({ rel, type: 'file', size: st.size });
  return out;
}

const summarize = (entries) => ({
  files: entries.filter((e) => e.type !== 'dir').length,
  bytes: entries.reduce((n, e) => n + e.size, 0),
});

/**
 * 이전 계획. 반환: { items:[{rel, files, bytes}], conflicts:[상대경로], files, bytes }
 * conflicts: 작업 공간에 이미 같은 이름의 파일이 있어 덮어쓰게 되는 항목(있으면 이전하지 않는다)
 */
export function planMigration({ program = programRoot(), workspace } = {}) {
  const items = [];
  const conflicts = [];
  for (const rel of legacyItems(program)) {
    const entries = walk(program, rel);
    items.push({ rel, ...summarize(entries) });
    for (const e of entries) {
      const dest = join(workspace, ...e.rel.split('/'));
      if (!existsSync(dest) && !isLink(dest)) continue;
      // 폴더끼리는 합친다. 파일·링크가 겹치거나 종류가 다르면 충돌
      if (e.type === 'dir' && lstatSync(dest).isDirectory()) continue;
      conflicts.push(e.rel);
    }
  }
  return { items, conflicts, files: items.reduce((n, i) => n + i.files, 0), bytes: items.reduce((n, i) => n + i.bytes, 0) };
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Windows의 일시적 잠금(EPERM/EBUSY/EACCES)은 잠깐 기다렸다가 다시 시도한다. 실패해도 원본을 지우지 않는다
function renameKeep(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

function uniqueDir(base) {
  if (!existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * 이전 실행. 확인은 호출한 쪽(CLI)이 받는다.
 * 반환: { moved: boolean, items, files, bytes, backup: 원본 보관 폴더(절대경로) }
 * 실패하면 MigrateError. 검증 실패면 이번에 복사한 파일만 되돌리고 원본은 그대로 둔다.
 */
export function migrateLegacy({ program = programRoot(), workspace, date = kstDate() } = {}) {
  if (!workspace) throw new MigrateError('작업 공간 경로가 필요합니다.');
  checkWorkspacePath(workspace, program);
  const plan = planMigration({ program, workspace });
  if (!plan.items.length) return { moved: false, items: [], files: 0, bytes: 0, backup: null };
  if (plan.conflicts.length) {
    const list = plan.conflicts.slice(0, 10).join(', ');
    throw new MigrateError(`작업 공간에 같은 이름의 파일이 있어 이전하지 않았습니다: ${list}${plan.conflicts.length > 10 ? ` 외 ${plan.conflicts.length - 10}개` : ''}. 작업 공간 파일을 옮기거나 다른 작업 공간(--workspace)을 지정하세요.`);
  }

  // 1) 복사(덮어쓰지 않음). 만든 파일·폴더를 기록해 검증 실패 때 되돌린다
  mkdirSync(workspace, { recursive: true });
  const created = [];
  const rollback = () => {
    for (const { path: p, dir } of created.reverse()) {
      try {
        if (dir) rmdirSync(p); // 비어 있을 때만 지워진다
        else rmSync(p, { force: true });
      } catch { /* 지우지 못한 것은 남긴다 */ }
    }
  };
  try {
    for (const item of plan.items) {
      for (const e of walk(program, item.rel)) {
        const src = join(program, ...e.rel.split('/'));
        const dest = join(workspace, ...e.rel.split('/'));
        if (e.type === 'dir') {
          if (!existsSync(dest)) {
            mkdirSync(dest, { recursive: true });
            created.push({ path: dest, dir: true });
          }
          continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        if (e.type === 'link') symlinkSync(readlinkSync(src), dest);
        else {
          copyFileSync(src, dest, constants.COPYFILE_EXCL);
          const st = lstatSync(src);
          try { utimesSync(dest, st.atime, st.mtime); } catch { /* 시각 보존 실패는 무시 */ }
        }
        created.push({ path: dest, dir: false });
      }
    }
  } catch (err) {
    rollback();
    throw new MigrateError(`복사하지 못해 이전을 취소했습니다(원본은 그대로입니다): ${err.message}`);
  }

  // 2) 검증: 항목별 파일 수·전체 크기, 파일마다 크기
  for (const item of plan.items) {
    const a = walk(program, item.rel);
    const b = new Map(walk(workspace, item.rel).map((e) => [e.rel, e]));
    const missing = a.filter((e) => e.type !== 'dir' && (!b.has(e.rel) || b.get(e.rel).type !== e.type || b.get(e.rel).size !== e.size));
    const sa = summarize(a);
    if (missing.length || sa.files !== item.files || sa.bytes !== item.bytes) {
      rollback();
      throw new MigrateError(`복사본 검증에 실패해 이전을 취소했습니다(원본은 그대로입니다): ${item.rel}${missing.length ? ` — 다른 파일: ${missing.slice(0, 5).map((e) => e.rel).join(', ')}` : ' — 복사 중 원본이 바뀌었습니다. 서버를 끄고 다시 실행하세요'}`);
    }
  }

  // 3) 원본 보관: 레포의 .office-migrated-<날짜>/로 옮긴다(삭제하지 않는다)
  const backup = uniqueDir(join(program, `.office-migrated-${date}`));
  const moved = [];
  try {
    for (const item of plan.items) {
      const to = join(backup, ...item.rel.split('/'));
      mkdirSync(dirname(to), { recursive: true });
      renameKeep(join(program, ...item.rel.split('/')), to);
      moved.push(item.rel);
    }
  } catch (err) {
    const left = plan.items.map((i) => i.rel).filter((r) => !moved.includes(r));
    throw new MigrateError(`복사·검증은 끝났지만 원본 일부를 보관 폴더로 옮기지 못했습니다(${err.message}). 옮긴 항목: ${moved.join(', ') || '없음'} / 남은 항목: ${left.join(', ')}. 남은 항목을 ${backup}로 직접 옮기세요. 작업 공간의 복사본은 그대로 둡니다.`);
  }
  return { moved: true, items: plan.items, files: plan.files, bytes: plan.bytes, backup };
}
