import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectReviewModel, projectReviewPolicy, validateProjectReviewResponse } from '../lib/project-review-model.mjs';

const clear = { summary: '当前候选没有发现阻塞问题。', issues: [], resolutions: [] };
const config = { baseUrl: 'https://model.invalid/v1', model: 'project-review', apiKey: 'private-review-secret' };
const reply = raw => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));

test('project Review accepts the full allowed multi-file snapshot and never accepts candidate completion fields', async () => {
  const files = Array.from({ length: 24 }, (_, index) => ({ path: `src/module-${index}.mjs`, content: `// ${'x'.repeat(40_000)}\nexport const value=${index};` }));
  const model = createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 4096);
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.deepEqual(context.files, files.map(({ path, content }) => ({ path, lines: content.split(/\r?\n/u).map((text, index) => ({ line: index + 1, text })) })));
    assert.ok(context.files.every(file => !Object.hasOwn(file, 'content'))); assert.deepEqual(context.previousIssues, []);
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
    Array.from({ length: 61 }, (_, index) => ({ path: `src/module-${index}.mjs`, content: '' })),
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
    assert.deepEqual(JSON.parse(JSON.parse(options.body).messages[1].content), { task: '检查', files: files.map(({ path, content }) => ({ path,
      lines: content.split(/\r?\n/u).map((text, index) => ({ line: index + 1, text })) })), previousIssues });
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

test('Review finish metadata is restricted to known constants, never provider text or the configured credential', async () => {
  const content = JSON.stringify(clear);
  for (const finish_reason of [config.apiKey, 'provider-private-details', 'STOP', 'stop ', { secret: config.apiKey }, null, undefined]) {
    let receipt, calls = 0;
    const model = createProjectReviewModel({ config, fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ model: config.apiKey, choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 2, completion_tokens: 5 } }));
    } });
    await assert.rejects(model({ task: '检查', files: candidateFiles, onReceipt: async value => { receipt = value; } }), error => {
      assert.equal(error.code, undefined);
      assert.ok(!error.message.includes(config.apiKey) && !error.message.includes('provider-private-details')); return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(receipt, { model: config.model, finishReason: 'unknown', usage: { inputTokens: 2, outputTokens: 5 }, content });
    assert.equal(JSON.stringify(receipt).includes(config.apiKey), false);
  }
});

test('Review non-stop finishes are not JSON-format errors even when content is absent or invalid', async () => {
  for (const finish_reason of ['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', null, undefined]) {
    for (const content of [null, undefined, '', '{"summary":']) {
      let receipt, calls = 0;
      const model = createProjectReviewModel({ config, fetchImpl: async () => {
        calls++; return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));
      } });
      await assert.rejects(model({ task: '检查', files: candidateFiles, onReceipt: async value => { receipt = value; } }), error => error.code !== 'invalid_model_response');
      assert.equal(calls, 1);
      assert.equal(receipt.finishReason, typeof finish_reason === 'string' ? finish_reason : 'unknown');
      assert.equal(receipt.content, typeof content === 'string' ? content : '');
    }
  }
});

test('Review sends program-numbered source lines once, preserving multi-file CRLF, blank lines and source spacing', async () => {
  const files = Object.freeze([
    Object.freeze({ path: 'src/app.mjs', content: '  const a = 1;  \r\n\r\n// end\r\n' }),
    Object.freeze({ path: 'public/ui.js', content: '\n\tconst b = 2;\n' }),
  ]);
  const numbered = [
    { path: 'src/app.mjs', lines: [{ line: 1, text: '  const a = 1;  ' }, { line: 2, text: '' }, { line: 3, text: '// end' }, { line: 4, text: '' }] },
    { path: 'public/ui.js', lines: [{ line: 1, text: '' }, { line: 2, text: '\tconst b = 2;' }, { line: 3, text: '' }] },
  ];
  let calls = 0;
  const result = await createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body), context = JSON.parse(request.messages[1].content);
    assert.deepEqual(context, { task: '逐行审查', files: numbered, previousIssues: [] });
    assert.ok(context.files.every(file => !Object.hasOwn(file, 'content')));
    assert.match(request.messages[0].content, /line由平台/u);
    assert.match(request.messages[0].content, /text\.trim\(\)/u);
    assert.match(request.messages[0].content, /不要自行数行/u);
    return reply(clear);
  } })({ task: '逐行审查', files });
  assert.deepEqual(result.issues, []); assert.equal(calls, 1);
});

