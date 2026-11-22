import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, unlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles, readProjectFiles } from '../lib/project-files.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = { projectId: 'proposal-repair', runId: 'approved-run', taskId: 'whole', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const task = { title: 'Approved resource fixture', tasks: [{ id: 'implement', title: 'Resource', description: 'Approved resource observations', dependsOn: [], requirementIds: ['R'], writePaths: ['src/app.mjs'], inputs: ['Approved contract'], outputs: ['Resource program'], acceptance: ['Joint observations'] }] };
const badJSON = '{"files":[{"path":"src/app.mjs",\'content\':"malformed JSON must not be applied"}]}';
const fakeKey = 'local-fixture-key-4e78b24d27954af3';
function approved() {
  const proposal = { version: 1, id: 'repair-definition', name: 'Controlled joint observations', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R'], request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'ok', op: 'status', value: 200 }] } }], browser: { version: 1, sessions: ['u'], steps: [{ id: 'go', session: 'u', requirementIds: ['R'], op: 'goto', path: '/' }, { id: 'visible', session: 'u', requirementIds: ['R'], op: 'visible', testId: 'resources', value: true }] } };
  const control = createVerificationControl(), input = { proposal, requirements: ['R'], binding: Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]])) }, approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval); return { manifest, control, approval };
}
if (!process.env.TASKFLOW_PROPOSAL_REPAIR_CHILD) {
  test('bounded pre-edit repair uses native localhost HTTP adapters, real Git and private source receipts; no paid model', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^LLM_|^TASKFLOW_TEAM/iu.test(key))); env.TASKFLOW_PROPOSAL_REPAIR_CHILD = '1'; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }); assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  let active; const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'inert-repair-infrastructure' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => {
    const ready = !(active.mode === 'self-failure' && ++active.http === 1);
    return { status: ready ? 'passed' : 'failed', binding: structuredClone(input.binding), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash, sourceHash: hash(validateProjectFiles(input.files)), terminationConfirmed: true, processes: [{ ...stopped, pid: 1 }], checks: input.manifest.checks.map(rule => ({ ...rule, passed: ready })) };
  } } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), manifestHash: input.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, sourceHash: hash(validateProjectFiles(input.files)), terminationConfirmed: true, browser: { closed: true, version: 'inert-repair-edge' }, processes: [{ ...stopped, kind: 'runtime', pid: 2 }, { ...stopped, kind: 'runtime', pid: 3 }, { ...stopped, kind: 'browser', pid: 4 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, passed: true })) }) } });
  const { createProjectCodeModel } = await import('../lib/project-code-model.mjs');
  const { createProjectReviewModel } = await import('../lib/project-review-model.mjs');
  const { startPlannedWebExecution, isPlannedWebTaskAccepted } = await import('../lib/planned-web-executor.mjs');
  const { inspectPlannedSource, assertPlannedSource } = await import('../lib/planned-source.mjs');
  async function execute(t, mode = 'invalid-first', maxCalls = 2) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'proposal-repair-')), approval = approved(), f = active = { root, mode, coding: 0, review: 0, http: 0, requests: [], persisted: [], live: true }; let handle;
    const server = createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) raw += chunk; const request = JSON.parse(raw), input = JSON.parse(request.messages[1].content), coding = Object.hasOwn(input, 'feedback'), number = coding ? ++f.coding : ++f.review;
        const snapshot = handle.snapshot(), disk = JSON.parse(await readFile(snapshot.reportPath, 'utf8')), pending = snapshot.modelCalls.at(-1);
        assert.ok(disk.modelCalls.some(call => call.id === pending.id && call.inputSourceHash === pending.inputSourceHash && call.startedAt && call.requestState === 'prepared'), 'request identity must be persisted before actual native HTTP dispatch'); f.persisted.push(pending.id); f.requests.push({ role: coding ? 'coding' : 'review', input });
        if (mode === 'unknown' && coding) { res.destroy(); return; }
        const bad = coding && (['invalid-first', 'unknown-usage', 'tamper-receipt', 'cancel', 'stale', 'tamper-source', 'spoof-native-error'].includes(mode) && number === 1 || mode === 'all-invalid' || mode === 'blocking-format' && number === 2);
        const files = [{ path: mode === 'outside-first' && number === 1 ? 'docs/future.md' : 'src/app.mjs', content: `export async function createApp(){return {handle:async()=>({status:200,body:"resource",headers:{}})}}\n// actual candidate ${number}\n` }];
        if (coding && mode === 'duplicate-first' && number === 1) files.push({ path: 'src/app.mjs', content: '// ambiguous duplicate must not be written' });
        const useLiteralFiles = coding && ['invalid-first', 'duplicate-first'].includes(mode) && number === 2;
        if (useLiteralFiles) { assert.equal('response_format' in request, false); assert.match(request.messages[0].content, /TASKFLOW-FILES\/1/u); }
        const content = coding ? mode === 'credential' ? JSON.stringify({ files: [{ path: 'src/app.mjs', content: fakeKey }] }) : bad ? badJSON : useLiteralFiles
          ? `TASKFLOW-FILES/1\nFILE ${files[0].path}\n${files[0].content}END-TASKFLOW-FILE\nEND-TASKFLOW-FILES` : JSON.stringify({ files }) : JSON.stringify({ summary: 'Native local Review fixture',
          issues: mode === 'blocking-format' && number === 1 ? [{ severity: 'blocking', file: input.files[0].path, line: 1, message: 'Retain this original issue across proposal repair' }] : [],
          resolutions: (input.previousIssues ?? []).map(issue => ({ id: issue.id, status: 'resolved', reason: 'Current candidate was reviewed against the original issue' })) });
        if (mode === 'stale' && coding) f.live = false;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], ...(mode === 'unknown-usage' && coding && number === 1 ? {} : { usage: { prompt_tokens: coding ? 2 : 3, completion_tokens: coding ? 3 : 4 } }) }));
      } catch (error) { f.serverError = error; res.destroy(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'native-local-repair-fixture', apiKey: fakeKey }, native = createProjectCodeModel({ config });
    const provider = async input => {
      const options = ['tamper-receipt', 'cancel', 'tamper-source'].includes(mode) ? { ...input, onReceipt: async receipt => {
        await input.onReceipt(receipt);
        if (mode === 'cancel') handle.cancel();
        if (mode === 'tamper-receipt') { const call = handle.snapshot().modelCalls.at(-1); await writeFile(call.receiptPath, (await readFile(call.receiptPath, 'utf8')) + ' '); }
        if (mode === 'tamper-source') await writeFile(path.join(handle.snapshot().workspace, 'src', 'app.mjs'), 'uncommitted out-of-band source\n').catch(async () => { const { mkdir } = await import('node:fs/promises'); await mkdir(path.join(handle.snapshot().workspace, 'src'), { recursive: true }); await writeFile(path.join(handle.snapshot().workspace, 'src', 'app.mjs'), 'uncommitted out-of-band source\n'); });
      } } : input;
      let response;
      try { response = await native(options); }
      catch (error) { if (mode === 'spoof-native-error') throw Object.assign(new Error('untrusted replacement error'), { code: 'invalid_model_response', responseComplete: true, dispatched: true }); throw error; }
      return mode === 'mismatch' ? { ...response, files: [{ path: 'src/app.mjs', content: '// mismatched returned files\n' }] } : response;
    };
    const reviewer = mode === 'diagnostic-blocking' ? async input => {
      const response = { summary: 'Explicit free diagnostic fixture', issues: [{ severity: 'blocking', file: input.files[0].path, line: 1,
        message: 'Diagnostic blocking obligation is still source history', evidence: input.files[0].content.split('\n')[0].trim() }], resolutions: [] };
      await input.onReceipt({ model: 'free-diagnostic-fixture', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 }, content: JSON.stringify(response) }); return response;
    } : createProjectReviewModel({ config: mode === 'unsent-review' ? { ...config, baseUrl: 'invalid%native-url' } : config });
    handle = startPlannedWebExecution({ outputDir: root, binding, task, manifest: approval.manifest, provider, reviewer,
      reviewerKind: mode === 'diagnostic-blocking' ? 'diagnostic' : 'model', maxCalls, maxReviewCalls: mode === 'blocking-format' ? 2 : 1, timeoutMs: 30000, assertCurrent: () => f.live });
    f.record = await handle.done; f.handle = handle; f.manifest = approval.manifest; assert.ifError(f.serverError);
    t.after(async () => { await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('proposal-repair-')); await rm(root, { recursive: true, force: true }); }); return f;
  }
  const inspect = f => inspectPlannedSource({ rootDir: f.root, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'] });
  for (const mode of ['invalid-first', 'outside-first']) test(`native complete ${mode} is never applied, stays paid history, then creates attempt2 candidate and complete acceptance`, async t => {
    const f = await execute(t, mode), { record } = f; assert.equal(record.status, 'accepted', record.error); assert.equal(record.terminationConfirmed, true); assert.equal(record.errorCode, null); assert.equal(f.coding, 2); assert.equal(f.review, 1); assert.equal(record.totalModelCalls, 3); assert.deepEqual(record.usage, { inputTokens: 7, outputTokens: 10 });
    assert.deepEqual(record.versions.map(version => version.attempt), [2]); assert.equal(record.modelCalls[0].proposalRejection.reason, mode === 'invalid-first' ? 'proposal_invalid' : 'proposal_outside_scope'); assert.equal(record.modelCalls[0].proposalRejection.applied, false); assert.equal(record.modelCalls[1].attempt, 2); assert.equal(f.persisted.length, 3);
    assert.deepEqual((await readProjectFiles(record.workspace)).map(file => file.path), ['src/app.mjs']); const feedback = JSON.parse(f.requests.filter(r => r.role === 'coding')[1].input.feedback); assert.deepEqual(feedback.allowedPaths, ['src/app.mjs']); assert.equal(feedback.applied, false); assert.equal(Object.hasOwn(feedback, 'previousResponse'), false); assert.equal(JSON.stringify(feedback).includes(fakeKey), false);
    if (mode === 'invalid-first') {
      assert.equal(JSON.parse(await readFile(record.modelCalls[0].receiptPath, 'utf8')).content, badJSON);
      assert.equal(record.modelCalls[1].codeWireVersion, 2);
      const literalReceipt = JSON.parse(await readFile(record.modelCalls[1].receiptPath, 'utf8'));
      assert.ok(literalReceipt.content.includes('body:"resource"'));
    }
    const source = assertPlannedSource(await inspect(f), binding, ['src/app.mjs']); assert.equal(source.provenance.sourceModelReceiptHashes.length, 3); assert.equal(source.provenance.sourceModelCalls, 3); assert.equal(isPlannedWebTaskAccepted(record, f.manifest), true);
  });
  test('duplicate output paths are rejected before Git write and consume one call of the same repair budget', async t => {
    const f = await execute(t, 'duplicate-first'), { record } = f;
    assert.equal(record.status, 'accepted', record.error);
    assert.equal(f.coding, 2);
    assert.equal(f.review, 1);
    assert.deepEqual(record.versions.map(version => version.attempt), [2]);
    const [rejected, replacement] = record.modelCalls;
    const recorded = JSON.parse(await readFile(rejected.receiptPath, 'utf8'));
    assert.deepEqual(JSON.parse(recorded.content).files.map(file => file.path), ['src/app.mjs', 'src/app.mjs']);
    assert.equal(rejected.proposalRejection.reason, 'proposal_invalid');
    assert.equal(rejected.proposalRejection.applied, false);
    assert.equal(rejected.inputSourceHash, replacement.inputSourceHash);
    assert.equal(replacement.codeWireVersion, 2);
    assert.deepEqual(record.usage, { inputTokens: 7, outputTokens: 10 });
    assert.equal(record.totalModelCalls, 3);
    assert.equal(isPlannedWebTaskAccepted(record, f.manifest), true);
    assert.equal(assertPlannedSource(await inspect(f), binding, ['src/app.mjs']).provenance.sourceModelReceiptHashes.length, 3);
  });
  test('bounded repeated malformed proposals exhaust original calls without versions, source edits or Review', async t => {
    const f = await execute(t, 'all-invalid', 3); assert.equal(f.record.status, 'failed'); assert.equal(f.record.errorCode, 'retry_exhausted'); assert.equal(f.coding, 3); assert.equal(f.review, 0); assert.equal(f.record.totalModelCalls, 3); assert.equal(f.record.versions.length, 0); assert.equal(f.record.modelCalls.filter(c => c.proposalRejection).length, 3); assert.deepEqual(await readProjectFiles(f.record.workspace), []);
  });
  for (const mode of ['credential', 'unknown', 'mismatch', 'tamper-receipt', 'cancel', 'stale', 'tamper-source', 'spoof-native-error']) test(`no automatic retry for unsafe or non-proposal failure: ${mode}`, async t => {
    const f = await execute(t, mode, 3); assert.equal(f.coding, 1); assert.equal(f.review, 0); assert.equal(f.record.versions.length, 0); assert.equal(f.record.modelCalls.some(call => call.proposalRejection), false); assert.notEqual(f.record.status, 'accepted'); assert.equal(JSON.stringify(f.record).includes(fakeKey), false);
    if (mode === 'unknown') { assert.equal(f.record.status, 'reconciliation_required'); assert.equal(f.record.errorCode, 'transport_unknown'); assert.equal(f.record.terminationConfirmed, false); }
    if (mode === 'credential') assert.equal(f.record.errorCode, 'credential_response'); if (mode === 'mismatch' || mode === 'tamper-receipt') assert.equal(f.record.errorCode, 'receipt_mismatch'); if (mode === 'cancel') assert.equal(f.record.errorCode, 'cancelled');
  });
  test('unknown receipt usage stays null after a successful finite format repair', async t => {
    const f = await execute(t, 'unknown-usage'); assert.equal(f.record.status, 'accepted'); assert.equal(f.record.totalModelCalls, 3); assert.deepEqual(f.record.usage, { inputTokens: null, outputTokens: null }); assert.equal((await inspect(f)).kind, 'owned_planned_source');
  });
  test('an intermediate rejected format preserves all earlier blocking Review obligations and retries against the same definition', async t => {
    const f = await execute(t, 'blocking-format', 3); assert.equal(f.record.status, 'accepted'); assert.deepEqual(f.record.versions.map(version => version.attempt), [1, 3]); assert.equal(f.record.totalModelCalls, 5);
    const third = f.requests.filter(item => item.role === 'coding')[2], feedback = JSON.parse(third.input.feedback); assert.equal(feedback.previousIssues.length, 1); assert.equal(feedback.previousIssues[0].status, 'open'); assert.match(feedback.previousVerificationFeedback, /blocking/);
    const reviews = f.requests.filter(item => item.role === 'review'); assert.equal(reviews[1].input.previousIssues.length, 1); assert.deepEqual(JSON.parse(third.input.task).acceptedVerification, JSON.parse(f.requests[0].input.task).acceptedVerification);
    const source = assertPlannedSource(await inspect(f), binding, ['src/app.mjs']); assert.equal(source.previousIssues.length, 1); assert.equal(source.previousIssues[0].status, 'open'); assert.equal(source.provenance.sourceModelReceiptHashes.length, 5);
  });
  test('rejected extra receipts, changed bytes/usage/marker/source state or removed charged calls cannot be reused as source', async t => {
    const f = await execute(t), report = await readFile(f.record.reportPath), receipt = await readFile(f.record.modelCalls[0].receiptPath), filename = f.record.modelCalls[0].receiptPath;
    const restore = async () => { await writeFile(f.record.reportPath, report); await writeFile(filename, receipt); };
    for (const mutate of [r => { r.modelCalls[0].usage.inputTokens++; }, r => { r.modelCalls[0].proposalRejection.inputSourceHash = '0'.repeat(64); }, r => { r.modelCalls[0].proposalRejection.applied = true; }, r => { r.modelCalls[0].proposalRejection.baseCommit = r.candidateCommit; }, r => { r.modelCalls.splice(0, 1); r.totalModelCalls--; }, r => { r.modelCalls[0].dispatched = false; delete r.modelCalls[0].proposalRejection; r.totalModelCalls--; }, r => { r.modelCalls[0].kind = 'diagnostic'; delete r.modelCalls[0].proposalRejection; r.totalModelCalls--; }]) { const record = JSON.parse(report); mutate(record); await writeFile(f.record.reportPath, JSON.stringify(record)); await assert.rejects(inspect(f)); await restore(); }
    await writeFile(filename, Buffer.concat([receipt, Buffer.from(' ')])); await assert.rejects(inspect(f)); await restore();
    await unlink(filename); await assert.rejects(inspect(f)); await restore();
    const extra = path.join(path.dirname(filename), 'model-coding-5.json'); await writeFile(extra, receipt); await assert.rejects(inspect(f)); await unlink(extra); await inspect(f);
  });
  test('legacy unmarked unapplied receipt and explicit unsent zero metadata preserve code history without granting a pass', async t => {
    const f = await execute(t), record = structuredClone(f.record); delete record.modelCalls[0].proposalRejection;
    const unsent = { ...record.modelCalls[1], id: 'legacy-unsent', attempt: 3, inputSourceHash: record.versions.at(-1).sourceHash, dispatched: false,
      receiptConfirmed: false, receiptHash: undefined, receiptPath: undefined, model: undefined, finishReason: undefined, requestState: 'not_dispatched', terminationConfirmed: true, usage: { inputTokens: 0, outputTokens: 0 } };
    record.modelCalls.push(unsent);
    await writeFile(record.reportPath, JSON.stringify(record)); const source = assertPlannedSource(await inspect(f), binding, ['src/app.mjs']); assert.equal(source.provenance.sourceModelCalls, 3); assert.equal(isPlannedWebTaskAccepted(record, f.manifest), false);
    for (const patch of [{ requestState: 'completed' }, { requestState: 'unknown' }, { requestState: 'in_flight' }, { requestState: 'prepared' }, { requestState: undefined },
      { model: 'completed-model' }, { model: '' }, { finishReason: 'stop' }, { finishReason: null }, { receiptHash: '' }, { receiptPath: null }, { terminationConfirmed: false }]) {
      const changed = structuredClone(record); Object.assign(changed.modelCalls.at(-1), patch); await writeFile(record.reportPath, JSON.stringify(changed)); await assert.rejects(inspect(f), 'unsent must not retain completed, unknown, model or receipt evidence');
    }
    await writeFile(record.reportPath, JSON.stringify(record)); assert.equal(assertPlannedSource(await inspect(f), binding, ['src/app.mjs']).provenance.sourceModelCalls, 3);
  });
  test('source role kinds bind both paid Review accounting and legitimate diagnostic history', async t => {
    const paid = await execute(t), record = structuredClone(paid.record), review = record.modelCalls.find(call => call.role === 'review');
    assert.equal(record.reviewerKind, 'model'); assert.equal(review.kind, 'model'); review.kind = 'diagnostic'; record.totalModelCalls--;
    await writeFile(record.reportPath, JSON.stringify(record)); await assert.rejects(inspect(paid), 'a paid Review cannot be relabelled diagnostic to erase one call');
    const diagnostic = await execute(t, 'diagnostic-blocking', 1); assert.equal(diagnostic.record.status, 'failed'); assert.equal(diagnostic.record.reviewerKind, 'diagnostic'); assert.equal(diagnostic.record.totalModelCalls, 1);
    const source = assertPlannedSource(await inspect(diagnostic), binding, ['src/app.mjs']); assert.equal(source.provenance.sourceModelCalls, 1); assert.equal(source.previousIssues.length, 1); assert.equal(source.previousIssues[0].status, 'open');
    for (const kind of ['model', 'trusted_fixture']) { const changed = structuredClone(diagnostic.record); changed.modelCalls.find(call => call.role === 'review').kind = kind;
      changed.totalModelCalls = changed.modelCalls.filter(call => call.kind === 'model' && call.dispatched !== false).length; await writeFile(changed.reportPath, JSON.stringify(changed)); await assert.rejects(inspect(diagnostic)); }
  });
  test('completed Review cannot be erased as unsent to remove its private blocker and reduce source cost', async t => {
    const f = await execute(t, 'blocking-format', 3), record = structuredClone(f.record), review = record.modelCalls.find(call => call.role === 'review');
    assert.equal(record.totalModelCalls, 5); assert.equal(record.versions[0].acceptance.review.issues.length, 1); assert.equal(review.requestState, 'completed'); assert.equal(review.finishReason, 'stop'); assert.equal(typeof review.model, 'string');
    await unlink(review.receiptPath); review.dispatched = false; review.receiptConfirmed = false; review.usage = { inputTokens: 0, outputTokens: 0 }; delete review.receiptHash; delete review.receiptPath; record.totalModelCalls--;
    record.versions[0].acceptance = null; record.versions.at(-1).acceptance.issues = []; await writeFile(record.reportPath, JSON.stringify(record));
    await assert.rejects(inspect(f), 'completed Review metadata contradicts unsent even when its receipt and editable acceptance fields are removed');
  });
  test('actual native predispatch Review remains zero-cost reusable source history without software acceptance', async t => {
    const f = await execute(t, 'unsent-review', 1), review = f.record.modelCalls.find(call => call.role === 'review'); assert.equal(f.record.status, 'failed'); assert.equal(f.coding, 1); assert.equal(f.review, 0); assert.equal(f.record.totalModelCalls, 1);
    assert.equal(review.dispatched, false); assert.equal(review.requestState, 'not_dispatched'); assert.equal(review.terminationConfirmed, true); assert.equal(review.receiptConfirmed, false); assert.deepEqual(review.usage, { inputTokens: 0, outputTokens: 0 });
    for (const key of ['receiptHash', 'receiptPath', 'model', 'finishReason']) assert.equal(Object.hasOwn(review, key), false);
    const source = assertPlannedSource(await inspect(f), binding, ['src/app.mjs']); assert.equal(source.provenance.sourceModelCalls, 1); assert.equal(source.provenance.sourceModelReceiptHashes.length, 1); assert.equal(isPlannedWebTaskAccepted(f.record, f.manifest), false);
    for (const patch of [{ requestState: 'unknown', terminationConfirmed: false }, { requestState: 'not_dispatched', terminationConfirmed: false }]) { const changed = structuredClone(f.record); Object.assign(changed.modelCalls.find(call => call.role === 'review'), patch); await writeFile(changed.reportPath, JSON.stringify(changed)); await assert.rejects(inspect(f)); }
  });
  test('a pre-edit marker cannot hide a real applied commit or skip its Git parent', async t => {
    const f = await execute(t, 'self-failure'), record = structuredClone(f.record); assert.equal(record.status, 'accepted'); assert.equal(record.versions.length, 2); await inspect(f);
    const call = record.modelCalls[0]; record.versions.shift(); record.writablePaths = []; call.errorCode = 'proposal_outside_scope'; call.proposalRejection = { version: 1, stage: 'before_apply', reason: call.errorCode, callId: call.id, baseCommit: record.baseCommit, inputSourceHash: call.inputSourceHash, receiptHash: call.receiptHash, applied: false, terminationConfirmed: true };
    await writeFile(record.reportPath, JSON.stringify(record)); await assert.rejects(inspect(f));
  });
}
