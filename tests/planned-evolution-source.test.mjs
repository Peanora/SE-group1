import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspectPlannedSource, assertPlannedSource } from '../lib/planned-source.mjs';
import { createPlannedEvolutionSeed, assertPlannedEvolutionSeed, describePlannedEvolutionSeed, revokePlannedEvolutionSeed } from '../lib/planned-evolution-source.mjs';
import { createMigrationControl, compileMigrationPlan } from '../lib/planned-migration-contract.mjs';
import { createPlannedDatasetService } from '../lib/planned-dataset.mjs';
import { inspectVerificationTasks } from '../lib/verification-task-scopes.mjs';
import { installWebShell, getWebShellFiles } from '../lib/web-delivery.mjs';
import { applyProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';
import { startWebRuntime } from '../lib/web-runtime.mjs';
import { minimalEnv } from '../lib/managed-process.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceHash = files => hash(validateProjectFiles(files)), A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const native = process.platform === 'win32' && !!process.env.EXECUTION_SANDBOX_EXE && process.env.TASKFLOW_EXECUTION_NATIVE_TESTS === '1';
const oldBinding = { projectId: 'evolution-project', specRevision: A, planRevision: B }, retainedPaths = ['public/app.js', 'src/app.mjs'];
const requirements = ['R1'], tasks = [{ id: 'NEW_APP', title: '新需求业务规则', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'] }, { id: 'NEW_FINAL', title: '新版本页面与完整回归', requirementIds: ['R1'], dependsOn: ['NEW_APP'], writePaths: ['public/app.js'] }];
const approvedTaskSetHash = inspectVerificationTasks(tasks, requirements).taskSetHash, none = { version: 1, kind: 'none', operations: [] };

test('evolution source API rejects missing or executable getter options before touching a workspace', async () => {
  await assert.rejects(createPlannedEvolutionSeed({})); let invoked = 0; const raw = {}; Object.defineProperty(raw, 'sourceHandle', { enumerable: true, get() { invoked++; return {}; } }); await assert.rejects(createPlannedEvolutionSeed(raw)); assert.equal(invoked, 0);
  for (const fake of [{ kind: 'owned_planned_evolution_seed', id: 'x' }, null]) { await assert.rejects(describePlannedEvolutionSeed(fake)); await assert.rejects(assertPlannedEvolutionSeed(fake, {})); assert.throws(() => revokePlannedEvolutionSeed(fake)); }
});

// Git and the stopped SQLite runtime/backup worker are real. Model receipts are
// explicit synthetic fixtures: no provider, network key or paid request is used.
test('source-only evolution keeps two real bindings, all costs and blockers, and rejects live authority races', { skip: !native, timeout: 180000 }, async t => {
  const base = path.resolve('output/planned-evolution-source-author'); await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'case-')), sourceRootDir = path.join(directory, 'sources'); await mkdir(sourceRootDir);
  const logs = [], originalArtifacts = new Map();
  async function candidate({ parent, name, rejected = false, blocker = false }) {
    const dir = path.join(sourceRootDir, `planned-web-${name}`), workspace = path.join(dir, 'workspace'); await mkdir(workspace, { recursive: true }); const shell = await installWebShell({ workspace }); await mkdir(path.join(workspace, '.platform'), { recursive: true }); await writeFile(path.join(workspace, '.platform/gitconfig'), '');
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Evolution source fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: workspace, windowsHide: true, encoding: 'utf8', env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform/gitconfig'), GIT_TERMINAL_PROMPT: '0' } }).trim();
    if (parent) await applyProjectFiles({ workspace, files: parent.data.files }); git(['init', '--quiet']); git(['add', '--', '.']); git(['commit', '--quiet', '-m', 'protected base']); const baseCommit = git(['rev-parse', 'HEAD']);
    const app = `import {DatabaseSync} from 'node:sqlite';export async function createApp({databasePath}){const db=new DatabaseSync(databasePath);db.exec("CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY,owner TEXT,value TEXT);INSERT OR IGNORE INTO items VALUES(1,'alice','retained'),(2,'bob','also retained')");return{handle:async()=>({status:200,headers:{'content-type':'application/json'},body:JSON.stringify({version:'${name}',rows:db.prepare('SELECT * FROM items ORDER BY id').all()})}),close:()=>db.close()}}\n`;
    const files = validateProjectFiles([{ path: 'src/app.mjs', content: app }, { path: 'public/app.js', content: `export const version='${name}';\n` }]); await applyProjectFiles({ workspace, files }); git(['add', '--', ...retainedPaths]); git(['commit', '--quiet', '-m', 'synthetic source candidate']); const commit = git(['rev-parse', 'HEAD']);
    const identity = { id: `execution-${name}`, ...oldBinding, runId: `run-${name}`, taskId: 'whole', attemptId: randomUUID(), manifestHash: C }, modelCalls = [];
    async function receipt(role, attempt, content, usage, finishReason = 'stop') {
      const receiptPath = path.join(dir, `model-${role}-${attempt}.json`), raw = JSON.stringify({ model: `synthetic-${role}`, finishReason, usage, content }); await writeFile(receiptPath, raw); originalArtifacts.set(receiptPath, hash(raw));
      modelCalls.push({ id: randomUUID(), role, kind: 'model', attempt, ...Object.fromEntries(['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'manifestHash'].map(key => [key, identity[key]])), candidateCommit: role === 'review' ? commit : null, inputSourceHash: role === 'review' ? sourceHash(files) : sourceHash(parent?.data.files ?? []), usage, model: `synthetic-${role}`, finishReason, receiptConfirmed: true, receiptPath, receiptHash: hash(raw) });
    }
    if (rejected) await receipt('coding', 1, '{"files":[broken JSON and CSS}', { inputTokens: null, outputTokens: 4 });
    await receipt('coding', rejected ? 2 : 1, JSON.stringify({ files }), rejected ? { inputTokens: 2, outputTokens: 3 } : { inputTokens: 1, outputTokens: 1 });
    const nativeIssue = { severity: 'blocking', file: 'src/app.mjs', line: 1, message: '历史所有者隔离必须重验', evidence: files.find(file => file.path === 'src/app.mjs').content.trim() }, issue = { ...nativeIssue, id: `ISSUE-${hash({ ...nativeIssue, commit }).slice(0, 20)}`, status: 'open', originCommit: commit };
    const review = { summary: 'synthetic historical Review', issues: blocker ? [nativeIssue] : [], resolutions: [] };
    await receipt('review', 1, rejected ? 'incomplete Review' : JSON.stringify(review), { inputTokens: 1, outputTokens: 1 }, rejected ? 'length' : 'stop');
    const record = { ...identity, profileId: 'planned-web-v1', providerKind: 'model', reviewerKind: 'model', status: 'failed', terminationConfirmed: true, workspace, baseCommit, candidateCommit: commit, shellHash: shell.hash, totalModelCalls: modelCalls.length, modelCalls,
      versions: [{ attempt: rejected ? 2 : 1, commit, sourceHash: sourceHash(files), selfCheck: { status: 'failed', checks: [{ id: 'old-self', passed: false }] }, acceptance: rejected ? null : { binding: { ...identity, candidateCommit: commit, sourceHash: sourceHash(files) }, status: 'changes_requested', issues: blocker ? [issue] : [], review: { ...review, status: 'completed', openBlockingIssues: blocker ? 1 : 0 } } }], ...(parent ? { initialSource: parent.data.provenance } : {}) };
    const reportPath = path.join(dir, 'execution.json'); await writeFile(reportPath, JSON.stringify(record)); originalArtifacts.set(reportPath, hash(await readFile(reportPath)));
    const handle = await inspectPlannedSource({ rootDir: sourceRootDir, reportPath, binding: oldBinding, writablePaths: retainedPaths }), data = assertPlannedSource(handle, oldBinding, retainedPaths); return { workspace, record, reportPath, handle, data, issue, git };
  }
  const parent = await candidate({ name: 'old-parent', blocker: true }), source = await candidate({ parent, name: 'old-child', rejected: true });
  const runtime = await startWebRuntime({ workspace: source.workspace, timeoutMs: 30000 }); let stop;
  try { const response = await runtime.request({ method: 'GET', path: '/', headers: {}, body: '' }); assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).rows.length, 2); } finally { stop = await runtime.stop(); }
  assert.equal(stop.terminationConfirmed, true); assert.equal(stop.stopAcknowledged, true); assert.equal(stop.sourceUnchanged, true);
  const dbPath = path.join(source.workspace, '.platform/tmp/app.sqlite'), originalDatabase = await readFile(dbPath), originalSourceFiles = await Promise.all(source.data.files.map(async file => [file.path, hash(await readFile(path.join(source.workspace, file.path)))]));
  const originBinding = { projectId: oldBinding.projectId, runId: source.record.runId, executionId: source.record.id, candidateCommit: source.record.candidateCommit, sourceHash: source.data.provenance.sourceHash, sourceRevision: '0'.repeat(64), sourceGeneration: 0, specRevision: A, planRevision: B };
  const state = { current: true, dataCurrent: true, generation: 0, stopped: true, calls: 0 }, service = await createPlannedDatasetService({ rootDir: path.join(directory, 'datasets'), sourceRootDir, authorizeStoppedDataset: async () => ({ kind: 'owned_dataset', workspace: source.workspace, origin: originBinding, dataGeneration: state.generation, stopEvidence: state.stopped ? stop : { ...stop, terminationConfirmed: false }, assertCurrent: () => state.dataCurrent }) });
  const controls = [];
  t.after(async () => {
    state.dataCurrent = true; state.generation = 0; state.stopped = true; await service.close(); controls.forEach(control => control.close());
    for (const [filename, expected] of originalArtifacts) assert.equal(hash(await readFile(filename)), expected); assert.equal(hash(await readFile(dbPath)), hash(originalDatabase));
    for (const [filename, expected] of originalSourceFiles) assert.equal(hash(await readFile(path.join(source.workspace, filename))), expected);
    await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ cases: logs, paidModelCalls: 0, actualNativeStop: stop, originalSourceAndDataUnchanged: true, originBinding, targetBinding, sourceFiles: originalSourceFiles, receiptHashes: [...originalArtifacts], note: 'synthetic model receipts; real Git, MXC runtime, SQLite and backup worker; no business acceptance claimed' }, null, 2));
  });
  const registered = await service.registerStoppedDataset({ runtimeRef: 'owned-old-data' }), snapshotHandle = await service.snapshot({ datasetId: registered.datasetId, expectedGeneration: 0 }), snapshot = await service.readSnapshot(snapshotHandle);
  const targetBinding = { projectId: originBinding.projectId, runId: 'new-confirmed-run', sourceRevision: '1'.repeat(64), sourceGeneration: 1, specRevision: '2'.repeat(64), planRevision: '3'.repeat(64), inputSnapshotHash: snapshot.snapshotHash, inputSchemaHash: snapshot.schemaHash };
  function migration() { const control = createMigrationControl({ assertCurrent: () => state.current }); controls.push(control); const approval = control.approve({ plan: none, binding: targetBinding, feedback: 'Exact source-only evolution fixture; no migration execution' }); return { control, compiled: compileMigrationPlan({ plan: none, binding: targetBinding, approval }) }; }
  const approved = migration(), gate = context => { state.calls++; assert.deepEqual(context.originBinding, originBinding); assert.deepEqual(context.targetBinding, targetBinding); assert.equal(context.taskSetHash, approvedTaskSetHash); return state.current; };
  const input = { sourceHandle: source.handle, sourceRootDir, originBinding, targetBinding, requirements, tasks, approvedTaskSetHash, retainedPaths, snapshotHandle, datasetService: service, compiledMigrationPlan: approved.compiled, assertCurrent: gate };
  const expected = { targetBinding, requirements, tasks, approvedTaskSetHash }; let seed;
  async function caseTest(name, fn) { await t.test(name, async () => { await fn(); logs.push({ name, passed: true }); }); }
  async function afterSnapshotRead(changes, during, restore = () => {}) {
    let count = 0, entered, release, timer; const reached = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; });
    // The underlying private read remains real; this trusted controller adapter
    // holds its second completed read to expose the enclosing publication window.
    const adapter = Object.freeze({ inspect: service.inspect, async readSnapshot(handle) { const value = await service.readSnapshot(handle); if (++count === 2) { entered(); await waiting; } return value; } });
    const reading = createPlannedEvolutionSeed({ ...input, ...changes, datasetService: adapter }); reading.catch(() => {});
    try { await Promise.race([reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('snapshot read barrier not reached')), 10000); })]); await during(); release(); await assert.rejects(reading); }
    finally { clearTimeout(timer); release(); await reading.catch(() => {}); await restore(); }
  }
  await caseTest('new private cap preserves original provenance and all five paid-history calls without inheriting acceptance', async () => {
    seed = await createPlannedEvolutionSeed(input); const value = await assertPlannedEvolutionSeed(seed, expected);
    assert.deepEqual(value.provenance.source, source.data.provenance); assert.equal(value.provenance.source.specRevision, A); assert.equal(value.targetBinding.specRevision, '2'.repeat(64)); assert.equal(value.historicalCosts.totalModelCalls, 5); assert.equal(value.historicalCosts.modelCalls.length, 5); assert.deepEqual(value.historicalCosts.usage, { inputTokens: null, outputTokens: 10 }); assert.equal(source.data.provenance.sourceModelCalls, 3);
    assert.equal(value.historicalCosts.reports.length, 2); assert.equal(value.historicalCosts.receiptHashes.length, 5); assert.deepEqual(value.previousIssues.map(issue => issue.id), [parent.issue.id]); assert.equal(value.previousIssues[0].status, 'open');
    assert.deepEqual(value.files, source.data.files); assert.deepEqual(value.tasks, tasks); for (const field of ['accepted', 'acceptance', 'completed', 'versions']) assert.equal(Object.hasOwn(value, field), false); assert.equal(value.provenance.reuseValidation, false); assert.equal(value.provenance.migration.operationsHash, hash(none)); assert.ok(Object.isFrozen(value) && Object.isFrozen(value.historicalCosts.modelCalls[0].call));
    const view = await describePlannedEvolutionSeed(seed); assert.equal(view.historicalCosts.totalModelCalls, 5); assert.equal(JSON.stringify(view).includes(source.workspace), false); assert.equal(JSON.stringify(view).includes(snapshot.filename), false); assert.equal(view.taskSetHash, approvedTaskSetHash);
  });
  await caseTest('JSON copies of seed, source, snapshot or private migration approval grant nothing', async () => {
    for (const fake of [structuredClone(seed), JSON.parse(JSON.stringify(seed))]) await assert.rejects(assertPlannedEvolutionSeed(fake, expected));
    for (const [field, value] of [['sourceHandle', structuredClone(source.handle)], ['snapshotHandle', structuredClone(snapshotHandle)], ['compiledMigrationPlan', structuredClone(approved.compiled)]]) await assert.rejects(createPlannedEvolutionSeed({ ...input, [field]: value }));
  });
  await caseTest('foreign, same-run, old input generations and changed target/approval bindings reject', async () => {
    for (const changes of [{ projectId: 'foreign' }, { runId: originBinding.runId }, { sourceGeneration: 0 }, { inputSnapshotHash: C }, { inputSchemaHash: C }]) await assert.rejects(createPlannedEvolutionSeed({ ...input, targetBinding: { ...targetBinding, ...changes } }));
    await assert.rejects(assertPlannedEvolutionSeed(seed, { ...expected, targetBinding: { ...targetBinding, planRevision: C } }));
  });
  await caseTest('old historical run needs no new-run current flag while both exact source/data origins must match', async () => {
    const again = await createPlannedEvolutionSeed(input); assert.equal((await describePlannedEvolutionSeed(again)).originBinding.runId, 'run-old-child');
    for (const changes of [{ executionId: 'wrong' }, { sourceRevision: C }, { sourceGeneration: 1 }, { sourceHash: C }, { candidateCommit: '4'.repeat(40) }]) await assert.rejects(createPlannedEvolutionSeed({ ...input, originBinding: { ...originBinding, ...changes } }));
  });
  await caseTest('new approved task hash, exact permissions and no delete/rename or inherited task completion', async () => {
    await assert.rejects(createPlannedEvolutionSeed({ ...input, approvedTaskSetHash: C })); await assert.rejects(createPlannedEvolutionSeed({ ...input, retainedPaths: ['src/app.mjs'] })); await assert.rejects(createPlannedEvolutionSeed({ ...input, retainedPaths: [...retainedPaths, 'public/renamed.js'] })); await assert.rejects(createPlannedEvolutionSeed({ ...input, deletePaths: ['public/app.js'] }));
    const narrowed = tasks.map(task => ({ ...task, writePaths: ['src/app.mjs'] })); await assert.rejects(createPlannedEvolutionSeed({ ...input, tasks: narrowed, approvedTaskSetHash: inspectVerificationTasks(narrowed, requirements).taskSetHash }));
    const done = tasks.map(task => ({ ...task, status: 'completed' })); await assert.rejects(createPlannedEvolutionSeed({ ...input, tasks: done, approvedTaskSetHash: inspectVerificationTasks(done, requirements).taskSetHash }));
    await assert.rejects(assertPlannedEvolutionSeed(seed, { ...expected, tasks: [...tasks].reverse() }));
  });
  await caseTest('every complete rejected/Review-error and ancestor receipt remains required byte evidence', async () => {
    for (const call of [source.record.modelCalls[0], source.record.modelCalls[2], parent.record.modelCalls[1]]) { const raw = await readFile(call.receiptPath); try { await writeFile(call.receiptPath, Buffer.concat([raw, Buffer.from(' ')])); await assert.rejects(assertPlannedEvolutionSeed(seed, expected)); } finally { await writeFile(call.receiptPath, raw); } }
    assert.equal((await assertPlannedEvolutionSeed(seed, expected)).historicalCosts.totalModelCalls, 5);
  });
  await caseTest('Git source, protected runtime bytes and unknown original termination cannot be reused', async () => {
    const app = path.join(source.workspace, 'src/app.mjs'), bytes = await readFile(app); try { await writeFile(app, Buffer.concat([bytes, Buffer.from('// changed\n')])); await assert.rejects(assertPlannedEvolutionSeed(seed, expected)); } finally { await writeFile(app, bytes); }
    const shell = (await getWebShellFiles())[0], filename = path.join(source.workspace, shell.path), original = await readFile(filename); try { await writeFile(filename, Buffer.concat([original, Buffer.from('\n')])); await assert.rejects(createPlannedEvolutionSeed(input), error => error.code === 'evolution_incompatible_shell'); } finally { await writeFile(filename, original); }
    const report = await readFile(source.reportPath); try { await writeFile(source.reportPath, JSON.stringify({ ...source.record, terminationConfirmed: false, status: 'reconciliation_required' })); await assert.rejects(createPlannedEvolutionSeed(input)); } finally { await writeFile(source.reportPath, report); }
  });
  await caseTest('live target/data revocation, data generation drift and unknown stop reject', async () => {
    state.current = false; await assert.rejects(assertPlannedEvolutionSeed(seed, expected)); state.current = true;
    for (const [key, value] of [['dataCurrent', false], ['generation', 1], ['stopped', false]]) { const previous = state[key]; state[key] = value; try { await assert.rejects(assertPlannedEvolutionSeed(seed, expected)); } finally { state[key] = previous; } }
    for (const assertCurrent of [() => false, () => undefined, async () => true]) await assert.rejects(createPlannedEvolutionSeed({ ...input, assertCurrent }));
  });
  await caseTest('revoked migration confirmation and explicit seed revocation cannot be revived', async () => {
    const fresh = migration(), cap = await createPlannedEvolutionSeed({ ...input, compiledMigrationPlan: fresh.compiled }); fresh.control.revoke(); await assert.rejects(assertPlannedEvolutionSeed(cap, expected));
    const other = await createPlannedEvolutionSeed(input); revokePlannedEvolutionSeed(other); await assert.rejects(assertPlannedEvolutionSeed(other, expected)); await assert.rejects(describePlannedEvolutionSeed(other));
  });
  await caseTest('late target revoke and immutable snapshot mutation are checked after awaits', async () => {
    let guards = 0; await assert.rejects(createPlannedEvolutionSeed({ ...input, assertCurrent: () => ++guards < 8 })); assert.ok(guards >= 8);
    const bytes = await readFile(snapshot.filename); await chmod(snapshot.filename, 0o600); try { await writeFile(snapshot.filename, Buffer.concat([bytes, Buffer.from('changed')])); await assert.rejects(assertPlannedEvolutionSeed(seed, expected)); } finally { await writeFile(snapshot.filename, bytes); await chmod(snapshot.filename, 0o400); }
  });
  await caseTest('completed read awaiting publication cannot survive target, data or migration approval revocation', async () => {
    await afterSnapshotRead({}, () => { state.current = false; }, () => { state.current = true; });
    await afterSnapshotRead({ assertCurrent: context => gate(context) && state.dataCurrent && state.generation === 0 && state.stopped }, () => { state.dataCurrent = false; }, () => { state.dataCurrent = true; });
    const fresh = migration(); await afterSnapshotRead({ compiledMigrationPlan: fresh.compiled }, () => fresh.control.revoke());
  });
  await caseTest('source receipt changed after the final snapshot read cannot escape the last Git and byte audit', async () => {
    const filename = parent.record.modelCalls[1].receiptPath, bytes = await readFile(filename);
    await afterSnapshotRead({}, () => writeFile(filename, Buffer.concat([bytes, Buffer.from(' ')])), () => writeFile(filename, bytes));
  });
  await caseTest('ancestor source bytes changed after the final Git await are rejected before capability publication', async () => {
    let guards = 0; await createPlannedEvolutionSeed({ ...input, assertCurrent: context => { guards++; return gate(context); } });
    const filename = path.join(parent.workspace, 'src/app.mjs'), bytes = await readFile(filename); let count = 0, changed = false;
    try {
      await assert.rejects(createPlannedEvolutionSeed({ ...input, assertCurrent: context => { if (++count === guards - 3) { writeFileSync(filename, Buffer.concat([bytes, Buffer.from('// late ancestor change\n')])); changed = true; } return gate(context); } }));
      assert.equal(changed, true, 'exercise the guard immediately after the final managed Git await');
    } finally { await writeFile(filename, bytes); }
  });
  await caseTest('source-only does not create a migration intent, mutate code/DB or spend model calls', async () => {
    assert.deepEqual(service.inspectIntents(originBinding.projectId).map(intent => intent.kind), ['snapshot']); assert.equal(hash(await readFile(dbPath)), hash(originalDatabase));
    const controller = new AbortController(); controller.abort(); await assert.rejects(createPlannedEvolutionSeed({ ...input, signal: controller.signal })); await assert.rejects(assertPlannedEvolutionSeed(seed, expected, { signal: controller.signal }));
  });
  await caseTest('service closing after a completed read blocks publication and withdraws every issued seed', async () => { await afterSnapshotRead({}, () => service.close()); await assert.rejects(assertPlannedEvolutionSeed(seed, expected)); await assert.rejects(createPlannedEvolutionSeed(input)); });
});
