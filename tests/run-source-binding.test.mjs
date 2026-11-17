import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error('等待规格停点超时'); await delay(5); }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-source-binding-'));
  const calls = { specifications: 0 };
  const config = { baseUrl: 'https://model.invalid/v1', model: 'run-source-binding-fixture', apiKey: 'synthetic-run-source-binding-fixture' };
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner,
    getModelConfig: () => ({ configured: true, model: config.model }),
    analyzeWithModel: (content, name, options) => {
      calls.specifications++;
      const spec = { title: name, summary: content, goals: [], roles: ['用户'], questions: [], constraints: [], assumptions: [], acceptanceScenarios: [],
        stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' }, sourceMode: 'model',
        requirements: [{ id: 'R1', title: '查看资源', description: content, sourceQuote: content, acceptance: ['按当前需求展示资源'] }] };
      return planner.analyzeWithModel(content, name, { ...options, config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(spec) } }] })) });
    },
  } });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('run-source-binding-'));
    await rm(directory, { recursive: true, force: true });
  });
  const project = await app.store.create({ name: '规划需求版本绑定', source: { filename: 'r.md', content: '用户可以查看资源。' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  let writes = 0;
  const save = app.store.save.bind(app.store);
  app.store.save = (...args) => { writes++; return save(...args); };
  const post = async (route, body) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const start = options => post(`/api/projects/${project.id}/runs`, { mode: 'model', ...options });
  const current = () => app.store.getSourceVersion(project.id);
  const expected = value => ({ expectedSourceRevision: value.revision, expectedSourceGeneration: value.generation });
  const disk = () => readFile(path.join(directory, `${project.id}.json`), 'utf8');
  const applySource = async (source, requestKey) => {
    const before = current(), change = app.sourceChangeService.request({ projectId: project.id, baseRevision: before.revision, source, reason: '验证输入版本并发保护', kind: 'other', requestKey });
    return app.sourceChangeService.apply({ projectId: project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation });
  };
  return { app, project, start, post, current, expected, calls, disk, writes: () => writes, applySource };
}

test('HTTP正确需求内容版本与代次创建冻结运行，旧调用不传预期版本继续兼容', async t => {
  for (const provideExpected of [true, false]) {
    const env = await fixture(t), source = env.current();
    const result = await env.start(provideExpected ? env.expected(source) : {});
    assert.equal(result.status, 201);
    const run = env.project.runs[0];
    await until(() => run.status === 'awaiting_spec' && !env.app.orchestrator.state(run).driving);
    assert.equal(env.calls.specifications, 1);
    assert.equal(run.sourceRevision, source.revision);
    assert.equal(run.sourceGeneration, source.generation);
    assert.deepEqual(run.sourceSnapshot, source.source);
    assert.equal(run.approvals.spec, null);
  }
});

test('HTTP不匹配内容版本或代次在创建、持久化和模型调用前409拒绝', async t => {
  const env = await fixture(t), current = env.current(), before = await env.disk();
  for (const options of [
    { ...env.expected(current), expectedSourceRevision: '0'.repeat(64) },
    { ...env.expected(current), expectedSourceGeneration: current.generation + 1 },
  ]) {
    const result = await env.start(options);
    assert.equal(result.status, 409);
    assert.match(result.body.error, /需求版本已变化/);
  }
  assert.equal(env.project.runs.length, 0);
  assert.equal(env.writes(), 0);
  assert.equal(env.calls.specifications, 0);
  assert.equal(await env.disk(), before);
  assert.equal(env.app.orchestrator.projectAdmissions.has(env.project.id), false);
});

test('HTTP缺一项或非法预期字段400拒绝，内部显式undefined也不被视为省略', async t => {
  const env = await fixture(t), current = env.current(), pair = env.expected(current), before = await env.disk();
  const malformed = [
    { expectedSourceRevision: current.revision }, { expectedSourceGeneration: current.generation },
    { ...pair, expectedSourceRevision: null }, { ...pair, expectedSourceRevision: false },
    { ...pair, expectedSourceRevision: 'a'.repeat(63) }, { ...pair, expectedSourceRevision: 'A'.repeat(64) },
    { ...pair, expectedSourceRevision: 'g'.repeat(64) }, { ...pair, expectedSourceGeneration: -1 },
    { ...pair, expectedSourceGeneration: 0.5 }, { ...pair, expectedSourceGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...pair, expectedSourceGeneration: '0' }, { ...pair, expectedSourceGeneration: null },
  ];
  for (const input of malformed) assert.equal((await env.start(input)).status, 400, JSON.stringify(input));
  await assert.rejects(env.app.orchestrator.createRun(env.project.id, { mode: 'model', expectedSourceRevision: undefined, expectedSourceGeneration: undefined }), { status: 400 });
  assert.equal(env.project.runs.length, 0);
  assert.equal(env.writes(), 0);
  assert.equal(env.calls.specifications, 0);
  assert.equal(await env.disk(), before);
  assert.equal(env.app.orchestrator.projectAdmissions.has(env.project.id), false);
});

test('真实需求ABA回到相同内容哈希后，旧代次请求仍409且不调用模型', async t => {
  const env = await fixture(t), first = env.current();
  await env.applySource({ filename: 'r.md', content: '用户可以查看资源并筛选名称。' }, 'binding-change-to-b');
  await env.applySource(first.source, 'binding-change-to-a');
  const latest = env.current(), before = await env.disk(), writes = env.writes();
  assert.equal(latest.revision, first.revision);
  assert.equal(latest.generation, first.generation + 2);
  const result = await env.start(env.expected(first));
  assert.equal(result.status, 409);
  assert.equal(env.project.runs.length, 0);
  assert.equal(env.writes(), writes);
  assert.equal(env.calls.specifications, 0);
  assert.equal(await env.disk(), before);
});

test('创建运行首次持久化被挂起时，真实需求apply不能跨越项目认领保护', async t => {
  const env = await fixture(t), current = env.current(), entered = deferred(), release = deferred();
  const change = env.app.sourceChangeService.request({ projectId: env.project.id, baseRevision: current.revision,
    source: { filename: 'r.md', content: '用户可以查看资源并筛选名称。' }, reason: '在创建运行时尝试变更', kind: 'other', requestKey: 'binding-admission-change' });
  const save = env.app.store.save.bind(env.app.store);
  let held = false;
  env.app.store.save = async project => {
    if (!held && project.runs.length) { held = true; entered.resolve(); await release.promise; }
    return save(project);
  };
  const starting = env.start(env.expected(current));
  try {
    await entered.promise;
    assert.equal(env.app.orchestrator.projectAdmissions.has(env.project.id), true);
    assert.equal(env.calls.specifications, 0);
    const apply = await env.post(`/api/projects/${env.project.id}/changes/${change.id}/apply`, { baseRevision: change.baseRevision, generation: change.generation });
    assert.equal(apply.status, 409);
    assert.deepEqual(env.project.source, current.source);
    assert.equal(env.app.sourceChangeService.list({ projectId: env.project.id })[0].status, 'pending');
  } finally { release.resolve(); env.app.store.save = save; }
  assert.equal((await starting).status, 201);
  const run = env.project.runs[0];
  await until(() => run.status === 'awaiting_spec' && !env.app.orchestrator.state(run).driving);
  assert.deepEqual(run.sourceSnapshot, current.source);
  assert.equal(run.sourceGeneration, current.generation);
  assert.equal(env.calls.specifications, 1);
});

test('需求发布安全检查点在途时，正确双版本请求也原子拒绝且不产生运行', async t => {
  const env = await fixture(t), current = env.current(), entered = deferred(), release = deferred(), before = await env.disk();
  const checkpoint = env.app.orchestrator.withProjectCheckpoint(env.project.id, async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    const result = await env.start(env.expected(current));
    assert.equal(result.status, 409);
    assert.equal(env.project.runs.length, 0);
    assert.equal(env.writes(), 0);
    assert.equal(env.calls.specifications, 0);
    assert.equal(await env.disk(), before);
  } finally { release.resolve(); await checkpoint; }
});
