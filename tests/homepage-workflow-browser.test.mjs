import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { deliverySteps } from '../public/delivery-workflow.js';

const request = '我想做个小组公告网页，让大家看到一条共享公告。';
const announcement = '明天下午开会';
const requirementId = 'R-001';
const spec = {
  title: '小组公告', summary: request, goals: ['让成员查看公告'], roles: ['小组成员'], constraints: [], assumptions: [],
  questions: [], acceptanceScenarios: ['打开网页看到公告'],
  stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
  requirements: [{ id: requirementId, title: '查看共享公告', description: '小组成员打开网页能看到公告。',
    sourceQuote: request, acceptance: [`打开页面能看到「${announcement}」。`] }],
};
const plan = {
  version: 1, title: '共享公告的开发方案', summary: '提供一个公告页面和查询接口', entities: [],
  routes: [{ id: 'NOTICE', method: 'GET', path: '/api/notice', roles: [], request: '无正文', response: '返回公告文字',
    errors: [], requirementIds: [requirementId] }],
  views: [{ id: 'HOME', path: '/', title: '小组公告', requirementIds: [requirementId], selectors: [{ testId: 'notice', role: 'heading' }] }],
  tasks: [{ id: 'SHOW', title: '在网页上展示公告', description: '读取公告接口并显示公告', requirementIds: [requirementId],
    dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['已确认的公告'], outputs: ['公告页面与查询接口'], acceptance: ['网页显示公告'] }],
};
const definition = {
  version: 1, id: 'notice-checks', name: '查看小组公告', sessions: [],
  steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: [requirementId],
    request: { id: 'get_notice', method: 'GET', path: '/api/notice', assertions: [
      { id: 'ok', op: 'status', value: 200 }, { id: 'notice_text', op: 'jsonEquals', path: '$.text', value: announcement },
    ] } }],
  browser: { version: 1, sessions: ['visitor'], steps: [
    { id: 'visit', session: 'visitor', op: 'goto', path: '/', requirementIds: [requirementId] },
    { id: 'read_notice', session: 'visitor', op: 'text', testId: 'notice', value: announcement, requirementIds: [requirementId] },
  ] },
  taskScopes: [],
};
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
const native = process.env.TASKFLOW_TEST_REAL_SANDBOX === '1' && !!process.env.EXECUTION_SANDBOX_EXE;
const stage = (page, id) => page.locator(`[data-delivery-step="${id}"]`);

test('active development takes precedence over a locked definition and earlier failed drafts', () => {
  const run = { specRevision: 'spec', planRevision: 'plan',
    approvals: { spec: { revision: 'spec' }, plan: { revision: 'plan', specRevision: 'spec' } } };
  const earlier = { state: 'failed', text: '清单准备未完成' };
  const state = deliverySteps({ project: {}, run, verification: earlier,
    development: { hasDefinition: false, execution: { status: 'generating', active: true } } });
  assert.equal(state.find(step => step.id === 'verification').state, 'done');
  assert.equal(state.find(step => step.id === 'coding').state, 'working');
  assert.equal(state.find(step => step.id === 'delivery').state, 'idle');
  const history = deliverySteps({ project: {}, run, historical: true, verification: earlier,
    development: { execution: { status: 'generating', active: true } } });
  assert.equal(history.find(step => step.id === 'verification').text, '历史版本');
});

test('homepage shows the whole workflow before a project exists on desktop and mobile', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-homepage-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  app = await createApp({ dataDir: directory, teamEnabled: false });
  await listen(app.server);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(endpoint(app.server));
    await page.getByRole('heading', { name: '项目流程图', exact: true }).waitFor();
    await stage(page, 'source').waitFor();
    const nodes = page.locator('[data-delivery-step]:visible');
    assert.deepEqual(await nodes.evaluateAll(elements => elements.map(element => element.dataset.deliveryStep)),
      ['source', 'spec', 'spec-approval', 'plan', 'plan-approval', 'verification', 'coding', 'testing', 'delivery']);
    assert.equal(await page.locator('#guided-workspace, #workspace-view-toggle').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await stage(page, 'source').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '新建软件项目' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '你想做什么？' }).isVisible(), true);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
});

