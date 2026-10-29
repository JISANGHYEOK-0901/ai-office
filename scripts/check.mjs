#!/usr/bin/env node
// npm run check: 전체 테스트. 셸 문법 없이 Windows·macOS·Linux에서 같게 동작한다.
// 정본·생성물 일치 검사(sync --check)는 사용자 작업 공간(~/AIOffice 등)을 읽게 되므로 여기서 하지 않는다.
// 작업 공간 점검은 npm run sync -- --check로 따로 한다(테스트는 임시 작업 공간으로 같은 경로를 확인한다).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 사용자 셸의 작업 공간 지정이 테스트에 섞이지 않게 뺀다(테스트는 임시 작업 공간을 AI_OFFICE_ROOT로 준다)
const env = { ...process.env };
delete env.AI_OFFICE_WORKSPACE;
delete env.AI_OFFICE_ROOT;
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env }).status ?? 1;

// 폴더 인자는 Node 버전마다 해석이 달라서 테스트 파일을 직접 나열한다
const testDir = join(root, 'test');
const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join(testDir, f));
console.log(`> node --test (${files.length}개 파일)`);
process.exit(run(['--test', ...files]) === 0 ? 0 : 1);
