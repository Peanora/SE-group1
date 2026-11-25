import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { minimalEnv, runProcess } from './managed-process.mjs';
import { createWindowsSandbox } from './windows-sandbox.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { getWebShellFiles, installWebShell, verifyWebShell } from './web-delivery.mjs';
import { assertCompiledManifest, compiledManifestDefinition, isTaskCompiledManifest, canonicalJSON } from './verification-contract.mjs';
import { runHttpScenarios } from './http-scenarios.mjs';
import { runBrowserScenarios } from './browser-scenarios.mjs';
import { browserScenarioChecks, browserScenarioPolicyHash, copyBrowserScenarioData } from './browser-scenario-contract.mjs';
import { validateTaskWriteConflicts } from './task-write-validation.mjs';
import { projectReviewPolicy, validateProjectReviewResponse, decodeProjectReviewResponseV2, getProjectReviewResponseFeedback, projectReviewEvidenceOrigin, PROJECT_REVIEW_HISTORY_LIMIT } from './project-review-model.mjs';
import { decodeProjectCodeResponse } from './project-code-model.mjs';
import { getModelRequestEvidence } from './model-request-evidence.mjs';
import { hasCompletePlannedModelReceipt } from './planned-call-history.mjs';
import { reconcilePlannedReviewIssues } from './planned-review-issues.mjs';
import { resolvePlannedTaskBase } from './planned-task-merge.mjs';
import { assertPlannedCheckpoint } from './planned-checkpoint.mjs';
import { assertPlannedTaskSeed } from './planned-task-base.mjs';
import { assertPlannedEvolutionSeed, assertPlannedEvolutionSeedCurrent, describePlannedEvolutionSeed } from './planned-evolution-source.mjs';
import { createPlannedVerificationDataset, assertPlannedVerificationDatasetReceipt } from './planned-verification-dataset.mjs';
import { assertMigrationPlan, normalizeMigrationPlan } from './planned-migration-contract.mjs';
import { findMissingBrowserLogin } from './planned-failure-help.mjs';

export const PLANNED_EXECUTION_TIMEOUT_MS = 3_600_000;

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceHash = files => hash(validateProjectFiles(files));
const need = (condition, message) => { if (!condition) throw new Error(message); };
const executionError = (code, message) => Object.assign(new Error(message), { code });
const errorCodes = new Set(['proposal_invalid', 'proposal_outside_scope', 'retry_exhausted', 'verification_failed', 'unchanged_candidate', 'integration_rework_required', 'transport_unknown', 'credential_response', 'credential_input', 'receipt_failed', 'receipt_mismatch', 'cancelled', 'timed_out', 'browser_dependency_unavailable', 'execution_failed']);
export async function assertPlannedBrowserDependency(load = () => import('playwright-core')) {
  try {
    const { chromium } = await load();
    if (typeof chromium?.launchServer === 'function' && typeof chromium.connect === 'function') return;
  } catch { /* Report the supported recovery action without leaking loader paths. */ }
  throw executionError('browser_dependency_unavailable', '缺少可用的浏览器验收依赖，请在项目目录运行 npm ci 后重试。');
}

const safeErrorCode = error => errorCodes.has(error?.code) ? error.code : error?.code === 'invalid_model_response' ? 'proposal_invalid' : 'execution_failed';
const baseKeys = ['projectId', 'runId', 'specRevision', 'planRevision'];
const candidateKeys = [...baseKeys, 'taskId', 'attemptId', 'candidateCommit', 'sourceHash', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash'];
const verifiedExecutions = new WeakMap(), integrationReworks = new WeakMap(), historicalEvolutionProof = new WeakMap();
const recordHash = value => hash(copyBrowserScenarioData(value, 32 * 1024 * 1024, { maxNodes: 250000 }));
const freezeData = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeData); Object.freeze(value); } return value; };
const stopped = item => item?.terminationConfirmed === true && item.status === 'stopped' && item.exitCode === 0 && item.sourceUnchanged === true && item.stopAcknowledged === true;
export const plannedExecutionPolicyHash = hash(['planned-web-executor.mjs', 'planned-call-history.mjs', 'planned-source.mjs', 'planned-task-base.mjs', 'planned-task-merge.mjs', 'planned-task-executor.mjs', 'task-store.mjs', 'planned-checkpoint.mjs', 'planned-execution-service.mjs', 'planned-preview.mjs', 'planned-command-evidence.mjs', 'planner.mjs', 'project-code-model.mjs', 'project-review-model.mjs', 'model-request-evidence.mjs',
  'planned-failure-help.mjs', 'planned-review-issues.mjs',
  'planned-evolution-source.mjs', 'planned-verification-dataset.mjs', 'planned-dataset.mjs', 'planned-migration-contract.mjs', 'planned-migration-worker.cjs',
  'browser-scenarios.mjs', 'browser-scenario-contract.mjs', 'http-scenarios.mjs', 'verification-contract.mjs', 'web-delivery.mjs', 'planned-delivery.mjs',
  'web-runtime.mjs', 'web-worker.cjs', 'web-protocol.mjs', 'windows-sandbox.mjs', 'managed-process.mjs', 'project-files.mjs'].map(name => ({ name, hash: hash(readFileSync(new URL(name, import.meta.url))) })));

async function directory(raw) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root, '执行目录必须是专用绝对路径。');
  const absolute = path.resolve(raw); let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current), actual = await realpath(current);
    need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current), '执行目录及父链不可使用链接。');
  }
  return absolute;
}

function boundHttp(test, binding, manifest) {
  return test && test.sourceHash === binding.sourceHash && test.manifestHash === manifest.manifestHash && test.policyHash === manifest.policyHash
    && [...baseKeys, 'taskId', 'attemptId', 'candidateCommit'].every(key => test.binding?.[key] === binding[key])
    && test.checks?.length === manifest.checks.length && manifest.checks.every(rule => test.checks.filter(item => item.id === rule.id).length === 1);
}
function confirmedHttp(test, binding, manifest) {
  return boundHttp(test, binding, manifest) && test.terminationConfirmed === true
    && Array.isArray(test.processes) && test.processes.length > 0 && test.processes.every(stopped);
}
function completeHttp(test, binding, manifest) {
  return test?.status === 'passed' && confirmedHttp(test, binding, manifest) && test.checks.every(item => item.passed === true);
}
function confirmedBrowser(test, binding, manifest) {
  const checks = browserScenarioChecks(manifest.browser);
  return test && test.manifestHash === manifest.manifestHash && test.sourceHash === binding.sourceHash && test.browserPolicyHash === browserScenarioPolicyHash
    && candidateKeys.every(key => test.binding?.[key] === binding[key]) && test.terminationConfirmed === true && test.browser?.closed === true && !!test.browser.version
    && test.checks?.length === checks.length && checks.every(rule => test.checks.filter(item => item.id === rule.id).length === 1)
    && test.processes?.length >= 3 && test.processes.filter(item => item.kind === 'browser').length === 1
    && test.processes.every(item => item.kind === 'browser' ? item.terminationConfirmed === true && item.status === 'stopped' && item.exitCode === 0 : stopped(item));
}
function completeBrowser(test, binding, manifest) {
  return test?.status === 'passed' && confirmedBrowser(test, binding, manifest) && test.checks.every(item => item.passed === true);
}

function repeatedEvidence(checks) {
  const failures = checks.filter(item => item.passed === false && typeof item.actual === 'string' && !item.actual.includes('未执行'));
  return failures.length ? { passed: checks.filter(item => item.passed === true).map(item => item.id), failures: failures.map(({ id, actual }) => [id, actual]) } : null;
}
const startupCodes = new Set(['sqlite_transaction_unsupported', 'application_module_failed', 'application_initialization_failed', 'invalid_application_factory', 'invalid_application_handler']);

function browserRepairEvidence(report, definition, files, includeObservedValues) {
  const inlineStyles = files.filter(file => file.path.startsWith('public/') && file.path.endsWith('.html')
    && /<[a-z][^>]*\sstyle\s*=/iu.test(file.content)).map(file => file.path);
  return ['DESKTOP', 'MOBILE'].flatMap(view => {
    const failure = report?.checks?.find(check => check.passed === false && check.id.startsWith(`BROWSER-${view}-`) && check.actual !== '未执行，未获得通过结论');
    if (!failure) {
      const guardId = `BROWSER-${view}-GUARD`;
      const actions = report?.checks?.filter(check => check.id.startsWith(`BROWSER-${view}-`) && check.id !== guardId) ?? [];
      if (actions.length && actions.every(check => check.passed) && report.checks.some(check => check.id === guardId && !check.passed)) {
        return [{ id: guardId, view, hint: '本视口的页面操作已通过，但最终浏览器守卫未通过。检查是否横向溢出、产生控制台错误或发生非预期导航；不要关闭守卫。' }];
      }
      return [];
    }
    const step = definition.steps.find(item => failure.id === `BROWSER-${view}-${item.id}`);
    let observation;
    try { observation = JSON.parse(failure.actual); } catch { /* A non-action failure has no browser observation. */ }
    const { observed, guardFailures } = observation ?? {};
    const guards = ['console_error', 'page_error', 'navigation', 'external_request', 'websocket', 'dialog', 'download']
      .filter(reason => Number.isInteger(guardFailures?.[reason]) && guardFailures[reason] > 0);
    const delayedLoad = step?.op === 'createWithDelayedLoad' ? { listTestId: step.listTestId, countTestId: step.countTestId,
      initialStatus: observed?.initialStatus ?? null, beforeCountRead: observed?.beforeCount != null, createResponseReceived: observed?.postStatus != null,
      note: '首次加载期间，输入、提交、列表和纯数字总数元素必须各有且只有一个。未读到初始总数时先检查定位元素和初始可见性。' } : undefined;
    const observedValue = ['text', 'value'].includes(step?.op) ? observed?.[step.op] : undefined;
    return [{ id: failure.id, view, ...(step ? { operation: step.op, session: step.session, path: step.path, testId: step.testId } : {}),
      ...(includeObservedValues && typeof observedValue === 'string' ? { expected: step.value, actual: observedValue.slice(0, 512) } : {}),
      guards, ...(delayedLoad ? { delayedLoad } : {}), ...(Number.isInteger(observed?.status) ? { status: observed.status } : {}),
      ...(Number.isInteger(observed?.count) ? { matches: observed.count, visible: observed.visible === true } : {}),
      ...(Number.isInteger(observed?.scroll) && observed.scroll > observed.width + 1 ? { width: observed.width, scrollWidth: observed.scroll } : {}),
      ...(guards.includes('console_error') && inlineStyles.length ? { possibleInlineStyleSources: inlineStyles.slice(0, 12),
        hint: '候选 HTML 包含内联样式，浏览器报告了控制台错误。检查并把内联样式移到同源样式表。保留平台 CSP 和登录权限。' } : {}),
    }];
  });
}

