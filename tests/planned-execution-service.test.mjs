import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPlannedExecutionService } from '../lib/planned-execution-service.mjs';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { verificationModelPolicy } from '../lib/verification-model.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';

// The core below is an inert accounting fixture. It starts no process or model,
// cannot obtain a real execution-result brand and never proves software accepted.
const ids = { projectId: 'project', runId: 'run' };
const config = { baseUrl: 'https://planned-service.synthetic.invalid/v1', model: 'synthetic-planned', apiKey: 'synthetic-private-planned-key' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read, label = '服务状态') { const end = Date.now() + 5000; for (;;) { const value = await read(); if (value) return value; assert.ok(Date.now() < end, `${label}超时`); await new Promise(done => setTimeout(done, 5)); } }
function definition() { return { version: 1, id: 'resources', name: '资源定义', sessions: [], steps: [{ id: 'read', type: 'request', requirementIds: ['R1'], dependsOn: [], request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'ok', op: 'status', value: 200 }] } }], browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } }; }
function planning() {
  const source = { filename: 'requirements.md', content: '用户读取资源列表。' };
  const spec = { title: '资源系统', summary: source.content, goals: ['读取资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取', description: source.content, sourceQuote: source.content, acceptance: ['返回列表'] }] };
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { ...ids, specRevision }, proposal: { version: 1, title: '资源工程', summary: '读取接口', entities: [], routes: [{ id: 'resources', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '资源列表', errors: [], requirementIds: ['R1'] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks: [{ id: 'implement', title: '实现资源', description: '实现读取', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['读取接口'], acceptance: ['可读'] }] } });
  const run = { id: ids.runId, projectId: ids.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, status: 'succeeded', stages: [], spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '读取资源' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: ids.projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planned-service-test-')), data = planning();
  const ledger = [], contexts = [], providerSettings = [], services = [], releases = [], checkpoint = deferred(); let service, verification, row, mode = options.mode ?? 'known', coreCalls = 0, modeCancelled = false;
  const query = sql => { const db = new DatabaseSync(path.join(directory, 'planned', 'planned.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const seedLegacyBudget = () => {
    const db = new DatabaseSync(path.join(directory, 'planned', 'planned.sqlite'));
    try {
      const row = db.prepare('SELECT budget FROM budgets').get();
      const legacy = JSON.stringify({ ...JSON.parse(row.budget), maxAttempts: 3, totalModelCalls: 18 });
      db.prepare('UPDATE budgets SET budget=? WHERE project_id=? AND run_id=?').run(legacy, ids.projectId, ids.runId);
      return legacy;
    } finally { db.close(); }
  };
  const verifyReservation = () => { const [budget] = query('SELECT * FROM budgets'); assert.equal(budget.reserved_calls, 6); assert.equal(budget.attempts, coreCalls + 1); ledger.push('reserved-before-core'); };
  async function openVerification() {
    verification = await createVerificationPlanningService({ rootDir: path.join(directory, 'verification'), getPlanning: () => data, getPlanningSync: () => data, config, timeoutMs: 2000, cleanupMs: 30,
      dependencies: { createModel: () => async input => { const proposal = definition(), usage = { inputTokens: 1, outputTokens: 1 }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(proposal) }); return { proposal, usage, model: config.model, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } });
    services.push(verification);
  }
  async function open(extra = {}) {
    service = await createPlannedExecutionService({ rootDir: path.join(directory, 'planned'), verificationService: verification, getPlanningSync: () => data,
      withCheckpoint: async (_id, work) => { if (options.holdCheckpoint) await checkpoint.promise; return work(); }, config, executable: process.execPath,
      dependencies: { createProvider: value => { providerSettings.push(structuredClone(value.config)); verifyReservation(); return async () => assert.fail('inert core must not call a real provider'); }, createReviewer: () => async () => assert.fail('inert core must not call a real reviewer'),
        startExecution: input => {
          contexts.push(structuredClone(input.task));
          verifyReservation(); coreCalls++;
          const callEntries = [{ role: 'coding', kind: 'model', dispatched: true }, { role: 'review', kind: 'model', dispatched: true,
            candidateCommit: options.versions?.at(0)?.commit, reviewRejection: options.reviewRejection }];
          const owned = { id: randomUUID(), ...input.binding, status: mode === 'fake-accepted' ? 'accepted' : 'failed', terminationConfirmed: true, totalModelCalls: 2, modelCalls: callEntries.map(item => ({ ...item, receiptPath: path.join(directory, 'private-receipt.json') })), versions: structuredClone(options.versions ?? []), usage: { inputTokens: null, outputTokens: null }, workspace: path.join(directory, 'private-workspace'), reportPath: path.join(directory, 'private-report.json'), error: 'synthetic inert failure' };
          const gate = deferred(); releases.push(() => gate.resolve({ ...owned, status: modeCancelled ? 'stopped' : owned.status }));
          const result = mode === 'foreign' ? { ...owned, id: 'foreign-core', terminationConfirmed: false }
            : mode === 'malformed' ? null
            : mode === 'bad-role' ? { ...owned, modelCalls: [{ role: 'free', kind: 'model' }, { role: 'review', kind: 'model' }] }
            : mode === 'negative-calls' ? { ...owned, totalModelCalls: -1 }
            : mode === 'missing-calls' ? { ...owned, totalModelCalls: undefined, modelCalls: undefined }
            : mode === 'mismatch-calls' ? { ...owned, totalModelCalls: 0 }
            : mode === 'unknown' ? { ...owned, status: 'reconciliation_required', terminationConfirmed: false } : owned;
          return { id: owned.id, snapshot: () => structuredClone(owned), cancel: () => { modeCancelled = true; if (mode === 'held') gate.resolve({ ...owned, status: 'stopped' }); }, done: ['held', 'uncooperative'].includes(mode) ? gate.promise : Promise.resolve(result) };
        } }, ...extra });
    services.push(service); return service;
  }
  t.after(async () => {
    checkpoint.resolve(); for (const release of releases) release();
    for (const item of services.reverse()) await item.shutdown();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('planned-service-test-')); await rm(directory, { recursive: true, force: true });
  });
  await openVerification();
  const candidate = (await verification.propose({ ...ids, contractRevision: (await verification.list(ids)).capabilities.contractRevision })).proposal;
  row = await until(async () => (await verification.list(ids)).proposals.find(item => item.id === candidate.id && item.status === 'draft'));
  if (options.approved !== false) row = (await verification.approve({ ...ids, proposalId: row.id, revision: row.revision, feedback: '认可结构定义，不代表执行验收' })).proposal;
  await open(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  return { directory, data, ledger, contexts, providerSettings, query, seedLegacyBudget, checkpoint, get service() { return service; }, get verification() { return verification; }, get row() { return row; }, coreCalls: () => coreCalls,
    release: () => { for (const release of releases) release(); }, mode: value => { mode = value; }, open,
    async reopen(extra = {}, both = false) { await service.shutdown(); if (both) { await verification.shutdown(); await openVerification(); } return open(extra); },
    async input(extra = {}) { return { ...ids, proposalId: row.id, revision: row.revision, contractRevision: (await service.list(ids)).capabilities.contractRevision, ...extra }; },
    async finished() { return until(async () => { const state = await service.list(ids); return state.executions.findLast(item => ['failed', 'accepted', 'stopped', 'reconciliation_required'].includes(item.status)) && state; }); },
  };
}

test('native admission receives each confirmed requirement body and acceptance, beyond the plan summary', async t => {
  const f = await fixture(t); await f.service.start(await f.input()); await f.finished();
  assert.equal(f.contexts.length, 1);
  assert.deepEqual(f.contexts[0].requirements, f.data.run.spec.requirements.map(r => ({ id: r.id, text: `${r.title}\n${r.description}\n${r.acceptance.join('\n')}` })));
  assert.ok(f.contexts[0].requirements[0].text.includes('返回列表'));
  assert.deepEqual(f.contexts[0].engineeringContract.routes, f.data.run.engineeringPlan.proposal.routes);
});

test('service freezes absent model controls, binds explicit changes in contract and keeps prior budget charges', async t => {
  const saved = { LLM_THINKING: process.env.LLM_THINKING, LLM_JSON_MODE: process.env.LLM_JSON_MODE };
  try {
    delete process.env.LLM_THINKING; delete process.env.LLM_JSON_MODE;
    const f = await fixture(t), original = (await f.service.list(ids)).capabilities.contractRevision;
    process.env.LLM_THINKING = 'enabled'; process.env.LLM_JSON_MODE = '0';
    await f.service.start(await f.input()); await f.finished();
    assert.equal(Object.hasOwn(f.providerSettings[0], 'thinking'), true); assert.equal(f.providerSettings[0].thinking, undefined);
    assert.equal(Object.hasOwn(f.providerSettings[0], 'jsonMode'), true); assert.equal(f.providerSettings[0].jsonMode, undefined);
    const before = f.query('SELECT * FROM budgets'); assert.equal(before[0].attempts, 1); assert.equal(before[0].used_calls, 2); assert.equal(before[0].reserved_calls, 0);
    await f.reopen({ config: { ...config, thinking: 'disabled', jsonMode: false } });
    const changed = (await f.service.list(ids)).capabilities.contractRevision; assert.notEqual(changed, original);
    assert.deepEqual(f.query('SELECT * FROM budgets'), before);
    await assert.rejects(f.service.start(await f.input({ contractRevision: original })), error => error.code === 'contract_changed');
    assert.deepEqual(f.query('SELECT * FROM budgets'), before);
    await f.reopen({ config: { ...config, thinking: 'disabled', jsonMode: true } });
    assert.notEqual((await f.service.list(ids)).capabilities.contractRevision, changed); assert.deepEqual(f.query('SELECT * FROM budgets'), before);
    await f.reopen({ config: { ...config, jsonMode: 'invalid' } });
    assert.equal((await f.service.list(ids)).capabilities.canStart, false); assert.deepEqual(f.query('SELECT * FROM budgets'), before);
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('before any native core admission the run budget and six-call reservation are durable', async t => {
  const f = await fixture(t); const before = await f.service.list(ids);
  assert.deepEqual(before.capabilities.budget, { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 3_600_000, unlimited: true,
    maxAttempts: null, remainingAttempts: null, totalModelCalls: null, remainingModelCalls: null });
  await f.service.start(await f.input()); const state = await f.finished();
  assert.equal(f.coreCalls(), 1); assert.equal(f.ledger.length, 2);
  assert.equal(state.executions[0].status, 'failed'); assert.equal(state.capabilities.budget.remainingModelCalls, null);
  const [budget] = f.query('SELECT * FROM budgets'); assert.equal(budget.used_calls, 2); assert.equal(budget.reserved_calls, 0);
  const json = JSON.stringify(state); for (const privateValue of [f.directory, config.apiKey, 'receiptPath', 'private-workspace', 'private-receipt']) assert.equal(json.includes(privateValue), false);
});

test('a new attempt on an existing approved plan gets one hour without changing previous deadlines or usage', async t => {
  const f = await fixture(t, { timeoutMs: 600_000 });
  const before = await f.input();
  const { execution: old } = await f.service.start(before);
  await f.finished();
  assert.equal(old.budget.timeoutMs, 600_000);

  await f.reopen();
  await assert.rejects(f.service.start(before), error => error.code === 'contract_changed');
  const { execution: next } = await f.service.start(await f.input());
  assert.equal(next.budget.timeoutMs, 3_600_000);
  const result = await until(async () => {
    const state = await f.service.list(ids);
    return state.executions.every(row => !row.active) && state;
  });
  assert.equal(result.executions.find(row => row.id === old.id).budget.timeoutMs, 600_000);
  assert.equal(result.executions.find(row => row.id === next.id).budget.timeoutMs, 3_600_000);
  const [ledger] = f.query('SELECT budget, attempts, used_calls, reserved_calls FROM budgets');
  assert.equal(JSON.parse(ledger.budget).timeoutMs, 600_000);
  assert.equal(ledger.attempts, 2);
  assert.equal(ledger.used_calls, 4);
  assert.equal(ledger.reserved_calls, 0);
});

test('unapproved, obsolete, foreign or malformed definition requests do not consume attempts', async t => {
  const f = await fixture(t, { approved: false }); await assert.rejects(f.service.start(await f.input()), error => error.status === 409);
  assert.deepEqual(f.query('SELECT * FROM budgets'), []); assert.equal(f.coreCalls(), 0);
  await f.verification.approve({ ...ids, proposalId: f.row.id, revision: f.row.revision, feedback: '现在认可当前定义' });
  for (const change of [{ proposalId: 'foreign' }, { revision: '0'.repeat(64) }, { projectId: 'foreign' }, { runId: 'foreign' }, { contractRevision: '0'.repeat(64) }, { budget: 999 }, { workspace: 'private' }]) await assert.rejects(f.service.start(await f.input(change)));
  assert.deepEqual(f.query('SELECT * FROM budgets'), []); assert.equal(f.coreCalls(), 0);
  f.data.run.sourceSuperseded = true; await assert.rejects(f.service.start(await f.input()), error => error.status === 409);
  assert.deepEqual(f.query('SELECT * FROM budgets'), []);
});

for (const mode of ['foreign', 'malformed', 'bad-role', 'negative-calls', 'missing-calls', 'mismatch-calls', 'unknown']) test(`unattributable or unknown core result keeps the original reservation: ${mode}`, async t => {
  const f = await fixture(t, { mode }); await f.service.start(await f.input()); const state = await f.finished();
  assert.equal(state.executions[0].status, 'reconciliation_required'); assert.equal(state.executions[0].active, true); assert.equal(state.capabilities.canStart, false);
  const [budget] = f.query('SELECT * FROM budgets'); assert.equal(budget.reserved_calls, 6); assert.equal(budget.used_calls, 0); assert.equal(state.capabilities.budget.remainingModelCalls, null);
  await assert.rejects(f.service.cancel({ ...ids, executionId: state.executions[0].id }), error => error.status === 409);
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('unknown cannot release project checkpoint')), error => error.status === 409);
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('unknown core cannot release source/delete checkpoint')));
  await f.reopen({}, true); const reopened = await f.service.list(ids);
  assert.equal(reopened.executions[0].active, true); assert.equal(reopened.executions[0].status, 'reconciliation_required'); assert.equal(reopened.capabilities.canStart, false);
  assert.deepEqual(f.query('SELECT * FROM budgets'), [budget]);
});

test('duplicate starts and current project checkpoint cannot pass an in-flight core', async t => {
  const f = await fixture(t, { mode: 'held' }); const started = await f.service.start(await f.input()); await until(() => f.coreCalls() === 1);
  await assert.rejects(f.service.start(await f.input()));
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('source/delete cannot pass the active core')));
  const cancelled = await f.service.cancel({ ...ids, executionId: started.execution.id }); assert.equal(cancelled.execution.status, 'cancel_requested');
  const state = await f.finished(); assert.equal(state.executions[0].status, 'stopped'); assert.equal(state.executions[0].active, false);
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => 'known stopped'), 'known stopped');
});

