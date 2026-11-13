import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { minimalEnv } from '../lib/managed-process.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { createWebDelivery, getWebShellFiles, installWebShell, verifyWebShell } from '../lib/web-delivery.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = 'export async function createApp(){return {handle(request){return {status:200,headers:{"content-type":"text/plain"},body:"protected fixture "+request.path}},close(){}}}\n';
const sourceFiles = () => [{ path: 'src/app.mjs', content: source }, { path: 'public/index.html', content: '<!doctype html><title>Protected fixture</title>' }];
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-delivery-test-'));
  const workspace = path.join(root, 'workspace'), cleanup = []; await fs.mkdir(workspace);
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('web-delivery-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, workspace, cleanup };
}
async function input(proposalFiles = sourceFiles()) {
  const { webManifest, databaseObserverHash } = await import('../lib/web-tests.mjs');
  const { browserManifest } = await import('../lib/web-browser-tests.mjs');
  const { webProfile } = await import('../lib/web-profile.mjs');
  const { projectReviewPolicy } = await import('../lib/project-review-model.mjs');
  const files = validateProjectFiles(proposalFiles);
  const binding = { projectId: 'project-1', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', specRevision: '1'.repeat(64),
    planRevision: '2'.repeat(64), candidateCommit: '3'.repeat(40), sourceHash: hash(JSON.stringify(files)),
    manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash };
  const result = manifest => ({ status: 'passed', binding: { ...binding }, profileId: webProfile.id, sourceHash: binding.sourceHash, manifestHash: manifest.hash,
    checks: manifest.checks.map(check => ({ ...check, passed: true })), terminationConfirmed: true,
    processes: [0, 1].map(() => ({ status: 'stopped', terminationConfirmed: true, sourceUnchanged: true, exitCode: 0, stopAcknowledged: true,
      stderr: 'C:\\Users\\private\\database.sqlite', databasePath: '/home/private/data.db' })) });
  const browserResult = result(browserManifest);
  browserResult.processes.push({ kind: 'browser', status: 'stopped', terminationConfirmed: true, exitCode: 0 });
  return { files, binding, requirements: '# Original requirement\nProvide an echo endpoint.',
    spec: { title: 'Echo fixture', requirementIds: ['R1'] }, plan: { tasks: [{ id: 'DEV-1', acceptance: ['Echo endpoint responds'] }] },
    report: { status: 'passed', binding: { ...binding }, test: { ...result(webManifest), databasePreflights: [], databaseCommands: [0, 1].map(() => ({
      kind: 'database_observation', runnerHash: databaseObserverHash, sourceHash: binding.sourceHash, exitCode: 0,
      terminationConfirmed: true, stopReason: null, truncated: false, stdout: 'private database observation', stderr: 'private host path',
    })) },
      browser: { ...browserResult, binding: { ...binding }, browser: { version: '123.0.1', closed: true } },
      review: { status: 'completed', binding: { ...binding }, policyHash: projectReviewPolicy.hash, openBlockingIssues: 0 },
      rawLogs: 'LLM_API_KEY=private-api-key; C:\\Users\\private\\.env; /home/private/data.db' } };
}
function unzip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    assert.equal(files.has(name), false); files.set(name, bytes.subarray(start, start + size)); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return files;
}

