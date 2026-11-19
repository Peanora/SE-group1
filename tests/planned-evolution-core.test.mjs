import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setupPlannedEvolutionFixture, nativeEvolutionAvailable, hash } from './helpers/planned-evolution-fixture.mjs';
import { createVerificationControl, compileManifest, canonicalJSON } from '../lib/verification-contract.mjs';
import { startPlannedWebExecution, isPlannedWebTaskAccepted, isPlannedWebDeliveryAccepted } from '../lib/planned-web-executor.mjs';
import { assertPlannedEvolutionSeedCurrent } from '../lib/planned-evolution-source.mjs';
import { inspectPlannedSource, assertPlannedSource } from '../lib/planned-source.mjs';

// Real core/Git/HTTP/Edge/SQLite; only the coding and Review responses are
// explicit free fixtures. Counts prove this chain, not general business quality.
test('cross-version core preserves real old code/data/history, publishes trusted request IDs and fully revalidates each new candidate', { skip: !nativeEvolutionAvailable, timeout: 240000 }, async t => {
  const f = await setupPlannedEvolutionFixture(t), base = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, f.targetBinding[key]]));
  const proposal = { version: 1, id: 'evolution-check', name: '旧数据保留与新版本检查', sessions: [], steps: [{ id: 'retained', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'old-rows', method: 'GET', path: '/items', assertions: [{ id: 'status', op: 'status', value: 200 }, { id: 'count', op: 'jsonLength', path: '$', value: 2 }] } }],
    browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'rows', session: 'visitor', requirementIds: ['R1'], op: 'count', testId: 'item', value: 2 }, { id: 'notice', session: 'visitor', requirementIds: ['R1'], op: 'text', testId: 'notice', value: '旧数据已核对' }] } };
  const control = createVerificationControl(), input = { proposal, requirements: f.requirements, binding: base }, approval = control.approve({ ...input, feedback: '确认新版本精确旧数据观察' }), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval); t.after(() => control.revoke(approval));
  const binding = { ...base, taskId: 'whole', sourceRevision: f.targetBinding.sourceRevision }, task = { title: '新确认计划', tasks: f.tasks };
  const prompts = [], metadata = [], proofs = []; let execution, calls = 0;
  const inspectRequest = async (request, role) => {
    const identity = request.requestIdentity, snapshot = execution.snapshot(), saved = JSON.parse(await readFile(snapshot.reportPath, 'utf8')), call = saved.modelCalls.find(call => call.id === identity.id);
    assert.ok(Object.isFrozen(identity)); assert.equal(identity.role, role); assert.equal(identity.sourceRevision, f.targetBinding.sourceRevision); assert.ok([1, 2].includes(identity.attempt)); assert.equal(call.requestState, 'prepared');
    for (const field of ['id', 'role', 'kind', 'attempt', 'projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'sourceRevision', 'manifestHash', 'inputSourceHash', 'candidateCommit']) assert.equal(identity[field], call[field]);
    metadata.push(identity); prompts.push(JSON.stringify({ task: request.task, files: request.files, feedback: request.feedback, previousIssues: request.previousIssues }));
  };
  const provider = async request => {
    calls++; await inspectRequest(request, 'coding');
    const original = request.files.find(file => file.path === 'src/app.mjs'), first = request.requestIdentity.attempt === 1;
    const originalApp = f.files.find(file => file.path === 'src/app.mjs').content;
    const content = originalApp.replace("rows.map(row=>row.owner+':'+row.value).join('|')", "rows.map(row=>'<div data-testid=\"item\">'+row.owner+':'+row.value+'</div>').join('')+'<div data-testid=\"notice\">'+" + (first ? "rows.map(row=>row.value).join('|')" : "'旧数据已核对'") + "+'</div>'") + `// current candidate ${request.requestIdentity.attempt} is independently revalidated\n`;
    assert.notEqual(content, original.content); const response = { files: [{ path: original.path, content }], model: 'fixture-coding', usage: { inputTokens: 3, outputTokens: 5 } };
    const proof = await request.onReceipt({ model: response.model, usage: response.usage, finishReason: 'stop', content: JSON.stringify(response) }); assert.ok(Object.isFrozen(proof)); assert.equal(proof.callId, request.requestIdentity.id); assert.equal(Object.hasOwn(proof, 'receiptPath'), false); proofs.push(proof); return response;
  };
  const reviewer = async request => {
    calls++; await inspectRequest(request, 'review'); assert.deepEqual(request.previousIssues.map(issue => issue.id), [f.issue.id]);
    const response = { summary: '新候选按完整定义独立核查', issues: [], resolutions: request.previousIssues.map(issue => ({ id: issue.id, status: 'resolved', reason: '本次候选与旧数据检查重新核对' })), model: 'fixture-review', usage: { inputTokens: 7, outputTokens: 11 } };
    const proof = await request.onReceipt({ model: response.model, usage: response.usage, finishReason: 'stop', content: JSON.stringify(response) }); assert.equal(proof.callId, request.requestIdentity.id); proofs.push(proof); return response;
  };
  const options = { outputDir: f.sourceRootDir, binding, task, manifest, provider, reviewer, evolutionSeed: f.evolutionSeed, assertCurrent: () => f.state.current, maxCalls: 2, maxReviewCalls: 2, timeoutMs: 180000 };
  await t.test('mutual source options, copied capabilities and same-version initialSource cannot authorize cross-version work', async () => {
    assert.throws(() => startPlannedWebExecution({ ...options, initialSource: f.sourceHandle })); assert.throws(() => startPlannedWebExecution({ ...options, evolutionSeed: undefined, initialSource: f.sourceHandle }));
    const fake = startPlannedWebExecution({ ...options, evolutionSeed: structuredClone(f.evolutionSeed) }); assert.equal((await fake.done).status, 'failed'); assert.equal(calls, 0);
    assert.throws(() => assertPlannedEvolutionSeedCurrent(structuredClone(f.evolutionSeed), f.context)); assertPlannedEvolutionSeedCurrent(f.evolutionSeed, f.context);
  });
  let record;
  await t.test('real independent checks each migrate a separate old-data copy and preserve every retained code path', async () => {
    execution = startPlannedWebExecution(options); record = await execution.done; assert.equal(record.status, 'accepted', JSON.stringify(record)); assert.equal(isPlannedWebTaskAccepted(record, manifest), true);
    assert.equal(record.baseCommit, f.originBinding.candidateCommit); assert.equal(record.totalModelCalls, 4); assert.equal(record.evolutionHistory.totalModelCalls, 2); assert.equal(record.evolutionSource.source.specRevision, f.originBinding.specRevision); assert.equal(record.specRevision, f.targetBinding.specRevision);
    assert.equal(record.versions.length, 2); assert.ok(record.versions[0].acceptance.browser.checks.some(check => String(check.actual).includes('PRIVATE_ROW_')));
    const version = record.versions.at(-1), receipts = [version.selfCheck.dataset, version.acceptance.test.dataset, ...version.acceptance.browser.dataset]; assert.equal(receipts.length, 4); assert.equal(new Set(receipts.map(receipt => receipt.migrationId)).size, 4);
    assert.deepEqual(receipts.map(receipt => receipt.phase), ['self_check', 'http', 'browser-DESKTOP', 'browser-MOBILE']); assert.ok(receipts.every(receipt => receipt.binding.candidateCommit === record.candidateCommit && receipt.inputSnapshotHash === f.snapshot.snapshotHash && receipt.operationsHash === record.evolutionSource.migration.operationsHash));
    for (const filename of f.retainedPaths) assert.ok((await readFile(path.join(record.workspace, filename))).length > 0);
    assert.equal(await readFile(path.join(record.workspace, 'public/app.js'), 'utf8'), f.files.find(file => file.path === 'public/app.js').content);
    assert.notEqual(f.workspace, f.runtimeWorkspace); assert.equal(calls, 4); assert.equal(metadata.length, 4); assert.equal(proofs.length, 4);
    for (const text of prompts) { assert.equal(text.includes('PRIVATE_ROW_'), false); assert.equal(text.includes(f.workspace), false); assert.equal(text.includes(f.snapshot.filename), false); assert.equal(text.includes('requestIdentity'), false); }
    for (const proof of proofs) { const call = record.modelCalls.find(call => call.id === proof.callId); assert.equal(proof.receiptHash, call.receiptHash); assert.equal(hash(await readFile(call.receiptPath)), proof.receiptHash); }
  });
  await t.test('evolved source reinspection uses both real bindings and raw historical receipts without requiring old target current', async () => {
    f.state.current = false;
    try { const handle = await inspectPlannedSource({ rootDir: f.sourceRootDir, reportPath: record.reportPath, binding, writablePaths: f.retainedPaths }), value = assertPlannedSource(handle, binding, f.retainedPaths); assert.equal(value.provenance.sourceModelReceiptHashes.length, 6); assert.deepEqual(value.previousIssues.map(issue => issue.id), [f.issue.id]); assert.equal(value.provenance.evolution.originBinding.specRevision, f.originBinding.specRevision); }
    finally { f.state.current = true; }
  });
  await t.test('forged origin or historical costs and removed original receipt cannot produce reusable source', async () => {
    const original = await readFile(record.reportPath);
    try {
      const fake = structuredClone(record); fake.evolutionSource.originBinding.specRevision = 'f'.repeat(64); fake.evolutionSeedHash = hash(canonicalJSON(fake.evolutionSource)); await writeFile(record.reportPath, JSON.stringify(fake)); await assert.rejects(inspectPlannedSource({ rootDir: f.sourceRootDir, reportPath: record.reportPath, binding, writablePaths: f.retainedPaths }));
      const costs = structuredClone(record); costs.evolutionHistory.totalModelCalls = 0; await writeFile(record.reportPath, JSON.stringify(costs)); await assert.rejects(inspectPlannedSource({ rootDir: f.sourceRootDir, reportPath: record.reportPath, binding, writablePaths: f.retainedPaths }));
    } finally { await writeFile(record.reportPath, original); }
    const filename = f.record.modelCalls[0].receiptPath, moved = filename + '.held'; await rename(filename, moved); try { await assert.rejects(inspectPlannedSource({ rootDir: f.sourceRootDir, reportPath: record.reportPath, binding, writablePaths: f.retainedPaths })); } finally { await rename(moved, filename); }
  });
  await t.test('copied/tampered acceptance and withdrawn data cannot inherit the original private pass', async () => {
    assert.equal(isPlannedWebTaskAccepted(structuredClone(record), manifest), false); const tampered = structuredClone(record); tampered.versions[0].acceptance.browser.dataset.pop(); assert.equal(isPlannedWebTaskAccepted(tampered, manifest), false);
    assert.equal(isPlannedWebDeliveryAccepted({ record: structuredClone(record), manifest, checkpoint: {} }), false);
    f.state.dataCurrent = false; assert.equal(isPlannedWebTaskAccepted(record, manifest), false); f.state.dataCurrent = true; assert.equal(isPlannedWebTaskAccepted(record, manifest), true);
    await f.service.close(); assert.equal(isPlannedWebTaskAccepted(record, manifest), false); assert.throws(() => assertPlannedEvolutionSeedCurrent(f.evolutionSeed, f.context));
  });
});
