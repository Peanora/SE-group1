import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../server.mjs';

async function fixture(t, service) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verification-planning-http-'));
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, verificationPlanningService: service });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('verification-planning-http-')); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '测试提案HTTP', source: { filename: 'r.md', content: '用户读取资源。' } });
  const run = { id: randomUUID(), status: 'succeeded', stages: [], artifacts: [], tasks: [] }; project.runs.push(run); await app.store.save(project);
  const identity = { projectId: project.id, runId: run.id }, url = `http://127.0.0.1:${app.server.address().port}`;
  const route = `${url}/api/projects/${project.id}/runs/${run.id}/verification-plans`;
  const request = (suffix = '', body) => fetch(route + suffix, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, project, url, route, identity, request };
}
function stub() {
  const calls = [], row = { id: 'proposal-one', status: 'draft', coverage: 'structural_only', executed: false };
  const service = { shutdown: async () => {} };
  for (const method of ['list', 'propose', 'revise', 'approve', 'reject', 'cancel']) service[method] = async input => { calls.push([method, structuredClone(input)]); return method === 'list' ? { proposals: [row], capabilities: {} } : { proposal: row }; };
  return { calls, service };
}

test('verification proposal HTTP derives identity and accepts only the precise data for each action', async t => {
  const { calls, service } = stub(), { identity, request } = await fixture(t, service);
  assert.equal((await request()).status, 200);
  assert.equal((await request('/propose', { contractRevision: 'a'.repeat(64) })).status, 202);
  const revision = 'b'.repeat(64), proposal = { version: 1, id: 'data-only' };
  for (const [action, body] of [['revise', { revision, proposal, feedback: '增加异常场景' }], ['approve', { revision, feedback: '' }], ['reject', { revision, feedback: '需要补充' }], ['cancel', {}]]) assert.equal((await request('/proposal-one/' + action, body)).status, 200);
  assert.deepEqual(calls, [['list', identity], ['propose', { ...identity, contractRevision: 'a'.repeat(64) }],
    ['revise', { ...identity, proposalId: 'proposal-one', revision, proposal, feedback: '增加异常场景' }], ['approve', { ...identity, proposalId: 'proposal-one', revision, feedback: '' }],
    ['reject', { ...identity, proposalId: 'proposal-one', revision, feedback: '需要补充' }], ['cancel', { ...identity, proposalId: 'proposal-one' }]]);
});

test('client identities, execution capabilities and paths never reach the proposal controller', async t => {
  const { calls, service } = stub(), { request } = await fixture(t, service);
  for (const field of ['projectId', 'runId', 'config', 'dependencies', 'budget', 'rootDir', 'files', 'manifest', 'passed']) assert.equal((await request('/propose', { contractRevision: 'a'.repeat(64), [field]: 'forbidden' })).status, 400);
  assert.equal((await request('/propose', {})).status, 400);
  for (const field of ['projectId', 'runId', 'proposalId', 'approval', 'passed', 'workspace']) assert.equal((await request('/proposal-one/approve', { revision: 'b'.repeat(64), feedback: '', [field]: 'forbidden' })).status, 400);
  assert.equal((await request('/proposal-one/cancel', { revision: 'b'.repeat(64) })).status, 400);
  assert.equal((await request('/proposal-one/revise', { revision: 'b'.repeat(64), proposal: {} })).status, 400);
  assert.deepEqual(calls, []);
});

test('proposal routes reject rebinding and cross-site calls, and preserve controller conflicts and disabled services', async t => {
  const { calls, service } = stub(), { request, route } = await fixture(t, service);
  const status = await new Promise((resolve, reject) => { const q = http.get(route, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); q.once('error', reject); });
  assert.equal(status, 403);
  const response = await fetch(route + '/propose', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify({ contractRevision: 'a'.repeat(64) }) });
  assert.equal(response.status, 403); assert.deepEqual(calls, []);
  service.propose = async () => { throw Object.assign(new Error('当前计划已变化。'), { status: 409 }); };
  const conflict = await request('/propose', { contractRevision: 'a'.repeat(64) }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, '当前计划已变化。');
  const disabled = await fixture(t, null); assert.equal((await disabled.request()).status, 404);
});
