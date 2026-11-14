import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { ProjectStore } from '../lib/store.mjs';
import { createVerificationPlanningService, verificationPlanningPolicy } from '../lib/verification-planning-service.mjs';

const content = '用户可以读取资源列表，响应为JSON数组。';
const changed = '用户可以读取资源列表，响应为JSON数组，并显示资源的说明字段。';
const modelHost = 'verification-product.synthetic.invalid';
const settings = { LLM_BASE_URL: `https://${modelHost}/v1`, LLM_MODEL: 'synthetic-product-model', LLM_API_KEY: 'synthetic-product-private-credential', LLM_JSON_MODE: '1', LLM_THINKING: 'disabled', LLM_MAX_TOKENS: '16384' };
const output = path.resolve('output/verification/verification-product-acceptance');
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(read, predicate = Boolean, label = '产品状态') {
  const end = Date.now() + 15000;
  for (;;) { const value = await read(); if (predicate(value)) return value; assert.ok(Date.now() < end, `${label}超时: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const spec = document => ({ title: '资源提案产品检查', summary: document, goals: [], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回资源JSON数组'],
  stack: { frontend: '原生HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ id: 'R-001', title: '读取资源', description: document, sourceQuote: document, acceptance: ['成功读取资源列表'] }] });
const engineering = () => ({ version: 1, title: '资源工程接口', summary: '根据确认需求提供资源集合', entities: [],
  routes: [{ id: 'READ', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '200与JSON数组', errors: [], requirementIds: ['R-001'] }],
  views: [{ id: 'HOME', path: '/', title: '资源', requirementIds: ['R-001'], selectors: [{ testId: 'resources', role: 'list' }] }],
  tasks: [{ id: 'DEV', title: '实现资源读取', description: '实现已确认资源接口', requirementIds: ['R-001'], dependsOn: [], writePaths: ['src/app.mjs', 'public/app.js'], inputs: ['确认规格'], outputs: ['资源接口与页面'], acceptance: ['返回JSON资源集合'] }] });
const definition = () => ({ version: 1, id: 'resources-http', name: '资源HTTP结构提案', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R-001'],
  request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'read_status', op: 'status', value: 200 }] } }] });
function safePublic(value, directory) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [settings.LLM_API_KEY, directory, '.private', 'specification-receipts', 'engineering-receipts', 'receipt_path', 'receiptPath']) assert.equal(json.includes(secret), false, secret);
  assert.equal(json.includes(JSON.stringify(JSON.stringify(definition()))), false, '原始回执正文不得作为字符串下发');
}
async function fixture(t, { unknownReceipt = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verification-product-'));
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]])), originalFetch = globalThis.fetch;
  const f = { directory, calls: { spec: 0, engineering: 0, verification: 0 }, bodies: [], posts: [], errors: [], releaseModel: deferred(), modelEntered: deferred(), releaseWriter: deferred(), writerEntered: deferred(), writerExited: deferred(), holdModel: false };
  let app, browser;
  t.after(async () => {
    await mkdir(output, { recursive: true });
    const label = t.name.replace(/[^A-Za-z0-9]+/gu, '-').slice(0, 100), evidence = { completed: f.completed === true, calls: f.calls, posts: f.posts, browserErrors: f.errors, databases: [] };
    if (f.project) evidence.project = app?.store.get(f.project.id);
    for (const [relative, table] of [['verification-planning/verification.sqlite', 'proposals'], ['source-changes/changes.sqlite', 'changes'], ['executions/service.sqlite', 'executions']]) {
      let db;
      try { db = new DatabaseSync(path.join(directory, relative), { readOnly: true }); evidence.databases.push({ relative, rows: db.prepare(`SELECT * FROM ${table}`).all() }); }
      catch (error) { evidence.databases.push({ relative, error: error.code ?? 'unavailable' }); } finally { db?.close(); }
    }
    await writeFile(path.join(output, `${label}.json`), JSON.stringify(evidence, null, 2));
    if (!f.completed && f.page && !f.page.isClosed()) await f.page.screenshot({ path: path.join(output, `${label}-failure.png`), fullPage: true }).catch(() => {});
    f.releaseModel.resolve(); f.releaseWriter.resolve();
    try { await browser?.close(); await app?.close(); if (unknownReceipt && f.writerStarted) await f.writerExited.promise; }
    finally {
      globalThis.fetch = originalFetch; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('verification-product-')); await rm(directory, { recursive: true, force: true });
    }
  });
  await mkdir(output, { recursive: true });
  Object.assign(process.env, settings);
  globalThis.fetch = async (url, request = {}) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.hostname === modelHost) {
      assert.equal(target.pathname, '/v1/chat/completions'); assert.equal(request.method, 'POST'); assert.equal(request.headers.Authorization, `Bearer ${settings.LLM_API_KEY}`);
      const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content); f.bodies.push(body); let proposal, usage;
      if (typeof data.document === 'string') { f.calls.spec++; proposal = spec(data.document); usage = { prompt_tokens: 17, completion_tokens: 19 }; }
      else if (data.spec) { f.calls.engineering++; proposal = engineering(); usage = { prompt_tokens: 23, completion_tokens: 29 }; }
      else {
        assert.deepEqual(Object.keys(data).sort(), ['binding', 'engineeringContract', 'requirements', 'task']); assert.equal(data.requirements[0].id, 'R-001'); assert.equal(data.engineeringContract.routes[0].path, '/resources');
        for (const key of ['candidate', 'files', 'sourceSnapshot', 'testResults', 'passed', 'artifacts']) assert.equal(Object.hasOwn(data, key), false);
        assert.equal(request.body.includes(settings.LLM_API_KEY), false); assert.equal(Object.hasOwn(request, 'onReceipt'), false);
        f.calls.verification++; f.modelEntered.resolve(); if (f.holdModel) await f.releaseModel.promise; proposal = definition(); usage = { prompt_tokens: 31, completion_tokens: 37 };
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }], usage }));
    }
    assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), '测试禁止其他外部网络'); return originalFetch(url, request);
  };
  if (unknownReceipt) {
    const store = await new ProjectStore(directory).init();
    const service = await createVerificationPlanningService({ rootDir: path.join(directory, 'verification-planning'), getPlanning: (pid, rid) => store.getPersistedRun(pid, rid), timeoutMs: 500, cleanupMs: 30,
      dependencies: { writeReceipt: async ({ filename, contents }) => { f.writerStarted = true; f.writerEntered.resolve(); try { await f.releaseWriter.promise; await writeFile(filename, contents, { flag: 'wx', mode: 0o600 }); } finally { f.writerExited.resolve(); } } } });
    app = await createApp({ store, stepDelayMs: 0, verificationPlanningService: service });
  } else app = await createApp({ dataDir: directory, stepDelayMs: 0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  f.app = app; f.url = `http://127.0.0.1:${app.server.address().port}`;
  f.request = async (route, body, status = 200) => {
    const response = await fetch(f.url + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.clone().text()); const value = await response.json(); safePublic(value, directory); return value;
  };
  f.project = (await f.request('/api/projects', { name: '独立测试提案产品', filename: 'requirements.md', content }, 201)).project;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  f.page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  f.page.on('pageerror', error => f.errors.push(error.message));
  f.page.on('console', item => { if (item.type() === 'error') f.errors.push(item.text()); });
  f.page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/verification-plans/')) f.posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  f.base = () => `/api/projects/${f.project.id}/runs/${f.run.id}/verification-plans`;
  f.state = () => f.request(f.base());
  f.row = id => until(async () => (await f.state()).proposals.find(row => row.id === id), row => row && !['generating', 'cancel_requested'].includes(row.status), '提案终态');
  f.reopen = async () => {
    await f.page.close(); await app.close(); app = await createApp({ dataDir: directory, stepDelayMs: 0 }); f.app = app;
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); f.url = `http://127.0.0.1:${app.server.address().port}`;
  };
  await f.page.goto(f.url); await ready(f.page.locator('#start-run')); await f.page.locator('#mode-select').selectOption('model');
  await f.page.locator('#start-run').click(); await f.page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  f.run = app.store.get(f.project.id).runs.at(-1);
  assert.deepEqual(f.calls, { spec: 1, engineering: 0, verification: 0 }); assert.equal(f.run.specificationHistory[0].receiptState, 'saved'); assert.deepEqual(f.run.specificationHistory[0].usage, { inputTokens: 17, outputTokens: 19 });
  await f.page.getByRole('button', { name: '确认规格并继续', exact: true }).click(); await f.page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 0 });
  await f.page.getByRole('button', { name: '确认计划并导出', exact: true }).click(); await f.page.locator('#download-bundle').waitFor({ state: 'visible' });
  await f.page.locator('#verification-plans-section > summary').click(); f.panel = f.page.locator('.verification-plans');
  await ready(f.panel.locator('input[type=checkbox]')); assert.equal(await f.panel.getByRole('button', { name: '生成独立测试提案', exact: true }).isDisabled(), true);
  return f;
}
async function ready(locator) { await locator.waitFor({ state: 'visible' }); await until(() => locator.isEnabled(), Boolean, '控件许可'); }
async function generate(f) {
  const state = await f.state(), button = f.panel.getByRole('button', { name: '生成独立测试提案', exact: true });
  await ready(f.panel.locator('input[type=checkbox]')); assert.equal(await f.panel.locator('input[type=checkbox]').isChecked(), false);
  assert.ok((await f.panel.innerText()).includes(`模型：${state.capabilities.model}`)); assert.ok((await f.panel.innerText()).includes(`剩余 ${state.capabilities.budget.remainingAttempts} 次`));
  await f.panel.locator('input[type=checkbox]').check(); await ready(button);
  const received = f.page.waitForResponse(response => response.url().endsWith(f.base() + '/propose') && response.request().method() === 'POST');
  await button.click(); const response = await received; assert.equal(response.status(), 202); const row = (await response.json()).proposal;
  assert.equal(row.status, 'generating'); assert.deepEqual(f.posts.at(-1).body, { contractRevision: state.capabilities.contractRevision }); return row;
}
async function refresh(f) { const received = f.page.waitForResponse(response => response.url().endsWith(f.base()) && response.request().method() === 'GET'); await f.panel.getByRole('button', { name: '刷新测试提案', exact: true }).click(); await received; }
async function action(f, label, kind) {
  const button = f.panel.getByRole('button', { name: label, exact: true }); await ready(button);
  const received = f.page.waitForResponse(response => response.url().endsWith('/' + kind) && response.request().method() === 'POST'); await button.click();
  const response = await received; assert.equal(response.status(), 200, await response.text()); return (await response.json()).proposal;
}
async function saveChange(f, name) {
  const source = await f.request(`/api/projects/${f.project.id}/changes`);
  return (await f.request(`/api/projects/${f.project.id}/changes`, { baseRevision: source.current.revision, source: { filename: 'changed.md', content: changed }, reason: '扩展说明字段，旧历史保留', kind: 'field', requestKey: name }, 201)).change;
}

