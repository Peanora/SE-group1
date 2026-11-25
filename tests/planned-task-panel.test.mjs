import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const context = { projectId: 'project-a', runId: 'run-a', specRevision: A, planRevision: B, planningStatus: 'confirmed' };
const marker = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
function proposal() { return { id: 'proposal-1', projectId: context.projectId, runId: context.runId, current: true, approved: true, status: 'approved', revision: A, manifestHash: B, coverage: 'structural_only', executed: false,
  binding: { ...context, sourceRevision: C, sourceGeneration: 1 }, approval: { phase: 'definition_only' }, proposal: { name: '联合验收定义', browser: { version: 1, sessions: ['user'], steps: [{ id: 'visible' }] } } }; }
function execution(extra = {}) { return { id: 'execution-1', projectId: context.projectId, runId: context.runId, proposalId: 'proposal-1', revision: A, kind: 'planned_web', status: 'generating', current: true, active: true,
  binding: { ...context, sourceRevision: C, sourceGeneration: 1 }, budget: { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000 }, candidateCommit: 'e'.repeat(40), baseCommit: 'f'.repeat(40), diff: marker, usage: { inputTokens: null, outputTokens: 8 }, totalModelCalls: 1,
  events: [{ sequence: 1, at: '2026-11-17T00:00:00Z', status: 'generating', message: marker }], error: null, accepted: false, actions: { canCancel: true, canDownload: false },
  checks: { self: [{ id: 'self', expected: '200', actual: '200', passed: true }], http: [], browser: [{ id: 'browser', name: marker, expected: marker, actual: marker, passed: false }], review: 'changes_requested', issues: [{ id: 'blocking', severity: 'blocking', status: 'open', message: marker }] }, modelCalls: [{ role: 'coding', kind: 'model', attempt: 1, model: marker, usage: { inputTokens: null, outputTokens: 8 }, finishReason: 'stop', receiptConfirmed: true, receiptHash: C }], ...extra }; }
