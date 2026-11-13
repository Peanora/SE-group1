import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { minimalEnv, runProcess } from './managed-process.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { getWebShellFiles, installWebShell, verifyWebShell } from './web-delivery.mjs';
import { createWindowsSandbox } from './windows-sandbox.mjs';
import { webProfile } from './web-profile.mjs';
import { databaseObserverHash, runWebTests, webManifest } from './web-tests.mjs';
import { browserManifest, runWebBrowserTests } from './web-browser-tests.mjs';
import { projectReviewPolicy, validateProjectReviewResponse } from './project-review-model.mjs';
import { isWebTaskAccepted } from './web-executor.mjs';

const HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const FINISH = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'unknown']);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceHash = files => hash(validateProjectFiles(files));
const need = (value, message) => { if (!value) throw new Error(message); };
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b));
const aborted = () => Object.assign(new Error('复验已停止。'), { name: 'AbortError' });
const stopCheck = signal => { if (signal?.aborted) throw aborted(); };
const currentSpec = () => hash(webProfile.task);
const currentPlan = () => hash({ profileId: webProfile.id, web: webManifest.hash, browser: browserManifest.hash });
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function contained(root, target) { const relative = path.relative(root, target); need(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), '路径不属于受控执行根目录。'); }
async function directoryChain(directory) {
  need(typeof directory === 'string' && path.isAbsolute(directory) && !directory.includes('\0'), '必须提供可信绝对目录。');
  let current = path.parse(directory).root;
  for (const segment of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const info = await lstat(current);
    need(info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(current), current), '目录及其父链不可使用链接。');
  }
  need(path.resolve(directory) !== path.parse(directory).root, '文件系统根目录不能作为执行根。'); return path.resolve(directory);
}
async function readOwned(filename, maximum) {
  await directoryChain(path.dirname(filename));
  const before = await lstat(filename, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= maximum, '受控记录必须是有界、无链接的普通文件。');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }); need(opened.dev === before.dev && opened.ino === before.ino, '记录在打开时变化。');
    const chunks = []; let bytes = 0;
    for (;;) { const buffer = Buffer.alloc(16384), { bytesRead } = await handle.read(buffer); if (!bytesRead) break; bytes += bytesRead; need(bytes <= maximum, '记录读取超限。'); chunks.push(buffer.subarray(0, bytesRead)); }
    const after = await lstat(filename, { bigint: true });
    need(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs, '记录在读取时变化。');
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
async function safeTree(root, signal) {
  let entries = 0, bytes = 0;
  async function visit(directory) {
    stopCheck(signal);
    for (const name of await readdir(directory)) {
      need(++entries <= 10000, '来源工作区文件数量超限。'); const target = path.join(directory, name), info = await lstat(target);
      need(!info.isSymbolicLink(), '来源工作区包含链接。');
      if (info.isDirectory()) await visit(target);
      else { need(info.isFile() && info.nlink === 1, '来源工作区包含硬链接或非普通文件。'); bytes += info.size; need(bytes <= 64 * 1024 * 1024, '来源工作区总大小超限。'); }
    }
  }
  await visit(root);
}
async function gitRead(workspace, args, signal, log = []) {
  stopCheck(signal);
  const result = await runProcess('git', ['--no-optional-locks', '-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd: workspace, signal, timeoutMs: 15000, maxOutputBytes: 2 * 1024 * 1024,
    env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  log.push({ args, ...result });
  if (!result.terminationConfirmed) throw Object.assign(new Error('只读Git检查进程停止尚未确认。'), { reconciliationRequired: true, result });
  stopCheck(signal); need(result.exitCode === 0 && !result.stopReason && !result.truncated, '只读Git版本检查失败。'); return result.stdout;
}
function proofStopped(report) {
  need(!['preparing', 'generating', 'validating', 'awaiting_acceptance', 'checking_environment', 'reconciliation_required'].includes(report.status) && typeof report.finishedAt === 'string', '来源执行尚未结束或停止待协调。');
  const latest = report.versions.at(-1), outputs = [latest.selfCheck, latest.acceptance?.test, latest.acceptance?.browser].filter(Boolean);
  need(latest.selfCheck?.terminationConfirmed === true && latest.selfCheck.processes?.some(item => item.pid && item.terminationConfirmed === true), '来源缺少真实运行停止证据。');
  for (const output of outputs) {
    need(output.status !== 'reconciliation_required' && output.terminationConfirmed === true && output.browser?.closed !== false, '来源存在未确认停止的检查。');
    for (const item of [...(output.processes ?? []), ...(output.databaseCommands ?? []), ...(output.databasePreflights ?? [])]) need(item.terminationConfirmed === true, '来源检查进程仍待核对。');
  }
  need(!report.gitCommands?.some(item => item.terminationConfirmed !== true) && report.environmentFailure?.result?.terminationConfirmed !== false, '来源预检或Git进程停止未知。');
}
function receiptData(raw, maximum) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).sort().join(',') === 'content,finishReason,model,usage', '模型回执必须是固定四字段。');
  need(typeof raw.model === 'string' && raw.model.trim() && raw.model.length <= 200 && FINISH.has(raw.finishReason) && typeof raw.content === 'string' && Buffer.byteLength(raw.content) <= maximum, '模型回执枚举或大小无效。');
  need(raw.usage && Object.keys(raw.usage).sort().join(',') === 'inputTokens,outputTokens' && Object.values(raw.usage).every(value => value === null || tokens(value) !== null), '模型回执用量无效。');
  return raw;
}
async function loadSource({ executionRoot, sourceReportPath, signal, log = [] }) {
  const root = await directoryChain(executionRoot);
  need(typeof sourceReportPath === 'string' && path.isAbsolute(sourceReportPath) && path.basename(sourceReportPath) === 'execution.json', '必须提供受控历史execution.json的绝对路径。');
  const reportPath = path.resolve(sourceReportPath); contained(root, reportPath); const directory = path.dirname(reportPath);
  need(path.basename(directory).startsWith('web-execution-'), '首版仅支持原始模型执行记录，不递归复验链或ZIP。');
  const raw = await readOwned(reportPath, 16 * 1024 * 1024), source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); stopCheck(signal);
  need(source && ID.test(source.id ?? '') && ['projectId', 'runId', 'taskId'].every(key => ID.test(source[key] ?? '')) && source.profileId === webProfile.id && source.taskId === webProfile.id && source.providerKind === 'model' && !source.provenance?.sourceExecutionId, '来源不是受控固定档案的原始模型执行。');
  need(source.specRevision === currentSpec(), '原规格与当前固定档案冲突，不能复用代码复验。');
  need(Number.isInteger(source.calls) && source.calls >= 1 && source.calls <= 5 && Array.isArray(source.modelCalls) && source.modelCalls.length <= 10 && Array.isArray(source.versions) && source.versions.length > 0 && source.versions.length <= 5, '来源模型调用或候选历史无效。');
  const workspace = path.join(directory, 'workspace'); need(samePath(source.workspace ?? '', workspace) && samePath(source.reportPath ?? '', reportPath), '来源报告或工作区路径不属于记录目录。');
  contained(root, workspace); await directoryChain(workspace); await safeTree(workspace, signal);
  const latest = source.versions.at(-1); need(COMMIT.test(latest.commit ?? '') && latest.commit === source.candidateCommit && HASH.test(latest.sourceHash ?? '') && Number.isInteger(latest.attempt), '来源候选版本不完整。'); proofStopped(source);
  const shell = await verifyWebShell({ workspace }); need(shell.hash === source.shellHash, '当前保护外壳与原提交不一致，不能冒充原候选。');
  const files = await readProjectFiles(workspace); need(sourceHash(files) === latest.sourceHash, '来源源码与版本历史不一致。');
  need(samePath((await gitRead(workspace, ['rev-parse', '--show-toplevel'], signal, log)).trim(), workspace), '来源不是独立Git工作区。');
  need((await gitRead(workspace, ['rev-parse', 'HEAD'], signal, log)).trim() === latest.commit && !(await gitRead(workspace, ['status', '--porcelain', '--untracked-files=all'], signal, log)).trim(), '来源HEAD或干净状态已变化。');
  const expected = [...files, ...await getWebShellFiles()];
  const tree = (await gitRead(workspace, ['ls-tree', '-rz', 'HEAD'], signal, log)).split('\0').filter(Boolean);
  need(tree.length === expected.length, '原提交包含未知文件或缺少源码/外壳。');
  const objects = new Map();
  for (const line of tree) { const match = line.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u); need(match && !objects.has(match[3]), '原Git树包含非普通文件或重复路径。'); objects.set(match[3], match[2]); }
  for (const file of expected) { const bytes = Buffer.from(file.content); const object = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); need(objects.get(file.path) === object, '允许源码或保护外壳与原Git提交内容不符。'); }
  const coding = source.modelCalls.filter(call => call.role === 'coding' && call.kind === 'model'); need(coding.length === source.calls, '来源编码请求数量不一致。');
  const receipts = [];
  for (const call of coding) {
    need(Number.isInteger(call.attempt) && call.attempt >= 1 && HASH.test(call.receiptHash ?? ''), '来源缺少真实编码回执哈希。');
    const receiptPath = path.join(directory, `model-coding-${call.attempt}.json`); need(samePath(call.receiptPath ?? '', receiptPath), '来源编码回执路径不属于受控记录。');
    const bytes = await readOwned(receiptPath, 2 * 1024 * 1024); need(hash(bytes) === call.receiptHash, '来源编码回执哈希不一致。');
    const receipt = receiptData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), 512 * 1024);
    need(call.model === receipt.model && JSON.stringify(call.usage) === JSON.stringify(receipt.usage), '来源模型或用量与回执不一致。');
    receipts.push({ attempt: call.attempt, receiptPath, receiptHash: call.receiptHash, model: receipt.model });
    if (call.attempt === latest.attempt) {
      need(receipt.finishReason === 'stop', '候选编码回执未正常结束。'); const proposed = validateProjectFiles(JSON.parse(receipt.content)?.files);
      need(proposed.length > 0 && proposed.every(file => files.some(actual => actual.path === file.path && actual.content === file.content)), '候选源码与对应真实模型文件建议不一致。');
    }
  }
  need(coding.some(call => call.attempt === latest.attempt), '候选没有对应的模型编码回执。');
  const openIssues = latest.acceptance?.openIssues ?? [];
  need(Array.isArray(openIssues) && openIssues.length <= 20 && (openIssues.length === 0 || latest.acceptance.review?.status === 'completed'), '来源阻塞问题历史不完整。');
  const previousIssues = openIssues.map(issue => {
    need(ID.test(issue?.id ?? '') && issue.severity === 'blocking' && issue.status === 'open', '来源阻塞问题编号或状态无效。');
    validateProjectReviewResponse({ summary: '核对历史阻塞问题', issues: [issue], resolutions: [] }, { files }); return { ...issue };
  });
  need(new Set(previousIssues.map(issue => issue.id)).size === previousIssues.length, '来源阻塞问题编号重复。');
  return { source, files, latest, previousIssues, root, workspace, reportHash: hash(raw), summary: { sourceExecutionId: source.id, sourceReport: reportPath, sourceReportHash: hash(raw), sourceWorkspace: workspace, sourceCommit: latest.commit, sourceHash: latest.sourceHash, sourceUsage: structuredClone(source.usage ?? { inputTokens: null, outputTokens: null }), sourceCodingCalls: source.calls, sourceModelCalls: source.totalModelCalls ?? coding.length, codingReceipts: receipts, sourceShellHash: shell.hash }, gitCommands: log };
}

