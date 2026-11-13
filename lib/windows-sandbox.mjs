import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { minimalEnv, runProcess } from './managed-process.mjs';

const probeSource = `const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const r={};fs.writeFileSync('marker','probe');r.insideWrite=fs.readFileSync('marker','utf8')==='probe';
try{fs.readFileSync(path.resolve('..','sentinel'));r.outsideReadDenied=false}catch(e){r.outsideReadDenied=['EPERM','EACCES'].includes(e.code)}
try{fs.writeFileSync(path.resolve('..','outside-write'),'probe');r.outsideWriteDenied=false}catch(e){r.outsideWriteDenied=['EPERM','EACCES'].includes(e.code)}
const s=net.connect({host:'1.1.1.1',port:80});let done=false;
function end(denied){if(done)return;done=true;s.destroy();r.networkDenied=denied;console.log(JSON.stringify(r));process.exitCode=Object.values(r).every(Boolean)?0:1}
s.on('connect',()=>end(false));s.on('error',e=>end(['EPERM','EACCES'].includes(e.code)));s.setTimeout(1500,()=>end(false));`;

function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

async function checkedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('执行工作区必须是绝对路径。');
  const resolved = path.resolve(directory), canonical = await realpath(resolved);
  if (!samePath(canonical, resolved) || !(await lstat(resolved)).isDirectory()) throw new Error('执行工作区不可使用目录链接。');
  return canonical;
}

