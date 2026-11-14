import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectStore } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import * as planner from '../lib/planner.mjs';
import { createEngineeringModel } from '../lib/engineering-model.mjs';
import { contentRevision } from '../lib/planning-review.mjs';

const source = '用户可以查看资源。', config = { baseUrl: 'https://model.invalid/v1', model: 'spec-mock', apiKey: 'synthetic-spec-secret' };
const raw = () => ({ title: '  资源  ', summary: source, goals: [], roles: ['读者'], constraints: [], assumptions: [], questions: [], acceptanceScenarios: [],
  requirements: [{ title: ' 查看资源 ', description: source, acceptance: ['  显示资源  '], sourceQuote: source }], stack: { frontend: 'HTML', backend: 'Node.js', storage: 'SQLite' } });
const reply = (content = JSON.stringify(raw()), finish = 'stop', usage = { prompt_tokens: 7, completion_tokens: 9 }) => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }], usage }));
const engineering = { version: 1, title: '资源设计', summary: '提供资源列表', entities: [{ id: 'RESOURCE', name: '资源', fields: [{ name: 'id', type: 'string', required: true }], constraints: [] }],
  routes: [{ id: 'LIST', method: 'GET', path: '/api/resources', roles: ['ROLE-001'], request: '无', response: '列表', errors: [{ status: 401, reason: '未登录' }], requirementIds: ['R-001'] }],
  views: [{ id: 'HOME', path: '/', title: '资源', requirementIds: ['R-001'], selectors: [{ testId: 'resources', role: 'list' }] }],
  tasks: [{ id: 'IMPLEMENT', title: '资源列表', description: '实现确认规格', requirementIds: ['R-001'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['接口'], acceptance: ['显示资源'] }] };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function waitFor(check) { const until = Date.now() + 5000; while (!check()) { if (Date.now() > until) throw new Error('等待规格阶段超时'); await delay(5); } }
const idle = x => !x.orchestrator.state(x.run).active.size && !x.orchestrator.state(x.run).driving;
async function terminal(x, status = 'failed') { await waitFor(() => x.run.status === status && idle(x)); }
async function setup(t, { fetchImpl = async () => reply(), provider, options = {}, beforeRun, mode = 'model' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spec-planning-')), store = await new ProjectStore(directory).init(); let calls = 0, invocations = 0;
  const actual = (text, name, input) => planner.analyzeWithModel(text, name, { ...input, config, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
  const trusted = { ...planner, getModelConfig: () => ({ configured: true, model: config.model }), analyzeWithModel: (text, name, input) => { invocations++; return (provider ?? actual)(text, name, input, actual); },
    createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(engineering) } }] })) }) };
  const orchestrator = new Orchestrator(store, trusted, { stepDelayMs: 0, ...options }), instances = [orchestrator];
  const project = await store.create({ name: '资源项目', source: { filename: 'requirements.md', content: source } });
  t.after(async () => { await Promise.all(instances.map(item => item.shutdown())); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('spec-planning-')); await rm(directory, { recursive: true, force: true }); });
  const x = { directory, store, project, orchestrator, trusted, actual, calls: () => calls, invocations: () => invocations, register: item => instances.push(item) };
  await beforeRun?.(x); x.run = await orchestrator.createRun(project.id, { mode }); return x;
}
const retry = x => x.orchestrator.action(x.project.id, x.run.id, { action: 'retry', stageId: 'spec' });
const receiptFile = x => path.join(x.directory, '.private', 'specification-receipts', x.project.id, x.run.id, `${x.run.specificationHistory.at(-1).receipt.id}.json`);

