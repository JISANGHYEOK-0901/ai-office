#!/usr/bin/env node
// 데모 이벤트 생성기. .office/demo-events.jsonl 에만 쓴다(실제 events.jsonl 은 건드리지 않는다).
// 정본 조직이 비어 있으면 프리셋으로 가상의 데모 조직을 만들어 .office/demo-org.json 에 저장한다.
//
// 사용: node scripts/simulate-events.mjs [--interval 1200] [--org <조직 JSON 경로>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent } from '../lib/events.mjs';
import { loadOrg, loadPresets } from '../lib/org.mjs';
import { kstDate, renameWithRetry, repoRoot } from '../lib/paths.mjs';

const DEMO_FILE = 'demo-events.jsonl';
const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
const GIVEN = ['민준', '서연', '도윤', '하은', '시우', '지우', '주원', '수아', '예준', '지민', '하준', '채원', '유진', '서준', '다은',
  '현우', '소윤', '지호', '윤서', '건우', '예린', '우진', '나연', '태윤', '가은', '정우', '수빈', '은호', '하린', '승민'];
const RANKS = ['사원', '주임', '대리', '과장', '차장'];
const LEAD_RANKS = ['팀장', '부장'];
const CLAUDE_TOOLS = ['Read', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Bash'];
const CODEX_TOOLS = ['Bash', 'Bash', 'Read'];
const TASK_TITLES = ['경쟁사 가격 정책 조사', '3분기 매출 보고서 정리', '신규 캠페인 카피 초안', '계약서 위험 조항 검토',
  '고객 인터뷰 요약', '랜딩 페이지 개선안', '투자 검토 메모', '주간 운영 지표 점검', '채용 공고 작성', '제품 FAQ 갱신'];
const SUMMARIES = {
  Read: ['brief.md 확인', 'report.md 초안 읽기', '참고 자료 검토', 'data/sales.csv 확인'],
  Grep: ['핵심 키워드 검색', '숫자 출처 찾기', '중복 표현 확인'],
  Glob: ['산출물 폴더 목록 확인', '참고 문서 찾기'],
  Write: ['report.md 작성', '요약본 저장', '초안 저장'],
  Edit: ['수치 표 갱신', '문장 다듬기', '결론 보완'],
  WebSearch: ['시장 규모 2026 검색', '경쟁사 최신 소식 검색', '업계 평균 지표 검색'],
  WebFetch: ['보도자료 원문 확인', '공시 자료 읽기'],
  Bash: ['node scripts/office.mjs task status', 'wc -l outputs/report.md', 'ls outputs'],
};
// 프리셋이 없을 때 쓰는 최소 부서 목록
const FALLBACK_DEPTS = [
  { id: 'research', name: '리서치부', en: 'RESEARCH', color: '#38bdf8', engine: 'claude', roles: ['시장조사', '경쟁사 분석', '고객 조사'] },
  { id: 'marketing', name: '마케팅부', en: 'MARKETING', color: '#f472b6', engine: 'claude', roles: ['콘텐츠 기획', '카피라이팅', '성과 분석'] },
  { id: 'business', name: '비즈니스부', en: 'BUSINESS', color: '#a78bfa', engine: 'claude', roles: ['사업 기획', '제휴 검토', '가격 전략'] },
  { id: 'operations', name: '운영부', en: 'OPERATIONS', color: '#34d399', engine: 'claude', roles: ['일정 관리', '프로세스 정리', '지표 점검'] },
  { id: 'finance', name: '재무부', en: 'FINANCE', color: '#fbbf24', engine: 'claude', roles: ['예산 관리', '손익 분석', '비용 점검'] },
  { id: 'legal', name: '법무부', en: 'LEGAL', color: '#f87171', engine: 'claude', roles: ['계약 검토', '규정 확인'] },
  { id: 'verify', name: '검증실', en: 'VERIFY', color: '#22d3ee', engine: 'codex', roles: ['사실 확인', '숫자 감사', '문서 검토'] },
];

// 화면 캡처가 매번 같도록 시드 고정 난수를 쓴다
function makeRandom(seed = 20261029) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

function presetDepartments(root) {
  let list = [];
  try { list = loadPresets(root).departments; } catch { /* 프리셋 오류는 기본 목록으로 대체 */ }
  list = list.filter((d) => d && typeof d.id === 'string' && Array.isArray(d.roles) && d.roles.length);
  if (list.length >= 6) return list;
  return FALLBACK_DEPTS.map((d) => ({
    ...d,
    roles: d.roles.map((name, i) => ({ key: `${d.id}-role-${i + 1}`, name, specialty: name, description: `${name} 업무`, instructions: `${name} 업무를 맡는다.` })),
  }));
}

// 부서 6~8개, 40~50명 규모의 가상 조직
export function buildDemoOrg(root, { seed } = {}) {
  const rnd = makeRandom(seed);
  const presets = presetDepartments(root);
  const verify = presets.find((d) => d.id === 'verify' || d.engine === 'codex');
  const others = presets.filter((d) => d !== verify);
  const deptCount = Math.min(rnd.int(6, 8), presets.length);
  const chosen = others.slice(0, verify ? deptCount - 1 : deptCount);
  if (verify) chosen.push(verify);

  const total = rnd.int(40, 50);
  const departments = [];
  const roster = [];
  const usedNames = new Set();
  const personName = () => {
    for (let i = 0; i < 50; i++) {
      const n = rnd.pick(SURNAMES) + rnd.pick(GIVEN);
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    return rnd.pick(SURNAMES) + rnd.pick(GIVEN);
  };

  chosen.forEach((d, idx) => {
    const { roles, ...fields } = d;
    departments.push({ ...fields, active: true, order: idx + 1 });
    const base = Math.floor(total / chosen.length);
    const size = Math.max(3, base + (idx < total % chosen.length ? 1 : 0));
    const leadRole = roles.find((r) => r.lead);
    for (let n = 0; n < size; n++) {
      const lead = n === 0;
      const role = lead && leadRole ? leadRole : roles[n % roles.length];
      const rank = lead ? rnd.pick(LEAD_RANKS) : rnd.pick(RANKS);
      const name = personName();
      roster.push({
        id: `${d.id}-${n + 1}`,
        name: `${name} ${rank}`,
        department: d.id,
        title: lead ? '팀장' : n < 3 ? '선임' : '담당',
        lead,
        rank,
        specialty: role.specialty || role.name || '',
        description: role.description || '',
        instructions: role.instructions || '',
        thoughts: Array.isArray(role.thoughts) && role.thoughts.length ? role.thoughts : ['오늘 할 일부터 정리하자', '자료 출처를 다시 볼까'],
        active: true,
      });
    }
  });
  return { departments, roster };
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameWithRetry(tmp, file);
}

// 조직 기준으로 이벤트를 계속 만든다. 반환값은 중지 함수(stop.org 에 사용한 조직)
export function startSimulation({ root = repoRoot(), intervalMs = 1200, org, seed } = {}) {
  const officeDir = join(root, '.office');
  mkdirSync(officeDir, { recursive: true });

  let useOrg = org && Array.isArray(org.roster) && org.roster.length ? org : null;
  if (!useOrg) {
    try {
      const real = loadOrg(root);
      if (real.roster.length) useOrg = real;
    } catch { /* 정본 오류면 데모 조직을 쓴다 */ }
  }
  if (!useOrg) {
    useOrg = buildDemoOrg(root, { seed });
    writeJsonAtomic(join(officeDir, 'demo-org.json'), useOrg);
  }

  // 데모 기록은 일회용이므로 시작할 때마다 비운다
  writeFileSync(join(officeDir, DEMO_FILE), '');

  const rnd = makeRandom((seed ?? 7) + 1);
  const engineOf = new Map(useOrg.departments.map((d) => [d.id, d.engine === 'codex' ? 'codex' : 'claude']));
  const members = useOrg.roster.filter((a) => a.active !== false);
  const reviewers = members.filter((a) => engineOf.get(a.department) === 'codex');
  const workers = members.filter((a) => engineOf.get(a.department) !== 'codex');
  const session = `demo-${Date.now().toString(36)}`;
  const working = new Map(); // agentId → { tool, steps }
  const reviewing = new Set();
  const tasks = [];
  let taskSeq = 0;
  const timers = new Set();
  let stopped = false;

  const emit = (ev) => {
    try {
      appendEvent(root, { v: 1, ts: new Date().toISOString(), session, ...ev }, { file: DEMO_FILE });
    } catch { /* 데모 기록 실패는 무시 */ }
  };
  const currentTask = () => tasks.filter((t) => t.status === 'active').at(-1)?.id;

  function newTask() {
    taskSeq += 1;
    const title = TASK_TITLES[(taskSeq - 1) % TASK_TITLES.length];
    const id = `${kstDate()}/demo-${taskSeq}`;
    tasks.push({ id, title, status: 'active' });
    emit({ engine: 'claude', agent: 'chief', instance: session, kind: 'request', summary: `${title} 해줘` });
    emit({ engine: 'claude', agent: 'chief', instance: session, kind: 'task.start', task: id, summary: title, title });
  }

  function startWork(agent) {
    const instance = `${agent.id}-${Date.now().toString(36)}`;
    working.set(agent.id, { instance, steps: rnd.int(3, 8), tool: null });
    emit({ engine: 'claude', agent: 'chief', instance: session, kind: 'tool.start', tool: 'Agent', task: currentTask(),
      summary: `${agent.id}: ${agent.specialty || '업무 처리'}` });
    emit({ engine: 'claude', agent: agent.id, instance, kind: 'agent.start', task: currentTask() });
  }

  function stepWork(agent) {
    const w = working.get(agent.id);
    const task = currentTask();
    if (w.tool) {
      emit({ engine: 'claude', agent: agent.id, instance: w.instance, kind: 'tool.end', tool: w.tool, task, summary: w.summary });
      w.tool = null;
      w.steps -= 1;
      if (w.steps <= 0) {
        working.delete(agent.id);
        emit({ engine: 'claude', agent: agent.id, instance: w.instance, kind: 'agent.stop', task,
          summary: `${agent.specialty || '담당 업무'} 정리 완료` });
        emit({ engine: 'claude', agent: 'chief', instance: session, kind: 'tool.end', tool: 'Agent', task,
          summary: `${agent.id}: 완료` });
      }
      return;
    }
    w.tool = rnd.pick(CLAUDE_TOOLS);
    w.summary = rnd.pick(SUMMARIES[w.tool]);
    emit({ engine: 'claude', agent: agent.id, instance: w.instance, kind: 'tool.start', tool: w.tool, task, summary: w.summary });
  }

  function startReview() {
    const idle = reviewers.filter((r) => !reviewing.has(r.id));
    const task = currentTask();
    if (!idle.length || !task) return;
    const r = rnd.pick(idle);
    reviewing.add(r.id);
    emit({ engine: 'codex', agent: r.id, instance: r.id, kind: 'review.start', task, summary: `검토 시작: outputs/${task}` });
    let steps = rnd.int(2, 4);
    const tick = () => {
      if (stopped) return;
      if (steps-- > 0) {
        const tool = rnd.pick(CODEX_TOOLS);
        const summary = tool === 'Bash' ? `rg -n "매출" outputs/${task}` : 'report.md 확인';
        emit({ engine: 'codex', agent: r.id, instance: r.id, kind: 'tool.start', tool, task, summary });
        timers.add(setTimeout(() => {
          emit({ engine: 'codex', agent: r.id, instance: r.id, kind: 'tool.end', tool, task, summary });
          tick();
        }, intervalMs));
        return;
      }
      const verdict = rnd.next() < 0.6 ? 'PASS' : rnd.next() < 0.85 ? 'FIX' : 'BLOCK';
      emit({ engine: 'codex', agent: r.id, instance: r.id, kind: 'review.end', task, verdict, summary: `${verdict}: reviews/${r.id}.md` });
      reviewing.delete(r.id);
    };
    tick();
  }

  function finishTask() {
    const active = tasks.filter((t) => t.status === 'active');
    if (active.length < 2) return;
    const t = active[0];
    t.status = rnd.next() < 0.85 ? 'done' : 'blocked';
    emit({ engine: 'claude', agent: 'chief', instance: session, kind: 'task.update', task: t.id, status: t.status, summary: `${t.title}: ${t.status}` });
  }

  function tick() {
    // 전체의 20~35% 정도가 일하도록 유지한다
    const target = Math.max(2, Math.round(workers.length * (0.2 + rnd.next() * 0.15)));
    if (working.size < target && workers.length) {
      const free = workers.filter((a) => !working.has(a.id));
      if (free.length) startWork(rnd.pick(free));
    }
    for (const id of [...working.keys()]) {
      if (rnd.next() < 0.6) stepWork(workers.find((a) => a.id === id));
    }
    const roll = rnd.next();
    if (roll < 0.04) newTask();
    else if (roll < 0.1) startReview();
    else if (roll < 0.12) finishTask();
  }

  emit({ engine: 'claude', agent: 'chief', instance: session, kind: 'session.start', summary: 'demo' });
  newTask();
  newTask();
  for (let i = 0; i < Math.min(4, workers.length); i++) tick();
  const timer = setInterval(tick, intervalMs);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  stop.org = useOrg;
  return stop;
}

function parseCli(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interval') opts.intervalMs = Number(argv[++i]);
    else if (argv[i] === '--org') opts.orgPath = argv[++i];
    else throw new Error(`알 수 없는 인자입니다: ${argv[i]}`);
  }
  if (opts.intervalMs !== undefined && !(opts.intervalMs >= 100)) throw new Error('--interval 은 100 이상의 밀리초여야 합니다.');
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseCli(process.argv.slice(2));
    const org = opts.orgPath ? JSON.parse(readFileSync(resolve(opts.orgPath), 'utf8')) : undefined;
    const root = repoRoot();
    const stop = startSimulation({ root, intervalMs: opts.intervalMs, org });
    console.log(`데모 이벤트 생성 중: ${join(root, '.office', DEMO_FILE)} (직원 ${stop.org.roster.length}명, Ctrl+C 로 종료)`);
    const end = () => { stop(); process.exit(0); };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
  } catch (err) {
    console.error(`오류: ${err.message}`);
    process.exit(1);
  }
}
