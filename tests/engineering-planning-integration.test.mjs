import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectStore } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import * as planner from '../lib/planner.mjs';
import { createEngineeringModel, engineeringModelPolicy } from '../lib/engineering-model.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';

const config = { baseUrl: 'https://model.invalid/v1', model: 'design-mock', apiKey: 'synthetic-design-secret' };
const source = '用户能够读取资源并提交预约。';
const spec = () => ({ title: '资源预约', summary: source, goals: [], roles: ['申请者：查看和预约资源'], acceptanceScenarios: [], constraints: [], assumptions: [], questions: [],
  stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' },
  requirements: [{ id: 'R1', title: '资源预约', description: source, sourceQuote: source, acceptance: ['读取可用资源', '并发不能超量预约'] }], sourceMode: 'model' });
const proposal = () => ({ version: 1, title: '资源预约工程', summary: '按确认规格提供接口和外置页面',
  entities: [{ id: 'RESOURCE', name: '资源', fields: [{ name: 'id', type: 'string', required: true, unique: true }], constraints: ['资源标识唯一'] }],
  routes: [{ id: 'LIST', method: 'GET', path: '/api/resources', roles: ['ROLE-001'], request: '无正文', response: '资源列表', errors: [{ status: 401, reason: '尚未登录' }], requirementIds: ['R1'] }],
  views: [{ id: 'HOME', path: '/', title: '资源列表', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }],
  tasks: [{ id: 'DEV-R1', title: '实现资源契约', description: '根据资源预约规格实现服务和界面', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs', 'public/app.js'], inputs: ['确认规格'], outputs: ['资源接口与页面'], acceptance: ['覆盖确认的验收条件'] }] });
const reply = (value = proposal(), finishReason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }], usage: { prompt_tokens: 23, completion_tokens: 34 } }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check) { const until = Date.now() + 5000; while (!check()) { if (Date.now() >= until) throw new Error('等待规划状态超时'); await delay(5); } }
async function setup(t, { fetchImpl = async () => reply(), options = {}, override = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'engineering-integration-'));
  const store = await new ProjectStore(directory).init(); let calls = 0;
  const trustedPlanner = { ...planner, getModelConfig: () => ({ configured: true }), analyzeWithModel: async () => spec(), analyzeRequirements: () => spec(),
    createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } }), ...override };
  const orchestrator = new Orchestrator(store, trustedPlanner, { stepDelayMs: 0, ...options });
  const instances = [orchestrator], register = instance => { instances.push(instance); return instance; };
  const project = await store.create({ name: '资源项目', source: { filename: '需求.md', content: source } });
  t.after(async () => { await Promise.all(instances.map(instance => instance.shutdown())); await rm(directory, { recursive: true, force: true }); });
  const run = await orchestrator.createRun(project.id, { mode: 'model' });
  await waitFor(() => run.status === 'awaiting_spec');
  const approve = () => orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
  return { directory, store, orchestrator, project, run, approve, register, calls: () => calls };
}
const approvePlan = ({ orchestrator, project, run }) => orchestrator.action(project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision });

