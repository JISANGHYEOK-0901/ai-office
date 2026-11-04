// 프로그램 폴더 세션용 요청 구분 스킬: Claude·Codex 사본이 같고, 작업 공간(비서실장)으로는 복사되지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceFiles } from '../lib/workspace.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const claude = readFileSync(join(root, '.claude/skills/office-request/SKILL.md'), 'utf8');
const codex = readFileSync(join(root, '.agents/skills/office-request/SKILL.md'), 'utf8');

test('office-request 스킬은 Claude·Codex가 같은 내용을 쓴다', () => {
  assert.equal(codex, claude, '.agents/skills/office-request/SKILL.md를 .claude 사본과 같게 맞추세요');
  assert.match(claude, /^---\nname: office-request\ndescription: .+\n---\n/);
});

test('office-request 스킬은 현재 안전선(20통·첨부·직접 실무 금지)과 맞고 작업 공간으로 복사되지 않는다', () => {
  for (const rule of [/20통마다/, /직접 하지 않는다/, /첨부/, /초안만/, /끝까지 자동으로/, /원문 그대로 넣기/, /office-ask\.mjs ask/, /대표가 직접 말한 경우에만/]) assert.match(claude, rule);
  assert.ok(![...workspaceFiles({ program: root }).keys()].some((path) => path.includes('office-request')), '비서실장 작업 공간에는 넣지 않는다');
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /office-request/);
});
