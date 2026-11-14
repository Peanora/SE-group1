import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64), d = 'd'.repeat(64);
const marker = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
const context = { projectId: 'project-a', runId: 'run-a', specRevision: a, planRevision: b, planningStatus: 'confirmed' };
const definition = { version: 1, id: 'http-checks', name: 'HTTP结构检查', sessions: [], steps: [], limits: {} };
function row(overrides = {}) { return { id: 'proposal-1', projectId: 'project-a', runId: 'run-a', attempt: 1, status: 'draft', current: true,
  coverage: 'structural_only', executed: false, approved: false, notice: '仅测试定义与人工审阅，尚未执行测试或证明软件通过。',
  binding: { projectId: 'project-a', runId: 'run-a', specRevision: a, planRevision: b, sourceRevision: c, sourceGeneration: 1, engineeringHash: c, contextHash: c, policyHash: d },
  revision: a, proposal: definition, manifestHash: b, policyHash: d, approval: null, history: [], model: 'fixture-model', usage: { inputTokens: null, outputTokens: null },
  finishReason: null, dispatched: true, receiptState: 'saved', receipt: { sha256: c, bytes: 123 }, error: null, errorCode: null, startedAt: '2026-11-14T00:00:00Z', finishedAt: '2026-11-14T00:00:01Z',
  actions: { canCancel: false, canRevise: true, canApprove: true, canReject: true }, ...overrides }; }
