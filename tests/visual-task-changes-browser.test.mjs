import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';
import { createEngineeringModel } from '../lib/engineering-model.mjs';
import { planningRevision } from '../lib/planning-review.mjs';

async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await delay(10);
  }
}

async function fixture(t, width) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'visual-task-changes-browser-'));
  const content = '申请者可以查看可预约资源。\n申请者可以查看资源说明。';
  const requirements = content.split('\n').map((line, index) => ({ id: `R-00${index + 1}`, title: index ? '查看资源说明' : '查看可预约资源', description: line, sourceQuote: line, acceptance: [index ? '展示资源说明' : '展示可用资源'] }));
  const spec = { title: '可视化任务编辑', summary: content, goals: [], roles: ['申请者：查看资源'], acceptanceScenarios: [], constraints: [], assumptions: [], questions: [],
    stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' }, requirements, sourceMode: 'model' };
  const definitions = [
    ['A', [], '准备资源契约', 'src/bootstrap.mjs', ['R-001', 'R-002']],
    ['B', ['A'], '实现资源读取', 'src/resources.mjs', ['R-001']],
    ['C', ['A'], '实现资源说明页面', 'public/resources.js', ['R-002']],
    ['D', ['B', 'C'], '验证资源页面与接口', 'tests/resources.test.mjs', ['R-001', 'R-002']],
    ['E', ['D'], '整理资源使用说明', 'docs/resources.md', ['R-001', 'R-002']],
  ];
  const tasks = definitions.map(([id, dependsOn, title, filename, requirementIds]) => ({ id, title, description: `完成${title}并覆盖异常分支`, dependsOn, requirementIds,
    writePaths: [filename], inputs: ['已确认资源规格', ...dependsOn.map(value => `任务${value}输出`)], outputs: [`${title}产物`], acceptance: [`核对${title}结果`] }));
  const proposal = { version: 1, title: '资源工程草案', summary: '实现已确认的资源读取与说明',
    entities: [{ id: 'RESOURCE', name: '资源', fields: [{ name: 'id', type: 'string', required: true, unique: true }], constraints: ['标识唯一'] }],
    routes: [{ id: 'LIST', method: 'GET', path: '/api/resources', roles: ['ROLE-001'], request: '无正文', response: '资源及说明列表', errors: [{ status: 401, reason: '尚未登录' }], requirementIds: ['R-001', 'R-002'] }],
    views: [{ id: 'HOME', path: '/', title: '资源列表', requirementIds: ['R-001', 'R-002'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks };
  const calls = { specifications: 0, engineering: 0 };
  const config = { baseUrl: 'https://model.invalid/v1', model: 'visual-task-fixture', apiKey: 'synthetic-visual-task-fixture' };
  let browser;
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner,
    getModelConfig: () => ({ configured: true, model: config.model }),
    analyzeWithModel: (text, name, options) => {
      calls.specifications++;
      return planner.analyzeWithModel(text, name, { ...options, config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(spec) } }] })) });
    },
    createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async () => {
      calls.engineering++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 23, completion_tokens: 34 } }));
    } }),
  } });
  const errors = [];
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('visual-task-changes-browser-'));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const project = await app.store.create({ name: `任务编辑浏览器${width}`, source: { filename: 'requirements.md', content } });
  const run = await app.orchestrator.createRun(project.id, { mode: 'model' });
  await until(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving, '规格待确认');
  await app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
  await until(() => run.status === 'awaiting_review' && !app.orchestrator.state(run).driving, '计划待确认');
  assert.deepEqual(calls, { specifications: 1, engineering: 1 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  await page.goto(`http://127.0.0.1:${app.server.address().port}/?view=details`);
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  return { app, project, run, page, calls, content };
}

for (const width of [1440, 390]) test(`真实Edge ${width}px：从任务图编辑、预览及保存新计划，确认和旧需求门禁保持`, { timeout: 90000 }, async t => {
  const { app, project, run, page, calls, content } = await fixture(t, width);
  const original = structuredClone({ tasks: run.tasks, revision: run.planRevision, engineering: run.engineeringPlan, specRevision: run.specRevision });
  await page.locator('#tab-tasks').click();
  const selectedNode = page.locator('.dev-task[data-task="B"]');
  await selectedNode.click();
  assert.equal(await selectedNode.getAttribute('aria-pressed'), 'true');
  await page.locator('[data-edit-selected-task]').click();
  const title = page.locator('[data-review-field="task.1.title"]');
  assert.equal(await page.locator('[data-review-details="task-1"]').evaluate(element => element.open), true);
  assert.equal(await title.evaluate(element => document.activeElement === element), true);
  const changedTitle = '明确资源读取及库存不足提示';
  const changedModuleName = '资源读取与库存提示';
  await title.fill(changedTitle);
  const moduleName = page.locator('[data-review-field="module.1.name"]');
  await moduleName.fill(changedModuleName);
  await page.waitForFunction(value => document.querySelector('.dev-task[data-task="B"] .dev-task-title')?.textContent === value, changedModuleName);
  assert.equal(await page.locator('.task-detail .module-task-action').textContent(), changedTitle);
  const preview = page.locator('#review-plan-preview');
  assert.match(await preview.textContent(), /实现资源读取/);
  assert.ok((await preview.textContent()).includes(changedTitle));
  assert.match(await preview.textContent(), /2 项下游任务/);
  assert.equal(await selectedNode.evaluate(element => element.classList.contains('draft-changed')), true);
  for (const id of ['D', 'E']) assert.equal(await page.locator(`.dev-task[data-task="${id}"]`).evaluate(element => element.classList.contains('draft-downstream')), true);
  assert.equal(await page.locator('.dev-task[data-task="C"]').evaluate(element => element.classList.contains('draft-downstream')), false);
  assert.equal(run.tasks[1].title, original.tasks[1].title, '未保存草稿不能修改后端计划');
  const prerequisite = id => page.locator(`[data-review-choice="dependsOn"][data-task-index="1"][value="${id}"]`);
  for (const id of ['B', 'D', 'E']) assert.equal(await prerequisite(id).isDisabled(), true, `禁用${id}以避免依赖环`);
  assert.equal(await prerequisite('A').isChecked(), true);
  assert.equal(await prerequisite('C').isEnabled(), true);
  await preview.locator('.review-change > summary').click();
  await prerequisite('C').check();
  await page.locator('[data-review-choice="requirementIds"][data-task-index="1"][value="R-002"]').check();
  assert.match(await preview.textContent(), /前置任务/);
  assert.match(await preview.textContent(), /需求来源/);
  assert.equal(await page.locator('#approve-button').isDisabled(), true, '未保存草稿不能确认');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await preview.locator('[data-change-task="B"]').evaluate(element => element.open), true, '输入与状态更新应保留已展开的修改对照');
  assert.equal(await preview.locator('pre').first().isVisible(), true);
  const evidence = path.resolve('output', 'visual-task-changes'); await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `task-editor-${width}.png`), fullPage: true });

  await page.reload();
  await page.locator('[data-workspace-view="plan"]').click();
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  assert.equal(await title.inputValue(), changedTitle);
  assert.equal(await moduleName.inputValue(), changedModuleName);
  assert.equal(await prerequisite('C').isChecked(), true);
  assert.equal(await page.locator('[data-review-choice="requirementIds"][data-task-index="1"][value="R-002"]').isChecked(), true);
  await page.locator('#tab-tasks').click();
  assert.equal(await selectedNode.getAttribute('aria-pressed'), 'true', '刷新后仍保留当前所选任务B');
  assert.equal(await page.locator('.dev-task[aria-pressed="true"]').count(), 1);
  await page.locator('[data-edit-selected-task]').click();
  assert.equal(await title.evaluate(element => document.activeElement === element), true);
  assert.equal(await selectedNode.evaluate(element => element.classList.contains('draft-changed')), true);
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await until(() => run.status === 'awaiting_review' && run.planRevision !== original.revision && !app.orchestrator.state(run).driving, '新计划重新检查');
  await page.waitForFunction(() => document.querySelector('#approve-button') && !document.querySelector('#approve-button').disabled);
  assert.deepEqual(calls, { specifications: 1, engineering: 1 }, '保存任务修订不能重新调用模型');
  assert.equal(run.tasks[1].title, changedTitle);
  assert.equal(run.tasks[1].workflowModule.name, changedModuleName);
  assert.deepEqual(run.tasks[1].dependsOn, ['A', 'C']);
  assert.deepEqual(run.tasks[1].requirementIds, ['R-001', 'R-002']);
  for (const key of ['category', 'writePaths', 'suggestedFiles', 'inputs', 'outputs']) assert.deepEqual(run.tasks[1][key], original.tasks[1][key], `保留工程字段${key}`);
  assert.equal(run.planRevision, planningRevision(run));
  assert.equal(run.specRevision, original.specRevision);
  assert.equal(run.approvals.plan, null);
  assert.equal(run.artifacts.some(item => item.name === 'plan.json'), false, '确认计划前不能导出');
  assert.equal(run.revisionHistory.plan.length, 1);
  assert.equal(run.revisionHistory.plan[0].revision, original.revision);
  assert.deepEqual(run.revisionHistory.plan[0].tasks, original.tasks);
  assert.deepEqual(run.revisionHistory.plan[0].engineeringPlan, original.engineering);
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click();
  await until(() => run.status === 'succeeded' && !app.orchestrator.state(run).driving, '确认后导出完成');
  await page.locator('#download-bundle').waitFor({ state: 'visible' });
  assert.equal(run.approvals.plan.revision, run.planRevision);
  const exported = JSON.parse(run.artifacts.find(item => item.name === 'plan.json').content);
  assert.equal(exported.tasks[1].title, changedTitle);
  assert.equal(exported.tasks[1].workflowModule.name, changedModuleName);
  assert.equal(exported.planRevision, run.planRevision);
  const flow = page.locator('#delivery-workflow');
  assert.equal(await flow.evaluate(element => element.open), true);
  assert.equal(await flow.locator('#delivery-steps').getByRole('button').count(), 9);
  assert.equal(await flow.locator('[data-delivery-step="plan-approval"]').getAttribute('data-state'), 'done');
  await flow.locator('[data-delivery-step="coding"]').click();
  const prepare = page.getByRole('button', { name: '去准备验收清单', exact: true });
  await prepare.click();
  assert.equal(await page.locator('#verification-plans-section').evaluate(section => section.open), true);
  assert.equal(await page.locator('#execution-tools').evaluate(section => section.open), false);
  await flow.locator('[data-delivery-step="plan"]').click();
  assert.equal(await page.locator('[data-edit-selected-task]').isEnabled(), true);
  assert.equal(await page.locator('[data-add-feature]').isEnabled(), true);
  await page.locator('[data-edit-selected-task]').click();
  assert.equal(await page.locator('#task-edit-dialog').evaluate(dialog => dialog.open), true);
  await title.fill('修订已确认的资源任务');
  assert.equal(run.approvals.plan.revision, exported.planRevision, '打开和编辑草稿不改变已确认版本');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  assert.equal(run.approvals.plan, null);
  assert.equal(run.approvals.spec.revision, original.specRevision);
  assert.equal(run.revisionHistory.plan.at(-1).revision, exported.planRevision);
  assert.equal(run.revisionHistory.plan.at(-1).approvals.plan.revision, exported.planRevision);
  assert.equal(run.tasks[1].title, '修订已确认的资源任务');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

  const change = app.sourceChangeService.request({ projectId: project.id, baseRevision: app.store.getSourceVersion(project.id).revision,
    source: { filename: 'requirements.md', content: `${content}\n申请者可以按名称筛选资源。` }, reason: '明确后续新增筛选功能', kind: 'other', requestKey: `visual-task-history-${width}` });
  await app.sourceChangeService.apply({ projectId: project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation });
  await page.waitForFunction(() => document.querySelector('#review-heading')?.textContent === '历史需求输入：确认记录只读');
  assert.equal(run.sourceSuperseded, true);
  assert.equal(await page.locator('[data-review-action]').count(), 0);
  assert.equal(await page.locator('[data-edit-selected-task]').isDisabled(), true);
  assert.equal(await page.locator('.dev-task.draft-changed').count(), 0);
  await assert.rejects(app.orchestrator.action(project.id, run.id, { action: 'revise_plan', revision: run.planRevision, tasks: structuredClone(run.tasks) }), { status: 409, code: 'source_superseded' });
  assert.deepEqual(calls, { specifications: 1, engineering: 1 });
});

