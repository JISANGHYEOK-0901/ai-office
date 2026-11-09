import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectionStore, allowedServiceUrl, connectionDirectory, connectionAllowsUrl, connectionLoginUrl, normalizeSite } from '../lib/connections.mjs';
import { externalActionPolicy } from '../lib/guardrails.mjs';
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
  // 사이트에서 본 결과를 자연스럽게 말한 답도 확인으로 보고, 아직 안 올라갔다는 말과 질문은 확인이 아니다
  for (const text of ['글은 올라가 있는데 나머지 글 2건은 안올라와있어 2건 마저 올리고 보고해줘', '카페에 잘 올라왔어', '글 게시돼 있어', '다 올라갔네', '올라간 내용 확인은 했어', '게시된 글 확인했어']) {
    assert.equal(externalActionPolicy([text]).confirmExisting, true, text);
  }
  for (const text of ['아직 안 올라왔어', '글이 안올라가 있어', '못 올라갔어', '글이 올라갔는지 봐줘', '카페에 올라와 있나요?', '미게시 확인, 재게시', '올라간 거 확인해 줘', '안 올라간 거 확인했어']) {
    assert.equal(externalActionPolicy([text]).confirmExisting, false, text);
  }
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

test('일반 웹사이트 연결은 사용자가 정한 시작 주소·허용 도메인 안에서만 열고 로그인 값을 입력한다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'office-accounts-web-')), root = join(temp, 'workspace'); mkdirSync(root);
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  const erp = store.create({ provider: 'web', label: '', startUrl: 'https://erp.example.com/erp/login', hosts: 'partners.example.com, *.cdn.example.net' });
  assert.equal(erp.label, 'erp.example.com');
  assert.deepEqual(erp.hosts, ['erp.example.com', 'partners.example.com', 'cdn.example.net']);
  assert.deepEqual(erp.services, []);
  const record = store.find(erp.id);
  assert.equal(connectionLoginUrl(record), 'https://erp.example.com/erp/login');
  for (const url of ['https://erp.example.com/erp/proposal-pages', 'https://partners.example.com/a', 'https://img.cdn.example.net/x.png'])
    assert.equal(connectionAllowsUrl(record, url), true, url);
  for (const url of ['http://erp.example.com/', 'https://erp.example.com.evil.test/', 'https://example.com/', 'https://user:pw@erp.example.com/', 'https://erp.example.com:8443/'])
    assert.equal(connectionAllowsUrl(record, url), false, url);
  assert.equal(credentialLoginUrl(record, 'https://erp.example.com/erp/login'), true);
  assert.equal(credentialLoginUrl(record, 'https://evil.test/erp/login'), false);
  // 이 컴퓨터에서 띄운 검증 서버는 http://localhost를 허용한다(포트 무관)
  const local = store.find(store.create({ provider: 'web', label: '로컬 ERP', startUrl: 'http://localhost:5173/erp/login' }).id);
  assert.equal(connectionAllowsUrl(local, 'http://localhost:8080/api/admin'), true);
  assert.equal(connectionAllowsUrl(local, 'http://127.0.0.1:5173/'), false);
  for (const startUrl of ['http://erp.example.com/', 'ftp://erp.example.com/', 'https://u:p@erp.example.com/', 'javascript:alert(1)', ''])
    assert.throws(() => normalizeSite({ startUrl }), /시작 주소/, startUrl);
  assert.throws(() => normalizeSite({ startUrl: 'https://erp.example.com/', hosts: 'bad_host!' }), /허용 도메인/);
  assert.throws(() => normalizeSite({ startUrl: 'https://erp.example.com/', hosts: 'com' }), /허용 도메인/);
  // 기존 서비스 연결은 예전 규칙 그대로
  assert.equal(connectionAllowsUrl({ provider: 'naver' }, 'https://blog.naver.com/x'), true);
  assert.equal(connectionAllowsUrl({ provider: 'naver' }, 'https://erp.example.com/'), false);
});

