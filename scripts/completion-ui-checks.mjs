import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.mjs';
import { collectFinalOutputs } from '../lib/final-outputs.mjs';

export async function verifyCompletionUi({ browser, directory }) {
  const root = mkdtempSync(join(tmpdir(), 'office-complete-ui-'));
  const checks = [], screenshots = [];
  let server, context;
  const first = '2026-10-30/complete-ui';
  const createOutput = (id, title) => {
    const folder = join(root, 'outputs', id); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'report.md'), `# ${title}\n\n검토를 마친 작업입니다. 핵심 결과와 최종 산출물을 전달합니다.`);
    writeFileSync(join(folder, 'final.html'), '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>완료된 HTML</title></head><body><h1>완료된 HTML</h1><p>최종 전달할 결과입니다.</p><script>window.unsafeReportRan=true</script></body></html>');
    writeFileSync(join(folder, 'intermediate.json'), '{"privateDraft":true}');
    const plan = { stages: [{ id: 'final', output: 'final.html', dependsOn: [] }], deliverables: ['final'] };
    writeFileSync(join(folder, 'plan.json'), JSON.stringify(plan));
    collectFinalOutputs(root, { task: id, title, plan });
  };
  try {
    for (const folder of ['org', '.office/runs', '.office/publications']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'org/departments.json'), JSON.stringify([{ id: 'ops', name: '운영부', engine: 'codex', codexRole: 'exec' }]));
    writeFileSync(join(root, 'org/roster.json'), JSON.stringify([{ id: 'ops-1', name: '김담당', department: 'ops' }]));
    const health = join(root, 'health.mjs');
    writeFileSync(health, "if(process.argv.includes('--version'))console.log('Fixture 1.0');else if(process.argv.includes('auth'))console.log(JSON.stringify({loggedIn:true}));else if(process.argv.includes('login'))console.log('Logged in');else setInterval(()=>{},1000);");
    createOutput(first, '검토를 완료한 업무');
    writeFileSync(join(root, '.office/tasks.json'), JSON.stringify([{ id: first, title: '검토를 완료한 업무 — .office/simulation-inputs/2026-10-30/market.json 원본을 대조한 최종 산출물', status: 'done', completedAt: '2026-10-30T01:00:00Z' }]));
    writeFileSync(join(root, '.office/runs.json'), JSON.stringify([{ id: 'finished-ui', rootId: 'finished-ui', task: first, status: 'done', engine: 'codex' }]));
    writeFileSync(join(root, '.office/runs/finished-ui.log'), '이전 실행 로그');
    writeFileSync(join(root, '.office/publications/sent.json'), '{"status":"confirmed"}');
    server = await startServer({ root, port: 0, quiet: true, env: { ...process.env, CLAUDE_BIN: health, CODEX_BIN: health }, openFolder: () => {} });
    const base = `http://127.0.0.1:${server.port}`;
    const api = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { 'X-Office-Token': server.token, Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await res.json(); assert.ok(res.ok, data.error); return data;
    };
    const waitState = async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) { const state = await api('GET', '/api/state'); if (predicate(state)) return state; await new Promise((resolve) => setTimeout(resolve, 50)); }
      throw new Error('브라우저 검증 상태 대기 초과');
    };
    context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const shot = async (name) => { await page.screenshot({ path: join(directory, name), fullPage: false }); screenshots.push({ path: name, viewport: page.viewportSize() }); };
    await page.goto(base);
    await page.locator('.select-trigger[data-select="chiefModel"]').waitFor();
    for (const width of [1366, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => ({ form: document.querySelector('#chiefForm').getBoundingClientRect().toJSON(), policy: document.querySelector('#chiefPolicy').getBoundingClientRect().toJSON(), input: document.querySelector('#chiefInput').getBoundingClientRect().toJSON(), width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(geometry.policy.y >= geometry.form.bottom, '설명문은 업무 지시 폼 아래에 위치');
      assert.ok(geometry.input.width >= (width > 560 ? 280 : 180), `입력칸 너비 ${width}px: ${geometry.input.width}`);
      assert.ok(geometry.scroll <= width + 1);
      await shot(`command-input-${width}.png`);
    }
    checks.push({ name: '1366·1024·390px 지시 입력 너비·하단 설명·가로 넘침 없음', interaction: 'click', passed: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.locator('[data-act="attn"][data-attn^="complete|"]').first().click();
    const modal = page.locator('#completionDialog');
    await modal.locator('#completionReport').getByText('검토를 마친 작업입니다.', { exact: false }).waitFor();
    assert.equal(await modal.getByRole('button', { name: /^(승인|반려)$/ }).count(), 0);
    assert.equal(await modal.getByText('intermediate.json').count(), 0);
    assert.equal(await modal.getByText('plan.json').count(), 0);
    const popupPromise = page.waitForEvent('popup');
    await modal.getByRole('button', { name: 'final.html 새 탭에서 열기', exact: true }).click();
    const popup = await popupPromise;
    await popup.getByRole('heading', { name: '완료된 HTML', exact: true }).waitFor();
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.equal(await popup.evaluate(() => window.unsafeReportRan), undefined);
    await popup.screenshot({ path: join(directory, 'completed-html-new-tab.png') });
    screenshots.push({ path: 'completed-html-new-tab.png', viewport: popup.viewportSize() });
    await popup.close();
    await shot('completion-modal-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await modal.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth));
    await shot('completion-modal-mobile.png');
    await modal.getByRole('button', { name: '닫기', exact: true }).click();
    await waitState((state) => state.tasks.find((task) => task.id === first)?.resultSeenAt);
    assert.equal((await api('GET', '/api/state')).tasks.find((task) => task.id === first).status, 'done');
    checks.push({ name: '완료 모달은 보고·최종 파일만 표시하고 승인 없이 읽음 처리·HTML 새 탭 렌더', interaction: 'click', passed: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    const next = '2026-10-30/next-completion'; createOutput(next, '새로 완료한 작업');
    const tasks = JSON.parse(readFileSync(join(root, '.office/tasks.json')));
    tasks.push({ id: next, title: '새로 완료한 작업', status: 'done', completedAt: new Date().toISOString() });
    writeFileSync(join(root, '.office/tasks.json'), JSON.stringify(tasks));
    await modal.getByRole('heading', { name: '업무 완료 · 새로 완료한 작업' }).waitFor();
    await modal.locator('#completionReport').getByText('검토를 마친 작업입니다.', { exact: false }).waitFor();
    await modal.getByRole('button', { name: '닫기', exact: true }).click();
    await waitState((state) => state.tasks.find((task) => task.id === next)?.resultSeenAt);
    checks.push({ name: '새 업무의 최종 완료가 도착하면 완료 모달 자동 표시', interaction: 'click', passed: true });
    const active = await api('POST', '/api/runs', { agentId: 'ops-1', prompt: '테스트에서 대기', continuous: false });
    await waitState((state) => state.runs.some((run) => run.id === active.id && run.status === 'running'));
    await page.locator('#clearHistoryBtn').click();
    await page.locator('#confirmOk').click();
    await waitState((state) => !state.runs.some((run) => run.id === 'finished-ui'));
    const remaining = await api('GET', '/api/state');
    assert.ok(remaining.runs.some((run) => run.id === active.id && run.status === 'running'));
    assert.ok(!remaining.tasks.some((task) => [first, next].includes(task.id)));
    assert.ok(!existsSync(join(root, '.office/runs/finished-ui.log')));
    assert.equal(readFileSync(join(root, '.office/publications/sent.json'), 'utf8'), '{"status":"confirmed"}');
    await page.getByRole('tab', { name: '산출물', exact: true }).click();
    await page.locator(`[data-act="out-open"][data-task="${first}"]`).click();
    await page.locator('#outDetail .file-btn').filter({ hasText: 'final.html' }).first().waitFor();
    await shot('history-cleared-outputs-preserved.png');
    await api('POST', `/api/runs/${active.id}/stop`, {});
    checks.push({ name: '내역 초기화 후 진행 중 업무·최종 산출물·발송 증표 보존', interaction: 'click', passed: true });
    assert.deepEqual(errors, []);
    return { checks, screenshots };
  } finally {
    await context?.close(); await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
