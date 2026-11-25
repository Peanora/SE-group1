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

test('真实 Factory v1.0.5 和 Edge：规格交接、任务图、原生执行、Review 与 Git 集成', {
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
    "  plan: { objective: '任务编排夹具', tasks: [{ id: 'T1', title: '写入演示文件', objective: '只写入演示文件', dependencies: [], acceptanceCriteria: ['能读出演示内容'] }] },",
    "  work: { commands: [], tests: [] },",
    "  review: { decision: 'approve', reason: '已核对演示产物' },",
    "};",
    `const marker = ${JSON.stringify(firstReview)};`,
    "if (mode === 'work') writeFileSync('factory-demo.txt', existsSync(marker) ? 'factory fixture result\\n' : 'draft\\n');",
    "if (mode === 'review' && !existsSync(marker)) {",
    "  writeFileSync(marker, 'requested');",
    "  output.review = { decision: 'request_changes', reason: '请替换草稿内容', feedback: ['写入已确认的演示内容'] };",
    "}",
    "console.log(JSON.stringify(output[mode]));",
  ].join('\n'));

  app = await createApp({
    dataDir: path.join(directory, 'data'), teamEnabled: false, stepDelayMs: 0,
    planner: { ...simulationPlanner, getModelConfig: () => ({ configured: false }) },
  });
  const project = await app.store.create({ name: 'Factory 交接夹具', source: { filename: 'fixture.md', content: '演示规格和计划的交接。' } });
  const planning = await app.orchestrator.createRun(project.id, { mode: 'local' });
  await until(() => planning.status === 'awaiting_spec' && !app.orchestrator.state(planning).driving, '规格待确认');
  await app.orchestrator.action(project.id, planning.id, { action: 'approve_spec', revision: planning.specRevision });
  await until(() => planning.status === 'awaiting_review', 'Taskflow 计划待确认');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const base = origin + '/api/projects/' + project.id + '/factory';
  const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
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
  assert.equal(planned.tasks[0].title, '写入演示文件');
  const plannerInput = await readFile(receivedSpec, 'utf8');
  assert.ok(plannerInput.includes(planning.id) && plannerInput.includes(planning.specRevision));

  await page.frameLocator('#factory-dashboard-frame').getByText('Agent Graph', { exact: true }).first().waitFor();
  if (process.env.TASKFLOW_FACTORY_SCREENSHOT === '1') {
    const screenshots = path.join(root, 'output', 'factory-workbench');
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'dashboard.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.setViewportSize({ width: 1440, height: 960 });
  const terminalId = await page.frameLocator('#factory-dashboard-frame').locator('body').evaluate(async () => {
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
  await page.goto(new URL('/#/runs/' + handed.run.id, factory).href);
  await page.getByText('写入演示文件', { exact: true }).first().waitFor();

  assert.equal((await fetch(new URL(runURL + '/start', factory), { method: 'POST' })).status, 202);
  const complete = await until(async () => {
    const data = await request(runURL);
    if (data.run.status === 'failed' && data.attempts.length >= 3) throw new Error(JSON.stringify(data.attempts));
    return data.run.status === 'completed' && data;
  }, 'Factory 编码、审查并集成');
  assert.deepEqual(complete.attempts.map(attempt => attempt.status), ['changes_requested', 'approved']);
  assert.equal(complete.sessions.length, 5);
  const stream = await fetch(new URL('/api/sessions/' + complete.sessions[0].id + '/stream', factory), { signal: AbortSignal.timeout(5000) });
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  assert.match(await stream.text(), /event: session/);
  const workspace = path.join(directory, 'data', 'factory-workspaces', project.id);
  const integrated = await git('git', ['-C', workspace, 'show', 'factory/run-' + handed.run.id + ':factory-demo.txt']);
  assert.equal(integrated.stdout.trim(), 'factory fixture result');
  const defaultBranch = await git('git', ['-C', workspace, 'ls-tree', 'HEAD', 'factory-demo.txt']);
  assert.equal(defaultBranch.stdout, '');
  for (const api of ['/api/graph', '/api/roles', '/api/recipes', '/api/agents', '/api/performance/agents', '/api/mcp/servers', '/api/github/status']) await request(api);

  const stopped = await post(base + '/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).factory.state, 'stopped');
  await assert.rejects(fetch(new URL('/api/health', factory), { signal: AbortSignal.timeout(3000) }));
  const reopened = await post(base + '/start', { confirmedLocalExecution: true });
  assert.equal(reopened.status, 200);
  const nextFactory = (await reopened.json()).factory.url;
  assert.equal((await (await fetch(new URL(runURL, nextFactory))).json()).run.status, 'completed');
});
