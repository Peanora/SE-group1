import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';
import { createZip } from '../lib/zip.mjs';

const original = '用户可以读取资源。';
const changed = '用户可以读取资源，并查看新增的说明字段。';
const spec = content => ({ title: '资源目录', summary: content, goals: [], roles: ['用户'], questions: [], constraints: [], assumptions: [], acceptanceScenarios: [],
  stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, sourceMode: 'local',
  requirements: [{ id: 'R1', title: '读取资源', description: content, sourceQuote: content, acceptance: ['按当前需求展示资源'] }] });
async function waitFor(check) { const end = Date.now() + 10000; while (!check()) { if (Date.now() >= end) throw new Error('规划停点等待超时'); await delay(5); } }
async function fixture(t, { allowRunConflict = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'source-change-browser-'));
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner, analyzeRequirements: spec, getModelConfig: () => ({ configured: false }), analyzeWithModel: () => assert.fail('本轮需求版本检查不允许模型调用') } });
  const project = await app.store.create({ name: '同项目需求版本', source: { filename: 'original.md', content: original } });
  const run = await app.orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', item => {
    if (item.type() === 'error' && !(allowRunConflict && item.location().url.endsWith(`/api/projects/${project.id}/runs`) && /409/.test(item.text()))) errors.push(item.text());
  });
  t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('source-change-browser-')); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(url + '/?view=details'); await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  await page.locator('[data-workspace-view="source"]').click();
  await page.locator('.source-changes').getByLabel('需求正文', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.source-changes textarea.sc-source').disabled);
  const request = async (route, body) => { const response = await fetch(url + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  return { directory, app, project, run, page, request };
}

test('actual workbench parses Word into a pending draft, applies it, keeps history read-only and exports a newly confirmed plan', { timeout: 90000 }, async t => {
  const { app, project, run, page, request } = await fixture(t), oldSnapshot = structuredClone(run.sourceSnapshot), oldSpecRevision = run.specRevision;
  const docx = createZip([{ name: 'word/document.xml', content: `<w:document><w:body><w:p><w:r><w:t>${changed}</w:t></w:r></w:p></w:body></w:document>` }]);
  await page.getByLabel('导入 MD / TXT / DOCX（最大 3 MiB）').setInputFiles({ name: 'new.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
  await page.getByRole('button', { name: '导入文件到草稿', exact: true }).click();
  await page.waitForFunction(value => document.querySelector('.source-changes textarea.sc-source').value === value, changed);
  assert.equal(project.source.content, original); assert.equal(app.sourceChangeService.list({ projectId: project.id }).length, 0);
  await page.getByLabel('变更原因', { exact: true }).fill('增加说明字段，并保留历史');
  await page.getByLabel('变更分类（仅标签）').selectOption('field');
  await page.getByRole('button', { name: '保存为待应用变更', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.source-changes button')].find(el => el.textContent === '应用为新需求版本')?.disabled);
  assert.equal(project.source.content, original); assert.equal(run.sourceSuperseded, undefined);
  assert.match(await page.locator('.source-changes').innerText(), /待应用|pending/);
  assert.match(await page.locator('.source-changes').innerText(), /迁移/);
  await page.getByRole('button', { name: '应用为新需求版本', exact: true }).click();
  await page.locator('[data-workspace-view="plan"]').click();
  await page.getByRole('heading', { name: '历史需求输入：确认记录只读', exact: true }).waitFor();
  assert.equal(project.sourceGeneration, 1); assert.equal(project.source.content, changed); assert.equal(run.sourceSuperseded, true);
  assert.deepEqual(run.sourceSnapshot, oldSnapshot); assert.equal(run.specRevision, oldSpecRevision);
  assert.equal(await page.locator('[data-review-action]').count(), 0); assert.equal(await page.locator('#start-run').isEnabled(), true);
  await page.locator('#source-button').click(); assert.equal(await page.locator('#source-content').textContent(), original);
  await page.locator('#source-dialog [data-close-dialog]').first().click();
  await page.locator('#start-run').click(); await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  const next = project.runs.at(-1); assert.notEqual(next.id, run.id); assert.equal(next.sourceGeneration, 1); assert.equal(next.sourceSnapshot.content, changed); assert.deepEqual(next.approvals, { spec: null, plan: null });
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).click(); await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click(); await page.locator('#download-bundle').waitFor({ state: 'visible' });
  const exported = await request(`/api/projects/${project.id}/runs/${next.id}/artifacts/plan.json`);
  assert.equal(exported.sourceGeneration, 1); assert.equal(exported.sourceRevision, next.sourceRevision);
  await page.locator('#run-select').selectOption(run.id); await page.getByRole('heading', { name: '历史需求输入：确认记录只读', exact: true }).waitFor();
  await page.reload(); await page.getByRole('heading', { name: '历史需求输入：确认记录只读', exact: true }).waitFor();
  assert.equal(project.runs.length, 2); assert.equal(await page.locator('[data-review-action]').count(), 0);
});

test('external source publication is observed by polling without replacing a focused draft or retaining old approval actions', { timeout: 60000 }, async t => {
  const { app, project, run, page } = await fixture(t);
  const body = page.locator('.source-changes').getByLabel('需求正文', { exact: true });
  await body.fill('尚未保存的个人草稿'); await body.focus(); await body.evaluate(el => el.setSelectionRange(2, 5));
  await page.setViewportSize({ width: 390, height: 844 });
  const change = app.sourceChangeService.request({ projectId: project.id, baseRevision: app.store.getSourceVersion(project.id).revision,
    source: { filename: 'external.md', content: changed }, reason: '另一次请求应用需求', kind: 'field', requestKey: 'external-publication' });
  await app.sourceChangeService.apply({ projectId: project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation });
  await page.waitForFunction(() => document.querySelector('#review-heading')?.textContent === '历史需求输入：确认记录只读');
  assert.equal(await page.locator('#workspace-source').isVisible(), true, '外部需求更新不能打断当前工作面');
  assert.equal(await body.inputValue(), '尚未保存的个人草稿');
  assert.deepEqual(await body.evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 2, 5]);
  assert.equal(await page.getByRole('button', { name: '保存为待应用变更', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('[data-review-action]').count(), 0); assert.equal(await page.locator('#start-run').isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(run.sourceSuperseded, true); assert.equal(run.sourceSnapshot.content, original);
  const shots = path.resolve('output/verification/source-change-browser'); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'mobile-source-history.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(shots, 'desktop-source-history.png'), fullPage: true });
  await page.getByRole('button', { name: '基于当前版本重新编辑', exact: true }).click(); assert.equal(await body.inputValue(), changed);
  assert.equal(await page.getByRole('button', { name: '保存为待应用变更', exact: true }).isEnabled(), true);
});

test('late parent refresh after applying a source cannot announce success in a different selected project', { timeout: 60000 }, async t => {
  const { app, project, page } = await fixture(t);
  const other = await app.store.create({ name: '另一个项目', source: { filename: 'other.md', content: '读取另一组独立资源。' } });
  await page.locator('#refresh-button').click();
  await page.locator(`[data-project="${other.id}"]`).waitFor();
  const change = app.sourceChangeService.request({ projectId: project.id, baseRevision: app.store.getSourceVersion(project.id).revision,
    source: { filename: 'new.md', content: changed }, reason: '检查迟到通知归属', kind: 'field', requestKey: 'late-parent-refresh' });
  await page.getByRole('button', { name: '刷新变更状态', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.source-changes button')].find(el => el.textContent === '应用为新需求版本')?.disabled);
  let projectReads = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  await page.route(`**/api/projects/${project.id}`, async route => {
    if (route.request().method() === 'GET' && ++projectReads === 2) { entered(); await held; }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '应用为新需求版本', exact: true }).click();
    await waiting;
    await page.locator(`[data-project="${other.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#project-title').textContent === '另一个项目');
  } finally { release(); }
  await page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}`));
  await page.waitForTimeout(100);
  assert.equal(project.sourceGeneration, 1); assert.equal(app.sourceChangeService.list({ projectId: project.id }).find(item => item.id === change.id).status, 'applied');
  assert.doesNotMatch(await page.locator('#toast').textContent(), /新需求已应用/);
  assert.equal(await page.locator('#project-title').textContent(), other.name);
});

test('新增功能在真实工作台经草稿、保存、应用和单独重新规划，桌面与窄屏保留旧运行归属', { timeout: 90000 }, async t => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const { app, project, run, page } = await fixture(t); await page.setViewportSize(viewport);
    const panel = page.locator('.source-changes'), source = panel.getByLabel('需求正文', { exact: true }), oldSnapshot = structuredClone(run.sourceSnapshot);
    await source.fill(`${original}\n已有未保存的补充说明。`);
    await panel.getByRole('button', { name: '新增功能', exact: true }).click();
    await panel.getByLabel('功能名称', { exact: true }).fill('资源筛选'); await panel.getByLabel('功能说明', { exact: true }).fill('用户可以按资源类型筛选结果。');
    await panel.getByLabel('功能验收条件（每行一条）').fill('选择某一类型后仅显示对应资源\n清除条件后恢复全部结果');
    assert.equal(project.source.content, original); assert.equal(app.sourceChangeService.list({ projectId: project.id }).length, 0);
    assert.equal(await panel.getByRole('button', { name: '重新规划', exact: true }).isDisabled(), true);
    const featureShots = path.resolve('output/visual-task-changes'); await mkdir(featureShots, { recursive: true });
    await panel.locator('.sc-feature').screenshot({ path: path.join(featureShots, `feature-${viewport.width}.png`) });
    await panel.getByRole('button', { name: '加入需求草稿', exact: true }).click(); const merged = await source.inputValue();
    assert.ok(merged.startsWith(`${original}\n已有未保存的补充说明。\n\n## 新增功能：资源筛选`));
    assert.ok(merged.includes('- 清除条件后恢复全部结果')); assert.equal(project.source.content, original); assert.equal(project.runs.length, 1);
    await page.reload(); await page.locator('[data-workspace-view="source"]').click();
    await panel.getByLabel('功能名称', { exact: true }).waitFor(); assert.equal(await panel.getByLabel('功能名称', { exact: true }).inputValue(), '资源筛选'); assert.equal(await source.inputValue(), merged);
    await panel.getByRole('button', { name: '保存为待应用变更', exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.source-changes button')].find(el => el.textContent === '应用为新需求版本')?.disabled);
    assert.equal(project.source.content, original); assert.equal(project.runs.length, 1); assert.match(await panel.getByLabel('新增功能流程').innerText(), /后端已确认保存/);
    await panel.getByRole('button', { name: '应用为新需求版本', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#review-heading')?.textContent === '历史需求输入：确认记录只读');
    const replan = panel.getByRole('button', { name: '重新规划', exact: true });
    await page.waitForFunction(() => ![...document.querySelectorAll('.source-changes button')].find(el => el.textContent === '重新规划')?.disabled);
    assert.equal(project.source.content, merged); assert.equal(project.sourceGeneration, 1); assert.equal(project.runs.length, 1);
    assert.equal(run.sourceSuperseded, true); assert.deepEqual(run.sourceSnapshot, oldSnapshot); assert.match(await panel.getByLabel('新增功能流程').innerText(), /后端已确认新版本/);
    const shots = path.resolve('output/verification/source-feature-browser'); await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `applied-${viewport.width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await replan.click(); await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
    assert.equal(project.runs.length, 2); const next = project.runs.at(-1);
    assert.notEqual(next.id, run.id); assert.equal(next.sourceGeneration, 1); assert.equal(next.sourceSnapshot.content, merged); assert.equal(next.status, 'awaiting_spec');
    assert.deepEqual(next.approvals, { spec: null, plan: null }); assert.equal(run.sourceSuperseded, true);
  }
});

test('重新规划请求在途时另一窗口发布新版，拒绝过期请求且不创建运行', { timeout: 60000 }, async t => {
  const { app, project, run, page } = await fixture(t, { allowRunConflict: true });
  const panel = page.locator('.source-changes');
  await panel.getByLabel('需求正文', { exact: true }).fill(changed);
  await panel.getByLabel('变更原因', { exact: true }).fill('先确认功能A');
  await panel.getByRole('button', { name: '保存为待应用变更', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.source-changes button')].find(button => button.textContent === '应用为新需求版本')?.disabled);
  await panel.getByRole('button', { name: '应用为新需求版本', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.source-changes button')].find(button => button.textContent === '重新规划')?.disabled);
  const revision = project.currentSourceRevision, generation = project.sourceGeneration;
  let release, entered, requestBody;
  const hold = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { entered = resolve; });
  await page.route(`**/api/projects/${project.id}/runs`, async route => {
    if (route.request().method() === 'POST') { requestBody = route.request().postDataJSON(); entered(); await hold; }
    await route.continue();
  });
  try {
    const rejected = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/runs`) && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '重新规划', exact: true }).click(); await intercepted;
    assert.equal(requestBody.expectedSourceRevision, revision); assert.equal(requestBody.expectedSourceGeneration, generation);
    const external = app.sourceChangeService.request({ projectId: project.id, baseRevision: revision, source: { filename: project.source.filename, content: `${changed}\n其他窗口增加资源筛选。` }, reason: '其他窗口提交功能B', kind: 'other', requestKey: 'source-binding-browser-race' });
    await app.sourceChangeService.apply({ projectId: project.id, changeId: external.id, baseRevision: external.baseRevision, generation: external.generation });
    release(); assert.equal((await rejected).status(), 409);
    await page.waitForFunction(() => !document.querySelector('#error-banner').hidden);
    assert.match(await page.locator('#error-text').textContent(), /版本/);
    assert.equal(project.runs.length, 1); assert.equal(project.runs[0].id, run.id);
    assert.equal(project.sourceGeneration, generation + 1); assert.equal(project.currentSourceRevision, external.sourceRevision);
  } finally { release(); }
});
