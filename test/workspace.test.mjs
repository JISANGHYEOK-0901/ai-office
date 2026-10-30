// 작업 공간 분리(SPEC "작업 공간 분리"): 경로 결정, 생성물, 훅 절대경로, 프로그램 레포 보호, runner·서버 cwd, migrate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import fsModule, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_CONFIG, WORKSPACE_MARKER, WorkspaceError, defaultWorkspace, kstDate, legacyItems, programRoot, resolveWorkspace, saveLocalWorkspace,
} from '../lib/paths.mjs';
import { GENERATED_MANIFEST, buildWorkspaceSettings, ensureWorkspace, shimFile, syncWorkspace, workspaceFiles } from '../lib/workspace.mjs';
import { decideRepoGuard, shellWriteTarget } from '../lib/chief-guard.mjs';
import { MigrateError, migrateLegacy, planMigration } from '../lib/migrate.mjs';
import { SERVER_LOCK, acquireServerLock, runningServer } from '../lib/server-lock.mjs';
import { createRunner } from '../dashboard/runner.mjs';
import { workspaceBanners } from '../dashboard/public/app.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];

function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // Windows는 runner 로그 스트림이 비동기로 닫히기 전에 지우면 ENOTEMPTY가 난다.
  // 동기 rmSync 재시도는 이벤트 루프를 막아 핸들이 닫히지 않으므로 비동기 rm으로 재시도한다
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

// 테스트 환경: 사용자 셸의 작업 공간 지정·Claude 세션 변수가 섞이지 않게 뺀다
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['AI_OFFICE_ROOT', 'AI_OFFICE_WORKSPACE', 'CLAUDE_PROJECT_DIR', 'OFFICE_CHIEF_RUN', 'OFFICE_ORGMAP_INJECTED']) delete env[k];
  return { ...env, ...extra };
}

// 프로그램 레포의 최소 사본(생성물 원본·스크립트·훅·lib). 프로그램 폴더 위치가 바뀌는 경우와 migrate CLI 시험에 쓴다
function copyProgram(t, prefix = 'office-program-') {
  const program = tmp(t, prefix);
  for (const rel of ['AGENTS.md', 'CLAUDE.md', 'package.json', '.claude/settings.json', '.claude/skills', 'lib', 'hooks', 'scripts', 'org/presets.json', 'org/templates']) {
    cpSync(join(REPO, ...rel.split('/')), join(program, ...rel.split('/')), { recursive: true });
  }
  return program;
}

function gitStatus() {
  const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO, encoding: 'utf8' });
  return res.status === 0 ? res.stdout : null;
}

// ---- 경로 결정 ----

test('resolveWorkspace: AI_OFFICE_ROOT(테스트용) > AI_OFFICE_WORKSPACE > --workspace > .office-local.json > 기본 ~/AIOffice', (t) => {
  const program = tmp(t, 'office-prog-');
  const home = tmp(t, 'office-home-');
  const a = join(tmp(t, 'office-ws-'), 'a');
  const b = join(tmp(t, 'office-ws-'), 'b');
  const c = join(tmp(t, 'office-ws-'), 'c');
  const opts = { program, homedir: home, platform: process.platform };
  const def = resolveWorkspace({ ...opts, env: {} });
  assert.equal(def.path, join(home, 'AIOffice'));
  assert.equal(def.source, 'default');
  assert.equal(def.compat, false);

  saveLocalWorkspace(c, program);
  assert.deepEqual(JSON.parse(readFileSync(join(program, LOCAL_CONFIG), 'utf8')), { workspace: c });
  assert.equal(resolveWorkspace({ ...opts, env: {} }).source, 'local');
  assert.equal(resolveWorkspace({ ...opts, env: {} }).path, c);
  assert.equal(resolveWorkspace({ ...opts, env: {}, workspace: b }).path, b);
  assert.equal(resolveWorkspace({ ...opts, env: {}, workspace: b }).source, 'arg');
  assert.equal(resolveWorkspace({ ...opts, env: { AI_OFFICE_WORKSPACE: a }, workspace: b }).path, a);
  assert.equal(resolveWorkspace({ ...opts, env: { AI_OFFICE_WORKSPACE: a, AI_OFFICE_ROOT: b } }).path, b);

  writeFileSync(join(program, LOCAL_CONFIG), '{ 깨진');
  assert.throws(() => resolveWorkspace({ ...opts, env: {} }), WorkspaceError);
});

test('resolveWorkspace: 프로그램 폴더 안·상위는 거부하고, 예전 데이터가 레포에 있으면(사용자 지정 없음) 호환 모드', (t) => {
  const parent = tmp(t, 'office-parent-');
  const program = join(parent, 'ai-office');
  mkdirSync(join(program, 'org'), { recursive: true });
  assert.throws(() => resolveWorkspace({ program, env: { AI_OFFICE_WORKSPACE: program } }), /프로그램 폴더\(.*\) 안에/);
  assert.throws(() => resolveWorkspace({ program, env: { AI_OFFICE_WORKSPACE: join(program, 'ws') } }), WorkspaceError);
  assert.throws(() => resolveWorkspace({ program, env: { AI_OFFICE_WORKSPACE: parent } }), /품고 있습니다/);

  // .office만 있으면(레포에서 연 개발 세션의 이벤트) 예전 데이터로 보지 않는다
  mkdirSync(join(program, '.office'));
  writeFileSync(join(program, '.office', 'events.jsonl'), '');
  assert.deepEqual(legacyItems(program), []);
  writeFileSync(join(program, 'org', 'roster.json'), '[]');
  assert.deepEqual(legacyItems(program), ['org/roster.json', '.office']);
  const compat = resolveWorkspace({ program, env: {}, homedir: parent });
  assert.deepEqual({ path: compat.path, source: compat.source, compat: compat.compat }, { path: program, source: 'compat', compat: true });
  // 사용자가 고른 작업 공간이 있으면 그쪽을 쓰고 예전 데이터는 legacy로만 알린다
  const chosen = resolveWorkspace({ program, env: { AI_OFFICE_WORKSPACE: join(parent, 'ws') } });
  assert.equal(chosen.compat, false);
  assert.deepEqual(chosen.legacy, ['org/roster.json', '.office']);
  assert.equal(resolveWorkspace({ program, env: {}, homedir: parent, allowCompat: false }).path, join(parent, 'AIOffice'));
});

