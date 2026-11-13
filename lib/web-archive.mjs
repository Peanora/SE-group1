import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { crc32 } from './zip.mjs';
import { validateProjectFiles } from './project-files.mjs';
import { getWebShellFiles } from './web-delivery.mjs';
import { runWebTests, webManifest, databaseObserverHash } from './web-tests.mjs';
import { runWebBrowserTests, browserManifest } from './web-browser-tests.mjs';
import { projectReviewPolicy } from './project-review-model.mjs';

const MAX_ARCHIVE = 8 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const utf8 = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('交付文件不是有效UTF-8文本。'); } };
const bindingKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'sourceHash', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash'];

async function outputDirectory(directory) {
  const absolute = path.resolve(directory), anchor = path.parse(absolute).root;
  let current = anchor;
  for (const part of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let info;
    try { info = await lstat(current); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; await mkdir(current, { mode: 0o700 }); info = await lstat(current); }
    const canonical = await realpath(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === 'win32' ? canonical.toLowerCase() !== current.toLowerCase() : canonical !== current)) fail('交付复验目录及父目录不可使用链接。');
  }
  return current;
}

function zipEntries(input) {
  if (!Buffer.isBuffer(input) || input.length < 22 || input.length > MAX_ARCHIVE) fail('交付ZIP必须为8MiB以内的有界文件。');
  const bytes = Buffer.from(input), end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0
    || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail('仅支持平台生成的单卷、无附加注释ZIP。');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  if (count < 1 || count > 100 || bytes.readUInt16LE(end + 8) !== count || centralOffset + centralSize !== end) fail('交付ZIP目录不完整或超限。');
  const entries = new Map(), ranges = [];
  let offset = centralOffset, total = 0;
  const range = (start, length, limit) => { if (!Number.isSafeInteger(start + length) || start < 0 || start + length > limit) fail('交付ZIP文件边界无效。'); };
  for (let index = 0; index < count; index++) {
    range(offset, 46, end);
    if (bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 4) !== 20 || bytes.readUInt16LE(offset + 6) !== 20
      || bytes.readUInt16LE(offset + 8) !== 0x800 || bytes.readUInt16LE(offset + 10) !== 0
      || bytes.readUInt16LE(offset + 34) !== 0 || bytes.readUInt16LE(offset + 36) !== 0 || bytes.readUInt32LE(offset + 38) !== 0) fail('交付ZIP只接受平台固定的UTF-8非压缩普通文件。');
    const checksum = bytes.readUInt32LE(offset + 16), size = bytes.readUInt32LE(offset + 24), packed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    if (size !== packed || size > 2 * 1024 * 1024 || nameLength < 1 || nameLength > 1024 || extra || comment) fail('交付ZIP条目大小或格式不符。');
    range(offset + 46, nameLength, end);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength), name = utf8(nameBytes);
    if (!name.isWellFormed() || name !== name.normalize('NFC') || /[\\\x00-\x1f\x7f:%]/u.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..' || part !== part.trim() || /[. ]$/u.test(part))) fail('交付ZIP包含不安全路径。');
    const folded = name.toUpperCase().toLowerCase();
    if ([...entries.keys()].some(key => key.toUpperCase().toLowerCase() === folded)) fail('交付ZIP包含重复或大小写混淆路径。');
    range(local, 30, centralOffset);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) !== 20 || bytes.readUInt16LE(local + 6) !== 0x800 || bytes.readUInt16LE(local + 8) !== 0
      || bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== size || bytes.readUInt32LE(local + 22) !== size
      || bytes.readUInt16LE(local + 26) !== nameLength || bytes.readUInt16LE(local + 28) !== 0) fail('交付ZIP本地条目与目录不一致。');
    range(local + 30, nameLength + size, centralOffset);
    if (!bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)) fail('交付ZIP文件名不一致。');
    const data = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
    if (crc32(data) !== checksum) fail('交付ZIP内容校验失败。');
    total += size; if (total > MAX_ARCHIVE) fail('交付ZIP内容总量超限。');
    entries.set(name, { content: utf8(data), bytes: size, sha256: hash(data) });
    ranges.push([local, local + 30 + nameLength + size]);
    offset += 46 + nameLength;
  }
  if (offset !== end) fail('交付ZIP目录条目数量不一致。');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges[0][0] !== 0 || ranges.at(-1)[1] !== centralOffset || ranges.some((range, index) => index > 0 && range[0] !== ranges[index - 1][1])) fail('交付ZIP条目重叠或包含未归属数据。');
  return { entries, archiveHash: hash(bytes) };
}

