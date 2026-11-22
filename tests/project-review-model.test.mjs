import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectReviewModel, projectReviewPolicy, validateProjectReviewResponse, decodeProjectReviewResponseV2, getProjectReviewResponseFeedback, normalizeProjectReviewResponseFeedback, projectReviewEvidenceOrigin, PROJECT_REVIEW_HISTORY_LIMIT } from '../lib/project-review-model.mjs';
import { getModelRequestEvidence } from '../lib/model-request-evidence.mjs';

const clear = { summary: '当前候选没有发现阻塞问题。', issues: [], resolutions: [] };
const config = { baseUrl: 'https://model.invalid/v1', model: 'project-review', apiKey: 'private-review-secret' };
const reply = raw => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
const wire = raw => ({ summary: raw.summary, issues: raw.issues.map(({ evidence, ...issue }) => issue), resolutions: raw.resolutions });

test('project Review accepts the full allowed multi-file snapshot and never accepts candidate completion fields', async () => {
  const files = Array.from({ length: 24 }, (_, index) => ({ path: `src/module-${index}.mjs`, content: `// ${'x'.repeat(40_000)}\nexport const value=${index};` }));
  const model = createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 4096);
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.deepEqual(context.files, files.map(({ path, content }) => ({ path, lines: content.split(/\r?\n/u).map((text, index) => ({ line: index + 1, text })) })));
    assert.ok(context.files.every(file => !Object.hasOwn(file, 'content'))); assert.deepEqual(context.previousIssues, []);
    assert.equal(context.task, '按固定Web契约检查。');
    assert.equal(options.body.includes(config.apiKey), false);
    return reply(clear);
  } });
  const result = await model({ task: '按固定Web契约检查。', files });
  assert.deepEqual(result, { ...clear, evidenceOrigin: projectReviewEvidenceOrigin, model: config.model, usage: { inputTokens: null, outputTokens: null } });
  assert.equal(projectReviewPolicy.version, 'web-project-review-v2');
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

test('planned Review preserves every historical ID above the original batch size', async () => {
  const files = [{ path: 'src/app.mjs', content: 'export const app = 1;' }];
  const previousIssues = Array.from({ length: 21 }, (_, index) => ({
    id: `old-${index}`, file: files[0].path, line: 1, severity: 'blocking', message: `Old issue ${index}`, evidence: files[0].content,
  }));
  const resolutions = previousIssues.map(({ id }) => ({ id, status: 'resolved', reason: 'Rechecked on this candidate.' }));
  const context = { files, previousIssues };
  const model = createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(JSON.parse(body.messages[1].content).previousIssues, previousIssues);
    return reply({ ...clear, resolutions });
  } });
  assert.deepEqual((await model({ task: 'Recheck the fixed candidate.', ...context })).resolutions, resolutions);
  assert.throws(() => decodeProjectReviewResponseV2(JSON.stringify({ ...clear, resolutions: resolutions.slice(0, -1) }), context));
  assert.throws(() => decodeProjectReviewResponseV2(JSON.stringify({ ...clear, resolutions: resolutions.map((entry, index) => index === 20 ? resolutions[0] : entry) }), context),
    error => normalizeProjectReviewResponseFeedback(getProjectReviewResponseFeedback(error))?.field === 'resolutions[20].id');
  const overflow = Array.from({ length: PROJECT_REVIEW_HISTORY_LIMIT + 1 }, (_, index) => ({ id: `over-${index}` }));
  await assert.rejects(model({ task: 'Recheck the fixed candidate.', files, previousIssues: overflow }), /输入资料格式无效/u);
});

test('duplicate findings have a bounded diagnostic and cannot give the same finding two IDs', async () => {
  const files = [{ path: 'src/queue.mjs', content: 'return waiting.find(row => row.id === requestedId);' }];
  const issue = { file: files[0].path, line: 1, severity: 'blocking', message: '调度员可绕过队首，后加入的成员可先获得设备。' };
  const raw = { ...clear, issues: [issue, { ...issue, severity: 'advisory', message: ' ' + issue.message }] };
  const model = createProjectReviewModel({ config, fetchImpl: async () => reply(raw) });
  let receipt;
  await assert.rejects(model({ files, task: '必须按候补加入顺序提升。', allowHistoricalDuplicates: true, onReceipt: value => { receipt = value; } }), error => {
    const feedback = getProjectReviewResponseFeedback(error);
    assert.deepEqual(feedback, { version: 1, reason: 'duplicate_issue', field: 'issues[1]' });
    assert.deepEqual(normalizeProjectReviewResponseFeedback(feedback), feedback);
    return true;
  });
  assert.deepEqual(JSON.parse(receipt.content), raw);
  const history = { files, allowHistoricalDuplicates: true };
  const old = decodeProjectReviewResponseV2(receipt.content, history);
  assert.equal(validateProjectReviewResponse(old, history).issues.length, 2);
  assert.throws(() => validateProjectReviewResponse(old, { files }), /重复/u);
  const distinct = { ...raw, issues: [issue, { ...issue, message: '空队列会返回未定义值，无法生成约定的冲突响应。' }] };
  assert.equal(decodeProjectReviewResponseV2(JSON.stringify(distinct), { files }).issues.length, 2);
});

