import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAcceptance } from '../lib/acceptance.mjs';

test('可复现验收：同一固定需求两次本地规划产生相同文档和计划，且不调用模型', { timeout: 120000 }, async t => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'taskflow-acceptance-test-'));
  t.after(async () => {
    assert.equal(path.dirname(outDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(outDir).startsWith('taskflow-acceptance-test-'));
    await rm(outDir, { recursive: true, force: true });
  });
  const report = await runAcceptance({ fixturePath: 'examples/library-system.md', outDir, repetitions: 2 });
  assert.equal(report.format, 'taskflow-acceptance-v1');
  assert.equal(report.status, 'planning_passed_only');
  assert.equal(report.complete, false);
  assert.equal(report.planning.passed, true);
  assert.equal(report.planning.reproducible, true);
  assert.equal(report.planning.modelCalls, 0);
  assert.equal(report.planning.runs.length, 2);
  assert.equal(report.planning.runs[0].requirements, 8);
  assert.ok(report.planning.runs[0].tasks > 0);
  assert.equal(report.planning.runs[0].modelCalls, 0);
  assert.deepEqual(report.planning.runs[0].documents, report.planning.runs[1].documents);
  assert.equal(report.planning.runs[0].planProjectionHash, report.planning.runs[1].planProjectionHash);
  assert.deepEqual(report.planning.runs[0].zip.entries, ['architecture.md', 'handoff.md', 'plan.json', 'requirements.md', 'review.md', 'spec.md', 'task.md']);
  assert.equal(report.webDelivery.status, 'not_provided');
  assert.match(report.reportPath, /acceptance\.json$/u);
  assert.match(report.markdownPath, /acceptance\.md$/u);
});