test('actual model planning to HTTP proposal and definition-only human decisions preserves edits across Edge polling and reload', { timeout: 90000 }, async t => {
  const f = await fixture(t), { page, panel } = f; await mkdir(output, { recursive: true });
  const reserved = await generate(f), draft = await f.row(reserved.id); assert.equal(draft.status, 'draft'); assert.deepEqual(draft.usage, { inputTokens: 31, outputTokens: 37 }); assert.equal(draft.receiptState, 'saved');
  await refresh(f); const json = panel.getByLabel('HTTP测试定义 JSON', { exact: true }), feedback = panel.getByLabel('修订或审阅依据（必填，最多5000字）', { exact: true });
  await ready(json); await json.fill('{ invalid JSON'); await feedback.fill('保留本次审阅依据'); await json.focus(); await json.evaluate(el => el.setSelectionRange(2, 9));
  await page.setViewportSize({ width: 390, height: 844 });
  const nextPoll = page.waitForResponse(response => response.url().endsWith(f.base()) && response.request().method() === 'GET'); await nextPoll;
  assert.equal(await json.inputValue(), '{ invalid JSON'); assert.equal(await feedback.inputValue(), '保留本次审阅依据');
  assert.deepEqual(await json.evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 2, 9]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.getByRole('button', { name: '保存提案修订', exact: true }).click(); await until(() => panel.locator('[role=alert]').textContent(), text => /JSON格式无效/u.test(text));
  assert.equal(f.posts.filter(item => item.path.endsWith('/revise')).length, 0); assert.equal(await feedback.inputValue(), '保留本次审阅依据');
  await page.reload(); await page.locator('#verification-plans-section > summary').click(); await ready(json);
  assert.equal(await json.inputValue(), '{ invalid JSON'); assert.equal(await feedback.inputValue(), '保留本次审阅依据'); assert.equal(await panel.locator('input[type=checkbox]').isChecked(), false);
  const first = structuredClone(draft.proposal); first.steps[0].request.assertions.push({ id: 'json_root', op: 'jsonExists', path: '$' }); await json.fill(JSON.stringify(first, null, 2));
  const revised = await action(f, '保存提案修订', 'revise'); assert.notEqual(revised.revision, draft.revision); assert.equal(revised.approved, false); assert.equal(revised.proposal.steps[0].request.assertions.length, 2);
  await ready(panel.getByRole('button', { name: '驳回测试定义', exact: true })); const rejected = await action(f, '驳回测试定义', 'reject'); assert.equal(rejected.status, 'rejected');
  await f.request(`${f.base()}/${rejected.id}/approve`, { revision: rejected.revision, feedback: '同版本重试不得绕过驳回' }, 409);
  await refresh(f); assert.equal(await panel.getByRole('button', { name: '认可测试定义（尚未运行）', exact: true }).isDisabled(), true);
  const second = structuredClone(rejected.proposal); second.steps[0].request.assertions.push({ id: 'array_text', op: 'textIncludes', value: '[' }); await json.fill(JSON.stringify(second, null, 2)); await feedback.fill('增加JSON数组断言后人工核对');
  const final = await action(f, '保存提案修订', 'revise'); assert.notEqual(final.revision, rejected.revision);
  const approved = await action(f, '认可测试定义（尚未运行）', 'approve'); assert.equal(approved.approved, true); assert.equal(approved.approval.phase, 'definition_only'); assert.equal(approved.coverage, 'structural_only'); assert.equal(approved.executed, false);
  assert.equal(approved.policyHash, verificationPlanningPolicy.hash); assert.ok(approved.history.some(item => item.status === 'reject')); assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 1 });
  assert.equal(await panel.locator('a').count(), 0); assert.doesNotMatch(await panel.innerText(), /业务测试已通过|软件已通过/u);
  const executions = await f.request(`/api/projects/${f.project.id}/runs/${f.run.id}/executions`); assert.deepEqual(executions.executions, []);
  const projectJson = await readFile(path.join(f.directory, `${f.project.id}.json`), 'utf8'); safePublic(projectJson, f.directory); assert.equal(projectJson.includes(approved.id), false);
  const plan = await (await fetch(f.url + `/api/projects/${f.project.id}/runs/${f.run.id}/artifacts/plan.json`)).text(); safePublic(plan, f.directory); assert.equal(plan.includes(approved.id), false);
  const download = await fetch(new URL(await page.locator('#download-bundle').getAttribute('href'), f.url)); assert.equal(download.status, 200); const zip = Buffer.from(await download.arrayBuffer());
  assert.ok(zip.includes(Buffer.from('plan.json'))); for (const privateText of [settings.LLM_API_KEY, f.directory, 'verification-planning', approved.id]) assert.equal(zip.includes(Buffer.from(privateText)), false);
  const receipts = await readdir(path.join(f.directory, 'verification-planning', 'receipts')); assert.equal(receipts.length, 1);
  await page.screenshot({ path: path.join(output, 'definition-approved-mobile.png'), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(output, 'definition-approved-desktop.png'), fullPage: true });
  await page.reload(); await page.locator('#verification-plans-section > summary').click(); await until(() => panel.innerText(), text => text.includes('已认可定义（尚未运行）'));
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 1 }); assert.equal((await f.state()).proposals[0].approval.id, approved.approval.id); assert.deepEqual(f.errors, []);
  f.completed = true;
});

