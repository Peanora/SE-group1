import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

const content = '用户可以查看资源列表。';
const specification = text => ({ title: '资源工作台', summary: text, goals: ['查看资源'], roles: ['用户'], questions: [], constraints: [], assumptions: [], acceptanceScenarios: ['展示资源列表'],
  stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, sourceMode: 'local',
  requirements: [{ id: 'R-001', title: '查看资源', description: text, sourceQuote: text, acceptance: ['展示资源列表'] }] });
const views = ['overview', 'source', 'plan', 'tasks', 'execution', 'trace'];
const nav = (page, view) => page.locator(`[data-workspace-view="${view}"]`);
const pane = (page, view) => page.locator(`#workspace-${view}`);

async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`等待超时：${label}`); await delay(10); }
}

async function fixture(t, width, { delayedModel = false, modelConfigured = delayedModel, changeFailureStatus = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-ui-browser-'));
  let rejectModel, modelCalls = 0, browser;
  const response = new Promise((resolve, reject) => { rejectModel = reject; });
  // Handle teardown before the controlled provider is entered as well.
  void response.catch(() => {});
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner,
    analyzeRequirements: specification,
    getModelConfig: () => ({ configured: modelConfigured, model: 'workspace-ui-controlled-fixture' }),
    analyzeWithModel: (text, name, options) => planner.analyzeWithModel(text, name, { ...options,
      config: { baseUrl: 'https://workspace-fixture.invalid/v1', model: 'workspace-ui-controlled-fixture', apiKey: '' },
      fetchImpl: async () => {
        modelCalls++; assert.equal(delayedModel, true, '普通UI验收不能进入模型');
        // The UI case needs a failed, fully finished request before a new run.
        // A bare rejected provider Promise is correctly unknown in production.
        await response.catch(() => {});
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
      },
    }),
  } });
  const errors = [];
  t.after(async () => {
    rejectModel(new Error('controlled fixture closed'));
    await browser?.close(); await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('workspace-ui-browser-'));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], '只允许明确拦截的网络失败，其他浏览器错误均须为空');
  });
  const project = await app.store.create({ name: `统一工作台${width}`, source: { filename: 'requirements.md', content } });
  let run;
  if (!delayedModel) {
    run = await app.orchestrator.createRun(project.id);
    await until(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving, '规格待确认');
    await app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
    await until(() => run.status === 'awaiting_review' && !app.orchestrator.state(run).driving, '计划待确认');
  }
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', item => {
    const expectedChangeError = item.location().url.endsWith(`/api/projects/${project.id}/changes`)
      && (/net::ERR_FAILED/.test(item.text()) || changeFailureStatus === 503 && /\b503\b/.test(item.text()));
    if (item.type() === 'error' && !expectedChangeError) errors.push(item.text());
  });
  await page.goto(url + '/?view=details');
  await page.waitForFunction(name => document.querySelector('#project-title')?.textContent === name, project.name);
  await nav(page, 'plan').waitFor();
  if (!delayedModel) await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  return { app, project, run, page, rejectModel, modelCalls: () => modelCalls, url };
}

