import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cafeBoard, cafeHtml, createNaverCafeApi, naverApiApp } from '../lib/naver-cafe-api.mjs';
import { createConnectionStore } from '../lib/connections.mjs';
import { createBrowserWork } from '../lib/browser-work.mjs';
import { accountsFile } from '../lib/vault.mjs';

const KEYS = 'NAVER_API_CLIENT=fixture-client\nNAVER_API_SECRET=fixture-secret\nNAVER_API_CALLBACK=http://localhost:4777/oauth/naver/callback\n';
function workspace(t, accounts = KEYS) {
  const temp = mkdtempSync(join(tmpdir(), 'office-cafe-api-')), root = join(temp, 'workspace');
  mkdirSync(join(root, '보관함'), { recursive: true });
  if (accounts !== null) writeFileSync(accountsFile(root), accounts);
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, store: createConnectionStore({ root, base: join(temp, 'private') }) };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('앱 키: 계정.env의 NAVER_API_* 세 값이 모두 있고 콜백이 이 컴퓨터 주소일 때만 쓴다', (t) => {
  assert.deepEqual(naverApiApp(workspace(t).root), { clientId: 'fixture-client', secret: 'fixture-secret', callback: 'http://localhost:4777/oauth/naver/callback' });
  assert.equal(naverApiApp(workspace(t, 'NAVER_API_CLIENT=a\nNAVER_API_SECRET=b\n').root), null);
  assert.equal(naverApiApp(workspace(t, KEYS.replace('http://localhost:4777', 'https://evil.example')).root), null);
  assert.equal(naverApiApp(workspace(t, null).root), null);
});

test('게시판 주소: 새 카페 주소와 예전 clubid/menuid 주소를 읽고 전체글보기·다른 사이트는 거부한다', () => {
  assert.deepEqual(cafeBoard('https://cafe.naver.com/f-e/cafes/31520563/menus/44'), { clubid: '31520563', menuid: '44' });
  assert.deepEqual(cafeBoard('https://cafe.naver.com/ArticleList.nhn?search.clubid=31520563&search.menuid=24'), { clubid: '31520563', menuid: '24' });
  for (const bad of ['https://cafe.naver.com/f-e/cafes/31520563/menus/0', 'https://cafe.naver.com/petdilab', 'https://evil.example/cafes/1/menus/2', 'http://cafe.naver.com/f-e/cafes/1/menus/2', '']) assert.equal(cafeBoard(bad), null, bad);
});

