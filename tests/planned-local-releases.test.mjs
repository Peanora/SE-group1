import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPlannedLocalReleases } from '../lib/planned-local-releases.mjs';
import { createPlannedDatasetService } from '../lib/planned-dataset.mjs';
import { createMigrationControl, compileMigrationPlan } from '../lib/planned-migration-contract.mjs';
import { createPlannedEvolutionSeed, assertPlannedEvolutionSeed } from '../lib/planned-evolution-source.mjs';
import { setupPlannedEvolutionFixture, nativeEvolutionAvailable, oldRows, hash } from './helpers/planned-evolution-fixture.mjs';
import { createLocalCandidate } from './helpers/planned-local-release-fixture.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(50); } throw new Error('state did not converge'); }
test('local release admission requires trusted callbacks and bounded configuration', async () => { await assert.rejects(createPlannedLocalReleases({})); });

test('real owned pair activation, stopped-dataset evolution and rollback preserve source/data versions without leaking private data', { skip: !nativeEvolutionAvailable, timeout: 240000 }, async t => {
  const f = await setupPlannedEvolutionFixture(t, { prefix: 'local-', blocking: false }), projectId = f.originBinding.projectId, state = { owner: true, externalBusy: false }, grants = new Map(), migrations = [], controls = []; let service, datasets;
  const access = () => state.owner, viewer = () => true, list = () => service.list({ projectId }, { assertAccess: viewer }).releases, current = () => list().find(row => row.current);
  const publicExecutionId = 'public-origin-execution'; grants.set(publicExecutionId, { files: f.files, sourceHandle: f.sourceHandle, sourceRootDir: f.sourceRootDir, originBinding: f.originBinding, sourceHash: f.originBinding.sourceHash, shellHash: f.record.shellHash, assertCurrent: () => true });
  const options = { rootDir: path.join(f.sourceRootDir, 'managed-releases'), authorizeExecution: async (input, { assertAccess }) => { assert.equal(assertAccess(), true); const grant = grants.get(input.executionId); assert.ok(grant); return grant; }, withCheckpoint: async (pid, work) => { assert.equal(service.hasActivity(pid), false, 'the owned checkpoint must not reject its own reservation'); return work(); }, assertIdle: pid => !state.externalBusy && !service.hasActivity(pid), timeoutMs: 120000 };
  service = await createPlannedLocalReleases(options); t.after(async () => { await service.shutdown(); await datasets?.close(); controls.forEach(control => control.close()); for (const [filename, expected] of migrations) assert.equal(hash(await readFile(filename)), expected); });
  let first, firstGrant, firstBytes;
  await t.test('role/scope, explicit first activation and real MXC writes require confirmed stop before data admission', async () => {
    await assert.rejects(service.activate({ projectId, runId: f.originBinding.runId, executionId: f.originBinding.executionId, expectedReleaseId: null, expectedDataGeneration: 0 }, { assertAccess: () => false })); assert.equal(list().length, 0);
    first = (await service.activate({ projectId, runId: f.originBinding.runId, executionId: publicExecutionId, expectedReleaseId: null, expectedDataGeneration: 0 }, { assertAccess: access })).release; assert.equal(first.executionId, publicExecutionId);
    assert.equal(first.dataGeneration, 0); await assert.rejects(service.authorizeStoppedDataset(first.id));
    const started = await service.start({ projectId, releaseId: first.id, expectedDataGeneration: 0 }, { assertAccess: access }); assert.equal(started.release.state, 'running'); assert.ok(started.release.url);
    await assert.rejects(service.authorizeStoppedDataset(first.id)); await assert.rejects(service.stop({ projectId: 'foreign', releaseId: first.id }, { assertAccess: access }));
    for (const row of oldRows) assert.equal((await fetch(started.release.url + '/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) })).status, 201);
    const stopped = (await service.stop({ projectId, releaseId: first.id }, { assertAccess: access })).release; assert.equal(stopped.state, 'stopped'); assert.equal(stopped.active, false); assert.equal(stopped.dataGeneration, 1);
    firstGrant = await service.authorizeStoppedDataset(first.id); assert.notEqual(firstGrant.workspace, f.workspace); assert.equal(firstGrant.sourceProvenance.sourceWorkspace, f.workspace); assert.deepEqual(firstGrant.retainedPaths, f.retainedPaths); firstBytes = hash(await readFile(path.join(firstGrant.workspace, '.platform/tmp/app.sqlite')));
    const text = JSON.stringify(list()); for (const privateValue of ['PRIVATE_ROW_', firstGrant.workspace, f.workspace, 'databasePath', 'receiptPath']) assert.equal(text.includes(privateValue), false);
    assert.deepEqual((await service.stop({ projectId, releaseId: first.id }, { assertAccess: access })).release, list().find(row => row.id === first.id));
  });
  datasets = await createPlannedDatasetService({ rootDir: path.join(f.directory, 'local-datasets'), sourceRootDir: f.sourceRootDir, authorizeStoppedDataset: id => service.authorizeStoppedDataset(id) });
  async function evolve(ordinal) {
    const old = current(), oldGrant = await service.authorizeStoppedDataset(old.id), registered = await datasets.registerStoppedDataset({ runtimeRef: old.id }), snapshotHandle = await datasets.snapshot({ datasetId: registered.datasetId, expectedGeneration: registered.dataGeneration }), snapshot = await datasets.readSnapshot(snapshotHandle);
    const grant = await createLocalCandidate(f, ordinal), targetBinding = { ...Object.fromEntries(['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision'].map(key => [key, grant.originBinding[key]])), inputSnapshotHash: snapshot.snapshotHash, inputSchemaHash: snapshot.schemaHash };
    const plan = { version: 1, kind: 'bounded_operations', operations: [{ op: 'addColumn', table: 'items', column: 'priority', type: 'INTEGER', nullable: false, default: 0 }] }, control = createMigrationControl({ assertCurrent: () => { oldGrant.assertCurrent(); return state.owner; } }); controls.push(control);
    const approval = control.approve({ plan, binding: targetBinding, feedback: 'Exact paired migration fixture' }), compiled = compileMigrationPlan({ plan, binding: targetBinding, approval });
    const context = { targetBinding, requirements: f.requirements, tasks: f.tasks, approvedTaskSetHash: f.approvedTaskSetHash, retainedPaths: f.retainedPaths }, seed = await createPlannedEvolutionSeed({ sourceHandle: f.sourceHandle, sourceRootDir: f.sourceRootDir, originBinding: oldGrant.origin, ...context, snapshotHandle, datasetService: datasets, compiledMigrationPlan: compiled, assertCurrent: () => { oldGrant.assertCurrent(); return state.owner; } });
    const value = await assertPlannedEvolutionSeed(seed, context), result = await datasets.migrate({ snapshotHandle, compiledPlan: compiled, targetBinding, candidateCommit: grant.originBinding.candidateCommit }), migrated = await datasets.readResult(result); migrations.push([snapshot.filename, hash(await readFile(snapshot.filename))], [migrated.databasePath, hash(await readFile(migrated.databasePath))]);
    grant.evolutionSource = value.provenance; grants.set(grant.originBinding.executionId, grant);
    const activated = await service.activate({ projectId, runId: grant.originBinding.runId, executionId: grant.originBinding.executionId, expectedReleaseId: old.id, expectedDataGeneration: old.dataGeneration }, { assertAccess: access, migrationResult: result, datasetService: datasets });
    return { ...activated, old, oldGrant, snapshot, result };
  }
  await t.test('preparing migration may read the stopped old pair despite its own active intent, then rollback restores the whole old pair', async () => {
    const next = await evolve(1); assert.equal(next.release.current, true); assert.equal(next.release.predecessorId, first.id); assert.equal(current().actions.canRollback, true); assert.equal(hash(await readFile(path.join(firstGrant.workspace, '.platform/tmp/app.sqlite'))), firstBytes);
    const restored = await service.rollback({ projectId, releaseId: next.release.id, expectedDataGeneration: 0, reason: '未产生新写入，恢复成对旧版本' }, { assertAccess: access }); assert.equal(restored.release.id, first.id); assert.equal(restored.release.current, true); assert.equal(restored.release.dataGeneration, 2); assert.equal(restored.replacedRelease.state, 'rolled_back'); assert.throws(next.oldGrant.assertCurrent, 'pointer ABA must not revive the old data grant');
    assert.equal(hash(await readFile(path.join(firstGrant.workspace, '.platform/tmp/app.sqlite'))), firstBytes);
  });
  await t.test('new business writes permanently block rollback and keep both immutable backup objects intact', async () => {
    const next = await evolve(2), running = await service.start({ projectId, releaseId: next.release.id, expectedDataGeneration: 0 }, { assertAccess: access }); const before = await (await fetch(running.release.url + '/items')).json(); assert.equal(before.length, 2); assert.ok(before.every(row => row.priority === 0));
    await fetch(running.release.url + '/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'alice', value: 'NEW_RETAINED_ROW' }) }); const ended = await service.stop({ projectId, releaseId: next.release.id }, { assertAccess: access }); assert.equal(ended.release.dataGeneration, 1); assert.equal(ended.release.actions.canRollback, false);
    await assert.rejects(service.rollback({ projectId, releaseId: next.release.id, expectedDataGeneration: 1, reason: '必须拒绝丢弃新行' }, { assertAccess: access }), error => error.code === 'local_release_rollback_data_changed'); assert.equal(current().id, next.release.id);
    const again = await service.start({ projectId, releaseId: next.release.id, expectedDataGeneration: 1 }, { assertAccess: access }); assert.equal((await (await fetch(again.release.url + '/items')).json()).length, 3); await service.stop({ projectId, releaseId: next.release.id }, { assertAccess: access });
  });
  await t.test('role withdrawal stops an issued runtime and external busy/lost generations cannot start new work', async () => {
    const row = current(); state.externalBusy = true; await assert.rejects(service.start({ projectId, releaseId: row.id, expectedDataGeneration: row.dataGeneration }, { assertAccess: access })); state.externalBusy = false;
    await assert.rejects(service.start({ projectId, releaseId: row.id, expectedDataGeneration: row.dataGeneration + 1 }, { assertAccess: access }));
    await service.start({ projectId, releaseId: row.id, expectedDataGeneration: row.dataGeneration }, { assertAccess: access }); state.owner = false; assert.equal(current().url, null); await until(() => current().state === 'stopped'); await assert.rejects(service.start({ projectId, releaseId: row.id, expectedDataGeneration: current().dataGeneration }, { assertAccess: access })); state.owner = true;
  });
  await t.test('private checkpoint holds competing work and inherited async context expires immediately on completion', async () => {
    let release, entered, background, observe; const held = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; }), future = new Promise(resolve => { observe = resolve; });
    const work = service.withProjectCheckpoint(projectId, async () => { background = future.then(() => service.hasActivity(projectId)); entered(); await held; }); await reached; assert.equal(service.hasActivity(projectId), true); assert.throws(() => service.withProjectCheckpoint(projectId, async () => {})); release(); await work;
    const row = current(); await service.start({ projectId, releaseId: row.id, expectedDataGeneration: row.dataGeneration }, { assertAccess: access }); observe(); assert.equal(await background, true); await service.stop({ projectId, releaseId: row.id }, { assertAccess: access });
  });
  await t.test('source drift revokes the runtime and restart preserves unknown coordination rather than releasing the project', async () => {
    const row = current(), grant = await service.authorizeStoppedDataset(row.id), filename = path.join(grant.workspace, 'src/app.mjs'), bytes = await readFile(filename); await service.start({ projectId, releaseId: row.id, expectedDataGeneration: row.dataGeneration }, { assertAccess: access });
    try { await writeFile(filename, Buffer.concat([bytes, Buffer.from('// changed owned source\n')])); await until(() => current().state === 'reconciliation_required'); assert.equal(service.hasActivity(projectId), true); await assert.rejects(service.authorizeStoppedDataset(row.id)); }
    finally { await writeFile(filename, bytes); }
    const closed = await service.shutdown(); assert.equal(closed.reconciliationRequired, true); service = await createPlannedLocalReleases(options); assert.equal(current().state, 'reconciliation_required'); assert.equal(service.hasActivity(projectId), true); await assert.rejects(service.start({ projectId, releaseId: row.id, expectedDataGeneration: row.dataGeneration }, { assertAccess: access }));
  });
});