test('a restarted legacy plan can exceed both old caps while attempt reservations and usage remain exact', async t => {
  const f = await fixture(t); let legacy;
  for (let attempt = 1; attempt <= 11; attempt++) {
    await f.service.start(await f.input()); await until(() => f.query('SELECT * FROM executions WHERE active=1').length === 0);
    if (attempt === 1) legacy = f.seedLegacyBudget();
    if (attempt === 3 || attempt === 9) await f.reopen();
  }
  const state = await f.service.list(ids);
  assert.equal(state.capabilities.canStart, true); assert.equal(state.capabilities.budget.unlimited, true);
  assert.equal(state.capabilities.budget.remainingAttempts, null); assert.equal(state.capabilities.budget.remainingModelCalls, null);
  assert.equal(f.coreCalls(), 11); assert.equal(state.executions.length, 11);
  const [ledger] = f.query('SELECT * FROM budgets');
  assert.equal(ledger.attempts, 11); assert.equal(ledger.used_calls, 22); assert.equal(ledger.reserved_calls, 0);
  assert.equal(ledger.budget, legacy);
});

test('endpoint changes invalidate the paid admission contract without publishing endpoint or credential text', async t => {
  const f = await fixture(t); const old = await f.input();
  await f.reopen({ config: { ...config, baseUrl: 'https://different.synthetic.invalid/v1' } });
  const current = await f.service.list(ids); assert.notEqual(current.capabilities.contractRevision, old.contractRevision);
  assert.equal(JSON.stringify(current).includes('different.synthetic.invalid'), false);
  await assert.rejects(f.service.start(old), error => error.code === 'contract_changed'); assert.deepEqual(f.query('SELECT * FROM budgets'), []);
});

