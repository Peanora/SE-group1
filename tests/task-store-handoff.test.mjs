import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { openTaskStore, inspectFrozenTaskHandoff, inspectConsumedTaskHandoff } from '../lib/task-store.mjs';

const hash = value => value.repeat(64), commit = 'a'.repeat(40);
const task = (id, dependsOn = []) => ({ id, description: id, inputs: ['approved'], outputs: ['candidate'], dependsOn,
  writablePaths: [`src/${id}.mjs`], acceptance: ['tested'], baseCommit: commit, reservation: { calls: 2, tokens: 100 },
  manifests: { test: { hash: hash('a'), checkIds: ['http'] }, browser: { hash: hash('b'), checkIds: ['view'] }, review: { hash: hash('c') } } });
const freeze = store => store.control.freezeHandoff({ runId: 'run', expectedVersion: 1, checkpointId: 'checkpoint', evidenceHash: hash('e') });
const consume = (store, checkpoint, generationId = 'generation-2') => store.control.consumeHandoff({ runId: 'run', expectedVersion: 1,
  checkpointId: checkpoint.checkpointId, evidenceHash: checkpoint.evidenceHash, frozenStateHash: checkpoint.frozenStateHash, generationId });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-handoff-')), filename = path.join(root, 'tasks.sqlite'), stores = []; let time = 1000;
  const open = () => { const store = openTaskStore({ filename, now: () => time }); stores.push(store); return store; }, store = open();
  store.control.createRun({ projectId: 'project', runId: 'run', projectRevision: hash('1'), specRevision: hash('2'), planRevision: hash('3'),
    deadlineAt: 61000, budget: { calls: 8, tokens: 400 }, tasks: [task('BASE'), task('FINAL', ['BASE'])] });
  t.after(async () => { for (const item of stores) item.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('task-handoff-')); await rm(root, { recursive: true, force: true }); });
  return { store, filename, open, advance: value => { time += value; } };
}
function complete(store, { stop = true, settle = true } = {}) {
  let { lease } = store.worker.claim({ runId: 'run', taskId: 'BASE', workerId: 'original' });
  if (stop) store.control.confirmStopped({ attemptId: lease.attemptId, evidenceId: 'known-stop' });
  if (settle) store.control.settle({ attemptId: lease.attemptId, settlementId: 'known-cost', usage: { calls: 2, tokens: 12 } });
  lease = store.worker.publish({ lease, publicationId: 'base-source', candidateCommit: 'b'.repeat(40), sourceHash: hash('d'), artifacts: ['base'] }).lease;
  const fields = ['projectId', 'runId', 'taskId', 'attemptId', 'generation', 'projectRevision', 'specRevision', 'planRevision', 'baseCommit', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash', 'candidateCommit', 'sourceHash'];
  const binding = Object.fromEntries(fields.map(key => [key, lease[key]]));
  const receipts = { test: { role: 'test', kind: 'independent', binding, manifestHash: hash('a'), status: 'passed', terminationConfirmed: true, checks: [{ id: 'http', passed: true }] },
    browser: { role: 'browser', kind: 'independent', binding, manifestHash: hash('b'), status: 'passed', terminationConfirmed: true, checks: [{ id: 'view', passed: true }] },
    review: { role: 'review', kind: 'independent', binding, manifestHash: hash('c'), status: 'completed', issues: [] } };
  store.control.recordValidation({ lease, validationId: 'base-validation', receipts });
  assert.equal(store.worker.finish({ lease, validationId: 'base-validation' }).completed, true); return { lease, receipts };
}

test('frozen handoff survives reopen while retaining original budget, deadline and exact completed attempts', async t => {
  const f = await fixture(t); complete(f.store); f.store.control.pause('run');
  const before = f.store.query.getRun('run'), attempts = f.store.query.listAttempts('run'), checkpoint = freeze(f.store);
  assert.equal(checkpoint.duplicate, false); assert.match(checkpoint.frozenStateHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.store.query.getRun('run'), { ...before, status: 'handoff_frozen' }); assert.deepEqual(f.store.query.listAttempts('run'), attempts);
  f.store.close(); const reopened = f.open();
  const { duplicate, ...expected } = checkpoint; assert.deepEqual(inspectFrozenTaskHandoff({ filename: f.filename, runId: 'run', checkpointId: 'checkpoint' }), expected);
  assert.deepEqual(reopened.query.assertFrozenHandoff({ runId: 'run', checkpointId: 'checkpoint' }), expected);
  assert.equal(freeze(reopened).duplicate, true); assert.deepEqual(reopened.query.getRun('run').budget, before.budget);
});

test('handoff freeze fences ordinary resume, dispatch, rebinding and plan replacement', async t => {
  const { store } = await fixture(t); complete(store); store.control.pause('run'); freeze(store);
  assert.throws(() => store.control.resume('run'), { code: 'conflict' });
  assert.equal(store.worker.claim({ runId: 'run', taskId: 'FINAL', workerId: 'old' }), null);
  assert.throws(() => store.control.bindTaskBase({ runId: 'run', taskId: 'FINAL', expectedVersion: 1, baseCommit: 'c'.repeat(40), evidenceId: 'late-base' }), { code: 'conflict' });
  assert.throws(() => store.control.replacePlan({ runId: 'run', expectedVersion: 1, projectRevision: hash('4'), specRevision: hash('5'), planRevision: hash('6'), tasks: [task('NEW')] }), { code: 'conflict' });
  assert.throws(() => store.control.freezeHandoff({ runId: 'run', expectedVersion: 1, checkpointId: 'checkpoint', evidenceHash: hash('f') }), { code: 'conflict' });
});

test('one exact generation consumes once and dispatches only pending work without another reservation for BASE', async t => {
  const { store, open, filename } = await fixture(t); complete(store); store.control.pause('run'); const checkpoint = freeze(store), before = store.query.getRun('run');
  const first = consume(store, checkpoint); assert.equal(first.duplicate, false); const cursor = store.query.events().cursor;
  assert.equal(consume(open(), checkpoint).duplicate, true); assert.equal(store.query.events().cursor, cursor);
  assert.throws(() => consume(store, checkpoint, 'generation-3'), { code: 'conflict' });
  assert.deepEqual(store.query.getRun('run'), { ...before, status: 'running' });
  assert.equal(store.worker.claim({ runId: 'run', taskId: 'BASE', workerId: 'next' }), null);
  store.control.bindTaskBase({ runId: 'run', taskId: 'FINAL', expectedVersion: 1, baseCommit: 'b'.repeat(40), evidenceId: 'restored-base', reservation: { calls: 2, tokens: 100 } });
  const next = store.worker.claim({ runId: 'run', taskId: 'FINAL', workerId: 'next' }); assert.equal(next.lease.generation, 1);
  assert.equal(store.query.listAttempts('run').length, 2); assert.equal(store.query.getRun('run').budget.committed.calls, 4);
  const consumed = inspectConsumedTaskHandoff({ filename, runId: 'run', checkpointId: checkpoint.checkpointId, generationId: 'generation-2' });
  assert.equal(consumed.consumedBy, 'generation-2'); assert.equal(consumed.frozenStateHash, checkpoint.frozenStateHash);
  assert.throws(() => inspectConsumedTaskHandoff({ filename, runId: 'run', checkpointId: checkpoint.checkpointId, generationId: 'generation-3' }), { code: 'checkpoint_unavailable' });
});

test('freeze refuses an empty checkpoint and an in-flight lease even after stop and cost observations', async t => {
  const { store } = await fixture(t); store.control.pause('run'); assert.throws(() => freeze(store), { code: 'conflict' }); store.control.resume('run');
  const { lease } = store.worker.claim({ runId: 'run', workerId: 'inflight' }); store.control.pause('run');
  store.control.confirmStopped({ attemptId: lease.attemptId, evidenceId: 'stop' }); store.control.settle({ attemptId: lease.attemptId, settlementId: 'cost', usage: { calls: 0, tokens: 0 } });
  assert.throws(() => freeze(store), { code: 'conflict' }); assert.equal(store.query.getRun('run').status, 'paused');
});

for (const missing of ['stop', 'cost', 'reservation']) test(`freeze refuses ${missing} evidence and preserves the pending checkpoint`, async t => {
  const { store, filename } = await fixture(t); complete(store, { stop: missing !== 'stop', settle: missing !== 'cost' });
  if (missing === 'reservation') { const db = new DatabaseSync(filename); try { db.exec('DELETE FROM reservations'); } finally { db.close(); } }
  store.control.pause('run'); const budget = store.query.getRun('run').budget; assert.throws(() => freeze(store), { code: 'conflict' }); assert.deepEqual(store.query.getRun('run').budget, budget);
});

test('a late historical validation invalidates the frozen event tail without releasing original costs', async t => {
  const { store, filename } = await fixture(t), original = complete(store); store.control.pause('run'); const checkpoint = freeze(store), budget = store.query.getRun('run').budget;
  assert.equal(store.control.recordValidation({ lease: original.lease, validationId: 'late-record', receipts: original.receipts }).current, false);
  assert.throws(() => store.query.assertFrozenHandoff({ runId: 'run', checkpointId: 'checkpoint' }), { code: 'checkpoint_changed' });
  assert.throws(() => inspectFrozenTaskHandoff({ filename, runId: 'run', checkpointId: 'checkpoint' }), { code: 'checkpoint_changed' });
  assert.throws(() => consume(store, checkpoint), { code: 'checkpoint_changed' }); assert.deepEqual(store.query.getRun('run').budget, budget);
});

test('original deadline and explicit cancellation both prevent frozen recovery', async t => {
  const f = await fixture(t); complete(f.store); f.store.control.pause('run'); const checkpoint = freeze(f.store), budget = f.store.query.getRun('run').budget;
  f.advance(60000); assert.throws(() => consume(f.store, checkpoint), { code: 'conflict' }); assert.equal(f.store.query.getRun('run').deadlineAt, 61000);
  f.store.control.requestCancel('run'); f.store.control.confirmCancel('run'); assert.throws(() => consume(f.store, checkpoint), { code: 'checkpoint_changed' });
  assert.deepEqual(f.store.query.getRun('run').budget, budget); assert.equal(f.store.query.getTask('run', 'BASE').status, 'completed');
});

test('consumed handoff rejects duplicated or changed resume history', async t => {
  const { store, filename } = await fixture(t); complete(store); store.control.pause('run'); const checkpoint = freeze(store); consume(store, checkpoint);
  const db = new DatabaseSync(filename);
  try { db.exec("INSERT INTO events(run_id,version,task_id,attempt_id,type,payload,created_at) SELECT run_id,version,task_id,attempt_id,type,payload,created_at FROM events WHERE type='checkpoint_resumed'"); }
  finally { db.close(); }
  assert.throws(() => inspectConsumedTaskHandoff({ filename, runId: 'run', checkpointId: checkpoint.checkpointId, generationId: 'generation-2' }), { code: 'checkpoint_changed' });
});

test('version-one migration preserves old completed evidence and unknown-free budget before freezing', async t => {
  const { store, filename, open } = await fixture(t); complete(store); store.control.pause('run'); const before = store.query.getRun('run'), attempts = store.query.listAttempts('run'); store.close();
  const old = new DatabaseSync(filename); try { old.exec('DROP INDEX task_unconsumed_handoff; DROP TABLE handoffs; PRAGMA user_version=1'); } finally { old.close(); }
  const migrated = open(); assert.deepEqual(migrated.query.getRun('run'), before); assert.deepEqual(migrated.query.listAttempts('run'), attempts);
  assert.equal(freeze(migrated).duplicate, false);
  const db = new DatabaseSync(filename, { readOnly: true }); try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3); } finally { db.close(); }
});

