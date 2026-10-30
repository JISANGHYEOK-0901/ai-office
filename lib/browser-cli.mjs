import { join } from 'node:path';
import { programRoot } from './paths.mjs';
import { BROWSER_TOOLS } from './browser-work.mjs';

// 이번에 승인된 외부 작업의 MCP만 자동 허용한다. 전역 CLI 설정·훅 신뢰는 바꾸지 않는다.
export function attachBrowser(spec, browser) {
  if (!browser.permissionsFile) throw new Error('외부 작업의 실행 권한 파일이 없습니다.');
  const args = [join(programRoot(), 'scripts/browser-mcp.mjs'), '--permissions', browser.permissionsFile];
  if (spec.engine === 'codex') {
    const values = { command: process.execPath, args, enabled: true, required: true,
      default_tools_approval_mode: 'approve', enabled_tools: BROWSER_TOOLS.map((t) => t.name) };
    const overrides = Object.entries(values).flatMap(([key, value]) => ['-c', `mcp_servers.office_browser.${key}=${JSON.stringify(value)}`]);
    spec.args.splice(-1, 0, ...overrides);
    spec.args[spec.args.indexOf('-s') + 1] = 'read-only';
  } else {
    if (!spec.agentId || !spec.agentDefinition) throw new Error('외부 브라우저 업무의 담당 직원 지침이 없습니다.');
    const tools = ['Read', 'Glob', 'Grep', ...BROWSER_TOOLS.map((tool) => `mcp__office_browser__${tool.name}`)];
    // --allowedTools만으로는 직원 파일 tools 밖의 MCP가 노출되지 않는다.
    // 정본과 같은 직원 지침을 실행별 정의로 쓰고 이 업무의 좁은 도구 목록만 지정한다.
    spec.args.push('--agents', JSON.stringify({ [spec.agentId]: { ...spec.agentDefinition, tools } }));
    spec.args.push('--mcp-config', JSON.stringify({ mcpServers: { office_browser: { command: process.execPath, args } } }),
      '--strict-mcp-config', '--tools', tools.join(','), '--allowedTools', tools.join(','));
  }
}
