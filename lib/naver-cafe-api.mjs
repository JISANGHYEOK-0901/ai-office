// 네이버 카페 공식 글쓰기 API(https://developers.naver.com/docs/login/cafe-api/cafe-api.md).
// 브라우저 게시와 따로 쓰는 도구다. 앱 키는 보관함/계정.env의 NAVER_API_CLIENT·NAVER_API_SECRET·NAVER_API_CALLBACK에서 읽고,
// 계정별 토큰은 연결 저장소(작업 공간 밖)에 암호화해 둔다. 토큰·코드·비밀값은 응답·로그에 싣지 않는다.
// 2026-11-09 실측: PKCE 토큰도 글쓰기에 쓸 수 있지만 토큰 교환에 client_secret이 필요하다(없으면 invalid_client).
// 본문 HTML 속성을 큰따옴표로 감싸면 403/999가 난다. iframe은 지워지고 <embed src='https://www.youtube.com/v/ID'>는 영상 재생기로 보인다.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';
import { accountsFile } from './vault.mjs';
import { youtubeVideoIds } from './video-history.mjs';

const AUTH_BASE = 'https://nid.naver.com/oauth2';
const API_BASE = 'https://openapi.naver.com/v1/cafe';
const PENDING_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 60 * 1000;

// 계정 제한·권한 문제: 브라우저로 올려도 같은 이유로 막히므로 우회를 제안하지 않고 멈춘다
const BLOCKED = {
  '0005': '비공개 카페의 멤버가 아닙니다.', CA002: '네이버 아이디가 이용 정지 상태입니다.', AP002: '접근 제한 중인 게시판입니다.',
  AP003: '이 계정 등급으로는 쓸 수 없는 게시판입니다.', AP004: '글쓰기를 허용하지 않는 게시판입니다.', AP005: '카페의 금칙어·스팸 자동 차단으로 스팸 보관함으로 옮겨졌습니다.',
  AP006: '카페가 존재하지 않습니다.', AP007: '이 카페에서 활동 정지 상태입니다.', AP008: '네이버 아이디가 이용 정지 상태입니다.',
};

export class NaverApiError extends Error {
  // kind: setup(앱 키·연결 없음) | auth(토큰 만료·권한 없음) | blocked(계정·게시판 제한) | request(요청 거부, 게시 안 됨) | uncertain(보냈는데 결과 모름)
  constructor(kind, message, apiCode = '') { super(message); this.code = 'NAVER_API'; this.kind = kind; this.apiCode = apiCode; }
}

// 보관함/계정.env에서 앱 키만 읽는다(계정 항목 _URL/_ID/_PASSWORD와 겹치지 않는 이름)
export function naverApiApp(root) {
  const file = accountsFile(root);
  if (!existsSync(file)) return null;
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?NAVER_API_(CLIENT|SECRET|CALLBACK)\s*=\s*(.*)$/);
    if (m) values[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!values.CLIENT || !values.SECRET || !values.CALLBACK) return null;
  let callback;
  try { callback = new URL(values.CALLBACK); } catch { return null; }
  // 콜백은 이 컴퓨터의 대시보드로만 받는다
  if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(callback.hostname)) return null;
  return { clientId: values.CLIENT, secret: values.SECRET, callback: callback.toString() };
}