test('웹사이트 업로드·등록 지시와 위임 표현을 판별한다', () => {
  const ask = externalActionPolicy(['만든 HTML을 ERP 제휴 제안 페이지에 업로드해 줘']);
  assert.deepEqual([ask.actions, ask.delegated], [['web'], false]);
  assert.equal(externalActionPolicy(['만든 HTML을 관리자 페이지에 올려 줘. 끝까지 자동으로 해']).delegated, true);
  assert.equal(externalActionPolicy(['업로드해 줘', '확인 없이 진행']).delegated, true);
  assert.deepEqual(externalActionPolicy(['보고서 HTML 초안만 만들어 줘']).actions, []);
  assert.deepEqual(externalActionPolicy(['HTML 만들되 업로드하지 마']).actions, []);
  // 실행기가 붙인 저장 위치 안내·일반 문장은 웹사이트 작업 지시가 아니다(PR #10 오인 회귀)
  for (const text of ['ERP에서 조건에 맞는 상담사를 찾아 리스트로 정리해 줘\n\n[저장 위치] 이 작업의 산출물은 이 폴더에 저장하세요: outputs/x/', 'HTML 페이지 만들어줘. 저장해줘', 'ERP에서 신규 등록 상담사 찾아줘'])
    assert.deepEqual(externalActionPolicy([text]).actions, [], text);
  assert.deepEqual(externalActionPolicy(['관리자 페이지에 공지 등록해 줘']).actions, ['web']);
});

test('requestLogin: 없는 연결을 만들어 창을 열고 로그인 완료·창 닫힘·시간 초과를 구분한다', async (t) => {
  const { createBrowserWork } = await import('../lib/browser-work.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'office-login-request-')), root = join(temp, 'workspace'); mkdirSync(root);
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = createConnectionStore({ root, base: join(temp, 'private') });
  let onOpen = () => {};
  const sessions = { open: async (id) => { store.update(id, { status: 'connecting' }); onOpen(id); }, close: async () => {} };
  const work = createBrowserWork({ root, store, sessions });
  onOpen = (id) => setTimeout(() => store.update(id, { status: 'connected', manualLoginAt: 'x' }), 5);
  const done = await work.requestLogin({ provider: 'naver', pollMs: 1 });
  assert.equal(done.status, 'connected');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].provider, 'naver');
  onOpen = (id) => setTimeout(() => store.update(id, { status: 'disconnected' }), 5);
  assert.equal((await work.requestLogin({ provider: 'naver', pollMs: 1 })).status, 'closed');
  assert.equal(store.list().length, 1, '있는 연결을 다시 쓴다');
  onOpen = () => {};
  assert.equal((await work.requestLogin({ provider: 'naver', pollMs: 1, timeoutMs: 10 })).status, 'timeout');
  const web = await work.requestLogin({ target: 'https://erp.example.com/a', pollMs: 1, timeoutMs: 10 });
  assert.equal(store.list().find((c) => c.id === web.id).provider, 'web');
  const stop = new AbortController(); stop.abort();
  await assert.rejects(work.requestLogin({ provider: 'naver', pollMs: 1, signal: stop.signal }));
});

test('글 본문 나누기: 유튜브·네이버 지도 링크만 따로 떼고 순서를 지키며 다른 링크는 글에 둔다', async () => {
  const { bodySegments } = await import('../lib/browser-work.mjs');
  const y = 'https://www.youtube.com/shorts/AbCdEfGhI_1';
  assert.deepEqual(bodySegments(`소개글\n${y}\n마무리`), [{ text: '소개글\n\n', card: false }, { text: y, card: true }, { text: '마무리', card: false }]);
  assert.deepEqual(bodySegments(`영상: ${y}.`).map((s) => s.text), ['영상:\n\n', y, '.']);
  assert.deepEqual(bodySegments(y), [{ text: y, card: true }]);
  assert.deepEqual(bodySegments('https://youtu.be/AbCdEfGhI_1 그리고 https://m.youtube.com/watch?v=ZyXwVuTsR_2').map((s) => s.card), [true, false, true]);
  assert.deepEqual(bodySegments('자료는 https://example.com/a 를 보세요'), [{ text: '자료는 https://example.com/a 를 보세요', card: false }]);
  assert.deepEqual(bodySegments(''), [{ text: '', card: false }]);
  // 네이버 지도 공유 주소·플레이스 주소도 장소 카드가 되도록 단독으로 붙여넣는다
  for (const place of ['https://naver.me/AbCd1234', 'https://map.naver.com/p/entry/place/1234567', 'https://m.place.naver.com/place/1234567/home', 'https://pcmap.place.naver.com/place/1234567']) {
    assert.deepEqual(bodySegments(`이런 곳 좋아보여요~\n\n${place}`), [{ text: '이런 곳 좋아보여요~\n\n', card: false }, { text: place, card: true }], place);
  }
  // 네이버의 다른 주소(카페·블로그)와 비슷한 이름의 다른 사이트는 글에 둔다
  for (const other of ['https://cafe.naver.com/petdilab', 'https://blog.naver.com/a/1', 'https://map.naver.com.evil.example/a', 'https://mynaver.me/a']) {
    assert.equal(bodySegments(`참고 ${other}`).filter((s) => s.card).length, 0, other);
  }
});
