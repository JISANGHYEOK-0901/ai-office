import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.mjs';
import { modelCatalog } from '../lib/models.mjs';
import { saveSettings, loadSettings } from '../lib/settings.mjs';
import { exportOrg, importOrg } from '../lib/org.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-settings-'));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org', 'departments.json'), '[]');
  writeFileSync(join(root, 'org', 'roster.json'), '[]');
  const server = await startServer({ root, port: 0, quiet: true,
    env: { ...process.env, CODEX_BIN: join(root, 'missing-codex'), CLAUDE_BIN: join(root, 'missing-claude'), CODEX_HOME: root } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (method, path, body, auth = true) => {
    const res = await fetch(base + path, { method, headers: {
      ...(auth ? { 'X-Office-Token': server.token, Origin: base } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  return { root, api };
}

test('설정 API: 기본 Codex → Claude 변경·저장·재조회, 인증과 잘못된 조합 검사', async (t) => {
  const { root, api } = await fixture(t);
  const initial = await api('GET', '/api/state');
  assert.deepEqual(initial.data.settings.chief, { engine: 'codex', model: 'gpt-6.1-sol', effort: 'max' });
  assert.ok(initial.data.models.codex.some((m) => m.id === 'gpt-6.1-sol'));
  const chief = { engine: 'claude', model: 'sonnet', effort: 'high' };
  assert.equal((await api('PUT', '/api/settings', { chief }, false)).status, 403);
  assert.equal((await api('PUT', '/api/settings', { chief })).status, 200);
  assert.deepEqual(loadSettings(root).chief, chief);
  assert.deepEqual((await api('GET', '/api/state')).data.settings.chief, chief);
  for (const invalid of [
    { engine: 'claude', model: 'gpt-6.1-sol', effort: 'max' },
    { engine: 'codex', model: 'sonnet', effort: 'max' },
    { engine: 'codex', model: 'gpt-6-luna', effort: 'ultra' },
  ]) assert.equal((await api('PUT', '/api/settings', { chief: invalid })).status, 400);
  assert.deepEqual(loadSettings(root).chief, chief);
  assert.equal(readFileSync(join(root, 'org/roster.json'), 'utf8'), '[]');
});

test('직원 Codex 설정 API: 모델·effort 저장과 빈 값의 부서 기본 상속', async (t) => {
  const { api } = await fixture(t);
  const department = await api('POST', '/api/departments', { id: 'dev', name: '개발부', engine: 'codex', codexRole: 'exec' });
  assert.equal(department.status, 201);
  const create = await api('POST', '/api/agents', { id: 'dev-1', name: '김대리', department: 'dev', codexModel: 'gpt-6-luna', codexEffort: 'medium' });
  assert.equal(create.status, 201);
  assert.equal(create.data.codexModel, 'gpt-6-luna');
  const update = await api('PUT', '/api/agents/dev-1', { codexModel: '', codexEffort: '' });
  assert.equal(update.status, 200);
  assert.ok(!update.data.codexModel);
});

test('모델 목록은 공개 캐시에서 지원 모델·effort만 읽고 없으면 기본 목록을 준다', async (t) => {
  const { root } = await fixture(t);
  writeFileSync(join(root, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
    { slug: 'hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'max' }] },
  ] }));
  const catalog = modelCatalog({ env: { CODEX_HOME: root } });
  assert.deepEqual(catalog.codex.find((m) => m.id === 'gpt-6-luna').efforts, ['low', 'max']);
  assert.ok(!catalog.codex.some((m) => m.id === 'hidden'));
  assert.ok(catalog.codex.some((m) => m.id === 'gpt-6.1-sol'));
});

test('회사 구성 백업에 비서실장 설정을 포함하며 이전 형식도 가져올 수 있다', async (t) => {
  const src = await fixture(t), dst = await fixture(t);
  const chief = { engine: 'codex', model: 'gpt-6-astra', effort: 'high' };
  saveSettings(src.root, { chief });
  const backup = exportOrg(src.root);
  assert.deepEqual(backup.settings.chief, chief);
  await importOrg(dst.root, backup);
  assert.deepEqual(loadSettings(dst.root).chief, chief);
  const old = { version: 1, company: '', departments: [], roster: [] };
  await importOrg(dst.root, old);
  assert.deepEqual(loadSettings(dst.root).chief, chief);
});
