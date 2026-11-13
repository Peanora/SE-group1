import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createWebExecutionService, webExecutionContractRevision } from '../lib/web-execution-service.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { isWebTaskAccepted, startWebExecution } from '../lib/web-executor.mjs';
import { webManifest, databaseObserverHash } from '../lib/web-tests.mjs';
import { browserManifest } from '../lib/web-browser-tests.mjs';
import { projectReviewPolicy } from '../lib/project-review-model.mjs';
import { installWebShell } from '../lib/web-delivery.mjs';
import { applyProjectFiles } from '../lib/project-files.mjs';

const ids = { projectId: 'project-1', runId: 'run-1' };
const startInput = { ...ids, profileId: 'library-web-v1', contractRevision: webExecutionContractRevision };
const config = { baseUrl: 'http://localhost:1', model: 'trusted-test-model', apiKey: 'test-private-api-key' };
const files = [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:503,headers:{"content-type":"application/json"},body:"{\\"error\\":\\"business missing\\"}"}}}}\n' }];
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function planning() {
  const sourceSnapshot = { content: '# Unrelated upload\nTrack student attendance.', filename: 'private.md' }, spec = { title: 'Attendance planning', requirements: [] };
  const run = { id: ids.runId, workflowVersion: 2, status: 'succeeded', sourceSnapshot, sourceRevision: contentRevision(sourceSnapshot), spec,
    specRevision: contentRevision(spec), tasks: [], specQuestions: [], artifacts: [{ name: 'architecture.md', content: 'Confirmed architecture' }], review: { passed: true, issues: [] }, stages: [] };
  run.planRevision = planningRevision(run); run.approvals = { spec: { revision: run.specRevision }, plan: { revision: run.planRevision, specRevision: run.specRevision } };
  return { project: { id: ids.projectId, source: sourceSnapshot }, run };
}
async function fixture(t, overrides = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'web-service-test-')), state = { planning: planning(), calls: [], previews: [], deliveries: [], services: [] };
  t.after(async () => {
    for (const service of state.services.reverse()) { try { await service.shutdown(); } catch {} }
    assert.equal(path.dirname(path.resolve(rootDir)), path.resolve(os.tmpdir())); await rm(rootDir, { recursive: true, force: true });
  });
  const dependencies = {
    codeModel: settings => { assert.equal(settings.config.apiKey, config.apiKey); return async () => { throw new Error('No model call is authorized by these lifecycle tests'); }; },
    reviewModel: () => async () => { throw new Error('No review call is authorized'); },
    startExecution(options) {
      const finished = deferred(), record = { id: randomUUID(), ...options.binding, attemptId: randomUUID(), profileId: 'library-web-v1', providerKind: 'model', reviewerKind: 'model',
        status: 'generating', acceptanceStatus: 'not_checked', budget: { maxCalls: options.maxCalls, maxReviewCalls: options.maxReviewCalls, timeoutMs: options.timeoutMs },
        calls: 1, reviewCalls: 0, usage: { inputTokens: null, outputTokens: null }, versions: [], events: [], gitCommands: [] };
      const entry = { options, record, cancelled: 0, finish(change = {}) { Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString() }, change); finished.resolve(structuredClone(record)); } };
      state.calls.push(entry); return { id: record.id, snapshot: () => structuredClone(record), done: finished.promise,
        cancel() { entry.cancelled++; if (!state.manualCancel) entry.finish({ status: 'stopped' }); } };
    },
    verifySource: async () => ({ files: structuredClone(files), shellHash: 'c'.repeat(64) }),
    startRuntime: async options => {
      const done = deferred(), entry = { options, stopped: 0, result: { status: 'stopped', exitCode: 0, stopAcknowledged: true, sourceUnchanged: true, terminationConfirmed: true } };
      state.previews.push(entry); return { url: state.previewUrl || 'http://localhost:43123', done: done.promise, pid: 123,
        stop: async () => { entry.stopped++; done.resolve(entry.result); return entry.result; } };
    },
    createDelivery: async input => { state.deliveries.push(input); return { zip: Buffer.from('trusted-controller-test-zip') }; },
    ...overrides.dependencies,
  };
  async function open(options = {}) {
    const service = await createWebExecutionService({ rootDir, getPlanning: async () => state.planning, config, executable: process.execPath,
      previewTimeoutMs: 100, ...overrides, ...options, dependencies: { ...dependencies, ...options.dependencies } }); state.services.push(service); return service;
  }
  return { rootDir, state, open, service: await open() };
}
async function waitFor(service, predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await service.list(ids); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('controller state did not settle');
}
// Fabricated trusted-adapter receipts exercise gate wiring only; none represent real business acceptance.
function acceptedRecord(entry) {
  const binding = { ...entry.options.binding, attemptId: entry.record.attemptId, candidateCommit: 'a'.repeat(40), sourceHash: hash(files),
    manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash };
  const result = manifest => ({ status: 'passed', profileId: 'library-web-v1', sourceHash: binding.sourceHash, manifestHash: manifest.hash, binding: { ...binding },
    checks: manifest.checks.map(item => ({ ...item, passed: true })), terminationConfirmed: true,
    processes: [0, 1].map(() => ({ status: 'stopped', exitCode: 0, stopAcknowledged: true, sourceUnchanged: true, terminationConfirmed: true })) });
  const http = { ...result(webManifest), databasePreflights: [], databaseCommands: [0, 1].map(() => ({ kind: 'database_observation', runnerHash: databaseObserverHash, sourceHash: binding.sourceHash,
    exitCode: 0, terminationConfirmed: true, stopReason: null, truncated: false })) };
  const browser = { ...result(browserManifest), browser: { closed: true, version: '157.0.1' } }; browser.processes.push({ kind: 'browser', status: 'stopped', exitCode: 0, terminationConfirmed: true });
  const acceptance = { status: 'passed', binding, test: http, browser,
    review: { status: 'completed', binding: { ...binding }, policyHash: projectReviewPolicy.hash, openBlockingIssues: 0, issues: [], summary: 'Trusted test fixture' }, issues: [], openIssues: [] };
  return { ...entry.record, status: 'accepted', acceptanceStatus: 'passed', candidateCommit: binding.candidateCommit, shellHash: 'c'.repeat(64),
    workspace: '/private/controller-test/workspace', versions: [{ commit: binding.candidateCommit, sourceHash: binding.sourceHash, selfCheck: http, acceptance }], reviewCalls: 1 };
}
async function accept(service, state) {
  const { execution } = await service.start(startInput); const entry = state.calls.at(-1), record = acceptedRecord(entry);
  assert.equal(isWebTaskAccepted(record), true); entry.finish(record);
  await waitFor(service, value => value.executions[0].taskAccepted); return execution.id;
}