test('shell contains the complete trusted runtime and a fixed no-dependency protected start command', async () => {
  const files = await getWebShellFiles(), map = new Map(files.map(file => [file.path, file.content]));
  assert.equal(files.length, 11);
  assert.deepEqual(JSON.parse(map.get('package.json')).scripts, { start: 'node server.mjs' });
  assert.equal(JSON.parse(map.get('package.json')).engines.node, '>=22.21.0');
  assert.equal(JSON.parse(map.get('package.json')).dependencies, undefined);
  assert.deepEqual(JSON.parse(map.get('package-lock.json')).packages[''].engines, { node: '>=22.21.0' });
  assert.match(map.get('server.mjs'), /startWebRuntime/u);
  assert.doesNotMatch(map.get('server.mjs'), /import\s*\(?['"].*src\/app/u);
  assert.match(map.get('server.mjs'), /terminationConfirmed/u);
  assert.match(map.get('.env.example'), /EXECUTION_SANDBOX_EXE=\n$/u);
  assert.doesNotMatch(map.get('.env.example'), /[A-Za-z]:[\\/]/u);
  for (const file of files.filter(file => file.path.startsWith('runtime/'))) {
    assert.equal(file.content, await fs.readFile(new URL(`../lib/${path.posix.basename(file.path)}`, import.meta.url), 'utf8'));
  }
  files[0].content = 'tampered returned array';
  assert.notEqual((await getWebShellFiles())[0].content, 'tampered returned array');
});

test('shell install is exclusive, deterministic, idempotent and preserves unrelated local data', async t => {
  const { workspace } = await setup(t);
  await fs.writeFile(path.join(workspace, '.env'), 'LOCAL_PRIVATE=unchanged');
  const first = await installWebShell({ workspace }), before = await fs.stat(path.join(workspace, 'server.mjs'));
  const second = await installWebShell({ workspace }), after = await fs.stat(path.join(workspace, 'server.mjs'));
  assert.deepEqual(first, second); assert.equal(first.files.length, 11);
  assert.equal(first.hash, (await verifyWebShell({ workspace })).hash);
  assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(await fs.readFile(path.join(workspace, '.env'), 'utf8'), 'LOCAL_PRIVATE=unchanged');
  const concurrent = await Promise.all([installWebShell({ workspace }), verifyWebShell({ workspace })]);
  assert.ok(concurrent.every(item => item.hash === first.hash));
});

test('shell rejects unknown protected content before adding files and detects post-install tampering', async t => {
  const { workspace } = await setup(t);
  await fs.writeFile(path.join(workspace, 'server.mjs'), 'unknown original');
  await assert.rejects(installWebShell({ workspace }), /内容发生变化/u);
  assert.deepEqual(await fs.readdir(workspace), ['server.mjs']);
  assert.equal(await fs.readFile(path.join(workspace, 'server.mjs'), 'utf8'), 'unknown original');
  await fs.unlink(path.join(workspace, 'server.mjs')); await installWebShell({ workspace });
  await fs.appendFile(path.join(workspace, 'runtime', 'web-runtime.mjs'), '\n// changed');
  await assert.rejects(verifyWebShell({ workspace }), /内容发生变化/u);
  await assert.rejects(installWebShell({ workspace }), /内容发生变化/u);
});

test('shell rejects extra runtime files, directory aliases, file hard links and missing protected files', async t => {
  const { workspace, root } = await setup(t);
  await installWebShell({ workspace });
  await fs.writeFile(path.join(workspace, 'runtime', 'extra.mjs'), 'unknown');
  await assert.rejects(verifyWebShell({ workspace }), /非平台/u);
  await fs.unlink(path.join(workspace, 'runtime', 'extra.mjs'));
  await fs.unlink(path.join(workspace, 'server.mjs'));
  await assert.rejects(verifyWebShell({ workspace }), /缺失/u);
  const external = path.join(root, 'original.mjs'); await fs.writeFile(external, 'outside');
  await fs.link(external, path.join(workspace, 'server.mjs'));
  await assert.rejects(installWebShell({ workspace }), /硬链接/u);
  assert.equal(await fs.readFile(external, 'utf8'), 'outside');
});

test('shell refuses workspace and ancestor links, runtime junctions, root and relative directories', async t => {
  const { workspace, root } = await setup(t);
  for (const value of ['.', path.parse(workspace).root, path.join(workspace, 'missing')]) {
    await assert.rejects(installWebShell({ workspace: value }));
    await assert.rejects(verifyWebShell({ workspace: value }));
  }
  const linked = path.join(root, 'linked'); await fs.symlink(workspace, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installWebShell({ workspace: linked }), /链接/u);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workspace, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installWebShell({ workspace }), /链接/u);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(workspace), ['runtime']);
});

test('shell rejects case alias paths and serializes concurrent first installations', async t => {
  const { workspace } = await setup(t);
  await fs.writeFile(path.join(workspace, 'SERVER.mjs'), 'unknown');
  await assert.rejects(installWebShell({ workspace }), /冲突/u);
  await fs.unlink(path.join(workspace, 'SERVER.mjs'));
  const result = await Promise.all([installWebShell({ workspace }), installWebShell({ workspace })]);
  assert.deepEqual(result[0], result[1]);
});

test('shell installation failure removes only its own unchanged files and preserves other writer data', async t => {
  const { workspace } = await setup(t);
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'unrelated local file');
  const open = fs.open.bind(fs); let writes = 0;
  const mocked = t.mock.method(fs, 'open', async (filename, flags, ...rest) => {
    if ((flags & constants.O_EXCL) !== 0 && ++writes === 3) throw new Error('controlled write failure');
    return open(filename, flags, ...rest);
  });
  await assert.rejects(installWebShell({ workspace }), /安装失败/u);
  mocked.mock.restore();
  assert.deepEqual(await fs.readdir(workspace), ['notes.txt']);
  assert.equal(await fs.readFile(path.join(workspace, 'notes.txt'), 'utf8'), 'unrelated local file');
  writes = 0;
  const replaced = t.mock.method(fs, 'open', async (filename, flags, ...rest) => {
    if ((flags & constants.O_EXCL) !== 0 && ++writes === 3) {
      await fs.writeFile(path.join(workspace, '.env.example'), 'other writer data');
      throw new Error('controlled later write failure');
    }
    return open(filename, flags, ...rest);
  });
  await assert.rejects(installWebShell({ workspace }), /安装失败/u);
  replaced.mock.restore();
  assert.equal(await fs.readFile(path.join(workspace, '.env.example'), 'utf8'), 'other writer data');
  assert.equal(await fs.readFile(path.join(workspace, 'notes.txt'), 'utf8'), 'unrelated local file');
});

