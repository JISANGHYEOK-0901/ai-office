// 대표의 "하던 작업 멈추고 정리해 두었다가 다음에 이어서" 지시를 판별하고, 업무별 정리 노트를 만든다.
// 노트는 AI 호출 없이 체크포인트·계획·업무 폴더에서 바로 만든다(노트북을 끄기 직전에도 즉시 끝나야 한다).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { writeFileAtomic } from './org.mjs';
import { redactContext } from './events.mjs';

const STOP = /(멈춰|멈추|멈춤|멈출|중단|중지|일시\s*정지|정지|그만|스톱|pause)/i;
const LATER = /(이어|다음에|나중에|재개|내일|정리|저장|노트북|퇴근|끄|꺼)/;
const SCOPE = /(작업|업무|하던|진행|모든|모두|전부|전체|지금)/;
// 새 산출물을 만들어 달라는 요청은 업무 지시다. "중단된 업무 정리 보고서 작성해 줘" 같은 문장을 일시정지로 오인하지 않는다.
const NEW_WORK = /(보고서|작성|조사해|만들어|분석해|써\s*줘|찾아|보내)/;

export const PAUSE_NOTE = 'pause-note.md';
export const RESUME_PROMPT = '이어서 재개';

export function pauseIntent(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 160) return false;
  if (/^(?:전체\s*|모든\s*작업\s*|작업\s*|업무\s*)?(?:일시\s*정지|pause)(?:\s*해\s*줘|\s*해|\s*해\s*주세요)?[.!\s]*$/i.test(t)) return true;
  return STOP.test(t) && LATER.test(t) && SCOPE.test(t) && !NEW_WORK.test(t);
}

// "계속 시장을 조사해 줘" 같은 새 지시와 구분하려고 재개 문장 전체 형태만 받는다.
const RESUME_SENTENCE = /^(?:(?:하던|멈춘|멈췄던|일시\s*정지한|정지한|중단한|중단된|아까)\s*)?(?:작업|업무|일)?들?(?:을|를|은|도)?\s*(?:다|전부|모두|전체)?\s*(?:이어서|이어|계속|다시)\s*(?:해|하자|진행|시작|재개|가자)?(?:\s*해)?(?:\s*줘|\s*주세요|\s*줄래)?[.!?\s]*$/;
const RESUME_WORD = /^(?:이어서\s*)?(?:재개|resume)(?:\s*해\s*줘|\s*해|\s*해\s*주세요)?[.!\s]*$/i;

export function resumeIntent(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 40) return false;
  return RESUME_SENTENCE.test(t) || RESUME_WORD.test(t);
}

function listFiles(dir, base, limit = 40) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (out.length >= limit) return;
      if (name === PAUSE_NOTE || name.startsWith('.')) continue;
      const path = join(d, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else out.push(relative(base, path).replace(/\\/g, '/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function kst(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' (KST)';
}

// run: 일시정지한 실행, checkpoint: .office/orchestrations/<rootId>.json, monitor: 지속 감시 체크포인트
export function buildPauseNote({ run, title = '', checkpoint = null, monitor = null, taskDir = null, root, pausedAt = new Date().toISOString() }) {
  const lines = [`# 일시정지 정리: ${redactContext(title || run.request || run.task)}`, ''];
  lines.push(`- 일시정지 시각: ${kst(pausedAt)}`);
  lines.push(`- 업무 id: ${run.task}`);
  if (checkpoint?.originalRequest || run.request) lines.push(`- 원래 요청: ${redactContext(checkpoint?.originalRequest || run.request).replace(/\s+/g, ' ').slice(0, 300)}`);
  lines.push('');
  const stages = checkpoint?.plan?.stages || [];
  if (stages.length) {
    const done = stages.filter((s) => checkpoint.completed?.[s.id]);
    const left = stages.filter((s) => !checkpoint.completed?.[s.id]);
    lines.push(`## 진행 상황 (${done.length}/${stages.length} 단계 완료)`, '');
    if (done.length) {
      lines.push('완료한 단계(재개할 때 파일이 바뀌지 않았으면 다시 하지 않습니다):');
      for (const s of done) lines.push(`- [완료] ${s.title || s.id} — ${s.agent} → ${s.output}`);
      lines.push('');
    }
    if (left.length) {
      lines.push('남은 단계(재개하면 여기서부터 진행합니다):');
      for (const s of left) lines.push(`- [남음] ${s.title || s.id} — ${s.agent} → ${s.output}`);
      lines.push('');
    }
    if (left.length === 0) lines.push('모든 단계 산출물이 있습니다. 재개하면 비서실장 검토·전달부터 진행합니다.', '');
  } else if (!monitor) {
    lines.push('## 진행 상황', '', checkpoint ? '아직 작업 계획을 세우기 전에 멈췄습니다. 재개하면 계획부터 다시 세웁니다.' : '직원 직접 지시 실행입니다. 재개하면 같은 대화를 이어서 남은 작업을 마칩니다.', '');
  }
  if (monitor) {
    lines.push('## 지속 감시 상태', '');
    lines.push(`- 조회 ${monitor.cycles || 0}회, 새 자료 ${(monitor.seen || []).length}건, 후속 보고 ${(monitor.batches || []).filter((b) => b.runId).length}건`);
    if (monitor.deadlineAt) lines.push(`- 원래 종료 시각: ${kst(new Date(monitor.deadlineAt).toISOString())} (재개해도 연장되지 않습니다)`);
    lines.push('- 재개하면 마지막 확인 위치부터 이어서 감시하고, 이미 전달한 자료는 다시 보내지 않습니다.', '');
  }
  const pending = (checkpoint?.pending || []).filter((q) => q?.question);
  if (pending.length) {
    lines.push('## 대표 결정 대기', '');
    pending.forEach((q, i) => lines.push(`${i + 1}. ${redactContext(q.question)}`));
    lines.push('');
  }
  const files = taskDir && root ? listFiles(taskDir, root) : [];
  if (files.length) {
    lines.push('## 지금까지 만든 파일', '');
    for (const f of files) lines.push(`- ${f}`);
    lines.push('');
  }
  lines.push('## 다시 시작하는 방법', '');
  lines.push('- 대시보드 지시창에 "이어서 해줘"라고 쓰면 일시정지한 업무를 모두 재개합니다.');
  lines.push('- 이 업무만 재개하려면 업무·실행 목록에서 대화를 열고 "이어서 재개"라고 답하세요.');
  return lines.join('\n') + '\n';
}

export function writePauseNote(args) {
  if (!args.taskDir) return null;
  const file = join(args.taskDir, PAUSE_NOTE);
  writeFileAtomic(file, buildPauseNote(args));
  return relative(args.root, file).replace(/\\/g, '/');
}
