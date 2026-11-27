import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { WORKFLOW } from '../lib/orchestrator.mjs';
import { contentRevision } from '../lib/planning-review.mjs';

const exactCommit = 'a'.repeat(40);
const otherCommit = 'b'.repeat(40);
const text = '用户可查看资源列表。';
const lateMessage = '选中的历史执行留有接口失败记录';
const earlyMessage = '整理规划时保存的阶段事件';
const leakedMessage = '这个执行属于其他运行';
const nav = (page, view) => page.locator(`[data-workspace-view="${view}"]`);
const trace = page => page.locator('#studio-trace-host');

function archivedExecution(projectId, run, extra = {}) {
  return {
    id: 'archived-attempt', projectId, runId: run.id, kind: 'planned_web',
    status: 'failed', current: false, active: false, accepted: false, candidateCommit: otherCommit,
    binding: { projectId, runId: run.id, specRevision: run.specRevision, planRevision: run.planRevision,
      sourceRevision: run.sourceRevision, sourceGeneration: run.sourceGeneration },
    events: [{ sequence: 1, at: '2026-11-28T08:06:00Z', status: 'failed', message: lateMessage }],
    reviewHistory: [
      { candidateCommit: exactCommit, status: 'changes_requested', issues: [{ severity: 'blocking', status: 'open' }] },
      { candidateCommit: exactCommit, status: 'changes_requested', issues: [{ severity: 'blocking', status: 'open' }] },
    ],
    checks: { http: [{ passed: true }], browser: [{ passed: true }], review: 'not_started' },
    ...extra,
  };
}

test('workflow trace keeps a selected historical run separate and uses exact candidate evidence at desktop and narrow widths', { timeout: 50000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-workflow-trace-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^taskflow-workflow-trace-/u);
    await rm(directory, { recursive: true, force: true });
  });
  app = await createApp({ dataDir: directory, teamEnabled: false });
  const project = await app.store.create({ name: '研发轨迹验收', source: { filename: 'requirements.md', content: text } });
  const stamp = '2026-11-28T08:03:00Z';
  const revision = 'c'.repeat(64);
  const stages = WORKFLOW.map(stage => ({ ...stage, status: 'succeeded', attempt: 1, startedAt: stamp, finishedAt: stamp }));
  const common = {
    projectId: project.id, mode: 'local', workflowVersion: 2, status: 'succeeded', sourceSnapshot: project.source,
    sourceGeneration: 0, sourceRevision: contentRevision(project.source), specRevision: revision, planRevision: 'e'.repeat(64),
    specVersion: 1, planVersion: 1, stages, tasks: [], spec: null, artifacts: [], review: { passed: true, issues: [] },
  };
  const approval = { revision, at: stamp, feedback: '规格来源已核对' };
  const historicalRun = {
    ...common, id: 'archived-run', sourceSuperseded: true, sourceRevision: 'd'.repeat(64), createdAt: '2026-11-27T08:00:00Z',
    approvals: { spec: approval }, decisions: [{ ...approval, action: 'approve_spec' }],
    events: [{ sequence: 1, time: '2026-11-28T08:02:00Z', stageId: 'spec', level: 'info', message: earlyMessage }],
  };
  const currentRun = { ...common, id: 'current-run', createdAt: '2026-11-28T10:00:00Z',
    events: [{ sequence: 1, time: '2026-11-28T10:00:00Z', stageId: null, level: 'info', message: '当前规划已打开' }] };
  project.runs.push(historicalRun, currentRun);
  await app.store.save(project);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', record => { if (record.type() === 'error') errors.push(record.text()); });
    page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()); });
    await page.route(`**/runs/*/development-executions`, route => {
      const history = route.request().url().includes(`/${historicalRun.id}/`);
      return route.fulfill({ json: { capabilities: { canStart: false },
        executions: history ? [
          archivedExecution(project.id, historicalRun),
          archivedExecution(project.id, currentRun, { id: 'wrong-run', events: [{ message: leakedMessage, at: stamp }] }),
        ] : [],
      } });
    });
    await page.goto(`${url}/?project=${project.id}&run=${currentRun.id}&view=trace`);
    await trace(page).getByText('当前规划已打开', { exact: true }).waitFor();
    await trace(page).getByText('本次运行暂无开发记录。', { exact: true }).waitFor();
    await page.locator('#run-select').selectOption(historicalRun.id);
    await trace(page).getByText(lateMessage, { exact: true }).waitFor();
    assert.equal(await trace(page).getByText('历史需求 · 只读', { exact: true }).isVisible(), true);
    assert.equal(await trace(page).getByText('当前规划已打开', { exact: true }).count(), 0);
    assert.equal(await trace(page).getByText(leakedMessage, { exact: true }).count(), 0);
    assert.equal(await trace(page).getByText('规格来源已核对', { exact: true }).count(), 1);
    assert.deepEqual(await trace(page).locator('time').evaluateAll(entries => entries.map(item => item.dateTime)),
      ['2026-11-28T08:06:00Z', stamp, '2026-11-28T08:02:00Z']);
    assert.equal(await trace(page).locator(`[data-trace-commit="${exactCommit}"]`).count(), 1);
    const historicalCandidate = trace(page).locator('.run-trace-row').filter({ has: page.locator(`[data-trace-commit="${exactCommit}"]`) });
    assert.equal(await historicalCandidate.locator('time').count(), 0);
    assert.match(await historicalCandidate.innerText(), /接口未记录结果。浏览器未记录结果。代码审查需修订，1 项阻塞/u);
    await trace(page).getByRole('combobox', { name: '记录来源' }).selectOption('execution');
    await trace(page).getByRole('checkbox', { name: '仅异常' }).check();
    assert.equal(await trace(page).locator('.run-trace-row').count(), 2);
    assert.equal(await trace(page).locator(`[data-trace-commit="${otherCommit}"]`).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await historicalCandidate.getByRole('button', { name: '查看候选证据' }).press('Enter');
    const inspector = page.locator(`#workspace-execution .pe-process-inspector[data-candidate-commit="${exactCommit}"]`);
    await inspector.waitFor();
    assert.equal(await inspector.getByText('所选历史候选', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('link', { name: '下载当前已验收源码', exact: true }).isVisible(), false);
    await nav(page, 'trace').click();
    await trace(page).getByRole('combobox', { name: '记录来源' }).selectOption('planning');
    await trace(page).getByRole('checkbox', { name: '仅异常' }).uncheck();
    await trace(page).locator('[data-trace-stage="spec"]').press('Enter');
    assert.equal(await nav(page, 'plan').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#stage-inspector').evaluate(element => document.activeElement === element), true);
    assert.deepEqual(mutations, []);
    assert.deepEqual(errors, []);
    await page.close();
  }
});
