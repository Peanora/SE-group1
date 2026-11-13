import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { runCandidateAcceptance, isTaskAccepted } from '../lib/candidate-acceptance.mjs';
import { startTaskExecution } from '../lib/task-executor.mjs';
import { borrowingProfile as profile, hash, validationManifest } from '../lib/execution-profile.mjs';
import { runProcess } from '../lib/managed-process.mjs';
import { createWindowsSandbox } from '../lib/windows-sandbox.mjs';

const good = await readFile(new URL('../examples/library-borrow.fixture.mjs', import.meta.url), 'utf8');
// This adapter executes only the platform-authored fixtures in this file.
const trustedSandbox = { preflight: async () => ({}), run: ({ workspace, runnerFile, ...options }) =>
  runProcess(process.execPath, ['--experimental-vm-modules', runnerFile], { cwd: workspace, ...options }) };
const clear = () => ({ summary: '未发现阻塞问题', issues: [], resolutions: [], model: 'test-model', usage: { inputTokens: 10, outputTokens: 5 } });
const issue = { severity: 'blocking', file: profile.writableFile, line: 2, message: '需要核实当前任务规则', evidence: good.split('\n')[1].trim() };
const candidate = (source, commit = 'a'.repeat(40)) => ({ taskId: profile.id, attemptId: 'attempt-1', specRevision: hash(profile.task),
  planRevision: hash({ file: profile.writableFile, validationManifest }), candidateCommit: commit, sourceHash: hash(source) });
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-gate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function gate(t, options = {}) {
  const source = options.source ?? good;
  return runCandidateAcceptance({ rootDir: await directory(t), candidate: candidate(source), source, sandbox: trustedSandbox,
    reviewer: async () => clear(), assertCurrent: async () => {}, ...options });
}

test('两方分别检查同一快照并保存绑定与真实命令；Review不收到测试结果', async t => {
  const report = await gate(t, { reviewer: async input => { assert.deepEqual(Object.keys(input).sort(), ['files', 'previousIssues', 'signal', 'task']); return clear(); } });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.test.binding, report.review.binding);
  assert.notEqual(report.testWorkspace, report.reviewWorkspace);
  assert.equal(report.test.command.exitCode, 0);
  assert.equal(report.test.checks.length, 13);
  assert.equal(hash(await readFile(path.join(report.reviewWorkspace, profile.writableFile), 'utf8')), report.binding.sourceHash);
  assert.equal(JSON.parse(await readFile(report.reportPath, 'utf8')).status, 'passed');
});

test('缺少Review结论、服务失败及进程失败均不得放行', async t => {
  assert.equal((await gate(t, { reviewer: async () => ({ passed: true }) })).status, 'error');
  assert.equal((await gate(t, { reviewer: async () => { throw new Error('private response'); } })).status, 'error');
  const failed = await gate(t, { source: profile.seed });
  assert.equal(failed.status, 'changes_requested');
  assert.equal(failed.test.checks.every(item => item.passed), false);
});

test('一方失败仍等待另一方收尾，保留独立证据', async t => {
  let completed = false;
  const report = await gate(t, { reviewer: async () => { throw new Error('review unavailable'); }, sandbox: {
    preflight: trustedSandbox.preflight, run: async input => {
      await new Promise(resolve => setTimeout(resolve, 30));
      const result = await trustedSandbox.run(input); completed = true; return result;
    },
  } });
  assert.equal(completed, true);
  assert.equal(report.test.status, 'passed');
  assert.equal(report.status, 'error');
});

test('检查期间版本变化或结果迟到不能通过', async t => {
  let current = true;
  const report = await gate(t, { assertCurrent: async () => { if (!current) throw new Error('stale'); },
    reviewer: async () => { current = false; return clear(); } });
  assert.equal(report.status, 'invalidated');
  assert.equal(report.review.status, 'completed');
});

test('测试结束后快照发生变化也不能使用旧通过证据', async t => {
  const rootDir = await directory(t);
  const report = await gate(t, { rootDir, onProgress: async message => {
    if (message.startsWith('独立测试结束')) {
      const [name] = await readdir(rootDir);
      await writeFile(path.join(rootDir, name, 'test', profile.writableFile), good + '\n// changed after test');
    }
  } });
  assert.equal(report.test.status, 'passed');
  assert.equal(report.status, 'invalidated');
});

test('取消及停止未确认不能变成验收成功', async t => {
  const controller = new AbortController();
  const cancelled = await gate(t, { signal: controller.signal, reviewer: async () => { controller.abort(); return clear(); } });
  assert.equal(cancelled.status, 'cancelled');
  const unknown = await gate(t, { sandbox: { preflight: trustedSandbox.preflight, run: async () => ({ terminationConfirmed: false }) } });
  assert.equal(unknown.status, 'reconciliation_required');
});

test('阻塞问题只能在新候选明确复验后关闭；遗漏或仍未解决不得放行', async t => {
  const first = await gate(t, { reviewer: async () => ({ ...clear(), issues: [issue] }) });
  assert.equal(first.status, 'changes_requested');
  assert.equal(first.openIssues.length, 1);
  const source = good + '\n// new candidate\n';
  const previousIssues = first.openIssues;
  const next = { source, candidate: candidate(source, 'b'.repeat(40)), previousIssues };
  assert.equal((await gate(t, next)).status, 'error');
  const open = await gate(t, { ...next, reviewer: async () => ({ ...clear(), resolutions: [{ id: previousIssues[0].id, status: 'open', reason: '仍需处理' }] }) });
  assert.equal(open.status, 'changes_requested');
  const closed = await gate(t, { ...next, reviewer: async () => ({ ...clear(), resolutions: [{ id: previousIssues[0].id, status: 'resolved', reason: '已依据新候选逐项复核' }] }) });
  assert.equal(closed.status, 'passed');
  assert.equal(closed.issues[0].status, 'resolved');
  assert.notEqual(closed.binding.candidateCommit, first.binding.candidateCommit);
  assert.notEqual(closed.binding.validationId, first.binding.validationId);
});

