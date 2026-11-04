// 메일 첨부: 대표가 지시문에 적은 파일을 서버 코드가 찾는다. AI는 계획에 대표가 쓴 파일 이름·경로만 적고 파일을 고르지 않는다.
// - 대표 원문(최초 지시·답장)에 그 이름이 실제로 있어야 한다(evidenceIn과 같은 방식)
// - 이름만 주면 작업 공간(보관함 포함)·다운로드·문서·데스크톱에서만 찾는다. 경로를 주면 그 파일을 쓴다
// - 못 찾거나 같은 이름이 여러 개면 추측하지 않고 대표에게 묻는다
// - 계정 파일·비밀 폴더·숨김 파일·키 파일·심볼릭 링크로 범위를 벗어난 파일은 첨부하지 않는다
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { evidenceIn, secretLocations } from './guardrails.mjs';

export const MAX_MAIL_ATTACHMENTS = 10;
// 네이버웍스 첨부 한도는 회사 관리자가 정해 고정값이 없다. 일반 웹사이트 첨부와 같은 공통 안전 상한만 둔다
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const SEARCH_LIMIT = { depth: 6, entries: 20000 };
const SKIP_DIRS = new Set(['node_modules', '__pycache__']);
// 비밀값이 들 수 있는 파일: 숨김 파일, .env, 인증서·키, SSH 키
const SECRET_FILE = /^\.|^계정\.env$|\.env(?:\.|$)|\.(?:pem|key|p12|pfx|ppk|kdbx|keychain(?:-db)?|gpg|asc)$|^id_(?:rsa|dsa|ecdsa|ed25519)/i;

