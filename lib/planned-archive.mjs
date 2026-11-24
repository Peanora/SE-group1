import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { readWebArchiveEntries } from './web-archive.mjs';
import { getWebShellFiles } from './web-delivery.mjs';
import { validateProjectFiles } from './project-files.mjs';
import { contentRevision } from './planning-review.mjs';
import { compileManifest, createVerificationControl } from './verification-contract.mjs';
import { browserScenarioPolicyHash } from './browser-scenario-contract.mjs';
import { projectReviewPolicy } from './project-review-model.mjs';
import { runHttpScenarios } from './http-scenarios.mjs';
import { runBrowserScenarios } from './browser-scenarios.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const need = condition => { if (!condition) throw new Error('规划源码包的文件、版本或当前验证规则无法完整核对。'); };
const bindingKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash', 'executorPolicyHash', 'sourceHash'];

/** ZIP integrity is not a trusted historical pass. Only a new diagnostic is exposed. */
export async function inspectPlannedArchive(buffer) {
  const { entries, archiveHash } = readWebArchiveEntries(buffer);
  const manifest = JSON.parse(entries.get('delivery/manifest.json')?.content ?? 'null');
  need(manifest?.version === 1 && manifest.profileId === 'planned-web-v1' && Array.isArray(manifest.files) && manifest.files.length === entries.size - 1);
  const binding = manifest.binding;
  need(binding && Object.keys(binding).length === bindingKeys.length && bindingKeys.every(key => typeof binding[key] === 'string'
    && (key.endsWith('Id') ? /^[A-Za-z0-9_-]{1,128}$/u : key === 'candidateCommit' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(binding[key])));
  const listed = new Set();
  for (const file of manifest.files) {
    need(file && typeof file.path === 'string' && file.path !== 'delivery/manifest.json' && !listed.has(file.path)); listed.add(file.path);
    const actual = entries.get(file.path); need(actual && actual.bytes === file.bytes && actual.sha256 === file.sha256);
  }
  const shell = await getWebShellFiles(), shellPaths = new Set(shell.map(file => file.path));
  for (const file of shell) need(entries.get(file.path)?.content === file.content);
  const meta = new Set(['delivery/manifest.json', 'delivery/requirements.md', 'delivery/spec.json', 'delivery/tasks.json', 'delivery/verification-definition.json', 'delivery/verification.json']);
  need([...meta].every(name => entries.has(name)));
  meta.add('delivery/task-execution.json'); // Optional history is indexed data, never a historical acceptance authority.
  meta.add('delivery/evolution.json'); // Optional evolution metadata is indexed data, never a historical acceptance authority.
  const files = validateProjectFiles([...entries].filter(([name]) => !shellPaths.has(name) && !meta.has(name)).map(([name, entry]) => ({ path: name, content: entry.content })));
  need(files.some(file => file.path === 'src/app.mjs') && hash(files) === binding.sourceHash && manifest.sourceHash === binding.sourceHash);
  const spec = JSON.parse(entries.get('delivery/spec.json').content), tasks = JSON.parse(entries.get('delivery/tasks.json').content);
  const verification = JSON.parse(entries.get('delivery/verification.json').content);
  need(verification && typeof verification === 'object' && !Array.isArray(verification));
  need(contentRevision(spec) === binding.specRevision && tasks.specRevision === binding.specRevision && tasks.planRevision === binding.planRevision && Array.isArray(tasks.tasks));
  const proposal = JSON.parse(entries.get('delivery/verification-definition.json').content), base = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]]));
  const definition = { proposal, requirements: spec.requirements.map(item => item.id), binding: base, tasks: tasks.tasks }, control = createVerificationControl();
  const approval = control.approve({ ...definition, feedback: '操作人显式选择本包的历史定义进行独立诊断；不认可历史完成声明，不启动编码，不发布软件完成。' });
  const compiled = compileManifest({ ...definition, approval });
  need(compiled.browser && compiled.manifestHash === binding.manifestHash && binding.browserPolicyHash === browserScenarioPolicyHash && binding.reviewPolicyHash === projectReviewPolicy.hash);
  control.beginCoding(approval); // Freeze the approved diagnostic definition before any candidate runs; no coding request is made.
  const summarizeChecks = list => Array.isArray(list) ? { total: list.length, passed: list.filter(item => item?.passed === true).length } : null;
  const verificationReport = {
    status: typeof verification.status === 'string' ? verification.status : null,
    acceptanceAt: typeof verification.acceptanceAt === 'string' ? verification.acceptanceAt : null,
    notice: typeof verification.notice === 'string' ? verification.notice : null,
    self: summarizeChecks(verification.self), http: summarizeChecks(verification.http), browser: summarizeChecks(verification.browser),
    review: verification.review && typeof verification.review === 'object' ? {
      summary: typeof verification.review.summary === 'string' ? verification.review.summary : null,
      issues: Array.isArray(verification.review.issues) ? verification.review.issues.length : null,
      openBlockingIssues: Array.isArray(verification.review.issues)
        ? verification.review.issues.filter(item => item?.severity === 'blocking' && item?.status !== 'resolved').length
        : null,
    } : null,
  };
  return { integrityVerified: true, taskAccepted: false, historicalAcceptanceVerified: false, archiveHash, binding, files, manifest: compiled,
    startGuidePresent: entries.has('START-HERE.md'), verificationReport,
    notice: '仅核对本包完整性；包内通过声明及历史Review不产生当前验收资格。' };
}