function fixture() { return { coverage: 'structural_only', capabilities: { canPropose: true, contractRevision: d, budget: { maxAttempts: 3, remainingAttempts: 2, timeoutMs: 60000 }, model: 'fixture-model', reason: null }, proposals: [row()] }; }
const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><main style="max-width:1100px;margin:auto"><div id="panel"></div></main><script type="module">
import {createVerificationPlans} from '/verification-plans.js';
window.ctx=${JSON.stringify(context)};window.initial=${JSON.stringify(fixture())};window.states={a:structuredClone(window.initial),b:structuredClone(window.initial)};
for(const r of window.states.b.proposals){r.projectId='project-b';r.runId='run-b';r.binding.projectId='project-b';r.binding.runId='run-b';}
window.requests=[];window.errors=[];window.holds={};window.pending=[];window.mode={};window.counter=1;
const stateKey=url=>decodeURIComponent(url.split('/')[3])==='project-b'||decodeURIComponent(url.split('/')[5])==='run-b'?'b':'a';
window.release=async(index,opts={})=>{const p=window.pending[index];if(opts.error){p.reject(Object.assign(new Error(opts.error),{status:opts.status}));return;}try{p.resolve(opts.response??await p.execute());}catch(e){p.reject(e);}};
const api=(url,options={})=>{
 const method=options.method||'GET',key=stateKey(url),body=options.body?JSON.parse(options.body):null,snapshot=structuredClone(window.states[key]);window.requests.push({url,method,body});
 const execute=async()=>{
  if(method==='GET'){if(window.mode.getStatus)throw Object.assign(new Error('读取测试提案失败'),{status:window.mode.getStatus});return snapshot;}
  if(window.mode.postStatus)throw Object.assign(new Error('提案操作失败，编辑内容保留'),{status:window.mode.postStatus});
  const state=window.states[key],action=url.split('/').at(-1),id=decodeURIComponent(url.split('/').at(-2));let target;
  if(action==='propose'){
   target=structuredClone(state.proposals[0]??window.initial.proposals[0]);target.id='proposal-'+(++window.counter);Object.assign(target,{status:'generating',proposal:null,revision:null,approved:false,attempt:window.counter,history:[],actions:{canCancel:true,canRevise:false,canApprove:false,canReject:false}});
   state.proposals.push(target);state.capabilities.budget.remainingAttempts--;state.capabilities.canPropose=false;
  }else{
   target=state.proposals.find(x=>x.id===id);if(action==='cancel'){target.status=window.mode.cancelState||'cancel_requested';target.actions.canCancel=false;}
   else if(action==='revise'){target.history.push({revision:target.revision,manifestHash:target.manifestHash,status:'revised',feedback:body.feedback,at:'now'});target.revision='${c}';target.proposal=body.proposal;target.status='draft';target.approved=false;target.approval=null;}
   else if(action==='approve'){target.status='approved';target.approved=true;target.approval={id:'approval-1',revision:target.revision,approvedAt:'now',feedback:body.feedback,phase:'definition_only',coverage:'structural_only'};target.history.push({revision:target.revision,status:'approve',feedback:body.feedback,at:'now'});target.actions.canApprove=false;}
   else if(action==='reject'){target.status='rejected';target.approved=false;target.history.push({revision:target.revision,status:'reject',feedback:body.feedback,at:'now'});target.actions.canApprove=false;target.actions.canReject=false;}
  }
  if(window.mode.holdConfirmation)window.holds['GET:'+key]=1;
  if(window.mode.postThenFail)throw Object.assign(new Error('连接中断，操作结果未知'),{status:503});
  return {proposal:structuredClone(target)};
 };
 const hold=method+':'+key;if(window.holds[hold]){window.holds[hold]--;return new Promise((resolve,reject)=>window.pending.push({url,method,body,execute,resolve,reject}));}return execute();
};
window.panel=createVerificationPlans({api,getContext:()=>window.ctx,onError:e=>window.errors.push(e.message)});
await window.panel.mount(document.querySelector('#panel'));window.ready=true;
</script></body></html>`;
let browser, server, address;
before(async () => {
  const module = await readFile(new URL('../public/verification-plans.js', import.meta.url));
  server = http.createServer((req, res) => { if (req.url === '/verification-plans.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(module); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(harness); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); address = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function pageFor(t, viewport = { width: 1440, height: 1000 }) {
  const page = await browser.newPage({ viewport }), errors = [];
  page.on('pageerror', value => errors.push(value.message)); page.on('console', value => { if (value.type() === 'error') errors.push(value.text()); });
  t.after(async () => { assert.deepEqual(errors, [], 'real browser must have no script/console errors'); await page.close(); });
  await page.goto(address); await page.waitForFunction(() => window.ready); return page;
}
const json = page => page.getByLabel('HTTP测试定义 JSON', { exact: true });
const feedback = page => page.getByLabel('修订或审阅依据（必填，最多5000字）', { exact: true });
const select = page => page.getByLabel('测试提案记录', { exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const propose = page => button(page, '生成独立测试提案');
const revise = page => button(page, '保存提案修订');
const approve = page => button(page, '认可测试定义（尚未运行）');
const reject = page => button(page, '驳回测试定义');
const consent = page => page.getByRole('checkbox');
const refresh = page => page.evaluate(() => window.panel.refresh());
async function settle(page) { await page.waitForFunction(() => document.querySelector('.verification-plans select')?.disabled === false); }

test('model proposal requires exact current consent and budget, sends only contractRevision, and never means software passed', async t => {
  const page = await pageFor(t); assert.equal(await propose(page).isDisabled(), true); await consent(page).check(); assert.equal(await propose(page).isEnabled(), true);
  await propose(page).click(); await page.waitForFunction(() => document.querySelector('select').value === 'proposal-2');
  const request = await page.evaluate(() => window.requests.find(x => x.method === 'POST'));
  assert.equal(request.url, '/api/projects/project-a/runs/run-a/verification-plans/propose'); assert.deepEqual(request.body, { contractRevision: d });
  assert.match(await page.locator('.verification-plans').innerText(), /尚未运行/); assert.match(await page.locator('.verification-plans').innerText(), /输入 未知 \/ 输出 未知/);
  assert.equal(await page.locator('a').count(), 0); assert.equal(await consent(page).isChecked(), false); assert.equal(await approve(page).isDisabled(), true);
});

test('invalid cost fields, approval status, contract/model/budget changes and backend refusal withdraw paid permission', async t => {
  const page = await pageFor(t);
  for (const change of [cap => cap.canPropose = false, cap => cap.contractRevision = 'bad', cap => cap.model = null, cap => cap.budget.remainingAttempts = null, cap => cap.budget.timeoutMs = 60001, cap => cap.budget.maxAttempts = 0]) {
    await page.evaluate(change => { window.states.a = structuredClone(window.initial); (0,eval)('('+change+')')(window.states.a.capabilities); }, change.toString()); await refresh(page);
    assert.equal(await consent(page).isDisabled(), true); assert.equal(await propose(page).isDisabled(), true);
  }
  await page.evaluate(() => { window.states.a = structuredClone(window.initial); }); await refresh(page); await consent(page).check();
  for (const field of ['contract', 'model', 'budget']) {
    await page.evaluate(field => { const cap = window.states.a.capabilities; if (field === 'contract') cap.contractRevision = 'e'.repeat(64); if (field === 'model') cap.model += '-changed'; if (field === 'budget') cap.budget.remainingAttempts = 1; }, field);
    await refresh(page); assert.equal(await consent(page).isChecked(), false); await consent(page).check();
  }
  await page.evaluate(() => { window.ctx.planningStatus = 'awaiting_review'; }); await refresh(page); assert.equal(await propose(page).isDisabled(), true); assert.equal(await consent(page).isChecked(), false);
});

test('save and approve are separate exact revision operations; approve is definition-only with no preview, download or passed badge', async t => {
  const page = await pageFor(t), edited = { ...definition, name: '修订后的HTTP定义' }; await json(page).fill(JSON.stringify(edited)); await feedback(page).fill('补充边界检查');
  assert.equal(await approve(page).isDisabled(), true); await revise(page).click(); await settle(page);
  let requests = await page.evaluate(() => window.requests.filter(x => x.method === 'POST')); assert.deepEqual(requests[0].body, { revision: a, proposal: edited, feedback: '补充边界检查' });
  assert.equal(await page.evaluate(() => window.states.a.proposals[0].approved), false); assert.match(await page.locator('.verification-plans').innerText(), /已保存提案修订，尚未认可或运行/);
  assert.equal(await approve(page).isEnabled(), true); await approve(page).click(); await settle(page);
  requests = await page.evaluate(() => window.requests.filter(x => x.method === 'POST')); assert.deepEqual(requests[1].body, { revision: c, feedback: '补充边界检查' });
  assert.match(await page.locator('.verification-plans').innerText(), /已认可当前测试定义，尚未运行测试，不代表软件通过/);
  assert.equal(await page.locator('a,[class*="success"],[class*="passed"]').count(), 0);
});

test('reject has exact revision/feedback and no automatic rewrite or model request', async t => {
  const page = await pageFor(t); await feedback(page).fill('缺少权限异常定义'); await reject(page).click(); await settle(page);
  const request = await page.evaluate(() => window.requests.filter(x => x.method === 'POST'));
  assert.equal(request.length, 1); assert.deepEqual(request[0].body, { revision: a, feedback: '缺少权限异常定义' }); assert.match(request[0].url, /\/proposal-1\/reject$/);
  assert.equal(await json(page).inputValue(), JSON.stringify(definition, null, 2)); assert.equal(await approve(page).isDisabled(), true);
});

test('current binding, policy, revision and action fields all gate definition changes while invalid JSON stays in the editor', async t => {
  const page = await pageFor(t); await feedback(page).fill('审阅依据');
  for (const change of [row => row.current = false, row => row.binding.specRevision = 'f'.repeat(64), row => row.binding.planRevision = 'f'.repeat(64), row => row.binding.policyHash = 'f'.repeat(64), row => row.binding.sourceGeneration = null, row => row.revision = null, row => row.actions.canApprove = false]) {
    await page.evaluate(change => { window.states.a = structuredClone(window.initial); (0,eval)('('+change+')')(window.states.a.proposals[0]); }, change.toString()); await refresh(page); assert.equal(await approve(page).isDisabled(), true);
  }
  await page.evaluate(() => { window.states.a = structuredClone(window.initial); }); await refresh(page); await json(page).fill('{broken'); await revise(page).click();
  assert.match(await page.getByRole('alert').innerText(), /JSON格式无效/); assert.equal(await json(page).inputValue(), '{broken'); assert.equal(await page.evaluate(() => window.requests.filter(x => x.method === 'POST').length), 0);
});

test('polling preserves focus, selection, feedback, details and text-only unsafe content on desktop and 390px', async t => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await pageFor(t, viewport); await page.evaluate(marker => { const row = window.states.a.proposals[0]; row.notice = marker; row.error = marker; row.history = [{ revision: row.revision, status: 'reject', feedback: marker, at: marker }]; row.proposal.name = marker; }, marker); await refresh(page);
    await page.locator('summary').first().click(); await page.locator('summary').last().click(); await json(page).fill(marker); await feedback(page).fill(marker); await json(page).focus();
    await json(page).evaluate(el => el.setSelectionRange(2, 8)); await page.waitForTimeout(3200);
    assert.equal(await json(page).inputValue(), marker); assert.equal(await feedback(page).inputValue(), marker);
    assert.deepEqual(await json(page).evaluate(el => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd })), { focused: true, start: 2, end: 8 });
    assert.equal(await page.locator('details[open]').count(), 2); assert.equal(await page.locator('.verification-plans img,.verification-plans script').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
});

test('new server revision preserves typed old draft but disables stale save and approval until explicit current load', async t => {
  const page = await pageFor(t); await json(page).fill('old typed draft'); await feedback(page).fill('old feedback');
  await page.evaluate(c => { window.states.a.proposals[0].revision = c; window.states.a.proposals[0].proposal.name = 'server current'; }, c); await refresh(page);
  assert.equal(await json(page).inputValue(), 'old typed draft'); assert.equal(await revise(page).isDisabled(), true); assert.equal(await approve(page).isDisabled(), true); assert.match(await page.locator('.verification-plans').innerText(), /旧编辑内容已保留/);
  await button(page, '载入当前提案版本').click(); assert.equal(JSON.parse(await json(page).inputValue()).name, 'server current'); assert.equal(await feedback(page).inputValue(), '');
  await feedback(page).fill('current feedback'); assert.equal(await approve(page).isEnabled(), true);
  await json(page).focus(); await json(page).evaluate(el => el.setSelectionRange(2, 8)); const loaded = await json(page).inputValue();
  await page.evaluate(() => { window.states.a.proposals[0].revision = 'e'.repeat(64); window.states.a.proposals[0].proposal.name = 'another external version'; }); await refresh(page);
  assert.equal(await json(page).inputValue(), loaded); assert.deepEqual(await json(page).evaluate(el => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd })), { focused: true, start: 2, end: 8 });
  assert.equal(await approve(page).isDisabled(), true);
});

test('draft sessions isolate project/run/revision and survive reload without approving saved browser text', async t => {
  const page = await pageFor(t); await json(page).fill('session A edit'); await feedback(page).fill('session A reason');
  await page.evaluate(() => { window.ctx = { ...window.ctx, projectId: 'project-b', runId: 'run-b' }; }); await refresh(page); await json(page).fill('session B edit');
  await page.evaluate(() => { window.ctx = { ...window.ctx, projectId: 'project-a', runId: 'run-a' }; }); await refresh(page); assert.equal(await json(page).inputValue(), 'session A edit');
  await page.reload(); await page.waitForFunction(() => window.ready); assert.equal(await json(page).inputValue(), 'session A edit'); assert.equal(await feedback(page).inputValue(), 'session A reason'); assert.equal(await approve(page).isDisabled(), true);
});

test('400/409/503 and unknown POST preserve input, show no fake saved result, and require current GET before actions recover', async t => {
  for (const status of [400, 409, 503]) {
    const page = await pageFor(t); await json(page).fill(JSON.stringify({ ...definition, name: 'keep me' })); await feedback(page).fill('keep feedback'); await page.evaluate(status => { window.mode.postStatus = status; }, status);
    await revise(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' }); assert.match(await json(page).inputValue(), /keep me/); assert.equal(await feedback(page).inputValue(), 'keep feedback');
    assert.equal(await revise(page).isDisabled(), true); assert.equal(await approve(page).isDisabled(), true); assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /后端已保存提案修订/);
    await page.evaluate(() => { window.mode.postStatus = 0; }); await refresh(page); assert.equal(await revise(page).isEnabled(), true);
  }
  const page = await pageFor(t); await consent(page).check(); await page.evaluate(() => { window.mode.postThenFail = true; }); await propose(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.equal(await consent(page).isChecked(), false); assert.match(await page.locator('.verification-plans').innerText(), /结果未确认/); assert.equal(await page.evaluate(() => window.requests.filter(x => x.method === 'POST').length), 1);
  await refresh(page); assert.equal(await select(page).locator('option').count(), 2); assert.equal(await page.evaluate(() => window.requests.filter(x => x.method === 'POST').length), 1);
});

test('failed latest GET removes permissions without losing prior text, and a successful GET recovers', async t => {
  const page = await pageFor(t); await feedback(page).fill('review basis'); await consent(page).check(); await page.evaluate(() => { window.mode.getStatus = 503; }); await refresh(page);
  assert.equal(await feedback(page).inputValue(), 'review basis'); assert.equal(await approve(page).isDisabled(), true); assert.equal(await propose(page).isDisabled(), true);
  await page.evaluate(() => { window.mode.getStatus = 0; }); await refresh(page); assert.equal(await approve(page).isEnabled(), true); assert.equal(await consent(page).isChecked(), false);
  await page.evaluate(() => { window.mode.getStatus = 404; }); await refresh(page); assert.match(await page.getByRole('alert').innerText(), /尚未开放独立测试提案/);
});

test('a newer GET overtaking the POST confirmation GET still confirms the intent once without a false failure', async t => {
  const page = await pageFor(t); await json(page).fill(JSON.stringify({ ...definition, name: 'confirmed elsewhere' })); await feedback(page).fill('revision basis');
  await page.evaluate(() => { window.mode.holdConfirmation = true; }); await revise(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await refresh(page); assert.match(await page.locator('.verification-plans').innerText(), /后端已保存提案修订/); await page.evaluate(() => window.release(0)); await settle(page);
  assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /尚未确认操作完成/); assert.equal(await page.getByRole('alert').isVisible(), false); assert.equal(await approve(page).isEnabled(), true);
});

test('POST success with failed GET remains unconfirmed until a later exact current GET, retaining edits made in flight', async t => {
  const page = await pageFor(t); await json(page).fill(JSON.stringify({ ...definition, name: 'submitted' })); await feedback(page).fill('submitted feedback');
  await page.evaluate(() => { window.mode.holdConfirmation = true; }); await revise(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await json(page).fill('newer local draft'); await page.evaluate(() => window.release(0, { error: 'confirmation unavailable', status: 503 })); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /后端已保存提案修订/); assert.equal(await json(page).inputValue(), 'newer local draft');
  await refresh(page); assert.match(await page.locator('.verification-plans').innerText(), /后端已保存提案修订/); assert.equal(await json(page).inputValue(), 'newer local draft'); assert.equal(await revise(page).isDisabled(), true);
});

test('last GET wins over late success and failure, with stale error unable to revoke new permissions', async t => {
  for (const oldFailure of [false, true]) {
    const page = await pageFor(t); await feedback(page).fill('basis'); await page.evaluate(() => { window.holds['GET:a'] = 1; window.firstRead = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1);
    await page.evaluate(() => { window.states.a.proposals[0].status = 'rejected'; window.states.a.proposals[0].actions.canApprove = false; }); await refresh(page);
    await page.evaluate(oldFailure => window.release(0, oldFailure ? { error: 'stale failed GET', status: 503 } : {}), oldFailure); await page.evaluate(() => window.firstRead);
    assert.equal(await approve(page).isDisabled(), true); assert.equal(await page.getByRole('alert').isVisible(), false); assert.match(await page.locator('.verification-plans').innerText(), /已驳回定义/);
  }
});

test('A to B to A epoch isolates old POST success/error/finally and keeps the newer action lock', async t => {
  for (const oldFailure of [false, true]) {
    const page = await pageFor(t); await feedback(page).fill('old A basis'); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await approve(page).click(); await page.waitForFunction(() => window.pending.length === 1);
    await page.evaluate(() => { window.ctx.projectId = 'project-b'; window.ctx.runId = 'run-b'; }); await refresh(page); await feedback(page).fill('B basis');
    await page.evaluate(() => { window.ctx.projectId = 'project-a'; window.ctx.runId = 'run-a'; }); await refresh(page); await feedback(page).fill('new A basis'); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await reject(page).click(); await page.waitForFunction(() => window.pending.length === 2);
    await page.evaluate(oldFailure => window.release(0, oldFailure ? { error: 'old A error', status: 503 } : { response: { proposal: { ...window.states.a.proposals[0], status: 'approved', approved: true } } }), oldFailure); await page.waitForTimeout(50);
    assert.equal(await reject(page).isDisabled(), true); assert.equal(await select(page).isDisabled(), true); assert.equal(await feedback(page).inputValue(), 'new A basis'); assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /old A error|后端已认可/);
    await page.evaluate(() => window.release(1)); await settle(page); assert.match(await page.locator('.verification-plans').innerText(), /后端已驳回/);
  }
});

test('cancel reflects request versus confirmed or reconciliation state and sends only an empty object', async t => {
  const page = await pageFor(t); await page.evaluate(() => { const row = window.states.a.proposals[0]; row.status = 'generating'; row.proposal = null; row.revision = null; row.current = false; row.actions = { canCancel: true }; }); await refresh(page);
  await button(page, '请求停止提案生成').click(); await settle(page); const request = await page.evaluate(() => window.requests.find(x => x.method === 'POST'));
  assert.deepEqual(request.body, {}); assert.match(request.url, /\/cancel$/); assert.match(await page.locator('.verification-plans').innerText(), /已请求停止提案生成，尚未确认停止/);
  await page.evaluate(() => { window.states.a.proposals[0].status = 'reconciliation_required'; }); await refresh(page); assert.match(await page.locator('.verification-plans').innerText(), /停止或回执状态待核对/); assert.equal(await approve(page).isDisabled(), true);
  await page.evaluate(() => { window.states.a.proposals[0].status = 'cancelled'; }); await refresh(page); assert.match(await page.locator('.verification-plans').innerText(), /已确认取消/);
  assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /已请求停止提案生成，尚未确认停止|停止或回执状态待核对/);
});

test('destroy detaches the panel and late requests cannot publish, report an error or restart polling', async t => {
  const page = await pageFor(t); await page.evaluate(() => { window.holds['GET:a'] = 1; window.late = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => window.panel.destroy()); await page.evaluate(() => window.release(0, { error: 'late failure', status: 503 })); await page.evaluate(() => window.late);
  const count = await page.evaluate(() => window.requests.length); await page.waitForTimeout(3100); assert.equal(await page.evaluate(() => window.requests.length), count);
  assert.equal(await page.locator('.verification-plans').count(), 0); assert.deepEqual(await page.evaluate(() => window.errors), []);
});

test('GET before a failing in-flight POST cannot be reused as confirmation or restore old permissions', async t => {
  const page = await pageFor(t); await feedback(page).fill('review basis'); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await approve(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await refresh(page); await page.evaluate(() => window.release(0, { error: 'unconfirmed approval failure', status: 503 })); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.equal(await approve(page).isDisabled(), true); assert.equal(await reject(page).isDisabled(), true); assert.equal(await feedback(page).inputValue(), 'review basis');
  await refresh(page); assert.equal(await approve(page).isEnabled(), true); assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /后端已认可当前/);
});

test('definition approval cannot be confirmed against a changed private binding or a historical approval revision', async t => {
  for (const changed of ['binding', 'revision']) {
    const page = await pageFor(t); await feedback(page).fill('same feedback'); await page.evaluate(() => { window.mode.holdConfirmation = true; }); await approve(page).click(); await page.waitForFunction(() => window.pending.length === 1);
    await page.evaluate(changed => { const row = window.states.a.proposals[0]; if (changed === 'binding') row.binding.sourceGeneration++; else row.revision = 'c'.repeat(64); }, changed); await refresh(page);
    assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /后端已认可当前测试定义/); await page.evaluate(() => window.release(0)); await settle(page);
    assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /后端已认可当前测试定义/);
  }
});

test('unknown status and false coverage never enable definition actions, and spec-version changes isolate old draft and requests', async t => {
  const page = await pageFor(t); await feedback(page).fill('old version reason');
  await page.evaluate(() => { window.states.a.proposals[0].status = 'unrecognized_future_state'; }); await refresh(page); assert.equal(await approve(page).isDisabled(), true); assert.equal(await reject(page).isDisabled(), true);
  await page.evaluate(() => { window.states.a = structuredClone(window.initial); window.states.a.proposals[0].executed = true; }); await refresh(page); assert.equal(await propose(page).isDisabled(), true); assert.equal(await approve(page).isDisabled(), true);
  await page.evaluate(() => { window.states.a = structuredClone(window.initial); }); await refresh(page); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await approve(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => { window.ctx.specRevision = 'e'.repeat(64); }); await refresh(page); assert.equal(await approve(page).isDisabled(), true); assert.equal(await feedback(page).inputValue(), '');
  await page.evaluate(() => { window.ctx.specRevision = 'a'.repeat(64); }); await refresh(page); assert.equal(await feedback(page).inputValue(), 'old version reason');
  await page.evaluate(() => window.release(0, { error: 'old specification request', status: 503 })); await page.waitForTimeout(40); assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /old specification request/);
});

test('a generated proposal arriving while the user types leaves their selected draft, focus and selection intact', async t => {
  const page = await pageFor(t); await consent(page).check(); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await propose(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await json(page).fill('editing original while generation is pending'); await json(page).focus(); await json(page).evaluate(el => el.setSelectionRange(3, 9));
  await page.evaluate(() => window.release(0)); await settle(page);
  assert.equal(await select(page).inputValue(), 'proposal-1'); assert.equal(await select(page).locator('option').count(), 2); assert.equal(await json(page).inputValue(), 'editing original while generation is pending');
  assert.deepEqual(await json(page).evaluate(el => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd })), { focused: true, start: 3, end: 9 });
});

test('runs within the same project isolate sessions and reject a late GET from the prior run', async t => {
  const page = await pageFor(t); await feedback(page).fill('run A feedback');
  await page.evaluate(() => { window.holds['GET:a'] = 1; window.oldRunRead = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => { window.ctx.runId = 'run-b'; for (const row of window.states.b.proposals) { row.projectId = 'project-a'; row.binding.projectId = 'project-a'; } }); await refresh(page);
  assert.equal(await feedback(page).inputValue(), ''); await feedback(page).fill('run B feedback'); await page.evaluate(() => window.release(0, { error: 'old run failure', status: 503 })); await page.evaluate(() => window.oldRunRead);
  assert.equal(await feedback(page).inputValue(), 'run B feedback'); assert.doesNotMatch(await page.locator('.verification-plans').innerText(), /old run failure/);
  await page.evaluate(() => { window.ctx.runId = 'run-a'; }); await refresh(page); assert.equal(await feedback(page).inputValue(), 'run A feedback');
});
