import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { analyzeWithModel, renderSpec } from '../lib/planner.mjs';
import { modelContentGuardPolicy } from '../lib/model-content-guard.mjs';

const source = '用户可以读取资源。';
const config = { baseUrl: 'https://model.invalid/v1', model: 'specification-test', apiKey: 'synthetic-specification-key-not-real' };
const fakeSpec = () => ({ title: '资源读取', summary: '读取资源', goals: ['查看资源'], roles: [], acceptanceScenarios: [],
  requirements: [{ title: '读取', description: source, acceptance: ['返回资源列表'], sourceQuote: source, kind: 'functional' }],
  constraints: [], assumptions: [], questions: [], stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' } });
const contentOf = value => typeof value === 'string' ? value : JSON.stringify(value);
function response(content = fakeSpec(), finish = 'stop', usage) { return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: contentOf(content) } }], usage })); }
const invoke = (options = {}, text = source, name = '资源') => analyzeWithModel(text, name, { config, fetchImpl: async () => response(), ...options });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hidden = error => { assert.equal(error.cause, undefined); assert.equal(error.message.includes(config.apiKey), false); assert.equal(error.message.includes('private.invalid'), false); return true; };
async function rejectsCode(promise, code) { await assert.rejects(promise, error => { hidden(error); assert.equal(error.code, code); return true; }); }
async function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await callback(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('stop preserves raw/fenced JSON compatibility, source quotes and the public Spec-only shape', async () => {
  for (const wrap of [value => value, value => '```json\n' + value + '\n```', value => '  ```JSON\n' + value + '\n```  ']) {
    let receipt, requests = 0;
    const spec = await invoke({ fetchImpl: async (url, options) => {
      requests++; assert.equal(String(url), config.baseUrl + '/chat/completions'); assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      const body = JSON.parse(options.body); assert.equal(body.model, config.model); assert.equal(options.body.includes(config.apiKey), false);
      assert.ok(Buffer.byteLength(options.body) <= 768 * 1024); assert.equal(JSON.parse(body.messages[1].content).document, source);
      return response(wrap(JSON.stringify(fakeSpec())), 'stop', { prompt_tokens: 8, completion_tokens: 13 });
    }, onReceipt: value => { receipt = value; } });
    assert.equal(requests, 1); assert.equal(spec.sourceMode, 'model'); assert.equal(spec.requirements[0].sourceQuote, source);
    assert.deepEqual(Object.keys(receipt), ['model', 'finishReason', 'usage', 'content']); assert.equal(receipt.content, wrap(JSON.stringify(fakeSpec())));
    assert.deepEqual(receipt.usage, { inputTokens: 8, outputTokens: 13 }); assert.equal(receipt.finishReason, 'stop');
    for (const field of ['usage', 'content', 'apiKey', 'receipt', 'model', 'finishReason']) assert.equal(Object.hasOwn(spec, field), false);
    assert.equal(renderSpec(spec).includes(config.apiKey), false);
  }
});

test('only stop can pass; all known non-stop, missing and unexpected reasons preserve bounded receipt enums', async () => {
  for (const reason of ['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'private.invalid', null, true]) {
    let receipt, calls = 0;
    await rejectsCode(invoke({ fetchImpl: async () => { calls++; return response(fakeSpec(), reason); }, onReceipt: value => { receipt = value; } }), 'abnormal_finish');
    assert.equal(calls, 1); assert.equal(receipt.finishReason, ['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource'].includes(reason) ? reason : 'unknown');
  }
  let missing;
  await rejectsCode(invoke({ fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeSpec()) } }] })), onReceipt: value => { missing = value; } }), 'abnormal_finish');
  assert.equal(missing.finishReason, 'unknown');
});

test('literal/escaped credentials, duplicate keys and malformed/stray prefixes are guarded before parsing and abnormal finish', async () => {
  assert.equal(modelContentGuardPolicy.version, 'json-escape-credential-v2');
  const key = config.apiKey, encoded = [...key].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const raw = JSON.stringify(fakeSpec()), echo = raw.replace('读取资源', key), escaped = raw.replace('读取资源', encoded);
  const variants = [echo, escaped, `{"summary":"${encoded}",${raw.slice(1)}`, `{"ignored":"${encoded}",`, '"' + escaped, escaped + '"'];
  for (const content of variants) for (const finish of ['stop', 'length']) for (const hook of [false, true]) {
    let receipt, calls = 0;
    await rejectsCode(invoke({ fetchImpl: async () => { calls++; return response(content, finish, { prompt_tokens: 9, completion_tokens: 11 }); }, ...(hook ? { onReceipt: value => { receipt = value; } } : {}) }), 'credential_response');
    assert.equal(calls, 1);
    if (hook) { assert.equal(receipt.content.includes(key), false); assert.equal(receipt.content.includes('\\u0073'), false); assert.notEqual(receipt.content, content); assert.equal(receipt.finishReason, finish); assert.deepEqual(receipt.usage, { inputTokens: 9, outputTokens: 11 }); }
  }
});

