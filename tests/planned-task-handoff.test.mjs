import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = { projectId: 'handoff-project', runId: 'handoff-run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64), sourceRevision: 'c'.repeat(64), sourceGeneration: 0 };
const tasks = [
  { id: 'BASE', title: '基础', description: '基础服务', dependsOn: [], requirementIds: ['R'], inputs: ['approved'], outputs: ['base'], acceptance: ['base passes'], writePaths: ['src/app.mjs'] },
  { id: 'FINAL', title: '最终集成', description: '完整集成', dependsOn: ['BASE'], requirementIds: ['R'], inputs: ['verified base'], outputs: ['delivery'], acceptance: ['all passes'], writePaths: ['docs/README.md'] },
];
function approved() {
  const proposal = { version: 1, id: 'handoff-joint', name: 'Handoff mechanism', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R'],
    request: { id: 'health', method: 'GET', path: '/health', assertions: [{ id: 'health_status', op: 'status', value: 200 }] } }],
    browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R'], op: 'goto', path: '/' }, { id: 'ready', session: 'visitor', requirementIds: ['R'], op: 'visible', testId: 'ready', value: true }] },
    taskScopes: tasks.map(item => ({ taskId: item.id, httpStepIds: ['read'], browserStepIds: ['ready'] })) };
  const control = createVerificationControl(), input = { proposal, requirements: ['R'], binding: Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]])), tasks };
  const approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval); return { control, manifest, approval };
}

