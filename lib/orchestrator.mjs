import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './documents.mjs';

export const WORKFLOW = [
  { id: 'intake', title: '读取需求文档', dependsOn: [] },
  { id: 'spec', title: '整理设计规格', dependsOn: ['intake'] },
  { id: 'architecture', title: '设计项目架构', dependsOn: ['spec'] },
  { id: 'tasks', title: '拆解开发任务', dependsOn: ['spec'] },
  { id: 'review', title: '检查依赖与覆盖', dependsOn: ['architecture', 'tasks'] },
  { id: 'export', title: '确认并导出文档', dependsOn: ['review'] },
];

const ACTIVE_STATUSES = new Set(['running', 'paused', 'awaiting_review']);
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
  constructor(store, planner, { stepDelayMs = 350, concurrency = 2 } = {}) {
    this.store = store;
    this.planner = planner;
    this.stepDelayMs = Math.max(0, Math.min(5000, Number(stepDelayMs) || 0));
    this.concurrency = concurrency;
    this.runtime = new Map();
    this.closed = false;
  }

  state(run) {
    if (!this.runtime.has(run.id)) this.runtime.set(run.id, { driving: false, active: new Map() });
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
        if (!['running', 'paused'].includes(run.status)) continue;
        changed = true;
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
      if (changed) await this.store.save(project);
    }
  }

  async createRun(projectId, { mode = 'local', failOnceStage } = {}) {
    if (this.closed) throw new HttpError(409, '服务正在停止，请稍后重试。');
    const project = this.store.get(projectId);
    if (project.runs.some(run => ACTIVE_STATUSES.has(run.status))) throw new HttpError(409, '该项目已有活动运行，请先完成或恢复它。');
    if (!['local', 'model'].includes(mode)) throw new HttpError(400, '请选择本地规则或模型模式。');
    if (mode === 'model' && !this.planner.getModelConfig().configured) throw new HttpError(400, '尚未配置模型，请在服务端 .env 设置模型地址、名称和密钥，或使用本地规则模式。');
    if (failOnceStage && !['architecture', 'tasks', 'review'].includes(failOnceStage)) throw new HttpError(400, '不支持该演示故障阶段。');
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(), projectId, mode, status: 'running', createdAt: now, updatedAt: now,
      stages: WORKFLOW.map(stage => ({ ...stage, dependsOn: [...stage.dependsOn], status: 'pending', attempt: 0, startedAt: null, finishedAt: null, error: null, history: [] })),
      spec: null, tasks: [], artifacts: [], events: [], review: null, feedback: '', approvedAt: null,
      simulation: failOnceStage ? { failOnceStage } : null,
    };
    addEvent(run, `已冻结需求快照，开始${mode === 'model' ? '模型' : '本地规则'}规划。`);
    if (failOnceStage) addEvent(run, '已启用演示故障：指定阶段首次尝试将失败，重试后正常执行。');
    project.runs.push(run);
    await this.store.save(project);
    this.schedule(project, run);
    return run;
  }

  schedule(project, run) {
    if (!this.closed) queueMicrotask(() => this.drive(project, run).catch(error => {
      run.status = 'failed';
      addEvent(run, `调度器无法继续：${error.message}`, null, 'error');
      this.store.save(project).catch(() => {});
    }));
  }

  async drive(project, run) {
    const state = this.state(run);
    if (state.driving || this.closed) return;
    state.driving = true;
    try {
      this.blockDependents(run);
      if (run.status === 'paused') {
        if (state.active.size === 0 && run.stages.some(stage => stage.status === 'failed')) {
          run.status = 'failed';
          addEvent(run, '暂停前启动的阶段执行失败，请查看错误并重试。', null, 'error');
          await this.store.save(project);
        }
        return;
      }
      if (run.status !== 'running') return;
      if (run.stages.every(stage => stage.status === 'succeeded')) {
        run.status = 'succeeded';
        addEvent(run, '文档已确认并导出，软件开发计划准备完成。', null, 'success');
        await this.store.save(project);
        return;
      }
      const ready = run.stages.filter(stage => stage.status === 'pending' && stage.dependsOn.every(id => run.stages.find(s => s.id === id)?.status === 'succeeded'));
      for (const stage of ready) {
        if (state.active.size >= this.concurrency) break;
        if (stage.id === 'export' && !run.approvedAt) {
          run.status = 'awaiting_review';
          addEvent(run, '计划检查完成，请审阅规格与 task.md，确认后导出文档包。');
          await this.store.save(project);
          return;
        }
        const promise = this.executeStage(project, run, stage).finally(() => {
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
        await this.store.save(project);
      }
    } finally { state.driving = false; }
  }

  async executeStage(project, run, stage) {
    stage.status = 'running';
    stage.attempt++;
    stage.startedAt = new Date().toISOString();
    stage.finishedAt = null;
    stage.error = null;
    addEvent(run, `${stage.title}开始，第 ${stage.attempt} 次尝试。`, stage.id);
    try {
      await this.store.save(project);
      if (this.stepDelayMs) await delay(this.stepDelayMs);
      if (run.simulation?.failOnceStage === stage.id && stage.attempt === 1) throw new Error('演示故障：本次尝试主动失败。可重试该阶段以观察分支保留与恢复。');
      const result = await this.performStage(project, run, stage);
      const now = new Date().toISOString();
      for (const [key, value] of Object.entries(result)) if (key !== 'artifacts') run[key] = value;
      for (const artifact of result.artifacts ?? []) {
        run.artifacts = run.artifacts.filter(existing => existing.name !== artifact.name);
        run.artifacts.push({ ...artifact, title: titles[artifact.name] ?? artifact.name, stageId: stage.id, createdAt: now });
      }
      stage.status = 'succeeded';
      stage.finishedAt = now;
      stage.history.push({ attempt: stage.attempt, status: 'succeeded', startedAt: stage.startedAt, finishedAt: now, error: null });
      addEvent(run, `${stage.title}完成${result.artifacts?.length ? `，生成 ${result.artifacts.map(a => a.name).join('、')}` : ''}。`, stage.id, 'success');
      await this.store.save(project);
    } catch (error) {
      stage.status = 'failed';
      stage.finishedAt = new Date().toISOString();
      stage.error = error.message || '阶段执行失败。';
      stage.history.push({ attempt: stage.attempt, status: 'failed', startedAt: stage.startedAt, finishedAt: stage.finishedAt, error: stage.error });
      addEvent(run, `${stage.title}失败：${stage.error}`, stage.id, 'error');
      this.blockDependents(run);
      await this.store.save(project);
    }
  }

  async performStage(project, run, stage) {
    const p = this.planner;
    switch (stage.id) {
      case 'intake':
        if (!project.source.content.trim()) throw new Error('需求正文为空。');
        addEvent(run, `读取 ${project.source.filename}，共 ${project.source.content.length} 字符；原始文本只作为需求数据处理。`, stage.id);
        return {};
      case 'spec': {
        const spec = run.mode === 'model' ? await p.analyzeWithModel(project.source.content, project.name) : p.analyzeRequirements(project.source.content, project.name);
        return { spec, artifacts: [{ name: 'spec.md', content: p.renderSpec(spec) }] };
      }
      case 'architecture': return { artifacts: [{ name: 'architecture.md', content: p.renderArchitecture(run.spec) }] };
      case 'tasks': {
        const tasks = p.generateTasks(run.spec);
        p.validateTaskGraph(tasks);
        return { tasks, artifacts: [{ name: 'task.md', content: p.renderTasks(run.spec, tasks) }] };
      }
      case 'review': {
        const review = p.reviewPlan(run.spec, run.tasks);
        if (!review.passed) throw new Error(`计划检查未通过：${review.issues.join('；')}`);
        return { review, artifacts: [{ name: 'review.md', content: p.renderReview(review) }] };
      }
      case 'export':
        return { artifacts: [
          { name: 'handoff.md', content: p.renderHandoff(run.spec, run.tasks, run.review, run.feedback) },
          { name: 'plan.json', content: JSON.stringify({ project: project.name, runId: run.id, sourceFilename: project.source.filename, mode: run.mode, spec: run.spec, tasks: run.tasks, review: run.review, feedback: run.feedback }, null, 2) },
        ] };
      default: throw new Error('未知工作流阶段。');
    }
  }

  async action(projectId, runId, input = {}) {
    const { project, run } = this.store.getRun(projectId, runId);
    const state = this.state(run);
    const action = input.action;
    if (action === 'pause') {
      if (run.status !== 'running') throw new HttpError(409, '只有执行中的运行可以暂停。');
      run.status = 'paused';
      addEvent(run, '已请求在阶段边界暂停；正在执行的阶段会先完成。');
    } else if (action === 'resume') {
      if (run.status !== 'paused') throw new HttpError(409, '只有暂停的运行可以继续。');
      run.status = 'running';
      addEvent(run, '继续执行待处理阶段。');
    } else if (action === 'approve') {
      if (run.status !== 'awaiting_review') throw new HttpError(409, '请等待计划检查完成后再确认导出。');
      if (input.feedback !== undefined && (typeof input.feedback !== 'string' || input.feedback.length > 5000)) throw new HttpError(400, '审阅意见必须是 5000 字符以内的文本。');
      run.feedback = input.feedback?.trim() ?? '';
      run.approvedAt = new Date().toISOString();
      run.status = 'running';
      addEvent(run, '用户已审阅并确认开发计划，开始导出文档。', null, 'success');
    } else if (action === 'retry') {
      if (run.status !== 'failed' || state.active.size) throw new HttpError(409, '请等待失败运行结束后重试。');
      const failed = run.stages.filter(stage => stage.status === 'failed' && (!input.stageId || stage.id === input.stageId));
      if (!failed.length) throw new HttpError(409, '所选阶段不是可重试的失败阶段。');
      const reset = descendants(run, failed.map(stage => stage.id));
      for (const stage of run.stages) if (reset.has(stage.id) && ['failed', 'blocked'].includes(stage.status)) {
        stage.status = 'pending'; stage.error = null; stage.startedAt = null; stage.finishedAt = null;
      }
      run.status = 'running';
      addEvent(run, `重试 ${failed.map(stage => stage.title).join('、')}，保留已成功阶段与历史日志。`);
    } else throw new HttpError(400, '不支持该操作。');
    await this.store.save(project);
    this.schedule(project, run);
    return run;
  }

  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.runtime.values()].flatMap(state => [...state.active.values()]));
    await this.store.flush();
  }
}
