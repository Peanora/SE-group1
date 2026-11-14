import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { startWebExecution, isWebTaskAccepted } from './web-executor.mjs';
import { inspectWebRecheckSource, startWebRecheck } from './web-recheck.mjs';
import { createProjectCodeModel } from './project-code-model.mjs';
import { createProjectReviewModel, projectReviewPolicy } from './project-review-model.mjs';
import { getModelConfig } from './planner.mjs';
import { contentRevision, planningRevision, assertSpecApproval } from './planning-review.mjs';
import { webProfile } from './web-profile.mjs';
import { webManifest } from './web-tests.mjs';
import { browserManifest } from './web-browser-tests.mjs';
import { readProjectFiles, validateProjectFiles, applyProjectFiles } from './project-files.mjs';
import { installWebShell, verifyWebShell, getWebShellFiles, createWebDelivery } from './web-delivery.mjs';
import { startWebRuntime } from './web-runtime.mjs';
import { minimalEnv, runProcess } from './managed-process.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const ID = /^[A-Za-z0-9_-]{1,128}$/u, HASH = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(['accepted', 'failed', 'stopped', 'timed_out', 'diagnostic_passed', 'superseded']);
const REFERENCE_NOTICE = '仅执行固定library-web-v1参考项目：图书借阅、SQLite、HTTP与浏览器验收及独立Review。上传资料仅作关联快照，不代表任意上传业务已实现。';
export const webExecutionContractRevision = digest({ profile: webProfile, http: webManifest.hash, browser: browserManifest.hash, review: projectReviewPolicy.hash });
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const need = (condition, status = 409, code = 'conflict', message = '执行状态或版本不允许此操作。') => { if (!condition) fail(status, code, message); };
const identifier = value => { need(typeof value === 'string' && ID.test(value), 400, 'invalid_id', '编号格式无效。'); return value; };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const known = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const projectPath = value => { try { return validateProjectFiles([{ path: value, content: '' }])[0].path; } catch { return null; } };
const ADMISSION_CLEANUP_MS = 5500; // Existing managed processes allow five seconds to confirm termination.
const privateProcessEvidence = value => Object.fromEntries(['pid', 'startedAt', 'finishedAt', 'status', 'exitCode', 'signal', 'stopReason', 'terminationConfirmed',
  'sourceUnchanged', 'stopAcknowledged', 'durationMs', 'controlDirectory', 'control', 'probeDirectory', 'probe']
  .filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key]) || value?.[key] === null)
  .map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 2048) : value[key]]));
const cleanStop = result => result?.terminationConfirmed === true && result.sourceUnchanged === true
  && (result.status === 'stopped' || result.status === 'timed_out' && result.stopReason === 'timed_out') && result.exitCode === 0 && result.stopAcknowledged === true;

async function directory(directory, create = false) {
  need(typeof directory === 'string' && path.isAbsolute(directory) && path.resolve(directory) !== path.parse(directory).root, 500, 'invalid_root', '服务目录必须是专用绝对目录。');
  const absolute = path.resolve(directory), anchor = path.parse(absolute).root;
  let current = anchor;
  for (const part of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await lstat(current);
    need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(current), current), 500, 'invalid_root', '服务目录及父目录不能是链接。');
  }
  return absolute;
}

function planningSnapshot(project, run, projectId, runId) {
  need(project?.id === projectId && run?.id === runId, 404, 'not_found', '未找到项目或规划运行。');
  need(run.sourceSuperseded !== true && (!Object.hasOwn(project, 'currentSourceRevision') || project.currentSourceRevision === run.sourceRevision),
    409, 'source_superseded', '该运行的需求来源已更新，仅保留历史，请从当前需求重新规划并确认。');
  need(run.workflowVersion === 2 && run.sourceSnapshot, 409, 'approval_required', '仅当前规格和计划均确认的新版运行可执行参考项目。');
  assertSpecApproval(run);
  need(contentRevision(run.sourceSnapshot) === run.sourceRevision && planningRevision(run) === run.planRevision
    && run.approvals?.plan?.revision === run.planRevision && run.approvals.plan.specRevision === run.specRevision
    && run.review?.passed === true && !run.review.issues?.length && ['succeeded', 'running'].includes(run.status)
    && !run.stages?.some(stage => stage.status === 'running' && stage.id !== 'export'), 409, 'approval_required', '当前规划内容或确认已变化，请先确认规格和计划。');
  need([run.sourceRevision, run.specRevision, run.planRevision].every(value => HASH.test(value || '')), 409, 'approval_required', '当前规划版本不完整。');
  return { binding: { projectId, runId, taskId: webProfile.id, sourceRevision: run.sourceRevision, specRevision: run.specRevision, planRevision: run.planRevision },
    source: structuredClone(run.sourceSnapshot), spec: structuredClone(run.spec), plan: { tasks: structuredClone(run.tasks), architecture: run.artifacts.find(item => item.name === 'architecture.md').content },
    notice: REFERENCE_NOTICE };
}

async function verifySource(record, ownedRoot, executeGit = runProcess) {
  need(isWebTaskAccepted(record), 409, 'not_accepted', '当前候选尚未完整通过独立验收。');
  const workspace = path.resolve(record.workspace || ''), relative = path.relative(ownedRoot, workspace);
  need(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(workspace) === 'workspace', 409, 'source_changed', '候选工作区不属于服务。');
  await directory(workspace);
  await directory(path.join(workspace, '.git'));
  const shell = await verifyWebShell({ workspace }), files = await readProjectFiles(workspace);
  need(shell.hash === record.shellHash && digest(validateProjectFiles(files)) === record.versions.at(-1).sourceHash, 409, 'source_changed', '候选源码或保护外壳已经变化。');
  const git = async args => {
    const command = { executable: 'git', args: ['--no-optional-locks', '-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', ...args], workspace };
    let result;
    try { result = await executeGit('git', command.args, {
      cwd: workspace, timeoutMs: 15000, maxOutputBytes: 2 * 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }); } catch (error) { throw Object.assign(error, { phase: 'source_git', command }); }
    if (result.terminationConfirmed !== true || result.exitCode !== 0 || result.stopReason || result.truncated) throw Object.assign(new Error(result.terminationConfirmed !== true ? '版本核对进程停止尚未确认。' : '候选版本核对失败。'),
      { status: 409, code: result.terminationConfirmed !== true ? 'reconciliation_required' : 'source_changed', phase: 'source_git', command, result });
    return result.stdout;
  };
  need(samePath((await git(['rev-parse', '--show-toplevel'])).trim(), workspace)
    && (await git(['rev-parse', 'HEAD'])).trim() === record.candidateCommit
    && !(await git(['status', '--porcelain', '--untracked-files=all'])).trim(), 409, 'source_changed', '候选提交或干净状态已经变化。');
  const entries = (await git(['ls-tree', '-rz', 'HEAD'])).split('\0').filter(Boolean), expected = [...files, ...await getWebShellFiles()];
  need(entries.length === expected.length, 409, 'source_changed', '固定提交包含未知或缺失文件。');
  const objects = new Map(entries.map(line => { const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line); need(match, 409, 'source_changed', '固定提交包含非普通文件。'); return [match[3], match[2]]; }));
  for (const file of expected) { const bytes = Buffer.from(file.content), hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); need(objects.get(file.path) === hash, 409, 'source_changed', '固定提交与当前文件不一致。'); }
  return { files, shellHash: shell.hash };
}