test('known input credentials are rejected without sending or mutating source, project or model', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; assert.fail('must not send credentials in prompts'); };
  const encoded = [...config.apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  for (const key of [config.apiKey, encoded]) {
    await rejectsCode(invoke({ fetchImpl }, source + key), 'invalid_input');
    await rejectsCode(invoke({ fetchImpl }, source, '项目' + key), 'invalid_input');
    await rejectsCode(invoke({ fetchImpl, config: { ...config, model: key } }), 'invalid_input');
  }
  assert.equal(calls, 0); assert.equal(source, '用户可以读取资源。');
});

test('slash-escaped configured credentials are also refused before any Spec is returned', async () => {
  const apiKey = 'synthetic/specification/key'; let receipt;
  const echoed = fakeSpec(); echoed.summary = apiKey;
  await rejectsCode(invoke({ config: { ...config, apiKey }, fetchImpl: async () => response(JSON.stringify(echoed).replaceAll('/', '\\/')), onReceipt: value => { receipt = value; } }), 'credential_response');
  assert.equal(receipt.content.includes(apiKey), false); assert.equal(receipt.content.includes('synthetic'), false);
});

test('config/options are snapshotted before await and receipt callback mutations cannot change the Spec', async () => {
  const gate = deferred(), settings = { ...config }; let received = 0;
  const options = { config: settings, timeoutMs: 5000, onReceipt: value => { received++; value.content = '{}'; value.model = 'mutated'; value.usage.inputTokens = 999; }, fetchImpl: async (_url, request) => {
    assert.equal(JSON.parse(request.body).model, config.model); assert.equal(request.headers.Authorization, `Bearer ${config.apiKey}`); await gate.promise; return response();
  } };
  const pending = analyzeWithModel(source, '资源', options);
  settings.model = 'changed'; settings.apiKey = 'changed'; options.timeoutMs = 1; options.fetchImpl = () => assert.fail('must not use new function'); options.onReceipt = () => assert.fail('must not use replacement');
  gate.resolve(); const result = await pending; assert.equal(received, 1); assert.equal(result.title, fakeSpec().title); assert.equal(result.summary, fakeSpec().summary);
});

test('input/config/option getters, symbols, extra fields and wrong prototypes are rejected without execution', async () => {
  let getters = 0, calls = 0;
  for (const key of ['config', 'fetchImpl', 'signal', 'timeoutMs', 'onReceipt']) {
    const options = { config, fetchImpl: async () => { calls++; return response(); } }; Object.defineProperty(options, key, { enumerable: true, get() { getters++; return config; } }); await assert.rejects(analyzeWithModel(source, '资源', options));
  }
  for (const key of ['baseUrl', 'model', 'apiKey']) { const settings = { ...config }; Object.defineProperty(settings, key, { enumerable: true, get() { getters++; return config[key]; } }); await assert.rejects(invoke({ config: settings })); }
  const toJSON = { get toJSON() { getters++; return () => ({}); } };
  for (const settings of [null, [], Object.assign(Object.create({}), config), { ...config, extra: toJSON }, { ...config, [Symbol('x')]: 1 }]) await assert.rejects(invoke({ config: settings }));
  const hidden = { ...config }; Object.defineProperty(hidden, 'apiKey', { value: config.apiKey, enumerable: false }); await assert.rejects(invoke({ config: hidden }));
  await assert.rejects(invoke({ extra: true })); await assert.rejects(invoke({ [Symbol('x')]: 1 }));
  await assert.rejects(analyzeWithModel(toJSON, '资源', { config })); await assert.rejects(analyzeWithModel(source, toJSON, { config }));
  assert.equal(getters, 0); assert.equal(calls, 0);
});

