// 검토를 마친 전달 파일만 사용자 지정 상위 폴더/최종산출물/날짜/업무명으로 모은다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isTaskId } from './plan.mjs';
import { insideRel, walkOutputFiles } from './outputs.mjs';
import { programRoot } from './paths.mjs';
import { readPrivate, writePrivate } from './private-state.mjs';

const configFile = (root) => join(root, '.office', 'final-outputs', 'settings.json');
const indexFile = (root) => join(root, '.office', 'final-outputs', 'index.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const posix = (path) => path.split(sep).join('/');
const segment = (title) => {
  const safe = String(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '');
  let result = '';
  for (const char of safe) { if (Buffer.byteLength(result + char) > 120) break; result += char; }
  return result || '업무';
};

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), basename(path));
}

export function finalOutputSettings(root, parent = readPrivate(configFile(root)).parent || '') {
  if (typeof parent !== 'string' || parent.length > 2000 || parent.includes('\0')) throw new Error('최종 산출물 상위 폴더 경로가 올바르지 않습니다.');
  const expanded = parent.trim().replace(/^~(?=[/\\]|$)/, homedir());
  if (expanded && !isAbsolute(expanded)) throw new Error('최종 산출물 상위 폴더는 절대 경로로 입력해 주세요.');
  const chosen = resolve(expanded || root);
  if (existsSync(chosen) && !statSync(chosen).isDirectory()) throw new Error('최종 산출물 상위 경로는 폴더여야 합니다.');
  const base = join(chosen, '최종산출물');
  const realBase = canonical(base), realRoot = canonical(resolve(root)), program = canonical(programRoot());
  if ((realBase === program || insideRel(program, realBase)) && !(realRoot === program && chosen === resolve(root))) throw new Error('프로그램 폴더 밖의 저장 위치를 골라 주세요.');
  for (const protectedDir of [join(root, 'outputs'), join(root, '.office'), join(homedir(), '.config', 'ai-office', 'private')]) {
    const protectedReal = canonical(resolve(protectedDir));
    if (realBase === protectedReal || insideRel(protectedReal, realBase)) throw new Error('작업 중간 자료·인증 정보 폴더 밖의 저장 위치를 골라 주세요.');
  }
  return { parent: expanded ? chosen : '', directory: base };
}

export function saveFinalOutputSettings(root, parent) {
  const settings = finalOutputSettings(root, parent);
  writePrivate(configFile(root), { parent: settings.parent });
  return settings;
}

export function finalOutputs(root) {
  return readPrivate(indexFile(root), { items: {} }).items || {};
}

export function selectedDeliverables(plan = {}) {
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  if (Array.isArray(plan.deliverables)) {
    return plan.deliverables.map((ref) => {
      const stage = stages.find((s) => s.id === ref || s.output === ref);
      if (!stage) throw new Error('최종 전달 파일은 계획의 단계 산출물이어야 합니다.');
      return stage.output;
    });
  }
  const dependedOn = new Set(stages.flatMap((s) => s.dependsOn || []));
  return stages.filter((s) => !dependedOn.has(s.id)).map((s) => s.output);
}

