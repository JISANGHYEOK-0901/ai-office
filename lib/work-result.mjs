import { officeIssues } from './office-files.mjs';
const TOOL_PROBLEM = /office_browser|브라우저[^.\n]{0,40}(?:연결|제공|없)|(?:도구|WebFetch|WebSearch)[^.\n]{0,40}(?:없|연결|거부|막|차단|제공)|실행기[^.\n]{0,30}(?:연결|설정)/i;
export const toolProblem = (text) => TOOL_PROBLEM.test(String(text || ''));

// CLI의 마지막 메시지와 실행기의 제어 신호를 분리한다. 예전 직원의 일반 텍스트도 읽는다.
const STATUSES = ['done', 'needs_decision', 'reroute', 'delegate', 'replan'];
// 응답 전체가 JSON이 아니어도 설명 문장 앞뒤에 붙은 JSON 블록(```json … ``` 또는 {"status": …})을 읽는다. 전체 → 마지막 블록 순서
function controlValue(text) {
  const raw = String(text ?? '').trim();
  const candidates = [raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')];
  for (const match of [...raw.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].reverse()) candidates.push(match[1]);
  const start = [...raw.matchAll(/\{\s*"status"\s*:/g)].at(-1)?.index;
  if (start !== undefined) candidates.push(raw.slice(start, raw.lastIndexOf('}') + 1));
  for (const candidate of candidates) {
    try { const value = JSON.parse(candidate); if (value && STATUSES.includes(value.status)) return value; } catch { /* 다음 후보 */ }
  }
  return null;
}

export function stageResult(text) {
  const value = controlValue(text);
  if (value) {
    // 도구·권한 문제는 대표가 답해도 바뀌지 않는다. 직원이 질문으로 보내도 계획 수정으로 돌린다
    if (value.status === 'needs_decision' && toolProblem(`${value.question || ''} ${value.summary || ''}`)) return { ...value, status: 'replan', reason: value.reason || value.question || value.summary };
    return value;
  }
  // 구버전 직원의 일반 텍스트 응답
  const body = String(text || '').trim();
  if (/(?:전달|이관|재배정)(?:해|이|을|이\s?필요)|(?:부서|팀)(?:으로|에)\s*(?:전달|이관|재배정)/.test(body)) {
    return { status: 'reroute', reason: body, department: '', agent: '' };
  }
  return { status: looksLikeQuestion(body) ? 'needs_decision' : 'done', question: body, summary: body };
}

const ASK = /(확인하겠습니다|확인해\s?주세요|알려\s?주세요|알려\s?주시면|선택해\s?주세요|골라\s?주세요|말씀해\s?주세요|말씀해\s?주시면|답해\s?주세요|답변해\s?주세요|답하셔도|답장|정해\s?주세요|결정해\s?주세요|기본값으로 진행)/;
const COURTESY = /(있으시?면|필요하시면|원하시면|궁금하시면|있다면)[^.!?\n]{0,40}(말씀해|알려)\s?주세요/;
const NUMBERED = /^\s*(?:[*_]{1,2})?\s*(?:\d+|[①-⑳])[.)]?\s.*[?？]/;
export function looksLikeQuestion(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return false;
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = (paras.at(-1) || '').replace(/https?:\/\/\S+/g, '');
  if (/[?？]/.test(last)) return true;
  if (ASK.test(last) && !(COURTESY.test(last) && !/(확인하겠습니다|선택해|골라|답하셔도|답장|기본값으로 진행)/.test(last))) return true;
  const numbered = (chunk) => chunk.split('\n').filter((l) => NUMBERED.test(l)).length;
  return numbered(body) >= 2 || numbered(paras.slice(-3).join('\n')) >= 1;
}

export const HTML_BRIEF = 'HTML은 비개발자가 읽는 보고서입니다. 결론·핵심 수치와 근거/출처·확인일·한계·다음 행동을 구분하고, 제목과 명확한 정보 순서를 갖추세요. 모바일에서도 표/카드가 화면을 넘지 않게 하고 충분한 대비·읽기 쉬운 글자·인쇄용 스타일을 적용하세요. placeholder나 검증하지 않은 수치를 사실처럼 쓰지 마세요.';

// 최소 형식 검사는 모델의 읽기 검토를 보완한다. 미적 완성도나 사실성을 보장하지 않는다.
export function outputIssues(path, content) {
  if (!content.length || !content.toString('utf8').trim()) return ['산출물이 비어 있습니다.'];
  if (/\.json$/i.test(path)) {
    try { JSON.parse(content.toString('utf8')); } catch { return ['JSON 산출물의 문법이 올바르지 않습니다.']; }
  }
  if (/\.(?:pptx|docx|xlsx|pdf)$/i.test(path)) return officeIssues(path, content);
  if (!/\.html?$/i.test(path)) return [];
  const html = content.toString('utf8');
  const issues = [];
  if (/\{\{REPORT_[A-Z_]+\}\}/.test(html)) issues.push('보고서 양식의 빈 항목을 실제 내용으로 채워야 합니다.');
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html) || !/<title\b[^>]*>\s*[^<\s]/i.test(html)) issues.push('HTML 문서 구조와 비어 있지 않은 title이 필요합니다.');
  if (!/<meta\b[^>]*name\s*=\s*["']?viewport\b/i.test(html)) issues.push('모바일 viewport 설정이 필요합니다.');
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] || '';
  const visible = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').replace(/\s/g, '');
  if (visible.length < 40) issues.push('보고서 본문이 충분하지 않습니다.');
  return issues;
}
