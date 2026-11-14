import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, mkdir, rename, writeFile, stat, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { ProjectStore } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { createSourceChangeService } from '../lib/source-change-service.mjs';
import { contentRevision } from '../lib/planning-review.mjs';
import { HttpError } from '../lib/documents.mjs';
import * as basePlanner from '../lib/planner.mjs';

const source = { filename: '需求.md', content: '用户可以读取资源。' };
const specification = text => ({ title: '资源', summary: text, goals: [], roles: [], questions: [], constraints: [], assumptions: [], acceptanceScenarios: [],
  stack: { frontend: 'HTML', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R1', title: '读取资源', description: text, sourceQuote: text, acceptance: ['读取成功'] }], sourceMode: 'local' });
const planner = { ...basePlanner, getModelConfig: () => ({ configured: true }), analyzeRequirements: specification,
  generateTasks: () => [{ id: '任务/一', title: '资源', description: '按规格读取资源', dependsOn: [], requirementIds: ['R1'], suggestedFiles: ['src/app.mjs'], acceptance: ['符合规格'] }] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() >= end) throw new Error('等待检查点超时'); await delay(5); } }
async function setup(t, { override = {}, stepDelayMs = 0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-change-test-')), dataDir = path.join(root, 'projects'), changeRoot = path.join(root, 'changes');
  const store = await new ProjectStore(dataDir).init(), orchestrator = new Orchestrator(store, { ...planner, ...override }, { stepDelayMs });
  const project = await store.create({ name: '资源项目', source: structuredClone(source) }), services = [], orchestrators = [orchestrator], cleanup = [];
  const env = { root, dataDir, changeRoot, store, orchestrator, project, executionState: 'none', service: null };
  env.cleanup = callback => cleanup.push(callback);
  env.open = async (nextStore = env.store, nextOrchestrator = env.orchestrator) => {
    const service = await createSourceChangeService({ rootDir: changeRoot, store: nextStore, withCheckpoint: (pid, work) => nextOrchestrator.withProjectCheckpoint(pid, async () => {
      if (env.executionState !== 'none') throw Object.assign(new Error('private execution detail: ' + changeRoot), { status: 409, code: env.executionState === 'unknown' ? 'reconciliation_required' : 'project_busy' });
      return work();
    }) }); services.push(service); env.service = service; return service;
  };
  env.restore = async () => { const restoredStore = await new ProjectStore(dataDir).init(), restored = new Orchestrator(restoredStore, planner, { stepDelayMs: 0 }); orchestrators.push(restored); await restored.init(); env.store = restoredStore; env.orchestrator = restored; env.project = restoredStore.get(project.id); return env.open(restoredStore, restored); };
  await env.open();
  t.after(async () => { await Promise.all(services.map(service => service.shutdown())); await Promise.all(orchestrators.map(instance => instance.shutdown())); for (const close of cleanup) await close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('source-change-test-')); await rm(root, { recursive: true, force: true }); });
  return env;
}
function request(env, extra = {}) { return env.service.request({ projectId: env.project.id, baseRevision: env.store.getSourceVersion(env.project.id).revision, source: { ...source, content: '用户可以读取和更新资源。' }, reason: '增加更新能力', kind: 'field', requestKey: randomUUID(), ...extra }); }
const apply = (env, change, extra = {}) => env.service.apply({ projectId: env.project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation, ...extra });
async function waiting(env, target = 'awaiting_spec') {
  const run = await env.orchestrator.createRun(env.project.id);
  await waitFor(() => run.status === 'awaiting_spec' && !env.orchestrator.state(run).driving && !env.orchestrator.state(run).active.size);
  if (target === 'awaiting_review') { await env.orchestrator.action(env.project.id, run.id, { action: 'approve_spec', revision: run.specRevision }); await waitFor(() => run.status === target && !env.orchestrator.state(run).driving && !env.orchestrator.state(run).active.size); }
  return run;
}

test('pending survives active stage writes; applying waits for an explicit quiescent checkpoint and new run uses new snapshot', async t => {
  const gate = deferred(); const env = await setup(t, { override: { analyzeWithModel: async (text, name, options) => { await gate.promise; return basePlanner.analyzeWithModel(text, name, { ...options, config: { baseUrl: 'http://localhost', model: 'source-fixture', apiKey: '' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(specification(text)) } }] })) }); } } });
  const run = await env.orchestrator.createRun(env.project.id, { mode: 'model' }); await waitFor(() => run.stages.find(stage => stage.id === 'spec').status === 'running');
  const change = request(env); assert.equal(change.status, 'pending'); assert.equal(env.project.sourceGeneration, undefined);
  await assert.rejects(apply(env, change), { status: 409, code: 'project_busy' }); assert.equal(env.service.list({ projectId: env.project.id })[0].status, 'pending');
  gate.resolve(); await waitFor(() => run.status === 'awaiting_spec' && !env.orchestrator.state(run).active.size && !env.orchestrator.state(run).driving);
  assert.equal(env.service.list({ projectId: env.project.id }).length, 1); assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(env.dataDir, env.project.id + '.json'))), 'changeRequests'), false);
  const old = structuredClone(run), oldSpec = run.spec, oldSnapshot = run.sourceSnapshot;
  const applied = await apply(env, change); assert.equal(applied.status, 'applied'); assert.equal(applied.draft.impact.reusableValidation, false);
  assert.equal(env.project.runs[0], run); assert.equal(run.spec, oldSpec); assert.equal(run.sourceSnapshot, oldSnapshot); assert.equal(run.specRevision, old.specRevision); assert.deepEqual(run.approvals, old.approvals);
  assert.equal(run.sourceSuperseded, true); assert.deepEqual(run.sourceSnapshot, source); assert.equal(env.project.sourceGeneration, 1); assert.equal(env.project.sourceVersions.length, 2);
  for (const action of ['approve_spec', 'revise_spec', 'resume', 'retry', 'approve']) await assert.rejects(env.orchestrator.action(env.project.id, run.id, { action, revision: run.specRevision }), { status: 409, code: 'source_superseded' });
  const next = await env.orchestrator.createRun(env.project.id); assert.equal(next.sourceGeneration, 1); assert.deepEqual(next.sourceSnapshot, change.source); assert.notEqual(next.sourceRevision, old.sourceRevision); assert.deepEqual(next.approvals, { spec: null, plan: null });
  await waitFor(() => next.status === 'awaiting_spec' && !env.orchestrator.state(next).driving && !env.orchestrator.state(next).active.size);
  await env.orchestrator.action(env.project.id, next.id, { action: 'approve_spec', revision: next.specRevision });
  await waitFor(() => next.status === 'awaiting_review' && !env.orchestrator.state(next).driving && !env.orchestrator.state(next).active.size);
  await env.orchestrator.action(env.project.id, next.id, { action: 'approve_plan', revision: next.planRevision, specRevision: next.specRevision });
  await waitFor(() => next.status === 'succeeded' && !env.orchestrator.state(next).driving && !env.orchestrator.state(next).active.size);
  const exported = JSON.parse(next.artifacts.find(item => item.name === 'plan.json').content); assert.equal(exported.sourceGeneration, 1); assert.equal(exported.sourceRevision, change.sourceRevision); assert.equal(run.sourceSuperseded, true);
});

