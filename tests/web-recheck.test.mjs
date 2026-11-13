import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { applyProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';
import { installWebShell } from '../lib/web-delivery.mjs';
import { runProcess, minimalEnv } from '../lib/managed-process.mjs';
import { webProfile } from '../lib/web-profile.mjs';
import { databaseObserverHash, webManifest } from '../lib/web-tests.mjs';
import { browserManifest } from '../lib/web-browser-tests.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fixtureFiles = [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:500,headers:{},body:"deliberately incomplete candidate"}}}}\n' }];
const fileName = fileURLToPath(import.meta.url);
const moduleUrl = name => new URL(`../lib/${name}.mjs`, import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskflow-recheck-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  const directory = await mkdtemp(path.join(root, 'web-execution-')), workspace = path.join(directory, 'workspace');
  await mkdir(workspace); await applyProjectFiles({ workspace, files: fixtureFiles });
  const shellHash = (await installWebShell({ workspace })).hash;
  await mkdir(path.join(workspace, '.platform')); await writeFile(path.join(workspace, '.platform/gitconfig'), '');
  async function git(args) {
    const result = await runProcess('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspace, timeoutMs: 10000, env: { ...minimalEnv({ PATH: process.env.PATH || '' }),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform/gitconfig'), GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Trusted recheck test', GIT_AUTHOR_EMAIL: 'recheck-test@invalid', GIT_COMMITTER_NAME: 'Trusted recheck test', GIT_COMMITTER_EMAIL: 'recheck-test@invalid' },
    });
    assert.equal(result.exitCode, 0, result.stderr); return result.stdout.trim();
  }
  await git(['init', '-q']); await git(['add', '.']); await git(['commit', '-qm', 'trusted incomplete source fixture']);
  const commit = await git(['rev-parse', 'HEAD']), sourceHash = hash(validateProjectFiles(fixtureFiles));
  const receiptPath = path.join(directory, 'model-coding-1.json');
  // This synthetic controller history tests admission only. It is never claimed
  // to be genuine generated business software or a successful business fixture.
  const receipt = { model: 'trusted-test-only', finishReason: 'stop', usage: { inputTokens: 22, outputTokens: 33 }, content: JSON.stringify({ files: fixtureFiles }) };
  const receiptText = JSON.stringify(receipt, null, 2); await writeFile(receiptPath, receiptText);
  const sourceReportPath = path.join(directory, 'execution.json');
  const source = { id: 'source-execution', projectId: 'source-project', runId: 'source-run', taskId: webProfile.id, profileId: webProfile.id,
    providerKind: 'model', reviewerKind: 'model', status: 'failed', acceptanceStatus: 'error', finishedAt: '2026-01-01T00:00:00.000Z',
    specRevision: hash(webProfile.task), planRevision: '1'.repeat(64), workspace, reportPath: sourceReportPath, shellHash, calls: 1, reviewCalls: 1,
    totalModelCalls: 2, usage: { inputTokens: 44, outputTokens: 66 }, candidateCommit: commit, baseCommit: commit,
    modelCalls: [{ role: 'coding', kind: 'model', attempt: 1, model: receipt.model, usage: receipt.usage, receiptPath, receiptHash: hash(receiptText) }],
    versions: [{ attempt: 1, commit, sourceHash, selfCheck: { status: 'failed', terminationConfirmed: true,
      processes: [{ pid: 12345, terminationConfirmed: true }] }, acceptance: null }], gitCommands: [] };
  const saveSource = async () => writeFile(sourceReportPath, JSON.stringify(source, null, 2));
  await saveSource();
  return { root, directory, workspace, sourceReportPath, source, receiptPath, commit, sourceHash, git, saveSource };
}

async function child(args, options = {}) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { processChild.kill(); reject(new Error('trusted test child did not settle')); }, 30000);
    processChild.stdout.on('data', value => { stdout += value; if (stdout.length > 4 * 1024 * 1024) processChild.kill(); });
    processChild.stderr.on('data', value => { stderr += value; });
    processChild.once('error', reject); processChild.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function mockRun(f, mode, extra = {}) {
  const output = await child(['--experimental-test-module-mocks', fileName, '--trusted-mock-child', JSON.stringify({ executionRoot: f.root, sourceReportPath: f.sourceReportPath, mode, ...extra })]);
  assert.equal(output.code, 0, output.stderr + output.stdout); return JSON.parse(output.stdout);
}

