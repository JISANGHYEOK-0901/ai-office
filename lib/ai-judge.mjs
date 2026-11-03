// 짧은 판단 한 번(의도 판별 등)을 로그인된 AI CLI에 묻는다. 도구 없이 구조화 응답만 받고, 실패·시간 초과는 null을 돌려준다.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { programRoot } from './paths.mjs';
import { killTree, resolveCommand, spawnCli, writePrompt } from './cli.mjs';

// 실측(haiku): 4.5~13초. 넘기면 규칙 판별로 대신한다
export function createJudge({ env = process.env, spawnImpl, engine = () => 'claude', timeoutMs = 15000 } = {}) {
  return async function judge(schemaName, prompt, { timeout = timeoutMs } = {}) {
    let schema;
    try { schema = JSON.parse(readFileSync(join(programRoot(), 'dashboard', 'schemas', `${schemaName}.json`), 'utf8')); } catch { return null; }
    const which = engine();
    if (!which) return null;
    // 테스트용 가짜 CLI(.js)로는 판별하지 않는다(AI_OFFICE_JUDGE=on이면 예외). 규칙 판별로 대신한다.
    const override = which === 'codex' ? env.CODEX_BIN : env.CLAUDE_BIN;
    if (env.AI_OFFICE_JUDGE === 'off' || /\.(m?js|cjs)$/i.test(override || '') && env.AI_OFFICE_JUDGE !== 'on') return null;
    let cmd, args;
    try {
      if (which === 'codex') {
        cmd = resolveCommand('codex', 'CODEX_BIN', { env });
        args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-c', 'model_reasoning_effort="low"',
          '--output-schema', join(programRoot(), 'dashboard', 'schemas', `${schemaName}.json`), '-'];
      } else {
        cmd = resolveCommand('claude', 'CLAUDE_BIN', { env });
        args = ['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', ''];
      }
    } catch { return null; }
    return new Promise((resolve) => {
      let out = '', done = false, child, timer;
      const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
      // 작업 공간 밖에서 실행해 작업 공간의 수칙·훅을 불러오지 않는다(판별만 하는 짧은 호출)
      try { child = spawnCli(cmd, args, { cwd: tmpdir(), env: { ...env, OFFICE_JUDGE: '1' }, spawnImpl }); } catch { finish(null); return; }
      timer = setTimeout(() => { killTree(child, 'SIGKILL'); finish(null); }, timeout);
      timer.unref?.();
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => { out += chunk; if (out.length > 200000) { killTree(child, 'SIGKILL'); finish(null); } });
      child.on('error', () => finish(null));
      child.on('close', () => finish(parseJudge(out)));
      writePrompt(child, prompt);
    });
  };
}

// claude: {structured_output}, codex: 마지막 agent_message의 JSON
export function parseJudge(out) {
  const text = String(out || '').trim();
  try { const whole = JSON.parse(text); if (whole?.structured_output && typeof whole.structured_output === 'object') return whole.structured_output; } catch { /* 줄 단위 */ }
  let last = null;
  for (const line of text.split('\n')) {
    try {
      const msg = JSON.parse(line);
      if (msg?.structured_output && typeof msg.structured_output === 'object') last = msg.structured_output;
      else if (msg?.item?.type === 'agent_message' && msg.item.text) last = JSON.parse(msg.item.text);
    } catch { /* 무시 */ }
  }
  return last && typeof last === 'object' && !Array.isArray(last) ? last : null;
}
