// 현재 조직도(Markdown). 비서실장이 사용자가 만든 부서·직원을 읽고 분담·협조 순서를 계획하도록 실행 때마다 주입한다.
// 부서 이름·id를 코드에 하드코딩하지 않고 정본(org)만으로 만든다. 순수 함수다(파일을 읽지 않는다).
import { resolveAgentModel } from './sync.mjs';
import { DEFAULT_CODEX_MODEL } from './cli.mjs';

const MAX_FIELD = 120;

// 정본 값은 사용자가 입력한 문자열이라 줄바꿈·Markdown 제어 문자를 정리해 한 줄로 만든다
function line(text, max = MAX_FIELD) {
  const s = String(text ?? '').replace(/\s+/g, ' ').replace(/[`|]/g, "'").trim();
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

const tags = (list) => (Array.isArray(list) ? list.filter((t) => typeof t === 'string' && t.trim()).map((t) => line(t, 40)) : []);

// 부서에 capabilities·handoffs가 없으면 같은 id의 프리셋 기본값으로 보충한다(예전에 만든 부서 호환)
function deptProfile(dept, presets) {
  const preset = (presets?.departments ?? []).find((p) => p && p.id === dept.id);
  const own = (k) => (Array.isArray(dept[k]) ? dept[k] : null);
  return {
    capabilities: tags(own('capabilities') ?? preset?.capabilities),
    handoffs: (own('handoffs') ?? preset?.handoffs ?? []).filter((h) => typeof h === 'string'),
    fromPreset: !own('capabilities') && Array.isArray(preset?.capabilities),
  };
}

const sortDepts = (departments) => [...departments]
  .map((d, i) => ({ d, i }))
  .sort((x, y) => (x.d.order ?? Infinity) - (y.d.order ?? Infinity) || x.i - y.i)
  .map(({ d }) => d);

/**
 * @param {{departments:any[], roster:any[]}} org
 * @param {{presets?:{departments:any[]}}} [opts]
 * @returns {string} Markdown
 */
export function buildOrgMap(org, { presets } = {}) {
  const departments = sortDepts(Array.isArray(org?.departments) ? org.departments.filter((d) => d && d.id) : []);
  const roster = Array.isArray(org?.roster) ? org.roster.filter((a) => a && a.id) : [];
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const out = [
    '# 현재 조직도 (AI Office)',
    '',
    '사용자가 만든 지금의 조직이다. 부서 이름을 짐작하지 말고 이 목록만 기준으로 분담·협조 순서를 계획한다.',
    '- 업무는 아래 **근무중** 직원에게만 Agent(subagent_type = 직원 id)로 배정한다. 휴무·운영 중지 직원은 부를 수 없다.',
    '- Codex 검증실 직원은 Agent로 부르지 않고 `node scripts/codex-review.mjs --target outputs/<업무> --reviewers <직원 id>`로 실행한다.',
    '- 지시문에 담당(부서·이름·직무)이 하나도 없고 관련 근무중 부서가 둘 이상이면, 요청이 짧아도 계획 전에 관련 팀장·담당 2~4명을 `[회의]` Agent로 병렬 소집해 분담을 정하고 meeting.md에 남긴다.',
    '- 배정 전에 `outputs/<업무>/plan.json`을 쓰고 `node scripts/office.mjs plan validate <업무>`로 검사한다.',
    '- 필요한 역량을 가진 근무중 부서가 없으면 대신 하지 말고 plan.gaps에 적은 뒤 가능한 단계만 진행한다.',
    '',
  ];

  if (!departments.length) {
    out.push('부서가 아직 없습니다. 직접 실무를 하지 말고, 대시보드 "조직" 탭에서 부서와 직원을 추가하도록 사용자에게 안내한다.', '');
    return out.join('\n');
  }

  const available = new Map(); // 역량 → 근무중 직원이 있는 부서 이름(Agent로 배정 가능한 claude 부서만)
  const unlabeled = []; // 근무중 직원은 있지만 역량을 입력하지 않은 부서
  const reviewOnly = []; // 근무중 직원이 있는 Codex 부서(읽기 전용 검토만, 산출물 단계 배정 불가)
  out.push('## 부서', '');
  for (const dept of departments) {
    const members = roster.filter((a) => a.department === dept.id);
    const deptOff = dept.active === false;
    const working = deptOff ? [] : members.filter((a) => a.active !== false);
    const codex = dept.engine === 'codex';
    const { capabilities, handoffs, fromPreset } = deptProfile(dept, presets);
    const head = [`### ${line(dept.name, 40)} (\`${dept.id}\`)`];
    if (codex) head.push('· Codex 검증실(검토 전용 — 산출물 단계 배정 불가)');
    if (deptOff) head.push('· 운영 중지(배정 불가)');
    else if (!working.length) head.push('· 근무중 직원 없음(배정 불가)');
    out.push(head.join(' '));
    if (dept.summary) out.push(`- 하는 일: ${line(dept.summary)}`);
    out.push(`- 역량: ${capabilities.length ? capabilities.join(', ') : '(미입력 — summary와 직원 담당으로 판단)'}${fromPreset ? ' (프리셋 기본값)' : ''}`);
    if (handoffs.length) {
      const names = handoffs.map((h) => {
        const target = deptById.get(h);
        return target ? `${line(target.name, 40)}(\`${h}\`)` : `\`${h}\`(조직에 없음)`;
      });
      out.push(`- 주로 결과를 넘기는 부서: ${names.join(', ')}`);
    }
    if (!members.length) out.push('- 직원: 없음');
    for (const a of members) {
      const off = deptOff || a.active === false;
      const parts = [`\`${a.id}\``, line(a.name, 40)];
      const rank = a.rank || a.title || (a.lead ? '팀장' : '담당');
      // 직급이 이미 '팀장'이면 팀장 표시를 겹쳐 쓰지 않는다(예: "팀장(팀장)")
      parts.push(a.lead && line(rank, 20) !== '팀장' ? `${line(rank, 20)}(팀장)` : line(rank, 20));
      if (a.role) parts.push(`직무 ${line(a.role, 48)}`);
      const duty = a.specialty || a.description;
      if (duty) parts.push(`담당: ${line(duty)}`);
      parts.push(codex ? `모델 codex ${line(dept.codexModel || DEFAULT_CODEX_MODEL, 64)}` : `모델 ${resolveAgentModel(a, dept)}`);
      out.push(`- ${off ? '~~' : ''}${parts.join(' · ')}${off ? '~~ (휴무 — 배정 불가)' : ''}`);
    }
    out.push('');
    if (working.length && codex) {
      reviewOnly.push(line(dept.name, 40));
      continue;
    }
    if (working.length && !capabilities.length) unlabeled.push(line(dept.name, 40));
    if (working.length) {
      for (const c of capabilities) {
        if (!available.has(c)) available.set(c, []);
        available.get(c).push(line(dept.name, 40));
      }
    }
  }

  out.push('## 역량 색인 (근무중 직원이 있고 Agent로 배정할 수 있는 부서만)', '');
  for (const [cap, names] of available) out.push(`- ${cap}: ${names.join(', ')}`);
  if (unlabeled.length) out.push(`- (역량 미입력) ${unlabeled.join(', ')}: 부서 설명과 직원 담당으로 판단한다.`);
  if (reviewOnly.length) out.push(`- (검토 전용) ${reviewOnly.join(', ')}: Codex 읽기 전용 검토만 한다(codex-review.mjs). 조사·작성 같은 산출물 단계는 맡길 수 없다.`);
  if (!available.size && !unlabeled.length) {
    out.push('- 배정 가능한 부서가 없습니다. 직접 실무를 하지 말고 산출물이 필요한 일은 plan.gaps에 적은 뒤, 사용자에게 직원 근무 전환이나 부서 추가를 안내한다.');
  }
  out.push('');
  return out.join('\n');
}
