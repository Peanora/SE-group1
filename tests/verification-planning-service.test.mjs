import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createVerificationPlanningService, verificationPlanningPolicy } from '../lib/verification-planning-service.mjs';
import { strictHttpTool, strictHttpWire } from '../lib/strict-http-wire.mjs';
import { createVerificationModel, verificationModelPolicy } from '../lib/verification-model.mjs';
import { canonicalJSON, compileManifest, inspectVerificationProposal, verificationPolicyHash } from '../lib/verification-contract.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';
import { suggestVerificationDraft } from '../lib/verification-recovery.mjs';

const config = { baseUrl: 'https://synthetic.invalid/v1', model: 'independent-tests', apiKey: 'only-a-fake-local-credential' };
const ids = { projectId: 'project', runId: 'run' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function planning(projectId = ids.projectId, runId = ids.runId, requirementCount = 1) {
  const source = { filename: 'requirements.md', content: '读取资源' };
  const spec = { title: '资源服务', summary: '确认资源接口', goals: ['读取资源'], roles: [], constraints: ['只使用已确认API'], acceptanceScenarios: ['正常读取返回200'], assumptions: [], questions: [],
    stack: { frontend: '原生 HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ id: 'R1', title: '读取', description: '读取资源', acceptance: ['返回资源集合'], sourceQuote: '读取资源' }] };
  for (let i = 2; i <= requirementCount; i++) spec.requirements.push({ ...spec.requirements[0], id: `R${i}`, title: `读取 ${i}` });
  const requirementIds = spec.requirements.map(item => item.id);
  const specRevision = contentRevision(spec);
  const engineeringPlan = validateEngineeringPlan({ spec, binding: { projectId, runId, specRevision }, proposal: { version: 1, title: '资源工程', summary: '已确认接口与任务', entities: [],
    routes: [{ id: 'READ', method: 'GET', path: '/resources', roles: [], request: '无请求正文', response: '200资源集合', errors: [], requirementIds }],
    views: [{ id: 'HOME', path: '/', title: '资源', requirementIds, selectors: [{ testId: 'resources', role: 'list' }] }],
    tasks: [{ id: 'DEV', title: '读取资源接口', description: '实现已确认资源API', requirementIds, dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格与工程接口'], outputs: ['接口与页面'], acceptance: ['正确返回集合'] }] } });
  const run = { id: runId, projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, sourceSuperseded: false,
    spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '已确认资源架构' }],
    review: { passed: true, issues: [] }, stages: [], status: 'succeeded', approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}
function proposal(name = '资源HTTP测试') { return { version: 1, id: 'resource-http', name, sessions: [], steps: [
  { id: 'read', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'read_status', op: 'status', value: 200 }] } },
] }; }

test('a UI-only coverage gap adds an entry-page check and preserves all original assertions', () => {
  const { run } = planning();
  const input = proposal();
  input.browser = { version: 1, sessions: ['visitor'], steps: [
    { id: 'open', op: 'goto', path: '/', session: 'visitor', requirementIds: ['R2'] },
    { id: 'see', op: 'visible', testId: 'resources', value: true, session: 'visitor', requirementIds: ['R2'] },
  ] };
  const context = { binding: { ...ids, specRevision: run.specRevision, planRevision: run.planRevision }, task: { tasks: run.tasks },
    requirements: [{ id: 'R1' }, { id: 'R2' }], engineeringContract: {
      views: [{ path: '/', requirementIds: ['R2'], selectors: [{ testId: 'resources' }] }],
      routes: [{ path: '/resources', requirementIds: ['R1'] }],
    } };
  const saved = structuredClone(input);
  const repaired = suggestVerificationDraft(input, context);
  assert.equal(repaired?.draft.steps.length, 2);
  assert.deepEqual(repaired.draft.steps[0], saved.steps[0]);
  assert.deepEqual(repaired.draft.browser, saved.browser);
  assert.deepEqual(input, saved);
  assert.equal(repaired.draft.steps[1].request.path, '/');
  assert.equal(repaired.draft.steps[1].request.method, 'GET');
  assert.deepEqual(repaired.draft.steps[1].requirementIds, ['R2']);
  context.engineeringContract.routes[0].requirementIds.push('R2');
  assert.equal(suggestVerificationDraft(input, context), null, 'a missing API requirement cannot pass using a page check');
  context.engineeringContract.routes[0].requirementIds.pop();
  input.browser.steps[1].value = false;
  assert.equal(suggestVerificationDraft(input, context), null, 'an absence check cannot show the entry page is usable');
});

test('a list-item selector and a visible numeric counter are split before approval', () => {
  const { run } = planning();
  const input = proposal();
  const race = { id: 'create', op: 'createWithDelayedLoad', path: '/', loadPath: '/resources', session: 'visitor',
    requirementIds: ['R1'], inputTestId: 'input', submitTestId: 'submit', listTestId: 'list', countTestId: 'item', value: '新资源', expectedCount: 1 };
  input.browser = { version: 1, sessions: ['visitor'], steps: [
    { id: 'open', op: 'goto', path: '/', session: 'visitor', requirementIds: ['R1'] },
    { id: 'empty', op: 'count', testId: 'item', value: 0, session: 'visitor', requirementIds: ['R1'] }, race,
    { id: 'created', op: 'visible', testId: 'item', value: true, session: 'visitor', requirementIds: ['R1'] },
  ] };
  const context = { binding: { ...ids, specRevision: run.specRevision, planRevision: run.planRevision }, task: { tasks: run.tasks },
    requirements: [{ id: 'R1' }], engineeringContract: { views: [{ path: '/', selectors: [{ testId: 'item', role: 'listitem' }] }] } };
  const saved = structuredClone(input);
  const repaired = suggestVerificationDraft(input, context);
  assert.ok(repaired);
  assert.deepEqual(input, saved);
  assert.deepEqual(repaired.draft.steps, saved.steps);
  assert.deepEqual(repaired.draft.browser.steps.slice(0, 2), saved.browser.steps.slice(0, 2));
  assert.deepEqual(repaired.draft.browser.steps[2], { ...race, countTestId: 'taskflow-visible-total' });
  assert.deepEqual(repaired.draft.browser.steps.slice(3, 5).map(({ op, testId, value, session }) => ({ op, testId, value, session })), [
    { op: 'fill', testId: 'input', value: '新资源', session: 'visitor' }, { op: 'click', testId: 'submit', value: undefined, session: 'visitor' },
  ]);
  assert.deepEqual(repaired.draft.browser.steps.at(-1), saved.browser.steps.at(-1));
  assert.equal(suggestVerificationDraft(repaired.draft, context), null);
  context.engineeringContract.views[0].selectors[0].role = 'status';
  assert.equal(suggestVerificationDraft(input, context), null);
});
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
async function importManual(service, body = proposal(), feedback = '人工导入公开固定定义，仅供结构审阅') {
  const { capabilities } = await service.list(ids);
  return (await service.importDefinition({ ...ids, contractRevision: capabilities.contractRevision, proposal: body, feedback })).proposal;
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

test('durable Worker grant carries the complete approved requirement text and remains revision-bound', async t => {
  let current;
  const body = { ...proposal(), browser: { version: 1, sessions: ['visitor'], steps: [
    { id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' },
    { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true },
  ] } };
  const f = await fixture(t, { getPlanningSync: () => current, dependencies: { createModel: fakeModel(async input => { await input.onReceipt(receipt(body)); return result(body); }) } });
  current = f.data;
  const requested = await propose(f.service), draft = await wait(f.service, requested.id, 'draft');
  await f.service.approve(edit(draft));
  const grant = f.service.workerExecution({ ...ids, proposalId: draft.id, revision: draft.revision, jobId: 'worker-requirements', executionId: 'execution-requirements' });
  assert.deepEqual(grant.task.requirements, current.run.spec.requirements.map(r => ({ id: r.id, text: `${r.title}\n${r.description}\n${r.acceptance.join('\n')}` })));
  assert.equal(grant.assertCurrent(), true);
  current.run.spec.requirements[0].description = '未经新版本批准的替换需求';
  assert.throws(() => grant.assertCurrent(), error => error.status === 409);
  assert.ok(!grant.task.requirements[0].text.includes('未经新版本'));
});

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
  for (const [index, behavior] of cases.entries()) {
    const f = await fixture(t, { dependencies: { createModel: fakeModel(behavior) } }); const row = await wait(f.service, (await propose(f.service)).id, row => row.status !== 'generating');
    assert.equal(row.status, index === 0 ? 'reconciliation_required' : 'failed'); assert.equal(row.proposal, null); assert.equal(row.approval, null); assert.equal(row.actions.canApprove, false);
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
  assert.equal(row.status, 'reconciliation_required'); assert.equal(row.errorCode, 'receipt_failed'); assert.equal(row.proposal, null);
  assert.equal((await f.service.list(ids)).capabilities.canPropose, false);
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

for (const mode of ['reset', 'truncated', 'rejected-stream', 'invalid-json', 'http-rejection']) test(`native transport ${mode} releases a slot only with complete response evidence`, async t => {
  const unfinished = ['reset', 'truncated', 'rejected-stream'].includes(mode);
  const f = await fixture(t, { dependencies: { createModel: options => createVerificationModel({ ...options, fetchImpl: async () => {
    if (mode === 'reset') throw Object.assign(new Error('private upstream reset'), { code: 'ECONNRESET' });
    if (mode === 'invalid-json') return new Response('{ invalid json');
    if (mode === 'http-rejection') return new Response('denied', { status: 401 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); controller.error(new Error('private stream interrupted')); } }), { status: mode === 'rejected-stream' ? 401 : 200 });
  } }) } });
  const row = await wait(f.service, (await propose(f.service)).id, value => !['generating', 'cancel_requested'].includes(value.status));
  assert.equal(row.status, unfinished ? 'reconciliation_required' : 'failed');
  assert.equal(row.dispatched, true); assert.equal(row.proposal, null); assert.deepEqual(row.usage, { inputTokens: null, outputTokens: null });
  assert.equal((await f.service.list(ids)).capabilities.canPropose, !unfinished);
  if (unfinished) await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true), code('project_busy'));
  else assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => true), true);
  await f.service.shutdown(); const reopened = await f.open();
  assert.equal((await reopened.list(ids)).capabilities.canPropose, !unfinished);
});

