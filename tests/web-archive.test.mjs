import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createZip } from '../lib/zip.mjs';
import { inspectWebArchive, revalidateWebArchive } from '../lib/web-archive.mjs';
import { createWebDelivery, getWebShellFiles } from '../lib/web-delivery.mjs';
import { webProfile } from '../lib/web-profile.mjs';
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

async function productionPackage(content) {
  const input = await fixture(), files = input.files.map(file => file.path === 'src/app.mjs' ? { ...file, content } : file);
  const binding = { ...input.manifest.binding, sourceHash: hash(JSON.stringify(files)) };
  const runtime = { status: 'stopped', terminationConfirmed: true, sourceUnchanged: true, exitCode: 0, stopAcknowledged: true };
  // Synthetic trusted receipts exercise archive encoding only, never business acceptance.
  const result = manifest => ({ status: 'passed', profileId: webProfile.id, sourceHash: binding.sourceHash, manifestHash: manifest.hash,
    binding: { ...binding }, checks: manifest.checks.map(check => ({ ...check, passed: true })), terminationConfirmed: true, processes: [runtime, runtime] });
  return createWebDelivery({ files, binding, requirements: '# Encoding round trip only', spec: { title: 'encoding test' }, plan: { tasks: ['encoding'] },
    report: { status: 'passed', binding: { ...binding }, test: { ...result(webManifest), databasePreflights: [], databaseCommands: [0, 1].map(() => ({
      kind: 'database_observation', runnerHash: databaseObserverHash, sourceHash: binding.sourceHash, exitCode: 0, terminationConfirmed: true, stopReason: null, truncated: false,
    })) }, browser: { ...result(browserManifest), browser: { version: '157.0.4341.46', closed: true }, processes: [runtime, runtime, { kind: 'browser', status: 'stopped', terminationConfirmed: true, exitCode: 0 }] },
      review: { status: 'completed', binding: { ...binding }, policyHash: projectReviewPolicy.hash, openBlockingIssues: 0 } } });
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

test('production archive round trip preserves a legal source BOM and rejects BOM-masked launcher names or bytes', async () => {
  const source = `\uFEFF${sources()[0].content}`, created = await productionPackage(source);
  const decoded = await inspectWebArchive(created.zip);
  assert.equal(decoded.files.find(file => file.path === 'src/app.mjs').content, source);
  const input = await fixture();
  const renamed = input.payload.map(file => file.path === 'server.mjs' ? { ...file, path: '\uFEFFserver.mjs' } : file);
  await assert.rejects(inspectWebArchive(input.pack(renamed)));
  const changed = input.payload.map(file => file.path === 'server.mjs' ? { ...file, content: `\uFEFF${file.content}` } : file), manifest = structuredClone(input.manifest);
  manifest.files = changed.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) }));
  await assert.rejects(inspectWebArchive(input.pack(changed, manifest)), /保护外壳/);
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

test('preparation shares the total deadline and a late shell lookup cannot start checks or create output', async t => {
  const root = await temporary(t), input = await fixture(), archiveFile = path.join(root, 'fixture.zip');
  await writeFile(archiveFile, input.pack());
  const script = `
    import {mock} from 'node:test';import {access} from 'node:fs/promises';
    const deliveryUrl=${JSON.stringify(new URL('../lib/web-delivery.mjs', import.meta.url).href)};
    const testsUrl=${JSON.stringify(new URL('../lib/web-tests.mjs', import.meta.url).href)};
    const browserUrl=${JSON.stringify(new URL('../lib/web-browser-tests.mjs', import.meta.url).href)};
    const shell=await (await import(deliveryUrl)).getWebShellFiles(),actualTests=await import(testsUrl),actualBrowser=await import(browserUrl);
    let calls=0;const output=${JSON.stringify(path.join(root, 'must-not-exist'))};
    mock.module(deliveryUrl,{namedExports:{getWebShellFiles:async()=>{await new Promise(resolve=>setTimeout(resolve,200));return shell;}}});
    mock.module(testsUrl,{namedExports:{webManifest:actualTests.webManifest,databaseObserverHash:actualTests.databaseObserverHash,runWebTests:async()=>{calls++;return {status:'passed',terminationConfirmed:true};}}});
    mock.module(browserUrl,{namedExports:{browserManifest:actualBrowser.browserManifest,runWebBrowserTests:async()=>{calls++;return {status:'passed',terminationConfirmed:true};}}});
    const {revalidateWebArchive}=await import(${JSON.stringify(new URL('../lib/web-archive.mjs', import.meta.url).href)});
    const started=Date.now();let code;try{await revalidateWebArchive({archiveFile:${JSON.stringify(archiveFile)},outputDir:output,timeoutMs:20});}catch(error){code=error.code;}
    const duration=Date.now()-started;await new Promise(resolve=>setTimeout(resolve,250));let exists=true;try{await access(output);}catch{exists=false;}
    process.stdout.write(JSON.stringify({code,calls,duration,exists}));
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('trusted preparation probe timed out')); }, 5000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stderr + stdout)); } } });
    child.stdin.end(script);
  });
  assert.equal(result.code, 'timed_out'); assert.equal(result.calls, 0); assert.equal(result.exists, false);
  assert.ok(result.duration < 190);
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
