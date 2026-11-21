import { createHash, randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openTaskStore, inspectFrozenTaskHandoff } from './task-store.mjs';
import { assertCompiledManifest, compileTaskManifest, isTaskCompiledManifest, canonicalJSON } from './verification-contract.mjs';
import { browserScenarioChecks, copyBrowserScenarioData } from './browser-scenario-contract.mjs';
import { validateTaskWriteConflicts } from './task-write-validation.mjs';
import { projectReviewPolicy } from './project-review-model.mjs';
import { startPlannedWebExecution, isPlannedWebTaskAccepted, plannedIntegrationRework } from './planned-web-executor.mjs';
import { createPlannedTaskSeed, createTaskRunDirectory } from './planned-task-base.mjs';
import { inspectPlannedSource } from './planned-source.mjs';
import { mergePlannedTaskCandidates, resolvePlannedTaskBase } from './planned-task-merge.mjs';

const proofs = new WeakMap(), keys = ['projectId', 'runId', 'specRevision', 'planRevision'];
const taskHandles = new WeakMap(), pausedCheckpoints = new WeakMap(), retiredCheckpoints = new WeakMap();
const resumedPermits = new WeakSet();
const freezeData = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeData); Object.freeze(value); } return value; };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = value => { if (!value) throw new Error('逐任务执行的版本、租约、基础代码或独立验收未完整通过。'); };
const pureHash = value => digest(copyBrowserScenarioData(value, 32 * 1024 * 1024, { maxNodes: 250000 }));
const taskHash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');

/** The original final core capability, never parsed task records, grants acceptance. */
export function isPlannedTaskRunAccepted(record, manifest) {
  try {
    const proof = proofs.get(record); if (!proof || proof.manifest !== manifest) return false;
    proof.assertResume?.();
    if (proof.hash !== pureHash(record)) return false;
    assertCompiledManifest(manifest, Object.fromEntries(keys.map(key => [key, record[key]])));
    return record.status === 'accepted' && record.terminationConfirmed === true && record.tasks.every(task => task.status === 'completed')
      && isPlannedWebTaskAccepted(proof.integration, manifest);
  } catch { return false; }
}
export function plannedTaskIntegration(record, manifest) {
  need(isPlannedTaskRunAccepted(record, manifest)); return proofs.get(record).integration;
}

/** Only the original paused scheduler can freeze completed dependency evidence.
 * These capabilities grant neither a complete graph nor a fresh child pass. */
export async function capturePausedTaskCheckpoint({ handle, manifest } = {}) {
  const state = taskHandles.get(handle); need(state && state.manifest === manifest); return state.capture();
}
export function assertPausedTaskCheckpoint(checkpoint, { manifest } = {}) {
  const proof = pausedCheckpoints.get(checkpoint); need(proof && proof.manifest === manifest); proof.assert(); return proof.payload;
}
export async function auditPausedTaskCheckpoint(checkpoint, { manifest } = {}) {
  const proof = pausedCheckpoints.get(checkpoint); need(proof && proof.manifest === manifest); proof.assert(); await proof.audit(); return assertPausedTaskCheckpoint(checkpoint, { manifest });
}
export async function retirePausedTaskCheckpoint({ handle, checkpoint, manifest } = {}) {
  const state = taskHandles.get(handle); need(state && state.manifest === manifest); return state.retire(checkpoint);
}
export function assertRetiredTaskCheckpoint(retirement, { checkpoint, manifest } = {}) {
  const proof = retiredCheckpoints.get(retirement); need(proof && proof.checkpoint === checkpoint && proof.manifest === manifest); proof.assert(); return proof.value;
}

/** Pure admission, before reserving attempts or starting any model/filesystem work. */
export function inspectPlannedTaskGraph(task) {
  try {
    const confirmed = copyBrowserScenarioData(task, 96000), tasks = confirmed?.tasks;
    need(Array.isArray(tasks) && tasks.length >= 2 && tasks.length <= 8);
    need(tasks.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(item.id) && !['__proto__', 'prototype', 'constructor'].includes(item.id)
      && Array.isArray(item.dependsOn) && new Set(item.dependsOn).size === item.dependsOn.length
      && Array.isArray(item.writePaths ?? item.suggestedFiles) && (item.writePaths ?? item.suggestedFiles).length > 0));
    const byId = new Map(tasks.map(item => [item.id, item])); need(byId.size === tasks.length); validateTaskWriteConflicts(tasks);
    const ancestors = new Map();
    const visit = item => { if (ancestors.has(item.id)) return ancestors.get(item.id); const found = new Set(); for (const id of item.dependsOn) { found.add(id); for (const prior of visit(byId.get(id))) found.add(prior); } ancestors.set(item.id, found); return found; };
    tasks.forEach(visit);
    const finalTasks = tasks.filter(item => ancestors.get(item.id).size === tasks.length - 1), roots = tasks.filter(item => item.dependsOn.length === 0);
    need(finalTasks.length === 1 && roots.length === 1 && (roots[0].writePaths ?? roots[0].suggestedFiles).includes('src/app.mjs'));
    return { task: confirmed, tasks, allPaths: [...new Set(tasks.flatMap(item => item.writePaths ?? item.suggestedFiles))], integrationTaskId: finalTasks[0].id };
  } catch { throw Object.assign(new Error('当前确认任务图不支持逐任务执行，请核对任务数量、依赖、文件范围与最终集成任务。'), { code: 'unsupported_task_graph' }); }
}

