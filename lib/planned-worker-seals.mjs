import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { assertCompiledManifest, isTaskCompiledManifest } from './verification-contract.mjs';
import { isPlannedWebTaskAccepted } from './planned-web-executor.mjs';
import { isPlannedTaskRunAccepted, plannedTaskIntegration, auditPausedTaskCheckpoint, assertPausedTaskCheckpoint, assertRetiredTaskCheckpoint } from './planned-task-executor.mjs';
import { inspectFrozenTaskHandoff, inspectConsumedTaskHandoff } from './task-store.mjs';
import { inspectPlannedSource } from './planned-source.mjs';
import path from 'node:path';
import { assertPlannedWorkerStore } from './planned-worker-store.mjs';
import { assertExecutionSubjectCurrent } from './team-access.mjs';
import { hasCompletePlannedModelReceipt } from './planned-call-history.mjs';
import { WORKER_AUTH_PURPOSE, WORKER_RESULT_PURPOSE, WORKER_OUTCOME_PURPOSE, WORKER_CHECKPOINT_PURPOSE as PAUSED_PURPOSE, WORKER_RETIREMENT_PURPOSE as RETIRED_PURPOSE, WORKER_RESUME_PURPOSE as RESUME_PURPOSE, workerCopy, workerExact, workerFreeze, workerHash, workerNeed, workerPolicyHash } from './planned-worker-contract.mjs';

const signers = new WeakMap(), permits = new WeakMap(), outcomePermits = new WeakMap(), authorities = new WeakMap();
const signedPauses = new WeakMap(), signedRetirements = new WeakMap(), handoffPermits = new WeakMap(), resumePermits = new WeakMap();
const retirementCostPermits = new WeakMap();
const confirmedExits = new WeakMap();
const baseKeys = ['projectId', 'runId', 'specRevision', 'planRevision'];
const fingerprint = key => createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex');
function validSignature(body, signature, publicKey) {
  try { workerNeed(typeof signature === 'string' && signature.length <= 256 && typeof publicKey === 'string' && publicKey.length <= 1024); return verify(null, Buffer.from(workerHash(body)), createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signature, 'base64')); } catch { return false; }
}
export function createWorkerAuthority({ store } = {}) { assertPlannedWorkerStore(store); const authority = Object.freeze({ kind: 'worker_authority', id: randomUUID() }); authorities.set(authority, store); return authority; }
export function signWorkerAuthorization({ authority, job } = {}) { const store = authorities.get(authority); workerNeed(store, 'worker_authority_required'); return store.signAuthorization(job); }

/** The fixed Worker verifies the stored issuer before locally rebuilding a manifest. */
export function verifyWorkerAuthorization({ store, jobId } = {}) {
  assertPlannedWorkerStore(store); const row = store.get(jobId), envelope = row?.authorization; workerNeed(row && envelope?.body?.purpose === WORKER_AUTH_PURPOSE
    && envelope.body.jobId === row.id && envelope.body.executionId === row.execution_id && envelope.body.rootIdentity === store.identity && envelope.body.policyHash === workerPolicyHash()
    && workerHash(envelope.body) === row.grant_hash && envelope.issuerPublicKey === row.issuer && row.issuer === store.issuerPublicKey && validSignature(envelope.body, envelope.signature, row.issuer), 'worker_authorization_signature');
  return workerFreeze(workerCopy(envelope.body));
}

/** Result keys are generated only in their own OS process and are never exported. */
export function createWorkerResultSigner() {
  const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const handle = Object.freeze({ kind: 'worker_result_signer', id: randomUUID(), publicKey }); signers.set(handle, { privateKey: pair.privateKey, publicKey, pid: process.pid }); return handle;
}
export function signCompletedWorkerResult({ signer, store, lease, manifest, record, graph } = {}) {
  const key = signers.get(signer); workerNeed(key && key.pid === process.pid); assertPlannedWorkerStore(store); const job = store.assertWorker(lease), grant = verifyWorkerAuthorization({ store, jobId: job.id });
  assertExecutionSubjectCurrent(grant.subject);
  workerNeed(job.registration.publicKey === key.publicKey && !isTaskCompiledManifest(manifest) && manifest.manifestHash === grant.definition.manifestHash && isPlannedWebTaskAccepted(record, manifest), 'worker_original_acceptance_required');
  workerNeed(record.taskExecution?.integration !== true || graph, 'worker_graph_required');
  if (grant.mode === 'graph') workerNeed(graph && isPlannedTaskRunAccepted(graph, manifest) && plannedTaskIntegration(graph, manifest) === record);
  else workerNeed(graph === undefined);
  const actual = graph ?? record, calls = actual.modelCalls; workerNeed(actual.terminationConfirmed === true && calls.length > 0 && actual.totalModelCalls === calls.filter(call => call.kind === 'model' && call.dispatched !== false).length && actual.totalModelCalls <= grant.budget.maxModelCalls);
  workerNeed(calls.every(hasCompletePlannedModelReceipt));
  const journal = store.calls(job.id); workerNeed(journal.length === calls.length && calls.every(call => journal.some(item => item.call_id === call.id && item.state === 'receipt_complete' && item.receipt_hash === call.receiptHash && workerHash(item.usage) === workerHash(call.usage))), 'worker_call_journal_mismatch');
  const generationChainHash = verifyGenerationHistory(store, job.id);
  workerNeed(baseKeys.every(name => record[name] === grant.binding[name]) && Date.parse(actual.finishedAt) <= grant.deadlineAt);
  const body = workerFreeze(workerCopy({ version: 1, purpose: WORKER_RESULT_PURPOSE, jobId: job.id, executionId: job.execution_id, grantHash: job.grant_hash,
    instanceId: job.registration.instanceId, generation: job.registration.generation, publicKeyFingerprint: fingerprint(key.publicKey), policyHash: grant.policyHash,
    subjectHash: workerHash(grant.subject), generationChainHash, manifestHash: manifest.manifestHash, taskSetHash: manifest.taskSetHash ?? null, recordHash: workerHash(record), graphHash: graph ? workerHash(graph) : null,
    candidateCommit: record.candidateCommit, sourceHash: record.versions.at(-1).sourceHash, shellHash: record.shellHash, receiptSetHash: workerHash(calls.map(call => ({ id: call.id, hash: call.receiptHash, usage: call.usage }))),
    callJournalHash: workerHash(journal), eventSeq: job.event_seq, eventHash: job.event_hash, deadlineAt: grant.deadlineAt, completedAt: actual.finishedAt,
    settlement: { actualCalls: actual.totalModelCalls, usage: actual.usage, releasedReservation: grant.budget.maxModelCalls, terminationConfirmed: true } }));
  return { body, signature: sign(null, Buffer.from(workerHash(body)), key.privateKey).toString('base64') };
}