test('accepted delivery contains source, fixed shell and bound sanitized evidence with every file hash', async () => {
  const options = await input();
  options.requirements += '\nPublic API reference: https://example.test/docs; preview http://127.0.0.1 is local.';
  const result = await createWebDelivery(options), contents = unzip(result.zip);
  assert.equal(contents.get('src/app.mjs').toString(), source);
  assert.equal(contents.get('delivery/requirements.md').toString(), options.requirements);
  assert.deepEqual(JSON.parse(contents.get('delivery/spec.json')), options.spec);
  assert.deepEqual(JSON.parse(contents.get('delivery/plan.json')), options.plan);
  assert.deepEqual(JSON.parse(contents.get('delivery/manifest.json')), result.manifest);
  assert.deepEqual(result.manifest.binding, options.binding);
  assert.equal(result.manifest.validation.status, 'previously_passed');
  for (const file of result.manifest.files) {
    assert.equal(file.sha256, hash(contents.get(file.path))); assert.equal(file.bytes, contents.get(file.path).length);
  }
  assert.equal(contents.size, result.manifest.files.length + 1);
  const evidence = contents.get('delivery/acceptance.json').toString();
  assert.doesNotMatch(evidence, /private-api-key|Users|private|databasePath|rawLogs|stderr/u);
  assert.equal(JSON.parse(evidence).browser.browser.closed, true);
  assert.equal([...contents.keys()].some(name => name === '.env' || /\.(?:db|sqlite)(?:-|$)/u.test(name) || name.startsWith('.platform/')), false);
  assert.equal(result.manifest.shellHash, hash(JSON.stringify(await getWebShellFiles())));
});

test('delivery refuses stale or missing binding fields, changed source and old policy hashes', async () => {
  const options = await input();
  for (const key of Object.keys(options.binding)) {
    const changed = structuredClone(options);
    changed.report.binding[key] = key.endsWith('Id') ? 'different-id' : key === 'candidateCommit' ? '0'.repeat(40) : '0'.repeat(64);
    await assert.rejects(createWebDelivery(changed));
    const missing = structuredClone(options); delete missing.binding[key];
    await assert.rejects(createWebDelivery(missing));
  }
  const changedSource = structuredClone(options); changedSource.files[0].content += '\n// changed';
  await assert.rejects(createWebDelivery(changedSource), /sourceHash/u);
  for (const key of ['manifestHash', 'browserManifestHash', 'reviewPolicyHash']) {
    const old = structuredClone(options); old.binding[key] = old.report.binding[key] = '0'.repeat(64);
    await assert.rejects(createWebDelivery(old), /变化/u);
  }
});

