import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { ProjectStore } from '../lib/store.mjs';
import { SimulatedTaskService } from '../lib/simulated-tasks.mjs';
import { planningRevision } from '../lib/planning-review.mjs';
import { simulationPlanner } from '../examples/simulation-fixture.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';
import { randomUUID } from 'node:crypto';

async function until(predicate) { for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(5); } assert.fail('等待模拟状态超时'); }
class ControlledExecutor {
  constructor() { this.calls = []; }
  execute(context) {
    return new Promise((resolve, reject) => {
      const call = { ...context, resolve }; this.calls.push(call);
      context.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
    });
  }
  async finish(id, outcome = 'completed') {
    await until(() => this.calls.some(call => call.task.id === id && !call.done));
    const call = this.calls.find(call => call.task.id === id && !call.done); call.done = true;
    call.resolve({ outcome, summary: `模拟${outcome}` });
  }
}
async function setup(t, executor = new ControlledExecutor()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-simulation-'));
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: simulationPlanner,
    executionService: null, sourceChangeService: null, simulatedExecutor: executor });
  app.additionalShutdown = [];
  t.after(async () => { for (const service of app.additionalShutdown) await service.shutdown(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '模拟验收', source: { filename: 'demo.md', content: 'A完成后B和C并行，D等待人工确认后E启动。' } });
  const plan = await app.orchestrator.createRun(project.id, {});
  await until(() => plan.status === 'awaiting_spec');
  await app.orchestrator.action(project.id, plan.id, { action: 'approve_spec', revision: plan.specRevision });
  await until(() => plan.status === 'awaiting_review' && !app.orchestrator.state(plan).driving && app.orchestrator.state(plan).active.size === 0);
  const approve = async () => {
    await app.orchestrator.action(project.id, plan.id, { action: 'approve_plan', revision: plan.planRevision, specRevision: plan.specRevision, feedback: '人工确认模拟用例计划' });
    await until(() => plan.status === 'succeeded' && !app.orchestrator.state(plan).driving && app.orchestrator.state(plan).active.size === 0); await app.store.flush();
  };
  const start = options => app.simulationService.start(project.id, plan.id, { planRevision: plan.planRevision, ...options });
  const current = id => app.simulationService.list(project.id, plan.id).find(run => run.id === id);
  const action = (id, input) => app.simulationService.action(project.id, plan.id, id, input);
  return { app, project, plan, executor, directory, approve, start, current, action };
}
const task = (run, id) => run.tasks.find(task => task.id === id);

test('双确认后真实计划DAG：A→并行B/C→D人工确认→E；持久化和模拟门禁', async t => {
  const f = await setup(t);
  await assert.rejects(f.start(), /确认/);
  await f.approve(); const run = await f.start();
  await until(() => f.executor.calls.length === 1); assert.equal(f.executor.calls[0].task.id, 'A');
  await f.executor.finish('A'); await until(() => f.executor.calls.length === 3);
  assert.deepEqual(f.executor.calls.slice(1).map(call => call.task.id).sort(), ['B', 'C']);
  await f.executor.finish('B'); await until(() => task(f.current(run.id), 'B').status === 'completed');
  assert.equal(f.executor.calls.length, 3);
  await f.executor.finish('C'); await until(() => f.executor.calls.length === 4);
  await f.executor.finish('D'); await until(() => task(f.current(run.id), 'D').status === 'awaiting_confirmation');
  assert.equal(task(f.current(run.id), 'E').attempts.length, 0);
  await assert.rejects(f.action(run.id, { action: 'complete', taskId: 'D' }), /不支持/);
  await assert.rejects(f.action(run.id, { action: 'confirm', taskId: 'D', attempt: 0, reason: '过期' }), /当前/);
  await assert.rejects(f.action(run.id, { action: 'confirm', taskId: 'D', attempt: 1, reason: '' }), /依据/);
  const reload = await new ProjectStore(f.directory).init();
  assert.equal(task(reload.get(f.project.id).simulations[0], 'D').status, 'awaiting_confirmation');
  await f.action(run.id, { action: 'confirm', taskId: 'D', attempt: 1, reason: '已核对模拟记录和依赖，允许模拟后续任务' });
  await f.executor.finish('E'); await until(() => f.current(run.id).status === 'completed');
  const complete = f.current(run.id);
  assert.equal(complete.realAcceptance, false); assert.match(complete.notice, /不代表真实编码/);
  assert.match(task(complete, 'D').attempts[0].confirmation.reason, /核对/);
  assert.ok(complete.tasks.every(task => task.history.length >= 3));
  assert.deepEqual(f.plan.tasks, simulationPlanner.generateTasks());
});

