// 계정 프로필·선택적으로 저장한 로그인 값은 AI 작업 공간 밖에 둔다. 공개 응답은 상태만 제공한다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';

export const CONNECTION_PROVIDERS = Object.freeze({
  naverworks: { name: '네이버웍스 메일', loginUrl: 'https://mail.worksmobile.com/', hosts: ['worksmobile.com', 'naverworks.com', 'workplace.navercorp.com'], services: ['naverworks_mail'] },
  naver: { name: '네이버 블로그·카페', loginUrl: 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fwww.naver.com%2F', hosts: ['naver.com'], services: ['naver_blog', 'naver_cafe'] },
  kakao: { name: '다음·카카오 블로그·카페', loginUrl: 'https://accounts.kakao.com/login/?continue=https%3A%2F%2Fwww.daum.net%2F', hosts: ['kakao.com', 'daum.net', 'tistory.com', 'brunch.co.kr', 'brunchstory.com'], services: ['daum_cafe', 'tistory', 'brunch'] },
});
export const serviceProvider = (service) => Object.entries(CONNECTION_PROVIDERS).find(([, p]) => p.services.includes(service))?.[0];
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
  const find = (id) => { const item = load().find((c) => c.id === id); if (!item) throw new Error('연결 계정을 찾을 수 없습니다.'); return item; };
  const profile = (id) => { find(id); const path = join(directory, 'profiles', id); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const publicConnection = (c) => ({ id: c.id, provider: c.provider, label: c.label, status: c.status,
    services: CONNECTION_PROVIDERS[c.provider].services, hasCredentials: Boolean(c.credentials), updatedAt: c.updatedAt });
  const update = (id, fields) => {
    const all = load(); const item = all.find((c) => c.id === id); if (!item) throw new Error('연결 계정을 찾을 수 없습니다.');
    Object.assign(item, fields, { updatedAt: new Date().toISOString() }); writePrivate(file, all); return publicConnection(item);
  };
  const credentials = (id) => {
    const record = find(id).credentials; if (!record) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'));
  };
  return { directory, find, profile, update, credentials, authFile: (id) => { find(id); return join(directory, 'profiles', id, 'auth-state.json'); },
    list: () => load().map(publicConnection),
    create({ provider, label }) {
      if (!CONNECTION_PROVIDERS[provider]) throw new Error('연결할 서비스를 선택해 주세요.');
      if (typeof label !== 'string' || label.length > 80) throw new Error('계정 이름은 80자 이하로 입력해 주세요.');
      ensure(); const all = load();
      const item = { id: randomBytes(12).toString('hex'), provider, label: label.trim() || CONNECTION_PROVIDERS[provider].name,
        status: 'disconnected', updatedAt: new Date().toISOString() };
      all.push(item); writePrivate(file, all); return publicConnection(item);
    },
    saveCredentials(id, { username, password }) {
      find(id); ({ username, password } = validateLoginValues({ username, password }));
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
      const data = Buffer.concat([cipher.update(JSON.stringify({ username, password }), 'utf8'), cipher.final()]);
      return update(id, { credentials: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') } });
    },
    remove(id) {
      find(id); writePrivate(file, load().filter((c) => c.id !== id));
      rmSync(join(directory, 'profiles', id), { recursive: true, force: true });
    },
  };
}
