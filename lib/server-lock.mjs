// 대시보드 서버 실행 표식(<데이터 위치>/.office/server.lock): 서버가 켜져 있는 동안 pid·포트를 남긴다.
// migrate가 이 표식으로 실행 중인 서버를 알아보고 이전을 거부한다(서버가 옮겨진 원본 자리에 데이터를 다시 쓰는 것을 막는다).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renameWithRetry } from './paths.mjs';

// 데이터 위치 기준 상대경로. migrate는 이 파일을 옮기지 않는다(다른 위치에서 남의 pid로 오인되지 않게)
export const SERVER_LOCK = '.office/server.lock';

const lockFile = (root) => join(root, ...SERVER_LOCK.split('/'));

// pid가 살아 있는가. 신호 0은 존재 확인만 한다(EPERM은 다른 사용자의 살아 있는 프로세스)
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 표식을 남긴다. 반환: 해제 함수(이 서버가 남긴 표식일 때만 지운다)
 * 서버 하나가 여러 번 불러도 되고, 표식을 남기지 못해도 서버 실행은 막지 않는다(호출한 쪽이 경고).
 */
export function acquireServerLock(root, { port, host } = {}) {
  const file = lockFile(root);
  const id = randomBytes(8).toString('hex');
  mkdirSync(join(root, '.office'), { recursive: true });
  const tmp = `${file}.${process.pid}.${id}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, host, id, started: new Date().toISOString() }) + '\n');
  renameWithRetry(tmp, file);
  return function release() {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).id === id) rmSync(file, { force: true });
    } catch { /* 이미 없거나 다른 서버의 표식이면 그대로 둔다 */ }
  };
}

// 실행 중인 서버 표식. 반환: { pid, port, host } 또는 null(표식 없음·깨짐·프로세스 종료)
export function runningServer(root) {
  let data;
  try {
    data = JSON.parse(readFileSync(lockFile(root), 'utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !isPidAlive(data.pid)) return null;
  return { pid: data.pid, port: data.port, host: data.host };
}
