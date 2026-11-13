import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationModel, verificationModelPolicy } from '../lib/verification-model.mjs';
import { assertCompiledManifest, compileManifest, createVerificationControl, inspectVerificationProposal } from '../lib/verification-contract.mjs';

const config = { baseUrl: 'https://model.invalid/v1', model: 'independent-verification', apiKey: 'private-verification-key' };
const binding = { projectId: 'project', runId: 'run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
function input() { return { task: { title: 'Generic resource API', constraints: ['Use the confirmed engineering API'] },
  requirements: [{ id: 'REQ1', text: 'Read a resource identifier' }, { id: 'REQ2', text: 'Submit that identifier' }],
  engineeringContract: { routes: ['GET /objects', 'POST /objects/:id'], responseType: 'application/json' }, binding: { ...binding } }; }
function proposal() { return { version: 1, id: 'generic-resource', name: 'Resource HTTP contract', sessions: ['reader', 'writer'], steps: [
  { id: 'read', type: 'request', dependsOn: [], requirementIds: ['REQ1'], request: { id: 'get', method: 'GET', path: '/objects', session: 'reader',
    assertions: [{ id: 'read_status', op: 'status', value: 200 }, { id: 'id_exists', op: 'jsonExists', path: '$.id' }], captures: [{ name: 'objectId', path: '$.id' }] } },
  { id: 'submit', type: 'request', dependsOn: ['read'], requirementIds: ['REQ2'], request: { id: 'post', method: 'POST', path: '/objects/${objectId}', session: 'writer', body: { id: { $var: 'objectId' } },
    assertions: [{ id: 'submitted', op: 'status', value: 201 }] } },
] }; }
function reply(raw = proposal(), extra = {}) { return envelope(JSON.stringify(raw), extra); }
function envelope(content, { finishReason = 'stop', ...extra } = {}) { return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }], ...extra })); }
async function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await callback(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const masked = error => { assert.equal(error.cause, undefined); assert.ok(!error.message.includes(config.apiKey)); assert.ok(!error.message.includes('private.invalid')); return true; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one independent request receives only frozen spec/API data and returns unapproved structural proposal', async () => {
  await withEnv({ LLM_JSON_MODE: '1', LLM_THINKING: 'disabled', LLM_MAX_TOKENS: '999999' }, async () => {
    const original = input(); let calls = 0, receipt;
    const result = await createVerificationModel({ config, fetchImpl: async (url, options) => {
      calls++; assert.equal(String(url), config.baseUrl + '/chat/completions'); assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      const body = JSON.parse(options.body); assert.equal(body.max_tokens, 8192); assert.deepEqual(body.response_format, { type: 'json_object' }); assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(JSON.parse(body.messages[1].content), original); assert.equal(options.body.includes(config.apiKey), false);
      assert.ok(Buffer.byteLength(options.body) <= verificationModelPolicy.requestBytes);
      for (const required of ['结构意义', '编码前', 'requirements', 'engineeringContract', 'concurrent', 'restart', 'jsonEquals', '$var', 'Shell', 'SQL', '4096', '200']) assert.ok(body.messages[0].content.includes(required), required);
      assert.equal(Object.hasOwn(options, 'onReceipt'), false);
      return reply(undefined, { usage: { prompt_tokens: 31, completion_tokens: 42 }, model: 'untrusted-provider-name' });
    } })({ ...original, onReceipt: value => { receipt = value; } });
    assert.equal(calls, 1); assert.deepEqual(result, { proposal: proposal(), model: config.model, usage: { inputTokens: 31, outputTokens: 42 }, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' });
    assert.deepEqual(Object.keys(receipt), ['model', 'finishReason', 'usage', 'content']); assert.equal(receipt.model, config.model); assert.equal(receipt.finishReason, 'stop');
    assert.equal(receipt.content, JSON.stringify(proposal())); assert.equal(Object.hasOwn(result, 'passed'), false); assert.equal(Object.hasOwn(result, 'approval'), false);
    assert.throws(() => assertCompiledManifest(result.proposal, binding), /可信/u);
    assert.match(result.policyHash, /^[a-f0-9]{64}$/u);
  });
});

test('pure inspection exports ordinary definitions without granting approval or execution brands', () => {
  const raw = proposal(), args = { proposal: raw, requirements: ['REQ1', 'REQ2'], binding };
  const definition = inspectVerificationProposal(args); assert.equal(Object.getPrototypeOf(definition), Object.prototype);
  assert.throws(() => assertCompiledManifest(definition, binding), /可信/u); assert.throws(() => compileManifest({ ...args, approval: definition }), /可信/u);
  raw.steps[0].request.path = '/changed'; assert.equal(definition.steps[0].request.path, '/objects');
  const control = createVerificationControl(), approval = control.approve({ ...args, proposal: proposal() });
  const manifest = compileManifest({ ...args, proposal: proposal(), approval });
  assert.throws(() => assertCompiledManifest(manifest, binding), /编码阶段/u); control.beginCoding(approval); assert.equal(assertCompiledManifest(manifest, binding), manifest);
});

test('caller edits and receipt mutations never change the frozen request, validation inputs or output usage', async () => {
  const original = input(), expected = structuredClone(original), settings = { ...config }; let calls = 0;
  const model = createVerificationModel({ config: settings, fetchImpl: async (_url, options) => {
    calls++; assert.deepEqual(JSON.parse(JSON.parse(options.body).messages[1].content), expected);
    original.task.title = 'changed'; original.engineeringContract.routes = []; original.requirements[0].id = 'CHANGED'; original.binding.planRevision = 'd'.repeat(64);
    return reply(undefined, { usage: { prompt_tokens: 3, completion_tokens: 4 } });
  } });
  settings.model = 'caller-edited-config';
  const sink = receipt => { receipt.model = 'changed'; receipt.content = '{}'; receipt.usage.inputTokens = 999; };
  sink.toJSON = () => assert.fail('receipt function must not be serialized');
  const result = await model({ ...original, onReceipt: sink }); assert.equal(calls, 1); assert.equal(result.model, config.model); assert.deepEqual(result.proposal, proposal()); assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 });
});

