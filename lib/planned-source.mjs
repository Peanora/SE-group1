import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { runProcess, minimalEnv } from './managed-process.mjs';
import { readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { getWebShellFiles, verifyWebShell } from './web-delivery.mjs';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';
import { validateProjectReviewResponse, decodeProjectReviewResponseV2, getProjectReviewResponseFeedback, projectReviewEvidenceOrigin, projectReviewPolicy } from './project-review-model.mjs';
import { reconcilePlannedReviewIssues } from './planned-review-issues.mjs';
import { decodeProjectCodeResponse } from './project-code-model.mjs';
import { canonicalJSON } from './verification-contract.mjs';
import { normalizeMigrationPlan } from './planned-migration-contract.mjs';

const sources = new WeakMap(), HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u;
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceHash = files => digest(validateProjectFiles(files));
const normalizedUsage = usage => Object.fromEntries(['inputTokens', 'outputTokens'].map(key => [key, Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : null]));
const notDispatched = call => call.dispatched === false && call.requestState === 'not_dispatched' && call.terminationConfirmed === true
  && call.receiptConfirmed === false && call.usage?.inputTokens === 0 && call.usage?.outputTokens === 0
  && ['receiptHash', 'receiptPath', 'model', 'finishReason', 'proposalRejection'].every(key => !Object.hasOwn(call, key));
const need = value => { if (!value) throw new Error('原代码来源、Git对象、回执或历史义务无法完整核对。'); };
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function inside(root, target) { const relative = path.relative(root, target); need(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); }
async function parents(target) {
  for (let current = target;; current = path.dirname(current)) {
    const stat = await lstat(current); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(current), current));
    if (current === path.dirname(current)) return;
  }
}
async function regularFile(filename, maximum) {
  await parents(path.dirname(filename)); const stat = await lstat(filename);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximum && samePath(await realpath(filename), filename));
  const bytes = await readFile(filename); need(bytes.length === stat.size); return bytes;
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function inspectedFile(state, filename, hash) {
  state.files ??= new Map(); const key = process.platform === 'win32' ? filename.toLowerCase() : filename;
  if (state.files.has(key)) need(state.files.get(key).hash === hash); else state.files.set(key, { filename, hash });
}
function sourceHistory(provenance, state) {
  const reports = new Map(), calls = new Map();
  const visit = reference => {
    const filename = path.resolve(reference.sourceReportPath), entry = state.records?.get(filename); need(entry && entry.reportHash === reference.sourceReportHash);
    if (reports.has(filename)) return; need(reports.size < 128);
    const record = entry.record, value = { reportHash: entry.reportHash, executionId: record.id, runId: record.runId, profileId: record.profileId, status: record.status, versions: record.versions ?? [], calls: [] }; reports.set(filename, value);
    for (const call of record.modelCalls ?? []) {
      const id = `${entry.reportHash}:${call.role}:${call.attempt}:${call.id ?? ''}`, item = { sourceReportHash: entry.reportHash, sourceExecutionId: record.id, sourceRunId: record.runId, call };
      if (calls.has(id)) need(canonicalJSON(calls.get(id)) === canonicalJSON(item)); else calls.set(id, item); value.calls.push(id);
    }
    const references = record.profileId === 'planned-task-merge-v1' ? [record.base, ...record.sources.map(item => item.provenance)] : [record.initialSource, record.evolutionSource?.source];
    for (const parent of references) if (parent?.sourceReportPath) visit(parent);
  };
  visit(provenance); const modelCalls = [...calls.values()];
  const usage = Object.fromEntries(['inputTokens', 'outputTokens'].map(key => { const sum = modelCalls.some(item => !Number.isSafeInteger(item.call.usage?.[key]) || item.call.usage[key] < 0) ? null : modelCalls.reduce((total, item) => total + item.call.usage[key], 0); return [key, Number.isSafeInteger(sum) ? sum : null]; }));
  const data = { reports: [...reports.values()].sort((a, b) => a.reportHash.localeCompare(b.reportHash)), modelCalls, receiptHashes: [...new Set(modelCalls.flatMap(item => item.call.receiptHash ? [item.call.receiptHash] : []))].sort(), totalModelCalls: modelCalls.filter(item => item.call.kind === 'model' && item.call.dispatched !== false).length, usage };
  return { ...data, historyHash: digest(canonicalJSON(data)) };
}
function evolutionBinding(record) {
  const value = record.evolutionSource, origin = value?.originBinding, target = value?.targetBinding;
  need(value?.version === 1 && value.kind === 'evolution_source_only' && value.reuseValidation === false && HASH.test(record.evolutionSeedHash ?? '') && digest(canonicalJSON(value)) === record.evolutionSeedHash);
  need(!record.initialSource && !record.taskSeed && origin && target && ['projectId', 'runId', 'specRevision', 'planRevision'].every(key => target[key] === record[key]) && origin.projectId === record.projectId && origin.runId !== target.runId);
  need(['sourceRevision', 'specRevision', 'planRevision', 'sourceHash'].every(key => HASH.test(origin[key] ?? '')) && ['sourceRevision', 'inputSnapshotHash', 'inputSchemaHash'].every(key => HASH.test(target[key] ?? '')));
  need(Number.isSafeInteger(origin.sourceGeneration) && origin.sourceGeneration >= 0 && Number.isSafeInteger(target.sourceGeneration) && target.sourceGeneration > origin.sourceGeneration && COMMIT.test(origin.candidateCommit ?? '') && record.baseCommit === origin.candidateCommit);
  need(value.source?.sourceCommit === origin.candidateCommit && value.source.sourceHash === origin.sourceHash && value.source.sourceExecutionId === origin.executionId && value.source.sourceRunId === origin.runId && value.source.projectId === origin.projectId && value.source.specRevision === origin.specRevision && value.source.planRevision === origin.planRevision);
  need(Array.isArray(value.retainedPaths) && HASH.test(value.taskSetHash ?? '') && HASH.test(value.historyHash ?? '') && value.snapshot?.originCommit === origin.candidateCommit && value.snapshot.snapshotHash === target.inputSnapshotHash && value.snapshot.schemaHash === target.inputSchemaHash && HASH.test(value.migration?.revision ?? '') && HASH.test(value.migration?.operationsHash ?? ''));
  const migration = normalizeMigrationPlan(record.evolutionMigration);
  need(canonicalJSON(migration) === canonicalJSON(record.evolutionMigration) && digest(JSON.stringify(migration)) === value.migration.operationsHash && HASH.test(value.inputSchemaMetadataHash ?? '') && digest(canonicalJSON(record.evolutionInputSchema)) === value.inputSchemaMetadataHash);
  return value;
}

