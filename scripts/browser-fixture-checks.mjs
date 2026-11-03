// 가짜 로컬 사이트에서만 브라우저 발송/게시/댓글·중복 방지를 검증한다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnectionStore } from '../lib/connections.mjs';
import { createBrowserWork } from '../lib/browser-work.mjs';

const HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>브라우저 업무 검증용 사이트</title></head><body>
<h1>브라우저 업무 검증용 사이트</h1><label>받는 사람<input name="to"></label><label>제목<input name="subject"></label><label>본문<textarea name="body"></textarea></label>
<button id="send">보내기</button><button id="post">발행</button><button id="comment">등록</button><div id="results"></div>
<script>
for(const [id,kind] of [['send','mail'],['post','post'],['comment','comment']])document.getElementById(id).onclick=async()=>{
 const subject=document.querySelector('[name=subject]').value,body=document.querySelector('[name=body]').value;
 await fetch('/record',{method:'POST',body:kind});
 const result=document.createElement('article');const title=document.createElement('h2');title.textContent=subject;const text=document.createElement('p');text.textContent=body;result.append(title,text);
 if(kind==='mail'){const p=document.createElement('p');p.textContent='메일을 보냈습니다';result.append(p)}
 document.getElementById('results').append(result);document.querySelector('[name=body]').value='';
 if(kind==='post')history.pushState({},'', '/published/'+Date.now());
};
</script></body></html>`;

export async function verifyBrowserWork() {
  const temp = mkdtempSync(join(tmpdir(), 'office-browser-work-')), root = join(temp, 'workspace'); mkdirSync(root);
  let browser, broker, site;
  const checks = [], counts = { mail: 0, post: 0, comment: 0 };
  try {
    site = createServer(async (req, res) => {
      if (req.url === '/record') { let type = ''; for await (const c of req) type += c; counts[type]++; res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(HTML);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${site.address().port}`;
    browser = await chromium.launch();
    const store = createConnectionStore({ root, base: join(temp, 'private') });
    const accounts = Object.fromEntries(['naverworks', 'naver', 'kakao'].map((provider) => {
      const item = store.create({ provider, label: provider }); store.update(item.id, { status: 'connected' }); return [provider, item.id];
    }));
    const sessions = { async withSession(_id, target, _signal, action) {
      const context = await browser.newContext(); await context.newPage(); await context.pages()[0].goto(target);
      try { return await action(context); } finally { await context.close(); }
    }, close: async () => {} };
    broker = createBrowserWork({ root, store, sessions, providersForTests: (_provider, url) => new URL(url).origin === origin });
    const pub = (action, service, provider, slug) => ({ id: slug, action, service, connection: accounts[provider],
      target: origin + '/' + slug, recipients: action === 'mail' ? ['fixture@example.invalid'] : [], subject: '검토된 업무 제목' });
    const body = '검토한 자료를 바탕으로 작성한 본문입니다. 확인한 내용과 추가 확인할 사항을 구분해 전달합니다.';
    const execute = (publication, options = {}) => async ({ url, token }) => {
      const call = async (name, args = {}) => {
        const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
        const data = await res.json(); if (data.error) throw new Error(`${publication.service}/${name}: ${data.code} ${data.error}`); return data.result;
      };
      const screen = await call('browser_snapshot'); const controls = screen.frames.flatMap((f) => f.controls);
      const searched = await call('browser_snapshot', { query: '받는사람 제목 본문 보내기' });
      assert.ok(searched.frames.flatMap((frame) => frame.controls).some((control) => control.label === 'body'));
      const noMatches = await call('browser_snapshot', { query: '없는입력칸 검색' });
      assert.ok(noMatches.frames.flatMap((frame) => frame.controls).some((control) => control.label === 'body'));
      // snapshot을 다시 읽으면 ref 정본도 갱신된다.
      controls.splice(0, controls.length, ...noMatches.frames.flatMap((frame) => frame.controls));
      const ref = (name) => controls.find((c) => c.label === name)?.ref;
      await call('browser_fill_content', { ref: ref('body'), field: 'body' });
      if (publication.action !== 'comment') await call('browser_fill_content', { ref: ref('subject'), field: 'subject' });
      if (publication.action === 'mail') await call('browser_fill_content', { ref: ref('to'), field: 'recipients' });
      const button = ref(publication.action === 'mail' ? '보내기' : publication.action === 'post' ? '발행' : '등록');
      await assert.rejects(call('browser_click', { ref: button }), /BROWSER_ACTION/);
      await call('browser_submit', { ref: button });
      if (options.uncertain) throw new Error('fixture lost reply');
      await call('browser_finish'); return '완료';
    };
    await Promise.all([['mail', 'naverworks_mail', 'naverworks'], ['post', 'naver_blog', 'naver']].map(async ([action, service, provider]) => {
      const publication = pub(action, service, provider, 'parallel-' + service);
      const result = await broker.deliver({ scope: 'parallel-' + service, publication, body, allowedActions: [action], instructionKey: 'original', execute: execute(publication), signal: new AbortController().signal });
      assert.equal(result.status, 'confirmed');
    }));
    checks.push({ name: '서로 다른 계정의 메일·블로그 작업을 동시에 실행', interaction: 'click', passed: true });
    for (const [action, service, provider] of [['mail', 'naverworks_mail', 'naverworks'], ['post', 'naver_blog', 'naver'], ['comment', 'daum_cafe', 'kakao'], ['post', 'tistory', 'kakao']]) {
      const publication = pub(action, service, provider, service);
      const request = { scope: service, publication, body, allowedActions: [action], instructionKey: 'original', execute: execute(publication), signal: new AbortController().signal };
      const result = await broker.deliver(request); assert.equal(result.status, 'confirmed');
      const before = { ...counts }; await broker.deliver(request); assert.deepEqual(counts, before);
      checks.push({ name: `${service}: 검토된 원문으로 브라우저 실행·결과 확인·같은 요청 재실행 방지`, interaction: 'click', passed: true });
    }
    const publication = pub('comment', 'naver_cafe', 'naver', 'uncertain');
    const request = { scope: 'uncertain', publication, body, allowedActions: ['comment'], instructionKey: 'original', signal: new AbortController().signal };
    await assert.rejects(broker.deliver({ ...request, execute: execute(publication, { uncertain: true }) }), /lost reply/);
    const before = counts.comment;
    await assert.rejects(broker.deliver({ ...request, execute: execute(publication) }), /불확실/);
    assert.equal(counts.comment, before);
    const confirmed = await broker.deliver({ ...request, confirmExisting: true, execute: () => { throw new Error('다시 실행하면 안 됨'); } });
    assert.equal(confirmed.confirmedBy, 'user'); assert.equal(counts.comment, before);
    checks.push({ name: '결과 불명 시 자동 재게시 차단·사용자 결과 확인 후 이어가기', interaction: 'click', passed: true });
    await assert.rejects(broker.deliver({ ...request, scope: 'unauthorized', allowedActions: [], execute: execute(publication) }), /대표가/);
    checks.push({ name: '지시하지 않은 외부 작업 실행 차단', interaction: 'click', passed: true });
    const ids = ['AbCdEfGhI_1', 'ZyXwVuTsR_2', 'MnOpQrStU_3'];
    const daily = pub('post', 'naver_cafe', 'naver', 'daily-board');
    const dailyRequest = (id, index) => ({ scope: 'daily-one', publication: { ...daily, id: `post-${index}` },
      body: `검토한 가상 여행 소개 https://www.youtube.com/shorts/${id}`, allowedActions: ['post'], instructionKey: 'daily',
      schedule: { id: 'daily', slot: '2026-10-30', maxPosts: 3, uniqueYoutube: true }, signal: new AbortController().signal });
    const initialPosts = counts.post;
    for (const [index, id] of ids.entries()) { const item = dailyRequest(id, index); await broker.deliver({ ...item, execute: execute(item.publication) }); }
    assert.equal(counts.post, initialPosts + 3);
    const existingVideo = dailyRequest(ids[0], 0);
    await broker.deliver({ ...existingVideo, allowResend: true, instructionKey: 'resume-after-confirmation', execute: execute(existingVideo.publication) });
    assert.equal(counts.post, initialPosts + 3);
    const repeated = { ...dailyRequest(ids[0], 0), scope: 'daily-two', body: `변경한 제목 https://youtu.be/${ids[0]}?si=changed` };
    await assert.rejects(broker.deliver({ ...repeated, execute: execute(repeated.publication) }), /영상/);
    const overQuota = dailyRequest('VwXyZaBcD_4', 4);
    await assert.rejects(broker.deliver({ ...overQuota, execute: execute(overQuota.publication) }), /최대/);
    assert.equal(counts.post, initialPosts + 3);
    checks.push({ name: '같은 게시판에 하루 3개 별도 게시·다음 업무의 URL 변경 중복·일일 한도 차단', interaction: 'click', passed: true });
    const raceBefore = counts.post;
    const raced = await Promise.allSettled([['naver_cafe', 'naver'], ['daum_cafe', 'kakao']].map(async ([service, provider]) => {
      const item = pub('post', service, provider, 'race-board');
      return broker.deliver({ scope: service + '-race', publication: item, body: '가상 소개 https://youtu.be/VwXyZaBcD_4', allowedActions: ['post'], instructionKey: 'race', execute: execute(item), signal: new AbortController().signal });
    }));
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(counts.post, raceBefore + 1);
    checks.push({ name: '두 계정의 같은 영상 동시 게시를 실제 클릭 직전에 한 건으로 제한', interaction: 'click', passed: true });
    const uncertainVideo = pub('post', 'naver_cafe', 'naver', 'uncertain-video');
    const uncertainRequest = { scope: 'uncertain-video', publication: uncertainVideo, body: '가상 소개 https://youtu.be/EfGhIjKlM_5', allowedActions: ['post'], instructionKey: 'uncertain-video', signal: new AbortController().signal };
    await assert.rejects(broker.deliver({ ...uncertainRequest, execute: execute(uncertainVideo, { uncertain: true }) }), /lost reply/);
    const uncertainCount = counts.post;
    await broker.close();
    broker = createBrowserWork({ root, store, sessions, providersForTests: (_provider, url) => new URL(url).origin === origin });
    await assert.rejects(broker.deliver({ ...uncertainRequest, scope: 'next-day-new-task', execute: execute(uncertainVideo) }), /영상/);
    assert.equal(counts.post, uncertainCount);
    checks.push({ name: '게시 응답 유실·재시작 뒤 새 업무에서도 같은 영상 자동 재게시 차단', interaction: 'click', passed: true });
    return checks;
  } finally {
    await broker?.close(); await browser?.close();
    if (site) { site.closeAllConnections?.(); await new Promise((resolve) => site.close(resolve)); }
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