test('real three-service checkpoints preserve a pending source during proposal generation and revoke all old permissions after publication', { timeout: 90000 }, async t => {
  const f = await fixture(t); const first = await f.row((await generate(f)).id); await refresh(f);
  const feedback = f.panel.getByLabel('修订或审阅依据（必填，最多5000字）', { exact: true }); await ready(feedback); await feedback.fill('认可当前结构定义'); const approved = await action(f, '认可测试定义（尚未运行）', 'approve');
  f.holdModel = true; f.modelEntered = deferred(); const pending = await generate(f); await f.modelEntered.promise;
  const change = await saveChange(f, 'generating-checkpoint'); const apply = `/api/projects/${f.project.id}/changes/${change.id}/apply`;
  await f.request(apply, { baseRevision: change.baseRevision, generation: change.generation }, 409);
  assert.equal(f.app.store.get(f.project.id).source.content, content); assert.equal((await f.request(`/api/projects/${f.project.id}/changes`)).changes.find(row => row.id === change.id).status, 'pending');
  const busy = await f.state(); assert.equal(busy.capabilities.canPropose, false); assert.equal(busy.proposals.find(row => row.id === approved.id).approved, false);
  f.releaseModel.resolve(); assert.equal((await f.row(pending.id)).status, 'draft'); await f.request(apply, { baseRevision: change.baseRevision, generation: change.generation });
  await f.page.getByRole('heading', { name: '历史需求输入：确认记录只读', exact: true }).waitFor();
  const old = await f.state(); assert.equal(old.capabilities.canPropose, false); for (const row of old.proposals) { assert.equal(row.current, false); assert.equal(row.approved, false); assert.ok(Object.values(row.actions).every(value => !value)); }
  await f.request(`${f.base()}/${approved.id}/approve`, { revision: approved.revision, feedback: '旧输入不得恢复许可' }, 409);
  assert.equal(f.app.store.get(f.project.id).sourceGeneration, 1); assert.equal(f.app.store.get(f.project.id).source.content, changed); assert.equal(f.run.sourceSnapshot.content, content);
  const counts = { ...f.calls }; await f.page.locator('#start-run').click(); await f.page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  const next = f.app.store.get(f.project.id).runs.at(-1); assert.notEqual(next.id, f.run.id); assert.equal(next.sourceGeneration, 1); assert.deepEqual(next.approvals, { spec: null, plan: null });
  assert.equal(f.calls.spec, counts.spec + 1); assert.equal(f.calls.engineering, counts.engineering); assert.equal(f.calls.verification, 2);
  await f.page.getByRole('button', { name: '确认规格并继续', exact: true }).click(); await f.page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  await f.page.getByRole('button', { name: '确认计划并导出', exact: true }).click(); await f.page.locator('#download-bundle').waitFor({ state: 'visible' });
  const newState = await f.request(`/api/projects/${f.project.id}/runs/${next.id}/verification-plans`); assert.equal(newState.capabilities.canPropose, true); assert.deepEqual(newState.proposals, []); assert.equal(newState.capabilities.budget.remainingAttempts, 3);
  await f.page.locator('#run-select').selectOption(f.run.id); await f.page.getByRole('heading', { name: '历史需求输入：确认记录只读', exact: true }).waitFor(); await refresh(f);
  assert.equal(await f.panel.getByRole('button', { name: '生成独立测试提案', exact: true }).isDisabled(), true); assert.equal(await f.page.locator('[data-review-action]').count(), 0); assert.deepEqual(f.errors, []);
  assert.equal(old.proposals.find(row => row.id === approved.id).approval.id, approved.approval.id); assert.equal(old.proposals.find(row => row.id === approved.id).revision, approved.revision); assert.equal(first.id, approved.id);
  f.completed = true;
});

