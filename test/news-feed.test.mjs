import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedUrls, parseFeed, searchNews } from '../lib/news-feed.mjs';
import { formatNews, parseArgs } from '../scripts/news-search.mjs';

// 실제 피드 형식을 따른 표본: Bing은 클릭 집계 주소 안에 기사 주소를 담고, Google은 제목 끝에 매체를 붙이며 설명이 제목의 반복이다
const bingItem = (title, url, date, snippet = '기사 요약문') => `<item><title>${title}</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=x&amp;url=${encodeURIComponent(url)}&amp;c=1</link><description>${snippet}</description><pubDate>${date}</pubDate><News:Source>매체A</News:Source></item>`;
const googleItem = (title, id, date) => `<item><title>${title} - 매체B</title><link>https://news.google.com/rss/articles/${id}?oc=5</link><pubDate>${date}</pubDate><description>&lt;a href="https://news.google.com/rss/articles/${id}"&gt;${title}&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;매체B&lt;/font&gt;</description><source url="https://b.example">매체B</source></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss><channel><title>피드</title>${items.join('')}</channel></rss>`;
const feed = (xml, status = 200) => new Response(xml, { status, headers: { 'content-type': 'application/rss+xml' } });
const NOW = Date.parse('2026-11-05T02:00:00Z');

test('피드 해석: Bing은 실제 기사 주소를, Google은 매체를 뗀 제목을 준다', () => {
  const [bing] = parseFeed(rss(bingItem('삼성 &amp; SK 급락', 'https://a.example/1', 'Wed, 04 Nov 2026 12:23:00 GMT')));
  assert.equal(bing.title, '삼성 & SK 급락');
  assert.equal(bing.url, 'https://a.example/1');
  assert.equal(bing.source, '매체A');
  assert.equal(bing.snippet, '기사 요약문');
  assert.equal(bing.published.toISOString(), '2026-11-04T12:23:00.000Z');
  const [google] = parseFeed(rss(googleItem('테슬라 소식', 'abc', 'Wed, 04 Nov 2026 12:23:00 GMT')));
  assert.equal(google.title, '테슬라 소식');
  assert.equal(google.source, '매체B');
  assert.equal(google.url, 'https://news.google.com/rss/articles/abc?oc=5');
  assert.equal(google.snippet, '', '제목을 되풀이하는 설명은 요약문이 아니다');
});

test('피드 해석: 날짜·제목이 없거나 내부 주소인 항목은 버린다', () => {
  const items = parseFeed(rss(
    bingItem('날짜 없음', 'https://a.example/1', ''),
    bingItem('', 'https://a.example/2', 'Wed, 04 Nov 2026 12:23:00 GMT'),
    bingItem('내부 주소', 'http://10.0.0.1/x', 'Wed, 04 Nov 2026 12:23:00 GMT'),
    '<item><title>스크립트 주소</title><link>javascript:alert(1)</link><pubDate>Wed, 04 Nov 2026 12:23:00 GMT</pubDate></item>',
  ));
  assert.deepEqual(items, []);
  assert.deepEqual(parseFeed('차단 화면 <html>'), []);
});

test('피드 주소: 검색어 언어에 맞추고 기간은 Google에만 건다', () => {
  const [bingKo, googleKo] = feedUrls('SK하이닉스', { days: 7 }).map((u) => new URL(u));
  assert.equal(bingKo.searchParams.get('setlang'), 'ko');
  assert.equal(bingKo.searchParams.get('qft'), 'sortbydate="1"');
  assert.equal(googleKo.searchParams.get('q'), 'SK하이닉스 when:7d');
  assert.equal(googleKo.searchParams.get('ceid'), 'KR:ko');
  const [bingEn, googleEn] = feedUrls('Tesla', { days: 30 }).map((u) => new URL(u));
  assert.equal(bingEn.searchParams.get('cc'), 'US');
  assert.equal(googleEn.searchParams.get('q'), 'Tesla when:30d');
  assert.equal(googleEn.searchParams.get('ceid'), 'US:en');
});

