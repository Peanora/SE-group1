import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inspectVerificationPlanning } from './verification-planning-service.mjs';
import { inspectVerificationTasks } from './verification-task-scopes.mjs';
import { inspectPlannedSource, assertPlannedSource } from './planned-source.mjs';
import { createPlannedEvolutionSeed } from './planned-evolution-source.mjs';
import { normalizeMigrationPlan, createMigrationControl, compileMigrationPlan } from './planned-migration-contract.mjs';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';

const HASH = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const EXECUTION_UNCONFIRMED = '演进开发的停止状态或模型用量尚待核对。原开发记录保留，请在「代码与验收」查看。';
const identifier = value => typeof value === 'string' && ID.test(value);
const unknownStop = error => error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false || error?.code === 'migration_stop_unknown';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const need = (ok, code = 'invalid_evolution', message = '演进来源、需求版本、迁移确认或当前状态无效。') => { if (!ok) throw Object.assign(new Error(message), { status: 409, code }); };
function exact(raw, names) {
  need(raw && Object.getPrototypeOf(raw) === Object.prototype && !Object.getOwnPropertySymbols(raw).length);
  const own = Object.getOwnPropertyDescriptors(raw); need(Object.keys(own).length === names.length && names.every(name => own[name]?.enumerable && Object.hasOwn(own[name], 'value')));
  return copyBrowserScenarioData(Object.fromEntries(names.map(name => [name, own[name].value])), 512 * 1024);
}
const text = value => { need(typeof value === 'string' && value.trim() && value.length <= 5000); return value.trim(); };
const checkAccess = callback => { need(typeof callback === 'function' && callback() === true, 'evolution_access_revoked'); };
async function directory(raw) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && path.resolve(raw) !== path.parse(raw).root && !raw.includes('\0'));
  const root = path.resolve(raw); let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); await mkdir(current, { recursive: true, mode: 0o700 }); const stat = await lstat(current), actual = await realpath(current);
    need(stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current));
  }
  return root;
}

/** Controller bridge, never a migration SQL interpreter. Only registered owned
 * data, current confirmed planning and private source/approval handles enter. */
