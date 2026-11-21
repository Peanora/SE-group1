import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { verificationModelPolicy } from '../lib/verification-model.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';
import { assertCompiledManifest } from '../lib/verification-contract.mjs';

const identity = { projectId: 'project', runId: 'run' }, config = { baseUrl: 'https://handoff.synthetic.invalid/v1', model: 'synthetic-handoff', apiKey: 'synthetic-handoff-private' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function definition(browser = true) {
  return { version: 1, id: 'resource-check', name: '资源读取', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'resource', method: 'GET', path: '/resources', assertions: [{ id: 'status', op: 'status', value: 200 }] } }],
    ...(browser ? { browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'open', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } } : {}) };
}
function planning() {
  const source = { filename: 'requirements.md', content: '用户读取资源列表。' }, spec = { title: '资源系统', summary: source.content, goals: ['读取资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取', description: source.content, sourceQuote: source.content, acceptance: ['返回列表'] }] };
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { ...identity, specRevision }, proposal: { version: 1, title: '资源工程', summary: '资源读取接口', entities: [], routes: [{ id: 'resources', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '资源列表', errors: [], requirementIds: ['R1'] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks: [{ id: 'implement', title: '实现资源', description: '实现读取', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['确认规格'], outputs: ['资源接口'], acceptance: ['资源可读'] }] } });
  const run = { id: identity.runId, projectId: identity.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, status: 'succeeded', stages: [], spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '资源读取' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: identity.projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}
async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'planned-handoff-')), data = planning(), services = [];
  const base = { rootDir, getPlanning: () => data, getPlanningSync: () => data, config, timeoutMs: 2000, cleanupMs: 30,
    dependencies: { createModel: () => async input => { const body = definition(options.browser !== false), usage = { inputTokens: 2, outputTokens: 3 }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(body) }); return { proposal: body, model: config.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } },
    ...(options.sync === 'missing' ? { getPlanningSync: undefined } : options.sync === 'async' ? { getPlanningSync: async () => data } : {}) };
  const open = async () => { const service = await createVerificationPlanningService(base); services.push(service); return service; };
  const service = await open();
  t.after(async () => { for (const item of services.reverse()) await item.shutdown(); assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir())); assert.ok(path.basename(rootDir).startsWith('planned-handoff-')); await rm(rootDir, { recursive: true, force: true }); });
  const proposal = (await service.propose({ ...identity, contractRevision: (await service.list(identity)).capabilities.contractRevision })).proposal;
  const end = Date.now() + 4000; let row;
  do { row = (await service.list(identity)).proposals.find(item => item.id === proposal.id); if (row.status === 'draft') break; assert.ok(Date.now() < end, JSON.stringify(row)); await new Promise(done => setTimeout(done, 5)); } while (true);
  if (options.approved !== false) row = (await service.approve({ ...identity, proposalId: row.id, revision: row.revision, feedback: '独立测试认可当前定义' })).proposal;
  const input = () => ({ ...identity, proposalId: row.id, revision: row.revision });
  const freezes = () => { const db = new DatabaseSync(path.join(rootDir, 'verification.sqlite'), { readOnly: true }); try { return db.prepare('SELECT * FROM execution_freezes').all(); } finally { db.close(); } };
  return { rootDir, data, service, open, row, input, freezes };
}