test('latest safe plan is projected at apply, old structure-passed is not software validation; malformed paths fall back to unknown', async t => {
  const env = await setup(t); const change = request(env); assert.equal(change.projection, 'unknown');
  const run = await waiting(env, 'awaiting_review'); const old = structuredClone(run);
  const published = await apply(env, change); assert.equal(published.appliedProjection, 'projected'); assert.deepEqual(published.appliedDraft.impact.requirementIds, ['R1']); assert.deepEqual(published.appliedDraft.impact.taskIds, ['任务/一']);
  assert.equal(published.appliedDraft.previousPlan.tasks[0].validationStatus, 'unknown'); assert.equal(published.appliedDraft.impact.requiresMigrationReview, true); assert.deepEqual(run.artifacts, old.artifacts); assert.equal(run.planRevision, old.planRevision); assert.deepEqual(run.approvals, old.approvals);
  const second = await waiting(env, 'awaiting_review'); second.tasks[0].suggestedFiles = ['../host']; await env.store.save(env.project);
  const unknown = request(env, { source: { filename: 'rename.txt', content: env.project.source.content } }); assert.equal(unknown.projection, 'unknown'); assert.equal(unknown.draft.changes.metadataOnly, true);
  assert.equal(unknown.draft.impact.allDownstream, true); assert.equal(unknown.draft.impact.requiresFullRegression, true); await apply(env, unknown);
});

