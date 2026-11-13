import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateProjectFiles } from './project-files.mjs';
import { createZip } from './zip.mjs';

const runtimeNames = ['managed-process.mjs', 'web-protocol.mjs', 'web-runtime.mjs', 'web-worker.cjs', 'windows-sandbox.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fold = value => value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
const fail = message => { throw new Error(message); };
const queues = new Map();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sorted = files => files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const packageFile = {
  name: 'taskflow-protected-web-project', version: '1.0.0', private: true, type: 'module',
  engines: { node: '>=22.21.0' }, scripts: { start: 'node server.mjs' },
};
const json = value => JSON.stringify(value, null, 2) + '\n';
const serverSource = `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const workspace = path.dirname(fileURLToPath(import.meta.url));
const runtimeIntegrity = __TASKFLOW_RUNTIME_INTEGRITY__;
const controller = new AbortController();
let runtime, stopping = false, input = '';
const stoppedCleanly = result => result.terminationConfirmed === true && result.status === 'stopped'
  && result.exitCode === 0 && result.stopAcknowledged === true && result.sourceUnchanged === true;
function stop() {
  if (stopping) return;
  stopping = true;
  if (runtime) void runtime.stop(); else controller.abort();
}
const receive = chunk => {
  input += chunk;
  if (input.length > 4096) input = '';
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end).trim(); input = input.slice(end + 1);
    if (line === 'STOP') stop();
  }
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
process.stdin.setEncoding('utf8'); process.stdin.on('data', receive); process.stdin.resume();
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'win32' || major < 22 || (major === 22 && minor < 21)) throw new Error();
  // Only the executor path is read. Application credentials never enter the worker.
  if (!process.env.EXECUTION_SANDBOX_EXE) {
    let text = '';
    try { text = await readFile(path.join(workspace, '.env'), 'utf8'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const line = text.split(/\\r?\\n/u).find(value => /^\\s*EXECUTION_SANDBOX_EXE\\s*=/u.test(value));
    if (line) {
      let value = line.slice(line.indexOf('=') + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env.EXECUTION_SANDBOX_EXE = value;
    }
  }
  if (!process.env.EXECUTION_SANDBOX_EXE) throw new Error();
  const directory = path.join(workspace, 'runtime'), directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error();
  for (const file of runtimeIntegrity) {
    const target = path.join(workspace, ...file.path.split('/')), info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== file.bytes) throw new Error();
    if (createHash('sha256').update(await readFile(target)).digest('hex') !== file.sha256) throw new Error();
  }
  // Trusted runtime bytes are checked before any local runtime module is imported.
  const { startWebRuntime } = await import('./runtime/web-runtime.mjs');
  runtime = await startWebRuntime({ workspace, signal: controller.signal, timeoutMs: 600000 });
  if (stopping) void runtime.stop();
  console.log('Preview URL: ' + runtime.url);
  console.log('Press Ctrl+C or enter STOP to stop. Session limit: 10 minutes.');
  const result = await runtime.done;
  if (result.terminationConfirmed) console.log('STOP_CONFIRMED');
  if (!stoppedCleanly(result)) {
    console.error('Protected application did not finish cleanly. Check the execution environment before restarting.');
    process.exitCode = 1;
  }
} catch {
  console.error('Protected startup refused. Windows, Node.js >=22.21.0 and a working EXECUTION_SANDBOX_EXE with Windows MXC are required.');
  process.exitCode = 1;
} finally {
  if (runtime) {
    const result = await runtime.stop();
    if (!stoppedCleanly(result)) process.exitCode = 1;
  }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  process.stdin.removeListener('data', receive); process.stdin.pause();
}
`;

/** Platform-owned launcher and its complete dependency closure. Never contains candidate imports. */
export async function getWebShellFiles() {
  const runtime = await Promise.all(runtimeNames.map(async name => ({ path: `runtime/${name}`, content: await fs.readFile(new URL(name, import.meta.url), 'utf8') })));
  return sorted([
    { path: 'package.json', content: json(packageFile) },
    { path: 'package-lock.json', content: json({ name: packageFile.name, version: packageFile.version, lockfileVersion: 3, requires: true,
      packages: { '': { name: packageFile.name, version: packageFile.version, engines: packageFile.engines } } }) },
    { path: 'server.mjs', content: serverSource.replace('__TASKFLOW_RUNTIME_INTEGRITY__', JSON.stringify(runtime.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) })))) },
    { path: '.env.example', content: '# Set the absolute path of the native Codex executable that supports Windows MXC.\nEXECUTION_SANDBOX_EXE=\n' },
    { path: '.gitignore', content: '.env\n.platform/\nnode_modules/\n*.sqlite\n*.sqlite-*\n*.db\n*.db-*\n' },
    { path: 'START-HERE.md', content: '# Run this protected project\n\nRequires Windows, Node.js >=22.21.0, npm, and a native Codex executable with working Windows MXC. No npm dependencies or npm install are required.\n\n1. Set EXECUTION_SANDBOX_EXE in the environment, or copy .env.example to .env and fill in that executable path.\n2. Run npm start in this folder. Open the printed random localhost preview URL.\n3. Press Ctrl+C or enter STOP. Wait for STOP_CONFIRMED before restarting or editing files. A session stops after ten minutes.\n\nThe launcher runs src/app.mjs only inside Windows MXC with networking disabled and source files read-only. SQLite data is written only to .platform/tmp/app.sqlite and stays local. Missing or failed protection refuses startup. Keep the platform-owned root files and runtime folder unchanged.\n\nThe delivery/ folder records the previously accepted candidate and its version bindings. Extracting or downloading this package does not run new acceptance tests, and it contains no database or local .env.\n' },
    ...runtime,
  ]);
}

