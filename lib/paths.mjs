// 레포 경로와 날짜 계산 공용 함수
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 레포 루트. 테스트나 다른 위치 실행을 위해 AI_OFFICE_ROOT 환경 변수로 바꿀 수 있다.
export function repoRoot() {
  if (process.env.AI_OFFICE_ROOT) return resolve(process.env.AI_OFFICE_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

// 런타임 데이터 폴더(.office). 없으면 만든다.
export function officeDir(root) {
  const dir = join(root, '.office');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 업무 산출물 폴더(outputs). 만들지는 않는다.
export function outputsDir(root) {
  return join(root, 'outputs');
}

// 한국 시간 기준 날짜 YYYY-MM-DD
export function kstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// rename이 Windows에서 EPERM/EBUSY/EACCES로 실패하면 짧은 백오프로 최대 5회 다시 시도한다.
export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { rmSync(from, { force: true }); } catch { /* 임시 파일 정리 실패는 무시 */ }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
