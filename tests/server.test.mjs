import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { createZip } from '../lib/zip.mjs';
import { extractDocx, parseDocument } from '../lib/documents.mjs';

const planner = {
  getModelConfig: () => ({ configured: false, model: '', baseUrl: '' }),
  analyzeRequirements: (content, title) => ({ title, summary: '需求规格', goals: ['实现需求'], roles: [], constraints: [], assumptions: [], questions: [], acceptanceScenarios: [],
    stack: { frontend: '原生HTML', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '任务功能', description: content, acceptance: ['能创建任务'], sourceQuote: content, kind: 'functional' }] }),
  generateTasks: () => [{ id: 'DEV-1', title: '实现功能', description: '创建与查询任务', category: '功能实现', suggestedFiles: ['src/tasks.mjs'], dependsOn: [], acceptance: ['通过验收'], requirementIds: ['R1'] }],
  validateTaskGraph: () => {},
  renderSpec: spec => `# ${spec.title}\n${spec.requirements[0].description}`,
  renderArchitecture: () => '# 架构设计',
  renderTasks: () => '# 开发任务\n\n- DEV-1',
  reviewPlan: () => ({ passed: true, issues: [], summary: '检查通过', coverage: [] }),
  renderReview: () => '# 检查通过',
  renderHandoff: (spec, tasks, review, feedback) => `# 交接\n${feedback}`,
};

async function start(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-server-'));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>工作台</title>');
  const app = await createApp({ dataDir: path.join(directory, 'data'), publicDir, stepDelayMs: 0, planner });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, body) => {
    const response = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { base, request, app };
}

test('真实 HTTP 上传、生成、人工确认、单文件和文档包下载', async t => {
  const { base, request, app } = await start(t);
  assert.equal((await request('/api/health')).body.ok, true);
  assert.match(await (await fetch(base)).text(), /工作台/u);
  const created = await request('/api/projects', { filename: '需求.md', name: '团队项目', content: '# 需求\n用户创建任务，团队查看开发进展。' });
  assert.equal(created.status, 201);
  const projectId = created.body.project.id;
  const result = await request(`/api/projects/${projectId}/runs`, { mode: 'local' });
  assert.equal(result.status, 201);
  const runId = result.body.run.id;
  let run;
  for (let i = 0; i < 100; i++) {
    run = (await request(`/api/projects/${projectId}/runs/${runId}`)).body.run;
    if (run.status === 'awaiting_spec') break;
    await delay(10);
  }
  assert.equal(run.status, 'awaiting_spec');
  assert.equal(run.stages.find(item => item.id === 'tasks').status, 'pending');
  assert.equal((await request(`/api/projects/${projectId}/runs/${runId}/action`, { action: 'approve', feedback: '不能绕过规格确认' })).status, 409);
  assert.equal((await request(`/api/projects/${projectId}/runs/${runId}/action`, { action: 'approve_spec', revision: 'old-version' })).status, 409);
  assert.equal((await request(`/api/projects/${projectId}/runs/${runId}/action`, { action: 'approve_spec', revision: run.specRevision })).status, 200);
  for (let i = 0; i < 100; i++) {
    run = (await request(`/api/projects/${projectId}/runs/${runId}`)).body.run;
    if (run.status === 'awaiting_review') break;
    await delay(10);
  }
  assert.equal(run.status, 'awaiting_review');
  assert.equal((await fetch(`${base}/api/projects/${projectId}/runs/${runId}/download`)).status, 409);
  const artifact = await fetch(`${base}/api/projects/${projectId}/runs/${runId}/artifacts/task.md?download=1`);
  assert.equal(artifact.status, 200);
  assert.match(artifact.headers.get('content-disposition'), /task\.md/u);
  assert.match(await artifact.text(), /DEV-1/u);
  assert.equal((await request(`/api/projects/${projectId}/runs/${runId}/action`, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision, feedback: '评审通过' })).status, 200);
  for (let i = 0; i < 100; i++) {
    run = (await request(`/api/projects/${projectId}/runs/${runId}`)).body.run;
    if (run.status === 'succeeded') break;
    await delay(10);
  }
  assert.equal(run.status, 'succeeded');
  const project = app.store.get(projectId);
  project.source = { filename: 'later.md', content: '后续需求不会进入历史导出' };
  await app.store.save(project);
  const download = await fetch(`${base}/api/projects/${projectId}/runs/${runId}/download`);
  assert.equal(download.status, 200);
  const zip = Buffer.from(await download.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.match(zip.toString('utf8'), /requirements\.md/u);
  assert.match(zip.toString('utf8'), /task\.md/u);
  assert.match(zip.toString('utf8'), /评审通过/u);
  assert.match(zip.toString('utf8'), /用户创建任务，团队查看开发进展/u);
  assert.doesNotMatch(zip.toString('utf8'), /后续需求不会进入历史导出/u);
  assert.equal((await request('/api/projects')).body.projects[0].lastRunStatus, 'succeeded');
});

test('上传 DOCX 提取正文与实体，不把文档内文字当作指令执行', async t => {
  const { request } = await start(t);
  const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>需求 &amp; 约束</w:t></w:r></w:p><w:p><w:r><w:t>用户可以创建任务。</w:t></w:r></w:p></w:body></w:document>';
  const zip = createZip([{ name: 'word/document.xml', content: xml }]);
  assert.equal(extractDocx(zip).trim(), '需求 & 约束\n用户可以创建任务。');
  const result = await request('/api/projects', { filename: '软件需求.docx', fileBase64: zip.toString('base64') });
  assert.equal(result.status, 201);
  assert.equal(result.body.project.source.content, '需求 & 约束\n用户可以创建任务。');
  assert.equal((await request('/api/projects', { filename: '坏文档.docx', fileBase64: Buffer.from('not a zip').toString('base64') })).status, 400);
});

test('拒绝空白、过长和不支持文档；限制跨站写入；不泄露工作区文件', async t => {
  const { base, request } = await start(t);
  assert.equal((await request('/api/projects', { filename: '空.md', content: ' \n ' })).status, 400);
  assert.equal((await request('/api/projects', { filename: '需求.pdf', content: '内容' })).status, 400);
  assert.equal((await request('/api/projects', { filename: '大.md', content: 'a'.repeat(100001) })).status, 400);
  const response = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: JSON.stringify({ filename: '需求.md', content: '需求' }) });
  assert.equal(response.status, 403);
  assert.notEqual((await fetch(`${base}/%2e%2e/server.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/api/projects/missing`)).status, 404);
});

test('DOCX 解压限制可阻止超大正文，原始文件名只作显示数据', () => {
  const oversized = createZip([{ name: 'word/document.xml', content: 'x'.repeat(2 * 1024 * 1024 + 1) }]);
  assert.throws(() => extractDocx(oversized), /正文过大/u);
  const parsed = parseDocument({ filename: '../../需求.md', content: '用户可以登录。' });
  assert.equal(parsed.source.filename, '需求.md');
});