/** Read-only admission of controller-owned history, never a client-supplied raw report. */
export async function inspectWebRecheckSource(options) { const value = await loadSource(options); return { source: structuredClone(value.source), summary: structuredClone(value.summary), files: structuredClone(value.files) }; }
const clean = item => item?.terminationConfirmed === true && item.status === 'stopped' && item.exitCode === 0 && item.stopAcknowledged === true && item.sourceUnchanged === true;
const checksComplete = (result, manifest) => Array.isArray(result?.checks) && result.checks.length === manifest.count && manifest.checks.every(rule => result.checks.filter(item => item.id === rule.id && item.name === rule.name && item.passed === true).length === 1);
function completeHTTP(result, binding) { return result?.status === 'passed' && result.profileId === webProfile.id && result.sourceHash === binding.sourceHash && result.manifestHash === webManifest.hash && result.terminationConfirmed === true && checksComplete(result, webManifest) && result.processes?.length >= 2 && result.processes.every(clean) && Array.isArray(result.databasePreflights) && result.databasePreflights.length === 0 && result.databaseCommands?.length === 2 && result.databaseCommands.every(item => item.kind === 'database_observation' && item.runnerHash === databaseObserverHash && item.sourceHash === binding.sourceHash && item.exitCode === 0 && item.terminationConfirmed === true && item.stopReason === null && item.truncated === false); }
function completeBrowser(result, binding) { return result?.status === 'passed' && result.profileId === webProfile.id && result.sourceHash === binding.sourceHash && result.manifestHash === browserManifest.hash && result.terminationConfirmed === true && checksComplete(result, browserManifest) && result.browser?.closed === true && /^\d+(?:\.\d+){1,3}$/u.test(result.browser.version ?? '') && result.processes?.length >= 3 && result.processes.filter(item => item.kind === 'browser').length === 1 && result.processes.every(item => item.kind === 'browser' ? item.terminationConfirmed === true && item.status === 'stopped' && item.exitCode === 0 : clean(item)); }
const unknownStop = result => result?.status === 'reconciliation_required' || result?.terminationConfirmed === false || result?.browser?.closed === false || result?.failure?.result?.terminationConfirmed === false || [...(result?.processes ?? []), ...(result?.databaseCommands ?? []), ...(result?.databasePreflights ?? [])].some(item => item.terminationConfirmed !== true);
async function cancelable(callback, input, signal) {
  stopCheck(signal); let abort;
  const pending = Promise.resolve().then(() => { stopCheck(signal); return callback(input); });
  const interrupted = new Promise((_, reject) => { abort = () => reject(aborted()); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([pending, interrupted]); } finally { signal.removeEventListener('abort', abort); }
}

/** Rechecks the same source commit. No coding callback, code repair or inherited pass result exists. */
export function startWebRecheck({ executionRoot, sourceReportPath, reviewer, reviewerKind = 'model', executable = process.env.EXECUTION_SANDBOX_EXE, signal, timeoutMs = 180000, maxReviewCalls = 2, onEvent = () => {}, assertCurrent = async () => {} } = {}) {
  need(typeof executionRoot === 'string' && path.isAbsolute(executionRoot) && typeof sourceReportPath === 'string' && path.isAbsolute(sourceReportPath) && typeof reviewer === 'function' && ['model', 'diagnostic'].includes(reviewerKind) && typeof onEvent === 'function' && typeof assertCurrent === 'function' && (signal === undefined || signal instanceof AbortSignal), '复验配置无效。');
  need(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600000 && Number.isInteger(maxReviewCalls) && maxReviewCalls >= 1 && maxReviewCalls <= 2, '复验预算无效。');
  const controller = new AbortController(), cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  const started = Date.now(); let timedOut = false, directory, loaded, saveQueue = Promise.resolve();
  const receiptWrites = new Set();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const record = { id: randomUUID(), attemptId: randomUUID(), kind: 'web_recheck', profileId: webProfile.id, providerKind: 'model', reviewerKind, status: 'preparing', acceptanceStatus: 'not_checked', startedAt: new Date().toISOString(), finishedAt: null,
    budget: { maxCalls: 0, maxReviewCalls, maxModelCalls: maxReviewCalls, timeoutMs }, calls: 0, reviewCalls: 0, totalModelCalls: 0, modelCalls: [], usage: { inputTokens: null, outputTokens: null }, versions: [], events: [], gitCommands: [], formatFailures: [], error: null, candidateCommit: null,
    validationManifest: { hash: webManifest.hash, count: webManifest.count, checks: webManifest.checks, databaseObserverHash }, browserManifest: { hash: browserManifest.hash, count: browserManifest.count, checks: browserManifest.checks }, reviewPolicyHash: projectReviewPolicy.hash };
  const event = message => { const item = { sequence: record.events.length + 1, time: new Date().toISOString(), status: record.status, message }; record.events.push(item); try { onEvent({ ...item }); } catch {} };
  const save = () => { if (!directory) return Promise.resolve(); const contents = JSON.stringify(record, null, 2); const next = saveQueue.catch(() => {}).then(async () => { const target = path.join(directory, 'execution.json'), temporary = `${target}.${randomUUID()}.tmp`; await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, target); }); saveQueue = next; return next; };
  const ensureRunning = () => {
    if (record.gitCommands.some(item => item.terminationConfirmed !== true)) record.status = 'reconciliation_required';
    stopCheck(controller.signal); need(record.status !== 'reconciliation_required', '存在未确认停止的进程。');
  };
  const check = async () => {
    ensureRunning();
    const reread = await loadSource({ executionRoot, sourceReportPath, signal: controller.signal, log: record.gitCommands });
    need(reread.reportHash === loaded.reportHash && reread.summary.sourceCommit === record.candidateCommit && reread.summary.sourceHash === record.versions[0].sourceHash, '原候选、回执或历史记录在复验期间改变。');
    need(sourceHash(await readProjectFiles(record.workspace)) === reread.summary.sourceHash && (await verifyWebShell({ workspace: record.workspace })).hash === record.shellHash, '复验快照或保护外壳被改变。');
    ensureRunning(); await assertCurrent(structuredClone(record.versions[0].acceptance?.binding ?? record.currentBinding)); ensureRunning();
  };
  const failedBranch = (previous, candidate, cause, message) => {
    const failure = cause?.result ? { result: structuredClone(cause.result), probeDirectory: cause.probeDirectory ?? null, cleanupError: cause.cleanupError ?? null } : undefined;
    const reconciliation = unknownStop(previous) || cause?.reconciliationRequired || cause?.result?.terminationConfirmed === false;
    if (reconciliation) record.status = 'reconciliation_required';
    return { ...previous, status: reconciliation ? 'reconciliation_required' : 'error', binding: { ...candidate }, ...(failure ? { failure } : {}), error: message };
  };
  const reviewCall = async (previousIssues, correction = false) => {
    await check(); need(record.reviewCalls < maxReviewCalls, 'Review调用预算已耗尽。'); record.reviewCalls++;
    const call = { role: 'review', attempt: record.reviewCalls, kind: reviewerKind === 'model' ? 'model' : 'diagnostic', model: null, usage: { inputTokens: null, outputTokens: null } };
    record.modelCalls.push(call); record.totalModelCalls = record.modelCalls.filter(item => item.kind === 'model').length; record.usage = { inputTokens: null, outputTokens: null }; await save();
    let accepts = true, receiptStarted = false, received;
    const writeReceipt = async value => {
      stopCheck(controller.signal); need(accepts && !receiptStarted, '回执不属于当前Review调用。'); const receipt = receiptData(structuredClone(value), 128 * 1024); receiptStarted = true;
      const receiptPath = path.join(directory, `model-review-${call.attempt}.json`), serialized = JSON.stringify(receipt, null, 2);
      // A receipt admitted before cancellation is settled before the final report.
      // Late callbacks never enter this write, and cannot change a completed record.
      await writeFile(receiptPath, serialized, { flag: 'wx', mode: 0o600 });
      received = receipt; call.model = receipt.model; call.usage = structuredClone(receipt.usage); call.receiptPath = receiptPath; call.receiptHash = hash(serialized); call.finishReason = receipt.finishReason; call.contentBytes = Buffer.byteLength(receipt.content);
      const modelCalls = record.modelCalls.filter(item => item.kind === 'model');
      record.usage = Object.fromEntries(['inputTokens', 'outputTokens'].map(key => { const sum = modelCalls.reduce((total, item) => total + (item.usage[key] ?? 0), 0); return [key, modelCalls.length && modelCalls.every(item => item.usage[key] !== null) && Number.isSafeInteger(sum) ? sum : null]; })); await save();
    };
    const onReceipt = value => {
      const pending = writeReceipt(value); receiptWrites.add(pending);
      pending.then(() => receiptWrites.delete(pending), () => receiptWrites.delete(pending)); return pending;
    };
    let raw, error;
    try { raw = await cancelable(reviewer, { task: JSON.stringify(webProfile.task, null, 2) + (correction ? '\n上次同候选Review的格式或逐字行号证据无效，未接受结论。请重新核对编号行，返回完整summary/issues/resolutions JSON；禁止推测通过。' : ''), files: structuredClone(loaded.files), previousIssues: structuredClone(previousIssues), signal: controller.signal, onReceipt }, controller.signal); }
    catch (cause) { error = cause; }
    finally { accepts = false; }
    stopCheck(controller.signal); await save(); await check();
    let result;
    try {
      if (error) throw error;
      need(reviewerKind !== 'model' || received?.finishReason === 'stop' && call.receiptHash, '真实Review缺少正常完成的私有回执。');
      result = validateProjectReviewResponse(raw, { files: loaded.files, previousIssues });
      if (reviewerKind === 'model') {
        const recorded = validateProjectReviewResponse(JSON.parse(received.content), { files: loaded.files, previousIssues });
        if (JSON.stringify(recorded) !== JSON.stringify(result)) throw Object.assign(new Error('Review返回意见与私有模型回执不一致。'), { code: 'receipt_response_mismatch' });
      }
    } catch (cause) {
      const format = received?.finishReason === 'stop' && !['credential_response', 'receipt_failed', 'receipt_response_mismatch'].includes(cause.code) && (cause.code === 'invalid_model_response' || !error || /Review问题位置|Review问题证据|Review历史问题复验|Review缺少历史/u.test(cause.message ?? ''));
      if (format) record.formatFailures.push({ attempt: call.attempt, code: 'invalid_review_response', receiptHash: call.receiptHash ?? null });
      throw Object.assign(new Error('Review请求、格式、行号证据或回执无效。'), { canCorrect: !!format });
    }
    return { ...result, model: received?.model ?? raw.model ?? null };
  };
  const done = (async () => {
    try {
      stopCheck(controller.signal); loaded = await loadSource({ executionRoot, sourceReportPath, signal: controller.signal, log: record.gitCommands });
      record.projectId = loaded.source.projectId; record.runId = loaded.source.runId; record.taskId = loaded.source.taskId; record.specRevision = currentSpec(); record.planRevision = currentPlan(); record.candidateCommit = loaded.summary.sourceCommit; record.baseCommit = loaded.source.baseCommit; record.provenance = loaded.summary;
      record.currentBinding = { projectId: record.projectId, runId: record.runId, taskId: record.taskId, attemptId: record.attemptId, specRevision: record.specRevision, planRevision: record.planRevision, candidateCommit: record.candidateCommit, sourceHash: loaded.summary.sourceHash, manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash };
      await assertCurrent(structuredClone(record.currentBinding)); stopCheck(controller.signal);
      directory = await mkdtemp(path.join(loaded.root, 'web-recheck-')); record.reportPath = path.join(directory, 'execution.json'); record.workspace = path.join(directory, 'workspace'); await mkdir(record.workspace);
      await applyProjectFiles({ workspace: record.workspace, files: loaded.files }); record.shellHash = (await installWebShell({ workspace: record.workspace })).hash; need(record.shellHash === loaded.summary.sourceShellHash, '保护外壳版本变化。');
      record.versions.push({ attempt: 1, commit: record.candidateCommit, sourceHash: loaded.summary.sourceHash, selfCheck: null, acceptance: null });
      record.status = 'checking_environment'; event('原候选仅建立独立内容快照，编码调用为0；检查受控环境。'); await save();
      record.environment = await createWindowsSandbox({ executable }).preflight({ workspace: record.workspace, signal: controller.signal }); await check();
      const version = record.versions[0], candidate = record.currentBinding;
      record.status = 'validating'; event('按当前清单重新执行HTTP/数据库自检，不继承原结论。'); await save(); await check();
      version.selfCheck = await runWebTests({ rootDir: directory, files: structuredClone(loaded.files), signal: controller.signal, executable, timeoutMs: Math.max(1, Math.min(90000, timeoutMs - (Date.now() - started))) }); await save();
      if (unknownStop(version.selfCheck)) { record.status = 'reconciliation_required'; throw new Error('新自检进程停止尚未确认。'); } await check();
      if (!completeHTTP(version.selfCheck, candidate)) { record.acceptanceStatus = 'changes_requested'; throw new Error('新自检未完整通过，固定代码不自动修复。'); }
      const acceptance = { status: 'checking', binding: { ...candidate }, test: null, browser: null, review: null, issues: [], openIssues: [], startedAt: new Date().toISOString() }; version.acceptance = acceptance; record.status = 'awaiting_acceptance'; record.acceptanceStatus = 'checking'; event('重新启动独立HTTP、浏览器与新Review，三方结束后才判定。'); await save();
      await Promise.allSettled([
        (async () => { try { await check(); const value = await runWebTests({ rootDir: directory, files: structuredClone(loaded.files), signal: controller.signal, executable, timeoutMs: Math.max(1, Math.min(90000, timeoutMs - (Date.now() - started))) }); acceptance.test = { ...value, binding: { ...candidate } }; if (unknownStop(value)) record.status = 'reconciliation_required'; await check(); } catch (cause) { acceptance.test = failedBranch(acceptance.test, candidate, cause, '独立HTTP复验未完成或版本核对失败。'); } await save(); })(),
        (async () => { try { await check(); const value = await runWebBrowserTests({ rootDir: directory, files: structuredClone(loaded.files), signal: controller.signal, executable, timeoutMs: Math.max(1, Math.min(90000, timeoutMs - (Date.now() - started))) }); acceptance.browser = { ...value, binding: { ...candidate } }; if (unknownStop(value)) record.status = 'reconciliation_required'; await check(); } catch (cause) { acceptance.browser = failedBranch(acceptance.browser, candidate, cause, '独立浏览器复验未完成或版本核对失败。'); } await save(); })(),
        (async () => { try {
          let value; for (let attempt = 0; attempt < 2; attempt++) { try { value = await reviewCall(loaded.previousIssues, attempt > 0); break; } catch (cause) { if (!cause.canCorrect || attempt || record.reviewCalls >= maxReviewCalls || controller.signal.aborted) throw cause; event('新Review响应无效，仅在原预算内对同一候选格式重核一次。'); await save(); } }
          const resolved = new Map(value.resolutions.map(item => [item.id, item]));
          acceptance.issues = loaded.previousIssues.map(issue => ({ ...issue, status: resolved.get(issue.id)?.status === 'resolved' ? 'resolved' : 'open', resolution: resolved.get(issue.id)?.reason, checkedCommit: candidate.candidateCommit }));
          for (const issue of value.issues) acceptance.issues.push({ ...issue, id: `ISSUE-${hash(issue).slice(0, 20)}`, status: 'open', originCommit: candidate.candidateCommit });
          acceptance.openIssues = acceptance.issues.filter(issue => issue.severity === 'blocking' && issue.status === 'open');
          acceptance.review = { ...value, status: 'completed', binding: { ...candidate }, policyHash: projectReviewPolicy.hash, kind: reviewerKind, openBlockingIssues: acceptance.openIssues.length };
        } catch { acceptance.review = { status: 'error', binding: { ...candidate }, policyHash: projectReviewPolicy.hash, error: '新Review没有给出完整有效结论。' }; } await save(); })(),
      ]);
      if ([acceptance.test, acceptance.browser].some(unknownStop)) { record.status = 'reconciliation_required'; throw new Error('独立复验进程仍待协调。'); }
      await check(); acceptance.finishedAt = new Date().toISOString();
      const passed = completeHTTP(acceptance.test, candidate) && completeBrowser(acceptance.browser, candidate) && acceptance.review?.status === 'completed' && !acceptance.openIssues.length;
      if (passed) {
        acceptance.status = reviewerKind === 'model' ? 'passed' : 'diagnostic_passed'; record.status = reviewerKind === 'model' ? 'accepted' : 'diagnostic_passed'; record.acceptanceStatus = acceptance.status;
        need(reviewerKind !== 'model' || isWebTaskAccepted(record), '现有完整门禁拒绝新的复验记录。'); event('原提交已得到本次全新结论；本次编码请求仍为0。');
      } else { acceptance.status = acceptance.review.status === 'error' ? 'error' : 'changes_requested'; record.acceptanceStatus = acceptance.status; record.status = 'failed'; record.error = '原代码复验未通过，保留新失败证据；编码修复另行处理。'; }
    } catch (cause) {
      if (cause.result) record.failure = { phase: record.status, result: structuredClone(cause.result), probeDirectory: cause.probeDirectory ?? null, cleanupError: cause.cleanupError ?? null };
      if (record.status === 'checking_environment') record.environmentFailure = { phase: 'environment_preflight', result: cause.result ? structuredClone(cause.result) : null, probeDirectory: cause.probeDirectory ?? null, cleanupError: cause.cleanupError ?? null };
      if (cause.reconciliationRequired || cause.result?.terminationConfirmed === false) record.status = 'reconciliation_required';
      if (record.status !== 'reconciliation_required') record.status = controller.signal.aborted ? timedOut ? 'timed_out' : 'stopped' : 'failed';
      record.error = controller.signal.aborted ? timedOut ? '复验总时长预算已耗尽。' : '复验已停止。' : cause.message ?? '复验失败。';
      if (record.acceptanceStatus === 'checking') record.acceptanceStatus = controller.signal.aborted ? 'cancelled' : 'error';
      const gate = record.versions[0]?.acceptance; if (gate?.status === 'checking') { gate.status = record.acceptanceStatus; gate.finishedAt = new Date().toISOString(); }
      event(record.error);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await Promise.allSettled([...receiptWrites]); record.finishedAt = new Date().toISOString(); await save(); }
    return structuredClone(record);
  })();
  return { id: record.id, cancel, done, snapshot: () => structuredClone(record) };
}
