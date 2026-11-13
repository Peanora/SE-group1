import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createZip } from '../lib/zip.mjs';
import { inspectWebArchive, revalidateWebArchive } from '../lib/web-archive.mjs';
import { getWebShellFiles } from '../lib/web-delivery.mjs';
import { webManifest, databaseObserverHash } from '../lib/web-tests.mjs';
import { browserManifest } from '../lib/web-browser-tests.mjs';
import { projectReviewPolicy } from '../lib/project-review-model.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sources = () => validateProjectFiles([
  { path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:500,body:"not a business application"}},close(){}}}' },
  { path: 'tests/forged.test.mjs', content: 'throw new Error("archived npm test must never be trusted or executed");' },
]);
async function fixture() {
  const shell = await getWebShellFiles(), files = sources();
  const binding = { projectId: 'archive-project', runId: 'archive-run', taskId: 'archive-task', attemptId: 'archive-attempt',
    specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64), candidateCommit: 'c'.repeat(40), sourceHash: hash(JSON.stringify(files)),
    manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash };
  const payload = [...files, ...shell,
    { path: 'delivery/requirements.md', content: '# Structurally valid archive fixture, deliberately wrong business.' },
    { path: 'delivery/spec.json', content: '{}' }, { path: 'delivery/plan.json', content: '{}' },
    { path: 'delivery/acceptance.json', content: '{"status":"passed","thisClaimIsNotTrusted":true}' },
  ].sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = { format: 'taskflow-web-delivery-v1', binding, sourceHash: binding.sourceHash, shellHash: hash(JSON.stringify(shell)),
    validation: { databaseObserverHash, manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash },
    files: payload.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) })) };
  const pack = (items = payload, data = manifest) => createZip([...items, { path: 'delivery/manifest.json', content: JSON.stringify(data) }].map(file => ({ name: file.path, content: file.content })));
  return { payload, manifest, pack, files };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-archive-test-'));
  t.after(async () => { const relative = path.relative(path.resolve(os.tmpdir()), directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('archive integrity never elevates an archived passed claim to trusted acceptance', async () => {
  const input = await fixture(), bytes = input.pack(), result = await inspectWebArchive(bytes);
  assert.equal(result.integrityVerified, true); assert.equal(result.historicalAcceptanceVerified, false);
  assert.deepEqual(result.files, input.files); assert.equal(result.binding.sourceHash, input.manifest.sourceHash);
  assert.equal(result.archiveHash, hash(bytes)); assert.equal(result.status, undefined);
});

test('archive checks CRC, complete manifest hashes, source identity and protected launcher bytes', async () => {
  const input = await fixture();
  const crc = input.pack(); crc[40] ^= 1; await assert.rejects(inspectWebArchive(crc));
  const changed = structuredClone(input.payload); changed.find(file => file.path === 'src/app.mjs').content += '\n// changed';
  await assert.rejects(inspectWebArchive(input.pack(changed)), /哈希/);
  const hostile = structuredClone(input.payload), data = structuredClone(input.manifest);
  hostile.find(file => file.path === 'server.mjs').content = 'throw new Error("hostile launcher");';
  data.files = hostile.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) }));
  await assert.rejects(inspectWebArchive(input.pack(hostile, data)), /保护外壳/);
});

test('archive rejects unsupported compression, symlink attributes, trailing data and ambiguous paths', async () => {
  const input = await fixture();
  for (const mutate of [
    bytes => { const at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bytes.writeUInt16LE(8, at + 10); },
    bytes => { const at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bytes.writeUInt32LE(0xa1ff0000, at + 38); },
  ]) { const bytes = input.pack(); mutate(bytes); await assert.rejects(inspectWebArchive(bytes)); }
  await assert.rejects(inspectWebArchive(Buffer.concat([input.pack(), Buffer.from('extra')])));
  for (const path of ['public/%2e%2e/escape.js', 'src/APP.mjs']) {
    const payload = [...input.payload, { path, content: 'unsafe' }];
    await assert.rejects(inspectWebArchive(input.pack(payload)));
  }
});

test('archive refuses stale verification rules and incomplete version bindings', async () => {
  const input = await fixture();
  for (const mutate of [
    data => { data.binding.manifestHash = '0'.repeat(64); }, data => { delete data.binding.planRevision; },
    data => { data.validation.databaseObserverHash = '0'.repeat(64); }, data => { data.files.pop(); },
  ]) { const manifest = structuredClone(input.manifest); mutate(manifest); await assert.rejects(inspectWebArchive(input.pack(input.payload, manifest))); }
});

test('cancelled archive verification creates no snapshots and linked output parents receive no writes', async t => {
  const root = await temporary(t), input = await fixture(), archiveFile = path.join(root, 'fixture.zip');
  await writeFile(archiveFile, input.pack());
  await assert.rejects(revalidateWebArchive({ archiveFile, outputDir: path.join(root, 'cancelled'), signal: AbortSignal.abort() }), { name: 'AbortError' });
  const target = path.join(root, 'target'); await mkdir(target);
  await symlink(target, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(revalidateWebArchive({ archiveFile, outputDir: path.join(root, 'alias', 'must-not-exist') }), /链接/);
  assert.deepEqual(await readdir(target), []);
});

test('real clean-snapshot archive checks reject wrong business despite forged archived passed and npm tests', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 60_000,
}, async t => {
  const root = await temporary(t), input = await fixture(), archiveFile = path.join(root, 'fixture.zip');
  await writeFile(archiveFile, input.pack());
  const report = await revalidateWebArchive({ archiveFile, outputDir: path.join(root, 'verification'), timeoutMs: 30_000 });
  assert.equal(report.status, 'failed'); assert.equal(report.taskAccepted, false); assert.equal(report.historicalAcceptanceVerified, false);
  assert.equal(report.test.checks.length, webManifest.count); assert.equal(report.browser.checks.length, browserManifest.count);
  assert.equal(report.test.terminationConfirmed, true); assert.equal(report.browser.terminationConfirmed, true);
  assert.ok(report.test.checks.some(check => !check.passed)); assert.ok(report.browser.checks.some(check => !check.passed));
});