async function mockChild(config) {
  const { mode } = config, counts = { http: 0, browser: 0, review: 0 }, controller = new AbortController(); let lateReceipt = false, timeout;
  const clean = () => ({ pid: 54321, status: 'stopped', exitCode: 0, terminationConfirmed: true, stopAcknowledged: true, sourceUnchanged: true });
  const http = files => ({ status: 'passed', profileId: webProfile.id, sourceHash: hash(validateProjectFiles(files)), manifestHash: webManifest.hash,
    terminationConfirmed: true, checks: webManifest.checks.map(item => ({ ...item, passed: true })), processes: [clean(), clean()], databasePreflights: [],
    databaseCommands: [1, 2].map(() => ({ kind: 'database_observation', runnerHash: databaseObserverHash, sourceHash: hash(validateProjectFiles(files)), exitCode: 0, terminationConfirmed: true, stopReason: null, truncated: false })) });
  const browser = files => ({ status: 'passed', profileId: webProfile.id, sourceHash: hash(validateProjectFiles(files)), manifestHash: browserManifest.hash,
    terminationConfirmed: true, checks: browserManifest.checks.map(item => ({ ...item, passed: true })), browser: { closed: true, version: '130.0.1.2' },
    processes: [clean(), clean(), { ...clean(), kind: 'browser' }] });
  mock.module(moduleUrl('windows-sandbox'), { namedExports: { createWindowsSandbox: () => ({ preflight: async () => {
    if (mode === 'preflight') throw Object.assign(new Error('trusted probe not confirmed'), { reconciliationRequired: true, probeDirectory: config.executionRoot + '/probe', result: { pid: 98765, startedAt: '2026-01-01T00:00:00.000Z', terminationConfirmed: false, controlDirectory: config.executionRoot + '/control' } });
    return { kind: 'trusted-test-only' };
  } }) } });
  mock.module(moduleUrl('web-tests'), { namedExports: { webManifest, databaseObserverHash, runWebTests: async ({ files, rootDir, signal }) => {
    counts.http++; const result = http(files);
    if (mode === 'http-throws-unknown' && counts.http === 2) throw Object.assign(new Error('trusted unexpected stop result'), { reconciliationRequired: true, result: { pid: 98766, terminationConfirmed: false, controlDirectory: config.executionRoot + '/branch-control' } });
    if (mode === 'self-failure' || mode === 'self-unknown' || mode === 'http-failure' && counts.http === 2) { result.status = 'failed'; result.checks[0].passed = false; }
    if (mode === 'self-unknown' || mode === 'http-unknown' && counts.http === 2) { result.status = 'reconciliation_required'; result.terminationConfirmed = false; result.processes[0].terminationConfirmed = false; }
    if (mode === 'missing-db' && counts.http === 2) result.databaseCommands.pop();
    if (mode === 'tamper-source' && counts.http === 2) await writeFile(config.sourceReportPath, (await readFile(config.sourceReportPath, 'utf8')) + ' ');
    if (mode === 'tamper-snapshot' && counts.http === 2) await writeFile(path.join(rootDir, 'workspace/src/app.mjs'), fixtureFiles[0].content + '// changed\n');
    if (counts.http === 2 && mode === 'cancel-runtime') { controller.abort(); await sleep(20); result.status = 'cancelled'; assert.equal(signal.aborted, true); }
    return result;
  } } });
  mock.module(moduleUrl('web-browser-tests'), { namedExports: { browserManifest, runWebBrowserTests: async ({ files }) => {
    counts.browser++; if (mode === 'http-failure') await sleep(80); const result = browser(files);
    if (mode === 'browser-incomplete') result.checks.pop(); return result;
  } } });
  const { startWebRecheck } = await import(moduleUrl('web-recheck'));
  const { isWebTaskAccepted } = await import(moduleUrl('web-executor'));
  const reviewer = async ({ onReceipt, previousIssues }) => {
    counts.review++;
    if (mode === 'cancel-review' || mode === 'late-receipt') {
      timeout = setTimeout(() => controller.abort(), 20);
      if (mode === 'late-receipt') { await sleep(150); lateReceipt = true; try { await onReceipt({ model: 'trusted-review-test', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 11 }, content: '{}' }); } catch {} }
      return new Promise(() => {});
    }
    const raw = { summary: 'Trusted controller protocol fixture, not business acceptance evidence', issues: [], resolutions: previousIssues.map(issue => ({ id: issue.id, status: 'resolved', reason: 'trusted protocol test only' })) };
    if (mode === 'blocking') raw.issues.push({ severity: 'blocking', file: 'src/app.mjs', line: 1, evidence: fixtureFiles[0].content.trim(), message: 'deliberately incomplete candidate' });
    if (mode === 'previous-open') raw.resolutions.forEach(item => { item.status = 'open'; });
    if (mode === 'previous-missing') raw.resolutions = [];
    if (mode === 'format' && counts.review === 1) raw.issues.push({ severity: 'advisory', file: 'src/app.mjs', line: 999, evidence: 'wrong', message: 'wrong evidence' });
    if (mode !== 'no-receipt' && mode !== 'diagnostic') await onReceipt({ model: 'trusted-review-test', finishReason: mode === 'length' ? 'length' : mode === 'bad-enum' ? 'not-real' : 'stop',
      usage: mode === 'unknown-usage' ? { inputTokens: null, outputTokens: null } : { inputTokens: 7, outputTokens: 11 }, content: JSON.stringify(mode === 'mismatched-receipt' ? { ...raw, summary: 'a different response' } : raw) });
    if (mode === 'http-failure') await sleep(40);
    return raw;
  };
  const execution = startWebRecheck({ executionRoot: config.executionRoot, sourceReportPath: config.sourceReportPath, reviewer,
    reviewerKind: mode === 'diagnostic' ? 'diagnostic' : 'model', signal: controller.signal, timeoutMs: config.timeoutMs ?? 15000, maxReviewCalls: config.maxReviewCalls ?? 2,
    assertCurrent: async () => { if (mode === 'changed-binding' && counts.http >= 2) throw new Error('trusted binding changed'); } });
  const record = await execution.done; clearTimeout(timeout);
  const before = record.reportPath ? await readFile(record.reportPath, 'utf8') : null;
  if (mode === 'late-receipt') await sleep(250);
  const unchanged = !before || before === await readFile(record.reportPath, 'utf8');
  process.stdout.write(JSON.stringify({ record, counts, accepted: isWebTaskAccepted(record), lateReceipt, unchanged }));
}

