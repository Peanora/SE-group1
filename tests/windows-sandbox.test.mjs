import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWindowsSandbox } from '../lib/windows-sandbox.mjs';

test('unconfirmed sandbox stop preserves the owned control directory and process evidence', { skip: process.platform !== 'win32' }, async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'taskflow-control-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), workspace);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(workspace, { recursive: true, force: true });
  });
  await mkdir(path.join(workspace, '.platform'));
  await writeFile(path.join(workspace, '.platform', 'runner.cjs'), '// trusted mock never executes candidate code');
  const script = `
    import {mock} from 'node:test';
    const moduleUrl=${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)};
    const {minimalEnv}=await import(moduleUrl);
    let calls=0;
    mock.module(moduleUrl,{namedExports:{minimalEnv,runProcess:async()=>{
      calls++;
      const base={exitCode:0,signal:null,stdout:'',stderr:'',truncated:false,terminationConfirmed:true,stopReason:null,pid:424242,startedAt:'2026-01-01T00:00:00.000Z'};
      if(calls===1)return {...base,stdout:'codex-cli mocked'};
      if(calls===2)return {...base,stdout:JSON.stringify({insideWrite:true,outsideReadDenied:true,outsideWriteDenied:true,networkDenied:true})};
      return {...base,exitCode:null,terminationConfirmed:false,stopReason:'timeout'};
    }}});
    const {createWindowsSandbox}=await import(${JSON.stringify(new URL('../lib/windows-sandbox.mjs', import.meta.url).href)});
    const workspace=${JSON.stringify(workspace)};
    const sandbox=createWindowsSandbox({executable:process.execPath});await sandbox.preflight({workspace});
    process.stdout.write(JSON.stringify(await sandbox.run({workspace,runnerFile:workspace+'/.platform/runner.cjs'})));
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('trusted control test timed out')); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)); });
    child.stdin.end(script);
  });
  assert.equal(result.terminationConfirmed, false); assert.equal(result.pid, 424242);
  const relative = path.relative(path.resolve(os.tmpdir()), result.controlDirectory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(result.controlDirectory).startsWith('task-sandbox-control-'));
  assert.deepEqual(await (await import('node:fs/promises')).readdir(result.controlDirectory), []);
  await rm(result.controlDirectory, { recursive: true, force: true });
});

test('unconfigured sandbox fails closed and never falls back to host execution', async () => {
  const sandbox = createWindowsSandbox({ executable: '', nodeExecutable: process.execPath });
  await assert.rejects(sandbox.preflight({ workspace: process.cwd() }), /Windows MXC/);
  await assert.rejects(sandbox.run({ workspace: process.cwd(), runnerFile: 'untrusted-command' }), /Windows MXC/);
});

test('nonexistent sandbox executable fails before running a target', async () => {
  const sandbox = createWindowsSandbox({ executable: process.platform === 'win32' ? 'C:\\nonexistent-taskflow-sandbox.exe' : '/nonexistent-taskflow-sandbox' });
  await assert.rejects(sandbox.preflight({ workspace: process.cwd() }), /Windows MXC/);
});

test('real Windows MXC preserves stdin, rejects writes, and stops its sandboxed process', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1',
}, async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'taskflow-sandbox-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, '.platform'));
  await mkdir(path.join(workspace, 'src'));
  await writeFile(path.join(workspace, 'src', 'borrow.mjs'), 'export const value = 42;');
  const runnerFile = path.join(workspace, '.platform', 'runner.cjs');
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  const sandbox = createWindowsSandbox();
  const preflight = await sandbox.preflight({ workspace });
  assert.ok(Object.values(preflight.evidence).every(Boolean));
  await writeFile(runnerFile, `const fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',async()=>{const r={input:JSON.parse(input),source:fs.readFileSync('source.txt','utf8'),imported:(await import('../src/borrow.mjs')).value};try{fs.writeFileSync('source.txt','changed');r.writeDenied=false}catch(e){r.writeDenied=['EPERM','EACCES'].includes(e.code)}console.log(JSON.stringify(r))});`);
  const result = await sandbox.run({ workspace, runnerFile, input: JSON.stringify({ text: '真实标准输入' }) });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { input: { text: '真实标准输入' }, source: 'source', imported: 42, writeDenied: true });
  assert.equal(await readFile(path.join(workspace, 'source.txt'), 'utf8'), 'source');
  for (const mode of ['timeout', 'cancelled']) {
    const marker = `${mode}.heartbeat`;
    await writeFile(runnerFile, `const fs=require('node:fs');setInterval(()=>fs.appendFileSync('.platform/tmp/${marker}','x'),30);`);
    const controller = new AbortController();
    const timer = mode === 'cancelled' ? setTimeout(() => controller.abort(), 700) : null;
    const stopped = await sandbox.run({ workspace, runnerFile, timeoutMs: mode === 'timeout' ? 700 : 5000, signal: controller.signal });
    clearTimeout(timer);
    assert.equal(stopped.stopReason, mode);
    assert.equal(stopped.terminationConfirmed, true);
    const file = path.join(workspace, '.platform', 'tmp', marker);
    const before = await readFile(file, 'utf8');
    assert.ok(before.length > 0, 'sandboxed process actually started before stopping');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await readFile(file, 'utf8'), before, 'sandboxed process stopped writing after CLI termination');
  }
});