// 게시판 주소에서 카페·게시판 번호를 읽는다. 새 카페 주소(/cafes/<카페>/menus/<게시판>)와 예전 주소(clubid=·menuid=)를 받는다
export function cafeBoard(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'https:' || !/(^|\.)cafe\.naver\.com$/.test(url.hostname)) return null;
  const path = url.pathname.match(/\/cafes\/(\d+)\/menus\/(\d+)/);
  const clubid = path?.[1] || url.searchParams.get('clubid') || url.searchParams.get('search.clubid');
  const menuid = path?.[2] || url.searchParams.get('menuid') || url.searchParams.get('search.menuid');
  // 전체글보기(0)에는 글을 쓸 수 없다
  return /^\d+$/.test(clubid || '') && /^[1-9]\d*$/.test(menuid || '') ? { clubid, menuid } : null;
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '%27').replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
// 검토된 원문(일반 글자)을 카페 API 본문 HTML로 바꾼다. 줄바꿈은 <br>, 링크는 <a>, 유튜브 링크 아래에는 영상 재생기(<embed>)를 붙인다.
// 속성은 모두 작은따옴표로 감싸고 본문 글자의 따옴표는 문자 참조로 바꿔 큰따옴표가 남지 않게 한다
export function cafeHtml(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    let html = '', last = 0;
    const embeds = [];
    for (const match of line.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
      const url = match[0].replace(/[.,;:!?…)\]]+$/, '');
      html += escapeText(line.slice(last, match.index)) + `<a href='${escapeAttr(url)}'>${escapeText(url)}</a>`;
      last = match.index + url.length;
      const [id] = youtubeVideoIds(url);
      if (id && /^[\w-]{6,20}$/.test(id)) embeds.push(`<embed src='https://www.youtube.com/v/${id}' type='application/x-shockwave-flash' width='315' height='560'>`);
    }
    html += escapeText(line.slice(last));
    out.push(html, ...embeds.flatMap((e) => ['', e]));
  }
  return out.join('<br>\n');
}

const b64url = (buf) => buf.toString('base64url');

