import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { openTaskStore } from '../lib/task-store.mjs';

const h = value => value.repeat(64), initial = 'a'.repeat(40), integrated = 'b'.repeat(40);
const task = (id = 'A', dependsOn = [], extra = {}) => ({ id, description: `实现${id}`, inputs: ['当前确认规格'], outputs: ['固定候选及独立收据'], dependsOn, writablePaths: [`src/${id}.mjs`], acceptance: ['同版本业务正常及异常断言'], baseCommit: initial,
  manifests: { test: { hash: h('d'), checkIds: ['HTTP-1', 'HTTP-2'] }, browser: { hash: h('e'), checkIds: ['BROWSER-1'] }, review: { hash: h('f') } }, reservation: { calls: 2, tokens: 100 }, ...extra });
const run = (time, tasks = [task()], extra = {}) => ({ projectId: 'project', runId: 'run', projectRevision: h('1'), specRevision: h('2'), planRevision: h('3'), tasks, budget: { calls: 30, tokens: 3000 }, deadlineAt: time + 60000, ...extra });
async function fixture(t, realClock = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-store-execution-')), filename = path.join(root, 'tasks.sqlite'), stores = []; let time = 1000;
  const now = () => realClock ? Date.now() : time, open = () => { const store = openTaskStore({ filename, now }); stores.push(store); return store; }, store = open();
  t.after(async () => { for (const connection of stores) connection.close(); const relative = path.relative(path.resolve(os.tmpdir()), root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(root).startsWith('task-store-execution-')); await rm(root, { recursive: true, force: true }); });
  return { store, filename, open, now, advance: value => { time += value; } };
}
const bind = (store, patch = {}) => store.control.bindTaskBase({ runId: 'run', taskId: 'A', expectedVersion: 1, baseCommit: integrated, evidenceId: 'integration-evidence', ...patch });
const stop = (store, lease, suffix = '') => store.control.confirmStopped({ attemptId: lease.attemptId, evidenceId: 'stop-' + lease.generation + suffix });
const settle = (store, lease, usage = { calls: 1, tokens: 30 }, suffix = '') => store.control.settle({ attemptId: lease.attemptId, settlementId: 'settled-' + lease.generation + suffix, usage });
function receipts(lease, definition = task()) {
  const keys = ['projectId', 'runId', 'taskId', 'attemptId', 'generation', 'projectRevision', 'specRevision', 'planRevision', 'baseCommit', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash', 'candidateCommit', 'sourceHash'];
  const binding = Object.fromEntries(keys.map(key => [key, lease[key]]));
  return { test: { role: 'test', kind: 'independent', binding, manifestHash: definition.manifests.test.hash, status: 'passed', terminationConfirmed: true, checks: definition.manifests.test.checkIds.map(id => ({ id, passed: true })) },
    browser: { role: 'browser', kind: 'independent', binding, manifestHash: definition.manifests.browser.hash, status: 'passed', terminationConfirmed: true, checks: definition.manifests.browser.checkIds.map(id => ({ id, passed: true })) },
    review: { role: 'review', kind: 'independent', binding, manifestHash: definition.manifests.review.hash, status: 'completed', issues: [] } };
}
function complete(store, claimed, suffix = '') { const lease = store.worker.publish({ lease: claimed.lease, publicationId: 'publication-' + claimed.task.id + suffix, candidateCommit: 'c'.repeat(40), sourceHash: h('9') }).lease; const validationId = 'validation-' + claimed.task.id + suffix; store.control.recordValidation({ lease, validationId, receipts: receipts(lease, claimed.task) }); store.worker.finish({ lease, validationId }); return lease; }
async function contenders(filename, actions) {
  const module = new URL('../lib/task-store.mjs', import.meta.url).href;
  const children = actions.map((action, index) => spawn(process.execPath, ['--input-type=module', '-e', `import {openTaskStore} from ${JSON.stringify(module)};const store=openTaskStore({filename:${JSON.stringify(filename)}});process.on('message',message=>{if(message!=='go')return;try{const value=${action === 'bind' ? "store.control.bindTaskBase({runId:'run',taskId:'B',expectedVersion:1,baseCommit:'b'.repeat(40),evidenceId:'child-integration'})" : `store.worker.claim({runId:'run',taskId:'B',workerId:'child-${index}',leaseMs:10000})`};process.send({action:${JSON.stringify(action)},value});}catch(error){process.send({action:${JSON.stringify(action)},error:{code:error.code,message:error.message}});}finally{store.close();process.disconnect();}});process.send({ready:true});`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const ready = [], results = [], exits = []; let stderr = '';
  for (const child of children) {
    ready.push(new Promise((resolve, reject) => { child.on('message', message => { if (message.ready) resolve(); }); child.once('error', reject); child.once('exit', () => reject(new Error('child exited before ready'))); }));
    results.push(new Promise((resolve, reject) => { child.on('message', message => { if (!message.ready) resolve(message); }); child.once('error', reject); child.once('exit', () => reject(new Error('child exited before result'))); }));
    exits.push(new Promise((resolve, reject) => { child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); }));
  }
  const all = Promise.all([...results, ...exits]); all.catch(() => {}); let timer;
  try { await Promise.race([Promise.all(ready), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child readiness timed out')), 15000); })]); clearTimeout(timer); for (const child of children) child.send('go'); await Promise.race([all, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child transaction timed out')), 15000); })]); return await Promise.all(results); }
  finally { clearTimeout(timer); for (const child of children) if (child.exitCode === null) child.kill(); }
}

