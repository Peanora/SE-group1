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
      let captured; const result = await actual(text, name, { ...input, onReceipt: variant === 'missing' ? undefined : (value, proof) => { captured = value; return input.onReceipt(value, proof); } });
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
  await assert.rejects(retry(x), /次数已用尽/); await terminal(x); assert.equal(x.calls(), 2); assert.equal(x.run.specificationHistory.length, 2); assert.match(x.run.stages.find(item => item.id === 'spec').error, /JSON/); assert.equal((await x.orchestrator.describeRun(x.project,x.run)).specificationFailure.canRetry,false);
  const disk = JSON.parse(await readFile(path.join(x.directory, x.project.id + '.json'), 'utf8')); assert.equal(disk.runs[0].specificationCalls, 2);
  assert.deepEqual(x.run.specificationBudget, { maxCalls: 2, timeoutMs: 90000 }); await x.orchestrator.shutdown();
  const restoredStore = await new ProjectStore(x.directory).init(), restored = new Orchestrator(restoredStore, x.trusted, { stepDelayMs: 0, specificationMaxCalls: 5 }); x.register(restored); await restored.init();
  const restoredRun = restoredStore.get(x.project.id).runs[0]; await assert.rejects(restored.action(x.project.id, restoredRun.id, { action: 'retry', stageId: 'spec' }), /次数已用尽/);
  await waitFor(() => restoredRun.status === 'failed' && !restored.state(restoredRun).active.size && !restored.state(restoredRun).driving); assert.equal(x.calls(), 2); assert.equal(restoredRun.specificationHistory.length, 2);
});

test('unproven remote transport stays blocked after local provider settlement and cannot publish late data', async t => {
  const gate = deferred(); let callback;
  const x = await setup(t, { options: { specificationTimeoutMs: 35 }, provider: (_text, _name, input) => { callback = input.onReceipt; return gate.promise; } }); await terminal(x);
  const attempt = x.run.specificationHistory[0], before = structuredClone(attempt); assert.equal(attempt.code, 'model_timeout'); assert.equal(attempt.requestState, 'unconfirmed');
  await assert.rejects(x.orchestrator.withProjectCheckpoint(x.project.id, () => assert.fail('unknown request admitted')), { code: 'project_busy' });
  await assert.rejects(retry(x), { status: 409 }); await assert.rejects(x.orchestrator.createRun(x.project.id), { status: 409 });
  assert.throws(() => callback({ model: config.model, finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 9 }, content: JSON.stringify(raw()) }));
  gate.resolve({ title: 'late' }); await delay(15); assert.deepEqual(attempt, before); assert.equal(x.run.spec, null);
  assert.equal(x.orchestrator.hasSpecificationWork(x.project.id), true); await assert.rejects(x.orchestrator.withProjectCheckpoint(x.project.id, () => assert.fail('local settlement is not remote stop')), { code: 'project_busy' });
});

