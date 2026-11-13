import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectReviewModel, projectReviewPolicy, validateProjectReviewResponse } from '../lib/project-review-model.mjs';

const clear = { summary: '当前候选没有发现阻塞问题。', issues: [], resolutions: [] };
const config = { baseUrl: 'https://model.invalid/v1', model: 'project-review', apiKey: 'private-review-secret' };
const reply = raw => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));

test('project Review accepts the full allowed multi-file snapshot and never accepts candidate completion fields', async () => {
  const files = Array.from({ length: 24 }, (_, index) => ({ path: `src/module-${index}.mjs`, content: `// ${'x'.repeat(40_000)}\nexport const value=${index};` }));
  const model = createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.deepEqual(context.files, files); assert.deepEqual(context.previousIssues, []);
    assert.equal(context.task, '按固定Web契约检查。');
    assert.equal(options.body.includes(config.apiKey), false);
    return reply({ ...clear, passed: true, status: 'accepted', binding: { sourceHash: 'forged' } });
  } });
  const result = await model({ task: '按固定Web契约检查。', files });
  assert.deepEqual(result, { ...clear, model: config.model, usage: { inputTokens: null, outputTokens: null } });
  assert.equal(projectReviewPolicy.version, 'web-project-review-v1');
  assert.match(projectReviewPolicy.hash, /^[a-f0-9]{64}$/u);
});

test('project Review enforces source scope and total context limits before a request', async () => {
  let calls = 0;
  const model = createProjectReviewModel({ config, fetchImpl: async () => { calls++; return reply(clear); } });
  for (const files of [
    [{ path: '.platform/worker.cjs', content: 'unsafe' }],
    [{ path: '../outside.mjs', content: 'unsafe' }],
    [{ path: 'src/app.mjs', content: 'x'.repeat(131_073) }],
    Array.from({ length: 17 }, (_, index) => ({ path: `src/module-${index}.mjs`, content: 'x'.repeat(131_072) })),
    [{ path: 'src/app.mjs', content: 'a' }, { path: 'src/APP.mjs', content: 'b' }],
  ]) await assert.rejects(model({ task: '检查', files }));
  assert.equal(calls, 0);
});

test('project Review binds evidence to actual lines and explicitly resolves every prior issue', () => {
  const files = [{ path: 'src/app.mjs', content: 'export function createApp(){\n return {};\n}\n' }];
  const previousIssues = [{ id: 'old-1', severity: 'blocking', file: 'src/app.mjs', line: 2, message: '缺少handle' }];
  const issue = { severity: 'blocking', file: 'src/app.mjs', line: 2, evidence: 'return {};', message: '没有实现HTTP处理器。' };
  const raw = { ...clear, issues: [issue], resolutions: [{ id: 'old-1', status: 'open', reason: '仍未实现handle。' }] };
  assert.deepEqual(validateProjectReviewResponse(raw, { files, previousIssues }), raw);
  assert.throws(() => validateProjectReviewResponse({ ...raw, resolutions: [] }, { files, previousIssues }));
  assert.throws(() => validateProjectReviewResponse({ ...raw, issues: [{ ...issue, evidence: 'invented' }] }, { files, previousIssues }));
});

test('project Review transport errors hide credentials and cancellation rejects incomplete opinions', async () => {
  const files = [{ path: 'src/app.mjs', content: 'export const app = 1;' }];
  for (const fetchImpl of [async () => { throw new Error(config.apiKey); }, async () => new Response(config.apiKey, { status: 401 })]) {
    await assert.rejects(createProjectReviewModel({ config, fetchImpl })({ task: '检查', files }), error => !error.message.includes(config.apiKey));
  }
  const controller = new AbortController();
  const model = createProjectReviewModel({ config, fetchImpl: async () => {
    controller.abort(); return reply(clear);
  } });
  await assert.rejects(model({ task: '检查', files, signal: controller.signal }), { name: 'AbortError' });
});

const candidateFiles = [{ path: 'src/app.mjs', content: 'export const app = 1;' }];
function envelopeFor(content, { finishReason = 'stop', usage } = {}) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }], usage }));
}

test('Review records malformed, blank and missing content with normalized usage before strict format rejection', async () => {
  for (const content of ['{"summary":', ' \t\n ', '', '```json\n{}\n```', null, undefined, '{}']) {
    const receipts = [];
    await assert.rejects(createProjectReviewModel({ config, fetchImpl: async () => envelopeFor(content, { usage: { prompt_tokens: 0, completion_tokens: -1 } }) })({ task: '检查', files: candidateFiles,
      onReceipt: async receipt => { receipts.push(receipt); } }), { code: 'invalid_model_response' });
    assert.deepEqual(receipts, [{ model: config.model, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: null }, content: typeof content === 'string' ? content : '' }]);
    assert.equal(Object.getPrototypeOf(receipts[0]), Object.prototype);
    assert.equal(Object.getPrototypeOf(receipts[0].usage), Object.prototype);
  }
});