test('본문 HTML: 큰따옴표 없이 줄바꿈·링크를 만들고 유튜브 링크 아래에 영상 재생기(embed)를 붙인다', () => {
  const html = cafeHtml('냥이 "기차놀이" <영상>이에요\nhttps://www.youtube.com/shorts/brRdeasE2K0\n자료 https://example.com/a?b=1&c=2.');
  assert.doesNotMatch(html, /"/, '큰따옴표가 있으면 카페 API가 403/999를 돌려준다');
  assert.match(html, /냥이 &quot;기차놀이&quot; &lt;영상&gt;이에요/);
  assert.match(html, /<a href='https:\/\/www\.youtube\.com\/shorts\/brRdeasE2K0'>/);
  assert.match(html, /<embed src='https:\/\/www\.youtube\.com\/v\/brRdeasE2K0' type='application\/x-shockwave-flash' width='315' height='560'>/);
  assert.match(html, /<a href='https:\/\/example\.com\/a\?b=1&amp;c=2'>https:\/\/example\.com\/a\?b=1&amp;c=2<\/a>\./, '문장 끝 마침표는 링크에서 뺀다');
  assert.equal((html.match(/<embed/g) || []).length, 1, '유튜브가 아닌 링크에는 재생기를 붙이지 않는다');
  assert.equal(cafeHtml("it's"), 'it&#39;s');
});

test('연결·글쓰기: PKCE+비밀값으로 토큰을 받아 암호화해 두고, 만료 전에 갱신하며 실패를 종류별로 나눈다', async (t) => {
  const { root, store } = workspace(t);
  const conn = store.create({ provider: 'naver', label: '업무' });
  let clock = 1_000_000;
  const calls = [];
  let reply = () => json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: '3600' });
  const fetch = async (url, init) => { calls.push({ url: String(url), init }); return reply(String(url), init); };
  const api = createNaverCafeApi({ root, store, fetch, now: () => clock });
  assert.equal(api.connected(conn.id), false);
  const { url } = api.start(conn.id);
  const auth = new URL(url);
  assert.equal(auth.origin + auth.pathname, 'https://nid.naver.com/oauth2/authorize');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:4777/oauth/naver/callback');
  const state = auth.searchParams.get('state');
  await assert.rejects(api.finish({ state: 'other', code: 'c' }), /만료|올바르지/);
  await api.finish({ state, code: 'code-1' });
  const exchange = new URLSearchParams(calls[0].init.body);
  assert.equal(exchange.get('client_secret'), 'fixture-secret', '네이버는 PKCE에도 client_secret이 필요하다(2026-11-09 실측)');
  assert.ok(exchange.get('code_verifier'));
  await assert.rejects(api.finish({ state, code: 'code-1' }), /만료|올바르지/, 'state는 한 번만 쓴다');
  assert.equal(api.connected(conn.id), true);
  // 토큰은 평문으로 남지 않는다
  const tokenDir = join(store.directory, 'naver-api');
  for (const name of readdirSync(tokenDir)) assert.doesNotMatch(readFileSync(join(tokenDir, name), 'utf8'), /access-1|refresh-1/);

  // 글쓰기 성공: 게시판 번호·작은따옴표 본문·전체 공개
  reply = () => json(200, { message: { status: '200', result: { articleId: 10754, articleUrl: 'https://cafe.naver.com/petdilab/10754' } } });
  const posted = await api.post(conn.id, { target: 'https://cafe.naver.com/f-e/cafes/31520563/menus/44', subject: '제목', body: '본문\nhttps://youtu.be/brRdeasE2K0' });
  assert.deepEqual(posted, { articleId: 10754, articleUrl: 'https://cafe.naver.com/petdilab/10754' });
  const sent = calls.at(-1);
  assert.equal(sent.url, 'https://openapi.naver.com/v1/cafe/31520563/menu/44/articles');
  assert.equal(sent.init.headers.Authorization, 'Bearer access-1');
  assert.equal(sent.init.body.get('openyn'), 'true');
  assert.doesNotMatch(decodeURIComponent(sent.init.body.get('content')), /"/);
  assert.match(decodeURIComponent(sent.init.body.get('content')), /youtube\.com\/v\/brRdeasE2K0/);

  // 만료 1분 전부터는 갱신 토큰으로 새 토큰을 받는다
  clock += 3600 * 1000;
  reply = (u) => u.includes('/oauth2/token') ? json(200, { access_token: 'access-2', expires_in: '3600' }) : json(200, { message: { result: { articleId: 1, articleUrl: 'https://cafe.naver.com/x/1' } } });
  await api.post(conn.id, { target: 'https://cafe.naver.com/f-e/cafes/1/menus/2', subject: 's', body: 'b' });
  assert.equal(new URLSearchParams(calls.at(-2).init.body).get('grant_type'), 'refresh_token');
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer access-2');

  const kind = async (respond) => { reply = respond; try { await api.post(conn.id, { target: 'https://cafe.naver.com/f-e/cafes/1/menus/2', subject: 's', body: 'b' }); return 'ok'; } catch (e) { assert.equal(e.code, 'NAVER_API'); return e.kind; } };
  assert.equal(await kind(() => json(401, { errorMessage: 'Authentication failed', errorCode: '024' })), 'auth');
  assert.equal(await kind(() => json(403, { message: { status: '500', error: { code: 'AP005', msg: '스팸' } } })), 'blocked');
  assert.equal(await kind(() => json(403, { message: { status: '500', error: { code: 'AP007', msg: '활동 정지' } } })), 'blocked');
  assert.equal(await kind(() => json(403, { message: { status: '500', error: { code: '999', msg: '오류가 발생하였습니다.' } } })), 'request');
  assert.equal(await kind(() => json(502, {})), 'uncertain');
  assert.equal(await kind(() => { throw new Error('socket hang up'); }), 'uncertain');
  await assert.rejects(api.post(conn.id, { target: 'https://cafe.naver.com/petdilab', subject: 's', body: 'b' }), (e) => e.kind === 'request' && /게시판 주소/.test(e.message));
  api.disconnect(conn.id);
  assert.equal(api.connected(conn.id), false);
});

