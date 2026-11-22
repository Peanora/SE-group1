import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createZip } from '../lib/zip.mjs';
import { inspectPlannedArchive, revalidatePlannedArchive } from '../lib/planned-archive.mjs';
import { readWebArchiveEntries } from '../lib/web-archive.mjs';
import { getWebShellFiles } from '../lib/web-delivery.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { contentRevision } from '../lib/planning-review.mjs';
import { compileManifest, createVerificationControl, assertCompiledManifest } from '../lib/verification-contract.mjs';
import { browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { projectReviewPolicy } from '../lib/project-review-model.mjs';
import { plannedExecutionPolicyHash } from '../lib/planned-web-executor.mjs';
import { migrationContractPolicy, normalizeMigrationPlan } from '../lib/planned-migration-contract.mjs';
import { plannedNotes } from '../examples/planned-notes.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const evidenceRoot = path.resolve(import.meta.dirname, '../output/full-goal-20261117/archive-independent');
async function fixture() {
  const files = validateProjectFiles(plannedNotes.files), shell = await getWebShellFiles(), spec = structuredClone(plannedNotes.spec);
  const base = { projectId: 'archive-project', runId: 'archive-run', specRevision: contentRevision(spec), planRevision: contentRevision(plannedNotes.task) };
  const definition = { proposal: structuredClone(plannedNotes.definition), requirements: spec.requirements.map(item => item.id), binding: base };
  const control = createVerificationControl(), approval = control.approve({ ...definition, feedback: 'ZIP integrity fixture only, no historical business acceptance' });
  const compiled = compileManifest({ ...definition, approval });
  const binding = { ...base, taskId: 'archive-task', attemptId: 'archive-attempt', candidateCommit: 'c'.repeat(40), manifestHash: compiled.manifestHash,
    browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: projectReviewPolicy.hash, executorPolicyHash: plannedExecutionPolicyHash, sourceHash: hash(files) };
  const payload = [...shell, ...files,
    { path: 'delivery/requirements.md', content: plannedNotes.requirements }, { path: 'delivery/spec.json', content: JSON.stringify(spec) },
    { path: 'delivery/tasks.json', content: JSON.stringify({ specRevision: base.specRevision, planRevision: base.planRevision, tasks: plannedNotes.task.tasks }) },
    { path: 'delivery/verification-definition.json', content: JSON.stringify(definition.proposal) },
    { path: 'delivery/verification.json', content: JSON.stringify({ status: 'accepted', taskAccepted: true, review: { status: 'completed', openBlockingIssues: 0 }, thisIsAnUntrustedHistoricalClaim: true }) },
  ];
  const index = items => items.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) }));
  const manifest = { version: 1, profileId: 'planned-web-v1', sourceHash: binding.sourceHash, binding, files: index(payload) };
  const pack = (items = payload, data = manifest) => createZip([...items.map(file => ({ name: file.path, content: file.content })), { name: 'delivery/manifest.json', content: JSON.stringify(data) }]);
  return { files, shell, payload, manifest, base, compiled, index, pack };
}
async function temporary() { await mkdir(evidenceRoot, { recursive: true }); return mkdtemp(path.join(evidenceRoot, 'case-')); }

