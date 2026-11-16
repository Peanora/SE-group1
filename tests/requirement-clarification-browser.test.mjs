import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

for (const width of [1440, 390]) test(`Edge ${width}px：一句话需求可澄清、保存刷新、继续生成新规格`, { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-clarification-browser-'));
  const source = '我想做一个类似微信的聊天软件';
  const raw = { title: '聊天软件', summary: '首版范围待补充', goals: ['聊天软件'], roles: [], acceptanceScenarios: [], constraints: [], assumptions: [], requirements: [], questions: ['目标平台是什么？', '首版需要哪些功能？'], stack: { frontend: '待确认', backend: '待确认', storage: '待确认' } };
  let calls = 0, received;
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner,
    getModelConfig: () => ({ configured: true, model: 'clarification-mock' }),
    analyzeWithModel: (text, name, options) => planner.analyzeWithModel(text, name, { ...options, config: { baseUrl: 'http://localhost', model: 'clarification-mock', apiKey: '' }, fetchImpl: async () => {
      calls++; received = text;
      const final = { ...raw, summary: '首版聊天范围', questions: [], requirements: [{ title: '文字聊天', description: '首版支持文字聊天', sourceQuote: '首版只做文字聊天', acceptance: ['用户可以发送和接收文字消息'] }] };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls === 1 ? raw : final) } }] }));
    } }) } });
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '微信', source: { filename: 'requirements.md', content: source } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: 950 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.goto(url); await page.locator('#mode-select').selectOption('model'); await page.locator('#start-run').click();
  await page.getByRole('heading', { name: '需要补充需求信息', exact: true }).waitFor();
  assert.match(await page.locator('#run-status').innerText(), /等待补充需求/);
  assert.equal(await page.getByRole('button', { name: '根据回答整理规格', exact: true }).isDisabled(), true);
  await page.getByLabel(/Q-001/).fill('Web网页'); await page.getByLabel(/Q-002/).fill('首版只做文字聊天');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-review-action="save"]').disabled);
  assert.equal(calls, 1);
  await page.reload(); await page.getByRole('heading', { name: '需要补充需求信息', exact: true }).waitFor();
  assert.equal(await page.getByLabel(/Q-002/).inputValue(), '首版只做文字聊天');
  assert.match(await page.locator('#review-banner').innerText(), /新增一次模型请求/);
  await page.getByRole('button', { name: '根据回答整理规格', exact: true }).click();
  await page.getByRole('heading', { name: '先确认规格，再生成开发计划', exact: true }).waitFor();
  assert.equal(calls, 2); assert.ok(received.includes('首版只做文字聊天'));
  const run = app.store.get(project.id).runs[0];
  assert.equal(run.status, 'awaiting_spec'); assert.equal(run.approvals.spec, null); assert.equal(run.sourceSnapshot.content, source);
  assert.equal(await page.getByRole('button', { name: '确认规格并继续', exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(errors, []);
});
