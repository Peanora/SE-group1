import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewModel, validateReviewResponse, reviewPolicy } from '../lib/review-model.mjs';

const config = { baseUrl: 'https://model.invalid/v1', model: 'review-test', apiKey: 'secret-review-key' };
const task = '同步借阅函数，不得修改输入。';
const files = [{ path: 'src/borrow.mjs', content: 'export function borrowBook(state, userId) {\n  return state;\n}\n' }];
const opinion = { summary: '存在阻塞问题', issues: [{ severity: 'blocking', file: files[0].path, line: 2, message: '没有扣减库存并复制记录', evidence: 'return state;' }], resolutions: [] };
const clear = { summary: '未发现阻塞问题', issues: [], resolutions: [] };
const history = [{ id: 'ISSUE-1', severity: 'blocking', file: files[0].path, line: 2, message: '需要复制记录', evidence: 'return state;' }];
function responseFor(raw = opinion, extra = {}) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }], ...extra }));
}
async function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('Review只发送固定任务和代码资料，解析问题，不接受模型完成状态或binding', async () => {
  await withEnv({ LLM_THINKING: 'disabled', LLM_JSON_MODE: '1' }, async () => {
    const controller = new AbortController();
    const model = createReviewModel({ config, fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://model.invalid/v1/chat/completions');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      const body = JSON.parse(options.body);
      assert.equal(body.max_tokens, 4096);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(JSON.parse(body.messages[1].content), { task, files, previousIssues: [] });
      assert.ok(!options.body.includes(config.apiKey));
      assert.ok(!body.messages[1].content.includes('testPassed'));
      return responseFor({ ...opinion, passed: true, binding: 'wrong', model: 'not-trusted' }, { usage: { prompt_tokens: 60, completion_tokens: 30 } });
    } });
    assert.deepEqual(await model({ task, files, signal: controller.signal }), { ...opinion, model: config.model, usage: { inputTokens: 60, outputTokens: 30 } });
    assert.match(reviewPolicy.hash, /^[0-9a-f]{64}$/);
    assert.equal(reviewPolicy.version, 'library-review-v1');
    assert.equal(Object.isFrozen(reviewPolicy), true);
  });
});

test('Review纯校验支持无新问题及逐条历史问题复验，丢弃额外状态字段', () => {
  const raw = { ...clear, resolutions: [{ id: 'ISSUE-1', status: 'resolved', reason: '当前代码已明确复制记录' }], passed: true };
  assert.deepEqual(validateReviewResponse(raw, { files, previousIssues: history }), { summary: clear.summary, issues: [], resolutions: raw.resolutions });
  assert.equal(validateReviewResponse({ ...clear, resolutions: [{ id: 'ISSUE-1', status: 'open', reason: '问题仍存在' }] }, { files, previousIssues: history }).resolutions[0].status, 'open');
});

test('等待Review期间调用方改动资料，不改变已发送候选的校验上下文', async () => {
  const mutableFiles = structuredClone(files);
  const mutableHistory = structuredClone(history);
  const model = createReviewModel({ config, fetchImpl: async () => {
    mutableFiles[0].content = 'different file';
    mutableHistory[0].id = 'CHANGED';
    return responseFor({ ...opinion, resolutions: [{ id: 'ISSUE-1', status: 'open', reason: '当前候选仍存在此问题' }] });
  } });
  const result = await model({ task, files: mutableFiles, previousIssues: mutableHistory });
  assert.equal(result.issues[0].evidence, 'return state;');
  assert.equal(result.resolutions[0].id, 'ISSUE-1');
});

test('Review缺失结构、位置不匹配、空证据和非法严重程度明确拒绝', () => {
  for (const raw of [null, {}, { ...clear, summary: '' }, { ...clear, summary: 'x'.repeat(2001) }, { ...clear, issues: null }, { ...clear, resolutions: undefined }, { ...clear, issues: Array(21).fill(opinion.issues[0]) }]) {
    assert.throws(() => validateReviewResponse(raw, { files }), /Review/);
  }
  for (const change of [{ severity: 'pass' }, { file: '../outside' }, { line: 0 }, { line: 100 }, { line: 1.5 }, { line: 4, evidence: '' }, { evidence: 'different code' }, { evidence: ' return state; ' }, { message: '' }, { message: 'x'.repeat(1001) }]) {
    assert.throws(() => validateReviewResponse({ ...opinion, issues: [{ ...opinion.issues[0], ...change }] }, { files }), /Review/);
  }
});

