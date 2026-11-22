import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './documents.mjs';
import { describeExecutionSubject } from './team-access.mjs';
import { repeatedCounterSteps } from '../public/verification-draft.js';
import { missingObservableBrowserRequirements } from './verification-browser-coverage.mjs';

export const AUTOMATIC_BUDGET = Object.freeze({ specificationMaxCalls: 4, engineeringMaxCalls: 5, verificationMaxAttempts: 3 });
const ACTIVE = new Set(['queued', 'running', 'needs_clarification']);
const APPROVAL = '依据启动时授权自动核对并确认当前版本。';
const INCOMPLETE_SOURCE = new Set(['no_requirements_or_questions', 'too_many_requirements']);
const REPAIRABLE_RESPONSE = new Set(['invalid_model_response', 'abnormal_finish']);
const UNSETTLED = new Set(['generating', 'cancel_requested']);
const CHECKING = new Set(['self_check', 'testing', 'review']);
const ENGINEERING = new Set(['architecture', 'tasks']);
const VERIFICATION_REWORK_ATTEMPTS = 3;
const UUID = /^[0-9a-f-]{36}$/u;

export function createAutomaticDelivery({ store, orchestrator, verification, planned, recovery, getSettingsRevision, getSettingsFingerprint, restoreSubject, preflight, checkProject, intervalMs = 300 }) {
  const jobs = new Map();
  const available = [verification?.propose, verification?.approve, planned?.start].every(method => typeof method === 'function');
  const authorizations = path.join(store.directory, 'automatic-delivery');
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
    if (getSettingsRevision() !== run.automaticDelivery.settingsRevision
      || getSettingsFingerprint(run.automaticDelivery.authorizationId) !== job.settingsFingerprint) {
      throw new HttpError(409, 'Agent 服务配置已变化，自动运行已停止派发。请核对配置后重新启动。');
    }
  }

  function sourceBinding(run) {
    return { projectId: run.projectId, runId: run.id, sourceRevision: run.sourceRevision, sourceGeneration: run.sourceGeneration ?? 0 };
  }

  function matches(binding, actual) {
    return !!actual && Object.entries(binding).every(([key, value]) => actual[key] === value);
  }

  async function saveAuthorization(run, subject, authorizationId, settingsRevision, settingsFingerprint) {
    const authorization = { authorizationId, ...sourceBinding(run), settingsRevision, settingsFingerprint, subject: describeExecutionSubject(subject) };
    await mkdir(authorizations, { recursive: true, mode: 0o700 });
    await writeFile(path.join(authorizations, `${authorizationId}.json`), JSON.stringify(authorization), { flag: 'wx', mode: 0o600, flush: true });
  }

  async function recoverAuthorization(run) {
    const { authorizationId, settingsRevision } = run.automaticDelivery;
    if (!UUID.test(authorizationId) || settingsRevision !== getSettingsRevision()) throw new HttpError(409, '原用量授权或 Agent 设置版本已变化。');
    const file = path.join(authorizations, `${authorizationId}.json`);
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new HttpError(409, '原用量授权无法核对。');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const settingsFingerprint = getSettingsFingerprint(authorizationId);
    if (!matches({ ...sourceBinding(run), authorizationId, settingsRevision, settingsFingerprint }, saved)) throw new HttpError(409, '原用量授权与当前运行不匹配。');
    return { subject: restoreSubject(saved.subject), settingsFingerprint };
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
    if (!row) return publish(project, run, { status: 'interrupted', usageUncertain: true, message: '无法核对已启动的开发记录及模型用量，已停止后续派发。' });
    const stage = (row.workflow?.stage ? CHECKING.has(row.workflow.stage) : row.candidateCommit) ? 'testing' : 'coding';
    if (row.accepted && row.actions?.canDownload) {
      return publish(project, run, { stage: 'delivery', status: 'completed', candidateCommit: row.candidateCommit, message: '当前版本通过独立测试和代码审查，可下载源码。' });
    }
    if (row.status === 'reconciliation_required') {
      return publish(project, run, { stage, status: 'interrupted', usageUncertain: true, message: row.checkpoint?.message || '开发进程或回执尚待核对，模型用量可能未知。' });
    }
    if (!row.active && row.status !== 'restoring_delivery') {
      return publish(project, run, { stage, status: 'failed', message: row.failureHelp?.detail || row.error || row.checkpoint?.message || '当前候选未达到源码交付条件，请查看执行证据。' });
    }
    const message = row.workflow?.stage === 'review' ? '正在独立审查当前候选。'
      : stage === 'testing' ? '正在检查当前候选，失败时自动返工并复验。'
        : '正在准备或编写代码，候选固定后自动验收。';
    return publish(project, run, { stage, status: 'running', message });
  }

  function planBinding(run) {
    return { ...sourceBinding(run), specRevision: run.specRevision, planRevision: run.planRevision };
  }

  async function reconcileDispatch(project, run) {
    const intent = run.automaticDelivery.pendingDispatch;
    const ids = { projectId: project.id, runId: run.id };
    const development = intent.kind === 'development';
    if (['verification', 'development'].includes(intent.kind) && matches(planBinding(run), intent.binding) && Array.isArray(intent.priorIds)) {
      const rows = development ? (await planned.list(ids)).executions : (await verification.list(ids)).proposals;
      const prior = new Set(intent.priorIds), present = new Set(rows.map(row => row.id));
      const additions = rows.filter(row => !prior.has(row.id));
      const [row] = additions;
      // Each trusted service saves its row before starting model work. A new
      // row must be uniquely attributable to this dispatch and frozen binding.
      if ([...prior].every(id => present.has(id)) && additions.length === 1 && matches(ids, row) && (development
        ? row.proposalId === intent.proposalId && row.revision === intent.revision && (!row.binding || matches(intent.binding, row.binding))
        : row.origin === 'model' && matches(intent.binding, row.binding))) {
        return publish(project, run, { pendingDispatch: null, ...(development ? { executionId: row.id } : { proposalId: row.id }),
          message: development ? '已找到此前启动的开发记录，正在核对原执行。' : '已找到此前发起的验收清单，正在核对原请求。' });
      }
    }
    return interruptDispatch(project, run);
  }

  function interruptDispatch(project, run) {
    return publish(project, run, { status: 'interrupted', usageUncertain: true, message: '无法唯一核对此前派发及模型用量，已保留证据并停止自动重发。' });
  }

  async function dispatch(project, run, intent, changes, execute) {
    assertDispatch(run);
    await publish(project, run, { ...changes, pendingDispatch: intent });
    try { assertDispatch(run); }
    catch (error) {
      await publish(project, run, { pendingDispatch: null });
      throw error;
    }
    const reference = await execute();
    return publish(project, run, { ...reference, pendingDispatch: null });
  }

  async function prepareVerification(job, project, run) {
    const ids = { projectId: project.id, runId: run.id };
    const state = run.automaticDelivery;
    const rework = state.verificationRework;
    const additionalAttempts = rework?.additionalAttempts ?? 0;
    const result = await verification.list(ids, { additionalAttempts });
    const { capabilities, proposals } = result;
    const draft = proposals.find(item => item.id === state.proposalId && item.current && ['draft', 'approved'].includes(item.status));
    const latest = proposals.find(item => item.id === state.proposalId);
    if (state.savedDefinitionResume && (draft?.id !== state.savedDefinitionResume.id || draft?.revision !== state.savedDefinitionResume.revision
      || !usableDefinition(draft, run))) throw new HttpError(409, '已保存验收清单的版本或批准资格变化，需要重新核对。');
    if (UNSETTLED.has(latest?.status)) return;
    if (latest?.status === 'reconciliation_required') {
      return publish(project, run, { status: 'interrupted', usageUncertain: true, message: '测试模型请求或回执待核对，模型用量可能未知。已停止后续派发。' });
    }

    // Reuse the workbench's trusted deterministic repairs. No unchecked
    // response or repaired assertion can go straight to the executor.
    let diagnostic;
    if (latest && (latest.status === 'failed' || repeatedCounterSteps(draft?.proposal).length)) {
      const identity = { ...ids, proposalId: latest.id };
      const saved = await recovery.read(identity).catch(error => {
        if (error.status !== 409) throw error;
        return null;
      });
      diagnostic = saved?.diagnostic;
      if (diagnostic?.suggestedRepair) {
        const normal = additionalAttempts ? await verification.list(ids) : result;
        const { proposal } = await orchestrator.withProjectCheckpoint(project.id, () => recovery.save(identity,
          { contractRevision: normal.capabilities.contractRevision }, {
            checkAccess: () => assertDispatch(run), importDefinition: input => verification.importDefinition(input), list: input => verification.list(input),
          }));
        return publish(project, run, { proposalId: proposal.id, message: '已修复可确定的清单问题，正在重新核对覆盖。' });
      }
    }
    const missingBrowser = missingObservableBrowserRequirements(draft?.proposal, run.engineeringPlan?.proposal.views);
    if (!draft?.proposal?.browser || missingBrowser.length || repeatedCounterSteps(draft.proposal).length) {
      const modelAttempts = proposals.filter(item => item.origin === 'model').length;
      if (!capabilities.canPropose || modelAttempts >= (rework?.attemptLimit ?? AUTOMATIC_BUDGET.verificationMaxAttempts)) {
        const missing = diagnostic?.missing?.map(item => item.id).slice(0, 12).join('、');
        const browserIds = draft?.proposal?.browser ? missingBrowser.slice(0, 12).join('、') : '';
        throw new HttpError(409, latest ? `验收清单未通过校验。${diagnostic?.message ?? ''}${missing ? `缺少接口检查：${missing}。` : ''}${browserIds ? `缺少浏览器结果断言：${browserIds}。` : ''}` : capabilities.reason || '验收清单服务当前不可用。');
      }
      const priorModel = proposals.findLast(item => item.origin === 'model');
      const previousProposalId = priorModel && ['failed', 'timed_out', 'draft'].includes(priorModel.status) ? priorModel.id : undefined;
      return dispatch(project, run, { kind: 'verification', binding: planBinding(run), priorIds: proposals.map(item => item.id) }, {
        message: previousProposalId ? '正在把上一轮校验问题反馈给测试 Agent，并核对修订后的清单。' : '正在生成并核对独立验收清单。',
      }, async () => {
        const { proposal } = await verification.propose({ ...ids, contractRevision: capabilities.contractRevision },
          { additionalAttempts, ...(previousProposalId ? { previousProposalId } : {}) });
        return { proposalId: proposal.id };
      });
    }
    if (!draft.approved) {
      assertDispatch(run);
      await verification.approve({ ...ids, proposalId: draft.id, revision: draft.revision, feedback: APPROVAL });
      return;
    }

    const { capabilities: admission, executions } = await planned.list(ids);
    if (executions.some(row => row.proposalId === draft.id && row.revision === draft.revision)) {
      throw new HttpError(409, '同版清单已有开发记录，已停止自动重复派发。');
    }
    if (!admission.canStart || !admission.supportedProposalIds?.includes(draft.id)) {
      throw new HttpError(409, admission.reason || '已确认清单无法启动开发，请检查执行配置。');
    }
    return dispatch(project, run, { kind: 'development', binding: planBinding(run), priorIds: executions.map(item => item.id),
      proposalId: draft.id, revision: draft.revision }, { stage: 'coding', message: '已固定当前验收清单，正在启动开发。' }, async () => {
      const { execution } = await planned.start({ ...ids, proposalId: draft.id, revision: draft.revision, contractRevision: admission.contractRevision }, { subject: job.subject });
      return { executionId: execution.id };
    });
  }

  function usableDefinition(draft, run) {
    return !!(draft?.current && (draft.approved || draft.actions?.canApprove) && draft.proposal?.browser
      && !missingObservableBrowserRequirements(draft.proposal, run.engineeringPlan?.proposal.views).length
      && !repeatedCounterSteps(draft.proposal).length);
  }

  function canReturnToVerification(project, run) {
    const state = run.automaticDelivery;
    return !!(state && state.status === 'failed' && (state.stage === 'verification' || state.executionId)
      && (!state.savedDefinitionResume || state.savedDefinitionResume.planRevision !== run.planRevision)
      && run.status === 'succeeded' && run.planRevision
      && !jobs.has(project.id) && !orchestrator.sourceSuperseded(project, run));
  }

  function canReplaceDevelopment(executions, previous, run) {
    if (executions.some(row => row.active || row.current)) return false;
    if (!previous.executionId) return executions.length === 0;
    const old = executions.find(row => row.id === previous.executionId);
    return !!(old?.binding?.planRevision && old.binding.planRevision !== run.planRevision && old.status === 'failed');
  }

  async function resumePlanning(project, run, failed, action) {
    if (failed?.history?.at(-1)?.code !== 'service_restart') return false;
    const engineering = ENGINEERING.has(failed.id) && !run.engineeringPlan;
    const attempts = failed.id === 'spec' ? run.specificationHistory : engineering ? run.engineeringHistory : null;
    const attempt = attempts?.at(-1);
    if (attempt && failed.startedAt && attempt.startedAt >= failed.startedAt && attempt.requestState !== 'not_started') {
      // A completed response can be reused, but a lost or invalid response is
      // not a reason to silently charge again after a restart.
      if (attempt.requestState !== 'settled' || attempt.receiptState !== 'saved') {
        await publish(project, run, { status: 'interrupted', usageUncertain: attempt.requestState !== 'settled',
          message: attempt.requestState !== 'settled' ? '规划请求是否结束及用量待核对，未再次发送。' : '没有可继续核验的已保存规划响应，请查看本次用量与阶段记录。' });
        return true;
      }
      await action(engineering ? { action: 'revalidate_engineering' } : { action: 'revalidate_spec', attemptId: attempt.id });
    } else await action({ action: 'retry', stageId: failed.id });
    return true;
  }

  async function advance(job) {
    const { project, run } = store.getRun(job.projectId, job.runId);
    const { run: saved } = store.getPersistedRun(job.projectId, job.runId);
    if (orchestrator.sourceSuperseded(project, run)) throw new HttpError(409, '项目需求已换版，旧自动运行已结束。');
    if (run.automaticDelivery.executionId) return observeExecution(project, run);
    if (run.automaticDelivery.pendingDispatch) return reconcileDispatch(project, run);
    if (!job.subject) {
      const unknown = orchestrator.hasSpecificationWork(project.id) || run.automaticDelivery.stage === 'coding';
      return publish(project, run, { status: 'interrupted', ...(unknown ? { usageUncertain: true } : {}),
        message: unknown ? '无法核对原请求、用量或继续授权，已停止自动派发。' : '无法核对本次继续授权或 Agent 设置，历史已保留，请重新核对。' });
    }
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
    if (orchestrator.hasSpecificationWork(project.id)) {
      return publish(project, run, { status: 'interrupted', usageUncertain: true, message: '规划请求或回执待核对，模型用量可能未知。已停止后续派发。' });
    }
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
      if (await resumePlanning(project, run, failed, action)) return;
      if (failed?.id === 'spec') {
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
      return publish(project, run, { status: 'failed',
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
        if (run.automaticDelivery.pendingDispatch) {
          try { await reconcileDispatch(project, run); }
          catch (cause) {
            await interruptDispatch(project, run);
            console.error('[automatic-delivery]', cause.message);
          }
          return;
        }
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
      const authorizationId = randomUUID(), settingsFingerprint = getSettingsFingerprint(authorizationId);
      const job = { projectId, subject, settingsFingerprint };
      jobs.set(projectId, job);
      try {
        await checkProject(projectId);
        describeExecutionSubject(subject);
        preflight();
        if (settingsRevision !== getSettingsRevision()) throw new HttpError(409, 'Agent 服务配置已变化，请核对后重新启动。');
        const automaticDelivery = { status: 'queued', stage: 'spec', message: '已授权自动运行，等待整理规格。', authorizationId, settingsRevision, updatedAt: new Date().toISOString() };
        const run = await orchestrator.createRun(projectId, input, { automaticDelivery, budget: AUTOMATIC_BUDGET,
          saveAuthorization: run => saveAuthorization(run, subject, authorizationId, settingsRevision, settingsFingerprint) });
        job.runId = run.id;
        schedule(job, 0);
        return run;
      } catch (error) {
        jobs.delete(projectId);
        throw error;
      }
    },
    async retryVerification(projectId, runId, input, subject) {
      if (input.modelUsageConfirmed !== true) throw new HttpError(400, '请确认本次验收返工及后续开发的模型用量。');
      const ready = readiness();
      if (!ready.ready) throw new HttpError(409, ready.reason);
      const { project, run } = store.getRun(projectId, runId);
      const previous = run.automaticDelivery;
      if (!canReturnToVerification(project, run) || input.planRevision !== run.planRevision || input.updatedAt !== previous.updatedAt) {
        throw new HttpError(409, '验收状态或已确认计划版本已变化，请刷新。');
      }
      describeExecutionSubject(subject);
      const settingsRevision = getSettingsRevision();
      const authorizationId = randomUUID(), settingsFingerprint = getSettingsFingerprint(authorizationId);
      const job = { projectId, runId, subject, settingsFingerprint };
      jobs.set(projectId, job);
      try {
        await checkProject(projectId);
        const ids = { projectId, runId };
        const extra = previous.verificationRework || previous.executionId ? 0 : VERIFICATION_REWORK_ATTEMPTS;
        const { capabilities, proposals } = await verification.list(ids, { additionalAttempts: extra });
        const usable = proposals.findLast(item => usableDefinition(item, run));
        if (!usable && (!extra || !capabilities.canPropose)) throw new HttpError(409, '请先保存通过校验的联合验收清单。');
        const { executions } = await planned.list(ids);
        if (!canReplaceDevelopment(executions, previous, run)) throw new HttpError(409, '当前计划已有开发尝试，不能从清单重复派发。');
        const attemptLimit = proposals.filter(item => item.origin === 'model').length + VERIFICATION_REWORK_ATTEMPTS;
        const baseLimit = capabilities.budget.maxAttempts - VERIFICATION_REWORK_ATTEMPTS;
        const additionalAttempts = Math.min(VERIFICATION_REWORK_ATTEMPTS, Math.max(0, attemptLimit - baseLimit));
        const { run: saved } = store.getPersistedRun(projectId, runId);
        describeExecutionSubject(subject);
        if (closing || settingsRevision !== getSettingsRevision() || saved.planRevision !== input.planRevision
          || saved.automaticDelivery?.updatedAt !== input.updatedAt || orchestrator.sourceSuperseded(project, run)) {
          throw new HttpError(409, '项目或 Agent 配置已变化，请刷新后继续。');
        }
        await saveAuthorization(run, subject, authorizationId, settingsRevision, settingsFingerprint);
        await publish(project, run, { status: 'running', stage: 'verification', authorizationId, settingsRevision, proposalId: usable?.id ?? previous.proposalId,
          ...(previous.executionId ? { executionId: null, candidateCommit: null } : {}),
          ...(usable ? { message: '正在核对已保存的清单，随后进入开发。',
            savedDefinitionResume: { id: usable.id, revision: usable.revision, planRevision: run.planRevision } }
            : { message: '已保留确认过的规格和计划，正在返工验收清单。',
              verificationRework: { at: new Date().toISOString(), planRevision: input.planRevision, fromProposalId: previous.proposalId ?? null, attemptLimit, additionalAttempts } }) });
        schedule(job, 0);
        return status(project, run);
      } catch (error) {
        jobs.delete(projectId);
        throw error;
      }
    },
    async init() {
      for (const project of store.projects.values()) {
        for (const run of project.runs) {
          if (!ACTIVE.has(run.automaticDelivery?.status)) continue;
          if (available && !orchestrator.sourceSuperseded(project, run) && !jobs.has(project.id)) {
            const job = { projectId: project.id, runId: run.id, subject: null };
            if (!run.automaticDelivery.executionId) {
              try { Object.assign(job, await recoverAuthorization(run)); } catch { /* Missing or stale authorization cannot dispatch. */ }
            }
            jobs.set(project.id, job);
            schedule(job);
          } else {
            await publish(project, run, { status: 'interrupted', message: '工作台曾重启，历史记录已保留。可从当前规划阶段查看问题并继续处理。' });
          }
        }
      }
    },
    status,
    async shutdown() {
      closing = true;
      for (const job of jobs.values()) clearTimeout(job.timer);
      await Promise.allSettled([...jobs.values()].map(job => job.work));
    },
  };

  async function status(project, run) {
    const state = run.automaticDelivery;
    if (!state) return { enabled: false };
    const { authorizationId, pendingDispatch, settingsRevision, proposalAttempts, verificationRework, savedDefinitionResume, ...view } = state;
    let downloadAvailable = false;
    if (state.status === 'completed' && planned && !orchestrator.sourceSuperseded(project, run)) {
      const { executions } = await planned.list({ projectId: project.id, runId: run.id });
      downloadAvailable = executions.some(row => row.id === state.executionId && row.actions?.canDownload);
    }
    let retryVerification;
    if (canReturnToVerification(project, run) && readiness().ready) {
      const ids = { projectId: project.id, runId: run.id };
      const { proposals } = await verification.list(ids);
      if (proposals.some(item => usableDefinition(item, run))) {
        const { executions } = await planned.list(ids);
        if (canReplaceDevelopment(executions, state, run)) retryVerification = { maxAttempts: 0 };
      } else if (!verificationRework && !state.executionId && !savedDefinitionResume) retryVerification = { maxAttempts: VERIFICATION_REWORK_ATTEMPTS };
    }
    return { enabled: true, ...view, downloadAvailable, ...(retryVerification ? { retryVerification } : {}) };
  }
}