test('an existing finding must be rechecked under its original ID even if the new report downgrades severity', () => {
  const files = [{ path: 'src/queue.mjs', content: 'return waiting.at(-1);' }];
  const prior = { id: 'FIFO-1', file: files[0].path, line: 1, severity: 'blocking', message: '提升队尾会跳过先加入的成员。', evidence: files[0].content };
  const context = { files, previousIssues: [prior] };
  const issue = { file: prior.file, line: prior.line, severity: 'advisory', message: prior.message };
  const resolutions = [{ id: prior.id, status: 'resolved', reason: '已复查。' }];
  const repeated = { ...clear, issues: [issue], resolutions };
  assert.throws(() => decodeProjectReviewResponseV2(JSON.stringify(repeated), context), error =>
    getProjectReviewResponseFeedback(error)?.reason === 'duplicate_issue');
  assert.throws(() => validateProjectReviewResponse({ ...repeated, issues: [{ ...issue, evidence: prior.evidence }] }, context), /重复/u);
  const open = [{ id: prior.id, status: 'open', reason: '当前提交仍然从队尾选人。' }];
  assert.deepEqual(decodeProjectReviewResponseV2(JSON.stringify({ ...clear, resolutions: open }), context).resolutions, open);
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
    assert.deepEqual(receipts, [{ model: config.model, finishReason: 'stop', reviewWireVersion: 2, usage: { inputTokens: 0, outputTokens: null }, content: typeof content === 'string' ? content : '' }]);
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
    return envelopeFor(JSON.stringify(wire(raw)), { usage: { prompt_tokens: 8, completion_tokens: 5 } });
  } });
  assert.deepEqual(await model({ task: '检查', files, previousIssues, onReceipt: sink }), { ...raw, evidenceOrigin: projectReviewEvidenceOrigin, model: config.model, usage: { inputTokens: 8, outputTokens: 5 } });
  assert.equal(called, true);
});

