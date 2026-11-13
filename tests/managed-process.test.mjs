import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { minimalEnv, runProcess } from '../lib/managed-process.mjs';

test('minimal environment does not inherit credentials or runtime hooks', () => {
  const env = minimalEnv();
  for (const key of ['LLM_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT', 'PYTHONPATH']) {
    assert.equal(env[key], undefined);
    assert.throws(() => minimalEnv({ [key]: 'not-allowed' }), /环境配置无效/);
  }
});

test('real process returns stdin, stderr, and nonzero exit without a shell', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdin.on('data',x=>process.stdout.write(x));process.stdin.on('end',()=>{console.error('failure');process.exitCode=7})"], { input: 'literal $(unsafe) & text' });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'literal $(unsafe) & text');
  assert.match(result.stderr, /failure/);
  assert.equal(result.terminationConfirmed, true);
  assert.equal(result.stopReason, null);
});

test('process evidence identifies the actual child and its start time', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  assert.equal(result.pid, Number(result.stdout));
  assert.ok(Number.isInteger(result.pid) && result.pid > 0);
  assert.ok(Number.isFinite(Date.parse(result.startedAt)));
  assert.equal(result.terminationConfirmed, true);
});

test('timeout terminates a real process', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(result.stopReason, 'timeout');
  assert.equal(result.terminationConfirmed, true);
  assert.notEqual(result.exitCode, 0);
});

test('abort before launch performs no write; abort while running confirms termination', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const signal = AbortSignal.abort();
  const before = await runProcess(process.execPath, ['-e', "require('fs').writeFileSync('unexpected','x')"], { cwd: directory, signal });
  assert.equal(before.stopReason, 'cancelled');
  await assert.rejects(readFile(path.join(directory, 'unexpected')), { code: 'ENOENT' });
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const after = await pending;
  assert.equal(after.stopReason, 'cancelled');
  assert.equal(after.terminationConfirmed, true);
});

test('output overflow is bounded and terminates the process', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"], { maxOutputBytes: 128 });
  assert.equal(result.stopReason, 'output_limit');
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 128);
  assert.equal(result.terminationConfirmed, true);
});

test('launch errors do not expose process paths or environment', async () => {
  await assert.rejects(runProcess('missing-command-with-private-details', []), error => error.message === '无法启动执行进程。');
});
