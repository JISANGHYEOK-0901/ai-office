// 뉴스 검색 피드(Bing·Google 뉴스 RSS)에서 최신 기사 후보를 AI 호출 없이 받는다. 로그인·API 키가 필요 없다.
// 공식 API가 아니라 형식이 바뀌거나 막힐 수 있다. 그때는 빈 목록을 돌려주고 직원이 웹 검색으로 찾는다.
import { isPublicWebUrl } from './source-check.mjs';

const TIMEOUT_MS = 5000, MAX_ITEMS = 40, MAX_PER_DAY = 15, MAX_BYTES = 2 * 1024 * 1024, DAY_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'AI-Office-news-search/1.0';

const decode = (text) => String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const plain = (text) => decode(decode(text)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '';
const koreanQuery = (query) => /[\p{Script=Hangul}]/u.test(query);

// Bing은 클릭 집계 주소 안에 실제 기사 주소를 담아 준다
function articleUrl(link) {
  const raw = decode(link).trim();
  try {
    const url = new URL(raw);
    return /(^|\.)bing\.com$/i.test(url.hostname) ? url.searchParams.get('url') || '' : raw;
  } catch { return ''; }
}

export function parseFeed(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].flatMap(([, block]) => {
    const source = plain(tag(block, 'News:Source') || tag(block, 'source'));
    let title = plain(tag(block, 'title'));
    // Google은 제목 끝에 " - 매체"를 붙인다
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3).trim();
    const url = articleUrl(tag(block, 'link'));
    const published = new Date(plain(tag(block, 'pubDate')));
    if (!title || !isPublicWebUrl(url) || Number.isNaN(published.getTime())) return [];
    const snippet = plain(tag(block, 'description'));
    // Google의 설명은 제목과 매체를 되풀이할 뿐이라 요약문으로 쓰지 않는다
    return [{ title, url, source, published, snippet: snippet.startsWith(title) ? '' : snippet }];
  });
}

export function feedUrls(query, { days = 7 } = {}) {
  const ko = koreanQuery(query);
  // Bing은 기간을 걸면 결과가 크게 줄어 최신순으로만 받고, 기간은 searchNews가 거른다
  const bing = new URLSearchParams({ q: query, format: 'rss', setlang: ko ? 'ko' : 'en', cc: ko ? 'KR' : 'US', qft: 'sortbydate="1"' });
  const google = new URLSearchParams({ q: `${query} when:${days}d`, hl: ko ? 'ko' : 'en-US', gl: ko ? 'KR' : 'US', ceid: ko ? 'KR:ko' : 'US:en' });
  return [`https://www.bing.com/news/search?${bing}`, `https://news.google.com/rss/search?${google}`];
}

async function readFeed(url, { fetchImpl, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, credentials: 'omit', headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml' } });
    if (!response.ok) return { items: [], failed: true };
    const xml = await response.text();
    return xml.length > MAX_BYTES ? { items: [], failed: true } : { items: parseFeed(xml), failed: false };
  } catch { return { items: [], failed: true }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

const titleKey = (title) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// 검색어들의 결과를 합쳐 최신순으로 돌려준다. 같은 제목은 요약문이 있는 쪽(대개 실제 기사 주소를 주는 Bing)을 남긴다
export async function searchNews(queries, { fetchImpl = globalThis.fetch, signal, days = 7, limit = MAX_ITEMS, now = Date.now() } = {}) {
  const feeds = await Promise.all(queries.flatMap((query) => feedUrls(query, { days })).map((url) => readFeed(url, { fetchImpl, signal })));
  const byKey = new Map();
  for (const item of feeds.flatMap((feed) => feed.items)) {
    if (now - item.published > days * DAY_MS) continue;
    const key = titleKey(item.title);
    const known = byKey.get(key);
    if (!known || (!known.snippet && item.snippet)) byKey.set(key, item);
  }
  // 큰 사건이 난 날은 최신 기사가 전부 그 사건이라 다른 소식이 잘려 나간다. 날짜별 상한을 둬 며칠 치가 함께 들어오게 한다
  const seen = new Set(), perDay = new Map();
  const items = [...byKey.values()].sort((a, b) => b.published - a.published).filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    const day = item.published.toDateString(), count = perDay.get(day) || 0;
    perDay.set(day, count + 1);
    return count < MAX_PER_DAY;
  }).slice(0, limit);
  return { items, failed: feeds.filter((feed) => feed.failed).length, total: feeds.length };
}
