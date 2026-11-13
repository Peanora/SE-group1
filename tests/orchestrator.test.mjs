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
  analyzeRequirements: (text, name) => ({ title: name, summary: text, goals: [], roles: [], acceptanceScenarios: [], constraints: [], assumptions: [], questions: [], stack: { frontend: '原生HTML', backend: 'Node.js', storage: 'JSON' }, requirements: [{ id: 'R1', title: '任务管理', description: text, sourceQuote: text, acceptance: ['可完成任务'] }], sourceMode: 'local' }),
  generateTasks: () => [{ id: 'DEV-1', title: '实现需求', description: '完成任务管理', suggestedFiles: ['src/tasks.mjs'], dependsOn: [], requirementIds: ['R1'], acceptance: ['通过验收'] }],
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

async function setup(t, stepDelayMs = 0, plannerOverride = planner) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-orchestrator-'));
  const store = await new ProjectStore(directory).init();
  const orchestrator = new Orchestrator(store, plannerOverride, { stepDelayMs });
  const instances = [orchestrator];
  const register = instance => { instances.push(instance); return instance; };
  const project = await store.create({ name: '课程任务系统', source: { filename: '需求.md', content: '用户可以创建、更新并完成软件开发任务。' } });
  // Every restored scheduler must finish its own writes before deleting the shared fixture.
  t.after(async () => { await Promise.all(instances.map(instance => instance.shutdown())); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, orchestrator, project, register };
}

async function approveSpec(orchestrator, project, run) {
  await waitFor(() => run.status === 'awaiting_spec');
  return orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
}

async function approvePlan(orchestrator, project, run, feedback) {
  return orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision, feedback });
}

test('失败只阻塞下游；重试保留成功分支；审阅确认才导出', async t => {
  const { orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id, { failOnceStage: 'tasks' });
  await approveSpec(orchestrator, project, run);
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
  await approvePlan(orchestrator, project, run, '按本计划进入开发。');
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
  await waitFor(() => run.status === 'awaiting_spec');
  assert.equal(run.stages[0].attempt, 1);
});

test('服务重启将中断阶段转为可重试失败，并保留成功阶段', async t => {
  const { directory, store, project, register } = await setup(t);
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
  register(restored);
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
  await waitFor(() => run.status === 'awaiting_spec');
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'retry' }), { status: 409 });
});

test('等待人工审阅的运行在服务重启后保持门禁状态', async t => {
  const { directory, orchestrator, project, register } = await setup(t);
  const run = await orchestrator.createRun(project.id);
  await approveSpec(orchestrator, project, run);
  await waitFor(() => run.status === 'awaiting_review');
  await orchestrator.shutdown();
  const restoredStore = await new ProjectStore(directory).init();
  const restored = new Orchestrator(restoredStore, planner, { stepDelayMs: 0 });
  register(restored);
  await restored.init();
  const restoredRun = restoredStore.getRun(project.id, run.id).run;
  assert.equal(restoredRun.status, 'awaiting_review');
  assert.equal(restoredRun.stages.find(s => s.id === 'export').attempt, 0);
  await approvePlan(restored, project, restoredRun, '恢复后继续确认。');
  await waitFor(() => restoredRun.status === 'succeeded');
  assert.equal(restoredRun.stages.find(s => s.id === 'tasks').attempt, 1);
});