test('Review receipt callbacks are not request data and cannot mutate the saved candidate context or conclusion', async () => {
  const files = candidateFiles.map(item => ({ ...item }));
  const previousIssues = [{ id: 'old-1', severity: 'blocking', file: 'src/app.mjs', line: 1, message: '核对原候选' }];
  const raw = { summary: '原候选仍有问题', issues: [{ severity: 'blocking', file: 'src/app.mjs', line: 1, message: '原候选证据', evidence: files[0].content }],
    resolutions: [{ id: 'old-1', status: 'open', reason: '原问题仍存在' }] };
  let called = false;
  const sink = async receipt => {
    called = true; receipt.content = JSON.stringify(clear); receipt.usage.inputTokens = 999;
    files[0].content = 'changed after request'; previousIssues[0].id = 'changed-id';
  };
  sink.toJSON = () => { throw new Error('callback must not enter JSON'); };
  const model = createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    assert.equal(Object.hasOwn(options, 'onReceipt'), false);
    assert.deepEqual(Object.keys(options.headers).sort(), ['Authorization', 'Content-Type']);
    assert.deepEqual(JSON.parse(JSON.parse(options.body).messages[1].content), { task: '检查', files, previousIssues });
    return envelopeFor(JSON.stringify(raw), { usage: { prompt_tokens: 8, completion_tokens: 5 } });
  } });
  assert.deepEqual(await model({ task: '检查', files, previousIssues, onReceipt: sink }), { ...raw, model: config.model, usage: { inputTokens: 8, outputTokens: 5 } });
  assert.equal(called, true);
});

test('Review credential responses are redacted everywhere in the receipt and never accepted as opinions', async () => {
  const raw = { ...clear, summary: `echo ${config.apiKey} ${config.apiKey}` };
  const model = createProjectReviewModel({ config, fetchImpl: async () => reply(raw) });
  let receipt;
  await assert.rejects(model({ task: '检查', files: candidateFiles, onReceipt: async value => { receipt = value; } }), error => {
    assert.equal(error.code, 'credential_response'); assert.ok(!error.message.includes(config.apiKey)); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(receipt.content.includes(config.apiKey), false); assert.equal(receipt.content.split('[REDACTED]').length - 1, 2);
  await assert.rejects(model({ task: '检查', files: candidateFiles }), { code: 'credential_response' });
  let boundedReceipt;
  await assert.rejects(createProjectReviewModel({ config: { ...config, apiKey: '!' }, fetchImpl: async () => envelopeFor('!'.repeat(70_000)) })({ task: '检查', files: candidateFiles,
    onReceipt: async value => { boundedReceipt = value; } }), { code: 'credential_response' });
  assert.ok(Buffer.byteLength(boundedReceipt.content) <= 128 * 1024); assert.equal(boundedReceipt.content.includes('!'), false);
});

test('Review sink failures and cancellation cannot publish opinions or expose sink exceptions', async () => {
  const model = createProjectReviewModel({ config, fetchImpl: async () => reply(clear) });
  await assert.rejects(model({ task: '检查', files: candidateFiles, onReceipt: async () => { throw new Error(`${config.apiKey} https://private.invalid`); } }), error => {
    assert.equal(error.code, 'receipt_failed'); assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes(config.apiKey) && !error.message.includes('private.invalid')); return true;
  });
  let providerCalls = 0;
  await assert.rejects(createProjectReviewModel({ config, fetchImpl: async () => { providerCalls++; return reply(clear); } })({ task: '检查', files: candidateFiles, onReceipt: {} }), { code: 'receipt_failed' });
  assert.equal(providerCalls, 0);
  const controller = new AbortController();
  let entered, release, accepted = false;
  const started = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const pending = model({ task: '检查', files: candidateFiles, signal: controller.signal, onReceipt: async () => { entered(); await barrier; } }).then(value => { accepted = true; return value; });
  await started; controller.abort(config.apiKey);
  await assert.rejects(pending, { name: 'AbortError', message: 'Review模型请求已取消。' });
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(accepted, false);
  const before = new AbortController(); before.abort(); let sinkCalls = 0;
  await assert.rejects(model({ task: '检查', files: candidateFiles, signal: before.signal, onReceipt: () => { sinkCalls++; } }), { name: 'AbortError' });
  assert.equal(sinkCalls, 0);
});

test('Review transport limits, truncation and invalid evidence are not format retries and preserve bounded receipts', async () => {
  for (const [fetchImpl, finishReason] of [
    [async () => envelopeFor('{"summary":', { finishReason: 'length' }), 'length'],
    [async () => envelopeFor('{}', { finishReason: null }), 'unknown'],
    [async () => reply({ ...clear, issues: [{ severity: 'blocking', file: '../outside.mjs', line: 1, evidence: 'invented', message: 'wrong location' }] }), 'stop'],
  ]) {
    let receipt;
    await assert.rejects(createProjectReviewModel({ config, fetchImpl })({ task: '检查', files: candidateFiles, onReceipt: value => { receipt = value; } }), error => error.code !== 'invalid_model_response');
    assert.equal(receipt.finishReason, finishReason);
  }
  for (const fetchImpl of [async () => new Response('provider error', { status: 500 }), async () => envelopeFor('x'.repeat(128 * 1024))]) {
    let called = false;
    await assert.rejects(createProjectReviewModel({ config, fetchImpl })({ task: '检查', files: candidateFiles, onReceipt: () => { called = true; } }), error => error.code !== 'invalid_model_response');
    assert.equal(called, false);
  }
});