test('B失败时C继续、D阻塞；重试仅重跑B并保留失败；暂停和继续守住派发边界', async t => {
  const f = await setup(t); await f.approve(); const run = await f.start();
  await f.executor.finish('A'); await until(() => f.executor.calls.length === 3);
  await f.executor.finish('B', 'failed'); await f.executor.finish('C');
  await until(() => f.current(run.id).status === 'failed');
  assert.equal(task(f.current(run.id), 'D').status, 'blocked');
  await assert.rejects(f.action(run.id, { action: 'confirm', taskId: 'B', attempt: 1, reason: '绕过失败' }), /只能确认/);
  await assert.rejects(f.action(run.id, { action: 'confirm', taskId: 'D', attempt: 0, reason: '绕过阻塞' }), /只能确认/);
  await f.action(run.id, { action: 'retry', taskId: 'B' });
  await until(() => f.executor.calls.length === 4);
  await f.action(run.id, { action: 'pause' }); await f.executor.finish('B');
  await until(() => task(f.current(run.id), 'B').status === 'completed');
  assert.equal(f.current(run.id).status, 'paused'); assert.equal(task(f.current(run.id), 'D').attempts.length, 0);
  assert.equal(f.executor.calls.filter(call => ['A', 'C'].includes(call.task.id)).length, 2);
  await assert.rejects(f.app.orchestrator.action(f.project.id, f.plan.id, { action: 'revise_spec' }), /活动模拟/);
  await assert.rejects(f.app.orchestrator.withProjectCheckpoint(f.project.id, () => {}), /活动模拟/);
  await assert.rejects(f.start(), /活动模拟/);
  await f.action(run.id, { action: 'resume' }); await until(() => f.executor.calls.length === 5);
  assert.equal(f.executor.calls.at(-1).task.id, 'D');
  assert.deepEqual(task(f.current(run.id), 'B').attempts.map(attempt => attempt.status), ['failed', 'completed']);
});

test('非法依赖、共享写入、大小写路径冲突明确拒绝；串行共享文件允许', async t => {
  const f = await setup(t); await f.approve();
  const original = structuredClone(f.plan.tasks);
  const change = async mutate => {
    f.plan.tasks = structuredClone(original); mutate(f.plan.tasks);
    f.plan.planRevision = planningRevision(f.plan); f.plan.approvals.plan.revision = f.plan.planRevision; await f.app.store.save(f.project);
  };
  await change(tasks => { tasks[1].dependsOn = ['UNKNOWN']; }); await assert.rejects(f.start(), /未知依赖/);
  await change(tasks => { tasks[0].dependsOn = ['E']; }); await assert.rejects(f.start(), /循环/);
  await change(tasks => { tasks[1].suggestedFiles = ['src/shared.mjs']; tasks[2].suggestedFiles = ['src/shared.mjs']; });
  await assert.rejects(f.start(), /共享文件/);
  await change(tasks => { tasks[1].suggestedFiles = ['src/Shared.mjs']; tasks[2].suggestedFiles = ['src/shared.mjs']; });
  await assert.rejects(f.start(), /大小写/);
  await change(tasks => { tasks[0].suggestedFiles = ['src/shared.mjs']; tasks[1].suggestedFiles = ['src/shared.mjs']; });
  assert.equal((await f.start()).kind, 'simulation');
});

