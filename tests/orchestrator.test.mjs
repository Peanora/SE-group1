import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectStore } from '../lib/store.mjs';
import { Orchestrator, WORKFLOW } from '../lib/orchestrator.mjs';

const planner = {
  getModelConfig: () => ({ configured: false, model: '' }),
  analyzeRequirements: (text, name) => ({ title: name, requirements: [{ id: 'R1', description: text }], sourceMode: 'local' }),
  generateTasks: () => [{ id: 'DEV-1', title: '实现需求', dependsOn: [], requirementIds: ['R1'], acceptance: ['通过验收'] }],
  validateTaskGraph: () => {},
  renderSpec: spec => `# ${spec.title}\n\n${spec.requirements[0].description}`,
  renderArchitecture: () => '# 项目架构\n\n前端、后端和存储。',
  renderTasks: (spec, tasks) => `# ${spec.title} 开发任务\n\n${tasks[0].id}`,
  reviewPlan: () => ({ passed: true, issues: [], coverage: [{ requirementId: 'R1', taskIds: ['DEV-1'] }], summary: '需求全部覆盖' }),
  renderReview: review => `# 检查\n${review.summary}`,
  renderHandoff: (spec, tasks, review, feedback) => `# 开发交接\n${feedback}`,
};

async function waitFor(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待运行状态超时');
    await delay(5);
  }
}

async function setup(t, stepDelayMs = 0) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-orchestrator-'));
  const store = await new ProjectStore(directory).init();
  const orchestrator = new Orchestrator(store, planner, { stepDelayMs });
  const project = await store.create({ name: '课程任务系统', source: { filename: '需求.md', content: '用户可以创建、更新并完成软件开发任务。' } });
  t.after(async () => { await orchestrator.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, orchestrator, project };
}

test('失败只阻塞下游；重试保留成功分支；审阅确认才导出', async t => {
  const { orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id, { failOnceStage: 'tasks' });
  await waitFor(() => run.status === 'failed');
  assert.equal(run.stages.find(s => s.id === 'architecture').status, 'succeeded');
  assert.equal(run.stages.find(s => s.id === 'tasks').attempt, 1);
  assert.equal(run.stages.find(s => s.id === 'review').status, 'blocked');
  assert.equal(run.stages.find(s => s.id === 'export').status, 'blocked');
  assert.ok(run.artifacts.some(a => a.name === 'architecture.md'));
  assert.ok(!run.artifacts.some(a => a.name === 'task.md'));

  await orchestrator.action(project.id, run.id, { action: 'retry', stageId: 'tasks' });
  await waitFor(() => run.status === 'awaiting_review');
  assert.equal(run.stages.find(s => s.id === 'architecture').attempt, 1);
  assert.equal(run.stages.find(s => s.id === 'tasks').attempt, 2);
  assert.equal(run.stages.find(s => s.id === 'tasks').history.length, 2);
  assert.equal(run.stages.find(s => s.id === 'export').status, 'pending');
  assert.ok(run.artifacts.some(a => a.name === 'task.md'));
  assert.ok(!run.artifacts.some(a => a.name === 'handoff.md'));
  await orchestrator.action(project.id, run.id, { action: 'approve', feedback: '按本计划进入开发。' });
  await waitFor(() => run.status === 'succeeded');
  assert.match(run.artifacts.find(a => a.name === 'handoff.md').content, /按本计划进入开发/u);
  assert.ok(run.artifacts.some(a => a.name === 'plan.json'));
  assert.deepEqual(run.events.map(e => e.sequence), run.events.map((e, i) => i + 1));
});

test('阶段边界暂停不启动后续任务；恢复后继续推进', async t => {
  const { orchestrator, project } = await setup(t, 40);
  const run = await orchestrator.createRun(project.id);
  await waitFor(() => run.stages[0].status === 'running');
  await orchestrator.action(project.id, run.id, { action: 'pause' });
  await delay(100);
  assert.equal(run.status, 'paused');
  assert.equal(run.stages[0].status, 'succeeded');
  assert.equal(run.stages.find(s => s.id === 'spec').status, 'pending');
  await assert.rejects(orchestrator.createRun(project.id), { status: 409 });
  await orchestrator.action(project.id, run.id, { action: 'resume' });
  await waitFor(() => run.status === 'awaiting_review');
  assert.equal(run.stages[0].attempt, 1);
});

test('服务重启将中断阶段转为可重试失败，并保留成功阶段', async t => {
  const { directory, store, project } = await setup(t);
  const now = new Date().toISOString();
  const run = {
    id: randomUUID(), projectId: project.id, mode: 'local', status: 'running', createdAt: now, updatedAt: now,
    spec: null, tasks: [], artifacts: [], review: null, feedback: '', approvedAt: null, events: [],
    stages: WORKFLOW.map((stage, i) => ({ ...stage, dependsOn: [...stage.dependsOn], status: i === 0 ? 'succeeded' : i === 1 ? 'running' : 'pending', attempt: i <= 1 ? 1 : 0, startedAt: i <= 1 ? now : null, finishedAt: i === 0 ? now : null, error: null, history: [] })),
  };
  project.runs.push(run);
  await store.save(project);
  const restoredStore = await new ProjectStore(directory).init();
  const restored = new Orchestrator(restoredStore, planner, { stepDelayMs: 0 });
  t.after(() => restored.shutdown());
  await restored.init();
  const restoredRun = restoredStore.getRun(project.id, run.id).run;
  assert.equal(restoredRun.status, 'failed');
  assert.equal(restoredRun.stages[1].status, 'failed');
  assert.equal(restoredRun.stages[2].status, 'blocked');
  await restored.action(project.id, run.id, { action: 'retry', stageId: 'spec' });
  await waitFor(() => restoredRun.status === 'awaiting_review');
  assert.equal(restoredRun.stages[0].attempt, 1);
  assert.equal(restoredRun.stages[1].attempt, 2);
});

test('拒绝未配置模型和越过审阅门禁的操作', async t => {
  const { orchestrator, project } = await setup(t, 20);
  await assert.rejects(orchestrator.createRun(project.id, { mode: 'model' }), { status: 400 });
  const run = await orchestrator.createRun(project.id);
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve' }), { status: 409 });
  await assert.rejects(orchestrator.createRun(project.id), { status: 409 });
  await waitFor(() => run.status === 'awaiting_review');
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'retry' }), { status: 409 });
});

test('等待人工审阅的运行在服务重启后保持门禁状态', async t => {
  const { directory, orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_review');
  await orchestrator.shutdown();
  const restoredStore = await new ProjectStore(directory).init();
  const restored = new Orchestrator(restoredStore, planner, { stepDelayMs: 0 });
  t.after(() => restored.shutdown());
  await restored.init();
  const restoredRun = restoredStore.getRun(project.id, run.id).run;
  assert.equal(restoredRun.status, 'awaiting_review');
  assert.equal(restoredRun.stages.find(s => s.id === 'export').attempt, 0);
  await restored.action(project.id, run.id, { action: 'approve', feedback: '恢复后继续确认。' });
  await waitFor(() => restoredRun.status === 'succeeded');
  assert.equal(restoredRun.stages.find(s => s.id === 'tasks').attempt, 1);
});