test('requestKey binds exact body; double applications and stale base cannot publish twice or alter historical replay', async t => {
  const env = await setup(t), first = request(env), second = request(env, { source: { ...source, content: '另一种资源需求。' } });
  const repeated = request(env, { requestKey: first.requestKey }); assert.equal(repeated.id, first.id); assert.equal(env.service.list({ projectId: env.project.id }).length, 2);
  assert.throws(() => request(env, { requestKey: first.requestKey, reason: 'different' }), { status: 409, code: 'request_conflict' });
  const results = await Promise.allSettled([apply(env, first), apply(env, first), apply(env, second)]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(env.project.sourceVersions.length, 2); assert.equal(env.project.sourceGeneration, 1);
  const filename = path.join(env.dataDir, env.project.id + '.json'), before = await readFile(filename), modified = (await stat(filename)).mtimeMs;
  assert.equal((await apply(env, first)).status, 'applied'); assert.deepEqual(await readFile(filename), before); assert.equal((await stat(filename)).mtimeMs, modified);
  assert.equal(request(env, { requestKey: first.requestKey, baseRevision: first.baseRevision }).id, first.id);
  await assert.rejects(apply(env, second), { status: 409, code: 'stale_revision' });
  assert.throws(() => request(env, { baseRevision: first.baseRevision }), { status: 409, code: 'stale_revision' });
});

test('returning to identical old source bytes creates a new generation and cannot resurrect old approvals or pending requests', async t => {
  const env = await setup(t), run = await waiting(env, 'awaiting_review'), originalRevision = run.sourceRevision;
  const stale = request(env, { source: { ...source, content: '基于最初版本的另一个变更。' } }), first = request(env), staleClone = structuredClone(env.project);
  await apply(env, first); const flags = { at: run.sourceSupersededAt, by: run.supersededByChangeId };
  const back = request(env, { source: structuredClone(source), reason: '明确回退输入，但仍须重新确认与回归' }); await apply(env, back);
  assert.equal(env.project.currentSourceRevision, originalRevision); assert.equal(env.project.sourceGeneration, 2); assert.equal(run.sourceSuperseded, true);
  assert.deepEqual({ at: run.sourceSupersededAt, by: run.supersededByChangeId }, flags);
  await assert.rejects(env.orchestrator.action(env.project.id, run.id, { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision }), { status: 409, code: 'source_superseded' });
  await assert.rejects(apply(env, stale), { status: 409, code: 'stale_revision' }); await assert.rejects(env.store.save(staleClone), { status: 409 });
  const fresh = await env.orchestrator.createRun(env.project.id); assert.equal(fresh.sourceGeneration, 2); assert.equal(fresh.sourceRevision, originalRevision); assert.deepEqual(fresh.approvals, { spec: null, plan: null });
});

test('checkpoint is synchronous, blocks create/approval, releases on failure, and drains existing queued writes', async t => {
  const env = await setup(t), run = await waiting(env), gate = deferred(), entered = deferred();
  const barrier = env.orchestrator.withProjectCheckpoint(env.project.id, async () => { entered.resolve(); await gate.promise; return 42; });
  await assert.rejects(env.orchestrator.createRun(env.project.id), { status: 409, code: 'project_checkpoint' });
  await assert.rejects(env.orchestrator.action(env.project.id, run.id, { action: 'approve_spec', revision: run.specRevision }), { status: 409, code: 'project_checkpoint' });
  await assert.rejects(env.orchestrator.withProjectCheckpoint(env.project.id, async () => {}), { status: 409, code: 'project_checkpoint' });
  await entered.promise; gate.resolve(); assert.equal(await barrier, 42);
  const sentinel = new Error('trusted sentinel'); await assert.rejects(env.orchestrator.withProjectCheckpoint(env.project.id, async () => { throw sentinel; }), error => error === sentinel);
  const stale = structuredClone(env.project), oldSave = env.store.save(env.project), change = request(env);
  await Promise.all([oldSave, apply(env, change)]); const filename = path.join(env.dataDir, env.project.id + '.json');
  await assert.rejects(env.store.save(stale), { status: 409 });
  const before = await readFile(filename); env.orchestrator.schedule(env.project, run); await delay(15); assert.deepEqual(await readFile(filename), before); assert.equal(env.store.getPersistedProject(env.project.id).currentSourceRevision, change.sourceRevision);
});

test('approval/create in flight and every planning/execution active state reject application without recording intent', async t => {
  const env = await setup(t), run = await waiting(env), change = request(env);
  const approve = env.orchestrator.action(env.project.id, run.id, { action: 'approve_spec', revision: run.specRevision });
  await assert.rejects(apply(env, change), { status: 409 }); await approve;
  await waitFor(() => run.status === 'awaiting_review' && !env.orchestrator.state(run).active.size && !env.orchestrator.state(run).driving);
  for (const key of ['driving', 'actionBusy']) { env.orchestrator.state(run)[key] = true; await assert.rejects(apply(env, change), { status: 409 }); env.orchestrator.state(run)[key] = false; }
  env.orchestrator.projectActions = new Set([env.project.id]); await assert.rejects(apply(env, change), { status: 409 }); env.orchestrator.projectActions.clear();
  for (const state of ['active', 'preview', 'unknown', 'inflight']) { env.executionState = state; await assert.rejects(apply(env, change), error => { assert.equal(error.status, 409); assert.equal(error.message.includes(env.changeRoot), false); return true; }); }
  assert.equal(env.service.list({ projectId: env.project.id })[0].status, 'pending'); assert.equal(env.project.sourceGeneration, undefined); env.executionState = 'none'; await apply(env, change);
  const fresh = await env.orchestrator.createRun(env.project.id); const newer = request(env, { source: { ...source, content: '再变更。' } }); await assert.rejects(apply(env, newer), { status: 409 }); await waitFor(() => fresh.status === 'awaiting_spec');
});

test('creating a run before its first save is a project operation even when no stage or drive is active', async t => {
  const env = await setup(t), change = request(env), entered = deferred(), release = deferred(), save = env.store.save.bind(env.store); let held = false;
  env.store.save = async project => { if (!held && project.runs.length) { held = true; entered.resolve(); await release.promise; } return save(project); };
  const creating = env.orchestrator.createRun(env.project.id);
  try { await entered.promise; assert.equal(env.orchestrator.runtime.size, 0); await assert.rejects(apply(env, change), { status: 409, code: 'project_busy' }); assert.equal(env.service.list({ projectId: env.project.id })[0].status, 'pending'); }
  finally { release.resolve(); await creating; env.store.save = save; }
  assert.equal(env.project.sourceGeneration, undefined);
});

test('paused boundary can apply; legacy snapshots are frozen and old resume/retry/init never dispatches', async t => {
  const env = await setup(t, { stepDelayMs: 30 }), run = await env.orchestrator.createRun(env.project.id);
  await waitFor(() => run.stages[0].status === 'running'); await env.orchestrator.action(env.project.id, run.id, { action: 'pause' });
  await waitFor(() => !env.orchestrator.state(run).active.size && !env.orchestrator.state(run).driving);
  delete run.workflowVersion; delete run.sourceSnapshot; delete run.sourceRevision; await env.store.save(env.project);
  const change = request(env), publishing = apply(env, change);
  await assert.rejects(env.orchestrator.action(env.project.id, run.id, { action: 'resume' }), { status: 409, code: 'project_checkpoint' });
  await publishing; assert.deepEqual(run.sourceSnapshot, source); assert.equal(run.sourceRevision, contentRevision(source)); assert.equal(run.status, 'paused');
  await assert.rejects(env.orchestrator.action(env.project.id, run.id, { action: 'resume' }), { status: 409, code: 'source_superseded' });
  await env.service.shutdown(); await env.orchestrator.shutdown(); await env.restore();
  const historical = env.project.runs[0]; assert.equal(historical.status, 'paused'); assert.equal(historical.sourceSuperseded, true); assert.equal(historical.stages.find(stage => stage.id === 'spec').attempt, 0);
  assert.equal((await env.orchestrator.createRun(env.project.id)).sourceGeneration, 1);
});

test('actual JSON rename failure preserves live source/approval/version identities and marks interrupted', async t => {
  const env = await setup(t), run = await waiting(env, 'awaiting_review'), change = request(env), old = structuredClone(env.project);
  const filename = path.join(env.dataDir, env.project.id + '.json'), backup = filename + '.backup'; await rename(filename, backup); await mkdir(filename);
  await assert.rejects(apply(env, change), { status: 503, code: 'publication_failed' });
  assert.deepEqual(env.project, old); assert.deepEqual(env.store.getPersistedProject(env.project.id).source, old.source); assert.deepEqual(run.approvals, old.runs[0].approvals); assert.equal(env.service.list({ projectId: env.project.id })[0].status, 'apply_interrupted');
  await rm(filename, { recursive: true }); await rename(backup, filename);
  await env.service.shutdown(); await env.open(); assert.equal(env.service.list({ projectId: env.project.id })[0].status, 'apply_interrupted'); assert.equal(env.project.sourceGeneration, undefined);
  await assert.rejects(apply(env, change), { status: 409 });
});

test('SQLite final-ack failure preserves authoritative JSON; recovery only completes bookkeeping and blocks ambiguous next apply', async t => {
  const env = await setup(t), change = request(env), database = new DatabaseSync(path.join(env.changeRoot, 'changes.sqlite')); env.cleanup(() => database.close());
  database.exec("CREATE TRIGGER fail_ack BEFORE UPDATE OF status ON changes WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'trusted failure injection'); END;");
  await assert.rejects(apply(env, change), { status: 503, code: 'publication_pending_confirmation' });
  assert.equal(env.project.appliedChangeId, change.id); assert.equal(env.project.sourceGeneration, 1); assert.equal(env.service.list({ projectId: env.project.id })[0].status, 'applying');
  assert.throws(() => request(env, { source: { ...source, content: 'more' } }), { status: 409, code: 'project_busy' });
  database.exec('DROP TRIGGER fail_ack;'); await env.service.shutdown(); await env.open();
  assert.equal(env.service.list({ projectId: env.project.id })[0].status, 'applied'); assert.equal(env.project.sourceVersions.length, 2); await apply(env, change); assert.equal(env.project.sourceVersions.length, 2);
});

async function crashChild(env, change, after) {
  const storeUrl = new URL('../lib/store.mjs', import.meta.url).href, serviceUrl = new URL('../lib/source-change-service.mjs', import.meta.url).href;
  const program = `import {ProjectStore} from ${JSON.stringify(storeUrl)};import {createSourceChangeService} from ${JSON.stringify(serviceUrl)};
  const store=await new ProjectStore(${JSON.stringify(env.dataDir)}).init();const service=await createSourceChangeService({rootDir:${JSON.stringify(env.changeRoot)},store,withCheckpoint:async(_pid,work)=>work()});
  const publish=store.publishSourceChange.bind(store);store.publishSourceChange=async(...args)=>{${after ? 'await publish(...args);' : ''}process.exit(${after ? 24 : 23});};
  await service.apply(${JSON.stringify({ projectId: env.project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation })});`;
  return new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', program], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', value => { stderr += value; }); child.on('error', reject); child.on('close', code => { if (code !== (after ? 24 : 23)) reject(new Error('trusted crash child failed: ' + stderr)); else resolve(code); }); });
}
test('real controller exits before/after JSON publication reconcile applying intent without automatic replay', async t => {
  for (const after of [false, true]) await t.test(after ? 'after publication' : 'before publication', async t => {
    const env = await setup(t), change = request(env); await env.service.shutdown(); await env.orchestrator.shutdown();
    await crashChild(env, change, after); await env.restore(); const row = env.service.list({ projectId: env.project.id })[0];
    assert.equal(row.status, after ? 'applied' : 'apply_interrupted'); assert.equal(env.project.sourceGeneration, after ? 1 : undefined); assert.equal(env.project.runs.length, 0);
    const bytes = await readFile(path.join(env.dataDir, env.project.id + '.json')); await delay(10); assert.deepEqual(await readFile(path.join(env.dataDir, env.project.id + '.json')), bytes);
    if (after) { await apply(env, change); assert.equal(env.project.sourceVersions.length, 2); } else { await assert.rejects(apply(env, change), { status: 409 }); assert.deepEqual(env.project.source, source); }
  });
});

