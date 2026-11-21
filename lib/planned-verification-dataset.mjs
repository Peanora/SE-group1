import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPlannedEvolutionSeed, assertPlannedEvolutionSeedCurrent } from './planned-evolution-source.mjs';
import { assertCompiledManifest, compiledManifestDefinition } from './verification-contract.mjs';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';

const capabilities = new WeakMap(), receipts = new WeakMap(), migrationQueues = new WeakMap();
const keys = ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'sourceHash', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash'];
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const need = (value, code = 'invalid_verification_dataset') => { if (!value) throw Object.assign(new Error('旧数据验收副本、迁移回执或当前许可无法完整核对。'), { code }); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const phaseValue = value => { need(typeof value === 'string' && /^(?:self_check|http|browser-(?:DESKTOP|MOBILE)|race-(?:DESKTOP|MOBILE)-[A-Za-z0-9_-]{1,128})$/u.test(value)); return value; };
function bindingValue(raw) {
  const value = copyBrowserScenarioData(raw, 8192); need(value && Object.keys(value).length === keys.length && keys.every(key => typeof value[key] === 'string'));
  for (const key of ['projectId', 'runId', 'taskId', 'attemptId']) need(/^[A-Za-z0-9_-]{1,128}$/u.test(value[key]));
  for (const key of ['specRevision', 'planRevision', 'sourceHash', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash']) need(/^[a-f0-9]{64}$/u.test(value[key]));
  need(/^[a-f0-9]{40}$/u.test(value.candidateCommit)); return freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}
function bound(proof, { manifest, binding }) {
  need(proof && proof.manifest === manifest && digest(bindingValue(binding)) === proof.bindingHash, 'verification_dataset_binding_changed');
  assertCompiledManifest(manifest, Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, proof.binding[key]])));
  need(compiledManifestDefinition(manifest).manifestHash === proof.binding.manifestHash);
  return assertPlannedEvolutionSeedCurrent(proof.seed, proof.context);
}
async function checkedDirectory(target, create = false) {
  need(typeof target === 'string' && path.isAbsolute(target) && !target.includes('\0') && path.resolve(target) !== path.parse(target).root);
  target = path.resolve(target); let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await lstat(current); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(current), current));
  }
  return target;
}
async function databaseBytes(filename) {
  need(typeof filename === 'string' && path.isAbsolute(filename)); await checkedDirectory(path.dirname(filename));
  const before = await lstat(filename); need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= 32 * 1024 * 1024 && samePath(await realpath(filename), filename));
  const bytes = await readFile(filename), after = await lstat(filename);
  need(bytes.length === before.size && after.size === before.size && after.ino === before.ino && after.dev === before.dev && after.nlink === 1 && !after.isSymbolicLink()); return bytes;
}

/** Private admission for one frozen candidate; JSON metadata cannot seed a database. */
export async function createPlannedVerificationDataset({ evolutionSeed, context, manifest, binding } = {}) {
  const normalized = bindingValue(binding), expected = freeze(copyBrowserScenarioData(context, 512 * 1024));
  const value = await assertPlannedEvolutionSeed(evolutionSeed, expected);
  need(['projectId', 'runId', 'specRevision', 'planRevision'].every(key => normalized[key] === value.targetBinding[key]));
  const proof = { seed: evolutionSeed, context: expected, manifest, binding: normalized, bindingHash: digest(normalized), seedHash: value.seedHash,
    migration: value.provenance.migration, snapshotHash: value.provenance.snapshot.snapshotHash, service: value.datasetService,
    migrate: value.datasetService.migrate, readResult: value.datasetService.readResult, snapshotHandle: value.snapshotHandle,
    compiledPlan: value.compiledMigrationPlan, targetBinding: value.targetBinding, workspaces: new Set(), phases: new Set() };
  need(typeof proof.migrate === 'function' && typeof proof.readResult === 'function'); bound(proof, { manifest, binding });
  const handle = Object.freeze({ kind: 'planned_verification_dataset', id: randomUUID() }); capabilities.set(handle, proof); return handle;
}