test('homepage follows automatic repair of a failed browser round and a blocked Review through source delivery', { timeout: 180000, skip: !native }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-homepage-run-'));
  const calls = [], errors = [];
  let app, browser;
  let releaseCoding, releaseRework;
  const allowCoding = new Promise(resolve => { releaseCoding = resolve; });
  const allowRework = new Promise(resolve => { releaseRework = resolve; });
  const model = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const { messages } = JSON.parse(Buffer.concat(parts));
      const input = JSON.parse(messages.at(-1).content);
      let role, output;
      if (typeof input.document === 'string') {
        role = 'spec';
        output = calls.includes(role) ? spec : { ...spec, requirements: [], questions: ['公告默认显示哪一句话？'], clarificationRequired: true };
        if (calls.includes(role)) assert.match(input.document, /明天下午开会/u);
      } else if (input.spec) {
        role = 'plan'; output = plan;
      } else if (input.engineeringContract) {
        role = 'verification'; output = definition;
      } else if (Object.hasOwn(input, 'feedback')) {
        role = 'coding';
        const round = calls.filter(call => call === role).length + 1;
        let content = code;
        if (round === 1) content = code.replace('data-testid="notice"', 'data-testid="old-notice"');
        if (round === 2) {
          const evidence = JSON.parse(input.feedback);
          assert.equal(evidence.reviewStatus, 'not_started');
          assert.ok(evidence.browser.some(check => check.view === 'MOBILE' && check.testId === 'notice' && check.matches === 0));
          content = `${code}\n// known defect: POST returns the announcement page`;
        }
        if (round === 3) {
          const evidence = JSON.parse(input.feedback);
          assert.equal(evidence.issues.length, 1);
          content = code.replace("    if (request.path === '/favicon.ico')", "    if (request.method !== 'GET') return { status: 405, headers: {}, body: '' };\n    if (request.path === '/favicon.ico')");
        }
        output = { files: [{ path: 'src/app.mjs', content }] };
        if (round === 2) await allowRework;
      } else {
        role = 'review';
        const source = input.files.find(file => file.path === 'src/app.mjs');
        assert.ok(source.lines.some(({ text }) => text.includes('data-testid="notice"')), 'failing candidate is not sent for Review');
        const { line } = source.lines.find(({ text }) => text.includes('const body'));
        output = { summary: '本地固定审查响应', issues: source.lines.some(({ text }) => text.includes('// known defect'))
          ? [{ severity: 'blocking', file: source.path, line, message: '公告页也处理了未约定的 POST 请求，应该返回 405。' }] : [],
          resolutions: input.previousIssues.map(issue => ({ id: issue.id, status: 'resolved', reason: '同版本确认仅接受 GET 请求。' })) };
      }
      calls.push(role);
      if (role === 'coding') await allowCoding;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    } catch (error) { errors.push(error.message); res.writeHead(500); res.end(); }
  });
  await listen(model);
  const original = new Map(Object.entries(process.env).filter(([key]) => /^LLM_|^TASKFLOW_TEAM/u.test(key)));
  for (const key of original.keys()) delete process.env[key];
  const settings = { LLM_BASE_URL: `${endpoint(model)}/v1`, LLM_MODEL: 'local-homepage-fixture',
    LLM_API_KEY: 'local-homepage-test-credential', LLM_THINKING: 'disabled', TASKFLOW_TEAM_MODE: '0' };
  Object.assign(process.env, settings);
  t.after(async () => {
    releaseCoding(); releaseRework();
    try { await browser?.close(); await app?.close(); await new Promise(resolve => model.close(resolve)); }
    finally {
      for (const key of Object.keys(settings)) delete process.env[key];
      for (const [key, value] of original) process.env[key] = value;
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  app = await createApp({ dataDir: directory, stepDelayMs: 0 });
  await listen(app.server);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(endpoint(app.server));
  await stage(page, 'source').click();
  await page.getByRole('textbox', { name: '你想做什么？' }).fill(request);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.locator('#mode-select').selectOption('model');
  await page.locator('#start-run').click();
  await stage(page, 'spec').getByText('等待补充需求', { exact: true }).waitFor();
  await stage(page, 'spec').click();
  await page.getByRole('textbox', { name: /公告默认显示哪一句话/u }).fill(announcement);
  await page.getByRole('button', { name: '提交本轮回答', exact: true }).click();
  await stage(page, 'spec-approval').getByText('待你确认', { exact: true }).waitFor();
  await page.locator('#approve-button').click();
  await stage(page, 'plan-approval').getByText('待你确认', { exact: true }).waitFor();
  await page.locator('#approve-button').click();
  await stage(page, 'plan-approval').getByText('已确认', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await stage(page, 'verification').click();
  const verification = page.locator('#verification-plans-section');
  await verification.getByRole('checkbox').check();
  await verification.getByRole('button', { name: '生成独立测试提案', exact: true }).click();
  await stage(page, 'verification').getByText('待确认清单', { exact: true }).waitFor();
  // Add a later failure through the real API to reproduce a saved draft followed by a failed retry.
  const { projects: [project] } = await (await page.request.get(endpoint(app.server) + '/api/projects')).json();
  const { project: savedProject } = await (await page.request.get(endpoint(app.server) + '/api/projects/' + project.id)).json();
  const verificationApi = endpoint(app.server) + '/api/projects/' + project.id + '/runs/' + savedProject.runs[0].id + '/verification-plans';
  const { capabilities, proposals } = await (await page.request.get(verificationApi)).json();
  const verifiedDraft = proposals.find(row => row.status === 'draft');
  assert.ok(verifiedDraft);
  const additional = await page.request.post(verificationApi + '/propose', { data: { contractRevision: capabilities.contractRevision } });
  assert.equal(additional.status(), 202);
  await page.waitForFunction(async url => (await (await fetch(url)).json()).proposals.at(-1)?.status === 'failed', verificationApi);
  await page.reload();
  await stage(page, 'verification').getByText('待确认清单', { exact: true }).waitFor();
  await stage(page, 'verification').click();
  await verification.getByLabel('测试提案记录', { exact: true }).selectOption(verifiedDraft.id);
  assert.match(await verification.getByLabel('HTTP测试定义 JSON', { exact: true }).inputValue(), new RegExp(announcement, 'u'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await verification.getByLabel('修订或审阅依据（必填，最多5000字）', { exact: true }).fill('已核对公告的接口返回和浏览器显示内容。');
  await verification.getByRole('button', { name: '认可测试定义（尚未运行）', exact: true }).click();
  await stage(page, 'verification').getByText('清单已确认', { exact: true }).waitFor();
  await stage(page, 'coding').click();
  const execution = page.locator('#planned-execution-section');
  const begin = execution.getByRole('button', { name: '按当前规划开始开发', exact: true });
  const cancel = execution.getByRole('button', { name: '请求停止本次开发', exact: true });
  await execution.getByRole('checkbox').check();
  await begin.click();
  await stage(page, 'coding').getByText('正在编码', { exact: true }).waitFor({ timeout: 25000 });
  const locked = await (await page.request.get(verificationApi)).json();
  assert.equal(locked.capabilities.canImportDefinition, false);
  assert.ok(locked.proposals.some(row => row.status === 'approved'));
  assert.ok(locked.proposals.every(row => row.current === false));
  await page.reload();
  await stage(page, 'coding').getByText('正在编码', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await stage(page, 'verification').getAttribute('data-state'), 'done');
  assert.equal(await stage(page, 'coding').getAttribute('aria-current'), 'step');
  await stage(page, 'coding').click();
  await cancel.waitFor();
  assert.doesNotMatch(await stage(page, 'verification').innerText(), /清单准备未完成/u);
  const executionApi = verificationApi.replace(/verification-plans$/u, 'development-executions');
  releaseCoding();
  await stage(page, 'coding').getByText('已安排 1 次自动返工', { exact: true }).waitFor({ timeout: 50000 });
  assert.equal(await stage(page, 'coding').getAttribute('data-state'), 'working');
  await stage(page, 'testing').click();
  await execution.getByText('自检、HTTP与浏览器实际检查', { exact: true }).waitFor();
  releaseRework();
  const deadline = Date.now() + 90000;
  let result;
  do {
    ({ executions: [result] } = await (await page.request.get(executionApi)).json());
    if (!result.active && (result.accepted || result.status !== 'accepted')) break;
    await delay(750);
  } while (Date.now() < deadline);
  assert.equal(result.accepted, true, JSON.stringify({ status: result.status, workflow: result.workflow, error: result.error,
    checks: result.checks?.issues, calls, errors, recentEvents: result.events.slice(-8) }));
  assert.equal(result.workflow.reworkCount, 2);
  await stage(page, 'delivery').getByText('可预览与下载', { exact: true }).waitFor();
  await stage(page, 'delivery').click();
  await execution.getByRole('button', { name: '启动已验收软件预览', exact: true }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('link', { name: '打开软件预览', exact: true }).click();
  const software = await popup;
  await software.getByRole('heading', { name: announcement, exact: true }).waitFor();
  await software.close();
  await execution.getByRole('button', { name: '停止软件预览', exact: true }).click();
  const pending = page.waitForEvent('download');
  const download = execution.getByRole('link', { name: '下载当前已验收源码', exact: true });
  await download.click();
  const file = await pending;
  assert.match(file.suggestedFilename(), /\.zip$/u);
  const zip = await readFile(await file.path());
  assert.equal(zip.toString('hex', 0, 4), '504b0304');
  assert.ok(zip.includes(Buffer.from('delivery/manifest.json')));
  assert.ok(zip.includes(Buffer.from('src/app.mjs')));
  assert.ok(zip.includes(Buffer.from("request.method !== 'GET'")));
  await page.reload();
  await stage(page, 'delivery').getByText('可预览与下载', { exact: true }).waitFor();
  await stage(page, 'delivery').click();
  await download.waitFor();
  assert.deepEqual(calls, ['spec', 'spec', 'plan', 'verification', 'verification', 'coding', 'coding', 'review', 'coding', 'review']);
  assert.deepEqual(errors, []);
});
