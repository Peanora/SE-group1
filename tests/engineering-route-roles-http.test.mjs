import test from 'node:test';
import assert from 'node:assert/strict';
import { roleCase, until } from './helpers/engineering-role-case.mjs';
import { reviseEngineeringRouteContracts } from '../lib/engineering-route-contracts.mjs';

test('HTTP role changes are owner-only, version-bound and preserve model history, budget and draft data', async t => {
  const f = await roleCase(t, { teamEnabled: true }), { run, route } = await f.start();
  assert.equal((await f.request('/api/health')).value.engineeringRoleRevision.available, true);
  const body = { action: 'revise_route_roles', revision: run.planRevision, changes: [{ id: 'route-list', roles: ['ROLE-001'] }], feedback: '接口仅允许成员访问' };
  for (const role of ['reviewer', 'observer']) {
    assert.equal((await f.request('/api/team/members', { name: role, password: 'Route-role-fixture-password-2026', role }, f.owner)).status, 201);
    const login = await f.request('/api/team/login', { name: role, password: 'Route-role-fixture-password-2026' }); assert.equal(login.status, 200);
    assert.equal((await f.request(route + '/action', body, login.cookie)).status, 403);
  }
  assert.equal((await f.request(route + '/action', { ...body, tasks: [] }, f.owner)).status, 400);
  assert.equal((await f.request(route + '/action', { ...body, changes: [{ id: 'unknown', roles: [] }] }, f.owner)).status, 400);
  assert.equal((await f.request(route + '/action', { ...body, changes: [{ id: 'route-list', roles: ['ROLE-UNKNOWN'] }] }, f.owner)).status, 400);
  assert.equal((await f.request(route + '/action', body, f.owner)).status, 200);
  const next = await until(async () => { const result = await f.request(route, undefined, f.owner); return result.value.run.status === 'awaiting_review' && result.value.run; });
  assert.notEqual(next.planRevision, run.planRevision); assert.equal(next.approvals.plan, null); assert.deepEqual(next.approvals.spec, run.approvals.spec);
  assert.deepEqual(next.engineeringHistory, run.engineeringHistory); assert.deepEqual(next.specificationHistory, run.specificationHistory); assert.deepEqual(next.engineeringBudget, run.engineeringBudget);
  assert.deepEqual(next.tasks, run.tasks); assert.deepEqual(next.engineeringPlan.proposal.routes[0].roles, ['ROLE-001']); assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
  assert.equal((await f.request(route + '/action', body, f.owner)).status, 409);
  assert.equal((await f.request(route + '/action', { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision }, f.owner)).status, 409);
  assert.equal((await f.request(route + '/action', { action: 'approve_plan', revision: next.planRevision, specRevision: next.specRevision }, f.owner)).status, 200);
  await until(async () => (await f.request(route, undefined, f.owner)).value.run.status === 'succeeded');
  assert.equal((await f.request(route + '/action', { ...body, revision: next.planRevision }, f.owner)).status, 409);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
});