test('model specification has one private receipt, normalized equality, known usage and a public-safe real planning export', async t => {
  const content = `\n\`\`\`json\n${JSON.stringify(raw())}\n\`\`\`\n`, x = await setup(t, { fetchImpl: async () => reply(content) }); await terminal(x, 'awaiting_spec');
  assert.equal(x.calls(), 1); assert.equal(x.invocations(), 1); assert.equal(x.run.specificationCalls, 1); const attempt = x.run.specificationHistory[0];
  assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.sourceRevision, x.run.sourceRevision); assert.equal(attempt.finishReason, 'stop'); assert.equal(attempt.receiptState, 'saved'); assert.equal(attempt.requestState, 'settled'); assert.equal(attempt.model, config.model);
  assert.deepEqual(attempt.usage, { inputTokens: 7, outputTokens: 9 }); assert.equal(x.run.spec.title, '资源'); assert.equal(x.run.spec.requirements[0].id, 'R-001'); assert.deepEqual(x.run.spec.requirements[0].acceptance, ['显示资源']);
  const file = await readFile(receiptFile(x)), receipt = JSON.parse(file); assert.deepEqual(Object.keys(receipt), ['model', 'finishReason', 'usage', 'content']); assert.equal(receipt.content, content);
  assert.equal(attempt.receipt.sha256, createHash('sha256').update(file).digest('hex')); assert.equal(attempt.receipt.bytes, file.length);
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'approve_spec', revision: x.run.specRevision }); await terminal(x, 'awaiting_review');
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'approve_plan', revision: x.run.planRevision, specRevision: x.run.specRevision }); await terminal(x, 'succeeded');
  const publicText = JSON.stringify(x.run), exported = x.run.artifacts.find(item => item.name === 'plan.json').content;
  for (const value of [x.directory, '.private', 'specification-receipts', config.apiKey, JSON.stringify(content)]) assert.equal(publicText.includes(value), false, value);
  assert.equal(JSON.parse(exported).specificationHistory, undefined); assert.equal(x.calls(), 1);
});

test('abnormal finishes, malformed JSON and provider failures retain only trustworthy usage and never publish a spec', async t => {
  for (const variant of ['length', 'tool_calls', 'unknown', 'json', 'http', 'network', 'unknown_usage']) await t.test(variant, async t => {
    const x = await setup(t, { fetchImpl: async () => {
      if (variant === 'http') return new Response('private path ' + config.apiKey, { status: 503 });
      if (variant === 'network') throw new Error(config.apiKey + '/private/fetch');
      return reply(variant === 'json' ? '{"title":' : JSON.stringify(raw()), variant === 'unknown_usage' || variant === 'json' ? 'stop' : variant, variant === 'unknown_usage' ? { prompt_tokens: -1, completion_tokens: '9' } : undefined);
    } }); await terminal(x, variant === 'unknown_usage' ? 'awaiting_spec' : 'failed'); const attempt = x.run.specificationHistory[0];
    assert.equal(x.calls(), 1); assert.deepEqual(attempt.usage, ['http', 'network', 'unknown_usage'].includes(variant) ? { inputTokens: null, outputTokens: null } : { inputTokens: 7, outputTokens: 9 });
    if (variant !== 'unknown_usage') { assert.equal(x.run.spec, null); assert.equal(x.run.approvals.spec, null); assert.equal(attempt.code, variant === 'http' ? 'http_error' : variant === 'network' ? 'transport_error' : variant === 'json' ? 'invalid_model_response' : 'abnormal_finish'); }
    assert.equal(JSON.stringify(x.run).includes(config.apiKey), false); assert.equal(JSON.stringify(x.run).includes('/private/fetch'), false);
  });
});