/** Native Windows execution fails closed; this adapter never installs or configures a sandbox. */
export function createWindowsSandbox({ executable = process.env.EXECUTION_SANDBOX_EXE, nodeExecutable = process.execPath } = {}) {
  const verified = new Set();
  const checkExecutable = async () => {
    if (process.platform !== 'win32') throw new Error('当前执行器需要 Windows MXC 受限环境。');
    if (!executable || !path.isAbsolute(executable) || !path.isAbsolute(nodeExecutable)) throw new Error('请配置已安装的 Windows MXC 执行程序。');
    try { await access(executable); await access(nodeExecutable); }
    catch { throw new Error('Windows MXC 执行程序不可用。'); }
  };
  const execute = async ({ workspace, runnerFile, input = '', signal, timeoutMs, maxOutputBytes, writable = false }) => {
    const control = await mkdtemp(path.join(os.tmpdir(), 'task-sandbox-control-'));
    const platformRoot = path.join(workspace, '.platform'), temp = path.join(platformRoot, 'tmp');
    let result;
    try {
      await mkdir(platformRoot, { recursive: true });
      if (!samePath(await realpath(platformRoot), platformRoot)) throw new Error('平台验证目录不可使用目录链接。');
      await mkdir(temp, { recursive: true });
      if (!samePath(await realpath(temp), temp)) throw new Error('验证临时目录不可使用目录链接。');
      const env = minimalEnv({ CODEX_HOME: control, TEMP: temp, TMP: temp });
      const filesystem = `permissions.taskflow.filesystem={ ":minimal"="read", ":workspace_roots"={ "."="${writable ? 'write' : 'read'}", ".platform/tmp"="write" } }`;
      result = await runProcess(executable, ['sandbox', '-P', 'taskflow', '-C', workspace,
        '-c', 'windows.sandbox="mxc"', '-c', filesystem, '-c', 'permissions.taskflow.network.enabled=false',
        nodeExecutable, '--experimental-vm-modules', '--preserve-symlinks', '--preserve-symlinks-main', runnerFile],
      { cwd: workspace, env, input, signal, timeoutMs, maxOutputBytes });
      result.controlDirectory = control;
      return result;
    } finally {
      // An unconfirmed process may still need its control directory. Cleanup must
      // neither destroy reconciliation evidence nor mask the actual stop result.
      if (!result || result.terminationConfirmed === true) {
        try {
          const parent = await realpath(os.tmpdir()), canonical = await realpath(control), relative = path.relative(parent, canonical);
          if (!relative || path.isAbsolute(relative) || relative.startsWith('..') || !path.basename(canonical).startsWith('task-sandbox-control-')) throw new Error('unsafe cleanup');
          await rm(canonical, { recursive: true, force: true });
          if (result) result.controlDirectory = null;
        } catch { if (result) result.cleanupError = '控制目录清理未确认，保留路径供核对。'; }
      }
    }
  };
  return {
    async preflight({ workspace, signal } = {}) {
      await checkExecutable();
      workspace = await checkedDirectory(workspace);
      const version = await runProcess(executable, ['--version'], { signal });
      if (!version.terminationConfirmed) throw Object.assign(new Error('预检进程停止尚未确认。'), { reconciliationRequired: true, result: version });
      if (version.exitCode !== 0 || version.stopReason || !/codex-cli\s+\S+/u.test(version.stdout)) throw new Error('Windows MXC 执行器版本检查失败。');
      const probe = await mkdtemp(path.join(path.dirname(workspace), '.task-sandbox-probe-'));
      let probeResult, environment, probeError;
      try {
        const inner = path.join(probe, 'workspace');
        await mkdir(inner);
        await writeFile(path.join(probe, 'sentinel'), 'public sandbox probe');
        await writeFile(path.join(inner, 'probe.cjs'), probeSource);
        const result = probeResult = await execute({ workspace: inner, runnerFile: path.join(inner, 'probe.cjs'), signal, timeoutMs: 10_000, maxOutputBytes: 16_384, writable: true });
        if (!result.terminationConfirmed) throw Object.assign(new Error('预检进程停止尚未确认。'), { reconciliationRequired: true, result });
        let evidence;
        try { evidence = JSON.parse(result.stdout.trim()); } catch {}
        if (result.exitCode !== 0 || result.stopReason || !result.terminationConfirmed
          || !evidence?.insideWrite || !evidence?.outsideReadDenied || !evidence?.outsideWriteDenied || !evidence?.networkDenied) {
          throw new Error('Windows MXC 隔离自检未通过，执行已拒绝。');
        }
        verified.add(workspace);
        environment = { kind: 'windows-mxc', version: version.stdout.trim(), evidence };
        return environment;
      } catch (cause) {
        probeError = cause;
        if (cause?.reconciliationRequired || probeResult?.terminationConfirmed === false) {
          cause.probeDirectory = probe;
          if (probeResult) probeResult.probeDirectory = probe;
        }
        throw cause;
      } finally {
        // A live or unconfirmed probe keeps its workspace for later coordination.
        // Cleanup failure must not replace its process identity or stop evidence.
        if (!probeError?.reconciliationRequired && probeResult?.terminationConfirmed !== false) {
          try {
            const parent = await realpath(path.dirname(workspace)), canonical = await realpath(probe), relative = path.relative(parent, canonical);
            if (!relative || path.isAbsolute(relative) || relative.startsWith('..') || !path.basename(canonical).startsWith('.task-sandbox-probe-')) throw new Error('unsafe cleanup');
            await rm(canonical, { recursive: true, force: true });
          } catch {
            const evidence = probeError ?? environment;
            if (evidence) { evidence.probeDirectory = probe; evidence.cleanupError = '预检目录清理未确认，保留路径供核对。'; }
          }
        }
      }
    },
    async run({ workspace, runnerFile, input = '', signal, timeoutMs = 10_000, maxOutputBytes = 65_536 } = {}) {
      await checkExecutable();
      workspace = await checkedDirectory(workspace);
      if (!verified.has(workspace)) throw new Error('请先完成当前工作区的隔离自检。');
      const expected = path.join(workspace, '.platform', 'runner.cjs');
      if (!samePath(path.resolve(runnerFile || ''), expected)
        || !samePath(await realpath(expected), expected) || !(await lstat(expected)).isFile()) throw new Error('仅允许平台固定的验证入口。');
      await readFile(expected); // Fail before launch if the trusted runner has disappeared.
      return execute({ workspace, runnerFile: expected, input, signal, timeoutMs, maxOutputBytes });
    },
  };
}
