// 작업 공간(workspace) 생성물: 수칙(CLAUDE.md·AGENTS.md)·스킬·Claude 설정(훅)·office 스크립트 연결 파일·표식.
// 원본은 프로그램 레포의 AGENTS.md, .claude/skills/office-task/SKILL.md, .claude/settings.json이다(하나의 정본).
// 생성 표식이 있는 파일(설정 JSON은 생성 기록의 해시가 같은 파일)만 갱신하고, 사용자가 직접 만들거나 고친 파일은 보존한다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { programRoot, realish, renameWithRetry, WORKSPACE_MARKER } from './paths.mjs';
import { CLAUDE_MARKER, syncAgents } from './sync.mjs';

export const TEXT_MARKER = 'ai-office:generated';
const NOTICE = '이 파일은 AI Office 프로그램이 작업 공간에 자동 생성합니다. 직접 고치지 마세요(프로그램 폴더에서 npm run sync로 다시 만듭니다).';
// 표식을 넣을 수 없는 JSON 생성물은 여기에 내용 해시를 남겨, 해시가 같을 때만 생성물로 본다
export const GENERATED_MANIFEST = '.claude/ai-office-generated.json';
const SETTINGS = '.claude/settings.json';
const SKILL = '.claude/skills/office-task/SKILL.md';
const HOOK_PREFIX = '${CLAUDE_PROJECT_DIR}/hooks/';
const SHIMS = ['office.mjs', 'codex-review.mjs'];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// 작업 공간이 프로그램 레포와 같은가(호환 모드: 예전 데이터를 레포 안에서 계속 쓰는 경우). 이때는 생성물을 만들지 않는다
export function isCompatRoot(root, program = programRoot()) {
  const a = realish(root);
  const b = realish(program);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// 훅 명령: 프로그램 레포 훅의 절대경로를 exec 형식 args로 넣는다(셸을 거치지 않아 공백·Windows 경로도 안전).
// base는 프로그램 레포의 .claude/settings.json(호환 모드용, ${CLAUDE_PROJECT_DIR} 자리표시자) 내용이다. 순수 함수
export function buildWorkspaceSettings(base, program, platform = process.platform) {
  const P = pathFor(platform);
  const hooks = {};
  for (const [event, groups] of Object.entries(base.hooks ?? {})) {
    hooks[event] = groups.map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).map((h) => ({
        ...h,
        args: (h.args ?? []).map((a) => (typeof a === 'string' && a.startsWith(HOOK_PREFIX)
          ? P.join(program, 'hooks', ...a.slice(HOOK_PREFIX.length).split('/'))
          : a)),
      })),
    }));
  }
  return JSON.stringify({ ...base, hooks }, null, 2) + '\n';
}

function workspaceSettings(program, platform) {
  return buildWorkspaceSettings(JSON.parse(readFileSync(join(program, '.claude', 'settings.json'), 'utf8')), program, platform);
}

// 작업 공간에서 `node scripts/office.mjs …`를 실행하면 프로그램 레포의 같은 스크립트를 이 작업 공간 기준으로 실행한다.
// 작업 공간 위치는 이 파일 위치로 정하므로 작업 공간 폴더를 옮겨도 그대로 동작한다
export function shimFile(program, name, platform = process.platform) {
  const target = pathFor(platform).join(program, 'scripts', name);
  return [
    '#!/usr/bin/env node',
    `// ${TEXT_MARKER} ${NOTICE}`,
    `// 프로그램 폴더의 scripts/${name}를 이 작업 공간(이 파일의 상위 폴더) 기준으로 실행한다.`,
    "import { dirname, resolve } from 'node:path';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    '',
    `const target = ${JSON.stringify(target)};`,
    "process.env.AI_OFFICE_WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..');",
    'delete process.env.AI_OFFICE_ROOT;',
    'process.argv[1] = target;',
    'await import(pathToFileURL(target).href);',
    '',
  ].join('\n');
}

function claudeMd(program) {
  return [
    `<!-- ${TEXT_MARKER} ${NOTICE} -->`,
    '@AGENTS.md',
    '',
    '이 작업 공간에서 연 Claude Code 메인 세션은 비서실장이다. 운영 수칙은 AGENTS.md, 업무 절차는 `.claude/skills/office-task/SKILL.md`를 따른다.',
    '',
    `이 폴더는 회사 데이터(org/·outputs/·.office/)와 AI 실행 위치다. 대시보드 프로그램(\`${program}\`)의 코드·설정은 고치지 않는다. 쓰기는 훅이 거부한다.`,
    '',
  ].join('\n');
}

function agentsMd(program, platform) {
  const body = readText(join(program, 'AGENTS.md')).trimEnd();
  return [
    `<!-- ${TEXT_MARKER} ${NOTICE} -->`,
    `> 이 폴더는 AI Office 작업 공간이다. 프로그램 폴더 \`${program}\`는 읽기만 하고 고치지 않는다(설계 정본: \`${pathFor(platform).join(program, 'docs', 'SPEC.md')}\`).`,
    '',
    body,
    '',
  ].join('\n');
}