for (const [label, sql] of [
  ['old actual usage', 'UPDATE reservations SET actual_calls=actual_calls+1'],
  ['old settlement', `UPDATE settlements SET payload='{"calls":0,"tokens":0}'`],
  ['old attempt', "UPDATE attempts SET validation_id='unrelated-validation'"],
  ['old event prefix', "UPDATE events SET payload='{}' WHERE type='run_created'"],
]) test(`consumed audit rejects changed ${label} while the stored freeze hash is left intact`, async t => {
  const { store, filename } = await fixture(t); complete(store); store.control.pause('run'); const checkpoint = freeze(store); consume(store, checkpoint);
  const db = new DatabaseSync(filename); try { db.exec(sql); assert.equal(db.prepare('SELECT frozen_state_hash FROM handoffs').get().frozen_state_hash, checkpoint.frozenStateHash); } finally { db.close(); }
  assert.throws(() => inspectConsumedTaskHandoff({ filename, runId: 'run', checkpointId: checkpoint.checkpointId, generationId: 'generation-2' }), { code: 'checkpoint_changed' });
});

test('version-two handoffs without a sealed history snapshot are never retroactively authorized', async t => {
  const { store, filename, open } = await fixture(t); complete(store); store.control.pause('run'); freeze(store); const before = store.query.getRun('run'); store.close();
  const db = new DatabaseSync(filename); try { db.exec('ALTER TABLE handoffs DROP COLUMN frozen_history; PRAGMA user_version=2'); } finally { db.close(); }
  const migrated = open(); assert.deepEqual(migrated.query.getRun('run'), before);
  assert.throws(() => migrated.query.assertFrozenHandoff({ runId: 'run', checkpointId: 'checkpoint' }), { code: 'checkpoint_changed' });
});
