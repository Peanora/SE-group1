import { HttpError } from './documents.mjs';
import { describeExecutionSubject } from './team-access.mjs';
import { repeatedCounterSteps } from '../public/verification-draft.js';

export const AUTOMATIC_BUDGET = Object.freeze({ specificationMaxCalls: 4, engineeringMaxCalls: 5, verificationMaxAttempts: 3 });
const ACTIVE = new Set(['queued', 'running', 'needs_clarification']);
const APPROVAL = '依据启动时授权自动核对并确认当前版本。';
const INCOMPLETE_SOURCE = new Set(['no_requirements_or_questions', 'too_many_requirements']);
const REPAIRABLE_RESPONSE = new Set(['invalid_model_response', 'abnormal_finish']);
const UNSETTLED = new Set(['generating', 'cancel_requested']);
const CHECKING = new Set(['self_check', 'testing', 'review']);

export function createAutomaticDelivery({ store, orchestrator, verification, planned, recovery, getSettingsRevision, preflight, checkProject, intervalMs = 300 }) {
  const jobs = new Map();
  const available = [verification?.propose, verification?.approve, planned?.start].every(method => typeof method === 'function');
  let closing = false;

  function readiness() {
    if (!available || closing) return { ready: false, reason: '当前工作台未开放自动交付。' };
    try { preflight(); return { ready: true }; }
    catch (error) { return { ready: false, reason: error.message }; }
  }

  function assertDispatch(run) {
    if (!run.automaticDelivery || !ACTIVE.has(run.automaticDelivery.status)) return;
    const job = jobs.get(run.projectId);
    if (closing || !job?.subject) throw new HttpError(409, '自动运行已中断，未派发新的模型请求。');
    describeExecutionSubject(job.subject);
    if (getSettingsRevision() !== run.automaticDelivery.settingsRevision) throw new HttpError(409, 'Agent 服务配置已变化，自动运行已停止派发。请核对配置后重新启动。');
  }

  async function publish(project, run, changes) {
    const state = run.automaticDelivery;
    if (Object.entries(changes).every(([key, value]) => state[key] === value)) return;
    const next = { ...state, ...changes, updatedAt: new Date().toISOString() };
    run.automaticDelivery = next;
    try { await store.save(project); }
    catch (cause) {
      run.automaticDelivery = { ...state, status: 'interrupted', message: '保存自动进度失败，已停止后续派发。请检查本地存储。' };
      throw cause;
    }
  }

  async function observeExecution(project, run) {
    const { executionId } = run.automaticDelivery, ids = { projectId: project.id, runId: run.id };
    const { executions } = await planned.list(ids);
    const row = executions.find(item => item.id === executionId);
    if (!row) throw new HttpError(409, '找不到已启动的开发记录，请保留现场核对。');
    const stage = (row.workflow?.stage ? CHECKING.has(row.workflow.stage) : row.candidateCommit) ? 'testing' : 'coding';
    if (row.accepted && row.actions?.canDownload) {
      return publish(project, run, { stage: 'delivery', status: 'completed', candidateCommit: row.candidateCommit, message: '当前版本通过独立测试和代码审查，可下载源码。' });
    }
    if (row.status === 'reconciliation_required') {
      return publish(project, run, { stage, status: 'interrupted', message: row.checkpoint?.message || '开发进程或回执尚待核对，已保留开发记录和用量。' });
    }
    if (!row.active && row.status !== 'restoring_delivery') {
      return publish(project, run, { stage, status: 'failed', message: row.failureHelp?.detail || row.error || row.checkpoint?.message || '当前候选未达到源码交付条件，请查看执行证据。' });
    }
    const message = row.workflow?.stage === 'review' ? '正在独立审查当前候选。'
      : stage === 'testing' ? '正在检查当前候选，失败时自动返工并复验。'
        : '正在准备或编写代码，候选固定后自动验收。';
    return publish(project, run, { stage, status: 'running', message });
  }

  async function prepareVerification(job, project, run) {
    const ids = { projectId: project.id, runId: run.id };
    const result = await verification.list(ids);
    const { capabilities, proposals } = result;
    const state = run.automaticDelivery;
    const draft = proposals.find(item => item.id === state.proposalId && item.current && ['draft', 'approved'].includes(item.status));
    const latest = proposals.find(item => item.id === state.proposalId);
    if (UNSETTLED.has(latest?.status)) return;
    if (latest?.status === 'reconciliation_required') {
      return publish(project, run, { status: 'interrupted', message: '测试模型请求或回执待核对，已停止后续派发。' });
    }

    // Reuse the workbench's trusted deterministic repairs. No unchecked
    // response or repaired assertion can go straight to the executor.
    if (latest && (latest.status === 'failed' || repeatedCounterSteps(draft?.proposal).length)) {
      const identity = { ...ids, proposalId: latest.id };
      const diagnostic = await recovery.read(identity).catch(error => {
        if (error.status !== 409) throw error;
        return null;
      });
      if (diagnostic?.diagnostic.suggestedRepair) {
        const { proposal } = await orchestrator.withProjectCheckpoint(project.id, () => recovery.save(identity,
          { contractRevision: capabilities.contractRevision }, {
            checkAccess: () => assertDispatch(run), importDefinition: input => verification.importDefinition(input), list: input => verification.list(input),
          }));
        return publish(project, run, { proposalId: proposal.id, message: '已修复可确定的清单问题，正在重新核对覆盖。' });
      }
    }
    if (!draft?.proposal?.browser || repeatedCounterSteps(draft.proposal).length) {
      if (!capabilities.canPropose || (state.proposalAttempts ?? 0) >= AUTOMATIC_BUDGET.verificationMaxAttempts) {
        throw new HttpError(409, latest ? '自动生成的验收清单未能满足接口和浏览器验收要求，请查看最后一次提案。' : capabilities.reason || '验收清单服务当前不可用。');
      }
      await publish(project, run, { proposalAttempts: (state.proposalAttempts ?? 0) + 1, message: '正在生成并核对独立验收清单。' });
      assertDispatch(run);
      const { proposal } = await verification.propose({ ...ids, contractRevision: capabilities.contractRevision });
      return publish(project, run, { proposalId: proposal.id });
    }
    if (!draft.approved) {
      assertDispatch(run);
      await verification.approve({ ...ids, proposalId: draft.id, revision: draft.revision, feedback: APPROVAL });
      return;
    }

    const { capabilities: admission } = await planned.list(ids);
    if (!admission.canStart || !admission.supportedProposalIds?.includes(draft.id)) {
      throw new HttpError(409, admission.reason || '已确认清单无法启动开发，请检查执行配置。');
    }
    await publish(project, run, { stage: 'coding', message: '已固定当前验收清单，正在启动开发。' });
    assertDispatch(run);
    const { execution } = await planned.start({ ...ids, proposalId: draft.id, revision: draft.revision, contractRevision: admission.contractRevision }, { subject: job.subject });
    return publish(project, run, { executionId: execution.id });
  }

  async function advance(job) {
    const { project, run } = store.getRun(job.projectId, job.runId);
    const { run: saved } = store.getPersistedRun(job.projectId, job.runId);
    if (orchestrator.sourceSuperseded(project, run)) throw new HttpError(409, '项目需求已换版，旧自动运行已结束。');
    if (run.automaticDelivery.executionId) return observeExecution(project, run);
    // Planner stages and user answers may still be committing their checkpoint.
    if (saved.status !== run.status || orchestrator.projectActions.has(project.id)) return;
    const action = input => orchestrator.action(project.id, run.id, input, { assertAccess: () => assertDispatch(run) });
    if (run.status === 'running') {
      const stage = run.approvals.plan ? 'plan-approval' : run.approvals.spec ? 'plan' : 'spec';
      const message = stage === 'spec' ? '正在整理需求和设计规格。'
        : stage === 'plan' ? '正在编排架构和开发任务。' : '正在固定已校验的开发计划。';
      return publish(project, run, { status: 'running', stage, message });
    }
    if (orchestrator.state(run).driving || orchestrator.state(run).active.size) return;
    if (run.status === 'awaiting_spec') {
      const clarification = run.spec?.clarificationRequired || run.specQuestions?.some(item => item.blocking && !item.answer.trim());
      if (clarification && orchestrator.specificationRemaining(run) === 0) throw new HttpError(409, '规格调用次数已用尽。请补充需求后重新启动。');
      if (clarification) return publish(project, run, { status: 'needs_clarification', stage: 'spec', message: '有业务问题需要补充，提交答复后会自动继续。' });
      await publish(project, run, { status: 'running', stage: 'spec-approval', message: '正在核对并确认规格版本。' });
      await action({ action: 'approve_spec', revision: run.specRevision, feedback: APPROVAL });
      return publish(project, run, { stage: 'plan', message: '正在编排架构和开发任务。' });
    }
    if (run.status === 'awaiting_review') {
      await publish(project, run, { status: 'running', stage: 'plan-approval', message: '正在核对并确认计划版本。' });
      await action({ action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision, feedback: APPROVAL });
      return;
    }
    if (run.status === 'succeeded') {
      if (run.automaticDelivery.stage === 'plan-approval') await publish(project, run, { status: 'running', stage: 'verification', message: '正在准备独立验收清单。' });
      assertDispatch(run);
      return prepareVerification(job, project, run);
    }
    if (run.status === 'failed') {
      const failed = run.stages.find(item => item.status === 'failed');
      if (failed?.id === 'spec' && !orchestrator.hasSpecificationWork(project.id)) {
        const attempt = run.specificationHistory?.at(-1);
        if (INCOMPLETE_SOURCE.has(attempt?.reason) && orchestrator.specificationRemaining(run) !== 0) {
          return publish(project, run, { status: 'needs_clarification', stage: 'spec', message: '现有需求需要补充业务范围或验收条件，提交答复后会自动继续。' });
        }
        if (attempt?.requestState === 'settled' && REPAIRABLE_RESPONSE.has(attempt.code) && orchestrator.specificationRemaining(run) !== 0) {
          const described = await orchestrator.describeRun(project, run);
          const input = described.specificationFailure?.canRevalidate ? { action: 'revalidate_spec' } : { action: 'retry', stageId: 'spec' };
          if (input.action === 'revalidate_spec') input.attemptId = attempt.id;
          await action(input);
          return;
        }
      }
      return publish(project, run, { status: orchestrator.hasSpecificationWork(project.id) ? 'interrupted' : 'failed',
        stage: failed && ['intake', 'spec'].includes(failed.id) ? 'spec' : 'plan', message: failed?.error || '规划未能通过校验，请查看失败记录。' });
    }
    return publish(project, run, { status: 'interrupted', message: '规划已暂停或中断，请查看当前记录。' });
  }

  function schedule(job, delay = intervalMs) {
    if (closing) return;
    job.timer = setTimeout(() => {
      job.work = advance(job).catch(async error => {
        if (closing) return;
        const { project, run } = store.getRun(job.projectId, job.runId);
        if (!ACTIVE.has(run.automaticDelivery.status)) return;
        await publish(project, run, { status: 'failed', message: error.status && error.status < 500 ? error.message : '自动运行出现服务错误，请查看服务端日志。' });
        if (!error.status || error.status >= 500) console.error('[automatic-delivery]', error.message);
      }).catch(error => console.error('[automatic-delivery]', error.message)).finally(() => {
        job.work = null;
        const live = store.projects.get(job.projectId)?.runs.find(item => item.id === job.runId);
        if (ACTIVE.has(live?.automaticDelivery?.status)) schedule(job);
        else jobs.delete(job.projectId);
      });
    }, delay);
    job.timer.unref();
  }

  return {
    available, readiness, assertDispatch,
    ownsProject: projectId => jobs.has(projectId),
    ownsRun: (projectId, runId) => jobs.get(projectId)?.runId === runId,
    async start(projectId, input, subject) {
      const consent = input.automaticDelivery;
      if (input.mode !== 'model' || input.failOnceStage || !consent || Object.keys(consent).length !== 1 || consent.modelUsageConfirmed !== true) {
        throw new HttpError(400, '自动交付需要模型模式及本次用量确认。');
      }
      const readinessState = readiness();
      if (!readinessState.ready) throw new HttpError(409, readinessState.reason);
      if (jobs.has(projectId)) throw new HttpError(409, '该项目已有自动交付运行。');
      describeExecutionSubject(subject);
      const settingsRevision = getSettingsRevision();
      const job = { projectId, subject };
      jobs.set(projectId, job);
      try {
        await checkProject(projectId);
        describeExecutionSubject(subject);
        preflight();
        if (settingsRevision !== getSettingsRevision()) throw new HttpError(409, 'Agent 服务配置已变化，请核对后重新启动。');
        const automaticDelivery = { status: 'queued', stage: 'spec', message: '已授权自动运行，等待整理规格。', settingsRevision, updatedAt: new Date().toISOString() };
        const run = await orchestrator.createRun(projectId, input, { automaticDelivery, budget: AUTOMATIC_BUDGET });
        job.runId = run.id;
        schedule(job, 0);
        return run;
      } catch (error) {
        jobs.delete(projectId);
        throw error;
      }
    },
    async init() {
      for (const project of store.projects.values()) {
        for (const run of project.runs) {
          if (!ACTIVE.has(run.automaticDelivery?.status)) continue;
          if (available && run.automaticDelivery.executionId && !orchestrator.sourceSuperseded(project, run) && !jobs.has(project.id)) {
            const job = { projectId: project.id, runId: run.id };
            jobs.set(project.id, job);
            schedule(job);
          } else {
            await publish(project, run, { status: 'interrupted', message: '工作台曾重启，历史记录已保留。可从当前规划阶段查看问题并继续处理。' });
          }
        }
      }
    },
    async status(project, run) {
      const state = run.automaticDelivery;
      if (!state) return { enabled: false };
      const { settingsRevision, proposalAttempts, ...view } = state;
      let downloadAvailable = false;
      if (state.status === 'completed' && planned && !orchestrator.sourceSuperseded(project, run)) {
        const { executions } = await planned.list({ projectId: project.id, runId: run.id });
        downloadAvailable = executions.some(row => row.id === state.executionId && row.actions?.canDownload);
      }
      return { enabled: true, ...view, downloadAvailable };
    },
    async shutdown() {
      closing = true;
      for (const job of jobs.values()) clearTimeout(job.timer);
      await Promise.allSettled([...jobs.values()].map(job => job.work));
    },
  };
}