test('게시 경로: API가 연결된 카페 글은 브라우저 없이 올리고, 실패해도 자동 전환하지 않으며 "브라우저로 진행"일 때만 브라우저로 간다', async (t) => {
  const { root, store } = workspace(t);
  const conn = store.create({ provider: 'naver', label: '업무' });
  store.update(conn.id, { status: 'connected', manualLoginAt: 'x' });
  let browserUsed = 0;
  const sessions = { withSession: async () => { browserUsed++; throw new Error('browser-path'); }, close: async () => {} };
  let outcome = () => ({ articleId: 1, articleUrl: 'https://cafe.naver.com/petdilab/1' });
  const posts = [];
  const cafeApi = { connected: () => true, status: () => ({ configured: true, connected: true }), post: async (id, input) => { posts.push(input); return outcome(); } };
  const work = createBrowserWork({ root, store, sessions, cafeApi });
  const base = { allowedActions: ['post'], instructionKey: 'k', signal: new AbortController().signal, execute: async () => 'x' };
  const publication = (id) => ({ id, action: 'post', service: 'naver_cafe', target: 'https://cafe.naver.com/f-e/cafes/1/menus/2', subject: `제목 ${id}`, connection: conn.id });

  const done = await work.deliver({ ...base, scope: 's1', publication: publication('a'), body: '본문' });
  assert.equal(done.status, 'confirmed'); assert.equal(done.method, 'api'); assert.equal(done.resultUrl, 'https://cafe.naver.com/petdilab/1');
  assert.equal(browserUsed, 0);
  assert.equal((await work.deliver({ ...base, scope: 's1', publication: publication('a'), body: '본문' })).status, 'confirmed', '같은 글은 다시 올리지 않는다');
  assert.equal(posts.length, 1);
  assert.equal(work.connections()[0].naverApi.connected, true);

  // 요청 거부(게시 안 됨): 멈추고 브라우저 우회를 제안한다. 대표가 "브라우저로 진행"이라고 답하면 브라우저로 간다
  outcome = () => { throw Object.assign(new Error('공식 API가 글쓰기를 거부했습니다(HTTP 403, 코드 999).'), { code: 'NAVER_API', kind: 'request', apiCode: '999' }); };
  await assert.rejects(work.deliver({ ...base, scope: 's2', publication: publication('b'), body: '본문' }), /브라우저로 진행/);
  assert.equal(browserUsed, 0, 'API 실패를 브라우저로 자동 전환하지 않는다');
  await assert.rejects(work.deliver({ ...base, scope: 's2', publication: publication('b'), body: '본문', viaBrowser: true }), /browser-path/);
  assert.equal(browserUsed, 1);

  // 계정 제한·인증 오류: 우회를 제안하지 않고 멈춘다
  for (const kind of ['blocked', 'auth']) {
    outcome = () => { throw Object.assign(new Error('막힘'), { code: 'NAVER_API', kind }); };
    await assert.rejects(work.deliver({ ...base, scope: `s-${kind}`, publication: publication(kind), body: '본문' }), (e) => /작업을 멈췄습니다/.test(e.message) && !/브라우저로 진행/.test(e.message));
  }

  // 결과 불확실: 다시 보내지 않고 기존 불확실 확인 절차로 멈춘다
  outcome = () => { throw Object.assign(new Error('응답 없음'), { code: 'NAVER_API', kind: 'uncertain' }); };
  await assert.rejects(work.deliver({ ...base, scope: 's3', publication: publication('c'), body: '본문' }), /미게시 확인, 재게시/);
  const before = posts.length;
  await assert.rejects(work.deliver({ ...base, scope: 's3', publication: publication('c'), body: '본문' }), /불확실/);
  assert.equal(posts.length, before, '불확실한 글은 대표 확인 없이 다시 보내지 않는다');

  // 블로그·댓글은 그대로 브라우저로 간다
  await assert.rejects(work.deliver({ ...base, allowedActions: ['comment'], scope: 's4', publication: { ...publication('d'), action: 'comment', target: 'https://cafe.naver.com/f-e/cafes/1/articles/3' }, body: '댓글' }), /browser-path/);
});

