import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { ProjectStore } from '../lib/store.mjs';
import { createWebExecutionService } from '../lib/web-execution-service.mjs';

const enabled = process.platform === 'win32' && process.env.TASKFLOW_TEST_REAL_SANDBOX === '1';
const source = '# 连接验证\n\n## 功能需求\n用户登录后借阅和归还图书。\n\n## 技术约束\n前端原生HTML，服务端Node.js，数据库SQLite。';

test('approved workbench reaches the real isolated executor and persists its genuine failed checks without any model request', { skip: !enabled, timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-execution-connected-'));
  const store = await new ProjectStore(path.join(directory, 'data')).init(), serviceRoot = path.join(directory, 'service');
  const files = [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:503,headers:{"content-type":"application/json"},body:"{\\"error\\":\\"deliberately missing business\\"}"}}}}\n' }];
  let codeCalls = 0, reviewCalls = 0;
  const options = { rootDir: serviceRoot, getPlanning: async (projectId, runId) => structuredClone(store.getRun(projectId, runId)),
    config: { baseUrl: 'http://localhost:1', model: 'trusted-negative-test-no-network', apiKey: 'synthetic-test-only' },
    executable: process.env.EXECUTION_SANDBOX_EXE, budget: { maxCalls: 1, maxReviewCalls: 1, timeoutMs: 60000 },
    dependencies: {
      // Only proposal transport is substituted. Workspace, Git, MXC, HTTP tests,
      // lifecycle persistence and browser workbench are the actual components.
      codeModel: () => async ({ onReceipt }) => {
        codeCalls++;
        await onReceipt({ model: 'trusted-negative-test-no-network', finishReason: 'stop', usage: { inputTokens: null, outputTokens: null }, content: JSON.stringify({ files }) });
        return { files, model: 'trusted-negative-test-no-network', usage: { inputTokens: null, outputTokens: null } };
      },
      reviewModel: () => async () => { reviewCalls++; assert.fail('Failed self-check must not request a Review'); },
    } };
  const service = await createWebExecutionService(options);
  let app = await createApp({ store, executionService: service, stepDelayMs: 0 });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => {
    await browser.close(); await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('web-execution-connected-'));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let url = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(url + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const { project } = await request('/api/projects', { filename: 'connection.md', name: '真实执行负例连接', content: source });
  let { run } = await request(`/api/projects/${project.id}/runs`, { mode: 'local' });
  const runPath = `/api/projects/${project.id}/runs/${run.id}`;
  async function waitRun(status) {
    const deadline = Date.now() + 10000;
    do { run = (await request(runPath)).run; if (run.status === status) return; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
    assert.fail(`Planning did not reach ${status}: ${run.status}`);
  }
  await waitRun('awaiting_spec');
  await request(`${runPath}/action`, { action: 'revise_spec', revision: run.specRevision, answers: Object.fromEntries(run.specQuestions.map(item => [item.id, '测试负责人先验证受控执行，业务依赖依照已生成计划；本轮无额外交付期限。'])) });
  run = (await request(runPath)).run;
  await request(`${runPath}/action`, { action: 'approve_spec', revision: run.specRevision }); await waitRun('awaiting_review');
  await request(`${runPath}/action`, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision }); await waitRun('succeeded');
  const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const start = page.getByRole('button', { name: '使用配置模型开始执行', exact: true });
  await page.getByRole('combobox', { name: '执行范围', exact: true }).waitFor();
  assert.equal(await start.isDisabled(), true);
  await page.locator('.execution-panel').getByRole('checkbox').check();
  await page.waitForFunction(() => !document.querySelector('.execution-panel .ep-primary').disabled);
  await start.click();
  await page.waitForFunction(() => document.querySelector('.execution-panel .ep-body').textContent.includes('执行失败'), undefined, { timeout: 60000 });
  const data = await request(`${runPath}/executions`), execution = data.executions[0];
  assert.equal(execution.status, 'failed'); assert.equal(execution.taskAccepted, false);
  assert.equal(execution.calls, 1); assert.equal(execution.reviewCalls, 0); assert.equal(execution.versions.length, 1);
  assert.equal(execution.versions[0].selfCheck.status, 'failed'); assert.equal(execution.versions[0].selfCheck.checks.length, 18);
  assert.ok(execution.versions[0].selfCheck.checks.some(item => item.passed === false));
  const failedLogin = execution.versions[0].selfCheck.checks.find(item => item.id === 'WEB-003');
  assert.equal(failedLogin.expected, 'HTTP 401'); assert.match(failedLogin.actual, /503/u);
  await page.locator('.execution-panel summary').filter({ hasText: '编码自检' }).click();
  const visibleFailure = page.locator('.execution-panel p.ep-muted').filter({ hasText: 'WEB-003' });
  assert.equal(await visibleFailure.isVisible(), true);
  assert.match(await visibleFailure.textContent(), /预期：HTTP 401/u); assert.match(await visibleFailure.textContent(), /实际：.*503/u);
  assert.equal(execution.actions.canDownload, false); assert.equal(execution.actions.canPreview, false);
  assert.equal(execution.usage.inputTokens, null); assert.equal(execution.usage.outputTokens, null);
  assert.equal(codeCalls, 1); assert.equal(reviewCalls, 0);
  assert.equal(await page.getByRole('link', { name: '下载已验收源码' }).isVisible(), false);
  assert.equal(await page.getByRole('link', { name: '打开本地预览' }).isVisible(), false);
  // Inspect actual DTO fields/text rather than JSON escape bytes (body:\" is
  // JavaScript source inside a diff, not a Windows drive path).
  const inspectDTO = value => {
    if (typeof value === 'string') { assert.ok(!value.includes('synthetic-test-only')); assert.doesNotMatch(value, /\b[A-Za-z]:[\\/]/u); }
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.ok(!['workspace', 'receiptPath', 'reportPath', 'controlDirectory', 'probeDirectory'].includes(key), key); inspectDTO(child);
    }
  };
  inspectDTO(data);
  const owned = path.join(serviceRoot, 'executions', execution.id), names = await readdir(owned);
  const report = JSON.parse(await readFile(path.join(owned, names.find(name => name.startsWith('web-execution-')), 'execution.json'), 'utf8'));
  assert.equal(report.status, 'failed'); assert.match(report.candidateCommit, /^[a-f0-9]{40}$/u);
  assert.ok(report.gitCommands.every(item => item.terminationConfirmed === true));
  assert.ok(report.versions[0].selfCheck.processes.length > 0);
  assert.ok(report.versions[0].selfCheck.processes.every(item => item.terminationConfirmed === true));
  await app.close();
  const reopened = await createWebExecutionService(options);
  app = await createApp({ store, executionService: reopened, stepDelayMs: 0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${app.server.address().port}`;
  const history = await request(`${runPath}/executions`);
  assert.equal(history.executions[0].id, execution.id); assert.equal(history.executions[0].status, 'failed');
  assert.equal(history.executions[0].taskAccepted, false); assert.equal(codeCalls, 1); assert.deepEqual(errors, []);
});