export async function createPlannedEvolutionService({ rootDir, sourceRootDir, getPlanningSync, verificationService, plannedService, releaseService, datasetService, withCheckpoint } = {}) {
  need(typeof getPlanningSync === 'function' && typeof withCheckpoint === 'function' && typeof verificationService?.assertApprovedDefinition === 'function'
    && typeof plannedService?.list === 'function' && typeof releaseService?.authorizeStoppedDataset === 'function' && typeof datasetService?.snapshot === 'function');
  const root = await directory(rootDir); need(typeof sourceRootDir === 'string' && path.isAbsolute(sourceRootDir));
  const filename = path.join(root, 'evolutions.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) { try { const target = filename + suffix, stat = await lstat(target), actual = await realpath(target); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (process.platform === 'win32' ? actual.toLowerCase() === target.toLowerCase() : actual === target)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const db = new DatabaseSync(filename), owner = randomUUID(), controls = new Map(), controllers = new Set(), pending = new Set(); let closed = false, closing = false, closePromise;
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT,pid INTEGER);
    CREATE TABLE IF NOT EXISTS evolutions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,
      status TEXT NOT NULL,active INTEGER NOT NULL,revision TEXT NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_key));
    CREATE UNIQUE INDEX IF NOT EXISTS active_evolution_project ON evolutions(project_id) WHERE active=1;`);
  function transaction(work) { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  try { transaction(() => {
    const old = db.prepare('SELECT * FROM owner WHERE id=1').get(); let alive = false; if (old?.token) { try { process.kill(old.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } } need(!alive, 'evolution_owned');
    db.prepare("UPDATE evolutions SET status='reconciliation_required' WHERE active=1").run(); db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid);
  }); } catch (error) { db.close(); throw error; }
  const owns = () => !closed && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner;
  const available = () => need(owns() && !closing, 'evolution_closed');
  const hasActivity = projectId => !closed && !!db.prepare('SELECT 1 FROM evolutions WHERE project_id=? AND active=1').get(projectId);
  const select = id => db.prepare('SELECT * FROM evolutions WHERE id=?').get(id);
  const snapshot = (projectId, runId) => inspectVerificationPlanning(getPlanningSync(projectId, runId), projectId, runId);
  const definitionIdentity = record => ({ projectId: record.input.projectId, runId: record.input.runId, proposalId: record.input.proposalId, revision: record.input.definitionRevision });
  function current(record, assertAccess) {
    available(); if (assertAccess) checkAccess(assertAccess);
    const view = snapshot(record.input.projectId, record.input.runId); need(view.key === record.planningKey, 'evolution_target_changed');
    verificationService.assertApprovedDefinition(definitionIdentity(record)); return view;
  }
  const revision = record => hash({ version: 1, input: record.input, origin: record.origin, targetBinding: record.targetBinding, planningKey: record.planningKey,
    snapshot: record.snapshot, retainedPaths: record.retainedPaths, migration: record.migration, revisionNumber: record.revisionNumber, reason: record.reason });
  const rowFor = input => { const row = select(input.evolutionId); need(row && row.project_id === input.projectId && row.run_id === input.runId, 'evolution_not_found'); return row; };
  function save(row, record, status = row.status, active = !!row.active) {
    available(); db.prepare('UPDATE evolutions SET status=?,active=?,revision=?,record=?,updated_at=? WHERE id=?').run(status, active ? 1 : 0, revision(record), JSON.stringify(record), new Date().toISOString(), row.id); return select(row.id);
  }
  function publicRow(row) {
    const record = JSON.parse(row.record); let isCurrent = false; try { current(record); isCurrent = true; } catch { /* Preserve historical drafts. */ }
    return { id: row.id, projectId: row.project_id, runId: row.run_id, revision: row.revision, status: row.status, active: !!row.active, current: isCurrent,
      origin: record.origin ?? null, targetBinding: record.targetBinding ?? null, sourceReleaseId: record.input.releaseId, snapshot: record.snapshot ?? null,
      migration: record.migration, schema: record.schema ?? [], reason: record.reason, feedback: record.feedback ?? '', approval: record.approval ?? null,
      executionId: record.executionId ?? null, releaseId: record.releaseId ?? null, error: record.error ?? null,
      impact: { mode: 'full_revalidation', reusedCodePaths: record.retainedPaths ?? [], reusedAcceptance: false, reason: '首版保守重验全部任务和完整业务，不继承旧通过；各检查独立迁移旧数据。' },
      actions: { canRevise: isCurrent && !row.active && ['awaiting_review', 'changes_requested', 'approved'].includes(row.status), canApprove: isCurrent && !row.active && row.status === 'awaiting_review',
        canStart: isCurrent && !row.active && row.status === 'approved' && typeof plannedService.startEvolution === 'function', canActivate: isCurrent && !row.active && row.status === 'accepted' } };
  }
  async function list(raw) {
    const { projectId, runId } = exact(raw, ['projectId', 'runId']); need(identifier(projectId) && identifier(runId)); available();
    const executions = await plannedService.list({ projectId, runId }); available();
    for (const row of db.prepare("SELECT * FROM evolutions WHERE project_id=? AND run_id=? AND active=0 AND status IN ('starting','running','reconciliation_required')").all(projectId, runId)) {
      const record = JSON.parse(row.record), actual = executions.executions?.find(item => item.id === record.executionId);
      if (!actual) continue;
      let status = actual.active ? 'running' : actual.accepted ? 'accepted' : 'failed';
      if (actual.status === 'reconciliation_required') status = 'reconciliation_required';
      const previousError = record.error;
      if (status === 'reconciliation_required') record.error = EXECUTION_UNCONFIRMED;
      else if (previousError === EXECUTION_UNCONFIRMED) delete record.error;
      // Development retains its own activity and budget reservation.
      if (status !== row.status || record.error !== previousError) save(row, record, status, false);
    }
    return { evolutions: db.prepare('SELECT * FROM evolutions WHERE project_id=? AND run_id=? ORDER BY created_at DESC,id DESC').all(projectId, runId).map(publicRow),
      policy: { migrationKinds: ['none', 'addColumn', 'mapValues'], supportedTaskMode: 'whole_project', publicDeployment: false, rollbackAfterNewWrites: false } };
  }
  function track(work) { const controller = new AbortController(); controllers.add(controller); const done = Promise.resolve().then(() => work(controller.signal)); pending.add(done); done.then(() => { controllers.delete(controller); pending.delete(done); }, () => { controllers.delete(controller); pending.delete(done); }); return done; }
  async function prepare(raw, { assertAccess } = {}) {
    const input = exact(raw, ['projectId', 'runId', 'releaseId', 'proposalId', 'definitionRevision', 'expectedSourceRevision', 'expectedSourceGeneration', 'requestKey', 'reason']);
    need(['projectId', 'runId', 'releaseId', 'proposalId', 'requestKey'].every(key => identifier(input[key])) && HASH.test(input.definitionRevision) && HASH.test(input.expectedSourceRevision) && Number.isSafeInteger(input.expectedSourceGeneration) && input.expectedSourceGeneration >= 0); text(input.reason); available(); checkAccess(assertAccess);
    const duplicate = db.prepare('SELECT * FROM evolutions WHERE project_id=? AND request_key=?').get(input.projectId, input.requestKey);
    if (duplicate) { need(duplicate.input_hash === hash(input), 'evolution_request_key_conflict'); return { evolution: publicRow(duplicate) }; }
    return track(signal => withCheckpoint(input.projectId, async () => {
      available(); checkAccess(assertAccess);
      const existing = db.prepare('SELECT * FROM evolutions WHERE project_id=? AND request_key=?').get(input.projectId, input.requestKey);
      if (existing) { need(existing.input_hash === hash(input), 'evolution_request_key_conflict'); return { evolution: publicRow(existing) }; }
      need(!hasActivity(input.projectId), 'evolution_busy');
      const view = snapshot(input.projectId, input.runId); need(view.binding.sourceRevision === input.expectedSourceRevision && view.binding.sourceGeneration === input.expectedSourceGeneration, 'evolution_target_changed');
      verificationService.assertApprovedDefinition({ projectId: input.projectId, runId: input.runId, proposalId: input.proposalId, revision: input.definitionRevision });
      const id = randomUUID(), now = new Date().toISOString(), record = { version: 1, input, planningKey: view.key, revisionNumber: 1, reason: input.reason, migration: { version: 1, kind: 'none', operations: [] } };
      db.prepare("INSERT INTO evolutions VALUES(?,?,?,?,?,'preparing',1,?,?,?,?)").run(id, input.projectId, input.runId, input.requestKey, hash(input), revision(record), JSON.stringify(record), now, now);
      try {
        const grant = await releaseService.authorizeStoppedDataset(input.releaseId); current(record, assertAccess); need(grant.origin.projectId === input.projectId && grant.origin.runId !== input.runId && grant.origin.sourceGeneration < input.expectedSourceGeneration);
        const source = await inspectPlannedSource({ rootDir: sourceRootDir, reportPath: grant.sourceProvenance.sourceReportPath, binding: grant.origin, writablePaths: grant.retainedPaths, signal }); current(record, assertAccess); grant.assertCurrent();
        const original = assertPlannedSource(source, grant.origin, grant.retainedPaths); need(original.provenance.sourceReportHash === grant.sourceProvenance.sourceReportHash && original.provenance.sourceHash === grant.origin.sourceHash);
        const registered = await datasetService.registerStoppedDataset({ runtimeRef: input.releaseId }, { signal }); current(record, assertAccess); grant.assertCurrent();
        const handle = await datasetService.snapshot({ datasetId: registered.datasetId, expectedGeneration: registered.dataGeneration }), data = await datasetService.readSnapshot(handle); current(record, assertAccess); grant.assertCurrent();
        record.origin = grant.origin; record.sourceProvenance = original.provenance; record.retainedPaths = original.files.map(file => file.path);
        record.snapshot = Object.fromEntries(['datasetId', 'snapshotId', 'snapshotHash', 'dataGeneration', 'databaseHash', 'schemaHash', 'rowsHash', 'bytes', 'policyHash'].map(key => [key, data[key]]));
        record.schema = data.workerReceipt.after.tables.map(table => ({ name: table.name, label: view.context.engineeringContract.entities.find(entity => entity.table === table.name)?.name ?? table.name,
          rows: table.rows, columns: table.columns.map(column => ({ name: column.name, type: column.type, primary: column.pk !== 0 })) }));
        record.targetBinding = { ...Object.fromEntries(['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision'].map(key => [key, view.binding[key]])), inputSnapshotHash: data.snapshotHash, inputSchemaHash: data.schemaHash };
        need(record.retainedPaths.every(file => view.context.task.tasks.some(task => task.writePaths.includes(file))), 'evolution_unmapped_source');
        return { evolution: publicRow(save(select(id), record, 'awaiting_review', false)) };
      } catch (error) { record.error = '演进准备失败，旧代码和数据未覆盖。'; const unknown = unknownStop(error); if (owns()) save(select(id), record, unknown ? 'reconciliation_required' : 'failed', unknown); throw error; }
    }));
  }
  async function revise(raw, { assertAccess } = {}) {
    const input = exact(raw, ['projectId', 'runId', 'evolutionId', 'revision', 'migration', 'reason']), row = rowFor(input), record = JSON.parse(row.record); current(record, assertAccess);
    need(row.revision === input.revision && !row.active && ['awaiting_review', 'changes_requested', 'approved'].includes(row.status));
    const plan = normalizeMigrationPlan(input.migration), reason = text(input.reason); need(hash(plan) !== hash(record.migration), 'evolution_revision_unchanged');
    controls.get(row.id)?.control.close(); controls.delete(row.id); record.migration = plan; record.reason = reason; record.revisionNumber++; delete record.approval;
    return { evolution: publicRow(save(row, record, 'awaiting_review', false)) };
  }
  async function review(raw, accepted, { assertAccess } = {}) {
    const input = exact(raw, ['projectId', 'runId', 'evolutionId', 'revision', 'feedback']), row = rowFor(input), record = JSON.parse(row.record); current(record, assertAccess);
    need(row.revision === input.revision && row.status === 'awaiting_review' && !row.active); record.feedback = text(input.feedback);
    if (accepted) record.approval = { revision: row.revision, feedback: record.feedback, at: new Date().toISOString() };
    return { evolution: publicRow(save(row, record, accepted ? 'approved' : 'changes_requested', false)) };
  }
  async function seedFor(row, grant, assertAccess, signal) {
    const record = JSON.parse(row.record); current(record, assertAccess); need(record.approval?.revision === row.revision && ['starting', 'running', 'approved'].includes(row.status)); grant.assertCurrent();
    const view = snapshot(row.project_id, row.run_id), retainedPaths = record.retainedPaths;
    const sourceHandle = await inspectPlannedSource({ rootDir: sourceRootDir, reportPath: record.sourceProvenance.sourceReportPath, binding: record.origin, writablePaths: retainedPaths, signal }); current(record, assertAccess); grant.assertCurrent();
    need(assertPlannedSource(sourceHandle, record.origin, retainedPaths).provenance.sourceReportHash === record.sourceProvenance.sourceReportHash);
    const snapshotHandle = await datasetService.snapshot({ datasetId: record.snapshot.datasetId, expectedGeneration: record.snapshot.dataGeneration }); current(record, assertAccess); grant.assertCurrent();
    const control = createMigrationControl(), approval = control.approve({ plan: record.migration, binding: record.targetBinding, feedback: record.approval.feedback }), compiledMigrationPlan = compileMigrationPlan({ plan: record.migration, binding: record.targetBinding, approval });
    controls.get(row.id)?.control.close(); controls.set(row.id, { control, compiledMigrationPlan });
    const requirements = view.context.requirements.map(item => item.id), tasks = view.context.task.tasks, approvedTaskSetHash = inspectVerificationTasks(tasks, requirements).taskSetHash;
    return createPlannedEvolutionSeed({ sourceHandle, sourceRootDir, originBinding: record.origin, targetBinding: record.targetBinding, requirements, tasks, approvedTaskSetHash, retainedPaths,
      snapshotHandle, datasetService, compiledMigrationPlan, signal, assertCurrent: () => { const live = select(row.id); need(live && live.revision === row.revision && ['starting', 'running'].includes(live.status)); current(record, assertAccess); grant.assertCurrent(); return true; } });
  }
  async function start(raw, { assertAccess, subject } = {}) {
    const input = exact(raw, ['projectId', 'runId', 'evolutionId', 'revision', 'contractRevision']), row = rowFor(input), record = JSON.parse(row.record); current(record, assertAccess);
    need(row.revision === input.revision && row.status === 'approved' && !row.active && typeof plannedService.startEvolution === 'function', 'evolution_start_unavailable');
    save(row, record, 'starting', false);
    try {
      const result = await plannedService.startEvolution({ ...definitionIdentity(record), contractRevision: input.contractRevision }, { createSeed: grant => seedFor(select(row.id), grant, assertAccess, grant.signal), ...(subject === undefined ? {} : { subject }) });
      current(record, assertAccess); record.executionId = result.execution.id; return { evolution: publicRow(save(select(row.id), record, 'running', false)), execution: result.execution };
    } catch (error) { if (owns()) { record.error = '新版本开发未开始或未能确认接收，请保留原记录。'; const unknown = unknownStop(error); save(select(row.id), record, unknown ? 'reconciliation_required' : 'failed', unknown); } throw error; }
  }
  async function activate(raw, { assertAccess } = {}) {
    const input = exact(raw, ['projectId', 'runId', 'evolutionId', 'revision']), row = rowFor(input), record = JSON.parse(row.record); current(record, assertAccess);
    need(row.status === 'accepted' && row.revision === input.revision && !row.active && record.executionId, 'evolution_not_accepted');
    return track(async signal => {
      save(row, record, 'preparing_activation', true);
      try {
        const source = await plannedService.authorizeAcceptedSource({ projectId: row.project_id, runId: row.run_id, executionId: record.executionId }, { signal, assertAccess }); current(record, assertAccess); source.assertCurrent();
        const snapshotHandle = await datasetService.snapshot({ datasetId: record.snapshot.datasetId, expectedGeneration: record.snapshot.dataGeneration }); current(record, assertAccess);
        const control = createMigrationControl(), approval = control.approve({ plan: record.migration, binding: record.targetBinding, feedback: record.approval.feedback });
        controls.get(row.id)?.control.close(); const compiledMigrationPlan = compileMigrationPlan({ plan: record.migration, binding: record.targetBinding, approval }); controls.set(row.id, { control, compiledMigrationPlan });
        const migrationResult = await datasetService.migrate({ snapshotHandle, compiledPlan: compiledMigrationPlan, targetBinding: record.targetBinding, candidateCommit: source.originBinding.candidateCommit }, { signal }); current(record, assertAccess); source.assertCurrent();
        // Separate databases use an explicit handoff. Fresh checks in releases
        // guard the small admission gap; no cross-database atomicity is claimed.
        save(select(row.id), record, 'activation_ready', false);
        const result = await releaseService.activate({ projectId: row.project_id, runId: row.run_id, executionId: record.executionId, expectedReleaseId: record.input.releaseId, expectedDataGeneration: record.snapshot.dataGeneration }, { assertAccess, signal, migrationResult, datasetService });
        checkAccess(assertAccess); record.releaseId = result.release.id; return { evolution: publicRow(save(select(row.id), record, 'active', false)), release: result.release };
      } catch (error) { if (owns()) { record.error = '本机激活未完成，请核对旧版本及迁移记录。'; const unknown = unknownStop(error); save(select(row.id), record, unknown ? 'reconciliation_required' : 'accepted', unknown); } throw error; }
    });
  }
  function shutdown() { return closePromise ??= (async () => {
    if (closed) return; closing = true; for (const controller of controllers) controller.abort(); let settled = false, timer;
    try { await Promise.race([Promise.allSettled([...pending]).then(() => { settled = true; }), new Promise(resolve => { timer = setTimeout(resolve, 6000); })]); } finally { clearTimeout(timer); }
    controls.forEach(value => value.control.close());
    if (owns()) { db.prepare("UPDATE evolutions SET status='reconciliation_required' WHERE active=1").run(); db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); }
    const reconciliationRequired = !settled || !!db.prepare('SELECT 1 FROM evolutions WHERE active=1 LIMIT 1').get(); db.close(); closed = true; return { closed: true, reconciliationRequired };
  })(); }
  return Object.freeze({ list, prepare, revise, approve: (raw, options) => review(raw, true, options), reject: (raw, options) => review(raw, false, options), start, activate, hasActivity, shutdown });
}
