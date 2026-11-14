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
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'source-change-browser-'));
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner, analyzeRequirements: spec, getModelConfig: () => ({ configured: false }), analyzeWithModel: () => assert.fail('本轮需求版本检查不允许模型调用') } });
  const project = await app.store.create({ name: '同项目需求版本', source: { filename: 'original.md', content: original } });
  const run = await app.orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('source-change-browser-')); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(url); await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  await page.locator('#source-changes-section > summary').click();
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
  await page.getByRole('heading', { name: '历史需求输入：确认记录只读', exact: true }).waitFor();
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
