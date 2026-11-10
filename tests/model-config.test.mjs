import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithModel } from '../lib/planner.mjs';

const source = '用户可以新增待办事项。';
const config = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'mock-not-a-real-key' };
const spec = {
  title: '待办项目', summary: '管理待办事项', goals: ['新增待办'],
  requirements: [{ title: '新增待办', description: source, acceptance: ['新增后能看到事项'], sourceQuote: source, kind: 'functional' }],
  constraints: [], assumptions: [], questions: [], stack: { frontend: '待确认', backend: '待确认', storage: '待确认' },
};

async function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('DeepSeek 可配置非思考模式和 JSON 输出长度，不在文档中发布密钥', async () => {
  await withEnv({ LLM_THINKING: 'disabled', LLM_MAX_TOKENS: '16384', LLM_JSON_MODE: '1' }, async () => {
    let body;
    const result = await analyzeWithModel(source, '待办项目', { config, fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(spec) } }] }));
    } });
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 16384);
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(result.sourceMode, 'model');
    assert.ok(!JSON.stringify(result).includes(config.apiKey));
  });
});

test('模型配置错误在发送请求前被拒绝', async () => {
  for (const values of [{ LLM_THINKING: 'unknown' }, { LLM_THINKING: '', LLM_MAX_TOKENS: '-1' }]) {
    await withEnv(values, async () => {
      let called = false;
      await assert.rejects(analyzeWithModel(source, '测试', { config, fetchImpl: async () => { called = true; } }), /LLM_/);
      assert.equal(called, false);
    });
  }
});

test('被截断的模型输出明确报告长度问题', async () => {
  await assert.rejects(analyzeWithModel(source, '测试', { config, fetchImpl: async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: '{"title":' } }],
  })) }), /截断/);
});
