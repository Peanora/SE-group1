import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './documents.mjs';
import { contentRevision, planningRevision, assertSpecApproval, validatePlanningTasks } from './planning-review.mjs';
import { validateTaskWriteConflicts } from './task-write-validation.mjs';
import { assertEngineeringAlignment } from './engineering-planner.mjs';

const active = new Set(['running', 'paused', 'awaiting_confirmation']);
const now = () => new Date().toISOString();
const need = (condition, message, status = 409) => { if (!condition) throw new HttpError(status, message); };
export const SIMULATION_NOTICE = '模拟执行：模拟完成不代表真实编码、测试通过或软件验收，不开放源码交付。';

/** Executor contract: execute({ task, attempt, failOnce, durationMs, signal }) -> { outcome, summary }.
 * Only the scheduler publishes state. Replacing this adapter does not confer real acceptance authority.
 */
export class SimulatedExecutor {
  async execute({ task, attempt, failOnce, durationMs, signal }) {
    await delay(durationMs, undefined, { signal });
    return { outcome: failOnce && attempt === 1 ? 'failed' : 'completed',
      summary: `模拟执行 ${task.id}：${failOnce && attempt === 1 ? '首次尝试注入失败' : '模拟结果已产生，未修改任何代码'}` };
  }
}

export class SimulatedTaskService {
  constructor(store, { executor = new SimulatedExecutor(), withCheckpoint = async (_id, work) => work(), assertControlAvailable = () => {} } = {}) {
    this.store = store; this.executor = executor; this.withCheckpoint = withCheckpoint;
    this.assertControlAvailable = assertControlAvailable;
    this.queues = new Map(); this.jobs = new Map(); this.halted = new Set(); this.closed = false;
  }
  hasActive(projectId) {
    return (this.store.get(projectId).simulations ?? []).some(run => active.has(run.status)) || this.halted.has(projectId);
  }
  assertIdle(projectId) { need(!this.hasActive(projectId), '该项目有活动模拟编排，请先完成运行；活动期间不能修改计划或应用需求变更。'); }
  async serial(projectId, work) {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work); this.queues.set(projectId, next);
    try { return await next; } finally { if (this.queues.get(projectId) === next) this.queues.delete(projectId); }
  }
  async save(project, before) {
    try { await this.store.save(project); }
    catch (error) {
      project.simulations = before; this.halted.add(project.id);
      throw new HttpError(503, '模拟记录保存失败，已停止该项目派发；请检查存储并重启核对。');
    }
  }
  async init() {
    for (const project of this.store.projects.values()) {
      const before = structuredClone(project.simulations ?? []); let changed = false;
      for (const run of project.simulations ?? []) if (active.has(run.status)) {
        changed = true; run.status = 'interrupted'; run.pauseRequested = true;
        for (const task of run.tasks) if (task.status === 'running') {
          const attempt = task.attempts.at(-1); attempt.status = 'interrupted'; attempt.finishedAt = now();
          attempt.summary = '服务重启中断，未确认模拟完成。';
          this.transition(task, 'failed', attempt.summary);
        }
        this.dependencies(run); this.event(run, '服务重启：模拟运行已中断，需人工继续或重试，未自动派发。');
      }
      if (changed) await this.save(project, before);
    }
    return this;
  }
  event(run, message) { run.updatedAt = now(); run.events.push({ sequence: run.events.length + 1, at: run.updatedAt, message }); }
  transition(task, status, reason) {
    if (task.status === status && task.reason === reason) return;
    task.status = status; task.reason = reason;
    task.history.push({ at: now(), status, reason, attempt: task.attempts.length });
  }
  binding(projectId, planningId) {
    const { project, run } = this.store.getPersistedRun(projectId, planningId);
    const live = this.store.getRun(projectId, planningId).run;
    need(!run.sourceSuperseded && !live.sourceSuperseded && contentRevision(project.source) === run.sourceRevision
      && (run.sourceGeneration ?? 0) === (project.sourceGeneration ?? 0), '旧需求版本的计划不能启动或继续模拟。');
    need(run.workflowVersion === 2 && run.status === 'succeeded' && run.review?.passed === true && !run.review.issues?.length, '请先完成当前计划的双确认及规划导出。');
    assertSpecApproval(run);
    need(run.approvals?.plan?.revision === run.planRevision && run.approvals.plan.specRevision === run.specRevision
      && planningRevision(run) === run.planRevision && live.planRevision === run.planRevision
      && contentRevision(live.tasks) === contentRevision(run.tasks), '当前计划尚未确认或版本已变化。');
    const tasks = validatePlanningTasks(run.spec, run.tasks);
    if (run.engineeringPlan) assertEngineeringAlignment(run);
    try { validateTaskWriteConflicts(tasks); } catch (error) { throw new HttpError(409, `模拟编排无法启动：${error.message}`); }
    return { projectId, planningId, sourceRevision: run.sourceRevision, sourceGeneration: run.sourceGeneration ?? 0,
      specRevision: run.specRevision, planRevision: run.planRevision, planVersion: run.planVersion, tasks, spec: run.spec };
  }
  current(run) {
    const binding = this.binding(run.projectId, run.planningId);
    need(['sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision'].every(key => binding[key] === run[key]), '模拟运行属于旧版本，只能查看历史。');
  }
  list(projectId, planningId) {
    this.store.getRun(projectId, planningId);
    return structuredClone((this.store.getPersistedProject(projectId).simulations ?? []).filter(run => run.planningId === planningId));
  }
  find(projectId, planningId, id) {
    const project = this.store.get(projectId), run = (project.simulations ?? []).find(item => item.id === id && item.planningId === planningId);
    need(run, '未找到该模拟运行。', 404); return { project, run };
  }
  async start(projectId, planningId, options = {}) {
    return this.serial(projectId, () => this.withCheckpoint(projectId, async () => {
      need(!this.closed && !this.halted.has(projectId), '模拟调度服务不可用。'); this.assertIdle(projectId);
      need(Object.keys(options).every(key => ['planRevision', 'concurrency', 'durationMs', 'failOnceIds', 'confirmationIds'].includes(key)), '模拟启动参数包含未知字段。', 400);
      const binding = this.binding(projectId, planningId), project = this.store.get(projectId);
      need(options.planRevision === binding.planRevision, '请核对当前计划版本后启动模拟。');
      const concurrency = options.concurrency ?? 2, durationMs = options.durationMs ?? 1200;
      need(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8 && Number.isInteger(durationMs) && durationMs >= 0 && durationMs <= 10000, '并发须为1至8，模拟时长须为0至10000毫秒。', 400);
      const ids = new Set(binding.tasks.map(task => task.id));
      for (const values of [options.failOnceIds ?? [], options.confirmationIds ?? []]) need(Array.isArray(values) && values.every(id => typeof id === 'string' && ids.has(id)) && new Set(values).size === values.length, '模拟选项包含未知或重复任务。', 400);
      const before = structuredClone(project.simulations ?? []);
      const run = { ...binding, id: randomUUID(), kind: 'simulation', notice: SIMULATION_NOTICE,
        realAcceptance: false, status: 'running', createdAt: now(), updatedAt: now(), pauseRequested: false,
        concurrency, durationMs, failOnceIds: options.failOnceIds ?? [], events: [],
        tasks: binding.tasks.map(definition => ({ id: definition.id, definition, status: 'pending', reason: '等待前置依赖。',
          requiresConfirmation: definition.requiresConfirmation === true || (options.confirmationIds ?? []).includes(definition.id), attempts: [], history: [] })) };
      for (const task of run.tasks) this.transition(task, 'pending', '模拟任务已创建，等待依赖检查。');
      this.dependencies(run); this.event(run, '已冻结已确认计划，启动独立模拟编排。');
      project.simulations ??= []; project.simulations.push(run); await this.save(project, before);
      this.schedule(projectId, run.id); return structuredClone(run);
    }));
  }
  dependencies(run) {
    const byId = new Map(run.tasks.map(task => [task.id, task]));
    // Iterate to propagate failures regardless of the input order.
    for (let pass = 0; pass < run.tasks.length; pass++) {
      let changed = false;
      for (const task of run.tasks) if (['pending', 'ready', 'blocked'].includes(task.status)) {
        const deps = task.definition.dependsOn.map(id => byId.get(id));
        const failed = deps.filter(dep => ['failed', 'blocked'].includes(dep.status));
        const waiting = deps.filter(dep => dep.status !== 'completed');
        const status = failed.length ? 'blocked' : waiting.length ? 'pending' : 'ready';
        const reason = failed.length ? `前置失败或阻塞：${failed.map(dep => dep.id).join('、')}`
          : waiting.length ? `等待前置模拟完成：${waiting.map(dep => dep.id).join('、')}` : '依赖已满足，可模拟执行。';
        if (task.status !== status || task.reason !== reason) { this.transition(task, status, reason); changed = true; }
      }
      if (!changed) break;
    }
  }
  summary(run) {
    if (run.pauseRequested) run.status = 'paused';
    else if (run.tasks.some(task => ['running', 'ready'].includes(task.status))) run.status = 'running';
    else if (run.tasks.some(task => task.status === 'awaiting_confirmation')) run.status = 'awaiting_confirmation';
    else if (run.tasks.every(task => task.status === 'completed')) run.status = 'completed';
    else run.status = 'failed';
  }
  schedule(projectId, id) {
    if (this.closed || this.halted.has(projectId)) return;
    queueMicrotask(() => this.serial(projectId, () => this.pump(projectId, id)).catch(error => { this.halted.add(projectId); console.error('[simulation]', error.message); }));
  }
  async pump(projectId, id) {
    if (this.closed || this.halted.has(projectId)) return;
    const project = this.store.get(projectId), run = project.simulations.find(item => item.id === id);
    if (!run || !['running', 'awaiting_confirmation', 'paused'].includes(run.status)) return;
    const before = structuredClone(project.simulations); this.current(run); this.dependencies(run);
    const launches = [];
    if (!run.pauseRequested) for (const task of run.tasks) {
      if (task.status !== 'ready') continue;
      if (run.tasks.filter(item => item.status === 'running').length >= run.concurrency) break;
      const attempt = { number: task.attempts.length + 1, status: 'running', startedAt: now(), finishedAt: null, summary: '', kind: 'simulation' };
      task.attempts.push(attempt); this.transition(task, 'running', '后端模拟执行器运行中。');
      this.event(run, `${task.id} 开始模拟尝试 ${attempt.number}`); launches.push({ taskId: task.id, number: attempt.number });
    }
    this.summary(run); await this.save(project, before);
    for (const launch of launches) this.launch(run, launch);
  }
  launch(run, { taskId, number }) {
    const controller = new AbortController(), key = `${run.id}/${taskId}/${number}`, task = run.tasks.find(item => item.id === taskId);
    const job = Promise.resolve().then(() => this.executor.execute({ task: structuredClone(task.definition), attempt: number,
      failOnce: run.failOnceIds.includes(taskId), durationMs: run.durationMs, signal: controller.signal }))
      .then(result => this.finish(run.projectId, run.id, taskId, number, result),
        () => this.finish(run.projectId, run.id, taskId, number, { outcome: 'failed', summary: '模拟执行器异常或中断，未模拟完成。' }))
      .catch(error => { this.halted.add(run.projectId); console.error('[simulation]', error.message); })
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, { controller, job });
  }
  async finish(projectId, id, taskId, number, result) {
    return this.serial(projectId, async () => {
      if (this.closed || this.halted.has(projectId)) return;
      const project = this.store.get(projectId), run = project.simulations.find(item => item.id === id);
      const task = run?.tasks.find(item => item.id === taskId);
      if (!task || task.status !== 'running' || task.attempts.length !== number) return;
      this.current(run); const before = structuredClone(project.simulations), attempt = task.attempts.at(-1);
      const valid = result && ['completed', 'failed'].includes(result.outcome) && typeof result.summary === 'string' && result.summary.length <= 5000;
      attempt.status = valid ? result.outcome : 'failed'; attempt.finishedAt = now();
      attempt.summary = valid ? result.summary : '模拟执行器返回无效结果，未模拟完成。';
      this.transition(task, attempt.status === 'failed' ? 'failed' : task.requiresConfirmation ? 'awaiting_confirmation' : 'completed',
        attempt.status === 'failed' ? attempt.summary : task.requiresConfirmation ? '模拟结果已产生，等待人工填写依据确认。' : '模拟完成，未进行真实软件验收。');
      this.event(run, `${taskId}：${task.reason}`); this.dependencies(run); this.summary(run);
      await this.save(project, before); this.schedule(projectId, id);
    });
  }
  async action(projectId, planningId, id, input) {
    return this.serial(projectId, async () => {
      need(!this.closed && !this.halted.has(projectId), '模拟调度服务不可用。');
      this.assertControlAvailable(projectId);
      need(input && Object.keys(input).every(key => ['action', 'taskId', 'attempt', 'reason'].includes(key)), '模拟操作包含未知字段。', 400);
      const { project, run } = this.find(projectId, planningId, id); this.current(run);
      need(!(project.simulations ?? []).some(item => item.id !== id && active.has(item.status)), '项目已有其他活动模拟运行。');
      const before = structuredClone(project.simulations), task = run.tasks.find(item => item.id === input.taskId);
      if (input.action === 'pause') {
        need(['running', 'awaiting_confirmation'].includes(run.status), '只有活动模拟运行可以暂停。');
        run.pauseRequested = true; this.event(run, '已请求阶段边界暂停；在途模拟允许结束，不再派发新任务。');
      } else if (input.action === 'resume') {
        need(['paused', 'interrupted'].includes(run.status), '只有暂停或中断运行可以继续。');
        run.pauseRequested = false; this.event(run, '人工继续模拟，重新检查依赖；失败任务仍须单独重试。');
      } else if (input.action === 'retry') {
        need(task?.status === 'failed', '只能重试失败任务，不能重做成功分支。');
        need(task.attempts.length < 50, '单任务已达到50次模拟尝试上限。');
        this.transition(task, 'pending', '人工请求重试；保留全部失败历史。'); this.event(run, `${task.id} 请求模拟重试`);
        if (run.status === 'interrupted') run.pauseRequested = false;
      } else if (input.action === 'confirm') {
        need(task?.status === 'awaiting_confirmation' && task.attempts.at(-1)?.status === 'completed'
          && input.attempt === task.attempts.length, '只能确认当前成功模拟尝试，失败或阻塞任务不能人工完成。');
        need(typeof input.reason === 'string' && !!input.reason.trim() && input.reason.length <= 5000, '请填写模拟结果的人工确认依据。', 400);
        task.attempts.at(-1).confirmation = { at: now(), reason: input.reason.trim(), attempt: input.attempt, planRevision: run.planRevision };
        this.transition(task, 'completed', '人工确认后的模拟完成，不代表真实验收。'); this.event(run, `${task.id} 人工确认模拟结果`);
      } else throw new HttpError(400, '不支持此模拟操作；没有普通完成或强制完成入口。');
      this.dependencies(run); this.summary(run); await this.save(project, before); this.schedule(projectId, id); return structuredClone(run);
    });
  }
  async shutdown() {
    this.closed = true;
    for (const { controller } of this.jobs.values()) controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(entry => entry.job));
    await Promise.allSettled(this.queues.values());
    // Persist explicit interruption rather than claiming in-flight tasks finished.
    await this.init();
  }
}
