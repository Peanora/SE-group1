import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url);
const context = { projectId: 'project-a', runId: 'run-a', planningStatus: 'confirmed', specRevision: 'spec-1', planRevision: 'plan-1' };
const marker = '<img src=x onerror="window.uiInjected=true"><script>window.uiInjected=true</script>';
function execution(overrides = {}) {
  return {
    id: 'execution-1', status: 'awaiting_acceptance', stage: '独立检查', taskAccepted: false,
    calls: 1, reviewCalls: 1, usage: { inputTokens: null, outputTokens: null },
    budget: { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000 }, error: null,
    actions: { canCancel: true, canRetry: false, canPreview: false, canStopPreview: false, canDownload: false },
    versions: [{ commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), diff: marker,
      selfCheck: { status: 'passed', checks: [{ id: 'self-1', passed: true }] },
      acceptance: { status: 'checking', test: { status: 'passed', checks: [{ id: 'HTTP-1', passed: true }] },
        browser: { status: 'failed', checks: [{ id: 'BROWSER-1', passed: false, message: marker, expected: 'HTTP 200', actual: 'HTTP 503 ' + marker }] },
        review: { status: 'completed', summary: marker },
        issues: [{ id: 'ISSUE-1', status: 'resolved', title: marker, checkedCommit: 'a'.repeat(40) }], openIssues: [] } }],
    diff: marker, events: [{ sequence: 1, time: '2026-11-14T00:00:00.000Z', message: marker }], ...overrides,
  };
}
function fixture(overrides = {}) {
  return { capabilities: { canStart: true,
    profiles: [{ id: 'library-web-v1', title: '固定图书借阅示例', description: '只生成固定图书借阅Web示例；含HTTP、SQLite与浏览器检查。', contractRevision: 'contract-1' },
      { id: 'library-web-v2', title: '另一固定范围', description: '仅用于UI选择保留测试。', contractRevision: 'contract-2' }],
    model: { name: '已配置测试模型' }, budget: { maxCalls: 3, maxReviewCalls: 3, maxDurationMs: 600000 } },
  executions: [execution()], ...overrides };
}
const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><style>main{max-width:1100px;margin:28px auto;padding:0 16px}h1{font-size:24px}</style></head><body><main><h1>Taskflow 需求编排台</h1><div id="panel"></div></main><script type="module">
import {createExecutionPanel} from '/execution-panel.js';
window.context=${JSON.stringify(context)};window.errors=[];
const api=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'Content-Type':'application/json'}});const data=await r.json();if(!r.ok){const e=new Error(data.error||'请求失败');e.status=r.status;throw e;}return data;};
window.panel=createExecutionPanel({api,getContext:()=>window.context,onError:e=>window.errors.push(e.message)});
await window.panel.mount(document.querySelector('#panel'));window.panelReady=true;
</script></body></html>`;

test('execution panel uses backend facts in real Edge with a fixed platform-UI API fixture', { timeout: 120000 }, async t => {
  let state = fixture(), requests = [], getStatus = 200, postStatus = 200, postExecution = null, previewResponse = null, delayNextGet = null;
  const module = await readFile(new URL('public/execution-panel.js', root));
  const styles = await readFile(new URL('public/styles.css', root));
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(harness); return; }
      if (req.url === '/execution-panel.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(module); return; }
      if (req.url === '/styles.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(styles); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
      if (req.url.endsWith('/download')) { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="verified-source.zip"' }); res.end('fixed UI fixture'); return; }
      if (req.method === 'GET') {
        const snapshot = structuredClone(state), status = getStatus, delay = delayNextGet; delayNextGet = null;
        if (delay) await delay;
        send(status, status === 200 ? snapshot : { error: status === 404 ? '接口未开放' : '暂时无法读取，请重试' }); return;
      }
      if (postStatus !== 200) { send(postStatus, { error: '执行请求失败，请保留当前选择后重试' }); return; }
      const next = postExecution || execution({ status: 'preparing', versions: [], events: [] });
      state.executions = [structuredClone(next), ...state.executions.filter(item => item.id !== next.id)];
      send(200, { execution: next, ...(previewResponse ? { preview: previewResponse } : {}) });
    } catch (error) { send(500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  let currentPage;
  async function pageFor(viewport = { width: 1440, height: 1000 }) {
    if (currentPage) await currentPage.close();
    state = fixture(); requests = []; getStatus = 200; postStatus = 200; postExecution = null; previewResponse = null; delayNextGet = null;
    const page = await browser.newPage({ viewport });
    currentPage = page;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (404|409|500)\b/.test(message.text())) errors.push(message.text()); });
    t.after(async () => { assert.deepEqual(errors, []); await page.close(); });
    await page.goto(address); await page.waitForFunction(() => window.panelReady);
    return page;
  }
  const refresh = page => page.evaluate(() => window.panel.refresh());
  const start = page => page.getByRole('button', { name: '使用配置模型开始执行', exact: true });
  const consent = page => page.getByRole('checkbox');
  const download = page => page.getByRole('link', { name: '下载已验收源码' });
  async function pendingPostPage() {
    const page = await pageFor();
    await page.evaluate(async ({ initialContext, runA, runB }) => {
      window.panel.destroy();
      const { createExecutionPanel } = await import('/execution-panel.js');
      window.context = initialContext; window.crossRequests = []; window.crossPosts = [];
      const states = { 'run-a': runA, 'run-b': runB };
      const api = (url, options = {}) => {
        const runId = url.includes('/runs/run-b/') ? 'run-b' : 'run-a', method = options.method || 'GET';
        window.crossRequests.push({ url, method });
        if (method === 'GET') return Promise.resolve(structuredClone(states[runId]));
        return new Promise((resolve, reject) => {
          window.crossPosts.push({ runId, complete(response) {
            states[runId].executions = [response.execution]; resolve(response);
          }, fail() { reject(Object.assign(new Error('旧运行操作失败，不应显示在新运行'), { status: 409 })); } });
        });
      };
      window.panel = createExecutionPanel({ api, getContext: () => window.context, onError: error => window.errors.push(error.message) });
      await window.panel.mount(document.querySelector('#panel'));
    }, { initialContext: context, runA: fixture({ executions: [execution({ id: 'run-a-record' })] }), runB: fixture({ executions: [execution({ id: 'run-b-record' })] }) });
    return page;
  }
  async function assertPendingPostIsolation({ oldResult = 'success', revisit = false }) {
    const page = await pendingPostPage();
    await consent(page).check(); await start(page).click();
    await page.waitForFunction(() => window.crossPosts.length === 1);
    await page.evaluate(async () => { window.context.runId = 'run-b'; await window.panel.refresh(); });
    const selected = page.getByRole('combobox', { name: '执行记录', exact: true });
    assert.equal(await selected.inputValue(), 'run-b-record');
    assert.equal(await page.evaluate(() => window.crossRequests.filter(item => item.method === 'GET' && item.url.includes('/run-b/')).length), 1);
    assert.equal(await consent(page).isChecked(), false);
    if (revisit) {
      await page.evaluate(async () => { window.context.runId = 'run-a'; await window.panel.refresh(); });
      assert.equal(await selected.inputValue(), 'run-a-record');
    }
    const currentRun = revisit ? 'run-a' : 'run-b';
    await consent(page).check(); assert.equal(await start(page).isEnabled(), true); await start(page).click();
    await page.waitForFunction(() => window.crossPosts.length === 2);
    assert.equal(await page.evaluate(() => window.crossPosts[1].runId), currentRun);
    const reads = await page.evaluate(() => window.crossRequests.filter(item => item.method === 'GET').length);
    await page.evaluate(async ({ oldResult, oldExecution }) => {
      if (oldResult === 'success') window.crossPosts[0].complete({ execution: oldExecution, preview: { url: 'http://localhost:1234/old', expiresAt: '2099-01-01T00:00:00Z' } });
      else window.crossPosts[0].fail();
      // Drain the resolved/rejected POST and the component's finally before
      // observing whether it incorrectly unlocked the newer pending action.
      await new Promise(resolve => setTimeout(resolve, 0));
    }, { oldResult, oldExecution: execution({ id: 'stale-action-result', taskAccepted: true, actions: { canDownload: true } }) });
    assert.equal(await start(page).isDisabled(), true);
    assert.equal(await consent(page).isDisabled(), true);
    assert.equal(await selected.inputValue(), `${currentRun}-record`);
    assert.equal(await page.getByRole('alert').isVisible(), false); assert.deepEqual(await page.evaluate(() => window.errors), []);
    assert.equal(await page.getByRole('link', { name: '打开本地预览', exact: true }).count(), 0); assert.equal(await download(page).count(), 0);
    await refresh(page); await start(page).dispatchEvent('click');
    assert.equal(await page.evaluate(() => window.crossPosts.length), 2);
    assert.equal(await page.evaluate(() => window.crossRequests.filter(item => item.method === 'GET').length), reads);
    await page.evaluate(response => window.crossPosts[1].complete(response), { execution: execution({ id: 'current-action-result', status: 'preparing' }) });
    await page.waitForFunction(() => document.querySelector('select[aria-label="执行记录"]').value === 'current-action-result');
    assert.equal(await start(page).isEnabled(), true); assert.equal(await selected.isEnabled(), true);
    assert.equal(await selected.locator('option', { hasText: 'stale-action-result' }).count(), 0);
  }

  await t.test('404 clearly keeps planning documents distinct from code execution', async () => {
    const page = await pageFor(); getStatus = 404; await refresh(page);
    assert.match(await page.locator('.ep-notice').first().textContent(), /当前版本尚未开放网页执行/);
    assert.equal(await start(page).isDisabled(), true);
    assert.equal(await download(page).count(), 0);
    assert.match(await page.locator('.ep-empty, .ep-body').textContent(), /文档|规划/);
  });

  await t.test('start requires current confirmations, exact profile revision, backend capability and explicit model consent', async () => {
    const page = await pageFor(); assert.equal(await start(page).isDisabled(), true);
    await consent(page).check(); assert.equal(await start(page).isEnabled(), true);
    await page.evaluate(() => { window.context.planningStatus = 'succeeded'; }); await refresh(page);
    await consent(page).check(); assert.equal(await start(page).isDisabled(), true);
    await page.evaluate(() => { window.context.planningStatus = 'confirmed'; window.context.planRevision = ''; }); await refresh(page);
    await consent(page).check(); assert.equal(await start(page).isDisabled(), true);
    await page.evaluate(() => { window.context.planRevision = 'plan-1'; });
    state.capabilities.canStart = false; state.capabilities.reason = '此需求不属于首版固定范围'; await refresh(page); await consent(page).check();
    assert.equal(await start(page).isDisabled(), true); assert.match(await page.locator('.ep-notice').first().textContent(), /不属于首版/);
    state.capabilities.canStart = true; await refresh(page); await consent(page).check();
    await start(page).click(); await page.waitForFunction(() => document.querySelector('.ep-body').textContent.includes('准备工作区'));
    assert.deepEqual(requests.find(item => item.url.endsWith('/start')).body, { profileId: 'library-web-v1', contractRevision: 'contract-1' });
    assert.match(await page.locator('.ep-result').textContent(), /尚未通过/);
    assert.match(await page.locator('.ep-scope').textContent(), /正常用量/);
    assert.match(await page.locator('.ep-scope').textContent(), /600 秒/);
  });

  await t.test('failed action and transient refresh preserve profile, consent and keyboard focus', async () => {
    const page = await pageFor(); const select = page.getByRole('combobox', { name: '执行范围', exact: true });
    await select.selectOption('library-web-v2'); await consent(page).check(); postStatus = 409;
    await start(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
    assert.equal(await select.inputValue(), 'library-web-v2'); assert.equal(await consent(page).isChecked(), true);
    await select.focus(); getStatus = 500; await refresh(page);
    assert.equal(await select.inputValue(), 'library-web-v2'); assert.equal(await consent(page).isChecked(), true);
    assert.equal(await start(page).isDisabled(), true);
    getStatus = 200; await refresh(page); await select.focus(); await refresh(page);
    assert.equal(await select.evaluate(element => document.activeElement === element), true);
    assert.equal(await start(page).isEnabled(), true);
    assert.equal(await page.getByRole('alert').isVisible(), false);
  });

  await t.test('polling preserves record selection, open evidence and summary focus', async () => {
    const page = await pageFor(); state.executions.push(execution({ id: 'execution-2', status: 'failed' })); await refresh(page);
    const select = page.getByRole('combobox', { name: '执行记录', exact: true }); await select.selectOption('execution-2');
    const summary = page.locator('summary').filter({ hasText: '独立HTTP与SQLite检查' }); await summary.click(); await summary.focus();
    state.executions[1].events.push({ sequence: 2, message: '追加的真实事件', time: '2026-11-14T00:01:00Z' });
    state.executions[1].versions[0].acceptance.test.status = 'failed'; await refresh(page);
    assert.equal(await select.inputValue(), 'execution-2');
    assert.equal(await summary.evaluate(element => document.activeElement === element && element.parentElement.open), true);
    assert.match(await page.locator('.ep-event-list').textContent(), /追加的真实事件/);
    assert.match(await summary.locator('..').textContent(), /failed/);
    state.executions[1].events.push({ sequence: 3, message: '定时轮询读取的事件' });
    await page.waitForFunction(() => document.querySelector('.ep-event-list').textContent.includes('定时轮询读取的事件'));
    assert.equal(await summary.evaluate(element => document.activeElement === element && element.parentElement.open), true);
  });

  await t.test('code, model output, review history and logs remain inert text; null usage is unknown', async () => {
    const page = await pageFor(); state.capabilities.profiles[0].description = marker; state.capabilities.model.name = marker; await refresh(page);
    assert.equal(await page.locator('.execution-panel img, .execution-panel script').count(), 0);
    assert.equal(await page.evaluate(() => window.uiInjected === true), false);
    assert.match(await page.locator('.ep-event-list').textContent(), /<img src=x/);
    assert.match(await page.locator('.ep-facts').textContent(), /输入用量：未知 token；输出用量：未知 token/);
    assert.match(await page.locator('.ep-body').textContent(), /HTTP-1/);
    assert.match(await page.locator('.ep-body').textContent(), /BROWSER-1/);
    const finding = await page.locator('p.ep-muted').filter({ hasText: 'BROWSER-1' }).textContent();
    assert.match(finding, /预期：HTTP 200/u); assert.match(finding, /实际：HTTP 503/u);
    assert.match(await page.locator('.ep-body').textContent(), /ISSUE-1/);
    assert.match(await page.locator('.ep-body').textContent(), /resolved/);
    state.executions[0].usage = { inputTokens: 0, outputTokens: 12 }; await refresh(page);
    assert.match(await page.locator('.ep-facts').textContent(), /输入用量：0 token；输出用量：12 token/);
  });

  await t.test('cancel request, reconciliation and confirmed stop stay distinct', async () => {
    const page = await pageFor(); postExecution = execution({ status: 'cancel_requested', actions: {} });
    await page.getByRole('button', { name: '请求停止', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ep-body').textContent.includes('已请求停止，等待确认'));
    assert.doesNotMatch(await page.locator('.ep-result').textContent(), /已通过验收/);
    state.executions[0] = execution({ status: 'reconciliation_required', error: '尚有进程未确认退出', actions: {} }); await refresh(page);
    assert.match(await page.locator('.ep-body').textContent(), /尚未确认停止/);
    state.executions[0] = execution({ status: 'stopped', actions: { canRetry: true } }); await refresh(page);
    assert.match(await page.locator('.ep-body').textContent(), /已确认停止/);
    assert.equal(await page.getByRole('button', { name: '重新执行', exact: true }).isDisabled(), true);
    await consent(page).check();
    assert.equal(await page.getByRole('button', { name: '重新执行', exact: true }).isEnabled(), true);
    assert.deepEqual(requests.find(item => item.method === 'POST').body, { action: 'cancel' });
  });

  await t.test('source download requires both backend permission and explicit task acceptance', async () => {
    const page = await pageFor(); state.executions[0] = execution({ status: 'accepted', taskAccepted: false, actions: { canDownload: true } }); await refresh(page);
    assert.equal(await download(page).count(), 0);
    state.executions[0].taskAccepted = true; state.executions[0].actions.canDownload = false; await refresh(page);
    assert.equal(await download(page).count(), 0);
    state.executions[0].actions.canDownload = true; await refresh(page);
    assert.equal(await download(page).getAttribute('href'), '/api/projects/project-a/runs/run-a/executions/execution-1/download');
    const downloaded = page.waitForEvent('download'); await download(page).click();
    assert.equal((await downloaded).suggestedFilename(), 'verified-source.zip');
    assert.match(await page.locator('.ep-result').textContent(), /当前固定示例已通过验收/);
  });

  await t.test('preview rejects arbitrary URLs and only exposes bounded local HTTP links', async () => {
    const page = await pageFor(); postExecution = execution({ actions: { canPreview: true, canStopPreview: true } });
    state.executions = [structuredClone(postExecution)]; await refresh(page);
    const previewButton = page.getByRole('button', { name: '启动本地预览', exact: true });
    const previewLink = page.getByRole('link', { name: '打开本地预览', exact: true });
    for (const url of ['https://example.com:1234', 'javascript:alert(1)', 'http://127.0.0.1/', 'http://user:password@localhost:1234/', 'http://localhost.evil:1234/', 'http://127.1:1234/', 'http://2130706433:1234/', 'http://localhost:0/', 'http://localhost:99999/', 'http://localhost:1234\\@evil.com/']) {
      previewResponse = { url, expiresAt: '2099-01-01T00:00:00Z' }; await previewButton.click();
      await page.getByRole('alert').waitFor({ state: 'visible' }); assert.equal(await previewLink.count(), 0, url);
    }
    previewResponse = { url: 'http://127.0.0.1:1234/app', expiresAt: '2000-01-01T00:00:00Z' };
    await previewButton.click(); await page.getByRole('alert').waitFor({ state: 'visible' }); assert.equal(await previewLink.count(), 0);
    for (const url of ['http://127.0.0.1:1234/app', 'http://localhost:1234/app']) {
      previewResponse = { url, expiresAt: '2099-01-01T00:00:00Z' }; await previewButton.click(); await previewLink.waitFor({ state: 'visible' });
      assert.equal(await previewLink.getAttribute('href'), url); assert.equal(await previewLink.getAttribute('target'), '_blank');
      assert.equal(await previewLink.getAttribute('rel'), 'noopener noreferrer');
    }
    state.executions[0].preview = null; await refresh(page); assert.equal(await previewLink.count(), 0);
    previewResponse = { url: 'http://localhost:1234/app', expiresAt: '2099-01-01T00:00:00Z' };
    await previewButton.click(); await previewLink.waitFor({ state: 'visible' });
    previewResponse = null; await page.getByRole('button', { name: '停止预览', exact: true }).click(); await previewLink.waitFor({ state: 'hidden' });
    assert.deepEqual(requests.filter(item => item.method === 'POST').at(-1).body, { action: 'stop_preview' });
  });

  await t.test('unknown budget stays unknown and missing action permissions never enable controls', async () => {
    const page = await pageFor(); await consent(page).check(); state.capabilities.budget = null; state.capabilities.model = null;
    state.executions[0] = execution({ taskAccepted: false, actions: {}, budget: null }); await refresh(page);
    assert.match(await page.locator('.ep-scope').textContent(), /总时长 未知/);
    assert.match(await page.locator('.ep-scope').textContent(), /名称未知/);
    assert.equal(await consent(page).isChecked(), false);
    assert.equal(await page.getByRole('button', { name: '请求停止', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '重新执行', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '启动本地预览', exact: true }).count(), 0);
  });

  await t.test('desktop and 390×844 have usable controls, visible evidence and no horizontal overflow', async () => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await pageFor(viewport); state.executions[0].id = 'execution-' + 'long-id'.repeat(80); await refresh(page);
      await page.locator('summary').filter({ hasText: '独立浏览器检查' }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const box = await start(page).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
      await consent(page).check(); assert.equal(await start(page).isEnabled(), true);
      if (process.env.EXECUTION_PANEL_SCREENSHOTS === '1') {
        await mkdir(new URL('output/playwright/', root), { recursive: true });
        await page.screenshot({ path: fileURLToPath(new URL(`output/playwright/execution-panel-${viewport.width}.png`, root)), fullPage: true });
      }
      await page.close();
    }
  });

  await t.test('late responses cannot overwrite a newly selected planning run', async () => {
    const page = await pageFor(); let release;
    delayNextGet = new Promise(resolve => { release = resolve; });
    const initialCount = requests.length;
    await page.evaluate(() => { window.oldRequest = window.panel.refresh(); });
    while (requests.length === initialCount) await new Promise(resolve => setTimeout(resolve, 5));
    state.executions = [execution({ id: 'new-run-execution' })];
    await page.evaluate(() => { window.context.runId = 'run-b'; }); await refresh(page);
    release(); await page.evaluate(() => window.oldRequest);
    assert.equal(await page.getByRole('combobox', { name: '执行记录', exact: true }).inputValue(), 'new-run-execution');
    assert.match(requests.at(-1).url, /run-b/);
  });

  await t.test('pending POST permits new-run GET and POST; old success, error and finally cannot unlock the new action', async () => {
    for (const oldResult of ['success', 'error']) await assertPendingPostIsolation({ oldResult });
  });

  await t.test('revisiting a run keeps the newer action token even when the old POST has the same context key', async () => {
    for (const oldResult of ['success', 'error']) await assertPendingPostIsolation({ oldResult, revisit: true });
  });

  await t.test('an action supersedes an old read without stopping subsequent polling', async () => {
    const page = await pageFor(); let release;
    delayNextGet = new Promise(resolve => { release = resolve; }); const initialCount = requests.length;
    await page.evaluate(() => { window.oldRequest = window.panel.refresh(); });
    while (requests.length === initialCount) await new Promise(resolve => setTimeout(resolve, 5));
    postExecution = execution({ status: 'cancel_requested', actions: {} });
    await page.getByRole('button', { name: '请求停止', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ep-body').textContent.includes('已请求停止，等待确认'));
    state.executions[0] = execution({ status: 'stopped', actions: {} });
    await page.waitForFunction(() => document.querySelector('.ep-body').textContent.includes('已确认停止'));
    release(); await page.evaluate(() => window.oldRequest);
    assert.match(await page.locator('.ep-body').textContent(), /已确认停止/);
    assert.doesNotMatch(await page.locator('.ep-body').textContent(), /独立测试与审查中/);
  });

  await t.test('destroy removes the view and suppresses late results', async () => {
    const page = await pageFor(); let release;
    delayNextGet = new Promise(resolve => { release = resolve; }); const initialCount = requests.length;
    await page.evaluate(() => { window.oldRequest = window.panel.refresh(); });
    while (requests.length === initialCount) await new Promise(resolve => setTimeout(resolve, 5));
    await page.evaluate(() => window.panel.destroy()); release(); await page.evaluate(() => window.oldRequest);
    assert.equal(await page.locator('.execution-panel').count(), 0);
  });
});