test('unbranded provider error fields cannot forge native response completion', async t => {
  const f = await fixture(t, { dependencies: { createModel: fakeModel(async () => { throw Object.assign(new Error('synthetic failure'), { code: 'transport_error', dispatched: false, responseComplete: true, remoteConfirmed: true }); }) } });
  const row = await wait(f.service, (await propose(f.service)).id, 'reconciliation_required');
  assert.equal(row.dispatched, true); assert.equal((await f.service.list(ids)).capabilities.canPropose, false);
});

test('native configuration rejection before fetch does not strand the project as an unknown request', async t => {
  let calls = 0;
  const f = await fixture(t, { config: { ...config, baseUrl: 'not a URL' }, dependencies: { createModel: options => createVerificationModel({ ...options,
    fetchImpl: async () => { calls++; throw new Error('must not send'); } }) } });
  const row = await wait(f.service, (await propose(f.service)).id, 'failed');
  assert.equal(calls, 0); assert.equal(row.errorCode, 'invalid_input');
  assert.equal((await f.service.list(ids)).capabilities.canPropose, true);
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => true), true);
  await f.service.shutdown(); const reopened = await f.open();
  assert.equal((await reopened.list(ids)).capabilities.canPropose, true);
});

for (const interruption of ['cancel', 'timeout']) test(`actual HTTP adapter ${interruption} cannot confirm remote stop from a settled local Promise`, async t => {
  const entered = deferred();
  const f = await fixture(t, { timeoutMs: interruption === 'timeout' ? 250 : 2000, cleanupMs: 30, dependencies: {
    createModel: options => createVerificationModel({ ...options, fetchImpl: async (_url, request) => {
      entered.resolve();
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('local transport aborted without remote acknowledgement')), { once: true }));
    } }),
  } });
  const row = await propose(f.service); await entered.promise;
  if (interruption === 'cancel') await f.service.cancel({ ...ids, proposalId: row.id });
  const stopped = await wait(f.service, row.id, 'reconciliation_required');
  assert.equal(stopped.dispatched, true); assert.equal(stopped.proposal, null);
  assert.deepEqual(stopped.usage, { inputTokens: null, outputTokens: null });
  assert.equal(stopped.errorCode, interruption === 'cancel' ? 'cancelled' : 'model_timeout');
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true), code('project_busy'));
  assert.equal((await f.service.list(ids)).capabilities.canPropose, false);
  await f.service.shutdown(); const reopened = await f.open();
  assert.equal((await reopened.list(ids)).proposals[0].status, 'reconciliation_required');
  assert.equal((await reopened.list(ids)).capabilities.canPropose, false);
});

test('cancellation before dispatch confirms local stop without leaving a remote request slot', async t => {
  const gate = deferred(), entered = deferred(); let reads = 0, modelCalls = 0;
  const f = await fixture(t, { getPlanning: () => { if (++reads === 3) { entered.resolve(); return gate.promise; } return planning(); },
    dependencies: { createModel: fakeModel(async input => { modelCalls++; await input.onReceipt(receipt()); return result(); }) } });
  const row = await propose(f.service); await entered.promise;
  await f.service.cancel({ ...ids, proposalId: row.id });
  const stopped = await wait(f.service, row.id, 'cancelled');
  assert.equal(stopped.dispatched, false); assert.equal(modelCalls, 0);
  gate.resolve(planning()); await tick();
  assert.equal((await f.service.list(ids)).capabilities.canPropose, true);
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => 'safe'), 'safe');
});

