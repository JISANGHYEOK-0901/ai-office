// 임시 작업 공간·가짜 CLI로만 예약을 검증한다. 실제 AI와 카페에는 접속하지 않는다.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.mjs';
import { createVideoHistory } from '../lib/video-history.mjs';

export function createScheduleFixture(root) {
  mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(join(root, 'org/departments.json'), JSON.stringify([{ id: 'ops', name: '운영부', engine: 'claude' }]));
  writeFileSync(join(root, 'org/roster.json'), JSON.stringify([{ id: 'writer', name: '김담당', department: 'ops' }]));
  const bin = join(root, 'schedule-fixture.mjs');
  writeFileSync(bin, String.raw`
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('Fixture 1.0');process.exit(0)}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
if(args.includes('login')){console.log('Logged in');process.exit(0)}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const claude=args.includes('--json-schema');
 const schema=JSON.parse(claude?args[args.indexOf('--json-schema')+1]:readFileSync(args[args.indexOf('--output-schema')+1],'utf8')).properties;
 let result;
 if(schema.plan){const task=input.match(/업무 id: ([\d-]+\/run-[\w-]+)\./)[1];result={question:'',needsMeeting:false,meetingAgents:[],meetingSummary:'',rerunStages:[],plan:{version:1,task,goal:'가상 예약 업무',stages:[{id:'draft',title:'가상 정리',dept:'ops',agent:'writer',inputs:[],output:'outputs/'+task+'/ops/writer-note.txt',done:'가상 원본 대조',dependsOn:[]}],review:{by:'chief',criteria:'가상 원본 확인'},gaps:[],publications:[],deliverables:['draft']}}}
 else if(schema.status){const output=input.match(/\n출력: ([^\n]+)/)[1];mkdirSync(dirname(output),{recursive:true});writeFileSync(output,'가상 자료를 대조한 예약 결과입니다. 실제 조사나 게시를 하지 않았습니다.');result={status:'done',summary:'가상 산출물 작성',question:''}}
 else if(schema.verdict)result={verdict:'pass',reason:'가상 원본 대조',report:'# 완료한 작업\n\n가상 예약 결과입니다.',question:'',stage:''};
 else process.exit(1);
 console.log(JSON.stringify(claude?{type:'result',structured_output:result}:{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
});`);
  let stamp = Date.parse('2026-10-30T01:59:00Z');
  return { env: { ...process.env, CLAUDE_BIN: bin, CODEX_BIN: bin }, now: () => stamp,
    set: (value) => { stamp = Date.parse(value); } };
}

