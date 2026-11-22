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
  for (const method of ['list', 'propose', 'importDefinition', 'revise', 'approve', 'reject', 'cancel']) service[method] = async input => { calls.push([method, structuredClone(input)]); return method === 'list' ? { proposals: [row], capabilities: {} } : { proposal: row }; };
  return { calls, service };
}

test('verification proposal HTTP derives identity and accepts only the precise data for each action', async t => {
  const { calls, service } = stub(), { identity, request } = await fixture(t, service);
  assert.equal((await request()).status, 200);
  assert.equal((await request('/propose', { contractRevision: 'a'.repeat(64) })).status, 202);
  const revision = 'b'.repeat(64), proposal = { version: 1, id: 'data-only' };
  for (const [action, body] of [['revise', { revision, proposal, feedback: '增加异常场景' }], ['approve', { revision, feedback: '' }], ['reject', { revision, feedback: '需要补充' }], ['cancel', {}]]) assert.equal((await request('/proposal-one/' + action, body)).status, 200);
  assert.deepEqual(calls, [['list', identity], ['list', identity], ['propose', { ...identity, contractRevision: 'a'.repeat(64) }],
    ['revise', { ...identity, proposalId: 'proposal-one', revision, proposal, feedback: '增加异常场景' }], ['list', identity], ['approve', { ...identity, proposalId: 'proposal-one', revision, feedback: '' }],
    ['reject', { ...identity, proposalId: 'proposal-one', revision, feedback: '需要补充' }], ['cancel', { ...identity, proposalId: 'proposal-one' }]]);
});

test('settled staged HTTP can request one missing supplement and one browser check with distinct quotes', async t => {
  const baseRevision = 'a'.repeat(64), extraRevision = 'b'.repeat(64);
  const partial = (id, stage, next) => ({
    id, origin: 'model', current: true, status: 'draft', receiptState: 'saved', proposal: { steps: [id] },
    revision: id.padStart(64, '0'), generationStage: stage, nextGenerationStage: next,
  });
  const proposals = [
    { id: '1', origin: 'model', current: true, status: 'failed' },
    { id: '2', origin: 'model', current: true, status: 'failed' },
    partial('3', 'http', 'http-supplement'),
  ];
  const paid = [];
  const service = {
    shutdown: async () => {},
    list: async (_identity, { additionalAttempts = 0 } = {}) => ({
      proposals,
      capabilities: {
        canPropose: proposals.length < 3 + additionalAttempts,
        contractRevision: additionalAttempts ? extraRevision : baseRevision,
        budget: { maxAttempts: 3 + additionalAttempts, remainingAttempts: Math.max(0, 3 + additionalAttempts - proposals.length), timeoutMs: 120000 },
      },
    }),
    propose: async ({ contractRevision }, options) => {
      if (!options || options.previousProposalId !== proposals.at(-1).id || contractRevision !== extraRevision) {
        throw Object.assign(new Error('No authorized continuation.'), { status: 409 });
      }
      paid.push(options);
      const row = proposals.length === 3 ? partial('4', 'http-supplement', 'browser') : partial('5', 'browser');
      proposals.push(row);
      return { proposal: row };
    },
  };
  const { request } = await fixture(t, service);
  const capability = async () => (await (await request()).json()).capabilities;
  const first = await capability();
  assert.equal(first.contractRevision, baseRevision);
  assert.equal(first.canPropose, false);
  assert.equal(first.continuation.stage, 'http-supplement');
  assert.equal(first.continuation.budget.remainingAttempts, 2);
  assert.notEqual(first.continuation.contractRevision, extraRevision);
  assert.equal((await request('/propose', { contractRevision: extraRevision })).status, 409);
  assert.equal((await request('/propose', { contractRevision: first.continuation.contractRevision })).status, 202);
  assert.equal((await request('/propose', { contractRevision: first.continuation.contractRevision })).status, 409);
  const second = await capability();
  assert.equal(second.continuation.stage, 'browser');
  assert.notEqual(second.continuation.contractRevision, first.continuation.contractRevision);
  assert.equal(second.continuation.budget.remainingAttempts, 1);
  assert.equal((await request('/propose', { contractRevision: second.continuation.contractRevision })).status, 202);
  assert.equal((await capability()).continuation, undefined);
  assert.equal((await request('/propose', { contractRevision: second.continuation.contractRevision })).status, 409);
  assert.deepEqual(paid, [{ previousProposalId: '3', additionalAttempts: 2 }, { previousProposalId: '4', additionalAttempts: 2 }]);
});

test('manual definition HTTP derives identity and accepts only definition, contract and feedback', async t => {
  const { calls, service } = stub(), { identity, request, route } = await fixture(t, service);
  const body = { contractRevision: 'a'.repeat(64), proposal: { version: 1, id: 'manual-only' }, feedback: '依据已确认需求导入；未运行' };
  const imported = await request('/import', body); assert.equal(imported.status, 201, await imported.text());
  assert.deepEqual(calls, [['importDefinition', { ...identity, ...body }]]);
  for (const key of ['projectId', 'runId', 'approved', 'budget', 'passed', 'origin', 'config', 'workspace']) assert.equal((await request('/import', { ...body, [key]: true })).status, 400);
  for (const key of Object.keys(body)) { const missing = { ...body }; delete missing[key]; assert.equal((await request('/import', missing)).status, 400); }
  assert.equal((await fetch(route + '/import', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify(body) })).status, 403);
  assert.equal(calls.length, 1);
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

test('project deletion waits for the proposal checkpoint even when code execution is idle', async t => {
  const { service } = stub(); let blocked = true, checkpoints = 0;
  service.withProjectCheckpoint = async (_id, publish) => {
    checkpoints++;
    if (blocked) throw Object.assign(new Error('测试提案状态尚待核对。'), { status: 409 });
    return publish();
  };
  const f = await fixture(t, service);
  const remove = () => fetch(`${f.url}/api/projects/${f.project.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmationName: f.project.name }) });
  assert.equal((await remove()).status, 409);
  assert.equal(f.app.store.get(f.project.id).name, f.project.name);
  blocked = false;
  assert.equal((await remove()).status, 200);
  assert.equal(checkpoints, 2);
  assert.throws(() => f.app.store.get(f.project.id), /不存在|未找到/u);
});
