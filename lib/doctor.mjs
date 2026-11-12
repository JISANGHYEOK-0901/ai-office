// 실행 환경 점검(npm run doctor)과 서버 시작 때의 빠른 점검(설치 여부만)
// 인증 정보·이메일은 출력하지 않는다. claude auth status는 loggedIn·authMethod만, codex login status는 로그인 여부만 쓴다.
import net from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findExecutable, killTree, resolveCommand, spawnCli } from './cli.mjs';
import { WORKSPACE_SOURCE_LABEL, programRoot, resolveWorkspace } from './paths.mjs';
import { findSoffice } from './doc-preview.mjs';
import { planMigration } from './migrate.mjs';
import { asideAdvice, createAside } from './aside.mjs';
import { loadOrg } from './org.mjs';

export const DEFAULT_PORT = 4777;
export const COMMAND_TIMEOUT_MS = 5000;
export const MIN_NODE_MAJOR = 20;
// 있으면 구독 대신 API 과금(또는 다른 제공자)으로 실행될 수 있는 환경변수. 값은 절대 출력하지 않는다
export const BILLING_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

const TOOLS = {
  claude: { envVar: 'CLAUDE_BIN', label: 'claude' },
  codex: { envVar: 'CODEX_BIN', label: 'codex' },
};

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// claude·codex 실행 파일 위치. CLAUDE_BIN/CODEX_BIN 대체(.js/.mjs면 node로 실행)를 반영한다.
// 반환: { installed, resolved }
export function locateTool(name, { env = process.env, platform = process.platform } = {}) {
  const { envVar } = TOOLS[name];
  const resolved = resolveCommand(name, envVar, { env, platform });
  const installed = resolved.prefixArgs.length
    ? isFile(resolved.prefixArgs[0])
    : Boolean(findExecutable(env[envVar] || name, { env, platform }));
  return { installed, resolved };
}

// 서버 시작 때 쓰는 빠른 점검: 프로세스를 띄우지 않고 설치 여부만 본다
export function quickToolCheck(opts = {}) {
  return {
    claude: { installed: locateTool('claude', opts).installed },
    codex: { installed: locateTool('codex', opts).installed },
  };
}

export function detectedMode(tools) {
  const available = (tool) => tool?.installed === true && tool.loggedIn === true;
  const claude = available(tools?.claude), codex = available(tools?.codex);
  return claude && codex ? 'mixed' : claude ? 'claude' : codex ? 'codex' : 'none';
}

export async function checkToolLogins({ env = process.env, platform = process.platform, timeoutMs = COMMAND_TIMEOUT_MS, signal } = {}) {
  const pairs = await Promise.all(['claude', 'codex'].map(async (name) => {
    const { installed, resolved } = locateTool(name, { env, platform });
    if (!installed) return [name, { installed: false, loggedIn: false }];
    const result = await runCapture(resolved, name === 'claude' ? ['auth', 'status'] : ['login', 'status'], { env, timeoutMs, signal });
    const loggedIn = result.timedOut || result.error ? null
      : name === 'claude' ? parseClaudeAuth(result.stdout).loggedIn : parseCodexLogin(result);
    return [name, { installed, loggedIn }];
  }));
  return Object.fromEntries(pairs);
}

// CLI를 띄워 출력을 모은다. timeoutMs가 지나면 프로세스 트리를 끝내고 timedOut: true
// 반환: { code, stdout, stderr, timedOut, error }
export function runCapture(resolved, args, { env = process.env, timeoutMs = COMMAND_TIMEOUT_MS, cwd, signal } = {}) {
  return new Promise((resolveRun) => {
    if (signal?.aborted) { resolveRun({ code: null, stdout: '', stderr: '', timedOut: true, error: null }); return; }
    let child;
    try {
      child = spawnCli(resolved, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolveRun({ code: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolveRun({ stdout, stderr, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
      finish({ code: null, error: null });
    }, timeoutMs);
    const abort = () => {
      timedOut = true;
      killTree(child, 'SIGKILL');
      finish({ code: null, error: null });
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < 65536) stderr += d; });
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code) => finish({ code, error: null }));
  });
}

