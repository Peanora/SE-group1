import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJSON, createVerificationControl, inspectVerificationProposal, compileManifest, compileTaskManifest, assertCompiledManifest, assertTaskCompiledManifest, isTaskCompiledManifest, compiledManifestDefinition } from '../lib/verification-contract.mjs';
import { browserScenarioChecks } from '../lib/browser-scenario-contract.mjs';
import { createVerificationModel, verificationModelPolicy } from '../lib/verification-model.mjs';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';

// All fixtures describe observations only. No software or real model is executed.
const binding = { projectId: 'project', runId: 'run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const tasks = () => ['A', 'B', 'C'].map((id, index) => ({ id, title: `Task ${id}`, description: `Observable ${id}`, requirementIds: [`R${index + 1}`], dependsOn: id === 'B' ? ['A'] : [], writePaths: [`src/${id.toLowerCase()}.mjs`], inputs: ['Approved interfaces'], outputs: ['Observable behavior'], acceptance: [`Verify R${index + 1}`] }));
const http = (id, requirementId, dependsOn = [], extra = {}) => ({ id, type: 'request', dependsOn, requirementIds: [requirementId], request: { id: `${id}_request`, method: 'GET', path: `/${id}`, assertions: [{ id: `${id}_ok`, op: 'status', value: 200 }], ...extra } });
function proposal() {
  return { version: 1, id: 'task-scopes', name: 'Approved task observations', sessions: [], steps: [
    http('a', 'R1', [], { captures: [{ name: 'itemId', path: '$.id' }] }), http('c', 'R3'),
    { id: 'restart', type: 'restart', dependsOn: ['a'], requirementIds: ['R1'] },
    http('b', 'R2', ['restart'], { path: '/items/${itemId}', assertions: [{ id: 'b_ok', op: 'status', value: 200 }, { id: 'b_id', op: 'jsonEquals', path: '$.id', value: { $var: 'itemId' } }] }),
  ], browser: { version: 1, sessions: ['u', 'v'], steps: [
    { id: 'u_goto', session: 'u', requirementIds: ['R1'], op: 'goto', path: '/' },
    { id: 'v_goto', session: 'v', requirementIds: ['R3'], op: 'goto', path: '/other' },
    { id: 'u_fill', session: 'u', requirementIds: ['R1'], op: 'fill', testId: 'title', value: 'original input' },
    { id: 'u_a', session: 'u', requirementIds: ['R1'], op: 'visible', testId: 'a', value: true },
    { id: 'v_c', session: 'v', requirementIds: ['R3'], op: 'text', testId: 'c', value: 'C exact' },
    { id: 'u_click', session: 'u', requirementIds: ['R2'], op: 'click', testId: 'save' },
    { id: 'u_b', session: 'u', requirementIds: ['R2'], op: 'text', testId: 'b', value: 'B exact' },
  ] }, taskScopes: [
    { taskId: 'A', httpStepIds: ['a'], browserStepIds: ['u_a'] },
    { taskId: 'B', httpStepIds: ['b'], browserStepIds: ['u_b'] },
    { taskId: 'C', httpStepIds: ['c'], browserStepIds: ['v_c'] },
  ] };
}
const input = (raw = proposal(), currentTasks = tasks()) => ({ proposal: raw, requirements: ['R1', 'R2', 'R3'], binding, tasks: currentTasks });
function approved({ begin = true, raw = proposal() } = {}) {
  const control = createVerificationControl(), value = input(raw), approval = control.approve(value), manifest = compileManifest({ ...value, approval });
  if (begin) control.beginCoding(approval);
  return { control, approval, manifest, tasks: value.tasks };
}
const compile = (f, taskId = 'B', currentTasks = f.tasks) => compileTaskManifest({ manifest: f.manifest, taskId, tasks: currentTasks });
const invalid = error => error?.code === 'invalid_contract';

test('legacy definitions stay whole-project definitions and require no task context', () => {
  const raw = proposal(); delete raw.taskScopes;
  const base = { proposal: raw, requirements: ['R1', 'R2', 'R3'], binding };
  const before = inspectVerificationProposal(base), supplied = inspectVerificationProposal({ ...base, tasks: [] });
  assert.deepEqual(before, supplied); assert.equal(Object.hasOwn(before, 'taskSetHash'), false);
  const f = approved({ raw }); assert.equal(isTaskCompiledManifest(f.manifest), false); assert.equal(Object.hasOwn(f.manifest, 'executionScope'), false);
  assert.throws(() => compile(f), invalid);
});

test('scopes bind every complete task object and selected checks into the parent approval', () => {
  const first = inspectVerificationProposal(input()); assert.equal(first.taskSetHash, digest(tasks()));
  for (const mutate of [value => value[0].acceptance.push('Additional acceptance'), value => value[2].writePaths.push('src/extra.mjs'), value => value.reverse()]) {
    const changed = tasks(); mutate(changed);
    assert.notEqual(inspectVerificationProposal(input(proposal(), changed)).manifestHash, first.manifestHash);
  }
  const changed = proposal(); changed.taskScopes[1].httpStepIds.push('a');
  assert.notEqual(inspectVerificationProposal(input(changed)).manifestHash, first.manifestHash);
  const { control, approval } = approved({ begin: false });
  assert.throws(() => compileManifest({ ...input(changed), approval }), invalid);
  control.revoke(approval);
});

test('HTTP closure keeps all transitive captures/restarts and exact original expectations, excluding unrelated tasks', () => {
  const f = approved(), child = compile(f);
  assert.deepEqual(child.steps.map(step => step.id), ['a', 'restart', 'b']);
  assert.deepEqual(child.steps, f.manifest.steps.filter(step => step.id !== 'c'));
  assert.deepEqual(child.checks, f.manifest.checks.filter(check => check.stepId !== 'c'));
  assert.deepEqual(child.requirements, ['R1', 'R2']);
  assert.equal(child.steps[2].request.path, '/items/${itemId}');
  assert.deepEqual(child.steps[2].request.assertions[1].value, { $var: 'itemId' });
  assert.deepEqual(child.executionScope, { kind: 'task', parentHash: f.manifest.manifestHash, taskId: 'B', taskDefinitionHash: digest(f.tasks[1]) });
  assert.equal(child.taskSetHash, f.manifest.taskSetHash); assert.equal(Object.hasOwn(child, 'taskScopes'), false);
  assert.equal(isTaskCompiledManifest(child), true); assert.equal(assertTaskCompiledManifest(child, binding, 'B'), child);
  assert.equal(assertCompiledManifest(child, binding), child); assert.equal(compiledManifestDefinition(child), child);
  assert.notEqual(child.manifestHash, f.manifest.manifestHash); assert.equal(Object.isFrozen(child.steps[0].request.assertions), true);
});

test('browser closure is only the selected sessions original prefixes, preserving interaction and assertion values', () => {
  const f = approved(), b = compile(f), c = compile(f, 'C');
  assert.deepEqual(b.browser.sessions, ['u']); assert.deepEqual(b.browser.steps.map(step => step.id), ['u_goto', 'u_fill', 'u_a', 'u_click', 'u_b']);
  assert.deepEqual(c.browser.sessions, ['v']); assert.deepEqual(c.browser.steps.map(step => step.id), ['v_goto', 'v_c']);
  assert.deepEqual(c.requirements, ['R3']); assert.deepEqual(c.steps.map(step => step.id), ['c']);
  assert.equal(b.browser.steps[1].value, 'original input'); assert.equal(b.browser.steps.at(-1).value, 'B exact');
  const checks = browserScenarioChecks(b.browser);
  assert.ok(checks.some(check => check.id === 'BROWSER-MOBILE-u_b' && check.expected === 'B exact'));
  assert.equal(checks.some(check => check.id.includes('v_c')), false);
});
test('self-contained delayed-load assertions count direct REQ coverage without inheriting session setup or contaminating ordinary prefixes', () => {
  const raw = proposal(); raw.browser.steps.splice(5, 0, { id: 'u_race', session: 'u', requirementIds: ['R2'], op: 'createWithDelayedLoad', path: '/items.html', loadPath: '/api/items', inputTestId: 'name', submitTestId: 'create', listTestId: 'items', countTestId: 'total', value: 'item', expectedCount: 1 });
  raw.taskScopes[1].browserStepIds = ['u_race']; const f = approved({ raw }), child = compile(f, 'B');
  assert.deepEqual(child.browser.steps.map(step => step.id), ['u_race']); assert.deepEqual(child.browser.sessions, ['u']); assert.equal(child.browser.steps[0].expectedCount, 1);
  const other = proposal(); other.browser.steps.splice(5, 0, raw.browser.steps.find(step => step.id === 'u_race'));
  const normal = compile(approved({ raw: other }), 'B'); assert.deepEqual(normal.browser.steps.map(step => step.id), ['u_goto', 'u_fill', 'u_a', 'u_click', 'u_b']);
  const changed = structuredClone(raw); changed.browser.steps.find(step => step.id === 'u_race').expectedCount = 2;
  assert.notEqual(inspectVerificationProposal(input(changed)).manifestHash, f.manifest.manifestHash);
  assert.throws(() => compileManifest({ ...input(changed), approval: f.approval }));
});

test('early task does not require future task steps or whole-project structural coverage', () => {
  const f = approved(), a = compile(f, 'A');
  assert.deepEqual(a.requirements, ['R1']); assert.deepEqual(a.steps.map(step => step.id), ['a']);
  assert.deepEqual(a.browser.steps.map(step => step.id), ['u_goto', 'u_fill', 'u_a']);
  assert.equal(a.checks.some(check => check.id === 'b_id'), false);
});

test('approval must have begun before any task capability is minted', () => {
  const f = approved({ begin: false }); assert.throws(() => compile(f), invalid);
  f.control.beginCoding(f.approval); assert.equal(isTaskCompiledManifest(compile(f)), true);
});

test('fake inspection, cloned manifests, nested scopes and wrong-task bindings cannot authorize execution', () => {
  const f = approved(), child = compile(f);
  for (const fake of [inspectVerificationProposal(input()), structuredClone(f.manifest), JSON.parse(JSON.stringify(child)), { ...child }, null, true]) {
    assert.equal(isTaskCompiledManifest(fake), false);
    assert.throws(() => assertTaskCompiledManifest(fake, binding, 'B'), invalid);
    assert.throws(() => compileTaskManifest({ manifest: fake, taskId: 'B', tasks: f.tasks }), invalid);
  }
  assert.throws(() => compileTaskManifest({ manifest: child, taskId: 'B', tasks: f.tasks }), invalid);
  assert.throws(() => assertTaskCompiledManifest(child, binding, 'A'), invalid);
  assert.throws(() => assertTaskCompiledManifest(child, { ...binding, runId: 'foreign' }, 'B'), invalid);
  assert.throws(() => { child.executionScope.taskId = 'A'; }, TypeError);
});

test('revoking or superseding the parent withdraws every already derived capability', () => {
  const f = approved(), children = ['A', 'B', 'C'].map(id => compile(f, id)); f.control.revoke(f.approval);
  for (const child of children) { assert.equal(isTaskCompiledManifest(child), false); assert.throws(() => assertCompiledManifest(child, binding), invalid); }
  assert.throws(() => compile(f), invalid);
  const other = approved({ begin: false }), raw = proposal(); raw.name += ' revised'; other.control.approve(input(raw));
  assert.throws(() => other.control.beginCoding(other.approval), invalid);
});

test('all tasks, not just the chosen task, must match the approved pure-data plan', () => {
  const f = approved();
  for (const mutate of [value => value[2].acceptance.push('changed'), value => value[0].writePaths.push('src/new.mjs'), value => value.pop(), value => value.reverse()]) {
    const changed = tasks(); mutate(changed); assert.throws(() => compile(f, 'B', changed), invalid);
  }
  assert.throws(() => compile(f, 'missing'), invalid);
  assert.equal(compile(f, 'B', structuredClone(tasks())).executionScope.taskId, 'B');
});

test('accessors and toJSON are never executed while checking task compilation or task definitions', () => {
  const f = approved(); let invoked = 0;
  const getter = {}; Object.defineProperty(getter, 'manifest', { enumerable: true, get() { invoked++; return f.manifest; } }); getter.taskId = 'B'; getter.tasks = f.tasks;
  assert.throws(() => compileTaskManifest(getter), invalid);
  const fake = {}; Object.defineProperty(fake, 'binding', { get() { invoked++; return binding; } }); assert.equal(isTaskCompiledManifest(fake), false);
  const accessorTasks = tasks(); Object.defineProperty(accessorTasks[2], 'title', { enumerable: true, get() { invoked++; return 'modified'; } });
  assert.throws(() => compile(f, 'B', accessorTasks), invalid);
  const jsonTasks = tasks(); jsonTasks[2].toJSON = () => { invoked++; return {}; }; assert.throws(() => inspectVerificationProposal(input(proposal(), jsonTasks)), invalid);
  assert.equal(invoked, 0);
});

const invalidScopes = [
  ['missing task', p => p.taskScopes.pop()],
  ['unknown task', p => { p.taskScopes[2].taskId = 'other'; }],
  ['duplicate task', p => { p.taskScopes[2].taskId = 'A'; }],
  ['unknown HTTP step', p => { p.taskScopes[0].httpStepIds = ['missing']; }],
  ['unknown browser step', p => { p.taskScopes[0].browserStepIds = ['missing']; }],
  ['duplicate step', p => { p.taskScopes[0].httpStepIds = ['a', 'a']; }],
  ['HTTP-only group', p => { p.taskScopes[0].browserStepIds = []; }],
  ['browser-only group', p => { p.taskScopes[0].httpStepIds = []; }],
  ['restart-only HTTP coverage', p => { p.taskScopes[0].httpStepIds = ['restart']; }],
  ['setup-only browser coverage', p => { p.taskScopes[0].browserStepIds = ['u_goto', 'u_fill']; }],
  ['HTTP closure cannot substitute direct task REQ coverage', p => { p.taskScopes[0].httpStepIds = ['b']; }],
  ['browser prefix cannot substitute direct task REQ coverage', p => { p.taskScopes[0].browserStepIds = ['u_b']; }],
  ['unknown fields', p => { p.taskScopes[0].approved = true; }],
  ['no joint definition', p => { delete p.browser; }],
];
for (const [name, mutate] of invalidScopes) test(`reject invalid task grouping: ${name}`, () => { const raw = proposal(); mutate(raw); assert.throws(() => inspectVerificationProposal(input(raw)), invalid); });

const invalidTasks = [
  ['no complete plan', value => value.splice(0)],
  ['duplicate task IDs', value => { value[2].id = 'A'; }],
  ['missing exact writePaths', value => { delete value[0].writePaths; }],
  ['empty writePaths', value => { value[0].writePaths = []; }],
  ['unsafe path', value => { value[0].writePaths = ['../outside.mjs']; }],
  ['unordered shared writers', value => { value[2].writePaths = ['src/a.mjs']; }],
  ['case-colliding paths', value => { value[1].writePaths = ['src/A.mjs']; }],
  ['missing dependency', value => { value[1].dependsOn = ['missing']; }],
  ['dependency cycle', value => { value[0].dependsOn = ['B']; }],
  ['unknown requirement', value => { value[0].requirementIds = ['other']; }],
  ['omitted requirement', value => { value[2].requirementIds = ['R1']; }],
];
for (const [name, mutate] of invalidTasks) test(`reject invalid current task plan: ${name}`, () => { const current = tasks(); mutate(current); assert.throws(() => inspectVerificationProposal(input(proposal(), current)), invalid); });

test('ordered shared writers and a later integration task can use already approved full joint checks', () => {
  const current = tasks(), raw = proposal(); current[1].writePaths.push('src/a.mjs'); current[2].dependsOn = ['B']; current[2].writePaths.push('src/a.mjs');
  current[2].requirementIds = ['R1', 'R2', 'R3']; raw.taskScopes[2] = { taskId: 'C', httpStepIds: ['a', 'b', 'c'], browserStepIds: ['u_a', 'u_b', 'v_c'] };
  const control = createVerificationControl(), value = input(raw, current), approval = control.approve(value), manifest = compileManifest({ ...value, approval }); control.beginCoding(approval);
  const child = compileTaskManifest({ manifest, taskId: 'C', tasks: current }); assert.deepEqual(child.requirements, ['R1', 'R2', 'R3']);
  assert.equal(isTaskCompiledManifest(child), true); assert.notEqual(child.manifestHash, manifest.manifestHash);
});

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'task-scope-fixture', apiKey: 'not-a-real-credential' };
const modelInput = currentTasks => ({ task: { title: 'Approved fixture', tasks: currentTasks }, requirements: ['R1', 'R2', 'R3'].map(id => ({ id, text: `Approved ${id}` })), engineeringContract: { routes: ['confirmed fixture paths'] }, binding });
test('native verification model validates taskScopes against the complete approved task projection', async () => {
  let calls = 0;
  const model = createVerificationModel({ config, fetchImpl: async (_url, request) => {
    calls++; const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    assert.deepEqual(data.task.tasks, tasks()); assert.match(body.messages[0].content, /taskScopes/); assert.match(body.messages[0].content, /省略taskScopes/);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }], usage: { prompt_tokens: 3, completion_tokens: 5 } }));
  } });
  const result = await model(modelInput(tasks())); assert.deepEqual(result.proposal.taskScopes, proposal().taskScopes); assert.equal(calls, 1); assert.equal(result.coverage, 'structural_only');
});
test('native model rejects invented scopes when current task writePaths or task mapping is missing', async () => {
  for (const current of [undefined, [], tasks().map(({ writePaths: _paths, ...task }) => task)]) {
    const model = createVerificationModel({ config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }] })) });
    const value = modelInput(current); if (current === undefined) delete value.task.tasks;
    await assert.rejects(model(value), error => error.code === 'invalid_model_response');
  }
});