test('capabilities are explicit reference-only, and start checks current content plus both approvals', async t => {
  const { service, state } = await fixture(t); const list = await service.list(ids);
  assert.equal(list.capabilities.canStart, true); assert.match(list.capabilities.profiles[0].description, /不代表任意上传业务/u);
  assert.equal(list.capabilities.profiles[0].contractRevision, webExecutionContractRevision);
  for (const change of [run => run.workflowVersion = 1, run => run.approvals.spec = null, run => run.approvals.plan = null,
    run => run.spec.title = 'changed', run => run.sourceSnapshot.content += 'changed', run => run.tasks.push({ id: 'changed' }), run => run.approvals.plan.specRevision = 'wrong']) {
    state.planning = planning(); change(state.planning.run);
    await assert.rejects(service.start(startInput), { status: 409 }); assert.equal((await service.list(ids)).capabilities.canStart, false);
  }
  state.planning = planning();
  await assert.rejects(service.start({ ...startInput, contractRevision: '0'.repeat(64) }), { code: 'contract_changed' });
  await assert.rejects(service.start({ ...startInput, report: { status: 'passed' } }), { status: 400 });
  await assert.rejects(service.start({ ...startInput, outputDir: '/host' }), { status: 400 });
  assert.equal(state.calls.length, 0);
});

