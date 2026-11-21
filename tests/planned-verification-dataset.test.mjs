import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { runHttpScenarios } from '../lib/http-scenarios.mjs';
import { runBrowserScenarios } from '../lib/browser-scenarios.mjs';
import { createPlannedVerificationDataset, preparePlannedVerificationDataset, assertPlannedVerificationDatasetReceipt } from '../lib/planned-verification-dataset.mjs';
import { applyProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';
import { setupPlannedEvolutionFixture, nativeEvolutionAvailable, sourceHash, hash, oldRows } from './helpers/planned-evolution-fixture.mjs';

const migration = { version: 1, kind: 'bounded_operations', operations: [{ op: 'addColumn', table: 'items', column: 'priority', type: 'INTEGER', nullable: false, default: 0 }] };
function approved(f) {
  const control = createVerificationControl(), base = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, f.targetBinding[key]]));
  const assertions = (name, priority) => [{ id: `${name}_status`, op: 'status', value: 200 }, { id: `${name}_count`, op: 'jsonLength', path: '$', value: 2 },
    { id: `${name}_owner`, op: 'jsonEquals', path: '$[0].owner', value: 'alice' }, { id: `${name}_priority`, op: 'jsonEquals', path: '$[0].priority', value: priority }];
  const request = (id, method, route, dependsOn, list, body) => ({ id, type: 'request', dependsOn, requirementIds: ['R1'], request: { id: `${id}_request`, method, path: route, assertions: list, ...(body ? { body } : {}) } });
  const expectedText = oldRows.map(row => `${row.owner}:${row.value}:p0`).join('|');
  const proposal = { version: 1, id: 'migrated-old-data', name: 'Approved migration copy isolation fixture', sessions: [], limits: { timeoutMs: 60000, requestTimeoutMs: 5000 }, steps: [
    request('old_rows', 'GET', '/items', [], assertions('initial', 0)),
    request('change', 'POST', '/priority', ['old_rows'], [{ id: 'change_status', op: 'status', value: 204 }], { id: 1, priority: 2 }),
    { id: 'restart', type: 'restart', dependsOn: ['change'], requirementIds: ['R1'] },
    request('persisted', 'GET', '/items', ['restart'], assertions('after_restart', 2)),
  ], browser: { version: 1, sessions: ['reader'], limits: { timeoutMs: 60000, actionTimeoutMs: 5000 }, steps: [
    { id: 'home', op: 'goto', session: 'reader', requirementIds: ['R1'], path: '/' },
    { id: 'old_values', op: 'text', session: 'reader', requirementIds: ['R1'], testId: 'items', value: expectedText },
  ] } };
  const input = { proposal, binding: base, requirements: ['R1'] }, approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval);
  const files = validateProjectFiles(f.candidateFiles.map(file => file.path === 'src/app.mjs' ? { ...file, content: file.content
    .replace('SELECT id,owner,value FROM items ORDER BY id', 'SELECT id,owner,value,priority FROM items ORDER BY id')
    .replace("row.owner+':'+row.value", "row.owner+':'+row.value+':p'+row.priority")
    .replace(".join('|')", ".join('|<wbr>')")
    .replace(".join('|')", ".join('|<wbr>')")
    .replace('handle:async request=>{', `handle:async request=>{if(request.method==='POST'&&request.path==='/priority'){const data=JSON.parse(request.body);db.prepare('UPDATE items SET priority=? WHERE id=?').run(data.priority,data.id);return{status:204,body:''}}`) } : file));
  const binding = { ...base, taskId: 'whole', attemptId: 'old-data-attempt', candidateCommit: '9'.repeat(40), sourceHash: sourceHash(files), manifestHash: manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: '8'.repeat(64) };
  return { control, approval, manifest, binding, files };
}

test('JSON cannot introduce an old-data verification capability', async () => {
  for (const fake of [null, { kind: 'planned_verification_dataset', id: 'fake' }]) {
    await assert.rejects(preparePlannedVerificationDataset(fake, { phase: 'http' }));
    assert.throws(() => assertPlannedVerificationDatasetReceipt(fake, {}, { phase: 'http' }));
  }
});

