import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createVerificationPlanningService, verificationPlanningPolicy } from '../lib/verification-planning-service.mjs';
import { createVerificationModel, verificationModelPolicy } from '../lib/verification-model.mjs';
import { compileManifest } from '../lib/verification-contract.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';

const config = { baseUrl: 'https://synthetic.invalid/v1', model: 'independent-tests', apiKey: 'only-a-fake-local-credential' };
const ids = { projectId: 'project', runId: 'run' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function planning(projectId = ids.projectId, runId = ids.runId) {
  const source = { filename: 'requirements.md', content: '读取资源' };
  const spec = { title: '资源服务', summary: '确认资源接口', goals: ['读取资源'], roles: [], constraints: ['只使用已确认API'], acceptanceScenarios: ['正常读取返回200'], assumptions: [], questions: [],
    stack: { frontend: '原生 HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ id: 'R1', title: '读取', description: '读取资源', acceptance: ['返回资源集合'], sourceQuote: '读取资源' }] };
  const specRevision = contentRevision(spec);
  const engineeringPlan = validateEngineeringPlan({ spec, binding: { projectId, runId, specRevision }, proposal: { version: 1, title: '资源工程', summary: '已确认接口与任务', entities: [],
    routes: [{ id: 'READ', method: 'GET', path: '/resources', roles: [], request: '无请求正文', response: '200资源集合', errors: [], requirementIds: ['R1'] }],
    views: [{ id: 'HOME', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }],
    tasks: [{ id: 'DEV', title: '读取资源接口', description: '实现已确认资源API', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格与工程接口'], outputs: ['接口与页面'], acceptance: ['正确返回集合'] }] } });
  const run = { id: runId, projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, sourceSuperseded: false,
    spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '已确认资源架构' }],
    review: { passed: true, issues: [] }, stages: [], status: 'succeeded', approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}
function proposal(name = '资源HTTP测试') { return { version: 1, id: 'resource-http', name, sessions: [], steps: [
  { id: 'read', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'read_status', op: 'status', value: 200 }] } },
] }; }
const receipt = (body = proposal(), extra = {}) => ({ model: config.model, finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 11 }, content: JSON.stringify(body), ...extra });
const result = (body = proposal(), extra = {}) => ({ proposal: body, model: config.model, usage: { inputTokens: 7, outputTokens: 11 }, policyHash: verificationModelPolicy.hash, coverage: 'structural_only', ...extra });
const fakeModel = behavior => () => async input => {
  if (behavior) return behavior(input);
  await input.onReceipt(receipt()); return result();
};
async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'verification-planning-'));
  const data = planning(), services = [];
  const getPlanning = options.getPlanning ?? (() => data);
  const base = { rootDir, getPlanning, config, timeoutMs: 2000, cleanupMs: 30, ...options,
    dependencies: { createModel: fakeModel(), ...options.dependencies } };
  const service = await createVerificationPlanningService(base); services.push(service);
  t.after(async () => { for (const value of services.reverse()) await value.shutdown(); await rm(rootDir, { recursive: true, force: true }); });
  return { rootDir, data, service, services, base, async open(extra = {}) { const next = await createVerificationPlanningService({ ...base, ...extra }); services.push(next); return next; } };
}
async function propose(service, project = ids) {
  const state = await service.list(project);
  return (await service.propose({ ...project, contractRevision: state.capabilities.contractRevision })).proposal;
}
async function wait(service, id, expected, project = ids) {
  const until = Date.now() + 4000;
  for (;;) {
    const value = (await service.list(project)).proposals.find(row => row.id === id);
    if (typeof expected === 'function' ? expected(value) : value?.status === expected) return value;
    assert.ok(Date.now() < until, `waiting for ${expected}: ${JSON.stringify(value)}`); await pause(5);
  }
}
const edit = (row, extra = {}) => ({ projectId: row.projectId, runId: row.runId, proposalId: row.id, revision: row.revision, feedback: '人工核对当前结构', ...extra });
const code = wanted => error => error.code === wanted && !error.message.includes(config.apiKey) && !error.message.includes('synthetic.invalid') && error.cause === undefined;

