// 터미널 AI가 로컬 대시보드에 지시를 넣을 때 쓰는 접속 정보(<작업 공간>/.office/dashboard-access.json, 본인만 읽기).
// 서버가 켜질 때 남기고 꺼질 때 지운다. 화면의 지시창과 같은 API로 들어가므로 의도 판별·계획·검토·실행 전 확인이 똑같이 적용된다.
// 대시보드는 원래 같은 PC·같은 사용자 프로그램이 접근할 수 있는 구조다(화면 HTML에도 같은 토큰이 실린다).
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from './private-state.mjs';
import { isPidAlive } from './server-lock.mjs';

export const DASHBOARD_ACCESS = '.office/dashboard-access.json';
const accessFile = (root) => join(root, ...DASHBOARD_ACCESS.split('/'));

// 대시보드가 실행한 AI(비서실장·직원·실행기 하위 실행)는 새 지시를 넣지 못한다. 실행기가 이 표시를 붙인다
export const AI_RUN_MARKERS = ['OFFICE_AI_RUN', 'OFFICE_CHIEF_RUN', 'OFFICE_ORCHESTRATOR_CHILD'];
export const insideOfficeRun = (env = process.env) => AI_RUN_MARKERS.some((name) => Boolean(env[name]));

export function writeDashboardAccess(root, { url, token, pid = process.pid }) {
  const file = accessFile(root), id = randomBytes(8).toString('hex');
  writePrivate(file, { url, token, pid, id, started: new Date().toISOString() });
  return function release() {
    try { if (JSON.parse(readFileSync(file, 'utf8')).id === id) rmSync(file, { force: true }); } catch { /* 이미 없거나 다른 서버의 기록 */ }
  };
}

// 반환: { url, token } 또는 null(서버 꺼짐·기록 없음·깨짐)
export function readDashboardAccess(root) {
  let data;
  try { data = JSON.parse(readFileSync(accessFile(root), 'utf8')); } catch { return null; }
  if (!data || typeof data.url !== 'string' || typeof data.token !== 'string' || !isPidAlive(data.pid)) return null;
  return { url: data.url, token: data.token };
}