/** Read-only controller admission. JSON, ZIP declarations and model-supplied paths do not create this capability. */
export async function inspectPlannedSource(options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000; need(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000 && (options.signal === undefined || options.signal instanceof AbortSignal));
  const controller = new AbortController(), abort = () => controller.abort(), deadline = Date.now() + timeoutMs;
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort(); const timer = setTimeout(abort, timeoutMs);
  const state = { processes: 0 }; let interrupted;
  const cancelled = new Promise((_, reject) => {
    // File reads are read-only and may settle late. Active Git must instead
    // finish its managed stop so an unknown child is not silently forgotten.
    interrupted = () => { if (state.processes === 0) reject(Object.assign(new Error('来源核对已取消或达到时长上限。'), { name: 'AbortError', code: 'source_interrupted' })); };
    controller.signal.addEventListener('abort', interrupted, { once: true }); if (controller.signal.aborted) interrupted();
  });
  try { return await Promise.race([Promise.resolve().then(() => inspectSource({ ...options, signal: controller.signal }, new Set(), deadline, state)), cancelled]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', interrupted); }
}

async function inspectSource({ rootDir, reportPath, binding, writablePaths, signal, expectedRecord }, visited, deadline, state) {
  need(!signal.aborted && Date.now() < deadline);
  need(typeof rootDir === 'string' && path.isAbsolute(rootDir) && path.resolve(rootDir) !== path.parse(rootDir).root && typeof reportPath === 'string' && path.isAbsolute(reportPath));
  const root = path.resolve(rootDir), filename = path.resolve(reportPath), visitKey = process.platform === 'win32' ? filename.toLowerCase() : filename;
  inside(root, filename); need(!visited.has(visitKey) && visited.size < 16); visited.add(visitKey);
  try {
  await parents(root); const bytes = await regularFile(filename, 32 * 1024 * 1024), reportHash = digest(bytes);
  inspectedFile(state, filename, reportHash);
  const record = copyBrowserScenarioData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), 32 * 1024 * 1024, { maxNodes: 250000 });
  state.records ??= new Map(); if (state.records.has(filename)) need(state.records.get(filename).reportHash === reportHash); else state.records.set(filename, { reportHash, record });
  if (expectedRecord !== undefined) need(digest(record) === digest(copyBrowserScenarioData(expectedRecord, 32 * 1024 * 1024, { maxNodes: 250000 })));
  if (record.profileId === 'planned-task-merge-v1') return await inspectMergeSource({ root, filename, record, reportHash, binding, writablePaths, signal }, visited, deadline, state);
  need(record.profileId === 'planned-web-v1' && record.providerKind === 'model' && ['model', 'diagnostic'].includes(record.reviewerKind) && record.terminationConfirmed === true && ['accepted', 'failed', 'stopped', 'timed_out'].includes(record.status)
    && typeof record.workspace === 'string' && path.isAbsolute(record.workspace) && Array.isArray(record.versions) && record.versions.length > 0 && record.versions.length <= 5
    && Array.isArray(record.modelCalls) && COMMIT.test(record.baseCommit ?? '') && COMMIT.test(record.candidateCommit ?? ''));
  for (const key of ['projectId', 'specRevision', 'planRevision']) need(typeof binding?.[key] === 'string' && record[key] === binding[key]);
  const callKeys = new Set();
  for (const call of record.modelCalls) {
    need(call && ['coding', 'review'].includes(call.role) && Number.isInteger(call.attempt) && call.attempt >= 1 && call.attempt <= 5
      && ['model', 'trusted_fixture', 'diagnostic'].includes(call.kind)
      && ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision'].every(key => typeof record[key] === 'string' && call[key] === record[key])
      && call.manifestHash === record.manifestHash && !callKeys.has(`${call.role}:${call.attempt}`));
    callKeys.add(`${call.role}:${call.attempt}`);
    // Both roles retain their original provider class. A paid Review cannot
    // become a diagnostic to disappear from the dispatch ledger.
    need(call.kind === (call.role === 'coding' ? record.providerKind : record.reviewerKind));
    if (call.proposalRejection !== undefined) need(call.role === 'coding');
    if (call.reviewRejection !== undefined) need(call.role === 'review' && call.reviewWireVersion === 2);
    if (call.codeWireVersion !== undefined) need(call.role === 'coding' && call.codeWireVersion === 2);
  }
  need(Number.isSafeInteger(record.totalModelCalls) && record.totalModelCalls === record.modelCalls.filter(call => call.kind === 'model' && call.dispatched !== false).length);
  const codingCalls = record.modelCalls.filter(call => call.role === 'coding').sort((a, b) => a.attempt - b.attempt);
  const reviewCalls = record.modelCalls.filter(call => call.role === 'review').sort((a, b) => a.attempt - b.attempt);
  need(reviewCalls.every((call, index) => call.attempt === index + 1) && new Set(reviewCalls.filter(call => call.receiptConfirmed).map(call => call.reviewWireVersion ?? 1)).size <= 1);
  need(record.reviewWireVersion === undefined || [1, 2].includes(record.reviewWireVersion) && reviewCalls.filter(call => call.receiptConfirmed).every(call => (call.reviewWireVersion ?? 1) === record.reviewWireVersion));
  need(codingCalls.length > 0 && codingCalls.every((call, index) => call.attempt === index + 1));
  need(new Set(record.versions.map(version => version.commit)).size === record.versions.length && new Set(record.versions.map(version => version.attempt)).size === record.versions.length);
  for (const call of record.modelCalls.filter(item => item.role === 'review')) {
    const version = record.versions.filter(item => item.commit === call.candidateCommit);
    need(version.length === 1 && call.inputSourceHash === version[0].sourceHash);
  }
  const workspace = path.resolve(record.workspace); inside(root, workspace); await parents(workspace); need(samePath(path.dirname(workspace), path.dirname(filename)));
  need((await lstat(path.join(workspace, '.git'))).isDirectory() && !((await lstat(path.join(workspace, '.git'))).isSymbolicLink()));
  const commands = [];
  const git = async args => {
    need(!signal.aborted && Date.now() < deadline);
    let result; state.processes++;
    try { result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspace, signal, timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), maxOutputBytes: 2 * 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    }); } finally { state.processes--; }
    commands.push({ args, exitCode: result.exitCode, terminationConfirmed: result.terminationConfirmed });
    if (result.terminationConfirmed !== true) throw Object.assign(new Error('来源核对进程停止尚未确认。'), { reconciliationRequired: true, result, workspace });
    need(!signal.aborted && Date.now() < deadline);
    need(result.exitCode === 0 && result.terminationConfirmed === true && !result.stopReason && !result.truncated); return result.stdout;
  };
  need(samePath((await git(['rev-parse', '--show-toplevel'])).trim(), workspace));
  need((await git(['rev-parse', 'HEAD'])).trim() === record.candidateCommit && !(await git(['status', '--porcelain', '--untracked-files=all'])).trim());
  need((await verifyWebShell({ workspace })).hash === record.shellHash);
  async function filesAt(commit) {
    need(COMMIT.test(commit));
    const entries = (await git(['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean), files = [];
    for (const entry of entries) {
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/su); need(match);
      let allowed = true; try { validateProjectFiles([{ path: match[3], content: '' }]); } catch { allowed = false; }
      if (!allowed) continue;
      const content = await git(['cat-file', 'blob', `${commit}:${match[3]}`]), data = Buffer.from(content);
      need(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') === match[2]); files.push({ path: match[3], content });
    }
    return validateProjectFiles(files);
  }
  let previous = await filesAt(record.baseCommit), parentSource;
  if (record.evolutionSource !== undefined) {
    const evolution = evolutionBinding(record);
    const parent = await inspectSource({ rootDir: root, reportPath: evolution.source.sourceReportPath, binding: evolution.originBinding, writablePaths, signal }, visited, deadline, state);
    parentSource = sources.get(parent);
    for (const key of ['sourceExecutionId', 'sourceRunId', 'sourceCommit', 'sourceHash', 'sourceWorkspace', 'sourceReportPath', 'sourceReportHash', 'projectId', 'specRevision', 'planRevision']) need(evolution.source[key] === parentSource.provenance[key]);
    need(canonicalJSON(evolution.source.sourceModelReceiptHashes) === canonicalJSON(parentSource.provenance.sourceModelReceiptHashes) && sourceHash(previous) === parentSource.provenance.sourceHash);
    need(canonicalJSON(validateProjectFiles(evolution.retainedPaths.map(path => ({ path, content: '' }))).map(file => file.path)) === canonicalJSON(parentSource.files.map(file => file.path)));
    const history = sourceHistory(evolution.source, state); need(history.historyHash === evolution.historyHash && canonicalJSON(history) === canonicalJSON(record.evolutionHistory));
  } else if (record.initialSource?.sourceReportPath) {
    const parent = await inspectSource({ rootDir: root, reportPath: record.initialSource.sourceReportPath,
      binding: { projectId: record.projectId, specRevision: record.specRevision, planRevision: record.planRevision }, writablePaths, signal }, visited, deadline, state);
    parentSource = sources.get(parent); need(sourceHash(previous) === parentSource.provenance.sourceHash);
    for (const key of ['sourceReportHash', 'sourceCommit', 'sourceHash']) need(record.initialSource[key] === parentSource.provenance[key]);
    for (const key of ['sourceExecutionId', 'sourceRunId', 'projectId', 'specRevision', 'planRevision']) if (record.initialSource[key] !== undefined) need(record.initialSource[key] === parentSource.provenance[key]);
  } else need(previous.length === 0);
  const receiptHashes = [...(parentSource?.provenance.sourceModelReceiptHashes ?? [])], findings = new Map((parentSource?.previousIssues ?? []).map(issue => [issue.id, Object.fromEntries(Object.entries(issue).filter(([key]) => key !== 'status'))]));
  const receiptCache = new Map(); let reviewPreviousIssues = structuredClone(parentSource?.previousIssues ?? []);
  // A repair may read receipts produced before duplicate findings were rejected.
  // Replaying these can only retain blocking obligations, never grant delivery.
  need(record.reviewHistoryVersion === undefined || record.reviewHistoryVersion === 2);
  const allowHistoricalDuplicates = record.reviewHistoryVersion === undefined && record.reviewPolicyHash !== projectReviewPolicy.hash;
  async function readReceipt(call, normalStop = true) {
    need(call && HASH.test(call.receiptHash ?? '') && call.receiptConfirmed === true && (!normalStop || call.finishReason === 'stop'));
    const key = `${call.role}:${call.attempt}`; if (receiptCache.has(key)) return receiptCache.get(key);
    const receiptFile = path.join(path.dirname(filename), `model-${call.role}-${call.attempt}.json`); need(samePath(receiptFile, call.receiptPath));
    const raw = await regularFile(receiptFile, 2 * 1024 * 1024); need(digest(raw) === call.receiptHash); inspectedFile(state, receiptFile, call.receiptHash); receiptHashes.push(call.receiptHash);
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); need(receipt.finishReason === call.finishReason && receipt.model === call.model);
    if (call.role === 'review') need(receipt.reviewWireVersion === undefined && call.reviewWireVersion === undefined || receipt.reviewWireVersion === 2 && call.reviewWireVersion === 2);
    // Older local fixtures/records may omit per-call usage. Never fill that
    // absence with zero; new rejection records must carry the exact receipt usage.
    if (Object.hasOwn(call, 'usage') || call.proposalRejection !== undefined) need(call.usage && digest(normalizedUsage(receipt.usage)) === digest(normalizedUsage(call.usage)));
    receiptCache.set(key, receipt); return receipt;
  }
  const receiptNames = new Set((await readdir(path.dirname(filename))).filter(name => /^model-(?:coding|review)-.+\.json$/u.test(name)));
  const expectedNames = new Set(record.modelCalls.map(call => `model-${call.role}-${call.attempt}.json`));
  need([...receiptNames].every(name => expectedNames.has(name)));
  for (const call of record.modelCalls) {
    if (receiptNames.has(`model-${call.role}-${call.attempt}.json`)) { need(call.dispatched !== false); await readReceipt(call, false); }
    // Missing private evidence is compatible only with the exact terminal
    // native pre-dispatch shape, never a completed or unknown request.
    else need(notDispatched(call));
  }
  function retain(issue) {
    need(typeof issue.id === 'string' && issue.id && typeof issue.message === 'string');
    const core = Object.fromEntries(['id', 'severity', 'file', 'line', 'message', 'evidence', 'originCommit'].filter(key => issue[key] !== undefined).map(key => [key, issue[key]]));
    if (findings.has(issue.id)) need(digest(core) === digest(findings.get(issue.id))); else findings.set(issue.id, core);
  }
  let previousCommit = record.baseCommit;
  const versionsByAttempt = new Map(record.versions.map(version => [version.attempt, version]));
  for (const call of codingCalls) {
    need(call.inputSourceHash === sourceHash(previous));
    const version = versionsByAttempt.get(call.attempt);
    if (!version) {
      if (call.dispatched === false) { need(!call.proposalRejection); continue; }
      const receipt = await readReceipt(call, false);
      if (call.proposalRejection !== undefined) {
        const rejection = call.proposalRejection;
        need(rejection && Object.keys(rejection).length === 9 && ['version', 'stage', 'reason', 'callId', 'baseCommit', 'inputSourceHash', 'receiptHash', 'applied', 'terminationConfirmed'].every(key => Object.hasOwn(rejection, key)));
        need(rejection.version === 1 && rejection.stage === 'before_apply' && rejection.applied === false && rejection.terminationConfirmed === true
          && call.kind === 'model' && call.terminationConfirmed === true && call.receiptConfirmed === true && call.finishReason === 'stop'
          && rejection.callId === call.id && typeof call.id === 'string' && rejection.baseCommit === previousCommit
          && rejection.inputSourceHash === call.inputSourceHash && rejection.receiptHash === call.receiptHash && rejection.reason === call.errorCode);
        let files;
        try { files = decodeProjectCodeResponse(receipt.content, { literalFiles: call.codeWireVersion === 2 }); } catch { /* Invalid proposal is retained, never applied. */ }
        if (rejection.reason === 'proposal_invalid') need(!files);
        else { need(rejection.reason === 'proposal_outside_scope' && files && Array.isArray(record.writablePaths));
          const writable = new Set(validateProjectFiles(record.writablePaths.map(path => ({ path, content: '' }))).map(file => file.path)); need(files.some(file => !writable.has(file.path))); }
      }
      // Legacy complete unapplied calls remain paid history. They never become
      // versions, and their returned files are deliberately not applied here.
      continue;
    }
    need(call.proposalRejection === undefined && call.dispatched !== false);
    need(COMMIT.test(version.commit ?? '') && HASH.test(version.sourceHash ?? '') && Number.isInteger(version.attempt));
    const parents = (await git(['rev-list', '--parents', '-n', '1', version.commit])).trim().split(' ');
    need(parents.length === 2 && parents[0] === version.commit && parents[1] === previousCommit); previousCommit = version.commit;
    const receipt = await readReceipt(call);
    const updates = decodeProjectCodeResponse(receipt.content, { literalFiles: call.codeWireVersion === 2 }), merged = new Map(previous.map(file => [file.path, file.content]));
    if (record.taskExecution) { const writable = new Set(validateProjectFiles(record.writablePaths.map(path => ({ path, content: '' }))).map(file => file.path)); need(updates.every(file => writable.has(file.path))); }
    for (const file of updates) merged.set(file.path, file.content);
    const expected = validateProjectFiles([...merged].map(([path, content]) => ({ path, content }))), actual = await filesAt(version.commit);
    need(sourceHash(actual) === version.sourceHash && sourceHash(expected) === version.sourceHash); previous = actual;
    const reviews = reviewCalls.filter(item => item.candidateCommit === version.commit);
    const reviewContext = { files: actual, previousIssues: reviewPreviousIssues, allowHistoricalDuplicates };
    if (reviews.some(call => call.reviewWireVersion === 2)) {
      let reviewed, primary;
      for (const [index, reviewCall] of reviews.entries()) {
        need(reviewCall.reviewWireVersion === 2 && reviewCall.inputSourceHash === version.sourceHash);
        if (!reviewCall.receiptConfirmed || reviewCall.finishReason !== 'stop') { need(index === reviews.length - 1 && version.acceptance?.review?.status !== 'completed'); continue; }
        const saved = await readReceipt(reviewCall); let invalid;
        try { reviewed = decodeProjectReviewResponseV2(saved.content, reviewContext); }
        catch (error) { invalid = getProjectReviewResponseFeedback(error); need(invalid); }
        if (invalid) {
          reviewed = undefined;
          if (index < reviews.length - 1 || reviewCall.reviewRejection !== undefined) {
            const rejection = reviewCall.reviewRejection;
            need(reviewCall.kind === 'model' && reviewCall.terminationConfirmed === true && reviewCall.requestState === 'completed' && reviewCall.errorCode === 'proposal_invalid'
              && rejection?.version === 1 && rejection.code === 'invalid_model_response' && rejection.callId === reviewCall.id && rejection.receiptHash === reviewCall.receiptHash
              && rejection.candidateCommit === version.commit && rejection.inputSourceHash === version.sourceHash
              && digest(Object.fromEntries(['version', 'reason', 'field', 'position'].filter(key => rejection[key] !== undefined).map(key => [key, rejection[key]]))) === digest(invalid));
            if (index < reviews.length - 1) need(digest(reviews[index + 1].responseFeedback) === digest(invalid));
          }
          need(version.acceptance?.review?.status !== 'completed' || index < reviews.length - 1);
          continue;
        }
        // A genuine opinion, including blocking, cannot be relabeled a format
        // failure to permit another draw of Review against unchanged code.
        need(index === reviews.length - 1 && reviewCall.reviewRejection === undefined && reviewCall.errorCode === null); primary = reviewCall;
      }
      if (version.acceptance?.review?.status === 'completed') {
        need(reviewed && primary && primary.id === version.acceptance.review.primaryCallId && version.acceptance.review.evidenceOrigin === projectReviewEvidenceOrigin
          && digest(validateProjectReviewResponse(version.acceptance.review, reviewContext)) === digest(validateProjectReviewResponse(reviewed, reviewContext)));
      }
      if (reviewed) {
        const { issues } = reconcilePlannedReviewIssues({ result: reviewed, previousIssues: reviewPreviousIssues, commit: version.commit });
        for (const issue of issues) if (issue.severity === 'blocking') retain(issue);
        reviewPreviousIssues = issues.filter(issue => issue.severity === 'blocking'
          && (record.reviewHistoryVersion === 2 || record.evolutionSource || issue.status === 'open'));
      }
    } else {
    need(reviews.length <= 1);
    if (reviews.length && reviews[0].receiptConfirmed === true && reviews[0].finishReason === 'stop') {
      const reviewCall = reviews[0]; need(reviewCall.inputSourceHash === version.sourceHash);
      const saved = await readReceipt(reviewCall); let reviewed;
      try { const rawReview = JSON.parse(saved.content); reviewed = validateProjectReviewResponse({ ...rawReview, resolutions: [] }, { files: actual, allowHistoricalDuplicates }); }
      catch { need(version.acceptance?.review?.status !== 'completed'); }
      if (reviewed) {
        // The original private opinion, not editable report metadata, carries
        // every known blocking obligation into a new coding attempt.
        const { issues } = reconcilePlannedReviewIssues({ result: reviewed, previousIssues: [], commit: version.commit });
        for (const issue of issues) if (issue.severity === 'blocking') retain(issue);
        if (version.acceptance?.review?.status === 'completed') need(digest(reviewed.issues) === digest(version.acceptance.review.issues));
      }
    }
    if (version.acceptance?.review?.status === 'completed') need(reviews.length === 1 && reviews[0].receiptConfirmed === true && reviews[0].finishReason === 'stop');
    }
    for (const issue of version.acceptance?.issues ?? []) if (issue.severity === 'blocking') retain(issue);
  }
  need(record.versions.every(version => codingCalls.some(call => call.attempt === version.attempt)));
  const last = record.versions.at(-1); need(last.commit === record.candidateCommit && findings.size <= 20 && sourceHash(previous) === last.sourceHash);
  const files = await readProjectFiles(workspace); need(sourceHash(files) === last.sourceHash);
  if (record.evolutionSource) need(record.evolutionSource.retainedPaths.every(path => files.some(file => file.path === path)));
  const allowed = new Set(validateProjectFiles(writablePaths.map(path => ({ path, content: '' }))).map(file => file.path)); need(files.every(file => allowed.has(file.path)));
  need(digest(await regularFile(filename, 32 * 1024 * 1024)) === reportHash && (await git(['rev-parse', 'HEAD'])).trim() === record.candidateCommit);
  for (const file of state.files.values()) need(digest(await regularFile(file.filename, 32 * 1024 * 1024)) === file.hash);
  const provenance = { sourceExecutionId: record.id, sourceRunId: record.runId, sourceCommit: record.candidateCommit, sourceHash: last.sourceHash, sourceWorkspace: workspace,
    sourceReportPath: filename, sourceReportHash: reportHash, sourceModelReceiptHashes: receiptHashes, sourceModelCalls: record.totalModelCalls,
    projectId: record.projectId, specRevision: record.specRevision, planRevision: record.planRevision,
    ...(record.evolutionSource ? { evolution: { seedHash: record.evolutionSeedHash, originBinding: record.evolutionSource.originBinding, targetBinding: record.evolutionSource.targetBinding } } : {}),
    inspectionHash: digest({ reportHash, sourceHash: last.sourceHash, receiptHashes, commands }) };
  const handle = Object.freeze({ id: randomUUID(), kind: 'owned_planned_source' });
  need(!signal.aborted && Date.now() < deadline);
  const previousFailures = Object.fromEntries([['self', last.selfCheck], ['http', last.acceptance?.test], ['browser', last.acceptance?.browser]].map(([role, report]) => [role, (report?.checks ?? []).filter(check => check.passed !== true)]));
  sources.set(handle, freeze({ files, provenance, previousFailures, previousIssues: [...findings.values()].map(issue => ({ ...issue, status: 'open' })) })); return handle;
  } finally { visited.delete(visitKey); }
}

