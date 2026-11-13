import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp, startServer } from '../server.mjs';

async function fixture(t, service) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-execution-http-'));
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, executionService: service });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('web-execution-http-'));
    await rm(directory, { recursive: true, force: true });
  });
  const project = await app.store.create({ name: 'HTTP接线测试', source: { filename: 'test.md', content: 'Private test input' } });
  const run = { id: randomUUID(), status: 'succeeded', stages: [], artifacts: [], tasks: [] };
  project.runs.push(run); await app.store.save(project);
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { app, url, identity: { projectId: project.id, runId: run.id }, route: `${url}/api/projects/${project.id}/runs/${run.id}/executions` };
}

function stub() {
  const calls = [];
  const dto = { id: 'execution-1', status: 'failed', taskAccepted: false, actions: { canRetry: true } };
  const service = {
    list: async input => { calls.push(['list', input]); return { capabilities: { canStart: true, profiles: [] }, executions: [dto] }; },
    start: async input => { calls.push(['start', input]); return { execution: dto }; },
    action: async input => { calls.push(['action', input]); return { execution: dto }; },
    download: async input => { calls.push(['download', input]); return { buffer: Buffer.from('trusted route fixture'), filename: '图书源码.zip', contentType: 'application/zip' }; },
    shutdown: async () => { calls.push(['shutdown']); },
  };
  return { service, calls, dto };
}
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('execution routes preserve server project/run identity, exact payloads and download bytes', async t => {
  const { service, calls, dto } = stub(), { route, identity } = await fixture(t, service);
  let response = await fetch(route); assert.equal(response.status, 200); assert.equal((await response.json()).executions[0].id, dto.id);
  response = await fetch(`${route}/start`, json({ profileId: 'library-web-v1', contractRevision: 'fixed-contract' }));
  assert.equal(response.status, 202); assert.equal((await response.json()).execution.taskAccepted, false);
  response = await fetch(`${route}/execution-1/action`, json({ action: 'cancel' })); assert.equal(response.status, 200);
  response = await fetch(`${route}/execution-1/action`, json({ action: 'recheck' })); assert.equal(response.status, 200);
  response = await fetch(`${route}/execution-1/download`); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%E5%9B%BE/u);
  assert.equal(await response.text(), 'trusted route fixture');
  assert.deepEqual(calls, [
    ['list', identity], ['start', { ...identity, profileId: 'library-web-v1', contractRevision: 'fixed-contract' }],
    ['action', { ...identity, executionId: 'execution-1', action: 'cancel' }],
    ['action', { ...identity, executionId: 'execution-1', action: 'recheck' }], ['download', { ...identity, executionId: 'execution-1' }],
  ]);
});

test('execution rejects rebinding Host, mismatched ports and cross-site access before invoking the service', async t => {
  const { service, calls } = stub(), { route, url } = await fixture(t, service), port = new URL(url).port;
  for (const headers of [{ host: `attacker.example:${port}` }, { host: 'localhost:1' }, { host: `localhost.:${port}` }, { 'sec-fetch-site': 'cross-site' }]) {
    // fetch normalizes Host; the native client preserves the actual adversarial header.
    const status = await new Promise((resolve, reject) => { const request = http.get(route, { headers }, response => { response.resume(); resolve(response.statusCode); }); request.once('error', reject); });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  const crossOrigin = await fetch(`${route}/start`, { ...json({ profileId: 'library-web-v1', contractRevision: 'fixed-contract' }), headers: { 'content-type': 'application/json', origin: 'https://attacker.example' } });
  assert.equal(crossOrigin.status, 403); assert.deepEqual(calls, []);
});

test('extra client identity, paths, budget or results cannot enter execution controller calls', async t => {
  const { service, calls } = stub(), { route } = await fixture(t, service);
  for (const body of [
    { profileId: 'library-web-v1' }, { profileId: 'library-web-v1', contractRevision: 'x', projectId: 'other' },
    { profileId: 'library-web-v1', contractRevision: 'x', budget: { maxCalls: 999 } },
    { profileId: 'library-web-v1', contractRevision: 'x', report: { status: 'passed' } },
    { profileId: 'library-web-v1', contractRevision: 'x', workspace: 'C:/private' },
  ]) assert.equal((await fetch(`${route}/start`, json(body))).status, 400);
  for (const body of [{}, { action: 'cancel', executionId: 'other' }, { action: 'cancel', path: '../other' }, { action: 'force_pass' },
    { action: 'recheck', sourceReportPath: 'C:/private/execution.json' }, { action: 'recheck', sourceBinding: { projectId: 'other' } },
    { action: 'recheck', outputDir: 'C:/other' }, { action: 'recheck', budget: { maxReviewCalls: 999 } },
  ]) {
    assert.equal((await fetch(`${route}/execution-1/action`, json(body))).status, 400);
  }
  assert.deepEqual(calls, []);
});

test('unsupported verbs and absent services retain explicit failures; controller conflicts cannot become successful actions', async t => {
  const { service, calls } = stub(); service.start = async () => { throw Object.assign(new Error('当前计划版本已变化。'), { status: 409 }); };
  const { route } = await fixture(t, service);
  for (const [suffix, options] of [['', json({})], ['/start', {}], ['/execution-1/action', {}], ['/execution-1/download', json({})]]) {
    assert.equal((await fetch(route + suffix, options)).status, 405);
  }
  const response = await fetch(`${route}/start`, json({ profileId: 'library-web-v1', contractRevision: 'fixed-contract' }));
  assert.equal(response.status, 409); assert.equal((await response.json()).error, '当前计划版本已变化。'); assert.deepEqual(calls, []);
  const disabled = await fixture(t, null); assert.equal((await fetch(disabled.route)).status, 404);
});

test('shutdown is idempotent and closes the HTTP server even when execution shutdown rejects', async t => {
  const { service, calls } = stub(); service.shutdown = async () => { calls.push(['shutdown']); throw new Error('controlled shutdown failure'); };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-execution-close-'));
  const app = await createApp({ dataDir: directory, executionService: service });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('web-execution-close-')); await rm(directory, { recursive: true, force: true }); });
  const first = app.close(), second = app.close(); assert.equal(first, second);
  await assert.rejects(first, /controlled shutdown failure/u); assert.equal(app.server.listening, false); assert.deepEqual(calls, [['shutdown']]);
});

test('planning initialization failure releases the already opened execution service', async () => {
  const { service, calls } = stub();
  const store = { projects: new Map([['broken', { runs: [{ status: 'running' }] }]]) };
  await assert.rejects(createApp({ store, executionService: service }), TypeError);
  assert.deepEqual(calls, [['shutdown']]);
});

test('a port conflict releases the new execution service and leaves the existing listener intact', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-execution-listen-')), blocker = http.createServer((request, response) => response.end('original listener'));
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => blocker.close(resolve)); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('web-execution-listen-')); await rm(directory, { recursive: true, force: true }); });
  const { service, calls } = stub(), port = blocker.address().port;
  await assert.rejects(startServer({ dataDir: directory, executionService: service, loadEnv: false, port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
  assert.deepEqual(calls, [['shutdown']]);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'original listener');
});