function planning() {
  const source = { filename: 'fixture.md', content: '读取资源' };
  const spec = { title: '资源', summary: '读取资源', goals: ['读取资源'], roles: [], constraints: [], acceptanceScenarios: ['资源可读'], assumptions: [], questions: [], stack: { frontend: '原生HTML', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '资源', description: '读取资源', acceptance: ['返回资源集合'], sourceQuote: '读取资源' }] };
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { projectId: binding.projectId, runId: binding.runId, specRevision }, proposal: { version: 1, title: '资源工程', summary: '资源读取', entities: [], routes: [{ id: 'READ', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '200资源集合', errors: [], requirementIds: ['R1'] }], views: [{ id: 'HOME', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks: [{ id: 'DEV', title: '读取资源', description: '实现接口与页面', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['确认规格'], outputs: ['可读资源'], acceptance: ['返回资源集合'] }] } });
  const run = { id: binding.runId, projectId: binding.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, sourceSuperseded: false, spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '资源架构' }], review: { passed: true, issues: [] }, status: 'succeeded', stages: [], approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: binding.projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}
function serviceProposal() {
  return { version: 1, id: 'resource', name: '资源联合观察', sessions: [], steps: [http('read', 'R1', [], { path: '/resources' }), http('again', 'R1', ['read'], { path: '/resources' })], browser: { version: 1, sessions: ['user'], steps: [{ id: 'home', session: 'user', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'items', session: 'user', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] }, taskScopes: [{ taskId: 'DEV', httpStepIds: ['read'], browserStepIds: ['items'] }] };
}
async function serviceFixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'verification-task-scopes-')), data = planning(), opened = [];
  const options = { rootDir, config, timeoutMs: 2000, cleanupMs: 30, getPlanning: () => data, getPlanningSync: () => data, dependencies: { createModel: () => async value => {
    const body = serviceProposal(), usage = { inputTokens: 2, outputTokens: 3 }; await value.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(body) });
    return { proposal: body, model: config.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' };
  } } };
  const open = async () => { const service = await createVerificationPlanningService(options); opened.push(service); return service; }, service = await open();
  t.after(async () => { for (const item of opened.reverse()) await item.shutdown(); assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir())); assert.ok(path.basename(rootDir).startsWith('verification-task-scopes-')); await rm(rootDir, { recursive: true, force: true }); });
  const ids = { projectId: binding.projectId, runId: binding.runId }, reserved = (await service.propose({ ...ids, contractRevision: (await service.list(ids)).capabilities.contractRevision })).proposal;
  const deadline = Date.now() + 4000; let row;
  for (;;) { row = (await service.list(ids)).proposals.find(item => item.id === reserved.id); if (row.status === 'draft') break; assert.ok(Date.now() < deadline, JSON.stringify(row)); await new Promise(resolve => setTimeout(resolve, 5)); }
  const edit = (r = row, extra = {}) => ({ ...ids, proposalId: r.id, revision: r.revision, feedback: '核对当前分组', ...extra });
  return { service, data, ids, row, edit, open };
}