test('actual adapter with an uncooperative private receipt keeps source application blocked and unknown evidence durable after restart', { timeout: 90000 }, async t => {
  const f = await fixture(t, { unknownReceipt: true }), pending = await generate(f); await f.writerEntered.promise;
  const change = await saveChange(f, 'unknown-receipt-checkpoint'), apply = `/api/projects/${f.project.id}/changes/${change.id}/apply`;
  await f.request(apply, { baseRevision: change.baseRevision, generation: change.generation }, 409);
  const unknown = await f.row(pending.id); assert.equal(unknown.status, 'reconciliation_required'); assert.equal(unknown.receiptState, 'unknown'); assert.equal(unknown.proposal, null); assert.deepEqual(unknown.usage, { inputTokens: 31, outputTokens: 37 });
  await refresh(f); await until(() => f.panel.innerText(), text => text.includes('停止或回执状态待核对')); assert.equal(await f.panel.getByRole('button', { name: '请求停止提案生成', exact: true }).isDisabled(), true);
  await f.page.screenshot({ path: path.join(output, 'unknown-private-receipt.png'), fullPage: true });
  await f.reopen(); const reopened = await f.state(); assert.equal(reopened.proposals[0].status, 'reconciliation_required'); assert.equal(reopened.capabilities.canPropose, false); assert.equal(reopened.capabilities.budget.remainingAttempts, 2);
  f.releaseWriter.resolve(); await f.writerExited.promise; await f.request(apply, { baseRevision: change.baseRevision, generation: change.generation }, 409);
  assert.equal((await f.state()).proposals[0].status, 'reconciliation_required'); assert.equal(f.app.store.get(f.project.id).source.content, content);
  assert.equal((await f.request(`/api/projects/${f.project.id}/changes`)).changes[0].status, 'pending'); assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 1 });
  for (const [relative, table, expected] of [['verification-planning/verification.sqlite', 'proposals', 1], ['source-changes/changes.sqlite', 'changes', 1], ['executions/service.sqlite', 'executions', 0]]) {
    const db = new DatabaseSync(path.join(f.directory, relative), { readOnly: true }); try { assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, expected); } finally { db.close(); }
  }
  assert.deepEqual(f.errors, []); f.completed = true;
});