test('cooperative local cancellation keeps remote status unknown and consumed attempt metadata', async t => {
  const entered = deferred(); const f = await fixture(t, { dependencies: { createModel: fakeModel(input => { entered.resolve(); return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('private provider detail')), { once: true })); }) } });
  const row = await propose(f.service); await entered.promise;
  const requested = (await f.service.cancel({ ...ids, proposalId: row.id })).proposal; assert.equal(requested.status, 'cancel_requested');
  const stopped = await wait(f.service, row.id, 'reconciliation_required'); assert.equal(stopped.proposal, null); assert.equal(stopped.dispatched, true); assert.deepEqual(stopped.usage, { inputTokens: null, outputTokens: null });
  assert.equal((await f.service.list(ids)).capabilities.canPropose, false);
  assert.equal((await f.service.list(ids)).capabilities.budget.remainingAttempts, 2); await assert.rejects(f.service.cancel({ ...ids, proposalId: row.id }), code('not_running'));
});

test('total deadline includes private receipt writes; uncooperative model/writer retains unknown slot and cannot publish late', async t => {
  // Reach the intended boundary before advancing the same 70 ms deadline.
  // Real disk scheduling under the full native suite must not decide whether
  // this test exercises a pending writer or a pre-dispatch timeout instead.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const release = deferred(), late = deferred(), written = deferred(), modelEnded = deferred(); let entered = false, input;
  const pump = async (read, advance = false) => { const end = performance.now() + 5000; for (;;) { const value = await read(); if (value) return value;
    assert.ok(performance.now() < end, 'bounded fixture boundary was not reached'); await tick(); if (advance) t.mock.timers.tick(1); } };
  try {
  const f = await fixture(t, { timeoutMs: 70, cleanupMs: 15, dependencies: { writeReceipt: async ({ filename, contents }) => { entered = true; await release.promise; await writeFile(filename, contents, { flag: 'wx', mode: 0o600 }); written.resolve(); } } });
  const reserved = await propose(f.service); await pump(() => entered); t.mock.timers.tick(70);
  const row = await pump(async () => { const row = (await f.service.list(ids)).proposals.find(row => row.id === reserved.id); return row?.status === 'reconciliation_required' && row; }, true);
  assert.equal(row.receiptState, 'unknown'); assert.equal(row.errorCode, 'model_timeout'); assert.deepEqual(row.usage, { inputTokens: 7, outputTokens: 11 });
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => true), code('project_busy')); await assert.rejects(propose(f.service), code('project_busy'));
  release.resolve(); let writeFinished = false; written.promise.then(() => { writeFinished = true; }); await pump(() => writeFinished); await tick(); assert.equal((await f.service.list(ids)).proposals[0].status, 'reconciliation_required');
  assert.equal((await f.service.list(ids)).proposals[0].proposal, null);
  const g = await fixture(t, { timeoutMs: 70, cleanupMs: 15, dependencies: { createModel: fakeModel(async value => { input = value; try { await late.promise; await value.onReceipt(receipt()); return result(); } finally { modelEnded.resolve(); } }) } });
  const next = await propose(g.service); await pump(() => input); t.mock.timers.tick(70);
  await pump(async () => (await g.service.list(ids)).proposals.find(row => row.id === next.id)?.status === 'reconciliation_required', true);
  await assert.rejects(input.onReceipt(receipt())); late.resolve(); let modelFinished = false; modelEnded.promise.then(() => { modelFinished = true; }); await pump(() => modelFinished); await tick(); assert.equal((await g.service.list(ids)).proposals[0].proposal, null); assert.deepEqual(await readdir(path.join(g.rootDir, 'receipts')), []);
  } finally { release.resolve(); late.resolve(); t.mock.timers.reset(); }
});

test('receipt sink failure is sanitized and a settled local timeout cannot release a remote request', async t => {
  const f = await fixture(t, { dependencies: { writeReceipt: async () => { throw new Error(config.apiKey + ' C:/private/provider'); } } });
  const row = await wait(f.service, (await propose(f.service)).id, 'failed'); assert.equal(row.receiptState, 'failed'); assert.equal(row.errorCode, 'receipt_failed'); assert.equal(JSON.stringify(row).includes(config.apiKey), false);
  const g = await fixture(t, { timeoutMs: 70, cleanupMs: 15, dependencies: { createModel: fakeModel(input => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }))) } });
  const timed = await wait(g.service, (await propose(g.service)).id, 'reconciliation_required'); assert.equal(timed.errorCode, 'model_timeout'); assert.equal((await g.service.list(ids)).capabilities.canPropose, false);
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