test('controller base binding is visible cross-connection and records exact old/new/evidence/version without spending budget', async t => {
  const f = await fixture(t), a = f.store, b = f.open(); a.control.createRun(run(f.now(), [task('A'), task('B')])); const before = b.query.getTask('run', 'B'), budget = b.query.getRun('run').budget;
  assert.equal(a.worker.bindTaskBase, undefined); const bound = bind(a, { taskId: 'B' }); assert.deepEqual(bound, { ...before, baseCommit: integrated }); assert.deepEqual(b.query.getTask('run', 'B'), bound); assert.deepEqual(b.query.getRun('run').budget, budget);
  const event = b.query.events().events.find(event => event.type === 'task_base_bound'); assert.equal(event.taskId, 'B'); assert.equal(event.version, 1); assert.deepEqual(event.payload, { previousBaseCommit: initial, baseCommit: integrated, evidenceId: 'integration-evidence', version: 1 });
  const selected = b.worker.claim({ runId: 'run', taskId: 'B', workerId: 'specific', baseCommit: 'f'.repeat(40) }); assert.equal(selected.task.id, 'B'); assert.equal(selected.lease.baseCommit, integrated); assert.equal(selected.task.baseCommit, integrated); assert.equal(a.query.getTask('run', 'A').status, 'pending');
});
test('base cannot be changed before dependencies finish and dependency acceptance remains complete', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task(), task('B', ['A'])])); const before = s.query.events().cursor;
  assert.throws(() => bind(s, { taskId: 'B' }), { code: 'conflict' }); assert.equal(s.query.events().cursor, before); assert.equal(s.query.getTask('run', 'B').baseCommit, initial);
  const parent = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'parent' }); assert.throws(() => s.worker.finish({ lease: parent.lease, passed: true }), { code: 'validation_required' });
  complete(s, parent); assert.equal(bind(s, { taskId: 'B' }).baseCommit, integrated); assert.equal(s.worker.claim({ runId: 'run', taskId: 'B', workerId: 'child' }).lease.baseCommit, integrated);
});
test('paused pending task may bind but cannot claim until resume; cancelled and completed runs reject binding', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); s.control.pause('run'); assert.equal(bind(s).baseCommit, integrated); assert.equal(s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'one' }), null);
  s.control.resume('run'); const claimed = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'one' }); assert.equal(claimed.lease.baseCommit, integrated); complete(s, claimed); assert.throws(() => bind(s), { code: 'conflict' });
  s.control.createRun(run(f.now(), [task()], { runId: 'cancelled' })); s.control.requestCancel('cancelled'); assert.throws(() => bind(s, { runId: 'cancelled' }), { code: 'conflict' }); s.control.confirmCancel('cancelled'); assert.throws(() => bind(s, { runId: 'cancelled' }), { code: 'conflict' });
});
test('invalid ids/versions/commits and stale expectedVersion roll back without a base event', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); const before = s.query.events().cursor;
  for (const patch of [{ evidenceId: '' }, { evidenceId: 'x'.repeat(129) }, { taskId: '../A' }, { expectedVersion: 0 }, { expectedVersion: '1' }, { baseCommit: 'A'.repeat(40) }, { baseCommit: 'a'.repeat(39) }]) assert.throws(() => bind(s, patch), { code: 'invalid_input' });
  assert.throws(() => bind(s, { expectedVersion: 2 }), { code: 'conflict' }); assert.throws(() => bind(s, { taskId: 'missing' }), { code: 'not_found' }); assert.equal(s.query.events().cursor, before); assert.equal(s.query.getTask('run', 'A').baseCommit, initial);
});
test('a current lease forbids base mutation even after independent stop and final accounting', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); const lease = s.worker.claim({ runId: 'run', workerId: 'one' }).lease;
  stop(s, lease); settle(s, lease); assert.throws(() => bind(s), { code: 'conflict' }); assert.equal(s.worker.heartbeat({ lease }).current, true); assert.equal(s.query.listAttempts('run')[0].baseCommit, initial);
});
test('failed task requires both confirmed termination and final known usage before rebasing', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); const lease = s.worker.claim({ runId: 'run', workerId: 'one' }).lease; s.worker.finish({ lease, outcome: 'failed', reason: 'controlled failure' });
  assert.throws(() => bind(s), { code: 'conflict' }); stop(s, lease); assert.throws(() => bind(s), { code: 'conflict' }); settle(s, lease, { calls: 1, tokens: null }, '-partial'); assert.throws(() => bind(s), { code: 'conflict' }); settle(s, lease, { calls: 1, tokens: 30 });
  assert.equal(bind(s).baseCommit, integrated); const next = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'two' }).lease; assert.equal(next.baseCommit, integrated); assert.equal(next.generation, 2); assert.equal(s.query.listAttempts('run').find(attempt => attempt.attemptId === lease.attemptId).baseCommit, initial);
});
test('final settlement alone is insufficient, while known zero usage is a valid final settlement after stop', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); const lease = s.worker.claim({ runId: 'run', workerId: 'one' }).lease; s.worker.finish({ lease, outcome: 'failed', reason: 'not dispatched' }); settle(s, lease, { calls: 0, tokens: 0 });
  assert.throws(() => bind(s), { code: 'conflict' }); stop(s, lease); assert.equal(bind(s).baseCommit, integrated); assert.deepEqual(s.query.getRun('run').budget.committed, { calls: 0, tokens: 0 });
});
test('default expired retry remains unchanged but every older generation must settle and stop before binding', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); const first = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'one', leaseMs: 5 }).lease; f.advance(6);
  const second = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'two' }).lease; assert.equal(second.generation, 2); assert.equal(s.query.listAttempts('run').find(value => value.attemptId === first.attemptId).terminationState, 'unknown');
  s.worker.finish({ lease: second, outcome: 'failed', reason: 'controlled failure' }); stop(s, second); settle(s, second); assert.throws(() => bind(s), { code: 'conflict' }); stop(s, first); settle(s, first); assert.equal(bind(s).baseCommit, integrated);
  const third = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'three' }).lease; assert.equal(third.generation, 3); assert.equal(third.baseCommit, integrated); assert.equal(s.worker.heartbeat({ lease: first }).current, false); assert.throws(() => s.worker.heartbeat({ lease: { ...first, baseCommit: integrated } }), { code: 'stale_lease' });
});
test('same task id across plan versions cannot hide unsettled superseded attempts or revive old validation', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); const old = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'old' }).lease;
  s.control.replacePlan({ runId: 'run', expectedVersion: 1, projectRevision: h('4'), specRevision: h('5'), planRevision: h('6'), tasks: [task()] }); assert.throws(() => bind(s, { expectedVersion: 1 }), { code: 'conflict' }); assert.throws(() => bind(s, { expectedVersion: 2 }), { code: 'conflict' });
  stop(s, old); settle(s, old); assert.equal(bind(s, { expectedVersion: 2 }).version, 2); const fresh = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'new' }).lease; assert.equal(fresh.baseCommit, integrated); assert.equal(fresh.specRevision, h('5'));
  const late = s.worker.publish({ lease: old, publicationId: 'old-publication', candidateCommit: 'c'.repeat(40), sourceHash: h('9') }); assert.equal(late.current, false); assert.equal(s.control.recordValidation({ lease: late.lease, validationId: 'old-validation', receipts: receipts(late.lease) }).current, false); assert.equal(s.worker.finish({ lease: late.lease, validationId: 'old-validation' }).completed, false); assert.equal(s.query.getTask('run', 'A').status, 'leased');
});
test('specific claim never falls back from missing, blocked, unaffordable or already claimed tasks', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task(), task('B', [], { reservation: { calls: 3, tokens: 120 } }), task('C', ['A'])], { budget: { calls: 3, tokens: 120 } }));
  for (const taskId of ['missing', 'C']) assert.equal(s.worker.claim({ runId: 'run', taskId, workerId: 'none' }), null); assert.throws(() => s.worker.claim({ runId: 'run', taskId: '../A', workerId: 'none' }), { code: 'invalid_input' });
  const first = s.worker.claim({ runId: 'run', workerId: 'default' }); assert.equal(first.task.id, 'A'); assert.equal(s.worker.claim({ runId: 'run', taskId: 'B', workerId: 'no-fallback' }), null); assert.equal(s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'no-duplicate' }), null); assert.equal(s.query.listAttempts('run').length, 1);
});
test('missing final reservation cannot be mistaken for a settled old attempt', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now())); const lease = s.worker.claim({ runId: 'run', workerId: 'one' }).lease; s.worker.finish({ lease, outcome: 'failed', reason: 'controlled failure' }); stop(s, lease);
  const database = new DatabaseSync(f.filename); try { database.prepare('DELETE FROM reservations WHERE attempt_id=?').run(lease.attemptId); } finally { database.close(); } assert.throws(() => bind(s), { code: 'conflict' });
});
test('rebased attempts still require complete current independent evidence and cannot reuse older receipts', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task(), task('B', ['A'])])); let old = s.worker.claim({ runId: 'run', workerId: 'old' }).lease; old = s.worker.publish({ lease: old, publicationId: 'old', candidateCommit: 'c'.repeat(40), sourceHash: h('9') }).lease; const oldReceipts = receipts(old);
  s.worker.finish({ lease: old, outcome: 'failed', reason: 'controlled failure' }); stop(s, old); settle(s, old); bind(s); let fresh = s.worker.claim({ runId: 'run', taskId: 'A', workerId: 'new' }).lease; fresh = s.worker.publish({ lease: fresh, publicationId: 'new', candidateCommit: 'd'.repeat(40), sourceHash: h('8') }).lease;
  assert.throws(() => s.worker.finish({ lease: fresh, passed: true }), { code: 'validation_required' }); assert.throws(() => s.control.recordValidation({ lease: fresh, validationId: 'borrowed', receipts: oldReceipts }), { code: 'invalid_receipt' }); const incomplete = receipts(fresh); incomplete.test.checks.pop(); assert.throws(() => s.control.recordValidation({ lease: fresh, validationId: 'incomplete', receipts: incomplete }), { code: 'invalid_receipt' });
  s.control.recordValidation({ lease: fresh, validationId: 'current', receipts: receipts(fresh) }); assert.equal(s.worker.finish({ lease: fresh, validationId: 'current' }).completed, true); assert.equal(s.worker.claim({ runId: 'run', taskId: 'B', workerId: 'downstream' }).task.id, 'B');
});
test('two real child connections targeting the same task create one lease and never claim another ready task', async t => {
  const f = await fixture(t, true); f.store.control.createRun(run(f.now(), [task(), task('B')])); const result = await contenders(f.filename, ['claim', 'claim']); assert.equal(result.filter(value => value.value).length, 1); assert.equal(result.filter(value => value.error).length, 0); assert.equal(f.store.query.listAttempts('run').length, 1); assert.equal(f.store.query.listAttempts('run')[0].taskId, 'B'); assert.equal(f.store.query.getTask('run', 'A').status, 'pending');
});
test('real child base-binding versus targeted claim has one transactional ordering and an immutable lease base', async t => {
  const f = await fixture(t, true); f.store.control.createRun(run(f.now(), [task(), task('B')])); const result = await contenders(f.filename, ['bind', 'claim']), binding = result.find(value => value.action === 'bind'), claiming = result.find(value => value.action === 'claim'); assert.ok(claiming.value);
  if (binding.value) { assert.equal(claiming.value.lease.baseCommit, integrated); const events = f.store.query.events().events; assert.ok(events.find(value => value.type === 'task_base_bound').seq < events.find(value => value.type === 'claimed').seq); } else { assert.equal(binding.error.code, 'conflict'); assert.equal(claiming.value.lease.baseCommit, initial); }
  assert.equal(f.store.query.listAttempts('run').length, 1); assert.equal(f.store.query.getTask('run', 'B').baseCommit, claiming.value.lease.baseCommit); assert.equal(f.store.query.getTask('run', 'A').status, 'pending');
});
