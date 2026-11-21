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
function fixture() { return { dev: { capabilities: { canStart: true, contractRevision: D, model: { name: 'controlled-fixture-model', reviewName: 'independent-review-model' }, budget: { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000, maxAttempts: 3, totalModelCalls: 0, remainingModelCalls: 18, remainingAttempts: 3 }, reason: null }, executions: [] }, definitions: { coverage: 'structural_only', proposals: [proposal()] } }; }
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
window.revisions=[];
window.panel=createPlannedExecutionPanel({api,getContext:()=>window.ctx,reviseChecklist:id=>window.revisions.push(id),onError:e=>{window.errors.push(e.message);if(window.mode.observerThrow)throw new Error('observer');},onFailure:value=>{window.failures.push(structuredClone(value));if(window.mode.observerReject)return Promise.reject(new Error('observer rejected'));}});
await window.panel.mount(document.querySelector('#panel'));window.ready=true;
</script></body></html>`;
let browser, server, origin;
before(async () => { const module = await readFile(new URL('../public/planned-execution.js', import.meta.url)); server = http.createServer((request, response) => { const js = request.url === '/planned-execution.js' ? module : null; response.writeHead(200, { 'content-type': js ? 'text/javascript' : 'text/html; charset=utf-8' }); response.end(js || harness); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ channel: 'msedge', headless: true }); });
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
const unlimitedBudget = { unlimited: true, maxAttempts: null, remainingAttempts: null, totalModelCalls: null, remainingModelCalls: null };

test('unlimited plans keep per-execution confirmation and accept only the explicit unlimited contract', async t => {
  const page = await pageFor(t);
  await page.evaluate(budget => { Object.assign(window.states.a.dev.capabilities.budget, budget); }, unlimitedBudget);
  await refresh(page);
  assert.equal(await page.getByText(/整份计划可以不限次执行/u).isVisible(), true);
  assert.equal(await start(page).isDisabled(), true);
  await consent(page).check();
  assert.equal(await start(page).isEnabled(), true);
  await page.evaluate(() => { window.states.a.dev.capabilities.budget.remainingAttempts = 0; });
  await refresh(page);
  assert.equal(await consent(page).isDisabled(), true);
  assert.equal(await start(page).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.requests.some(request => request.method === 'POST')), false);
});

test('whole-project and task development allow a one-hour budget and reject larger budgets', async t => {
  const page = await pageFor(t, 390);
  for (const executionBudget of [{}, { taskLimit: 2, maxConcurrency: 2, attemptModelCalls: 12 }]) {
    await page.evaluate(({ executionBudget, unlimitedBudget }) => {
      window.states.a.dev.capabilities.budget = { ...window.initial.dev.capabilities.budget, ...unlimitedBudget, ...executionBudget, timeoutMs: 3600000 };
    }, { executionBudget, unlimitedBudget });
    await refresh(page);
    assert.match(await page.locator('.planned-execution').innerText(), /总时限3600秒/u);
    assert.equal(await start(page).isDisabled(), true);
    await consent(page).check();
    assert.equal(await start(page).isEnabled(), true);

    await page.evaluate(() => { window.states.a.dev.capabilities.budget.timeoutMs += 1; });
    await refresh(page);
    assert.equal(await consent(page).isChecked(), false);
    assert.equal(await consent(page).isDisabled(), true);
    assert.equal(await start(page).isDisabled(), true);
  }
  assert.equal(await page.evaluate(() => window.requests.some(request => request.method === 'POST')), false);
});

test('checklist blocker shows the reason and enables revision while blocking coding retries', async t => {
  const page = await pageFor(t, 390);
  const value = { ...failedRow, failureHelp: { action: 'review_checklist', title: '验收缺少登录步骤',
    detail: '浏览器打开聊天页前，测试没有让该账号登录。', nextStep: '准备清单修订，然后确认新的验收清单。' } };
  await page.evaluate(({ value, budget }) => {
    window.states.a.dev.executions = [value];
    Object.assign(window.states.a.dev.capabilities.budget, budget);
  }, { value, budget: unlimitedBudget });
  await refresh(page);
  const panel = page.locator('.planned-execution');
  await panel.getByText(value.failureHelp.title, { exact: true }).waitFor();
  await panel.getByText(value.failureHelp.detail, { exact: true }).waitFor();
  await panel.getByText(value.failureHelp.nextStep, { exact: true }).waitFor();
  assert.equal(await consent(page).isDisabled(), true);
  assert.equal(await start(page).isDisabled(), true);
  assert.equal(await repair(page).isDisabled(), true);
  await panel.getByRole('button', { name: '准备清单修订', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.revisions), [value.id]);
  assert.equal(await page.evaluate(() => window.requests.some(request => request.method === 'POST')), false);
});

for (const width of [1440, 390]) test(`planned panel ${width}px: cost consent, exact start body, backend facts and text-only evidence`, async t => {
  const page = await pageFor(t, width); assert.equal(await start(page).isDisabled(), true); await consent(page).check(); assert.equal(await start(page).isEnabled(), true); await start(page).click();
  assert.match(await page.locator('.planned-execution').innerText(), /编码模型：controlled-fixture-model；审查模型：independent-review-model/u);
  await page.waitForFunction(() => document.querySelector('.pe-result')?.textContent.includes('尚未获得完整验收'));
  const post = await page.evaluate(() => window.requests.find(r => r.method === 'POST')); assert.equal(post.url, '/api/projects/project-a/runs/run-a/development-executions/start'); assert.deepEqual(post.body, { proposalId: 'proposal-1', revision: A, contractRevision: D });
  assert.equal(await consent(page).isChecked(), false); assert.match(await page.locator('.planned-execution').innerText(), /输入未知/u); assert.equal(await download(page).count(), 0);
  assert.equal(await page.locator('img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.evaluate(value => { window.states.a.dev.executions = [value]; }, acceptedRow); await refresh(page);
  assert.equal(await download(page).isVisible(), true); assert.equal(await download(page).getAttribute('href'), '/api/projects/project-a/runs/run-a/development-executions/execution-1/download'); assert.equal(await page.locator('.pe-result').getAttribute('data-accepted'), 'true');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  const shots = path.resolve('output/planned-panel-author'); await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `panel-${width}.png`), fullPage: true });
});
test('changing contract, model, budget, context or proposal revision withdraws fee consent', async t => {
  const page = await pageFor(t);
  for (const kind of ['contract', 'model', 'review-model', 'budget', 'revision']) {
    await consent(page).check(); await page.evaluate(kind => { if (kind === 'contract') window.states.a.dev.capabilities.contractRevision = 'e'.repeat(64); if (kind === 'model') window.states.a.dev.capabilities.model.name += '-changed'; if (kind === 'review-model') window.states.a.dev.capabilities.model.reviewName += '-changed'; if (kind === 'budget') window.states.a.dev.capabilities.budget.remainingModelCalls--; if (kind === 'revision') window.states.a.definitions.proposals[0].revision = 'f'.repeat(64); }, kind); await refresh(page);
    assert.equal(await consent(page).isChecked(), false); assert.equal(await start(page).isDisabled(), true);
  }
  await consent(page).check(); await page.evaluate(() => { window.ctx.planningStatus = 'unconfirmed'; }); await refresh(page); assert.equal(await consent(page).isChecked(), false); assert.equal(await start(page).isDisabled(), true);
});
test('false coverage, stale or absent joint definitions and historical accepted records cannot authorize actions', async t => {
  const page = await pageFor(t);
  for (const kind of ['false-coverage', 'not-current', 'not-approved', 'no-browser', 'old-binding']) {
    await page.evaluate(kind => { window.states.a = structuredClone(window.initial); const p = window.states.a.definitions.proposals[0]; if (kind === 'false-coverage') p.coverage = 'full'; if (kind === 'not-current') p.current = false; if (kind === 'not-approved') p.approved = false; if (kind === 'no-browser') delete p.proposal.browser; if (kind === 'old-binding') p.binding.specRevision = 'f'.repeat(64); }, kind);
    await refresh(page); assert.equal(await consent(page).isDisabled(), true); assert.equal(await start(page).isDisabled(), true);
  }
  for (const kind of ['accepted-false', 'not-current', 'active', 'diagnostic']) {
    await page.evaluate(({ value, kind }) => { window.states.a = structuredClone(window.initial); if (kind === 'accepted-false') value.accepted = false; if (kind === 'not-current') value.current = false; if (kind === 'active') value.active = true; if (kind === 'diagnostic') value.status = 'diagnostic_passed'; window.states.a.dev.executions = [value]; }, { value: acceptedRow, kind });
    await refresh(page); assert.equal(await download(page).count(), 0); assert.equal(await page.locator('.pe-result').getAttribute('data-accepted'), 'false');
  }
});
test('POST accepted response cannot grant download before a later matching GET, and missing GET record stays unconfirmed', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.nextPost = value; window.mode.noPublish = true; }, acceptedRow); await consent(page).check(); await start(page).click();
  await page.waitForFunction(() => window.requests.filter(r => r.method === 'GET' && r.url.endsWith('/development-executions')).length >= 2);
  assert.equal(await download(page).count(), 0); assert.equal(await start(page).isDisabled(), true); assert.match(await page.locator('.pe-notice').innerText(), /尚未确认/u);
  await page.evaluate(value => { window.states.a.dev.executions = [value]; }, acceptedRow); await refresh(page); assert.equal(await download(page).isVisible(), true);
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.method === 'POST').length), 1);
});
test('cancel request, pending backend read, confirmed stop and unknown process remain distinct', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value]; }, execution()); await refresh(page); await cancel(page).click();
  await page.waitForFunction(() => document.querySelector('.pe-status')?.textContent.includes('等待确认') || document.querySelector('.pe-body')?.textContent.includes('已请求停止，等待确认'));
  assert.equal(await cancel(page).isDisabled(), true); assert.match(await page.locator('.pe-notice').innerText(), /尚未确认停止/u);
  await page.evaluate(() => { window.states.a.dev.executions[0].status = 'stopped'; window.states.a.dev.executions[0].active = false; }); await refresh(page); assert.match(await page.locator('.planned-execution').innerText(), /已确认停止/u); assert.equal(await download(page).count(), 0);
  await page.evaluate(() => { window.states.a.dev.executions[0].status = 'reconciliation_required'; window.states.a.dev.executions[0].active = true; }); await refresh(page); assert.match(await page.locator('.planned-execution').innerText(), /尚未确认停止/u);
});
test('three-second polling preserves focused selection and fee consent when the contract does not change', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value, { ...structuredClone(value), id: 'execution-2' }]; }, execution()); await refresh(page);
  await records(page).selectOption('execution-2'); await consent(page).check(); await records(page).focus(); const before = await page.evaluate(() => window.requests.length); await page.waitForTimeout(3300);
  assert.ok(await page.evaluate(() => window.requests.length) > before); assert.equal(await records(page).inputValue(), 'execution-2'); assert.equal(await records(page).evaluate(node => node === document.activeElement), true); assert.equal(await consent(page).isChecked(), true);
});
test('late A-B-A GET and POST results cannot replace selection, unlock newer requests or notify a stale failure', async t => {
  const page = await pageFor(t); await page.evaluate(() => { window.holds.dev = true; window.oldRead = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async () => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; await window.panel.refresh(); window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; await window.panel.refresh(); });
  await consent(page).check(); await page.evaluate(() => { window.holds.post = true; }); await start(page).click(); await page.waitForFunction(() => window.pending.length === 2);
  await page.evaluate(() => window.release(0, { error: 'old GET failure' })); assert.equal(await start(page).isDisabled(), true); assert.deepEqual(await page.evaluate(() => window.errors), []);
  await page.evaluate(async () => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; await window.panel.refresh(); window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; await window.panel.refresh(); });
  await consent(page).check(); await page.evaluate(() => { window.holds.post = true; }); await start(page).click(); await page.waitForFunction(() => window.pending.length === 3);
  await page.evaluate(() => window.release(1, { error: 'old POST failure' })); assert.deepEqual(await page.evaluate(() => window.errors), []); assert.equal(await start(page).isDisabled(), true);
  await page.evaluate(() => window.release(2)); await page.waitForFunction(() => document.querySelector('.pe-result')?.textContent.includes('尚未获得完整验收'));
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.method === 'POST').length), 2); assert.deepEqual(await page.evaluate(() => window.failures), []);
});
test('current real terminal failures notify once while observer failures, action errors and destroy cannot grant completion', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value]; window.mode.observerReject = true; }, execution({ status: 'failed', active: false, error: marker }));
  await refresh(page); await refresh(page); assert.equal(await page.evaluate(() => window.failures.length), 1); assert.deepEqual(await page.evaluate(() => window.failures[0].context), { projectId: 'project-a', runId: 'run-a' });
  await page.evaluate(() => { window.mode.postError = true; window.mode.observerThrow = true; }); await consent(page).check(); await start(page).click(); await page.waitForFunction(() => window.errors.length === 1); assert.equal(await download(page).count(), 0); assert.equal(await consent(page).isChecked(), false);
  await page.evaluate(() => { window.holds.dev = true; window.held = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1); const before = await page.evaluate(() => window.requests.length);
  await page.evaluate(() => window.panel.destroy()); await page.evaluate(() => window.release(0, { error: 'destroyed read failure' })); await page.waitForTimeout(3300);
  assert.equal(await page.locator('.planned-execution').count(), 0); assert.equal(await page.evaluate(() => window.errors.length), 1); assert.equal(await page.evaluate(() => window.requests.length), before);
});
test('duplicate records and invalid fee budgets revoke permission without sending any start request', async t => {
  const page = await pageFor(t);
  for (const field of ['duplicate', 'attempts', 'calls', 'contract', 'model']) {
    await page.evaluate(field => { window.states.a = structuredClone(window.initial); const cap = window.states.a.dev.capabilities;
      if (field === 'duplicate') window.states.a.definitions.proposals.push(structuredClone(window.states.a.definitions.proposals[0]));
      if (field === 'attempts') cap.budget.remainingAttempts = 0; if (field === 'calls') cap.budget.remainingModelCalls = null; if (field === 'contract') cap.contractRevision = 'invalid'; if (field === 'model') cap.model.name = '';
    }, field); await refresh(page); assert.equal(await consent(page).isDisabled(), true); assert.equal(await start(page).isDisabled(), true);
  }
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 0);
});
test('a failed confirmation GET cannot reuse the accepted POST or automatically repeat a paid action', async t => {
  const page = await pageFor(t); await consent(page).check(); await page.evaluate(value => { window.nextPost = value; window.mode.getError = true; }, acceptedRow); await start(page).click();
  await page.waitForFunction(() => window.errors.length > 0); assert.equal(await download(page).count(), 0); assert.equal(await start(page).isDisabled(), true);
  await page.evaluate(() => { window.mode.getError = false; }); await refresh(page); assert.equal(await download(page).isVisible(), true);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 1);
});
test('a download click rechecks the live context before following the old link', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value]; }, acceptedRow); await refresh(page); assert.equal(await download(page).isVisible(), true);
  const requests = []; page.on('request', request => { if (request.url().includes('/download')) requests.push(request.url()); });
  await page.evaluate(() => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; }); await download(page).click();
  assert.deepEqual(requests, []); assert.equal(page.url(), `${origin}/`); assert.equal(await download(page).count(), 0);
});
test('late start confirmation preserves an execution selection changed by the reader', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value, { ...structuredClone(value), id: 'execution-2' }]; window.mode.noPublish = true; }, execution()); await refresh(page);
  await consent(page).check(); await start(page).click(); await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('尚未确认'));
  await records(page).selectOption('execution-2');
  await page.evaluate(value => { window.states.a.dev.executions.unshift({ ...value, id: 'new-1', status: 'preparing' }); }, execution()); await refresh(page);
  assert.equal(await records(page).inputValue(), 'execution-2'); assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 1);
});
test('older failed attempts do not notify over the selected accepted result', async t => {
  const page = await pageFor(t); await page.evaluate(({ accepted, failed }) => { window.states.a.dev.executions = [accepted, failed]; }, { accepted: acceptedRow, failed: execution({ id: 'older-failed', status: 'failed', active: false, error: '历史失败记录' }) }); await refresh(page);
  assert.equal(await download(page).isVisible(), true); assert.deepEqual(await page.evaluate(() => window.failures), []);
  await records(page).selectOption('older-failed'); assert.equal(await page.evaluate(() => window.failures.length), 1); assert.equal(await download(page).count(), 0);
});

for (const width of [1440, 390]) test(`paid repair ${width}px requires consent, exact contract and a newly confirmed execution`, async t => {
  const page = await pageFor(t, width);
  await page.evaluate(value => { window.states.a.dev.executions = [value]; window.mode.noPublish = true; window.nextPost = { ...structuredClone(value), id: 'repair-new', status: 'accepted', accepted: true, actions: { canDownload: true } }; }, failedRow);
  await refresh(page); assert.equal(await repair(page).isDisabled(), true); await consent(page).check(); assert.equal(await repair(page).isEnabled(), true);
  const note = '登录完成前，检查公共页面是否提前发起会话请求。';
  if (width === 390) {
    const field = page.getByRole('textbox', { name: '修复说明（选填）' });
    await field.fill(note);
    assert.equal(await consent(page).isChecked(), false);
    assert.equal(await repair(page).isDisabled(), true);
    await page.evaluate(() => window.panel.refresh());
    assert.equal(await field.inputValue(), note);
    assert.equal(await field.evaluate(element => document.activeElement === element), true);
    await consent(page).check();
  }
  await repair(page).click();
  await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('尚未确认'));
  const post = await page.evaluate(() => window.requests.find(request => request.method === 'POST'));
  assert.equal(post.url, '/api/projects/project-a/runs/run-a/development-executions/execution-1/repair');
  assert.deepEqual(post.body, { contractRevision: D, ...(width === 390 ? { repairNote: note } : {}) });
  assert.equal(await consent(page).isChecked(), false); assert.equal(await repair(page).isDisabled(), true); assert.equal(await download(page).count(), 0); assert.equal(await page.locator('.pe-result').getAttribute('data-accepted'), 'false');
  const newExecution = execution({ id: 'repair-new', status: 'preparing', accepted: false });
  await page.evaluate(value => { window.states.a.dev.executions.unshift(value); }, newExecution); await refresh(page);
  assert.equal(await records(page).inputValue(), 'repair-new'); assert.equal(await download(page).count(), 0); assert.match(await page.locator('.pe-notice').innerText(), /重新独立验收/u);
  await records(page).selectOption('execution-1'); assert.match(await page.locator('.pe-error').last().innerText(), /原候选仍有阻塞问题/u); assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});
test('repair cannot use historical acceptance, unknown stop, missing authority, a stale definition or exhausted budget', async t => {
  const page = await pageFor(t);
  for (const kind of ['no-authority', 'active', 'stale', 'unknown', 'accepted-history', 'invalid-commit', 'no-definition', 'wrong-revision', 'attempt-budget', 'call-budget', 'backend-disabled']) {
    await page.evaluate(({ value, kind }) => {
      window.states.a = structuredClone(window.initial); window.states.a.dev.executions = [value]; const row = window.states.a.dev.executions[0];
      if (kind === 'no-authority') row.actions.canRepair = false; if (kind === 'active') row.active = true; if (kind === 'stale') row.current = false;
      if (kind === 'unknown') row.status = 'reconciliation_required'; if (kind === 'accepted-history') { row.status = 'accepted'; row.accepted = false; }
      if (kind === 'invalid-commit') row.candidateCommit = 'none'; if (kind === 'no-definition') window.states.a.definitions.proposals = [];
      if (kind === 'wrong-revision') row.revision = 'f'.repeat(64); if (kind === 'attempt-budget') window.states.a.dev.capabilities.budget.remainingAttempts = 0;
      if (kind === 'call-budget') window.states.a.dev.capabilities.budget.remainingModelCalls = 5; if (kind === 'backend-disabled') window.states.a.dev.capabilities.canStart = false;
    }, { value: failedRow, kind });
    await refresh(page); if (await consent(page).isEnabled()) await consent(page).check(); assert.equal(await repair(page).isDisabled(), true, kind); assert.equal(await download(page).count(), 0);
  }
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 0);
});
test('switching the selected repair candidate or its commit withdraws the fee agreement', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value, { ...structuredClone(value), id: 'execution-2' }]; }, failedRow); await refresh(page);
  const note = page.getByRole('textbox', { name: '修复说明（选填）' });
  await note.fill('仅适用于所选候选。');
  await consent(page).check(); assert.equal(await repair(page).isEnabled(), true); await records(page).selectOption('execution-2'); assert.equal(await consent(page).isChecked(), false); assert.equal(await repair(page).isDisabled(), true);
  assert.equal(await note.inputValue(), '');
  await note.fill('仅适用于当前提交。');
  await consent(page).check(); await page.evaluate(() => { window.states.a.dev.executions[1].candidateCommit = '0'.repeat(40); }); await refresh(page); assert.equal(await consent(page).isChecked(), false); assert.equal(await repair(page).isDisabled(), true);
  assert.equal(await note.inputValue(), '');
});
test('a repair POST with the original id is unconfirmed and never causes a repeated paid request', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value]; window.nextPost = value; }, failedRow); await refresh(page);
  await consent(page).check(); await repair(page).click(); await page.waitForFunction(() => window.errors.length === 1); assert.equal(await download(page).count(), 0); assert.equal(await consent(page).isChecked(), false);
  await refresh(page); assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 1); assert.equal(await repair(page).isDisabled(), true);
});
test('repair GET must confirm the same new id, proposal and revision, and cannot steal a later record selection', async t => {
  const page = await pageFor(t); const newRow = execution({ id: 'repair-new', status: 'preparing' });
  await page.evaluate(({ failed, next }) => { window.states.a.dev.executions = [failed, { ...structuredClone(failed), id: 'execution-2' }]; window.nextPost = next; window.mode.noPublish = true; }, { failed: failedRow, next: newRow }); await refresh(page);
  await consent(page).check(); await repair(page).click(); await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('尚未确认'));
  await records(page).selectOption('execution-2');
  for (const field of ['proposalId', 'revision']) {
    await page.evaluate(({ value, field }) => { value[field] = field === 'proposalId' ? 'other-proposal' : 'f'.repeat(64); window.states.a.dev.executions = [value, ...window.states.a.dev.executions.filter(row => row.id !== value.id)]; }, { value: newRow, field }); await refresh(page);
    assert.equal(await records(page).inputValue(), 'execution-2'); assert.equal(await start(page).isDisabled(), true); assert.equal(await repair(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
  }
  await page.evaluate(value => { window.states.a.dev.executions[0] = value; }, newRow); await refresh(page); assert.equal(await records(page).inputValue(), 'execution-2'); assert.match(await page.locator('.pe-notice').innerText(), /新的修复执行/u);
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 1);
});
test('a late repair response after A-B-A cannot disturb a newer paid repair or grant acceptance', async t => {
  const page = await pageFor(t); await page.evaluate(value => { window.states.a.dev.executions = [value]; window.holds.post = true; }, failedRow); await refresh(page);
  await consent(page).check(); await repair(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async () => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; await window.panel.refresh(); window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; await window.panel.refresh(); window.holds.post = true; });
  await consent(page).check(); await repair(page).click(); await page.waitForFunction(() => window.pending.length === 2);
  await page.evaluate(() => window.release(0, { error: 'old repair error' })); assert.deepEqual(await page.evaluate(() => window.errors), []); assert.equal(await repair(page).isDisabled(), true);
  await page.evaluate(() => window.release(1)); await page.waitForFunction(() => document.querySelector('.pe-notice')?.textContent.includes('新的修复执行'));
  assert.equal(await download(page).count(), 0); assert.equal(await page.locator('.pe-result').getAttribute('data-accepted'), 'false'); assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === 'POST').length), 2);
});

test('review detail keeps the original commit and resolved issue history readable on desktop and narrow screens', async t => {
  for (const width of [1280, 390]) {
    const page = await pageFor(t, width);
    const original = { id: 'ISSUE-fifo', severity: 'blocking', status: 'open', file: 'src/promote.mjs', line: 3,
      message: marker, evidence: 'const head = queued.find(byId);' };
    const history = [
      { candidateCommit: '1'.repeat(40), sourceHash: A, status: 'completed', issues: [original], resolutions: [] },
      { candidateCommit: '2'.repeat(40), sourceHash: B, status: 'completed', issues: [{ ...original, status: 'resolved' }],
        resolutions: [{ id: original.id, status: 'resolved', reason: 'sequence 最小的 queued 项才是队首' }] },
    ];
    await page.evaluate(({ value, history }) => { window.states.a.dev.executions = [{ ...value, reviewHistory: history }]; }, { value: failedRow, history });
    await refresh(page);
    const detail = page.locator('details').filter({ has: page.getByText('Review与阻塞问题', { exact: true }) });
    await detail.locator('summary').click();
    const rendered = JSON.parse(await detail.locator('pre').textContent());
    assert.deepEqual(rendered.history, history);
    assert.equal(await detail.locator('img, script').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await download(page).count(), 0);
    await refresh(page);
    assert.equal(await detail.getAttribute('open'), '');
    assert.deepEqual(JSON.parse(await detail.locator('pre').textContent()).history, history);
  }
});

test('role progress follows the selected candidate and opens its evidence with the keyboard', async t => {
  for (const width of [1440, 390]) {
    const page = await pageFor(t, width);
    const commit = '1'.repeat(40);
    const current = execution({ status: 'validating', candidateCommit: commit,
      checks: { http: [{ passed: true }], browser: [{ passed: true }] },
      workflow: { stage: 'review' },
      reviewHistory: [{ attempt: 1, candidateCommit: commit, status: 'not_started' }] });
    const previous = execution({ id: 'older-run', status: 'failed', active: false, current: false,
      candidateCommit: '9'.repeat(40), checks: { browser: [{ passed: false }] } });
    await page.evaluate(rows => { window.states.a.dev.executions = rows; }, [current, previous]);
    await refresh(page);
    await records(page).selectOption(current.id);
    const monitor = page.getByRole('region', { name: '执行角色进度' });
    const role = name => monitor.locator('[data-role="' + name + '"]');
    await monitor.getByText('正在审查', { exact: true }).waitFor();
    assert.equal(await role('testing').getAttribute('data-state'), 'done');
    assert.equal(await monitor.locator('.pe-role-context').getAttribute('title'), commit);
    const action = monitor.getByRole('button', { name: '查看审查记录', exact: true });
    const reviewDetail = page.locator('details').filter({ has: page.getByText('Review与阻塞问题', { exact: true }) });
    await action.focus();
    await refresh(page);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '查看审查记录');
    await action.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Review与阻塞问题');
    assert.equal(await page.evaluate(() => document.activeElement.parentElement.open), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

    await reviewDetail.locator('summary').click();
    assert.equal(await reviewDetail.getAttribute('open'), null);
    await action.focus();
    await page.evaluate(id => {
      const row = window.states.a.dev.executions.find(execution => execution.id === id);
      row.status = 'generating';
      row.events.push({ type: 'coding_round', round: 2 });
    }, current.id);
    await refresh(page);
    assert.equal(await role('coding').getAttribute('data-state'), 'running');
    assert.equal(await role('testing').getAttribute('data-state'), 'waiting');
    assert.equal(await action.isDisabled(), true);
    assert.equal(await monitor.locator('.pe-role-context').getAttribute('title'), '');
    assert.equal(await action.evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Enter');
    assert.equal(await reviewDetail.getAttribute('open'), null);
    const testsDetail = page.locator('details').filter({ has: page.getByText('自检、HTTP与浏览器实际检查', { exact: true }) });
    for (const detail of [testsDetail, reviewDetail]) {
      const previousEvidence = JSON.parse(await detail.locator('pre').textContent());
      assert.equal(previousEvidence.candidateCommit, null);
      assert.equal(previousEvidence.lastFixedCandidateCommit, commit);
    }

    await records(page).selectOption(previous.id);
    await monitor.getByText(/历史运行/u).waitFor();
    assert.equal(await role('testing').getAttribute('data-state'), 'failed');
    assert.equal(await action.isDisabled(), true);
  }
});

test('test evidence includes errors for the selected candidate even without completed checks', async t => {
  const page = await pageFor(t);
  const commit = '2'.repeat(40);
  const oldError = { role: 'test', code: 'earlier_attempt', terminationConfirmed: true };
  const browserError = { role: 'browser', code: 'verification_failed', terminationConfirmed: true };
  const reviewError = { role: 'review', code: 'invalid_model_response', terminationConfirmed: true };
  const current = execution({
    status: 'validating', candidateCommit: commit,
    checks: { http: [], browser: [] }, workflow: { stage: 'testing' },
    reviewHistory: [
      { attempt: 1, candidateCommit: '1'.repeat(40), status: 'not_started', errors: [oldError] },
      { attempt: 2, candidateCommit: commit, status: 'not_started', errors: [browserError, reviewError] },
    ],
  });
  await page.evaluate(row => { window.states.a.dev.executions = [row]; }, current);
  await refresh(page);

  const monitor = page.getByRole('region', { name: '执行角色进度' });
  assert.equal(await monitor.locator('[data-role="testing"]').getAttribute('data-state'), 'incomplete');
  const button = monitor.getByRole('button', { name: '查看测试结果', exact: true });
  assert.equal(await button.isEnabled(), true);
  await button.click();

  const detail = page.locator('details').filter({ has: page.getByText('自检、HTTP与浏览器实际检查', { exact: true }) });
  assert.equal(await detail.getAttribute('open'), '');
  const evidence = JSON.parse(await detail.locator('pre').textContent());
  assert.equal(evidence.candidateCommit, commit);
  assert.deepEqual(evidence.http, []);
  assert.deepEqual(evidence.browser, []);
  assert.deepEqual(evidence.errors, [browserError]);
});