test('Windows 경로(platform 주입): 기본값은 %USERPROFILE%\\AIOffice, 대소문자 다른 레포 안 경로도 거부', () => {
  const env = { USERPROFILE: 'C:\\Users\\김대리' };
  assert.equal(defaultWorkspace({ platform: 'win32', env }), 'C:\\Users\\김대리\\AIOffice');
  const program = 'C:\\Users\\김대리\\Code\\ai-office';
  const ws = resolveWorkspace({ platform: 'win32', env, program, homedir: 'C:\\Users\\김대리', allowCompat: false });
  assert.equal(ws.path, 'C:\\Users\\김대리\\AIOffice');
  assert.throws(() => resolveWorkspace({ platform: 'win32', env: { AI_OFFICE_WORKSPACE: 'c:\\users\\김대리\\CODE\\AI-OFFICE\\data' }, program, allowCompat: false }), WorkspaceError);
  // 다른 드라이브는 레포와 겹치지 않는다
  assert.equal(resolveWorkspace({ platform: 'win32', env: { AI_OFFICE_WORKSPACE: 'D:\\Office' }, program, allowCompat: false }).path, 'D:\\Office');
});

// ---- 생성물 ----

test('workspace 설정: 훅은 프로그램 레포 훅 절대경로의 exec 형식, 레포 설정과 같은 이벤트·권한(공백·Windows 경로 포함)', () => {
  const repoSettings = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
  const cases = [
    { text: workspaceFiles().get('.claude/settings.json'), program: programRoot(), P: path },
    { text: buildWorkspaceSettings(repoSettings, '/Users/kim/My Apps/ai office', 'darwin'), program: '/Users/kim/My Apps/ai office', P: path.posix },
    { text: buildWorkspaceSettings(repoSettings, 'C:\\Program Files\\AI Office', 'win32'), program: 'C:\\Program Files\\AI Office', P: path.win32 },
  ];
  for (const c of cases) {
    const settings = JSON.parse(c.text);
    assert.deepEqual(settings.permissions, repoSettings.permissions);
    assert.deepEqual(Object.keys(settings.hooks), Object.keys(repoSettings.hooks));
    for (const ev of HOOK_EVENTS) {
      const want = repoSettings.hooks[ev].flatMap((g) => g.hooks).map((h) => c.P.join(c.program, 'hooks', h.args[0].split('/').pop()));
      const got = settings.hooks[ev].flatMap((g) => g.hooks).map((h) => {
        assert.equal(h.type, 'command');
        assert.equal(h.command, 'node', '셸을 거치지 않는 exec 형식');
        assert.equal(h.args.length, 1);
        return h.args[0];
      });
      assert.deepEqual(got, want, ev);
    }
    assert.ok(!c.text.includes('${CLAUDE_PROJECT_DIR}'));
  }
});

