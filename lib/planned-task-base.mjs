import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { installWebShell, verifyWebShell } from './web-delivery.mjs';
import { minimalEnv, runProcess } from './managed-process.mjs';
import { readProjectFiles } from './project-files.mjs';

const seeds = new WeakMap(), keys = ['projectId', 'runId', 'specRevision', 'planRevision'];
const need = value => { if (!value) throw new Error('任务初始Git基础的私有来源无法核对。'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function ownedDirectory(root) {
  need(typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) !== path.parse(root).root);
  const absolute = path.resolve(root); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); await mkdir(current, { recursive: true, mode: 0o700 });
    const info = await lstat(current), actual = await realpath(current);
    need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current));
  }
  return absolute;
}

/** Host-owned empty code base, before a task is leased. No candidate data or model callback is accepted. */
export async function createTaskRunDirectory(rootDir) {
  return mkdtemp(path.join(await ownedDirectory(rootDir), 'task-run-'));
}

export async function createPlannedTaskSeed({ rootDir, binding, signal } = {}) {
  need(binding && ['projectId', 'runId'].every(key => /^[A-Za-z0-9_-]{1,128}$/u.test(binding[key] ?? ''))
    && ['specRevision', 'planRevision'].every(key => /^[a-f0-9]{64}$/u.test(binding[key] ?? '')) && (signal === undefined || signal instanceof AbortSignal));
  const identity = Object.fromEntries(keys.map(key => [key, binding[key]])), commands = [];
  need(!signal?.aborted);
  const workspace = await mkdtemp(path.join(await ownedDirectory(rootDir), 'task-seed-'));
  await installWebShell({ workspace });
  const git = async args => {
    need(!signal?.aborted);
    const result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspace, signal, timeoutMs: 15000, maxOutputBytes: 2 * 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    });
    commands.push({ args, ...result });
    if (result.terminationConfirmed !== true) throw Object.assign(new Error('任务初始Git进程停止尚未确认。'), { reconciliationRequired: true, result, workspace });
    need(!signal?.aborted && result.exitCode === 0 && !result.stopReason && !result.truncated);
    return result.stdout.trim();
  };
  await git(['init', '--quiet']); await git(['add', '--', '.']);
  await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'commit', '--quiet', '-m', 'base: task graph protected runtime']);
  const commit = await git(['rev-parse', 'HEAD']), files = await readProjectFiles(workspace);
  need(files.length === 0 && /^[a-f0-9]{40}$/u.test(commit) && !(await git(['status', '--porcelain', '--untracked-files=all'])));
  const handle = Object.freeze({ kind: 'owned_task_seed', id: randomUUID() });
  seeds.set(handle, { files: Object.freeze([]), provenance: Object.freeze({ ...identity, sourceCommit: commit, sourceWorkspace: workspace, sourceHash: digest(files), shellHash: (await verifyWebShell({ workspace })).hash }), commands });
  return handle;
}

export function assertPlannedTaskSeed(handle, binding) {
  const entry = seeds.get(handle); need(entry && keys.every(key => entry.provenance[key] === binding?.[key]));
  return entry;
}
