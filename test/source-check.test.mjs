import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSources, extractSources, inspectLinks, isPrivateAddress, isPublicWebUrl, pageDate, sourceProblemReason, titleMatches } from '../lib/source-check.mjs';
import { formatLinks } from '../scripts/check-links.mjs';

const page = (title, { status = 200, type = 'text/html', location = null } = {}) => new Response(status >= 300 && status < 400 ? null : `<html><head><title>${title}</title></head></html>`,
  { status, headers: { 'content-type': type, ...(location ? { location } : {}) } });
const publicDns = async () => [{ address: '93.184.216.34' }];

test('출처 추출: 표·목록·괄호 링크에서 주소만 뽑고 끝 문장부호와 중복을 뺀다', () => {
  const urls = extractSources('| 제목 | https://a.example/x |\n- [글](https://b.example/y).\nhttps://a.example/x\n<a href="https://c.example/z">c</a>').map((s) => s.url);
  assert.deepEqual(urls, ['https://a.example/x', 'https://b.example/y', 'https://c.example/z']);
  assert.deepEqual(extractSources('[위키](https://en.wikipedia.org/wiki/Tesla_Roadster_(second_generation)). (https://a.example/y)').map((s) => s.url), ['https://en.wikipedia.org/wiki/Tesla_Roadster_(second_generation)', 'https://a.example/y']);
  assert.match(extractSources('## Tesla reveals Roadster\n\n링크: https://a.example/x')[0].context, /Tesla reveals Roadster/);
});

test('제목 대조: 사이트 이름·기호를 빼고 비교하며 짧거나 차단 화면이면 판단하지 않는다', () => {
  assert.equal(titleMatches('Tesla reveals SpaceX-powered Roadster | TechCrunch', '제목: Tesla reveals SpaceX powered Roadster'), true);
  assert.equal(titleMatches('Tesla reveals SpaceX-powered Roadster | TechCrunch', 'Tesla sets Roadster event for Thursday'), false);
  assert.equal(titleMatches('Tesla&#8217;s new Roadster is here - Electrek', 'Tesla’s new Roadster is here'), true);
  assert.equal(titleMatches('Tesla Roadster: reservar la versi&oacute;n que vuela cuesta mucho', 'Tesla Roadster: reservar la versión que vuela cuesta mucho'), true);
  assert.equal(titleMatches('Just a moment...', '아무 글'), true);
  assert.equal(titleMatches('Home', '아무 글'), true);
  assert.equal(titleMatches('SK하이닉스 주가, 11월 5일 장중 7.02% 하락 < e-trend 뉴스 < 기사본문 - 중앙이코노미뉴스', 'SK하이닉스 주가, 11월 5일 장중 7.02% 하락'), true, '국내 언론 사이트 형식');
  assert.equal(titleMatches('美중간선거 D-100…"공화, 하원 내주고" :: 공감언론 뉴시스 ::', '美중간선거 D-100…"공화, 하원 내주고"'), true);
});

test('내부 주소 판별', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.0.5', '172.20.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('공개 웹 주소 판별', () => {
  for (const url of ['https://www.youtube.com/shorts/x', 'http://example.com/', 'https://8.8.8.8/']) assert.equal(isPublicWebUrl(url), true, url);
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'file:///etc/passwd', 'http://erp/', 'http://erp.corp/', 'http://a.local/', 'https://user:pw@example.com/', 'javascript:alert(1)', '']) assert.equal(isPublicWebUrl(url), false, url);
});

