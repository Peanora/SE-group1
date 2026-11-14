import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() >= end) throw new Error('等待规划停点超时'); await delay(5); } }
async function fixture(t) {
  const names = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'EXECUTION_SANDBOX_EXE'], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { LLM_BASE_URL: 'https://model.invalid/v1', LLM_MODEL: 'project-gate-no-api', LLM_API_KEY: 'synthetic-project-gate-only', EXECUTION_SANDBOX_EXE: path.resolve(os.tmpdir(), 'never-run-sandbox') });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planning-project-gate-')), app = await createApp({ dataDir: directory, stepDelayMs: 0 });
  t.after(async () => { await app.close(); for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('planning-project-gate-')); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '项目审批门禁', source: { filename: 'r.md', content: '# 资源\n\n## 功能\n用户可以查看资源。\n\n## 技术\n前端HTML，服务端Node.js，数据库SQLite。' } });
  async function prepare(fail = false) {
    const run = await app.orchestrator.createRun(project.id, { mode: 'local', ...(fail ? { failOnceStage: 'tasks' } : {}) });
    await waitFor(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving);
    if (run.specQuestions.length) await app.orchestrator.action(project.id, run.id, { action: 'revise_spec', revision: run.specRevision,
      answers: Object.fromEntries(run.specQuestions.map(item => [item.id, '由测试负责人按现有边界验收，无额外交付期限。'])) });
    await app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
    return run;
  }
  const settle = async (run, status) => waitFor(() => run.status === status && !app.orchestrator.state(run).driving && !app.orchestrator.state(run).active.size);
  return { app, directory, project, prepare, settle };
}

test('同项目旧运行不能把当前待决审批写盘，失败后磁盘和执行门禁均不批准', async t => {
  const { app, directory, project, prepare, settle } = await fixture(t);
  const old = await prepare(true); await settle(old, 'failed');
  const current = await prepare(); await settle(current, 'awaiting_review');
  const save = app.store.save.bind(app.store), entered = deferred(), release = deferred(); let held = false;
  app.store.save = async value => {
    if (!held && current.approvals.plan) { held = true; entered.resolve(); await release.promise; throw new Error('controlled publication failure'); }
    return save(value);
  };
  const approving = app.orchestrator.action(project.id, current.id, { action: 'approve_plan', revision: current.planRevision, specRevision: current.specRevision });
  void approving.catch(() => {});
  try {
    await entered.promise;
    const oldBefore = structuredClone(old), identity = { projectId: project.id, runId: current.id };
    await assert.rejects(app.orchestrator.action(project.id, old.id, { action: 'retry', stageId: 'tasks' }), { status: 409 });
    await assert.rejects(app.orchestrator.createRun(project.id), { status: 409 });
    assert.deepEqual(old, oldBefore);
    assert.equal((await app.executionService.list(identity)).capabilities.canStart, false);
    release.resolve(); await assert.rejects(approving, { code: 'persistence_failed' });
    assert.equal(current.approvals.plan, null);
    assert.equal(app.store.getPersistedRun(project.id, current.id).run.approvals.plan, null);
    assert.equal(JSON.parse(await readFile(path.join(directory, `${project.id}.json`), 'utf8')).runs.find(run => run.id === current.id).approvals.plan, null);
    assert.equal((await app.executionService.list(identity)).capabilities.canStart, false);
    await assert.rejects(app.orchestrator.action(project.id, old.id, { action: 'retry' }), { status: 409 });
    app.store.save = save;
    await app.orchestrator.action(project.id, current.id, { action: 'approve_plan', revision: current.planRevision, specRevision: current.specRevision });
    await settle(current, 'succeeded');
    await app.orchestrator.action(project.id, old.id, { action: 'retry', stageId: 'tasks' });
    await settle(old, 'awaiting_review');
    assert.equal(current.approvals.plan.revision, current.planRevision);
  } finally { release.resolve(); await approving.catch(() => {}); app.store.save = save; }
});

test('同一运行先等待审阅停点保存结束，才公开待决审批', async t => {
  const { app, project, prepare } = await fixture(t);
  const save = app.store.save.bind(app.store), entered = deferred(), release = deferred(); let held = false;
  app.store.save = async value => {
    const run = value.runs.at(-1);
    if (!held && run?.status === 'awaiting_review') { held = true; entered.resolve(); await release.promise; }
    if (run?.approvals.plan) throw new Error('controlled decision save failure');
    return save(value);
  };
  let approving;
  try {
    const run = await prepare(); await entered.promise;
    assert.equal(app.orchestrator.state(run).driving, true);
    approving = app.orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision });
    void approving.catch(() => {}); await delay(5);
    assert.equal(run.approvals.plan, null, '旧停点保存中不应变更共享项目里的审批');
    assert.equal((await app.executionService.list({ projectId: project.id, runId: run.id })).capabilities.canStart, false);
    release.resolve(); await assert.rejects(approving, { code: 'persistence_failed' });
    assert.equal(run.approvals.plan, null); assert.equal(app.store.getPersistedRun(project.id, run.id).run.approvals.plan, null);
  } finally { release.resolve(); await approving?.catch(() => {}); app.store.save = save; }
});
