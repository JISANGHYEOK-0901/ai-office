import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.mjs';

test('계정 API: 최초 저장·수정·해제, 비밀값 비공개와 토큰/Origin 검사를 유지한다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-account-api-')), root = join(temp, 'workspace'); mkdirSync(root);
  const server = await startServer({ root, port: 0, quiet: true, connectionBase: join(temp, 'private'),
    env: { ...process.env, CLAUDE_BIN: join(temp, 'missing-claude'), CODEX_BIN: join(temp, 'missing-codex') } });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { Origin: base, 'X-Office-Token': server.token, 'Content-Type': 'application/json' };
  const request = async (path, method = 'GET', body, auth = headers) => {
    const res = await fetch(base + path, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await request('/api/connections', 'GET', undefined, {})).status, 403);
  const invalid = await request('/api/connections', 'POST', { provider: 'naver', remember: true, username: 'fixture-user', password: 'x'.repeat(1025) });
  assert.equal(invalid.status, 400);
  assert.equal((await request('/api/connections')).data.connections.length, 0);
  const created = await request('/api/connections', 'POST', { provider: 'naver', label: '업무용', remember: true, username: 'fixture-user', password: 'fixture-password' });
  assert.equal(created.status, 200); assert.equal(created.data.hasCredentials, true);
  assert.doesNotMatch(JSON.stringify(created.data), /fixture-user|fixture-password/);
  assert.equal((await request('/api/connections', 'POST', { provider: 'naver' }, { ...headers, Origin: 'https://outside.invalid' })).status, 403);
  const state = await request('/api/state'); assert.doesNotMatch(JSON.stringify(state.data), /fixture-user|fixture-password/);
  assert.equal((await request(`/api/connections/${created.data.id}`, 'PUT', { username: 'fixture-updated', password: 'fixture-new-password' })).status, 200);
  const listed = await request('/api/connections'); assert.equal(listed.data.connections.length, 1); assert.doesNotMatch(JSON.stringify(listed.data), /fixture-updated|fixture-new-password/);
  assert.equal((await request(`/api/connections/${created.data.id}`, 'DELETE')).status, 200);
  assert.equal((await request('/api/connections')).data.connections.length, 0);
});
