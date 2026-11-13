import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { runIndependentTests } from '../lib/independent-tests.mjs';
import { borrowingProfile, runnerSource, validationManifest, hash } from '../lib/execution-profile.mjs';
import { runProcess } from '../lib/managed-process.mjs';
import { createWindowsSandbox } from '../lib/windows-sandbox.mjs';

const good = await readFile(new URL('../examples/library-borrow.fixture.mjs', import.meta.url), 'utf8');
const trustedFixtureSandbox = {
  preflight: async () => ({ kind: 'trusted-test-fixture' }),
  run: ({ workspace, runnerFile, ...options }) => runProcess(process.execPath,
    ['--experimental-vm-modules', '--preserve-symlinks-main', runnerFile], { cwd: workspace, ...options }),
};
async function setup(t, { source = good, sandbox = trustedFixtureSandbox, ...options } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'independent-tests-'));
  t.after(async () => {
    const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('independent-tests-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'test');
  return { root, workspace, options: { workspace, source, sourceHash: hash(source), sandbox, ...options } };
}
const completed = extra => ({ exitCode: 0, signal: null, stdout: '[]', stderr: '', truncated: false,
  terminationConfirmed: true, stopReason: null, durationMs: 1, ...extra });

test('独立测试在全新快照真实执行固定检查，不复用任何编码自检通过状态', async t => {
  let preflights = 0, runs = 0;
  const { workspace, options } = await setup(t, { sandbox: {
    preflight: async data => { preflights++; return trustedFixtureSandbox.preflight(data); },
    run: async data => { runs++; return trustedFixtureSandbox.run(data); },
  } });
  const result = await runIndependentTests({ ...options, passed: false, checks: [], command: completed() });
  assert.equal(preflights, 1); assert.equal(runs, 1);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 13);
  assert.ok(result.checks.every(item => item.passed));
  assert.equal(result.sourceHash, hash(good));
  assert.equal(result.manifestHash, validationManifest.hash);
  assert.equal(result.runnerHash, hash(runnerSource));
  assert.equal(result.command.exitCode, 0);
  assert.equal(await readFile(path.join(workspace, borrowingProfile.writableFile), 'utf8'), good);
});

test('候选业务错误和语法错误均不能被外部passed声明放行', async t => {
  for (const source of ['export function borrowBook() { return {}; }', 'export function {']) {
    const { options } = await setup(t, { source });
    const result = await runIndependentTests({ ...options, passed: true });
    assert.equal(result.status, 'failed');
    assert.ok(result.checks.every(item => !item.passed));
    assert.equal(result.command.exitCode, source.includes('return') ? 0 : 1);
  }
});

test('没有完整观察结果、超时、截断或超限输出均不能成为通过', async t => {
  for (const command of [
    completed({ stdout: '模型称已通过' }), completed({ stdout: '[]' }),
    completed({ stopReason: 'timeout' }), completed({ truncated: true }),
    completed({ stdout: 'x'.repeat(65_537) }),
  ]) {
    const { options } = await setup(t, { sandbox: { preflight: async () => ({}), run: async () => command } });
    const result = await runIndependentTests(options);
    assert.equal(result.status, 'failed');
    assert.equal(result.command, command);
  }
});

test('已取消请求不启动预检；执行中取消也不发布迟到通过', async t => {
  const before = new AbortController(); before.abort();
  let called = false;
  const initial = await setup(t, { signal: before.signal, sandbox: {
    preflight: async () => { called = true; }, run: async () => assert.fail(),
  } });
  assert.equal((await runIndependentTests(initial.options)).status, 'cancelled');
  assert.equal(called, false);
  const during = new AbortController();
  const active = await setup(t, { signal: during.signal, sandbox: {
    preflight: async () => ({}), run: async data => {
      const command = await trustedFixtureSandbox.run(data); during.abort(); return command;
    },
  } });
  const result = await runIndependentTests(active.options);
  assert.equal(result.command.exitCode, 0);
  assert.equal(result.status, 'cancelled');
});

test('实际命令或预检停止未确认时保留待协调，不误报取消完成', async t => {
  for (const inPreflight of [false, true]) {
    const controller = new AbortController();
    const { options } = await setup(t, { signal: controller.signal, sandbox: {
      preflight: async () => {
        if (inPreflight) { controller.abort(); throw Object.assign(new Error('private worker detail'), { reconciliationRequired: true }); }
        return {};
      },
      run: async () => { controller.abort(); return completed({ terminationConfirmed: false }); },
    } });
    const result = await runIndependentTests(options);
    assert.equal(result.status, 'reconciliation_required');
    assert.match(result.error, /停止尚未确认/u);
    assert.doesNotMatch(result.error, /private/u);
  }
});

test('预检及测试前后核对源码和平台runner，变化拒绝通过且保留命令证据', async t => {
  for (const file of ['src/borrow.mjs', '.platform/runner.cjs']) {
    const { workspace, options } = await setup(t, { sandbox: {
      preflight: async () => ({}),
      run: async data => { const command = await trustedFixtureSandbox.run(data); await writeFile(path.join(data.workspace, file), 'changed'); return command; },
    } });
    const result = await runIndependentTests(options);
    assert.equal(result.status, 'error');
    assert.equal(result.command.exitCode, 0);
    assert.match(result.error, /快照或平台观察器发生变化/u);
    assert.equal(await readFile(path.join(workspace, file), 'utf8'), 'changed');
  }
  let ran = false;
  const setupBefore = await setup(t, { sandbox: {
    preflight: async ({ workspace }) => { await writeFile(path.join(workspace, 'src/borrow.mjs'), 'changed'); },
    run: async () => { ran = true; },
  } });
  assert.equal((await runIndependentTests(setupBefore.options)).status, 'error');
  assert.equal(ran, false);
});

test('无保护适配器、哈希不匹配、过大源码或已有目录都明确拒绝', async t => {
  const { workspace, options } = await setup(t);
  assert.equal((await runIndependentTests({ ...options, sandbox: null })).status, 'error');
  assert.equal((await runIndependentTests({ ...options, sourceHash: '0'.repeat(64) })).status, 'error');
  const tooLarge = 'x'.repeat(32_769);
  assert.equal((await runIndependentTests({ ...options, source: tooLarge, sourceHash: hash(tooLarge) })).status, 'error');
  await mkdir(workspace); await writeFile(path.join(workspace, 'keep'), 'untouched');
  assert.equal((await runIndependentTests(options)).status, 'error');
  assert.equal(await readFile(path.join(workspace, 'keep'), 'utf8'), 'untouched');
});

test('父链中的目录链接被拒绝，不向目标目录写入', async t => {
  const { root, options } = await setup(t);
  const target = path.join(root, 'target'); await mkdir(target);
  const link = path.join(root, 'alias');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await runIndependentTests({ ...options, workspace: path.join(link, 'test') });
  assert.equal(result.status, 'error');
  assert.match(result.error, /父链不可使用链接/u);
});

test('受限执行错误不暴露异常正文；从不回退宿主执行', async t => {
  let ran = false;
  const { options } = await setup(t, { sandbox: {
    preflight: async () => { throw new Error('secret-token https://private.example'); },
    run: async () => { ran = true; },
  } });
  const result = await runIndependentTests(options);
  assert.equal(result.status, 'error');
  assert.equal(ran, false);
  assert.doesNotMatch(result.error, /secret|private/u);
});

test('真实MXC独立快照完成固定业务检查', { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1' }, async t => {
  const { options } = await setup(t, { sandbox: createWindowsSandbox() });
  const result = await runIndependentTests(options);
  assert.equal(result.status, 'passed', result.error);
  assert.equal(result.command.exitCode, 0);
  assert.equal(result.checks.filter(item => item.passed).length, 13);
  assert.equal(result.environment.kind, 'windows-mxc');
});