async function assertOnlyView(page, view) {
  for (const name of views) {
    assert.equal(await pane(page, name).isVisible(), name === view, `仅显示${view}工作面：${name}`);
    assert.equal(await nav(page, name).getAttribute('aria-selected'), String(name === view));
  }
  assert.equal(await page.locator('#workspace-context').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
}

test('homepage checklist repair returns to the revised plan for normal confirmation', { timeout: 45000 }, async t => {
  const { app, project, run, page, url } = await fixture(t, 390);
  await app.orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision });
  await until(() => run.status === 'succeeded' && !app.orchestrator.state(run).driving, '计划已确认');
  const projectUrl = `${url}/api/projects/${project.id}`;
  const runUrl = `${projectUrl}/runs/${run.id}`;
  const savedProject = (await (await page.request.get(projectUrl)).json()).project;
  const current = { ...savedProject.runs[0], engineeringPlan: {} };
  const revised = { ...current, status: 'awaiting_review', planRevision: 'd'.repeat(64), approvals: { ...current.approvals, plan: null } };
  const binding = { projectId: project.id, runId: run.id, specRevision: current.specRevision, planRevision: current.planRevision,
    sourceRevision: current.sourceRevision, sourceGeneration: current.sourceGeneration };
  const approval = { id: 'checklist', projectId: project.id, runId: run.id, status: 'approved', current: true, approved: true, executed: false,
    binding, coverage: 'structural_only', approval: { phase: 'definition_only' }, revision: 'b'.repeat(64), manifestHash: 'c'.repeat(64),
    proposal: { name: '旧清单', browser: { version: 1, sessions: ['用户'], steps: [{}] } } };
  const execution = { id: 'blocked-execution', projectId: project.id, runId: run.id, proposalId: approval.id, revision: approval.revision,
    status: 'failed', kind: 'planned_web', binding, current: true, active: false, accepted: false, candidateCommit: 'e'.repeat(40),
    checks: { http: [{ passed: true }], browser: [{ passed: false }] }, failureHelp: { action: 'review_checklist', title: '清单缺少登录步骤',
      detail: '打开聊天页面前没有登录。', nextStep: '给测试账号补上登录步骤，然后确认新版清单。' } };
  await page.route(projectUrl, route => route.fulfill({ json: { project: { ...savedProject, runs: [current] } } }));
  await page.route(`${runUrl}/development-executions`, route => route.fulfill({ json: { capabilities: { canStart: false }, executions: [execution] } }));
  await page.route(`${runUrl}/verification-plans`, route => route.fulfill({ json: { coverage: 'structural_only', capabilities: {}, proposals: [approval] } }));
  let submitted;
  await page.route(`${runUrl}/development-executions/${execution.id}/revise-checklist`, route => {
    submitted = { method: route.request().method(), body: route.request().postDataJSON() };
    return route.fulfill({ json: { run: revised } });
  });
  await page.reload();
  const banner = page.locator('#workspace-context');
  await banner.getByText(execution.failureHelp.title, { exact: true }).waitFor();
  await banner.getByText(execution.failureHelp.nextStep).waitFor();
  await banner.getByRole('button', { name: '准备清单修订', exact: true }).click();
  const review = page.locator('#workspace-plan #review-heading');
  await review.getByText('开发计划已生成，请确认后导出', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认计划并导出', exact: true }).isVisible(), true);
  assert.equal(await page.locator('[data-delivery-step="plan-approval"]').getAttribute('data-state'), 'waiting');
  assert.deepEqual(submitted, { method: 'POST', body: {} });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});

async function assertInViewport(locator) {
  assert.equal(await locator.isVisible(), true);
  const rect = await locator.boundingBox();
  const viewport = locator.page().viewportSize();
  assert.ok(rect && rect.y >= -1 && rect.y + rect.height <= viewport.height + 1, `内容应完整位于视口内：${JSON.stringify(rect)}`);
  assert.ok(rect.x >= -1 && rect.x + rect.width <= viewport.width + 1);
}

async function pointerClick(page, locator) {
  const hit = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return { x, y, visible: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && element.contains(document.elementFromPoint(x, y)) };
  });
  assert.equal(hit.visible, true, `普通指针必须命中当前视口中的控件：${JSON.stringify(hit)}`);
  await page.mouse.click(hit.x, hit.y);
}

async function wheelDocument(page, delta = 420) {
  const viewport = page.viewportSize(), before = await page.evaluate(() => scrollY);
  // The page gutter avoids native textarea, graph and notice scroll regions.
  await page.mouse.move(viewport.width - 6, Math.floor(viewport.height * .55));
  await page.mouse.wheel(0, delta);
  await page.waitForFunction(({ before, direction }) => direction > 0 ? scrollY > before + 1 : scrollY < before - 1, { before, direction: delta }, { timeout: 2000 });
  await page.evaluate(() => new Promise(resolve => {
    let previous = scrollY, stable = 0;
    const frame = () => { if (scrollY === previous) stable++; else { previous = scrollY; stable = 0; } if (stable >= 5) resolve(); else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }));
  assert.equal(await page.locator('[data-workspace-panel]:not([hidden])').evaluate(element => element.scrollTop), 0, '滚轮应移动文档，而非工作面内层');
  return page.evaluate(() => scrollY);
}

async function wheelToControl(page, locator) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return { y, height: innerHeight, hit: y > 0 && y < innerHeight && element.contains(document.elementFromPoint(x, y)) };
    });
    if (state.hit) return;
    await wheelDocument(page, Math.sign(state.y - state.height / 2) * Math.min(800, Math.max(120, Math.abs(state.y - state.height / 2))));
  }
  assert.fail('普通滚轮无法把下部操作移到可点击位置');
}