if (process.argv[2] === '--trusted-mock-child') {
  await mockChild(JSON.parse(process.argv[3]));
} else {
  test('read-only inspection validates same Git tree, genuine-history receipt structure and frozen source, without writes', async t => {
    const f = await fixture(t), { inspectWebRecheckSource } = await import(moduleUrl('web-recheck'));
    const original = await readFile(f.sourceReportPath), index = await readFile(path.join(f.workspace, '.git/index'));
    const inspected = await inspectWebRecheckSource({ executionRoot: f.root, sourceReportPath: f.sourceReportPath });
    assert.equal(inspected.summary.sourceCommit, f.commit); assert.equal(inspected.summary.sourceHash, f.sourceHash);
    assert.equal(inspected.summary.sourceCodingCalls, 1); assert.equal(inspected.summary.sourceModelCalls, 2);
    assert.deepEqual(inspected.files, fixtureFiles); assert.equal(inspected.source.status, 'failed');
    assert.deepEqual(await readFile(f.sourceReportPath), original); assert.deepEqual(await readFile(path.join(f.workspace, '.git/index')), index);
    assert.deepEqual(await readdir(f.root), [path.basename(f.directory)]);
  });

  test('admission rejects outside/raw/recheck sources, dirty trees, stale spec, receipts and protected shell changes', async t => {
    const f = await fixture(t), { inspectWebRecheckSource } = await import(moduleUrl('web-recheck'));
    const inspect = changes => inspectWebRecheckSource({ executionRoot: f.root, sourceReportPath: f.sourceReportPath, ...changes });
    await assert.rejects(inspect({ executionRoot: f.workspace }));
    await assert.rejects(inspect({ sourceReportPath: path.join(os.tmpdir(), 'execution.json') }));
    await assert.rejects(inspect({ sourceReportPath: f.source }));
    for (const [key, value] of [['providerKind', 'trusted_fixture'], ['calls', 0], ['specRevision', 'a'.repeat(64)], ['workspace', path.join(f.root, 'other')], ['candidateCommit', 'a'.repeat(40)], ['status', 'reconciliation_required']]) {
      const previous = f.source[key]; f.source[key] = value; await f.saveSource(); await assert.rejects(inspect(), key); f.source[key] = previous;
    }
    await f.saveSource();
    const receipt = await readFile(f.receiptPath); await writeFile(f.receiptPath, '{}'); await assert.rejects(inspect(), /回执/); await writeFile(f.receiptPath, receipt);
    await writeFile(path.join(f.workspace, 'src/app.mjs'), fixtureFiles[0].content + '// dirty'); await assert.rejects(inspect());
    await writeFile(path.join(f.workspace, 'src/app.mjs'), fixtureFiles[0].content);
    const server = path.join(f.workspace, 'server.mjs'), original = await readFile(server); await writeFile(server, '// changed shell'); await assert.rejects(inspect()); await writeFile(server, original);
    assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('web-recheck-')), []);
  });

  test('source report, receipt and workspace links/hardlinks are rejected', async t => {
    const f = await fixture(t), { inspectWebRecheckSource } = await import(moduleUrl('web-recheck'));
    const inspect = (root, report) => inspectWebRecheckSource({ executionRoot: root, sourceReportPath: report });
    const alias = path.join(f.root, 'alias'); await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspect(f.root, path.join(alias, 'execution.json')));
    const hard = path.join(f.root, 'source-hardlink'); await link(f.sourceReportPath, hard); await assert.rejects(inspect(f.root, f.sourceReportPath)); await rm(hard);
    const receiptHard = path.join(f.root, 'receipt-hardlink'); await link(f.receiptPath, receiptHard); await assert.rejects(inspect(f.root, f.sourceReportPath)); await rm(receiptHard);
    await link(path.join(f.workspace, 'src/app.mjs'), path.join(f.workspace, 'src/alias.mjs')); await assert.rejects(inspect(f.root, f.sourceReportPath));
  });

  test('new protocol result uses exact old commit, new attempt/current bindings, fresh checks and zero coding calls', async t => {
    const f = await fixture(t), original = await readFile(f.sourceReportPath), result = await mockRun(f, 'normal');
    const { record, counts } = result, version = record.versions[0], gate = version.acceptance;
    assert.equal(result.accepted, true); assert.equal(record.status, 'accepted'); assert.deepEqual(counts, { http: 2, browser: 1, review: 1 });
    assert.equal(record.calls, 0); assert.equal(record.reviewCalls, 1); assert.equal(record.totalModelCalls, 1); assert.equal(record.modelCalls[0].role, 'review');
    assert.equal(record.candidateCommit, f.commit); assert.equal(version.commit, f.commit); assert.equal(version.sourceHash, f.sourceHash);
    assert.notEqual(record.id, f.source.id); assert.notEqual(record.attemptId, f.source.attemptId); assert.notEqual(record.workspace, f.workspace);
    assert.equal(record.provenance.sourceWorkspace, f.workspace); assert.equal(record.provenance.sourceReport, f.sourceReportPath);
    assert.deepEqual(record.provenance.sourceUsage, f.source.usage); assert.equal(record.provenance.sourceCodingCalls, 1);
    assert.deepEqual(record.usage, { inputTokens: 7, outputTokens: 11 }); assert.equal(record.modelCalls[0].finishReason, 'stop');
    for (const branch of [gate.test, gate.browser, gate.review]) assert.deepEqual(branch.binding, gate.binding);
    assert.equal(gate.binding.attemptId, record.attemptId); assert.equal(gate.binding.manifestHash, webManifest.hash); assert.equal(gate.binding.browserManifestHash, browserManifest.hash);
    const names = await readdir(record.workspace); assert.ok(!names.includes('.git')); assert.ok(names.includes('server.mjs'));
    assert.deepEqual(await readFile(f.sourceReportPath), original); assert.equal(await f.git(['rev-parse', 'HEAD']), f.commit); assert.equal(await f.git(['status', '--porcelain']), '');
    const receiptText = await readFile(record.modelCalls[0].receiptPath); assert.equal(hash(receiptText), record.modelCalls[0].receiptHash);
    assert.deepEqual(Object.keys(JSON.parse(receiptText)).sort(), ['content', 'finishReason', 'model', 'usage']);
  });

  test('old passed results cannot replace failed fresh self-check; unknown stop forbids downstream', async t => {
    for (const mode of ['self-failure', 'self-unknown']) {
      const f = await fixture(t); f.source.status = 'accepted'; f.source.versions[0].selfCheck.status = 'passed'; await f.saveSource();
      const result = await mockRun(f, mode); assert.equal(result.accepted, false); assert.deepEqual(result.counts, { http: 1, browser: 0, review: 0 });
      assert.equal(result.record.calls, 0); assert.equal(result.record.reviewCalls, 0); assert.equal(result.record.versions[0].acceptance, null);
      assert.equal(result.record.status, mode === 'self-unknown' ? 'reconciliation_required' : 'failed');
    }
  });

  test('all independent branches settle; failed HTTP, incomplete browser, missing DB and unknown stop fail closed', async t => {
    for (const mode of ['http-failure', 'browser-incomplete', 'missing-db', 'http-unknown', 'http-throws-unknown']) {
      const f = await fixture(t), { record, accepted, counts } = await mockRun(f, mode);
      assert.equal(accepted, false, mode);
      if (mode.includes('unknown')) { assert.equal(counts.http, 2); assert.ok(counts.browser <= 1); assert.ok(counts.review <= 1); }
      else assert.deepEqual(counts, { http: 2, browser: 1, review: 1 });
      assert.ok(record.versions[0].acceptance.test); assert.ok(record.versions[0].acceptance.browser);
      if (!mode.includes('unknown')) assert.equal(record.versions[0].acceptance.review.status, 'completed');
      assert.equal(record.status, mode.includes('unknown') ? 'reconciliation_required' : 'failed');
      if (mode === 'http-throws-unknown') assert.equal(record.versions[0].acceptance.test.failure.result.pid, 98766);
    }
  });

  test('invalid Review line evidence gets at most one same-candidate recheck and records both true usages', async t => {
    const f = await fixture(t), { record, accepted } = await mockRun(f, 'format');
    assert.equal(accepted, true); assert.equal(record.calls, 0); assert.equal(record.reviewCalls, 2); assert.equal(record.versions.length, 1);
    assert.equal(record.formatFailures.length, 1); assert.equal(record.candidateCommit, f.commit); assert.deepEqual(record.usage, { inputTokens: 14, outputTokens: 22 });
    assert.equal(new Set(record.modelCalls.map(item => item.receiptPath)).size, 2);
    const limited = await mockRun(f, 'format', { maxReviewCalls: 1 }); assert.equal(limited.accepted, false); assert.equal(limited.record.reviewCalls, 1);
  });

  test('missing/abnormal/invalid receipts cannot pass or retry; unknown usage remains null; diagnostic is never accepted', async t => {
    for (const mode of ['no-receipt', 'length', 'bad-enum', 'mismatched-receipt']) {
      const f = await fixture(t), result = await mockRun(f, mode);
      assert.equal(result.accepted, false); assert.equal(result.record.reviewCalls, 1); assert.equal(result.record.versions[0].acceptance.review.status, 'error');
    }
    const f = await fixture(t), unknown = await mockRun(f, 'unknown-usage'), diagnostic = await mockRun(f, 'diagnostic');
    assert.equal(unknown.accepted, true); assert.deepEqual(unknown.record.usage, { inputTokens: null, outputTokens: null });
    assert.equal(diagnostic.accepted, false); assert.equal(diagnostic.record.status, 'diagnostic_passed'); assert.equal(diagnostic.record.totalModelCalls, 0);
  });

  test('new blocking issues reject; legitimate previous issues need explicit matching resolutions', async t => {
    const f = await fixture(t), blocking = await mockRun(f, 'blocking');
    assert.equal(blocking.accepted, false); assert.equal(blocking.record.versions[0].acceptance.openIssues.length, 1);
    const issue = { id: 'prior-issue-1', severity: 'blocking', status: 'open', file: 'src/app.mjs', line: 1, evidence: fixtureFiles[0].content.trim(), message: 'trusted prior issue' };
    f.source.versions[0].acceptance = { review: { status: 'completed' }, openIssues: [issue] }; await f.saveSource();
    for (const mode of ['previous-open', 'previous-missing']) { const result = await mockRun(f, mode); assert.equal(result.accepted, false); }
    const resolved = await mockRun(f, 'normal'); assert.equal(resolved.accepted, true);
    assert.equal(resolved.record.versions[0].acceptance.issues[0].id, issue.id); assert.equal(resolved.record.versions[0].acceptance.issues[0].status, 'resolved');
  });

  test('stage guards reject changed source, snapshot or current binding without accepting a recorded pass', async t => {
    for (const mode of ['tamper-source', 'tamper-snapshot', 'changed-binding']) {
      const f = await fixture(t), result = await mockRun(f, mode); assert.equal(result.accepted, false, mode); assert.equal(result.record.status, 'failed'); assert.equal(result.record.calls, 0);
    }
  });

  test('initial unconfirmed preflight persists PID/control/probe evidence and starts no checks or models', async t => {
    const f = await fixture(t), { record, counts } = await mockRun(f, 'preflight');
    assert.equal(record.status, 'reconciliation_required'); assert.deepEqual(counts, { http: 0, browser: 0, review: 0 });
    assert.equal(record.environmentFailure.result.pid, 98765); assert.equal(record.environmentFailure.result.terminationConfirmed, false);
    assert.match(record.environmentFailure.probeDirectory, /probe$/u); assert.match(record.environmentFailure.result.controlDirectory, /control$/u);
    assert.equal(JSON.parse(await readFile(record.reportPath, 'utf8')).environmentFailure.result.pid, 98765);
  });

  test('cancelled noncooperative Review cannot hold completion or publish a late receipt', async t => {
    for (const mode of ['cancel-review', 'late-receipt']) {
      const f = await fixture(t), { record, counts, unchanged, lateReceipt } = await mockRun(f, mode);
      assert.equal(record.status, 'stopped'); assert.equal(record.calls, 0); assert.equal(counts.review, 1); assert.equal(unchanged, true);
      assert.deepEqual(record.usage, { inputTokens: null, outputTokens: null }); assert.equal(record.modelCalls[0].receiptPath, undefined);
      assert.equal(lateReceipt, mode === 'late-receipt'); assert.deepEqual((await readdir(path.dirname(record.reportPath))).filter(name => name.startsWith('model-')), []);
    }
  });

  test('configuration, pre-abort and total budget stop before any coding, and invalid source makes no snapshot', async t => {
    const f = await fixture(t), { startWebRecheck } = await import(moduleUrl('web-recheck'));
    const options = { executionRoot: f.root, sourceReportPath: f.sourceReportPath, reviewer: async () => assert.fail('no call') };
    for (const change of [{ executionRoot: '.' }, { reviewer: null }, { signal: {} }, { timeoutMs: 600001 }, { maxReviewCalls: 3 }, { reviewerKind: 'fixture' }]) assert.throws(() => startWebRecheck({ ...options, ...change }));
    const controller = new AbortController(); controller.abort(); const stopped = await startWebRecheck({ ...options, signal: controller.signal }).done;
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.calls, 0); assert.equal(stopped.reportPath, undefined);
    const expired = await mockRun(f, 'normal', { timeoutMs: 1 }); assert.equal(expired.record.status, 'timed_out'); assert.equal(expired.record.calls, 0); assert.equal(expired.accepted, false);
  });

  test('CLI defaults to read-only inspection and requires both explicit live flags', async t => {
    const f = await fixture(t), script = fileURLToPath(new URL('../scripts/recheck-web.mjs', import.meta.url));
    const args = [script, '--record', f.sourceReportPath, '--execution-root', f.root];
    const inspected = await child(args); assert.equal(inspected.code, 0, inspected.stderr); const value = JSON.parse(inspected.stdout);
    assert.equal(value.mode, 'inspect'); assert.equal(value.reviewCallsThisInspection, 0); assert.equal(value.provenance.sourceCommit, f.commit);
    for (const flags of [['--run'], ['--model-review'], ['--surprise']]) { const failed = await child([...args, ...flags]); assert.equal(failed.code, 2); }
    assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('web-recheck-')), []);
  });

  test('real controlled recheck rejects an incomplete candidate without host execution or a new coding/Review request', { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 60000 }, async t => {
    const f = await fixture(t), original = await readFile(f.sourceReportPath), { startWebRecheck } = await import(moduleUrl('web-recheck'));
    let reviews = 0;
    const record = await startWebRecheck({ executionRoot: f.root, sourceReportPath: f.sourceReportPath, timeoutMs: 45000, reviewer: async () => { reviews++; assert.fail('bad candidate must stop before Review'); } }).done;
    assert.equal(record.status, 'failed', record.error); assert.equal(record.calls, 0); assert.equal(record.reviewCalls, 0); assert.equal(reviews, 0);
    assert.equal(record.candidateCommit, f.commit); assert.equal(record.versions[0].selfCheck.status, 'failed');
    assert.equal(record.versions[0].selfCheck.checks.length, webManifest.count); assert.equal(record.versions[0].selfCheck.terminationConfirmed, true);
    assert.ok(record.versions[0].selfCheck.checks.some(item => !item.passed)); assert.deepEqual(await readFile(f.sourceReportPath), original);
  });
}