test('escaped credential content is privately redacted before rejection and preserves finish and known usage', async t => {
  const encoded = [...config.apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const x = await setup(t, { fetchImpl: async () => reply(`"{"name":"${encoded}","name":"normal"}`) }); await terminal(x);
  const attempt = x.run.specificationHistory[0], receipt = JSON.parse(await readFile(receiptFile(x), 'utf8'));
  assert.equal(attempt.code, 'credential_response'); assert.equal(attempt.finishReason, 'stop'); assert.deepEqual(attempt.usage, { inputTokens: 7, outputTokens: 9 });
  assert.equal(receipt.content.includes(encoded), false); assert.equal(receipt.content.includes(config.apiKey), false); assert.equal(x.run.spec, null);
});

test('missing, duplicate, malformed or inconsistent provider receipts fail closed without executing getters', async t => {
  for (const variant of ['missing', 'duplicate', 'getter', 'mismatch', 'result_getter', 'encoded_size']) await t.test(variant, async t => {
    let getters = 0;
    const x = await setup(t, { provider: async (text, name, input, actual) => {
      if (variant === 'getter') { const value = {}; Object.defineProperty(value, 'content', { enumerable: true, get() { getters++; return config.apiKey; } }); try { input.onReceipt(value); } catch {} return {}; }
      if (variant === 'encoded_size') return input.onReceipt({ model: config.model, finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 9 }, content: '\0'.repeat(512 * 1024) });
      let captured; const result = await actual(text, name, { ...input, onReceipt: variant === 'missing' ? undefined : value => { captured = value; return input.onReceipt(value); } });
      if (variant === 'duplicate') { try { await input.onReceipt(captured); } catch {} }
      if (variant === 'mismatch') result.title = 'not the receipted title';
      if (variant === 'result_getter') Object.defineProperty(result, 'title', { enumerable: true, get() { getters++; return 'bad'; } });
      return result;
    } }); await terminal(x); assert.equal(x.run.spec, null); assert.equal(x.run.approvals.spec, null); assert.equal(getters, 0); assert.equal(x.run.specificationHistory[0].status, 'failed');
    assert.equal(x.run.specificationHistory[0].code, variant === 'mismatch' ? 'invalid_model_response' : 'receipt_failed');
  });
});

test('run budget is durable, failures do not refund attempts and exhausted retry sends no new request', async t => {
  const x = await setup(t, { fetchImpl: async () => reply('{'), options: { specificationMaxCalls: 2 } }); await terminal(x); const first = structuredClone(x.run.specificationHistory[0]);
  await retry(x); await terminal(x); assert.equal(x.run.specificationCalls, 2); assert.equal(x.calls(), 2); assert.deepEqual(x.run.specificationHistory[0], first);
  await retry(x); await terminal(x); assert.equal(x.calls(), 2); assert.equal(x.run.specificationHistory.length, 2); assert.match(x.run.stages.find(item => item.id === 'spec').error, /预算已用尽/);
  const disk = JSON.parse(await readFile(path.join(x.directory, x.project.id + '.json'), 'utf8')); assert.equal(disk.runs[0].specificationCalls, 2);
  assert.deepEqual(x.run.specificationBudget, { maxCalls: 2, timeoutMs: 90000 }); await x.orchestrator.shutdown();
  const restoredStore = await new ProjectStore(x.directory).init(), restored = new Orchestrator(restoredStore, x.trusted, { stepDelayMs: 0, specificationMaxCalls: 5 }); x.register(restored); await restored.init();
  const restoredRun = restoredStore.get(x.project.id).runs[0]; await restored.action(x.project.id, restoredRun.id, { action: 'retry', stageId: 'spec' });
  await waitFor(() => restoredRun.status === 'failed' && !restored.state(restoredRun).active.size && !restored.state(restoredRun).driving); assert.equal(x.calls(), 2); assert.equal(restoredRun.specificationHistory.length, 2);
});

test('a non-cooperative provider times out, blocks new work until truly settled, and cannot publish a late receipt or spec', async t => {
  const gate = deferred(); let callback;
  const x = await setup(t, { options: { specificationTimeoutMs: 35 }, provider: (_text, _name, input) => { callback = input.onReceipt; return gate.promise; } }); await terminal(x);
  const attempt = x.run.specificationHistory[0], before = structuredClone(attempt); assert.equal(attempt.code, 'model_timeout'); assert.equal(attempt.requestState, 'unconfirmed');
  await assert.rejects(x.orchestrator.withProjectCheckpoint(x.project.id, () => assert.fail('unknown request admitted')), { code: 'project_busy' });
  await assert.rejects(retry(x), { status: 409 }); await assert.rejects(x.orchestrator.createRun(x.project.id), { status: 409 });
  assert.throws(() => callback({ model: config.model, finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 9 }, content: JSON.stringify(raw()) }));
  gate.resolve({ title: 'late' }); await waitFor(() => !x.orchestrator.hasSpecificationWork(x.project.id)); await delay(10); assert.deepEqual(attempt, before); assert.equal(x.run.spec, null);
  assert.equal(await x.orchestrator.withProjectCheckpoint(x.project.id, () => 'idle'), 'idle');
});