test('delivery binds every independent branch to all eleven current identity fields', async () => {
  const options = await input();
  for (const role of ['test', 'browser', 'review']) {
    const missingBranchBinding = structuredClone(options); delete missingBranchBinding.report[role].binding;
    await assert.rejects(createWebDelivery(missingBranchBinding), undefined, `${role} needs its own binding`);
    for (const key of Object.keys(options.binding)) {
      const stale = structuredClone(options);
      stale.report[role].binding[key] = key.endsWith('Id') ? 'old-identity' : key === 'candidateCommit' ? '0'.repeat(40) : '0'.repeat(64);
      await assert.rejects(createWebDelivery(stale), undefined, `${role}.${key} cannot be stale`);
      const missingField = structuredClone(options); delete missingField.report[role].binding[key];
      await assert.rejects(createWebDelivery(missingField), undefined, `${role}.${key} cannot be omitted`);
    }
  }
});

test('delivery needs every exact HTTP and browser check and independently confirmed process termination', async () => {
  const options = await input();
  const changes = [
    value => { value.report.status = 'diagnostic_passed'; },
    value => { delete value.report.browser; },
    value => { value.report.review.status = 'failed'; },
    value => { value.report.review.openBlockingIssues = 1; },
    value => { value.report.review.policyHash = '0'.repeat(64); },
    value => { value.report.review.kind = 'diagnostic'; },
    value => { value.report.browser.browser.closed = false; },
    value => { value.report.browser.binding.candidateCommit = '0'.repeat(40); },
    value => { value.report.browser.processes.pop(); },
    value => { value.report.browser.processes.push({ kind: 'browser', status: 'stopped', terminationConfirmed: true, exitCode: 0 }); },
    value => { value.report.browser.processes.at(-1).exitCode = 1; },
    value => { value.report.browser.processes.splice(0, 1); },
    value => { value.report.test.processes[0].kind = 'browser'; },
    value => { value.report.test.databaseCommands = []; },
    value => { delete value.report.test.databasePreflights; },
    value => { value.report.test.databasePreflights = [{ kind: 'database_preflight', terminationConfirmed: false }]; },
    value => { value.report.test.databasePreflights = [{ kind: 'database_preflight', terminationConfirmed: true }]; },
    value => { value.report.test.databaseCommands.pop(); },
    value => { value.report.test.databaseCommands[0].kind = 'candidate-result'; },
    value => { value.report.test.databaseCommands[0].runnerHash = '0'.repeat(64); },
    value => { value.report.test.databaseCommands[0].sourceHash = '0'.repeat(64); },
    value => { value.report.test.databaseCommands[0].exitCode = 1; },
    value => { value.report.test.databaseCommands[0].terminationConfirmed = false; },
    value => { value.report.test.databaseCommands[0].stopReason = 'timeout'; },
    value => { value.report.test.databaseCommands[0].truncated = true; },
  ];
  for (const role of ['test', 'browser']) changes.push(
    value => { value.report[role].status = 'failed'; },
    value => { value.report[role].sourceHash = '0'.repeat(64); },
    value => { value.report[role].manifestHash = '0'.repeat(64); },
    value => { value.report[role].profileId = 'other-profile'; },
    value => { value.report[role].terminationConfirmed = false; },
    value => { value.report[role].processes = []; },
    value => { value.report[role].processes = value.report[role].processes.slice(0, 1); },
    value => { value.report[role].processes[0].terminationConfirmed = false; },
    value => { value.report[role].processes[0].status = 'failed'; },
    value => { value.report[role].processes[0].sourceUnchanged = false; },
    value => { value.report[role].processes[0].exitCode = 1; },
    value => { value.report[role].processes[0].stopAcknowledged = false; },
    value => { value.report[role].checks = []; },
    value => { value.report[role].checks.pop(); },
    value => { value.report[role].checks[0].passed = false; },
    value => { value.report[role].checks[0].id = 'candidate-added-check'; },
    value => { value.report[role].checks.push(value.report[role].checks[0]); },
    value => { value.report[role].checks[1] = { ...value.report[role].checks[0] }; },
    value => { value.report[role].checks[0].name = 'candidate replaced assertion'; },
  );
  for (const change of changes) { const changed = structuredClone(options); change(changed); await assert.rejects(createWebDelivery(changed)); }
});