function skillMd(program) {
  const text = readText(join(program, ...SKILL.split('/')));
  const m = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(text);
  if (!m) return `<!-- ${TEXT_MARKER} ${NOTICE} -->\n${text}`;
  // 에이전트 파일과 같은 위치(frontmatter 다음 줄)에 표식을 둔다
  return `${m[1]}${CLAUDE_MARKER} ${NOTICE} -->\n${m[2]}`;
}

function markerFile(program) {
  return [
    `${TEXT_MARKER} AI Office 작업 공간 표식. 지우지 마세요(훅이 이 폴더를 작업 공간으로 알아보는 데 씁니다).`,
    `program: ${program}`,
    '',
  ].join('\n');
}

/**
 * 작업 공간에 둘 생성물 목록. 반환: Map(상대경로 → 내용). 순수 함수에 가깝다(프로그램 레포의 원본 파일만 읽는다).
 * platform은 테스트에서 Windows 경로를 확인하려고 주입한다.
 */
export function workspaceFiles({ program = programRoot(), platform = process.platform } = {}) {
  const files = new Map();
  files.set(WORKSPACE_MARKER, markerFile(program));
  files.set('CLAUDE.md', claudeMd(program));
  files.set('AGENTS.md', agentsMd(program, platform));
  files.set(SKILL, skillMd(program));
  files.set(SETTINGS, workspaceSettings(program, platform));
  for (const name of SHIMS) files.set(`scripts/${name}`, shimFile(program, name, platform));
  return files;
}

// 텍스트 생성물의 표식 판정
function hasTextMarker(rel, text) {
  if (rel === SKILL) {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n(.*)/.exec(text);
    return Boolean(m && m[1].startsWith(CLAUDE_MARKER));
  }
  const head = text.split(/\r?\n/, 3).join('\n');
  return head.includes(TEXT_MARKER);
}

function readManifest(root) {
  try {
    const data = JSON.parse(readFileSync(join(root, ...GENERATED_MANIFEST.split('/')), 'utf8'));
    return data && typeof data === 'object' && data.files && typeof data.files === 'object' ? data : { version: 1, files: {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameWithRetry(tmp, file);
}

/**
 * 작업 공간 생성물 동기화. write=false면 무엇이 달라지는지만 계산한다.
 * 반환: { changed:[상대경로], conflicts:[상대경로], diffs:[{path, kind}], ok, skipped }
 * 호환 모드(root가 프로그램 레포)면 skipped: true로 아무것도 하지 않는다.
 */
export function syncWorkspace(root, { write = false, program = programRoot(), platform = process.platform } = {}) {
  if (isCompatRoot(root, program)) return { changed: [], conflicts: [], diffs: [], ok: true, skipped: true };
  const desired = workspaceFiles({ program, platform });
  const manifest = readManifest(root);
  const changed = [];
  const conflicts = [];
  const diffs = [];
  let manifestDirty = false;
  for (const [rel, content] of desired) {
    const abs = join(root, ...rel.split('/'));
    const isJson = rel.endsWith('.json');
    if (existsSync(abs)) {
      const current = readFileSync(abs, 'utf8');
      if (current === content) {
        if (isJson && manifest.files[rel] !== sha256(content)) {
          manifest.files[rel] = sha256(content);
          manifestDirty = true;
        }
        continue;
      }
      const generated = isJson ? manifest.files[rel] === sha256(current) : hasTextMarker(rel, current);
      if (!generated) {
        conflicts.push(rel);
        continue;
      }
      diffs.push({ path: rel, kind: 'update' });
    } else {
      diffs.push({ path: rel, kind: 'create' });
    }
    changed.push(rel);
    if (write) {
      writeAtomic(abs, content);
      if (isJson) {
        manifest.files[rel] = sha256(content);
        manifestDirty = true;
      }
    }
  }
  if (write && manifestDirty) writeAtomic(join(root, ...GENERATED_MANIFEST.split('/')), JSON.stringify(manifest, null, 2) + '\n');
  return { changed, conflicts, diffs, ok: conflicts.length === 0 && (write || diffs.length === 0), skipped: false };
}

// 작업 공간 초기화 여부(표식 파일이 있는가)
export function isWorkspaceInitialized(root) {
  return existsSync(join(root, WORKSPACE_MARKER));
}

/**
 * 작업 공간 준비: 폴더를 만들고 생성물(수칙·설정·스킬·스크립트 연결·표식)과 에이전트 파일을 정본에서 다시 만든다.
 * 서버 시작·migrate·npm run sync가 부른다. 호환 모드(root가 프로그램 레포)면 에이전트 파일만 맞춘다.
 * 반환: { workspace: syncWorkspace 결과, agents: syncAgents 결과 또는 null, error? }
 */
export function ensureWorkspace(root, { program = programRoot(), platform = process.platform } = {}) {
  mkdirSync(root, { recursive: true });
  const workspace = syncWorkspace(root, { write: true, program, platform });
  let agents = null;
  let error = null;
  try {
    agents = syncAgents(root, { write: true });
  } catch (err) {
    error = err;
  }
  return { workspace, agents, error };
}
