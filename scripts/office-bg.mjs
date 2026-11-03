#!/usr/bin/env node
// 대시보드 서버를 터미널·AI 세션과 분리해서 켜고 끈다.
//   node scripts/office-bg.mjs start [서버 옵션…]   (npm run office:start)
//   node scripts/office-bg.mjs stop                  (npm run office:stop)
//   node scripts/office-bg.mjs status                (npm run office:status)
// Claude Code·Codex는 세션이 끝날 때 자신이 띄운 프로세스를 정리하므로, 대표가 "서버 켜줘"라고 하면 이 명령을 쓴다.
// 서버 출력은 프로그램 폴더의 .office/server.log(Git 제외)에 이어서 남긴다.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { programRoot, resolveWorkspace } from '../lib/paths.mjs';
import { isPidAlive, runningServer } from '../lib/server-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', 'dashboard', 'server.mjs');
const START_TIMEOUT_MS = Number(process.env.AI_OFFICE_START_TIMEOUT_MS) || 30000;
const STOP_TIMEOUT_MS = 10000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 서버에 넘길 --workspace 값(있으면 그 작업 공간의 실행 표식을 본다)
function workspaceArg(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace') return args[i + 1] ?? null;
    if (args[i].startsWith('--workspace=')) return args[i].slice('--workspace='.length);
  }
  return null;
}

function dataRoot(args) {
  return resolveWorkspace({ workspace: workspaceArg(args) }).path;
}

function urlOf(info) {
  const host = !info.host || info.host === '0.0.0.0' || info.host === '::' ? '127.0.0.1' : info.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${info.port}/`;
}

function readFrom(file, offset) {
  try {
    return readFileSync(file, 'utf8').slice(offset);
  } catch {
    return '';
  }
}

async function start(args) {
  const root = dataRoot(args);
  const running = runningServer(root);
  if (running) {
    console.log(`이미 실행 중입니다: ${urlOf(running)} (pid ${running.pid})`);
    return 0;
  }
  const logDir = process.env.AI_OFFICE_BG_LOG_DIR ? resolve(process.env.AI_OFFICE_BG_LOG_DIR) : join(programRoot(), '.office');
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, 'server.log');
  const fd = openSync(log, 'a');
  let offset = 0;
  try { offset = statSync(log).size; } catch { /* 새 파일 */ }
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: programRoot(),
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  closeSync(fd);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const info = runningServer(root);
    if (info && info.pid === child.pid) {
      const out = readFrom(log, offset);
      const url = out.match(/AI Office 대시보드[^:]*: (\S+)/)?.[1] ?? urlOf(info);
      console.log(`AI Office 서버를 켰습니다: ${url}`);
      console.log('터미널이나 AI 창을 닫아도 서버는 계속 켜져 있습니다. 끌 때는 npm run office:stop');
      console.log(`서버 기록: ${log}`);
      return 0;
    }
    if (!isPidAlive(child.pid)) break;
  }
  const out = readFrom(log, offset).trim();
  console.error('서버를 켜지 못했습니다.' + (out ? `\n${out.split('\n').slice(-15).join('\n')}` : ''));
  if (isPidAlive(child.pid)) console.error(`서버 프로세스(pid ${child.pid})가 아직 준비되지 않았습니다. 잠시 뒤 npm run office:status로 확인하세요.`);
  return 1;
}

async function stop(args) {
  const root = dataRoot(args);
  const info = runningServer(root);
  if (!info) {
    console.log('실행 중인 AI Office 서버가 없습니다.');
    return 0;
  }
  if (process.platform === 'win32') {
    // 실행 중인 AI 작업(자식 프로세스)까지 함께 정리한다
    spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch (err) {
      if (err.code === 'EPERM') {
        console.error(`서버(pid ${info.pid})를 끌 권한이 없습니다. 서버를 켠 사용자 권한으로 실행하세요(Codex라면 샌드박스 밖 실행 승인이 필요합니다).`);
        return 1;
      }
    }
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isPidAlive(info.pid)) await sleep(200);
  if (isPidAlive(info.pid)) {
    try { process.kill(info.pid, 'SIGKILL'); } catch { /* 이미 종료 */ }
    await sleep(300);
  }
  if (isPidAlive(info.pid)) {
    console.error(`서버(pid ${info.pid})를 끄지 못했습니다.`);
    return 1;
  }
  console.log(`AI Office 서버를 껐습니다 (${urlOf(info)}).`);
  return 0;
}

function status(args) {
  const info = runningServer(dataRoot(args));
  console.log(info ? `실행 중: ${urlOf(info)} (pid ${info.pid})` : '꺼져 있습니다.');
  return 0;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'start') return await start(args);
    if (command === 'stop') return await stop(args);
    if (command === 'status') return status(args);
    console.error('사용법: node scripts/office-bg.mjs start|stop|status [서버 옵션…]');
    return 1;
  } catch (err) {
    console.error(`오류: ${err.message}`);
    return 1;
  }
}

process.exitCode = await main();
