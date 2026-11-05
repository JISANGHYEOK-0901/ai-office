#!/usr/bin/env node
// 후보 링크의 실제 제목·게시일을 AI 호출 없이 한 번에 확인한다(빠른 조회 직원이 글을 쓰기 전에 쓴다).
//   node scripts/check-links.mjs <주소> [<주소> …]
// 줄마다 결과<TAB>게시일<TAB>주소<TAB>실제 제목. 결과: ok(열림), broken(없는 페이지), unknown(차단·시간 초과), skipped(내부 주소).
// 게시일을 찾지 못하면 미확인이다. 사내망·로컬 주소는 열지 않는다.
import { pathToFileURL } from 'node:url';
import { inspectLinks } from '../lib/source-check.mjs';

export function formatLinks({ links, omitted }) {
  const clean = (text) => String(text).replace(/\s+/g, ' ').trim();
  const lines = links.map((l) => [l.state, l.date || '미확인', l.url, clean(l.title).slice(0, 200)].join('\t'));
  if (omitted) lines.push(`# 한 번에 확인할 수 있는 수를 넘어 ${omitted}개는 확인하지 않았습니다.`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error('사용법: node scripts/check-links.mjs <주소> [<주소> …]');
    process.exit(1);
  }
  // 받아 둔 연결이 프로세스를 붙잡지 않게 바로 끝낸다. 출력을 다 내보낸 뒤 끝내야 잘리지 않는다
  process.stdout.write(`${formatLinks(await inspectLinks(urls))}\n`, () => process.exit(0));
}
