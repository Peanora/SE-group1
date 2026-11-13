import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openTaskStore } from '../lib/task-store.mjs';

const h = char => char.repeat(64);
const task = (id = 'A', dependsOn = []) => ({ id, description: `实现${id}`, inputs: ['已确认规格'], outputs: ['候选代码及产物引用'], dependsOn, writablePaths: [`src/${id}.mjs`], acceptance: ['业务正常及异常检查通过'], baseCommit: 'a'.repeat(40), manifests: { test: { hash: h('d'), checkIds: ['TEST-1', 'TEST-2'] }, browser: { hash: h('e'), checkIds: ['BROWSER-1'] }, review: { hash: h('f') } }, reservation: { calls: 2, tokens: 100 } });
const run = (now, tasks = [task(), task('B', ['A'])], extra = {}) => ({ projectId: 'project', runId: 'run', projectRevision: h('a'), specRevision: h('b'), planRevision: h('c'), tasks, budget: { calls: 20, tokens: 1000 }, deadlineAt: now + 60000, ...extra });
const bindingKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'generation', 'projectRevision', 'specRevision', 'planRevision', 'baseCommit', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash', 'candidateCommit', 'sourceHash'];
function receipts(lease, definition = task()) {
  const binding = Object.fromEntries(bindingKeys.map(key => [key, lease[key]]));
  return {
    test: { role: 'test', kind: 'independent', binding, manifestHash: definition.manifests.test.hash, status: 'passed', terminationConfirmed: true, checks: definition.manifests.test.checkIds.map(id => ({ id, passed: true })) },
    browser: { role: 'browser', kind: 'independent', binding, manifestHash: definition.manifests.browser.hash, status: 'passed', terminationConfirmed: true, checks: definition.manifests.browser.checkIds.map(id => ({ id, passed: true })) },
    review: { role: 'review', kind: 'independent', binding, manifestHash: definition.manifests.review.hash, status: 'completed', issues: [] },
  };
}
async function fixture(t, fixed = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-store-test-'));
  const filename = path.join(root, 'tasks.sqlite'), stores = [];
  let time = 1000;
  const clock = () => fixed ? time : Date.now();
  const open = () => { const store = openTaskStore({ filename, now: clock }); stores.push(store); return store; };
  const store = open();
  t.after(async () => {
    for (const connection of stores) connection.close();
    const relative = path.relative(path.resolve(os.tmpdir()), root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  return { store, filename, open, now: clock, advance: amount => { time += amount; } };
}
function publish(store, lease, publicationId = 'publication') { return store.worker.publish({ lease, publicationId, candidateCommit: 'b'.repeat(40), sourceHash: h('1'), artifacts: ['candidate-code'] }).lease; }
function validate(store, lease, validationId = 'validation', value = receipts(lease)) { return store.control.recordValidation({ lease, validationId, receipts: value }); }
async function childrenClaim(filename, runId = 'run') {
  const moduleUrl = new URL('../lib/task-store.mjs', import.meta.url).href;
  const children = [0, 1].map(index => spawn(process.execPath, ['--input-type=module', '-e', `import {openTaskStore} from ${JSON.stringify(moduleUrl)};const store=openTaskStore({filename:${JSON.stringify(filename)}});process.on('message',message=>{if(message==='go'){try{const result=store.worker.claim({runId:${JSON.stringify(runId)},workerId:'child-${index}',leaseMs:10000});process.send({claimed:!!result,attemptId:result?.lease.attemptId,workspaceKey:result?.lease.workspaceKey});store.close();process.disconnect();}catch(error){process.send({error:error.message});store.close();process.disconnect();}}});process.send({ready:true});`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  let stderr = '';
  const exits = children.map(child => new Promise((resolve, reject) => { child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); }));
  const outcomes = children.map(child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('claim child timed out')); }, 15000);
    child.on('message', message => { if (!message.ready) { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('claim child exited before returning a result')); });
  }));
  const finished = Promise.all([...outcomes, ...exits]); finished.catch(() => {});
  try {
    await Promise.all(children.map(child => new Promise((resolve, reject) => { child.on('message', message => { if (message.ready) resolve(); }); child.once('error', reject); child.once('exit', () => reject(new Error('claim child exited before ready'))); })));
    for (const child of children) child.send('go');
    const results = await Promise.all(outcomes); await Promise.all(exits); return results;
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
}

test('任务DAG、范围、验收、可信清单和预留先原子校验', async t => {
  const f = await fixture(t), { store } = f;
  for (const tasks of [[], [task(), task()], [task('A', ['unknown'])], [task('A', ['B']), task('B', ['A'])], [{ ...task(), acceptance: [' '] }], [{ ...task(), writablePaths: ['../src/x.mjs'] }], [{ ...task(), reservation: { calls: 0, tokens: 100 } }], [{ ...task(), manifests: { ...task().manifests, test: { hash: h('d'), checkIds: [] } } }]]) {
    assert.throws(() => store.control.createRun(run(f.now(), tasks)), { code: 'invalid_input' });
  }
  assert.equal(store.query.events().events.length, 0);
  const created = store.control.createRun(run(f.now())); assert.equal(created.version, 1);
  assert.equal(store.worker.recordValidation, undefined); assert.equal(store.worker.settle, undefined);
});

test('两个真实child连接同时抢同任务，只有一个原子认领和预留', async t => {
  const f = await fixture(t, false); f.store.control.createRun(run(f.now(), [task()]));
  const results = await childrenClaim(f.filename);
  assert.equal(results.filter(item => item.claimed).length, 1);
  assert.equal(f.store.query.listAttempts('run').length, 1);
  assert.deepEqual(f.store.query.getRun('run').budget.committed, { calls: 2, tokens: 100 });
  assert.equal(f.store.query.events().events.filter(item => item.type === 'claimed').length, 1);
});

test('两个真实child抢不同就绪任务仍不能透支共享预算', async t => {
  const f = await fixture(t, false); f.store.control.createRun(run(f.now(), [task('A'), task('B')], { budget: { calls: 2, tokens: 100 } }));
  const results = await childrenClaim(f.filename);
  assert.equal(results.filter(item => item.claimed).length, 1);
  assert.equal(f.store.query.listAttempts('run').length, 1);
});

test('只有完整同版本独立收据完成任务；幂等finish只释放一次下游', async t => {
  const f = await fixture(t), { store } = f; store.control.createRun(run(f.now()));
  const first = store.worker.claim({ runId: 'run', workerId: 'one' }); assert.equal(first.task.id, 'A');
  assert.equal(store.worker.claim({ runId: 'run', workerId: 'two' }), null);
  let lease = publish(store, first.lease);
  assert.throws(() => store.worker.finish({ lease, passed: true }), { code: 'validation_required' });
  assert.equal(validate(store, lease).eligible, true);
  assert.equal(store.worker.finish({ lease, validationId: 'validation' }).completed, true);
  const before = store.query.events().cursor;
  assert.equal(store.worker.finish({ lease, validationId: 'validation' }).duplicate, true);
  assert.equal(store.query.events().cursor, before);
  assert.throws(() => store.worker.finish({ lease, validationId: 'forged' }), { code: 'conflict' });
  assert.equal(store.worker.claim({ runId: 'run', workerId: 'two' }).task.id, 'B');
});

test('发布回调幂等；相同publicationId对应不同结果冲突，身份字段严格匹配', async t => {
  const f = await fixture(t), { store } = f; store.control.createRun(run(f.now(), [task()]));
  const lease = store.worker.claim({ runId: 'run', workerId: 'one' }).lease;
  for (const patch of [{ leaseToken: 'wrong' }, { generation: 2 }, { specRevision: h('8') }, { planRevision: h('8') }, { projectRevision: h('8') }, { baseCommit: 'c'.repeat(40) }, { manifestHash: h('8') }, { browserManifestHash: h('8') }, { reviewPolicyHash: h('8') }]) assert.throws(() => store.worker.heartbeat({ lease: { ...lease, ...patch } }), { code: 'stale_lease' });
  const input = { lease, publicationId: 'publication', candidateCommit: 'b'.repeat(40), sourceHash: h('1'), artifacts: ['candidate-code'] };
  const published = store.worker.publish(input);
  const before = store.query.events().cursor;
  assert.equal(store.worker.publish(input).duplicate, true); assert.equal(store.query.events().cursor, before);
  assert.throws(() => store.worker.publish({ ...input, sourceHash: h('2') }), { code: 'conflict' });
  assert.throws(() => store.worker.publish({ ...input, resultHash: h('2') }), { code: 'conflict' });
  assert.throws(() => store.worker.publish({ ...input, lease: published.lease, publicationId: 'new-publication' }), { code: 'conflict' });
  assert.throws(() => store.worker.heartbeat({ lease }), { code: 'stale_candidate' });
  assert.equal(store.worker.heartbeat({ lease: published.lease }).current, true);
});

test('租约过期只保留晚结果历史，新attempt独立workspace且旧worker不能完成', async t => {
  const f = await fixture(t), { store } = f; store.control.createRun(run(f.now(), [task()]));
  const first = store.worker.claim({ runId: 'run', workerId: 'old', leaseMs: 10 }).lease;
  f.advance(11);
  const next = store.worker.claim({ runId: 'run', workerId: 'new', leaseMs: 100 }).lease;
  assert.notEqual(next.workspaceKey, first.workspaceKey); assert.notEqual(next.leaseToken, first.leaseToken); assert.equal(next.generation, first.generation + 1);
  const old = store.worker.publish({ lease: first, publicationId: 'late', candidateCommit: 'b'.repeat(40), sourceHash: h('1') }); assert.equal(old.current, false);
  assert.equal(validate(store, old.lease).current, false);
  assert.deepEqual(store.worker.finish({ lease: old.lease, validationId: 'validation' }), { current: false, completed: false });
  assert.equal(store.worker.finish({ lease: old.lease, validationId: 'validation' }).current, false);
  assert.equal(store.worker.heartbeat({ lease: old.lease }).current, false);
  assert.equal(store.query.getTask('run', 'A').status, 'leased');
  assert.equal(store.query.listAttempts('run').find(attempt => attempt.attemptId === first.attemptId).terminationState, 'unknown');
});

test('重启保留有效lease与未知进程，不自动标记失败或停止', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()]));
  const first = s.worker.claim({ runId: 'run', workerId: 'one', leaseMs: 100 }).lease; s.close();
  const restarted = f.open();
  assert.equal(restarted.query.getRun('run').status, 'running');
  assert.equal(restarted.query.listAttempts('run')[0].terminationState, 'unknown');
  assert.equal(restarted.worker.claim({ runId: 'run', workerId: 'two' }), null);
  assert.equal(restarted.worker.heartbeat({ lease: first, leaseMs: 100 }).current, true);
  f.advance(101); assert.ok(restarted.worker.claim({ runId: 'run', workerId: 'two' }));
});