/** Each independent check receives its own newly migrated copy, before runtime start. */
export async function preparePlannedVerificationDataset(handle, { workspace, manifest, binding, phase, signal } = {}) {
  const proof = capabilities.get(handle); phaseValue(phase); bound(proof, { manifest, binding });
  need(signal === undefined || signal instanceof AbortSignal); need(!signal?.aborted, 'verification_dataset_cancelled');
  const target = await checkedDirectory(workspace); bound(proof, { manifest, binding });
  const name = process.platform === 'win32' ? target.toLowerCase() : target;
  need(!proof.workspaces.has(name) && !proof.phases.has(phase), 'verification_dataset_already_prepared');
  proof.workspaces.add(name); proof.phases.add(phase);
  const current = () => {
    need(!signal?.aborted, 'verification_dataset_cancelled'); bound(proof, { manifest, binding });
    need(proof.service.migrate === proof.migrate && proof.service.readResult === proof.readResult, 'verification_dataset_service_changed');
  };
  current();
  const previous = migrationQueues.get(proof.service) ?? Promise.resolve();
  const migration = previous.catch(() => {}).then(() => { current(); return proof.migrate.call(proof.service, { snapshotHandle: proof.snapshotHandle, compiledPlan: proof.compiledPlan,
    targetBinding: proof.targetBinding, candidateCommit: proof.binding.candidateCommit }, { signal }); });
  migrationQueues.set(proof.service, migration); migration.catch(() => {});
  const result = await migration; current();
  const first = await proof.readResult.call(proof.service, result); current();
  const receipt = first.receipt;
  need(receipt?.terminationConfirmed === true && receipt.candidateCommit === proof.binding.candidateCommit && receipt.inputSnapshotHash === proof.snapshotHash
    && receipt.migrationRevision === proof.migration.revision && receipt.operationsHash === proof.migration.operationsHash);
  need(Array.isArray(receipt.processes) && receipt.processes.length > 0 && receipt.processes.every(item => item.terminationConfirmed === true && item.exitCode === 0 && !item.stopReason && !item.truncated));
  const bytes = await databaseBytes(first.databasePath); current(); need(digest(bytes) === receipt.databaseHash);
  const dataDirectory = await checkedDirectory(path.join(target, '.platform', 'tmp'), true); current();
  const filename = path.join(dataDirectory, 'app.sqlite'); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); current();
  need(digest(await databaseBytes(filename)) === receipt.databaseHash); current();
  const last = await proof.readResult.call(proof.service, result); current();
  need(first.databasePath === last.databasePath && digest(receipt) === digest(last.receipt));
  // Refresh the complete asynchronous source audit, then publish without another await.
  const latest = await assertPlannedEvolutionSeed(proof.seed, proof.context, { signal }); current(); need(latest.seedHash === proof.seedHash);
  const value = freeze({ version: 1, kind: 'planned_verification_dataset', seedHash: proof.seedHash, binding: proof.binding, phase,
    inputSnapshotHash: proof.snapshotHash, migrationRevision: receipt.migrationRevision, operationsHash: receipt.operationsHash,
    migrationId: receipt.id, migrationReceiptHash: digest(receipt), databaseHash: receipt.databaseHash, schemaHash: receipt.schemaHash, rowsHash: receipt.rowsHash,
    terminationConfirmed: true, processes: receipt.processes.map(item => ({ kind: 'dataset_migration', pid: item.pid ?? null, status: 'stopped', exitCode: item.exitCode, terminationConfirmed: true })) });
  receipts.set(value, { capability: handle, hash: digest(value), phase }); return value;
}

/** Only the original receipt object can enter the current candidate's trusted gate. */
export function assertPlannedVerificationDatasetReceipt(handle, receipt, { manifest, binding, phase } = {}) {
  const proof = capabilities.get(handle), issued = receipts.get(receipt); phaseValue(phase); bound(proof, { manifest, binding });
  need(issued?.capability === handle && issued.phase === phase && digest(receipt) === issued.hash && receipt.seedHash === proof.seedHash
    && receipt.inputSnapshotHash === proof.snapshotHash && receipt.migrationRevision === proof.migration.revision
    && receipt.operationsHash === proof.migration.operationsHash && receipt.terminationConfirmed === true, 'invalid_verification_dataset_receipt');
  return receipt;
}
