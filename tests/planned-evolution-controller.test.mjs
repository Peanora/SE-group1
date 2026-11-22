import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlannedEvolutionService } from '../lib/planned-evolution.mjs';
import { inspectVerificationPlanning } from '../lib/verification-planning-service.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';
import { setupPlannedEvolutionFixture, nativeEvolutionAvailable } from './helpers/planned-evolution-fixture.mjs';

function planning(projectId) {
  const ids = { projectId, runId: 'new-run' }, source = { filename: 'change.md', content: '保留原事项数据，新增优先级和界面显示。' };
  const spec = { title: '事项演进', summary: source.content, goals: ['保留已有事项并增加优先级'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['旧事项不丢失'],
    stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '数据保留', description: source.content, sourceQuote: source.content, acceptance: ['旧事项仍可查看'] }] };
  const specRevision = contentRevision(spec), tasks = [{ id: 'NEW_APP', title: '修改业务', description: '原事项数据和新字段', requirementIds: ['R1'], dependsOn: [], inputs: ['规格'], outputs: ['接口'], acceptance: ['旧数据保留'], writePaths: ['src/app.mjs'] },
    { id: 'NEW_FINAL', title: '修改页面', description: '显示旧事项及优先级', requirementIds: ['R1'], dependsOn: ['NEW_APP'], inputs: ['接口'], outputs: ['页面'], acceptance: ['页面显示'], writePaths: ['public/app.js'] }];
  const engineeringPlan = validateEngineeringPlan({ spec, binding: { ...ids, specRevision }, proposal: { version: 1, title: '事项工程计划', summary: '保留旧数据', entities: [],
    routes: [{ id: 'items', method: 'GET', path: '/items', roles: [], request: '无', response: '事项', errors: [], requirementIds: ['R1'] }],
    views: [{ id: 'home', title: '事项', path: '/', requirementIds: ['R1'], selectors: [{ testId: 'items', role: 'list' }] }], tasks } });
  const run = { id: ids.runId, projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 1, status: 'succeeded', stages: [], spec, specRevision,
    specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '事项模型' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: projectId, currentSourceRevision: run.sourceRevision, sourceGeneration: 1 }, run };
}