test('换spec/plan/project版本失效旧lease，旧完成历史不自动继承', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now()));
  const a = publish(s, s.worker.claim({ runId: 'run', workerId: 'one' }).lease); validate(s, a); s.worker.finish({ lease: a, validationId: 'validation' });
  const b = s.worker.claim({ runId: 'run', workerId: 'two' }).lease;
  s.control.replacePlan({ runId: 'run', expectedVersion: 1, projectRevision: h('4'), specRevision: h('5'), planRevision: h('6'), tasks: [task(), task('B', ['A'])] });
  assert.equal(s.query.getTask('run', 'A', 1).status, 'completed'); assert.equal(s.query.getTask('run', 'A').status, 'pending');
  const late = s.worker.publish({ lease: b, publicationId: 'old-B', candidateCommit: 'b'.repeat(40), sourceHash: h('1') }); assert.equal(late.current, false);
  assert.equal(s.worker.finish({ lease: late.lease, validationId: 'none' }).current, false);
  assert.equal(s.worker.finish({ lease: a, validationId: 'validation' }).completed, false);
  assert.throws(() => s.control.replacePlan({ runId: 'run', expectedVersion: 1, projectRevision: h('7'), specRevision: h('8'), planRevision: h('9'), tasks: [task()] }), { code: 'conflict' });
  assert.equal(s.worker.claim({ runId: 'run', workerId: 'new' }).task.id, 'A');
});