test('single owner, private root links/database hardlinks, strict JSON fields and bounded requests/versions', async t => {
  const env = await setup(t);
  await assert.rejects(createSourceChangeService({ rootDir: env.changeRoot, store: env.store, withCheckpoint: () => {} }), { status: 409, code: 'service_owned' });
  let getters = 0; const bad = { projectId: env.project.id }; Object.defineProperty(bad, 'source', { enumerable: true, get() { getters++; return source; } });
  assert.throws(() => env.service.request(bad)); assert.equal(getters, 0);
  assert.throws(() => request(env, { withCheckpoint: () => {} })); assert.throws(() => request(env, { source: { ...source, path: env.root } })); assert.throws(() => request(env, { source: { ...source, content: 'x'.repeat(100001) } }));
  for (let generation = 0; generation < 19; generation++) { const change = request(env, { source: { ...source, content: '输入版本' + generation } }); await apply(env, change); }
  const final = request(env, { source: { ...source, content: 'overflow' } }); await assert.rejects(apply(env, final), { status: 409, code: 'version_limit' });
  assert.throws(() => request(env), { status: 409, code: 'request_limit' }); assert.equal(env.service.list({ projectId: env.project.id }).length, 20); assert.equal(env.project.sourceVersions.length, 20);
  assert.equal(JSON.stringify(env.service.list({ projectId: env.project.id })).includes(env.changeRoot), false);
  await env.service.shutdown(); const hard = path.join(env.root, 'hard-db'); await link(path.join(env.changeRoot, 'changes.sqlite'), hard);
  await assert.rejects(env.open(), { status: 500, code: 'invalid_root' }); await rm(hard);
  const alias = path.join(env.root, 'alias'); await symlink(env.changeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSourceChangeService({ rootDir: path.join(alias, 'never-create'), store: env.store, withCheckpoint: () => {} }), { status: 500, code: 'invalid_root' }); assert.equal((await readdir(env.changeRoot)).includes('never-create'), false);
});

