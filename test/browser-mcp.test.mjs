import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { programRoot } from '../lib/paths.mjs';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writePrivate } from '../lib/private-state.mjs';

test('stdio MCP: 초기화·도구 목록·실행별 권한으로 도구 호출하며 로그인 값은 노출하지 않는다', async (t) => {
  let called = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).name, 'browser_snapshot'); called = true;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: { url: 'https://example.invalid/' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'office-mcp-permission-')), permissions = join(directory, 'permissions.json');
  writePrivate(permissions, { url: `http://127.0.0.1:${server.address().port}/tools`, token: 'fixture-only' });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [join(programRoot(), 'scripts/browser-mcp.mjs'), '--permissions', permissions], {
    env: { ...process.env, OFFICE_BROWSER_ENDPOINT: '', OFFICE_BROWSER_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', (c) => output += c);
  const done = once(child, 'exit');
  for (const request of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'notifications/initialized' }, { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
  ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
  child.stdin.end(); assert.equal((await done)[0], 0);
  const results = output.trim().split('\n').map(JSON.parse);
  assert.equal(results[0].result.protocolVersion, '2024-11-05');
  assert.ok(results[1].result.tools.some((tool) => tool.name === 'browser_submit'));
  assert.ok(!results[1].result.tools.some((tool) => /cookie|password|evaluate|network/.test(tool.name)));
  assert.equal(JSON.parse(results[2].result.content[0].text).url, 'https://example.invalid/');
  assert.equal(called, true); assert.doesNotMatch(output, /fixture-only/);
});