test('actual model adapter receives confirmed planning projections, persists private receipt and never runs DSL', async t => {
  let calls = 0;
  const f = await fixture(t, { dependencies: { createModel: options => createVerificationModel({ ...options, fetchImpl: async (_url, request) => {
    calls++; const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
    assert.deepEqual(Object.keys(input).sort(), ['binding', 'engineeringContract', 'requirements', 'task']);
    assert.equal(input.task.tasks[0].id, 'DEV'); assert.equal(input.engineeringContract.routes[0].path, '/resources'); assert.equal(input.requirements[0].id, 'R1');
    for (const privateText of [config.apiKey, 'requirements.md', 'PRIVATE_IMPLEMENTATION', 'PRIVATE_TEST_RESULT', 'PRIVATE_UPLOAD']) assert.equal(request.body.includes(privateText), false);
    assert.equal(Object.hasOwn(request, 'onReceipt'), false);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }], usage: { prompt_tokens: 7, completion_tokens: 11 } }));
  } }) } });
  f.data.run.candidate = 'PRIVATE_IMPLEMENTATION'; f.data.run.testResults = 'PRIVATE_TEST_RESULT'; f.data.project.uploadBody = 'PRIVATE_UPLOAD';
  const reserved = await propose(f.service); assert.equal(reserved.status, 'generating'); assert.equal(reserved.dispatched, false);
  const draft = await wait(f.service, reserved.id, 'draft'); assert.equal(calls, 1); assert.equal(draft.coverage, 'structural_only'); assert.equal(draft.executed, false); assert.equal(draft.approved, false);
  assert.equal(draft.binding.engineeringHash, f.data.run.engineeringPlan.hash); assert.match(draft.revision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(draft.usage, { inputTokens: 7, outputTokens: 11 }); assert.equal(draft.receiptState, 'saved');
  const names = await readdir(path.join(f.rootDir, 'receipts')); assert.equal(names.length, 1);
  const bytes = await readFile(path.join(f.rootDir, 'receipts', names[0])); assert.equal(draft.receipt.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(draft.receipt.bytes, bytes.length);
  const json = JSON.stringify(await f.service.list(ids)); assert.equal(json.includes(f.rootDir), false); assert.equal(json.includes(names[0]), false); assert.equal(json.includes('"content"'), false);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(f.rootDir, 'receipts', names[0]))).mode & 0o077, 0);
  assert.throws(() => compileManifest({ proposal: draft.proposal, requirements: ['R1'], binding: { projectId: ids.projectId, runId: ids.runId, specRevision: draft.binding.specRevision, planRevision: draft.binding.planRevision }, approval: draft.approval }));
});

test('human approval is idempotent metadata, survives reopen and exports no runnable controller brand', async t => {
  const f = await fixture(t); const row = await wait(f.service, (await propose(f.service)).id, 'draft');
  const approved = (await f.service.approve(edit(row))).proposal; assert.equal(approved.status, 'approved'); assert.equal(approved.approved, true); assert.equal(approved.approval.phase, 'definition_only'); assert.equal(approved.executed, false);
  assert.deepEqual((await f.service.approve(edit(approved))).proposal.approval, approved.approval);
  assert.throws(() => compileManifest({ proposal: approved.proposal, requirements: ['R1'], binding: { projectId: ids.projectId, runId: ids.runId, specRevision: approved.binding.specRevision, planRevision: approved.binding.planRevision }, approval: approved.approval }), /可信/u);
  await f.service.shutdown(); const reopened = await f.open();
  const stored = (await reopened.list(ids)).proposals[0]; assert.equal(stored.approved, true); assert.deepEqual(stored.approval, approved.approval); assert.equal(stored.history.length, 1);
});

test('default factory uses the existing verification adapter and bounded request rather than a separate model loop', async t => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, request) => { calls++; assert.equal(String(url), config.baseUrl + '/chat/completions'); assert.equal(JSON.parse(request.body).max_tokens, verificationModelPolicy.maxTokens);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }] })); };
  try {
    const f = await fixture(t); await f.service.shutdown();
    const service = await f.open({ dependencies: {} }); const row = await wait(service, (await propose(service)).id, 'draft');
    assert.equal(calls, 1); assert.deepEqual(row.usage, { inputTokens: null, outputTokens: null }); assert.equal(row.receiptState, 'saved');
  } finally { globalThis.fetch = original; }
});

test('rejection history cannot be washed by a second rejection, a new attempt or restart; actual revision is required', async t => {
  const f = await fixture(t); let row = await wait(f.service, (await propose(f.service)).id, 'draft');
  row = (await f.service.reject(edit(row))).proposal;
  await assert.rejects(f.service.approve(edit(row)), code('revision_required'));
  await assert.rejects(f.service.revise(edit(row, { proposal: proposal() })), code('no_change'));
  row = (await f.service.revise(edit(row, { proposal: proposal('第二定义') }))).proposal;
  assert.equal(row.approval, null); row = (await f.service.reject(edit(row))).proposal;
  row = (await f.service.revise(edit(row, { proposal: proposal() }))).proposal;
  assert.equal(row.actions.canApprove, false); await assert.rejects(f.service.approve(edit(row)), code('revision_required'));
  await f.service.shutdown(); const reopened = await f.open();
  const repeated = await wait(reopened, (await propose(reopened)).id, 'draft'); assert.equal(repeated.actions.canApprove, false);
  await assert.rejects(reopened.approve(edit(repeated)), code('revision_required'));
  const changed = (await reopened.revise(edit(repeated, { proposal: proposal('第三定义') }))).proposal;
  const approved = (await reopened.approve(edit(changed))).proposal; assert.equal(approved.approved, true); assert.notEqual(changed.revision, repeated.revision);
  await assert.rejects(reopened.approve(edit(repeated)), code('stale_revision'));
  assert.ok(approved.history.every(history => !Object.hasOwn(history, 'proposal')));
});

