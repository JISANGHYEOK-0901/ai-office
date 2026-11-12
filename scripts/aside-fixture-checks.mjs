#!/usr/bin/env node
// 실제 Aside(앱·CLI·연결 구독)로 Aside 직원의 외부 작업을 가짜 로컬 사이트에서만 검증한다. 바깥 사이트에는 아무것도 보내지 않는다.
//   node scripts/aside-fixture-checks.mjs [comment,post,mail,web]
// Aside 에이전트를 실제로 띄우므로 연결한 구독 사용량을 쓴다(작업 하나에 1~2분).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASIDE_CONNECTION, asideExecArgs, asidePublishPrompt, createAside, parseExecOutput } from '../lib/aside.mjs';
import { createBrowserWork } from '../lib/browser-work.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

// 카페(글·댓글), 메일(쓰기·보낸메일함·상세), 관리 화면(일반 웹사이트 작업)을 흉내 낸 서버. 상태는 메모리에 둔다
function fixtureSite() {
  const state = { comments: ['첫 댓글입니다'], posts: [], mails: [], vendors: [], hits: { comment: 0, post: 0, mail: 0, web: 0 } };
  const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (title, body) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page(title, body)); };
    if (req.method === 'POST' && url.pathname === '/cafe/comment') {
      const text = new URLSearchParams((await readBody(req)).toString()).get('text') || '';
      state.hits.comment++; if (text.trim()) state.comments.push(text);
      res.writeHead(303, { Location: '/cafe/article/1' }); res.end(); return;
    }
    if (url.pathname === '/cafe/article/1') return html('고양이가 상자를 좋아하는 이유', `<p>작성자: 홍시주스</p><p>상자 안은 따뜻하고 안전하게 느껴집니다.</p>
      <h2>댓글</h2><ul id="comments">${state.comments.map((c) => `<li class="text_comment">${esc(c)}</li>`).join('')}</ul>
      <form method="post" action="/cafe/comment"><textarea name="text" placeholder="댓글을 남겨보세요"></textarea><button>등록</button></form>`);
    if (url.pathname === '/cafe/board') return html('별지기 쉼터 수다방', `<a href="/cafe/write">글쓰기</a><ul>${state.posts.map((p, i) => `<li><a href="/cafe/article/p${i}">${esc(p.subject)}</a></li>`).join('')}</ul>`);
    if (req.method === 'POST' && url.pathname === '/cafe/write') {
      const form = new URLSearchParams((await readBody(req)).toString());
      state.hits.post++; state.posts.push({ subject: form.get('subject') || '', body: form.get('body') || '' });
      res.writeHead(303, { Location: `/cafe/article/p${state.posts.length - 1}` }); res.end(); return;
    }
    if (url.pathname === '/cafe/write') return html('카페 글쓰기', `<form method="post" action="/cafe/write"><label>제목<input name="subject"></label><label>본문<textarea name="body" rows="8"></textarea></label><button>등록</button></form>`);
    const article = url.pathname.match(/^\/cafe\/article\/p(\d+)$/);
    if (article && state.posts[article[1]]) { const p = state.posts[article[1]]; return html(p.subject, `<article><h2>${esc(p.subject)}</h2><div class="body">${esc(p.body).replace(/\n/g, '<br>')}</div></article>`); }
    if (url.pathname === '/w/compose') return html('메일쓰기', `<form method="post" action="/w/send" enctype="multipart/form-data">
      <p>보내는 주소: me@fixture.invalid</p><label>받는사람<input name="to"></label><label>제목<input name="subject"></label>
      <label>본문<textarea name="body" rows="8"></textarea></label><label>파일첨부<input type="file" name="files" multiple></label><button>보내기</button></form>`);
    if (req.method === 'POST' && url.pathname === '/w/send') {
      const raw = (await readBody(req)).toString('latin1');
      const field = (name) => Buffer.from((raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`)) || [])[1] || '', 'latin1').toString('utf8');
      const files = [...raw.matchAll(/name="files"; filename="([^"]+)"/g)].map((m) => Buffer.from(m[1], 'latin1').toString('utf8')).filter(Boolean);
      state.hits.mail++; state.mails.push({ id: String(1000 + state.mails.length), to: field('to'), subject: field('subject'), body: field('body'), files });
      return html('메일을 보냈습니다', '<p>메일을 보냈습니다</p><a href="/w/sent">보낸메일함</a>');
    }
    if (url.pathname === '/w/sent') return html('보낸메일함', `<ul>${state.mails.map((m) => `<li><a href="/read/popup?nMailId=${m.id}">${esc(m.subject)}</a></li>`).join('')}</ul>`);
    if (url.pathname === '/read/popup') {
      const m = state.mails.find((x) => x.id === url.searchParams.get('nMailId'));
      if (!m) return html('없는 메일', '');
      return html(m.subject, `<p>보낸사람 나&lt;me@fixture.invalid&gt;</p><p>받는사람 상대&lt;${esc(m.to)}&gt;</p><p>첨부: ${esc(m.files.join(', ') || '없음')}</p><div>${esc(m.body).replace(/\n/g, '<br>')}</div>`);
    }
    if (req.method === 'POST' && url.pathname === '/admin/vendors') {
      const name = new URLSearchParams((await readBody(req)).toString()).get('name') || '';
      state.hits.web++; if (name.trim()) state.vendors.push(name.trim());
      res.writeHead(303, { Location: '/admin/vendors' }); res.end(); return;
    }
    if (url.pathname === '/admin/vendors') return html('제휴 업체 관리', `<ul>${state.vendors.map((v) => `<li>${esc(v)}</li>`).join('')}</ul><form method="post" action="/admin/vendors"><label>업체 이름<input name="name"></label><button>저장</button></form>`);
    res.writeHead(404); res.end('없음');
  });
  return { server, state };
}

export async function verifyAside({ only = ['comment', 'post', 'mail', 'web'], log = console.log } = {}) {
  const aside = createAside();
  if (!aside.installed()) throw new Error('Aside CLI가 없습니다. GUIDE.html "Aside 설치·세팅"을 따라 설치한 뒤 다시 실행하세요.');
  const temp = mkdtempSync(join(tmpdir(), 'office-aside-fixture-')), root = join(temp, 'workspace'); mkdirSync(root);
  const { server, state } = fixtureSite();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // 실제 연결 저장소처럼 없는 계정(aside)을 조회하면 오류를 낸다
  const store = { list: () => [], find: () => { throw new Error('연결 계정을 찾을 수 없습니다.'); }, credentials: () => { throw new Error('연결 계정을 찾을 수 없습니다.'); }, directory: join(temp, 'private') };
  const work = createBrowserWork({ root, store, sessions: { close: async () => {} }, aside, asideSentUrl: `${origin}/w/sent`, providersForTests: (_provider, url) => new URL(url).origin === origin });
  const results = [];
  // 실제 Aside 에이전트 실행: 실행기와 같은 지시문(asidePublishPrompt)을 쓴다
  const agent = (publication, body) => async (_browser, extra = {}) => {
    const prompt = `당신은 Aside 브라우저 직원이다. 파일을 읽거나 쓰지 않고 결과를 마지막 JSON 응답에 담는다. 이것은 로컬 검증용 가짜 사이트(${origin})다.\n\n${asidePublishPrompt({ publication, body, files: extra.files || [] })}`;
    const started = Date.now();
    const { stdout } = await aside.run(asideExecArgs(prompt, { timeout: '10m' }), { timeoutMs: 11 * 60 * 1000 });
    const out = parseExecOutput(stdout);
    log(`  - Aside 직원 ${Math.round((Date.now() - started) / 1000)}초 · ${out?.outcome || '응답 없음'}`);
    return out?.answer || '';
  };
  const run = async (name, publication, body, files = []) => {
    if (!only.includes(name)) return;
    log(`▶ ${name}`);
    const started = Date.now();
    try {
      const record = await work.deliver({ scope: 'aside-fixture', publication: { connection: ASIDE_CONNECTION, recipients: [], subject: '', ...publication }, body, allowedActions: ['mail', 'post', 'comment', 'web'],
        instructionKey: 'fixture', signal: new AbortController().signal, engine: 'aside', files, execute: agent(publication, body) });
      results.push({ name, ok: true, status: record.status, confirmedBy: record.confirmedBy, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (error) {
      results.push({ name, ok: false, error: error.message.slice(0, 300), seconds: Math.round((Date.now() - started) / 1000) });
    }
  };
  try {
    await run('comment', { id: 'fx-comment', action: 'comment', service: 'naver_cafe', target: `${origin}/cafe/article/1`, targetTitle: '고양이가 상자를 좋아하는 이유' }, '상자 사랑은 진리죠, 잘 보고 갑니다 :)');
    await run('post', { id: 'fx-post', action: 'post', service: 'naver_cafe', target: `${origin}/cafe/board`, subject: '오늘의 집사 일기' }, '오늘은 고양이가 새 상자를 발견했습니다.\n\n한참을 들어가 앉아 있었어요.');
    const attachment = join(temp, '제휴제안서.txt'); writeFileSync(attachment, '제휴 제안 내용(검증용)');
    await run('mail', { id: 'fx-mail', action: 'mail', service: 'naverworks_mail', target: `${origin}/w/compose`, recipients: ['partner@fixture.invalid'], subject: '꼬리별관측소 제휴 제안드립니다' },
      '안녕하세요, 꼬리별관측소입니다.\n제휴를 제안드립니다. 첨부 자료를 확인 부탁드립니다.', [{ name: '제휴제안서.txt', path: attachment }]);
    await run('web', { id: 'fx-web', action: 'web', service: 'web', target: `${origin}/admin/vendors` }, '업체 이름 칸에 "ai-office-test 상점"을 입력하고 저장한다. 저장 뒤 목록에 그 이름이 보이는지 확인한다.');
    // 사이트에 실제로 남은 결과(한 번만 등록됐는지)
    const checks = {
      comment: () => assert.equal(state.comments.filter((c) => c === '상자 사랑은 진리죠, 잘 보고 갑니다 :)').length, 1, '댓글이 정확히 한 번 등록돼야 한다'),
      post: () => assert.equal(state.posts.filter((p) => p.subject === '오늘의 집사 일기').length, 1, '글이 정확히 한 번 올라가야 한다'),
      mail: () => { assert.equal(state.mails.length, 1, '메일은 한 통'); assert.deepEqual(state.mails[0].files, ['제휴제안서.txt'], '첨부 파일이 붙어야 한다'); },
      web: () => assert.equal(state.vendors.filter((v) => v === 'ai-office-test 상점').length, 1, '업체가 한 번 저장돼야 한다'),
    };
    for (const r of results) { try { checks[r.name](); r.siteOk = true; } catch (error) { r.siteOk = false; r.siteError = error.message; } }
    return { results, hits: state.hits };
  } finally {
    await work.close?.().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = (process.argv[2] || 'comment,post,mail,web').split(',').map((s) => s.trim()).filter(Boolean);
  const { results, hits } = await verifyAside({ only });
  for (const r of results) console.log(`${r.ok && r.siteOk ? '✔' : '✖'} ${r.name}: ${r.ok ? `${r.status}(${r.confirmedBy})` : r.error} · 사이트 ${r.siteOk ? '정상' : r.siteError || '확인 안 함'} · ${r.seconds}초`);
  console.log(`가짜 사이트 요청 수: ${JSON.stringify(hits)}`);
  process.exit(results.every((r) => r.ok && r.siteOk) ? 0 : 1);
}