/** Leased, isolated task executions; a whole batch must pass before integration. */
export function startPlannedTaskExecution({ outputDir, binding, task, manifest, provider, reviewer, executable, signal,
  maxConcurrency = 2, maxCalls = 3, maxReviewCalls = 3, timeoutMs = 1200000, deadlineAt, resumePermit, assertCurrent, onEvent = () => {} } = {}) {
  need(typeof assertCurrent === 'function' && (signal === undefined || signal instanceof AbortSignal));
  const identity = Object.fromEntries(keys.map(key => [key, binding?.[key]])); assertCompiledManifest(manifest, identity);
  need(!isTaskCompiledManifest(manifest) && Number.isInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 2
    && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 1200000 && [maxCalls, maxReviewCalls].every(value => Number.isInteger(value) && value >= 1 && value <= 3));
  const { task: confirmed, tasks, allPaths, integrationTaskId } = inspectPlannedTaskGraph(task);
  const scoped = new Map(tasks.map(item => [item.id, compileTaskManifest({ manifest, taskId: item.id, tasks })]));
  const controller = new AbortController(), active = new Map(), inflight = new Set(), contexts = [];
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  const startTime = Date.now(), deadline = deadlineAt ?? startTime + timeoutMs;
  need(Number.isSafeInteger(deadline) && deadline > startTime && deadline <= startTime + timeoutMs);
  const timer = setTimeout(cancel, Math.max(1, deadline - Date.now())), workerId = `local-${randomUUID()}`;
  let store, directory, paused = false, wake, integration, queue = Promise.resolve(), source, seed, capturing = false, handoff = null, retiring = false, retirement, resumed;
  const handoffSignal = new Error('scheduler_handoff');
  let record = { id: randomUUID(), ...identity, profileId: 'planned-task-run-v1', manifestHash: manifest.manifestHash,
    status: 'preparing', terminationConfirmed: false, startedAt: new Date().toISOString(), finishedAt: null,
    executionMode: maxConcurrency === 1 ? 'serial_tasks' : 'parallel_tasks', maxConcurrency, maxObservedConcurrency: 0, maxConcurrentTasks: 0, integrationTaskId,
    tasks: tasks.map(item => ({ id: item.id, title: item.title, writePaths: item.writePaths ?? item.suggestedFiles, dependsOn: item.dependsOn, status: 'pending', history: [], record: null })), batches: [], merges: [], reworks: [], events: [],
    budget: { maxCalls, maxReviewCalls, maxModelCalls: tasks.length * (maxCalls + maxReviewCalls), maxIntegrationReworks: 1, timeoutMs },
    totalModelCalls: 0, modelCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, error: null };
  const current = () => {
    need(!controller.signal.aborted && Date.now() < deadline);
    const result = assertCurrent(structuredClone(identity)); need(result !== false && (!result || typeof result.then !== 'function')); assertCompiledManifest(manifest, identity);
    if (resumed) need(resumed.assertCurrent() === true);
  };
  const event = message => { const value = typeof message === 'string' ? { message } : message; record.events.push({ sequence: record.events.length + 1, at: new Date().toISOString(), status: record.status, ...value }); try { onEvent(structuredClone(record.events.at(-1))); } catch {} };
  const refreshUsage = () => {
    record.modelCalls = record.tasks.flatMap(item => [...item.history, ...(item.record ? [item.record] : [])].flatMap(value => value.modelCalls ?? []));
    record.totalModelCalls = record.modelCalls.filter(call => call.kind === 'model' && call.dispatched !== false).length;
    for (const key of ['inputTokens', 'outputTokens']) {
      const total = record.modelCalls.reduce((sum, call) => sum + (call.usage?.[key] ?? 0), 0);
      record.usage[key] = contexts.every(ctx => !ctx.unavailable) && record.modelCalls.every(call => Number.isSafeInteger(call.usage?.[key]) && call.usage[key] >= 0) && Number.isSafeInteger(total) ? total : null;
    }
  };
  const remainingFor = entry => {
    const calls = [...entry.history, ...(entry.record ? [entry.record] : [])].flatMap(value => value.modelCalls ?? []);
    return { maxCalls: maxCalls - calls.filter(call => call.role === 'coding').length, maxReviewCalls: maxReviewCalls - calls.filter(call => call.role === 'review').length };
  };
  const save = () => {
    refreshUsage(); if (!directory) return Promise.resolve(); const value = JSON.stringify(record, null, 2);
    queue = queue.then(async () => { const temp = path.join(directory, `${randomUUID()}.tmp`); await writeFile(temp, value, { flag: 'wx', mode: 0o600 }); await rename(temp, path.join(directory, 'task-execution.json')); }); return queue;
  };
  const notify = () => { wake?.(); wake = null; };
  controller.signal.addEventListener('abort', () => { for (const handle of active.values()) handle.cancel(); notify(); }, { once: true });
  const assertLease = ctx => { current(); const live = store.query.listAttempts(identity.runId).find(value => value.attemptId === ctx.lease.attemptId); need(live?.status === 'leased' && live.expiresAt > Date.now()); };
  const rememberUnknown = error => {
    if (error?.result?.terminationConfirmed !== false) return;
    const item = { workspace: error.workspace ?? null, process: Object.fromEntries(['pid', 'startedAt', 'exitCode', 'terminationConfirmed', 'stopReason'].map(key => [key, error.result[key] ?? null])) };
    record.reconciliations ??= []; if (!record.reconciliations.some(old => digest(old) === digest(item))) record.reconciliations.push(item); record.reconciliation ??= item;
  };
  function receipts(result, lease) {
    const binding = Object.fromEntries(['projectId', 'runId', 'taskId', 'attemptId', 'generation', 'projectRevision', 'specRevision', 'planRevision', 'baseCommit', 'manifestHash', 'browserManifestHash', 'reviewPolicyHash', 'candidateCommit', 'sourceHash'].map(key => [key, lease[key]]));
    const gate = result.versions.at(-1).acceptance;
    return { test: { role: 'test', kind: 'independent', binding, manifestHash: lease.manifestHash, status: gate.test.status, terminationConfirmed: gate.test.terminationConfirmed, checks: gate.test.checks },
      browser: { role: 'browser', kind: 'independent', binding, manifestHash: lease.browserManifestHash, status: gate.browser.status, terminationConfirmed: gate.browser.terminationConfirmed, checks: gate.browser.checks },
      review: { role: 'review', kind: 'independent', binding, manifestHash: lease.reviewPolicyHash, status: gate.review.status, issues: gate.issues } };
  }
  const notStarted = ctx => {
    if (ctx.handle || ctx.settled) return;
    store.control.settle({ attemptId: ctx.lease.attemptId, settlementId: `usage-${ctx.lease.attemptId}`, usage: { calls: 0, tokens: 0 } }); ctx.settled = true;
    store.control.confirmStopped({ attemptId: ctx.lease.attemptId, evidenceId: `not-started-${ctx.lease.attemptId}` });
    ctx.entry.status = 'stopped';
  };
  async function runTask(ctx, baseHandle) {
    const { item, entry, definition } = ctx;
    try {
      assertLease(ctx);
      ctx.handle = startPlannedWebExecution({ outputDir: directory, binding: { ...identity, sourceRevision: binding.sourceRevision ?? null, taskId: item.id }, task: confirmed, manifest: definition,
        taskExecution: { attemptId: ctx.lease.attemptId, integration: item.id === integrationTaskId }, ...(baseHandle === seed ? { initialTaskBase: seed } : { initialSource: baseHandle }), provider, reviewer, executable,
        signal: controller.signal, ...ctx.remaining, timeoutMs: Math.max(1, Math.min(600000, deadline - Date.now())),
        assertCurrent: () => assertLease(ctx), onEvent: () => { entry.record = ctx.handle?.snapshot() ?? entry.record; void save().catch(() => {}); } });
      active.set(item.id, ctx.handle); record.maxObservedConcurrency = Math.max(record.maxObservedConcurrency, active.size); record.maxConcurrentTasks = record.maxObservedConcurrency;
      event({ message: `任务 ${item.id} 已在独立候选中启动。`, type: 'task_started', taskId: item.id, attemptId: ctx.lease.attemptId, baseCommit: ctx.lease.baseCommit, activeCount: active.size });
      ctx.heartbeat = setInterval(() => { try { const result = store.worker.heartbeat({ lease: ctx.lease, leaseMs: 30000 }); if (result.current) ctx.lease = result.lease; else ctx.handle.cancel(); } catch { ctx.handle.cancel(); } }, 5000);
      const result = await ctx.handle.done; ctx.result = result; entry.record = result; entry.candidateCommit = result.candidateCommit; entry.status = result.status;
      const actualTokens = result.usage.inputTokens === null || result.usage.outputTokens === null ? null : result.usage.inputTokens + result.usage.outputTokens;
      store.control.settle({ attemptId: ctx.lease.attemptId, settlementId: `usage-${ctx.lease.attemptId}`, usage: { calls: result.totalModelCalls, tokens: actualTokens } }); ctx.settled = true;
      if (result.terminationConfirmed === true) store.control.confirmStopped({ attemptId: ctx.lease.attemptId, evidenceId: `stopped-${ctx.lease.attemptId}` });
      await save(); need(result.terminationConfirmed === true && result.baseCommit === ctx.lease.baseCommit); assertLease(ctx);
      const rework = item.id === integrationTaskId ? plannedIntegrationRework(result, definition) : null;
      need(isPlannedWebTaskAccepted(result, definition) || rework);
      ctx.source = await inspectPlannedSource({ rootDir: directory, reportPath: result.reportPath, binding: identity, writablePaths: allPaths, signal: controller.signal, expectedRecord: result });
      if (rework) {
        assertLease(ctx); need(plannedIntegrationRework(result, definition) === rework); ctx.rework = rework; entry.status = 'integration_rework';
        event({ message: '完整集成已停止并保留精确上游返工意见，尚未通过。', type: 'integration_rework', taskId: item.id, attemptId: ctx.lease.attemptId }); return ctx;
      }
      assertLease(ctx); entry.status = 'verified'; event({ message: `任务 ${item.id} 已通过独立验收与来源核对，等待同批集成。`, type: 'task_verified', taskId: item.id, attemptId: ctx.lease.attemptId }); return ctx;
    } catch (error) {
      rememberUnknown(error);
      if (!ctx.handle) notStarted(ctx); else if (!ctx.result) { ctx.unavailable = true; entry.record = ctx.handle.snapshot(); }
      if (!ctx.result || ctx.result.status === 'accepted') entry.status = 'failed';
      throw error;
    } finally { active.delete(item.id); await save(); }
  }
  const done = (async () => {
    try {
      current();
      if (resumePermit !== undefined) {
        need(resumePermit && typeof resumePermit === 'object' && !resumedPermits.has(resumePermit));
        const { assertVerifiedPausedTaskResume } = await import('./planned-worker-seals.mjs');
        need(typeof assertVerifiedPausedTaskResume === 'function'); resumed = assertVerifiedPausedTaskResume(resumePermit, { manifest, binding, task: confirmed });
        need(resumed && typeof resumed.assertCurrent === 'function'); current();
        const checkpoint = resumed.checkpoint, snapshot = checkpoint?.graph;
        need(checkpoint?.version === 1 && checkpoint.purpose === 'taskflow/task-dependency-checkpoint/v1' && checkpoint.manifestHash === manifest.manifestHash
          && checkpoint.taskSetHash === manifest.taskSetHash && checkpoint.taskDefinitionHash === taskHash(confirmed) && checkpoint.deadlineAt === deadline
          && taskHash(checkpoint.task) === taskHash(confirmed) && checkpoint.binding.sourceRevision === (binding.sourceRevision ?? null) && checkpoint.binding.sourceGeneration === (binding.sourceGeneration ?? null)
          && keys.every(key => checkpoint.binding[key] === identity[key]) && snapshot?.id === checkpoint.graphId && snapshot.status === 'paused'
          && snapshot.terminationConfirmed === false && snapshot.startedAt === checkpoint.startedAt && snapshot.manifestHash === manifest.manifestHash
          && snapshot.maxConcurrency === maxConcurrency && snapshot.budget.maxCalls === maxCalls && snapshot.budget.maxReviewCalls === maxReviewCalls
          && snapshot.tasks.length === tasks.length && tasks.every((item, index) => snapshot.tasks[index].id === item.id && taskHash(snapshot.tasks[index].writePaths) === taskHash(item.writePaths ?? item.suggestedFiles)));
        const { freeze, ...initialCheckpoint } = checkpoint; need(freeze.evidenceHash === taskHash(initialCheckpoint));
        resumedPermits.add(resumePermit);
        need(path.isAbsolute(checkpoint.taskRootDir) && checkpoint.taskRootDir === path.dirname(checkpoint.taskDatabase)
          && checkpoint.taskDatabase === path.join(checkpoint.taskRootDir, 'tasks.sqlite') && checkpoint.taskRootDir === path.dirname(snapshot.reportPath));
        const relative = path.relative(path.resolve(outputDir), checkpoint.taskRootDir); need(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        directory = checkpoint.taskRootDir;
        need(taskHash(inspectFrozenTaskHandoff({ filename: checkpoint.taskDatabase, runId: identity.runId, checkpointId: checkpoint.checkpointId })) === taskHash(freeze));
        source = await inspectPlannedSource({ rootDir: directory, reportPath: checkpoint.currentSource.sourceReportPath, binding: identity, writablePaths: allPaths,
          signal: controller.signal, timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) }); current();
        const checked = resolvePlannedTaskBase(source, identity, allPaths); need(checked.provenance.sourceReportHash === checkpoint.currentSource.sourceReportHash
          && checked.provenance.sourceCommit === checkpoint.currentSource.sourceCommit && checked.provenance.sourceHash === checkpoint.currentSource.sourceHash);
        store = openTaskStore({ filename: checkpoint.taskDatabase });
        const consumed = store.control.consumeHandoff({ runId: identity.runId, expectedVersion: freeze.version, checkpointId: checkpoint.checkpointId,
          evidenceHash: freeze.evidenceHash, frozenStateHash: freeze.frozenStateHash, generationId: resumed.generationId }); need(!consumed.duplicate);
        record = structuredClone(snapshot); handle.id = record.id;
        record.recoveries ??= []; record.recoveries.push({ kind: 'verified_paused_task_dependency', checkpointId: checkpoint.checkpointId,
          checkpointHash: taskHash(checkpoint), generationId: resumed.generationId, resumedAt: new Date().toISOString(), originalDeadlineAt: deadline,
          historicalTaskIds: record.tasks.filter(item => item.status === 'completed').map(item => item.id), notice: '复用原同版本暂停点的依赖资格，旧任务未重新执行；最终集成仍需实际全验。' });
        record.status = 'running'; record.finishedAt = null; record.error = null; event({ message: '已核对原暂停点与原预算，继续待执行任务；历史任务未重做。', type: 'checkpoint_resumed', checkpointId: checkpoint.checkpointId }); await save();
      } else {
      directory = await createTaskRunDirectory(outputDir); record.reportPath = path.join(directory, 'task-execution.json');
      await save(); current(); seed = await createPlannedTaskSeed({ rootDir: directory, binding: identity, signal: controller.signal }); current();
      const base = resolvePlannedTaskBase(seed, identity, allPaths); record.seed = { ...base.provenance, gitCommands: base.commands };
      store = openTaskStore({ filename: path.join(directory, 'tasks.sqlite') });
      store.control.createRun({ projectId: identity.projectId, runId: identity.runId, projectRevision: binding.sourceRevision ?? identity.specRevision, specRevision: identity.specRevision, planRevision: identity.planRevision,
        deadlineAt: deadline, budget: { calls: record.budget.maxModelCalls, tokens: tasks.length * 1000000 }, tasks: tasks.map(item => {
          const definition = item.id === integrationTaskId ? manifest : scoped.get(item.id);
          return { id: item.id, description: item.description || item.title, inputs: item.inputs, outputs: item.outputs, dependsOn: item.dependsOn, writablePaths: item.writePaths ?? item.suggestedFiles,
            acceptance: item.acceptance, baseCommit: base.provenance.sourceCommit, manifests: { test: { hash: definition.manifestHash, checkIds: definition.checks.map(check => check.id) },
              browser: { hash: definition.manifestHash, checkIds: browserScenarioChecks(definition.browser).map(check => check.id) }, review: { hash: projectReviewPolicy.hash } }, reservation: { calls: maxCalls + maxReviewCalls, tokens: 1000000 } };
        }) });
      record.status = 'running'; event('已创建真实任务事务记录；只有独立验收通过才能释放下游。'); await save();
      }
      while (record.tasks.some(item => item.status !== 'completed')) {
        while (paused) { record.status = 'paused'; event({ message: '在途批次已保存，暂停新批次派发。', type: 'paused' }); await save(); await new Promise(resolve => { wake = resolve; if (!paused || controller.signal.aborted) notify(); }); if (retiring) throw handoffSignal; current(); }
        if (retiring) throw handoffSignal;
        current(); record.status = 'running';
        const ready = tasks.filter(item => store.query.getTask(identity.runId, item.id).status === 'pending' && item.dependsOn.every(id => store.query.getTask(identity.runId, id).status === 'completed')).slice(0, maxConcurrency); need(ready.length > 0);
        const baseHandle = source ?? seed, prior = resolvePlannedTaskBase(baseHandle, identity, allPaths);
        const batch = { id: `batch-${record.batches.length + 1}`, taskIds: ready.map(item => item.id), baseCommit: prior.provenance.sourceCommit, status: 'running', startedAt: new Date().toISOString(), finishedAt: null };
        record.batches.push(batch); const selected = [];
        try {
          // No await/observer between claims: pause applies to the next batch.
          for (const item of ready) {
            const entry = record.tasks.find(value => value.id === item.id), definition = item.id === integrationTaskId ? manifest : scoped.get(item.id);
            const remaining = remainingFor(entry); need(remaining.maxCalls >= 1 && remaining.maxReviewCalls >= 1);
            store.control.bindTaskBase({ runId: identity.runId, taskId: item.id, expectedVersion: 1, baseCommit: prior.provenance.sourceCommit, evidenceId: `${batch.id}-${item.id}`,
              reservation: { calls: remaining.maxCalls + remaining.maxReviewCalls, tokens: 1000000 } });
            const { lease } = store.worker.claim({ runId: identity.runId, taskId: item.id, workerId, leaseMs: 30000 }) ?? {}; need(lease);
            entry.status = 'running'; entry.attemptId = lease.attemptId; entry.baseCommit = lease.baseCommit; entry.batchId = batch.id;
            const ctx = { item, entry, definition, lease, remaining }; contexts.push(ctx); selected.push(ctx);
          }
          event({ message: `批次 ${batch.id} 固定同一基础，派发 ${selected.length} 个就绪任务。`, type: 'batch_started', batchId: batch.id, taskIds: batch.taskIds, baseCommit: batch.baseCommit }); await save();
          const operations = selected.map(ctx => { const operation = runTask(ctx, baseHandle); inflight.add(operation); operation.finally(() => inflight.delete(operation)).catch(() => {}); return operation; });
          const outcomes = await Promise.allSettled(operations), rejected = outcomes.filter(value => value.status === 'rejected');
          if (rejected.length) throw rejected.find(value => value.reason?.reconciliationRequired || value.reason?.result?.terminationConfirmed === false)?.reason ?? rejected[0].reason;
          selected.forEach(assertLease);
          if (selected.some(ctx => ctx.rework)) {
            need(selected.length === 1 && selected[0].item.id === integrationTaskId && record.reworks.length < record.budget.maxIntegrationReworks);
            const ctx = selected[0], request = plannedIntegrationRework(ctx.result, manifest);
            need(request === ctx.rework && request.taskSetHash === manifest.taskSetHash && request.candidateCommit === ctx.result.candidateCommit
              && request.manifestHash === manifest.manifestHash && request.targets.length === 1 && request.taskIds.length === 1);
            for (const target of request.targets) {
              const owner = tasks.find(item => item.id === target.taskId), entry = record.tasks.find(item => item.id === target.taskId);
              need(owner && owner.id !== integrationTaskId && request.taskIds.includes(owner.id) && target.taskDefinitionHash === taskHash(owner)
                && entry.status === 'completed' && target.requiredPaths.length > 0 && target.requiredPaths.every(file => (owner.writePaths ?? owner.suggestedFiles).includes(file))
                && request.issues.length > 0 && request.issues.every(issue => issue.severity === 'blocking' && issue.status === 'open' && (owner.writePaths ?? owner.suggestedFiles).includes(issue.file)));
              const remaining = remainingFor(entry); need(remaining.maxCalls >= 1 && remaining.maxReviewCalls >= 1);
            }
            const affected = new Set(request.taskIds); let changed = true;
            while (changed) { changed = false; for (const task of tasks) if (!affected.has(task.id) && task.dependsOn.some(id => affected.has(id))) { affected.add(task.id); changed = true; } }
            for (const id of affected) { const remaining = remainingFor(record.tasks.find(item => item.id === id)); need(remaining.maxCalls >= 1 && remaining.maxReviewCalls >= 1); }
            const reworkId = `integration-${record.reworks.length + 1}`, evidenceHash = digest(request);
            // The failed final attempt is settled and stopped before reopening.
            // All operations below are synchronous private transactions.
            const failed = store.worker.finish({ lease: ctx.lease, outcome: 'failed', reason: '当前完整集成要求上游负责者修复。' }); need(failed.current && !failed.completed);
            clearInterval(ctx.heartbeat);
            const reopened = store.control.reopenTasks({ runId: identity.runId, expectedVersion: 1, taskIds: request.taskIds, reworkId, evidenceHash });
            need(digest(reopened.taskIds) === digest([...affected].sort()));
            for (const id of reopened.taskIds) {
              const entry = record.tasks.find(item => item.id === id); need(entry);
              if (entry.record) entry.history.push(entry.record);
              Object.assign(entry, { status: 'pending', record: null, candidateCommit: null, baseCommit: null, attemptId: null });
            }
            source = ctx.source;
            record.reworks.push({ id: reworkId, evidenceHash, requestedAt: new Date().toISOString(), taskIds: request.taskIds, affectedTaskIds: reopened.taskIds,
              failedCandidateCommit: request.candidateCommit, sourceReportHash: resolvePlannedTaskBase(source, identity, allPaths).provenance.sourceReportHash, issues: request.issues });
            batch.status = 'rework_requested'; batch.candidateCommit = request.candidateCommit;
            event({ message: `集成阻塞已退回 ${request.taskIds.join('、')}，其下游重新执行；原预算、历史意见和费用保留。`, type: 'integration_rework_requested', reworkId, taskIds: request.taskIds, affectedTaskIds: reopened.taskIds });
            await save(); continue;
          }
          const nextSource = selected.length === 1 ? selected[0].source : await mergePlannedTaskCandidates({ rootDir: directory, sourceRootDir: directory, binding: identity, manifest, task: confirmed, base: baseHandle, candidates: selected.map(ctx => ({ record: ctx.result, manifest: ctx.definition })), signal: controller.signal, assertCurrent: () => { selected.forEach(assertLease); return true; } });
          selected.forEach(assertLease);
          const merged = resolvePlannedTaskBase(nextSource, identity, allPaths); batch.candidateCommit = merged.provenance.sourceCommit;
          if (selected.length > 1) record.merges.push({ batchId: batch.id, taskIds: batch.taskIds, baseCommit: batch.baseCommit, ...merged.provenance });
          // Single owner only: these are consecutive transactions, not an
          // atomic bulk finalize. No await/observer can dispatch between them.
          for (const ctx of selected) {
            assertLease(ctx); const publication = store.worker.publish({ lease: ctx.lease, publicationId: `candidate-${ctx.lease.attemptId}`, candidateCommit: ctx.result.candidateCommit, sourceHash: ctx.result.versions.at(-1).sourceHash, artifacts: [ctx.result.id] }); need(publication.current); ctx.lease = publication.lease;
            const validationId = `validation-${ctx.lease.attemptId}`, validation = store.control.recordValidation({ lease: ctx.lease, validationId, receipts: receipts(ctx.result, ctx.lease) }); need(validation.current && validation.eligible);
            const finished = store.worker.finish({ lease: ctx.lease, validationId }); need(finished.current && finished.completed); ctx.entry.status = 'completed';
          }
          if (selected[0].item.id === integrationTaskId) integration = selected[0].result;
          source = nextSource; batch.status = 'completed';
          event({ message: `批次 ${batch.id} 已完成同版本独立验收和代码集成，释放下游。`, type: 'batch_completed', batchId: batch.id, taskIds: batch.taskIds, candidateCommit: batch.candidateCommit }); await save();
        } catch (error) { rememberUnknown(error); batch.status = error?.reconciliationRequired || error?.result?.terminationConfirmed === false || selected.some(ctx => ctx.unavailable || ctx.result?.terminationConfirmed === false) ? 'reconciliation_required' : 'failed'; throw error; }
        finally { batch.finishedAt = new Date().toISOString(); for (const ctx of selected) { clearInterval(ctx.heartbeat); notStarted(ctx); } }
      }
      current(); need(store.query.getRun(identity.runId).status === 'succeeded' && isPlannedWebTaskAccepted(integration, manifest));
      record.integration = structuredClone(integration); record.executorPolicyHash = integration.executorPolicyHash;
      for (const key of ['candidateCommit', 'baseCommit', 'workspace', 'browserPolicyHash', 'reviewPolicyHash', 'acceptanceStatus']) record[key] = integration[key];
      record.sourceHash = integration.versions.at(-1).sourceHash; record.integrationReportPath = integration.reportPath;
      record.status = 'accepted'; record.terminationConfirmed = true; event('完整批准清单已在最终集成任务代码上重新验收，未继承局部通过。');
    } catch (error) {
      if (error === handoffSignal && retiring && handoff && !controller.signal.aborted && active.size === 0 && inflight.size === 0) {
        record.status = 'retired_for_recovery'; record.terminationConfirmed = true;
        event({ message: '已冻结安全暂停点并结束本调度器；未执行剩余任务，未授予完整交付。', type: 'checkpoint_retired', checkpointId: handoff.id });
      } else {
      // A first failure never abandons other started workers or their costs.
      if (inflight.size) { cancel(); await Promise.allSettled([...inflight]); }
      rememberUnknown(error);
      const attempts = store?.query.listAttempts(identity.runId) ?? [], unknown = error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false || attempts.some(value => value.terminationState !== 'confirmed') || contexts.some(ctx => ctx.unavailable);
      record.status = unknown ? 'reconciliation_required' : controller.signal.aborted ? Date.now() >= deadline ? 'timed_out' : 'stopped' : 'failed';
      record.terminationConfirmed = !unknown; record.error = '任务执行未获得完整有效结论，已停止派发；原候选、验收和预留保留。';
      if (store) { store.control.requestCancel(identity.runId); store.control.confirmCancel(identity.runId); }
      }
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); for (const ctx of contexts) clearInterval(ctx.heartbeat); record.finishedAt = new Date().toISOString();
      if (store) { record.transaction = store.query.getRun(identity.runId); record.attempts = store.query.listAttempts(identity.runId); record.transactionEvents = store.query.events({ runId: identity.runId, limit: 1000 }).events; }
      try { await save(); } catch { record.status = 'reconciliation_required'; record.terminationConfirmed = false; }
      store?.close();
    }
    const result = structuredClone(record);
    if (record.status === 'accepted') {
      try { proofs.set(result, { manifest, hash: pureHash(result), integration, ...(resumed ? { assertResume: () => need(resumed.assertCurrent() === true) } : {}) }); }
      catch { record.status = 'failed'; record.error = '完整任务证据超过可信快照限制，未授予交付资格；原始候选与费用记录保留。';
        try { await save(); } catch { record.status = 'reconciliation_required'; record.terminationConfirmed = false; }
        return structuredClone(record); }
    }
    return result;
  })();
  const handle = { id: record.id, done, cancel, snapshot: () => structuredClone(record),
    pause() { need(store && !capturing && !handoff && record.status === 'running' && !paused); store.control.pause(identity.runId); paused = true; record.status = 'pause_requested'; event({ message: '已请求暂停新批次派发，在途任务完成后保存。', type: 'pause_requested' }); void save().catch(() => {}); },
    resume() { need(store && !capturing && !handoff && paused && ['pause_requested', 'paused'].includes(record.status)); store.control.resume(identity.runId); paused = false; record.status = 'running'; event({ message: '继续派发当前版本的就绪任务。', type: 'resumed' }); notify(); void save().catch(() => {}); } };
  const graphRecords = () => record.tasks.flatMap(entry => [...entry.history, ...(entry.record ? [entry.record] : [])]);
  const historicalRecords = () => resumed?.checkpoint.graph.tasks.flatMap(entry => [...(entry.history ?? []), ...(entry.record ? [entry.record] : [])]) ?? [];
  const completedOriginals = () => {
    need(record.tasks.some(entry => entry.status === 'completed') && record.tasks.some(entry => entry.status === 'pending')
      && record.tasks.every(entry => ['completed', 'pending'].includes(entry.status)) && active.size === 0 && inflight.size === 0
      && contexts.every(ctx => ctx.result && !ctx.unavailable && ctx.settled && ctx.result.terminationConfirmed === true));
    const saved = graphRecords(), historical = historicalRecords();
    if (resumed) need(resumed.assertCurrent() === true);
    need(saved.length === contexts.length + historical.length && new Set(saved.map(item => item.id)).size === saved.length
      && historical.every(item => saved.some(value => value.id === item.id && pureHash(value) === pureHash(item))));
    for (const ctx of contexts) {
      need(saved.some(item => item.id === ctx.result.id && pureHash(item) === pureHash(ctx.result)));
      if (ctx.entry.record?.id === ctx.result.id && ctx.entry.status === 'completed') need(isPlannedWebTaskAccepted(ctx.result, ctx.definition));
    }
    const attempts = store.query.listAttempts(identity.runId); need(attempts.length === contexts.length + (resumed?.checkpoint.graph.attempts.length ?? 0) && attempts.every(attempt => attempt.terminationState === 'confirmed' && attempt.status !== 'leased')
      && store.query.getRun(identity.runId).budget.unknown === 0);
    return saved;
  };
  const auditOriginals = async () => {
    current();
    need(contexts.every(ctx => ctx.result && !ctx.unavailable && ctx.settled && ctx.result.terminationConfirmed === true));
    for (const original of [...historicalRecords(), ...contexts.map(ctx => ctx.result)]) {
      await inspectPlannedSource({ rootDir: directory, reportPath: original.reportPath, binding: identity, writablePaths: allPaths,
        expectedRecord: original, signal: controller.signal, timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) }); current();
    }
    const prior = resolvePlannedTaskBase(source, identity, allPaths);
    const checked = await inspectPlannedSource({ rootDir: directory, reportPath: prior.provenance.sourceReportPath, binding: identity, writablePaths: allPaths,
      signal: controller.signal, timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) }); current();
    const actual = resolvePlannedTaskBase(checked, identity, allPaths); need(actual.provenance.sourceReportHash === prior.provenance.sourceReportHash
      && actual.provenance.sourceCommit === prior.provenance.sourceCommit && actual.provenance.sourceHash === prior.provenance.sourceHash);
  };
  taskHandles.set(handle, { manifest,
    async capture() {
      if (handoff) { assertPausedTaskCheckpoint(handoff, { manifest }); return handoff; }
      current(); need(!capturing && paused && record.status === 'paused'); capturing = true;
      try {
        await queue; current(); completedOriginals(); await auditOriginals(); await queue; current(); completedOriginals(); need(record.status === 'paused' && store.query.getRun(identity.runId).status === 'paused');
        const snapshot = structuredClone(record); snapshot.transaction = store.query.getRun(identity.runId); snapshot.attempts = store.query.listAttempts(identity.runId);
        snapshot.transactionEvents = store.query.events({ runId: identity.runId, limit: 1000 }).events;
        const payload = { version: 1, purpose: 'taskflow/task-dependency-checkpoint/v1', checkpointId: randomUUID(), graphId: record.id,
          binding: { ...identity, sourceRevision: binding.sourceRevision ?? null, sourceGeneration: binding.sourceGeneration ?? null },
          manifestHash: manifest.manifestHash, taskSetHash: manifest.taskSetHash, taskDefinitionHash: taskHash(confirmed), task: confirmed,
          taskRootDir: directory, taskDatabase: path.join(directory, 'tasks.sqlite'), writablePaths: allPaths,
          deadlineAt: deadline, startedAt: record.startedAt, budget: record.budget, graph: snapshot, currentSource: resolvePlannedTaskBase(source, identity, allPaths).provenance };
        const evidenceHash = taskHash(payload), frozen = store.control.freezeHandoff({ runId: identity.runId, expectedVersion: snapshot.transaction.version, checkpointId: payload.checkpointId, evidenceHash });
        const { duplicate, ...freeze } = frozen; payload.freeze = freeze; freezeData(payload);
        handoff = Object.freeze({ kind: 'original_paused_task_checkpoint', id: payload.checkpointId });
        const originalHashes = contexts.map(ctx => pureHash(ctx.result)); let liveHash;
        const assert = () => {
          current(); need(handoff && !capturing && (!retiring ? record.status === 'handoff_frozen' : ['handoff_frozen', 'retired_for_recovery'].includes(record.status))
            && liveHash === pureHash(record) && contexts.every((ctx, index) => pureHash(ctx.result) === originalHashes[index]));
          const frozenState = inspectFrozenTaskHandoff({ filename: payload.taskDatabase, runId: identity.runId, checkpointId: payload.checkpointId });
          need(taskHash(frozenState) === taskHash(payload.freeze));
        };
        record.status = 'handoff_frozen'; event({ message: '真实暂停点已冻结，旧调度器不能继续派发。', type: 'checkpoint_frozen', checkpointId: handoff.id }); await save();
        liveHash = pureHash(record); capturing = false;
        pausedCheckpoints.set(handoff, { manifest, payload, assert, audit: async () => { assert(); await auditOriginals(); assert(); }, setRetiredHash: () => { liveHash = pureHash(record); } });
        assert(); return handoff;
      } finally { capturing = false; }
    },
    async retire(checkpoint) {
      if (retirement) { assertRetiredTaskCheckpoint(retirement, { checkpoint, manifest }); return retirement; }
      need(checkpoint === handoff && !retiring); await auditPausedTaskCheckpoint(checkpoint, { manifest });
      retiring = true; paused = false; notify(); const result = await done;
      need(result.status === 'retired_for_recovery' && result.terminationConfirmed === true && active.size === 0 && inflight.size === 0);
      const proof = pausedCheckpoints.get(checkpoint); proof.setRetiredHash(); proof.assert();
      const value = freezeData({ version: 1, purpose: 'taskflow/task-scheduler-retirement/v1', checkpointHash: taskHash(proof.payload), checkpointId: checkpoint.id,
        graphId: record.id, retiredAt: record.finishedAt, retiredRecordHash: taskHash(result), pid: process.pid, terminationConfirmed: true });
      retirement = Object.freeze({ kind: 'original_task_scheduler_retirement', id: randomUUID() }); retiredCheckpoints.set(retirement, { checkpoint, manifest, value, assert: proof.assert }); return retirement;
    } });
  return handle;
}