test('approved definition creates a real compiled capability and durable freeze before the callback starts', async t => {
  const f = await fixture(t); let callback = 0, captured;
  const result = await f.service.withApprovedExecution(f.input(), async capability => {
    callback++; captured = capability; assert.equal(f.freezes().length, 1);
    assert.equal(assertCompiledManifest(capability.manifest, { ...identity, specRevision: f.data.run.specRevision, planRevision: f.data.run.planRevision }), capability.manifest);
    assert.equal(capability.assertCurrent(), true); assert.ok(capability.task.tasks[0].writePaths.includes('src/app.mjs'));
    return { status: 'failed', terminationConfirmed: true };
  });
  assert.equal(callback, 1); assert.equal(result.terminationConfirmed, true);
  assert.throws(() => captured.assertCurrent());
  assert.equal(await f.service.withProjectCheckpoint(identity.projectId, () => 'released'), 'released');
  const state = await f.service.list(identity); assert.equal(state.capabilities.canPropose, false); assert.equal(state.proposals[0].frozenForCoding, true); assert.ok(Object.values(state.proposals[0].actions).every(value => !value));
});
for (const options of [{ approved: false }, { browser: false }, { sync: 'missing' }, { sync: 'async' }]) test(`handoff refuses missing prerequisite ${JSON.stringify(options)} without freezing`, async t => {
  const f = await fixture(t, options); let calls = 0;
  await assert.rejects(f.service.withApprovedExecution(f.input(), () => { calls++; return { status: 'failed', terminationConfirmed: true }; }));
  assert.equal(calls, 0); assert.equal(f.freezes().length, 0);
});
test('handoff refuses foreign identity, old revision, forged approval and superseded input', async t => {
  const f = await fixture(t); let calls = 0; const callback = () => { calls++; return { status: 'failed', terminationConfirmed: true }; };
  for (const input of [{ ...f.input(), revision: 'a'.repeat(64) }, { ...f.input(), projectId: 'foreign' }, { ...f.input(), runId: 'foreign' }, { ...f.input(), approval: { passed: true } }]) await assert.rejects(f.service.withApprovedExecution(input, callback));
  f.data.run.sourceSuperseded = true; await assert.rejects(f.service.withApprovedExecution(f.input(), callback));
  assert.equal(calls, 0); assert.equal(f.freezes().length, 0);
});
test('an in-flight code capability blocks editing, duplicate execution and the shared project checkpoint', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const running = f.service.withApprovedExecution(f.input(), async capability => { entered.resolve(); await release.promise; capability.assertCurrent(); return { status: 'failed', terminationConfirmed: true }; });
  await entered.promise;
  await assert.rejects(f.service.withProjectCheckpoint(identity.projectId, () => assert.fail('source/delete checkpoint must not enter')));
  await assert.rejects(f.service.withApprovedExecution(f.input(), () => assert.fail('duplicate execution')));
  for (const method of ['revise', 'approve', 'reject']) await assert.rejects(f.service[method]({ ...f.input(), ...(method === 'revise' ? { proposal: definition() } : {}), feedback: '不能在编码期间修改验收定义' }));
  release.resolve(); await running;
  await assert.rejects(f.service.revise({ ...f.input(), proposal: { ...definition(), name: '编码后不能换测试' }, feedback: '不能洗掉原门禁' }));
});
test('unknown completion and callback failure preserve reconciliation across restart', async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t);
    if (throws) await assert.rejects(f.service.withApprovedExecution(f.input(), () => { throw new Error('worker result unavailable'); }));
    else await f.service.withApprovedExecution(f.input(), () => ({ status: 'reconciliation_required', terminationConfirmed: false }));
    await assert.rejects(f.service.withProjectCheckpoint(identity.projectId, () => true));
    await f.service.shutdown(); const next = await f.open();
    assert.equal((await next.list(identity)).proposals[0].status, 'reconciliation_required');
    await assert.rejects(next.withProjectCheckpoint(identity.projectId, () => true));
  }
});
test('shutdown is bounded and a late accepted worker cannot restore permission after restart', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let capability;
  const work = f.service.withApprovedExecution(f.input(), async input => { capability = input; entered.resolve(); await release.promise; return { status: 'accepted', terminationConfirmed: true }; });
  const rejected = assert.rejects(work); await entered.promise; const started = Date.now(); await f.service.shutdown(); assert.ok(Date.now() - started < 1000);
  assert.equal(capability.signal.aborted, true); const next = await f.open(); release.resolve(); await rejected;
  assert.equal((await next.list(identity)).proposals[0].status, 'reconciliation_required');
  await assert.rejects(next.withProjectCheckpoint(identity.projectId, () => true));
});
test('persisted freeze is stable across a changed policy/context hash and cannot be replaced', async t => {
  const f = await fixture(t); await f.service.withApprovedExecution(f.input(), () => ({ status: 'failed', terminationConfirmed: true })); await f.service.shutdown();
  const db = new DatabaseSync(path.join(f.rootDir, 'verification.sqlite'));
  try { const row = db.prepare('SELECT snapshot FROM proposals WHERE id=?').get(f.row.id), snapshot = JSON.parse(row.snapshot); snapshot.binding.policyHash = 'f'.repeat(64); db.prepare('UPDATE proposals SET context_key=?,snapshot=? WHERE id=?').run('e'.repeat(64), JSON.stringify(snapshot), f.row.id); } finally { db.close(); }
  const next = await f.open(), state = await next.list(identity); assert.equal(state.proposals[0].frozenForCoding, true); assert.equal(state.capabilities.canPropose, false);
  await assert.rejects(next.propose({ ...identity, contractRevision: state.capabilities.contractRevision })); assert.equal(f.freezes().length, 1);
});
test('changing the current plan while a worker waits prevents its accepted result from returning', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const work = f.service.withApprovedExecution(f.input(), async () => { entered.resolve(); await release.promise; return { status: 'accepted', terminationConfirmed: true }; });
  const rejected = assert.rejects(work); await entered.promise; f.data.run.planRevision = 'f'.repeat(64); release.resolve(); await rejected;
});
