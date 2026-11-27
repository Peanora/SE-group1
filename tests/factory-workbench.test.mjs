import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { simulationPlanner } from '../examples/simulation-fixture.mjs';
import { createFactoryHandoffStore } from '../lib/factory-handoff-store.mjs';

const prefix = 'taskflow-factory-http-';
const upstream = 'http://127.0.0.1:49451/';
const requirement = '操作员可以核对已登记的三条演示数据。';

async function fixture(t, teamEnabled = false) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, prefix));
  let app;
  t.after(async () => {
    try { await app?.close(); } finally {
      assert.equal(path.dirname(directory), parent);
      assert.ok(path.basename(directory).startsWith(prefix));
      await rm(directory, { recursive: true, force: true });
    }
  });

  const calls = [], active = new Set();
  const factoryWorkbench = {
    status: projectId => ({ available: true, state: active.has(projectId) ? 'running' : 'stopped',
      url: active.has(projectId) ? upstream : null, version: '1.0.5' }),
    hasActivity: projectId => active.has(projectId),
    async start(projectId, options) {
      calls.push({ action: 'start', projectId, options }); active.add(projectId);
      return this.status(projectId);
    },
    async stop(projectId) {
      calls.push({ action: 'stop', projectId }); active.delete(projectId);
      return this.status(projectId);
    },
    async plan(projectId, { objective, runId, specRevision }) {
      calls.push({ action: 'plan', projectId, objective, runId, specRevision });
      return { id: 17, status: 'planning' };
    },
    async close() { calls.push({ action: 'close' }); },
  };
  app = await createApp({ dataDir: directory, teamEnabled, stepDelayMs: 0, factoryWorkbench,
    planner: { ...simulationPlanner, getModelConfig: () => ({ configured: false }),
      analyzeWithModel: () => assert.fail('Factory HTTP 路由测试不得调用模型。') } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const project = await app.store.create({ name: 'Factory 路由测试', source: { filename: 'fixture.md', content: requirement } });
  const route = `/api/projects/${project.id}/factory`;
  async function request(target, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + target, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, headers: response.headers, data };
  }
  const post = (target, body, headers) => request(target, { method: 'POST', body, headers });
  async function createSpec() {
    const run = await app.orchestrator.createRun(project.id, { mode: 'local' });
    const deadline = Date.now() + 10_000;
    while (run.status !== 'awaiting_spec' || app.orchestrator.state(run).driving) {
      assert.ok(Date.now() < deadline, '本地规格未到达待确认状态。');
      await delay(10);
    }
    return run;
  }
  return { app, calls, factoryWorkbench, project, route, request, post, createSpec };
}