async function evolutionFixture() {
  const input = await fixture(), manifest = structuredClone(input.manifest);
  manifest.binding.executorPolicyHash = 'a'.repeat(64);
  const originBinding = { ...input.base, runId: 'archive-previous-run', executionId: 'archive-previous-execution', candidateCommit: 'b'.repeat(40),
    sourceHash: '1'.repeat(64), sourceRevision: '2'.repeat(64), sourceGeneration: 0 };
  const worker = await readFile(new URL('../lib/planned-migration-worker.cjs', import.meta.url));
  const snapshot = { version: 1, datasetId: 'dataset', snapshotId: 'snapshot', dataGeneration: 2,
    originCommit: originBinding.candidateCommit, databaseHash: '3'.repeat(64), schemaHash: '4'.repeat(64), rowsHash: '5'.repeat(64), bytes: 4096,
    policyHash: hash({ version: 1, workerHash: hash(worker), contract: migrationContractPolicy }) };
  snapshot.snapshotHash = hash(snapshot);
  const { projectId, runId, specRevision, planRevision } = input.base;
  const targetBinding = { projectId, runId, sourceRevision: '6'.repeat(64), sourceGeneration: 1, specRevision, planRevision,
    inputSnapshotHash: snapshot.snapshotHash, inputSchemaHash: snapshot.schemaHash };
  const recipe = normalizeMigrationPlan({ version: 1, kind: 'bounded_operations', operations: [{ op: 'addColumn', table: 'notes', column: 'rank', type: 'INTEGER', nullable: false, default: 0 }] });
  const sidecar = { version: 1, historicalRecordOnly: true, reusedAcceptance: false, originBinding, targetBinding, seedHash: '7'.repeat(64),
    inputSnapshot: snapshot, inputSchema: [{ name: 'notes', columns: [{ name: 'id', type: 'INTEGER', primary: 1 }] }],
    migration: { revision: hash({ plan: recipe, binding: targetBinding, policy: migrationContractPolicy }), operationsHash: hash(recipe), policy: migrationContractPolicy }, recipe,
    platformPreMigration: true, historyHash: '8'.repeat(64), validationHistory: { purpose: 'taskflow/evolution-validation-history/v1', datasetReceiptsHash: '9'.repeat(64) },
    historicalCosts: { totalModelCalls: 2, usage: { inputTokens: null, outputTokens: 5 }, receiptHashes: ['e'.repeat(64)] }, databaseIncluded: false,
    notice: '源码包不含业务数据库、备份或私有路径。已有数据迁移和干净空库启动须分别验证；此摘要不是新的执行许可或数据恢复操作。' };
  const redacted = [{ id: 'history', name: '报表', passed: true, detail: '已有数据的断言值仅保留本机私有验证记录。' }];
  const report = { version: 1, profileId: 'planned-web-v1', status: 'accepted', binding: manifest.binding, sourceHash: manifest.sourceHash,
    self: redacted, http: redacted, browser: redacted, taskAccepted: true };
  const payload = input.payload.filter(entry => entry.path !== 'delivery/verification.json');
  payload.push({ path: 'delivery/verification.json', content: JSON.stringify(report) });
  const pack = (extras = [{ path: 'delivery/evolution.json', content: JSON.stringify(sidecar) }], base = payload) =>
    input.pack([...base, ...extras], { ...manifest, files: input.index([...base, ...extras]) });
  return { sidecar, pack, payload, report };
}

test('evolution ZIP verifies source and metadata without accepting old policy, database access or historical checks', async () => {
  const input = await evolutionFixture(), archive = await inspectPlannedArchive(input.pack());
  assert.equal(archive.integrityVerified, true);
  assert.equal(archive.executorPolicyCurrent, false);
  assert.equal(archive.taskAccepted, false);
  assert.equal(archive.historicalAcceptanceVerified, false);
  assert.deepEqual(archive.evolution, { version: 1, historicalRecordOnly: true, databaseIncluded: false, existingDataVerified: false,
    migrationKind: 'bounded_operations', originGeneration: 0, targetGeneration: 1 });
  assert.equal(archive.files.some(entry => entry.path.startsWith('delivery/')), false);
  const root = await temporary(), archiveFile = path.join(root, 'evolution.zip');
  await writeFile(archiveFile, input.pack());
  const result = await revalidatePlannedArchive({ archiveFile, outputDir: path.join(root, 'no-runtime') });
  assert.equal(result.status, 'evolution_dataset_required');
  assert.deepEqual([result.taskAccepted, result.totalModelCalls, result.terminationConfirmed, result.test, result.browser, result.reportPath], [false, 0, null, null, null, null]);
  assert.deepEqual(await readdir(root), ['evolution.zip']);
  const cli = new URL('../scripts/verify-planned-delivery.mjs', import.meta.url);
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(cli), '--archive', archiveFile, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const dry = run('--inspect'), normal = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(normal.status, 1, normal.stderr);
  assert.deepEqual([JSON.parse(dry.stdout).status, JSON.parse(normal.stdout).status], ['integrity_verified', 'evolution_dataset_required']);
  for (const stdout of [dry.stdout, normal.stdout]) {
    const output = JSON.parse(stdout);
    assert.deepEqual([output.taskAccepted, output.historicalAcceptanceVerified, output.evolution.existingDataVerified, output.totalModelCalls], [false, false, false, 0]);
  }
});

