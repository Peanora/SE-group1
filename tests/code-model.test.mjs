import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeModel } from '../lib/code-model.mjs';

const config = { baseUrl: 'https://model.invalid/v1', model: 'test-model', apiKey: 'secret-test-key' };
const task = { id: 'T-1', description: '修复加法', allowedFiles: ['src/add.mjs'] };
const files = [{ path: 'src/add.mjs', content: 'export const add = (a, b) => a - b;' }];
const replacement = [{ path: 'src/add.mjs', content: 'export const add = (a, b) => a + b;' }];

function responseFor(proposal = { files: replacement }, extra = {}) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }],
    ...extra,
  }));
}

async function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('编码模型发送数据、有限 JSON 请求和取消信号，仅返回文件建议及可信数值用量', async () => {
  await withEnv({ LLM_THINKING: 'disabled', LLM_JSON_MODE: '1', LLM_MAX_TOKENS: '99999' }, async () => {
    const controller = new AbortController();
    const feedback = [{ message: '2 + 3 应为 5' }];
    const model = createCodeModel({ config, fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://model.invalid/v1/chat/completions');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      const body = JSON.parse(options.body);
      assert.equal(body.model, config.model);
      assert.equal(body.max_tokens, 4096);
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(JSON.parse(body.messages[1].content), { task, files, feedback });
      assert.ok(!options.body.includes(config.apiKey));
      return responseFor({ files: replacement, commands: ['do not execute'], succeeded: true }, { usage: { prompt_tokens: 100, completion_tokens: 40 } });
    } });
    assert.deepEqual(await model({ task, files, feedback, signal: controller.signal }), {
      files: replacement, usage: { inputTokens: 100, outputTokens: 40 }, model: config.model,
    });
  });
});

test('默认复用现有 LLM 配置，未知用量为 null，JSON 模式可关闭', async () => {
  await withEnv({ LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey, LLM_THINKING: '', LLM_JSON_MODE: '0' }, async () => {
    const model = createCodeModel({ fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      assert.equal('response_format' in JSON.parse(options.body), false);
      return responseFor(undefined, { usage: { prompt_tokens: -1, completion_tokens: '40' } });
    } });
    assert.deepEqual((await model({ task, files })).usage, { inputTokens: null, outputTokens: null });
  });
});

test('非法配置在发送请求前失败，错误不包含配置地址或密钥', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return responseFor(); };
  for (const invalid of [{ ...config, baseUrl: 'file:///secret-test-key' }, { ...config, baseUrl: 'not a URL secret-test-key' }, { ...config, model: '' }]) {
    await assert.rejects(createCodeModel({ config: invalid, fetchImpl })({ task, files }), error => !error.message.includes(config.apiKey));
  }
  await withEnv({ LLM_THINKING: 'invalid' }, async () => {
    await assert.rejects(createCodeModel({ config, fetchImpl })({ task, files }), /LLM_THINKING/);
  });
  assert.equal(calls, 0);
});

test('非法结构、无正常完成和截断输出明确失败，模型完成文字没有效力', async () => {
  for (const proposal of [null, {}, { files: 'done' }, { files: [{ path: 1, content: '' }] }, { files: [{ path: 'x', content: null }] }]) {
    await assert.rejects(createCodeModel({ config, fetchImpl: async () => responseFor(proposal) })({ task, files }), /文件建议格式无效/);
  }
  for (const [finish_reason, pattern] of [['length', /截断/], ['content_filter', /未正常结束/]]) {
    const response = responseFor(undefined, { choices: [{ finish_reason, message: { content: '{"files":' } }] });
    await assert.rejects(createCodeModel({ config, fetchImpl: async () => response })({ task, files }), pattern);
  }
  await assert.rejects(createCodeModel({ config, fetchImpl: async () => responseFor(undefined, { choices: [{ finish_reason: 'stop', message: { content: '已完成并通过测试' } }] }) })({ task, files }), /有效 JSON 文件建议/);
});

test('服务错误和异常文本中的正文、URL、密钥不进入错误结果', async () => {
  const secret = `${config.apiKey} https://private.invalid/?token=secret-url`;
  for (const fetchImpl of [
    async () => new Response(secret, { status: 401 }),
    async () => { throw new Error(secret); },
    async () => new Response(secret),
    async () => responseFor(undefined, { error: { message: secret } }),
    async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: secret } }] })),
    async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } })),
  ]) {
    await assert.rejects(createCodeModel({ config, fetchImpl })({ task, files }), error => {
      assert.ok(!error.message.includes(config.apiKey));
      assert.ok(!error.message.includes('private.invalid'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('响应按实际字节流限制 128 KiB，超限即取消且不读取整个正文', async () => {
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(70 * 1024).fill(97)); },
    cancel() { cancelled = true; },
  });
  const model = createCodeModel({ config, fetchImpl: async () => new Response(stream, { headers: { 'Content-Length': '1' } }) });
  await assert.rejects(model({ task, files }), /超过 128 KiB/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test('取消发生在请求前和请求期间时不回显取消原因', async () => {
  const before = new AbortController();
  before.abort(config.apiKey);
  let calls = 0;
  await assert.rejects(createCodeModel({ config, fetchImpl: async () => { calls++; } })({ task, files, signal: before.signal }), { name: 'AbortError', message: '编码模型请求已取消。' });
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = createCodeModel({ config, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(config.apiKey)), { once: true });
    queueMicrotask(() => during.abort(config.apiKey));
  }) })({ task, files, signal: during.signal });
  await assert.rejects(pending, { name: 'AbortError', message: '编码模型请求已取消。' });
});

test('读取响应期间取消可结束挂起的读取并取消流', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const stream = new ReadableStream({
    pull() { reading(); },
    cancel() { cancelled = true; },
  });
  const pending = createCodeModel({ config, fetchImpl: async () => new Response(stream) })({ task, files, signal: controller.signal });
  await started;
  controller.abort(config.apiKey);
  await assert.rejects(pending, { name: 'AbortError', message: '编码模型请求已取消。' });
  assert.equal(cancelled, true);
});
