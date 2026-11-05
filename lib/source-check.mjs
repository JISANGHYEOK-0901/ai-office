// 결과 파일에 적힌 출처 링크를 AI 호출 없이 확인한다. 접속 여부와 페이지 제목·게시일만 보며 본문 수치는 확인하지 않는다.
// 사내망·로컬 주소는 열지 않고, 차단·시간 초과는 오류가 아니라 "확인 불가"로 둔다.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_URLS = 40, CONCURRENCY = 6, TIMEOUT_MS = 8000, MAX_REDIRECTS = 5, MAX_BYTES = 1024 * 1024;
const INSPECT_MAX = 30, INSPECT_CONCURRENCY = 10, INSPECT_TIMEOUT_MS = 4000;
// 차단·동의 화면의 제목은 실제 문서 제목이 아니다
const GATE_TITLE = /just a moment|access denied|attention required|are you a robot|captcha|forbidden|sign in|log in|subscribe|403|404|robot check|보안 확인|로그인/i;

export function isPrivateAddress(address) {
  const ip = String(address).toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

// 악센트 차이(versión·version)는 제목 오류가 아니므로 지우고 비교한다
// 로그인·사내망 없이 볼 수 있는 공개 주소인지 주소 형식으로 판단한다(이름 풀이는 호출하는 쪽에서 한다)
export function isPublicWebUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || /\.(?:localhost|local|internal|intranet|lan|home|corp)$/.test(host) || !(isIP(host) || host.includes('.'))) return false;
    return !isIP(host) || !isPrivateAddress(host);
  } catch { return false; }
}

const normalize = (text) => String(text ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const decodeEntities = (text) => String(text)
  .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&([aeiouAEIOU])(?:acute|grave|circ|uml|tilde);/g, '$1').replace(/&ntilde;/g, 'n').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

// 링크마다 주변 글(같은 줄과 위쪽 몇 줄)을 함께 돌려준다. 제목은 대개 그 안에 있다
export function extractSources(text) {
  const lines = String(text).split(/\r?\n/);
  const found = new Map();
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/https?:\/\/[^\s<>"'`|\\\]）]+/g)) {
      // 위키백과처럼 주소 안의 괄호는 살리고, 짝 없는 닫는 괄호부터는 뺀다(마크다운 링크 끝, "(주소)는" 같은 조사)
      let depth = 0, end = match[0].length;
      for (let i = 0; i < match[0].length; i++) {
        if (match[0][i] === '(') depth++;
        else if (match[0][i] === ')' && --depth < 0) { end = i; break; }
      }
      const url = match[0].slice(0, end).replace(/[.,;:!?…。，、]+$/, '');
      if (!found.has(url)) found.set(url, lines.slice(Math.max(0, index - 8), index + 1).join('\n'));
    }
  });
  return [...found].map(([url, context]) => ({ url, context }));
}

// 사이트 이름을 뺀 제목의 가장 긴 조각이 주변 글에 있으면 일치로 본다. 짧거나 차단 화면이면 판단하지 않는다
export function titleMatches(pageTitle, context) {
  const title = decodeEntities(pageTitle).trim();
  if (!title || GATE_TITLE.test(title)) return true;
  const longest = title.split(/\s(?:[|–—·:<-]|::)\s|\s(?:[|–—·]|::)|(?:[|–—·]|::)\s/).map(normalize).sort((a, b) => b.length - a.length)[0] || '';
  return longest.length < 12 || normalize(context).includes(longest);
}

// 게시일 메타 태그 이름(매체별로 다르다). 앞에 있을수록 우선한다
const DATE_META = ['article:published_time', 'og:article:published_time', 'datepublished', 'parsely-pub-date', 'sailthru.date', 'pubdate', 'publishdate', 'publish_date', 'dc.date.issued', 'dc.date', 'date'];

const isoDate = (value) => {
  const match = String(value ?? '').trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/);
  if (!match) return '';
  const [year, month, day] = match.slice(1).map(Number);
  return year >= 1990 && month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
};

// 메타 태그 → 구조화 데이터 → <time> 순서로 게시일을 찾는다. 추정하지 않는다(URL 숫자는 쓰지 않는다)
export function pageDate(html) {
  const metas = new Map();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (name && content && !metas.has(name)) metas.set(name, content[1] ?? content[2]);
  }
  for (const name of DATE_META) {
    const date = isoDate(metas.get(name));
    if (date) return date;
  }
  return isoDate(html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1]) || isoDate(html.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)/i)?.[1]);
}

// 필요한 값을 찾을 때까지만 받는다. 시간이 다 되면 제목을 받았을 때만 받은 데까지로 판단한다
async function readPage(response, signal, needDate) {
  if (!/html/i.test(response.headers.get('content-type') || '') || !response.body) return { title: '', date: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '', size = 0, title = '', date = '';
  try {
    while (size < MAX_BYTES && !signal.aborted && !(title && (date || !needDate))) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; html += decoder.decode(value, { stream: true });
      title ||= html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1].replace(/\s+/g, ' ').trim() || '';
      if (needDate) date ||= pageDate(html);
    }
  } catch (err) { if (!signal.aborted || !title) throw err; }
  finally { await reader.cancel().catch(() => {}); }
  return { title, date };
}

