import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { lstat, mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getModelConfig, snapshotModelControls } from './planner.mjs';
import { guardModelContent } from './model-content-guard.mjs';
import { createProjectCodeModel } from './project-code-model.mjs';
import { createProjectReviewModel } from './project-review-model.mjs';
import { startPlannedWebExecution, isPlannedWebTaskAccepted, isPlannedWebDeliveryAccepted, plannedExecutionPolicyHash, assertPlannedEvolutionAcceptance, PLANNED_EXECUTION_TIMEOUT_MS } from './planned-web-executor.mjs';
import { createPlannedCheckpoints } from './planned-checkpoint.mjs';
import { readProjectFiles } from './project-files.mjs';
import { verifyWebShell } from './web-delivery.mjs';
import { createPlannedDelivery } from './planned-delivery.mjs';
import { inspectPlannedSource, assertPlannedSource } from './planned-source.mjs';
import { createPlannedPreviews } from './planned-preview.mjs';
import { plannedCommandEvidence } from './planned-command-evidence.mjs';
import { plannedFailureHelp } from './planned-failure-help.mjs';
import { startPlannedTaskExecution, isPlannedTaskRunAccepted, plannedTaskIntegration, inspectPlannedTaskGraph } from './planned-task-executor.mjs';
import { inspectVerificationPlanning } from './verification-planning-service.mjs';
import { openPlannedWorkerStore } from './planned-worker-store.mjs';
import { createApprovedWorkerJob, workerHash, workerModelConfigRevision } from './planned-worker-contract.mjs';
import { launchPlannedWorker, attachPlannedWorker, launchResumedPlannedWorker } from './planned-worker-client.mjs';
import { verifyWorkerResult, verifyWorkerOutcome, verifyPausedWorkerCheckpoint, assertWorkerGenerationEvidence, verifyRetiredWorkerCancellation, assertVerifiedRetiredWorkerCancellation, confirmWorkerExit } from './planned-worker-seals.mjs';
import { createLocalExecutionSubject, describeExecutionSubject, assertExecutionSubjectCurrent } from './team-access.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const need = (value, status, code, message) => { if (!value) fail(status, code, message); };
const ID = /^[A-Za-z0-9_-]{1,128}$/u, HASH = /^[a-f0-9]{64}$/u;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// Serial tasks may share exact paths. Keep distinct spellings for the source validator.
const planWritablePaths = tasks => [...new Set(tasks.flatMap(task => task.writePaths ?? task.suggestedFiles))];
function input(raw, names) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.getOwnPropertySymbols(raw).length === 0, 400, 'invalid_input', '执行请求格式无效。');
  const own = Object.getOwnPropertyDescriptors(raw);
  need(Object.keys(own).length === names.length && names.every(key => own[key]?.enumerable && Object.hasOwn(own[key], 'value') && typeof own[key].value === 'string' && own[key].value), 400, 'invalid_input', '执行字段缺失或包含未授权字段。');
  const result = Object.fromEntries(names.map(key => [key, own[key].value]));
  for (const key of ['projectId', 'runId', 'executionId', 'proposalId']) if (result[key] !== undefined) need(ID.test(result[key]), 400, 'invalid_id', '执行编号无效。');
  return result;
}
async function rootDirectory(raw) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root, 500, 'invalid_root', '研发执行需要专用绝对目录。');
  const absolute = path.resolve(raw); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(current), current), 500, 'invalid_root', '执行目录及父链不能链接到别处。');
  }
  return absolute;
}

