import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { openTaskStore } from '../lib/task-store.mjs';

const H = value => value.repeat(64), commit = 'a'.repeat(40);
const definition = (id, dependsOn = []) => ({ id, description: id, inputs: ['approved'], outputs: ['candidate'], dependsOn, writablePaths: [`src/${id}.mjs`], acceptance: ['tested'], baseCommit: commit,
  manifests: { test: { hash: H('a'), checkIds: ['http'] }, browser: { hash: H('b'), checkIds: ['view'] }, review: { hash: H('c') } }, reservation: { calls: 2, tokens: 100 } });
async function fixture(t, tasks = [definition('A'), definition('B'), definition('FINAL', ['A', 'B'])]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-rework-')), filename = path.join(root, 'tasks.sqlite'), store = openTaskStore({ filename, now: () => 1000 });
  t.after(async () => { store.close(); const relative = path.relative(path.resolve(os.tmpdir()), root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(root).startsWith('task-rework-')); await rm(root, { recursive: true, force: true }); });
  store.control.createRun({ projectId: 'p', runId: 'r', projectRevision: H('1'), specRevision: H('2'), planRevision: H('3'), deadlineAt: 61000, budget: { calls: 30, tokens: 1000 }, tasks });
  return { store, filename };
}
function complete(store, taskId) {
  let { lease } = store.worker.claim({ runId: 'r', taskId, workerId: 'controlled' });
  store.control.settle({ attemptId: lease.attemptId, settlementId: `usage-${lease.attemptId}`, usage: { calls: 1, tokens: 5 } });
  store.control.confirmStopped({ attemptId: lease.attemptId, evidenceId: `stop-${lease.attemptId}` });
  lease = store.worker.publish({ lease, publicationId: `pub-${lease.attemptId}`, candidateCommit: 'b'.repeat(40), sourceHash: H('d'), artifacts: ['candidate'] }).lease;
  const keys = ['projectId', 'runId', 'taskId', 'attemptId', 'generation', 'projectRevision', 'specRevision', 'planRevision', 'baseCommit', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash', 'candidateCommit', 'sourceHash'];
  const binding = Object.fromEntries(keys.map(key => [key, lease[key]])), validationId = `verify-${lease.attemptId}`;
  const receipts = { test: { role: 'test', kind: 'independent', binding, manifestHash: H('a'), status: 'passed', terminationConfirmed: true, checks: [{ id: 'http', passed: true }] },
    browser: { role: 'browser', kind: 'independent', binding, manifestHash: H('b'), status: 'passed', terminationConfirmed: true, checks: [{ id: 'view', passed: true }] },
    review: { role: 'review', kind: 'independent', binding, manifestHash: H('c'), status: 'completed', issues: [] } };
  assert.equal(store.control.recordValidation({ lease, validationId, receipts }).eligible, true);
  assert.equal(store.worker.finish({ lease, validationId }).completed, true);
  return { lease, validationId };
}
const reopen = (store, extra = {}) => store.control.reopenTasks({ runId: 'r', expectedVersion: 1, taskIds: ['A'], reworkId: 'integration-1', evidenceHash: H('e'), ...extra });

test('integration rework invalidates dependency closure while preserving unrelated work, history and budget', async t => {
  const { store } = await fixture(t), oldA = complete(store, 'A'); complete(store, 'B');
  const before = store.query.getRun('r');
  const result = reopen(store); assert.deepEqual(result.taskIds, ['A', 'FINAL']); assert.equal(result.duplicate, false);
  assert.equal(store.query.getTask('r', 'A').status, 'pending'); assert.equal(store.query.getTask('r', 'FINAL').status, 'pending'); assert.equal(store.query.getTask('r', 'B').status, 'completed');
  assert.deepEqual(store.query.getRun('r').budget, before.budget); assert.equal(store.query.listAttempts('r').find(a => a.attemptId === oldA.lease.attemptId).status, 'completed');
  const next = store.worker.claim({ runId: 'r', taskId: 'A', workerId: 'repair' }); assert.equal(next.lease.generation, oldA.lease.generation + 1); assert.notEqual(next.lease.attemptId, oldA.lease.attemptId);
  assert.equal(store.worker.finish(oldA).current, false); assert.equal(store.query.getTask('r', 'A').status, 'leased');
  assert.equal(store.worker.publish({ lease: oldA.lease, publicationId: oldA.lease.publicationId, candidateCommit: oldA.lease.candidateCommit, sourceHash: oldA.lease.sourceHash, artifacts: ['candidate'] }).current, false);
});
test('same rework is idempotent even after a new generation is claimed; different evidence is rejected', async t => {
  const { store } = await fixture(t); complete(store, 'A'); complete(store, 'B'); reopen(store);
  const next = store.worker.claim({ runId: 'r', taskId: 'A', workerId: 'repair' });
  assert.equal(reopen(store).duplicate, true); assert.equal(store.query.getTask('r', 'A').currentAttemptId, next.lease.attemptId);
  assert.throws(() => reopen(store, { evidenceHash: H('f') }), { code: 'conflict' });
  assert.equal(store.query.events({ runId: 'r', limit: 100 }).events.filter(e => e.type === 'tasks_reopened').length, 1);
});
test('rework refuses in-flight or unknown historical activity without clearing reservation', async t => {
  const { store, filename } = await fixture(t); const old = complete(store, 'A'); complete(store, 'B');
  const active = store.worker.claim({ runId: 'r', taskId: 'FINAL', workerId: 'checking' });
  assert.throws(() => reopen(store), { code: 'conflict' });
  store.control.confirmStopped({ attemptId: active.lease.attemptId, evidenceId: 'stop-final' });
  store.control.settle({ attemptId: active.lease.attemptId, settlementId: 'usage-final', usage: { calls: 1, tokens: 5 } });
  store.worker.finish({ lease: active.lease, outcome: 'failed', reason: 'integration blocker' });
  const db = new DatabaseSync(filename); try { db.prepare("UPDATE reservations SET state='unknown',actual_tokens=NULL WHERE attempt_id=?").run(old.lease.attemptId); } finally { db.close(); }
  const budget = store.query.getRun('r').budget; assert.throws(() => reopen(store), { code: 'conflict' });
  assert.equal(store.query.getTask('r', 'A').status, 'completed'); assert.deepEqual(store.query.getRun('r').budget, budget); assert.equal(budget.unknown, 1);
});
test('rework cannot resurrect cancellation, a stale version or an unfinished root', async t => {
  const { store } = await fixture(t); assert.throws(() => reopen(store), { code: 'conflict' }); complete(store, 'A'); complete(store, 'B');
  assert.throws(() => reopen(store, { expectedVersion: 2 }), { code: 'conflict' });
  assert.throws(() => reopen(store, { taskIds: ['missing'] }), { code: 'not_found' });
  store.control.requestCancel('r'); assert.throws(() => reopen(store), { code: 'conflict' }); assert.equal(store.query.getTask('r', 'A').status, 'completed');
});
test('transitive closure is computed from stored dependencies, never supplied as a completed list', async t => {
  const { store } = await fixture(t, [definition('A'), definition('B', ['A']), definition('C'), definition('D', ['B']), definition('FINAL', ['C', 'D'])]);
  for (const taskId of ['A', 'B', 'C', 'D']) complete(store, taskId);
  assert.deepEqual(reopen(store).taskIds, ['A', 'B', 'D', 'FINAL']); assert.equal(store.query.getTask('r', 'C').status, 'completed');
});
test('controller may reduce a new generation reservation but neither controller nor worker may expand it', async t => {
  const { store } = await fixture(t); complete(store, 'A'); complete(store, 'B'); reopen(store);
  const value = { runId: 'r', taskId: 'A', expectedVersion: 1, baseCommit: commit, evidenceId: 'remaining-quota' };
  assert.throws(() => store.control.bindTaskBase({ ...value, reservation: { calls: 3, tokens: 100 } }), { code: 'invalid_input' });
  store.control.bindTaskBase({ ...value, reservation: { calls: 1, tokens: 50 } });
  assert.throws(() => store.worker.claim({ runId: 'r', taskId: 'A', workerId: 'repair', reserve: { calls: 2, tokens: 100 } }), { code: 'invalid_input' });
  const next = store.worker.claim({ runId: 'r', taskId: 'A', workerId: 'repair' }); assert.equal(next.task.reservation.calls, 1);
  assert.equal(store.query.getRun('r').budget.committed.calls, 3);
});
