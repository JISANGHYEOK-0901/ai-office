#!/usr/bin/env node
// 터미널 AI(프로그램 폴더에서 연 Claude·Codex)가 대표 대신 로컬 대시보드 비서실장에게 지시를 넣고, 진행을 보고, 답장한다.
//   node scripts/office-ask.mjs ask '<지시문>'            새 업무 지시(예약·일시정지·재개 문장도 지시창과 같게 처리)
//   node scripts/office-ask.mjs status [실행 id]          최근 업무 목록, 또는 한 업무의 상태와 마지막 답변(질문)
//   node scripts/office-ask.mjs wait <실행 id> [--timeout 초]  끝나거나 답변이 필요해질 때까지 기다린 뒤 status와 같게 출력
//   node scripts/office-ask.mjs reply <실행 id> '<답장>'   답변 필요 질문에 대표 답장 넣기
// 공통 옵션: --workspace <작업 공간 경로>
// 화면의 지시창과 같은 API로 들어가므로 의도 판별·계획·검토·실행 전 확인·메일 20통 제한이 똑같이 적용된다.
// 지시문은 대표가 한 말을 그대로 넣는다. 발송·게시·위임·첨부처럼 권한이 되는 표현은 대표가 직접 말한 것만 넣는다(office-request 스킬).
import { readDashboardAccess, insideOfficeRun } from '../lib/dashboard-access.mjs';
import { resolveWorkspace } from '../lib/paths.mjs';

const USAGE = '사용법: node scripts/office-ask.mjs ask \'<지시문>\' | status [실행 id] | wait <실행 id> [--timeout 초] | reply <실행 id> \'<답장>\' [--workspace <경로>]';
const ACTIVE = new Set(['running', 'queued']);

export function parseArgs(argv) {
  const rest = [], opts = { timeout: 600, workspace: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout') opts.timeout = Number(argv[++i]);
    else if (arg.startsWith('--timeout=')) opts.timeout = Number(arg.slice(10));
    else if (arg === '--workspace') opts.workspace = argv[++i] ?? null;
    else if (arg.startsWith('--workspace=')) opts.workspace = arg.slice(12);
    else rest.push(arg);
  }
  const [command, ...args] = rest;
  return { command, args, ...opts };
}

export function createClient({ url, token, fetchImpl = fetch }) {
  const origin = new URL(url).origin;
  const call = async (method, path, body) => {
    const headers = { 'X-Office-Token': token, Accept: 'application/json' };
    if (method !== 'GET') Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' });
    const res = await fetchImpl(new URL(path, url), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = JSON.parse(text).error || text; } catch { /* 글자 그대로 */ }
      throw new Error(`대시보드가 요청을 거부했습니다(${res.status}): ${message}`);
    }
    return res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  };
  return {
    ask: (prompt) => call('POST', '/api/runs', { prompt }),
    reply: (id, prompt) => call('POST', `/api/runs/${encodeURIComponent(id)}/reply`, { prompt }),
    state: () => call('GET', '/api/state'),
    result: (id) => call('GET', `/api/runs/${encodeURIComponent(id)}/result`),
  };
}

// 대표가 지시한 대화 단위(비서실장 실행)만 보여 준다. 내부 단계 실행(phase)은 숨긴다
const conversations = (state) => (state.runs || []).filter((r) => !r.phase && r.target !== 'review');
const statusText = (r) => r.needsReply ? '답변 필요' : ACTIVE.has(r.status) ? '진행 중' : r.status === 'done' ? '끝남' : r.status;

export async function describe(client, id) {
  const run = conversations(await client.state()).find((r) => r.id === id);
  if (!run) throw new Error(`실행을 찾을 수 없습니다: ${id}. status로 실행 id를 확인하세요.`);
  const lines = [`[${statusText(run)}] ${run.id} · ${run.request || ''}${run.task ? ` · 업무 ${run.task}` : ''}`];
  if (!ACTIVE.has(run.status)) {
    const text = await client.result(id).catch(() => '');
    if (text) lines.push('', run.needsReply ? '비서실장 질문(이 실행 id로 reply 하세요):' : '마지막 답변:', String(text).trim());
  }
  return { run, text: lines.join('\n') };
}

async function main(argv) {
  const { command, args, timeout, workspace } = parseArgs(argv);
  if (!['ask', 'status', 'wait', 'reply'].includes(command)) throw new Error(USAGE);
  // 대시보드가 실행한 AI가 스스로 새 지시를 만들면 대표 원문 근거 원칙이 깨진다
  if (insideOfficeRun()) throw new Error('대시보드 업무 실행 중인 AI는 새 지시나 답장을 넣을 수 없습니다. 필요한 결정은 needs_decision으로 대표에게 물으세요.');
  const root = resolveWorkspace({ workspace }).path;
  const access = readDashboardAccess(root);
  if (!access) throw new Error(`대시보드 서버가 꺼져 있거나 이 작업 공간(${root})의 서버가 아닙니다. 먼저 npm run office:start로 켜 주세요.`);
  const client = createClient(access);
  if (command === 'ask') {
    const prompt = args.join(' ').trim();
    if (!prompt) throw new Error(USAGE);
    const result = await client.ask(prompt);
    if (result.scheduled || result.schedule) return console.log(`예약으로 등록했습니다. 대시보드 '예약'에서 확인하세요.\n${JSON.stringify(result.schedule || result, null, 2)}`);
    if (result.historyCleared) return console.log(`끝난 업무와 실행 내역을 지웠습니다. 최종 산출물·계정과 진행 중인 업무는 그대로 있습니다.${result.keptWaiting ? ` 답변을 기다리는 업무 ${result.keptWaiting}건은 남겼습니다.` : ''}`);
    if (result.pauseRequested || result.resumeRequested) return console.log(`${result.pauseRequested ? '진행 중인 업무를 일시정지했습니다' : '멈춘 업무를 이어서 시작했습니다'}.\n${JSON.stringify(result, null, 2)}`);
    return console.log(`비서실장에게 지시했습니다. 실행 id: ${result.id}\n진행 확인: node scripts/office-ask.mjs wait ${result.id}\n대시보드: ${access.url}`);
  }
  if (command === 'reply') {
    const [id, ...words] = args;
    const prompt = words.join(' ').trim();
    if (!id || !prompt) throw new Error(USAGE);
    const run = await client.reply(id, prompt);
    return console.log(`답장을 넣었습니다. 이어지는 실행 id: ${run.id}\n진행 확인: node scripts/office-ask.mjs wait ${run.id}`);
  }
  if (command === 'status' && !args[0]) {
    const list = conversations(await client.state()).slice(-10).reverse();
    return console.log(list.length ? list.map((r) => `[${statusText(r)}] ${r.id} · ${r.request || ''}`).join('\n') : '실행 기록이 없습니다.');
  }
  const id = args[0];
  if (command === 'wait') {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout은 0보다 큰 초 단위 숫자여야 합니다.');
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const { run, text } = await describe(client, id);
      if (!ACTIVE.has(run.status) || run.needsReply) return console.log(text);
      if (Date.now() > deadline) return console.log(`${text}\n\n아직 진행 중입니다(${timeout}초 대기). 같은 명령으로 다시 기다리거나 대시보드에서 확인하세요.`);
      await new Promise((done) => setTimeout(done, 3000));
    }
  }
  console.log((await describe(client, id)).text);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('office-ask.mjs')) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