async function probe(url, { fetchImpl, lookup, signal, timeoutMs = TIMEOUT_MS, needDate = false }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = new URL(current);
      if (!['http:', 'https:'].includes(target.protocol)) return { state: 'skipped' };
      const host = target.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
      if (host === 'localhost' || addresses.some(isPrivateAddress)) return { state: 'skipped' };
      const response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal, credentials: 'omit',
        headers: { 'User-Agent': 'AI-Office-source-check/1.0', Accept: 'text/html,*/*' } });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        await response.body?.cancel?.().catch(() => {});
        current = new URL(response.headers.get('location'), current).href;
        continue;
      }
      if ([404, 410].includes(response.status)) { await response.body?.cancel?.().catch(() => {}); return { state: 'broken', status: response.status }; }
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); return { state: 'unknown', status: response.status }; }
      return { state: 'ok', status: response.status, ...await readPage(response, controller.signal, needDate) };
    }
    return { state: 'unknown', status: 'redirect' };
  } catch (err) {
    const code = err?.code || err?.cause?.code;
    return ['ENOTFOUND', 'EAI_NONAME'].includes(code) ? { state: 'broken', status: code } : { state: 'unknown', status: code || 'error' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const isNewsRelay = (url) => { try { return new URL(url).hostname === 'news.google.com'; } catch { return false; } };

// files: [{stage, text}]. 같은 링크는 처음 나온 단계 기준으로 한 번만 연다
export async function checkSources(files, { fetchImpl = globalThis.fetch, lookup = dnsLookup, signal } = {}) {
  const items = new Map();
  for (const { stage, text } of files) {
    for (const source of extractSources(text)) if (!items.has(source.url)) items.set(source.url, { ...source, stage });
  }
  const queue = [...items.values()].slice(0, MAX_URLS);
  const result = { checked: 0, broken: [], mismatched: [], unknown: [], skipped: Math.max(0, items.size - MAX_URLS), relayed: 0 };
  const worker = async () => {
    for (let item = queue.shift(); item && !signal?.aborted; item = queue.shift()) {
      // 구글 뉴스 경유 주소는 코드로 열면 중계 화면만 나와 원문을 확인할 수 없다(브라우저에서는 원문으로 이동한다)
      if (isNewsRelay(item.url)) { result.relayed++; continue; }
      const outcome = await probe(item.url, { fetchImpl, lookup, signal });
      if (outcome.state === 'skipped') { result.skipped++; continue; }
      result.checked++;
      if (outcome.state === 'broken') result.broken.push({ url: item.url, stage: item.stage, status: outcome.status });
      else if (outcome.state === 'unknown') result.unknown.push({ url: item.url, stage: item.stage, status: outcome.status });
      else if (outcome.title && !titleMatches(outcome.title, item.context)) result.mismatched.push({ url: item.url, stage: item.stage, title: decodeEntities(outcome.title) });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return result;
}

// 직원이 글을 쓰기 전에 후보 링크를 한 번에 확인한다: 열리는지, 실제 제목, 게시일. 입력 순서대로 돌려준다
export async function inspectLinks(urls, { fetchImpl = globalThis.fetch, lookup = dnsLookup, signal, timeoutMs = INSPECT_TIMEOUT_MS } = {}) {
  const unique = [...new Set(urls)];
  const queue = unique.slice(0, INSPECT_MAX).map((url, index) => ({ url, index }));
  const found = new Array(queue.length);
  const worker = async () => {
    for (let item = queue.shift(); item && !signal?.aborted; item = queue.shift()) {
      const { state, status, title = '', date = '' } = await probe(item.url, { fetchImpl, lookup, signal, timeoutMs, needDate: true });
      found[item.index] = { url: item.url, state, status, title: decodeEntities(title), date };
    }
  };
  await Promise.all(Array.from({ length: INSPECT_CONCURRENCY }, worker));
  return { links: found.filter(Boolean), omitted: Math.max(0, unique.length - INSPECT_MAX) };
}

// 담당에게 되돌릴 사유: 다시 조사하지 않고 해당 항목만 고치게 한다
export function sourceProblemReason(problems) {
  const lines = [
    ...problems.filter((p) => p.title === undefined).map((p) => `- 링크가 열리지 않음(${p.status}): ${p.url}`),
    ...problems.filter((p) => p.title !== undefined).map((p) => `- 적은 제목이 실제 페이지 제목과 다름: ${p.url} (실제 제목: ${p.title})`),
  ];
  return `출처 자동 확인에서 아래 항목이 어긋났습니다. 처음부터 다시 조사하지 말고 지금 파일을 읽어 이 항목만 고치세요. 열리지 않는 링크는 다른 출처로 바꾸거나 빼고 건수를 다시 적으세요. 항목의 제목으로 적은 글이 다르면 실제 제목으로 고치고, 제목 없이 참고로 적은 링크이거나 차단 화면이면 그대로 두세요.\n${lines.join('\n')}`;
}
