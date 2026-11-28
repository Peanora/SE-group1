import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { simulationPlanner } from '../examples/simulation-fixture.mjs';

const firstCommit = '1'.repeat(40), siblingCommit = '2'.repeat(40), repairedCommit = '3'.repeat(40);
const firstAttempt = 'first-b', siblingAttempt = 'first-c', repairedAttempt = 'repair-b';
const fixtureTime = '2026-11-28T04:00:00.000Z';
const reviewCall = (taskId, attemptId, candidateCommit) => ({
  id: `review-${attemptId}`, role: 'review', taskId, attemptId, candidateCommit,
  attempt: 1, requestState: 'in_flight', startedAt: fixtureTime, finishedAt: null,
});
const reviewRecord = (taskId, attemptId, candidateCommit, status, issues = []) => ({
  taskId, attemptId, candidateCommit, status, issues, attempt: 1,
});
const passChecks = { http: [{ id: 'HTTP-1', passed: true }], browser: [{ id: 'EDGE-1', passed: true }], issues: [] };
const blocker = { id: 'REVIEW-1', severity: 'blocking', status: 'open', file: 'src/b.mjs', line: 1,
  message: '场地查询未筛选已停用记录', evidence: 'return allRecords;' };
const flow = page => page.locator('#task-review-flow');
const review = (page, id) => page.locator(`[data-task-review="${id}"]`);
const task = (page, id) => page.locator(`.dev-task[data-task="${id}"]`);
const returnPath = (page, id) => page.locator('.plan-task-node').filter({ has: review(page, id) }).locator('.task-review-return');

async function settle(app, run, status) {
  const deadline = Date.now() + 10000;
  while (run.status !== status || app.orchestrator.state(run).driving) {
    assert.ok(Date.now() < deadline, `等待 ${status} 超时`);
    await delay(20);
  }
}

