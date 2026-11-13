import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { contentRevision } from '../lib/planning-review.mjs';
import { createEngineeringModel, engineeringModelPolicy } from '../lib/engineering-model.mjs';
import { engineeringPlanPolicy, inspectEngineeringContext } from '../lib/engineering-plan.mjs';

const config = { baseUrl: 'https://model.invalid/v1', model: 'engineering-designer', apiKey: 'synthetic-engineering-key' };
function input() {
  const spec = { title: '资源预约', roles: ['申请者：查看和预约资源', '管理者：维护资源'], constraints: ['预约失败不改变数据'], stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ id: 'READ', title: '查看资源', description: '读取资源列表', acceptance: ['返回已有资源'] }, { id: 'RESERVE', title: '预约资源', description: '预约可用资源', acceptance: ['并发不能超量预约'] }] };
  return { spec, binding: { projectId: 'resources', runId: 'run', specRevision: contentRevision(spec) } };
}
function proposal() { return { version: 1, title: '资源预约设计', summary: '从已确认需求形成工程草案', entities: [
  { id: 'RESOURCE', name: '资源', fields: [{ name: 'id', type: 'string', required: true, unique: true }], constraints: [] },
  { id: 'RESERVATION', name: '预约', fields: [{ name: 'id', type: 'string', required: true, unique: true }, { name: 'resourceId', type: 'string', required: true, references: { entityId: 'RESOURCE', field: 'id' } }], constraints: ['不能超量'] },
], routes: [
  { id: 'LIST', method: 'GET', path: '/api/resources', roles: ['ROLE-001'], request: '无正文', response: '200与资源列表', errors: [], requirementIds: ['READ'] },
  { id: 'RESERVE', method: 'POST', path: '/api/reservations', roles: ['ROLE-001'], request: '资源id', response: '201与预约记录', errors: [{ status: 409, reason: '库存不足' }], requirementIds: ['RESERVE'] },
], views: [{ id: 'MAIN', path: '/', title: '资源', requirementIds: ['READ', 'RESERVE'], selectors: [{ testId: 'reserve', role: 'button' }] }], tasks: [
  { id: 'READ', title: '读取资源', description: '实现读取契约', requirementIds: ['READ'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['读取接口'], acceptance: ['列表符合规格'] },
  { id: 'RESERVE', title: '预约与页面', description: '实现预约接口及外置页面', requirementIds: ['RESERVE'], dependsOn: ['READ'], writePaths: ['src/app.mjs', 'public/index.html', 'public/app.js'], inputs: ['读取契约'], outputs: ['预约接口和页面'], acceptance: ['竞争时只有足够库存的请求成功'] },
] }; }
function envelope(content, { finishReason = 'stop', ...extra } = {}) { return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }], ...extra })); }
const reply = (raw = proposal(), extra = {}) => envelope(JSON.stringify(raw), extra);
async function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await callback(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const masked = error => { assert.equal(error.cause, undefined); assert.ok(!error.message.includes(config.apiKey)); assert.ok(!error.message.includes('private.invalid')); return true; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one request uses only fixed engineering context, 16384 tokens and structural-only frozen output', async () => {
  await withEnv({ LLM_JSON_MODE: '1', LLM_THINKING: 'disabled', LLM_MAX_TOKENS: '1' }, async () => {
    const original = input(); let calls = 0, receipt;
    const result = await createEngineeringModel({ config, fetchImpl: async (url, options) => {
      calls++; assert.equal(String(url), config.baseUrl + '/chat/completions'); assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      const body = JSON.parse(options.body); assert.equal(body.max_tokens, 16384); assert.deepEqual(body.response_format, { type: 'json_object' }); assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(JSON.parse(body.messages[1].content), inspectEngineeringContext(original));
      assert.ok(Buffer.byteLength(options.body) <= engineeringModelPolicy.requestBytes); assert.equal(options.body.includes(config.apiKey), false); assert.equal(Object.hasOwn(options, 'onReceipt'), false);
      for (const term of ['ROLE-001', 'createApp({databasePath})', 'SQLite', 'structural_only', 'references', 'writePaths', '依赖祖先链', 'Shell']) assert.ok(body.messages[0].content.includes(term), term);
      return reply(undefined, { usage: { prompt_tokens: 22, completion_tokens: 33 }, model: 'provider-forged' });
    } })({ ...original, onReceipt: value => { receipt = value; } });
    assert.equal(calls, 1); assert.equal(result.coverage, 'structural_only'); assert.equal(result.policyHash, engineeringPlanPolicy.hash); assert.equal(result.modelPolicyHash, engineeringModelPolicy.hash);
    assert.equal(result.model, config.model); assert.deepEqual(result.usage, { inputTokens: 22, outputTokens: 33 }); assert.equal(result.specHash, original.binding.specRevision);
    assert.deepEqual(result.requirements, original.spec.requirements); assert.equal(result.roleDefinitions[0].text, original.spec.roles[0]);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.proposal.tasks)); assert.equal(Object.hasOwn(result, 'passed'), false); assert.equal(Object.hasOwn(result, 'approval'), false);
    assert.deepEqual(Object.keys(receipt), ['model', 'finishReason', 'usage', 'content']); assert.equal(receipt.content, JSON.stringify(proposal()));
  });
});

