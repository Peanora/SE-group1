import { createHash } from 'node:crypto';
import { createZip } from './zip.mjs';
import { validateProjectFiles } from './project-files.mjs';
import { getWebShellFiles } from './web-delivery.mjs';
import { isPlannedWebDeliveryAccepted } from './planned-web-executor.mjs';
import { contentRevision } from './planning-review.mjs';
import { inspectVerificationTasks } from './verification-task-scopes.mjs';
import { isPlannedTaskRunAccepted, plannedTaskIntegration } from './planned-task-executor.mjs';
import { assertPlannedCheckpoint } from './planned-checkpoint.mjs';
import { normalizeMigrationPlan } from './planned-migration-contract.mjs';
import { canonicalJSON } from './verification-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const need = value => { if (!value) throw new Error('只允许交付当前已完整验收且来源一致的规划驱动源码。'); };
export async function createPlannedDelivery({ record, manifest, files, requirements, spec, tasks, checkpoint, executionId, executionRecord } = {}) {
  need(isPlannedWebDeliveryAccepted({ record, manifest, checkpoint, executionId }));
  need(record.taskExecution?.integration !== true || executionRecord);
  if (executionRecord) {
    if (checkpoint) assertPlannedCheckpoint(checkpoint, { executionId, record, manifest, policyHash: record.executorPolicyHash, executionRecord });
    else need(isPlannedTaskRunAccepted(executionRecord, manifest) && plannedTaskIntegration(executionRecord, manifest) === record);
  }
  const source = validateProjectFiles(files), version = record.versions.at(-1), acceptance = version.acceptance;
  need(hash(JSON.stringify(source)) === version.sourceHash && typeof requirements === 'string' && contentRevision(spec) === record.specRevision && Array.isArray(tasks));
  if (manifest.taskScopes) need(inspectVerificationTasks(tasks, manifest.requirements).taskSetHash === manifest.taskSetHash);
  const shell = await getWebShellFiles();
  need(hash(JSON.stringify(shell)) === record.shellHash);
  const binding = Object.fromEntries(['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash', 'executorPolicyHash'].map(key => [key, record[key]]));
  binding.sourceHash = version.sourceHash;
  const publicCalls = (executionRecord ?? record).modelCalls.map(({ role, kind, attempt, model, usage, receiptHash, finishReason, taskId, attemptId, startedAt, finishedAt }) => ({ role, kind, attempt, model, usage, receiptHash, finishReason, taskId, attemptId, startedAt, finishedAt }));
  const publicChecks = checks => record.evolutionSource ? checks.map(({ id, name, passed }) => ({ id, name, passed, detail: '已有数据的断言值仅保留本机私有验证记录。' })) : checks;
  const summary = { version: 1, profileId: 'planned-web-v1', status: 'accepted', binding, sourceHash: version.sourceHash,
    acceptanceAt: record.finishedAt,
    notice: '本包对应交付时的已验收版本；解压和启动不会产生新验收，历史通过不能自动继承到修改后的代码。',
    self: publicChecks(version.selfCheck.checks), http: publicChecks(acceptance.test.checks), browser: publicChecks(acceptance.browser.checks),
    review: { summary: acceptance.review.summary, issues: acceptance.issues, resolutions: acceptance.review.resolutions },
    usage: (executionRecord ?? record).usage, costEstimate: { known: false, amount: null, currency: null, reason: '未配置模型单价，金额未知；token和调用为实际记录。' }, modelCalls: publicCalls };
  const entries = [...shell.map(file => ({ name: file.path, content: file.content })), ...source.map(file => ({ name: file.path, content: file.content })),
    { name: 'delivery/requirements.md', content: requirements }, { name: 'delivery/spec.json', content: JSON.stringify(spec, null, 2) },
    { name: 'delivery/tasks.json', content: JSON.stringify({ specRevision: record.specRevision, planRevision: record.planRevision, tasks }, null, 2) },
    { name: 'delivery/verification-definition.json', content: JSON.stringify(Object.fromEntries(['version', 'id', 'name', 'sessions', 'steps', 'limits', 'browser', ...(manifest.taskScopes ? ['taskScopes'] : [])].map(key => [key, manifest[key]])), null, 2) },
    { name: 'delivery/verification.json', content: JSON.stringify(summary, null, 2) }];
  if (record.evolutionSource) entries.push({ name: 'delivery/evolution.json', content: JSON.stringify({ version: 1, historicalRecordOnly: true, reusedAcceptance: false,
    originBinding: record.evolutionSource.originBinding, targetBinding: record.evolutionSource.targetBinding, seedHash: record.evolutionSeedHash,
    inputSnapshot: record.evolutionSource.snapshot, inputSchema: record.evolutionInputSchema, migration: record.evolutionSource.migration, recipe: normalizeMigrationPlan(record.evolutionMigration), platformPreMigration: true, historyHash: record.evolutionSource.historyHash,
    validationHistory: { purpose: 'taskflow/evolution-validation-history/v1', datasetReceiptsHash: hash(canonicalJSON([version.selfCheck.dataset, acceptance.test.dataset, ...acceptance.browser.dataset])) },
    historicalCosts: { totalModelCalls: record.evolutionHistory?.totalModelCalls ?? null, usage: record.evolutionHistory?.usage ?? null,
      receiptHashes: record.evolutionHistory?.receiptHashes ?? [] },
    databaseIncluded: false, notice: '源码包不含业务数据库、备份或私有路径。已有数据迁移和干净空库启动须分别验证；此摘要不是新的执行许可或数据恢复操作。' }, null, 2) });
  if (executionRecord) entries.push({ name: 'delivery/task-execution.json', content: JSON.stringify({ version: 1, status: 'accepted', historicalRecordOnly: true,
    executionMode: executionRecord.executionMode, maxConcurrentTasks: executionRecord.maxConcurrentTasks, binding,
    reworks: (executionRecord.reworks ?? []).map(({ id, evidenceHash, taskIds, affectedTaskIds, failedCandidateCommit, issues }) => ({ id, evidenceHash, taskIds, affectedTaskIds, failedCandidateCommit, issues })),
    tasks: executionRecord.tasks.map(item => { const last = item.record.versions.at(-1); return { id: item.id, title: item.title ?? item.id, dependsOn: item.dependsOn, status: item.status,
      attemptId: item.attemptId, baseCommit: item.baseCommit, candidateCommit: item.candidateCommit, manifestHash: item.record.manifestHash, usage: item.record.usage,
      self: last.selfCheck.checks, http: last.acceptance.test.checks, browser: last.acceptance.browser.checks,
      review: { summary: last.acceptance.review.summary, issues: last.acceptance.issues, resolutions: last.acceptance.review.resolutions },
      history: (item.history ?? []).map(past => { const gate = past.versions.at(-1)?.acceptance; return { attemptId: past.attemptId, status: past.status, candidateCommit: past.candidateCommit,
        totalModelCalls: past.totalModelCalls, usage: past.usage, errorCode: past.errorCode ?? null, self: past.versions.at(-1)?.selfCheck?.checks ?? [], http: gate?.test?.checks ?? [], browser: gate?.browser?.checks ?? [],
        review: gate?.review ? { summary: gate.review.summary, issues: gate.issues ?? [], resolutions: gate.review.resolutions ?? [] } : null }; }) }; }),
    totalModelCalls: executionRecord.totalModelCalls, usage: executionRecord.usage,
    notice: '逐任务历史来源与结果；下载、解包或修改本记录不产生新的可信任务完成或软件通过。' }, null, 2) });
  need(new Set(entries.map(file => file.name.toLowerCase())).size === entries.length);
  const index = entries.map(file => ({ path: file.name, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) }));
  entries.push({ name: 'delivery/manifest.json', content: JSON.stringify({ version: 1, profileId: 'planned-web-v1', binding, sourceHash: version.sourceHash, files: index }, null, 2) });
  need(isPlannedWebDeliveryAccepted({ record, manifest, checkpoint, executionId })); return createZip(entries);
}