test('matching contract, atomic active slot and persistent per-run attempts prevent duplicate or free retries', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, { dependencies: { createModel: fakeModel(async input => { calls++; entered.resolve(); await release.promise; await input.onReceipt(receipt()); return result(); }) } });
  await assert.rejects(f.service.propose({ ...ids, contractRevision: 'old' }), code('contract_changed'));
  assert.equal((await f.service.list(ids)).capabilities.budget.remainingAttempts, 3);
  const list = await f.service.list(ids), requests = await Promise.allSettled([f.service.propose({ ...ids, contractRevision: list.capabilities.contractRevision }), f.service.propose({ ...ids, contractRevision: list.capabilities.contractRevision })]);
  assert.equal(requests.filter(r => r.status === 'fulfilled').length, 1); assert.equal(requests.find(r => r.status === 'rejected').reason.code, 'project_busy');
  await entered.promise; assert.equal(calls, 1); await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail()), code('project_busy'));
  release.resolve(); const row = requests.find(r => r.status === 'fulfilled').value.proposal; await wait(f.service, row.id, 'draft');
  for (let n = 0; n < 2; n++) await wait(f.service, (await propose(f.service)).id, 'draft');
  assert.equal(calls, 3); assert.equal((await f.service.list(ids)).capabilities.budget.remainingAttempts, 0);
  await assert.rejects(propose(f.service), code('budget_exhausted')); await f.service.shutdown();
  const reopened = await f.open(); await assert.rejects(propose(reopened), code('budget_exhausted'));
});

test('activity and unknown receipts block every run of the project while other projects retain independent slots and budgets', async t => {
  const release = deferred(); let calls = 0;
  const f = await fixture(t, { getPlanning: (pid, rid) => planning(pid, rid), dependencies: { createModel: fakeModel(async input => { calls++; await release.promise; await input.onReceipt(receipt()); return result(); }) } });
  const first = await propose(f.service); await tick();
  const anotherRun = { projectId: ids.projectId, runId: 'another-run' };
  const secondProject = { projectId: 'another-project', runId: ids.runId };
  assert.equal((await f.service.list(anotherRun)).capabilities.canPropose, false); await assert.rejects(propose(f.service, anotherRun), code('project_busy'));
  const second = await propose(f.service, secondProject); await tick(); assert.equal(calls, 2);
  release.resolve(); await wait(f.service, first.id, 'draft'); await wait(f.service, second.id, 'draft', secondProject);
  const freshRun = await wait(f.service, (await propose(f.service, anotherRun)).id, 'draft', anotherRun); assert.equal(freshRun.attempt, 1); assert.equal((await f.service.list(anotherRun)).capabilities.budget.remainingAttempts, 2);
});

test('current source, both approvals, review and exact engineering projection are mandatory before reservation', async t => {
  let calls = 0; const f = await fixture(t, { dependencies: { createModel: fakeModel(async () => { calls++; assert.fail(); }) } });
  const original = structuredClone(f.data);
  const mutations = [data => { data.run.workflowVersion = 1; }, data => { data.run.sourceSuperseded = true; }, data => { data.project.currentSourceRevision = 'a'.repeat(64); },
    data => { data.project.sourceGeneration++; }, data => { data.run.sourceSnapshot.content += '变更'; }, data => { data.run.approvals.spec = null; }, data => { data.run.approvals.plan = null; },
    data => { data.run.review.passed = false; }, data => { data.run.review.issues.push('未处理问题'); }, data => { data.run.engineeringPlan.hash = 'a'.repeat(64); },
    data => { data.run.tasks[0].description += '篡改'; }, data => { delete data.run.engineeringPlan; }, data => { data.run.spec.title += '未批准'; },
    data => { data.run.status = 'failed'; }, data => { data.run.stages.push({ id: 'tasks', status: 'running' }); }];
  for (const mutate of mutations) {
    Object.assign(f.data, structuredClone(original)); mutate(f.data);
    const state = await f.service.list(ids); assert.equal(state.capabilities.canPropose, false); assert.equal(state.proposals.length, 0);
    await assert.rejects(f.service.propose({ ...ids, contractRevision: state.capabilities.contractRevision }), error => error.status === 409);
  }
  Object.assign(f.data, original); assert.equal((await f.service.list(ids)).capabilities.canPropose, true); assert.equal(calls, 0);
});

test('malformed persisted planning descriptors never execute getters or grant a model reservation', async t => {
  let invoked = 0, raw = planning(), calls = 0;
  const f = await fixture(t, { getPlanning: () => raw, dependencies: { createModel: fakeModel(async () => { calls++; assert.fail(); }) } });
  const mutations = [value => { Object.defineProperty(value.run.spec, 'title', { enumerable: true, get() { invoked++; return '访问器'; } }); },
    value => { Object.defineProperty(value.project, 'sourceGeneration', { enumerable: true, get() { invoked++; return 0; } }); },
    value => { value.run.spec.toJSON = () => { invoked++; return {}; }; }, value => { value.run.spec.self = value.run.spec; }];
  for (const mutate of mutations) { raw = planning(); mutate(raw); const state = await f.service.list(ids); assert.equal(state.capabilities.canPropose, false);
    await assert.rejects(f.service.propose({ ...ids, contractRevision: state.capabilities.contractRevision }), error => error.status === 409); }
  assert.equal(invoked, 0); assert.equal(calls, 0);
});

