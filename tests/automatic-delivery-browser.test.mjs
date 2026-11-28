import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';

const requirement = '做一个公开的小组公告网页，访客打开首页可以看到一条固定公告，GET /api/notice 返回同样的公告文字。其他方法返回 405。';
const question = '公告要显示哪一句话？';
const announcement = '明天下午开会';
const requirementIds = ['R-001'];
const spec = {
  title: '小组公告', summary: requirement, goals: ['让成员查看公告'], roles: ['访客'], constraints: [], assumptions: [], questions: [],
  acceptanceScenarios: ['打开首页看到公告，查询接口返回同样的文字'],
  stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
  requirements: [{ id: requirementIds[0], title: '查看公告', description: '在首页和查询接口显示固定公告。', sourceQuote: requirement,
    acceptance: [`打开首页并看到「${announcement}」`, 'GET /api/notice 返回同样的文字，其他方法返回 405'] }],
};
const plan = {
  version: 1, title: '公告开发计划', summary: '实现首页和公告接口', entities: [],
  routes: [{ id: 'NOTICE', method: 'GET', path: '/api/notice', roles: [], request: '无正文', response: '返回公告文字', errors: [], requirementIds }],
  views: [{ id: 'HOME', path: '/', title: '小组公告', requirementIds, selectors: [{ testId: 'notice', role: 'heading' }] }],
  tasks: [{ id: 'SHOW', title: '实现公告页面与查询', description: '首页和查询接口展示公告', requirementIds, dependsOn: [],
    writePaths: ['src/app.mjs'], inputs: ['已确认规格'], outputs: ['公告首页和查询接口'], acceptance: ['两处显示同一公告'] }],
};
const definition = {
  version: 1, id: 'notice-checks', name: '公告接口和首页', sessions: [], taskScopes: [],
  steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds, request: {
    id: 'get_notice', method: 'GET', path: '/api/notice', assertions: [
      { id: 'ok', op: 'status', value: 200 }, { id: 'notice_text', op: 'jsonEquals', path: '$.text', value: announcement },
    ],
  } }],
  browser: { version: 1, sessions: ['visitor'], steps: [
    { id: 'visit', session: 'visitor', op: 'goto', path: '/', requirementIds },
    { id: 'read_notice', session: 'visitor', op: 'text', testId: 'notice', value: announcement, requirementIds },
  ] },
};
const methodGuard = "    if (request.method !== 'GET') return { status: 405, headers: {}, body: '' };";
const code = `export async function createApp() {
  const title = ${JSON.stringify(announcement)};
  return { handle(request) {
    if (request.path === '/favicon.ico') return { status: 204, headers: {}, body: '' };
    if (request.path === '/api/notice') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: title }) };
    const body = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>小组公告</title><h1 data-testid="notice">' + title + '</h1></html>';
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
  } };
}`;

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = server => `http://127.0.0.1:${server.address().port}`;
const roles = ['spec', 'engineering', 'verification', 'coding', 'review'];
const stopStates = new Set(['completed', 'failed', 'interrupted']);
const native = process.platform === 'win32' && process.env.TASKFLOW_TEST_REAL_SANDBOX === '1' && !!process.env.EXECUTION_SANDBOX_EXE;

async function until(read, message, ms = 40000) {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (value) return value;
    await delay(300);
  } while (Date.now() < end);
  assert.fail(message);
}