test('新运行双门禁绑定版本；旧确认、未答问题和过期版本不能推进', async t => {
  const custom = { ...planner, analyzeRequirements: (text, name) => ({ ...planner.analyzeRequirements(text, name), questions: ['界面需要哪些终端？'] }) };
  const { orchestrator, project } = await setup(t, 0, custom);
  const run = await orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_spec');
  assert.equal(run.workflowVersion, 2);
  assert.equal(run.specVersion, 1);
  assert.match(run.specRevision, /^[a-f0-9]{64}$/u);
  assert.equal(run.stages.find(stage => stage.id === 'architecture').attempt, 0);
  assert.equal(run.stages.find(stage => stage.id === 'tasks').attempt, 0);
  assert.deepEqual(run.spec.clarifications, run.specQuestions);
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve' }), { status: 409 });
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision }), { status: 409 });
  await assert.rejects(orchestrator.createRun(project.id), { status: 409 });
  const oldRevision = run.specRevision;
  await orchestrator.action(project.id, run.id, { action: 'revise_spec', revision: oldRevision, answers: { 'Q-001': '桌面和手机浏览器' } });
  assert.notEqual(run.specRevision, oldRevision);
  assert.equal(run.specVersion, 2);
  assert.equal(run.specQuestions[0].answer, '桌面和手机浏览器');
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: oldRevision }), { status: 409 });
  await approveSpec(orchestrator, project, run);
  await waitFor(() => run.status === 'awaiting_review');
  assert.equal(run.planVersion, 1);
  assert.equal(run.approvals.spec.revision, run.specRevision);
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve' }), { status: 409 });
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: oldRevision }), { status: 409 });
  await approvePlan(orchestrator, project, run);
  await waitFor(() => run.status === 'succeeded');
  const exported = JSON.parse(run.artifacts.find(item => item.name === 'plan.json').content);
  assert.equal(exported.specRevision, run.specRevision);
  assert.equal(exported.planRevision, run.planRevision);
  assert.equal(exported.approvals.plan.specRevision, exported.specRevision);
});

test('驳回需实际修订；修订规格清空下游及两审批并保留不可变历史', async t => {
  const { orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_spec');
  let revision = run.specRevision;
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'reject_spec', revision, feedback: ' ' }), { status: 400 });
  await orchestrator.action(project.id, run.id, { action: 'reject_spec', revision, feedback: '明确错误处理' });
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve_spec', revision }), { status: 409 });
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'revise_spec', revision, spec: { ...run.spec } }), { status: 409 });
  const badSpec = { ...run.spec, requirements: [{ ...run.spec.requirements[0], sourceQuote: '并非原文' }] };
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'revise_spec', revision, spec: badSpec }), { status: 400 });
  await orchestrator.action(project.id, run.id, { action: 'revise_spec', revision, spec: { ...run.spec, summary: '补充异常处理审阅' }, feedback: '已补充' });
  await approveSpec(orchestrator, project, run);
  await waitFor(() => run.status === 'awaiting_review');
  const oldPlan = run.planRevision;
  const oldTasks = structuredClone(run.tasks);
  revision = run.specRevision;
  const oldArchitectureAttempt = run.stages.find(stage => stage.id === 'architecture').attempt;
  await orchestrator.action(project.id, run.id, { action: 'revise_spec', revision, spec: { ...run.spec, summary: '增加第二次规格审阅说明' } });
  assert.equal(run.status, 'awaiting_spec');
  assert.deepEqual(run.approvals, { spec: null, plan: null });
  assert.equal(run.planRevision, null);
  assert.deepEqual(run.tasks, []);
  assert.equal(run.review, null);
  assert.deepEqual(run.artifacts.map(item => item.name), ['spec.md']);
  assert.equal(run.stages.find(stage => stage.id === 'architecture').status, 'pending');
  assert.equal(run.stages.find(stage => stage.id === 'architecture').history.length, oldArchitectureAttempt);
  const archivedPlan = structuredClone(run.revisionHistory.plan[0]);
  assert.equal(archivedPlan.revision, oldPlan);
  assert.deepEqual(archivedPlan.tasks, oldTasks);
  assert.ok(archivedPlan.artifacts.some(item => item.name === 'review.md'));
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: oldPlan, specRevision: revision }), { status: 409 });
  await approveSpec(orchestrator, project, run);
  await waitFor(() => run.status === 'awaiting_review');
  assert.notEqual(run.planRevision, oldPlan);
  assert.deepEqual(run.revisionHistory.plan[0], archivedPlan);
  assert.equal(run.stages.find(stage => stage.id === 'architecture').attempt, oldArchitectureAttempt + 1);
});