test('evolution ZIP rejects foreign, stripped, malformed or private history even with rebuilt file hashes', async () => {
  const input = await evolutionFixture();
  const entry = (content, name = 'delivery/evolution.json') => ({ path: name, content });
  for (const change of [
    value => { value.targetBinding.runId = 'another-run'; value.migration.revision = hash({ plan: value.recipe, binding: value.targetBinding, policy: migrationContractPolicy }); },
    value => { value.originBinding.runId = value.targetBinding.runId; },
    value => { value.originBinding.sourceGeneration = value.targetBinding.sourceGeneration; },
    value => { value.inputSnapshot.rowsHash = 'f'.repeat(64); },
    value => { value.inputSnapshot.filename = 'C:/private/business.sqlite'; },
    value => { value.inputSchema[0].rows = ['private row']; },
    value => { value.migration.operationsHash = 'f'.repeat(64); },
    value => { value.migration.policy.implementationHash = 'f'.repeat(64); },
    value => { value.recipe.operations[0].sql = 'SELECT private'; },
    value => { value.validationHistory.accepted = true; },
    value => { value.historicalCosts.receiptHashes.push('C:/private/receipt.json'); },
    value => { value.databaseIncluded = true; },
    value => { value.reusedAcceptance = true; },
  ]) {
    const sidecar = structuredClone(input.sidecar); change(sidecar);
    await assert.rejects(inspectPlannedArchive(input.pack([entry(JSON.stringify(sidecar))])));
  }
  for (const extras of [[], [entry('{')], [entry(JSON.stringify(input.sidecar), 'delivery/Evolution.json')],
    [entry(JSON.stringify(input.sidecar)), entry('{}', 'delivery/task-execution.json')],
    [entry(JSON.stringify(input.sidecar)), entry('snapshot', 'delivery/input.sqlite')]]) {
    await assert.rejects(inspectPlannedArchive(input.pack(extras)));
  }
  for (const change of [value => { value.binding.runId = 'foreign'; }, value => { value.http = [{ ...value.http[0], detail: 'private data' }]; }]) {
    const report = structuredClone(input.report); change(report);
    const payload = input.payload.map(item => item.path === 'delivery/verification.json' ? { ...item, content: JSON.stringify(report) } : item);
    await assert.rejects(inspectPlannedArchive(input.pack(undefined, payload)));
  }
});

test('planned ZIP verifies exact source/shell/current definitions while forged acceptance remains non-authoritative', async () => {
  const input = await fixture(), bytes = input.pack(), result = await inspectPlannedArchive(bytes);
  assert.equal(result.integrityVerified, true); assert.equal(result.taskAccepted, false); assert.equal(result.historicalAcceptanceVerified, false);
  assert.deepEqual(result.files, input.files); assert.equal(result.archiveHash, hash(bytes)); assert.equal(result.status, undefined);
  assert.equal(result.binding.manifestHash, input.compiled.manifestHash);
  assert.equal(assertCompiledManifest(result.manifest, input.base), result.manifest, 'independent diagnostic must have a usable current frozen manifest');
  assert.equal(readWebArchiveEntries(bytes).entries.size, input.payload.length + 1);
  const folder = await temporary(); await writeFile(path.join(folder, 'current-fixture.zip'), bytes);
});