test('a bound evolution observes pending reconciliation after restart without redispatch or activation', async t => {
  const temp = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temp, 'evolution-observation-'));
  const rootDir = path.join(directory, 'evolutions'), data = planning('project-evolution-restart');
  const identity = { projectId: data.project.id, runId: data.run.id }, evolutionId = 'evolution-1', executionId = 'execution-1';
  const definitionRevision = 'a'.repeat(64), contractRevision = 'b'.repeat(64), assertAccess = () => true;
  let service, starts = 0, execution = { id: executionId, status: 'running', active: true, accepted: false };
  t.after(async () => {
    await service?.shutdown();
    const target = await realpath(directory);
    assert.equal(path.dirname(target), temp);
    assert.ok(path.basename(target).startsWith('evolution-observation-'));
    await rm(target, { recursive: true, force: true });
  });
  const options = { rootDir, sourceRootDir: directory, getPlanningSync: () => structuredClone(data),
    verificationService: { assertApprovedDefinition(input) { assert.deepEqual(input, { ...identity, proposalId: 'definition', revision: definitionRevision }); } },
    plannedService: { list: async () => ({ executions: [structuredClone(execution)] }), startEvolution: async () => { starts++; return { execution }; } },
    releaseService: { authorizeStoppedDataset: () => assert.fail('no release operation') },
    datasetService: { snapshot: () => assert.fail('no data operation') }, withCheckpoint: (_id, work) => work() };
  service = await createPlannedEvolutionService(options);
  // Start with a persisted controller-approved migration, before its first development dispatch.
  const record = { version: 1, input: { ...identity, releaseId: 'owned-release', proposalId: 'definition', definitionRevision },
    planningKey: inspectVerificationPlanning(data, identity.projectId, identity.runId).key,
    revisionNumber: 1, reason: '保留旧事项。', migration: { version: 1, kind: 'none', operations: [] } };
  const revision = contentRevision(record), now = new Date().toISOString();
  record.approval = { revision, at: now, feedback: '确认迁移。' };
  const db = new DatabaseSync(path.join(rootDir, 'evolutions.sqlite'));
  try {
    db.prepare("INSERT INTO evolutions VALUES(?,?,?,?,?,'approved',0,?,?,?,?)")
      .run(evolutionId, identity.projectId, identity.runId, 'request-1', contentRevision(record.input), revision, JSON.stringify(record), now, now);
  } finally { db.close(); }
  const request = { ...identity, evolutionId, revision, contractRevision };
  const started = await service.start(request, { assertAccess });
  assert.equal(started.evolution.executionId, executionId);
  assert.equal(started.evolution.status, 'running');
  await service.shutdown();

  execution = { ...execution, status: 'reconciliation_required', active: true };
  service = await createPlannedEvolutionService(options);
  const [reopened] = (await service.list(identity)).evolutions;
  assert.equal(reopened.status, 'reconciliation_required');
  assert.equal(reopened.executionId, executionId);
  assert.equal(reopened.revision, revision);
  assert.match(reopened.error, /模型用量.*待核对/u);
  assert.deepEqual(reopened.actions, { canRevise: false, canApprove: false, canStart: false, canActivate: false });
  await assert.rejects(service.start(request, { assertAccess }), { code: 'evolution_start_unavailable' });
  await assert.rejects(service.activate({ ...identity, evolutionId, revision }, { assertAccess }), { code: 'evolution_not_accepted' });
  assert.equal(execution.active, true, 'the original development service still owns the active slot');
  assert.equal(starts, 1);

  execution = { ...execution, status: 'accepted', active: false, accepted: true };
  const [settled] = (await service.list(identity)).evolutions;
  assert.equal(settled.status, 'accepted');
  assert.equal(settled.error, null);
  assert.equal(settled.actions.canActivate, true);
  assert.equal(starts, 1);
});