function missingPageRoutes(report, definition) {
  const failed = new Set(report?.checks?.filter(check => !check.passed && check.actual === 'HTTP 404').map(check => check.id));
  const pages = new Set(definition.browser.steps.filter(step => step.op === 'goto').map(step => step.path));
  return definition.steps.filter(step => step.type === 'request' && step.request.method === 'GET' && pages.has(step.request.path)
    && step.request.assertions.some(assertion => assertion.op === 'status' && assertion.value === 200 && failed.has(assertion.id))).map(step => step.request.path);
}
function safeStartupDiagnostic(report, files) {
  const value = report?.startupDiagnostic;
  if (!value || value.phase !== 'startup' || !startupCodes.has(value.code) || Object.keys(value).some(key => !['phase', 'code', 'sourceLocation'].includes(key))) return undefined;
  let sourceLocation;
  if (value.sourceLocation !== undefined) {
    const location = value.sourceLocation, file = files.find(file => file.path === location?.name);
    if (!file || Object.keys(location).some(key => !['name', 'line'].includes(key)) || !Number.isInteger(location.line) || location.line < 1
      || !file.content.split(/\r?\n/u)[location.line - 1]?.trim()) return undefined;
    sourceLocation = { name: location.name, line: location.line };
  }
  return { phase: 'startup', code: value.code, ...(sourceLocation ? { sourceLocation } : {}) };
}