test('规格批准后双分支共用一次模型设计，真实架构/任务/哈希及私有回执可核对', async t => {
  const x = await setup(t); const { run, project, directory } = x;
  assert.equal(x.calls(), 0); assert.equal(run.engineeringPlan, undefined);
  project.source.content = '项目后续变更，不影响本次快照';
  await x.approve(); await waitFor(() => run.status === 'awaiting_review');
  assert.equal(x.calls(), 1); assert.equal(run.engineeringCalls, 1); assert.equal(run.engineeringHistory.length, 1);
  const history = run.engineeringHistory[0];
  assert.equal(history.status, 'succeeded'); assert.equal(history.modelPolicyHash, engineeringModelPolicy.hash); assert.equal(history.finishReason, 'stop');
  assert.deepEqual(history.usage, { inputTokens: 23, outputTokens: 34 });
  assert.deepEqual(run.tasks, engineeringTasks(run.engineeringPlan));
  assert.equal(run.engineeringPlan.binding.specRevision, run.specRevision);
  assert.equal(run.engineeringPlan.roleDefinitions[0].text, spec().roles[0]);
  const architecture = run.artifacts.find(a => a.name === 'architecture.md').content;
  const renderedArchitecture = architecture.replace(/\\([^\s])/gu, '$1');
  for (const expected of ['RESOURCE', '/api/resources', 'ROLE-001', 'resources', 'structural_only']) assert.ok(renderedArchitecture.includes(expected), expected);
  const taskText = run.artifacts.find(a => a.name === 'task.md').content.replace(/\\([^\s])/gu, '$1');
  for (const expected of ['src/app.mjs', '确认规格', '资源接口与页面']) assert.ok(taskText.includes(expected), expected);
  assert.equal(run.planRevision, planningRevision(run));
  assert.notEqual(run.planRevision, contentRevision({ specRevision: run.specRevision, architecture, tasks: run.tasks }));
  const privateDir = path.join(directory, '.private', 'engineering-receipts', project.id, run.id);
  const files = await readdir(privateDir); assert.deepEqual(files, [`${history.receipt.id}.json`]);
  const receipt = JSON.parse(await readFile(path.join(privateDir, files[0]), 'utf8'));
  assert.deepEqual(Object.keys(receipt), ['model', 'finishReason', 'usage', 'content']); assert.deepEqual(JSON.parse(receipt.content), proposal());
  await approvePlan(x); await waitFor(() => run.status === 'succeeded');
  const exported = JSON.parse(run.artifacts.find(a => a.name === 'plan.json').content);
  assert.deepEqual(exported.engineeringPlan, run.engineeringPlan);
  const publicText = JSON.stringify(run);
  for (const forbidden of [directory, '.private', 'engineering-receipts', config.apiKey, '"content":"{\\"version']) assert.equal(publicText.includes(forbidden), false, forbidden);
  assert.equal(exported.engineeringHistory, undefined);
});

test('共享无效草案同时失败，重试共享新尝试并保留旧回执用量', async t => {
  let attempts = 0; const x = await setup(t, { fetchImpl: async () => ++attempts === 1 ? reply('{"version":1') : reply() });
  await x.approve(); await waitFor(() => x.run.status === 'failed');
  assert.equal(x.calls(), 1); assert.equal(x.run.engineeringPlan, undefined);
  for (const id of ['architecture', 'tasks']) assert.equal(x.run.stages.find(stage => stage.id === id).status, 'failed');
  assert.equal(x.run.artifacts.some(a => ['architecture.md', 'task.md'].includes(a.name)), false);
  const old = structuredClone(x.run.engineeringHistory[0]); assert.equal(old.code, 'invalid_model_response'); assert.ok(old.receipt);
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'retry', stageId: 'tasks' });
  await waitFor(() => x.run.status === 'awaiting_review');
  assert.equal(x.calls(), 2); assert.equal(x.run.engineeringHistory.length, 2); assert.deepEqual(x.run.engineeringHistory[0], old);
  assert.notEqual(x.run.engineeringHistory[1].receipt.id, old.receipt.id);
});

test('串行阶段也共用失败缓存，传输/配置错误无回退且未知用量不填零', async t => {
  for (const variant of ['http', 'factory', 'config']) await t.test(variant, async t => {
    const x = await setup(t, { options: { concurrency: 1 }, fetchImpl: async () => new Response('private provider detail', { status: 500 }),
      ...(variant === 'factory' ? { override: { createEngineeringModel: () => { throw new Error(config.apiKey + ' private config path'); } } } : {}),
      ...(variant === 'config' ? { override: { createEngineeringModel: () => createEngineeringModel({ config: { ...config, model: '' }, fetchImpl: async () => assert.fail('invalid config cannot dispatch') }) } } : {}) });
    await x.approve(); await waitFor(() => x.run.status === 'failed');
    assert.equal(x.calls(), variant === 'http' ? 1 : 0); assert.equal(x.run.engineeringCalls, 1); assert.equal(x.run.engineeringHistory.length, 1);
    assert.equal(x.run.engineeringPlan, undefined); assert.equal(x.run.engineeringHistory[0].receipt, null);
    if (variant === 'config') assert.equal(x.run.engineeringHistory[0].code, 'invalid_input');
    assert.deepEqual(x.run.engineeringHistory[0].usage, { inputTokens: null, outputTokens: null });
    for (const id of ['architecture', 'tasks']) assert.equal(x.run.stages.find(stage => stage.id === id).status, 'failed');
    assert.equal(JSON.stringify(x.run).includes(config.apiKey), false); assert.equal(JSON.stringify(x.run).includes('private provider detail'), false);
  });
});