// Real source/Git/owned data and snapshot workers; planning/controller adapters
// are explicit fixtures. This is not a model-generated product acceptance.
test('evolution drafts retain owned data, bind exact review and survive restart without gaining execution permission', { skip: !nativeEvolutionAvailable, timeout: 90000 }, async t => {
  const f = await setupPlannedEvolutionFixture(t, { prefix: 'controller-' }), data = planning(f.originBinding.projectId), state = { access: true, approved: true, checkpoint: false };
  const assertAccess = () => state.access, identity = { projectId: data.project.id, runId: data.run.id }, definitionRevision = 'a'.repeat(64); let checkpointQueue = Promise.resolve();
  const rootDir = path.join(f.directory, 'controller'); await mkdir(rootDir);
  const options = { rootDir, sourceRootDir: f.sourceRootDir, getPlanningSync: () => structuredClone(data),
    verificationService: { assertApprovedDefinition(input) { assert.equal(input.projectId, identity.projectId); assert.equal(input.runId, identity.runId); assert.equal(input.proposalId, 'approved-definition'); assert.equal(input.revision, definitionRevision); assert.equal(state.approved, true); } },
    plannedService: { list: async () => ({ executions: [] }) }, datasetService: f.service,
    releaseService: { async authorizeStoppedDataset(id) { assert.equal(id, 'owned-release'); return { origin: f.originBinding, sourceProvenance: f.source.provenance, retainedPaths: f.retainedPaths,
      assertCurrent() { assert.equal(f.state.dataCurrent, true); return true; } }; } },
    withCheckpoint: (_id, work) => { const done = checkpointQueue.then(async () => { assert.equal(state.checkpoint, false); state.checkpoint = true; try { return await work(); } finally { state.checkpoint = false; } }); checkpointQueue = done.catch(() => {}); return done; } };
  const service = await createPlannedEvolutionService(options); let closed = false; t.after(async () => { if (!closed) await service.shutdown(); });
  const body = { ...identity, releaseId: 'owned-release', proposalId: 'approved-definition', definitionRevision, expectedSourceRevision: data.run.sourceRevision, expectedSourceGeneration: 1, requestKey: 'request-1', reason: '新增优先级，原事项必须保留。' };
  await assert.rejects(service.prepare({ ...body, workspace: f.runtimeWorkspace }, { assertAccess }));
  state.access = false; await assert.rejects(service.prepare(body, { assertAccess })); state.access = true;
  const simultaneous = await Promise.all([service.prepare(body, { assertAccess }), service.prepare(body, { assertAccess })]);
  const first = simultaneous[0].evolution; assert.equal(simultaneous[1].evolution.id, first.id, 'the checkpoint must recheck the same idempotency key');
  assert.equal(first.status, 'awaiting_review'); assert.equal(first.current, true); assert.equal(first.actions.canStart, false); assert.equal(first.schema[0].name, 'items'); assert.equal(first.schema[0].rows, 2);
  assert.equal(JSON.stringify(first).includes(f.directory), false); assert.equal(JSON.stringify(first).includes('PRIVATE_ROW'), false);
  assert.equal((await service.prepare(body, { assertAccess })).evolution.id, first.id);
  await assert.rejects(service.prepare({ ...body, reason: '同一个请求编号不能更换内容。' }, { assertAccess }), e => e.code === 'evolution_request_key_conflict');
  const key = { ...identity, evolutionId: first.id, revision: first.revision }, migration = { version: 1, kind: 'bounded_operations', operations: [{ op: 'addColumn', table: 'items', column: 'priority', type: 'INTEGER', nullable: false, default: 0 }] };
  const changed = (await service.revise({ ...key, migration, reason: '使用默认值保留原行。' }, { assertAccess })).evolution; assert.notEqual(changed.revision, first.revision);
  await assert.rejects(service.approve({ ...key, feedback: '旧确认不能批准新描述。' }, { assertAccess }));
  const fresh = { ...key, revision: changed.revision }; state.access = false;
  await assert.rejects(service.approve({ ...fresh, feedback: '没有权限。' }, { assertAccess })); state.access = true;
  const rejected = (await service.reject({ ...fresh, feedback: '需要进一步调整迁移。' }, { assertAccess })).evolution; assert.equal(rejected.status, 'changes_requested');
  await assert.rejects(service.approve({ ...fresh, feedback: '原描述不能直接重新通过。' }, { assertAccess }));
  await assert.rejects(service.revise({ ...fresh, migration, reason: '只更改说明不足以消除驳回。' }, { assertAccess }), e => e.code === 'evolution_revision_unchanged');
  const adjusted = structuredClone(migration); adjusted.operations[0].default = 1;
  const finalDraft = (await service.revise({ ...fresh, migration: adjusted, reason: '按审阅调整默认优先级。' }, { assertAccess })).evolution;
  const approved = (await service.approve({ ...key, revision: finalDraft.revision, feedback: '确认当前精确字段及默认值。' }, { assertAccess })).evolution;
  assert.equal(approved.status, 'approved'); assert.equal(approved.actions.canStart, false, 'missing execution bridge is never advertised');
  await service.shutdown(); closed = true;
  const restored = await createPlannedEvolutionService(options); t.after(() => restored.shutdown());
  const saved = (await restored.list(identity)).evolutions[0]; assert.equal(saved.status, 'approved'); assert.equal(saved.revision, finalDraft.revision);
  state.approved = false; assert.equal((await restored.list(identity)).evolutions[0].current, false);
  await assert.rejects(restored.revise({ ...key, revision: saved.revision, migration, reason: '撤销验收定义后不能修改。' }, { assertAccess }));
});
