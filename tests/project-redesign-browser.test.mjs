import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

// Real Edge against isolated source storage or explicitly controlled panel DTOs.
// These tests make no paid requests and do not grant software acceptance.
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const ids = { projectId: 'redesign-project', runId: 'redesign-run' };
const context = { ...ids, specRevision: A, planRevision: B, sourceRevision: C, sourceGeneration: 0, planningStatus: 'confirmed' };
const original = '用户可以读取资源列表。';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { const end = Date.now() + 12000; while (!await check()) { assert.ok(Date.now() < end, message); await pause(20); } }
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const button = (page, name) => page.getByRole('button', { name, exact: true });
const screenshots = path.resolve('output/ui-navigation/project-redesign');
const modelError = () => assert.fail('This UI regression must not request a model');

async function sourceFixture(t, width) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-redesign-source-'));
  let browser, app, releaseCheckpoint, checkpoint;
  const errors = [], writes = [];
  t.after(async () => {
    releaseCheckpoint?.(); await checkpoint?.catch(() => {});
    await browser?.close(); await app?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('tf-redesign-source-'));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner, getModelConfig: () => ({ configured: false }), analyzeWithModel: modelError,
    analyzeRequirements: content => ({ title: '资源目录', summary: content, goals: [], roles: ['用户'], questions: [], constraints: [], assumptions: [], acceptanceScenarios: [], sourceMode: 'local',
      stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取资源', description: content, sourceQuote: content, acceptance: ['按当前需求显示资源'] }] }) } });
  const project = await app.store.create({ name: '需求版本交互回归', source: { filename: 'requirements.md', content: original } });
  const run = await app.orchestrator.createRun(project.id);
  await until(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving, 'Local specification did not settle');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error' && !entry.location().url.endsWith('/apply')) errors.push(entry.text()); });
  page.on('request', request => { if (request.method() === 'POST') writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await page.goto(origin); await page.locator('[data-workspace-view="source"]').click();
  const panel = page.locator('.source-changes'); await panel.waitFor();
  await until(() => panel.getByLabel('需求正文', { exact: true }).isEnabled(), 'Source editor did not become ready');
  return { app, project, run, page, panel, writes, origin,
    async holdCheckpoint() {
      checkpoint = app.orchestrator.withProjectCheckpoint(project.id, () => new Promise(resolve => { releaseCheckpoint = resolve; }));
      await until(() => typeof releaseCheckpoint === 'function', 'Checkpoint was not acquired');
    },
    async releaseCheckpoint() { releaseCheckpoint?.(); await checkpoint; releaseCheckpoint = null; checkpoint = null; },
  };
}

for (const width of [1440, 390]) test(`source process ${width}px: feature preview, pending save, failed checkpoint and confirmed application remain distinct`, { timeout: 70000 }, async t => {
  const f = await sourceFixture(t, width), { page, panel, project, run, app, writes } = f;
  await panel.locator('.sc-process').waitFor();
  assert.deepEqual(await panel.locator('[data-source-phase]').evaluateAll(nodes => nodes.map(node => node.dataset.sourcePhase)), ['current', 'draft', 'pending', 'applied']);
  for (const phase of ['current', 'draft']) await panel.locator(`[data-source-phase="${phase}"]`).click();
  assert.equal(writes.length, 0, 'Process navigation must not save or apply');
  if (await button(panel, '直接修改需求').isVisible()) await button(panel, '直接修改需求').click();
  const source = panel.getByLabel('需求正文', { exact: true });
  if (!await source.isVisible()) await panel.locator('.sc-full-editor > summary').click();
  await source.fill(original + '\n\n保留尚未保存的说明。');
  await button(panel, '新增功能').click();
  await panel.getByLabel('功能名称', { exact: true }).fill('资源搜索');
  await panel.getByLabel('功能说明', { exact: true }).fill('用户按资源标题筛选列表。');
  await panel.getByLabel('功能验收条件（每行一条）', { exact: true }).fill('输入标题关键字后只显示匹配资源。');
  assert.match(await panel.getByLabel('功能追加预览', { exact: true }).innerText(), /保留尚未保存的说明[\s\S]*资源搜索/u);
  assert.equal(writes.length, 0);
  await button(panel, '加入需求草稿').click();
  await button(panel, '直接修改需求').click();
  assert.match(await source.inputValue(), /保留尚未保存的说明[\s\S]*资源搜索/u);
  const reason = panel.getByLabel('变更原因', { exact: true }); await reason.fill('补充搜索能力，并保留原来的正文');
  await reason.focus(); await reason.evaluate(node => node.setSelectionRange(2, 7));
  const reads = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/projects/${project.id}/changes`));
  await reads;
  assert.deepEqual(await reason.evaluate(node => [node === document.activeElement, node.selectionStart, node.selectionEnd]), [true, 2, 7]);
  const preservedSource = await source.inputValue(), preservedReason = await reason.inputValue();
  await page.locator('[data-workspace-view="execution"]').click();
  assert.deepEqual(await page.locator('[data-execution-step]').evaluateAll(nodes => nodes.map(node => node.dataset.executionStep)), ['verification', 'coding', 'testing', 'delivery']);
  await page.locator('[data-execution-step="verification"]').click();
  assert.equal(await page.locator('#workspace-execution').isVisible(), true);
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#workspace-execution'))), true);
  await page.locator('[data-workspace-view="source"]').click();
  assert.equal(await source.inputValue(), preservedSource); assert.equal(await reason.inputValue(), preservedReason);
  await button(panel, '新增功能').click();
  await button(panel, '保存为待应用变更').click();
  await until(() => app.sourceChangeService.list({ projectId: project.id }).length === 1, 'Pending source request was not saved');
  await until(() => button(panel, '应用为新需求版本').isEnabled(), 'Saved pending source cannot be reviewed');
  const saved = app.sourceChangeService.list({ projectId: project.id })[0];
  assert.equal(saved.status, 'pending'); assert.equal(project.source.content, original); assert.equal(app.store.getSourceVersion(project.id).generation, 0);
  assert.match(await panel.locator('.sc-diff-block').innerText(), /资源搜索/u);
  assert.equal(await panel.locator('[data-source-phase="pending"]').getAttribute('data-state'), 'current');
  assert.equal(await panel.locator('[data-source-phase="applied"]').getAttribute('data-state'), 'waiting');
  assert.equal(await button(panel, '重新规划').isEnabled(), false);
  await until(() => panel.locator('.sc-feature-editor').isHidden(), 'Confirmed pending features should expose the difference review instead of the full form');
  await button(panel, '编辑草稿').click();
  assert.equal(await panel.locator('.sc-feature-editor').isVisible(), true);
  assert.equal(await panel.getByLabel('功能名称', { exact: true }).inputValue(), '资源搜索');
  const retainedEdit = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/projects/${project.id}/changes`));
  await retainedEdit;
  assert.equal(await panel.locator('.sc-feature-editor').isVisible(), true, 'Polling preserves an explicitly reopened form');
  await button(panel, '收起编辑').click();
  if (await panel.locator('.sc-full-editor > summary').isVisible() && await panel.locator('.sc-full-editor').evaluate(node => node.open)) await panel.locator('.sc-full-editor > summary').click();
  const savedWrites = writes.length; await panel.locator('[data-source-phase="pending"]').click();
  assert.equal(writes.length, savedWrites, 'Reviewing pending differences does not apply the change');
  await panel.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `source-pending-${width}.png`) });
  await panel.locator('.sc-diff-block').evaluate(node => node.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(screenshots, `source-diff-${width}.png`) });
  await f.holdCheckpoint();
  const rejectedApplication = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/apply'));
  await button(panel, '应用为新需求版本').click();
  assert.equal((await rejectedApplication).status(), 409);
  await until(() => panel.locator('.sc-error:not([hidden])').isVisible(), 'Checkpoint failure was not displayed');
  assert.equal(project.source.content, original); assert.equal(app.store.getSourceVersion(project.id).generation, 0);
  assert.equal(app.sourceChangeService.list({ projectId: project.id })[0].status, 'pending');
  assert.equal(project.runs.length, 1); assert.equal(await panel.locator('[data-source-phase="applied"]').getAttribute('data-state'), 'waiting');
  await f.releaseCheckpoint(); await button(panel, '刷新变更状态').click();
  await until(() => button(panel, '应用为新需求版本').isEnabled(), 'Released checkpoint did not restore a pending action');
  await button(panel, '应用为新需求版本').click();
  await until(() => project.sourceGeneration === 1, 'Applied source version was not committed');
  await until(() => button(panel, '重新规划').isEnabled(), 'Replan enabled before/without confirmed GET binding');
  assert.match(project.source.content, /资源搜索/u); assert.equal(run.sourceSuperseded, true); assert.equal(run.sourceSnapshot.content, original);
  assert.equal(app.sourceChangeService.list({ projectId: project.id })[0].status, 'applied');
  assert.equal(await panel.locator('[data-source-phase="applied"]').getAttribute('data-state'), 'current');
  await button(panel, '前往重新规划').click();
  assert.equal(await button(panel, '重新规划').evaluate(node => node === document.activeElement), true);
  assert.equal(project.runs.length, 1, 'Process navigation only focuses the explicit replan action');
  await button(panel, '重新规划').click();
  await until(() => project.runs.length === 2 && project.runs.at(-1).status === 'awaiting_spec', 'Confirmed source was not replanned locally');
  assert.equal(project.runs.at(-1).sourceGeneration, 1); assert.deepEqual(project.runs.at(-1).approvals, { spec: null, plan: null });
  assert.equal(await noOverflow(page), true);
  await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `source-${width}.png`), fullPage: true });
});