test('출처 확인: 열림·깨짐·제목 불일치·차단·DNS 실패를 구분한다', async () => {
  const text = ['Good article title here', 'https://a.example/ok', '', '', '', '', '', '', '', '', 'Wrong title written', 'https://a.example/title', '', '', '', '', '', '', '', '', 'https://a.example/gone', 'https://a.example/blocked', 'https://nodns.example/x'].join('\n');
  const seen = [];
  const result = await checkSources([{ stage: 'collect', text }], { lookup: async (host) => {
    if (host === 'nodns.example') throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    return publicDns();
  }, fetchImpl: async (url, init) => {
    seen.push(init);
    if (url.endsWith('/ok')) return page('Good article title here | Site');
    if (url.endsWith('/title')) return page('A completely different page title | Site');
    if (url.endsWith('/gone')) return page('', { status: 404 });
    return page('', { status: 403 });
  } });
  assert.equal(result.checked, 5);
  assert.deepEqual(result.broken.map((b) => [b.url, b.status]).sort((x, y) => x[0].localeCompare(y[0])), [['https://a.example/gone', 404], ['https://nodns.example/x', 'ENOTFOUND']]);
  assert.deepEqual(result.mismatched.map((m) => m.url), ['https://a.example/title']);
  assert.deepEqual(result.unknown.map((u) => u.status), [403]);
  assert.ok(seen.every((init) => init.credentials === 'omit' && init.redirect === 'manual'));
  const reason = sourceProblemReason([...result.broken, ...result.mismatched]);
  assert.match(reason, /다시 조사하지 말고.*이 항목만 고치세요/);
  assert.match(reason, /참고로 적은 링크이거나 차단 화면이면 그대로/);
  assert.match(reason, /열리지 않음\(404\).*gone/);
  assert.match(reason, /실제 제목: A completely different/);
});

test('출처 확인: 내부 주소는 열지 않고, 공개 주소에서 내부로 가는 리디렉션도 막는다', async () => {
  const opened = [];
  const result = await checkSources([{ stage: 's', text: 'http://localhost:4777/x http://10.0.0.5/erp https://intra.example/a https://pub.example/r' }], {
    lookup: async (host) => [{ address: host === 'intra.example' ? '192.168.1.9' : '93.184.216.34' }],
    fetchImpl: async (url) => { opened.push(url); return page('', { status: 302, location: 'https://intra.example/secret' }); } });
  assert.deepEqual(opened, ['https://pub.example/r']);
  assert.equal(result.skipped, 4);
  assert.equal(result.checked, 0);
});

test('출처 확인: 링크가 40개를 넘으면 나머지는 건너뛴다', async () => {
  const text = Array.from({ length: 45 }, (_, i) => `https://a.example/${i}`).join('\n');
  const result = await checkSources([{ stage: 's', text }], { lookup: publicDns, fetchImpl: async () => page('') });
  assert.equal(result.checked, 40);
  assert.equal(result.skipped, 5);
});

test('게시일: 메타 태그·구조화 데이터·time 태그에서 찾고, 없으면 추정하지 않는다', () => {
  assert.equal(pageDate('<meta property="article:published_time" content="2026-11-05T09:44:00+09:00">'), '2026-11-05');
  assert.equal(pageDate('<meta content=\'2026-11-04\' name=\'date\'>'), '2026-11-04');
  assert.equal(pageDate('<meta name="date" content="2026-01-01"><meta property="article:published_time" content="2026-11-05">'), '2026-11-05', '게시일 태그를 앞세운다');
  assert.equal(pageDate('<script type="application/ld+json">{"datePublished":"2026-10-22T11:01:48Z"}</script>'), '2026-10-22');
  assert.equal(pageDate('<time class="x" datetime="2026.3.4 10:00">3월 4일</time>'), '2026-03-04');
  assert.equal(pageDate('<a href="/2026/11/04/news">글</a>'), '', '주소의 숫자는 게시일로 쓰지 않는다');
  assert.equal(pageDate('<meta name="date" content="다음 주"><meta name="date2" content="2026-13-40">'), '');
});