test('source and plan changes withdraw approval and late model publications without altering historical definitions', async t => {
  const f = await fixture(t); const row = await wait(f.service, (await propose(f.service)).id, 'draft');
  await f.service.approve(edit(row)); f.data.run.artifacts[0].content += '计划变更'; f.data.run.planRevision = planningRevision(f.data.run); f.data.run.approvals.plan.revision = f.data.run.planRevision;
  const old = (await f.service.list(ids)).proposals[0]; assert.equal(old.approved, false); assert.equal(old.current, false); assert.ok(Object.values(old.actions).every(v => !v));
  assert.deepEqual(old.proposal, row.proposal); await assert.rejects(f.service.approve(edit(row)), code('stale_revision'));
  const entered = deferred(), released = deferred();
  const g = await fixture(t, { dependencies: { createModel: fakeModel(async input => { entered.resolve(); await released.promise; await input.onReceipt(receipt()); return result(); }) } });
  const next = await propose(g.service); await entered.promise; g.data.run.sourceSuperseded = true; g.data.project.sourceGeneration++;
  released.resolve(); const stale = await wait(g.service, next.id, row => !['generating', 'cancel_requested'].includes(row.status));
  assert.equal(stale.status, 'stale'); assert.equal(stale.proposal, null); assert.equal(stale.receiptState, 'saved'); assert.deepEqual(stale.usage, { inputTokens: 7, outputTokens: 11 });
});

test('safe request copy rejects getters, toJSON, cycles, symbols, sparse arrays, nonfinite and capability fields without invoking them', async t => {
  const f = await fixture(t); const row = await wait(f.service, (await propose(f.service)).id, 'draft'); let invoked = 0;
  const requests = [];
  const getter = edit(row, { proposal: proposal() }); Object.defineProperty(getter, 'proposal', { enumerable: true, get() { invoked++; return proposal(); } }); requests.push(getter);
  for (const mutate of [p => { p.toJSON = () => { invoked++; }; }, p => { p.self = p; }, p => { p[Symbol('cap')] = 1; }, p => { delete p.steps[0]; }, p => { p.name = Infinity; },
    p => { Object.setPrototypeOf(p, { fake: true }); }, p => { p.steps.map = () => { invoked++; }; }, p => { p.name = '\ud800'; }, p => { p.name = 'x'.repeat(512 * 1024); },
    p => { p.passed = true; }, p => { p.commands = ['echo fake']; }, p => { p.steps[0].request.path = 'https://external.invalid'; }, p => { p.steps[0].requirementIds = ['UNKNOWN']; }]) {
    const p = proposal(); mutate(p); requests.push(edit(row, { proposal: p }));
  }
  const nested = proposal(); Object.defineProperty(nested.steps[0], 'request', { enumerable: true, get() { invoked++; return {}; } }); requests.push(edit(row, { proposal: nested }));
  for (const input of requests) await assert.rejects(f.service.revise(input), error => error.status === 400);
  for (const field of ['dependencies', 'filename', 'path', 'manifest', 'passed', 'signal']) await assert.rejects(f.service.propose({ ...ids, contractRevision: 'x', [field]: true }), code('invalid_input'));
  assert.equal(invoked, 0); assert.equal((await f.service.list(ids)).proposals[0].revision, row.revision);
});

test('request and config snapshots are copied before first await, including revisions and feedback', async t => {
  const gate = deferred(); let blocking = false;
  const f = await fixture(t, { getPlanning: () => blocking ? gate.promise : planning() }); const row = await wait(f.service, (await propose(f.service)).id, 'draft');
  blocking = true; const request = edit(row, { proposal: proposal('合法修订') }); const pending = f.service.revise(request);
  request.proposal.name = '迟到变更'; request.feedback = '迟到反馈'; request.revision = 'old'; gate.resolve(planning());
  const revised = (await pending).proposal; assert.equal(revised.proposal.name, '合法修订'); assert.equal(revised.history.at(-1).feedback, '人工核对当前结构');
  let getter = 0; const invalid = { rootDir: f.rootDir, getPlanning: () => planning() }; Object.defineProperty(invalid, 'config', { enumerable: true, get() { getter++; return config; } });
  await assert.rejects(createVerificationPlanningService(invalid)); assert.equal(getter, 0);
  for (const options of [{ maxAttempts: null }, { timeoutMs: null }, { cleanupMs: null }, { config: null }, { dependencies: null }]) await assert.rejects(createVerificationPlanningService({ ...f.base, ...options }));
});

