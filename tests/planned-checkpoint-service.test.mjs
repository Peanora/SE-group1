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
// A real Git candidate can take over 10s under concurrent local browser/Git load.
async function until(read) { const end = Date.now() + 30000; for (;;) { const result = await read(); if (result) return result; assert.ok(Date.now() < end, 'checkpoint fixture timed out'); await new Promise(done => setTimeout(done, 5)); } }
function proposal() { return { version: 1, id: 'resources', name: 'Resource definition', sessions: [], steps: [{ id: 'read', type: 'request', requirementIds: ['R1'], dependsOn: [], request: { id: 'resources', method: 'GET', path: '/resources', assertions: [{ id: 'status', op: 'status', value: 200 }] } }], browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'resources', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } }; }
function planning() {
  const source = { filename: 'requirements.md', content: '用户读取资源列表。' }, spec = { title: 'Resources', summary: source.content, goals: ['读取资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回列表'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取', description: source.content, sourceQuote: source.content, acceptance: ['返回资源'] }] };
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { ...ids, specRevision }, proposal: { version: 1, title: 'Resource plan', summary: '读取接口', entities: [], routes: [{ id: 'resources', method: 'GET', path: '/resources', roles: [], request: '无', response: '列表', errors: [], requirementIds: ['R1'] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks: [{ id: 'implement', title: '实现资源', description: '读取资源', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['接口'], acceptance: ['返回列表'] }] } });
  const run = { id: ids.runId, projectId: ids.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, status: 'succeeded', stages: [], spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '资源结构' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision }; return { project: { id: ids.projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}

if (!process.env.TASKFLOW_CHECKPOINT_SERVICE_CHILD) {
  test('checkpoint service integration preserves real original brands and SQLite/Git while mocking external execution only', () => {
    const env = { ...process.env, TASKFLOW_CHECKPOINT_SERVICE_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) if (/^LLM_/iu.test(key)) delete env[key];
    // This limit covers the whole real Git/recovery suite, not a business SLA.
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', import.meta.filename], { env, encoding: 'utf8', timeout: 300000, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  let active;
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
    const directory = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-service-')), rootDir = path.join(directory, 'executions'), data = planning(), services = [];
    const f = active = { directory, rootDir, data, stats: { proposal: 0, code: 0, review: 0, core: 0, preflight: 0, http: 0, browser: 0, checkpoints: 0 }, mode: options.mode ?? 'normal', gate: null, original: null, manifest: null, service: null, verification: null, releases: [] };
    f.database = callback => { const db = new DatabaseSync(path.join(rootDir, 'planned.sqlite')); try { return callback(db); } finally { db.close(); } };
    f.snapshot = () => f.database(db => ({ rows: db.prepare('SELECT * FROM executions ORDER BY id').all(), budgets: db.prepare('SELECT * FROM budgets ORDER BY project_id,run_id').all(), seals: db.prepare('SELECT * FROM accepted_checkpoints ORDER BY execution_id').all() }));
    f.stableSnapshot = () => { const state = f.snapshot(); state.rows = state.rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['owner', 'control', 'updated_at'].includes(key)))); return state; };
    f.openVerification = async () => {
      f.verification = await createVerificationPlanningService({ rootDir: path.join(directory, 'verification'), getPlanning: () => data, getPlanningSync: () => data, config, timeoutMs: 2000, cleanupMs: 30, dependencies: { createModel: () => async input => { f.stats.proposal++; const usage = { inputTokens: 1, outputTokens: 1 }, body = proposal(); await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(body) }); return { proposal: body, usage, model: config.model, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } });
      services.push(f.verification); return f.verification;
    };
    f.open = async (extra = {}) => {
      f.service = await createPlannedExecutionService({ rootDir, verificationService: f.verification, getPlanningSync: () => data, config, executable: process.execPath,
        withCheckpoint: async (_id, work) => { f.stats.checkpoints++; if (f.gate) { const gate = f.gate; gate.entered.resolve(); await gate.release.promise; } return work(); },
        dependencies: { createProvider: () => async input => { f.stats.code++; const body = { files: [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle:async()=>({status:200,headers:{},body:"resources"})}}\n' }] }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify(body) }); return body; },
          createReviewer: () => async input => { f.stats.review++; const body = { summary: 'Synthetic review for lifecycle only', issues: [], resolutions: [] }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7 }, content: JSON.stringify(body) }); return body; },
          startExecution: input => { f.stats.core++; f.manifest = input.manifest;
            if (f.mode === 'unknown') { const record = { id: randomUUID(), ...input.binding, status: 'reconciliation_required', terminationConfirmed: false, totalModelCalls: 2, modelCalls: [{ role: 'coding', kind: 'model', dispatched: true }, { role: 'review', kind: 'model', dispatched: true }] }; return { id: record.id, snapshot: () => structuredClone(record), cancel: () => {}, done: Promise.resolve(record) }; }
            const handle = startPlannedWebExecution(input); const done = handle.done.then(record => { f.original = record; return f.mode === 'clone' ? structuredClone(record) : record; }); return { ...handle, done };
          } }, ...extra }); services.push(f.service); return f.service;
    };
    f.reopen = async ({ both = true, extra = {} } = {}) => { await f.service.shutdown(); if (both) { await f.verification.shutdown(); await f.openVerification(); } return f.open(extra); };
    f.input = async () => ({ ...ids, proposalId: f.proposal.id, revision: f.proposal.revision, contractRevision: (await f.service.list(ids)).capabilities.contractRevision });
    f.start = async () => { const started = await f.service.start(await f.input()); return until(async () => { const state = await f.service.list(ids), row = state.executions.find(item => item.id === started.execution.id); return row && !['reserved', 'preparing', 'checking_environment', 'generating', 'self_check', 'validating'].includes(row.status) && { state, row }; }); };
    f.hold = () => { const gate = f.gate = { entered: deferred(), release: deferred() }; f.releases.push(() => gate.release.resolve()); return gate; };
    f.holdGit = () => { const gate = f.gitGate = { entered: deferred(), release: deferred(), used: false }; f.releases.push(() => gate.release.resolve()); return gate; };
    t.after(async () => { for (const release of f.releases) release(); f.gate = null; for (const service of services.reverse()) await service.shutdown(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('checkpoint-service-')); await rm(directory, { recursive: true, force: true }); });
    await f.openVerification(); const candidate = (await f.verification.propose({ ...ids, contractRevision: (await f.verification.list(ids)).capabilities.contractRevision })).proposal;
    const draft = await until(async () => (await f.verification.list(ids)).proposals.find(row => row.id === candidate.id && row.status === 'draft'));
    f.proposal = (await f.verification.approve({ ...ids, proposalId: draft.id, revision: draft.revision, feedback: 'Only a controlled lifecycle fixture, not software accepted.' })).proposal;
    await f.open(); return f;
  }

  test('an original fully checked capability seals and atomically settles exactly two synthetic calls', async t => {
    const f = await fixture(t), { row } = await f.start(); assert.equal(row.status, 'accepted'); assert.equal(isPlannedWebTaskAccepted(f.original, f.manifest), true);
    const stored = f.snapshot(); assert.equal(stored.rows[0].status, 'accepted'); assert.equal(stored.rows[0].active, 0); assert.equal(stored.seals.length, 1);
    assert.equal(stored.budgets[0].attempts, 1); assert.equal(stored.budgets[0].used_calls, 2); assert.equal(stored.budgets[0].reserved_calls, 0);
    const publicData = JSON.stringify(await f.service.list(ids)); for (const forbidden of [f.directory, config.apiKey, 'signature', 'recordHash', '.accepted-checkpoint.key', 'receiptPath']) assert.equal(publicData.includes(forbidden), false);
  });

  test('a real branded result restores same-version download after two restarts with zero new work or budget mutation', async t => {
    const f = await fixture(t), { row } = await f.start(), before = f.stableSnapshot(), work = { ...f.stats };
    const originalArchive = (await f.service.download({ ...ids, executionId: row.id })).buffer;
    for (let index = 0; index < 2; index++) {
      await f.reopen(); const state = await f.service.list(ids), restored = state.executions.find(item => item.id === row.id);
      assert.equal(restored.accepted, true); assert.equal(restored.checkpoint.restored, true); assert.equal(restored.actions.canDownload, true);
      const zip = await f.service.download({ ...ids, executionId: row.id }), { entries } = readWebArchiveEntries(zip.buffer), summary = JSON.parse(entries.get('delivery/verification.json').content);
      assert.equal(Object.hasOwn(summary, 'restoredHistoricalDelivery'), false); assert.equal(summary.binding.candidateCommit, f.original.candidateCommit);
      assert.deepEqual(zip.buffer, originalArchive, 'recovery state must not change the historical delivery package bytes');
      assert.equal(entries.get('src/app.mjs').content, 'export async function createApp(){return {handle:async()=>({status:200,headers:{},body:"resources"})}}\n');
      assert.equal(isPlannedWebTaskAccepted(JSON.parse(before.rows[0].record), f.manifest), false, 'recovery cannot reconstruct the original result brand');
      assert.deepEqual(f.stableSnapshot(), before); for (const role of ['proposal', 'code', 'review', 'core', 'preflight', 'http', 'browser']) assert.equal(f.stats[role], work[role]);
    }
  });

  test('a cloned accepted-looking JSON result cannot be sealed, including after restart', async t => {
    const f = await fixture(t, { mode: 'clone' }), { row } = await f.start(); assert.equal(row.status, 'failed'); assert.equal(row.actions.canDownload, false); assert.equal(f.snapshot().seals.length, 0);
    await f.reopen(); assert.equal((await f.service.list(ids)).executions[0].accepted, false); await assert.rejects(f.service.download({ ...ids, executionId: row.id }));
  });

  test('old accepted JSON without a seal stays historical and does not get silently re-signed', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.service.shutdown(); f.database(db => db.prepare('DELETE FROM accepted_checkpoints').run()); const before = f.snapshot();
    await f.reopen(); assert.equal((await f.service.list(ids)).executions[0].actions.canDownload, false); await assert.rejects(f.service.download({ ...ids, executionId: row.id })); assert.deepEqual(f.snapshot(), before);
  });

  for (const mode of ['record', 'seal', 'row-id', 'budget', 'source', 'receipt', 'report', 'key']) test(`recovery rejects changed ${mode} without new model work or ledger changes`, async t => {
    const f = await fixture(t), { row } = await f.start(); await f.service.shutdown();
    if (mode === 'record') f.database(db => { const saved = JSON.parse(db.prepare('SELECT record FROM executions').get().record); saved.usage.inputTokens++; db.prepare('UPDATE executions SET record=?').run(JSON.stringify(saved)); });
    if (mode === 'seal') f.database(db => { const seal = JSON.parse(db.prepare('SELECT seal FROM accepted_checkpoints').get().seal); seal.signature = '0'.repeat(64); db.prepare('UPDATE accepted_checkpoints SET seal=?').run(JSON.stringify(seal)); });
    if (mode === 'row-id') f.database(db => { db.prepare('UPDATE executions SET id=?').run('foreign-row'); db.prepare('UPDATE accepted_checkpoints SET execution_id=?').run('foreign-row'); });
    if (mode === 'budget') f.database(db => { const budget = JSON.parse(db.prepare('SELECT budget FROM executions').get().budget); budget.maxCalls++; db.prepare('UPDATE executions SET budget=?').run(JSON.stringify(budget)); });
    if (mode === 'source') await writeFile(path.join(f.original.workspace, 'src/app.mjs'), '// external source change\n');
    if (mode === 'receipt') await writeFile(f.original.modelCalls[0].receiptPath, '{}');
    if (mode === 'report') { const report = JSON.parse(await readFile(f.original.reportPath)); report.totalModelCalls++; await writeFile(f.original.reportPath, JSON.stringify(report)); }
    if (mode === 'key') await rm(path.join(f.rootDir, '.accepted-checkpoint.key'));
    const before = f.stableSnapshot(), calls = { ...f.stats }; await f.reopen();
    const state = await f.service.list(ids); assert.equal(state.executions[0].accepted, false); assert.equal(state.executions[0].actions.canDownload, false);
    await assert.rejects(f.service.download({ ...ids, executionId: mode === 'row-id' ? 'foreign-row' : row.id })); assert.deepEqual(f.stableSnapshot(), before);
    for (const role of ['proposal', 'code', 'review', 'core']) assert.equal(f.stats[role], calls[role]);
  });

  test('changed current approval blocks a valid seal and the old version cannot be granted a download', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.service.shutdown(); f.data.run.approvals.plan = null; const before = f.snapshot(); await f.reopen();
    assert.equal((await f.service.list(ids)).executions[0].actions.canDownload, false); await assert.rejects(f.service.download({ ...ids, executionId: row.id })); assert.deepEqual(f.snapshot(), before);
  });

  test('failed seal persistence rolls back accepted and settlement atomically rather than publishing an unsealed pass', async t => {
    const f = await fixture(t); f.database(db => db.exec("CREATE TRIGGER block_seal BEFORE INSERT ON accepted_checkpoints BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"));
    const { row } = await f.start(), stored = f.snapshot(); assert.notEqual(row.status, 'accepted'); assert.equal(row.actions.canDownload, false); assert.equal(stored.seals.length, 0);
    assert.equal(stored.budgets[0].used_calls + stored.budgets[0].reserved_calls, 2, 'actual two calls must settle exactly once or remain reserved if unknown');
  });

  test('unknown in-flight records retain their active slot and six-call reservation through restart', async t => {
    const f = await fixture(t, { mode: 'unknown' }), { row } = await f.start(); assert.equal(row.status, 'reconciliation_required'); const before = f.snapshot();
    assert.equal(before.budgets[0].reserved_calls, 6); assert.equal(before.seals.length, 0); await f.reopen();
    const state = await f.service.list(ids); assert.equal(state.executions[0].status, 'reconciliation_required'); assert.equal(state.executions[0].active, true); assert.equal(state.capabilities.canStart, false);
    assert.deepEqual(f.snapshot().budgets, before.budgets); assert.equal(f.snapshot().seals.length, 0);
  });

  test('one restoring audit holds a durable slot and concurrent download fails closed until completion', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.reopen(); const before = f.stableSnapshot(), checkpointCount = f.stats.checkpoints, gate = f.holdGit();
    const one = f.service.list(ids); await gate.entered.promise;
    const pending = f.snapshot(); assert.equal(pending.rows[0].status, 'restoring_delivery'); assert.equal(pending.rows[0].active, 1); assert.deepEqual(pending.budgets, before.budgets);
    const two = assert.rejects(f.service.download({ ...ids, executionId: row.id }), error => error.status === 409);
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true)); await assert.rejects(f.service.start({ ...ids, proposalId: f.proposal.id, revision: f.proposal.revision, contractRevision: 'a'.repeat(64) }));
    f.gitGate = null; gate.release.resolve(); await one; await two; assert.ok((await f.service.download({ ...ids, executionId: row.id })).buffer.length > 0); assert.equal(f.stats.checkpoints, checkpointCount + 1); assert.deepEqual(f.stableSnapshot(), before);
  });

  test('unconfirmed Git boundary retains process metadata and active slot without changing the settled budget', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.reopen(); const before = f.snapshot(); f.gitFault = 'unknown';
    const state = await f.service.list(ids), view = state.executions[0]; assert.equal(view.status, 'reconciliation_required'); assert.equal(view.active, true); assert.equal(view.actions.canDownload, false); assert.equal(state.capabilities.canStart, false);
    const pending = f.snapshot(); assert.deepEqual(pending.budgets, before.budgets);
    const observation = f.database(db => db.prepare('SELECT * FROM checkpoint_restorations').get()); assert.equal(observation.status, 'reconciliation_required'); assert.equal(JSON.parse(observation.details).process.pid, 999999);
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true)); await assert.rejects(f.service.download({ ...ids, executionId: row.id }));
    await f.reopen(); assert.equal((await f.service.list(ids)).capabilities.canStart, false); assert.deepEqual(f.snapshot().budgets, before.budgets);
  });

  test('a failed source audit is not replayed by identical polling or downloads during the same boot', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.reopen(); await writeFile(path.join(f.original.workspace, 'src/app.mjs'), '// altered\n');
    assert.equal((await f.service.list(ids)).executions[0].accepted, false); const checkpoints = f.stats.checkpoints, before = f.stableSnapshot();
    for (let index = 0; index < 3; index++) { assert.equal((await f.service.list(ids)).executions[0].accepted, false); await assert.rejects(f.service.download({ ...ids, executionId: row.id })); }
    assert.equal(f.stats.checkpoints, checkpoints); assert.deepEqual(f.stableSnapshot(), before);
  });

  test('losing the private key after restoration immediately withdraws download authority', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.reopen(); assert.equal((await f.service.list(ids)).executions[0].actions.canDownload, true);
    await rm(path.join(f.rootDir, '.accepted-checkpoint.key')); const before = f.stableSnapshot();
    const state = await f.service.list(ids); assert.equal(state.executions[0].actions.canDownload, false); assert.equal(state.capabilities.canStart, false); await assert.rejects(f.service.download({ ...ids, executionId: row.id })); assert.deepEqual(f.stableSnapshot(), before);
  });

  test('an interrupted persisted restoration keeps its slot and seal but never automatically resumes delivery', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.service.shutdown();
    f.database(db => { db.prepare("UPDATE executions SET status='restoring_delivery',active=1,control=control+1").run(); db.prepare("INSERT INTO checkpoint_restorations VALUES(?,'checking','{}',?)").run(row.id, new Date().toISOString()); });
    const budget = f.snapshot().budgets; await f.reopen(); const state = await f.service.list(ids), view = state.executions[0];
    assert.equal(view.status, 'reconciliation_required'); assert.equal(view.active, true); assert.equal(view.checkpoint.sealed, true); assert.equal(view.checkpoint.restored, false); assert.equal(view.actions.canDownload, false); assert.equal(state.capabilities.canStart, false);
    await assert.rejects(f.service.download({ ...ids, executionId: row.id })); await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true)); assert.deepEqual(f.snapshot().budgets, budget);
  });

  test('approval invalidation while Git is pending prevents publication of an otherwise valid restored delivery', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.reopen(); const budget = f.snapshot().budgets, gate = f.holdGit();
    const reading = f.service.list(ids); await gate.entered.promise; f.data.run.approvals.plan = null; gate.release.resolve(); await reading;
    assert.equal((await f.service.list(ids)).executions[0].actions.canDownload, false); await assert.rejects(f.service.download({ ...ids, executionId: row.id })); assert.deepEqual(f.snapshot().budgets, budget);
  });

  test('close during source restoration denies a late publish and a new controller can independently recover', async t => {
    const f = await fixture(t), { row } = await f.start(); await f.reopen(); const gate = f.holdGit(), reading = f.service.list(ids); const rejected = assert.rejects(reading); await gate.entered.promise;
    await f.service.shutdown(); f.gitGate = null; gate.release.resolve(); await rejected; await f.reopen();
    const state = await f.service.list(ids); assert.equal(state.executions[0].actions.canDownload, true); assert.equal((await f.service.download({ ...ids, executionId: row.id })).buffer.length > 0, true);
  });
}