export async function verifySchedulesUi({ browser, directory }) {
  const root = mkdtempSync(join(tmpdir(), 'office-schedule-ui-')), auth = mkdtempSync(join(tmpdir(), 'office-schedule-ui-auth-'));
  const fixture = createScheduleFixture(root), checks = [], screenshots = [];
  let server, page;
  try {
    server = await startServer({ root, port: 0, quiet: true, env: fixture.env, scheduleNow: fixture.now, connectionBase: auth });
    const base = server.url.replace(/\/$/, ''), headers = { 'X-Office-Token': server.token, Origin: base, 'Content-Type': 'application/json' };
    page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.setDefaultTimeout(15000);
    await page.goto(base);
    await page.locator('#companyBtn').click();
    await page.waitForFunction(() => !document.querySelector('#companyRules').disabled);
    await page.locator('#companyRules').fill('저장하지 않은 가상 회사 규칙');
    await page.locator('#companySchedulesBtn').click();
    await page.locator('#schedulePrompt').fill('가상 주제의 소식 보고서를 작성해 줘. ' + '긴 제목에서도 예약 시각과 주요 버튼이 보여야 합니다. '.repeat(10));
    await page.locator('#scheduleSave').click();
    await page.locator('.schedule-item').waitFor();
    let items = server.schedules.list(); assert.equal(items[0].time, '11:00');
    const first = items[0].id;
    const row = () => page.locator(`[data-schedule="${first}"]`);
    await row().getByRole('button', { name: '수정', exact: true }).click();
    await page.locator('#scheduleTime').fill('11:30');
    await page.locator('#schedulePrompt').fill('가상 주제의 소식 보고서를 작성해 줘.');
    await page.locator('#scheduleSave').click();
    await page.waitForFunction(() => document.querySelector('.schedule-item')?.textContent.includes('11:30'));
    await row().getByRole('button', { name: '일시중지', exact: true }).click();
    await row().getByRole('button', { name: '다시 켜기', exact: true }).waitFor();
    await page.locator('#schedulesDialog [data-close]').click();
    assert.equal(await page.locator('#companyDialog').evaluate((node) => node.open), true);
    assert.equal(await page.locator('#companyRules').inputValue(), '저장하지 않은 가상 회사 규칙');
    await page.locator('#companyDialog [data-close]').click();
    checks.push({ name: '회사 설정에서 예약 관리·돌아왔을 때 입력 중인 회사 규칙 보존', interaction: 'click', passed: true });
    await page.reload(); await page.locator('#schedulesBtn').click();
    assert.equal(server.schedules.list()[0].enabled, false);
    await row().getByRole('button', { name: '다시 켜기', exact: true }).click();
    await row().getByRole('button', { name: '일시중지', exact: true }).waitFor();
    checks.push({ name: '반복 예약 추가·시각/업무 수정·중지·새로고침·다시 켜기', interaction: 'click', passed: true });
    await page.locator('#schedulesDialog [data-close]').click();
    await page.locator('#chiefInput').fill('매일 오전 11시 45분에 여행 유튜브 숏츠를 카페에 2~3개씩 올려줘. 가상 대상이며 지금은 실행하지 말고 예약만 등록해.');
    await page.locator('#chiefForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#schedulesBtn').textContent.includes('2'));
    items = server.schedules.list(); assert.equal(items.length, 2); assert.equal(items.find((item) => item.id !== first).time, '11:45');
    assert.equal((await (await page.request.get(base + '/api/state')).json()).runs.length, 0);
    checks.push({ name: '상단 자연어 매일 지시는 즉시 AI 실행 없이 예약으로 등록', interaction: 'click', passed: true });
    await page.locator('#schedulesBtn').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#schedulesDialog').evaluate((node) => node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth), true);
    const shot = 'schedules-mobile.png'; await page.screenshot({ path: join(directory, shot) }); screenshots.push({ path: shot, viewport: page.viewportSize() });
    await page.locator('#scheduleSave').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#scheduleSave').evaluate((node) => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= document.querySelector('#schedulesDialog .modal-actions').getBoundingClientRect().top; }), true);
    await page.screenshot({ path: join(directory, 'schedules-mobile-form.png') }); screenshots.push({ path: 'schedules-mobile-form.png', viewport: page.viewportSize() });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.screenshot({ path: join(directory, 'schedules-desktop.png') }); screenshots.push({ path: 'schedules-desktop.png', viewport: page.viewportSize() });
    checks.push({ name: '긴 예약 지시·한국 시각·모바일 주요 조작 배치', interaction: 'click', passed: true });
    fixture.set('2026-10-30T02:30:00Z'); server.schedules.tick();
    await page.waitForFunction((id) => document.querySelector(`[data-schedule="${id}"]`)?.textContent.includes('최근: 종료'), first);
    server.schedules.tick(); assert.equal(server.schedules.list().find((item) => item.id === first).lastRun.status, 'done');
    await row().getByRole('button', { name: '최근 결과', exact: true }).click();
    await page.locator('#completionDialog').waitFor();
    assert.equal(await page.locator('#completionDialog').getByRole('button', { name: /승인|반려/ }).count(), 0);
    await page.locator('#completionDialog').getByRole('button', { name: '닫기', exact: true }).click();
    const video = createVideoHistory(root); video.claim({ ids: ['AbCdEfGhI_1'], owner: 'fixture', scope: 'fixture' }); video.confirm({ ids: ['AbCdEfGhI_1'], owner: 'fixture', resultUrl: base + '/published/1' });
    const historyBefore = readFileSync(join(root, '.office/video-publications.json'), 'utf8');
    const response = await page.request.delete(base + '/api/history', { headers }); assert.equal(response.status(), 200);
    assert.equal(server.schedules.list().length, 2);
    assert.equal(readFileSync(join(root, '.office/video-publications.json'), 'utf8'), historyBefore);
    await page.locator('#schedulesBtn').click();
    await row().getByRole('button', { name: '삭제', exact: true }).click();
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => document.querySelectorAll('.schedule-item').length === 1);
    assert.equal(readFileSync(join(root, '.office/video-publications.json'), 'utf8'), historyBefore);
    checks.push({ name: '예약 시각 실제 가짜 CLI 완료·결과 모달·내역 초기화/예약 삭제 후 영상 이력 보존', interaction: 'click', passed: true });
    return { checks, screenshots };
  } catch (error) {
    writeFileSync(join(directory, 'schedules-failure.json'), JSON.stringify({ error: error.message, schedules: server?.schedules.list(), runs: (() => { try { return JSON.parse(readFileSync(join(root, '.office/runs.json'))); } catch { return []; } })() }, null, 2));
    await page?.screenshot({ path: join(directory, 'schedules-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await page?.close(); await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(auth, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
