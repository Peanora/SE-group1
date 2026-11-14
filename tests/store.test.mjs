import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { ProjectStore } from '../lib/store.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() >= end) throw new Error('等待状态超时'); await delay(5); } }

test('default execution admission cannot use a planning approval before it is durably saved', async t => {
  const names = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'EXECUTION_SANDBOX_EXE'], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { LLM_BASE_URL: 'https://model.invalid/v1', LLM_MODEL: 'durable-admission-no-model-call', LLM_API_KEY: 'synthetic-admission-only', EXECUTION_SANDBOX_EXE: path.resolve(os.tmpdir(), 'not-executed-sandbox') });
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  for (const fails of [false, true]) await t.test(fails ? 'failed approval remains unavailable' : 'committed approval becomes available', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'durable-approval-'));
    const app = await createApp({ dataDir: directory, stepDelayMs: 0 });
    t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('durable-approval-')); await rm(directory, { recursive: true, force: true }); });
    const project = await app.store.create({ name: '落盘门禁', source: { filename: 'requirements.md', content: '# 需求\n\n## 功能\n用户可以查看资源。\n\n## 技术\n前端HTML，服务端Node.js，数据库SQLite。' } });
    const run = await app.orchestrator.createRun(project.id);
    await waitFor(() => run.status === 'awaiting_spec');
    if (run.specQuestions.length) await app.orchestrator.action(project.id, run.id, { action: 'revise_spec', revision: run.specRevision,
      answers: Object.fromEntries(run.specQuestions.map(item => [item.id, '由测试负责人按现有技术边界验收，无额外交付期限。'])) });
    await app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
    await waitFor(() => run.status === 'awaiting_review' && !app.orchestrator.state(run).driving);
    const save = app.store.save.bind(app.store), entered = deferred(), release = deferred(); let held = false;
    app.store.save = async value => {
      if (!held && run.approvals.plan) { held = true; entered.resolve(); await release.promise; if (fails) throw new Error('synthetic persistence failure'); }
      return save(value);
    };
    const approving = app.orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision });
    void approving.catch(() => {});
    try {
      await entered.promise;
      assert.ok(run.approvals.plan, '内存中的在途审批用于复现，尚未持久化');
      const identity = { projectId: project.id, runId: run.id };
      assert.equal((await app.executionService.list(identity)).capabilities.canStart, false, '落盘前不能作为可信执行输入');
      release.resolve();
      if (fails) await assert.rejects(approving, { code: 'persistence_failed' }); else { await approving; await waitFor(() => run.status === 'succeeded'); }
      assert.equal((await app.executionService.list(identity)).capabilities.canStart, !fails);
      const disk = JSON.parse(await readFile(path.join(directory, `${project.id}.json`), 'utf8')).runs.find(item => item.id === run.id);
      assert.equal(!!disk.approvals.plan, !fails);
    } finally { release.resolve(); await approving.catch(() => {}); app.store.save = save; }
  });
});

test('persisted planning reads are isolated from live and returned references and survive restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'durable-store-')), store = await new ProjectStore(directory).init();
  t.after(async () => { await store.flush(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('durable-store-')); await rm(directory, { recursive: true, force: true }); });
  const project = await store.create({ name: '保存读取', source: { filename: 'r.md', content: 'original' } });
  project.runs.push({ id: 'run1', approvals: { plan: null } }); await store.save(project);
  project.runs[0].approvals.plan = { revision: 'not-committed' };
  assert.equal(store.getPersistedRun(project.id, 'run1').run.approvals.plan, null);
  const returned = store.getPersistedRun(project.id, 'run1'); returned.project.name = 'external'; returned.run.approvals.plan = { revision: 'external' };
  assert.equal(store.getPersistedRun(project.id, 'run1').project.name, '保存读取');
  assert.equal(store.getPersistedRun(project.id, 'run1').run.approvals.plan, null);
  await store.save(project);
  assert.equal(store.getPersistedRun(project.id, 'run1').run.approvals.plan.revision, 'not-committed');
  const restored = await new ProjectStore(directory).init();
  assert.deepEqual(restored.getPersistedRun(project.id, 'run1'), store.getPersistedRun(project.id, 'run1'));
  const hold = deferred(); store.queues.set(project.id, hold.promise);
  project.name = 'queued snapshot'; const pending = store.save(project); project.name = 'later live mutation';
  assert.equal(store.getPersistedRun(project.id, 'run1').project.name, '保存读取');
  hold.resolve(); await pending;
  assert.equal(store.getPersistedRun(project.id, 'run1').project.name, 'queued snapshot');
  assert.equal(JSON.parse(await readFile(path.join(directory, `${project.id}.json`), 'utf8')).name, 'queued snapshot');
});