// claude auth status 출력에서 loggedIn·authMethod만 꺼낸다. 다른 필드(email 등)는 버린다.
// 반환: { loggedIn: true|false|null, authMethod: string|null }
export function parseClaudeAuth(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { loggedIn: null, authMethod: null };
  let data;
  try {
    data = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { loggedIn: null, authMethod: null };
  }
  const loggedIn = typeof data?.loggedIn === 'boolean' ? data.loggedIn : null;
  // 방식 이름만 허용한다(예: claude.ai, console, apiKey). 형식이 다르면 버린다
  const authMethod = typeof data?.authMethod === 'string' && /^[A-Za-z0-9._ -]{1,40}$/.test(data.authMethod) ? data.authMethod : null;
  return { loggedIn, authMethod };
}

// codex login status: 종료 코드 0이고 "not logged in" 류 문구가 없으면 로그인됨. 출력 원문은 쓰지 않는다
export function parseCodexLogin({ code, stdout, stderr }) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  if (/not\s+logged\s+in|logged\s+out/i.test(text)) return false;
  return code === 0;
}

// Git for Windows의 bash.exe. CLAUDE_CODE_GIT_BASH_PATH가 있으면 그 값을 먼저 본다.
// System32의 bash.exe(WSL)는 Git Bash가 아니라서 제외한다. 반환: 경로 또는 null
export function findGitBash({ env = process.env, platform = process.platform } = {}) {
  const explicit = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (explicit && isFile(explicit)) return resolve(explicit);
  if (platform !== 'win32') return null;
  const candidates = [];
  const git = findExecutable('git', { env, platform });
  // git.exe는 보통 <Git>\cmd\git.exe 또는 <Git>\bin\git.exe에 있다
  if (git) candidates.push(join(dirname(dirname(git)), 'bin', 'bash.exe'), join(dirname(git), 'bash.exe'));
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
  }
  return candidates.find((p) => isFile(p) && !/[\\/]system32[\\/]/i.test(p)) ?? null;
}

// 포트를 잠깐 열어 보고 닫는다. 반환: { available, code }
export function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolvePort) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolvePort({ available: false, code: err.code || 'ERROR' }));
    srv.listen(port, host, () => srv.close(() => resolvePort({ available: true, code: null })));
  });
}

const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 80) ?? '';

const LEGACY_ARCHIVE_NOTE = '아무것도 바꾸지 않고 대상과 충돌 파일을 보여 줍니다. 쓰고 있는 작업 공간이면 덮어쓰거나 합치지 말고, 대시보드 서버를 끈 뒤 위 항목을 프로그램 폴더 밖의 새 폴더로 옮겨 보관하세요';

