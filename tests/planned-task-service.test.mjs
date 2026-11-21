import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';

// Integration mechanism only: real approvals, private brands, Git, SQLite,
// HMAC and ZIP; synthetic model transport and external HTTP/Edge infrastructure.
const ids = { projectId: 'dag-service-project', runId: 'dag-planning-run' }, config = { baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-task-service', apiKey: '' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Measured: the graph took 43s and the full first case 130s; these waits do not change production budgets.
async function until(read) { const deadline = Date.now() + 90000; for (;;) { const value = await read(); if (value) return value; assert.ok(Date.now() < deadline, 'task service did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 20)); } }
function planning(unsupported = false) {
  const source = { filename: 'tasks.md', content: '实现基础、两个独立资源模块及最终集成。' };
  const spec = { title: 'Resources', summary: source.content, goals: ['实现资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R', title: '资源', description: source.content, sourceQuote: source.content, acceptance: ['返回资源'] }] };
  const tasks = [ { id: 'base', dependsOn: [], writePaths: ['src/app.mjs'] }, { id: 'alpha', dependsOn: ['base'], writePaths: ['src/alpha.mjs'] }, { id: 'beta', dependsOn: ['base'], writePaths: ['src/beta.mjs'] }, { id: 'final', dependsOn: ['alpha', 'beta'], writePaths: ['docs/README.md'] } ]
    .map(item => ({ ...item, title: item.id, description: `实现${item.id}`, requirementIds: ['R'], inputs: ['确认规格'], outputs: ['受控代码'], acceptance: ['固定检查通过'] }));
  if (unsupported) tasks[1].dependsOn = [];
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { ...ids, specRevision }, proposal: { version: 1, title: 'Resources plan', summary: source.content, entities: [], routes: [{ id: 'resources', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '资源列表', requirementIds: ['R'], errors: [] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks } });
  const run = { id: ids.runId, projectId: ids.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '确定工程结构' }], review: { passed: true, issues: [] }, status: 'succeeded', stages: [], approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: ids.projectId, sourceGeneration: 0, currentSourceRevision: run.sourceRevision }, run };
}
function definition(tasks) { return { version: 1, id: 'dag-resources', name: 'Task scoped definition', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R'], request: { id: 'get_resources', method: 'GET', path: '/resources', assertions: [{ id: 'resource_status', op: 'status', value: 200 }] } }],
  browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R'], op: 'goto', path: '/' }, { id: 'list', session: 'visitor', requirementIds: ['R'], op: 'visible', testId: 'resources', value: true }] },
  taskScopes: tasks.map(task => ({ taskId: task.id, httpStepIds: ['read'], browserStepIds: ['list'] })) }; }