test('Review credential responses are redacted everywhere in the receipt and never accepted as opinions', async () => {
  const raw = { ...clear, summary: `echo ${config.apiKey} ${config.apiKey}` };
  const model = createProjectReviewModel({ config, fetchImpl: async () => reply(raw) });
  let receipt;
  await assert.rejects(model({ task: '检查', files: candidateFiles, onReceipt: async value => { receipt = value; } }), error => {
    assert.equal(error.code, 'credential_response'); assert.ok(!error.message.includes(config.apiKey)); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(receipt.content.includes(config.apiKey), false); assert.equal(receipt.content, '[REDACTED]');
  await assert.rejects(model({ task: '检查', files: candidateFiles }), { code: 'credential_response' });
  let boundedReceipt;
  await assert.rejects(createProjectReviewModel({ config: { ...config, apiKey: '!' }, fetchImpl: async () => envelopeFor('!'.repeat(70_000)) })({ task: '检查', files: candidateFiles,
    onReceipt: async value => { boundedReceipt = value; } }), { code: 'credential_response' });
  assert.ok(Buffer.byteLength(boundedReceipt.content) <= 128 * 1024); assert.equal(boundedReceipt.content.includes('!'), false);
});

test('Review rejects escaped summary/object-key credentials before any recoverable receipt, independent of finish metadata', async () => {
  const escape = value => value.split('').map(letter => '\\u' + letter.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const raw = JSON.stringify({ ...clear, summary: config.apiKey + config.apiKey });
  const encoded = raw.replaceAll(config.apiKey, escape(config.apiKey)), mixed = raw.replace(config.apiKey, escape(config.apiKey));
  const key = JSON.stringify({ ...clear, [config.apiKey]: 'also rejected' }).replaceAll(config.apiKey, escape(config.apiKey));
  for (const content of [encoded, mixed, key, encoded.slice(0, -1)]) {
    for (const finishReason of ['stop', 'length', 'content_filter', null]) {
      let receipt, calls = 0;
      const model = createProjectReviewModel({ config, fetchImpl: async () => { calls++; return envelopeFor(content, { finishReason, usage: { prompt_tokens: 4, completion_tokens: 6 } }); } });
      await assert.rejects(model({ task: '检查', files: candidateFiles, onReceipt: value => { receipt = value; } }), error => error.code === 'credential_response' && !error.message.includes(config.apiKey) && !error.cause);
      assert.equal(calls, 1); assert.deepEqual(receipt.usage, { inputTokens: 4, outputTokens: 6 }); assert.equal(receipt.finishReason, finishReason ?? 'unknown');
      const stored = JSON.parse(JSON.stringify(receipt)); assert.equal(stored.content, '[REDACTED]'); assert.equal(stored.content.includes(escape(config.apiKey)), false);
      await assert.rejects(model({ task: '检查', files: candidateFiles }), { code: 'credential_response' });
    }
  }
});

test('Review keeps nonleaking escaped JSON byte for byte and still enforces the original evidence validator', async () => {
  const content = JSON.stringify(clear).replaceAll('summary', '\\u0073ummary'); let receipt;
  const result = await createProjectReviewModel({ config, fetchImpl: async () => envelopeFor(content) })({ task: '检查', files: candidateFiles, onReceipt: value => { receipt = value; } });
  assert.equal(receipt.content, content); assert.equal(result.summary, clear.summary);
  const wrong = { ...clear, issues: [{ severity: 'advisory', file: 'src/app.mjs', line: 1, evidence: 'invented', message: 'still invalid' }] };
  await assert.rejects(createProjectReviewModel({ config, fetchImpl: async () => reply(wrong) })({ task: '检查', files: candidateFiles }), error => getProjectReviewResponseFeedback(error)?.reason === 'unknown_fields');
});

test('stray quote and escape framing cannot retain Review credentials or make them correctable JSON failures', async () => {
  const escaped = config.apiKey.split('').map(letter => '\\u' + letter.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const body = JSON.stringify({ ...clear, summary: config.apiKey }).replaceAll(config.apiKey, escaped);
  for (const [prefix, suffix] of [['"', ''], ['"', '"'], ['\\"', '\\'], ['"\\', '"\\"'], ["'", "'"]]) {
    for (const finishReason of ['stop', 'length', null]) {
      let receipt, calls = 0;
      const model = createProjectReviewModel({ config, fetchImpl: async () => { calls++; return envelopeFor(prefix + body + suffix, { finishReason, usage: { prompt_tokens: 5, completion_tokens: 7 } }); } });
      await assert.rejects(model({ task: '检查', files: candidateFiles, onReceipt: value => { receipt = value; } }), error => error.code === 'credential_response' && !error.message.includes(config.apiKey));
      assert.equal(calls, 1); assert.deepEqual(receipt.usage, { inputTokens: 5, outputTokens: 7 }); assert.equal(receipt.finishReason, finishReason ?? 'unknown');
      const stored = JSON.parse(JSON.stringify(receipt)); assert.equal(stored.content, '[REDACTED]'); assert.equal(stored.content.includes(escaped), false);
    }
  }
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
    assert.deepEqual(receipt, { model: config.model, finishReason: 'unknown', reviewWireVersion: 2, usage: { inputTokens: 2, outputTokens: 5 }, content });
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
    assert.match(request.messages[0].content, /不输出evidence或复制整行代码/u);
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
    return reply(wire(raw));
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
    assert.equal(getProjectReviewResponseFeedback(error)?.reason, 'unknown_fields'); assert.equal(error.code, 'invalid_model_response'); return true;
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

async function reviewEvidence(operation, expected) {
  let failure;
  try { await operation; } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, '该场景必须拒绝Review意见');
  const evidence = getModelRequestEvidence(failure);
  assert.deepEqual(evidence, expected);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(failure.message.includes(config.apiKey), false);
  return failure;
}

test('Review native wrapper includes every pre-dispatch input and configuration failure', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return reply(clear); };
  await reviewEvidence(createProjectReviewModel({ config: { ...config, baseUrl: 'not a URL' }, fetchImpl })({ task: '检查', files: candidateFiles }), { dispatched: false, responseComplete: false });
  const model = createProjectReviewModel({ config, fetchImpl });
  await reviewEvidence(model(null), { dispatched: false, responseComplete: false });
  await reviewEvidence(model({ task: '', files: candidateFiles }), { dispatched: false, responseComplete: false });
  await reviewEvidence(model({ task: '检查', files: [{ path: '../outside.mjs', content: 'unsafe' }] }), { dispatched: false, responseComplete: false });
  const controller = new AbortController(); controller.abort();
  await reviewEvidence(model({ task: '检查', files: candidateFiles, signal: controller.signal }), { dispatched: false, responseComplete: false });
  const snapshotAbort = new AbortController();
  await reviewEvidence(model({ task: '检查', files: [{ path: 'src/app.mjs', get content() { snapshotAbort.abort(); return 'export const app = 1;'; } }], signal: snapshotAbort.signal }), { dispatched: false, responseComplete: false });
  assert.equal(requests, 0);
});

test('Review connection reset and settled abort cannot forge remote completion with error fields', async () => {
  const reset = createProjectReviewModel({ config, fetchImpl: async () => { throw Object.assign(new Error(config.apiKey), { responseComplete: true, dispatched: false }); } });
  await reviewEvidence(reset({ task: '检查', files: candidateFiles }), { dispatched: true, responseComplete: false });
  const controller = new AbortController(); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const model = createProjectReviewModel({ config, fetchImpl: async (_url, options) => {
    entered(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error(config.apiKey)), { once: true }));
  } });
  const pending = model({ task: '检查', files: candidateFiles, signal: controller.signal }); await ready; controller.abort();
  const failure = await reviewEvidence(pending, { dispatched: true, responseComplete: false });
  assert.equal(failure.name, 'AbortError');
});

for (const status of [200, 401]) test(`Review HTTP ${status} interrupted body is not a terminal response`, async () => {
  let chunks = 0;
  const model = createProjectReviewModel({ config, fetchImpl: async () => new Response(new ReadableStream({ pull(controller) {
    if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('{"choices":['));
    else controller.error(new Error(config.apiKey));
  } }), { status }) });
  await reviewEvidence(model({ task: '检查', files: candidateFiles }), { dispatched: true, responseComplete: false });
});

