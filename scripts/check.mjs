#!/usr/bin/env node
// npm run check: 정본·생성물 일치 검사 + 전체 테스트. 셸 문법 없이 Windows·macOS·Linux에서 같게 동작한다.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status ?? 1;

console.log('> node scripts/sync-agents.mjs --check');
if (run([join(root, 'scripts', 'sync-agents.mjs'), '--check']) !== 0) process.exit(1);

// 폴더 인자는 Node 버전마다 해석이 달라서 테스트 파일을 직접 나열한다
const testDir = join(root, 'test');
const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join(testDir, f));
console.log(`> node --test (${files.length}개 파일)`);
process.exit(run(['--test', ...files]) === 0 ? 0 : 1);
