import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

// Real core/receipts/Git/source/SQLite. Only execution infrastructure and model
// response transports are inert. This does not validate a business application.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = { projectId: 'rework', runId: 'same-plan', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const tasks = [{ id: 'BASE', title: '基础', description: '基础程序', requirementIds: ['R1'], dependsOn: [], inputs: ['规格'], outputs: ['程序'], acceptance: ['程序可用'], writePaths: ['src/app.mjs'] },
  { id: 'FINAL', title: '集成', description: '完整独立验证', requirementIds: ['R1', 'R2'], dependsOn: ['BASE'], inputs: ['基础程序'], outputs: ['说明'], acceptance: ['完整通过'], writePaths: ['docs/integration.md'] }];
function approved() {
  const proposal = { version: 1, id: 'rework-observations', name: '返工机制观察', sessions: [],
    steps: ['base', 'final'].map((id, i) => ({ id, type: 'request', dependsOn: i ? ['base'] : [], requirementIds: [`R${i + 1}`], request: { id: `${id}_request`, method: 'GET', path: `/${id}`, assertions: [{ id: `${id}_ok`, op: 'status', value: 200 }] } })),
    browser: { version: 1, sessions: ['base', 'final'], steps: ['base', 'final'].flatMap((id, i) => [{ id: `${id}_go`, op: 'goto', session: id, requirementIds: [`R${i + 1}`], path: '/' }, { id: `${id}_visible`, op: 'visible', session: id, requirementIds: [`R${i + 1}`], testId: id, value: true }]) },
    taskScopes: [{ taskId: 'BASE', httpStepIds: ['base'], browserStepIds: ['base_visible'] }, { taskId: 'FINAL', httpStepIds: ['base', 'final'], browserStepIds: ['base_visible', 'final_visible'] }] };
  const control = createVerificationControl(), value = { proposal, tasks, requirements: ['R1', 'R2'], binding }, approval = control.approve(value);
  const manifest = compileManifest({ ...value, approval }); control.beginCoding(approval); return manifest;
}
if (!process.env.TASKFLOW_INTEGRATION_REWORK_CHILD) {
  test('integration rework uses actual private gates and task transactions with inert transports', () => {
    const env = { ...process.env, TASKFLOW_INTEGRATION_REWORK_CHILD: '1', LLM_BASE_URL: '', LLM_MODEL: '', LLM_API_KEY: '' }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', import.meta.filename], { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr); assert.match(child.stdout, /# fail 0/u);
  });
} else {
  const stop = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'inert-controller-fixture' }) }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), sourceHash: digest(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash,
    policyHash: input.manifest.policyHash, terminationConfirmed: true, processes: [{ ...stop, pid: 1 }], checks: input.manifest.checks.map(rule => ({ ...rule, passed: true })) }) } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => ({ status: 'passed', binding: structuredClone(input.binding), sourceHash: digest(validateProjectFiles(input.files)), manifestHash: input.manifest.manifestHash,
    browserPolicyHash: browserScenarioPolicyHash, browser: { closed: true, version: 'inert-controller-edge' }, terminationConfirmed: true, processes: [{ ...stop, kind: 'runtime', pid: 2 }, { ...stop, kind: 'runtime', pid: 3 }, { ...stop, kind: 'browser', pid: 4 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, passed: true })) }) } });
  const { startPlannedTaskExecution, isPlannedTaskRunAccepted } = await import('../lib/planned-task-executor.mjs');
  const { createProjectReviewModel } = await import('../lib/project-review-model.mjs');
  const { inspectPlannedSource, assertPlannedSource } = await import('../lib/planned-source.mjs');
  async function execute(mode = 'repair', limit = 3) {
    const parent = path.resolve(import.meta.dirname, '../output/integration-rework-tests'); await mkdir(parent, { recursive: true }); const outputDir = await mkdtemp(path.join(parent, 'case-'));
    const manifest = approved(), code = [], reviews = []; let live = true, baseAttempts = 0, finalAttempts = 0;
    const provider = async input => {
      const id = JSON.parse(input.task).activeTask.id; code.push(id);
      const n = id === 'BASE' ? ++baseAttempts : ++finalAttempts;
      const files = [{ path: tasks.find(item => item.id === id).writePaths[0], content: id === 'BASE' ? `export const revision=${n};\nexport async function createApp(){return {handle:async()=>({status:200,body:'fixture'})}}\n` : `# Integration round ${n}\n` }];
      await input.onReceipt({ model: 'inert-code', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify({ files }) }); return { files };
    };
    const reviewer = async input => {
      const id = JSON.parse(input.task).activeTask.id; reviews.push(id);
      if (mode === 'unknown' && id === 'FINAL') throw new Error('inert dispatched review without receipt');
      if (mode === 'truncated-history' && id === 'FINAL' && reviews.filter(item => item === 'FINAL').length === 1) {
        await input.onReceipt({ model: 'inert-review', finishReason: 'length', usage: { inputTokens: 3, outputTokens: 4096 }, content: '' });
        throw new Error('Review模型输出被截断。');
      }
      const appSource = input.files.find(file => file.path === 'src/app.mjs').content, fixed = appSource.includes('revision=2');
      const upstreamMessage = '上游业务文件存在需修复的阻塞。';
      const previousIssues = input.previousIssues ?? [];
      const knownUpstream = previousIssues.find(issue => issue.file === 'src/app.mjs' && issue.message === upstreamMessage);
      const upstreamStillOpen = id === 'FINAL' && (!fixed || mode === 'repeat');
      const issues = upstreamStillOpen && !knownUpstream ? [{ severity: 'blocking', file: 'src/app.mjs', line: 1, message: upstreamMessage, evidence: appSource.split('\n')[0].trim() }] : [];
      if (mode === 'mixed' && id === 'FINAL') issues.push({ severity: 'blocking', file: 'docs/integration.md', line: 1, message: '集成自己负责的说明仍不完整。', evidence: input.files.find(file => file.path === 'docs/integration.md').content.split('\n')[0].trim() });
      const resolutions = previousIssues.map(issue => {
        const resolved = fixed && !(issue.id === knownUpstream?.id && upstreamStillOpen);
        return { id: issue.id, status: resolved ? 'resolved' : 'open', reason: resolved ? '该业务文件已实际变更并复核。' : '原阻塞仍存在。' };
      });
      const value = { summary: 'Inert independent review fixture', issues, resolutions };
      if (mode === 'native-repair') return createProjectReviewModel({ config: { baseUrl: 'https://native-review.synthetic.invalid/v1', model: 'native-local-review', apiKey: '', thinking: undefined, jsonMode: true }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...value, issues: value.issues.map(({ evidence, ...issue }) => issue) }) } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })) })(input);
      await input.onReceipt({ model: 'inert-review', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 }, content: JSON.stringify(value) }); return value;
    };
    const handle = startPlannedTaskExecution({ outputDir, binding, task: { title: 'Integration rework fixture', tasks }, manifest, provider, reviewer, maxCalls: limit, maxReviewCalls: limit, timeoutMs: 90000, assertCurrent: () => live,
      onEvent: event => { if (mode === 'stale' && event.type === 'integration_rework') live = false; } });
    return { record: await handle.done, manifest, code, reviews, outputDir };
  }
  test('failed final returns exact owner, preserves both task histories, and fully rechecks new integration', async () => {
    const { record, manifest, code } = await execute();
    assert.equal(record.status, 'accepted', JSON.stringify(record.tasks.map(item => ({ id: item.id, status: item.status, error: item.record?.error }))));
    assert.deepEqual(code, ['BASE', 'FINAL', 'BASE', 'FINAL']); assert.equal(record.reworks.length, 1); assert.deepEqual(record.reworks[0].affectedTaskIds, ['BASE', 'FINAL']);
    assert.equal(record.tasks[0].history.length, 1); assert.equal(record.tasks[1].history.length, 1); assert.equal(record.tasks[1].history[0].errorCode, 'integration_rework_required');
    assert.equal(record.tasks[0].baseCommit, record.reworks[0].failedCandidateCommit); assert.notEqual(record.tasks[0].attemptId, record.tasks[0].history[0].attemptId);
    assert.equal(record.totalModelCalls, 8); assert.deepEqual(record.usage, { inputTokens: 20, outputTokens: 28 }); assert.equal(record.modelCalls.length, 8);
    assert.equal(new Set(record.modelCalls.map(call => call.id)).size, 8); assert.equal(record.transaction.budget.committed.calls, 8); assert.equal(record.transaction.budget.unknown, 0);
    assert.equal(record.transactionEvents.filter(event => event.type === 'tasks_reopened').length, 1);
    assert.equal(record.integration.versions.at(-1).acceptance.review.openBlockingIssues, 0); assert.equal(isPlannedTaskRunAccepted(record, manifest), true); assert.equal(isPlannedTaskRunAccepted(structuredClone(record), manifest), false);
    assert.equal(record.tasks[0].record.budget.maxCalls, 2); assert.equal(record.tasks[1].record.budget.maxReviewCalls, 2);
  });
  test('remaining original task budget cannot reset when final requests upstream repair', async () => {
    const { record, code } = await execute('repair', 1); assert.equal(record.status, 'failed'); assert.deepEqual(code, ['BASE', 'FINAL']); assert.equal(record.totalModelCalls, 4); assert.equal(record.reworks.length, 0);
    assert.equal(record.transaction.budget.committed.calls, 4); assert.equal(record.attempts.length, 2); assert.equal(record.terminationConfirmed, true);
  });
  test('native wire v2 blocking opinions retain their fixed source evidence through exact upstream rework', async () => {
    const { record, manifest, code } = await execute('native-repair');
    assert.equal(record.status, 'accepted'); assert.equal(isPlannedTaskRunAccepted(record, manifest), true); assert.deepEqual(code, ['BASE', 'FINAL', 'BASE', 'FINAL']);
    assert.equal(record.totalModelCalls, 8); assert.equal(record.reworks.length, 1); const prior = record.tasks.find(t => t.id === 'FINAL').history[0];
    assert.equal(prior.versions.at(-1).acceptance.review.evidenceOrigin, 'controller_fixed_source_line'); assert.equal(prior.versions.at(-1).acceptance.review.openBlockingIssues, 1);
    assert.equal(prior.modelCalls.find(c => c.role === 'review').reviewWireVersion, 2); assert.equal(record.integration.versions.at(-1).acceptance.review.openBlockingIssues, 0);
  });
  test('a non-stop final Review stops the original graph and retains owned source and fees for explicit intervention', async () => {
    const { record, manifest, code, outputDir } = await execute('truncated-history');
    assert.equal(record.status, 'failed'); assert.equal(isPlannedTaskRunAccepted(record, manifest), false); assert.deepEqual(code, ['BASE', 'FINAL']);assert.equal(record.reworks.length, 0);
    assert.equal(record.totalModelCalls, 4);assert.deepEqual(record.usage,{inputTokens:10,outputTokens:4106});assert.equal(record.transaction.budget.committed.calls,4);assert.equal(record.transaction.budget.unknown,0);
    const original=record.tasks.find(t=>t.id==='FINAL').record,failed=original.modelCalls.find(call=>call.finishReason==='length');assert.equal(original.versions.length,1);assert.equal(failed.usage.outputTokens,4096);assert.equal(failed.terminationConfirmed,true);
    const source=await inspectPlannedSource({rootDir:outputDir,reportPath:original.reportPath,binding,writablePaths:tasks.flatMap(t=>t.writePaths),expectedRecord:original});
    assert.ok(assertPlannedSource(source,binding,tasks.flatMap(t=>t.writePaths)).provenance.sourceModelReceiptHashes.includes(failed.receiptHash));
  });
  test('a reduced reservation allows a repair that exactly fits the original total quota', async () => {
    const { record, manifest } = await execute('repair', 2);
    assert.equal(record.status, 'accepted'); assert.equal(isPlannedTaskRunAccepted(record, manifest), true);
    assert.equal(record.totalModelCalls, 8); assert.equal(record.budget.maxModelCalls, 8); assert.equal(record.transaction.budget.available.calls, 0);
    assert.equal(record.tasks[0].record.budget.maxCalls, 1); assert.equal(record.tasks[1].record.budget.maxReviewCalls, 1);
  });
  test('one rework round is bounded and a repeated independent blocker still denies delivery', async () => {
    const { record, code, manifest } = await execute('repeat'); assert.equal(record.status, 'failed'); assert.deepEqual(code, ['BASE', 'FINAL', 'BASE', 'FINAL']); assert.equal(record.reworks.length, 1);
    assert.equal(record.totalModelCalls, 8); assert.equal(isPlannedTaskRunAccepted(record, manifest), false); assert.equal(record.tasks[1].record.errorCode, 'integration_rework_required');
    const [original] = record.tasks[1].history[0].versions.at(-1).acceptance.issues;
    const review = record.tasks[1].record.versions.at(-1).acceptance.review;
    assert.deepEqual(review.issues, []);
    assert.deepEqual(review.resolutions.map(({ id, status }) => [id, status]), [[original.id, 'open']]);
  });
  test('revocation at the integration handoff cannot schedule a repair', async () => {
    const { record, code } = await execute('stale'); assert.equal(record.status, 'failed'); assert.deepEqual(code, ['BASE', 'FINAL']); assert.equal(record.reworks.length, 0);
  });
  test('mixed integration and upstream blockers remain complete and do not dispatch an unsupported repair', async () => {
    const { record, code } = await execute('mixed'); assert.equal(record.status, 'failed'); assert.deepEqual(code, ['BASE', 'FINAL']);
    assert.equal(record.reworks.length, 0); assert.equal(record.totalModelCalls, 4);
    const issues = record.tasks[1].record.versions.at(-1).acceptance.issues;
    assert.deepEqual(issues.filter(issue => issue.severity === 'blocking' && issue.status === 'open').map(issue => issue.file).sort(), ['docs/integration.md', 'src/app.mjs']);
  });
  test('mixed upstream and current-owner blockers remain intact without automatic repair dispatch', async () => {
    const { record, code } = await execute('mixed'); assert.equal(record.status, 'failed'); assert.deepEqual(code, ['BASE', 'FINAL']);
    assert.equal(record.reworks.length, 0); assert.equal(record.totalModelCalls, 4); assert.equal(record.tasks[1].record.versions.at(-1).acceptance.issues.filter(issue => issue.severity === 'blocking' && issue.status === 'open').length, 2);
  });
  test('unknown review completion holds graph and cannot become an upstream repair', async () => {
    const { record, code } = await execute('unknown'); assert.equal(record.status, 'reconciliation_required'); assert.deepEqual(code, ['BASE', 'FINAL']); assert.equal(record.reworks.length, 0); assert.equal(record.terminationConfirmed, false); assert.equal(record.usage.inputTokens, null);
  });
}