test('诊断Review通过也不计为真实任务验收', async t => {
  assert.equal((await gate(t, { reviewKind: 'diagnostic' })).status, 'diagnostic_passed');
  assert.equal(isTaskAccepted({ status: 'executed', acceptanceStatus: 'diagnostic_passed' }), false);
});

test('执行器返工后新提交重新运行两方，保留旧问题和独立检查历史', async t => {
  let codingCalls = 0, reviewCalls = 0, processCalls = 0;
  const execution = startTaskExecution({ outputDir: await directory(t), maxCalls: 2, sandbox: { preflight: trustedSandbox.preflight,
    run: async input => { processCalls++; return trustedSandbox.run(input); } },
    provider: async ({ feedback }) => {
      if (codingCalls) assert.match(feedback, /独立检查要求修改/u);
      return { files: [{ path: profile.writableFile, content: good + `\n// candidate ${++codingCalls}\n` }], usage: { inputTokens: 1, outputTokens: 2 } };
    },
    reviewer: async ({ previousIssues }) => {
      reviewCalls++;
      return reviewCalls === 1 ? { ...clear(), issues: [issue] }
        : { ...clear(), resolutions: previousIssues.map(item => ({ id: item.id, status: 'resolved', reason: '复验已解决' })) };
    },
  });
  const record = await execution.done;
  assert.equal(record.status, 'accepted');
  assert.equal(isTaskAccepted(record), true);
  assert.equal(record.reviewCalls, 2);
  assert.equal(record.totalModelCalls, 4);
  assert.equal(record.usage.inputTokens, 22);
  assert.equal(record.versions[0].acceptance.status, 'changes_requested');
  assert.equal(record.versions[1].acceptance.status, 'passed');
  assert.notEqual(record.versions[0].commit, record.versions[1].commit);
  assert.equal(processCalls, 4, 'each candidate has its own self-check and independent test');
  const old = structuredClone(record); old.candidateCommit = old.versions[0].commit;
  assert.equal(isTaskAccepted(old), false);
  const mismatchedLatest = structuredClone(record); mismatchedLatest.versions.at(-1).commit = mismatchedLatest.versions[0].commit;
  assert.equal(isTaskAccepted(mismatchedLatest), false);
  const oldPolicy = structuredClone(record); oldPolicy.versions.at(-1).acceptance.binding.reviewPolicyHash = 'old-policy';
  assert.equal(isTaskAccepted(oldPolicy), false);
  const wrongRole = structuredClone(record); wrongRole.versions.at(-1).acceptance.test.role = 'review';
  assert.equal(isTaskAccepted(wrongRole), false);
  const wrongVersion = structuredClone(record);
  wrongVersion.versions.at(-1).acceptance.review.binding = { ...wrongVersion.versions.at(-1).acceptance.binding, candidateCommit: '0'.repeat(40) };
  assert.equal(isTaskAccepted(wrongVersion), false);
});

test('Review故障不盲目改代码，未知Review用量计入共享总量', async t => {
  const execution = startTaskExecution({ outputDir: await directory(t), sandbox: trustedSandbox,
    provider: async () => ({ files: [{ path: profile.writableFile, content: good }], usage: { inputTokens: 5, outputTokens: 5 } }),
    reviewer: async () => { throw new Error('upstream failed'); },
  });
  const record = await execution.done;
  assert.equal(record.status, 'failed');
  assert.equal(record.calls, 1);
  assert.equal(record.usage.inputTokens, null);
  assert.equal(record.versions[0].acceptance.status, 'error');
});

test('真实MXC下返工的新提交重新独立检查，诊断Review不冒充真实验收', { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1' }, async t => {
  let edits = 0, reviews = 0;
  const record = await startTaskExecution({ outputDir: await directory(t), sandbox: createWindowsSandbox(), providerKind: 'trusted_fixture', reviewerKind: 'diagnostic',
    provider: async () => ({ files: [{ path: profile.writableFile, content: good + `\n// diagnostic revision ${++edits}\n` }], usage: {} }),
    reviewer: async ({ previousIssues }) => ++reviews === 1 ? { ...clear(), issues: [issue] }
      : { ...clear(), resolutions: previousIssues.map(item => ({ id: item.id, status: 'resolved', reason: '可信诊断复验已结束' })) },
  }).done;
  assert.equal(record.status, 'executed');
  assert.equal(record.acceptanceStatus, 'diagnostic_passed');
  assert.equal(isTaskAccepted(record), false);
  assert.equal(record.totalModelCalls, 0);
  assert.notEqual(record.versions[0].commit, record.versions[1].commit);
  assert.equal(record.versions[0].acceptance.status, 'changes_requested');
  assert.equal(record.versions[1].acceptance.test.status, 'passed');
  assert.equal(record.versions[1].acceptance.review.resolutions[0].status, 'resolved');
});
