import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = { projectId: 'leased-project', runId: 'confirmed-planning-run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64), sourceRevision: 'c'.repeat(64) };
const plainBinding = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]]));
const tasks = [
  { id: 'base', title: '基础服务', description: '实现基础运行和页面', dependsOn: [], requirementIds: ['R1'], inputs: ['确认规格'], outputs: ['基础API与网页'], acceptance: ['基础正常'], writePaths: ['src/app.mjs', 'public/index.html'] },
  { id: 'feature', title: '新增功能', description: '实现独立功能', dependsOn: ['base'], requirementIds: ['R2'], inputs: ['已验收基础'], outputs: ['功能模块'], acceptance: ['功能正常'], writePaths: ['src/feature.mjs'] },
  { id: 'integration', title: '集成与说明', description: '完整集成与交付说明', dependsOn: ['feature'], requirementIds: ['R1', 'R2'], inputs: ['全部已验收模块'], outputs: ['集成说明与完整验证'], acceptance: ['整体验收通过'], writePaths: ['docs/README.md'] },
];
function approved() {
  const proposal = { version: 1, id: 'leased-joint', name: '逐任务批准定义', sessions: [],
    steps: ['base', 'feature'].map((id, index) => ({ id, type: 'request', dependsOn: [], requirementIds: [`R${index + 1}`], request: { id: `${id}_request`, method: 'GET', path: `/${id}`, assertions: [{ id: `${id}_status`, op: 'status', value: 200 }] } })),
    browser: { version: 1, sessions: ['base_session', 'feature_session'], steps: ['base', 'feature'].flatMap((id, index) => [
      { id: `${id}_goto`, session: `${id}_session`, requirementIds: [`R${index + 1}`], op: 'goto', path: '/' },
      { id: `${id}_visible`, session: `${id}_session`, requirementIds: [`R${index + 1}`], op: 'visible', testId: id, value: true },
    ]) }, taskScopes: tasks.map(item => ({ taskId: item.id, httpStepIds: item.id === 'integration' ? ['base', 'feature'] : [item.id], browserStepIds: item.id === 'integration' ? ['base_visible', 'feature_visible'] : [`${item.id}_visible`] })) };
  const control = createVerificationControl(), input = { proposal, requirements: ['R1', 'R2'], binding: plainBinding, tasks };
  const approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval); return { control, approval, manifest };
}

