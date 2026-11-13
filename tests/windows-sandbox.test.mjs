import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsSandbox } from '../lib/windows-sandbox.mjs';

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