test('게시 경로: 장소(네이버 지도) 링크가 있는 글은 API가 연결돼 있어도 장소 카드를 만들 수 있게 브라우저로 올린다', async (t) => {
  const { root, store } = workspace(t);
  const conn = store.create({ provider: 'naver', label: '업무' });
  store.update(conn.id, { status: 'connected', manualLoginAt: 'x' });
  let browserUsed = 0;
  const sessions = { withSession: async () => { browserUsed++; throw new Error('browser-path'); }, close: async () => {} };
  const posts = [];
  const cafeApi = { connected: () => true, status: () => ({ configured: true, connected: true }), post: async (id, input) => { posts.push(input); return { articleId: posts.length, articleUrl: `https://cafe.naver.com/petdilab/${posts.length}` }; } };
  const work = createBrowserWork({ root, store, sessions, cafeApi });
  const base = { allowedActions: ['post'], instructionKey: 'k', signal: new AbortController().signal, execute: async () => 'x' };
  const publication = (id) => ({ id, action: 'post', service: 'naver_cafe', target: 'https://cafe.naver.com/f-e/cafes/1/menus/24', subject: `제목 ${id}`, connection: conn.id });

  for (const [id, place] of [['p1', 'https://map.naver.com/p/entry/place/1502417487'], ['p2', 'https://naver.me/AbCd1234'], ['p3', 'https://m.place.naver.com/place/1234567/home']]) {
    await assert.rejects(work.deliver({ ...base, scope: `place-${id}`, publication: { ...publication(id), kind: 'info' }, body: `이런 곳 좋아보여요~\n상호: 가상 펜션\n\n${place}` }), /browser-path/, place);
  }
  assert.equal(browserUsed, 3);
  assert.equal(posts.length, 0, '장소 글은 API로 올리지 않는다');

  // 유튜브 영상 글과 링크 없는 글은 API 그대로(영상 재생기는 API도 붙인다)
  assert.equal((await work.deliver({ ...base, scope: 'video', publication: publication('v'), body: '귀여운 영상이에요\n\nhttps://www.youtube.com/shorts/AbCdEfGhI_1' })).method, 'api');
  assert.equal((await work.deliver({ ...base, scope: 'plain', publication: publication('t'), body: '그냥 글이에요. 참고 https://cafe.naver.com/petdilab' })).method, 'api');
  assert.equal(posts.length, 2);
  assert.equal(browserUsed, 3);
});

test('서버: 공식 API 연결 시작은 네이버 계정에만, 콜백은 한 번 쓰는 state가 없으면 실패 화면을 보여 준다', async (t) => {
  const { startServer } = await import('../dashboard/server.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'office-cafe-api-server-')), root = join(temp, 'workspace');
  mkdirSync(join(root, '보관함'), { recursive: true }); writeFileSync(accountsFile(root), KEYS);
  const server = await startServer({ root, port: 0, quiet: true, connectionBase: join(temp, 'private'),
    env: { ...process.env, CLAUDE_BIN: join(temp, 'missing-claude'), CODEX_BIN: join(temp, 'missing-codex') } });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { Origin: base, 'X-Office-Token': server.token, 'Content-Type': 'application/json' };
  const request = async (path, method = 'GET', body) => { const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: res.status, data: await res.json() }; };
  const naver = (await request('/api/connections', 'POST', { provider: 'naver', label: '업무' })).data;
  const web = (await request('/api/connections', 'POST', { provider: 'web', label: 'ERP', startUrl: 'https://erp.example.com/' })).data;
  const listed = await request('/api/connections');
  assert.equal(listed.data.naverApiConfigured, true);
  assert.equal(listed.data.connections.find((c) => c.id === naver.id).naverApi.connected, false);
  const started = await request(`/api/connections/${naver.id}/naver-api`, 'POST');
  assert.equal(started.status, 200);
  assert.match(started.data.url, /^https:\/\/nid\.naver\.com\/oauth2\/authorize\?/);
  assert.doesNotMatch(started.data.url, /fixture-secret/, '동의 주소에 비밀값을 싣지 않는다');
  assert.equal((await request(`/api/connections/${web.id}/naver-api`, 'POST')).status, 400);
  const callback = await fetch(`${base}/oauth/naver/callback?state=forged&code=x`);
  assert.equal(callback.status, 400);
  assert.match(await callback.text(), /연결 실패/);
});
