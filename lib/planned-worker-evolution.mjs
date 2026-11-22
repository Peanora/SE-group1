import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createPlannedDatasetService } from './planned-dataset.mjs';
import { createStoppedDatasetResolver } from './planned-local-releases.mjs';
import { openPlannedReadonlyLedger } from './planned-readonly-ledger.mjs';
import { openWorkerEvolutionBinding } from './planned-worker-evolution-binding.mjs';
import { assertPlannedSource, inspectPlannedSource } from './planned-source.mjs';
import { createPlannedEvolutionSeed } from './planned-evolution-source.mjs';
import { createMigrationControl, compileMigrationPlan } from './planned-migration-contract.mjs';
import { inspectVerificationTasks } from './verification-task-scopes.mjs';
import { getWebShellFiles } from './web-delivery.mjs';
import { canonicalJSON } from './verification-contract.mjs';

const digest = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const equal = (left, right) => canonicalJSON(left) === canonicalJSON(right);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const need = ok => { if (!ok) throw Object.assign(new Error('演进原数据、迁移回执或持久作业无法核对。'), { code: 'worker_evolution_evidence_changed', status: 409 }); };

async function openStoppedRelease(root) {
  const directory = path.join(root, 'local-releases'), shell = await getWebShellFiles();
  const ledger = openPlannedReadonlyLedger(path.join(directory, 'releases.sqlite'));
  const resolver = createStoppedDatasetResolver({ root: directory, shell, available: ledger.assertCurrent,
    select: id => ledger.db.prepare('SELECT * FROM releases WHERE id=?').get(id),
    pointer: id => ledger.db.prepare('SELECT * FROM current_release WHERE project_id=?').get(id) });
  return { ...resolver, close: ledger.close };
}

export async function openWorkerEvolution({ root, jobDir, grant, manifest, executable, signal, assertWorker }) {
  const ledger = openWorkerEvolutionBinding(root, grant);
  const control = createMigrationControl();
  let release, datasets;
  const close = async () => {
    try { await datasets?.close(); }
    finally { control.close(); release?.close(); ledger.close(); }
  };
  try {
    const record = ledger.read(), releaseId = record.input.releaseId;
    release = await openStoppedRelease(root);
    const stopped = release.open(releaseId);
    const assertCurrent = () => { assertWorker(); ledger.read(); stopped.assertCurrent(); return true; };
    assertCurrent();
    datasets = await createPlannedDatasetService({ rootDir: path.join(jobDir, 'ds'), sourceRootDir: root, snapshotRootDir: path.join(root, 'datasets'),
      executable, authorizeStoppedDataset: async id => {
        assertCurrent();
        need(id === releaseId);
        const data = await release.authorizeStoppedDataset(id);
        assertCurrent();
        need(equal(data.origin, record.origin) && data.dataGeneration === record.snapshot.dataGeneration);
        return data;
      } });
    assertCurrent();
    const snapshotHandle = await datasets.snapshot({ datasetId: record.snapshot.datasetId, expectedGeneration: record.snapshot.dataGeneration });
    const sourceHandle = await inspectPlannedSource({ rootDir: root, reportPath: record.sourceProvenance.sourceReportPath,
      binding: record.origin, writablePaths: record.retainedPaths, signal });
    assertCurrent();
    const provenance = assertPlannedSource(sourceHandle, record.origin, record.retainedPaths).provenance;
    need(equal(provenance, record.sourceProvenance));
    const input = { plan: record.migration, binding: record.targetBinding, feedback: record.approval.feedback };
    const compiledMigrationPlan = compileMigrationPlan({ ...input, approval: control.approve(input) });
    const requirements = grant.definition.requirements, tasks = grant.task.tasks;
    need(manifest.manifestHash === grant.definition.manifestHash);
    const approvedTaskSetHash = inspectVerificationTasks(tasks, requirements).taskSetHash;
    const seed = await createPlannedEvolutionSeed({ sourceHandle, sourceRootDir: root, originBinding: record.origin, targetBinding: record.targetBinding,
      requirements, tasks, approvedTaskSetHash, retainedPaths: record.retainedPaths, snapshotHandle, datasetService: datasets, compiledMigrationPlan,
      signal, assertCurrent });
    assertCurrent();
    return { seed, assertCurrent, close };
  } catch (error) { await close(); throw error; }
}