test('收据须完整角色、版本、commit、source和固定清单；新失败覆盖旧通过', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()])); const lease = publish(s, s.worker.claim({ runId: 'run', workerId: 'one' }).lease);
  const mutations = [value => { delete value.browser; }, value => { value.test.kind = 'self_check'; }, value => { value.test.binding.candidateCommit = 'c'.repeat(40); }, value => { value.test.binding.specRevision = h('7'); }, value => { value.test.manifestHash = h('7'); }, value => { value.test.checks.pop(); }, value => { value.test.checks = [value.test.checks[0], value.test.checks[0]]; }, value => { value.browser.terminationConfirmed = undefined; }];
  for (const change of mutations) { const value = structuredClone(receipts(lease)); change(value); assert.throws(() => validate(s, lease, 'invalid', value), { code: 'invalid_receipt' }); }
  validate(s, lease, 'pass-one');
  const failed = receipts(lease); failed.review.issues = [{ id: 'ISSUE-1', severity: 'blocking', status: 'open', evidence: '明确阻塞问题' }];
  assert.equal(validate(s, lease, 'blocked', failed).eligible, false);
  assert.equal(validate(s, lease, 'pass-one').duplicate, true);
  assert.throws(() => s.worker.finish({ lease, validationId: 'pass-one' }), { code: 'validation_required' });
  assert.throws(() => s.worker.finish({ lease, validationId: 'blocked' }), { code: 'validation_required' });
  failed.review.issues[0].status = 'resolved'; assert.equal(validate(s, lease, 'closed', failed).eligible, true);
  assert.throws(() => validate(s, lease, 'closed', receipts(lease)), { code: 'conflict' });
  assert.equal(s.worker.finish({ lease, validationId: 'closed' }).completed, true);
});

