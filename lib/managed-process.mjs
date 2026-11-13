import { spawn } from 'node:child_process';
import path from 'node:path';

const systemKeys = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'];
const extraKeys = new Set([...systemKeys, 'PATH', 'CODEX_HOME']);

/** Construct an environment without model credentials or language/runtime hooks. */
export function minimalEnv(extra = {}) {
  const env = {};
  for (const key of systemKeys) if (process.env[key]) env[key] = process.env[key];
  env.PATH = process.platform === 'win32'
    ? [path.dirname(process.execPath), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';')
    : '/usr/bin:/bin';
  for (const [key, value] of Object.entries(extra)) {
    if (!extraKeys.has(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('执行环境配置无效。');
    env[key] = value;
  }
  return env;
}

export function runProcess(command, args, {
  cwd, env = minimalEnv(), input = '', signal, timeoutMs = 10_000, maxOutputBytes = 65_536,
} = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args)
    || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    return Promise.reject(new Error('执行进程参数无效。'));
  }
  const started = Date.now();
  const empty = { exitCode: null, signal: null, stdout: '', stderr: '', truncated: false,
    terminationConfirmed: true, stopReason: 'cancelled', durationMs: 0 };
  if (signal?.aborted) return Promise.resolve(empty);
  return new Promise((resolve, reject) => {
    let child, timeout, forceTimer, confirmationTimer, settled = false, stopReason = null;
    let bytes = 0, truncated = false;
    const stdout = [], stderr = [];
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(forceTimer); clearTimeout(confirmationTimer);
      signal?.removeEventListener('abort', cancel);
    };
    const finish = (exitCode, exitSignal, confirmed) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ exitCode, signal: exitSignal, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), truncated, terminationConfirmed: confirmed,
        stopReason, durationMs: Date.now() - started });
    };
    const kill = () => {
      if (!child?.pid || settled) return;
      if (process.platform === 'win32') {
        const killer = spawn(path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, env: minimalEnv(), stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch {} });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 200);
      }
    };
    const stop = reason => {
      if (stopReason || settled) return;
      stopReason = reason; kill();
      confirmationTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref();
        finish(null, null, false);
      }, 5000);
    };
    const cancel = () => stop('cancelled');
    const capture = (target, chunk) => {
      const buffer = Buffer.from(chunk), remaining = Math.max(0, maxOutputBytes - bytes);
      if (remaining) target.push(buffer.subarray(0, remaining));
      bytes += buffer.length;
      if (bytes > maxOutputBytes) { truncated = true; stop('output_limit'); }
    };
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { settled = true; reject(new Error('无法启动执行进程。')); return; }
    child.on('error', () => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error('无法启动执行进程。'));
    });
    child.on('close', (code, exitSignal) => finish(code, exitSignal, true));
    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    child.stdin.on('error', () => {});
    signal?.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => stop('timeout'), timeoutMs);
    if (signal?.aborted) cancel();
    else child.stdin.end(input);
  });
}
