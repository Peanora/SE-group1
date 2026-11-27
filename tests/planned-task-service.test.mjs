import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';
import { ProjectStore } from '../lib/store.mjs';

// Integration mechanism only: real approvals, private brands, Git, SQLite,
// HMAC and ZIP; synthetic model transport and external HTTP/Edge infrastructure.
const ids = { projectId: 'dag-service-project', runId: 'dag-planning-run' }, config = { baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-task-service', apiKey: '' };
const source = { filename: 'tasks.md', content: '实现基础、两个独立资源模块及最终集成。' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Measured: the graph took 43s and the full first case 130s; these waits do not change production budgets.
async function until(read) { const deadline = Date.now() + 90000; for (;;) { const value = await read(); if (value) return value; assert.ok(Date.now() < deadline, 'task service did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 20)); } }
function planning({ unsupported, modular, wholeProject, identity }) {
  const spec = { title: 'Resources', summary: source.content, goals: ['实现资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R', title: '资源', description: source.content, sourceQuote: source.content, acceptance: ['返回资源'] }] };
  const tasks = [ { id: 'base', dependsOn: [], writePaths: ['src/app.mjs'] }, { id: 'alpha', dependsOn: ['base'], writePaths: ['src/alpha.mjs'] }, { id: 'beta', dependsOn: ['base'], writePaths: ['src/beta.mjs'] }, { id: 'final', dependsOn: ['alpha', 'beta'], writePaths: ['docs/README.md'] } ]
    .map(item => ({ ...item, title: item.id, description: `实现${item.id}`, requirementIds: ['R'], inputs: ['确认规格'], outputs: ['受控代码'], acceptance: ['固定检查通过'] }));
  if (unsupported) tasks[1].dependsOn = [];
  if (wholeProject) tasks.splice(1);
  if (modular) {
    for (const task of tasks) task.workflowModule = { group: ['base', 'alpha'].includes(task.id) ? '资源目录' : '资源展示', name: task.id };
  }
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { ...identity, specRevision }, proposal: { version: 1, title: 'Resources plan', summary: source.content, entities: [], routes: [{ id: 'resources', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '资源列表', requirementIds: ['R'], errors: [] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks } });
  const run = { id: identity.runId, projectId: identity.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '确定工程结构' }], review: { passed: true, issues: [] }, status: 'succeeded', stages: [], approvals: { spec: { revision: specRevision } } };
  if (modular) run.dependencyExecution = true;
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: identity.projectId, sourceGeneration: 0, currentSourceRevision: run.sourceRevision }, run };
}
function definition(tasks) { return { version: 1, id: 'dag-resources', name: 'Task scoped definition', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R'], request: { id: 'get_resources', method: 'GET', path: '/resources', assertions: [{ id: 'resource_status', op: 'status', value: 200 }] } }],
  browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R'], op: 'goto', path: '/' }, { id: 'list', session: 'visitor', requirementIds: ['R'], op: 'visible', testId: 'resources', value: true }] },
  ...(tasks.length > 1 ? { taskScopes: tasks.map(task => ({ taskId: task.id, httpStepIds: ['read'], browserStepIds: ['list'] })) } : {}) }; }
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
  async function fixture(t, { pause = false, unsupported = false, priced = false, modular = false, wholeProject = false, http = false } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'planned-task-service-')), services = [], gate = deferred(), barrier = deferred();
    let app, verification, service, approved;
    t.after(async () => {
      gate.resolve(); barrier.resolve();
      await app?.close();
      for (const item of services.reverse()) await item.shutdown();
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('planned-task-service-'));
      await rm(root, { recursive: true, force: true });
    });
    const store = http ? await new ProjectStore(path.join(root, 'projects')).init() : null;
    const project = await store?.create({ name: 'Task graph recipes', source });
    const identity = project ? { projectId: project.id, runId: randomUUID() } : ids;
    const data = planning({ unsupported, modular, wholeProject, identity });
    if (project) { project.runs.push(data.run); await store.save(project); }
    let currentCallbacks = 0;
    const f = active = { calls: [], models: 0, simultaneous: 0, peakCallbacks: 0, gate, root, data };
    const query = sql => { const db = new DatabaseSync(path.join(root, 'planned', 'planned.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
    const open = async () => {
      const codingInputRate = services.length === 0 ? 2 : 12;
      verification = await createVerificationPlanningService({ rootDir: path.join(root, 'verification'), getPlanning: () => data, getPlanningSync: () => data, config,
        dependencies: { createModel: () => async input => { const proposal = definition(input.task.tasks), usage = { inputTokens: 0, outputTokens: 0 }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(proposal) }); return { proposal, model: config.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } }); services.push(verification);
      service = await createPlannedExecutionService({ rootDir: path.join(root, 'planned'), verificationService: verification, getPlanningSync: () => data, withCheckpoint: (_id, work) => work(), config, executable: process.execPath,
        ...(priced ? { getConfig: () => ({ ...config, model: 'synthetic-code', pricing: { currency: 'CNY', inputPerMillion: codingInputRate, outputPerMillion: 5 } }),
          getReviewConfig: () => ({ ...config, model: 'synthetic-review', pricing: { currency: 'CNY', inputPerMillion: 3, outputPerMillion: 7 } }) } : {}),
        dependencies: { startExecution: input => { f.manifest = input.manifest; f.task = input.task; f.maxConcurrency = input.maxConcurrency; const handle = startPlannedTaskExecution({ ...input, maxCalls: 1, maxReviewCalls: 1 });
          return { ...handle, done: handle.done.then(record => { f.originalGraph = record; return record; }) }; }, createProvider: () => async input => {
          const context = JSON.parse(input.task), item = context.activeTask; f.calls.push(item.id); f.models++;
          assert.equal(query('SELECT reserved_calls FROM budgets')[0].reserved_calls, 24, 'all four tasks reserved before first model');
          if (pause && item.id === 'base') await gate.promise;
          currentCallbacks++;
          f.peakCallbacks = Math.max(f.peakCallbacks, currentCallbacks);
          try {
            if (f.maxConcurrency !== 1 && ['alpha', 'beta'].includes(item.id)) { f.simultaneous++; if (f.simultaneous === 2) barrier.resolve(); await barrier.promise; }
            const files = [{ path: item.writePaths[0], content: item.id === 'base' ? 'export async function createApp(){return {handle:async()=>({status:200,body:"resources",headers:{}})}}\n' : item.id === 'final' ? '# Integration evidence\n' : `export const ${item.id}=true;\n` }];
            await input.onReceipt({ model: 'synthetic-code', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify({ files }) }); return { files };
          } finally { currentCallbacks--; }
        }, createReviewer: () => async input => { f.models++; const value = { summary: 'synthetic review', issues: [], resolutions: [] }; await input.onReceipt({ model: 'synthetic-review', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 }, content: JSON.stringify(value) }); return value; } } }); services.push(service);
    };
    await open(); const proposed = (await verification.propose({ ...identity, contractRevision: (await verification.list(identity)).capabilities.contractRevision })).proposal;
    approved = await until(async () => (await verification.list(identity)).proposals.find(item => item.id === proposed.id && item.status === 'draft'));
    approved = (await verification.approve({ ...identity, proposalId: approved.id, revision: approved.revision, feedback: '确认编码前验收范围，未执行目标软件' })).proposal;
    if (store) {
      const { createApp } = await import('../server.mjs');
      app = await createApp({ store, teamEnabled: false, stepDelayMs: 0, executionService: null, localLifecycleEnabled: false,
        sourceChangeService: null, verificationPlanningService: verification, plannedExecutionService: service });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    }
    return { root, data, f, query, identity, get service() { return service; }, async reopen() { await service.shutdown(); await verification.shutdown(); await open(); },
      async input() { return { ...identity, proposalId: approved.id, revision: approved.revision, contractRevision: (await service.list(identity)).capabilities.contractRevision }; },
      async request(suffix = '', body) {
        const route = `http://127.0.0.1:${app.server.address().port}/api/projects/${identity.projectId}/runs/${identity.runId}/development-executions`;
        const response = await fetch(route + suffix, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      },
      async start(recipe) {
        const { projectId, runId, ...request } = await this.input();
        const cap = (await service.list(identity)).capabilities;
        assert.equal(cap.budget.attemptModelCalls, 24); assert.equal(cap.budget.totalModelCalls, null); assert.equal(cap.budget.unlimited, true); assert.equal(cap.budget.taskLimit, 4);
        const body = { ...request, ...(recipe ? { executionRecipeId: recipe } : {}) };
        if (!app) return (await service.start({ projectId, runId, ...body })).execution;
        const result = await this.request('/start', body);
        assert.equal(result.status, 202, JSON.stringify(result.body));
        return result.body.execution;
      },
      async row(id) { return (await service.list(identity)).executions.find(item => item.id === id); }, async done(id) { return until(async () => { const row = await this.row(id); return row && !row.active ? row : null; }); } };
  }
  test('four tasks are reserved once, actual two-way coding/merge completes, full-run cost/history survives two close/reopen downloads', async t => {
    const f = await fixture(t, { priced: true, modular: true }), started = await f.start(), row = await f.done(started.id);
    assert.equal(row.accepted, true, row.error || row.checkpoint.message); assert.equal(row.executionMode, 'task_dag'); assert.equal(row.maxConcurrentTasks, 2); assert.equal(row.tasks.length, 4); assert.ok(row.tasks.every(item => item.status === 'completed'));
    assert.equal(row.totalModelCalls, 8); assert.deepEqual(row.usage, { inputTokens: 20, outputTokens: 28 }); assert.equal(f.f.models, 8);
    assert.equal(f.f.peakCallbacks, 2, 'omitting a recipe retains two active branches');
    assert.equal(row.costEstimate.known, true); assert.equal(row.costEstimate.amount, 0.000224);
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
    let archiveHash, fullZipHash; const before = JSON.stringify(ledger);
    for (let generation = 0; generation < 3; generation++) {
      if (generation) await f.reopen(); const restored = await f.row(started.id); assert.equal(restored.accepted, true, restored.checkpoint.message); assert.equal(restored.checkpoint.restored, generation > 0);
      if (generation) assert.equal((await f.service.list(ids)).capabilities.modelPrices.coding.inputPerMillion, 12);
      assert.deepEqual(restored.reviewHistory, row.reviewHistory);
      const zip = (await f.service.download({ ...ids, executionId: started.id })).buffer, entries = readWebArchiveEntries(zip).entries;
      const history = JSON.parse(entries.get('delivery/task-execution.json').content), summary = JSON.parse(entries.get('delivery/verification.json').content);
      assert.deepEqual(history.tasks.map(task => task.workflowModule), f.data.run.tasks.map(task => task.workflowModule));
      assert.deepEqual(restored.tasks.map(task => task.workflowModule), history.tasks.map(task => task.workflowModule));
      assert.equal(history.tasks.length, 4); assert.equal(history.totalModelCalls, 8); assert.equal(summary.modelCalls.length, 8); assert.deepEqual(summary.usage, { inputTokens: 20, outputTokens: 28 });
      assert.deepEqual(restored.costEstimate, row.costEstimate);
      assert.deepEqual(summary.costEstimate, row.costEstimate);
      assert.deepEqual(summary.modelPrices, row.modelPrices);
      const fullHash = createHash('sha256').update(zip).digest('hex'); if (fullZipHash) assert.equal(fullHash, fullZipHash); fullZipHash = fullHash;
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
  test('the HTTP sequential recipe runs the real Git graph one task at a time and survives a pause checkpoint', async t => {
    const f = await fixture(t, { pause: true, modular: true, http: true });
    const state = await f.request();
    assert.equal(state.status, 200);
    assert.equal(state.body.capabilities.canStart, true);
    assert.equal(state.body.capabilities.defaultExecutionRecipeId, 'parallel');
    assert.deepEqual(state.body.capabilities.executionRecipes.map(({ id, maxConcurrency }) => [id, maxConcurrency]), [['sequential', 1], ['parallel', 2]]);
    const { projectId, runId, ...body } = await f.input();
    await assert.rejects(f.service.start({ ...f.identity, ...body, executionRecipeId: 'unbounded' }), { status: 400, code: 'invalid_execution_recipe' });
    assert.equal((await f.request('/start', { ...body, executionRecipeId: 'unbounded' })).status, 400);
    assert.equal((await f.request('/start', { ...body, executionRecipeId: 'sequential', maxConcurrency: 2 })).status, 400);
    assert.equal(f.query('SELECT * FROM budgets').length, 0);
    assert.equal(f.query('SELECT * FROM executions').length, 0);
    assert.equal(f.f.models, 0);

    const started = await f.start('sequential');
    assert.equal(started.budget.executionRecipeId, 'sequential');
    await until(() => f.f.calls.includes('base'));
    const pause = await f.service.pause({ ...f.identity, executionId: started.id }); assert.equal(pause.execution.status, 'pause_requested'); assert.equal(pause.execution.actions.canResume, true);
    await assert.rejects(f.service.pause({ ...f.identity, executionId: started.id })); f.f.gate.resolve();
    const paused = await until(async () => { const row = await f.row(started.id); return row.status === 'paused' ? row : null; }); assert.equal(paused.active, true); assert.deepEqual(f.f.calls, ['base']);
    await assert.rejects(f.service.withProjectCheckpoint(projectId, () => assert.fail('paused task must hold project checkpoint')));
    const resumed = await f.service.resume({ ...f.identity, executionId: started.id });
    assert.equal(resumed.execution.status, 'running');
    const ended = await f.done(started.id);
    assert.equal(ended.accepted, true, ended.error);
    assert.equal(ended.budget.executionRecipeId, 'sequential');
    assert.equal(ended.maxConcurrentTasks, 1);
    assert.equal(f.f.originalGraph.maxObservedConcurrency, 1);
    assert.equal(f.f.peakCallbacks, 1);
    assert.deepEqual(f.f.calls, ['base', 'alpha', 'beta', 'final']);
    assert.ok(ended.tasks.every(item => item.status === 'completed'));
    const entries = readWebArchiveEntries((await f.service.download({ ...f.identity, executionId: started.id })).buffer).entries;
    assert.equal(entries.get('src/alpha.mjs').content, 'export const alpha=true;\n');
    assert.equal(entries.get('src/beta.mjs').content, 'export const beta=true;\n');
    await assert.rejects(f.service.resume({ ...f.identity, executionId: started.id }));
    assert.equal(f.f.models, 8);
  });
  test('whole-project HTTP never advertises task recipes and rejects one before execution or model reservation', async t => {
    const f = await fixture(t, { wholeProject: true, http: true });
    const state = await f.request();
    assert.equal(state.status, 200);
    assert.equal(state.body.capabilities.canStart, true);
    assert.equal(state.body.capabilities.executionRecipes, undefined);
    assert.equal(state.body.capabilities.defaultExecutionRecipeId, undefined);
    const { projectId, runId, ...body } = await f.input();
    const requested = { ...body, executionRecipeId: 'parallel' };
    await assert.rejects(f.service.start({ projectId, runId, ...requested }), { status: 409, code: 'execution_recipe_unavailable' });
    assert.equal((await f.request('/start', requested)).status, 409);
    assert.equal(f.query('SELECT * FROM budgets').length, 0);
    assert.equal(f.query('SELECT * FROM executions').length, 0);
    assert.equal(f.f.models, 0);
  });
  test('a confirmed but unsupported task graph is explained and rejected before any attempt, reservation, callback or paid request', async t => {
    const f = await fixture(t, { unsupported: true }), state = await f.service.list(ids); assert.equal(state.capabilities.canStart, false); assert.deepEqual(state.capabilities.supportedProposalIds, []); assert.match(state.capabilities.reason, /统一基础/u);
    assert.equal(state.capabilities.executionRecipes, undefined);
    await assert.rejects(f.service.start(await f.input()), { code: 'unsupported_task_graph' }); assert.equal(f.f.models, 0); assert.deepEqual(f.f.calls, []);
    assert.equal(f.query('SELECT * FROM budgets').length, 0); assert.equal(f.query('SELECT * FROM executions').length, 0);
  });
  test('an approved multi-module design with disconnected roots stays inspectable and cannot start coding', async t => {
    const f = await fixture(t, { unsupported: true, modular: true });
    const result = await f.service.list(ids);
    assert.equal(result.capabilities.canStart, false);
    assert.match(result.capabilities.reason, /基础入口/u);
    await assert.rejects(f.service.start(await f.input()), { code: 'unsupported_task_graph' });
    assert.equal(f.f.models, 0);
    assert.equal(f.query('SELECT * FROM executions').length, 0);
    assert.equal(f.query('SELECT * FROM budgets').length, 0);
  });
}
