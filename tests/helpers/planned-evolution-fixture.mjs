import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { inspectPlannedSource, assertPlannedSource } from '../../lib/planned-source.mjs';
import { createPlannedEvolutionSeed } from '../../lib/planned-evolution-source.mjs';
import { createPlannedDatasetService } from '../../lib/planned-dataset.mjs';
import { createMigrationControl, compileMigrationPlan } from '../../lib/planned-migration-contract.mjs';
import { inspectVerificationTasks } from '../../lib/verification-task-scopes.mjs';
import { applyProjectFiles, validateProjectFiles } from '../../lib/project-files.mjs';
import { installWebShell } from '../../lib/web-delivery.mjs';
import { minimalEnv } from '../../lib/managed-process.mjs';
import { startWebRuntime } from '../../lib/web-runtime.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const sourceHash = files => hash(validateProjectFiles(files));
export const nativeEvolutionAvailable = process.platform === 'win32' && !!process.env.EXECUTION_SANDBOX_EXE && process.env.TASKFLOW_EXECUTION_NATIVE_TESTS === '1';
export const oldRows = [{ owner: 'alice', value: 'PRIVATE_ROW_ALICE' }, { owner: 'bob', value: 'PRIVATE_ROW_BOB' }];
const app = `import {DatabaseSync} from 'node:sqlite';
export async function createApp({databasePath}){const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY,owner TEXT,value TEXT)');return{handle:async request=>{if(request.method==='POST'&&request.path==='/items'){const data=JSON.parse(request.body);db.prepare('INSERT INTO items(owner,value) VALUES(?,?)').run(data.owner,data.value);return{status:201,body:'created'}}const rows=db.prepare('SELECT id,owner,value FROM items ORDER BY id').all();return request.path==='/items'?{status:200,headers:{'content-type':'application/json'},body:JSON.stringify(rows)}:{status:200,headers:{'content-type':'text/html; charset=utf-8'},body:'<div data-testid="items">'+rows.map(row=>row.owner+':'+row.value).join('|')+'</div>'}},close:()=>db.close()}}\n`;