test('receipt/result mismatch, missing receipt, non-stop, unknown policy and invalid DSL fail closed', async t => {
  const cases = [async () => result(), async input => { await input.onReceipt(receipt()); return result(proposal('不一致')); },
    async input => { await input.onReceipt(receipt(undefined, { finishReason: 'length' })); return result(); },
    async input => { await input.onReceipt(receipt()); return result(undefined, { policyHash: 'a'.repeat(64) }); },
    async input => { const p = proposal(); p.passed = true; await input.onReceipt(receipt(p)); return result(p); },
    async input => { await input.onReceipt(receipt()); await input.onReceipt(receipt()); return result(); }];
  for (const behavior of cases) {
    const f = await fixture(t, { dependencies: { createModel: fakeModel(behavior) } }); const row = await wait(f.service, (await propose(f.service)).id, row => row.status !== 'generating');
    assert.equal(row.status, 'failed'); assert.equal(row.proposal, null); assert.equal(row.approval, null); assert.equal(row.actions.canApprove, false);
  }
});

test('caught receipt boundary violations remain fatal even when provider returns the first valid proposal', async t => {
  let getters = 0;
  const getter = receipt(); Object.defineProperty(getter, 'content', { enumerable: true, get() { getters++; return 'must not execute'; } });
  for (const invalid of [receipt(), undefined, { content: 'malformed' }, receipt(undefined, { usage: { inputTokens: -1, outputTokens: null } }), getter]) {
    const f = await fixture(t, { dependencies: { createModel: fakeModel(async input => {
      await input.onReceipt(receipt()); await assert.rejects(input.onReceipt(invalid)); return result();
    }) } });
    const row = await wait(f.service, (await propose(f.service)).id, value => value.status !== 'generating');
    assert.equal(row.status, 'failed'); assert.equal(row.errorCode, 'receipt_failed'); assert.equal(row.proposal, null); assert.equal(row.approved, false); assert.equal(row.actions.canApprove, false);
    assert.equal(row.receiptState, 'saved'); assert.ok(row.receipt.sha256); assert.deepEqual(row.usage, { inputTokens: 7, outputTokens: 11 }); assert.equal(row.finishReason, 'stop');
    await assert.rejects(f.service.approve(edit(row)), error => error.status === 409);
  }
  assert.equal(getters, 0);
  const f = await fixture(t, { dependencies: { createModel: fakeModel(async input => {
    await assert.rejects(input.onReceipt({ content: 'invalid first receipt' }));
    await input.onReceipt(receipt()).catch(() => {}); return result();
  }) } });
  const row = await wait(f.service, (await propose(f.service)).id, value => value.status !== 'generating');
  assert.equal(row.status, 'failed'); assert.equal(row.errorCode, 'receipt_failed'); assert.equal(row.proposal, null);
  assert.equal(row.receiptState, 'not_received'); assert.deepEqual(row.usage, { inputTokens: null, outputTokens: null });
});

test('caught late receipt violation during final planning read cannot publish a draft', async t => {
  const finalEntered = deferred(), finalRead = deferred(); let reads = 0, captured;
  const f = await fixture(t, { getPlanning: () => ++reads === 3 ? (finalEntered.resolve(), finalRead.promise) : planning(),
    dependencies: { createModel: fakeModel(async input => { captured = input; await input.onReceipt(receipt()); return result(); }) } });
  const contractRevision = (await f.service.list(ids)).capabilities.contractRevision; reads = 0;
  const reservation = (await f.service.propose({ ...ids, contractRevision })).proposal;
  await finalEntered.promise; await assert.rejects(captured.onReceipt(receipt())); finalRead.resolve(planning());
  const row = await wait(f.service, reservation.id, value => value.status !== 'generating');
  assert.equal(row.status, 'failed'); assert.equal(row.errorCode, 'receipt_failed'); assert.equal(row.proposal, null); assert.equal(row.receiptState, 'saved'); assert.deepEqual(row.usage, { inputTokens: 7, outputTokens: 11 });
});

test('explicit source generations reject malformed values before reservation and before human approval', async t => {
  let calls = 0; const f = await fixture(t, { dependencies: { createModel: fakeModel(async input => { calls++; await input.onReceipt(receipt()); return result(); }) } });
  const original = structuredClone(f.data), bad = [-1, null, 0.5, NaN, Infinity, '0', false, {}, Number.MAX_SAFE_INTEGER + 1];
  for (const side of ['run', 'project']) for (const value of bad) {
    Object.assign(f.data, structuredClone(original)); delete f.data.project.sourceGeneration; delete f.data.run.sourceGeneration; f.data[side].sourceGeneration = value;
    const state = await f.service.list(ids); assert.equal(state.capabilities.canPropose, false, `${side}/${String(value)}`); assert.equal(state.proposals.length, 0);
    await assert.rejects(f.service.propose({ ...ids, contractRevision: state.capabilities.contractRevision }), error => error.status === 409);
  }
  assert.equal(calls, 0); Object.assign(f.data, structuredClone(original));
  const row = await wait(f.service, (await propose(f.service)).id, 'draft');
  for (const mutate of [data => { data.run.sourceGeneration = null; }, data => { delete data.project.sourceGeneration; data.run.sourceGeneration = -1; },
    data => { data.project.sourceGeneration = '0'; }, data => { data.project.sourceGeneration = 1; }, data => { data.project.currentSourceRevision = 'a'.repeat(64); }, data => { data.run.sourceSuperseded = true; }]) {
    Object.assign(f.data, structuredClone(original)); mutate(f.data); const old = (await f.service.list(ids)).proposals[0];
    assert.equal(old.current, false); assert.equal(old.approved, false); assert.equal(old.actions.canApprove, false);
    await assert.rejects(f.service.approve(edit(row)), error => error.status === 409);
  }
  assert.equal(calls, 1); Object.assign(f.data, original); assert.equal((await f.service.approve(edit(row))).proposal.approved, true);
});