test('getters, toJSON, cycles, custom arrays, symbols and non-JSON inputs are rejected before any request', async () => {
  let calls = 0, invoked = 0;
  const model = createVerificationModel({ config, fetchImpl: async () => { calls++; return reply(); } });
  const top = input(); Object.defineProperty(top, 'task', { enumerable: true, get() { invoked++; return 'bad'; } });
  const nested = input(); Object.defineProperty(nested.task, 'hidden', { enumerable: true, get() { invoked++; return 'bad'; } });
  const req = input(); Object.defineProperty(req.requirements[0], 'text', { enumerable: true, get() { invoked++; return 'bad'; } });
  const toJSON = input(); toJSON.task.toJSON = () => { invoked++; return 'bad'; };
  const method = input(); Object.defineProperty(method.requirements, 'map', { value() { invoked++; return []; } });
  const prototype = input(); Object.setPrototypeOf(prototype.requirements, { map() { invoked++; return []; } });
  const cycle = input(); cycle.task.self = cycle.task;
  const symbol = input(); symbol.task[Symbol('hidden')] = 'not data';
  const sparse = input(); delete sparse.requirements[0];
  for (const value of [top, nested, req, toJSON, method, prototype, cycle, symbol, sparse, undefined, null, []]) await assert.rejects(model(value));
  const factory = {}; Object.defineProperty(factory, 'config', { enumerable: true, get() { invoked++; return config; } }); assert.throws(() => createVerificationModel(factory));
  assert.throws(() => createVerificationModel({ config, fetchImpl: null })); assert.throws(() => createVerificationModel({ config: null }));
  assert.equal(calls, 0); assert.equal(invoked, 0);
});

