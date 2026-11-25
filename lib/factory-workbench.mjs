import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './documents.mjs';
import { FACTORY_VERSION } from './factory-release.mjs';
import { runProcess } from './managed-process.mjs';

const WINDOWS = process.platform === 'win32';
const START_TIMEOUT = 10000;
const STOP_TIMEOUT = 5000;
const keys = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
const normalize = value => WINDOWS ? value.toLowerCase() : value;
const samePath = (left, right) => normalize(path.resolve(left)) === normalize(path.resolve(right));

function childEnvironment(source) {
  const values = new Map(Object.entries(source).map(([key, value]) => [normalize(key), value]));
  const env = {};
  for (const key of keys) {
    const value = values.get(normalize(key));
    if (typeof value === 'string' && value && !value.includes('\0')) env[key] = value;
  }
  return env;
}

async function statIfPresent(file) {
  try { return await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function managedDirectory(parent, name) {
  const directory = path.join(parent, name);
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(directory, await realpath(directory))) {
    throw new HttpError(409, '托管 Factory 工作区必须是平台数据目录中的普通目录。');
  }
  return directory;
}

async function emptyEnvironmentFile(workspace) {
  const filename = path.join(workspace, '.env');
  await writeFile(filename, '', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.size !== 0) {
    throw new HttpError(409, '托管 Factory 工作区的 .env 必须是普通空文件。');
  }
}

async function excludePrivateFiles(gitDirectory) {
  const info = await managedDirectory(gitDirectory, 'info');
  const filename = path.join(info, 'exclude');
  const metadata = await statIfPresent(filename);
  if (metadata && (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 65536)) {
    throw new HttpError(409, '托管 Factory 工作区的 Git 排除文件无效。');
  }
  const existing = metadata ? (await readFile(filename, 'utf8')).split(/\r?\n/u) : [];
  const missing = ['/.env', '/.factory/'].filter(line => !existing.includes(line));
  if (missing.length) await appendFile(filename, `\n${missing.join('\n')}\n`);
}

async function assertNoEnvironmentFiles(workspace) {
  let directory = workspace;
  for (;;) {
    if (await statIfPresent(path.join(directory, '.env'))) {
      throw new HttpError(409, '这个仓库或其上级目录含 .env，Factory 会自动加载，不能绑定。');
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function assertStateDirectory(workspace) {
  const directory = path.join(workspace, '.factory');
  const info = await statIfPresent(directory);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(409, 'Factory 状态必须保存在仓库内的普通目录。');
  for (const name of ['config.toml', 'db.sqlite3', 'db.sqlite3-wal', 'db.sqlite3-shm', 'graph.json', 'recipes.toml']) {
    const file = await statIfPresent(path.join(directory, name));
    if (file && (!file.isFile() || file.nlink !== 1)) throw new HttpError(409, 'Factory 状态目录中存在链接或非普通文件。');
  }
}

function launch(binary, cwd, env) {
  const child = spawn(binary, ['start', '--port', '0', '--no-browser'], { cwd, env, shell: false,
    windowsHide: true, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'ignore'] });
  const handle = { child, exited: false, ready: null, done: null };
  let ready, fail;
  handle.ready = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
  handle.done = new Promise(resolve => {
    const finished = () => {
      handle.exited = true;
      fail(new HttpError(503, 'Factory 进程在服务就绪前退出。'));
      resolve();
    };
    child.once('error', finished);
    child.once('close', finished);
  });
  let line = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    const lines = (line + chunk).split('\n');
    line = lines.pop().slice(-1024);
    for (const value of lines) {
      const match = /^Agentic Software Factory running at (http:\/\/127\.0\.0\.1:([1-9]\d{0,4}))\s*$/u.exec(value);
      if (match && Number(match[2]) <= 65535) ready(match[1]);
    }
  });
  return handle;
}

async function terminate(handle, env) {
  if (!handle?.child.pid || handle.exited) return true;
  const { child, done } = handle;
  if (WINDOWS) {
    const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const result = await runProcess(executable, ['/PID', String(child.pid), '/T', '/F'], { env, timeoutMs: STOP_TIMEOUT }).catch(() => null);
    if (result?.exitCode !== 0) return handle.exited;
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([done, delay(300, null, { ref: false })]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  await Promise.race([done, delay(STOP_TIMEOUT, null, { ref: false })]);
  return handle.exited;
}

export function createFactoryWorkbench({ dataDir, binary, env = process.env }) {
  const workspaces = new Map();
  const repositories = new Map();
  const childEnv = childEnvironment(env);
  let closed = false;
  const available = () => typeof binary === 'string' && !binary.includes('\0') && path.isAbsolute(binary) && existsSync(binary);

  function status(projectId) {
    const row = workspaces.get(projectId);
    return { available: available(), state: row?.state ?? 'stopped', url: row?.url ?? null, version: FACTORY_VERSION,
      ...(row?.message ? { message: row.message } : {}) };
  }

  function hasActivity(projectId) {
    const row = workspaces.get(projectId);
    return !!row && (['starting', 'running', 'stopping'].includes(row.state) || row.repositories.size > 0);
  }

  function reserve(row, workspace) {
    const key = normalize(workspace);
    const current = repositories.get(key);
    if (current && current !== row) throw new HttpError(409, '此 Git 仓库已由另一个 Factory 工作区使用。');
    repositories.set(key, row);
    row.repositories.add(key);
  }

  function release(row) {
    for (const key of row.repositories) if (repositories.get(key) === row) repositories.delete(key);
    row.repositories.clear();
  }

  async function command(row, executable, args, cwd, message, exitStatus = 503) {
    const result = await runProcess(executable, args, { cwd, env: childEnv, signal: row.controller.signal, timeoutMs: START_TIMEOUT })
      .catch(() => { throw new HttpError(503, message); });
    if (!result.terminationConfirmed) row.unconfirmed = true;
    if (result.stopReason || !result.terminationConfirmed) throw new HttpError(503, message);
    if (result.exitCode !== 0) throw new HttpError(exitStatus, message);
    return result.stdout.trim();
  }

  const git = (row, args, cwd, message = '无法核对 Factory 工作区的 Git 仓库。', exitStatus) => command(row, 'git', args, cwd, message, exitStatus);

  async function prepare(row, projectId, repositoryPath) {
    await mkdir(dataDir, { recursive: true });
    const dataRoot = await realpath(dataDir);
    const external = repositoryPath !== undefined;
    let workspace;
    if (external) {
      if (typeof repositoryPath !== 'string' || repositoryPath.includes('\0') || !path.isAbsolute(repositoryPath)) {
        throw new HttpError(400, '请提供已授权 Git 仓库的绝对路径。');
      }
      workspace = await realpath(repositoryPath).catch(() => { throw new HttpError(400, '找不到指定的 Git 仓库目录。'); });
      const fromDataRoot = path.relative(dataRoot, workspace);
      if (!(await lstat(workspace)).isDirectory() || samePath(workspace, path.parse(workspace).root)
        || !fromDataRoot || (!fromDataRoot.startsWith(`..${path.sep}`) && fromDataRoot !== '..' && !path.isAbsolute(fromDataRoot))) {
        throw new HttpError(400, '不能把文件系统根目录或 Taskflow 平台数据目录绑定为外部仓库。');
      }
      await assertNoEnvironmentFiles(workspace);
    } else {
      const root = await managedDirectory(dataRoot, 'factory-workspaces');
      workspace = await managedDirectory(root, projectId);
    }
    reserve(row, workspace);
    if (!external) {
      const gitDirectory = path.join(workspace, '.git');
      const existing = await statIfPresent(gitDirectory);
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new HttpError(409, '托管工作区缺少独立 Git 目录。');
      if (!existing) {
        await git(row, ['init', '--initial-branch=main', '--template='], workspace);
        const hooks = await managedDirectory(gitDirectory, 'hooks');
        await git(row, ['config', '--local', 'user.name', 'Taskflow'], workspace);
        await git(row, ['config', '--local', 'user.email', 'taskflow@localhost'], workspace);
        await git(row, ['-c', 'commit.gpgSign=false',
          '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', 'commit', '--allow-empty', '-m', 'Initialize Taskflow Factory workspace'], workspace);
      }
      await excludePrivateFiles(gitDirectory);
      await emptyEnvironmentFile(workspace);
    }
    const top = await git(row, ['rev-parse', '--show-toplevel'], workspace, '请绑定实际存在的 Git 仓库顶层目录。', external ? 400 : 503);
    if (!samePath(await realpath(top), workspace)) throw new HttpError(400, '只能绑定 Git 仓库的顶层目录。');
    const common = await git(row, ['rev-parse', '--path-format=absolute', '--git-common-dir'], workspace);
    reserve(row, await realpath(common));
    await assertStateDirectory(workspace);
    return workspace;
  }

  function stopRow(row) {
    if (row.stopPromise) return row.stopPromise;
    row.state = 'stopping'; row.url = null;
    row.controller.abort();
    row.stopPromise = (async () => {
      if (row.unconfirmed || !await terminate(row.handle, childEnv)) {
        row.state = 'failed'; row.message = '无法确认 Factory 相关进程已停止。';
        throw new HttpError(503, row.message);
      }
      row.state = 'stopped'; row.message = null;
      release(row);
    })().finally(() => { row.stopPromise = null; });
    return row.stopPromise;
  }

  async function start(projectId, { repositoryPath } = {}) {
    if (closed || !available()) throw new HttpError(503, `Factory v${FACTORY_VERSION} 可执行文件尚未配置。`);
    if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/u.test(projectId)) throw new HttpError(400, 'Factory 项目编号无效。');
    if (hasActivity(projectId)) {
      throw new HttpError(409, '此项目已有 Factory 工作区正在启动、运行或停止。');
    }
    const row = { state: 'starting', url: null, message: null, repositories: new Set(), controller: new AbortController() };
    workspaces.set(projectId, row);
    row.pending = (async () => {
      try {
        const workspace = await prepare(row, projectId, repositoryPath);
        const executable = await realpath(binary);
        if (!(await lstat(executable)).isFile()) throw new HttpError(503, 'Factory 可执行文件无效。');
        const version = await command(row, executable, ['--version'], workspace, '无法核对 Factory 版本。');
        if (version !== `factory ${FACTORY_VERSION}`) throw new HttpError(409, `Factory 版本必须是 ${FACTORY_VERSION}。`);
        await command(row, executable, ['init'], workspace, 'Factory 无法初始化此工作区。');
        row.controller.signal.throwIfAborted();
        row.handle = launch(executable, workspace, childEnv);
        const startSignal = AbortSignal.any([row.controller.signal, AbortSignal.timeout(START_TIMEOUT)]);
        const pendingAbort = new Promise((_, reject) => startSignal.addEventListener('abort', () => reject(startSignal.reason), { once: true }));
        const url = await Promise.race([row.handle.ready, pendingAbort]);
        const response = await fetch(`${url}/api/health`, { signal: startSignal, redirect: 'error' });
        if (!response.ok || (await response.json())?.status !== 'ok' || row.handle.exited || closed) {
          throw new HttpError(503, 'Factory 健康检查未通过。');
        }
        row.state = 'running'; row.url = url;
        void row.handle.done.then(() => {
          if (row.state !== 'running') return;
          row.unconfirmed = true;
          row.state = 'failed'; row.url = null; row.message = 'Factory 进程意外退出，子进程的停止情况待核对。';
        });
        return status(projectId);
      } catch (error) {
        const stopped = await terminate(row.handle, childEnv);
        if (stopped && !row.unconfirmed) release(row);
        row.state = 'failed'; row.url = null;
        row.message = stopped && !row.unconfirmed ? (error instanceof HttpError ? error.message : '无法启动 Factory 工作区。') : 'Factory 启动失败，相关进程的停止情况待核对。';
        throw new HttpError(error instanceof HttpError ? error.status : 503, row.message);
      }
    })();
    return row.pending;
  }

  async function stop(projectId) {
    const row = workspaces.get(projectId);
    if (!row || row.state === 'stopped') return status(projectId);
    if (['starting', 'stopping'].includes(row.state)) throw new HttpError(409, 'Factory 工作区正在切换状态，请稍后重试。');
    await stopRow(row);
    return status(projectId);
  }

  async function plan(projectId, { objective } = {}) {
    const row = workspaces.get(projectId);
    if (!row || row.state !== 'running' || row.handle.exited || closed) throw new HttpError(409, '请先启动此项目的 Factory 工作区。');
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 100000 || !objective.isWellFormed() || objective.includes('\0')) {
      throw new HttpError(400, 'Factory 工作流目标必须是 1 至 100000 字的文本。');
    }
    if (row.planning) throw new HttpError(409, '正在提交 Factory 规划，请稍后查看工作流。');
    row.planning = true;
    try {
      const signal = AbortSignal.any([row.controller.signal, AbortSignal.timeout(START_TIMEOUT)]);
      const response = await fetch(`${row.url}/api/runs`, { method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objective: objective.trim() }) });
      if (response.status !== 202) throw new HttpError(409, 'Factory 拒绝创建工作流，请在 Factory 中核对 Agent 配置和状态。');
      const run = await response.json();
      if (!Number.isSafeInteger(run?.id) || run.id < 1 || run.status !== 'planning') throw new Error('invalid Factory response');
      return { id: run.id, status: run.status };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'Factory 工作流结果待核对，请查看 Factory 工作流后再重试。');
    } finally {
      row.planning = false;
    }
  }

  async function close() {
    closed = true;
    const rows = Array.from(workspaces.values());
    for (const row of rows) if (row.state === 'starting') row.controller.abort();
    await Promise.allSettled(rows.map(row => row.pending));
    const results = await Promise.allSettled(rows.filter(row => row.state !== 'stopped').map(stopRow));
    if (results.some(result => result.status === 'rejected')) throw new HttpError(503, '部分 Factory 工作区的停止情况待核对。');
  }

  return { status, hasActivity, start, stop, plan, close };
}
