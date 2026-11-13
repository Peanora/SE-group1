import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectCodeModel } from '../lib/project-code-model.mjs';

const config = { baseUrl: 'https://model.invalid/v1', model: 'project-model', apiKey: 'secret-project-key' };
const task = { id: 'web-1', specRevision: 'spec-confirmed', planRevision: 'plan-confirmed', requirements: '实现输入中指定的工单管理 Web 应用', design: { frontend: '原生 HTML', database: 'SQLite' } };
const files = [{ path: 'src/app.mjs', content: 'export async function createApp() { return {handle: async () => ({status: 503, headers: {}, body: "pending"})}; }' }];
const replacement = [
  { path: 'src/app.mjs', content: 'export async function createApp({databasePath}) { return {handle: async () => ({status: 200, headers: {}, body: "ok"})}; }' },
  { path: 'public/index.html', content: '<!doctype html><script src="/app.js" defer></script><link rel="stylesheet" href="/app.css">' },
  { path: 'public/app.js', content: 'document.title = "工单";' },
  { path: 'public/app.css', content: 'body { color: #333; }' },
];
const normalized = value => [...value].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function responseFor(proposal = { files: replacement }, extra = {}) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }], ...extra }));
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

test('项目模型发送完整任务资料及固定Web契约，只返回规范化多文件建议', async () => {
  await withEnv({ LLM_THINKING: 'disabled', LLM_JSON_MODE: '1', LLM_MAX_TOKENS: '99999' }, async () => {
    const controller = new AbortController();
    const feedback = [{ message: '需要修复工单权限' }];
    const model = createProjectCodeModel({ config, fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://model.invalid/v1/chat/completions');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      const body = JSON.parse(options.body);
      assert.equal(body.model, config.model);
      assert.equal(body.max_tokens, 8192);
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(JSON.parse(body.messages[1].content), { task, files, feedback });
      const system = body.messages[0].content;
      for (const required of ['src/app.mjs', 'createApp({databasePath})', 'body:string|Buffer', 'SQLite', 'stdout', 'console.log', 'public', 'self', 'Shell', '.platform']) assert.ok(system.includes(required), required);
      assert.ok(!options.body.includes(config.apiKey));
      return responseFor({ files: replacement, commands: ['ignored'], passed: true, status: 'accepted' }, { usage: { prompt_tokens: 100, completion_tokens: 80 } });
    } });
    assert.deepEqual(await model({ task, files, feedback, signal: controller.signal }), {
      files: normalized(replacement), usage: { inputTokens: 100, outputTokens: 80 }, model: config.model,
    });
  });
});

test('默认复用LLM配置，首次可不提供文件，未知或非法用量保留null', async () => {
  await withEnv({ LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey, LLM_THINKING: '', LLM_JSON_MODE: '0' }, async () => {
    const model = createProjectCodeModel({ fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      const request = JSON.parse(options.body);
      assert.equal('response_format' in request, false);
      assert.deepEqual(JSON.parse(request.messages[1].content).files, []);
      return responseFor(undefined, { usage: { prompt_tokens: -1, completion_tokens: '40' } });
    } });
    assert.deepEqual((await model({ task })).usage, { inputTokens: null, outputTokens: null });
  });
  for (const usage of [undefined, {}, { prompt_tokens: 0, completion_tokens: 0 }, { prompt_tokens: 12, completion_tokens: 1.5 }, { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: null }]) {
    const result = await createProjectCodeModel({ config, fetchImpl: async () => responseFor(undefined, { usage }) })({ task, files });
    assert.deepEqual(result.usage, { inputTokens: Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null, outputTokens: Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null });
  }
});

test('非法配置和不可序列化资料在发送前拒绝，不回显秘密', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return responseFor(); };
  for (const invalid of [{ ...config, baseUrl: 'file:///secret-project-key' }, { ...config, baseUrl: 'invalid secret-project-key' }, { ...config, baseUrl: 'https://secret-project-key@model.invalid/' }, { ...config, model: '' }]) {
    await assert.rejects(createProjectCodeModel({ config: invalid, fetchImpl })({ task, files }), error => !error.message.includes(config.apiKey));
  }
  await withEnv({ LLM_THINKING: 'bad-secret-project-key' }, async () => {
    await assert.rejects(createProjectCodeModel({ config, fetchImpl })({ task, files }), error => /LLM_THINKING/u.test(error.message) && !error.message.includes(config.apiKey));
  });
  const circular = {};
  circular.self = circular;
  await assert.rejects(createProjectCodeModel({ config, fetchImpl })({ task: circular, files }), /无法序列化/u);
  assert.equal(calls, 0);
});

test('输入不允许平台文件或越界路径，不向模型发送未授权资料', async () => {
  let calls = 0;
  const model = createProjectCodeModel({ config, fetchImpl: async () => { calls++; return responseFor(); } });
  for (const path of ['package.json', '.platform/secret-project-key.json', '../secret-project-key.txt', 'public/../data.json', 'src\\app.mjs', 'src/%2e%2e/secret.txt']) {
    await assert.rejects(model({ task, files: [{ path, content: 'sensitive input' }] }), error => /输入文件/u.test(error.message) && !error.message.includes(config.apiKey) && !error.message.includes('sensitive input'));
  }
  assert.equal(calls, 0);
});

