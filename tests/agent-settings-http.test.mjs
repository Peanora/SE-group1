import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server => `http://127.0.0.1:${server.address().port}`;
const disabledServices = { executionService: null, plannedExecutionService: null, verificationPlanningService: null, sourceChangeService: null };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-agent-http-'));
  const apps = [];
  t.after(async () => { for (const app of apps.reverse()) await app.close(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => { const app = await createApp({ dataDir: directory, agentEnvironment: {}, stepDelayMs: 0, ...disabledServices, ...options }); apps.push(app); await listen(app.server); return app; };
  let app = await start();
  return { get app() { return app; }, async restart() { await app.close(); app = await start(); }, async request(url, body, headers = {}, method = body === undefined ? 'GET' : 'PUT') {
    const response = await fetch(address(app.server) + url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  } };
}
const provider = (id, baseUrl, model) => ({ id, name: id, baseUrl, model, jsonMode: true, thinking: '' });
const payload = (view, providers, roles = view.roles) => ({ revision: view.revision, providers, roles });

test('HTTP saves API assignments without returning keys, rejects stale/foreign requests, survives restart', async t => {
  const f = await fixture(t);
  const initial = (await f.request('/api/agent-settings')).body;
  assert.equal(initial.roleDefinitions.length, 5);
  assert.equal((await f.request('/api/health')).body.model.configured, false);
  const secret = 'mock-private-key-should-never-return';
  const added = [provider('one', 'https://example.invalid/v1', 'spec-model')]; added[0].apiKey = secret;
  const saved = await f.request('/api/agent-settings', payload(initial, added, { ...initial.roles, spec: 'one' }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.providers[0].hasKey, true);
  assert.ok(!JSON.stringify(saved.body).includes(secret));
  assert.equal((await f.request('/api/health')).body.model.model, 'spec-model');
  assert.equal((await f.request('/api/agent-settings', payload(initial, added))).status, 409);
  assert.equal((await f.request('/api/agent-settings', payload(saved.body, []))).status, 400, 'bound provider cannot disappear');
  assert.equal((await f.request('/api/agent-settings', payload(saved.body, added), { origin: 'https://foreign.invalid' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(address(f.app.server) + '/api/agent-settings', { headers: { host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await f.request('/api/agent-settings', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  await f.restart();
  const restored = (await f.request('/api/agent-settings')).body;
  assert.equal(restored.revision, saved.body.revision);
  assert.equal(restored.roles.spec, 'one'); assert.equal(restored.providers[0].hasKey, true);
});

test('saved spec role reaches its real local HTTP provider; later config changes preserve the in-flight request', async t => {
  const source = '用户可以查看小组公告。', seen = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const model = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, body: JSON.parse(body) }); await gate;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'model-one', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      title: '小组公告', summary: source, goals: ['查看公告'], roles: ['用户'], constraints: [], assumptions: [], questions: [],
      stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, acceptanceScenarios: ['打开页面显示公告'],
      requirements: [{ id: 'R-001', title: '查看公告', description: source, sourceQuote: source, acceptance: ['打开页面显示公告'], kind: 'functional' }],
    }) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
  });
  await listen(model); t.after(async () => { release(); await new Promise(resolve => model.close(resolve)); });
  const f = await fixture(t), initial = (await f.request('/api/agent-settings')).body;
  const configured = await f.request('/api/agent-settings', payload(initial, [provider('local', address(model), 'model-one')], { ...initial.roles, spec: 'local' }));
  assert.equal(configured.status, 200);
  const created = await f.request('/api/projects', { name: '公告', filename: 'notice.md', content: source }, {}, 'POST');
  const started = await f.request(`/api/projects/${created.body.project.id}/runs`, { mode: 'model' }, {}, 'POST');
  assert.equal(started.status, 201);
  for (let i = 0; i < 150 && !seen.length; i++) await delay(10);
  assert.equal(seen.length, 1); assert.equal(seen[0].path, '/chat/completions'); assert.equal(seen[0].body.model, 'model-one');
  const updated = await f.request('/api/agent-settings', payload(configured.body, [provider('local', address(model), 'model-two')], configured.body.roles));
  assert.equal(updated.status, 200); release();
  let run;
  for (let i = 0; i < 150; i++) {
    run = (await f.request(`/api/projects/${created.body.project.id}/runs/${started.body.run.id}`)).body.run;
    if (run.status === 'awaiting_spec' || run.status === 'failed') break;
    await delay(10);
  }
  assert.equal(run.status, 'awaiting_spec', JSON.stringify(run.events));
  assert.equal(run.spec.sourceMode, 'model');
  assert.equal((await f.request('/api/health')).body.model.model, 'model-two');
});

test('only the team owner can inspect or change API settings', async t => {
  const f = await fixture(t, { teamEnabled: true }), password = 'Agent-api-test-password-2026';
  assert.equal((await f.request('/api/agent-settings')).status, 401);
  const owner = await f.request('/api/team/setup', { name: 'owner', password }, {}, 'POST'); assert.equal(owner.status, 201);
  const view = await f.request('/api/agent-settings', undefined, { cookie: owner.cookie }); assert.equal(view.status, 200);
  for (const role of ['reviewer', 'observer']) {
    assert.equal((await f.request('/api/team/members', { name: role, password, role }, { cookie: owner.cookie }, 'POST')).status, 201);
    const actor = await f.request('/api/team/login', { name: role, password }, {}, 'POST'); assert.equal(actor.status, 200);
    assert.equal((await f.request('/api/agent-settings', undefined, { cookie: actor.cookie })).status, 403);
    assert.equal((await f.request('/api/agent-settings', payload(view.body, []), { cookie: actor.cookie })).status, 403);
  }
});
