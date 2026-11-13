import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { borrowingProfile as profile, validationManifest, hash } from './execution-profile.mjs';
import { runIndependentTests } from './independent-tests.mjs';
import { validateReviewResponse, reviewPolicy } from './review-model.mjs';

const fields = ['taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'sourceHash'];
const safeError = error => error?.reconciliationRequired ? '停止尚未确认，请核对检查进程。' : '独立检查服务未能完成，请查看对应检查记录。';

/** Platform-owned collector. There is deliberately no endpoint to submit a passed flag. */
export async function runCandidateAcceptance({ rootDir, candidate, source, sandbox, reviewer, previousIssues = [],
  assertCurrent, signal, timeoutMs = 15_000, reviewKind = 'model', onProgress = () => {} } = {}) {
  if (!rootDir || !candidate || fields.some(key => typeof candidate[key] !== 'string' || !candidate[key])
    || candidate.taskId !== profile.id || candidate.specRevision !== hash(profile.task)
    || candidate.planRevision !== hash({ file: profile.writableFile, validationManifest })
    || !/^[0-9a-f]{40,64}$/u.test(candidate.candidateCommit) || !/^[0-9a-f]{64}$/u.test(candidate.sourceHash)
    || typeof source !== 'string' || hash(source) !== candidate.sourceHash || Buffer.byteLength(source) > 32_768
    || typeof reviewer !== 'function' || typeof assertCurrent !== 'function' || !Array.isArray(previousIssues)
    || previousIssues.length > 20 || !['model', 'diagnostic'].includes(reviewKind)) throw new Error('独立验收输入不完整或版本无效。');
  previousIssues = structuredClone(previousIssues);
  const binding = Object.freeze({ ...Object.fromEntries(fields.map(key => [key, candidate[key]])),
    manifestHash: validationManifest.hash, reviewPolicyHash: reviewPolicy.hash, validationId: randomUUID() });
  const report = { id: binding.validationId, binding, reviewKind, status: 'checking', startedAt: new Date().toISOString(),
    finishedAt: null, test: null, review: null, issues: [], openIssues: [], error: null, reportPath: null };
  let directory, saving = Promise.resolve();
  const save = () => {
    saving = saving.then(async () => {
      if (!directory) return;
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
      await rename(temporary, report.reportPath);
    });
    return saving;
  };
  const progress = async message => { try { await onProgress(message); } catch { /* Observers cannot approve a candidate. */ } };
  const check = async () => {
    if (signal?.aborted) throw new Error('检查已取消。');
    await assertCurrent(binding);
    if (signal?.aborted) throw new Error('检查已取消。');
  };
  let reviewWorkspace;
  const verifyFile = async (target, expectedHash) => {
    const info = await lstat(target);
    const canonical = await realpath(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || (process.platform === 'win32' ? canonical.toLowerCase() !== target.toLowerCase() : canonical !== target)
      || hash(await readFile(target, 'utf8')) !== expectedHash) throw new Error('检查快照发生变化。');
  };
  const verifyReviewSnapshot = () => verifyFile(path.join(reviewWorkspace, profile.writableFile), binding.sourceHash);
  try {
    await check();
    await mkdir(path.resolve(rootDir), { recursive: true });
    const canonical = await realpath(path.resolve(rootDir));
    if ((process.platform === 'win32' ? canonical.toLowerCase() !== path.resolve(rootDir).toLowerCase() : canonical !== path.resolve(rootDir))) throw new Error('验收记录目录不可使用链接。');
    directory = await mkdtemp(path.join(canonical, 'validation-'));
    report.reportPath = path.join(directory, 'acceptance.json');
    report.testWorkspace = path.join(directory, 'test');
    reviewWorkspace = path.join(directory, 'review');
    report.reviewWorkspace = reviewWorkspace;
    await mkdir(path.join(reviewWorkspace, 'src'), { recursive: true });
    await writeFile(path.join(reviewWorkspace, profile.writableFile), source, { mode: 0o400 });
    await save();
    await verifyReviewSnapshot();
    // Both branches settle before the caller is allowed to repair the candidate.
    await Promise.allSettled([
      (async () => {
        try {
          const result = await runIndependentTests({ workspace: report.testWorkspace, source, sourceHash: binding.sourceHash,
            sandbox, signal, timeoutMs });
          report.test = { ...result, role: 'test', binding };
          await progress(`独立测试结束：${result.status}。`);
        } catch (error) {
          report.test = { role: 'test', binding, status: error?.reconciliationRequired ? 'reconciliation_required' : 'error', error: safeError(error) };
        }
        await save();
      })(),
      (async () => {
        let stage = 'request';
        try {
          await check();
          const raw = await reviewer({ task: profile.task, files: [{ path: profile.writableFile, content: await readFile(path.join(reviewWorkspace, profile.writableFile), 'utf8') }],
            previousIssues: structuredClone(previousIssues), signal });
          stage = 'schema';
          const normalized = validateReviewResponse(raw, { files: [{ path: profile.writableFile, content: source }], previousIssues });
          stage = 'snapshot';
          await verifyReviewSnapshot();
          report.review = { role: 'review', binding, status: 'completed', ...normalized,
            model: typeof raw.model === 'string' ? raw.model : null,
            usage: Object.fromEntries(['inputTokens', 'outputTokens'].map(key => [key,
              Number.isSafeInteger(raw.usage?.[key]) && raw.usage[key] >= 0 ? raw.usage[key] : null])) };
          await progress('独立Review已返回结构化意见。');
        } catch (error) {
          report.review = { role: 'review', binding, status: 'error', stage,
            error: stage === 'schema' ? 'Review响应未通过结构、代码位置或历史问题校验。'
              : stage === 'snapshot' ? 'Review快照已变化，意见不能用于放行。' : 'Review请求未完成，请检查模型配置或连接后重新检查。',
            usage: { inputTokens: null, outputTokens: null } };
        }
        await save();
      })(),
    ]);
    if (report.test?.status === 'reconciliation_required') {
      report.status = 'reconciliation_required'; report.error = '独立检查进程停止尚未确认。';
    } else if (signal?.aborted) {
      report.status = 'cancelled'; report.error = '独立验收已取消，结果不能用于放行。';
    } else {
      await check();
      await verifyReviewSnapshot();
      const test = report.test;
      if (test?.command) {
        await verifyFile(path.join(report.testWorkspace, profile.writableFile), binding.sourceHash);
        await verifyFile(path.join(report.testWorkspace, '.platform', 'runner.cjs'), validationManifest.runnerHash);
      }
      const testComplete = test?.role === 'test' && test.sourceHash === binding.sourceHash && test.manifestHash === binding.manifestHash
        && test.runnerHash === validationManifest.runnerHash && Array.isArray(test.checks) && test.checks.length === validationManifest.count
        && test.command?.terminationConfirmed === true;
      if (!testComplete || ['error', 'cancelled'].includes(test?.status) || report.review?.status !== 'completed') {
        report.status = 'error'; report.error = '缺少完整的独立检查结论，未放行候选。';
      } else {
        const resolutionById = new Map(report.review.resolutions.map(item => [item.id, item]));
        report.issues = previousIssues.map(item => ({ ...item, status: resolutionById.get(item.id)?.status === 'resolved' ? 'resolved' : 'open',
          resolution: resolutionById.get(item.id)?.reason ?? '', checkedCommit: binding.candidateCommit }));
        for (const item of report.review.issues) report.issues.push({ ...item,
          id: `ISSUE-${hash(item).slice(0, 20)}`, status: 'open', originCommit: binding.candidateCommit });
        report.openIssues = [...new Map(report.issues.filter(item => item.severity === 'blocking' && item.status === 'open').map(item => [item.id, item])).values()];
        if (report.openIssues.length > 20) {
          report.status = 'error'; report.error = '未解决阻塞问题超过单轮Review预算，请人工处理后重新检查。';
        } else if (test.status !== 'passed' || test.command.exitCode !== 0 || test.command.stopReason || test.command.truncated
          || !test.checks.every(item => item.passed === true) || report.openIssues.length) {
          report.status = 'changes_requested'; report.error = '测试未通过或仍有阻塞性审查问题。';
        } else report.status = reviewKind === 'model' ? 'passed' : 'diagnostic_passed';
      }
    }
  } catch (error) {
    report.status = error?.reconciliationRequired ? 'reconciliation_required' : signal?.aborted ? 'cancelled' : 'invalidated';
    report.error = report.status === 'reconciliation_required' ? safeError(error) : '候选版本或检查快照已失效，结果未放行。';
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
  }
  return report;
}

export function isTaskAccepted(record) {
  const latest = record?.versions?.at(-1);
  const report = latest?.acceptance;
  return record?.status === 'accepted' && record.acceptanceStatus === 'passed' && report?.status === 'passed'
    && report.reviewKind === 'model' && latest.commit === record.candidateCommit && report.binding?.candidateCommit === record.candidateCommit
    && report.binding?.sourceHash === latest.sourceHash && report.binding?.specRevision === record.specRevision
    && report.binding?.planRevision === record.planRevision && report.binding?.attemptId === record.attemptId
    && report.binding?.taskId === record.taskId && report.binding?.manifestHash === validationManifest.hash
    && record.validationManifest?.hash === validationManifest.hash && report.binding?.reviewPolicyHash === reviewPolicy.hash
    && report.test?.role === 'test' && report.review?.role === 'review' && report.test.status === 'passed' && report.review.status === 'completed'
    && report.test.command?.exitCode === 0 && report.test.command?.terminationConfirmed === true
    && report.test.command?.stopReason === null && report.test.command?.truncated === false
    && Array.isArray(report.test.checks) && report.test.checks.length === validationManifest.count && report.test.checks.every(item => item.passed === true)
    && Array.isArray(report.openIssues) && report.openIssues.length === 0
    && [...fields, 'manifestHash', 'reviewPolicyHash', 'validationId'].every(key => report.test.binding?.[key] === report.binding[key] && report.review.binding?.[key] === report.binding[key]);
}