test('manual import after a completed failed model preserves its charges and cannot replenish the model budget', async t => {
  let calls = 0;
  const f = await fixture(t, { maxAttempts: 1, dependencies: { createModel: fakeModel(async input => { calls++; await input.onReceipt(receipt(proposal(), { finishReason: 'length' })); throw new Error('complete truncated synthetic response'); }) } });
  const failed = await wait(f.service, (await propose(f.service)).id, 'failed');
  const bytes = await readFile(path.join(f.rootDir, 'receipts', failed.id + '.json'));
  const row = await importManual(f.service);
  assert.equal(row.origin, 'manual'); assert.equal(row.status, 'draft'); assert.equal(row.approved, false); assert.equal(row.executed, false);
  assert.equal(row.attempt, 2); assert.equal(row.model, null); assert.equal(row.finishReason, null); assert.deepEqual(row.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(row.dispatched, false); assert.equal(row.receiptState, 'not_applicable'); assert.equal(row.receipt, null); assert.equal(row.history[0].status, 'imported');
  const listed = await f.service.list(ids); assert.deepEqual(listed.proposals[0], failed); assert.equal(listed.proposals[0].origin, 'model');
  assert.deepEqual(await readFile(path.join(f.rootDir, 'receipts', failed.id + '.json')), bytes); assert.equal(calls, 1);
  assert.equal(listed.capabilities.budget.remainingAttempts, 0); assert.equal(listed.capabilities.manualBudget.remainingDefinitions, 19);
  await assert.rejects(propose(f.service), code('budget_exhausted'));
  await f.service.shutdown(); const reopened = await f.open(); assert.equal((await reopened.list(ids)).proposals[1].origin, 'manual');
  assert.equal((await reopened.list(ids)).capabilities.budget.remainingAttempts, 0); assert.equal(calls, 1);
});

test('unconfigured model still permits a guarded manual draft and never mints approval or private model receipts', async t => {
  let calls = 0;
  const f = await fixture(t, { config: { baseUrl: '', model: '', apiKey: '' }, dependencies: { createModel: () => { calls++; throw new Error('must not construct a model'); } } });
  const state = await f.service.list(ids); assert.equal(state.capabilities.canPropose, false); assert.equal(state.capabilities.canImportDefinition, true);
  const row = await importManual(f.service); assert.equal(row.origin, 'manual'); assert.equal(calls, 0); assert.deepEqual(await readdir(path.join(f.rootDir, 'receipts')), []);
  assert.throws(() => compileManifest({ proposal: row.proposal, requirements: ['R1'], binding: row.binding, approval: row.approval }));
  const db = new DatabaseSync(path.join(f.rootDir, 'verification.sqlite'), { readOnly: true });
  try { const stored = db.prepare('SELECT * FROM proposals WHERE id=?').get(row.id); assert.equal(stored.origin, 'manual'); assert.equal(stored.active, 0); assert.equal(JSON.parse(stored.history)[0].proposal.id, proposal().id); assert.equal(JSON.parse(stored.snapshot).context.binding.runId, ids.runId); } finally { db.close(); }
});

test('manual count is bounded separately and concurrent mixed admissions use MAX attempt without returning model fees', async t => {
  const f = await fixture(t);
  const settled = await Promise.allSettled(Array.from({ length: 21 }, (_, index) => importManual(f.service, proposal('人工 ' + index))));
  const rows = settled.filter(x => x.status === 'fulfilled').map(x => x.value); assert.equal(rows.length, 20);
  assert.equal(settled.filter(x => x.status === 'rejected').length, 1); assert.equal(settled.find(x => x.status === 'rejected').reason.code, 'manual_budget_exhausted');
  assert.deepEqual(rows.map(x => x.attempt).sort((a, b) => a - b), Array.from({ length: 20 }, (_, n) => n + 1));
  let state = await f.service.list(ids); assert.equal(state.capabilities.budget.remainingAttempts, 3); assert.equal(state.capabilities.canImportDefinition, false); assert.equal(state.capabilities.manualBudget.remainingDefinitions, 0);
  for (let index = 0; index < 3; index++) { const row = await wait(f.service, (await propose(f.service)).id, 'draft'); assert.equal(row.attempt, 21 + index); assert.equal(row.origin, 'model'); }
  state = await f.service.list(ids); assert.equal(state.capabilities.budget.remainingAttempts, 0); assert.equal(state.proposals.length, 23);
  await assert.rejects(propose(f.service), code('budget_exhausted')); await assert.rejects(importManual(f.service), code('manual_budget_exhausted'));
});

test('old proposals migrate to model origin with unchanged receipts and attempt attribution', async t => {
  const f = await fixture(t), row = await wait(f.service, (await propose(f.service)).id, 'draft');
  const receiptFile = path.join(f.rootDir, 'receipts', row.id + '.json'), receiptBytes = await readFile(receiptFile); await f.service.shutdown();
  const filename = path.join(f.rootDir, 'verification.sqlite'), old = new DatabaseSync(filename);
  let before; try { old.exec('ALTER TABLE proposals DROP COLUMN origin'); before = old.prepare('SELECT * FROM proposals').all().map(row => ({ ...row })); } finally { old.close(); }
  const reopened = await f.open(), migrated = new DatabaseSync(filename, { readOnly: true });
  try { const column = migrated.prepare('PRAGMA table_info(proposals)').all().find(c => c.name === 'origin'); assert.equal(column.notnull, 1); assert.equal(column.dflt_value, "'model'"); const after = migrated.prepare('SELECT * FROM proposals').all(); assert.equal(after[0].origin, 'model'); assert.deepEqual(after.map(({ origin, ...rest }) => rest), before); } finally { migrated.close(); }
  const state = await reopened.list(ids); assert.equal(state.proposals[0].id, row.id); assert.equal(state.proposals[0].origin, 'model'); assert.equal(state.capabilities.budget.remainingAttempts, 2);
  assert.deepEqual(await readFile(receiptFile), receiptBytes);
  const manual = await importManual(reopened); assert.equal(manual.attempt, 2); assert.equal(manual.origin, 'manual');
});

test('manual import never bypasses active or unknown requests, including after owner recovery', async t => {
  const hold = deferred(), entered = deferred();
  const f = await fixture(t, { dependencies: { createModel: fakeModel(async () => { entered.resolve(); await hold.promise; throw new Error('local rejection without remote-stop evidence'); }) } });
  const pending = await propose(f.service); await entered.promise;
  assert.equal((await f.service.list(ids)).capabilities.canImportDefinition, false); await assert.rejects(importManual(f.service), code('project_busy'));
  hold.resolve(); await wait(f.service, pending.id, 'reconciliation_required'); await assert.rejects(importManual(f.service), code('project_busy'));
  await f.service.shutdown(); const reopened = await f.open(); assert.equal((await reopened.list(ids)).capabilities.canImportDefinition, false); await assert.rejects(importManual(reopened), code('project_busy'));
});

test('manual import requires exact contract, safe full DSL, secret-free feedback and ordinary unprivileged data', async t => {
  const f = await fixture(t), contractRevision = (await f.service.list(ids)).capabilities.contractRevision;
  const input = { ...ids, contractRevision, proposal: proposal(), feedback: '人工核对' };
  await assert.rejects(f.service.importDefinition({ ...input, contractRevision: 'old' }), code('contract_changed'));
  const invalid = proposal(); invalid.steps[0].requirementIds = ['unconfirmed']; await assert.rejects(f.service.importDefinition({ ...input, proposal: invalid }), code('invalid_proposal'));
  await assert.rejects(f.service.importDefinition({ ...input, feedback: config.apiKey }), code('credential_response'));
  await assert.rejects(f.service.importDefinition({ ...input, proposal: proposal(config.apiKey) }), code('credential_response'));
  for (const extra of [{ origin: 'model' }, { usage: { inputTokens: 0 } }, { approval: {} }, { passed: true }]) await assert.rejects(f.service.importDefinition({ ...input, ...extra }), error => error.status === 400);
  let accessed = false; const unsafe = { ...input }; Object.defineProperty(unsafe, 'proposal', { enumerable: true, get() { accessed = true; return proposal(); } });
  await assert.rejects(f.service.importDefinition(unsafe), error => error.status === 400); assert.equal(accessed, false); assert.equal((await f.service.list(ids)).proposals.length, 0);
});

test('manual import cannot cross planning approvals, source generations or a project checkpoint', async t => {
  const f = await fixture(t), initial = structuredClone(f.data);
  for (const mutate of [d => { d.run.approvals.plan = null; }, d => { d.run.approvals.spec = null; }, d => { d.project.sourceGeneration++; }, d => { d.run.sourceSuperseded = true; }]) {
    Object.assign(f.data, structuredClone(initial)); mutate(f.data); const state = await f.service.list(ids); assert.equal(state.capabilities.canImportDefinition, false);
    await assert.rejects(importManual(f.service), error => error.status === 409);
  }
  Object.assign(f.data, structuredClone(initial)); const hold = deferred(), entered = deferred();
  const checkpoint = f.service.withProjectCheckpoint(ids.projectId, async () => { entered.resolve(); await hold.promise; }); await entered.promise;
  try { assert.equal((await f.service.list(ids)).capabilities.canImportDefinition, false); await assert.rejects(importManual(f.service), code('project_checkpoint')); } finally { hold.resolve(); await checkpoint; }
  assert.equal((await f.service.list(ids)).proposals.length, 0);
});

test('manual source cannot wash rejected manifests and normal revision approval authorizes only its exact frozen Worker version', async t => {
  let current; const f = await fixture(t, { getPlanningSync: () => current }); current = f.data;
  const first = await importManual(f.service); await f.service.reject(edit(first));
  const same = await importManual(f.service); assert.equal(same.actions.canApprove, false); await assert.rejects(f.service.approve(edit(same)), code('revision_required'));
  const body = { ...proposal('真实修订定义'), browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } };
  const revised = (await f.service.revise(edit(same, { proposal: body }))).proposal; assert.equal(revised.origin, 'manual'); assert.equal(revised.history.length, 2);
  const workerInput = { ...ids, proposalId: revised.id, revision: revised.revision, jobId: 'manual-worker', executionId: 'manual-execution' };
  assert.throws(() => f.service.workerExecution(workerInput), code('approval_required')); await f.service.approve(edit(revised));
  const grant = f.service.workerExecution(workerInput); assert.equal(grant.assertCurrent(), true); assert.deepEqual(grant.task.requirements, [{ id: 'R1', text: '读取\n读取资源\n返回资源集合' }]);
  assert.equal((await f.service.list(ids)).capabilities.canImportDefinition, false); await assert.rejects(importManual(f.service), error => ['project_busy', 'definition_frozen'].includes(error.code));
  await assert.rejects(f.service.revise(edit(revised, { proposal: proposal('编码后不能改变') })), code('definition_frozen'));
  assert.equal((await f.service.list(ids)).capabilities.budget.remainingAttempts, 3); assert.deepEqual(await readdir(path.join(f.rootDir, 'receipts')), []);
});

