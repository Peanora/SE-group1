import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, realpath, writeFile } from 'node:fs/promises';
import { minimalEnv, runProcess } from './managed-process.mjs';
import { createWindowsSandbox } from './windows-sandbox.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { installWebShell, verifyWebShell } from './web-delivery.mjs';
import { webProfile } from './web-profile.mjs';
import { databaseObserverHash, runWebTests, webManifest } from './web-tests.mjs';
import { projectReviewPolicy, validateProjectReviewResponse } from './project-review-model.mjs';
import { browserManifest, runWebBrowserTests } from './web-browser-tests.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sourceHash = files => hash(validateProjectFiles(files));
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const identityKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'sourceHash', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash'];
const terminal = new Set(['accepted', 'diagnostic_passed', 'failed', 'stopped', 'timed_out', 'reconciliation_required']);
const abortError = () => Object.assign(new Error('项目执行已停止。'), { name: 'AbortError' });
const stoppedCleanly = item => item?.terminationConfirmed === true && item.sourceUnchanged === true
  && item.status === 'stopped' && item.exitCode === 0 && item.stopAcknowledged === true;

async function checkedOutputDirectory(directory) {
  const absolute = path.resolve(directory), anchor = path.parse(absolute).root;
  let current = anchor;
  for (const part of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      await mkdir(current, { mode: 0o700 }); info = await lstat(current);
    }
    const canonical = await realpath(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === 'win32' ? canonical.toLowerCase() !== current.toLowerCase() : canonical !== current)) throw new Error('执行记录目录及父目录不可使用链接。');
  }
  return current;
}

async function cancelableModelCall(callback, input, signal) {
  if (signal.aborted) throw abortError();
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(abortError()); });
  signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    // Late replies are data only. They cannot write files or publish conclusions.
    return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw abortError(); return callback(input); }), interrupted]);
  } finally { signal.removeEventListener('abort', rejectAbort); }
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object') throw new Error('项目执行缺少已确认版本。');
  const normalized = {};
  for (const key of ['projectId', 'runId', 'taskId']) {
    if (typeof binding[key] !== 'string' || !/^[\w-]{1,128}$/u.test(binding[key])) throw new Error('项目执行身份无效。');
    normalized[key] = binding[key];
  }
  for (const key of ['specRevision', 'planRevision']) {
    if (!HASH.test(binding[key] ?? '')) throw new Error('项目执行的规格或计划版本无效。');
    normalized[key] = binding[key];
  }
  return normalized;
}

function completeTest(test, binding) {
  return test?.status === 'passed' && test.profileId === webProfile.id && test.sourceHash === binding.sourceHash
    && test.manifestHash === binding.manifestHash && test.terminationConfirmed === true
    && Array.isArray(test.checks) && test.checks.length === webManifest.count
    && webManifest.checks.every(rule => test.checks.filter(item => item.id === rule.id && item.passed === true).length === 1)
    && Array.isArray(test.processes) && test.processes.length > 0
    && test.processes.every(stoppedCleanly)
    && Array.isArray(test.databaseCommands) && test.databaseCommands.length === 2
    && test.databaseCommands.every(command => command.kind === 'database_observation' && command.runnerHash === databaseObserverHash
      && command.sourceHash === binding.sourceHash && command.exitCode === 0 && command.terminationConfirmed === true
      && command.stopReason === null && command.truncated === false)
    && Array.isArray(test.databasePreflights) && test.databasePreflights.length === 0;
}

function completeBrowser(test, binding) {
  return test?.status === 'passed' && test.profileId === webProfile.id && test.sourceHash === binding.sourceHash && test.manifestHash === binding.browserManifestHash
    && test.terminationConfirmed === true && test.browser?.closed === true && typeof test.browser.version === 'string'
    && Array.isArray(test.checks) && test.checks.length === browserManifest.count
    && browserManifest.checks.every(rule => test.checks.filter(item => item.id === rule.id && item.passed === true).length === 1)
    && Array.isArray(test.processes) && test.processes.length >= 3
    && test.processes.filter(item => item.kind === 'browser').length === 1
    && test.processes.every(item => item.kind === 'browser' ? item.terminationConfirmed === true && item.status === 'stopped' && item.exitCode === 0 : stoppedCleanly(item));
}

