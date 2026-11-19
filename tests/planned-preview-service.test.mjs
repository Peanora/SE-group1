import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';

// Real controller/SQLite/Git/manifest/original-result brands and private receipts.
// Windows preflight and HTTP/Edge execution are trusted mock infrastructure.
// Model transports are synthetic. No candidate is run and no business acceptance
// is claimed. In particular, isPlannedWebTaskAccepted is NEVER mocked.
// Git normally runs for real. A wrapper delays one Git call or reports an
// explicitly synthetic unknown-result PID to exercise lifecycle boundaries.
const ids = { projectId: 'checkpoint-project', runId: 'checkpoint-run' };
const config = { baseUrl: 'https://checkpoint.synthetic.invalid/v1', model: 'synthetic-checkpoint', apiKey: 'synthetic-checkpoint-private' };
const sourceHash = files => createHash('sha256').update(JSON.stringify(validateProjectFiles(files))).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read, { timeoutMs = 10000, describe = () => 'checkpoint fixture timed out' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await read();
    if (result) return result;
    if (Date.now() >= deadline) assert.fail(describe());
    await new Promise(done => setTimeout(done, 25));
  }
}
function proposal(taskIds) { return { version: 1, id: 'resources', name: 'Resource definition', sessions: [], steps: [{ id: 'read', type: 'request', requirementIds: ['R1'], dependsOn: [], request: { id: 'resources', method: 'GET', path: '/resources', assertions: [{ id: 'status', op: 'status', value: 200 }] } }], browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'resources', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] }, ...(taskIds ? { taskScopes: taskIds.map(taskId => ({ taskId, httpStepIds: ['read'], browserStepIds: ['resources'] })) } : {}) }; }
function planning(graph = false) {
  const source = { filename: 'requirements.md', content: '用户读取资源列表。' }, spec = { title: 'Resources', summary: source.content, goals: ['读取资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回列表'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取', description: source.content, sourceQuote: source.content, acceptance: ['返回资源'] }] };
  const requiredTasks = [{ id: 'implement', title: '实现资源', description: '读取资源', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['接口'], acceptance: ['返回列表'] }];
  if (graph) requiredTasks.push({ id: 'integrate', title: '集成', description: '完整检查资源', requirementIds: ['R1'], dependsOn: ['implement'], writePaths: ['docs/integration.md'], inputs: ['接口'], outputs: ['说明'], acceptance: ['完整返回列表'] });
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { ...ids, specRevision }, proposal: { version: 1, title: 'Resource plan', summary: '读取接口', entities: [], routes: [{ id: 'resources', method: 'GET', path: '/resources', roles: [], request: '无', response: '列表', errors: [], requirementIds: ['R1'] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks: requiredTasks } });
  const run = { id: ids.runId, projectId: ids.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, status: 'succeeded', stages: [], spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '资源结构' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision }; return { project: { id: ids.projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}

if (!process.env.TASKFLOW_PREVIEW_SERVICE_CHILD) {
  test('preview service integrates owned sources and lifecycle with real Git/SQLite and inert execution infrastructure', () => {
    const env = { ...process.env, TASKFLOW_PREVIEW_SERVICE_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) if (/^LLM_/iu.test(key)) delete env[key];
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  let active;
  const nativeRuntime = await import('../lib/web-runtime.mjs');
  const managed = await import('../lib/managed-process.mjs');
  mock.module(new URL('../lib/managed-process.mjs', import.meta.url).href, { namedExports: { ...managed, runProcess: async (...args) => {
    if (args[0] === 'git' && active?.gitGate && !active.gitGate.used) {
      const gate = active.gitGate; gate.used = true; gate.entered.resolve();
      let abort; try { await Promise.race([gate.release.promise, new Promise(resolve => { abort = resolve; args[2]?.signal?.addEventListener('abort', abort, { once: true }); if (args[2]?.signal?.aborted) resolve(); })]); }
      finally { args[2]?.signal?.removeEventListener('abort', abort); }
    }
    if (args[0] === 'git' && active?.gitFault === 'unknown') { active.gitFault = null; return { pid: 999999, exitCode: null, terminationConfirmed: false, stdout: '', stderr: '', stopReason: 'synthetic-unknown-boundary' }; }
    return managed.runProcess(...args);
  } } });
  const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => { active.stats.preflight++; return { kind: 'trusted-external-mock' }; } }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => { active.stats.http++; return { status: 'passed', binding: structuredClone(input.binding), sourceHash: sourceHash(input.files), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash, terminationConfirmed: true, processes: [{ ...stopped, pid: 101 }], checks: input.manifest.checks.map(rule => ({ ...rule, actual: rule.expected ?? rule.name, passed: true })) }; } } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => { active.stats.browser++; return { status: 'passed', binding: structuredClone(input.binding), sourceHash: sourceHash(input.files), manifestHash: input.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, terminationConfirmed: true, browser: { version: 'trusted-external-mock', closed: true }, processes: [{ ...stopped, kind: 'runtime', pid: 201 }, { ...stopped, kind: 'runtime', pid: 202 }, { ...stopped, kind: 'browser', pid: 203 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, actual: rule.expected, passed: true })) }; } } });
  const { createPlannedExecutionService } = await import('../lib/planned-execution-service.mjs');
  const { createVerificationPlanningService } = await import('../lib/verification-planning-service.mjs');
  const { verificationModelPolicy } = await import('../lib/verification-model.mjs');
  const { startPlannedWebExecution, isPlannedWebTaskAccepted } = await import('../lib/planned-web-executor.mjs');
  const { readWebArchiveEntries } = await import('../lib/web-archive.mjs');

  async function fixture(t, options = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'preview-service-')), rootDir = path.join(directory, 'executions'), data = planning(options.graph), services = [];
    const f = active = { directory, rootDir, data, stats: { proposal: 0, code: 0, review: 0, core: 0, preflight: 0, http: 0, browser: 0, checkpoints: 0 }, mode: options.mode ?? 'normal', gate: null, original: null, manifest: null, service: null, verification: null, releases: [] };
    f.database = callback => { const db = new DatabaseSync(path.join(rootDir, 'planned.sqlite')); try { return callback(db); } finally { db.close(); } };
    f.snapshot = () => f.database(db => ({ rows: db.prepare('SELECT * FROM executions ORDER BY id').all(), budgets: db.prepare('SELECT * FROM budgets ORDER BY project_id,run_id').all(), seals: db.prepare('SELECT * FROM accepted_checkpoints ORDER BY execution_id').all() }));
    f.stableSnapshot = () => { const state = f.snapshot(); state.rows = state.rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['owner', 'control', 'updated_at'].includes(key)))); return state; };
    f.openVerification = async () => {
      f.verification = await createVerificationPlanningService({ rootDir: path.join(directory, 'verification'), getPlanning: () => data, getPlanningSync: () => data, config, timeoutMs: 2000, cleanupMs: 30, dependencies: { createModel: () => async input => { f.stats.proposal++; const usage = { inputTokens: 1, outputTokens: 1 }, body = proposal(options.graph ? data.run.tasks.map(task => task.id) : null); await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(body) }); return { proposal: body, usage, model: config.model, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } });
      services.push(f.verification); return f.verification;
    };
    f.open = async (extra = {}) => {
      f.service = await createPlannedExecutionService({ rootDir, verificationService: f.verification, getPlanningSync: () => data, config, executable: process.execPath,
        withCheckpoint: async (_id, work) => { f.stats.checkpoints++; if (f.gate) { const gate = f.gate; gate.entered.resolve(); await gate.release.promise; } return work(); },
        dependencies: {
          startPreviewRuntime: async input => {
            f.stats.preview = (f.stats.preview ?? 0) + 1; f.previewArgs = input;
            if (f.previewGate) await f.previewGate.promise;
            const done = deferred();
            return { url: 'http://localhost:49123', pid: 551122, done: done.promise, stop: async () => {
              f.stats.previewStops = (f.stats.previewStops ?? 0) + 1;
              const result = f.previewMode === 'unknown' ? { ...stopped, status: 'reconciliation_required', terminationConfirmed: false } : { ...stopped };
              done.resolve(result); return result;
            } };
          },
          createProvider: () => async input => { f.stats.code++; const file = JSON.parse(input.task).activeTask?.writePaths[0] ?? 'src/app.mjs'; const body = { files: [{ path: file, content: file === 'src/app.mjs' ? 'export async function createApp(){return {handle:async()=>({status:200,headers:{},body:"resources"})}}\n' : '# Integration fixture\n' }] }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify(body) }); return body; },
          createReviewer: () => async input => { f.stats.review++; const body = { summary: 'Synthetic review for lifecycle only', issues: [], resolutions: [] }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7 }, content: JSON.stringify(body) }); return body; },
          ...(options.graph ? {} : { startExecution: input => { f.stats.core++; f.manifest = input.manifest;
            if (f.mode === 'unknown') { const record = { id: randomUUID(), ...input.binding, status: 'reconciliation_required', terminationConfirmed: false, totalModelCalls: 2, modelCalls: [{ role: 'coding', kind: 'model', dispatched: true }, { role: 'review', kind: 'model', dispatched: true }] }; return { id: record.id, snapshot: () => structuredClone(record), cancel: () => {}, done: Promise.resolve(record) }; }
            const handle = startPlannedWebExecution(input); const done = handle.done.then(record => { f.original = record; return f.mode === 'clone' ? structuredClone(record) : record; }); return { ...handle, done };
          } }) }, ...extra }); services.push(f.service); return f.service;
    };
    f.reopen = async ({ both = true, extra = {} } = {}) => { await f.service.shutdown(); if (both) { await f.verification.shutdown(); await f.openVerification(); } return f.open(extra); };
    f.input = async () => ({ ...ids, proposalId: f.proposal.id, revision: f.proposal.revision, contractRevision: (await f.service.list(ids)).capabilities.contractRevision });
    f.start = async () => {
      const started = await f.service.start(await f.input());
      let row;
      return until(async () => {
        const state = await f.service.list(ids);
        row = state.executions.find(item => item.id === started.execution.id);
        return row && ['accepted', 'failed', 'stopped', 'timed_out', 'reconciliation_required'].includes(row.status)
          && (row.status === 'reconciliation_required' || !row.active) && { state, row };
      }, {
        timeoutMs: options.graph ? 25000 : 10000,
        describe: () => `development fixture timed out: ${JSON.stringify({
          status: row?.status, active: row?.active, error: row?.error,
          tasks: row?.tasks?.map(item => [item.id, item.status, item.errorCode]), stats: f.stats
        })}`
      });
    };
    f.hold = () => { const gate = f.gate = { entered: deferred(), release: deferred() }; f.releases.push(() => gate.release.resolve()); return gate; };
    f.holdGit = () => { const gate = f.gitGate = { entered: deferred(), release: deferred(), used: false }; f.releases.push(() => gate.release.resolve()); return gate; };
    t.after(async () => { for (const release of f.releases) release(); f.gate = null; for (const service of services.reverse()) await service.shutdown(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('preview-service-')); await rm(directory, { recursive: true, force: true }); });
    await f.openVerification(); const candidate = (await f.verification.propose({ ...ids, contractRevision: (await f.verification.list(ids)).capabilities.contractRevision })).proposal;
    const draft = await until(async () => (await f.verification.list(ids)).proposals.find(row => row.id === candidate.id && row.status === 'draft'));
    f.proposal = (await f.verification.approve({ ...ids, proposalId: draft.id, revision: draft.revision, feedback: 'Only a controlled lifecycle fixture, not software accepted.' })).proposal;
    await f.open(); return f;
  }

  test('accepted preview uses copied source, reserves the shared project slot, and adds no model calls', async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id }, budget = f.snapshot().budgets;
    const result = await f.service.preview(identity);
    assert.equal(result.preview.state, 'running'); assert.equal(result.execution.preview.url, 'http://localhost:49123');
    assert.notEqual(f.previewArgs.workspace, f.original.workspace); assert.equal(f.stats.preview, 1);
    assert.equal(result.execution.actions.canDownload, false); assert.equal(result.execution.actions.canPreview, false);
    await assert.rejects(f.service.preview(identity), e => e.status === 409);
    await assert.rejects(f.service.start(await f.input()), e => e.status === 409);
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('must not publish or delete')), e => e.status === 409);
    await assert.rejects(f.service.download(identity), e => e.status === 409);
    const commands = result.execution.commands; assert.ok(commands.length > 0);
    const publicData = JSON.stringify(result); for (const forbidden of [f.directory, config.apiKey, 'receiptPath', '551122']) assert.equal(publicData.includes(forbidden), false);
    const stoppedResult = await f.service.stopPreview(identity); assert.equal(stoppedResult.preview.state, 'stopped');
    assert.equal(stoppedResult.execution.actions.canDownload, true); assert.equal(stoppedResult.execution.actions.canPreview, true);
    assert.deepEqual(f.snapshot().budgets, budget); assert.equal(f.stats.code, 1); assert.equal(f.stats.review, 1); assert.equal(f.stats.previewStops, 1);
  });
  test('source changes cannot start a preview or retain a current download qualification', async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id };
    await writeFile(path.join(f.original.workspace, 'src/app.mjs'), 'changed\n');
    await assert.rejects(f.service.preview(identity), e => e.status === 409); assert.equal(f.stats.preview ?? 0, 0);
    const after = (await f.service.list(ids)).executions[0]; assert.equal(after.preview.url, null); assert.equal(after.accepted, false); assert.equal(after.actions.canDownload, false);
  });
  test('authorization revoked during runtime startup stops it before a URL is published', async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id }; let authorized = true;
    const gate = f.previewGate = deferred(), starting = f.service.preview(identity, { assertAccess: () => authorized }); starting.catch(() => {});
    await until(() => f.stats.preview === 1); authorized = false; gate.resolve();
    await assert.rejects(starting, e => e.status === 409); assert.equal(f.stats.previewStops, 1);
    assert.equal((await f.service.list(ids)).executions[0].preview.url, null);
    assert.equal((await f.service.list(ids)).capabilities.canStart, true);
  });
  test('unknown preview stop survives restart and blocks source publication and further execution', async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id }; f.previewMode = 'unknown';
    await f.service.preview(identity); const result = await f.service.stopPreview(identity); assert.equal(result.preview.state, 'reconciliation_required');
    const budget = f.snapshot().budgets; await f.reopen();
    const state = await f.service.list(ids), current = state.executions[0];
    assert.equal(current.preview.state, 'reconciliation_required'); assert.equal(current.preview.url, null);
    assert.equal(state.capabilities.canStart, false); assert.equal(current.actions.canDownload, false); assert.equal(current.actions.canPreview, false); assert.equal(current.actions.canStopPreview, false);
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('unknown remains busy')), e => e.status === 409);
    await assert.rejects(f.service.stopPreview(identity), e => e.status === 409); assert.deepEqual(f.snapshot().budgets, budget);
  });
  test('original history restores preview eligibility after restart without another model request', async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id };
    await f.reopen(); const restored = (await f.service.list(ids)).executions[0]; assert.equal(restored.checkpoint.restored, true);
    const result = await f.service.preview(identity); assert.equal(result.preview.state, 'running');
    await f.service.stopPreview(identity); assert.equal(f.stats.code, 1); assert.equal(f.stats.review, 1);
  });
  test('role revocation after startup unpublishes the URL immediately and confirms stop', async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id }; let authorized = true;
    await f.service.preview(identity, { assertAccess: () => authorized }); authorized = false;
    const after = (await f.service.list(ids)).executions[0]; assert.equal(after.preview.url, null);
    await until(() => f.stats.previewStops === 1); await until(async () => (await f.service.list(ids)).executions[0].preview.state === 'stopped');
    assert.equal((await f.service.list(ids)).capabilities.canStart, true); assert.equal(f.stats.code, 1);
  });
  test('unknown source verifier stop holds the project before any preview runtime dispatch', async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id }; f.gitFault = 'unknown';
    await assert.rejects(f.service.preview(identity)); assert.equal(f.stats.preview ?? 0, 0);
    const state = await f.service.list(ids); assert.equal(state.executions[0].preview.state, 'reconciliation_required');
    assert.equal(state.capabilities.canStart, false); assert.equal(state.executions[0].actions.canDownload, false);
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('unknown verifier still owns activity')), e => e.status === 409);
  });
  test('full task graph delivery can be previewed from its original final source without inheriting a child verdict', async t => {
    const f = await fixture(t, { graph: true }), { row } = await f.start(); assert.equal(row.executionMode, 'task_dag'); assert.equal(row.accepted, true,
      JSON.stringify({ status: row.status, current: row.current, active: row.active, error: row.error, checkpoint: row.checkpoint, tasks: row.tasks.map(task => ({ id: task.id, status: task.status, errorCode: task.errorCode })), code: f.stats.code, review: f.stats.review }));
    const identity = { ...ids, executionId: row.id }, budget = f.snapshot().budgets;
    const result = await f.service.preview(identity); assert.equal(result.preview.state, 'running');
    assert.equal(result.execution.tasks.length, 2); assert.equal(result.execution.totalModelCalls, 4); await f.service.stopPreview(identity); assert.deepEqual(f.snapshot().budgets, budget);
  });
  test('actual isolated preview runtime starts and stops through the service with no new model request', { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1' || !process.env.EXECUTION_SANDBOX_EXE }, async t => {
    const f = await fixture(t), { row } = await f.start(), identity = { ...ids, executionId: row.id }, budget = f.snapshot().budgets;
    await f.service.shutdown();
    await f.open({ executable: process.env.EXECUTION_SANDBOX_EXE, dependencies: { startPreviewRuntime: nativeRuntime.startWebRuntime } });
    await f.service.list(ids); const result = await f.service.preview(identity); assert.equal(result.preview.state, 'running');
    const response = await fetch(result.preview.url); assert.equal(response.status, 200); assert.equal(await response.text(), 'resources');
    assert.equal((await f.service.stopPreview(identity)).preview.state, 'stopped'); await assert.rejects(fetch(result.preview.url)); assert.deepEqual(f.snapshot().budgets, budget);
    assert.equal(f.stats.code, 1); assert.equal(f.stats.review, 1);
  });
}