async function openPredecessor(f) {
  // Load a real service with a different implementation fingerprint. Only its
  // module location/import URLs and a comment differ; business planning and DSL
  // stay identical. This portable regression does not depend on local output/i8.
  const currentURL = new URL('../lib/verification-planning-service.mjs', import.meta.url);
  const oldCode = (await readFile(currentURL, 'utf8')).replace(/(['"])(\.\.?\/[^'"]+)\1/gu, (_all, quote, relative) => quote + new URL(relative, currentURL).href + quote) + '\n// Predecessor service implementation fingerprint.\n';
  const oldFile = path.join(f.rootDir, 'predecessor-service.mjs'); await writeFile(oldFile, oldCode);
  const predecessor = await import(pathToFileURL(oldFile).href), previous = await predecessor.createVerificationPlanningService(f.base); f.services.push(previous);
  return previous;
}

test('trusted retries derive exact private diagnostics across service versions and do not change the default budget', async t => {
  const valid = proposal();
  valid.browser = { version: 1, sessions: ['visitor'], steps: [
    { id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' },
    { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true },
  ] };
  const invalid = structuredClone(valid);
  invalid.browser.steps.pop();
  invalid.name = 'private unreplayed model text';
  invalid.steps[0].requirementIds = ['UNKNOWN'];
  invalid.steps[0].dependsOn = [{ step: 'future' }, 'missing'];
  const responses = [JSON.stringify(invalid), '{"version": 1,', JSON.stringify(valid)];
  const inputs = [];
  const f = await fixture(t, { maxAttempts: 1, dependencies: { createModel: options => createVerificationModel({ ...options, fetchImpl: async (_url, request) => {
    const { messages } = JSON.parse(request.body);
    inputs.push(JSON.parse(messages[1].content));
    assert.ok(inputs.length <= responses.length);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: responses[inputs.length - 1] } }] }));
  } }) } });
  await f.service.shutdown();
  const predecessor = await openPredecessor(f);
  const previous = await wait(predecessor, (await propose(predecessor)).id, 'failed');
  assert.equal(previous.receiptState, 'saved');
  assert.equal(Object.hasOwn(inputs[0], 'retryFeedback'), false);
  await predecessor.shutdown();

  const current = await f.open(), extended = { additionalAttempts: 2 };
  const standard = (await current.list(ids)).capabilities;
  const rework = (await current.list(ids, extended)).capabilities;
  assert.equal(standard.canPropose, false);
  assert.equal(standard.budget.maxAttempts, 1);
  assert.equal(rework.budget.maxAttempts, 3);
  assert.notEqual(rework.contractRevision, standard.contractRevision);
  const reworkInput = { ...ids, contractRevision: rework.contractRevision };
  const retry = previousProposalId => current.propose(reworkInput, { ...extended, previousProposalId });
  await assert.rejects(current.propose({ ...reworkInput, additionalAttempts: 2 }), code('invalid_input'));
  await assert.rejects(current.propose(reworkInput, extended), code('retry_source_required'));
  await assert.rejects(current.propose({ ...reworkInput, contractRevision: standard.contractRevision }, { ...extended, previousProposalId: previous.id }), code('contract_changed'));

  const filename = path.join(f.rootDir, 'receipts', `${previous.id}.json`), original = await readFile(filename);
  await writeFile(filename, Buffer.concat([original, Buffer.from('tampered')]));
  await assert.rejects(retry(previous.id), code('invalid_retry_receipt'));
  await writeFile(filename, original);
  assert.equal(inputs.length, 1);

  const next = await wait(current, (await retry(previous.id)).proposal.id, 'failed');
  assert.notEqual(next.binding.policyHash, previous.binding.policyHash);
  assert.match(inputs[1].retryFeedback, /HTTP 步骤缺少需求编号 R1/u);
  assert.match(inputs[1].retryFeedback, /read 的 dependsOn 必须是前序步骤编号的字符串数组/u);
  assert.match(inputs[1].retryFeedback, /read 引用了不存在的依赖 missing/u);
  assert.match(inputs[1].retryFeedback, /浏览器业务断言缺少页面相关需求编号 R1/u);
  assert.doesNotMatch(JSON.stringify(inputs[1]), /private unreplayed model text/u);
  assert.doesNotMatch(JSON.stringify(next), /retryFeedback|private unreplayed model text/u);
  await assert.rejects(retry(previous.id), code('stale_retry_source'));

  const final = await wait(current, (await retry(next.id)).proposal.id, 'draft');
  assert.match(inputs[2].retryFeedback, /无法解析为有效的清单 JSON/u);
  assert.equal((await current.approve(edit(final))).proposal.approved, true);
  assert.equal((await current.list(ids, extended)).capabilities.budget.remainingAttempts, 0);
  assert.equal(inputs.length, 3);
});

