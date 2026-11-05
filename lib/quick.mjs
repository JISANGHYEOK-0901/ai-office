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
      done: '대표 요청을 md 파일 하나로 정리한다. 항목마다 제목(원문 그대로), 매체, 날짜, 개별 글 링크, 한국어 요약 1~2문장을 적는다. 같은 사건은 1건으로 묶어 센다(묶은 보도를 한 항목에 나열하지 않고 대표 기사 1개만 적는다). 수치·날짜는 확인한 자료에서만 가져오고, 확인하지 못한 값은 미확인으로 표시한다. 건수를 채우면 바로 끝내고, 못 채우면 실제 건수와 부족 사유를 적는다.' }] };
}

// 응답을 주고받는 횟수가 곧 시간이라 순서를 응답 단위로 정해 준다.
// 셸이 있는 직원은 뉴스 후보와 링크 확인을 코드로 처리한다(AI 호출 없음). 웹 검색은 날짜가 없고 최신 글을 놓치는 일이 잦다
export function quickGuide({ today = '', newsSearch = '', linkCheck = '' } = {}) {
  const news = newsSearch ? [
    '[뉴스·소식·동향처럼 최근 일어난 일을 찾는 요청]',
    `첫 응답에서 이 명령 한 번으로 후보를 받으세요(몇 초 걸립니다): ${newsSearch} "<검색어>" "<검색어>" … 해외 주제면 한국어와 영어 검색어를 함께 주세요. 줄마다 게시 시각·매체·제목·링크·요약문이 최신순으로 나옵니다.`,
    '다음 응답에서 바로 파일을 쓰세요. 먼저 후보를 사건별로 묶고 사건마다 기사 1개만 고르세요. 같은 결과·발표·사고를 다룬 보도는 속보·분석·시사점처럼 각도가 달라도 1건입니다. 게시 시각 최신순으로 적으세요.',
    '제목·매체·날짜·링크는 받은 값 그대로 적고, 요약은 받은 요약문과 제목에 있는 내용만 쓰세요. 페이지를 열지 마세요. 사건이 건수에 모자라면 --days 30을 붙여 한 번 더 받고, 그래도 모자라면 실제 건수와 사유를 적으세요.',
    '[기능·방법·문서·제품 정보·개념처럼 내용을 찾는 요청, 또는 뉴스 명령에서 후보를 받지 못한 경우]',
  ].join('\n') : '';
  return [
    `빠른 조회입니다. 다른 직원에게 분담하지 말고 혼자, 아래 순서대로 끝내세요.${today ? ` 오늘은 ${today}입니다.` : ''}`,
    news,
    '1. 검색(첫 응답에서 동시에): 서로 다른 검색어 2~3개를 한 번에 검색해 개별 글 주소를 요청 건수의 2배쯤 모으세요. 사이트 첫 화면·목록은 후보가 아닙니다.',
    linkCheck
      ? `2. 확인(다음 응답에서 한 번): 후보 주소 전부를 이 명령 한 번으로 확인하세요(몇 초 걸립니다): ${linkCheck} <주소> <주소> … 줄마다 결과·게시일·주소·실제 제목이 나옵니다. 페이지를 하나씩 열지 마세요. broken은 버립니다. unknown이나 게시일 미확인은 버리지 말고 날짜를 미확인으로 적어 쓰세요.`
      : '2. 확인: 검색 결과에 날짜나 제목이 없는 후보만 열어 확인하세요. 확인하지 못한 항목은 버리지 말고 미확인으로 적으세요.',
    '3. 선별: 공식 문서·1차 자료를 앞에 두고, 같은 내용을 되풀이한 자료는 1건만 남기세요. 뉴스라면 같은 사건은 1건입니다. 최신 자료 요청이면 오래된 글은 건수가 모자랄 때만 쓰고 오래된 글임을 밝히세요.',
    `4. 작성: 제목은 ${linkCheck ? '확인 결과의 실제 제목에서 사이트 이름만 뺀' : '원문'} 그대로 적으세요. 주소를 보고 제목을 만들지 마세요. 건수가 모자라면 실제 건수와 사유를 적고 끝내세요.`,
  ].filter(Boolean).join('\n');
}

// 전체 절차의 수집 단계 안내. 검증하기 쉬운 글을 고르느라 최신 사건을 빼면 최종 검토에서 반려돼 수집부터 다시 돈다
export function collectGuide({ today = '', newsSearch = '', linkCheck = '', firstStage = false } = {}) {
  return [
    firstStage && newsSearch ? `뉴스·최신 소식을 모으는 단계면: 먼저 이 명령 한 번으로 후보를 받으세요(몇 초 걸립니다): ${newsSearch} "<검색어>" "<검색어>" …${today ? ` 오늘은 ${today}입니다.` : ''} 최근 사건 위주로 고르되(최근 며칠 안의 순서는 엄밀히 따지지 않습니다), 검증하기 쉽다는 이유로 더 최근 사건을 빼지 마세요. 교차 확인이 부족하면 빼지 말고 일부 확인·미확인으로 표시하세요. 피드의 시각·요약은 후보를 고르는 데만 쓰고 확인된 사실로 적지 마세요. 고른 건마다 원문 주소를 찾아 적고 본문을 열어 날짜·수치를 확인하세요. 구글 뉴스 경유 링크(news.google.com)는 열리지 않으니 제목으로 웹 검색해 원문을 찾고, 찾지 못하면 다른 후보로 바꾸세요. 고른 건만 확인하고 후보를 더 찾지 마세요.` : '',
    linkCheck ? `여러 링크의 열림 여부·실제 제목·게시일은 하나씩 열지 말고 이 명령 한 번으로 확인하세요: ${linkCheck} <주소> <주소> …` : '',
  ].filter(Boolean).join('\n');
}

// 최종 검토를 생략하므로 보고서에 그 사실과 출처 자동 확인 결과를 밝힌다
export function quickReport({ goal, summary, sources }) {
  const lines = ['- 빠른 조회 결과입니다. 비서실장 최종 검토를 거치지 않았습니다. 정밀 확인이 필요하면 지시에 "검증해서"를 적어 다시 맡겨 주세요.'];
  if (sources) {
    lines.push(`- 출처 자동 확인: 링크 ${sources.checked}개 확인. 접속 여부와 페이지 제목만 확인했고 본문 수치는 확인하지 않았습니다. 차단·시간 초과로 확인하지 못한 링크 ${sources.unknown.length}개.${sources.relayed ? ` 구글 뉴스 경유 링크 ${sources.relayed}개는 원문을 코드로 확인할 수 없어 뺐습니다(브라우저에서 누르면 원문으로 이동합니다).` : ''}`);
    for (const b of sources.broken) lines.push(`- 열리지 않는 링크: ${b.url}`);
    for (const m of sources.mismatched) lines.push(`- 제목 확인 필요: ${m.url} (실제 페이지 제목: ${m.title})`);
  }
  return `# ${goal}\n\n## 완료\n\n${String(summary || '결과 파일을 작성했습니다.').trim()}\n\n## 확인 필요\n\n${lines.join('\n')}\n`;
}