test('Edge can stop automatic advancement while a specification request is still settling', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-automatic-stop-browser-'));
  let app, browser, releaseSpecification;
  const requests = [], modelErrors = [], pageErrors = [];
  const specificationGate = new Promise(resolve => { releaseSpecification = resolve; });
  const model = createServer(async (request, response) => {
    try {
      for await (const _part of request) { /* Consume the fixture request before holding the reply. */ }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      requests.push(request.url);
      await specificationGate;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(spec) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    } catch (error) {
      modelErrors.push(error.message);
      response.writeHead(500).end();
    }
  });
  await listen(model);
  t.after(async () => {
    releaseSpecification();
    await browser?.close();
    try { await app?.close(); }
    finally {
      model.closeAllConnections();
      await new Promise(resolve => model.close(resolve));
      const root = await realpath(os.tmpdir()), target = await realpath(directory);
      assert.equal(path.dirname(target), root);
      assert.ok(path.basename(target).startsWith('tf-automatic-stop-browser-'));
      await rm(target, { recursive: true, force: true });
    }
  });

  const unexpected = () => assert.fail('停止演示不得派发后续验收或开发');
  app = await createApp({ dataDir: directory, teamEnabled: false, stepDelayMs: 0,
    agentEnvironment: { LLM_BASE_URL: endpoint(model) + '/v1', LLM_MODEL: 'automatic-stop-fixture' },
    plannedExecutionService: { start: unexpected, list: async () => ({ executions: [], capabilities: { canStart: false } }),
      withProjectCheckpoint: async (_id, work) => work(), shutdown: async () => {} },
  });
  await listen(app.server);
  const origin = endpoint(app.server);
  const created = await fetch(origin + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '自动停止浏览器验证', filename: 'notice.md', content: requirement }) });
  assert.equal(created.status, 201);
  const { project } = await created.json();
  const projectUrl = `${origin}/api/projects/${project.id}`;

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(`${message.location().url}: ${message.text()}`); });
  await page.goto(origin);
  await page.locator('#start-automatic').click();
  await page.locator('#automatic-consent').check();
  await page.locator('#confirm-automatic').click();
  await until(() => requests.length === 1, '未发送规格请求');
  const stop = page.locator('#stop-automatic');
  await stop.waitFor();
  page.once('dialog', async dialog => {
    assert.match(dialog.message(), /后续步骤/u);
    await dialog.accept();
  });
  const stopResponse = page.waitForResponse(response => response.url().endsWith('/automatic-delivery/stop'));
  await stop.click();
  const response = await stopResponse;
  assert.equal(response.status(), 202);
  const requested = await response.json();
  assert.equal(requested.status, 'stop_requested');
  assert.equal(requested.usageByStage.specification.totalModelCalls, null);
  await stop.filter({ hasText: /^等待停止自动推进$/u }).waitFor();
  assert.equal(await stop.isDisabled(), true);
  assert.equal(await page.locator('#automatic-download').isVisible(), false);

  releaseSpecification();
  await page.locator('#workspace-context-title').filter({ hasText: /^已停止自动推进$/u }).waitFor();
  const { project: loadedProject } = await (await fetch(projectUrl)).json();
  const [run] = loadedProject.runs;
  const saved = await (await fetch(`${projectUrl}/runs/${run.id}/automatic-delivery`)).json();
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.stopRequestedAt, requested.stopRequestedAt);
  assert.equal(saved.usageByStage.specification.totalModelCalls, 1);
  assert.equal(saved.usageByStage.specification.usage.outputTokens, 2);
  assert.equal(saved.downloadAvailable, false);
  assert.equal(run.approvals.spec, null);
  assert.deepEqual(requests, ['/v1/chat/completions']);
  assert.deepEqual(modelErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('automatic delivery in Edge pauses only for the missing business answer and delivers the repaired candidate', { timeout: 180000, skip: !native }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-automatic-delivery-'));
  const calls = [], modelErrors = [], pageErrors = [];
  let app, browser, identity, completed;
  let releaseCoding;
  const waitForProgressAssertion = new Promise(resolve => { releaseCoding = resolve; });
  const model = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const payload = JSON.parse(Buffer.concat(parts));
      const role = req.url.match(/^\/([^/]+)\/chat\/completions$/u)?.[1];
      assert.ok(roles.includes(role), req.url);
      assert.equal(payload.model, `automatic-${role}`);
      assert.equal(req.headers.authorization, `Bearer synthetic-automatic-${role}-secret`);
      const input = JSON.parse(payload.messages.at(-1).content);
      calls.push(role);
      const round = calls.filter(call => call === role).length;
      let output = { engineering: plan, verification: definition }[role];
      if (role === 'verification') {
        if (round === 1) {
          output = structuredClone(definition);
          output.steps[0].dependsOn = ['missing-earlier-step'];
        } else {
          assert.equal(round, 2);
          assert.match(input.retryFeedback, /missing-earlier-step/u);
        }
      }
      if (role === 'spec') {
        if (round === 2) assert.ok(input.document.includes(announcement));
        output = round === 1 ? { ...spec, requirements: [], questions: [question] } : spec;
      }
      if (role === 'coding') {
        let content = code;
        if (round === 1) {
          content = code.replace('data-testid="notice"', 'data-testid="wrong-notice"');
          await waitForProgressAssertion;
        } else if (round === 2) {
          const feedback = JSON.parse(input.feedback);
          assert.equal(feedback.reviewStatus, 'not_started');
          assert.ok(feedback.browser.some(check => check.view === 'MOBILE' && check.testId === 'notice' && check.matches === 0));
        } else {
          assert.equal(round, 3);
          assert.equal(JSON.parse(input.feedback).issues.length, 1);
          content = code.replace('  return { handle(request) {', `  return { handle(request) {\n${methodGuard}`);
        }
        output = { files: [{ path: 'src/app.mjs', content }] };
      }
      if (role === 'review') {
        const source = input.files.find(file => file.path === 'src/app.mjs');
        assert.ok(source.lines.some(line => line.text.includes('data-testid="notice"')));
        assert.equal(source.lines.some(line => line.text === methodGuard), round === 2);
        assert.equal(input.previousIssues.length, round - 1);
        output = { summary: '固定的本地审查响应', issues: round === 1 ? [{ severity: 'blocking', file: source.path,
          line: source.lines.find(line => line.text.includes('handle(request)')).line, message: '按需求让非 GET 请求返回 405。' }] : [],
        resolutions: input.previousIssues.map(issue => ({ id: issue.id, status: 'resolved', reason: '当前源码在路由执行前拒绝非 GET 请求。' })) };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    } catch (error) {
      modelErrors.push(error.message);
      res.writeHead(500).end();
    }
  });
  await listen(model);
  t.after(async () => {
    releaseCoding();
    await browser?.close();
    let safeToRemove = completed?.status === 'completed' || !calls.includes('coding');
    try {
      if (!safeToRemove && identity) {
        const service = app.plannedExecutionService;
        const { executions } = await service.list(identity);
        for (const execution of executions.filter(item => item.actions.canCancel)) await service.cancel({ ...identity, executionId: execution.id });
        safeToRemove = await until(async () => (await service.list(identity)).executions.every(item => !item.active), 'Worker停止尚未确认', 15000);
      }
    } catch (error) { t.diagnostic(error.message); }
    try { await app?.close(); }
    finally {
      model.closeAllConnections();
      await new Promise(resolve => model.close(resolve));
      const root = await realpath(os.tmpdir()), current = await realpath(directory);
      assert.equal(path.dirname(current), root);
      assert.ok(path.basename(current).startsWith('tf-automatic-delivery-'));
      if (safeToRemove) await rm(current, { recursive: true, force: true });
      else t.diagnostic(`保留停止待核对的测试目录 ${current}`);
    }
  });

  app = await createApp({ dataDir: directory, agentEnvironment: {}, stepDelayMs: 0, teamEnabled: false });
  const pricing = { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 3 };
  await app.agentSettings.save({ revision: 0, roles: Object.fromEntries(roles.map(role => [role, role])),
    providers: roles.map(role => ({ id: role, name: role, baseUrl: `${endpoint(model)}/${role}`, model: `automatic-${role}`,
      apiKey: `synthetic-automatic-${role}-secret`, pricing })) });
  await listen(app.server);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') pageErrors.push(entry.text()); });
  const origin = endpoint(app.server);
  const responseJson = async resource => {
    const response = await page.request.get(`${origin}${resource}`);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  await page.goto(origin);
  await page.locator('#onboarding-import').click();
  await page.getByRole('textbox', { name: '需求正文' }).fill(requirement);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.locator('#start-automatic').click();
  assert.equal(await page.locator('#confirm-automatic').isDisabled(), true);
  await page.locator('#automatic-consent').check();
  await page.locator('#confirm-automatic').click();
  const { projects: [project] } = await responseJson('/api/projects');
  const projectUrl = `/api/projects/${project.id}`;
  const { project: { runs: [run] } } = await until(async () => {
    const state = await responseJson(projectUrl);
    return state.project.runs.length > 0 && state;
  }, '自动交付未创建规划运行');
  identity = { projectId: project.id, runId: run.id };
  const runUrl = `${projectUrl}/runs/${run.id}`;
  const deliveryUrl = `${runUrl}/automatic-delivery`;
  await until(async () => {
    const state = await responseJson(deliveryUrl);
    assert.ok(!stopStates.has(state.status), JSON.stringify({ state, modelErrors }));
    return state.status === 'needs_clarification';
  }, '未进入需求澄清');
  assert.deepEqual(calls, ['spec']);
  assert.equal(await page.locator('#automatic-download').isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('#delivery-current-state').getByText('等待补充需求', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#workspace-next-root').click();
  await page.getByRole('textbox', { name: question }).fill(announcement);
  await page.getByRole('button', { name: '提交本轮回答', exact: true }).click();
  const inFlight = await until(async () => {
    const state = await responseJson(deliveryUrl);
    assert.ok(!stopStates.has(state.status), JSON.stringify({ state, modelErrors }));
    return state.status === 'running' && state.executionId && calls.includes('coding') && state;
  }, '回答后未自动通过规格、计划和清单并进入编码');
  const executionUrl = `${runUrl}/development-executions`;
  assert.equal(inFlight.usageByStage.development.totalModelCalls, null);
  assert.equal((await responseJson('/api/health')).automaticDelivery.developmentTimeoutMs, 3_600_000);
  const { capabilities, executions: [running] } = await responseJson(executionUrl);
  assert.equal(capabilities.budget.timeoutMs, 3_600_000);
  assert.equal(running.budget.timeoutMs, 3_600_000);
  const beforeDelivery = await page.request.get(`${origin}${executionUrl}/${inFlight.executionId}/download`);
  assert.equal(beforeDelivery.status(), 409);
  assert.equal(await page.locator('#automatic-download').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  releaseCoding();

  completed = await until(async () => {
    const state = await responseJson(deliveryUrl);
    return stopStates.has(state.status) && state;
  }, '真实 Worker 未完成验收', 100000);
  assert.deepEqual(modelErrors, []);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.executionId, inFlight.executionId);
  assert.equal(completed.downloadAvailable, true);
  const { executions: [execution, ...duplicates] } = await responseJson(executionUrl);
  assert.equal(duplicates.length, 0);
  assert.equal(execution.id, completed.executionId);
  assert.equal(execution.executionEngine, 'persistent_worker');
  assert.equal(execution.accepted, true);
  assert.equal(execution.checkpoint.sealed, true);
  assert.equal(execution.workflow.reworkCount, 2);
  assert.equal(execution.checks.review, 'completed');
  assert.ok(execution.checks.http.length > 0 && execution.checks.http.every(item => item.passed));
  assert.ok(execution.checks.browser.some(item => item.id.startsWith('BROWSER-DESKTOP-')));
  assert.ok(execution.checks.browser.some(item => item.id.startsWith('BROWSER-MOBILE-')));
  assert.ok(execution.checks.browser.every(item => item.passed));
  const [failedBrowser, blockedReview, valid] = execution.reviewHistory;
  assert.equal(failedBrowser.status, 'not_started');
  assert.equal(blockedReview.issues[0].severity, 'blocking');
  assert.equal(valid.resolutions[0].status, 'resolved');
  assert.equal(valid.candidateCommit, execution.candidateCommit);
  assert.equal(new Set(execution.reviewHistory.map(item => item.candidateCommit)).size, 3);
  assert.deepEqual(calls, ['spec', 'spec', 'engineering', 'verification', 'verification', 'coding', 'coding', 'review', 'coding', 'review']);
  for (const [stage, callCount] of [['specification', 2], ['engineering', 1], ['verification', 2], ['development', 5]]) {
    const actual = completed.usageByStage[stage];
    assert.equal(actual.totalModelCalls, callCount);
    assert.deepEqual(actual.usage, { inputTokens: callCount * 3, outputTokens: callCount * 2 });
    assert.deepEqual(actual.costEstimate, { known: true, amount: callCount * 0.000012, currency: 'CNY', amounts: [{ amount: callCount * 0.000012, currency: 'CNY' }] });
  }
  assert.doesNotMatch(JSON.stringify(completed), /synthetic-automatic|receiptHash|inputPerMillion|settingsFingerprint/u);
  const settings = app.agentSettings.view();
  await app.agentSettings.save({ revision: settings.revision, roles: settings.roles, providers: settings.providers.map(provider => ({ ...provider, pricing: { ...pricing, inputPerMillion: 9 } })) });
  assert.deepEqual((await responseJson(deliveryUrl)).usageByStage, completed.usageByStage);

  await page.reload();
  await page.locator('#delivery-done-count').getByText(/9\s*\/\s*9/u).waitFor();
  await page.locator('[data-delivery-step="coding"] small').getByText(/调用 5 次.*费用估算 0.00006 CNY/u).waitFor();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#automatic-download').click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /\.zip$/u);
  const zip = await readFile(await download.path());
  assert.equal(zip.toString('hex', 0, 4), '504b0304');
  for (const value of ['src/app.mjs', 'delivery/manifest.json', execution.candidateCommit, methodGuard]) assert.ok(zip.includes(Buffer.from(value)), value);
  assert.ok(!zip.includes(Buffer.from('-secret')));
  assert.deepEqual(pageErrors, []);
  t.diagnostic(JSON.stringify({ candidateCommit: execution.candidateCommit, self: execution.checks.self.length,
    http: execution.checks.http.length, browser: execution.checks.browser.length, reviews: 2, calls: calls.length }));
  if (process.env.TASKFLOW_AUTOMATIC_E2E_ARCHIVE) await writeFile(process.env.TASKFLOW_AUTOMATIC_E2E_ARCHIVE, zip, { flag: 'wx' });
});