test('驳回计划后验证新任务图、需求映射和验收并重做检查', async t => {
  const { orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id);
  await approveSpec(orchestrator, project, run);
  await waitFor(() => run.status === 'awaiting_review');
  const revision = run.planRevision;
  const action = extra => orchestrator.action(project.id, run.id, { action: 'revise_plan', revision, ...extra });
  await orchestrator.action(project.id, run.id, { action: 'reject_plan', revision, feedback: '补充边界验收' });
  await assert.rejects(approvePlan(orchestrator, project, run), { status: 409 });
  await assert.rejects(action({ tasks: run.tasks }), { status: 409 });
  await assert.rejects(action({ tasks: [{ ...run.tasks[0], acceptance: [' '] }] }), { status: 400 });
  await assert.rejects(action({ tasks: [{ ...run.tasks[0], requirementIds: ['unknown'] }] }), { status: 400 });
  await assert.rejects(action({ tasks: [{ ...run.tasks[0], requirementIds: [] }] }), { status: 400 });
  await assert.rejects(action({ tasks: [{ ...run.tasks[0], dependsOn: ['DEV-1'] }] }), { status: 400 });
  const oldReviewAttempt = run.stages.find(stage => stage.id === 'review').attempt;
  const tasks = [{ ...run.tasks[0], acceptance: [...run.tasks[0].acceptance, '非法输入保持原数据'] }];
  await action({ tasks, feedback: '已增加异常验收' });
  assert.equal(run.approvals.plan, null);
  assert.equal(run.approvals.spec.revision, run.specRevision);
  assert.equal(run.planVersion, 2);
  await waitFor(() => run.status === 'awaiting_review');
  assert.equal(run.stages.find(stage => stage.id === 'review').attempt, oldReviewAttempt + 1);
  assert.equal(run.stages.find(stage => stage.id === 'tasks').attempt, 1);
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve_plan', revision, specRevision: run.specRevision }), { status: 409 });
  await approvePlan(orchestrator, project, run);
  await waitFor(() => run.status === 'succeeded');
});