async function assertArtifact(filename, expectedHash, expectedSize) {
  const before = await lstat(filename);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size === expectedSize
    && expectedSize > 0 && expectedSize <= 32 * 1024 * 1024 && samePath(await realpath(filename), filename));
  const bytes = await readFile(filename), after = await lstat(filename);
  need(after.isFile() && !after.isSymbolicLink() && after.dev === before.dev && after.ino === before.ino
    && after.size === before.size && after.nlink === 1 && digest(bytes) === expectedHash);
}

async function verifyOriginalSnapshot(root, approval, assertCurrent) {
  const release = await openStoppedRelease(root);
  let ledger;
  try {
    ledger = openPlannedReadonlyLedger(path.join(root, 'datasets', 'datasets.sqlite'));
    const stopped = await release.authorizeStoppedDataset(approval.input.releaseId);
    const dataset = ledger.db.prepare('SELECT * FROM datasets WHERE id=?').get(approval.snapshot.datasetId);
    const snapshot = JSON.parse(dataset?.snapshot ?? 'null'), expected = approval.snapshot;
    need(dataset?.runtime_ref === approval.input.releaseId && dataset.data_generation === expected.dataGeneration
      && dataset.source_fingerprint === stopped.sourceFingerprint && equal(JSON.parse(dataset.origin), approval.origin)
      && equal(stopped.origin, approval.origin) && stopped.dataGeneration === expected.dataGeneration
      && Object.entries(expected).every(([key, value]) => snapshot?.[key] === value));
    const filename = path.join(root, 'datasets', 'artifacts', expected.snapshotId + '.sqlite');
    need(samePath(snapshot.filename, filename));
    await assertArtifact(filename, expected.databaseHash, expected.bytes);
    ledger.assertCurrent(); stopped.assertCurrent(); assertCurrent();
  } finally { ledger?.close(); release.close(); }
}

export async function verifyWorkerEvolutionEvidence({ root, jobDir, authorization, record, historical }) {
  const ledger = openWorkerEvolutionBinding(root, authorization);
  let migrations;
  try {
    const current = () => ledger.read({ historical });
    const approval = current(), source = record.evolutionSource;
    const version = record.versions.at(-1);
    need(source && equal(source.originBinding, approval.origin) && equal(source.targetBinding, approval.targetBinding)
      && equal(source.source, approval.sourceProvenance) && equal(source.retainedPaths, approval.retainedPaths)
      && equal(record.evolutionMigration, approval.migration)
      && Object.entries(approval.snapshot).every(([key, value]) => source.snapshot?.[key] === value));
    const location = path.join(jobDir, 'ds');
    migrations = openPlannedReadonlyLedger(path.join(location, 'datasets.sqlite'));
    for (const proof of [version.selfCheck.dataset, version.acceptance.test.dataset, ...version.acceptance.browser.dataset]) {
      need(proof && /^[A-Za-z0-9_-]{1,128}$/u.test(proof.migrationId));
      migrations.assertCurrent();
      const row = migrations.db.prepare('SELECT * FROM intents WHERE id=?').get(proof.migrationId);
      need(row?.project_id === record.projectId && row.kind === 'migration' && row.status === 'completed' && !row.active);
      const receipt = JSON.parse(row.receipt);
      need(digest(receipt) === proof.migrationReceiptHash && receipt.id === proof.migrationId
        && receipt.candidateCommit === record.candidateCommit && receipt.inputSnapshotHash === source.snapshot.snapshotHash
        && receipt.migrationRevision === source.migration.revision && receipt.operationsHash === source.migration.operationsHash
        && equal(receipt.binding, approval.targetBinding) && receipt.databaseHash === proof.databaseHash
        && receipt.schemaHash === proof.schemaHash && receipt.rowsHash === proof.rowsHash);
      await assertArtifact(path.join(location, 'artifacts', proof.migrationId + '.sqlite'), receipt.databaseHash, receipt.workerReceipt?.outputBytes);
      current();
    }
    if (!historical) await verifyOriginalSnapshot(root, approval, current);
    return true;
  } finally { migrations?.close(); ledger.close(); }
}