for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 667 }, { width: 390, height: 844 }]) test(`整页 ${size.width}×${size.height}：流程默认展开，手动收起不被轮询打开，新运行重新展开`, { timeout: 60000 }, async t => {
  const { app, project, page, rejectModel, modelCalls } = await fixture(t, size.width, { delayedModel: true });
  await page.setViewportSize(size);
  const workflow = page.locator('#workflow-details');
  assert.equal(await workflow.evaluate(element => element.open), true, '载入项目默认展开截图中的流程图');
  await page.locator('#mode-select').selectOption('model'); await page.locator('#start-run').click();
  await until(() => modelCalls() === 1, '受控模型进入规格阶段');
  const first = project.runs.at(-1);
  assert.equal(await workflow.evaluate(element => element.open), true);
  await workflow.locator('> summary').click();
  assert.equal(await workflow.evaluate(element => element.open), false);
  let polls = 0;
  const countPoll = response => { if (response.request().method() === 'GET' && response.url().endsWith(`/runs/${first.id}`)) polls++; };
  page.on('response', countPoll);
  await until(() => polls >= 2, '当前运行发生两次真实轮询');
  assert.equal(await workflow.evaluate(element => element.open), false, '轮询保留用户主动收起的选择');
  page.off('response', countPoll);
  rejectModel(new Error('受控规格失败，允许本地新运行检查'));
  await until(() => first.status === 'failed' && !app.orchestrator.state(first).driving, '旧运行失败停点');
  assert.deepEqual(first.specificationHistory.at(-1).transport, { version: 1, dispatched: true, responseComplete: true }, '新建运行前必须取得原生完整响应证据');
  assert.equal(first.specificationHistory.at(-1).coordinationRequired, false, '本用例的已停失败不能冒充未知请求');
  await page.waitForFunction(() => document.querySelector('#run-status').classList.contains('status-failed'));
  assert.equal(await workflow.evaluate(element => element.open), false, '后台失败也不能强行展开当前图');
  await page.locator('#dismiss-error').click();
  await page.locator('#mode-select').selectOption('local'); await page.locator('#start-run').click();
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  assert.notEqual(project.runs.at(-1).id, first.id);
  assert.equal(await workflow.evaluate(element => element.open), true, '新运行默认重新展开流程图');
  const documentY = await wheelDocument(page, 420);
  assert.ok(documentY > 0);
  assert.equal(await pane(page, 'plan').evaluate(element => element.scrollTop), 0);
  await nav(page, 'source').click();
  const reason = page.locator('.source-changes').getByLabel('变更原因', { exact: true });
  await reason.fill('整页下部操作应该可以移到屏幕中部。');
  const center = await reason.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2; });
  const delta = center - size.height / 2;
  if (Math.abs(delta) > 20) await wheelDocument(page, delta);
  const finalCenter = await reason.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2; });
  assert.ok(finalCenter >= size.height * .2 && finalCenter <= size.height * .8, `下部输入可随整页移动到中部：${finalCenter}`);
  assert.equal(await pane(page, 'source').evaluate(element => element.scrollTop), 0);
  assert.equal(modelCalls(), 1, '只有受控模拟请求，无额外模型调用');
  const shots = path.resolve('output/document-scroll'); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `page-${size.width}-${size.height}.png`) });
});

