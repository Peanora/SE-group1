import assert from 'node:assert/strict';
import test from 'node:test';
import { executionRoleProgress } from '../public/planned-execution.js';

const firstCommit = '1'.repeat(40);
const secondCommit = '2'.repeat(40);
const passingChecks = { http: [{ passed: true }], browser: [{ passed: true }] };
const blockingIssue = { severity: 'blocking', status: 'open' };

test('shows testing before Review and same-candidate test results during Review', () => {
  const item = {
    status: 'validating', active: true, candidateCommit: firstCommit,
    reviewHistory: [{ attempt: 1, candidateCommit: firstCommit, status: 'not_started' }],
    checks: { http: [], browser: [] }, workflow: { stage: 'testing' },
  };
  let progress = executionRoleProgress(item, null, true);
  assert.deepEqual([progress.coding, progress.testing, progress.review], ['done', 'running', 'waiting']);

  item.workflow.stage = 'review';
  item.checks = passingChecks;
  progress = executionRoleProgress(item, null, true);
  assert.deepEqual([progress.coding, progress.testing, progress.review], ['done', 'done', 'running']);
  assert.equal(progress.commit, firstCommit);
  assert.equal(progress.testingEvidence, true);
  assert.equal(progress.reviewEvidence, true);
});

test('refuses to carry a previous candidate through a new round or its early failure', () => {
  const item = {
    status: 'generating', active: true, candidateCommit: firstCommit, checks: passingChecks,
    reviewHistory: [{ attempt: 1, candidateCommit: firstCommit, status: 'completed' }],
    workflow: { stage: 'review' }, events: [{ type: 'coding_round', round: 2 }],
    modelCalls: [{ role: 'coding', attempt: 2 }],
  };
  let progress = executionRoleProgress(item, null, true);
  assert.deepEqual([progress.commit, progress.coding, progress.testing, progress.review], [null, 'running', 'waiting', 'waiting']);
  assert.equal(progress.testingEvidence, false);
  assert.equal(progress.reviewEvidence, false);

  Object.assign(item, { status: 'failed', active: false });
  progress = executionRoleProgress(item, null, true);
  assert.deepEqual([progress.commit, progress.coding, progress.testing, progress.review], [null, 'incomplete', 'waiting', 'waiting']);
});

test('distinguishes failed tests, Review blockers and missing or inconsistent results', () => {
  const snapshot = { attempt: 1, candidateCommit: firstCommit, status: 'not_started' };
  const item = {
    status: 'failed', active: false, candidateCommit: firstCommit, reviewHistory: [snapshot],
    workflow: { stage: 'testing' }, checks: { browser: [{ passed: false }] },
  };
  let progress = executionRoleProgress(item);
  assert.equal(progress.testing, 'failed');
  assert.equal(progress.review, 'waiting');

  snapshot.status = 'completed';
  snapshot.issues = [blockingIssue];
  item.workflow.stage = 'review';
  progress = executionRoleProgress(item);
  assert.equal(progress.testing, 'unknown');
  assert.equal(progress.review, 'failed');

  item.checks = passingChecks;
  progress = executionRoleProgress(item);
  assert.equal(progress.testing, 'done');
  snapshot.status = 'error';
  assert.equal(executionRoleProgress(item).review, 'incomplete');
});

test('a task uses its own live attempt and cannot inherit another task or older attempt', () => {
  const first = { id: 'A', attemptId: 'new-a', status: 'running', stage: 'validating', checks: {} };
  const second = { id: 'B', attemptId: 'new-b', status: 'running', stage: 'validating', checks: passingChecks };
  const item = {
    status: 'pause_requested', active: true, workflow: { stage: 'review' },
    reviewHistory: [
      { taskId: 'A', attemptId: 'old-a', candidateCommit: '3'.repeat(40), status: 'completed' },
      { taskId: 'A', attemptId: 'new-a', candidateCommit: firstCommit, status: 'not_started' },
      { taskId: 'B', attemptId: 'new-b', candidateCommit: secondCommit, status: 'not_started' },
    ],
    modelCalls: [{ role: 'review', taskId: 'B', attemptId: 'new-b', candidateCommit: secondCommit }],
  };
  const firstProgress = executionRoleProgress(item, first, true);
  const secondProgress = executionRoleProgress(item, second, true);
  assert.deepEqual([firstProgress.commit, firstProgress.testing, firstProgress.review], [firstCommit, 'running', 'waiting']);
  assert.deepEqual([secondProgress.commit, secondProgress.testing, secondProgress.review], [secondCommit, 'done', 'running']);
  assert.equal(executionRoleProgress(item, { ...first, attemptId: null, checks: null }, true).commit, null);
});

test('a paused, stale or unobserved task cannot advertise a live Review', () => {
  const task = { id: 'A', attemptId: 'new-a', status: 'running', stage: 'validating', checks: passingChecks };
  const item = {
    status: 'paused', active: true,
    reviewHistory: [{ taskId: 'A', attemptId: 'new-a', candidateCommit: firstCommit, status: 'not_started' }],
    modelCalls: [{ role: 'review', taskId: 'A', attemptId: 'new-a', candidateCommit: firstCommit }],
  };
  assert.equal(executionRoleProgress(item, task, true).review, 'unknown');
  assert.equal(executionRoleProgress({ ...item, status: 'running' }, task, false).review, 'unknown');
  assert.equal(executionRoleProgress({ status: 'failed', active: false }).review, 'waiting');
});