test('shutdown is bounded but restart cannot retry an unknown original remote request', async t => {
  const gate = deferred(), entered = deferred(); const x = await setup(t, { provider: () => { entered.resolve(); return gate.promise; } });
  await entered.promise; assert.equal(x.invocations(), 1); assert.equal(x.run.specificationHistory[0].requestState, 'dispatch_intent');
  const started = Date.now(); await x.orchestrator.shutdown(); assert.ok(Date.now() - started < 1000); const old = structuredClone(x.run.specificationHistory[0]);
  assert.equal(old.code, 'cancelled'); assert.equal(old.requestState, 'unconfirmed'); assert.equal(x.run.spec, null);
  const store = await new ProjectStore(x.directory).init(), next = new Orchestrator(store, { ...x.trusted, analyzeWithModel: x.actual }, { stepDelayMs: 0 }); x.register(next); await next.init();
  const project = store.get(x.project.id), run = project.runs[0]; assert.equal(run.specificationCalls, 1); assert.deepEqual(run.specificationHistory[0], old);
  await assert.rejects(next.action(project.id, run.id, { action: 'retry', stageId: 'spec' }), {status:409});
  gate.resolve({ title: 'late previous controller' }); await delay(15); assert.deepEqual(run.specificationHistory[0], old); assert.equal(run.specificationHistory.length, 1); assert.equal(run.specificationCalls, 1);
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

const vague = () => ({ ...raw(), requirements: [], questions: ['目标平台是什么？', '首版功能是什么？'] });
const answers = { 'Q-001': 'Web网页', 'Q-002': '访客可以查看资源列表。' };
test('空需求进入澄清停点，保存回答不调用模型，答复后新规格可确认并导出；补充引用和原文均可追溯', async t => {
  const inputs = [];
  const x = await setup(t, { fetchImpl: async (_url, options) => {
    inputs.push(JSON.parse(JSON.parse(options.body).messages[1].content).document);
    const final = raw(); final.requirements[0].sourceQuote = answers['Q-002'];
    return reply(JSON.stringify(inputs.length === 1 ? vague() : final));
  } });
  await terminal(x, 'awaiting_spec'); const original = structuredClone(x.run.sourceSnapshot), revision = x.run.sourceRevision;
  assert.equal(x.run.spec.clarificationRequired, true); assert.equal(x.run.specQuestions.length, 2);
  assert.ok(x.run.stages.filter(s => ['architecture','tasks'].includes(s.id)).every(s => s.attempt === 0));
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'approve_spec',revision:x.run.specRevision}), /仍待澄清/);
  const old = x.run.specRevision;
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'clarify_spec',revision:old,answers:{'Q-001':'Web'}}), /回答全部/);
  assert.equal(x.run.specRevision, old); assert.equal(x.calls(),1);
  await x.orchestrator.action(x.project.id,x.run.id,{action:'revise_spec',revision:old,answers});
  assert.equal(x.calls(),1);
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'clarify_spec',revision:old,answers}),{status:409});
  await x.orchestrator.action(x.project.id,x.run.id,{action:'clarify_spec',revision:x.run.specRevision,answers});
  await terminal(x,'awaiting_spec'); assert.equal(x.calls(),2);
  assert.ok(inputs[1].includes(answers['Q-002'])); assert.deepEqual(x.run.sourceSnapshot,original); assert.equal(x.run.sourceRevision,revision);
  assert.equal(x.run.spec.clarificationRequired,undefined); assert.equal(x.run.approvals.spec,null);
  assert.equal(x.run.spec.sourceClarifications[0].answers[1].answer,answers['Q-002']);
  assert.notEqual(x.run.specificationHistory[0].inputRevision,x.run.specificationHistory[1].inputRevision);
  await x.orchestrator.action(x.project.id,x.run.id,{action:'approve_spec',revision:x.run.specRevision}); await terminal(x,'awaiting_review');
  await x.orchestrator.action(x.project.id,x.run.id,{action:'approve_plan',revision:x.run.planRevision,specRevision:x.run.specRevision}); await terminal(x,'succeeded');
  const exported=JSON.parse(x.run.artifacts.find(a=>a.name==='plan.json').content);
  assert.equal(exported.clarificationHistory[0].answers[1].answer,answers['Q-002']);
  const restarted=await new ProjectStore(x.directory).init();assert.deepEqual(restarted.getRun(x.project.id,x.run.id).run.clarificationHistory,x.run.clarificationHistory);
});
test('澄清调用不扩大冻结预算，预算耗尽时仍可保存回答', async t => {
  const x=await setup(t,{fetchImpl:async()=>reply(JSON.stringify(vague())),options:{specificationMaxCalls:1}});await terminal(x,'awaiting_spec');
  await x.orchestrator.action(x.project.id,x.run.id,{action:'revise_spec',revision:x.run.specRevision,answers});
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'clarify_spec',revision:x.run.specRevision,answers}),/次数已用尽/);
  assert.equal(x.calls(),1);assert.equal(x.run.specQuestions[1].answer,answers['Q-002']);
});
test('补充调用失败保留回答及失败回执，重试采用相同补充输入且不自动确认', async t => {
  let calls=0;
  const x=await setup(t,{fetchImpl:async()=>{calls++;return reply(calls===1?JSON.stringify(vague()):calls===2?'broken':JSON.stringify(raw()));}});await terminal(x,'awaiting_spec');
  await x.orchestrator.action(x.project.id,x.run.id,{action:'clarify_spec',revision:x.run.specRevision,answers});await terminal(x,'failed');
  assert.equal(x.run.clarificationHistory.length,1);assert.equal(x.run.specificationHistory[1].status,'failed');
  assert.equal(x.run.specQuestions[1].answer,answers['Q-002']);
  await retry(x);await terminal(x,'awaiting_spec');assert.equal(x.calls(),3);assert.equal(x.run.approvals.spec,null);
  assert.equal(x.run.specificationHistory[1].inputRevision,x.run.specificationHistory[2].inputRevision);
});
test('澄清动作保存失败不发起新请求、也不丢失原停点', async t => {
  const x=await setup(t,{fetchImpl:async()=>reply(JSON.stringify(vague()))});await terminal(x,'awaiting_spec');
  const before=structuredClone(x.run),save=x.store.save;
  x.store.save=async()=>{throw new Error('controlled save failure');};
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'clarify_spec',revision:x.run.specRevision,answers}),/运行记录保存失败/);
  x.store.save=save;assert.deepEqual(x.run,before);assert.equal(x.calls(),1);
});

