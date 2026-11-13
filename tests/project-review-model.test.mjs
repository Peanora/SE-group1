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
