import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { accountsFile, ensureVault, parseAccounts, vaultDir } from '../lib/vault.mjs';
import { createConnectionStore } from '../lib/connections.mjs';
import { decideSecretGuard } from '../lib/chief-guard.mjs';

test('계정 파일은 사이트 이름별로 주소·아이디·비밀번호를 묶고, 빠지거나 틀린 항목은 값 없이 사유만 알린다', () => {
  const { accounts, problems } = parseAccounts(`# 주석
ERP_URL=https://erp.example.com/erp/login
ERP_ID=qa@example.com
ERP_PASSWORD="p@ss word"
ERP_HOSTS=partners.example.com
NAVER_URL=https://nid.naver.com/nidlogin.login
NAVER_USER=naver-id
NAVER_PW='secret'
LOCAL_URL=http://localhost:3000/erp/login
LOCAL_ID=a
LOCAL_PASSWORD=b
BROKEN_URL=http://erp.example.com/
BROKEN_ID=a
BROKEN_PASSWORD=b
HALF_URL=https://half.example.com/
HALF_ID=x
`);
  assert.deepEqual(accounts.map((a) => [a.name, a.startUrl, a.hosts, a.username]), [
    ['ERP', 'https://erp.example.com/erp/login', ['erp.example.com', 'partners.example.com'], 'qa@example.com'],
    ['NAVER', 'https://nid.naver.com/nidlogin.login', ['nid.naver.com'], 'naver-id'],
    ['LOCAL', 'http://localhost:3000/erp/login', ['localhost'], 'a'],
  ]);
  assert.equal(accounts[0].password, 'p@ss word');
  assert.equal(accounts[1].password, 'secret');
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => !/\bb\b|secret|x$/.test(p)), '사유에 값을 싣지 않는다');
});

test('보관함은 Git·검색 제외 파일과 본인만 읽는 계정 파일로 만들고, 계정 파일은 연결 목록에 나타나되 비밀번호는 파일에서만 읽는다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-vault-')), root = join(temp, 'workspace'); mkdirSync(root);
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  ensureVault(root);
  for (const name of ['.gitignore', '.ignore', '.rgignore']) assert.equal(readFileSync(join(vaultDir(root), name), 'utf8'), '*\n');
  assert.match(readFileSync(accountsFile(root), 'utf8'), /ERP_URL=/);
  if (process.platform !== 'win32') assert.equal(statSync(accountsFile(root)).mode & 0o777, 0o600);
  ensureVault(root); // 다시 불러도 사용자가 쓴 파일을 덮지 않는다
  writeFileSync(accountsFile(root), 'ERP_URL=https://erp.example.com/erp/login\nERP_ID=qa\nERP_PASSWORD=file-only-secret\nNAVER_URL=https://nid.naver.com/nidlogin.login\nNAVER_ID=n\nNAVER_PASSWORD=np\n');
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const list = store.list();
  const erp = list.find((c) => c.label === 'ERP'), naver = list.find((c) => c.label === 'NAVER');
  assert.deepEqual([erp.provider, erp.source, erp.hasCredentials, erp.startUrl], ['web', 'file', true, 'https://erp.example.com/erp/login']);
  assert.equal(naver.provider, 'naver', '알려진 서비스 주소는 그 서비스 계정으로(카페·블로그 작업에 사용)');
  assert.doesNotMatch(JSON.stringify(list), /file-only-secret/);
  assert.doesNotMatch(readFileSync(join(store.directory, 'connections.json'), 'utf8'), /file-only-secret/, '비밀번호를 저장소에 복사하지 않는다');
  assert.deepEqual(store.credentials(erp.id), { username: 'qa', password: 'file-only-secret' });
  assert.throws(() => store.saveCredentials(erp.id, { username: 'a', password: 'b' }), /계정\.env/);
  assert.throws(() => store.remove(erp.id), /계정\.env/);
  store.update(erp.id, { status: 'connected' });
  writeFileSync(accountsFile(root), 'ERP_URL=https://erp.example.com/erp/login\nERP_ID=qa2\nERP_PASSWORD=changed\n');
  assert.equal(store.list().find((c) => c.id === erp.id).status, 'connected', '파일이 바뀌어도 로그인 상태는 유지');
  assert.deepEqual(store.credentials(erp.id), { username: 'qa2', password: 'changed' }, '바뀐 값을 바로 읽는다');
  assert.equal(store.list().some((c) => c.label === 'NAVER'), false, '파일에서 지운 계정은 목록에서도 사라진다');
});

test('직원·비서실장은 계정 파일과 계정 저장소를 읽거나 고치거나 셸 명령에 쓸 수 없다', () => {
  const root = '/work/space';
  const check = (tool_name, tool_input, cwd = root) => decideSecretGuard({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd }, { root, platform: 'linux', home: '/home/u' });
  assert.ok(check('Read', { file_path: '/work/space/보관함/계정.env' }));
  assert.ok(check('Read', { file_path: '보관함/계정.env' }));
  assert.ok(check('Edit', { file_path: '/work/space/보관함/계정.env', old_string: 'a', new_string: 'b' }));
  assert.ok(check('Grep', { pattern: 'PASSWORD', path: '/home/u/.config/ai-office/private' }));
  assert.ok(check('Glob', { pattern: '**/계정.env' }));
  assert.ok(check('Bash', { command: 'cat 보관함/계정.env' }));
  assert.ok(check('Bash', { command: 'ls ~/.config/ai-office/private' }));
  assert.equal(check('Read', { file_path: '/work/space/outputs/2026-11-03/x/report.md' }), null);
  assert.equal(check('Read', { file_path: '/work/space/보관함/최종산출물/2026-11-03/a.md' }), null, '보관함의 산출물은 읽을 수 있다');
  assert.equal(check('Bash', { command: 'node scripts/office.mjs task files 2026-11-03/x' }), null);
  assert.equal(check('Grep', { pattern: 'TODO', path: '.' }), null);
  assert.ok(existsSync(homedir()));
});