test('输出路径、纯文本、数量和大小在模型响应后继续受校验，整批拒绝', async () => {
  for (const invalid of [
    { path: 'package.json', content: '{}' },
    { path: 'server.mjs', content: 'console.log(1)' },
    { path: '.platform/secret-project-key.json', content: 'secret-project-key' },
    { path: '../secret-project-key.txt', content: 'outside' },
    { path: 'public/CON.txt', content: 'reserved' },
    { path: 'src/app.mjs', content: '\0' },
    { path: 'public/large.txt', content: 'x'.repeat(128 * 1024 + 1) },
  ]) {
    const model = createProjectCodeModel({ config, fetchImpl: async () => responseFor({ files: [{ path: 'README.md', content: 'valid' }, invalid] }) });
    await assert.rejects(model({ task, files }), error => /输出文件/u.test(error.message) && !error.message.includes(config.apiKey));
  }
  const duplicate = [{ path: 'public/a.js', content: '' }, { path: 'public/A.js', content: '' }];
  const overCount = Array.from({ length: 61 }, (_, index) => ({ path: `src/file-${index}.js`, content: '' }));
  for (const rejected of [duplicate, overCount]) await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => responseFor({ files: rejected }) })({ task, files }), /输出文件/u);
});

test('空建议、非法JSON、无正常结束和截断结果不被当作已完成', async () => {
  for (const proposal of [null, {}, [], { files: [] }, { files: 'done' }, { files: [{ path: 1, content: '' }] }, { files: [{ path: 'src/app.mjs', content: null }] }]) {
    await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => responseFor(proposal) })({ task, files }), /文件建议|输出文件/u);
  }
  for (const [finish_reason, pattern] of [['length', /截断/u], ['content_filter', /未正常结束/u], [null, /未正常结束/u], ['tool_calls', /未正常结束/u]]) {
    await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => responseFor(undefined, { choices: [{ finish_reason, message: { content: '{"files":' } }] }) })({ task, files }), pattern);
  }
  await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => new Response('{"choices":') })({ task, files }), /有效 JSON 响应/u);
  await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => responseFor(undefined, { choices: [{ finish_reason: 'stop', message: { content: '{"files":' } }] }) })({ task, files }), /有效 JSON 文件建议/u);
});

test('服务错误、读取异常和响应正文中的URL与秘密不进入错误', async () => {
  const secret = `${config.apiKey} https://private.invalid/?token=secret-url`;
  for (const fetchImpl of [
    async () => new Response(secret, { status: 401 }),
    async () => { throw new Error(secret); },
    async () => new Response(secret),
    async () => responseFor(undefined, { error: { message: secret } }),
    async () => responseFor(undefined, { choices: [{ finish_reason: 'stop', message: { content: secret } }] }),
    async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } })),
    async () => ({ ok: true, body: { getReader() { throw new Error(secret); } } }),
  ]) {
    await assert.rejects(createProjectCodeModel({ config, fetchImpl })({ task, files }), error => {
      assert.ok(!error.message.includes(config.apiKey));
      assert.ok(!error.message.includes('private.invalid'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('多文件大于旧128KiB响应仍能读取，实际流超过512KiB立即停止', async () => {
  const large = [{ path: 'src/one.txt', content: 'x'.repeat(100 * 1024) }, { path: 'src/two.txt', content: 'y'.repeat(100 * 1024) }];
  assert.deepEqual((await createProjectCodeModel({ config, fetchImpl: async () => responseFor({ files: large }) })({ task, files })).files, large);
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(280 * 1024).fill(97)); },
    cancel() { cancelled = true; },
  });
  const model = createProjectCodeModel({ config, fetchImpl: async () => new Response(stream, { headers: { 'Content-Length': '1' } }) });
  await assert.rejects(model({ task, files }), /超过 512 KiB/u);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test('无可读正文与无效UTF8都失败，错误不包含流内容', async () => {
  await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => ({ ok: true, body: null }) })({ task, files }), /缺少可读取/u);
  const bytes = new Uint8Array([0xc3, 0x28]);
  await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => new Response(bytes) })({ task, files }), /有效的 UTF-8/u);
});

test('请求前或请求期间取消会停止，不回显取消原因', async () => {
  const before = new AbortController();
  before.abort(config.apiKey);
  let calls = 0;
  await assert.rejects(createProjectCodeModel({ config, fetchImpl: async () => { calls++; } })({ task, files, signal: before.signal }), { name: 'AbortError', message: '项目编码模型请求已取消。' });
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = createProjectCodeModel({ config, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(config.apiKey)), { once: true });
    queueMicrotask(() => during.abort(config.apiKey));
  }) })({ task, files, signal: during.signal });
  await assert.rejects(pending, { name: 'AbortError', message: '项目编码模型请求已取消。' });
});

test('读取挂起响应期间取消会关闭流，响应返回时已取消同样拒绝', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const stream = new ReadableStream({
    pull() { reading(); },
    cancel() { cancelled = true; },
  });
  const pending = createProjectCodeModel({ config, fetchImpl: async () => new Response(stream) })({ task, files, signal: controller.signal });
  await started;
  controller.abort(config.apiKey);
  await assert.rejects(pending, { name: 'AbortError', message: '项目编码模型请求已取消。' });
  assert.equal(cancelled, true);
  const after = new AbortController();
  let bodyCancelled = false;
  const late = createProjectCodeModel({ config, fetchImpl: async () => {
    after.abort(config.apiKey);
    return { ok: true, body: { cancel: async () => { bodyCancelled = true; } } };
  } });
  await assert.rejects(late({ task, files, signal: after.signal }), { name: 'AbortError', message: '项目编码模型请求已取消。' });
  assert.equal(bodyCancelled, true);
});