test('raw source/project/config bounds and URL rules fail before network with fixed errors', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response(); };
  for (const value of ['', ' ', '\ud800', 'x'.repeat(100001), ' '.repeat(100000) + source, source + '\0']) await assert.rejects(invoke({ fetchImpl }, value), hidden);
  for (const value of [null, {}, '\ud800', 'x'.repeat(1001), '\0']) await assert.rejects(invoke({ fetchImpl }, source, value), hidden);
  for (const change of [{ baseUrl: 'file:///private.invalid' }, { baseUrl: 'ftp://private.invalid' }, { baseUrl: 'https://user:password@private.invalid' }, { baseUrl: 'https://private.invalid/?secret=x' }, { baseUrl: 'https://private.invalid/#secret' }, { baseUrl: '/relative' }, { baseUrl: 'x'.repeat(4097) }, { model: '' }, { model: {} }, { apiKey: 7 }, { apiKey: 'x'.repeat(4097) }, { model: 'x\r\nprivate.invalid' }]) await rejectsCode(invoke({ fetchImpl, config: { ...config, ...change } }), 'invalid_input');
  for (const timeoutMs of [null, NaN, Infinity, 0, -1, 120001, 1.5, '50']) await rejectsCode(invoke({ fetchImpl, timeoutMs }), 'invalid_input');
  for (const signal of [null, {}, false]) await rejectsCode(invoke({ fetchImpl, signal }), 'invalid_input');
  for (const onReceipt of [null, {}, false]) await rejectsCode(invoke({ fetchImpl, onReceipt }), 'receipt_failed');
  assert.equal(calls, 0);
});

test('exact source/name bounds and existing BOM/CRLF normalization remain valid', async () => {
  for (const [text, name, expected] of [[source + '汉'.repeat(100000 - source.length), '项'.repeat(1000), source + '汉'.repeat(100000 - source.length)], ['\uFEFF' + source + '\r\n  ', '资源', source]]) {
    const result = await invoke({ fetchImpl: async (_url, request) => { const body = JSON.parse(request.body); assert.equal(JSON.parse(body.messages[1].content).document, expected); assert.ok(Buffer.byteLength(request.body) <= 768 * 1024); return response(); } }, text, name);
    assert.equal(result.requirements[0].sourceQuote, source);
  }
});

test('existing LLM token/JSON/thinking configuration remains compatible, defaults never expose API key', async () => {
  await withEnv({ LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey, LLM_MAX_TOKENS: '393216', LLM_JSON_MODE: '0', LLM_THINKING: 'disabled', LLM_TIMEOUT_MS: 'not-a-number' }, async () => {
    let receipt; const result = await analyzeWithModel(source, '资源', { fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body); assert.equal(body.max_tokens, 393216); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(Object.hasOwn(body, 'response_format'), false); assert.equal(request.body.includes(config.apiKey), false); return response();
    }, onReceipt: value => { receipt = value; } }); assert.equal(result.sourceMode, 'model'); assert.equal(receipt.model, config.model);
  });
});

test('default LLM_TIMEOUT_MS keeps its existing 1000ms lower clamp while bounding noncooperative fetch', { timeout: 10000 }, async () => {
  await withEnv({ LLM_TIMEOUT_MS: '1' }, async () => {
    const late = deferred(); let cancelled = false;
    const started = Date.now();
    await rejectsCode(invoke({ fetchImpl: async () => { await late.promise; return { ok: true, body: { cancel: async () => { cancelled = true; } } }; } }), 'model_timeout');
    assert.ok(Date.now() - started >= 900); late.resolve(); await delay(10); assert.equal(cancelled, true);
  });
});

test('usage is exact nonnegative safe-integer or null and malformed output still saves a four-field receipt', async () => {
  for (const usage of [undefined, {}, { prompt_tokens: 0, completion_tokens: 7 }, { prompt_tokens: -1, completion_tokens: 2.5 }, { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: '8' }]) {
    let receipt; await invoke({ fetchImpl: async () => response(fakeSpec(), 'stop', usage), onReceipt: value => { receipt = value; } });
    assert.deepEqual(receipt.usage, { inputTokens: Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null, outputTokens: Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null });
  }
  for (const bad of ['{"title":', '', '{}']) { let receipt, calls = 0; await assert.rejects(invoke({ fetchImpl: async () => { calls++; return response(bad, 'stop', { prompt_tokens: 3, completion_tokens: 5 }); }, onReceipt: value => { receipt = value; } })); assert.equal(receipt.content, bad); assert.deepEqual(receipt.usage, { inputTokens: 3, outputTokens: 5 }); assert.equal(calls, 1); }
  const invented = fakeSpec(); invented.requirements[0].sourceQuote = '不存在的引用'; let received = false;
  await assert.rejects(invoke({ fetchImpl: async () => response(invented), onReceipt: () => { received = true; } }), /原文引用/); assert.equal(received, true);
});