function datasetPhases(definition) {
  return ['browser-DESKTOP', 'browser-MOBILE', ...definition.browser.steps.filter(step => step.op === 'createWithDelayedLoad').flatMap(step => [`race-DESKTOP-${step.id}`, `race-MOBILE-${step.id}`])];
}
function completeEvolutionDatasets(record, version, binding, definition) {
  if (record.evolutionSource === undefined) return record.evolutionSeedHash === undefined && record.evolutionHistory === undefined;
  const source = record.evolutionSource, expected = datasetPhases(definition), web = version.acceptance?.browser?.dataset;
  if (source.version !== 1 || source.kind !== 'evolution_source_only' || source.reuseValidation !== false || record.evolutionSeedHash !== hash(canonicalJSON(source)) || !completeEvolutionRecipe(record)
    || !baseKeys.every(key => source.targetBinding?.[key] === record[key]) || !Array.isArray(web) || web.length !== expected.length) return false;
  const matches = (receipt, phase) => receipt?.version === 1 && receipt.kind === 'planned_verification_dataset' && receipt.phase === phase && receipt.seedHash === record.evolutionSeedHash
    && candidateKeys.every(key => receipt.binding?.[key] === binding[key]) && receipt.inputSnapshotHash === source.snapshot?.snapshotHash
    && receipt.migrationRevision === source.migration?.revision && receipt.operationsHash === source.migration?.operationsHash
    && ['migrationReceiptHash', 'databaseHash', 'schemaHash', 'rowsHash'].every(key => /^[a-f0-9]{64}$/u.test(receipt[key] ?? ''))
    && /^[A-Za-z0-9_-]{1,128}$/u.test(receipt.migrationId ?? '') && receipt.terminationConfirmed === true && Array.isArray(receipt.processes) && receipt.processes.length > 0
    && receipt.processes.every(process => process.kind === 'dataset_migration' && process.status === 'stopped' && process.exitCode === 0 && process.terminationConfirmed === true);
  return matches(version.selfCheck?.dataset, 'self_check') && matches(version.acceptance?.test?.dataset, 'http')
    && expected.every(phase => web.filter(receipt => matches(receipt, phase)).length === 1)
    && new Set([version.selfCheck.dataset, version.acceptance.test.dataset, ...web].map(receipt => receipt.migrationId)).size === expected.length + 2;
}
function completeEvolutionRecipe(record) {
  try { const normalized = normalizeMigrationPlan(record.evolutionMigration); return canonicalJSON(normalized) === canonicalJSON(record.evolutionMigration)
    && hash(JSON.stringify(normalized)) === record.evolutionSource.migration.operationsHash && hash(canonicalJSON(record.evolutionInputSchema)) === record.evolutionSource.inputSchemaMetadataHash; } catch { return false; }
}
function historicalSummary(record) {
  const version = record.versions.at(-1), origin = record.evolutionSource;
  return freezeData({ version: 1, purpose: 'taskflow/evolution-validation-history/v1', seedHash: record.evolutionSeedHash, candidateCommit: record.candidateCommit,
    sourceHash: version.sourceHash, manifestHash: record.manifestHash, inputSnapshotHash: origin.snapshot.snapshotHash, inputSchemaHash: origin.snapshot.schemaHash,
    migrationRevision: origin.migration.revision, operationsHash: origin.migration.operationsHash,
    datasetReceiptsHash: hash(canonicalJSON([version.selfCheck.dataset, version.acceptance.test.dataset, ...version.acceptance.browser.dataset])) });
}
function regularHistoricalFile(filename) {
  for (let parent = path.dirname(filename);; parent = path.dirname(parent)) { const stat = lstatSync(parent); need(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(realpathSync(parent)).toLowerCase() === path.resolve(parent).toLowerCase(), '历史源码目录已变化。'); if (parent === path.dirname(parent)) break; }
  const stat = lstatSync(filename); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 2 * 1024 * 1024, '历史源码文件已变化。'); const bytes = readFileSync(filename); need(bytes.length === stat.size, '历史源码文件读取不完整。'); return bytes;
}
function historicalCodeAudit(record, expectedFiles, shell) {
  const files = []; let entries = 0;
  const walk = (directory, relative) => { const stat = lstatSync(directory); need(stat.isDirectory() && !stat.isSymbolicLink(), '历史源码目录无效。'); for (const entry of readdirSync(directory, { withFileTypes: true })) { need(++entries <= 512 && !entry.isSymbolicLink(), '历史源码目录超限或包含链接。'); const name = `${relative}/${entry.name}`, filename = path.join(directory, entry.name); if (entry.isDirectory()) walk(filename, name); else { need(entry.isFile(), '历史源码不是普通文件。'); files.push({ path: name, content: new TextDecoder('utf-8', { fatal: true }).decode(regularHistoricalFile(filename)) }); } } };
  for (const relative of ['src', 'public', 'migrations', 'tests', 'docs']) { try { walk(path.join(record.workspace, relative), relative); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  try { files.push({ path: 'README.md', content: new TextDecoder('utf-8', { fatal: true }).decode(regularHistoricalFile(path.join(record.workspace, 'README.md'))) }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  need(sourceHash(files) === sourceHash(expectedFiles) && sourceHash(files) === record.versions.at(-1).sourceHash, '历史候选源码已变化。');
  for (const file of shell) need(hash(regularHistoricalFile(path.join(record.workspace, file.path))) === hash(file.content), '历史保护运行文件已变化。');
  const head = regularHistoricalFile(path.join(record.workspace, '.git/HEAD')).toString('utf8').trim(); let commit = head;
  if (head.startsWith('ref: ')) { const ref = head.slice(5); need(/^refs\/[A-Za-z0-9_./-]+$/u.test(ref) && !ref.split('/').some(part => !part || part === '.' || part === '..'), '历史Git引用无效。'); try { commit = regularHistoricalFile(path.join(record.workspace, '.git', ...ref.split('/'))).toString('utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; commit = regularHistoricalFile(path.join(record.workspace, '.git/packed-refs')).toString('utf8').split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0]; } }
  need(commit === record.candidateCommit, '历史Git提交已变化。');
}

/** Frozen past validation only: no fresh task, seed, data, merge or execution authority. */
export function assertPlannedEvolutionAcceptance(record, manifest) {
  const proof = historicalEvolutionProof.get(record);
  need(proof && proof.manifest === manifest && proof.recordHash === recordHash(record) && proof.manifestHash === hash(canonicalJSON(manifest)) && completeEvolutionRecipe(record), '没有对应原始演进验收历史证明。');
  historicalCodeAudit(record, proof.files, proof.shell); need(canonicalJSON(historicalSummary(record)) === canonicalJSON(proof.summary), '演进验收历史内容已变化。'); return proof.summary;
}

function completeAcceptedRecord(record, manifest) {
  try {
    assertCompiledManifest(manifest, Object.fromEntries(baseKeys.map(key => [key, record?.[key]])));
    const definition = compiledManifestDefinition(manifest), version = record?.versions?.at(-1), gate = version?.acceptance, binding = gate?.binding;
    return (!isTaskCompiledManifest(manifest) || record.taskExecution?.taskId === definition.executionScope.taskId && record.taskId === definition.executionScope.taskId
      && record.taskExecution.taskDefinitionHash === definition.executionScope.taskDefinitionHash && record.taskExecution.taskSetHash === definition.taskSetHash)
      && record.status === 'accepted' && record.profileId === 'planned-web-v1' && record.providerKind === 'model' && record.reviewerKind === 'model'
      && record.terminationConfirmed === true && [...baseKeys, 'taskId', 'attemptId'].every(key => record[key] === binding?.[key])
      && record.executorPolicyHash === plannedExecutionPolicyHash && record.acceptanceStatus === 'passed' && gate?.status === 'passed'
      && record.manifestHash === definition.manifestHash && record.browserPolicyHash === browserScenarioPolicyHash && record.reviewPolicyHash === projectReviewPolicy.hash
      && binding?.candidateCommit === record.candidateCommit && binding.candidateCommit === version.commit && binding.sourceHash === version.sourceHash
      && /^[a-f0-9]{40}$/u.test(binding.candidateCommit) && binding.manifestHash === definition.manifestHash && binding.browserPolicyHash === browserScenarioPolicyHash
      && binding.reviewPolicyHash === projectReviewPolicy.hash && completeHttp(version.selfCheck, binding, definition) && completeHttp(gate.test, binding, definition)
      && completeBrowser(gate.browser, binding, definition) && completeEvolutionDatasets(record, version, binding, definition) && gate.review?.status === 'completed' && gate.review.policyHash === projectReviewPolicy.hash
      && candidateKeys.every(key => gate.review.binding?.[key] === binding[key]) && gate.review.openBlockingIssues === 0
      && Array.isArray(gate.review.issues) && !gate.review.issues.some(item => item.severity === 'blocking')
      && Array.isArray(gate.issues) && gate.issues.every(item => item.severity !== 'blocking' || item.status === 'resolved' && item.checkedCommit === binding.candidateCommit)
      && record.versions.every(applied => record.modelCalls.filter(item => item.role === 'coding' && item.attempt === applied.attempt && item.finishReason === 'stop').length === 1)
      && completeCurrentReviewCalls(record, gate.review, binding)
      && record.modelCalls.length > 0 && record.modelCalls.every(item => hasCompletePlannedModelReceipt(item)
        && [...baseKeys, 'taskId', 'attemptId'].every(key => item[key] === record[key]))
      && record.totalModelCalls === record.modelCalls.filter(item => item.kind === 'model' && item.dispatched !== false).length;
  } catch { return false; }
}

function completeCurrentReviewCalls(record, review, binding) {
  const calls = record.modelCalls.filter(call => call.role === 'review' && call.candidateCommit === binding.candidateCommit && call.inputSourceHash === binding.sourceHash);
  const primary = calls.at(-1);
  return calls.length > 0 && primary.id === review.primaryCallId && primary.errorCode === null && primary.finishReason === 'stop'
    && (primary.reviewWireVersion !== 2 || review.evidenceOrigin === projectReviewEvidenceOrigin)
    && calls.slice(0, -1).every(call => call.reviewWireVersion === 2 && call.errorCode === 'proposal_invalid' && call.finishReason === 'stop' && hasCompletePlannedModelReceipt(call)
      && call.reviewRejection?.version === 1 && call.reviewRejection.code === 'invalid_model_response' && call.reviewRejection.callId === call.id && call.reviewRejection.receiptHash === call.receiptHash
      && call.reviewRejection.candidateCommit === binding.candidateCommit && call.reviewRejection.inputSourceHash === binding.sourceHash);
}

/** A parsed report or model completion statement cannot replace the original execution identity. */
export function isPlannedWebTaskAccepted(record, manifest) {
  try { const proof = verifiedExecutions.get(record); proof?.assertDataset?.(); return proof?.manifest === manifest && proof.hash === recordHash(record) && completeAcceptedRecord(record, manifest); }
  catch { return false; }
}

/** The original failed integration alone can ask its controller to rework exact upstream owners. */
export function plannedIntegrationRework(record, manifest) {
  try {
    const proof = integrationReworks.get(record);
    if (!proof || proof.manifest !== manifest || proof.hash !== recordHash(record) || record.status !== 'failed'
      || record.errorCode !== 'integration_rework_required' || record.terminationConfirmed !== true) return null;
    proof.assertCurrent(); return proof.value;
  } catch { return null; }
}

/** Recovery authorizes the same historical delivery; it never recreates a new task pass or original brand. */
export function isPlannedWebDeliveryAccepted({ record, manifest, checkpoint, executionId } = {}) {
  if (isTaskCompiledManifest(manifest)) return false;
  if (record?.evolutionSource !== undefined) {
    if (!completeAcceptedRecord(record, manifest)) return false;
    const evidence = { executionId, record, manifest, policyHash: plannedExecutionPolicyHash };
    for (const purpose of ['taskflow/planned-evolution-accepted/v1', 'taskflow/planned-worker-evolution-accepted/v1']) {
      try { return assertPlannedCheckpoint(checkpoint, { ...evidence, purpose }); } catch { /* Try the other trusted publication format. */ }
    }
    return false;
  }
  if (isPlannedWebTaskAccepted(record, manifest)) return true;
  try { assertPlannedCheckpoint(checkpoint, { executionId, record, manifest, policyHash: plannedExecutionPolicyHash }); return completeAcceptedRecord(record, manifest); }
  catch { return false; }
}

/** Trusted controller only: the manifest must be approved before any model or candidate code starts. */
export function startPlannedWebExecution({ outputDir, binding, task, manifest, provider, reviewer, executable = process.env.EXECUTION_SANDBOX_EXE,
  providerKind = 'model', reviewerKind = 'model', signal, initialSource, initialTaskBase, evolutionSeed, taskExecution, repairNote, maxCalls = 3, maxReviewCalls = 3, timeoutMs = PLANNED_EXECUTION_TIMEOUT_MS, assertCurrent, onEvent = () => {} } = {}) {
  need(binding && typeof binding === 'object' && typeof assertCurrent === 'function', '执行必须绑定当前规划和可信同步门禁。');
  const identity = Object.fromEntries([...baseKeys, 'taskId'].map(key => [key, binding[key]]));
  need(['projectId', 'runId', 'taskId'].every(key => /^[A-Za-z0-9_-]{1,128}$/u.test(identity[key] ?? '')) && ['specRevision', 'planRevision'].every(key => /^[a-f0-9]{64}$/u.test(identity[key] ?? '')), '规划执行身份无效。');
  assertCompiledManifest(manifest, Object.fromEntries(baseKeys.map(key => [key, identity[key]])));
  const definition = compiledManifestDefinition(manifest); need(definition.browser, '通用执行须先认可联合HTTP与浏览器清单。');
  need(typeof provider === 'function' && typeof reviewer === 'function' && ['model', 'trusted_fixture'].includes(providerKind) && ['model', 'diagnostic'].includes(reviewerKind), '缺少受控编码和独立Review。');
  need(signal === undefined || signal instanceof AbortSignal, '取消信号无效。');
  need([maxCalls, maxReviewCalls].every(value => Number.isInteger(value) && value >= 1 && value <= 5) && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= PLANNED_EXECUTION_TIMEOUT_MS, '执行预算无效。');
  const taskData = structuredClone(task);
  need(taskData && Array.isArray(taskData.tasks) && taskData.tasks.length > 0 && Buffer.byteLength(JSON.stringify(taskData)) <= 96000, '确认工程任务无效或超限。');
  validateTaskWriteConflicts(taskData.tasks);
  const allPaths = new Set(taskData.tasks.flatMap(item => item.writePaths ?? item.suggestedFiles));
  need(allPaths.has('src/app.mjs'), '规划须包含平台约定的src/app.mjs入口。');
  validateProjectFiles([...allPaths].map(path => ({ path, content: '' })));
  let executionTask = null;
  if (taskExecution !== undefined) {
    const selected = copyBrowserScenarioData(taskExecution, 4096);
    need(Object.keys(selected).every(key => ['attemptId', 'integration'].includes(key)) && /^[A-Za-z0-9_-]{1,128}$/u.test(selected.attemptId ?? '')
      && (selected.integration === undefined || typeof selected.integration === 'boolean'), '逐任务执行必须绑定控制器认领的尝试。');
    need(hash(canonicalJSON(taskData.tasks)) === definition.taskSetHash, '逐任务执行的完整任务集合与批准文件范围不同。');
    executionTask = taskData.tasks.find(item => item.id === identity.taskId);
    need(executionTask, '逐任务执行未绑定确认计划中的任务。');
    if (selected.integration === true) {
      need(!isTaskCompiledManifest(manifest), '集成验收必须使用完整批准清单。');
      const byId = new Map(taskData.tasks.map(item => [item.id, item])), ancestors = new Set();
      const visit = item => { for (const id of item.dependsOn) if (!ancestors.has(id)) { ancestors.add(id); visit(byId.get(id)); } };
      visit(executionTask);
      need(ancestors.size === taskData.tasks.length - 1, '最终集成任务必须依赖所有开发任务。');
    } else need(isTaskCompiledManifest(manifest) && definition.executionScope.taskId === identity.taskId, '开发任务必须使用该任务的批准派生清单。');
    taskExecution = { attemptId: selected.attemptId, integration: selected.integration === true, taskId: identity.taskId,
      taskSetHash: definition.taskSetHash, taskDefinitionHash: hash(canonicalJSON(executionTask)) };
  } else need(!isTaskCompiledManifest(manifest), '局部清单不能作为整项目执行。');
  const writable = new Set(executionTask ? executionTask.writePaths ?? executionTask.suggestedFiles : allPaths);
  need(writable.size > 0, '当前开发任务没有明确可写文件。');
  need([initialSource, initialTaskBase, evolutionSeed].filter(value => value !== undefined).length <= 1 && (initialTaskBase === undefined || taskExecution), '初始任务基础、同版修复来源与跨版演进来源不能混用。');
  need(repairNote === undefined || initialSource !== undefined && !taskExecution && typeof repairNote === 'string' && repairNote.length <= 2000 && repairNote.trim() === repairNote && repairNote.length > 0, '修复说明只能用于保留源码的整项目修复。');
  let source = initialTaskBase !== undefined ? assertPlannedTaskSeed(initialTaskBase, identity) : initialSource === undefined ? null : resolvePlannedTaskBase(initialSource, identity, [...allPaths]), evolution = null, evolutionContext = null;
  need(writable.has('src/app.mjs') || source?.files.some(file => file.path === 'src/app.mjs') || evolutionSeed !== undefined, '非入口任务必须先取得已核对的基础程序。');
  let confirmedTask = JSON.stringify({ ...taskData, ...(executionTask ? { activeTask: executionTask, executionScope: taskExecution.integration ? { kind: 'integration', parentHash: definition.manifestHash } : definition.executionScope } : {}),
    writablePaths: [...writable], readonlyPaths: [...allPaths].filter(item => !writable.has(item)), acceptedVerification: Object.fromEntries(['version', 'id', 'name', 'sessions', 'steps', 'limits', 'browser'].map(key => [key, definition[key]])),
    interface: 'src/app.mjs exports async createApp({databasePath}) -> {handle({method,path,headers,body}),close?}; SQLite只使用传入路径；原生前端放public；平台拥有server/package/runtime；禁止额外路径、Shell、网络、子进程和端口。acceptedVerification是编码前已认可的精确验收条件，含浏览器文本与选择器约定；不得改写该定义。它不包含当前测试结果。' });
  need(Buffer.byteLength(confirmedTask) <= 131072, '确认任务与完整验收约定超过模型上下文上限；须重新拆分，不能截断条件。');
  const controller = new AbortController(), cancel = () => controller.abort();
  let expired = false, uncertain = false, directoryPath, rework, queue = Promise.resolve();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  const deadline = Date.now() + timeoutMs, timer = setTimeout(() => { expired = true; cancel(); }, timeoutMs);
  const record = { id: randomUUID(), ...identity, attemptId: taskExecution?.attemptId ?? randomUUID(), profileId: 'planned-web-v1', providerKind, reviewerKind, executorPolicyHash: plannedExecutionPolicyHash,
    manifestHash: definition.manifestHash, browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: projectReviewPolicy.hash, reviewHistoryVersion: 2,
    status: 'preparing', acceptanceStatus: 'not_checked', startedAt: new Date().toISOString(), finishedAt: null,
    budget: { maxCalls, maxReviewCalls, maxModelCalls: maxCalls + maxReviewCalls, timeoutMs }, modelCalls: [], totalModelCalls: 0, usage: { inputTokens: null, outputTokens: null },
    versions: [], events: [], gitCommands: [], candidateCommit: null, baseCommit: null, diff: '', error: null, errorCode: null, terminationConfirmed: false, writablePaths: [...writable],
    ...(source ? initialTaskBase !== undefined ? { taskSeed: source.provenance } : { initialSource: source.provenance } : {}), ...(taskExecution ? { taskExecution } : {}),
    ...(repairNote === undefined ? {} : { repairNote }) };
  const proposalErrors = new WeakMap(), completedProposals = new WeakMap(), datasetCaps = new Map(), candidateSources = new Map(); let protectedFiles;
  function current() {
    need(!controller.signal.aborted && Date.now() < deadline, '执行已取消或超时。');
    const value = assertCurrent(structuredClone(identity)); need(value !== false && (!value || typeof value.then !== 'function'), '当前版本门禁必须同步通过，不能在发布窗口返回Promise。');
    assertCompiledManifest(manifest, Object.fromEntries(baseKeys.map(key => [key, identity[key]])));
    if (evolution) assertPlannedEvolutionSeedCurrent(evolutionSeed, evolutionContext);
  }
  function event(message, detail = {}) {
    const item = { sequence: record.events.length + 1, at: new Date().toISOString(), status: record.status, message, ...detail };
    if (record.events.length < 500) record.events.push(item);
    try { const pending = onEvent(structuredClone(item)); if (pending?.catch) void pending.catch(() => {}); } catch { /* An observer cannot grant completion. */ }
  }
  function save() {
    if (!directoryPath) return Promise.resolve(); const body = JSON.stringify(record, null, 2);
    queue = queue.then(async () => { const target = path.join(directoryPath, 'execution.json'), temp = `${target}.${randomUUID()}.tmp`; await writeFile(temp, body, { flag: 'wx', mode: 0o600 }); await rename(temp, target); }); return queue;
  }
  async function git(args, trim = true) {
    current(); const result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: record.workspace, signal: controller.signal, timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), maxOutputBytes: 2 * 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(record.workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    }); record.gitCommands.push({ args, ...result }); uncertain ||= result.terminationConfirmed !== true;
    current(); need(result.exitCode === 0 && !result.stopReason && !result.truncated && result.terminationConfirmed, 'Git版本操作没有完整正常结束。'); return trim ? result.stdout.trim() : result.stdout;
  }
  async function fixed(candidate) {
    current(); need(await git(['rev-parse', 'HEAD']) === candidate.candidateCommit && !(await git(['status', '--porcelain', '--untracked-files=all'])), '候选代码版本或工作区变化。');
    const files = await readProjectFiles(record.workspace);
    need(sourceHash(files) === candidate.sourceHash && (await verifyWebShell({ workspace: record.workspace })).hash === record.shellHash, '候选源码或保护外壳变化。');
    const tree = new Map((await git(['ls-tree', '-rz', '--full-tree', candidate.candidateCommit], false)).split('\0').filter(Boolean).map(line => {
      const found = line.match(/^([0-7]{6}) blob ([a-f0-9]{40})\t(.+)$/su); need(found, 'Git树包含非普通文件。'); return [found[3], found[2]];
    }));
    for (const file of files) {
      const contents = Buffer.from(file.content, 'utf8'), blob = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
      need(tree.get(file.path) === blob, '被检文件与固定Git提交的blob不一致。');
    }
    current();
  }
  async function modelCall(role, callback, input) {
    current(); const kind = role === 'coding' ? providerKind : reviewerKind, attempt = record.modelCalls.filter(item => item.role === role).length + 1;
    need(attempt <= (role === 'coding' ? maxCalls : maxReviewCalls), '模型调用预算已用尽。');
    const call = { id: randomUUID(), role, kind, attempt, ...identity, attemptId: record.attemptId, startedAt: new Date().toISOString(), finishedAt: null,
      candidateCommit: role === 'review' ? record.candidateCommit : null, inputSourceHash: sourceHash(input.files), manifestHash: definition.manifestHash,
      sourceRevision: evolution?.targetBinding.sourceRevision ?? binding.sourceRevision ?? null,
      usage: { inputTokens: null, outputTokens: null }, receiptConfirmed: false, requestState: 'prepared', errorCode: null };
    if (role === 'coding' && input.literalFiles) call.codeWireVersion = 2;
    if (role === 'review' && input.responseFeedback) call.responseFeedback = structuredClone(input.responseFeedback);
    record.modelCalls.push(call); record.totalModelCalls = record.modelCalls.filter(item => item.kind === 'model').length;
    let accepting = true, seen = false, violated = false, receipt, writing, writerSettled = true, settled = false, requestError, interrupt, request, requestStarted = false;
    const onReceipt = async value => {
      try {
        current(); need(accepting && !seen, '回执不属于当前调用或重复。'); seen = true;
        need(value && typeof value.model === 'string' && value.model.length <= 200 && typeof value.content === 'string' && Buffer.byteLength(value.content) <= (role === 'coding' ? 512 : 128) * 1024, '回执结构无效。');
        need(value.reviewWireVersion === undefined || role === 'review' && value.reviewWireVersion === 2, '回执wire版本无效。');
        if (role === 'review') { const wireVersion = value.reviewWireVersion ?? 1; need(record.reviewWireVersion === undefined || record.reviewWireVersion === wireVersion, '同次执行的Review wire版本不能改变。'); record.reviewWireVersion = wireVersion; }
        receipt = { model: value.model, finishReason: value.finishReason, usage: Object.fromEntries(['inputTokens', 'outputTokens'].map(key => [key, Number.isSafeInteger(value.usage?.[key]) && value.usage[key] >= 0 ? value.usage[key] : null])), content: value.content,
          ...(value.reviewWireVersion === 2 ? { reviewWireVersion: 2 } : {}) };
        if (receipt.reviewWireVersion === 2) call.reviewWireVersion = 2;
        call.dispatched = true;
        call.usage = receipt.usage; call.finishReason = receipt.finishReason; call.model = receipt.model;
        for (const key of ['inputTokens', 'outputTokens']) {
          const total = record.modelCalls.reduce((sum, item) => sum + (item.usage[key] ?? 0), 0);
          record.usage[key] = record.modelCalls.every(item => item.usage[key] !== null) && Number.isSafeInteger(total) ? total : null;
        }
        const contents = JSON.stringify(receipt), filename = path.join(directoryPath, `model-${role}-${attempt}.json`);
        writerSettled = false; writing = writeFile(filename, contents, { flag: 'wx', mode: 0o600 }); writing.then(() => { writerSettled = true; }, () => { writerSettled = true; });
        await writing; current(); need(accepting, '回执已过期。');
        const bytes = await readFile(filename); need(bytes.equals(Buffer.from(contents)), '私有回执内容不一致。');
        call.receiptHash = hash(bytes); call.receiptPath = filename; call.receiptConfirmed = true;
        current(); return freezeData({ callId: call.id, receiptHash: call.receiptHash, usage: { ...call.usage }, model: call.model, finishReason: call.finishReason });
      } catch (error) { violated = true; throw error; }
    };
    try {
      // Persist the full request identity before any provider callback can send.
      await save(); current();
      const sourceRevision = call.sourceRevision;
      need(sourceRevision === null || /^[a-f0-9]{64}$/u.test(sourceRevision), '可信请求的来源版本无效。');
      const requestIdentity = freezeData({ version: 1, id: call.id, role: call.role, kind: call.kind, attempt: call.attempt, ...Object.fromEntries([...baseKeys, 'taskId', 'attemptId'].map(key => [key, call[key]])), sourceRevision, manifestHash: call.manifestHash, inputSourceHash: call.inputSourceHash, candidateCommit: call.candidateCommit });
      request = Promise.resolve().then(() => { current(); requestStarted = true; call.requestState = 'in_flight'; return callback({ ...input, requestIdentity, signal: controller.signal, onReceipt }); });
      request.then(() => { settled = true; }, error => { settled = true; requestError = error; });
      const stoppedRequest = new Promise((_, reject) => { interrupt = () => reject(new Error('模型本地请求已停止。')); controller.signal.addEventListener('abort', interrupt, { once: true }); });
      const response = await Promise.race([request, stoppedRequest]); if (writing) await writing; current();
      need(!violated && call.receiptConfirmed && receipt?.finishReason === 'stop', '缺少正常且完整的私有模型回执。');
      if (role === 'coding') {
        const returned = decodeProjectCodeResponse(receipt.content, { literalFiles: call.codeWireVersion === 2 });
        if (sourceHash(response.files) !== sourceHash(returned)) throw executionError('receipt_mismatch', '编码返回内容与私有回执不一致。');
      } else {
        const returned = receipt.reviewWireVersion === 2 ? decodeProjectReviewResponseV2(receipt.content, input) : JSON.parse(receipt.content);
        need(hash(validateProjectReviewResponse(response, input)) === hash(validateProjectReviewResponse(returned, input)), 'Review返回与私有回执不一致。');
      }
      call.terminationConfirmed = true; call.requestState = 'completed';
      if (role === 'coding' && kind === 'model') completedProposals.set(call, { receiptHash: call.receiptHash });
      await save(); return response;
    } catch (error) {
      let cleanupTimer;
      try { await Promise.race([Promise.allSettled([request, writing]), new Promise(resolve => { cleanupTimer = setTimeout(resolve, 250); })]); }
      finally { clearTimeout(cleanupTimer); }
      const evidence = getModelRequestEvidence(requestError ?? error), remoteKnown = !requestStarted || !!receipt || evidence && (!evidence.dispatched || evidence.responseComplete);
      call.terminationConfirmed = !requestStarted || settled && writerSettled && !!remoteKnown;
      uncertain ||= !call.terminationConfirmed;
      call.dispatched = !requestStarted ? false : receipt ? true : evidence ? evidence.dispatched : true;
      if (!requestStarted || evidence && !evidence.dispatched) call.usage = { inputTokens: 0, outputTokens: 0 };
      call.requestState = call.dispatched === false ? 'not_dispatched' : call.terminationConfirmed ? 'completed' : 'unknown'; call.errorCode = safeErrorCode(error);
      record.totalModelCalls = record.modelCalls.filter(item => item.kind === 'model' && item.dispatched !== false).length;
      if (role === 'coding' && kind === 'model' && error?.code === 'invalid_model_response' && evidence?.dispatched === true && evidence.responseComplete === true
        && call.terminationConfirmed && !uncertain && !violated && call.receiptConfirmed && receipt?.finishReason === 'stop') proposalErrors.set(error, call);
      const responseFeedback = role === 'review' && getProjectReviewResponseFeedback(error);
      if (kind === 'model' && error?.code === 'invalid_model_response' && responseFeedback && evidence?.dispatched === true && evidence.responseComplete === true
        && call.terminationConfirmed && !uncertain && !violated && call.receiptConfirmed && receipt?.finishReason === 'stop' && receipt.reviewWireVersion === 2) {
        call.reviewRejection = { ...responseFeedback, code: 'invalid_model_response', callId: call.id, candidateCommit: call.candidateCommit, inputSourceHash: call.inputSourceHash, receiptHash: call.receiptHash };
      }
      throw error;
    } finally { call.finishedAt = new Date().toISOString(); accepting = false; if (interrupt) controller.signal.removeEventListener('abort', interrupt); }
  }
  function assertDatasets(version, candidate, all = true) {
    if (!evolution) return;
    const cap = datasetCaps.get(candidate.candidateCommit); need(cap, '当前候选缺少可信数据集验证能力。');
    assertPlannedVerificationDatasetReceipt(cap, version.selfCheck?.dataset, { manifest, binding: candidate, phase: 'self_check' });
    if (!all) return;
    assertPlannedVerificationDatasetReceipt(cap, version.acceptance?.test?.dataset, { manifest, binding: candidate, phase: 'http' });
    const expected = datasetPhases(definition), receipts = version.acceptance?.browser?.dataset;
    need(Array.isArray(receipts) && receipts.length === expected.length && expected.every(phase => receipts.filter(receipt => receipt.phase === phase).length === 1), '浏览器检查没有逐副本覆盖同一旧数据快照。');
    for (const receipt of receipts) assertPlannedVerificationDatasetReceipt(cap, receipt, { manifest, binding: candidate, phase: receipt.phase });
    need(completeEvolutionDatasets(record, version, candidate, definition), '数据迁移回执与当前候选、旧快照或迁移确认不一致。');
  }
  function modelFailures(checks, historical = false) {
    const failed = (Array.isArray(checks) ? checks : []).filter(check => check.passed !== true);
    if (!evolution) return failed;
    return failed.map(check => ({ id: typeof check.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(check.id) ? check.id : 'unidentified_check', passed: false,
      ...(!historical ? { name: [...definition.checks, ...browserScenarioChecks(definition.browser)].find(rule => rule.id === check.id)?.name ?? '批准断言', message: '断言未满足' } : {}) }));
  }
  async function rejectBeforeApply(call, reason, inputFiles) {
    current(); need(call === record.modelCalls.at(-1) && call.role === 'coding' && call.kind === 'model' && call.terminationConfirmed === true && call.receiptConfirmed === true && call.finishReason === 'stop', '提案不满足可信写入前拒绝条件。');
    const bytes = await readFile(call.receiptPath);
    if (hash(bytes) !== call.receiptHash) throw executionError('receipt_mismatch', '写入前回执指纹已变化，停止自动修复。');
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    need(receipt.model === call.model && receipt.finishReason === 'stop' && canonicalJSON(receipt.usage) === canonicalJSON(call.usage), '写入前回执归属或用量不同。');
    need(sourceHash(await readProjectFiles(record.workspace)) === call.inputSourceHash && call.inputSourceHash === sourceHash(inputFiles)
      && (await verifyWebShell({ workspace: record.workspace })).hash === record.shellHash, '提案拒绝前源码或保护文件已变化。');
    const beforeCommit = record.versions.at(-1)?.commit ?? record.baseCommit;
    need(await git(['rev-parse', 'HEAD']) === beforeCommit && !(await git(['status', '--porcelain', '--untracked-files=all'])), '提案拒绝前Git或文件状态已变化。'); current();
    call.errorCode = reason; call.proposalRejection = { version: 1, stage: 'before_apply', reason, callId: call.id, baseCommit: beforeCommit,
      inputSourceHash: call.inputSourceHash, receiptHash: call.receiptHash, applied: false, terminationConfirmed: true };
    record.status = 'proposal_rejected'; record.errorCode = call.attempt < maxCalls ? reason : 'retry_exhausted';
    event(`第${call.attempt}/${maxCalls}次编码建议在应用任何文件前被拒绝（${reason === 'proposal_invalid' ? 'JSON或文件字段格式不符' : '超出当前精确可写范围'}）；${call.attempt < maxCalls ? '仅在原调用预算和时限内重试' : '原次数已用尽，停止自动修复'}。`,
      call.attempt < maxCalls ? { type: 'automatic_rework', cause: 'proposal', nextRound: call.attempt + 1 } : {}); await save();
    if (call.attempt >= maxCalls) throw executionError('retry_exhausted', '编码建议重试次数已用尽，原失败回执和费用保留。');
  }
  async function upstreamRework(candidate, version, files, previousIssues) {
    const gate = version.acceptance;
    if (!taskExecution?.integration || isTaskCompiledManifest(manifest) || providerKind !== 'model' || reviewerKind !== 'model'
      || !completeHttp(version.selfCheck, candidate, definition) || !completeHttp(gate?.test, candidate, definition) || !completeBrowser(gate?.browser, candidate, definition)
      || gate.review?.status !== 'completed' || gate.review.policyHash !== projectReviewPolicy.hash || gate.errors.length
      || !candidateKeys.every(key => gate.review.binding?.[key] === candidate[key])) return null;
    const issues = gate.issues.filter(issue => issue.severity === 'blocking' && issue.status === 'open'), outside = issues.filter(issue => !writable.has(issue.file));
    if (!outside.length) return null;
    const targets = new Map(), ancestors = new Set(), byId = new Map(taskData.tasks.map(item => [item.id, item]));
    const visit = item => { for (const id of item.dependsOn) if (!ancestors.has(id)) { ancestors.add(id); visit(byId.get(id)); } }; visit(executionTask);
    for (const issue of outside) {
      const owners = taskData.tasks.filter(item => item.id !== executionTask.id && ancestors.has(item.id) && (item.writePaths ?? item.suggestedFiles).includes(issue.file));
      if (owners.length !== 1) return null;
      const owner = owners[0]; if (!targets.has(owner.id)) targets.set(owner.id, { taskId: owner.id, taskDefinitionHash: hash(canonicalJSON(owner)), requiredPaths: [] });
      const target = targets.get(owner.id); if (!target.requiredPaths.includes(issue.file)) target.requiredPaths.push(issue.file);
    }
    const calls = record.modelCalls;
    if (!calls.length || calls.some(call => !hasCompletePlannedModelReceipt(call)
      || ![...baseKeys, 'taskId', 'attemptId'].every(key => call[key] === record[key]) || call.manifestHash !== definition.manifestHash)) return null;
    if (!record.versions.every(applied => calls.filter(call => call.role === 'coding' && call.attempt === applied.attempt && call.finishReason === 'stop').length === 1)) return null;
    const reviewCall = calls.filter(call => call.role === 'review' && call.candidateCommit === candidate.candidateCommit && call.inputSourceHash === candidate.sourceHash).at(-1);
    if (!reviewCall || reviewCall.id !== gate.review.primaryCallId || reviewCall.finishReason !== 'stop') return null;
    let originalReview;
    for (const call of calls) {
      current(); const filename = path.join(directoryPath, `model-${call.role}-${call.attempt}.json`);
      const stat = await lstat(filename);
      if (filename !== call.receiptPath || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw executionError('receipt_mismatch', '返工前私有模型回执无法核对。');
      const bytes = await readFile(filename);
      if (hash(bytes) !== call.receiptHash) throw executionError('receipt_mismatch', '返工前私有模型回执指纹已变化。');
      const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (receipt.model !== call.model || receipt.finishReason !== call.finishReason || canonicalJSON(receipt.usage) !== canonicalJSON(call.usage)) throw executionError('receipt_mismatch', '返工前私有模型回执归属或用量不同。');
      if (call.role === 'review' && receipt.reviewWireVersion !== call.reviewWireVersion) throw executionError('receipt_mismatch', '返工前Review wire版本不同。');
      if (call === reviewCall) originalReview = validateProjectReviewResponse(receipt.reviewWireVersion === 2 ? decodeProjectReviewResponseV2(receipt.content, { files, previousIssues }) : JSON.parse(receipt.content), { files, previousIssues });
    }
    if (hash(originalReview) !== hash(Object.fromEntries(['summary', 'issues', 'resolutions'].map(key => [key, gate.review[key]])))) throw executionError('receipt_mismatch', '返工前原始Review意见与本轮门禁不同。');
    await fixed(candidate); current();
    const ordered = [...targets.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)); ordered.forEach(target => target.requiredPaths.sort());
    return freezeData(structuredClone({ kind: 'integration_rework', taskId: identity.taskId, attemptId: record.attemptId,
      manifestHash: definition.manifestHash, taskSetHash: definition.taskSetHash, candidateCommit: candidate.candidateCommit, sourceHash: candidate.sourceHash,
      taskIds: ordered.map(target => target.taskId), targets: ordered, issues }));
  }
  const done = (async () => {
    try {
      current(); await assertPlannedBrowserDependency(); current();
      if (evolutionSeed !== undefined) {
        current(); const summary = await describePlannedEvolutionSeed(evolutionSeed, { signal: controller.signal, timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) }); current();
        need(baseKeys.every(key => summary.targetBinding[key] === identity[key]) && (binding.sourceRevision === undefined || summary.targetBinding.sourceRevision === binding.sourceRevision), '跨版来源没有绑定本次新确认规划。');
        evolutionContext = { targetBinding: summary.targetBinding, requirements: summary.requirements, tasks: taskData.tasks, approvedTaskSetHash: definition.taskSetHash ?? hash(canonicalJSON(taskData.tasks)), retainedPaths: summary.retainedPaths };
        evolution = await assertPlannedEvolutionSeed(evolutionSeed, evolutionContext, { signal: controller.signal, timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) }); current();
        need(evolution.retainedPaths.every(file => allPaths.has(file)), '新确认计划必须覆盖全部保留旧源码。');
        source = { files: evolution.files, provenance: evolution.provenance.source, previousIssues: evolution.previousIssues, previousFailures: evolution.previousFailures };
        record.evolutionSource = evolution.provenance; record.evolutionSeedHash = evolution.seedHash; record.evolutionHistory = evolution.historicalCosts;
        const approvedMigration = assertMigrationPlan(evolution.compiledMigrationPlan, evolution.targetBinding).plan;
        record.evolutionMigration = structuredClone(approvedMigration); record.evolutionInputSchema = structuredClone(evolution.inputSchema);
        need(completeEvolutionRecipe(record), '已确认迁移配方或schema指纹不一致。');
        confirmedTask = JSON.stringify({ ...JSON.parse(confirmedTask), evolution: { kind: 'evolution', platformPreMigration: true, inputSchema: evolution.inputSchema,
          operations: approvedMigration.operations.map(operation => Object.fromEntries(['op', 'table', 'column', 'type', 'nullable'].filter(key => Object.hasOwn(operation, key)).map(key => [key, operation[key]]))),
          inputSchemaHash: evolution.provenance.snapshot.schemaHash, inputSnapshotHash: evolution.provenance.snapshot.snapshotHash,
          migrationRevision: evolution.provenance.migration.revision, operationsHash: evolution.provenance.migration.operationsHash,
          instruction: '平台在每个已有数据验证副本启动前完成已确认迁移，应用不得重复ALTER；业务规则以新确认规格和工程为准，兼容已迁移库。空库可用完整新schema的CREATE IF NOT EXISTS初始化。提示不含旧行或迁移值字面量。' } });
        need(Buffer.byteLength(confirmedTask) <= 131072, '确认任务和安全迁移上下文超过模型上限；拒绝截断。');
      }
      current(); directoryPath = await mkdtemp(path.join(await directory(outputDir), 'planned-web-'));
      record.reportPath = path.join(directoryPath, 'execution.json'); record.workspace = path.join(directoryPath, 'workspace'); await mkdir(record.workspace);
      if (source && (taskExecution || evolution)) {
        need(typeof source.provenance.sourceWorkspace === 'string' && path.isAbsolute(source.provenance.sourceWorkspace), '任务基础缺少受控Git来源。');
        await git(['clone', '--no-local', '--no-hardlinks', '--', source.provenance.sourceWorkspace, '.']);
        need(await git(['rev-parse', 'HEAD']) === source.provenance.sourceCommit && sourceHash(await readProjectFiles(record.workspace)) === source.provenance.sourceHash, '克隆基础与已核对提交不一致。');
        record.shellHash = (await verifyWebShell({ workspace: record.workspace })).hash;
        event('从已核对候选克隆独立Git仓库，保留真实基础提交和祖先链。');
      } else record.shellHash = (await installWebShell({ workspace: record.workspace })).hash;
      if (evolution) { protectedFiles = await getWebShellFiles(); current(); }
      await mkdir(path.join(record.workspace, '.platform', 'tmp'), { recursive: true }); await writeFile(path.join(record.workspace, '.platform', 'gitconfig'), '', { flag: 'wx' });
      record.status = 'checking_environment'; event('检查隔离环境，尚未请求编码。'); await save();
      record.environment = await createWindowsSandbox({ executable }).preflight({ workspace: record.workspace, signal: controller.signal }); current();
      if (source && !taskExecution && !evolution) { await applyProjectFiles({ workspace: record.workspace, files: source.files }); event('已核对原代码来源并复制到新工作区；不继承历史验收。'); current(); }
      if (!source || !taskExecution && !evolution) { await git(['init', '--quiet']); await git(['add', '--', '.']); await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'commit', '--quiet', '-m', 'base: confirmed plan and protected web shell']); }
      record.baseCommit = await git(['rev-parse', 'HEAD']);
      let previousIssues = structuredClone(source?.previousIssues ?? []);
      let feedback = source ? JSON.stringify({ message: '保留已核对的原代码，按完整批准定义修复；所有历史阻塞必须在新版本重新检查。原验收结论不继承。', previousIssues, previousFailures: evolution ? Object.fromEntries(Object.entries(source.previousFailures).map(([phase, checks]) => [phase, modelFailures(checks, true)])) : source.previousFailures }) : '';
      let verificationFeedback = feedback, literalFiles = false, previousFailureFingerprint = null, lastCandidate;
      function stopWithoutRepairEvidence() {
        record.status = 'failed';
        record.errorCode = 'verification_failed';
        record.error = '检查未获得属于当前候选的完整可返工证据，已保留本轮记录。';
        event(record.error, { type: 'automatic_rework_blocked', cause: 'verification_failed' });
      }
      function stopIfUnchanged(phase, evidence) {
        const fingerprint = hash(canonicalJSON({ phase, evidence }));
        const repeated = fingerprint === previousFailureFingerprint;
        previousFailureFingerprint = fingerprint;
        if (!repeated) return false;
        record.status = 'failed';
        record.errorCode = 'rework_no_progress';
        record.error = '自动返工后复验再次得到相同的失败结果，请先查看卡住的检查或调整修复方向。';
        event(record.error, { type: 'automatic_rework_blocked', cause: 'rework_no_progress' });
        return true;
      }
      for (let attempt = 1; attempt <= maxCalls; attempt++) {
        if (record.modelCalls.filter(item => item.role === 'review').length >= maxReviewCalls) break;
        current(); record.status = 'generating'; event(`根据当前确认规格进行第${attempt}次编码。`, { type: 'coding_round', round: attempt }); await save();
        const inputFiles = await readProjectFiles(record.workspace); let proposal, rejection;
        if (lastCandidate) need(sourceHash(inputFiles) === lastCandidate.sourceHash, '返工输入已偏离失败候选。');
        const codingFeedback = repairNote === undefined ? feedback : JSON.stringify({ ...JSON.parse(feedback), operatorDiagnosis: repairNote });
        try { proposal = await modelCall('coding', provider, { task: confirmedTask, files: inputFiles, feedback: codingFeedback, ...(literalFiles ? { literalFiles } : {}) }); }
        catch (error) { const call = proposalErrors.get(error); if (!call) throw error; rejection = { call, reason: 'proposal_invalid' }; }
        let updates;
        if (!rejection) {
          updates = validateProjectFiles(proposal.files);
          if (!updates.every(file => writable.has(file.path))) {
            const call = record.modelCalls.at(-1); need(completedProposals.get(call)?.receiptHash === call.receiptHash, '没有正常匹配回执，不允许自动修复文件范围。');
            rejection = { call, reason: 'proposal_outside_scope' };
          }
        }
        if (rejection) {
          await rejectBeforeApply(rejection.call, rejection.reason, inputFiles);
          literalFiles ||= rejection.reason === 'proposal_invalid';
          feedback = JSON.stringify({ stage: 'before_apply', reason: rejection.reason, applied: false, remainingCodingCalls: maxCalls - attempt,
            message: '上次文件建议未应用。按当前系统提示的文件格式重新提交完整文件。只能修改allowedPaths中的精确文件；不能输出未来任务文件、额外字段授权、命令或修改验收定义。',
            allowedPaths: [...writable], previousIssues, previousVerificationFeedback: verificationFeedback });
          continue;
        }
        record.errorCode = null; record.error = null;
        if (lastCandidate) await fixed(lastCandidate);
        current(); const changed = await applyProjectFiles({ workspace: record.workspace, files: updates });
        if (!changed.changed.length) throw executionError('unchanged_candidate', '本轮返工没有改变代码。');
        await verifyWebShell({ workspace: record.workspace }); await git(['add', '--', ...changed.changed]);
        await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'commit', '--quiet', '-m', `candidate: planned attempt ${attempt}`]);
        const files = await readProjectFiles(record.workspace), commit = await git(['rev-parse', 'HEAD']); record.candidateCommit = commit; record.diff = await git(['diff', record.baseCommit, commit, '--'], false);
        const candidate = { ...identity, attemptId: record.attemptId, candidateCommit: commit, sourceHash: sourceHash(files), manifestHash: definition.manifestHash, browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: projectReviewPolicy.hash };
        lastCandidate = candidate;
        const version = { attempt, commit, sourceHash: candidate.sourceHash, selfCheck: null, acceptance: null }; record.versions.push(version); if (evolution) candidateSources.set(commit, freezeData(structuredClone(files))); await fixed(candidate);
        const datasetSeed = evolution ? await createPlannedVerificationDataset({ evolutionSeed, context: evolutionContext, manifest, binding: candidate }) : undefined; current();
        if (datasetSeed) datasetCaps.set(commit, datasetSeed);
        const http = phase => runHttpScenarios({ manifest, rootDir: directoryPath, files, binding: candidate, signal: controller.signal, executable, timeoutMs: Math.max(1, Math.min(definition.limits.timeoutMs, deadline - Date.now())), ...(datasetSeed ? { datasetSeed, phase } : {}) });
        record.status = 'self_check'; event('固定候选后运行自检。'); await save(); version.selfCheck = await http('self_check'); await fixed(candidate);
        if (completeHttp(version.selfCheck, candidate, definition)) assertDatasets(version, candidate, false);
        if (!completeHttp(version.selfCheck, candidate, definition)) {
          const report = version.selfCheck;
          uncertain ||= report?.status === 'reconciliation_required'; if (uncertain) throw new Error('自检进程停止待核对。');
          const failed = report?.status === 'failed' && confirmedHttp(report, candidate, definition);
          // An application that fails to initialize can exit before acknowledging a graceful stop.
          const failedStartup = report?.status === 'error' && boundHttp(report, candidate, definition) && report.terminationConfirmed === true
            && report.checks.some(check => check.id === 'SYS_START' && check.passed === false && check.executed === true)
            && Array.isArray(report.processes) && report.processes.length > 0
            && report.processes.every(process => process.terminationConfirmed === true && process.sourceUnchanged === true);
          const startupDiagnostic = failed || failedStartup ? safeStartupDiagnostic(report, files) : undefined;
          const evidence = failed ? repeatedEvidence(report.checks) : null;
          if (!startupDiagnostic && !evidence) { stopWithoutRepairEvidence(); break; }
          if (stopIfUnchanged('self_check', { startupDiagnostic: startupDiagnostic ?? null, checks: evidence })) break;
          if (startupDiagnostic) record.error = `候选启动失败：${startupDiagnostic.code}${startupDiagnostic.sourceLocation ? ` (${startupDiagnostic.sourceLocation.name}:${startupDiagnostic.sourceLocation.line})` : ''}`;
          const missingRoutes = missingPageRoutes(version.selfCheck, definition);
          feedback = JSON.stringify({ message: '修复自检失败，不能改变验收定义。', failedCandidate: candidate, checks: modelFailures(report.checks), ...(startupDiagnostic ? { startupDiagnostic } : {}),
            ...(missingRoutes.length ? { missingRoutes, routeHint: '这些已确认页面返回了404。平台不会自动托管public目录，应用handle需要按既定映射返回页面和它引用的静态资源。' } : {}) }); verificationFeedback = feedback;
          if (attempt < maxCalls) event('自检未通过，已安排修改代码并重新检查。', { type: 'automatic_rework', cause: 'self_check', nextRound: attempt + 1 });
          await save(); continue;
        }
        record.status = 'validating';
        const gate = version.acceptance = { binding: candidate, status: 'checking', phase: 'testing', test: null, browser: null, review: null, issues: structuredClone(previousIssues), errors: [] };
        event('在固定代码版本运行独立接口及浏览器测试。'); await save();
        const reviewCandidate = async responseFeedback => {
          await fixed(candidate);
          const response = await modelCall('review', reviewer, { task: confirmedTask, files: structuredClone(files), previousIssues: structuredClone(previousIssues), ...(responseFeedback ? { responseFeedback } : {}) });
          const primary = record.modelCalls.filter(call => call.role === 'review').at(-1);
          const result = validateProjectReviewResponse(response, { files, previousIssues });
          const { issues, openBlockingIssues } = reconcilePlannedReviewIssues({ result, previousIssues, commit });
          gate.issues = issues;
          gate.review = { ...result, status: 'completed', binding: candidate, policyHash: projectReviewPolicy.hash, primaryCallId: primary.id,
            ...(primary.reviewWireVersion === 2 ? { evidenceOrigin: projectReviewEvidenceOrigin } : {}), openBlockingIssues };
        };
        const formatFeedback = error => {
          const failed = record.modelCalls.filter(call => call.role === 'review').at(-1), feedback = getProjectReviewResponseFeedback(error);
          return feedback && failed?.reviewRejection && failed.reviewRejection.callId === failed.id && failed.candidateCommit === commit && failed.inputSourceHash === candidate.sourceHash ? feedback : null;
        };
        const branchResults = await Promise.allSettled([
          (async () => { gate.test = await http('http'); })(),
          (async () => { gate.browser = await runBrowserScenarios({ manifest, files, rootDir: directoryPath, binding: candidate, signal: controller.signal, executable, timeoutMs: Math.max(1, Math.min(definition.browser.limits.timeoutMs, deadline - Date.now())), ...(datasetSeed ? { datasetSeed } : {}) }); })(),
        ]);
        for (const [index, outcome] of branchResults.entries()) if (outcome.status === 'rejected') {
          const role = ['test', 'browser'][index], error = outcome.reason;
          uncertain ||= error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false;
          gate[role] = { status: uncertain ? 'reconciliation_required' : 'error', binding: candidate, error: '该独立检查未获得完整有效结论。' };
          gate.errors.push({ role, code: error?.code === 'invalid_model_response' ? 'invalid_model_response' : 'verification_failed', terminationConfirmed: !uncertain });
        }
        await fixed(candidate); uncertain ||= [gate.test, gate.browser].some(item => item?.status === 'reconciliation_required');
        need(!uncertain, '独立进程或模型停止待核对。');
        const httpPassed = completeHttp(gate.test, candidate, definition);
        const browserPassed = completeBrowser(gate.browser, candidate, definition);
        const httpEvidence = gate.test?.status === 'failed' && confirmedHttp(gate.test, candidate, definition) ? repeatedEvidence(gate.test.checks) : null;
        const browserEvidence = gate.browser?.status === 'failed' && confirmedBrowser(gate.browser, candidate, definition) ? repeatedEvidence(gate.browser.checks) : null;
        if (!(httpPassed || httpEvidence) || !(browserPassed || browserEvidence)) {
          gate.status = record.acceptanceStatus = 'incomplete'; stopWithoutRepairEvidence(); break;
        }
        const observed = httpPassed && browserPassed;
        if (observed) {
          assertDatasets(version, candidate);
          gate.phase = 'review'; event('测试已通过，开始独立审查同一代码版本。'); await save();
          let responseFeedback;
          while (true) {
            try { await reviewCandidate(responseFeedback); gate.errors = gate.errors.filter(item => item.role !== 'review'); break; }
            catch (error) {
              responseFeedback = formatFeedback(error);
              const detail = responseFeedback?.reason === 'duplicate_issue' ? '审查返回了重复意见。'
                : responseFeedback ? '审查回执的格式或源码位置无效。' : '审查未获得完整有效的结论。';
              gate.review = { status: uncertain ? 'reconciliation_required' : 'error', binding: candidate, error: detail, ...(responseFeedback ? { diagnostic: responseFeedback } : {}) };
              gate.errors = [...gate.errors.filter(item => item.role !== 'review'), { role: 'review', code: error?.code === 'invalid_model_response' ? 'invalid_model_response' : 'verification_failed', terminationConfirmed: !uncertain }];
              if (!responseFeedback) throw error;
              if (record.modelCalls.filter(call => call.role === 'review').length >= maxReviewCalls) break;
              event('审查回执的格式或位置无效，正在同一版本重新审查。', { type: 'review_retry' }); await save();
            }
          }
          await fixed(candidate);
        }
        const passed = observed && completeEvolutionDatasets(record, version, candidate, definition) && gate.review?.status === 'completed' && gate.review.openBlockingIssues === 0;
        gate.status = passed ? 'passed' : observed && gate.review?.status !== 'completed' ? 'incomplete' : 'changes_requested';
        record.acceptanceStatus = gate.status;
        if (passed) { current(); record.status = providerKind === 'model' && reviewerKind === 'model' ? 'accepted' : 'diagnostic_passed'; break; }
        rework = await upstreamRework(candidate, version, files, previousIssues);
        if (rework) {
          record.status = 'failed'; record.errorCode = 'integration_rework_required'; record.error = '最终集成发现属于上游任务的阻塞问题，当前任务无权修改对应文件，已停止并保留返工证据。';
          event('完整同版本检查发现当前任务范围外的阻塞，停止继续集成编码，由控制器核对后退回精确上游任务；原回执和费用保留。'); await save(); break;
        }
        const loginIssue = httpPassed && browserEvidence && findMissingBrowserLogin({ definition, browserReport: gate.browser, files });
        if (loginIssue) {
          record.status = 'failed';
          record.errorCode = 'checklist_needs_revision';
          record.failureDiagnosis = loginIssue;
          record.error = '验收清单漏了此测试账号的登录步骤，请先补上登录步骤，再重新执行。';
          event(record.error, { type: 'automatic_rework_blocked', cause: 'browser_login_missing' });
          break;
        }
        const blockers = gate.issues.filter(item => item.severity === 'blocking');
        const unresolved = blockers.filter(item => item.status !== 'resolved');
        need(blockers.length <= PROJECT_REVIEW_HISTORY_LIMIT, '阻塞意见超过完整复验预算，停止且不截断。');
        // A closure is evidence for this commit only. Recheck every historical ID
        // on the next commit, even when a different blocker prompted the repair.
        previousIssues = blockers.map(({ resolution, checkedCommit, ...issue }) => ({ ...issue, status: 'open' }));
        const reviewEvidence = observed && gate.review?.status === 'completed' && unresolved.length
          ? [...new Set(unresolved.map(({ file, line, message, evidence }) => canonicalJSON({ file, line, message, evidence })))].sort() : null;
        if (!httpEvidence && !browserEvidence && !reviewEvidence) { stopWithoutRepairEvidence(); break; }
        if (stopIfUnchanged('acceptance', { httpEvidence, browserEvidence, reviewEvidence })) break;
        const startupDiagnostic = safeStartupDiagnostic(gate.test, files);
        feedback = JSON.stringify({ message: '依据失败证据和未关闭的阻塞意见修复；新版本重新检查，不更改清单。', failedCandidate: candidate, issues: unresolved, test: modelFailures(gate.test?.checks),
          browser: browserRepairEvidence(gate.browser, definition.browser, files, !evolution), reviewStatus: gate.review?.status ?? 'not_started', ...(startupDiagnostic ? { startupDiagnostic } : {}) }); verificationFeedback = feedback;
        if (attempt < maxCalls && record.modelCalls.filter(call => call.role === 'review').length < maxReviewCalls) {
          const cause = observed ? 'review' : 'testing';
          event(observed ? '审查发现待修复的问题，已安排修改代码并重新验收。' : '测试发现待修复的问题，已安排修改代码并重新验收。',
            { type: 'automatic_rework', cause, nextRound: attempt + 1 });
        }
        await save();
      }
      current(); if (!['accepted', 'diagnostic_passed'].includes(record.status)) { record.status = 'failed'; record.errorCode ??= 'verification_failed'; }
    } catch (error) {
      const gate = record.versions.at(-1)?.acceptance;
      if (gate?.status === 'checking') {
        gate.status = 'incomplete';
        record.acceptanceStatus = gate.status;
      }
      uncertain ||= error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false;
      record.error = '执行未获得当前版本完整有效结论，请保留证据。'; record.status = uncertain ? 'reconciliation_required' : expired ? 'timed_out' : controller.signal.aborted ? 'stopped' : 'failed';
      record.errorCode = uncertain ? 'transport_unknown' : expired ? 'timed_out' : controller.signal.aborted ? 'cancelled' : safeErrorCode(error);
    }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); record.finishedAt = new Date().toISOString(); record.terminationConfirmed = !uncertain;
      for (const key of ['inputTokens', 'outputTokens']) {
        const total = record.modelCalls.reduce((sum, item) => sum + (item.usage[key] ?? 0), 0);
        record.usage[key] = record.modelCalls.every(item => item.usage[key] !== null) && Number.isSafeInteger(total) ? total : null;
      }
      try { await save(); } catch { record.status = 'reconciliation_required'; record.terminationConfirmed = false; }
    }
    let evolutionHistory;
    if (['accepted', 'diagnostic_passed'].includes(record.status)) {
      try { current(); const version = record.versions.at(-1); assertDatasets(version, version.acceptance.binding);
        if (record.status === 'accepted' && evolution) { need(completeAcceptedRecord(record, manifest), '演进最终验收不完整。'); const files = candidateSources.get(record.candidateCommit); historicalCodeAudit(record, files, protectedFiles); current(); assertDatasets(version, version.acceptance.binding);
          evolutionHistory = { manifest, files, shell: freezeData(structuredClone(protectedFiles)), summary: historicalSummary(record), manifestHash: hash(canonicalJSON(manifest)) }; }
      }
      catch { record.status = 'failed'; record.acceptanceStatus = 'invalidated'; record.error = '最终发布前规划或验收许可已失效。'; try { await save(); } catch { record.status = 'reconciliation_required'; record.terminationConfirmed = false; } }
    }
    const result = structuredClone(record);
    if (record.status === 'accepted') verifiedExecutions.set(result, { manifest, hash: recordHash(result), ...(evolution ? { assertDataset: () => { const version = record.versions.at(-1); assertDatasets(version, version.acceptance.binding); } } : {}) });
    if (record.status === 'accepted' && evolutionHistory) historicalEvolutionProof.set(result, { ...evolutionHistory, recordHash: recordHash(result) });
    if (record.status === 'failed' && record.errorCode === 'integration_rework_required' && record.terminationConfirmed === true && rework) {
      try { current(); integrationReworks.set(result, { manifest, hash: recordHash(result), value: rework, assertCurrent: current }); } catch { /* A stale, cancelled or expired integration never authorizes rework. */ }
    }
    return result;
  })();
  return { id: record.id, cancel, done, snapshot: () => structuredClone(record) };
}
