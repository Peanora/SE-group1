import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewReservations } from '../scripts/review-reservations.mjs';

test('预约独立审查保留首版源码证据，在新提交按原 ID 关闭队首问题', async t => {
  const output = await mkdtemp(path.join(tmpdir(), 'fifo-review-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const { directory, reports, demonstrated } = await reviewReservations('--fixture', output);
  assert.equal(demonstrated, true);
  const [initial, repaired] = reports;
  assert.equal(initial.kind, 'offline_fixture');
  assert.equal(initial.openBlockingIssues, 1);
  assert.equal(repaired.previousCommit, initial.candidateCommit);
  assert.notEqual(initial.sourceHash, repaired.sourceHash);
  assert.equal(repaired.openBlockingIssues, 0);
  const [issue] = initial.issues;
  assert.equal(issue.status, 'open');
  assert.equal(repaired.issues[0].id, issue.id);
  assert.equal(repaired.issues[0].status, 'resolved');
  assert.equal(repaired.issues[0].originCommit, initial.candidateCommit);
  assert.equal(repaired.issues[0].checkedCommit, repaired.candidateCommit);
  const bob = { id: 'bob', sequence: 1, status: 'queued', resourceId: 'A', slot: 'AM' };
  const carol = { ...bob, id: 'carol', sequence: 2 };
  const queue = [{ ...bob, id: 'other-slot', slot: 'PM', sequence: 0 }, carol, bob];
  for (const report of reports) {
    const persisted = JSON.parse(await readFile(path.join(directory, report.candidateCommit + '.json'), 'utf8'));
    assert.deepEqual(persisted, report);
    const code = execFileSync('git', ['cat-file', 'blob', `${report.candidateCommit}:${issue.file}`], {
      cwd: path.join(directory, 'candidate'), encoding: 'utf8', windowsHide: true,
    });
    if (report === initial) assert.equal(code.split('\n')[issue.line - 1].trim(), issue.evidence);
    // Only these two checked-in fixture bodies are executed by this test.
    const { promotableWaiter } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    assert.equal(promotableWaiter(queue, 'A', 'AM', carol.id), report === initial ? carol : null);
    assert.equal(promotableWaiter(queue, 'A', 'AM', bob.id), bob);
  }
});