test('空需求且无可回答问题仍拒绝，不能把无效输出标成澄清成功', async t => {
  const x=await setup(t,{fetchImpl:async()=>reply(JSON.stringify({...raw(),requirements:[],questions:[]}))});await terminal(x,'failed');
  assert.equal(x.run.spec,null);assert.equal(x.run.specificationHistory[0].code,'invalid_model_response');
});

test('模型问题上下文不能冒充用户需求引用；保存的多行答复可逐字引用', async t => {
  let calls=0;
  const x=await setup(t,{fetchImpl:async()=>{
    calls++; const result=calls===1?{...vague(),questions:['需要支持支付吗？']}:raw();
    if(calls>1)result.requirements[0].sourceQuote=calls===2?'支持支付':'首版不包含支付';
    return reply(JSON.stringify(result));
  }});await terminal(x,'awaiting_spec');
  await x.orchestrator.action(x.project.id,x.run.id,{action:'clarify_spec',revision:x.run.specRevision,answers:{'Q-001':'首版不包含支付\n只查看资源'}});await terminal(x,'failed');
  assert.equal(x.run.specificationHistory[1].code,'invalid_model_response');
  await retry(x);await terminal(x,'awaiting_spec');assert.equal(x.run.spec.requirements[0].sourceQuote,'首版不包含支付');
  const changed=structuredClone(x.run.spec);changed.requirements[0].sourceQuote='支持支付';
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'revise_spec',revision:x.run.specRevision,spec:changed}),/原文引用/);
});

test('平台添加的答复包装可规范化，纯问题引用和伪造包装仍拒绝', () => {
  const input='原始需求\nQ-001 目标平台是什么？\n答复：Windows';
  assert.equal(planner.normalizeSourceQuote('答复：Windows',input,['原始需求','Windows']),'Windows');
  assert.equal(planner.normalizeSourceQuote('Q-001 目标平台是什么？\n答复：Windows',input,['原始需求','Windows']),'Windows');
  assert.equal(planner.normalizeSourceQuote('目标平台是什么',input,['原始需求','Windows']),null);
  assert.equal(planner.normalizeSourceQuote('伪造问题\n答复：Windows',input,['原始需求','Windows']),null);
});
test('具体引用失败原因被保留，公开说明不包含模型正文或私有路径', async t => {
  const bad=raw();bad.requirements[0].sourceQuote='not-in-source-private';
  const x=await setup(t,{fetchImpl:async()=>reply(JSON.stringify(bad))});await terminal(x);
  const dto=await x.orchestrator.describeRun(x.project,x.run);
  assert.equal(dto.specificationFailure.reason,'requirement_quote_not_found');assert.equal(dto.specificationFailure.requirementIndex,1);
  assert.deepEqual(dto.planningIssue.draftRequirement,{index:1,title:'查看资源',description:source,sourceQuote:'not-in-source-private'});
  assert.equal(dto.planningIssue.autoExplain,false);
  assert.match(x.run.stages.find(s=>s.id==='spec').error,/第1条需求/);
  assert.equal(JSON.stringify(dto.specificationFailure).includes('not-in-source-private'),false);assert.equal(JSON.stringify(dto.specificationFailure).includes(x.directory),false);
});
const oldRejected = async t => {
  const x=await setup(t,{options:{specificationMaxCalls:1},provider:async(text,name,options,actual)=>{await actual(text,name,options);throw new Error('legacy validator failure');}});
  await terminal(x);return x;
};
test('预算已尽可免费重新校验可信响应，不修改原失败/用量，也不自动审批或再请求模型', async t => {
  const x=await oldRejected(t),old=structuredClone(x.run.specificationHistory);
  const dto=await x.orchestrator.describeRun(x.project,x.run);assert.equal(dto.specificationFailure.canRevalidate,true);assert.equal(dto.specificationFailure.canRetry,false);
  await x.orchestrator.action(x.project.id,x.run.id,{action:'revalidate_spec',attemptId:old[0].id});
  assert.equal(x.run.status,'awaiting_spec');assert.equal(x.run.approvals.spec,null);assert.equal(x.run.specificationCalls,1);assert.equal(x.calls(),1);
  assert.deepEqual(x.run.specificationHistory,old);assert.equal(x.run.specificationRevalidations.length,1);
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'revalidate_spec',attemptId:old[0].id}),{status:409});
  const disk=await new ProjectStore(x.directory).init();assert.deepEqual(disk.getRun(x.project.id,x.run.id).run.specificationHistory,old);
});
test('免费重新校验拒绝旧响应编号、输入变更、篡改回执，保存失败撤回新规格', async t => {
  const x=await oldRejected(t);const attempt=x.run.specificationHistory[0],before=structuredClone(x.run);
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'revalidate_spec',attemptId:'foreign'}),{status:409});
  const originalSave=x.store.save;x.store.save=async()=>{throw new Error('controlled storage failure');};
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'revalidate_spec',attemptId:attempt.id}),/保存失败/);x.store.save=originalSave;assert.deepEqual(x.run,before);
  const {writeFile}=await import('node:fs/promises');const file=receiptFile(x);await writeFile(file,'{}');
  const dto=await x.orchestrator.describeRun(x.project,x.run);assert.equal(dto.specificationFailure.canRevalidate,false);
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'revalidate_spec',attemptId:attempt.id}),{status:409});assert.equal(x.calls(),1);assert.deepEqual(x.run,before);
});

