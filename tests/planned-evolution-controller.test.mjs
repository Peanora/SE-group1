import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { minimalEnv } from '../lib/managed-process.mjs';
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
  let service, starts = 0, linkedIntent, execution = { id: executionId, status: 'running', active: true, accepted: false };
  t.after(async () => {
    await service?.shutdown();
    const target = await realpath(directory);
    assert.equal(path.dirname(target), temp);
    assert.ok(path.basename(target).startsWith('evolution-observation-'));
    await rm(target, { recursive: true, force: true });
  });
  const options = { rootDir, sourceRootDir: directory, getPlanningSync: () => structuredClone(data),
    verificationService: { assertApprovedDefinition(input) { assert.deepEqual(input, { ...identity, proposalId: 'definition', revision: definitionRevision }); } },
    plannedService: {
      list: async () => ({ executions: [structuredClone(execution)] }), evolutionStartAuthority: 'fixture-ledger',
      findEvolutionStart: value => value.intentId === linkedIntent ? executionId : null,
      startEvolution: async (_input, { evolutionStart, assertAdmission }) => {
        assert.equal(assertAdmission(), true);
        linkedIntent = evolutionStart.intentId;
        starts++;
        return { execution };
      },
    },
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

test('HTTP start crash windows preserve the exact execution and permit only an undispatched retry', async t => {
  const temp = await realpath(os.tmpdir());
  for (const fault of ['after-reservation', 'before-reservation', 'rollback-association', 'replaced-ledger', 'revoke-before-reservation']) await t.test(fault, async t => {
    const directory = await mkdtemp(path.join(temp, 'evolution-start-intent-'));
    const data = planning('project-start-intent');
    const identity = { projectId: data.project.id, runId: data.run.id };
    const evolutionId = 'evolution-1';
    const record = { version: 1, input: { ...identity, releaseId: 'older-release', proposalId: 'definition', definitionRevision: 'a'.repeat(64) },
      planningKey: inspectVerificationPlanning(data, identity.projectId, identity.runId).key,
      revisionNumber: 1, reason: '保留旧数据。', migration: { version: 1, kind: 'none', operations: [] } };
    const revision = contentRevision(record);
    record.approval = { revision, at: new Date().toISOString(), feedback: '确认已有数据保留。' };
    await writeFile(path.join(directory, 'input.json'), JSON.stringify({ data, record, revision, evolutionId, identity }));
    const applications = [];
    t.after(async () => {
      for (const { child, exited } of applications) {
        if (child.connected) child.send('close', error => { if (error) child.kill(); });
        await exited;
      }
      const target = await realpath(directory);
      assert.equal(path.dirname(target), temp);
      assert.match(path.basename(target), /^evolution-start-intent-/u);
      await rm(target, { recursive: true, force: true });
    });
    async function boot(mode) {
      const child = fork(new URL('./fixtures/planned-evolution-start-api.mjs', import.meta.url), [directory, mode],
        { execArgv: [], env: minimalEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const exited = once(child, 'exit');
      applications.push({ child, exited });
      const [{ port }] = await Promise.race([once(child, 'message'), exited.then(([code]) => assert.fail('API exited before listen: ' + code))]);
      return {
        request: (method, fields, authorized = true, pathname = '/') => fetch('http://127.0.0.1:' + port + pathname, {
          method, signal: AbortSignal.timeout(8000),
          headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer fixture-owner' } : {}) },
          ...(fields ? { body: JSON.stringify(fields) } : {}),
        }),
        exited,
      };
    }
    const ledgerFile = path.join(directory, 'execution', 'planned.sqlite');
    const queryExecution = sql => {
      const db = new DatabaseSync(ledgerFile, { readOnly: true });
      try { return db.prepare(sql).all(); }
      finally { db.close(); }
    };
    function modifyFixtureLedger(sql) {
      const db = new DatabaseSync(ledgerFile);
      try { db.exec(sql); }
      finally { db.close(); }
    }
    const readEvolution = async api => {
      const response = await api.request('GET');
      assert.equal(response.status, 200);
      return (await response.json()).evolutions[0];
    };
    const original = await boot(fault === 'replaced-ledger' ? 'before-reservation' : fault);
    let resumed;
    if (fault === 'rollback-association') {
      const failed = await original.request('POST', { evolutionId });
      assert.equal(failed.status, 500);
      assert.deepEqual(queryExecution('SELECT * FROM evolution_starts'), []);
      modifyFixtureLedger('DROP TRIGGER forced_association_rollback');
      resumed = original;
    } else if (fault === 'revoke-before-reservation') {
      const failed = await original.request('POST', { evolutionId });
      assert.equal(failed.status, 409);
      assert.deepEqual(await failed.json(), { code: 'evolution_access_revoked' });
      resumed = original;
    } else {
      await assert.rejects(original.request('POST', { evolutionId }), TypeError);
      const [exitCode] = await original.exited;
      assert.equal(exitCode, fault === 'after-reservation' ? 42 : 41);
      if (fault === 'replaced-ledger') modifyFixtureLedger("UPDATE evolution_start_authority SET nonce='different-ledger' WHERE id=1");
      resumed = await boot('no-fault');
    }
    const verifyProjectBlocked = async () => {
      const checkpoint = await resumed.request('POST', undefined, true, '/checkpoint');
      assert.equal(checkpoint.status, 409);
      assert.deepEqual(await checkpoint.json(), { code: 'project_busy' });
      const planned = await resumed.request('POST', undefined, true, '/planned');
      assert.equal(planned.status, 409);
      assert.deepEqual(await planned.json(), { code: 'not_ready' });
      assert.deepEqual(queryExecution('SELECT * FROM budgets'), []);
    };
    if (fault === 'replaced-ledger') await verifyProjectBlocked();
    const evolution = await readEvolution(resumed);
    let executionId;
    if (fault === 'after-reservation') {
      const [execution] = queryExecution('SELECT id,status,active FROM executions');
      assert.deepEqual([execution.status, execution.active], ['reconciliation_required', 1]);
      assert.equal(evolution.executionId, execution.id);
      assert.equal(evolution.status, 'reconciliation_required');
      assert.equal(evolution.actions.canStart, false);
      executionId = execution.id;
    } else {
      assert.deepEqual(queryExecution('SELECT id FROM executions'), []);
      assert.deepEqual(queryExecution('SELECT * FROM budgets'), []);
      assert.equal(evolution.executionId, null);
      if (fault === 'replaced-ledger') {
        assert.equal(evolution.status, 'reconciliation_required');
        assert.equal(evolution.actions.canStart, false);
        assert.equal((await resumed.request('POST', { evolutionId })).status, 409);
        await verifyProjectBlocked();
        return;
      }
      assert.equal(evolution.status, 'approved');
      assert.equal(evolution.actions.canStart, true);
      const checkpoint = await resumed.request('POST', undefined, true, '/checkpoint');
      assert.equal(checkpoint.status, 200);
      assert.deepEqual(await checkpoint.json(), { checkpoint: true });
      const retry = await resumed.request('POST', { evolutionId });
      assert.equal(retry.status, 202);
      executionId = (await retry.json()).execution.id;
    }
    const denied = await Promise.all(['missing', evolutionId].map(id => resumed.request('POST', { evolutionId: id }, false)));
    assert.deepEqual(await Promise.all(denied.map(response => response.json())), [
      { code: 'evolution_access_revoked' }, { code: 'evolution_access_revoked' },
    ]);
    const duplicated = await resumed.request('POST', { evolutionId });
    assert.equal(duplicated.status, 409);
    assert.equal((await readEvolution(resumed)).executionId, executionId);
    assert.deepEqual(queryExecution('SELECT id FROM executions').map(row => row.id), [executionId]);
    assert.deepEqual(queryExecution('SELECT evolution_id,evolution_revision,execution_id FROM evolution_starts').map(row => [...Object.values(row)]), [[evolutionId, revision, executionId]]);
    assert.deepEqual(queryExecution('SELECT attempts,used_calls,reserved_calls FROM budgets').map(row => [...Object.values(row)]), [[1, 0, 6]]);
    await assert.rejects(stat(path.join(directory, 'unexpected-model-call')), { code: 'ENOENT' });
  });
});
