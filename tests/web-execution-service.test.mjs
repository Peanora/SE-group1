import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createWebExecutionService, webExecutionContractRevision } from '../lib/web-execution-service.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { isWebTaskAccepted, startWebExecution } from '../lib/web-executor.mjs';
import { webManifest, databaseObserverHash } from '../lib/web-tests.mjs';
import { browserManifest } from '../lib/web-browser-tests.mjs';
import { projectReviewPolicy, validateProjectReviewResponse } from '../lib/project-review-model.mjs';
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
      if (options.initialSource && state.startRepair) return state.startRepair(options);
      const finished = deferred(), record = { id: randomUUID(), ...options.binding, attemptId: randomUUID(), profileId: 'library-web-v1', providerKind: 'model', reviewerKind: 'model',
        status: 'generating', acceptanceStatus: 'not_checked', budget: { maxCalls: options.maxCalls, maxReviewCalls: options.maxReviewCalls, timeoutMs: options.timeoutMs },
        calls: 1, reviewCalls: 0, usage: { inputTokens: null, outputTokens: null }, versions: [], events: [], gitCommands: [] };
      const entry = { options, record, cancelled: 0, finish(change = {}) { Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString() }, change); finished.resolve(structuredClone(record)); } };
      state.calls.push(entry); return { id: record.id, snapshot: () => structuredClone(record), done: finished.promise,
        cancel() { entry.cancelled++; if (!state.manualCancel) entry.finish({ status: 'stopped' }); } };
    },
    verifySource: async record => ({ files: structuredClone(state.repairFiles?.get(record.id) ?? files), shellHash: record.shellHash ?? 'c'.repeat(64) }),
    startRuntime: async options => {
      const done = deferred(), entry = { options, stopped: 0, result: { status: 'stopped', exitCode: 0, stopAcknowledged: true, sourceUnchanged: true, terminationConfirmed: true } };
      state.previews.push(entry); return { url: state.previewUrl || 'http://localhost:43123', done: done.promise, pid: 123,
        stop: async () => { entry.stopped++; done.resolve(entry.result); return entry.result; } };
    },
    createDelivery: async input => { state.deliveries.push(input); return { zip: Buffer.from('trusted-controller-test-zip') }; },
    ...overrides.dependencies,
  };
  async function open(options = {}) {
    const service = await createWebExecutionService({ rootDir, getPlanning: async (...args) => state.getPlanning ? state.getPlanning(...args) : state.planning, config, executable: process.execPath,
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

// Controller integration fixtures only: neither these fabricated receipts nor mock inspectors prove business acceptance.
async function recheckFixture(t) {
  let f;
  const inspected = options => {
    const source = structuredClone(f.state.original), summary = { sourceExecutionRoot: path.dirname(path.dirname(source.reportPath)), sourceBinding: { ...f.state.calls[0].options.binding },
      sourceExecutionId: source.id, sourceReport: source.reportPath, sourceReportHash: f.state.reportHash || 'f'.repeat(64), sourceWorkspace: source.workspace,
      sourceCommit: source.candidateCommit, sourceHash: source.versions.at(-1).sourceHash, sourceUsage: source.usage, sourceCodingCalls: 1, sourceModelCalls: 2,
      codingReceipts: [{ attempt: 1, receiptPath: source.modelCalls[0].receiptPath, receiptHash: source.modelCalls[0].receiptHash, model: 'trusted-fixture' }], sourceShellHash: source.shellHash };
    delete summary.sourceBinding.sourceRevision;
    return { source, summary, files: structuredClone(files) };
  };
  f = await fixture(t, { dependencies: {
    inspectRecheckSource: async options => {
      f.state.inspections.push(options); if (f.state.inspectHook) return f.state.inspectHook(options, () => inspected(options)); return inspected(options);
    },
    startRecheck(options) {
      const finished = deferred(), record = { id: randomUUID(), ...options.sourceBinding, attemptId: randomUUID(), kind: 'web_recheck', profileId: 'library-web-v1', providerKind: 'model', reviewerKind: 'model', reviewPolicyHash: projectReviewPolicy.hash,
        status: 'validating', calls: 0, reviewCalls: 0, usage: { inputTokens: null, outputTokens: null }, budget: { maxCalls: 0, maxReviewCalls: options.maxReviewCalls, timeoutMs: options.timeoutMs },
        versions: [], events: [], gitCommands: [] };
      const entry = { record, options: { ...options, binding: options.sourceBinding }, cancelled: 0,
        finish(change = {}) { Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString() }, change); finished.resolve(structuredClone(record)); },
        async pass(change = {}) { await entry.ready; const passed = acceptedRecord(entry); passed.versions[0].acceptance.review.kind = 'model'; entry.finish({ ...passed, kind: 'web_recheck', calls: 0, budget: record.budget,
          workspace: record.workspace, reportPath: record.reportPath, shellHash: record.shellHash, provenance: record.provenance, usage: { inputTokens: 5, outputTokens: 7 }, ...change }); },
      };
      entry.ready = (async () => { await mkdir(options.outputDir, { recursive: true }); const directory = await mkdtemp(path.join(options.outputDir, 'web-recheck-'));
        record.workspace = path.join(directory, 'workspace'); record.reportPath = path.join(directory, 'execution.json'); await mkdir(record.workspace);
        record.shellHash = (await installWebShell({ workspace: record.workspace })).hash; await applyProjectFiles({ workspace: record.workspace, files }); record.provenance = inspected(options).summary;
      })();
      f.state.rechecks.push(entry); return { id: record.id, snapshot: () => structuredClone(record), done: entry.ready.then(() => finished.promise),
        cancel() { entry.cancelled++; if (!f.state.manualRecheckCancel) entry.finish({ status: 'stopped' }); } };
    },
  } });
  Object.assign(f.state, { rechecks: [], inspections: [] });
  const { execution } = await f.service.start(startInput), originalEntry = f.state.calls[0], original = acceptedRecord(originalEntry);
  const directory = path.join(originalEntry.options.outputDir, 'web-execution-source'); await mkdir(directory, { recursive: true }); original.workspace = path.join(directory, 'workspace');
  original.reportPath = path.join(directory, 'execution.json'); await mkdir(original.workspace); original.shellHash = (await installWebShell({ workspace: original.workspace })).hash;
  await applyProjectFiles({ workspace: original.workspace, files }); await mkdir(path.join(original.workspace, '.git'));
  original.versions[0].attempt = 1; original.versions[0].selfCheck.processes.forEach((process, index) => { process.pid = 61000 + index; });
  original.modelCalls = [{ role: 'coding', kind: 'model', attempt: 1, model: 'trusted-fixture', receiptHash: 'e'.repeat(64), receiptPath: path.join(directory, 'model-coding-1.json') }, { role: 'review', kind: 'model', attempt: 1 }];
  Object.assign(original, { status: 'failed', acceptanceStatus: 'error', calls: 1, reviewCalls: 1, totalModelCalls: 2, usage: { inputTokens: 900, outputTokens: 100 }, error: 'Original Review had no valid line evidence' });
  original.versions[0].acceptance.status = 'error'; original.versions[0].acceptance.review.status = 'error';
  originalEntry.finish(original); f.state.original = structuredClone(originalEntry.record); f.state.sourceId = execution.id;
  await writeFile(original.reportPath, JSON.stringify(f.state.original)); await waitFor(f.service, value => value.executions[0].status === 'failed'); return f;
}
async function waitRecheck(f) {
  for (let i = 0; i < 200; i++) { if (f.state.rechecks.length) { await f.state.rechecks.at(-1).ready; return f.state.rechecks.at(-1); } await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('mock recheck was not dispatched');
}
async function setRecheckTimeout(f, timeoutMs) {
  await f.service.shutdown(); f.service = await f.open({ budget: { maxCalls: 1, maxReviewCalls: 1, timeoutMs } });
}

// Seeded repair positive paths below are trusted lifecycle fixtures, not Git/model/business acceptance.
async function repairFixture(t) {
  const f = await recheckFixture(t); f.state.reportHash = createHash('sha256').update(await readFile(f.state.original.reportPath)).digest('hex');
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }), finding = await waitRecheck(f), failed = acceptedRecord(finding);
  const issue = { id: 'ISSUE-repair-origin', severity: 'blocking', status: 'open', file: 'src/app.mjs', line: 1, message: 'The source needs an atomic update', evidence: files[0].content.trim(), originCommit: failed.candidateCommit };
  Object.assign(failed.versions[0].acceptance, { status: 'changes_requested', issues: [issue], openIssues: [issue] });
  Object.assign(failed.versions[0].acceptance.review, { kind: 'model', resolutions: [], openBlockingIssues: 1, issues: [{ severity: issue.severity, file: issue.file, line: issue.line, message: issue.message, evidence: issue.evidence }] });
  await finding.pass({ status: 'failed', acceptanceStatus: 'changes_requested', versions: failed.versions });
  await writeFile(finding.record.reportPath, JSON.stringify(finding.record)); await waitFor(f.service, value => value.executions[0].status === 'failed');
  Object.assign(f.state, { findingId: execution.id, finding: finding.record, issue, repairs: [], repairFiles: new Map() });
  f.state.startRepair = options => {
    const done = deferred(), changedFiles = files.map(file => ({ ...file, content: file.content + '\n// trusted repair fixture changed source\n' }));
    const record = { id: randomUUID(), ...options.binding, kind: 'web_execution', attemptId: randomUUID(), profileId: 'library-web-v1', providerKind: 'model', reviewerKind: 'model',
      status: 'generating', calls: 1, reviewCalls: 0, budget: { maxCalls: options.maxCalls, maxReviewCalls: options.maxReviewCalls, timeoutMs: options.timeoutMs },
      repairSource: { ...Object.fromEntries(Object.entries(options.initialSource).filter(([key]) => key !== 'files')), previousIssues: structuredClone(options.previousIssues) },
      usage: { inputTokens: null, outputTokens: null }, events: [], versions: [], gitCommands: [] };
    const entry = { record, options, files: changedFiles, cancelled: 0, finish(change = {}) { Object.assign(record, { finishedAt: new Date().toISOString(), status: 'failed' }, change); done.resolve(structuredClone(record)); },
      async pass(change = {}) {
        await entry.ready; const accepted = JSON.parse(JSON.stringify(acceptedRecord(entry)).replaceAll('a'.repeat(40), 'b'.repeat(40)).replaceAll(hash(files), hash(changedFiles)));
        Object.assign(accepted, { baseCommit: 'd'.repeat(40), workspace: record.workspace, reportPath: record.reportPath, shellHash: record.shellHash, repairSource: record.repairSource, usage: { inputTokens: 11, outputTokens: 13 } });
        const gate = accepted.versions[0].acceptance;
        gate.issues = options.previousIssues.map(issue => ({ ...issue, status: 'resolved', checkedCommit: accepted.candidateCommit, resolution: 'Fixed in the new source' })); gate.openIssues = [];
        gate.review.resolutions = options.previousIssues.map(issue => ({ id: issue.id, status: 'resolved', reason: 'The changed source closes the issue' }));
        entry.finish(typeof change === 'function' ? change(accepted) : { ...accepted, ...change });
      } };
    entry.ready = (async () => { await mkdir(options.outputDir, { recursive: true }); const directory = await mkdtemp(path.join(options.outputDir, 'web-execution-'));
      record.workspace = path.join(directory, 'workspace'); record.reportPath = path.join(directory, 'execution.json'); await mkdir(record.workspace);
      record.shellHash = (await installWebShell({ workspace: record.workspace })).hash; await applyProjectFiles({ workspace: record.workspace, files: changedFiles });
      f.state.repairFiles.set(record.id, changedFiles);
    })();
    f.state.repairs.push(entry); return { id: record.id, snapshot: () => structuredClone(record), done: entry.ready.then(() => done.promise),
      cancel() { entry.cancelled++; if (!f.state.manualRepairCancel) entry.finish({ status: 'stopped' }); } };
  };
  return f;
}
async function waitRepair(f) {
  for (let i = 0; i < 300; i++) { if (f.state.repairs.length) { await f.state.repairs.at(-1).ready; return f.state.repairs.at(-1); } await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('trusted repair executor was not constructed');
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
  const retry = await service.action({ ...startInput, executionId: execution.id, action: 'retry' });
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

test('check DTOs retain bounded comparison text while masking secrets and paths and excluding process objects', async t => {
  const { service, state } = await fixture(t); await service.start(startInput);
  const checks = [
    { id: 'STATUS', name: 'HTTP状态', passed: false, expected: 'HTTP 200', actual: '{"status":503}' },
    { id: 'SENSITIVE', passed: false, expected: `${config.apiKey} C:/private/expected.json`, actual: `${config.apiKey} /opt/private/actual.json` },
    { id: 'BOUNDED', passed: false, expected: '期望'.repeat(2000), actual: '观察'.repeat(2000) },
    { id: 'PRIVATE', passed: false, pid: 919191, stdout: 'private-raw-log', expected: { pid: 919191 }, actual: { stderr: 'private-raw-log', workspace: 'C:/private/workspace' } },
    { id: 'OPTIONAL', passed: false, error: '浏览器未出现登录表单' },
  ];
  const result = { status: 'failed', terminationConfirmed: true, checks };
  state.calls[0].record.versions = [{ commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), selfCheck: structuredClone(result),
    acceptance: { status: 'changes_requested', test: structuredClone(result), browser: structuredClone(result) } }];
  const version = (await service.list(ids)).executions[0].versions[0];
  for (const branch of [version.selfCheck, version.acceptance.test, version.acceptance.browser]) {
    assert.equal(branch.checks[0].expected, 'HTTP 200'); assert.equal(branch.checks[0].actual, '{"status":503}'); assert.equal(branch.checks[0].passed, false);
    assert.ok(!branch.checks[1].expected.includes(config.apiKey) && !branch.checks[1].expected.includes('C:/private'));
    assert.ok(!branch.checks[1].actual.includes(config.apiKey) && !branch.checks[1].actual.includes('/opt/private'));
    assert.match(branch.checks[1].actual, /已隐藏/u); assert.match(branch.checks[1].expected, /本地路径/u);
    assert.equal(branch.checks[2].expected.length, 2000); assert.equal(branch.checks[2].actual.length, 2000);
    assert.ok(!('expected' in branch.checks[3]) && !('actual' in branch.checks[3]) && !('pid' in branch.checks[3]) && !('stdout' in branch.checks[3]));
    assert.ok(!('expected' in branch.checks[4]) && !('actual' in branch.checks[4])); assert.equal(branch.checks[4].error, '浏览器未出现登录表单');
    assert.ok(!JSON.stringify(branch).includes('919191') && !JSON.stringify(branch).includes('private-raw-log'));
  }
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
  await assert.rejects(next.action({ ...startInput, executionId: list.executions[0].id, action: 'retry' }), { code: 'cannot_retry' }); assert.equal(state.calls.length, 1);
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

test('owned recheck creates a zero-coding attempt, deep admits before Review, and keeps original history and usage', async t => {
  const f = await recheckFixture(t), { service, state } = f;
  assert.equal((await service.list(ids)).executions[0].actions.canRecheck, true); await service.list(ids); assert.equal(state.inspections.length, 0, 'polling must not run Git admission');
  const before = await readFile(state.original.reportPath), started = await service.action({ ...startInput, executionId: state.sourceId, action: 'recheck' });
  assert.notEqual(started.execution.id, state.sourceId); assert.equal(started.execution.calls, 0); assert.equal(started.execution.budget.maxCalls, 0); assert.equal(started.execution.budget.maxReviewCalls, 2);
  assert.deepEqual(started.execution.usage, { inputTokens: null, outputTokens: null });
  const entry = await waitRecheck(f); assert.equal(state.calls.length, 1); assert.equal(state.inspections.length, 1);
  assert.equal(entry.options.outputDir, path.join(f.rootDir, 'executions', started.execution.id));
  assert.equal(entry.options.executionRoot, path.join(f.rootDir, 'executions', state.sourceId));
  assert.deepEqual(Object.keys(entry.options.sourceBinding).sort(), ['planRevision', 'projectId', 'runId', 'specRevision', 'taskId']);
  await entry.pass(); const result = await waitFor(service, value => value.executions[0].taskAccepted), current = result.executions[0], original = result.executions[1];
  assert.equal(current.calls, 0); assert.equal(current.reviewCalls, 1); assert.deepEqual(current.usage, { inputTokens: 5, outputTokens: 7 });
  assert.equal(current.sourceExecutionId, state.sourceId); assert.equal(current.sourceCommit, state.original.candidateCommit);
  assert.equal(original.status, 'failed'); assert.deepEqual(original.usage, { inputTokens: 900, outputTokens: 100 });
  assert.equal(current.actions.canRecheck, false); await assert.rejects(service.action({ ...startInput, executionId: current.id, action: 'recheck' }), { code: 'cannot_recheck' });
  await assert.rejects(stat(path.join(entry.record.workspace, '.git')), { code: 'ENOENT' });
  await service.download({ ...ids, executionId: current.id }); assert.ok(state.inspections.length >= 3, 'delivery revalidates original provenance');
  const preview = await service.action({ ...ids, executionId: current.id, action: 'preview' }); assert.equal(preview.execution.taskAccepted, true);
  await service.action({ ...ids, executionId: current.id, action: 'stop_preview' });
  assert.equal(state.deliveries[0].binding.candidateCommit, state.original.candidateCommit); assert.deepEqual(await readFile(state.original.reportPath), before);
  const json = JSON.stringify(result); assert.ok(!json.includes('sourceReport') && !json.includes('codingReceipts') && !json.includes(f.rootDir));
});

test('recheck atomic slot rejects simultaneous starts and refuses all client provenance or budget fields', async t => {
  const f = await recheckFixture(t), input = { ...startInput, executionId: f.state.sourceId, action: 'recheck' };
  for (const extra of [{ sourceReportPath: '/host/report.json' }, { sourceBinding: {} }, { outputDir: '/host' }, { budget: { maxCalls: 0 } }]) await assert.rejects(f.service.action({ ...input, ...extra }), { status: 400 });
  const results = await Promise.allSettled([f.service.action(input), f.service.action(input)]); assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const entry = await waitRecheck(f); await entry.pass(); await waitFor(f.service, value => value.executions[0].taskAccepted); assert.equal(f.state.rechecks.length, 1);
});

test('both paid actions require an explicit current profile contract while free actions refuse those extra fields', async t => {
  const f = await recheckFixture(t);
  for (const action of ['retry', 'recheck', 'repair']) {
    const input = { ...ids, executionId: f.state.sourceId, action };
    await assert.rejects(f.service.action(input), { status: 400 });
    await assert.rejects(f.service.action({ ...input, profileId: 'library-web-v1' }), { status: 400 });
    await assert.rejects(f.service.action({ ...input, profileId: 'library-web-v1', contractRevision: '0'.repeat(64) }), { code: 'contract_changed' });
    await assert.rejects(f.service.action({ ...input, profileId: 'another-profile', contractRevision: webExecutionContractRevision }), { code: 'contract_changed' });
  }
  await assert.rejects(f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'cancel' }), { status: 400 });
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.rechecks.length, 0); assert.equal(f.state.inspections.length, 0);
});