test('링크 일괄 확인: 입력 순서로 제목·게시일·상태를 주고 내부 주소는 열지 않는다', async () => {
  const opened = [];
  const html = (body) => new Response(body, { headers: { 'content-type': 'text/html' } });
  const { links, omitted } = await inspectLinks(['https://a.example/ok', 'https://a.example/gone', 'https://a.example/nodate', 'http://10.0.0.5/erp', 'https://a.example/ok'], {
    lookup: publicDns,
    fetchImpl: async (url) => {
      opened.push(url);
      if (url.endsWith('/gone')) return new Response('', { status: 404 });
      if (url.endsWith('/nodate')) return html('<title>날짜 없는 글</title>');
      return html('<head><meta property="article:published_time" content="2026-11-05T01:00:00Z"><title>실제 &amp; 제목</title></head>');
    } });
  assert.equal(omitted, 0);
  assert.deepEqual(links.map((l) => [l.state, l.date, l.title]), [['ok', '2026-11-05', '실제 & 제목'], ['broken', '', ''], ['ok', '', '날짜 없는 글'], ['skipped', '', '']]);
  assert.ok(!opened.some((u) => u.includes('10.0.0.5')));
  const output = formatLinks({ links, omitted: 2 }).split('\n');
  assert.deepEqual(output[0].split('\t'), ['ok', '2026-11-05', 'https://a.example/ok', '실제 & 제목']);
  assert.equal(output[2].split('\t')[1], '미확인');
  assert.match(output.at(-1), /2개는 확인하지 않았습니다/);
});

test('링크 일괄 확인: 응답이 멈춰도 받은 데까지로 답하고, 많은 링크는 잘라서 알린다', async (t) => {
  // 시간 초과 타이머는 unref라 실제 소켓이 없는 이 시험에서는 따로 이벤트 루프를 붙잡아야 울린다(Node 20·22)
  const keepAlive = setInterval(() => {}, 5);
  t.after(() => clearInterval(keepAlive));
  // 실제 fetch처럼 중단 신호가 오면 본문 읽기가 오류로 끝난다
  const { links } = await inspectLinks(['https://a.example/slow'], { lookup: publicDns, timeoutMs: 30, fetchImpl: async (url, { signal }) => {
    const stalled = new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('<title>앞부분만 받은 글</title>'));
      signal.addEventListener('abort', () => c.error(new DOMException('중단', 'AbortError')));
    } });
    return new Response(stalled, { headers: { 'content-type': 'text/html' } });
  } });
  assert.deepEqual([links[0].state, links[0].title], ['ok', '앞부분만 받은 글']);
  const silent = await inspectLinks(['https://a.example/silent'], { lookup: publicDns, timeoutMs: 30, fetchImpl: async (url, { signal }) => new Response(new ReadableStream({ start(c) {
    signal.addEventListener('abort', () => c.error(new DOMException('중단', 'AbortError')));
  } }), { headers: { 'content-type': 'text/html' } }) });
  assert.equal(silent.links[0].state, 'unknown', '아무것도 받지 못하면 열렸다고 하지 않는다');
  const many = await inspectLinks(Array.from({ length: 33 }, (_, i) => `https://a.example/${i}`), { lookup: publicDns, fetchImpl: async () => page('') });
  assert.deepEqual([many.links.length, many.omitted], [30, 3]);
  assert.equal(pageDate('<meta property="article:modified_time" content="2026-11-05">'), '', '수정일은 게시일이 아니다');
});

test('출처 확인: 제목을 받으면 더 읽지 않는다(게시일은 일괄 확인에서만 찾는다)', async () => {
  let pulls = 0;
  const body = new ReadableStream({ pull(c) {
    pulls++;
    c.enqueue(new TextEncoder().encode(pulls === 1 ? '<title>Good article title here</title>' : '<p>본문</p>'));
    if (pulls > 50) c.close();
  } }, { highWaterMark: 0 });
  await checkSources([{ stage: 's', text: 'Good article title here https://a.example/x' }], { lookup: publicDns, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  assert.equal(pulls, 1);
});

test('출처 확인: 구글 뉴스 경유 주소는 열지 않고 따로 센다', async () => {
  const opened = [];
  const result = await checkSources([{ stage: 's', text: 'https://news.google.com/rss/articles/abc?oc=5 https://a.example/x' }], { lookup: publicDns, fetchImpl: async (url) => { opened.push(url); return page(''); } });
  assert.deepEqual(opened, ['https://a.example/x']);
  assert.deepEqual([result.checked, result.relayed], [1, 1]);
});