test('context types, bounds, bindings and forbidden candidate/results fields fail before sending', async () => {
  let calls = 0; const model = createVerificationModel({ config, fetchImpl: async () => { calls++; return reply(); } });
  const mutations = [value => { value.task = ''; }, value => { value.engineeringContract = {}; }, value => { value.task = []; }, value => { value.requirements = []; },
    value => { value.requirements.push(value.requirements[0]); }, value => { value.requirements[0].text = ''; }, value => { value.requirements[0].id = true; }, value => { value.requirements[0].extra = 'not allowed'; },
    value => { value.binding.specRevision = 'old'; }, value => { value.task.n = Infinity; }, value => { value.task.n = NaN; }, value => { value.task.text = '\ud800'; },
    value => { value.task.text = 'x'.repeat(128 * 1024); }, value => { value.requirements[0].text = 'x'.repeat(8193); }, value => { value.task.rows = Array(2001).fill(1); },
    value => { value.task.n = {}; let current = value.task.n; for (let i = 0; i < 17; i++) current = current.next = {}; },
    ...['files', 'code', 'testResults', 'passed', 'approval', 'candidate'].map(key => value => { value[key] = 'must not be sent'; })];
  for (const mutate of mutations) { const value = input(); mutate(value); await assert.rejects(model(value), masked); }
  for (const signal of [null, {}, false]) await assert.rejects(model({ ...input(), signal }), masked);
  await assert.rejects(model({ ...input(), onReceipt: true }), { code: 'receipt_failed' }); assert.equal(calls, 0);
});

test('existing DSL rejects unknown fields, paths, commands, passed, coverage, dependencies and coerced variables', async () => {
  const mutations = [raw => { raw.passed = true; }, raw => { raw.approved = true; }, raw => { raw.commands = ['echo done']; }, raw => { raw.binding = binding; },
    raw => { raw.steps[0].request.headers = { authorization: 'forged' }; }, raw => { raw.steps[0].request.sql = 'SELECT 1'; }, raw => { raw.steps[0].request.script = 'eval()'; },
    raw => { raw.steps[0].request.path = 'https://external.invalid/'; }, raw => { raw.steps[0].request.path = '/%2f%2fexternal.invalid'; }, raw => { raw.steps[0].request.assertions = []; },
    raw => { raw.steps[1].requirementIds = ['REQ1']; }, raw => { raw.steps[1].requirementIds = ['UNKNOWN']; }, raw => { raw.steps[1].dependsOn = []; }, raw => { raw.steps[0].dependsOn = ['submit']; },
    raw => { raw.steps[0].request.captures[0].name = true; }, raw => { raw.steps[1].request.body.id.$var = true; }];
  for (const mutate of mutations) {
    const raw = proposal(); mutate(raw); let calls = 0, receipts = 0;
    await assert.rejects(createVerificationModel({ config, fetchImpl: async () => { calls++; return reply(raw); } })({ ...input(), onReceipt: () => { receipts++; } }), { code: 'invalid_model_response' });
    assert.equal(calls, 1); assert.equal(receipts, 1);
  }
  const numeric = proposal(); numeric.steps[1].request.body = { amount: 13 }; const overflow = JSON.stringify(numeric).replace('"amount":13', '"amount":1e400');
  await assert.rejects(createVerificationModel({ config, fetchImpl: async () => envelope(overflow) })(input()), { code: 'invalid_model_response' });
});

test('malformed, blank and nontext proposals retain four-field receipts and known usage before rejection', async () => {
  for (const content of ['{"version":', ' \n\t ', '', '```json\n{}\n```', null, undefined, '{}', '[]']) {
    let receipt;
    await assert.rejects(createVerificationModel({ config, fetchImpl: async () => envelope(content, { usage: { prompt_tokens: 0, completion_tokens: 'bad' } }) })({ ...input(), onReceipt: value => { receipt = value; } }), { code: 'invalid_model_response' });
    assert.deepEqual(receipt, { model: config.model, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: null }, content: typeof content === 'string' ? content : '' });
  }
});

