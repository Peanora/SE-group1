import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { analyzeWithModel } from '../lib/planner.mjs';
import { createEngineeringModel } from '../lib/engineering-model.mjs';
import { createVerificationModel } from '../lib/verification-model.mjs';
import { createProjectCodeModel } from '../lib/project-code-model.mjs';
import { createProjectReviewModel } from '../lib/project-review-model.mjs';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { createPlannedExecutionService } from '../lib/planned-execution-service.mjs';
import { createWebExecutionService } from '../lib/web-execution-service.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { normalizeWorkerModelConfig, workerModelConfigRevision } from '../lib/planned-worker-contract.mjs';
import { getModelRequestEvidence } from '../lib/model-request-evidence.mjs';

const ids = { projectId: 'routing-project', runId: 'routing-run' };
const text = '用户读取资源列表。';
const spec = { title: '资源系统', summary: text, goals: ['读取资源'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: ['返回资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取', description: text, sourceQuote: text, acceptance: ['返回列表'] }] };
const design = { version: 1, title: '资源工程', summary: '读取接口', entities: [], routes: [{ id: 'resources', method: 'GET', path: '/resources', roles: [], request: '无正文', response: '资源列表', errors: [], requirementIds: ['R1'] }], views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }], tasks: [{ id: 'implement', title: '实现资源', description: '实现读取', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['读取接口'], acceptance: ['可读'] }] };
const proposal = { version: 1, id: 'resources', name: '资源定义', sessions: [], steps: [{ id: 'read', type: 'request', requirementIds: ['R1'], dependsOn: [], request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'ok', op: 'status', value: 200 }] } }], browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } };
const source = [{ path: 'src/app.mjs', content: 'export const application = true;\n' }];
function planning() {
  const original = { filename: 'requirements.md', content: text }, specRevision = contentRevision(spec);
  const engineeringPlan = validateEngineeringPlan({ spec, binding: { ...ids, specRevision }, proposal: design });
  const run = { id: ids.runId, projectId: ids.projectId, workflowVersion: 2, sourceSnapshot: original, sourceRevision: contentRevision(original), sourceGeneration: 0, status: 'succeeded', stages: [], spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan), artifacts: [{ name: 'architecture.md', content: '读取资源' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: ids.projectId, source: original, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(work, timeoutMs = 5000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await work(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Local routing result did not settle'); }
async function endpoint(t, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, auth: req.headers.authorization, body });
    const value = await respond(req.url, body);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const config = role => ({ baseUrl: `http://127.0.0.1:${server.address().port}/${role}`, model: `${role}-model`, apiKey: `synthetic-${role}-private-key`, jsonMode: false, thinking: undefined });
  return { requests, config };
}

test('all five real native adapters route to separate local API endpoints and honor explicit controls', async t => {
  const api = await endpoint(t, route => route.startsWith('/spec/') ? spec : route.startsWith('/engineering/') ? design : route.startsWith('/verification/') ? proposal : route.startsWith('/coding/') ? { files: source } : { summary: '本地传输检查', issues: [], resolutions: [] });
  const specConfig = api.config('spec');
  const request = analyzeWithModel(text, '资源', { config: specConfig });
  assert.equal((await request).sourceMode, 'model'); assert.deepEqual(getModelRequestEvidence(request), { dispatched: true, responseComplete: true });
  const engineeringConfig = api.config('engineering'), engineering = createEngineeringModel({ config: engineeringConfig });
  engineeringConfig.baseUrl = 'https://must-not-dispatch.invalid'; engineeringConfig.thinking = 'enabled';
  await engineering({ spec, binding: { ...ids, specRevision: contentRevision(spec) } });
  const data = planning();
  await createVerificationModel({ config: api.config('verification') })({ task: { title: '资源系统' }, requirements: [{ id: 'R1', text }], engineeringContract: { routes: design.routes, views: design.views }, binding: { ...ids, specRevision: data.run.specRevision, planRevision: data.run.planRevision } });
  await createProjectCodeModel({ config: api.config('coding') })({ task: '读取资源', files: [] });
  await createProjectReviewModel({ config: api.config('review') })({ task: '读取资源', files: source });
  assert.deepEqual(api.requests.map(value => value.path), ['spec', 'engineering', 'verification', 'coding', 'review'].map(role => `/${role}/chat/completions`));
  for (const [index, role] of ['spec', 'engineering', 'verification', 'coding', 'review'].entries()) {
    const sent = api.requests[index]; assert.equal(sent.auth, `Bearer ${api.config(role).apiKey}`); assert.equal(sent.body.model, `${role}-model`);
    assert.equal(Object.hasOwn(sent.body, 'response_format'), false); assert.equal(Object.hasOwn(sent.body, 'thinking'), false);
    assert.equal(JSON.stringify(sent.body).includes('-private-key'), false);
  }
});

test('Worker handoff binds both public role configurations while neither credential affects its public revision', () => {
  const coding = { baseUrl: 'http://localhost:1/coding', model: 'coder', apiKey: 'private-coder', thinking: undefined, jsonMode: false };
  const reviewConfig = { baseUrl: 'http://localhost:2/review', model: 'reviewer', apiKey: 'private-reviewer', thinking: 'disabled', jsonMode: true };
  const combined = { ...coding, reviewConfig }, copy = normalizeWorkerModelConfig(combined), revision = workerModelConfigRevision(copy);
  assert.equal(copy.reviewConfig.model, 'reviewer'); assert.equal(Object.isFrozen(copy.reviewConfig), true);
  assert.equal(workerModelConfigRevision({ ...combined, apiKey: 'rotated-coding', reviewConfig: { ...reviewConfig, apiKey: 'rotated-review' } }), revision);
  for (const patch of [{ model: 'another-reviewer' }, { baseUrl: 'http://localhost:3/review' }, { thinking: 'enabled' }, { jsonMode: false }]) assert.notEqual(workerModelConfigRevision({ ...combined, reviewConfig: { ...reviewConfig, ...patch } }), revision);
  assert.throws(() => normalizeWorkerModelConfig({ ...combined, reviewConfig: { ...reviewConfig, reviewConfig } }));
  assert.throws(() => normalizeWorkerModelConfig({ ...combined, unknown: true }));
});

test('fixed-reference paid admission rejects the pre-deployment API contract before creating any attempt', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fixed-role-routing-')), data = planning(); let service;
  t.after(async () => { await service?.shutdown(); await rm(root, { recursive: true, force: true }); });
  let coding = { baseUrl: 'http://localhost:1/coding', model: 'coder-one', apiKey: 'private-coder-one', jsonMode: false, thinking: undefined };
  let reviewing = { baseUrl: 'http://localhost:2/review', model: 'reviewer-one', apiKey: 'private-reviewer-one', jsonMode: true, thinking: 'disabled' };
  let dispatched = 0;
  service = await createWebExecutionService({ rootDir: root, getPlanning: () => data, getConfig: () => coding, getReviewConfig: () => reviewing, executable: process.execPath,
    dependencies: { startExecution: () => { dispatched++; assert.fail('Stale API selection must not start a model or executor'); } } });
  const first = await service.list(ids), contractRevision = first.capabilities.profiles[0].contractRevision;
  reviewing = { ...reviewing, model: 'reviewer-two' };
  const second = await service.list(ids); assert.notEqual(second.capabilities.profiles[0].contractRevision, contractRevision);
  await assert.rejects(service.start({ ...ids, profileId: 'library-web-v1', contractRevision }), error => error.code === 'contract_changed');
  assert.equal(dispatched, 0); assert.equal((await service.list(ids)).executions.length, 0);
  const reviewContract = second.capabilities.profiles[0].contractRevision; coding = { ...coding, baseUrl: 'http://localhost:3/coding' };
  assert.notEqual((await service.list(ids)).capabilities.profiles[0].contractRevision, reviewContract);
});

test('deployment affects new proposals and admission contracts while the active proposal keeps its original API', async t => {
  const held = defer(), reached = defer(); let first = true;
  const api = await endpoint(t, async () => { if (first) { first = false; reached.resolve(); await held.promise; } return proposal; });
  const root = await mkdtemp(path.join(tmpdir(), 'role-routing-')); let verification, planned;
  t.after(async () => { await planned?.shutdown(); await verification?.shutdown(); await rm(root, { recursive: true, force: true }); });
  let selected, reviewing = api.config('review-a'); const data = planning();
  const getConfig = () => { if (!selected) throw Error('not configured'); return selected; };
  verification = await createVerificationPlanningService({ rootDir: path.join(root, 'verification'), getPlanning: () => data, getPlanningSync: () => data, getConfig });
  assert.equal((await verification.list(ids)).capabilities.canPropose, false);
  selected = api.config('verification-a');
  const before = await verification.list(ids);
  const started = await verification.propose({ ...ids, contractRevision: before.capabilities.contractRevision });
  await reached.promise; selected = api.config('verification-b');
  const inFlight = await verification.list(ids); assert.notEqual(inFlight.capabilities.contractRevision, before.capabilities.contractRevision); assert.equal(inFlight.capabilities.canPropose, false);
  held.resolve();
  const firstDraft = await until(async () => (await verification.list(ids)).proposals.find(row => row.id === started.proposal.id && row.status === 'draft'));
  assert.equal(firstDraft.model, 'verification-a-model');
  const next = await verification.list(ids); await verification.propose({ ...ids, contractRevision: next.capabilities.contractRevision });
  const secondDraft = await until(async () => (await verification.list(ids)).proposals.find(row => row.model === 'verification-b-model' && row.status === 'draft'));
  await verification.approve({ ...ids, proposalId: secondDraft.id, revision: secondDraft.revision, feedback: '批准相同业务断言' });
  planned = await createPlannedExecutionService({ rootDir: path.join(root, 'planned'), verificationService: verification, getPlanningSync: () => data, withCheckpoint: (_id, work) => work(), getConfig, getReviewConfig: () => reviewing, executable: process.execPath });
  const codingBefore = await planned.list(ids); reviewing = api.config('review-b');
  const codingAfter = await planned.list(ids); assert.notEqual(codingAfter.capabilities.contractRevision, codingBefore.capabilities.contractRevision); assert.equal(codingAfter.capabilities.model.reviewName, 'review-b-model');
  await assert.rejects(planned.start({ ...ids, proposalId: secondDraft.id, revision: secondDraft.revision, contractRevision: codingBefore.capabilities.contractRevision }), error => error.code === 'contract_changed');
  assert.equal((await planned.list(ids)).executions.length, 0); assert.equal(api.requests.length, 2);
  assert.deepEqual(api.requests.map(row => row.auth), ['Bearer synthetic-verification-a-private-key', 'Bearer synthetic-verification-b-private-key']);
  assert.equal(JSON.stringify(codingAfter).includes('-private-key'), false);
});

test('real independent Worker sends coding and Review to frozen separate APIs through native HTTP and Edge acceptance', {
  timeout: 150000, skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1' || !process.env.EXECUTION_SANDBOX_EXE,
}, async t => {
  const entered = defer(), release = defer(); let held = false;
  const candidate = `export async function createApp(){return {handle(request){const p=new URL(request.path,'http://localhost').pathname;if(p==='/favicon.ico')return {status:204,headers:{},body:''};if(p==='/resources')return {status:200,headers:{'content-type':'application/json'},body:'[]'};return {status:200,headers:{'content-type':'text/html'},body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><ul data-testid="resources"><li>Resource</li></ul>'}},close(){}}}`;
  const api = await endpoint(t, async route => {
    if (route.startsWith('/verification/')) return proposal;
    if (route.startsWith('/coding/')) { if (!held) { held = true; entered.resolve(); await release.promise; } return { files: [{ path: 'src/app.mjs', content: candidate }] }; }
    if (route.startsWith('/review/')) return { summary: 'Fixed local routing diagnostic only.', issues: [], resolutions: [] };
    assert.fail(`Unexpected new-configuration dispatch: ${route}`);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'role-worker-')), data = planning(); let verification, planned, workerPid;
  t.after(async () => {
    release.resolve(); await planned?.shutdown(); await verification?.shutdown();
    if (workerPid) await until(() => { try { process.kill(workerPid, 0); return false; } catch { return true; } }, 10000);
    await rm(root, { recursive: true, force: true });
  });
  verification = await createVerificationPlanningService({ rootDir: path.join(root, 'verification'), getPlanning: () => data, getPlanningSync: () => data, getConfig: () => api.config('verification') });
  const listing = await verification.list(ids), pending = await verification.propose({ ...ids, contractRevision: listing.capabilities.contractRevision });
  const draft = await until(async () => (await verification.list(ids)).proposals.find(row => row.id === pending.proposal.id && row.status === 'draft'));
  await verification.approve({ ...ids, proposalId: draft.id, revision: draft.revision, feedback: '固定免费传输与隔离诊断' });
  let coding = api.config('coding'), reviewing = { ...api.config('review'), jsonMode: true, thinking: 'disabled' };
  planned = await createPlannedExecutionService({ rootDir: path.join(root, 'planned'), verificationService: verification, getPlanningSync: () => data, withCheckpoint: (_id, work) => work(), getConfig: () => coding, getReviewConfig: () => reviewing, executable: process.env.EXECUTION_SANDBOX_EXE });
  const before = await planned.list(ids); assert.equal(before.capabilities.canStart, true);
  const started = await planned.start({ ...ids, proposalId: draft.id, revision: draft.revision, contractRevision: before.capabilities.contractRevision });
  await until(async () => { if (held) return true; const row = (await planned.list(ids)).executions.find(row => row.id === started.execution.id); if (row?.status === 'failed' || row?.status === 'reconciliation_required') {
    const inspection = new DatabaseSync(path.join(root, 'planned', 'planned.sqlite'), { readOnly: true });
    try { const raw = JSON.parse(inspection.prepare('SELECT record FROM executions WHERE id=?').get(row.id).record); assert.fail(JSON.stringify({ error: row.error, environment: raw.environmentFailure, failure: raw.failure })); } finally { inspection.close(); }
  } return false; }, 30000);
  const db = new DatabaseSync(path.join(root, 'planned', 'workers', 'workers.sqlite'), { readOnly: true });
  try { workerPid = JSON.parse(db.prepare('SELECT registration FROM jobs').get().registration).pid; } finally { db.close(); }
  assert.notEqual(workerPid, process.pid); coding = api.config('coding-new'); reviewing = api.config('review-new'); release.resolve();
  const completed = await until(async () => {
    const row = (await planned.list(ids)).executions.find(row => row.id === started.execution.id);
    if (row?.status === 'failed' || row?.status === 'reconciliation_required') assert.fail(JSON.stringify(row));
    return row?.accepted && row;
  }, 100000);
  assert.equal(completed.totalModelCalls, 2); assert.equal(completed.executionEngine, 'persistent_worker');
  assert.deepEqual(api.requests.map(row => row.path), ['/verification/chat/completions', '/coding/chat/completions', '/review/chat/completions']);
  assert.deepEqual(api.requests.slice(1).map(row => row.auth), ['Bearer synthetic-coding-private-key', 'Bearer synthetic-review-private-key']);
  assert.equal(Object.hasOwn(api.requests[1].body, 'response_format'), false);
  assert.deepEqual(api.requests[2].body.response_format, { type: 'json_object' }); assert.deepEqual(api.requests[2].body.thinking, { type: 'disabled' });
  assert.equal(JSON.stringify(completed).includes('-private-key'), false);
});
