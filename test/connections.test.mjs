import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectionStore, allowedServiceUrl, connectionDirectory } from '../lib/connections.mjs';
import { externalActionPolicy } from '../lib/browser-work.mjs';
import { attachBrowser } from '../lib/browser-cli.mjs';
import { credentialLoginUrl } from '../lib/browser-session.mjs';

test('계정은 작업 공간 밖에서 암호화해 저장하고 공개 목록·재로딩에 비밀번호를 노출하지 않는다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-accounts-')), root = join(temp, 'workspace'); mkdirSync(root);
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const account = store.create({ provider: 'naver', label: '업무용 계정' });
  store.saveCredentials(account.id, { username: 'fixture-user', password: 'fixture-password-private' });
  assert.doesNotMatch(JSON.stringify(store.list()), /fixture-user|fixture-password|credentials|cookie/);
  assert.doesNotMatch(readFileSync(join(store.directory, 'connections.json'), 'utf8'), /fixture-password-private|fixture-user/);
  const reloaded = createConnectionStore({ root, base: join(temp, 'private') });
  assert.deepEqual(reloaded.credentials(account.id), { username: 'fixture-user', password: 'fixture-password-private' });
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(store.directory, 'connections.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(store.directory, 'local.key')).mode & 0o777, 0o600);
  }
  assert.throws(() => connectionDirectory(root, root), /작업 공간 밖/);
  store.remove(account.id); assert.deepEqual(store.list(), []);
});

test('브라우저 대상은 지정한 플랫폼·HTTPS 주소만 허용한다', () => {
  assert.equal(allowedServiceUrl('naver', 'https://blog.naver.com/company'), true);
  for (const url of ['https://naver.com.evil.test/', 'http://blog.naver.com/', 'https://user:password@blog.naver.com/', 'https://blog.naver.com:444/']) assert.equal(allowedServiceUrl('naver', url), false);
  assert.equal(allowedServiceUrl('kakao', 'https://example.tistory.com/manage'), true);
  assert.equal(allowedServiceUrl('naverworks', 'https://mail.worksmobile.com/'), true);
  assert.equal(credentialLoginUrl('kakao', 'https://accounts.kakao.com/login/'), true);
  assert.equal(credentialLoginUrl('naver', 'https://nid.naver.com/nidlogin.login'), true);
  assert.equal(credentialLoginUrl('naverworks', 'https://auth.worksmobile.com/login/login'), true);
  for (const url of ['https://untrusted.tistory.com/login', 'https://cafe.daum.net/board', 'https://blog.naver.com/login']) {
    assert.equal(credentialLoginUrl('kakao', url), false);
    assert.equal(credentialLoginUrl('naver', url), false);
  }
});

test('사용자가 지시한 작업만 허용하고 이후 금지·재발송·결과 확인 지시를 반영한다', () => {
  assert.deepEqual(externalActionPolicy(['자료를 조사해 줘']).actions, []);
  assert.deepEqual(externalActionPolicy(['메일로 보내 줘', '계정 연결 완료']).actions, ['mail']);
  assert.deepEqual(externalActionPolicy(['메일 보내고 블로그에 글 작성해 줘', '메일 발송하지 마']).actions, ['post']);
  assert.deepEqual(externalActionPolicy(['블로그에 게시해 줘', '초안만 작성', '이제 블로그에 발행해 줘']).actions, ['post']);
  assert.equal(externalActionPolicy(['미발송 확인, 재발송']).retryUncertain, true);
  assert.equal(externalActionPolicy(['발송됐음 확인']).confirmExisting, true);
  assert.equal(externalActionPolicy(['미발송 확인, 재발송']).confirmExisting, false);
});

test('최초 메일 승인에 과거 미발송·재발송 금지가 함께 있어도 최초 1통만 허용한다', () => {
  const request = '메일 1통을 지정 수신자에게 발송해. 아직 어느 메일도 발송하지 않았다. 전송 결과가 불확실하면 다시 발송하지 말고 확인 필요로 남겨.';
  const first = externalActionPolicy([request, '승인']);
  assert.deepEqual(first.actions, ['mail']); assert.equal(first.allowResend, false); assert.equal(first.retryUncertain, false);
  const retryWarning = externalActionPolicy([request]);
  assert.deepEqual(retryWarning.actions, ['mail']); assert.equal(retryWarning.allowResend, false);
  assert.equal(externalActionPolicy(['메일 발송해. 재발송 금지.']).allowResend, false);
  assert.deepEqual(externalActionPolicy([request, '메일 발송하지 말아 주세요']).actions, []);
  assert.deepEqual(externalActionPolicy([request, '메일 발송 금지']).actions, []);
  const retry = externalActionPolicy([request, '미발송 확인, 재발송']);
  assert.equal(retry.allowResend, true); assert.equal(retry.retryUncertain, true);
  for (const statement of ['가상 자료를 HTML로 정리해. 웹 수집, 메일 발송, 게시, 광고 집행은 없다.',
    '실제 광고 집행·메일 발송·게시는 없다.', '메일·게시·광고 집행은 없다.',
    '메일 발송은 하지 않는다.', '메일은 발송하지 않습니다.']) assert.deepEqual(externalActionPolicy([statement]).actions, []);
});

test('MCP 연결은 실행별 승인된 도구에 한정하고 전역 설정·훅 신뢰를 우회하지 않는다', () => {
  const browser = { url: 'http://127.0.0.1:12345/tools', token: 'fixture-token', permissionsFile: '/private/fixture-capability.json' };
  const codex = { engine: 'codex', args: ['exec', '-s', 'workspace-write', '-'] };
  attachBrowser(codex, browser);
  assert.equal(codex.args[codex.args.indexOf('-s') + 1], 'read-only');
  assert.ok(codex.args.some((s) => s === 'mcp_servers.office_browser.default_tools_approval_mode="approve"'));
  assert.doesNotMatch(codex.args.join(' '), /dangerously|fixture-token/);
  assert.equal(codex.env?.OFFICE_BROWSER_TOKEN, undefined);
  const claude = { engine: 'claude', agentId: 'mail-1', agentDefinition: { description: '메일 담당', prompt: '검토된 메일만 발송', model: 'sonnet' }, args: ['-p'] }; attachBrowser(claude, browser);
  assert.ok(claude.args.includes('--strict-mcp-config'));
  const definition = JSON.parse(claude.args[claude.args.indexOf('--agents') + 1])['mail-1'];
  assert.equal(definition.prompt, '검토된 메일만 발송');
  assert.ok(definition.tools.includes('mcp__office_browser__browser_submit'));
  assert.ok(!definition.tools.includes('Write') && !definition.tools.includes('Bash'));
  assert.ok(claude.args[claude.args.indexOf('--tools') + 1].includes('mcp__office_browser__browser_snapshot'));
  assert.doesNotMatch(claude.args.join(' '), /fixture-token/);
});
