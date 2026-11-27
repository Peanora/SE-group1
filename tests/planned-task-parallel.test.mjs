import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { runModelRequestWithEvidence } from '../lib/model-request-evidence.mjs';

// Real controller/core/source/Git/SQLite; inert HTTP, browser and model transports.
// These tests establish mechanism behavior, not target software acceptance.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = { projectId: 'parallel-project', runId: 'parallel-plan', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const tasks = [
  { id: 'base', title: '基础', description: '独立基础观察', dependsOn: [], requirementIds: ['R1'], inputs: ['批准契约'], outputs: ['基础程序'], acceptance: ['基础可观察'], writePaths: ['src/app.mjs'] },
  { id: 'alpha', title: '甲功能', description: '独立甲观察', dependsOn: ['base'], requirementIds: ['R2'], inputs: ['已验收基础'], outputs: ['甲模块'], acceptance: ['甲可观察'], writePaths: ['src/alpha.mjs'] },
  { id: 'beta', title: '乙功能', description: '独立乙观察', dependsOn: ['base'], requirementIds: ['R3'], inputs: ['已验收基础'], outputs: ['乙模块'], acceptance: ['乙可观察'], writePaths: ['src/beta.mjs'] },
  { id: 'integration', title: '完整集成', description: '合并代码完整联合检查', dependsOn: ['alpha', 'beta'], requirementIds: ['R1', 'R2', 'R3'], inputs: ['全部已验收功能'], outputs: ['集成说明'], acceptance: ['完整清单通过'], writePaths: ['docs/integration.md'] },
];
const rollingTasks = [...tasks.slice(0, -1),
  { id: 'alpha_follow', title: '甲分支后继', description: '不等待乙分支', dependsOn: ['alpha'], requirementIds: ['R4'],
    inputs: ['已验收甲模块'], outputs: ['甲分支结果'], acceptance: ['甲分支后继可观察'], writePaths: ['src/alpha_follow.mjs'] },
  { ...tasks.at(-1), dependsOn: ['alpha_follow', 'beta'], requirementIds: ['R1', 'R2', 'R3', 'R4'] },
];