test('implementation policy changes cannot clear real persisted rejection across manual, model and edit flows', async t => {
  const f = await fixture(t); await f.service.shutdown();
  const previous = await openPredecessor(f);
  const first = await wait(previous, (await propose(previous)).id, 'draft'), rejected = (await previous.reject(edit(first))).proposal;
  assert.equal(rejected.status, 'rejected'); await previous.shutdown();
  const database = new DatabaseSync(path.join(f.rootDir, 'verification.sqlite'), { readOnly: true }); let originalRejections;
  try { originalRejections = database.prepare('SELECT * FROM rejections').all(); } finally { database.close(); }
  const current = await f.open(), manual = await importManual(current);
  assert.notEqual(manual.binding.policyHash, rejected.binding.policyHash); assert.equal(manual.binding.contextHash, rejected.binding.contextHash);
  assert.equal(manual.manifestHash, rejected.manifestHash); assert.equal(manual.actions.canApprove, false);
  await assert.rejects(current.approve(edit(manual)), code('revision_required'));
  const generated = await wait(current, (await propose(current)).id, 'draft'); assert.equal(generated.actions.canApprove, false);
  await assert.rejects(current.approve(edit(generated)), code('revision_required'));
  const changed = (await current.revise(edit(manual, { proposal: proposal('实际不同的定义') }))).proposal;
  assert.notEqual(changed.manifestHash, rejected.manifestHash); assert.equal((await current.approve(edit(changed))).proposal.approved, true);
  const reverted = (await current.revise(edit(changed, { proposal: proposal() }))).proposal;
  assert.equal(reverted.actions.canApprove, false); await assert.rejects(current.approve(edit(reverted)), code('revision_required'));
  f.data.run.artifacts[0].content += '\n真实的新计划修订'; f.data.run.planRevision = planningRevision(f.data.run); f.data.run.approvals.plan.revision = f.data.run.planRevision;
  const newPlan = await importManual(current); assert.notEqual(newPlan.manifestHash, rejected.manifestHash); assert.equal((await current.approve(edit(newPlan))).proposal.approved, true);
  const source = planning(ids.projectId, 'new-source-run'); source.run.sourceSnapshot.content += '\n新来源版本'; source.run.sourceRevision = contentRevision(source.run.sourceSnapshot);
  source.run.sourceGeneration = 1; source.project.sourceGeneration = 1; source.project.source = source.run.sourceSnapshot; source.project.currentSourceRevision = source.run.sourceRevision; Object.assign(f.data, source);
  const binding = { projectId: ids.projectId, runId: 'new-source-run' }, listing = await current.list(binding);
  const newSource = (await current.importDefinition({ ...binding, contractRevision: listing.capabilities.contractRevision, proposal: proposal(), feedback: '新来源与新运行，仍须人工确认' })).proposal;
  assert.notEqual(newSource.manifestHash, rejected.manifestHash); assert.equal((await current.approve(edit(newSource))).proposal.approved, true);
  const after = new DatabaseSync(path.join(f.rootDir, 'verification.sqlite'), { readOnly: true });
  try { assert.deepEqual(after.prepare('SELECT * FROM rejections').all(), originalRejections); } finally { after.close(); }
});
test('large planning admission freezes its longer model deadline and reports exact over-budget diagnostics', async t => {
  const large = planning(ids.projectId, ids.runId, 16), inputs = [], createTimeouts = [];
  const raw = proposal(), requirementIds = large.run.spec.requirements.map(item => item.id);
  raw.steps[0].requirementIds = requirementIds;
  const browser = { version: 1, sessions: ['visitor'], steps: [
    { id: 'home', session: 'visitor', requirementIds, op: 'goto', path: '/' },
    { id: 'list', session: 'visitor', requirementIds, op: 'visible', testId: 'resources', value: true },
  ] };
  const overflow = structuredClone(raw);
  overflow.steps = Array.from({ length: 51 }, (_, index) => ({
    ...overflow.steps[0], id: 'step-' + index, request: { ...overflow.steps[0].request, id: 'request-' + index,
      assertions: [{ id: 'status-' + index, op: 'status', value: 200 }] },
  }));
  const f = await fixture(t, { getPlanning: () => large, getPlanningSync: () => large, timeoutMs: undefined,
    dependencies: { createModel: options => {
      createTimeouts.push(options.config.timeoutMs);
      return createVerificationModel({ ...options, fetchImpl: async (_url, request) => {
        inputs.push(JSON.parse(JSON.parse(request.body).messages[1].content));
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify([overflow, raw, browser][inputs.length - 1]) } }] }));
      } });
    } } });
  const { capabilities } = await f.service.list(ids);
  assert.equal(capabilities.budget.timeoutMs, 120000);
  const first = await wait(f.service, (await propose(f.service)).id, 'failed');
  assert.equal(first.receiptState, 'saved');
  const second = await f.service.propose({ ...ids, contractRevision: capabilities.contractRevision }, { previousProposalId: first.id });
  const acceptedDraft = await wait(f.service, second.proposal.id, 'draft');
  assert.equal(acceptedDraft.proposal.steps.length, 1);
  assert.equal(createTimeouts.length, 2);
  assert.ok(createTimeouts.every(ms => ms > 60000 && ms <= 120000));
  assert.match(inputs[1].retryFeedback, /51 个 HTTP 步骤，硬上限为 40/u);
  assert.equal(acceptedDraft.generationStage, 'http');
  assert.equal(acceptedDraft.actions.canApprove, false);
  await assert.rejects(f.service.approve(edit(acceptedDraft)), code('definition_incomplete'));
  assert.equal(Object.hasOwn(inputs[1], 'browserObligations'), false);

  // A later receipt must be composed with the precise HTTP artifact.
  const db = new DatabaseSync(path.join(f.rootDir, 'verification.sqlite'));
  try {
    const broken = structuredClone(acceptedDraft.proposal); broken.name = 'Unverified change';
    db.prepare('UPDATE proposals SET proposal=? WHERE id=?').run(JSON.stringify(broken), acceptedDraft.id);
    await assert.rejects(f.service.propose({ ...ids, contractRevision: capabilities.contractRevision }), code('stale_verification_stage'));
    assert.equal(inputs.length, 2);
    db.prepare('UPDATE proposals SET proposal=? WHERE id=?').run(JSON.stringify(acceptedDraft.proposal), acceptedDraft.id);
  } finally { db.close(); }

  const third = await propose(f.service);
  const joint = await wait(f.service, third.id, 'draft');
  assert.equal(joint.generationStage, 'browser');
  assert.deepEqual(joint.proposal.steps, acceptedDraft.proposal.steps);
  assert.deepEqual(joint.proposal.browser.steps, browser.steps);
  assert.equal(joint.actions.canApprove, true);
  assert.deepEqual(inputs[2].browserObligations, requirementIds);
  assert.equal(Object.hasOwn(inputs[2], 'retryFeedback'), false);
  assert.equal((await f.service.approve(edit(joint))).proposal.approved, true);
  assert.equal((await f.service.list(ids)).capabilities.budget.remainingAttempts, 0);
});

