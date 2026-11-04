// 전달용 Markdown을 비개발자가 바로 읽는 HTML로 바꾼다. AI를 호출하지 않으며 입력의 HTML은 모두 글자로 표시한다.
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (url) => /^https?:\/\//i.test(url) ? esc(url) : null;

function inline(text) {
  const parts = String(text).split(/(`[^`\n]+`)/);
  return parts.map((part, index) => {
    if (index % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
    const links = [];
    const hold = (html) => { links.push(html); return `\u0000${links.length - 1}\u0000`; };
    let out = part.replace(/\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g, (_, label, url) => hold(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`));
    out = out.replace(/https?:\/\/(?:[^\s<>"'`|()\]]|\([^\s()]*\))+/g, (raw) => {
      const url = raw.replace(/[.,;:!?…。，、]+$/, '');
      return hold(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`) + raw.slice(url.length);
    });
    out = esc(out).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
  }).join('');
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

export function markdownBody(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${head.map((name, c) => `<td data-label="${esc(name.replace(/[*`]/g, ''))}">${inline(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    const item = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
    if (item.test(line)) {
      const ordered = Boolean(line.match(item)[3]);
      const entries = [];
      for (; i < lines.length; i++) {
        const match = lines[i].match(item);
        if (match && (!match[1].length || !entries.length)) { entries.push([match[4]]); continue; }
        // 들여쓴 줄은 앞 항목에 이어 붙인다(하위 목록 포함)
        if (lines[i].trim() && /^\s+/.test(lines[i]) && entries.length) { entries.at(-1).push(lines[i].trim().replace(/^[-*+]\s+/, '')); continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${entries.map(([first, ...rest]) => `<li>${inline(first)}${rest.map((r) => `<br>${inline(r)}`).join('')}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(?:#{1,4}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !(lines[i].includes('|') && isRule(lines[i + 1] || '')); i++) para.push(lines[i].trim());
    if (!para.length) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

export function markdownDocument(markdown, title) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light; --ink: #172b3a; --muted: #516575; --line: #dce5eb; --accent: #0b6c66; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: #f1f5f7; font: 16px/1.7 system-ui, -apple-system, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; }
main { max-width: 1040px; margin: 24px auto; padding: 36px 40px; background: #fff; border: 1px solid var(--line); border-radius: 12px; }
h1 { margin: 0 0 16px; font-size: 1.8rem; line-height: 1.3; }
h2 { margin: 32px 0 12px; font-size: 1.3rem; }
h3, h4 { margin: 24px 0 8px; font-size: 1.05rem; }
p, ul, ol { margin: 0 0 14px; }
ul, ol { padding-left: 24px; }
li + li { margin-top: 8px; }
a { color: #075d91; overflow-wrap: anywhere; text-underline-offset: 3px; }
blockquote { margin: 0 0 14px; padding: 10px 16px; color: var(--muted); border-left: 4px solid var(--accent); background: #f4f8f9; }
code { padding: 1px 5px; background: #edf2f5; border-radius: 4px; font-size: .9em; overflow-wrap: anywhere; }
pre { overflow-x: auto; padding: 14px; background: #edf2f5; border-radius: 8px; }
pre code { padding: 0; background: none; }
hr { margin: 24px 0; border: 0; border-top: 1px solid var(--line); }
.table-wrap { max-width: 100%; overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: .92rem; text-align: left; }
th { background: #f1f5f7; font-weight: 700; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; min-width: 72px; }
tr:last-child td { border-bottom: 0; }
@media (max-width: 640px) {
  main { margin: 0; padding: 22px 16px; border: 0; border-radius: 0; }
  h1 { font-size: 1.45rem; }
  /* 좁은 화면에서는 표의 행을 항목별 카드로 쌓는다 */
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  table, tbody, tr, td { display: block; width: 100%; }
  tr { padding: 10px 12px; border-bottom: 2px solid var(--line); }
  tr:last-child { border-bottom: 0; }
  td { padding: 3px 0; border: 0; min-width: 0; }
  td:empty { display: none; }
  td::before { content: attr(data-label); display: block; color: var(--muted); font-size: .78rem; font-weight: 700; }
}
@media print { body { background: #fff; } main { margin: 0; padding: 0; border: 0; } a { color: inherit; } }
</style>
</head>
<body>
<main>
${markdownBody(markdown)}
</main>
</body>
</html>
`;
}