// OS별 해결 명령. win32는 PowerShell 기준, 그 밖(macOS·Linux)은 macOS 기준 셸 명령
const FIX = {
  node: {
    darwin: ['brew install node', '또는 https://nodejs.org 에서 LTS 설치 파일을 받습니다'],
    win32: ['winget install OpenJS.NodeJS.LTS', '또는 https://nodejs.org 에서 LTS 설치 파일을 받습니다'],
  },
  claudeInstall: {
    darwin: ['npm install -g @anthropic-ai/claude-code', '설치 후 새 터미널을 열고 claude --version 으로 확인합니다'],
    win32: ['npm install -g @anthropic-ai/claude-code', '설치 후 새 PowerShell 창을 열고 claude --version 으로 확인합니다'],
  },
  claudeLogin: {
    darwin: ['claude auth login', '브라우저가 열리면 본인 Claude 구독 계정으로 로그인합니다(claude 실행 중이면 /login)'],
    win32: ['claude auth login', '브라우저가 열리면 본인 Claude 구독 계정으로 로그인합니다(claude 실행 중이면 /login)'],
  },
  claudeUpdate: {
    darwin: ['npm install -g @anthropic-ai/claude-code', '최신 버전으로 올린 뒤 claude auth status 로 확인합니다'],
    win32: ['npm install -g @anthropic-ai/claude-code', '최신 버전으로 올린 뒤 claude auth status 로 확인합니다'],
  },
  codexInstall: {
    darwin: ['npm install -g @openai/codex', '설치 후 새 터미널을 열고 codex --version 으로 확인합니다'],
    win32: ['npm install -g @openai/codex', '설치 후 새 PowerShell 창을 열고 codex --version 으로 확인합니다'],
  },
  codexLogin: {
    darwin: ['codex login', '본인 ChatGPT 계정으로 로그인합니다'],
    win32: ['codex login', '본인 ChatGPT 계정으로 로그인합니다'],
  },
  gitBash: {
    win32: ['winget install Git.Git', '선택 사항입니다. 다른 위치에 설치했다면 CLAUDE_CODE_GIT_BASH_PATH 환경변수로 bash.exe 경로를 지정합니다'],
  },
  migrate: {
    darwin: ['npm run migrate', '대시보드 서버를 끈 뒤 실행합니다. 복사·검증 후 원본은 프로그램 폴더의 .office-migrated-<날짜>/에 보관됩니다'],
    win32: ['npm run migrate', '대시보드 서버를 끈 뒤 실행합니다. 복사·검증 후 원본은 프로그램 폴더의 .office-migrated-<날짜>/에 보관됩니다'],
  },
  // 작업 공간에 같은 이름의 다른 파일이 있어 migrate가 거부하는 경우. 이미 쓰는 작업 공간의 데이터를 덮거나 합치지 않게 보관을 안내한다
  legacyArchive: {
    darwin: ['npm run migrate -- --dry-run', LEGACY_ARCHIVE_NOTE],
    win32: ['npm run migrate -- --dry-run', LEGACY_ARCHIVE_NOTE],
  },
  workspace: {
    darwin: ['npm run office -- --workspace ~/AIOffice', '프로그램 폴더 밖의 경로를 고릅니다. 고른 경로는 .office-local.json에 기억됩니다'],
    win32: ['npm run office -- --workspace $env:USERPROFILE\\AIOffice', '프로그램 폴더 밖의 경로를 고릅니다. 고른 경로는 .office-local.json에 기억됩니다'],
  },
  officeDocs: {
    darwin: ['npm ci', '프로그램 폴더에서 실행합니다. PowerPoint·Word·Excel 제작에 씁니다'],
    win32: ['npm ci', '프로그램 폴더에서 실행합니다. PowerPoint·Word·Excel 제작에 씁니다'],
  },
  officePreview: {
    darwin: ['brew install --cask libreoffice && brew install poppler', '선택 사항입니다. 없어도 문서는 만들어지지만 직원이 결과를 화면으로 확인하지 못합니다'],
    win32: ['winget install TheDocumentFoundation.LibreOffice', '선택 사항입니다. 없어도 문서는 만들어지지만 직원이 결과를 화면으로 확인하지 못합니다'],
  },
  // Aside(브라우저 업무 권장). 앱 설치 후 CLI를 설치한다(공식 문서 https://docs.aside.com/help/developers.md)
  asideInstall: {
    darwin: ['brew install --cask aside && curl -fsSL https://releases.aside.com/install.sh | bash', 'Homebrew가 없으면 https://aside.com/download 에서 앱을 받고, 앱의 Settings → Developer에서 CLI를 설치합니다. 앱에서 Aside 계정 로그인 → Settings → Models에서 Claude 또는 ChatGPT 구독 연결 → 업무 사이트 로그인(GUIDE.html "Aside 설치·세팅")'],
    win32: ['https://aside.com/download 에서 Windows 설치 파일을 받아 설치합니다', 'CLI는 앱의 Settings → Developer에서 설치하거나 https://docs.aside.com/help/developers.md 의 PowerShell 명령을 씁니다. 설치 후 새 PowerShell 창에서 aside --version 으로 확인합니다(GUIDE.html "Aside 설치·세팅")'],
  },
  asideLogin: {
    darwin: ['Aside 앱 → Settings → Account에서 로그인', '로그인 후 Settings → Models → Providers에서 Claude 또는 ChatGPT 구독을 연결합니다'],
    win32: ['Aside 앱 → Settings → Account에서 로그인', '로그인 후 Settings → Models → Providers에서 Claude 또는 ChatGPT 구독을 연결합니다'],
  },
  asideEngine: {
    darwin: ['대시보드 → 직원 편집 → 엔진: Aside', '브라우저 업무(메일·카페·사이트 조회)를 맡는 직원만 바꾸면 됩니다. 문서 작성·공개 웹 조사 직원은 그대로 둡니다'],
    win32: ['대시보드 → 직원 편집 → 엔진: Aside', '브라우저 업무(메일·카페·사이트 조회)를 맡는 직원만 바꾸면 됩니다. 문서 작성·공개 웹 조사 직원은 그대로 둡니다'],
  },
  port: {
    darwin: ['lsof -nP -iTCP:4777 -sTCP:LISTEN', '이미 대시보드가 켜져 있을 수 있습니다. 다른 포트로 띄우려면 node dashboard/server.mjs --port 4800'],
    win32: ['Get-NetTCPConnection -LocalPort 4777 -State Listen | Select-Object OwningProcess', '이미 대시보드가 켜져 있을 수 있습니다. 다른 포트로 띄우려면 node dashboard/server.mjs --port 4800'],
  },
};