test('shutdown interrupts ownership promptly; late completion does not alter history and a restart can explicitly retry', async t => {
  const gate = deferred(), entered = deferred(); const x = await setup(t, { provider: () => { entered.resolve(); return gate.promise; } });
  await entered.promise; assert.equal(x.invocations(), 1); assert.equal(x.run.specificationHistory[0].requestState, 'running');
  const started = Date.now(); await x.orchestrator.shutdown(); assert.ok(Date.now() - started < 1000); const old = structuredClone(x.run.specificationHistory[0]);
  assert.equal(old.code, 'cancelled'); assert.equal(old.requestState, 'unconfirmed'); assert.equal(x.run.spec, null);
  const store = await new ProjectStore(x.directory).init(), next = new Orchestrator(store, { ...x.trusted, analyzeWithModel: x.actual }, { stepDelayMs: 0 }); x.register(next); await next.init();
  const project = store.get(x.project.id), run = project.runs[0]; assert.equal(run.specificationCalls, 1); assert.deepEqual(run.specificationHistory[0], old);
  await next.action(project.id, run.id, { action: 'retry', stageId: 'spec' }); await waitFor(() => run.status === 'awaiting_spec' && !next.state(run).active.size && !next.state(run).driving);
  gate.resolve({ title: 'late previous controller' }); await delay(15); assert.deepEqual(run.specificationHistory[0], old); assert.equal(run.specificationHistory.length, 2); assert.equal(run.specificationCalls, 2);
  assert.deepEqual(x.run.specificationHistory[0], old); assert.equal(x.run.spec, null);
});

test('shutdown before a reserved specification is dispatched records not_started and never enters the provider', async t => {
  const entered = deferred(), release = deferred(); let originalSave;
  const x = await setup(t, { provider: () => assert.fail('派发前关闭不能调用模型'), beforeRun: x => {
    originalSave = x.store.save.bind(x.store); let held = false;
    x.store.save = async project => { if (!held && project.runs.some(run => run.specificationHistory?.length === 1)) { held = true; entered.resolve(); await release.promise; } return originalSave(project); };
  } });
  try {
    await entered.promise; assert.equal(x.invocations(), 0);
    const stopping = x.orchestrator.shutdown(); release.resolve(); await stopping;
    const attempt = x.run.specificationHistory[0]; assert.equal(attempt.code, 'cancelled'); assert.equal(attempt.requestState, 'not_started');
    assert.equal(x.invocations(), 0); assert.equal(x.run.spec, null); assert.equal(x.run.approvals.spec, null);
    let callbackEntered = false;
    await assert.rejects(x.orchestrator.withProjectCheckpoint(x.project.id, () => { callbackEntered = true; }), { status: 409, code: 'project_checkpoint' });
    assert.equal(callbackEntered, false);
  } finally { release.resolve(); x.store.save = originalSave; }
});

