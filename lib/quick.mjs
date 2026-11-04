// 단순 조회 빠른 경로: 계획·회의·진행 점검·최종 검토 없이 직원 한 명이 한 번에 끝낸다.
import { codexRole } from './settings.mjs';

const usable = (org, agent) => {
  const dept = org.departments.find((d) => d.id === agent.department);
  if (!dept || agent.active === false || dept.active === false) return false;
  if (dept.engine === 'codex') return codexRole(dept) !== 'review';
  return !Array.isArray(dept.tools) || !dept.tools.length || dept.tools.includes('WebSearch');
};

// 팀장보다 실무 직원을 앞에 둔다
export function quickCandidates(org) {
  return (org?.roster || []).filter((a) => usable(org, a)).sort((a, b) => Number(Boolean(a.lead)) - Number(Boolean(b.lead)))
    .map((a) => ({ id: a.id, name: a.name, department: org.departments.find((d) => d.id === a.department)?.name || a.department, role: a.specialty || a.role || a.description || '' }));
}

export function quickPlan({ org, task, request, agentId }) {
  const candidates = quickCandidates(org);
  const chosen = candidates.find((c) => c.id === agentId) || candidates[0];
  if (!chosen) return null;
  const agent = org.roster.find((a) => a.id === chosen.id);
  const goal = String(request).replace(/\[저장 위치\][^\n]*/g, '').trim().split('\n')[0]
    .replace(/\s*(?:해\s*줘|해\s*주세요|부탁해|부탁합니다)[.!?\s]*$/, '').slice(0, 60).trim() || '빠른 조회';
  return { version: 1, task, goal, deliverables: ['quick'], review: { by: 'chief', criteria: '빠른 조회는 최종 검토를 생략한다' }, gaps: [], publications: [],
    stages: [{ id: 'quick', title: goal, dept: agent.department, agent: agent.id, inputs: [], dependsOn: [], connection: '', target: '',
      output: `outputs/${task}/${agent.department}/${agent.id}-quick.md`,
      done: '대표 요청을 md 파일 하나로 정리한다. 항목마다 제목(원문 그대로), 매체, 날짜, 링크, 한국어 요약 1~2문장을 적는다. 같은 사건은 1건으로 묶어 센다. 수치·날짜는 확인한 자료에서만 가져오고, 확인하지 못한 값은 미확인으로 표시한다. 건수를 채우면 바로 끝내고, 못 채우면 실제 건수와 부족 사유를 적는다.' }] };
}

export const QUICK_GUIDE = '빠른 조회입니다. 검색 결과로 확인되면 페이지를 따로 열지 말고, 날짜나 내용이 불확실할 때만 여세요. 다른 직원에게 분담하지 말고 바로 작성하세요.';

// 최종 검토를 생략하므로 보고서에 그 사실과 출처 자동 확인 결과를 밝힌다
export function quickReport({ goal, summary, sources }) {
  const lines = ['- 빠른 조회 결과입니다. 비서실장 최종 검토를 거치지 않았습니다. 정밀 확인이 필요하면 지시에 "검증해서"를 적어 다시 맡겨 주세요.'];
  if (sources) {
    lines.push(`- 출처 자동 확인: 링크 ${sources.checked}개 확인. 접속 여부와 페이지 제목만 확인했고 본문 수치는 확인하지 않았습니다. 차단·시간 초과로 확인하지 못한 링크 ${sources.unknown.length}개.`);
    for (const b of sources.broken) lines.push(`- 열리지 않는 링크: ${b.url}`);
    for (const m of sources.mismatched) lines.push(`- 제목 확인 필요: ${m.url} (실제 페이지 제목: ${m.title})`);
  }
  return `# ${goal}\n\n## 완료\n\n${String(summary || '결과 파일을 작성했습니다.').trim()}\n\n## 확인 필요\n\n${lines.join('\n')}\n`;
}