function envFix(names, platform) {
  if (platform === 'win32') {
    return [
      names.map((n) => `Remove-Item Env:${n}`).join('; '),
      `현재 창에서만 지웁니다. 영구 설정이면 [Environment]::SetEnvironmentVariable('${names[0]}', $null, 'User') 처럼 사용자 환경변수에서도 지웁니다`,
    ];
  }
  return [`unset ${names.join(' ')}`, '현재 터미널에서만 지웁니다. ~/.zshrc 등 셸 설정 파일에 있으면 그 줄도 지웁니다'];
}

function fixFor(key, platform, port) {
  const table = FIX[key];
  if (!table) return null;
  const os = platform === 'win32' ? 'win32' : 'darwin';
  const entry = table[os];
  if (!entry) return null;
  const [command, note] = entry;
  const swap = (s) => (port && port !== DEFAULT_PORT ? s.replaceAll(String(DEFAULT_PORT), String(port)) : s);
  return { os: os === 'win32' ? 'Windows PowerShell' : 'macOS', command: key === 'port' ? swap(command) : command, note };
}

// 선택 도구(없어도 대시보드는 뜨지만 일부 기능을 못 씀). 출력에 '(선택)'을 붙인다
const OPTIONAL_IDS = new Set(['codex', 'codex-auth', 'git-bash', 'office-preview', 'aside']);
const check = (id, label, status, required, message, extra = {}) => ({ id, label, status, required, optional: OPTIONAL_IDS.has(id), message, ...extra });

// 전체 점검. 반환: { ok, platform, checks:[{id, label, status:'ok'|'fail'|'warn', required, message, fix?, ...}] }
// ok는 필수 항목(Node 버전, claude 설치·로그인)이 모두 통과했을 때 true
// Aside 점검: 설치·실행·로그인과 브라우저 업무 직원 권장. 앱이 꺼져 있으면 띄우지 않고 설치만 본다(업무 때 CLI가 자동으로 켠다)
export async function asideCheck({ env = process.env, platform = process.platform, program = programRoot(), aside = createAside({ env, platform }) } = {}) {
  let advice = null;
  try { const ws = resolveWorkspace({ env, program }); advice = asideAdvice({ org: loadOrg(ws.path), root: ws.path, installed: aside.installed() }); } catch { advice = null; }
  const status = await aside.status().catch(() => ({ installed: aside.installed(), running: false, signedIn: null }));
  if (!status.installed) return { ...check('aside', 'Aside(브라우저 업무 권장)', 'warn', false, `없음 — ${advice?.message || '브라우저 업무는 Aside 직원을 권장합니다. 없으면 기존 브라우저(Playwright)로 실행합니다.'}`), fixKey: 'asideInstall', advice };
  if (status.running && status.signedIn === false) return { ...check('aside', 'Aside(브라우저 업무 권장)', 'warn', false, '설치됨 — Aside 계정에 로그인하지 않았습니다'), fixKey: 'asideLogin', advice };
  const base = status.running ? `설치됨·실행 중${status.signedIn ? '·로그인됨' : ''}` : '설치됨(꺼져 있음: 업무 때 자동으로 켜집니다)';
  if (advice && advice.level === 'warn' || advice?.level === 'info') return { ...check('aside', 'Aside(브라우저 업무 권장)', 'warn', false, `${base} — ${advice.message}`), fixKey: 'asideEngine', advice };
  return { ...check('aside', 'Aside(브라우저 업무 권장)', 'ok', false, `${base}${advice?.message ? ` — ${advice.message}` : ''}`), advice };
}

