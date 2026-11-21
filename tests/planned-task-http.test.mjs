import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';

const post = (body = {}, cookie = '') => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
async function fixture(t, teamEnabled = false, supported = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-control-http-')), calls = [];
  const service = { list: async () => ({ executions: [] }), start: async () => assert.fail('not part of task control test'), cancel: async () => assert.fail('not part of task control test'),
    withProjectCheckpoint: (_id, work) => work(), shutdown: async () => {} };
  if (supported) for (const action of ['pause', 'resume']) service[action] = async input => { calls.push([action, input]); return { execution: { id: input.executionId, kind: 'planned_web', executionMode: 'task_dag', status: action === 'pause' ? 'pause_requested' : 'running', active: true } }; };
  const app = await createApp({ dataDir: directory, teamEnabled, stepDelayMs: 0, plannedExecutionService: service });
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('task-control-http-')); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: 'Task controls', source: { filename: 'requirements.md', content: '公开路由测试，不编码' } }), run = { id: randomUUID(), status: 'succeeded', stages: [], artifacts: [], tasks: [] };
  project.runs.push(run); await app.store.save(project); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`, route = `${origin}/api/projects/${project.id}/runs/${run.id}/development-executions/job`;
  return { app, origin, route, calls, identity: { projectId: project.id, runId: run.id, executionId: 'job' } };
}
test('task controls derive all identities from the real HTTP route and reject body authority or invalid methods', async t => {
  const f = await fixture(t);
  for (const action of ['pause', 'resume']) {
    const response = await fetch(`${f.route}/${action}`, post()); assert.equal(response.status, 200); assert.equal((await response.json()).execution.active, true);
    for (const field of ['projectId', 'runId', 'executionId', 'leaseToken', 'passed', 'status', 'budget']) assert.equal((await fetch(`${f.route}/${action}`, post({ [field]: 'untrusted' }))).status, 400);
    assert.ok([404, 405].includes((await fetch(`${f.route}/${action}`)).status));
    assert.equal((await fetch(`${f.route}/${action}`, { ...post(), headers: { 'content-type': 'application/json', Origin: 'https://external.invalid' } })).status, 403);
  }
  assert.deepEqual(f.calls, [['pause', f.identity], ['resume', f.identity]]);
});
test('older execution adapters cannot fabricate a supported pause or resume action', async t => {
  const f = await fixture(t, false, false); for (const action of ['pause', 'resume']) assert.equal((await fetch(`${f.route}/${action}`, post())).status, 409); assert.equal(f.calls.length, 0);
});
test('only team owners control real tasks; reviewer and observer get server denial and each attempted mutation is audited', async t => {
  const f = await fixture(t, true);
  const setup = await fetch(`${f.origin}/api/team/setup`, post({ name: 'owner', password: 'synthetic-owner-password-123' })); assert.equal(setup.status, 201); const owner = setup.headers.get('set-cookie').split(';')[0];
  const cookies = { owner };
  for (const role of ['reviewer', 'observer']) {
    const created = await fetch(`${f.origin}/api/team/members`, post({ name: role, role, password: `synthetic-${role}-password-123` }, owner)); assert.equal(created.status, 201);
    const login = await fetch(`${f.origin}/api/team/login`, post({ name: role, password: `synthetic-${role}-password-123` })); assert.equal(login.status, 200); cookies[role] = login.headers.get('set-cookie').split(';')[0];
  }
  for (const action of ['pause', 'resume']) {
    assert.equal((await fetch(`${f.route}/${action}`, post())).status, 401);
    for (const role of ['reviewer', 'observer']) assert.equal((await fetch(`${f.route}/${action}`, post({}, cookies[role]))).status, 403);
    const allowed = await fetch(`${f.route}/${action}`, post({}, owner)); assert.equal(allowed.status, 200); assert.ok(allowed.headers.get('x-request-id'));
  }
  assert.deepEqual(f.calls, [['pause', f.identity], ['resume', f.identity]]);
  const audit = await fetch(`${f.origin}/api/team/audit`, { headers: { Cookie: owner } }); assert.equal(audit.status, 200);
  const body = await audit.json(), events = body.events ?? body.audit ?? [];
  assert.ok(events.some(event => event.target.endsWith('/pause') && event.status === 403)); assert.ok(events.some(event => event.target.endsWith('/resume') && event.status === 200));
});
