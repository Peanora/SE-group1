import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';

const source = '# 图书参考流程\n\n## 目标\n开发用于检查工作台连接的图书网页。\n\n## 功能需求\n### F01 登录与借阅\n用户登录后可以查看图书并借阅，归还后库存恢复。\n\n## 技术约束\n前端使用原生 HTML CSS JavaScript，后端使用 Node.js，数据使用 SQLite。\n\n## 验收场景\n用户可以登录并完成借阅和归还。';
const profile = { id: 'library-web-v1', title: '固定图书借阅参考项目', description: '仅执行参考契约，不代表任意上传业务已实现。', contractRevision: 'c'.repeat(64) };

test('real workbench confirms both planning versions before its execution panel can send an explicitly scoped request', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-execution-browser-')), starts = [], records = new Map();
  let app, shutdowns = 0;
  // Explicit controller fixture: no model, target code, or business acceptance is performed here.
  const executionService = {
    async list({ projectId, runId }) {
      const { run } = app.store.getRun(projectId, runId);
      const confirmed = !!run.specRevision && !!run.planRevision && run.approvals?.spec?.revision === run.specRevision
        && run.approvals?.plan?.revision === run.planRevision && run.approvals?.plan?.specRevision === run.specRevision;
      return { capabilities: { canStart: confirmed, profiles: [profile], model: { name: '界面连接替身，零模型请求' },
        budget: { maxCalls: 1, maxReviewCalls: 1, timeoutMs: 60000 } }, executions: records.get(runId) || [] };
    },
    async start(input) {
      const { run } = app.store.getRun(input.projectId, input.runId);
      assert.equal(run.approvals.spec.revision, run.specRevision); assert.equal(run.approvals.plan.revision, run.planRevision);
      starts.push(structuredClone(input));
      const execution = { id: 'ui-connection-only', status: 'failed', taskAccepted: false, calls: 0, reviewCalls: 0,
        error: '可信界面连接替身；未生成软件、未调用模型。', usage: { inputTokens: null, outputTokens: null },
        budget: { maxCalls: 1, maxReviewCalls: 1, timeoutMs: 60000 }, versions: [], preview: null,
        actions: { canCancel: false, canRetry: false, canPreview: false, canStopPreview: false, canDownload: false },
        events: [{ sequence: 1, time: new Date().toISOString(), message: '路由已收到当前运行及固定参考契约。' }] };
      records.set(input.runId, [execution]); return { execution };
    },
    async action() { assert.fail('No action was authorized by this UI wiring fixture'); },
    async download() { assert.fail('A failed UI fixture must never offer a software download'); },
    async shutdown() { shutdowns++; },
  };
  app = await createApp({ dataDir: path.join(directory, 'data'), stepDelayMs: 0, executionService });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => {
    await browser.close(); await app.close(); assert.equal(shutdowns, 1);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('web-execution-browser-'));
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const response = await fetch(url + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const { project } = await request('/api/projects', { name: '实际规划接线', filename: 'reference.md', content: source });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  await page.goto(url); await page.locator('#start-run').waitFor({ state: 'visible' });
  const start = page.getByRole('button', { name: '使用配置模型开始执行', exact: true });
  const consent = page.locator('.execution-panel').getByRole('checkbox');
  await page.locator('#start-run').click();
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  assert.equal(await start.isDisabled(), true); assert.equal(starts.length, 0);
  for (const answer of await page.locator('[data-review-field^="answer."]').all()) await answer.fill('本次由测试负责人完成，优先打通参考流程，完成后按现有依赖验收；无额外交付期限。');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#approve-button')?.disabled);
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).click();
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  assert.equal(await start.isDisabled(), true); assert.equal(starts.length, 0);
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.execution-panel .ep-body').textContent.includes('配置模型：界面连接替身'));
  const run = app.store.get(project.id).runs.at(-1);
  assert.equal(run.workflowVersion, 2); assert.equal(run.approvals.spec.revision, run.specRevision); assert.equal(run.approvals.plan.revision, run.planRevision);
  await consent.check(); await page.waitForFunction(() => !document.querySelector('.execution-panel .ep-primary').disabled);
  await start.click(); await page.getByText('可信界面连接替身；未生成软件、未调用模型。', { exact: true }).waitFor();
  assert.deepEqual(starts, [{ projectId: project.id, runId: run.id, profileId: profile.id, contractRevision: profile.contractRevision }]);
  assert.match(await page.locator('.execution-panel .ep-result').textContent(), /尚未通过验收/u);
  assert.match(await page.locator('.execution-panel .ep-facts').textContent(), /未知/u);
  assert.equal(await page.getByRole('link', { name: '下载已验收源码' }).isVisible(), false);
  assert.equal(await page.getByRole('link', { name: '打开本地预览' }).isVisible(), false);
  const shots = path.resolve('output/verification/web-execution-browser'); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(shots, 'mobile.png'), fullPage: true });
  await page.reload(); await page.getByText('可信界面连接替身；未生成软件、未调用模型。', { exact: true }).waitFor();
  assert.equal(await consent.isChecked(), false); assert.equal(await start.isDisabled(), true);

  // Switching the planning selector must remove old execution permission before GET settles.
  const { run: next } = await request(`/api/projects/${project.id}/runs`, { mode: 'local' });
  await page.reload();
  await page.locator('#run-select').selectOption(run.id);
  await page.getByText('可信界面连接替身；未生成软件、未调用模型。', { exact: true }).waitFor();
  await consent.check(); await page.waitForFunction(() => !document.querySelector('.execution-panel .ep-primary').disabled);
  let release, intercepted = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/projects/${project.id}/runs/${next.id}`, async route => { intercepted = true; await held; await route.continue(); });
  await page.locator('#run-select').selectOption(next.id);
  await page.waitForFunction(() => document.querySelector('.execution-panel .ep-notice').textContent.includes('选择一个已确认'));
  assert.equal(intercepted, true); assert.equal(await start.isDisabled(), true); assert.equal(starts.length, 1);
  release(); await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  assert.equal(await start.isDisabled(), true); assert.equal(await consent.isChecked(), false);
  assert.deepEqual(errors, []);
});