test('凭据正文先遮蔽私有回执再拒绝，不成为可重试格式错误', async t => {
  const content = JSON.stringify(proposal()).replace('资源预约工程', [...config.apiKey].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
  const x = await setup(t, { fetchImpl: async () => reply(content) }); await x.approve(); await waitFor(() => x.run.status === 'failed');
  const history = x.run.engineeringHistory[0]; assert.equal(history.code, 'credential_response'); assert.equal(history.finishReason, 'stop');
  assert.deepEqual(history.usage, { inputTokens: 23, outputTokens: 34 }); assert.equal(x.run.engineeringPlan, undefined);
  const file = path.join(x.directory, '.private', 'engineering-receipts', x.project.id, x.run.id, `${history.receipt.id}.json`);
  const receipt = JSON.parse(await readFile(file, 'utf8')); assert.equal(receipt.content.includes(config.apiKey), false); assert.equal(receipt.content.includes('\\u0073'), false);
  assert.notEqual(receipt.content, content); assert.equal(JSON.stringify(x.run).includes(config.apiKey), false);
});

test('异常finish有回执且不回退；耗尽预算的重试不发送新请求', async t => {
  const x = await setup(t, { fetchImpl: async () => reply(proposal(), 'length'), options: { engineeringMaxCalls: 1 } });
  await x.approve(); await waitFor(() => x.run.status === 'failed');
  assert.equal(x.run.engineeringHistory[0].code, 'abnormal_finish'); assert.equal(x.run.engineeringHistory[0].finishReason, 'length');
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'retry', stageId: 'architecture' });
  await waitFor(() => x.run.status === 'failed' && x.run.stages.find(s => s.id === 'architecture').attempt === 2);
  assert.equal(x.calls(), 1); assert.equal(x.run.engineeringHistory.length, 1); assert.equal(x.run.engineeringCalls, 1);
  assert.match(x.run.stages.find(s => s.id === 'tasks').error, /预算/u);
});

test('边界暂停允许当前共享请求完成，恢复才开始review', async t => {
  const gate = deferred(); const x = await setup(t, { fetchImpl: async () => { await gate.promise; return reply(); } });
  await x.approve(); await waitFor(() => x.calls() === 1);
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'pause' }); gate.resolve();
  await waitFor(() => x.run.stages.filter(s => ['architecture', 'tasks'].includes(s.id)).every(s => s.status === 'succeeded'));
  assert.equal(x.run.status, 'paused'); assert.equal(x.run.stages.find(s => s.id === 'review').status, 'pending');
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'resume' }); await waitFor(() => x.run.status === 'awaiting_review'); assert.equal(x.calls(), 1);
});

test('时长预算和关闭均打断不配合取消的模型等待；迟到响应不能发布', async t => {
  for (const shutdown of [false, true]) await t.test(shutdown ? 'shutdown' : 'timeout', async t => {
    const gate = deferred(); const x = await setup(t, { fetchImpl: async () => { await gate.promise; return reply(); }, options: { engineeringTimeoutMs: shutdown ? 5000 : 40 } });
    await x.approve(); await waitFor(() => x.calls() === 1);
    if (shutdown) await x.orchestrator.shutdown(); else await waitFor(() => x.run.status === 'failed');
    assert.equal(x.run.engineeringPlan, undefined); assert.equal(x.run.engineeringHistory[0].code, shutdown ? 'cancelled' : 'model_timeout');
    assert.deepEqual(x.run.engineeringHistory[0].usage, { inputTokens: null, outputTokens: null });
    const old = JSON.stringify(x.run); gate.resolve(); await delay(30); assert.equal(JSON.stringify(x.run), old);
    assert.equal(x.run.artifacts.some(a => a.name === 'architecture.md'), false);
  });
});

