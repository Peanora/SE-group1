import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { inspectPlannedSource, assertPlannedSource } from '../lib/planned-source.mjs';
import { installWebShell } from '../lib/web-delivery.mjs';
import { applyProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';

// Real local Git objects + synthetic native receipts, never a paid model,
// generated-business execution or a claim that the fixture software is accepted.
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceHash = files => hash(validateProjectFiles(files));
const binding = { projectId: 'project', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) }, writablePaths = ['src/app.mjs'];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planned-source-test-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('planned-source-test-')); await rm(root, { recursive: true, force: true }); });
  const records = [];
  async function create({ initial, blocking = false, suffix = 'first', acceptance = true } = {}) {
    const directory = path.join(root, `planned-web-${randomUUID()}`), workspace = path.join(directory, 'workspace'); await mkdir(workspace, { recursive: true });
    const shell = await installWebShell({ workspace }); await mkdir(path.join(workspace, '.platform'), { recursive: true }); await writeFile(path.join(workspace, '.platform', 'gitconfig'), '');
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Source fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' } }).trim();
    if (initial) await applyProjectFiles({ workspace, files: initial.files });
    git(['init', '--quiet']); git(['add', '--', '.']); git(['commit', '--quiet', '-m', 'protected base']); const baseCommit = git(['rev-parse', 'HEAD']);
    const files = [{ path: 'src/app.mjs', content: `export async function createApp(){return {handle:async()=>({status:200,headers:{},body:'${suffix}'})}}\n` }];
    await applyProjectFiles({ workspace, files }); git(['add', '--', 'src/app.mjs']); git(['commit', '--quiet', '-m', 'synthetic candidate']); const commit = git(['rev-parse', 'HEAD']);
    const identity = { id: randomUUID(), ...binding, runId: `run-${suffix}`, taskId: 'whole', attemptId: randomUUID(), manifestHash: 'e'.repeat(64) }, currentHash = sourceHash(files);
    const modelCalls = [];
    async function receipt(role, content) {
      const receiptPath = path.join(directory, `model-${role}-1.json`), raw = JSON.stringify({ model: `synthetic-${role}`, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, content: JSON.stringify(content) }); await writeFile(receiptPath, raw);
      const call = { id: randomUUID(), role, kind: 'model', attempt: 1, ...Object.fromEntries(['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'manifestHash'].map(key => [key, identity[key]])), candidateCommit: role === 'review' ? commit : null, inputSourceHash: role === 'review' ? currentHash : sourceHash(initial?.files ?? []), usage: { inputTokens: 1, outputTokens: 1 }, model: `synthetic-${role}`, finishReason: 'stop', receiptConfirmed: true, receiptPath, receiptHash: hash(raw) };
      modelCalls.push(call); return call;
    }
    await receipt('coding', { files });
    const nativeIssue = { severity: 'blocking', file: 'src/app.mjs', line: 1, message: '必须修复原业务条件', evidence: files[0].content.split('\n')[0] };
    const issue = { ...nativeIssue, id: `ISSUE-${hash({ ...nativeIssue, commit }).slice(0, 20)}`, status: 'open', originCommit: commit };
    const version = { attempt: 1, commit, sourceHash: currentHash, selfCheck: { status: 'failed', checks: [{ id: 'business-check', passed: false, actual: 'synthetic failure' }] }, acceptance: null };
    if (acceptance) {
      const review = { summary: '合成Review，仅用于来源核对', issues: blocking ? [nativeIssue] : [], resolutions: [] }; await receipt('review', review);
      version.acceptance = { binding: { ...identity, candidateCommit: commit, sourceHash: currentHash }, status: blocking ? 'changes_requested' : 'error', issues: blocking ? [issue] : [], review: { ...review, status: 'completed', openBlockingIssues: blocking ? 1 : 0 } };
    }
    const parentSource = initial ? assertPlannedSource(await initial.inspect(), binding, ['src/app.mjs']) : null;
    const reportPath = path.join(directory, 'execution.json');
    const record = { ...identity, profileId: 'planned-web-v1', providerKind: 'model', reviewerKind: 'model', status: 'failed', terminationConfirmed: true, reportPath, workspace, baseCommit, candidateCommit: commit, shellHash: shell.hash, versions: [version], modelCalls, totalModelCalls: modelCalls.length,
      ...(parentSource ? { initialSource: parentSource.provenance } : {}) };
    const save = () => writeFile(reportPath, JSON.stringify(record)); await save();
    const result = { directory, workspace, files, record, reportPath, issue, git, save, inspect: extra => inspectPlannedSource({ rootDir: root, reportPath, binding, writablePaths, ...extra }) }; records.push(result); return result;
  }
  return { root, records, create };
}

test('real Git/native-receipt source creates only an immutable reuse capability, never inherited acceptance', async t => {
  const f = await fixture(t), source = await f.create({ blocking: true }), handle = await source.inspect(), data = assertPlannedSource(handle, binding, writablePaths);
  assert.deepEqual(data.files, source.files); assert.equal(data.provenance.sourceCommit, source.record.candidateCommit); assert.equal(data.provenance.sourceReportHash, hash(await readFile(source.reportPath)));
  assert.equal(data.previousIssues.length, 1); assert.equal(data.previousIssues[0].status, 'open'); assert.equal(data.previousFailures.self[0].id, 'business-check');
  assert.equal(Object.hasOwn(data, 'accepted'), false); assert.equal(Object.hasOwn(data, 'acceptance'), false); assert.ok(Object.isFrozen(data) && Object.isFrozen(data.files[0]));
  for (const fake of [structuredClone(handle), JSON.parse(JSON.stringify(handle)), { id: handle.id, kind: 'owned_planned_source' }]) assert.throws(() => assertPlannedSource(fake, binding, writablePaths));
  assert.throws(() => assertPlannedSource(handle, { ...binding, projectId: 'foreign' }, writablePaths)); assert.throws(() => assertPlannedSource(handle, binding, []));
});

test('all ancestor blocking survives a later coding-only failure without a new Review', async t => {
  const f = await fixture(t), parent = await f.create({ blocking: true }), child = await f.create({ initial: parent, acceptance: false, suffix: 'child' });
  const data = assertPlannedSource(await child.inspect(), binding, writablePaths);
  assert.deepEqual(data.previousIssues.map(issue => issue.id), [parent.issue.id]); assert.ok(data.provenance.sourceModelReceiptHashes.includes(parent.record.modelCalls[0].receiptHash));
});

test('the stored parent report fingerprint cannot be replaced by another self-consistent source claim', async t => {
  const f = await fixture(t), parent = await f.create({ blocking: true }), child = await f.create({ initial: parent, acceptance: false, suffix: 'child' });
  child.record.initialSource = { ...child.record.initialSource, sourceReportHash: '0'.repeat(64) }; await child.save(); await assert.rejects(child.inspect());
});

for (const kind of ['receipt-hash', 'receipt-path', 'commit', 'provider', 'binding', 'cycle', 'duplicate-issue']) test(`source rejects inconsistent provenance: ${kind}`, async t => {
  const f = await fixture(t), source = await f.create({ blocking: true });
  if (kind === 'receipt-hash') source.record.modelCalls[0].receiptHash = '0'.repeat(64);
  if (kind === 'receipt-path') source.record.modelCalls[0].receiptPath = path.join(f.root, 'foreign-receipt.json');
  if (kind === 'commit') source.record.candidateCommit = 'c'.repeat(40);
  if (kind === 'provider') source.record.providerKind = 'trusted_fixture';
  if (kind === 'binding') source.record.projectId = 'foreign';
  if (kind === 'cycle') source.record.initialSource = { sourceReportPath: source.reportPath };
  if (kind === 'duplicate-issue') source.record.versions[0].acceptance.issues.push({ ...source.issue, message: 'same id different obligation' });
  await source.save(); await assert.rejects(source.inspect());
});

test('source rejects a hidden dirty file even if Git status reports clean', async t => {
  const f = await fixture(t), source = await f.create(); source.git(['update-index', '--assume-unchanged', 'src/app.mjs']);
  await writeFile(path.join(source.workspace, 'src/app.mjs'), 'export const altered = true;\n'); assert.equal(source.git(['status', '--porcelain']), ''); await assert.rejects(source.inspect());
});

test('Git symlink mode cannot be hidden behind matching regular working-file bytes', async t => {
  const f = await fixture(t), source = await f.create(), blob = source.git(['rev-parse', 'HEAD:src/app.mjs']);
  source.git(['update-index', '--cacheinfo', `120000,${blob},src/app.mjs`]); source.git(['commit', '--quiet', '-m', 'synthetic forbidden symlink mode']); source.git(['update-index', '--assume-unchanged', 'src/app.mjs']);
  const commit = source.git(['rev-parse', 'HEAD']); source.record.candidateCommit = commit; source.record.versions[0].commit = commit; await source.save();
  assert.equal(source.git(['status', '--porcelain']), ''); await assert.rejects(source.inspect());
});

test('matching blobs in an unrelated orphan commit cannot replace native candidate ancestry', async t => {
  const f = await fixture(t), source = await f.create(); source.git(['checkout', '--quiet', '--orphan', 'unrelated']); source.git(['commit', '--quiet', '-m', 'unrelated candidate']);
  const commit = source.git(['rev-parse', 'HEAD']); source.record.candidateCommit = commit; source.record.versions[0].commit = commit; await source.save();
  await assert.rejects(source.inspect());
});

test('coding call identity and attempt attribution cannot be replaced by a matching receipt hash', async t => {
  const f = await fixture(t), source = await f.create(); source.record.modelCalls[0].runId = 'foreign-run'; await source.save(); await assert.rejects(source.inspect());
});

test('a duplicate coding call for one version is ambiguous and must not pick the first receipt', async t => {
  const f = await fixture(t), source = await f.create(), duplicate = structuredClone(source.record.modelCalls[0]); duplicate.id = randomUUID();
  source.record.modelCalls.push(duplicate); source.record.totalModelCalls++; await source.save(); await assert.rejects(source.inspect());
});

test('a saved blocking Review receipt cannot be erased by deleting report issue metadata', async t => {
  const f = await fixture(t), source = await f.create({ blocking: true }); source.record.versions[0].acceptance.issues = []; source.record.versions[0].acceptance.review.issues = []; source.record.versions[0].acceptance.review.openBlockingIssues = 0; await source.save();
  let handle; try { handle = await source.inspect(); } catch { return; }
  assert.ok(assertPlannedSource(handle, binding, writablePaths).previousIssues.some(issue => issue.id === source.issue.id), 'either reject inconsistent report or retain the real blocking receipt obligation');
});

test('all raw Review blockers survive when the entire acceptance metadata is unavailable', async t => {
  const f = await fixture(t), source = await f.create({ blocking: true }); source.record.versions[0].acceptance = null; await source.save();
  const data = assertPlannedSource(await source.inspect(), binding, writablePaths);
  assert.deepEqual(data.previousIssues.map(issue => issue.id), [source.issue.id]);
});

test('a confirmed Review call cannot be detached from every candidate to hide its private blocking opinion', async t => {
  const f = await fixture(t), source = await f.create({ blocking: true }); source.record.modelCalls[1].candidateCommit = 'd'.repeat(40);
  source.record.versions[0].acceptance = null; await source.save();
  let handle; try { handle = await source.inspect(); } catch { return; }
  assert.ok(assertPlannedSource(handle, binding, writablePaths).previousIssues.some(issue => issue.id === source.issue.id), 'reject the unowned confirmed Review or retain its real blocking obligation');
});

test('coding receipt inputs must describe the exact prior Git source', async t => {
  const f = await fixture(t), source = await f.create(); source.record.modelCalls[0].inputSourceHash = '0'.repeat(64);
  await source.save(); await assert.rejects(source.inspect());
});

test('the controller-owned record must exactly match the saved report and cannot execute serialization hooks', async t => {
  const f = await fixture(t), source = await f.create();
  assertPlannedSource(await source.inspect({ expectedRecord: structuredClone(source.record) }), binding, writablePaths);
  const changed = structuredClone(source.record); changed.totalModelCalls++;
  await assert.rejects(source.inspect({ expectedRecord: changed }));
  let called = 0; const getter = structuredClone(source.record); Object.defineProperty(getter, 'status', { enumerable: true, get() { called++; return 'failed'; } });
  await assert.rejects(source.inspect({ expectedRecord: getter }));
  const toJSON = structuredClone(source.record); toJSON.toJSON = () => { called++; return source.record; };
  await assert.rejects(source.inspect({ expectedRecord: toJSON })); assert.equal(called, 0);
});

test('out-of-root report, obsolete target binding, narrowed write range and cancelled inspection are refused', async t => {
  const f = await fixture(t), source = await f.create();
  await assert.rejects(source.inspect({ reportPath: path.join(path.dirname(f.root), 'outside-source.json') }));
  await assert.rejects(source.inspect({ binding: { ...binding, planRevision: 'f'.repeat(64) } })); await assert.rejects(source.inspect({ writablePaths: ['src/other.mjs'] }));
  const controller = new AbortController(); controller.abort(); await assert.rejects(source.inspect({ signal: controller.signal }));
});