/** Real Git/SQLite/MXC fixture; model receipts are synthetic and never paid. */
export async function setupPlannedEvolutionFixture(t, { prefix = 'case-', plan = { version: 1, kind: 'none', operations: [] }, blocking = true, distinctRuntime = true } = {}) {
  const output = path.resolve('output/planned-evolution-integration-author'); await mkdir(output, { recursive: true }); const directory = await mkdtemp(path.join(output, prefix)), sourceRootDir = path.join(directory, 'sources'), originDirectory = path.join(sourceRootDir, 'planned-web-origin'), workspace = path.join(originDirectory, 'workspace'); await mkdir(workspace, { recursive: true });
  const shell = await installWebShell({ workspace }); await mkdir(path.join(workspace, '.platform'), { recursive: true }); await writeFile(path.join(workspace, '.platform/gitconfig'), '');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Evolution integration fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: workspace, windowsHide: true, encoding: 'utf8', env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform/gitconfig'), GIT_TERMINAL_PROMPT: '0' } }).trim();
  git(['init', '--quiet']); git(['add', '--', '.']); git(['commit', '--quiet', '-m', 'protected base']); const baseCommit = git(['rev-parse', 'HEAD']);
  const files = validateProjectFiles([{ path: 'src/app.mjs', content: app }, { path: 'public/app.js', content: 'export const originalVersion=true;\n' }]); await applyProjectFiles({ workspace, files }); git(['add', '--', ...files.map(file => file.path)]); git(['commit', '--quiet', '-m', 'synthetic original candidate']); const commit = git(['rev-parse', 'HEAD']);
  const originBinding = { projectId: 'evolution-integration', runId: 'origin-run', executionId: 'origin-execution', candidateCommit: commit, sourceHash: sourceHash(files), sourceRevision: '0'.repeat(64), sourceGeneration: 0, specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
  const identity = { id: originBinding.executionId, projectId: originBinding.projectId, runId: originBinding.runId, specRevision: originBinding.specRevision, planRevision: originBinding.planRevision, taskId: 'whole', attemptId: randomUUID(), manifestHash: 'c'.repeat(64) }, modelCalls = [];
  const issue = { severity: 'blocking', file: 'src/app.mjs', line: 2, message: '旧数据所有者规则须按新需求重验', evidence: app.split('\n')[1] }, review = { summary: 'synthetic origin Review', issues: blocking ? [issue] : [], resolutions: [] };
  for (const role of ['coding', 'review']) {
    const receiptPath = path.join(originDirectory, `model-${role}-1.json`), raw = JSON.stringify({ model: `synthetic-${role}`, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, content: JSON.stringify(role === 'coding' ? { files } : review) }); await writeFile(receiptPath, raw);
    modelCalls.push({ id: randomUUID(), role, kind: 'model', attempt: 1, ...Object.fromEntries(['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'manifestHash'].map(key => [key, identity[key]])), candidateCommit: role === 'review' ? commit : null, inputSourceHash: role === 'review' ? sourceHash(files) : sourceHash([]), usage: { inputTokens: 1, outputTokens: 1 }, model: `synthetic-${role}`, finishReason: 'stop', receiptConfirmed: true, receiptPath, receiptHash: hash(raw) });
  }
  const savedIssue = { ...issue, id: `ISSUE-${hash({ ...issue, commit }).slice(0, 20)}`, status: 'open', originCommit: commit }, reportPath = path.join(originDirectory, 'execution.json');
  const record = { ...identity, profileId: 'planned-web-v1', providerKind: 'model', reviewerKind: 'model', status: 'failed', terminationConfirmed: true, workspace, baseCommit, candidateCommit: commit, shellHash: shell.hash, totalModelCalls: 2, modelCalls, versions: [{ attempt: 1, commit, sourceHash: sourceHash(files), selfCheck: { status: 'failed', checks: [] }, acceptance: { binding: { ...identity, candidateCommit: commit, sourceHash: sourceHash(files) }, status: 'changes_requested', issues: blocking ? [savedIssue] : [], review: { ...review, status: 'completed', openBlockingIssues: blocking ? 1 : 0 } } }] }; await writeFile(reportPath, JSON.stringify(record));
  const retainedPaths = files.map(file => file.path), sourceHandle = await inspectPlannedSource({ rootDir: sourceRootDir, reportPath, binding: originBinding, writablePaths: retainedPaths }), source = assertPlannedSource(sourceHandle, originBinding, retainedPaths);
  const runtimeWorkspace = distinctRuntime ? path.join(sourceRootDir, 'owned-runtime') : workspace;
  if (distinctRuntime) git(['clone', '--no-local', '--no-hardlinks', '--', workspace, runtimeWorkspace]);
  const runtime = await startWebRuntime({ workspace: runtimeWorkspace, timeoutMs: 30000 }); let stop;
  try { for (const row of oldRows) assert.equal((await runtime.request({ method: 'POST', path: '/items', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) })).status, 201); } finally { stop = await runtime.stop(); }
  assert.equal(stop.terminationConfirmed, true); assert.equal(stop.stopAcknowledged, true);
  const originalDatabase = hash(await readFile(path.join(runtimeWorkspace, '.platform/tmp/app.sqlite'))), state = { current: true, dataCurrent: true, dataGeneration: 0 };
  const service = await createPlannedDatasetService({ rootDir: path.join(directory, 'datasets'), sourceRootDir, authorizeStoppedDataset: async () => ({ kind: 'owned_dataset', workspace: runtimeWorkspace, origin: originBinding, dataGeneration: state.dataGeneration, stopEvidence: stop, assertCurrent: () => state.dataCurrent }) });
  const registered = await service.registerStoppedDataset({ runtimeRef: 'owned-origin' }), snapshotHandle = await service.snapshot({ datasetId: registered.datasetId, expectedGeneration: 0 }), snapshot = await service.readSnapshot(snapshotHandle);
  const targetBinding = { projectId: originBinding.projectId, runId: 'new-run', sourceRevision: '1'.repeat(64), sourceGeneration: 1, specRevision: '2'.repeat(64), planRevision: '3'.repeat(64), inputSnapshotHash: snapshot.snapshotHash, inputSchemaHash: snapshot.schemaHash };
  const requirements = ['R1'], tasks = [{ id: 'NEW_APP', title: '修改新规则', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], acceptance: ['旧数据保留'] }, { id: 'NEW_FINAL', title: '完整新版本回归', requirementIds: ['R1'], dependsOn: ['NEW_APP'], writePaths: ['public/app.js'], acceptance: ['页面显示旧数据'] }], approvedTaskSetHash = inspectVerificationTasks(tasks, requirements).taskSetHash;
  const control = createMigrationControl({ assertCurrent: () => state.current }), approval = control.approve({ plan, binding: targetBinding, feedback: 'Exact integration migration fixture' }), compiledMigrationPlan = compileMigrationPlan({ plan, binding: targetBinding, approval });
  const context = { targetBinding, requirements, tasks, approvedTaskSetHash, retainedPaths }, seedInput = { sourceHandle, sourceRootDir, originBinding, ...context, snapshotHandle, datasetService: service, compiledMigrationPlan, assertCurrent: () => state.current && state.dataCurrent && state.dataGeneration === 0 }, evolutionSeed = await createPlannedEvolutionSeed(seedInput);
  t.after(async () => { await service.close(); control.close(); assert.equal(hash(await readFile(path.join(runtimeWorkspace, '.platform/tmp/app.sqlite'))), originalDatabase); });
  return { directory, sourceRootDir, workspace, runtimeWorkspace, files, candidateFiles: files.map(file => file.path === 'src/app.mjs' ? { ...file, content: file.content + '// current new candidate\n' } : file), source, sourceHandle, reportPath, record, issue: savedIssue, git, originBinding, targetBinding, tasks, requirements, retainedPaths, approvedTaskSetHash, service, state, snapshot, snapshotHandle, compiledMigrationPlan, control, evolutionSeed, context, originalDatabase, seedInput };
}
