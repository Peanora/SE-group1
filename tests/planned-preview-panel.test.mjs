import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Real Edge renders the production panel; the API is a controlled fixture. This
// suite verifies panel authorization and interactions, not native app startup.
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const ctx = { projectId: 'project-a', runId: 'run-a', specRevision: A, planRevision: B, planningStatus: 'confirmed' };
const marker = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const panelURL = new URL('../public/planned-execution.js', import.meta.url), panelBytes = await readFile(panelURL), panelHash = digest(panelBytes);
const definition = { id: 'proposal-1', projectId: ctx.projectId, runId: ctx.runId, current: true, approved: true, status: 'approved', revision: A, manifestHash: B, coverage: 'structural_only', executed: false,
  binding: { ...ctx, sourceRevision: C, sourceGeneration: 1 }, approval: { phase: 'definition_only' }, proposal: { name: '联合验收定义', browser: { version: 1, sessions: ['user'], steps: [{ id: 'visible' }] } } };
function preview(extra = {}) { return { id: 'preview-1', executionId: 'execution-1', state: 'running', active: true, startedAt: '2026-11-18T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', url: 'http://127.0.0.1:4317/', error: null, actions: { canStop: true }, ...extra }; }
function execution(extra = {}) { return { id: 'execution-1', projectId: ctx.projectId, runId: ctx.runId, proposalId: definition.id, revision: A, kind: 'planned_web', status: 'accepted', current: true, active: false, accepted: true,
  binding: { ...ctx, sourceRevision: C, sourceGeneration: 1 }, candidateCommit: 'e'.repeat(40), baseCommit: 'f'.repeat(40), totalModelCalls: 8, usage: { inputTokens: 210, outputTokens: 90 }, events: [], modelCalls: [], preview: null, commands: [],
  actions: { canPreview: true, canStopPreview: false, canDownload: true }, ...extra }; }
