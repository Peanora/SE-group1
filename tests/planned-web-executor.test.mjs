import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { inspectPlannedSource } from '../lib/planned-source.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceHash = files => hash(validateProjectFiles(files));
const binding = { projectId: 'planned-project', runId: 'planned-run', taskId: 'planned-task', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const base = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]]));
function proposal() {
  return { version: 1, id: 'resource-check', name: '资源读取', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'resource', method: 'GET', path: '/resources', assertions: [{ id: 'ok', op: 'status', value: 200 }] } }],
    browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'resources', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true }] } };
}
function loginProposal() {
  const definition = proposal();
  definition.sessions = ['member'];
  definition.steps.push(
    { id: 'api_login', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'login', session: 'member', method: 'POST', path: '/api/auth/login', body: { username: 'member', password: 'fixture' }, assertions: [{ id: 'logged_in', op: 'status', value: 200 }] } },
    { id: 'api_whoami', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'whoami', method: 'GET', path: '/api/auth/me', assertions: [{ id: 'no_session', op: 'status', value: 401 }] } },
  );
  definition.browser = { version: 1, sessions: ['visitor', 'member'], steps: [
    { id: 'login_page', session: 'visitor', op: 'goto', path: '/login.html', requirementIds: ['R1'] },
    { id: 'fill_password', session: 'visitor', op: 'fill', testId: 'login-password', value: 'fixture', requirementIds: ['R1'] },
    { id: 'login_submit', session: 'visitor', op: 'click', testId: 'login-submit', requirementIds: ['R1'] },
    { id: 'member_page', session: 'member', op: 'goto', path: '/resources.html', requirementIds: ['R1'] },
    { id: 'member_resources', session: 'member', op: 'visible', testId: 'resources', value: true, requirementIds: ['R1'] },
  ] };
  return definition;
}
function manifest(definition = proposal()) { const control = createVerificationControl(), input = { proposal: definition, requirements: ['R1'], binding: base }, approval = control.approve({ ...input, feedback: '固定联合定义' }), compiled = compileManifest({ ...input, approval }); control.beginCoding(approval); return { compiled, control, approval }; }
const task = { title: '确认资源项目', requirements: ['读取资源'], tasks: [{ id: 'implement', dependsOn: [], title: '实现资源列表', description: '实现接口与页面', requirementIds: ['R1'], writePaths: ['src/app.mjs'], inputs: ['确认规格'], outputs: ['资源接口'], acceptance: ['返回资源'] }] };

