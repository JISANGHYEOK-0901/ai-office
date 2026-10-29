// 업무 산출물 폴더(outputs/<업무>/) 읽기 전용 도우미. 대시보드 서버와 office.mjs(task files)가 함께 쓴다.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const MAX_OUTPUT_FILES = 2000;
export const MAX_OUTPUT_DEPTH = 6;

// target이 base 안이면 base 기준 상대경로, 아니면 null
export function insideRel(base, target) {
  const rel = relative(base, target);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
}

/**
 * 업무 폴더 아래 파일 목록(이름순). 숨김 파일은 빼고, 심볼릭 링크는 실제 경로가 baseReal(outputs의 실제 경로) 안일 때만 따라간다.
 * @returns {{rel:string, name:string, size:number, mtime:string}[]} rel은 dir 기준 '/' 구분 경로
 */
export function walkOutputFiles(dir, baseReal, { maxDepth = MAX_OUTPUT_DEPTH, maxFiles = MAX_OUTPUT_FILES } = {}) {
  const out = [];
  const walk = (current, relDir, depth) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxFiles) return;
      if (ent.name.startsWith('.')) continue;
      const full = join(current, ent.name);
      let real = full;
      let st;
      try {
        if (ent.isSymbolicLink()) {
          real = realpathSync(full);
          if (!insideRel(baseReal, real)) continue;
        }
        st = statSync(real);
      } catch {
        continue;
      }
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (st.isDirectory()) {
        if (depth < maxDepth) walk(real, rel, depth + 1);
      } else if (st.isFile()) {
        out.push({ rel, name: ent.name, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  };
  walk(dir, '', 0);
  return out;
}

/**
 * 업무 폴더의 실제 경로. 글자 경로와 실제 경로 모두 outputs 안이어야 한다. 폴더가 없거나 밖이면 null.
 * @returns {{real:string, baseReal:string}|null}
 */
export function resolveTaskDir(root, taskId) {
  const base = resolve(root, 'outputs');
  const abs = resolve(base, ...String(taskId).split('/'));
  if (!insideRel(base, abs)) return null;
  try {
    const baseReal = realpathSync(base);
    const real = realpathSync(abs);
    if (!insideRel(baseReal, real) || !statSync(real).isDirectory()) return null;
    return { real, baseReal };
  } catch {
    return null;
  }
}

/**
 * 계획표 단계 산출물(stage.output, 레포 기준 'outputs/…' 경로) 존재 여부. 업무 폴더 밖을 가리키는 경로는 확인하지 않는다(값 없음).
 * @param {{stages?:{id:string, output?:string}[]}} plan compactPlan 요약
 * @returns {Object<string, boolean>} 단계 id → 파일이 있는지
 */
export function planOutputStatus(root, taskId, plan) {
  const out = {};
  const taskDir = resolve(root, 'outputs', ...String(taskId).split('/'));
  for (const st of Array.isArray(plan?.stages) ? plan.stages : []) {
    if (!st || typeof st.id !== 'string' || typeof st.output !== 'string' || !st.output.trim() || st.output.includes('\0')) continue;
    const abs = resolve(root, ...st.output.split(/[\\/]/));
    if (!insideRel(taskDir, abs)) continue;
    let exists = false;
    try {
      const real = realpathSync(abs);
      exists = Boolean(insideRel(realpathSync(taskDir), real)) && statSync(real).isFile();
    } catch {
      exists = false;
    }
    out[st.id] = exists;
  }
  return out;
}