test('context/config snapshots and per-call receipt copies survive caller mutations without changing the draft', async () => {
  const original = input(), expected = inspectEngineeringContext(original), settings = { ...config };
  const model = createEngineeringModel({ config: settings, fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(JSON.parse(options.body).messages[1].content), expected);
    original.spec.requirements[0].description = 'changed'; original.spec.roles.reverse(); original.binding.specRevision = 'a'.repeat(64);
    return reply(undefined, { usage: { prompt_tokens: 5, completion_tokens: 7 } });
  } }); settings.model = 'mutated-config';
  const sink = value => { value.model = 'changed'; value.content = '{}'; value.usage.inputTokens = 999; };
  sink.toJSON = () => assert.fail('sink is not request data');
  const result = await model({ ...original, onReceipt: sink }); assert.equal(result.model, config.model); assert.deepEqual(result.requirements, expected.spec.requirements); assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 7 });
});

test('LLM defaults are reused and unknown or illegal token usage remains null', async () => {
  await withEnv({ LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey, LLM_JSON_MODE: '0', LLM_THINKING: '' }, async () => {
    const result = await createEngineeringModel({ fetchImpl: async (_url, options) => { const body = JSON.parse(options.body); assert.equal('response_format' in body, false); assert.equal('thinking' in body, false); return reply(); } })(input()); assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
  });
  for (const usage of [{}, { prompt_tokens: 0, completion_tokens: 9 }, { prompt_tokens: -1, completion_tokens: '9' }, { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1.5 }]) {
    const result = await createEngineeringModel({ config, fetchImpl: async () => reply(undefined, { usage }) })(input());
    assert.deepEqual(result.usage, { inputTokens: Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null, outputTokens: Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null });
  }
});

test('getters, unapproved input shapes, stale revision and incompatible stack fail before sending', async () => {
  let calls = 0, invoked = false; const model = createEngineeringModel({ config, fetchImpl: async () => { calls++; return reply(); } });
  const getter = input(); Object.defineProperty(getter, 'spec', { enumerable: true, get() { invoked = true; return {}; } }); await assert.rejects(model(getter));
  const nested = input(); Object.defineProperty(nested.spec, 'hidden', { enumerable: true, get() { invoked = true; return 1; } }); await assert.rejects(model(nested));
  for (const mutate of [value => { value.spec.requirements[0].description = 'new spec'; }, value => { value.spec.stack.backend = 'Node.js 18'; }, value => { value.spec.toJSON = () => { invoked = true; }; }, value => { value.spec.extra = Infinity; }, value => { value.spec.extra = 'x'.repeat(128 * 1024); },
    ...['files', 'code', 'testResults', 'approved', 'passed', 'proposal'].map(key => value => { value[key] = true; })]) { const value = input(); mutate(value); await assert.rejects(model(value), masked); }
  for (const signal of [null, {}, false]) await assert.rejects(model({ ...input(), signal }));
  await assert.rejects(model({ ...input(), onReceipt: true }), { code: 'receipt_failed' }); assert.equal(calls, 0); assert.equal(invoked, false);
});

