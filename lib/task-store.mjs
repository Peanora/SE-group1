import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const revisionKeys = ['projectRevision', 'specRevision', 'planRevision'];
const manifestKeys = ['manifestHash', 'browserManifestHash', 'reviewPolicyHash'];
const identityKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'generation', 'leaseToken', ...revisionKeys, 'baseCommit', ...manifestKeys];
const bindingKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'generation', ...revisionKeys, 'baseCommit', ...manifestKeys, 'candidateCommit', 'sourceHash'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const requireThat = (condition, code, message) => { if (!condition) fail(code, message); };
const text = (value, label) => { requireThat(typeof value === 'string' && value.trim() && value.length <= 5000, 'invalid_input', `${label}必须是非空有界文本。`); return value.trim(); };
const id = (value, label = '编号') => { requireThat(typeof value === 'string' && ID.test(value), 'invalid_input', `${label}无效。`); return value; };
const integer = (value, label, min = 0, max = 1_000_000_000) => { requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_input', `${label}无效。`); return value; };
const hash = (value, label) => { requireThat(typeof value === 'string' && HASH.test(value), 'invalid_input', `${label}必须为SHA256。`); return value; };
const strings = (value, label, nonempty = true) => {
  requireThat(Array.isArray(value) && value.length <= 100 && (!nonempty || value.length > 0), 'invalid_input', `${label}必须是有界文本数组。`);
  const result = value.map(item => text(item, label));
  requireThat(new Set(result).size === result.length, 'invalid_input', `${label}不能重复。`); return result;
};
function budget(value) {
  requireThat(value && typeof value === 'object', 'invalid_input', '必须明确调用和token预算。');
  return { calls: integer(value.calls, '调用预算', 1, 10000), tokens: integer(value.tokens, 'token预算', 1) };
}
function revisions(value) { return Object.fromEntries(revisionKeys.map(key => [key, hash(value[key], key)])); }
function normalizeTasks(raw) {
  requireThat(Array.isArray(raw) && raw.length > 0 && raw.length <= 1000, 'invalid_input', '任务必须为1至1000项。');
  const tasks = raw.map(item => {
    requireThat(item && typeof item === 'object', 'invalid_input', '任务格式无效。');
    const manifests = {};
    for (const role of ['test', 'browser', 'review']) {
      const manifest = item.manifests?.[role];
      requireThat(manifest && typeof manifest === 'object', 'invalid_input', '任务必须绑定可信验收清单。');
      manifests[role] = { hash: hash(manifest.hash, `${role}清单`) };
      if (role !== 'review') manifests[role].checkIds = strings(manifest.checkIds, `${role}用例编号`).map(value => id(value, '用例编号'));
    }
    requireThat(typeof item.baseCommit === 'string' && COMMIT.test(item.baseCommit), 'invalid_input', '任务基础提交无效。');
    const writablePaths = strings(item.writablePaths, '可写范围');
    for (const relative of writablePaths) requireThat(!path.posix.isAbsolute(relative) && !/[\\%:\x00]/u.test(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..' && !['.git', '.platform', 'node_modules'].includes(part.toLowerCase())), 'invalid_input', '可写范围必须是不越界的相对POSIX路径。');
    return { id: id(item.id, '任务编号'), description: text(item.description, '任务描述'), inputs: strings(item.inputs, '任务输入'), outputs: strings(item.outputs, '任务输出'), dependsOn: strings(item.dependsOn, '依赖', false).map(value => id(value)), writablePaths, acceptance: strings(item.acceptance, '验收条件'), baseCommit: item.baseCommit, manifests, reservation: budget(item.reservation) };
  });
  const byId = new Map(tasks.map(task => [task.id, task]));
  requireThat(byId.size === tasks.length, 'invalid_input', '任务编号重复。');
  const visiting = new Set(), visited = new Set();
  const visit = task => {
    requireThat(!visiting.has(task.id), 'invalid_input', '任务依赖存在环。');
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const dependency of task.dependsOn) { requireThat(byId.has(dependency), 'invalid_input', '任务引用了未知依赖。'); visit(byId.get(dependency)); }
    visiting.delete(task.id); visited.add(task.id);
  };
  for (const task of tasks) visit(task);
  return tasks;
}
function checkedDatabase(filename) {
  requireThat(typeof filename === 'string' && path.isAbsolute(filename) && !filename.includes('\0') && path.resolve(filename) !== path.parse(filename).root, 'invalid_input', '数据库必须为可信绝对文件路径。');
  const target = path.resolve(filename);
  for (let parent = path.dirname(target);; parent = path.dirname(parent)) {
    const info = lstatSync(parent);
    requireThat(info.isDirectory() && !info.isSymbolicLink(), 'invalid_input', '数据库父目录不能使用链接。');
    if (path.dirname(parent) === parent) break;
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { const info = lstatSync(target + suffix); requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'invalid_input', '数据库及附属文件必须为无链接的普通文件。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

/** Internal capability split only: not cross-process authentication or an OS sandbox. */
export function openTaskStore({ filename, now = Date.now } = {}) {
  requireThat(typeof now === 'function', 'invalid_input', '时钟无效。');
  const target = checkedDatabase(filename);
  const db = new DatabaseSync(target);
  chmodSync(target, 0o600);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  if (schema > 1) { db.close(); fail('unsupported_schema', '任务数据库来自更新版本。'); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,current_version INTEGER NOT NULL,status TEXT NOT NULL,calls_limit INTEGER NOT NULL,tokens_limit INTEGER NOT NULL,deadline INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS run_versions(run_id TEXT NOT NULL,version INTEGER NOT NULL,project_revision TEXT NOT NULL,spec_revision TEXT NOT NULL,plan_revision TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,version),UNIQUE(run_id,project_revision,spec_revision,plan_revision),FOREIGN KEY(run_id) REFERENCES runs(id));
    CREATE TABLE IF NOT EXISTS tasks(run_id TEXT NOT NULL,version INTEGER NOT NULL,id TEXT NOT NULL,definition TEXT NOT NULL,status TEXT NOT NULL,current_attempt TEXT,PRIMARY KEY(run_id,version,id),FOREIGN KEY(run_id,version) REFERENCES run_versions(run_id,version));
    CREATE TABLE IF NOT EXISTS dependencies(run_id TEXT NOT NULL,version INTEGER NOT NULL,task_id TEXT NOT NULL,dependency_id TEXT NOT NULL,PRIMARY KEY(run_id,version,task_id,dependency_id),FOREIGN KEY(run_id,version,task_id) REFERENCES tasks(run_id,version,id),FOREIGN KEY(run_id,version,dependency_id) REFERENCES tasks(run_id,version,id));
    CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,version INTEGER NOT NULL,task_id TEXT NOT NULL,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,lease_token TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,status TEXT NOT NULL,workspace_key TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,candidate_commit TEXT,source_hash TEXT,publication_id TEXT,validation_id TEXT,termination_state TEXT NOT NULL,cancel_state TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,task_id,generation),FOREIGN KEY(run_id,version,task_id) REFERENCES tasks(run_id,version,id));
    CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,result_hash TEXT NOT NULL,payload TEXT NOT NULL,is_current INTEGER NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(attempt_id) REFERENCES attempts(id));
    CREATE TABLE IF NOT EXISTS validations(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,payload TEXT NOT NULL,eligible INTEGER NOT NULL,is_current INTEGER NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(attempt_id) REFERENCES attempts(id));
    CREATE TABLE IF NOT EXISTS reservations(attempt_id TEXT PRIMARY KEY,calls INTEGER NOT NULL,tokens INTEGER NOT NULL,actual_calls INTEGER,actual_tokens INTEGER,state TEXT NOT NULL,FOREIGN KEY(attempt_id) REFERENCES attempts(id));
    CREATE TABLE IF NOT EXISTS settlements(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(attempt_id) REFERENCES attempts(id));
    CREATE TABLE IF NOT EXISTS finishes(attempt_id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(attempt_id) REFERENCES attempts(id));
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,version INTEGER,task_id TEXT,attempt_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    PRAGMA user_version=1;
  `);
  let closed = false;
  const timestamp = () => integer(now(), '当前时间', 0, Number.MAX_SAFE_INTEGER);
  const transaction = fn => {
    requireThat(!closed, 'closed', '任务数据库已关闭。');
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(timestamp()); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const event = (type, runId, time, payload = {}, version = null, taskId = null, attemptId = null) => db.prepare('INSERT INTO events(run_id,version,task_id,attempt_id,type,payload,created_at) VALUES(?,?,?,?,?,?,?)').run(runId, version, taskId, attemptId, type, json(payload), time);
  const runRow = runId => { const row = db.prepare('SELECT * FROM runs WHERE id=?').get(id(runId, '运行编号')); requireThat(row, 'not_found', '未找到运行。'); return row; };
  const taskRow = (runId, version, taskId) => { const row = db.prepare('SELECT * FROM tasks WHERE run_id=? AND version=? AND id=?').get(runId, version, taskId); requireThat(row, 'not_found', '未找到任务。'); return row; };
  const versionRow = run => db.prepare('SELECT * FROM run_versions WHERE run_id=? AND version=?').get(run.id, run.current_version);
  const budgetState = run => {
    const spent = db.prepare('SELECT COALESCE(SUM(COALESCE(actual_calls,calls)),0) calls,COALESCE(SUM(COALESCE(actual_tokens,tokens)),0) tokens FROM reservations JOIN attempts ON attempts.id=reservations.attempt_id WHERE attempts.run_id=?').get(run.id);
    return { limits: { calls: run.calls_limit, tokens: run.tokens_limit }, committed: { calls: spent.calls, tokens: spent.tokens }, available: { calls: Math.max(0, run.calls_limit - spent.calls), tokens: Math.max(0, run.tokens_limit - spent.tokens) }, unknown: db.prepare("SELECT COUNT(*) count FROM reservations JOIN attempts ON attempts.id=reservations.attempt_id WHERE attempts.run_id=? AND state!='settled'").get(run.id).count };
  };
  const attemptView = row => ({ ...JSON.parse(row.binding), candidateCommit: row.candidate_commit, sourceHash: row.source_hash, expiresAt: row.expires_at, status: row.status, workspaceKey: row.workspace_key, workerId: row.worker_id, terminationState: row.termination_state, cancelState: row.cancel_state, publicationId: row.publication_id, validationId: row.validation_id });
  const runView = run => ({ id: run.id, projectId: run.project_id, version: run.current_version, ...Object.fromEntries(revisionKeys.map((key, index) => [key, versionRow(run)[['project_revision', 'spec_revision', 'plan_revision'][index]]])), status: run.status, deadlineAt: run.deadline, budget: budgetState(run) });
  const active = (attempt, time) => {
    const run = runRow(attempt.run_id), task = taskRow(attempt.run_id, attempt.version, attempt.task_id);
    return run.current_version === attempt.version && ['running', 'paused'].includes(run.status) && task.current_attempt === attempt.id && task.status === 'leased' && attempt.status === 'leased' && attempt.expires_at > time;
  };
  const leaseAttempt = lease => {
    requireThat(lease && typeof lease === 'object', 'invalid_input', '缺少租约绑定。');
    const row = db.prepare('SELECT * FROM attempts WHERE id=?').get(id(lease.attemptId, '尝试编号'));
    requireThat(row, 'not_found', '未找到尝试。');
    const stored = JSON.parse(row.binding);
    requireThat(identityKeys.every(key => lease[key] === stored[key]), 'stale_lease', '租约身份或版本不匹配。');
    return row;
  };
  const candidateMatches = (attempt, lease) => requireThat(lease.candidateCommit === attempt.candidate_commit && lease.sourceHash === attempt.source_hash, 'stale_candidate', '候选提交或源码版本不匹配。');
  const staleEvent = (type, attempt, time, payload = {}) => event(type, attempt.run_id, time, payload, attempt.version, attempt.task_id, attempt.id);
  const insertVersion = (runId, version, revision, tasks, time) => {
    db.prepare('INSERT INTO run_versions VALUES(?,?,?,?,?,?)').run(runId, version, revision.projectRevision, revision.specRevision, revision.planRevision, time);
    for (const task of tasks) db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,NULL)').run(runId, version, task.id, json(task), 'pending');
    for (const task of tasks) for (const dependency of task.dependsOn) db.prepare('INSERT INTO dependencies VALUES(?,?,?,?)').run(runId, version, task.id, dependency);
  };
  const sweep = time => {
    const expired = db.prepare("SELECT * FROM attempts WHERE status='leased' AND expires_at<=?").all(time);
    for (const attempt of expired) {
      db.prepare("UPDATE attempts SET status='expired' WHERE id=?").run(attempt.id);
      db.prepare("UPDATE tasks SET status='pending',current_attempt=NULL WHERE run_id=? AND version=? AND id=? AND current_attempt=? AND status='leased'").run(attempt.run_id, attempt.version, attempt.task_id, attempt.id);
      db.prepare("UPDATE runs SET status='reconciliation_required' WHERE id=? AND status='cancel_requested'").run(attempt.run_id);
      staleEvent('lease_expired', attempt, time, { terminationState: attempt.termination_state, workspaceKey: attempt.workspace_key });
    }
    return expired.length;
  };

  const control = Object.freeze({
    createRun(input) {
      const runId = id(input.runId, '运行编号'), projectId = id(input.projectId, '项目编号'), revision = revisions(input), tasks = normalizeTasks(input.tasks), limits = budget(input.budget);
      return transaction(time => {
        requireThat(!db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId), 'conflict', '运行编号已存在。');
        requireThat(tasks.every(task => task.reservation.calls <= limits.calls && task.reservation.tokens <= limits.tokens), 'invalid_input', '单任务预留超过运行总预算。');
        const deadline = integer(input.deadlineAt, '运行截止时间', time + 1, Number.MAX_SAFE_INTEGER);
        db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run(runId, projectId, 1, 'running', limits.calls, limits.tokens, deadline, time);
        insertVersion(runId, 1, revision, tasks, time); event('run_created', runId, time, { revision, taskCount: tasks.length }, 1);
        return runView(runRow(runId));
      });
    },
    replacePlan(input) {
      const revision = revisions(input), tasks = normalizeTasks(input.tasks);
      return transaction(time => {
        const run = runRow(input.runId);
        requireThat(run.current_version === input.expectedVersion && ['running', 'paused'].includes(run.status), 'conflict', '运行版本已变化或不可修订。');
        requireThat(tasks.every(task => task.reservation.calls <= run.calls_limit && task.reservation.tokens <= run.tokens_limit), 'invalid_input', '单任务预留超过运行总预算。');
        requireThat(!db.prepare('SELECT 1 FROM run_versions WHERE run_id=? AND project_revision=? AND spec_revision=? AND plan_revision=?').get(run.id, revision.projectRevision, revision.specRevision, revision.planRevision), 'conflict', '修订必须是尚未使用的新内容版本。');
        const version = run.current_version + 1;
        db.prepare("UPDATE attempts SET status='superseded' WHERE run_id=? AND status='leased'").run(run.id);
        insertVersion(run.id, version, revision, tasks, time); db.prepare('UPDATE runs SET current_version=? WHERE id=?').run(version, run.id);
        event('plan_replaced', run.id, time, { previousVersion: run.current_version, revision }, version); return runView(runRow(run.id));
      });
    },
    pause(runId) { return transaction(time => { const run = runRow(runId); requireThat(run.status === 'running', 'conflict', '仅执行中运行可暂停。'); db.prepare("UPDATE runs SET status='paused' WHERE id=?").run(run.id); event('paused', run.id, time); return runView(runRow(run.id)); }); },
    resume(runId) { return transaction(time => { const run = runRow(runId); requireThat(run.status === 'paused', 'conflict', '仅暂停运行可恢复。'); db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id); event('resumed', run.id, time); return runView(runRow(run.id)); }); },
    sweepExpired() { return transaction(sweep); },
    requestCancel(runId) { return transaction(time => {
      const run = runRow(runId); if (['cancel_requested', 'cancelled', 'reconciliation_required'].includes(run.status)) return runView(run);
      db.prepare("UPDATE runs SET status='cancel_requested' WHERE id=?").run(run.id);
      db.prepare("UPDATE attempts SET cancel_state='requested' WHERE run_id=? AND termination_state!='confirmed'").run(run.id);
      event('cancel_requested', run.id, time); return runView(runRow(run.id));
    }); },
    confirmStopped({ attemptId, evidenceId }) { return transaction(time => {
      id(evidenceId, '停止证据编号'); const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(id(attemptId)); requireThat(attempt, 'not_found', '未找到尝试。');
      if (attempt.termination_state === 'confirmed') return attemptView(attempt);
      db.prepare("UPDATE attempts SET termination_state='confirmed',cancel_state=CASE WHEN cancel_state='requested' THEN 'confirmed' ELSE cancel_state END WHERE id=?").run(attemptId);
      staleEvent('stop_confirmed', attempt, time, { evidenceId }); return attemptView(db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId));
    }); },
    confirmCancel(runId) { return transaction(time => {
      const run = runRow(runId); requireThat(['cancel_requested', 'reconciliation_required', 'cancelled'].includes(run.status), 'conflict', '尚未请求取消。');
      const unknown = db.prepare("SELECT COUNT(*) count FROM attempts WHERE run_id=? AND termination_state!='confirmed'").get(run.id).count;
      const status = unknown ? 'reconciliation_required' : 'cancelled';
      if (status !== run.status) { db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run.id); event(status, run.id, time, { unconfirmedAttempts: unknown }); }
      return { ...runView(runRow(run.id)), unconfirmedAttempts: unknown };
    }); },
    settle({ attemptId, settlementId, usage }) { return transaction(time => {
      id(settlementId, '结算编号'); const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(id(attemptId)); requireThat(attempt, 'not_found', '未找到尝试。');
      requireThat(usage && typeof usage === 'object', 'invalid_input', '结算必须明确已知或未知用量。');
      const actual = Object.fromEntries(['calls', 'tokens'].map(key => [key, usage[key] === null ? null : integer(usage[key], key)]));
      const previous = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
      if (previous) { requireThat(previous.attempt_id === attemptId && previous.payload === json(actual), 'conflict', '重复结算编号对应不同用量。'); return { duplicate: true, budget: budgetState(runRow(attempt.run_id)) }; }
      const reservation = db.prepare('SELECT * FROM reservations WHERE attempt_id=?').get(attemptId);
      requireThat(reservation.state !== 'settled', 'conflict', '该尝试已完成最终结算。');
      for (const [key, column] of [['calls', 'actual_calls'], ['tokens', 'actual_tokens']]) requireThat(reservation[column] === null || actual[key] === reservation[column], 'conflict', '不能修改或抹去已确认用量。');
      db.prepare('INSERT INTO settlements VALUES(?,?,?,?)').run(settlementId, attemptId, json(actual), time);
      db.prepare('UPDATE reservations SET actual_calls=?,actual_tokens=?,state=? WHERE attempt_id=?').run(actual.calls, actual.tokens, actual.calls === null || actual.tokens === null ? 'unknown' : 'settled', attemptId);
      staleEvent('usage_settled', attempt, time, { settlementId, usage: actual }); return { duplicate: false, budget: budgetState(runRow(attempt.run_id)) };
    }); },
    recordValidation(input) { return transaction(time => {
      const attempt = leaseAttempt(input.lease); candidateMatches(attempt, input.lease);
      requireThat(attempt.publication_id && attempt.candidate_commit, 'conflict', '尚未固定候选发布。');
      const validationId = id(input.validationId, '验证编号'), task = JSON.parse(taskRow(attempt.run_id, attempt.version, attempt.task_id).definition), expected = attemptView(attempt);
      const receipts = input.receipts; requireThat(receipts && typeof receipts === 'object', 'invalid_receipt', '缺少独立验收收据。');
      let eligible = true;
      for (const role of ['test', 'browser', 'review']) {
        const receipt = receipts[role];
        requireThat(receipt && receipt.role === role && receipt.kind === 'independent' && receipt.binding && bindingKeys.every(key => receipt.binding[key] === expected[key]), 'invalid_receipt', '独立验收角色或版本绑定不一致。');
        requireThat(receipt.manifestHash === task.manifests[role].hash, 'invalid_receipt', '验收清单或Review规则不一致。');
        if (role !== 'review') {
          const ids = task.manifests[role].checkIds;
          requireThat(['passed', 'failed', 'error'].includes(receipt.status) && typeof receipt.terminationConfirmed === 'boolean' && Array.isArray(receipt.checks) && receipt.checks.length === ids.length && ids.every(checkId => receipt.checks.filter(check => check && check.id === checkId && typeof check.passed === 'boolean').length === 1), 'invalid_receipt', '独立测试或浏览器用例清单不完整。');
          eligible &&= receipt.status === 'passed' && receipt.terminationConfirmed === true && receipt.checks.every(check => check.passed === true);
        } else {
          requireThat(['completed', 'error'].includes(receipt.status) && Array.isArray(receipt.issues) && receipt.issues.length <= 100 && receipt.issues.every(issue => issue && typeof issue.id === 'string' && ID.test(issue.id) && ['blocking', 'advisory'].includes(issue.severity) && ['open', 'resolved'].includes(issue.status) && typeof issue.evidence === 'string' && issue.evidence.trim()) && new Set(receipt.issues.map(issue => issue.id)).size === receipt.issues.length, 'invalid_receipt', 'Review收据格式无效。');
          eligible &&= receipt.status === 'completed' && !receipt.issues.some(issue => issue.severity === 'blocking' && issue.status !== 'resolved');
        }
      }
      const payload = { binding: Object.fromEntries(bindingKeys.map(key => [key, expected[key]])), receipts }, receiptHash = digest(payload);
      const old = db.prepare('SELECT * FROM validations WHERE id=?').get(validationId);
      if (old) { requireThat(old.attempt_id === attempt.id && old.receipt_hash === receiptHash, 'conflict', '重复验证编号对应不同结论。'); return { duplicate: true, current: active(attempt, time), eligible: old.eligible === 1 }; }
      const current = active(attempt, time);
      db.prepare('INSERT INTO validations VALUES(?,?,?,?,?,?,?)').run(validationId, attempt.id, receiptHash, json(payload), eligible ? 1 : 0, current ? 1 : 0, time);
      // Closed, expired or superseded attempts accept historical receipts only;
      // they cannot replace the receipt that authorized an earlier completion.
      if (current) db.prepare('UPDATE attempts SET validation_id=? WHERE id=?').run(validationId, attempt.id);
      staleEvent('validation_recorded', attempt, time, { validationId, eligible, current }); return { duplicate: false, current, eligible };
    }); },
  });

  const worker = Object.freeze({
    claim({ runId, workerId, reserve, leaseMs = 30000 } = {}) { return transaction(time => {
      id(workerId, 'Worker编号'); integer(leaseMs, '租约时长', 1, 600000); sweep(time);
      const run = runRow(runId); if (run.status !== 'running' || time >= run.deadline) return null;
      const candidates = db.prepare("SELECT * FROM tasks t WHERE run_id=? AND version=? AND status='pending' AND NOT EXISTS(SELECT 1 FROM dependencies d JOIN tasks parent ON parent.run_id=d.run_id AND parent.version=d.version AND parent.id=d.dependency_id WHERE d.run_id=t.run_id AND d.version=t.version AND d.task_id=t.id AND parent.status!='completed') ORDER BY id").all(run.id, run.current_version);
      const available = budgetState(run).available;
      const selected = candidates.find(row => { const task = JSON.parse(row.definition); return task.reservation.calls <= available.calls && task.reservation.tokens <= available.tokens; });
      if (!selected) return null;
      const task = JSON.parse(selected.definition);
      if (reserve !== undefined) requireThat(json(budget(reserve)) === json(task.reservation), 'invalid_input', 'Worker不能改变控制器固定的调用预留。');
      const version = versionRow(run), attemptId = randomUUID(), generation = db.prepare('SELECT COALESCE(MAX(generation),0)+1 generation FROM attempts WHERE run_id=? AND task_id=?').get(run.id, selected.id).generation;
      const binding = { projectId: run.project_id, runId: run.id, taskId: selected.id, attemptId, generation, leaseToken: randomUUID(), projectRevision: version.project_revision, specRevision: version.spec_revision, planRevision: version.plan_revision, baseCommit: task.baseCommit, manifestHash: task.manifests.test.hash, browserManifestHash: task.manifests.browser.hash, reviewPolicyHash: task.manifests.review.hash };
      const workspaceKey = randomUUID(), expires = Math.min(time + leaseMs, run.deadline);
      db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,?)').run(attemptId, run.id, run.current_version, selected.id, workerId, generation, binding.leaseToken, expires, 'leased', workspaceKey, json(binding), 'unknown', 'none', time);
      db.prepare("INSERT INTO reservations VALUES(?,?,?,NULL,NULL,'reserved')").run(attemptId, task.reservation.calls, task.reservation.tokens);
      db.prepare("UPDATE tasks SET status='leased',current_attempt=? WHERE run_id=? AND version=? AND id=?").run(attemptId, run.id, run.current_version, selected.id);
      event('claimed', run.id, time, { workerId, workspaceKey, generation, reservation: task.reservation }, run.current_version, selected.id, attemptId);
      return { lease: attemptView(db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId)), task };
    }); },
    heartbeat({ lease, leaseMs = 30000 }) { return transaction(time => {
      integer(leaseMs, '租约时长', 1, 600000); const attempt = leaseAttempt(lease); candidateMatches(attempt, lease);
      if (!active(attempt, time)) { staleEvent('late_heartbeat', attempt, time); return { current: false, lease: attemptView(attempt) }; }
      const expiresAt = Math.min(time + leaseMs, runRow(attempt.run_id).deadline);
      db.prepare('UPDATE attempts SET expires_at=? WHERE id=?').run(expiresAt, attempt.id);
      if (expiresAt !== attempt.expires_at) staleEvent('lease_renewed', attempt, time, { expiresAt });
      return { current: true, lease: attemptView(db.prepare('SELECT * FROM attempts WHERE id=?').get(attempt.id)) };
    }); },
    publish({ lease, publicationId, candidateCommit, sourceHash, artifacts = [], resultHash: declaredHash }) { return transaction(time => {
      const attempt = leaseAttempt(lease); id(publicationId, '发布编号'); requireThat(typeof candidateCommit === 'string' && COMMIT.test(candidateCommit), 'invalid_input', '候选提交无效。'); hash(sourceHash, '源码版本');
      const payload = { candidateCommit, sourceHash, artifacts: strings(artifacts, '产物引用', false) }, resultHash = digest({ binding: JSON.parse(attempt.binding), payload });
      requireThat(declaredHash === undefined || declaredHash === resultHash, 'conflict', '声明的结果版本与实际发布内容不一致。');
      const old = db.prepare('SELECT * FROM publications WHERE id=?').get(publicationId);
      if (old) { requireThat(old.attempt_id === attempt.id && old.result_hash === resultHash, 'conflict', '重复发布编号对应不同结果。'); return { duplicate: true, current: active(attempt, time), lease: attemptView(attempt), resultHash }; }
      candidateMatches(attempt, lease); requireThat(!attempt.publication_id, 'conflict', '当前尝试已固定候选，修改须新建尝试。');
      const current = active(attempt, time);
      db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?)').run(publicationId, attempt.id, resultHash, json(payload), current ? 1 : 0, time);
      db.prepare('UPDATE attempts SET candidate_commit=?,source_hash=?,publication_id=? WHERE id=?').run(candidateCommit, sourceHash, publicationId, attempt.id);
      staleEvent(current ? 'candidate_published' : 'late_publication', attempt, time, { publicationId, resultHash, current });
      return { duplicate: false, current, lease: attemptView(db.prepare('SELECT * FROM attempts WHERE id=?').get(attempt.id)), resultHash };
    }); },
    finish({ lease, validationId, outcome = 'completed', reason }) { return transaction(time => {
      const attempt = leaseAttempt(lease); candidateMatches(attempt, lease);
      requireThat(['completed', 'failed'].includes(outcome), 'invalid_input', '完成操作无效。');
      if (validationId !== undefined) id(validationId, '验证编号');
      if (reason !== undefined) reason = text(reason, '完成或失败原因');
      const payload = json({ validationId: validationId ?? null, outcome, reason: reason ?? null });
      const previous = db.prepare('SELECT * FROM finishes WHERE attempt_id=?').get(attempt.id);
      if (previous) {
        requireThat(previous.payload === payload, 'conflict', '重复完成回调对应不同结果。');
        const run = runRow(attempt.run_id), current = attempt.status === 'completed' ? run.current_version === attempt.version && ['running', 'paused', 'succeeded'].includes(run.status) : active(attempt, time);
        return { duplicate: true, current, completed: current && attempt.status === 'completed' };
      }
      if (!active(attempt, time)) { db.prepare('INSERT INTO finishes VALUES(?,?,?)').run(attempt.id, payload, time); staleEvent('late_finish', attempt, time, { outcome }); return { current: false, completed: false }; }
      if (outcome === 'failed') {
        text(reason, '失败原因'); db.prepare('INSERT INTO finishes VALUES(?,?,?)').run(attempt.id, payload, time); db.prepare("UPDATE attempts SET status='failed' WHERE id=?").run(attempt.id); db.prepare("UPDATE tasks SET status='pending',current_attempt=NULL WHERE run_id=? AND version=? AND id=?").run(attempt.run_id, attempt.version, attempt.task_id);
        staleEvent('attempt_failed', attempt, time, { reason }); return { current: true, completed: false };
      }
      requireThat(outcome === 'completed', 'invalid_input', '完成操作无效。');
      requireThat(attempt.validation_id === validationId, 'validation_required', '必须使用当前独立验证收据。');
      const validation = db.prepare('SELECT * FROM validations WHERE id=? AND attempt_id=?').get(validationId, attempt.id);
      requireThat(validation && validation.eligible === 1 && validation.is_current === 1, 'validation_required', '独立同版本验收未完整通过或仍有阻塞问题。');
      db.prepare('INSERT INTO finishes VALUES(?,?,?)').run(attempt.id, payload, time);
      db.prepare("UPDATE attempts SET status='completed' WHERE id=?").run(attempt.id); db.prepare("UPDATE tasks SET status='completed' WHERE run_id=? AND version=? AND id=? AND current_attempt=?").run(attempt.run_id, attempt.version, attempt.task_id, attempt.id);
      const run = runRow(attempt.run_id);
      if (!db.prepare("SELECT 1 FROM tasks WHERE run_id=? AND version=? AND status!='completed'").get(run.id, run.current_version)) db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(run.id);
      staleEvent('task_completed', attempt, time, { validationId, candidateCommit: attempt.candidate_commit }); return { duplicate: false, current: true, completed: true };
    }); },
  });
  const query = Object.freeze({
    getRun(runId) { return runView(runRow(runId)); },
    getTask(runId, taskId, version = runRow(runId).current_version) { const row = taskRow(runId, version, taskId); return { ...JSON.parse(row.definition), version: row.version, status: row.status, currentAttemptId: row.current_attempt }; },
    listAttempts(runId) { runRow(runId); return db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY created_at,id').all(runId).map(attemptView); },
    events({ after = 0, limit = 100, runId } = {}) { integer(after, '事件游标', 0, Number.MAX_SAFE_INTEGER); integer(limit, '事件数量', 1, 1000); const rows = runId === undefined ? db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit) : db.prepare('SELECT * FROM events WHERE seq>? AND run_id=? ORDER BY seq LIMIT ?').all(after, id(runId), limit); return { cursor: rows.at(-1)?.seq ?? after, events: rows.map(row => ({ seq: row.seq, runId: row.run_id, version: row.version, taskId: row.task_id, attemptId: row.attempt_id, type: row.type, payload: JSON.parse(row.payload), at: row.created_at })) }; },
  });
  return Object.freeze({ control, worker, query, close() { if (!closed) { db.close(); closed = true; } } });
}