test('concurrent starts reserve one durable active slot; a second controller cannot own the root', async t => {
  const { service, state, open } = await fixture(t);
  const results = await Promise.allSettled([service.start(startInput), service.start(startInput)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'execution_active'); assert.equal(state.calls.length, 1);
  assert.equal((await service.list(ids)).capabilities.canStart, false);
  await assert.rejects(open(), { code: 'service_owned' });
});

test('cancel remains requested until the executor stops; retry makes a new immutable attempt', async t => {
  const { service, state } = await fixture(t); state.manualCancel = true;
  const { execution } = await service.start(startInput), entry = state.calls[0];
  const result = await service.action({ ...ids, executionId: execution.id, action: 'cancel' });
  assert.equal(result.execution.status, 'cancel_requested'); assert.equal(result.execution.taskAccepted, false); assert.equal(entry.cancelled, 1);
  await assert.rejects(service.start(startInput), { code: 'execution_active' });
  entry.finish({ status: 'stopped' }); await waitFor(service, value => value.executions[0].status === 'stopped');
  const retry = await service.action({ ...ids, executionId: execution.id, action: 'retry' });
  assert.notEqual(retry.execution.id, execution.id); assert.equal(retry.execution.attempt, 2);
  const list = await service.list(ids); assert.equal(list.executions.length, 2); assert.equal(list.executions[1].status, 'stopped'); state.manualCancel = false;
});

test('stale planning callbacks cannot publish acceptance or trigger preview/download', async t => {
  const { service, state } = await fixture(t); const { execution } = await service.start(startInput), entry = state.calls[0];
  state.planning.run.spec.title = 'new unapproved version'; await assert.rejects(entry.options.assertCurrent(entry.options.binding), { code: 'stale_version' });
  entry.finish(acceptedRecord(entry)); await waitFor(service, value => value.executions[0].status === 'superseded');
  const dto = (await service.list(ids)).executions[0]; assert.equal(dto.taskAccepted, false); assert.equal(dto.actions.canPreview, false); assert.equal(dto.actions.canDownload, false);
  await assert.rejects(service.download({ ...ids, executionId: execution.id }), { code: 'not_accepted' });
});

test('partial or wrong-binding accepted reports never grant completion', async t => {
  const { service, state } = await fixture(t);
  await service.start(startInput); state.calls[0].finish({ status: 'accepted', acceptanceStatus: 'passed' });
  await waitFor(service, value => value.executions[0].status === 'failed');
  await service.start(startInput); const entry = state.calls[1]; entry.finish({ ...acceptedRecord(entry), runId: 'another-run' });
  await waitFor(service, value => value.executions[0].status === 'reconciliation_required');
  assert.ok((await service.list(ids)).executions.every(item => !item.taskAccepted));
});

test('DTOs retain unknown usage and whitelist reports, bounded messages and no secret/private paths', async t => {
  const { service, state } = await fixture(t); await service.start(startInput); const entry = state.calls[0];
  entry.record.receipt = { apiKey: config.apiKey, path: 'C:/private/receipt.json' };
  entry.record.events = [{ sequence: 1, time: '2026-11-14T00:00:00Z', message: `${config.apiKey} Bearer abc C:/private/data /private/host/info api_key=xyz` }];
  entry.record.error = '/opt/private/secret.json'; entry.record.workspace = 'C:/host/private/workspace';
  const dto = (await service.list(ids)).executions[0], text = JSON.stringify(dto);
  assert.deepEqual(dto.usage, { inputTokens: null, outputTokens: null });
  assert.ok(!text.includes(config.apiKey) && !text.includes('C:/private') && !text.includes('/private/host') && !text.includes('/opt/private') && !text.includes('receipt'));
  assert.match(dto.events[0].message, /已隐藏/u);
  entry.record.usage = { inputTokens: 0, outputTokens: 12 }; assert.deepEqual((await service.list(ids)).executions[0].usage, { inputTokens: 0, outputTokens: 12 });
});

test('restarting keeps failed history and does not re-run or overwrite completed attempts', async t => {
  const { service, state, open } = await fixture(t); await service.start(startInput); state.calls[0].finish(); await waitFor(service, value => value.executions[0].status === 'failed');
  await service.shutdown(); const next = await open(); const list = await next.list(ids);
  assert.equal(list.executions.length, 1); assert.equal(list.executions[0].status, 'failed'); assert.equal(state.calls.length, 1);
  await next.start(startInput); assert.equal((await next.list(ids)).executions[0].attempt, 2);
});

test('unknown prior execution or preview becomes reconciliation_required and cannot be retried', async t => {
  const { service, state, rootDir, open } = await fixture(t); await service.start(startInput); state.calls[0].finish(); await waitFor(service, value => value.executions[0].status === 'failed');
  await service.shutdown();
  const db = new DatabaseSync(path.join(rootDir, 'service.sqlite')); db.exec("UPDATE executions SET active=1,status='generating',preview_state='running'"); db.close();
  const next = await open(), list = await next.list(ids); assert.equal(list.executions[0].status, 'reconciliation_required'); assert.equal(list.capabilities.canStart, false);
  await assert.rejects(next.action({ ...ids, executionId: list.executions[0].id, action: 'retry' }), { code: 'cannot_retry' }); assert.equal(state.calls.length, 1);
});

test('expired controller callbacks cannot overwrite a new owner after simulated process loss', async t => {
  const { service, state, open } = await fixture(t); await service.start(startInput); const entry = state.calls[0];
  const next = await open({ dependencies: { isProcessAlive: () => false } }); entry.finish(acceptedRecord(entry));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await next.list(ids)).executions[0].status, 'reconciliation_required'); await assert.rejects(service.list(ids), { code: 'stale_owner' });
});

