import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, unlink, link, symlink } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

const evidence = path.resolve(import.meta.dirname, '../output/full-goal-20261118/checkpoint-independent');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const normalizedHash = value => hash(validateProjectFiles(value));
if (process.env.TASKFLOW_CHECKPOINT_INDEPENDENT_CHILD !== '1') {
  test('independent checkpoint probes use real Git/core brands with trusted verification fixtures (not business acceptance)', async () => {
    await mkdir(evidence, { recursive: true }); const env = { ...process.env, TASKFLOW_CHECKPOINT_INDEPENDENT_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', import.meta.filename], { env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    await writeFile(path.join(evidence, 'child-tests.tap'), child.stdout); await writeFile(path.join(evidence, 'child-stderr.txt'), child.stderr);
    assert.equal(child.status, 0, child.stdout + child.stderr); assert.match(child.stdout, /# fail 0/u);
  });
} else {
  const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'trusted-test-fixture' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding),
    sourceHash: normalizedHash(input.files), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash, terminationConfirmed: true,
    processes: [{ ...stopped, pid: 111 }], checks: input.manifest.checks.map(item => ({ ...item, expected: item.name, actual: item.name, passed: true })) }) } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding),
    sourceHash: normalizedHash(input.files), manifestHash: input.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, terminationConfirmed: true,
    browser: { closed: true, version: 'trusted-test-fixture' }, coverage: 'structural_only', processes: [{ ...stopped, kind: 'runtime', pid: 211 }, { ...stopped, kind: 'runtime', pid: 212 }, { ...stopped, kind: 'browser', pid: 213 }],
    checks: browserScenarioChecks(input.manifest.browser).map(item => ({ ...item, actual: item.expected, passed: true })) }) } });
  const { startPlannedWebExecution, isPlannedWebTaskAccepted, isPlannedWebDeliveryAccepted, plannedExecutionPolicyHash } = await import('../lib/planned-web-executor.mjs');
  const { createPlannedCheckpoints, assertPlannedCheckpoint } = await import('../lib/planned-checkpoint.mjs');
  const binding = { projectId: 'checkpoint-project', runId: 'checkpoint-run', taskId: 'checkpoint-task', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
  const base = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]]));
  const proposal = { version: 1, id: 'checkpoint-read', name: '资源读取', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'status', op: 'status', value: 200 }] } }],
    browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'visible', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } };
  const task = { title: '资源读取', tasks: [{ id: 'implement', title: '实现资源读取', description: '实现确认的资源接口与页面', dependsOn: [], requirementIds: ['R1'], writePaths: ['src/app.mjs'], inputs: ['确认规格'], outputs: ['资源接口'], acceptance: ['资源可读'] }] };
  let original, row;
  const stores = [];
  async function directory(label) { await mkdir(evidence, { recursive: true }); return mkdtemp(path.join(evidence, label + '-')); }
  function compiled() { const control = createVerificationControl(), input = { proposal: structuredClone(proposal), requirements: ['R1'], binding: base }, approval = control.approve({ ...input, feedback: '可信测试夹具，不计业务验收' }), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval); return { control, approval, manifest }; }
  async function store(label, options = {}) { const rootDir = await directory(label), instance = await createPlannedCheckpoints({ rootDir, ...options }); stores.push(instance); return { rootDir, instance, keyFile: path.join(rootDir, '.accepted-checkpoint.key') }; }
  function args(record, manifest, handle, executionId = row.id) { return { record, manifest, checkpoint: handle, executionId }; }
  async function signed(label) {
    const f = await store(label), seal = f.instance.sign({ row, record: original.record, manifest: original.manifest }), record = JSON.parse(JSON.stringify(original.record)), current = compiled();
    const handle = f.instance.verify({ row, record, seal, policyHash: plannedExecutionPolicyHash, manifest: current.manifest }); return { ...f, seal, record, handle, ...current };
  }
  before(async () => {
    const outputDir = await directory('real-git'), approved = compiled();
    const provider = async input => { const value = { files: [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:200,headers:{},body:"resources"}},close(){}}}\n' }], model: 'synthetic-code', usage: { inputTokens: 3, outputTokens: 4 } }; await input.onReceipt({ model: value.model, finishReason: 'stop', usage: value.usage, content: JSON.stringify({ files: value.files }) }); return value; };
    const reviewer = async input => { const value = { summary: '受控Review夹具', issues: [], resolutions: [], model: 'synthetic-review', usage: { inputTokens: 5, outputTokens: 6 } }; await input.onReceipt({ model: value.model, finishReason: 'stop', usage: value.usage, content: JSON.stringify({ summary: value.summary, issues: [], resolutions: [] }) }); return value; };
    const handle = startPlannedWebExecution({ outputDir, binding, task, manifest: approved.manifest, provider, reviewer, assertCurrent: () => true, maxCalls: 1, maxReviewCalls: 1, timeoutMs: 10000 });
    const record = await handle.done; assert.equal(record.status, 'accepted', JSON.stringify(record)); assert.equal(isPlannedWebTaskAccepted(record, approved.manifest), true);
    original = { record, ...approved }; row = { id: 'service-execution-1', project_id: binding.projectId, run_id: binding.runId, proposal_id: 'proposal-1', definition_revision: 'd'.repeat(64), status: 'accepted', active: 0, created_at: '2026-11-18T00:00:00.000Z',
      binding: JSON.stringify({ ...base, sourceRevision: 'e'.repeat(64), sourceGeneration: 1, engineeringHash: 'f'.repeat(64), contextHash: '1'.repeat(64), policyHash: '2'.repeat(64) }), budget: JSON.stringify({ ...record.budget, maxAttempts: 3, totalModelCalls: 6 }) };
  });
  after(() => { for (const instance of stores) instance.close(); });

  test('real Git/core original identity and receipts remain intact; parsed JSON does not obtain an original pass', async () => {
    const actual = execFileSync('git', ['-C', original.record.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); assert.equal(actual, original.record.candidateCommit);
    for (const call of original.record.modelCalls) assert.equal(hash(await readFile(call.receiptPath)), call.receiptHash);
    assert.equal(isPlannedWebTaskAccepted(JSON.parse(JSON.stringify(original.record)), original.manifest), false); assert.equal(isPlannedWebTaskAccepted(original.record, structuredClone(original.manifest)), false);
  });
  test('new key is exactly 32 bytes, persists across reopen and does not appear in returned seal fields', async () => {
    const f = await store('key-lifecycle'), key = await readFile(f.keyFile); assert.equal(key.length, 32); assert.equal(f.instance.available(), true);
    const seal = f.instance.sign({ row, record: original.record, manifest: original.manifest }); assert.equal(Object.isFrozen(seal), true); assert.deepEqual(Object.keys(seal).sort(), ['instanceId', 'recordHash', 'signature', 'version']);
    assert.equal(JSON.stringify(seal).includes(key.toString('hex')), false); f.instance.close(); assert.equal(f.instance.available(), false);
    const reopened = await createPlannedCheckpoints({ rootDir: f.rootDir, hasCheckpoints: true }); stores.push(reopened); assert.equal(reopened.available(), true); assert.deepEqual(await readFile(f.keyFile), key);
    const record = JSON.parse(JSON.stringify(original.record)), current = compiled(), permit = reopened.verify({ row, record, seal, policyHash: plannedExecutionPolicyHash, manifest: current.manifest });
    assert.equal(isPlannedWebTaskAccepted(record, current.manifest), false); assert.equal(isPlannedWebDeliveryAccepted(args(record, current.manifest, permit)), true);
  });
  test('plain JSON, mutated native records, diagnostics and unbranded manifests cannot be sealed', async () => {
    const f = await store('cannot-seal'), record = JSON.parse(JSON.stringify(original.record));
    for (const value of [record, { ...record, status: 'diagnostic_passed' }, { status: 'accepted', passed: true }]) assert.throws(() => f.instance.sign({ row, record: value, manifest: original.manifest }));
    assert.throws(() => f.instance.sign({ row, record: original.record, manifest: JSON.parse(JSON.stringify(original.manifest)) }));
    const previous = original.record.usage.inputTokens; original.record.usage.inputTokens++;
    try { assert.throws(() => f.instance.sign({ row, record: original.record, manifest: original.manifest })); } finally { original.record.usage.inputTokens = previous; }
  });
  test('HMAC is SHA256 over the purpose/version/complete-domain/canonical-record/settlement bytes', async () => {
    const f = await store('actual-hmac'), key = await readFile(f.keyFile), seal = f.instance.sign({ row, record: original.record, manifest: original.manifest });
    const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => [name, sort(child)])) : value;
    const encode = value => JSON.stringify(sort(value)), r = original.record;
    const message = { purpose: 'taskflow/planned-accepted/v1', version: 1, instanceId: hash(key).slice(0, 32), identity: { executionId: row.id, projectId: row.project_id, runId: row.run_id, proposalId: row.proposal_id, definitionRevision: row.definition_revision,
      createdAt: row.created_at, binding: JSON.parse(row.binding), budget: JSON.parse(row.budget), coreId: r.id, attemptId: r.attemptId, candidateCommit: r.candidateCommit, manifestHash: r.manifestHash, browserPolicyHash: r.browserPolicyHash, reviewPolicyHash: r.reviewPolicyHash, executorPolicyHash: r.executorPolicyHash },
      recordHash: hash(encode(r)), settlement: { actualCalls: r.totalModelCalls, usage: r.usage, releasedReservation: JSON.parse(row.budget).maxCalls + JSON.parse(row.budget).maxReviewCalls } };
    assert.equal(seal.recordHash, message.recordHash); assert.equal(seal.signature, createHmac('sha256', key).update(encode(message)).digest('hex'));
    assert.notEqual(seal.signature, hash(encode(message))); assert.notEqual(seal.signature, createHmac('sha256', key).update(encode({ ...message, purpose: 'different-purpose' })).digest('hex'));
  });
  test('restoration grants historical delivery only and the permit is bound to both object identities and execution id', async () => {
    const f = await signed('object-binding'); assert.equal(isPlannedWebDeliveryAccepted(args(f.record, f.manifest, f.handle)), true); assert.equal(isPlannedWebTaskAccepted(f.record, f.manifest), false);
    for (const candidate of [{ ...f.handle }, JSON.parse(JSON.stringify(f.handle)), JSON.parse(JSON.stringify(f.seal)), f.seal, null]) assert.equal(isPlannedWebDeliveryAccepted(args(f.record, f.manifest, candidate)), false);
    assert.equal(isPlannedWebDeliveryAccepted(args(structuredClone(f.record), f.manifest, f.handle)), false); assert.equal(isPlannedWebDeliveryAccepted(args(f.record, compiled().manifest, f.handle)), false);
    assert.equal(isPlannedWebDeliveryAccepted(args(f.record, f.manifest, f.handle, 'different-service-execution')), false);
  });
  test('an authenticated payload still cannot bypass the shared complete delivery predicate', async () => {
    const f = await signed('full-predicate'), key = await readFile(path.join(f.rootDir, '.accepted-checkpoint.key'));
    const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(name => [name, sort(value[name])])) : value;
    const encode = value => JSON.stringify(sort(value));
    for (const mutate of [record => { record.versions[0].acceptance.test.checks = []; }, record => { record.modelCalls[0].receiptHash = 'not-a-sha256'; }, record => { record.totalModelCalls = 0; }, record => { record.versions[0].acceptance.review.openBlockingIssues = 1; }]) {
      const record = structuredClone(f.record); mutate(record);
      const payload = { purpose: 'taskflow/planned-accepted/v1', version: 1, instanceId: f.seal.instanceId, identity: { executionId: row.id, projectId: row.project_id, runId: row.run_id, proposalId: row.proposal_id, definitionRevision: row.definition_revision,
        createdAt: row.created_at, binding: JSON.parse(row.binding), budget: JSON.parse(row.budget), coreId: record.id, attemptId: record.attemptId, candidateCommit: record.candidateCommit, manifestHash: record.manifestHash, browserPolicyHash: record.browserPolicyHash, reviewPolicyHash: record.reviewPolicyHash, executorPolicyHash: record.executorPolicyHash },
        recordHash: hash(encode(record)), settlement: { actualCalls: record.totalModelCalls, usage: record.usage, releasedReservation: JSON.parse(row.budget).maxCalls + JSON.parse(row.budget).maxReviewCalls } };
      // This synthetic-key integrity probe is deliberately outside the signing
      // API: ordinary parsed records must never be accepted by sign().
      assert.throws(() => f.instance.sign({ row, record, manifest: f.manifest }));
      const seal = { version: 1, instanceId: payload.instanceId, recordHash: payload.recordHash, signature: createHmac('sha256', key).update(encode(payload)).digest('hex') };
      const permit = f.instance.verify({ row, record, seal, policyHash: plannedExecutionPolicyHash, manifest: f.manifest }); assert.equal(assertPlannedCheckpoint(permit, { executionId: row.id, record, manifest: f.manifest, policyHash: plannedExecutionPolicyHash }), true);
      assert.equal(isPlannedWebDeliveryAccepted(args(record, f.manifest, permit)), false);
    }
  });
  test('record mutation, manifest revocation, wrong policy and close invalidate restored delivery', async () => {
    const f = await signed('invalidated'), prior = f.record.usage.inputTokens; f.record.usage.inputTokens++;
    assert.equal(isPlannedWebDeliveryAccepted(args(f.record, f.manifest, f.handle)), false); f.record.usage.inputTokens = prior;
    assert.throws(() => assertPlannedCheckpoint(f.handle, { executionId: row.id, record: f.record, manifest: f.manifest, policyHash: '0'.repeat(64) }));
    assert.equal(isPlannedWebDeliveryAccepted(args(f.record, f.manifest, f.handle)), true); f.control.revoke(f.approval); assert.equal(isPlannedWebDeliveryAccepted(args(f.record, f.manifest, f.handle)), false);
    const g = await signed('closed-permit'); g.instance.close(); assert.equal(isPlannedWebDeliveryAccepted(args(g.record, g.manifest, g.handle)), false); assert.throws(() => g.instance.verify({ row, record: g.record, seal: g.seal, policyHash: plannedExecutionPolicyHash, manifest: g.manifest }));
  });
  for (const field of ['id', 'project_id', 'run_id', 'proposal_id', 'definition_revision', 'created_at', 'status', 'active', 'binding', 'budget']) test(`signed row domain cannot be transplanted or altered: ${field}`, async () => {
    const f = await signed('domain-' + field), changed = structuredClone(row);
    if (field === 'active') changed[field] = 1; else if (field === 'status') changed[field] = 'failed'; else if (field === 'binding') changed.binding = JSON.stringify({ ...JSON.parse(row.binding), sourceGeneration: 2 }); else if (field === 'budget') changed.budget = JSON.stringify({ ...JSON.parse(row.budget), maxCalls: 2 }); else if (field === 'definition_revision') changed[field] = '0'.repeat(64); else changed[field] += '-other';
    assert.throws(() => f.instance.verify({ row: changed, record: f.record, seal: f.seal, policyHash: plannedExecutionPolicyHash, manifest: f.manifest }));
  });
  test('all planning provenance and final source/receipt/body changes are covered, not only visible passed fields', async () => {
    const f = await signed('full-record');
    for (const name of ['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'engineeringHash', 'contextHash', 'policyHash', 'specRevision', 'planRevision']) {
      const changed = structuredClone(row), value = JSON.parse(changed.binding); value[name] = name === 'sourceGeneration' ? 99 : '0'.repeat(64); changed.binding = JSON.stringify(value);
      assert.throws(() => f.instance.verify({ row: changed, record: f.record, seal: f.seal, policyHash: plannedExecutionPolicyHash, manifest: f.manifest }));
    }
    for (const mutate of [r => { r.id += '-foreign'; }, r => { r.candidateCommit = 'f'.repeat(40); }, r => { r.versions[0].sourceHash = '0'.repeat(64); }, r => { r.modelCalls[0].receiptHash = '0'.repeat(64); }, r => { r.events[0].message += 'altered'; }, r => { r.usage.inputTokens++; }, r => { r.executorPolicyHash = '0'.repeat(64); }]) {
      const changed = structuredClone(f.record); mutate(changed); assert.throws(() => f.instance.verify({ row, record: changed, seal: f.seal, policyHash: changed.executorPolicyHash, manifest: f.manifest }));
    }
  });
  test('invalid or foreign tags, versions and manifest brands do not produce a permit', async () => {
    const f = await signed('bad-tags');
    for (const seal of [{ ...f.seal, signature: '0'.repeat(64) }, { ...f.seal, signature: 'a'.repeat(63) }, { ...f.seal, signature: 'z'.repeat(64) }, { ...f.seal, signature: '' }, { ...f.seal, recordHash: 'f'.repeat(64) }, { ...f.seal, instanceId: 'f'.repeat(32) }, { ...f.seal, version: 2 }]) assert.throws(() => f.instance.verify({ row, record: f.record, seal, policyHash: plannedExecutionPolicyHash, manifest: f.manifest }));
    assert.throws(() => f.instance.verify({ row, record: f.record, seal: f.seal, policyHash: '0'.repeat(64), manifest: f.manifest })); assert.throws(() => f.instance.verify({ row, record: f.record, seal: f.seal, policyHash: plannedExecutionPolicyHash, manifest: structuredClone(f.manifest) }));
    const foreign = await store('foreign-key'); assert.throws(() => foreign.instance.verify({ row, record: f.record, seal: f.seal, policyHash: plannedExecutionPolicyHash, manifest: f.manifest }));
  });
  test('missing key with saved checkpoints, corrupt sizes, directories and hardlinks fail closed without replacing bytes', async () => {
    const missing = await store('missing-key', { hasCheckpoints: true }); assert.equal(missing.instance.available(), false); assert.deepEqual(await readdir(missing.rootDir), []); assert.throws(() => missing.instance.sign({ row, record: original.record, manifest: original.manifest }));
    for (const length of [0, 31, 33]) { const rootDir = await directory('bad-key'), filename = path.join(rootDir, '.accepted-checkpoint.key'), bytes = Buffer.alloc(length, 0x41); await writeFile(filename, bytes); const instance = await createPlannedCheckpoints({ rootDir }); stores.push(instance); assert.equal(instance.available(), false); assert.deepEqual(await readFile(filename), bytes); }
    const rootDir = await directory('directory-key'); await mkdir(path.join(rootDir, '.accepted-checkpoint.key')); const invalid = await createPlannedCheckpoints({ rootDir }); stores.push(invalid); assert.equal(invalid.available(), false);
    const linked = await store('hardlink-key'); await link(linked.keyFile, path.join(linked.rootDir, 'alias')); assert.equal(linked.instance.available(), false);
    const reopen = await createPlannedCheckpoints({ rootDir: linked.rootDir, hasCheckpoints: true }); stores.push(reopen); assert.equal(reopen.available(), false);
  });
  test('key replacement or deletion invalidates both further operations and every cached restored permit', async () => {
    for (const mode of ['replace', 'delete']) { const f = await signed('changed-key-' + mode); if (mode === 'replace') await writeFile(f.keyFile, Buffer.alloc(32, 0x37)); else await unlink(f.keyFile);
      assert.equal(f.instance.available(), false); assert.throws(() => f.instance.sign({ row, record: original.record, manifest: original.manifest }));
      assert.equal(isPlannedWebDeliveryAccepted(args(f.record, f.manifest, f.handle)), false, mode + ' cannot retain a cached restoration capability'); }
  });
  test('linked private root is rejected before any key is created', async () => {
    const rootDir = await directory('linked-parent'), target = path.join(rootDir, 'target'); await mkdir(target); await symlink(target, path.join(rootDir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createPlannedCheckpoints({ rootDir: path.join(rootDir, 'alias') })); assert.deepEqual(await readdir(target), []);
  });
  test('concurrent fresh key initialization never replaces the winning key or grants an unavailable writer', async () => {
    const rootDir = await directory('concurrent-key'), results = await Promise.all([createPlannedCheckpoints({ rootDir }), createPlannedCheckpoints({ rootDir })]); stores.push(...results);
    assert.ok(results.some(store => store.available())); const key = await readFile(path.join(rootDir, '.accepted-checkpoint.key')); assert.equal(key.length, 32);
    for (const store of results) { if (store.available()) assert.equal(store.instanceId, hash(key).slice(0, 32)); else assert.throws(() => store.sign({ row, record: original.record, manifest: original.manifest })); }
    const reopened = await createPlannedCheckpoints({ rootDir, hasCheckpoints: true }); stores.push(reopened); assert.equal(reopened.instanceId, hash(key).slice(0, 32)); assert.deepEqual(await readFile(path.join(rootDir, '.accepted-checkpoint.key')), key);
  });
  test('source restoration preparation respects deadline and cancellation before a slow file read resolves', async () => {
    const probeRoot = await directory('source-budget');
    for (const mode of ['timeout', 'cancel']) {
      const script = `import {mock} from 'node:test';import fs from 'node:fs/promises';import * as managed from ${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)};const mode=${JSON.stringify(mode)},nativeReadFile=fs.readFile,nativeRun=managed.runProcess;let calls=0;const reportPath=${JSON.stringify(original.record.reportPath)};mock.module('node:fs/promises',{defaultExport:fs,namedExports:{...fs,readFile:async(...args)=>{if(String(args[0])===reportPath)await new Promise(resolve=>setTimeout(resolve,200));return nativeReadFile(...args);}}});mock.module(${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)},{namedExports:{...managed,runProcess:async(...args)=>{calls++;return nativeRun(...args);}}});const {inspectPlannedSource}=await import(${JSON.stringify(new URL('../lib/planned-source.mjs', import.meta.url).href)});const controller=new AbortController();if(${JSON.stringify(mode)}==='cancel')setTimeout(()=>controller.abort(),20);const started=Date.now();let granted=false,error;try{await inspectPlannedSource({rootDir:${JSON.stringify(path.dirname(path.dirname(original.record.reportPath)))},reportPath,binding:${JSON.stringify(base)},writablePaths:['src/app.mjs'],signal:controller.signal,timeoutMs:${mode === 'timeout' ? 20 : 500}});granted=true;}catch(caught){error={name:caught.name,message:caught.message};}const duration=Date.now()-started;await new Promise(resolve=>setTimeout(resolve,250));process.stdout.write(JSON.stringify({mode,granted,error,duration,calls}));`;
      const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      await writeFile(path.join(probeRoot, mode + '.json'), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.status === 0 ? null : result.stderr }, null, 2)); assert.equal(result.status, 0, result.stdout + result.stderr);
      const actual = JSON.parse(result.stdout); assert.equal(actual.granted, false); assert.ok(actual.error); assert.equal(actual.calls, 0); assert.ok(actual.duration < 190, `${mode} source preparation took ${actual.duration}ms despite 20ms stop`);
    }
  });
  test('an unconfirmed source Git process preserves reconciliationRequired and the original process evidence', async () => {
    const script = `import {mock} from 'node:test';import * as managed from ${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)};const uncertain={pid:987654321,exitCode:null,terminationConfirmed:false,stdout:'',stderr:'',stopReason:'fixture-unconfirmed'};mock.module(${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)},{namedExports:{...managed,runProcess:async()=>uncertain}});const {inspectPlannedSource}=await import(${JSON.stringify(new URL('../lib/planned-source.mjs', import.meta.url).href)});let error;try{await inspectPlannedSource({rootDir:${JSON.stringify(path.dirname(path.dirname(original.record.reportPath)))},reportPath:${JSON.stringify(original.record.reportPath)},binding:${JSON.stringify(base)},writablePaths:['src/app.mjs']});}catch(caught){error={reconciliationRequired:caught.reconciliationRequired,result:caught.result};}process.stdout.write(JSON.stringify(error));`;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 10000 }); assert.equal(result.status, 0, result.stdout + result.stderr);
    const actual = JSON.parse(result.stdout); assert.equal(actual.reconciliationRequired, true); assert.equal(actual.result.terminationConfirmed, false); assert.equal(actual.result.stopReason, 'fixture-unconfirmed');
  });
  test('cancelling an already dispatched source Git waits for its stop receipt and never hides unknown termination', async () => {
    const probeRoot = await directory('source-git-stop');
    for (const confirmed of [false, true]) {
      const script = `import {mock} from 'node:test';import * as managed from ${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)};const controller=new AbortController();let calls=0;mock.module(${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)},{namedExports:{...managed,runProcess:async()=>{calls++;setTimeout(()=>controller.abort(),20);await new Promise(resolve=>setTimeout(resolve,200));return {pid:987654321,exitCode:${confirmed ? '0' : 'null'},terminationConfirmed:${confirmed},stdout:'',stderr:'',stopReason:'fixture-cancel-stop'};}}});const {inspectPlannedSource}=await import(${JSON.stringify(new URL('../lib/planned-source.mjs', import.meta.url).href)});const started=Date.now();let error,granted=false;try{await inspectPlannedSource({rootDir:${JSON.stringify(path.dirname(path.dirname(original.record.reportPath)))},reportPath:${JSON.stringify(original.record.reportPath)},binding:${JSON.stringify(base)},writablePaths:['src/app.mjs'],signal:controller.signal,timeoutMs:500});granted=true;}catch(caught){error={message:caught.message,reconciliationRequired:caught.reconciliationRequired??false,result:caught.result??null};}process.stdout.write(JSON.stringify({duration:Date.now()-started,calls,granted,error}));`;
      const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      await writeFile(path.join(probeRoot, (confirmed ? 'known' : 'unknown') + '.json'), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.status === 0 ? null : result.stderr }, null, 2)); assert.equal(result.status, 0, result.stdout + result.stderr);
      const actual = JSON.parse(result.stdout); assert.equal(actual.calls, 1); assert.equal(actual.granted, false); assert.ok(actual.duration >= 150, 'must retain a dispatched process until its fixed stop receipt is known');
      assert.equal(actual.error.reconciliationRequired, !confirmed); if (!confirmed) assert.equal(actual.error.result.terminationConfirmed, false);
    }
  });
}