test('shutdown waits an admitted checkpoint and does not automatically execute pending requests', async t => {
  const env = await setup(t), change = request(env), gate = deferred(), entered = deferred();
  const original = env.store.publishSourceChange.bind(env.store); env.store.publishSourceChange = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const pending = apply(env, change); await entered.promise; let closed = false;
  const stopping = env.service.shutdown().then(() => { closed = true; }); await delay(10); assert.equal(closed, false);
  assert.throws(() => request(env), { status: 503 }); gate.resolve(); await pending; await stopping; assert.equal(env.project.sourceGeneration, 1);
});

test('full valid inputs containing getters/functions are rejected without execution; DTO edits cannot grant impact or change source', async t => {
  const env = await setup(t); let getters = 0;
  const valid = () => ({ projectId: env.project.id, baseRevision: contentRevision(source), source: structuredClone(source), reason: 'rename', kind: 'field', requestKey: randomUUID() });
  for (const key of ['projectId', 'baseRevision', 'source', 'reason', 'kind', 'requestKey']) { const input = valid(); Object.defineProperty(input, key, { enumerable: true, get() { getters++; return 'wrong'; } }); assert.throws(() => env.service.request(input)); }
  for (const key of ['filename', 'content']) { const input = valid(); Object.defineProperty(input.source, key, { enumerable: true, get() { getters++; return 'wrong'; } }); assert.throws(() => env.service.request(input)); }
  assert.equal(getters, 0); assert.equal(env.service.list({ projectId: env.project.id }).length, 0);
  const change = request(env), expected = structuredClone(change.source); change.source.content = 'forged'; change.draft.impact.requiresNewSpecApproval = false;
  const list = env.service.list({ projectId: env.project.id }); assert.deepEqual(list[0].source, expected); assert.equal(list[0].draft.impact.requiresNewSpecApproval, true);
  const input = { projectId: env.project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation }, applying = env.service.apply(input);
  input.baseRevision = 'c'.repeat(64); input.generation = 100; await applying; assert.deepEqual(env.project.source, expected);
});

