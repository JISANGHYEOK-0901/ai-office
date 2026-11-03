// 메일 편집기의 기본 서명(명함 이미지)을 지우지 않고 본문을 넣는지, 보낸메일함 목록으로 발송 완료를 확인하는지 가짜 화면에서만 검증한다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnectionStore } from '../lib/connections.mjs';
import { createBrowserWork } from '../lib/browser-work.mjs';

// 실제 메일 화면(네이버웍스)처럼 본문 편집기를 about:blank 프레임에 스크립트로 채운다
const EDITOR = `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body>
<div id="editor" contenteditable="true" aria-label="본문"><p><br></p><div class="signature"><img alt="명함" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><table><tr><td tabindex="0">운영팀 매니저</td></tr></table></div></div></body></html>`;
const COMPOSE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>메일 쓰기</title></head><body>
<label>받는 사람<input name="to"></label><label>제목<input name="subject"></label>
<iframe id="frame" title="본문 편집 영역" style="width:600px;height:200px"></iframe>
<script>(async()=>{const d=document.getElementById('frame').contentDocument;d.open();d.write(await (await fetch('/editor')).text());d.close();})();</script>
<button id="send">보내기</button>
<script>document.getElementById('send').onclick=async()=>{const e=document.getElementById('frame').contentDocument.getElementById('editor');
await fetch('/sent-mail',{method:'POST',body:JSON.stringify({to:document.querySelector('[name=to]').value,subject:document.querySelector('[name=subject]').value,text:e.innerText,img:!!e.querySelector('img[alt=명함]')})});
location.href='/sent';};</script></body></html>`;

export async function verifyMailEditor() {
  const temp = mkdtempSync(join(tmpdir(), 'office-mail-editor-')), root = join(temp, 'workspace'); mkdirSync(root);
  let browser, broker, site;
  const sent = [];
  try {
    site = createServer(async (req, res) => {
      if (req.method === 'POST') { let b = ''; for await (const c of req) b += c; sent.push(JSON.parse(b)); res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/editor' ? EDITOR : req.url === '/sent' ? `<!doctype html><html lang="ko"><body><h1>보낸메일함</h1><table><tr><td>${sent.at(-1)?.to || ''}</td><td>${sent.at(-1)?.subject || ''}</td><td>오늘</td></tr></table></body></html>` : COMPOSE);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${site.address().port}`;
    browser = await chromium.launch();
    const store = createConnectionStore({ root, base: join(temp, 'private') });
    const account = store.create({ provider: 'naverworks', label: '메일' }); store.update(account.id, { status: 'connected' });
    const sessions = { async withSession(_id, target, _signal, action) {
      const context = await browser.newContext(); await context.newPage(); await context.pages()[0].goto(target);
      try { return await action(context); } finally { await context.close(); }
    }, close: async () => {} };
    broker = createBrowserWork({ root, store, sessions, providersForTests: (_provider, url) => new URL(url).origin === origin });
    const body = 'AI Office 자동 메일 발송 기능을 시험하는 메일입니다.';
    const result = await broker.deliver({ scope: 'mail-editor', allowedActions: ['mail'], instructionKey: 'k', signal: new AbortController().signal, body,
      publication: { id: 'm1', action: 'mail', service: 'naverworks_mail', connection: account.id, target: `${origin}/compose`, recipients: ['fixture@example.invalid'], subject: 'AI Office 메일 발송 테스트' },
      execute: async ({ url, token }) => {
        const call = async (name, args = {}) => {
          const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
          const data = await r.json(); if (data.error) throw new Error(`${name}: ${data.error}`); return data.result;
        };
        const refs = Object.fromEntries((await call('browser_snapshot')).frames.flatMap((f) => f.controls).map((c) => [c.label, c.ref]));
        // 칸 종류가 맞지 않으면 거부한다(본문을 받는사람·제목 칸에, 제목을 본문 편집기에 넣지 않음)
        await assert.rejects(call('browser_fill_content', { ref: refs.to, field: 'body' }), /본문 편집기/);
        await assert.rejects(call('browser_fill_content', { ref: refs.subject, field: 'body' }), /본문 편집기/);
        await assert.rejects(call('browser_fill_content', { ref: refs['본문'], field: 'subject' }), /제목 칸/);
        await assert.rejects(call('browser_fill_content', { ref: refs.subject, field: 'recipients' }), /받는사람/);
        await call('browser_fill_content', { ref: refs.to, field: 'recipients' });
        await call('browser_fill_content', { ref: refs.subject, field: 'subject' });
        // 서명 표 칸을 본문 칸으로 골라도 편집기 전체의 맨 앞에 들어가야 한다(실제 네이버웍스 실측 결함)
        const filled = await call('browser_fill_content', { ref: refs['운영팀 매니저'], field: 'body' });
        assert.match(filled.kept || '', /서명/);
        assert.match((await call('browser_text')).text, /자동 메일 발송 기능을 시험/, '직원이 화면 글자 읽기로 편집기 본문을 확인할 수 있다');
        const again = Object.fromEntries((await call('browser_snapshot')).frames.flatMap((f) => f.controls).map((c) => [c.label, c.ref]));
        assert.match((await call('browser_fill_content', { ref: again['본문'], field: 'body' })).note || '', /이미 입력/, '본문을 두 번 넣지 않는다');
        Object.assign(refs, again);
        await call('browser_submit', { ref: refs['보내기'] });
        await call('browser_finish'); return 'done';
      } });
    assert.equal(result.status, 'confirmed', '보낸메일함의 제목·수신자로 발송 완료를 확인한다');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].img, true, '기본 서명(명함 이미지)을 지우지 않는다');
    assert.ok(sent[0].text.startsWith(body), '본문은 서명 앞에 들어간다');
    assert.match(sent[0].text, /운영팀 매니저/);
    assert.equal(sent[0].subject, 'AI Office 메일 발송 테스트', '본문이 제목 칸에 섞이지 않는다');
    return [{ name: '메일 편집기: 기본 서명·명함 이미지 유지, 본문 1회 입력, 보낸메일함으로 발송 확인', interaction: 'click', passed: true }];
  } finally {
    await broker?.close(); await browser?.close(); site?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// 카페 글쓰기처럼 제목이 textarea이고, 입력은 안쪽 프레임의 숨은 편집 칸이 받아 붙여넣기만 처리해 링크 카드를 만드는 편집기
const CAFE_INPUT = `<!doctype html><html lang="ko"><body><div id="capture" contenteditable="true" style="width:17px;height:200px"></div>
<script>document.getElementById('capture').addEventListener('paste',(e)=>{e.preventDefault();const t=e.clipboardData.getData('text/plain');const doc=parent.document;
const p=doc.createElement('p');p.className='text';p.textContent=t;doc.getElementById('content').appendChild(p);
if(/youtube\\.com\\/shorts\\//.test(t)){const c=doc.createElement('div');c.className='card';c.textContent='영상 카드';doc.getElementById('content').appendChild(c);}});
document.getElementById('capture').addEventListener('beforeinput',(e)=>e.preventDefault());</script></body></html>`;
const CAFE_WRITE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>카페 글쓰기</title></head><body>
<button id="board" type="button" onclick="this.textContent='수다방 선택됨'">게시판 선택</button>
<textarea id="title" placeholder="제목을 입력해 주세요." rows="2"></textarea>
<div id="content" onclick="document.getElementById('frame').contentDocument.getElementById('capture').focus()"><p class="placeholder">내용을 입력하세요.</p></div>
<iframe id="frame" src="/cafe-input" title="입력" style="width:20px;height:20px"></iframe>
<button id="submit" type="button">등록</button>
<script>document.getElementById('submit').onclick=async()=>{const texts=[...document.querySelectorAll('#content .text')].map(p=>p.textContent).join('\\n');
await fetch('/cafe-post',{method:'POST',body:JSON.stringify({board:document.getElementById('board').textContent,title:document.getElementById('title').value,text:texts,card:!!document.querySelector('#content .card')})});location.href='/cafe-article';};</script></body></html>`;

export async function verifyCafeEditor() {
  const temp = mkdtempSync(join(tmpdir(), 'office-cafe-editor-')), root = join(temp, 'workspace'); mkdirSync(root);
  let browser, broker, site;
  const posts = [];
  try {
    site = createServer(async (req, res) => {
      if (req.method === 'POST') { let b = ''; for await (const c of req) b += c; posts.push(JSON.parse(b)); res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const last = posts.at(-1);
      res.end(req.url === '/cafe-input' ? CAFE_INPUT : req.url === '/cafe-article' ? `<!doctype html><html lang="ko"><body><h1>${last?.title || ''}</h1><p>${last?.text || ''}</p>${last?.card ? '<div>영상 카드</div>' : ''}</body></html>` : CAFE_WRITE);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${site.address().port}`;
    browser = await chromium.launch();
    const store = createConnectionStore({ root, base: join(temp, 'private') });
    const account = store.create({ provider: 'naver', label: '카페' }); store.update(account.id, { status: 'connected' });
    const sessions = { async withSession(_id, target, _signal, action) {
      const context = await browser.newContext(); await context.newPage(); await context.pages()[0].goto(target);
      try { return await action(context); } finally { await context.close(); }
    }, close: async () => {} };
    broker = createBrowserWork({ root, store, sessions, providersForTests: (_provider, url) => new URL(url).origin === origin });
    const body = 'https://www.youtube.com/shorts/AbCdEfGhI_1';
    const result = await broker.deliver({ scope: 'cafe-editor', allowedActions: ['post'], instructionKey: 'k', signal: new AbortController().signal, body,
      publication: { id: 'c1', action: 'post', service: 'naver_cafe', connection: account.id, target: `${origin}/write`, recipients: [], subject: '강아지 반응이 너무 웃기네요ㅎㅎ' },
      execute: async ({ url, token }) => {
        const call = async (name, args = {}) => {
          const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
          const data = await r.json(); if (data.error) throw new Error(`${name}: ${data.error}`); return data.result;
        };
        const controls = (await call('browser_snapshot')).frames.flatMap((f) => f.controls);
        const ref = (pattern) => controls.find((c) => pattern.test(c.label))?.ref;
        // 게시판 선택 버튼은 되돌리기 어려운 최종 버튼이 아니다
        await call('browser_click', { ref: ref(/게시판 선택/) });
        // 제목 칸이 textarea여도 제목 단서가 있으면 제목으로 넣는다
        await call('browser_fill_content', { ref: ref(/제목을 입력/), field: 'subject' });
        await assert.rejects(call('browser_fill_content', { ref: ref(/제목을 입력/), field: 'body' }), /본문 편집기/, '본문은 제목 칸에 넣지 않는다');
        // 숨은 입력 칸에 붙여넣기로 넣어 편집기가 링크를 영상 카드로 바꾸게 한다
        const filled = await call('browser_fill_content', { ref: controls.find((c) => c.editable)?.ref, field: 'body' });
        assert.match(filled.kept || '', /입력 확인됨/);
        await call('browser_submit', { ref: ref(/^등록$/) });
        await call('browser_finish'); return 'done';
      } });
    assert.equal(result.status, 'confirmed', '글 화면에 제목·본문이 보이면 게시 완료로 확인한다');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].board, '수다방 선택됨');
    assert.equal(posts[0].title, '강아지 반응이 너무 웃기네요ㅎㅎ');
    assert.equal(posts[0].text, body, '본문은 한 번만 들어간다');
    assert.equal(posts[0].card, true, '붙여넣기로 넣어 링크가 영상 카드가 된다');
    return [{ name: '카페 편집기: textarea 제목, 게시판 선택 클릭, 붙여넣기로 영상 카드, 등록 확인', interaction: 'click', passed: true }];
  } finally {
    await broker?.close(); await browser?.close(); site?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