test('full trusted fixture gate is required, then preview copies source and timer confirms shutdown', async t => {
  const { service, state, rootDir } = await fixture(t, { previewTimeoutMs: 40 }); const executionId = await accept(service, state);
  const result = await service.action({ ...ids, executionId, action: 'preview' });
  assert.match(result.preview.url, /^http:\/\/localhost:\d+$/u); assert.equal(result.execution.preview.url, result.preview.url);
  assert.ok(state.previews[0].options.workspace.startsWith(path.join(rootDir, 'previews')));
  assert.equal(state.previews[0].options.timeoutMs, 15040);
  await waitFor(service, value => value.executions[0].preview === null && value.executions[0].actions.canPreview);
  assert.ok(state.previews[0].stopped >= 1);
  const db = new DatabaseSync(path.join(rootDir, 'service.sqlite'));
  const previewEvidence = db.prepare('SELECT state,record FROM preview_history').get(); db.close();
  assert.equal(previewEvidence.state, 'stopped'); assert.equal(JSON.parse(previewEvidence.record).pid, 123);
  assert.equal(JSON.parse(previewEvidence.record).stop.terminationConfirmed, true);
  const download = await service.download({ ...ids, executionId }); assert.equal(download.contentType, 'application/zip');
  assert.ok(Buffer.isBuffer(download.buffer)); assert.equal(state.deliveries.length, 1);
  assert.match(state.deliveries[0].spec.notice, /不代表任意上传业务/u);
});

test('source or current approval changes block download and preview despite old passing receipts', async t => {
  const { service, state } = await fixture(t, { dependencies: { verifySource: async () => { throw new Error('C:/private/tampered-source'); } } });
  const executionId = await accept(service, state);
  await assert.rejects(service.download({ ...ids, executionId }), error => error.status === 500 && !error.message.includes('C:/private'));
  assert.equal(state.previews.length, 0); state.planning.run.approvals.plan = null;
  await assert.rejects(service.action({ ...ids, executionId, action: 'preview' }), { code: 'not_accepted' });
});

test('unconfirmed preview termination preserves reconciliation and disables current delivery', async t => {
  const { service, state } = await fixture(t, { previewTimeoutMs: 10000 }); const executionId = await accept(service, state);
  await service.action({ ...ids, executionId, action: 'preview' }); state.previews[0].result.terminationConfirmed = false;
  const result = await service.action({ ...ids, executionId, action: 'stop_preview' });
  assert.equal(result.execution.status, 'reconciliation_required'); assert.equal(result.execution.actions.canDownload, false);
  await assert.rejects(service.download({ ...ids, executionId }), { code: 'reconciliation_required' });
});

test('invalid preview URL is closed, never exposed, and clean stop permits another attempt', async t => {
  const { service, state } = await fixture(t); const executionId = await accept(service, state); state.previewUrl = 'https://remote.invalid/app';
  await assert.rejects(service.action({ ...ids, executionId, action: 'preview' }), { code: 'preview_failed' });
  assert.equal(state.previews[0].stopped, 1); assert.equal((await service.list(ids)).executions[0].preview, null);
});