test('old validation contract can reuse its original code only through a new current-contract recheck', async t => {
  const f = await recheckFixture(t), db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite'));
  Object.assign(f.state.original, { status: 'accepted', acceptanceStatus: 'passed' }); f.state.original.versions[0].acceptance.status = 'passed'; f.state.original.versions[0].acceptance.review.status = 'completed';
  assert.equal(isWebTaskAccepted(f.state.original), true);
  const snapshot = JSON.parse(db.prepare('SELECT snapshot FROM executions WHERE id=?').get(f.state.sourceId).snapshot); snapshot.contractRevision = '0'.repeat(64);
  db.prepare('UPDATE executions SET record=?,snapshot=?,status=? WHERE id=?').run(JSON.stringify(f.state.original), JSON.stringify(snapshot), 'accepted', f.state.sourceId); db.close();
  await writeFile(f.state.original.reportPath, JSON.stringify(f.state.original));
  const old = (await f.service.list(ids)).executions[0]; assert.equal(old.taskAccepted, false); assert.equal(old.actions.canDownload, false); assert.equal(old.actions.canRecheck, true);
  assert.equal(old.recheckContractRevision, webExecutionContractRevision); await assert.rejects(f.service.download({ ...ids, executionId: f.state.sourceId }), { code: 'not_accepted' });
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); assert.equal(execution.contractRevision, webExecutionContractRevision); assert.equal(execution.taskAccepted, false);
  const entry = await waitRecheck(f); await entry.pass(); const result = await waitFor(f.service, value => value.executions[0].taskAccepted); assert.equal(result.executions[0].calls, 0); assert.equal(result.executions[1].taskAccepted, false);
});