test('在途期间规格或需求快照失效会拒绝迟到结果，非法修订不能覆盖在途stage', async t => {
  for (const target of ['spec', 'sourceSnapshot']) await t.test(target, async t => {
    const gate = deferred(); const x = await setup(t, { fetchImpl: async () => { await gate.promise; return reply(); } });
    await x.approve(); await waitFor(() => x.calls() === 1);
    const stage = x.run.stages.find(s => s.id === 'architecture');
    await assert.rejects(x.orchestrator.action(x.project.id, x.run.id, { action: 'revise_spec', revision: x.run.specRevision, spec: spec() }), { status: 409 });
    assert.equal(x.run.stages.find(s => s.id === 'architecture'), stage);
    if (target === 'spec') x.run.spec.summary += '新版本'; else x.run.sourceSnapshot.content += '新版本';
    gate.resolve(); await waitFor(() => x.run.status === 'failed'); assert.equal(x.run.engineeringPlan, undefined); assert.equal(x.calls(), 1);
    assert.equal(x.run.engineeringHistory[0].code, 'stale_revision'); assert.ok(x.run.engineeringHistory[0].receipt);
    assert.deepEqual(x.run.engineeringHistory[0].usage, { inputTokens: 23, outputTokens: 34 });
    assert.equal(x.run.artifacts.some(a => a.name === 'architecture.md'), false);
  });
});

test('规格回修归档完整旧草案，清缓存且再次确认前不调用', async t => {
  const x = await setup(t); await x.approve(); await waitFor(() => x.run.status === 'awaiting_review');
  const old = structuredClone(x.run.engineeringPlan), history = structuredClone(x.run.engineeringHistory);
  const revised = structuredClone(x.run.spec); revised.summary += ' 明确预约边界';
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'revise_spec', revision: x.run.specRevision, spec: revised });
  assert.equal(x.run.engineeringPlan, undefined); assert.equal(x.run.planRevision, null); assert.equal(x.calls(), 1);
  assert.deepEqual(x.run.revisionHistory.spec[0].engineeringPlan, old); assert.deepEqual(x.run.revisionHistory.plan[0].engineeringHistory, history);
  await x.approve(); await waitFor(() => x.run.status === 'awaiting_review');
  assert.equal(x.calls(), 2); assert.notEqual(x.run.engineeringPlan.hash, old.hash); assert.equal(x.run.engineeringPlan.binding.specRevision, x.run.specRevision);
  assert.deepEqual(x.run.revisionHistory.spec[0].engineeringPlan, old);
});

test('人工计划编辑同步工程任务及哈希，越写域原子拒绝，固定API保持', async t => {
  const x = await setup(t); await x.approve(); await waitFor(() => x.run.status === 'awaiting_review');
  const oldPlan = structuredClone(x.run.engineeringPlan), oldRevision = x.run.planRevision;
  let tasks = structuredClone(x.run.tasks); tasks[0].title = '重新细化资源契约'; tasks[0].outputs.push('明确接口错误分支');
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'revise_plan', revision: oldRevision, tasks });
  await waitFor(() => x.run.status === 'awaiting_review');
  assert.equal(x.calls(), 1); assert.notEqual(x.run.planRevision, oldRevision); assert.notEqual(x.run.engineeringPlan.hash, oldPlan.hash);
  assert.deepEqual(x.run.tasks, engineeringTasks(x.run.engineeringPlan)); assert.equal(x.run.engineeringPlan.proposal.tasks[0].title, tasks[0].title);
  assert.equal(x.run.planRevision, planningRevision(x.run)); assert.ok(x.run.artifacts.find(a => a.name === 'architecture.md').content.includes(x.run.engineeringPlan.hash));
  assert.deepEqual(x.run.engineeringPlan.proposal.routes, oldPlan.proposal.routes); assert.deepEqual(x.run.revisionHistory.plan[0].engineeringPlan, oldPlan);
  tasks = structuredClone(x.run.tasks); tasks[0].writePaths.push('src/extra.mjs'); tasks[0].suggestedFiles.push('src/extra.mjs');
  const before = structuredClone(x.run);
  await assert.rejects(x.orchestrator.action(x.project.id, x.run.id, { action: 'revise_plan', revision: x.run.planRevision, tasks }), { status: 400 });
  assert.deepEqual(x.run, before); await assert.rejects(x.orchestrator.action(x.project.id, x.run.id, { action: 'approve_plan', revision: oldRevision, specRevision: x.run.specRevision }), { status: 409 });
  x.run.engineeringPlan.proposal.routes[0].response = '伪造变化';
  await assert.rejects(approvePlan(x), { status: 409 });
});