test('固定预留不能被worker放宽，未知用量和失联不归零，controller已知结算幂等', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()], { budget: { calls: 2, tokens: 100 } }));
  assert.throws(() => s.worker.claim({ runId: 'run', workerId: 'one', reserve: { calls: 0, tokens: 0 } }), { code: 'invalid_input' });
  const lease = s.worker.claim({ runId: 'run', workerId: 'one', leaseMs: 5 }).lease;
  s.control.settle({ attemptId: lease.attemptId, settlementId: 'unknown', usage: { calls: null, tokens: null } });
  f.advance(6); assert.equal(s.worker.claim({ runId: 'run', workerId: 'two' }), null);
  assert.deepEqual(s.query.getRun('run').budget.available, { calls: 0, tokens: 0 });
  const input = { attemptId: lease.attemptId, settlementId: 'known', usage: { calls: 1, tokens: 20 } };
  s.control.settle(input); const before = s.query.events().cursor;
  assert.equal(s.control.settle(input).duplicate, true); assert.equal(s.query.events().cursor, before);
  assert.throws(() => s.control.settle({ ...input, usage: { calls: 0, tokens: 0 } }), { code: 'conflict' });
  assert.deepEqual(s.query.getRun('run').budget.committed, { calls: 1, tokens: 20 });
  assert.equal(s.worker.claim({ runId: 'run', workerId: 'two' }), null); // trusted reservation still needs 2 calls
});

