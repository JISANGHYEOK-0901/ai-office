// 계정 프로필·선택적으로 저장한 로그인 값은 AI 작업 공간 밖에 둔다. 공개 응답은 상태만 제공한다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';
import { accountConnectionId, accountProvider, loadAccounts } from './vault.mjs';

export const CONNECTION_PROVIDERS = Object.freeze({
  naverworks: { name: '네이버웍스 메일', loginUrl: 'https://mail.worksmobile.com/', hosts: ['worksmobile.com', 'naverworks.com', 'workplace.navercorp.com'], services: ['naverworks_mail'] },
  naver: { name: '네이버 블로그·카페', loginUrl: 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fwww.naver.com%2F', hosts: ['naver.com'], services: ['naver_blog', 'naver_cafe'] },
  kakao: { name: '다음·카카오 블로그·카페', loginUrl: 'https://accounts.kakao.com/login/?continue=https%3A%2F%2Fwww.daum.net%2F', hosts: ['kakao.com', 'daum.net', 'tistory.com', 'brunch.co.kr', 'brunchstory.com'], services: ['daum_cafe', 'tistory', 'brunch'] },
});
// 일반 웹사이트: 사용자가 정한 시작 주소·허용 도메인으로 어느 사이트든 연결한다(서비스 고정 목록이 아님).
export const CUSTOM_PROVIDER = 'web';
export const CUSTOM_PROVIDER_INFO = Object.freeze({ name: '일반 웹사이트', services: [] });
export const providerInfo = (provider) => provider === CUSTOM_PROVIDER ? CUSTOM_PROVIDER_INFO : CONNECTION_PROVIDERS[provider];
export const serviceProvider = (service) => Object.entries(CONNECTION_PROVIDERS).find(([, p]) => p.services.includes(service))?.[0];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
// http는 이 컴퓨터에서 실행한 개발·검증 서버(localhost)만 허용한다.
function siteUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) ? url : null;
}
// 일반 웹사이트 연결의 시작 주소와 허용 도메인을 검사해 저장 형식으로 바꾼다.
export function normalizeSite({ startUrl, hosts = [] } = {}) {
  const start = siteUrl(startUrl);
  if (!start) throw new Error('시작 주소는 https:// 주소로 입력해 주세요(이 컴퓨터의 검증 서버는 http://localhost도 됩니다).');
  const extra = (Array.isArray(hosts) ? hosts : String(hosts || '').split(/[\s,]+/)).map((h) => String(h).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')).filter(Boolean);
  const all = [...new Set([start.hostname, ...extra])];
  if (all.length > 10) throw new Error('허용 도메인은 10개까지 입력할 수 있습니다.');
  for (const host of all) if (!LOCAL_HOSTS.has(host) && (!HOST_PATTERN.test(host) || !host.includes('.'))) throw new Error(`허용 도메인 형식이 올바르지 않습니다: ${host}`);
  return { startUrl: start.toString(), hosts: all };
}
// 연결 계정이 열 수 있는 주소인지 본다. 일반 웹사이트는 연결에 저장한 도메인과 그 하위 도메인만 허용한다.
export function connectionAllowsUrl(connection, value) {
  if (!connection) return false;
  if (connection.provider !== CUSTOM_PROVIDER) return allowedServiceUrl(connection.provider, value);
  const url = siteUrl(value);
  if (!url) return false;
  if (url.protocol === 'https:' && url.port && url.port !== '443' && !LOCAL_HOSTS.has(url.hostname)) return false;
  return (connection.hosts || []).some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
// 첫 로그인은 대표가 직접 한다. 그 뒤(직접 로그인 기록 또는 이미 연결됐던 계정)부터 저장 정보로 다시 로그인할 수 있다
export const firstLoginDone = (connection) => Boolean(connection?.manualLoginAt) || ['connected', 'needs_login'].includes(connection?.status);
export const connectionLoginUrl = (connection) => connection.provider === CUSTOM_PROVIDER ? connection.startUrl : CONNECTION_PROVIDERS[connection.provider].loginUrl;
export function validateLoginValues({ username, password }) {
  if (typeof username !== 'string' || !username.trim() || username.length > 320 || typeof password !== 'string' || !password || password.length > 1024) throw new Error('자동 로그인에 사용할 아이디와 비밀번호를 입력해 주세요.');
  return { username: username.trim(), password };
}
const inside = (root, path) => { const rel = relative(root, path); return !rel || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const canonical = (value) => {
  let current = resolve(value); const missing = [];
  while (!existsSync(current)) { missing.unshift(basename(current)); current = dirname(current); }
  return join(realpathSync(current), ...missing);
};

export function connectionDirectory(root, base = join(homedir(), '.config', 'ai-office', 'private')) {
  const path = canonical(join(base, createHash('sha256').update(canonical(root)).digest('hex').slice(0, 24)));
  if (inside(canonical(root), path)) throw new Error('계정 저장 위치는 AI 작업 공간 밖이어야 합니다.');
  return path;
}
export function allowedServiceUrl(provider, value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && CONNECTION_PROVIDERS[provider]?.hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function createConnectionStore({ root, base } = {}) {
  const directory = connectionDirectory(root, base);
  const file = join(directory, 'connections.json');
  const keyFile = join(directory, 'local.key');
  const load = () => readPrivate(file, []);
  const ensure = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    if (!existsSync(join(directory, '.gitignore'))) writeFileSync(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  };
  const key = () => {
    ensure();
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    return readFileSync(keyFile);
  };
  // 보관함/계정.env의 사이트를 연결 목록에 맞춘다(비밀번호는 저장하지 않고 쓸 때마다 파일에서 읽는다)
  const syncFile = () => {
    if (!root) return;
    let accounts;
    try { ({ accounts } = loadAccounts(root)); } catch { return; }
    const all = load(), ids = new Set();
    let changed = false;
    for (const account of accounts) {
      const id = accountConnectionId(account.name), provider = accountProvider(account);
      ids.add(id);
      const want = { provider, label: account.name, source: 'file', ...(provider === CUSTOM_PROVIDER ? { startUrl: account.startUrl, hosts: account.hosts } : {}) };
      const current = all.find((c) => c.id === id);
      if (!current) { all.push({ id, status: 'disconnected', updatedAt: new Date().toISOString(), ...want }); changed = true; }
      else if (['provider', 'label', 'startUrl', 'hosts'].some((k) => JSON.stringify(current[k]) !== JSON.stringify(want[k]))) { delete current.startUrl; delete current.hosts; Object.assign(current, want); changed = true; }
    }
    const kept = all.filter((c) => c.source !== 'file' || ids.has(c.id));
    if (changed || kept.length !== all.length) { ensure(); writePrivate(file, kept); }
  };
  const find = (id) => { syncFile(); const item = load().find((c) => c.id === id); if (!item) throw new Error('연결 계정을 찾을 수 없습니다.'); return item; };
  const profile = (id) => { find(id); const path = join(directory, 'profiles', id); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const publicConnection = (c) => ({ id: c.id, provider: c.provider, label: c.label, status: c.status,
    services: providerInfo(c.provider).services, hasCredentials: Boolean(c.credentials) || c.source === 'file', updatedAt: c.updatedAt, ...(c.source === 'file' ? { source: 'file' } : {}),
    firstLoginDone: firstLoginDone(c),
    ...(c.provider === CUSTOM_PROVIDER ? { startUrl: c.startUrl, hosts: c.hosts } : {}) });
  const update = (id, fields) => {
    const all = load(); const item = all.find((c) => c.id === id); if (!item) throw new Error('연결 계정을 찾을 수 없습니다.');
    Object.assign(item, fields, { updatedAt: new Date().toISOString() }); writePrivate(file, all); return publicConnection(item);
  };
  // 저장소 키로 값을 암호화·복호화한다(자동 로그인 정보, 공식 API 토큰)
  const seal = (value) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  const unseal = (record) => {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'));
  };
  const credentials = (id) => {
    const item = find(id);
    if (item.source === 'file') {
      const account = loadAccounts(root).accounts.find((a) => accountConnectionId(a.name) === id);
      return account ? { username: account.username, password: account.password } : null;
    }
    return item.credentials ? unseal(item.credentials) : null;
  };
  return { directory, find, profile, update, credentials, seal, unseal, authFile: (id) => { find(id); return join(directory, 'profiles', id, 'auth-state.json'); },
    list: () => { syncFile(); return load().map(publicConnection); },
    create({ provider, label, startUrl, hosts }) {
      if (!providerInfo(provider)) throw new Error('연결할 서비스를 선택해 주세요.');
      if (typeof label !== 'string' || label.length > 80) throw new Error('계정 이름은 80자 이하로 입력해 주세요.');
      const site = provider === CUSTOM_PROVIDER ? normalizeSite({ startUrl, hosts }) : null;
      ensure(); const all = load();
      const item = { id: randomBytes(12).toString('hex'), provider, label: label.trim() || (site ? new URL(site.startUrl).hostname : CONNECTION_PROVIDERS[provider].name),
        status: 'disconnected', updatedAt: new Date().toISOString(), ...(site || {}) };
      all.push(item); writePrivate(file, all); return publicConnection(item);
    },
    saveCredentials(id, { username, password }) {
      if (find(id).source === 'file') throw new Error('보관함/계정.env에 적힌 계정입니다. 로그인 정보는 그 파일에서 바꿔 주세요.'); ({ username, password } = validateLoginValues({ username, password }));
      return update(id, { credentials: seal({ username, password }) });
    },
    remove(id) {
      if (find(id).source === 'file') throw new Error('보관함/계정.env에 적힌 계정입니다. 그 파일에서 지우면 목록에서도 사라집니다.'); writePrivate(file, load().filter((c) => c.id !== id));
      rmSync(join(directory, 'profiles', id), { recursive: true, force: true });
    },
  };
}
