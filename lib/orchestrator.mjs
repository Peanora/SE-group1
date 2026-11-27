import { randomUUID, createHash } from 'node:crypto';
import { startSpecificationMeeting, advanceSpecificationMeeting, assertSpecificationMeeting, currentMeeting, specificationMeetingIssue, prepareMeetingAnswers, meetingArtifacts } from './specification-meeting.mjs';
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './documents.mjs';
import { MAX_PLANNING_VERSIONS, planningSourceText, planningQuoteSources, contentRevision, preparePlanningSpec, validatePlanningTasks, planningRevision, planningFeedback, assertCurrentRevision, assertSpecApproval } from './planning-review.mjs';
import { createEngineeringModel, engineeringModelPolicy } from './engineering-model.mjs';
import { inspectEngineeringContext, validateEngineeringPlan } from './engineering-plan.mjs';
import { engineeringTasks, finalizeEngineeringWorkflow, renderEngineeringArchitecture, renderEngineeringTasks, assertEngineeringAlignment, reviseEngineeringTasks, reviseEngineeringRouteRoles } from './engineering-planner.mjs';
import { reviseEngineeringRouteContracts } from './engineering-route-contracts.mjs';
import { readSpecificationReceipt, specificationReceipt, specificationReceiptInfo, specificationData, specificationFromReceipt, writeSpecificationReceipt } from './specification-receipts.mjs';

import { specificationFailure, specificationRepairField } from './specification-failure.mjs';

import { clarificationFollowUps, clarificationKey, clarificationSources, confirmedSourceText, distinctClarificationQuestions, latestClarificationSources, needsConcreteAnswer, submittedClarifications } from './clarification-sources.mjs';
import { getModelRequestEvidence } from './model-request-evidence.mjs';
import { applyPlatformDefaults, technicalQuestion } from './platform-defaults.mjs';
import { decodePlanningIssue } from './planner.mjs';
import { guardModelContent } from './model-content-guard.mjs';
import { estimateModelCall } from './planned-model-cost.mjs';
import { inspectPlannedTaskGraph } from './planned-task-executor.mjs';
import { inspectVerificationTasks } from './verification-task-scopes.mjs';

export const WORKFLOW = [
  { id: 'intake', title: '读取需求文档', dependsOn: [] },
  { id: 'spec', title: '整理设计规格', dependsOn: ['intake'] },
  { id: 'architecture', title: '设计项目架构', dependsOn: ['spec'] },
  { id: 'tasks', title: '拆解开发任务', dependsOn: ['spec'] },
  { id: 'review', title: '检查依赖与覆盖', dependsOn: ['architecture', 'tasks'] },
  { id: 'export', title: '确认并导出文档', dependsOn: ['review'] },
];

const ACTIVE_STATUSES = new Set(['running', 'paused', 'awaiting_spec', 'awaiting_review']);
const validCallLimit = value => value === null || Number.isSafeInteger(value) && value > 0 && value <= 20;
// A controller set to unlimited replaces earlier numeric defaults. When a
// deployment explicitly uses a finite policy, it can only tighten saved limits.
const effectiveCallLimit = (saved, configured) => configured === null ? null : Math.min(saved ?? configured, configured);
const titles = { 'spec.md': '设计规格', 'architecture.md': '项目架构', 'task.md': '开发任务', 'review.md': '检查报告', 'handoff.md': '开发交接', 'plan.json': '结构化计划' };

function addEvent(run, message, stageId = null, level = 'info') {
  run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, time: new Date().toISOString(), stageId, level, message });
  run.updatedAt = new Date().toISOString();
}

function assertDependencyExecutionPlan(spec, tasks) {
  try {
    inspectPlannedTaskGraph({ tasks });
    inspectVerificationTasks(tasks, spec.requirements.map(requirement => requirement.id));
  }
  catch (error) {
    const message = ['unsupported_task_graph', 'invalid_contract'].includes(error?.code) ? error.hint ?? error.message : '无法校验当前任务图的执行条件。';
    throw Object.assign(new HttpError(409, message), { code: 'unsupported_task_graph' });
  }
}

// Module lanes organize a multi-module plan. Only its direct edges grant readiness.
// Plans outside the worker's admission limits can still be reviewed and exported.
function isModuleWorkflow(engineeringPlan, tasks) {
  return Boolean(engineeringPlan && tasks.length > 1 && tasks.every(task => task.workflowModule));
}

function descendants(run, ids) {
  const found = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of run.stages) {
      if (!found.has(stage.id) && stage.dependsOn.some(id => found.has(id))) { found.add(stage.id); changed = true; }
    }
  }
  return found;
}

export class Orchestrator {
  constructor(store, planner, { stepDelayMs = 350, concurrency = 2, engineeringMaxCalls = null, engineeringTimeoutMs = 60000, engineeringTotalTimeoutMs = 600000, specificationMaxCalls = null, specificationTimeoutMs = 90000 } = {}) {
    this.store = store;
    this.planner = planner;
    this.stepDelayMs = Math.max(0, Math.min(5000, Number(stepDelayMs) || 0));
    this.concurrency = concurrency;
    this.runtime = new Map();
    this.closed = false;
    if (!validCallLimit(engineeringMaxCalls) || !Number.isInteger(engineeringTimeoutMs) || engineeringTimeoutMs < 1 || engineeringTimeoutMs > 120000
      || !Number.isInteger(engineeringTotalTimeoutMs) || engineeringTotalTimeoutMs < 1 || engineeringTotalTimeoutMs > 3_600_000) throw new Error('工程规划预算无效。');
    this.engineeringMaxCalls = engineeringMaxCalls;
    this.engineeringTimeoutMs = engineeringTimeoutMs;
    this.engineeringTotalTimeoutMs = engineeringTotalTimeoutMs;
    this.engineering = new Map();
    this.engineeringPending = new Set();
    if (!validCallLimit(specificationMaxCalls) || !Number.isInteger(specificationTimeoutMs) || specificationTimeoutMs < 1 || specificationTimeoutMs > 90000) throw new Error('规格规划预算无效。');
    this.specificationMaxCalls = specificationMaxCalls;
    this.specificationTimeoutMs = specificationTimeoutMs;
    this.specification = new Map();
    this.specificationPending = new Set();
    this.planningInputIssues = new Map();
    this.projectActions = new Set();
    this.projectCheckpoints = new Set();
    this.projectAdmissions = new Set();
    this.checkpointWork = new Set();
  }

  sourceSuperseded(project, run) {
    return run.sourceSuperseded === true || project.currentSourceRevision !== undefined && run.sourceRevision !== project.currentSourceRevision;
  }

  assertProjectAvailable(project, run) {
    if (this.closed || this.projectCheckpoints.has(project.id)) throw Object.assign(new HttpError(409, '项目正在输入变更检查点或服务停止中，请稍后重试。'), { code: 'project_checkpoint' });
    this.assertSimulationIdle?.(project.id);
    if (run && this.sourceSuperseded(project, run)) throw Object.assign(new HttpError(409, '旧输入版本的运行只保留历史，请为当前输入新建运行。'), { code: 'source_superseded' });
  }

  /** Trusted, non-waiting barrier. It does not cancel or claim to stop active work. */
  async withProjectCheckpoint(projectId, work) {
    const project = this.store.get(projectId);
    this.assertProjectAvailable(project);
    if (typeof work !== 'function') throw new HttpError(400, '检查点需要可信工作入口。');
    this.projectCheckpoints.add(projectId);
    let complete;
    const completion = new Promise(resolve => { complete = resolve; }); this.checkpointWork.add(completion);
    try {
      if (this.projectAdmissions.has(projectId) || this.projectActions?.has(projectId) || this.hasSpecificationWork(projectId) || project.runs.some(run => {
        const state = this.runtime.get(run.id);
        return state?.active.size || state?.driving || state?.actionBusy || !Array.isArray(run.stages) || run.stages.some(stage => stage.status === 'running');
      })) throw Object.assign(new HttpError(409, '项目仍有规划操作在途，请等待阶段边界后应用。'), { code: 'project_busy' });
      await this.store.flush(projectId);
      if (this.closed) throw new HttpError(409, '服务正在停止，未开始输入发布。');
      return await work();
    } finally {
      this.projectCheckpoints.delete(projectId);
      this.checkpointWork.delete(completion); complete();
      for (const run of project.runs) if (!this.sourceSuperseded(project, run) && run.status === 'running') this.schedule(project, run);
    }
  }

  usesEngineering(run) { return run.workflowVersion === 2 && run.mode === 'model' && !run.engineeringFallback; }

  hasSpecificationWork(projectId, runId) {
    // Historical name retained for existing callers; this is the shared planning barrier.
    if ([...this.specificationPending, ...this.engineeringPending].some(entry => entry.projectId === projectId && (!runId || entry.runId === runId))) return true;
    const project = this.store.get(projectId);
    return project.runs.some(run => (!runId || run.id === runId) && [...(run.specificationHistory ?? []), ...(run.engineeringHistory ?? []), ...(run.planningIssueHistory ?? [])]
      .some(attempt => attempt.coordinationRequired === true && attempt.coordination?.resolved !== true));
  }

  planningEvidence(entry) {
    const proofs = [entry.nativeResult, entry.nativeError, entry.nativeRequest, entry.receiptEvidence].map(getModelRequestEvidence).filter(Boolean);
    return proofs.find(proof => proof.responseComplete) ?? proofs[0] ?? null;
  }

  planningKnown(entry) {
    const proof = this.planningEvidence(entry);
    return !entry.providerInvoked || !!proof && (!proof.dispatched || proof.responseComplete);
  }

  finalizePlanningAttempt(entry, attempt) {
    const proof = this.planningEvidence(entry);
    attempt.transport = { version: 1, dispatched: !entry.providerInvoked ? false : proof?.dispatched ?? null, responseComplete: proof?.responseComplete === true };
    attempt.requestState = !entry.providerInvoked || proof?.dispatched === false ? 'not_started' : proof?.responseComplete === true ? 'settled' : 'unconfirmed';
    attempt.coordinationRequired = !entry.requestSettled || !entry.receiptSettled || !this.planningKnown(entry);
  }

  async reconcilePlanning(project, entry, attempt, pending) {
    if (!entry.finalized || entry.reconciling || !entry.requestSettled || !entry.receiptSettled || !this.planningKnown(entry)) return;
    if (!attempt.coordinationRequired) { pending.delete(entry); return; }
    if (this.closed) return;
    entry.reconciling = true;
    const previous = attempt.coordination;
    attempt.coordination = { resolved: true, at: new Date().toISOString(), transport: this.planningEvidence(entry) ?? { dispatched: false, responseComplete: false } };
    try { await this.persist(project); pending.delete(entry); }
    catch { if (previous === undefined) delete attempt.coordination; else attempt.coordination = previous; }
    finally { entry.reconciling = false; }
  }

  engineeringBudget(run) {
    const previous = run.engineeringBudget ?? { maxCalls: this.engineeringMaxCalls, timeoutMs: this.engineeringTimeoutMs, totalTimeoutMs: this.engineeringTotalTimeoutMs };
    if (!previous || Object.keys(previous).sort().join(',') !== 'maxCalls,timeoutMs,totalTimeoutMs' || !validCallLimit(previous.maxCalls) || !Number.isInteger(previous.timeoutMs) || previous.timeoutMs < 1 || previous.timeoutMs > 120000 || !Number.isInteger(previous.totalTimeoutMs) || previous.totalTimeoutMs < 1 || previous.totalTimeoutMs > 3600000) throw Object.assign(new Error('工程运行预算记录无效。'), { code: 'invalid_input' });
    const maxCalls = effectiveCallLimit(previous.maxCalls, this.engineeringMaxCalls) ?? (run.automaticDelivery ? previous.maxCalls : null);
    return { maxCalls, timeoutMs: Math.min(previous.timeoutMs, this.engineeringTimeoutMs), totalTimeoutMs: Math.min(previous.totalTimeoutMs, this.engineeringTotalTimeoutMs) };
  }

  engineeringRemaining(run) {
    const reserved = run.engineeringCalls ?? 0, history = run.engineeringHistory ?? [];
    if (!Number.isSafeInteger(reserved) || reserved < 0 || !Array.isArray(history)) throw Object.assign(new Error('工程调用历史无效。'), { code: 'invalid_input' });
    const { maxCalls } = this.engineeringBudget(run);
    return maxCalls === null ? null : Math.max(0, maxCalls - Math.max(reserved, history.length));
  }

  specificationBudget(run) {
    const budget = specificationData(run.specificationBudget ?? { maxCalls: this.specificationMaxCalls, timeoutMs: this.specificationTimeoutMs });
    if (Object.keys(budget ?? {}).sort().join(',') !== 'maxCalls,timeoutMs' || !validCallLimit(budget.maxCalls) || !Number.isInteger(budget.timeoutMs) || budget.timeoutMs < 1 || budget.timeoutMs > 90000) throw new Error('规格运行预算记录无效。');
    const maxCalls = effectiveCallLimit(budget.maxCalls, this.specificationMaxCalls) ?? (run.automaticDelivery ? budget.maxCalls : null);
    return { maxCalls, timeoutMs: Math.min(this.specificationTimeoutMs, budget.timeoutMs) };
  }

  assertSpecificationCurrent(project, run, entry) {
    if (entry.deadline && Date.now() >= entry.deadline) { entry.timedOut = true; entry.controller.abort(); }
    if (this.closed || entry.controller.signal.aborted || this.specification.get(entry.runId) !== entry) throw Object.assign(new Error('规格调用已中断。'), { code: entry.timedOut ? 'model_timeout' : 'cancelled' });
    if (this.store.get(project.id) !== project || project.id !== entry.projectId || run.id !== entry.runId || !project.runs.includes(run) || run.mode !== 'model' || !['running', 'paused'].includes(run.status)
      || this.sourceSuperseded(project, run) || this.projectCheckpoints.has(project.id) || contentRevision(run.sourceSnapshot ?? project.source) !== entry.sourceRevision
      || (run.sourceRevision ?? entry.sourceRevision) !== entry.sourceRevision || run.specRevision !== entry.specRevision || run.stages.find(stage => stage.id === 'spec') !== entry.stage || entry.stage.status !== 'running' || contentRevision(planningSourceText(run, project.source)) !== entry.inputRevision) throw Object.assign(new Error('规格调用所属运行或输入已失效。'), { code: 'stale_revision' });
  }

  writeSpecificationReceipt(project, run, attempt, receipt, signal) {
    return writeSpecificationReceipt(this.store.directory, project.id, run.id, attempt.id, receipt, signal);
  }