test('重启保留完成草案和等待门禁；中断历史标识未知且不退还调用预算', async t => {
  const x = await setup(t); await x.approve(); await waitFor(() => x.run.status === 'awaiting_review');
  const restoredStore = await new ProjectStore(x.directory).init(); const restored = x.register(new Orchestrator(restoredStore, planner, { stepDelayMs: 0 }));
  await restored.init(); const saved = restoredStore.getRun(x.project.id, x.run.id).run;
  assert.equal(saved.status, 'awaiting_review'); assert.deepEqual(saved.engineeringPlan, x.run.engineeringPlan);
  saved.status = 'running'; saved.engineeringHistory.push({ id: 'interrupted', status: 'running', usage: { inputTokens: null, outputTokens: null } }); saved.engineeringCalls++;
  saved.stages.find(s => s.id === 'review').status = 'running'; await restoredStore.save(restoredStore.get(x.project.id));
  await restored.init(); assert.equal(saved.status, 'failed'); assert.equal(saved.engineeringHistory.at(-1).code, 'service_restart'); assert.equal(saved.engineeringCalls, 2);
  assert.deepEqual(saved.engineeringHistory.at(-1).usage, { inputTokens: null, outputTokens: null });
});

test('local与v1仍使用原规则，不调用工程适配器且旧哈希公式不变', async t => {
  const x = await setup(t);
  await waitFor(() => !x.orchestrator.state(x.run).driving && x.orchestrator.state(x.run).active.size === 0);
  delete x.run.workflowVersion; x.run.status = 'running'; x.orchestrator.schedule(x.project, x.run);
  await waitFor(() => x.run.status === 'awaiting_review'); assert.equal(x.calls(), 0); assert.equal(x.run.engineeringPlan, undefined);
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'approve' }); await waitFor(() => x.run.status === 'succeeded');
  const local = await x.orchestrator.createRun(x.project.id, { mode: 'local' }); await waitFor(() => local.status === 'awaiting_spec');
  await x.orchestrator.action(x.project.id, local.id, { action: 'approve_spec', revision: local.specRevision }); await waitFor(() => local.status === 'awaiting_review');
  assert.equal(x.calls(), 0); assert.equal(local.engineeringPlan, undefined);
  assert.equal(local.planRevision, contentRevision({ specRevision: local.specRevision, architecture: local.artifacts.find(a => a.name === 'architecture.md').content, tasks: local.tasks }));
});