test('recheck rejects foreign report paths, missing receipts and stale current approvals before dispatch', async t => {
  const f = await recheckFixture(t), db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite'));
  const original = db.prepare('SELECT record FROM executions WHERE id=?').get(f.state.sourceId).record;
  for (const mutate of [value => value.reportPath = path.join(f.rootDir, 'elsewhere', 'execution.json'), value => value.modelCalls[0].receiptHash = null]) {
    const changed = JSON.parse(original); mutate(changed); db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(changed), f.state.sourceId);
    assert.equal((await f.service.list(ids)).executions[0].actions.canRecheck, false);
    await assert.rejects(f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }), { code: 'cannot_recheck' });
  }
  db.prepare('UPDATE executions SET record=? WHERE id=?').run(original, f.state.sourceId); db.close(); f.state.planning.run.approvals.plan = null;
  await assert.rejects(f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }), { code: 'cannot_recheck' }); assert.equal(f.state.inspections.length, 0);
});

test('deep inspector mismatched binding or original report stops a new recheck before any Review', async t => {
  for (const kind of ['binding', 'source']) {
    const f = await recheckFixture(t); f.state.inspectHook = async (_options, value) => { const result = value(); if (kind === 'binding') result.summary.sourceBinding.runId = 'foreign-run'; else result.source.candidateCommit = '0'.repeat(40); return result; };
    await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' });
    const result = await waitFor(f.service, value => value.executions[0].status === 'failed'); assert.equal(result.executions[0].calls, 0); assert.equal(result.executions[0].reviewCalls, 0); assert.equal(f.state.rechecks.length, 0);
    assert.equal(result.executions[1].status, 'failed'); assert.equal(result.executions[1].usage.inputTokens, 900);
  }
});

test('recheck admission cancellation prevents a late inspector from constructing a Review executor', async t => {
  const f = await recheckFixture(t), entered = deferred(), release = deferred();
  f.state.inspectHook = async (_options, value) => { entered.resolve(); await release.promise; return value(); };
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); await entered.promise;
  const result = await f.service.action({ ...ids, executionId: execution.id, action: 'cancel' }); assert.equal(result.execution.status, 'cancel_requested'); release.resolve();
  await waitFor(f.service, value => value.executions[0].status === 'stopped'); assert.equal(f.state.rechecks.length, 0);
});

test('the row admission deadline aborts a slow inspector and rejects synchronous elapsed-budget overruns before Review dispatch', async t => {
  for (const synchronous of [false, true]) {
    const f = await recheckFixture(t); await setRecheckTimeout(f, 25); let signal;
    f.state.inspectHook = async (options, value) => {
      signal = options.signal;
      if (synchronous) { const until = Date.now() + 80; while (Date.now() < until) { /* Block the timer to exercise the explicit elapsed check. */ } }
      else await new Promise(resolve => setTimeout(resolve, 100));
      return value();
    };
    const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' });
    const result = await waitFor(f.service, value => value.executions[0].status === 'timed_out');
    assert.equal(signal.aborted, true); assert.equal(f.state.rechecks.length, 0); assert.equal(result.executions[0].reviewCalls, 0);
    assert.equal(result.executions[0].taskAccepted, false); assert.equal(result.executions[0].budget.timeoutMs, 25);
    assert.equal(result.capabilities.canStart, true, 'a settled inspector may release the slot after the timeout');
    const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), privateRow = db.prepare('SELECT snapshot FROM executions WHERE id=?').get(execution.id); db.close();
    assert.equal(JSON.parse(privateRow.snapshot).admission.sourceReportPath, f.state.original.reportPath);
  }
});

test('cooperative admission consumes the shared budget and only the remaining time reaches the new core execution', async t => {
  const f = await recheckFixture(t); await setRecheckTimeout(f, 1500);
  f.state.inspectHook = async (_options, value) => { await new Promise(resolve => setTimeout(resolve, 150)); return value(); };
  await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); const entry = await waitRecheck(f);
  assert.ok(entry.options.timeoutMs >= 1 && entry.options.timeoutMs <= 1350, `remaining core budget was ${entry.options.timeoutMs}`);
  await entry.pass(); const result = await waitFor(f.service, value => value.executions[0].taskAccepted);
  assert.equal(result.executions[0].budget.timeoutMs, 1500, 'the DTO retains the confirmed total budget, not a fresh allowance');
});

test('a core result returned after the shared deadline cannot publish a late accepted task', async t => {
  const f = await recheckFixture(t); await setRecheckTimeout(f, 500); f.state.manualRecheckCancel = true;
  await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); const entry = await waitRecheck(f);
  await new Promise(resolve => entry.options.signal.aborted ? resolve() : entry.options.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal((await f.service.list(ids)).capabilities.canStart, false); await entry.pass();
  const result = await waitFor(f.service, value => value.executions[0].status === 'timed_out');
  assert.equal(entry.cancelled, 1); assert.equal(result.executions[0].taskAccepted, false); assert.equal(result.executions[0].actions.canDownload, false);
});