for (const height of [667, 844]) test(`短屏 390×${height}：长错误可滚动且关闭、定位与保存入口始终可达`, { timeout: 60000 }, async t => {
  const { app, project, page, modelCalls } = await fixture(t, 390, { modelConfigured: true, changeFailureStatus: 503 });
  await page.setViewportSize({ width: 390, height });
  const modeProject = await app.store.create({ name: `预算展示入口${height}`, source: { filename: 'requirements.md', content } });
  await page.locator('#refresh-button').click();
  await page.locator('#project-menu-trigger').click();
  await page.locator(`[data-project="${modeProject.id}"]`).click();
  await page.waitForFunction(name => document.querySelector('#project-title').textContent === name, modeProject.name);
  await page.locator('#mode-select').selectOption('model');
  await page.locator('#project-menu-trigger').click();
  await page.locator(`[data-project="${project.id}"]`).click();
  await page.locator('#approve-button').waitFor();
  assert.equal(await page.locator('#planning-charge-notice').isVisible(), true);
  await nav(page, 'source').click();
  const source = page.locator('.source-changes').getByLabel('需求正文', { exact: true }), draft = `${content}\n短屏错误后仍需保留的草稿。`;
  await source.fill(draft); await page.getByLabel('变更原因', { exact: true }).fill('补充短屏错误恢复检查');
  let posts = 0;
  await page.route(`**/api/projects/${project.id}/changes`, route => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '本次保存结果待核对：\n' + '请保留草稿，检查服务与具体字段，再刷新核对结果。\n'.repeat(90) }) }); }
    return route.continue();
  });
  const saveButton = page.getByRole('button', { name: '保存为待应用变更', exact: true });
  await saveButton.click();
  await page.locator('#error-banner').waitFor();
  const beforeExpand = await page.evaluate(() => scrollY);
  await pointerClick(page, page.locator('[data-notice-expand]'));
  await assertInViewport(page.locator('#error-banner'));
  assert.equal(await page.locator('#error-banner').getAttribute('data-expanded'), 'true');
  const text = page.locator('#error-text');
  assert.equal(await text.evaluate(element => element.scrollHeight > element.clientHeight), true, '完整长错误在正文区域内独立滚动');
  await text.evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert.ok(await text.evaluate(element => element.scrollTop > 0));
  assert.equal(await pane(page, 'source').evaluate(element => element.scrollTop), 0);
  assert.ok((await page.locator('#workspace-panels').boundingBox()).height > height, '主内容按自身高度自然展开，不再挤在屏幕底部小区');
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - beforeExpand) <= 2, '展开错误只能滚错误正文，不能打断文档阅读位置');
  await pointerClick(page, page.locator('[data-notice-locate]'));
  await assertOnlyView(page, 'source');
  assert.equal(await page.locator('#main').evaluate(element => element.scrollTop), 0, 'main不再是隐藏的程序滚动容器');
  await wheelToControl(page, saveButton);
  await pointerClick(page, saveButton);
  await until(() => posts === 2, '第二次明确保存请求');
  await page.waitForFunction(() => [...document.querySelectorAll('.source-changes button')].some(button => button.textContent === '保存为待应用变更' && !button.disabled));
  assert.equal(await page.locator('#error-banner').getAttribute('data-expanded'), 'true');
  assert.equal(posts, 2, '保存入口在真实工作面内可点击，不自动额外重试');
  await pointerClick(page, page.locator('#dismiss-error'));
  assert.equal(await page.locator('#error-banner').isVisible(), false);
  assert.equal(await source.inputValue(), draft); assert.equal(project.source.content, content);
  assert.equal(app.sourceChangeService.list({ projectId: project.id }).length, 0);
  assert.equal(modelCalls(), 0); assert.equal(project.runs.length, 1);
  assert.equal(await pane(page, 'source').evaluate(element => element.scrollTop), 0);
  const shots = path.resolve('output/workspace-ui'); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `short-error-recovered-${height}.png`) });
});

