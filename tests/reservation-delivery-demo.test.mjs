import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../lib/zip.mjs';
import { inspectPlannedArchive } from '../lib/planned-archive.mjs';
import { getWebShellFiles } from '../lib/web-delivery.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { contentRevision } from '../lib/planning-review.mjs';
import { compileManifest, createVerificationControl } from '../lib/verification-contract.mjs';
import { browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { projectReviewPolicy } from '../lib/project-review-model.mjs';
import { plannedExecutionPolicyHash } from '../lib/planned-web-executor.mjs';
import { plannedNotes } from '../examples/planned-notes.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
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

test('inspectPlannedArchive accepts optional delivery/evolution.json while keeping historical claims non-authoritative', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evolution-archive-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const files = validateProjectFiles(plannedNotes.files), shell = await getWebShellFiles(), spec = structuredClone(plannedNotes.spec);
  const base = { projectId: 'evo-project', runId: 'evo-run', specRevision: contentRevision(spec), planRevision: contentRevision(plannedNotes.task) };
  const definition = { proposal: structuredClone(plannedNotes.definition), requirements: spec.requirements.map(item => item.id), binding: base };
  const control = createVerificationControl(), approval = control.approve({ ...definition, feedback: 'Evolution archive inspection test' });
  const compiled = compileManifest({ ...definition, approval });
  const binding = { ...base, taskId: 'evo-task', attemptId: 'evo-attempt', candidateCommit: 'e'.repeat(40), manifestHash: compiled.manifestHash,
    browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: projectReviewPolicy.hash, executorPolicyHash: plannedExecutionPolicyHash, sourceHash: hash(files) };
  const payload = [...shell, ...files,
    { path: 'delivery/requirements.md', content: plannedNotes.requirements },
    { path: 'delivery/spec.json', content: JSON.stringify(spec) },
    { path: 'delivery/tasks.json', content: JSON.stringify({ specRevision: base.specRevision, planRevision: base.planRevision, tasks: plannedNotes.task.tasks }) },
    { path: 'delivery/verification-definition.json', content: JSON.stringify(definition.proposal) },
    { path: 'delivery/verification.json', content: JSON.stringify({ status: 'accepted', self: [{ id: 's1', passed: true }], http: [{ id: 'h1', passed: true }], browser: [{ id: 'b1', passed: true }], review: { summary: 'ok', issues: [] } }) },
    { path: 'delivery/evolution.json', content: JSON.stringify({ version: 1, historicalRecordOnly: true, databaseIncluded: false }) },
  ];
  const manifest = { version: 1, profileId: 'planned-web-v1', sourceHash: binding.sourceHash, binding, files: payload.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) })) };
  const zip = createZip([...payload.map(file => ({ name: file.path, content: file.content })), { name: 'delivery/manifest.json', content: JSON.stringify(manifest) }]);
  const result = await inspectPlannedArchive(zip);
  assert.equal(result.integrityVerified, true);
  assert.equal(result.taskAccepted, false);
  assert.equal(result.historicalAcceptanceVerified, false);
  assert.equal(result.verificationReport.http.passed, 1);
  assert.equal(result.verificationReport.review.openBlockingIssues, 0);
});
