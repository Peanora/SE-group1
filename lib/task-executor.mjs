import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile, rename, lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { borrowingProfile as profile, validationCases, validationManifest, runnerSource, hash } from './execution-profile.mjs';
import { runProcess, minimalEnv } from './managed-process.mjs';

const TERMINAL = new Set(['executed', 'failed', 'stopped', 'timed_out', 'reconciliation_required']);

/** A single, bounded coding trial. This is not a scheduler or software release verdict. */
export function startTaskExecution({ outputDir, provider, sandbox, providerKind = 'model', signal, maxCalls = 2, timeoutMs = 180_000, onEvent = () => {} } = {}) {
  if (!outputDir || typeof provider !== 'function' || typeof sandbox?.preflight !== 'function' || typeof sandbox?.run !== 'function') throw new Error('执行器缺少输出目录、模型或受限执行适配器。');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 3 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('执行预算无效。');
  const controller = new AbortController();
  let deadline = false;
  const cancel = () => controller.abort(new Error('停止请求'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { deadline = true; controller.abort(new Error('执行超时')); }, timeoutMs);
  const record = {
    id: randomUUID(), taskId: profile.id, attemptId: randomUUID(), providerKind, model: null, status: 'preparing',
    specRevision: hash(profile.task), planRevision: hash({ file: profile.writableFile, validationManifest }),
    validationManifest, acceptanceStatus: 'not_reviewed', startedAt: new Date().toISOString(), finishedAt: null,
    budget: { maxCalls, timeoutMs, maxChangeBytes: 32_768, maxOutputBytes: 65_536 },
    calls: 0, usage: { inputTokens: null, outputTokens: null }, versions: [], commands: [], events: [],
    baseCommit: null, candidateCommit: null, diff: '', gitCommands: [], error: null,
  };
  let directory;
  const event = message => {
    const item = { sequence: record.events.length + 1, time: new Date().toISOString(), message };
    record.events.push(item);
    try { onEvent(item); } catch { /* An observer cannot change execution results. */ }
  };
  const save = async () => {
    if (!directory) return;
    const target = path.join(directory, 'execution.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temporary, target);
  };
  const checkStop = () => { if (controller.signal.aborted) throw new Error('执行已停止'); };
  const git = async (args, { allowFailure = false } = {}) => {
    checkStop();
    const result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: record.workspace, signal: controller.signal, timeoutMs: 10_000,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(record.workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    });
    record.gitCommands.push({ args, ...result });
    if (!result.terminationConfirmed) { record.status = 'reconciliation_required'; throw new Error('版本管理进程停止未确认。'); }
    if (!allowFailure && result.exitCode !== 0) throw new Error('保存代码版本失败。');
    return result.stdout.trim();
  };
  const done = (async () => {
    try {
      await mkdir(path.resolve(outputDir), { recursive: true });
      const root = await realpath(path.resolve(outputDir));
      directory = await mkdtemp(path.join(root, 'execution-'));
      record.workspace = path.join(directory, 'workspace');
      record.reportPath = path.join(directory, 'execution.json');
      await mkdir(path.join(record.workspace, 'src'), { recursive: true });
      await mkdir(path.join(record.workspace, '.platform', 'tmp'), { recursive: true });
      await writeFile(path.join(record.workspace, profile.writableFile), profile.seed);
      await writeFile(path.join(record.workspace, '.platform', 'runner.cjs'), runnerSource);
      await writeFile(path.join(record.workspace, '.platform', 'gitconfig'), '');
      await writeFile(path.join(record.workspace, '.gitignore'), '.platform/\n');
      await save(); checkStop();
      record.platform = { nodeVersion: process.version, executorSourceHash: hash(await readFile(new URL(import.meta.url), 'utf8')),
        sandboxSourceHash: hash(await readFile(new URL('./windows-sandbox.mjs', import.meta.url), 'utf8')) };
      record.status = 'checking_environment'; event('预检文件边界和网络限制。'); await save();
      record.environment = await sandbox.preflight({ workspace: record.workspace, signal: controller.signal });
      checkStop();
      await git(['init', '--quiet']);
      await git(['add', '.']);
      await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'commit', '--quiet', '-m', 'base: confirmed borrowing task']);
      record.baseCommit = await git(['rev-parse', 'HEAD']);
      let feedback = '';
      for (let attempt = 1; attempt <= maxCalls; attempt++) {
        checkStop(); record.status = 'generating'; record.calls = attempt;
        event(`第 ${attempt} 次代码修改请求。`); await save();
        const current = await readFile(path.join(record.workspace, profile.writableFile), 'utf8');
        const proposal = await provider({ task: profile.task, files: [{ path: profile.writableFile, content: current }], feedback, signal: controller.signal });
        checkStop();
        record.model = proposal?.model ?? null;
        if (!Array.isArray(proposal?.files) || proposal.files.length !== 1 || proposal.files[0]?.path !== profile.writableFile || typeof proposal.files[0]?.content !== 'string') throw new Error('模型修改超出唯一允许文件。');
        const content = proposal.files[0].content;
        if (!content.trim() || Buffer.byteLength(content) > record.budget.maxChangeBytes) throw new Error('模型修改为空或超过大小预算。');
        if (content === current) throw new Error('模型没有产生实际代码改动。');
        const target = path.join(record.workspace, profile.writableFile);
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(target) !== target) throw new Error('候选文件不是允许的普通文件。');
        await writeFile(target, content, { mode: 0o600 });
        for (const key of ['inputTokens', 'outputTokens']) {
          const value = proposal.usage?.[key];
          // Missing usage remains unknown, rather than being treated as zero.
          if (attempt === 1) record.usage[key] = Number.isSafeInteger(value) && value >= 0 ? value : null;
          else record.usage[key] = record.usage[key] !== null && Number.isSafeInteger(value) && value >= 0 ? record.usage[key] + value : null;
        }
        await git(['add', '--', profile.writableFile]);
        await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'commit', '--quiet', '-m', `candidate: attempt ${attempt}`]);
        record.candidateCommit = await git(['rev-parse', 'HEAD']);
        record.diff = await git(['diff', record.baseCommit, record.candidateCommit, '--', profile.writableFile]);
        const version = { attempt, commit: record.candidateCommit, sourceHash: hash(content), check: null };
        record.versions.push(version);
        record.status = 'validating'; event(`候选版本已固定，执行 ${validationManifest.count} 项业务检查。`); await save();
        const result = await sandbox.run({
          workspace: record.workspace, runnerFile: path.join(record.workspace, '.platform', 'runner.cjs'),
          input: JSON.stringify(validationCases.map(({ expected, name, ...input }) => input)), signal: controller.signal,
          timeoutMs: Math.min(15_000, timeoutMs), maxOutputBytes: record.budget.maxOutputBytes,
        });
        record.commands.push({ ...result, commit: version.commit, manifestHash: validationManifest.hash, command: 'sandbox: node --preserve-symlinks-main .platform/runner.cjs' });
        if (!result.terminationConfirmed) { record.status = 'reconciliation_required'; throw new Error('目标进程停止尚未确认。'); }
        checkStop();
        if (hash(await readFile(target, 'utf8')) !== version.sourceHash || await git(['rev-parse', 'HEAD']) !== version.commit) throw new Error('检查期间候选代码版本发生变化。');
        let observations;
        try { observations = JSON.parse(result.stdout); } catch { observations = null; }
        const validEnvelope = result.exitCode === 0 && !result.truncated && !result.stopReason && Array.isArray(observations) && observations.length === validationCases.length;
        const checks = validationCases.map((item, index) => ({ name: item.name, passed: Boolean(validEnvelope && isDeepStrictEqual(observations[index], item.expected)),
          expected: item.expected, actual: validEnvelope ? observations[index] : null }));
        version.check = { passed: checks.every(item => item.passed), checks, manifestHash: validationManifest.hash };
        if (version.check.passed) {
          record.status = 'executed'; event('真实文件修改和固定业务检查完成；尚未经过独立 Review 或软件交付验收。');
          break;
        }
        const failed = checks.filter(item => !item.passed);
        feedback = JSON.stringify({ message: '固定检查未通过，请修复指定模块。', exitCode: result.exitCode,
          failed: failed.map(item => ({ name: item.name, expected: item.expected, actual: JSON.stringify(item.actual).slice(0, 1024) })) });
        event(`固定检查未通过，退出码 ${result.exitCode}：${failed.map(item => item.name).join('、')}。`); await save();
        if (attempt === maxCalls) throw new Error('业务检查未通过，已达到修改次数预算。');
      }
    } catch (error) {
      if (error?.reconciliationRequired) record.status = 'reconciliation_required';
      if (record.status !== 'reconciliation_required') record.status = controller.signal.aborted ? (deadline ? 'timed_out' : 'stopped') : 'failed';
      record.error = controller.signal.aborted ? (deadline ? '执行超时，已停止后续工作。' : '已停止执行。') : (error instanceof Error ? error.message : '执行失败。');
      event(record.error);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (!TERMINAL.has(record.status)) { record.status = 'failed'; record.error = '执行未得到可信结果。'; }
      record.finishedAt = new Date().toISOString();
      await save();
    }
    return record;
  })();
  return { id: record.id, cancel, done };
}
