// 일반 웹사이트 업무(자유 입력·파일 첨부·되돌리기 어려운 버튼·결과 증표)를 로컬 가짜 관리자 사이트에서만 검증한다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnectionStore } from '../lib/connections.mjs';
import { createBrowserWork } from '../lib/browser-work.mjs';

const LIST = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>상담사 목록</title></head><body>
<label>검색어<input name="q"></label><button id="sort">등록일</button><button id="save">저장</button>
<table><tbody>${Array.from({ length: 1200 }, (_, i) => `<tr><td>상담사${i + 1}</td><td>010-0000-${String(i).padStart(4, '0')}</td><td>담당 ${i % 3 ? '김' : '이'}</td></tr>`).join('')}</tbody></table>
<p id="searched"></p>
<script>document.querySelector('[name=q]').addEventListener('keydown',(e)=>{if(e.key==='Enter')document.getElementById('searched').textContent='검색함:'+e.target.value;});
document.getElementById('sort').onclick=()=>document.getElementById('searched').textContent='정렬함';
document.getElementById('save').onclick=()=>fetch('/save',{method:'POST'});</script></body></html>`;
// 관리자 화면의 데이터 표처럼 보이는 행만 그리는 표(안쪽 스크롤)
const GRID = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>경고 목록</title>
<style>body{margin:0;padding:200px 40px}#grid{height:390px;overflow:auto;border:1px solid #999}#inner{position:relative}.row{position:absolute;left:0;right:0;height:30px}</style></head><body>
<div id="grid" role="grid"><div id="inner"></div></div>
<script>const total=445,h=30,grid=document.getElementById('grid'),inner=document.getElementById('inner');inner.style.height=(total*h)+'px';
const draw=()=>{const first=Math.floor(grid.scrollTop/h);inner.innerHTML='';for(let i=first;i<Math.min(total,first+13);i++){const r=document.createElement('div');r.className='row';r.tabIndex=-1;r.style.top=(i*h)+'px';r.textContent='경고'+(i+1)+' 최근접속 2026-09-'+String(i%28+1).padStart(2,'0');inner.append(r);}};
grid.addEventListener('scroll',draw);draw();</script></body></html>`;
const HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>가짜 관리자 화면</title></head><body>
<h1>제휴 제안 페이지</h1>
<label>업체 코드<input name="code"></label><button id="add">업체 추가</button><button id="del">삭제</button>
<a href="https://outside.example.invalid/">외부 링크</a>
<section id="upload" hidden><button id="pick">파일 선택</button><input type="file" name="bundle" hidden aria-label="파일 선택"><span id="picked"></span><button id="up">업로드</button></section>
<p id="result"></p>
<script>
let code='';
document.getElementById('add').onclick=()=>{code=document.querySelector('[name=code]').value;document.getElementById('upload').hidden=false;return fetch('/add?code='+encodeURIComponent(code),{method:'POST'});};
document.getElementById('del').onclick=()=>fetch('/delete',{method:'POST'});
// 실제 관리자 화면처럼 숨긴 파일 칸을 버튼이 대신 연다
document.getElementById('pick').onclick=()=>document.querySelector('[name=bundle]').click();
document.querySelector('[name=bundle]').onchange=(e)=>{document.getElementById('picked').textContent=e.target.files[0]?.name||'';};
document.getElementById('up').onclick=async()=>{const f=document.querySelector('[name=bundle]').files[0];
 const text=f?await f.text():'';await fetch('/upload?name='+encodeURIComponent(f?f.name:''),{method:'POST',body:text});
 document.getElementById('result').textContent='공개 주소: /p/'+code+' 버전 1 업로드 완료';};