test('重新校验最后一个异步边界之后输入变化不能发布旧规格', async t => {
  const x=await oldRejected(t),saved=x.orchestrator.savedSpecification.bind(x.orchestrator),before=structuredClone(x.run);
  x.orchestrator.savedSpecification=async(...args)=>{const result=await saved(...args);x.run.clarificationHistory=[{answers:[{question:'平台？',answer:'changed'}]}];return result;};
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'revalidate_spec',attemptId:before.specificationHistory[0].id}),{status:409});
  assert.deepEqual(x.run,before);assert.equal(x.calls(),1);
});

test('规格引用失败给出具体位置和可补充字段，补充先保存再用一次预算重试且不自动确认', async t => {
  let calls=0;const documents=[];
  const bad=()=>{const value=raw();value.requirements[0].sourceQuote='only-in-model-question';return value;};
  const x=await setup(t,{fetchImpl:async(_url,options)=>{calls++;documents.push(JSON.parse(JSON.parse(options.body).messages[1].content).document);return reply(JSON.stringify(calls===1?bad():raw()));}});
  await terminal(x);
  const failure=(await x.orchestrator.describeRun(x.project,x.run)).specificationFailure;
  assert.equal(failure.reason,'requirement_quote_not_found');assert.equal(failure.requirementIndex,1);
  assert.match(failure.message,/第1条需求「查看资源」/);assert.match(failure.message,/需求引用/);
  assert.equal(failure.repairable,true);assert.equal(failure.supplement.available,true);
  assert.deepEqual(failure.supplement.fields.map(field=>field.id),['evidence','scope','note']);
  assert.equal(failure.supplement.canRetry,true);assert.match(failure.supplement.note,/不覆盖原始需求/);
  assert.equal(JSON.stringify(failure).includes('only-in-model-question'),false);
  const sourceBefore=structuredClone(x.run.sourceSnapshot),revisionBefore=x.run.sourceRevision;
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'supplement_spec',revision:revisionBefore,answers:{unknown:'x'},retry:false}),/不支持/);
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'supplement_spec',revision:'0'.repeat(64),answers:{evidence:'说明'},retry:false}),{status:409});
  await x.orchestrator.action(x.project.id,x.run.id,{action:'supplement_spec',revision:revisionBefore,answers:{evidence:'首版只查看资源列表。'},retry:false});
  assert.equal(calls,1);assert.equal(x.run.status,'failed');
  const saved=(await x.orchestrator.describeRun(x.project,x.run)).specificationFailure.supplement.saved;
  assert.equal(saved.evidence,'首版只查看资源列表。');
  await x.orchestrator.action(x.project.id,x.run.id,{action:'supplement_spec',revision:revisionBefore,answers:{evidence:'首版只查看资源列表。'},retry:true});
  await terminal(x,'awaiting_spec');
  assert.equal(calls,2);assert.equal(x.run.specificationRepair,undefined);
  assert.equal(x.run.clarificationHistory.at(-1).kind,'spec_repair');
  assert.equal(x.run.approvals.spec,null);assert.equal(x.run.spec.requirements[0].title,'查看资源');
  assert.ok(documents[1].includes('首版只查看资源列表。'));
  assert.deepEqual(x.run.sourceSnapshot,sourceBefore);assert.equal(x.run.sourceRevision,revisionBefore);
  assert.notEqual(x.run.specificationHistory[0].inputRevision,x.run.specificationHistory[1].inputRevision);
});

