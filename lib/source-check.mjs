// 결과 파일에 적힌 출처 링크를 AI 호출 없이 확인한다. 접속 여부와 페이지 제목만 보며 본문 수치는 확인하지 않는다.
// 사내망·로컬 주소는 열지 않고, 차단·시간 초과는 오류가 아니라 "확인 불가"로 둔다.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_URLS = 40, CONCURRENCY = 6, TIMEOUT_MS = 8000, MAX_REDIRECTS = 5, MAX_BYTES = 256 * 1024;
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
      let url = match[0].replace(/[.,;:!?…。，、]+$/, '');
      // 위키백과처럼 주소 안의 괄호는 살리고, 마크다운 링크를 닫는 괄호만 뺀다
      while (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1).replace(/[.,;:!?…。，、]+$/, '');
      if (!found.has(url)) found.set(url, lines.slice(Math.max(0, index - 8), index + 1).join('\n'));
    }
  });
  return [...found].map(([url, context]) => ({ url, context }));
}

// 사이트 이름을 뺀 제목의 가장 긴 조각이 주변 글에 있으면 일치로 본다. 짧거나 차단 화면이면 판단하지 않는다
export function titleMatches(pageTitle, context) {
  const title = decodeEntities(pageTitle).trim();
  if (!title || GATE_TITLE.test(title)) return true;
  const longest = title.split(/\s[|–—·:-]\s|\s[|–—·]|[|–—·]\s/).map(normalize).sort((a, b) => b.length - a.length)[0] || '';
  return longest.length < 12 || normalize(context).includes(longest);
}

async function readTitle(response, signal) {
  if (!/html/i.test(response.headers.get('content-type') || '') || !response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '', size = 0;
  try {
    while (size < MAX_BYTES && !signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; html += decoder.decode(value, { stream: true });
      const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
      if (title) return title[1].replace(/\s+/g, ' ').trim();
    }
  } finally { await reader.cancel().catch(() => {}); }
  return '';
}

async function probe(url, { fetchImpl, lookup, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
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
      return { state: 'ok', status: response.status, title: await readTitle(response, controller.signal) };
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

// files: [{stage, text}]. 같은 링크는 처음 나온 단계 기준으로 한 번만 연다
export async function checkSources(files, { fetchImpl = globalThis.fetch, lookup = dnsLookup, signal } = {}) {
  const items = new Map();
  for (const { stage, text } of files) {
    for (const source of extractSources(text)) if (!items.has(source.url)) items.set(source.url, { ...source, stage });
  }
  const queue = [...items.values()].slice(0, MAX_URLS);
  const result = { checked: 0, broken: [], mismatched: [], unknown: [], skipped: Math.max(0, items.size - MAX_URLS) };
  const worker = async () => {
    for (let item = queue.shift(); item && !signal?.aborted; item = queue.shift()) {
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

// 담당에게 되돌릴 사유: 다시 조사하지 않고 해당 항목만 고치게 한다
export function sourceProblemReason(problems) {
  const lines = [
    ...problems.filter((p) => p.title === undefined).map((p) => `- 링크가 열리지 않음(${p.status}): ${p.url}`),
    ...problems.filter((p) => p.title !== undefined).map((p) => `- 적은 제목이 실제 페이지 제목과 다름: ${p.url} (실제 제목: ${p.title})`),
  ];
  return `출처 자동 확인에서 아래 항목이 어긋났습니다. 처음부터 다시 조사하지 말고 지금 파일을 읽어 이 항목만 고치세요. 열리지 않는 링크는 다른 출처로 바꾸거나 빼고 건수를 다시 적으세요. 항목의 제목으로 적은 글이 다르면 실제 제목으로 고치고, 제목 없이 참고로 적은 링크이거나 차단 화면이면 그대로 두세요.\n${lines.join('\n')}`;
}
