import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { createZip } from '../lib/zip.mjs';
import { createSourceChangeService } from '../lib/source-change-service.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() >= end) throw new Error('等待规划停点超时'); await delay(5); } }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'source-change-http-'));
  const { listGate, ...appOptions } = options;
  let service;
  const forwarding = listGate ? {
    list: async input => { if (listGate.hold) { listGate.entered.resolve(); await listGate.release.promise; } return service.list(input); },
    request: input => service.request(input), apply: input => service.apply(input), shutdown: () => service?.shutdown(),
  } : undefined;
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, ...appOptions, ...(forwarding ? { sourceChangeService: forwarding } : {}) });
  if (forwarding) service = await createSourceChangeService({ rootDir: path.join(directory, 'source-changes'), store: app.store,
    withCheckpoint: (projectId, work) => app.orchestrator.withProjectCheckpoint(projectId, () => app.executionService.withProjectCheckpoint(projectId, () => app.verificationPlanningService.withProjectCheckpoint(projectId, work))) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('source-change-http-')); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const project = await app.store.create({ name: '输入变更接线', source: { filename: 'r.md', content: '# 功能\n用户可以查看资源。' } });
  const route = `/api/projects/${project.id}/changes`;
  const request = async (suffix = '', body) => {
    const response = await fetch(url + route + suffix, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, app, url, project, route, request };
}
const proposal = (current, requestKey = 'change-one') => ({ baseRevision: current.revision, source: { filename: 'r.md', content: '# 功能\n用户可以查看资源并查看说明字段。' }, reason: '新增资源说明字段', kind: 'field', requestKey });

test('HTTP pending/apply uses both real project checkpoints and keeps old runs read-only with a new source snapshot', async t => {
  const { app, project, request } = await fixture(t);
  const run = await app.orchestrator.createRun(project.id, { mode: 'local' });
  await waitFor(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving);
  const original = structuredClone(run), originalSource = structuredClone(project.source);
  const { body: before } = await request(); assert.equal(before.capabilities.canApply, true); assert.equal(before.current.generation, 0);
  const payload = proposal(before.current), saved = await request('', payload);
  assert.equal(saved.status, 201); const change = saved.body.change;
  assert.equal(change.status, 'pending'); assert.deepEqual(project.source, originalSource); assert.deepEqual(run, original);
  assert.equal(change.draft.impact.reusableValidation, false);
  assert.equal((await request('', payload)).body.change.id, change.id);
  assert.equal((await request('', { ...payload, reason: '其他内容' })).status, 409);
  const applied = await request(`/${change.id}/apply`, { baseRevision: change.baseRevision, generation: change.generation });
  assert.equal(applied.status, 200); assert.equal(applied.body.change.status, 'applied');
  assert.equal(project.sourceGeneration, 1); assert.equal(run.sourceSuperseded, true);
  assert.deepEqual(run.sourceSnapshot, original.sourceSnapshot); assert.equal(run.specRevision, original.specRevision);
  await assert.rejects(app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision }), { status: 409 });
  const again = await request(`/${change.id}/apply`, { baseRevision: change.baseRevision, generation: change.generation });
  assert.equal(again.status, 200); assert.equal(project.sourceVersions.length, 2);
  const next = await app.orchestrator.createRun(project.id, { mode: 'local' });
  assert.equal(next.sourceGeneration, 1); assert.deepEqual(next.sourceSnapshot, payload.source);
  const after = (await request()).body; assert.equal(after.current.generation, 1); assert.equal(after.changes[0].status, 'applied');
  assert.equal((await request('', { ...proposal(before.current, 'stale-new-key') })).status, 409);
});