test('暂停只停新派发，已认领任务可保存并独立验收；恢复才认领后继', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now()));
  const first = s.worker.claim({ runId: 'run', workerId: 'one' }).lease; s.control.pause('run');
  assert.equal(s.worker.heartbeat({ lease: first }).current, true); const lease = publish(s, first); validate(s, lease); s.worker.finish({ lease, validationId: 'validation' });
  assert.equal(s.query.getRun('run').status, 'paused'); assert.equal(s.worker.claim({ runId: 'run', workerId: 'two' }), null);
  s.control.resume('run'); assert.equal(s.worker.claim({ runId: 'run', workerId: 'two' }).task.id, 'B');
});

test('取消请求、待协调和确认取消分开；重启不把未知进程当已停止', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()])); const lease = s.worker.claim({ runId: 'run', workerId: 'one' }).lease;
  assert.equal(s.control.requestCancel('run').status, 'cancel_requested'); assert.equal(s.worker.claim({ runId: 'run', workerId: 'two' }), null);
  assert.equal(s.worker.heartbeat({ lease }).current, false); assert.equal(s.control.confirmCancel('run').status, 'reconciliation_required'); s.close();
  const restored = f.open(); assert.equal(restored.query.getRun('run').status, 'reconciliation_required');
  assert.equal(restored.query.listAttempts('run')[0].terminationState, 'unknown');
  restored.control.confirmStopped({ attemptId: lease.attemptId, evidenceId: 'process-exit-record' });
  assert.equal(restored.control.confirmCancel('run').status, 'cancelled');
  assert.equal(restored.query.listAttempts('run')[0].cancelState, 'confirmed');
});

test('总截止时间禁止新认领，已存在lease不越过deadline续期', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()], { deadlineAt: f.now() + 20 }));
  const lease = s.worker.claim({ runId: 'run', workerId: 'one', leaseMs: 1000 }).lease; assert.equal(lease.expiresAt, f.now() + 20);
  f.advance(21); assert.equal(s.worker.heartbeat({ lease }).current, false); assert.equal(s.worker.claim({ runId: 'run', workerId: 'two' }), null);
  assert.equal(s.query.listAttempts('run')[0].terminationState, 'unknown');
});

test('全局事件seq单调唯一，可跨run按cursor补齐，重启后不重排', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()])); s.control.createRun(run(f.now(), [task()], { runId: 'another' }));
  s.worker.claim({ runId: 'run', workerId: 'one' }); s.worker.claim({ runId: 'another', workerId: 'two' });
  const all = s.query.events().events; assert.deepEqual(all.map(item => item.seq), [...new Set(all.map(item => item.seq))].sort((a, b) => a - b));
  let cursor = 0; const collected = []; for (;;) { const page = s.query.events({ after: cursor, limit: 1 }); if (!page.events.length) break; collected.push(...page.events); cursor = page.cursor; }
  assert.deepEqual(collected, all); s.close(); assert.deepEqual(f.open().query.events().events, all);
});

test('失败尝试不释放下游，重复失败幂等且新尝试保留独立workspace和预算', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now()));
  const first = s.worker.claim({ runId: 'run', workerId: 'one' }).lease;
  const failure = { lease: first, outcome: 'failed', reason: '可信自检失败，需要返工' };
  assert.equal(s.worker.finish(failure).completed, false); const cursor = s.query.events().cursor;
  assert.equal(s.worker.finish(failure).duplicate, true); assert.equal(s.query.events().cursor, cursor);
  assert.throws(() => s.worker.finish({ ...failure, reason: '不同回调内容' }), { code: 'conflict' });
  const next = s.worker.claim({ runId: 'run', workerId: 'two' }); assert.equal(next.task.id, 'A'); assert.notEqual(next.lease.workspaceKey, first.workspaceKey);
  assert.equal(s.query.getTask('run', 'B').status, 'pending'); assert.deepEqual(s.query.getRun('run').budget.committed, { calls: 4, tokens: 200 });
  assert.equal(s.query.listAttempts('run').find(attempt => attempt.attemptId === first.attemptId).terminationState, 'unknown');
});