/** A trusted, single-controller local service. Dependencies are test-only capabilities, never HTTP input. */
export async function createWebExecutionService({ rootDir, getPlanning, config, executable = process.env.EXECUTION_SANDBOX_EXE,
  budget = { maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600000 }, previewTimeoutMs = 180000, dependencies = {} } = {}) {
  need(typeof getPlanning === 'function', 500, 'invalid_config', '服务需要可信规划查询入口。');
  need(Object.keys(budget).sort().join(',') === 'maxCalls,maxReviewCalls,timeoutMs' && [budget.maxCalls, budget.maxReviewCalls].every(value => Number.isInteger(value) && value >= 1 && value <= 5)
    && Number.isInteger(budget.timeoutMs) && budget.timeoutMs >= 1 && budget.timeoutMs <= 600000 && Number.isInteger(previewTimeoutMs) && previewTimeoutMs >= 1 && previewTimeoutMs <= 180000,
  500, 'invalid_config', '服务预算无效。');
  budget = Object.freeze({ ...budget });
  const recheckBudget = Object.freeze({ maxCalls: 0, maxReviewCalls: Math.min(2, budget.maxReviewCalls), timeoutMs: Math.min(180000, budget.timeoutMs) });
  config = config ? { ...config } : undefined;
  need(config?.apiKey === undefined || typeof config.apiKey === 'string', 500, 'invalid_config', '模型密钥配置必须为文本。');
  const root = await directory(rootDir, true), output = await directory(path.join(root, 'executions'), true), previewsRoot = await directory(path.join(root, 'previews'), true);
  const filename = path.join(root, 'service.sqlite');
  for (const name of [filename, `${filename}-wal`, `${filename}-shm`]) {
    try { const stat = await lstat(name); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && samePath(await realpath(name), name), 500, 'invalid_root', '服务数据库不能是链接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(filename); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT,pid INTEGER);
    CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,attempt INTEGER NOT NULL,owner TEXT NOT NULL,
    binding TEXT NOT NULL,snapshot TEXT NOT NULL,record TEXT NOT NULL,status TEXT NOT NULL,active INTEGER NOT NULL,preview_state TEXT NOT NULL DEFAULT 'none',error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preview_history(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_history(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,created_at TEXT NOT NULL,record TEXT NOT NULL);`);
  const owner = randomUUID(), handles = new Map(), previewHandles = new Map(), operations = new Map(), pendingOperations = new Set();
  const projectBarriers = new Map(), projectOperations = new Map(), projectGenerations = new Map(); let closing = false, closed = false, shutdownPromise;
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const alive = dependencies.isProcessAlive || (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
  try {
    transaction(() => {
      const previous = db.prepare('SELECT * FROM owner WHERE id=1').get();
      need(!previous?.token || !alive(previous.pid), 409, 'service_owned', '该服务目录已有运行中的控制器。');
      if (!db.prepare('PRAGMA table_info(executions)').all().some(column => column.name === 'control_version')) db.exec('ALTER TABLE executions ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0');
      // Old versions allowed one running preview plus a coding attempt. Keep both unknown histories.
      db.exec("DROP INDEX IF EXISTS active_run; CREATE UNIQUE INDEX active_run ON executions(project_id,run_id) WHERE active=1 AND status!='reconciliation_required'");
      db.prepare("UPDATE executions SET status='reconciliation_required',active=1,preview_state='unknown',error=? WHERE active=1 OR preview_state IN ('starting','running','stopping')")
        .run('服务重启，既有执行或预览进程状态未确认；需人工核对，不能自动重跑。');
      db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid);
      db.prepare('UPDATE executions SET owner=?,control_version=control_version+1').run(owner);
      db.exec("UPDATE preview_history SET state='unknown' WHERE state IN ('starting','running','stopping')");
    });
  } catch (error) { db.close(); throw error; }
  const own = () => { need(!closed && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner, 409, 'stale_owner', '控制器身份已失效，旧回调不可更新当前状态。'); };
  const available = () => { own(); need(!closing, 503, 'shutting_down', '服务正在停止，请稍后重试。'); };
  const projectAdmission = (projectId, expected = null) => {
    available(); identifier(projectId);
    const generation = projectGenerations.get(projectId) ?? 0;
    need(!projectBarriers.has(projectId), 409, 'project_checkpoint', '当前项目正在更新需求，请等待更新结束后重试。');
    need(expected === null || generation === expected, 409, 'stale_project_checkpoint', '项目检查点已变化，请重新读取当前需求和确认。'); return generation;
  };
  const select = id => db.prepare('SELECT * FROM executions WHERE id=?').get(identifier(id));
  const hasActivity = row => !!db.prepare("SELECT 1 FROM executions WHERE project_id=? AND run_id=? AND (active=1 OR status='reconciliation_required' OR preview_state!='none') LIMIT 1").get(row.project_id ?? row.projectId, row.run_id ?? row.runId);
  const hasReconciliation = row => !!db.prepare("SELECT 1 FROM executions WHERE project_id=? AND run_id=? AND status='reconciliation_required' LIMIT 1").get(row.project_id, row.run_id);
  const lookup = input => { const row = select(input.executionId); need(row && row.project_id === input.projectId && row.run_id === input.runId, 404, 'not_found', '未找到该执行。'); return row; };
  const getSnapshot = async input => { identifier(input.projectId); identifier(input.runId); const { project, run } = await getPlanning(input.projectId, input.runId); return planningSnapshot(project, run, input.projectId, input.runId); };
  const current = async row => { try {
    const generation = projectGenerations.get(row.project_id) ?? 0; if (projectBarriers.has(row.project_id)) return false;
    const snapshot = await getSnapshot({ projectId: row.project_id, runId: row.run_id });
    return !projectBarriers.has(row.project_id) && (projectGenerations.get(row.project_id) ?? 0) === generation && digest(snapshot.binding) === digest(JSON.parse(row.binding));
  } catch { return false; } };
  const publicModel = getModelConfig(), configured = config ? !!config.baseUrl && !!config.model : publicModel.configured;
  const ready = configured && typeof executable === 'string' && path.isAbsolute(executable);
  const deps = { startExecution: startWebExecution, startRecheck: startWebRecheck, inspectRecheckSource: inspectWebRecheckSource,
    codeModel: createProjectCodeModel, reviewModel: createProjectReviewModel, startRuntime: startWebRuntime,
    verifySource: (record, ownedRoot) => verifySource(record, ownedRoot, dependencies.runProcess || runProcess), createDelivery: createWebDelivery, ...dependencies };
  const secrets = [...new Set([config?.apiKey, process.env.LLM_API_KEY].filter(value => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length);
  const safe = value => {
    let result = typeof value === 'string' ? value : '';
    const mask = secrets.some(secret => '[已隐藏]'.includes(secret)) ? '' : '[已隐藏]';
    for (const secret of secrets) result = result.replaceAll(secret, mask);
    return result.replace(/\b(?:Bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/giu, '[已隐藏]')
      .replace(/[A-Za-z]:[\\/][^\s"'<>]*/gu, '[本地路径]').replace(/(?<![:\w])\/(?!api(?:\/|\b))(?:[\w.-]+\/)+[^\s"'<>]*/gu, '[本地路径]').slice(0, 2000);
  };
  function saveRecord(row, record, status = record.status, error = null) {
    own(); need(row.owner === owner, 409, 'stale_owner', '该执行不属于当前控制器。');
    const serialized = JSON.stringify(record); need(Buffer.byteLength(serialized) <= 16 * 1024 * 1024, 500, 'record_limit', '执行记录超出服务预算。');
    db.prepare('UPDATE executions SET record=?,status=?,active=?,error=? WHERE id=? AND owner=?').run(serialized, status, status === 'reconciliation_required' || !TERMINAL.has(status) || row.preview_state !== 'none' ? 1 : 0, error, row.id, owner);
  }
  const raw = row => JSON.parse(row.record);
  const snapshotHandle = id => { const handle = handles.get(id); if (!handle) return; const row = select(id); if (!row || row.owner !== owner || !row.active || TERMINAL.has(row.status) || ['cancel_requested', 'reconciliation_required'].includes(row.status)) return;
    const record = handle.handle.snapshot(); saveRecord(row, record, TERMINAL.has(record.status) ? 'finalizing' : record.status); };
  const assertCurrent = async (id, expected) => {
    own(); const row = select(id); need(row && row.owner === owner && row.active === 1 && !TERMINAL.has(row.status) && !['cancel_requested', 'reconciliation_required'].includes(row.status) && !hasReconciliation(row), 409, 'stale_execution', '执行已停止或归属失效。');
    const generation = projectAdmission(row.project_id);
    const valid = await current(row); own(); const latest = select(id);
    projectAdmission(row.project_id, generation);
    need(latest?.owner === owner && latest.control_version === row.control_version && latest.active === 1 && !TERMINAL.has(latest.status) && !['cancel_requested', 'reconciliation_required'].includes(latest.status) && !hasReconciliation(latest), 409, 'stale_execution', '执行已停止或归属失效。');
    need(valid && Object.entries(JSON.parse(latest.binding)).filter(([key]) => key !== 'sourceRevision').every(([key, value]) => expected[key] === value), 409, 'stale_version', '规划版本已变化，旧执行不能发布结果。');
  };
  function uncertain(record) {
    const results = (record.versions || []).flatMap(version => [version.selfCheck, version.acceptance?.test, version.acceptance?.browser]).filter(Boolean);
    return record.status === 'reconciliation_required' || record.gitCommands?.some(item => item.terminationConfirmed !== true)
      || record.failure?.result?.terminationConfirmed === false || record.environmentFailure?.result?.terminationConfirmed === false || results.some(result => result.status === 'reconciliation_required' || result.terminationConfirmed !== true
        || result.browser?.closed === false || [...(result.processes || []), ...(result.databaseCommands || []), ...(result.databasePreflights || [])].some(item => item.terminationConfirmed !== true));
  }
  const contextBinding = row => Object.fromEntries(Object.entries(JSON.parse(row.binding)).filter(([key]) => key !== 'sourceRevision'));
  const blockingMessage = '同一固定提交已有新的有效阻塞问题；请先修复形成新代码版本，再重新验收，不能反复重审覆盖该问题。';
  function knownBlocking(row, candidate = raw(row)) {
    const latest = candidate.versions?.at(-1), commit = latest?.commit, sourceHash = latest?.sourceHash;
    if (!/^[a-f0-9]{40}$/u.test(commit || '') || !HASH.test(sourceHash || '')) return false;
    for (const history of db.prepare('SELECT id,binding,snapshot,record,status FROM executions WHERE project_id=? AND run_id=?').all(row.project_id, row.run_id)) {
      const value = raw(history), snapshot = JSON.parse(history.snapshot), version = value.versions?.at(-1), review = version?.acceptance?.review;
      if (snapshot.operation !== 'recheck' || value.kind !== 'web_recheck' || value.reviewerKind !== 'model' || value.calls !== 0 || !TERMINAL.has(history.status) || !TERMINAL.has(value.status)
        || !Number.isInteger(value.reviewCalls) || value.reviewCalls < 1 || value.reviewCalls > 2
        || !Number.isFinite(Date.parse(value.finishedAt)) || version?.commit !== commit || version?.sourceHash !== sourceHash
        || snapshot.sourceProof?.sourceCommit !== commit || snapshot.sourceProof?.sourceHash !== sourceHash || review?.status !== 'completed' || review.kind !== 'model'
        || review.policyHash !== value.reviewPolicyHash || !HASH.test(review.policyHash || '') || !Number.isInteger(review.openBlockingIssues) || review.openBlockingIssues < 1
        || typeof review.summary !== 'string' || !review.summary.trim() || review.summary.length > 2000
        || review.binding?.candidateCommit !== commit || review.binding?.sourceHash !== sourceHash || review.binding?.attemptId !== value.attemptId
        || !Object.entries(contextBinding(history)).every(([key, expected]) => review.binding[key] === expected)
        || !Array.isArray(review.issues) || review.issues.length > 20 || !Array.isArray(version.acceptance.openIssues) || version.acceptance.openIssues.length > 40) continue;
      const source = select(snapshot.sourceServiceExecutionId), oldIds = new Set((source ? raw(source).versions?.at(-1)?.acceptance?.openIssues || [] : []).map(issue => issue.id));
      if (version.acceptance.openIssues.some(issue => !oldIds.has(issue.id) && ID.test(issue.id || '') && issue.severity === 'blocking' && issue.status === 'open'
        && Number.isInteger(issue.line) && issue.line > 0 && projectPath(issue.file) !== null
        && ['message', 'evidence'].every(key => typeof issue[key] === 'string' && issue[key].trim())
        && review.issues.some(item => ['severity', 'file', 'line', 'message', 'evidence'].every(key => item[key] === issue[key])))) return true;
    }
    return false;
  }
  function originalSource(row) {
    const record = raw(row), snapshot = JSON.parse(row.snapshot), latest = record.versions?.at(-1);
    need(snapshot.operation !== 'recheck' && record.kind !== 'web_recheck' && !record.provenance && row.active === 0 && row.preview_state === 'none'
      && TERMINAL.has(row.status) && row.status !== 'superseded' && record.profileId === webProfile.id && record.providerKind === 'model'
      && HASH.test(snapshot.contractRevision || '') && !uncertain(record) && !knownBlocking(row, record) && typeof record.finishedAt === 'string'
      && Number.isInteger(record.calls) && record.calls >= 1 && record.calls <= 5 && Array.isArray(record.modelCalls) && record.modelCalls.length <= 10
      && /^[a-f0-9]{40}$/u.test(latest?.commit || '') && latest.commit === record.candidateCommit && HASH.test(latest.sourceHash || '')
      && latest.selfCheck?.terminationConfirmed === true && latest.selfCheck.processes?.some(item => Number.isSafeInteger(item.pid) && item.pid > 0 && item.terminationConfirmed === true),
    409, 'cannot_recheck', '仅当前规划的已停止原始编码候选可重新检查，复验记录不能作为递归来源。');
    need(Object.entries(contextBinding(row)).every(([key, value]) => record[key] === value), 409, 'cannot_recheck', '原始报告身份与当前来源规划不一致。');
    const executionRoot = path.join(output, row.id), reportPath = record.reportPath;
    need(typeof reportPath === 'string' && path.isAbsolute(reportPath) && path.basename(reportPath) === 'execution.json'
      && samePath(path.dirname(path.dirname(reportPath)), executionRoot) && /^web-execution-[\w-]+$/u.test(path.basename(path.dirname(reportPath)))
      && samePath(record.workspace || '', path.join(path.dirname(reportPath), 'workspace')), 409, 'cannot_recheck', '原始候选路径不属于该服务执行。');
    const coding = record.modelCalls.filter(call => call.role === 'coding' && call.kind === 'model');
    need(coding.length === record.calls && coding.every(call => Number.isInteger(call.attempt) && call.attempt >= 1 && HASH.test(call.receiptHash || '')
      && samePath(call.receiptPath || '', path.join(path.dirname(reportPath), `model-coding-${call.attempt}.json`)))
      && coding.some(call => call.attempt === latest.attempt), 409, 'cannot_recheck', '原始候选缺少对应的编码回执，不能复验。');
    return { row, record, latest, executionRoot, sourceReportPath: reportPath, sourceBinding: contextBinding(row) };
  }
  function recheckPossible(row) { try { originalSource(row); return true; } catch { return false; } }
  function inspectMatches(value, source, pinned = null) {
    const summary = value?.summary;
    need(value?.source && summary && digest(value.source) === digest(source.record)
      && samePath(summary.sourceExecutionRoot || '', source.executionRoot) && samePath(summary.sourceReport || '', source.sourceReportPath)
      && digest(summary.sourceBinding) === digest(source.sourceBinding) && summary.sourceExecutionId === source.record.id
      && summary.sourceCommit === source.latest.commit && summary.sourceHash === source.latest.sourceHash && summary.sourceShellHash === source.record.shellHash
      && HASH.test(summary.sourceReportHash || '') && digest(validateProjectFiles(value.files)) === source.latest.sourceHash
      && (!pinned || ['sourceExecutionId', 'sourceReportHash', 'sourceCommit', 'sourceHash', 'sourceShellHash'].every(key => summary[key] === pinned[key])),
    409, 'source_changed', '原始报告、代码、上下文或复验来源已经变化。');
    return summary;
  }
  function startOwnedRecheck(row) {
    const snapshot = JSON.parse(row.snapshot), controller = new AbortController(); let execution;
    const deadline = snapshot.admission.deadline, admission = { ...snapshot.admission, sourceServiceExecutionId: snapshot.sourceServiceExecutionId,
      sourceExecutionRoot: path.join(output, snapshot.sourceServiceExecutionId), outputDirectory: path.join(output, row.id) };
    let timedOut = false, phase = 'planning';
    const initial = { id: randomUUID(), ...contextBinding(row), attemptId: randomUUID(), kind: 'web_recheck', profileId: webProfile.id,
      providerKind: 'model', reviewerKind: 'model', status: 'preparing', calls: 0, reviewCalls: 0, budget: recheckBudget,
      usage: { inputTokens: null, outputTokens: null }, events: [], versions: [], gitCommands: [] };
    const stop = timeout => {
      if (controller.signal.aborted) return;
      timedOut = timeout; initial.status = 'stopping'; initial.error = timeout ? '复验总时长已用尽，正在等待来源核对或执行停止。' : '复验已请求停止，正在等待核对结束。';
      controller.abort(); execution?.cancel();
      queueMicrotask(() => { try { snapshotHandle(row.id); } catch { /* An expired controller cannot publish. */ } });
    };
    const timer = setTimeout(() => stop(true), Math.max(1, deadline - Date.now()));
    const remaining = () => {
      const value = deadline - Date.now(); if (value < 1 && !controller.signal.aborted) stop(true);
      need(!controller.signal.aborted, 409, timedOut ? 'recheck_timed_out' : 'stopped', timedOut ? '复验总时长预算已耗尽。' : '复验已请求停止。');
      return Math.floor(value);
    };
    const rememberLate = outcome => {
      if (closed) return;
      try { sourceFailure(select(row.id), { ...(outcome.error || {}), reconciliationRequired: true, phase: 'recheck_admission_late' },
        { ...admission, inspectionSettled: true, lateResultAt: new Date().toISOString() }); } catch { /* Closed or superseded owners retain their previous unknown history. */ }
    };
    const stage = async (name, callback) => {
      remaining(); phase = name; let abort, drainTimer;
      const pending = Promise.resolve().then(() => { remaining(); return callback(); }).then(value => ({ value }), error => ({ error }));
      const aborted = new Promise(resolve => { abort = () => resolve(null); controller.signal.addEventListener('abort', abort, { once: true }); if (controller.signal.aborted) abort(); });
      let outcome;
      try {
        outcome = await Promise.race([pending, aborted]);
        if (!outcome) {
          outcome = await Promise.race([pending, new Promise(resolve => { drainTimer = setTimeout(() => resolve(null), ADMISSION_CLEANUP_MS); })]);
          if (!outcome) {
            void pending.then(rememberLate);
            throw Object.assign(new Error('来源核对尚未结束，进程停止需人工协调。'), { reconciliationRequired: true, code: 'reconciliation_required', phase: 'recheck_admission' });
          }
        }
        if (outcome.error) throw outcome.error;
        remaining(); return outcome.value;
      } finally { clearTimeout(drainTimer); controller.signal.removeEventListener('abort', abort); }
    };
    const done = (async () => {
      try {
        await stage('planning', () => assertCurrent(row.id, contextBinding(row)));
        const source = originalSource(select(snapshot.sourceServiceExecutionId));
        Object.assign(admission, { sourceReportPath: source.sourceReportPath, sourceWorkspace: source.record.workspace });
        db.prepare('UPDATE executions SET snapshot=? WHERE id=? AND owner=?').run(JSON.stringify({ ...JSON.parse(select(row.id).snapshot), admission: { ...admission } }), row.id, owner);
        need(digest(JSON.parse(source.row.binding)) === digest(JSON.parse(row.binding)), 409, 'stale_version', '来源不属于当前确认的规划版本。');
        const inspected = await stage('source_inspection', () => deps.inspectRecheckSource({ executionRoot: source.executionRoot, sourceReportPath: source.sourceReportPath, sourceBinding: source.sourceBinding, signal: controller.signal }));
        const summary = inspectMatches(inspected, source); await stage('planning_after_inspection', () => assertCurrent(row.id, contextBinding(row)));
        remaining();
        const latest = select(row.id), updated = { ...JSON.parse(latest.snapshot), sourceProof: { sourceExecutionId: summary.sourceExecutionId,
          sourceReportHash: summary.sourceReportHash, sourceCommit: summary.sourceCommit, sourceHash: summary.sourceHash, sourceShellHash: summary.sourceShellHash } };
        db.prepare('UPDATE executions SET snapshot=? WHERE id=? AND owner=?').run(JSON.stringify(updated), row.id, owner);
        const reviewer = deps.reviewModel({ config }); const timeoutMs = remaining(); phase = 'recheck_execution';
        execution = deps.startRecheck({ executionRoot: source.executionRoot, sourceReportPath: source.sourceReportPath, sourceBinding: source.sourceBinding,
          outputDir: path.join(output, row.id), reviewer, executable, maxReviewCalls: recheckBudget.maxReviewCalls,
          timeoutMs, signal: controller.signal, assertCurrent: async value => { remaining(); await assertCurrent(row.id, value); remaining(); },
          onEvent: () => { queueMicrotask(() => { try { snapshotHandle(row.id); } catch { controller.abort(); execution?.cancel(); } }); } });
        const record = await execution.done;
        if (Date.now() >= deadline && !controller.signal.aborted) stop(true);
        return controller.signal.aborted && !uncertain(record) ? { ...record, status: timedOut ? 'timed_out' : 'stopped', error: initial.error } : record;
      } catch (error) {
        const unresolved = error.reconciliationRequired || error.code === 'reconciliation_required' || error.result?.terminationConfirmed === false;
        if (error.result || error.reconciliationRequired || error.code === 'reconciliation_required' || controller.signal.aborted) sourceFailure(select(row.id), error,
          { ...admission, phase, inspectionSettled: !error.reconciliationRequired, aborted: controller.signal.aborted });
        return { ...initial, ...execution?.snapshot(), ...contextBinding(row), status: unresolved ? 'reconciliation_required' : controller.signal.aborted ? timedOut ? 'timed_out' : 'stopped' : 'failed',
          finishedAt: new Date().toISOString(), error: unresolved ? '来源核对或执行停止尚未确认，已保留来源证据，需要人工核对后再继续。' : controller.signal.aborted ? initial.error : '固定代码复验准入或执行未完成，请核对当前版本和来源证据。', ...(error.result ? { failure: { result: error.result } } : {}) };
      } finally { clearTimeout(timer); }
    })();
    return { id: initial.id, done, snapshot: () => execution ? { ...execution.snapshot(), ...(controller.signal.aborted ? { status: 'stopping', error: initial.error } : {}) } : structuredClone(initial), cancel() { stop(false); } };
  }
  async function finish(id, record) {
    let row = select(id); if (!row || row.owner !== owner) return;
    const binding = JSON.parse(row.binding);
    need(['projectId', 'runId', 'taskId', 'specRevision', 'planRevision'].every(key => record[key] === binding[key]), 409, 'stale_execution', '执行返回的身份不属于固定版本。');
    const snapshot = JSON.parse(row.snapshot);
    if (snapshot.operation === 'recheck') need(record.kind === 'web_recheck' && record.calls === 0 && record.budget?.maxCalls === 0 && record.reviewCalls <= recheckBudget.maxReviewCalls
      && (record.status !== 'accepted' || snapshot.sourceProof && record.candidateCommit === snapshot.sourceProof.sourceCommit
        && record.versions?.at(-1)?.sourceHash === snapshot.sourceProof.sourceHash
        && ['sourceExecutionId', 'sourceReportHash', 'sourceCommit', 'sourceHash', 'sourceShellHash'].every(key => record.provenance?.[key] === snapshot.sourceProof[key])
        && digest(record.provenance?.sourceBinding) === digest(contextBinding(row))
        && samePath(record.provenance?.sourceExecutionRoot || '', path.join(output, snapshot.sourceServiceExecutionId))),
    409, 'stale_execution', '复验返回的编码次数或固定候选来源不一致。');
    const unchanged = await current(row); own(); row = select(id);
    need(row?.owner === owner, 409, 'stale_owner', '该执行不属于当前控制器。');
    let status = uncertain(record) || hasReconciliation(row) ? 'reconciliation_required' : unchanged ? record.status : 'superseded';
    if (row.status === 'cancel_requested' && status !== 'reconciliation_required') status = 'stopped';
    if (!TERMINAL.has(status) && status !== 'reconciliation_required') status = 'failed';
    if (status === 'accepted' && !isWebTaskAccepted(record)) status = 'failed';
    const blocked = knownBlocking(row, record); if (status === 'accepted' && blocked) status = 'failed';
    saveRecord(row, record, status, blocked ? blockingMessage : status === 'superseded' ? '规划确认版本已变化，旧结果仅保留历史。' : null);
    db.prepare('UPDATE executions SET control_version=control_version+1 WHERE id=?').run(id);
  }
  function startHandle(row) {
    const binding = JSON.parse(row.binding);
    let state;
    try {
      projectAdmission(row.project_id);
      const handle = JSON.parse(row.snapshot).operation === 'recheck' ? startOwnedRecheck(row) : deps.startExecution({ outputDir: path.join(output, row.id), binding, task: `${REFERENCE_NOTICE}\n关联规划版本：${JSON.stringify(binding)}`,
        provider: deps.codeModel({ config }), reviewer: deps.reviewModel({ config }), executable, ...budget,
        assertCurrent: value => assertCurrent(row.id, value), onEvent: () => { queueMicrotask(() => { try { snapshotHandle(row.id); } catch { state?.handle.cancel(); } }); } });
      need(handle && typeof handle.cancel === 'function' && typeof handle.snapshot === 'function' && handle.done?.then, 500, 'executor_invalid', '执行器没有返回有效生命周期。');
      state = { handle, done: null }; handles.set(row.id, state);
      state.done = Promise.resolve(handle.done).then(record => finish(row.id, record), () => finish(row.id, { ...raw(row), status: 'reconciliation_required', error: '执行器异常，进程停止状态需要核对。' }))
        .catch(() => { try { saveRecord(select(row.id), raw(select(row.id)), 'reconciliation_required', '执行记录发布失败，停止状态需要核对。'); } catch { /* An expired owner cannot publish. */ } })
        .finally(() => handles.delete(row.id));
    } catch { saveRecord(row, raw(row), 'failed', '执行器启动失败，请检查本地执行配置。'); }
  }
  function checkPayload(input, fields) { need(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => fields.includes(key)), 400, 'invalid_input', '不接受客户端路径、报告、预算或额外执行字段。'); }
  async function createAttempt(input, sourceRow = null) {
    const generation = projectAdmission(input.projectId), snapshot = await getSnapshot(input); projectAdmission(input.projectId, generation);
    need(input.profileId === webProfile.id && input.contractRevision === webExecutionContractRevision, 409, 'contract_changed', '参考项目范围或验收版本已变化，请刷新核对。');
    need(ready, 409, 'not_configured', '模型或受控执行环境尚未配置。');
    snapshot.contractRevision = webExecutionContractRevision;
    if (sourceRow) {
      sourceRow = select(sourceRow.id); originalSource(sourceRow);
      need(digest(JSON.parse(sourceRow.binding)) === digest(snapshot.binding), 409, 'stale_version', '当前来源或规划版本已变化，不能复验。');
      Object.assign(snapshot, { operation: 'recheck', sourceServiceExecutionId: sourceRow.id, sourceContractRevision: JSON.parse(sourceRow.snapshot).contractRevision });
    }
    const id = randomUUID(), row = transaction(() => {
      projectAdmission(input.projectId, generation); need(!hasActivity(input), 409, 'execution_active', '该规划已有执行、预览或停止状态待核对，不能重复启动。');
      const started = Date.now(); if (sourceRow) snapshot.admission = { startedAt: new Date(started).toISOString(), deadline: started + recheckBudget.timeoutMs, budget: { ...recheckBudget } };
      const attempt = db.prepare('SELECT COALESCE(MAX(attempt),0)+1 next FROM executions WHERE project_id=? AND run_id=?').get(input.projectId, input.runId).next;
      const record = { status: 'preparing', events: [], versions: [], usage: { inputTokens: null, outputTokens: null }, calls: 0, reviewCalls: 0, budget: sourceRow ? recheckBudget : budget };
      db.prepare('INSERT INTO executions(id,project_id,run_id,attempt,owner,binding,snapshot,record,status,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?)')
        .run(id, input.projectId, input.runId, attempt, owner, JSON.stringify(snapshot.binding), JSON.stringify(snapshot), JSON.stringify(record), 'preparing', new Date(started).toISOString()); return select(id);
    });
    startHandle(row); return { execution: await dto(select(id)) };
  }
  const issueDto = item => ({ id: safe(item.id), severity: item.severity === 'blocking' ? 'blocking' : 'advisory', status: item.status === 'resolved' ? 'resolved' : 'open',
    file: projectPath(item.file) !== null ? safe(item.file) : null,
    line: known(item.line), message: safe(item.message), evidence: safe(item.evidence), resolution: safe(item.resolution) });
  const comparisonDto = check => Object.fromEntries(['expected', 'actual'].filter(key => typeof check[key] === 'string').map(key => [key, safe(check[key])]));
  const checkDto = item => item ? { status: safe(item.status), checks: (Array.isArray(item.checks) ? item.checks : []).slice(0, 100).map(check => ({ id: safe(check.id), name: safe(check.name), passed: check.passed === true, error: safe(check.error), ...comparisonDto(check) })),
    terminationConfirmed: item.terminationConfirmed === true, error: safe(item.error) } : null;
  async function verifyRecheckSource(row) {
    const record = raw(row), snapshot = JSON.parse(row.snapshot), proof = snapshot.sourceProof, provenance = record.provenance;
    need(snapshot.operation === 'recheck' && ID.test(snapshot.sourceServiceExecutionId || '') && proof && record.kind === 'web_recheck' && record.calls === 0
      && provenance && ['sourceExecutionId', 'sourceReportHash', 'sourceCommit', 'sourceHash', 'sourceShellHash'].every(key => proof[key] === provenance[key])
      && record.candidateCommit === proof.sourceCommit && record.versions.at(-1).sourceHash === proof.sourceHash,
    409, 'source_changed', '复验快照的固定来源绑定无效。');
    const source = originalSource(select(snapshot.sourceServiceExecutionId));
    need(source.row.project_id === row.project_id && source.row.run_id === row.run_id && source.row.binding === row.binding
      && JSON.parse(source.row.snapshot).contractRevision === snapshot.sourceContractRevision
      && samePath(provenance.sourceExecutionRoot || '', source.executionRoot) && samePath(provenance.sourceReport || '', source.sourceReportPath)
      && digest(provenance.sourceBinding) === digest(source.sourceBinding), 409, 'source_changed', '复验不能引用其他项目、运行或客户端路径。');
    const ownedRoot = path.join(output, row.id), workspace = record.workspace, reportPath = record.reportPath;
    need(typeof workspace === 'string' && path.isAbsolute(workspace) && typeof reportPath === 'string' && samePath(path.dirname(workspace), path.dirname(reportPath))
      && path.basename(workspace) === 'workspace' && path.basename(reportPath) === 'execution.json'
      && samePath(path.dirname(path.dirname(workspace)), ownedRoot) && /^web-recheck-[\w-]+$/u.test(path.basename(path.dirname(workspace))),
    409, 'source_changed', '复验快照不属于服务为本次尝试创建的工作区。');
    await directory(workspace);
    const inspected = await deps.inspectRecheckSource({ executionRoot: source.executionRoot, sourceReportPath: source.sourceReportPath, sourceBinding: source.sourceBinding });
    inspectMatches(inspected, source, proof);
    const shell = await verifyWebShell({ workspace }), files = await readProjectFiles(workspace);
    need(shell.hash === proof.sourceShellHash && record.shellHash === shell.hash && digest(validateProjectFiles(files)) === proof.sourceHash
      && digest(validateProjectFiles(inspected.files)) === digest(validateProjectFiles(files)), 409, 'source_changed', '复验快照字节或保护外壳与原固定提交不一致。');
    return { files, shellHash: shell.hash };
  }
  async function dto(row) {
    const generation = projectGenerations.get(row.project_id) ?? 0;
    const unchanged = await current(row); own(); row = select(row.id);
    const valid = unchanged && !projectBarriers.has(row.project_id) && (projectGenerations.get(row.project_id) ?? 0) === generation;
    const record = raw(row), blocked = knownBlocking(row, record), contractRevision = JSON.parse(row.snapshot).contractRevision, accepted = row.status === 'accepted' && !blocked && !hasReconciliation(row) && valid && contractRevision === webExecutionContractRevision && isWebTaskAccepted(record), previewState = previewHandles.get(row.id);
    const snapshot = JSON.parse(row.snapshot), executionBudget = snapshot.admission?.budget ?? record.budget;
    return { id: row.id, attempt: row.attempt, kind: snapshot.operation === 'recheck' ? 'web_recheck' : 'web_execution',
      ...(snapshot.operation === 'recheck' ? { sourceExecutionId: snapshot.sourceServiceExecutionId, sourceCommit: snapshot.sourceProof?.sourceCommit ?? null } : {}),
      profileId: webProfile.id, contractRevision, recheckContractRevision: webExecutionContractRevision, referenceNotice: REFERENCE_NOTICE, recheckBudget: { ...recheckBudget },
      status: row.status, stage: safe(record.status), taskAccepted: accepted, calls: known(record.calls), reviewCalls: known(record.reviewCalls),
      usage: { inputTokens: known(record.usage?.inputTokens), outputTokens: known(record.usage?.outputTokens) }, budget: { maxCalls: known(executionBudget?.maxCalls), maxReviewCalls: known(executionBudget?.maxReviewCalls), timeoutMs: known(executionBudget?.timeoutMs) },
      versions: (record.versions || []).slice(-5).map(version => ({ commit: safe(version.commit), sourceHash: safe(version.sourceHash), selfCheck: checkDto(version.selfCheck),
        acceptance: version.acceptance ? { status: safe(version.acceptance.status), test: checkDto(version.acceptance.test), browser: checkDto(version.acceptance.browser),
          review: version.acceptance.review ? { status: safe(version.acceptance.review.status), summary: safe(version.acceptance.review.summary), openBlockingIssues: known(version.acceptance.review.openBlockingIssues) } : null,
          issues: (version.acceptance.issues || []).slice(0, 100).map(issueDto), openIssues: (version.acceptance.openIssues || []).slice(0, 100).map(issueDto) } : null })),
      diff: safe(record.diff), events: (record.events || []).slice(-100).map(item => ({ sequence: known(item.sequence), time: safe(item.time), message: safe(item.message) })), error: safe(blocked ? blockingMessage : row.error || record.error) || null,
      preview: previewState?.runtime && row.preview_state === 'running' ? { url: previewState.runtime.url, expiresAt: previewState.expiresAt } : null,
      actions: { canCancel: handles.has(row.id) && row.status !== 'cancel_requested', canRetry: valid && !row.active && !accepted && ready && row.preview_state === 'none'
        && !hasActivity(row),
        canRecheck: valid && ready && !hasActivity(row) && recheckPossible(row),
        canPreview: accepted && row.preview_state === 'none' && !hasActivity(row), canStopPreview: previewHandles.has(row.id), canDownload: accepted && !['unknown', 'stopping'].includes(row.preview_state) } };
  }
  function acceptedRow(id, previewState = null, controlVersion = null) {
    own(); const row = select(id);
    if (row) projectAdmission(row.project_id);
    need(row && !knownBlocking(row), 409, 'not_accepted', blockingMessage);
    need(row?.owner === owner && row.status === 'accepted' && JSON.parse(row.snapshot).contractRevision === webExecutionContractRevision
      && !hasReconciliation(row) && !['stopping', 'unknown'].includes(row.preview_state) && isWebTaskAccepted(raw(row))
      && (controlVersion === null || row.control_version === controlVersion), 409, 'not_accepted', '当前确认版本没有完整通过或控制状态已变化，不能预览或下载。');
    const activityMatches = previewState === null
      ? (row.preview_state === 'none' ? row.active === 0 : row.active === 1 && !!previewHandles.get(id))
      : row.preview_state === 'starting' && row.active === 1 && previewHandles.get(id) === previewState && !previewState.controller.signal.aborted;
    need(activityMatches, 409, 'not_accepted', '预览或执行活动状态已变化，不能继续发布。');
    return row;
  }
  function sourceFailure(row, error, admission = null) {
    own(); row = select(row.id); need(row?.owner === owner, 409, 'stale_owner', '旧控制器不能保存核对结果。');
    const command = error.command ? { executable: String(error.command.executable || '').slice(0, 256), workspace: String(error.command.workspace || '').slice(0, 2048), args: (Array.isArray(error.command.args) ? error.command.args : []).slice(0, 64).map(value => String(value).slice(0, 512)) } : null;
    const evidence = { ...privateProcessEvidence(error), phase: typeof error.phase === 'string' ? error.phase.slice(0, 128) : 'source_verification', command, result: error.result ? privateProcessEvidence(error.result) : null,
      ...(admission ? { admission } : {}) };
    db.prepare('INSERT INTO source_history VALUES(?,?,?,?)').run(randomUUID(), row.id, new Date().toISOString(), JSON.stringify(evidence));
    const unresolved = error.reconciliationRequired === true || error.code === 'reconciliation_required' || error.result?.terminationConfirmed === false || hasReconciliation(row);
    db.prepare('UPDATE executions SET status=?,active=?,error=?,control_version=control_version+1 WHERE id=? AND owner=?')
      .run(unresolved ? 'reconciliation_required' : 'failed', unresolved || row.preview_state !== 'none' ? 1 : 0,
        unresolved ? '源码核对进程停止尚未确认。' : '当前候选文件核对失败，既有通过记录只保留历史。', row.id, owner);
  }
  async function acceptedSource(row, previewState = null) {
    const generation = projectAdmission(row.project_id);
    row = acceptedRow(row.id, previewState); const version = row.control_version;
    need(await current(row), 409, 'not_accepted', '当前确认版本已变化。'); projectAdmission(row.project_id, generation); row = acceptedRow(row.id, previewState, version);
    let source;
    try { source = JSON.parse(row.snapshot).operation === 'recheck' ? await verifyRecheckSource(row) : await deps.verifySource(raw(row), path.join(output, row.id)); }
    catch (error) { sourceFailure(row, error); throw error; }
    projectAdmission(row.project_id, generation); row = acceptedRow(row.id, previewState, version);
    need(await current(row), 409, 'stale_version', '核对期间当前确认已变化。'); projectAdmission(row.project_id, generation); acceptedRow(row.id, previewState, version); return source;
  }
  const stopRuntimeOnce = state => state.runtimeStop ??= Promise.resolve().then(() => state.runtime.stop()).then(result => {
    state.stopResult = result; state.evidence.pid = result?.pid ?? state.evidence.pid; return result;
  }, error => { state.stopResult = error?.result; state.evidence.pid = error?.result?.pid ?? state.evidence.pid; throw error; });
  async function stopPreview(row) {
    const state = previewHandles.get(row.id); need(state, 409, 'preview_unknown', '当前控制器没有可确认停止的预览句柄。');
    if (state.stopping) return state.stopping;
    own(); db.prepare("UPDATE executions SET preview_state='stopping',control_version=control_version+1 WHERE id=? AND owner=?").run(row.id, owner);
    db.prepare("UPDATE preview_history SET state='stopping' WHERE id=?").run(state.id); state.controller.abort();
    state.stopping = (async () => {
      let result;
      try { if (!state.runtime) await state.starting; if (state.runtime) result = await stopRuntimeOnce(state); }
      catch (error) { result = state.stopResult ?? error?.result; }
      state.evidence.pid = result?.pid ?? state.evidence.pid;
      clearTimeout(state.timer); previewHandles.delete(row.id); own();
      const noProcessStarted = !state.spawnRequested, confirmed = cleanStop(result) || noProcessStarted;
      db.prepare('UPDATE preview_history SET state=?,record=? WHERE id=?').run(noProcessStarted ? 'not_started' : cleanStop(result) ? 'stopped' : 'unknown', JSON.stringify({ ...state.evidence,
        noProcessStarted,
        finishedAt: new Date().toISOString(), stop: result ? { ...privateProcessEvidence(result), pid: result.pid ?? state.evidence.pid,
          terminationConfirmed: result.terminationConfirmed === true, sourceUnchanged: result.sourceUnchanged === true, stopAcknowledged: result.stopAcknowledged === true } : null }), state.id);
      const latest = select(row.id);
      if (confirmed) db.prepare("UPDATE executions SET preview_state='none',active=?,control_version=control_version+1 WHERE id=? AND owner=?").run(latest.status === 'reconciliation_required' || hasReconciliation(latest) ? 1 : 0, row.id, owner);
      else db.prepare("UPDATE executions SET preview_state='unknown',status='reconciliation_required',active=1,error=?,control_version=control_version+1 WHERE id=? AND owner=?").run('预览进程停止或源码状态未确认，需人工核对。', row.id, owner);
      return result;
    })();
    return state.stopping;
  }
  async function preview(row) {
    const generation = projectAdmission(row.project_id);
    need(row.preview_state === 'none' && !hasActivity(row), 409, 'preview_active', '该规划已有执行、预览或停止状态待核对。');
    const source = await acceptedSource(row); available();
    const state = { id: randomUUID(), controller: new AbortController(), runtime: null, runtimeStop: null, stopResult: null, spawnRequested: false,
      starting: null, stopping: null, timer: null, expiresAt: null, evidence: { pid: null, startedAt: new Date().toISOString() } };
    transaction(() => {
      projectAdmission(row.project_id, generation);
      acceptedRow(row.id); need(!hasActivity(row), 409, 'preview_active', '该规划已有其他活动，不能重复启动。');
      db.prepare("UPDATE executions SET preview_state='starting',active=1,control_version=control_version+1 WHERE id=? AND owner=?").run(row.id, owner);
      db.prepare('INSERT INTO preview_history VALUES(?,?,?,?)').run(state.id, row.id, 'starting', JSON.stringify(state.evidence));
    });
    previewHandles.set(row.id, state);
    state.starting = (async () => {
      const workspace = await mkdtemp(path.join(previewsRoot, 'preview-')); await installWebShell({ workspace }); await applyProjectFiles({ workspace, files: source.files });
      state.evidence.workspace = workspace;
      need(digest(await readProjectFiles(workspace)) === raw(row).versions.at(-1).sourceHash, 409, 'source_changed', '预览快照与已验收源码不一致。');
      await acceptedSource(select(row.id), state);
      // No await between this fresh authoritative guard and dispatching a new process.
      acceptedRow(row.id, state); projectAdmission(row.project_id, generation); state.spawnRequested = true;
      db.prepare('UPDATE preview_history SET record=? WHERE id=?').run(JSON.stringify({ ...state.evidence, spawnRequested: true }), state.id);
      // The visible live-preview timer requests graceful stop before the runtime's hard kill deadline.
      const runtime = await deps.startRuntime({ workspace, executable, signal: state.controller.signal, timeoutMs: previewTimeoutMs + 15000, requestTimeoutMs: Math.min(10000, previewTimeoutMs), maxOutputBytes: 262144 });
      state.runtime = runtime;
      state.evidence.pid = runtime.pid ?? null;
      db.prepare('UPDATE preview_history SET record=? WHERE id=?').run(JSON.stringify({ ...state.evidence, spawnRequested: true }), state.id);
      if (state.controller.signal.aborted) throw Object.assign(new Error('预览启动已取消。'), { status: 409, code: 'preview_cancelled', result: await stopRuntimeOnce(state) });
      const url = new URL(runtime.url); need(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !!url.port && !url.username && !url.password, 500, 'preview_url', '预览地址必须是受控本机端口。');
      need(typeof runtime.stop === 'function' && runtime.done?.then, 500, 'preview_invalid', '预览缺少可确认停止的句柄。');
      await acceptedSource(select(row.id), state);
      acceptedRow(row.id, state); db.prepare("UPDATE executions SET preview_state='running',control_version=control_version+1 WHERE id=? AND owner=?").run(row.id, owner);
      state.expiresAt = new Date(Date.now() + previewTimeoutMs).toISOString();
      Object.assign(state.evidence, { pid: runtime.pid ?? null, expiresAt: state.expiresAt });
      db.prepare("UPDATE preview_history SET state='running',record=? WHERE id=?").run(JSON.stringify(state.evidence), state.id);
      state.timer = setTimeout(() => { void stopPreview(select(row.id)).catch(() => {}); }, previewTimeoutMs);
      void Promise.resolve(runtime.done).then(() => { if (previewHandles.get(row.id) === state) void stopPreview(select(row.id)).catch(() => {}); }, () => { if (previewHandles.get(row.id) === state) void stopPreview(select(row.id)).catch(() => {}); });
      return runtime;
    })();
    try {
      await state.starting; const execution = await dto(select(row.id)); own(); const latest = select(row.id);
      need(previewHandles.get(row.id) === state && !state.controller.signal.aborted && latest.status === 'accepted' && latest.preview_state === 'running'
        && latest.active === 1 && !hasReconciliation(latest), 409, 'preview_cancelled', '预览已停止或当前状态已变化。');
      return { execution, preview: { url: state.runtime.url, expiresAt: state.expiresAt } };
    }
    catch (error) { if (previewHandles.get(row.id) === state) await stopPreview(select(row.id)); throw Object.assign(new Error('预览启动未完成，请刷新核对状态。'), { status: 409, code: 'preview_failed' }); }
  }
  const controller = {
    async withProjectCheckpoint(projectId, work) {
      available(); identifier(projectId); need(typeof work === 'function', 400, 'invalid_input', '项目检查点需要可信内部回调。');
      need(!projectBarriers.has(projectId), 409, 'project_checkpoint', '该项目已有需求检查点。');
      const token = {}; projectBarriers.set(projectId, token);
      try {
        const active = db.prepare("SELECT 1 FROM executions WHERE project_id=? AND (active=1 OR status='reconciliation_required' OR preview_state!='none') LIMIT 1").get(projectId);
        const pendingHandle = [...handles.keys(), ...previewHandles.keys(), ...operations.keys()].some(id => select(id)?.project_id === projectId);
        need(!active && !pendingHandle && !projectOperations.get(projectId)?.size, 409, 'project_busy', '该项目仍有执行、预览、核对、下载或停止状态待确认，暂不能更新需求。');
        projectGenerations.set(projectId, (projectGenerations.get(projectId) ?? 0) + 1);
        return await work();
      } finally { if (projectBarriers.get(projectId) === token) projectBarriers.delete(projectId); }
    },
    async list(input) {
      checkPayload(input, ['projectId', 'runId']); available(); identifier(input.projectId); identifier(input.runId);
      const generation = projectGenerations.get(input.projectId) ?? 0, admissionOpen = !projectBarriers.has(input.projectId);
      let approved = false; try { await getSnapshot(input); approved = true; } catch (error) { if (error.status !== 409) throw error; }
      for (const [id] of handles) { const row = select(id); if (row.project_id === input.projectId && row.run_id === input.runId) { try { snapshotHandle(id); } catch {} } }
      for (const [id] of previewHandles) { const row = select(id); if (row.project_id === input.projectId && row.run_id === input.runId && !await current(row)) await stopPreview(row); }
      const rows = db.prepare('SELECT * FROM executions WHERE project_id=? AND run_id=? ORDER BY attempt DESC').all(input.projectId, input.runId);
      const executions = await Promise.all(rows.map(dto)), active = hasActivity(input), checkpoint = projectBarriers.has(input.projectId);
      const batchCurrent = admissionOpen && !checkpoint && generation === (projectGenerations.get(input.projectId) ?? 0);
      approved &&= batchCurrent;
      if (!approved) for (const execution of executions) {
        execution.taskAccepted = false; execution.preview = null;
        Object.assign(execution.actions, { canRetry: false, canRecheck: false, canPreview: false, canDownload: false });
      }
      return { capabilities: { canStart: approved && ready && !active && !checkpoint, profiles: [{ id: webProfile.id, title: '固定图书借阅参考项目', description: REFERENCE_NOTICE, contractRevision: webExecutionContractRevision }],
        reason: checkpoint ? '当前项目正在更新需求。' : !batchCurrent ? '项目检查点已变化，请刷新执行状态。' : !approved ? '当前规格和计划尚未同时确认。' : !ready ? '模型或受控执行环境尚未配置。' : active ? '已有执行、预览或进程状态待核对。' : null,
        model: { name: safe(config?.model || publicModel.model) }, budget: { ...budget }, recheckBudget: { ...recheckBudget } }, executions };
    },
    async start(input) { checkPayload(input, ['projectId', 'runId', 'profileId', 'contractRevision']); return createAttempt(input); },
    async action(input) {
      const paid = ['retry', 'recheck'].includes(input?.action);
      checkPayload(input, ['projectId', 'runId', 'executionId', 'action', ...(paid ? ['profileId', 'contractRevision'] : [])]);
      if (paid) need(typeof input.profileId === 'string' && typeof input.contractRevision === 'string', 400, 'invalid_input', '收费操作需要当前选择的参考范围与契约版本。');
      available(); identifier(input.projectId); identifier(input.runId); const row = lookup(input);
      if (paid) need(input.profileId === webProfile.id && input.contractRevision === webExecutionContractRevision, 409, 'contract_changed', '收费范围或契约已变化，请刷新并重新确认。');
      need(['cancel', 'retry', 'recheck', 'preview', 'stop_preview'].includes(input.action), 400, 'invalid_action', '执行操作无效。');
      if (input.action === 'cancel') { need(handles.has(row.id), 409, 'not_running', '该执行不在当前控制器中运行。'); db.prepare("UPDATE executions SET status=CASE WHEN status='reconciliation_required' THEN status ELSE 'cancel_requested' END,control_version=control_version+1 WHERE id=? AND owner=?").run(row.id, owner); handles.get(row.id).handle.cancel(); return { execution: await dto(select(row.id)) }; }
      if (input.action === 'retry') { need((await dto(row)).actions.canRetry, 409, 'cannot_retry', '当前状态不能重新执行。'); return createAttempt({ projectId: input.projectId, runId: input.runId, profileId: input.profileId, contractRevision: input.contractRevision }); }
      if (input.action === 'recheck') { need((await dto(row)).actions.canRecheck, 409, 'cannot_recheck', '当前来源、确认或活动状态不允许固定代码复验。'); return createAttempt({ projectId: input.projectId, runId: input.runId, profileId: input.profileId, contractRevision: input.contractRevision }, row); }
      if (input.action === 'stop_preview') { await stopPreview(row); return { execution: await dto(select(row.id)) }; }
      need(!operations.has(row.id), 409, 'operation_active', '该执行正在核对或启动预览。'); const operation = preview(row); operations.set(row.id, operation); try { return await operation; } finally { operations.delete(row.id); }
    },
    async download(input) {
      checkPayload(input, ['projectId', 'runId', 'executionId']); available(); const row = lookup(input); need(row.preview_state !== 'unknown', 409, 'reconciliation_required', '预览停止状态尚未确认。');
      const source = await acceptedSource(row), record = raw(row), snapshot = JSON.parse(row.snapshot), acceptance = record.versions.at(-1).acceptance;
      const delivery = await deps.createDelivery({ files: source.files, binding: acceptance.binding, report: acceptance, requirements: snapshot.source.content, spec: { ...webProfile.task, planningReference: snapshot.spec, notice: REFERENCE_NOTICE }, plan: snapshot.plan });
      await acceptedSource(select(row.id)); return { buffer: delivery.zip, filename: `library-web-${row.id}.zip`, contentType: 'application/zip' };
    },
    shutdown() { return shutdownPromise ??= (async () => {
      if (closed) return; closing = true;
      for (const [id, state] of handles) { try { own(); db.prepare("UPDATE executions SET status=CASE WHEN status='reconciliation_required' THEN status ELSE 'cancel_requested' END,control_version=control_version+1 WHERE id=? AND owner=?").run(id, owner); } catch {} state.handle.cancel(); }
      await Promise.allSettled([...handles.values()].map(state => state.done));
      await Promise.allSettled([...previewHandles.keys()].map(id => stopPreview(select(id))));
      await Promise.allSettled([...operations.values()]);
      await Promise.allSettled([...pendingOperations]);
      try { own(); db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE id=1 AND token=?').run(owner); } finally { db.close(); closed = true; }
    })(); },
  };
  return Object.freeze(Object.fromEntries(Object.entries(controller).map(([name, fn]) => [name, async (...args) => {
    let operation, projectId, ticket;
    try {
      if (['start', 'action', 'download'].includes(name) && typeof args[0]?.projectId === 'string' && ID.test(args[0].projectId)) {
        projectId = args[0].projectId; available();
        if (name !== 'action' || !['cancel', 'stop_preview'].includes(args[0].action)) projectAdmission(projectId);
        ticket = {}; if (!projectOperations.has(projectId)) projectOperations.set(projectId, new Set()); projectOperations.get(projectId).add(ticket);
      }
      operation = Promise.resolve(fn(...args)); if (name !== 'shutdown') pendingOperations.add(operation); return await operation;
    }
    catch (error) { if (name === 'withProjectCheckpoint') throw error;
      throw Object.assign(new Error(safe(error.status ? error.message : '本地执行资料不可用，请刷新后核对。')), { status: Number.isInteger(error.status) ? error.status : 500,
      code: typeof error.code === 'string' && /^[a-z_]+$/u.test(error.code) ? error.code : 'service_error' }); }
    finally {
      if (operation) pendingOperations.delete(operation);
      if (ticket) { const tickets = projectOperations.get(projectId); tickets?.delete(ticket); if (!tickets?.size) projectOperations.delete(projectId); }
    }
  }])));
}