test('私有回执父链链接及保存失败阻断两个分支而不暴露宿主路径', async t => {
  const x = await setup(t); const outside = await mkdtemp(path.join(os.tmpdir(), 'engineering-private-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(x.directory, '.private'), process.platform === 'win32' ? 'junction' : 'dir');
  await x.approve(); await waitFor(() => x.run.status === 'failed');
  assert.equal(x.run.engineeringHistory[0].code, 'receipt_failed'); assert.equal(x.run.engineeringPlan, undefined); assert.deepEqual(await readdir(outside), []);
  assert.equal(x.run.engineeringHistory[0].finishReason, 'stop'); assert.deepEqual(x.run.engineeringHistory[0].usage, { inputTokens: 23, outputTokens: 34 });
  assert.equal(JSON.stringify(x.run).includes(outside), false); assert.equal(JSON.stringify(x.run).includes(config.apiKey), false);
});

test('非合作回执写入不能阻塞超时或关闭，迟到结果不改最终历史', async t => {
  for (const shutdown of [false, true]) for (const lateFailure of [false, true]) await t.test(`${shutdown ? '关闭' : '超时'}-${lateFailure ? '迟到失败' : '迟到成功'}`, async t => {
    const entered = deferred(), release = deferred();
    const x = await setup(t, { options: { engineeringTimeoutMs: shutdown ? 5000 : 50 } });
    let writerSettled = false;
    x.orchestrator.writeEngineeringReceipt = async () => {
      entered.resolve(); await release.promise; writerSettled = true;
      if (lateFailure) throw new Error(`${config.apiKey} C:/synthetic-private/late-receipt`);
      return { id: 'late-receipt', sha256: 'a'.repeat(64), bytes: 100 };
    };
    try {
      await x.approve(); await entered.promise;
      if (shutdown) {
        let closed = false;
        void x.orchestrator.shutdown().then(() => { closed = true; });
        await waitFor(() => closed);
      } else await waitFor(() => x.run.status === 'failed');
      assert.equal(writerSettled, false, '停止必须在写入器释放前完成');
      assert.equal(x.run.engineeringPlan, undefined);
      const attempt = x.run.engineeringHistory[0];
      assert.equal(attempt.code, shutdown ? 'cancelled' : 'model_timeout');
      assert.equal(attempt.receipt, null); assert.equal(attempt.receiptState, 'unconfirmed');
      assert.deepEqual(attempt.usage, { inputTokens: 23, outputTokens: 34 });
      assert.ok(attempt.finishedAt);
      for (const id of ['architecture', 'tasks']) assert.equal(x.run.stages.find(stage => stage.id === id).status, 'failed');
      const before = JSON.stringify(x.run);
      release.resolve(); await waitFor(() => writerSettled); await delay(5);
      assert.equal(JSON.stringify(x.run), before, '迟到写入不得更新回执或发布草案');
    } finally { release.resolve(); }
  });
});

test('工程规划最终保存失败撤回成功且公开错误保持固定，持续故障不产生拒绝泄漏', async t => {
  for (const persistent of [false, true]) await t.test(persistent ? '持续故障' : '单次故障', async t => {
    const x = await setup(t), save = x.store.save.bind(x.store);
    let faults = 0;
    x.store.save = async project => {
      if (x.run.engineeringHistory?.[0]?.finishedAt && (persistent || faults === 0)) {
        faults++; throw new Error(`${config.apiKey} EACCES C:/synthetic-private/engineering-final-save.tmp`);
      }
      return save(project);
    };
    await x.approve(); await waitFor(() => x.run.status === 'failed');
    await x.orchestrator.shutdown();
    assert.ok(faults > 0); assert.equal(x.run.engineeringPlan, undefined);
    const attempt = x.run.engineeringHistory[0];
    assert.equal(attempt.code, 'persistence_failed'); assert.equal(attempt.status, 'failed');
    assert.equal(attempt.persistenceStatus, 'failed'); assert.equal(attempt.receiptState, 'saved');
    assert.deepEqual(attempt.usage, { inputTokens: 23, outputTokens: 34 });
    assert.ok(attempt.receipt);
    assert.equal(x.run.planRevision, null); assert.equal(x.run.artifacts.some(item => item.name === 'architecture.md'), false);
    const publicText = JSON.stringify(x.run);
    for (const forbidden of [config.apiKey, 'C:/synthetic-private', 'engineering-final-save.tmp', 'EACCES']) assert.equal(publicText.includes(forbidden), false, forbidden);
    for (const id of ['architecture', 'tasks']) assert.equal(x.run.stages.find(stage => stage.id === id).status, 'failed');
  });
});