  async requestSpecification(project, run, stage) {
    const history = run.specificationHistory ?? [], reserved = run.specificationCalls ?? 0;
    const budget = this.specificationBudget(run);
    if (!Array.isArray(history) || !Number.isSafeInteger(reserved) || reserved < 0) throw Object.assign(new Error('规格调用历史无效。'), { code: 'invalid_input' });
    if (this.specificationRemaining(run) === 0) throw Object.assign(new Error('规格调用尝试预算已用尽。'), { code: 'budget_exhausted' });
    if (this.hasSpecificationWork(project.id, run.id)) throw Object.assign(new Error('前次规格请求或回执仍待核对。'), { code: 'specification_pending' });
    const entry = { projectId: project.id, runId: run.id, sourceRevision: contentRevision(run.sourceSnapshot ?? project.source), specRevision: run.specRevision, inputRevision: contentRevision(planningSourceText(run, project.source)), projectName: project.name,
      stage, timeoutMs: Math.min(this.specificationTimeoutMs, budget.timeoutMs), controller: new AbortController(), requestSettled: true, receiptSettled: true };
    const source = { ...(run.sourceSnapshot ?? project.source), content: planningSourceText(run, project.source) }, attempt = { id: randomUUID(), attempt: history.length + 1, sourceRevision: entry.sourceRevision, inputRevision: entry.inputRevision,
      status: 'running', startedAt: new Date().toISOString(), finishedAt: null, model: null, usage: { inputTokens: null, outputTokens: null }, finishReason: null, receipt: null, receiptState: 'not_received', requestState: 'not_started', transport: { version: 1, dispatched: false, responseComplete: false }, code: null };
    run.specificationBudget = budget; run.specificationHistory = history; history.push(attempt); this.specification.set(run.id, entry); this.specificationPending.add(entry);
    let timer, receipt, modelPrice, receiptWrites = Promise.resolve(), accepting = true, aborted, receiptError;
    const release = () => { void this.reconcilePlanning(project, entry, attempt, this.specificationPending); };
    const failure = (code, error) => {
      const detail = specificationFailure(code, error?.reason, error?.requirementIndex, { requirementTitle: error?.requirementTitle, field: error?.field, detail: error?.publicDetail });
      Object.assign(attempt, { code, reason: detail.reason, message: detail.message, ...(detail.requirementIndex ? { requirementIndex: detail.requirementIndex } : {}), ...(detail.requirementTitle ? { requirementTitle: detail.requirementTitle } : {}), ...(detail.detail ? { detail: detail.detail } : {}) });
      attempt.status = code === 'cancelled' ? 'interrupted' : 'failed'; return Object.assign(new Error(detail.message), { code });
    };
    try {
      this.assertSpecificationCurrent(project, run, entry);
      run.specificationCalls = Math.max(reserved, history.length - 1) + 1;
      await this.persist(project);
      this.assertSpecificationCurrent(project, run, entry);
      entry.deadline = Date.now() + entry.timeoutMs;
      timer = setTimeout(() => { entry.timedOut = true; entry.controller.abort(); }, entry.timeoutMs);
      const interrupted = new Promise((_, reject) => {
        aborted = () => reject(Object.assign(new Error('规格请求已中断。'), { code: entry.timedOut ? 'model_timeout' : 'cancelled' }));
        entry.controller.signal.addEventListener('abort', aborted, { once: true }); if (entry.controller.signal.aborted) aborted();
      });
      // Observe a timeout during the durable intent write, before the request race is active.
      void interrupted.catch(() => {});
      attempt.requestState = 'dispatch_intent'; attempt.coordinationRequired = true; attempt.transport = { version: 1, dispatched: null, responseComplete: false };
      await this.persist(project); this.assertSpecificationCurrent(project, run, entry);
      entry.requestSettled = false;
      const request = Promise.resolve().then(() => {
        this.assertSpecificationCurrent(project, run, entry);
        this.assertAutomaticDispatch?.(run);
        entry.providerInvoked = true;
        const openQuestions = run.clarificationHistory?.at(-1)?.openQuestions;
        const previousAttempt = history.at(-2);
        const quoteFailure = previousAttempt?.reason === 'requirement_quote_not_found';
        entry.nativeRequest = this.planner.analyzeWithModel(source.content, entry.projectName, { signal: entry.controller.signal, timeoutMs: entry.timeoutMs, usePlatformDefaults: run.workflowVersion === 2, confirmedSources: confirmedSourceText(run), quoteSources: planningQuoteSources(run, project.source),
          ...(this.planner.recordsModelPricing ? { onModelPrice: price => { modelPrice = price; } } : {}),
          afterClarification: Boolean(submittedClarifications(run)), repairUnsupportedDraft: quoteFailure, ...(openQuestions?.length ? { openQuestions } : {}), onReceipt: (value, proof) => {
          try {
            this.assertSpecificationCurrent(project, run, entry);
            if (getModelRequestEvidence(proof)?.responseComplete !== true) throw Object.assign(new Error('规格回执缺少原生完整响应证据。'), { code: 'receipt_failed' });
            entry.receiptEvidence = proof;
            if (!accepting || receipt || receiptError) throw Object.assign(new Error('无效或重复规格回执。'), { code: 'receipt_failed' });
            const captured = specificationReceipt(value); receipt = captured.receipt;
            if (captured.credentialResponse) receiptError = 'credential_response';
            Object.assign(attempt, { model: receipt.model, usage: { ...receipt.usage }, finishReason: receipt.finishReason, receiptState: 'writing' });
            entry.receiptSettled = false;
            receiptWrites = Promise.resolve().then(() => this.writeSpecificationReceipt(project, run, attempt, receipt, entry.controller.signal)).then(metadata => {
              metadata = specificationReceiptInfo(metadata, attempt.id);
              entry.receiptSettled = true; release();
              if (accepting && !entry.controller.signal.aborted && !this.closed && this.specification.get(run.id) === entry) {
                attempt.receipt = metadata; attempt.receiptState = 'saved';
                if (modelPrice) attempt.costEstimate = estimateModelCall(receipt, modelPrice);
              }
            }).catch(() => {
              entry.receiptSettled = true; release(); if (accepting && !entry.controller.signal.aborted) attempt.receiptState = 'failed';
              throw Object.assign(new Error('规格回执写入失败。'), { code: 'receipt_failed' });
            });
            void receiptWrites.catch(() => {}); return Promise.race([receiptWrites, interrupted]);
          } catch (error) { receiptError = ['credential_response', 'stale_revision', 'cancelled', 'model_timeout'].includes(error.code) ? error.code : 'receipt_failed'; throw Object.assign(new Error('规格回执未被接受。'), { code: receiptError }); }
        } });
        return Promise.resolve(entry.nativeRequest).then(result => { entry.nativeResult = result; return result; }, error => { entry.nativeError = error; throw error; });
      }).finally(() => { entry.requestSettled = true; release(); });
      const result = await Promise.race([request, interrupted]);
      this.assertSpecificationCurrent(project, run, entry); await Promise.race([receiptWrites, interrupted]); this.assertSpecificationCurrent(project, run, entry);
      if (this.planningEvidence(entry)?.responseComplete !== true) throw Object.assign(new Error('规格原生传输尚未完整核对。'), { code: 'transport_error' });
      if (receiptError) throw Object.assign(new Error('规格回执被拒绝。'), { code: receiptError });
      if (!receipt || !attempt.receipt || attempt.receiptState !== 'saved') throw Object.assign(new Error('规格缺少已保存的私有回执。'), { code: 'receipt_failed' });
      const normalized = await specificationFromReceipt(receipt, source.content, entry.projectName, { signal: entry.controller.signal, timeoutMs: Math.max(1, entry.deadline - Date.now()), usePlatformDefaults: run.workflowVersion === 2, confirmedSources: confirmedSourceText(run), quoteSources: planningQuoteSources(run, project.source) });
      this.assertSpecificationCurrent(project, run, entry);
      const copied = specificationData(result);
      if (contentRevision(copied) !== contentRevision(normalized)) throw Object.assign(new Error('规格与私有回执不等价。'), { code: 'invalid_model_response' });
      attempt.status = 'validated'; return copied;
    } catch (error) {
      const known = new Set(['invalid_input', 'transport_error', 'http_error', 'response_error', 'response_too_large', 'receipt_failed', 'credential_response', 'abnormal_finish', 'invalid_model_response', 'model_timeout', 'cancelled', 'stale_revision', 'persistence_failed']);
      throw failure(entry.timedOut ? 'model_timeout' : entry.controller.signal.aborted || this.closed ? 'cancelled' : receiptError ?? (known.has(error.code) ? error.code : 'invalid_model_response'), error);
    } finally {
      accepting = false; clearTimeout(timer); if (aborted) entry.controller.signal.removeEventListener('abort', aborted);
      this.finalizePlanningAttempt(entry, attempt);
      if (receipt && this.planningEvidence(entry)?.responseComplete !== true) attempt.receiptState = 'unconfirmed';
      if (!entry.receiptSettled) attempt.receiptState = 'unconfirmed';
      attempt.finishedAt = new Date().toISOString(); release();
      try {
        try { await this.persist(project); } catch { attempt.persistenceStatus = 'failed'; throw failure('persistence_failed'); }
        if (attempt.status === 'validated') {
          try { this.assertSpecificationCurrent(project, run, entry); }
          catch (error) { throw failure(entry.timedOut ? 'model_timeout' : this.closed ? 'cancelled' : error.code === 'stale_revision' ? 'stale_revision' : 'cancelled'); }
        }
      } finally { entry.finalized = true; release(); if (this.specification.get(entry.runId) === entry) this.specification.delete(entry.runId); }
    }
  }

  async persist(project) {
    try { await this.store.save(project); }
    catch { throw Object.assign(new Error('运行记录保存失败，请保留现场并检查本地存储后重试。'), { code: 'persistence_failed' }); }
  }

