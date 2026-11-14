import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

test('actual model-mode controls disclose specification budgets and refuse a service that omits them', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'specification-usage-browser-'));
  let calls = 0;
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, specificationMaxCalls: 2, specificationTimeoutMs: 1000,
    planner: { ...planner, getModelConfig: () => ({ configured: true, model: 'usage-ui-fixture' }), analyzeWithModel: () => { calls++; assert.fail('仅核对预算披露，不调用模型'); } } });
  const project = await app.store.create({ name: '规格预算界面', source: { filename: 'r.md', content: '用户读取资源。' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => { await browser.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('specification-usage-browser-')); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  await page.route('**/api/health', async route => { const response = await route.fetch(), body = await response.json(); delete body.modelPlanning.specificationMaxCalls; delete body.modelPlanning.specificationTimeoutMs; await route.fulfill({ response, json: body }); });
  await page.goto(url); await page.waitForFunction(() => !document.querySelector('#start-run').disabled);
  await page.locator('#mode-select').selectOption('model');
  assert.equal(await page.locator('#start-run').isDisabled(), true); assert.match(await page.locator('#planning-model-notice').textContent(), /未提供规格调用预算/);
  await page.locator('#mode-select').selectOption('local'); assert.equal(await page.locator('#start-run').isEnabled(), true);
  await page.unroute('**/api/health'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#start-run').disabled);
  await page.locator('#mode-select').selectOption('model'); assert.equal(await page.locator('#start-run').isEnabled(), true);
  assert.match(await page.locator('#planning-model-notice').textContent(), /规格整理最多尝试 2 次，单次最多 1 秒/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const health = await (await fetch(url + '/api/health')).json();
  assert.equal(health.modelPlanning.specificationMaxCalls, 2); assert.equal(health.modelPlanning.specificationTimeoutMs, 1000);
  assert.equal(calls, 0); assert.equal(app.store.get(project.id).runs.length, 0); assert.deepEqual(errors, []);
});