test('연결 스크립트·수칙: Windows 경로는 JSON 문자열로 안전하게 넣고, 생성 표식을 단다', () => {
  const win = 'C:\\Users\\김대리\\Code\\ai "office"';
  const shim = shimFile(win, 'office.mjs', 'win32');
  assert.match(shim, /^#!\/usr\/bin\/env node\n\/\/ ai-office:generated/);
  assert.ok(shim.includes(`const target = ${JSON.stringify(path.win32.join(win, 'scripts', 'office.mjs'))};`), shim);
  assert.match(shim, /delete process\.env\.AI_OFFICE_ROOT/);
  const files = workspaceFiles();
  assert.ok(files.get('AGENTS.md').startsWith('<!-- ai-office:generated'));
  assert.ok(files.get('AGENTS.md').includes(join(programRoot(), 'docs', 'SPEC.md')));
  assert.match(files.get('CLAUDE.md'), /^<!-- ai-office:generated.*-->\n@AGENTS\.md\n/);
  assert.match(files.get('.claude/skills/office-task/SKILL.md'), /^---\nname: office-task\n[\s\S]*?\n---\n<!-- ai-office:generated/);
  assert.match(files.get(WORKSPACE_MARKER), /^ai-office:generated/);
});

test('syncWorkspace: 생성 → 일치, 표식 없는 수칙·직접 고친 설정은 보존(충돌), 프로그램 폴더가 옮겨지면 생성물만 갱신', (t) => {
  const ws = tmp(t, 'office-wsync-');
  const progA = copyProgram(t);
  let r = syncWorkspace(ws, { write: true, program: progA });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed.sort(), ['.ai-office-workspace', '.claude/settings.json', '.claude/skills/office-task/SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'scripts/codex-review.mjs', 'scripts/office.mjs']);
  assert.ok(existsSync(join(ws, GENERATED_MANIFEST)));
  assert.deepEqual(syncWorkspace(ws, { program: progA }).diffs, []);

  // 사용자가 직접 쓴 CLAUDE.md(표식 없음)와 손댄 설정은 덮어쓰지 않는다
  writeFileSync(join(ws, 'CLAUDE.md'), '# 내 수칙\n');
  const settingsFile = join(ws, '.claude', 'settings.json');
  writeFileSync(settingsFile, readFileSync(settingsFile, 'utf8').replace('"permissions"', '"model": "opus",\n  "permissions"'));
  const progB = copyProgram(t, 'office-program-moved-');
  r = syncWorkspace(ws, { write: true, program: progB });
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts.sort(), ['.claude/settings.json', 'CLAUDE.md']);
  assert.equal(readFileSync(join(ws, 'CLAUDE.md'), 'utf8'), '# 내 수칙\n');
  assert.match(readFileSync(settingsFile, 'utf8'), /"model": "opus"/);
  // 표식이 있는 생성물은 새 프로그램 위치로 갱신된다
  assert.ok(readFileSync(join(ws, 'scripts', 'office.mjs'), 'utf8').includes(JSON.stringify(join(progB, 'scripts', 'office.mjs'))));
  assert.ok(readFileSync(join(ws, 'AGENTS.md'), 'utf8').includes(progB));

  // 손대지 않은 설정은 해시가 같으므로 새 위치로 갱신된다
  rmSync(settingsFile);
  syncWorkspace(ws, { write: true, program: progA });
  r = syncWorkspace(ws, { write: true, program: progB });
  assert.ok(r.changed.includes('.claude/settings.json'));
  assert.ok(readFileSync(settingsFile, 'utf8').includes(JSON.stringify(join(progB, 'hooks', 'office-event.mjs')).slice(1, -1)));

  // 호환 모드(작업 공간 = 프로그램 레포)는 아무것도 만들지 않는다
  assert.equal(syncWorkspace(progA, { write: true, program: progA }).skipped, true);
  assert.equal(existsSync(join(progA, WORKSPACE_MARKER)), false);
});

// ---- 작업 공간에서의 실행: 연결 스크립트·훅 ----

test('작업 공간의 node scripts/office.mjs는 프로그램 스크립트를 그 작업 공간 기준으로 실행하고, 레포에는 아무것도 쓰지 않는다', (t) => {
  const before = gitStatus();
  const ws = join(tmp(t, 'office-wsrun-'), 'My Office');
  const init = ensureWorkspace(ws);
  assert.equal(init.workspace.ok, true);
  const res = spawnSync(process.execPath, ['scripts/office.mjs', 'task', 'start', '작업 공간 시험', '--slug', 'ws-test'], { cwd: ws, env: cleanEnv({ AI_OFFICE_ROOT: '' }), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const id = `${kstDate()}/ws-test`;
  assert.match(res.stdout, new RegExp(`OFFICE_TASK=${id}`));
  assert.ok(existsSync(join(ws, 'outputs', kstDate(), 'ws-test', 'brief.md')));
  assert.ok(JSON.parse(readFileSync(join(ws, '.office', 'tasks.json'), 'utf8')).some((x) => x.id === id));

  // codex-review 연결 스크립트도 같은 작업 공간을 쓴다(실제 codex는 실행하지 않는 --dry-run)
  mkdirSync(join(ws, 'org'), { recursive: true });
  writeFileSync(join(ws, 'org', 'departments.json'), JSON.stringify([{ id: 'verify', name: '검증실', engine: 'codex' }]));
  writeFileSync(join(ws, 'org', 'roster.json'), JSON.stringify([{ id: 'verify-1', name: '최과장', department: 'verify', title: '담당' }]));
  const review = spawnSync(process.execPath, ['scripts/codex-review.mjs', '--target', `outputs/${id}`, '--dry-run'], { cwd: ws, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /-C <작업 공간>/);
  assert.match(review.stdout, new RegExp(`작업 공간 기준 경로: outputs/${id}`));

  if (before !== null) assert.equal(gitStatus(), before, '프로그램 레포의 git status가 바뀌면 안 된다');
});

function runHook(script, input, env) {
  return spawnSync(process.execPath, [script], { env: cleanEnv(env), input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
}

test('훅: 작업 공간 설정의 절대경로 훅이 이벤트를 작업 공간 .office에 쓰고, 직원의 프로그램 레포 쓰기를 거부한다', (t) => {
  const before = gitStatus();
  const ws = tmp(t, 'office-wshook-');
  ensureWorkspace(ws);
  const settings = JSON.parse(readFileSync(join(ws, '.claude', 'settings.json'), 'utf8'));
  const hookArgs = (ev, name) => settings.hooks[ev].flatMap((g) => g.hooks).map((h) => h.args[0]).find((a) => a.endsWith(name));
  const eventHook = hookArgs('SessionStart', 'office-event.mjs');
  const guardHook = hookArgs('PreToolUse', 'chief-guard.mjs');
  assert.equal(eventHook, join(programRoot(), 'hooks', 'office-event.mjs'));

  const env = { CLAUDE_PROJECT_DIR: ws };
  let res = runHook(eventHook, { session_id: 's-ws', hook_event_name: 'SessionStart', cwd: ws, source: 'startup' }, env);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const events = readFileSync(join(ws, '.office', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.at(-1).kind, 'session.start');

  const pre = (tool, toolInput, extra = {}) => ({ session_id: 's-ws', hook_event_name: 'PreToolUse', cwd: ws, tool_name: tool, tool_input: toolInput, agent_id: 'a1', agent_type: 'dev-1', ...extra });
  const decision = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null);
  const target = join(programRoot(), 'lib', 'paths.mjs');
  for (const [tool, input] of [
    ['Write', { file_path: target, content: 'x' }],
    ['Edit', { file_path: target, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: target, edits: [] }],
    ['Bash', { command: `echo x > "${join(programRoot(), 'README.md')}"` }],
  ]) {
    res = runHook(guardHook, pre(tool, input), env);
    assert.equal(res.status, 0);
    const d = decision(res);
    assert.equal(d?.permissionDecision, 'deny', `${tool} 거부`);
    assert.match(d.permissionDecisionReason, /프로그램 폴더/);
  }
  // 비서실장(메인 세션)도 같다
  res = runHook(guardHook, pre('Write', { file_path: target, content: 'x' }, { agent_id: undefined, agent_type: undefined }), env);
  assert.equal(decision(res)?.permissionDecision, 'deny');
  // 작업 공간 안 쓰기·레포 읽기는 허용
  res = runHook(guardHook, pre('Write', { file_path: join(ws, 'outputs', 'x.md'), content: 'x' }), env);
  assert.equal(res.stdout, '');
  res = runHook(guardHook, pre('Bash', { command: `cat "${join(programRoot(), 'README.md')}"` }), env);
  assert.equal(res.stdout, '');
  assert.equal(readFileSync(target, 'utf8').length > 0, true);
  if (before !== null) assert.equal(gitStatus(), before);
});

test('훅: 작업 공간에서 node scripts/office.mjs task start 출력은 그 작업 공간의 sessions.json에 세션을 연결한다', (t) => {
  const ws = tmp(t, 'office-wslink-');
  ensureWorkspace(ws);
  const id = '2026-10-29/link-test';
  mkdirSync(join(ws, '.office'), { recursive: true });
  writeFileSync(join(ws, '.office', 'tasks.json'), JSON.stringify([{ id, title: 't', status: 'active', created: '2026-10-29T00:00:00Z' }]));
  const res = runHook(join(programRoot(), 'hooks', 'office-event.mjs'), {
    session_id: 's-link', hook_event_name: 'PostToolUse', cwd: ws, tool_name: 'Bash',
    tool_input: { command: "node scripts/office.mjs task start '링크'" }, tool_response: { stdout: `brief.md\nOFFICE_TASK=${id}\n` },
  }, { CLAUDE_PROJECT_DIR: ws });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(ws, '.office', 'sessions.json'), 'utf8')), { 's-link': id });
});

test('화면 배너: 호환 모드·예전 데이터 남음이면 이전 안내(닫기 없음), 데모·정상은 없음', () => {
  assert.deepEqual(workspaceBanners({ compat: false, legacyPending: false }), []);
  assert.deepEqual(workspaceBanners({ compat: true, legacyPending: true }, { demo: true }), []);
  const [compat] = workspaceBanners({ compat: true, legacyPending: true });
  assert.equal(compat.sticky, true);
  assert.match(compat.text, /호환 모드.*npm run migrate/);
  assert.match(workspaceBanners({ compat: false, legacyPending: true })[0].text, /예전 회사 데이터.*npm run migrate/);
  assert.deepEqual(workspaceBanners(undefined), []);
});

// ---- 프로그램 레포 보호 판정(순수 함수) ----

test('decideRepoGuard: 파일 도구는 대상 경로로 판정(상대경로·~·NotebookEdit), 작업 공간이 레포면 판정하지 않는다', () => {
  const program = '/Users/kim/ai office';
  const root = '/Users/kim/AIOffice';
  const opts = { program, root, platform: 'linux', home: '/Users/kim' };
  const pre = (tool, toolInput, cwd = root) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd });
  assert.ok(decideRepoGuard(pre('Write', { file_path: '/Users/kim/ai office/dashboard/server.mjs' }), opts));
  assert.ok(decideRepoGuard(pre('Edit', { file_path: '../ai office/lib/x.mjs' }), opts));
  assert.ok(decideRepoGuard(pre('Write', { file_path: '~/ai office/x' }), opts));
  assert.ok(decideRepoGuard(pre('NotebookEdit', { notebook_path: '/Users/kim/ai office/n.ipynb' }), opts));
  assert.equal(decideRepoGuard(pre('Write', { file_path: 'outputs/2026-10-29/x/a.md' }), opts), null);
  assert.equal(decideRepoGuard(pre('Write', { file_path: '/Users/kim/ai office-backup/x' }), opts), null, '이름만 비슷한 폴더는 레포가 아니다');
  assert.equal(decideRepoGuard(pre('Read', { file_path: '/Users/kim/ai office/README.md' }), opts), null);
  assert.equal(decideRepoGuard(pre('Write', { file_path: '/Users/kim/ai office/x' }), { ...opts, root: program }), null, '호환 모드·레포 개발 세션');
  assert.equal(decideRepoGuard({ ...pre('Write', { file_path: '/Users/kim/ai office/x' }), hook_event_name: 'PostToolUse' }, opts), null);
});

test('shellWriteTarget(최선 노력): 리다이렉션·tee·rm·mv·cp 대상·cd 이동·git 쓰기·인라인 스크립트는 거부, 읽기와 cp 원본은 허용', () => {
  const program = '/Users/kim/ai office';
  const o = { program, cwd: '/Users/kim/AIOffice', platform: 'linux', home: '/Users/kim' };
  const hit = (c) => shellWriteTarget(c, o);
  for (const c of [
    'echo hi > "/Users/kim/ai office/lib/a.mjs"',
    'echo hi >>"/Users/kim/ai office/a"',
    'ls 2> "/Users/kim/ai office/err.log"',
    'ls | tee -a "/Users/kim/ai office/x"',
    'rm -rf ~/"ai office"/lib',
    'sudo rm "$HOME/ai office/x"',
    'mv "/Users/kim/ai office/a" b',
    'cp out.md "/Users/kim/ai office/README.md"',
    'cp -t "/Users/kim/ai office" a b',
    'cd "/Users/kim/ai office" && touch x',
    'cd .. ; rm "ai office/x"',
    'git -C "/Users/kim/ai office" reset --hard',
    'cd "/Users/kim/ai office"; git commit -am x',
    'node -e "require(\'fs\').writeFileSync(\'/Users/kim/ai office/x\', 1)"',
    'sed -i s/a/b/ "/Users/kim/ai office/x"',
    'bash -c "rm -rf \'/Users/kim/ai office/lib\'"',
  ]) assert.ok(hit(c), c);
  for (const c of [
    'cat "/Users/kim/ai office/README.md"',
    'grep -r foo "/Users/kim/ai office/lib"',
    'cp "/Users/kim/ai office/README.md" out.md',
    'git -C "/Users/kim/ai office" log --oneline',
    'node scripts/office.mjs task list',
    'echo 1 2>/dev/null',
    'curl https://example.com/ai office > out.html',
  ]) assert.equal(hit(c), null, c);
});

test('shellWriteTarget: Windows 경로(platform 주입)·PowerShell 명령·대소문자 차이', () => {
  const o = { program: 'C:\\Users\\Kim\\ai office', cwd: 'C:\\Users\\Kim\\AIOffice', platform: 'win32', home: 'C:\\Users\\Kim' };
  const hit = (c) => shellWriteTarget(c, o);
  assert.ok(hit('Remove-Item -Recurse "c:\\users\\kim\\AI OFFICE\\lib"'));
  assert.ok(hit('Set-Content -Path "C:\\Users\\Kim\\ai office\\x.txt" -Value 1'));
  assert.ok(hit('Copy-Item a.txt -Destination "$env:USERPROFILE\\ai office\\b.txt"'));
  assert.ok(hit('echo x > "C:/Users/Kim/ai office/a.txt"'));
  assert.ok(hit('del ..\\"ai office"\\x'));
  assert.ok(hit('cmd /c "del C:\\Users\\Kim\\ai office\\x"') || hit("cmd /c 'del \"C:\\Users\\Kim\\ai office\\x\"'"));
  assert.ok(hit('powershell -Command "Remove-Item \'C:\\Users\\Kim\\ai office\\lib\' -Recurse"'));
  assert.equal(hit('Get-Content "C:\\Users\\Kim\\ai office\\README.md"'), null);
  assert.equal(hit('Remove-Item "D:\\ai office\\x"'), null, '다른 드라이브');
  const decision = decideRepoGuard({ tool_name: 'PowerShell', tool_input: { command: 'Out-File -FilePath "C:\\Users\\Kim\\ai office\\x"' }, cwd: o.cwd }, { program: o.program, root: o.cwd, platform: 'win32', home: o.home });
  assert.match(decision.reason, /셸 명령의 쓰기 대상/);
});

// ---- runner·서버 ----

function fakeSpawner() {
  const calls = [];
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { calls, spawnImpl };
}

test('runner: claude·codex-review 실행의 cwd는 작업 공간, codex-review는 프로그램 레포 스크립트에 작업 공간을 환경변수로 넘긴다', async (t) => {
  const ws = tmp(t, 'office-wsrunner-');
  mkdirSync(join(ws, 'org'));
  writeFileSync(join(ws, 'org', 'departments.json'), '[]');
  writeFileSync(join(ws, 'org', 'roster.json'), '[]');
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = join(ws, 'fake-claude.js');
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev; });
  const { calls, spawnImpl } = fakeSpawner();
  const runner = createRunner({ root: ws, spawnImpl, killGraceMs: 10 });
  runner.start({ agentId: null, prompt: '시장 조사' });
  runner.startReview({ target: 'outputs/2026-10-29/x', reviewers: 'all' });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.opts.cwd, ws);
  const review = calls[1];
  assert.equal(review.args[0], join(programRoot(), 'scripts', 'codex-review.mjs'));
  assert.equal(review.opts.env.AI_OFFICE_WORKSPACE, ws);
  assert.equal(review.opts.env.AI_OFFICE_ROOT, '');
  for (const c of calls) c.child.emit('close', 0, null);
  await runner.stopAll?.();
});

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 본문이 JSON이 아님 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('서버: 없는 작업 공간을 만들어 초기화하고, 회사 설정(토큰)에 경로·폴더 열기를 제공한다. 레포 git status는 그대로', async (t) => {
  const before = gitStatus();
  const ws = join(tmp(t, 'office-wsserver-'), 'AIOffice');
  const publicDir = join(tmp(t, 'office-wspublic-'), 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><meta name="office-token" content="__OFFICE_TOKEN__">');
  const opened = [];
  const { startServer } = await import('../dashboard/server.mjs');
  const handle = await startServer({ root: ws, port: 0, publicDir, quiet: true, env: cleanEnv({ CLAUDE_BIN: join(ws, 'none.js'), CODEX_BIN: join(ws, 'none.js') }), openFolder: (dir) => opened.push(dir) });
  t.after(() => handle.close());
  for (const rel of [WORKSPACE_MARKER, 'CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.claude/skills/office-task/SKILL.md', 'scripts/office.mjs', 'scripts/codex-review.mjs', '.office']) {
    assert.ok(existsSync(join(ws, ...rel.split('/'))), rel);
  }
  assert.equal(existsSync(join(ws, 'org')), false, '빈 회사: 정본은 첫 저장 때 만든다');

  const base = `http://127.0.0.1:${handle.port}`;
  const state = await request(handle.port, 'GET', '/api/state');
  assert.deepEqual(state.json.workspace, { compat: false, legacyPending: legacyItems().length > 0 });
  assert.ok(!state.text.includes(ws), '토큰 없는 상태 응답에는 경로를 싣지 않는다');
  assert.ok((await request(handle.port, 'GET', '/api/company')).status >= 400, '토큰 없는 회사 설정 조회는 거부');
  const company = await request(handle.port, 'GET', '/api/company', { headers: { 'X-Office-Token': handle.token } });
  assert.equal(company.json.workspace.path, ws);
  assert.equal(company.json.workspace.compat, false);
  const open = await request(handle.port, 'POST', '/api/workspace/open', { body: {}, headers: { 'X-Office-Token': handle.token, Origin: base, 'Content-Type': 'application/json' } });
  assert.equal(open.status, 200, open.text);
  assert.deepEqual(opened, [ws]);
  const noToken = await request(handle.port, 'POST', '/api/workspace/open', { body: {}, headers: { Origin: base, 'Content-Type': 'application/json' } });
  assert.ok(noToken.status >= 400 && opened.length === 1);
  if (before !== null) assert.equal(gitStatus(), before);
});

test('서버 호환 모드: 작업 공간이 프로그램 레포면 생성물을 만들지 않고 상태에 compat을 싣는다', async (t) => {
  const program = copyProgram(t);
  mkdirSync(join(program, 'org'), { recursive: true });
  writeFileSync(join(program, 'org', 'departments.json'), '[]');
  const publicDir = join(tmp(t, 'office-wspublic-'), 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html>');
  const { startServer } = await import('../dashboard/server.mjs');
  // 기본 작업 공간(표식 여부)을 사용자 홈이 아닌 임시 홈에서 본다
  const home = tmp(t, 'office-wshome-');
  const handle = await startServer({ port: 0, publicDir, quiet: true, program, env: cleanEnv({ HOME: home, USERPROFILE: home, CLAUDE_BIN: join(program, 'none.js'), CODEX_BIN: join(program, 'none.js') }) });
  t.after(() => handle.close());
  assert.equal(handle.root, program);
  assert.equal(handle.compat, true);
  assert.equal(existsSync(join(program, WORKSPACE_MARKER)), false);
  const state = await request(handle.port, 'GET', '/api/state');
  assert.deepEqual(state.json.workspace, { compat: true, legacyPending: true });
});

// ---- migrate ----

function seedLegacy(program) {
  mkdirSync(join(program, 'org'), { recursive: true });
  writeFileSync(join(program, 'org', 'departments.json'), JSON.stringify([{ id: 'research', name: '리서치부', engine: 'claude' }]));
  writeFileSync(join(program, 'org', 'roster.json'), JSON.stringify([{ id: 'research-1', name: '김대리', department: 'research', title: '담당' }]));
  writeFileSync(join(program, 'org', 'company.md'), '회사 규칙\n');
  mkdirSync(join(program, 'outputs', '2026-10-29', 'scan', 'research'), { recursive: true });
  writeFileSync(join(program, 'outputs', '2026-10-29', 'scan', 'report.md'), '# 보고\n'.repeat(100));
  writeFileSync(join(program, 'outputs', '2026-10-29', 'scan', 'research', 'research-1-data.csv'), 'a,b\n1,2\n');
  mkdirSync(join(program, '.office', 'runs'), { recursive: true });
  writeFileSync(join(program, '.office', 'events.jsonl'), '{"v":1}\n');
  writeFileSync(join(program, '.office', 'runs', 'r1.log'), 'log');
  mkdirSync(join(program, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(program, '.claude', 'agents', 'mine.md'), '내 에이전트(표식 없음)\n');
}

test('migrate: 복사 → 검증(파일 수·크기) → 원본은 .office-migrated-<날짜>/로 보관, 다시 실행하면 할 일 없음', (t) => {
  const program = tmp(t, 'office-mprog-');
  seedLegacy(program);
  const ws = join(tmp(t, 'office-mws-'), 'AIOffice');
  const plan = planMigration({ program, workspace: ws });
  assert.deepEqual(plan.items.map((i) => i.rel), ['org/departments.json', 'org/roster.json', 'org/company.md', 'outputs', '.office', '.claude/agents']);
  assert.equal(plan.files, 8);
  const result = migrateLegacy({ program, workspace: ws, date: '2026-10-29' });
  assert.equal(result.moved, true);
  assert.equal(result.backup, join(program, '.office-migrated-2026-10-29'));
  for (const rel of ['org/departments.json', 'outputs/2026-10-29/scan/report.md', 'outputs/2026-10-29/scan/research/research-1-data.csv', '.office/runs/r1.log', '.claude/agents/mine.md']) {
    const a = readFileSync(join(ws, ...rel.split('/')));
    const b = readFileSync(join(result.backup, ...rel.split('/')));
    assert.ok(a.equals(b), rel);
    assert.equal(existsSync(join(program, ...rel.split('/'))), false, `원본 위치에서 옮겨짐: ${rel}`);
  }
  assert.deepEqual(legacyItems(program), [], '이전 뒤에는 호환 모드가 아니다');
  assert.equal(migrateLegacy({ program, workspace: ws }).moved, false);

  // 같은 날 다시 이전하면 보관 폴더 이름이 겹치지 않는다
  seedLegacy(program);
  const ws2 = join(tmp(t, 'office-mws2-'), 'AIOffice');
  assert.equal(migrateLegacy({ program, workspace: ws2, date: '2026-10-29' }).backup, join(program, '.office-migrated-2026-10-29-2'));
});

test('migrate: 작업 공간에 같은 이름의 파일이 있으면 아무것도 바꾸지 않는다', (t) => {
  const program = tmp(t, 'office-mprog-');
  seedLegacy(program);
  const ws = tmp(t, 'office-mws-');
  mkdirSync(join(ws, 'org'));
  writeFileSync(join(ws, 'org', 'roster.json'), '[]');
  mkdirSync(join(ws, '.office'));
  assert.deepEqual(planMigration({ program, workspace: ws }).conflicts, ['org/roster.json']);
  assert.throws(() => migrateLegacy({ program, workspace: ws }), MigrateError);
  assert.equal(readFileSync(join(ws, 'org', 'roster.json'), 'utf8'), '[]');
  assert.equal(existsSync(join(ws, 'outputs')), false);
  assert.ok(existsSync(join(program, 'org', 'departments.json')), '원본은 그대로');
  assert.equal(readdirSync(program).some((n) => n.startsWith('.office-migrated-')), false);
  assert.throws(() => migrateLegacy({ program, workspace: join(program, 'inside') }), WorkspaceError);
});

test('migrate CLI: 확인 없이는 옮기지 않고(호환 모드 유지), --yes면 이전·경로 기억·작업 공간 생성물을 만든다', (t) => {
  const program = copyProgram(t);
  seedLegacy(program);
  const ws = join(tmp(t, 'office-mcli-'), 'Office Space');
  const script = join(program, 'scripts', 'migrate.mjs');
  const env = cleanEnv();
  let res = spawnSync(process.execPath, [script, '--workspace', ws], { env, encoding: 'utf8', input: '' });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /옮기지 않았습니다/);
  assert.ok(existsSync(join(program, 'org', 'roster.json')));
  assert.equal(existsSync(ws), false);

  res = spawnSync(process.execPath, [script, '--workspace', ws, '--dry-run'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /합계: 파일 8개/);
  assert.equal(existsSync(ws), false);

  res = spawnSync(process.execPath, [script, '--workspace', ws, '--yes'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /이전 완료: 파일 8개/);
  assert.deepEqual(JSON.parse(readFileSync(join(program, LOCAL_CONFIG), 'utf8')), { workspace: ws });
  assert.ok(readFileSync(join(ws, '.claude', 'settings.json'), 'utf8').includes(JSON.stringify(join(program, 'hooks', 'chief-guard.mjs')).slice(1, -1)));
  assert.ok(existsSync(join(ws, '.claude', 'agents', 'research-1.md')), '옮긴 정본으로 에이전트 파일을 다시 만든다');
  assert.equal(readFileSync(join(ws, '.claude', 'agents', 'mine.md'), 'utf8'), '내 에이전트(표식 없음)\n');
  // 이제 기본 결정은 기억된 작업 공간이다
  assert.deepEqual((({ path, source, compat }) => ({ path, source, compat }))(resolveWorkspace({ program, env: {} })), { path: ws, source: 'local', compat: false });
});

// ---- 검토 회귀: 이전 뒤 예전 항목 재등장, 서버 실행 중 이전, 끊긴 이전 이어서 하기 ----

test('resolveWorkspace: 기본 작업 공간에 표식이 있으면 레포에 예전 항목이 다시 생겨도 호환 모드로 돌아가지 않는다', (t) => {
  const program = tmp(t, 'office-reprog-');
  const home = tmp(t, 'office-rehome-');
  mkdirSync(join(program, 'outputs', '2026-10-29', 'x'), { recursive: true });
  writeFileSync(join(program, 'outputs', '2026-10-29', 'x', 'brief.md'), '# 레포에서 연 세션의 산출물\n');
  assert.equal(resolveWorkspace({ program, env: {}, homedir: home }).source, 'compat', '표식이 없으면 예전처럼 호환 모드');
  mkdirSync(join(home, 'AIOffice'));
  writeFileSync(join(home, 'AIOffice', WORKSPACE_MARKER), 'ai-office:generated\n');
  const ws = resolveWorkspace({ program, env: {}, homedir: home });
  assert.deepEqual({ path: ws.path, source: ws.source, compat: ws.compat, legacy: ws.legacy }, { path: join(home, 'AIOffice'), source: 'default', compat: false, legacy: ['outputs'] });
});

test('migrate CLI(기본 경로): 이전한 작업 공간을 기억해, 이전 뒤 레포에 산출물이 다시 생겨도 작업 공간을 쓴다', (t) => {
  const program = copyProgram(t);
  seedLegacy(program);
  const home = tmp(t, 'office-mhome-');
  const env = cleanEnv({ HOME: home, USERPROFILE: home });
  const res = spawnSync(process.execPath, [join(program, 'scripts', 'migrate.mjs'), '--yes'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const ws = join(home, 'AIOffice');
  assert.deepEqual(JSON.parse(readFileSync(join(program, LOCAL_CONFIG), 'utf8')), { workspace: ws });
  mkdirSync(join(program, 'outputs', '2026-10-29', 'x'), { recursive: true });
  writeFileSync(join(program, 'outputs', '2026-10-29', 'x', 'brief.md'), '# 다시 생긴 산출물\n');
  const after = resolveWorkspace({ program, env: {}, homedir: home });
  assert.deepEqual({ path: after.path, source: after.source, compat: after.compat, legacy: after.legacy }, { path: ws, source: 'local', compat: false, legacy: ['outputs'] });
  // 기억 파일이 없어져도 표식이 있는 기본 작업 공간을 쓴다
  rmSync(join(program, LOCAL_CONFIG));
  assert.equal(resolveWorkspace({ program, env: {}, homedir: home }).path, ws);
  assert.ok(existsSync(join(ws, 'org', 'departments.json')));
});

test('migrate: 호환 모드 서버가 실행 중이면 거부하고(--force로 무시), 서버를 끄면 표식이 지워져 이전된다', async (t) => {
  const program = copyProgram(t);
  seedLegacy(program);
  const home = tmp(t, 'office-lhome-');
  const ws = join(home, 'AIOffice');
  const publicDir = join(tmp(t, 'office-lpublic-'), 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html>');
  const { startServer } = await import('../dashboard/server.mjs');
  const handle = await startServer({ port: 0, publicDir, quiet: true, program, env: cleanEnv({ HOME: home, USERPROFILE: home, CLAUDE_BIN: join(program, 'none.js'), CODEX_BIN: join(program, 'none.js') }) });
  let closed = false;
  t.after(() => (closed ? undefined : handle.close()));
  assert.equal(handle.compat, true);
  assert.deepEqual(runningServer(program), { pid: process.pid, port: handle.port, host: '127.0.0.1' });

  assert.throws(() => migrateLegacy({ program, workspace: ws }), (err) => err instanceof MigrateError && /서버가 실행 중/.test(err.message) && err.message.includes(String(handle.port)));
  assert.ok(existsSync(join(program, 'org', 'departments.json')), '원본은 그대로');
  assert.equal(existsSync(ws), false, '작업 공간에 아무것도 만들지 않는다');
  const cli = spawnSync(process.execPath, [join(program, 'scripts', 'migrate.mjs'), '--yes'], { env: cleanEnv({ HOME: home, USERPROFILE: home }), encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /서버가 실행 중.*--force|--force/s);
  assert.ok(existsSync(join(program, 'org', 'departments.json')));

  await handle.close();
  closed = true;
  assert.equal(existsSync(join(program, ...SERVER_LOCK.split('/'))), false, 'close가 자기 표식을 지운다');
  const result = migrateLegacy({ program, workspace: ws, date: '2026-10-29' });
  assert.equal(result.moved, true);
  assert.equal(existsSync(join(ws, ...SERVER_LOCK.split('/'))), false);
});

test('server-lock: 종료된 pid의 표식은 무시하고, 다른 서버의 표식은 지우지 않으며, migrate는 표식 파일을 옮기지 않는다', (t) => {
  const root = tmp(t, 'office-lock-');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  mkdirSync(join(root, '.office'));
  writeFileSync(join(root, ...SERVER_LOCK.split('/')), JSON.stringify({ pid: Number(dead.stdout), port: 4777, id: 'old' }));
  assert.equal(runningServer(root), null, '종료된 서버');
  writeFileSync(join(root, ...SERVER_LOCK.split('/')), '{ 깨진');
  assert.equal(runningServer(root), null);
  const releaseA = acquireServerLock(root, { port: 1 });
  const releaseB = acquireServerLock(root, { port: 2 });
  releaseA();
  assert.equal(runningServer(root)?.port, 2, '나중에 시작한 서버의 표식은 남는다');
  releaseB();
  assert.equal(runningServer(root), null);

  // 살아 있는 서버 표식은 이전을 막고 --force(force)로만 무시한다
  const forced = tmp(t, 'office-lockforce-');
  seedLegacy(forced);
  const releaseLive = acquireServerLock(forced, { port: 4777 });
  const forcedWs = join(tmp(t, 'office-lockforcews-'), 'AIOffice');
  assert.throws(() => migrateLegacy({ program: forced, workspace: forcedWs }), /서버가 실행 중/);
  assert.equal(migrateLegacy({ program: forced, workspace: forcedWs, force: true }).moved, true);
  releaseLive();

  // 종료된 서버가 남긴 표식은 이전을 막지 않고 작업 공간으로 따라가지도 않는다
  const program = tmp(t, 'office-lockprog-');
  seedLegacy(program);
  writeFileSync(join(program, ...SERVER_LOCK.split('/')), JSON.stringify({ pid: Number(dead.stdout), port: 4777, id: 'old' }));
  const ws = join(tmp(t, 'office-lockws-'), 'AIOffice');
  assert.equal(migrateLegacy({ program, workspace: ws }).moved, true);
  assert.equal(existsSync(join(ws, ...SERVER_LOCK.split('/'))), false);
  assert.ok(existsSync(join(ws, '.office', 'events.jsonl')));
});

test('migrate 이어서 하기(복사 중 끊김): 같은 복사본은 건너뛰고, 내용이 다른 파일만 충돌로 본다', (t) => {
  const program = tmp(t, 'office-rsprog-');
  seedLegacy(program);
  const ws = join(tmp(t, 'office-rsws-'), 'AIOffice');
  // 끊긴 이전이 남긴 부분 복사본(롤백되지 않음)
  for (const rel of ['org/departments.json', 'outputs/2026-10-29/scan/report.md']) {
    mkdirSync(dirname(join(ws, ...rel.split('/'))), { recursive: true });
    cpSync(join(program, ...rel.split('/')), join(ws, ...rel.split('/')));
  }
  const plan = planMigration({ program, workspace: ws });
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.copied, ['org/departments.json', 'outputs/2026-10-29/scan/report.md']);
  // 크기는 같고 내용이 다른 파일은 충돌
  writeFileSync(join(ws, 'org', 'departments.json'), readFileSync(join(program, 'org', 'departments.json'), 'utf8').replace('리서치부', '마케팅부'));
  assert.deepEqual(planMigration({ program, workspace: ws }).conflicts, ['org/departments.json']);
  assert.throws(() => migrateLegacy({ program, workspace: ws }), MigrateError);
  cpSync(join(program, 'org', 'departments.json'), join(ws, 'org', 'departments.json'));

  const result = migrateLegacy({ program, workspace: ws, date: '2026-10-29' });
  assert.equal(result.moved, true);
  assert.equal(result.resumed, 2);
  assert.equal(result.files, 8);
  for (const rel of ['org/departments.json', 'org/roster.json', 'outputs/2026-10-29/scan/report.md', '.office/runs/r1.log']) {
    assert.ok(readFileSync(join(ws, ...rel.split('/'))).equals(readFileSync(join(result.backup, ...rel.split('/')))), rel);
  }
});

test('migrate 이어서 하기(원본 이동 중 끊김): 작업 공간을 먼저 기억해 호환 모드로 돌아가지 않고, 다시 실행하면 남은 항목을 옮긴다', (t) => {
  const program = tmp(t, 'office-rmprog-');
  seedLegacy(program);
  const home = tmp(t, 'office-rmhome-');
  const ws = join(home, 'AIOffice');
  const outputsSrc = join(program, 'outputs');
  const realRename = fsModule.renameSync;
  fsModule.renameSync = (from, to) => {
    if (from === outputsSrc) throw Object.assign(new Error('강제 종료 흉내'), { code: 'EIO' });
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => migrateLegacy({ program, workspace: ws, date: '2026-10-29' }), (err) => err instanceof MigrateError && /다시 실행하면 이어서/.test(err.message));
  } finally {
    fsModule.renameSync = realRename;
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(join(program, 'org', 'departments.json')), false, 'org 원본은 이미 보관 폴더로');
  assert.ok(existsSync(join(program, '.office-migrated-2026-10-29', 'org', 'departments.json')));
  assert.ok(existsSync(join(program, 'outputs')), 'outputs 원본은 아직 레포에');
  const mid = resolveWorkspace({ program, env: {}, homedir: home });
  assert.deepEqual({ path: mid.path, source: mid.source, compat: mid.compat }, { path: ws, source: 'local', compat: false }, '옮긴 회사 데이터(org)가 있는 작업 공간을 쓴다');
  assert.ok(mid.legacy.includes('outputs'));

  const result = migrateLegacy({ program, workspace: ws, date: '2026-10-29' });
  assert.equal(result.moved, true);
  assert.ok(result.resumed > 0);
  assert.deepEqual(legacyItems(program), []);
  assert.equal(result.backup, join(program, '.office-migrated-2026-10-29-2'));
  assert.ok(existsSync(join(result.backup, 'outputs', '2026-10-29', 'scan', 'report.md')));
  assert.ok(existsSync(join(ws, 'outputs', '2026-10-29', 'scan', 'research', 'research-1-data.csv')));
  assert.ok(existsSync(join(ws, 'org', 'departments.json')));
});

test('.gitignore: .office-local.json과 .office-migrated-*/는 Git에서 제외한다', (t) => {
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO, encoding: 'utf8' });
  if (inRepo.status !== 0) return t.skip('git 저장소가 아님');
  for (const f of [LOCAL_CONFIG, '.office-migrated-2026-10-29/org/roster.json']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', '--', f], { cwd: REPO }).status, 0, f);
  }
});