test('뉴스 검색: 합쳐서 최신순으로 주고, 같은 제목은 실제 주소·요약문이 있는 쪽을 남기며 기간 밖은 뺀다', async () => {
  const fetchImpl = async (url) => feed(String(url).includes('bing.com')
    ? rss(bingItem('같은 기사', 'https://a.example/same', 'Wed, 04 Nov 2026 10:00:00 GMT'), bingItem('한 달 전 기사', 'https://a.example/old', 'Sun, 04 Oct 2026 10:00:00 GMT'))
    : rss(googleItem('같은 기사', 'dup', 'Wed, 04 Nov 2026 09:00:00 GMT'), googleItem('오늘 기사', 'new', 'Thu, 05 Nov 2026 01:00:00 GMT')));
  const { items, failed, total } = await searchNews(['주제'], { fetchImpl, now: NOW, days: 7 });
  assert.deepEqual(items.map((n) => n.title), ['오늘 기사', '같은 기사']);
  assert.equal(items[1].url, 'https://a.example/same');
  assert.deepEqual([failed, total], [0, 2]);
  const wide = await searchNews(['주제'], { fetchImpl, now: NOW, days: 60 });
  assert.ok(wide.items.some((n) => n.title === '한 달 전 기사'));
});

test('뉴스 검색: 하루 기사가 많아도 상한을 둬 다른 날 소식이 함께 들어온다', async () => {
  const today = Array.from({ length: 50 }, (_, i) => bingItem(`오늘 기사 ${i}`, `https://a.example/t${i}`, 'Thu, 05 Nov 2026 01:00:00 GMT'));
  const fetchImpl = async () => feed(rss(...today, bingItem('이틀 전 다른 소식', 'https://a.example/older', 'Tue, 03 Nov 2026 05:00:00 GMT')));
  const { items } = await searchNews(['주제'], { fetchImpl, now: NOW });
  assert.equal(items.filter((n) => n.title.startsWith('오늘')).length, 15);
  assert.equal(items.at(-1).title, '이틀 전 다른 소식');
});

test('뉴스 검색: 쿠키를 보내지 않고, 피드 하나가 막혀도 나머지로 답하며, 전부 막히면 웹 검색을 안내한다', async () => {
  const seen = [];
  const partial = await searchNews(['주제'], { now: NOW, fetchImpl: async (url, init) => {
    seen.push(init);
    if (String(url).includes('bing.com')) throw new Error('막힘');
    return feed(rss(googleItem('기사', 'a', 'Thu, 05 Nov 2026 01:00:00 GMT')));
  } });
  assert.equal(partial.items.length, 1);
  assert.equal(partial.failed, 1);
  assert.ok(seen.every((init) => init.credentials === 'omit'));
  assert.match(formatNews(partial), /2개 중 1개를 읽지 못했습니다/);
  const blocked = await searchNews(['주제'], { now: NOW, fetchImpl: async () => feed('막힘', 403) });
  assert.deepEqual([blocked.items.length, blocked.failed], [0, 2]);
  assert.match(formatNews(blocked), /웹 검색으로 찾으세요/);
});

test('뉴스 명령: 한 줄 한 기사로 출력하고 인자를 검사한다', () => {
  const line = formatNews({ failed: 0, total: 2, items: [{ title: '제목', url: 'https://a.example/1', source: '', snippet: '요'.repeat(300), published: new Date(2026, 10, 5, 9, 7) }] });
  const [when, source, title, url, snippet] = line.split('\t');
  assert.deepEqual([when, source, title, url], ['2026-11-05 09:07', '매체 미확인', '제목', 'https://a.example/1']);
  assert.equal(snippet.length, 200);
  assert.deepEqual(parseArgs(['--days', '30', ' 테슬라 ', '']), { queries: ['테슬라'], days: 30 });
  assert.equal(parseArgs(['--days', '천', 'a']).days, 7);
  assert.equal(parseArgs(Array.from({ length: 9 }, (_, i) => `q${i}`)).queries.length, 5);
});