function fixture() { return { dev: { capabilities: { canStart: true, contractRevision: D, model: { name: 'fixture-only' }, budget: { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000, maxAttempts: 3, totalModelCalls: 0, remainingModelCalls: 18, remainingAttempts: 3 } }, executions: [execution()] }, definitions: { coverage: 'structural_only', proposals: [definition] } }; }
const safeJSON = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>body{margin:0;background:#f5f7fb;font:14px sans-serif}main{max-width:1100px;margin:24px auto;padding:0 16px}</style></head><body><main><div id="panel"></div></main><script type="module">
import {createPlannedExecutionPanel} from '/planned-execution.js';
window.ctx=${safeJSON(ctx)};window.initial=${safeJSON(fixture())};window.states={a:structuredClone(window.initial),b:structuredClone(window.initial)};
for(const state of [window.states.b])for(const row of [...state.dev.executions,...state.definitions.proposals]){row.projectId='project-b';row.runId='run-b';row.binding.projectId='project-b';row.binding.runId='run-b';}
window.requests=[];window.errors=[];window.pending=[];window.holds={};window.mode={};window.serial=0;
window.release=async(index,extra={})=>{const p=window.pending[index];if(extra.error)p.reject(new Error(extra.error));else p.resolve(extra.response??await p.execute());};
const api=(url,options={})=>{
 const method=options.method||'GET',key=url.includes('/project-b/')?'b':'a',state=window.states[key],type=method==='POST'?'post':url.endsWith('/verification-plans')?'definitions':'dev';
 const snapshot=structuredClone(state[type==='definitions'?'definitions':'dev']);window.requests.push({url,method,body:options.body?JSON.parse(options.body):null});
 const execute=async()=>{
  if(method==='GET'){if(window.mode.getError)throw new Error('预览读取失败');return snapshot;}
  if(window.mode.postError)throw new Error('预览请求未确认');
  const selected=state.dev.executions.find(row=>row.id===url.split('/').at(-2));
  const value=window.nextPost?structuredClone(window.nextPost):{execution:structuredClone(selected),preview:{id:'preview-'+(++window.serial),executionId:selected.id,state:'running',active:true,startedAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',url:location.origin+'/',error:null,actions:{canStop:true}}};
  if(url.endsWith('/stop-preview')&&!window.nextPost)value.preview={...structuredClone(selected.preview),state:'stopped',active:false,url:null,actions:{canStop:false}};
  if(!window.mode.noPublish){const record=structuredClone(value.execution);record.preview=structuredClone(value.preview);record.actions={...record.actions,canPreview:value.preview.state==='stopped',canStopPreview:value.preview.active,canDownload:!value.preview.active};state.dev.executions=state.dev.executions.map(row=>row.id===record.id?record:row);}
  return value;
 };
 if(window.holds[type]){window.holds[type]=false;return new Promise((resolve,reject)=>window.pending.push({type,url,execute,resolve,reject}));}return execute();
};
window.panel=createPlannedExecutionPanel({api,getContext:()=>window.ctx,onError:error=>window.errors.push(error.message)});await window.panel.mount(document.querySelector('#panel'));window.ready=true;
</script></body></html>`;
let browser, server, origin, evidence;
before(async () => {
  assert.equal(digest(await readFile(panelURL)), panelHash); const base = path.resolve('output/planned-preview-panel-author'); await mkdir(base, { recursive: true }); evidence = await mkdtemp(path.join(base, 'run-'));
  server = http.createServer((request, response) => { const js = request.url === '/planned-execution.js'; response.writeHead(200, { 'content-type': js ? 'text/javascript' : 'text/html; charset=utf-8' }); response.end(js ? panelBytes : html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => {
  const afterHash = digest(await readFile(panelURL));
  if (evidence) await writeFile(path.join(evidence, 'evidence.json'), JSON.stringify({ node: process.version, browser: browser?.version(), panelHash, afterHash, zeroDrift: panelHash === afterHash, api: 'controlled fixtures; no model calls; no native preview process', viewports: [1440, 390] }, null, 2));
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); assert.equal(afterHash, panelHash);
});
async function pageFor(t, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); }); await page.goto(origin); await page.waitForFunction(() => window.ready); return page;
}
const refresh = page => page.evaluate(() => window.panel.refresh());
const start = page => page.getByRole('button', { name: '启动已验收软件预览', exact: true });
const stop = page => page.getByRole('button', { name: '停止软件预览', exact: true });
const link = page => page.getByRole('link', { name: '打开软件预览', exact: true });
const download = page => page.getByRole('link', { name: '下载当前已验收源码', exact: true });
const records = page => page.getByLabel('开发执行记录', { exact: true });
const paid = page => page.getByRole('button', { name: '按当前规划开始开发', exact: true });
async function setRow(page, row) { await page.evaluate(row => { window.states.a.dev.executions = [row]; }, row); await refresh(page); }
const running = extra => execution({ preview: preview(), actions: { canPreview: false, canStopPreview: true, canDownload: false }, ...extra });

for (const width of [1440, 390]) test(`preview ${width}px: free action, POST is provisional, fresh GET link and preserved consent`, async t => {
  const page = await pageFor(t, width); assert.equal(await page.getByRole('checkbox').isChecked(), false); assert.equal(await start(page).isEnabled(), true);
  await page.getByRole('checkbox').check(); await page.evaluate(() => { window.mode.noPublish = true; window.holds.dev = true; }); await start(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  assert.equal(await link(page).count(), 0); assert.equal(await download(page).count(), 0); assert.equal(await start(page).isDisabled(), true); assert.equal(await page.getByRole('checkbox').isChecked(), true);
  assert.deepEqual(await page.evaluate(() => window.requests.find(row => row.method === 'POST').body), {});
  await page.evaluate(() => window.release(0)); await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('等待后续读取'));
  assert.equal(await link(page).count(), 0); assert.equal(await start(page).isDisabled(), true);
  await setRow(page, running({ preview: preview({ url: origin + '/' }) })); assert.equal(await link(page).isVisible(), true); assert.equal(await link(page).getAttribute('target'), '_blank'); assert.equal(await link(page).getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.getByRole('checkbox').isChecked(), true); assert.equal(await paid(page).isDisabled(), true);
  const popupPromise = page.waitForEvent('popup'); await link(page).click(); const popup = await popupPromise; await popup.waitForLoadState(); assert.equal(await popup.evaluate(() => window.opener === null), true); await popup.close();
  await page.screenshot({ path: path.join(evidence, `preview-${width}.png`), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await page.evaluate(() => window.requests.filter(row => row.method === 'POST').length), 1);
});

for (const width of [1440, 390]) test(`actual task graph and safe commands ${width}px: real edges, focus and checkbox survive polling`, async t => {
  const page = await pageFor(t, width), tasks = Array.from({ length: 8 }, (_, index) => ({ id: `ACTUAL_${index}`, title: index === 2 ? marker : `实际业务任务 ${index}`, dependsOn: index < 2 ? [] : [`ACTUAL_${index - 2}`], status: index < 2 ? 'completed' : index === 2 ? 'running' : 'pending', stage: index === 2 ? 'validating' : null, checks: { issues: [{ message: marker }] }, history: [{ attemptId: 'old-attempt', totalModelCalls: 2 }] }));
  const command = { id: 'CMD_1', taskId: 'ACTUAL_2', phase: 'self_check', tool: marker, startedAt: '2026-11-18T10:00:00Z', durationMs: 120, exitCode: 0, terminationConfirmed: true, status: 'completed', argv: 'PRIVATE_ARGV', stdout: 'PRIVATE_STDOUT', pid: 'PRIVATE_PID', path: 'PRIVATE_PATH' };
  await setRow(page, execution({ executionMode: 'task_dag', tasks, commands: [command, { id: 'CMD_2', taskId: 'ACTUAL_3', phase: 'test', tool: 'native', durationMs: null, exitCode: null, terminationConfirmed: null, status: 'reconciliation_required' }] }));
  const nodes = page.locator('.pe-task-node'); assert.equal(await nodes.count(), 8); assert.deepEqual(await nodes.evaluateAll(nodes => nodes.map(node => node.dataset.taskId)), tasks.map(task => task.id));
  assert.deepEqual(await page.locator('.pe-graph-canvas path').evaluateAll(paths => paths.map(path => [path.dataset.from, path.dataset.to])), tasks.flatMap(task => task.dependsOn.map(id => [id, task.id])));
  await page.locator('.pe-task-node[data-task-id="ACTUAL_2"]').click(); const card = page.locator('.pe-task-node[data-task-id="ACTUAL_2"]'); assert.equal(await card.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY'); assert.match(await page.evaluate(() => document.activeElement?.textContent), /本次|独立测试与审查/u);
  await page.getByRole('checkbox').check(); await records(page).focus(); await refresh(page); assert.equal(await records(page).evaluate(node => node === document.activeElement), true); assert.equal(await page.getByRole('checkbox').isChecked(), true);
  const commands = page.locator('.pe-commands'); assert.equal(await commands.getAttribute('open'), null); await commands.locator('summary').click(); assert.match(await commands.innerText(), /120 ms/u); assert.match(await commands.innerText(), /未知/u); assert.match(await commands.innerText(), /已确认/u);
  for (const secret of ['PRIVATE_ARGV', 'PRIVATE_STDOUT', 'PRIVATE_PID', 'PRIVATE_PATH']) assert.equal((await commands.innerText()).includes(secret), false);
  assert.equal(await page.locator('img,script:not([type="module"])').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); assert.ok(await page.locator('.pe-graph-scroll').evaluate(node => node.scrollWidth > node.clientWidth));
  await page.screenshot({ path: path.join(evidence, `graph-commands-${width}.png`), fullPage: true });
});

test('strict preview addresses reject credentials, remote origins, path tricks, malformed values and expiry', async t => {
  const page = await pageFor(t);
  for (const url of ['https://localhost:4317/', 'http://example.com:4317/', 'http://localhost.evil:4317/', 'http://user:password@localhost:4317/', 'http://localhost:4317/?x=1', 'http://localhost:4317/#x', 'http://localhost:4317/path/', 'http://localhost/', 'http://localhost:80/', 'http://localhost:0/', 'http://localhost:65536/', 'http://[::1]:4317/', 'http://127.1:4317/', 'http://localhost:4317/\\evil', ' http://localhost:4317/', 'javascript:alert(1)', marker, { href: 'http://localhost:4317/' }]) {
    await setRow(page, running({ preview: preview({ url }) })); assert.equal(await link(page).count(), 0, JSON.stringify(url)); assert.equal(await start(page).isDisabled(), true);
  }
  for (const extra of [{ expiresAt: '2020-01-01T00:00:00Z' }, { expiresAt: null }, { id: '../bad' }, { executionId: 'foreign' }, { state: 'unknown' }, { active: false }, { state: 'stopping' }]) {
    await setRow(page, running({ preview: preview(extra) })); assert.equal(await link(page).count(), 0, JSON.stringify(extra)); assert.equal(await download(page).count(), 0);
  }
  for (const url of ['http://localhost:4317/', 'http://127.0.0.1:4317']) { await setRow(page, running({ preview: preview({ url }) })); assert.equal(await link(page).isVisible(), true); }
  assert.equal(await page.locator('img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
});

test('only backend permission and current accepted binding authorize starting or opening preview', async t => {
  const page = await pageFor(t);
  for (const extra of [{ current: false }, { accepted: false }, { active: true }, { status: 'diagnostic_passed' }, { candidateCommit: 'invalid' }, { actions: { canPreview: false } }, { binding: { ...ctx, specRevision: D, sourceRevision: C, sourceGeneration: 1 } }]) {
    await setRow(page, execution(extra)); assert.equal(await start(page).isDisabled(), true);
    if (!extra.actions) { await setRow(page, running(extra)); assert.equal(await link(page).count(), 0); }
  }
  await page.evaluate(() => { window.ctx.planningStatus = 'unconfirmed'; }); await setRow(page, execution()); assert.equal(await start(page).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.requests.filter(row => row.method === 'POST').length), 0);
});

test('old scoped preview can stop without current approvals, and stopped POST awaits a confirming GET', async t => {
  const page = await pageFor(t), old = running({ current: false, binding: { ...ctx, specRevision: D, sourceRevision: C, sourceGeneration: 1 } });
  await setRow(page, old); await page.evaluate(() => { window.ctx.planningStatus = 'unconfirmed'; }); await refresh(page);
  assert.equal(await link(page).count(), 0); assert.equal(await stop(page).isEnabled(), true); assert.equal(await page.getByRole('checkbox').isDisabled(), true);
  await page.evaluate(() => { window.mode.noPublish = true; window.holds.dev = true; }); await stop(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  assert.equal(await link(page).count(), 0); assert.doesNotMatch(await page.locator('.pe-preview-status').innerText(), /已确认停止/u); await page.evaluate(() => window.release(0));
  await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('等待后续读取')); assert.equal(await stop(page).isDisabled(), true);
  await setRow(page, { ...old, preview: preview({ state: 'stopped', active: false, url: null, actions: { canStop: false } }), actions: { canPreview: false, canStopPreview: false } });
  assert.match(await page.locator('.pe-preview-status').innerText(), /已确认停止/u); assert.equal(await start(page).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.requests.filter(row => row.method === 'POST').length), 1); assert.deepEqual(await page.evaluate(() => window.requests.find(row => row.method === 'POST').body), {});
});

test('unknown preview blocks download and restart but explicit cleanup remains available', async t => {
  const page = await pageFor(t); await setRow(page, running({ preview: preview({ state: 'reconciliation_required', error: marker }), actions: { canPreview: true, canStopPreview: true, canDownload: true } }));
  await page.getByRole('checkbox').check(); assert.equal(await start(page).isDisabled(), true); assert.equal(await paid(page).isDisabled(), true); assert.equal(await download(page).count(), 0); assert.equal(await link(page).count(), 0); assert.equal(await stop(page).isEnabled(), true);
  assert.match(await page.locator('.pe-preview-info, .pe-preview .pe-note').innerText(), /img/u); assert.equal(await page.locator('img').count(), 0);
  await page.evaluate(() => { window.states.a.dev.executions[0].preview.state = 'unrecognized'; }); await refresh(page); assert.match(await page.locator('.pe-preview-status').innerText(), /未知/u); assert.equal(await stop(page).isEnabled(), true); assert.equal(await download(page).count(), 0);
});

test('start and stop preview send only empty bodies with the paid checkbox unchecked', async t => {
  const page = await pageFor(t); assert.equal(await page.getByRole('checkbox').isChecked(), false); await start(page).click(); await page.waitForFunction(() => document.querySelector('.pe-preview-link')?.hasAttribute('href'));
  assert.equal(await page.getByRole('checkbox').isChecked(), false); await stop(page).click(); await page.waitForFunction(() => document.querySelector('.pe-preview-status')?.textContent.includes('已确认停止'));
  assert.equal(await link(page).count(), 0); assert.equal(await page.getByRole('checkbox').isChecked(), false); assert.equal(await start(page).isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.requests.filter(row => row.method === 'POST').map(row => ({ action: row.url.split('/').at(-1), body: row.body }))), [{ action: 'preview', body: {} }, { action: 'stop-preview', body: {} }]);
});

test('an active preview on another scoped historical record blocks coding, restart and download', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions.push(value); }, { ...running(), id: 'historical', current: false, preview: preview({ executionId: 'historical' }) }); await refresh(page);
  await page.getByRole('checkbox').check(); assert.equal(await records(page).inputValue(), 'execution-1'); assert.equal(await paid(page).isDisabled(), true); assert.equal(await start(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
  await records(page).selectOption('historical'); await page.waitForFunction(() => !document.querySelector('.pe-preview button:nth-of-type(2)')?.disabled); assert.equal(await stop(page).isEnabled(), true); assert.equal(await link(page).count(), 0);
});

test('fresh reads, selection changes and failed reads immediately hide old addresses', async t => {
  const page = await pageFor(t); await setRow(page, running()); assert.equal(await link(page).isVisible(), true);
  await page.evaluate(() => { window.holds.dev = true; window.reading = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1); assert.equal(await link(page).count(), 0);
  await page.evaluate(() => window.release(0)); await page.waitForFunction(() => document.querySelector('.pe-preview-link')?.hasAttribute('href')); assert.equal(await link(page).isVisible(), true);
  await page.evaluate(() => { window.mode.getError = true; }); await refresh(page); assert.equal(await link(page).count(), 0); assert.equal(await start(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
  await page.evaluate(() => { window.mode.getError = false; window.states.a.dev.executions.push({ ...structuredClone(window.states.a.dev.executions[0]), id: 'execution-2', preview: null }); }); await refresh(page);
  await page.evaluate(() => { window.holds.dev = true; }); await records(page).selectOption('execution-2'); await page.waitForFunction(() => window.pending.length === 2); assert.equal(await link(page).count(), 0); assert.equal(await records(page).inputValue(), 'execution-2');
  await records(page).selectOption('execution-1'); await page.waitForFunction(() => document.querySelector('.pe-preview-link')?.hasAttribute('href')); await page.evaluate(() => window.release(1));
  assert.equal(await records(page).inputValue(), 'execution-1'); assert.equal(await link(page).getAttribute('href'), 'http://127.0.0.1:4317/');
});

test('context A-B-A rejects an old preview GET and POST without reviving its URL', async t => {
  const page = await pageFor(t); await setRow(page, running()); await page.evaluate(() => { window.holds.dev = true; window.oldRead = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async () => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; await window.panel.refresh(); window.states.a.dev.executions[0].preview = null; window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; await window.panel.refresh(); });
  await page.evaluate(() => window.release(0)); assert.equal(await link(page).count(), 0);
  await page.evaluate(() => { window.states.a.dev.executions[0].actions.canPreview = true; }); await refresh(page); await page.evaluate(() => { window.holds.post = true; }); await start(page).click(); await page.waitForFunction(() => window.pending.length === 2);
  await page.evaluate(async () => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; await window.panel.refresh(); window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; await window.panel.refresh(); });
  await page.evaluate(() => window.release(1)); assert.equal(await link(page).count(), 0); assert.equal(await page.evaluate(() => window.requests.filter(row => row.method === 'POST').length), 1);
});

test('malformed or failed preview POST never creates a link or automatic retry', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.mode.noPublish = true; window.nextPost = { execution: window.states.a.dev.executions[0], preview: value }; }, preview({ executionId: 'foreign' })); await start(page).click(); await page.waitForFunction(() => window.errors.length === 1);
  assert.equal(await link(page).count(), 0); assert.equal(await start(page).isDisabled(), true); await page.evaluate(() => { window.nextPost = null; window.mode.postError = true; }); await refresh(page); await start(page).click(); await page.waitForFunction(() => window.errors.length === 2);
  assert.equal(await link(page).count(), 0); assert.equal(await page.evaluate(() => window.requests.filter(row => row.method === 'POST').length), 2);
});

test('invalid graph relationships are displayed as evidence without fabricated edges', async t => {
  const page = await pageFor(t);
  for (const tasks of [[{ id: 'A', title: marker, dependsOn: ['MISSING'], status: 'pending' }], [{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }]]) {
    await setRow(page, execution({ executionMode: 'task_dag', tasks })); assert.equal(await page.locator('.pe-graph-scroll').isVisible(), false); assert.equal(await page.locator('.pe-graph-canvas path').count(), 0);
    const evidence = page.locator('.pe-graph-scroll + div > details').first(); if (await evidence.getAttribute('open') === null) await evidence.locator('summary').click();
    // The task description is a direct child; the role monitor has its own paragraph.
    const description = evidence.locator(':scope > p'); assert.equal(await description.isVisible(), true); assert.match(await description.innerText(), /任务 A/u);
  }
  assert.equal(await page.locator('img').count(), 0);
});