for (const width of [1440, 390]) test(`统一工作台 ${width}px：六个工作面、草稿阅读位置与就地任务编辑`, { timeout: 90000 }, async t => {
  const { app, project, run, page, modelCalls } = await fixture(t, width);
  await assertOnlyView(page, 'plan');
  for (const view of views) { await nav(page, view).click(); await assertOnlyView(page, view); }
  await nav(page, 'plan').focus(); await nav(page, 'plan').press('ArrowRight');
  assert.equal(await nav(page, 'tasks').evaluate(element => document.activeElement === element), true);
  await nav(page, 'tasks').press('Enter'); await assertOnlyView(page, 'tasks');

  await nav(page, 'source').click();
  const source = page.locator('.source-changes').getByLabel('需求正文', { exact: true });
  await source.waitFor(); await source.fill(`${content}\n用户尚未保存的补充内容。`);
  const sourceDraft = await source.inputValue();
  const scrollPosition = await wheelDocument(page, 300);
  assert.ok(scrollPosition > 0, '来源正文通过整页滚动阅读，主导航仍可操作');
  await pointerClick(page, nav(page, 'plan')); await pointerClick(page, nav(page, 'source'));
  assert.equal(await source.inputValue(), sourceDraft);
  try { await page.waitForFunction(position => Math.abs(scrollY - position) <= 4, scrollPosition, { timeout: 5000 }); }
  catch (error) {
    const debug = await page.evaluate(() => ({ y: scrollY, documentHeight: document.documentElement.scrollHeight, nav: document.querySelector('#workspace-nav').getBoundingClientRect().toJSON(), scrollEntries: Object.fromEntries(Object.keys(sessionStorage).filter(key => key.startsWith('taskflow.workspace:')).map(key => [key, JSON.parse(sessionStorage.getItem(key))])) }));
    await mkdir(path.resolve('output/document-scroll'), { recursive: true });
    await writeFile(path.resolve(`output/document-scroll/navigation-${width}.json`), JSON.stringify({ expected: scrollPosition, ...debug }, null, 2));
    throw error;
  }
  assert.equal(await pane(page, 'source').evaluate(element => element.scrollTop), 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#workspace-source') && !document.querySelector('#workspace-source').hidden);
  await source.waitFor(); assert.equal(await source.inputValue(), sourceDraft);
  await assertOnlyView(page, 'source');
  try { await page.waitForFunction(position => Math.abs(scrollY - position) <= 4, scrollPosition, { timeout: 5000 }); }
  catch (error) {
    const debug = await page.evaluate(() => ({ y: scrollY, documentHeight: document.documentElement.scrollHeight, scrollEntries: Object.fromEntries(Object.keys(sessionStorage).filter(key => key.startsWith('taskflow.workspace:')).map(key => [key, JSON.parse(sessionStorage.getItem(key))])) }));
    await mkdir(path.resolve('output/document-scroll'), { recursive: true });
    await writeFile(path.resolve(`output/document-scroll/refresh-${width}.json`), JSON.stringify({ expected: scrollPosition, ...debug }, null, 2)); throw error;
  }
  assert.equal(await pane(page, 'source').evaluate(element => element.scrollTop), 0, '刷新恢复文档位置，不复活内层滚动');

  await nav(page, 'tasks').click();
  const target = run.tasks.find(task => task.requirementIds.length);
  await page.locator(`.dev-task[data-task="${target.id}"]`).click();
  const editButton = page.locator('[data-edit-selected-task]');
  await editButton.scrollIntoViewIfNeeded();
  assert.equal(await pane(page, 'tasks').evaluate(element => element.scrollTop), 0);
  const beforeWindow = await page.evaluate(() => scrollY);
  await editButton.click();
  const dialog = page.locator('#task-edit-dialog');
  assert.equal(await dialog.evaluate(element => element.open), true);
  await assertInViewport(dialog);
  await assertInViewport(dialog.locator('.task-edit-header'));
  await assertInViewport(dialog.locator('#task-edit-heading'));
  await assertInViewport(dialog.locator('.task-edit-footer'));
  assert.equal(await page.locator('#review-banner').count(), 1, '整个界面只维护一份审阅表单');
  assert.equal(await dialog.locator('#review-banner').count(), 1, '编辑同一份审阅DOM，不复制草稿');
  const index = run.tasks.indexOf(target), title = page.locator(`[data-review-field="task.${index}.title"]`);
  assert.equal(await title.evaluate(element => document.activeElement === element), true);
  const changedTitle = `${target.title}（明确异常情况）`;
  await title.fill(changedTitle);
  assert.equal(run.tasks[index].title, target.title, '本地填写不直接改保存计划');
  assert.match(await page.locator('#review-plan-preview').textContent(), /未保存/);
  assert.equal(await page.evaluate(() => scrollY), beforeWindow, '就地编辑不反向滚动整个页面');
  const shots = path.resolve('output/workspace-ui'); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `task-dialog-${width}.png`) });
  await page.keyboard.press('Escape');
  assert.equal(await dialog.evaluate(element => element.open), false);
  await assertOnlyView(page, 'tasks');
  assert.equal(await editButton.evaluate(element => document.activeElement === element), true, '关闭编辑器后回到原操作按钮');
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - beforeWindow) <= 4, '关闭编辑器后保留原文档位置');
  assert.equal(await page.locator(`.dev-task[data-task="${target.id}"]`).getAttribute('aria-pressed'), 'true');
  await editButton.click(); assert.equal(await title.inputValue(), changedTitle);
  await dialog.getByRole('button', { name: '返回任务图', exact: true }).click();
  await editButton.click();
  await page.locator('[data-review-add-feature]').click();
  assert.equal(await dialog.evaluate(element => element.open), false, '从任务编辑添加功能时退出编辑对话框');
  await assertOnlyView(page, 'source');
  assert.equal(await page.locator('.source-changes').getByLabel('功能名称', { exact: true }).evaluate(element => document.activeElement === element), true);
  await assertInViewport(page.locator('.source-changes').getByLabel('功能名称', { exact: true }));
  await nav(page, 'tasks').click();
  assert.equal(await page.locator(`.dev-task[data-task="${target.id}"]`).getAttribute('aria-pressed'), 'true');
  assert.equal(await source.inputValue(), sourceDraft);
  assert.equal(modelCalls(), 0); assert.equal(project.runs.length, 1);
  assert.equal(run.approvals.plan, null);
  await page.screenshot({ path: path.join(shots, `workspace-${width}.png`) });
  assert.equal(await app.store.get(project.id).source.content, content);
});