test('accepted history can be previewed after a clean restart by its new controller', async t => {
  const { service, state, open } = await fixture(t, { previewTimeoutMs: 10000 }); const executionId = await accept(service, state);
  await service.shutdown(); const next = await open();
  const result = await next.action({ ...ids, executionId, action: 'preview' }); assert.equal(result.execution.preview.url, 'http://localhost:43123');
  const stopped = await next.action({ ...ids, executionId, action: 'stop_preview' }); assert.equal(stopped.execution.preview, null); assert.equal(stopped.execution.actions.canDownload, true);
});

test('the default source guard rejects an outside workspace without passing it to a runtime', async t => {
  const { rootDir, service, state } = await fixture(t); const executionId = await accept(service, state); await service.shutdown();
  const next = await createWebExecutionService({ rootDir, getPlanning: async () => state.planning, config, executable: process.execPath }); state.services.push(next);
  await assert.rejects(next.download({ ...ids, executionId }), { code: 'source_changed' }); assert.equal(state.previews.length, 0);
});

test('a planning change during preview startup stops the acquired runtime and rejects its URL', async t => {
  const pending = deferred(), acquired = deferred(); let stopped = 0;
  const { service, state } = await fixture(t, { dependencies: { startRuntime: async () => { acquired.resolve(); await pending.promise; return {
    url: 'http://localhost:43123', done: new Promise(() => {}), stop: async () => { stopped++; return { status: 'stopped', exitCode: 0, stopAcknowledged: true, sourceUnchanged: true, terminationConfirmed: true }; },
  }; } } });
  const executionId = await accept(service, state), preview = service.action({ ...ids, executionId, action: 'preview' });
  await acquired.promise; state.planning.run.approvals.plan = null; pending.resolve();
  await assert.rejects(preview, { code: 'preview_failed' }); assert.equal(stopped, 1); assert.equal((await service.list(ids)).executions[0].preview, null);
});

test('refresh revokes a running old-version preview and never reuses old approval', async t => {
  const { service, state } = await fixture(t, { previewTimeoutMs: 10000 }); const executionId = await accept(service, state);
  await service.action({ ...ids, executionId, action: 'preview' }); state.planning.run.approvals.spec = null;
  const result = await service.list(ids); assert.equal(result.executions[0].preview, null); assert.equal(result.executions[0].taskAccepted, false); assert.equal(state.previews[0].stopped, 1);
});

test('owned root refuses links and public methods refuse foreign IDs and caller budgets', async t => {
  const { service, rootDir } = await fixture(t); const target = path.join(rootDir, 'linked-target'), linked = path.join(rootDir, 'linked');
  await mkdir(target); await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createWebExecutionService({ rootDir: linked, getPlanning: async () => planning() }), { code: 'invalid_root' });
  await assert.rejects(service.download({ ...ids, executionId: '../host' }), { status: 400 });
  await assert.rejects(service.start({ ...startInput, budget: { maxCalls: 100 } }), { status: 400 });
});

test('stop during runtime startup preserves the one actual stop result and strict failure cases', async t => {
  for (const invalid of [null, 'terminationConfirmed', 'exitCode', 'stopAcknowledged', 'sourceUnchanged']) {
    const entered = deferred(), release = deferred(), done = deferred(); let stops = 0;
    const stopResult = { status: 'stopped', pid: 777, exitCode: 0, stopAcknowledged: true, sourceUnchanged: true, terminationConfirmed: true };
    if (invalid) stopResult[invalid] = invalid === 'exitCode' ? 1 : false;
    const { service, state, rootDir } = await fixture(t, { previewTimeoutMs: 10000, dependencies: { startRuntime: async () => {
      entered.resolve(); await release.promise;
      return { url: 'http://localhost:43123', pid: 777, done: done.promise, stop: async () => { stops++; done.resolve(stopResult); return stopResult; } };
    } } });
    const executionId = await accept(service, state), starting = service.action({ ...ids, executionId, action: 'preview' }).catch(error => error);
    await entered.promise; const stopping = service.action({ ...ids, executionId, action: 'stop_preview' }); release.resolve();
    assert.equal((await starting).code, 'preview_failed'); const result = await stopping;
    assert.equal(stops, 1); assert.equal(result.execution.status, invalid ? 'reconciliation_required' : 'accepted');
    assert.equal((await service.list(ids)).capabilities.canStart, !invalid);
    const db = new DatabaseSync(path.join(rootDir, 'service.sqlite')), history = db.prepare('SELECT state,record FROM preview_history').get(); db.close();
    const evidence = JSON.parse(history.record); assert.equal(evidence.pid, 777); assert.equal(evidence.stop.pid, 777);
    assert.equal(evidence.stop.terminationConfirmed, stopResult.terminationConfirmed); assert.equal(history.state, invalid ? 'unknown' : 'stopped');
  }
});