test('fake accepted inert result cannot authorize source download or regain the native core brand', async t => {
  const f = await fixture(t, { mode: 'fake-accepted' }); const started = await f.service.start(await f.input()), state = await f.finished();
  assert.equal(state.executions[0].status, 'failed'); assert.equal(state.executions[0].actions.canDownload, false);
  await assert.rejects(f.service.download({ ...ids, executionId: started.execution.id }), error => error.code === 'not_accepted');
});

test('review history preserves original findings and same-ID resolutions across service restart', async t => {
  const original = { id: 'ISSUE-fifo', file: 'src/app.mjs', line: 3, severity: 'blocking', status: 'open',
    message: '跳过队首使后到候补先占位', evidence: 'return requested;', originCommit: '1'.repeat(40) };
  const versions = [
    { attempt: 1, commit: '1'.repeat(40), sourceHash: 'a'.repeat(64), acceptance: { issues: [original], errors: [],
      review: { status: 'completed', summary: '队首规则缺失', resolutions: [], receiptPath: '/private/receipt' } } },
    { attempt: 2, commit: '2'.repeat(40), sourceHash: 'b'.repeat(64), acceptance: { errors: [],
      issues: [{ ...original, status: 'resolved', checkedCommit: '2'.repeat(40), resolution: '先选择 sequence 最小的候补' }],
      review: { status: 'completed', summary: '复核关闭', resolutions: [{ id: original.id, status: 'resolved', reason: '队首先行' }] } } },
    { attempt: 3, commit: '3'.repeat(40), sourceHash: 'c'.repeat(64), acceptance: { issues: [], errors: [{ role: 'review', code: 'invalid_model_response' }],
      review: { status: 'error', error: '审查意见重复', diagnostic: { version: 1, reason: 'duplicate_issue', field: 'issues[1]' } } } },
  ];
  const rejection = { version: 1, reason: 'duplicate_issue', field: 'issues[1]' };
  const f = await fixture(t, { versions, reviewRejection: { ...rejection, receiptPath: '/private/rejected-receipt' } });
  await f.service.start(await f.input());
  const state = await f.finished(), row = state.executions[0], history = row.reviewHistory;
  assert.equal(history.length, 3);
  assert.equal(history[0].issues[0].status, 'open');
  assert.equal(history[1].issues[0].id, history[0].issues[0].id);
  assert.equal(history[1].issues[0].status, 'resolved');
  assert.equal(history[0].candidateCommit, versions[0].commit);
  assert.equal(history[1].sourceHash, versions[1].sourceHash);
  assert.equal(history[2].diagnostic.reason, 'duplicate_issue');
  assert.deepEqual(row.modelCalls[1].reviewRejection, rejection);
  assert.equal(row.modelCalls[1].candidateCommit, versions[0].commit);
  assert.equal(JSON.stringify(row.modelCalls).includes('/private/rejected-receipt'), false);
  assert.equal(JSON.stringify(history).includes('/private/receipt'), false);
  assert.equal(row.accepted, false);
  assert.equal(row.actions.canDownload, false);
  await f.reopen();
  assert.deepEqual((await f.service.list(ids)).executions[0].reviewHistory, history);
});