test('finish whitelist produces only safe enums; truncation, unknown and non-stop outcomes never yield proposals', async () => {
  for (const finishReason of ['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', config.apiKey, 1, null, {}]) {
    let receipt;
    await assert.rejects(createVerificationModel({ config, fetchImpl: async () => envelope(JSON.stringify(proposal()), { finishReason }) })({ ...input(), onReceipt: value => { receipt = value; } }), error => error.code === 'abnormal_finish' && masked(error));
    assert.ok(['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'unknown'].includes(receipt.finishReason));
    assert.ok(!JSON.stringify(receipt).includes(config.apiKey));
  }
});

test('default LLM settings are reused while unknown/invalid token usage stays null and fixed limits ignore env overrides', async () => {
  await withEnv({ LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey, LLM_JSON_MODE: '0', LLM_THINKING: '', LLM_MAX_TOKENS: '1' }, async () => {
    const result = await createVerificationModel({ fetchImpl: async (_url, options) => { const body = JSON.parse(options.body); assert.equal(body.max_tokens, 8192); assert.equal('response_format' in body, false); assert.equal('thinking' in body, false); return reply(); } })(input());
    assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
  });
  for (const usage of [{}, { prompt_tokens: -1, completion_tokens: 1.5 }, { prompt_tokens: '7', completion_tokens: Infinity }, { prompt_tokens: 0, completion_tokens: 9 }, { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: null }]) {
    const result = await createVerificationModel({ config, fetchImpl: async () => reply(undefined, { usage }) })(input());
    assert.deepEqual(result.usage, { inputTokens: Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null, outputTokens: Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null });
  }
});

test('invalid config and injected configured credentials in task/model are rejected without a request', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return reply(); };
  for (const change of [{ baseUrl: 'file:///private.invalid' }, { baseUrl: 'bad ' + config.apiKey }, { baseUrl: 'https://user:pass@private.invalid/' }, { baseUrl: 'https://private.invalid/?x=1' }, { baseUrl: 'https://private.invalid/#hash' }, { model: '' }, { model: config.apiKey }, { apiKey: 1 }, { timeoutMs: 0 }, { timeoutMs: null }, { timeoutMs: 120001 }]) await assert.rejects(createVerificationModel({ config: { ...config, ...change }, fetchImpl })(input()), masked);
  const value = input(); value.task.secret = config.apiKey; await assert.rejects(createVerificationModel({ config, fetchImpl })(value), masked);
  await withEnv({ LLM_THINKING: config.apiKey }, async () => { await assert.rejects(createVerificationModel({ config, fetchImpl })(input()), masked); });
  assert.equal(calls, 0);
});

test('HTTP, connection, envelope and stream errors never expose private transport data or create fake receipts', async () => {
  const secret = config.apiKey + ' https://private.invalid/';
  const fetchers = [async () => { throw new Error(secret); }, async () => new Response(secret, { status: 401 }), async () => new Response(secret),
    async () => reply(undefined, { error: { message: secret } }), async () => new Response('[]'), async () => new Response('{"choices":'),
    async () => ({ ok: true, body: null }), async () => ({ ok: true, body: { getReader() { throw new Error(secret); } } }),
    async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } }))];
  for (const fetchImpl of fetchers) { let receipts = 0; await assert.rejects(createVerificationModel({ config, fetchImpl })({ ...input(), onReceipt: () => { receipts++; } }), masked); assert.equal(receipts, 0); }
});

test('actual response bytes have a 256KiB cap regardless of Content-Length and malformed UTF8 is masked', async () => {
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(140 * 1024).fill(97)); }, cancel() { cancelled = true; } });
  await assert.rejects(createVerificationModel({ config, fetchImpl: async () => new Response(stream, { headers: { 'Content-Length': '1' } }) })(input()), { code: 'response_too_large' });
  assert.equal(cancelled, true); assert.ok(pulls <= 3);
  await assert.rejects(createVerificationModel({ config, fetchImpl: async () => new Response(new Uint8Array([0xc3, 0x28])) })(input()), masked);
});