test('non-cooperative admission drains without releasing the slot, then preserves unknown source evidence and never dispatches Review', async t => {
  for (const cancel of [false, true]) {
    const f = await recheckFixture(t); await setRecheckTimeout(f, cancel ? 15000 : 50); const entered = deferred(), release = deferred(); let signal;
    f.state.inspectHook = async options => { signal = options.signal; entered.resolve(); return release.promise; };
    const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); await entered.promise;
    if (cancel) await f.service.action({ ...ids, executionId: execution.id, action: 'cancel' });
    await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
    const draining = await f.service.list(ids); assert.ok(['cancel_requested', 'stopping'].includes(draining.executions[0].status));
    assert.equal(draining.capabilities.canStart, false); assert.equal(f.state.rechecks.length, 0);
    const result = await waitFor(f.service, value => value.executions[0].status === 'reconciliation_required', 7500);
    assert.equal(result.executions[0].taskAccepted, false); assert.equal(result.executions[0].reviewCalls, 0); assert.equal(f.state.rechecks.length, 0);
    assert.equal(result.capabilities.canStart, false); await assert.rejects(f.service.start(startInput), { code: 'execution_active' });
    const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), evidence = JSON.parse(db.prepare('SELECT record FROM source_history WHERE execution_id=?').get(execution.id).record);
    assert.equal(evidence.admission.sourceServiceExecutionId, f.state.sourceId); assert.equal(evidence.admission.sourceReportPath, f.state.original.reportPath);
    assert.equal(evidence.admission.sourceWorkspace, f.state.original.workspace); assert.equal(evidence.admission.inspectionSettled, false);
    assert.equal(evidence.admission.outputDirectory, path.join(f.rootDir, 'executions', execution.id));
    assert.ok(!JSON.stringify(result).includes(f.rootDir));
    if (!cancel) {
      release.reject(Object.assign(new Error('late unknown Git stop'), { result: { pid: 919191, terminationConfirmed: false, controlDirectory: 'C:/private/late-admission' }, probeDirectory: 'C:/private/late-probe' }));
      for (let i = 0; i < 100 && db.prepare('SELECT COUNT(*) count FROM source_history WHERE execution_id=?').get(execution.id).count < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
      const late = db.prepare('SELECT record FROM source_history WHERE execution_id=?').all(execution.id).map(item => JSON.parse(item.record)).find(item => item.result?.pid === 919191);
      assert.equal(late.result.controlDirectory, 'C:/private/late-admission'); assert.equal(late.probeDirectory, 'C:/private/late-probe');
    }
    db.close(); await f.service.shutdown();
    if (cancel) release.resolve({}); // A response after shutdown must not publish or mutate the next controller.
    const next = await f.open(); assert.equal((await next.list(ids)).executions[0].status, 'reconciliation_required'); assert.equal((await next.list(ids)).capabilities.canStart, false);
  }
});

test('abort-confirmed inspector completion and an unknown stop result stay distinct', async t => {
  const f = await recheckFixture(t); await setRecheckTimeout(f, 50);
  f.state.inspectHook = options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Git termination unknown'), {
    result: { pid: 929292, startedAt: new Date().toISOString(), terminationConfirmed: false, controlDirectory: 'C:/private/admission-control' }, probeDirectory: 'C:/private/admission-probe',
  })), { once: true }));
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' });
  const result = await waitFor(f.service, value => value.executions[0].status === 'reconciliation_required'); assert.equal(f.state.rechecks.length, 0);
  const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), evidence = JSON.parse(db.prepare('SELECT record FROM source_history WHERE execution_id=?').get(execution.id).record); db.close();
  assert.equal(evidence.result.pid, 929292); assert.equal(evidence.admission.sourceReportPath, f.state.original.reportPath); assert.equal(result.capabilities.canStart, false);
  assert.ok(!JSON.stringify(result).includes('929292') && !JSON.stringify(result).includes('admission-control'));
});

test('late recheck pass cannot override cancellation or a new planning version', async t => {
  for (const kind of ['cancel', 'stale']) {
    const f = await recheckFixture(t); f.state.manualRecheckCancel = true; const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }), entry = await waitRecheck(f);
    if (kind === 'cancel') await f.service.action({ ...ids, executionId: execution.id, action: 'cancel' }); else f.state.planning.run.approvals.spec = null;
    await entry.pass(); const result = await waitFor(f.service, value => ['stopped', 'superseded'].includes(value.executions[0].status));
    assert.equal(result.executions[0].taskAccepted, false); assert.equal(result.executions[0].actions.canDownload, false); assert.equal(result.executions[1].calls, 1);
  }
});

test('recheck unknown source termination remains private and blocked across restart', async t => {
  const f = await recheckFixture(t); f.state.inspectHook = async () => { throw Object.assign(new Error('private unknown source'), { reconciliationRequired: true, result: { pid: 878787, terminationConfirmed: false, controlDirectory: 'C:/private/recheck-control' }, probeDirectory: 'C:/private/recheck-probe' }); };
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' });
  const result = await waitFor(f.service, value => value.executions[0].status === 'reconciliation_required'); assert.equal(result.executions[0].calls, 0); assert.equal(f.state.rechecks.length, 0);
  const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), proof = JSON.parse(db.prepare('SELECT record FROM source_history WHERE execution_id=?').get(execution.id).record); db.close(); assert.equal(proof.result.pid, 878787);
  assert.ok(!JSON.stringify(result).includes('878787') && !JSON.stringify(result).includes('recheck-control')); await f.service.shutdown();
  const next = await f.open(); assert.equal((await next.list(ids)).capabilities.canStart, false); assert.equal((await next.list(ids)).executions[0].status, 'reconciliation_required');
});

test('recheck Review blocking or fresh check failure never inherits original passing HTTP/browser evidence', async t => {
  for (const kind of ['review', 'http']) {
    const f = await recheckFixture(t); await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); const entry = await waitRecheck(f), result = acceptedRecord(entry);
    if (kind === 'review') { result.versions[0].acceptance.review.openBlockingIssues = 1; result.versions[0].acceptance.review.issues.push({ severity: 'blocking' }); }
    else result.versions[0].acceptance.test.checks[0].passed = false;
    await entry.pass({ versions: result.versions }); const report = await waitFor(f.service, value => value.executions[0].status === 'failed');
    assert.equal(report.executions[0].taskAccepted, false); assert.equal(report.executions[0].actions.canPreview, false); assert.equal(report.executions[1].versions[0].acceptance.test.status, 'passed');
  }
});

test('a new valid blocking Review revokes publication of the same old accepted commit and cannot be washed by another recheck', async t => {
  const f = await recheckFixture(t), db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite'));
  Object.assign(f.state.original, { status: 'accepted', acceptanceStatus: 'passed', error: null }); f.state.original.versions[0].acceptance.status = 'passed'; f.state.original.versions[0].acceptance.review.status = 'completed';
  db.prepare('UPDATE executions SET record=?,status=? WHERE id=?').run(JSON.stringify(f.state.original), 'accepted', f.state.sourceId); db.close();
  await writeFile(f.state.original.reportPath, JSON.stringify(f.state.original)); assert.equal((await f.service.list(ids)).executions[0].taskAccepted, true);
  await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); const entry = await waitRecheck(f), result = acceptedRecord(entry);
  const issue = { id: 'ISSUE-known-new', severity: 'blocking', status: 'open', file: 'src/app.mjs', line: 1, message: 'The fixed route has a reproducible business error', evidence: files[0].content.trim(), originCommit: result.candidateCommit };
  const gate = result.versions[0].acceptance; gate.status = 'changes_requested'; gate.review.kind = 'model'; gate.review.openBlockingIssues = 1;
  gate.review.issues = [{ severity: issue.severity, file: issue.file, line: issue.line, message: issue.message, evidence: issue.evidence }]; gate.issues = [issue]; gate.openIssues = [issue];
  await entry.pass({ status: 'failed', acceptanceStatus: 'changes_requested', versions: result.versions });
  const list = await waitFor(f.service, value => value.executions[0].status === 'failed'), old = list.executions.find(value => value.id === f.state.sourceId);
  assert.equal(old.status, 'accepted', 'historical state remains intact'); assert.equal(old.taskAccepted, false); assert.equal(old.actions.canDownload, false); assert.equal(old.actions.canPreview, false); assert.equal(old.actions.canRecheck, false);
  assert.equal(old.actions.canRetry, true); assert.match(old.error, /先修复形成新代码版本/u);
  await assert.rejects(f.service.download({ ...ids, executionId: f.state.sourceId }), { code: 'not_accepted' });
  await assert.rejects(f.service.action({ ...ids, executionId: f.state.sourceId, action: 'preview' }), { code: 'not_accepted' });
  await assert.rejects(f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }), { code: 'cannot_recheck' });
  assert.equal(f.state.rechecks.length, 1);
  const history = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), saved = history.prepare('SELECT record,snapshot FROM executions WHERE id=?').get(list.executions[0].id);
  const malformed = JSON.parse(saved.record); malformed.versions[0].acceptance.review.status = 'error';
  history.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(malformed), list.executions[0].id);
  let restored = (await f.service.list(ids)).executions.find(value => value.id === f.state.sourceId);
  assert.equal(restored.taskAccepted, true, 'an invalid Review response cannot create a new blocking finding'); assert.equal(restored.actions.canRecheck, true);
  const different = JSON.parse(saved.record.replaceAll('a'.repeat(40), 'b'.repeat(40))), differentSnapshot = JSON.parse(saved.snapshot);
  differentSnapshot.sourceProof.sourceCommit = 'b'.repeat(40);
  history.prepare('UPDATE executions SET record=?,snapshot=? WHERE id=?').run(JSON.stringify(different), JSON.stringify(differentSnapshot), list.executions[0].id); history.close();
  restored = (await f.service.list(ids)).executions.find(value => value.id === f.state.sourceId);
  assert.equal(restored.taskAccepted, true, 'a finding for another commit does not revoke this commit'); assert.equal(restored.actions.canRecheck, true);
});

