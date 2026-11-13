import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startTaskExecution } from '../lib/task-executor.mjs';
import { runProcess } from '../lib/managed-process.mjs';

const good = await readFile(new URL('../examples/library-borrow.fixture.mjs', import.meta.url), 'utf8');
// Only trusted fixtures run in this test adapter. Production has no unsandboxed fallback.
const trustedFixtureSandbox = {
  preflight: async () => {},
  run: ({ workspace, runnerFile, ...options }) => runProcess(process.execPath, ['--preserve-symlinks-main', runnerFile], { cwd: workspace, ...options }),
};
const replacement = content => ({ files: [{ path: 'src/borrow.mjs', content }], usage: {} });
async function run(t, provider, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'execution-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return startTaskExecution({ outputDir: directory, sandbox: trustedFixtureSandbox, provider, ...options });
}

test('真实文件差异、代码提交和受控检查绑定同一候选；不宣称独立验收完成', async t => {
  const execution = await run(t, async () => replacement(good));
  const record = await execution.done;
  assert.equal(record.status, 'executed');
  assert.notEqual(record.baseCommit, record.candidateCommit);
  assert.match(record.diff, /borrowBook/u);
  assert.equal(record.commands[0].exitCode, 0);
  assert.equal(record.commands[0].commit, record.candidateCommit);
  assert.equal(record.versions[0].check.checks.length, 13);
  assert.equal(record.acceptanceStatus, 'not_reviewed');
  assert.equal(record.usage.inputTokens, null);
  assert.equal(JSON.parse(await readFile(record.reportPath, 'utf8')).status, 'executed');
});

test('语法错误产生真实非零退出，修复形成新提交且保留原失败', async t => {
  let calls = 0;
  const execution = await run(t, async ({ feedback }) => {
    calls++;
    if (calls === 2) assert.match(feedback, /未通过/u);
    return replacement(calls === 1 ? 'export function {' : good);
  });
  const record = await execution.done;
  assert.equal(record.status, 'executed');
  assert.equal(record.versions.length, 2);
  assert.equal(record.versions[0].check.passed, false);
  assert.notEqual(record.commands[0].exitCode, 0);
  assert.equal(record.versions[1].check.passed, true);
  assert.notEqual(record.versions[0].commit, record.versions[1].commit);
});

test('业务错误不会因进程退出0或声称成功而通过', async t => {
  const record = await (await run(t, async () => replacement('export function borrowBook() { return {}; }'), { maxCalls: 1 })).done;
  assert.equal(record.status, 'failed');
  assert.equal(record.commands[0].exitCode, 0);
  assert.equal(record.versions[0].check.passed, false);
  assert.match(record.error, /预算/u);
});

test('拒绝路径穿越、验收修改、超限内容和没有改动', async t => {
  for (const proposal of [
    { files: [{ path: '../outside.mjs', content: good }] },
    { files: [{ path: '.platform/runner.cjs', content: good }] },
    replacement('x'.repeat(32769)),
    replacement("export function borrowBook(state, userId) {\n  throw new Error('NOT_IMPLEMENTED');\n}\n"),
  ]) {
    const record = await (await run(t, async () => proposal)).done;
    assert.equal(record.status, 'failed');
    assert.equal(record.candidateCommit, null);
  }
});

test('环境预检失败时不调用模型也不执行候选代码', async t => {
  let called = false;
  const execution = await run(t, async () => { called = true; return replacement(good); }, {
    sandbox: { preflight: async () => { throw new Error('环境不支持'); }, run: async () => assert.fail('不得回退') },
  });
  const record = await execution.done;
  assert.equal(record.status, 'failed');
  assert.equal(called, false);
  assert.equal(record.calls, 0);
});

test('取消模型等待和总时长预算，不接受迟到修改', async t => {
  const pendingProvider = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  const stopped = await run(t, pendingProvider);
  stopped.cancel();
  assert.equal((await stopped.done).status, 'stopped');
  const timed = await run(t, pendingProvider, { timeoutMs: 100 });
  assert.equal((await timed.done).status, 'timed_out');
});

test('无法确认目标进程停止时保持待协调，不能报告已停止', async t => {
  const record = await (await run(t, async () => replacement(good), {
    sandbox: { preflight: async () => {}, run: async () => ({ exitCode: null, stdout: '', stderr: '', terminationConfirmed: false }) },
  })).done;
  assert.equal(record.status, 'reconciliation_required');
});
