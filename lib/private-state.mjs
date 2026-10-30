import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './org.mjs';

export function readPrivate(file, fallback = {}) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}
export function writePrivate(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dirname(file), 0o700);
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