test('foreign checkpoint failures have fixed public errors and keep pending intent untouched', async t => {
  let foreignHttp = false;
  const env = await setup(t), service = await createSourceChangeService({ rootDir: path.join(env.root, 'other-controller'), store: env.store, withCheckpoint: async () => { throw foreignHttp ? new HttpError(409, env.root + '/private-debug-secret') : new Error(env.root + '/private-debug-secret'); } }); env.cleanup(() => service.shutdown());
  const change = service.request({ projectId: env.project.id, baseRevision: contentRevision(source), source: { ...source, content: 'change' }, reason: 'change', kind: 'other', requestKey: 'error-case' });
  await assert.rejects(service.apply({ projectId: env.project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation }), error => { assert.equal(error.status, 500); assert.equal(error.code, 'checkpoint_failed'); assert.equal(error.message.includes(env.root), false); assert.equal(error.message.includes('private-debug-secret'), false); return true; });
  foreignHttp = true;
  await assert.rejects(service.apply({ projectId: env.project.id, changeId: change.id, baseRevision: change.baseRevision, generation: change.generation }), error => { assert.equal(error.status, 409); assert.equal(error.code, 'project_busy'); assert.equal(error.message.includes(env.root), false); assert.equal(error.message.includes('private-debug-secret'), false); return true; });
  assert.equal(service.list({ projectId: env.project.id })[0].status, 'pending'); assert.deepEqual(env.project.source, source);
});