if (!process.env.TASKFLOW_TASK_HANDOFF_CHILD) {
  test('paused-task capability uses actual Git/SQLite/private core objects with explicit synthetic verification transport', () => {
    const env = { ...process.env, TASKFLOW_TASK_HANDOFF_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 6 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# tests 3\r?\n/u); assert.match(result.stdout, /# pass 3\r?\n/u); assert.match(result.stdout, /# fail 0\r?\n/u);
  });
} else {
  const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'synthetic-infrastructure' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding),
    sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash, terminationConfirmed: true,
    processes: [{ ...stopped, pid: 1 }], checks: input.manifest.checks.map(rule => ({ ...rule, passed: true })) }) } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding),
    sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash,
    browser: { closed: true, version: 'synthetic-browser' }, terminationConfirmed: true,
    processes: [{ ...stopped, kind: 'runtime', pid: 2 }, { ...stopped, kind: 'runtime', pid: 3 }, { ...stopped, kind: 'browser', pid: 4 }],
    checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, passed: true })) }) } });
  const { startPlannedTaskExecution, isPlannedTaskRunAccepted, capturePausedTaskCheckpoint, assertPausedTaskCheckpoint, auditPausedTaskCheckpoint,
    retirePausedTaskCheckpoint, assertRetiredTaskCheckpoint } = await import('../lib/planned-task-executor.mjs');
  const { inspectFrozenTaskHandoff } = await import('../lib/task-store.mjs');
  const { isPlannedWebTaskAccepted } = await import('../lib/planned-web-executor.mjs');
  async function until(read) { const end = Date.now() + 30000; for (;;) { const value = read(); if (value) return value; assert.ok(Date.now() < end, 'expected confirmed pause'); await new Promise(resolve => setTimeout(resolve, 10)); } }
  async function fixture(t) {
    const base = path.resolve('output/task-handoff-author'); await mkdir(base, { recursive: true }); const outputDir = await mkdtemp(path.join(base, 'case-')), { control, manifest, approval } = approved(), calls = [];
    let handle;
    const provider = async input => {
      const id = JSON.parse(input.task).activeTask.id; calls.push({ role: 'coding', id }); if (id === 'BASE') handle.pause();
      const files = [{ path: id === 'BASE' ? 'src/app.mjs' : 'docs/README.md', content: id === 'BASE' ? 'export async function createApp(){return {handle:async()=>({status:200,headers:{},body:"ready"})}}\n' : '# Integration\n' }];
      await input.onReceipt({ model: 'synthetic-code', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 }, content: JSON.stringify({ files }) }); return { files };
    };
    const reviewer = async input => { calls.push({ role: 'review', id: JSON.parse(input.task).activeTask.id }); const result = { summary: 'synthetic review', issues: [], resolutions: [] };
      await input.onReceipt({ model: 'synthetic-review', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 6 }, content: JSON.stringify(result) }); return result; };
    handle = startPlannedTaskExecution({ outputDir, binding, task: { title: 'Paused graph', tasks }, manifest, provider, reviewer, maxCalls: 1, maxReviewCalls: 1, timeoutMs: 60000, assertCurrent: () => true });
    t.after(async () => { handle.cancel(); await handle.done; control.revoke(approval); });
    await until(() => handle.snapshot().status === 'paused'); return { handle, manifest, calls, outputDir };
  }
  test('an original paused handle freezes once and retires without completing or rerunning pending tasks', async t => {
    const f = await fixture(t); await assert.rejects(capturePausedTaskCheckpoint({ handle: { ...f.handle }, manifest: f.manifest }));
    const checkpoint = await capturePausedTaskCheckpoint({ handle: f.handle, manifest: f.manifest });
    assert.equal(await capturePausedTaskCheckpoint({ handle: f.handle, manifest: f.manifest }), checkpoint);
    const payload = await auditPausedTaskCheckpoint(checkpoint, { manifest: f.manifest }); assert.equal(payload.graph.totalModelCalls, 2); assert.equal(payload.graph.tasks[0].status, 'completed'); assert.equal(payload.graph.tasks[1].status, 'pending');
    assert.throws(() => assertPausedTaskCheckpoint(structuredClone(checkpoint), { manifest: f.manifest })); assert.throws(() => f.handle.resume());
    assert.equal(isPlannedTaskRunAccepted(payload.graph, f.manifest), false); assert.equal(isPlannedWebTaskAccepted(payload.graph.tasks[0].record, f.manifest), false);
    const retirement = await retirePausedTaskCheckpoint({ handle: f.handle, checkpoint, manifest: f.manifest }); const result = await f.handle.done;
    assert.equal(result.status, 'retired_for_recovery'); assert.equal(result.terminationConfirmed, true); assert.equal(result.totalModelCalls, 2); assert.equal(result.tasks[1].status, 'pending');
    assert.equal(isPlannedTaskRunAccepted(result, f.manifest), false); assert.equal(assertRetiredTaskCheckpoint(retirement, { checkpoint, manifest: f.manifest }).terminationConfirmed, true);
    assert.throws(() => assertRetiredTaskCheckpoint(structuredClone(retirement), { checkpoint, manifest: f.manifest }));
    assert.deepEqual(inspectFrozenTaskHandoff({ filename: payload.taskDatabase, runId: binding.runId, checkpointId: payload.checkpointId }), payload.freeze);
    await auditPausedTaskCheckpoint(checkpoint, { manifest: f.manifest }); assert.deepEqual(f.calls.map(call => `${call.role}:${call.id}`), ['coding:BASE', 'review:BASE']);
    await writeFile(path.join(f.outputDir, 'mechanism-result.json'), JSON.stringify({ payload, retirement: assertRetiredTaskCheckpoint(retirement, { checkpoint, manifest: f.manifest }), calls: f.calls, paidCalls: 0 }, null, 2));
  });
  test('fresh checkpoint audit and retirement reject changed original receipt bytes', async t => {
    const f = await fixture(t), checkpoint = await capturePausedTaskCheckpoint({ handle: f.handle, manifest: f.manifest }), payload = assertPausedTaskCheckpoint(checkpoint, { manifest: f.manifest });
    const filename = payload.graph.modelCalls[0].receiptPath, original = await readFile(filename); await writeFile(filename, Buffer.concat([original, Buffer.from('\n ')]));
    try { await assert.rejects(auditPausedTaskCheckpoint(checkpoint, { manifest: f.manifest })); await assert.rejects(retirePausedTaskCheckpoint({ handle: f.handle, checkpoint, manifest: f.manifest })); assert.equal(f.calls.length, 2); }
    finally { await writeFile(filename, original); }
    await retirePausedTaskCheckpoint({ handle: f.handle, checkpoint, manifest: f.manifest });
  });
  test('a descriptive resume object cannot create a workspace, a task attempt or a model request', async t => {
    const { control, manifest, approval } = approved(); t.after(() => control.revoke(approval));
    const outputDir = path.resolve(`output/task-handoff-author/refused-${Date.now()}`); let calls = 0;
    const handle = startPlannedTaskExecution({ outputDir, binding, task: { title: 'Paused graph', tasks }, manifest,
      provider: async () => { calls++; }, reviewer: async () => { calls++; }, maxCalls: 1, maxReviewCalls: 1,
      timeoutMs: 60000, assertCurrent: () => true, resumePermit: { kind: 'verified_paused_task_resume', checkpoint: { passed: true } } });
    const result = await handle.done; assert.equal(result.status, 'failed'); assert.equal(result.terminationConfirmed, true); assert.equal(result.totalModelCalls, 0); assert.equal(calls, 0);
    assert.equal(result.reportPath, undefined); assert.equal(result.attempts, undefined); assert.equal(isPlannedTaskRunAccepted(result, manifest), false);
    await assert.rejects(lstat(outputDir), { code: 'ENOENT' });
  });
}
