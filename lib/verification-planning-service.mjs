import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentRevision, planningRevision, assertSpecApproval } from './planning-review.mjs';
import { assertEngineeringAlignment } from './engineering-planner.mjs';
import { engineeringPlanPolicy } from './engineering-plan.mjs';
import { createVerificationModel, verificationModelPolicy, verificationRequestEvidence } from './verification-model.mjs';
import { inspectVerificationProposal, createVerificationControl, compileManifest, verificationPolicyHash } from './verification-contract.mjs';
import { guardModelContent } from './model-content-guard.mjs';
import { getModelConfig, snapshotModelControls } from './planner.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/u, HASH = /^[a-f0-9]{64}$/u;
const MAX_MANUAL_DEFINITIONS = 20;
const digest = value => createHash('sha256').update(value).digest('hex');
export const verificationPlanningPolicy = Object.freeze({ version: 'verification-planning-v1', coverage: 'structural_only',
  hash: contentRevision({ service: digest(readFileSync(new URL(import.meta.url))), model: verificationModelPolicy.hash, dsl: verificationPolicyHash,
    engineering: engineeringPlanPolicy.hash, alignment: digest(readFileSync(new URL('./engineering-planner.mjs', import.meta.url))), planning: digest(readFileSync(new URL('./planning-review.mjs', import.meta.url))) }) });
const failures = new WeakSet();
const fail = (status, code, message) => { const e = Object.assign(new Error(message), { status, code }); failures.add(e); throw e; };
const need = (condition, status, code, message) => { if (!condition) fail(status, code, message); };
const identifier = value => { need(typeof value === 'string' && ID.test(value), 400, 'invalid_id', '提案编号无效。'); return value; };
function fields(value, required, optional = [], exact = true) {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0, 400, 'invalid_input', '只接受普通数据对象。');
  const own = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  need(required.every(k => Object.hasOwn(own, k)) && (!exact || Object.keys(own).every(k => allowed.includes(k)))
    && allowed.filter(k => Object.hasOwn(own, k)).every(k => own[k].enumerable && Object.hasOwn(own[k], 'value')), 400, 'invalid_input', '字段缺失、含访问器或未授权能力字段。');
  return Object.fromEntries(allowed.filter(k => Object.hasOwn(own, k)).map(k => [k, own[k].value]));
}
function copyData(raw, maximum = 512 * 1024) {
  let count = 0, bytes = 0; const ancestors = new Set();
  function copy(value, depth) {
    need(++count <= 40000 && depth <= 24, 400, 'invalid_input', '提案数据结构超限。');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); need(value.isWellFormed() && bytes <= maximum, 400, 'invalid_input', '提案文本无效或超限。'); return value; }
    if (typeof value === 'number') { need(Number.isFinite(value), 400, 'invalid_input', '提案数值必须有限。'); return value; }
    const array = Array.isArray(value);
    need(value && typeof value === 'object' && Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype) && !ancestors.has(value), 400, 'invalid_input', '仅接受无循环纯JSON。');
    const keys = Reflect.ownKeys(value); need(keys.length <= 40000, 400, 'invalid_input', '字段数量超限。');
    const own = Object.getOwnPropertyDescriptors(value), length = array ? own.length.value : 0;
    need(!array || length <= 2000 && keys.length === length + 1, 400, 'invalid_input', '数组必须连续且有界。');
    ancestors.add(value); const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      need(typeof key === 'string' && key.isWellFormed() && !['__proto__', 'prototype', 'constructor'].includes(key) && own[key].enumerable && Object.hasOwn(own[key], 'value')
        && (!array || /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < length), 400, 'invalid_input', '数据不能含访问器、符号或附加数组字段。');
      bytes += Buffer.byteLength(key); need(bytes <= maximum, 400, 'invalid_input', '数据超出字节预算。'); result[key] = copy(own[key].value, depth + 1);
    }
    ancestors.delete(value); return result;
  }
  const value = copy(raw, 0); need(Buffer.byteLength(JSON.stringify(value)) <= maximum, 400, 'invalid_input', '编码后数据超限。'); return value;
}
const feedbackText = value => { need(typeof value === 'string' && value.trim() && value.length <= 5000, 400, 'invalid_feedback', '请提供最多5000字符的审阅依据。'); return value; };
const known = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function directory(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.resolve(value) !== path.parse(value).root, 500, 'invalid_root', '需要专用可信绝对目录。');
  const absolute = path.resolve(value); let at = path.parse(absolute).root;
  for (const part of absolute.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part); try { await mkdir(at, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await lstat(at); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(at), at), 500, 'invalid_root', '目录父链不可使用链接。');
  }
  return absolute;
}
function race(callback, signal) {
  if (signal.aborted) return Promise.reject(new Error('interrupted'));
  let abort; const pending = Promise.resolve().then(() => { if (signal.aborted) throw new Error('interrupted'); return callback(); });
  const stop = new Promise((_, reject) => { abort = () => reject(new Error('interrupted')); signal.addEventListener('abort', abort, { once: true }); });
  return Promise.race([pending, stop]).finally(() => signal.removeEventListener('abort', abort));
}
function planningData(raw, projectId, runId) {
  const pair = fields(raw, ['project', 'run']);
  const project = fields(pair.project, ['id'], ['currentSourceRevision', 'sourceGeneration'], false);
  const runFields = fields(pair.run, ['id', 'projectId', 'workflowVersion', 'sourceSnapshot', 'sourceRevision', 'spec', 'specRevision', 'planRevision', 'approvals', 'tasks', 'artifacts', 'engineeringPlan', 'review', 'status', 'stages'], ['sourceSuperseded', 'sourceGeneration', 'specQuestions'], false);
  const generation = value => { need(value === undefined || Number.isSafeInteger(value) && value >= 0, 409, 'stale_planning', '需求来源代次无效。'); return value === undefined ? 0 : value; };
  const projectGeneration = generation(project.sourceGeneration), runGeneration = generation(runFields.sourceGeneration);
  // Legacy absence/undefined is the only default; never repair malformed persisted attribution.
  if (runFields.sourceGeneration === undefined) delete runFields.sourceGeneration;
  const run = copyData(runFields, 2 * 1024 * 1024);
  need(project.id === projectId && run.id === runId && run.projectId === projectId, 404, 'not_found', '未找到该项目运行。');
  need(run.workflowVersion === 2 && run.sourceSuperseded !== true && (!Object.hasOwn(project, 'currentSourceRevision') || project.currentSourceRevision === run.sourceRevision)
    && projectGeneration === runGeneration, 409, 'stale_planning', '需求来源已变化或不是当前新版运行。');
  try {
    assertSpecApproval(run);
    need(contentRevision(run.sourceSnapshot) === run.sourceRevision && planningRevision(run) === run.planRevision && run.approvals.plan?.revision === run.planRevision
      && run.approvals.plan.specRevision === run.specRevision && run.review?.passed === true && !run.review.issues?.length && ['succeeded', 'running'].includes(run.status)
      && !run.stages.some(s => s.status === 'running' && s.id !== 'export'), 409, 'approval_required', '当前规格和工程计划须先完成双确认。');
    const engineering = assertEngineeringAlignment(run);
    need(run.tasks.length > 0 && [run.sourceRevision, run.specRevision, run.planRevision, engineering.hash].every(v => typeof v === 'string' && HASH.test(v)), 409, 'approval_required', '当前版本绑定不完整。');
    const binding = { projectId, runId, specRevision: run.specRevision, planRevision: run.planRevision };
    const context = { binding, task: { title: run.spec.title, summary: run.spec.summary, goals: run.spec.goals, roles: run.spec.roles, constraints: run.spec.constraints,
      acceptanceScenarios: run.spec.acceptanceScenarios, tasks: run.tasks.map(t => ({ id: t.id, title: t.title, description: t.description, requirementIds: t.requirementIds, dependsOn: t.dependsOn, inputs: t.inputs, outputs: t.outputs, acceptance: t.acceptance, writePaths: t.writePaths ?? t.suggestedFiles })) },
    requirements: run.spec.requirements.map(r => ({ id: r.id, text: `${r.title}\n${r.description}\n${r.acceptance.join('\n')}` })),
    engineeringContract: { entities: engineering.proposal.entities, routes: engineering.proposal.routes, views: engineering.proposal.views, roleDefinitions: engineering.roleDefinitions } };
    copyData(context, verificationModelPolicy.contextBytes);
    const fullBinding = { ...binding, sourceRevision: run.sourceRevision, sourceGeneration: runGeneration, engineeringHash: engineering.hash,
      contextHash: contentRevision(context), policyHash: verificationPlanningPolicy.hash };
    return { context, binding: fullBinding, key: contentRevision(fullBinding) };
  } catch (e) { if (failures.has(e)) throw e; fail(409, 'approval_required', '当前规格、计划和工程草案不一致或尚未确认。'); }
}