test('shutdown during uncooperative core preserves unknown ownership and reservation; late completion cannot unlock it', async t => {
  const f = await fixture(t, { mode: 'uncooperative' }); await f.service.start(await f.input()); await until(() => f.coreCalls() === 1);
  await f.service.shutdown(); const before = f.query('SELECT * FROM executions'); assert.equal(before[0].status, 'reconciliation_required'); assert.equal(before[0].active, 1);
  f.release(); await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(f.query('SELECT * FROM executions'), before);
  await f.reopen({}, true); const state = await f.service.list(ids); assert.equal(state.executions[0].status, 'reconciliation_required'); assert.equal(state.capabilities.canStart, false);
  assert.equal(f.query('SELECT * FROM budgets')[0].reserved_calls, 6);
});

test('cancellation while waiting for the common checkpoint performs no coding and releases only its reservation', async t => {
  const f = await fixture(t, { holdCheckpoint: true }); const started = await f.service.start(await f.input());
  assert.equal(f.coreCalls(), 0); assert.equal(f.query('SELECT * FROM budgets')[0].reserved_calls, 6);
  assert.equal((await f.service.cancel({ ...ids, executionId: started.execution.id })).execution.status, 'cancel_requested');
  f.checkpoint.resolve(); const done = await f.finished(); assert.equal(done.executions[0].status, 'stopped'); assert.equal(f.coreCalls(), 0);
  const [budget] = f.query('SELECT * FROM budgets'); assert.equal(budget.used_calls, 0); assert.equal(budget.reserved_calls, 0);
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => 'idle'), 'idle');
});

test('duplicate execution/owner and foreign execution identity cannot reuse the same activity slot', async t => {
  const f = await fixture(t, { mode: 'held' }); const started = await f.service.start(await f.input());
  await until(() => f.coreCalls() === 1);
  await assert.rejects(f.service.start(await f.input()), error => error.status === 409);
  await assert.rejects(f.open(), error => error.code === 'service_owned');
  for (const action of ['cancel', 'download']) await assert.rejects(f.service[action]({ ...ids, projectId: 'foreign', executionId: started.execution.id }), error => error.status === 404);
  assert.equal(f.query('SELECT * FROM budgets')[0].attempts, 1);
  await f.service.cancel({ ...ids, executionId: started.execution.id }); await f.finished();
});