test('直接重试失败规格时一并带入已保存的补充信息，不额外增加调用', async t => {
  let calls=0;const documents=[];
  const bad=()=>{const value=raw();value.requirements[0].sourceQuote='not-in-source';return value;};
  const x=await setup(t,{fetchImpl:async(_url,options)=>{calls++;documents.push(JSON.parse(JSON.parse(options.body).messages[1].content).document);return reply(JSON.stringify(calls===1?bad():raw()));}});
  await terminal(x);
  await x.orchestrator.action(x.project.id,x.run.id,{action:'supplement_spec',revision:x.run.sourceRevision,answers:{evidence:'首版只查看资源列表。'},retry:false});
  await retry(x);await terminal(x,'awaiting_spec');
  assert.equal(calls,2);assert.equal(x.run.specificationRepair,undefined);
  assert.equal(x.run.clarificationHistory.at(-1).kind,'spec_repair');
  assert.ok(documents[1].includes('首版只查看资源列表。'));
  assert.equal(x.run.approvals.spec,null);assert.equal(x.run.sourceSnapshot.content,source);
});

test('没有需求也没有可回答问题失败后列出补充字段，预算耗尽仍可保存但不能再次调用', async t => {
  const x=await setup(t,{fetchImpl:async()=>reply(JSON.stringify({...raw(),requirements:[],questions:[]})),options:{specificationMaxCalls:1}});
  await terminal(x);
  const failure=(await x.orchestrator.describeRun(x.project,x.run)).specificationFailure;
  assert.equal(failure.reason,'no_requirements_or_questions');assert.equal(failure.repairable,true);
  assert.deepEqual(failure.supplement.fields.map(field=>field.id),['goal','users','scope','acceptance']);
  assert.equal(failure.supplement.canRetry,false);
  await x.orchestrator.action(x.project.id,x.run.id,{action:'supplement_spec',revision:x.run.sourceRevision,answers:{scope:'首版只查看资源列表。'},retry:false});
  assert.equal(x.calls(),1);assert.equal(x.run.specificationRepair.answers.scope,'首版只查看资源列表。');
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'supplement_spec',revision:x.run.sourceRevision,answers:{scope:'首版只查看资源列表。'},retry:true}),/已用尽/);
  assert.equal(x.calls(),1);
});

test('新版规格重复上一版问题时预填继承回答，不再要求用户重填', async t => {
  const x = await setup(t, { fetchImpl: async () => reply(JSON.stringify(raw())) }); await terminal(x, 'awaiting_spec');
  x.run.specificationHistory = [];
  x.run.clarificationHistory = [{ kind: 'inherited', fromRunId: 'previous-run', revision: x.run.sourceRevision, at: new Date().toISOString(),
    answers: [{ question: '目标用户是谁？', answer: '访客', inherited: true }] }];
  const result = x.orchestrator.prepareSpec(x.project, x.run, { ...raw(), requirements: [], questions: ['目标用户是谁？'], clarificationRequired: true });
  assert.equal(result.specQuestions.length, 1); assert.equal(result.specQuestions[0].answer, '访客'); assert.equal(result.specQuestions[0].inherited, true);
  assert.equal(result.spec.clarifications[0].answer, '访客'); assert.equal(result.spec.clarifications[0].inherited, true);
  assert.equal(result.specRevision, contentRevision(result.spec));
});