test('shutdown during runtime startup waits for the same late clean stop evidence', async t => {
  const entered = deferred(), release = deferred(), done = deferred(); let stops = 0;
  const { service, state, rootDir } = await fixture(t, { dependencies: { startRuntime: async () => {
    entered.resolve(); await release.promise; return { url: 'http://localhost:43123', pid: 778, done: done.promise,
      stop: async () => { stops++; const result = { status: 'stopped', pid: 778, exitCode: 0, stopAcknowledged: true, sourceUnchanged: true, terminationConfirmed: true }; done.resolve(result); return result; } };
  } } });
  const executionId = await accept(service, state), starting = service.action({ ...ids, executionId, action: 'preview' }).catch(error => error);
  await entered.promise; const shutdown = service.shutdown(); release.resolve(); await shutdown;
  assert.equal((await starting).code, 'preview_failed'); assert.equal(stops, 1);
  const db = new DatabaseSync(path.join(rootDir, 'service.sqlite')), history = db.prepare('SELECT state,record FROM preview_history').get(); db.close();
  assert.equal(history.state, 'stopped'); assert.equal(JSON.parse(history.record).stop.pid, 778);
});

test('source errors keep private process and probe evidence without exposing them in DTO or HTTP errors', async t => {
  const { service, state, rootDir } = await fixture(t, { dependencies: { verifySource: async () => { throw Object.assign(new Error('private source stop'), {
    status: 409, code: 'reconciliation_required', phase: 'source_probe', probeDirectory: 'C:/owned/private-probe',
    command: { executable: 'git', args: ['status', '--porcelain'], workspace: 'C:/owned/private-workspace' },
    result: { pid: 89124, startedAt: '2026-11-14T00:00:00Z', terminationConfirmed: false, controlDirectory: 'C:/owned/private-control' },
  }); } } });
  const executionId = await accept(service, state);
  await assert.rejects(service.download({ ...ids, executionId }), error => error.code === 'reconciliation_required' && !('result' in error) && !error.message.includes('89124'));
  const db = new DatabaseSync(path.join(rootDir, 'service.sqlite')), history = JSON.parse(db.prepare('SELECT record FROM source_history').get().record); db.close();
  assert.equal(history.result.pid, 89124); assert.equal(history.result.controlDirectory, 'C:/owned/private-control');
  assert.equal(history.probeDirectory, 'C:/owned/private-probe'); assert.equal(history.phase, 'source_probe'); assert.deepEqual(history.command.args, ['status', '--porcelain']);
  const dto = JSON.stringify(await service.list(ids)); assert.ok(!dto.includes('89124') && !dto.includes('private-probe') && !dto.includes('private-control'));
});

