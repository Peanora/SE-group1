// Keep this bootstrap compatible with Node.js 16, so an old PATH can be repaired
// before importing any application module that depends on node:sqlite.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<21))process.exit(1);if(typeof require('node:sqlite').DatabaseSync!=='function')process.exit(2);process.stdout.write(process.versions.node)";

export function findRuntime(env = process.env) {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = env.TASKFLOW_NODE ? [env.TASKFLOW_NODE] : [
    process.execPath, path.join(root, '.runtime', name),
    ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), name)),
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', name),
  ];
  for (const executable of new Set(candidates)) {
    if (!path.isAbsolute(executable) || !existsSync(executable)) continue;
    const result = spawnSync(executable, ['-e', probe], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (result.status === 0 && /^\d+\.\d+\.\d+$/.test(result.stdout || '')) return { executable, version: result.stdout };
  }
  throw new Error(env.TASKFLOW_NODE
    ? 'TASKFLOW_NODE must point to a working Node.js >=22.21.0 with node:sqlite. Check this setting or remove it.'
    : 'Node.js >=22.21.0 with node:sqlite is required. Install a supported version or set TASKFLOW_NODE to its absolute node executable path.');
}

export function main(args = process.argv.slice(2)) {
  const runtime = findRuntime();
  if (args.includes('--check-runtime')) { console.log(JSON.stringify(runtime)); return 0; }
  const env = { ...process.env, PATH: `${path.dirname(runtime.executable)}${path.delimiter}${process.env.PATH || process.env.Path || ''}` };
  const run = (file, ...args) => {
    const result = spawnSync(runtime.executable, [file, ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    return result.status === null ? 1 : result.status;
  };
  console.log(`[Taskflow] Node.js ${runtime.version}: ${runtime.executable}`);
  if (!existsSync(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    throw new Error('前端构建依赖缺失。请在项目目录运行 npm ci --ignore-scripts。');
  }
  const frontendCode = run('node_modules/vite/bin/vite.js', 'build');
  if (frontendCode !== 0) return frontendCode;
  if (args.includes('--demo')) {
    env.DATA_DIR = path.join(root, 'output', 'simulation-demo-data'); env.PORT = '4320';
    const hasDemo = existsSync(env.DATA_DIR) && readdirSync(env.DATA_DIR).some(name => /^[0-9a-f-]{36}\.json$/.test(name));
    if (!hasDemo) { const code = run('scripts/create-simulation-demo.mjs'); if (code !== 0) return code; }
    console.log('[Taskflow] Simulation demo: http://127.0.0.1:4320');
  }
  return run('server.mjs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`[Taskflow] ${error.message}`); process.exitCode = 1; }
}