if (!process.env.TASKFLOW_TASK_SERVICE_CHILD) {
  test('task graph service retains actual full-run receipts/budget and restores only historical delivery, not parsed task brands', () => {
    const env = { ...process.env, TASKFLOW_TASK_SERVICE_CHILD: '1' }; delete env.NODE_TEST_CONTEXT; for (const key of Object.keys(env)) if (/^LLM_/iu.test(key)) delete env[key];
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', import.meta.filename], { env, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 6 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  let active; const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'synthetic-infrastructure' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash, terminationConfirmed: true, processes: [{ ...stopped, pid: 1 }], checks: input.manifest.checks.map(rule => ({ ...rule, passed: true })) }) } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, terminationConfirmed: true, browser: { closed: true, version: 'synthetic-edge' }, processes: [{ ...stopped, kind: 'runtime', pid: 2 }, { ...stopped, kind: 'runtime', pid: 3 }, { ...stopped, kind: 'browser', pid: 4 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, passed: true })) }) } });
  const { createVerificationPlanningService } = await import('../lib/verification-planning-service.mjs');
  const { verificationModelPolicy } = await import('../lib/verification-model.mjs');
  const { createPlannedExecutionService } = await import('../lib/planned-execution-service.mjs');
  const { startPlannedTaskExecution, isPlannedTaskRunAccepted } = await import('../lib/planned-task-executor.mjs');
  const { plannedTaskIntegration } = await import('../lib/planned-task-executor.mjs');
  const { createPlannedCheckpoints } = await import('../lib/planned-checkpoint.mjs');
  const { createPlannedDelivery } = await import('../lib/planned-delivery.mjs');
  const { readProjectFiles } = await import('../lib/project-files.mjs');
  const { inspectPlannedArchive } = await import('../lib/planned-archive.mjs');
  const { readWebArchiveEntries } = await import('../lib/web-archive.mjs');
  async function fixture(t, pause = false, unsupported = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'planned-task-service-')), data = planning(unsupported), services = [], gate = deferred(), barrier = deferred(); let verification, service, approved;
    const f = active = { calls: [], models: 0, simultaneous: 0, gate, root, data };
    const query = sql => { const db = new DatabaseSync(path.join(root, 'planned', 'planned.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
    const open = async () => {
      verification = await createVerificationPlanningService({ rootDir: path.join(root, 'verification'), getPlanning: () => data, getPlanningSync: () => data, config,
        dependencies: { createModel: () => async input => { const proposal = definition(input.task.tasks), usage = { inputTokens: 0, outputTokens: 0 }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(proposal) }); return { proposal, model: config.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } }); services.push(verification);
      service = await createPlannedExecutionService({ rootDir: path.join(root, 'planned'), verificationService: verification, getPlanningSync: () => data, withCheckpoint: (_id, work) => work(), config, executable: process.execPath,
        dependencies: { startExecution: input => { f.manifest = input.manifest; f.task = input.task; const handle = startPlannedTaskExecution({ ...input, maxCalls: 1, maxReviewCalls: 1 });
          return { ...handle, done: handle.done.then(record => { f.originalGraph = record; return record; }) }; }, createProvider: () => async input => {
          const context = JSON.parse(input.task), item = context.activeTask; f.calls.push(item.id); f.models++;
          assert.equal(query('SELECT reserved_calls FROM budgets')[0].reserved_calls, 24, 'all four tasks reserved before first model');
          if (pause && item.id === 'base') await gate.promise;
          if (['alpha', 'beta'].includes(item.id)) { f.simultaneous++; if (f.simultaneous === 2) barrier.resolve(); await barrier.promise; }
          const files = [{ path: item.writePaths[0], content: item.id === 'base' ? 'export async function createApp(){return {handle:async()=>({status:200,body:"resources",headers:{}})}}\n' : item.id === 'final' ? '# Integration evidence\n' : `export const ${item.id}=true;\n` }];
          await input.onReceipt({ model: 'synthetic-code', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify({ files }) }); return { files };
        }, createReviewer: () => async input => { f.models++; const value = { summary: 'synthetic review', issues: [], resolutions: [] }; await input.onReceipt({ model: 'synthetic-review', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 }, content: JSON.stringify(value) }); return value; } } }); services.push(service);
    };
    await open(); const proposed = (await verification.propose({ ...ids, contractRevision: (await verification.list(ids)).capabilities.contractRevision })).proposal;
    approved = await until(async () => (await verification.list(ids)).proposals.find(item => item.id === proposed.id && item.status === 'draft'));
    approved = (await verification.approve({ ...ids, proposalId: approved.id, revision: approved.revision, feedback: '确认编码前逐任务范围，未执行目标软件' })).proposal;
    t.after(async () => { gate.resolve(); barrier.resolve(); for (const item of services.reverse()) await item.shutdown(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('planned-task-service-')); await rm(root, { recursive: true, force: true }); });
    return { root, data, f, query, get service() { return service; }, async reopen() { await service.shutdown(); await verification.shutdown(); await open(); },
      async input() { return { ...ids, proposalId: approved.id, revision: approved.revision, contractRevision: (await service.list(ids)).capabilities.contractRevision }; },
      async start() { const cap = (await service.list(ids)).capabilities; assert.equal(cap.budget.attemptModelCalls, 24); assert.equal(cap.budget.totalModelCalls, null); assert.equal(cap.budget.unlimited, true); assert.equal(cap.budget.taskLimit, 4); return (await service.start({ ...ids, proposalId: approved.id, revision: approved.revision, contractRevision: cap.contractRevision })).execution; },
      async row(id) { return (await service.list(ids)).executions.find(item => item.id === id); }, async done(id) { return until(async () => { const row = await this.row(id); return row && !row.active ? row : null; }); } };
  }
  test('four tasks are reserved once, actual two-way coding/merge completes, full-run cost/history survives two close/reopen downloads', async t => {
    const f = await fixture(t), started = await f.start(), row = await f.done(started.id);
    assert.equal(row.accepted, true, row.error || row.checkpoint.message); assert.equal(row.executionMode, 'task_dag'); assert.equal(row.maxConcurrentTasks, 2); assert.equal(row.tasks.length, 4); assert.ok(row.tasks.every(item => item.status === 'completed'));
    assert.equal(row.totalModelCalls, 8); assert.deepEqual(row.usage, { inputTokens: 20, outputTokens: 28 }); assert.equal(f.f.models, 8);
    assert.equal(row.reviewHistory.length, 4);
    assert.deepEqual(row.reviewHistory.map(item => item.taskId), row.tasks.map(item => item.id));
    for (const review of row.reviewHistory) {
      assert.equal(review.status, 'completed');
      assert.equal(review.candidateCommit, row.tasks.find(item => item.id === review.taskId).candidateCommit);
    }
    const [ledger] = f.query('SELECT * FROM budgets'); assert.equal(ledger.used_calls, 8); assert.equal(ledger.reserved_calls, 0); assert.equal(ledger.attempts, 1);
    const final = plannedTaskIntegration(f.f.originalGraph, f.f.manifest), checkpointControl = await createPlannedCheckpoints({ rootDir: path.join(f.root, 'planned'), hasCheckpoints: true });
    try {
      const saved = f.query('SELECT * FROM executions')[0], seal = JSON.parse(f.query('SELECT seal FROM accepted_checkpoints')[0].seal), parsed = JSON.parse(saved.record);
      assert.throws(() => checkpointControl.sign({ row: saved, record: final, manifest: f.f.manifest }), 'integration cannot be sealed without its whole original graph');
      assert.throws(() => checkpointControl.verify({ row: saved, record: parsed.integration, seal, policyHash: final.executorPolicyHash, manifest: f.f.manifest }), 'historical integration cannot omit whole sealed graph');
      const permit = checkpointControl.verify({ row: saved, record: parsed.integration, executionRecord: parsed, seal, policyHash: final.executorPolicyHash, manifest: f.f.manifest });
      const delivery = { record: parsed.integration, manifest: f.f.manifest, files: await readProjectFiles(final.workspace), requirements: f.data.run.sourceSnapshot.content, spec: f.data.run.spec, tasks: f.f.task.tasks, checkpoint: permit, executionId: saved.id };
      await assert.rejects(createPlannedDelivery(delivery), 'even a valid graph historical permit cannot omit graph cost/history');
      const zip = await createPlannedDelivery({ ...delivery, executionRecord: parsed });
      assert.equal(JSON.parse(readWebArchiveEntries(zip).entries.get('delivery/verification.json').content).modelCalls.length, 8);
    } finally { checkpointControl.close(); }
    let archiveHash; const before = JSON.stringify(ledger);
    for (let generation = 0; generation < 3; generation++) {
      if (generation) await f.reopen(); const restored = await f.row(started.id); assert.equal(restored.accepted, true, restored.checkpoint.message); assert.equal(restored.checkpoint.restored, generation > 0);
      assert.deepEqual(restored.reviewHistory, row.reviewHistory);
      const zip = (await f.service.download({ ...ids, executionId: started.id })).buffer, entries = readWebArchiveEntries(zip).entries;
      const history = JSON.parse(entries.get('delivery/task-execution.json').content), summary = JSON.parse(entries.get('delivery/verification.json').content);
      assert.equal(history.tasks.length, 4); assert.equal(history.totalModelCalls, 8); assert.equal(summary.modelCalls.length, 8); assert.deepEqual(summary.usage, { inputTokens: 20, outputTokens: 28 });
      assert.equal(history.maxConcurrentTasks, 2); assert.equal((await inspectPlannedArchive(zip)).taskAccepted, false); assert.equal(f.f.models, 8); assert.equal(JSON.stringify(f.query('SELECT * FROM budgets')[0]), before);
      const codeOnly = hash([...entries].filter(([name]) => !name.startsWith('delivery/')).map(([name, file]) => [name, file.sha256])); if (archiveHash) assert.equal(codeOnly, archiveHash); archiveHash = codeOnly;
    }
    const db = new DatabaseSync(path.join(f.root, 'planned', 'planned.sqlite'));
    try {
      const saved = db.prepare('SELECT record FROM executions WHERE id=?').get(started.id), record = JSON.parse(saved.record);
      record.usage.inputTokens++;
      // Read-only history must remain ordered even when delivery rejects a changed record.
      const past = structuredClone(record.tasks[0].record);
      past.attemptId = 'historical-attempt';
      past.versions[0].commit = '0'.repeat(40);
      record.tasks[0].history.push(past);
      db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(record), started.id);
    } finally { db.close(); }
    await f.reopen(); const tampered = await f.row(started.id); assert.equal(tampered.accepted, false); assert.equal(tampered.actions.canDownload, false); assert.equal(f.f.models, 8);
    assert.equal(tampered.reviewHistory[0].attemptId, 'historical-attempt');
    assert.equal(tampered.reviewHistory[0].candidateCommit, '0'.repeat(40));
    assert.equal(tampered.reviewHistory[1].candidateCommit, row.tasks[0].candidateCommit);
  });
  test('pause/continue is a backend batch checkpoint, preserves reservations, blocks publication while paused and never starts downstream early', async t => {
    const f = await fixture(t, true), started = await f.start(); await until(() => f.f.calls.includes('base'));
    const pause = await f.service.pause({ ...ids, executionId: started.id }); assert.equal(pause.execution.status, 'pause_requested'); assert.equal(pause.execution.actions.canResume, true);
    await assert.rejects(f.service.pause({ ...ids, executionId: started.id })); f.f.gate.resolve();
    const paused = await until(async () => { const row = await f.row(started.id); return row.status === 'paused' ? row : null; }); assert.equal(paused.active, true); assert.deepEqual(f.f.calls, ['base']);
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('paused task must hold project checkpoint')));
    const resumed = await f.service.resume({ ...ids, executionId: started.id }); assert.equal(resumed.execution.status, 'running'); const ended = await f.done(started.id); assert.equal(ended.accepted, true, ended.error);
    await assert.rejects(f.service.resume({ ...ids, executionId: started.id })); assert.equal(f.f.models, 8);
  });
  test('a confirmed but unsupported task graph is explained and rejected before any attempt, reservation, callback or paid request', async t => {
    const f = await fixture(t, false, true), state = await f.service.list(ids); assert.equal(state.capabilities.canStart, false); assert.deepEqual(state.capabilities.supportedProposalIds, []); assert.match(state.capabilities.reason, /统一基础/u);
    await assert.rejects(f.service.start(await f.input()), { code: 'unsupported_task_graph' }); assert.equal(f.f.models, 0); assert.deepEqual(f.f.calls, []);
    assert.equal(f.query('SELECT * FROM budgets').length, 0); assert.equal(f.query('SELECT * FROM executions').length, 0);
  });
}
