#!/usr/bin/env node
// 네이버 카페 공식 API 세팅 도구. 프로그램 폴더의 터미널 AI가 "네이버 카페 api 세팅해줘"를 처리할 때 쓴다(AGENTS.md "프로그램 레포에서 연 세션").
// 앱 키 값은 어떤 출력에도 싣지 않는다. 키는 표준 입력으로만 받는다(명령줄 인자는 프로세스 목록·대화 기록에 남는다).
// 터미널 AI 세션은 훅 때문에 보관함/계정.env를 직접 쓰지 못하므로 이 명령이 대신 쓴다. 대시보드가 실행한 AI(비서실장·직원)는 쓰지 못한다.
//   node scripts/naver-api.mjs status [--json]
//   <키를 읽는 코드> | node scripts/naver-api.mjs save [--replace] [--callback <주소>]
//   node scripts/naver-api.mjs connect [--connection <id>] [--timeout 600]
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConnectionStore } from '../lib/connections.mjs';
import { insideOfficeRun, readDashboardAccess } from '../lib/dashboard-access.mjs';
import { createNaverCafeApi, naverApiApp, naverApiCallback, saveNaverApiApp } from '../lib/naver-cafe-api.mjs';
import { resolveWorkspace } from '../lib/paths.mjs';
import { runningServer } from '../lib/server-lock.mjs';
import { createClient } from './office-ask.mjs';

const USAGE = [
  '사용법:',
  '  node scripts/naver-api.mjs status [--json]   앱 키 저장 여부, 개발자센터에 등록할 값, 네이버 계정별 공식 API 연결 상태(키 값은 출력하지 않음)',
  '  <키를 읽는 코드> | node scripts/naver-api.mjs save [--replace] [--callback <주소>]   표준 입력 JSON의 clientId·secret을 보관함 계정 파일에 저장',
  '  node scripts/naver-api.mjs connect [--connection <id>] [--timeout 600]   네이버 동의 창을 열고 연결될 때까지 기다림(대시보드 서버 필요)',
].join('\n');
const SERVICE_URL = 'http://localhost';
const REGISTER_URL = 'https://developers.naver.com/apps/#/register';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, json: false, replace: false, callback: null, connection: null, timeout: 600, workspace: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => { const v = rest[++i]; if (!v) throw new Error(`${arg} 값이 비어 있습니다.\n${USAGE}`); return v; };
    if (arg === '--json') opts.json = true;
    else if (arg === '--replace') opts.replace = true;
    else if (arg === '--callback') opts.callback = value();
    else if (arg === '--connection') opts.connection = value();
    else if (arg === '--timeout') opts.timeout = Number(value());
    else if (arg === '--workspace') opts.workspace = value();
    else throw new Error(`알 수 없는 옵션입니다: ${arg}\n${USAGE}`);
  }
  if (!['status', 'save', 'connect'].includes(command)) throw new Error(USAGE);
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout은 0보다 큰 초 단위 숫자여야 합니다.');
  return opts;
}

