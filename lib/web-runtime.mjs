import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { createWindowsSandbox } from './windows-sandbox.mjs';
import { minimalEnv } from './managed-process.mjs';
import { decodeWebResponse, MAX_WEB_BODY, normalizeWebRequest, WEB_CSP, WebLineDecoder, WebRuntimeError } from './web-protocol.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const error = (code, message, status) => new WebRuntimeError(code, message, status);
const fail = (code, message, status) => { throw error(code, message, status); };
const QUEUE_LIMIT = 32;
const CLOSE_GRACE_MS = 500;
const STOP_CONFIRM_MS = 5000;

// Cookies are shared by hostname across ports. Only the HTTP boundary knows this
// per-runtime namespace; the candidate and trusted request() API retain app_* names.
function browserRequestHeaders(headers, namespace) {
  const forwarded = { ...headers };
  delete forwarded.cookie;
  if (typeof headers.cookie === 'string') {
    const cookies = headers.cookie.split(';').map(item => item.trim()).filter(item => item.startsWith(namespace))
      .map(item => item.slice(namespace.length));
    if (cookies.length) forwarded.cookie = cookies.join('; ');
  }
  return forwarded;
}

function browserResponseHeaders(headers, namespace) {
  const forwarded = { ...headers };
  if (headers['set-cookie']) forwarded['set-cookie'] = headers['set-cookie'].map(cookie => `${namespace}${cookie.trimStart()}`);
  return forwarded;
}

function readHttpBody(incoming, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer); incoming.removeListener('data', data); incoming.removeListener('end', end);
      incoming.removeListener('aborted', aborted); incoming.removeListener('error', aborted);
      incoming.once('error', () => {});
    };
    const finish = (cause, value) => {
      if (settled) return;
      settled = true; cleanup();
      if (cause) { incoming.pause(); reject(cause); } else resolve(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_WEB_BODY) finish(error('body_limit', '请求正文不能超过 256 KiB。', 413));
      else chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks));
    const aborted = () => finish(error('request_aborted', 'HTTP 请求已中断。', 400));
    const timer = setTimeout(() => finish(error('request_timeout', 'HTTP 请求正文超时。', 408)), timeoutMs);
    incoming.on('data', data); incoming.once('end', end); incoming.once('aborted', aborted);
    incoming.on('error', aborted);
  });
}

async function checkedDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) fail('invalid_workspace', '工作区及其父目录不可使用目录链接。');
}

async function checkedParents(directory) {
  for (let current = directory;; current = path.dirname(current)) {
    await checkedDirectory(current);
    if (path.dirname(current) === current) break;
  }
}

async function ensureDirectory(directory) {
  try { await mkdir(directory); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  await checkedDirectory(directory);
}

async function checkedFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !samePath(await realpath(filename), filename)) {
    fail('invalid_workspace', '源码与平台文件必须为无链接的普通文件。');
  }
  return info;
}

/** Git metadata and runtime data are not candidate source. All other files and directories are bound. */
async function sourceSnapshot(workspace) {
  let bytes = 0, count = 0;
  const entries = [];
  const visit = async relative => {
    const directory = path.join(workspace, relative);
    await checkedDirectory(directory);
    for (const name of (await readdir(directory)).sort()) {
      const item = relative ? `${relative}/${name}` : name;
      if (item === '.git' || item === '.platform/tmp') continue;
      if (++count > 10_000) fail('source_limit', '源码文件数量超过运行限制。');
      const filename = path.join(workspace, item);
      const info = await lstat(filename);
      if (info.isDirectory()) { entries.push([item, 'directory']); await visit(item); }
      else {
        await checkedFile(filename);
        bytes += info.size;
        if (bytes > 64 * 1024 * 1024) fail('source_limit', '源码总大小超过运行限制。');
        entries.push([item, hash(await readFile(filename))]);
      }
    }
  };
  await visit('');
  return { hash: hash(JSON.stringify(entries)), files: count, bytes };
}