test('planned ZIP refuses CRC corruption, missing/index-duplicate entries and unlisted payloads', async () => {
  const input = await fixture(), bytes = input.pack();
  const target = bytes.indexOf(Buffer.from(input.payload.find(file => file.path === 'delivery/requirements.md').content)); assert.ok(target > 0); bytes[target] ^= 1;
  await assert.rejects(inspectPlannedArchive(bytes));
  for (const mutate of [data => data.files.pop(), data => data.files.push(data.files[0]), data => { data.files[0].sha256 = '0'.repeat(64); }, data => { data.files[0].bytes++; }]) {
    const manifest = structuredClone(input.manifest); mutate(manifest); await assert.rejects(inspectPlannedArchive(input.pack(input.payload, manifest)));
  }
  await assert.rejects(inspectPlannedArchive(input.pack([...input.payload, { path: 'public/unlisted.js', content: 'export const unlisted=true;' }])));
});

test('fresh per-file hashes cannot authorize changed source identity or a hostile protected shell', async () => {
  const input = await fixture();
  for (const name of ['src/app.mjs', 'server.mjs']) {
    const payload = structuredClone(input.payload); payload.find(file => file.path === name).content += '\n// modified';
    const manifest = structuredClone(input.manifest); manifest.files = input.index(payload);
    await assert.rejects(inspectPlannedArchive(input.pack(payload, manifest)));
  }
  for (const missing of ['delivery/spec.json', 'delivery/tasks.json', 'delivery/verification-definition.json', 'delivery/verification.json', 'src/app.mjs']) {
    const payload = input.payload.filter(file => file.path !== missing), manifest = structuredClone(input.manifest); manifest.files = input.index(payload);
    await assert.rejects(inspectPlannedArchive(input.pack(payload, manifest)));
  }
});

test('planned ZIP path checks reject ambiguous names, archive attributes and extraneous root permissions', async () => {
  const input = await fixture();
  for (const name of ['public/%2e%2e/escape.js', 'public\\escape.js', 'src/APP.mjs', 'src/CON.mjs', '.env', 'package-lock.json', 'delivery/extra.json']) {
    const payload = [...input.payload, { path: name, content: 'untrusted' }], manifest = structuredClone(input.manifest); manifest.files = input.index(payload);
    await assert.rejects(inspectPlannedArchive(input.pack(payload, manifest)), name);
  }
  for (const offset of [10, 38]) {
    const bytes = input.pack(), central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (offset === 10) bytes.writeUInt16LE(8, central + offset); else bytes.writeUInt32LE(0xa1ff0000, central + offset);
    await assert.rejects(inspectPlannedArchive(bytes));
  }
  await assert.rejects(inspectPlannedArchive(Buffer.concat([input.pack(), Buffer.from('tail')])));
});

test('planned ZIP rejects stale rules, wrong definition binding and inconsistent spec/plan versions', async () => {
  const input = await fixture();
  for (const key of ['manifestHash', 'browserPolicyHash', 'reviewPolicyHash', 'specRevision', 'planRevision', 'sourceHash']) {
    const manifest = structuredClone(input.manifest); manifest.binding[key] = '0'.repeat(64); await assert.rejects(inspectPlannedArchive(input.pack(input.payload, manifest)), key);
  }
  for (const change of [data => { delete data.binding.taskId; }, data => { data.binding.untrusted = 'x'; }, data => { data.profileId = 'other'; }, data => { data.version = 2; }]) {
    const manifest = structuredClone(input.manifest); change(manifest); await assert.rejects(inspectPlannedArchive(input.pack(input.payload, manifest)));
  }
  for (const name of ['delivery/spec.json', 'delivery/tasks.json', 'delivery/verification-definition.json']) {
    const payload = structuredClone(input.payload), item = payload.find(file => file.path === name), raw = JSON.parse(item.content);
    if (name.endsWith('spec.json')) raw.title += ' changed'; else if (name.endsWith('tasks.json')) raw.planRevision = '0'.repeat(64); else raw.steps[0].request.path = '/changed';
    item.content = JSON.stringify(raw); const manifest = structuredClone(input.manifest); manifest.files = input.index(payload);
    await assert.rejects(inspectPlannedArchive(input.pack(payload, manifest)));
  }
});

