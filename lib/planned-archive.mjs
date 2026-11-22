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
import { migrationContractPolicy, normalizeMigrationPlan } from './planned-migration-contract.mjs';
import { runHttpScenarios } from './http-scenarios.mjs';
import { runBrowserScenarios } from './browser-scenarios.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const need = condition => { if (!condition) throw new Error('规划源码包的文件、版本或当前验证规则无法完整核对。'); };
const bindingKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash', 'executorPolicyHash', 'sourceHash'];
const evolutionPath = 'delivery/evolution.json';
const redactedCheckDetail = '已有数据的断言值仅保留本机私有验证记录。';
const evolutionNotice = '源码包不含业务数据库、备份或私有路径。已有数据迁移和干净空库启动须分别验证；此摘要不是新的执行许可或数据恢复操作。';
const databaseRequired = '此包仅含源码和迁移摘要。复验已有数据需要由平台持有并批准的原快照，本次没有运行旧数据检查。';
const HEX = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u, COMMIT = /^[a-f0-9]{40}$/u, SCHEMA_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const select = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
function exact(value, keys) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  return select(value, keys);
}

async function inspectEvolution(content, binding) {
  const evolution = exact(JSON.parse(content), ['version', 'historicalRecordOnly', 'reusedAcceptance', 'originBinding', 'targetBinding', 'seedHash', 'inputSnapshot', 'inputSchema',
    'migration', 'recipe', 'platformPreMigration', 'historyHash', 'validationHistory', 'historicalCosts', 'databaseIncluded', 'notice']);
  need(evolution.version === 1 && evolution.historicalRecordOnly === true && evolution.reusedAcceptance === false && evolution.platformPreMigration === true
    && evolution.databaseIncluded === false && evolution.notice === evolutionNotice && [evolution.seedHash, evolution.historyHash].every(value => matches(value, HEX)));
  const origin = exact(evolution.originBinding, ['projectId', 'runId', 'executionId', 'candidateCommit', 'sourceHash', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision']);
  const target = exact(evolution.targetBinding, ['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision', 'inputSnapshotHash', 'inputSchemaHash']);
  need(['projectId', 'runId', 'specRevision', 'planRevision'].every(key => target[key] === binding[key])
    && origin.projectId === target.projectId && origin.runId !== target.runId && matches(origin.runId, ID) && matches(origin.executionId, ID)
    && matches(origin.candidateCommit, COMMIT) && [origin.sourceHash, origin.sourceRevision, origin.specRevision, origin.planRevision, target.sourceRevision, target.inputSnapshotHash, target.inputSchemaHash].every(value => matches(value, HEX))
    && nonnegative(origin.sourceGeneration) && nonnegative(target.sourceGeneration) && origin.sourceGeneration < target.sourceGeneration);

  const snapshotKeys = ['version', 'datasetId', 'snapshotId', 'dataGeneration', 'originCommit', 'databaseHash', 'schemaHash', 'rowsHash', 'bytes', 'policyHash'];
  const snapshot = exact(evolution.inputSnapshot, [...snapshotKeys, 'snapshotHash']);
  const workerHash = hash(await readFile(new URL('./planned-migration-worker.cjs', import.meta.url)));
  const snapshotPolicy = hash({ version: 1, workerHash, contract: migrationContractPolicy });
  need(snapshot.version === 1 && matches(snapshot.datasetId, ID) && matches(snapshot.snapshotId, ID) && nonnegative(snapshot.dataGeneration)
    && snapshot.originCommit === origin.candidateCommit && snapshot.schemaHash === target.inputSchemaHash && snapshot.snapshotHash === target.inputSnapshotHash
    && [snapshot.databaseHash, snapshot.rowsHash].every(value => matches(value, HEX)) && Number.isSafeInteger(snapshot.bytes) && snapshot.bytes > 0 && snapshot.bytes <= 32 * 1024 * 1024
    && snapshot.policyHash === snapshotPolicy && snapshot.snapshotHash === hash(select(snapshot, snapshotKeys)));
  need(Array.isArray(evolution.inputSchema) && evolution.inputSchema.length <= 32);
  for (const entry of evolution.inputSchema) {
    const table = exact(entry, ['name', 'columns']);
    need(matches(table.name, SCHEMA_NAME) && Array.isArray(table.columns) && table.columns.length <= 64);
    for (const item of table.columns) {
      const column = exact(item, ['name', 'type', 'primary']);
      need(matches(column.name, SCHEMA_NAME) && matches(column.type, /^[^\x00-\x1f\x7f]{0,128}$/u)
        && column.type.isWellFormed() && nonnegative(column.primary) && column.primary <= 64);
    }
  }

  const recipe = normalizeMigrationPlan(evolution.recipe), migration = exact(evolution.migration, ['revision', 'operationsHash', 'policy']);
  const policy = exact(migration.policy, Object.keys(migrationContractPolicy));
  need(hash(policy) === hash(migrationContractPolicy) && migration.operationsHash === hash(recipe)
    && migration.revision === hash({ plan: recipe, binding: target, policy: migrationContractPolicy }));
  const validation = exact(evolution.validationHistory, ['purpose', 'datasetReceiptsHash']);
  need(validation.purpose === 'taskflow/evolution-validation-history/v1' && matches(validation.datasetReceiptsHash, HEX));
  const costs = exact(evolution.historicalCosts, ['totalModelCalls', 'usage', 'receiptHashes']);
  need((costs.totalModelCalls === null || nonnegative(costs.totalModelCalls)) && Array.isArray(costs.receiptHashes)
    && costs.receiptHashes.every(value => matches(value, HEX)) && new Set(costs.receiptHashes).size === costs.receiptHashes.length);
  if (costs.usage !== null) need(Object.values(exact(costs.usage, ['inputTokens', 'outputTokens'])).every(value => value === null || nonnegative(value)));

  return { version: 1, historicalRecordOnly: true, databaseIncluded: false, existingDataVerified: false,
    migrationKind: recipe.kind, originGeneration: origin.sourceGeneration, targetGeneration: target.sourceGeneration };
}

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
  meta.add(evolutionPath);
  const files = validateProjectFiles([...entries].filter(([name]) => !shellPaths.has(name) && !meta.has(name)).map(([name, entry]) => ({ path: name, content: entry.content })));
  need(files.some(file => file.path === 'src/app.mjs') && hash(files) === binding.sourceHash && manifest.sourceHash === binding.sourceHash);
  const spec = JSON.parse(entries.get('delivery/spec.json').content), tasks = JSON.parse(entries.get('delivery/tasks.json').content);
  need(contentRevision(spec) === binding.specRevision && tasks.specRevision === binding.specRevision && tasks.planRevision === binding.planRevision && Array.isArray(tasks.tasks));
  const proposal = JSON.parse(entries.get('delivery/verification-definition.json').content), base = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]]));
  const definition = { proposal, requirements: spec.requirements.map(item => item.id), binding: base, tasks: tasks.tasks }, control = createVerificationControl();
  const approval = control.approve({ ...definition, feedback: '操作人显式选择本包的历史定义进行独立诊断；不认可历史完成声明，不启动编码，不发布软件完成。' });
  const compiled = compileManifest({ ...definition, approval });
  need(compiled.browser && compiled.manifestHash === binding.manifestHash && binding.browserPolicyHash === browserScenarioPolicyHash && binding.reviewPolicyHash === projectReviewPolicy.hash);
  let evolution, executorPolicyCurrent, verification;
  try { verification = JSON.parse(entries.get('delivery/verification.json').content); }
  catch (error) { if (entries.has(evolutionPath)) throw error; }
  const checks = ['self', 'http', 'browser'].map(key => verification?.[key]);
  const describesOldData = checks.some(group => Array.isArray(group) && group.some(check => check?.detail === redactedCheckDetail));
  need(!describesOldData || entries.has(evolutionPath));
  if (entries.has(evolutionPath)) {
    need(!entries.has('delivery/task-execution.json'));
    const reportBinding = exact(verification?.binding, bindingKeys);
    need(verification.version === 1 && verification.profileId === 'planned-web-v1' && verification.sourceHash === binding.sourceHash
      && bindingKeys.every(key => reportBinding[key] === binding[key]));
    need(describesOldData && checks.every(group => Array.isArray(group) && group.every(check => {
      const item = exact(check, ['id', 'name', 'passed', 'detail']);
      return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.passed === 'boolean' && item.detail === redactedCheckDetail;
    })));
    evolution = await inspectEvolution(entries.get(evolutionPath).content, binding);
    const { plannedExecutionPolicyHash } = await import('./planned-web-executor.mjs');
    executorPolicyCurrent = binding.executorPolicyHash === plannedExecutionPolicyHash;
  }
  control.beginCoding(approval); // Freeze the approved diagnostic definition before any candidate runs; no coding request is made.
  return { integrityVerified: true, taskAccepted: false, historicalAcceptanceVerified: false, archiveHash, binding, files, manifest: compiled, ...(evolution ? { evolution, executorPolicyCurrent } : {}),
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
    if (archive.evolution) return { status: 'evolution_dataset_required', integrityVerified: true, taskAccepted: false, historicalAcceptanceVerified: false,
      totalModelCalls: 0, archiveHash: archive.archiveHash, binding: archive.binding, executorPolicyCurrent: archive.executorPolicyCurrent, evolution: archive.evolution,
      terminationConfirmed: null, test: null, browser: null, reportPath: null, notice: databaseRequired };
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