test('a hung receipt writer is bounded and its late success or error cannot mutate finalized metadata', async t => {
  for (const rejected of [false, true]) await t.test(rejected ? 'late error' : 'late success', async t => {
    const gate = deferred(), x = await setup(t, { options: { specificationTimeoutMs: 50 }, beforeRun: env => { env.orchestrator.writeSpecificationReceipt = () => gate.promise; } }); await terminal(x);
    const attempt = x.run.specificationHistory[0], before = structuredClone(attempt); assert.equal(attempt.receiptState, 'unconfirmed'); assert.equal(attempt.code, 'model_timeout'); assert.deepEqual(attempt.usage, { inputTokens: 7, outputTokens: 9 });
    await assert.rejects(x.orchestrator.withProjectCheckpoint(x.project.id, () => {}), { code: 'project_busy' }); await assert.rejects(retry(x), { status: 409 });
    const started = Date.now(); await x.orchestrator.shutdown(); assert.ok(Date.now() - started < 1000);
    if (rejected) gate.reject(new Error(config.apiKey + '/private/writer')); else gate.resolve({ id: attempt.id, sha256: 'a'.repeat(64), bytes: 1 });
    await delay(15); assert.deepEqual(attempt, before); assert.equal(x.run.spec, null);
  });
});

test('stale source or run identity, and boundary pause, never change the frozen call ownership', async t => {
  for (const variant of ['source', 'identity', 'pause']) await t.test(variant, async t => {
    const gate = deferred(), x = await setup(t, { fetchImpl: async () => { await gate.promise; return reply(); } }); await waitFor(() => x.calls() === 1);
    const original = x.run.sourceRevision;
    if (variant === 'source') x.run.sourceSnapshot.content += 'changed';
    else if (variant === 'identity') x.project.runs[0] = { ...x.run };
    else await x.orchestrator.action(x.project.id, x.run.id, { action: 'pause' });
    gate.resolve();
    if (variant === 'pause') { await waitFor(() => x.run.stages.find(item => item.id === 'spec').status === 'succeeded' && idle(x)); assert.equal(x.run.status, 'paused'); assert.equal(x.run.specificationHistory[0].sourceRevision, original); await x.orchestrator.action(x.project.id, x.run.id, { action: 'resume' }); await terminal(x, 'awaiting_spec'); }
    else { await terminal(x); assert.equal(x.run.spec, null); assert.equal(x.run.specificationHistory[0].status, 'failed'); }
  });
});

test('receipt storage failure, linked parents and invalid writer metadata expose no private paths or body', async t => {
  for (const variant of ['writer', 'link', 'metadata']) await t.test(variant, async t => {
    let outside;
    const x = await setup(t, { beforeRun: async env => {
      if (variant === 'link') { outside = path.join(env.directory, 'outside'); await mkdir(outside); await symlink(outside, path.join(env.directory, '.private'), process.platform === 'win32' ? 'junction' : 'dir'); }
      else env.orchestrator.writeSpecificationReceipt = async () => { if (variant === 'writer') throw new Error(config.apiKey + env.directory); return { id: 'fake', sha256: 'a'.repeat(64), bytes: 1, path: env.directory }; };
    } }); await terminal(x); const attempt = x.run.specificationHistory[0]; assert.equal(attempt.code, 'receipt_failed'); assert.equal(attempt.receiptState, 'failed'); assert.deepEqual(attempt.usage, { inputTokens: 7, outputTokens: 9 });
    assert.equal(JSON.stringify(x.run).includes(x.directory), false); assert.equal(JSON.stringify(x.run).includes(config.apiKey), false); assert.equal(x.run.spec, null);
    if (outside) assert.deepEqual(await readdir(outside), []);
  });
});