test('config, environment, private credentials and factory accessors cannot produce an invalid request', async () => {
  let calls = 0, invoked = false; const fetchImpl = async () => { calls++; return reply(); };
  for (const change of [{ baseUrl: 'file:///private.invalid' }, { baseUrl: 'https://user:pass@private.invalid/' }, { baseUrl: 'https://private.invalid/?x=1' }, { model: '' }, { model: config.apiKey }, { apiKey: 1 }, { timeoutMs: 0 }, { timeoutMs: null }, { timeoutMs: 120001 }]) await assert.rejects(createEngineeringModel({ config: { ...config, ...change }, fetchImpl })(input()), masked);
  const secretInput = input(); secretInput.spec.extra = config.apiKey; secretInput.binding.specRevision = contentRevision(secretInput.spec); await assert.rejects(createEngineeringModel({ config, fetchImpl })(secretInput), masked);
  const factory = {}; Object.defineProperty(factory, 'config', { enumerable: true, get() { invoked = true; return config; } }); assert.throws(() => createEngineeringModel(factory));
  assert.throws(() => createEngineeringModel({ config, fetchImpl: null })); assert.throws(() => createEngineeringModel({ config: null }));
  await withEnv({ LLM_THINKING: config.apiKey }, async () => { await assert.rejects(createEngineeringModel({ config, fetchImpl })(input()), masked); });
  assert.equal(calls, 0); assert.equal(invoked, false);
});

test('strict engineering schema rejects executable fields, unknown requirements, invented roles and unordered shared writes after a receipt', async () => {
  for (const mutate of [raw => { raw.passed = true; }, raw => { raw.commands = ['npm test']; }, raw => { raw.roleDefinitions = []; }, raw => { raw.tasks[0].command = 'node app'; }, raw => { raw.routes[0].path = 'https://external.invalid/'; },
    raw => { raw.tasks[0].requirementIds = ['UNKNOWN']; }, raw => { raw.routes[0].roles = ['admin']; }, raw => { raw.tasks[1].dependsOn = []; }, raw => { raw.tasks[1].writePaths = ['package.json']; }, raw => { raw.tasks[0].acceptance = []; }]) {
    const raw = proposal(); mutate(raw); let calls = 0, receipt;
    await assert.rejects(createEngineeringModel({ config, fetchImpl: async () => { calls++; return reply(raw); } })({ ...input(), onReceipt: value => { receipt = value; } }), { code: 'invalid_model_response' });
    assert.equal(calls, 1); assert.equal(receipt.content, JSON.stringify(raw));
  }
});

test('malformed, missing and blank proposals preserve four receipt fields and known usage before format rejection', async () => {
  for (const content of [null, undefined, '', ' \n\t ', '```json\n{}\n```', '{"version":', '{}', '[]']) {
    let receipt;
    await assert.rejects(createEngineeringModel({ config, fetchImpl: async () => envelope(content, { usage: { prompt_tokens: 0, completion_tokens: 'bad' } }) })({ ...input(), onReceipt: value => { receipt = value; } }), { code: 'invalid_model_response' });
    assert.deepEqual(receipt, { model: config.model, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: null }, content: typeof content === 'string' ? content : '' });
  }
});

test('normal escaped JSON remains unchanged in the receipt and still produces the validated frozen proposal', async () => {
  const content = JSON.stringify(proposal()).replaceAll('title', '\\u0074itle'); let receipt;
  const result = await createEngineeringModel({ config, fetchImpl: async () => envelope(content) })({ ...input(), onReceipt: value => { receipt = value; } });
  assert.equal(receipt.content, content); assert.equal(result.proposal.title, proposal().title); assert.equal(result.coverage, 'structural_only');
});