test('active planning and an execution checkpoint retain pending changes until both real services are idle', async t => {
  const { app, project, request } = await fixture(t), entered = deferred(), release = deferred();
  const save = app.store.save.bind(app.store); let held = false;
  app.store.save = async value => { if (!held && value.runs.some(run => run.stages.some(stage => stage.status === 'running'))) { held = true; entered.resolve(); await release.promise; } return save(value); };
  const run = await app.orchestrator.createRun(project.id);
  try {
    await entered.promise;
    const { current } = (await request()).body, change = (await request('', proposal(current))).body.change;
    const body = { baseRevision: change.baseRevision, generation: change.generation };
    assert.equal((await request(`/${change.id}/apply`, body)).status, 409);
    assert.equal((await request()).body.changes[0].status, 'pending');
    release.resolve(); app.store.save = save;
    await waitFor(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving);
    const executing = deferred(), finish = deferred();
    const checkpoint = app.executionService.withProjectCheckpoint(project.id, async () => { executing.resolve(); await finish.promise; });
    try { await executing.promise; assert.equal((await request(`/${change.id}/apply`, body)).status, 409); assert.equal(project.sourceGeneration, undefined); }
    finally { finish.resolve(); await checkpoint; }
    const proposalEntered = deferred(), proposalFinish = deferred();
    const proposalCheckpoint = app.verificationPlanningService.withProjectCheckpoint(project.id, async () => { proposalEntered.resolve(); await proposalFinish.promise; });
    try { await proposalEntered.promise; assert.equal((await request(`/${change.id}/apply`, body)).status, 409); assert.equal(project.sourceGeneration, undefined); }
    finally { proposalFinish.resolve(); await proposalCheckpoint; }
    assert.equal((await request(`/${change.id}/apply`, body)).status, 200);
    assert.equal(project.sourceGeneration, 1); assert.equal(run.sourceSuperseded, true);
  } finally { release.resolve(); app.store.save = save; }
});

test('parse is read-only, precise fields reject client capabilities and source APIs enforce local access', async t => {
  const { app, url, project, route, request, directory } = await fixture(t);
  const document = createZip([{ name: 'word/document.xml', content: '<w:document><w:body><w:p><w:r><w:t>导入的新版需求</w:t></w:r></w:p></w:body></w:document>' }]);
  const parsed = await request('/parse', { filename: 'version.docx', fileBase64: document.toString('base64') });
  assert.equal(parsed.status, 200); assert.equal(parsed.body.source.content, '导入的新版需求');
  assert.equal((await request()).body.changes.length, 0); assert.equal(project.sourceGeneration, undefined);
  const current = app.store.getSourceVersion(project.id), base = proposal(current);
  for (const extra of ['projectId', 'withCheckpoint', 'workspace', 'report', 'sourceGeneration']) assert.equal((await request('', { ...base, [extra]: 'forbidden' })).status, 400);
  assert.equal((await request('', { ...base, source: { filename: '../outside.md', content: 'x' } })).status, 400);
  assert.equal((await request('/parse', { filename: 'x.md', content: 'text', fileBase64: 'extra' })).status, 400);
  const rebinding = await new Promise((resolve, reject) => { const q = http.get(url + route, { headers: { host: 'attacker.example' } }, r => { r.resume(); resolve(r.statusCode); }); q.once('error', reject); });
  assert.equal(rebinding, 403);
  const cross = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify(base) });
  assert.equal(cross.status, 403);
  assert.equal((await request()).body.changes.length, 0);
  assert.ok((await readdir(directory)).every(name => name === `${project.id}.json` || ['executions', 'source-changes', 'verification-planning'].includes(name)));
});

test('HTTP list reads the latest source when publication completes while its change list is awaiting', async t => {
  const listGate = { hold: false, entered: deferred(), release: deferred() };
  const { app, project, request } = await fixture(t, { listGate });
  const current = app.store.getSourceVersion(project.id), change = (await request('', proposal(current))).body.change;
  listGate.hold = true; const pendingList = request();
  try {
    await listGate.entered.promise;
    assert.equal((await request(`/${change.id}/apply`, { baseRevision: change.baseRevision, generation: change.generation })).status, 200);
  } finally { listGate.release.resolve(); }
  const { status, body } = await pendingList;
  assert.equal(status, 200); assert.equal(body.current.generation, 1);
  assert.equal(body.current.revision, change.draft.sourceRevision); assert.equal(body.changes[0].status, 'applied');
  assert.deepEqual(body.current.source, proposal(current).source);
});

test('unsupported execution coordination permits pending drafts but never publishes them, and disabled change service stays unavailable', async t => {
  const { app, project, request } = await fixture(t, { executionService: null });
  const original = structuredClone(project.source), before = (await request()).body;
  assert.equal(before.capabilities.canApply, false); assert.ok(before.capabilities.reason);
  const saved = await request('', proposal(before.current)); assert.equal(saved.status, 201);
  const change = saved.body.change;
  assert.equal((await request(`/${change.id}/apply`, { baseRevision: change.baseRevision, generation: change.generation })).status, 409);
  assert.equal((await request()).body.changes[0].status, 'pending'); assert.deepEqual(project.source, original); assert.equal(project.sourceGeneration, undefined);
  const disabled = await fixture(t, { executionService: null, sourceChangeService: null });
  assert.equal((await disabled.request()).status, 404);
});
