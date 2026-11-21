import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertCompiledManifest, compiledManifestDefinition, isTaskCompiledManifest, canonicalJSON } from './verification-contract.mjs';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';
import { inspectPlannedTaskGraph } from './planned-task-executor.mjs';
import { plannedExecutionPolicyHash } from './planned-web-executor.mjs';
import { validateTaskWriteConflicts } from './task-write-validation.mjs';
import { describeExecutionSubject, createLocalExecutionSubject } from './team-access.mjs';
import { snapshotModelControls } from './planner.mjs';

const jobs = new WeakMap();
export const WORKER_AUTH_PURPOSE = 'taskflow.worker.authorization.v1';
export const WORKER_RESULT_PURPOSE = 'taskflow.worker.completed.v1';
export const WORKER_OUTCOME_PURPOSE = 'taskflow.worker.stopped.v1';
export const WORKER_CHECKPOINT_PURPOSE = 'taskflow.worker.paused-dependencies.v1';
export const WORKER_RETIREMENT_PURPOSE = 'taskflow.worker.paused-retirement.v1';
export const WORKER_RESUME_PURPOSE = 'taskflow.worker.resume-authorization.v1';
export const WORKER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const WORKER_HASH = /^[a-f0-9]{64}$/u;
export const workerNeed = (value, code = 'invalid_worker_state') => { if (!value) throw Object.assign(new Error('Worker身份、授权、状态或证据无法完整核对。'), { code, status: 409 }); };
export const workerCopy = value => copyBrowserScenarioData(value, 32 * 1024 * 1024, { maxNodes: 250000 });
export const workerHash = value => createHash('sha256').update(canonicalJSON(workerCopy(value))).digest('hex');
export const workerFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(workerFreeze); Object.freeze(value); } return value; };
export function workerExact(raw, keys) {
  workerNeed(raw && typeof raw === 'object' && Object.getPrototypeOf(raw) === Object.prototype && !Object.getOwnPropertySymbols(raw).length);
  const fields = Object.getOwnPropertyDescriptors(raw); workerNeed(Object.keys(fields).length === keys.length && keys.every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value')));
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
/** Only whitelisted model settings travel over anonymous stdin, never an env. */
export function normalizeWorkerModelConfig(raw) {
  workerNeed(raw && typeof raw === 'object' && Object.getPrototypeOf(raw) === Object.prototype && !Object.getOwnPropertySymbols(raw).length, 'worker_model_config_revision');
  const fields = Object.getOwnPropertyDescriptors(raw), keys = Object.keys(fields);
  workerNeed(['baseUrl', 'model', 'apiKey'].every(name => Object.hasOwn(fields, name))
    && keys.every(name => ['baseUrl', 'model', 'apiKey', 'thinking', 'jsonMode'].includes(name) && fields[name].enumerable && Object.hasOwn(fields[name], 'value')), 'worker_model_config_revision');
  // Own undefined controls freeze absence for in-process factories, while the
  // anonymous JSON bootstrap retains the legacy three-field wire format.
  const selected = Object.fromEntries(keys.filter(name => !['thinking', 'jsonMode'].includes(name) || fields[name].value !== undefined).map(name => [name, fields[name].value]));
  let value; try { value = workerCopy(selected); } catch { workerNeed(false, 'worker_model_config_revision'); }
  workerNeed(typeof value.baseUrl === 'string' && value.baseUrl.length <= 2000 && typeof value.model === 'string' && value.model.length <= 200
    && typeof value.apiKey === 'string' && value.apiKey.length <= 8192, 'worker_model_config_revision');
  let controls; try { controls = snapshotModelControls(value, {}); } catch { workerNeed(false, 'worker_model_config_revision'); }
  return workerFreeze({ baseUrl: value.baseUrl, model: value.model, apiKey: value.apiKey, ...controls });
}
export function workerModelConfigRevision(config) {
  const { apiKey, ...publicSettings } = normalizeWorkerModelConfig(config);
  return workerHash(publicSettings);
}
export function workerPolicyHash() {
  const names = ['planned-worker-contract.mjs', 'planned-worker-store.mjs', 'planned-worker-client.mjs', 'planned-worker-seals.mjs', '../scripts/planned-worker.mjs',
    'planned-web-executor.mjs', 'planned-task-executor.mjs', 'planned-task-base.mjs', 'planned-task-merge.mjs', 'planned-source.mjs', 'planned-checkpoint.mjs', 'planned-delivery.mjs', 'planned-execution-service.mjs', 'task-store.mjs', 'task-write-validation.mjs', 'verification-contract.mjs',
    'verification-task-scopes.mjs', 'verification-planning-service.mjs', 'planner.mjs', 'project-code-model.mjs', 'project-review-model.mjs', 'model-request-evidence.mjs', 'model-content-guard.mjs', 'windows-sandbox.mjs', 'managed-process.mjs',
    'http-scenarios.mjs', 'browser-scenarios.mjs', 'browser-scenario-contract.mjs', 'web-delivery.mjs', 'web-runtime.mjs', 'web-worker.cjs', 'web-protocol.mjs', 'project-files.mjs', 'team-access.mjs'];
  return workerHash({ executionPolicyHash: plannedExecutionPolicyHash, files: names.map(name => ({ name, hash: createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex') })) });
}

/** Only a begun real parent manifest can authorize an independent process. JSON is descriptive data. */
export function createApprovedWorkerJob({ manifest, task, binding, jobId = randomUUID(), executionId, proposalId, revision, contextHash, engineeringHash,
  sourceRevision, sourceGeneration, budget = { maxCalls: 3, maxReviewCalls: 3, maxConcurrency: 2 }, deadlineAt, rootIdentity, configRevision, assertCurrent, subject } = {}) {
  workerNeed(typeof assertCurrent === 'function'); const current = () => { const result = assertCurrent(); workerNeed(result !== false && !result?.then); assertCompiledManifest(manifest, binding); };
  current(); workerNeed(!isTaskCompiledManifest(manifest)); const definition = compiledManifestDefinition(manifest), confirmed = workerCopy(task), limits = workerExact(budget, ['maxCalls', 'maxReviewCalls', 'maxConcurrency']);
  workerNeed(WORKER_ID.test(jobId) && WORKER_ID.test(executionId ?? '') && WORKER_ID.test(proposalId ?? ''));
  for (const value of [revision, contextHash, engineeringHash, sourceRevision, rootIdentity, configRevision]) workerNeed(typeof value === 'string' && WORKER_HASH.test(value));
  workerNeed(Number.isSafeInteger(sourceGeneration) && sourceGeneration >= 0 && Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now() && deadlineAt <= Date.now() + 1200000);
  workerNeed([limits.maxCalls, limits.maxReviewCalls].every(value => Number.isInteger(value) && value >= 1 && value <= 3) && [1, 2].includes(limits.maxConcurrency));
  workerNeed(confirmed && Array.isArray(confirmed.tasks) && confirmed.tasks.length > 0 && Buffer.byteLength(JSON.stringify(confirmed)) <= 96000); validateTaskWriteConflicts(confirmed.tasks);
  const mode = definition.taskScopes ? 'graph' : 'whole'; if (mode === 'graph') { inspectPlannedTaskGraph(confirmed); workerNeed(createHash('sha256').update(canonicalJSON(confirmed.tasks)).digest('hex') === definition.taskSetHash, 'worker_task_set_changed'); }
  const executionSubject = workerCopy(describeExecutionSubject(subject ?? createLocalExecutionSubject()));
  const nonce = randomBytes(32).toString('hex'), normalizedBinding = workerCopy({ ...definition.binding, sourceRevision, sourceGeneration });
  const body = workerFreeze(workerCopy({ version: 1, purpose: WORKER_AUTH_PURPOSE, jobId, executionId, binding: normalizedBinding, proposalId, revision, contextHash, engineeringHash,
    task: confirmed, definition, mode, subject: executionSubject, budget: { ...limits, maxModelCalls: (mode === 'graph' ? confirmed.tasks.length : 1) * (limits.maxCalls + limits.maxReviewCalls) },
    deadlineAt, rootIdentity, configRevision, policyHash: workerPolicyHash(), dispatchNonceHash: createHash('sha256').update(nonce).digest('hex') }));
  const handle = Object.freeze({ kind: 'approved_worker_job', id: jobId }); jobs.set(handle, { body, manifest, current, nonce }); return handle;
}
export function assertApprovedWorkerJob(handle) { const proof = jobs.get(handle); workerNeed(proof, 'worker_job_capability_required'); proof.current(); workerNeed(proof.body.deadlineAt > Date.now() && proof.body.policyHash === workerPolicyHash()); return proof.body; }
export function describeApprovedWorkerJob(handle) { return workerCopy(assertApprovedWorkerJob(handle)); }
/** Trusted launcher only; never expose this material through an API or log. */
export function workerBootstrapNonce(handle) { assertApprovedWorkerJob(handle); return jobs.get(handle).nonce; }

export function inspectWorkerAuthorization(raw) {
  const value = workerCopy(raw); workerNeed(value?.version === 1 && value.purpose === WORKER_AUTH_PURPOSE && WORKER_ID.test(value.jobId ?? '') && WORKER_ID.test(value.executionId ?? '')
    && ['whole', 'graph'].includes(value.mode) && WORKER_HASH.test(value.policyHash ?? '') && value.policyHash === workerPolicyHash() && WORKER_HASH.test(value.rootIdentity ?? '')
    && WORKER_HASH.test(value.dispatchNonceHash ?? '') && Number.isSafeInteger(value.deadlineAt) && value.deadlineAt > Date.now(), 'invalid_worker_authorization');
  workerNeed(value.definition?.binding && value.definition.manifestHash && value.budget?.maxModelCalls > 0 && value.budget.maxModelCalls <= 48);
  return workerFreeze(value);
}