function definition() { return { id: 'definition-current', ...ids, current: true, approved: true, status: 'approved', revision: A, manifestHash: B, coverage: 'structural_only', executed: false,
  binding: { ...context }, approval: { phase: 'definition_only' }, proposal: { name: '事先批准的接口与浏览器清单', steps: [], browser: { version: 1, sessions: ['member'], steps: [{ id: 'list' }] } } }; }
function execution(extra = {}) { return { id: 'execution-current', ...ids, proposalId: 'definition-current', revision: A, kind: 'planned_web', current: true, active: true, status: 'generating',
  binding: { ...context }, budget: { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000 }, candidateCommit: null, baseCommit: 'b'.repeat(40), accepted: false,
  events: [], modelCalls: [], reviewHistory: [], totalModelCalls: 0, usage: { inputTokens: null, outputTokens: null }, checks: null,
  actions: { canCancel: true, canDownload: false, canPreview: false }, ...extra }; }
const capabilities = { canStart: true, contractRevision: D, model: { name: '本地编码夹具', reviewName: '本地审查夹具' },
  budget: { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000, maxAttempts: 3, remainingAttempts: 3, totalModelCalls: 18, remainingModelCalls: 18 } };

async function executionFixture(t, width) {
  let browser, server;
  const errors = [];
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/workbench-theme.css"><link rel="stylesheet" href="/execution-process.css"><style>body{margin:0}main{max-width:1100px;margin:18px auto;padding:0 12px}</style></head><body class="tf-product"><main id="panel"></main><script type="module">
    import {createPlannedExecutionPanel} from '/planned-execution.js';
    window.ctx=${JSON.stringify(context)};window.dev={capabilities:${JSON.stringify(capabilities)},executions:[]};window.definitions={coverage:'structural_only',proposals:[${JSON.stringify(definition())}]};
    window.requests=[];window.observedErrors=[];window.readFailure=false;window.postFailure=false;window.holdPost=false;window.releasePost=null;
    const api=async(url,options={})=>{const method=options.method||'GET';requests.push({url,method,body:options.body?JSON.parse(options.body):null});
      if(method==='GET'){if(readFailure)throw Error('受控读取失败，请刷新核对');return structuredClone(url.endsWith('/verification-plans')?definitions:dev);}
      if(holdPost)await new Promise(resolve=>releasePost=resolve);if(postFailure)throw Error('受控请求结果未知');return {execution:${JSON.stringify(execution({ id: 'new-execution', status: 'preparing' }))}};};
    window.panel=createPlannedExecutionPanel({api,getContext:()=>ctx,openVerification:()=>{},onError:error=>observedErrors.push(error.message)});await panel.mount(document.querySelector('#panel'));window.ready=true;
  </script></body></html>`;
  const allowed = new Set(['planned-execution.js', 'workbench-theme.css', 'execution-process.css']);
  server = http.createServer(async (request, response) => {
    const name = request.url.slice(1);
    if (!name) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    if (!allowed.has(name)) { response.writeHead(404); response.end(); return; }
    try { const bytes = await readFile(new URL('../public/' + name, import.meta.url)); response.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : 'text/javascript' }); response.end(bytes); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
  return page;
}
const refresh = page => page.evaluate(() => panel.refresh());
const consent = page => page.getByRole('checkbox');
const start = page => button(page, '按当前规划开始开发');
const download = page => page.getByRole('link', { name: '下载当前已验收源码', exact: true });
async function setExecution(page, value) { await page.evaluate(value => { dev.executions = [value]; }, value); await refresh(page); }

for (const width of [1440, 390]) test(`execution process ${width}px: explicit paid consent, acknowledgement, unknown state and historical passes never authorize delivery`, { timeout: 45000 }, async t => {
  const page = await executionFixture(t, width); await start(page).waitFor();
  assert.equal(await start(page).isDisabled(), true); await consent(page).check(); await consent(page).focus(); await refresh(page);
  assert.equal(await consent(page).isChecked(), true); assert.equal(await consent(page).evaluate(node => node === document.activeElement), true);
  await page.evaluate(() => { dev.capabilities.contractRevision = 'e'.repeat(64); }); await refresh(page);
  assert.equal(await consent(page).isChecked(), false); assert.equal(await start(page).isDisabled(), true);
  await consent(page).check(); await page.evaluate(() => { holdPost = true; }); await start(page).click();
  await page.waitForFunction(() => typeof releasePost === 'function'); assert.equal(await start(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
  await page.evaluate(() => releasePost()); await page.waitForFunction(() => requests.filter(row => row.method === 'POST').length === 1 && !document.querySelector('button').disabled);
  assert.equal(await download(page).count(), 0, 'POST acknowledgement cannot grant an accepted result');
  await setExecution(page, execution({ id: 'new-execution', status: 'reconciliation_required', active: true, candidateCommit: 'c'.repeat(40), accepted: true, actions: { canDownload: true, canPreview: true, canCancel: false } }));
  assert.equal(await download(page).count(), 0); assert.equal(await start(page).isDisabled(), true);
  const passed = execution({ id: 'new-execution', status: 'accepted', active: false, accepted: true, candidateCommit: 'd'.repeat(40), actions: { canDownload: true, canPreview: true, canCancel: false } });
  await setExecution(page, passed); assert.equal(await download(page).isVisible(), true, 'The same complete current DTO is eligible once its pending acknowledgement is reconciled');
  await setExecution(page, { ...passed, current: false });
  assert.equal(await download(page).count(), 0); assert.match(await page.locator('.pe-result').innerText(), /历史|未确认/u);
  assert.equal(await page.evaluate(() => requests.filter(row => row.method === 'POST').length), 1);
  assert.equal(await noOverflow(page), true);
  await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `execution-gates-${width}.png`), fullPage: true });
});

for (const width of [1440, 390]) test(`task inspector ${width}px keeps selection and same-version historical failures while keyboard navigation stays on the actual graph`, { timeout: 45000 }, async t => {
  const page = await executionFixture(t, width), oldCommit = '1'.repeat(40), currentCommit = '2'.repeat(40);
  const history = { attemptId: 'feature-old-attempt', candidateCommit: oldCommit, status: 'failed', totalModelCalls: 2,
    checks: { self: [{ id: 'self-old', passed: true }], http: [{ id: 'http-old', passed: false, expected: '200', actual: '409' }], browser: [], review: 'not_started', issues: [] } };
  const tasks = [
    { id: 'BASE', title: '初始化资源应用', dependsOn: [], status: 'completed', stage: 'accepted', candidateCommit: '3'.repeat(40), attemptId: 'base-attempt', history: [], checks: { self: [{ id: 'base-self', passed: true }], http: [{ id: 'base-http', passed: true }], browser: [{ id: 'base-edge', passed: true }], review: 'completed', issues: [] } },
    { id: 'FEATURE', title: '查询资源与权限边界', dependsOn: ['BASE'], status: 'running', stage: 'generating', candidateCommit: null, attemptId: 'feature-current-attempt', history: [history], checks: null, error: null },
    { id: 'FINAL', title: '完整业务集成', dependsOn: ['FEATURE'], status: 'pending', candidateCommit: null, history: [] },
  ];
  await setExecution(page, execution({ status: 'running', executionMode: 'task_dag', tasks, maxConcurrentTasks: 2, totalModelCalls: 4 }));
  const graph = page.getByRole('region', { name: '真实任务依赖图', exact: true });
  const feature = page.locator('.pe-task-node[data-task-id="FEATURE"]'); await feature.click();
  const inspector = page.getByRole('complementary', { name: '所选任务详情', exact: true }); await inspector.waitFor();
  assert.equal(await inspector.getAttribute('data-task-id'), 'FEATURE'); assert.match(await inspector.innerText(), /等待新候选|尚未固定/u);
  assert.equal(await feature.getAttribute('aria-pressed'), 'true'); assert.equal(await graph.isVisible(), true);
  const matrix = page.getByRole('table', { name: '候选版本的同版验收结果', exact: true }); await matrix.waitFor();
  const old = matrix.locator(`tbody tr[data-task-id="FEATURE"][data-candidate-commit="${oldCommit}"]`);
  assert.equal(await old.count(), 1); assert.equal(await old.getAttribute('data-current'), 'false'); assert.match(await old.innerText(), /未通过|失败/u);
  await feature.focus(); await refresh(page); assert.equal(await feature.evaluate(node => node === document.activeElement), true);
  assert.equal(await inspector.getAttribute('data-task-id'), 'FEATURE');
  await page.keyboard.press('Home'); assert.equal(await page.locator('.pe-task-node[data-task-id="BASE"]').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('End'); assert.equal(await page.locator('.pe-task-node[data-task-id="FINAL"]').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('ArrowLeft'); assert.equal(await feature.getAttribute('aria-pressed'), 'true');
  tasks[1] = { ...tasks[1], candidateCommit: currentCommit, stage: 'validating', checks: { self: [{ id: 'self-current', passed: true }], http: [{ id: 'http-current', passed: false, expected: '403', actual: '200' }], browser: [], review: 'not_started', issues: [] } };
  await setExecution(page, execution({ status: 'running', executionMode: 'task_dag', tasks, maxConcurrentTasks: 2, totalModelCalls: 5 }));
  assert.match(await inspector.innerText(), new RegExp(currentCommit.slice(0, 12), 'u'));
  assert.equal(await old.count(), 1); assert.match(await old.innerText(), /未通过|失败/u);
  await old.getByRole('button').click();
  assert.match(await inspector.innerText(), /历史结果，不计入当前通过/u);
  assert.match(await inspector.innerText(), new RegExp(oldCommit, 'u'));
  assert.match(await inspector.innerText(), /feature-old-attempt/u);
  assert.doesNotMatch(await inspector.innerText(), /feature-current-attempt/u);
  await feature.click(); assert.match(await inspector.innerText(), new RegExp(currentCommit, 'u'));
  tasks[1] = { ...tasks[1], status: 'failed', stage: 'failed', error: '成员越权读取资源，预期403，实际200', errorCode: 'verification_failed' };
  tasks[2] = { ...tasks[2], status: 'blocked' };
  await setExecution(page, execution({ status: 'failed', active: false, executionMode: 'task_dag', tasks, maxConcurrentTasks: 2, totalModelCalls: 5 }));
  assert.match(await inspector.innerText(), /成员越权读取资源/u);
  assert.equal(await inspector.locator('.pe-inspector-facts').getByText('等待测试通过', { exact: true }).isVisible(), true);
  assert.equal(await download(page).count(), 0); assert.equal(await noOverflow(page), true);
  assert.equal(await page.evaluate(() => requests.some(row => row.method === 'POST')), false);
  await mkdir(screenshots, { recursive: true });
  if (width === 1440) await page.locator('.pe-process').screenshot({ path: path.join(screenshots, `execution-task-inspector-${width}.png`) });
  else await page.screenshot({ path: path.join(screenshots, `execution-task-inspector-${width}.png`), fullPage: true });
});