test('canonical Review findings in README and legal dot-dot or Unicode names revoke old publication and remain visible in DTO', async t => {
  for (const file of ['README.md', 'docs/a..b.md', 'docs/中文说明.md']) {
    files.unshift({ path: file, content: 'Protected routes require authenticated sessions.\n' });
    try {
      const f = await recheckFixture(t), db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite'));
      Object.assign(f.state.original, { status: 'accepted', acceptanceStatus: 'passed', error: null }); f.state.original.versions[0].acceptance.status = 'passed'; f.state.original.versions[0].acceptance.review.status = 'completed';
      db.prepare('UPDATE executions SET record=?,status=? WHERE id=?').run(JSON.stringify(f.state.original), 'accepted', f.state.sourceId); db.close();
      await writeFile(f.state.original.reportPath, JSON.stringify(f.state.original)); assert.equal((await f.service.list(ids)).executions[0].taskAccepted, true);
      await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); const entry = await waitRecheck(f), result = acceptedRecord(entry);
      const issue = { id: 'ISSUE-canonical-path', severity: 'blocking', status: 'open', file, line: 1, message: 'The published contract contradicts authentication behavior', evidence: files[0].content.trim(), originCommit: result.candidateCommit };
      const checked = validateProjectReviewResponse({ summary: 'A code revision is required', issues: [issue], resolutions: [] }, { files, previousIssues: [] });
      const gate = result.versions[0].acceptance; gate.status = 'changes_requested'; gate.review = { ...gate.review, ...checked, kind: 'model', openBlockingIssues: 1 }; gate.issues = [issue]; gate.openIssues = [issue];
      await entry.pass({ status: 'failed', acceptanceStatus: 'changes_requested', versions: result.versions });
      const list = await waitFor(f.service, value => value.executions[0].status === 'failed'), old = list.executions.find(value => value.id === f.state.sourceId);
      assert.equal(list.executions[0].versions[0].acceptance.openIssues[0].file, file); assert.equal(old.status, 'accepted');
      assert.equal(old.taskAccepted, false); assert.equal(old.actions.canDownload, false); assert.equal(old.actions.canPreview, false); assert.equal(old.actions.canRecheck, false);
      await assert.rejects(f.service.download({ ...ids, executionId: old.id }), { code: 'not_accepted' });
      await assert.rejects(f.service.action({ ...ids, executionId: old.id, action: 'preview' }), { code: 'not_accepted' });
      await assert.rejects(f.service.action({ ...startInput, executionId: old.id, action: 'recheck' }), { code: 'cannot_recheck' }); assert.equal(f.state.rechecks.length, 1);
    } finally { files.shift(); }
  }
});

test('recheck download rejects snapshot tampering and changed original report provenance', async t => {
  for (const kind of ['snapshot', 'report']) {
    const f = await recheckFixture(t); const { execution } = await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }), entry = await waitRecheck(f); await entry.pass();
    await waitFor(f.service, value => value.executions[0].taskAccepted);
    if (kind === 'snapshot') await writeFile(path.join(entry.record.workspace, 'src', 'app.mjs'), 'export const changed=true;'); else f.state.reportHash = '0'.repeat(64);
    await assert.rejects(f.service.download({ ...ids, executionId: execution.id }), { code: 'source_changed' }); assert.equal(f.state.deliveries.length, 0);
    assert.equal((await f.service.list(ids)).executions[0].taskAccepted, false);
  }
});

test('a trusted project checkpoint acquires synchronously, blocks same-project admission and preserves cross-project independence', async t => {
  const f = await fixture(t), executionId = await accept(f.service, f.state), entered = deferred(), release = deferred(), answer = { trusted: 'callback result' };
  f.state.getPlanning = async (projectId, runId) => { if (projectId === ids.projectId) return f.state.planning; const value = planning(); value.project.id = projectId; value.run.id = runId; return value; };
  const checkpoint = f.service.withProjectCheckpoint(ids.projectId, async () => { entered.resolve(); await release.promise; return answer; });
  await entered.promise; try { await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('nested checkpoint entered')), { code: 'project_checkpoint' });
  await assert.rejects(f.service.start(startInput), { code: 'project_checkpoint' });
  for (const action of ['retry', 'recheck', 'preview']) await assert.rejects(f.service.action({ ...(action === 'preview' ? ids : startInput), executionId, action }), { code: 'project_checkpoint' });
  await assert.rejects(f.service.download({ ...ids, executionId }), { code: 'project_checkpoint' });
  const during = await f.service.list(ids); assert.equal(during.capabilities.canStart, false); assert.equal(during.executions[0].taskAccepted, false); assert.equal(during.executions[0].actions.canDownload, false);
  const other = await f.service.start({ ...startInput, projectId: 'other-project', runId: 'other-run' }); assert.equal(other.execution.status, 'preparing');
  assert.equal(await f.service.withProjectCheckpoint('third-project', () => 7), 7); } finally { release.resolve(); } assert.equal(await checkpoint, answer);
  assert.equal((await f.service.list(ids)).executions[0].taskAccepted, true); assert.equal(f.state.calls.length, 2);
});

test('checkpoint callback failures retain identity, always release the barrier, and cannot be sent as an HTTP-style action', async t => {
  const f = await fixture(t);
  for (const asynchronous of [false, true]) {
    const failure = Object.assign(new Error('trusted work failed'), { code: 'trusted_work_failure' });
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, asynchronous ? async () => { await Promise.resolve(); throw failure; } : () => { throw failure; }), value => value === failure);
    assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => 'released'), 'released');
  }
  await assert.rejects(f.service.withProjectCheckpoint('../invalid', () => {}), { code: 'invalid_id' });
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, {}), { code: 'invalid_input' });
  const { execution } = await f.service.start(startInput); f.state.calls[0].finish(); await waitFor(f.service, value => value.executions[0].status === 'failed');
  await assert.rejects(f.service.action({ ...ids, executionId: execution.id, action: 'withProjectCheckpoint', work: () => {} }), { code: 'invalid_input' });
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => true), true);
});

test('checkpoint SQLite admission checks every run and all active, unknown and preview states without stopping them', async t => {
  const f = await fixture(t), executionId = await accept(f.service, f.state), db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')); let called = 0;
  for (const [active, status, preview] of [[1, 'accepted', 'none'], [0, 'reconciliation_required', 'none'], ...['starting', 'running', 'stopping', 'unknown'].map(state => [0, 'accepted', state])]) {
    db.prepare('UPDATE executions SET run_id=?,active=?,status=?,preview_state=? WHERE id=?').run('another-run', active, status, preview, executionId);
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => called++), { code: 'project_busy' });
    const row = db.prepare('SELECT active,status,preview_state FROM executions WHERE id=?').get(executionId);
    assert.deepEqual({ ...row }, { active, status, preview_state: preview });
  }
  assert.equal(called, 0); assert.equal(f.state.previews.length, 0); db.prepare("UPDATE executions SET run_id=?,active=0,status='accepted',preview_state='none' WHERE id=?").run(ids.runId, executionId); db.close();
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => 'idle'), 'idle');
});

test('start, retry and recheck preparations registered before a pending planning read reject a racing checkpoint', async t => {
  for (const action of ['start', 'retry', 'recheck']) {
    const f = action === 'recheck' ? await recheckFixture(t) : await fixture(t); let executionId = f.state.sourceId;
    if (action === 'retry') { const result = await f.service.start(startInput); executionId = result.execution.id; f.state.calls[0].finish(); await waitFor(f.service, value => value.executions[0].status === 'failed'); }
    const entered = deferred(), release = deferred(); let once = true;
    f.state.getPlanning = async () => { const value = structuredClone(f.state.planning); if (once) { once = false; entered.resolve(); await release.promise; } return value; };
    const pending = action === 'start' ? f.service.start(startInput) : f.service.action({ ...startInput, executionId, action }); await entered.promise;
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('pending preparation was ignored')), { code: 'project_busy' });
    release.resolve(); const result = await pending;
    if (action === 'recheck') { const entry = await waitRecheck(f); entry.finish({ status: 'stopped' }); } else f.state.calls.at(-1).finish();
    await waitFor(f.service, value => ['failed', 'stopped'].includes(value.executions[0].status));
    assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => 'after preparation'), 'after preparation'); assert.ok(result.execution.id);
  }
});

test('preview source verification and every download phase are registered before SQLite activity exists', async t => {
  for (const phase of ['preview_source', 'download_source', 'download_archive']) {
    const entered = deferred(), release = deferred(); let blocking = true;
    const f = await fixture(t, { previewTimeoutMs: 5000, dependencies: {
      verifySource: async () => { if (phase !== 'download_archive' && blocking) { blocking = false; entered.resolve(); await release.promise; } return { files: structuredClone(files), shellHash: 'c'.repeat(64) }; },
      createDelivery: async () => { entered.resolve(); await release.promise; return { zip: Buffer.from('fixture') }; },
    } });
    const executionId = await accept(f.service, f.state), pending = phase === 'preview_source' ? f.service.action({ ...ids, executionId, action: 'preview' }) : f.service.download({ ...ids, executionId });
    await entered.promise; const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')); assert.equal(db.prepare('SELECT active FROM executions WHERE id=?').get(executionId).active, 0); db.close();
    await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('in-flight source/archive work was ignored')), { code: 'project_busy' });
    release.resolve(); await pending; if (phase === 'preview_source') await f.service.action({ ...ids, executionId, action: 'stop_preview' });
    assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => true), true);
  }
});