test('delivery rejects protected model paths, environment files, credentials and host paths', async () => {
  const options = await input();
  for (const relative of ['server.mjs', 'package.json', 'package-lock.json', 'START-HERE.md', '.env.example', '.env', 'runtime/web-runtime.mjs', 'src/data.sqlite', 'docs/.env.example']) {
    const changed = structuredClone(options); changed.files.push({ path: relative, content: 'must not ship' });
    await assert.rejects(createWebDelivery(changed));
  }
  for (const secret of ['LLM_API_KEY="super-secret-value"', 'https://user:password@example.test/api', 'C:\\Users\\private\\data.db', '\\\\host\\share\\secret', '/home/private/token', 'sk-1234567890abcdefghijklmnop']) {
    const changed = structuredClone(options); changed.requirements = secret;
    await assert.rejects(createWebDelivery(changed), /凭据|绝对路径/u);
    const code = structuredClone(options); code.files[0].content = `export const secret = ${JSON.stringify(secret)};`;
    code.binding.sourceHash = code.report.binding.sourceHash = hash(JSON.stringify(validateProjectFiles(code.files)));
    await assert.rejects(createWebDelivery(code), /凭据|绝对路径/u);
  }
  let invoked = false;
  const accessor = structuredClone(options);
  Object.defineProperty(accessor.report, 'status', { get: () => { invoked = true; return 'passed'; } });
  await assert.rejects(createWebDelivery(accessor), /普通数据/u); assert.equal(invoked, false);
});

test('delivery refuses unquoted commented credentials and authorization headers without echoing their values', async () => {
  const options = await input(), fakeSecret = ['REVIEW', 'FAKE', 'SECRET', '123456'].join('_');
  for (const material of [
    `LLM_API_KEY=${fakeSecret} # local`,
    `LLM_API_KEY=${fakeSecret}#local`,
    `Authorization: Bearer ${fakeSecret}`,
    `authorization:Bearer ${fakeSecret}`,
    `Authorization: Basic ${Buffer.from(fakeSecret).toString('base64')}`,
  ]) {
    const changed = structuredClone(options); changed.requirements = material;
    await assert.rejects(createWebDelivery(changed), error => /凭据|绝对路径/u.test(error.message) && !error.message.includes(fakeSecret));
    const code = await input([{ path: 'src/app.mjs', content: `export const value = ${JSON.stringify(material)};` }]);
    await assert.rejects(createWebDelivery(code), error => /凭据|绝对路径/u.test(error.message) && !error.message.includes(fakeSecret));
  }
});

function launch(workspace, { executable = '', npm = false } = {}) {
  const command = npm && process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : process.execPath;
  const args = npm && process.platform === 'win32' ? ['/d', '/s', '/c', 'npm start'] : ['server.mjs'];
  const child = spawn(command, args, { cwd: workspace, windowsHide: true, shell: false,
    env: { ...minimalEnv(), EXECUTION_SANDBOX_EXE: executable }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  return { child, done, stdout: () => stdout };
}

async function ensureStopped(launched) {
  if (launched.child.exitCode !== null) return launched.done;
  launched.child.stdin.write('STOP\n');
  const timer = setTimeout(() => {
    if (process.platform === 'win32') {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(launched.child.pid), '/T', '/F'],
        { windowsHide: true, shell: false, stdio: 'ignore', env: minimalEnv() });
      killer.on('error', () => launched.child.kill());
    } else launched.child.kill();
  }, 7000);
  try { return await launched.done; } finally { clearTimeout(timer); }
}

async function extractDelivery(workspace, delivery) {
  for (const [name, content] of unzip(delivery.zip)) {
    const target = path.resolve(workspace, ...name.split('/')), relative = path.relative(workspace, target);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { flag: 'wx' });
  }
  assert.equal((await verifyWebShell({ workspace })).hash, delivery.manifest.shellHash);
}

