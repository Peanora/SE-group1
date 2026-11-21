import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import * as planner from '../lib/planner.mjs';
import { createApp } from '../server.mjs';

for (const width of [1440, 390]) test(`Edge ${width}px automatically generates and follows up on individual questions in the same run`, { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planning-issue-ui-'));
  const source = '我想做一个资源查看系统。';
  const questions = ['首版谁可以查看资源？', '首版能否编辑资源？'];
  const answers = ['首版仅让访客查看可用资源列表。', '不确定'];
  const followUp = questions[1];
  const followUpAnswer = '首版不开放修改。';
  const extraQuestion = '列表的筛选按钮用什么颜色？';
  const specification = {
    title: '资源查看', summary: '首版展示可用资源', goals: [], roles: [], acceptanceScenarios: [],
    constraints: [], assumptions: [], questions: [],
    stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ title: '查看资源', description: '访客可读资源列表', sourceQuote: answers[0], acceptance: ['页面展示可用资源'] }],
  };
  const calls = [];
  const app = await createApp({
    dataDir: directory, stepDelayMs: 0, teamEnabled: false,
    planner: { ...planner,
      getModelConfig: () => ({ configured: true, model: 'planning-issue-fixture' }),
      analyzeWithModel: (text, name, options) => planner.analyzeWithModel(text, name, { ...options, config: { baseUrl: 'http://localhost', model: 'planning-issue-fixture', apiKey: '' },
        fetchImpl: async (_url, request) => {
          calls.push({ text, issue: options.planningIssue, input: JSON.parse(request.body) });
          let reply = specification;
          if (options.planningIssue) reply = options.planningIssue.message.includes('需求摘要为空')
            ? { explanation: '摘要缺少首版目标。', questions: ['首版要解决什么问题？'] }
            : { explanation: '请一次确认首版的查看和编辑权限。', questions };
          else if (calls.length === 2) reply = { ...specification, requirements: [] };
          else if (text.includes(answers[0])) reply = { ...specification, questions: [...questions, extraQuestion] };
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
        },
      }),
    },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('planning-issue-ui-'));
    await rm(directory, { recursive: true, force: true });
  });
  const project = await app.store.create({ name: '规划问答示例', source: { filename: 'source.md', content: source } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !(message.location().url.endsWith('/action') && /status of 400\b/.test(message.text()))) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${app.server.address().port}/?view=details`);
  await page.locator('#mode-select').selectOption('model');
  assert.match(await page.locator('#planning-charge-notice').innerText(), /规格调用次数不限.*工程调用次数不限/);
  await page.locator('#start-run').click();
  const panel = page.locator('#planning-issue-host');
  await page.locator('#workspace-next-root').filter({ hasText: '查看问题' }).click();
  await panel.waitFor();
  assert.equal(await panel.locator('h3').evaluate(heading => document.activeElement === heading), true);
  await panel.getByRole('heading', { name: '模型草案第 1 条 · 查看资源' }).waitFor();
  assert.equal(await panel.getByText('访客可读资源列表', { exact: true }).isVisible(), true);
  assert.equal(await panel.locator('[data-issue-draft-quote]').textContent(), answers[0]);
  assert.equal(await panel.getByRole('textbox').count(), 0);
  assert.equal(calls.length, 1);
  await panel.getByRole('button', { name: '用已保存的回答重新整理', exact: true }).click();
  const [first, second] = questions.map(name => panel.getByRole('textbox', { name, exact: true }));
  const submit = panel.getByRole('button', { name: '提交本轮回答', exact: true });
  await second.waitFor();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].issue.allowQuestions, true);
  assert.ok(calls[2].text.includes(source));
  const current = app.store.get(project.id).runs.at(-1);
  assert.equal(current.planningIssueHistory[0].receiptState, 'saved');
  assert.deepEqual(current.planningIssueHistory[0].usage, { inputTokens: 12, outputTokens: 8 });
  await first.fill(answers[0]);
  assert.equal(await first.evaluate(input => document.activeElement === input), true);
  assert.equal(await submit.isDisabled(), true);
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await panel.getByText('回答已保存。', { exact: true }).waitFor();
  assert.equal(calls.length, 3);
  await page.reload();
  await page.locator('#workspace-next-root').filter({ hasText: '查看问题' }).click();
  await panel.waitFor();
  assert.equal(await first.inputValue(), answers[0]);
  assert.equal(await second.inputValue(), '');
  assert.equal(calls.length, 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await second.fill(answers[1]);
  await submit.click();
  const next = panel.getByRole('textbox', { name: followUp, exact: true });
  await panel.getByText(/上次回答「不确定」/u).waitFor();
  await first.waitFor({ state: 'detached' });
  assert.equal(await panel.locator('h3').evaluate(heading => document.activeElement === heading), true);
  assert.equal(await panel.getByRole('textbox').count(), 1);
  assert.equal(await panel.getByText(extraQuestion, { exact: true }).count(), 0);
  assert.match(await page.locator('[data-stage="spec"] .node-meta').innerText(), /等待补充需求/u);
  assert.match(await page.locator('#run-progress').innerText(), /^1 \/ 6/u);
  assert.equal(calls.length, 4);
  assert.equal(current.approvals.spec, null);
  assert.ok(questions.every((question, index) => calls[3].text.includes(`${question}\n答复：${answers[index]}`)));
  assert.deepEqual(JSON.parse(calls[3].input.messages[1].content).openQuestions, questions);
  await next.fill('不确定');
  await submit.click();
  await panel.getByText(/第 1 题仍需明确答复/u).waitFor();
  assert.equal(calls.length, 4);
  await next.fill(followUpAnswer);
  await submit.click();
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).waitFor();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(calls.length, 5);
  assert.ok(calls[4].text.includes(`${followUp}\n答复：${followUpAnswer}`));
  assert.equal(current.sourceSnapshot.content, source);
  assert.deepEqual(current.clarificationHistory.map(round => round.answers.map(item => item.answer)), [answers, [followUpAnswer]]);
  assert.equal(current.approvals.spec, null);
  assert.equal(current.planningIssueDraft, undefined);
  assert.equal(app.store.get(project.id).runs.length, 1);
  if (width === 390) {
    const summary = page.locator('[data-review-field="spec.summary"]');
    await summary.fill('');
    const review = page.locator('#review-banner');
    const validation = page.waitForResponse(response => response.url().endsWith('/action') && response.request().postDataJSON()?.action === 'revise_spec');
    await review.getByRole('button', { name: '保存修订', exact: true }).click();
    assert.equal((await validation).status(), 400);
    await review.locator('[data-review-issue]').click();
    await panel.getByText('需求摘要为空，请概括要解决的问题和首版要实现的内容。', { exact: true }).waitFor();
    await panel.getByRole('textbox', { name: '首版要解决什么问题？', exact: true }).waitFor();
    assert.equal(await summary.inputValue(), '');
    assert.notEqual(current.spec.summary, '');
    assert.equal(calls.length, 6);
  }
  assert.deepEqual(errors, []);
});
