import path from 'node:path';
import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { borrowingProfile, validationCases, validationManifest, runnerSource, hash } from './execution-profile.mjs';

const MAX_SOURCE_BYTES = 32_768;
const MAX_OUTPUT_BYTES = 65_536;
class TestServiceError extends Error {}
const reject = message => { throw new TestServiceError(message); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function checkedParents(directory) {
  for (let current = directory;; current = path.dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) reject('独立测试目录的父链不可使用链接。');
    if (path.dirname(current) === current) break;
  }
}

async function checkedFile(file, expectedHash) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !samePath(await realpath(file), file)
    || hash(await readFile(file, 'utf8')) !== expectedHash) reject('独立测试快照或平台观察器发生变化。');
}

/** Re-execute platform-owned checks in a fresh snapshot. No self-check result is accepted. */
export async function runIndependentTests({ workspace, source, sourceHash, sandbox, signal, timeoutMs = 15_000 } = {}) {
  const result = { status: 'error', sourceHash: null, manifestHash: validationManifest.hash,
    runnerHash: validationManifest.runnerHash, checks: [], command: null, environment: null, error: null };
  const cancelled = () => {
    result.status = 'cancelled'; result.error = '独立测试已取消，未发布通过结论。'; return result;
  };
  try {
    if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE_BYTES || typeof sourceHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(sourceHash) || hash(source) !== sourceHash) reject('独立测试源码或内容标识无效。');
    result.sourceHash = sourceHash;
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) reject('独立测试工作区或时长预算无效。');
    if (typeof sandbox?.preflight !== 'function' || typeof sandbox?.run !== 'function') reject('独立测试缺少受限执行适配器。');
    if (signal?.aborted) return cancelled();
    workspace = path.resolve(workspace);
    await checkedParents(path.dirname(workspace));
    try { await mkdir(workspace); } catch (error) {
      if (error.code === 'EEXIST') reject('独立测试工作区必须是尚不存在的新目录。');
      throw error;
    }
    const sourceFile = path.join(workspace, borrowingProfile.writableFile);
    const runnerFile = path.join(workspace, '.platform', 'runner.cjs');
    await mkdir(path.dirname(sourceFile));
    await mkdir(path.dirname(runnerFile));
    await mkdir(path.join(workspace, '.platform', 'tmp'));
    await writeFile(sourceFile, source, { flag: 'wx', mode: 0o600 });
    await writeFile(runnerFile, runnerSource, { flag: 'wx', mode: 0o600 });
    const checkSnapshot = async () => {
      await checkedParents(path.dirname(sourceFile));
      await checkedParents(path.dirname(runnerFile));
      await checkedFile(sourceFile, sourceHash);
      await checkedFile(runnerFile, validationManifest.runnerHash);
    };
    await checkSnapshot();
    result.environment = await sandbox.preflight({ workspace, signal });
    if (signal?.aborted) return cancelled();
    await checkSnapshot();
    const command = await sandbox.run({ workspace, runnerFile, signal, timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES,
      input: JSON.stringify(validationCases.map(({ name, expected, ...input }) => input)) });
    result.command = command;
    if (command?.terminationConfirmed !== true) {
      result.status = 'reconciliation_required'; result.error = '独立测试进程停止尚未确认。'; return result;
    }
    await checkSnapshot();
    if (signal?.aborted || command.stopReason === 'cancelled') return cancelled();
    let observations;
    const boundedOutput = typeof command.stdout === 'string' && typeof command.stderr === 'string'
      && Buffer.byteLength(command.stdout) + Buffer.byteLength(command.stderr) <= MAX_OUTPUT_BYTES;
    try { observations = boundedOutput ? JSON.parse(command.stdout) : null; } catch { observations = null; }
    const validEnvelope = command.exitCode === 0 && command.stopReason === null && command.truncated === false
      && boundedOutput && Array.isArray(observations) && observations.length === validationCases.length;
    result.checks = validationCases.map((item, index) => ({ name: item.name, expected: item.expected,
      actual: validEnvelope ? observations[index] : null,
      passed: Boolean(validEnvelope && isDeepStrictEqual(observations[index], item.expected)) }));
    result.status = result.checks.every(item => item.passed) ? 'passed' : 'failed';
    if (result.status === 'failed') result.error = command.stopReason === 'timeout' ? '独立测试命令超时。'
      : command.truncated || !boundedOutput || command.stopReason === 'output_limit' ? '独立测试输出无效或超过预算。' : '独立业务检查未通过。';
  } catch (error) {
    if (error?.reconciliationRequired) {
      result.status = 'reconciliation_required'; result.error = '独立测试进程停止尚未确认。';
    } else if (signal?.aborted) return cancelled();
    else { result.status = 'error'; result.error = error instanceof TestServiceError ? error.message : '独立测试执行失败，未发布通过结论。'; }
  }
  return result;
}
