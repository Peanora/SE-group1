import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertPlannedSource, inspectPlannedSource } from './planned-source.mjs';
import { assertMigrationPlan } from './planned-migration-contract.mjs';
import { inspectVerificationTasks } from './verification-task-scopes.mjs';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';
import { readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { getWebShellFiles } from './web-delivery.mjs';

const seeds = new WeakMap(), HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const originKeys = ['projectId', 'runId', 'executionId', 'candidateCommit', 'sourceHash', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision'];
const targetKeys = ['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision', 'inputSnapshotHash', 'inputSchemaHash'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const fail = (code, message = '跨版源码、数据快照、确认或历史义务无法完整核对。') => { throw Object.assign(new Error(message), { code, status: 409 }); };
const need = (value, code = 'invalid_evolution_seed', message) => { if (!value) fail(code, message); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const pure = value => copyBrowserScenarioData(value, 32 * 1024 * 1024, { maxNodes: 250000 });
const equal = (a, b) => hash(a) === hash(b);
export const evolutionSourcePolicy = freeze({ version: 'planned-evolution-source-only-v1', implementationHash: hash(readFileSync(new URL(import.meta.url))) });
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function object(raw, names, optional = []) {
  need(raw && typeof raw === 'object' && Object.getPrototypeOf(raw) === Object.prototype && !Object.getOwnPropertySymbols(raw).length);
  const fields = Object.getOwnPropertyDescriptors(raw);
  need(Object.keys(fields).every(key => [...names, ...optional].includes(key)) && names.every(key => Object.hasOwn(fields, key)) && Object.values(fields).every(field => field.enumerable && Object.hasOwn(field, 'value')));
  return Object.fromEntries(Object.keys(fields).map(key => [key, fields[key].value]));
}
function binding(raw, keys) {
  const value = object(pure(raw), keys);
  for (const key of keys) need(key === 'sourceGeneration' ? Number.isSafeInteger(value[key]) && value[key] >= 0 : typeof value[key] === 'string' && (['projectId', 'runId', 'executionId'].includes(key) ? ID : key === 'candidateCommit' ? COMMIT : HASH).test(value[key]));
  return freeze(value);
}
function paths(raw) { const value = pure(raw); need(Array.isArray(value)); return validateProjectFiles(value.map(path => ({ path, content: '' }))).map(file => file.path); }
function taskSet(rawTasks, rawRequirements, approvedHash) {
  const requirements = pure(rawRequirements); need(Array.isArray(requirements) && requirements.length > 0 && requirements.length <= 100 && new Set(requirements).size === requirements.length && requirements.every(id => typeof id === 'string' && ID.test(id)));
  const value = inspectVerificationTasks(rawTasks, requirements); need(value.tasks.length <= 8 && HASH.test(approvedHash) && value.taskSetHash === approvedHash, 'evolution_tasks_changed');
  const runtime = ['status', 'completed', 'accepted', 'checks', 'candidateCommit', 'baseCommit', 'history', 'attemptId', 'usage', 'modelCalls', 'totalModelCalls', 'versions', 'leaseToken', 'generation'];
  need(value.tasks.every(task => runtime.every(key => !Object.hasOwn(task, key)) && (task.acceptance === undefined || Array.isArray(task.acceptance) && task.acceptance.every(item => typeof item === 'string'))), 'evolution_inherited_execution', '新任务只能是确认计划，不能携带旧任务状态或通过结论。');
  const writePaths = paths([...new Set(value.tasks.flatMap(task => task.writePaths))]);
  return freeze({ ...value, requirements, writePaths });
}
function inside(root, filename) { const relative = path.relative(root, filename); need(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'evolution_source_outside_root'); }
function parentChecksSync(filename) {
  for (let current = path.dirname(filename);; current = path.dirname(current)) { const stat = lstatSync(current); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(realpathSync(current), current)); if (current === path.dirname(current)) return; }
}
function regularSync(filename, maximum = 32 * 1024 * 1024) {
  parentChecksSync(filename); const stat = lstatSync(filename); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximum && samePath(realpathSync(filename), filename));
  const value = readFileSync(filename), after = lstatSync(filename); need(value.length === stat.size && value.length === after.size && stat.ino === after.ino && stat.dev === after.dev && after.nlink === 1 && !after.isSymbolicLink()); return value;
}
async function regular(filename, current) {
  current();
  for (let directory = path.dirname(filename);; directory = path.dirname(directory)) {
    const stat = await lstat(directory); current(); const resolved = await realpath(directory); current(); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(resolved, directory)); if (directory === path.dirname(directory)) break;
  }
  const stat = await lstat(filename); current(); const resolved = await realpath(filename); current(); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024 && samePath(resolved, filename));
  const value = await readFile(filename); current(); const after = await lstat(filename); current(); need(value.length === stat.size && after.size === stat.size && after.ino === stat.ino && after.dev === stat.dev && after.nlink === 1 && !after.isSymbolicLink()); return value;
}
function options(raw = {}) { const value = object(raw, [], ['signal', 'timeoutMs']); need(value.signal === undefined || value.signal instanceof AbortSignal); const timeoutMs = value.timeoutMs ?? 60000; need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000); return { signal: value.signal, deadline: Date.now() + timeoutMs }; }
function sourceIdentity(source, origin) {
  const p = source.provenance;
  for (const [key, field] of [['projectId', 'projectId'], ['runId', 'sourceRunId'], ['executionId', 'sourceExecutionId'], ['candidateCommit', 'sourceCommit'], ['sourceHash', 'sourceHash'], ['specRevision', 'specRevision'], ['planRevision', 'planRevision']]) need(origin[key] === p[field], 'evolution_origin_changed');
}
function snapshotReference(snapshot, origin, target) {
  need(equal(snapshot.origin, origin) && snapshot.originCommit === origin.candidateCommit && snapshot.snapshotHash === target.inputSnapshotHash && snapshot.schemaHash === target.inputSchemaHash, 'evolution_snapshot_changed');
  need(snapshot.version === 1 && ['datasetId', 'snapshotId'].every(key => typeof snapshot[key] === 'string' && ID.test(snapshot[key])) && ['snapshotHash', 'databaseHash', 'schemaHash', 'rowsHash', 'policyHash'].every(key => HASH.test(snapshot[key])) && Number.isSafeInteger(snapshot.bytes) && snapshot.bytes >= 1 && Number.isSafeInteger(snapshot.dataGeneration) && snapshot.dataGeneration >= 0 && path.isAbsolute(snapshot.filename));
  return freeze(Object.fromEntries(['version', 'datasetId', 'snapshotId', 'dataGeneration', 'originCommit', 'snapshotHash', 'databaseHash', 'schemaHash', 'rowsHash', 'bytes', 'policyHash'].map(key => [key, snapshot[key]])));
}
function schemaMetadata(snapshot) {
  const tables = snapshot.workerReceipt?.after?.tables; need(Array.isArray(tables) && tables.length <= 32, 'evolution_schema_invalid');
  return freeze(tables.map(table => {
    need(typeof table.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(table.name) && Array.isArray(table.columns) && table.columns.length <= 64, 'evolution_schema_invalid');
    return { name: table.name, columns: table.columns.map(column => { need(typeof column.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(column.name) && typeof column.type === 'string' && column.type.length <= 128 && !/[\x00-\x1f\x7f]/u.test(column.type) && Number.isInteger(column.pk) && column.pk >= 0 && column.pk <= 64, 'evolution_schema_invalid'); return { name: column.name, type: column.type, primary: column.pk }; }) };
  }));
}
function current(proof, operation) {
  need(proof.live && !proof.uncertain, 'evolution_seed_revoked'); need(!operation.signal?.aborted && Date.now() < operation.deadline, 'evolution_interrupted');
  need(proof.service.readSnapshot === proof.readSnapshot && proof.service.inspect === proof.inspectDataset, 'evolution_dataset_service_changed');
  need(proof.assertCurrent(proof.context) === true, 'evolution_stale', '旧来源代次、新规格计划、冻结验收定义和权限必须同步明确通过。');
  assertMigrationPlan(proof.compiledMigrationPlan, proof.targetBinding);
  if (proof.snapshot) {
    const latest = proof.inspectDataset.call(proof.service, proof.snapshot.datasetId);
    need(equal(latest.origin, proof.originBinding) && latest.dataGeneration === proof.snapshot.dataGeneration && latest.snapshot?.snapshotHash === proof.snapshot.snapshotHash, 'evolution_snapshot_changed');
  }
}
function workspaceFacts(proof, shell) {
  const workspace = proof.source.provenance.sourceWorkspace, facts = new Map();
  const remember = (filename, expected) => { const bytes = regularSync(filename); if (expected !== undefined) need(hash(bytes) === expected, 'evolution_source_changed'); facts.set(filename, hash(bytes)); return bytes; };
  for (const file of proof.source.files) remember(path.join(workspace, file.path), hash(file.content));
  for (const file of shell) { try { remember(path.join(workspace, file.path), hash(file.content)); } catch { fail('evolution_incompatible_shell', '旧来源的平台运行文件与当前受控运行器不兼容，不能复用未核对的旧运行文件。'); } }
  const headPath = path.join(workspace, '.git', 'HEAD'), head = remember(headPath).toString('utf8').trim();
  let commit = head;
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5); need(/^refs\/[A-Za-z0-9_./-]+$/u.test(ref) && !ref.split('/').some(part => !part || part === '.' || part === '..'));
    const filename = path.join(workspace, '.git', ...ref.split('/')); inside(path.join(workspace, '.git'), filename);
    try { commit = remember(filename).toString('utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const packed = remember(path.join(workspace, '.git', 'packed-refs')).toString('utf8'); commit = packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0]; }
  }
  need(commit === proof.originBinding.candidateCommit, 'evolution_source_changed');
  return facts;
}
function databaseFacts(workspace) {
  need(typeof workspace === 'string' && path.isAbsolute(workspace)); const facts = new Map();
  for (const suffix of ['', '-wal', '-shm']) {
    const filename = path.join(workspace, '.platform', 'tmp', `app.sqlite${suffix}`);
    try { facts.set(filename, hash(regularSync(filename))); } catch (error) { if (suffix && error.code === 'ENOENT') facts.set(filename, null); else throw error; }
  }
  return facts;
}
function verifyFacts(facts) { for (const [filename, expected] of facts) { try { const actual = hash(regularSync(filename)); need(expected !== null && actual === expected, 'evolution_source_changed'); } catch (error) { if (expected === null && error.code === 'ENOENT') continue; throw error; } } }
async function history(proof, operation, shell) {
  const currentCheck = () => current(proof, operation), reports = new Map(), calls = new Map(), artifacts = new Map(), visiting = new Set();
  async function visit(provenance) {
    currentCheck(); const filename = path.resolve(provenance.sourceReportPath); inside(proof.sourceRootDir, filename); need(HASH.test(provenance.sourceReportHash));
    if (reports.has(filename)) { need(reports.get(filename).reportHash === provenance.sourceReportHash); return; }
    need(!visiting.has(filename) && visiting.size < 16 && reports.size < 128); visiting.add(filename);
    const bytes = await regular(filename, currentCheck); currentCheck(); need(hash(bytes) === provenance.sourceReportHash, 'evolution_source_changed'); artifacts.set(filename, hash(bytes));
    const record = pure(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    need(['planned-web-v1', 'planned-task-merge-v1'].includes(record.profileId));
    need(typeof record.workspace === 'string' && path.isAbsolute(record.workspace)); inside(proof.sourceRootDir, record.workspace);
    const files = await readProjectFiles(record.workspace); currentCheck();
    const expectedSourceHash = record.profileId === 'planned-task-merge-v1' ? record.sourceHash : record.versions.at(-1).sourceHash;
    need(hash(JSON.stringify(validateProjectFiles(files))) === expectedSourceHash, 'evolution_source_changed');
    const sourceFacts = workspaceFacts({ source: { files, provenance: { sourceWorkspace: record.workspace } }, originBinding: { candidateCommit: record.candidateCommit } }, shell, false);
    for (const [filename, expected] of sourceFacts) { if (artifacts.has(filename)) need(artifacts.get(filename) === expected, 'evolution_source_changed'); artifacts.set(filename, expected); }
    const entry = { reportHash: hash(bytes), executionId: record.id, runId: record.runId, profileId: record.profileId, status: record.status, versions: record.versions ?? [], calls: [] }; reports.set(filename, entry);
    for (const call of record.modelCalls ?? []) {
      const item = { sourceReportHash: entry.reportHash, sourceExecutionId: record.id, sourceRunId: record.runId, call: pure(call) }, id = `${entry.reportHash}:${call.role}:${call.attempt}:${call.id ?? ''}`;
      if (calls.has(id)) need(equal(calls.get(id), item)); else calls.set(id, item); entry.calls.push(id);
      if (call.receiptPath !== undefined) { const receipt = path.resolve(call.receiptPath); inside(proof.sourceRootDir, receipt); const raw = await regular(receipt, currentCheck); currentCheck(); need(hash(raw) === call.receiptHash); artifacts.set(receipt, hash(raw)); }
    }
    const references = record.profileId === 'planned-task-merge-v1' ? [record.base, ...record.sources.map(item => item.provenance)] : [record.initialSource, record.evolutionSource?.source];
    for (const reference of references) if (reference?.sourceReportPath) { await visit(reference); currentCheck(); }
    visiting.delete(filename);
  }
  await visit(proof.source.provenance); currentCheck();
  const modelCalls = [...calls.values()], receipts = [...new Set(modelCalls.flatMap(item => item.call.receiptHash ? [item.call.receiptHash] : []))].sort();
  need(equal(receipts, [...new Set(proof.source.provenance.sourceModelReceiptHashes)].sort()), 'evolution_history_changed');
  const usage = Object.fromEntries(['inputTokens', 'outputTokens'].map(key => { const sum = modelCalls.some(item => !Number.isSafeInteger(item.call.usage?.[key]) || item.call.usage[key] < 0) ? null : modelCalls.reduce((total, item) => total + item.call.usage[key], 0); return [key, Number.isSafeInteger(sum) ? sum : null]; }));
  const result = { reports: [...reports.values()].sort((a, b) => a.reportHash.localeCompare(b.reportHash)), modelCalls, receiptHashes: receipts, totalModelCalls: modelCalls.filter(item => item.call.kind === 'model' && item.call.dispatched !== false).length, usage };
  return { data: freeze({ ...result, historyHash: hash(result) }), artifacts };
}
async function check(proof, rawOptions) {
  const operation = options(rawOptions), ensure = () => current(proof, operation); ensure();
  const migration = assertMigrationPlan(proof.compiledMigrationPlan, proof.targetBinding), shell = await getWebShellFiles(); ensure();
  const before = await proof.readSnapshot.call(proof.service, proof.snapshotHandle); ensure(); const snapshot = snapshotReference(before, proof.originBinding, proof.targetBinding), inputSchema = schemaMetadata(before);
  if (proof.snapshot) need(equal(snapshot, proof.snapshot), 'evolution_snapshot_changed'); else proof.snapshot = snapshot;
  const facts = workspaceFacts(proof, shell), dataFacts = databaseFacts(before.runtimeWorkspace);
  const source = assertPlannedSource(await inspectPlannedSource({ rootDir: proof.sourceRootDir, reportPath: proof.source.provenance.sourceReportPath, binding: proof.originBinding, writablePaths: proof.retainedPaths, signal: operation.signal, timeoutMs: Math.max(1, operation.deadline - Date.now()) }), proof.originBinding, proof.retainedPaths); ensure();
  sourceIdentity(source, proof.originBinding); need(equal(source, proof.source), 'evolution_source_changed');
  const ledger = await history(proof, operation, shell); ensure();
  const after = await proof.readSnapshot.call(proof.service, proof.snapshotHandle); ensure(); need(equal(snapshotReference(after, proof.originBinding, proof.targetBinding), snapshot) && equal(schemaMetadata(after), inputSchema) && typeof after.runtimeWorkspace === 'string' && samePath(before.runtimeWorkspace, after.runtimeWorkspace), 'evolution_snapshot_changed');
  // The last await revalidates real Git/compatibility after all data/receipt reads.
  const last = assertPlannedSource(await inspectPlannedSource({ rootDir: proof.sourceRootDir, reportPath: proof.source.provenance.sourceReportPath, binding: proof.originBinding, writablePaths: proof.retainedPaths, signal: operation.signal, timeoutMs: Math.max(1, operation.deadline - Date.now()) }), proof.originBinding, proof.retainedPaths); ensure(); need(equal(last, proof.source), 'evolution_source_changed');
  verifyFacts(facts); verifyFacts(dataFacts); verifyFacts(ledger.artifacts); need(hash(regularSync(after.filename)) === snapshot.databaseHash, 'evolution_snapshot_changed'); ensure();
  // Match the fixed migration worker's exact normalized-plan encoding.
  const migrationRef = freeze({ revision: migration.revision, operationsHash: hash(JSON.stringify(migration.plan)), policy: migration.policy });
  const provenance = freeze({ version: 1, kind: 'evolution_source_only', policy: evolutionSourcePolicy, originBinding: proof.originBinding, targetBinding: proof.targetBinding, source: proof.source.provenance, taskSetHash: proof.taskSet.taskSetHash, retainedPaths: proof.retainedPaths, historyHash: ledger.data.historyHash, inputSchemaMetadataHash: hash(inputSchema), snapshot, migration: migrationRef, reuseValidation: false });
  if (proof.provenance) need(equal(provenance, proof.provenance), 'evolution_seed_changed'); else proof.provenance = provenance;
  const value = Object.freeze({ files: proof.source.files, inputSchema, sourceWorkspace: proof.source.provenance.sourceWorkspace, provenance, originBinding: proof.originBinding, targetBinding: proof.targetBinding, taskSetHash: proof.taskSet.taskSetHash, tasks: proof.taskSet.tasks, requirements: proof.taskSet.requirements, retainedPaths: proof.retainedPaths, writePathsByTask: freeze(proof.taskSet.tasks.map(task => ({ taskId: task.id, writePaths: [...task.writePaths] }))), previousIssues: proof.source.previousIssues, previousFailures: proof.source.previousFailures, historicalCosts: ledger.data, snapshotHandle: proof.snapshotHandle, compiledMigrationPlan: proof.compiledMigrationPlan, datasetService: proof.service, seedHash: hash(provenance) });
  const audit = () => { verifyFacts(facts); verifyFacts(dataFacts); verifyFacts(ledger.artifacts); need(hash(regularSync(after.filename)) === snapshot.databaseHash, 'evolution_snapshot_changed'); current(proof, { deadline: Infinity }); };
  const finish = () => { audit(); ensure(); };
  finish(); return { value, finish, audit };
}

/** Trusted controller admission only. This capability neither copies data nor grants acceptance. */
export async function createPlannedEvolutionSeed(raw) {
  const input = object(raw, ['sourceHandle', 'sourceRootDir', 'originBinding', 'targetBinding', 'requirements', 'tasks', 'approvedTaskSetHash', 'retainedPaths', 'snapshotHandle', 'datasetService', 'compiledMigrationPlan', 'assertCurrent'], ['signal', 'timeoutMs']);
  need(typeof input.sourceRootDir === 'string' && path.isAbsolute(input.sourceRootDir) && path.resolve(input.sourceRootDir) !== path.parse(input.sourceRootDir).root && typeof input.assertCurrent === 'function');
  const originBinding = binding(input.originBinding, originKeys), targetBinding = binding(input.targetBinding, targetKeys), retainedPaths = freeze(paths(input.retainedPaths)), tasks = taskSet(input.tasks, input.requirements, input.approvedTaskSetHash);
  need(originBinding.projectId === targetBinding.projectId && originBinding.runId !== targetBinding.runId && targetBinding.sourceGeneration > originBinding.sourceGeneration, 'evolution_target_not_new');
  const source = assertPlannedSource(input.sourceHandle, originBinding, retainedPaths); sourceIdentity(source, originBinding);
  need(equal(retainedPaths, source.files.map(file => file.path)) && retainedPaths.every(file => tasks.writePaths.includes(file)), 'evolution_unsupported_removal', '首版必须保留全部旧文件，并在新确认任务中逐一覆盖；删除、改名和缩小覆盖不受支持。');
  need(input.datasetService && typeof input.datasetService.readSnapshot === 'function' && typeof input.datasetService.inspect === 'function', 'evolution_dataset_service_required');
  const context = freeze({ originBinding, targetBinding, taskSetHash: tasks.taskSetHash, retainedPaths });
  const proof = { live: true, sourceRootDir: path.resolve(input.sourceRootDir), source, originBinding, targetBinding, retainedPaths, taskSet: tasks, context, assertCurrent: input.assertCurrent, snapshotHandle: input.snapshotHandle, service: input.datasetService, readSnapshot: input.datasetService.readSnapshot, inspectDataset: input.datasetService.inspect, compiledMigrationPlan: input.compiledMigrationPlan };
  const checked = await check(proof, { signal: input.signal, timeoutMs: input.timeoutMs });
  // No await after this final lifetime/approval check and capability publication.
  checked.finish(); proof.syncAudit = checked.audit; const handle = Object.freeze({ id: randomUUID(), kind: 'owned_planned_evolution_seed' }); seeds.set(handle, proof); return handle;
}

function expectedSeed(proof, expected) {
  const value = object(expected, ['targetBinding', 'requirements', 'tasks', 'approvedTaskSetHash'], ['retainedPaths']);
  need(equal(binding(value.targetBinding, targetKeys), proof.targetBinding), 'evolution_target_changed'); const tasks = taskSet(value.tasks, value.requirements, value.approvedTaskSetHash);
  need(equal(tasks, proof.taskSet) && (value.retainedPaths === undefined || equal(paths(value.retainedPaths), proof.retainedPaths)), 'evolution_tasks_changed');
}
export async function assertPlannedEvolutionSeed(handle, expected, rawOptions = {}) {
  const proof = seeds.get(handle); need(proof, 'invalid_evolution_capability'); expectedSeed(proof, expected);
  try { const checked = await check(proof, rawOptions); checked.finish(); proof.syncAudit = checked.audit; return checked.value; }
  catch (error) { if (error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false) { proof.uncertain = true; proof.syncAudit = null; } throw error; }
}

/** Reuses only a completed private audit; parsed summaries cannot grant authority. */
export function assertPlannedEvolutionSeedCurrent(handle, expected) {
  const proof = seeds.get(handle); need(proof && typeof proof.syncAudit === 'function', 'invalid_evolution_capability'); expectedSeed(proof, expected); proof.syncAudit();
}

/** A revalidated summary; private filenames, source content and raw calls stay internal. */
export async function describePlannedEvolutionSeed(handle, rawOptions = {}) {
  const proof = seeds.get(handle); need(proof, 'invalid_evolution_capability'); const checked = await check(proof, rawOptions); checked.finish(); proof.syncAudit = checked.audit; const value = checked.value;
  return freeze({ id: handle.id, kind: handle.kind, originBinding: value.originBinding, targetBinding: value.targetBinding, retainedPaths: value.retainedPaths, requirements: value.requirements, taskSetHash: value.taskSetHash, source: { commit: value.provenance.source.sourceCommit, sourceHash: value.provenance.source.sourceHash, reportHash: value.provenance.source.sourceReportHash, receiptHashes: value.historicalCosts.receiptHashes }, historicalCosts: { totalModelCalls: value.historicalCosts.totalModelCalls, usage: value.historicalCosts.usage, reportCount: value.historicalCosts.reports.length, historyHash: value.historicalCosts.historyHash }, blockerIds: value.previousIssues.map(issue => issue.id), snapshot: value.provenance.snapshot, migration: value.provenance.migration, reuseValidation: false, seedHash: value.seedHash });
}

export function revokePlannedEvolutionSeed(handle) { const proof = seeds.get(handle); need(proof, 'invalid_evolution_capability'); proof.live = false; }