export function createNaverCafeApi({ root, store, fetch = globalThis.fetch, now = () => Date.now() }) {
  const pending = new Map();
  const tokenFile = (id) => join(store.directory, 'naver-api', `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.json`);
  const load = (id) => { const record = readPrivate(tokenFile(id), null); if (!record?.sealed) return null; try { return { ...record, ...store.unseal(record.sealed) }; } catch { return null; } };
  const save = (id, token) => writePrivate(tokenFile(id), { connectedAt: token.connectedAt, expiresAt: token.expiresAt, sealed: store.seal({ access: token.access, refresh: token.refresh }) });
  const app = () => naverApiApp(root);
  const requireApp = () => { const a = app(); if (!a) throw new NaverApiError('setup', '보관함/계정.env에 NAVER_API_CLIENT·NAVER_API_SECRET·NAVER_API_CALLBACK을 넣어 주세요.'); return a; };

  async function tokenRequest(params) {
    const a = requireApp();
    let res, json;
    try {
      res = await fetch(`${AUTH_BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: a.clientId, client_secret: a.secret, ...params }) });
      json = await res.json().catch(() => ({}));
    } catch { throw new NaverApiError('auth', '네이버 로그인 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.'); }
    if (!res.ok || !json.access_token) throw new NaverApiError('auth', `네이버 로그인 토큰을 받지 못했습니다(${json.error || res.status}). 계정 연결에서 공식 API를 다시 연결해 주세요.`);
    return json;
  }

  async function accessToken(id) {
    const token = load(id);
    if (!token) throw new NaverApiError('auth', '이 계정은 공식 API가 연결되지 않았습니다. 계정 연결에서 "공식 API 연결"을 해 주세요.');
    if (token.expiresAt - REFRESH_EARLY_MS > now()) return token.access;
    if (!token.refresh) throw new NaverApiError('auth', '공식 API 인증이 만료됐습니다. 계정 연결에서 공식 API를 다시 연결해 주세요.');
    const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh });
    const next = { ...token, access: json.access_token, refresh: json.refresh_token || token.refresh, expiresAt: now() + Number(json.expires_in || 3600) * 1000 };
    save(id, next);
    return next.access;
  }

  return {
    configured: () => Boolean(app()),
    connected: (id) => Boolean(load(id)),
    status: (id) => { const t = load(id); return { configured: Boolean(app()), connected: Boolean(t), connectedAt: t?.connectedAt || null }; },
    // 네이버 로그인 동의 화면 주소를 만든다. 카페 글쓰기는 [선택] 동의라 사용자가 꼭 체크해야 한다
    start(id) {
      const a = requireApp();
      store.find(id);
      for (const [key, value] of pending) if (value.createdAt + PENDING_MS < now()) pending.delete(key);
      const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(32));
      pending.set(state, { id, verifier, createdAt: now() });
      const q = new URLSearchParams({ response_type: 'code', client_id: a.clientId, redirect_uri: a.callback, state, scope: 'openid',
        code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', auth_type: 'reprompt' });
      return { url: `${AUTH_BASE}/authorize?${q}` };
    },
    // 콜백: state는 한 번만 쓴다
    async finish({ state, code, error }) {
      const entry = pending.get(String(state || ''));
      pending.delete(String(state || ''));
      if (!entry || entry.createdAt + PENDING_MS < now()) throw new NaverApiError('auth', '연결 요청이 만료됐거나 올바르지 않습니다. 계정 연결에서 다시 시도해 주세요.');
      if (error || !code) throw new NaverApiError('auth', '네이버 로그인 동의가 취소됐습니다.');
      const json = await tokenRequest({ grant_type: 'authorization_code', code: String(code), state: String(state), redirect_uri: requireApp().callback, code_verifier: entry.verifier });
      save(entry.id, { access: json.access_token, refresh: json.refresh_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000, connectedAt: new Date(now()).toISOString() });
      return { id: entry.id };
    },
    disconnect(id) { rmSync(tokenFile(id), { force: true }); return { removed: true }; },
    // 글 한 건. 성공하면 { articleId, articleUrl }. 실패는 NaverApiError(kind)로 나눈다
    async post(id, { target, subject, body }) {
      const board = cafeBoard(target);
      if (!board) throw new NaverApiError('request', '공식 API로 올리려면 게시판 주소(https://cafe.naver.com/f-e/cafes/<카페 번호>/menus/<게시판 번호>)가 필요합니다.');
      if (!String(subject || '').trim()) throw new NaverApiError('request', '공식 API 게시에는 제목이 필요합니다.');
      const access = await accessToken(id);
      const form = new FormData();
      form.set('subject', encodeURIComponent(String(subject).trim()));
      form.set('content', encodeURIComponent(cafeHtml(body)));
      form.set('openyn', 'true');
      form.set('searchopen', 'true');
      let res, text;
      try {
        res = await fetch(`${API_BASE}/${board.clubid}/menu/${board.menuid}/articles`, { method: 'POST', headers: { Authorization: `Bearer ${access}` }, body: form });
        text = await res.text();
      } catch { throw new NaverApiError('uncertain', '공식 API 응답을 받지 못해 게시 여부를 알 수 없습니다. 카페에서 글이 올라갔는지 확인해 주세요.'); }
      let json = {}; try { json = JSON.parse(text); } catch { /* 응답이 JSON이 아님 */ }
      const result = json.message?.result;
      if (res.ok && result?.articleUrl) return { articleId: result.articleId, articleUrl: String(result.articleUrl) };
      const apiCode = String(json.message?.error?.code || json.errorCode || '');
      if (res.status === 401 || /^0?24$/.test(apiCode) || (res.status === 403 && /권한/.test(json.errorMessage || ''))) throw new NaverApiError('auth', '공식 API 인증이 만료됐거나 카페 글쓰기 권한이 없습니다. 계정 연결에서 공식 API를 다시 연결해 주세요(카페 가입·글쓰기 항목에 동의).', apiCode);
      if (BLOCKED[apiCode]) throw new NaverApiError('blocked', `카페가 글쓰기를 막았습니다: ${BLOCKED[apiCode]}`, apiCode);
      if (res.status >= 500 && !apiCode) throw new NaverApiError('uncertain', `공식 API가 서버 오류(${res.status})를 돌려줘 게시 여부를 알 수 없습니다. 카페에서 글이 올라갔는지 확인해 주세요.`);
      throw new NaverApiError('request', `공식 API가 글쓰기를 거부했습니다(HTTP ${res.status}${apiCode ? `, 코드 ${apiCode}` : ''}${json.message?.error?.msg ? `: ${json.message.error.msg}` : ''}).`, apiCode);
    },
  };
}
