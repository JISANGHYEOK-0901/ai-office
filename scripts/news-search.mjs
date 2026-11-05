#!/usr/bin/env node
// 최신 뉴스 후보를 AI 호출 없이 몇 초 안에 받는다(빠른 조회 직원이 쓴다).
//   node scripts/news-search.mjs [--days 7] "<검색어>" ["<검색어>" …]
// 줄마다 게시 시각<TAB>매체<TAB>제목<TAB>링크<TAB>요약문. 최신순이고, 같은 제목은 합쳐져 있다.
import { pathToFileURL } from 'node:url';
import { searchNews } from '../lib/news-feed.mjs';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function formatNews({ items, failed, total }) {
  const lines = items.map((n) => [stamp(n.published), n.source || '매체 미확인', n.title, n.url, n.snippet.slice(0, 200)].join('\t'));
  if (!items.length) lines.push('# 후보를 받지 못했습니다. 웹 검색으로 찾으세요.');
  if (failed) lines.push(`# 뉴스 피드 ${total}개 중 ${failed}개를 읽지 못했습니다.`);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const queries = [];
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]);
    else queries.push(argv[i]);
  }
  return { queries: queries.map((q) => q.trim()).filter(Boolean).slice(0, 5), days: Number.isInteger(days) && days > 0 && days <= 365 ? days : 7 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { queries, days } = parseArgs(process.argv.slice(2));
  if (!queries.length) {
    console.error('사용법: node scripts/news-search.mjs [--days 7] "<검색어>" ["<검색어>" …]');
    process.exit(1);
  }
  // 받아 둔 연결이 프로세스를 붙잡지 않게 바로 끝낸다. 출력을 다 내보낸 뒤 끝내야 잘리지 않는다
  process.stdout.write(`${formatNews(await searchNews(queries, { days }))}\n`, () => process.exit(0));
}
