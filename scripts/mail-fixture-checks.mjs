// 메일 편집기의 기본 서명(명함 이미지)을 지우지 않고 본문을 넣는지, 보낸메일함 목록으로 발송 완료를 확인하는지 가짜 화면에서만 검증한다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
// 실제 편집기처럼 링크를 단독으로 붙여넣을 때만 영상·장소 카드가 되고, 글과 섞이면 글자로 남는다
if(/^https:\\/\\/(?:www\\.youtube\\.com\\/shorts|naver\\.me)\\/\\S+$/.test(t.trim())){const c=doc.createElement('div');c.className='card';c.textContent='링크 카드';doc.getElementById('content').appendChild(c);return;}
const p=doc.createElement('p');p.className='text';p.textContent=t;doc.getElementById('content').appendChild(p);});
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
      // 실제 카페 글 화면처럼 줄마다 문단을 만들고 빈 줄은 폭 없는 공백(U+200B)만 든 문단으로 보여 준다
      const paragraphs = (last?.text || '').replace(/\n+$/, '').split('\n').map((line) => `<p>${line || '\u200B'}</p>`).join('');
      res.end(req.url === '/cafe-input' ? CAFE_INPUT : req.url === '/cafe-article' ? `<!doctype html><html lang="ko"><body><h1>${last?.title || ''}</h1>${paragraphs}${last?.card ? '<div>영상 카드</div>' : ''}</body></html>` : CAFE_WRITE);
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
    // 유튜브 영상 글과 네이버 지도(플레이스) 장소 글을 같은 방식으로 나눠 붙여넣는다
    const cases = [
      { id: 'c1', subject: '강아지 반응이 너무 웃기네요ㅎㅎ', text: '귀여운 강아지 영상이에요\n다들 한번 보세요', link: 'https://www.youtube.com/shorts/AbCdEfGhI_1' },
      // 장소 글은 문단 사이에 빈 줄이 있어 게시 확인의 앞뒤 조각이 빈 문단을 건너간다
      { id: 'c2', subject: '[추천] [가평/글램핑] 이런 곳 어떠세용~?', text: '가상 글램핑 펜션이 좋아보여요~\n\n📍 상호: 가상 펜션\n⏰ 운영시간: 매일 24시간 (00:00 - 24:00)\n\n가시기 전에 한 번 더 확인해 보세용~', link: 'https://naver.me/AbCd1234' },
    ];
    for (const item of cases) {
      const result = await broker.deliver({ scope: `cafe-editor-${item.id}`, allowedActions: ['post'], instructionKey: 'k', signal: new AbortController().signal, body: `${item.text}\n\n${item.link}`,
        publication: { id: item.id, action: 'post', service: 'naver_cafe', connection: account.id, target: `${origin}/write`, recipients: [], subject: item.subject },
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
          // 숨은 입력 칸에 붙여넣기로 넣어 편집기가 링크를 영상·장소 카드로 바꾸게 한다
          const filled = await call('browser_fill_content', { ref: controls.find((c) => c.editable)?.ref, field: 'body' });
          assert.match(filled.kept || '', /입력 확인됨/);
          await call('browser_submit', { ref: ref(/^등록$/) });
          await call('browser_finish'); return 'done';
        } });
      assert.equal(result.status, 'confirmed', `${item.id}: 링크가 카드로 바뀌어도 글 화면의 제목·본문으로 게시 완료를 확인한다`);
      const post = posts.at(-1);
      assert.equal(post.board, '수다방 선택됨');
      assert.equal(post.title, item.subject);
      assert.equal(post.text, `${item.text}\n\n`, `${item.id}: 글 뒤에 빈 줄을 두고 한 번만 들어가며 링크는 글자로 남지 않는다`);
      assert.equal(post.card, true, `${item.id}: 글과 링크를 나눠 붙여넣어 링크가 카드가 된다`);
    }
    assert.equal(posts.length, cases.length);
    return [{ name: '카페 편집기: textarea 제목, 게시판 선택 클릭, 글과 링크를 나눠 영상·장소 카드, 등록 확인', interaction: 'click', passed: true }];
  } finally {
    await broker?.close(); await browser?.close(); site?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// 첨부 칸이 숨겨진 메일 쓰기 화면: "파일 첨부" 버튼이 파일 선택 창을 열고, 고른 파일 이름이 첨부 목록에 보인다
const ATTACH_COMPOSE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>메일 쓰기</title></head><body>
<label>받는 사람<input name="to"></label><label>제목<input name="subject"></label>
<button id="pick" type="button">파일 첨부</button><input id="file" type="file" multiple style="display:none"><ul id="list" aria-label="첨부 목록"></ul>
<div id="editor" contenteditable="true" aria-label="본문" style="min-height:80px"></div>
<button id="send">보내기</button>
<script>const file=document.getElementById('file');document.getElementById('pick').onclick=()=>file.click();
const picked=[];file.onchange=()=>{for(const f of file.files){picked.push(f);const li=document.createElement('li');li.textContent=f.name+' ('+f.size+'B)';document.getElementById('list').append(li);}};
document.getElementById('send').onclick=async()=>{await fetch('/sent-mail',{method:'POST',body:JSON.stringify({to:document.querySelector('[name=to]').value,subject:document.querySelector('[name=subject]').value,
text:document.getElementById('editor').innerText,files:picked.map(f=>({name:f.name,size:f.size}))})});location.href='/sent';};</script></body></html>`;

export async function verifyMailAttachment() {
  const temp = mkdtempSync(join(tmpdir(), 'office-mail-attach-')), root = join(temp, 'workspace'); mkdirSync(join(root, '보관함'), { recursive: true });
  let browser, broker, site;
  const sent = [];
  try {
    const proposal = join(root, '보관함', '제휴제안서.pdf'); writeFileSync(proposal, '%PDF-1.4 가상 제휴제안서');
    const secret = join(root, '보관함', '계정.env'); writeFileSync(secret, 'SITE_PASSWORD=fixture');
    site = createServer(async (req, res) => {
      if (req.method === 'POST') { let b = ''; for await (const c of req) b += c; sent.push(JSON.parse(b)); res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/sent' ? `<!doctype html><html lang="ko"><body><h1>보낸메일함</h1><table><tr><td>${sent.at(-1)?.to || ''}</td><td>${sent.at(-1)?.subject || ''}</td></tr></table></body></html>` : ATTACH_COMPOSE);
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
    const publication = { id: 'a1', action: 'mail', service: 'naverworks_mail', connection: account.id, target: `${origin}/compose`, recipients: ['partner@example.invalid'], subject: '제휴 제안드립니다' };
    const request = { scope: 'mail-attach', allowedActions: ['mail'], instructionKey: 'k', signal: new AbortController().signal, body: '제휴 제안서를 첨부합니다.', publication };
    // 계정 파일은 실행기가 넘겨도 브라우저 작업이 다시 막는다
    await assert.rejects(broker.deliver({ ...request, files: [{ name: '계정.env', path: secret }], execute: async () => 'never' }), /계정 파일/);
    const result = await broker.deliver({ ...request, files: [{ name: '제휴제안서.pdf', path: proposal }],
      execute: async ({ url, token }) => {
        const call = async (name, args = {}) => {
          const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
          const data = await r.json(); if (data.error) throw new Error(`${name}: ${data.error}`); return data.result;
        };
        const refs = Object.fromEntries((await call('browser_snapshot')).frames.flatMap((f) => f.controls).map((c) => [c.label, c.ref]));
        await call('browser_fill_content', { ref: refs.to, field: 'recipients' });
        await call('browser_fill_content', { ref: refs.subject, field: 'subject' });
        await call('browser_fill_content', { ref: refs['본문'], field: 'body' });
        Object.assign(refs, Object.fromEntries((await call('browser_snapshot')).frames.flatMap((f) => f.controls).map((c) => [c.label, c.ref])));
        await assert.rejects(call('browser_type', { ref: refs['본문'], text: '임의 문장' }), /일반 웹사이트/, '메일 본문은 자유 입력하지 않는다');
        await assert.rejects(call('browser_submit', { ref: refs['보내기'] }), /첨부 파일을 모두/, '첨부 전에는 보내지 않는다');
        await assert.rejects(call('browser_attach', { ref: refs['파일 첨부'], file: '다른파일.pdf' }), /지정된 첨부 파일만/);
        assert.deepEqual(await call('browser_attach', { ref: refs['파일 첨부'], file: '제휴제안서.pdf' }), { attached: '제휴제안서.pdf' });
        await call('browser_submit', { ref: refs['보내기'] });
        await call('browser_finish'); return 'done';
      } });
    assert.equal(result.status, 'confirmed');
    assert.equal(sent.length, 1, '첨부 전 발송 시도는 실제로 보내지 않는다');
    assert.deepEqual(sent[0].files.map((f) => f.name), ['제휴제안서.pdf'], '지정한 파일이 실제로 첨부되어 발송된다');
    assert.ok(sent[0].files[0].size > 0);
    assert.ok(sent[0].text.startsWith('제휴 제안서를 첨부합니다.'));
    return [{ name: '메일 첨부: 숨긴 파일 칸을 버튼으로 열어 지정 파일만 첨부, 첨부 전 발송 거부, 계정 파일 차단', interaction: 'click', passed: true }];
  } finally {
    await broker?.close(); await browser?.close(); site?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