test('cancel acknowledgement remains in flight after actual stop, while preview stopping remains a real active slot', async t => {
  const f = await fixture(t); f.state.manualCancel = true; const { execution } = await f.service.start(startInput), entered = deferred(), release = deferred(); let once = true;
  f.state.getPlanning = async () => { if (once) { once = false; entered.resolve(); await release.promise; } return f.state.planning; };
  const cancel = f.service.action({ ...ids, executionId: execution.id, action: 'cancel' }); await entered.promise;
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => {}), { code: 'project_busy' }); f.state.calls[0].finish({ status: 'stopped' });
  await waitFor(f.service, value => value.executions[0].status === 'stopped');
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => {}), { code: 'project_busy' }); release.resolve(); await cancel;
  assert.equal(await f.service.withProjectCheckpoint(ids.projectId, () => true), true);
  const stopping = deferred(), stopRelease = deferred(), done = deferred();
  const g = await fixture(t, { previewTimeoutMs: 5000, dependencies: { startRuntime: async () => ({ url: 'http://localhost:43210', pid: 515151, done: done.promise,
    stop: async () => { stopping.resolve(); const value = await stopRelease.promise; done.resolve(value); return value; } }) } });
  const previewId = await accept(g.service, g.state); await g.service.action({ ...ids, executionId: previewId, action: 'preview' });
  const stop = g.service.action({ ...ids, executionId: previewId, action: 'stop_preview' }); await stopping.promise;
  await assert.rejects(g.service.withProjectCheckpoint(ids.projectId, () => assert.fail('preview was assumed dead')), { code: 'project_busy' });
  stopRelease.resolve({ status: 'stopped', pid: 515151, exitCode: 0, stopAcknowledged: true, sourceUnchanged: true, terminationConfirmed: true }); await stop;
  assert.equal(await g.service.withProjectCheckpoint(ids.projectId, () => 'confirmed'), 'confirmed');
});

test('shutdown rejects new checkpoints and waits for the entered trusted work to release its barrier', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let closed = false;
  const checkpoint = f.service.withProjectCheckpoint(ids.projectId, async () => { entered.resolve(); await release.promise; return 42; }); await entered.promise;
  const shutdown = f.service.shutdown().then(() => { closed = true; });
  await assert.rejects(f.service.withProjectCheckpoint('another-project', () => assert.fail('entered during close')), { code: 'shutting_down' });
  await assert.rejects(f.service.start(startInput), { code: 'shutting_down' }); assert.equal(closed, false); release.resolve(); assert.equal(await checkpoint, 42); await shutdown;
  assert.equal(closed, true); await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => {}), { code: 'stale_owner' });
});

test('current source revision and superseded flags revoke old execution publication while legacy records remain compatible', async t => {
  const f = await fixture(t), executionId = await accept(f.service, f.state), original = structuredClone(f.state.planning.run);
  assert.equal((await f.service.list(ids)).executions[0].taskAccepted, true);
  f.state.planning.project.currentSourceRevision = original.sourceRevision; assert.equal((await f.service.list(ids)).executions[0].taskAccepted, true);
  for (const variant of ['revision', 'flag', 'invalid_revision']) {
    f.state.planning.run.sourceSuperseded = variant === 'flag'; f.state.planning.project.currentSourceRevision = variant === 'revision' ? '0'.repeat(64) : variant === 'invalid_revision' ? null : original.sourceRevision;
    const result = await f.service.list(ids); assert.equal(result.capabilities.canStart, false); assert.equal(result.executions[0].status, 'accepted'); assert.equal(result.executions[0].taskAccepted, false);
    for (const permission of ['canRetry', 'canRecheck', 'canPreview', 'canDownload']) assert.equal(result.executions[0].actions[permission], false);
    await assert.rejects(f.service.start(startInput), { code: 'source_superseded' }); await assert.rejects(f.service.download({ ...ids, executionId }), { code: 'not_accepted' });
    await assert.rejects(f.service.action({ ...ids, executionId, action: 'preview' }), { code: 'not_accepted' });
    assert.equal(f.state.calls.length, 1); assert.equal(f.state.previews.length, 0);
  }
  delete f.state.planning.project.currentSourceRevision; delete f.state.planning.run.sourceSuperseded;
  assert.deepEqual(f.state.planning.run, original); assert.equal((await f.service.list(ids)).executions[0].taskAccepted, true);
});

test('an old list read cannot revive capability or task acceptance after a source publication checkpoint', async t => {
  const f = await fixture(t), executionId = await accept(f.service, f.state), entered = deferred(), release = deferred(); let once = true;
  f.state.getPlanning = async () => { const old = structuredClone(f.state.planning); if (once) { once = false; entered.resolve(); await release.promise; } return old; };
  const pending = f.service.list(ids); await entered.promise;
  await f.service.withProjectCheckpoint(ids.projectId, () => { f.state.planning.project.currentSourceRevision = '0'.repeat(64); f.state.planning.run.sourceSuperseded = true; });
  release.resolve(); const result = await pending; assert.equal(result.capabilities.canStart, false); assert.equal(result.executions[0].taskAccepted, false);
  await assert.rejects(f.service.download({ ...ids, executionId }), { code: 'not_accepted' }); assert.equal(f.state.deliveries.length, 0);
});

test('a multi-row list withdraws every completed DTO permission when a new source is published behind its last pending row', async t => {
  const f = await recheckFixture(t), acceptedId = await accept(f.service, f.state), before = await f.service.list(ids);
  assert.equal(before.executions[0].taskAccepted, true); assert.equal(before.executions[1].actions.canRetry, true); assert.equal(before.executions[1].actions.canRecheck, true);
  const entered = deferred(), release = deferred(); let reads = 0;
  f.state.getPlanning = async () => { const value = structuredClone(f.state.planning); if (++reads === 3) { entered.resolve(); await release.promise; } return value; };
  const pending = f.service.list(ids); await entered.promise; await new Promise(resolve => setImmediate(resolve));
  await f.service.withProjectCheckpoint(ids.projectId, () => {
    const source = { content: '# New current requirement\nA different source version.', filename: 'new.md' };
    f.state.planning.project.source = source; f.state.planning.project.currentSourceRevision = contentRevision(source); f.state.planning.run.sourceSuperseded = true;
  });
  release.resolve(); const result = await pending; assert.equal(result.capabilities.canStart, false);
  for (const execution of result.executions) {
    assert.equal(execution.taskAccepted, false); assert.equal(execution.preview, null);
    for (const action of ['canRetry', 'canRecheck', 'canPreview', 'canDownload']) assert.equal(execution.actions[action], false, `${execution.id}: ${action}`);
  }
  assert.equal(result.executions[0].status, 'accepted'); assert.equal(result.executions[1].status, 'failed');
  assert.equal((await f.service.list(ids)).executions.every(value => !value.taskAccepted), true);
  await assert.rejects(f.service.download({ ...ids, executionId: acceptedId }), { code: 'not_accepted' }); assert.equal(f.state.deliveries.length, 0);
});

test('multi-row list generation withdrawal is conservative after checkpoint success or failure and a fresh read restores unchanged context', async t => {
  for (const rejectedWork of [false, true]) {
    const f = await recheckFixture(t); await accept(f.service, f.state); const entered = deferred(), release = deferred(); let reads = 0;
    f.state.getPlanning = async () => { const value = structuredClone(f.state.planning); if (++reads === 3) { entered.resolve(); await release.promise; } return value; };
    const pending = f.service.list(ids); await entered.promise; await new Promise(resolve => setImmediate(resolve));
    if (rejectedWork) { const error = new Error('trusted no-publication failure'); await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => { throw error; }), value => value === error); }
    else await f.service.withProjectCheckpoint(ids.projectId, () => 'unchanged');
    release.resolve(); const result = await pending;
    for (const execution of result.executions) { assert.equal(execution.taskAccepted, false); assert.equal(execution.preview, null); for (const action of ['canRetry', 'canRecheck', 'canPreview', 'canDownload']) assert.equal(execution.actions[action], false); }
    const fresh = await f.service.list(ids); assert.equal(fresh.capabilities.canStart, true); assert.equal(fresh.executions[0].taskAccepted, true);
    assert.equal(fresh.executions[1].actions.canRetry, true); assert.equal(fresh.executions[1].actions.canRecheck, true);
  }
});

test('an invalid batch admission clears source permissions and preview links while keeping actual cancel and stop handles', async t => {
  for (const preview of [false, true]) {
    const f = await fixture(t, { previewTimeoutMs: 5000 });
    const executionId = preview ? await accept(f.service, f.state) : (await f.service.start(startInput)).execution.id;
    if (preview) await f.service.action({ ...ids, executionId, action: 'preview' }); let once = true;
    f.state.getPlanning = async () => { if (once) { once = false; throw Object.assign(new Error('context temporarily unavailable'), { status: 409 }); } return f.state.planning; };
    const result = await f.service.list(ids), execution = result.executions[0]; assert.equal(result.capabilities.canStart, false); assert.equal(execution.taskAccepted, false); assert.equal(execution.preview, null);
    for (const action of ['canRetry', 'canRecheck', 'canPreview', 'canDownload']) assert.equal(execution.actions[action], false);
    assert.equal(execution.actions.canCancel, !preview); assert.equal(execution.actions.canStopPreview, preview);
    if (preview) { const fresh = await f.service.list(ids); assert.equal(fresh.executions[0].taskAccepted, true); assert.ok(fresh.executions[0].preview.url); await f.service.action({ ...ids, executionId, action: 'stop_preview' }); }
  }
});