/** Stores structural proposals only. No compile, beginCoding or runner capability is exposed. */
export function inspectVerificationPlanning(raw, projectId, runId) {
  return planningData(raw, projectId, runId);
}

export async function createVerificationPlanningService(options) {
  const ownOptions = fields(options, ['rootDir', 'getPlanning'], ['getPlanningSync', 'config', 'getConfig', 'maxAttempts', 'timeoutMs', 'cleanupMs', 'dependencies']);
  const { getPlanning } = ownOptions, maxAttempts = ownOptions.maxAttempts === undefined ? 3 : ownOptions.maxAttempts,
    timeoutMs = ownOptions.timeoutMs === undefined ? 60000 : ownOptions.timeoutMs, cleanupMs = ownOptions.cleanupMs === undefined ? 250 : ownOptions.cleanupMs;
  need(typeof getPlanning === 'function' && (ownOptions.getPlanningSync === undefined || typeof ownOptions.getPlanningSync === 'function') && Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 3 && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000
    && Number.isInteger(cleanupMs) && cleanupMs >= 1 && cleanupMs <= 2000, 500, 'invalid_config', '提案服务预算或规划入口无效。');
  need(ownOptions.getConfig === undefined || typeof ownOptions.getConfig === 'function', 500, 'invalid_config', '模型配置入口无效。');
  const initialPublicConfig = getModelConfig();
  const initialSelected = fields(ownOptions.getConfig ? { baseUrl: '', model: '', apiKey: '', thinking: undefined, jsonMode: undefined } : ownOptions.config ?? { baseUrl: initialPublicConfig.baseUrl, model: initialPublicConfig.model, apiKey: process.env.LLM_API_KEY || '' }, ['baseUrl', 'model'], ['apiKey', 'thinking', 'jsonMode']);
  const initialControls = snapshotModelControls(initialSelected);
  const initialConfig = { ...copyData(Object.fromEntries(Object.entries(initialSelected).filter(([key]) => !['thinking', 'jsonMode'].includes(key))), 8192), thinking: initialControls.thinking, jsonMode: initialControls.jsonMode };
  const secrets = new Set();
  function modelSelection() {
    try {
    const supplied = fields(ownOptions.getConfig ? ownOptions.getConfig() : initialConfig, ['baseUrl', 'model'], ['apiKey', 'thinking', 'jsonMode']);
    const controls = snapshotModelControls(supplied);
    const values = copyData(Object.fromEntries(Object.entries(supplied).filter(([key]) => !['thinking', 'jsonMode'].includes(key))), 8192);
    need(typeof values.baseUrl === 'string' && typeof values.model === 'string' && (values.apiKey === undefined || typeof values.apiKey === 'string'), 500, 'invalid_config', '模型配置无效。');
    const settings = Object.freeze({ ...values, thinking: controls.thinking, jsonMode: controls.jsonMode });
    if (settings.apiKey) secrets.add(settings.apiKey);
    noSecret({ model: settings.model });
    return { settings, ready: !!settings.baseUrl.trim() && !!settings.model.trim() && (!!ownOptions.getConfig || ownOptions.config !== undefined || initialPublicConfig.configured),
      contractRevision: contentRevision({ policyHash: verificationPlanningPolicy.hash, endpoint: settings.baseUrl.trim(), model: settings.model.trim(), controls, maxAttempts, timeoutMs }) };
    } catch (error) {
      if (!ownOptions.getConfig) throw error;
      return { settings: Object.freeze({ baseUrl: '', model: '', apiKey: '', thinking: undefined, jsonMode: undefined }), ready: false,
        contractRevision: contentRevision({ policyHash: verificationPlanningPolicy.hash, configured: false, maxAttempts, timeoutMs }) };
    }
  }
  const deps = fields(ownOptions.dependencies === undefined ? {} : ownOptions.dependencies, [], ['createModel', 'writeReceipt', 'isProcessAlive']);
  for (const value of Object.values(deps)) need(typeof value === 'function', 500, 'invalid_config', '可信依赖必须是函数。');
  const createModel = deps.createModel ?? createVerificationModel;
  function noSecret(value) { for (const key of secrets) need(!guardModelContent(JSON.stringify(value), key, 512 * 1024).credentialResponse, 400, 'credential_response', '资料包含配置凭据，拒绝保存或发送。'); }
  modelSelection();
  const root = await directory(ownOptions.rootDir), receipts = await directory(path.join(root, 'receipts')), filename = path.join(root, 'verification.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) { try { const s = await lstat(filename + suffix); need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 500, 'invalid_root', '私有数据库不可使用链接。'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const db = new DatabaseSync(filename);
  try { await chmod(filename, 0o600); db.exec(`PRAGMA busy_timeout=1000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY,token TEXT,pid INTEGER);
    CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,owner TEXT NOT NULL,attempt INTEGER NOT NULL,
    context_key TEXT NOT NULL,snapshot TEXT NOT NULL,status TEXT NOT NULL,active INTEGER NOT NULL,proposal TEXT,revision TEXT,manifest_hash TEXT,rejected_hash TEXT,
    history TEXT NOT NULL,approval TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,finish_reason TEXT,receipt_state TEXT NOT NULL,receipt_hash TEXT,receipt_bytes INTEGER,
    dispatched INTEGER NOT NULL DEFAULT 0,error TEXT,started_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE IF NOT EXISTS rejections(context_key TEXT NOT NULL,manifest_hash TEXT NOT NULL,PRIMARY KEY(context_key,manifest_hash));
    CREATE INDEX IF NOT EXISTS rejected_manifest ON rejections(manifest_hash);
    CREATE TABLE IF NOT EXISTS execution_freezes(proposal_id TEXT PRIMARY KEY,context_key TEXT NOT NULL,revision TEXT NOT NULL,manifest_hash TEXT NOT NULL,started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_executions(job_id TEXT PRIMARY KEY,execution_id TEXT UNIQUE NOT NULL,proposal_id TEXT NOT NULL,
      context_key TEXT NOT NULL,revision TEXT NOT NULL,manifest_hash TEXT NOT NULL,approval_hash TEXT NOT NULL,phase TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS active_project ON proposals(project_id,active);
    CREATE UNIQUE INDEX IF NOT EXISTS run_attempt ON proposals(project_id,run_id,attempt);`);
    if (!db.prepare('PRAGMA table_info(proposals)').all().some(column => column.name === 'origin')) db.exec("ALTER TABLE proposals ADD COLUMN origin TEXT NOT NULL DEFAULT 'model' CHECK(origin IN ('model','manual'))");
    db.exec('COMMIT'); }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw e; }
  const owner = randomUUID(), states = new Map(), operations = new Set(), barriers = new Map(), generations = new Map(), control = createVerificationControl(), handles = new Map(), executions = new Map(), workerGrants = new WeakMap();
  let closing = false, closed = false, shutdownPromise;
  const transaction = work => { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  try { transaction(() => {
    const old = db.prepare('SELECT * FROM owner WHERE id=1').get();
    let alive = false; if (old?.token) { try { alive = deps.isProcessAlive ? deps.isProcessAlive(old.pid) : (process.kill(old.pid, 0), true); } catch (e) { alive = e.code !== 'ESRCH'; } }
    need(!alive, 409, 'owner_active', '该提案目录已有活动控制器。');
    db.prepare("UPDATE proposals SET status='reconciliation_required',active=1,error='interrupted',receipt_state=CASE WHEN receipt_state='writing' THEN 'unknown' ELSE receipt_state END WHERE active=1 AND NOT EXISTS(SELECT 1 FROM worker_executions w WHERE w.proposal_id=proposals.id AND w.phase='active')").run();
    db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid);
  }); } catch (e) { db.close(); throw e; }
  const owns = () => !closed && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner;
  const available = () => { need(owns(), 409, 'stale_owner', '提案控制器归属已失效。'); need(!closing, 503, 'shutting_down', '提案服务正在停止。'); };
  const active = pid => !!db.prepare('SELECT 1 FROM proposals WHERE project_id=? AND active=1 LIMIT 1').get(pid);
  const admission = (pid, generation = generations.get(pid) ?? 0) => { available(); need(!barriers.has(pid), 409, 'project_checkpoint', '项目正在安全检查点。'); need((generations.get(pid) ?? 0) === generation, 409, 'stale_planning', '项目检查点已变化。'); };
  const select = id => db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
  // The DSL manifest already binds project/run/spec/plan, requirements and DSL
  // policy. A service implementation fingerprint must not erase a human reject.
  const rejectedManifest = manifestHash => !!db.prepare('SELECT 1 FROM rejections WHERE manifest_hash=? LIMIT 1').get(manifestHash);
  const originCount = (input, origin) => db.prepare('SELECT COUNT(*) n FROM proposals WHERE project_id=? AND run_id=? AND origin=?').get(input.projectId, input.runId, origin).n;
  const nextAttempt = input => db.prepare('SELECT COALESCE(MAX(attempt),0)+1 n FROM proposals WHERE project_id=? AND run_id=?').get(input.projectId, input.runId).n;
  function frozenPlanning(binding) {
    return db.prepare('SELECT p.snapshot FROM execution_freezes f JOIN proposals p ON p.id=f.proposal_id WHERE p.project_id=? AND p.run_id=?').all(binding.projectId, binding.runId)
      .some(item => { const saved = JSON.parse(item.snapshot).context.binding;
        return ['projectId', 'runId', 'specRevision', 'planRevision'].every(key => saved[key] === binding[key]); });
  }
  const lookup = input => { const row = select(input.proposalId); need(row && row.project_id === input.projectId && row.run_id === input.runId, 404, 'not_found', '未找到该运行提案。'); return row; };
  const revisionOf = (definition, snapshot) => contentRevision({ proposal: definition, binding: snapshot.binding, policyHash: verificationPlanningPolicy.hash });
  function inspect(proposal, snapshot) {
    try { const checked = inspectVerificationProposal({ proposal, requirements: snapshot.context.requirements.map(r => r.id), binding: snapshot.context.binding, tasks: snapshot.context.task.tasks });
      const definition = Object.fromEntries(['version', 'id', 'name', 'sessions', 'steps', 'limits', ...(checked.browser ? ['browser'] : []), ...(checked.taskScopes ? ['taskScopes'] : [])].map(k => [k, checked[k]]));
      return { definition, manifestHash: checked.manifestHash, revision: revisionOf(definition, snapshot) };
    } catch { fail(400, 'invalid_proposal', '提案未满足当前HTTP DSL结构、覆盖或依赖规则。'); }
  }
  const metadataHistory = row => JSON.parse(row.history).map(({ revision, manifestHash, status, feedback, at }) => ({ revision, manifestHash, status, feedback, at }));
  function dto(row, current) {
    const approval = row.approval ? JSON.parse(row.approval) : null, definition = row.proposal ? JSON.parse(row.proposal) : null;
    const frozen = frozenPlanning(JSON.parse(row.snapshot).context.binding);
    const approved = current && row.status === 'approved' && approval?.revision === row.revision;
    return { id: row.id, projectId: row.project_id, runId: row.run_id, attempt: row.attempt, origin: row.origin, status: row.status, current, coverage: 'structural_only', executed: false, approved,
      notice: '仅测试定义与人工审阅，尚未执行测试或证明软件通过。', binding: JSON.parse(row.snapshot).binding, revision: row.revision, proposal: definition,
      manifestHash: row.manifest_hash, policyHash: verificationPlanningPolicy.hash, approval, history: metadataHistory(row), frozenForCoding: frozen,
      model: row.model, usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens }, finishReason: row.finish_reason, dispatched: !!row.dispatched,
      receiptState: row.receipt_state, receipt: row.receipt_hash ? { sha256: row.receipt_hash, bytes: row.receipt_bytes } : null,
      error: row.error ? '提案未获得完整有效结论，请保留历史并核对状态。' : null, errorCode: row.error, startedAt: row.started_at, finishedAt: row.finished_at,
      actions: { canCancel: states.has(row.id) && row.status === 'generating', canRevise: current && !frozen && ['draft', 'rejected', 'approved'].includes(row.status),
        canApprove: current && !frozen && row.status === 'draft' && !rejectedManifest(row.manifest_hash), canReject: current && !frozen && ['draft', 'approved'].includes(row.status) } };
  }
  const readPlanning = async (pid, rid, signal) => {
    const raw = await race(() => getPlanning(pid, rid), signal);
    try { return planningData(raw, pid, rid); }
    catch (e) { if (e.status === 404 || e.status === 409) throw e; fail(409, 'approval_required', '当前规格、计划和工程草案尚未完整发布。'); }
  };
  const revoke = row => { const handle = handles.get(row.id); if (handle) { try { control.revoke(handle); } catch {} handles.delete(row.id); } };
  const errorCodes = new Set(['invalid_input', 'invalid_model_response', 'invalid_proposal', 'credential_response', 'receipt_failed', 'abnormal_finish', 'response_too_large', 'response_error', 'transport_error', 'http_error', 'model_timeout', 'cancelled', 'stale_planning', 'not_configured']);
  const boundedSettle = async promises => { let timer; try { await Promise.race([Promise.allSettled(promises), new Promise(r => { timer = setTimeout(r, cleanupMs); })]); } finally { clearTimeout(timer); } };
  function runModel(row, settings) {
    const key = settings.apiKey ?? '';
    const snapshot = JSON.parse(row.snapshot), controller = new AbortController(), state = { row, controller, alive: true, modelSettled: true, receiptSettled: true, receiptStarted: false, receiptFailed: false, pending: [], timedOut: false };
    const deadline = Date.parse(row.started_at) + timeoutMs;
    state.check = () => {
      need(owns() && state.alive, 409, 'stale_owner', '旧提案回调不可发布。');
      if (Date.now() >= deadline) { state.timedOut = true; controller.abort(); }
      need(!controller.signal.aborted && !closing && select(row.id)?.status === 'generating', 409, state.timedOut ? 'model_timeout' : 'cancelled', '提案请求已停止。');
      need(!state.receiptFailed, 400, 'receipt_failed', '本次回执边界已失效。');
      admission(row.project_id);
    };
    const timer = setTimeout(() => { state.timedOut = true; controller.abort(); }, Math.max(1, deadline - Date.now()));
    const receiptPath = path.join(receipts, `${row.id}.json`);
    state.done = Promise.resolve().then(async () => {
      try {
        state.check(); const current = await readPlanning(row.project_id, row.run_id, controller.signal); state.check();
        need(current.key === row.context_key, 409, 'stale_planning', '规划版本已变化。'); noSecret(snapshot.context);
        const model = createModel({ config: { ...settings, timeoutMs: Math.max(1, deadline - Date.now()) } });
        need(typeof model === 'function', 500, 'model_failed', '模型工厂无效。'); state.check();
        const onReceipt = async raw => {
          try {
            state.check(); need(!state.receiptStarted, 409, 'receipt_failed', '回执重复。');
            const receipt = copyData(fields(raw, ['model', 'finishReason', 'usage', 'content']), 2 * 1024 * 1024);
            fields(receipt.usage, ['inputTokens', 'outputTokens']);
            need(receipt.model === settings.model.trim() && typeof receipt.content === 'string' && Buffer.byteLength(receipt.content) <= 256 * 1024
              && ['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'unknown'].includes(receipt.finishReason)
              && Object.values(receipt.usage).every(v => v === null || known(v) !== null), 400, 'receipt_failed', '回执结构无效。');
            state.receiptStarted = true; const guarded = guardModelContent(receipt.content, key, 256 * 1024); receipt.content = guarded.content; state.credentialResponse = guarded.credentialResponse;
            state.receipt = receipt; db.prepare("UPDATE proposals SET model=?,input_tokens=?,output_tokens=?,finish_reason=?,receipt_state='writing' WHERE id=?").run(receipt.model, receipt.usage.inputTokens, receipt.usage.outputTokens, receipt.finishReason, row.id);
            const contents = JSON.stringify(receipt), writer = deps.writeReceipt ?? (async ({ filename, contents, signal }) => writeFile(filename, contents, { flag: 'wx', mode: 0o600, signal }));
            state.receiptSettled = false;
            const writing = Promise.resolve().then(async () => { state.check(); await writer({ filename: receiptPath, contents, signal: controller.signal });
              const stat = await lstat(receiptPath); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 2 * 1024 * 1024, 400, 'receipt_failed', '回执文件无效。');
              await chmod(receiptPath, 0o600);
              const bytes = await readFile(receiptPath); need(bytes.equals(Buffer.from(contents)), 400, 'receipt_failed', '回执落盘内容不一致。');
              state.check(); db.prepare("UPDATE proposals SET receipt_state='saved',receipt_hash=?,receipt_bytes=? WHERE id=?").run(digest(bytes), bytes.length, row.id);
            });
            state.pending.push(writing); writing.then(() => { state.receiptSettled = true; }, () => { state.receiptSettled = true; });
            try { await race(() => writing, controller.signal); } catch { state.check(); fail(500, 'receipt_failed', '私有回执未完整保存。'); }
          } catch (error) { state.receiptFailed = true; throw error; }
        };
        state.modelSettled = false;
        const request = Promise.resolve().then(() => { state.check(); db.prepare('UPDATE proposals SET dispatched=1 WHERE id=?').run(row.id); return model({ ...structuredClone(snapshot.context), signal: controller.signal, onReceipt }); });
        state.pending.push(request); request.then(() => { state.modelSettled = true; }, () => { state.modelSettled = true; });
        const response = copyData(await race(() => request, controller.signal)); state.check();
        fields(response, ['proposal', 'model', 'usage', 'policyHash', 'coverage']);
        need(state.receipt && select(row.id).receipt_state === 'saved' && state.receipt.finishReason === 'stop' && !state.credentialResponse, 400, state.credentialResponse ? 'credential_response' : 'receipt_failed', '未取得正常完整回执。');
        let returned; try { returned = JSON.parse(state.receipt.content); } catch { fail(400, 'invalid_model_response', '回执不是JSON提案。'); }
        need(contentRevision(response.proposal) === contentRevision(returned) && response.model === state.receipt.model && contentRevision(response.usage) === contentRevision(state.receipt.usage)
          && response.policyHash === verificationModelPolicy.hash && response.coverage === 'structural_only', 400, 'receipt_failed', '返回提案与回执或当前规则不一致。');
        const inspected = inspect(response.proposal, snapshot), currentFinal = await readPlanning(row.project_id, row.run_id, controller.signal); state.check();
        need(currentFinal.key === row.context_key, 409, 'stale_planning', '规划版本已变化。');
        transaction(() => { state.check(); db.prepare("UPDATE proposals SET proposal=?,revision=?,manifest_hash=?,status='draft',active=0,error=NULL,finished_at=? WHERE id=? AND owner=?").run(JSON.stringify(inspected.definition), inspected.revision, inspected.manifestHash, new Date().toISOString(), row.id, owner); });
      } catch (e) {
        controller.abort(); await boundedSettle(state.pending);
        if (owns()) {
          const code = state.timedOut ? 'model_timeout' : closing || select(row.id)?.status === 'cancel_requested' ? 'cancelled' : state.receiptFailed ? 'receipt_failed' : errorCodes.has(e.code) ? e.code : 'model_failed';
          // All incomplete dispatched requests (reset, truncated stream, abort,
          // timeout or an unproven adapter) remain unknown, not only cancellations.
          const evidence = verificationRequestEvidence(e);
          if (evidence && !evidence.dispatched) db.prepare('UPDATE proposals SET dispatched=0 WHERE id=? AND owner=?').run(row.id, owner);
          const remoteUnconfirmed = select(row.id)?.dispatched === 1 && !state.receiptStarted
            && !(evidence && (!evidence.dispatched || evidence.responseComplete));
          const unknown = !state.modelSettled || !state.receiptSettled || remoteUnconfirmed;
          const status = unknown ? 'reconciliation_required' : code === 'cancelled' ? 'cancelled' : code === 'model_timeout' ? 'timed_out' : code === 'stale_planning' ? 'stale' : 'failed';
          db.prepare("UPDATE proposals SET status=?,active=?,error=?,receipt_state=CASE WHEN receipt_state='writing' THEN ? ELSE receipt_state END,finished_at=? WHERE id=? AND owner=?").run(status, unknown ? 1 : 0, code, state.receiptSettled ? 'failed' : 'unknown', new Date().toISOString(), row.id, owner);
        }
      } finally { state.alive = false; clearTimeout(timer); states.delete(row.id); }
    });
    states.set(row.id, state);
  }

  const implementation = {
    async list(input, op) {
      const { settings, ready, contractRevision } = modelSelection();
      let current = null; try { current = await op.planning(); } catch (e) { if (e.status !== 409) throw e; }
      op.check(); const rows = db.prepare('SELECT * FROM proposals WHERE project_id=? AND run_id=? ORDER BY attempt').all(input.projectId, input.runId);
      const open = !barriers.has(input.projectId) && op.generation === (generations.get(input.projectId) ?? 0), busy = active(input.projectId);
      const count = rows.filter(row => row.origin === 'model').length, manualCount = rows.filter(row => row.origin === 'manual').length, frozen = current && frozenPlanning(current.context.binding);
      const commonReason = !current ? '当前工程计划尚未确认或来源已失效。' : !open ? '项目检查点已变化。' : busy ? '该项目有提案或未知回执待协调。' : frozen ? '本规划已进入编码，验收定义已冻结；修改验收须形成新规划版本。' : null;
      return { coverage: 'structural_only', capabilities: { canPropose: !!current && open && !busy && !frozen && ready && count < maxAttempts, contractRevision,
        budget: { maxAttempts, remainingAttempts: Math.max(0, maxAttempts - count), timeoutMs }, model: settings.model, reason: commonReason ?? (!ready ? '测试模型尚未配置。' : count >= maxAttempts ? '本运行测试模型尝试预算已用尽。' : null),
        canImportDefinition: !commonReason && manualCount < MAX_MANUAL_DEFINITIONS,
        manualBudget: { maxDefinitions: MAX_MANUAL_DEFINITIONS, remainingDefinitions: Math.max(0, MAX_MANUAL_DEFINITIONS - manualCount) },
        manualReason: commonReason ?? (manualCount >= MAX_MANUAL_DEFINITIONS ? '本运行人工定义数量已达上限。' : null) },
      proposals: rows.map(row => dto(row, !!current && open && !busy && current.key === row.context_key)) };
    },
    async propose(input, op) {
      const { settings, ready, contractRevision } = modelSelection();
      const snapshot = await op.planning(); op.admit(); noSecret(snapshot.context);
      need(!frozenPlanning(snapshot.context.binding), 409, 'definition_frozen', '本版本已进入编码，不能替换验收定义。');
      need(input.contractRevision === contractRevision, 409, 'contract_changed', '测试提案规则或预算已变化，请重新确认。'); need(ready, 409, 'not_configured', '测试模型尚未配置。');
      const row = transaction(() => { op.admit(); need(!active(input.projectId), 409, 'project_busy', '该项目有提案或未知回执待协调。');
        const count = originCount(input, 'model'); need(count < maxAttempts, 409, 'budget_exhausted', '本运行测试模型尝试预算已用尽。');
        const id = randomUUID(); db.prepare("INSERT INTO proposals(id,project_id,run_id,owner,attempt,context_key,snapshot,status,active,history,receipt_state,started_at) VALUES(?,?,?,?,?,?,?,'generating',1,'[]','not_received',?)").run(id, input.projectId, input.runId, owner, nextAttempt(input), snapshot.key, JSON.stringify(snapshot), new Date().toISOString()); return select(id); });
      runModel(row, settings); return { proposal: dto(row, true) };
    },
    async importDefinition(input, op) {
      const { contractRevision } = modelSelection();
      const snapshot = await op.planning(); op.admit(); feedbackText(input.feedback); noSecret({ context: snapshot.context, proposal: input.proposal, feedback: input.feedback });
      need(input.contractRevision === contractRevision, 409, 'contract_changed', '测试提案规则或预算已变化，请重新确认。');
      const inspected = inspect(input.proposal, snapshot), now = new Date().toISOString();
      const row = transaction(() => {
        op.admit(); need(!active(input.projectId), 409, 'project_busy', '该项目有提案或未知回执待协调。');
        need(!frozenPlanning(snapshot.context.binding), 409, 'definition_frozen', '本版本已进入编码，不能替换验收定义。');
        need(originCount(input, 'manual') < MAX_MANUAL_DEFINITIONS, 409, 'manual_budget_exhausted', '本运行人工定义数量已达上限。');
        const id = randomUUID(), history = [{ revision: inspected.revision, manifestHash: inspected.manifestHash, proposal: inspected.definition, status: 'imported', feedback: input.feedback, at: now }];
        db.prepare("INSERT INTO proposals(id,project_id,run_id,owner,attempt,context_key,snapshot,status,active,proposal,revision,manifest_hash,history,input_tokens,output_tokens,receipt_state,dispatched,started_at,finished_at,origin) VALUES(?,?,?,?,?,?,?,'draft',0,?,?,?,?,0,0,'not_applicable',0,?,?,'manual')")
          .run(id, input.projectId, input.runId, owner, nextAttempt(input), snapshot.key, JSON.stringify(snapshot), JSON.stringify(inspected.definition), inspected.revision, inspected.manifestHash, JSON.stringify(history), now, now);
        return select(id);
      });
      return { proposal: dto(row, true) };
    },
    async revise(input, op) { return edit(input, op, 'revise'); },
    async approve(input, op) { return edit(input, op, 'approve'); },
    async reject(input, op) { return edit(input, op, 'reject'); },
    async cancel(input) { const row = lookup(input), state = states.get(row.id); need(state && row.status === 'generating', 409, 'not_running', '当前控制器没有可取消请求。');
      db.prepare("UPDATE proposals SET status='cancel_requested' WHERE id=?").run(row.id); state.controller.abort(); return { proposal: dto(select(row.id), false) }; },
  };
  async function edit(input, op, action) {
    const before = lookup(input), current = await op.planning(); op.admit();
    const row = lookup(input); need(row.revision && input.revision === row.revision && before.revision === row.revision && row.context_key === current.key, 409, 'stale_revision', '提案或当前规划版本已变化。');
    need(!frozenPlanning(current.context.binding), 409, 'definition_frozen', '编码开始后验收定义只读，修改须新规划版本。');
    need(!active(input.projectId) && ['draft', 'rejected', 'approved'].includes(row.status), 409, 'project_busy', '提案尚不可审阅或有未知请求。');
    feedbackText(input.feedback); noSecret({ feedback: input.feedback, ...(action === 'revise' ? { proposal: input.proposal } : {}) });
    if (action === 'approve' && row.status === 'approved') return { proposal: dto(row, true) };
    const snapshot = JSON.parse(row.snapshot), history = JSON.parse(row.history);
    need(history.length < 60, 409, 'revision_limit', '提案审阅历史已达上限。');
    const inspected = inspect(action === 'revise' ? input.proposal : JSON.parse(row.proposal), snapshot);
    if (action === 'revise') need(inspected.manifestHash !== row.manifest_hash && history.filter(h => h.status === 'revised').length < 20, 409, 'no_change', '必须实际修订提案内容。');
    if (action === 'approve') need(row.status === 'draft' && !rejectedManifest(row.manifest_hash), 409, 'revision_required', '拒绝后必须实际修订，不能批准相同定义。');
    const now = new Date().toISOString(); history.push({ revision: row.revision, manifestHash: row.manifest_hash, proposal: JSON.parse(row.proposal), status: action === 'revise' ? 'revised' : action, feedback: input.feedback, at: now });
    transaction(() => { op.admit(); need(select(row.id).revision === input.revision && select(row.id).status === row.status, 409, 'stale_revision', '并发审阅已更新提案。'); revoke(row);
      if (action === 'approve') {
        const handle = control.approve({ proposal: inspected.definition, requirements: snapshot.context.requirements.map(r => r.id), binding: snapshot.context.binding, tasks: snapshot.context.task.tasks, feedback: input.feedback }); handles.set(row.id, handle);
        db.prepare("UPDATE proposals SET status='superseded' WHERE project_id=? AND run_id=? AND status='approved' AND id!=?").run(input.projectId, input.runId, row.id);
        const approval = { id: handle.id, revision: row.revision, approvedAt: now, feedback: input.feedback, phase: 'definition_only', coverage: 'structural_only' };
        db.prepare("UPDATE proposals SET status='approved',approval=?,history=? WHERE id=?").run(JSON.stringify(approval), JSON.stringify(history), row.id);
      } else {
        if (action === 'reject') db.prepare('INSERT OR IGNORE INTO rejections VALUES(?,?)').run(row.context_key, row.manifest_hash);
        db.prepare('UPDATE proposals SET status=?,proposal=?,revision=?,manifest_hash=?,rejected_hash=?,approval=NULL,history=? WHERE id=?').run(action === 'revise' ? 'draft' : 'rejected', JSON.stringify(inspected.definition), inspected.revision, inspected.manifestHash, action === 'reject' ? row.manifest_hash : row.rejected_hash, JSON.stringify(history), row.id);
      }
    });
    return { proposal: dto(select(row.id), true) };
  }
  const shapes = { list: ['projectId', 'runId'], propose: ['projectId', 'runId', 'contractRevision'], importDefinition: ['projectId', 'runId', 'contractRevision', 'proposal', 'feedback'], revise: ['projectId', 'runId', 'proposalId', 'revision', 'proposal', 'feedback'],
    approve: ['projectId', 'runId', 'proposalId', 'revision', 'feedback'], reject: ['projectId', 'runId', 'proposalId', 'revision', 'feedback'], cancel: ['projectId', 'runId', 'proposalId'] };
  const api = Object.fromEntries(Object.keys(shapes).map(name => [name, async raw => {
    const input = copyData(fields(raw, shapes[name])); identifier(input.projectId); identifier(input.runId); if (input.proposalId !== undefined) identifier(input.proposalId);
    const controller = new AbortController(), generation = generations.get(input.projectId) ?? 0, deadline = Date.now() + timeoutMs;
    available(); if (!['list', 'cancel'].includes(name)) admission(input.projectId, generation);
    let complete; const done = new Promise(resolve => { complete = resolve; });
    const op = { name, projectId: input.projectId, controller, generation, done, check() { available(); need(!controller.signal.aborted && Date.now() < deadline, 503, 'operation_stopped', '提案操作已停止。'); },
      admit() { this.check(); admission(input.projectId, generation); }, async planning() { this.check(); const snapshot = await readPlanning(input.projectId, input.runId, controller.signal); this.check(); return snapshot; } };
    operations.add(op); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await implementation[name](input, op); }
    catch (e) { if (failures.has(e)) throw e; if (controller.signal.aborted) fail(503, 'operation_stopped', '提案操作已停止。'); fail(500, 'service_failed', '提案服务未获得完整结论，请保留历史并重试读取。'); }
    finally { clearTimeout(timer); operations.delete(op); complete(); }
  }]));
  api.withProjectCheckpoint = async (projectId, work) => {
    available(); identifier(projectId); need(typeof work === 'function', 400, 'invalid_input', '检查点需要可信内部回调。');
    need(!barriers.has(projectId), 409, 'project_checkpoint', '项目已有检查点。'); let complete; const done = new Promise(r => { complete = r; }); barriers.set(projectId, done);
    try { need(!active(projectId) && ![...operations].some(op => op.projectId === projectId && op.name !== 'list'), 409, 'project_busy', '项目仍有提案、审阅或未知回执在途。'); generations.set(projectId, (generations.get(projectId) ?? 0) + 1); return await work(); }
    finally { barriers.delete(projectId); complete(); }
  };
  // Internal capability, deliberately absent from HTTP routes. A serialized
  // approval or candidate-provided report cannot create a compiled manifest.
  api.assertFrozenExecution = raw => {
    const input = copyData(fields(raw, ['projectId', 'runId', 'proposalId', 'revision']));
    for (const key of ['projectId', 'runId', 'proposalId']) identifier(input[key]);
    available(); need(typeof ownOptions.getPlanningSync === 'function', 409, 'execution_unavailable', '缺少当前规划同步门禁。');
    const snapshot = planningData(ownOptions.getPlanningSync(input.projectId, input.runId), input.projectId, input.runId), row = lookup(input);
    const frozen = db.prepare('SELECT * FROM execution_freezes WHERE proposal_id=?').get(row.id);
    need(row.status === 'approved' && row.revision === input.revision && row.context_key === snapshot.key && frozen?.revision === row.revision
      && frozen.manifest_hash === row.manifest_hash, 409, 'stale_revision', '冻结验收或当前规划已变化。');
    return structuredClone(snapshot.binding);
  };
  api.assertApprovedDefinition = raw => {
    const input = copyData(fields(raw, ['projectId', 'runId', 'proposalId', 'revision']));
    for (const key of ['projectId', 'runId', 'proposalId']) identifier(input[key]);
    available(); need(typeof ownOptions.getPlanningSync === 'function', 409, 'execution_unavailable', '缺少当前规划同步门禁。');
    const snapshot = planningData(ownOptions.getPlanningSync(input.projectId, input.runId), input.projectId, input.runId), row = lookup(input);
    need(HASH.test(input.revision) && row.status === 'approved' && row.revision === input.revision && row.context_key === snapshot.key && !!row.approval
      && JSON.parse(row.approval).revision === row.revision, 409, 'approval_required', '须先认可当前规划的同版本联合验收定义。');
    const checked = inspect(JSON.parse(row.proposal), snapshot);
    need(checked.manifestHash === row.manifest_hash && checked.revision === row.revision, 409, 'stale_revision', '当前验收定义或规则已变化。');
    return structuredClone(snapshot.binding);
  };
  // An explicit persistent job owns this approval independently of an API
  // callback. API shutdown never aborts or rewrites these durable rows.
  api.workerExecution = raw => {
    const input = copyData(fields(raw, ['projectId', 'runId', 'proposalId', 'revision', 'jobId', 'executionId']));
    for (const key of ['projectId', 'runId', 'proposalId', 'jobId', 'executionId']) identifier(input[key]);
    available(); need(typeof ownOptions.getPlanningSync === 'function', 409, 'execution_unavailable', '缺少持久作业的当前规划门禁。');
    const readCurrent = () => {
      const value = ownOptions.getPlanningSync(input.projectId, input.runId);
      need(!value?.then, 500, 'invalid_config', '持久作业门禁必须同步核对当前规划。');
      return planningData(value, input.projectId, input.runId);
    };
    const snapshot = readCurrent(), row = lookup(input), existing = db.prepare('SELECT * FROM worker_executions WHERE job_id=?').get(input.jobId);
    need(HASH.test(input.revision) && row.status === 'approved' && row.revision === input.revision && row.context_key === snapshot.key && !!row.approval,
      409, 'approval_required', '持久作业必须使用当前确认的同版本联合验收定义。');
    const approvalHash = digest(row.approval), inspected = inspect(JSON.parse(row.proposal), snapshot);
    need(inspected.revision === row.revision && inspected.manifestHash === row.manifest_hash, 409, 'stale_revision', '持久作业定义或执行规则已变化。');
    if (existing) need(existing.execution_id === input.executionId && existing.proposal_id === row.id && existing.context_key === snapshot.key
      && existing.revision === row.revision && existing.manifest_hash === row.manifest_hash && existing.approval_hash === approvalHash && ['active', 'completed'].includes(existing.phase),
    409, 'worker_authorization_changed', '原持久作业的审批身份已变化，不能重新派发。');
    else {
      admission(input.projectId); need(!active(input.projectId) && ![...operations].some(op => op.projectId === input.projectId && op.name !== 'list'), 409, 'project_busy', '项目已有审批或执行活动。');
      transaction(() => {
        need(!active(input.projectId), 409, 'project_busy', '项目已有持久作业。');
        db.prepare('INSERT OR IGNORE INTO execution_freezes VALUES(?,?,?,?,?)').run(row.id, row.context_key, row.revision, row.manifest_hash, new Date().toISOString());
        db.prepare("INSERT INTO worker_executions VALUES(?,?,?,?,?,?,?,'active',?)").run(input.jobId, input.executionId, row.id, snapshot.key, row.revision, row.manifest_hash, approvalHash, new Date().toISOString());
        db.prepare('UPDATE proposals SET active=1,owner=? WHERE id=?').run(`worker:${input.jobId}`, row.id);
      });
    }
    const compileInput = { proposal: inspected.definition, requirements: snapshot.context.requirements.map(item => item.id), binding: snapshot.context.binding, tasks: snapshot.context.task.tasks };
    const approval = handles.get(row.id) ?? control.approve({ ...compileInput, feedback: JSON.parse(row.approval).feedback });
    handles.set(row.id, approval); const manifest = compileManifest({ ...compileInput, approval }); control.beginCoding(approval);
    const assertCurrent = () => {
      available(); const live = lookup(input), durable = db.prepare('SELECT * FROM worker_executions WHERE job_id=?').get(input.jobId);
      need(durable && durable.execution_id === input.executionId && ['active', 'completed'].includes(durable.phase) && live.status === 'approved'
        && live.revision === input.revision && live.manifest_hash === inspected.manifestHash && live.context_key === readCurrent().key && digest(live.approval ?? '') === approvalHash,
      409, 'worker_authorization_changed', '原持久作业的当前规划或批准已失效。');
      return true;
    };
    assertCurrent(); const grant = Object.freeze({ manifest, task: { ...snapshot.context.task, requirements: structuredClone(snapshot.context.requirements), engineeringContract: snapshot.context.engineeringContract },
      binding: structuredClone(snapshot.binding), assertCurrent, proposalId: row.id, revision: row.revision, jobId: input.jobId, executionId: input.executionId });
    workerGrants.set(grant, input); return grant;
  };
  api.completeWorkerExecution = async (grant, args) => {
    const input = workerGrants.get(grant); need(input, 409, 'worker_authorization_required', '缺少本服务持久作业能力。'); grant.assertCurrent();
    const { assertVerifiedWorkerResult } = await import('./planned-worker-seals.mjs');
    const body = assertVerifiedWorkerResult(args?.permit, { ...args, manifest: grant.manifest, jobId: input.jobId });
    grant.assertCurrent(); need(body.executionId === input.executionId, 409, 'worker_authorization_changed', 'Worker终态不属于本次持久作业。');
    transaction(() => {
      grant.assertCurrent(); db.prepare("UPDATE worker_executions SET phase='completed' WHERE job_id=?").run(input.jobId);
      db.prepare('UPDATE proposals SET active=0 WHERE id=? AND owner=?').run(input.proposalId, `worker:${input.jobId}`);
    });
  };
  api.stopWorkerExecution = async (grant, args) => {
    const input = workerGrants.get(grant); need(input, 409, 'worker_authorization_required', '缺少本服务持久作业能力。'); grant.assertCurrent();
    const { assertVerifiedWorkerOutcome } = await import('./planned-worker-seals.mjs');
    const body = assertVerifiedWorkerOutcome(args?.permit, { ...args, manifest: grant.manifest, jobId: input.jobId });
    grant.assertCurrent(); need(body.executionId === input.executionId, 409, 'worker_authorization_changed', '停止证明不属于本次持久作业。');
    transaction(() => {
      grant.assertCurrent(); db.prepare("UPDATE worker_executions SET phase='completed' WHERE job_id=?").run(input.jobId);
      db.prepare('UPDATE proposals SET active=0 WHERE id=? AND owner=?').run(input.proposalId, `worker:${input.jobId}`);
    });
  };
  api.cancelRetiredWorkerExecution = async (raw, args) => {
    const input = copyData(fields(raw, ['projectId', 'runId', 'proposalId', 'revision', 'jobId', 'executionId']));
    for (const key of ['projectId', 'runId', 'proposalId', 'jobId', 'executionId']) identifier(input[key]);
    available(); const { assertVerifiedRetiredWorkerCancellation } = await import('./planned-worker-seals.mjs');
    const { body } = assertVerifiedRetiredWorkerCancellation(args?.permit, { store: args?.store, jobId: input.jobId });
    need(['projectId', 'runId', 'proposalId', 'revision', 'jobId', 'executionId'].every(key => input[key] === body[key]), 409, 'worker_authorization_changed', '退休费用许可不属于原持久作业。');
    transaction(() => {
      available(); const row = lookup(input), durable = db.prepare('SELECT * FROM worker_executions WHERE job_id=?').get(input.jobId);
      need(durable && ['active', 'cancelled'].includes(durable.phase) && durable.execution_id === input.executionId && durable.proposal_id === input.proposalId
        && durable.revision === input.revision && durable.manifest_hash === body.manifestHash, 409, 'worker_authorization_changed', '原作业身份或历史费用归属已变化。');
      db.prepare("UPDATE worker_executions SET phase='cancelled' WHERE job_id=?").run(input.jobId);
      db.prepare('UPDATE proposals SET active=0 WHERE id=? AND owner=?').run(row.id, `worker:${input.jobId}`);
    });
  };
  api.withApprovedExecution = async (raw, work) => {
    const input = copyData(fields(raw, ['projectId', 'runId', 'proposalId', 'revision']));
    for (const key of ['projectId', 'runId', 'proposalId']) identifier(input[key]);
    need(typeof work === 'function' && typeof ownOptions.getPlanningSync === 'function', 409, 'execution_unavailable', '缺少可信同步规划与执行入口。');
    const generation = generations.get(input.projectId) ?? 0;
    admission(input.projectId, generation);
    need(!active(input.projectId) && ![...operations].some(op => op.projectId === input.projectId && op.name !== 'list'), 409, 'project_busy', '项目有提案或审阅在途。');
    const readCurrent = () => {
      const value = ownOptions.getPlanningSync(input.projectId, input.runId);
      need(!value || typeof value.then !== 'function', 500, 'invalid_config', '执行规划门禁不能返回Promise。');
      return planningData(value, input.projectId, input.runId);
    };
    const snapshot = readCurrent(), row = lookup(input);
    need(HASH.test(input.revision) && row.revision === input.revision && row.status === 'approved' && row.context_key === snapshot.key, 409, 'approval_required', '必须使用当前规划认可的同版本测试定义。');
    const inspected = inspect(JSON.parse(row.proposal), snapshot);
    need(inspected.manifestHash === row.manifest_hash && inspected.revision === row.revision, 409, 'stale_revision', '保存的验收定义或规则已变化。');
    const compileInput = { proposal: inspected.definition, requirements: snapshot.context.requirements.map(item => item.id), binding: snapshot.context.binding, tasks: snapshot.context.task.tasks };
    const approval = handles.get(row.id) ?? control.approve({ ...compileInput, feedback: JSON.parse(row.approval).feedback });
    handles.set(row.id, approval);
    const manifest = compileManifest({ ...compileInput, approval });
    need(manifest.browser, 409, 'browser_required', '研发执行前须认可联合HTTP与浏览器测试定义。');
    const controller = new AbortController(), state = { alive: true, controller, done: null };
    const assertCurrent = () => {
      available(); need(state.alive && !controller.signal.aborted, 409, 'execution_stopped', '执行许可已停止。'); admission(input.projectId, generation);
      const live = lookup(input);
      need(live.status === 'approved' && live.active === 1 && live.revision === input.revision && live.context_key === readCurrent().key, 409, 'stale_revision', '当前规划或验收许可已变化。');
      return true;
    };
    transaction(() => {
      admission(input.projectId, generation); need(!active(input.projectId), 409, 'project_busy', '同项目已有在途执行。');
      db.prepare('INSERT OR IGNORE INTO execution_freezes VALUES(?,?,?,?,?)').run(row.id, row.context_key, row.revision, row.manifest_hash, new Date().toISOString());
      db.prepare('UPDATE proposals SET active=1,owner=? WHERE id=?').run(owner, row.id);
    });
    try { control.beginCoding(approval); }
    catch (error) { db.prepare('UPDATE proposals SET active=0 WHERE id=? AND owner=?').run(row.id, owner); throw error; }
    executions.set(row.id, state);
    state.done = (async () => {
      let completed = false;
      try {
        assertCurrent();
        const result = await work({ manifest, task: { ...snapshot.context.task, requirements: structuredClone(snapshot.context.requirements), engineeringContract: snapshot.context.engineeringContract }, binding: structuredClone(snapshot.binding),
          signal: controller.signal, assertCurrent, proposalId: row.id, revision: row.revision });
        completed = result?.terminationConfirmed === true && result.status !== 'reconciliation_required';
        if (completed && result.status === 'accepted') assertCurrent();
        return result;
      } finally {
        state.alive = false;
        if (owns()) {
          if (completed) db.prepare('UPDATE proposals SET active=0 WHERE id=? AND owner=?').run(row.id, owner);
          else { revoke(row); db.prepare("UPDATE proposals SET status='reconciliation_required',active=1,error='execution_unconfirmed' WHERE id=? AND owner=?").run(row.id, owner); }
        }
        executions.delete(row.id);
      }
    })();
    return state.done;
  };
  api.shutdown = () => shutdownPromise ??= (async () => {
    if (closed) return; closing = true; for (const op of operations) op.controller.abort(); for (const state of states.values()) state.controller.abort(); for (const state of executions.values()) state.controller.abort();
    await boundedSettle([...executions.values()].map(state => state.done));
    for (const [id, state] of executions) { state.alive = false; db.prepare("UPDATE proposals SET status='reconciliation_required',active=1,error='execution_unconfirmed' WHERE id=? AND owner=?").run(id, owner); }
    await Promise.allSettled([...states.values()].map(s => s.done)); await Promise.allSettled([...operations].map(op => op.done)); await Promise.allSettled([...barriers.values()]);
    if (owns()) db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); db.close(); closed = true;
  })();
  return Object.freeze(api);
}
