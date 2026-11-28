import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaskReview, renderTaskReview } from '../public/task-review-flow.js';

const old = 'a'.repeat(40), candidate = 'b'.repeat(40);
const task = { id: 'reserve', status: 'running', stage: 'validating', attemptId: 'attempt-2', candidateCommit: candidate };
const snapshot = { taskId: task.id, attemptId: task.attemptId, candidateCommit: candidate, attempt: 1, status: 'not_started', issues: [] };
const checks = { http: [{ passed: true }], browser: [{ passed: true }], review: 'completed', issues: [] };
const receipt = { ...snapshot, status: 'completed' };
const dispatch = { taskId: task.id, attemptId: task.attemptId, role: 'review', requestState: 'in_flight', dispatched: true, candidateCommit: candidate };
const open = { id: 'R1', message: '重复申请未拒绝', severity: 'blocking', status: 'open' };

function project(selected, fields = {}) {
  return projectTaskReview({ id: 'run-dev', active: true, status: 'running', tasks: [selected], ...fields }, selected);
}

test('计划、派发、固定候选与集成分别读取各自证据', () => {
  const plan = projectTaskReview(null, task);
  assert.equal(plan.review.state, 'planned');
  const review = project({ ...task, checks }, { reviewHistory: [receipt] });
  assert.equal(review.review.state, 'passed');
  assert.equal(review.release.state, 'waiting');
  assert.equal(project({ ...task, checks, status: 'completed' }, { reviewHistory: [receipt] }).release.state, 'passed');
  assert.equal(project({ ...task, attemptId: null, checks }, { reviewHistory: [receipt] }).commit, null);
});

test('同一任务新提交、同次尝试更高轮或正在改写时，上一版 Review 仅进历史', () => {
  const previous = { ...receipt, candidateCommit: old };
  const mismatch = project({ ...task, checks }, { reviewHistory: [previous] });
  assert.equal(mismatch.commit, candidate);
  assert.equal(mismatch.checks, null);
  assert.equal(mismatch.review.state, 'waiting');
  assert.equal(mismatch.history[0].commit, old);
  for (const next of [
    project({ ...task, checks, stage: 'generating' }, { reviewHistory: [receipt] }),
    project({ ...task, checks }, { reviewHistory: [receipt], modelCalls: [{ ...dispatch, role: 'coding', attempt: 2 }] }),
  ]) {
    assert.equal(next.commit, null);
    assert.equal(next.history.length, 1);
    assert.equal(next.review.state, 'waiting');
  }
  assert.equal(project({ ...task, checks }, { reviewHistory: [{ ...receipt, attemptId: 'earlier' }] }).review.state, 'waiting');
  const archived = { attemptId: 'earlier', candidateCommit: old, checks };
  assert.equal(project({ ...task, checks, history: [archived] }).review.state, 'waiting');
  assert.equal(project({ ...task, candidateCommit: 'invalid', checks }, { reviewHistory: [receipt] }).commit, null);
});

test('仅同任务同候选已派发的审查调用可驱动正在审查状态', () => {
  const live = { ...task, candidateCommit: null };
  assert.equal(project(live, { reviewHistory: [snapshot], modelCalls: [dispatch] }).review.state, 'checking');
  for (const call of [{ ...dispatch, taskId: 'sibling' }, { ...dispatch, attemptId: 'previous' },
    { ...dispatch, candidateCommit: old }, { ...dispatch, requestState: 'prepared' }, { ...dispatch, finishedAt: 'done' }]) {
    assert.equal(project(live, { reviewHistory: [snapshot], modelCalls: [call], workflow: { reviewPending: true } }).review.state, 'waiting');
  }
});

test('同版阻塞需逐项复核关闭，旧意见不会提前产生新版本的 Review 结论', () => {
  const read = (entry, taskChecks = checks) => project({ ...task, checks: taskChecks }, { reviewHistory: [entry] });
  assert.equal(read({ ...receipt, issues: [open] }).review.state, 'failed');
  assert.equal(read({ ...receipt, issues: [{ ...open, status: 'resolved', checkedCommit: old }] }).review.state, 'failed');
  assert.equal(read({ ...receipt, issues: [{ ...open, status: 'resolved', checkedCommit: candidate }] }).review.state, 'passed');
  assert.equal(read({ ...snapshot, issues: [open] }).review.state, 'waiting');
  assert.equal(read(receipt, { ...checks, http: [{ passed: false }] }).review.state, 'unknown');
  assert.equal(read(receipt, { ...checks, browser: [{ passed: true }, {}] }).review.state, 'unknown');
});

test('历史证据仅按任务、尝试和完整提交生成链接，消息与定位经过转义', () => {
  const past = { ...receipt, attemptId: 'old-attempt', candidateCommit: old, summary: '<img onerror=boom>' };
  const row = project(task, { reviewHistory: [past, receipt, { ...past, taskId: 'sibling', attemptId: 'sibling-attempt' }] });
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const view = renderTaskReview(row, { downstream: [], versions: [past], escape, contextKey: 'scope', historyOpen: true });
  assert.match(view, /data-review-history open/);
  assert.match(view, /&lt;img onerror=boom&gt;/);
  assert.doesNotMatch(view, /<img|sibling-attempt/);
  assert.match(view, /data-trace-attempt="old-attempt"/);
  assert.doesNotMatch(view, /data-trace-attempt="attempt-2"/);
});
