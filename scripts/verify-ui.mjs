#!/usr/bin/env node
// 실제 회사 데이터·AI 실행을 사용하지 않는 브라우저 회귀 검사. 훅은 종료 코드·보고서·이미지·소스 해시를 확인한다.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../dashboard/server.mjs';
import { verifyBrowserWork } from './browser-fixture-checks.mjs';
import { verifyLogin } from './login-fixture-checks.mjs';
import { verifyCompletionUi } from './completion-ui-checks.mjs';
import { verifySchedulesUi } from './schedule-fixture-checks.mjs';

const index = process.argv.indexOf('--report');
const reportPath = resolve(index >= 0 ? process.argv[index + 1] : 'ai-input/ui-validation/latest/report.json');
mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(tmpdir(), 'office-browser-'));
const connectionBase = mkdtempSync(join(tmpdir(), 'office-ui-auth-'));
mkdirSync(join(root, 'org'));
// 네이버 카페 공식 API 앱 키(가짜 값): 네이버 계정 카드에 "카페 공식 API 연결" 버튼이 보여야 한다
mkdirSync(join(root, '보관함'), { recursive: true });
writeFileSync(join(root, '보관함/계정.env'), 'NAVER_API_CLIENT=fixture-client\nNAVER_API_SECRET=fixture-secret\nNAVER_API_CALLBACK=http://localhost:4777/oauth/naver/callback\n', { mode: 0o600 });
writeFileSync(join(root, 'org/departments.json'), JSON.stringify([
  { id: 'research', name: '리서치부', engine: 'claude', capabilities: ['자료조사'], color: '#38bdf8' },
  { id: 'dev', name: '개발부', engine: 'codex', codexRole: 'exec', capabilities: ['HTML'], color: '#34d399' },
]));
writeFileSync(join(root, 'org/roster.json'), JSON.stringify([
  { id: 'research-1', name: '김팀장', department: 'research', rank: '팀장', lead: true },
  { id: 'dev-1', name: '이대리', department: 'dev', rank: '대리' },
]));
const health = join(root, 'health.mjs');
writeFileSync(health, `if(process.argv.includes('--version'))console.log('UI fixture 1.0');
else if(process.argv.includes('auth'))console.log(JSON.stringify({loggedIn:true}));
else if(process.argv.includes('login'))console.log('Logged in');
else if(process.argv.includes('--output-schema') || process.argv.includes('--json-schema')){
let input=''; process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
const schema=process.argv.includes('--json-schema')?JSON.parse(process.argv[process.argv.indexOf('--json-schema')+1]):null;
const s=schema?(schema.properties?.agent?'watch-plan.json':schema.properties?.cursor?'watch.json':'unknown'):process.argv[process.argv.indexOf('--output-schema')+1];
const value=s.endsWith('watch-plan.json')?{agent:'dev-1',instructions:'가상 자료 확인',deliveryPrompt:'후속 보고',question:''}
:s.endsWith('watch.json')?{cursor:'ui-fixture',summary:'새 자료 없음',question:'',items:[]}:null;
if(!value)process.exit(1);else console.log(JSON.stringify(schema?{type:'result',structured_output:value}:{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}));});
}else process.exit(1);`);
const finalTask = '2026-10-30/ui-final';
mkdirSync(join(root, 'outputs', finalTask, 'dev'), { recursive: true });
mkdirSync(join(root, '.office'), { recursive: true });
writeFileSync(join(root, 'outputs', finalTask, 'report.md'), '# 비서실장 보고\n\n최종 전달 자료를 확인했습니다.');
writeFileSync(join(root, 'outputs', finalTask, 'dev', 'dev-1-result.html'), '<!doctype html><html lang="ko"><head><title>가상 최종 보고</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>가상 최종 보고</h1><p>대표에게 전달할 결과입니다.</p></body></html>');
writeFileSync(join(root, 'outputs', finalTask, 'plan.json'), JSON.stringify({ stages: [{ id: 'html', output: `outputs/${finalTask}/dev/dev-1-result.html`, dependsOn: [] }] }));
writeFileSync(join(root, '.office', 'tasks.json'), JSON.stringify([{ id: finalTask, title: '최종 보고 정리', status: 'done', completedAt: '2026-10-30T01:00:00Z' }]));
const env = { ...process.env, CLAUDE_BIN: health, CODEX_BIN: health };
// env 주입이 누락되는 회귀가 생겨도 실제 계정의 CLI로 빠지지 않게 한다.
const originalBins = { CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN };
process.env.CLAUDE_BIN = join(root, 'unconfigured-claude.mjs');
process.env.CODEX_BIN = join(root, 'unconfigured-codex.mjs');
const report = { framework: 'playwright', passed: false, checks: [], screenshots: [], consoleErrors: [], networkErrors: [] };
let server, browser;
const accountContexts = [];
const accountBrowser = {
  async launchPersistentContext(profile, options) {
    const context = await chromium.launchPersistentContext(join(connectionBase, `fixture-browser-${accountContexts.length}`), { ...options, channel: undefined, headless: true });
    accountContexts.push(context);
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const cookies = await context.cookies(route.request().url());
      const connected = cookies.some((c) => c.name === 'fixture_auth');
      if (!/naver\.com$|worksmobile\.com$/.test(url.hostname)) { await route.fulfill({ status: 204, body: '' }); return; }
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: connected
        ? '<!doctype html><html><body><h1>연결된 가상 계정</h1><p>로그인 상태가 유지됩니다.</p></body></html>'
        : `<!doctype html><html><body><form id="login"><label>아이디<input name="id"></label><label>비밀번호<input type="password" name="password"></label><button type="submit">로그인</button></form><script>document.getElementById('login').onsubmit=e=>{e.preventDefault();const n=location.hostname.includes('naver.com');document.cookie='fixture_auth=1; domain='+(n?'.naver.com':'.worksmobile.com')+'; path=/; SameSite=Lax; Secure';location.href=n?'https://www.naver.com/':'https://mail.worksmobile.com/';}</script></body></html>` });
    });
    const prepare = (page) => {
      const goto = page.goto.bind(page);
      page.goto = async (url, options) => {
        const connected = (await context.cookies(url)).some((cookie) => cookie.name === 'fixture_auth');
        return goto(connected && new URL(url).hostname === 'nid.naver.com' ? 'https://www.naver.com/' : url, options);
      };
    };
    context.pages().forEach(prepare); context.on('page', prepare);
    return context;
  },
};
const check = (name, interaction, fn) => {
  fn(); report.checks.push({ name, interaction, passed: true });
};
try {
  server = await startServer({ root, port: 0, quiet: true, env, connectionBase, browserOptions: { browser: accountBrowser, channel: null } });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => report.consoleErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.location().url?.endsWith('/favicon.ico')) report.consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) report.networkErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('requestfailed', (request) => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.networkErrors.push(new URL(request.url()).pathname); });
  const url = `http://127.0.0.1:${server.port}`;
  const selected = (id) => page.locator(`#${id}`).inputValue();
  const trigger = (id) => page.locator(`.select-trigger[data-select="${id}"]`);
  const popup = () => page.getByRole('listbox').filter({ visible: true });
  const choose = async (id, value) => {
    const position = await page.locator(`#${id}`).evaluate((select, value) => [...select.options].findIndex((o) => o.value === value), value);
    assert.ok(position >= 0, `${id}: ${value} 옵션 없음`);
    await trigger(id).click();
    await popup().locator(`[data-index="${position}"]`).click();
    assert.equal(await selected(id), value);
  };
  const saved = async (predicate) => {
    const deadline = Date.now() + 20000;
    let last;
    while (Date.now() < deadline) {
      const state = await (await page.request.get(url + '/api/state')).json();
      last = state;
      if (predicate(state)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('가상 실행 상태를 확인하지 못했습니다: ' + JSON.stringify(last?.runs?.map((r) => ({ phase: r.phase, status: r.status, monitor: r.monitor, summary: r.summary }))));
  };
  const shot = async (name) => {
    for (const close of await page.getByRole('button', { name: '알림 닫기', exact: true }).all()) await close.click({ timeout: 1000 }).catch(() => {});
    await page.screenshot({ path: join(dirname(reportPath), name), fullPage: false });
    report.screenshots.push({ path: name, viewport: page.viewportSize() });
  };
  const geometry = async (id) => {
    const button = await trigger(id).boundingBox(), menu = await popup().boundingBox();
    const viewport = page.viewportSize();
    check(`${id}: 목록이 선택 상자 근처·화면 안에 표시`, 'click', () => {
      assert.ok(button && menu);
      assert.ok(menu.x >= 0 && menu.x + menu.width <= viewport.width + 1);
      assert.ok(menu.y >= 0 && menu.y + menu.height <= viewport.height + 1);
      assert.ok(Math.min(Math.abs(menu.y - button.y - button.height), Math.abs(button.y - menu.y - menu.height)) <= 8);
    });
  };
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#chiefModel')?.options.length > 3 && document.querySelector('[data-select="chiefModel"]'));
  await trigger('chiefModel').click();
  await geometry('chiefModel'); await shot('desktop-model-open.png'); await page.keyboard.press('Escape');
  await choose('chiefModel', 'gpt-6-astra');
  await saved((s) => s.settings.chief.model === 'gpt-6-astra');
  report.checks.push({ name: 'Codex 모델 선택 저장', interaction: 'click', passed: true });
  await choose('chiefEngine', 'claude');
  await saved((s) => s.settings.chief.engine === 'claude');
  await choose('chiefEffort', 'medium');
  await saved((s) => s.settings.chief.effort === 'medium');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-select="chiefEngine"]')?.textContent === 'Claude');
  assert.equal(await selected('chiefEffort'), 'medium');
  report.checks.push({ name: '제공자·effort 새로고침 후 유지', interaction: 'click', passed: true });
  await trigger('chiefEffort').focus(); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  assert.equal(await selected('chiefEffort'), 'low');
  report.checks.push({ name: '키보드로 펼침·이동·선택', interaction: 'keyboard', passed: true });
  await page.locator('#tabOrg').click();
  await page.locator('[data-act="add-agent"][data-dept="dev"]').first().click();
  const staffModel = page.locator('#agentForm .select-trigger[data-select="codexModel"]');
  await staffModel.click();
  const staffMenu = await popup().boundingBox(), staffButton = await staffModel.boundingBox();
  check('직원 모델 목록은 대화상자 위에 표시', 'click', () => assert.ok(staffMenu.y >= staffButton.y - staffMenu.height - 8));
  await shot('staff-model-open.png');
  const staffIndex = await page.locator('#agentForm select[name="codexModel"]').evaluate((select) => [...select.options].findIndex((o) => o.value === 'gpt-6.1-sol'));
  await popup().locator(`[data-index="${staffIndex}"]`).click();
  assert.equal(await page.locator('#agentForm select[name="codexModel"]').inputValue(), 'gpt-6.1-sol');
  await page.locator('#agentForm .select-trigger[data-select="codexEffort"]').click();
  await popup().getByRole('option', { name: 'high', exact: true }).click();
  await page.locator('#agentForm input[name="name"]').fill('정대리');
  await page.locator('#agentForm input[name="id"]').fill('ui-dev-2');
  await page.locator('#agentSubmit').click();
  await page.waitForFunction(() => !document.querySelector('#agentDialog').open);
  await saved((s) => s.agents['ui-dev-2']?.codexModel === 'gpt-6.1-sol' && s.agents['ui-dev-2']?.codexEffort === 'high');
  await page.locator('[data-act="edit-agent"][data-id="ui-dev-2"]').first().click();
  assert.equal(await page.locator('#agentForm select[name="codexModel"]').inputValue(), 'gpt-6.1-sol');
  assert.equal(await page.locator('#agentForm select[name="codexEffort"]').inputValue(), 'high');
  report.checks.push({ name: '직원 Codex 모델·effort 저장 후 수정 화면 유지', interaction: 'click', passed: true });
  await page.keyboard.press('Escape');
  // 직원 엔진: 브라우저 업무 직원만 Aside로 바꾸고(모델 칸은 숨김), 다시 부서 설정으로 되돌린다
  await page.locator('[data-act="edit-agent"][data-id="research-1"]').first().click();
  await page.locator('#agentForm .select-trigger[data-select="engine"]').click();
  await popup().getByRole('option', { name: /Aside/ }).click();
  assert.equal(await page.locator('#agentForm select[name="engine"]').inputValue(), 'aside');
  const modelHidden = await page.locator('#agentModelRow').isHidden();
  check('Aside 엔진이면 Claude 모델 칸을 숨김', 'click', () => assert.equal(modelHidden, true));
  await shot('staff-engine-aside.png');
  await page.locator('#agentSubmit').click();
  await page.waitForFunction(() => !document.querySelector('#agentDialog').open);
  await saved((s) => s.agents['research-1']?.engine === 'aside');
  await page.locator('[data-act="edit-agent"][data-id="research-1"]').first().click();
  assert.equal(await page.locator('#agentForm select[name="engine"]').inputValue(), 'aside');
  await page.locator('#agentForm .select-trigger[data-select="engine"]').click();
  await popup().getByRole('option', { name: /부서 설정 따름/ }).click();
  await page.locator('#agentSubmit').click();
  await page.waitForFunction(() => !document.querySelector('#agentDialog').open);
  await saved((s) => !s.agents['research-1']?.engine);
  report.checks.push({ name: '직원 엔진 Aside 저장·되돌리기', interaction: 'click', passed: true });
  await page.locator('#addDeptBtn').click();
  await page.locator('#deptForm .select-trigger[data-select="handoffPolicy"]').click();
  await popup().getByRole('option', { name: /필수/ }).click();
  assert.equal(await page.locator('#deptForm select[name="handoffPolicy"]').inputValue(), 'required');
  report.checks.push({ name: '전달 부서 필수/권장 선택', interaction: 'click', passed: true });
  await page.keyboard.press('Escape');
  for (const theme of ['neon', 'pastel']) {
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    await trigger('chiefModel').click();
    const colors = await popup().evaluate((menu) => {
      const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--panel-2)'; document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor; probe.remove();
      return { background: getComputedStyle(menu).backgroundColor, expected };
    });
    check(`${theme} 테마 목록 색상`, 'click', () => assert.equal(colors.background, colors.expected));
    await shot(`${theme}-select-open.png`); await page.keyboard.press('Escape');
  }
  // 지시 접수 중: 바로 표시하고, 응답 전에 다시 눌러도 한 번만 보낸다
  let chiefPosts = 0, releaseChief;
  const chiefHeld = new Promise((resolve) => { releaseChief = resolve; });
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    chiefPosts++;
    await chiefHeld;
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ pauseRequested: true, paused: [] }) });
  });
  await page.locator('#chiefInput').fill('가상 지시 접수 표시 확인');
  await page.locator('#chiefSubmit').click();
  await page.locator('#chiefSendStatus').filter({ hasText: '전달하고 있습니다' }).waitFor();
  const sendingLabel = await page.locator('#chiefSubmit').textContent();
  const sendingLocked = await page.locator('#chiefSubmit').isDisabled();
  check('지시 접수 중 표시와 버튼 잠금', 'click', () => { assert.equal(sendingLabel, '전달 중…'); assert.equal(sendingLocked, true); });
  await page.locator('#chiefInput').press('Enter');
  await page.locator('#chiefSubmit').click({ force: true }).catch(() => {});
  await shot('chief-sending-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#chiefSendStatus').scrollIntoViewIfNeeded();
  await shot('chief-sending-mobile.png');
  const sendingFits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check('접수 중 모바일 가로 넘침 없음', 'click', () => assert.equal(sendingFits, true));
  await page.setViewportSize({ width: 1440, height: 1000 });
  check('접수 중 다시 눌러도 한 번만 전송', 'click', () => assert.equal(chiefPosts, 1));
  releaseChief();
  await page.waitForFunction(() => document.querySelector('#chiefSubmit').textContent === '지시하기' && !document.querySelector('#chiefSubmit').disabled);
  const sentStatus = await page.locator('#chiefSendStatus').textContent();
  const sentInput = await page.locator('#chiefInput').inputValue();
  check('접수가 끝나면 입력창과 버튼 복구', 'click', () => { assert.equal(sentStatus, ''); assert.equal(sentInput, ''); });
  await page.unroute('**/api/runs');
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger('chiefModel').scrollIntoViewIfNeeded(); await trigger('chiefModel').click();
  await geometry('chiefModel'); await shot('mobile-model-open.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  report.checks.push({ name: '모바일 가로 넘침 없음', interaction: 'click', passed: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#companyBtn').click();
  await page.locator('#finalOutputParent:not(:disabled)').waitFor();
  const destination = join(root, '사용자 지정 저장소');
  await page.locator('#finalOutputParent').fill(destination);
  // 업무 예산: 기본 40회·60분을 보여 주고, 바꾼 값을 저장한다
  assert.deepEqual([await page.locator('#budgetCalls').inputValue(), await page.locator('#budgetMinutes').inputValue()], ['40', '60']);
  await page.locator('#budgetCalls').fill('50');
  await page.locator('#budgetMinutes').fill('90');
  // 글·댓글 간격: 기본 30초를 보여 주고, 바꾼 값을 저장한다
  assert.equal(await page.locator('#postGapSeconds').inputValue(), '30');
  await page.locator('#postGapSeconds').fill('300');
  await page.locator('#companySubmit').click();
  await page.waitForFunction(() => !document.querySelector('#companyDialog').open);
  await page.locator('#companyBtn').click();
  await page.locator('#finalOutputParent:not(:disabled)').waitFor();
  assert.equal(await page.locator('#finalOutputParent').inputValue(), destination);
  assert.equal(await page.locator('#finalOutputPath').textContent(), join(destination, '최종산출물'));
  assert.deepEqual([await page.locator('#budgetCalls').inputValue(), await page.locator('#budgetMinutes').inputValue()], ['50', '90']);
  assert.equal(await page.locator('#postGapSeconds').inputValue(), '300');
  await page.locator('#budgetTitle').scrollIntoViewIfNeeded();
  await shot('final-output-settings.png');
  // 좁은 화면에서도 예산 입력칸이 가로로 넘치지 않는다
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#budgetTitle').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#companyDialog').evaluate((d) => d.scrollWidth <= d.clientWidth), true);
  await shot('company-budget-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  report.checks.push({ name: '회사 설정 업무 예산: 기본값 표시·저장·재열기 유지·모바일 넘침 없음', interaction: 'click', passed: true });
  await page.keyboard.press('Escape');
  await page.locator('#tabOutputs').click();
  await page.locator(`[data-act="out-open"][data-task="${finalTask}"]`).click();
  await page.getByRole('button', { name: '최종산출물 폴더 열기', exact: true }).waitFor();
  const workDetails = page.locator('#outDetail details').filter({ has: page.getByText('중간 작업·계획·대화 보기', { exact: true }) });
  assert.equal(await workDetails.getAttribute('open'), null);
  await page.locator('#outDetail .file-btn').filter({ hasText: 'dev-1-result.html' }).first().click();
  await page.locator('#outPreview iframe').waitFor();
  await page.frameLocator('#outPreview iframe').getByRole('heading', { name: '가상 최종 보고', exact: true }).waitFor();
  await shot('final-outputs-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#outDetail').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot('final-outputs-mobile.png');
  report.checks.push({ name: '저장 상위 폴더 저장·재조회, 최종산출물 우선·중간 자료 접기·HTML 미리보기·모바일', interaction: 'click', passed: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#tabOffice').click();
  const monitor = await page.evaluate(async () => {
    const res = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': document.querySelector('meta[name="office-token"]').content },
      body: JSON.stringify({ prompt: '계속 새 자료를 감시해 줘', continuous: { intervalMs: 60000 } }) });
    if (!res.ok) throw new Error('가상 감시 시작 실패'); return res.json();
  });
  await saved((state) => state.runs.some((r) => r.id === monitor.id && r.monitor?.status === 'waiting'));
  await page.locator('.run-monitor').filter({ hasText: '새 자료 대기' }).waitFor();
  await page.locator('.run-monitor').filter({ hasText: '새 자료 대기' }).scrollIntoViewIfNeeded();
  // 상시 업무 카드에 오늘 사용량(AI 호출 수·토큰)을 보여 준다
  await page.locator('.run-daily').filter({ hasText: /오늘 사용: AI 호출 [1-9]\d*회/ }).first().waitFor();
  await shot('continuous-monitor.png');
  await page.locator(`[data-act="stop-run"][data-run="${monitor.id}"]`).click();
  await saved((state) => state.runs.some((r) => r.id === monitor.id && r.status === 'stopped'));
  report.checks.push({ name: '실제 업무·감시 카드 렌더, 새 자료 대기·오늘 사용량 표시·사용자 중지', interaction: 'click', passed: true });
  await page.locator('#connectionsBtn').click();
  await choose('connectionProvider', 'naverworks');
  await page.locator('#connectionForm input[name="label"]').fill('검증용 웍스 계정');
  // 계정 브라우저는 열릴 때마다 새로 만들어지므로, 동작 뒤 새로 생긴 창을 기다려 쓴다
  const nextLoginWindow = async (count) => {
    for (let i = 0; i < 100 && !(accountContexts.length > count && accountContexts[count].pages().length); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(accountContexts.length > count, '로그인 창이 열린다');
    return accountContexts[count];
  };
  const closed = (context) => new Promise((resolve, reject) => { if (!context.pages().length) { resolve(); return; } const t = setTimeout(() => reject(new Error('로그인 확인 뒤 창이 자동으로 닫히지 않았습니다.')), 20000); context.once('close', () => { clearTimeout(t); resolve(); }); });
  let windows = accountContexts.length;
  await page.locator('#connectionSubmit').click();
  // 첫 로그인은 대표가 직접: 안내가 뜨고, 로그인을 마치면 창이 자동으로 닫히며 목록이 연결됨으로 바뀐다
  const worksContext = await nextLoginWindow(windows);
  await page.locator('[data-connection-action="confirm"]').waitFor();
  const firstLogin = worksContext.pages().at(-1);
  await firstLogin.locator('#ai-office-login-banner').waitFor({ state: 'attached' });
  await firstLogin.locator('input[name="id"]').fill('fixture-user');
  await firstLogin.locator('input[type="password"]').fill('fixture-password');
  await firstLogin.getByRole('button', { name: '로그인', exact: true }).click();
  await closed(worksContext);
  await page.getByText('네이버웍스 메일 · 연결됨', { exact: true }).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[data-connection-action="confirm"]'));
  // 다시 열면 저장된 로그인 상태로 입력 없이 연결되고 창이 자동으로 닫힌다
  windows = accountContexts.length;
  await page.locator('[data-connection-action="open"]').first().click();
  await closed(await nextLoginWindow(windows));
  await page.getByText('네이버웍스 메일 · 연결됨', { exact: true }).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[data-connection-action="confirm"]'), null, { timeout: 20000 });
  report.checks.push({ name: '첫 로그인은 직접(안내·자동 감지·창 자동 닫힘), 새 브라우저 프로세스에서도 로그인 상태 재사용', interaction: 'click', passed: true });
  await choose('connectionProvider', 'naver');
  await page.locator('#connectionForm input[name="label"]').fill('검증용 네이버 계정');
  await page.locator('#connectionRemember').check();
  await page.locator('#connectionUsername').fill('fixture-auto-user');
  await page.locator('#connectionPassword').fill('fixture-auto-password');
  windows = accountContexts.length;
  await page.locator('#connectionSubmit').click();
  // 자동 로그인 정보를 저장해도 첫 로그인은 입력하지 않는다
  const naverContext = await nextLoginWindow(windows);
  await page.locator('[data-connection-action="confirm"]').waitFor();
  const naverLogin = naverContext.pages().at(-1);
  await naverLogin.locator('input[name="id"]').waitFor();
  assert.equal(await naverLogin.locator('input[name="id"]').inputValue(), '');
  await naverLogin.locator('input[name="id"]').fill('fixture-auto-user');
  await naverLogin.locator('input[type="password"]').fill('fixture-auto-password');
  await naverLogin.getByRole('button', { name: '로그인', exact: true }).click();
  await closed(naverContext);
  assert.equal(await page.locator('#connectionPassword').inputValue(), '');
  await page.waitForFunction(() => !document.querySelector('[data-connection-action="confirm"]'), null, { timeout: 20000 });
  await page.getByText(/자동 로그인 저장됨/).waitFor();
  // 카페 공식 API 연결: 누르면 새 창이 네이버 동의 주소(PKCE)로 열린다. 실제 네이버에는 접속하지 않는다
  await page.context().route('https://nid.naver.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>naver</title>' }));
  const apiButton = page.locator('[data-connection-action="naver-api"]');
  assert.equal(await apiButton.count(), 1, '네이버 계정에만 공식 API 연결 버튼이 있다');
  assert.equal((await apiButton.textContent()).trim(), '카페 공식 API 연결');
  const [consent] = await Promise.all([page.context().waitForEvent('page'), apiButton.click()]);
  await consent.waitForURL(/^https:\/\/nid\.naver\.com\/oauth2\/authorize\?/);
  const consentUrl = new URL(consent.url());
  assert.equal(consentUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(consentUrl.searchParams.get('client_id'), 'fixture-client');
  assert.equal(consentUrl.searchParams.has('client_secret'), false);
  await consent.close();
  assert.equal(await page.locator('#connectionError').isHidden(), true);
  report.checks.push({ name: '카페 공식 API 연결 버튼이 네이버 동의 창(PKCE)을 연다', interaction: 'click', passed: true });
  await shot('connections-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#connectionProvider').locator('..').scrollIntoViewIfNeeded();
  await trigger('connectionProvider').click();
  await geometry('connectionProvider'); await shot('connections-mobile-open.png'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#connectionsDialog').evaluate((d) => d.scrollWidth <= d.clientWidth), true);
  report.checks.push({ name: '자동 로그인 암호화 저장·비밀번호 폼 비우기·모바일 연결 화면', interaction: 'click', passed: true });
  await page.locator('#connectionsClose').click();
  report.checks.push(...await verifyBrowserWork());
  report.checks.push(...await verifyLogin());
  const sample = {
    TITLE: '신규 제휴 후보 검토: 1차 확인 결과', SUBTITLE: '확인한 자료와 추가 결정이 필요한 내용을 구분한 보고서 예시입니다.',
    AUTHOR: '개발부 · 비서실장 검토', DATE: '2026-10-30', SCOPE: '가상 후보 3곳 · 공개 자료 범위',
    CONCLUSION: '우선 후보의 적합성과 공개 연락처를 확인하고, 제휴 조건과 발송 문안은 대표 결정 후 확정합니다. 현재 자료만으로 매출 효과를 추정하지 않습니다.',
    FINDINGS_HTML: '<ol><li><h3>후보의 적합성부터 확인</h3><p>공개 사업 소개를 기준으로 대상 업종과 협업 형태를 정리했습니다. 실제 거래 가능 여부는 추가 확인이 필요합니다.</p></li><li><h3>확인한 내용과 해석을 구분</h3><p>공개된 서비스 범위는 사실로, 제휴 적합성은 검토 의견으로 표시합니다. 근거가 없는 성장률은 제시하지 않습니다.</p></li></ol>',
    TABLE_CAPTION: '가상 후보 비교 · 수치 없는 정성 검토 예시',
    TABLE_ROWS_HTML: '<tr><td>후보 A</td><td>대상 업종 서비스 운영</td><td>제휴 형태 확인</td><td><a href="#source-1">자료 1</a></td></tr><tr><td>후보 B</td><td>공개 문의 창구 있음</td><td>접수 범위 확인</td><td><a href="#source-1">자료 1</a></td></tr><tr><td>후보 C</td><td>조건 확인 자료 부족</td><td>추가 조사 후 판단</td><td>확인 필요</td></tr>',
    ACTIONS_HTML: '<ol><li><strong>대상 범위 결정</strong><br>대표: 업종·지역·우선순위 확인</li><li><strong>조건과 자료 보완</strong><br>담당 부서: 근거 원문 확인 후 제안서 정리</li></ol>',
    LIMITATIONS: 'UI 검증용 가상 자료입니다. 외부 조사를 수행하지 않았으며 실제 업체 평가나 자동 발송의 근거로 사용하지 않습니다.',
    SOURCES_HTML: '<li id="source-1">로컬 UI 검증용 예시 자료 · 확인일 2026-10-30</li>',
  };
  const template = readFileSync(new URL('../org/templates/report.html', import.meta.url), 'utf8');
  const html = template.replace(/\{\{REPORT_([A-Z_]+)\}\}/g, (_, key) => { assert.ok(key in sample, key); return sample[key]; });
  await page.goto('about:blank');
  for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size); await page.setContent(html);
    assert.equal(await page.title(), sample.TITLE);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('link', { name: '자료 1', exact: true }).first().click();
    await page.getByRole('heading', { name: '출처와 확인일' }).scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#source-1').isVisible(), true);
    await page.evaluate(() => scrollTo(0, 0));
    await shot(size.width > 700 ? 'report-desktop.png' : 'report-mobile.png');
    report.checks.push({ name: `${size.width}px 보고서 제목·본문·출처 이동·가로 넘침 검사`, interaction: 'click', passed: true });
  }
  assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.networkErrors, []);
  const completion = await verifyCompletionUi({ browser, directory: dirname(reportPath) });
  report.checks.push(...completion.checks); report.screenshots.push(...completion.screenshots);
  const schedules = await verifySchedulesUi({ browser, directory: dirname(reportPath) });
  report.checks.push(...schedules.checks); report.screenshots.push(...schedules.screenshots);
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
} finally {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await browser?.close(); await server?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(connectionBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const [key, value] of Object.entries(originalBins)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: reportPath, error: report.error }));