export async function runDoctor({ env = process.env, platform = process.platform, port = DEFAULT_PORT, nodeVersion = process.versions.node, timeoutMs = COMMAND_TIMEOUT_MS, program = programRoot(), aside = null } = {}) {
  const checks = [];
  const withFix = (c, key) => {
    if (c.status !== 'ok') {
      const fix = fixFor(key, platform, port);
      if (fix) c.fix = fix;
    }
    return c;
  };

  const major = Number(String(nodeVersion).split('.')[0]);
  checks.push(withFix(major >= MIN_NODE_MAJOR
    ? check('node', 'Node.js', 'ok', true, `${nodeVersion} (${MIN_NODE_MAJOR} 이상 필요)`, { version: nodeVersion })
    : check('node', 'Node.js', 'fail', true, `${nodeVersion} — ${MIN_NODE_MAJOR} 이상이 필요합니다`, { version: nodeVersion }), 'node'));

  checks.push(workspaceCheck({ env, program, withFix }));

  const claudeTask = (async () => {
    const out = [];
    const { installed, resolved } = locateTool('claude', { env, platform });
    if (!installed) {
      out.push(withFix(check('claude', 'claude 설치', 'fail', true, 'claude(Claude Code)를 찾지 못했습니다'), 'claudeInstall'));
      out.push(check('claude-auth', 'claude 로그인', 'fail', true, 'claude가 없어 확인하지 못했습니다'));
      return out;
    }
    const ver = await runCapture(resolved, ['--version'], { env, timeoutMs });
    const version = firstLine(ver.stdout) || firstLine(ver.stderr);
    if (ver.code === 0 && version) {
      out.push(check('claude', 'claude 설치', 'ok', true, version, { version }));
    } else {
      const why = ver.timedOut ? `${timeoutMs / 1000}초 안에 응답하지 않았습니다` : '실행하지 못했습니다';
      out.push(withFix(check('claude', 'claude 설치', 'fail', true, `claude --version ${why}`), 'claudeInstall'));
    }
    const auth = await runCapture(resolved, ['auth', 'status'], { env, timeoutMs });
    const { loggedIn, authMethod } = parseClaudeAuth(auth.stdout);
    if (loggedIn === true) {
      out.push(check('claude-auth', 'claude 로그인', 'ok', true, `로그인됨${authMethod ? ` (방식: ${authMethod})` : ''}`, { loggedIn, authMethod }));
    } else if (loggedIn === false) {
      out.push(withFix(check('claude-auth', 'claude 로그인', 'fail', true, '로그인되어 있지 않습니다', { loggedIn, authMethod: null }), 'claudeLogin'));
    } else {
      const why = auth.timedOut ? `${timeoutMs / 1000}초 안에 응답하지 않았습니다` : '결과를 읽지 못했습니다(구버전일 수 있음)';
      out.push(withFix(check('claude-auth', 'claude 로그인', 'warn', true, `claude auth status ${why}. 터미널에서 claude를 실행해 로그인 상태를 직접 확인하세요`, { loggedIn: null, authMethod: null }), 'claudeUpdate'));
    }
    return out;
  })();

  const codexTask = (async () => {
    const out = [];
    const { installed, resolved } = locateTool('codex', { env, platform });
    if (!installed) {
      out.push(withFix(check('codex', 'codex 설치', 'fail', false, 'codex를 찾지 못했습니다 — 검증실(Codex 검토)을 실행할 수 없습니다'), 'codexInstall'));
      out.push(check('codex-auth', 'codex 로그인', 'fail', false, 'codex가 없어 확인하지 못했습니다'));
      return out;
    }
    const ver = await runCapture(resolved, ['--version'], { env, timeoutMs });
    const version = firstLine(ver.stdout) || firstLine(ver.stderr);
    if (ver.code === 0 && version) {
      out.push(check('codex', 'codex 설치', 'ok', false, version, { version }));
    } else {
      const why = ver.timedOut ? `${timeoutMs / 1000}초 안에 응답하지 않았습니다` : '실행하지 못했습니다';
      out.push(withFix(check('codex', 'codex 설치', 'fail', false, `codex --version ${why}`), 'codexInstall'));
    }
    const login = await runCapture(resolved, ['login', 'status'], { env, timeoutMs });
    if (login.timedOut) {
      out.push(withFix(check('codex-auth', 'codex 로그인', 'warn', false, `codex login status가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다`, { loggedIn: null }), 'codexLogin'));
    } else if (parseCodexLogin(login)) {
      out.push(check('codex-auth', 'codex 로그인', 'ok', false, '로그인됨', { loggedIn: true }));
    } else {
      out.push(withFix(check('codex-auth', 'codex 로그인', 'fail', false, '로그인되어 있지 않습니다 — 검증실(Codex 검토)을 실행할 수 없습니다', { loggedIn: false }), 'codexLogin'));
    }
    return out;
  })();

  const portTask = checkPort(port);
  const asideTask = asideCheck({ env, platform, program, ...(aside ? { aside } : {}) }).catch(() => null);
  const [claudeChecks, codexChecks, portResult, asideResult] = await Promise.all([claudeTask, codexTask, portTask, asideTask]);
  checks.push(...claudeChecks, ...codexChecks);
  if (asideResult) { const { fixKey, ...item } = asideResult; checks.push(fixKey ? withFix(item, fixKey) : item); }
  const ready = (list) => list.some((c) => c.id.endsWith('-auth') && c.loggedIn === true);
  const hasClaude = ready(claudeChecks), hasCodex = ready(codexChecks);
  for (const item of [...claudeChecks, ...codexChecks]) { item.required = false; item.optional = true; }
  checks.push(check('ai-login', 'AI 로그인', hasClaude || hasCodex ? 'ok' : 'fail', true,
    hasCodex && !hasClaude ? 'Codex 전용 모드로 실행됩니다' : hasClaude || hasCodex ? '로그인된 AI 도구를 사용할 수 있습니다' : 'Claude 또는 Codex 중 하나에 로그인해 주세요'));

  const present = BILLING_ENV_VARS.filter((n) => typeof env[n] === 'string' && env[n] !== '');
  if (present.length) {
    const c = check('api-env', 'API 키 환경변수', 'warn', false, `${present.join(', ')} 설정됨 — 구독 대신 API 과금(또는 Bedrock·Vertex)으로 실행될 수 있습니다`, { names: present });
    const [command, note] = envFix(present, platform);
    c.fix = { os: platform === 'win32' ? 'Windows PowerShell' : 'macOS', command, note };
    checks.push(c);
  } else {
    checks.push(check('api-env', 'API 키 환경변수', 'ok', false, '없음(구독 로그인으로 실행)', { names: [] }));
  }

  if (platform === 'win32') {
    const bash = findGitBash({ env, platform });
    checks.push(withFix(bash
      ? check('git-bash', 'Git for Windows', 'ok', false, '있음(선택 사항)')
      : check('git-bash', 'Git for Windows', 'warn', false, '없음 — 선택 사항이라 없어도 대시보드·훅은 동작합니다'), 'gitBash'));
  }

  // 문서 제작 라이브러리는 package.json 의존성이라 npm ci로 들어온다
  const missingDocs = ['pptxgenjs', 'docx', 'exceljs', 'jszip'].filter((name) => !existsSync(join(program, 'node_modules', name, 'package.json')));
  checks.push(withFix(missingDocs.length
    ? check('office-docs', '문서 제작 라이브러리', 'warn', false, `없음(${missingDocs.join(', ')}) — PowerPoint·Word·Excel을 만들지 못할 수 있습니다`)
    : check('office-docs', '문서 제작 라이브러리', 'ok', false, 'PowerPoint·Word·Excel 제작 가능'), 'officeDocs'));
  checks.push(withFix(findSoffice({ env, platform })
    ? check('office-preview', '문서 화면 확인(LibreOffice)', 'ok', false, '있음(선택 사항)')
    : check('office-preview', '문서 화면 확인(LibreOffice)', 'warn', false, '없음 — 선택 사항입니다. 직원이 만든 문서를 화면으로 확인하지 못합니다'), 'officePreview'));

  checks.push(withFix(portResult.available
    ? check('port', `포트 ${port}`, 'ok', false, '사용 가능')
    : check('port', `포트 ${port}`, 'warn', false, portResult.code === 'EADDRINUSE' ? '다른 프로그램이 사용 중입니다' : `열 수 없습니다(${portResult.code})`), 'port'));

  const ok = checks.every((c) => !c.required || c.status !== 'fail');
  return { ok, platform, checks };
}

