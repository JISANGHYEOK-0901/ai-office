// 보관함: 작업 공간의 Git 제외 폴더. 사이트별 계정 파일(계정.env)과 최종산출물을 한곳에 둔다.
// 계정 파일은 서버 코드만 읽기 전용으로 읽는다(고치지 않음). 값은 AI·로그·화면에 넘기지 않는다.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONNECTION_PROVIDERS, CUSTOM_PROVIDER, normalizeSite } from './connections.mjs';

export const VAULT_DIR = '보관함';
export const ACCOUNTS_FILE = '계정.env';
export const vaultDir = (root) => join(root, VAULT_DIR);
export const accountsFile = (root) => join(vaultDir(root), ACCOUNTS_FILE);

const TEMPLATE = `# AI Office 사이트별 계정 (이 파일은 Git에서 제외되고, 서버만 읽기 전용으로 읽습니다)
# 사이트마다 같은 이름 앞부분으로 주소·아이디·비밀번호를 적으세요. 이름은 영문 대문자·숫자·_ 로 씁니다.
# 비밀번호는 AI 직원에게 전달되지 않고 자동 로그인에만 쓰입니다.
#
# ERP_URL=https://erp.example.com/erp/login
# ERP_ID=
# ERP_PASSWORD=
# ERP_HOSTS=partners.example.com          # (선택) 함께 허용할 도메인, 쉼표로 구분
#
# NAVER_URL=https://nid.naver.com/nidlogin.login
# NAVER_ID=
# NAVER_PASSWORD=
`;

// 보관함 폴더와 안내 파일을 만든다. 검색 도구(ripgrep)·Git이 들여다보지 않게 .ignore·.gitignore를 둔다.
export function ensureVault(root) {
  const dir = vaultDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ['.gitignore', '.ignore', '.rgignore']) {
    const file = join(dir, name);
    if (!existsSync(file)) writeFileSync(file, '*\n', { mode: 0o600 });
  }
  const file = accountsFile(root);
  if (!existsSync(file)) writeFileSync(file, TEMPLATE, { mode: 0o600 });
  if (process.platform !== 'win32') { try { chmodSync(dir, 0o700); chmodSync(file, 0o600); } catch { /* 권한 변경 불가 환경 */ } }
  return dir;
}

const unquote = (value) => {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, '');
};

// KEY=VALUE 줄을 <이름>_URL/_ID/_PASSWORD/_HOSTS로 묶는다. 형식이 틀린 항목은 사유와 함께 돌려준다(값은 싣지 않음).
export function parseAccounts(text) {
  const groups = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)_(URL|ID|USER|USERNAME|PASSWORD|PW|HOSTS)\s*=\s*(.*)$/);
    if (!m) continue;
    const field = { USER: 'ID', USERNAME: 'ID', PW: 'PASSWORD' }[m[2]] || m[2];
    const item = groups.get(m[1]) || {}; item[field] = unquote(m[3]); groups.set(m[1], item);
  }
  const accounts = [], problems = [];
  for (const [name, item] of groups) {
    if (!item.URL && !item.ID && !item.PASSWORD) continue;
    if (!item.URL || !item.ID || !item.PASSWORD) { problems.push(`${name}: _URL·_ID·_PASSWORD가 모두 있어야 합니다.`); continue; }
    try {
      const site = normalizeSite({ startUrl: item.URL, hosts: item.HOSTS || '' });
      accounts.push({ name, ...site, username: item.ID, password: item.PASSWORD });
    } catch (error) { problems.push(`${name}: ${error.message}`); }
  }
  return { accounts, problems };
}

export function loadAccounts(root) {
  const file = accountsFile(root);
  if (!existsSync(file) || !statSync(file).isFile()) return { accounts: [], problems: [] };
  return parseAccounts(readFileSync(file, 'utf8'));
}

// 알려진 서비스 도메인이면 그 서비스(네이버 카페·블로그 등 외부 작업과 연결), 아니면 일반 웹사이트
export function accountProvider(account) {
  const host = new URL(account.startUrl).hostname;
  const known = Object.entries(CONNECTION_PROVIDERS).find(([, p]) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  return known ? known[0] : CUSTOM_PROVIDER;
}

export const accountConnectionId = (name) => `file-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
