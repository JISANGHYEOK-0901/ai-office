// Windows 동작을 platform 주입으로 고정한다(실제 Windows가 없는 환경에서도 분기·인자·명령을 검사).
// 실제 Windows 실행은 CI(windows-latest)에서 나머지 테스트가 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExecutable, killTree, resolveCommand, spawnCli } from '../lib/cli.mjs';
import { shutdownSignals } from '../dashboard/server.mjs';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'office-win-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const recorder = () => {
  const calls = [];
  const spawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    return { pid: 4242, on() {}, stdin: null };
  };
  return { calls, spawnImpl };
};

test('win32 탐색: PATH는 ;로 나누고 따옴표 친 폴더도 읽으며, PATHEXT 순서로 .cmd shim을 찾는다(Path 키 대소문자 무관)', (t) => {
  const dir = tmp(t);
  const npmDir = join(dir, 'npm global');
  mkdirSync(npmDir);
  writeFileSync(join(npmDir, 'claude.cmd'), '');
  writeFileSync(join(npmDir, 'claude'), ''); // npm이 함께 만드는 sh 스크립트는 Windows에서 실행 대상이 아니다
  const env = { Path: `${join(dir, 'none')};"${npmDir}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(findExecutable('claude', { env, platform: 'win32' }), join(npmDir, 'claude.cmd'));
  // .exe가 같은 폴더에 있으면 PATHEXT 순서상 .exe가 먼저다
  writeFileSync(join(npmDir, 'claude.exe'), '');
  assert.equal(findExecutable('claude', { env, platform: 'win32' }), join(npmDir, 'claude.exe'));
  assert.equal(findExecutable('codex', { env, platform: 'win32' }), null);
});

test('win32 resolveCommand: .cmd/.bat만 shell, .exe와 .js 대체는 셸 없이', (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'codex.cmd'), '');
  writeFileSync(join(dir, 'claude.exe'), '');
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  const codex = resolveCommand('codex', 'CODEX_BIN', { env, platform: 'win32' });
  assert.deepEqual({ command: codex.command, shell: codex.shell }, { command: join(dir, 'codex.cmd'), shell: true });
  const claude = resolveCommand('claude', 'CLAUDE_BIN', { env, platform: 'win32' });
  assert.equal(claude.shell, false);
  const fake = resolveCommand('claude', 'CLAUDE_BIN', { env: { ...env, CLAUDE_BIN: join(dir, 'fake.mjs') }, platform: 'win32' });
  assert.deepEqual({ command: fake.command, shell: fake.shell }, { command: process.execPath, shell: false });
  // macOS에서는 .cmd 이름이어도 셸을 쓰지 않는다
  assert.equal(resolveCommand('codex', 'CODEX_BIN', { env: { ...env, CODEX_BIN: join(dir, 'codex.cmd') }, platform: 'darwin' }).shell, false);
});

test('win32 spawnCli: .cmd는 shell:true + 공백·따옴표 인자 처리, detached 없음, windowsHide', () => {
  const { calls, spawnImpl } = recorder();
  const resolved = { command: 'C:\\Program Files\\nodejs\\codex.cmd', prefixArgs: [], shell: true, display: 'codex' };
  spawnCli(resolved, ['exec', '-C', 'C:\\Users\\Kim Dev\\ai-office', '-c', 'model_reasoning_effort="max"', '--allowedTools', 'Read,Bash(git:*)', '-'], { cwd: 'C:\\x', spawnImpl, platform: 'win32' });
  const { command, args, opts } = calls[0];
  assert.equal(command, '"C:\\Program Files\\nodejs\\codex.cmd"');
  assert.deepEqual(args, ['exec', '-C', '"C:\\Users\\Kim Dev\\ai-office"', '-c', '"model_reasoning_effort=""max"""', '--allowedTools', '"Read,Bash(git:*)"', '-']);
  assert.equal(opts.shell, true);
  assert.equal(opts.detached, undefined, 'Windows에서는 detached로 띄우지 않는다(새 콘솔 창 방지)');
  assert.equal(opts.windowsHide, true);

  // .exe는 인자를 그대로 배열로 넘기고 셸을 쓰지 않는다
  spawnCli({ command: 'C:\\bin\\claude.exe', prefixArgs: [], shell: false }, ['-p', '--agent', 'research-1'], { spawnImpl, platform: 'win32' });
  assert.deepEqual({ command: calls[1].command, args: calls[1].args, shell: calls[1].opts.shell }, { command: 'C:\\bin\\claude.exe', args: ['-p', '--agent', 'research-1'], shell: undefined });
  // POSIX는 프로세스 그룹을 위해 detached
  spawnCli({ command: '/usr/local/bin/claude', prefixArgs: [], shell: false }, ['-p'], { spawnImpl, platform: 'darwin' });
  assert.equal(calls[2].opts.detached, true);
});

test('win32 killTree: SIGTERM·SIGKILL 모두 taskkill /PID <pid> /T /F로 트리 종료(신호 미지원이어도 오류 없음)', () => {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    const { calls, spawnImpl } = recorder();
    let killed = null;
    const child = { pid: 1234, kill: (s) => { killed = s; } };
    killTree(child, sig, { platform: 'win32', spawnImpl });
    assert.deepEqual(calls.map((c) => [c.command, c.args]), [['taskkill', ['/PID', '1234', '/T', '/F']]]);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(killed, null, 'taskkill이 성공적으로 시작되면 child.kill을 부르지 않는다');
  }
  // taskkill을 띄우지 못하면 child.kill로 대신한다
  let killed = null;
  killTree({ pid: 5, kill: (s) => { killed = s; } }, 'SIGTERM', { platform: 'win32', spawnImpl: () => { throw new Error('ENOENT'); } });
  assert.equal(killed, 'SIGTERM');
  // pid가 없으면(spawn 실패) taskkill 없이 child.kill만
  const { calls, spawnImpl } = recorder();
  killTree({ pid: undefined, kill() {} }, 'SIGTERM', { platform: 'win32', spawnImpl });
  assert.equal(calls.length, 0);
});

test('서버 종료 신호: Windows는 SIGBREAK·SIGHUP(콘솔 닫기)도 정리, POSIX는 nohup을 깨지 않게 SIGHUP 제외', () => {
  assert.deepEqual(shutdownSignals('win32'), ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  assert.deepEqual(shutdownSignals('darwin'), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(shutdownSignals('linux'), ['SIGINT', 'SIGTERM']);
  // 현재 OS의 신호 목록은 리스너 등록이 오류 없이 된다
  for (const sig of shutdownSignals()) {
    const fn = () => {};
    process.on(sig, fn);
    process.off(sig, fn);
  }
});
