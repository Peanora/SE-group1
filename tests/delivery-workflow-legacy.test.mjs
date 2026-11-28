import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { WORKFLOW } from '../lib/orchestrator.mjs';
import { analyzeRequirements, generateTasks, reviewPlan } from '../lib/planner.mjs';
import { deliverySteps } from '../public/delivery-workflow.js';
import { createApp } from '../server.mjs';

function oldRun(project, { status = 'awaiting_review', stageStatuses = {}, approvedAt = null } = {}) {
  const now = new Date().toISOString();
  const spec = analyzeRequirements(project.source.content, project.name, { workflowVersion: 1 });
  const tasks = generateTasks(spec, { workflowVersion: 1 });
  return {
    id: randomUUID(), projectId: project.id, status, mode: 'local', createdAt: now, updatedAt: now,
    spec, tasks, artifacts: [], review: reviewPlan(spec, tasks), feedback: '', approvedAt, events: [],
    stages: WORKFLOW.map(stage => {
      const status = stageStatuses[stage.id] ?? (stage.id === 'export' ? 'pending' : 'succeeded');
      return { ...stage, dependsOn: [...stage.dependsOn], status, attempt: status === 'pending' ? 0 : 1, history: [] };
    }),
  };
}

const source = { filename: 'legacy.md', content: '成员可以查看自己的预约。管理员可以创建可预约时段。' };
const projectName = '旧版预约规划';

test('legacy progress follows observed planning and export stages, even with stray newer approval and delivery fields', () => {
  const project = { id: 'legacy-project', name: projectName, source };
  const run = oldRun(project);
  const verification = { state: 'done', text: '清单已确认' };
  const development = { accepted: true, execution: { status: 'accepted', candidateCommit: 'abc' } };
  const automatic = { status: 'completed', downloadAvailable: true };
  const steps = state => Object.fromEntries(deliverySteps({
    project, run: { specRevision: 'spec-v2', planRevision: 'plan-v2',
      approvals: { spec: { revision: 'spec-v2' }, plan: { revision: 'plan-v2', specRevision: 'spec-v2' } }, ...state },
    verification, development, automatic,
  }).map(step => [step.id, step]));

  const pending = steps(run);
  assert.equal(pending.plan.state, 'done');
  assert.equal(pending['plan-approval'].text, '等待审阅');
  assert.equal(pending['plan-approval'].state, 'waiting');
  for (const id of ['spec-approval', 'verification', 'coding', 'testing', 'delivery']) {
    assert.equal(pending[id].state, 'unavailable');
  }

  const exporting = new Date().toISOString();
  const approved = steps(oldRun(project, { status: 'paused', approvedAt: exporting }));
  assert.equal(approved['plan-approval'].text, '已审阅，等待导出');
  const ready = steps(oldRun(project, { status: 'running', approvedAt: exporting, stageStatuses: { export: 'running' } }));
  assert.equal(ready['plan-approval'].state, 'working');
  const failed = steps(oldRun(project, { status: 'failed', stageStatuses: { review: 'failed' } }));
  assert.equal(failed.plan.state, 'done');
  assert.equal(failed['plan-approval'].state, 'failed');
  assert.equal(failed['plan-approval'].text, '计划检查未通过');
  const exported = steps(oldRun(project, { status: 'succeeded', approvedAt: exporting, stageStatuses: { export: 'succeeded' } }));
  assert.equal(exported['plan-approval'].state, 'done');
  assert.equal(exported['plan-approval'].text, '规划文档已导出');
});

test('Edge opens a persisted v1 run at its single review gate and finishes with the planning bundle', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-legacy-flow-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  app = await createApp({ dataDir: directory, teamEnabled: false, stepDelayMs: 0 });
  const project = await app.store.create({ name: projectName, source });
  const run = oldRun(project);
  project.runs.push(run);
  await app.store.save(project);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  page.on('request', request => {
    if (request.method() === 'POST') mutations.push(request.postDataJSON());
  });
  const projectUrl = 'http://127.0.0.1:' + app.server.address().port + '/?' + new URLSearchParams({ project: project.id, run: run.id });
  await page.goto(projectUrl + '&view=overview');
  await page.waitForURL(projectUrl + '&view=source');
  assert.equal(await page.locator('#workspace-tab-source').getAttribute('aria-selected'), 'true');
  await page.locator('#studio-workflow-scope').waitFor();
  await page.locator('#delivery-current-state').getByText('等待审阅', { exact: true }).waitFor();
  assert.match(await page.locator('#delivery-done-count').innerText(), /3\s*\/\s*4/u);
  assert.deepEqual(await page.locator('[data-delivery-step]').evaluateAll(nodes => nodes.map(node => node.dataset.deliveryStep)),
    ['source', 'spec', 'plan', 'plan-approval']);
  const exportStep = page.locator('[data-delivery-step="plan-approval"]');
  assert.equal(await exportStep.getAttribute('aria-current'), 'step');
  await exportStep.click();
  await page.getByRole('heading', { name: '旧版记录：开发计划等待审阅' }).waitFor();
  assert.deepEqual(mutations, []);
  await page.getByRole('button', { name: '确认并导出', exact: true }).click();
  await page.locator('#download-bundle').waitFor();
  await exportStep.getByText('规划文档已导出', { exact: true }).waitFor();
  assert.match(await page.locator('#delivery-done-count').innerText(), /4\s*\/\s*4/u);
  assert.equal(run.workflowVersion, undefined);
  assert.equal(run.approvals, undefined);
  assert.deepEqual(mutations.map(action => action.action), ['approve']);
  assert.equal(await page.locator('#automatic-download').isVisible(), false);
  await exportStep.click();
  await page.locator('[data-artifact="handoff.md"][aria-pressed="true"]').waitFor();
  await page.locator('#workspace-tab-execution').click();
  await page.getByRole('heading', { name: '旧版规划记录', exact: true }).waitFor();
  assert.equal(await page.locator('#execution-workspace-steps').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