test('Review complete rejection, invalid JSON and decode failures preserve real terminal evidence', async () => {
  for (const response of [new Response(config.apiKey, { status: 401 }), new Response(null, { status: 401 }), new Response(null, { status: 200 }), new Response('{ incomplete JSON'), new Response(new Uint8Array([0xff]))]) {
    let receipts = 0;
    const model = createProjectReviewModel({ config, fetchImpl: async () => response });
    await reviewEvidence(model({ task: '检查', files: candidateFiles, onReceipt: () => { receipts++; } }), { dispatched: true, responseComplete: true });
    assert.equal(receipts, 0);
  }
});

test('Review consumes bounded rejection bodies, hides stream diagnostics and ignores evidence in JSON', async () => {
  const oversized = createProjectReviewModel({ config, fetchImpl: async () => new Response('x'.repeat(128 * 1024 + 1), { status: 401 }) });
  await reviewEvidence(oversized({ task: '检查', files: candidateFiles }), { dispatched: true, responseComplete: false });
  const unreadable = createProjectReviewModel({ config, fetchImpl: async () => ({ ok: true, status: 200, body: { getReader() { throw new Error(config.apiKey); } } }) });
  await reviewEvidence(unreadable({ task: '检查', files: candidateFiles }), { dispatched: true, responseComplete: false });
  await assert.rejects(createProjectReviewModel({ config, fetchImpl: async () => reply({ ...clear, responseComplete: true, dispatched: false }) })({ task: '检查', files: candidateFiles }), error => {
    assert.equal(getProjectReviewResponseFeedback(error)?.reason, 'unknown_fields'); assert.deepEqual(getModelRequestEvidence(error), { dispatched: true, responseComplete: true }); return true;
  });
});

test('Review configuration or source credential collisions are rejected without sending or saving receipts', async () => {
  for (const where of ['model', 'task', 'file']) {
    let requests = 0, receipts = 0;
    const model = createProjectReviewModel({ config: { ...config, ...(where === 'model' ? { model: `model-${config.apiKey}` } : {}) }, fetchImpl: async () => { requests++; throw new Error('must not send'); } });
    await reviewEvidence(model({ task: where === 'task' ? config.apiKey : '检查', files: where === 'file' ? [{ path: 'src/app.mjs', content: config.apiKey }] : candidateFiles,
      onReceipt: () => { receipts++; } }), { dispatched: false, responseComplete: false }); assert.equal(requests, 0); assert.equal(receipts, 0);
  }
});
