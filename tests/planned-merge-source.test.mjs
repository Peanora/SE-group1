import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, lstat, realpath, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { inspectPlannedSource, assertPlannedSource } from '../lib/planned-source.mjs';
import { installWebShell } from '../lib/web-delivery.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';
import { minimalEnv, runProcess } from '../lib/managed-process.mjs';

const evidence = path.resolve(import.meta.dirname, '../output/full-goal-20261118/merge-source-author');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceHash = value => hash(validateProjectFiles(value));
const binding = { projectId: 'merge-source-project', runId: 'merge-source-run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const writablePaths = ['src/app.mjs', 'src/alpha.mjs', 'src/beta.mjs'];

if (process.env.TASKFLOW_MERGE_SOURCE_CHILD !== '1') {
  test('merge provenance probes use real Git and synthetic private receipts, with no paid model or inherited business acceptance', async () => {
    await mkdir(evidence, { recursive: true }); const env = { ...process.env, TASKFLOW_MERGE_SOURCE_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(path.join(evidence, 'child-tests.tap'), result.stdout); await writeFile(path.join(evidence, 'child-stderr.txt'), result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  let f;
  const directories = [];
  function git(workspace, args) {
    return execFileSync('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Source fixture', '-c', 'user.email=fixture@localhost', ...args], {
      cwd: workspace, encoding: 'utf8', windowsHide: true,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  }
  async function fixture({ seedBase = false } = {}) {
    await mkdir(evidence, { recursive: true }); const root = await mkdtemp(path.join(evidence, 'fixture-')); directories.push(root);
    const seedWorkspace = path.join(root, 'seed', 'workspace'); await mkdir(seedWorkspace, { recursive: true }); const shell = await installWebShell({ workspace: seedWorkspace });
    async function platform(workspace) { await mkdir(path.join(workspace, '.platform'), { recursive: true }); await writeFile(path.join(workspace, '.platform', 'gitconfig'), ''); }
    await platform(seedWorkspace); git(seedWorkspace, ['init', '--quiet']); git(seedWorkspace, ['add', '--', '.']); git(seedWorkspace, ['commit', '--quiet', '-m', 'protected seed']);
    const seed = { ...binding, sourceCommit: git(seedWorkspace, ['rev-parse', 'HEAD']), sourceWorkspace: seedWorkspace, sourceHash: sourceHash([]), shellHash: shell.hash };
    async function candidate(id, base, updates, blocking = false) {
      const directory = path.join(root, `candidate-${id}`), workspace = path.join(directory, 'workspace'); await mkdir(directory);
      git(directory, ['clone', '--quiet', '--no-local', '--no-hardlinks', '--', base.provenance.sourceWorkspace, 'workspace']); await platform(workspace);
      const baseCommit = git(workspace, ['rev-parse', 'HEAD']); await applyProjectFiles({ workspace, files: updates }); git(workspace, ['add', '--', ...updates.map(file => file.path)]); git(workspace, ['commit', '--quiet', '-m', `candidate ${id}`]);
      const files = await readProjectFiles(workspace), commit = git(workspace, ['rev-parse', 'HEAD']), reportPath = path.join(directory, 'execution.json');
      const identity = { id: randomUUID(), ...binding, taskId: id, attemptId: `attempt-${id}`, manifestHash: 'c'.repeat(64) }, calls = [];
      async function receipt(role, content) {
        const receiptPath = path.join(directory, `model-${role}-1.json`), raw = JSON.stringify({ model: `fixture-${role}`, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 }, content: JSON.stringify(content) }); await writeFile(receiptPath, raw);
        calls.push({ role, kind: 'model', attempt: 1, ...Object.fromEntries(['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'manifestHash'].map(key => [key, identity[key]])),
          candidateCommit: role === 'review' ? commit : null, inputSourceHash: sourceHash(role === 'review' ? files : base.files), model: `fixture-${role}`, finishReason: 'stop', receiptConfirmed: true, receiptPath, receiptHash: hash(raw) });
      }
      await receipt('coding', { files: updates });
      const issue = { severity: 'blocking', file: updates[0].path, line: 1, message: 'fixture obligation must survive', evidence: updates[0].content.split('\n')[0] };
      const review = { summary: 'synthetic private review', issues: blocking ? [issue] : [], resolutions: [] }; await receipt('review', review);
      const record = { ...identity, profileId: 'planned-web-v1', providerKind: 'model', reviewerKind: 'model', status: 'failed', terminationConfirmed: true,
        reportPath, workspace, baseCommit, candidateCommit: commit, shellHash: shell.hash, totalModelCalls: 2, modelCalls: calls,
        writablePaths: updates.map(file => file.path), taskExecution: { taskId: id, attemptId: identity.attemptId, integration: false, taskSetHash: 'd'.repeat(64), taskDefinitionHash: 'e'.repeat(64) },
        versions: [{ attempt: 1, commit, sourceHash: sourceHash(files), selfCheck: { checks: [{ id: 'fixture-not-accepted', passed: false }] },
          acceptance: { issues: [], review: { ...review, status: 'completed' } } }],
        ...(base.provenance.sourceReportPath ? { initialSource: base.provenance } : { taskSeed: base.provenance }) };
      await writeFile(reportPath, JSON.stringify(record, null, 2));
      const handle = await inspectPlannedSource({ rootDir: root, reportPath, binding, writablePaths }), data = assertPlannedSource(handle, binding, writablePaths);
      return { record, files, data, workspace, reportPath };
    }
    const seedData = { files: [], provenance: seed }, foundation = seedBase ? null : await candidate('base', seedData, [{ path: 'src/app.mjs', content: 'export const app = true;\n' }]);
    const base = foundation?.data ?? seedData;
    const alpha = await candidate('alpha', base, [{ path: seedBase ? 'src/app.mjs' : 'src/alpha.mjs', content: 'export const alpha = true;\n' }], true);
    const beta = await candidate('beta', base, [{ path: 'src/beta.mjs', content: 'export const beta = true;\n' }]);
    const directory = path.join(root, 'merged'), workspace = path.join(directory, 'workspace'); await mkdir(directory);
    git(directory, ['clone', '--quiet', '--no-local', '--no-hardlinks', '--', base.provenance.sourceWorkspace, 'workspace']); await platform(workspace);
    for (const source of [alpha, beta]) { git(workspace, ['fetch', '--quiet', '--no-tags', '--', source.workspace, source.record.candidateCommit]); git(workspace, ['merge', '--quiet', '--no-ff', '--no-edit', '-m', `integrate ${source.record.taskId}`, source.record.candidateCommit]); }
    const reportPath = path.join(directory, 'merge-source.json'), files = await readProjectFiles(workspace);
    const record = { version: 1, profileId: 'planned-task-merge-v1', id: randomUUID(), ...binding, manifestHash: 'f'.repeat(64), taskSetHash: 'd'.repeat(64), workspace,
      base: base.provenance, sources: [alpha, beta].map(source => ({ taskId: source.record.taskId, writablePaths: source.record.writablePaths, provenance: source.data.provenance })),
      candidateCommit: git(workspace, ['rev-parse', 'HEAD']), sourceHash: sourceHash(files), shellHash: shell.hash,
      gitCommands: [{ forged: true, terminationConfirmed: false }], taskAccepted: true, passed: true, createdAt: new Date().toISOString() };
    const fixture = { root, record, files, workspace, reportPath, alpha, beta, foundation, seed, candidate,
      inspect: extra => inspectPlannedSource({ rootDir: root, reportPath, binding, writablePaths, ...extra }) };
    fixture.save = () => writeFile(reportPath, JSON.stringify(fixture.record, null, 2)); await fixture.save(); return fixture;
  }
  before(async () => { f = await fixture(); });
  after(async () => { for (const root of directories) { assert.equal(path.dirname(root), evidence); assert.ok(path.basename(root).startsWith('fixture-')); await rm(root, { recursive: true, force: true }); } });
  async function mutateFile(t, filename, body) { const original = await readFile(filename); await writeFile(filename, body); t.after(() => writeFile(filename, original)); }
  async function mutateRecord(t, mutate) { const original = structuredClone(f.record); mutate(f.record); await f.save(); t.after(async () => { f.record = original; await f.save(); }); }

  test('shared DAG ancestors are rechecked without false cycle rejection and merged source never inherits any pass', async () => {
    const handle = await f.inspect({ expectedRecord: f.record }), source = assertPlannedSource(handle, binding, writablePaths);
    assert.deepEqual(source.files, f.files); assert.equal(source.provenance.sourceKind, 'task_merge'); assert.equal(source.provenance.sourceReportHash, hash(await readFile(f.reportPath)));
    const receipts = [...new Set([f.foundation, f.alpha, f.beta].flatMap(item => item.record.modelCalls.map(call => call.receiptHash)))];
    assert.deepEqual([...source.provenance.sourceModelReceiptHashes].sort(), receipts.sort()); assert.equal(source.previousIssues.length, 1); assert.equal(source.previousIssues[0].status, 'open');
    assert.deepEqual(source.previousFailures, {}); assert.equal(source.accepted, undefined); assert.equal(source.passed, undefined); assert.equal(source.taskAccepted, undefined);
    assert.ok(Object.isFrozen(source) && Object.isFrozen(source.files)); assert.throws(() => assertPlannedSource(structuredClone(handle), binding, writablePaths));
  });
  test('empty protected seed baselines are checked by actual Git and shell and can join independent deltas', async () => {
    const s = await fixture({ seedBase: true }), handle = await s.inspect(); assert.deepEqual(assertPlannedSource(handle, binding, writablePaths).files, s.files);
    s.record.base.sourceHash = '0'.repeat(64); await s.save(); await assert.rejects(s.inspect());
  });
  test('a later ordinary source can recurse through a merged base while preserving original blocking obligations', async () => {
    const base = assertPlannedSource(await f.inspect(), binding, writablePaths), child = await f.candidate('after-merge', base, [{ path: 'src/app.mjs', content: 'export const afterMerge = true;\n' }]);
    assert.equal(child.record.baseCommit, f.record.candidateCommit); assert.equal(child.data.previousIssues.length, 1); assert.equal(child.data.previousIssues[0].status, 'open');
    assert.deepEqual(child.files.map(file => file.path), ['src/alpha.mjs', 'src/app.mjs', 'src/beta.mjs']);
  });
  test('merge source hash, common base commit/hash and current record identity cannot be forged', async t => {
    for (const mutate of [r => { r.sourceHash = '0'.repeat(64); }, r => { r.base.sourceHash = '0'.repeat(64); }, r => { r.base.sourceCommit = r.candidateCommit; }, r => { r.projectId = 'other'; }]) {
      const saved = structuredClone(f.record); mutate(f.record); await f.save(); await assert.rejects(f.inspect()); f.record = saved; await f.save();
    }
    await assert.rejects(f.inspect({ expectedRecord: { ...f.record, taskAccepted: false } }));
  });
  test('exact source report hashes and original coding and Review receipts are required', async t => {
    await mutateFile(t, f.alpha.reportPath, (await readFile(f.alpha.reportPath, 'utf8')) + '\n'); await assert.rejects(f.inspect());
  });
  for (const role of ['coding', 'review']) test(`changed private ${role} bytes reject merge provenance`, async t => {
    const filename = f.beta.record.modelCalls.find(c => c.role === role).receiptPath; await mutateFile(t, filename, '{}'); await assert.rejects(f.inspect());
  });
  test('delta permissions must exactly match the original task and sibling task paths cannot overlap', async t => {
    await mutateRecord(t, r => { r.sources[0].writablePaths.push('src/app.mjs'); }); await assert.rejects(f.inspect());
  });
  test('duplicate source tasks or sibling write-range overlaps do not obtain a provenance handle', async () => {
    for (const mutate of [r => { r.sources[1] = structuredClone(r.sources[0]); }, r => { r.sources[1].writablePaths.push(r.sources[0].writablePaths[0]); }]) {
      const saved = structuredClone(f.record); mutate(f.record); await f.save(); await assert.rejects(f.inspect()); f.record = saved; await f.save();
    }
  });
  test('source sets cannot be duplicated or reordered to misrepresent actual merge parent order', async t => {
    await mutateRecord(t, r => { r.sources.reverse(); }); await assert.rejects(f.inspect());
  });
  test('a same-tree forged commit with alternate Git parents is rejected even with matching report HEAD/hash', async t => {
    const prior = f.record.candidateCommit, tree = git(f.workspace, ['rev-parse', `${prior}^{tree}`]);
    const forged = git(f.workspace, ['commit-tree', tree, '-p', f.beta.record.candidateCommit, '-p', f.alpha.record.candidateCommit, '-m', 'same tree false parents']);
    git(f.workspace, ['update-ref', 'HEAD', forged]); f.record.candidateCommit = forged; await f.save();
    t.after(async () => { git(f.workspace, ['update-ref', 'HEAD', prior]); f.record.candidateCommit = prior; await f.save(); }); await assert.rejects(f.inspect());
  });
  test('working source or protected shell changes cannot obtain a merged source handle', async t => {
    await mutateFile(t, path.join(f.workspace, 'src/beta.mjs'), 'export const changed = true;\n'); await assert.rejects(f.inspect());
  });
  test('protected shell changes in the merge workspace reject independently of candidate source hashes', async t => {
    await mutateFile(t, path.join(f.workspace, 'server.mjs'), (await readFile(path.join(f.workspace, 'server.mjs'), 'utf8')) + '\n// changed protected file\n'); await assert.rejects(f.inspect());
  });
  test('cross-root and linked parent directories are rejected before reading external source', async t => {
    const narrow = path.dirname(f.reportPath); await assert.rejects(f.inspect({ rootDir: narrow }));
    const link = path.join(f.root, 'linked-merge'); await symlink(path.dirname(f.reportPath), link, process.platform === 'win32' ? 'junction' : 'dir'); t.after(() => rm(link, { force: true })); await assert.rejects(f.inspect({ reportPath: path.join(link, 'merge-source.json') }));
  });
  test('real recursive source cycles reject and do not become allowed by shared-ancestor support', async t => {
    await mutateRecord(t, r => { r.base.sourceReportPath = f.reportPath; r.base.sourceReportHash = hash('untrusted circular claim'); }); await assert.rejects(f.inspect());
  });
  test('pre-abort and late read have one global bounded budget and never dispatch late Git', async () => {
    let reads = 0, processes = 0;
    const fsMock = mock.module('node:fs/promises', { namedExports: { lstat, realpath, readdir, readFile: async (...args) => { reads++; if (path.resolve(args[0]) === f.foundation.reportPath) await new Promise(resolve => setTimeout(resolve, 90)); return readFile(...args); } } });
    const managedMock = mock.module(new URL('../lib/managed-process.mjs', import.meta.url).href, { namedExports: { minimalEnv, runProcess: async (...args) => { processes++; return runProcess(...args); } } });
    try {
      const limited = await import(`../lib/planned-source.mjs?merge-timeout=${randomUUID()}`), controller = new AbortController(); controller.abort();
      await assert.rejects(limited.inspectPlannedSource({ rootDir: f.root, reportPath: f.reportPath, binding, writablePaths, signal: controller.signal }), e => e.name === 'AbortError'); assert.equal(reads, 0);
      const started = Date.now(); await assert.rejects(limited.inspectPlannedSource({ rootDir: f.root, reportPath: f.reportPath, binding, writablePaths, timeoutMs: 25 }), e => e.name === 'AbortError'); assert.ok(Date.now() - started < 200);
      await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(processes, 0);
    } finally { managedMock.restore(); fsMock.restore(); }
  });
  test('a report edited after recursive checking still fails the final whole-record hash recheck', async t => {
    const original = await readFile(f.reportPath); let rootReads = 0;
    const fsMock = mock.module('node:fs/promises', { namedExports: { lstat, realpath, readdir, readFile: async (...args) => {
      if (path.resolve(args[0]) === f.reportPath && ++rootReads === 2) {
        const changed = Buffer.from(original.toString('utf8').replace('"manifestHash": "' + 'f'.repeat(64), '"manifestHash": "0' + 'f'.repeat(63)));
        assert.equal(changed.length, original.length); assert.notDeepEqual(changed, original); await writeFile(f.reportPath, changed);
      }
      return readFile(...args);
    } } });
    try { const late = await import(`../lib/planned-source.mjs?merge-late-record=${randomUUID()}`); await assert.rejects(late.inspectPlannedSource({ rootDir: f.root, reportPath: f.reportPath, binding, writablePaths })); assert.equal(rootReads, 2); }
    finally { fsMock.restore(); await writeFile(f.reportPath, original); }
  });
  test('unconfirmed managed Git carries its original process evidence and workspace instead of claiming stop', async () => {
    const result = { pid: 7654321, terminationConfirmed: false, exitCode: null, stopReason: 'stop_unconfirmed', stdout: '', stderr: '' };
    const managedMock = mock.module(new URL('../lib/managed-process.mjs', import.meta.url).href, { namedExports: { minimalEnv, runProcess: async (...args) => args[2].cwd === f.workspace ? result : runProcess(...args) } });
    try {
      const uncertain = await import(`../lib/planned-source.mjs?merge-unknown=${randomUUID()}`);
      await assert.rejects(uncertain.inspectPlannedSource({ rootDir: f.root, reportPath: f.reportPath, binding, writablePaths }), error => error.reconciliationRequired === true && error.result === result && error.workspace === f.workspace && error.result.pid === 7654321);
    } finally { managedMock.restore(); }
  });
  test('already dispatched Git is awaited for its known stop before the deadline error returns', async () => {
    let stopped = false;
    const managedMock = mock.module(new URL('../lib/managed-process.mjs', import.meta.url).href, { namedExports: { minimalEnv, runProcess: async () => { await new Promise(resolve => setTimeout(resolve, 65)); stopped = true; return { terminationConfirmed: true, exitCode: 0, stdout: f.foundation.workspace, stderr: '' }; } } });
    try {
      const limited = await import(`../lib/planned-source.mjs?merge-git-stop=${randomUUID()}`), started = Date.now();
      await assert.rejects(limited.inspectPlannedSource({ rootDir: f.root, reportPath: f.reportPath, binding, writablePaths, timeoutMs: 30 })); assert.equal(stopped, true); assert.ok(Date.now() - started >= 60);
    } finally { managedMock.restore(); }
  });
}