test('HTTP contract revision changes only existing route fields and requires a new plan approval', async t => {
  const f = await roleCase(t, { teamEnabled: true });
  const { run, route } = await f.start();
  const before = run.engineeringPlan.proposal;
  const action = { action: 'revise_route_contracts', revision: run.planRevision,
    changes: [{ id: 'route-list', request: '无正文，支持分页参数', response: '200 {items,total}', roles: ['ROLE-001'] }] };
  assert.equal((await f.request('/api/health')).value.engineeringRouteContractRevision.available, true);
  const reviewer = { name: 'contract-reviewer', password: 'Contract-reviewer-fixture-2026', role: 'reviewer' };
  assert.equal((await f.request('/api/team/members', reviewer, f.owner)).status, 201);
  const login = await f.request('/api/team/login', { name: reviewer.name, password: reviewer.password });
  assert.equal(login.status, 200);
  assert.equal((await f.request(route + '/action', action, login.cookie)).status, 403);

  for (const changes of [
    [{ id: 'missing', response: 'valid' }],
    [{ id: 'route-list', method: 'DELETE', response: 'valid' }],
    [{ id: 'route-list', response: '   ' }],
    [{ id: 'route-list', response: 123 }],
    [{ id: 'route-list', response: 'x'.repeat(2001) }],
    [{ id: 'route-list', response: before.routes[0].response }],
    [{ id: 'route-list', response: 'valid' }, { id: 'route-list', request: 'valid' }],
  ]) assert.equal((await f.request(route + '/action', { ...action, changes }, f.owner)).status, 400);
  let getterCalls = 0;
  const change = { id: 'route-list', get response() { getterCalls++; return 'text'; } };
  assert.throws(() => reviseEngineeringRouteContracts(run, [change]), { status: 400 });
  assert.equal(getterCalls, 0);
  assert.equal((await f.request(route, undefined, f.owner)).value.run.planRevision, run.planRevision);

  assert.equal((await f.request(route + '/action', action, f.owner)).status, 200);
  const next = await until(async () => {
    const result = await f.request(route, undefined, f.owner);
    return result.value.run.status === 'awaiting_review' && result.value.run;
  });
  const expected = structuredClone(before);
  Object.assign(expected.routes[0], action.changes[0]);
  assert.deepEqual(next.engineeringPlan.proposal, expected);
  assert.deepEqual(next.tasks, run.tasks);
  assert.deepEqual(next.approvals.spec, run.approvals.spec);
  assert.equal(next.approvals.plan, null);
  assert.equal(next.planVersion, run.planVersion + 1);
  assert.equal(next.revisionHistory.plan.at(-1).revision, run.planRevision);
  assert.match(next.artifacts.find(item => item.name === 'architecture.md').content, /200 \\\{items,total\\\}/u);
  assert.deepEqual(next.engineeringHistory, run.engineeringHistory);
  assert.deepEqual(next.engineeringBudget, run.engineeringBudget);
  assert.notEqual(next.planRevision, run.planRevision);
  assert.equal((await f.request(route + '/action', action, f.owner)).status, 409);
  assert.equal((await f.request(route + '/action', { action: 'approve_plan', revision: next.planRevision, specRevision: next.specRevision }, f.owner)).status, 200);
  await until(async () => (await f.request(route, undefined, f.owner)).value.run.status === 'succeeded');
  assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
});

for (const revoke of [true, false]) test(`checkpoint publication wait rechecks the submitting owner; revoked=${revoke}`, async t => {
  const f = await roleCase(t, { teamEnabled: true });
  let releaseSave, held = false;
  const gate = new Promise(resolve => { releaseSave = resolve; }), originalSave = f.app.store.save.bind(f.app.store);
  f.app.store.save = async project => { if (!held && project.runs.some(run => run.status === 'awaiting_review')) { held = true; await gate; } return originalSave(project); };
  try {
    const { run, route } = await f.start(); assert.equal(held, true); assert(f.app.orchestrator.state(f.app.store.getRun(f.projectId, run.id).run).driveIdle);
    const name = 'waiting-owner', password = 'Waiting-owner-fixture-2026';
    const added = await f.request('/api/team/members', { name, password, role: 'owner' }, f.owner); assert.equal(added.status, 201);
    const login = await f.request('/api/team/login', { name, password }); assert.equal(login.status, 200);
    const pending = f.request(route + '/action', { action: 'revise_route_roles', revision: run.planRevision, changes: [{ id: 'route-list', roles: ['ROLE-001'] }] }, login.cookie);
    await until(() => f.app.orchestrator.projectActions.has(f.projectId));
    if (revoke) {
      const response = await fetch(f.origin + '/api/team/members/' + added.value.member.id, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: f.owner }, body: JSON.stringify({ role: 'observer', active: false }) });
      assert.equal(response.status, 200); await response.arrayBuffer();
    }
    releaseSave(); const result = await pending, latest = (await f.request(route, undefined, f.owner)).value.run;
    if (revoke) {
      assert.ok([401, 403].includes(result.status)); assert.equal(latest.planRevision, run.planRevision); assert.equal(latest.planVersion, run.planVersion);
      assert.deepEqual(latest.engineeringPlan, run.engineeringPlan); assert.deepEqual(latest.decisions, run.decisions); assert.deepEqual(latest.approvals, run.approvals);
    } else { assert.equal(result.status, 200); assert.notEqual(latest.planRevision, run.planRevision); assert.equal(latest.planVersion, run.planVersion + 1); }
    assert.deepEqual(f.calls, { spec: 1, engineering: 1 }); assert.deepEqual(latest.engineeringHistory, run.engineeringHistory); assert.deepEqual(latest.engineeringBudget, run.engineeringBudget);
  } finally { releaseSave(); }
});
