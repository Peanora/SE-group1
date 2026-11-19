import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';

// These tests check real HTTP/team/route boundaries. Preview source admission
// and native runtime are tested elsewhere; the service below is an explicit stub.
const post = (body = {}, cookie = '') => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
async function fixture(t, teamEnabled = false, supported = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'preview-control-http-')), calls = [];
  const service = { list: async () => ({ executions: [] }), withProjectCheckpoint: (_id, work) => work(), shutdown: async () => {} };
  if (supported) for (const action of ['preview', 'stop-preview']) service[action === 'preview' ? 'preview' : 'stopPreview'] = async (input, options) => {
    options.assertAccess(); calls.push([action, input]);
    return { execution: { id: input.executionId, kind: 'planned_web', status: 'accepted', active: false }, preview: { state: action === 'preview' ? 'running' : 'stopped', active: action === 'preview' } };
  };
  const app = await createApp({ dataDir: directory, teamEnabled, stepDelayMs: 0, plannedExecutionService: service });
  t.after(async () => { await app.close(); const relative = path.relative(path.resolve(os.tmpdir()), directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('preview-control-http-')); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: 'Preview route fixture', source: { filename: 'requirements.md', content: '路由边界测试，不执行模型。' } }), run = { id: randomUUID(), status: 'succeeded', stages: [], artifacts: [], tasks: [] };
  project.runs.push(run); await app.store.save(project); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`, route = `${origin}/api/projects/${project.id}/runs/${run.id}/development-executions/job`;
  return { app, origin, route, calls, identity: { projectId: project.id, runId: run.id, executionId: 'job' } };
}
test('preview and stop derive identity from route and reject client verdicts, paths, secrets and external Origin', async t => {
  const f = await fixture(t);
  for (const action of ['preview', 'stop-preview']) {
    const response = await fetch(`${f.route}/${action}`, post()); assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.execution.active, false); assert.equal(body.preview.state, action === 'preview' ? 'running' : 'stopped');
    for (const field of ['projectId', 'runId', 'executionId', 'workspace', 'url', 'passed', 'status', 'apiKey']) assert.equal((await fetch(`${f.route}/${action}`, post({ [field]: 'untrusted' }))).status, 400);
    assert.ok([404, 405].includes((await fetch(`${f.route}/${action}`)).status));
    assert.equal((await fetch(`${f.route}/${action}`, { ...post(), headers: { 'content-type': 'application/json', Origin: 'https://foreign.invalid' } })).status, 403);
  }
  assert.deepEqual(f.calls, [['preview', f.identity], ['stop-preview', f.identity]]);
});
test('older execution adapters refuse unsupported preview operations', async t => {
  const f = await fixture(t, false, false); for (const action of ['preview', 'stop-preview']) assert.equal((await fetch(`${f.route}/${action}`, post())).status, 409); assert.equal(f.calls.length, 0);
});
test('only owner can mutate preview lifecycle and each allowed or forbidden request is audited', async t => {
  const f = await fixture(t, true), setup = await fetch(`${f.origin}/api/team/setup`, post({ name: 'owner', password: 'synthetic-owner-password-123' })); assert.equal(setup.status, 201);
  const owner = setup.headers.get('set-cookie').split(';')[0], cookies = { owner };
  for (const role of ['reviewer', 'observer']) {
    assert.equal((await fetch(`${f.origin}/api/team/members`, post({ name: role, role, password: `synthetic-${role}-password-123` }, owner))).status, 201);
    const login = await fetch(`${f.origin}/api/team/login`, post({ name: role, password: `synthetic-${role}-password-123` })); assert.equal(login.status, 200); cookies[role] = login.headers.get('set-cookie').split(';')[0];
  }
  for (const action of ['preview', 'stop-preview']) {
    assert.equal((await fetch(`${f.route}/${action}`, post())).status, 401);
    for (const role of ['reviewer', 'observer']) assert.equal((await fetch(`${f.route}/${action}`, post({}, cookies[role]))).status, 403);
    assert.equal((await fetch(`${f.route}/${action}`, post({}, owner))).status, 200);
  }
  const events = (await (await fetch(`${f.origin}/api/team/audit`, { headers: { Cookie: owner } })).json()).events;
  for (const action of ['preview', 'stop-preview']) assert.ok(events.some(event => event.target.endsWith(`/${action}`) && event.status === 200));
  assert.ok(events.some(event => event.status === 403)); assert.equal(f.calls.length, 2);
});
