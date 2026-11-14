import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';
import { createEngineeringModel } from '../lib/engineering-model.mjs';
import { planningRevision } from '../lib/planning-review.mjs';

test('actual model-planning UI discloses its budget, preserves engineering task boundaries and confirms the edited version', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'engineering-planning-browser-'));
  const content = '申请者可以查看可预约资源。';
  const spec = { title: '资源规划界面检查', summary: content, goals: [], roles: ['申请者：查看资源'], acceptanceScenarios: [], constraints: [], assumptions: [], questions: [],
    stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ id: 'R1', title: '查看资源', description: content, sourceQuote: content, acceptance: ['展示可用资源'] }], sourceMode: 'model' };
  const proposal = { version: 1, title: '资源工程草案', summary: '实现确认的资源接口与页面',
    entities: [{ id: 'RESOURCE', name: '资源', fields: [{ name: 'id', type: 'string', required: true, unique: true }], constraints: ['标识唯一'] }],
    routes: [{ id: 'LIST', method: 'GET', path: '/api/resources', roles: ['ROLE-001'], request: '无正文', response: '资源列表', errors: [{ status: 401, reason: '尚未登录' }], requirementIds: ['R1'] }],
    views: [{ id: 'HOME', path: '/', title: '资源列表', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }],
    tasks: [{ id: 'DEV-R1', title: '实现资源契约', description: '实现确认接口和页面', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs', 'public/app.js'], inputs: ['已确认资源规格'], outputs: ['资源接口与页面'], acceptance: ['展示可用资源'] }] };
  let specs = 0, designs = 0;
  const config = { baseUrl: 'https://model.invalid/v1', model: 'engineering-browser-mock', apiKey: 'synthetic-browser-private-key' };
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner,
    getModelConfig: () => ({ configured: true, model: config.model }),
    analyzeWithModel: async () => { specs++; return structuredClone(spec); },
    createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async () => {
      designs++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 23, completion_tokens: 34 } }));
    } }),
  }, executionService: { list: async () => ({ capabilities: { canStart: false, profiles: [], reason: '本用例仅检查工程规划。' }, executions: [] }), shutdown: async () => {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => { await browser.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('engineering-planning-browser-')); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const project = await app.store.create({ name: '工程规划界面检查', source: { filename: 'requirements.md', content } });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  await page.goto(url); await page.waitForFunction(() => !document.querySelector('#start-run').disabled);
  assert.equal(await page.locator('#planning-model-notice').isVisible(), false);
  await page.locator('#mode-select').selectOption('model');
  assert.match(await page.locator('#planning-model-notice').textContent(), /最多尝试 3 次，单次最多 60 秒/u);
  assert.match(await page.locator('#planning-model-notice').textContent(), /确认规格后.*工程设计.*产生用量/u);
  await page.locator('#start-run').click();
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  assert.equal(specs, 1); assert.equal(designs, 0);
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).click();
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  assert.equal(designs, 1);
  assert.match(await page.locator('#planning-model-notice').textContent(), /输入 23、输出 34 token/u);
  const run = app.store.get(project.id).runs.at(-1), originalHash = run.engineeringPlan.hash, originalTask = structuredClone(run.tasks[0]);
  assert.equal(run.planRevision, planningRevision(run));
  await page.locator('#tab-tasks').click();
  for (const text of ['计划修改范围', 'src/app.mjs', '输入资料', '已确认资源规格', '预期产出', '资源接口与页面']) assert.ok((await page.locator('.task-detail').textContent()).includes(text), text);
  const title = page.locator('[data-review-field="task.0.title"]');
  await title.fill('明确资源读取与异常分支'); await title.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await title.evaluate(element => document.activeElement === element), true);
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await page.waitForFunction(() => { const button = document.querySelector('#approve-button'); return button && !button.disabled; });
  assert.equal(designs, 1); assert.notEqual(run.engineeringPlan.hash, originalHash);
  assert.deepEqual(run.tasks[0].writePaths, originalTask.writePaths);
  assert.deepEqual(run.tasks[0].inputs, originalTask.inputs); assert.deepEqual(run.tasks[0].outputs, originalTask.outputs);
  assert.equal(run.engineeringPlan.proposal.tasks[0].title, '明确资源读取与异常分支');
  assert.equal(run.planRevision, planningRevision(run));
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click();
  await page.locator('#download-bundle').waitFor({ state: 'visible' });
  const download = await fetch(url + new URL(await page.locator('#download-bundle').getAttribute('href'), url).pathname);
  assert.equal(download.status, 200); const zip = Buffer.from(await download.arrayBuffer());
  assert.ok(zip.includes(Buffer.from('engineeringPlan')));
  for (const privateText of [config.apiKey, directory, 'engineering-receipts']) assert.equal(zip.includes(Buffer.from(privateText)), false);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#run-status')?.classList.contains('status-succeeded'));
  assert.equal(designs, 1); assert.equal(specs, 1); assert.equal(run.approvals.plan.revision, run.planRevision);
  assert.deepEqual(errors, []);
});
