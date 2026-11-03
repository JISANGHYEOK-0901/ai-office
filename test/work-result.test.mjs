import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputIssues, stageResult } from '../lib/work-result.mjs';
import { redactContext } from '../lib/events.mjs';

test('산출물 검사: 빈 파일·본문 없는 HTML·양식 미작성은 완료하지 않는다', () => {
  assert.ok(outputIssues('data.txt', Buffer.from(' \n ')).length);
  const valid = (body) => Buffer.from(`<!doctype html><html lang="ko"><head><title>조사 결과</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`);
  assert.ok(outputIssues('report.html', valid('<style>' + 'x'.repeat(1000) + '</style>빈 본문')).length);
  assert.ok(outputIssues('report.html', Buffer.from('<html><head><title>' + '긴 제목'.repeat(40) + '</title><meta name="viewport"></head><body></body></html>')).length);
  assert.ok(outputIssues('report.html', valid('{{REPORT_CONCLUSION}}<p>자료를 확인하고 내용을 정리해야 합니다.</p>')).length);
  assert.deepEqual(outputIssues('report.html', valid('<h1>조사 결과</h1><p>확인된 자료와 해석을 구분하고 출처와 기준일을 함께 기록했습니다. 추가 확인이 필요한 사항을 다음 행동과 한계에 정리합니다.</p>')), []);
});

test('재개 문맥은 비밀값을 가리면서 Cookie 뒤의 요청·줄바꿈·코드 들여쓰기를 보존', () => {
  const input = 'Cookie: sid=example-private-cookie\n\n이 자료로 HTML 작성\n```python\nif ready:\n    build_report()\n```\npassword="line1\nline2"';
  const masked = redactContext(input);
  assert.doesNotMatch(masked, /example-private-cookie|line1|line2/);
  assert.match(masked, /\n\n이 자료로 HTML 작성\n```python\nif ready:\n {4}build_report\(\)/);
});

test('직원 응답의 질문·이관은 완료 보고와 구분한다', () => {
  assert.equal(stageResult('{"status":"needs_decision","question":"예산을 알려 주세요."}').status, 'needs_decision');
  assert.equal(stageResult('대표님, 지역과 예산을 알려 주세요?').status, 'needs_decision');
  assert.equal(stageResult('개발부로 전달해 주세요.').status, 'reroute');
  assert.equal(stageResult('파일 작성 완료. 확인 필요: 없음').status, 'done');
});
