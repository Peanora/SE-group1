import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findRuntime } from '../scripts/start-local.mjs';

test('启动检测验证实际SQLite能力，显式配置无效时明确拒绝', () => {
  const runtime = findRuntime({ TASKFLOW_NODE: process.execPath });
  assert.equal(runtime.executable, process.execPath);
  assert.throws(() => findRuntime({ TASKFLOW_NODE: path.join(os.tmpdir(), 'taskflow-nonexistent-node.exe') }), /TASKFLOW_NODE/);
  const checked = spawnSync(runtime.executable, ['scripts/start-local.mjs', '--check-runtime'], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).executable, runtime.executable);
});

test('检测选定的运行环境实际启动临时工作台并正常关闭，不调用模型', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-start-'));
  try {
    const runtime = findRuntime({ TASKFLOW_NODE: process.execPath });
    const script = "const {startServer}=await import('./server.mjs');const app=await startServer({loadEnv:false,dataDir:process.env.DATA_DIR,port:0});try{const r=await fetch(app.url+'/api/health');if(!r.ok||!(await r.json()).ok)throw Error('health failed');console.log('START_STOP_OK')}finally{await app.close()}";
    const result = spawnSync(runtime.executable, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DATA_DIR: directory } });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /START_STOP_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
