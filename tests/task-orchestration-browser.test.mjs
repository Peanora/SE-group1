import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { simulationPlanner } from '../examples/simulation-fixture.mjs';

const groups = { A: '应用基础', B: '场地与规则', C: '场地与规则', D: '预约核对', E: '联合验收' };
const moduleNames = { A: '应用入口', B: '场地查询', C: '预约配额', D: '审阅预约', E: '后续任务' };
const modulePlanner = { ...simulationPlanner, generateTasks: (...args) => simulationPlanner.generateTasks(...args).map(task => ({
  ...task, workflowModule: { group: groups[task.id], name: moduleNames[task.id] },
})) };

async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await delay(20);
  }
}

async function fixture(t, { width, planner = modulePlanner, teamEnabled = false, name = '分叉汇合验收', content = 'A 完成后执行 B 和 C，随后检查 D 并执行 E。' }) {
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

async function panOverflowingCanvas(page, canvas) {
  await canvas.scrollIntoViewIfNeeded();
  const overflow = await canvas.evaluate(element => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
    return { x: element.scrollWidth - element.clientWidth, y: element.scrollHeight - element.clientHeight };
  });
  assert.ok(Math.max(overflow.x, overflow.y) > 100, '放大后在画布的实际方向可滚动');
  const axis = overflow.y > overflow.x ? 'y' : 'x';
  const point = await canvas.evaluate((element, axis) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0), top = Math.max(rect.top, 0);
    const right = Math.min(rect.right - 18, innerWidth), bottom = Math.min(rect.bottom - 18, innerHeight);
    for (const inset of [8, 14, 20]) {
      const x = axis === 'x' ? Math.min(left + 120, right - 8) : left + inset;
      const y = axis === 'y' ? Math.min(top + 120, bottom - 8) : top + inset;
      const target = document.elementFromPoint(x, y);
      if (target && element.contains(target) && !target.closest('button')) return { x, y };
    }
    return null;
  }, axis);
  assert.ok(point, '有可用于平移的画布空白');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - (axis === 'x' ? 75 : 0), point.y - (axis === 'y' ? 75 : 0), { steps: 5 });
  await page.mouse.up();
  assert.ok(await canvas.evaluate((element, axis) => axis === 'x' ? element.scrollLeft > 0 : element.scrollTop > 0, axis), '拖动空白只平移画布');
}

const taskCard = (canvas, id) => canvas.locator(`.dev-task[data-task="${id}"]`);
const dependency = (canvas, from, to) => canvas.locator(`.task-edge[data-from="${from}"][data-to="${to}"]`);

async function layoutOf(locator) {
  return locator.evaluate(element => {
    const graph = element.closest('.task-graph-sizer').getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { x: box.x - graph.x, y: box.y - graph.y, width: box.width, height: box.height };
  });
}