test('the default Git source guard attaches actual unknown-stop command metadata to private history', async t => {
  const { service, state, rootDir } = await fixture(t); const executionId = await accept(service, state); await service.shutdown();
  const workspace = path.join(rootDir, 'executions', executionId, 'web-execution-fixture', 'workspace'); await mkdir(workspace, { recursive: true });
  const shell = await installWebShell({ workspace }); await applyProjectFiles({ workspace, files }); await mkdir(path.join(workspace, '.git'));
  const db = new DatabaseSync(path.join(rootDir, 'service.sqlite')), row = db.prepare('SELECT record FROM executions WHERE id=?').get(executionId), record = JSON.parse(row.record);
  Object.assign(record, { workspace, shellHash: shell.hash }); db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(record), executionId); db.close();
  const next = await createWebExecutionService({ rootDir, getPlanning: async () => state.planning, config, executable: process.execPath, dependencies: {
    runProcess: async () => ({ pid: 89125, startedAt: '2026-11-14T00:00:00Z', terminationConfirmed: false, controlDirectory: 'C:/owned/git-control' }),
  } }); state.services.push(next);
  await assert.rejects(next.download({ ...ids, executionId }), { code: 'reconciliation_required' });
  const evidenceDb = new DatabaseSync(path.join(rootDir, 'service.sqlite')), history = JSON.parse(evidenceDb.prepare('SELECT record FROM source_history').get().record); evidenceDb.close();
  assert.equal(history.phase, 'source_git'); assert.equal(history.result.pid, 89125); assert.equal(history.command.executable, 'git');
  assert.ok(history.command.args.includes('rev-parse')); assert.equal(history.result.controlDirectory, 'C:/owned/git-control');
});

test('a cancel accepted during finish planning lookup wins over the late accepted record', async t => {
  const entered = deferred(), release = deferred(), plan = planning(); let pauseNext = false;
  const { service, state } = await fixture(t, { getPlanning: async () => { if (pauseNext) { pauseNext = false; entered.resolve(); await release.promise; } return plan; } });
  const { execution } = await service.start(startInput), entry = state.calls[0]; pauseNext = true; entry.finish(acceptedRecord(entry)); await entered.promise;
  const cancelled = await service.action({ ...ids, executionId: execution.id, action: 'cancel' }); assert.equal(cancelled.execution.status, 'cancel_requested'); release.resolve();
  const result = await waitFor(service, value => value.executions[0].status === 'stopped');
  assert.equal(entry.cancelled, 1); assert.equal(result.executions[0].taskAccepted, false); assert.equal(result.executions[0].actions.canDownload, false);
  await assert.rejects(service.download({ ...ids, executionId: execution.id }), { code: 'not_accepted' });
});

test('an executor version assertion rechecks a concurrent cancellation after its async planning lookup', async t => {
  const entered = deferred(), release = deferred(), plan = planning(); let pauseNext = false;
  const { service, state } = await fixture(t, { getPlanning: async () => { if (pauseNext) { pauseNext = false; entered.resolve(); await release.promise; } return plan; } });
  state.manualCancel = true; const { execution } = await service.start(startInput), entry = state.calls[0]; pauseNext = true;
  const asserting = entry.options.assertCurrent(entry.options.binding).catch(error => error); await entered.promise;
  await service.action({ ...ids, executionId: execution.id, action: 'cancel' }); release.resolve(); assert.equal((await asserting).code, 'stale_execution');
  entry.finish({ status: 'stopped' }); state.manualCancel = false;
});

test('a concurrent source unknown-stop prevents the already pending preview from spawning', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const { service, state, rootDir } = await fixture(t, { dependencies: { verifySource: async () => {
    const call = ++calls; if (call === 2) { entered.resolve(); await release.promise; }
    if (call === 3) throw Object.assign(new Error('trusted unknown stop'), { code: 'reconciliation_required', result: { pid: 424242, terminationConfirmed: false, control: 'private-control' }, probe: 'private-probe' });
    return { files: structuredClone(files), shellHash: 'c'.repeat(64) };
  } } });
  const executionId = await accept(service, state), starting = service.action({ ...ids, executionId, action: 'preview' }).catch(error => error); await entered.promise;
  await assert.rejects(service.download({ ...ids, executionId }), { code: 'reconciliation_required' }); release.resolve();
  assert.equal((await starting).code, 'preview_failed'); assert.equal(state.previews.length, 0);
  const result = await service.list(ids); assert.equal(result.executions[0].status, 'reconciliation_required'); assert.equal(result.capabilities.canStart, false);
  const db = new DatabaseSync(path.join(rootDir, 'service.sqlite')), history = db.prepare('SELECT state FROM preview_history').get(); db.close(); assert.equal(history.state, 'not_started');
});