test('重启中断在途模拟，不自动继续；重试保留中断记录，新计划不继承成功', async t => {
  const f = await setup(t); await f.approve(); const run = await f.start(); await until(() => f.executor.calls.length === 1);
  await f.app.simulationService.shutdown();
  const store = await new ProjectStore(f.directory).init(), executor = new ControlledExecutor();
  const service = await new SimulatedTaskService(store, { executor }).init(); f.app.additionalShutdown.push(service);
  const restored = service.list(f.project.id, f.plan.id)[0];
  assert.equal(restored.status, 'interrupted'); assert.equal(task(restored, 'A').attempts[0].status, 'interrupted'); assert.equal(executor.calls.length, 0);
  await service.action(f.project.id, f.plan.id, run.id, { action: 'retry', taskId: 'A' }); await until(() => executor.calls.length === 1);
  await executor.finish('A'); await until(() => executor.calls.length === 3); await executor.finish('B', 'failed'); await executor.finish('C');
  await until(() => service.list(f.project.id, f.plan.id)[0].status === 'failed');
  const project = store.get(f.project.id), plan = project.runs[0];
  plan.tasks[0].title = '新计划基础契约'; plan.planRevision = planningRevision(plan); plan.planVersion++;
  plan.approvals.plan.revision = plan.planRevision; await store.save(project);
  await assert.rejects(service.action(project.id, plan.id, run.id, { action: 'retry', taskId: 'B' }), /旧版本/);
  const newer = await service.start(project.id, plan.id, { planRevision: plan.planRevision });
  assert.ok(newer.tasks.every(task => task.attempts.length === 0)); assert.notEqual(newer.id, run.id);
  assert.equal(task(service.list(project.id, plan.id)[0], 'C').status, 'completed');
});

test('默认模拟执行器失败一次后重试、并发可配置；HTTP持久化导出无真实验收门禁', async t => {
  const f = await setup(t, undefined); // setup default is controlled; use a separate default service after planning.
  await f.approve();
  const service = new SimulatedTaskService(f.app.store); await service.init(); f.app.additionalShutdown.push(service);
  const run = await service.start(f.project.id, f.plan.id, { planRevision: f.plan.planRevision, concurrency: 1, durationMs: 0, failOnceIds: ['B'] });
  await until(() => service.list(f.project.id, f.plan.id)[0].status === 'failed');
  await service.action(f.project.id, f.plan.id, run.id, { action: 'retry', taskId: 'B' });
  await until(() => task(service.list(f.project.id, f.plan.id)[0], 'D').status === 'awaiting_confirmation');
  assert.equal(task(service.list(f.project.id, f.plan.id)[0], 'C').attempts.length, 1);
  await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${f.app.server.address().port}/api/projects/${f.project.id}/runs/${f.plan.id}`;
  const listing = await (await fetch(`${url}/simulations`)).json(); assert.equal(listing.runs[0].id, run.id);
  const exported = await (await fetch(`${url}/simulations/${run.id}/download`)).json();
  assert.equal(exported.realAcceptance, false); assert.equal(exported.kind, 'simulation');
  assert.match(exported.simulation.notice, /模拟完成/);
  assert.equal((await fetch(`${url}/executions`)).status, 404);
  assert.equal((await fetch(`${url}/simulations/${run.id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'complete', taskId: 'D' }) })).status, 400);
  const raw = JSON.parse(await readFile(path.join(f.directory, `${f.project.id}.json`), 'utf8'));
  assert.equal(raw.simulations[0].tasks.find(task => task.id === 'D').status, 'awaiting_confirmation');
});