async function directory(raw, guard) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && path.resolve(raw) !== path.parse(raw).root);
  const absolute = path.resolve(raw); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    guard();
    current = path.join(current, part); try { await mkdir(current, { mode: 0o700 }); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const info = await lstat(current), actual = await realpath(current);
    guard();
    need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current));
  }
  return absolute;
}

export async function revalidatePlannedArchive({ archiveFile, outputDir, executable = process.env.EXECUTION_SANDBOX_EXE, signal, timeoutMs = 120000 } = {}) {
  need(typeof archiveFile === 'string' && path.isAbsolute(archiveFile) && (signal === undefined || signal instanceof AbortSignal) && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
  const started = Date.now(), deadline = started + timeoutMs, controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const guard = () => { if (controller.signal.aborted || Date.now() >= deadline) { controller.abort(); throw Object.assign(new Error('交付诊断已取消或达到时长上限。'), { name: 'AbortError', code: 'interrupted' }); } };
  async function prepare(operation) {
    guard(); let interrupted;
    const cancelled = new Promise((_, reject) => { interrupted = () => { try { guard(); } catch (error) { reject(error); } }; controller.signal.addEventListener('abort', interrupted, { once: true }); });
    try { const result = await Promise.race([Promise.resolve().then(() => { guard(); return operation(); }), cancelled]); guard(); return result; }
    finally { controller.signal.removeEventListener('abort', interrupted); }
  }
  let report;
  try {
    const info = await prepare(() => lstat(archiveFile)); need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 8 * 1024 * 1024);
    const bytes = await prepare(() => readFile(archiveFile)), archive = await prepare(() => inspectPlannedArchive(bytes));
    const root = await prepare(() => directory(outputDir, guard)), target = await prepare(() => mkdtemp(path.join(root, 'planned-delivery-')));
    report = { id: randomUUID(), status: 'checking', profileId: 'planned-web-v1', taskAccepted: false, historicalAcceptanceVerified: false,
      totalModelCalls: 0, archiveHash: archive.archiveHash, binding: archive.binding, startedAt: new Date(started).toISOString(), test: null, browser: null, errors: [], terminationConfirmed: false,
      reportPath: path.join(target, 'revalidation.json') };
    const binding = { ...archive.binding, taskId: 'delivery-recheck', attemptId: report.id }; delete binding.executorPolicyHash;
    guard(); const remaining = Math.max(1, deadline - Date.now());
    const results = await Promise.allSettled([
      runHttpScenarios({ manifest: archive.manifest, rootDir: target, files: archive.files, binding, executable, signal: controller.signal, timeoutMs: Math.min(remaining, archive.manifest.limits.timeoutMs) }).then(result => { report.test = result; }),
      runBrowserScenarios({ manifest: archive.manifest, rootDir: target, files: archive.files, binding, executable, signal: controller.signal, timeoutMs: Math.min(remaining, archive.manifest.browser.limits.timeoutMs) }).then(result => { report.browser = result; }),
    ]);
    results.forEach((result, index) => { if (result.status === 'rejected') report.errors.push({ role: ['http', 'browser'][index], message: '未获得完整独立诊断结果。' }); });
    report.terminationConfirmed = [report.test, report.browser].every(item => item?.terminationConfirmed === true);
    report.status = !report.terminationConfirmed ? 'reconciliation_required' : controller.signal.aborted ? 'interrupted'
      : [report.test, report.browser].every(item => item?.status === 'passed') ? 'checks_passed' : 'failed';
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (report) { report.finishedAt = new Date().toISOString(); await writeFile(report.reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 }); }
  }
  return report;
}
