// 실제 HTTP/프로세스 경계를 검증하되 CLI는 가짜이며 유료 AI·발송을 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.mjs';

const FAKE = String.raw`
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('Fixture 1.0');process.exit(0)}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
if(args.includes('login')){console.log('Logged in');process.exit(0)}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const claude=args.includes('--json-schema');
 const schema=claude?args[args.indexOf('--json-schema')+1]:readFileSync(args[args.indexOf('--output-schema')+1],'utf8');
 const kind=JSON.parse(schema).properties;
 const file=join(process.cwd(),'fixture-counts.json');
 const counts=existsSync(file)?JSON.parse(readFileSync(file)):{};
 const count=k=>(counts[k]=(counts[k]||0)+1);
 let result;
 if(kind.plan){
  const n=count('plan'),task=input.match(/업무 id: ([\d-]+\/run-[\w-]+)\./)[1];
  const stage=(id,dept,agent,ext,deps)=>({id,title:id,dept,agent,inputs:deps,output:'outputs/'+task+'/'+dept+'/'+agent+'-'+id+ext,done:'내용과 출처 확인',dependsOn:deps});
  result={question:'',needsMeeting:false,meetingAgents:[],meetingSummary:'',rerunStages:n>1?['b']:[],plan:{version:1,task,goal:'조사 후 HTML 보고서',stages:[stage('a','research','research-1','.txt',[]),stage('b','dev','dev-1','.html',['a'])],review:{by:'chief',criteria:'자료 확인'},gaps:[]}};
 }else if(kind.status){
  const output=[...input.matchAll(/\n출력: ([^\n]+)/g)].at(-1)[1],id=output.endsWith('.txt')?'a':'b',n=count(id);
  if(id==='a'&&n===1)result={status:'needs_decision',question:'대상 지역과 예산을 알려 주세요.'};
  else{
   if(!input.includes('서울, 100만원'))throw new Error('대표 결정 문맥 누락');
   const path=join(process.cwd(),output);mkdirSync(dirname(path),{recursive:true});
   writeFileSync(path,id==='a'?'서울 업체 자료와 근거':'<!doctype html><html lang="ko"><head><title>업체 조사 보고서</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>조사 결과 '+n+'</h1><p>서울 지역 업체의 공개 자료를 기준으로 내용을 정리했습니다. 확인한 사실과 해석을 구분하고 추가 확인이 필요한 항목을 보고합니다.</p></body></html>');
   result={status:'done',summary:'작성 완료'};
  }
 }else{count('review');result={verdict:'pass',stage:'',reason:'내용 확인',report:'# 완료\n\n산출물과 근거를 확인했습니다.\n\n확인 필요: 없음',question:''}}
 writeFileSync(file,JSON.stringify(counts));
 console.log(JSON.stringify(claude?{type:'result',structured_output:result}:{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
});
`;

test('HTTP: 직원 질문 알림 → 결정 답장 → 산출물 → 검토 후 자동 완료 → 읽음 → 내역 정리', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-api-flow-'));
  mkdirSync(join(root, 'org'));
  writeFileSync(join(root, 'org/departments.json'), JSON.stringify([
    { id: 'research', name: '리서치부', engine: 'codex', codexRole: 'exec' },
    { id: 'dev', name: '개발부', engine: 'codex', codexRole: 'exec' },
  ]));
  writeFileSync(join(root, 'org/roster.json'), JSON.stringify([
    { id: 'research-1', name: '김대리', department: 'research' },
    { id: 'dev-1', name: '이대리', department: 'dev' },
  ]));
  const bin = join(root, 'fake.mjs'); writeFileSync(bin, FAKE);
  // 실행기에 env 전달이 빠져도 실제 CLI를 호출하지 않고 즉시 실패하는 전역 대체 경로.
  const previous = process.env.CODEX_BIN; process.env.CODEX_BIN = join(root, 'must-not-run-global.mjs');
  let server;
  t.after(async () => {
    await server?.close();
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  server = await startServer({ root, port: 0, quiet: true, env: { ...process.env, CLAUDE_BIN: bin, CODEX_BIN: bin } });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { 'X-Office-Token': server.token, Origin: base, 'Content-Type': 'application/json' };
  const post = async (path, body, status = 202) => {
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, json.error); return json;
  };
  const state = async () => (await fetch(base + '/api/state')).json();
  const wait = async (predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const current = await state(); if (predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('HTTP 업무 흐름 대기 초과');
  };
  const first = await post('/api/runs', { prompt: '업체 조사와 HTML 보고서 작성' });
  const run = first;
  assert.ok(run?.id);
  const paused = await wait((s) => s.runs.some((r) => r.id === run.id && r.needsReply)
    && s.tasks.some((task) => task.id === run.task && task.status === 'blocked'));
  assert.ok(paused.attention.some((a) => a.kind === 'reply' && a.task === run.task));
  assert.equal(paused.tasks.find((task) => task.id === run.task).status, 'blocked');
  await post(`/api/runs/${run.id}/reply`, { prompt: '서울, 100만원' });
  await wait((s) => s.tasks.some((task) => task.id === run.task && task.status === 'done')
    && !s.runs.some((r) => r.task === run.task && ['running', 'queued'].includes(r.status)));
  const delivered = await state();
  assert.ok(delivered.attention.some((a) => a.kind === 'complete' && a.task === run.task));
  assert.ok(!delivered.attention.some((a) => a.kind === 'approve'));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'fixture-counts.json'))), { plan: 1, a: 2, b: 1, review: 1 });
  await post(`/api/tasks/${encodeURIComponent(run.task)}/seen`, {}, 200);
  const seen = await state();
  assert.equal(seen.tasks.find((task) => task.id === run.task).status, 'done');
  assert.ok(!seen.attention.some((a) => a.task === run.task));

});