test('a list begun inside an open checkpoint remains unapproved even when publication releases it before the old read returns', async t => {
  const f = await recheckFixture(t); await accept(f.service, f.state); const workEntered = deferred(), publish = deferred(), readEntered = deferred(), releaseRead = deferred();
  const checkpoint = f.service.withProjectCheckpoint(ids.projectId, async () => { workEntered.resolve(); await publish.promise;
    f.state.planning.project.currentSourceRevision = contentRevision({ content: 'published while the list waited', filename: 'new.md' }); f.state.planning.run.sourceSuperseded = true;
  });
  await workEntered.promise; let once = true;
  f.state.getPlanning = async () => { const value = structuredClone(f.state.planning); if (once) { once = false; readEntered.resolve(); await releaseRead.promise; } return value; };
  const pending = f.service.list(ids); await readEntered.promise; publish.resolve(); await checkpoint; releaseRead.resolve(); const result = await pending;
  assert.equal(result.capabilities.canStart, false); assert.equal(result.executions.every(execution => !execution.taskAccepted && !execution.actions.canPreview && !execution.actions.canDownload && !execution.actions.canRetry && !execution.actions.canRecheck && execution.preview === null), true);
});

test('a changed current source blocks a pending preview and coding assertion before any new runtime or model use', async t => {
  const entered = deferred(), release = deferred(), f = await fixture(t, { dependencies: { verifySource: async () => { entered.resolve(); await release.promise; return { files: structuredClone(files), shellHash: 'c'.repeat(64) }; } } });
  const executionId = await accept(f.service, f.state), pending = f.service.action({ ...ids, executionId, action: 'preview' }); await entered.promise;
  f.state.planning.project.currentSourceRevision = '0'.repeat(64); release.resolve(); await assert.rejects(pending, { code: 'stale_version' }); assert.equal(f.state.previews.length, 0);
  let charged = 0, g;
  g = await fixture(t, { dependencies: { codeModel: () => { g.state.planning.run.sourceSuperseded = true; return async () => { charged++; }; },
    startExecution: options => {
      const record = { ...options.binding, status: 'preparing', calls: 0, reviewCalls: 0, budget: { maxCalls: options.maxCalls }, events: [], versions: [] };
      return { snapshot: () => record, cancel() {}, done: (async () => { try { await options.assertCurrent(options.binding); await options.provider(); } catch { record.status = 'failed'; } return record; })() };
    } } });
  await g.service.start(startInput); const result = await waitFor(g.service, value => value.executions[0].status === 'superseded'); assert.equal(charged, 0); assert.equal(result.executions[0].taskAccepted, false);
});

test('a source publication during deep recheck admission prevents constructing the new Review executor', async t => {
  const f = await recheckFixture(t), entered = deferred(), release = deferred();
  f.state.inspectHook = async (_options, value) => { const inspected = value(); entered.resolve(); await release.promise; return inspected; };
  await f.service.action({ ...startInput, executionId: f.state.sourceId, action: 'recheck' }); await entered.promise;
  await assert.rejects(f.service.withProjectCheckpoint(ids.projectId, () => assert.fail('active deep admission was ignored')), { code: 'project_busy' });
  f.state.planning.project.currentSourceRevision = '0'.repeat(64); release.resolve();
  const result = await waitFor(f.service, value => value.executions[0].status === 'superseded');
  assert.equal(f.state.rechecks.length, 0); assert.equal(result.executions[0].calls, 0); assert.equal(result.executions[0].reviewCalls, 0); assert.equal(result.executions[0].actions.canDownload, false);
});

test('owned repair uses the selected failed recheck lineage, fixed source and blocking feedback in a new attempt without old usage', async t => {
  const f = await repairFixture(t), beforeSource = await readFile(f.state.original.reportPath), beforeFinding = await readFile(f.state.finding.reportPath), before = await f.service.list(ids);
  assert.equal(before.executions[0].actions.canRepair, true); assert.equal(before.executions[0].actions.canRecheck, false); assert.equal(before.executions[1].actions.canRepair, false);
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' }); const entry = await waitRepair(f);
  assert.notEqual(execution.id, f.state.findingId); assert.equal(execution.operation, 'repair'); assert.equal(execution.repairSourceExecutionId, f.state.sourceId); assert.equal(execution.repairFindingExecutionId, f.state.findingId);
  assert.deepEqual(entry.options.initialSource.files, files); assert.deepEqual(entry.options.previousIssues, [f.state.issue]); assert.equal(entry.options.initialSource.reviewSourceExecutionId, f.state.finding.id);
  assert.equal(entry.options.maxCalls, 3); assert.equal(entry.options.maxReviewCalls, 3); assert.ok(entry.options.timeoutMs <= 600000);
  await entry.pass(); const result = await waitFor(f.service, value => value.executions[0].taskAccepted), current = result.executions[0];
  assert.equal(current.kind, 'web_execution'); assert.equal(current.calls, 1); assert.deepEqual(current.usage, { inputTokens: 11, outputTokens: 13 });
  assert.notEqual(current.versions[0].commit, f.state.original.candidateCommit); assert.equal(current.versions[0].acceptance.issues[0].status, 'resolved');
  assert.equal(result.executions.find(item => item.id === f.state.findingId).taskAccepted, false); assert.deepEqual(result.executions.find(item => item.id === f.state.sourceId).usage, { inputTokens: 900, outputTokens: 100 });
  assert.deepEqual(await readFile(f.state.original.reportPath), beforeSource); assert.deepEqual(await readFile(f.state.finding.reportPath), beforeFinding);
  await f.service.download({ ...ids, executionId: current.id }); assert.equal(f.state.deliveries.length, 1);
  const preview = await f.service.action({ ...ids, executionId: current.id, action: 'preview' }); assert.equal(preview.execution.taskAccepted, true); await f.service.action({ ...ids, executionId: current.id, action: 'stop_preview' });
  assert.ok(!JSON.stringify(result).includes(f.rootDir) && !JSON.stringify(result).includes('sourceReportHash') && !JSON.stringify(result).includes('receiptPath'));
});

test('repair refuses client provenance, stale contracts, invalid Review and duplicate or foreign issue bindings', async t => {
  const f = await repairFixture(t), input = { ...startInput, executionId: f.state.findingId, action: 'repair' };
  for (const extra of [{ initialSource: {} }, { previousIssues: [] }, { sourceReportPath: '/private/file' }, { binding: {} }, { budget: { maxCalls: 3 } }]) await assert.rejects(f.service.action({ ...input, ...extra }), { code: 'invalid_input' });
  await assert.rejects(f.service.action({ ...input, contractRevision: '0'.repeat(64) }), { code: 'contract_changed' });
  const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), saved = db.prepare('SELECT record,snapshot FROM executions WHERE id=?').get(f.state.findingId);
  for (const mutate of [record => record.versions[0].acceptance.review.status = 'error', record => record.reviewPolicyHash = '0'.repeat(64),
    record => record.versions[0].acceptance.review.binding.runId = 'another-run', record => { const gate = record.versions[0].acceptance; gate.openIssues.push(gate.openIssues[0]); gate.review.openBlockingIssues = 2; }]) {
    const value = JSON.parse(saved.record); mutate(value); db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(value), f.state.findingId);
    assert.equal((await f.service.list(ids)).executions[0].actions.canRepair, false); await assert.rejects(f.service.action(input), { code: 'cannot_repair' });
  }
  db.prepare('UPDATE executions SET record=? WHERE id=?').run(saved.record, f.state.findingId); db.close(); assert.equal(f.state.repairs.length, 0);
});

test('repair deep admission rejects mismatched private reports, paths, provenance and source inspection before constructing code execution', async t => {
  for (const kind of ['report', 'path', 'provenance', 'source']) {
    const f = await repairFixture(t), db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite'));
    if (kind === 'report') await writeFile(f.state.finding.reportPath, JSON.stringify({ ...f.state.finding, error: 'changed private report' }));
    if (kind === 'path' || kind === 'provenance') {
      const record = structuredClone(f.state.finding); if (kind === 'path') record.reportPath = path.join(f.rootDir, 'foreign', 'execution.json'); else record.provenance.sourceReportHash = '0'.repeat(64);
      db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(record), f.state.findingId);
    }
    db.close(); if (kind === 'source') f.state.inspectHook = async (_options, value) => { const result = value(); result.source.candidateCommit = '0'.repeat(40); return result; };
    await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' });
    const result = await waitFor(f.service, value => value.executions[0].status === 'failed'); assert.equal(f.state.repairs.length, 0); assert.equal(result.executions[0].calls, 0); assert.equal(result.executions[0].taskAccepted, false);
    assert.equal(result.executions.find(value => value.id === f.state.findingId).taskAccepted, false);
  }
});