async function readyUrl(launched) {
  for (let count = 0; count < 500; count++) {
    const url = /Preview URL: (http:\/\/[^\s]+)/u.exec(launched.stdout())?.[1];
    if (url) return url;
    if (launched.child.exitCode !== null) assert.fail(JSON.stringify(await launched.done));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('packaged launcher did not report preview readiness');
}

test('packaged launcher fails closed without MXC and never imports candidate code on the host', async t => {
  const { workspace } = await setup(t); await installWebShell({ workspace });
  await fs.mkdir(path.join(workspace, 'src'));
  await fs.writeFile(path.join(workspace, 'src/app.mjs'), 'import {writeFileSync} from "node:fs";writeFileSync("host-executed.txt","wrong");export function createApp(){throw new Error("wrong host import")}');
  const process = launch(workspace);
  const timer = setTimeout(() => process.child.kill(), 10_000);
  try {
    const result = await process.done;
    assert.equal(result.code, 1); assert.match(result.stderr, /Protected startup refused/u);
    assert.doesNotMatch(result.stdout, /Preview URL/u);
    await assert.rejects(fs.stat(path.join(workspace, 'host-executed.txt')), { code: 'ENOENT' });
  } finally { clearTimeout(timer); }
});

test('packaged launcher rejects changed trusted runtime before importing its module', async t => {
  const { workspace } = await setup(t); await installWebShell({ workspace });
  await fs.mkdir(path.join(workspace, 'src')); await fs.writeFile(path.join(workspace, 'src/app.mjs'), source);
  await fs.writeFile(path.join(workspace, 'runtime', 'web-runtime.mjs'), 'import {writeFileSync} from "node:fs";writeFileSync("host-executed.txt","wrong");export function startWebRuntime(){throw new Error("wrong import")}');
  const launched = launch(workspace, { executable: process.execPath });
  const timer = setTimeout(() => launched.child.kill(), 10_000);
  try {
    const result = await launched.done;
    assert.equal(result.code, 1); assert.match(result.stderr, /Protected startup refused/u);
    await assert.rejects(fs.stat(path.join(workspace, 'host-executed.txt')), { code: 'ENOENT' });
  } finally { clearTimeout(timer); }
});

test('real packaged ZIP npm start serves a trusted echo fixture through MXC and confirms STOP', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 40_000,
}, async t => {
  const { workspace, cleanup } = await setup(t);
  // Synthetic service verdicts exercise packaging only; this fixture is not a business acceptance claim.
  const delivery = await createWebDelivery(await input());
  await extractDelivery(workspace, delivery);
  const launched = launch(workspace, { executable: process.env.EXECUTION_SANDBOX_EXE, npm: true });
  cleanup.push(() => ensureStopped(launched));
  const url = await readyUrl(launched);
  const response = await fetch(url + '/echo');
  assert.equal(response.status, 200); assert.equal(await response.text(), 'protected fixture /echo');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/u);
  launched.child.stdin.write('STOP\n');
  const result = await launched.done;
  assert.equal(result.code, 0); assert.match(result.stdout, /STOP_CONFIRMED/u);
  await assert.rejects(fetch(url));
  assert.equal(await fs.readFile(path.join(workspace, 'src', 'app.mjs'), 'utf8'), source);
  assert.equal((await verifyWebShell({ workspace })).hash, hash(JSON.stringify(await getWebShellFiles())));
});

test('real packaged launcher exits nonzero when a hanging close must be killed despite confirmed termination', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 40_000,
}, async t => {
  const { workspace, cleanup } = await setup(t);
  const hangingSource = 'export async function createApp(){return {handle(){return {status:200,body:"close fixture"}},close(){setInterval(()=>{},20);return new Promise(()=>{})}}}\n';
  // A trusted transport fixture with synthetic service verdicts, never a business acceptance claim.
  const delivery = await createWebDelivery(await input([{ path: 'src/app.mjs', content: hangingSource }]));
  await extractDelivery(workspace, delivery);
  const launched = launch(workspace, { executable: process.env.EXECUTION_SANDBOX_EXE, npm: true });
  cleanup.push(() => ensureStopped(launched));
  const url = await readyUrl(launched);
  assert.equal(await (await fetch(url)).text(), 'close fixture');
  launched.child.stdin.write('STOP\n');
  const result = await launched.done;
  assert.equal(result.code, 1, 'confirmed force termination must not look like a normal application close');
  assert.match(result.stdout, /STOP_CONFIRMED/u);
  assert.match(result.stderr, /did not finish cleanly/u);
  await assert.rejects(fetch(url));
  assert.equal(await fs.readFile(path.join(workspace, 'src/app.mjs'), 'utf8'), hangingSource);
  assert.equal((await verifyWebShell({ workspace })).hash, delivery.manifest.shellHash);
});
