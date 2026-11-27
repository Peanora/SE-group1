import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import { factoryBinaryPath } from '../lib/factory-release.mjs';
import { simulationPlanner } from '../examples/simulation-fixture.mjs';

const git = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = factoryBinaryPath(root);
const available = await access(binary).then(() => true, () => false);

async function until(check, label) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error('等待超时：' + label);
    await delay(80);
  }
}

async function openNativeLink(page, selector, url) {
  const link = page.locator(selector);
  await link.waitFor();
  assert.equal(await link.getAttribute('href'), url);
  await page.bringToFront();
  const [native] = await Promise.all([page.context().waitForEvent('page', { timeout: 8_000 }), link.click()]);
  native.setDefaultTimeout(8_000);
  await native.waitForURL(url);
  return native;
}

test('真实 Factory v1.0.5 和 Edge：规格交接、原生图与角色、DAG 执行、Review 和 Git 集成', {
  skip: available ? false : '先运行 npm run factory:install 安装固定版本', timeout: 75_000,
}, async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'taskflow-factory-runtime-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    assert.equal(path.dirname(directory), await realpath(tmpdir()));
    assert.ok(path.basename(directory).startsWith('taskflow-factory-runtime-'));
    await rm(directory, { recursive: true, force: true });
  });
  const script = path.join(directory, 'fixture.mjs');
  const receivedSpec = path.join(directory, 'planner-input.txt');
  const firstReview = path.join(directory, 'changes-requested');
  const terminal = path.join(directory, 'terminal.mjs');
  await writeFile(terminal, [
    "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    "console.log('factory-terminal-ready');",
    "process.stdin.once('data', () => console.log('factory-terminal-fixture'));",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  await writeFile(script, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const mode = process.argv[2];",
    "const prompt = readFileSync(0, 'utf8');",
    `if (mode === 'plan') writeFileSync(${JSON.stringify(receivedSpec)}, prompt);`,
    "const output = {",
    "  plan: { objective: '任务编排夹具', tasks: [",
    "    { id: 'T1', title: '写入演示文件', objective: '只写入演示文件', dependencies: [], acceptanceCriteria: ['能读出演示内容'] },",
    "    { id: 'T2', title: '生成后继文件', objective: '读取已集成的演示文件', dependencies: ['T1'], acceptanceCriteria: ['后继内容包含前置已验收结果'] },",
    "  ] },",
    "  work: { commands: [], tests: [] },",
    "  review: { decision: 'approve', reason: '已核对演示产物' },",
    "};",
    `const marker = ${JSON.stringify(firstReview)};`,
    "if (mode === 'work' && prompt.includes('\\nTASK\\n生成后继文件')) {",
    "  const previous = readFileSync('factory-demo.txt', 'utf8').trim();",
    "  if (previous !== 'factory fixture result') throw new Error('后继任务没有收到已集成的前置候选');",
    "  writeFileSync('factory-followup.txt', `verified: ${previous}\\n`);",
    "} else if (mode === 'work') writeFileSync('factory-demo.txt', existsSync(marker) ? 'factory fixture result\\n' : 'draft\\n');",
    "if (mode === 'review') {",
    "  const followup = prompt.includes('\\nTASK\\n生成后继文件');",
    "  const file = followup ? 'factory-followup.txt' : 'factory-demo.txt';",
    "  const expected = followup ? 'verified: factory fixture result' : existsSync(marker) ? 'factory fixture result' : 'draft';",
    "  if (!prompt.includes(file) || readFileSync(file, 'utf8').trim() !== expected) {",
    "    throw new Error('Reviewer 没有收到本轮工作树和文件证据');",
    "  }",
    "}",
    "if (mode === 'review' && !existsSync(marker)) {",
    "  writeFileSync(marker, 'requested');",
    "  output.review = { decision: 'request_changes', reason: '请替换草稿内容', feedback: ['写入已确认的演示内容'] };",
    "}",
    "console.log(JSON.stringify(output[mode]));",
  ].join('\n'));

  const applicationOptions = {
    dataDir: path.join(directory, 'data'), teamEnabled: false, stepDelayMs: 0,
    planner: { ...simulationPlanner, getModelConfig: () => ({ configured: false }) },
  };
  app = await createApp(applicationOptions);
  const project = await app.store.create({ name: 'Factory 交接夹具', source: { filename: 'fixture.md', content: '演示规格和计划的交接。' } });
  const planning = await app.orchestrator.createRun(project.id, { mode: 'local' });
  await until(() => planning.status === 'awaiting_spec' && !app.orchestrator.state(planning).driving, '规格待确认');
  await app.orchestrator.action(project.id, planning.id, { action: 'approve_spec', revision: planning.specRevision });
  await until(() => planning.status === 'awaiting_review', 'Taskflow 计划待确认');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const factoryPath = '/api/projects/' + project.id + '/factory';
  let base = origin + factoryPath;
  const taskflowResult = async () => {
    const response = await fetch(`${base}?${new URLSearchParams({ run: planning.id })}`);
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(8_000);
  await page.goto(origin);
  await page.getByRole('link', { name: 'Factory 全流程' }).click();
  await page.waitForURL('**/factory.html?*');
  await page.getByText(project.name, { exact: true }).waitFor();
  const starting = page.waitForResponse(response => response.url() === base + '/start' && response.request().method() === 'POST');
  await page.locator('#factory-execution-confirmation').check();
  await page.getByRole('button', { name: '启动本地 Factory', exact: true }).click();
  const start = await starting;
  const result = await start.json();
  assert.equal(start.status(), 200, JSON.stringify(result));
  const factory = result.factory.url;
  const request = async (uri) => {
    const response = await fetch(new URL(uri, factory));
    assert.equal(response.status, 200, uri);
    return response.json();
  };
  const config = await request('/api/config');
  const assignments = { planner: 'plan', worker: 'work', reviewer: 'review' };
  config.agents = Object.fromEntries(Object.values(assignments).map(mode => [mode, {
    kind: 'custom', command: process.execPath, args: [script, mode], prompt_transport: 'stdin',
  }]));
  config.agents.console = {
    kind: 'custom', command: process.execPath, args: [],
    interactive_args: [terminal], prompt_transport: 'disabled',
  };
  config.role_assignments = Object.entries(assignments).map(([role, agent]) => ({ role, agent, preferred: true }));
  assert.equal((await post(new URL('/api/config', factory), config, 'PUT')).status, 204);

  assert.deepEqual(page.frames(), [page.mainFrame()], 'Taskflow 页面没有嵌入 Factory 页面');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.setViewportSize({ width: 1440, height: 960 });
  const graph = await openNativeLink(page, '#factory-open-graph', new URL('/#/network', factory).href);
  await graph.getByText('Agent Graph', { exact: true }).first().waitFor();
  await graph.getByRole('button', { name: 'Add graph node', exact: true }).click();
  const addNode = graph.getByRole('dialog', { name: 'Add graph node', exact: true });
  await addNode.getByRole('button', { name: /^Role Core assignment/u }).click();
  await addNode.getByRole('button', { name: /^Custom role/u }).click();
  const roleName = 'Fixture Advisor';
  await addNode.getByLabel('Name', { exact: true }).fill(roleName);
  await addNode.getByLabel('Description', { exact: true }).fill('Local fixture reviewer for documentation.');
  await addNode.getByRole('combobox', { name: 'Execution class', exact: true }).selectOption('advisory');
  await addNode.getByRole('combobox', { name: /^Policy preset/u }).selectOption('read_only');
  await addNode.getByRole('checkbox', { name: 'review', exact: true }).check();
  await addNode.getByRole('button', { name: 'Create role', exact: true }).click();
  await addNode.waitFor({ state: 'hidden' });
  const settings = await openNativeLink(page, '#factory-open-settings', new URL('/#/settings', factory).href);
  await settings.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await settings.getByRole('button', { name: `Edit ${roleName} role`, exact: true }).click();
  const roleInstructions = 'Verify only the supplied documentation scope.';
  await settings.locator('form.role-form').getByLabel('Instructions', { exact: true }).fill(roleInstructions);
  const savingRole = settings.waitForResponse(response => response.url() === new URL('/api/roles/fixture_advisor', factory).href && response.request().method() === 'PUT');
  await settings.getByRole('button', { name: 'Save role', exact: true }).click();
  assert.equal((await savingRole).status(), 200);
  await settings.locator('form.role-form').waitFor({ state: 'hidden' });
  const role = (await request('/api/roles')).find(item => item.id === 'fixture_advisor');
  assert.equal(role.kind, 'custom');
  assert.equal(role.executionClass, 'advisory');
  assert.equal(role.instructions, roleInstructions);
  assert.deepEqual(role.assignments, [{ agent: 'review', preferred: true }]);

  const handingOff = page.waitForResponse(response => response.url() === base + '/plan' && response.request().method() === 'POST');
  await page.locator('#factory-planning-confirmation').check();
  await page.getByRole('button', { name: '交给 Factory 规划', exact: true }).click();
  const handoff = await handingOff;
  const handed = await handoff.json();
  assert.equal(handoff.status(), 202, JSON.stringify(handed));
  assert.equal(handed.handoff.specRevision, planning.specRevision);
  const runURL = '/api/runs/' + handed.run.id;
  const planned = await until(async () => {
    const data = await request(runURL);
    assert.notEqual(data.run.status, 'failed', JSON.stringify(data.sessions));
    return data.run.status === 'planned' && data;
  }, 'Factory 已生成任务');
  assert.deepEqual(planned.tasks.map(task => task.title), ['写入演示文件', '生成后继文件']);
  assert.deepEqual(planned.tasks[0].dependencies, []);
  assert.deepEqual(planned.tasks[1].dependencies, [planned.tasks[0].id]);
  const plannerInput = await readFile(receivedSpec, 'utf8');
  assert.ok(plannerInput.includes(planning.id) && plannerInput.includes(planning.specRevision));
  const details = await openNativeLink(page, '#factory-created-run', new URL('/#/runs/' + handed.run.id, factory).href);
  await details.getByRole('heading', { name: 'Task graph', exact: true }).waitFor();
  const followup = details.getByRole('row').filter({ hasText: '生成后继文件' });
  assert.equal(await followup.getByRole('cell').last().innerText(), `#${planned.tasks[0].id}`);

  await graph.reload();
  const workflow = graph.getByLabel(/workflow, planned$/u);
  await workflow.waitFor();
  const screenshots = process.env.TASKFLOW_FACTORY_SCREENSHOT === '1' ? path.join(root, 'output', 'factory-workbench') : null;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await graph.screenshot({ path: path.join(screenshots, 'dashboard.png'), fullPage: true });
    await details.screenshot({ path: path.join(screenshots, 'native-plan.png'), fullPage: true });
  }
  const terminalId = await graph.evaluate(async () => {
    const response = await fetch('/api/agents/console/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    if (!response.ok) throw new Error('Factory terminal HTTP ' + response.status);
    const session = await response.json();
    const socket = new WebSocket('ws://' + location.host + '/api/sessions/' + session.id + '/terminal');
    socket.binaryType = 'arraybuffer';
    try {
      await new Promise((resolve, reject) => {
        let output = '', sent = false, cursorReported = false;
        const timeout = setTimeout(() => reject(new Error('终端没有返回夹具输出 ' + JSON.stringify(output.slice(0, 200)))), 8000);
        socket.onmessage = ({ data }) => {
          output += typeof data === 'string' ? data : new TextDecoder().decode(data);
          // Windows ConPTY requests the initial cursor position, which xterm normally answers.
          if (!cursorReported && output.includes('\x1b[6n')) {
            cursorReported = true;
            socket.send(JSON.stringify({ type: 'input', data: '\x1b[1;1R' }));
          }
          if (!sent && output.includes('factory-terminal-ready')) {
            sent = true;
            socket.send(JSON.stringify({ type: 'input', data: 'test' }));
          }
          if (output.includes('factory-terminal-fixture')) { clearTimeout(timeout); resolve(); }
        };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error('Factory terminal WebSocket failed')); };
      });
      return session.id;
    } finally {
      socket.close();
      await fetch('/api/sessions/' + session.id, { method: 'DELETE' });
    }
  });
  assert.ok(terminalId > 0);

  const startRequest = { runId: planning.id, specRevision: planning.specRevision, nativeRunId: handed.run.id, confirmedLocalExecution: true };
  assert.equal((await post(base + '/start-workflow', { ...startRequest, nativeRunId: handed.run.id + 1 })).status, 409);
  assert.equal((await post(base + '/start-workflow', { ...startRequest, confirmedLocalExecution: false })).status, 400);
  await page.locator('#factory-refresh').click();
  const startWorkflow = page.getByRole('button', { name: '启动此 Factory 运行', exact: true });
  await startWorkflow.waitFor();
  page.once('dialog', dialog => dialog.accept());
  const started = page.waitForResponse(response => response.url() === base + '/start-workflow' && response.request().method() === 'POST');
  await startWorkflow.click();
  const startedRun = await started;
  assert.equal(startedRun.status(), 202, await startedRun.text());
  const complete = await until(async () => {
    const data = await request(runURL);
    if (data.run.status === 'failed' && data.attempts.length >= 3) throw new Error(JSON.stringify(data.attempts));
    return data.run.status === 'completed' && data;
  }, 'Factory 编码、审查并集成');
  assert.deepEqual(complete.attempts.map(attempt => [attempt.taskId, attempt.status]), [
    [planned.tasks[0].id, 'changes_requested'], [planned.tasks[0].id, 'approved'], [planned.tasks[1].id, 'approved'],
  ]);
  assert.equal(complete.sessions.length, 7);
  const stream = await fetch(new URL('/api/sessions/' + complete.sessions[0].id + '/stream', factory), { signal: AbortSignal.timeout(5000) });
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  assert.match(await stream.text(), /event: session/);
  const workspace = path.join(directory, 'data', 'factory-workspaces', project.id);
  const integrated = await git('git', ['-C', workspace, 'show', 'factory/run-' + handed.run.id + ':factory-demo.txt']);
  assert.equal(integrated.stdout.trim(), 'factory fixture result');
  const integratedFollowup = await git('git', ['-C', workspace, 'show', 'factory/run-' + handed.run.id + ':factory-followup.txt']);
  assert.equal(integratedFollowup.stdout.trim(), 'verified: factory fixture result');
  assert.deepEqual(complete.integration.integratedTasks, planned.tasks.map(task => task.id));
  const gitHead = (await git('git', ['-C', workspace, 'rev-parse', complete.integration.branch])).stdout.trim();
  assert.equal(gitHead, complete.integration.head);
  const defaultBranch = await git('git', ['-C', workspace, 'ls-tree', 'HEAD', 'factory-demo.txt', 'factory-followup.txt']);
  assert.equal(defaultBranch.stdout, '');
  for (const api of ['/api/graph', '/api/roles', '/api/recipes', '/api/agents', '/api/performance/agents', '/api/mcp/servers', '/api/github/status']) await request(api);

  const resultSummary = await taskflowResult();
  assert.equal(resultSummary.available, true);
  assert.equal(resultSummary.nativeStatus, 'completed');
  assert.equal(resultSummary.nativeRunId, handed.run.id);
  assert.equal(resultSummary.specRevision, planning.specRevision);
  assert.deepEqual(resultSummary.integration, { branch: complete.integration.branch, head: gitHead, integratedTaskCount: 2 });
  assert.equal((await post(base + '/start-workflow', startRequest)).status, 409);
  if (screenshots) {
    await details.reload();
    await details.getByText(/100% complete/u).waitFor();
    await details.screenshot({ path: path.join(screenshots, 'native-run.png'), fullPage: true });
  }
  await page.reload();
  const resultCard = page.getByRole('region', { name: '规格交接记录', exact: true });
  await resultCard.getByText(gitHead, { exact: true }).waitFor();
  assert.ok(await resultCard.getByText('completed', { exact: true }).isVisible());
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'handoff.png'), fullPage: true });
  const stopped = await post(base + '/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).factory.state, 'stopped');
  await assert.rejects(fetch(new URL('/api/health', factory), { signal: AbortSignal.timeout(3000) }));
  const stoppedSummary = await taskflowResult();
  assert.equal(stoppedSummary.available, false);
  assert.equal(stoppedSummary.nativeRunId, resultSummary.nativeRunId);
  assert.equal(stoppedSummary.integration, null);
  await app.close();
  app = await createApp(applicationOptions);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}${factoryPath}`;
  assert.deepEqual(await taskflowResult(), stoppedSummary);
  const reopened = await post(base + '/start', { confirmedLocalExecution: true });
  assert.equal(reopened.status, 200);
  const nextFactory = (await reopened.json()).factory.url;
  const history = await (await fetch(new URL(runURL, nextFactory))).json();
  assert.equal(history.run.status, 'completed');
  assert.deepEqual(history.attempts, complete.attempts);
  assert.deepEqual(history.integration, complete.integration);
  const savedRole = (await (await fetch(new URL('/api/roles', nextFactory))).json()).find(item => item.id === role.id);
  assert.deepEqual(savedRole, role);
  assert.deepEqual(await taskflowResult(), resultSummary);
  if (screenshots) await writeFile(path.join(screenshots, 'run-evidence.json'), JSON.stringify({
    factoryVersion: result.factory.version,
    handoff: resultSummary,
    stopped: stoppedSummary,
    afterRestart: await taskflowResult(),
    tasks: history.tasks.map(({ id, title, dependencies, state }) => ({ id, title, dependencies, state })),
    attempts: history.attempts.map(({ taskId, attemptNumber, status, role, commitSha }) => ({ taskId, attemptNumber, status, role, commitSha })),
  }, null, 2) + '\n');
});