/** Merge JSON records establish reusable code provenance only, never accepted software. */
async function inspectMergeSource({ root, filename, record, reportHash, binding, writablePaths, signal }, visited, deadline, state) {
  const current = () => need(!signal.aborted && Date.now() < deadline);
  current();
  need(record.version === 1 && ['id', 'projectId', 'runId'].every(key => /^[A-Za-z0-9_-]{1,128}$/u.test(record[key] ?? ''))
    && ['manifestHash', 'taskSetHash', 'sourceHash', 'shellHash', 'specRevision', 'planRevision'].every(key => HASH.test(record[key] ?? ''))
    && COMMIT.test(record.candidateCommit ?? '') && Array.isArray(record.sources) && record.sources.length >= 1 && record.sources.length <= 2);
  for (const key of ['projectId', 'specRevision', 'planRevision']) need(typeof binding?.[key] === 'string' && record[key] === binding[key]);
  const allowed = new Set(validateProjectFiles(writablePaths.map(path => ({ path, content: '' }))).map(file => file.path));
  const reportFiles = new Map([[filename, reportHash]]), commands = [], receiptHashes = new Set(), findings = new Map();
  const rememberIssues = source => {
    for (const issue of source.previousIssues ?? []) {
      if (findings.has(issue.id)) need(digest(findings.get(issue.id)) === digest(issue)); else findings.set(issue.id, issue);
    }
    need(findings.size <= 20);
    for (const hash of source.provenance.sourceModelReceiptHashes ?? []) { need(HASH.test(hash)); receiptHashes.add(hash); }
  };
  async function workspaceAt(raw, report) {
    need(typeof raw === 'string' && path.isAbsolute(raw)); const workspace = path.resolve(raw); inside(root, workspace); await parents(workspace);
    if (report) need(samePath(path.dirname(workspace), path.dirname(report)));
    const gitInfo = await lstat(path.join(workspace, '.git')); need(gitInfo.isDirectory() && !gitInfo.isSymbolicLink()); return workspace;
  }
  async function git(workspace, args) {
    current(); let result; state.processes++;
    try { result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspace, signal, timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), maxOutputBytes: 2 * 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    }); } finally { state.processes--; }
    commands.push({ workspace, args, exitCode: result.exitCode, terminationConfirmed: result.terminationConfirmed });
    if (result.terminationConfirmed !== true) throw Object.assign(new Error('来源核对进程停止尚未确认。'), { reconciliationRequired: true, result, workspace });
    current(); need(result.exitCode === 0 && !result.stopReason && !result.truncated); return result.stdout;
  }
  const shell = await getWebShellFiles(), shellBlobs = new Map(shell.map(file => {
    const data = Buffer.from(file.content); return [file.path, createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')];
  }));
  async function filesAt(workspace, commit) {
    need(COMMIT.test(commit)); const entries = (await git(workspace, ['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean), files = [], seenShell = new Set();
    for (const entry of entries) {
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/su); need(match);
      if (shellBlobs.has(match[3])) { need(match[2] === shellBlobs.get(match[3])); seenShell.add(match[3]); continue; }
      validateProjectFiles([{ path: match[3], content: '' }]);
      const content = await git(workspace, ['cat-file', 'blob', `${commit}:${match[3]}`]), data = Buffer.from(content);
      need(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') === match[2]); files.push({ path: match[3], content });
    }
    need(seenShell.size === shellBlobs.size); return validateProjectFiles(files);
  }
  async function sourceAt(provenance) {
    need(provenance && typeof provenance.sourceReportPath === 'string' && HASH.test(provenance.sourceReportHash ?? ''));
    const handle = await inspectSource({ rootDir: root, reportPath: provenance.sourceReportPath, binding, writablePaths, signal }, visited, deadline, state), source = sources.get(handle);
    for (const key of ['sourceExecutionId', 'sourceRunId', 'sourceCommit', 'sourceHash', 'sourceWorkspace', 'sourceReportHash', 'projectId', 'specRevision', 'planRevision']) need(provenance[key] === source.provenance[key]);
    need(digest(provenance.sourceModelReceiptHashes) === digest(source.provenance.sourceModelReceiptHashes));
    const report = path.resolve(provenance.sourceReportPath); reportFiles.set(report, provenance.sourceReportHash);
    rememberIssues(source); return source;
  }
  let base;
  if (record.base?.sourceReportPath) base = await sourceAt(record.base);
  else {
    const provenance = record.base; need(provenance && ['projectId', 'runId', 'specRevision', 'planRevision'].every(key => provenance[key] === record[key])
      && COMMIT.test(provenance.sourceCommit ?? '') && provenance.sourceHash === sourceHash([]) && provenance.shellHash === record.shellHash);
    const workspace = await workspaceAt(provenance.sourceWorkspace);
    need(samePath((await git(workspace, ['rev-parse', '--show-toplevel'])).trim(), workspace)
      && (await git(workspace, ['rev-parse', 'HEAD'])).trim() === provenance.sourceCommit
      && !(await git(workspace, ['status', '--porcelain', '--untracked-files=all'])).trim()
      && (await verifyWebShell({ workspace })).hash === record.shellHash
      && (await filesAt(workspace, provenance.sourceCommit)).length === 0 && (await readProjectFiles(workspace)).length === 0);
    base = { files: [], provenance, previousIssues: [] };
  }
  need(COMMIT.test(base.provenance.sourceCommit) && HASH.test(base.provenance.sourceHash));
  const expected = new Map(base.files.map(file => [file.path, file.content])), usedPaths = new Set(), taskIds = new Set(), candidates = [];
  for (const item of record.sources) {
    need(item && /^[A-Za-z0-9_-]{1,128}$/u.test(item.taskId ?? '') && !taskIds.has(item.taskId)); taskIds.add(item.taskId);
    const writable = validateProjectFiles(item.writablePaths.map(path => ({ path, content: '' }))).map(file => file.path);
    need(writable.length > 0 && writable.every(path => allowed.has(path) && !usedPaths.has(path))); writable.forEach(path => usedPaths.add(path));
    const source = await sourceAt(item.provenance), sourceBytes = await regularFile(path.resolve(item.provenance.sourceReportPath), 32 * 1024 * 1024);
    const sourceRecord = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes));
    need(digest(sourceBytes) === item.provenance.sourceReportHash
      && sourceRecord.profileId === 'planned-web-v1' && sourceRecord.taskId === item.taskId && sourceRecord.runId === record.runId
      && sourceRecord.baseCommit === base.provenance.sourceCommit && sourceRecord.taskExecution?.taskId === item.taskId && sourceRecord.taskExecution.integration === false
      && sourceRecord.taskExecution.taskSetHash === record.taskSetHash && HASH.test(sourceRecord.taskExecution.taskDefinitionHash ?? '')
      && digest([...sourceRecord.writablePaths].sort()) === digest([...writable].sort()));
    if (record.base.sourceReportPath) need(sourceRecord.initialSource?.sourceReportHash === record.base.sourceReportHash && sourceRecord.initialSource.sourceCommit === record.base.sourceCommit);
    else need(sourceRecord.taskSeed?.sourceCommit === record.base.sourceCommit && sourceRecord.taskSeed.sourceHash === sourceHash([]));
    const actual = new Map(source.files.map(file => [file.path, file.content]));
    for (const prior of base.files) need(actual.has(prior.path) && (writable.includes(prior.path) || actual.get(prior.path) === prior.content));
    for (const file of source.files) if (file.content !== base.files.find(prior => prior.path === file.path)?.content) { need(writable.includes(file.path)); expected.set(file.path, file.content); }
    candidates.push({ source, expected: validateProjectFiles([...expected].map(([path, content]) => ({ path, content }))) });
  }
  const workspace = await workspaceAt(record.workspace, filename);
  need(samePath((await git(workspace, ['rev-parse', '--show-toplevel'])).trim(), workspace)
    && (await git(workspace, ['rev-parse', 'HEAD'])).trim() === record.candidateCommit && !(await git(workspace, ['status', '--porcelain', '--untracked-files=all'])).trim()
    && (await verifyWebShell({ workspace })).hash === record.shellHash && sourceHash(await filesAt(workspace, base.provenance.sourceCommit)) === base.provenance.sourceHash);
  // Walk the actual first-parent merge chain backwards; editable command logs do not prove ancestry.
  let cursor = record.candidateCommit;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index], commit = candidate.source.provenance.sourceCommit;
    const parents = (await git(workspace, ['rev-list', '--parents', '-n', '1', cursor])).trim().split(' ');
    need(parents.length === 3 && parents[0] === cursor && parents[2] === commit);
    await git(workspace, ['merge-base', '--is-ancestor', base.provenance.sourceCommit, commit]);
    need(sourceHash(await filesAt(workspace, commit)) === candidate.source.provenance.sourceHash && sourceHash(await filesAt(workspace, cursor)) === sourceHash(candidate.expected));
    cursor = parents[1];
  }
  need(cursor === base.provenance.sourceCommit);
  const files = await readProjectFiles(workspace); need(sourceHash(files) === record.sourceHash && sourceHash(files) === sourceHash([...expected].map(([path, content]) => ({ path, content }))) && files.every(file => allowed.has(file.path)));
  for (const [report, hash] of reportFiles) need(digest(await regularFile(report, 32 * 1024 * 1024)) === hash);
  for (const file of state.files.values()) need(digest(await regularFile(file.filename, 32 * 1024 * 1024)) === file.hash);
  need((await git(workspace, ['rev-parse', 'HEAD'])).trim() === record.candidateCommit && !(await git(workspace, ['status', '--porcelain', '--untracked-files=all'])).trim()); current();
  const provenance = { sourceExecutionId: record.id, sourceRunId: record.runId, sourceCommit: record.candidateCommit, sourceHash: record.sourceHash, sourceWorkspace: workspace,
    sourceReportPath: filename, sourceReportHash: reportHash, sourceKind: 'task_merge', sourceModelReceiptHashes: [...receiptHashes],
    projectId: record.projectId, specRevision: record.specRevision, planRevision: record.planRevision,
    inspectionHash: digest({ reportHash, sourceHash: record.sourceHash, receiptHashes: [...receiptHashes], commands }) };
  const handle = Object.freeze({ id: randomUUID(), kind: 'owned_planned_source' }); current();
  sources.set(handle, freeze({ files, provenance, previousFailures: {}, previousIssues: [...findings.values()] })); return handle;
}

export function assertPlannedSource(handle, binding, writablePaths) {
  const source = sources.get(handle); need(source);
  for (const key of ['projectId', 'specRevision', 'planRevision']) need(source.provenance[key] === binding[key]);
  const allowed = new Set(writablePaths); need(source.files.every(file => allowed.has(file.path))); return source;
}