// 예전 데이터와 충돌하는 작업 공간 파일 수. 확인하지 못하면 0으로 보고 기본 안내를 쓴다
function legacyConflictCount(program, workspace) {
  try {
    return planMigration({ program, workspace }).conflicts.length;
  } catch {
    return 0;
  }
}

// 작업 공간 경로·출처와 예전 데이터 이전 필요 여부(같은 파일인지 비교만 하고 내용은 출력하지 않는다)
function workspaceCheck({ env, program, withFix }) {
  let ws;
  try {
    ws = resolveWorkspace({ env, program });
  } catch (err) {
    return withFix(check('workspace', '작업 공간', 'warn', false, err.message), 'workspace');
  }
  const label = WORKSPACE_SOURCE_LABEL[ws.source] ?? ws.source;
  if (ws.compat) return check('workspace', '작업 공간', 'ok', false, `${ws.path} (${label})`, { path: ws.path, source: ws.source, compat: true });
  const state = existsSync(ws.path) ? '' : ' — 아직 없음(npm run office가 처음 실행할 때 만듭니다)';
  if (ws.legacy.length) {
    const conflicts = legacyConflictCount(program, ws.path);
    const blocked = conflicts ? `. 작업 공간에 같은 이름의 다른 파일이 ${conflicts}개 있어 이전할 수 없습니다` : '';
    return withFix(check('workspace', '작업 공간', 'warn', false, `${ws.path} (${label})${state}. 프로그램 폴더에 예전 데이터가 남아 있습니다(${ws.legacy.join(', ')})${blocked}`, { path: ws.path, source: ws.source, compat: false }), conflicts ? 'legacyArchive' : 'migrate');
  }
  return check('workspace', '작업 공간', 'ok', false, `${ws.path} (${label})${state}`, { path: ws.path, source: ws.source, compat: false });
}

export const STATUS_MARK = { ok: '✔', fail: '✖', warn: '⚠' };

const OS_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

// 사람이 읽는 출력 줄 목록
export function formatDoctor(result) {
  const lines = [`AI Office 환경 점검 (${OS_NAME[result.platform] ?? result.platform})`, ''];
  for (const c of result.checks) {
    lines.push(`${STATUS_MARK[c.status]} ${c.label}${c.optional ? ' (선택)' : ''}: ${c.message}`);
    if (c.fix) {
      lines.push(`    해결(${c.fix.os}): ${c.fix.command}`);
      if (c.fix.note) lines.push(`    ${c.fix.note}`);
    }
  }
  lines.push('');
  const requiredFails = result.checks.filter((c) => c.required && c.status === 'fail').length;
  const others = result.checks.filter((c) => !(c.required && c.status === 'fail') && c.status !== 'ok').length;
  if (requiredFails) lines.push(`결과: 필수 항목 ${requiredFails}개 실패 — 위 해결 방법을 따른 뒤 npm run doctor를 다시 실행하세요.`);
  else lines.push(`결과: 필수 항목 통과${others ? ` (확인할 항목 ${others}개)` : ''}. npm run office로 대시보드를 띄우세요.`);
  return lines;
}