/** Evidence resolver is a trusted W4 boundary; it must recheck fixed Git/source/shell/receipt files. */
export async function verifyWorkerResult({ store, jobId, envelope, record, graph, manifest, assertCurrent, verifyEvidence } = {}) {
  assertPlannedWorkerStore(store); workerNeed(typeof assertCurrent === 'function' && typeof verifyEvidence === 'function');
  const current = () => { const value = assertCurrent(); workerNeed(value !== false && !value?.then); assertCompiledManifest(manifest, Object.fromEntries(baseKeys.map(key => [key, record?.[key]]))); workerNeed(!isTaskCompiledManifest(manifest)); };
  current(); const row = store.get(jobId), grant = verifyWorkerAuthorization({ store, jobId }), packet = workerCopy(envelope), body = packet.body;
  assertExecutionSubjectCurrent(grant.subject);
  workerNeed(body.generationChainHash === verifyGenerationHistory(store, jobId), 'worker_generation_chain_changed');
  workerNeed(row?.status === 'terminal' && row.result?.envelope && workerHash(row.result.envelope) === workerHash(packet), 'worker_terminal_not_registered');
  workerExact(packet, ['body', 'signature']); workerNeed(row?.registration && body?.version === 1 && body.purpose === WORKER_RESULT_PURPOSE && body.jobId === jobId
    && body.executionId === row.execution_id && body.grantHash === row.grant_hash && body.instanceId === row.registration.instanceId && body.generation === row.registration.generation
    && body.publicKeyFingerprint === fingerprint(row.registration.publicKey) && body.policyHash === grant.policyHash && body.manifestHash === manifest.manifestHash
    && body.subjectHash === workerHash(grant.subject) && body.taskSetHash === (manifest.taskSetHash ?? null) && body.recordHash === workerHash(record) && body.graphHash === (graph ? workerHash(graph) : null)
    && body.deadlineAt === grant.deadlineAt && Date.parse(body.completedAt) <= grant.deadlineAt && validSignature(body, packet.signature, row.registration.publicKey), 'worker_result_signature');
  workerNeed(record.status === 'accepted' && record.terminationConfirmed === true && baseKeys.every(key => record[key] === grant.binding[key]) && body.candidateCommit === record.candidateCommit
    && body.sourceHash === record.versions?.at(-1)?.sourceHash && body.shellHash === record.shellHash && record.manifestHash === manifest.manifestHash);
  workerNeed(grant.mode === 'graph' ? graph?.status === 'accepted' && graph.terminationConfirmed === true && graph.tasks?.every(task => task.status === 'completed') && workerHash(graph.integration) === workerHash(record) : graph === undefined);
  const actual = graph ?? record, calls = actual.modelCalls;
  workerNeed(calls.length > 0 && calls.every(hasCompletePlannedModelReceipt), 'worker_incomplete_call_history');
  workerNeed(body.settlement.actualCalls === actual.totalModelCalls && actual.totalModelCalls <= grant.budget.maxModelCalls && body.settlement.releasedReservation === grant.budget.maxModelCalls
    && body.settlement.terminationConfirmed === true && workerHash(body.settlement.usage) === workerHash(actual.usage)
    && body.receiptSetHash === workerHash(calls.map(call => ({ id: call.id, hash: call.receiptHash, usage: call.usage }))) && body.callJournalHash === workerHash(store.calls(jobId)), 'worker_settlement_mismatch');
  const recordHash = workerHash(record), graphHash = graph ? workerHash(graph) : null, registrationHash = workerHash(row.registration), result = await verifyEvidence({ record, graph, manifest, authorization: grant, envelope: packet });
  workerNeed(result === true, 'worker_evidence_rejected'); current(); assertExecutionSubjectCurrent(grant.subject); workerNeed(workerHash(record) === recordHash && (graph ? workerHash(graph) : null) === graphHash && workerHash(store.get(jobId)?.registration) === registrationHash && store.get(jobId)?.status !== 'revoked');
  const permit = Object.freeze({ kind: 'verified_worker_result', id: randomUUID() }); permits.set(permit, { store, jobId, record, graph, manifest, recordHash, graphHash, registrationHash, body, envelopeHash: workerHash(packet), current }); return permit;
}
export function assertVerifiedWorkerResult(permit, { store, jobId, record, graph, manifest } = {}) {
  const proof = permits.get(permit); workerNeed(proof && proof.store === store && proof.jobId === jobId && proof.record === record && proof.graph === graph && proof.manifest === manifest
    && proof.recordHash === workerHash(record) && proof.graphHash === (graph ? workerHash(graph) : null), 'worker_result_permit_required');
  proof.current(); workerNeed(workerHash(store.get(jobId)?.registration) === proof.registrationHash && store.get(jobId)?.status !== 'revoked' && proof.body.policyHash === workerPolicyHash() && proof.body.generationChainHash === verifyGenerationHistory(store, jobId));
  assertExecutionSubjectCurrent(verifyWorkerAuthorization({ store, jobId }).subject);
  return workerFreeze(workerCopy({ ...proof.body, envelopeHash: proof.envelopeHash }));
}

