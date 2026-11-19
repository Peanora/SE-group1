import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { ProjectStore } from '../lib/store.mjs';
import { createPlannedExecutionService } from '../lib/planned-execution-service.mjs';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { verificationModelPolicy } from '../lib/verification-model.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';

const config = { baseUrl: 'https://planned-http.synthetic.invalid/v1', model: 'synthetic-planned-http', apiKey: 'synthetic-http-private-credential' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read) { const end = Date.now() + 5000; for (;;) { const value = await read(); if (value) return value; assert.ok(Date.now() < end, 'HTTP状态超时'); await new Promise(done => setTimeout(done, 5)); } }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function stub() {
  const calls = [], row = { id: 'inert-execution', status: 'failed', actions: { canDownload: false } };
  return { calls, service: { list: async input => { calls.push(['list', input]); return { capabilities: { canStart: false }, executions: [row] }; }, start: async input => { calls.push(['start', input]); return { execution: row }; }, cancel: async input => { calls.push(['cancel', input]); return { execution: row }; }, download: async input => { calls.push(['download', input]); throw Object.assign(new Error('尚无真实验收源码。'), { status: 409 }); }, withProjectCheckpoint: async (_id, work) => work(), shutdown: async () => {} } };
}
async function routeFixture(t, service) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planned-http-route-'));
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, plannedExecutionService: service });
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('planned-http-route-')); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '研发HTTP路由', source: { filename: 'r.md', content: '测试资源读取' } }), run = { id: randomUUID(), status: 'succeeded', stages: [], artifacts: [], tasks: [] };
  project.runs.push(run); await app.store.save(project);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`, identity = { projectId: project.id, runId: run.id };
  return { app, project, run, identity, url, route: `${url}/api/projects/${project.id}/runs/${run.id}/development-executions` };
}

test('development routes derive identity, accept precise data and never turn a stub into a source delivery', async t => {
  const f = stub(), r = await routeFixture(t, f.service), body = { proposalId: 'proposal', revision: 'a'.repeat(64), contractRevision: 'b'.repeat(64) };
  assert.equal((await fetch(r.route)).status, 200);
  assert.equal((await fetch(`${r.route}/start`, post(body))).status, 202);
  assert.equal((await fetch(`${r.route}/inert-execution/cancel`, post({}))).status, 200);
  assert.equal((await fetch(`${r.route}/inert-execution/download`)).status, 409);
  assert.deepEqual(f.calls, [['list', r.identity], ['start', { ...r.identity, ...body }], ['cancel', { ...r.identity, executionId: 'inert-execution' }], ['download', { ...r.identity, executionId: 'inert-execution' }]]);
});

test('extra capabilities, missing fields and wrong route methods never reach the planned controller', async t => {
  const f = stub(), r = await routeFixture(t, f.service), body = { proposalId: 'proposal', revision: 'a'.repeat(64), contractRevision: 'b'.repeat(64) };
  for (const extra of ['projectId', 'runId', 'executionId', 'workspace', 'budget', 'provider', 'passed', 'approval']) assert.equal((await fetch(`${r.route}/start`, post({ ...body, [extra]: 'forbidden' }))).status, 400);
  for (const field of Object.keys(body)) { const missing = { ...body }; delete missing[field]; assert.equal((await fetch(`${r.route}/start`, post(missing))).status, 400); }
  assert.equal((await fetch(`${r.route}/inert/cancel`, post({ revision: body.revision }))).status, 400);
  for (const [suffix, options] of [['', post({})], ['/start', {}], ['/inert/cancel', {}], ['/inert/download', post({})]]) assert.ok([404, 405].includes((await fetch(r.route + suffix, options)).status));
  assert.deepEqual(f.calls, []);
});

test('development routes enforce loopback host, same Origin, cross-project runs and disabled service', async t => {
  const f = stub(), r = await routeFixture(t, f.service), body = { proposalId: 'proposal', revision: 'a'.repeat(64), contractRevision: 'b'.repeat(64) };
  const rebinding = await new Promise((resolve, reject) => { const request = http.get(r.route, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.once('error', reject); });
  assert.equal(rebinding, 403);
  const options = post(body); options.headers.origin = 'https://attacker.example'; assert.equal((await fetch(`${r.route}/start`, options)).status, 403);
  assert.equal((await fetch(r.route, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const other = await r.app.store.create({ name: '其他项目', source: { filename: 'other.md', content: '其他需求' } });
  assert.equal((await fetch(`${r.url}/api/projects/${other.id}/runs/${r.run.id}/development-executions`)).status, 404);
  assert.deepEqual(f.calls, []);
  const disabled = await routeFixture(t, null); assert.equal((await fetch(disabled.route)).status, 404);
});

function confirmedRun(project) {
  const id = randomUUID(), source = project.source, spec = { title: '资源系统', summary: source.content, goals: ['读取资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取', description: source.content, sourceQuote: source.content, acceptance: ['返回列表'] }] };
  const specRevision = contentRevision(spec), engineeringPlan = validateEngineeringPlan({ spec, binding: { projectId: project.id, runId: id, specRevision }, proposal: { version: 1, title: '资源工程', summary: '读取接口', entities: [], routes: [{ id: 'read', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '资源列表', errors: [], requirementIds: ['R1'] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks: [{ id: 'implement', title: '实现资源', description: '实现资源列表', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['列表'], acceptance: ['可读'] }] } });
  const run = { id, projectId: project.id, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0, status: 'succeeded', stages: [], spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '读取资源' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision }; return run;
}
function jointDefinition() { return { version: 1, id: 'resources', name: '资源联合定义', sessions: [], steps: [{ id: 'read', type: 'request', requirementIds: ['R1'], dependsOn: [], request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'ok', op: 'status', value: 200 }] } }], browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } }; }
function missingLoginDefinition() {
  const proposal = jointDefinition();
  proposal.sessions.push('alice');
  proposal.steps.push({ id: 'login-alice', type: 'request', requirementIds: ['R1'], dependsOn: [],
    request: { id: 'login', method: 'POST', path: '/api/auth/login', session: 'alice', body: { username: 'sample', password: 'sample-test-value' }, assertions: [{ id: 'login-status', op: 'status', value: 200 }] } },
  { id: 'anonymous-profile', type: 'request', requirementIds: ['R1'], dependsOn: [],
    request: { id: 'profile', method: 'GET', path: '/api/auth/me', assertions: [{ id: 'profile-status', op: 'status', value: 401 }] } });
  proposal.browser.sessions = ['bob', 'alice'];
  proposal.browser.steps = [
    { id: 'login-page', session: 'bob', op: 'goto', path: '/login.html' },
    { id: 'fill-password', session: 'bob', op: 'fill', testId: 'login-password', value: 'sample-test-value' },
    { id: 'submit', session: 'bob', op: 'click', testId: 'login-submit' },
    { id: 'list-page', session: 'alice', op: 'goto', path: '/' },
    { id: 'result', session: 'alice', op: 'visible', testId: 'resources', value: true },
  ].map(step => ({ ...step, requirementIds: ['R1'] }));
  return proposal;
}
async function connectedFixture(t, mode = 'held') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planned-http-connected-')), store = await new ProjectStore(directory).init();
  const project = await store.create({ name: '真实检查点连接', source: { filename: 'r.md', content: '用户读取资源列表。' } }), run = confirmedRun(project);
  if (mode === 'login-failed') Object.assign(run, { planVersion: 1, decisions: [], revisionHistory: { spec: [], plan: [] }, events: [] });
  project.runs.push(run); await store.save(project); await store.flush();
  const identity = { projectId: project.id, runId: run.id }, entered = deferred(), release = deferred(); let planned, coreCalls = 0;
  const verification = await createVerificationPlanningService({ rootDir: path.join(directory, 'verification-planning'), getPlanning: (...args) => store.getPersistedRun(...args), getPlanningSync: (...args) => store.getPersistedRun(...args), config, timeoutMs: 2000, cleanupMs: 30,
    dependencies: { createModel: () => async input => { const proposal = mode === 'login-failed' ? missingLoginDefinition() : jointDefinition(), usage = { inputTokens: 1, outputTokens: 1 }; await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(proposal) }); return { proposal, usage, model: config.model, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } });
  const forwarding = Object.fromEntries(['list', 'start', 'cancel', 'download', 'withProjectCheckpoint', 'shutdown'].map(name => [name, (...args) => planned?.[name](...args)]));
  const app = await createApp({ store, stepDelayMs: 0, verificationPlanningService: verification, plannedExecutionService: forwarding });
  // Only the core is inert: real JSON, four services/SQLite controllers, compiler
  // branding and local HTTP enforce lifecycle. This is no software acceptance.
  planned = await createPlannedExecutionService({ rootDir: path.join(directory, 'planned-executions'), verificationService: verification, getPlanningSync: (...args) => store.getPersistedRun(...args), withCheckpoint: (id, work) => app.orchestrator.withProjectCheckpoint(id, () => app.executionService.withProjectCheckpoint(id, work)), config, executable: process.execPath,
    dependencies: { createProvider: () => async () => assert.fail('no real coding request'), createReviewer: () => async () => assert.fail('no real Review request'), startExecution: input => {
      coreCalls++; const record = { id: randomUUID(), ...input.binding, status: mode === 'fake-accepted' ? 'accepted' : 'stopped', terminationConfirmed: true, totalModelCalls: 0, modelCalls: [], versions: [], usage: { inputTokens: null, outputTokens: null }, workspace: path.join(directory, 'private-workspace') };
      if (mode === 'login-failed') {
        record.status = 'failed';
        const actual = JSON.stringify({ operation: 'goto', observed: { status: 200 }, guardFailures: { console_error: 1 } });
        record.versions = [{ acceptance: { browser: { checks: ['DESKTOP', 'MOBILE'].map(view => ({ id: `BROWSER-${view}-list-page`, passed: false, actual })) } } }];
      }
      entered.resolve(); return { id: record.id, snapshot: () => structuredClone(record), cancel: () => release.resolve(record), done: ['fake-accepted', 'login-failed'].includes(mode) ? Promise.resolve(record) : release.promise };
    } } });
  t.after(async () => { release.resolve({ status: 'reconciliation_required', terminationConfirmed: false }); await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('planned-http-connected-')); await rm(directory, { recursive: true, force: true }); });
  const reserved = (await verification.propose({ ...identity, contractRevision: (await verification.list(identity)).capabilities.contractRevision })).proposal;
  const draft = await until(async () => (await verification.list(identity)).proposals.find(row => row.id === reserved.id && row.status === 'draft'));
  const proposal = (await verification.approve({ ...identity, proposalId: draft.id, revision: draft.revision, feedback: '确认联合定义，仅做生命周期夹具' })).proposal;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${app.server.address().port}`, route = `${url}/api/projects/${project.id}/runs/${run.id}/development-executions`;
  const request = async (suffix = '', body) => { const response = await fetch(route + suffix, body === undefined ? {} : post(body)); return { status: response.status, body: await response.json() }; };
  return { app, planned, verification, project, run, identity, directory, url, route, request, entered, coreCalls: () => coreCalls,
    async start() { const state = await request(); return request('/start', { proposalId: proposal.id, revision: proposal.revision, contractRevision: state.body.capabilities.contractRevision }); },
    async saveChange() { const target = `${url}/api/projects/${project.id}/changes`, current = (await (await fetch(target)).json()).current; const saved = await fetch(target, post({ baseRevision: current.revision, source: { filename: 'r.md', content: project.source.content + '\n增加资源说明字段。' }, reason: '新增字段', kind: 'field', requestKey: 'source-field-change' })); assert.equal(saved.status, 201); const { change } = await saved.json(); return () => fetch(`${target}/${change.id}/apply`, post({ baseRevision: change.baseRevision, generation: change.generation })); },
    remove: () => fetch(`${url}/api/projects/${project.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmationName: project.name }) }),
  };
}

test('a missing-login result offers a versioned checklist repair without spending another execution', async t => {
  const f = await connectedFixture(t, 'login-failed');
  assert.equal((await f.start()).status, 202);
  const failed = await until(async () => (await f.request()).body.executions.find(execution => execution.status === 'failed'));
  assert.equal(failed.failureHelp.action, 'review_checklist');
  assert.match(failed.failureHelp.detail, /alice/u);
  assert.doesNotMatch(JSON.stringify(failed.failureHelp), /sample-test-value/u);
  assert.equal((await f.request()).body.capabilities.canStart, false);
  assert.equal((await f.start()).status, 409);
  assert.equal(f.coreCalls(), 1);
  const original = f.run.planRevision;
  const revision = await f.request(`/${failed.id}/revise-checklist`, {});
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  assert.notEqual(revision.body.run.planRevision, original);
  assert.equal(revision.body.run.approvals.plan, null);
  assert.match(revision.body.run.tasks[0].description, /独立的测试账号/u);
  assert.deepEqual(revision.body.run.tasks[0].writePaths, ['src/app.mjs']);
  assert.equal(f.coreCalls(), 1);
  assert.equal((await f.request(`/${failed.id}/revise-checklist`, {})).status, 409);
});

test('saving a confirmed plan revision is blocked while its code execution is active', async t => {
  const f = await connectedFixture(t);
  assert.equal((await f.start()).status, 202);
  await f.entered.promise;
  const revision = f.run.planRevision;
  const tasks = structuredClone(f.run.tasks);
  tasks[0].title = '新任务标题';
  const response = await fetch(f.route.replace(/development-executions$/u, 'action'), post({ action: 'revise_plan', revision, tasks }));
  assert.equal(response.status, 409);
  assert.equal(f.run.planRevision, revision);
  assert.equal(f.run.approvals.plan.revision, revision);
  assert.equal(f.coreCalls(), 1);
});

test('actual four-service checkpoints each block source publication and deletion while preserving the pending draft', async t => {
  const f = await connectedFixture(t), apply = await f.saveChange();
  for (const service of [f.app.orchestrator, f.app.executionService, f.verification, f.planned]) {
    const entered = deferred(), release = deferred(), held = service.withProjectCheckpoint(f.project.id, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    try { assert.equal((await apply()).status, 409); assert.equal((await f.remove()).status, 409); assert.equal(f.app.store.get(f.project.id).sourceGeneration ?? 0, 0); }
    finally { release.resolve(); await held; }
  }
  assert.equal((await apply()).status, 200); assert.equal(f.coreCalls(), 0);
});

test('planned execution blocks fixed start, source apply and deletion; known cancellation releases the actual common checkpoint', async t => {
  const f = await connectedFixture(t), apply = await f.saveChange(), started = await f.start(); assert.equal(started.status, 202); await f.entered.promise;
  assert.equal((await f.start()).status, 409); assert.equal((await apply()).status, 409); assert.equal((await f.remove()).status, 409);
  const fixed = await fetch(`${f.url}/api/projects/${f.project.id}/runs/${f.run.id}/executions/start`, post({ profileId: 'library-web-v1', contractRevision: 'test-only-not-a-live-authorization' })); assert.equal(fixed.status, 409);
  assert.equal((await f.request(`/${started.body.execution.id}/cancel`, {})).status, 200);
  await until(async () => (await f.request()).body.executions.some(row => row.status === 'stopped' && !row.active));
  assert.equal((await apply()).status, 200);
  const old = (await f.request()).body.executions[0]; assert.equal(old.current, false); assert.equal(old.actions.canDownload, false);
});

test('fixed execution checkpoint refuses planned admission before any coding; fake accepted result cannot download', async t => {
  const f = await connectedFixture(t, 'fake-accepted'), entered = deferred(), release = deferred();
  const held = f.app.executionService.withProjectCheckpoint(f.project.id, async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const blocked = await f.start(); assert.equal(blocked.status, 202);
  await until(async () => (await f.request()).body.executions.some(row => row.status === 'failed' && !row.active)); assert.equal(f.coreCalls(), 0);
  release.resolve(); await held;
  const started = await f.start(); assert.equal(started.status, 202); await f.entered.promise;
  await until(async () => (await f.request()).body.executions.filter(row => row.status === 'failed' && !row.active).length === 2);
  assert.equal((await fetch(`${f.route}/${started.body.execution.id}/download`)).status, 409);
  const json = JSON.stringify((await f.request()).body); assert.equal(json.includes(f.directory), false); assert.equal(json.includes(config.apiKey), false);
});