test('unknown and non-stop finish metadata is bounded to enums and cannot become format retries', async () => {
  for (const finishReason of ['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', config.apiKey, null, {}]) {
    let receipt; await assert.rejects(createEngineeringModel({ config, fetchImpl: async () => envelope(JSON.stringify(proposal()), { finishReason }) })({ ...input(), onReceipt: value => { receipt = value; } }), error => error.code === 'abnormal_finish' && masked(error));
    assert.ok(['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'unknown'].includes(receipt.finishReason)); assert.equal(JSON.stringify(receipt).includes(config.apiKey), false);
  }
});

test('credential guard precedes parsing duplicate/malformed/stray-quote JSON and preserves usage without format retry', async () => {
  const escaped = config.apiKey.split('').map(letter => '\\u' + letter.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const raw = proposal(); raw.title = config.apiKey;
  const encoded = JSON.stringify(raw).replaceAll(config.apiKey, escaped), duplicate = JSON.stringify(proposal()).replace('"title":"资源预约设计"', `"title":"${escaped}","title":"资源预约设计"`);
  for (const content of [JSON.stringify(raw), encoded, duplicate, '"' + encoded, `{"title":"${escaped}",`]) for (const finishReason of ['stop', 'length', config.apiKey]) {
    let receipt, calls = 0; const model = createEngineeringModel({ config, fetchImpl: async () => { calls++; return envelope(content, { finishReason, usage: { prompt_tokens: 5, completion_tokens: 7 } }); } });
    await assert.rejects(model({ ...input(), onReceipt: value => { receipt = value; } }), error => error.code === 'credential_response' && masked(error));
    assert.equal(calls, 1); assert.equal(JSON.parse(JSON.stringify(receipt)).content, '[REDACTED]'); assert.deepEqual(receipt.usage, { inputTokens: 5, outputTokens: 7 }); assert.equal(receipt.finishReason, finishReason === config.apiKey ? 'unknown' : finishReason);
    await assert.rejects(model(input()), { code: 'credential_response' }); assert.equal(calls, 2);
  }
});

test('transport, HTTP, envelope and response read failures hide all underlying private text', async () => {
  const secret = config.apiKey + ' https://private.invalid/';
  for (const fetchImpl of [async () => { throw new Error(secret); }, async () => new Response(secret, { status: 401 }), async () => new Response(secret), async () => reply(undefined, { error: { message: secret } }), async () => new Response('[]'),
    async () => ({ ok: true, body: null }), async () => ({ ok: true, body: { getReader() { throw new Error(secret); } } }), async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } }))]) {
    let receipts = 0; await assert.rejects(createEngineeringModel({ config, fetchImpl })({ ...input(), onReceipt: () => { receipts++; } }), masked); assert.equal(receipts, 0);
  }
});

test('actual response stream has a 256KiB budget and invalid UTF8 cannot enter a receipt', async () => {
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(140 * 1024).fill(97)); }, cancel() { cancelled = true; } });
  await assert.rejects(createEngineeringModel({ config, fetchImpl: async () => new Response(stream, { headers: { 'Content-Length': '1' } }) })(input()), { code: 'response_too_large' }); assert.equal(cancelled, true); assert.ok(pulls <= 3);
  await assert.rejects(createEngineeringModel({ config, fetchImpl: async () => new Response(new Uint8Array([0xc3, 0x28])) })(input()), masked);
});

test('receipt save failures fail closed without exposing callback errors or making another request', async () => {
  let calls = 0; await assert.rejects(createEngineeringModel({ config, fetchImpl: async () => { calls++; return reply(); } })({ ...input(), onReceipt: () => { throw new Error(config.apiKey + ' https://private.invalid/'); } }), error => error.code === 'receipt_failed' && masked(error)); assert.equal(calls, 1);
});