for (const width of [1440, 390]) test(`统一工作台 ${width}px：底部操作时后台失败与网络失败始终可见`, { timeout: 90000 }, async t => {
  const { app, project, page, rejectModel, modelCalls } = await fixture(t, width, { delayedModel: true });
  // Use a short desktop viewport so the source editor still exercises real page scrolling.
  if (width > 760) await page.setViewportSize({ width, height: 600 });
  await page.locator('#mode-select').selectOption('model');
  await page.locator('#start-run').click();
  await until(() => modelCalls() === 1, '受控规格请求进入');
  const run = project.runs.at(-1);
  await nav(page, 'source').click();
  const panel = page.locator('.source-changes'), source = panel.getByLabel('需求正文', { exact: true }), reason = panel.getByLabel('变更原因', { exact: true });
  await source.waitFor(); await source.fill(`${content}\n失败期间仍保留的需求草稿。`);
  await reason.fill('用户正在记录下一项变更'); await reason.focus();
  await reason.evaluate(element => element.setSelectionRange(2, 6));
  const focusedBefore = await reason.evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd]);
  assert.deepEqual(focusedBefore, [true, 2, 6]);
  const beforeFailureScroll = await page.evaluate(() => scrollY);
  const beforeFailureReasonY = await reason.evaluate(element => element.getBoundingClientRect().y);
  assert.ok(beforeFailureScroll > 0, '用户正在整页下方填写，不是在顶部等待错误');
  rejectModel(new Error('受控规格请求失败：请稍后重试，不改变已填写草稿。'));
  await until(() => run.status === 'failed' && !app.orchestrator.state(run).driving, '真实后端失败停点');
  const notice = page.locator('#error-banner');
  await notice.waitFor(); await assertInViewport(notice);
  assert.match(await page.locator('#error-text').textContent(), /整理设计规格/);
  assert.match(await page.locator('#error-text').textContent(), /失败|未完成|尚未生成/);
  await assertOnlyView(page, 'source');
  assert.deepEqual(await reason.evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd]), [true, 2, 6], '失败不能抢输入焦点或选区');
  // Native scroll anchoring may offset scrollY when the workflow above grows.
  assert.ok(Math.abs(await reason.evaluate(element => element.getBoundingClientRect().y) - beforeFailureReasonY) <= 2, '后台失败不得改变正在阅读的输入框视口位置');
  assert.match(await source.inputValue(), /失败期间仍保留/);
  await page.waitForTimeout(4000); await assertInViewport(notice);
  const locate = notice.locator('[data-notice-locate]');
  await locate.click(); await assertOnlyView(page, 'plan');
  assert.equal(await page.locator('#workflow-details').evaluate(element => element.open), true);
  assert.match(await page.locator('#stage-inspector').textContent(), /失败|未完成/);
  const recoveryActions = await page.locator('[data-retry="spec"], [data-spec-repair-action="retry"]').all();
  assert.equal((await Promise.all(recoveryActions.map(button => button.isVisible()))).some(Boolean), true, '定位后提供现有失败恢复操作');
  assert.equal(modelCalls(), 1, '点击定位不重试模型');

  await nav(page, 'source').click();
  assert.match(await source.inputValue(), /失败期间仍保留/);
  await page.locator('#dismiss-error').click();
  let failedPosts = 0;
  await page.route(`**/api/projects/${project.id}/changes`, route => {
    if (route.request().method() === 'POST') { failedPosts++; return route.abort('failed'); }
    return route.continue();
  });
  await panel.getByRole('button', { name: '保存为待应用变更', exact: true }).click();
  await page.waitForFunction(() => /fetch|网络|连接/i.test(document.querySelector('#error-text')?.textContent || ''));
  await assertInViewport(notice); await assertOnlyView(page, 'source');
  assert.equal(failedPosts, 1, '确实拦截了保存请求，不能误读先前失败通知');
  assert.equal(app.sourceChangeService.list({ projectId: project.id }).length, 0);
  assert.match(await reason.inputValue(), /用户正在记录/);
  assert.equal(modelCalls(), 1);
  const shots = path.resolve('output/workspace-ui'); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `persistent-error-${width}.png`) });
});
