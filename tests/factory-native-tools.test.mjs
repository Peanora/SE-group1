import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTORY_VERSION, factoryBinaryPath } from '../lib/factory-release.mjs';
import { createFactoryWorkbench } from '../lib/factory-workbench.mjs';

const binary = factoryBinaryPath(fileURLToPath(new URL('../', import.meta.url)));
const available = await access(binary).then(() => true, () => false);
const nativeTest = { skip: available ? false : '先运行 npm run factory:install 安装固定版本', timeout: 75_000 };
const projectId = 'native-tools';

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const prefix = 'taskflow-factory-native-';
  const directory = await mkdtemp(path.join(parent, prefix));
  const runtime = createFactoryWorkbench({ dataDir: directory, binary });
  t.after(async () => {
    try { await runtime.close(); } finally {
      assert.equal(path.dirname(directory), parent);
      assert.ok(path.basename(directory).startsWith(prefix));
      await rm(directory, { recursive: true, force: true });
    }
  });
  let origin;
  async function start() {
    const factory = await runtime.start(projectId);
    assert.equal(factory.version, FACTORY_VERSION);
    assert.equal(factory.state, 'running');
    assert.match(factory.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
    origin = factory.url;
  }
  async function request(uri, status = 200, method = 'GET', body) {
    const response = await fetch(new URL(uri, origin), {
      method, signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${uri}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
  await start();
  return { request, start, stop: () => runtime.stop(projectId) };
}

test('真实 Factory 原生设置：Agent、角色、配方、画布布局停启后读回', nativeTest, async t => {
  const factory = await fixture(t);
  const { request } = factory;
  const config = await request('/api/config');
  config.agents.fixture = { kind: 'custom', command: process.execPath, args: [], prompt_transport: 'stdin' };
  await request('/api/config', 204, 'PUT', config);
  assert.ok((await request('/api/agents')).some(agent => agent.name === 'fixture' && agent.available));

  const role = await request('/api/roles', 201, 'POST', {
    name: 'Fixture Advisor', description: 'Read-only local test role.', executionClass: 'advisory',
    agents: ['fixture'], preferredAgent: 'fixture', policyPreset: 'read_only',
  });
  assert.equal(role.id, 'fixture_advisor');
  assert.equal(role.kind, 'custom');
  assert.deepEqual(role.assignments, [{ agent: 'fixture', preferred: true }]);

  const recipe = await request('/api/recipes', 201, 'POST', {
    name: 'Fixture Development', roles: ['planner', 'worker', 'reviewer', role.id],
    routing: 'round_robin', maxParallelTasks: 2, plannerGuidance: 'Inspect docs before editing.',
  });
  assert.equal(recipe.id, 'fixture_development');
  assert.equal(recipe.maxParallelTasks, 2);

  const workspace = {
    version: 1,
    nodes: { 'agent:fixture': { x: 418, y: 216 }, 'group:fixture': { x: 260, y: 180 }, 'note:fixture': { x: 630, y: 80 } },
    customNodes: [
      { id: 'group:fixture', kind: 'group', label: 'Fixture group' },
      { id: 'note:fixture', kind: 'note', label: 'Fixture note', text: 'Saved separately from workflow state.' },
    ],
    edges: [{ id: 'edge:membership:fixture', source: 'agent:fixture', target: 'group:fixture', kind: 'membership' }],
  };
  await request('/api/graph/workspace', 204, 'PUT', workspace);
  const malformed = structuredClone(workspace);
  malformed.edges[0].target = 'group:missing';
  await request('/api/graph/workspace', 400, 'PUT', malformed);

  assert.equal((await factory.stop()).state, 'stopped');
  await factory.start();
  assert.deepEqual(await request('/api/graph/workspace'), workspace);
  assert.ok((await request('/api/roles')).some(item => item.id === role.id && item.assignments[0].agent === 'fixture'));
  assert.ok((await request('/api/recipes')).some(item => item.id === recipe.id && item.roles.includes(role.id)));
  assert.deepEqual(await request('/api/runs'), []);
});

test('真实 Factory 原生 MCP：本机 HTTP 发现只读工具、读取缓存并删除配置', nativeTest, async t => {
  const methods = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body || '{}');
    methods.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const results = {
      initialize: {
        protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'taskflow-fixture', version: '1.0.0' },
      },
      'tools/list': { tools: [{ name: 'lookup', description: 'Read local fixture data.',
        inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] },
    };
    const result = results[message.method];
    if (!result) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { request } = await fixture(t);
  const endpoint = '/api/mcp/servers/fixture';
  const added = await request('/api/mcp/servers', 201, 'POST', {
    id: 'fixture', transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`,
  });
  assert.equal(added.status, 'unknown');
  const discovered = await request(`${endpoint}/test`, 200, 'POST');
  assert.equal(discovered.status, 'connected');
  assert.ok(methods.includes('initialize') && methods.includes('tools/list'));
  const requestCount = methods.length;
  const [tool] = await request(`${endpoint}/tools`);
  assert.equal(tool.qualifiedName, 'fixture.lookup');
  assert.equal(tool.classification, 'read');
  assert.equal(methods.length, requestCount, '读取已缓存工具不重复请求 MCP 服务');
  assert.ok(!methods.includes('tools/call'));
  await request(endpoint, 204, 'DELETE');
  assert.deepEqual(await request('/api/mcp/servers'), []);
});