/** Checks archive integrity, never treats the archive's own success report as trusted evidence. */
export async function inspectWebArchive(input) {
  const { entries, archiveHash } = zipEntries(input);
  let manifest;
  try { manifest = JSON.parse(entries.get('delivery/manifest.json')?.content); } catch { fail('交付清单缺失或JSON无效。'); }
  if (manifest?.format !== 'taskflow-web-delivery-v1' || !Array.isArray(manifest.files) || manifest.files.length !== entries.size - 1) fail('交付清单格式或文件数量不符。');
  const binding = manifest.binding;
  if (!binding || Object.keys(binding).length !== bindingKeys.length || bindingKeys.some(key => !Object.hasOwn(binding, key)
    || typeof binding[key] !== 'string' || !(key.endsWith('Id') ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u : key === 'candidateCommit' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(binding[key]))) fail('交付版本绑定无效。');
  const listed = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path === 'delivery/manifest.json' || listed.has(file.path)) fail('交付清单有重复或非法条目。');
    listed.add(file.path);
    const actual = entries.get(file.path);
    if (!actual || file.bytes !== actual.bytes || file.sha256 !== actual.sha256) fail('交付文件与清单哈希不一致。');
  }
  const shell = await getWebShellFiles(), shellPaths = new Set(shell.map(file => file.path));
  if (manifest.shellHash !== hash(JSON.stringify(shell))) fail('交付运行器版本不同，需使用已验证的当前保护外壳重新交付。');
  for (const file of shell) if (entries.get(file.path)?.content !== file.content) fail('交付保护外壳已改变。');
  const metadata = new Set(['delivery/manifest.json', 'delivery/requirements.md', 'delivery/acceptance.json']);
  for (const stem of ['spec', 'plan']) {
    const present = ['md', 'json'].map(extension => `delivery/${stem}.${extension}`).filter(name => entries.has(name));
    if (present.length !== 1) fail('交付规格和计划必须各有一个快照。');
    metadata.add(present[0]);
  }
  if ([...metadata].some(name => !entries.has(name))) fail('交付需求或历史验收摘要缺失。');
  const files = validateProjectFiles([...entries].filter(([name]) => !shellPaths.has(name) && !metadata.has(name)).map(([name, item]) => ({ path: name, content: item.content })));
  if (!files.some(file => file.path === 'src/app.mjs') || hash(JSON.stringify(files)) !== binding.sourceHash || manifest.sourceHash !== binding.sourceHash) fail('交付源码版本不一致。');
  if (binding.manifestHash !== webManifest.hash || binding.browserManifestHash !== browserManifest.hash || binding.reviewPolicyHash !== projectReviewPolicy.hash
    || manifest.validation?.manifestHash !== binding.manifestHash || manifest.validation?.browserManifestHash !== binding.browserManifestHash
    || manifest.validation?.reviewPolicyHash !== binding.reviewPolicyHash || manifest.validation?.databaseObserverHash !== databaseObserverHash) fail('当前独立验收规则已变化或清单内部版本不一致，请重新生成交付后复验。');
  return { integrityVerified: true, historicalAcceptanceVerified: false, archiveHash, binding: { ...binding }, files,
    requirements: entries.get('delivery/requirements.md').content,
    notice: '文件完整性不证明既有验收摘要真实；复验将重新执行平台固定HTTP、数据库与浏览器检查。' };
}

/** Independent clean-snapshot verification, without a coding request or trusting archived test scripts. */
export async function revalidateWebArchive({ archiveFile, outputDir, executable = process.env.EXECUTION_SANDBOX_EXE, signal, timeoutMs = 120_000 } = {}) {
  if (typeof archiveFile !== 'string' || !path.isAbsolute(archiveFile) || typeof outputDir !== 'string' || !path.isAbsolute(outputDir)
    || signal !== undefined && !(signal instanceof AbortSignal) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) fail('交付复验配置无效。');
  const info = await lstat(archiveFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_ARCHIVE) fail('交付ZIP必须是8MiB以内的普通文件。');
  const archive = await inspectWebArchive(await readFile(archiveFile));
  if (signal?.aborted) throw Object.assign(new Error('交付复验已取消。'), { name: 'AbortError' });
  const canonical = await outputDirectory(outputDir);
  const directory = await mkdtemp(path.join(canonical, 'delivery-revalidation-'));
  const report = { id: randomUUID(), status: 'checking', taskAccepted: false, archiveHash: archive.archiveHash, binding: archive.binding,
    startedAt: new Date().toISOString(), finishedAt: null, historicalAcceptanceVerified: false, test: null, browser: null, reportPath: path.join(directory, 'revalidation.json') };
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    await Promise.allSettled([
      runWebTests({ rootDir: directory, files: archive.files, executable, signal: controller.signal, timeoutMs }).then(result => { report.test = result; }),
      runWebBrowserTests({ rootDir: directory, files: archive.files, executable, signal: controller.signal, timeoutMs }).then(result => { report.browser = result; }),
    ]);
    const results = [report.test, report.browser];
    report.status = results.some(result => result?.status === 'reconciliation_required') ? 'reconciliation_required'
      : controller.signal.aborted ? timedOut ? 'timed_out' : 'cancelled' : results.every(result => result?.status === 'passed' && result.terminationConfirmed === true) ? 'checks_passed' : 'failed';
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    report.finishedAt = new Date().toISOString();
    await writeFile(report.reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  return report;
}