test('plain reconstructed manifest or archived passed flags cannot create historical completion authority', async () => {
  const input = await fixture(), result = await inspectPlannedArchive(input.pack());
  assert.throws(() => assertCompiledManifest(JSON.parse(JSON.stringify(result.manifest)), input.base));
  const payload = structuredClone(input.payload); payload.find(file => file.path === 'delivery/verification.json').content = '{"status":"accepted","passed":true,"taskAccepted":true,"modelCalls":0}';
  const manifest = structuredClone(input.manifest); manifest.files = input.index(payload);
  const other = await inspectPlannedArchive(input.pack(payload, manifest)); assert.equal(other.taskAccepted, false); assert.equal(other.historicalAcceptanceVerified, false);
});

test('pre-cancelled planned archive diagnostics do not create workspaces or claim an unknown remote process', async () => {
  const input = await fixture(), root = await temporary(), archiveFile = path.join(root, 'fixture.zip'), outputDir = path.join(root, 'cancelled');
  await writeFile(archiveFile, input.pack());
  await assert.rejects(revalidatePlannedArchive({ archiveFile, outputDir, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(await readdir(root), ['fixture.zip']);
});

test('linked archive files and linked output parents cannot be used as diagnostic write authority', async () => {
  const input = await fixture(), root = await temporary(), archiveFile = path.join(root, 'fixture.zip'); await writeFile(archiveFile, input.pack());
  const target = path.join(root, 'target'); await mkdir(target); await symlink(target, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(revalidatePlannedArchive({ archiveFile, outputDir: path.join(root, 'alias', 'must-not-exist') })); assert.deepEqual(await readdir(target), []);
  const hardlink = path.join(root, 'linked.zip'); await link(archiveFile, hardlink); await assert.rejects(revalidatePlannedArchive({ archiveFile: hardlink, outputDir: path.join(root, 'hardlinked') }));
});

test('deadline and cancellation cover a slow trusted shell lookup and late preparation cannot create output', async () => {
  const input = await fixture(), root = await temporary(), archiveFile = path.join(root, 'fixture.zip'); await writeFile(archiveFile, input.pack());
  for (const mode of ['timeout', 'cancel']) {
    const outputDir = path.join(root, mode);
    const script = `import {mock} from 'node:test';import {access} from 'node:fs/promises';const delivery=${JSON.stringify(new URL('../lib/web-delivery.mjs', import.meta.url).href)};const shell=await(await import(delivery)).getWebShellFiles();let calls=0;mock.module(delivery,{namedExports:{getWebShellFiles:async()=>{await new Promise(resolve=>setTimeout(resolve,200));return shell;}}});mock.module(${JSON.stringify(new URL('../lib/http-scenarios.mjs', import.meta.url).href)},{namedExports:{runHttpScenarios:async()=>{calls++;return {status:'passed',terminationConfirmed:true};}}});mock.module(${JSON.stringify(new URL('../lib/browser-scenarios.mjs', import.meta.url).href)},{namedExports:{runBrowserScenarios:async()=>{calls++;return {status:'passed',terminationConfirmed:true};}}});const {revalidatePlannedArchive}=await import(${JSON.stringify(new URL('../lib/planned-archive.mjs', import.meta.url).href)});const controller=new AbortController();if(${JSON.stringify(mode)}==='cancel')setTimeout(()=>controller.abort(),20);let error;const started=Date.now();try{await revalidatePlannedArchive({archiveFile:${JSON.stringify(archiveFile)},outputDir:${JSON.stringify(outputDir)},timeoutMs:${mode === 'timeout' ? 20 : 500},signal:controller.signal});}catch(caught){error={name:caught.name,code:caught.code??null};}const duration=Date.now()-started;await new Promise(resolve=>setTimeout(resolve,250));let exists=true;try{await access(${JSON.stringify(outputDir)});}catch{exists=false;}process.stdout.write(JSON.stringify({calls,error,duration,exists}));`;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 0, child.stdout + child.stderr); const result = JSON.parse(child.stdout);
    assert.equal(result.calls, 0); assert.equal(result.exists, false); assert.ok(result.error, mode); assert.ok(result.duration < 190, `${mode}: ${result.duration}ms`);
    assert.equal(result.error.name, 'AbortError');
  }
});

test('delivery CLI rejects missing arguments without loading environment or offering acceptance', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/verify-planned-delivery.mjs', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /--archive/u); assert.equal(result.stdout.trim(), '');
});

test('delivery CLI renders diagnostic-only permission and proper exit codes (trusted runner mock, not native evidence)', () => {
  const scriptUrl = new URL('../scripts/verify-planned-delivery.mjs', import.meta.url).href;
  for (const status of ['checks_passed', 'failed', 'reconciliation_required']) {
    const script = `import {mock} from 'node:test';mock.module(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)},{namedExports:{loadEnv:async()=>{}}});mock.module(${JSON.stringify(new URL('../lib/planned-archive.mjs', import.meta.url).href)},{namedExports:{revalidatePlannedArchive:async()=>({status:${JSON.stringify(status)},taskAccepted:true,totalModelCalls:999,terminationConfirmed:${status !== 'reconciliation_required'},test:{checks:[{passed:true}]},browser:{checks:[{passed:true}]},reportPath:'trusted-mock-only'})}});process.argv=[process.execPath,'verify-planned-delivery.mjs','--archive','synthetic-fixture.zip'];await import(${JSON.stringify(scriptUrl)});`;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { input: script, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, status === 'checks_passed' ? 0 : 1, result.stdout + result.stderr); const output = JSON.parse(result.stdout);
    assert.equal(output.taskAccepted, false); assert.equal(output.totalModelCalls, 0); assert.equal(output.status, status);
  }
});

for (const wrongBusiness of [false, true]) test(`real ZIP free MXC/Edge diagnostic ${wrongBusiness ? 'rejects wrong business despite archived passed' : 'runs current HTTP/browser checks but never inherits Review acceptance'}`, {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 120000,
}, async () => {
  const { loadEnv } = await import('../server.mjs'); await loadEnv(); const executable = process.env.EXECUTION_SANDBOX_EXE;
  assert.equal(typeof executable, 'string', 'free native test needs the already configured executable only');
  const input = await fixture(), payload = structuredClone(input.payload), manifest = structuredClone(input.manifest);
  if (wrongBusiness) {
    payload.find(file => file.path === 'src/app.mjs').content = 'export async function createApp(){return {handle(){return {status:500,headers:{"content-type":"text/plain"},body:"deliberately wrong archived business"}},close(){}}}';
    const files = validateProjectFiles(payload.filter(file => input.files.some(source => source.path === file.path))); manifest.binding.sourceHash = hash(files); manifest.sourceHash = manifest.binding.sourceHash; manifest.files = input.index(payload);
  }
  const root = await temporary(), archiveFile = path.join(root, 'fixture.zip'); await writeFile(archiveFile, input.pack(payload, manifest));
  const report = await revalidatePlannedArchive({ archiveFile, outputDir: path.join(root, 'diagnostic'), executable, ...(wrongBusiness ? { timeoutMs: 90000 } : {}) });
  await writeFile(path.join(root, 'independent-report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.status, wrongBusiness ? 'failed' : 'checks_passed', JSON.stringify({ status: report.status, errors: report.errors, test: report.test?.error, browser: report.browser?.error }));
  assert.equal(report.taskAccepted, false); assert.equal(report.historicalAcceptanceVerified, false); assert.equal(report.totalModelCalls, 0); assert.equal(report.terminationConfirmed, true);
  assert.equal(report.test.checks.length, input.compiled.checks.length); assert.ok(report.browser.checks.length > 0); assert.equal(report.test.sourceHash, manifest.binding.sourceHash); assert.equal(report.browser.sourceHash, manifest.binding.sourceHash);
  assert.equal(report.browser.browser.closed, true); assert.equal(report.test.processes.every(process => process.terminationConfirmed), true);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')), report); assert.ok((await readdir(path.dirname(report.reportPath))).includes('revalidation.json'));
});