test('numbering and strict validation share the original snapshot when caller files and history change during fetch', async () => {
  const files = [{ path: 'src/app.mjs', content: 'export function app() {\r\n  return {};\r\n}\r\n' }];
  const previousIssues = [{ id: 'original-id', severity: 'blocking', file: 'src/app.mjs', line: 2, message: '原始问题' }];
  const raw = { summary: '按固定快照审查', issues: [{ severity: 'advisory', file: 'src/app.mjs', line: 2, evidence: 'return {};', message: '保留原始证据' }],
    resolutions: [{ id: 'original-id', status: 'open', reason: '仍需处理' }] };
  const result = await createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    const sent = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.deepEqual(sent.files, [{ path: 'src/app.mjs', lines: [{ line: 1, text: 'export function app() {' }, { line: 2, text: '  return {};' }, { line: 3, text: '}' }, { line: 4, text: '' }] }]);
    assert.equal(sent.previousIssues[0].id, 'original-id');
    files[0].path = 'src/replaced.mjs'; files[0].content = '\n'.repeat(10_000); previousIssues[0].id = 'replaced-id';
    return reply(raw);
  } })({ task: '检查原快照', files, previousIssues });
  assert.deepEqual(result.issues, raw.issues);
  assert.deepEqual(result.resolutions, raw.resolutions);
});

test('a misplaced advisory is still rejected even when its evidence appears at other numbered lines', async () => {
  const evidence = 'return record;';
  const repeated = new Set([207, 213, 223, 229]);
  const files = [{ path: 'src/app.mjs', content: Array.from({ length: 230 }, (_, index) => repeated.has(index + 1) ? `  ${evidence}` : `// original line ${index + 1}`).join('\n') }];
  const misplaced = { ...clear, issues: [{ severity: 'advisory', file: 'src/app.mjs', line: 146, evidence, message: '建议核对该分支' }] };
  let receipt;
  await assert.rejects(createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    const numbered = JSON.parse(JSON.parse(options.body).messages[1].content).files[0].lines;
    assert.deepEqual(numbered[145], { line: 146, text: '// original line 146' });
    assert.deepEqual(numbered[206], { line: 207, text: `  ${evidence}` });
    return reply(misplaced);
  } })({ task: '检查行号', files, onReceipt: value => { receipt = value; } }), error => {
    assert.match(error.message, /证据与候选代码不一致/u); assert.notEqual(error.code, 'invalid_model_response'); return true;
  });
  assert.equal(receipt.content, JSON.stringify(misplaced));
  assert.throws(() => validateProjectReviewResponse(misplaced, { files }), /证据与候选代码不一致/u);
  const correct = { ...misplaced, issues: [{ ...misplaced.issues[0], line: 207 }] };
  assert.deepEqual(validateProjectReviewResponse(correct, { files }).issues, correct.issues, 'valid advisories survive unchanged; no relocation or filtering');
});

test('more than 10000 total source lines reject before a model request or receipt, including newline-only input', async () => {
  let calls = 0, receipts = 0;
  const model = createProjectReviewModel({ config, fetchImpl: async () => { calls++; return reply(clear); } });
  for (const files of [
    [{ path: 'src/app.mjs', content: '\n'.repeat(10_000) }],
    [{ path: 'src/a.mjs', content: '\r\n'.repeat(4999) }, { path: 'src/b.mjs', content: '\n'.repeat(5000) }],
    Array.from({ length: 16 }, (_, index) => ({ path: `src/part-${index}.mjs`, content: '\n'.repeat(131_072) })),
  ]) {
    await assert.rejects(model({ task: '检查', files, onReceipt: () => { receipts++; } }), error => {
      assert.match(error.message, /总行数不能超过10000/u); assert.notEqual(error.code, 'invalid_model_response'); return true;
    });
  }
  assert.equal(calls, 0); assert.equal(receipts, 0);
});

test('exactly 10000 source lines are accepted and numbering resets for each file', async () => {
  const files = [{ path: 'src/a.mjs', content: '\r\n'.repeat(4999) }, { path: 'src/b.mjs', content: '\n'.repeat(4999) }];
  let calls = 0;
  await createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    calls++;
    const sent = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(sent.files.reduce((total, file) => total + file.lines.length, 0), 10_000);
    for (const file of sent.files) {
      assert.deepEqual(file.lines[0], { line: 1, text: '' });
      assert.deepEqual(file.lines.at(-1), { line: 5000, text: '' });
      assert.equal(Object.hasOwn(file, 'content'), false);
    }
    return reply(clear);
  } })({ task: '检查边界', files });
  assert.equal(calls, 1);
});