test('unchanged repair source, missing lineage and unclosed original issues cannot inherit a complete passing gate', async t => {
  for (const kind of ['unchanged_hash', 'unchanged_commit', 'lineage', 'resolution', 'failed_check']) {
    const f = await repairFixture(t); await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' }); const entry = await waitRepair(f);
    await entry.pass(value => {
      if (kind === 'unchanged_hash') return JSON.parse(JSON.stringify(value).replaceAll(hash(entry.files), hash(files)));
      if (kind === 'unchanged_commit') return JSON.parse(JSON.stringify(value).replaceAll('b'.repeat(40), 'a'.repeat(40)));
      if (kind === 'lineage') value.repairSource.reviewSourceReportHash = '0'.repeat(64);
      if (kind === 'resolution') value.versions[0].acceptance.issues[0].status = 'open';
      if (kind === 'failed_check') value.versions[0].acceptance.test.checks[0].passed = false;
      return value;
    });
    const result = await waitFor(f.service, value => value.executions[0].status === 'failed'); assert.equal(result.executions[0].taskAccepted, false); assert.equal(result.executions[0].actions.canDownload, false);
    assert.deepEqual(result.executions[0].usage, { inputTokens: 11, outputTokens: 13 }); assert.equal(result.executions.find(value => value.id === f.state.findingId).taskAccepted, false);
  }
});

test('repair cancellation, current-source invalidation and the shared admission deadline win before late code or success', async t => {
  for (const kind of ['cancel_admission', 'deadline', 'late_cancel', 'current']) {
    const f = await repairFixture(t), entered = deferred(), release = deferred();
    if (kind === 'deadline') { await f.service.shutdown(); f.service = await f.open({ budget: { maxCalls: 1, maxReviewCalls: 1, timeoutMs: 25 } }); }
    if (['cancel_admission', 'deadline'].includes(kind)) f.state.inspectHook = async (_options, value) => { entered.resolve(); if (kind === 'deadline') await new Promise(resolve => setTimeout(resolve, 100)); else await release.promise; return value(); };
    const { execution } = await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' });
    if (['cancel_admission', 'deadline'].includes(kind)) {
      await entered.promise; if (kind === 'cancel_admission') { await f.service.action({ ...ids, executionId: execution.id, action: 'cancel' }); release.resolve(); }
      const result = await waitFor(f.service, value => value.executions[0].status === (kind === 'deadline' ? 'timed_out' : 'stopped'));
      assert.equal(f.state.repairs.length, 0); assert.equal(result.executions[0].calls, 0);
    } else {
      const entry = await waitRepair(f); f.state.manualRepairCancel = true;
      if (kind === 'late_cancel') await f.service.action({ ...ids, executionId: execution.id, action: 'cancel' }); else f.state.planning.project.currentSourceRevision = '0'.repeat(64);
      await entry.pass(); const result = await waitFor(f.service, value => ['stopped', 'superseded'].includes(value.executions[0].status)); assert.equal(result.executions[0].taskAccepted, false);
    }
  }
});

test('repair unknown source termination preserves private PID and probe history without a new model executor or DTO disclosure', async t => {
  const f = await repairFixture(t); f.state.inspectHook = async () => { throw Object.assign(new Error('synthetic private source error'), { reconciliationRequired: true, result: { pid: 737373, terminationConfirmed: false, controlDirectory: 'C:/private/repair-control' }, probeDirectory: 'C:/private/repair-probe' }); };
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' });
  const result = await waitFor(f.service, value => value.executions[0].status === 'reconciliation_required'); assert.equal(f.state.repairs.length, 0); assert.equal(result.capabilities.canStart, false);
  const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), privateRecord = JSON.parse(db.prepare('SELECT record FROM source_history WHERE execution_id=?').get(execution.id).record); db.close();
  assert.equal(privateRecord.result.pid, 737373); assert.equal(privateRecord.probeDirectory, 'C:/private/repair-probe'); assert.ok(!JSON.stringify(result).includes('737373') && !JSON.stringify(result).includes('repair-control'));
  await f.service.shutdown(); const next = await f.open(); assert.equal((await next.list(ids)).executions[0].status, 'reconciliation_required');
});

test('changing source or finding report during repair blocks assertions, publication and accepted delivery', async t => {
  for (const phase of ['assertion', 'publication', 'download']) {
    const f = await repairFixture(t); await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' }); const entry = await waitRepair(f);
    if (phase === 'download') { await entry.pass(); await waitFor(f.service, value => value.executions[0].taskAccepted); }
    await writeFile(f.state.finding.reportPath, (await readFile(f.state.finding.reportPath, 'utf8')) + '\n');
    if (phase === 'assertion') { await assert.rejects(entry.options.assertCurrent(entry.options.binding), { code: 'source_changed' }); entry.finish(); }
    else if (phase === 'publication') await entry.pass();
    else await assert.rejects(f.service.download({ ...ids, executionId: (await f.service.list(ids)).executions[0].id }), { code: 'source_changed' });
    const result = await waitFor(f.service, value => value.executions[0].status === 'failed'); assert.equal(result.executions[0].taskAccepted, false); assert.equal(f.state.deliveries.length, 0);
  }
});

test('repair non-cooperative cancellation retains reconciliation evidence after the bounded drain and source changes withdraw all batch repair permissions', async t => {
  const f = await repairFixture(t), entered = deferred(), release = deferred();
  f.state.inspectHook = async () => { entered.resolve(); return release.promise; };
  const { execution } = await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' }); await entered.promise;
  await f.service.action({ ...ids, executionId: execution.id, action: 'cancel' });
  const result = await waitFor(f.service, value => value.executions[0].status === 'reconciliation_required', 7500); assert.equal(f.state.repairs.length, 0); assert.equal(result.capabilities.canStart, false);
  const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')), stored = db.prepare('SELECT record FROM executions WHERE id=?').get(execution.id), history = JSON.parse(db.prepare('SELECT record FROM source_history WHERE execution_id=?').get(execution.id).record); db.close();
  assert.equal(JSON.parse(stored.record).status, 'reconciliation_required'); assert.equal(history.admission.findingServiceExecutionId, f.state.findingId); assert.equal(history.admission.findingReportPath, f.state.finding.reportPath);
  release.resolve({}); await f.service.shutdown();
  const g = await repairFixture(t), paused = deferred(), resume = deferred(); let reads = 0;
  g.state.getPlanning = async () => { const value = structuredClone(g.state.planning); if (++reads === 3) { paused.resolve(); await resume.promise; } return value; };
  const pending = g.service.list(ids); await paused.promise; await new Promise(resolve => setImmediate(resolve));
  await g.service.withProjectCheckpoint(ids.projectId, () => { g.state.planning.project.currentSourceRevision = '0'.repeat(64); g.state.planning.run.sourceSuperseded = true; });
  resume.resolve(); assert.equal((await pending).executions.every(value => value.actions.canRepair === false), true);
});

test('finding tampering during publication inspection cannot pass the final source proof', async t => {
  const f = await repairFixture(t); await f.service.action({ ...startInput, executionId: f.state.findingId, action: 'repair' }); const entry = await waitRepair(f), entered = deferred(), release = deferred();
  f.state.inspectHook = async (_options, value) => { const source = value(); entered.resolve(); await release.promise; return source; };
  await entry.pass(); await entered.promise; await writeFile(f.state.finding.reportPath, (await readFile(f.state.finding.reportPath, 'utf8')) + '\n'); release.resolve();
  const result = await waitFor(f.service, value => value.executions[0].status === 'failed'); assert.equal(result.executions[0].taskAccepted, false); assert.equal(result.executions[0].actions.canDownload, false);
});

test('an original coded failed row can repair its own valid feedback and simultaneous repair requests reserve only one attempt', async t => {
  const f = await repairFixture(t), original = structuredClone(f.state.original), gate = original.versions[0].acceptance;
  original.reviewPolicyHash = projectReviewPolicy.hash; Object.assign(gate, { status: 'changes_requested', issues: [f.state.issue], openIssues: [f.state.issue] });
  Object.assign(gate.review, { kind: 'model', status: 'completed', resolutions: [], openBlockingIssues: 1, issues: [f.state.issue] });
  const db = new DatabaseSync(path.join(f.rootDir, 'service.sqlite')); db.prepare('UPDATE executions SET record=? WHERE id=?').run(JSON.stringify(original), f.state.sourceId); db.close();
  f.state.original = original; await writeFile(original.reportPath, JSON.stringify(original)); f.state.reportHash = createHash('sha256').update(await readFile(original.reportPath)).digest('hex');
  assert.equal((await f.service.list(ids)).executions.find(value => value.id === f.state.sourceId).actions.canRepair, true);
  const input = { ...startInput, executionId: f.state.sourceId, action: 'repair' }, requests = await Promise.allSettled([f.service.action(input), f.service.action(input)]);
  assert.equal(requests.filter(value => value.status === 'fulfilled').length, 1); const entry = await waitRepair(f); assert.equal(f.state.repairs.length, 1);
  assert.equal(entry.options.initialSource.sourceExecutionId, original.id); assert.equal(entry.options.initialSource.reviewSourceExecutionId, original.id); await entry.pass();
  await waitFor(f.service, value => value.executions[0].taskAccepted);
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