test('service persists task mappings through generation, revision, approval and restart; handoff derives from exact grant tasks', async t => {
  const f = await serviceFixture(t); assert.deepEqual(f.row.proposal.taskScopes, serviceProposal().taskScopes); assert.equal(Object.hasOwn(f.row.proposal, 'taskSetHash'), false);
  const changed = serviceProposal(); changed.taskScopes[0].httpStepIds = ['again'];
  const revised = (await f.service.revise(f.edit(f.row, { proposal: changed }))).proposal; assert.notEqual(revised.manifestHash, f.row.manifestHash); assert.notEqual(revised.revision, f.row.revision);
  const approvedRow = (await f.service.approve(f.edit(revised))).proposal; assert.equal(approvedRow.approved, true);
  await f.service.shutdown(); const next = await f.open(), stored = (await next.list(f.ids)).proposals.find(row => row.id === revised.id); assert.deepEqual(stored.proposal.taskScopes, changed.taskScopes); assert.equal(stored.approved, true);
  let calls = 0, child, assertCurrent;
  await next.withApprovedExecution({ ...f.ids, proposalId: stored.id, revision: stored.revision }, async grant => {
    calls++; assertCurrent = grant.assertCurrent; assert.equal(isTaskCompiledManifest(grant.manifest), false); assert.equal(grant.manifest.taskSetHash, digest(grant.task.tasks));
    child = compileTaskManifest({ manifest: grant.manifest, taskId: 'DEV', tasks: grant.task.tasks });
    assert.equal(isTaskCompiledManifest(child), true); assert.deepEqual(child.steps.map(step => step.id), ['read', 'again']);
    assert.equal(grant.assertCurrent(), true); return { status: 'failed', terminationConfirmed: true };
  });
  assert.equal(calls, 1); assert.equal(isTaskCompiledManifest(child), true); assert.throws(() => assertCurrent());
  const state = await next.list(f.ids); assert.equal(state.proposals[0].frozenForCoding, true);
});

test('service refuses incomplete grouping revision and changed current task plan before invoking any execution callback', async t => {
  const f = await serviceFixture(t), bad = serviceProposal(); bad.taskScopes = [];
  await assert.rejects(f.service.revise(f.edit(f.row, { proposal: bad })), error => error.code === 'invalid_proposal');
  const row = (await f.service.approve(f.edit())).proposal;
  f.data.run.tasks[0].acceptance.push('unapproved extra behavior'); let calls = 0;
  await assert.rejects(f.service.withApprovedExecution({ ...f.ids, proposalId: row.id, revision: row.revision }, () => { calls++; assert.fail('stale current tasks must not execute'); }));
  assert.equal(calls, 0);
});
