import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ProjectStore } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import * as planner from '../lib/planner.mjs';
import { createEngineeringModel } from '../lib/engineering-model.mjs';
import { reviseEngineeringRouteRoles, assertEngineeringAlignment } from '../lib/engineering-planner.mjs';

const source = '成员可以查看资源，审核者复核预约。';
const specification = { title: '接口权限修订', summary: source, goals: [], roles: ['成员：查看资源', '审核者：复核预约'], questions: [], constraints: [], assumptions: [], acceptanceScenarios: [],
  stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' }, sourceMode: 'model',
  requirements: [{ id: 'R-001', title: '查看资源', description: source, sourceQuote: source, acceptance: ['成员可查看资源列表'] }] };
const proposal = { version: 1, title: '资源工程', summary: '实现资源列表', entities: [{ id: 'RESOURCE', name: '资源', fields: [{ name: 'id', type: 'string', required: true, unique: true }], constraints: ['资源编号唯一'] }],
  routes: [{ id: 'route-list', method: 'GET', path: '/api/resources', roles: ['ROLE-001', 'ROLE-002'], request: '无正文', response: '资源列表', errors: [{ status: 401, reason: '尚未登录' }], requirementIds: ['R-001'] }],
  views: [{ id: 'view-list', path: '/', title: '资源列表', selectors: [{ testId: 'resource-row', role: 'list' }], requirementIds: ['R-001'] }],
  tasks: [{ id: 'task-list', title: '资源模块', description: '实现资源接口和页面', requirementIds: ['R-001'], dependsOn: [], writePaths: ['src/app.mjs', 'public/app.js'], inputs: ['确认规格'], outputs: ['资源列表'], acceptance: ['列表可读取'] }] };
const response = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 7, completion_tokens: 11 } }));
async function until(check) { const end = Date.now() + 6000; while (!check()) { assert(Date.now() < end, '规划等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'engineering-roles-')), store = await new ProjectStore(directory).init(); let models = 0;
  const config = { baseUrl: 'https://model.invalid/v1', model: 'route-role-test', apiKey: 'synthetic-route-role-key' };
  const trusted = { ...planner, getModelConfig: () => ({ configured: true }), analyzeWithModel: (text, name, options) => planner.analyzeWithModel(text, name, { ...options, config, fetchImpl: async () => response(specification) }),
    createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async () => { models++; return response(proposal); } }) };
  const orchestrator = new Orchestrator(store, trusted, { stepDelayMs: 0 }), project = await store.create({ name: '接口权限', source: { filename: 'r.md', content: source } });
  t.after(async () => { await orchestrator.shutdown(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('engineering-roles-')); await rm(directory, { recursive: true, force: true }); });
  const run = await orchestrator.createRun(project.id, { mode: 'model' }); await until(() => run.status === 'awaiting_spec');
  await orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision }); await until(() => run.status === 'awaiting_review');
  return { run, project, orchestrator, models: () => models };
}

test('owner route-role revision changes only the existing permission set and requires a newly confirmed plan', async t => {
  const x = await fixture(t), { run } = x, previous = structuredClone(run), history = structuredClone(run.engineeringHistory), budget = structuredClone(run.engineeringBudget);
  await x.orchestrator.action(x.project.id, run.id, { action: 'reject_plan', revision: run.planRevision, feedback: '接口角色与规格不符' });
  await x.orchestrator.action(x.project.id, run.id, { action: 'revise_route_roles', revision: run.planRevision, changes: [{ id: 'route-list', roles: ['ROLE-001'] }], feedback: '移除审核者的资源读取角色' });
  await until(() => run.status === 'awaiting_review'); assert.notEqual(run.planRevision, previous.planRevision); assert.equal(run.approvals.plan, null);
  assert.deepEqual(run.approvals.spec, previous.approvals.spec); assert.deepEqual(run.engineeringHistory, history); assert.deepEqual(run.engineeringBudget, budget); assert.equal(x.models(), 1);
  assert.deepEqual(run.engineeringPlan.proposal.routes[0].roles, ['ROLE-001']);
  for (const name of ['entities', 'views', 'tasks']) assert.deepEqual(run.engineeringPlan.proposal[name], previous.engineeringPlan.proposal[name]);
  assert.deepEqual(run.tasks, previous.tasks); assertEngineeringAlignment(run); assert.equal(run.revisionHistory.plan.at(-1).engineeringPlan.hash, previous.engineeringPlan.hash);
  await assert.rejects(x.orchestrator.action(x.project.id, run.id, { action: 'approve_plan', revision: previous.planRevision, specRevision: run.specRevision }), { status: 409 });
  await x.orchestrator.action(x.project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision }); await until(() => run.status === 'succeeded');
  assert.equal(run.approvals.plan.revision, run.planRevision); assert.equal(x.models(), 1); assert(run.decisions.some(d => d.action === 'revise_route_roles'));
});

test('invalid, reordered-only, unknown or non-data permissions cannot mutate a confirmed draft', async t => {
  const x = await fixture(t), original = structuredClone(x.run.engineeringPlan), revision = x.run.planRevision;
  const cases = [[], [{ id: 'unknown', roles: ['ROLE-001'] }], [{ id: 'route-list', roles: ['ROLE-999'] }], [{ id: 'route-list', roles: ['ROLE-001', 'ROLE-001'] }], [{ id: 'route-list', roles: ['ROLE-002', 'ROLE-001'] }], [{ id: 'route-list', roles: ['ROLE-001'], method: 'POST' }], [{ id: 'route-list', roles: ['ROLE-001'] }, { id: 'route-list', roles: [] }]];
  for (const changes of cases) {
    await assert.rejects(x.orchestrator.action(x.project.id, x.run.id, { action: 'revise_route_roles', revision, changes }), { status: 400 });
    assert.equal(x.run.planRevision, revision); assert.deepEqual(x.run.engineeringPlan, original);
  }
  let accessed = 0; const malicious = { id: 'route-list' }; Object.defineProperty(malicious, 'roles', { enumerable: true, get() { accessed++; return []; } });
  assert.throws(() => reviseEngineeringRouteRoles(x.run, [malicious]), { status: 400 }); assert.equal(accessed, 0); assert.equal(x.models(), 1);
});