const nfc = (s) => String(s ?? '').normalize('NFC');
// 계획의 첨부 이름과 확정 기록을 같은 키로 맞춘다
export const attachmentRef = (raw) => nfc(raw).trim();
const expandHome = (p, home) => p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
const looksLikePath = (ref) => isAbsolute(ref) || ref.startsWith('~/') || /[\\/]/.test(ref);
export const searchRoots = (root, home = homedir()) => [root, ...['Downloads', 'Documents', 'Desktop'].map((d) => join(home, d))];
export const displayPath = (path, home = homedir()) => {
  const rel = relative(home, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel}` : path;
};

// 첨부할 수 없는 파일이면 이유를, 첨부할 수 있으면 null을 돌려준다
export function blockedReason(path, { root, home = homedir() }) {
  let real;
  try { real = realpathSync(path); } catch { return '파일이 없습니다'; }
  const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  if (secretLocations(root, home).map(realOr).some((s) => real === s || real.startsWith(s + sep))) return '계정 파일·비밀 폴더는 첨부할 수 없습니다';
  // 숨김 폴더(.ssh·.config 등)·숨김 파일은 첨부하지 않는다. 홈 아래 파일은 홈 기준으로 본다
  const homeReal = realOr(home), rel = real.startsWith(homeReal + sep) ? real.slice(homeReal.length + 1) : real;
  if (rel.split(sep).some((part) => part.startsWith('.') && part !== '.' && part !== '..')) return '숨김 폴더·숨김 파일은 첨부할 수 없습니다';
  if (SECRET_FILE.test(nfc(basename(real)))) return '계정·키 파일은 첨부할 수 없습니다';
  let st;
  try { st = statSync(real); } catch { return '파일을 읽을 수 없습니다'; }
  if (!st.isFile()) return '파일이 아닙니다';
  if (st.size > MAX_ATTACHMENT_BYTES) return `파일이 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB보다 큽니다`;
  return null;
}

// 이름이 같은지: 확장자까지 적었으면 전체 이름, 확장자 없이 적었으면 확장자를 뺀 이름으로 비교한다(macOS의 한글 자모 분리 이름도 맞춘다)
function sameName(fileName, ref) {
  const name = nfc(fileName).toLowerCase(), want = nfc(ref).toLowerCase();
  return extname(want) ? name === want : name === want || name.slice(0, name.length - extname(name).length) === want;
}

// 대표가 지시문·답장에 적은 경로 중 실제로 있는 파일(공백이 든 경로도 찾는다)
function pathsInText(text, ref, home) {
  const target = nfc(ref), found = new Set();
  for (const line of nfc(text).split('\n')) {
    for (let at = line.indexOf(target); at >= 0; at = line.indexOf(target, at + 1)) {
      let end = at + target.length;
      if (!extname(target)) end += line.slice(end).match(/^\.[A-Za-z0-9]{1,8}/)?.[0].length || 0;
      for (let start = 0; start <= at; start++) {
        if (!(line[start] === '/' || line.startsWith('~/', start)) || start > 0 && !/[\s"'“‘(<:：,]/.test(line[start - 1])) continue;
        const path = expandHome(line.slice(start, end), home);
        try { if (statSync(path).isFile() && sameName(basename(path), basename(target))) found.add(realpathSync(path)); } catch { /* 없는 경로 */ }
      }
    }
  }
  return [...found];
}

// 허용 범위에서 이름이 같은 파일을 찾는다. 숨김·심볼릭 링크·비밀 위치는 들어가지 않는다
function searchFiles(ref, roots, isSecret) {
  const matches = new Set(), seen = new Set(), queue = roots.map((dir) => [dir, 0]);
  let visited = 0, truncated = false;
  while (queue.length) {
    const [dir, depth] = queue.shift();
    let real;
    try { real = realpathSync(dir); } catch { continue; }
    if (seen.has(real) || isSecret(real)) continue;
    seen.add(real);
    let entries;
    // macOS 개인정보 보호로 막힌 폴더는 건너뛴다
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > SEARCH_LIMIT.entries) { truncated = true; queue.length = 0; break; }
      const name = nfc(entry.name);
      if (name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < SEARCH_LIMIT.depth && !SKIP_DIRS.has(name)) queue.push([full, depth + 1]); }
      else if (entry.isFile() && sameName(name, ref)) { try { matches.add(realpathSync(full)); } catch { /* 사라진 파일 */ } }
    }
  }
  return { matches: [...matches].sort(), truncated };
}

// refs: 계획의 첨부 이름·경로, text: 대표 원문(최초 지시+답장), chosen: 앞서 확정한 {ref: 경로}
// → { files: [{ref, name, path}], problems: [{ref, reason, candidates}] }
export function resolveAttachments(refs, { text, root, home = homedir(), roots = searchRoots(root, home), chosen = {} }) {
  const files = [], problems = [];
  const secrets = secretLocations(root, home).map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });
  const isSecret = (real) => secrets.some((s) => real === s || real.startsWith(s + sep));
  if (refs.length > MAX_MAIL_ATTACHMENTS) return { files, problems: [{ ref: refs.join(', '), reason: `메일 첨부는 ${MAX_MAIL_ATTACHMENTS}개까지입니다`, candidates: [] }] };
  for (const raw of refs) {
    const ref = attachmentRef(raw);
    if (!ref) continue;
    // AI가 대표가 말하지 않은 파일을 붙이지 못하게 한다
    if (!evidenceIn(text, ref)) { problems.push({ ref, reason: '대표 지시문에 없는 파일 이름입니다', candidates: [] }); continue; }
    const previous = chosen[ref];
    if (previous && sameName(basename(previous), basename(ref)) && !blockedReason(previous, { root, home })) { files.push({ ref, name: basename(previous), path: realpathSync(previous) }); continue; }
    // 대표가 경로를 적었으면 그 파일만 후보로 본다. 이름만 적었으면 허용 범위를 찾는다
    const direct = looksLikePath(ref) ? (() => { const p = expandHome(ref, home); try { return statSync(p).isFile() ? [realpathSync(p)] : []; } catch { return []; } })() : [];
    const written = direct.length ? direct : pathsInText(text, basename(ref), home);
    const search = written.length || looksLikePath(ref) ? { matches: written, truncated: false } : searchFiles(ref, roots, isSecret);
    const blocked = search.matches.map((path) => [path, blockedReason(path, { root, home })]).filter(([, reason]) => reason);
    const usable = search.matches.filter((path) => !blocked.some(([b]) => b === path));
    if (usable.length === 1) { files.push({ ref, name: basename(usable[0]), path: usable[0] }); continue; }
    if (usable.length > 1) { problems.push({ ref, reason: `같은 이름의 파일이 ${usable.length}개 있습니다`, candidates: usable }); continue; }
    problems.push({ ref, candidates: [], reason: blocked.length ? blocked[0][1]
      : `${looksLikePath(ref) ? '적어 주신 경로에' : '작업 공간(보관함 포함)·다운로드·문서·데스크톱에서'} 파일을 찾지 못했습니다${search.truncated ? '(파일이 많아 일부만 확인)' : ''}` });
  }
  const names = files.map((f) => nfc(f.name).toLowerCase());
  for (const file of files) if (names.filter((n) => n === nfc(file.name).toLowerCase()).length > 1 && !problems.some((p) => p.ref === file.ref)) {
    problems.push({ ref: file.ref, reason: '서로 다른 첨부 파일의 이름이 같습니다. 이름을 바꿔 주세요', candidates: [] });
  }
  return problems.length ? { files: [], problems } : { files, problems };
}

// 후보 번호 답장: "1번" 또는 "제휴제안서.pdf는 2번"
export function pickChoices(answer, asked) {
  const entries = Object.entries(asked || {}), text = nfc(answer), choices = {};
  for (const [ref, candidates] of entries) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`${escaped}[^\\n\\d]{0,20}(\\d+)\\s*번`)) || (entries.length === 1 ? text.match(/(\d+)\s*번/) : null);
    const n = Number(match?.[1]);
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length) choices[ref] = candidates[n - 1];
  }
  return choices;
}

export function attachmentQuestion(problems, home = homedir()) {
  const lines = problems.map((p) => `- "${p.ref}": ${p.reason}.${p.candidates.length ? '\n' + p.candidates.map((c, i) => {
    let info = '';
    try { const st = statSync(c); info = ` (${(st.size / 1024 / 1024).toFixed(1)}MB, 수정 ${st.mtime.toISOString().slice(0, 10)})`; } catch { /* 표시만 생략 */ }
    return `  ${i + 1}. ${displayPath(c, home)}${info}`;
  }).join('\n') : ''}`);
  return `메일에 첨부할 파일을 확인해 주세요. 확인 전에는 메일을 보내지 않습니다.\n${lines.join('\n')}\n`
    + '여러 개면 번호(예: "1번")나 파일 전체 경로로, 찾지 못한 파일은 전체 경로로 답하거나 작업 공간 보관함에 넣은 뒤 "이어서 재개"라고 답해 주세요.';
}
