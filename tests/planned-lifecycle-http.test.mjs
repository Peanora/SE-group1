import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';

const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const barrier = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function fixture(t, team = false) {
  const base = path.resolve('output/lifecycle-http-author'); await mkdir(base, { recursive: true }); const dataDir = await mkdtemp(path.join(base, 'case-')), calls = [], gate = { hold: null, entered: null };
  const plain = { hasActivity: () => false, withProjectCheckpoint: async (_pid, work) => work(), shutdown: async () => {} };
  const local = { ...plain, list: async (_raw, options) => { options.assertAccess(); return { releases: [{ id: 'owned-release', projectId: project.id, actions: { canStart: true, canStop: false, canRollback: true } }] }; } };
  for (const action of ['activate', 'start', 'stop', 'rollback']) local[action] = async (raw, options) => { calls.push({ target: 'local', action, raw }); options.assertAccess(); if (gate.hold) { gate.entered.resolve(); await gate.hold.promise; options.assertAccess(); } return { release: { id: raw.releaseId ?? 'local-pair', ...raw } }; };
  const evolution = { ...plain, list: async () => ({ evolutions: [{ id: 'evo', projectId: project.id, runId: run.id, actions: { canRevise: true, canApprove: true, canStart: true, canActivate: true } }] }) };
  for (const action of ['prepare', 'revise', 'approve', 'reject', 'start', 'activate']) evolution[action] = async (raw, options) => { options.assertAccess(); calls.push({ target: 'evolution', action, raw }); return { evolution: { id: raw.evolutionId ?? 'evolution', ...raw } }; };
  const planned = { ...plain, list: async () => ({ executions: [], capabilities: {} }) }, datasets = { hasActivity: () => false, close: async () => {} };
  const app = await createApp({ dataDir, teamEnabled: team, stepDelayMs: 0, localLifecycleEnabled: true, plannedExecutionService: planned,
    localReleasesService: local, plannedDatasetService: datasets, evolutionService: evolution }); t.after(() => app.close());
  const project = await app.store.create({ name: 'Lifecycle HTTP fixture', source: { filename: 'request.md', content: '本地测试数据' } }), run = { id: 'run-a', status: 'succeeded', stages: [], artifacts: [], tasks: [] }; project.runs.push(run); await app.store.save(project);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${app.server.address().port}`, projectPath = `/api/projects/${project.id}`;
  return { app, calls, gate, project, run, origin, projectPath, local: `${origin}${projectPath}/local-releases`, evolution: `${origin}${projectPath}/runs/${run.id}/evolutions` };
}
test('local lifecycle routes derive scoped identity, use precise payloads and do not accept source or process capabilities', async t => {
  const f = await fixture(t), generation = 3;
  assert.equal((await fetch(f.local)).status, 200); assert.equal((await fetch(f.evolution)).status, 200);
  const initial = { runId: f.run.id, executionId: 'public-execution', expectedReleaseId: null, expectedDataGeneration: 0 };
  assert.equal((await fetch(`${f.local}/activate`, post(initial))).status, 200);
  assert.deepEqual(f.calls.at(-1).raw, { projectId: f.project.id, ...initial });
  for (const [action, body] of [['start', { expectedDataGeneration: generation }], ['stop', {}], ['rollback', { expectedDataGeneration: generation, reason: '恢复成对版本' }]]) {
    assert.equal((await fetch(`${f.local}/owned-release/${action}`, post(body))).status, 200); assert.deepEqual(f.calls.at(-1).raw, { projectId: f.project.id, releaseId: 'owned-release', ...body });
  }
  const prepare = { releaseId: 'owned-release', proposalId: 'definition', definitionRevision: 'a'.repeat(64), expectedSourceRevision: 'b'.repeat(64), expectedSourceGeneration: 1, requestKey: 'request-key', reason: '字段变化' };
  assert.equal((await fetch(f.evolution, post(prepare))).status, 200); assert.deepEqual(f.calls.at(-1).raw, { projectId: f.project.id, runId: f.run.id, ...prepare });
  const last = f.calls.length;
  for (const extra of ['projectId', 'workspace', 'databasePath', 'passed', 'stopEvidence', 'sourceHandle', 'migrationResult']) assert.equal((await fetch(f.evolution, post({ ...prepare, [extra]: 'forbidden' }))).status, 400);
  assert.equal((await fetch(`${f.local}/owned-release/stop`, post({ confirmed: true }))).status, 400);
  assert.equal((await fetch(`${f.local}/owned-release/rollback`, post({ expectedDataGeneration: generation }))).status, 400);
  assert.equal(f.calls.length, last);
  const host = await new Promise((resolve, reject) => { const request = http.get(f.local, { headers: { host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); request.once('error', reject); }); assert.equal(host, 403);
  assert.equal((await fetch(`${f.local}/owned-release/stop`, { ...post({}), headers: { 'content-type': 'application/json', origin: 'https://foreign.invalid' } })).status, 403);
});

test('team roles separate migration review from owned execution and recheck authority after an asynchronous operation', async t => {
  const f = await fixture(t, true), cookies = {};
  const request = async (url, body, cookie, method = 'POST') => fetch(f.origin + url, { ...post(body), method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
  let response = await request('/api/team/setup', { name: 'owner1', password: 'synthetic-owner-one-password' }); assert.equal(response.status, 201); cookies.owner = response.headers.get('set-cookie').split(';')[0];
  const owners = [];
  for (const [name, role] of [['owner2', 'owner'], ['reviewer', 'reviewer'], ['observer', 'observer']]) {
    response = await request('/api/team/members', { name, password: `synthetic-${name}-password`, role }, cookies.owner); assert.equal(response.status, 201); const member = (await response.json()).member; if (role === 'owner') owners.push(member);
    response = await request('/api/team/login', { name, password: `synthetic-${name}-password` }); assert.equal(response.status, 200); cookies[name] = response.headers.get('set-cookie').split(';')[0];
  }
  const reviewPath = `${f.projectPath}/runs/${f.run.id}/evolutions/evo/approve`, localPath = `${f.projectPath}/local-releases/pair/start`, body = { revision: 'a'.repeat(64), feedback: '确认精确迁移' };
  for (const [name, canReview] of [['reviewer', true], ['observer', false]]) {
    const localView = await (await fetch(f.local, { headers: { cookie: cookies[name] } })).json();
    assert.equal(localView.capabilities.canActivate, false); assert.ok(Object.values(localView.releases[0].actions).every(value => value === false));
    const evolutionView = await (await fetch(f.evolution, { headers: { cookie: cookies[name] } })).json();
    assert.equal(evolutionView.capabilities.canPrepare, false); assert.equal(evolutionView.evolutions[0].actions.canApprove, canReview);
    for (const action of ['canRevise', 'canStart', 'canActivate']) assert.equal(evolutionView.evolutions[0].actions[action], false);
  }
  assert.equal((await request(reviewPath, body, cookies.reviewer)).status, 200);
  assert.equal((await request(reviewPath, body, cookies.observer)).status, 403);
  assert.equal((await request(localPath, { expectedDataGeneration: 0 }, cookies.reviewer)).status, 403);
  assert.equal((await request(localPath, { expectedDataGeneration: 0 }, cookies.observer)).status, 403);
  const ownerIdentity = await (await fetch(`${f.origin}/api/team/session`, { headers: { cookie: cookies.owner } })).json();
  f.gate.hold = barrier(); f.gate.entered = barrier(); const pending = request(localPath, { expectedDataGeneration: 0 }, cookies.owner); await f.gate.entered.promise;
  response = await request(`/api/team/members/${ownerIdentity.user.id}`, { role: 'observer', active: true }, cookies.owner2, 'PATCH'); assert.equal(response.status, 200);
  f.gate.hold.resolve(); response = await pending; assert.ok([401, 403].includes(response.status), 'a revoked role cannot complete the pending mutation'); f.gate.hold = null;
});
