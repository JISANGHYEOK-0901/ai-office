#!/usr/bin/env node
// CLI가 사용하는 좁은 stdio MCP 브리지. 계정 비밀값은 없고 실행 한 건의 만료되는 권한만 받는다.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { BROWSER_TOOLS } from '../lib/browser-work.mjs';

let permissions = {};
try {
  const index = process.argv.indexOf('--permissions');
  permissions = index >= 0 ? JSON.parse(readFileSync(process.argv[index + 1], 'utf8'))
    : { url: process.env.OFFICE_BROWSER_ENDPOINT, token: process.env.OFFICE_BROWSER_TOKEN };
} catch { /* 권한 파일 오류 원문·내용을 로그에 남기지 않는다. */ }
const endpoint = permissions.url, token = permissions.token;
const input = createInterface({ input: process.stdin });
const send = (id, value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...value }) + '\n');
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!('id' in request)) continue;
  try {
    if (request.method === 'initialize') send(request.id, { result: { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'office_browser', version: '1.0.0' } } });
    else if (request.method === 'ping') send(request.id, { result: {} });
    else if (request.method === 'tools/list') send(request.id, { result: { tools: BROWSER_TOOLS } });
    else if (request.method === 'tools/call') {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/tools$/.test(endpoint || '') || !token) throw new Error('브라우저 업무 연결이 없습니다.');
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request.params), signal: AbortSignal.timeout(90000) });
      if (!response.ok) throw new Error('브라우저 업무 권한이 만료됐습니다.');
      const data = await response.json();
      send(request.id, { result: { content: [{ type: 'text', text: JSON.stringify(data.error ? { error: data.error, code: data.code } : data.result) }], ...(data.error ? { isError: true } : {}) } });
    } else send(request.id, { error: { code: -32601, message: '지원하지 않는 MCP 메서드입니다.' } });
  } catch { send(request.id, { error: { code: -32000, message: '브라우저 업무 연결을 확인해 주세요.' } }); }
}