function fixture() { return { dev: { capabilities: { canStart: true, contractRevision: D, model: { name: 'controlled-fixture-model' }, budget: { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000, maxAttempts: 3, totalModelCalls: 0, remainingModelCalls: 18, remainingAttempts: 3 }, reason: null }, executions: [] }, definitions: { coverage: 'structural_only', proposals: [proposal()] } }; }
const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>body{margin:0;background:#f5f7fb;font:14px sans-serif}main{max-width:1100px;margin:24px auto;padding:0 16px}</style></head><body><main><div id="panel"></div></main><script type="module">
import {createPlannedExecutionPanel} from '/planned-execution.js';
window.ctx=${JSON.stringify(context)};window.initial=${JSON.stringify(fixture())};window.template=${JSON.stringify(execution()).replaceAll('<', '\\u003c')};
window.states={a:structuredClone(window.initial),b:structuredClone(window.initial)};
for(const p of window.states.b.definitions.proposals){p.projectId='project-b';p.runId='run-b';p.binding.projectId='project-b';p.binding.runId='run-b';}
for(const p of window.states.b.definitions.proposals){p.projectId='project-b';p.runId='run-b';p.binding.projectId='project-b';p.binding.runId='run-b';}
window.requests=[];window.errors=[];window.failures=[];window.holds={};window.pending=[];window.mode={};window.serial=0;
window.release=async(i,extra={})=>{const p=window.pending[i];if(extra.error)p.reject(new Error(extra.error));else p.resolve(extra.response??await p.execute());};
const api=(url,options={})=>{
 const method=options.method||'GET',k=url.includes('/project-b/')?'b':'a',state=window.states[k],type=method==='POST'?'post':url.endsWith('/verification-plans')?'definitions':'dev';
 const snapshot=structuredClone(state[type==='definitions'?'definitions':'dev']);const body=options.body?JSON.parse(options.body):null;window.requests.push({url,method,body});
 const execute=async()=>{
  if(method==='GET'){if(window.mode.getError)throw new Error('读取开发记录失败');return snapshot;}
  if(window.mode.postError)throw new Error('开发请求未确认');
  const result=window.nextPost?structuredClone(window.nextPost):{...structuredClone(window.template),id:'new-'+(++window.serial),projectId:k==='b'?'project-b':'project-a',runId:k==='b'?'run-b':'run-a',status:url.endsWith('/cancel')?'cancel_requested':'preparing',active:true};
  if(url.endsWith('/cancel'))result.id=url.split('/').at(-2);
  result.binding.projectId=result.projectId;result.binding.runId=result.runId;
  if(!window.mode.noPublish)state.dev.executions=[result,...state.dev.executions.filter(x=>x.id!==result.id)];return {execution:result};
 };
 if(window.holds[type]){window.holds[type]=false;return new Promise((resolve,reject)=>window.pending.push({url,method,type,execute,resolve,reject}));}return execute();
};
window.panel=createPlannedExecutionPanel({api,getContext:()=>window.ctx,onError:e=>{window.errors.push(e.message);if(window.mode.observerThrow)throw new Error('observer');},onFailure:value=>{window.failures.push(structuredClone(value));if(window.mode.observerReject)return Promise.reject(new Error('observer rejected'));}});
await window.panel.mount(document.querySelector('#panel'));window.ready=true;
</script></body></html>`;
let browser, server, origin;
before(async () => { const module = await readFile(new URL('../public/planned-execution.js', import.meta.url)); server = http.createServer((request, response) => { const js = request.url === '/planned-execution.js'; response.writeHead(200, { 'content-type': js ? 'text/javascript' : 'text/html; charset=utf-8' }); response.end(js ? module : harness); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function pageFor(t, width = 1440) { const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } }), errors = []; page.on('pageerror', value => errors.push(value.message)); page.on('console', value => { if (value.type() === 'error') errors.push(value.text()); }); t.after(async () => { await page.close(); assert.deepEqual(errors, []); }); await page.goto(origin); await page.waitForFunction(() => window.ready); return page; }
const start = page => page.getByRole('button', { name: '按当前规划开始开发', exact: true });
const cancel = page => page.getByRole('button', { name: '请求停止本次开发', exact: true });
const repair = page => page.getByRole('button', { name: '保留代码并修复', exact: true });
const download = page => page.getByRole('link', { name: '下载当前已验收源码', exact: true });
const consent = page => page.getByRole('checkbox');
const records = page => page.getByLabel('开发执行记录', { exact: true });
const refresh = page => page.evaluate(() => window.panel.refresh());
const acceptedRow = execution({ status: 'accepted', accepted: true, active: false, actions: { canCancel: false, canDownload: true } });
const failedRow = execution({ status: 'failed', active: false, error: '原候选仍有阻塞问题', actions: { canCancel: false, canDownload: false, canRepair: true } });

// Only the existing component harness above is copied. These are new root-authored
// task-budget/task-evidence/control regressions, no former panel suite is registered.
import { writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Freeze the version under this test run, so legitimate future UI changes keep
// all behavior checks while still failing if the tested file changes mid-run.
const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const panelFile = new URL('../public/planned-execution.js', import.meta.url);
const frozenHash = digest(await readFile(panelFile));
let evidence;
before(async () => { assert.equal(digest(await readFile(panelFile)), frozenHash); const base = path.resolve('output/task-panel-regressions'); await mkdir(base, { recursive: true }); evidence = await mkdtemp(path.join(base, 'case-')); });
after(async () => {
  if (!evidence) return;
  const actual = digest(await readFile(panelFile));
  await writeFile(path.join(evidence, 'frozen-after.json'), JSON.stringify({ path: 'public/planned-execution.js', expected: frozenHash, actual, matches: actual === frozenHash }, null, 2)); assert.equal(actual, frozenHash);
});
const pause = page => page.getByRole('button', { name: '暂停派发新任务', exact: true });
const resume = page => page.getByRole('button', { name: '继续任务开发', exact: true });
const recover = page => page.getByRole('button', { name: '从安全暂停点恢复', exact: true });
const taskArea = page => page.locator('details').filter({ has: page.locator('summary', { hasText: /^真实任务、依赖与验收证据$/u }) }).first();
const taskCards = page => taskArea(page).locator(':scope > div > details');
const statusText = page => page.locator('.pe-status');
const taskBudget = () => ({ maxCalls: 3, maxReviewCalls: 3, taskLimit: 4, attemptModelCalls: 24, maxConcurrency: 2,
  timeoutMs: 1200000, maxAttempts: 3, totalModelCalls: 72, remainingModelCalls: 72, remainingAttempts: 3 });
function taskRow(extra = {}) {
  return execution({ status: 'running', executionMode: 'task_dag', budget: taskBudget(), actions: { canPause: true, canResume: false, canCancel: true, canDownload: false },
    tasks: [
      { id: 'TASK_A', title: `第一任务 ${marker}`, dependsOn: [], status: 'completed', stage: 'accepted', baseCommit: '1'.repeat(40), candidateCommit: '2'.repeat(40), attemptId: 'attempt-a', usage: { inputTokens: 11, outputTokens: 12 },
        checks: { self: [{ id: 'SELF_A', passed: true, expected: '200', actual: '200' }], http: [{ id: 'HTTP_A', passed: true, expected: 'SQLite持久化', actual: '重启后记录保留' }], browser: [{ id: 'EDGE_A', passed: true, expected: marker, actual: marker }], review: 'completed', issues: [] }, diff: `diff --git src/a.mjs\n+${marker}` },
      { id: 'TASK_B', title: `第二任务 ${'长标题'.repeat(60)}`, dependsOn: ['TASK_A'], status: 'running', stage: 'validating', baseCommit: '3'.repeat(40), candidateCommit: '4'.repeat(40), attemptId: 'attempt-b', usage: { inputTokens: null, outputTokens: 19 },
        checks: { self: [{ id: 'SELF_B', passed: true }], http: [{ id: 'HTTP_B', expected: 409, actual: 201, passed: false }], browser: [{ id: 'EDGE_B', expected: '拒绝重复', actual: '重复创建', passed: false }], review: 'changes_requested', issues: [{ id: 'BLOCK_B', severity: 'blocking', message: marker }] }, diff: `diff --git src/b.mjs\n+${'long-diff-'.repeat(100)}${marker}` },
    ], ...extra });
}
async function setupTasks(page, rows = []) {
  await page.evaluate(({ budget, rows }) => { window.states.a.dev.capabilities.budget = budget; window.states.a.dev.capabilities.supportedProposalIds = ['proposal-1']; window.states.a.dev.executions = rows; if (rows.length) window.template = structuredClone(rows[0]); }, { budget: taskBudget(), rows }); await refresh(page);
}
async function publish(page, row) { await page.evaluate(row => { window.states.a.dev.executions = [row]; }, row); await refresh(page); }

for (const width of [1440, 390]) test(`new task panel ${width}px shows separate real task source, checks, blockers and safe evidence without layout overflow`, async t => {
  const page = await pageFor(t, width), row = taskRow(); row.tasks[1].error = marker; row.tasks[1].errorCode = 'proposal_invalid';
  const task = row.tasks[1];
  const candidateCommit = task.candidateCommit;
  task.candidateCommit = null;
  row.reviewHistory = [{ taskId: task.id, attemptId: task.attemptId, candidateCommit, status: 'not_started' }];
  await page.evaluate(() => { window.states.a.dev.capabilities.costEstimate = { known: false, amount: null, currency: null, reason: '未配置模型单价' }; });
  await setupTasks(page, [row]);
  assert.equal(await page.getByText('只有后端当前版本验收通过后才开放源码下载。', { exact: true }).isVisible(), true);
  const cost = page.getByText(/最多4项真实任务，每项编码最多3次/u);
  assert.equal(await cost.isVisible(), true);
  assert.match(await cost.innerText(), /本次最多24次模型调用，并发最多2项.*1200秒/u);
  assert.equal(await taskCards(page).count(), 2); assert.match(await taskCards(page).nth(0).locator('summary').innerText(), /本任务已验收并集成/u); assert.match(await taskCards(page).nth(1).locator('summary').innerText(), /独立测试与审查/u);
  for (let i = 0; i < 2; i++) { const card = taskCards(page).nth(i); await card.locator('summary').click(); const body = await card.locator('pre').innerText();
    for (const field of ['baseCommit', 'candidateCommit', 'attemptId', 'usage', 'checks', 'diff']) assert.ok(body.includes(field), `${width}/${i}/${field}`);
    for (const field of ['SELF_', 'HTTP_', 'EDGE_']) assert.ok(body.includes(field), `${width}/${i}/${field}`);
  }
  assert.match(await taskCards(page).nth(1).innerText(), /TASK_A/u); assert.match(await taskCards(page).nth(1).locator('pre').innerText(), /BLOCK_B/u);
  assert.ok((await taskCards(page).nth(1).locator(':scope > p').innerText()).includes(marker)); assert.match(await taskCards(page).nth(1).locator('pre').innerText(), /proposal_invalid/u);
  const firstRoles = taskCards(page).nth(0).getByRole('region', { name: '任务角色进度' });
  const secondRoles = taskCards(page).nth(1).getByRole('region', { name: '任务角色进度' });
  assert.equal(await firstRoles.locator('[data-role="review"]').getAttribute('data-state'), 'done');
  assert.equal(await secondRoles.locator('[data-role="testing"]').getAttribute('data-state'), 'failed');
  assert.equal(await secondRoles.locator('[data-role="review"]').getAttribute('data-state'), 'waiting');
  assert.equal(await secondRoles.locator('.pe-role-context').getAttribute('title'), candidateCommit);
  assert.equal(JSON.parse(await taskCards(page).nth(1).locator('pre').innerText()).candidateCommit, candidateCommit);
  const estimate = page.getByText(/费用估算：未知.*未配置模型单价/u);
  assert.equal(await estimate.isVisible(), true);
  assert.equal(await page.locator('img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined); assert.equal(await download(page).count(), 0);
  assert.equal(await pause(page).isEnabled(), true); assert.equal(await resume(page).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: path.join(evidence, `tasks-${width}.png`), fullPage: true });

  task.candidateCommit = candidateCommit;
  task.stage = 'generating';
  await publish(page, row);
  assert.equal(await secondRoles.locator('.pe-role-context').getAttribute('title'), '');
  const previousEvidence = JSON.parse(await taskCards(page).nth(1).locator('pre').innerText());
  assert.equal(previousEvidence.candidateCommit, null);
  assert.equal(previousEvidence.lastFixedCandidateCommit, candidateCommit);
});

test('each new frozen task-budget field change withdraws previously granted fee consent', async t => {
  const page = await pageFor(t);
  for (const name of ['taskLimit', 'attemptModelCalls', 'maxConcurrency']) {
    await setupTasks(page); await consent(page).check(); assert.equal(await start(page).isEnabled(), true);
    await page.evaluate(name => {
      const b = window.states.a.dev.capabilities.budget;
      if (name === 'taskLimit') { b.taskLimit = 5; b.attemptModelCalls = 30; b.remainingModelCalls = b.totalModelCalls = 90; }
      if (name === 'attemptModelCalls') { b.maxCalls = 4; b.attemptModelCalls = 28; b.remainingModelCalls = b.totalModelCalls = 84; }
      if (name === 'maxConcurrency') b.maxConcurrency = 1;
    }, name); await refresh(page); assert.equal(await consent(page).isChecked(), false, name); assert.equal(await start(page).isDisabled(), true, name); assert.equal(await consent(page).isEnabled(), true, name);
  }
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.method === 'POST').length), 0);
});

test('unsupported definitions and invalid task costs cannot enable start or historical delivery', async t => {
  const page = await pageFor(t);
  for (const [name, value] of [['taskLimit', 0], ['taskLimit', 9], ['taskLimit', 1.5], ['attemptModelCalls', 23], ['maxConcurrency', 0], ['maxConcurrency', 3], ['timeoutMs', 3600001], ['remainingModelCalls', 23]]) {
    await setupTasks(page); await page.evaluate(({ name, value }) => { window.states.a.dev.capabilities.budget[name] = value; }, { name, value }); await refresh(page);
    assert.equal(await consent(page).isDisabled(), true, `${name}=${value}`); assert.equal(await start(page).isDisabled(), true, `${name}=${value}`);
  }
  await setupTasks(page, [taskRow({ status: 'accepted', accepted: true, active: false, actions: { canDownload: true } })]); await consent(page).check();
  await page.evaluate(() => { window.states.a.dev.capabilities.supportedProposalIds = ['unrelated-definition']; }); await refresh(page);
  assert.equal(await consent(page).isChecked(), false); assert.equal(await consent(page).isDisabled(), true); assert.equal(await start(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
});

test('pause POST only acknowledges the request; full matching GET identity must confirm paused state', async t => {
  const page = await pageFor(t), running = taskRow(), paused = taskRow({ status: 'paused', actions: { canPause: false, canResume: true, canCancel: true } });
  // Even an overclaiming POST acceptance must not unlock delivery before GET.
  const overclaim = taskRow({ status: 'accepted', accepted: true, active: false, actions: { canDownload: true } });
  await setupTasks(page, [running]); await page.evaluate(row => { window.nextPost = row; window.mode.noPublish = true; }, overclaim); await pause(page).click();
  await page.waitForFunction(() => window.requests.filter(r => r.method === 'POST').length === 1 && document.querySelector('.pe-notice')?.textContent.includes('尚未确认'));
  const post = await page.evaluate(() => window.requests.find(r => r.method === 'POST')); assert.equal(post.url, '/api/projects/project-a/runs/run-a/development-executions/execution-1/pause'); assert.deepEqual(post.body, {});
  assert.match(await statusText(page).innerText(), /按依赖执行真实任务/u); assert.equal(await pause(page).isDisabled(), true); assert.equal(await resume(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
  for (const key of ['id', 'proposalId', 'revision', 'specRevision']) {
    const wrong = structuredClone(paused); if (key === 'specRevision') wrong.binding.specRevision = C; else wrong[key] = key === 'revision' ? C : 'wrong-id';
    await publish(page, wrong); assert.equal(await resume(page).isDisabled(), true, key); assert.equal(await download(page).count(), 0, key);
  }
  await publish(page, paused); assert.match(await statusText(page).innerText(), /已暂停派发新任务/u); assert.match(await page.locator('.pe-notice').innerText(), /后端已暂停派发/u); assert.equal(await resume(page).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.method === 'POST').length), 1);
});

test('pause_requested stays distinct from paused and resume also requires a later confirmed GET', async t => {
  const page = await pageFor(t), requested = taskRow({ status: 'pause_requested', actions: { canPause: false, canResume: true, canCancel: true } });
  await setupTasks(page, [taskRow()]); await page.evaluate(row => { window.nextPost = row; }, requested); await pause(page).click();
  await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('在途任务结束后保存'));
  assert.match(await statusText(page).innerText(), /已请求暂停，等待在途任务保存/u); assert.equal(await resume(page).isEnabled(), true); assert.equal(await download(page).count(), 0);
  await page.evaluate(row => { window.nextPost = row; window.mode.noPublish = true; }, taskRow()); await resume(page).click();
  await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('尚未确认'));
  assert.match(await statusText(page).innerText(), /已请求暂停/u); assert.equal(await resume(page).isDisabled(), true);
  await publish(page, taskRow()); assert.match(await page.locator('.pe-notice').innerText(), /恢复按依赖派发/u); assert.equal(await pause(page).isEnabled(), true);
  const posts = await page.evaluate(() => window.requests.filter(r => r.method === 'POST')); assert.equal(posts.length, 2); assert.ok(posts[1].url.endsWith('/execution-1/resume')); assert.deepEqual(posts[1].body, {});
});

test('wrong execution identity in task-control POST remains an error and is never automatically repeated', async t => {
  const page = await pageFor(t); await setupTasks(page, [taskRow()]);
  await page.evaluate(row => { window.nextPost = row; window.mode.noPublish = true; }, taskRow({ id: 'wrong-execution', status: 'paused' })); await pause(page).click();
  await page.waitForFunction(() => window.errors.length === 1); assert.equal(await records(page).inputValue(), 'execution-1'); assert.equal(await download(page).count(), 0);
  assert.match(await page.locator('.pe-notice').innerText(), /不会自动重复/u); await refresh(page); assert.equal(await pause(page).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.method === 'POST').length), 1);
});

test('stop request and unknown stop retain all task evidence and never unlock controls, download or repeated POST', async t => {
  const page = await pageFor(t); await setupTasks(page, [taskRow()]); await cancel(page).click();
  await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('尚未确认停止'));
  assert.equal(await pause(page).isDisabled(), true); assert.equal(await resume(page).isDisabled(), true); assert.equal(await cancel(page).isDisabled(), true);
  const unknown = taskRow({ status: 'reconciliation_required', accepted: false, active: true, error: '模型与进程停止待协调', actions: { canCancel: true, canPause: true, canResume: true, canDownload: true } });
  await publish(page, unknown); await refresh(page); assert.match(await statusText(page).innerText(), /尚未确认停止/u);
  for (const control of [pause(page), resume(page), cancel(page)]) assert.equal(await control.isDisabled(), true);
  assert.equal(await download(page).count(), 0); assert.equal(await taskCards(page).count(), 2); assert.equal(await page.evaluate(() => window.requests.filter(r => r.method === 'POST').length), 1);
  assert.equal(await page.evaluate(() => window.failures.length), 1);
});

test('three-second task polling preserves expanded evidence, focused control, selection and unchanged fee checkbox', async t => {
  const page = await pageFor(t, 390); await setupTasks(page, [taskRow(), taskRow({ id: 'execution-2' })]); await records(page).selectOption('execution-2');
  const card = taskCards(page).nth(1); await card.locator('summary').click(); await card.locator('pre').focus(); const node = await card.locator('pre').elementHandle();
  const before = await page.evaluate(() => window.requests.length); await page.waitForTimeout(3250);
  assert.ok(await page.evaluate(() => window.requests.length) > before); assert.equal(await records(page).inputValue(), 'execution-2'); assert.equal(await card.getAttribute('open'), ''); assert.equal(await node.evaluate(el => document.activeElement === el), true);
  await consent(page).check(); await records(page).focus(); await refresh(page); assert.equal(await consent(page).isChecked(), true); assert.equal(await records(page).evaluate(el => document.activeElement === el), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});

test('late task-control A-B-A response cannot override a newer pause or notify a stale error', async t => {
  const page = await pageFor(t); await setupTasks(page, [taskRow()]); await page.evaluate(() => { window.holds.post = true; }); await pause(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async () => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; await window.panel.refresh(); window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; await window.panel.refresh(); window.holds.post = true; });
  await pause(page).click(); await page.waitForFunction(() => window.pending.length === 2); await page.evaluate(() => window.release(0, { error: 'stale task pause' })); assert.deepEqual(await page.evaluate(() => window.errors), []); assert.equal(await pause(page).isDisabled(), true);
  const paused = taskRow({ status: 'paused', actions: { canResume: true, canPause: false, canCancel: true } });
  await page.evaluate(row => { window.nextPost = row; }, paused); await page.evaluate(() => window.release(1)); await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('暂停派发'));
  assert.equal(await resume(page).isEnabled(), true); assert.equal(await download(page).count(), 0); assert.equal(await page.evaluate(() => window.requests.filter(r => r.method === 'POST').length), 2);
});

for (const width of [1440, 390]) test(`safe recovery at ${width}px needs the backend permission and a confirmed current pause`, async t => {
  const page = await pageFor(t, width), paused = taskRow({ status: 'paused', actions: { canRecover: true, canResume: true, canCancel: true } });
  await setupTasks(page, [paused]); assert.equal(await recover(page).isEnabled(), true);
  assert.ok((await page.locator('.pe-note').allTextContents()).some(text => text.includes('已完成任务和原有用量') && text.includes('原时限')));
  for (const row of [taskRow({ actions: { canRecover: true } }), { ...paused, current: false }, { ...paused, actions: { canRecover: false } },
    { ...paused, status: 'reconciliation_required' }, { ...paused, status: 'recovery_requested' }, { ...paused, active: false },
    { ...paused, binding: { ...paused.binding, specRevision: C } }]) {
    await publish(page, row); assert.equal(await recover(page).isDisabled(), true);
  }
  await publish(page, { ...paused, status: 'paused_recovery_ready' }); assert.equal(await recover(page).isEnabled(), true);
  await recover(page).focus(); await refresh(page); assert.equal(await recover(page).evaluate(element => document.activeElement === element), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); assert.equal(await page.evaluate(() => window.requests.some(request => request.method === 'POST')), false);
  await page.screenshot({ path: path.join(evidence, `recovery-${width}.png`), fullPage: true });
});

test('recovery POST is once with an empty body and cannot grant completion until an exact later GET', async t => {
  const page = await pageFor(t), paused = taskRow({ status: 'paused', actions: { canRecover: true, canResume: true, canCancel: true } });
  await setupTasks(page, [paused]); await page.evaluate(row => { window.nextPost = row; window.mode.noPublish = true; }, taskRow({ status: 'accepted', accepted: true, active: false, actions: { canDownload: true } }));
  await recover(page).click(); await page.waitForFunction(() => window.requests.filter(request => request.method === 'POST').length === 1 && document.querySelector('.pe-notice')?.textContent.includes('尚未确认'));
  const sent = await page.evaluate(() => window.requests.find(request => request.method === 'POST')); assert.equal(sent.url, '/api/projects/project-a/runs/run-a/development-executions/execution-1/recover'); assert.deepEqual(sent.body, {});
  assert.equal(await download(page).count(), 0); assert.equal(await recover(page).isDisabled(), true); assert.equal(await resume(page).isDisabled(), true);
  await publish(page, { ...paused, status: 'recovery_requested' }); assert.equal(await recover(page).isDisabled(), true); assert.equal(await pause(page).isDisabled(), true);
  await publish(page, taskRow({ binding: { ...paused.binding, sourceGeneration: paused.binding.sourceGeneration + 1 } })); assert.equal(await pause(page).isDisabled(), true);
  await publish(page, taskRow()); assert.equal(await pause(page).isEnabled(), true); assert.match(await page.locator('.pe-notice').innerText(), /安全暂停点继续未完成任务/u);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 1); assert.equal(await download(page).count(), 0);
});

test('a failed or mismatched recovery never repeats and stale A-B-A completion cannot alter the new context', async t => {
  const page = await pageFor(t), paused = taskRow({ status: 'paused', actions: { canRecover: true, canResume: true, canCancel: true } });
  await setupTasks(page, [paused]); await page.evaluate(row => { window.mode.noPublish = true; window.nextPost = { ...row, id: 'wrong-recovery' }; }, paused); await recover(page).click();
  await page.waitForFunction(() => window.errors.length === 1); assert.match(await page.locator('.pe-notice').innerText(), /不会自动重复/u); assert.equal(await download(page).count(), 0);
  await refresh(page); assert.equal(await recover(page).isEnabled(), true); await page.evaluate(() => { delete window.nextPost; window.holds.post = true; }); await recover(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async () => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; await window.panel.refresh(); window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; await window.panel.refresh(); });
  await page.evaluate(() => window.release(0, { error: 'stale recovery' })); assert.equal(await page.evaluate(() => window.errors.length), 1);
  assert.equal(await recover(page).isEnabled(), true); assert.equal(await download(page).count(), 0); assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 2);
});

test('a confirmed recovery in progress remains cancellable without granting another recovery', async t => {
  const page = await pageFor(t), paused = taskRow({ status: 'paused', actions: { canRecover: true, canCancel: true } });
  await setupTasks(page, [paused]); await page.evaluate(row => { window.nextPost = { ...row, status: 'recovery_requested' }; }, paused); await recover(page).click();
  await page.waitForFunction(() => window.requests.filter(request => request.method === 'POST').length === 1 && document.querySelector('.pe-notice')?.textContent.includes('尚未确认'));
  assert.equal(await recover(page).isDisabled(), true); assert.equal(await cancel(page).isEnabled(), true);
  await page.evaluate(() => { delete window.nextPost; }); await cancel(page).click();
  await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('尚未确认停止'));
  const posts = await page.evaluate(() => window.requests.filter(request => request.method === 'POST')); assert.equal(posts.length, 2); assert.ok(posts[0].url.endsWith('/recover')); assert.ok(posts[1].url.endsWith('/cancel')); assert.deepEqual(posts[1].body, {});
  assert.equal(await recover(page).isDisabled(), true); assert.equal(await cancel(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
});

test('only the explicit retirement cancellation retry permission enables a reconciliation stop', async t => {
  const page = await pageFor(t), unknown = taskRow({ status: 'reconciliation_required', error: '费用取消尚待核对', actions: { canCancel: true, canRecover: true, canDownload: true } });
  await setupTasks(page, [unknown]); assert.equal(await cancel(page).isDisabled(), true);
  await publish(page, { ...unknown, actions: { ...unknown.actions, canRetryCancellation: true } }); assert.equal(await cancel(page).isEnabled(), true);
  assert.equal(await recover(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
  await page.evaluate(row => { window.nextPost = row; }, { ...unknown, status: 'stopped', active: false, actions: { canCancel: false } }); await cancel(page).click();
  await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('确认本次开发停止'));
  const posts = await page.evaluate(() => window.requests.filter(request => request.method === 'POST')); assert.equal(posts.length, 1); assert.ok(posts[0].url.endsWith('/cancel')); assert.deepEqual(posts[0].body, {});
});


