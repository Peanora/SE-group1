import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { simulationPlanner } from '../examples/simulation-fixture.mjs';

async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await delay(20);
  }
}

async function fixture(t, { width, planner = simulationPlanner, teamEnabled = false, name = '分叉汇合验收', content = 'A 完成后执行 B 和 C，随后检查 D 并执行 E。' }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-orchestration-browser-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('task-orchestration-browser-'));
    await rm(directory, { recursive: true, force: true });
  });
  app = await createApp({ dataDir: directory, stepDelayMs: 0, teamEnabled,
    planner: { ...planner, getModelConfig: () => ({ configured: false, model: null }) } });
  const project = await app.store.create({ name, source: { filename: 'requirements.md', content } });
  const run = await app.orchestrator.createRun(project.id, { mode: 'local' });
  const settled = status => run.status === status && !app.orchestrator.state(run).driving;
  await until(() => settled('awaiting_spec'), '规格待确认');
  await app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
  await until(() => settled('awaiting_review'), '计划待确认');
  assert.equal(run.approvals.spec.revision, run.specRevision);
  assert.equal(run.approvals.plan, null);

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return { app, project, run, settled, page, origin };
}

async function openTasks(page, origin) {
  await page.goto(`${origin}/?view=details`);
  await page.getByRole('tab', { name: /开发任务/ }).click();
  const root = page.locator('.task-orchestration-root');
  await root.getByText('计划待确认', { exact: true }).waitFor();
  return root;
}