test('HTTP/envelope/stream/transport/receipt errors never echo underlying secrets and do not retry', async () => {
  for (const make of [async () => { throw new Error('https://private.invalid/' + config.apiKey); }, async () => new Response(config.apiKey, { status: 401 }), async () => new Response('{broken:' + config.apiKey), async () => new Response(JSON.stringify({ error: { message: config.apiKey } })), async () => ({ ok: true, body: { getReader() { throw new Error(config.apiKey); } } }), async () => ({ ok: true, body: { getReader: () => ({ read: async () => { throw new Error(config.apiKey); }, cancel: async () => {}, releaseLock() {} }) } })]) {
    let calls = 0; await assert.rejects(invoke({ fetchImpl: async () => { calls++; return make(); } }), hidden); assert.equal(calls, 1);
  }
  await rejectsCode(invoke({ onReceipt: async () => { throw new Error('private.invalid/' + config.apiKey); } }), 'receipt_failed');
  let textCalled = false; await rejectsCode(invoke({ fetchImpl: async () => ({ ok: true, text: async () => { textCalled = true; return ''; } }) }), 'response_error'); assert.equal(textCalled, false);
});

test('actual UTF8 byte stream and content budgets cancel oversized reads without response.text', async () => {
  let reads = 0, cancelled = 0, requestSignal;
  await rejectsCode(invoke({ fetchImpl: async (_url, request) => { requestSignal = request.signal; return { ok: true, body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(65536) }; }, cancel: async () => { cancelled++; }, releaseLock() {} }) }, text: () => assert.fail('unbounded text must not be used') }; } }), 'response_too_large');
  assert.equal(reads, 17); assert.ok(cancelled > 0); assert.equal(requestSignal.aborted, true);
  await rejectsCode(invoke({ fetchImpl: async () => new Response(new Uint8Array([0xff])) }), 'response_error');
  const oversized = fakeSpec(); oversized.summary = 'x'.repeat(512 * 1024); let received = false;
  await rejectsCode(invoke({ fetchImpl: async () => response(oversized), onReceipt: () => { received = true; } }), 'response_too_large'); assert.equal(received, false);
  const unicode = fakeSpec(); unicode.summary = '汉'.repeat(400000); await rejectsCode(invoke({ fetchImpl: async () => response(unicode) }), 'response_too_large');
});

test('noncooperative fetch/read/receipt are bounded by one deadline, and late fetch bodies are cancelled', async () => {
  for (const phase of ['fetch', 'read', 'receipt']) {
    const late = deferred(); let receipts = 0, cancelled = 0, completed = false;
    const fetchImpl = phase === 'fetch' ? async () => { await late.promise; return { ok: true, body: { cancel: async () => { cancelled++; } } }; }
      : phase === 'read' ? async () => ({ ok: true, body: { getReader: () => ({ read: () => late.promise, cancel: async () => { cancelled++; }, releaseLock() {} }) } }) : async () => response();
    const waiting = invoke({ fetchImpl, timeoutMs: 35, onReceipt: async () => { receipts++; if (phase === 'receipt') await late.promise; } }).then(value => { completed = true; return value; });
    await rejectsCode(waiting, 'model_timeout'); assert.equal(completed, false); assert.equal(receipts, phase === 'receipt' ? 1 : 0);
    late.resolve({ done: true }); await delay(10); assert.equal(completed, false); if (phase !== 'receipt') assert.ok(cancelled > 0);
  }
});

test('pre-cancel and in-flight fetch/read/receipt cancellation prevent proposal or new late receipt', async () => {
  const pre = new AbortController(); pre.abort(); let calls = 0;
  await rejectsCode(invoke({ signal: pre.signal, fetchImpl: async () => { calls++; return response(); } }), 'cancelled'); assert.equal(calls, 0);
  for (const phase of ['fetch', 'read', 'receipt']) {
    const controller = new AbortController(), entered = deferred(), late = deferred(); let receipts = 0, cancelled = 0;
    const fetchImpl = phase === 'fetch' ? async () => { entered.resolve(); await late.promise; return { ok: true, body: { cancel: async () => { cancelled++; } } }; }
      : phase === 'read' ? async () => ({ ok: true, body: { getReader: () => ({ read: () => { entered.resolve(); return late.promise; }, cancel: async () => { cancelled++; }, releaseLock() {} }) } }) : async () => response();
    const waiting = invoke({ signal: controller.signal, fetchImpl, onReceipt: async () => { receipts++; entered.resolve(); if (phase === 'receipt') await late.promise; } });
    await entered.promise; controller.abort(); await rejectsCode(waiting, 'cancelled'); late.resolve({ done: true }); await delay(10);
    assert.equal(receipts, phase === 'receipt' ? 1 : 0); if (phase !== 'receipt') assert.ok(cancelled > 0);
  }
});

test('absolute deadline is rechecked after receipt, before the timer can fire', async () => {
  const currentTime = Date.now; let admitted = false;
  try {
    await rejectsCode(invoke({ timeoutMs: 5000, onReceipt: () => { admitted = true; Date.now = () => currentTime() + 6000; } }), 'model_timeout');
    assert.equal(admitted, true);
  } finally { Date.now = currentTime; }
});
