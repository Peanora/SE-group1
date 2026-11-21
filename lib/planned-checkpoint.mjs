import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';
import { isPlannedWebTaskAccepted, assertPlannedEvolutionAcceptance } from './planned-web-executor.mjs';
import { assertCompiledManifest, isTaskCompiledManifest } from './verification-contract.mjs';
import { isPlannedTaskRunAccepted, plannedTaskIntegration } from './planned-task-executor.mjs';

const permits = new WeakMap(), digest = value => createHash('sha256').update(value).digest('hex');
const need = value => { if (!value) throw new Error('已验收检查点的身份、私有封签或当前策略无法完整核对。'); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const dataHash = value => digest(JSON.stringify(canonical(copyBrowserScenarioData(value, 32 * 1024 * 1024, { maxNodes: 250000 }))));
function identity(row, record) {
  need(row && typeof row === 'object' && row.status === 'accepted' && row.active === 0 && record?.status === 'accepted' && row.project_id === record.projectId && row.run_id === record.runId);
  const binding = JSON.parse(row.binding), budget = JSON.parse(row.budget);
  need(['specRevision', 'planRevision'].every(key => binding[key] === record[key]) && typeof row.id === 'string' && typeof row.proposal_id === 'string' && /^[a-f0-9]{64}$/u.test(row.definition_revision));
  return { executionId: row.id, projectId: row.project_id, runId: row.run_id, proposalId: row.proposal_id, definitionRevision: row.definition_revision,
    createdAt: row.created_at, binding, budget, coreId: record.id, attemptId: record.attemptId, candidateCommit: record.candidateCommit,
    manifestHash: record.manifestHash, browserPolicyHash: record.browserPolicyHash, reviewPolicyHash: record.reviewPolicyHash, executorPolicyHash: record.executorPolicyHash };
}
async function directory(root) {
  need(typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) !== path.parse(root).root);
  for (let current = path.resolve(root);; current = path.dirname(current)) {
    const info = await lstat(current); need(info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(current), current));
    if (current === path.dirname(current)) return;
  }
}