test('模型工程计划复用原有校验，原规划任务和真实源码验收保持隔离', async t => {
  const f = await setup(t); await f.approve();
  f.plan.mode = 'model';
  f.plan.engineeringPlan = validateEngineeringPlan({ spec: f.plan.spec,
    binding: { projectId: f.project.id, runId: f.plan.id, specRevision: f.plan.specRevision },
    proposal: { version: 1, title: '模拟工程计划夹具', summary: '不调用模型的工程计划结构样例', entities: [], routes: [],
      views: [{ id: 'HOME', path: '/', title: '模拟页面', requirementIds: ['R1'], selectors: [{ testId: 'simulation-example', role: 'heading' }] }],
      tasks: f.plan.tasks.map(({ id, title, description, requirementIds, dependsOn, inputs, outputs, acceptance, suggestedFiles }) =>
        ({ id, title, description, requirementIds, dependsOn, inputs, outputs, acceptance, writePaths: suggestedFiles })) } });
  f.plan.tasks = engineeringTasks(f.plan.engineeringPlan);
  f.plan.planRevision = planningRevision(f.plan); f.plan.approvals.plan.revision = f.plan.planRevision; await f.app.store.save(f.project);
  const run = await f.start({ confirmationIds: ['D'] }); assert.equal(run.kind, 'simulation');
  await f.executor.finish('A'); await f.executor.finish('B'); await f.executor.finish('C'); await f.executor.finish('D');
  await until(() => task(f.current(run.id), 'D').status === 'awaiting_confirmation');
  await f.action(run.id, { action: 'confirm', taskId: 'D', attempt: 1, reason: '工程计划模拟结果核对' });
  await f.executor.finish('E'); await until(() => f.current(run.id).status === 'completed');
  // A separate real service reads the same confirmed plan but never consumes simulated success.
  const real = await createApp({ dataDir: f.directory, planner: simulationPlanner, sourceChangeService: null });
  f.app.additionalShutdown.push({ shutdown: () => real.close() });
  const listing = await real.executionService.list({ projectId: f.project.id, runId: f.plan.id });
  assert.equal(listing.executions.length, 0);
  await assert.rejects(real.executionService.download({ projectId: f.project.id, runId: f.plan.id, executionId: run.id }));
  assert.equal(f.current(run.id).realAcceptance, false);
});

test('模拟发布先落盘后派发；保存失败不解锁下游，重复人工确认不能重复启动', async t => {
  const f = await setup(t); await f.approve(); const run = await f.start();
  await f.executor.finish('A'); await f.executor.finish('B'); await f.executor.finish('C'); await f.executor.finish('D');
  await until(() => task(f.current(run.id), 'D').status === 'awaiting_confirmation');
  const save = f.app.store.save.bind(f.app.store); let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.app.store.save = async project => { await gate; return save(project); };
  const confirmation = f.action(run.id, { action: 'confirm', taskId: 'D', attempt: 1, reason: '保存中不派发' });
  await delay(20); assert.equal(f.executor.calls.length, 4);
  assert.equal(task(f.current(run.id), 'D').status, 'awaiting_confirmation');
  release(); await confirmation; f.app.store.save = save;
  await until(() => f.executor.calls.length === 5);
  await assert.rejects(f.action(run.id, { action: 'confirm', taskId: 'D', attempt: 1, reason: '重复' }), /只能确认/);
  await f.executor.finish('E'); await until(() => f.current(run.id).status === 'completed');
  f.app.store.save = async () => { throw new Error('测试写入失败'); };
  await assert.rejects(f.start(), /保存失败/); f.app.store.save = save;
  assert.equal(f.executor.calls.length, 5); assert.equal(f.project.simulations.length, 1);
});

test('需求输入发布新版本后旧模拟只读，旧结果不影响新需求审批', async t => {
  const f = await setup(t); await f.approve(); const run = await f.start();
  await f.executor.finish('A'); await f.executor.finish('B', 'failed'); await f.executor.finish('C');
  await until(() => f.current(run.id).status === 'failed');
  await f.app.store.publishSourceChange(f.project.id, { baseRevision: f.plan.sourceRevision, generation: 0, changeId: randomUUID(),
    source: { filename: 'new.md', content: '新版需求新增约束，不继承旧模拟完成。' }, impact: {}, changeHash: 'test', policyHash: 'test' });
  await assert.rejects(f.action(run.id, { action: 'retry', taskId: 'B' }), /旧需求版本/);
  await assert.rejects(f.start(), /旧需求版本/);
  assert.equal(task(f.current(run.id), 'C').status, 'completed');
  assert.equal(f.current(run.id).sourceGeneration, 0); assert.equal(f.project.sourceGeneration, 1);
});