test('abort before/during fetch or response reads suppresses output and closes late response bodies', async () => {
  const before = new AbortController(); before.abort(config.apiKey); let calls = 0;
  await assert.rejects(createEngineeringModel({ config, fetchImpl: async () => { calls++; return reply(); } })({ ...input(), signal: before.signal }), { name: 'AbortError' }); assert.equal(calls, 0);
  let entered, release, receipts = 0, cancelled = false; const started = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
  const pending = createEngineeringModel({ config, fetchImpl: async () => { entered(); return new Promise(resolve => { release = resolve; }); } })({ ...input(), signal: controller.signal, onReceipt: () => { receipts++; } });
  await started; controller.abort(config.apiKey); await assert.rejects(pending, { name: 'AbortError' }); release({ ok: true, body: { cancel: async () => { cancelled = true; } } }); await tick(); assert.equal(cancelled, true); assert.equal(receipts, 0);
  let reading, closed = false; const readStarted = new Promise(resolve => { reading = resolve; }), during = new AbortController();
  const stream = new ReadableStream({ cancel() { closed = true; } });
  const read = createEngineeringModel({ config, fetchImpl: async () => ({ ok: true, body: { getReader() {
    const reader = stream.getReader(); return { read() { reading(); return reader.read(); }, cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock() };
  } } }) })({ ...input(), signal: during.signal });
  await readStarted; during.abort(); await assert.rejects(read, { name: 'AbortError' }); assert.equal(closed, true);
});

test('bounded deadlines cover fetch, custom reader and receipt even when they ignore cancellation', async () => {
  for (const stage of ['fetch', 'reader', 'receipt']) {
    let calls = 0;
    const model = createEngineeringModel({ config: { ...config, timeoutMs: 30 }, fetchImpl: async () => { calls++; if (stage === 'fetch') return new Promise(() => {}); if (stage === 'reader') return { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }) } }; return reply(); } });
    await assert.rejects(model({ ...input(), onReceipt: stage === 'receipt' ? () => new Promise(() => {}) : undefined }), { code: 'model_timeout', name: 'TimeoutError' }); assert.equal(calls, 1);
  }
});

test('elapsed time and pending-receipt cancellation are checked before draft publication', async t => {
  const now = Date.now.bind(Date); let offset = 0; t.mock.method(Date, 'now', () => now() + offset);
  await assert.rejects(createEngineeringModel({ config: { ...config, timeoutMs: 1000 }, fetchImpl: async () => reply() })({ ...input(), onReceipt: () => { offset = 2000; } }), { name: 'TimeoutError' }); offset = 0;
  let entered, release, published = false; const started = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
  const pending = createEngineeringModel({ config, fetchImpl: async () => reply() })({ ...input(), signal: controller.signal, onReceipt: async () => { entered(); await new Promise(resolve => { release = resolve; }); } }).then(value => { published = true; return value; });
  await started; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); release(); await tick(); assert.equal(published, false);
});

test('model policy follows the fixed guard implementation/version and engineering validator policy', async () => {
  async function policy(version, guardHash, planHash) {
    const script = `import {mock} from 'node:test';const plan=await import(${JSON.stringify(new URL('../lib/engineering-plan.mjs', import.meta.url).href)});mock.module(${JSON.stringify(new URL('../lib/engineering-plan.mjs', import.meta.url).href)},{namedExports:{...plan,engineeringPlanPolicy:{hash:${JSON.stringify(planHash)}}}});mock.module(${JSON.stringify(new URL('../lib/model-content-guard.mjs', import.meta.url).href)},{namedExports:{guardModelContent:()=>{throw new Error('not called')},modelContentGuardPolicy:{version:${JSON.stringify(version)},hash:${JSON.stringify(guardHash)}}}});const{engineeringModelPolicy}=await import(${JSON.stringify(new URL('../lib/engineering-model.mjs', import.meta.url).href)});process.stdout.write(engineeringModelPolicy.hash);`;
    return new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', errors = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('trusted policy probe timed out')); }, 10000); child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; }); child.once('error', reject); child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(errors)); }); child.stdin.end(script); });
  }
  const values = await Promise.all([policy('v2', 'a'.repeat(64), 'c'.repeat(64)), policy('v3', 'a'.repeat(64), 'c'.repeat(64)), policy('v2', 'b'.repeat(64), 'c'.repeat(64)), policy('v2', 'a'.repeat(64), 'd'.repeat(64))]);
  for (const value of values) assert.match(value, /^[a-f0-9]{64}$/u); assert.equal(new Set(values).size, 4);
});
