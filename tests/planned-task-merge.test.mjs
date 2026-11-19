import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVerificationControl, compileManifest, compileTaskManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = { projectId: 'merge-project', runId: 'merge-planning', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const tasks = [
  { id: 'base', requirementIds: ['R'], dependsOn: [], writePaths: ['src/app.mjs'] },
  { id: 'alpha', requirementIds: ['R'], dependsOn: ['base'], writePaths: ['src/alpha.mjs'] },
  { id: 'beta', requirementIds: ['R'], dependsOn: ['base'], writePaths: ['src/beta.mjs'] },
  { id: 'integration', requirementIds: ['R'], dependsOn: ['alpha', 'beta'], writePaths: ['docs/README.md'] },
].map(item => ({ ...item, title: item.id, description: `实现${item.id}`, inputs: ['确认规格'], outputs: ['代码'], acceptance: ['对应条件通过'] }));

if (!process.env.TASKFLOW_TASK_MERGE_CHILD) {
  test('parallel candidate merge uses real Git branches and receipts with synthetic verification infrastructure, no paid model', () => {
    const env = { ...process.env, TASKFLOW_TASK_MERGE_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env, encoding: 'utf8', timeout: 90000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'test-only-infrastructure' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash,
    sourceHash: hash(validateProjectFiles(input.files)), terminationConfirmed: true, processes: [{ ...stopped, pid: 1 }], checks: input.manifest.checks.map(rule => ({ ...rule, passed: true })) }) } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), manifestHash: input.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash,
    sourceHash: hash(validateProjectFiles(input.files)), terminationConfirmed: true, browser: { closed: true, version: 'test-only-edge' },
    processes: [{ ...stopped, kind: 'runtime', pid: 2 }, { ...stopped, kind: 'runtime', pid: 3 }, { ...stopped, kind: 'browser', pid: 4 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, passed: true })) }) } });
  const { startPlannedWebExecution, isPlannedWebTaskAccepted } = await import('../lib/planned-web-executor.mjs');
  const { createPlannedTaskSeed } = await import('../lib/planned-task-base.mjs');
  const { inspectPlannedSource } = await import('../lib/planned-source.mjs');
  const { mergePlannedTaskCandidates, assertPlannedMergedSource } = await import('../lib/planned-task-merge.mjs');

  test('two truly overlapping coding callbacks on distinct clones merge exact source deltas, preserving both native Git parents and no inherited pass', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'planned-parallel-'));
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('planned-parallel-')); await rm(root, { recursive: true, force: true }); });
    const proposal = { version: 1, id: 'merge-definition', name: '独立模块检查', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R'], request: { id: 'read_request', method: 'GET', path: '/', assertions: [{ id: 'ok', op: 'status', value: 200 }] } }],
      browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'go', op: 'goto', session: 'visitor', requirementIds: ['R'], path: '/' }, { id: 'shown', op: 'visible', session: 'visitor', requirementIds: ['R'], testId: 'shell', value: true }] },
      taskScopes: tasks.map(item => ({ taskId: item.id, httpStepIds: ['read'], browserStepIds: ['shown'] })) };
    const control = createVerificationControl(), input = { proposal, tasks, requirements: ['R'], binding }, approval = control.approve(input), parent = compileManifest({ ...input, approval }); control.beginCoding(approval);
    const task = { title: '独立模块', tasks }, writablePaths = tasks.flatMap(item => item.writePaths), seed = await createPlannedTaskSeed({ rootDir: root, binding });
    let parallelStarted = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const provider = async input => {
      const id = JSON.parse(input.task).activeTask.id;
      if (id !== 'base') { parallelStarted++; if (parallelStarted === 2) release(); await barrier; }
      const files = [{ path: tasks.find(item => item.id === id).writePaths[0], content: id === 'base' ? 'export async function createApp(){return {handle:async()=>({status:200,body:"base",headers:{}})}}\n' : `export const ${id} = true;\n` }];
      await input.onReceipt({ model: 'synthetic-code', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify({ files }) }); return { files };
    };
    const reviewer = async input => { const value = { summary: 'synthetic review', issues: [], resolutions: [] }; await input.onReceipt({ model: 'synthetic-review', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 }, content: JSON.stringify(value) }); return value; };
    const run = async (id, initial) => {
      const manifest = compileTaskManifest({ manifest: parent, taskId: id, tasks });
      const handle = startPlannedWebExecution({ outputDir: root, binding: { ...binding, taskId: id }, task, manifest, provider, reviewer, taskExecution: { attemptId: `attempt-${id}` },
        ...initial, maxCalls: 1, maxReviewCalls: 1, timeoutMs: 20000, assertCurrent: () => true });
      const record = await handle.done; assert.equal(isPlannedWebTaskAccepted(record, manifest), true, JSON.stringify(record)); return { record, manifest };
    };
    const scaffold = await run('base', { initialTaskBase: seed });
    const base = await inspectPlannedSource({ rootDir: root, reportPath: scaffold.record.reportPath, expectedRecord: scaffold.record, binding, writablePaths });
    const candidates = await Promise.all(['alpha', 'beta'].map(id => run(id, { initialSource: base })));
    assert.equal(parallelStarted, 2); assert.notEqual(candidates[0].record.workspace, candidates[1].record.workspace); assert.ok(candidates.every(item => item.record.baseCommit === scaffold.record.candidateCommit));
    const merge = await mergePlannedTaskCandidates({ rootDir: root, sourceRootDir: root, binding, manifest: parent, task, base, candidates, assertCurrent: () => true });
    const result = assertPlannedMergedSource(merge, binding, writablePaths);
    assert.deepEqual(result.files.map(file => file.path), ['src/alpha.mjs', 'src/app.mjs', 'src/beta.mjs']); assert.equal(result.files.find(file => file.path === 'src/app.mjs').content, scaffold.record.versions.length && (await readFile(path.join(scaffold.record.workspace, 'src/app.mjs'), 'utf8')));
    assert.equal(isPlannedWebTaskAccepted(merge, parent), false); assert.throws(() => assertPlannedMergedSource(JSON.parse(JSON.stringify(merge)), binding, writablePaths));
    const report = JSON.parse(await readFile(result.provenance.sourceReportPath, 'utf8')); assert.equal(report.taskAccepted, false); assert.equal(report.sources.length, 2);
    const git = spawnSync('git', ['rev-list', '--parents', '-n', '1', result.provenance.sourceCommit], { cwd: result.provenance.sourceWorkspace, encoding: 'utf8', windowsHide: true }); assert.equal(git.status, 0); assert.equal(git.stdout.trim().split(' ').length, 3);
    for (const candidate of candidates) { const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', candidate.record.candidateCommit, result.provenance.sourceCommit], { cwd: result.provenance.sourceWorkspace, windowsHide: true }); assert.equal(ancestor.status, 0); }
    await assert.rejects(mergePlannedTaskCandidates({ rootDir: root, sourceRootDir: root, binding, manifest: parent, task, base, candidates: [candidates[0], candidates[0]], assertCurrent: () => true }));
    const wrong = structuredClone(task); wrong.tasks[1].writePaths.push('src/other.mjs');
    await assert.rejects(mergePlannedTaskCandidates({ rootDir: root, sourceRootDir: root, binding, manifest: parent, task: wrong, base, candidates, assertCurrent: () => true }));
  });
}
