import { randomUUID, createHash } from 'node:crypto';
import { mkdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './documents.mjs';
import { MAX_PLANNING_VERSIONS, contentRevision, preparePlanningSpec, validatePlanningTasks, planningRevision, planningFeedback, assertCurrentRevision, assertSpecApproval } from './planning-review.mjs';
import { createEngineeringModel, engineeringModelPolicy } from './engineering-model.mjs';
import { validateEngineeringPlan } from './engineering-plan.mjs';
import { engineeringTasks, renderEngineeringArchitecture, renderEngineeringTasks, assertEngineeringAlignment, reviseEngineeringTasks } from './engineering-planner.mjs';

export const WORKFLOW = [
  { id: 'intake', title: '读取需求文档', dependsOn: [] },
  { id: 'spec', title: '整理设计规格', dependsOn: ['intake'] },
  { id: 'architecture', title: '设计项目架构', dependsOn: ['spec'] },
  { id: 'tasks', title: '拆解开发任务', dependsOn: ['spec'] },
  { id: 'review', title: '检查依赖与覆盖', dependsOn: ['architecture', 'tasks'] },
  { id: 'export', title: '确认并导出文档', dependsOn: ['review'] },
];

const ACTIVE_STATUSES = new Set(['running', 'paused', 'awaiting_spec', 'awaiting_review']);
const titles = { 'spec.md': '设计规格', 'architecture.md': '项目架构', 'task.md': '开发任务', 'review.md': '检查报告', 'handoff.md': '开发交接', 'plan.json': '结构化计划' };

function addEvent(run, message, stageId = null, level = 'info') {
  run.events.push({ sequence: (run.events.at(-1)?.sequence ?? 0) + 1, time: new Date().toISOString(), stageId, level, message });
  run.updatedAt = new Date().toISOString();
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
  constructor(store, planner, { stepDelayMs = 350, concurrency = 2, engineeringMaxCalls = 3, engineeringTimeoutMs = 60000 } = {}) {
    this.store = store;
    this.planner = planner;
    this.stepDelayMs = Math.max(0, Math.min(5000, Number(stepDelayMs) || 0));
    this.concurrency = concurrency;
    this.runtime = new Map();
    this.closed = false;
    if (!Number.isInteger(engineeringMaxCalls) || engineeringMaxCalls < 1 || engineeringMaxCalls > 20 || !Number.isInteger(engineeringTimeoutMs) || engineeringTimeoutMs < 1 || engineeringTimeoutMs > 120000) throw new Error('工程规划预算无效。');
    this.engineeringMaxCalls = engineeringMaxCalls;
    this.engineeringTimeoutMs = engineeringTimeoutMs;
    this.engineering = new Map();
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
      if (this.projectAdmissions.has(projectId) || this.projectActions?.has(projectId) || project.runs.some(run => {
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

  usesEngineering(run) { return run.workflowVersion === 2 && run.mode === 'model'; }

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

  engineeringDraft(project, run) {
    assertSpecApproval(run);
    if (run.engineeringPlan) return Promise.resolve(assertEngineeringAlignment(run));
    let entry = this.engineering.get(run.id);
    if (entry && (entry.specRevision !== run.specRevision || entry.sourceRevision !== run.sourceRevision)) { entry.controller.abort(); this.engineering.delete(run.id); entry = null; }
    if (entry) return entry.promise;
    if ((run.engineeringCalls ?? 0) >= this.engineeringMaxCalls) return Promise.reject(new Error('工程规划调用预算已用尽，请新建运行或联系控制器调整预算。'));
    entry = { specRevision: run.specRevision, sourceRevision: run.sourceRevision, controller: new AbortController(), status: 'running' };
    this.engineering.set(run.id, entry);
    entry.promise = this.requestEngineering(project, run, entry);
    return entry.promise;
  }

  async requestEngineering(project, run, entry) {
    const attempt = { id: randomUUID(), attempt: (run.engineeringHistory?.length ?? 0) + 1, specRevision: entry.specRevision, sourceRevision: entry.sourceRevision, modelPolicyHash: engineeringModelPolicy.hash, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, model: null, usage: { inputTokens: null, outputTokens: null }, finishReason: null, receipt: null, receiptState: 'not_received', code: null };
    run.engineeringHistory ??= [];
    run.engineeringHistory.push(attempt);
    let timer, receipt, receiptWrites = Promise.resolve(), accepting = true, aborted, receiptSettled = true;
    const timeout = () => { entry.timedOut = true; entry.controller.abort(); };
    const failure = code => {
      if (this.engineering.get(run.id) === entry) delete run.engineeringPlan;
      attempt.code = code;
      attempt.status = code === 'cancelled' ? 'interrupted' : 'failed'; entry.status = 'failed';
      return Object.assign(new Error(`工程设计请求未被接受（${code}），未使用规则回退；可检查配置或重试。`), { code });
    };
    try {
      this.assertEngineeringCurrent(project, run, entry);
      // Persist the reservation before dispatch. Unknown/failed calls never refund it.
      run.engineeringCalls = (run.engineeringCalls ?? 0) + 1;
      await this.persist(project);
      this.assertEngineeringCurrent(project, run, entry);
      entry.deadline = Date.now() + this.engineeringTimeoutMs;
      timer = setTimeout(timeout, this.engineeringTimeoutMs);
      const interrupted = new Promise((_, reject) => {
        aborted = () => reject(Object.assign(new Error('工程规划请求已停止。'), { code: entry.timedOut ? 'model_timeout' : 'cancelled' }));
        entry.controller.signal.addEventListener('abort', aborted, { once: true });
        if (entry.controller.signal.aborted) aborted();
      });
      const request = Promise.resolve().then(() => {
        this.assertEngineeringCurrent(project, run, entry);
        const model = (this.planner.createEngineeringModel ?? createEngineeringModel)();
        return model({ spec: structuredClone(run.spec), binding: { projectId: project.id, runId: run.id, specRevision: entry.specRevision }, signal: entry.controller.signal, onReceipt: value => {
          if (!accepting || receipt || this.closed || entry.controller.signal.aborted || this.engineering.get(run.id) !== entry) throw new Error('receipt_failed');
          receipt = structuredClone(value);
          // Transport-provided known usage is retained even if the private disk write fails.
          Object.assign(attempt, this.engineeringReceiptMetadata(receipt));
          attempt.receiptState = 'writing'; receiptSettled = false;
          receiptWrites = Promise.resolve().then(() => this.writeEngineeringReceipt(project, run, attempt, receipt, entry.controller.signal)).then(metadata => {
            receiptSettled = true;
            if (accepting && !entry.controller.signal.aborted && !this.closed && this.engineering.get(run.id) === entry) {
              attempt.receipt = metadata; attempt.receiptState = 'saved';
            }
          }, () => {
            receiptSettled = true;
            if (accepting && !entry.controller.signal.aborted) attempt.receiptState = 'failed';
            throw Object.assign(new Error('私有回执保存失败。'), { code: 'receipt_failed' });
          });
          // Observe even non-cooperative writers without letting their late
          // completion mutate a finalized attempt or hold cancellation open.
          void receiptWrites.catch(() => {});
          return Promise.race([receiptWrites, interrupted]);
        } });
      });
      const result = await Promise.race([request, interrupted]);
      this.assertEngineeringCurrent(project, run, entry);
      await Promise.race([receiptWrites, interrupted]);
      this.assertEngineeringCurrent(project, run, entry);
      const draft = validateEngineeringPlan({ proposal: result.proposal, spec: run.spec, binding: { projectId: project.id, runId: run.id, specRevision: entry.specRevision } });
      const receipted = receipt?.finishReason === 'stop' ? validateEngineeringPlan({ proposal: JSON.parse(receipt.content), spec: run.spec, binding: draft.binding }) : null;
      if (!attempt.receipt || result.modelPolicyHash !== engineeringModelPolicy.hash || result.hash !== draft.hash || receipted?.hash !== draft.hash || result.model !== receipt.model || contentRevision(result.usage) !== contentRevision(receipt.usage)) throw new Error('invalid_model_response');
      this.assertEngineeringCurrent(project, run, entry);
      run.engineeringPlan = structuredClone(draft);
      attempt.status = 'succeeded'; entry.status = 'succeeded';
      return run.engineeringPlan;
    } catch (error) {
      const known = new Set(['invalid_input', 'transport_error', 'http_error', 'response_error', 'response_too_large', 'receipt_failed', 'credential_response', 'abnormal_finish', 'invalid_model_response', 'model_timeout', 'cancelled', 'stale_revision', 'persistence_failed']);
      throw failure(entry.timedOut ? 'model_timeout' : entry.controller.signal.aborted || this.closed ? 'cancelled' : known.has(error.code) ? error.code : 'invalid_model_response');
    } finally {
      accepting = false; clearTimeout(timer); if (aborted) entry.controller.signal.removeEventListener('abort', aborted);
      if (receipt && !attempt.receipt && (!receiptSettled || attempt.receiptState === 'writing')) attempt.receiptState = 'unconfirmed';
      attempt.finishedAt = new Date().toISOString();
      try { await this.persist(project); }
      catch { attempt.persistenceStatus = 'failed'; throw failure('persistence_failed'); }
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
          stage.history.push({ attempt: stage.attempt, status: 'failed', startedAt: stage.startedAt, finishedAt: stage.finishedAt, error: stage.error });
        }
        this.blockDependents(run);
        run.status = 'failed';
        addEvent(run, '上次运行已中断，成功产物已保留，可重试失败阶段。', null, 'error');
      }
      if (changed) await this.persist(project);
    }
  }

  async createRun(projectId, { mode = 'local', failOnceStage } = {}) {
    if (this.closed) throw new HttpError(409, '服务正在停止，请稍后重试。');
    const project = this.store.get(projectId);
    if (this.projectActions.has(projectId)) throw new HttpError(409, '该项目正在保存操作，请稍后重试。');
    this.assertProjectAvailable(project);
    if (this.projectAdmissions.has(projectId)) throw new HttpError(409, '项目正在创建运行，请稍后重试。');
    this.projectAdmissions.add(projectId);
    try {
    if (project.runs.some(run => !this.sourceSuperseded(project, run) && ACTIVE_STATUSES.has(run.status))) throw new HttpError(409, '该项目已有活动运行，请先完成或恢复它。');
    if (!['local', 'model'].includes(mode)) throw new HttpError(400, '请选择本地规则或模型模式。');
    if (mode === 'model' && !this.planner.getModelConfig().configured) throw new HttpError(400, '尚未配置模型，请在服务端 .env 设置模型地址、名称和密钥，或使用本地规则模式。');
    if (failOnceStage && !['architecture', 'tasks', 'review'].includes(failOnceStage)) throw new HttpError(400, '不支持该演示故障阶段。');
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(), projectId, mode, workflowVersion: 2, status: 'running', createdAt: now, updatedAt: now,
      sourceSnapshot: structuredClone(project.source), sourceRevision: contentRevision(project.source),
      sourceGeneration: project.sourceGeneration ?? 0,
      specRevision: null, planRevision: null, specVersion: 0, planVersion: 0, specQuestions: [],
      approvals: { spec: null, plan: null }, revisionHistory: { spec: [], plan: [] }, decisions: [],
      stages: WORKFLOW.map(stage => ({ ...stage, dependsOn: [...stage.dependsOn], status: 'pending', attempt: 0, startedAt: null, finishedAt: null, error: null, history: [] })),
      spec: null, tasks: [], artifacts: [], events: [], review: null, feedback: '', approvedAt: null,
      simulation: failOnceStage ? { failOnceStage } : null,
    };
    addEvent(run, `已冻结需求快照，开始${mode === 'model' ? '模型' : '本地规则'}规划。`);
    if (failOnceStage) addEvent(run, '已启用演示故障：指定阶段首次尝试将失败，重试后正常执行。');
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
        addEvent(run, '规格已生成；请答复全部待确认问题，并确认当前规格版本后再拆解任务。');
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
    const specRevision = run.specRevision, sourceRevision = run.sourceRevision;
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
        run.planRevision = planningRevision(run);
        run.planVersion++;
      }
      stage.history.push({ attempt: stage.attempt, status: 'succeeded', startedAt: stage.startedAt, finishedAt: now, error: null });
      addEvent(run, `${stage.title}完成${result.artifacts?.length ? `，生成 ${result.artifacts.map(a => a.name).join('、')}` : ''}。`, stage.id, 'success');
      await this.persist(project);
    } catch (error) {
      stage.status = 'failed';
      stage.finishedAt = new Date().toISOString();
      stage.error = error.message || '阶段执行失败。';
      stage.history.push({ attempt: stage.attempt, status: 'failed', startedAt: stage.startedAt, finishedAt: stage.finishedAt, error: stage.error });
      addEvent(run, `${stage.title}失败：${stage.error}`, stage.id, 'error');
      this.blockDependents(run);
      await this.persist(project);
    }
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
        const spec = run.mode === 'model' ? await p.analyzeWithModel(source.content, project.name) : p.analyzeRequirements(source.content, project.name);
        if (run.workflowVersion !== 2) return { spec, artifacts: [{ name: 'spec.md', content: p.renderSpec(spec) }] };
        const result = preparePlanningSpec(spec, source.content);
        return { ...result, specVersion: 1, artifacts: [{ name: 'spec.md', content: this.renderSpec(result.spec) }] };
      }
      case 'architecture':
        if (run.workflowVersion === 2) assertSpecApproval(run);
        if (this.usesEngineering(run)) {
          const plan = await this.engineeringDraft(project, run);
          return { artifacts: [{ name: 'architecture.md', content: renderEngineeringArchitecture(plan) }] };
        }
        return { artifacts: [{ name: 'architecture.md', content: p.renderArchitecture(run.spec) }] };
      case 'tasks': {
        if (run.workflowVersion === 2) assertSpecApproval(run);
        if (this.usesEngineering(run)) {
          const plan = await this.engineeringDraft(project, run), tasks = engineeringTasks(plan);
          validatePlanningTasks(run.spec, tasks); p.validateTaskGraph(tasks);
          return { tasks, artifacts: [{ name: 'task.md', content: renderEngineeringTasks(p, run.spec, tasks) }] };
        }
        const generated = p.generateTasks(run.spec);
        const tasks = run.workflowVersion === 2 ? validatePlanningTasks(run.spec, generated) : generated;
        p.validateTaskGraph(tasks);
        return { tasks, artifacts: [{ name: 'task.md', content: p.renderTasks(run.spec, tasks) }] };
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
          { name: 'plan.json', content: JSON.stringify({ project: project.name, runId: run.id, sourceFilename: source.filename, sourceRevision: run.sourceRevision, ...(run.sourceGeneration !== undefined ? { sourceGeneration: run.sourceGeneration } : {}), workflowVersion: run.workflowVersion, specRevision: run.specRevision, planRevision: run.planRevision, approvals: run.approvals, mode: run.mode, spec: run.spec, tasks: run.tasks, review: run.review, feedback: run.feedback, ...(run.engineeringPlan ? { engineeringPlan: run.engineeringPlan } : {}) }, null, 2) },
        ] };
      default: throw new Error('未知工作流阶段。');
    }
  }

  renderSpec(spec) {
    const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const answers = (spec.clarifications ?? []).map(item => `- ${item.id} ${escape(item.question)}\n  答复：${escape(item.answer || '尚未答复')}`);
    return `${this.planner.renderSpec(spec)}${answers.length ? `\n\n## 结构化问题答复\n\n${answers.join('\n')}` : ''}`;
  }

  snapshot(run, kind) {
    return structuredClone({
      version: kind === 'spec' ? run.specVersion : run.planVersion,
      revision: kind === 'spec' ? run.specRevision : run.planRevision,
      specRevision: run.specRevision, at: new Date().toISOString(), spec: run.spec,
      specQuestions: run.specQuestions, tasks: run.tasks, artifacts: run.artifacts,
      stages: run.stages, review: run.review, approvals: run.approvals,
      ...(run.engineeringPlan ? { engineeringPlan: run.engineeringPlan, engineeringHistory: run.engineeringHistory } : {}),
    });
  }

  resetStages(run, ids) {
    for (const stage of run.stages) if (ids.has(stage.id)) {
      stage.status = 'pending'; stage.error = null; stage.startedAt = null; stage.finishedAt = null;
    }
    run.artifacts = run.artifacts.filter(item => !ids.has(item.stageId));
  }

  async action(projectId, runId, input = {}) {
    if (this.closed) throw new HttpError(409, '服务正在停止，请稍后重试。');
    const { project, run } = this.store.getRun(projectId, runId);
    this.assertProjectAvailable(project, run);
    const state = this.state(run);
    if (state.actionBusy || this.projectActions.has(projectId)) throw new HttpError(409, '该项目的操作正在保存，请稍后重试。');
    state.actionBusy = true;
    this.projectActions.add(projectId);
    const planningAction = ['approve_spec', 'revise_spec', 'reject_spec', 'approve_plan', 'revise_plan', 'reject_plan'].includes(input.action);
    const decisionAction = planningAction || input.action === 'approve';
    // Invalid requests during execution must never replace the stage objects
    // held by executeStage. Rollback is safe only at a quiescent review point.
    let before = null;
    try {
      const action = input.action;
      if (decisionAction) {
        if (project.runs.some(item => this.state(item).active.size || item !== run && !this.sourceSuperseded(project, item) && item.status === 'running')) throw new HttpError(409, '请等待该项目正在执行的阶段结束后再审阅。');
        // A displayed review checkpoint may still be saving. Keep approvals
        // invisible until every entered driver has finished that publication.
        await Promise.all(project.runs.map(item => this.state(item).driveIdle).filter(Boolean));
        if (this.closed || project.runs.some(item => this.state(item).active.size)) throw new HttpError(409, '该项目尚未进入可保存的审阅停点。');
        if (!run.stages.some(stage => stage.status === 'running')) before = structuredClone(run);
      }
      if (['retry', 'resume'].includes(action) && project.runs.some(item => item !== run && (this.state(item).active.size || !this.sourceSuperseded(project, item) && ACTIVE_STATUSES.has(item.status)))) throw new HttpError(409, '该项目已有其他活动运行，请先完成它。');
      if (planningAction) {
        this.planningAction(project, run, state, input);
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
        if (this.usesEngineering(run) && failed.some(stage => ['architecture', 'tasks'].includes(stage.id)) && !run.engineeringPlan) {
          this.engineering.get(run.id)?.controller.abort(); this.engineering.delete(run.id);
          for (const stage of run.stages) if (['architecture', 'tasks'].includes(stage.id) && stage.status === 'failed' && !failed.includes(stage)) failed.push(stage);
        }
        const reset = descendants(run, failed.map(stage => stage.id));
        for (const stage of run.stages) if (reset.has(stage.id) && ['failed', 'blocked'].includes(stage.status)) {
          stage.status = 'pending'; stage.error = null; stage.startedAt = null; stage.finishedAt = null;
        }
        run.status = 'running';
        addEvent(run, `重试 ${failed.map(stage => stage.title).join('、')}，保留已成功阶段与历史日志。`);
      } else throw new HttpError(400, '不支持该操作。');
      await this.persist(project);
      if (input.action === 'revise_spec') { this.engineering.get(run.id)?.controller.abort(); this.engineering.delete(run.id); }
      this.schedule(project, run);
      return run;
    } catch (error) {
      // Planning decisions have no in-flight stages; a failed save must not grant an in-memory approval.
      if (before) {
        for (const key of Object.keys(run)) delete run[key];
        Object.assign(run, before);
      }
      throw error;
    } finally { state.actionBusy = false; this.projectActions.delete(projectId); }
  }

  planningAction(project, run, state, input) {
    const { action } = input;
    if (run.workflowVersion !== 2) throw new HttpError(409, '旧版运行仅支持旧版导出确认，请新建运行使用规格和计划版本门禁。');
    if (state.active.size || run.stages.some(stage => stage.status === 'running')) throw new HttpError(409, '请等待当前阶段结束后审阅或修订。');
    assertCurrentRevision(contentRevision(run.sourceSnapshot ?? project.source), run.sourceRevision);
    const specAction = action.endsWith('_spec');
    const allowed = action === 'revise_spec' ? ['awaiting_spec', 'awaiting_review'] : [specAction ? 'awaiting_spec' : 'awaiting_review'];
    if (!allowed.includes(run.status)) throw new HttpError(409, '当前运行不在该操作的审阅停点。');
    assertCurrentRevision(specAction ? run.specRevision : run.planRevision, input.revision);
    assertCurrentRevision(contentRevision(run.spec), run.specRevision);
    const feedback = planningFeedback(input.feedback, action.startsWith('reject_'));
    const now = new Date().toISOString();
    const kind = specAction ? 'spec' : 'plan';
    const decision = { action, revision: input.revision, specRevision: run.specRevision, at: now, feedback };
    if (action.startsWith('approve_')) {
      if (run.decisions.some(item => item.action === `reject_${kind}` && item.revision === input.revision)) throw new HttpError(409, '该版本已被驳回，请先修订内容再确认。');
      if ((run.specQuestions ?? []).some(item => item.blocking && !item.answer.trim())) throw new HttpError(409, '仍有阻塞问题未答复，请先修订规格并保存问题答复。');
      if (!specAction) {
        assertCurrentRevision(run.specRevision, input.specRevision);
        assertSpecApproval(run);
        assertCurrentRevision(planningRevision(run), run.planRevision);
        if (run.engineeringPlan) assertEngineeringAlignment(run);
        validatePlanningTasks(run.spec, run.tasks);
        if (!run.review?.passed || run.review.issues?.length) throw new HttpError(409, '计划检查仍有阻塞问题，不能确认。');
      }
      run.approvals[kind] = specAction ? { revision: run.specRevision, at: now, feedback } : { revision: run.planRevision, specRevision: run.specRevision, at: now, feedback };
      if (!specAction) { run.feedback = feedback; run.approvedAt = now; }
      run.status = 'running';
      addEvent(run, specAction ? '已确认当前规格版本，开始架构与任务规划。' : '已确认当前计划版本，开始导出规划文档。', null, 'success');
    } else if (action.startsWith('reject_')) {
      if (run.decisions.some(item => item.action === action && item.revision === input.revision)) throw new HttpError(409, '该版本已经驳回，请先修订。');
      run.approvals[kind] = null;
      addEvent(run, `用户驳回当前${specAction ? '规格' : '计划'}版本：${feedback}`);
    } else if (specAction) {
      if (run.specVersion >= MAX_PLANNING_VERSIONS) throw new HttpError(409, '规格版本已达到 20 版上限，请新建运行。');
      const result = preparePlanningSpec(input.spec ?? run.spec, (run.sourceSnapshot ?? project.source).content, run.specQuestions, input.answers ?? {});
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
      delete run.engineeringPlan;
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
      let tasks = validatePlanningTasks(run.spec, input.tasks);
      let engineeringPlan = run.engineeringPlan;
      if (engineeringPlan) ({ tasks, engineeringPlan } = reviseEngineeringTasks(run, tasks));
      const architecture = engineeringPlan ? { name: 'architecture.md', title: titles['architecture.md'], stageId: 'architecture', content: renderEngineeringArchitecture(engineeringPlan), createdAt: now } : null;
      const revisionRun = architecture ? { ...run, artifacts: run.artifacts.map(item => item.name === 'architecture.md' ? architecture : item) } : run;
      const revision = planningRevision(revisionRun, tasks, engineeringPlan);
      if (revision === run.planRevision) throw new HttpError(409, '任务计划内容未变化，请作出实际修订。');
      if (run.revisionHistory.plan.some(item => item.revision === revision)) throw new HttpError(409, '不能恢复为旧计划版本，请保留本次修订依据。');
      const artifact = { name: 'task.md', title: titles['task.md'], stageId: 'tasks', content: engineeringPlan ? renderEngineeringTasks(this.planner, run.spec, tasks) : this.planner.renderTasks(run.spec, tasks), createdAt: now };
      run.revisionHistory.plan.push(this.snapshot(run, 'plan'));
      run.tasks = tasks; run.planRevision = revision; run.planVersion++;
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
    for (const entry of this.engineering.values()) entry.controller.abort();
    await Promise.allSettled([...this.checkpointWork]);
    await Promise.allSettled([...this.runtime.values()].flatMap(state => [...state.active.values()]));
    await this.store.flush();
  }
}
