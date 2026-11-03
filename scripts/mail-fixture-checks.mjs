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