test('全流程以当前版本的实际记录更新，并定位验收清单、检查明细和交付', { timeout: 60000 }, async t => {
  const { page, project, run } = await fixture(t, 1440);
  const base = `/api/projects/${project.id}/runs/${run.id}`;
  const revision = 'a'.repeat(64), policyHash = 'b'.repeat(64);
  const binding = { projectId: project.id, runId: run.id, specRevision: run.specRevision, planRevision: run.planRevision,
    sourceRevision: run.sourceRevision, sourceGeneration: 0, policyHash, engineeringHash: 'c'.repeat(64), contextHash: 'd'.repeat(64) };
  const definition = { id: 'joint-qa', projectId: project.id, runId: run.id, binding, current: true, approved: true, status: 'approved',
    policyHash, revision, manifestHash: 'e'.repeat(64), coverage: 'structural_only', executed: false, approval: { phase: 'definition_only' },
    proposal: { name: '资源验收清单', version: 1, steps: [{ id: 'read' }], browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'visible' }] } } };
  let approved = false, execution = null;
  const budget = { maxCalls: 3, maxReviewCalls: 3, maxAttempts: 3, remainingAttempts: 3, totalModelCalls: 18, remainingModelCalls: 18, timeoutMs: 600000 };
  await page.route(`**${base}/verification-plans`, route => route.fulfill({ json: { coverage: 'structural_only', capabilities: {}, proposals: approved ? [definition] : [] } }));
  await page.route(`**${base}/development-executions`, route => route.fulfill({ json: { capabilities: { canStart: approved, contractRevision: revision,
    model: { name: 'fixture' }, budget, reason: approved ? '' : '必须先认可当前联合HTTP与浏览器验收定义。' }, executions: execution ? [execution] : [] } }));
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click();
  assert.equal(await page.locator('#delivery-workflow').evaluate(element => element.open), true);
  const step = id => page.locator(`[data-delivery-step="${id}"]`);
  await step('verification').getByText('待准备清单', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开验收清单', exact: true }).click();
  assert.equal(await page.locator('#verification-plans-section > summary').evaluate(element => document.activeElement === element), true);
  approved = true;
  await step('coding').click();
  const refresh = page.getByRole('button', { name: '刷新开发状态', exact: true });
  await refresh.click();
  await step('verification').getByText('清单已确认', { exact: true }).waitFor();
  await step('coding').getByText('待开始开发', { exact: true }).waitFor();
  const start = page.getByRole('button', { name: '按当前规划开始开发', exact: true });
  assert.equal(await start.isDisabled(), true, '知悉预算之前禁止开始');
  await page.locator('.planned-execution [type="checkbox"]').check();
  assert.equal(await start.isEnabled(), true);
  execution = { id: 'fixture-run', projectId: project.id, runId: run.id, kind: 'planned_web', current: true, binding,
    proposalId: definition.id, revision, active: true, status: 'validating', candidateCommit: '1'.repeat(40), tasks: [], actions: {} };
  await refresh.click();
  await step('testing').getByText('正在检查候选', { exact: true }).waitFor();
  assert.equal(await step('delivery').getAttribute('data-state'), 'idle');
  await step('testing').click();
  assert.equal(await page.getByText('自检、HTTP与浏览器实际检查', { exact: true }).evaluate(element => element.parentElement.open && document.activeElement === element), true);
  execution = { ...execution, active: false, status: 'accepted', accepted: true, actions: { canPreview: true, canDownload: true },
    checks: { http: [{ passed: true }], browser: [{ passed: true }, { passed: true }], review: 'completed', issues: [] } };
  await refresh.click();
  await step('testing').getByText('HTTP 1/1，浏览器 2/2', { exact: true }).waitFor();
  await step('delivery').click();
  assert.equal(await page.getByRole('heading', { name: '软件预览' }).evaluate(element => document.activeElement === element), true);
  assert.equal(await page.getByRole('link', { name: '下载当前已验收源码' }).isVisible(), true);
});