/** Durable execution records are data. This predicate checks the registered rules, never a candidate's npm test. */
export function isWebTaskAccepted(record) {
  const latest = record?.versions?.at(-1), acceptance = latest?.acceptance, binding = acceptance?.binding;
  if (record?.status !== 'accepted' || record.providerKind !== 'model' || record.reviewerKind !== 'model'
    || record.profileId !== webProfile.id || record.acceptanceStatus !== 'passed' || acceptance?.status !== 'passed'
    || !binding || !COMMIT.test(binding.candidateCommit ?? '') || !['sourceHash', 'specRevision', 'planRevision'].every(key => HASH.test(binding[key] ?? ''))
    || binding.manifestHash !== webManifest.hash
    || binding.browserManifestHash !== browserManifest.hash || !completeBrowser(acceptance.browser, binding)
    || binding.reviewPolicyHash !== projectReviewPolicy.hash || record.candidateCommit !== latest.commit
    || record.candidateCommit !== binding.candidateCommit || latest.sourceHash !== binding.sourceHash
    || !completeTest(latest.selfCheck, binding) || !completeTest(acceptance.test, binding) || acceptance.review?.status !== 'completed'
    || acceptance.review.policyHash !== projectReviewPolicy.hash || acceptance.review.openBlockingIssues !== 0
    || !Array.isArray(acceptance.review.issues) || acceptance.review.issues.some(issue => issue.severity === 'blocking')
    || !Array.isArray(acceptance.issues) || acceptance.issues.some(issue => issue.severity === 'blocking' && issue.status === 'open')
    || !Array.isArray(acceptance.openIssues) || acceptance.openIssues.length) return false;
  return ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision'].every(key => record[key] === binding[key])
    && identityKeys.every(key => acceptance.test.binding?.[key] === binding[key] && acceptance.browser.binding?.[key] === binding[key] && acceptance.review.binding?.[key] === binding[key]);
}

