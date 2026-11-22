import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWindowsSandbox } from './windows-sandbox.mjs';
import { assertMigrationPlan, normalizeMigrationPlan, migrationContractPolicy } from './planned-migration-contract.mjs';
import { openPlannedReadonlyLedger } from './planned-readonly-ledger.mjs';

const snapshots = new WeakMap(), results = new WeakMap();
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, status: 409, ...extra }); };
const need = (value, code = 'dataset_invalid', message = '数据集来源、停止状态或内容无法完整核对。') => { if (!value) fail(code, message); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function exact(raw, names) { need(raw && typeof raw === 'object' && Object.getPrototypeOf(raw) === Object.prototype && !Object.getOwnPropertySymbols(raw).length); const descriptors = Object.getOwnPropertyDescriptors(raw); need(Object.keys(descriptors).length === names.length && names.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'))); return Object.fromEntries(names.map(key => [key, descriptors[key].value])); }
async function directory(raw, create = false) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root);
  const absolute = path.resolve(raw); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); if (create) await mkdir(current, { recursive: true, mode: 0o700 });
    const stat = await lstat(current); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(current), current));
  }
  return absolute;
}
function inside(root, target) { const relative = path.relative(root, target); need(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); }
async function regular(filename, maximum = 32 * 1024 * 1024) {
  await directory(path.dirname(filename)); const before = await lstat(filename); need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum && samePath(await realpath(filename), filename));
  const bytes = await readFile(filename), after = await lstat(filename); need(before.ino === after.ino && before.dev === after.dev && after.nlink === 1 && bytes.length === before.size && bytes.length === after.size && !after.isSymbolicLink()); return bytes;
}
async function bundle(workspace) {
  const files = []; let bytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const filename = path.join(workspace, '.platform', 'tmp', `app.sqlite${suffix}`);
    let value; try { value = await regular(filename); } catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    bytes += value.length; need(bytes <= 32 * 1024 * 1024, 'dataset_limit'); files.push({ suffix, hash: hash(value), bytes: value.length, value });
  }
  need(files[0]?.suffix === ''); return { fingerprint: hash(files.map(({ suffix, hash, bytes }) => ({ suffix, hash, bytes }))), files };
}
function origin(raw) {
  const value = exact(raw, ['projectId', 'runId', 'executionId', 'candidateCommit', 'sourceHash', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision']);
  need(['projectId', 'runId', 'executionId'].every(key => typeof value[key] === 'string' && ID.test(value[key])) && typeof value.candidateCommit === 'string' && COMMIT.test(value.candidateCommit));
  need(['sourceHash', 'sourceRevision', 'specRevision', 'planRevision'].every(key => typeof value[key] === 'string' && HASH.test(value[key])) && Number.isSafeInteger(value.sourceGeneration) && value.sourceGeneration >= 0); return value;
}
const cleanStop = value => value?.status === 'stopped' && value.exitCode === 0 && value.terminationConfirmed === true && value.sourceUnchanged === true && value.stopAcknowledged === true;

/** Internal data-plane only. The resolver owns runtime identity and grants stopped workspaces; HTTP never supplies paths or stop claims. */
export async function createPlannedDatasetService({ rootDir, sourceRootDir, snapshotRootDir, executable = process.env.EXECUTION_SANDBOX_EXE, authorizeStoppedDataset } = {}) {
  need(typeof authorizeStoppedDataset === 'function', 'dataset_resolver_required');
  const root = await directory(rootDir, true), sourceRoot = await directory(sourceRootDir);
  const snapshotRoot = snapshotRootDir === undefined ? root : await directory(snapshotRootDir);
  need(snapshotRootDir === undefined || !samePath(snapshotRoot, root), 'dataset_readonly_source_required');
  await directory(path.join(root, 'jobs'), true); await directory(path.join(root, 'artifacts'), true);
  const metadata = path.join(root, 'datasets.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) { try { await regular(metadata + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const db = new DatabaseSync(metadata); db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT,pid INTEGER);
    CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY,runtime_ref TEXT NOT NULL,project_id TEXT NOT NULL,data_generation INTEGER NOT NULL,origin TEXT NOT NULL,source_fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,active INTEGER NOT NULL,metadata TEXT NOT NULL,receipt TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_dataset_project ON intents(project_id) WHERE active=1;`);
  const owner = randomUUID(), controllers = new Set(), operations = new Set(); let closed = false, closing = false, closePromise;
  const transaction = work => { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  try { transaction(() => { const old = db.prepare('SELECT * FROM owner WHERE id=1').get(); let alive = false; if (old?.token) { try { process.kill(old.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } } need(!alive, 'dataset_service_owned'); db.prepare("UPDATE intents SET status='reconciliation_required' WHERE active=1").run(); db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid); }); } catch (error) { db.close(); throw error; }
  let worker, snapshotLedger;
  try {
    await chmod(metadata, 0o600);
    worker = await readFile(new URL('./planned-migration-worker.cjs', import.meta.url));
    if (snapshotRootDir !== undefined) snapshotLedger = openPlannedReadonlyLedger(path.join(snapshotRoot, 'datasets.sqlite'));
  } catch (error) {
    db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner);
    db.close();
    throw error;
  }
  const workerHash = hash(worker), policyHash = hash({ version: 1, workerHash, contract: migrationContractPolicy });
  const selectDataset = id => {
    snapshotLedger?.assertCurrent();
    return (snapshotLedger?.db ?? db).prepare('SELECT * FROM datasets WHERE id=?').get(id);
  };
  const available = () => need(!closed && !closing && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner, 'dataset_service_closed');
  const hasActivity = projectId => { available(); return !!db.prepare('SELECT 1 FROM intents WHERE project_id=? AND active=1').get(projectId); };
  const currentGrant = async runtimeRef => {
    available(); need(typeof runtimeRef === 'string' && ID.test(runtimeRef)); const grant = await authorizeStoppedDataset(runtimeRef); available();
    need(grant?.kind === 'owned_dataset' && cleanStop(grant.stopEvidence) && typeof grant.assertCurrent === 'function' && Number.isSafeInteger(grant.dataGeneration) && grant.dataGeneration >= 0, 'dataset_not_stopped');
    const value = grant.assertCurrent(); need(value !== false && !value?.then, 'dataset_stale');
    const workspace = await directory(grant.workspace); inside(sourceRoot, workspace); const checked = origin(grant.origin);
    return { ...grant, workspace, origin: checked };
  };
  const assertReadCurrent = grant => {
    available(); const value = grant.assertCurrent(); need(value !== false && !value?.then, 'dataset_stale'); available();
  };
  async function verifySnapshotProof(proof) {
    available(); need(proof?.owner === owner, 'invalid_dataset_capability');
    const row = selectDataset(proof.row.id);
    need(row && ['runtime_ref', 'project_id', 'data_generation', 'origin', 'source_fingerprint', 'snapshot'].every(key => row[key] === proof.row[key]), 'dataset_snapshot_changed');
    const data = proof.data;
    need(data.datasetId === row.id && data.dataGeneration === row.data_generation && typeof data.snapshotId === 'string' && ID.test(data.snapshotId) && samePath(data.filename, path.join(snapshotRoot, 'artifacts', `${data.snapshotId}.sqlite`)), 'dataset_snapshot_changed');
    need(data.snapshotHash === hash(Object.fromEntries(['version', 'datasetId', 'snapshotId', 'dataGeneration', 'originCommit', 'databaseHash', 'schemaHash', 'rowsHash', 'bytes', 'policyHash'].map(key => [key, data[key]]))), 'dataset_snapshot_changed');
    const checkOrigin = grant => {
      need(hash(grant.origin) === hash(JSON.parse(row.origin)) && grant.dataGeneration === row.data_generation, 'dataset_stale');
      if (proof.sourceWorkspace === undefined) proof.sourceWorkspace = grant.workspace;
      else need(samePath(grant.workspace, proof.sourceWorkspace), 'dataset_stale');
      assertReadCurrent(grant);
    };
    const first = await currentGrant(row.runtime_ref); available(); checkOrigin(first);
    const source = await bundle(first.workspace); available(); need(source.fingerprint === row.source_fingerprint, 'dataset_stale');
    const bytes = await regular(data.filename); available(); need(hash(bytes) === data.databaseHash && bytes.length === data.bytes, 'dataset_snapshot_changed');
    const last = await currentGrant(row.runtime_ref); available(); checkOrigin(last);
    const after = await bundle(last.workspace); available(); need(after.fingerprint === row.source_fingerprint, 'dataset_stale');
    // No await follows this publication guard. close/replacement or a withdrawn
    // resolver cannot turn an earlier successful read into a current capability.
    assertReadCurrent(last); return last;
  }
  const begin = (projectId, kind, metadata) => {
    available(); need(!hasActivity(projectId), 'dataset_busy'); const id = randomUUID(), now = new Date().toISOString();
    transaction(() => db.prepare("INSERT INTO intents VALUES(?,?,?,'preparing',1,?,NULL,?,?)").run(id, projectId, kind, JSON.stringify(metadata), now, now)); return id;
  };
  const update = (id, status, active, metadata, receipt = null) => { need(!closed && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner, 'dataset_service_closed'); return db.prepare('UPDATE intents SET status=?,active=?,metadata=?,receipt=?,updated_at=? WHERE id=?').run(status, active ? 1 : 0, JSON.stringify(metadata), receipt === null ? null : JSON.stringify(receipt), new Date().toISOString(), id); };
  const failAfterWorker = (id, error) => {
    const row = db.prepare('SELECT * FROM intents WHERE id=?').get(id);
    if (row?.status === 'preparing' && row.active) { const metadata = JSON.parse(row.metadata); metadata.publicationError = 'before_worker_dispatch_failed'; update(id, ['dataset_cancelled', 'dataset_service_closed'].includes(error.code) ? 'stopped' : 'failed', false, metadata); return; }
    if (row?.status === 'worker_completed' && row.active) { const metadata = JSON.parse(row.metadata); need(metadata.processes.length > 0 && metadata.processes.every(process => process.terminationConfirmed === true)); metadata.publicationError = 'artifact_or_current_binding_failed'; update(id, error.code === 'dataset_cancelled' ? 'stopped' : 'failed', false, metadata, JSON.parse(row.receipt)); }
  };
  const track = work => { const promise = Promise.resolve().then(work); operations.add(promise); promise.then(() => operations.delete(promise), () => operations.delete(promise)); return promise; };
  async function runWorker({ id, projectId, inputFiles, expectedSchema, operation, plan, signal, assertCurrent }) {
    available(); need(signal === undefined || signal instanceof AbortSignal); const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); controllers.add(controller);
    let expired = false; const deadline = Date.now() + 30000, timer = setTimeout(() => { expired = true; controller.abort(); }, 30000);
    const evidence = { id, projectId, operation, workerHash, policyHash, timeoutMs: 30000, workspace: null, processes: [] }; let result;
    const check = async () => { available(); need(!controller.signal.aborted, 'dataset_cancelled'); await assertCurrent(); need(hash(await readFile(new URL('./planned-migration-worker.cjs', import.meta.url))) === workerHash, 'migration_worker_changed'); };
    try {
      await check(); evidence.workspace = await mkdtemp(path.join(root, 'jobs', 'migration-')); await mkdir(path.join(evidence.workspace, '.platform', 'tmp'), { recursive: true });
      const runner = path.join(evidence.workspace, '.platform', 'runner.cjs'); await writeFile(runner, worker, { flag: 'wx', mode: 0o400 });
      for (const file of inputFiles) await writeFile(path.join(evidence.workspace, '.platform', 'tmp', `input.sqlite${file.suffix}`), file.value, { flag: 'wx', mode: 0o600 });
      const nonce = randomUUID(), job = { version: 1, nonce, operation, inputHash: inputFiles[0].hash, inputSchemaHash: expectedSchema ?? null, plan };
      update(id, 'preflight', true, evidence); const sandbox = createWindowsSandbox({ executable }); evidence.preflight = await sandbox.preflight({ workspace: evidence.workspace, signal: controller.signal }); await check();
      update(id, 'running', true, evidence); result = await sandbox.run({ workspace: evidence.workspace, runnerFile: runner, input: JSON.stringify(job), signal: controller.signal, timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), maxOutputBytes: 131072 }); evidence.processes.push(result);
      need(result.terminationConfirmed === true, 'migration_stop_unknown'); await check();
      let report; try { report = JSON.parse(result.stdout.trim()); } catch { fail('migration_invalid_output', '迁移 worker 没有完整可信结果。'); }
      need(result.exitCode === 0 && !result.stopReason && !result.truncated && report.status === 'passed', 'migration_failed', '迁移副本检查失败，原始数据库未覆盖。');
      need(report.version === 1 && report.nonce === nonce && report.operation === operation && report.inputHash === job.inputHash && report.operationsHash === hash(plan) && HASH.test(report.outputHash ?? '') && report.before?.integrity === 'ok' && report.after?.integrity === 'ok', 'migration_invalid_output');
      need(hash(await regular(runner, worker.length + 1)) === workerHash, 'migration_worker_changed');
      const bytes = await regular(path.join(evidence.workspace, '.platform', 'tmp', 'output.sqlite')); need(hash(bytes) === report.outputHash && bytes.length === report.outputBytes, 'migration_output_changed');
      await check(); update(id, 'worker_completed', true, evidence, report); return { report, bytes, evidence };
    } catch (error) {
      const unknown = error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false || result?.terminationConfirmed === false || error.code === 'migration_stop_unknown';
      if (error?.result && !evidence.processes.includes(error.result)) evidence.processes.push(error.result);
      update(id, unknown ? 'reconciliation_required' : expired ? 'timed_out' : controller.signal.aborted ? 'stopped' : 'failed', unknown, evidence);
      throw Object.assign(new Error(unknown ? '数据操作停止尚未确认，保留活动和现场。' : '数据操作未获得完整有效结论，原数据库未覆盖。'), { code: unknown ? 'dataset_reconciliation_required' : 'dataset_operation_failed', status: 409, reconciliationRequired: unknown, evidence });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller); }
  }
  async function registerStoppedDataset(raw, { signal } = {}) {
    const { runtimeRef } = exact(raw, ['runtimeRef']);
    need(!snapshotLedger, 'dataset_readonly_source_required');
    return track(async () => {
      need(signal === undefined || signal instanceof AbortSignal); need(!signal?.aborted, 'dataset_cancelled');
      const grant = await currentGrant(runtimeRef), source = await bundle(grant.workspace), id = begin(grant.origin.projectId, 'snapshot', { runtimeRef, origin: grant.origin, sourceFingerprint: source.fingerprint });
      try {
      const ensure = async () => { const current = await currentGrant(runtimeRef); need(hash(current.origin) === hash(grant.origin) && current.dataGeneration === grant.dataGeneration && (await bundle(current.workspace)).fingerprint === source.fingerprint, 'dataset_stale'); };
      const value = await runWorker({ id, projectId: grant.origin.projectId, inputFiles: source.files, operation: 'backup', plan: normalizeMigrationPlan({ version: 1, kind: 'none', operations: [] }), signal, assertCurrent: ensure });
      const datasetId = randomUUID(), snapshotId = randomUUID(), filename = path.join(root, 'artifacts', `${snapshotId}.sqlite`); await writeFile(filename, value.bytes, { flag: 'wx', mode: 0o400 }); await chmod(filename, 0o400);
      const snapshot = { version: 1, datasetId, snapshotId, dataGeneration: grant.dataGeneration, originCommit: grant.origin.candidateCommit, databaseHash: value.report.outputHash, schemaHash: value.report.after.schemaHash, rowsHash: value.report.after.rowsHash, bytes: value.bytes.length, policyHash, filename, workerReceipt: value.report, evidence: value.evidence };
      snapshot.snapshotHash = hash(Object.fromEntries(['version', 'datasetId', 'snapshotId', 'dataGeneration', 'originCommit', 'databaseHash', 'schemaHash', 'rowsHash', 'bytes', 'policyHash'].map(key => [key, snapshot[key]])));
      await ensure(); need(!signal?.aborted, 'dataset_cancelled'); transaction(() => { db.prepare('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?)').run(datasetId, runtimeRef, grant.origin.projectId, grant.dataGeneration, JSON.stringify(grant.origin), source.fingerprint, JSON.stringify(snapshot), new Date().toISOString()); update(id, 'completed', false, value.evidence, value.report); });
      return { datasetId, dataGeneration: grant.dataGeneration, snapshotId, snapshotHash: snapshot.snapshotHash, origin: grant.origin };
      } catch (error) { failAfterWorker(id, error); throw error; }
    });
  }
  async function snapshot(raw) {
    const { datasetId, expectedGeneration } = exact(raw, ['datasetId', 'expectedGeneration']); available(); need(typeof datasetId === 'string' && ID.test(datasetId) && Number.isSafeInteger(expectedGeneration));
    const row = selectDataset(datasetId); need(row && row.data_generation === expectedGeneration, 'dataset_generation_changed'); const data = JSON.parse(row.snapshot);
    const proof = { owner, row, data }, grant = await verifySnapshotProof(proof); assertReadCurrent(grant);
    const handle = Object.freeze({ kind: 'owned_dataset_snapshot', id: randomUUID() }); snapshots.set(handle, proof); return handle;
  }
  async function readSnapshot(handle) {
    available(); const proof = snapshots.get(handle); need(proof?.owner === owner, 'invalid_dataset_capability');
    const grant = await verifySnapshotProof(proof); assertReadCurrent(grant); return structuredClone({ ...proof.data, origin: JSON.parse(proof.row.origin), runtimeWorkspace: proof.sourceWorkspace });
  }
  async function migrate(raw, { signal } = {}) {
    const { snapshotHandle, compiledPlan, targetBinding, candidateCommit } = exact(raw, ['snapshotHandle', 'compiledPlan', 'targetBinding', 'candidateCommit']);
    return track(async () => {
      need(signal === undefined || signal instanceof AbortSignal); need(!signal?.aborted, 'dataset_cancelled');
      const source = await readSnapshot(snapshotHandle); need(typeof candidateCommit === 'string' && COMMIT.test(candidateCommit));
      const contract = assertMigrationPlan(compiledPlan, targetBinding), target = contract.binding;
      need(target.projectId === source.origin.projectId && target.inputSnapshotHash === source.snapshotHash && target.inputSchemaHash === source.schemaHash, 'migration_binding_changed');
      const id = begin(source.origin.projectId, 'migration', { candidateCommit, targetBinding: target, migrationRevision: contract.revision, inputSnapshotHash: source.snapshotHash });
      try {
      const ensure = async () => { await readSnapshot(snapshotHandle); assertMigrationPlan(compiledPlan, target); };
      const value = await runWorker({ id, projectId: source.origin.projectId, inputFiles: [{ suffix: '', hash: source.databaseHash, value: await regular(source.filename) }], expectedSchema: source.schemaHash, operation: 'migrate', plan: contract.plan, signal, assertCurrent: ensure });
      const filename = path.join(root, 'artifacts', `${id}.sqlite`); await writeFile(filename, value.bytes, { flag: 'wx', mode: 0o400 }); await chmod(filename, 0o400); await ensure(); need(!signal?.aborted, 'dataset_cancelled');
      const receipt = { version: 1, id, candidateCommit, binding: target, inputSnapshotHash: source.snapshotHash, migrationRevision: contract.revision, operationsHash: value.report.operationsHash, policyHash, databaseHash: value.report.outputHash, schemaHash: value.report.after.schemaHash, rowsHash: value.report.after.rowsHash, before: value.report.before, after: value.report.after, terminationConfirmed: true, workerReceipt: value.report, processes: value.evidence.processes };
      update(id, 'completed', false, value.evidence, receipt); const handle = Object.freeze({ kind: 'owned_migration_result', id: randomUUID() }); results.set(handle, { owner, receipt, receiptHash: hash(receipt), snapshotHandle, compiledPlan, target, filename }); return handle;
      } catch (error) { failAfterWorker(id, error); throw error; }
    });
  }
  async function readResult(handle) {
    available(); const proof = results.get(handle); need(proof?.owner === owner && hash(proof.receipt) === proof.receiptHash, 'invalid_dataset_capability');
    const source = snapshots.get(proof.snapshotHandle); need(source?.owner === owner && proof.receipt.inputSnapshotHash === source.data.snapshotHash, 'invalid_dataset_capability');
    assertMigrationPlan(proof.compiledPlan, proof.target); await verifySnapshotProof(source); available();
    inside(path.join(root, 'artifacts'), proof.filename); const bytes = await regular(proof.filename); available(); need(hash(bytes) === proof.receipt.databaseHash, 'migration_output_changed');
    const grant = await verifySnapshotProof(source); assertMigrationPlan(proof.compiledPlan, proof.target); assertReadCurrent(grant);
    return { receipt: structuredClone(proof.receipt), databasePath: proof.filename };
  }
  function inspect(datasetId) { available(); need(typeof datasetId === 'string' && ID.test(datasetId)); const row = selectDataset(datasetId); need(row, 'dataset_not_found'); const data = JSON.parse(row.snapshot); return { datasetId: row.id, dataGeneration: row.data_generation, origin: JSON.parse(row.origin), snapshot: Object.fromEntries(['snapshotId', 'snapshotHash', 'databaseHash', 'schemaHash', 'rowsHash', 'bytes', 'policyHash'].map(key => [key, data[key]])) }; }
  function inspectIntents(projectId) { available(); need(typeof projectId === 'string' && ID.test(projectId)); return db.prepare('SELECT id,project_id,kind,status,active,metadata,receipt,created_at,updated_at FROM intents WHERE project_id=? ORDER BY created_at,id').all(projectId).map(row => ({ ...row, metadata: JSON.parse(row.metadata), receipt: row.receipt ? JSON.parse(row.receipt) : null })); }
  function close() { return closePromise ??= (async () => { if (closed) return; closing = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...operations]); db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); try { db.close(); } finally { snapshotLedger?.close(); closed = true; } })(); }
  return Object.freeze({ registerStoppedDataset, snapshot, readSnapshot, migrate, readResult, inspect, inspectIntents, hasActivity, close });
}