test('predecessor definition keeps its original identity and only authorizes execution under a compatible validation policy', async t => {
  const layouts = [
    { dsl: '1a2f269ca3d663fc90a10273b3cb3c8eeed366f11d0c32d98152d74e560b714c', planning: 'cc771ddf230f6ddccb1d5cc413ea5cd47e5d5e6cec0570064bf6269bd1c2f9a4' },
    { dsl: 'c3d90eb76c23183e8d9b47057119e0ea449887db1cab43c04882bf341736a8b7', planning: '30178f9cdbad793616ad18c44602ae76c687983b8bb40d8275a70f09ebb4d53a' },
  ];
  const predecessor = layouts.find(layout => layout.dsl === verificationPolicyHash) ?? layouts[0];
  const sameValidationPolicy = predecessor.dsl === verificationPolicyHash;
  const priorHash = predecessor.planning;
  const planningRecord = planning(), body = proposal();
  body.browser = { version: 1, sessions: ['visitor'], steps: [
    { id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' },
    { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true },
  ] };
  const f = await fixture(t, { getPlanning: () => planningRecord, getPlanningSync: () => planningRecord });
  const imported = await importManual(f.service, body), approved = (await f.service.approve(edit(imported))).proposal;
  await f.service.shutdown();
  const database = new DatabaseSync(path.join(f.rootDir, 'verification.sqlite'));
  let revision, manifestHash;
  try {
    const row = database.prepare('SELECT snapshot,approval,proposal FROM proposals WHERE id=?').get(approved.id);
    const snapshot = JSON.parse(row.snapshot), approval = JSON.parse(row.approval);
    snapshot.binding.policyHash = priorHash;
    snapshot.key = contentRevision(snapshot.binding);
    revision = contentRevision({ proposal: JSON.parse(row.proposal), binding: snapshot.binding, policyHash: priorHash });
    approval.revision = revision;
    const { policyHash: _policy, manifestHash: _hash, checks: _checks, ...definition } = inspectVerificationProposal({
      proposal: JSON.parse(row.proposal), binding: snapshot.context.binding, requirements: snapshot.context.requirements.map(item => item.id), tasks: snapshot.context.task.tasks,
    });
    manifestHash = createHash('sha256').update(canonicalJSON({ ...definition, policyHash: predecessor.dsl })).digest('hex');
    database.prepare('UPDATE proposals SET context_key=?,snapshot=?,revision=?,approval=?,manifest_hash=? WHERE id=?')
      .run(snapshot.key, JSON.stringify(snapshot), revision, JSON.stringify(approval), manifestHash, approved.id);
  } finally { database.close(); }
  const restored = await f.open(), viewed = (await restored.list(ids)).proposals[0];
  assert.equal(viewed.status, 'approved');
  assert.equal(viewed.current, sameValidationPolicy);
  assert.equal(viewed.approved, sameValidationPolicy);
  assert.equal(viewed.revision, revision);
  assert.equal(viewed.policyHash, priorHash);
  assert.equal(viewed.manifestHash, manifestHash);
  const input = { ...ids, proposalId: approved.id, revision };
  if (!sameValidationPolicy) {
    assert.notEqual(manifestHash, approved.manifestHash);
    assert.throws(() => restored.assertApprovedDefinition(input), code('approval_required'));
    await assert.rejects(restored.withApprovedExecution(input, () => assert.fail('Old definition must not authorize execution.')));
    return;
  }
  assert.equal(manifestHash, approved.manifestHash);
  assert.equal(restored.assertApprovedDefinition(input).policyHash, priorHash);
  await restored.withApprovedExecution(input, grant => {
    assert.equal(grant.binding.policyHash, priorHash);
    assert.equal(grant.manifest.manifestHash, approved.manifestHash);
    assert.equal(grant.assertCurrent(), true);
    return { status: 'failed', terminationConfirmed: true };
  });
  assert.equal(restored.assertFrozenExecution(input).policyHash, priorHash);
  planningRecord.run.sourceGeneration = 1;
  planningRecord.project.sourceGeneration = 1;
  assert.throws(() => restored.assertFrozenExecution(input), code('stale_revision'));
});

test('an unfinished HTTP stage reopens and adds only missing checks before browser generation', async t => {
  const large = planning(ids.projectId, ids.runId, 16);
  const requirements = large.run.spec.requirements.map(value => value.id);
  const partial = proposal(); partial.steps[0].requirementIds = requirements.slice(0, -1);
  partial.steps[0].request.captures = [{ name: 'resourceId', path: '$.id' }];
  const supplement = { sessions: [], steps: [{
    ...structuredClone(partial.steps[0]), id: 'extra', dependsOn: [], requirementIds: ['R16'],
    request: { id: 'get-extra', method: 'GET', path: '/resources?id=${resourceId}', assertions: partial.steps[0].request.assertions },
  }] };
  const browser = { version: 1, sessions: ['visitor'], steps: [
    { id: 'home', session: 'visitor', requirementIds: requirements, op: 'goto', path: '/' },
    { id: 'list', session: 'visitor', requirementIds: requirements, op: 'visible', testId: 'resources', value: true },
  ] };
  const sent = [];
  const f = await fixture(t, { getPlanning: () => large, getPlanningSync: () => large, dependencies: {
    createModel: options => createVerificationModel({ ...options, fetchImpl: async (_url, request) => {
      sent.push(JSON.parse(JSON.parse(request.body).messages[1].content));
      const raw = [partial, supplement, browser][sent.length - 1];
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
    } }),
  } });
  const first = await wait(f.service, (await propose(f.service)).id, 'draft');
  assert.equal(first.generationStage, 'http');
  assert.equal(first.nextGenerationStage, 'http-supplement');
  assert.deepEqual(first.missingHttpRequirementIds, ['R16']);
  assert.deepEqual(sent[0].requirements.map(item => item.id), requirements.slice(0, 10));
  assert.equal(sent[0].httpTargetSteps, 22);
  assert.deepEqual(sent[0].engineeringContract.routes[0].requirementIds, requirements);
  await f.service.shutdown();
  const reopened = await f.open(), second = await wait(reopened, (await propose(reopened)).id, 'draft');
  assert.equal(second.generationStage, 'http-supplement');
  assert.equal(second.nextGenerationStage, 'browser');
  assert.deepEqual(second.missingHttpRequirementIds, []);
  assert.deepEqual(sent[1].httpMissing, ['R16']);
  assert.deepEqual(sent[1].requirements.map(item => item.id), ['R16']);
  assert.equal(sent[1].httpTargetSteps, 4);
  assert.equal(sent[1].remainingHttpSteps, 39);
  assert.deepEqual(sent[1].previousHttp, first.proposal);
  assert.deepEqual(second.proposal.steps[0], first.proposal.steps[0]);
  assert.deepEqual(second.proposal.steps[1].dependsOn, ['read']);
  assert.deepEqual(supplement.steps[0].dependsOn, []);
  assert.notEqual(second.proposal.steps[1].request.assertions[0].id, first.proposal.steps[0].request.assertions[0].id);
  assert.equal(second.proposal.steps[1].request.assertions[0].value, supplement.steps[0].request.assertions[0].value);
  assert.equal(second.actions.canApprove, false);
  const saved = JSON.parse(await readFile(path.join(f.rootDir, 'receipts', second.id + '.json'), 'utf8'));
  assert.deepEqual(JSON.parse(saved.content), supplement, 'the original provider response retains its check ID and dependencies');
  const final = await wait(reopened, (await propose(reopened)).id, 'draft');
  assert.equal(final.generationStage, 'browser');
  assert.equal(Object.hasOwn(final, 'nextGenerationStage'), false);
  assert.deepEqual(final.proposal.steps, second.proposal.steps);
  assert.equal(Object.hasOwn(sent[2], 'previousHttp'), false);
  assert.deepEqual(sent[2].requirements.map(item => item.id), requirements);
  assert.equal(Object.hasOwn(sent[2], 'httpTargetSteps'), false);
  assert.equal((await reopened.approve(edit(final))).proposal.approved, true);
  assert.deepEqual((await reopened.list(ids)).proposals.map(row => row.receiptState), ['saved', 'saved', 'saved']);
});

const wireConfig = { ...config, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', thinking: 'disabled', wireFormat: strictHttpWire };

test('strict wire receipts survive re-open, are explicit in the quote and become an ordinary reviewed joint draft', async t => {
  const large = planning(ids.projectId, ids.runId, 16);
  const requirements = large.run.spec.requirements.map(row => row.id);
  const initial = proposal(); initial.steps[0].requirementIds = requirements.slice(0, -1);
  const last = { ...structuredClone(initial.steps[0]), id: 'extra', requirementIds: ['R16'] };
  const browser = { version: 1, sessions: ['visitor'], steps: [
    { id: 'home', session: 'visitor', requirementIds: requirements, op: 'goto', path: '/' },
    { id: 'list', session: 'visitor', requirementIds: requirements, op: 'visible', testId: 'resources', value: true },
  ] };
  let selected = wireConfig;
  const dispatched = [];
  const f = await fixture(t, { getPlanning: () => large, getPlanningSync: () => large, getConfig: () => selected,
    dependencies: { createModel: options => createVerificationModel({ ...options, fetchImpl: async (url, { body }) => {
      const request = JSON.parse(body), tool = request.tools?.[0].function;
      const previous = dispatched.length;
      if (!tool) {
        dispatched.push({ endpoint: String(url) });
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(browser) } }] }));
      }
      const values = { id: initial.id, name: initial.name, sessions: [], step01: JSON.stringify(previous ? last : initial.steps[0]) };
      const argumentsText = JSON.stringify(Object.fromEntries(tool.parameters.required.map(key => [key, values[key] ?? ''])), null, 2);
      dispatched.push({ endpoint: String(url), argumentsText });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
        { type: 'function', function: { name: strictHttpTool, arguments: argumentsText } },
      ] } }] }));
    } }) },
  });
  const before = await f.service.list(ids), first = await wait(f.service, (await propose(f.service)).id, 'draft');
  assert.equal(first.finishReason, 'tool_calls');
  assert.equal(first.wireFormat, strictHttpWire);
  assert.equal(first.slotCount, 22);
  assert.deepEqual(first.missingHttpRequirementIds, ['R16']);
  assert.equal(first.actions.canApprove, false);
  assert.equal(Object.hasOwn(first, 'content'), false);
  const saved = JSON.parse(await readFile(path.join(f.rootDir, 'receipts', first.id + '.json'), 'utf8'));
  assert.equal(saved.content, dispatched[0].argumentsText);
  assert.equal(saved.finishReason, 'tool_calls');
  await f.service.shutdown();
  const reopened = await f.open();
  selected = { ...wireConfig }; delete selected.wireFormat;
  const ordinary = await reopened.list(ids);
  assert.notEqual(ordinary.capabilities.contractRevision, before.capabilities.contractRevision);
  await assert.rejects(propose(reopened), code('contract_changed'));
  assert.equal(dispatched.length, 1);
  selected = wireConfig;
  const second = await wait(reopened, (await propose(reopened)).id, 'draft');
  assert.equal(second.generationStage, 'http-supplement');
  assert.equal(second.finishReason, 'tool_calls');
  assert.equal(second.slotCount, 4);
  assert.deepEqual(second.missingHttpRequirementIds, []);
  assert.deepEqual(second.proposal.steps[0], first.proposal.steps[0]);
  const final = await wait(reopened, (await propose(reopened)).id, 'draft');
  assert.equal(final.generationStage, 'browser');
  assert.equal(final.finishReason, 'stop');
  assert.equal(Object.hasOwn(final, 'wireFormat'), false);
  assert.deepEqual(final.proposal.browser.steps, browser.steps);
  assert.deepEqual(dispatched.map(row => row.endpoint), ['https://api.deepseek.com/beta/chat/completions',
    'https://api.deepseek.com/beta/chat/completions', 'https://api.deepseek.com/chat/completions']);
  assert.equal((await reopened.approve(edit(final))).proposal.approved, true);
});

test('strict provider dispatch with incomplete response cannot be approved or automatically resent', async t => {
  const large = planning(ids.projectId, ids.runId, 16);
  let requests = 0;
  const f = await fixture(t, { getPlanning: () => large, getPlanningSync: () => large, config: wireConfig, timeoutMs: 100,
    dependencies: { createModel: options => createVerificationModel({ ...options, fetchImpl: async () => {
      requests++;
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
    } }) },
  });
  const first = await wait(f.service, (await propose(f.service)).id, 'reconciliation_required');
  assert.equal(first.dispatched, true);
  assert.equal(first.receiptState, 'not_received');
  assert.deepEqual(first.usage, { inputTokens: null, outputTokens: null });
  assert.equal(first.actions.canApprove, false);
  assert.equal((await f.service.list(ids)).capabilities.canPropose, false);
  await assert.rejects(propose(f.service), code('project_busy'));
  assert.equal(requests, 1);
});