if (!process.env.TASKFLOW_TASK_EXECUTOR_CHILD) {
  test('leased task executor probes use real Git/SQLite and synthetic model/verification transport, no paid calls', () => {
    const env = { ...process.env, TASKFLOW_TASK_EXECUTOR_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  let seen;
  const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'synthetic-infrastructure' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => {
    seen.http.push({ taskId: input.binding.taskId, steps: input.manifest.steps.map(step => step.id) });
    const ready = input.manifest.steps.every(step => step.id !== 'feature' || input.files.some(file => file.path === 'src/feature.mjs'));
    return { status: ready ? 'passed' : 'failed', binding: structuredClone(input.binding), sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash,
      terminationConfirmed: true, processes: [{ ...stopped, pid: 1 }], checks: input.manifest.checks.map(rule => ({ id: rule.id, name: rule.name, passed: ready })) };
  } } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), sourceHash: hash(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash,
    browserPolicyHash: browserScenarioPolicyHash, browser: { closed: true, version: 'synthetic-edge' }, terminationConfirmed: true,
    processes: [{ ...stopped, kind: 'runtime', pid: 2 }, { ...stopped, kind: 'runtime', pid: 3 }, { ...stopped, kind: 'browser', pid: 4 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, passed: true })) }) } });
  const { startPlannedTaskExecution, isPlannedTaskRunAccepted, plannedTaskIntegration } = await import('../lib/planned-task-executor.mjs');
  const { isPlannedWebDeliveryAccepted, isPlannedWebTaskAccepted } = await import('../lib/planned-web-executor.mjs');
  const { runModelRequestWithEvidence } = await import('../lib/model-request-evidence.mjs');

  async function execute(t, mode = 'normal') {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'planned-leased-'));
    t.after(async () => { assert.equal(path.dirname(outputDir), path.resolve(os.tmpdir())); assert.ok(path.basename(outputDir).startsWith('planned-leased-')); await rm(outputDir, { recursive: true, force: true }); });
    const accepted = approved(); seen = { code: [], review: [], http: [], readonly: [] };
    const provider = async input => {
      const context = JSON.parse(input.task), id = context.activeTask.id; seen.code.push(id); seen.readonly.push({ id, paths: context.readonlyPaths });
      if (mode === 'not-dispatched') return runModelRequestWithEvidence(async () => { throw new Error('confirmed native pre-dispatch failure'); });
      if (mode === 'pause' && id === 'base') { execution.pause(); setTimeout(() => execution.resume(), 50); }
      const files = id === 'base' ? [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle:async()=>({status:200,headers:{},body:"base"})}}\n' }, { path: 'public/index.html', content: '<div data-testid="base">基础</div>\n' }]
        : id === 'feature' ? [{ path: mode === 'readonly' ? 'src/app.mjs' : 'src/feature.mjs', content: 'export const feature = true;\n' }]
          : [{ path: 'docs/README.md', content: '# 集成完成的候选说明\n' }];
      await input.onReceipt({ model: 'synthetic-code', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 }, content: JSON.stringify({ files }) }); return { files };
    };
    const reviewer = async input => {
      const id = JSON.parse(input.task).activeTask.id; seen.review.push(id);
      const value = { summary: 'synthetic review transport', issues: mode === 'blocking' && id === 'base' ? [{ severity: 'blocking', file: 'src/app.mjs', line: 1, message: '基础业务尚有问题', evidence: input.files.find(file => file.path === 'src/app.mjs').content.split('\n')[0] }] : [], resolutions: [] };
      await input.onReceipt({ model: 'synthetic-review', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 6 }, content: JSON.stringify(value) }); return value;
    };
    const execution = startPlannedTaskExecution({ outputDir, binding, task: { title: '三任务工程', tasks }, manifest: accepted.manifest, provider, reviewer, maxCalls: 1, maxReviewCalls: 1, timeoutMs: 60000, assertCurrent: () => true });
    const record = await execution.done; return { ...accepted, execution, record, outputDir, seen };
  }
  test('three actual tasks claim immutable attempts, preserve real Git bases, release dependencies after gates and rerun full integration', async t => {
    const result = await execute(t), { record, manifest } = result;
    assert.equal(record.status, 'accepted', JSON.stringify({ error: record.error, tasks: record.tasks, attempts: record.attempts }));
    assert.equal(isPlannedTaskRunAccepted(record, manifest), true); assert.equal(isPlannedTaskRunAccepted(JSON.parse(JSON.stringify(record)), manifest), false);
    assert.deepEqual(result.seen.code, ['base', 'feature', 'integration']); assert.equal(record.totalModelCalls, 6); assert.deepEqual(record.usage, { inputTokens: 24, outputTokens: 30 });
    assert.equal(record.tasks[1].baseCommit, record.tasks[0].candidateCommit); assert.equal(record.tasks[2].baseCommit, record.tasks[1].candidateCommit);
    assert.ok(result.seen.readonly.find(item => item.id === 'feature').paths.includes('src/app.mjs'));
    assert.deepEqual(result.seen.http.filter(item => item.taskId === 'base').map(item => item.steps), [['base'], ['base']]);
    assert.deepEqual(result.seen.http.filter(item => item.taskId === 'integration').map(item => item.steps), [['base', 'feature'], ['base', 'feature']]);
    assert.equal(record.transaction.status, 'succeeded'); assert.equal(record.transaction.budget.unknown, 0); assert.ok(record.attempts.every(attempt => attempt.terminationState === 'confirmed'));
    const final = plannedTaskIntegration(record, manifest); assert.equal(isPlannedWebTaskAccepted(final, manifest), true); assert.equal(isPlannedWebDeliveryAccepted({ record: final, manifest }), true);
    assert.equal(JSON.parse(await readFile(record.reportPath, 'utf8')).status, 'accepted');
  });
  test('a blocking base Review cannot complete the task or start a downstream coding attempt', async t => {
    const result = await execute(t, 'blocking'); assert.equal(result.record.status, 'failed'); assert.equal(result.record.terminationConfirmed, true);
    assert.deepEqual(result.seen.code, ['base']); assert.equal(isPlannedTaskRunAccepted(result.record, result.manifest), false); assert.ok(result.record.tasks.slice(1).every(task => task.status === 'pending'));
  });
  test('a later task cannot overwrite the accepted foundation outside its exact domain', async t => {
    const result = await execute(t, 'readonly'); assert.equal(result.record.status, 'failed'); assert.equal(result.record.terminationConfirmed, true);
    assert.deepEqual(result.seen.code, ['base', 'feature']); assert.equal(result.record.tasks[2].status, 'pending');
  });
  test('pause keeps in-flight results and resume continues only after their same-version gate', async t => {
    const result = await execute(t, 'pause'); assert.equal(result.record.status, 'accepted'); assert.ok(result.record.events.some(event => event.message.includes('暂停')));
  });
  test('confirmed native pre-dispatch error is zero calls and zero tokens, while failure still blocks downstream', async t => {
    const result = await execute(t, 'not-dispatched'); assert.equal(result.record.status, 'failed'); assert.equal(result.record.terminationConfirmed, true);
    assert.equal(result.record.totalModelCalls, 0); assert.deepEqual(result.record.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(result.record.transaction.budget.unknown, 0); assert.deepEqual(result.record.transaction.budget.committed, { calls: 0, tokens: 0 });
    assert.deepEqual(result.seen.code, ['base']); assert.ok(result.record.tasks.slice(1).every(task => task.status === 'pending'));
  });
  test('widening the task write paths after approval is refused before provider or filesystem execution', async () => {
    const accepted = approved(), changed = structuredClone(tasks); changed[1].writePaths.push('src/app.mjs');
    const { compileTaskManifest } = await import('../lib/verification-contract.mjs');
    const { startPlannedWebExecution } = await import('../lib/planned-web-executor.mjs');
    const child = compileTaskManifest({ manifest: accepted.manifest, taskId: 'feature', tasks }); let calls = 0;
    assert.throws(() => startPlannedWebExecution({ outputDir: path.join(os.tmpdir(), 'must-not-be-created'), binding: { ...binding, taskId: 'feature' }, task: { tasks: changed }, manifest: child,
      taskExecution: { attemptId: 'wrong-task-set' }, provider: async () => { calls++; }, reviewer: async () => { calls++; }, assertCurrent: () => true }), /任务集合/u);
    assert.equal(calls, 0);
  });
}