async function statOrNull(target) {
  try { return await fs.lstat(target, { bigint: true }); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}
function ordinary(stat, directory = false) {
  if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1n)) fail('保护路径包含链接、硬链接或非普通文件，已拒绝访问。');
}
async function rootContext(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')) fail('请提供已存在的可信工作区绝对路径。');
  const root = path.resolve(workspace), anchor = path.parse(root).root;
  if (root === anchor) fail('文件系统根目录不能作为工作区。');
  let current = anchor;
  ordinary(await statOrNull(current), true);
  for (const part of root.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); ordinary(await statOrNull(current), true);
  }
  if (fold(await fs.realpath(root)) !== fold(root)) fail('工作区路径解析越界。');
  return { root, stat: await fs.lstat(root, { bigint: true }) };
}
async function assertRoot(context) {
  if (!sameFile(context.stat, (await rootContext(context.root)).stat)) fail('工作区已被替换，已停止访问。');
}
async function inspect(context, relative) {
  await assertRoot(context);
  const target = path.resolve(context.root, ...relative.split('/'));
  const boundary = path.relative(context.root, target);
  if (!boundary || boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) fail('保护路径越过工作区边界。');
  let parent = context.root;
  for (const [index, segment] of relative.split('/').entries()) {
    const names = await fs.readdir(parent);
    if (names.some(name => fold(name) === fold(segment) && name !== segment)) fail('保护路径存在大小写或 Unicode 冲突。');
    const child = path.join(parent, segment), stat = await statOrNull(child);
    if (!stat) return null;
    ordinary(stat, index < relative.split('/').length - 1);
    if (index === relative.split('/').length - 1) return stat;
    parent = child;
  }
}
async function checkRuntimeDirectory(context) {
  await assertRoot(context);
  const names = await fs.readdir(context.root);
  if (names.some(name => fold(name) === 'runtime' && name !== 'runtime')) fail('保护路径存在大小写或 Unicode 冲突。');
  const directory = path.join(context.root, 'runtime'), stat = await statOrNull(directory);
  if (!stat) return;
  ordinary(stat, true);
  for (const name of await fs.readdir(directory)) {
    if (!runtimeNames.includes(name)) fail('runtime 目录包含非平台保护文件。');
    ordinary(await fs.lstat(path.join(directory, name), { bigint: true }));
  }
}
async function readProtected(context, file, before) {
  if (before.size !== BigInt(Buffer.byteLength(file.content))) fail('平台保护文件内容发生变化。');
  const handle = await fs.open(path.join(context.root, ...file.path.split('/')), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }); ordinary(opened);
    if (!sameVersion(before, opened)) fail('平台保护文件在打开时变化。');
    const chunks = []; let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(16 * 1024), { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > Buffer.byteLength(file.content)) fail('平台保护文件读取超限。');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    const after = await inspect(context, file.path);
    if (!after || !sameVersion(before, after) || !sameVersion(before, await handle.stat({ bigint: true }))) fail('平台保护文件在读取时变化。');
    if (!bytes.equals(Buffer.from(file.content))) fail('平台保护文件内容发生变化。');
  } finally { await handle.close(); }
}
async function inspectShell(context, files, requireAll) {
  await checkRuntimeDirectory(context);
  for (const file of files) {
    const before = await inspect(context, file.path);
    if (before) await readProtected(context, file, before);
    else if (requireAll) fail('平台保护文件缺失。');
  }
}
async function locked(workspace, run) {
  const key = typeof workspace === 'string' ? fold(path.resolve(workspace)) : '';
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

/** Caller must own this isolated workspace and stop all candidate processes before installation. */
export async function installWebShell({ workspace } = {}) {
  return locked(workspace, async () => {
    const context = await rootContext(workspace), files = await getWebShellFiles();
    await inspectShell(context, files, false);
    let runtimeCreated = null;
    const created = [];
    try {
      if (!await statOrNull(path.join(context.root, 'runtime'))) {
        await assertRoot(context); await fs.mkdir(path.join(context.root, 'runtime'), { mode: 0o700 });
        runtimeCreated = await fs.lstat(path.join(context.root, 'runtime'), { bigint: true });
      }
      for (const file of files) {
        if (await inspect(context, file.path)) continue;
        const target = path.join(context.root, ...file.path.split('/'));
        const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        const entry = { path: file.path, target, stat: await handle.stat({ bigint: true }) };
        created.push(entry);
        try { await handle.writeFile(file.content, 'utf8'); await handle.sync(); entry.stat = await handle.stat({ bigint: true }); }
        finally { await handle.close(); }
      }
      await inspectShell(context, files, true);
      return { hash: hash(JSON.stringify(files)), files: files.map(file => file.path) };
    } catch {
      for (const entry of created.reverse()) {
        try {
          const current = await inspect(context, entry.path);
          if (current && sameVersion(current, entry.stat)) await fs.unlink(entry.target);
        } catch { /* Never remove unknown replacements. */ }
      }
      if (runtimeCreated) {
        try {
          await assertRoot(context);
          const current = await statOrNull(path.join(context.root, 'runtime')); ordinary(current, true);
          if (sameFile(current, runtimeCreated)) await fs.rmdir(path.join(context.root, 'runtime'));
        }
        catch { /* Preserve populated or replaced directories. */ }
      }
      fail('保护外壳安装失败，已停止；未知文件及替换数据保留，请核对工作区。');
    }
  });
}

export async function verifyWebShell({ workspace } = {}) {
  return locked(workspace, async () => {
    const context = await rootContext(workspace), files = await getWebShellFiles();
    await inspectShell(context, files, true);
    return { hash: hash(JSON.stringify(files)) };
  });
}

const bindingKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'sourceHash', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash'];
function dataObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) fail(`${label}必须是普通数据对象。`);
  return value;
}
function validateBinding(value) {
  const binding = dataObject(value, '版本绑定');
  if (Object.keys(binding).length !== bindingKeys.length || bindingKeys.some(key => !Object.hasOwn(binding, key))) fail('版本绑定必须包含完整且唯一的当前验收字段。');
  const normalized = {};
  for (const key of bindingKeys) {
    const value = binding[key], expression = key === 'candidateCommit' ? /^[a-f0-9]{40}$/u
      : key.endsWith('Id') ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u : /^[a-f0-9]{64}$/u;
    if (typeof value !== 'string' || !expression.test(value)) fail('版本绑定格式无效。');
    normalized[key] = value;
  }
  return normalized;
}
function safeMaterial(value, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) || Buffer.byteLength(value) > 512 * 1024) fail(`${label}必须是有界 UTF-8 文本。`);
  const inspected = value.replace(/\\(["'\\/])/gu, '$1');
  if ([value, inspected].some(text => /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|(?:^|[\s"'=(:])\/(?:Users|home|tmp|var|etc|root|opt|usr|mnt|Volumes|private)\//mu.test(text))
    || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u.test(inspected)
    || /\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\b["']?\s*[:=]\s*["'](?:Bearer\s+)?[^"'\s]{8,}["']/iu.test(inspected)
    || /(?:^|[\r\n"'])\s*(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*=\s*[^\s"'#]{8,}(?:[ \t]*#[^\r\n"']*)?[ \t]*(?=$|[\r\n"'])/imu.test(inspected)
    || /\bauthorization\b["']?\s*[:=]\s*["']?\s*(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{8,}/iu.test(inspected)
    || /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu.test(inspected)) fail(`${label}包含凭据或宿主绝对路径，不能加入交付包。`);
  return value;
}
function document(value, label) {
  if (typeof value === 'string') {
    if (!value.trim()) fail(`${label}不能为空。`);
    return { suffix: 'md', content: safeMaterial(value, label) };
  }
  if (value === null) fail(`${label}不能为空。`);
  const visit = (item, depth = 0) => {
    if (depth > 32) fail(`${label}嵌套层级过深。`);
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || typeof item === 'string') return item;
    if (Array.isArray(item)) { if (item.length > 2000) fail(`${label}过大。`); return item.map(child => visit(child, depth + 1)); }
    const object = dataObject(item, label), result = {};
    if (Object.keys(object).length > 2000) fail(`${label}过大。`);
    for (const key of Object.keys(object)) Object.defineProperty(result, key, { value: visit(object[key], depth + 1), enumerable: true });
    return result;
  };
  return { suffix: 'json', content: safeMaterial(json(visit(value)), label) };
}

/** Trusted caller supplies the accepted CURRENT binding. A download never creates a new test verdict. */
export async function createWebDelivery({ files, binding, report, requirements, spec, plan } = {}) {
  const sources = validateProjectFiles(files), current = validateBinding(binding);
  if (!sources.some(file => file.path === 'src/app.mjs')) fail('交付项目必须包含 src/app.mjs。');
  for (const file of sources) {
    if (file.path.split('/').some(part => /^\.env(?:\.|$)/iu.test(part))) fail('本地环境配置不能加入交付包。');
    safeMaterial(file.content, '项目源码');
  }
  if (hash(JSON.stringify(sources)) !== current.sourceHash) fail('交付源码与已验收候选的 sourceHash 不一致。');
  const { webManifest, databaseObserverHash } = await import('./web-tests.mjs');
  const { webProfile } = await import('./web-profile.mjs');
  const { browserManifest } = await import('./web-browser-tests.mjs');
  const { projectReviewPolicy } = await import('./project-review-model.mjs');
  const shell = await getWebShellFiles();
  if (current.manifestHash !== webManifest.hash) fail('当前验收清单已变化，不能复用旧通过结果。');
  if (current.browserManifestHash !== browserManifest.hash || current.reviewPolicyHash !== projectReviewPolicy.hash) fail('浏览器或 Review 规则已变化，不能复用旧通过结果。');
  const accepted = dataObject(report, '验收报告'), recorded = validateBinding(accepted.binding);
  if (accepted.status !== 'passed' || bindingKeys.some(key => current[key] !== recorded[key])) fail('验收报告未通过或不属于当前候选版本。');
  const test = dataObject(accepted.test, '测试结论'), browser = dataObject(accepted.browser, '浏览器结论'), review = dataObject(accepted.review, '审查结论');
  for (const [label, result] of [['独立测试', test], ['浏览器验收', browser], ['独立审查', review]]) {
    const branchBinding = validateBinding(result.binding);
    if (bindingKeys.some(key => current[key] !== branchBinding[key])) fail(`${label}结论不属于当前候选版本。`);
  }
  const checkResult = (result, manifest, expectedHash, label, withBrowser = false) => {
    if (result.status !== 'passed' || result.terminationConfirmed !== true || result.manifestHash !== expectedHash
      || result.sourceHash !== current.sourceHash || result.profileId !== webProfile.id || !Array.isArray(result.processes) || !result.processes.length || result.processes.length > 16
      || result.processes.some(process => {
        const record = dataObject(process, '进程结论');
        if (record.kind === 'browser') return !withBrowser || record.terminationConfirmed !== true || record.status !== 'stopped' || record.exitCode !== 0;
        return (record.kind !== undefined && record.kind !== 'runtime') || record.terminationConfirmed !== true || record.status !== 'stopped'
          || record.sourceUnchanged !== true || record.exitCode !== 0 || record.stopAcknowledged !== true;
      })) fail(`${label}、源码或进程停止证据不完整。`);
    const browserCount = result.processes.filter(record => record.kind === 'browser').length;
    if (browserCount !== (withBrowser ? 1 : 0) || result.processes.length - browserCount < 2) fail(`${label}缺少完整的独立运行进程记录。`);
    if (!Array.isArray(result.checks) || result.checks.length !== manifest.count || manifest.checks.length !== manifest.count) fail(`${label}清单不完整。`);
    const checkIds = new Set();
    for (const check of result.checks) {
      dataObject(check, '测试检查项');
      const definition = manifest.checks.find(item => item.id === check.id);
      if (!definition || checkIds.has(check.id) || check.passed !== true || (check.name !== undefined && check.name !== definition.name)) fail(`${label}检查项缺失、重复或未通过。`);
      checkIds.add(check.id);
    }
  };
  checkResult(test, webManifest, current.manifestHash, '独立测试');
  checkResult(browser, browserManifest, current.browserManifestHash, '浏览器验收', true);
  // This list records failed preflights only; a passed attempt must have none.
  if (!Array.isArray(test.databasePreflights) || test.databasePreflights.length !== 0) fail('存在失败或停止待协调的数据库预检记录，不能交付。');
  if (typeof databaseObserverHash !== 'string' || !/^[a-f0-9]{64}$/u.test(databaseObserverHash)
    || !Array.isArray(test.databaseCommands) || test.databaseCommands.length !== 2 || test.databaseCommands.some(command => {
      const record = dataObject(command, '数据库观察结论');
      return record.kind !== 'database_observation' || record.runnerHash !== databaseObserverHash || record.sourceHash !== current.sourceHash
        || record.exitCode !== 0 || record.terminationConfirmed !== true || record.stopReason !== null || record.truncated !== false;
    })) fail('数据库观察证据不完整、版本不匹配或停止未确认。');
  if (dataObject(browser.browser, '浏览器状态').closed !== true
    || typeof browser.browser.version !== 'string' || !/^\d{1,5}(?:\.\d{1,8}){1,3}$/u.test(browser.browser.version)) fail('浏览器版本绑定不一致或尚未确认关闭。');
  if (review.status !== 'completed' || review.openBlockingIssues !== 0 || review.policyHash !== current.reviewPolicyHash
    || (review.kind !== undefined && review.kind !== 'model')) fail('独立审查未完成、规则不匹配或仍有阻塞问题。');
  const requirementDocument = document(requirements, '原始需求'), specDocument = document(spec, '规格'), planDocument = document(plan, '计划');
  if (typeof requirements !== 'string') fail('原始需求必须为文本快照。');
  const summary = { status: 'passed', binding: current,
    test: { status: 'passed', profileId: webProfile.id, manifestHash: webManifest.hash, sourceHash: current.sourceHash, terminationConfirmed: true,
      processCount: test.processes.length, database: { observations: 2, runnerHash: databaseObserverHash, sourceHash: current.sourceHash, terminationConfirmed: true },
      checks: webManifest.checks.map(check => ({ id: check.id, name: check.name, passed: true })) },
    browser: { status: 'passed', profileId: webProfile.id, manifestHash: browserManifest.hash, sourceHash: current.sourceHash, terminationConfirmed: true,
      browser: { version: browser.browser.version, closed: true }, processCount: browser.processes.length,
      checks: browserManifest.checks.map(check => ({ id: check.id, name: check.name, passed: true })) },
    review: { status: 'completed', policyHash: current.reviewPolicyHash, openBlockingIssues: 0 },
    notice: '此记录属于绑定候选的既有验收；下载、解压和启动不代表重新通过验收。' };
  const payload = sorted([...sources, ...shell,
    { path: 'delivery/requirements.md', content: requirementDocument.content },
    { path: `delivery/spec.${specDocument.suffix}`, content: specDocument.content },
    { path: `delivery/plan.${planDocument.suffix}`, content: planDocument.content },
    { path: 'delivery/acceptance.json', content: json(summary) },
  ]);
  const manifest = { format: 'taskflow-web-delivery-v1', binding: current, sourceHash: current.sourceHash, shellHash: hash(JSON.stringify(shell)),
    execution: { platform: 'win32', node: '>=22.21.0', isolation: 'windows-mxc', network: false, source: 'read-only', entry: 'server.mjs' },
    validation: { manifestHash: webManifest.hash, databaseObserverHash, browserManifestHash: browserManifest.hash,
      reviewPolicyHash: current.reviewPolicyHash, status: 'previously_passed' },
    hashScope: '全部交付文件，不含 delivery/manifest.json 本身',
    files: payload.map(file => ({ path: file.path, sha256: hash(file.content), bytes: Buffer.byteLength(file.content) })) };
  return { zip: createZip([...payload, { path: 'delivery/manifest.json', content: json(manifest) }].map(file => ({ name: file.path, content: file.content }))), manifest };
}