test('only missing or undefined legacy generations default to zero and matched safe generations retain their real binding', async t => {
  for (const [projectGeneration, runGeneration] of [[undefined, undefined], [undefined, 0], [0, undefined], [0, 0], [7, 7], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    const f = await fixture(t); f.data.project.sourceGeneration = projectGeneration; f.data.run.sourceGeneration = runGeneration;
    const row = await wait(f.service, (await propose(f.service)).id, 'draft'); assert.equal(row.binding.sourceGeneration, runGeneration === undefined ? 0 : runGeneration);
    assert.equal((await f.service.approve(edit(row))).proposal.approved, true);
  }
  const f = await fixture(t); delete f.data.project.sourceGeneration; delete f.data.run.sourceGeneration;
  const row = await wait(f.service, (await propose(f.service)).id, 'draft'); assert.equal(row.binding.sourceGeneration, 0);
  f.data.run.sourceGeneration = 1; assert.equal((await f.service.list(ids)).proposals[0].current, false);
});

test('malformed/credential escaped outputs remain private and usage unknown stays null; no automatic format retry', async t => {
  for (const content of ['{"version":', JSON.stringify(proposal()).replace('资源HTTP测试', [...config.apiKey].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))]) {
    let calls = 0;
    const f = await fixture(t, { dependencies: { createModel: options => createVerificationModel({ ...options, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 'unknown', completion_tokens: -1 } })); } }) } });
    const row = await wait(f.service, (await propose(f.service)).id, row => row.status !== 'generating');
    assert.equal(row.status, 'failed'); assert.equal(calls, 1); assert.equal(row.proposal, null); assert.deepEqual(row.usage, { inputTokens: null, outputTokens: null }); assert.equal(row.receiptState, 'saved');
    const files = await readdir(path.join(f.rootDir, 'receipts')), stored = await readFile(path.join(f.rootDir, 'receipts', files[0]), 'utf8');
    assert.equal(stored.includes(config.apiKey), false); if (content.includes('\\u')) { assert.equal(row.errorCode, 'credential_response'); assert.equal(stored.includes('\\\\u006f'), false); }
  }
});

test('known credentials in approved input or feedback are rejected locally before any model dispatch', async t => {
  let calls = 0; const f = await fixture(t, { dependencies: { createModel: fakeModel(async () => { calls++; assert.fail(); }) } });
  f.data.run.spec.title = config.apiKey; f.data.run.specRevision = contentRevision(f.data.run.spec); f.data.run.approvals.spec.revision = f.data.run.specRevision;
  f.data.run.engineeringPlan = validateEngineeringPlan({ spec: f.data.run.spec, binding: { ...ids, specRevision: f.data.run.specRevision }, proposal: f.data.run.engineeringPlan.proposal });
  f.data.run.tasks = engineeringTasks(f.data.run.engineeringPlan); f.data.run.planRevision = planningRevision(f.data.run); f.data.run.approvals.plan = { revision: f.data.run.planRevision, specRevision: f.data.run.specRevision };
  await assert.rejects(propose(f.service), code('credential_response')); assert.equal(calls, 0); assert.equal((await f.service.list(ids)).proposals.length, 0);
  const g = await fixture(t); const row = await wait(g.service, (await propose(g.service)).id, 'draft'); await assert.rejects(g.service.approve(edit(row, { feedback: config.apiKey })), code('credential_response'));
});

test('cooperative cancellation is a request then confirmed cancellation and keeps consumed attempt metadata', async t => {
  const entered = deferred(); const f = await fixture(t, { dependencies: { createModel: fakeModel(input => { entered.resolve(); return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('private provider detail')), { once: true })); }) } });
  const row = await propose(f.service); await entered.promise;
  const requested = (await f.service.cancel({ ...ids, proposalId: row.id })).proposal; assert.equal(requested.status, 'cancel_requested');
  const stopped = await wait(f.service, row.id, 'cancelled'); assert.equal(stopped.proposal, null); assert.equal(stopped.dispatched, true); assert.deepEqual(stopped.usage, { inputTokens: null, outputTokens: null });
  assert.equal((await f.service.list(ids)).capabilities.budget.remainingAttempts, 2); await assert.rejects(f.service.cancel({ ...ids, proposalId: row.id }), code('not_running'));
});