test('configured credential echoes are redacted and rejected including JSON unicode escapes and repeated keys', async () => {
  const literal = proposal(); literal.name = config.apiKey + config.apiKey;
  const escapedKey = [...config.apiKey].map(letter => '\\u' + letter.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const encoded = JSON.stringify(literal).replaceAll(config.apiKey, escapedKey), mixed = JSON.stringify(literal).replace(config.apiKey, escapedKey);
  for (const content of [JSON.stringify(literal), encoded, mixed]) {
    let receipt;
    await assert.rejects(createVerificationModel({ config, fetchImpl: async () => envelope(content) })({ ...input(), onReceipt: value => { receipt = value; } }), { code: 'credential_response' });
    assert.equal(receipt.content.includes(config.apiKey), false); assert.equal(receipt.content.includes(escapedKey), false); assert.match(receipt.content, /REDACTED/u);
    await assert.rejects(createVerificationModel({ config, fetchImpl: async () => envelope(content) })(input()), { code: 'credential_response' });
  }
  let bounded;
  await assert.rejects(createVerificationModel({ config: { ...config, apiKey: '~' }, fetchImpl: async () => envelope('~'.repeat(70000)) })({ ...input(), onReceipt: value => { bounded = value; } }), { code: 'credential_response' });
  assert.ok(Buffer.byteLength(bounded.content) <= verificationModelPolicy.responseBytes); assert.equal(bounded.content.includes('~'), false);
});

test('receipt failures remain private and do not become valid proposals or retries', async () => {
  let calls = 0;
  const model = createVerificationModel({ config, fetchImpl: async () => { calls++; return reply(); } });
  await assert.rejects(model({ ...input(), onReceipt: () => { throw new Error(config.apiKey + ' https://private.invalid/'); } }), error => error.code === 'receipt_failed' && masked(error));
  assert.equal(calls, 1);
});

test('pre-abort and cancellation during fetch reject promptly without leaking the reason', async () => {
  let calls = 0; const before = new AbortController(); before.abort(config.apiKey);
  await assert.rejects(createVerificationModel({ config, fetchImpl: async () => { calls++; return reply(); } })({ ...input(), signal: before.signal }), { name: 'AbortError', message: '测试提案模型请求已取消。' }); assert.equal(calls, 0);
  const during = new AbortController();
  const pending = createVerificationModel({ config, fetchImpl: async () => { calls++; queueMicrotask(() => during.abort(config.apiKey)); return new Promise(() => {}); } })({ ...input(), signal: during.signal });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1);
});

test('cancellation closes pending response reads and prevents late fetch receipts or proposals', async () => {
  let reading, cancelled = false;
  const started = new Promise(resolve => { reading = resolve; }), controller = new AbortController();
  const stream = new ReadableStream({ pull() { reading(); }, cancel() { cancelled = true; } });
  const pending = createVerificationModel({ config, fetchImpl: async () => new Response(stream) })({ ...input(), signal: controller.signal });
  await started; controller.abort(config.apiKey); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, true);
  let release, entered, receiptCalls = 0, lateCancelled = false;
  const enteredFetch = new Promise(resolve => { entered = resolve; }), late = new AbortController();
  const later = createVerificationModel({ config, fetchImpl: () => { entered(); return new Promise(resolve => { release = resolve; }); } })({ ...input(), signal: late.signal, onReceipt: () => { receiptCalls++; } });
  await enteredFetch; late.abort(); await assert.rejects(later, { name: 'AbortError' });
  release({ ok: true, body: { cancel: async () => { lateCancelled = true; } } }); await tick(); assert.equal(lateCancelled, true); assert.equal(receiptCalls, 0);
});

test('bounded deadlines cover noncooperative fetch, response reader and receipt sink without automatic retries', async () => {
  for (const stage of ['fetch', 'reader', 'receipt']) {
    let calls = 0; const start = Date.now();
    const model = createVerificationModel({ config: { ...config, timeoutMs: 30 }, fetchImpl: async () => {
      calls++; if (stage === 'fetch') return new Promise(() => {});
      if (stage === 'reader') return { ok: true, body: { getReader() { return { read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }; } } };
      return reply();
    } });
    await assert.rejects(model({ ...input(), onReceipt: stage === 'receipt' ? () => new Promise(() => {}) : undefined }), { name: 'TimeoutError', code: 'model_timeout' });
    assert.equal(calls, 1); assert.ok(Date.now() - start < 1500);
  }
});

test('elapsed deadline is checked before publication even before the timer callback can run', async t => {
  const now = Date.now.bind(Date); let offset = 0;
  t.mock.method(Date, 'now', () => now() + offset);
  const model = createVerificationModel({ config: { ...config, timeoutMs: 1000 }, fetchImpl: async () => reply() });
  await assert.rejects(model({ ...input(), onReceipt: () => { offset = 2000; } }), { code: 'model_timeout', name: 'TimeoutError' });
});

test('cancelling a pending receipt never publishes a proposal when the sink later completes', async () => {
  let entered, release, published = false;
  const started = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
  const pending = createVerificationModel({ config, fetchImpl: async () => reply() })({ ...input(), signal: controller.signal, onReceipt: async () => { entered(); await new Promise(resolve => { release = resolve; }); } }).then(value => { published = true; return value; });
  await started; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); release(); await tick(); assert.equal(published, false);
});
