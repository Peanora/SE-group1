import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp } from '../../server.mjs';
import * as planner from '../../lib/planner.mjs';
import { createEngineeringModel } from '../../lib/engineering-model.mjs';

export const source = '成员可以查看资源，审核者复核预约。';
export const spec = { title: '接口权限修订', summary: source, goals: [], roles: ['成员：查看资源', '审核者：复核预约'], questions: [], constraints: [], assumptions: [], acceptanceScenarios: [], stack: { frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' }, sourceMode: 'model', requirements: [{ id: 'R-001', title: '查看资源', description: source, sourceQuote: source, acceptance: ['成员可查看资源列表'] }] };
export const proposal = { version: 1, title: '资源工程', summary: '实现资源列表', entities: [{ id: 'RESOURCE', name: '资源', fields: [{ name: 'id', type: 'string', required: true, unique: true }], constraints: ['资源编号唯一'] }], routes: [{ id: 'route-list', method: 'GET', path: '/api/resources', roles: ['ROLE-001', 'ROLE-002'], request: '无正文', response: '资源列表', errors: [{ status: 401, reason: '尚未登录' }], requirementIds: ['R-001'] }], views: [{ id: 'view-list', path: '/', title: '资源列表', selectors: [{ testId: 'resource-row', role: 'list' }], requirementIds: ['R-001'] }], tasks: [{ id: 'task-list', title: '资源模块', description: '实现资源接口和页面', requirementIds: ['R-001'], dependsOn: [], writePaths: ['src/app.mjs', 'public/app.js'], inputs: ['确认规格'], outputs: ['资源列表'], acceptance: ['列表可读取'] }] };
const response = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 7, completion_tokens: 11 } }));
export async function until(check) { const end = Date.now() + 10000; for (;;) { const value = await check(); if (value) return value; assert(Date.now() < end, '等待接口状态超时'); await new Promise(resolve => setTimeout(resolve, 10)); } }
export async function roleCase(t, { teamEnabled = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'engineering-role-http-')), calls = { spec: 0, engineering: 0 }, config = { baseUrl: 'https://model.invalid/v1', model: 'route-role-local', apiKey: 'synthetic-route-role-only' };
  const app = await createApp({ dataDir: directory, teamEnabled, stepDelayMs: 0, planner: { ...planner, getModelConfig: () => ({ configured: true, model: config.model }),
    analyzeWithModel: (text, name, options) => { calls.spec++; return planner.analyzeWithModel(text, name, { ...options, config, fetchImpl: async () => response(spec) }); },
    createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async () => { calls.engineering++; return response(proposal); } }) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('engineering-role-http-')); await rm(directory, { recursive: true, force: true }); });
  const request = async (route, body, cookie = '') => { const r = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const raw = await r.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return { status: r.status, value, cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  let owner = '';
  if (teamEnabled) { const created = await request('/api/team/setup', { name: 'owner', password: 'Route-role-fixture-password-2026' }); assert.equal(created.status, 201); owner = created.cookie; }
  const created = await request('/api/projects', { name: '接口权限项目', filename: 'r.md', content: source }, owner); assert.equal(created.status, 201); const projectId = created.value.project.id;
  const start = async () => {
    const result = await request(`/api/projects/${projectId}/runs`, { mode: 'model' }, owner); assert.equal(result.status, 201); const route = `/api/projects/${projectId}/runs/${result.value.run.id}`;
    const initial = await until(async () => { const { value } = await request(route, undefined, owner); return value.run.status === 'awaiting_spec' && value.run; });
    assert.equal((await request(route + '/action', { action: 'approve_spec', revision: initial.specRevision }, owner)).status, 200);
    const run = await until(async () => { const { value } = await request(route, undefined, owner); return value.run.status === 'awaiting_review' && value.run; }); return { route, run };
  };
  return { app, origin, calls, request, owner, projectId, start };
}