/** Single-controller planned development; no serialized client verdict or workspace is accepted. */
export async function createPlannedExecutionService({ rootDir, verificationService, getPlanningSync, withCheckpoint, config, getConfig, getReviewConfig, executable = process.env.EXECUTION_SANDBOX_EXE, timeoutMs = PLANNED_EXECUTION_TIMEOUT_MS, dependencies = {} } = {}) {
  need(typeof getPlanningSync === 'function' && typeof withCheckpoint === 'function', 500, 'invalid_config', '缺少当前规划或项目检查点。');
  need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= PLANNED_EXECUTION_TIMEOUT_MS, 500, 'invalid_config', '研发执行总时限无效。');
  const verifiedEntry = typeof verificationService?.withApprovedExecution === 'function' && typeof verificationService?.assertFrozenExecution === 'function';
  need(dependencies && Object.keys(dependencies).every(key => ['startExecution', 'createProvider', 'createReviewer', 'startPreviewRuntime', 'hasExternalActivity', 'requiresExecutionSubject'].includes(key) && typeof dependencies[key] === 'function'), 500, 'invalid_config', '内部执行适配器无效。');
  const useWorkers = !['startExecution', 'createProvider', 'createReviewer'].some(key => dependencies[key]);
  const root = await rootDirectory(rootDir), filename = path.join(root, 'planned.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { const stat = await lstat(filename + suffix); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && samePath(await realpath(filename + suffix), filename + suffix), 500, 'invalid_root', '执行数据库不可使用链接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  need([getConfig, getReviewConfig].every(value => value === undefined || typeof value === 'function'), 500, 'invalid_config', '模型配置入口无效。');
  const initialPublicConfig = getModelConfig(), initialConfig = structuredClone(config ?? { baseUrl: initialPublicConfig.baseUrl, model: initialPublicConfig.model, apiKey: process.env.LLM_API_KEY || '' });
  try { const controls = snapshotModelControls(initialConfig); Object.assign(initialConfig, { thinking: controls.thinking, jsonMode: controls.jsonMode }); } catch { /* Keep invalid controls visible as not-ready. */ }
  let workerReady = true;
  const modelSecrets = new Set();
  function modelSelection() {
    let settings = {}, reviewSettings = {}, ready = false;
    try {
      const freeze = value => {
        const supplied = structuredClone(value), controls = snapshotModelControls(supplied);
        const result = Object.freeze({ baseUrl: supplied.baseUrl, model: supplied.model, apiKey: supplied.apiKey ?? '', thinking: controls.thinking, jsonMode: controls.jsonMode });
        if (result.apiKey) modelSecrets.add(result.apiKey);
        return result;
      };
      settings = freeze(getConfig ? getConfig() : initialConfig);
      reviewSettings = getReviewConfig ? freeze(getReviewConfig()) : settings;
      ready = verifiedEntry && [settings, reviewSettings].every(value => {
        const url = new URL(value.baseUrl);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
          && typeof value.model === 'string' && !!value.model.trim() && value.model.length <= 200
          && ![...modelSecrets].some(key => guardModelContent(value.model, key, 1000).credentialResponse);
      }) && (!!getConfig || config !== undefined || initialPublicConfig.configured) && typeof executable === 'string' && path.isAbsolute(executable);
    } catch { /* Invalid configuration disables paid admission. */ }
    const rawModelName = typeof settings.model === 'string' && settings.model.length <= 200 ? settings.model : '';
    const displayModel = [...modelSecrets].some(key => guardModelContent(rawModelName, key, 1000).credentialResponse) ? '模型名称配置无效' : rawModelName;
    return { settings, reviewSettings, ready: ready && workerReady, displayModel,
      workerConfig: getReviewConfig ? { ...settings, reviewConfig: reviewSettings } : settings };
  }
  const standardBudget = Object.freeze({ maxCalls: 3, maxReviewCalls: 3, timeoutMs });
  const costEstimate = Object.freeze({ known: false, amount: null, currency: null, reason: '未配置模型单价；费用估算未知，实际调用和token用量单独记录。' });
  const reservationFor = budget => budget.attemptModelCalls ?? budget.maxCalls + budget.maxReviewCalls;
  const isTaskRun = record => record?.profileId === 'planned-task-run-v1';
  const frozenBudgetFor = definitions => {
    const taskLimit = Math.max(1, ...definitions.filter(item => item.current && item.approved && item.proposal?.browser)
      .map(item => item.proposal.taskScopes?.length ?? 1).filter(count => count >= 1 && count <= 8));
    return taskLimit <= 1 ? standardBudget : { ...standardBudget, taskLimit, maxConcurrency: 2, maxIntegrationReworks: 1, attemptModelCalls: taskLimit * 6 };
  };
  const admissionBudget = (row, definitions) => {
    if (!row) return frozenBudgetFor(definitions);
    // The ledger retains the approved task scope and model limits. Only a
    // new attempt takes the current time limit; existing rows keep theirs.
    const { maxAttempts, totalModelCalls, ...budget } = JSON.parse(row.budget);
    return { ...budget, timeoutMs };
  };
  const supportsDefinition = (item, budget, graphSupported = true) => item.current && item.approved && item.proposal?.browser && (item.proposal.taskScopes?.length ?? 1) <= (budget.taskLimit ?? 1)
    && ((item.proposal.taskScopes?.length ?? 1) <= 1 || graphSupported);
  const currentTaskContext = (projectId, runId) => {
    const snapshot = inspectVerificationPlanning(getPlanningSync(projectId, runId), projectId, runId);
    return { ...snapshot.context.task, requirements: structuredClone(snapshot.context.requirements), engineeringContract: snapshot.context.engineeringContract };
  };
  const contract = (budget, selected = modelSelection()) => {
    const publicSettings = value => ({ model: value.model ?? '', endpoint: typeof value.baseUrl === 'string' ? value.baseUrl.trim().replace(/\/+$/u, '') : '', thinking: value.thinking, jsonMode: value.jsonMode });
    return digest({ version: 'planned-execution-v3', policy: plannedExecutionPolicyHash, budget, coding: publicSettings(selected.settings), review: publicSettings(selected.reviewSettings), checkpointInstance: checkpoints?.instanceId ?? null });
  };
  const db = new DatabaseSync(filename), owner = randomUUID(), states = new Map(), manifests = new Map(), verifiedRecords = new Map(), deliveryRecords = new Map(), barriers = new Set();
  const restoredCheckpoints = new Map(), restorationErrors = new Map(), restoring = new Map(), observedWorkerStops = new Set(); let closed = false, closing = false, shutdownPromise;
  const restorationControllers = new Map(), attemptedRestorations = new Set(), rejectedArtifacts = new Set(), evidenceChecks = new Map();
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY,token TEXT,pid INTEGER);
    CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,proposal_id TEXT NOT NULL,definition_revision TEXT NOT NULL,owner TEXT NOT NULL,
      status TEXT NOT NULL,active INTEGER NOT NULL,control INTEGER NOT NULL,binding TEXT,budget TEXT NOT NULL,record TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_project ON executions(project_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS budgets(project_id TEXT,run_id TEXT,budget TEXT NOT NULL,attempts INTEGER NOT NULL,used_calls INTEGER NOT NULL,reserved_calls INTEGER NOT NULL,PRIMARY KEY(project_id,run_id));
    CREATE TABLE IF NOT EXISTS accepted_checkpoints(execution_id TEXT PRIMARY KEY,seal TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS worker_outbox(execution_id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,phase TEXT NOT NULL,
    grant_hash TEXT,settled INTEGER NOT NULL DEFAULT 0,result_hash TEXT);`);
  db.exec('CREATE TABLE IF NOT EXISTS checkpoint_restorations(execution_id TEXT PRIMARY KEY,status TEXT NOT NULL,details TEXT NOT NULL,at TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS cancellation_diagnostics(execution_id TEXT PRIMARY KEY,stage TEXT NOT NULL,code TEXT NOT NULL,at TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS artifact_checks(execution_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,owner TEXT NOT NULL,active INTEGER NOT NULL,status TEXT NOT NULL,details TEXT NOT NULL);');
  function transaction(work) { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  try { transaction(() => {
    const old = db.prepare('SELECT * FROM owner WHERE id=1').get(); let alive = false;
    if (old?.token) { try { process.kill(old.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } }
    need(!alive, 409, 'service_owned', '研发执行目录已有活动控制器。');
    db.prepare("UPDATE executions SET status='reconciliation_required',control=control+1 WHERE active=1 AND NOT EXISTS(SELECT 1 FROM worker_outbox w WHERE w.execution_id=executions.id)").run();
    db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid);
  }); } catch (error) { db.close(); throw error; }
  let checkpoints, previews, workerStore;
  try { checkpoints = await createPlannedCheckpoints({ rootDir: root, hasCheckpoints: !!db.prepare('SELECT 1 FROM accepted_checkpoints LIMIT 1').get() }); }
  catch (error) { db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); db.close(); throw error; }
  const owns = () => !closed && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner;
  const available = () => { need(owns() && !closing, 503, 'service_closed', '研发执行控制器正在停止或归属已失效。'); };
  const externalActivity = pid => { try { const value = dependencies.hasExternalActivity?.(pid); return !!value || !!value?.then; } catch { return true; } };
  const active = pid => !!db.prepare('SELECT 1 FROM executions WHERE project_id=? AND active=1').get(pid) || !!db.prepare('SELECT 1 FROM artifact_checks WHERE project_id=? AND active=1').get(pid) || !!previews?.hasActivity(pid) || externalActivity(pid);
  const select = id => db.prepare('SELECT * FROM executions WHERE id=?').get(id);
  const budgetRow = (pid, rid) => db.prepare('SELECT * FROM budgets WHERE project_id=? AND run_id=?').get(pid, rid);
  const rowFor = value => { const row = select(value.executionId); need(row?.project_id === value.projectId && row.run_id === value.runId, 404, 'not_found', '未找到该研发执行。'); return row; };
  function current(row) {
    if (!row.binding) return false;
    try {
      const binding = JSON.parse(row.binding), actual = verificationService.assertFrozenExecution({ projectId: row.project_id, runId: row.run_id, proposalId: row.proposal_id, revision: row.definition_revision });
      return ['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision', 'engineeringHash', 'contextHash', 'policyHash'].every(key => actual[key] === binding[key]);
    } catch { return false; }
  }
  function deliveryState(row) {
    const record = row.record ? JSON.parse(row.record) : null, manifest = manifests.get(row.id), isCurrent = current(row);
    const final = isTaskRun(record) ? record.integration : record, delivery = deliveryRecords.get(row.id) ?? verifiedRecords.get(row.id);
    const verified = verifiedRecords.get(row.id), accepted = isCurrent && row.status === 'accepted' && !row.active && !!manifest && !!verified
      && digest(verified) === digest(record) && isPlannedWebDeliveryAccepted({ record: delivery, manifest, checkpoint: restoredCheckpoints.get(row.id), executionId: row.id });
    return { record, manifest, isCurrent, final, delivery, verified, accepted };
  }
  function publicRow(row, definition, engineeringContract) {
    const { record, isCurrent, final, accepted } = deliveryState(row);
    const preview = previews?.read({ projectId: row.project_id, runId: row.run_id, executionId: row.id }) ?? null;
    const previewBusy = !!previews?.hasActivity(row.project_id);
    let workerSubjectCurrent = true;
    try { const intent = workerIntent(row.id); if (intent) { need(workerStore, 409, 'worker_unavailable', 'Worker尚不可核对。'); assertExecutionSubjectCurrent(workerStore.get(intent.job_id)?.authorization?.body?.subject); } } catch { workerSubjectCurrent = false; }
    const candidateReports = isTaskRun(record) ? (record.tasks ?? []).flatMap(task => [task.record, ...(task.history ?? [])]).filter(Boolean) : final ? [final] : [];
    const reviewReports = isTaskRun(record) ? (record.tasks ?? []).flatMap(task => [...(task.history ?? []), task.record]).filter(Boolean) : candidateReports;
    const reworks = candidateReports.flatMap(report => (report.events ?? []).filter(event => event.type === 'automatic_rework'));
    const lastRework = reworks.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    const liveReports = isTaskRun(record) ? (record.tasks ?? []).map(task => task.record).filter(report => report && !report.finishedAt) : candidateReports;
    const whole = liveReports.at(-1) ?? final;
    const version = whole?.versions?.at(-1), gate = version?.acceptance;
    const failureRecord = final?.versions?.length ? final : candidateReports.findLast(candidate => candidate.status === 'failed') ?? record;
    const failureHelp = plannedFailureHelp({ record: failureRecord && { ...failureRecord, status: row.status }, definition, engineeringContract });
    const workflow = { reworkCount: reworks.length + (record?.reworks?.length ?? 0), cause: lastRework?.cause ?? null,
      reviewPending: gate?.phase === 'review' && gate?.status === 'checking',
      testing: liveReports.some(report => report.status === 'validating'), selfCheck: liveReports.some(report => report.status === 'self_check'),
      errorCode: whole?.errorCode ?? null,
      stage: gate ? gate.phase === 'review' || gate.review?.status === 'completed' && gate.test?.status === 'passed' && gate.browser?.status === 'passed' ? 'review' : 'testing'
        : version?.selfCheck ? 'self_check' : 'coding' };
    return { id: row.id, projectId: row.project_id, runId: row.run_id, proposalId: row.proposal_id, revision: row.definition_revision,
      kind: 'planned_web', status: row.status, current: isCurrent, active: !!row.active, createdAt: row.created_at, updatedAt: row.updated_at,
      executionEngine: db.prepare('SELECT 1 FROM worker_outbox WHERE execution_id=?').get(row.id) ? 'persistent_worker' : 'in_process',
      recoverySupported: !!db.prepare('SELECT 1 FROM worker_outbox WHERE execution_id=?').get(row.id),
      budget: JSON.parse(row.budget), candidateCommit: final?.candidateCommit ?? null, baseCommit: final?.baseCommit ?? null, diff: final?.diff ?? '',
      usage: row.status === 'reconciliation_required' ? { inputTokens: null, outputTokens: null } : record?.usage ?? { inputTokens: null, outputTokens: null }, totalModelCalls: record?.totalModelCalls ?? (row.status === 'reconciliation_required' ? null : 0),
      costEstimate,
      preview, commands: plannedCommandEvidence(record), workflow, ...(failureHelp ? { failureHelp } : {}),
      reviewHistory: reviewReports.flatMap(report => (report.versions ?? []).map(version => ({
        taskId: report.taskId ?? null, attemptId: report.attemptId ?? null, attempt: version.attempt ?? null,
        candidateCommit: version.commit, sourceHash: version.sourceHash,
        status: version.acceptance?.review?.status ?? 'not_started', summary: version.acceptance?.review?.summary ?? null,
        issues: version.acceptance?.issues ?? [], resolutions: version.acceptance?.review?.resolutions ?? [],
        errors: version.acceptance?.errors ?? [], error: version.acceptance?.review?.error ?? null,
        diagnostic: version.acceptance?.review?.diagnostic ?? null,
      }))),
      events: record?.events ?? [], error: record?.error ?? null, binding: row.binding ? JSON.parse(row.binding) : null,
      checks: final?.versions?.at(-1)?.acceptance ? { self: final.versions.at(-1).selfCheck?.checks ?? [],
        http: final.versions.at(-1).acceptance.test?.checks ?? [], browser: final.versions.at(-1).acceptance.browser?.checks ?? [],
        review: final.versions.at(-1).acceptance.review?.status ?? 'not_started', issues: final.versions.at(-1).acceptance.issues ?? [] } : null,
      executionMode: isTaskRun(record) ? 'task_dag' : 'whole_project', maxConcurrentTasks: record?.maxConcurrentTasks ?? null,
      tasks: isTaskRun(record) ? (Array.isArray(record.tasks) ? record.tasks : []).map(item => ({ id: item.id, title: item.title ?? item.id, dependsOn: item.dependsOn, status: item.status, baseCommit: item.baseCommit ?? null, candidateCommit: item.candidateCommit ?? null,
        attemptId: item.attemptId ?? null, stage: item.record?.status ?? null, error: item.record?.error ?? null, errorCode: item.record?.errorCode ?? null,
        diff: item.record?.diff ?? '', usage: item.record?.usage ?? { inputTokens: null, outputTokens: null },
        history: (item.history ?? []).map(past => ({ attemptId: past.attemptId, candidateCommit: past.candidateCommit, status: past.status, errorCode: past.errorCode ?? null,
          totalModelCalls: past.totalModelCalls, usage: past.usage, checks: past.versions?.at(-1)?.acceptance ? { http: past.versions.at(-1).acceptance.test?.checks ?? [],
            browser: past.versions.at(-1).acceptance.browser?.checks ?? [], review: past.versions.at(-1).acceptance.review?.status ?? null, issues: past.versions.at(-1).acceptance.issues ?? [] } : null })),
        checks: item.record?.versions?.at(-1)?.acceptance ? { http: item.record.versions.at(-1).acceptance.test?.checks ?? [], browser: item.record.versions.at(-1).acceptance.browser?.checks ?? [],
          review: item.record.versions.at(-1).acceptance.review?.status ?? null, issues: item.record.versions.at(-1).acceptance.issues ?? [] } : null })) : [],
      modelCalls: (record?.modelCalls ?? []).map(({ id, role, kind, attempt, model, usage, finishReason, receiptConfirmed, receiptHash, taskId, attemptId, candidateCommit, reviewRejection, startedAt, finishedAt }) => ({
        id, role, kind, attempt, model, usage, finishReason, receiptConfirmed, receiptHash, taskId, attemptId, candidateCommit, startedAt, finishedAt,
        ...(reviewRejection ? { reviewRejection: { version: reviewRejection.version, reason: reviewRejection.reason,
          field: reviewRejection.field, ...(reviewRejection.position !== undefined ? { position: reviewRejection.position } : {}) } } : {}),
      })),
      accepted,
      checkpoint: { sealed: !!db.prepare('SELECT 1 FROM accepted_checkpoints WHERE execution_id=?').get(row.id), restored: accepted && restoredCheckpoints.has(row.id),
        message: restorationErrors.get(row.id) ?? (accepted && restoredCheckpoints.has(row.id) ? '同版本历史验收资格已恢复；未重新执行测试或Review。' : '') },
      actions: { canCancel: states.has(row.id) && !!row.active && (row.status !== 'reconciliation_required' || workerIntent(row.id)?.phase === 'retirement_cancel_intent') && !db.prepare('SELECT 1 FROM artifact_checks WHERE project_id=? AND active=1').get(row.project_id),
        canRetryCancellation: states.has(row.id) && !!row.active && row.status === 'reconciliation_required' && workerIntent(row.id)?.phase === 'retirement_cancel_intent'
          && !db.prepare('SELECT 1 FROM artifact_checks WHERE project_id=? AND active=1').get(row.project_id),
        canRecover: !!workerIntent(row.id) && !!row.active && ['paused', 'paused_recovery_ready'].includes(row.status) && !states.get(row.id)?.recovering && isCurrent && workerSubjectCurrent,
        canPause: isTaskRun(record) && states.has(row.id) && (!states.get(row.id).worker || !!states.get(row.id).client && !states.get(row.id).recovering) && !!row.active && row.status === 'running',
        canResume: isTaskRun(record) && states.has(row.id) && (!states.get(row.id).worker || !!states.get(row.id).client && !states.get(row.id).recovering) && !!row.active && ['pause_requested', 'paused'].includes(row.status),
        canPreview: accepted && !active(row.project_id) && !barriers.has(row.project_id) && typeof executable === 'string' && path.isAbsolute(executable),
        canStopPreview: preview?.actions.canStop === true,
        canDownload: accepted && !previewBusy, canRepair: modelSelection().ready && isCurrent && !row.active && !active(row.project_id) && !barriers.has(row.project_id)
          && ['failed', 'stopped', 'timed_out', 'accepted'].includes(row.status) && record?.profileId === 'planned-web-v1' && record.providerKind === 'model'
          && failureHelp?.action !== 'review_checklist' && record.terminationConfirmed === true && record.versions?.length > 0 && typeof record.reportPath === 'string' } };
  }
  const workerIntent = id => db.prepare('SELECT * FROM worker_outbox WHERE execution_id=?').get(id);
  const workerInput = row => ({ projectId: row.project_id, runId: row.run_id, proposalId: row.proposal_id, revision: row.definition_revision,
    executionId: row.id, jobId: workerIntent(row.id).job_id });
  function workerAuthority(row) {
    need(typeof verificationService.workerExecution === 'function', 409, 'worker_authorization_unavailable', '当前服务无法恢复持久Worker审批。');
    const grant = verificationService.workerExecution(workerInput(row)); manifests.set(row.id, grant.manifest); return grant;
  }
  async function inspectWorkerEvidence({ record, graph }, grant, signal) {
    grant.assertCurrent(); available(); const paths = planWritablePaths(grant.task.tasks);
    const records = graph ? graph.tasks.flatMap(task => [...(task.history ?? []), task.record].filter(Boolean)) : [record];
    need(records.length > 0 && (!graph || graph.tasks.every(task => task.status === 'completed')), 409, 'worker_evidence_incomplete', '持久作业缺少完整任务历史。');
    for (const candidate of records) {
      grant.assertCurrent(); available();
      await inspectPlannedSource({ rootDir: root, reportPath: candidate.reportPath, expectedRecord: candidate,
        binding: { projectId: grant.binding.projectId, specRevision: grant.binding.specRevision, planRevision: grant.binding.planRevision }, writablePaths: paths, signal });
      grant.assertCurrent(); available();
    }
    return true;
  }
  async function acceptWorker(row, state, job) {
    const intent = workerIntent(row.id), grant = state.grant ??= workerAuthority(row), result = job.result;
    need(intent && intent.grant_hash === job.grant_hash && job.execution_id === row.id && result?.envelope && result.record?.status === 'accepted',
      409, 'worker_terminal_unconfirmed', '未取得该Worker可核验的完整签名终态，原预留保留。');
    const record = result.record, graph = result.graph, actual = graph ?? record;
    const args = { store: workerStore, jobId: job.id, envelope: result.envelope, record, graph, manifest: grant.manifest,
      assertCurrent: () => { available(); grant.assertCurrent(); need(current(select(row.id)), 409, 'stale_execution', 'Worker结果当前审批已失效。'); return true; },
      verifyEvidence: input => inspectWorkerEvidence(input, grant, state.controller.signal) };
    const permit = await verifyWorkerResult(args); args.assertCurrent();
    const acceptedRow = { ...select(row.id), status: 'accepted', active: 0 };
    const seal = await checkpoints.signWorker({ row: acceptedRow, record, executionRecord: graph, manifest: grant.manifest, permit, store: workerStore, jobId: job.id });
    args.assertCurrent(); const resultHash = workerHash(result.envelope), frozen = JSON.parse(row.budget);
    transaction(() => {
      const live = workerIntent(row.id); need(live?.grant_hash === job.grant_hash && (!live.result_hash || live.result_hash === resultHash), 409, 'worker_result_changed', '持久作业终态已变化。');
      if (!live.settled) {
        need(Number.isSafeInteger(actual.totalModelCalls) && actual.totalModelCalls <= reservationFor(frozen), 409, 'invalid_result', 'Worker总费用不符合原预留。');
        db.prepare('UPDATE budgets SET reserved_calls=reserved_calls-?,used_calls=used_calls+? WHERE project_id=? AND run_id=?').run(reservationFor(frozen), actual.totalModelCalls, row.project_id, row.run_id);
        db.prepare("UPDATE worker_outbox SET phase='settled',settled=1,result_hash=? WHERE execution_id=?").run(resultHash, row.id);
      }
      db.prepare("UPDATE executions SET status='accepted',active=0,owner=?,record=?,updated_at=? WHERE id=?").run(owner, JSON.stringify(actual), new Date().toISOString(), row.id);
      db.prepare('INSERT INTO accepted_checkpoints VALUES(?,?) ON CONFLICT(execution_id) DO UPDATE SET seal=excluded.seal').run(row.id, JSON.stringify(seal));
    });
    await verificationService.completeWorkerExecution(grant, { ...args, permit }); available();
    await workerStore.consumeResult(permit, args); available();
    const checkpoint = checkpoints.verifyWorker({ row: select(row.id), record, executionRecord: graph, seal, policyHash: plannedExecutionPolicyHash, manifest: grant.manifest });
    verifiedRecords.set(row.id, actual); deliveryRecords.set(row.id, record); restoredCheckpoints.set(row.id, checkpoint); restorationErrors.delete(row.id);
  }
  async function stopWorker(row, state, job) {
    const intent = workerIntent(row.id), grant = state.grant ??= workerAuthority(row), result = job.result;
    need(intent?.grant_hash === job.grant_hash && result?.outcome, 409, 'worker_terminal_unconfirmed', 'Worker停止尚缺少本次签名证明。');
    const record = result.record, graph = result.graph, actual = graph ?? record;
    const args = { store: workerStore, jobId: job.id, envelope: result.outcome, record, graph, manifest: grant.manifest,
      assertCurrent: () => { available(); grant.assertCurrent(); return true; },
      verifyEvidence: async () => {
        const records = graph ? graph.tasks.flatMap(task => [...(task.history ?? []), task.record].filter(Boolean)) : [record];
        for (const source of records) for (const call of source.modelCalls ?? []) if (call.receiptConfirmed) {
          grant.assertCurrent(); available(); const filename = path.join(path.dirname(source.reportPath), `model-${call.role}-${call.attempt}.json`), relative = path.relative(root, filename);
          need(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && filename === call.receiptPath, 409, 'worker_receipt_changed', 'Worker停止回执来源无法核对。');
          let current = root;
          for (const component of path.dirname(relative).split(path.sep).filter(Boolean)) { current = path.join(current, component); const info = await lstat(current); need(info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(current), current), 409, 'worker_receipt_changed', 'Worker停止回执目录发生变化。'); grant.assertCurrent(); available(); }
          const info = await lstat(filename); need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 2 * 1024 * 1024, 409, 'worker_receipt_changed', 'Worker停止回执不是原始普通文件。');
          const bytes = await readFile(filename), after = await lstat(filename); grant.assertCurrent(); available();
          need(info.ino === after.ino && info.dev === after.dev && after.nlink === 1 && !after.isSymbolicLink() && createHash('sha256').update(bytes).digest('hex') === call.receiptHash, 409, 'worker_receipt_changed', 'Worker停止回执指纹已变化。');
          const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          need(receipt.model === call.model && receipt.finishReason === call.finishReason && workerHash(receipt.usage) === workerHash(call.usage), 409, 'worker_receipt_changed', 'Worker停止回执用量或身份不同。');
        }
        return true;
      } };
    const permit = await verifyWorkerOutcome(args); args.assertCurrent(); const resultHash = workerHash(result.outcome), frozen = JSON.parse(row.budget);
    transaction(() => {
      const live = workerIntent(row.id); need(live?.grant_hash === job.grant_hash && (!live.result_hash || live.result_hash === resultHash), 409, 'worker_result_changed', '持久停止结果已变化。');
      if (!live.settled) {
        need(actual.totalModelCalls <= reservationFor(frozen), 409, 'invalid_result', 'Worker停止用量超过原预算。');
        db.prepare('UPDATE budgets SET reserved_calls=reserved_calls-?,used_calls=used_calls+? WHERE project_id=? AND run_id=?').run(reservationFor(frozen), actual.totalModelCalls, row.project_id, row.run_id);
        db.prepare("UPDATE worker_outbox SET phase='settled',settled=1,result_hash=? WHERE execution_id=?").run(resultHash, row.id);
      }
      db.prepare('UPDATE executions SET status=?,active=0,owner=?,record=?,updated_at=? WHERE id=?').run(actual.status, owner, JSON.stringify(actual), new Date().toISOString(), row.id);
    });
    await verificationService.stopWorkerExecution(grant, { ...args, permit }); available(); await workerStore.consumeOutcome(permit, args); available(); restorationErrors.delete(row.id); observedWorkerStops.add(row.id);
  }
  async function readWorker(id, state) {
    if (state.recovering) return false;
    available(); let row = select(id); const intent = workerIntent(id), job = workerStore.get(intent.job_id);
    need(job && (!intent.grant_hash || job.grant_hash === intent.grant_hash) && job.execution_id === id, 409, 'worker_dispatch_unknown', 'Worker派发状态尚未确认，禁止自动重发。');
    if (intent.phase === 'retirement_cancelled' && intent.settled) {
      need(job.status === 'retirement_cancelled' && job.result?.retirementCancellation && workerHash(job.result.retirementCancellation) === intent.result_hash, 409, 'worker_cancel_unconfirmed', '历史退休费用结算尚未完整核对。'); observedWorkerStops.add(id); return true;
    }
    if (intent.phase === 'retirement_cancel_intent') {
      if (!state.cancelAttempted) { state.cancelAttempted = true; await finishRetiredCancellation(row, state, () => true); return true; }
      return false;
    }
    if (job.status === 'retired') {
      const handoff = workerStore.handoff(job.id, job.active_generation);
      need(handoff?.payload?.graph, 409, 'worker_retirement_unconfirmed', '尚未取得原任务退休检查点。');
      state.record = { ...handoff.payload.graph, status: 'paused_recovery_ready' };
      db.prepare("UPDATE executions SET status='paused_recovery_ready',record=?,owner=?,updated_at=? WHERE id=? AND active=1").run(JSON.stringify(state.record), owner, new Date().toISOString(), id); return false;
    }
    if (job.result && !job.result.envelope && !job.result.outcome) {
      const actual = job.result.graph ?? job.result.record;
      const record = actual?.projectId === row.project_id && actual?.runId === row.run_id ? { ...actual, status: 'reconciliation_required', terminationConfirmed: false,
        usage: { inputTokens: null, outputTokens: null } } : { status: 'reconciliation_required', terminationConfirmed: false, usage: { inputTokens: null, outputTokens: null } };
      state.record = record; db.prepare("UPDATE executions SET status='reconciliation_required',active=1,record=?,owner=?,updated_at=? WHERE id=?").run(JSON.stringify(record), owner, new Date().toISOString(), id);
      return false;
    }
    if (job.result) { if (job.result.envelope) await acceptWorker(row, state, job); else await stopWorker(row, state, job); return true; }
    state.grant ??= workerAuthority(row); state.grant.assertCurrent();
    if (!state.client) state.client = await attachPlannedWorker({ store: workerStore, jobId: job.id, controllerId: owner, heartbeat: false });
    const observed = await state.client.status(); available(); state.grant.assertCurrent();
    if (observed.job.result) { if (observed.job.result.envelope) await acceptWorker(row, state, observed.job); else await stopWorker(row, state, observed.job); return true; }
    need(observed.job.registration?.instanceId === job.registration?.instanceId, 409, 'worker_instance_changed', '原Worker身份无法确认。');
    const report = observed.snapshot;
    if (report) { state.record = report; db.prepare('UPDATE executions SET status=?,record=?,owner=?,updated_at=? WHERE id=? AND active=1').run(report.status, JSON.stringify(report), owner, new Date().toISOString(), id); }
    return false;
  }
  function observeWorker(id, state) {
    if (state.observing) return state.observing;
    state.observing = readWorker(id, state).finally(() => { state.observing = null; }); return state.observing;
  }
  function monitorWorker(id, state) {
    if (state.done) return state.done;
    state.done = (async () => {
      while (owns() && !closing && states.get(id) === state) {
        try { if (await observeWorker(id, state)) break; }
        catch {
          if (!owns() || closing) break;
          db.prepare("UPDATE executions SET status='reconciliation_required',active=1,owner=?,updated_at=? WHERE id=? AND active=1").run(owner, new Date().toISOString(), id);
          restorationErrors.set(id, '原Worker、授权或完整终态尚未核对；保留原作业和预算，不自动重新派发。');
        }
        await new Promise(resolve => { state.timer = setTimeout(resolve, 1000); state.wake = resolve; }); state.timer = null;
      }
    })().finally(async () => { try { await state.client?.detach(); } catch {} if (states.get(id) === state) states.delete(id); });
    return state.done;
  }
  function reconnectWorkers(projectId, runId) {
    if (!workerStore) return;
    for (const row of db.prepare('SELECT e.* FROM executions e JOIN worker_outbox w ON w.execution_id=e.id WHERE e.project_id=? AND e.run_id=?').all(projectId, runId)) {
      if (verifiedRecords.has(row.id) || observedWorkerStops.has(row.id) || states.has(row.id) || rejectedArtifacts.has(row.id)) continue;
      const state = { worker: true, client: null, grant: null, record: null, controller: new AbortController(), done: null, timer: null };
      states.set(row.id, state); void monitorWorker(row.id, state);
    }
  }
  async function list(raw) {
    const selected = modelSelection(), { ready, displayModel } = selected;
    const value = input(raw, ['projectId', 'runId']); available();
    const definitions = typeof verificationService?.list === 'function' ? await verificationService.list(value) : { proposals: [] }; available();
    let graphSupported = true;
    if ((definitions.proposals ?? []).some(item => item.current && item.approved && item.proposal?.taskScopes?.length >= 2)) {
      try { inspectPlannedTaskGraph(currentTaskContext(value.projectId, value.runId)); } catch { graphSupported = false; }
    }
    reconnectWorkers(value.projectId, value.runId);
    const row = budgetRow(value.projectId, value.runId), budget = admissionBudget(row, (definitions.proposals ?? []).filter(item => (item.proposal?.taskScopes?.length ?? 1) <= 1 || graphSupported));
    const records = db.prepare('SELECT * FROM executions WHERE project_id=? AND run_id=? ORDER BY created_at,id').all(value.projectId, value.runId);
    for (const record of records) if (record.status === 'accepted' && !record.active && !verifiedRecords.has(record.id) && !workerIntent(record.id)) await restore(record);
    available(); const busy = active(value.projectId) || barriers.has(value.projectId) || (budgetRow(value.projectId, value.runId)?.reserved_calls ?? 0) !== 0;
    const reportedDefinitions = new Map((definitions.proposals ?? []).map(item => [item.id, item]));
    let engineeringContract;
    if (records.some(record => record.status === 'failed')) {
      try { engineeringContract = currentTaskContext(value.projectId, value.runId).engineeringContract; } catch { /* Retain failure summaries for records with no current plan. */ }
    }
    const executions = db.prepare('SELECT * FROM executions WHERE project_id=? AND run_id=? ORDER BY created_at,id').all(value.projectId, value.runId)
      .map(entry => {
        const definition = reportedDefinitions.get(entry.proposal_id);
        return publicRow(entry, definition?.revision === entry.definition_revision ? definition.proposal : undefined, engineeringContract);
      });
    const supported = (definitions.proposals ?? []).filter(item => supportsDefinition(item, budget, graphSupported));
    const usable = supported.filter(item => executions.findLast(execution => execution.current && execution.proposalId === item.id
      && execution.revision === item.revision)?.failureHelp?.action !== 'review_checklist');
    const checklistBlocked = supported.length > 0 && !usable.length;
    return { capabilities: { canStart: ready && checkpoints.available() && !busy && usable.length > 0,
      contractRevision: contract(budget, selected), model: { name: displayModel, reviewName: selected.reviewSettings.model ?? '' }, costEstimate,
      budget: { ...budget, unlimited: true, maxAttempts: null, remainingAttempts: null, totalModelCalls: null, remainingModelCalls: null },
      supportedProposalIds: supported.map(item => item.id),
      reason: checklistBlocked ? '先补上测试账号的登录步骤，确认新清单后即可继续开发。' : !checkpoints.available() ? '本地交付凭据不可用，请恢复备份后重新启动；未开始模型请求。' : !ready ? '编码模型或隔离环境尚未配置。' : busy ? '同项目有执行、检查点或未知状态待核对。' : !usable.length ? !graphSupported ? '逐任务计划需要2至8项、统一基础程序和最终集成任务；请先调整并重新确认计划，没有开始收费执行。' : '必须先认可当前联合HTTP与浏览器验收定义。' : '当前联合验收定义已认可，可以开始开发。' }, executions };
  }
  async function restore(row) {
    if (workerIntent(row.id)) {
      let state = states.get(row.id);
      if (!state) { state = { worker: true, client: null, grant: null, record: null, controller: new AbortController(), done: null, timer: null }; states.set(row.id, state); }
      try { await observeWorker(row.id, state); }
      catch { restorationErrors.set(row.id, '持久Worker的原始审批、签名或源码尚未完整核对；未调用新模型。'); }
      return;
    }
    if (restoring.has(row.id)) return restoring.get(row.id);
    const work = (async () => {
      if (attemptedRestorations.has(row.id) || !current(row) || active(row.project_id) || barriers.has(row.project_id)) return;
      const saved = db.prepare('SELECT seal FROM accepted_checkpoints WHERE execution_id=?').get(row.id);
      if (!saved) { restorationErrors.set(row.id, '此历史记录未封存，不能仅凭JSON恢复交付。'); return; }
      if (!checkpoints.available()) { restorationErrors.set(row.id, '本地交付凭据不可用；未重新签署或更改历史记录。'); return; }
      const frozenRow = digest(row), frozenSeal = saved.seal, controller = new AbortController();
      restorationControllers.set(row.id, controller); attemptedRestorations.add(row.id); barriers.add(row.project_id); let occupied = false;
      try {
        await withCheckpoint(row.project_id, () => verificationService.withApprovedExecution({ projectId: row.project_id, runId: row.run_id, proposalId: row.proposal_id, revision: row.definition_revision }, async grant => {
          // Preparation only reads owned sources. A failed local check must not
          // turn into an unconfirmed remote request in the verifier lifecycle.
          let unknown = false;
          try {
            available(); grant.assertCurrent(); const record = JSON.parse(row.record), seal = JSON.parse(frozenSeal), final = isTaskRun(record) ? record.integration : record;
            const checkpoint = (seal.version === 3 ? checkpoints.verifyEvolution : checkpoints.verify)({ row, record: final, ...(isTaskRun(record) ? { executionRecord: record } : {}), seal, policyHash: plannedExecutionPolicyHash, manifest: grant.manifest });
            transaction(() => {
              need(!active(row.project_id) && digest(select(row.id)) === frozenRow && current(select(row.id)), 409, 'stale_checkpoint', '当前交付检查点已变化。');
              db.prepare("UPDATE executions SET status='restoring_delivery',active=1,control=control+1,owner=?,updated_at=? WHERE id=?").run(owner, new Date().toISOString(), row.id);
              db.prepare("INSERT INTO checkpoint_restorations VALUES(?,'checking','{}',?) ON CONFLICT(execution_id) DO UPDATE SET status=excluded.status,details=excluded.details,at=excluded.at").run(row.id, new Date().toISOString());
            });
            occupied = true; const pendingRow = digest(select(row.id));
            const paths = planWritablePaths(grant.task.tasks);
            await inspectPlannedSource({ rootDir: root, reportPath: final.reportPath, expectedRecord: final,
              binding: { projectId: row.project_id, specRevision: grant.binding.specRevision, planRevision: grant.binding.planRevision }, writablePaths: paths, signal: AbortSignal.any([grant.signal, controller.signal]) });
            available(); grant.assertCurrent(); need(digest(select(row.id)) === pendingRow
              && db.prepare('SELECT seal FROM accepted_checkpoints WHERE execution_id=?').get(row.id)?.seal === frozenSeal && current(select(row.id)), 409, 'stale_checkpoint', '恢复期间来源或记录已变化。');
            need(isPlannedWebDeliveryAccepted({ record: final, manifest: grant.manifest, checkpoint, executionId: row.id }), 409, 'invalid_checkpoint', '检查点不满足完整历史验收条件。');
            transaction(() => {
              need(digest(select(row.id)) === pendingRow && current(select(row.id)) && !closing, 409, 'stale_checkpoint', '恢复发布前当前状态已变化。');
              db.prepare("UPDATE executions SET status='accepted',active=0,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
              db.prepare("UPDATE checkpoint_restorations SET status='restored',details=?,at=? WHERE execution_id=?").run(JSON.stringify({ historicalAcceptance: true, newModelCalls: 0 }), new Date().toISOString(), row.id);
            });
            manifests.set(row.id, grant.manifest); verifiedRecords.set(row.id, record); deliveryRecords.set(row.id, final); restoredCheckpoints.set(row.id, checkpoint); restorationErrors.delete(row.id);
          } catch (error) {
            unknown = error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false;
            restorationErrors.set(row.id, unknown ? '交付核对进程停止尚未确认，项目保持待协调；未调用模型。' : '未能核对来源、封签、代码、回执或策略；本次会话保持历史只读，修复后重启再核对，未调用模型。');
            if (occupied && owns()) transaction(() => {
              db.prepare('UPDATE executions SET status=?,active=?,updated_at=? WHERE id=? AND owner=?').run(unknown ? 'reconciliation_required' : 'accepted', unknown ? 1 : 0, new Date().toISOString(), row.id, owner);
              db.prepare('UPDATE checkpoint_restorations SET status=?,details=?,at=? WHERE execution_id=?').run(unknown ? 'reconciliation_required' : 'rejected', JSON.stringify({ newModelCalls: 0, ...(error?.result ? { process: error.result } : {}) }), new Date().toISOString(), row.id);
            });
          }
          return { terminationConfirmed: !unknown };
        }));
      } catch { restorationErrors.set(row.id, '当前项目或批准定义尚不允许恢复交付；未调用模型。'); if (!occupied) attemptedRestorations.delete(row.id); }
      finally { barriers.delete(row.project_id); restorationControllers.delete(row.id); }
    })();
    restoring.set(row.id, work); try { await work; } finally { if (restoring.get(row.id) === work) restoring.delete(row.id); }
  }
  async function finish(id, record) {
    const row = select(id); if (!owns() || row?.owner !== owner) return;
    const state = states.get(id), frozen = JSON.parse(row.budget), manifest = manifests.get(id);
    const same = record && record.id === state?.handle?.id && record.projectId === row.project_id && record.runId === row.run_id;
    const admissionOnly = !state?.handle && record?.kind === 'controller_admission';
    const countValid = same && Number.isSafeInteger(record.totalModelCalls) && record.totalModelCalls >= 0
      && record.totalModelCalls <= reservationFor(frozen) && Array.isArray(record.modelCalls)
      && record.modelCalls.every(item => item && ['coding', 'review'].includes(item.role) && ['model', 'trusted_fixture', 'diagnostic'].includes(item.kind))
      && record.modelCalls.filter(item => item.kind === 'model' && item.dispatched !== false).length === record.totalModelCalls;
    let status = same || admissionOnly ? record.status : 'failed';
    let qualified = false;
    try { if (record?.evolutionSource) { assertPlannedEvolutionAcceptance(record, manifest); qualified = true; } else qualified = isTaskRun(record) ? isPlannedTaskRunAccepted(record, manifest) : isPlannedWebTaskAccepted(record, manifest); } catch {}
    if (status === 'accepted' && (!current(row) || !manifest || !qualified)) status = 'failed';
    if (!['accepted', 'failed', 'stopped', 'timed_out', 'diagnostic_passed', 'reconciliation_required'].includes(status)) status = 'failed';
    const unknown = status === 'reconciliation_required' || !admissionOnly && (!same || record.terminationConfirmed !== true || !countValid);
    const stored = same || admissionOnly ? record : { kind: 'controller_result_unknown', status: 'reconciliation_required', terminationConfirmed: false,
      error: '未能核对本执行的结果归属、停止或用量；保留原预算预留，等待核对。' };
    transaction(() => {
      if (!owns() || select(id).owner !== owner) return;
      db.prepare('UPDATE executions SET status=?,active=?,record=?,updated_at=? WHERE id=?').run(unknown ? 'reconciliation_required' : status, unknown ? 1 : 0, JSON.stringify(stored), new Date().toISOString(), id);
      if (!unknown) {
        const calls = admissionOnly ? 0 : record.totalModelCalls;
        need(calls >= 0 && calls <= reservationFor(frozen), 409, 'invalid_result', '执行用量不符合冻结预算。');
        db.prepare('UPDATE budgets SET reserved_calls=reserved_calls-?,used_calls=used_calls+? WHERE project_id=? AND run_id=?').run(reservationFor(frozen), calls, row.project_id, row.run_id);
      }
      if (!unknown && status === 'accepted') {
        need(current(select(id)) && !closing, 409, 'stale_execution', '封存前当前批准已失效。');
        const final = isTaskRun(record) ? plannedTaskIntegration(record, manifest) : record;
        if (state.subjectDescriptor) assertExecutionSubjectCurrent(state.subjectDescriptor);
        const seal = (final.evolutionSource ? checkpoints.signEvolution : checkpoints.sign)({ row: select(id), record: final, ...(isTaskRun(record) ? { executionRecord: record } : {}), manifest });
        db.prepare('INSERT INTO accepted_checkpoints VALUES(?,?)').run(id, JSON.stringify(seal));
        if (final.evolutionSource) restoredCheckpoints.set(id, checkpoints.verifyEvolution({ row: select(id), record: final, manifest, seal, policyHash: plannedExecutionPolicyHash }));
      }
    });
    if (!unknown && status === 'accepted') { verifiedRecords.set(id, record); deliveryRecords.set(id, isTaskRun(record) ? plannedTaskIntegration(record, manifest) : record); }
  }
  async function start(raw, initialSource, options = {}) {
    const selected = modelSelection(), { settings, reviewSettings, workerConfig, ready } = selected;
    const value = input(raw, ['projectId', 'runId', 'proposalId', 'revision', 'contractRevision']); available();
    const subject = options.subject ?? createLocalExecutionSubject(), subjectDescriptor = describeExecutionSubject(subject);
    need(!dependencies.requiresExecutionSubject?.() || subjectDescriptor.kind === 'team', 403, 'execution_subject_required', '团队执行必须绑定当前真实启动者。');
    need(HASH.test(value.revision) && HASH.test(value.contractRevision), 400, 'invalid_revision', '请核对当前定义与执行预算。');
    const definitions = typeof verificationService?.list === 'function' ? await verificationService.list({ projectId: value.projectId, runId: value.runId }) : { proposals: [] };
    available(); need((definitions.proposals ?? []).some(item => item.id === value.proposalId && item.revision === value.revision && item.current && item.approved && item.proposal?.browser), 409, 'approval_required', '须先认可当前联合验收定义；未开始执行或占用尝试预算。');
    const selectedDefinition = (definitions.proposals ?? []).find(item => item.id === value.proposalId && item.revision === value.revision);
    const previous = db.prepare('SELECT * FROM executions WHERE project_id=? AND run_id=? AND proposal_id=? AND definition_revision=? ORDER BY created_at DESC,id DESC LIMIT 1')
      .get(value.projectId, value.runId, value.proposalId, value.revision);
    need(!previous || publicRow(previous, selectedDefinition.proposal).failureHelp?.action !== 'review_checklist',
      409, 'checklist_needs_revision', '验收清单漏了测试账号的登录步骤。请先准备清单修订，再开始开发。');
    if (options.createSeed) need((selectedDefinition.proposal.taskScopes?.length ?? 1) <= 1, 409, 'evolution_task_graph_unsupported', '数据演进当前仅支持整体联合验收，尚不支持多任务种子；没有占用模型预算。');
    if (selectedDefinition.proposal.taskScopes?.length >= 2) {
      try { inspectPlannedTaskGraph(currentTaskContext(value.projectId, value.runId)); }
      catch { fail(409, 'unsupported_task_graph', '逐任务计划需要2至8项、统一基础程序和最终集成任务；请先调整并重新确认计划，没有占用尝试或模型预算。'); }
    }
    need(ready && checkpoints.available() && !active(value.projectId) && !barriers.has(value.projectId), 409, 'not_ready', '模型、交付凭据、环境或项目状态尚不可执行。');
    assertExecutionSubjectCurrent(subjectDescriptor);
    const id = randomUUID(), now = new Date().toISOString(); let frozen;
    transaction(() => {
      const old = budgetRow(value.projectId, value.runId); frozen = admissionBudget(old, definitions.proposals ?? []);
      need(value.contractRevision === contract(frozen, selected), 409, 'contract_changed', '执行规则、模型或预算已变化，请重新核对。');
      need((definitions.proposals ?? []).some(item => item.id === value.proposalId && item.revision === value.revision && supportsDefinition(item, frozen)), 409, 'definition_budget_changed', '当前冻结预算不覆盖该任务图；请核对定义及新规划预算。');
      if (!old) db.prepare('INSERT INTO budgets VALUES(?,?,?,0,0,0)').run(value.projectId, value.runId, JSON.stringify(frozen));
      const reservation = reservationFor(frozen);
      need((old?.reserved_calls ?? 0) === 0, 409, 'reservation_pending', '上次执行的模型用量还在核对，请刷新进度。');
      db.prepare('UPDATE budgets SET attempts=attempts+1,reserved_calls=reserved_calls+? WHERE project_id=? AND run_id=?').run(reservation, value.projectId, value.runId);
      db.prepare("INSERT INTO executions VALUES(?,?,?,?,?,?,'reserved',1,1,NULL,?,NULL,?,?)").run(id, value.projectId, value.runId, value.proposalId, value.revision, owner, JSON.stringify(frozen), now, now);
      if (useWorkers && !initialSource && !options.createSeed) db.prepare("INSERT INTO worker_outbox(execution_id,job_id,phase) VALUES(?,?,'reserved')").run(id, id);
    });
    if (useWorkers && !initialSource && !options.createSeed) {
      const state = { worker: true, client: null, grant: null, record: null, controller: new AbortController(), done: null, timer: null, starting: null, modelSettings: workerConfig };
      states.set(id, state);
      state.starting = Promise.resolve().then(() => withCheckpoint(value.projectId, async () => {
        available(); const row = select(id), grant = state.grant = workerAuthority(row); grant.assertCurrent();
        db.prepare("UPDATE executions SET binding=?,status='preparing',updated_at=? WHERE id=?").run(JSON.stringify(grant.binding), new Date().toISOString(), id);
        const job = createApprovedWorkerJob({ manifest: grant.manifest, task: grant.task, binding: Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, grant.binding[key]])),
          jobId: id, executionId: id, proposalId: row.proposal_id, revision: row.definition_revision, contextHash: grant.binding.contextHash, engineeringHash: grant.binding.engineeringHash,
          sourceRevision: grant.binding.sourceRevision, sourceGeneration: grant.binding.sourceGeneration, rootIdentity: workerStore.identity,
          configRevision: workerModelConfigRevision(workerConfig), deadlineAt: Date.parse(row.created_at) + frozen.timeoutMs,
          budget: { maxCalls: frozen.maxCalls, maxReviewCalls: frozen.maxReviewCalls, maxConcurrency: frozen.maxConcurrency ?? 2 }, subject,
          assertCurrent: () => { assertExecutionSubjectCurrent(subjectDescriptor); return grant.assertCurrent(); } });
        const { describeApprovedWorkerJob } = await import('./planned-worker-contract.mjs'); grant.assertCurrent(); available();
        const grantHash = workerHash(describeApprovedWorkerJob(job));
        db.prepare("UPDATE worker_outbox SET phase='dispatch_intent',grant_hash=? WHERE execution_id=? AND phase='reserved'").run(grantHash, id);
        await launchPlannedWorker({ store: workerStore, job, config: workerConfig, executable });
        if (owns()) db.prepare("UPDATE worker_outbox SET phase='dispatched' WHERE execution_id=? AND phase='dispatch_intent'").run(id);
      })).catch(() => {
        if (owns()) {
          db.prepare("UPDATE executions SET status='reconciliation_required',active=1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
          restorationErrors.set(id, '持久作业的派发或审批状态尚未确认；原活动槽与预算保留，禁止自动重发。');
        }
      }).finally(() => { state.starting = null; if (owns() && !closing) void monitorWorker(id, state); });
      return { execution: publicRow(select(id)) };
    }
    const state = { handle: null, cancelled: false, done: null, prepareController: new AbortController(), seedAttempted: false, subjectDescriptor }; states.set(id, state);
    state.done = Promise.resolve().then(() => withCheckpoint(value.projectId, () => verificationService.withApprovedExecution({ projectId: value.projectId, runId: value.runId, proposalId: value.proposalId, revision: value.revision }, async grant => {
      try {
      available(); need(!state.cancelled, 409, 'cancelled', '请求已在实际编码前停止。'); manifests.set(id, grant.manifest);
      db.prepare("UPDATE executions SET binding=?,status='preparing',updated_at=? WHERE id=? AND owner=?").run(JSON.stringify(grant.binding), new Date().toISOString(), id, owner);
      const assertCurrent = () => { available(); assertExecutionSubjectCurrent(subjectDescriptor); need(states.get(id) === state && !state.cancelled && select(id)?.owner === owner && current(select(id)), 409, 'stale_execution', '研发执行已停止或来源变化。'); return grant.assertCurrent(); };
      const byTask = grant.manifest.taskScopes?.length >= 2;
      need(!byTask || grant.task.tasks.length <= (frozen.taskLimit ?? 1), 409, 'definition_budget_changed', '真实任务图超过当前冻结预算。');
      let evolutionSeed;
      if (options.createSeed) {
        const deadline = Date.parse(select(id).created_at) + frozen.timeoutMs;
        state.seedAttempted = true; state.seedTimer = setTimeout(() => state.prepareController.abort(), Math.max(1, deadline - Date.now()));
        const preparationCurrent = () => { assertCurrent(); need(!state.prepareController.signal.aborted && Date.now() < deadline, 409, 'evolution_preparation_stopped', '演进准备已停止或达到本次总时限。'); return true; };
        evolutionSeed = await options.createSeed({ ...grant, assertCurrent: preparationCurrent, signal: AbortSignal.any([grant.signal, state.prepareController.signal]) });
        need(evolutionSeed && typeof evolutionSeed === 'object', 409, 'evolution_seed_required', '演进准备没有返回可信种子，禁止退回无旧数据的新开发。');
        preparationCurrent();
      }
      state.handle = (dependencies.startExecution ?? (byTask ? startPlannedTaskExecution : startPlannedWebExecution))({ outputDir: root, binding: { projectId: value.projectId, runId: value.runId, taskId: 'whole-planned-project', specRevision: grant.binding.specRevision, planRevision: grant.binding.planRevision, sourceRevision: grant.binding.sourceRevision },
        task: grant.task, manifest: grant.manifest, executable, initialSource, ...(options.createSeed ? { evolutionSeed } : {}),
        ...(options.repairNote === undefined ? {} : { repairNote: options.repairNote }),
        assertCurrent, signal: AbortSignal.any([grant.signal, state.prepareController.signal]), ...Object.fromEntries(['maxCalls', 'maxReviewCalls', 'timeoutMs'].map(key => [key, frozen[key]])),
        ...(options.createSeed ? { timeoutMs: Math.max(1, frozen.timeoutMs - (Date.now() - Date.parse(select(id).created_at))) } : {}),
        ...(byTask ? { maxConcurrency: frozen.maxConcurrency ?? 2 } : {}),
        provider: (dependencies.createProvider ?? createProjectCodeModel)({ config: settings }), reviewer: (dependencies.createReviewer ?? createProjectReviewModel)({ config: reviewSettings }),
        onEvent: () => { if (!owns() || states.get(id) !== state) return; const report = state.handle?.snapshot(); if (!report) return;
          db.prepare('UPDATE executions SET status=?,record=?,updated_at=? WHERE id=? AND owner=?').run(report.status, JSON.stringify(report), new Date().toISOString(), id, owner); },
      });
      return await state.handle.done;
      } catch (error) {
        if (state.handle) throw error;
        if (state.seedAttempted) return { kind: 'controller_admission', status: 'reconciliation_required', terminationConfirmed: false, totalModelCalls: 0,
          error: '演进数据或源码准备未取得完整停止证据；保留活动槽、原预算及现场，没有自动调用模型重试。' };
        return { kind: 'controller_admission', status: state.cancelled ? 'stopped' : 'failed', terminationConfirmed: true, totalModelCalls: 0,
          error: '实际编码开始前被当前状态或配置拒绝；请刷新规划、验收定义与环境后重试。' };
      }
    }))).then(record => finish(id, record)).catch(async () => {
      if (!owns()) return;
      const record = state.handle?.snapshot();
      if (record) await finish(id, { ...record, status: record.terminationConfirmed === true ? 'failed' : 'reconciliation_required',
        error: '结果或交付检查点未能可靠保存；保留现场，未自动重试模型。' });
      else {
        const report = { kind: 'controller_admission', status: state.cancelled ? 'stopped' : 'failed', terminationConfirmed: true, totalModelCalls: 0,
          error: '当前项目检查点或验收许可尚不允许执行；请刷新并核对，没有发起编码。' };
        transaction(() => { db.prepare("UPDATE executions SET status=?,active=0,record=?,updated_at=? WHERE id=? AND owner=?").run(report.status, JSON.stringify(report), new Date().toISOString(), id, owner);
          db.prepare('UPDATE budgets SET reserved_calls=reserved_calls-? WHERE project_id=? AND run_id=?').run(reservationFor(frozen), value.projectId, value.runId); });
      }
    }).finally(() => { clearTimeout(state.seedTimer); states.delete(id); });
    return { execution: publicRow(select(id)) };
  }
  async function finishRetiredCancellation(row, state, assertAccess) {
    let cancellationStage = 'admission';
    try {
    need(!db.prepare('SELECT 1 FROM artifact_checks WHERE project_id=? AND active=1').get(row.project_id), 409, 'worker_cancel_unconfirmed', '项目仍有未知核对进程，不能声明完整停止。');
    const intent = workerIntent(row.id), job = workerStore.get(intent.job_id), frozen = JSON.parse(row.budget);
    const assertControl = () => { available(); checkPreviewAccess(assertAccess); need(workerIntent(row.id)?.grant_hash === job.grant_hash && select(row.id), 409, 'stale_execution', '取消费用核对的作业归属已变化。'); return true; };
    let permit;
    cancellationStage = 'evidence';
    try { permit = await verifyRetiredWorkerCancellation({ store: workerStore, jobId: job.id, assertControl }); }
    catch (error) {
      if (owns() && (error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false)) db.prepare("INSERT INTO artifact_checks VALUES(?,?,?,1,'reconciliation_required',?) ON CONFLICT(execution_id) DO UPDATE SET active=1,status='reconciliation_required',details=excluded.details").run(row.id, row.project_id, owner, JSON.stringify(error?.result ? { process: error.result } : {}));
      throw error;
    }
    cancellationStage = 'permit'; const { body, graph } = assertVerifiedRetiredWorkerCancellation(permit, { store: workerStore, jobId: job.id }); assertControl();
    const resultHash = workerHash(body), record = { ...structuredClone(graph), kind: 'retirement_cost_only_cancellation', status: 'stopped', terminationConfirmed: true,
      finishedAt: new Date().toISOString(), error: '作业已在已签名安全退休点取消；仅结算已发生费用，待执行任务未运行，没有软件交付资格。' };
    cancellationStage = 'budget'; transaction(() => {
      assertControl(); const live = workerIntent(row.id); need(live.phase === 'retirement_cancel_intent' && (!live.result_hash || live.result_hash === resultHash)
        && body.executionId === row.id && body.grantHash === live.grant_hash && body.settlement.releasedReservation === reservationFor(frozen), 409, 'worker_cancel_unconfirmed', '退休取消费用或原预留不一致。');
      if (!live.settled) {
        db.prepare('UPDATE budgets SET reserved_calls=reserved_calls-?,used_calls=used_calls+? WHERE project_id=? AND run_id=?').run(reservationFor(frozen), body.settlement.actualCalls, row.project_id, row.run_id);
        db.prepare('UPDATE worker_outbox SET settled=1,result_hash=? WHERE execution_id=?').run(resultHash, row.id);
      }
      db.prepare("UPDATE executions SET status='cancelling_retired',active=1,record=?,owner=?,updated_at=? WHERE id=?").run(JSON.stringify(record), owner, new Date().toISOString(), row.id);
    });
    cancellationStage = 'worker_consumption'; await workerStore.consumeRetiredCancellation(permit, { jobId: job.id }); assertControl();
    need(typeof verificationService.cancelRetiredWorkerExecution === 'function', 409, 'worker_cancel_unavailable', '缺少退休费用取消的持久授权结算入口。');
    cancellationStage = 'planning_release'; await verificationService.cancelRetiredWorkerExecution(workerInput(row), { permit, store: workerStore }); assertControl();
    cancellationStage = 'final_release'; transaction(() => { assertControl(); db.prepare("UPDATE executions SET status='stopped',active=0,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
      db.prepare("UPDATE worker_outbox SET phase='retirement_cancelled' WHERE execution_id=? AND result_hash=?").run(row.id, resultHash); });
    observedWorkerStops.add(row.id); restorationErrors.delete(row.id); state.record = record;
    } catch (error) {
      const safeCodes = new Set(['worker_old_process_unconfirmed', 'worker_exit_observation_changed', 'worker_retirement_required', 'worker_handoff_signature', 'worker_checkpoint_changed',
        'worker_frozen_state_changed', 'worker_checkpoint_calls', 'worker_retirement_cost_unknown', 'worker_authorization_signature', 'worker_authorization_changed', 'worker_cancel_unconfirmed',
        'worker_result_replay_conflict', 'execution_subject_revoked', 'service_closed', 'stale_execution', 'forbidden', 'invalid_worker_state']);
      if (owns()) db.prepare('INSERT INTO cancellation_diagnostics VALUES(?,?,?,?) ON CONFLICT(execution_id) DO UPDATE SET stage=excluded.stage,code=excluded.code,at=excluded.at')
        .run(row.id, cancellationStage, safeCodes.has(error?.code) ? error.code : 'cancellation_step_rejected', new Date().toISOString());
      throw error;
    }
  }
  async function cancel(raw, { assertAccess = () => true } = {}) {
    const value = input(raw, ['projectId', 'runId', 'executionId']); available(); const row = rowFor(value), state = states.get(row.id);
    if (state?.worker) {
      if (state.recovering) {
        state.cancelled = true;
        db.prepare("UPDATE executions SET status='cancel_requested',control=control+1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
        return { execution: publicRow(select(row.id)) };
      }
      const intent = workerIntent(row.id), job = workerStore.get(intent.job_id);
      if (['retired', 'retirement_cancel_pending'].includes(job?.status) || intent.phase === 'retirement_cancel_intent') {
        checkPreviewAccess(assertAccess); workerStore.beginRetiredCancellation(job.id);
        db.prepare("UPDATE worker_outbox SET phase='retirement_cancel_intent' WHERE execution_id=? AND settled=0").run(row.id);
        state.cancelAttempted = true;
        try { await finishRetiredCancellation(row, state, assertAccess); }
        catch (error) { if (owns()) {
          if (error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false) db.prepare("INSERT INTO artifact_checks VALUES(?,?,?,1,'reconciliation_required',?) ON CONFLICT(execution_id) DO UPDATE SET active=1,status='reconciliation_required',details=excluded.details").run(row.id, row.project_id, owner, JSON.stringify(error?.result ? { process: error.result } : {}));
          db.prepare("UPDATE executions SET status='reconciliation_required',active=1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id); restorationErrors.set(row.id, '退休取消仍缺少完整停止或费用证据；原活动槽和现场保留，没有新的模型调用。');
        } throw Object.assign(new Error('退休取消的历史停止或费用尚未完整核对，请保留现场。'), { status: 409, code: 'worker_cancel_unconfirmed' }); }
        return { execution: publicRow(select(row.id)) };
      }
      need(row.active && state.client, 409, 'not_running', '尚未重新连接原Worker，取消状态不能确认。');
      const result = await state.client.cancel(); available(); need(!result.commandError, 409, 'worker_cancel_unconfirmed', '原Worker尚未确认取消命令，请刷新核对。');
      db.prepare("UPDATE executions SET status='cancel_requested',control=control+1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
      return { execution: publicRow(select(row.id)) };
    }
    need(state && row.active && row.status !== 'reconciliation_required', 409, 'not_running', '当前控制器没有可停止的研发执行。'); state.cancelled = true; state.prepareController?.abort(); state.handle?.cancel();
    db.prepare("UPDATE executions SET status='cancel_requested',control=control+1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id); return { execution: publicRow(select(row.id)) };
  }
  async function taskControl(raw, action) {
    const value = input(raw, ['projectId', 'runId', 'executionId']); available(); const row = rowFor(value), state = states.get(row.id);
    if (state?.worker) {
      const allowed = action === 'pause' ? publicRow(row).actions.canPause : publicRow(row).actions.canResume;
      need(allowed && state.client && current(row), 409, 'task_control_unavailable', '当前Worker任务图尚不可暂停或继续。');
      const result = await state.client[action](); available(); need(!result.commandError && result.snapshot, 409, 'task_control_unavailable', 'Worker尚未确认控制命令。');
      state.record = result.snapshot; db.prepare('UPDATE executions SET status=?,record=?,updated_at=? WHERE id=? AND active=1').run(result.snapshot.status, JSON.stringify(result.snapshot), new Date().toISOString(), row.id);
      return { execution: publicRow(select(row.id)) };
    }
    const allowed = action === 'pause' ? publicRow(row).actions.canPause : publicRow(row).actions.canResume;
    need(allowed && current(row) && state && !state.cancelled && typeof state.handle?.[action] === 'function', 409, 'task_control_unavailable', '只有当前控制器持有的任务图可以暂停或继续。');
    state.handle[action](); const record = state.handle.snapshot();
    db.prepare('UPDATE executions SET status=?,record=?,updated_at=? WHERE id=? AND owner=? AND active=1').run(record.status, JSON.stringify(record), new Date().toISOString(), row.id, owner);
    return { execution: publicRow(select(row.id)) };
  }
  async function recover(raw) {
    const value = input(raw, ['projectId', 'runId', 'executionId']); available(); const row = rowFor(value), state = states.get(row.id);
    need(state?.worker && publicRow(row).actions.canRecover && !state.recovering, 409, 'worker_recovery_unavailable', '只有已安全暂停且保持当前授权的持久任务图可申请换Worker继续。');
    state.recovering = true;
    db.prepare("UPDATE executions SET status='recovery_requested',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    state.recovery = (async () => {
      state.grant ??= workerAuthority(row); state.grant.assertCurrent();
      let job = workerStore.get(workerIntent(row.id).job_id);
      if (job.status !== 'retired') {
        need(state.client, 409, 'worker_not_connected', '原Worker尚未连接，不能假定已停止。');
        const result = await state.client.recover(); available(); need(!result.commandError && result.job.status === 'retired', 409, 'worker_retirement_unconfirmed', '未取得原Worker的签名退休检查点。'); job = workerStore.get(job.id);
      }
      state.client?.close(); state.client = null; const stopDeadline = Date.now() + 10000;
      for (;;) {
        available(); state.grant.assertCurrent(); let stopped = false;
        try { await confirmWorkerExit({ store: workerStore, jobId: job.id, generation: job.active_generation }); stopped = true; } catch (error) { if (error.code !== 'worker_old_process_unconfirmed') throw error; }
        if (stopped) break; need(Date.now() < stopDeadline, 409, 'worker_old_process_unconfirmed', '旧Worker进程停止尚未确认。'); await new Promise(resolve => setTimeout(resolve, 50));
      }
      const assertCurrent = () => { available(); state.grant.assertCurrent(); need(!state.cancelled && states.get(row.id) === state && current(select(row.id)) && !!select(row.id).active, 409, 'stale_execution', '恢复前当前规划或作业归属已变化。'); return true; };
      const permit = await verifyPausedWorkerCheckpoint({ store: workerStore, jobId: job.id, manifest: state.grant.manifest, assertCurrent }); assertCurrent();
      await launchResumedPlannedWorker({ store: workerStore, jobId: job.id, permit, manifest: state.grant.manifest, config: state.modelSettings ?? modelSelection().workerConfig, executable }); assertCurrent();
      db.prepare("UPDATE executions SET status='running',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    })().catch(async () => {
      if (owns() && !closing) {
        if (state.cancelled) try {
          const job = workerStore.get(workerIntent(row.id).job_id);
          if (['retired', 'retirement_cancel_pending'].includes(job.status)) {
            workerStore.beginRetiredCancellation(job.id); db.prepare("UPDATE worker_outbox SET phase='retirement_cancel_intent' WHERE execution_id=? AND settled=0").run(row.id); state.cancelAttempted = false;
          } else if (job.registration) {
            state.client?.close(); state.client = await attachPlannedWorker({ store: workerStore, jobId: job.id, controllerId: owner, heartbeat: false });
            const response = await state.client.cancel(); need(!response.commandError, 409, 'worker_cancel_unconfirmed', '原Worker取消尚未确认。');
          } else workerStore.markUnknown(job.id);
        } catch { try { workerStore.markUnknown(workerIntent(row.id).job_id); } catch {} }
        if (!owns() || closing) return; db.prepare("UPDATE executions SET status='reconciliation_required',active=1,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
        restorationErrors.set(row.id, '任务换Worker恢复尚未核对完成；原截止时间、费用、活动槽和现场保留，没有自动重复派发。'); }
    }).finally(() => { state.recovering = false; state.wake?.(); });
    return { execution: publicRow(select(row.id)) };
  }
  async function repair(raw, context = {}) {
    const fields = ['projectId', 'runId', 'executionId', 'contractRevision'];
    if (Object.hasOwn(raw ?? {}, 'repairNote')) fields.push('repairNote');
    const value = input(raw, fields);
    available();
    const repairNote = value.repairNote?.trim();
    if (value.repairNote !== undefined) {
      need(repairNote && value.repairNote.length <= 2000 && repairNote.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(repairNote),
        400, 'invalid_repair_note', '修复说明须为1至2000字符的文字。');
      modelSelection();
      need(![...modelSecrets].some(key => guardModelContent(repairNote, key).credentialResponse), 400, 'credential_input', '修复说明包含模型配置凭据，尚未开始修复。');
    }
    const row = rowFor(value); need(publicRow(row).actions.canRepair, 409, 'source_unavailable', '仅可复用当前规划、已确认停止且来源完整的模型候选。');
    const record = JSON.parse(row.record), planning = getPlanningSync(value.projectId, value.runId);
    let initialSource;
    try {
      initialSource = await inspectPlannedSource({ rootDir: root, reportPath: record.reportPath, expectedRecord: record,
        binding: { projectId: value.projectId, specRevision: planning.run.specRevision, planRevision: planning.run.planRevision },
        writablePaths: planWritablePaths(planning.run.tasks) });
    } catch { fail(409, 'source_unavailable', '原源码、Git版本、模型回执或历史阻塞意见无法完整核对；没有开始收费修复。'); }
    available(); need(publicRow(rowFor(value)).actions.canRepair && JSON.parse(rowFor(value).record).candidateCommit === record.candidateCommit, 409, 'stale_execution', '核对源码期间当前规划或原执行变化。');
    return start({ projectId: value.projectId, runId: value.runId, proposalId: row.proposal_id, revision: row.definition_revision, contractRevision: value.contractRevision }, initialSource, { ...context, repairNote });
  }
  async function download(raw) {
    const value = input(raw, ['projectId', 'runId', 'executionId']); available(); let row = rowFor(value);
    if (!verifiedRecords.has(row.id) && row.status === 'accepted' && !row.active) await restore(row);
    available(); row = rowFor(value); const view = publicRow(row);
    need(view.actions.canDownload && !row.active, 409, 'not_accepted', '当前规划尚无完整同版本验收源码。');
    return withProjectCheckpoint(value.projectId, async () => {
    const sourceGrant = await authorizeAcceptedSource(value); sourceGrant.assertCurrent();
    const record = deliveryRecords.get(row.id) ?? verifiedRecords.get(row.id), relative = path.relative(root, record.workspace);
    need(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 409, 'invalid_source', '源码不属于服务工作区。');
    const files = await readProjectFiles(record.workspace); need(digest(files) === record.versions.at(-1).sourceHash && (await verifyWebShell({ workspace: record.workspace })).hash === record.shellHash, 409, 'invalid_source', '交付前源码或外壳变化。');
    available(); need(current(select(row.id)) && publicRow(select(row.id)).actions.canDownload, 409, 'stale_execution', '交付前版本已变化。');
    const planning = getPlanningSync(value.projectId, value.runId);
    const deliveryTasks = manifests.get(row.id)?.taskScopes ? planning.run.tasks.map(t => ({ id: t.id, title: t.title, description: t.description, requirementIds: t.requirementIds, dependsOn: t.dependsOn, inputs: t.inputs, outputs: t.outputs, acceptance: t.acceptance, writePaths: t.writePaths ?? t.suggestedFiles })) : planning.run.tasks;
    const buffer = await createPlannedDelivery({ record, manifest: manifests.get(row.id), files, requirements: planning.run.sourceSnapshot.content, spec: planning.run.spec, tasks: deliveryTasks,
      checkpoint: restoredCheckpoints.get(row.id), executionId: row.id, ...(isTaskRun(verifiedRecords.get(row.id)) ? { executionRecord: verifiedRecords.get(row.id) } : {}) });
    available(); need(current(select(row.id)) && publicRow(select(row.id)).actions.canDownload, 409, 'stale_execution', '交付返回前版本已变化。');
    const finalSourceGrant = await authorizeAcceptedSource(value); finalSourceGrant.assertCurrent();
    return { buffer, filename: `planned-web-${row.id}.zip`, contentType: 'application/zip' };
    });
  }
  const previewAccess = new Map();
  function checkPreviewAccess(check) {
    const result = check?.();
    need(result !== false && !result?.then, 403, 'forbidden', '当前身份不能启动或继续预览。');
  }
  async function authorizeAcceptedSource(raw, { signal, assertAccess = () => true } = {}) {
    const value = input(raw, ['projectId', 'runId', 'executionId']); available();
    need(typeof assertAccess === 'function', 500, 'invalid_config', '源码授权缺少同步权限检查。'); checkPreviewAccess(assertAccess);
    let row = rowFor(value); if (!verifiedRecords.has(row.id) && row.status === 'accepted' && !row.active) await restore(row);
    available(); checkPreviewAccess(assertAccess); row = rowFor(value);
    const frozenRow = digest(row), selected = deliveryState(row), access = assertAccess;
    const assertCurrent = () => {
      available(); checkPreviewAccess(access);
      const latest = rowFor(value);
      need(digest(latest) === frozenRow && deliveryState(latest).accepted, 409, 'preview_not_accepted', '当前已验收版本或预览权限已变化。');
      return true;
    };
    assertCurrent();
    need(!evidenceChecks.has(row.project_id) && !db.prepare('SELECT 1 FROM artifact_checks WHERE project_id=? AND active=1').get(row.project_id), 409, 'evidence_check_busy', '项目已有源码证据核对或未知状态待协调。');
    const planning = getPlanningSync(value.projectId, value.runId), writablePaths = planWritablePaths(planning.run.tasks);
    const binding = { projectId: row.project_id, specRevision: selected.delivery.specRevision, planRevision: selected.delivery.planRevision };
    const controller = new AbortController(), checkToken = randomUUID(); let releaseCheck;
    const checkDone = new Promise(resolve => { releaseCheck = resolve; }); evidenceChecks.set(row.project_id, { controller, token: checkToken, done: checkDone });
    db.prepare("INSERT INTO artifact_checks VALUES(?,?,?,1,'checking','{}') ON CONFLICT(execution_id) DO UPDATE SET owner=excluded.owner,active=1,status='checking',details='{}'").run(row.id, row.project_id, owner);
    let handle; const checkingSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
    try {
      const actual = selected.verified, records = isTaskRun(actual) ? actual.tasks.flatMap(task => [...(task.history ?? []), task.record].filter(Boolean)) : [selected.delivery];
      const inspectWorkerHistory = () => { const intent = workerIntent(row.id); if (intent) assertWorkerGenerationEvidence({ store: workerStore, jobId: intent.job_id, record: selected.delivery, ...(isTaskRun(actual) ? { graph: actual } : {}) }); };
      inspectWorkerHistory();
      need(records.length > 0, 409, 'source_unavailable', '原始任务证据缺失。');
      for (const candidate of records) {
        assertCurrent();
        const checked = await inspectPlannedSource({ rootDir: root, reportPath: candidate.reportPath, expectedRecord: candidate, binding, writablePaths,
          signal: checkingSignal });
        assertCurrent(); inspectWorkerHistory(); if (candidate.id === selected.delivery.id) handle = checked;
      }
      if (!handle) handle = await inspectPlannedSource({ rootDir: root, reportPath: selected.delivery.reportPath, expectedRecord: selected.delivery, binding, writablePaths,
        signal: checkingSignal });
      assertCurrent();
    }
    catch (error) {
      const unknown = error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false;
      verifiedRecords.delete(row.id); deliveryRecords.delete(row.id); restoredCheckpoints.delete(row.id); rejectedArtifacts.add(row.id);
      restorationErrors.set(row.id, unknown ? '源码证据核对进程停止尚未确认；项目保持待协调，未调用模型。' : '未能核对原源码、Git或私有回执；当前交付资格已撤销，请保留现场。');
      if (owns()) db.prepare('UPDATE artifact_checks SET active=?,status=?,details=? WHERE execution_id=? AND owner=?').run(unknown ? 1 : 0, unknown ? 'reconciliation_required' : 'rejected', JSON.stringify(error?.result ? { process: error.result } : {}), row.id, owner);
      throw Object.assign(new Error(unknown ? '源码核对的停止尚未确认，请保留现场等待协调。' : '原始源码、Git版本或私有回执发生变化；没有交付或开始新模型请求。'),
        { status: 409, code: unknown ? 'source_check_unknown' : 'source_evidence_changed', ...(unknown ? { reconciliationRequired: true } : {}), ...(error?.result ? { result: error.result } : {}) });
    }
    finally {
      if (owns()) db.prepare("UPDATE artifact_checks SET active=0,status='verified' WHERE execution_id=? AND owner=? AND status='checking'").run(row.id, owner);
      if (evidenceChecks.get(row.project_id)?.token === checkToken) evidenceChecks.delete(row.project_id);
      releaseCheck();
    }
    assertCurrent();
    const source = assertPlannedSource(handle, binding, writablePaths);
    need(source.provenance.sourceCommit === selected.delivery.candidateCommit && source.provenance.sourceHash === selected.delivery.versions.at(-1).sourceHash,
      409, 'preview_source_changed', '预览代码来源与验收版本不同。');
    const origin = JSON.parse(row.binding);
    return { files: source.files, sourceHandle: handle, sourceRootDir: root, originBinding: { projectId: row.project_id, runId: row.run_id,
      executionId: source.provenance.sourceExecutionId, candidateCommit: source.provenance.sourceCommit, sourceHash: source.provenance.sourceHash,
      sourceRevision: origin.sourceRevision, sourceGeneration: origin.sourceGeneration ?? 0, specRevision: origin.specRevision, planRevision: origin.planRevision },
      sourceHash: source.provenance.sourceHash, shellHash: selected.delivery.shellHash,
      ...(selected.delivery.evolutionSource ? { evolutionSource: structuredClone(selected.delivery.evolutionSource) } : {}),
      ...(selected.delivery.evolutionMigration ? { evolutionMigration: structuredClone(selected.delivery.evolutionMigration) } : {}), assertCurrent };
  }
  async function authorizePreview(value, { signal } = {}) {
    return authorizeAcceptedSource(value, { signal, assertAccess: previewAccess.get(value.executionId) });
  }
  async function preview(raw, { assertAccess = () => true } = {}) {
    const value = input(raw, ['projectId', 'runId', 'executionId']); available(); need(typeof assertAccess === 'function', 500, 'invalid_config', '预览权限门禁无效。');
    checkPreviewAccess(assertAccess); let row = rowFor(value);
    if (!verifiedRecords.has(row.id) && row.status === 'accepted' && !row.active) await restore(row);
    return withCheckpoint(value.projectId, async () => {
      available(); checkPreviewAccess(assertAccess); row = rowFor(value);
      need(publicRow(row).actions.canPreview, 409, 'preview_not_accepted', '仅当前已完整验收且无活动的项目可启动预览。');
      previewAccess.set(row.id, assertAccess);
      try { const { preview: result } = await previews.start(value); return { execution: publicRow(rowFor(value)), preview: result }; }
      catch (error) { previewAccess.delete(row.id); throw error; }
    });
  }
  async function stopPreview(raw) {
    const value = input(raw, ['projectId', 'runId', 'executionId']); available(); const row = rowFor(value);
    const result = await previews.stop(value); previewAccess.delete(row.id); available(); return { execution: publicRow(rowFor(value)), preview: result.preview };
  }
  async function withProjectCheckpoint(projectId, work) {
    available(); need(ID.test(projectId) && typeof work === 'function' && !barriers.has(projectId) && !active(projectId), 409, 'project_busy', '项目有研发执行或未知状态待协调。');
    barriers.add(projectId); try { return await work(); } finally { barriers.delete(projectId); }
  }
  function shutdown() { return shutdownPromise ??= (async () => {
    if (closed) return; closing = true; for (const state of states.values()) {
      if (state.worker) { state.controller.abort(); clearTimeout(state.timer); state.wake?.(); }
      else { state.cancelled = true; state.prepareController?.abort(); state.handle?.cancel(); }
    }
    let detachTimer; try { await Promise.race([Promise.allSettled([...states.values()].filter(state => state.worker).map(state => state.client?.detach())), new Promise(resolve => { detachTimer = setTimeout(resolve, 1500); })]); } finally { clearTimeout(detachTimer); }
    for (const controller of restorationControllers.values()) controller.abort();
    for (const { controller } of evidenceChecks.values()) controller.abort();
    let timer; try { await Promise.race([Promise.allSettled([...states.values()].map(state => state.done).concat([...restoring.values()], [...evidenceChecks.values()].map(check => check.done))), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); } finally { clearTimeout(timer); }
    await previews?.shutdown(); previewAccess.clear();
    if (owns()) { db.prepare("UPDATE artifact_checks SET status='reconciliation_required' WHERE active=1 AND owner=?").run(owner); db.prepare("UPDATE executions SET status='reconciliation_required',control=control+1 WHERE active=1 AND NOT EXISTS(SELECT 1 FROM worker_outbox w WHERE w.execution_id=executions.id)").run(); db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); }
    checkpoints.close(); workerStore?.close(); db.close(); closed = true;
  })(); }
  try { workerStore = openPlannedWorkerStore({ rootDir: path.join(root, 'workers') }); }
  catch { if (useWorkers) workerReady = false; }
  if (useWorkers && (typeof verificationService?.workerExecution !== 'function' || typeof verificationService?.completeWorkerExecution !== 'function' || typeof verificationService?.stopWorkerExecution !== 'function')) workerReady = false;
  try { previews = await createPlannedPreviews({ rootDir: path.join(root, 'previews'), executable, authorize: authorizePreview,
    assertIdle: projectId => { available(); need(!active(projectId) && !barriers.has(projectId), 409, 'project_busy', '同项目有执行、预览或未知状态待协调。'); },
    dependencies: dependencies.startPreviewRuntime ? { startRuntime: dependencies.startPreviewRuntime } : {} }); }
  catch (error) { checkpoints.close(); workerStore?.close(); db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); db.close(); throw error; }
  return Object.freeze({ list, timeoutMs, start: (raw, context = {}) => start(raw, undefined, context),
    canPrepare: () => {
      if (!modelSelection().ready || !checkpoints.available()) return false;
      try { return statSync(executable, { throwIfNoEntry: false })?.isFile() === true; }
      catch { return false; }
    },
    startEvolution: (raw, options) => { need(options && Object.keys(options).every(key => ['createSeed', 'subject'].includes(key)) && typeof options.createSeed === 'function', 500, 'invalid_config', '演进执行缺少可信私有种子工厂。'); return start(raw, undefined, options); },
    repair, cancel, recover, preview, stopPreview, authorizeAcceptedSource, pause: raw => taskControl(raw, 'pause'), resume: raw => taskControl(raw, 'resume'), download, withProjectCheckpoint, shutdown });
}