/** One real multi-file Web candidate, bounded repair loop, independent fixed tests and model Review. */
export function startWebExecution({ outputDir, binding, task = '', provider, reviewer,
  providerKind = 'model', reviewerKind = 'model', executable = process.env.EXECUTION_SANDBOX_EXE,
  signal, maxCalls = 3, maxReviewCalls = 3, timeoutMs = 600_000, assertCurrent = async () => {}, onEvent = () => {} } = {}) {
  const identity = normalizeBinding(binding);
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || typeof provider !== 'function' || typeof reviewer !== 'function'
    || !['model', 'trusted_fixture'].includes(providerKind) || !['model', 'diagnostic'].includes(reviewerKind)
    || typeof task !== 'string' || Buffer.byteLength(task) > 96 * 1024 || typeof assertCurrent !== 'function'
    || typeof onEvent !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Web执行配置无效。');
  if (![maxCalls, maxReviewCalls].every(value => Number.isInteger(value) && value >= 1 && value <= 5)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Web执行预算无效。');
  // The registered contract is authoritative. Source material may add detail but cannot remove its rules.
  const confirmedTask = `${JSON.stringify(webProfile.task, null, 2)}\n\n已确认的项目资料（不得放宽上述契约）：\n${task}`;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let timedOut = false, directory, saveQueue = Promise.resolve();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const record = {
    id: randomUUID(), ...identity, attemptId: randomUUID(), profileId: webProfile.id, providerKind, reviewerKind,
    status: 'preparing', acceptanceStatus: 'not_checked', startedAt: new Date().toISOString(), finishedAt: null,
    budget: { maxCalls, maxReviewCalls, maxModelCalls: maxCalls + maxReviewCalls, timeoutMs },
    calls: 0, reviewCalls: 0, totalModelCalls: 0, modelCalls: [], usage: { inputTokens: null, outputTokens: null },
    versions: [], proposalFailures: [], events: [], gitCommands: [], baseCommit: null, candidateCommit: null, diff: '', error: null,
    validationManifest: { hash: webManifest.hash, count: webManifest.count, checks: webManifest.checks, databaseObserverHash },
    browserManifest: { hash: browserManifest.hash, count: browserManifest.count, checks: browserManifest.checks },
    reviewPolicyHash: projectReviewPolicy.hash,
  };
  const event = message => {
    const item = { sequence: record.events.length + 1, time: new Date().toISOString(), status: record.status, message };
    record.events.push(item); try { onEvent(item); } catch { /* Observers cannot alter results. */ }
  };
  const save = () => {
    if (!directory) return Promise.resolve();
    const content = JSON.stringify(record, null, 2);
    const next = saveQueue.catch(() => {}).then(async () => {
      const target = path.join(directory, 'execution.json'), temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, target);
    });
    saveQueue = next; return next;
  };
  const checkStop = () => { if (controller.signal.aborted) throw abortError(); };
  const checkIdentity = async () => { checkStop(); await assertCurrent(structuredClone(identity)); checkStop(); };
  const git = async (args, raw = false) => {
    checkStop();
    const result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: record.workspace, signal: controller.signal, timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(record.workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    });
    record.gitCommands.push({ args, ...result });
    if (!result.terminationConfirmed) { record.status = 'reconciliation_required'; throw new Error('代码版本进程停止尚未确认。'); }
    checkStop();
    if (result.exitCode !== 0 || result.stopReason || result.truncated) throw new Error('保存或读取代码版本失败。');
    return raw ? result.stdout : result.stdout.trim();
  };
  const callModel = async (role, callback, input) => {
    checkStop();
    const isCode = role === 'coding';
    if (isCode ? record.calls >= maxCalls : record.reviewCalls >= maxReviewCalls) throw new Error('模型调用次数预算已耗尽。');
    if (isCode) record.calls++; else record.reviewCalls++;
    const call = { role, attempt: isCode ? record.calls : record.reviewCalls, kind: (isCode ? providerKind : reviewerKind) === 'model' ? 'model' : 'diagnostic',
      model: null, usage: { inputTokens: null, outputTokens: null } };
    record.modelCalls.push(call); record.totalModelCalls = record.modelCalls.filter(item => item.kind === 'model').length;
    record.usage = { inputTokens: null, outputTokens: null };
    await save();
    checkStop();
    const recordUsage = value => {
      call.model = typeof value?.model === 'string' ? value.model : null;
      for (const key of ['inputTokens', 'outputTokens']) {
        const count = value?.usage?.[key]; call.usage[key] = Number.isSafeInteger(count) && count >= 0 ? count : null;
        const sum = record.modelCalls.reduce((total, item) => total + (item.usage[key] ?? 0), 0);
        record.usage[key] = record.modelCalls.every(item => item.usage[key] !== null) && Number.isSafeInteger(sum) ? sum : null;
      }
    };
    let response, acceptsReceipt = true, receiptStarted = false;
    const onReceipt = async value => {
      checkStop();
      if (!acceptsReceipt || receiptStarted) throw new Error('模型回执不属于当前调用。');
      if (!value || typeof value.model !== 'string' || value.model.length > 200 || typeof value.finishReason !== 'string' || value.finishReason.length > 100
        || typeof value.content !== 'string' || Buffer.byteLength(value.content) > (isCode ? 512 : 128) * 1024) throw new Error('模型回执结构或大小无效。');
      const receipt = { model: value.model, finishReason: value.finishReason, usage: Object.fromEntries(['inputTokens', 'outputTokens'].map(key => [key,
        Number.isSafeInteger(value.usage?.[key]) && value.usage[key] >= 0 ? value.usage[key] : null])), content: value.content };
      receiptStarted = true; recordUsage(receipt);
      const receiptPath = path.join(directory, `model-${role}-${call.attempt}.json`), serialized = JSON.stringify(receipt, null, 2);
      await writeFile(receiptPath, serialized, { flag: 'wx', mode: 0o600 });
      checkStop();
      if (!acceptsReceipt) throw abortError();
      call.receiptPath = receiptPath; call.receiptHash = hash(serialized);
      call.contentBytes = Buffer.byteLength(receipt.content); call.blankContent = !receipt.content.trim();
      await save();
    };
    try { response = await cancelableModelCall(callback, { ...input, onReceipt }, controller.signal); }
    finally { acceptsReceipt = false; checkStop(); }
    if (!call.receiptPath) recordUsage(response);
    await save(); return response;
  };
  const fixedCandidate = async candidate => {
    await checkIdentity();
    if (record.candidateCommit !== candidate.candidateCommit || await git(['rev-parse', 'HEAD']) !== candidate.candidateCommit
      || await git(['status', '--porcelain', '--untracked-files=all']) || sourceHash(await readProjectFiles(record.workspace)) !== candidate.sourceHash
      || (await verifyWebShell({ workspace: record.workspace })).hash !== record.shellHash) throw new Error('候选源码、平台外壳或版本已改变，不能接收检查结果。');
    await checkIdentity();
  };
  const done = (async () => {
    try {
      await checkIdentity();
      const canonical = await checkedOutputDirectory(outputDir);
      directory = await mkdtemp(path.join(canonical, 'web-execution-'));
      record.workspace = path.join(directory, 'workspace'); record.reportPath = path.join(directory, 'execution.json');
      record.platform = { nodeVersion: process.version, executorSourceHash: hash(await readFile(new URL(import.meta.url), 'utf8')) };
      await mkdir(record.workspace);
      record.shellHash = (await installWebShell({ workspace: record.workspace })).hash;
      await mkdir(path.join(record.workspace, '.platform', 'tmp'), { recursive: true });
      await writeFile(path.join(record.workspace, '.platform', 'gitconfig'), '', { flag: 'wx' });
      const sandbox = createWindowsSandbox({ executable });
      record.status = 'checking_environment'; event('检查受控运行环境，尚未生成业务代码。'); await save();
      record.environment = await sandbox.preflight({ workspace: record.workspace, signal: controller.signal });
      await checkIdentity();
      await git(['init', '--quiet']); await git(['add', '--', '.']);
      await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'commit', '--quiet', '-m', 'base: protected web project shell']);
      record.baseCommit = await git(['rev-parse', 'HEAD']);
      let feedback = '', previousIssues = [], formatCorrections = 0;
      for (let attempt = 1; attempt <= maxCalls; attempt++) {
        await checkIdentity(); record.status = 'generating'; event(`第${attempt}轮多文件编码。`); await save();
        let proposal;
        try {
          proposal = await callModel('coding', provider, { task: confirmedTask, files: await readProjectFiles(record.workspace), feedback, signal: controller.signal });
        } catch (cause) {
          if (cause?.code === 'invalid_model_response') {
            record.proposalFailures.push({ attempt, code: cause.code, receiptHash: record.modelCalls.at(-1)?.receiptHash ?? null });
            await save();
            if (formatCorrections < 1 && attempt < maxCalls && !controller.signal.aborted) {
              formatCorrections++;
              feedback = JSON.stringify({ message: '上次模型正文不是有效JSON文件对象；未写入任何建议。请只输出JSON {"files":[{"path":"src/app.mjs","content":"完整文件内容"}]}，完整代码字符串必须正确JSON转义，禁止空白、Markdown和解释。', priorFeedback: feedback.slice(0, 12_000) });
              event('模型格式无效，已保留响应证据；在原预算内进行一次格式纠正。'); await save();
              continue;
            }
          }
          throw cause;
        }
        await checkIdentity();
        const changed = await applyProjectFiles({ workspace: record.workspace, files: validateProjectFiles(proposal?.files) });
        if (!changed.changed.length) throw new Error('编码没有产生实际修改，停止重复尝试。');
        await verifyWebShell({ workspace: record.workspace });
        await git(['add', '--', ...changed.changed]);
        await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'commit', '--quiet', '-m', `candidate: web attempt ${attempt}`]);
        const files = await readProjectFiles(record.workspace);
        record.candidateCommit = await git(['rev-parse', 'HEAD']);
        record.diff = await git(['diff', record.baseCommit, record.candidateCommit, '--'], true);
        const version = { attempt, commit: record.candidateCommit, sourceHash: sourceHash(files), selfCheck: null, acceptance: null };
        record.versions.push(version);
        const candidate = { ...identity, attemptId: record.attemptId, candidateCommit: version.commit, sourceHash: version.sourceHash,
          manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash };
        await fixedCandidate(candidate);
        record.status = 'validating'; event('候选已固定，运行真实HTTP和数据库自检。'); await save();
        version.selfCheck = await runWebTests({ rootDir: directory, files, executable, signal: controller.signal,
          timeoutMs: Math.min(90_000, timeoutMs), onEvent: item => event(`自检：${item.message ?? item.type ?? '运行中'}`) });
        if (version.selfCheck.status === 'reconciliation_required' || version.selfCheck.processes?.some(item => item.terminationConfirmed !== true)
          || version.selfCheck.databaseCommands?.some(item => item.terminationConfirmed !== true)
          || version.selfCheck.databasePreflights?.some(item => item.terminationConfirmed !== true)) {
          record.status = 'reconciliation_required'; throw new Error('自检进程停止尚未确认。');
        }
        await fixedCandidate(candidate);
        if (!completeTest(version.selfCheck, candidate)) {
          if (version.selfCheck.status !== 'failed') throw new Error('自检服务没有给出完整失败证据，停止自动返工。');
          feedback = JSON.stringify({ message: '真实自检失败，按证据修复。', checks: version.selfCheck.checks?.filter(item => !item.passed), error: version.selfCheck.error }).slice(0, 16_384);
          event('自检未通过，保留失败后在预算内修复。'); await save();
          if (attempt === maxCalls) throw new Error('自检未通过，编码次数预算已耗尽。');
          continue;
        }
        record.status = 'awaiting_acceptance'; record.acceptanceStatus = 'checking'; event('启动同版本独立HTTP、浏览器测试和独立Review。');
        const acceptance = { status: 'checking', binding: candidate, test: null, browser: null, review: null, openIssues: [], issues: [], startedAt: new Date().toISOString() };
        version.acceptance = acceptance; await save();
        await Promise.allSettled([
          (async () => {
            try {
              const result = await runWebTests({ rootDir: directory, files, executable, signal: controller.signal, timeoutMs: Math.min(90_000, timeoutMs) });
              acceptance.test = { ...result, binding: { ...candidate } };
            } catch { acceptance.test = { status: 'error', binding: { ...candidate }, error: '独立测试服务没有完成。' }; }
            event(`独立测试：${acceptance.test.status}。`); await save();
          })(),
          (async () => {
            try {
              const result = await runWebBrowserTests({ rootDir: directory, files, executable, signal: controller.signal, timeoutMs: Math.min(90_000, timeoutMs) });
              acceptance.browser = { ...result, binding: { ...candidate } };
            } catch { acceptance.browser = { status: 'error', binding: { ...candidate }, error: '独立浏览器服务没有完成。' }; }
            event(`独立浏览器：${acceptance.browser.status}。`); await save();
          })(),
          (async () => {
            try {
              // Separate immutable values, no self-check or independent test conclusions are supplied.
              const raw = await callModel('review', reviewer, { task: confirmedTask, files: structuredClone(files), previousIssues: structuredClone(previousIssues), signal: controller.signal });
              const result = validateProjectReviewResponse(raw, { files, previousIssues });
              const resolutions = new Map(result.resolutions.map(item => [item.id, item]));
              const issues = previousIssues.map(issue => ({ ...issue, status: resolutions.get(issue.id)?.status === 'resolved' ? 'resolved' : 'open',
                resolution: resolutions.get(issue.id)?.reason, checkedCommit: candidate.candidateCommit }));
              for (const issue of result.issues) issues.push({ ...issue, id: `ISSUE-${hash(issue).slice(0, 20)}`, status: 'open', originCommit: candidate.candidateCommit });
              acceptance.issues = issues;
              acceptance.openIssues = [...new Map(issues.filter(issue => issue.severity === 'blocking' && issue.status === 'open').map(issue => [issue.id, issue])).values()];
              acceptance.review = { ...result, status: 'completed', binding: { ...candidate }, policyHash: projectReviewPolicy.hash,
                model: raw.model ?? null, openBlockingIssues: acceptance.openIssues.length };
            } catch { acceptance.review = { status: 'error', binding: { ...candidate }, policyHash: projectReviewPolicy.hash, error: 'Review请求、结构或问题证据无效，未放行。' }; }
            event(`独立Review：${acceptance.review.status}。`); await save();
          })(),
        ]);
        if ([acceptance.test, acceptance.browser].some(result => result?.status === 'reconciliation_required' || result?.processes?.some(item => item.terminationConfirmed !== true)
          || result?.databaseCommands?.some(item => item.terminationConfirmed !== true) || result?.databasePreflights?.some(item => item.terminationConfirmed !== true)
          || result?.browser?.closed === false)) {
          record.status = 'reconciliation_required'; throw new Error('独立测试进程停止尚未确认。');
        }
        await fixedCandidate(candidate);
        if (acceptance.review?.status !== 'completed' || !['passed', 'failed'].includes(acceptance.test?.status) || !['passed', 'failed'].includes(acceptance.browser?.status)
          || !Array.isArray(acceptance.test?.checks) || !Array.isArray(acceptance.browser?.checks)
          || acceptance.test.checks.length !== webManifest.count || acceptance.browser.checks.length !== browserManifest.count || acceptance.openIssues.length > 20) {
          acceptance.status = 'error'; throw new Error('独立结论不完整或超过审查预算，停止自动返工。');
        }
        acceptance.finishedAt = new Date().toISOString();
        if (completeTest(acceptance.test, candidate) && completeBrowser(acceptance.browser, candidate) && !acceptance.openIssues.length) {
          acceptance.status = providerKind === 'model' && reviewerKind === 'model' ? 'passed' : 'diagnostic_passed';
          record.acceptanceStatus = acceptance.status; record.status = acceptance.status === 'passed' ? 'accepted' : 'diagnostic_passed';
          event(record.status === 'accepted' ? '当前固定全栈候选通过独立测试与Review。' : '可信候选诊断通过，不计为模型任务验收。'); break;
        }
        acceptance.status = 'changes_requested'; record.acceptanceStatus = 'changes_requested'; previousIssues = acceptance.openIssues;
        feedback = JSON.stringify({ message: '独立检查要求修复；新版本必须重跑两方检查。', issues: previousIssues,
          failedTests: acceptance.test.checks.filter(item => !item.passed), failedBrowser: acceptance.browser.checks.filter(item => !item.passed) }).slice(0, 16_384);
        event('独立门禁要求返工，旧版本通过结果不复用。'); await save();
        if (attempt === maxCalls) throw new Error('独立门禁未通过，编码次数预算已耗尽。');
      }
    } catch (cause) {
      if (record.status === 'checking_environment') {
        record.environmentFailure = { phase: 'environment_preflight', result: cause?.result ? structuredClone(cause.result) : null,
          probeDirectory: typeof cause?.probeDirectory === 'string' ? cause.probeDirectory : null,
          cleanupError: typeof cause?.cleanupError === 'string' ? cause.cleanupError : null };
      }
      if (cause?.reconciliationRequired) record.status = 'reconciliation_required';
      if (record.status !== 'reconciliation_required') record.status = controller.signal.aborted ? timedOut ? 'timed_out' : 'stopped' : 'failed';
      record.error = record.status === 'reconciliation_required' ? '仍有进程状态待核对，未发布通过结论。'
        : controller.signal.aborted ? timedOut ? '执行达到总时长上限。' : '执行已停止。'
          : cause instanceof Error ? cause.message : '执行失败。';
      if (record.acceptanceStatus === 'checking') record.acceptanceStatus = controller.signal.aborted ? 'cancelled' : 'error';
      const incomplete = record.versions.at(-1)?.acceptance;
      if (incomplete?.status === 'checking') { incomplete.status = record.acceptanceStatus; incomplete.finishedAt = new Date().toISOString(); }
      event(record.error);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (!terminal.has(record.status)) { record.status = 'failed'; record.error = '执行没有得到完整的可信结论。'; }
      record.finishedAt = new Date().toISOString(); await save();
    }
    return record;
  })();
  return { id: record.id, cancel, done, snapshot: () => structuredClone(record) };
}