export function collectFinalOutputs(root, { task, title = task, plan = {} }) {
  if (!isTaskId(task)) throw new Error('최종 산출물 업무 id가 올바르지 않습니다.');
  const taskDir = resolve(root, 'outputs', task), report = join(taskDir, 'report.md');
  if (!existsSync(report) || !readFileSync(report, 'utf8').trim()) throw new Error('비서실장 최종 보고서가 있어야 최종산출물로 전달할 수 있습니다.');
  const taskReal = realpathSync(taskDir);
  if (!insideRel(realpathSync(join(root, 'outputs')), taskReal) || !insideRel(taskReal, realpathSync(report))) throw new Error('업무 폴더 밖의 보고서는 전달할 수 없습니다.');
  const sources = new Map();
  let total = 0;
  const add = (path) => {
    if (!insideRel(taskDir, path) || !insideRel(taskReal, realpathSync(path)) || !statSync(path).isFile()) throw new Error('최종 전달 파일은 해당 업무 폴더 안의 파일이어야 합니다.');
    const rel = posix(relative(taskDir, path));
    if (sources.has(rel)) return;
    const size = statSync(path).size;
    if (sources.size >= 2000 || (total += size) > 100 * 1024 * 1024) throw new Error('최종 전달 묶음은 2,000파일·100MB 이하여야 합니다.');
    const bytes = readFileSync(path); sources.set(rel, bytes);
    // 독립 HTML 외에도 같은 업무 폴더의 이미지·CSS 등 로컬 참조 파일을 함께 전달한다.
    if (/\.(?:html?|css)$/i.test(path)) {
      const refs = [...bytes.toString('utf8').matchAll(/(?:src|href)\s*=\s*["']([^"'#]+)["']|url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)];
      for (const match of refs) {
        const ref = (match[1] || match[2]).split(/[?#]/)[0];
        if (!ref || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(ref)) continue;
        let asset; try { asset = resolve(dirname(path), decodeURIComponent(ref)); } catch { continue; }
        if (insideRel(taskDir, asset) && existsSync(asset) && statSync(asset).isFile()) add(asset);
      }
    }
  };
  for (const output of selectedDeliverables(plan)) {
    const source = isAbsolute(output) ? output : output.replace(/\\/g, '/').startsWith('outputs/') ? resolve(root, output) : resolve(taskDir, output);
    if (existsSync(source) && statSync(source).isDirectory()) {
      const files = walkOutputFiles(source, taskReal);
      if (!files.length) throw new Error('최종 전달 폴더가 비어 있습니다.');
      for (const file of files) add(join(source, file.rel));
    } else add(source);
  }
  const { directory: base } = finalOutputSettings(root);
  const [date, slug] = task.split('/');
  const directory = join(base, date, `${segment(title)}--${slug}`);
  const realBase = canonical(base);
  if (!insideRel(realBase, canonical(directory))) throw new Error('최종 산출물 폴더가 저장 위치 밖을 가리킵니다.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const index = readPrivate(indexFile(root), { items: {} });
  const previous = index.items?.[task];
  const records = [];
  const deliveredPaths = new Map();
  const copy = (rel, bytes) => {
    let dest = join(directory, rel);
    if (!insideRel(canonical(directory), canonical(dest))) throw new Error('최종 산출물의 링크가 폴더 밖을 가리킵니다.');
    // 사용자가 전달 폴더에서 수정한 파일은 덮어쓰지 않는다.
    const owned = previous?.directory === directory && previous.files?.find((f) => f.rel === rel);
    if (existsSync(dest) && digest(readFileSync(dest)) !== digest(bytes) && (!owned || digest(readFileSync(dest)) !== owned.sha256)) {
      const extension = /\.[^.]+$/.exec(rel)?.[0] || '';
      const stem = extension ? rel.slice(0, -extension.length) : rel;
      rel = `${stem}-${digest(bytes).slice(0, 10)}${extension}`; dest = join(directory, rel);
      if (!insideRel(canonical(directory), canonical(dest))) throw new Error('최종 산출물 경로를 확인해 주세요.');
      if (existsSync(dest) && digest(readFileSync(dest)) !== digest(bytes)) throw new Error('기존 전달 파일과 충돌합니다. 저장 폴더를 확인해 주세요.');
    }
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, bytes, { mode: 0o600 });
    records.push({ rel: posix(rel), sha256: digest(bytes), size: bytes.length });
  };
  for (const [rel, bytes] of sources) { copy(rel, bytes); deliveredPaths.set(rel, records.at(-1).rel); }
  const links = records.map((f) => `- [${f.rel}](${f.rel.split('/').map(encodeURIComponent).join('/')})`).join('\n');
  const reportText = readFileSync(report, 'utf8').replace(/(\[[^\]]+\]\()([^\s)]+)(\))/g, (original, before, href, after) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#')) return original;
    let decoded; try { decoded = decodeURIComponent(href.split('#')[0]); } catch { return original; }
    const source = isAbsolute(decoded) ? decoded : decoded.startsWith('outputs/') ? resolve(root, decoded) : resolve(taskDir, decoded);
    const dest = deliveredPaths.get(posix(relative(taskDir, source)));
    return dest ? before + dest.split('/').map(encodeURIComponent).join('/') + (href.includes('#') ? '#' + href.split('#').slice(1).join('#') : '') + after : original;
  });
  copy('비서실장-보고.md', Buffer.from(reportText + '\n\n## 최종 전달 파일\n\n' + (links || '별도 첨부 파일 없음') + '\n'));
  const result = { task, title, base, directory, files: records, updated: new Date().toISOString() };
  index.items ||= {}; index.items[task] = result; writePrivate(indexFile(root), index);
  return result;
}

export function resolveFinalOutput(root, task, rel = null) {
  if (!isTaskId(task)) throw new Error('업무 id가 올바르지 않습니다.');
  const record = finalOutputs(root)[task];
  if (!record || basename(record.base) !== '최종산출물') throw new Error('최종산출물이 아직 없습니다.');
  const base = realpathSync(record.base), directory = realpathSync(record.directory);
  if (!insideRel(base, directory)) throw new Error('최종산출물 경로를 확인해 주세요.');
  if (rel === null) return { real: directory, record };
  if (!record.files.some((f) => f.rel === rel)) throw new Error('등록되지 않은 최종 전달 파일입니다.');
  const path = resolve(directory, rel), real = realpathSync(path);
  if (!insideRel(directory, path) || !insideRel(directory, real) || !statSync(real).isFile()) throw new Error('최종 전달 파일 경로를 확인해 주세요.');
  const stat = statSync(real);
  return { real, rel, size: stat.size, mtime: stat.mtime.toISOString(), record };
}
