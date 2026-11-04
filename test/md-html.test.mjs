import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownBody } from '../lib/md-html.mjs';

test('제목·목록·표·인용·코드·강조·링크를 변환한다', () => {
  const html = markdownBody('# 제목\n\n본문 **굵게** *기울임* `코드`\n\n- 하나\n- 둘\n\n1. 첫째\n   - 매체: A\n2. 둘째\n\n> 인용\n\n---\n\n```\n<b>원문</b>\n```\n\n[기사](https://a.example/x) 와 https://b.example/y.');
  for (const part of ['<h1>제목</h1>', '<strong>굵게</strong>', '<em>기울임</em>', '<code>코드</code>', '<ul><li>하나</li><li>둘</li></ul>', '<ol><li>첫째<br>매체: A</li><li>둘째</li></ol>', '<blockquote>인용</blockquote>', '<hr>', '&lt;b&gt;원문&lt;/b&gt;', '>기사</a>', 'href="https://b.example/y"']) assert.ok(html.includes(part), part);
  assert.match(html, /<\/a>\.<\/p>/, '끝 문장부호는 링크에서 뺀다');
});

test('표: 칸 수가 달라도 머리글 기준으로 맞추고 이스케이프한 세로줄을 살린다', () => {
  const html = markdownBody('| 제목 | 링크 |\n|---|---|\n| a\\|b | https://a.example/(x) |\n| 빈칸 |\n');
  assert.ok(html.includes('<td data-label="제목">a|b</td>'));
  assert.ok(html.includes('href="https://a.example/(x)"'));
  assert.ok(html.includes('<td data-label="제목">빈칸</td><td data-label="링크"></td>'));
  assert.ok(markdownBody('[위키](https://a.example/w_(x)) 끝').includes('href="https://a.example/w_(x)"'));
});

test('위험한 입력은 실행되지 않는다', () => {
  const html = markdownBody('<img src=x onerror=alert(1)>\n\n[누르기](javascript:alert(1))\n\n| <script>x</script> | b |\n|---|---|\n| `<i>` | "q" |');
  assert.doesNotMatch(html, /<img|<script|href="javascript/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test('표 머리글의 따옴표는 data-label에서 이스케이프한다', () => {
  assert.ok(markdownBody('| "a"><b> |\n|---|\n| x |').includes('data-label="&quot;a&quot;&gt;&lt;b&gt;"'));
});

test('내용 없는 입력과 닫히지 않은 코드 블록에서 멈추지 않는다', () => {
  assert.equal(markdownBody(''), '');
  assert.match(markdownBody('```\n코드'), /코드/);
  assert.equal(markdownBody('- '), '<ul><li></li></ul>');
  assert.match(markdownBody('| 표 아님 |'), /표 아님/);
});