function knownOutcome(actual, journal, grant) {
  workerNeed(actual && ['failed', 'stopped', 'timed_out'].includes(actual.status) && actual.terminationConfirmed === true && Array.isArray(actual.modelCalls));
  const calls = actual.modelCalls, ids = new Set(calls.map(call => call.id));
  workerNeed(ids.size === calls.length && Number.isSafeInteger(actual.totalModelCalls) && actual.totalModelCalls >= 0 && actual.totalModelCalls === calls.filter(call => call.kind === 'model' && call.dispatched !== false).length
    && actual.totalModelCalls <= grant.budget.maxModelCalls && calls.every(call => call.kind === 'model' && call.terminationConfirmed === true)
    && journal.every(item => ids.has(item.call_id)), 'worker_outcome_calls');
  for (const call of calls) {
    const item = journal.find(item => item.call_id === call.id);
    if (call.dispatched === false) workerNeed(call.usage?.inputTokens === 0 && call.usage?.outputTokens === 0 && (!item || item.state === 'not_dispatched'), 'worker_outcome_calls');
    else workerNeed(item && (call.receiptConfirmed ? item.state === 'receipt_complete' && item.receipt_hash === call.receiptHash : item.state === 'unknown')
      && workerHash(item.usage) === workerHash(call.usage), 'worker_outcome_calls');
  }
}

/** Separate known-stop proof: it never grants software acceptance or delivery. */
export function signStoppedWorkerResult({ signer, store, lease, manifest, record, graph } = {}) {
  const key = signers.get(signer); workerNeed(key && key.pid === process.pid); assertPlannedWorkerStore(store);
  const job = store.assertTerminalWorker(lease), grant = verifyWorkerAuthorization({ store, jobId: job.id }), actual = graph ?? record, journal = store.calls(job.id);
  workerNeed(job.registration.publicKey === key.publicKey && !isTaskCompiledManifest(manifest) && manifest.manifestHash === grant.definition.manifestHash
    && baseKeys.every(name => actual[name] === grant.binding[name]) && (grant.mode === 'graph' ? graph && graph === record : graph === undefined));
  knownOutcome(actual, journal, grant);
  const body = workerFreeze(workerCopy({ version: 1, purpose: WORKER_OUTCOME_PURPOSE, jobId: job.id, executionId: job.execution_id, grantHash: job.grant_hash,
    instanceId: job.registration.instanceId, generation: job.registration.generation, publicKeyFingerprint: fingerprint(key.publicKey), policyHash: grant.policyHash,
    manifestHash: manifest.manifestHash, generationChainHash: verifyGenerationHistory(store, job.id), recordHash: workerHash(record), graphHash: graph ? workerHash(graph) : null, callJournalHash: workerHash(journal),
    status: actual.status, completedAt: actual.finishedAt, deadlineAt: grant.deadlineAt,
    settlement: { actualCalls: actual.totalModelCalls, usage: actual.usage, releasedReservation: grant.budget.maxModelCalls, terminationConfirmed: true } }));
  return { body, signature: sign(null, Buffer.from(workerHash(body)), key.privateKey).toString('base64') };
}