test('coding and preview share one run slot in either direction and release it only after a confirmed stop', async t => {
  const { service, state } = await fixture(t, { previewTimeoutMs: 10000 }); const executionId = await accept(service, state);
  await service.action({ ...ids, executionId, action: 'preview' }); assert.equal((await service.list(ids)).capabilities.canStart, false);
  await assert.rejects(service.start(startInput), { code: 'execution_active' }); assert.equal(state.calls.length, 1);
  await service.action({ ...ids, executionId, action: 'stop_preview' }); assert.equal((await service.list(ids)).capabilities.canStart, true);
  await service.start(startInput); const list = await service.list(ids); assert.equal(list.executions[1].actions.canPreview, false);
  await assert.rejects(service.action({ ...ids, executionId, action: 'preview' }), { code: 'preview_active' }); assert.equal(state.previews.length, 1);
});

test('legacy preview-plus-coding rows migrate to two retained unknown histories without a uniqueness crash', async t => {
  const { service, state, rootDir, open } = await fixture(t); const oldId = await accept(service, state); const { execution } = await service.start(startInput);
  await service.shutdown();
  const db = new DatabaseSync(path.join(rootDir, 'service.sqlite'));
  db.exec('DROP INDEX active_run; CREATE UNIQUE INDEX active_run ON executions(project_id,run_id) WHERE active=1');
  db.prepare("UPDATE executions SET status='accepted',active=0,preview_state='running' WHERE id=?").run(oldId);
  db.prepare("UPDATE executions SET status='generating',active=1 WHERE id=?").run(execution.id);
  db.prepare('INSERT INTO preview_history VALUES(?,?,?,?)').run('legacy-preview', oldId, 'running', JSON.stringify({ pid: 515151, workspace: 'C:/owned/legacy-preview' })); db.close();
  const next = await open(), result = await next.list(ids); assert.equal(result.executions.length, 2); assert.ok(result.executions.every(item => item.status === 'reconciliation_required'));
  assert.equal(result.capabilities.canStart, false); assert.ok(result.executions.every(item => !item.actions.canRetry && !item.actions.canDownload));
  const check = new DatabaseSync(path.join(rootDir, 'service.sqlite')); assert.equal(check.prepare('SELECT COUNT(*) n FROM executions').get().n, 2);
  const history = check.prepare('SELECT state,record FROM preview_history WHERE id=?').get('legacy-preview'); check.close();
  assert.equal(history.state, 'unknown'); assert.equal(JSON.parse(history.record).pid, 515151);
});

test('all nonempty known keys including one-to-three-character keys are masked in DTO text and errors', async t => {
  for (const key of ['abc', 'xy', 'z']) {
    const { service, state } = await fixture(t, { config: { ...config, apiKey: key }, dependencies: { codeModel: () => async () => {} } });
    await service.start(startInput); state.calls[0].record.events = [{ sequence: 1, message: `echo=${key}` }]; state.calls[0].record.error = `echo=${key}`;
    const dto = (await service.list(ids)).executions[0]; assert.ok(!dto.events[0].message.includes(key)); assert.ok(!dto.error.includes(key));
  }
});

test('real MXC executes exactly one thin failed candidate through the default executor without model calls', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 60000,
}, async t => {
  const { service } = await fixture(t, { executable: process.env.EXECUTION_SANDBOX_EXE, budget: { maxCalls: 1, maxReviewCalls: 1, timeoutMs: 25000 },
    dependencies: { startExecution: startWebExecution, codeModel: () => async () => ({ files, model: 'trusted-fixture-no-api', usage: { inputTokens: null, outputTokens: null } }), reviewModel: () => async () => { throw new Error('self-check must fail before Review'); } } });
  await service.start(startInput);
  const result = await waitFor(service, value => ['failed', 'timed_out', 'reconciliation_required'].includes(value.executions[0].status), 35000), execution = result.executions[0];
  assert.equal(execution.status, 'failed'); assert.equal(execution.taskAccepted, false); assert.equal(execution.calls, 1);
  assert.equal(execution.versions.length, 1); assert.equal(execution.versions[0].selfCheck.status, 'failed');
  assert.equal(execution.actions.canDownload, false); assert.deepEqual(execution.usage, { inputTokens: null, outputTokens: null });
});