// 표준 입력에서 { clientId, secret }을 찾는다. 키를 읽는 코드의 출력(JSON 한 줄, Aside repl --json 결과처럼 감싼 JSON)을 그대로 받는다
const ID_KEY = /^client[_-]?id$/i, SECRET_KEY = /^(client[_-]?)?secret$/i;
export function findAppKeys(input) {
  const seen = new Set();
  const visit = (value, depth) => {
    if (depth > 6 || value === null || value === undefined) return null;
    if (typeof value === 'string') {
      // 전체(여러 줄 JSON)를 먼저, 그다음 마지막 줄부터 한 줄씩(앞에 붙은 표식 글자는 떼고) 읽는다
      for (const s of [value.trim(), ...value.split(/\r?\n/).reverse().map((line) => line.trim().replace(/^[^{]*?(?=\{)/, ''))]) {
        if (!/^[{[]/.test(s) || seen.has(s)) continue;
        seen.add(s);
        try { const found = visit(JSON.parse(s), depth + 1); if (found) return found; } catch { /* JSON이 아닌 줄 */ }
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    const entries = Object.entries(value);
    const id = entries.find(([k, v]) => ID_KEY.test(k) && typeof v === 'string')?.[1];
    const secret = entries.find(([k, v]) => SECRET_KEY.test(k) && typeof v === 'string')?.[1];
    if (id && secret) return { clientId: id.trim(), secret: secret.trim() };
    for (const [, v] of entries) { const found = visit(v, depth + 1); if (found) return found; }
    return null;
  };
  return visit(String(input || ''), 0);
}

async function readStdin() {
  if (process.stdin.isTTY) throw new Error('앱 키는 표준 입력으로 넘겨 주세요(예: <키를 읽는 코드> | node scripts/naver-api.mjs save). 키를 명령줄이나 채팅에 적지 않습니다.');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const tail = (value) => `…${String(value).slice(-4)}`;
const naverConnections = (list) => (list || []).filter((c) => c.provider === 'naver');

function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  return new Promise((done) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => done(false));
      child.on('spawn', () => { child.unref(); done(true); });
    } catch { done(false); }
  });
}

function status(root, { json }) {
  const store = createConnectionStore({ root });
  const cafeApi = createNaverCafeApi({ root, store });
  const app = naverApiApp(root);
  const server = runningServer(root);
  const callback = naverApiCallback(server?.port || 4777);
  const accounts = naverConnections(store.list()).map((c) => ({ id: c.id, label: c.label, ...cafeApi.status(c.id) }));
  const result = {
    appConfigured: Boolean(app), clientIdTail: app ? tail(app.clientId) : null, callback: app?.callback || callback,
    callbackMismatch: Boolean(app && server?.port && app.callback !== callback),
    register: { url: REGISTER_URL, api: '카페', environment: 'PC 웹', serviceUrl: SERVICE_URL, callbackUrl: app?.callback || callback },
    server: Boolean(server), accounts: accounts.map(({ id, label, connected, connectedAt }) => ({ id, label, connected, connectedAt })),
  };
  if (json) return console.log(JSON.stringify(result, null, 2));
  const lines = [
    `앱 키: ${app ? `저장됨(Client ID ${result.clientIdTail})` : '없음'}`,
    `개발자센터에 등록할 값: 사용 API ${result.register.api}, 환경 ${result.register.environment}, 서비스 URL ${SERVICE_URL}, Callback URL ${result.register.callbackUrl}`,
    `대시보드 서버: ${server ? `켜짐(포트 ${server.port})` : '꺼짐'}`,
  ];
  if (result.callbackMismatch) lines.push(`주의: 저장된 Callback URL(${app.callback})이 지금 대시보드 주소(${callback})와 다릅니다. 개발자센터와 저장값을 같은 포트로 맞추세요.`);
  lines.push(accounts.length ? `네이버 계정: ${accounts.map((a) => `${a.label}(${a.id}) ${a.connected ? `공식 API 연결됨${a.connectedAt ? ` ${a.connectedAt}` : ''}` : '공식 API 미연결'}`).join(', ')}`
    : '네이버 계정: 없음(connect가 계정 연결에 새로 만듭니다)');
  console.log(lines.join('\n'));
}

async function save(root, { replace, callback }) {
  const keys = findAppKeys(await readStdin());
  if (!keys) throw new Error('표준 입력에서 clientId·secret을 찾지 못했습니다. {"clientId":"…","secret":"…"} 형식의 JSON을 넘겨 주세요(입력 내용은 표시하지 않습니다).');
  const result = saveNaverApiApp(root, { ...keys, callback: callback || naverApiCallback(runningServer(root)?.port || 4777) }, { replace });
  const app = naverApiApp(root);
  if (!result.changed) return console.log(`같은 앱 키가 이미 저장돼 있습니다(Client ID ${tail(app.clientId)}). 다음: node scripts/naver-api.mjs connect`);
  const store = createConnectionStore({ root });
  const tokenDir = join(store.directory, 'naver-api');
  const linked = result.replaced && existsSync(tokenDir) ? readdirSync(tokenDir).filter((f) => f.endsWith('.json')).length : 0;
  console.log([
    `앱 키를 저장했습니다(Client ID ${tail(app.clientId)}, Callback URL ${app.callback}). 서버를 다시 켤 필요는 없습니다.`,
    ...(linked ? [`이전 앱으로 공식 API를 연결한 네이버 계정 ${linked}개는 다시 연결해야 합니다.`] : []),
    '다음: node scripts/naver-api.mjs connect',
  ].join('\n'));
}

// 시험에서는 client(대시보드 API)·open(브라우저 열기)·sleep을 바꿔 끼운다
export async function connect(root, { connection = null, timeout = 600 } = {}, { client = null, open = openInBrowser, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = console.log } = {}) {
  if (!client) {
    const access = readDashboardAccess(root);
    if (!access) throw new Error(`대시보드 서버가 꺼져 있거나 이 작업 공간(${root})의 서버가 아닙니다. npm run office:start로 켠 뒤 다시 실행하세요.`);
    client = createClient(access);
  }
  const listed = await client.connections();
  if (!listed.naverApiConfigured) throw new Error('카페 공식 API 앱 키가 없습니다. 먼저 개발자센터에 앱을 등록하고 node scripts/naver-api.mjs save로 저장하세요.');
  const naver = naverConnections(listed.connections);
  let target = connection ? naver.find((c) => c.id === connection) : naver.length === 1 ? naver[0] : null;
  if (connection && !target) throw new Error(`네이버 계정 연결을 찾을 수 없습니다: ${connection}. node scripts/naver-api.mjs status로 id를 확인하세요.`);
  if (!target && naver.length > 1) throw new Error(`네이버 계정이 여러 개입니다. 대표에게 어느 계정에 연결할지 물은 뒤 --connection으로 지정하세요: ${naver.map((c) => `${c.label}(${c.id})`).join(', ')}`);
  if (!target) { target = await client.createConnection({ provider: 'naver', label: '네이버' }); log(`계정 연결에 네이버 계정을 만들었습니다(${target.label}, ${target.id}).`); }
  const before = target.naverApi?.connectedAt || null;
  const { url } = await client.naverApiStart(target.id);
  if (await open(url)) log('네이버 동의 창을 기본 브라우저에 열었습니다. 대표에게 "카페 가입·카페 글쓰기 항목을 체크하고 동의"를 부탁하세요.');
  else log(`브라우저를 열지 못했습니다. 이 주소를 대표의 브라우저에서 열어 동의하게 하세요(10분 안):\n${url}`);
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    await sleep(3000);
    const now = naverConnections((await client.connections()).connections).find((c) => c.id === target.id);
    if (now?.naverApi?.connected && now.naverApi.connectedAt !== before) { log(`연결 완료: ${now.label}(${now.id}) 카페 공식 API 연결됨 ${now.naverApi.connectedAt}`); return now; }
    if (Date.now() > deadline) throw new Error(`아직 연결되지 않았습니다(${timeout}초 대기). 동의 창에서 카페 가입·글쓰기 항목을 체크하고 동의했는지, 개발자센터의 Callback URL이 status 값과 같은지 확인한 뒤 connect를 다시 실행하세요.`);
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  // 대시보드가 실행한 AI가 앱 키를 바꾸거나 동의 창을 띄우지 못하게 한다(대표가 터미널에서 요청한 세팅만)
  if (opts.command !== 'status' && insideOfficeRun()) throw new Error('대시보드 업무 실행 중인 AI는 카페 공식 API 세팅을 바꿀 수 없습니다. 대표가 터미널 AI에게 "네이버 카페 api 세팅해줘"라고 요청해야 합니다.');
  const root = resolveWorkspace({ workspace: opts.workspace }).path;
  if (opts.command === 'status') return status(root, opts);
  if (opts.command === 'save') return save(root, opts);
  return connect(root, opts);
}

if (process.argv[1]?.endsWith('naver-api.mjs')) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