export async function verifyWorkerOutcome({ store, jobId, envelope, record, graph, manifest, assertCurrent, verifyEvidence } = {}) {
  assertPlannedWorkerStore(store); workerNeed(typeof assertCurrent === 'function' && typeof verifyEvidence === 'function');
  const current = () => { const value = assertCurrent(); workerNeed(value !== false && !value?.then); assertCompiledManifest(manifest, Object.fromEntries(baseKeys.map(key => [key, record?.[key]]))); workerNeed(!isTaskCompiledManifest(manifest)); };
  current(); const row = store.get(jobId), grant = verifyWorkerAuthorization({ store, jobId }), packet = workerCopy(envelope), body = packet.body, actual = graph ?? record;
  workerExact(packet, ['body', 'signature']);
  workerNeed(row?.status === 'terminal' && row.result?.outcome && workerHash(row.result.outcome) === workerHash(packet) && body?.purpose === WORKER_OUTCOME_PURPOSE
    && body.jobId === jobId && body.executionId === row.execution_id && body.grantHash === row.grant_hash && body.instanceId === row.registration?.instanceId
    && body.generation === row.registration.generation && body.publicKeyFingerprint === fingerprint(row.registration.publicKey) && body.policyHash === grant.policyHash
    && body.manifestHash === manifest.manifestHash && body.recordHash === workerHash(record) && body.graphHash === (graph ? workerHash(graph) : null)
    && body.callJournalHash === workerHash(store.calls(jobId)) && body.generationChainHash === verifyGenerationHistory(store, jobId) && body.status === actual.status && body.deadlineAt === grant.deadlineAt
    && workerHash(body.settlement) === workerHash({ actualCalls: actual.totalModelCalls, usage: actual.usage, releasedReservation: grant.budget.maxModelCalls, terminationConfirmed: true })
    && validSignature(body, packet.signature, row.registration.publicKey), 'worker_outcome_signature');
  knownOutcome(actual, store.calls(jobId), grant);
  const recordHash = workerHash(record), graphHash = graph ? workerHash(graph) : null, registrationHash = workerHash(row.registration);
  workerNeed(await verifyEvidence({ record, graph, manifest, authorization: grant }) === true); current();
  workerNeed(workerHash(record) === recordHash && (graph ? workerHash(graph) : null) === graphHash && workerHash(store.get(jobId)?.registration) === registrationHash && store.get(jobId)?.status !== 'revoked');
  const permit = Object.freeze({ kind: 'verified_worker_stop', id: randomUUID() });
  outcomePermits.set(permit, { store, jobId, record, graph, manifest, recordHash, graphHash, registrationHash, body, envelopeHash: workerHash(packet), current }); return permit;
}
export function assertVerifiedWorkerOutcome(permit, { store, jobId, record, graph, manifest } = {}) {
  const proof = outcomePermits.get(permit); workerNeed(proof && proof.store === store && proof.jobId === jobId && proof.record === record && proof.graph === graph && proof.manifest === manifest
    && proof.recordHash === workerHash(record) && proof.graphHash === (graph ? workerHash(graph) : null), 'worker_outcome_permit_required');
  proof.current(); workerNeed(workerHash(store.get(jobId)?.registration) === proof.registrationHash && store.get(jobId)?.status !== 'revoked' && proof.body.policyHash === workerPolicyHash());
  return workerFreeze(workerCopy({ ...proof.body, envelopeHash: proof.envelopeHash }));
}

function boundManifest(manifest, grant) {
  assertCompiledManifest(manifest, Object.fromEntries(baseKeys.map(key => [key, grant.binding[key]])));
  workerNeed(!isTaskCompiledManifest(manifest) && manifest.manifestHash === grant.definition.manifestHash && manifest.taskSetHash === grant.definition.taskSetHash && grant.mode === 'graph');
}
function stoppedProcess(pid) {
  workerNeed(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid, 'worker_old_process_unconfirmed');
  try { process.kill(pid, 0); } catch (error) { workerNeed(error.code === 'ESRCH', 'worker_old_process_unconfirmed'); return true; }
  workerNeed(false, 'worker_old_process_unconfirmed');
}
/** Only an actual ESRCH observation can establish this fact. A later unrelated
 * process reusing that numeric PID cannot make the exited Worker live again. */