for (const width of [1440, 390]) test(`真实 Edge ${width}px：开发任务依赖、画布与计划确认`, { timeout: 60000 }, async t => {
  const { project, run, settled, page, origin } = await fixture(t, { width });
  const errors = [];
  const posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  page.on('request', request => {
    if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  const root = await openTasks(page, origin);
  const control = name => root.getByRole('button', { name, exact: true });
  const task = root.locator('.dev-task[data-task="B"]');
  const noPageOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  await task.click();
  assert.equal(await task.getAttribute('aria-pressed'), 'true');
  const inspector = root.locator('.task-detail');
  for (const label of ['前置任务', '后续任务', '验收条件']) {
    assert.equal(await inspector.getByRole('heading', { name: label, exact: true }).isVisible(), true);
  }
  assert.match(await inspector.textContent(), /核对分支B模拟结果/);

  const focus = control('突出关联');
  assert.equal(await focus.getAttribute('aria-pressed'), 'false');
  await focus.click();
  assert.equal(await focus.getAttribute('aria-pressed'), 'true');
  assert.equal(await root.locator('.task-edge.relation-upstream').count(), 1);
  assert.equal(await root.locator('.task-edge.relation-downstream').count(), 2);
  await focus.click();
  assert.equal(await focus.getAttribute('aria-pressed'), 'false');

  const zoom = root.locator('[data-task-zoom-value]');
  const zoomPercent = async () => Number.parseInt(await zoom.innerText(), 10);
  const baselineZoom = await zoomPercent();
  assert.ok(baselineZoom > 0);
  await control('放大').click();
  const increasedZoom = await zoomPercent();
  assert.ok(increasedZoom > baselineZoom);
  const canvas = root.locator('.task-graph-scroll');
  await canvas.scrollIntoViewIfNeeded();
  assert.equal(await canvas.evaluate(element => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
    return element.scrollWidth > element.clientWidth + 100;
  }), true);
  const canvasBox = await canvas.boundingBox();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 30, canvasBox.y + 12, { steps: 5 });
  await page.mouse.up();
  assert.ok(await canvas.evaluate(element => element.scrollLeft > 0), '拖动只平移画布');
  await control('缩小').click();
  assert.ok(await zoomPercent() < increasedZoom);
  await control('适应画布').click();
  assert.ok(await zoomPercent() > 0);
  assert.equal(await canvas.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  assert.equal(await noPageOverflow(), true);

  await control('查看设计规格').click();
  await page.locator('[data-artifact="spec.md"][aria-pressed="true"]').waitFor();
  await page.locator('#records-tab-tasks').click();
  await control('去确认计划').click();
  const approve = page.getByRole('button', { name: '确认计划并导出', exact: true });
  await approve.waitFor();
  assert.equal(await page.locator('#workspace-plan').isVisible(), true);
  assert.equal(run.approvals.plan, null);
  assert.deepEqual(posts, [], '查看规格、任务和审阅入口不修改计划或启动执行');

  await approve.click();
  await until(() => settled('succeeded'), '计划确认并导出');
  await page.getByRole('tab', { name: /开发任务/ }).click();
  await root.getByText('计划已确认', { exact: true }).waitFor();
  await control('准备验收与开发').click();
  await page.locator('#workspace-execution').waitFor();
  assert.equal(run.approvals.plan.revision, run.planRevision);
  assert.deepEqual(posts.map(({ path, body }) => [path, body?.action]), [
    [`/api/projects/${project.id}/runs/${run.id}/action`, 'approve_plan'],
  ], '通过现有确认入口后，开发入口也只打开已有验收工作区');
  assert.equal(await noPageOverflow(), true);
  assert.deepEqual(errors, []);
});

test('真实 Edge 390px：80 项长链可适应到 10% 以下并完整显示', { timeout: 30000 }, async t => {
  const taskId = index => `T-${index + 1}`;
  const planner = { ...simulationPlanner,
    generateTasks: () => Array.from({ length: 80 }, (_, index) => ({
      id: taskId(index), title: `任务 ${index + 1}`, description: `执行第 ${index + 1} 个阶段`,
      dependsOn: index ? [taskId(index - 1)] : [], requirementIds: ['R1'],
      suggestedFiles: [`src/task-${index + 1}.mjs`], acceptance: [`验证阶段 ${index + 1} 的输出`],
    })),
  };
  const { page, origin } = await fixture(t, { width: 390, planner, name: '长链画布验收', content: '按序执行并核对全部 80 个阶段。' });
  const root = await openTasks(page, origin);
  const canvas = root.locator('.task-graph-scroll');
  assert.equal(await canvas.locator('.dev-task').count(), 80);
  assert.equal(await canvas.evaluate(element => element.scrollHeight > element.clientHeight * 10), true);
  await root.getByRole('button', { name: '适应画布', exact: true }).click();
  const zoom = Number.parseFloat(await root.locator('[data-task-zoom-value]').innerText());
  assert.ok(zoom > 0 && zoom < 10);
  assert.equal(await canvas.evaluate(element => element.scrollWidth <= element.clientWidth + 1
    && element.scrollHeight <= element.clientHeight + 1), true);
});

test('真实 Edge：评审者可从任务图确认计划，开发入口仍由负责人操作', { timeout: 30000 }, async t => {
  const { app, page, origin, settled, run } = await fixture(t, { width: 1440, teamEnabled: true });
  const password = 'Synthetic-Taskflow-Reviewer-3092!';
  const owner = await app.teamAccess.setup({ name: 'owner', password });
  await app.teamAccess.createMember(owner.cookie, { name: 'reviewer', password, role: 'reviewer' });
  const login = await page.request.post(`${origin}/api/team/login`, { data: { name: 'reviewer', password } });
  assert.equal(login.status(), 200);
  const root = await openTasks(page, origin);
  assert.match(await page.locator('#team-link').innerText(), /评审者/);
  assert.equal(await root.getByRole('button', { name: '修改此任务', exact: true }).isDisabled(), true);
  await root.getByRole('button', { name: '去确认计划', exact: true }).click({ timeout: 5000 });
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click();
  await until(() => settled('succeeded'), '评审者确认计划');
  assert.equal(run.approvals.plan.revision, run.planRevision);
  await page.getByRole('tab', { name: /开发任务/ }).click();
  await root.getByText('计划已确认', { exact: true }).waitFor();
  assert.equal(await root.getByRole('button', { name: '准备验收与开发', exact: true }).isVisible(), false);
});

for (const width of [1440, 390]) test(`真实 Edge ${width}px：项目回程链接、运行历史与计划清单读取同一记录`, { timeout: 60000 }, async t => {
  const { app, project, run, page, origin } = await fixture(t, { width });
  await app.orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision });
  await until(() => run.status === 'succeeded' && !app.orchestrator.state(run).driving, '旧计划已导出');
  const next = await app.orchestrator.createRun(project.id, { mode: 'local' });
  await until(() => next.status === 'awaiting_spec' && !app.orchestrator.state(next).driving, '新规格待确认');
  const other = await app.store.create({ name: '另一个项目', source: { filename: 'other.md', content: '这个项目仅用于核对回程不会选错。' } });
  await page.addInitScript(({ id }) => sessionStorage.setItem('taskflow-selection', JSON.stringify({ projectId: id })), { id: other.id });
  const writes = [];
  page.on('request', request => {
    if (request.url().startsWith(origin + '/api/') && request.method() !== 'GET') writes.push(request.url());
  });

  await page.goto(origin + '/?' + new URLSearchParams({ project: project.id, run: next.id }));
  await page.getByRole('heading', { name: project.name, exact: true, level: 1 }).waitFor();
  await page.waitForFunction(id => document.querySelector('#run-select').value === id, next.id);
  await page.locator('#run-history > summary').click();
  const history = page.locator('#run-history-list');
  const oldRecord = history.locator('[data-run-history-id="' + run.id + '"]');
  assert.match(await oldRecord.innerText(), new RegExp(run.planRevision.slice(0, 8)));
  await oldRecord.click();
  await page.waitForFunction(id => document.querySelector('#run-select').value === id, run.id);
  assert.equal(new URL(page.url()).searchParams.get('run'), run.id);
  assert.equal(await oldRecord.getAttribute('aria-current'), 'true');

  await page.getByRole('tab', { name: /开发任务/ }).click();
  await page.getByRole('tab', { name: '计划清单' }).click();
  const schedule = page.getByRole('table', { name: '开发计划清单' });
  assert.equal(await schedule.getByText('已纳入计划', { exact: true }).count(), 5);
  const selected = schedule.locator('[data-task-schedule][data-task=C]');
  await selected.click();
  const details = page.getByRole('complementary', { name: '所选任务详情' });
  assert.equal(await details.getByRole('heading', { name: '分支C' }).isVisible(), true);
  await selected.press('End');
  assert.equal(await details.getByRole('heading', { name: '后续任务', level: 3 }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(writes, []);
});