// All data/SQL, Git, migration workers, HTTP, Edge and process stops are real.
// The origin model receipts and candidate implementation are explicit fixtures.
test('old rows are separately migrated for self-check, HTTP and both Edge views; restart keeps only its own writes', { skip: !nativeEvolutionAvailable, timeout: 180000 }, async t => {
  const f = await setupPlannedEvolutionFixture(t, { prefix: 'independent-data-', plan: migration, blocking: false }), a = approved(f); t.after(() => a.control.revoke(a.approval));
  const args = { evolutionSeed: f.evolutionSeed, context: f.context, manifest: a.manifest, binding: a.binding };
  await assert.rejects(createPlannedVerificationDataset({ ...args, evolutionSeed: structuredClone(f.evolutionSeed) }));
  await assert.rejects(createPlannedVerificationDataset({ ...args, manifest: structuredClone(a.manifest) }));
  const cap = await createPlannedVerificationDataset(args), rootDir = path.join(f.directory, 'independent-validation'); await mkdir(rootDir);
  const common = { manifest: a.manifest, binding: a.binding, files: a.files, rootDir, executable: process.env.EXECUTION_SANDBOX_EXE, timeoutMs: 60000, datasetSeed: cap };
  const self = await runHttpScenarios({ ...common, phase: 'self_check' }); assert.equal(self.status, 'passed', JSON.stringify(self));
  const [http, browser] = await Promise.all([runHttpScenarios({ ...common, phase: 'http' }), runBrowserScenarios(common)]);
  assert.equal(http.status, 'passed', JSON.stringify(http)); assert.equal(browser.status, 'passed', JSON.stringify(browser));
  assert.equal(self.terminationConfirmed && http.terminationConfirmed && browser.terminationConfirmed, true);
  const issued = [self.dataset, http.dataset, ...browser.dataset]; assert.equal(issued.length, 4); assert.equal(new Set(issued.map(receipt => receipt.migrationId)).size, 4);
  assert.deepEqual(new Set(issued.map(receipt => receipt.phase)), new Set(['self_check', 'http', 'browser-DESKTOP', 'browser-MOBILE']));
  assert.equal(new Set(issued.map(receipt => receipt.databaseHash)).size, 1); // Same pre-test old rows, four actual migrations.
  for (const receipt of issued) {
    assert.equal(assertPlannedVerificationDatasetReceipt(cap, receipt, { manifest: a.manifest, binding: a.binding, phase: receipt.phase }), receipt);
    assert.throws(() => assertPlannedVerificationDatasetReceipt(cap, structuredClone(receipt), { manifest: a.manifest, binding: a.binding, phase: receipt.phase }));
    assert.throws(() => assertPlannedVerificationDatasetReceipt(cap, receipt, { manifest: a.manifest, binding: { ...a.binding, candidateCommit: '7'.repeat(40) }, phase: receipt.phase }));
    assert.equal(JSON.stringify(receipt).includes(f.directory), false); assert.equal(JSON.stringify(receipt).includes('PRIVATE_ROW'), false);
  }
  const duplicate = await mkdtemp(path.join(rootDir, 'duplicate-')); await applyProjectFiles({ workspace: duplicate, files: a.files });
  await assert.rejects(preparePlannedVerificationDataset(cap, { workspace: duplicate, manifest: a.manifest, binding: a.binding, phase: 'http' }), e => e.code === 'verification_dataset_already_prepared');
  f.state.current = false;
  assert.throws(() => assertPlannedVerificationDatasetReceipt(cap, self.dataset, { manifest: a.manifest, binding: a.binding, phase: 'self_check' })); f.state.current = true;
  assert.notEqual(f.runtimeWorkspace, f.workspace);
  assert.equal(hash(await readFile(path.join(f.runtimeWorkspace, '.platform/tmp/app.sqlite'))), f.originalDatabase);
  await writeFile(path.join(f.directory, 'verification-dataset-result.json'), JSON.stringify({ self, http, browser, paidModelCalls: 0, originalDatabaseUnchanged: true }, null, 2));
});