test('Edge 工作流从任务图核对同一候选的 Review，独立审查通过仍须等待集成', { timeout: 75000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-task-review-'));
  let app, browser, execution;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^taskflow-task-review-/u);
    await rm(directory, { recursive: true, force: true });
  });
  app = await createApp({
    dataDir: directory, teamEnabled: false, stepDelayMs: 0, localLifecycleEnabled: false,
    planner: { ...simulationPlanner, getModelConfig: () => ({ configured: false, model: null }) },
  });
  const project = await app.store.create({ name: '任务审查验收', source: { filename: 'workflow.md', content: 'A 完成后同时检查 B 和 C，再启动 D。' } });
  const run = await app.orchestrator.createRun(project.id, { mode: 'local' });
  await settle(app, run, 'awaiting_spec');
  await app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
  await settle(app, run, 'awaiting_review');
  await app.orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision });
  await settle(app, run, 'succeeded');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const runPath = `/api/projects/${project.id}/runs/${run.id}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [], writes = [];
  const pages = await Promise.all([1440, 390].map(async width => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route(`${url}${runPath}/development-executions`, route =>
      route.fulfill({ json: { capabilities: { canStart: false }, executions: execution ? [execution] : [] } }));
    await page.goto(`${url}/?project=${project.id}&run=${run.id}&view=tasks`);
    await review(page, 'B').waitFor();
    if (width === 390) await review(page, 'B').tap();
    else await review(page, 'B').press('Enter');
    await page.locator('#task-review-flow[data-review-task="B"][data-review-state="planned"]').waitFor();
    assert.equal(await flow(page).evaluate(element => document.activeElement === element), true);
    const widthMetrics = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    assert.ok(widthMetrics.document <= widthMetrics.viewport + 1, JSON.stringify(widthMetrics));
    return page;
  }));

  const baseTask = (id, extra = {}) => {
    const plan = run.tasks.find(task => task.id === id);
    return { id, title: plan.title, dependsOn: plan.dependsOn, status: 'pending', checks: null, ...extra };
  };
  const reviewing = (id, attemptId, checks = passChecks) => baseTask(id, {
    status: 'running', stage: 'validating', attemptId, checks,
  });
  const publish = ({ tB, tC = reviewing('C', siblingAttempt), tD = baseTask('D'), reviewHistory, calls = [], status = 'running', active = true }) => {
    execution = {
      id: 'parallel-review-fixture', runId: run.id, projectId: project.id, kind: 'planned_web', executionMode: 'task_dag',
      active, status, current: true, accepted: false, createdAt: fixtureTime,
      binding: { projectId: project.id, runId: run.id, sourceRevision: run.sourceRevision, sourceGeneration: run.sourceGeneration,
        specRevision: run.specRevision, planRevision: run.planRevision },
      workflow: { reviewPending: true, stage: 'review' }, tasks: [baseTask('A', { status: 'completed' }), tB, tC, tD, baseTask('E')],
      modelCalls: calls, reviewHistory, actions: {}, events: [],
    };
  };
  const inspect = work => Promise.all(pages.map(work));
  const waitReview = (page, expression) => page.locator(`#task-review-flow[data-review-task="B"]${expression}`).waitFor();

  const firstReviews = [reviewRecord('B', firstAttempt, firstCommit, 'not_started'), reviewRecord('C', siblingAttempt, siblingCommit, 'not_started')];
  const siblingCall = reviewCall('C', siblingAttempt, siblingCommit);
  publish({ tB: reviewing('B', firstAttempt, { http: passChecks.http, browser: [] }), reviewHistory: firstReviews, calls: [siblingCall] });
  await inspect(async page => {
    await waitReview(page, `[data-review-commit="${firstCommit}"][data-review-state="waiting"]`);
    assert.notEqual(await flow(page).locator('[data-review-step="browser"]').getAttribute('data-state'), 'passed');
    assert.equal(await task(page, 'D').getAttribute('data-gate-state'), 'waiting');
  });
  await inspect(async page => {
    await review(page, 'C').press('Enter');
    await page.locator(`#task-review-flow[data-review-task="C"][data-review-state="checking"][data-review-commit="${siblingCommit}"]`).waitFor();
    await review(page, 'B').press('Enter');
    await waitReview(page, '[data-review-state="waiting"]');
  });

  const firstCall = reviewCall('B', firstAttempt, firstCommit);
  publish({ tB: reviewing('B', firstAttempt), reviewHistory: firstReviews, calls: [siblingCall, { ...firstCall, requestState: 'prepared' }] });
  await inspect(async page => {
    await flow(page).locator('[data-review-step="http"][data-state="passed"]').waitFor();
    await flow(page).locator('[data-review-step="browser"][data-state="passed"]').waitFor();
    assert.equal(await flow(page).getAttribute('data-review-state'), 'waiting');
  });
  publish({ tB: reviewing('B', firstAttempt), reviewHistory: firstReviews, calls: [siblingCall, firstCall] });
  await inspect(async page => {
    await waitReview(page, '[data-review-state="checking"]');
    assert.equal(await review(page, 'B').getAttribute('data-review-state'), 'checking');
    assert.equal(await flow(page).evaluate(element => document.activeElement === element), true);
    assert.equal(await task(page, 'D').getAttribute('data-gate-state'), 'waiting');
  });

  const rejected = reviewRecord('B', firstAttempt, firstCommit, 'completed', [blocker]);
  publish({ tB: baseTask('B', { status: 'failed', stage: 'failed', attemptId: firstAttempt, candidateCommit: firstCommit,
    checks: { ...passChecks, review: 'completed', issues: [blocker] } }),
    tD: baseTask('D', { status: 'blocked' }), reviewHistory: [rejected], status: 'failed', active: false });
  await inspect(async page => {
    await waitReview(page, '[data-review-state="failed"]');
    assert.equal(await review(page, 'B').getAttribute('data-review-state'), 'failed');
    assert.equal(await returnPath(page, 'B').getAttribute('data-review-loop'), 'blocked');
    assert.equal(await flow(page).locator('[data-blocking="true"]').filter({ hasText: blocker.message }).isVisible(), true);
    assert.equal(await task(page, 'B').getAttribute('data-gate-state'), 'failed');
    assert.equal(await task(page, 'D').getAttribute('data-gate-state'), 'waiting');
  });

  const repaired = reviewRecord('B', repairedAttempt, repairedCommit, 'not_started', [blocker]);
  // The older closure at a different attempt/commit remains history only.
  const historical = reviewRecord('B', firstAttempt, firstCommit, 'completed');
  const completedC = baseTask('C', { status: 'completed', attemptId: siblingAttempt, candidateCommit: siblingCommit });
  publish({ tB: { ...reviewing('B', repairedAttempt, { http: [], browser: [] }), candidateCommit: repairedCommit },
    tC: completedC, reviewHistory: [historical, repaired], calls: [reviewCall('B', firstAttempt, firstCommit)] });
  await inspect(async page => {
    await waitReview(page, `[data-review-commit="${repairedCommit}"][data-review-attempt="${repairedAttempt}"]`);
    assert.ok(['waiting', 'unknown'].includes(await flow(page).getAttribute('data-review-state')));
    assert.equal(await returnPath(page, 'B').getAttribute('data-review-loop'), 'conditional');
    assert.equal(await task(page, 'D').getAttribute('data-gate-state'), 'waiting');
  });

  const approved = { ...repaired, status: 'completed', issues: [{ ...blocker, status: 'resolved', checkedCommit: repairedCommit }] };
  const verified = baseTask('B', { status: 'verified', stage: 'accepted', attemptId: repairedAttempt,
    candidateCommit: repairedCommit, checks: { ...passChecks, review: 'completed' } });
  publish({ tB: verified, tC: completedC, reviewHistory: [historical, approved] });
  await inspect(async page => {
    await waitReview(page, '[data-review-state="passed"]');
    assert.equal(await flow(page).locator('[data-review-step="release"]').getAttribute('data-state'), 'waiting');
    assert.equal(await task(page, 'B').getAttribute('data-gate-state'), 'checking');
    assert.equal(await task(page, 'D').getAttribute('data-gate-state'), 'waiting');
  });

  publish({ tB: { ...verified, status: 'completed' }, tC: completedC, tD: baseTask('D', { status: 'running', stage: 'generating' }),
    reviewHistory: [historical, approved] });
  await inspect(async page => {
    await flow(page).locator('[data-review-step="release"][data-state="passed"]').waitFor();
    assert.equal(await task(page, 'D').getAttribute('data-gate-state'), 'checking');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await flow(page).locator(`[data-task-review-evidence][data-trace-commit="${repairedCommit}"]`).click();
    await page.locator(`#workspace-execution .pe-process-inspector[data-task-id="B"][data-candidate-commit="${repairedCommit}"]`).waitFor();
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
});