  assertEngineeringCurrent(project, run, entry) {
    if (entry.deadline && Date.now() >= entry.deadline) { entry.timedOut = true; entry.controller.abort(); }
    if (this.closed || entry.controller.signal.aborted || this.engineering.get(run.id) !== entry) throw Object.assign(new Error('工程规划已停止，不能发布迟到结果。'), { code: 'cancelled' });
    try {
      assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), entry.sourceRevision);
      assertCurrentRevision(run.sourceRevision, entry.sourceRevision);
      assertCurrentRevision(run.specRevision, entry.specRevision);
      assertSpecApproval(run);
    } catch { throw Object.assign(new Error('工程规划的规格或需求版本已失效。'), { code: 'stale_revision' }); }
  }

  engineeringReceiptMetadata(receipt) {
    const finishes = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'unknown']);
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'content,finishReason,model,usage' || typeof receipt.content !== 'string' || Buffer.byteLength(receipt.content) > 256 * 1024 || typeof receipt.model !== 'string' || !receipt.model.trim() || receipt.model.length > 200 || !finishes.has(receipt.finishReason)) throw new Error('receipt_failed');
    const usage = receipt.usage;
    if (!usage || Object.keys(usage).sort().join(',') !== 'inputTokens,outputTokens' || !Object.values(usage).every(value => value === null || Number.isSafeInteger(value) && value >= 0)) throw new Error('receipt_failed');
    return { model: receipt.model, usage: { ...usage }, finishReason: receipt.finishReason };
  }

  async writeEngineeringReceipt(project, run, attempt, receipt, signal) {
    const check = () => { if (signal?.aborted) throw Object.assign(new Error('回执保存已中断。'), { code: 'receipt_failed' }); };
    check();
    // Only server-created UUIDs may form private file names; never accept a caller path.
    if (![project.id, run.id, attempt.id].every(id => /^[0-9a-f-]{36}$/u.test(id))) throw new Error('receipt_failed');
    let directory = this.store.directory;
    const base = await lstat(directory);
    check();
    if (!base.isDirectory() || base.isSymbolicLink()) throw new Error('receipt_failed');
    for (const segment of ['.private', 'engineering-receipts', project.id, run.id]) {
      directory = path.join(directory, segment);
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      check();
      const stat = await lstat(directory);
      check();
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('receipt_failed');
    }
    const contents = JSON.stringify({ model: receipt.model, finishReason: receipt.finishReason, usage: receipt.usage, content: receipt.content });
    check();
    await writeFile(path.join(directory, `${attempt.id}.json`), contents, { flag: 'wx', mode: 0o600, signal });
    check();
    return { id: attempt.id, sha256: createHash('sha256').update(contents).digest('hex'), bytes: Buffer.byteLength(contents) };
  }

  async readEngineeringReceipt(project, run, attempt) {
    if (![project.id, run.id, attempt?.id].every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id)) || !attempt.receipt || attempt.receiptState !== 'saved') throw new HttpError(409, '没有可重新校验的工程草案。');
    const filename = path.join(this.store.directory, '.private', 'engineering-receipts', project.id, run.id, `${attempt.id}.json`);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new HttpError(409, '工程草案回执不是普通文件，不能重新校验。');
    const bytes = await readFile(filename);
    if (bytes.length !== attempt.receipt.bytes || createHash('sha256').update(bytes).digest('hex') !== attempt.receipt.sha256) throw new HttpError(409, '工程草案回执已变化，不能重新校验。');
    let raw;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(409, '工程草案回执不是有效JSON，不能免费重新校验。'); }
    const receipt = { model: raw.model, finishReason: raw.finishReason, usage: raw.usage, content: raw.content };
    this.engineeringReceiptMetadata(receipt);
    return receipt;
  }

  engineeringTimeRemaining(run) {
    const budget = this.engineeringBudget(run);
    const historyTimes = (run.engineeringHistory ?? []).map(attempt => Date.parse(attempt.startedAt)).filter(Number.isFinite);
    const since = budget.maxCalls === null ? run.engineeringBatchStartedAt ?? run.engineeringStartedAt : run.engineeringStartedAt;
    const started = since ? Date.parse(since) : historyTimes.length ? Math.min(...historyTimes) : NaN;
    if (!Number.isFinite(started)) return (run.engineeringCalls ?? 0) > 0 || (run.engineeringHistory?.length ?? 0) > 0 || run.engineeringStartedAt !== undefined ? 0 : budget.totalTimeoutMs;
    return Math.max(0, budget.totalTimeoutMs - (Date.now() - started));
  }

  engineeringDraft(project, run) {
    assertSpecApproval(run);
    if (run.engineeringPlan) return Promise.resolve(assertEngineeringAlignment(run));
    let entry = this.engineering.get(run.id);
    if (entry && (entry.specRevision !== run.specRevision || entry.sourceRevision !== run.sourceRevision)) { entry.controller.abort(); this.engineering.delete(run.id); entry = null; }
    if (entry) return entry.promise;
    if (this.hasSpecificationWork(project.id)) return Promise.reject(Object.assign(new Error('前次规划请求或私有回执仍待核对，不能重复派发。'), { code: 'planning_pending' }));
    const budgetError = () => Object.assign(new Error('工程模型总时长预算已用尽；可重新校验保存草案或改用本地规则生成。'), { code: 'invalid_model_response', publicDetail: '工程模型总时长预算已用尽。' });
    const start = feedback => {
      const next = { projectId: project.id, runId: run.id, specRevision: run.specRevision, sourceRevision: run.sourceRevision, controller: new AbortController(), status: 'running', requestSettled: true, receiptSettled: true,
        timeoutMs: Math.max(1, Math.min(this.engineeringBudget(run).timeoutMs, this.engineeringTimeRemaining(run))) };
      this.engineering.set(run.id, next);
      const promise = this.requestEngineering(project, run, next, feedback);
      next.promise = promise;
      return { entry: next, promise };
    };
    const attempt = (feedback, previousDetail) => {
      if (this.engineeringRemaining(run) === 0) return Promise.reject(Object.assign(new Error('工程调用次数已用尽；可免费重新校验保存草案或改用本地规则生成。'), { code: 'budget_exhausted' }));
      if (this.engineeringTimeRemaining(run) <= 0) return Promise.reject(budgetError());
      run.engineeringStartedAt ??= [...(run.engineeringHistory ?? [])].map(attempt => attempt.startedAt).filter(value => Number.isFinite(Date.parse(value))).sort()[0] ?? new Date().toISOString();
      const active = start(feedback);
      const chain = active.promise.catch(error => {
        // Repairs share the frozen run budget and require confirmed transport.
        if (error?.code !== 'invalid_model_response' || !error.publicDetail || this.closed
          || this.engineering.get(run.id) !== active.entry || active.entry.controller.signal.aborted) throw error;
        if (error.publicDetail === previousDetail) throw Object.assign(new Error('工程草案连续返回相同校验错误，自动修正已停止；请重新校验保存草案或改用本地规则生成。'), { code: 'invalid_model_response', publicDetail: error.publicDetail });
        if (this.hasSpecificationWork(project.id)) throw error;
        if (this.engineeringTimeRemaining(run) <= 0) throw budgetError();
        addEvent(run, '工程草案未通过结构校验，正在根据具体原因继续自动修正。', 'architecture');
        this.engineering.delete(run.id);
        return attempt(error.publicDetail, error.publicDetail);
      });
      active.entry.promise = chain;
      return chain;
    };
    return attempt('', null);
  }

  async requestEngineering(project, run, entry, feedback = '') {
    if (this.engineeringRemaining(run) === 0) throw Object.assign(new Error('工程调用次数已用尽。'), { code: 'budget_exhausted' });
    run.engineeringBudget = this.engineeringBudget(run);
    const attempt = { id: randomUUID(), attempt: (run.engineeringHistory?.length ?? 0) + 1, specRevision: entry.specRevision, sourceRevision: entry.sourceRevision, modelPolicyHash: engineeringModelPolicy.hash, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, model: null, usage: { inputTokens: null, outputTokens: null }, finishReason: null, receipt: null, receiptState: 'not_received', requestState: 'not_started', transport: { version: 1, dispatched: false, responseComplete: false }, code: null };
    run.engineeringHistory ??= [];
    run.engineeringHistory.push(attempt);
    this.engineeringPending.add(entry);
    let timer, receipt, modelPrice, receiptWrites = Promise.resolve(), accepting = true, aborted, receiptSettled = true;
    const release = () => { void this.reconcilePlanning(project, entry, attempt, this.engineeringPending); };
    const timeout = () => { entry.timedOut = true; entry.controller.abort(); };
    const failure = (code, error) => {
      if (this.engineering.get(run.id) === entry) delete run.engineeringPlan;
      attempt.code = code;
      const detail = typeof error?.publicDetail === 'string' && error.publicDetail ? error.publicDetail : null;
      if (detail) attempt.detail = detail;
      attempt.status = code === 'cancelled' ? 'interrupted' : 'failed'; entry.status = 'failed';
      const message = code === 'invalid_input' ? '工程设计输入检查未通过：请先应用平台默认网页方案并重新确认规格；直接重试不会补全方案。'
        : detail ? `工程设计草案未通过校验：${detail}` : `工程设计请求未被接受（${code}），未使用规则回退；请核对服务及预算。`;
      return Object.assign(new Error(message), { code, ...(detail ? { publicDetail: detail } : {}) });
    };
    try {
      this.assertEngineeringCurrent(project, run, entry);
      // Persist the reservation before dispatch. Unknown/failed calls never refund it.
      run.engineeringCalls = Math.max(run.engineeringCalls ?? 0, run.engineeringHistory.length - 1) + 1;
      await this.persist(project);
      this.assertEngineeringCurrent(project, run, entry);
      const callTimeoutMs = Math.max(1, Math.min(entry.timeoutMs ?? this.engineeringTimeoutMs, this.engineeringTimeRemaining(run)));
      entry.deadline = Date.now() + callTimeoutMs;
      timer = setTimeout(timeout, callTimeoutMs);
      const interrupted = new Promise((_, reject) => {
        aborted = () => reject(Object.assign(new Error('工程规划请求已停止。'), { code: entry.timedOut ? 'model_timeout' : 'cancelled' }));
        entry.controller.signal.addEventListener('abort', aborted, { once: true });
        if (entry.controller.signal.aborted) aborted();
      });
      // Observe a timeout during the durable intent write, before the request race is active.
      void interrupted.catch(() => {});
      attempt.requestState = 'dispatch_intent'; attempt.coordinationRequired = true; attempt.transport = { version: 1, dispatched: null, responseComplete: false };
      await this.persist(project); this.assertEngineeringCurrent(project, run, entry);
      entry.requestSettled = false;
      const request = Promise.resolve().then(() => {
        this.assertEngineeringCurrent(project, run, entry);
        this.assertAutomaticDispatch?.(run);
        const model = this.planner.recordsModelPricing ? this.planner.createEngineeringModel({ onModelPrice: price => { modelPrice = price; } })
          : (this.planner.createEngineeringModel ?? createEngineeringModel)();
        entry.providerInvoked = true;
        entry.nativeRequest = model({ spec: structuredClone(run.spec), binding: { projectId: project.id, runId: run.id, specRevision: entry.specRevision }, ...(feedback ? { feedback } : {}), signal: entry.controller.signal, onReceipt: (value, proof) => {
          if (!accepting || receipt || this.closed || entry.controller.signal.aborted || this.engineering.get(run.id) !== entry) throw new Error('receipt_failed');
          if (getModelRequestEvidence(proof)?.responseComplete !== true) throw Object.assign(new Error('工程回执缺少原生完整响应证据。'), { code: 'receipt_failed' });
          entry.receiptEvidence = proof;
          receipt = structuredClone(value);
          // Transport-provided known usage is retained even if the private disk write fails.
          Object.assign(attempt, this.engineeringReceiptMetadata(receipt));
          attempt.receiptState = 'writing'; receiptSettled = false; entry.receiptSettled = false;
          receiptWrites = Promise.resolve().then(() => this.writeEngineeringReceipt(project, run, attempt, receipt, entry.controller.signal)).then(metadata => {
            receiptSettled = true; entry.receiptSettled = true; release();
            if (accepting && !entry.controller.signal.aborted && !this.closed && this.engineering.get(run.id) === entry) {
              attempt.receipt = metadata; attempt.receiptState = 'saved';
              if (modelPrice) attempt.costEstimate = estimateModelCall(receipt, modelPrice);
            }
          }, () => {
            receiptSettled = true; entry.receiptSettled = true; release();
            if (accepting && !entry.controller.signal.aborted) attempt.receiptState = 'failed';
            throw Object.assign(new Error('私有回执保存失败。'), { code: 'receipt_failed' });
          });
          // Observe even non-cooperative writers without letting their late
          // completion mutate a finalized attempt or hold cancellation open.
          void receiptWrites.catch(() => {});
          return Promise.race([receiptWrites, interrupted]);
        } });
        return Promise.resolve(entry.nativeRequest).then(result => { entry.nativeResult = result; return result; }, error => { entry.nativeError = error; throw error; });
      }).finally(() => { entry.requestSettled = true; release(); });
      const result = await Promise.race([request, interrupted]);
      this.assertEngineeringCurrent(project, run, entry);
      await Promise.race([receiptWrites, interrupted]);
      this.assertEngineeringCurrent(project, run, entry);
      if (this.planningEvidence(entry)?.responseComplete !== true) throw Object.assign(new Error('工程原生传输尚未完整核对。'), { code: 'transport_error' });
      const draft = validateEngineeringPlan({ proposal: result.proposal, spec: run.spec, binding: { projectId: project.id, runId: run.id, specRevision: entry.specRevision } });
      const receipted = receipt?.finishReason === 'stop' ? validateEngineeringPlan({ proposal: JSON.parse(receipt.content), spec: run.spec, binding: draft.binding }) : null;
      if (!attempt.receipt || result.modelPolicyHash !== engineeringModelPolicy.hash || result.hash !== draft.hash || receipted?.hash !== draft.hash || result.model !== receipt.model || contentRevision(result.usage) !== contentRevision(receipt.usage)) throw new Error('invalid_model_response');
      this.assertEngineeringCurrent(project, run, entry);
      run.engineeringPlan = structuredClone(finalizeEngineeringWorkflow(draft, run.spec));
      attempt.status = 'succeeded'; entry.status = 'succeeded';
      return run.engineeringPlan;
    } catch (error) {
      const known = new Set(['invalid_input', 'transport_error', 'http_error', 'response_error', 'response_too_large', 'receipt_failed', 'credential_response', 'abnormal_finish', 'invalid_model_response', 'model_timeout', 'cancelled', 'stale_revision', 'persistence_failed']);
      throw failure(entry.timedOut ? 'model_timeout' : entry.controller.signal.aborted || this.closed ? 'cancelled' : known.has(error.code) ? error.code : 'invalid_model_response', error);
    } finally {
      accepting = false; clearTimeout(timer); if (aborted) entry.controller.signal.removeEventListener('abort', aborted);
      this.finalizePlanningAttempt(entry, attempt);
      if (receipt && this.planningEvidence(entry)?.responseComplete !== true) attempt.receiptState = 'unconfirmed';
      if (receipt && !attempt.receipt && (!receiptSettled || attempt.receiptState === 'writing')) attempt.receiptState = 'unconfirmed';
      attempt.finishedAt = new Date().toISOString();
      try { await this.persist(project); }
      catch { attempt.persistenceStatus = 'failed'; throw failure('persistence_failed'); }
      finally { entry.finalized = true; release(); }
    }
  }

  state(run) {
    if (!this.runtime.has(run.id)) this.runtime.set(run.id, { driving: false, active: new Map(), actionBusy: false });
    return this.runtime.get(run.id);
  }

  blockDependents(run) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const stage of run.stages) {
        if (stage.status !== 'pending') continue;
        if (stage.dependsOn.some(id => ['failed', 'blocked'].includes(run.stages.find(s => s.id === id)?.status))) {
          stage.status = 'blocked';
          stage.error = '前置阶段失败，等待上游恢复。';
          addEvent(run, `${stage.title}被上游失败阻塞。`, stage.id);
          changed = true;
        }
      }
    }
  }

  async init() {
    for (const project of this.store.projects.values()) {
      let changed = false;
      for (const run of project.runs) {
        if (run.engineeringBudget) { const tightened = this.engineeringBudget(run); if (contentRevision(tightened) !== contentRevision(run.engineeringBudget)) { run.engineeringBudget = tightened; changed = true; } }
        if (run.specificationBudget) {
          const budget = run.specificationBudget, tightened = this.specificationBudget(run);
          if (contentRevision(tightened) !== contentRevision(budget)) { run.specificationBudget = tightened; changed = true; }
        }
        for (const attempt of [...(run.specificationHistory ?? []), ...(run.engineeringHistory ?? []), ...(run.planningIssueHistory ?? [])]) {
          const interrupted = ['running', 'validated'].includes(attempt.status);
          const legacyUnknown = !attempt.transport && attempt.receiptState !== 'saved' && ['transport_error', 'response_error', 'response_too_large', 'model_timeout', 'cancelled', 'service_restart'].includes(attempt.code);
          if (interrupted || legacyUnknown || attempt.requestState === 'unconfirmed' || attempt.requestState === 'dispatch_intent' || attempt.coordinationRequired && !attempt.coordination?.resolved) {
            const notSent = attempt.transport?.version === 1 && attempt.transport.dispatched === false && attempt.requestState === 'not_started';
            const stopped = attempt.transport?.version === 1 && attempt.transport.responseComplete === true && attempt.receiptState !== 'writing' && attempt.receiptState !== 'unconfirmed';
            if (interrupted) { attempt.status = 'interrupted'; attempt.code = 'service_restart'; attempt.finishedAt = new Date().toISOString(); }
            if (!attempt.coordination?.resolved) { attempt.coordinationRequired = !notSent && !stopped; attempt.requestState = notSent ? 'not_started' : stopped ? 'settled' : 'unconfirmed'; }
            if (attempt.receiptState === 'writing') attempt.receiptState = 'unconfirmed'; changed = true;
          }
        }
        if (this.sourceSuperseded(project, run)) continue;
        if (!['running', 'paused'].includes(run.status)) continue;
        changed = true;
        for (const attempt of run.engineeringHistory ?? []) if (attempt.status === 'running') {
          attempt.status = 'interrupted'; attempt.code = 'service_restart'; attempt.finishedAt = new Date().toISOString();
        }
        if (run.stages.every(stage => stage.status === 'succeeded')) {
          run.status = 'succeeded';
          addEvent(run, '服务重启后确认所有阶段均已完成。', null, 'success');
          continue;
        }
        const interrupted = run.stages.filter(stage => stage.status === 'running');
        if (!interrupted.length && !run.stages.some(stage => stage.status === 'failed')) {
          const pending = run.stages.find(stage => stage.status === 'pending');
          if (pending) interrupted.push(pending);
        }
        for (const stage of interrupted) {
          stage.status = 'failed';
          stage.error = '上次运行因服务重启中断，请重试该阶段。';
          stage.finishedAt = new Date().toISOString();
          stage.history ??= [];
          stage.history.push({ attempt: stage.attempt, status: 'failed', code: 'service_restart', startedAt: stage.startedAt, finishedAt: stage.finishedAt, error: stage.error });
        }
        this.blockDependents(run);
        run.status = 'failed';
        addEvent(run, '上次运行已中断，成功产物已保留，可重试失败阶段。', null, 'error');
      }
      if (changed) await this.persist(project);
    }
  }

  inheritedClarifications(project, requestedRunId) {
    const versions = project.sourceVersions;
    if (!Array.isArray(versions) || versions.length < 2) return null;
    const previousRevision = versions.at(-2)?.revision;
    if (!previousRevision) return null;
    let previous;
    if (requestedRunId !== undefined) {
      if (typeof requestedRunId !== 'string' || !requestedRunId) throw new HttpError(400, '继承运行编号无效。');
      previous = project.runs.find(run => run.id === requestedRunId);
      if (!previous) throw new HttpError(404, '未找到要继承的历史运行。');
      if (previous.sourceRevision !== previousRevision) throw new HttpError(409, '只能继承上一输入版本的运行。');
    } else {
      previous = [...project.runs].reverse().find(run => run.sourceRevision === previousRevision
        && (run.clarificationHistory?.length || run.specQuestions?.some(question => String(question.answer ?? '').trim())));
    }
    if (!previous) return null;
    const normalize = question => question.trim().replace(/\s+/gu, ' ').toLowerCase();
    const seen = new Set(), rounds = [];
    const add = (bag, question, answer, extras) => {
      if (typeof question !== 'string' || typeof answer !== 'string' || !answer.trim()) return;
      const key = normalize(question);
      if (!key || seen.has(key)) return;
      seen.add(key); bag.push({ ...extras, question, answer: answer.trim(), blocking: false, inherited: true });
    };
    const initial = [];
    for (const question of previous.specQuestions ?? []) add(initial, question.question, question.answer, { id: question.id });
    if (initial.length) rounds.push({ kind: 'inherited', fromRunId: previous.id, originalKind: 'spec_questions', revision: previous.specRevision ?? previous.sourceRevision,
      at: previous.updatedAt ?? previous.createdAt ?? new Date().toISOString(), answers: initial });
    for (const round of previous.clarificationHistory ?? []) {
      const answers = [];
      for (const question of round.answers ?? []) add(answers, question.question, question.answer, { id: question.id, ...(question.field ? { field: question.field } : {}) });
      if (answers.length) rounds.push({ kind: 'inherited', fromRunId: previous.id, originalKind: round.kind ?? 'clarification',
        revision: round.revision ?? previous.sourceRevision, at: round.at ?? previous.updatedAt ?? new Date().toISOString(), answers });
    }
    while (rounds.length > 1 && planningSourceText({ sourceSnapshot: project.source, clarificationHistory: rounds }, project.source).length > 100000) rounds.shift();
    while (rounds.length === 1 && rounds[0].answers.length && planningSourceText({ sourceSnapshot: project.source, clarificationHistory: rounds }, project.source).length > 100000) rounds[0].answers.pop();
    if (!rounds.length || !rounds[0].answers.length) return null;
    const answers = rounds.flatMap(round => round.answers);
    return { history: rounds, metadata: { runId: previous.id, sourceRevision: previous.sourceRevision, specRevision: previous.specRevision ?? null,
      at: new Date().toISOString(), answerCount: answers.length } };
  }

  async createRun(projectId, options = {}, { automaticDelivery, budget, saveAuthorization } = {}) {
    const { mode = 'local', failOnceStage, inheritFromRunId, expectedSourceRevision, expectedSourceGeneration } = options;
    if (this.closed) throw new HttpError(409, '服务正在停止，请稍后重试。');
    const project = this.store.get(projectId);
    if (this.projectActions.has(projectId)) throw new HttpError(409, '该项目正在保存操作，请稍后重试。');
    this.assertProjectAvailable(project);
    if (this.hasSpecificationWork(projectId)) throw new HttpError(409, '该项目仍有规格请求或私有回执待核对。');
    if (this.projectAdmissions.has(projectId)) throw new HttpError(409, '项目正在创建运行，请稍后重试。');
    this.projectAdmissions.add(projectId);
    try {
    const expectsRevision = Object.hasOwn(options, 'expectedSourceRevision'), expectsGeneration = Object.hasOwn(options, 'expectedSourceGeneration');
    if (expectsRevision || expectsGeneration) {
      if (!expectsRevision || !expectsGeneration || typeof expectedSourceRevision !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSourceRevision)
        || !Number.isSafeInteger(expectedSourceGeneration) || expectedSourceGeneration < 0) throw new HttpError(400, '请同时提供有效的需求内容版本和输入代次。');
      // Admission blocks source publication until this run is persisted. Keep
      // this comparison and the source snapshot in the same synchronous turn.
      const current = this.store.getSourceVersion(projectId);
      if (current.revision !== expectedSourceRevision || current.generation !== expectedSourceGeneration) throw new HttpError(409, '需求版本已变化，请刷新核对后再重新规划。');
    }
    if (project.runs.some(run => !this.sourceSuperseded(project, run) && ACTIVE_STATUSES.has(run.status))) throw new HttpError(409, '该项目已有活动运行，请先完成或恢复它。');
    if (!['local', 'model'].includes(mode)) throw new HttpError(400, '请选择本地规则或模型模式。');
    if (mode === 'model' && !this.planner.getModelConfig().configured) throw new HttpError(400, '尚未配置规格模型。请在「API 服务」添加模型，再到「Agent 角色」为需求分析选择服务，或使用本地规则模式。');
    if (failOnceStage && !['architecture', 'tasks', 'review'].includes(failOnceStage)) throw new HttpError(400, '不支持该演示故障阶段。');
    const now = new Date().toISOString(), inherited = this.inheritedClarifications(project, inheritFromRunId);
    const run = {
      id: randomUUID(), projectId, mode, workflowVersion: 2, status: 'running', createdAt: now, updatedAt: now,
      sourceSnapshot: structuredClone(project.source), sourceRevision: contentRevision(project.source),
      sourceGeneration: project.sourceGeneration ?? 0,
      specRevision: null, planRevision: null, specVersion: 0, planVersion: 0, specQuestions: [],
      approvals: { spec: null, plan: null }, revisionHistory: { spec: [], plan: [] }, decisions: [],
      stages: WORKFLOW.map(stage => ({ ...stage, dependsOn: [...stage.dependsOn], status: 'pending', attempt: 0, startedAt: null, finishedAt: null, error: null, history: [] })),
      spec: null, tasks: [], artifacts: [], events: [], review: null, feedback: '', approvedAt: null,
      clarificationHistory: inherited?.history ?? [],
      ...(automaticDelivery ? { automaticDelivery,
        specificationBudget: { ...this.specificationBudget({}), maxCalls: effectiveCallLimit(this.specificationMaxCalls, budget.specificationMaxCalls) },
        engineeringBudget: { ...this.engineeringBudget({}), maxCalls: effectiveCallLimit(this.engineeringMaxCalls, budget.engineeringMaxCalls) },
      } : {}),
      ...(inherited?.metadata ? { inheritedFrom: inherited.metadata } : {}),
      simulation: failOnceStage ? { failOnceStage } : null,
    };
    addEvent(run, `已冻结需求快照，开始${mode === 'model' ? '模型' : '本地规则'}规划。`);
    if (inherited) addEvent(run, `已继承上一版运行 ${inherited.metadata.runId.slice(-8)} 的 ${inherited.metadata.answerCount} 条回答；新版正文优先，仍需重新确认规格。`);
    if (failOnceStage) addEvent(run, '已启用演示故障：指定阶段首次尝试将失败，重试后正常执行。');
    if (saveAuthorization) await saveAuthorization(run);
    project.runs.push(run);
    await this.persist(project);
    this.schedule(project, run);
    return run;
    } finally { this.projectAdmissions.delete(projectId); }
  }

  schedule(project, run) {
    if (!this.closed && !this.projectCheckpoints.has(project.id) && !this.sourceSuperseded(project, run)) queueMicrotask(() => this.drive(project, run).catch(error => {
      if (this.projectCheckpoints.has(project.id) || this.sourceSuperseded(project, run)) return;
      run.status = 'failed';
      addEvent(run, `调度器无法继续：${error.message}`, null, 'error');
      this.persist(project).catch(() => {});
    }));
  }

  async drive(project, run) {
    const state = this.state(run);
    if (state.driving || state.actionBusy || this.closed || this.projectAdmissions.has(project.id) || this.projectCheckpoints.has(project.id) || this.sourceSuperseded(project, run)) return;
    state.driving = true;
    let resolveIdle;
    state.driveIdle = new Promise(resolve => { resolveIdle = resolve; });
    try {
      this.blockDependents(run);
      if (run.status === 'paused') {
        if (state.active.size === 0 && run.stages.some(stage => stage.status === 'failed')) {
          run.status = 'failed';
          addEvent(run, '暂停前启动的阶段执行失败，请查看错误并重试。', null, 'error');
          await this.persist(project);
        }
        return;
      }
      if (run.status !== 'running') return;
      if (run.stages.every(stage => stage.status === 'succeeded')) {
        run.status = 'succeeded';
        addEvent(run, '文档已确认并导出，软件开发计划准备完成。', null, 'success');
        await this.persist(project);
        return;
      }
      if (run.workflowVersion === 2 && run.stages.find(stage => stage.id === 'spec')?.status === 'succeeded' && run.approvals?.spec?.revision !== run.specRevision) {
        run.status = 'awaiting_spec';
        addEvent(run, run.spec?.clarificationRequired || run.specQuestions?.some(item => item.blocking && !item.answer.trim())
          ? '需求仍待补充。请查看问题，提交答复后继续整理规格。' : '规格草案已生成，请核对并确认后再拆解任务。');
        await this.persist(project);
        return;
      }
      const ready = run.stages.filter(stage => stage.status === 'pending' && stage.dependsOn.every(id => run.stages.find(s => s.id === id)?.status === 'succeeded'));
      for (const stage of ready) {
        if (this.projectCheckpoints.has(project.id) || this.sourceSuperseded(project, run)) return;
        if (state.active.size >= this.concurrency) break;
        if (stage.id === 'export' && (run.workflowVersion === 2 ? run.approvals?.plan?.revision !== run.planRevision || !run.planRevision : !run.approvedAt)) {
          run.status = 'awaiting_review';
          addEvent(run, '计划检查完成，请核对当前计划版本，确认后导出规划文档包。');
          await this.persist(project);
          return;
        }
        const promise = this.executeStage(project, run, stage).catch(() => {
          run.status = 'failed';
          addEvent(run, '运行记录保存失败，已停止后续派发；请保留现场并检查本地存储。', stage.id, 'error');
        }).finally(() => {
          state.active.delete(stage.id);
          this.schedule(project, run);
        });
        state.active.set(stage.id, promise);
      }
      if (state.active.size === 0) {
        if (run.stages.some(stage => ['failed', 'blocked'].includes(stage.status))) {
          run.status = 'failed';
          addEvent(run, '运行失败，已完成的分支与产物保留。查看失败阶段后可重试。', null, 'error');
        } else {
          run.status = 'failed';
          const pending = run.stages.find(stage => stage.status === 'pending');
          if (pending) { pending.status = 'failed'; pending.error = '计划无法继续，依赖关系或调度状态无效。'; }
          addEvent(run, '没有可执行阶段，请检查计划依赖。', null, 'error');
        }
        await this.persist(project);
      }
    } finally { state.driving = false; resolveIdle(); state.driveIdle = null; }
  }

  async executeStage(project, run, stage) {
    this.assertProjectAvailable(project, run);
    const specRevision = run.specRevision, sourceRevision = run.sourceRevision ?? contentRevision(run.sourceSnapshot ?? project.source);
    let specificationPublication;
    stage.status = 'running';
    stage.attempt++;
    stage.startedAt = new Date().toISOString();
    stage.finishedAt = null;
    stage.error = null;
    addEvent(run, `${stage.title}开始，第 ${stage.attempt} 次尝试。`, stage.id);
    try {
      await this.persist(project);
      if (this.stepDelayMs) await delay(this.stepDelayMs);
      if (run.simulation?.failOnceStage === stage.id && stage.attempt === 1) throw new Error('演示故障：本次尝试主动失败。可重试该阶段以观察分支保留与恢复。');
      const result = await this.performStage(project, run, stage);
      if (this.projectCheckpoints.has(project.id) || this.sourceSuperseded(project, run)) throw new HttpError(409, '输入版本已失效，未发布阶段结果。');
      if (stage.id === 'spec' && run.mode === 'model') {
        if (this.closed || this.store.get(project.id) !== project || !project.runs.includes(run) || contentRevision(run.sourceSnapshot ?? project.source) !== sourceRevision || (run.sourceRevision ?? sourceRevision) !== sourceRevision || run.specRevision !== specRevision) throw Object.assign(new Error('规格所属版本已失效，未发布结果。'), { code: 'stale_revision' });
        specificationPublication = { fields: Object.fromEntries(Object.keys(result).filter(key => key !== 'artifacts').map(key => [key, { present: Object.hasOwn(run, key), value: run[key] }])), artifacts: [...run.artifacts], historyLength: stage.history.length };
        const attempt = run.specificationHistory.at(-1); attempt.status = 'succeeded';
      }
      if (this.usesEngineering(run) && ['architecture', 'tasks', 'review', 'export'].includes(stage.id)) {
        if (this.closed) throw new Error('服务已停止，未发布工程规划阶段结果。');
        assertCurrentRevision(run.specRevision, specRevision);
        assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), sourceRevision);
        assertCurrentRevision(run.sourceRevision, sourceRevision);
        assertSpecApproval(run);
      }
      const now = new Date().toISOString();
      for (const [key, value] of Object.entries(result)) if (key !== 'artifacts') run[key] = value;
      for (const artifact of result.artifacts ?? []) {
        run.artifacts = run.artifacts.filter(existing => existing.name !== artifact.name);
        run.artifacts.push({ ...artifact, title: titles[artifact.name] ?? artifact.name, stageId: stage.id, createdAt: now });
      }
      stage.status = 'succeeded';
      stage.finishedAt = now;
      if (run.workflowVersion === 2 && stage.id === 'review' && !run.planRevision) {
        if (run.planVersion >= MAX_PLANNING_VERSIONS) throw new Error('计划版本已达到上限，请新建运行。');
        if (isModuleWorkflow(run.engineeringPlan, run.tasks)) run.dependencyExecution = true;
        run.planRevision = planningRevision(run);
        run.planVersion++;
      }
      stage.history.push({ attempt: stage.attempt, status: 'succeeded', startedAt: stage.startedAt, finishedAt: now, error: null });
      if (stage.id === 'spec' && run.workflowVersion === 2 && (run.spec?.clarificationRequired || run.specQuestions?.some(item => item.blocking && !item.answer.trim()))) {
        addEvent(run, '已保存规格草案，等待补充需求。', stage.id);
      } else addEvent(run, `${stage.title}完成${result.artifacts?.length ? `，生成 ${result.artifacts.map(a => a.name).join('、')}` : ''}。`, stage.id, 'success');
      await this.persist(project);
    } catch (error) {
      if (stage.id === 'spec' && run.mode === 'model') {
        if (specificationPublication) {
          for (const [key, prior] of Object.entries(specificationPublication.fields)) { if (prior.present) run[key] = prior.value; else delete run[key]; }
          run.artifacts = specificationPublication.artifacts; stage.history.length = specificationPublication.historyLength;
        }
        const attempt = run.specificationHistory?.at(-1);
        if (attempt && ['validated', 'succeeded'].includes(attempt.status)) {
          attempt.status = 'failed';
          if (error.code === 'persistence_failed') attempt.code = 'persistence_failed';
          else if (error.isSpecValidation) {
            const detail = specificationFailure('invalid_model_response', error.reason ?? 'malformed_spec_fields', error.requirementIndex, { requirementTitle: error.requirementTitle, field: error.field, detail: error.publicDetail ?? error.message });
            Object.assign(attempt, { code: 'invalid_model_response', reason: detail.reason, message: detail.message, ...(detail.requirementIndex ? { requirementIndex: detail.requirementIndex } : {}), ...(detail.requirementTitle ? { requirementTitle: detail.requirementTitle } : {}), ...(detail.detail ? { detail: detail.detail } : {}) });
          } else attempt.code = 'stale_revision';
        }
      }
      stage.status = 'failed';
      stage.finishedAt = new Date().toISOString();
      stage.error = error.message || '阶段执行失败。';
      stage.history.push({ attempt: stage.attempt, status: 'failed', startedAt: stage.startedAt, finishedAt: stage.finishedAt, error: stage.error });
      addEvent(run, `${stage.title}失败：${stage.error}`, stage.id, 'error');
      this.blockDependents(run);
      await this.persist(project);
    }
  }

  inheritedAnswers(run) {
    const normalize = question => question.trim().replace(/\s+/gu, ' ').toLowerCase(), answers = new Map();
    for (const round of run.clarificationHistory ?? []) if (round.kind === 'inherited') for (const item of round.answers ?? []) {
      if (typeof item.question === 'string' && typeof item.answer === 'string' && item.answer.trim()) answers.set(normalize(item.question), item.answer.trim());
    }
    return answers;
  }

  prepareSpec(project, run, raw, previous = [], answers = {}, { modelDraft = false } = {}) {
    const spec = applyPlatformDefaults(raw); delete spec.sourceClarifications;
    if (run.clarificationHistory?.length) spec.sourceClarifications = structuredClone(run.clarificationHistory);
    const sources = clarificationSources(run);
    const currentSources = latestClarificationSources(run);
    delete spec.clarificationSources;
    if (sources.length) spec.clarificationSources = { version: 'confirmed-qa-v1', records: sources };
    if (modelDraft && Array.isArray(spec.questions)) {
      spec.questions = submittedClarifications(run)
        ? [...clarificationFollowUps(run).values()].map(item => item.question).filter(question => !technicalQuestion(question))
        : distinctClarificationQuestions(spec.questions);
    }
    const prior = previous.map(q => technicalQuestion(q.question) ? { ...q, answer: q.answer || '技术方案由平台固定，无需用户选型。' } : q);
    const result = preparePlanningSpec(spec, planningSourceText(run, project.source), prior, Object.fromEntries(Object.entries(answers).filter(([id]) => !previous.some(q => q.id === id && technicalQuestion(q.question)))), planningQuoteSources(run, project.source));
    for (const requirement of result.spec.requirements) {
      delete requirement.sourceRef; delete requirement.sourceRefs;
      if (sources.length) requirement.sourceRefs = currentSources.filter(record => record.decision === 'confirmed' && record.quotes.some(quote => quote.includes(requirement.sourceQuote))).map(record => record.id);
    }
    const inherited = this.inheritedAnswers(run);
    if (inherited.size) {
      for (const question of result.specQuestions) {
        if (String(question.answer ?? '').trim()) continue;
        const answer = inherited.get(question.question.trim().replace(/\s+/gu, ' ').toLowerCase());
        if (answer) { question.answer = answer; question.inherited = true; }
      }
      const next = new Map(result.specQuestions.map(question => [question.id, question]));
      for (const item of result.spec.clarifications ?? []) {
        const question = next.get(item.id);
        if (!question?.answer) continue;
        item.answer = question.answer;
        if (question.inherited) item.inherited = true;
      }
    }
    result.specRevision = contentRevision(result.spec);
    return result;
  }

  async performStage(project, run, stage) {
    const p = this.planner;
    const source = run.sourceSnapshot ?? project.source;
    if (run.workflowVersion === 2) assertCurrentRevision(contentRevision(source), run.sourceRevision);
    switch (stage.id) {
      case 'intake':
        if (!source.content.trim()) throw new Error('需求正文为空。');
        addEvent(run, `读取 ${source.filename}，共 ${source.content.length} 字符；原始文本只作为需求数据处理。`, stage.id);
        return {};
      case 'spec': {
        const workflowVersion = run.workflowVersion === 2 ? 2 : 1;
        const spec = run.mode === 'model' ? await this.requestSpecification(project, run, stage) : p.analyzeRequirements(source.content, project.name, { workflowVersion });
        if (run.workflowVersion !== 2) return { spec, artifacts: [{ name: 'spec.md', content: p.renderSpec(spec) }] };
        let result;
        try { result = this.prepareSpec(project, run, spec, [], {}, { modelDraft: run.mode === 'model' }); }
        catch (error) {
          // Validation of a model response is a specification failure, not a stale run.
          if (error instanceof HttpError && error.status === 400 && !error.isSpecValidation) { error.isSpecValidation = true; error.reason ??= 'malformed_spec_fields'; error.publicDetail ??= error.message; }
          throw error;
        }
        return { ...result, specVersion: (run.specVersion ?? 0) + 1, artifacts: [{ name: 'spec.md', content: this.renderSpec(result.spec) }] };
      }
      case 'architecture':
        if (run.workflowVersion === 2) assertSpecApproval(run);
        if (this.usesEngineering(run)) {
          const plan = await this.engineeringDraft(project, run);
          return { artifacts: [{ name: 'architecture.md', content: renderEngineeringArchitecture(plan) }] };
        }
        return { artifacts: [{ name: 'architecture.md', content: `${p.renderArchitecture(run.spec)}${run.engineeringFallback ? `\n\n> 工程草案来源：模型工程请求失败后由用户显式选择本地规则生成；仍须计划确认。\n` : ''}` }] };
      case 'tasks': {
        if (run.workflowVersion === 2) assertSpecApproval(run);
        if (this.usesEngineering(run)) {
          const plan = await this.engineeringDraft(project, run), tasks = engineeringTasks(plan);
          validatePlanningTasks(run.spec, tasks); p.validateTaskGraph(tasks);
          return { tasks, artifacts: [{ name: 'task.md', content: renderEngineeringTasks(p, run.spec, tasks) }] };
        }
        const generated = p.generateTasks(run.spec, { workflowVersion: run.workflowVersion === 2 ? 2 : 1 });
        const tasks = run.workflowVersion === 2 ? validatePlanningTasks(run.spec, generated) : generated;
        p.validateTaskGraph(tasks);
        return { tasks, artifacts: [{ name: 'task.md', content: `${p.renderTasks(run.spec, tasks)}${run.engineeringFallback ? `\n\n> 工程任务来源：模型工程请求失败后由用户显式选择本地规则生成；仍须计划确认。\n` : ''}` }] };
      }
      case 'review': {
        if (run.workflowVersion === 2) { assertSpecApproval(run); validatePlanningTasks(run.spec, run.tasks); }
        if (run.engineeringPlan) assertEngineeringAlignment(run);
        const review = p.reviewPlan(run.spec, run.tasks);
        if (!review.passed) throw new Error(`计划检查未通过：${review.issues.join('；')}`);
        return { review, artifacts: [{ name: 'review.md', content: p.renderReview(review) }] };
      }
      case 'export':
        if (run.workflowVersion === 2) {
          assertSpecApproval(run);
          if (run.engineeringPlan) assertEngineeringAlignment(run);
          assertCurrentRevision(planningRevision(run), run.planRevision);
          if (run.approvals?.plan?.revision !== run.planRevision || run.approvals.plan.specRevision !== run.specRevision) throw new HttpError(409, '当前计划尚未确认。');
        }
        return { artifacts: [
          { name: 'handoff.md', content: p.renderHandoff(run.spec, run.tasks, run.review, run.feedback) },
          { name: 'plan.json', content: JSON.stringify({ project: project.name, runId: run.id, sourceFilename: source.filename, sourceRevision: run.sourceRevision, ...(run.sourceGeneration !== undefined ? { sourceGeneration: run.sourceGeneration } : {}), workflowVersion: run.workflowVersion, specRevision: run.specRevision, planRevision: run.planRevision, approvals: run.approvals, mode: run.mode, ...(run.clarificationHistory?.length ? { clarificationHistory: run.clarificationHistory } : {}), spec: run.spec, tasks: run.tasks, review: run.review, feedback: run.feedback, ...(run.dependencyExecution === true ? { dependencyExecution: true } : {}), ...(run.engineeringPlan ? { engineeringPlan: run.engineeringPlan } : {}), ...(run.engineeringFallback ? { engineeringFallback: run.engineeringFallback } : {}), ...(run.inheritedFrom ? { inheritedFrom: run.inheritedFrom } : {}) }, null, 2) },
        ] };
      default: throw new Error('未知工作流阶段。');
    }
  }

  renderSpec(spec) {
    const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const answers = (spec.clarifications ?? []).map(item => `- ${item.id} ${escape(item.question)}\n  答复：${escape(item.answer || '尚未答复')}`);
    const sourceAnswers = (spec.sourceClarifications ?? []).flatMap(round => round.answers.map(q => `- ${round.kind === 'inherited' ? '[继承上一版] ' : ''}${escape(q.question)}\n  答复：${escape(q.answer)}`));
    const sourceNotes = (spec.clarificationSources?.records || []).map(record => `- ${record.id}：${escape(record.decision === 'confirmed' ? '已确认' : record.decision === 'rejected' ? '未采纳' : record.decision === 'unresolved' ? '需要进一步确认' : '已回答')}；问题：${escape(record.question)}；答复：${escape(record.answer)}`);
    const sourceSection = sourceNotes.length ? `\n\n## 问答来源关联\n\n${sourceNotes.join('\n')}` : '';
    const platform = spec.platformDefaults ? `\n\n## 平台默认交付方案\n\n${escape(spec.platformDefaults.description)}` : '';
    return `${sourceAnswers.length ? `## 用户补充的需求信息\n\n${sourceAnswers.join('\n')}\n\n` : ''}${this.planner.renderSpec(spec)}${platform}${sourceSection}${answers.length ? `\n\n## 结构化问题答复\n\n${answers.join('\n')}` : ''}`;
  }

  snapshot(run, kind) {
    return structuredClone({
      version: kind === 'spec' ? run.specVersion : run.planVersion,
      revision: kind === 'spec' ? run.specRevision : run.planRevision,
      specRevision: run.specRevision, at: new Date().toISOString(), spec: run.spec,
      specQuestions: run.specQuestions, tasks: run.tasks, artifacts: run.artifacts,
      stages: run.stages, review: run.review, approvals: run.approvals,
      ...(run.dependencyExecution === true ? { dependencyExecution: true } : {}),
      ...(run.engineeringPlan ? { engineeringPlan: run.engineeringPlan, engineeringHistory: run.engineeringHistory } : {}),
      ...(run.engineeringFallback ? { engineeringFallback: run.engineeringFallback } : {}),
    });
  }

  resetStages(run, ids) {
    for (const stage of run.stages) if (ids.has(stage.id)) {
      stage.status = 'pending'; stage.error = null; stage.startedAt = null; stage.finishedAt = null;
    }
    run.artifacts = run.artifacts.filter(item => !ids.has(item.stageId));
  }

  specificationRemaining(run) {
    const { maxCalls } = this.specificationBudget(run);
    return maxCalls === null ? null : Math.max(0, maxCalls - Math.max(run.specificationCalls ?? 0, run.specificationHistory?.length ?? 0));
  }

  async savedSpecification(project, run) {
    const attempt = run.specificationHistory?.at(-1);
    const eligible = attempt?.status === 'failed' && attempt.code === 'invalid_model_response'
      || attempt?.status === 'interrupted' && attempt.code === 'service_restart';
    if (!eligible || attempt.receiptState !== 'saved' || attempt.requestState !== 'settled'
      || attempt.sourceRevision !== run.sourceRevision || attempt.inputRevision !== contentRevision(planningSourceText(run, project.source))) throw new HttpError(409, '没有与当前输入匹配的可重新校验响应。');
    const proof = contentRevision(attempt), source = planningSourceText(run, project.source), quotes = planningQuoteSources(run, project.source);
    const receipt = await readSpecificationReceipt(this.store.directory, project.id, run.id, structuredClone(attempt));
    const spec = await specificationFromReceipt(receipt, source, project.name, { timeoutMs: 5000, usePlatformDefaults: run.workflowVersion === 2, confirmedSources: confirmedSourceText(run), quoteSources: quotes });
    if (proof !== contentRevision(attempt) || source !== planningSourceText(run, project.source)) throw new HttpError(409, '保存响应或输入版本已变化，请刷新后重新核对。');
    return { attempt, proof, result: this.prepareSpec(project, run, spec, [], {}, { modelDraft: true }) };
  }

  specificationRepairAnswers(run) {
    const draft = run.specificationRepair;
    if (draft?.sourceRevision === run.sourceRevision && draft.answers && typeof draft.answers === 'object' && !Array.isArray(draft.answers)) return { ...draft.answers };
    const round = [...(run.clarificationHistory ?? [])].reverse().find(item => item?.kind === 'spec_repair');
    if (!round) return {};
    return Object.fromEntries((round.answers ?? []).filter(item => typeof item?.field === 'string' && typeof item.answer === 'string').map(item => [item.field, item.answer]));
  }

  describeEngineeringFailure(run) {
    if (!['architecture', 'tasks'].some(id => run.stages.find(stage => stage.id === id)?.status === 'failed')) return null;
    const attempt = [...(run.engineeringHistory ?? [])].reverse().find(item => item.status === 'failed');
    const timeRemainingMs = this.engineeringTimeRemaining(run);
    const remaining = this.engineeringRemaining(run), pending = this.hasSpecificationWork(run.projectId);
    const canRetry = remaining !== 0 && (remaining === null || timeRemainingMs > 0) && !pending;
    const canRevalidate = !pending && Boolean(attempt?.receiptState === 'saved' && attempt?.receipt && attempt.status !== 'running');
    return {
      code: pending ? 'planning_pending' : remaining === 0 ? 'budget_exhausted' : attempt?.code ?? 'invalid_model_response', attemptId: attempt?.id ?? null, remaining, timeRemainingMs, pending, canRetry, canRevalidate, canUseLocal: !pending && !run.engineeringPlan,
      message: '架构与任务共用一次工程设计请求；该草案未通过平台结构校验，因此两个阶段都没有生成结果。',
      ...(attempt?.detail ? { detail: attempt.detail } : {}),
      nextStep: pending ? '前次规划请求或私有回执仍待核对；没有远端完整响应及本地写入证据前，不能再次请求模型或切换需求。'
        : canRevalidate ? '可先尝试免费重新校验已保存的工程草案，不调用模型；若仍不符合规则，再决定是否重试。'
        : canRetry ? remaining === null ? '工程设计调用次数不限。手动重试会开始新一轮工程设计并请求模型。' : `工程设计还可尝试 ${remaining} 次，总时长预算还剩约 ${Math.ceil(timeRemainingMs / 1000)} 秒；重试会继续请求模型。`
          : remaining === 0 ? '工程调用次数已用尽；可免费重新校验保存草案或改用本地规则生成。'
          : '工程模型总时长预算已用尽；可重新校验保存草案或改用本地规则生成。',
    };
  }

  syncMeetingArtifacts(run) {
    const artifacts = meetingArtifacts(run), names = new Set(artifacts.map(item => item.name));
    run.artifacts = run.artifacts.filter(item => !names.has(item.name));
    run.artifacts.push(...artifacts.map(artifact => ({ ...artifact, stageId: 'spec', createdAt: new Date().toISOString() })));
  }

  answerSpecificationMeeting(project, run, issue, input) {
    const decisions = prepareMeetingAnswers(run, issue, input);
    if (!input.continue) { run.planningIssueDraft = { id: issue.id, answers: Object.fromEntries(decisions.map(d => [d.issueId, d.answer])), at: new Date().toISOString() }; return; }
    this.applyMeetingDecisions(project, run, decisions, true);
  }

  applyMeetingDecisions(project, run, decisions, fromUser) {
    if (run.specVersion >= MAX_PLANNING_VERSIONS) throw new HttpError(409, '规格版本已达上限，请新建运行。');
    const round = currentMeeting(run), spec = structuredClone(run.spec), at = new Date().toISOString();
    run.revisionHistory.spec.push(this.snapshot(run, 'spec'));
    if (fromUser) {
      run.clarificationHistory ??= [];
      run.clarificationHistory.push({ kind: 'specification_meeting_decision', revision: run.sourceRevision, at,
        answers: decisions.map(d => ({ id: d.issueId, question: d.question, answer: d.answer, blocking: true })) });
    }
    spec.meetingDecisions = [...(spec.meetingDecisions ?? []), ...decisions];
    for (const requirement of spec.requirements) for (const decision of decisions) if (decision.requirementIds.includes(requirement.id)) {
      requirement.description += `\n${fromUser ? '用户明确裁决' : '依据原文或已确认答复修订'}：${decision.answer}`;
      requirement.acceptance = [...new Set([...requirement.acceptance, decision.answer])];
    }
    const result = this.prepareSpec(project, run, spec, run.specQuestions, {});
    if (result.specRevision === run.specRevision) throw new HttpError(409, '裁决未形成实际修订。');
    for (const issue of round.issues) {
      const decision = decisions.find(d => d.issueId === issue.id);
      if (decision) { issue.status = 'resolved_pending_recheck'; issue.resolution = decision; }
    }
    round.status = 'superseded'; Object.assign(run, result); run.specVersion++;
    run.approvals = { spec: null, plan: null }; run.planRevision = null; run.tasks = []; run.review = null;
    delete run.dependencyExecution; delete run.engineeringPlan; delete run.engineeringFallback; delete run.planningIssueDraft;
    this.resetStages(run, descendants(run, ['architecture', 'tasks']));
    run.artifacts = run.artifacts.filter(item => item.name !== 'spec.md');
    run.artifacts.push({ name: 'spec.md', title: '设计规格', content: this.renderSpec(run.spec), stageId: 'spec', createdAt: at });
    startSpecificationMeeting(run, { revision: run.specRevision, scenario: round.scenario });
    this.syncMeetingArtifacts(run); addEvent(run, `已依据${fromUser ? '用户裁决' : '原文或已确认答复'}形成新规格版本；全部专业席、自测和独立Review须重新检查，工程继续等待。`, 'spec');
  }

  planningIssue(project, run) {
    if (!this.sourceSuperseded(project, run)) {
      const meetingIssue = specificationMeetingIssue(run); if (meetingIssue) return meetingIssue;
    }
    if (run.workflowVersion !== 2 || run.mode !== 'model' || this.sourceSuperseded(project, run)
      || contentRevision(run.sourceSnapshot ?? project.source) !== run.sourceRevision) return null;
    const input = this.planningInputIssues.get(run.id) ?? run.planningInputIssue;
    const inputIssue = input && input.status === run.status && input.specRevision === run.specRevision && input.planRevision === run.planRevision ? input : null;
    const unanswered = (run.specQuestions ?? []).filter(item => !item.answer?.trim());
    const clarification = run.status === 'awaiting_spec' && unanswered.length > 0;
    const submitted = submittedClarifications(run);
    const followUps = submitted ? clarificationFollowUps(run) : new Map();
    const stage = inputIssue || clarification ? run.stages.find(item => item.id === (inputIssue?.stageId ?? 'spec')) : run.status === 'failed' ? run.stages.find(item => item.status === 'failed') : null;
    if (!stage || !['spec', 'architecture', 'tasks', 'review'].includes(stage.id)) return null;
    const engineering = ['architecture', 'tasks'].includes(stage.id);
    const attempt = run.status === 'failed' ? (engineering ? run.engineeringHistory : run.specificationHistory)?.at(-1) : null;
    const failure = run.status === 'failed' && stage.id === 'spec' ? specificationFailure(attempt?.code, attempt?.reason, attempt?.requirementIndex,
      { requirementTitle: attempt?.requirementTitle, detail: attempt?.detail }) : null;
    const options = clarification ? unanswered.slice(0, 20).map(item => item.question.slice(0, 4000).toWellFormed()) : (failure?.repairFields ?? []).map(item => item.question);
    const unsupportedDraft = failure?.reason === 'requirement_quote_not_found';
    const allowQuestions = Boolean(inputIssue) || clarification || Boolean(!submitted && failure?.repairable && !['requirement_quote_not_found', 'invalid_json', 'invalid_model_response', 'abnormal_finish'].includes(failure.reason))
      || engineering && attempt?.code === 'invalid_input' || stage.id === 'review';
    const canAnswer = Boolean(inputIssue) || clarification || Boolean(failure?.repairable) || engineering && ['invalid_input', 'invalid_model_response'].includes(attempt?.code) || stage.id === 'review';
    const existingQuestions = clarification && !inputIssue;
    const seen = new Set();
    const questionList = existingQuestions ? unanswered.flatMap(item => {
      const key = clarificationKey(item.question), followUp = followUps.get(key);
      if (seen.has(key) || submitted && !followUp) return [];
      seen.add(key);
      return [{ id: item.id, question: followUp?.question ?? item.question, ...(followUp ? { previousAnswer: followUp.answer } : {}) }];
    }) : [];
    const obsoleteQuestions = existingQuestions && submitted && !questionList.length;
    const oldMessage = (inputIssue?.message ?? (clarification ? '设计规格还有业务信息需要确认，请补充下面的问题。'
      : failure ? [failure.message, failure.detail].filter(Boolean).join(' ')
        : engineering && attempt?.detail ? `本次工程草案没有通过检查。 ${attempt.detail}`
          : stage.error || '规划未能完成，请查看当前阶段。')).slice(0, 4000);
    const id = contentRevision([run.id, run.sourceRevision, run.specRevision, run.planRevision, stage.id, stage.attempt, attempt?.id, options, oldMessage]);
    const message = obsoleteQuestions ? '已保留你的答复。这次草案里的剩余问题已回答，或属于可在规格中注明的细节，可以直接用已保存的回答重新整理。'
      : existingQuestions && submitted ? '请核对以下尚未明确的答复。' : oldMessage;
    const latest = run.planningIssueHistory?.findLast(item => item.issueId === id);
    const pending = this.hasSpecificationWork(project.id);
    const remaining = this.specificationRemaining(run);
    const explanation = allowQuestions && latest?.status === 'succeeded' ? latest.result : null;
    const generated = explanation?.questions ?? [];
    const distinct = new Set(distinctClarificationQuestions(generated));
    const qa = existingQuestions ? questionList
      : generated.flatMap((question, index) => distinct.delete(question) ? [{ id: `Q-${String(index + 1).padStart(3, '0')}`, question }] : []);
    const draft = run.planningIssueDraft?.id === id ? run.planningIssueDraft : null;
    const previousAnswer = draft?.answer ?? (run.specificationRepair && run.specificationRepair.sourceRevision === run.sourceRevision
      ? Object.values(run.specificationRepair.answers).join('\n') : '');
    const answers = draft?.answers ?? (qa.length === 1 && previousAnswer ? { [qa[0].id]: previousAnswer } : {});
    return { id, stageId: stage.id, title: stage.title, message, questions: allowQuestions ? options : [], allowQuestions, canExplain: !pending, pending,
      qa, answers, autoExplain: allowQuestions && !existingQuestions && !latest && !pending,
      fromInput: Boolean(inputIssue), answer: previousAnswer,
      canSave: canAnswer && !pending, canContinue: canAnswer && !pending && remaining !== 0 && (remaining === null || (run.specVersion ?? 0) < MAX_PLANNING_VERSIONS),
      canRebuild: Boolean(obsoleteQuestions) && !pending && remaining !== 0 && (remaining === null || (run.specVersion ?? 0) < MAX_PLANNING_VERSIONS),
      canRetrySpec: Boolean(unsupportedDraft) && !pending && remaining !== 0,
      ...(explanation ? { explanation } : {}),
      ...(['failed', 'interrupted'].includes(latest?.status) ? { explanationError: '这次未生成可用的问题，可重试生成。' } : {}) };
  }

  async explainPlanningIssue(project, run, issue, assertAccess) {
    if (!issue.canExplain) throw new HttpError(409, '前次模型请求仍待核对，请稍后再查看。');
    if (issue.explanation || !issue.allowQuestions) return;
    const entry = { projectId: project.id, runId: run.id, controller: new AbortController(), requestSettled: true, receiptSettled: true };
    const attempt = { id: randomUUID(), issueId: issue.id, sourceRevision: run.sourceRevision, status: 'running', startedAt: new Date().toISOString(),
      usage: { inputTokens: null, outputTokens: null }, receipt: null, receiptState: 'not_received', requestState: 'not_started',
      transport: { version: 1, dispatched: false, responseComplete: false } };
    run.planningIssueHistory ??= [];
    run.planningIssueHistory.push(attempt);
    if (issue.fromInput && this.planningInputIssues.has(run.id)) run.planningInputIssue = this.planningInputIssues.get(run.id);
    this.specificationPending.add(entry);
    const timeout = setTimeout(() => entry.controller.abort(), this.specificationTimeoutMs);
    let onAbort, modelPrice;
    try {
      await this.persist(project);
      attempt.requestState = 'dispatch_intent';
      attempt.coordinationRequired = true;
      attempt.transport.dispatched = null;
      await this.persist(project);
      assertAccess();
      if (this.closed || entry.controller.signal.aborted) throw new Error('cancelled');
      entry.providerInvoked = true;
      entry.requestSettled = false;
      let receipt;
      entry.nativeRequest = this.planner.analyzeWithModel(planningSourceText(run, project.source), project.name, {
        signal: entry.controller.signal, timeoutMs: this.specificationTimeoutMs,
        ...(this.planner.recordsModelPricing ? { onModelPrice: price => { modelPrice = price; } } : {}),
        planningIssue: { message: issue.message, questions: issue.questions, allowQuestions: issue.allowQuestions },
        onReceipt: async (value, proof) => {
          if (getModelRequestEvidence(proof)?.responseComplete !== true || receipt || entry.controller.signal.aborted) throw new Error('receipt_failed');
          entry.receiptEvidence = proof;
          const checked = specificationReceipt(value);
          receipt = checked.receipt;
          Object.assign(attempt, { model: receipt.model, finishReason: receipt.finishReason, usage: receipt.usage, receiptState: 'writing' });
          entry.receiptSettled = false;
          try {
            const info = await this.writeSpecificationReceipt(project, run, attempt, receipt, entry.controller.signal);
            if (entry.controller.signal.aborted || entry.finalized) return;
            attempt.receipt = specificationReceiptInfo(info, attempt.id);
            attempt.receiptState = 'saved';
            if (modelPrice) attempt.costEstimate = estimateModelCall(receipt, modelPrice);
          } catch (error) {
            if (!entry.finalized) attempt.receiptState = 'failed';
            throw error;
          } finally {
            entry.receiptSettled = true;
            if (entry.finalized) void this.reconcilePlanning(project, entry, attempt, this.specificationPending);
          }
          if (checked.credentialResponse) throw new Error('credential_response');
        },
      });
      const request = Promise.resolve(entry.nativeRequest).then(value => { entry.nativeResult = value; return value; }, error => { entry.nativeError = error; throw error; })
        .finally(() => { entry.requestSettled = true; if (entry.finalized) void this.reconcilePlanning(project, entry, attempt, this.specificationPending); });
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('cancelled'));
        entry.controller.signal.addEventListener('abort', onAbort, { once: true });
        if (entry.controller.signal.aborted) onAbort();
      });
      const result = await Promise.race([request, aborted]);
      assertAccess();
      if (this.closed || entry.controller.signal.aborted || this.planningIssue(project, run)?.id !== issue.id
        || this.planningEvidence(entry)?.responseComplete !== true || attempt.receiptState !== 'saved' || receipt?.finishReason !== 'stop') throw new Error('invalid_model_response');
      const validated = decodePlanningIssue(JSON.parse(receipt.content.replace(/^\s*```(?:json)?\s*/iu, '').replace(/\s*```\s*$/u, '').trim()), issue.allowQuestions);
      if (contentRevision(specificationData(result)) !== contentRevision(validated)) throw new Error('invalid_model_response');
      attempt.result = validated;
      attempt.status = 'succeeded';
    } catch {
      attempt.status = 'failed';
      attempt.code = 'planning_issue_failed';
    } finally {
      clearTimeout(timeout);
      if (onAbort) entry.controller.signal.removeEventListener('abort', onAbort);
      this.finalizePlanningAttempt(entry, attempt);
      if (attempt.receiptState === 'writing') attempt.receiptState = 'unconfirmed';
      attempt.finishedAt = new Date().toISOString();
      addEvent(run, attempt.status === 'succeeded' ? '已保存模型对当前规划问题的说明。' : '本次未收到可用的规划问题说明。', issue.stageId);
      try { await this.persist(project); }
      catch (error) { attempt.status = 'failed'; delete attempt.result; throw error; }
      finally { entry.finalized = true; void this.reconcilePlanning(project, entry, attempt, this.specificationPending); }
    }
    assertAccess();
  }

  answerPlanningIssue(project, run, issue, input) {
    if (!issue.canSave || input.continue === true && !issue.canContinue) throw new HttpError(409, '当前问题尚不能保存或继续，请刷新核对。');
    if (typeof input.continue !== 'boolean') throw new HttpError(400, '回答的提交方式无效。');
    const history = run.clarificationHistory ?? [], at = new Date().toISOString();
    const legacy = !Object.hasOwn(input, 'answers');
    let answers, saved;
    if (legacy) {
      if (typeof input.answer !== 'string' || !input.answer.isWellFormed()
        || input.answer.includes('\0') || !input.answer.trim() || input.answer.length > 8000) throw new HttpError(400, '请输入不超过8000字的回答。');
      saved = { answer: input.answer.trim() };
      answers = [{ id: `P-${history.length + 1}`, question: '用户针对当前规划问题补充的信息', answer: saved.answer, blocking: false }];
    } else {
      if (!input.answers || Object.getPrototypeOf(input.answers) !== Object.prototype || Object.hasOwn(input, 'answer')) throw new HttpError(400, '请按当前问题分别回答。');
      const rebuild = input.continue && issue.canRebuild && Object.keys(input.answers).length === 0;
      const allowed = new Set(issue.qa.map(item => item.id));
      if (!rebuild && (!allowed.size || Object.keys(input.answers).some(id => !allowed.has(id)))) throw new HttpError(409, '问题已更新，请刷新后回答。');
      answers = issue.qa.flatMap((item, index) => {
        if (!Object.hasOwn(input.answers, item.id)) return [];
        const value = input.answers[item.id];
        if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || value.length > 4000) throw new HttpError(400, '每条回答须为不超过4000字的文本。');
        if (input.continue && item.previousAnswer && value.trim() && needsConcreteAnswer(item.question, value)) throw new HttpError(400, `第 ${index + 1} 题仍需明确答复。请写出具体选择，或说明首版暂不包含或由系统决定。`);
        return value.trim() ? [{ id: item.id, question: item.question, answer: value.trim(), blocking: true }] : [];
      });
      if (!rebuild && (!answers.length || input.continue && answers.length !== issue.qa.length)) throw new HttpError(400, '请先回答本轮全部问题再提交。');
      saved = { answers: Object.fromEntries(answers.map(item => [item.id, item.answer])) };
    }
    if (!input.continue) {
      if (issue.fromInput && this.planningInputIssues.has(run.id)) run.planningInputIssue = this.planningInputIssues.get(run.id);
      run.planningIssueDraft = { id: issue.id, ...saved, at };
      return;
    }
    const openQuestions = legacy ? [...new Set([...(run.status === 'awaiting_spec' ? issue.questions : []), ...(issue.explanation?.questions ?? [])])].slice(0, 20)
      : answers.slice(0, 20).map(item => item.question.slice(0, 4000).toWellFormed());
    const priorAnswers = !legacy && run.status === 'awaiting_spec'
      ? (run.specQuestions ?? []).filter(item => item.answer?.trim() && !answers.some(answer => answer.question === item.question)) : [];
    const next = answers.length ? [...history, { kind: 'planning_issue', revision: run.sourceRevision, at,
      ...(openQuestions.length ? { openQuestions } : {}),
      answers: [...priorAnswers, ...answers] }] : history;
    if (planningSourceText({ ...run, clarificationHistory: next }, project.source).length > 100000) throw new HttpError(400, '需求和回答合计超过100000字，请精简回答。');
    if (run.specRevision && run.spec) run.revisionHistory.spec.push(this.snapshot(run, 'spec'));
    if (run.planRevision && run.tasks.length) run.revisionHistory.plan.push(this.snapshot(run, 'plan'));
    run.clarificationHistory = next;
    delete run.planningIssueDraft;
    delete run.planningInputIssue;
    delete run.specificationRepair;
    run.specQuestions = [];
    run.approvals = { spec: null, plan: null };
    run.planRevision = null;
    run.tasks = [];
    run.review = null;
    delete run.dependencyExecution;
    delete run.engineeringPlan;
    delete run.engineeringFallback;
    this.resetStages(run, descendants(run, ['spec']));
    run.status = 'running';
    run.decisions.push({ action: 'answer_planning_issue', revision: run.sourceRevision, issueId: issue.id, at });
    addEvent(run, answers.length ? `已保存本轮 ${answers.length} 条问答，继续整理规格。` : '正在用已保存的回答重新整理规格。', 'spec');
  }

  async describeRun(project, run) {
    const issue = this.planningIssue(project, run);
    const view = issue ? { ...run, planningIssue: issue } : run;
    if (run.mode !== 'model' || run.status !== 'failed') return view;
    if (run.stages.find(s => s.id === 'spec')?.status !== 'failed') {
      const engineeringFailure = this.describeEngineeringFailure(run);
      return engineeringFailure ? { ...view, engineeringFailure } : view;
    }
    const attempt = run.specificationHistory?.at(-1), input = contentRevision(planningSourceText(run, project.source));
    let detail = specificationFailure(attempt?.code, attempt?.reason, attempt?.requirementIndex, { requirementTitle: attempt?.requirementTitle, detail: attempt?.detail }), canRevalidate = false, draftRequirement;
    if (!this.sourceSuperseded(project, run) && run.workflowVersion === 2) {
      try { await this.savedSpecification(project, run); detail = specificationFailure('saved_response_valid'); canRevalidate = true; }
      catch (error) {
        if (error.reason) detail = specificationFailure(error.code, error.reason, error.requirementIndex, { requirementTitle: error.requirementTitle, field: error.field, detail: error.publicDetail });
      }
      if (issue && detail.reason === 'requirement_quote_not_found' && detail.requirementIndex && attempt?.inputRevision === input) {
        try {
          const receipt = await readSpecificationReceipt(this.store.directory, project.id, run.id, attempt);
          const draft = JSON.parse(receipt.content.replace(/^\s*```(?:json)?\s*/iu, '').replace(/\s*```\s*$/u, '').trim());
          const item = Array.isArray(draft?.requirements) ? draft.requirements[detail.requirementIndex - 1] : null;
          const excerpt = (value, length) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, length).toWellFormed() : '';
          if (item && typeof item.title === 'string') draftRequirement = { index: detail.requirementIndex, title: excerpt(item.title, 200),
            description: excerpt(item.description, 1200), sourceQuote: excerpt(item.sourceQuote, 400) };
        } catch { /* Avoid displaying unverified draft content. */ }
      }
    }
    if (run.status !== 'failed' || run.specificationHistory?.at(-1) !== attempt || input !== contentRevision(planningSourceText(run, project.source))) return run;
    const remaining = this.specificationRemaining(run), superseded = this.sourceSuperseded(project, run), pending = this.hasSpecificationWork(project.id);
    const supplement = detail.repairable && !canRevalidate && !superseded ? {
      available: true, fields: detail.repairFields, saved: this.specificationRepairAnswers(run), canSave: true, canRetry: remaining !== 0,
      note: '补充内容会作为新的需求来源保存，不覆盖原始需求；重新整理后仍需你确认规格。',
    } : { available: false, fields: [], saved: {}, canSave: false, canRetry: false, note: '' };
    const nextStep = canRevalidate ? '已保存的回答不会丢失。请点击“重新校验已保存响应”，无需再次调用模型。'
      : supplement.available && remaining !== 0 ? '补充信息后可继续整理规格，系统会再次请求模型。'
        : supplement.available ? '本次规格调用次数已用尽。补充信息仍可保存；请新建规划后继续。'
          : remaining === 0 ? '本次规格调用次数已用尽。已保存的回答仍保留，请勿继续重试；可以复制补充信息后新建规划。'
            : '已保存的回答仍保留。可核对原因后重试；重试会新增一次模型请求。';
    return { ...view, ...(draftRequirement ? { planningIssue: { ...issue, draftRequirement,
      message: '这条模型草案找不到可核对的引用。已保存的需求和答复会用于重新整理。' } } : {}),
      specificationFailure: { ...detail, attemptId: attempt?.id ?? null, remaining, pending, canRetry: remaining !== 0 && !superseded && !pending, canRevalidate: canRevalidate && !pending, supplement: pending ? { ...supplement, canRetry: false } : supplement, nextStep: pending ? '前次规划请求或私有回执仍待核对；本地结束不表示远端已停，不能重复请求或切换输入。' : nextStep } };
  }

  appendSpecificationRepair(project, run, answers, now) {
    const attempt = run.specificationHistory?.at(-1);
    const roundNo = (run.clarificationHistory?.length ?? 0) + 1;
    const questions = Object.entries(answers).map(([field, answer], index) => ({
      id: `S-${String(roundNo).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
      field, question: specificationRepairField(field, attempt?.requirementIndex)?.question ?? field, answer, blocking: false,
    }));
    const round = { kind: 'spec_repair', revision: run.sourceRevision, at: now, answers: questions };
    const nextSource = planningSourceText({ ...run, clarificationHistory: [...(run.clarificationHistory ?? []), round] }, project.source);
    if (nextSource.length > 100000) throw new HttpError(400, '原需求和补充回答合计超过100000字符，请精简补充信息。');
    if (run.specRevision && run.spec) run.revisionHistory.spec.push(this.snapshot(run, 'spec'));
    run.clarificationHistory = [...(run.clarificationHistory ?? []), round];
    delete run.specificationRepair;
    return round;
  }

  supplementSpecification(project, run, state, input) {
    if (run.workflowVersion !== 2 || run.mode !== 'model' || run.status !== 'failed' || state.active.size || this.hasSpecificationWork(project.id)
      || run.stages.some(stage => stage.status === 'running') || run.stages.find(stage => stage.id === 'spec')?.status !== 'failed'
      || project.runs.some(item => item !== run && !this.sourceSuperseded(project, item) && ACTIVE_STATUSES.has(item.status))) throw new HttpError(409, '当前运行尚不能补充规格信息，请先结束其他活动运行。');
    assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
    if (input.revision !== run.sourceRevision) throw new HttpError(409, '需求版本已变化，请刷新后重新核对。');
    if (input.retry !== undefined && typeof input.retry !== 'boolean') throw new HttpError(400, '补充操作的重试标记无效。');
    const answers = input.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.getPrototypeOf(answers) !== Object.prototype || Object.getOwnPropertySymbols(answers).length) throw new HttpError(400, '补充信息必须是字段到文本的对象。');
    const attempt = run.specificationHistory?.at(-1);
    const detail = specificationFailure(attempt?.code, attempt?.reason, attempt?.requirementIndex, { requirementTitle: attempt?.requirementTitle, detail: attempt?.detail });
    if (!detail.repairable) throw new HttpError(409, '当前失败不能通过补充需求信息处理，请核对失败原因后重试。');
    const allowed = new Set(detail.repairFields.map(field => field.id)), cleaned = {};
    for (const [key, value] of Object.entries(answers)) {
      if (!allowed.has(key)) throw new HttpError(400, '补充信息包含当前失败不支持的字段。');
      if (typeof value !== 'string') throw new HttpError(400, '补充信息必须是文本。');
      const answer = value.trim();
      if (!answer) continue;
      if (answer.length > 4000) throw new HttpError(400, '每项补充信息不能超过 4000 字符。');
      cleaned[key] = answer;
    }
    if (!Object.keys(cleaned).length) throw new HttpError(400, '请至少填写一项补充信息。');
    const retry = input.retry === true, now = new Date().toISOString();
    if (!retry) {
      run.specificationRepair = { answers: cleaned, sourceRevision: run.sourceRevision, savedAt: now };
      addEvent(run, '已保存规格补充信息，未调用模型；可在剩余次数内重新整理规格。', 'spec');
      return;
    }
    if (this.specificationRemaining(run) === 0) throw new HttpError(409, '本次规格调用次数已用尽，补充信息仍可单独保存；请新建规划后继续。');
    this.appendSpecificationRepair(project, run, cleaned, now);
    this.resetStages(run, descendants(run, ['spec']));
    run.status = 'running';
    run.decisions.push({ action: 'supplement_spec', revision: run.sourceRevision, at: now, fields: Object.keys(cleaned) });
    addEvent(run, '已保存补充信息并重新整理规格；新规格仍需确认，尚未生成下游计划。', 'spec');
  }

  useLocalEngineering(project, run, state, input) {
    if (run.workflowVersion !== 2 || run.mode !== 'model' || run.status !== 'failed' || state.active.size || this.hasSpecificationWork(project.id)
      || run.stages.some(stage => stage.status === 'running')
      || !['architecture', 'tasks'].some(id => run.stages.find(stage => stage.id === id)?.status === 'failed')
      || project.runs.some(item => item !== run && !this.sourceSuperseded(project, item) && ACTIVE_STATUSES.has(item.status))) throw new HttpError(409, '当前运行尚不能改用本地工程规则，请先结束其他活动运行。');
    assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
    assertCurrentRevision(contentRevision(run.spec), run.specRevision);
    assertSpecApproval(run);
    if (run.engineeringPlan) throw new HttpError(409, '当前运行已有工程草案，请直接重试失败阶段。');
    const now = new Date().toISOString();
    run.engineeringFallback = { version: 1, specRevision: run.specRevision, at: now, reason: '模型工程草案未通过后由用户显式选择本地规则生成' };
    delete run.engineeringPlan;
    this.engineering.get(run.id)?.controller.abort(); this.engineering.delete(run.id);
    this.resetStages(run, descendants(run, ['architecture', 'tasks']));
    run.status = 'running';
    run.decisions.push({ action: 'use_local_engineering', revision: run.specRevision, at: now });
    addEvent(run, '模型工程草案失败；已由用户选择改用本地规则生成架构和任务，未调用模型，仍需计划确认。', 'architecture');
  }

  async revalidateEngineering(project, run, state, input) {
    if (run.workflowVersion !== 2 || run.mode !== 'model' || run.status !== 'failed' || state.active.size || this.hasSpecificationWork(project.id)
      || run.stages.some(stage => stage.status === 'running')
      || !['architecture', 'tasks'].some(id => run.stages.find(stage => stage.id === id)?.status === 'failed')
      || project.runs.some(item => item !== run && !this.sourceSuperseded(project, item) && ACTIVE_STATUSES.has(item.status))) throw new HttpError(409, '当前运行尚不能重新校验工程草案，请先结束其他活动运行。');
    assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
    assertCurrentRevision(contentRevision(run.spec), run.specRevision);
    assertSpecApproval(run);
    if (run.engineeringPlan) throw new HttpError(409, '当前运行已有工程草案，请直接重试失败阶段。');
    const candidates = [...(run.engineeringHistory ?? [])].reverse().filter(attempt => (attempt.status === 'failed'
      || attempt.status === 'interrupted' && attempt.code === 'service_restart' && attempt.requestState === 'settled') && attempt.receiptState === 'saved' && attempt.receipt
      && attempt.specRevision === run.specRevision && attempt.sourceRevision === run.sourceRevision);
    let chosen = null, lastError = null;
    for (const attempt of candidates) {
      try {
        const receipt = await this.readEngineeringReceipt(project, run, attempt);
        if (receipt.finishReason !== 'stop') throw new HttpError(409, '工程草案未正常结束，不能免费重新校验。');
        const proposal = JSON.parse(receipt.content);
        const draft = validateEngineeringPlan({ proposal, spec: structuredClone(run.spec), binding: { projectId: project.id, runId: run.id, specRevision: run.specRevision } });
        chosen = { attempt, draft: finalizeEngineeringWorkflow(draft, run.spec) };
        break;
      } catch (error) { lastError = error; }
    }
    if (!chosen) throw new HttpError(409, `保存的工程草案仍不符合结构规则${lastError?.message ? `：${lastError.message}` : ''}；请重试该阶段或新建运行。`);
    if (this.closed || this.store.get(project.id) !== project || !project.runs.includes(run) || contentRevision(run.sourceSnapshot ?? project.source) !== run.sourceRevision
      || contentRevision(run.spec) !== run.specRevision || run.status !== 'failed') throw new HttpError(409, '工程草案所属运行已变化，未发布结果。');
    run.engineeringPlan = structuredClone(chosen.draft); delete run.engineeringFallback;
    (run.engineeringRevalidations ??= []).push({ attemptId: chosen.attempt.id, at: new Date().toISOString(), normalizedRouteParameters: true, proposalHash: chosen.draft.hash, policyHash: chosen.draft.policyHash });
    this.engineering.get(run.id)?.controller.abort(); this.engineering.delete(run.id);
    this.resetStages(run, descendants(run, ['architecture', 'tasks']));
    run.status = 'running';
    addEvent(run, `已重新校验保存的工程草案（第 ${chosen.attempt.attempt} 次），规范化路由参数写法，未调用模型；原失败与用量保留。`, 'architecture', 'success');
  }

  async revalidateSpecification(project, run, state, input) {
    if (run.workflowVersion !== 2 || run.mode !== 'model' || run.status !== 'failed' || state.active.size || this.hasSpecificationWork(project.id)
      || run.stages.some(s => s.status === 'running') || run.stages.find(s => s.id === 'spec')?.status !== 'failed'
      || project.runs.some(r => r !== run && !this.sourceSuperseded(project, r) && ACTIVE_STATUSES.has(r.status))) throw new HttpError(409, '当前运行尚不能重新校验，请先结束其他活动运行。');
    assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
    const attempt = run.specificationHistory?.at(-1);
    if (input.attemptId !== attempt?.id) throw new HttpError(409, '保存响应版本已变化，请刷新后重新核对。');
    if (run.specVersion >= MAX_PLANNING_VERSIONS) throw new HttpError(409, '规格版本已达上限，请新建运行。');
    const originalSpecRevision = run.specRevision;
    let saved;
    try { saved = await this.savedSpecification(project, run); }
    catch (error) { throw new HttpError(409, specificationFailure(error.code, error.reason, error.requirementIndex).message); }
    this.assertProjectAvailable(project, run);
    if (this.closed || this.store.get(project.id) !== project || !project.runs.includes(run) || contentRevision(run.sourceSnapshot ?? project.source) !== run.sourceRevision || run.specificationHistory.at(-1) !== saved.attempt || contentRevision(saved.attempt) !== saved.proof || saved.attempt.inputRevision !== contentRevision(planningSourceText(run, project.source)) || run.specRevision !== originalSpecRevision || run.status !== 'failed') throw new HttpError(409, '响应所属运行已变化，未发布规格。');
    run.revisionHistory.spec.push(this.snapshot(run, 'spec'));
    this.resetStages(run, descendants(run, ['spec']));
    Object.assign(run, saved.result); run.specVersion++;
    run.approvals = { spec: null, plan: null }; run.planRevision = null; run.tasks = []; run.review = null; delete run.dependencyExecution; delete run.engineeringPlan; delete run.engineeringFallback;
    const at = new Date().toISOString(), stage = run.stages.find(s => s.id === 'spec');
    stage.status = 'succeeded'; stage.finishedAt = at;
    stage.history.push({ attempt: stage.attempt, status: 'succeeded', kind: 'receipt_revalidation', finishedAt: at, error: null });
    (run.specificationRevalidations ??= []).push({ attemptId: attempt.id, receipt: structuredClone(attempt.receipt), inputRevision: attempt.inputRevision, specRevision: run.specRevision, at });
    run.artifacts.push({ name: 'spec.md', title: titles['spec.md'], stageId: 'spec', content: this.renderSpec(run.spec), createdAt: at });
    run.status = 'awaiting_spec';
    addEvent(run, '已重新校验保存响应，未调用模型；原失败与用量记录保留，请核对并确认新规格。', 'spec', 'success');
  }

  usePlatformDefaults(project, run, state, input) {
    if (run.workflowVersion !== 2 || !run.spec || !['awaiting_spec', 'awaiting_review', 'failed'].includes(run.status)
      || state.active.size || this.hasSpecificationWork(project.id) || run.stages.some(s => s.status === 'running')
      || project.runs.some(r => r !== run && !this.sourceSuperseded(project,r) && ACTIVE_STATUSES.has(r.status))) throw new HttpError(409, '当前不能修改方案，请先等待运行结束。');
    if (run.stages.find(s => s.id === 'spec')?.status !== 'succeeded') throw new HttpError(409, '请先完成规格整理或重新校验保存响应。');
    assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
    assertCurrentRevision(run.specRevision, input.revision);
    assertCurrentRevision(contentRevision(run.spec), run.specRevision);
    if (run.specVersion >= MAX_PLANNING_VERSIONS) throw new HttpError(409, '规格版本已达上限，请新建运行。');
    const result = this.prepareSpec(project, run, input.spec ?? run.spec, run.specQuestions, input.answers ?? {});
    if (result.specRevision === run.specRevision) throw new HttpError(409, '当前规格已采用平台默认方案。');
    run.revisionHistory.spec.push(this.snapshot(run,'spec'));
    if (run.planRevision) run.revisionHistory.plan.push(this.snapshot(run,'plan'));
    const previous = run.specRevision;
    Object.assign(run,result); run.specVersion++; run.planRevision=null; run.approvals={spec:null,plan:null};
    run.tasks=[];run.review=null;run.feedback='';run.approvedAt=null;delete run.dependencyExecution;delete run.engineeringPlan;delete run.engineeringFallback;
    this.resetStages(run,descendants(run,['architecture','tasks']));
    run.artifacts=run.artifacts.filter(a=>a.name!=='spec.md');
    run.artifacts.push({name:'spec.md',title:titles['spec.md'],stageId:'spec',content:this.renderSpec(run.spec),createdAt:new Date().toISOString()});
    run.status='awaiting_spec';
    run.decisions.push({action:'use_platform_defaults',revision:previous,newRevision:run.specRevision,at:new Date().toISOString(),feedback:'采用平台统一Web方案；旧确认失效，需重新核对规格。'});
    addEvent(run,'已免费应用平台默认网页方案，原文及回答保留；请核对并确认新规格。');
  }

  async action(projectId, runId, input = {}, { assertAccess = () => {} } = {}) {
    assertAccess();
    if (this.closed) throw new HttpError(409, '服务正在停止，请稍后重试。');
    const { project, run } = this.store.getRun(projectId, runId);
    this.assertProjectAvailable(project, run);
    const state = this.state(run);
    if (state.actionBusy || this.projectActions.has(projectId)) throw new HttpError(409, '该项目的操作正在保存，请稍后重试。');
    state.actionBusy = true;
    this.projectActions.add(projectId);
    const planningAction = ['clarify_spec', 'approve_spec', 'revise_spec', 'reject_spec', 'approve_plan', 'revise_plan', 'revise_route_roles', 'revise_route_contracts', 'reject_plan'].includes(input.action);
    const supplementAction = input.action === 'supplement_spec';
    const meetingAction = ['start_spec_meeting', 'advance_spec_meeting'].includes(input.action);
    const issueAction = ['explain_planning_issue', 'answer_planning_issue'].includes(input.action);
    const decisionAction = planningAction || supplementAction || issueAction || meetingAction || ['approve', 'revalidate_spec', 'revalidate_engineering', 'use_local_engineering', 'use_platform_defaults'].includes(input.action);
    // Invalid requests during execution must never replace the stage objects
    // held by executeStage. Rollback is safe only at a quiescent review point.
    let before = null;
    try {
      const action = input.action;
      if (action !== 'pause' && this.hasSpecificationWork(projectId)) throw new HttpError(409, '该项目仍有规划请求或私有回执待核对，不能重复派发或变更当前运行。');
      if (decisionAction) {
        if (project.runs.some(item => this.state(item).active.size || item !== run && !this.sourceSuperseded(project, item) && item.status === 'running')) throw new HttpError(409, '请等待该项目正在执行的阶段结束后再审阅。');
        // A displayed review checkpoint may still be saving. Keep approvals
        // invisible until every entered driver has finished that publication.
        await Promise.all(project.runs.map(item => this.state(item).driveIdle).filter(Boolean));
        // A complete request may wait for publication while its owner is revoked.
        // Check the trusted caller again before creating or approving a version.
        assertAccess();
        if (this.closed || project.runs.some(item => this.state(item).active.size)) throw new HttpError(409, '该项目尚未进入可保存的审阅停点。');
        if (action !== 'explain_planning_issue' && !run.stages.some(stage => stage.status === 'running')) before = structuredClone(run);
      }
      if (['retry', 'resume'].includes(action) && project.runs.some(item => item !== run && (this.state(item).active.size || !this.sourceSuperseded(project, item) && ACTIVE_STATUSES.has(item.status)))) throw new HttpError(409, '该项目已有其他活动运行，请先完成它。');
      if (['retry', 'resume'].includes(action) && this.hasSpecificationWork(projectId)) throw new HttpError(409, '该项目规格请求或私有回执仍待核对，不能重复派发。');
      if (meetingAction) {
        if (run.status !== 'awaiting_spec') throw new HttpError(409, '请在规格确认停点进行评审。');
        assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
        if (run.automaticDelivery) throw new HttpError(409, '离线评审首版仅用于手动规划，请新建手动运行；不会代替自动交付的真实审查。');
        if (action === 'start_spec_meeting') {
          if (Object.keys(input).some(key => !['action', 'revision', 'scenario'].includes(key))) throw new HttpError(400, '评审启动包含未知字段。');
          startSpecificationMeeting(run, input);
        } else {
          if (Object.keys(input).some(key => !['action', 'revision', 'roundId'].includes(key))) throw new HttpError(400, '不接受客户端提交Review结论或完成状态。');
          await advanceSpecificationMeeting(run, input, { executor: this.specificationMeetingExecutor,
            timeoutMs: this.specificationMeetingTimeoutMs ?? 3000,
            assertAccess: () => { assertAccess(); if (this.closed || this.sourceSuperseded(project, run)) throw new HttpError(409, '评审已停止或来源失效。'); } });
          if (currentMeeting(run).status === 'needs_source_revision') this.applyMeetingDecisions(project, run, currentMeeting(run).sourceResolutions, false);
        }
        this.syncMeetingArtifacts(run); addEvent(run, `离线规格评审：${currentMeeting(run).status}，未放行工程规划。`, 'spec');
      } else if (issueAction) {
        const issue = this.planningIssue(project, run);
        if (!issue || issue.id !== input.issueId) throw new HttpError(409, '问题或输入版本已变化，请刷新后继续。');
        if (action === 'explain_planning_issue') {
          if (issue.kind === 'specification_meeting') throw new HttpError(409, '离线评审已列明问题与选项，不请求付费模型解释。');
          if (input.automatic !== undefined && typeof input.automatic !== 'boolean') throw new HttpError(400, '问题生成方式无效。');
          if (input.automatic && !issue.autoExplain) return run;
          await this.explainPlanningIssue(project, run, issue, assertAccess);
          return run;
        }
        if (issue.kind === 'specification_meeting') this.answerSpecificationMeeting(project, run, issue, input);
        else this.answerPlanningIssue(project, run, issue, input);
      } else if (supplementAction) {
        this.supplementSpecification(project, run, state, input);
      } else if (planningAction) {
        this.planningAction(project, run, state, input);
      } else if (action === 'use_platform_defaults') {
        this.usePlatformDefaults(project, run, state, input);
      } else if (action === 'revalidate_spec') {
        await this.revalidateSpecification(project, run, state, input);
      } else if (action === 'revalidate_engineering') {
        await this.revalidateEngineering(project, run, state, input);
      } else if (action === 'use_local_engineering') {
        this.useLocalEngineering(project, run, state, input);
      } else if (action === 'pause') {
        if (run.status !== 'running') throw new HttpError(409, '只有执行中的运行可以暂停。');
        run.status = 'paused';
        addEvent(run, '已请求在阶段边界暂停；正在执行的阶段会先完成。');
      } else if (action === 'resume') {
        if (run.status !== 'paused') throw new HttpError(409, '只有暂停的运行可以继续。');
        run.status = 'running';
        addEvent(run, '继续执行待处理阶段。');
      } else if (action === 'approve') {
        if (run.workflowVersion === 2) throw new HttpError(409, '请分别确认当前规格版本和计划版本；旧确认操作不能绕过版本门禁。');
        if (run.status !== 'awaiting_review') throw new HttpError(409, '请等待计划检查完成后再确认导出。');
        run.feedback = planningFeedback(input.feedback);
        run.approvedAt = new Date().toISOString();
        run.status = 'running';
        addEvent(run, '用户已审阅并确认旧版开发计划，开始导出文档。', null, 'success');
      } else if (action === 'retry') {
        if (run.status !== 'failed' || state.active.size) throw new HttpError(409, '请等待失败运行结束后重试。');
        const failed = run.stages.filter(stage => stage.status === 'failed' && (!input.stageId || stage.id === input.stageId));
        if (!failed.length) throw new HttpError(409, '所选阶段不是可重试的失败阶段。');
        if (this.usesEngineering(run) && !run.engineeringPlan && failed.some(stage => ['architecture', 'tasks'].includes(stage.id)) && this.engineeringRemaining(run) === 0) throw new HttpError(409, '本次工程调用次数已用尽，可免费重新校验已有响应或改用本地规则。');
        if (this.usesEngineering(run) && failed.some(stage => ['architecture', 'tasks'].includes(stage.id)) && !run.engineeringPlan) {
          if (this.engineeringRemaining(run) === null) run.engineeringBatchStartedAt = new Date().toISOString();
          this.engineering.get(run.id)?.controller.abort(); this.engineering.delete(run.id);
          for (const stage of run.stages) if (['architecture', 'tasks'].includes(stage.id) && stage.status === 'failed' && !failed.includes(stage)) failed.push(stage);
        }
        if (run.mode === 'model' && failed.some(stage => stage.id === 'spec') && this.specificationRemaining(run) === 0) throw new HttpError(409, '本次规格调用次数已用尽，不能再次请求模型；已保存回答仍保留，可免费重新校验已有有效响应。');
        let usedRepair = false;
        if (run.mode === 'model' && failed.some(stage => stage.id === 'spec') && run.specificationRepair?.sourceRevision === run.sourceRevision) {
          const allowed = new Set(['goal', 'users', 'scope', 'exclude', 'acceptance', 'evidence', 'note']);
          const saved = Object.fromEntries(Object.entries(run.specificationRepair.answers ?? {}).filter(([field, answer]) => allowed.has(field) && typeof answer === 'string' && answer.trim() && answer.length <= 4000).map(([field, answer]) => [field, answer.trim()]));
          if (Object.keys(saved).length) { this.appendSpecificationRepair(project, run, saved, new Date().toISOString()); usedRepair = true; }
        }
        const reset = descendants(run, failed.map(stage => stage.id));
        for (const stage of run.stages) if (reset.has(stage.id) && ['failed', 'blocked'].includes(stage.status)) {
          stage.status = 'pending'; stage.error = null; stage.startedAt = null; stage.finishedAt = null;
        }
        run.status = 'running';
        addEvent(run, `重试 ${failed.map(stage => stage.title).join('、')}，保留已成功阶段与历史日志。${usedRepair ? '已带入保存的规格补充信息。' : ''}`);
      } else throw new HttpError(400, '不支持该操作。');
      if (planningAction) delete run.planningInputIssue;
      await this.persist(project);
      if (planningAction || action === 'answer_planning_issue' && input.continue) this.planningInputIssues.delete(run.id);
      if (['revise_spec', 'clarify_spec', 'use_platform_defaults', 'supplement_spec', 'use_local_engineering'].includes(input.action) || action === 'answer_planning_issue' && input.continue) { this.engineering.get(run.id)?.controller.abort(); this.engineering.delete(run.id); }
      this.schedule(project, run);
      return run;
    } catch (error) {
      // Planning decisions have no in-flight stages; a failed save must not grant an in-memory approval.
      if (before) {
        for (const key of Object.keys(run)) delete run[key];
        Object.assign(run, before);
        if (run.mode === 'model' && ['awaiting_spec', 'awaiting_review'].includes(run.status)
          && ['approve_spec', 'revise_spec', 'clarify_spec', 'approve_plan', 'revise_plan'].includes(input.action)
          && (error?.status === 400 || error?.planningInput === true)) {
          const message = guardModelContent(error.message.slice(0, 4000).toWellFormed(), process.env.LLM_API_KEY || '').content;
          const issue = { status: run.status, stageId: input.action.endsWith('_spec') ? 'spec' : 'review',
            specRevision: run.specRevision, planRevision: run.planRevision, message };
          this.planningInputIssues.set(run.id, issue);
          if (this.planningInputIssues.size > 100) this.planningInputIssues.delete(this.planningInputIssues.keys().next().value);
        }
      }
      throw error;
    } finally { state.actionBusy = false; this.projectActions.delete(projectId); }
  }

  planningAction(project, run, state, input) {
    const { action } = input;
    if (run.workflowVersion !== 2) throw new HttpError(409, '旧版运行仅支持旧版导出确认，请新建运行使用规格和计划版本门禁。');
    if (Object.hasOwn(input, 'dependencyExecution') && (action !== 'revise_plan' || input.dependencyExecution !== true)) {
      throw new HttpError(400, '仅修订开发计划时可选择按依赖执行。');
    }
    if (state.active.size || run.stages.some(stage => stage.status === 'running')) throw new HttpError(409, '请等待当前阶段结束后审阅或修订。');
    assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
    const specAction = action.endsWith('_spec');
    const allowed = action === 'revise_spec' ? ['awaiting_spec', 'awaiting_review']
      : action === 'revise_plan' ? ['awaiting_review', 'succeeded'] : [specAction ? 'awaiting_spec' : 'awaiting_review'];
    if (!allowed.includes(run.status)) throw new HttpError(409, '当前运行不在该操作的审阅停点。');
    if (action === 'revise_plan' && run.status === 'succeeded') {
      if (!run.planRevision || run.approvals?.plan?.revision !== run.planRevision) throw new HttpError(409, '当前版本没有可修订的已确认计划。');
      if (project.runs.some(item => item !== run && !this.sourceSuperseded(project, item) && ACTIVE_STATUSES.has(item.status))) throw new HttpError(409, '同项目已有其他活动规划，请先处理该运行再修订计划。');
    }
    assertCurrentRevision(specAction ? run.specRevision : run.planRevision, input.revision);
    assertCurrentRevision(contentRevision(run.spec), run.specRevision);
    const feedback = planningFeedback(input.feedback, action.startsWith('reject_'));
    const now = new Date().toISOString();
    const kind = specAction ? 'spec' : 'plan';
    const decision = { action, revision: input.revision, specRevision: run.specRevision, at: now, feedback };
    if (action === 'clarify_spec') {
      if (run.mode !== 'model' || !run.spec.clarificationRequired || run.spec.requirements.length) throw new HttpError(409, '当前规格不在需求澄清阶段。');
      if (this.hasSpecificationWork(project.id)) throw new HttpError(409, '前次规格调用仍待核对，请稍后继续。');
      if (run.specVersion >= MAX_PLANNING_VERSIONS && this.specificationRemaining(run) !== null) throw new HttpError(409, '规格版本已达上限，请新建运行。');
      if (this.specificationRemaining(run) === 0) throw new HttpError(409, '本次规格整理次数已用尽，可先保存回答；请将已确认的信息补充到需求后重新编排。');
      const result = preparePlanningSpec(run.spec, planningSourceText(run, project.source), run.specQuestions, input.answers ?? {});
      if (result.specQuestions.some(q => !q.answer.trim())) throw new HttpError(400, '请回答全部待澄清问题；暂不确定的内容可以明确写出首版暂不包含。');
      const round = { revision: run.specRevision, at: now, answers: structuredClone(result.specQuestions) };
      const next = { ...run, clarificationHistory: [...(run.clarificationHistory ?? []), round] };
      if (planningSourceText(next, project.source).length > 100000) throw new HttpError(400, '原需求和补充回答合计超过100000字符，请精简回答。');
      run.revisionHistory.spec.push(this.snapshot(run, 'spec'));
      Object.assign(run, result, { clarificationHistory: next.clarificationHistory });
      run.approvals = { spec: null, plan: null }; run.planRevision = null;
      run.tasks = []; run.review = null; delete run.dependencyExecution; delete run.engineeringPlan; delete run.engineeringFallback;
      this.resetStages(run, descendants(run, ['spec']));
      run.status = 'running'; decision.newRevision = run.specRevision;
      addEvent(run, '已保存补充回答，正在重新整理规格；新规格仍需单独确认。');
    } else if (action.startsWith('approve_')) {
      if (specAction && run.specReview?.required) {
        if (typeof input.meetingRevision !== 'string') throw new HttpError(409, '须一并核对并确认规格、评审纪要和阶段清单，不能绕过规格评审。');
        assertSpecificationMeeting(run, input.meetingRevision);
      }
      if (!run.spec.requirements.length || run.spec.clarificationRequired) throw new HttpError(409, '需求仍待澄清，请回答问题并重新整理规格后再确认。');
      if (run.decisions.some(item => item.action === `reject_${kind}` && item.revision === input.revision)) throw new HttpError(409, '该版本已被驳回，请先修订内容再确认。');
      if ((run.specQuestions ?? []).some(item => item.blocking && !item.answer.trim())) throw new HttpError(409, '仍有阻塞问题未答复，请先修订规格并保存问题答复。');
      if (!specAction) {
        assertCurrentRevision(run.specRevision, input.specRevision);
        assertSpecApproval(run);
        assertCurrentRevision(planningRevision(run), run.planRevision);
        if (run.engineeringPlan) assertEngineeringAlignment(run);
        validatePlanningTasks(run.spec, run.tasks);
        if (run.dependencyExecution === true && !isModuleWorkflow(run.engineeringPlan, run.tasks)) assertDependencyExecutionPlan(run.spec, run.tasks);
        if (!run.review?.passed || run.review.issues?.length) throw new HttpError(409, '计划检查仍有阻塞问题，不能确认。');
      }
      if (specAction && this.usesEngineering(run)) {
        try { inspectEngineeringContext({ spec: run.spec, binding: { projectId: project.id, runId: run.id, specRevision: run.specRevision } }); }
        catch {
          let message = '规格的工程资料格式或内容超限，请检查需求、验收条件和角色说明，保存后再确认；无需重试模型。';
          if (!run.spec.platformDefaults) message = '请先免费采用平台默认方案，再重新确认规格，无需重试模型。';
          else if (run.spec.title.length > 200) message = '规格标题最多200字，请缩短标题并保存修订后再确认。';
          else if (run.spec.requirements.some(r => r.title.length > 200)) message = '每条需求标题最多200字，请缩短超长标题并保存修订后再确认。';
          else if (run.spec.requirements.some(r => r.description.length > 12000 || r.acceptance.length > 30 || r.acceptance.some(a => a.length > 2000))) message = '每条需求说明最多12000字、验收条件最多30条且每条最多2000字，请精简后保存并确认。';
          throw Object.assign(new HttpError(409, message), { planningInput: true });
        }
      }
      run.approvals[kind] = specAction ? { revision: run.specRevision, at: now, feedback } : { revision: run.planRevision, specRevision: run.specRevision, at: now, feedback };
      if (specAction && run.specReview?.required) {
        const round = currentMeeting(run);
        round.confirmation = { at: now, specRevision: run.specRevision, bundleRevision: round.bundleRevision, feedback, kind: 'human_confirmation_of_offline_review' };
        run.approvals.spec.meetingRevision = round.bundleRevision; this.syncMeetingArtifacts(run);
      }
      if (specAction && this.usesEngineering(run) && this.engineeringRemaining(run) === null) run.engineeringBatchStartedAt = now;
      if (!specAction) { run.feedback = feedback; run.approvedAt = now; }
      run.status = 'running';
      addEvent(run, specAction ? '已确认当前规格版本，开始架构与任务规划。' : '已确认当前计划版本，开始导出规划文档。', null, 'success');
    } else if (action.startsWith('reject_')) {
      if (run.decisions.some(item => item.action === action && item.revision === input.revision)) throw new HttpError(409, '该版本已经驳回，请先修订。');
      run.approvals[kind] = null;
      addEvent(run, `用户驳回当前${specAction ? '规格' : '计划'}版本：${feedback}`);
    } else if (specAction) {
      if (run.specVersion >= MAX_PLANNING_VERSIONS) throw new HttpError(409, '规格版本已达到 20 版上限，请新建运行。');
      if (input.spec && !run.spec?.clarificationRequired && typeof input.spec.summary === 'string' && !input.spec.summary.trim()) throw new HttpError(400, '需求摘要为空，请概括要解决的问题和首版要实现的内容。');
      const result = this.prepareSpec(project, run, input.spec ?? run.spec, run.specQuestions, input.answers ?? {});
      if (result.specRevision === run.specRevision) throw new HttpError(409, '规格内容和问题答复均未变化，请作出实际修订。');
      if (run.revisionHistory.spec.some(item => item.revision === result.specRevision)) throw new HttpError(409, '不能恢复为旧规格版本，请保留本次修订依据。');
      const artifact = { name: 'spec.md', title: titles['spec.md'], stageId: 'spec', content: this.renderSpec(result.spec), createdAt: now };
      run.revisionHistory.spec.push(this.snapshot(run, 'spec'));
      if (run.planRevision) run.revisionHistory.plan.push(this.snapshot(run, 'plan'));
      Object.assign(run, result);
      run.specVersion++;
      run.planRevision = null;
      run.approvals = { spec: null, plan: null };
      run.tasks = []; run.review = null; run.feedback = ''; run.approvedAt = null;
      delete run.dependencyExecution;
      delete run.engineeringPlan;
      delete run.engineeringFallback;

      this.resetStages(run, descendants(run, ['architecture', 'tasks']));
      run.artifacts = run.artifacts.filter(item => item.name !== 'spec.md');
      run.artifacts.push(artifact);
      run.status = 'awaiting_spec';
      decision.newRevision = run.specRevision;
      addEvent(run, '已保存新规格版本；旧确认及下游计划已失效，历史结果保留。');
    } else {
      if (run.planVersion >= MAX_PLANNING_VERSIONS) throw new HttpError(409, '计划版本已达到 20 版上限，请新建运行。');
      assertSpecApproval(run);
      assertCurrentRevision(planningRevision(run), run.planRevision);
      let tasks;
      let engineeringPlan = run.engineeringPlan;
      if (action === 'revise_route_roles' || action === 'revise_route_contracts') {
        if (!engineeringPlan) throw new HttpError(409, '当前运行没有可修订的工程接口草案。');
        if (Object.keys(input).some(key => !['action', 'revision', 'changes', 'feedback'].includes(key))) throw new HttpError(400, '接口修订包含未授权字段。');
        const revise = action === 'revise_route_contracts' ? reviseEngineeringRouteContracts : reviseEngineeringRouteRoles;
        ({ tasks, engineeringPlan } = revise(run, input.changes));
      } else {
        tasks = validatePlanningTasks(run.spec, input.tasks, { previous: run.tasks });
        if (input.dependencyExecution === true) assertDependencyExecutionPlan(run.spec, tasks);
        if (engineeringPlan) ({ tasks, engineeringPlan } = reviseEngineeringTasks(run, tasks));
      }
      const moduleWorkflow = isModuleWorkflow(engineeringPlan, tasks);
      const dependencyExecution = run.dependencyExecution === true || input.dependencyExecution === true || moduleWorkflow;
      if (input.dependencyExecution !== true && dependencyExecution && !moduleWorkflow) assertDependencyExecutionPlan(run.spec, tasks);
      const architecture = engineeringPlan ? { name: 'architecture.md', title: titles['architecture.md'], stageId: 'architecture', content: renderEngineeringArchitecture(engineeringPlan), createdAt: now } : null;
      const revisionRun = architecture ? { ...run, artifacts: run.artifacts.map(item => item.name === 'architecture.md' ? architecture : item) } : run;
      const revision = planningRevision(dependencyExecution ? { ...revisionRun, dependencyExecution: true } : revisionRun, tasks, engineeringPlan);
      if (revision === run.planRevision) throw new HttpError(409, '任务计划内容未变化，请作出实际修订。');
      if (run.revisionHistory.plan.some(item => item.revision === revision)) throw new HttpError(409, '不能恢复为旧计划版本，请保留本次修订依据。');
      const artifact = { name: 'task.md', title: titles['task.md'], stageId: 'tasks', content: engineeringPlan ? renderEngineeringTasks(this.planner, run.spec, tasks) : this.planner.renderTasks(run.spec, tasks), createdAt: now };
      run.revisionHistory.plan.push(this.snapshot(run, 'plan'));
      run.tasks = tasks; run.planRevision = revision; run.planVersion++;
      if (dependencyExecution) run.dependencyExecution = true;
      if (engineeringPlan) run.engineeringPlan = engineeringPlan;
      run.approvals.plan = null; run.review = null; run.feedback = ''; run.approvedAt = null;
      this.resetStages(run, new Set(['review', 'export']));
      run.artifacts = run.artifacts.filter(item => item.name !== 'task.md');
      if (architecture) run.artifacts = run.artifacts.map(item => item.name === 'architecture.md' ? architecture : item);
      run.artifacts.push(artifact);
      run.status = 'running';
      decision.newRevision = run.planRevision;
      addEvent(run, '已保存新计划版本；旧计划确认已失效，重新运行覆盖与依赖检查。');
    }
    run.decisions.push(decision);
  }

  async shutdown() {
    this.closed = true;
    for (const entry of new Set([...this.specification.values(), ...this.specificationPending])) entry.controller.abort();
    for (const entry of this.engineering.values()) entry.controller.abort();
    for (const entry of this.engineeringPending) entry.controller.abort();
    await Promise.allSettled([...this.checkpointWork]);
    await Promise.allSettled([...this.runtime.values()].flatMap(state => [...state.active.values()]));
    await this.store.flush();
  }
}