export async function confirmWorkerExit({ store, jobId, generation } = {}) {
  assertPlannedWorkerStore(store); const job = store.get(jobId), selected = store.generation(jobId, generation);
  workerNeed(job && selected?.registration && selected.status === 'retired', 'worker_retirement_required');
  const previous = store.observedWorkerExit(jobId, generation); if (previous) return previous;
  stoppedProcess(selected.registration.pid);
  const body = workerFreeze(workerCopy({ version: 1, purpose: 'taskflow/confirmed-worker-exit/v1', jobId, generation, grantHash: job.grant_hash,
    registrationHash: workerHash(selected.registration), observedAt: Date.now() }));
  const permit = Object.freeze({ kind: 'confirmed_os_worker_exit', id: randomUUID() }); confirmedExits.set(permit, { store, jobId, generation, body });
  return store.recordWorkerExit(permit, { jobId, generation });
}
export function assertConfirmedWorkerExit(permit, { store, jobId, generation } = {}) {
  const proof = confirmedExits.get(permit); workerNeed(proof?.store === store && proof.jobId === jobId && proof.generation === generation, 'worker_exit_capability_required');
  workerNeed(proof.body.grantHash === store.get(jobId)?.grant_hash && proof.body.registrationHash === workerHash(store.generation(jobId, generation)?.registration), 'worker_exit_observation_changed'); return proof.body;
}
function observedExit(store, jobId, generation) { workerNeed(store.observedWorkerExit(jobId, generation), 'worker_old_process_unconfirmed'); }
function handoffSignatures(store, jobId, generation) {
  const job = store.get(jobId), grant = verifyWorkerAuthorization({ store, jobId }), old = store.generation(jobId, generation), handoff = store.handoff(jobId, generation);
  const checkpoint = handoff?.checkpoint?.body, retirement = handoff?.retirement?.body;
  workerNeed(old?.status === 'retired' && old.registration && handoff && checkpoint?.purpose === PAUSED_PURPOSE && retirement?.purpose === RETIRED_PURPOSE, 'worker_retirement_required');
  for (const body of [checkpoint, retirement]) workerNeed(body.version === 1 && body.jobId === jobId && body.executionId === job.execution_id && body.grantHash === job.grant_hash
    && body.generation === generation && body.instanceId === old.registration.instanceId && body.publicKeyFingerprint === fingerprint(old.registration.publicKey)
    && body.policyHash === grant.policyHash && body.deadlineAt === grant.deadlineAt && body.subjectHash === workerHash(grant.subject));
  workerNeed(validSignature(checkpoint, handoff.checkpoint.signature, old.registration.publicKey) && validSignature(retirement, handoff.retirement.signature, old.registration.publicKey)
    && checkpoint.payloadHash === workerHash(handoff.payload) && retirement.checkpointEnvelopeHash === workerHash(handoff.checkpoint)
    && retirement.retirement.checkpointHash === workerHash(handoff.payload) && retirement.retirement.checkpointId === handoff.payload.checkpointId
    && retirement.retirement.graphId === handoff.payload.graphId && retirement.retirement.pid === old.registration.pid && retirement.retirement.terminationConfirmed === true
    && checkpoint.callJournalHash === workerHash(store.calls(jobId)) && retirement.eventSeq === job.event_seq && retirement.eventHash === job.event_hash && checkpoint.eventSeq <= retirement.eventSeq, 'worker_handoff_signature');
  return { job, grant, old, handoff };
}
async function auditHandoff({ store, jobId, generation, manifest, assertCurrent, historicalCostsOnly = false }) {
  const current = () => { const value = assertCurrent(); workerNeed(value !== false && !value?.then); const grant = verifyWorkerAuthorization({ store, jobId }); if (!historicalCostsOnly) { boundManifest(manifest, grant); assertExecutionSubjectCurrent(grant.subject); workerNeed(Date.now() < grant.deadlineAt); } return grant; };
  const grant = current(), checked = handoffSignatures(store, jobId, generation), payload = checked.handoff.payload;
  const withoutFreeze = workerCopy(payload); delete withoutFreeze.freeze;
  const root = store.jobDirectory(jobId), relative = value => { const rel = path.relative(root, value); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  workerNeed(relative(payload.taskRootDir) && relative(payload.taskDatabase) && path.join(payload.taskRootDir, 'tasks.sqlite') === payload.taskDatabase
    && payload.purpose === 'taskflow/task-dependency-checkpoint/v1' && payload.version === 1 && payload.graphId === payload.graph.id
    && payload.graph.status === 'paused' && payload.graph.tasks.some(task => task.status === 'completed') && payload.graph.tasks.some(task => task.status === 'pending')
    && payload.graph.tasks.every(task => ['completed', 'pending'].includes(task.status)) && workerHash(payload.task) === workerHash(grant.task)
    && payload.taskDefinitionHash === workerHash(grant.task) && payload.manifestHash === grant.definition.manifestHash && payload.taskSetHash === grant.definition.taskSetHash
    && [...baseKeys, 'sourceRevision', 'sourceGeneration'].every(key => payload.binding[key] === grant.binding[key])
    && payload.deadlineAt === grant.deadlineAt && (historicalCostsOnly || payload.deadlineAt > Date.now()) && payload.freeze.evidenceHash === workerHash(withoutFreeze)
    && payload.freeze.runId === grant.binding.runId && payload.graph.totalModelCalls <= grant.budget.maxModelCalls, 'worker_checkpoint_changed');
  const frozen = inspectFrozenTaskHandoff({ filename: payload.taskDatabase, runId: grant.binding.runId, checkpointId: payload.checkpointId });
  workerNeed(workerHash(frozen) === workerHash(payload.freeze), 'worker_frozen_state_changed');
  const calls = payload.graph.modelCalls, journal = store.calls(jobId);
  workerNeed(Array.isArray(calls) && calls.length > 0 && journal.length === calls.length && payload.graph.totalModelCalls === calls.filter(call => call.kind === 'model' && call.dispatched !== false).length
    && calls.every(call => hasCompletePlannedModelReceipt(call)
      && journal.some(item => item.call_id === call.id && item.state === 'receipt_complete' && item.receipt_hash === call.receiptHash && workerHash(item.usage) === workerHash(call.usage))), 'worker_checkpoint_calls');
  const signal = AbortSignal.timeout(historicalCostsOnly ? 60000 : Math.min(60000, Math.max(1, grant.deadlineAt - Date.now()))), paths = grant.task.tasks.flatMap(task => task.writePaths ?? task.suggestedFiles);
  for (const entry of payload.graph.tasks.filter(task => task.status === 'completed')) for (const record of [...(entry.history ?? []), entry.record].filter(Boolean)) {
    current(); workerNeed(record.terminationConfirmed === true && relative(record.reportPath));
    await inspectPlannedSource({ rootDir: root, reportPath: record.reportPath, expectedRecord: record, binding: { projectId: grant.binding.projectId, specRevision: grant.binding.specRevision, planRevision: grant.binding.planRevision }, writablePaths: paths, signal }); current();
  }
  current(); workerNeed(workerHash(inspectFrozenTaskHandoff({ filename: payload.taskDatabase, runId: grant.binding.runId, checkpointId: payload.checkpointId })) === workerHash(frozen));
  return { ...checked, current, payloadHash: workerHash(payload) };
}
export async function signPausedWorkerCheckpoint({ signer, store, lease, manifest, checkpoint } = {}) {
  const key = signers.get(signer), job = store.assertWorker(lease), grant = verifyWorkerAuthorization({ store, jobId: job.id }); workerNeed(key?.pid === process.pid && key.publicKey === job.registration.publicKey);
  boundManifest(manifest, grant); assertExecutionSubjectCurrent(grant.subject);
  await auditPausedTaskCheckpoint(checkpoint, { manifest }); const payload = assertPausedTaskCheckpoint(checkpoint, { manifest });
  const body = workerFreeze(workerCopy({ version: 1, purpose: PAUSED_PURPOSE, jobId: job.id, executionId: job.execution_id, grantHash: job.grant_hash,
    generation: job.registration.generation, instanceId: job.registration.instanceId, publicKeyFingerprint: fingerprint(key.publicKey), policyHash: grant.policyHash,
    subjectHash: workerHash(grant.subject), deadlineAt: grant.deadlineAt, payloadHash: workerHash(payload), callJournalHash: workerHash(store.calls(job.id)), eventSeq: job.event_seq, eventHash: job.event_hash }));
  assertExecutionSubjectCurrent(grant.subject); const envelope = workerFreeze({ body, signature: sign(null, Buffer.from(workerHash(body)), key.privateKey).toString('base64') });
  signedPauses.set(envelope, { signer, store, lease, manifest, checkpoint, payload }); return envelope;
}
export function signRetiredWorkerCheckpoint({ signer, store, lease, manifest, checkpoint, retirement, envelope } = {}) {
  const proof = signedPauses.get(envelope), key = signers.get(signer), job = store.assertWorker(lease), grant = verifyWorkerAuthorization({ store, jobId: job.id });
  workerNeed(proof?.signer === signer && proof.store === store && proof.lease === lease && proof.manifest === manifest && proof.checkpoint === checkpoint && key?.pid === process.pid);
  const retired = assertRetiredTaskCheckpoint(retirement, { checkpoint, manifest }); assertExecutionSubjectCurrent(grant.subject);
  workerNeed(workerHash(assertPausedTaskCheckpoint(checkpoint, { manifest })) === envelope.body.payloadHash && workerHash(store.calls(job.id)) === envelope.body.callJournalHash);
  const body = workerFreeze(workerCopy({ ...envelope.body, purpose: RETIRED_PURPOSE, eventSeq: job.event_seq, eventHash: job.event_hash, checkpointEnvelopeHash: workerHash(envelope), retirement: retired }));
  const result = workerFreeze({ body, signature: sign(null, Buffer.from(workerHash(body)), key.privateKey).toString('base64') }); signedRetirements.set(result, { ...proof, envelope }); return result;
}
export function assertSignedWorkerHandoff({ checkpoint, retirement, manifest, store, lease }) {
  const proof = signedRetirements.get(retirement); workerNeed(proof?.envelope === checkpoint && proof.manifest === manifest && proof.store === store && proof.lease === lease);
  const job = store.assertWorker(lease); assertPausedTaskCheckpoint(proof.checkpoint, { manifest }); assertExecutionSubjectCurrent(verifyWorkerAuthorization({ store, jobId: job.id }).subject);
  return { generation: job.registration.generation, handoff: { checkpoint, retirement, payload: proof.payload } };
}
export async function verifyPausedWorkerCheckpoint({ store, jobId, manifest, assertCurrent } = {}) {
  assertPlannedWorkerStore(store); workerNeed(typeof assertCurrent === 'function'); const job = store.get(jobId); workerNeed(job?.status === 'retired' && job.active === 1 && !job.result); await confirmWorkerExit({ store, jobId, generation: job.active_generation });
  const checked = await auditHandoff({ store, jobId, generation: job.active_generation, manifest, assertCurrent }); observedExit(store, jobId, job.active_generation);
  const permit = Object.freeze({ kind: 'verified_retired_worker_handoff', id: randomUUID() }); handoffPermits.set(permit, { store, jobId, manifest, ...checked, generation: job.active_generation }); return permit;
}
export function assertVerifiedWorkerHandoff(permit, { store, jobId, manifest } = {}) {
  const proof = handoffPermits.get(permit); workerNeed(proof?.store === store && proof.jobId === jobId && proof.manifest === manifest); proof.current();
  const checked = handoffSignatures(store, jobId, proof.generation); workerNeed(workerHash(checked.handoff) === workerHash(proof.handoff)); observedExit(store, jobId, proof.generation);
  workerNeed(workerHash(inspectFrozenTaskHandoff({ filename: proof.handoff.payload.taskDatabase, runId: proof.grant.binding.runId, checkpointId: proof.handoff.payload.checkpointId })) === workerHash(proof.handoff.payload.freeze));
  return { generation: proof.generation, handoff: proof.handoff, assertCurrent: proof.current };
}
export async function verifyWorkerPausedTaskResume({ store, lease, manifest, assertCurrent } = {}) {
  const job = store.assertWorker(lease), grant = verifyWorkerAuthorization({ store, jobId: job.id }), envelope = job.generationAuthorization, body = envelope?.body;
  workerNeed(job.active_generation > 1 && body?.purpose === RESUME_PURPOSE && body.generation === job.active_generation && body.generationId === job.generationId
    && body.jobId === job.id && body.executionId === job.execution_id && body.grantHash === job.grant_hash && body.rootIdentity === store.identity
    && body.deadlineAt === grant.deadlineAt && body.maxModelCalls === grant.budget.maxModelCalls && body.policyHash === grant.policyHash && body.subjectHash === workerHash(grant.subject)
    && envelope.issuerPublicKey === store.issuerPublicKey && validSignature(body, envelope.signature, store.issuerPublicKey), 'worker_resume_authorization');
  const checked = await auditHandoff({ store, jobId: job.id, generation: body.previousGeneration, manifest, assertCurrent }); observedExit(store, job.id, body.previousGeneration);
  workerNeed(body.payloadHash === checked.payloadHash && body.checkpointHash === workerHash(checked.handoff.checkpoint) && body.retirementHash === workerHash(checked.handoff.retirement));
  const current = () => { checked.current(); const live = store.assertWorker(lease); workerNeed(live.generationId === job.generationId && workerHash(live.generationAuthorization) === workerHash(envelope)); return true; };
  const checkpoint = workerFreeze(workerCopy(checked.handoff.payload));
  const permit = Object.freeze({ kind: 'verified_paused_task_resume', id: randomUUID() }); resumePermits.set(permit, { manifest, store, lease, taskHash: workerHash(grant.task), binding: grant.binding, checkpoint, checkpointHash: workerHash(checkpoint), generationId: job.generationId, current }); return permit;
}
export function assertVerifiedPausedTaskResume(permit, { manifest, binding, task } = {}) {
  const proof = resumePermits.get(permit); workerNeed(proof?.manifest === manifest && proof.checkpointHash === workerHash(proof.checkpoint) && proof.taskHash === workerHash(task)
    && [...baseKeys, 'sourceRevision', 'sourceGeneration'].every(key => binding?.[key] === proof.binding[key]), 'worker_resume_permit_required'); proof.current();
  return Object.freeze({ checkpoint: proof.checkpoint, generationId: proof.generationId, assertCurrent: proof.current });
}

/** Fresh historical worker-chain audit for an already qualified artifact. It
 * returns no approval, task brand or execution permission. */
export function assertWorkerGenerationEvidence({ store, jobId, record, graph } = {}) {
  assertPlannedWorkerStore(store); const job = store.get(jobId), envelope = job?.result?.envelope, body = envelope?.body;
  workerNeed(body?.purpose === WORKER_RESULT_PURPOSE && body.jobId === jobId && body.executionId === job.execution_id && body.grantHash === job.grant_hash
    && body.instanceId === job.registration?.instanceId && body.generation === job.active_generation && body.publicKeyFingerprint === fingerprint(job.registration.publicKey)
    && body.recordHash === workerHash(record) && body.graphHash === (graph ? workerHash(graph) : null) && validSignature(body, envelope.signature, job.registration.publicKey)
    && body.generationChainHash === verifyGenerationHistory(store, jobId), 'worker_generation_history_changed'); return true;
}

/** Historical accounting only. An expired grant or revoked initiating subject
 * cannot authorize more execution, but does not erase a signed, stopped cost. */
export async function verifyRetiredWorkerCancellation({ store, jobId, assertControl } = {}) {
  assertPlannedWorkerStore(store); workerNeed(typeof assertControl === 'function'); const job = store.get(jobId);
  workerNeed(job && ['retired', 'retirement_cancel_pending', 'retirement_cancelled'].includes(job.status) && !job.result?.envelope && !job.result?.outcome, 'worker_retirement_required'); await confirmWorkerExit({ store, jobId, generation: job.active_generation });
  const checked = await auditHandoff({ store, jobId, generation: job.active_generation, assertCurrent: assertControl, historicalCostsOnly: true });
  observedExit(store, jobId, job.active_generation); const graph = checked.handoff.payload.graph, usage = { inputTokens: 0, outputTokens: 0 };
  for (const call of graph.modelCalls) for (const key of Object.keys(usage)) { workerNeed(Number.isSafeInteger(call.usage?.[key]) && call.usage[key] >= 0, 'worker_retirement_cost_unknown'); usage[key] += call.usage[key]; workerNeed(Number.isSafeInteger(usage[key])); }
  workerNeed(workerHash(usage) === workerHash(graph.usage) && graph.totalModelCalls === graph.modelCalls.length, 'worker_retirement_cost_unknown');
  const body = workerFreeze(workerCopy({ version: 1, purpose: 'taskflow/worker-retirement-cost-only/v1', jobId, executionId: job.execution_id,
    projectId: checked.grant.binding.projectId, runId: checked.grant.binding.runId, proposalId: checked.grant.proposalId, revision: checked.grant.revision,
    manifestHash: checked.grant.definition.manifestHash, grantHash: job.grant_hash, generation: job.active_generation, handoffHash: workerHash(checked.handoff),
    settlement: { actualCalls: graph.totalModelCalls, usage, releasedReservation: checked.grant.budget.maxModelCalls, terminationConfirmed: true } }));
  const permit = Object.freeze({ kind: 'verified_retirement_cost_only', id: randomUUID() }); retirementCostPermits.set(permit, { store, jobId, body, graph: workerFreeze(workerCopy(graph)), current: checked.current }); return permit;
}
export function assertVerifiedRetiredWorkerCancellation(permit, { store, jobId } = {}) {
  const proof = retirementCostPermits.get(permit); workerNeed(proof?.store === store && proof.jobId === jobId, 'worker_retirement_cost_permit_required'); proof.current();
  const job = store.get(jobId); workerNeed(['retired', 'retirement_cancel_pending', 'retirement_cancelled'].includes(job?.status) && job.grant_hash === proof.body.grantHash
    && workerHash(handoffSignatures(store, jobId, job.active_generation).handoff) === proof.body.handoffHash); observedExit(store, jobId, job.active_generation);
  return { body: proof.body, graph: proof.graph };
}

/** Every generation remains an append-only signed ancestry. Old task JSON is
 * dependency history; this check grants no original core or task brand. */
function verifyGenerationHistory(store, jobId) {
  const job = store.get(jobId), grant = verifyWorkerAuthorization({ store, jobId }), chain = store.generationChain(jobId), journal = store.calls(jobId);
  workerNeed(chain.length === job.active_generation && chain.length >= 1 && chain.length <= 8 && workerHash(chain[0].authorization) === workerHash(job.authorization)
    && workerHash(chain[0].registration) === workerHash(job.initialRegistration), 'worker_generation_chain_changed');
  for (let index = 0; index < chain.length; index++) {
    const item = chain[index]; workerNeed(item.generation === index + 1 && item.registration?.generation === item.generation);
    if (index === 0) continue;
    const prior = chain[index - 1], handoff = prior.handoff, checkpoint = handoff?.checkpoint?.body, retirement = handoff?.retirement?.body, auth = item.authorization, body = auth.body;
    observedExit(store, jobId, prior.generation);
    workerNeed(prior.status === 'retired' && handoff && checkpoint?.purpose === PAUSED_PURPOSE && retirement?.purpose === RETIRED_PURPOSE
      && body?.purpose === RESUME_PURPOSE && body.generation === item.generation && body.previousGeneration === prior.generation && body.generationId === item.generation_id
      && body.jobId === jobId && body.executionId === job.execution_id && body.grantHash === job.grant_hash && body.rootIdentity === store.identity
      && body.policyHash === grant.policyHash && body.deadlineAt === grant.deadlineAt && body.maxModelCalls === grant.budget.maxModelCalls && body.subjectHash === workerHash(grant.subject)
      && body.dispatchNonceHash === item.dispatch_hash && auth.issuerPublicKey === store.issuerPublicKey && validSignature(body, auth.signature, store.issuerPublicKey)
      && body.checkpointHash === workerHash(handoff.checkpoint) && body.retirementHash === workerHash(handoff.retirement) && body.payloadHash === workerHash(handoff.payload), 'worker_generation_chain_changed');
    for (const signed of [checkpoint, retirement]) workerNeed(signed.version === 1 && signed.jobId === jobId && signed.executionId === job.execution_id && signed.grantHash === job.grant_hash
      && signed.generation === prior.generation && signed.instanceId === prior.registration.instanceId && signed.publicKeyFingerprint === fingerprint(prior.registration.publicKey)
      && signed.policyHash === grant.policyHash && signed.deadlineAt === grant.deadlineAt && signed.subjectHash === workerHash(grant.subject));
    const oldCalls = handoff.payload.graph.modelCalls;
    workerNeed(validSignature(checkpoint, handoff.checkpoint.signature, prior.registration.publicKey) && validSignature(retirement, handoff.retirement.signature, prior.registration.publicKey)
      && checkpoint.payloadHash === workerHash(handoff.payload) && retirement.checkpointEnvelopeHash === workerHash(handoff.checkpoint)
      && retirement.retirement.checkpointHash === workerHash(handoff.payload) && retirement.retirement.pid === prior.registration.pid && retirement.retirement.terminationConfirmed === true
      && oldCalls.length <= journal.length && checkpoint.callJournalHash === workerHash(journal.slice(0, oldCalls.length))
      && oldCalls.every((call, i) => journal[i].call_id === call.id && journal[i].receipt_hash === call.receiptHash && workerHash(journal[i].usage) === workerHash(call.usage)), 'worker_generation_history_changed');
    const event = store.events(jobId, retirement.eventSeq - 1)[0]; workerNeed(event?.seq === retirement.eventSeq && event.hash === retirement.eventHash && checkpoint.eventSeq <= retirement.eventSeq);
    const frozen = inspectConsumedTaskHandoff({ filename: handoff.payload.taskDatabase, runId: grant.binding.runId, checkpointId: handoff.payload.checkpointId, generationId: item.generation_id });
    workerNeed(workerHash({ ...frozen, consumedBy: null }) === workerHash(handoff.payload.freeze), 'worker_consumed_handoff_changed');
  }
  return workerHash(chain);
}
