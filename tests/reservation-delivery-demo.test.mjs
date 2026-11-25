import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const demoScript = fileURLToPath(new URL('../scripts/deliver-reservations.mjs', import.meta.url));
const verifyCli = fileURLToPath(new URL('../scripts/verify-planned-delivery.mjs', import.meta.url));

test('reservation delivery demo verifies preview, ZIP download, clean-directory restart, and failed-record blocking', async t => {
  const result = spawnSync(process.execPath, [demoScript], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const jsonStart = result.stdout.indexOf('{');
  assert.ok(jsonStart >= 0, result.stdout);
  const summary = JSON.parse(result.stdout.slice(jsonStart));
  t.after(async () => { await rm(summary.directory, { recursive: true, force: true }); });

  assert.match(summary.candidateCommit, /^[a-f0-9]{40}$/u);
  assert.match(summary.sourceHash, /^[a-f0-9]{64}$/u);
  assert.equal(summary.previewTrialStatus, 201);
  assert.equal(summary.cleanScenarioRestartVerified, true);
  assert.deepEqual(summary.persistedAuditActions, ['queued', 'promoted', 'confirmed']);
  assert.deepEqual(summary.failedRecordBlocked, { canPreview: false, canDownload: false });
  assert.equal(summary.startGuidePresent, true);

  // Verify --inspect CLI succeeds on the delivered ZIP and binds the exact same commit
  const inspect = spawnSync(process.execPath, [verifyCli, '--archive', summary.zipPath, '--inspect'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(inspect.status, 0, inspect.stdout + inspect.stderr);
  const inspected = JSON.parse(inspect.stdout);
  assert.equal(inspected.status, 'integrity_verified');
  assert.equal(inspected.taskAccepted, false);
  assert.equal(inspected.historicalAcceptanceVerified, false);
  assert.equal(inspected.totalModelCalls, 0);
  assert.equal(inspected.startGuidePresent, true);
  assert.equal(inspected.binding.candidateCommit, summary.candidateCommit);
  assert.equal(inspected.binding.sourceHash, summary.sourceHash);
  assert.equal(inspected.verificationReport.status, 'accepted');
  assert.equal(inspected.verificationReport.review.openBlockingIssues, 0);

  // Verify --inspect CLI rejects a tampered ZIP
  const tamperedPath = path.join(summary.directory, 'tampered.zip');
  const bytes = Buffer.from(await readFile(summary.zipPath));
  const offset = bytes.indexOf(Buffer.from('START-HERE.md'));
  assert.ok(offset > 0);
  bytes[offset] ^= 1;
  await writeFile(tamperedPath, bytes);
  const tampered = spawnSync(process.execPath, [verifyCli, '--archive', tamperedPath, '--inspect'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(tampered.status, 1);
});