test('规格首轮合并重复问法，有待答问题时草案保留且不记录完成', async t => {
  const duplicate=raw();duplicate.questions=['是否需要审核？','是否需要审核?', '谁有权限查看？'];
  const x=await setup(t,{fetchImpl:async()=>reply(JSON.stringify(duplicate))});await terminal(x,'awaiting_spec');
  const {planningIssue}=await x.orchestrator.describeRun(x.project,x.run);
  assert.deepEqual(planningIssue.qa.map(item=>item.question),['是否需要审核？','谁有权限查看？']);
  assert.equal(x.run.approvals.spec,null);
  assert.ok(x.run.events.some(event=>event.stageId==='spec' && /等待补充需求/u.test(event.message)));
  assert.ok(!x.run.events.some(event=>event.stageId==='spec' && /整理设计规格完成/u.test(event.message)));
  await assert.rejects(x.orchestrator.action(x.project.id,x.run.id,{action:'approve_spec',revision:x.run.specRevision}),{status:409});
});

test('都需要确认首版列出的每项功能，只追问真正未明确的原题', async t => {
  const features = '单聊与群聊的会话列表、未读消息提示、消息已读状态，首版分别需要哪些？';
  const exclusive = '消息可保留七天还是三十天？';
  const x = await setup(t, { fetchImpl: async () => reply(JSON.stringify({ ...raw(), questions: [features, exclusive] })) });
  await terminal(x, 'awaiting_spec');
  const { planningIssue: first } = await x.orchestrator.describeRun(x.project, x.run);
  await x.orchestrator.action(x.project.id, x.run.id, { action: 'answer_planning_issue', issueId: first.id, continue: true,
    answers: Object.fromEntries(first.qa.map(item => [item.id, '都需要。'])) });
  await terminal(x, 'awaiting_spec');
  const { planningIssue: next } = await x.orchestrator.describeRun(x.project, x.run);
  assert.deepEqual(next.qa.map(item => item.question), [exclusive]);
  assert.equal(x.run.spec.clarificationSources.records[0].decision, 'confirmed');
  assert.deepEqual(x.run.spec.clarificationSources.records[0].quotes, ['单聊与群聊的会话列表', '未读消息提示', '消息已读状态']);
  assert.equal(x.calls(), 2);
});

test('旧运行的重复历史问题与新增细节可直接用已保存答复整理，无需补填', async t => {
  const historyQuestion='首版不保存历史消息，是否意味着用户刷新页面或重新登录后之前聊天的文字内容全部不可见？';
  const obsolete=`请分别明确以下问题中的选项或事项（此前回答“是”还不能确定范围）：${historyQuestion}`;
  const optional='固定模拟验证码以什么形式呈现给用户？';
  const laterAnswer='重新登录后本机用户仍可见之前消息';
  const x=await setup(t,{fetchImpl:async()=>reply(JSON.stringify({...raw(),questions:[optional,obsolete]}))});
  await terminal(x,'awaiting_spec');
  x.run.clarificationHistory=[
    {answers:[{id:'Q-001',question:historyQuestion,answer:'是'}]},
    {kind:'planning_issue',answers:[{id:'Q-001',question:obsolete,answer:'本机用户还是可以可见的'}]},
    {kind:'planning_issue',answers:[{id:'Q-001',question:'重新登录后本机用户可以看到之前消息吗？',answer:laterAnswer},{id:'Q-002',question:obsolete,answer:'可见'}]},
  ];
  const history=structuredClone(x.run.clarificationHistory);
  const {planningIssue:issue}=await x.orchestrator.describeRun(x.project,x.run);
  assert.deepEqual(issue.qa,[]);assert.equal(issue.canRebuild,true);assert.equal(issue.autoExplain,false);assert.equal(x.calls(),1);
  await x.orchestrator.action(x.project.id,x.run.id,{action:'answer_planning_issue',issueId:issue.id,answers:{},continue:true});
  await terminal(x,'awaiting_spec');
  assert.equal(x.calls(),2);assert.deepEqual(x.run.specQuestions,[]);assert.equal(x.run.approvals.spec,null);
  assert.deepEqual(x.run.clarificationHistory,history);
  assert.equal(x.run.spec.clarificationSources.records[0].decision,'answered');
  assert.equal((await x.orchestrator.describeRun(x.project,x.run)).planningIssue,undefined);
});