test('已知部分用量不能改写，实际超预留仍真实入账并阻止透支认领', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task('A'), task('B')], { budget: { calls: 4, tokens: 200 } }));
  const lease = s.worker.claim({ runId: 'run', workerId: 'one' }).lease;
  s.control.settle({ attemptId: lease.attemptId, settlementId: 'partial', usage: { calls: 3, tokens: null } });
  assert.deepEqual(s.query.getRun('run').budget.committed, { calls: 3, tokens: 100 }); assert.equal(s.query.getRun('run').budget.unknown, 1);
  assert.throws(() => s.control.settle({ attemptId: lease.attemptId, settlementId: 'changed', usage: { calls: 2, tokens: 120 } }), { code: 'conflict' });
  s.control.settle({ attemptId: lease.attemptId, settlementId: 'final', usage: { calls: 3, tokens: 120 } });
  assert.deepEqual(s.query.getRun('run').budget.committed, { calls: 3, tokens: 120 }); assert.equal(s.query.getRun('run').budget.unknown, 0);
  assert.equal(s.worker.claim({ runId: 'run', workerId: 'two' }), null);
  assert.throws(() => s.control.settle({ attemptId: lease.attemptId, settlementId: 'again', usage: { calls: 3, tokens: 120 } }), { code: 'conflict' });
});

test('测试失败、浏览器未确认停止或Review服务错误都不能完成', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()])); const lease = publish(s, s.worker.claim({ runId: 'run', workerId: 'one' }).lease);
  const changes = [value => { value.test.status = 'failed'; value.test.checks[0].passed = false; }, value => { value.browser.terminationConfirmed = false; }, value => { value.review.status = 'error'; }];
  for (const [index, change] of changes.entries()) {
    const value = receipts(lease); change(value); const validationId = `failure-${index}`;
    assert.equal(validate(s, lease, validationId, value).eligible, false);
    assert.throws(() => s.worker.finish({ lease, validationId, passed: true }), { code: 'validation_required' });
    assert.equal(s.query.getTask('run', 'A').status, 'leased');
  }
  validate(s, lease, 'all-passed'); assert.equal(s.worker.finish({ lease, validationId: 'all-passed' }).completed, true);
  assert.equal(s.query.getRun('run').status, 'succeeded');
});

test('旧版本或截止后的验证收据仍只属于历史，重领不复用通过结论', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now(), [task()]));
  const lease = publish(s, s.worker.claim({ runId: 'run', workerId: 'one', leaseMs: 5 }).lease); f.advance(6);
  assert.equal(validate(s, lease).eligible, true); assert.equal(validate(s, lease).current, false);
  const next = s.worker.claim({ runId: 'run', workerId: 'two' }).lease;
  const newer = publish(s, next, 'new-publication');
  assert.throws(() => s.worker.finish({ lease: newer, validationId: 'validation' }), { code: 'validation_required' });
  assert.equal(s.query.getTask('run', 'A').status, 'leased');
});

test('完成后的晚验收仅记历史，不替换已固定完成收据', async t => {
  const f = await fixture(t), s = f.store; s.control.createRun(run(f.now()));
  const lease = publish(s, s.worker.claim({ runId: 'run', workerId: 'one' }).lease);
  validate(s, lease, 'accepted'); s.worker.finish({ lease, validationId: 'accepted' });
  const late = receipts(lease); late.test.status = 'failed'; late.test.checks[0].passed = false;
  assert.equal(validate(s, lease, 'late-failure', late).current, false);
  assert.equal(s.query.listAttempts('run')[0].validationId, 'accepted');
  assert.ok(s.query.events().events.some(event => event.type === 'validation_recorded' && event.payload.validationId === 'late-failure' && event.payload.current === false));
  assert.equal(s.worker.finish({ lease, validationId: 'accepted' }).duplicate, true);
});