function validateOptions({ workspace, executable, nodeExecutable, signal, timeoutMs, requestTimeoutMs, maxOutputBytes, onEvent }) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')) fail('invalid_workspace', '运行工作区必须是绝对路径。');
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')
    || typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable) || nodeExecutable.includes('\0')) fail('invalid_executable', '请配置绝对路径的 Windows MXC 执行程序。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 4 * 1024 * 1024) fail('invalid_budget', '运行预算无效。');
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid_signal', '停止信号无效。');
  if (typeof onEvent !== 'function') fail('invalid_observer', '事件观察器无效。');
  if (process.platform !== 'win32') fail('unsupported_environment', 'Web 运行器需要 Windows MXC 环境。');
}

/** Trusted server API. There is no injectable command, environment, network target or passed flag. */
export async function startWebRuntime({ workspace, executable = process.env.EXECUTION_SANDBOX_EXE, nodeExecutable = process.execPath,
  signal, timeoutMs = 180_000, requestTimeoutMs = 10_000, maxOutputBytes = 262_144, onEvent = () => {} } = {}) {
  validateOptions({ workspace, executable, nodeExecutable, signal, timeoutMs, requestTimeoutMs, maxOutputBytes, onEvent });
  if (signal?.aborted) fail('cancelled', '运行已取消。', 503);
  workspace = path.resolve(workspace);
  await checkedParents(workspace);
  await access(executable); await access(nodeExecutable);
  const appFile = path.join(workspace, 'src', 'app.mjs');
  await checkedParents(path.dirname(appFile)); await checkedFile(appFile);
  const platform = path.join(workspace, '.platform'), temporary = path.join(platform, 'tmp');
  await ensureDirectory(platform); await ensureDirectory(temporary);
  const databasePath = path.join(temporary, 'app.sqlite');
  try { await checkedFile(databasePath); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const workerFile = path.join(platform, 'web-worker.cjs');
  const workerSource = await readFile(new URL('./web-worker.cjs', import.meta.url));
  try {
    await checkedFile(workerFile);
    if (hash(await readFile(workerFile)) !== hash(workerSource)) fail('invalid_worker', '工作区包含非平台提供的 Web worker。');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    await writeFile(workerFile, workerSource, { flag: 'wx', mode: 0o400 });
    await checkedFile(workerFile);
  }
  const snapshot = await sourceSnapshot(workspace);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const started = Date.now(), startedAt = new Date(started).toISOString();
  let deadlineTimer, control, child, server, active = null, processing = false, queue = [], ready = false;
  let stopReason = null, failure = null, finalized = false, exited = false, stopAck = false, terminationRequested = false;
  let outputBytes = 0, stdoutBytes = 0, stderrBytes = 0, stderr = '', forceTimer, confirmationTimer;
  let finishResolve, readyResolve, readyReject;
  const done = new Promise(resolve => { finishResolve = resolve; });
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Attach now: cancellation can settle startup before the caller begins awaiting it.
  readyPromise.catch(() => {});
  const event = (type, details = {}) => { try { onEvent({ type, time: new Date().toISOString(), ...details }); } catch { /* Observers cannot change runtime state. */ } };
  const currentError = () => failure ?? error(stopReason === 'timed_out' ? 'timed_out' : stopReason === 'cancelled' ? 'cancelled' : 'stopped', '应用运行已停止。', 503);
  const checkSnapshot = async () => {
    if ((await sourceSnapshot(workspace)).hash !== snapshot.hash || hash(await readFile(workerFile)) !== hash(workerSource)) {
      fail('source_changed', '运行期间源码或平台 worker 已变化。', 503);
    }
  };
  const rejectWork = cause => {
    if (active) { clearTimeout(active.timer); active.reject(cause); active = null; }
    for (const item of queue) { clearTimeout(item.timer); item.reject(cause); }
    queue = [];
  };
  const closeProxy = () => {
    if (!server) return;
    server.close(() => {});
    server.closeAllConnections();
  };
  const finalize = async (exitCode, exitSignal, confirmed) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(deadlineTimer); clearTimeout(forceTimer); clearTimeout(confirmationTimer);
    signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelled);
    if (!stopReason) { stopReason = 'unexpected_exit'; failure ??= error('unexpected_exit', '应用进程意外退出。', 503); }
    rejectWork(currentError()); readyReject(currentError()); closeProxy();
    let sourceUnchanged = false;
    try { await checkSnapshot(); sourceUnchanged = true; }
    catch { failure ??= error('source_changed', '运行结束时源码或平台 worker 校验失败。', 503); }
    let controlDirectory = control ?? null;
    if (control && confirmed) {
      try {
        const parent = await realpath(os.tmpdir()), canonical = await realpath(control), relative = path.relative(parent, canonical);
        if (!path.isAbsolute(relative) && !relative.startsWith('..') && path.basename(canonical).startsWith('taskflow-web-control-')) {
          await rm(canonical, { recursive: true, force: true }); controlDirectory = null;
        }
      } catch { /* Preserve a failed cleanup path for reconciliation. */ }
    }
    const result = {
      status: !confirmed ? 'reconciliation_required' : !sourceUnchanged || failure ? (stopReason === 'timed_out' || stopReason === 'request_timeout' ? 'timed_out' : 'failed')
        : stopReason === 'timed_out' || stopReason === 'request_timeout' ? 'timed_out' : 'stopped',
      stopReason, terminationConfirmed: confirmed, exitCode, signal: exitSignal, stopAcknowledged: stopAck,
      pid: child?.pid ?? null, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
      stdoutBytes, stderrBytes, stderr, sourceHash: snapshot.hash, sourceUnchanged, workerHash: hash(workerSource),
      error: failure?.message ?? null, errorCode: failure?.code ?? null, controlDirectory,
    };
    event('closed', { status: result.status, terminationConfirmed: confirmed }); finishResolve(result);
  };
  const killTree = () => {
    if (!child?.pid || exited || finalized) return;
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, env: minimalEnv(), stdio: 'ignore',
    });
    killer.on('error', () => { try { child.kill(); } catch { /* Stop confirmation remains required. */ } });
    confirmationTimer = setTimeout(() => {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      void finalize(null, null, false);
    }, STOP_CONFIRM_MS);
  };
  const stop = (reason = 'stopped', cause = null, graceful = true) => {
    if (!stopReason) {
      stopReason = reason; failure = cause; rejectWork(currentError()); readyReject(currentError()); closeProxy();
      event('stopping', { reason });
    }
    // A stop request may precede process creation. Repeated stop calls must still
    // terminate a child that became available later, without scheduling two kills.
    if (child && !exited && !finalized && !terminationRequested) {
      terminationRequested = true;
      if (graceful && ready) {
        child.stdin.end(`${JSON.stringify({ type: 'stop' })}\n`);
        forceTimer = setTimeout(killTree, CLOSE_GRACE_MS);
      } else killTree();
    }
    return done;
  };
  function cancelled() { void stop('cancelled', null); }
  controller.signal.addEventListener('abort', cancelled, { once: true });
  const fatal = cause => { void stop(cause.code === 'request_timeout' ? 'request_timeout' : 'protocol_error', cause, false); };
  const pump = async () => {
    if (processing || active || stopReason || !ready || !queue.length) return;
    processing = true;
    const item = queue.shift();
    active = item;
    try {
      await checkSnapshot();
      if (stopReason || active !== item) { item.reject(currentError()); return; }
      item.sent = true;
      child.stdin.write(`${JSON.stringify({ type: 'request', id: item.id, request: item.request })}\n`);
    } catch (cause) { item.reject(cause); fatal(cause); }
    finally { processing = false; }
  };
  const request = input => {
    let normalized;
    try { normalized = normalizeWebRequest(input); } catch (cause) { return Promise.reject(cause); }
    if (stopReason || !ready) return Promise.reject(currentError());
    if (queue.length + (active ? 1 : 0) >= QUEUE_LIMIT) return Promise.reject(error('queue_limit', '应用请求队列已满。', 429));
    return new Promise((resolve, reject) => {
      const item = { id: randomUUID(), request: normalized, resolve, reject, timer: null, sent: false };
      item.timer = setTimeout(() => {
        const cause = error('request_timeout', '应用请求超时。', 504);
        if (active === item) fatal(cause);
        else {
          const index = queue.indexOf(item);
          if (index >= 0) { queue.splice(index, 1); item.reject(cause); event('request_timeout', { phase: 'queued' }); }
        }
      }, requestTimeoutMs);
      queue.push(item); void pump();
    });
  };
  const receive = message => {
    if (message.type === 'ready' && Object.keys(message).length === 1 && !ready && !stopReason) { ready = true; readyResolve(); return; }
    if (message.type === 'stopped' && Object.keys(message).length === 1 && stopReason && !stopAck) { stopAck = true; return; }
    if (message.type !== 'response' || Object.keys(message).sort().join(',') !== 'id,response,type' || !ready || stopReason
      || !active || !active.sent || message.id !== active.id || active.responding) fail('protocol_error', '应用消息类型、阶段或请求编号无效。', 502);
    const response = decodeWebResponse(message.response);
    const item = active; item.responding = true;
    void (async () => {
      try {
        await checkSnapshot();
        if (stopReason || active !== item) return;
        clearTimeout(item.timer); active = null; item.resolve(response); event('response', { status: response.status });
        void pump();
      } catch (cause) { fatal(cause); }
    })();
  };
  const decoder = new WebLineDecoder(receive);
  const capture = (kind, chunk) => {
    if (finalized) return;
    outputBytes += chunk.length;
    if (kind === 'stdout') stdoutBytes += chunk.length; else stderrBytes += chunk.length;
    if (outputBytes > maxOutputBytes) { fatal(error('output_limit', '应用输出超过预算。', 502)); return; }
    if (kind === 'stderr') { stderr += chunk.toString('utf8'); return; }
    try { decoder.push(chunk); } catch (cause) { fatal(cause); }
  };
  try {
    // Record the deadline before aborting preflight, keeping cancellation distinct from elapsed time.
    deadlineTimer = setTimeout(() => { void stop('timed_out', error('timed_out', '应用运行超过总时长预算。', 503), false); controller.abort(); }, timeoutMs);
    const sandbox = createWindowsSandbox({ executable, nodeExecutable });
    const environment = await sandbox.preflight({ workspace, signal: controller.signal });
    await checkSnapshot();
    if (controller.signal.aborted || stopReason) throw currentError();
    control = await mkdtemp(path.join(await realpath(os.tmpdir()), 'taskflow-web-control-'));
    event('prepared', { phase: 'control_directory' });
    // Cancellation can arrive during either filesystem await above. No async gap
    // is allowed between this final admission check and spawning the process.
    if (controller.signal.aborted || stopReason) throw currentError();
    const filesystem = 'permissions.taskflow.filesystem={ ":minimal"="read", ":workspace_roots"={ "."="read", ".platform/tmp"="write" } }';
    child = spawn(executable, ['sandbox', '-P', 'taskflow', '-C', workspace,
      '-c', 'windows.sandbox="mxc"', '-c', filesystem, '-c', 'permissions.taskflow.network.enabled=false',
      nodeExecutable, '--preserve-symlinks', '--preserve-symlinks-main', workerFile], {
      cwd: workspace, env: minimalEnv({ CODEX_HOME: control, TEMP: temporary, TMP: temporary }),
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => capture('stdout', chunk)); child.stderr.on('data', chunk => capture('stderr', chunk));
    child.stdin.on('error', () => { if (!stopReason) fatal(error('stdin_closed', '应用输入通道意外关闭。', 503)); });
    child.on('error', () => { failure ??= error('spawn_failed', '无法启动受限应用进程。', 503); stopReason ??= 'spawn_failed'; void finalize(null, null, true); });
    child.on('close', (code, exitSignal) => {
      exited = true;
      try { decoder.end(); } catch (cause) { failure ??= cause; stopReason ??= 'protocol_error'; }
      if (code !== 0 && !stopReason) failure ??= error('unexpected_exit', '应用进程异常退出。', 503);
      void finalize(code, exitSignal, true);
    });
    event('started', { pid: child.pid, environment: environment.kind });
    let startupTimer;
    try {
      await Promise.race([readyPromise, new Promise((_, reject) => { startupTimer = setTimeout(() => {
        const cause = error('startup_timeout', '应用初始化超时。', 504); void stop('request_timeout', cause, false); reject(cause);
      }, requestTimeoutMs); })]);
    } finally { clearTimeout(startupTimer); }
    await checkSnapshot();
    if (stopReason) throw currentError();
    const cookieNamespace = `tf_${randomBytes(24).toString('hex')}_`;
    let origin, incomingRequests = 0;
    server = http.createServer(async (incoming, response) => {
      response.setHeader('Content-Security-Policy', WEB_CSP); response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('Connection', 'close');
      let admitted = false;
      try {
        if (incomingRequests >= QUEUE_LIMIT) fail('queue_limit', '应用 HTTP 请求队列已满。', 429);
        incomingRequests++; admitted = true;
        if (incoming.headers.host !== new URL(origin).host) fail('invalid_host', '应用 Host 无效。', 403);
        if (incoming.headers.origin !== undefined && incoming.headers.origin !== origin) fail('invalid_origin', '请从当前应用预览发起请求。', 403);
        if (incoming.headers.upgrade || incoming.headers.expect || incoming.headers['transfer-encoding']) fail('unsupported_protocol', '应用预览不支持升级或流式协议。', 400);
        if (Number(incoming.headers['content-length'] ?? 0) > MAX_WEB_BODY) fail('body_limit', '请求正文不能超过 256 KiB。', 413);
        const bytes = await readHttpBody(incoming, requestTimeoutMs);
        let body;
        try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail('invalid_body', '请求正文必须是 UTF-8 文本。', 400); }
        const result = await request({ method: incoming.method, path: incoming.url,
          headers: browserRequestHeaders(incoming.headers, cookieNamespace), body });
        response.writeHead(result.status, { ...browserResponseHeaders(result.headers, cookieNamespace), 'Content-Length': result.body.length });
        response.end(incoming.method === 'HEAD' ? undefined : result.body);
      } catch (cause) {
        if (response.destroyed) return;
        const status = cause instanceof WebRuntimeError ? cause.statusCode : 502;
        const body = Buffer.from(JSON.stringify({ error: cause instanceof WebRuntimeError ? cause.message : '应用请求失败。' }));
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }); response.end(body);
      } finally { if (admitted) incomingRequests--; }
    });
    server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    server.on('connect', (_request, socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'); });
    for (const type of ['checkContinue', 'checkExpectation']) server.on(type, (_request, response) => {
      response.writeHead(417, { Connection: 'close', 'Content-Length': 0 }); response.end();
    });
    server.requestTimeout = requestTimeoutMs; server.headersTimeout = Math.min(10_000, requestTimeoutMs); server.maxHeadersCount = 64;
    server.maxConnections = 64;
    event('proxy_preparing');
    if (stopReason) throw currentError();
    // server.close() may cancel an in-flight listen without invoking its callback.
    // Process shutdown must therefore settle proxy startup as well.
    await Promise.race([
      new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }),
      done.then(() => { throw currentError(); }),
    ]);
    origin = `http://localhost:${server.address().port}`;
    if (stopReason) throw currentError();
    event('ready', { url: origin });
    if (stopReason) throw currentError();
    return { url: origin, request, stop: () => stop(), done, pid: child.pid };
  } catch (cause) {
    if (!child) {
      if (!stopReason) { failure ??= cause; stopReason = controller.signal.aborted ? 'cancelled' : 'preflight_failed'; }
      await finalize(null, null, cause?.reconciliationRequired !== true);
    } else { void stop('startup_failed', cause, false); await done; closeProxy(); }
    const failureResult = await done;
    const thrown = cause instanceof Error ? cause : new Error('Web 运行器启动失败。'); thrown.result = failureResult; throw thrown;
  }
}