test('并发重复审批或修订仅接受一次，修订存在有界版本上限', async t => {
  const { orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_spec');
  const input = { action: 'revise_spec', revision: run.specRevision, spec: { ...run.spec, summary: '并发修订' } };
  const revisions = await Promise.allSettled([orchestrator.action(project.id, run.id, input), orchestrator.action(project.id, run.id, input)]);
  assert.equal(revisions.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(revisions.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal(run.specVersion, 2);
  for (let version = 3; version <= 20; version++) await orchestrator.action(project.id, run.id, { action: 'revise_spec', revision: run.specRevision, spec: { ...run.spec, summary: `规格第 ${version} 版` } });
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'revise_spec', revision: run.specRevision, spec: { ...run.spec, summary: '超出上限' } }), { status: 409 });
  assert.equal(run.revisionHistory.spec.length, 19);
  const approval = { action: 'approve_spec', revision: run.specRevision };
  const results = await Promise.allSettled([orchestrator.action(project.id, run.id, approval), orchestrator.action(project.id, run.id, approval)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
});

test('规格等待在重启后保留，输入快照不会被项目正文变化污染', async t => {
  const { directory, store, orchestrator, project, register } = await setup(t, 20);
  const source = structuredClone(project.source);
  const run = await orchestrator.createRun(project.id);
  project.source = { filename: '新需求.md', content: '新的需求正文' };
  await store.save(project);
  await waitFor(() => run.status === 'awaiting_spec');
  assert.deepEqual(run.sourceSnapshot, source);
  assert.equal(run.spec.requirements[0].sourceQuote, source.content);
  await orchestrator.shutdown();
  const restoredStore = await new ProjectStore(directory).init();
  const restored = new Orchestrator(restoredStore, planner, { stepDelayMs: 0 });
  register(restored);
  await restored.init();
  const restoredRun = restoredStore.getRun(project.id, run.id).run;
  assert.equal(restoredRun.status, 'awaiting_spec');
  await assert.rejects(restored.createRun(project.id), { status: 409 });
  const invalid = { ...restoredRun.spec, requirements: [{ ...restoredRun.spec.requirements[0], sourceQuote: project.source.content }] };
  await assert.rejects(restored.action(project.id, run.id, { action: 'revise_spec', revision: restoredRun.specRevision, spec: invalid }), { status: 400 });
  await approveSpec(restored, project, restoredRun);
  await waitFor(() => restoredRun.status === 'awaiting_review');
  await approvePlan(restored, project, restoredRun);
  await waitFor(() => restoredRun.status === 'succeeded');
  assert.equal(JSON.parse(restoredRun.artifacts.find(item => item.name === 'plan.json').content).sourceFilename, source.filename);
});

test('无workflowVersion的历史等待记录保留旧导出，不能追认v2规格审批', async t => {
  const { directory, store, project, register } = await setup(t);
  const now = new Date().toISOString();
  const spec = planner.analyzeRequirements(project.source.content, project.name);
  const run = {
    id: randomUUID(), projectId: project.id, mode: 'local', status: 'awaiting_review', createdAt: now, updatedAt: now,
    spec, tasks: planner.generateTasks(spec), artifacts: [], review: planner.reviewPlan(), feedback: '', approvedAt: null, events: [],
    stages: WORKFLOW.map(stage => ({ ...stage, dependsOn: [...stage.dependsOn], status: stage.id === 'export' ? 'pending' : 'succeeded', attempt: stage.id === 'export' ? 0 : 1, history: [] })),
  };
  project.runs.push(run);
  await store.save(project);
  const restoredStore = await new ProjectStore(directory).init();
  const restored = new Orchestrator(restoredStore, planner, { stepDelayMs: 0 });
  register(restored);
  await restored.init();
  const legacy = restoredStore.getRun(project.id, run.id).run;
  assert.equal(legacy.status, 'awaiting_review');
  await assert.rejects(restored.action(project.id, run.id, { action: 'approve_spec', revision: 'legacy' }), { status: 409 });
  await restored.action(project.id, run.id, { action: 'approve', feedback: '仅导出历史规划包' });
  await waitFor(() => legacy.status === 'succeeded');
  assert.equal(legacy.workflowVersion, undefined);
  assert.equal(legacy.approvals, undefined);
});

test('审批持久化失败不放行，规格/架构/任务内容变化使旧版本失效', async t => {
  const { store, orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_spec' && !orchestrator.state(run).driving);
  const originalSave = store.save.bind(store);
  const before = structuredClone(run);
  store.save = async () => { throw new Error('磁盘写入失败 C:/synthetic-private/approval-save.tmp synthetic-storage-secret'); };
  await assert.rejects(approveSpec(orchestrator, project, run), {
    code: 'persistence_failed', message: '运行记录保存失败，请保留现场并检查本地存储后重试。',
  });
  assert.deepEqual(run, before);
  assert.equal(orchestrator.state(run).actionBusy, false);
  store.save = originalSave;
  const source = structuredClone(run.sourceSnapshot);
  run.sourceSnapshot.content = '被更换的正文';
  await assert.rejects(approveSpec(orchestrator, project, run), { status: 409 });
  run.sourceSnapshot = source;
  await approveSpec(orchestrator, project, run);
  await waitFor(() => run.status === 'awaiting_review');
  const architecture = run.artifacts.find(item => item.name === 'architecture.md');
  const content = architecture.content;
  architecture.content = '外部替换架构';
  await assert.rejects(approvePlan(orchestrator, project, run), { status: 409 });
  run.artifacts.find(item => item.name === 'architecture.md').content = content;
  const tasks = structuredClone(run.tasks);
  run.tasks[0].title = '外部修改任务';
  await assert.rejects(approvePlan(orchestrator, project, run), { status: 409 });
  run.tasks = tasks;
  await approvePlan(orchestrator, project, run);
  await waitFor(() => run.status === 'succeeded');
});

test('保存修订期间并发批准不会读取尚未落盘的新版本', async t => {
  const { store, orchestrator, project } = await setup(t);
  const run = await orchestrator.createRun(project.id);
  await waitFor(() => run.status === 'awaiting_spec' && !orchestrator.state(run).driving);
  const originalSave = store.save.bind(store);
  let release;
  const saved = new Promise(resolve => { release = resolve; });
  store.save = async value => { await saved; return originalSave(value); };
  const revision = run.specRevision;
  const pending = orchestrator.action(project.id, run.id, { action: 'revise_spec', revision, spec: { ...run.spec, summary: '等待保存的新内容' } });
  await assert.rejects(orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision }), { status: 409 });
  assert.equal(run.approvals.spec, null);
  assert.equal(run.stages.find(item => item.id === 'tasks').attempt, 0);
  release();
  await pending;
  store.save = originalSave;
  await approveSpec(orchestrator, project, run);
  await waitFor(() => run.status === 'awaiting_review');
});