test('reservation and final publication save failures cannot authorize approval; retry preserves failed history', async t => {
  for (const point of ['reservation', 'validated', 'publication']) await t.test(point, async t => {
    let failed = false;
    const x = await setup(t, { beforeRun: env => { const save = env.store.save.bind(env.store); env.store.save = async project => {
      const run = project.runs[0], attempt = run?.specificationHistory?.[0], stage = run?.stages.find(item => item.id === 'spec');
      if (!failed && attempt && (point === 'reservation' ? attempt.status === 'running' : point === 'validated' ? attempt.status === 'validated' : stage.status === 'succeeded')) { failed = true; throw new Error(config.apiKey + env.directory); }
      return save(project);
    }; } }); await terminal(x); assert.equal(failed, true); assert.equal(x.run.spec, null); assert.equal(x.run.specRevision, null); assert.deepEqual(x.run.approvals, { spec: null, plan: null });
    const attempt = structuredClone(x.run.specificationHistory[0]); assert.equal(attempt.code, 'persistence_failed'); assert.equal(attempt.status, 'failed');
    const persisted = x.store.getPersistedRun(x.project.id, x.run.id).run; assert.equal(persisted.spec, null); assert.equal(persisted.specRevision, null); assert.equal(x.run.artifacts.some(item => item.name === 'spec.md'), false);
    await assert.rejects(x.orchestrator.action(x.project.id, x.run.id, { action: 'approve_spec', revision: x.run.specRevision }), { status: 409 });
    await retry(x); await terminal(x, 'awaiting_spec'); assert.deepEqual(x.run.specificationHistory[0], attempt); assert.equal(x.run.specificationCalls, 2);
  });
});

test('restart marks only real unfinished new attempts unknown, while old history-free and local/v1 flows remain compatible', async t => {
  const x = await setup(t, { mode: 'local' }); await terminal(x, 'awaiting_spec'); assert.equal(x.run.specificationHistory, undefined); assert.equal(x.run.specificationCalls, undefined);
  await x.orchestrator.shutdown(); const old = structuredClone(x.run); x.run.mode = 'model'; x.run.status = 'running'; x.run.spec = null; x.run.specRevision = null;
  Object.assign(x.run.stages.find(item => item.id === 'spec'), { status: 'running' });
  x.run.specificationCalls = 1; x.run.specificationHistory = [{ id: 'history', attempt: 1, sourceRevision: x.run.sourceRevision, status: 'running', requestState: 'running', receiptState: 'writing', usage: { inputTokens: null, outputTokens: null } }]; await x.store.save(x.project);
  const store = await new ProjectStore(x.directory).init(), next = new Orchestrator(store, x.trusted, { stepDelayMs: 0 }); x.register(next); await next.init();
  const run = store.get(x.project.id).runs[0]; assert.equal(run.status, 'failed'); assert.equal(run.specificationCalls, 1); assert.equal(run.specificationHistory[0].code, 'service_restart'); assert.equal(run.specificationHistory[0].receiptState, 'unconfirmed'); assert.equal(run.specificationHistory[0].requestState, 'unconfirmed'); assert.equal(x.calls(), 0);
  store.get(x.project.id).runs[0] = old; await store.save(store.get(x.project.id)); await next.init(); assert.equal(store.get(x.project.id).runs[0].specificationHistory, undefined);
  const legacy = await setup(t, { options: { stepDelayMs: 10 } }); delete legacy.run.workflowVersion; await terminal(legacy, 'awaiting_review');
  assert.equal(legacy.run.specificationCalls, 1); assert.equal(legacy.run.engineeringCalls, undefined); await legacy.orchestrator.action(legacy.project.id, legacy.run.id, { action: 'approve' }); await terminal(legacy, 'succeeded');
});

test('the final metadata save cannot publish a specification after source ownership or mode changes inside that await', async t => {
  for (const variant of ['revision', 'mode']) await t.test(variant, async t => {
    let changed = false;
    const x = await setup(t, { beforeRun: env => { const save = env.store.save.bind(env.store); env.store.save = async project => {
      await save(project); const run = project.runs[0];
      if (!changed && run?.specificationHistory?.[0]?.status === 'validated') { changed = true; if (variant === 'revision') run.sourceRevision = 'd'.repeat(64); else run.mode = 'local'; }
    }; } }); await terminal(x); assert.equal(changed, true); assert.equal(x.run.spec, null); assert.equal(x.run.specRevision, null); assert.equal(x.run.approvals.spec, null);
    assert.equal(x.run.specificationHistory[0].code, 'stale_revision'); assert.equal(x.run.specificationHistory[0].status, 'failed'); assert.equal(x.run.artifacts.some(item => item.name === 'spec.md'), false);
  });
});