test('Factory 项目状态、显式本机启动同意、独立停止及应用回收', async t => {
  const f = await fixture(t);
  const { project, route } = f;
  const initial = await f.request(route);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, {
    project: { id: project.id, name: project.name },
    factory: { available: true, state: 'stopped', url: null, version: '1.0.5' },
    handoff: { available: false },
  });
  assert.equal((await f.request('/api/health')).data.factoryWorkbench.available, true);
  assert.equal((await f.request('/api/projects/missing/factory')).status, 404);

  for (const body of [{}, { confirmedLocalExecution: false }, { confirmedLocalExecution: true, repositoryPath: 17 },
    { confirmedLocalExecution: true, repositoryPath: './relative' }, { confirmedLocalExecution: true, command: 'ignored' }]) {
    assert.equal((await f.post(route + '/start', body)).status, 400);
  }
  assert.equal((await f.post(route + '/start', { confirmedLocalExecution: true }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.post(route + '/start', { confirmedLocalExecution: true }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.deepEqual(f.calls, []);

  const started = await f.post(route + '/start', { confirmedLocalExecution: true });
  assert.equal(started.status, 200);
  assert.equal(started.data.factory.url, upstream);
  assert.equal((await f.request(route)).data.factory.state, 'running');
  const deletion = await f.request('/api/projects/' + project.id, { method: 'DELETE', body: { confirmationName: project.name } });
  assert.equal(deletion.status, 409);
  assert.match(deletion.data.error, /先停止.*Factory/);
  assert.equal((await f.post(route + '/stop', { command: 'ignored' })).status, 400);
  const stopped = await f.post(route + '/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.factory.state, 'stopped');
  await f.app.close();
  assert.deepEqual(f.calls, [
    { action: 'start', projectId: project.id, options: { repositoryPath: undefined } },
    { action: 'stop', projectId: project.id }, { action: 'close' },
  ]);
});

test('Factory 只接收已确认的当前规格版本并保留所属运行', async t => {
  const f = await fixture(t);
  const run = await f.createSpec();
  const exact = { runId: run.id, specRevision: run.specRevision, modelUsageConfirmed: true };
  const view = f.route + '?run=' + encodeURIComponent(run.id);
  assert.equal((await f.request(view)).data.handoff.available, false);
  assert.equal((await f.post(f.route + '/plan', exact)).status, 409);
  await f.app.orchestrator.action(f.project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
  const approved = await f.request(view);
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.data.handoff, {
    available: true, runId: run.id, specRevision: run.specRevision, title: run.spec.title,
  });

  assert.equal((await f.post(f.route + '/plan', { ...exact, modelUsageConfirmed: false })).status, 400);
  assert.equal((await f.post(f.route + '/plan', { ...exact, specRevision: 'a'.repeat(64) })).status, 409);
  assert.equal((await f.post(f.route + '/plan', { ...exact, objective: '未经确认的输入' })).status, 400);
  assert.equal((await f.post(f.route + '/plan', { ...exact, runId: 'missing' })).status, 404);
  const another = await f.app.store.create({ name: '独立项目', source: { filename: 'other.md', content: '独立项目。' } });
  assert.equal((await f.post(`/api/projects/${another.id}/factory/plan`, exact)).status, 404);
  assert.deepEqual(f.calls, []);

  const handed = await f.post(f.route + '/plan', exact);
  assert.equal(handed.status, 202);
  assert.deepEqual(handed.data, { run: { id: 17, status: 'planning' }, handoff: approved.data.handoff });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].projectId, f.project.id);
  assert.equal(f.calls[0].action, 'plan');
  assert.equal(f.calls[0].runId, run.id);
  assert.equal(f.calls[0].specRevision, run.specRevision);
  for (const value of [run.id, run.specRevision, requirement]) assert.ok(f.calls[0].objective.includes(value), value);

  f.factoryWorkbench.result = async () => { throw new Error('private receipt storage failure'); };
  const degraded = await f.request(view);
  assert.equal(degraded.status, 200);
  assert.match(degraded.data.resultError, /原生 Runs/u);
  assert.equal(degraded.data.factory.available, true);
  assert.equal(degraded.data.handoff.specRevision, run.specRevision);
  delete f.factoryWorkbench.result;

  run.sourceSuperseded = true;
  assert.equal((await f.request(view)).data.handoff.available, false);
  assert.equal((await f.post(f.route + '/plan', exact)).status, 409);
  assert.equal(f.calls.length, 1);
});

test('Factory 原生页面使用独立顶层导航，团队负责人同样不能启动原生服务', async t => {
  const local = await fixture(t);
  const framePolicy = /(?:^|;)\s*frame-src http:\/\/127\.0\.0\.1:\*/u;
  const shell = await local.request('/factory.html');
  assert.equal(shell.status, 200);
  assert.doesNotMatch(shell.headers.get('content-security-policy'), framePolicy);
  assert.doesNotMatch((await local.request('/')).headers.get('content-security-policy'), framePolicy);

  const team = await fixture(t, true);
  assert.equal((await team.request('/api/health')).data.factoryWorkbench.available, false);
  assert.equal((await team.request(team.route)).status, 401);
  const owner = await team.post('/api/team/setup', { name: 'factory-owner', password: 'Factory-test-account-password-2026' });
  assert.equal(owner.status, 201);
  const headers = { Cookie: owner.headers.get('set-cookie').split(';')[0] };
  assert.equal((await team.request(team.route, { headers })).status, 403);
  assert.equal((await team.post(team.route + '/start', { confirmedLocalExecution: true }, headers)).status, 403);
  assert.equal((await team.post(team.route + '/stop', {}, headers)).status, 403);
  assert.equal((await team.post(team.route + '/plan', {}, headers)).status, 403);
  const teamShell = await team.request('/factory.html');
  assert.equal(teamShell.status, 200);
  assert.doesNotMatch(teamShell.headers.get('content-security-policy'), framePolicy);
  assert.deepEqual(team.calls, []);
});

test('Factory 交接在提交前占位，未知回执可重开核对，运行与仓库切换保留各自归属', async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), prefix));
  t.after(async () => {
    assert.equal(path.dirname(directory), await realpath(tmpdir()));
    assert.ok(path.basename(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const store = createFactoryHandoffStore(directory);
  const binding = { id: 'intent-1', projectId: 'project-1', runId: 'planning-1', specRevision: 'a'.repeat(64),
    workspaceKey: 'b'.repeat(64), objectiveHash: 'c'.repeat(64), submittedAt: '2026-11-27T04:30:00Z' };
  assert.equal(await store.latest(binding.projectId, binding.runId), null);
  await store.reserve(binding);
  await store.unknown(binding.id);
  const reopened = createFactoryHandoffStore(directory);
  assert.equal((await reopened.latest(binding.projectId, binding.runId)).state, 'unknown');
  await assert.rejects(reopened.reserve({ ...binding, id: 'duplicate' }), { status: 409 });
  await reopened.link(binding.id, 7, binding.submittedAt);
  await store.unknown(binding.id);
  assert.equal((await store.latest(binding.projectId, binding.runId)).native_id, 7);
  await reopened.reserve({ ...binding, id: 'repo-2-intent', workspaceKey: 'd'.repeat(64) });
  await reopened.link('repo-2-intent', 7, binding.submittedAt);
  assert.equal((await reopened.latest(binding.projectId, binding.runId, binding.workspaceKey)).id, binding.id);
  assert.equal((await reopened.latest(binding.projectId, binding.runId, 'd'.repeat(64))).id, 'repo-2-intent');
  assert.equal(await reopened.latest('other-project', binding.runId), null);
  assert.equal(await reopened.latest(binding.projectId, 'other-run'), null);
});