test('历史问题不得漏报、重复、增加或伪造关闭状态', () => {
  for (const resolutions of [[], [{ id: 'OTHER', status: 'resolved', reason: '修复' }], [{ id: 'ISSUE-1', status: 'passed', reason: '修复' }], [{ id: 'ISSUE-1', status: 'resolved', reason: '' }], Array(2).fill({ id: 'ISSUE-1', status: 'resolved', reason: '修复' })]) {
    assert.throws(() => validateReviewResponse({ ...clear, resolutions }, { files, previousIssues: history }), /Review/);
  }
  assert.throws(() => validateReviewResponse({ ...clear, resolutions: [{ id: 'ISSUE-1', status: 'resolved', reason: '修复' }] }, { files }), /Review/);
  assert.throws(() => validateReviewResponse(clear, { files, previousIssues: [history[0], history[0]] }), /Review/);
});

test('默认Review复用LLM配置，未知或非法用量为null，JSON模式可关闭', async () => {
  await withEnv({ LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey, LLM_JSON_MODE: '0', LLM_THINKING: '' }, async () => {
    const result = await createReviewModel({ fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      assert.equal('response_format' in JSON.parse(options.body), false);
      return responseFor(clear, { usage: { prompt_tokens: -1, completion_tokens: '30' } });
    } })({ task, files });
    assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
    assert.equal(result.model, config.model);
  });
});

test('输入和配置错误在请求前拒绝，不回显地址和秘密', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return responseFor(); };
  for (const invalid of [{ ...config, baseUrl: 'file:///secret-review-key' }, { ...config, baseUrl: 'https://user:secret-review-key@model.invalid' }, { ...config, baseUrl: 'https://model.invalid/?token=secret-review-key' }, { ...config, model: '' }]) {
    await assert.rejects(createReviewModel({ config: invalid, fetchImpl })({ task, files }), error => !error.message.includes(config.apiKey));
  }
  await assert.rejects(createReviewModel({ config, fetchImpl })({ task, files: [] }), /Review/);
  await withEnv({ LLM_THINKING: 'invalid' }, async () => { await assert.rejects(createReviewModel({ config, fetchImpl })({ task, files }), /LLM_THINKING/); });
  assert.equal(calls, 0);
});

test('服务失败、JSON错误及截断均失败，秘密不进入异常', async () => {
  const secret = `${config.apiKey} https://private.invalid/?token=secret-url`;
  for (const fetchImpl of [
    async () => new Response(secret, { status: 401 }),
    async () => { throw new Error(secret); },
    async () => new Response(secret),
    async () => responseFor(clear, { error: { message: secret } }),
    async () => responseFor(clear, { choices: [{ finish_reason: 'stop', message: { content: secret } }] }),
    async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } })),
  ]) {
    await assert.rejects(createReviewModel({ config, fetchImpl })({ task, files }), error => {
      assert.ok(!error.message.includes(config.apiKey)); assert.ok(!error.message.includes('private.invalid')); assert.equal(error.cause, undefined); return true;
    });
  }
  for (const [finish_reason, pattern] of [['length', /截断/], ['content_filter', /未正常结束/]]) {
    await assert.rejects(createReviewModel({ config, fetchImpl: async () => responseFor(clear, { choices: [{ finish_reason, message: { content: '{}' } }] }) })({ task, files }), pattern);
  }
});

test('响应按实际字节限制128KiB，超限即取消', async () => {
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(70 * 1024).fill(97)); }, cancel() { cancelled = true; } });
  await assert.rejects(createReviewModel({ config, fetchImpl: async () => new Response(stream, { headers: { 'Content-Length': '1' } }) })({ task, files }), /128KiB/);
  assert.equal(cancelled, true); assert.ok(pulls <= 3);
});

test('请求前及请求中取消，固定错误不回显取消原因', async () => {
  let calls = 0;
  const before = new AbortController(); before.abort(config.apiKey);
  await assert.rejects(createReviewModel({ config, fetchImpl: async () => { calls++; } })({ task, files, signal: before.signal }), { name: 'AbortError', message: 'Review模型请求已取消。' });
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = createReviewModel({ config, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(config.apiKey)), { once: true }); queueMicrotask(() => during.abort(config.apiKey));
  }) })({ task, files, signal: during.signal });
  await assert.rejects(pending, { name: 'AbortError', message: 'Review模型请求已取消。' });
});

test('响应读取中取消能结束挂起流，不接受已取消回执', async () => {
  const controller = new AbortController(); let cancelled = false, started;
  const reading = new Promise(resolve => { started = resolve; });
  const stream = new ReadableStream({ pull() { started(); }, cancel() { cancelled = true; } });
  const pending = createReviewModel({ config, fetchImpl: async () => new Response(stream) })({ task, files, signal: controller.signal });
  await reading; controller.abort(config.apiKey);
  await assert.rejects(pending, { name: 'AbortError', message: 'Review模型请求已取消。' });
  assert.equal(cancelled, true);
});
