import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { startWebExecution, isWebTaskAccepted } from '../lib/web-executor.mjs';
import { webProfile } from '../lib/web-profile.mjs';
import { databaseObserverHash, webManifest } from '../lib/web-tests.mjs';
import { browserManifest } from '../lib/web-browser-tests.mjs';
import { projectReviewPolicy } from '../lib/project-review-model.mjs';

const binding = { projectId: 'test-project', runId: 'test-run', taskId: 'whole-web-project', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const review = async () => ({ summary: 'mock Review only', issues: [], resolutions: [] });
const real = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 60_000 };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-web-executor-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function mockExecution(t, mode) {
  const directory = await fixture(t);
  const script = `
    import {mock} from 'node:test';import {readFile} from 'node:fs/promises';
    const directory=${JSON.stringify(directory)},mode=${JSON.stringify(mode)};
    mock.module(${JSON.stringify(new URL('../lib/windows-sandbox.mjs', import.meta.url).href)},{namedExports:{createWindowsSandbox:()=>({preflight:async()=>{
      if(mode==='preflight')throw Object.assign(new Error('owned probe did not stop'),{reconciliationRequired:true,
        probeDirectory:directory+'/owned-probe',result:{pid:424245,startedAt:'2026-01-01T00:00:00.000Z',terminationConfirmed:false,controlDirectory:directory+'/owned-control'}});
      return {kind:'trusted-test-only'};
    }})}});
    const {startWebExecution}=await import(${JSON.stringify(new URL('../lib/web-executor.mjs', import.meta.url).href)});
    let calls=0,abortTimer,lateReceipt=false;const controller=new AbortController();const started=Date.now();
    const execution=startWebExecution({outputDir:directory,binding:${JSON.stringify(binding)},reviewer:async()=>({}),signal:controller.signal,timeoutMs:mode==='deadline'?1500:5000,
      provider:async({onReceipt})=>{
        calls++;
        if(mode==='format'){
          await onReceipt({model:'trusted-mock',finishReason:'stop',usage:{inputTokens:10,outputTokens:20},content:'   '});
          throw Object.assign(new Error('invalid JSON'),{code:'invalid_model_response'});
        }
        if(mode==='cancel'||mode==='late-receipt')abortTimer=setTimeout(()=>controller.abort(),30);
        if(mode==='late-receipt'){
          await new Promise(resolve=>setTimeout(resolve,150));lateReceipt=true;
          await onReceipt({model:'trusted-mock',finishReason:'stop',usage:{inputTokens:10,outputTokens:20},content:'late'});
        }
        return new Promise(()=>{});
      }});
    const record=await execution.done;clearTimeout(abortTimer);
    const original=await readFile(record.reportPath,'utf8');
    if(mode==='late-receipt')await new Promise(resolve=>setTimeout(resolve,250));
    const persisted=JSON.parse(await readFile(record.reportPath,'utf8'));
    process.stdout.write(JSON.stringify({record,persisted,calls,duration:Date.now()-started,lateReceipt,unchanged:original===await readFile(record.reportPath,'utf8')}));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('trusted executor probe did not settle')); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stderr + stdout)); } } });
    child.stdin.end(script);
  });
}

test('Web execution requires exact confirmed versions, roles and finite budgets before work starts', () => {
  const options = { outputDir: path.resolve('unused-output'), binding, provider: async () => {}, reviewer: review };
  for (const change of [{ binding: {} }, { binding: { ...binding, specRevision: '' } }, { providerKind: 'fixture-as-model' },
    { reviewer: null }, { maxCalls: 0 }, { maxReviewCalls: 6 }, { timeoutMs: 600_001 }, { outputDir: '.' }]) {
    assert.throws(() => startWebExecution({ ...options, ...change }));
  }
});

test('Web execution cancelled before starting creates no workspace or model call', async t => {
  const directory = await fixture(t), controller = new AbortController(); controller.abort();
  let calls = 0;
  const execution = startWebExecution({ outputDir: directory, binding, signal: controller.signal,
    provider: async () => { calls++; }, reviewer: review });
  const result = await execution.done;
  assert.equal(result.status, 'stopped'); assert.equal(result.calls, 0); assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []); assert.equal(isWebTaskAccepted(result), false);
});

test('Web execution rejects a changed confirmed version before creating work or calling the model', async t => {
  const directory = await fixture(t);
  const execution = startWebExecution({ outputDir: directory, binding, provider: async () => assert.fail('model must not run'), reviewer: review,
    assertCurrent: async received => { assert.deepEqual(received, binding); throw new Error('版本已经改变。'); } });
  const result = await execution.done;
  assert.equal(result.status, 'failed'); assert.match(result.error, /版本/); assert.equal(result.calls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('output directory links are rejected before creating a missing child through them', async t => {
  const directory = await fixture(t), target = path.join(directory, 'target'), alias = path.join(directory, 'alias');
  await mkdir(target); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await startWebExecution({ outputDir: path.join(alias, 'must-not-exist'), binding, provider: async () => assert.fail('model must not run'), reviewer: review }).done;
  assert.equal(result.status, 'failed'); assert.deepEqual(await readdir(target), []);
});

test('initial unconfirmed preflight retains process and workspace evidence in the durable record', async t => {
  const { record, persisted, calls } = await mockExecution(t, 'preflight');
  assert.equal(record.status, 'reconciliation_required'); assert.equal(calls, 0);
  assert.equal(persisted.environmentFailure.result.pid, 424245);
  assert.equal(persisted.environmentFailure.result.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(persisted.environmentFailure.result.terminationConfirmed, false);
  assert.match(persisted.environmentFailure.result.controlDirectory, /owned-control$/u);
  assert.match(persisted.environmentFailure.probeDirectory, /owned-probe$/u);
});

test('noncooperative model callback cannot keep execution alive after cancellation or total deadline', async t => {
  for (const mode of ['cancel', 'deadline']) {
    const { record, persisted, calls, duration } = await mockExecution(t, mode);
    assert.equal(record.status, mode === 'deadline' ? 'timed_out' : 'stopped');
    assert.equal(persisted.status, record.status); assert.equal(calls, 1);
    assert.equal(record.candidateCommit, null); assert.equal(record.versions.length, 0);
    assert.equal(record.modelCalls[0].usage.inputTokens, null);
    assert.ok(duration < 7000); assert.equal(isWebTaskAccepted(record), false);
  }
});

test('malformed responses retain private receipts and known usage, with at most one bounded format correction', async t => {
  const { record, persisted, calls } = await mockExecution(t, 'format');
  assert.equal(record.status, 'failed'); assert.equal(calls, 2);
  assert.equal(record.proposalFailures.length, 2); assert.equal(record.versions.length, 0);
  assert.deepEqual(persisted.usage, { inputTokens: 20, outputTokens: 40 });
  for (const call of persisted.modelCalls) {
    assert.equal(call.blankContent, true); assert.equal(call.contentBytes, 3);
    assert.match(call.receiptHash, /^[a-f0-9]{64}$/u);
    const receipt = JSON.parse(await readFile(call.receiptPath, 'utf8'));
    assert.equal(receipt.content, '   '); assert.equal(receipt.usage.inputTokens, 10);
  }
});

test('late model receipt after cancellation cannot write evidence or mutate the durable result', async t => {
  const { record, persisted, lateReceipt, unchanged } = await mockExecution(t, 'late-receipt');
  assert.equal(record.status, 'stopped'); assert.equal(lateReceipt, true); assert.equal(unchanged, true);
  assert.equal(persisted.modelCalls[0].receiptPath, undefined);
  assert.equal(persisted.usage.inputTokens, null);
  assert.deepEqual((await readdir(path.dirname(record.reportPath))).filter(name => name.startsWith('model-')), []);
});

test('missing controlled runtime fails closed before coding and persists the failure', async t => {
  const directory = await fixture(t);
  const result = await startWebExecution({ outputDir: directory, binding, executable: '',
    provider: async () => assert.fail('no unprotected fallback'), reviewer: review }).done;
  assert.equal(result.status, 'failed'); assert.equal(result.calls, 0); assert.equal(isWebTaskAccepted(result), false);
  const persisted = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(persisted.status, 'failed'); assert.deepEqual(persisted.usage, { inputTokens: null, outputTokens: null });
});

test('real Web execution rejects model paths outside source without executing or reviewing them', real, async t => {
  const directory = await fixture(t);
  let reviewCalls = 0;
  const result = await startWebExecution({ outputDir: directory, binding, maxCalls: 1,
    provider: async () => ({ files: [{ path: '../escape.mjs', content: 'unsafe' }] }),
    reviewer: async () => { reviewCalls++; return review(); } }).done;
  assert.equal(result.status, 'failed'); assert.equal(result.calls, 1); assert.equal(result.versions.length, 0);
  assert.equal(reviewCalls, 0); assert.equal(result.candidateCommit, null); assert.equal(isWebTaskAccepted(result), false);
});

test('real incomplete Web candidate fails fixed business checks, preserves evidence and stops at repair budget', real, async t => {
  const directory = await fixture(t);
  let calls = 0, reviews = 0;
  const result = await startWebExecution({ outputDir: directory, binding, maxCalls: 1, timeoutMs: 60_000,
    provider: async () => { calls++; return { files: [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:200,headers:{"content-type":"application/json"},body:"{}"}}}}' }] }; },
    reviewer: async () => { reviews++; return review(); } }).done;
  assert.equal(result.status, 'failed'); assert.equal(calls, 1); assert.equal(reviews, 0);
  assert.match(result.candidateCommit, /^[a-f0-9]{40}$/u); assert.notEqual(result.candidateCommit, result.baseCommit);
  const check = result.versions[0].selfCheck;
  assert.equal(check.status, 'failed'); assert.equal(check.checks.length, webManifest.count);
  assert.ok(check.checks.some(item => !item.passed)); assert.equal(check.terminationConfirmed, true);
  assert.equal(result.versions[0].acceptance, null); assert.equal(isWebTaskAccepted(result), false);
  assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).candidateCommit, result.candidateCommit);
});

test('acceptance predicate rejects stale rules, mismatched branches, missing browser results and diagnostic identities', () => {
  const candidate = { ...binding, attemptId: 'attempt-1', candidateCommit: 'c'.repeat(40), sourceHash: 'd'.repeat(64),
    manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash };
  const process = { terminationConfirmed: true, sourceUnchanged: true, status: 'stopped', exitCode: 0, stopAcknowledged: true };
  const check = manifest => ({ status: 'passed', sourceHash: candidate.sourceHash, manifestHash: manifest.hash,
    checks: manifest.checks.map(item => ({ ...item, passed: true })), processes: [process], terminationConfirmed: true, binding: { ...candidate } });
  const http = { ...check(webManifest), profileId: webProfile.id, databasePreflights: [], databaseCommands: Array.from({ length: 2 }, () => ({
    kind: 'database_observation', runnerHash: databaseObserverHash, sourceHash: candidate.sourceHash, exitCode: 0, terminationConfirmed: true, stopReason: null, truncated: false,
  })) };
  const gate = { status: 'passed', binding: candidate, openIssues: [], issues: [], test: http,
    browser: { ...check(browserManifest), profileId: webProfile.id, browser: { version: 'predicate-test', closed: true },
      processes: [process, process, { kind: 'browser', terminationConfirmed: true, status: 'stopped', exitCode: 0 }] },
    review: { status: 'completed', policyHash: projectReviewPolicy.hash, openBlockingIssues: 0, issues: [], resolutions: [], binding: { ...candidate } } };
  const baseline = { ...binding, attemptId: candidate.attemptId, profileId: webProfile.id, providerKind: 'model', reviewerKind: 'model',
    status: 'accepted', acceptanceStatus: 'passed', candidateCommit: candidate.candidateCommit,
    versions: [{ commit: candidate.candidateCommit, sourceHash: candidate.sourceHash, selfCheck: structuredClone(http), acceptance: gate }] };
  assert.equal(isWebTaskAccepted(baseline), true, 'synthetic predicate contract only; no execution is asserted');
  for (const mutate of [
    record => { record.providerKind = 'trusted_fixture'; }, record => { record.reviewerKind = 'diagnostic'; },
    record => { record.specRevision = 'e'.repeat(64); }, record => { record.candidateCommit = 'e'.repeat(40); },
    record => { record.versions[0].acceptance.test.binding.candidateCommit = 'f'.repeat(40); },
    record => { record.versions[0].acceptance.binding.manifestHash = 'f'.repeat(64); },
    record => { record.versions[0].acceptance.review.policyHash = 'f'.repeat(64); },
    record => { record.versions[0].acceptance.test.checks.pop(); },
    record => { record.versions[0].acceptance.browser = null; },
    record => { record.versions[0].acceptance.browser.browser.closed = false; },
    record => { record.versions[0].acceptance.browser.checks[0].passed = false; },
    record => { record.versions[0].acceptance.test.processes[0].exitCode = 1; },
    record => { record.versions[0].acceptance.test.databaseCommands[0].runnerHash = 'f'.repeat(64); },
    record => { record.versions[0].selfCheck = null; },
    record => { record.versions[0].acceptance.review.openBlockingIssues = 1; },
    record => { record.versions[0].acceptance.openIssues.push({ id: 'not-resolved' }); },
  ]) { const record = structuredClone(baseline); mutate(record); assert.equal(isWebTaskAccepted(record), false); }
});