function assertSameSlot(actual, expected) {
  assert.ok(Math.abs(actual.x - expected.x) < 1 && Math.abs(actual.y - expected.y) < 1,
    `expected slot ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

async function dragPointer(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

async function centerOf(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, '需要操作的节点或端口有可见位置');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function waitForBranchOrder(page, upper, lower) {
  await page.waitForFunction(([upper, lower]) => {
    const before = document.querySelector(`.dev-task[data-task="${upper}"]`)?.getBoundingClientRect();
    const after = document.querySelector(`.dev-task[data-task="${lower}"]`)?.getBoundingClientRect();
    return before && after && before.bottom <= after.top;
  }, [upper, lower], { timeout: 5000 });
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
  const shell = await page.evaluate(() => {
    const sidebar = document.querySelector('aside.sidebar').getBoundingClientRect();
    const main = document.querySelector('.app-shell').getBoundingClientRect();
    const nav = document.querySelector('#workspace-nav');
    return { sidebarRight: sidebar.right, sidebarBottom: sidebar.bottom, mainLeft: main.left, mainTop: main.top,
      tabsInWorkspace: nav.parentElement.id === 'main', runInHeading: !!document.querySelector('.workspace-heading #run-select') };
  });
  assert.equal(shell.tabsInWorkspace && shell.runInHeading, true, '工作区标签和运行选择位于原工作台主体');
  assert.ok(width === 1440 ? shell.sidebarRight <= shell.mainLeft + 1 : shell.sidebarBottom <= shell.mainTop + 1);
  const control = name => root.getByRole('button', { name, exact: true });
  const task = taskCard(root, 'B');
  const noPageOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  await task.click();
  assert.equal(await task.getAttribute('aria-pressed'), 'true');
  const inspector = root.locator('.task-detail');
  assert.equal(await task.locator('.dev-task-title').innerText(), moduleNames.B);
  assert.equal(await inspector.getAttribute('data-inspected-module'), 'B');
  assert.equal(await inspector.getByRole('heading', { name: moduleNames.B, exact: true }).count(), 1);
  const steps = inspector.getByText('执行步骤与证据', { exact: true });
  await steps.click();
  assert.equal(await inspector.getByText('HTTP 验收', { exact: true }).isVisible(), true);
  if (width === 390) {
    await inspector.getByRole('button', { name: '返回任务图', exact: true }).click();
    assert.equal(await task.getAttribute('aria-pressed'), 'true');
  }
  for (const label of ['前置任务', '后续任务', '验收条件']) {
    assert.equal(await inspector.getByRole('heading', { name: label, exact: true }).isVisible(), true);
  }
  assert.match(await inspector.textContent(), /核对分支B模拟结果/);

  const focus = control('突出关联');
  assert.equal(await focus.getAttribute('aria-pressed'), 'false');
  await focus.click();
  assert.equal(await focus.getAttribute('aria-pressed'), 'true');
  assert.match(await dependency(root, 'A', 'B').getAttribute('class'), /\brelation-upstream\b/);
  assert.match(await dependency(root, 'B', 'D').getAttribute('class'), /\brelation-downstream\b/);
  await focus.click();
  assert.equal(await focus.getAttribute('aria-pressed'), 'false');

  const zoom = root.locator('[data-task-zoom-value]');
  const zoomPercent = async () => Number.parseInt(await zoom.innerText(), 10);
  const baselineZoom = await zoomPercent();
  assert.ok(baselineZoom > 0);
  await control('放大').click();
  const increasedZoom = await zoomPercent();
  assert.ok(increasedZoom > baselineZoom);
  const canvas = root.locator('.task-graph-scroll[data-plan-canvas]');
  await panOverflowingCanvas(page, canvas);
  const navigator = root.getByRole('button', { name: /任务图小地图/ });
  const viewportMarker = navigator.locator('.task-navigator-viewport');
  assert.equal(await navigator.locator('[data-map-task]').count(), 5);
  assert.equal(await navigator.locator('[data-map-flow]').count(), 0);
  const scrollAxis = await canvas.evaluate(element => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
    return element.scrollWidth - element.clientWidth > element.scrollHeight - element.clientHeight ? 'x' : 'y';
  });
  await navigator.press(scrollAxis === 'x' ? 'ArrowRight' : 'ArrowDown');
  await page.waitForFunction(axis => Number(document.querySelector('.task-navigator-viewport')?.getAttribute(axis)) > 0, scrollAxis);
  assert.ok(await canvas.evaluate((element, axis) => (axis === 'x' ? element.scrollLeft : element.scrollTop) > 0, scrollAxis), '小地图方向键同步平移画布和视图框');
  assert.ok(Number(await viewportMarker.getAttribute('height')) > 0);
  await control('缩小').click();
  assert.ok(await zoomPercent() < increasedZoom);
  await control('适应画布').click();
  assert.ok(await zoomPercent() > 0);
  assert.equal(await canvas.evaluate(element => element.scrollWidth <= element.clientWidth + 1
    && element.scrollHeight <= element.clientHeight + 1), true);
  const firstTask = taskCard(canvas, 'A'), sibling = taskCard(canvas, 'C'), next = taskCard(canvas, 'D');
  assert.equal(await canvas.locator('[data-workflow-module][data-flow-part="agent"]').count(), 5, '每项真实任务只画一个模块节点');
  assert.equal(await canvas.locator('[data-flow-node]').count(), 5);
  for (const group of new Set(Object.values(groups))) {
    assert.equal(await canvas.locator('[data-flow-group]').filter({ hasText: group }).count(), 1);
  }
  assert.equal(await task.getAttribute('data-workflow-group'), groups.B);
  assert.equal(await sibling.getAttribute('data-workflow-group'), groups.C);
  assert.equal(await firstTask.locator('[data-module-fork]').count(), 1, '任务 A 标记实际分叉');
  assert.equal(await next.locator('[data-module-join]').count(), 1, '任务 D 标记实际汇合');
  const businessEdges = () => canvas.locator('.task-edge[data-from][data-to]').evaluateAll(edges =>
    edges.map(edge => `${edge.dataset.from}->${edge.dataset.to}`).sort());
  const savedEdges = ['A->B', 'A->C', 'B->D', 'C->D', 'D->E'];
  assert.deepEqual(await businessEdges(), savedEdges);
  const originalTasks = structuredClone(run.tasks);
  assert.equal(await firstTask.locator('[data-module-checkpoint]').count(), 1);
  assert.equal(await task.locator('[data-module-checkpoint]').count(), 0, '普通模块的校验细节由详情展示');

  await firstTask.click();
  await canvas.scrollIntoViewIfNeeded();
  const start = await layoutOf(task), other = await layoutOf(sibling);
  assert.ok(Math.abs(start.x - other.x) < 1 && start.y + start.height <= other.y, '同深度的分支保持相同列且不重叠');
  assert.ok((await layoutOf(firstTask)).x < start.x && start.x < (await layoutOf(next)).x, '任务按真实前置关系从左到右排布');

  const edge = dependency(canvas, 'A', 'B');
  await edge.waitFor({ state: 'attached' });
  const startPath = await edge.getAttribute('d');
  const mapTaskY = await navigator.locator('[data-map-task="B"]').getAttribute('y');
  const grip = task.locator('.dev-task-grip');
  const originGrip = await centerOf(grip), otherCenter = await centerOf(sibling), nextCenter = await centerOf(next);
  await dragPointer(page, originGrip, { x: nextCenter.x, y: originGrip.y });
  assertSameSlot(await layoutOf(task), start);
  assertSameSlot(await layoutOf(sibling), other);
  assert.deepEqual(await businessEdges(), savedEdges, '尝试跨深度只保留原有依赖');

  await dragPointer(page, await centerOf(grip), { x: originGrip.x, y: otherCenter.y });
  await waitForBranchOrder(page, 'C', 'B');
  assertSameSlot(await layoutOf(task), other);
  assertSameSlot(await layoutOf(sibling), start);
  assert.equal(await task.getAttribute('data-workflow-group'), groups.B, '换位不改变模块所属板块');
  assert.notEqual(await edge.getAttribute('d'), startPath, '业务连线跟随换位更新');
  await page.waitForFunction(y => {
    const marker = document.querySelector('[data-map-task="B"]');
    return marker && marker.getAttribute('y') !== y;
  }, mapTaskY);
  assert.deepEqual(await businessEdges(), savedEdges);
  assert.deepEqual(run.tasks, originalTasks);
  assert.equal(await firstTask.getAttribute('aria-pressed'), 'true', '拖动未触发任务点选');
  await task.click();
  assert.match(await inspector.textContent(), /核对分支B模拟结果/);
  await page.getByRole('tab', { name: '计划清单' }).click();
  assert.equal(await root.locator('[data-task-schedule][data-task="B"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#records-tab-tasks').click();
  await waitForBranchOrder(page, 'C', 'B');
  await page.reload();
  await page.getByRole('tab', { name: /开发任务/ }).click();
  await waitForBranchOrder(page, 'C', 'B');
  await control('适应画布').click();
  assertSameSlot(await layoutOf(task), other);
  assert.deepEqual(await businessEdges(), savedEdges);
  await control('恢复节点位置').click();
  await waitForBranchOrder(page, 'B', 'C');
  assertSameSlot(await layoutOf(task), start);
  assertSameSlot(await layoutOf(sibling), other);
  await task.press('Alt+ArrowDown');
  await waitForBranchOrder(page, 'C', 'B');
  assertSameSlot(await layoutOf(task), other);
  await task.press('Alt+ArrowUp');
  await waitForBranchOrder(page, 'B', 'C');
  await task.press('End');
  assert.equal(await inspector.locator('.task-detail-summary h3').innerText(), '后续任务');
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
  assert.equal(await canvas.evaluate(element => element.scrollWidth > element.clientWidth * 10
    || element.scrollHeight > element.clientHeight * 10), true);
  await root.getByRole('button', { name: '适应画布', exact: true }).click();
  const zoom = Number.parseFloat(await root.locator('[data-task-zoom-value]').innerText());
  assert.ok(zoom > 0 && zoom < 10);
  assert.equal(await canvas.evaluate(element => element.scrollWidth <= element.clientWidth + 1
    && element.scrollHeight <= element.clientHeight + 1), true);
});

test('真实 Edge 390px：画布修改直接依赖，保存并重新确认按图执行计划', { timeout: 60000 }, async t => {
  const planner = { ...modulePlanner, generateTasks: (...args) => modulePlanner.generateTasks(...args).map(task => {
    const files = task.id === 'A' ? ['src/app.mjs'] : task.suggestedFiles;
    return { ...task, suggestedFiles: files, writePaths: [...files] };
  }) };
  const { app, project, run, settled, page, origin } = await fixture(t, { width: 390, planner });
  const oldRevision = run.planRevision;
  const specRevision = run.specRevision;
  await app.orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: oldRevision, specRevision });
  await until(() => settled('succeeded'), '旧计划确认');
  const runPath = `/api/projects/${project.id}/runs/${run.id}`;
  const posts = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(runPath)) posts.push(request.postDataJSON());
  });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(origin + '/?view=details');
  const tasksTab = page.getByRole('tab', { name: /开发任务/ });
  await tasksTab.click();
  const root = page.locator('.task-orchestration-root');
  await root.getByText('计划已确认', { exact: true }).waitFor();
  const canvas = root.locator('.task-graph-scroll[data-plan-canvas]');
  const edge = (from, to) => dependency(canvas, from, to);
  const port = (direction, owner) => canvas.locator(`[data-task-connector="${direction}"][data-owner-task="${owner}"]`);
  const control = name => root.getByRole('button', { name, exact: true });
  const edit = control('编辑连线');
  await edit.click();
  assert.equal(await edit.getAttribute('aria-pressed'), 'true');
  const editor = root.getByRole('region', { name: '编辑任务流程' });
  await editor.waitFor();
  assert.equal(await canvas.locator('[data-module-checkpoint]').count(), 3);
  assert.equal(await taskCard(canvas, 'D').locator('[data-module-join]').count(), 1);
  assert.equal(await edge('B', 'D').count(), 1);
  assert.equal(await edge('C', 'D').count(), 1);
  assert.equal(await edge('D', 'E').count(), 1);
  assert.equal(await edge('A', 'B').evaluate(node => getComputedStyle(node).animationName), 'task-dependency-flow');
  assert.equal(await edge('D', 'E').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await edge('A', 'B').evaluate(node => getComputedStyle(node).animationName), 'none');

  await control('适应画布').click();
  await canvas.scrollIntoViewIfNeeded();
  await dragPointer(page, await centerOf(port('output', 'B')), await centerOf(port('input', 'E')));
  await edge('B', 'E').waitFor({ state: 'attached' });
  await root.getByText('计划修订预览', { exact: true }).waitFor();
  await taskCard(canvas, 'B').press('Alt+ArrowDown');
  await waitForBranchOrder(page, 'C', 'B');
  assert.equal(await edge('B', 'E').count(), 1, '本地换位保留当前直接依赖草稿');
  await root.getByText('计划修订预览', { exact: true }).waitFor();
  assert.equal(run.planRevision, oldRevision);
  assert.equal(run.approvals.plan.revision, oldRevision);
  assert.deepEqual(run.tasks.find(task => task.id === 'E').dependsOn, ['D']);

  const source = editor.getByLabel('起点');
  const target = editor.getByLabel('后继');
  await source.selectOption('E');
  await target.selectOption('A');
  await editor.getByRole('button', { name: '添加连线' }).press('Enter');
  await page.getByText('这条连线会形成循环。', { exact: true }).waitFor();
  assert.equal(await edge('E', 'A').count(), 0);
  assert.equal(await edge('B', 'E').count(), 1, '循环拒绝保留已存在的合法草稿');
  await page.locator('#dismiss-error').click();

  await taskCard(canvas, 'E').click();
  await editor.getByRole('button', { name: '移除 B 到 E 的连线' }).click();
  await edge('B', 'E').waitFor({ state: 'detached' });
  assert.equal(await editor.getByRole('button', { name: '移除 D 到 E 的连线' }).isVisible(), true);
  await source.selectOption('B');
  await target.selectOption('E');
  await editor.getByRole('button', { name: '添加连线' }).press('Enter');
  await edge('B', 'E').waitFor({ state: 'attached' });
  assert.deepEqual(posts, [], '画布拖连、循环检查和删除只修改当前本地草稿');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

  const designSave = page.waitForResponse(response => response.url() === origin + runPath + '/action'
    && response.request().method() === 'POST');
  await editor.getByRole('button', { name: '保存连线', exact: true }).click();
  assert.equal((await designSave).status(), 200);
  await until(() => run.planRevision !== oldRevision && settled('awaiting_review'), '保存直接依赖的设计版本');
  const designRevision = run.planRevision;
  assert.equal(run.dependencyExecution, undefined);
  assert.deepEqual([...run.tasks.find(task => task.id === 'E').dependsOn].sort(), ['B', 'D']);
  await tasksTab.click();
  await waitForBranchOrder(page, 'B', 'C');
  await control('编辑连线').click();
  const pendingSave = page.waitForResponse(response => response.url() === origin + runPath + '/action'
    && response.request().method() === 'POST');
  await editor.getByRole('button', { name: '保存为按图运行' }).click();
  const saveResponse = await pendingSave;
  assert.equal(saveResponse.status(), 200, await saveResponse.text());
  await until(() => run.planRevision !== designRevision && settled('awaiting_review'), '新任务图保存后重新审阅');
  const newRevision = run.planRevision;
  assert.equal(run.dependencyExecution, true);
  assert.equal(run.approvals.plan, null);
  assert.equal(run.approvals.spec.revision, specRevision);
  assert.equal(run.revisionHistory.plan.at(-1).revision, designRevision);
  assert.deepEqual([...run.tasks.find(task => task.id === 'E').dependsOn].sort(), ['B', 'D']);
  assert.deepEqual(posts.map(body => [body.action, body.revision, body.dependencyExecution]), [
    ['revise_plan', oldRevision, undefined],
    ['revise_plan', designRevision, true],
  ]);

  await tasksTab.click();
  await root.getByText('计划待确认', { exact: true }).waitFor();
  await control('去确认计划').click();
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click();
  await until(() => settled('succeeded'), '新任务图计划确认');
  assert.deepEqual(posts.map(body => [body.action, body.revision]), [
    ['revise_plan', oldRevision],
    ['revise_plan', designRevision],
    ['approve_plan', newRevision],
  ]);

  const response = await page.request.get(origin + runPath);
  assert.equal(response.status(), 200);
  const { run: saved } = await response.json();
  assert.equal(saved.planRevision, newRevision);
  assert.equal(saved.approvals.plan.revision, newRevision);
  assert.equal(saved.dependencyExecution, true);
  assert.ok(saved.tasks.every(task => task.requirementIds.includes('R1') && task.writePaths.length > 0));
  assert.deepEqual([...saved.tasks.find(task => task.id === 'E').dependsOn].sort(), ['B', 'D']);
  await page.reload();
  await tasksTab.click();
  await root.getByText('计划已确认', { exact: true }).waitFor();
  await edge('B', 'E').waitFor({ state: 'attached' });
  assert.equal(await edge('D', 'E').count(), 1);
  assert.deepEqual(errors, []);
});

test('真实 Edge：旧计划可修改功能板块与模块名称，保存新版本并保留原依赖', { timeout: 45000 }, async t => {
  const { app, project, run, settled, page, origin } = await fixture(t, { width: 1440, planner: simulationPlanner });
  const priorRevision = run.planRevision;
  const original = structuredClone(run.tasks);
  assert.equal(original.find(item => item.id === 'B').workflowModule, undefined);
  await app.orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: priorRevision, specRevision: run.specRevision });
  await until(() => settled('succeeded'), '旧计划已确认');

  const runPath = `/api/projects/${project.id}/runs/${run.id}`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?' + new URLSearchParams({ project: project.id, run: run.id, view: 'tasks' }));
  const root = page.locator('.task-orchestration-root');
  await root.getByText('计划已确认', { exact: true }).waitFor();
  await taskCard(root, 'B').click();
  await root.getByRole('button', { name: '修改此任务', exact: true }).click();
  const group = page.getByLabel('功能板块', { exact: true });
  const name = page.getByLabel('模块名称', { exact: true });
  assert.equal(await group.inputValue(), '');
  assert.equal(await name.inputValue(), '');
  await group.fill('预约入口');
  await name.fill('时段选择');
  const response = page.waitForResponse(item => item.url() === origin + runPath + '/action' && item.request().method() === 'POST');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  const saved = await response;
  assert.equal(saved.status(), 200, await saved.text());
  await until(() => run.planRevision !== priorRevision && settled('awaiting_review'), '模块更名保存为新计划');
  const previous = original.find(item => item.id === 'B');
  const expected = { ...previous, workflowModule: { group: '预约入口', name: '时段选择' } };
  assert.deepEqual(run.tasks, original.map(task => task.id === 'B' ? expected : task));
  assert.equal(run.approvals.plan, null);
  assert.equal(run.revisionHistory.plan.at(-1).revision, priorRevision);
  const persisted = app.store.getPersistedRun(project.id, run.id).run;
  assert.equal(persisted.planRevision, run.planRevision);
  assert.deepEqual(persisted.tasks, run.tasks);

  await page.getByRole('tab', { name: /开发任务/ }).click();
  await root.getByText('计划待确认', { exact: true }).waitFor();
  const board = root.locator('.task-graph-scroll');
  const entry = taskCard(board, 'B');
  await entry.click();
  assert.equal(await entry.locator('.dev-task-title').innerText(), '时段选择');
  assert.equal(await entry.getAttribute('data-workflow-group'), '预约入口');
  assert.equal(await board.locator('[data-flow-group]').filter({ hasText: '预约入口' }).count(), 1);
  const inspector = root.locator('.task-detail[data-inspected-module="B"]');
  assert.equal(await inspector.getByRole('heading', { name: '时段选择', exact: true }).count(), 1);
  assert.match(await inspector.locator('.task-detail-id').innerText(), /预约入口/);
  await dependency(board, 'A', 'B').waitFor({ state: 'attached' });
  await dependency(board, 'B', 'D').waitFor({ state: 'attached' });
  assert.deepEqual(errors, []);
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
  assert.equal(await details.getByRole('heading', { name: moduleNames.C, exact: true }).isVisible(), true);
  await selected.press('End');
  assert.equal(await details.getByRole('heading', { name: '后续任务', level: 3 }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(writes, []);
});
