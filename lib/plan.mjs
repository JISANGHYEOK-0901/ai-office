// 작업 계획표(outputs/<업무>/plan.json) 검사. 비서실장이 배정 전에 쓰고 `office.mjs plan validate <업무>`로 확인한다.
// 형식: {version:1, task, goal, stages:[{id, title, dept, agent, inputs, output, done, dependsOn, parallelGroup?}],
//        review:{by, criteria}, gaps:[{need, suggestion}]}
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { redact } from './events.mjs';
import { codexRole } from './settings.mjs';

export const PLAN_VERSION = 1;
export const MAX_STAGES = 30;
const STAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
// 업무 id: <YYYY-MM-DD>/<slug>. 경로로 쓰므로 이 형식만 받는다
export const TASK_ID_PATTERN = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Claude Code는 서브에이전트가 이 이름의 .md 파일을 쓰지 못하게 막는다(claude 2.1.312 Write 도구:
// "Subagents should return findings as text, not write report files."). 단계 산출물로 정하면 그 단계가 반드시 실패한다
export const SUBAGENT_BLOCKED_MD = /^(report|summary|findings|analysis).*\.md$/i;

export const isTaskId = (id) => typeof id === 'string' && TASK_ID_PATTERN.test(id) && !id.includes('..');

const inside = (base, target) => {
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

const toPosix = (p) => p.split(sep).join('/');

// 산출물은 기존 계약(업무 상대 또는 outputs/…)을 유지한다.
export function resolvePlanPath(value, { root, taskId }) {
  const path = normalize(String(value).replace(/\\/g, '/'));
  return resolve(isAbsolute(path) || /^outputs[\\/]/.test(path) ? root : resolve(root, 'outputs', taskId), path);
}

// 기존 업무 상대 입력·예정 산출물이 우선이다. 없는 경우 작업 공간의 원본을 찾는다.
export function resolvePlanInput(value, { root, taskId, fileExists = () => false, outputs = [] }) {
  const path = normalize(String(value).replace(/\\/g, '/'));
  const local = resolvePlanPath(path, { root, taskId });
  if (isAbsolute(path) || /^outputs[\\/]/.test(path) || fileExists(local) || outputs.includes(local)) return local;
  const workspace = resolve(root, path);
  return fileExists(workspace) ? workspace : local;
}

// 직원 CLI의 cwd는 작업 공간이다. 표시용 요약 대신 확정한 전체 입력 경로를 넘긴다.
export function normalizePlanInputs(plan, options) {
  if (!Array.isArray(plan?.stages)) return plan;
  const ids = new Set(plan.stages.map((stage) => stage?.id));
  const outputs = plan.stages.filter((stage) => typeof stage?.output === 'string')
    .map((stage) => resolvePlanPath(stage.output, options));
  return { ...plan, stages: plan.stages.map((stage) => !Array.isArray(stage?.inputs) ? stage : { ...stage,
    inputs: stage.inputs.map((input) => typeof input !== 'string' || ids.has(input) ? input
      : resolvePlanInput(input, { ...options, outputs })) }) };
}

/**
 * 계획표를 검사한다. 파일 존재 확인은 fileExists(절대경로)로 주입한다(테스트·순수성).
 * @returns {{ok:boolean, errors:string[], warnings:string[], plan?:object}} plan은 이벤트용 요약(compactPlan)
 */
export function validatePlan(plan, { org, taskId, root, fileExists = () => false } = {}) {
  const errors = [];
  const warnings = [];
  if (!isTaskId(taskId)) return { ok: false, errors: [`업무 id 형식이 올바르지 않습니다: ${JSON.stringify(taskId)}`], warnings };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, errors: ['plan.json은 JSON 객체여야 합니다.'], warnings };
  }
  if (plan.version !== PLAN_VERSION) errors.push(`version은 ${PLAN_VERSION}이어야 합니다: ${JSON.stringify(plan.version ?? null)}`);
  if (plan.task !== undefined && plan.task !== taskId) errors.push(`task가 업무 id와 다릅니다: ${JSON.stringify(plan.task)} (기대값 ${taskId})`);
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) errors.push('goal(업무 목표)이 비어 있습니다.');
  const stages = plan.stages;
  if (!Array.isArray(stages) || !stages.length) {
    errors.push('stages(단계)가 하나 이상 있어야 합니다.');
    return { ok: false, errors, warnings };
  }
  if (stages.length > MAX_STAGES) errors.push(`단계는 ${MAX_STAGES}개 이하여야 합니다(현재 ${stages.length}개).`);

  const departments = Array.isArray(org?.departments) ? org.departments : [];
  const roster = Array.isArray(org?.roster) ? org.roster : [];
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const agentById = new Map(roster.map((a) => [a.id, a]));
  const workingList = () => roster
    .filter((a) => a.active !== false && deptById.get(a.department)?.active !== false)
    .map((a) => a.id).join(', ') || '(없음)';

  const repo = resolve(root || '.');
  const taskDir = resolve(repo, 'outputs', ...taskId.split('/'));
  const resolvePath = (p) => resolvePlanPath(p, { root: repo, taskId });

  const ids = new Set();
  const byId = new Map();
  const outputOwners = new Map();
  stages.forEach((st, i) => {
    const label = `단계 ${typeof st?.id === 'string' ? st.id : `#${i + 1}`}`;
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
      errors.push(`${label}: 객체여야 합니다.`);
      return;
    }
    if (typeof st.id !== 'string' || !STAGE_ID.test(st.id)) errors.push(`${label}: id는 영문·숫자·_- 40자 이하여야 합니다.`);
    else if (ids.has(st.id)) errors.push(`${label}: id가 중복됩니다.`);
    else { ids.add(st.id); byId.set(st.id, st); }
    if (typeof st.title !== 'string' || !st.title.trim()) errors.push(`${label}: title(할 일)이 비어 있습니다.`);
    if (typeof st.done !== 'string' || !st.done.trim()) errors.push(`${label}: done(완료 기준)이 비어 있습니다.`);

    const dept = deptById.get(st.dept);
    const agent = agentById.get(st.agent);
    if (!dept) errors.push(`${label}: 부서 ${JSON.stringify(st.dept ?? null)}가 조직에 없습니다. 있는 부서: ${departments.map((d) => d.id).join(', ') || '(없음)'}`);
    else if (dept.active === false) errors.push(`${label}: 부서 ${dept.id}는 운영 중지 상태입니다.`);
    if (!agent) {
      errors.push(`${label}: 직원 ${JSON.stringify(st.agent ?? null)}가 조직에 없습니다. 근무중 직원: ${workingList()}`);
    } else {
      if (agent.active === false) errors.push(`${label}: 직원 ${agent.id}(${agent.name ?? ''})는 휴무 중입니다. 근무중 직원: ${workingList()}`);
      if (dept && agent.department !== dept.id) errors.push(`${label}: 직원 ${agent.id}는 ${dept.id} 소속이 아닙니다(소속: ${agent.department}).`);
      if (deptById.get(agent.department)?.engine === 'codex' && codexRole(deptById.get(agent.department)) === 'review') {
        // Codex 직원은 읽기 전용 검토만 한다(codex-review.mjs → reviews/). 생산 단계를 맡기면 output을 만들 수 없어 단계가 끝나지 않는다
        const out = typeof st.output === 'string' ? st.output.trim() : '';
        const rel = out ? toPosix(relative(taskDir, resolvePath(out))) : '';
        if (rel && !rel.startsWith('reviews/')) {
          errors.push(`${label}: ${agent.id}는 Codex 검증실(읽기 전용 검토) 직원이라 산출물 단계를 맡을 수 없습니다. 검토 단계면 output을 reviews/${agent.id}.md로 두고, 산출물을 만들 근무중 직원이 없으면 gaps에 적으세요.`);
        } else {
          warnings.push(`${label}: ${agent.id}는 Codex 검증실 직원입니다. Agent가 아니라 codex-review.mjs --reviewers ${agent.id}로 실행합니다.`);
        }
      }
    }

    if (typeof st.output !== 'string' || !st.output.trim()) {
      errors.push(`${label}: output(산출물 경로)이 비어 있습니다.`);
    } else if (!inside(taskDir, resolvePath(st.output))) {
      errors.push(`${label}: output은 outputs/${taskId}/ 안이어야 합니다: ${st.output}`);
    } else if (SUBAGENT_BLOCKED_MD.test(st.output.trim().split(/[\\/]/).pop())) {
      errors.push(`${label}: 직원(서브에이전트)은 report·summary·findings·analysis로 시작하는 .md 파일을 쓸 수 없습니다(Claude Code 제한). 직원 id를 앞에 붙이세요(예: ${st.agent || '<직원id>'}-${st.output.trim().split(/[\\/]/).pop()}): ${st.output}`);
    }
    if (typeof st.output === 'string' && st.output.trim()) {
      const path = resolvePath(st.output);
      if (outputOwners.has(path)) errors.push(`${label}: 산출물 경로가 단계 ${outputOwners.get(path)}와 같습니다. 단계별로 다른 파일을 지정하세요.`);
      else outputOwners.set(path, st.id);
    }
    if (st.dependsOn !== undefined && !(Array.isArray(st.dependsOn) && st.dependsOn.every((d) => typeof d === 'string'))) {
      errors.push(`${label}: dependsOn은 단계 id 배열이어야 합니다.`);
    }
    if (st.inputs !== undefined && !(Array.isArray(st.inputs) && st.inputs.every((d) => typeof d === 'string' && d.trim()))) {
      errors.push(`${label}: inputs는 경로나 단계 id 문자열 배열이어야 합니다.`);
    }
  });

  // dependsOn 대상 존재·자기 참조
  const deps = (st) => (Array.isArray(st?.dependsOn) ? st.dependsOn.filter((d) => typeof d === 'string') : []);
  for (const st of byId.values()) {
    for (const d of deps(st)) {
      if (d === st.id) errors.push(`단계 ${st.id}: 자기 자신에 의존할 수 없습니다.`);
      else if (!byId.has(d)) errors.push(`단계 ${st.id}: dependsOn의 단계 ${d}가 없습니다.`);
    }
  }

  // 순환 검사(DFS)
  const state = new Map(); // id → 1 방문 중, 2 완료
  const cycle = [];
  const visit = (id, pathIds) => {
    if (state.get(id) === 2 || cycle.length) return;
    if (state.get(id) === 1) {
      cycle.push(...pathIds.slice(pathIds.indexOf(id)), id);
      return;
    }
    state.set(id, 1);
    for (const d of deps(byId.get(id))) if (byId.has(d) && d !== id) visit(d, [...pathIds, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
  if (cycle.length) errors.push(`단계 의존 관계에 순환이 있습니다: ${cycle.join(' → ')}`);

  // 앞 단계(전이적 dependsOn) 계산. 순환이 있으면 무한 반복하지 않도록 방문 집합을 쓴다
  const ancestors = (id) => {
    const seen = new Set();
    const stack = [...deps(byId.get(id))];
    while (stack.length) {
      const d = stack.pop();
      if (seen.has(d) || !byId.has(d)) continue;
      seen.add(d);
      stack.push(...deps(byId.get(d)));
    }
    return seen;
  };

  // 기존 handoffs는 권장 경로다. 사용자가 필수로 지정한 경우에만 실제 의존 경로를 강제한다.
  for (const st of byId.values()) {
    const dept = deptById.get(st.dept);
    if (dept?.handoffPolicy !== 'required') continue;
    for (const target of dept.handoffs || []) {
      if (!deptById.has(target) || deptById.get(target).active === false) {
        errors.push(`단계 ${st.id}: 필수 전달 부서 ${target}가 없거나 운영 중지 상태입니다.`);
      } else if (![...byId.values()].some((next) => next.dept === target && ancestors(next.id).has(st.id))) {
        errors.push(`단계 ${st.id}: 필수 전달 부서 ${target}의 후속 단계를 dependsOn으로 연결해야 합니다.`);
      }
    }
  }

  // inputs: 앞 단계 id, 앞 단계 output, 또는 이미 있는 파일
  for (const st of byId.values()) {
    if (!Array.isArray(st.inputs)) continue;
    const before = ancestors(st.id);
    for (const input of st.inputs) {
      if (typeof input !== 'string' || !input.trim()) continue;
      if (byId.has(input)) {
        if (!before.has(input)) errors.push(`단계 ${st.id}: 입력 ${input}은 앞 단계가 아닙니다. dependsOn에 넣어 주세요.`);
        continue;
      }
      const abs = resolvePlanInput(input, { root: repo, taskId, fileExists, outputs: [...outputOwners.keys()] });
      const fromStage = [...before].some((d) => typeof byId.get(d)?.output === 'string' && resolvePath(byId.get(d).output) === abs);
      if (fromStage) continue;
      const laterStage = [...byId.values()].find((o) => o.id !== st.id && typeof o.output === 'string' && resolvePath(o.output) === abs);
      if (laterStage) errors.push(`단계 ${st.id}: 입력 ${input}은 단계 ${laterStage.id}의 산출물입니다. dependsOn에 ${laterStage.id}를 넣어 주세요.`);
      else if (!inside(repo, abs)) errors.push(`단계 ${st.id}: 입력 ${input}은 레포 밖 경로입니다.`);
      else if (!fileExists(abs)) errors.push(`단계 ${st.id}: 입력 ${input}이 앞 단계 산출물도 아니고 존재하는 파일도 아닙니다. 확인 경로: ${[...new Set([abs, resolve(repo, input)])].join(', ')}. 작업 공간과 업무 폴더의 실제 경로를 확인해 계획을 수정하세요.`);
    }
  }

  if (plan.deliverables !== undefined) {
    if (!Array.isArray(plan.deliverables) || plan.deliverables.length > MAX_STAGES || plan.deliverables.some((ref) => typeof ref !== 'string'
      || !byId.has(ref) && ![...byId.values()].some((s) => typeof s.output === 'string' && resolvePath(s.output) === resolvePath(ref)))) errors.push('deliverables는 최종 전달할 단계 id 또는 해당 산출물 경로 배열이어야 합니다.');
  }
  // review·gaps 형식
  if (plan.publications !== undefined) {
    if (!Array.isArray(plan.publications) || plan.publications.length > 50) errors.push('publications는 외부 작업 50개 이하의 배열이어야 합니다.');
    else for (const item of plan.publications) {
      if (!item || !['mail', 'post', 'comment'].includes(item.action) || !['naverworks_mail', 'naver_blog', 'naver_cafe', 'daum_cafe', 'tistory', 'brunch'].includes(item.service)) { errors.push('외부 작업 종류·서비스가 올바르지 않습니다.'); continue; }
      const agent = agentById.get(item.agent), dept = deptById.get(agent?.department);
      if (!agent || agent.active === false || !dept || dept.active === false || dept.engine === 'codex' && codexRole(dept) === 'review') errors.push('외부 작업은 근무중 실행 직원에게 배정해야 합니다.');
      if (typeof item.target !== 'string' || !/^https:\/\//.test(item.target) || typeof item.connection !== 'string' || typeof item.subject !== 'string' || !Array.isArray(item.recipients) || item.recipients.some((r) => typeof r !== 'string')) errors.push('외부 작업의 대상 주소·계정·제목·수신자 형식이 올바르지 않습니다.');
      if (typeof item.content !== 'string' || !byId.has(item.content) && ![...byId.values()].some((s) => typeof s.output === 'string' && resolvePath(s.output) === resolvePath(item.content))) errors.push('외부 작업 본문은 계획에서 검토하는 단계 산출물이어야 합니다.');
    }
  }
  if (plan.review !== undefined) {
    const by = plan.review?.by;
    if (!plan.review || typeof plan.review !== 'object' || typeof by !== 'string' || !by.trim()) {
      errors.push("review.by(검토자: 'chief'·'codex' 또는 직원 id)가 필요합니다.");
    } else if (by !== 'chief' && by !== 'codex' && !agentById.has(by)) {
      errors.push(`review.by ${by}가 조직에 없습니다. 'chief', 'codex' 또는 직원 id를 쓰세요.`);
    }
  }
  if (plan.gaps !== undefined) {
    if (!Array.isArray(plan.gaps) || !plan.gaps.every((g) => g && typeof g.need === 'string' && g.need.trim())) {
      errors.push('gaps는 {need, suggestion} 배열이어야 합니다.');
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, errors, warnings, plan: compactPlan(plan, { taskId, root: repo }) };
}

// plan.set 이벤트·화면용 요약: 긴 문자열은 자르고 비밀값은 가린다
export function compactPlan(plan, { taskId, root } = {}) {
  const repo = resolve(root || '.');
  const rel = (p) => {
    if (typeof p !== 'string') return undefined;
    const norm = normalize(p.replace(/\\/g, '/'));
    const abs = isAbsolute(norm) ? norm : (/^outputs[\\/]/.test(norm) ? resolve(repo, norm) : resolve(repo, 'outputs', ...String(taskId || '').split('/'), norm));
    return redact(toPosix(relative(repo, abs)), 160);
  };
  return {
    task: taskId ?? plan?.task,
    goal: redact(plan?.goal, 160),
    stages: (Array.isArray(plan?.stages) ? plan.stages : []).slice(0, MAX_STAGES).map((s) => ({
      id: String(s.id),
      title: redact(s.title, 80),
      dept: s.dept,
      agent: s.agent,
      output: rel(s.output),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === 'string') : [],
      ...(s.parallelGroup !== undefined ? { parallelGroup: redact(s.parallelGroup, 40) } : {}),
    })),
    review: plan?.review && typeof plan.review === 'object' ? { by: redact(plan.review.by, 48), criteria: redact(plan.review.criteria, 160) } : undefined,
    gaps: Array.isArray(plan?.gaps) ? plan.gaps.slice(0, 10).map((g) => ({ need: redact(g?.need, 80), suggestion: redact(g?.suggestion, 120) })) : [],
  };
}