/** Only the owning controller uses this file and returned methods. No HTTP key or signature input exists. */
export async function createPlannedCheckpoints({ rootDir, hasCheckpoints = false } = {}) {
  need(typeof hasCheckpoints === 'boolean'); await directory(rootDir);
  const filename = path.join(rootDir, '.accepted-checkpoint.key'); let key, fingerprint, closed = false;
  try {
    let info;
    try { info = await lstat(filename); }
    catch (error) {
      if (error.code !== 'ENOENT' || hasCheckpoints) throw error;
      const handle = await open(filename, 'wx', 0o600);
      try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      info = await lstat(filename);
    }
    need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === 32 && samePath(await realpath(filename), filename));
    key = await readFile(filename); const after = await lstat(filename);
    need(key.length === 32 && after.ino === info.ino && after.dev === info.dev && after.size === 32 && !after.isSymbolicLink() && after.nlink === 1);
    fingerprint = digest(key);
  } catch { key?.fill(0); key = null; }
  const instanceId = key ? fingerprint.slice(0, 32) : null;
  function available() {
    if (closed || !key) return false;
    try { const info = lstatSync(filename); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === 32 && samePath(realpathSync(filename), filename) && digest(readFileSync(filename)) === fingerprint; } catch { return false; }
  }
  function payload(row, record, executionRecord) {
    const execution = executionRecord === undefined ? null : copyBrowserScenarioData(executionRecord, 32 * 1024 * 1024, { maxNodes: 250000 });
    if (execution) need(execution.profileId === 'planned-task-run-v1' && execution.status === 'accepted' && execution.terminationConfirmed === true
      && execution.projectId === record.projectId && execution.runId === record.runId && execution.executorPolicyHash === record.executorPolicyHash
      && execution.integration && dataHash(execution.integration) === dataHash(record));
    const budget = JSON.parse(row.budget), actual = execution ?? record;
    return { purpose: 'taskflow/planned-accepted/v1', version: 1, instanceId, identity: identity(row, record), recordHash: dataHash(record),
      ...(execution ? { executionRecordHash: dataHash(execution) } : {}),
      settlement: { actualCalls: actual.totalModelCalls, usage: actual.usage, releasedReservation: budget.attemptModelCalls ?? budget.maxCalls + budget.maxReviewCalls } };
  }
  function signature(value) { return createHmac('sha256', key).update(JSON.stringify(canonical(value))).digest('hex'); }
  function evolutionSummary(record, manifest) {
    const evo = record.evolutionSource, last = record.versions?.at(-1);
    need(evo && record.evolutionMigration && last?.selfCheck?.dataset && last.acceptance?.test?.dataset && Array.isArray(last.acceptance?.browser?.dataset));
    return { version: 1, purpose: 'taskflow/evolution-validation-history/v1', seedHash: record.evolutionSeedHash,
      candidateCommit: record.candidateCommit, sourceHash: last.sourceHash, manifestHash: manifest.manifestHash,
      inputSnapshotHash: evo.snapshot.snapshotHash, inputSchemaHash: evo.snapshot.schemaHash, migrationRevision: evo.migration.revision,
      operationsHash: evo.migration.operationsHash,
      datasetReceiptsHash: dataHash([last.selfCheck.dataset, last.acceptance.test.dataset, ...last.acceptance.browser.dataset]) };
  }
  return Object.freeze({ available, instanceId,
    sign({ row, record, manifest, executionRecord }) {
      need(available() && !record.evolutionSource && !isTaskCompiledManifest(manifest) && isPlannedWebTaskAccepted(record, manifest));
      need(record.taskExecution?.integration !== true || executionRecord);
      if (executionRecord !== undefined) need(isPlannedTaskRunAccepted(executionRecord, manifest) && plannedTaskIntegration(executionRecord, manifest) === record);
      const value = payload(row, record, executionRecord); return Object.freeze({ version: 1, instanceId, recordHash: value.recordHash,
        ...(value.executionRecordHash ? { executionRecordHash: value.executionRecordHash } : {}), signature: signature(value) });
    },
    verify({ row, record, seal, policyHash, manifest, executionRecord }) {
      need(available() && !record.evolutionSource && !isTaskCompiledManifest(manifest) && seal?.version === 1 && seal.instanceId === instanceId && /^[a-f0-9]{64}$/u.test(seal.signature ?? '') && policyHash === record.executorPolicyHash);
      need(record.taskExecution?.integration !== true || executionRecord);
      const value = payload(row, record, executionRecord), expected = signature(value);
      need(seal.recordHash === value.recordHash && seal.executionRecordHash === value.executionRecordHash && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(seal.signature, 'hex')));
      assertCompiledManifest(manifest, Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, record[key]])));
      need(manifest.manifestHash === record.manifestHash);
      const handle = Object.freeze({ kind: 'persisted_planned_checkpoint', id: randomUUID() });
      permits.set(handle, { executionId: row.id, record, manifest, recordHash: value.recordHash, policyHash, manifestHash: record.manifestHash, live: available,
        purpose: value.purpose, executionRecord, executionRecordHash: value.executionRecordHash }); return handle;
    },
    signEvolution({ row, record, manifest, executionRecord }) {
      need(available() && !isTaskCompiledManifest(manifest) && executionRecord === undefined && record.taskExecution?.integration !== true);
      const summary = assertPlannedEvolutionAcceptance(record, manifest), expected = evolutionSummary(record, manifest);
      need(dataHash(summary) === dataHash(expected));
      const value = { ...payload(row, record), purpose: 'taskflow/planned-evolution-accepted/v1', version: 3, evolution: summary };
      return Object.freeze({ version: 3, purpose: value.purpose, instanceId, recordHash: value.recordHash, evolution: summary, signature: signature(value) });
    },
    verifyEvolution({ row, record, seal, policyHash, manifest, executionRecord }) {
      need(available() && !isTaskCompiledManifest(manifest) && executionRecord === undefined && record.taskExecution?.integration !== true && seal?.version === 3
        && seal.purpose === 'taskflow/planned-evolution-accepted/v1' && seal.instanceId === instanceId && /^[a-f0-9]{64}$/u.test(seal.signature ?? '') && policyHash === record.executorPolicyHash);
      const summary = evolutionSummary(record, manifest), value = { ...payload(row, record), purpose: seal.purpose, version: 3, evolution: summary };
      need(seal.recordHash === value.recordHash && dataHash(seal.evolution) === dataHash(summary) && timingSafeEqual(Buffer.from(signature(value), 'hex'), Buffer.from(seal.signature, 'hex')));
      assertCompiledManifest(manifest, Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, record[key]])));
      need(manifest.manifestHash === record.manifestHash);
      const handle = Object.freeze({ kind: 'persisted_planned_evolution_checkpoint', id: randomUUID() });
      permits.set(handle, { executionId: row.id, record, manifest, recordHash: value.recordHash, policyHash, manifestHash: record.manifestHash, live: available, purpose: value.purpose }); return handle;
    },
    async signWorker({ row, record, manifest, executionRecord, permit, store, jobId }) {
      need(available() && !isTaskCompiledManifest(manifest));
      const { assertVerifiedWorkerResult } = await import('./planned-worker-seals.mjs');
      const worker = assertVerifiedWorkerResult(permit, { store, jobId, record, graph: executionRecord, manifest });
      need(available() && worker.executionId === row.id && worker.manifestHash === manifest.manifestHash && worker.settlement.terminationConfirmed === true);
      const value = { ...payload(row, record, executionRecord), purpose: 'taskflow/planned-worker-accepted/v1', worker };
      need(value.settlement.actualCalls === worker.settlement.actualCalls && dataHash({ ...value.settlement, terminationConfirmed: true }) === dataHash(worker.settlement));
      return Object.freeze({ version: 2, purpose: value.purpose, instanceId, recordHash: value.recordHash,
        ...(value.executionRecordHash ? { executionRecordHash: value.executionRecordHash } : {}), worker, signature: signature(value) });
    },
    verifyWorker({ row, record, seal, policyHash, manifest, executionRecord }) {
      need(available() && !isTaskCompiledManifest(manifest) && seal?.version === 2 && seal.purpose === 'taskflow/planned-worker-accepted/v1'
        && seal.instanceId === instanceId && /^[a-f0-9]{64}$/u.test(seal.signature ?? '') && policyHash === record.executorPolicyHash
        && (record.taskExecution?.integration !== true || executionRecord));
      const value = { ...payload(row, record, executionRecord), purpose: seal.purpose, worker: seal.worker }, expected = signature(value);
      need(seal.recordHash === value.recordHash && seal.executionRecordHash === value.executionRecordHash && seal.worker?.executionId === row.id
        && seal.worker.manifestHash === manifest.manifestHash && dataHash(seal.worker.settlement) === dataHash({ ...value.settlement, terminationConfirmed: true })
        && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(seal.signature, 'hex')));
      assertCompiledManifest(manifest, Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, record[key]])));
      need(manifest.manifestHash === record.manifestHash);
      const handle = Object.freeze({ kind: 'persisted_planned_worker_checkpoint', id: randomUUID() });
      permits.set(handle, { executionId: row.id, record, manifest, recordHash: value.recordHash, policyHash, manifestHash: record.manifestHash, live: available,
        purpose: value.purpose, executionRecord, executionRecordHash: value.executionRecordHash }); return handle;
    },
    close() { if (closed) return; closed = true; key?.fill(0); },
  });
}

/** A JSON record, signature string or known key cannot replace this private verification permit. */
export function assertPlannedCheckpoint(handle, { executionId, record, manifest, policyHash, executionRecord, purpose }) {
  const proof = permits.get(handle);
  need(proof?.live() && (purpose === undefined || proof.purpose === purpose) && proof.record === record && proof.manifest === manifest && proof.executionId === executionId && proof.recordHash === dataHash(record) && proof.policyHash === policyHash && proof.manifestHash === manifest?.manifestHash);
  need(!proof.executionRecord || dataHash(proof.executionRecord) === proof.executionRecordHash);
  if (executionRecord !== undefined) need(proof.executionRecord === executionRecord);
  return true;
}