function approved(selectedTasks = tasks) {
  const ids = selectedTasks.slice(0, -1).map(item => item.id);
  const proposal = { version: 1, id: 'parallel-contract', name: '并行机制观察夹具', sessions: [], steps: selectedTasks.slice(0, -1).map((item, index) => ({ id: item.id, type: 'request', dependsOn: item.dependsOn, requirementIds: [`R${index + 1}`], request: { id: item.id + '_request', method: 'GET', path: '/' + item.id, assertions: [{ id: item.id + '_ok', op: 'status', value: 200 }] } })),
    browser: { version: 1, sessions: ids, steps: ids.flatMap((id, index) => [{ id: id + '_go', op: 'goto', session: id, requirementIds: [`R${index + 1}`], path: '/' }, { id: id + '_shown', op: 'visible', session: id, requirementIds: [`R${index + 1}`], testId: id, value: true }]) },
    taskScopes: selectedTasks.map(item => ({ taskId: item.id, httpStepIds: item.id === 'integration' ? ids : [item.id], browserStepIds: item.id === 'integration' ? ids.map(id => id + '_shown') : [item.id + '_shown'] })) };
  const control = createVerificationControl(), value = { proposal, tasks: selectedTasks, requirements: ids.map((_, index) => `R${index + 1}`), binding }, approval = control.approve(value), manifest = compileManifest({ ...value, approval }); control.beginCoding(approval); return { manifest };
}
if (!process.env.TASKFLOW_TASK_PARALLEL_CHILD) {
  test('parallel task mechanisms use free fixtures with real Git/SQLite and isolated child module mocks', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^LLM_|^TASKFLOW_TEAM/iu.test(key)));
    env.TASKFLOW_TASK_PARALLEL_CHILD = '1'; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr); assert.match(child.stdout, /# fail 0/u);
  });
} else {
  const managed = await import('../lib/managed-process.mjs');
  let seen, mode, handle, live = true, release, started, peakCallbacks, activeCallbacks, cancelledCallbacks;
  const stop = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/managed-process.mjs', import.meta.url).href, { namedExports: { ...managed, runProcess: async (command, args, options) => {
    if (command === 'git' && args.includes('merge') && args.includes('--no-ff') && ['merge-failed', 'merge-unknown'].includes(mode)) {
      seen.mergeFaults++; return { pid: mode === 'merge-unknown' ? 551101 : null, startedAt: '2026-11-18T01:00:00.000Z', exitCode: mode === 'merge-unknown' ? null : 1, terminationConfirmed: mode !== 'merge-unknown', stopReason: mode === 'merge-unknown' ? 'inert-stop-unknown' : null, stdout: '', stderr: '', truncated: false, durationMs: 1 };
    }
    return managed.runProcess(command, args, options);
  } } });
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'inert-parallel-test-infrastructure' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => {
    seen.http.push({ taskId: input.binding.taskId, steps: input.manifest.steps.map(step => step.id) });
    const ready = input.manifest.steps.every(step => input.files.some(file => file.path === `src/${step.id === 'base' ? 'app' : step.id}.mjs`)) && !(['alpha-http-failed', 'rolling-failed'].includes(mode) && input.binding.taskId === 'alpha');
    return { status: ready ? 'passed' : 'failed', binding: structuredClone(input.binding), sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash,
      terminationConfirmed: true, processes: [{ ...stop, pid: 1 }], checks: input.manifest.checks.map(rule => ({ ...rule, passed: ready })) };
  } } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash,
    browserPolicyHash: browserScenarioPolicyHash, browser: { closed: true, version: 'inert-parallel-edge' }, terminationConfirmed: true, processes: [{ ...stop, kind: 'runtime', pid: 2 }, { ...stop, kind: 'runtime', pid: 3 }, { ...stop, kind: 'browser', pid: 4 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, passed: true })) }) } });
  const { startPlannedTaskExecution, isPlannedTaskRunAccepted, plannedTaskIntegration } = await import('../lib/planned-task-executor.mjs');
  const { isPlannedWebTaskAccepted } = await import('../lib/planned-web-executor.mjs');
  const abortError = signal => new Promise((_, reject) => { if (signal.aborted) reject(new Error('inert aborted transport')); else signal.addEventListener('abort', () => reject(new Error('inert aborted transport')), { once: true }); });
  async function execute(t, selected = 'normal', maxConcurrency = 2) {
    mode = selected; seen = { code: [], review: [], http: [], mergeFaults: 0, observedPause: null, pauseAtBoundary: null }; live = true; started = 0; peakCallbacks = 0; activeCallbacks = 0; cancelledCallbacks = 0;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'planned-task-parallel-')); let barrier = new Promise(resolve => { release = resolve; });
    t.after(async () => { assert.equal(path.dirname(outputDir), path.resolve(os.tmpdir())); assert.ok(path.basename(outputDir).startsWith('planned-task-parallel-')); await rm(outputDir, { recursive: true, force: true }); });
    const rolling = selected.startsWith('rolling');
    const taskSet = rolling ? rollingTasks : tasks;
    const { manifest } = approved(taskSet);
    let releaseBeta;
    const betaGate = new Promise(resolve => { releaseBeta = resolve; });
    const provider = async input => {
      const id = JSON.parse(input.task).activeTask.id; seen.code.push(id);
      if (['alpha', 'beta'].includes(id)) {
        activeCallbacks++; peakCallbacks = Math.max(peakCallbacks, activeCallbacks); started++; if (started === 2) release();
        try {
          if (maxConcurrency === 2) await barrier;
          if (selected === 'unknown-one' && id === 'alpha') throw new Error('inert dispatched callback without receipt');
          if (selected === 'cancel-unknown' || selected === 'cancel-known') {
            if (id === 'alpha') setTimeout(() => handle.cancel(), 5);
            if (selected === 'cancel-known') return await runModelRequestWithEvidence(() => abortError(input.signal));
            return await abortError(input.signal);
          }
          if (selected === 'pause' && id === 'alpha') { handle.pause(); seen.observedPause = handle.snapshot().status; assert.throws(() => handle.pause()); }
          if (id === 'beta') {
            if (rolling) await runModelRequestWithEvidence(() => Promise.race([betaGate, abortError(input.signal)]));
            else await new Promise(resolve => setTimeout(resolve, 25));
          }
        } finally { activeCallbacks--; if (input.signal.aborted) cancelledCallbacks++; }
      }
      const file = taskSet.find(item => item.id === id).writePaths[0], files = [{ path: file, content: id === 'base' ? 'export async function createApp(){return {handle:async()=>({status:200,body:"inert test fixture",headers:{}})}}\n' : id === 'integration' ? '# Inert integration fixture\n' : `export const ${id}=true;\n` }];
      await input.onReceipt({ model: 'synthetic-code', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify({ files }) }); return { files };
    };
    const reviewer = async input => { seen.review.push(JSON.parse(input.task).activeTask.id); const value = { summary: 'Synthetic independent review transport', issues: [], resolutions: [] }; await input.onReceipt({ model: 'synthetic-review', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 }, content: JSON.stringify(value) }); return value; };
    const options = { outputDir, binding, task: { title: 'Parallel fixture', tasks: taskSet, ...(rolling ? { dependencyExecution: true } : {}) }, manifest, provider, reviewer, maxConcurrency, maxCalls: 1, maxReviewCalls: 1, timeoutMs: rolling ? 24000 : 90000, assertCurrent: () => live,
      onEvent: event => {
        if (rolling && event.type === 'task_started' && event.taskId === 'alpha_follow') {
          seen.betaAtNextDispatch = handle.snapshot().tasks.find(item => item.id === 'beta').status;
          releaseBeta();
        }
        if (selected === 'stale-merge' && event.type === 'task_verified' && ['alpha', 'beta'].includes(event.taskId) && handle.snapshot().tasks.filter(item => ['alpha', 'beta'].includes(item.id) && item.status === 'verified').length === 2) live = false;
        if (selected === 'pause' && event.type === 'paused') { seen.pauseAtBoundary = handle.snapshot(); assert.equal(seen.code.includes('integration'), false); setTimeout(() => { handle.resume(); assert.equal(handle.snapshot().status, 'running'); assert.throws(() => handle.resume()); }, 10); }
      } };
    if (selected === 'normal' && maxConcurrency === 2) delete options.maxConcurrency;
    handle = startPlannedTaskExecution(options); const record = await handle.done; return { record, manifest, seen: structuredClone(seen), peakCallbacks, cancelledCallbacks, options };
  }
  test('two coding callbacks overlap on different leases/clones sharing one exact base, then full parent rechecks real merged Git', async t => {
    const result = await execute(t), { record, manifest } = result; assert.equal(record.status, 'accepted', JSON.stringify({ error: record.error, tasks: record.tasks.map(item => ({ id: item.id, status: item.status, error: item.record?.error })), reconciliation: record.reconciliation }));
    assert.equal(result.peakCallbacks, 2); assert.equal(record.maxObservedConcurrency, 2); assert.equal(record.maxConcurrentTasks, 2); assert.equal(record.maxConcurrency, 2);
    assert.deepEqual(record.batches.map(batch => batch.taskIds), [['base'], ['alpha', 'beta'], ['integration']]); assert.equal(record.merges.length, 1);
    const [alpha, beta] = record.tasks.slice(1, 3); assert.equal(alpha.baseCommit, beta.baseCommit); assert.equal(alpha.baseCommit, record.tasks[0].candidateCommit); assert.notEqual(alpha.attemptId, beta.attemptId); assert.notEqual(alpha.record.workspace, beta.record.workspace);
    assert.equal(record.tasks[3].baseCommit, record.merges[0].sourceCommit); assert.equal(record.integration.baseCommit, record.merges[0].sourceCommit); assert.equal(record.integration.taskId, 'integration');
    for (const entry of [alpha, beta]) { const git = await managed.runProcess('git', ['merge-base', '--is-ancestor', entry.candidateCommit, record.candidateCommit], { cwd: record.workspace, env: managed.minimalEnv({ PATH: process.env.PATH || '' }) }); assert.equal(git.exitCode, 0); assert.equal(git.terminationConfirmed, true); }
    assert.equal(record.modelCalls.length, 8); assert.equal(record.totalModelCalls, 8); assert.equal(record.budget.maxModelCalls, 8); assert.deepEqual(record.usage, { inputTokens: 20, outputTokens: 28 }); assert.equal(record.transaction.budget.unknown, 0);
    assert.equal(record.executorPolicyHash, record.integration.executorPolicyHash); assert.equal(record.candidateCommit, record.integration.candidateCommit); assert.equal(isPlannedTaskRunAccepted(record, manifest), true); assert.equal(isPlannedTaskRunAccepted(structuredClone(record), manifest), false); assert.equal(isPlannedWebTaskAccepted(plannedTaskIntegration(record, manifest), manifest), true);
    assert.deepEqual(result.seen.http.filter(item => item.taskId === 'integration').map(item => item.steps), [['base', 'alpha', 'beta'], ['base', 'alpha', 'beta']]);
    assert.equal(JSON.parse(await readFile(record.reportPath, 'utf8')).integration.candidateCommit, record.candidateCommit);
  });
  test('explicit concurrency1 keeps real execution serial, sums all calls and uses no parallel merge', async t => {
    const { record, peakCallbacks } = await execute(t, 'normal', 1); assert.equal(record.status, 'accepted'); assert.equal(record.maxConcurrentTasks, 1); assert.equal(peakCallbacks, 1); assert.equal(record.merges.length, 0); assert.equal(record.totalModelCalls, 8); assert.deepEqual(record.batches.map(batch => batch.taskIds), [['base'], ['alpha'], ['beta'], ['integration']]);
  });
  test('a drawn dependency releases its own successor while its sibling is still in flight, then the join rechecks real Git', async t => {
    const { record, manifest, seen } = await execute(t, 'rolling');
    assert.equal(record.status, 'accepted', JSON.stringify({ tasks: record.tasks.map(({ id, status, record }) => [id, status, record?.error]), error: record.error }));
    assert.equal(record.dispatchMode, 'direct_dependencies');
    assert.equal(seen.betaAtNextDispatch, 'running');
    assert.deepEqual(seen.code.slice(0, 4), ['base', 'alpha', 'beta', 'alpha_follow']);
    const integratedAt = id => record.events.findIndex(event => event.type === 'batch_completed' && event.taskIds.includes(id));
    const startedAt = id => record.events.findIndex(event => event.type === 'task_started' && event.taskId === id);
    assert.ok(integratedAt('alpha') < startedAt('alpha_follow') && startedAt('alpha_follow') < integratedAt('beta'));
    assert.ok(Math.max(integratedAt('beta'), integratedAt('alpha_follow')) < startedAt('integration'));
    assert.equal(record.maxObservedConcurrency, 2);
    assert.ok(record.merges.some(merge => merge.taskIds.length === 1));
    assert.equal(isPlannedTaskRunAccepted(record, manifest), true);
  });
  test('failed checkpoint releases no successor or final join and started work is accounted for', async t => {
    const { record, seen } = await execute(t, 'rolling-failed');
    assert.equal(record.status, 'failed');
    assert.equal(record.terminationConfirmed, true);
    assert.ok(!seen.code.includes('alpha_follow') && !seen.code.includes('integration'));
    assert.equal(record.transactionEvents.filter(event => event.type === 'task_completed').length, 1);
    assert.equal(record.transaction.budget.unknown, 0);
  });
  test('one failed self-check waits for the successful sibling costs without completing either parallel task or releasing integration', async t => {
    const { record, seen } = await execute(t, 'alpha-http-failed'); assert.equal(record.status, 'failed'); assert.equal(record.terminationConfirmed, true); assert.equal(record.totalModelCalls, 5); assert.equal(record.modelCalls.length, 5); assert.equal(record.transaction.budget.committed.calls, 5); assert.equal(record.transaction.budget.unknown, 0); assert.equal(seen.review.includes('beta'), true); assert.equal(seen.code.includes('integration'), false); assert.ok(record.tasks.slice(1, 3).every(item => item.status !== 'completed')); assert.equal(record.transactionEvents.filter(event => event.type === 'task_completed').length, 1);
  });
  test('an unreceipted sibling does not discard another siblings complete calls or unknown reservation', async t => {
    const { record, seen } = await execute(t, 'unknown-one'); assert.equal(record.status, 'reconciliation_required'); assert.equal(record.terminationConfirmed, false); assert.equal(record.totalModelCalls, 5); assert.equal(record.modelCalls.length, 5); assert.equal(record.usage.inputTokens, null); assert.equal(record.usage.outputTokens, null); assert.equal(record.transaction.budget.unknown, 1); assert.equal(seen.review.includes('beta'), true); assert.equal(seen.code.includes('integration'), false);
  });
  for (const known of [false, true]) test(`cancel signals both live callbacks and accounts for all settled results; trusted-not-sent=${known}`, async t => {
    const { record, seen, cancelledCallbacks } = await execute(t, known ? 'cancel-known' : 'cancel-unknown'); assert.equal(cancelledCallbacks, 2); assert.equal(seen.code[0], 'base'); assert.deepEqual(seen.code.slice(1).sort(), ['alpha', 'beta']); assert.equal(record.attempts.length, 3); assert.equal(record.totalModelCalls, known ? 2 : 4); assert.equal(record.modelCalls.length, 4); assert.equal(record.terminationConfirmed, known); assert.equal(record.status, known ? 'stopped' : 'reconciliation_required'); assert.equal(record.transaction.budget.unknown, known ? 0 : 2); assert.equal(seen.code.includes('integration'), false);
  });
  for (const selected of ['merge-failed', 'merge-unknown', 'stale-merge']) test('failed, unknown or stale merge cannot release a locally accepted batch: ' + selected, async t => {
    const { record, seen } = await execute(t, selected); assert.equal(record.status, selected === 'merge-unknown' ? 'reconciliation_required' : 'failed'); assert.equal(record.terminationConfirmed, selected !== 'merge-unknown'); assert.equal(record.totalModelCalls, 6); assert.equal(record.transaction.budget.unknown, 0); assert.equal(seen.code.includes('integration'), false); assert.ok(record.tasks.slice(1, 3).every(item => item.status !== 'completed')); assert.equal(record.transactionEvents.filter(event => event.type === 'task_completed').length, 1); if (selected === 'merge-unknown') assert.equal(record.reconciliation.process.pid, 551101);
  });
  test('pause requested is immediately observable, finishes inflight batch, prevents next dispatch and resumes only once', async t => {
    const { record, seen } = await execute(t, 'pause'); assert.equal(record.status, 'accepted'); assert.equal(seen.observedPause, 'pause_requested'); assert.equal(seen.pauseAtBoundary.status, 'paused'); assert.ok(seen.pauseAtBoundary.tasks.slice(1, 3).every(item => item.status === 'completed')); assert.equal(seen.pauseAtBoundary.tasks[3].status, 'pending'); assert.ok(record.events.some(event => event.type === 'pause_requested')); assert.ok(record.events.some(event => event.type === 'resumed'));
  });
  test('invalid concurrency is rejected before a model callback or output creation', () => {
    const { manifest } = approved(); for (const maxConcurrency of [0, 3, '2', null]) assert.throws(() => startPlannedTaskExecution({ binding, task: { tasks }, manifest, maxConcurrency, assertCurrent: () => true }));
  });
}