test('total deadline includes private receipt writes; uncooperative model/writer retains unknown slot and cannot publish late', async t => {
  const release = deferred(), entered = deferred();
  const f = await fixture(t, { timeoutMs: 70, cleanupMs: 15, dependencies: { writeReceipt: async ({ filename, contents }) => { entered.resolve(); await release.promise; await writeFile(filename, contents, { flag: 'wx', mode: 0o600 }); } } });
  const reserved = await propose(f.service); await entered.promise; const row = await wait(f.service, reserved.id, 'reconciliation_required');
  assert.equal(row.receiptState, 'unknown'); assert.equal(row.errorCode, 'model_timeout'); assert.deepEqual(row.usage, { inputTokens: 7, outputTokens: 11 });
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true), code('project_busy')); await assert.rejects(propose(f.service), code('project_busy'));
  release.resolve(); await pause(20); assert.equal((await f.service.list(ids)).proposals[0].status, 'reconciliation_required');
  assert.equal((await f.service.list(ids)).proposals[0].proposal, null);
  const late = deferred(); let input;
  const g = await fixture(t, { timeoutMs: 70, cleanupMs: 15, dependencies: { createModel: fakeModel(async value => { input = value; await late.promise; await value.onReceipt(receipt()); return result(); }) } });
  const next = await propose(g.service); await wait(g.service, next.id, 'reconciliation_required');
  await assert.rejects(input.onReceipt(receipt())); late.resolve(); await pause(15); assert.equal((await g.service.list(ids)).proposals[0].proposal, null); assert.deepEqual(await readdir(path.join(g.rootDir, 'receipts')), []);
});

test('receipt sink failure is sanitized and confirmed timeout releases only a settled model', async t => {
  const f = await fixture(t, { dependencies: { writeReceipt: async () => { throw new Error(config.apiKey + ' C:/private/provider'); } } });
  const row = await wait(f.service, (await propose(f.service)).id, 'failed'); assert.equal(row.receiptState, 'failed'); assert.equal(row.errorCode, 'receipt_failed'); assert.equal(JSON.stringify(row).includes(config.apiKey), false);
  const g = await fixture(t, { timeoutMs: 70, cleanupMs: 15, dependencies: { createModel: fakeModel(input => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }))) } });
  const timed = await wait(g.service, (await propose(g.service)).id, 'timed_out'); assert.equal(timed.errorCode, 'model_timeout'); assert.equal((await g.service.list(ids)).capabilities.canPropose, true);
});

test('pending planning admission blocks checkpoint synchronously; different projects and callback errors remain independent', async t => {
  const gate = deferred(); let block = false;
  const f = await fixture(t, { getPlanning: (pid, rid) => block && pid === ids.projectId ? gate.promise : planning(pid, rid) });
  const contractRevision = (await f.service.list(ids)).capabilities.contractRevision; block = true;
  const pending = f.service.propose({ ...ids, contractRevision });
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true), code('project_busy'));
  assert.equal(await f.service.withProjectCheckpoint('other-project', () => 42), 42);
  gate.resolve(planning()); const row = (await pending).proposal; await wait(f.service, row.id, 'draft'); block = false;
  const error = new Error('trusted callback failure'); await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => { throw error; }), e => e === error);
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, async () => 'released'), 'released');
});

test('checkpoint in-flight lists and multiple history rows cannot restore old approvals after source publication', async t => {
  const gate = deferred(); let block = false;
  const f = await fixture(t, { getPlanning: () => block ? gate.promise : f.data });
  const first = await wait(f.service, (await propose(f.service)).id, 'draft'); await f.service.approve(edit(first));
  const second = await wait(f.service, (await propose(f.service)).id, 'draft'); await f.service.approve(edit(second));
  block = true; const oldRead = f.service.list(ids), hold = deferred();
  const checkpoint = f.service.withProjectCheckpoint(ids.projectId, async () => { await hold.promise; f.data.run.sourceSuperseded = true; f.data.project.sourceGeneration++; });
  await assert.rejects(f.service.propose({ ...ids, contractRevision: 'old' }), code('project_checkpoint'));
  await assert.rejects(f.service.approve(edit(second)), code('project_checkpoint'));
  hold.resolve(); await checkpoint; gate.resolve(planning()); const stale = await oldRead;
  assert.equal(stale.capabilities.canPropose, false); for (const row of stale.proposals) { assert.equal(row.approved, false); assert.equal(row.current, false); assert.ok(Object.values(row.actions).every(value => !value)); }
  block = false; assert.equal((await f.service.list(ids)).capabilities.canPropose, false);
});

test('asynchronous human action keeps checkpoint busy, and concurrent revisions cannot approve a stale body', async t => {
  const gate = deferred(); let block = false;
  const f = await fixture(t, { getPlanning: () => block ? gate.promise : planning() }); const row = await wait(f.service, (await propose(f.service)).id, 'draft');
  block = true; const first = f.service.revise(edit(row, { proposal: proposal('新定义') })), second = f.service.approve(edit(row));
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true), code('project_busy')); gate.resolve(planning());
  const values = await Promise.allSettled([first, second]); assert.equal(values[0].status, 'fulfilled'); assert.equal(values[1].status, 'rejected'); assert.equal(values[1].reason.code, 'stale_revision');
});