if (!process.env.TASKFLOW_PLANNED_CORE_CHILD) {
  test('planned execution independent probes keep real Git and branded manifests while mocking external verification infrastructure', () => {
    const env = { ...process.env, TASKFLOW_PLANNED_CORE_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', import.meta.filename], { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  let active;
  const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => { active.preflights++; return { kind: 'trusted-test-only-mock' }; } }) } });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, { namedExports: { runHttpScenarios: async input => {
    active.http++; const report = { status: 'passed', binding: structuredClone(input.binding), sourceHash: sourceHash(input.files), manifestHash: input.manifest.manifestHash, policyHash: input.manifest.policyHash,
      terminationConfirmed: true, processes: [{ ...stopped, pid: 101 }], checks: input.manifest.checks.map(rule => ({ id: rule.id, name: rule.name, expected: rule.name, actual: rule.name, passed: true })) };
    if (active.mode === 'missing-http-checks') report.checks = [];
    if (active.mode === 'unknown-http') { report.status = 'reconciliation_required'; report.terminationConfirmed = false; report.processes[0].terminationConfirmed = false; }
    if (active.mode === 'format-late-http' && active.http === 2) { active.httpEntered = true; await new Promise(resolve => { active.releaseHttp = resolve; }); }
    if (active.mode === 'format-plus-http-failure' && active.http === 2 || active.mode.startsWith('startup-') && active.code === 1 || active.mode === 'repeated-self-check-failure') {
      report.status = 'failed'; report.checks[0].passed = false; report.checks[0].actual = 'controlled startup failure';
      if (active.mode.startsWith('startup-')) report.startupDiagnostic = { phase: 'startup', code: active.mode === 'startup-invalid-code' ? 'untrusted-private-text' : 'sqlite_transaction_unsupported', sourceLocation: { name: active.mode === 'startup-invalid-path' ? '../private.mjs' : 'src/app.mjs', line: 1 } };
      if (active.mode === 'startup-valid') {
        const startup = report.checks.find(check => check.id === 'SYS_START');
        Object.assign(startup, { passed: false, executed: true, actual: 'SQLite 初始化不兼容' });
        Object.assign(report.processes[0], { status: 'failed', exitCode: 1, stopAcknowledged: false });
        report.status = 'error';
      }
    }
    return report;
  } } });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, { namedExports: { runBrowserScenarios: async input => {
    active.browser++; const report = { status: 'passed', binding: structuredClone(input.binding), sourceHash: sourceHash(input.files), manifestHash: input.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash,
      terminationConfirmed: true, browser: { closed: true, version: 'trusted-test-only-mock' }, coverage: 'structural_only', processes: [{ ...stopped, kind: 'runtime', pid: 201 }, { ...stopped, kind: 'runtime', pid: 202 }, { ...stopped, kind: 'browser', pid: 203 }], checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, actual: rule.expected, passed: true })) };
    if (active.mode === 'foreign-browser-commit') {
      report.binding.candidateCommit = 'f'.repeat(40);
      report.status = 'failed'; report.checks[0].passed = false; report.checks[0].actual = '不同提交的失败结果';
    }
    if (active.mode === 'duplicate-browser-check') report.checks[1] = { ...report.checks[0] };
    const loginIssue = active.mode.startsWith('missing-browser-login');
    if (loginIssue && active.browser === 1 || ['repeated-browser-failure', 'changed-browser-failure'].includes(active.mode) && active.browser <= 2) {
      report.status = 'failed';
      for (const view of ['DESKTOP', 'MOBILE']) {
        const id = `BROWSER-${view}-${loginIssue ? 'member_page' : 'resources'}`;
        const check = report.checks.find(item => item.id === id);
        check.passed = false;
        check.actual = JSON.stringify(loginIssue ? { operation: 'goto', observed: { status: 200 }, guardFailures: { console_error: 1 } }
          : { operation: 'visible', observed: { count: active.mode === 'changed-browser-failure' ? active.browser - 1 : 0, visible: false } });
      }
    }
    return report;
  } } });
  const { startPlannedWebExecution, isPlannedWebTaskAccepted } = await import('../lib/planned-web-executor.mjs');
  const { createProjectReviewModel } = await import('../lib/project-review-model.mjs');

  async function execute(t, mode = 'normal', options = {}) {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'planned-core-test-'));
    t.after(async () => { assert.equal(path.dirname(outputDir), path.resolve(os.tmpdir())); assert.ok(path.basename(outputDir).startsWith('planned-core-test-')); await rm(outputDir, { recursive: true, force: true }); });
    const loginIssue = mode.startsWith('missing-browser-login');
    const approved = manifest(loginIssue ? loginProposal() : proposal()), seen = active = { mode, preflights: 0, code: 0, review: 0, http: 0, browser: 0, previous: [], feedbacks: [], responseFeedbacks: [] };
    const executionTask = loginIssue ? { ...task, tasks: [{ ...task.tasks[0], writePaths: ['src/app.mjs', 'public/resources.js', 'public/api.js'] }] } : task;
    const provider = async input => {
      assert.deepEqual(JSON.parse(input.task).acceptedVerification.browser.steps, approved.compiled.browser.steps, 'coding receives approved exact acceptance before changing source');
      const call = ++seen.code;
      seen.feedbacks.push(input.feedback);
      const files = [{ path: mode === 'outside-write-path' ? 'src/unconfirmed.mjs' : 'src/app.mjs', content: `export async function createApp(){return {handle:async()=>({status:200,headers:{},body:'resources'})}}\n// candidate ${call} ${mode}\n` }];
      if (mode === 'missing-browser-login') files.push({ path: 'public/api.js', content: "window.api = { me: () => fetch('/api/auth/me') };\n" },
        { path: 'public/resources.js', content: "async function boot() { const reader = await window.api.me(); if (!reader.ok) location.href = '/login.html'; }\n" });
      const value = { files, summary: '生成资源接口', model: 'synthetic-code', usage: { inputTokens: 3, outputTokens: 5 } };
      if (mode !== 'no-code-receipt') await input.onReceipt({ model: value.model, finishReason: mode === 'unknown-finish-current-code' ? 'unknown' : 'stop', usage: value.usage, content: JSON.stringify(mode === 'mismatched-code-receipt' ? { ...value, files: [{ path: 'src/app.mjs', content: '// receipt differs\n' }] } : value) });
      return value;
    };
    const reviewer = async input => {
      assert.deepEqual(JSON.parse(input.task).acceptedVerification.browser.steps, approved.compiled.browser.steps, 'independent review sees acceptance criteria without execution results');
      const call = ++seen.review; seen.previous.push(structuredClone(input.previousIssues));
      seen.responseFeedbacks.push(input.responseFeedback);
      if (mode.startsWith('format-') || mode.startsWith('native-review-')) {
        const privateKey = 'synthetic-native-review-key';
        const selected = mode === 'native-review-receipt-failed' ? { ...input, onReceipt: async receipt => { await input.onReceipt(receipt); throw new Error('synthetic receipt sink failure'); } } : input;
        return createProjectReviewModel({ config: { baseUrl: 'https://review.synthetic.invalid/v1', model: 'synthetic-native-review', apiKey: privateKey, thinking: undefined, jsonMode: mode === 'native-review-local-error' ? 'invalid' : true }, fetchImpl: async () => {
          if (mode === 'native-review-unknown') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic stream disconnected')); } }));
          const body = { summary: mode === 'native-review-credential' ? privateKey : '完整合成Review', issues: [], resolutions: input.previousIssues.map(item => ({ id: item.id, status: 'resolved', reason: '当前候选复核' })) };
          const content = mode === 'format-exhausted' || mode.startsWith('format-') && call === 1 ? '{"summary":' : JSON.stringify(body);
          return new Response(JSON.stringify({ choices: [{ finish_reason: mode === 'native-review-length' ? 'length' : 'stop', message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 11 } }));
        } })(selected);
      }
      if (['blocking-history', 'duplicate-recheck', 'advisory', 'regressed-blocker'].includes(mode)) return createProjectReviewModel({ config: { baseUrl: 'https://review.synthetic.invalid/v1', model: 'synthetic-native-review', apiKey: '', thinking: undefined, jsonMode: true }, fetchImpl: async () => {
        const issue = { severity: 'blocking', file: 'src/app.mjs', line: 1, message: '需要修复原业务条件' };
        if (mode === 'advisory') issue.severity = 'advisory';
        const duplicate = mode === 'duplicate-recheck' && call > 1;
        const body = { summary: '明确native格式回归', issues: duplicate ? [issue, issue] : call === 1 ? [issue] : [],
          ...(mode === 'blocking-history' && call === 2 ? {} : { resolutions: input.previousIssues.map(item => ({ id: item.id, status: 'resolved', reason: '当前候选已核对原问题' })) }) };
        if (mode === 'regressed-blocker') {
          if (call === 1) body.issues.push({ ...issue, message: '列表未过滤归档资源' });
          else {
            const open = body.resolutions[call === 2 ? 1 : 0];
            open.status = 'open';
            open.reason = '本提交仍会返回不符合约定的资源';
          }
        }
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }], usage: { prompt_tokens: 7, completion_tokens: 11 } }));
        } })(input);
      if (['truncated-review-history', 'unknown-review-history', 'truncated-current-review'].includes(mode) && call === 1) {
        await input.onReceipt({ model: 'synthetic-review', finishReason: mode === 'unknown-review-history' ? 'unknown' : 'length', usage: { inputTokens: 13, outputTokens: 4096 }, content: '' });
        throw new Error('Review模型输出被截断。');
      }
      const issue = { severity: 'blocking', file: 'src/app.mjs', line: 1, message: '需要修复原业务条件', evidence: input.files.find(file => file.path === 'src/app.mjs').content.split('\n')[0] };
      const value = { summary: '独立审查', issues: mode === 'repeated-review-failure' && call === 1 ? [issue] : [],
        resolutions: input.previousIssues.map(item => ({ id: item.id, status: mode === 'repeated-review-failure' ? 'open' : 'resolved', reason: '当前候选已核对原问题' })),
        model: 'synthetic-review', usage: { inputTokens: 7, outputTokens: 11 } };
      if (mode !== 'no-review-receipt') await input.onReceipt({ model: value.model, finishReason: mode === 'unknown-finish-current-review' ? 'unknown' : 'stop', usage: value.usage, content: JSON.stringify(value) });
      return value;
    };
    const historyRetry = ['truncated-review-history', 'unknown-review-history'].includes(mode);
    const execution = startPlannedWebExecution({ outputDir, binding, task: executionTask, manifest: approved.compiled, provider, reviewer, assertCurrent: () => true, maxCalls: mode === 'blocking-history' ? 3 : historyRetry ? 2 : 1, maxReviewCalls: mode === 'blocking-history' ? 3 : historyRetry ? 2 : 1, timeoutMs: 10000, ...options });
    if (options.beforeDone) await options.beforeDone(seen, execution);
    const record = await execution.done;
    return { ...approved, seen, record, execution, outputDir };
  }
  test('real Git candidate preserves source blobs, exact write domain, both independent verifiers and private receipts', async t => {
    const f = await execute(t); assert.equal(f.record.status, 'accepted', JSON.stringify(f.record)); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
    assert.equal(f.seen.preflights, 1); assert.equal(f.seen.code, 1); assert.equal(f.seen.review, 1); assert.equal(f.seen.http, 2); assert.equal(f.seen.browser, 1);
    const committed = execFileSync('git', ['-C', f.record.workspace, 'show', `${f.record.candidateCommit}:src/app.mjs`], { encoding: 'utf8', windowsHide: true });
    assert.equal(sourceHash([{ path: 'src/app.mjs', content: committed }]), f.record.versions[0].sourceHash);
    for (const call of f.record.modelCalls) { const bytes = await readFile(call.receiptPath); assert.equal(createHash('sha256').update(bytes).digest('hex'), call.receiptHash); }
    assert.equal(isPlannedWebTaskAccepted(f.record, structuredClone(f.compiled)), false, 'serialized manifest cannot regain compiler branding');
  });
  test('an evidenced missing browser login requests checklist revision without another coding call', async t => {
    const f = await execute(t, 'missing-browser-login', { maxCalls: 3 });
    assert.equal(f.record.status, 'failed');
    assert.equal(f.record.errorCode, 'checklist_needs_revision');
    assert.deepEqual(f.record.failureDiagnosis, { code: 'browser_login_missing', path: '/resources.html', session: 'member', checkId: 'member_page' });
    assert.equal(f.record.versions[0].acceptance.browser.status, 'failed');
    assert.equal(f.seen.code, 1);
    assert.equal(f.seen.review, 0);
    assert.equal(f.record.events.some(event => event.type === 'automatic_rework'), false);
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false);
  });
  test('a possible missing login without candidate protection evidence still allows automatic code repair', async t => {
    const f = await execute(t, 'missing-browser-login-unproven', { maxCalls: 3 });
    assert.equal(f.record.status, 'accepted');
    assert.equal(f.seen.code, 2);
    assert.equal(f.seen.review, 1);
    assert.equal(f.record.failureDiagnosis, undefined);
  });
  test('identical browser failure evidence after rework ends the round without another code change', async t => {
    const f = await execute(t, 'repeated-browser-failure', { maxCalls: 3 });
    assert.equal(f.record.status, 'failed');
    assert.equal(f.record.errorCode, 'rework_no_progress');
    assert.equal(f.seen.code, 2);
    assert.equal(f.seen.review, 0);
    assert.equal(f.record.events.filter(event => event.type === 'automatic_rework').length, 1);
    assert.equal(f.record.events.some(event => event.cause === 'rework_no_progress'), true);
  });
  test('changed failed browser observations continue to automatically repair and verify', async t => {
    const f = await execute(t, 'changed-browser-failure', { maxCalls: 3 });
    assert.equal(f.record.status, 'accepted');
    assert.equal(f.seen.code, 3);
    assert.equal(f.seen.review, 1);
    assert.equal(f.record.events.filter(event => event.type === 'automatic_rework').length, 2);
  });
  for (const [mode, reviewCalls, cause] of [['repeated-self-check-failure', 0, 'self_check'], ['repeated-review-failure', 2, 'review']]) {
    test(`an unchanged ${cause} failure stops after one automatic correction`, async t => {
      const f = await execute(t, mode, { maxCalls: 3, maxReviewCalls: 3 });
      assert.equal(f.record.status, 'failed');
      assert.equal(f.record.errorCode, 'rework_no_progress');
      assert.equal(f.seen.code, 2);
      assert.equal(f.seen.review, reviewCalls);
      assert.deepEqual(f.record.events.filter(event => event.type === 'automatic_rework').map(event => event.cause), [cause]);
    });
  }
  test('non-stop Review stops the original execution; an explicit new repair retains charged owned history', async t => {
    const f = await execute(t, 'truncated-review-history');
    assert.equal(f.record.status, 'failed'); assert.equal(f.record.versions.length, 1); assert.equal(f.seen.code, 1); assert.equal(f.seen.review, 1);
    assert.equal(f.record.versions[0].acceptance.review.status, 'error'); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false);
    assert.equal(f.record.versions[0].acceptance.status, 'incomplete');
    assert.equal(f.record.acceptanceStatus, 'incomplete');
    assert.equal(f.record.totalModelCalls, 2); assert.deepEqual(f.record.usage, { inputTokens: 16, outputTokens: 4101 });
    const failed = f.record.modelCalls.find(call => call.role === 'review');
    assert.equal(failed.finishReason, 'length'); assert.equal(failed.requestState, 'completed'); assert.equal(failed.terminationConfirmed, true);
    const bytes = await readFile(failed.receiptPath); assert.equal(createHash('sha256').update(bytes).digest('hex'), failed.receiptHash); assert.equal(JSON.parse(bytes).content, '');
    const original = await readFile(f.record.reportPath);
    const initialSource = await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'], expectedRecord: f.record });
    const repaired = await execute(t, 'source-repair', { initialSource });
    assert.equal(isPlannedWebTaskAccepted(repaired.record, repaired.compiled), true); assert.equal(repaired.record.totalModelCalls, 2);
    assert.ok(repaired.record.initialSource.sourceModelReceiptHashes.includes(failed.receiptHash));
    assert.deepEqual(await readFile(f.record.reportPath), original); assert.deepEqual(await readFile(failed.receiptPath), bytes);
    assert.deepEqual({ inputTokens: f.record.usage.inputTokens + repaired.record.usage.inputTokens, outputTokens: f.record.usage.outputTokens + repaired.record.usage.outputTokens }, { inputTokens: 26, outputTokens: 4117 });
  });
  test('a current truncated Review remains unaccepted with its complete original receipt and charges', async t => {
    const f = await execute(t, 'truncated-current-review');
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); assert.notEqual(f.record.status, 'accepted');
    assert.equal(f.record.terminationConfirmed, true); assert.equal(f.record.modelCalls.at(-1).finishReason, 'length'); assert.equal(f.record.totalModelCalls, 2);
  });
  test('complete unknown finish stops dispatch while preserving owned source for an explicit bounded repair', async t => {
    const f = await execute(t, 'unknown-review-history');
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); assert.equal(f.seen.code, 1); assert.equal(f.seen.review, 1);
    const failed = f.record.modelCalls.find(call => call.finishReason === 'unknown');
    assert.equal(failed.requestState, 'completed'); assert.equal(failed.terminationConfirmed, true); assert.equal(f.record.totalModelCalls, 2);
    const bytes = await readFile(failed.receiptPath), original = await readFile(f.record.reportPath);
    const initialSource = await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'], expectedRecord: f.record });
    const repaired = await execute(t, 'source-repair', { initialSource }); assert.equal(isPlannedWebTaskAccepted(repaired.record, repaired.compiled), true);
    assert.ok(repaired.record.initialSource.sourceModelReceiptHashes.includes(failed.receiptHash)); assert.deepEqual(await readFile(failed.receiptPath), bytes); assert.deepEqual(await readFile(f.record.reportPath), original);
    assert.equal(f.record.totalModelCalls + repaired.record.totalModelCalls, 4); assert.equal(f.record.usage.inputTokens + repaired.record.usage.inputTokens, 26); assert.equal(f.record.usage.outputTokens + repaired.record.usage.outputTokens, 4117);
  });
  for (const mode of ['unknown-finish-current-code', 'unknown-finish-current-review']) test(`a complete non-stop current result cannot qualify code or Review: ${mode}`, async t => {
    const f = await execute(t, mode);
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); assert.notEqual(f.record.status, 'accepted');
    assert.equal(f.record.terminationConfirmed, true); assert.equal(f.record.modelCalls.at(-1).finishReason, 'unknown');
    assert.equal(f.record.modelCalls.at(-1).requestState, 'completed');
    if (mode === 'unknown-finish-current-code') { assert.equal(f.record.candidateCommit, null); assert.equal(f.seen.review, 0); }
  });
  for (const mode of ['outside-write-path', 'no-code-receipt', 'mismatched-code-receipt', 'no-review-receipt', 'missing-http-checks', 'unknown-http', 'foreign-browser-commit', 'duplicate-browser-check']) test(`planned core refuses incomplete or mismatched evidence: ${mode}`, async t => {
    const maxCalls = mode === 'outside-write-path' ? 1 : 3;
    const f = await execute(t, mode, { maxCalls }); assert.notEqual(f.record.status, 'accepted'); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false);
    assert.equal(f.seen.code, 1, 'incomplete or foreign evidence cannot spend another coding call');
    assert.ok(!f.record.events.some(event => event.type === 'automatic_rework'));
    if (['no-code-receipt', 'no-review-receipt', 'unknown-http'].includes(mode)) assert.equal(f.record.terminationConfirmed, false);
    if (mode === 'outside-write-path') { assert.equal(f.record.candidateCommit, null); assert.equal(f.seen.review, 0); }
  });
  test('one malformed Review cannot erase the complete previous blocking issue history', async t => {
    const f = await execute(t, 'blocking-history'); assert.equal(f.seen.review, 3); assert.equal(f.seen.previous[1].length, 1); assert.deepEqual(f.seen.previous[2].map(item => item.id), f.seen.previous[1].map(item => item.id));
    const [first, fixed] = f.record.versions;
    assert.equal(first.acceptance.status, 'changes_requested');
    assert.equal(first.acceptance.issues[0].status, 'open');
    assert.equal(f.record.versions.length, 2); assert.equal(f.seen.code, 2);
    const [closed] = fixed.acceptance.issues;
    assert.equal(closed.id, first.acceptance.issues[0].id);
    assert.equal(closed.originCommit, first.commit);
    assert.equal(closed.checkedCommit, fixed.commit);
    assert.equal(closed.status, 'resolved');
    assert.equal(fixed.acceptance.review.status, 'completed');
    const reviews = f.record.modelCalls.filter(call => call.role === 'review');
    assert.equal(reviews[1].candidateCommit, reviews[2].candidateCommit);
    assert.equal(reviews[1].reviewRejection.reason, 'missing_fields');
    assert.equal(f.record.status, 'accepted'); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
  });
  test('a duplicate opinion cannot close a previous blocker when the Review budget runs out', async t => {
    const f = await execute(t, 'duplicate-recheck', { maxCalls: 2, maxReviewCalls: 2 });
    const [first, recheck] = f.record.versions;
    assert.notEqual(first.commit, recheck.commit);
    assert.equal(recheck.acceptance.status, 'incomplete');
    assert.equal(recheck.acceptance.review.diagnostic.reason, 'duplicate_issue');
    assert.deepEqual(recheck.acceptance.issues, first.acceptance.issues);
    assert.equal(recheck.acceptance.issues[0].status, 'open');
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false);
    await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'], expectedRecord: f.record });
  });
  test('a source-bound advisory is retained without blocking delivery', async t => {
    const f = await execute(t, 'advisory');
    const { acceptance, commit } = f.record.versions[0];
    assert.equal(acceptance.issues[0].severity, 'advisory');
    assert.equal(acceptance.issues[0].originCommit, commit);
    assert.equal(acceptance.review.openBlockingIssues, 0);
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
  });
  test('a blocker closed on the second commit is rechecked alongside its peer on the third commit', async t => {
    const f = await execute(t, 'regressed-blocker', { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 30000 });
    const [first, second, third] = f.record.versions;
    const [a, b] = first.acceptance.issues.map(issue => issue.id);
    assert.deepEqual(second.acceptance.issues.map(issue => [issue.id, issue.status]), [[a, 'resolved'], [b, 'open']]);
    assert.deepEqual(JSON.parse(f.seen.feedbacks[2]).issues.map(issue => issue.id), [b]);
    assert.deepEqual(f.seen.previous[2].map(issue => issue.id), [a, b]);
    assert.deepEqual(third.acceptance.issues.map(issue => [issue.id, issue.status, issue.checkedCommit]),
      [[a, 'open', third.commit], [b, 'resolved', third.commit]]);
    assert.equal(third.acceptance.review.openBlockingIssues, 1);
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false);
    await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'], expectedRecord: f.record });
  });
  test('repair reuses owned source only and rechecks all historical blocking on a new candidate', async t => {
    const prior = await execute(t, 'blocking-history');
    const initialSource = await inspectPlannedSource({ rootDir: prior.outputDir, reportPath: prior.record.reportPath, binding, writablePaths: ['src/app.mjs'], expectedRecord: prior.record });
    assert.throws(() => startPlannedWebExecution({ outputDir: prior.outputDir, binding, task, manifest: prior.compiled, initialSource: structuredClone(initialSource), provider: async () => {}, reviewer: async () => {}, assertCurrent: () => true }));
    const repaired = await execute(t, 'source-repair', { initialSource });
    assert.equal(repaired.record.status, 'accepted'); assert.equal(repaired.record.initialSource.sourceCommit, prior.record.candidateCommit);
    assert.equal(repaired.seen.previous[0].length, 1, 'even a historical resolved blocker requires a fresh Review on repaired code');
    assert.notEqual(repaired.record.candidateCommit, repaired.record.baseCommit); assert.equal(repaired.seen.http, 2); assert.equal(repaired.seen.browser, 1);
    assert.equal(isPlannedWebTaskAccepted(repaired.record, repaired.compiled), true);
  });
  test('native format retry uses one fixed Git candidate, one coding call, exact primary call and unchanged independent checks', async t => {
    const f = await execute(t, 'format-retry', { maxCalls: 3, maxReviewCalls: 3 });
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true); assert.equal(f.seen.code, 1); assert.equal(f.seen.review, 2);
    assert.equal(f.record.versions.length, 1); assert.equal(f.seen.http, 2); assert.equal(f.seen.browser, 1); assert.equal(f.record.totalModelCalls, 3);
    const calls = f.record.modelCalls.filter(c => c.role === 'review'); assert.equal(calls[0].candidateCommit, calls[1].candidateCommit); assert.equal(calls[0].inputSourceHash, calls[1].inputSourceHash);
    assert.equal(calls[0].reviewRejection.reason, 'invalid_json'); assert.deepEqual(calls[1].responseFeedback, f.seen.responseFeedbacks[1]);
    assert.equal(f.record.versions[0].acceptance.review.primaryCallId, calls[1].id); assert.equal(f.record.versions[0].acceptance.review.evidenceOrigin, 'controller_fixed_source_line');
    assert.notEqual(calls[0].id, calls[1].id); assert.notEqual(calls[0].receiptPath, calls[1].receiptPath); assert.deepEqual(f.record.usage, { inputTokens: 17, outputTokens: 27 });
    assert.equal(JSON.parse(await readFile(calls[0].receiptPath, 'utf8')).content, '{"summary":');
    await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'], expectedRecord: f.record });
  });
  test('format retries wait for independent checks, then stop at the original Review call cap without another coding call', async t => {
    let release;
    const f = await execute(t, 'format-late-http', { maxCalls: 3, maxReviewCalls: 3, beforeDone: async (seen, execution) => {
      const end = Date.now() + 8000; while (!seen.httpEntered) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 5)); }
      release = seen.releaseHttp; try { await new Promise(r => setTimeout(r, 40)); assert.equal(seen.review, 0); assert.equal(execution.snapshot().modelCalls.filter(c => c.role === 'review').length, 0); } finally { release(); }
    } });
    assert.equal(f.record.status, 'accepted'); assert.equal(f.seen.code, 1); assert.equal(f.seen.review, 2);
    const exhausted = await execute(t, 'format-exhausted', { maxCalls: 3, maxReviewCalls: 3 });
    assert.equal(exhausted.record.status, 'failed'); assert.equal(exhausted.seen.code, 1); assert.equal(exhausted.seen.review, 3); assert.equal(exhausted.record.versions.length, 1);
    assert.equal(exhausted.record.totalModelCalls, 4); assert.deepEqual(exhausted.record.usage, { inputTokens: 24, outputTokens: 38 });
    assert.equal(new Set(exhausted.record.modelCalls.map(c => c.id)).size, 4); assert.ok(exhausted.record.modelCalls.filter(c => c.role === 'review').every(c => c.receiptConfirmed && c.reviewRejection && c.finishReason === 'stop'));
  });
  test('an independent HTTP failure returns to coding without spending a Review on that candidate', async t => {
    const f = await execute(t, 'format-plus-http-failure', { maxCalls: 3, maxReviewCalls: 3 });
    assert.equal(f.record.status, 'accepted'); assert.equal(f.seen.code, 2); assert.equal(f.seen.review, 2); assert.equal(f.record.versions.length, 2);
    const calls = f.record.modelCalls.filter(c => c.role === 'review'); assert.equal(calls[0].candidateCommit, f.record.versions[1].commit);
    assert.equal(calls[1].candidateCommit, calls[0].candidateCommit); assert.ok(calls[1].responseFeedback);
    assert.equal(f.record.versions[0].acceptance.review, null);
    assert.deepEqual(f.record.events.filter(event => event.type === 'automatic_rework').map(event => event.cause), ['testing']);
    const first = f.record.versions[0], feedback = JSON.parse(f.seen.feedbacks[1]);
    assert.equal(first.acceptance.test.status, 'failed'); assert.ok(feedback.test.some(c => c.passed === false));
    assert.deepEqual(feedback.failedCandidate, first.acceptance.binding);
    assert.equal(f.record.modelCalls.find(call => call.role === 'coding' && call.attempt === 2).inputSourceHash, first.sourceHash);
    await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'], expectedRecord: f.record });
  });
  for (const action of ['cancel', 'change-source']) test(`fixed candidate ${action} during testing prevents Review dispatch`, async t => {
    const f = await execute(t, 'format-late-http', { maxCalls: 3, maxReviewCalls: 3, beforeDone: async (seen, execution) => {
      const end = Date.now() + 8000;
      while (!seen.httpEntered) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 5)); }
      try {
        if (action === 'cancel') execution.cancel();
        else await writeFile(path.join(execution.snapshot().workspace, 'src/app.mjs'), '// changed outside the fixed candidate\n');
      } finally { seen.releaseHttp(); }
    } });
    assert.notEqual(f.record.status, 'accepted'); assert.equal(f.seen.code, 1); assert.equal(f.seen.review, 0); assert.equal(f.record.totalModelCalls, 1);
  });
  for (const kind of ['length', 'credential', 'unknown', 'receipt-failed', 'local-error']) test(`noneligible native Review failure cannot dispatch any subsequent model: ${kind}`, async t => {
    const f = await execute(t, `native-review-${kind}`, { maxCalls: 3, maxReviewCalls: 3 });
    assert.notEqual(f.record.status, 'accepted'); assert.equal(f.seen.code, 1); assert.equal(f.seen.review, 1); assert.equal(f.record.versions.length, 1);
    assert.equal(f.record.modelCalls.at(-1).reviewRejection, undefined);
    if (kind === 'unknown') { assert.equal(f.record.terminationConfirmed, false); assert.equal(f.record.modelCalls.at(-1).usage.inputTokens, null); }
    else assert.equal(f.record.terminationConfirmed, true);if(kind==='local-error'){assert.equal(f.record.modelCalls.at(-1).dispatched,false);assert.equal(f.record.modelCalls.at(-1).requestState,'not_dispatched');assert.deepEqual(f.record.modelCalls.at(-1).usage,{inputTokens:0,outputTokens:0});assert.equal(f.record.totalModelCalls,1);}
  });
  for (const mode of ['startup-valid', 'startup-invalid-code', 'startup-invalid-path']) test(`startup feedback uses only the controlled code and fixed source location: ${mode}`, async t => {
    const f = await execute(t, mode, { maxCalls: 2, maxReviewCalls: 2 }); assert.equal(f.record.status, 'accepted'); assert.equal(f.seen.code, 2);
    const feedback = JSON.parse(f.seen.feedbacks[1]); assert.equal(f.record.error, null);
    if (mode === 'startup-valid') assert.deepEqual(feedback.startupDiagnostic, { phase: 'startup', code: 'sqlite_transaction_unsupported', sourceLocation: { name: 'src/app.mjs', line: 1 } });
    else { assert.equal(feedback.startupDiagnostic, undefined); assert.equal(JSON.stringify(feedback).includes('untrusted-private-text'), false); assert.equal(JSON.stringify(feedback).includes('../private.mjs'), false); }
    assert.ok(feedback.checks.some(c => c.passed === false));
  });
  test('source replay rejects a prior valid blocking opinion relabeled as a format failure before a later empty Review', async t => {
    const f = await execute(t, 'format-retry', { maxCalls: 3, maxReviewCalls: 3 }), first = f.record.modelCalls.find(c => c.role === 'review'), originalReceipt = await readFile(first.receiptPath), originalReport = await readFile(f.record.reportPath);
    const oldHash = first.receiptHash, oldRejectionHash = first.reviewRejection.receiptHash;
    const forged = JSON.parse(originalReceipt); forged.content = JSON.stringify({ summary: 'A valid blocking result must survive', issues: [{ severity: 'blocking', file: 'src/app.mjs', line: 1, message: 'Real blocking obligation' }], resolutions: [] });
    try {
      const bytes = Buffer.from(JSON.stringify(forged)); await writeFile(first.receiptPath, bytes); first.receiptHash = createHash('sha256').update(bytes).digest('hex'); first.reviewRejection.receiptHash = first.receiptHash; await writeFile(f.record.reportPath, JSON.stringify(f.record));
      await assert.rejects(inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'] }));
    } finally { first.receiptHash = oldHash; first.reviewRejection.receiptHash = oldRejectionHash; await writeFile(first.receiptPath, originalReceipt); await writeFile(f.record.reportPath, originalReport); }
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true); await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'] });
  });
  for (const attack of ['receipt-bytes', 'wire-metadata', 'primary-call', 'line', 'feedback']) test(`same-candidate source proof rejects changed receipt, location or controller metadata: ${attack}`, async t => {
    const f = await execute(t, 'format-retry', { maxCalls: 3, maxReviewCalls: 3 }), first = f.record.modelCalls.find(c => c.role === 'review'), last = f.record.modelCalls.at(-1);
    const originalReport = await readFile(f.record.reportPath), originalReceipt = await readFile(first.receiptPath), saved = structuredClone(f.record);
    try {
      if (attack === 'receipt-bytes') await writeFile(first.receiptPath, Buffer.concat([originalReceipt, Buffer.from(' ')]));
      if (attack === 'wire-metadata') first.reviewWireVersion = 1;
      if (attack === 'primary-call') f.record.versions[0].acceptance.review.primaryCallId = first.id;
      if (attack === 'feedback') last.responseFeedback.field = 'issues[0].line';
      if (attack === 'line') { const receipt = JSON.parse(originalReceipt); receipt.content = JSON.stringify({ summary: 'invalid location', issues: [{ severity: 'blocking', file: 'src/app.mjs', line: 999, message: 'bad line' }], resolutions: [] }); await writeFile(first.receiptPath, JSON.stringify(receipt)); }
      await writeFile(f.record.reportPath, JSON.stringify(f.record));
      await assert.rejects(inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'] }));
    } finally { for (const key of Object.keys(f.record)) delete f.record[key]; Object.assign(f.record, saved); await writeFile(first.receiptPath, originalReceipt); await writeFile(f.record.reportPath, originalReport); }
    await inspectPlannedSource({ rootDir: f.outputDir, reportPath: f.record.reportPath, binding, writablePaths: ['src/app.mjs'] });
  });
  for (const field of ['manifestHash', 'browserPolicyHash', 'reviewPolicyHash']) test(`accepted record cannot carry a different outer ${field}`, async t => {
    const f = await execute(t); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true); const changed = structuredClone(f.record); changed[field] = 'f'.repeat(64);
    assert.equal(isPlannedWebTaskAccepted(changed, f.compiled), false);
  });
  test('accepted record rejects malformed private receipt hashes', async t => {
    const f = await execute(t); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
    const malformed = structuredClone(f.record); malformed.modelCalls[0].receiptHash = 'not-a-sha256'; assert.equal(isPlannedWebTaskAccepted(malformed, f.compiled), false);
  });
  test('accepted record rejects a private model receipt belonging to another attempt', async t => {
    const f = await execute(t); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
    const foreign = structuredClone(f.record); foreign.modelCalls[0].attemptId = 'foreign-attempt'; assert.equal(isPlannedWebTaskAccepted(foreign, f.compiled), false);
  });
  test('toJSON or accessors cannot hide changes to the original branded record', async t => {
    const f = await execute(t), clean = JSON.parse(JSON.stringify(f.record)); let invoked = 0;
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
    f.record.toJSON = () => { invoked++; return clean; }; f.record.budget.maxCalls = 999;
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); assert.equal(invoked, 0);
    delete f.record.toJSON; f.record.budget.maxCalls = clean.budget.maxCalls;
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
    Object.defineProperty(f.record, 'hiddenInput', { enumerable: true, configurable: true, get() { invoked++; return 'never read'; } });
    assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); assert.equal(invoked, 0);
  });
  test('even the original branded execution object loses acceptance when its contents are modified', async t => {
    const f = await execute(t); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), true);
    const original = f.record.manifestHash; f.record.manifestHash = 'f'.repeat(64); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); f.record.manifestHash = original;
    const receipt = f.record.modelCalls[0], receiptHash = receipt.receiptHash; receipt.receiptHash = 'not-a-sha256'; assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); receipt.receiptHash = receiptHash;
    const attempt = receipt.attemptId; receipt.attemptId = 'foreign-attempt'; assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false); receipt.attemptId = attempt;
    assert.equal(isPlannedWebTaskAccepted(JSON.parse(JSON.stringify(f.record)), f.compiled), false, 'parsed storage or a client DTO cannot recreate the private execution result brand');
  });
  test('cancellation during a noncooperative provider retains unknown status and rejects late receipts', async t => {
    let enter, release, finished; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; }), settled = new Promise(resolve => { finished = resolve; });
    const controller = new AbortController(); let lateRejected = false;
    const pending = execute(t, 'normal', { signal: controller.signal, provider: async input => {
      enter(); await held;
      const body = { files: [{ path: 'src/app.mjs', content: 'export async function createApp(){throw new Error("late")}\n' }] };
      try { await input.onReceipt({ model: 'late-synthetic-provider', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, content: JSON.stringify(body) }); }
      catch { lateRejected = true; }
      finished(); return body;
    } });
    await entered; controller.abort(); const f = await pending; assert.equal(f.record.status, 'reconciliation_required'); assert.equal(f.record.terminationConfirmed, false);
    const before = await readFile(f.record.reportPath, 'utf8'); release(); await settled; await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(lateRejected, true); assert.equal(await readFile(f.record.reportPath, 'utf8'), before); assert.equal(isPlannedWebTaskAccepted(f.record, f.compiled), false);
  });
  test('the current version gate must be synchronous and diagnostics never become accepted', async t => {
    const f = await execute(t, 'normal', { assertCurrent: async () => true }); assert.notEqual(f.record.status, 'accepted'); assert.equal(f.seen.preflights, 0); assert.equal(f.seen.code, 0);
    const g = await execute(t, 'normal', { providerKind: 'trusted_fixture', reviewerKind: 'diagnostic' }); assert.equal(g.record.status, 'diagnostic_passed'); assert.equal(isPlannedWebTaskAccepted(g.record, g.compiled), false);
  });
}