</script></body></html>`;

export async function verifyWebWork() {
  const temp = mkdtempSync(join(tmpdir(), 'office-web-work-')), root = join(temp, 'workspace'); mkdirSync(root);
  let browser, broker, site;
  const events = [];
  try {
    site = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST') { let body = ''; for await (const c of req) body += c; events.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body }); res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(url.pathname === '/list' ? LIST : url.pathname === '/grid' ? GRID : HTML);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${site.address().port}`;
    browser = await chromium.launch();
    const store = createConnectionStore({ root, base: join(temp, 'private') });
    const account = store.create({ provider: 'web', label: '가짜 관리자', startUrl: `${origin}/erp/login` });
    store.update(account.id, { status: 'connected' });
    const sessions = { async withSession(_id, target, _signal, action) {
      const context = await browser.newContext(); await context.newPage(); await context.pages()[0].goto(target);
      try { return await action(context); } finally { await context.close(); }
    }, close: async () => {} };
    broker = createBrowserWork({ root, store, sessions });
    const taskDir = join(root, 'outputs', '2026-11-03', 'web-fixture'); mkdirSync(taskDir, { recursive: true });
    const htmlFile = join(taskDir, 'proposal.html'); writeFileSync(htmlFile, '<!doctype html><title>제안</title><h1>제휴 제안</h1>');
    const evidenceDir = join(taskDir, 'evidence');
    const publication = (id) => ({ id, action: 'web', service: 'web', connection: account.id, agent: 'ops-1', target: `${origin}/erp/proposal-pages` });
    const instructions = '업체 코드 ai-office-test로 업체를 추가하고 proposal.html을 업로드한다.';
    let runs = 0;
    const execute = (options = {}) => async ({ url, token }) => {
      runs++;
      const call = async (name, args = {}) => {
        const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
        const data = await res.json(); if (data.error) throw new Error(`${name}: ${data.code} ${data.error}`); return data.result;
      };
      const refs = async () => Object.fromEntries((await call('browser_snapshot')).frames.flatMap((f) => f.controls).map((c) => [c.label, c.ref]));
      let r = await refs();
      await call('browser_type', { ref: r.code, text: 'ai-office-test' });
      await assert.rejects(call('browser_fill_content', { ref: r.code, field: 'body' }), /browser_type/);
      await assert.rejects(call('browser_click', { ref: r['업체 추가'] }), /browser_submit/, '되돌리기 어려운 버튼은 일반 클릭 금지');
      await assert.rejects(call('browser_click', { ref: r['삭제'] }), /삭제·결제/, '삭제 버튼 금지');
      await assert.rejects(call('browser_click', { ref: r['외부 링크'] }), /연결 서비스 밖/);
      await assert.rejects(call('browser_navigate', { url: 'https://outside.example.invalid/' }), /연결된 서비스 안/);
      await call('browser_submit', { ref: r['업체 추가'] });
      r = await refs();
      assert.equal(r.bundle, undefined, '숨긴 파일 칸은 화면 목록에 없다');
      await assert.rejects(call('browser_attach', { ref: r['파일 선택'], file: 'secret.txt' }), /지정된 첨부 파일만/);
      await assert.rejects(call('browser_attach', { ref: r.code, file: 'proposal.html' }), /파일 선택 창이 열리지/);
      if (options.giveUp) {
        await assert.rejects(call('browser_finish', { summary: '파일을 고르지 못했습니다.' }), /completed/);
        await call('browser_finish', { summary: '파일 선택 창을 찾지 못해 업로드하지 못했습니다.', completed: false });
        return 'status:needs_decision';
      }
      await call('browser_attach', { ref: r['파일 선택'], file: 'proposal.html' });
      await call('browser_submit', { ref: r['업로드'] });
      if (options.lostReply) throw new Error('fixture lost reply');
      await assert.rejects(call('browser_finish', {}), /summary/);
      const done = await call('browser_finish', { summary: '공개 주소 /p/ai-office-test 버전 1 업로드 완료를 확인했습니다.', completed: true });
      assert.ok(done.evidence);
      return 'status:done';
    };
    const first = await broker.deliver({ scope: 'fixture-run', publication: publication('upload'), body: instructions, allowedActions: ['web'], instructionKey: 'k1',
      files: [{ name: 'proposal.html', path: htmlFile }], evidenceDir, execute: execute(), signal: new AbortController().signal });
    assert.equal(first.status, 'confirmed');
    assert.match(first.summary, /ai-office-test/);
    assert.deepEqual(events.map((e) => e.path), ['/add', '/upload']);
    assert.equal(events[0].query.code, 'ai-office-test');
    assert.deepEqual([events[1].query.name, events[1].body], ['proposal.html', '<!doctype html><title>제안</title><h1>제휴 제안</h1>']);
    assert.ok(existsSync(evidenceDir) && readdirSync(evidenceDir).some((f) => f.endsWith('.png')), '결과 화면 캡처 증표');
    // 끝내지 못했다고 보고하면 완료로 닫지 않는다. 직원이 확인한 미완료라 대표가 이어서 지시하면 다시 시도할 수 있다
    await assert.rejects(broker.deliver({ scope: 'fixture-run', publication: publication('give-up'), body: instructions, allowedActions: ['web'], instructionKey: 'k1',
      files: [{ name: 'proposal.html', path: htmlFile }], evidenceDir, execute: execute({ giveUp: true }), signal: new AbortController().signal }), /끝내지 못했습니다[\s\S]*파일 선택 창을 찾지 못해/);
    const retried = await broker.deliver({ scope: 'fixture-run', publication: publication('give-up'), body: instructions, allowedActions: ['web'], instructionKey: 'k1',
      files: [{ name: 'proposal.html', path: htmlFile }], evidenceDir, execute: execute(), signal: new AbortController().signal });
    assert.equal(retried.status, 'confirmed');
    runs -= 2; events.splice(2);
    // 같은 지침·첨부는 다시 실행하지 않는다
    const again = await broker.deliver({ scope: 'fixture-run', publication: publication('upload'), body: instructions, allowedActions: ['web'], instructionKey: 'k1',
      files: [{ name: 'proposal.html', path: htmlFile }], evidenceDir, execute: execute(), signal: new AbortController().signal });
    assert.equal(again.status, 'confirmed'); assert.equal(runs, 1); assert.equal(events.length, 2);
    // 업로드 버튼을 누른 뒤 결과를 잃으면 불확실로 남기고 재실행하지 않는다
    await assert.rejects(broker.deliver({ scope: 'fixture-run', publication: publication('lost'), body: instructions, allowedActions: ['web'], instructionKey: 'k1',
      files: [{ name: 'proposal.html', path: htmlFile }], evidenceDir, execute: execute({ lostReply: true }), signal: new AbortController().signal }), /lost reply/);
    await assert.rejects(broker.deliver({ scope: 'fixture-run', publication: publication('lost'), body: instructions, allowedActions: ['web'], instructionKey: 'k1',
      files: [{ name: 'proposal.html', path: htmlFile }], evidenceDir, execute: execute(), signal: new AbortController().signal }), /불확실/);
    assert.equal(runs, 2);
    // 지시하지 않은 외부 작업·허용 밖 주소·첨부 누락은 시작하지 않는다
    await assert.rejects(broker.deliver({ scope: 's2', publication: publication('x'), body: instructions, allowedActions: ['mail'], instructionKey: 'k', execute: execute(), signal: new AbortController().signal }), /지시한/);
    await assert.rejects(broker.deliver({ scope: 's2', publication: { ...publication('x'), target: 'https://outside.example.invalid/' }, body: instructions, allowedActions: ['web'], instructionKey: 'k', execute: execute(), signal: new AbortController().signal }), /허용 도메인 밖/);
    await assert.rejects(broker.deliver({ scope: 's2', publication: publication('x'), body: instructions, allowedActions: ['web'], instructionKey: 'k', files: [{ name: 'none.html', path: join(taskDir, 'none.html') }], execute: execute(), signal: new AbortController().signal }), /첨부 파일이 없습니다/);
    assert.equal(runs, 2);
    // 사이트 조회 단계: 읽기 전용으로 긴 목록을 끝까지 읽고, 검색·정렬은 되며 저장·제출·첨부는 막는다
    const read = await broker.browse({ connection: account.id, target: `${origin}/list`, signal: new AbortController().signal, execute: async ({ url, token, write }) => {
      assert.equal(write, true, '조회 결과를 산출물 파일로 쓸 수 있다');
      const call = async (name, args = {}) => {
        const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
        const data = await res.json(); if (data.error) throw new Error(`${name}: ${data.code} ${data.error}`); return data.result;
      };
      const r = Object.fromEntries((await call('browser_snapshot')).frames.flatMap((f) => f.controls).map((c) => [c.label, c.ref]));
      await call('browser_type', { ref: r.q, text: '이' });
      await call('browser_press_key', { key: 'Enter' });
      await call('browser_click', { ref: r['등록일'] });
      await assert.rejects(call('browser_click', { ref: r['저장'] }), /읽기 전용/);
      await assert.rejects(call('browser_submit', { ref: r['저장'] }), /읽기 전용/);
      await assert.rejects(call('browser_attach', { ref: r.q, file: 'proposal.html' }), /읽기 전용/);
      let text = '', offset = 0;
      for (;;) { const part = await call('browser_text', { offset }); text += part.text; if (part.next === null) break; offset = part.next; }
      return { rows: (text.match(/상담사\d+/g) || []).length, last: text.includes('상담사1200'), phone: text.includes('010-0000-1199'), sorted: text.includes('정렬함') };
    } });
    assert.deepEqual(read, { rows: 1200, last: true, phone: true, sorted: true });
    assert.ok(!events.some((e) => e.path === '/save'), '읽기 전용 조회에서 저장 요청이 없어야 한다');
    // 보이는 행만 그리는 표: 표 안의 행을 기준으로 스크롤하며 읽으면 전체 행을 모을 수 있다
    const seen = await broker.browse({ connection: account.id, target: `${origin}/grid`, signal: new AbortController().signal, execute: async ({ url, token }) => {
      const call = async (name, args = {}) => {
        const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
        const data = await res.json(); if (data.error) throw new Error(`${name}: ${data.code} ${data.error}`); return data.result;
      };
      const ids = new Set();
      for (let i = 0; i < 80 && ids.size < 445; i++) {
        for (const m of (await call('browser_text')).text.matchAll(/경고(\d+)/g)) ids.add(Number(m[1]));
        const row = (await call('browser_snapshot')).frames.flatMap((f) => f.controls).find((c) => /^경고\d+/.test(c.label));
        await call('browser_scroll', { deltaY: 360, ref: row.ref });
      }
      return ids.size;
    } });
    assert.equal(seen, 445, '표 안쪽 스크롤로 보이지 않던 행까지 모두 읽는다');
    return [{ name: '일반 웹사이트: 자유 입력·지정 파일 첨부·되돌리기 어려운 버튼 submit·결과 캡처 증표', interaction: 'click', passed: true },
      { name: '일반 웹사이트: 삭제·외부 링크·허용 밖 이동·목록 밖 첨부 차단, 재실행·불확실 재시도 차단', interaction: 'click', passed: true },
      { name: '사이트 조회 단계: 읽기 전용 검색·정렬, 긴 목록 이어 읽기, 저장·제출·첨부 차단', interaction: 'click', passed: true },
      { name: '사이트 조회 단계: 보이는 행만 그리는 표를 안쪽 스크롤로 끝까지 읽기', interaction: 'scroll', passed: true }];
  } finally {
    await broker?.close(); await browser?.close(); site?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