test('shutdown rejects new work, bounds uncooperative model/read cleanup and waits existing checkpoint callback', async t => {
  const release = deferred(), entered = deferred(); const f = await fixture(t);
  const checkpoint = f.service.withProjectCheckpoint(ids.projectId, async () => { entered.resolve(); await release.promise; return 'original value'; }); await entered.promise;
  let finished = false; const shutdown = f.service.shutdown().then(() => { finished = true; }); await tick(); assert.equal(finished, false);
  await assert.rejects(f.service.withProjectCheckpoint('another', () => true), code('shutting_down')); await assert.rejects(f.service.list(ids), code('shutting_down'));
  release.resolve(); assert.equal(await checkpoint, 'original value'); await shutdown;
  const g = await fixture(t, { timeoutMs: 1000, cleanupMs: 15, dependencies: { createModel: fakeModel(() => new Promise(() => {})) } }); await propose(g.service); await tick();
  const start = Date.now(); await g.service.shutdown(); assert.ok(Date.now() - start < 500);
  const reopened = await g.open(); assert.equal((await reopened.list(ids)).proposals[0].status, 'reconciliation_required');
  const held = deferred(); let block = false; const h = await fixture(t, { getPlanning: () => block ? held.promise : planning() }); block = true;
  const pending = h.service.list(ids); const rejected = assert.rejects(pending, error => ['operation_stopped', 'shutting_down'].includes(error.code)); await h.service.shutdown(); await rejected;
});

test('single-owner restart preserves unresolved attempts and prevents late former owner receipt or publication', async t => {
  const entered = deferred(), release = deferred(); let captured;
  const f = await fixture(t, { timeoutMs: 2000, dependencies: { createModel: fakeModel(async input => { captured = input; entered.resolve(); await release.promise; await input.onReceipt(receipt()); return result(); }) } });
  const row = await propose(f.service); await entered.promise;
  await assert.rejects(createVerificationPlanningService(f.base), code('owner_active'));
  const replacement = await f.open({ dependencies: { createModel: fakeModel(), isProcessAlive: () => false } });
  const interrupted = (await replacement.list(ids)).proposals[0]; assert.equal(interrupted.status, 'reconciliation_required'); assert.equal(interrupted.proposal, null);
  await assert.rejects(captured.onReceipt(receipt()), code('stale_owner')); await assert.rejects(f.service.list(ids), code('stale_owner'));
  release.resolve(); await pause(20); assert.equal((await replacement.list(ids)).proposals[0].status, 'reconciliation_required'); assert.deepEqual(await readdir(path.join(f.rootDir, 'receipts')), []);
  await assert.rejects(replacement.withProjectCheckpoint(ids.projectId, () => true), code('project_busy')); await assert.rejects(propose(replacement), code('project_busy'));
  assert.equal(interrupted.id, row.id); assert.deepEqual(interrupted.usage, { inputTokens: null, outputTokens: null });
});

test('stored policy binds current implementation and metadata-only SQLite does not contain original receipt content', async t => {
  const f = await fixture(t); const row = await wait(f.service, (await propose(f.service)).id, 'draft');
  assert.match(verificationPlanningPolicy.hash, /^[a-f0-9]{64}$/u); assert.equal(row.binding.policyHash, verificationPlanningPolicy.hash); assert.equal(row.policyHash, verificationPlanningPolicy.hash);
  const db = new DatabaseSync(path.join(f.rootDir, 'verification.sqlite'), { readOnly: true });
  try { const columns = db.prepare('PRAGMA table_info(proposals)').all().map(column => column.name); assert.equal(columns.includes('content'), false); assert.equal(columns.includes('receipt_path'), false);
    const stored = db.prepare('SELECT * FROM proposals WHERE id=?').get(row.id); assert.equal(stored.receipt_hash, row.receipt.sha256); assert.equal(stored.receipt_bytes, row.receipt.bytes); assert.equal(JSON.parse(stored.snapshot).context.task.title, '资源服务');
  } finally { db.close(); }
});

test('paid admission revision changes with endpoint, model and budgets and excludes private endpoint text from DTO', async t => {
  const f = await fixture(t), original = (await f.service.list(ids)).capabilities.contractRevision; await f.service.shutdown();
  for (const extra of [{ config: { ...config, baseUrl: 'https://different.synthetic.invalid/v1' } }, { config: { ...config, model: 'different-model' } }, { maxAttempts: 2 }, { timeoutMs: 1500 }]) {
    const current = await f.open(extra), listing = await current.list(ids); assert.notEqual(listing.capabilities.contractRevision, original);
    assert.equal(JSON.stringify(listing).includes('synthetic.invalid'), false); await assert.rejects(current.propose({ ...ids, contractRevision: original }), code('contract_changed')); await current.shutdown();
  }
});
