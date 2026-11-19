import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupPlannedEvolutionFixture, nativeEvolutionAvailable, hash } from './helpers/planned-evolution-fixture.mjs';
import { createMigrationControl, compileMigrationPlan } from '../lib/planned-migration-contract.mjs';
import { createPlannedEvolutionSeed, assertPlannedEvolutionSeed } from '../lib/planned-evolution-source.mjs';
import { createVerificationControl, compileManifest, canonicalJSON } from '../lib/verification-contract.mjs';
import { contentRevision } from '../lib/planning-review.mjs';
import { startPlannedWebExecution, isPlannedWebTaskAccepted, isPlannedWebDeliveryAccepted, assertPlannedEvolutionAcceptance, plannedExecutionPolicyHash } from '../lib/planned-web-executor.mjs';
import { createPlannedCheckpoints } from '../lib/planned-checkpoint.mjs';
import { createPlannedDelivery } from '../lib/planned-delivery.mjs';
import { inspectPlannedSource } from '../lib/planned-source.mjs';
import { readProjectFiles } from '../lib/project-files.mjs';
import { readWebArchiveEntries } from '../lib/web-archive.mjs';

test('only original, fully validated evolution creates durable historical evidence and a bounded private-free model context', { skip: !nativeEvolutionAvailable, timeout: 240000 }, async t => {
  const f = await setupPlannedEvolutionFixture(t, { prefix: 'history-' }), spec = { title: '新版本旧数据兼容', requirements: [{ id: 'R1', text: '保留既有数据并由平台完成确认迁移' }] }, task = { title: '完整新版本', tasks: f.tasks };
  const targetBinding = { ...f.targetBinding, specRevision: contentRevision(spec), planRevision: contentRevision(task) }, binding = { ...Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, targetBinding[key]])), taskId: 'whole', sourceRevision: targetBinding.sourceRevision };
  const plan = { version: 1, kind: 'bounded_operations', operations: [{ op: 'addColumn', table: 'items', column: 'internal_marker', type: 'TEXT', nullable: false, default: 'PRIVATE_DEFAULT_LITERAL' }, { op: 'mapValues', table: 'items', column: 'value', mapping: [{ from: 'PRIVATE_ROW_ALICE', to: 'PRIVATE_ROW_ALICE' }, { from: 'PRIVATE_ROW_BOB', to: 'PRIVATE_ROW_BOB' }], unmapped: 'reject' }] };
  let phase = 'running'; const live = () => phase === 'running' && f.state.current && f.state.dataCurrent;
  const migration = createMigrationControl({ assertCurrent: live }), migrationApproval = migration.approve({ plan, binding: targetBinding, feedback: '精确批准私有字面值配方，模型只可见概要' }), compiledMigrationPlan = compileMigrationPlan({ plan, binding: targetBinding, approval: migrationApproval }); t.after(() => migration.close());
  const context = { targetBinding, requirements: f.requirements, tasks: f.tasks, approvedTaskSetHash: f.approvedTaskSetHash, retainedPaths: f.retainedPaths }, input = { ...f.seedInput, ...context, compiledMigrationPlan, assertCurrent: live }, seed = await createPlannedEvolutionSeed(input);
  const proposal = { version: 1, id: 'history-check', name: '旧行与平台迁移结果', sessions: [], steps: [{ id: 'data', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'rows', method: 'GET', path: '/items', assertions: [{ id: 'status', op: 'status', value: 200 }, { id: 'size', op: 'jsonLength', path: '$', value: 2 }, { id: 'migrated', op: 'jsonExists', path: '$[0].internal_marker' }] } }], browser: { version: 1, sessions: ['user'], steps: [{ id: 'home', session: 'user', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'count', session: 'user', requirementIds: ['R1'], op: 'count', testId: 'item', value: 2 }] } };
  function approved() { const control = createVerificationControl(), data = { proposal, requirements: f.requirements, binding: Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]])) }, approval = control.approve({ ...data, feedback: '冻结联合定义' }), manifest = compileManifest({ ...data, approval }); control.beginCoding(approval); return { control, approval, manifest }; }
  const original = approved(), prompts = []; t.after(() => original.control.revoke(original.approval));
  const inspectPrompt = request => {
    prompts.push(JSON.stringify({ task: request.task, files: request.files, feedback: request.feedback, previousIssues: request.previousIssues }));
    const safe = JSON.parse(request.task).evolution; assert.equal(safe.platformPreMigration, true); assert.deepEqual(safe.operations, [{ op: 'addColumn', table: 'items', column: 'internal_marker', type: 'TEXT', nullable: false }, { op: 'mapValues', table: 'items', column: 'value' }]); assert.equal(safe.inputSchemaHash, f.snapshot.schemaHash);
    assert.deepEqual(safe.inputSchema[0].columns.map(column => Object.keys(column).sort()), [['name', 'primary', 'type'], ['name', 'primary', 'type'], ['name', 'primary', 'type']]);
  };
  const provider = async request => { inspectPrompt(request); const file = request.files.find(file => file.path === 'src/app.mjs'), content = file.content.replace('SELECT id,owner,value FROM', 'SELECT id,owner,value,internal_marker FROM').replace("rows.map(row=>row.owner+':'+row.value).join('|')", "rows.map(row=>'<div data-testid=\"item\">'+row.owner+':'+row.value+'</div>').join('')") + '// historical validation candidate\n'; const result = { files: [{ path: file.path, content }], model: 'fixture-coding', usage: { inputTokens: 3, outputTokens: 4 } }; await request.onReceipt({ ...result, finishReason: 'stop', content: JSON.stringify({ files: result.files }) }); return result; };
  const reviewer = async request => { inspectPrompt(request); const result = { summary: '当前新代码与确认配方联合检查', issues: [], resolutions: request.previousIssues.map(issue => ({ id: issue.id, status: 'resolved', reason: '按当前源码与批准规则重验' })), model: 'fixture-review', usage: { inputTokens: 5, outputTokens: 6 } }; await request.onReceipt({ model: result.model, usage: result.usage, finishReason: 'stop', content: JSON.stringify(result) }); return result; };
  const record = await startPlannedWebExecution({ outputDir: f.sourceRootDir, binding, task, manifest: original.manifest, provider, reviewer, evolutionSeed: seed, maxCalls: 1, maxReviewCalls: 1, timeoutMs: 180000, assertCurrent: () => f.state.current }).done;
  assert.equal(record.status, 'accepted', JSON.stringify({ status: record.status, error: record.error, code: record.errorCode })); assert.equal(isPlannedWebTaskAccepted(record, original.manifest), true);
  assert.equal(isPlannedWebDeliveryAccepted({ record, manifest: original.manifest }), false, 'even the original live evolution needs a purpose-scoped historical delivery permit');
  const past = assertPlannedEvolutionAcceptance(record, original.manifest), version = record.versions.at(-1);
  assert.equal(past.purpose, 'taskflow/evolution-validation-history/v1'); assert.ok(Object.isFrozen(past)); assert.equal(past.datasetReceiptsHash, hash(canonicalJSON([version.selfCheck.dataset, version.acceptance.test.dataset, ...version.acceptance.browser.dataset]))); assert.deepEqual(record.evolutionMigration, plan);
  for (const prompt of prompts) for (const secret of ['PRIVATE_DEFAULT_LITERAL', 'PRIVATE_ROW_ALICE', 'PRIVATE_ROW_BOB', f.workspace, f.snapshot.filename, f.runtimeWorkspace]) assert.equal(prompt.includes(secret), false, secret);
  const row = { id: 'public-history-record', project_id: record.projectId, run_id: record.runId, proposal_id: 'proposal-history', definition_revision: 'a'.repeat(64), status: 'accepted', active: 0, created_at: record.startedAt, binding: JSON.stringify(targetBinding), budget: JSON.stringify({ ...record.budget, maxAttempts: 3, totalModelCalls: 6 }) };
  const rootDir = path.join(f.directory, 'history-checkpoint'); await mkdir(rootDir); let store = await createPlannedCheckpoints({ rootDir }); t.after(() => store.close()); let seal, restored, permit, current;
  await t.test('linked execution becoming accepted invalidates live data authority but not original historical validation', async () => {
    phase = 'accepted'; assert.equal(isPlannedWebTaskAccepted(record, original.manifest), false); assert.strictEqual(assertPlannedEvolutionAcceptance(record, original.manifest), past);
    await assert.rejects(assertPlannedEvolutionSeed(seed, context)); await assert.rejects(createPlannedEvolutionSeed(input));
    assert.equal(isPlannedWebDeliveryAccepted({ record, manifest: original.manifest }), false);
    seal = await store.signEvolution({ row, record, manifest: original.manifest }); assert.equal(seal.version, 3); assert.equal(seal.purpose, 'taskflow/planned-evolution-accepted/v1');
    permit = await store.verifyEvolution({ row, record, seal, policyHash: plannedExecutionPolicyHash, manifest: original.manifest }); assert.equal(isPlannedWebDeliveryAccepted({ record, manifest: original.manifest, checkpoint: permit, executionId: row.id }), true);
  });
  await t.test('closed data retains historical proof while clones, changed records, recipes and current code cannot acquire it', async () => {
    await f.service.close(); assert.equal(isPlannedWebTaskAccepted(record, original.manifest), false); assert.strictEqual(assertPlannedEvolutionAcceptance(record, original.manifest), past);
    for (const fake of [structuredClone(record), { ...record, candidateCommit: 'f'.repeat(40) }]) assert.throws(() => assertPlannedEvolutionAcceptance(fake, original.manifest)); assert.throws(() => assertPlannedEvolutionAcceptance(record, structuredClone(original.manifest)));
    const finishedAt = record.finishedAt; try { record.finishedAt = 'changed-original-record'; assert.throws(() => assertPlannedEvolutionAcceptance(record, original.manifest)); } finally { record.finishedAt = finishedAt; } assert.strictEqual(assertPlannedEvolutionAcceptance(record, original.manifest), past);
    const filename = path.join(record.workspace, 'src/app.mjs'), bytes = await readFile(filename); try { await writeFile(filename, Buffer.concat([bytes, Buffer.from('// changed historical code\n')])); assert.throws(() => assertPlannedEvolutionAcceptance(record, original.manifest)); await assert.rejects(inspectPlannedSource({ rootDir: f.sourceRootDir, reportPath: record.reportPath, binding, writablePaths: f.retainedPaths })); } finally { await writeFile(filename, bytes); }
    const saved = await readFile(record.reportPath); try { const fake = structuredClone(record); fake.evolutionMigration.operations[0].default = 'changed'; await writeFile(record.reportPath, JSON.stringify(fake)); await assert.rejects(inspectPlannedSource({ rootDir: f.sourceRootDir, reportPath: record.reportPath, binding, writablePaths: f.retainedPaths })); } finally { await writeFile(record.reportPath, saved); }
  });
  await t.test('v3 HMAC recovery is delivery-only and refuses tampering or signing parsed history', async () => {
    assert.throws(() => store.sign({ row, record, manifest: original.manifest }));
    await assert.rejects(Promise.resolve().then(() => store.signEvolution({ row, record: structuredClone(record), manifest: original.manifest }))); store.close(); store = await createPlannedCheckpoints({ rootDir, hasCheckpoints: true }); current = approved(); t.after(() => current.control.revoke(current.approval)); restored = structuredClone(record);
    permit = await store.verifyEvolution({ row, record: restored, seal, policyHash: plannedExecutionPolicyHash, manifest: current.manifest }); assert.equal(isPlannedWebTaskAccepted(restored, current.manifest), false); assert.throws(() => assertPlannedEvolutionAcceptance(restored, current.manifest)); assert.equal(isPlannedWebDeliveryAccepted({ record: restored, manifest: current.manifest, checkpoint: permit, executionId: row.id }), true);
    for (const mutate of [value => { value.versions.at(-1).acceptance.browser.dataset.pop(); }, value => { value.evolutionMigration.operations[0].default = 'changed'; }, value => { value.evolutionHistory.totalModelCalls = 0; }, value => { value.modelCalls[0].receiptHash = '0'.repeat(64); }]) { const fake = structuredClone(record); mutate(fake); await assert.rejects(Promise.resolve().then(() => store.verifyEvolution({ row, record: fake, seal, policyHash: plannedExecutionPolicyHash, manifest: current.manifest }))); }
    const invalidPurpose = { ...seal, purpose: 'taskflow/planned-accepted/v1' }; await assert.rejects(Promise.resolve().then(() => store.verifyEvolution({ row, record: restored, seal: invalidPurpose, policyHash: plannedExecutionPolicyHash, manifest: current.manifest })));
    assert.equal(isPlannedWebDeliveryAccepted({ record: restored, manifest: current.manifest, checkpoint: structuredClone(permit), executionId: row.id }), false);
  });
  await t.test('source ZIP exports exactly approved migration recipe and hash/schema summary without database, raw actual or private ancestry paths', async () => {
    const files = await readProjectFiles(record.workspace), bytes = await createPlannedDelivery({ record: restored, manifest: current.manifest, checkpoint: permit, executionId: row.id, files, requirements: '确认旧数据演进', spec, tasks: f.tasks }), archive = readWebArchiveEntries(bytes), entries = archive.entries;
    const entryText = name => { const value = entries.get(name); return Buffer.isBuffer(value) ? value.toString('utf8') : value.data ? Buffer.from(value.data).toString('utf8') : value.content?.toString() ?? String(value); };
    const recipe = JSON.parse(entryText('delivery/evolution.json')); assert.deepEqual(recipe.recipe, plan); assert.equal(recipe.databaseIncluded, false); assert.equal(recipe.validationHistory.datasetReceiptsHash, past.datasetReceiptsHash);
    assert.equal([...entries.keys()].some(name => /sqlite|\.db$|backup|receipt.*\.json/u.test(name)), false);
    for (const name of entries.keys()) { const text = entryText(name); assert.equal(text.includes(f.workspace), false); assert.equal(text.includes(f.runtimeWorkspace), false); assert.equal(text.includes(f.snapshot.filename), false); if (name !== 'delivery/evolution.json') assert.equal(text.includes('PRIVATE_ROW_'), false, name); }
    const verification = JSON.parse(entryText('delivery/verification.json')); for (const check of [...verification.self, ...verification.http, ...verification.browser]) assert.equal(Object.hasOwn(check, 'actual'), false);
  });
});
