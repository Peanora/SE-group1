import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
