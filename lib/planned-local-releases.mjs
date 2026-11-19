import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPlannedSource } from './planned-source.mjs';
import { readProjectFiles } from './project-files.mjs';
import { getWebShellFiles, verifyWebShell } from './web-delivery.mjs';
import { runProcess, minimalEnv } from './managed-process.mjs';
import { startWebRuntime } from './web-runtime.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value), HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const need = (value, code = 'invalid_local_release') => { if (!value) throw Object.assign(new Error('本机代码与数据版本、停止状态或操作许可无法完整核对。'), { status: 409, code }); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const stopped = result => result?.terminationConfirmed === true && result.status === 'stopped' && result.exitCode === 0 && result.stopAcknowledged === true && result.sourceUnchanged === true;
const unknown = error => error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false;
function exact(raw, keys) {
  need(raw && Object.getPrototypeOf(raw) === Object.prototype && !Object.getOwnPropertySymbols(raw).length);
  const fields = Object.getOwnPropertyDescriptors(raw); need(Object.keys(fields).length === keys.length && keys.every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value')));
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
async function directory(raw, create = false) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root);
  const target = path.resolve(raw); let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await lstat(current); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(current), current));
  }
  return target;
}
async function regular(filename) {
  await directory(path.dirname(filename)); const before = await lstat(filename);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 32 * 1024 * 1024 && samePath(await realpath(filename), filename));
  const bytes = await readFile(filename), after = await lstat(filename); need(before.size === bytes.length && after.size === before.size && after.ino === before.ino && after.dev === before.dev && !after.isSymbolicLink() && after.nlink === 1); return bytes;
}
function regularSync(filename) {
  for (let parent = path.dirname(filename);; parent = path.dirname(parent)) { const stat = lstatSync(parent); need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(realpathSync(parent), parent)); if (parent === path.dirname(parent)) break; }
  const before = lstatSync(filename); need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 32 * 1024 * 1024 && samePath(realpathSync(filename), filename));
  const bytes = readFileSync(filename), after = lstatSync(filename); need(before.size === bytes.length && after.size === before.size && after.ino === before.ino && after.dev === before.dev && !after.isSymbolicLink() && after.nlink === 1); return bytes;
}
async function dataState(workspace) {
  const files = [];
  for (const suffix of ['', '-wal', '-shm']) { try { const bytes = await regular(path.join(workspace, '.platform/tmp', `app.sqlite${suffix}`)); files.push({ suffix, hash: hash(bytes), bytes: bytes.length }); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  need(!files.length || files[0].suffix === ''); return { exists: files.length > 0, fingerprint: hash(files), files };
}
function dataCurrent(workspace, expected) {
  const files = [];
  for (const suffix of ['', '-wal', '-shm']) { try { const bytes = regularSync(path.join(workspace, '.platform/tmp', `app.sqlite${suffix}`)); files.push({ suffix, hash: hash(bytes), bytes: bytes.length }); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  need(hash(files) === expected.fingerprint, 'local_release_data_changed');
}
async function bounded(promise, timeout = 6000) { let timer; try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]); } finally { clearTimeout(timer); } }
function origin(raw) {
  const value = exact(raw, ['projectId', 'runId', 'executionId', 'candidateCommit', 'sourceHash', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision']);
  need(['projectId', 'runId', 'executionId'].every(key => id(value[key])) && COMMIT.test(value.candidateCommit) && ['sourceHash', 'sourceRevision', 'specRevision', 'planRevision'].every(key => HASH.test(value[key])) && Number.isSafeInteger(value.sourceGeneration) && value.sourceGeneration >= 0); return value;
}

/** Controller-only paired release store. Candidate code/SQL is never loaded here. */
export async function createPlannedLocalReleases({ rootDir, authorizeExecution, withCheckpoint, assertIdle, executable = process.env.EXECUTION_SANDBOX_EXE, timeoutMs = 600000 } = {}) {
  need(typeof authorizeExecution === 'function' && typeof withCheckpoint === 'function' && typeof assertIdle === 'function' && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600000);
  const root = await directory(rootDir, true); await directory(path.join(root, 'objects'), true);
  const gitConfig = path.join(root, 'empty-gitconfig'); try { await writeFile(gitConfig, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  need((await regular(gitConfig)).length === 0, 'local_release_git_config_changed');
  const shell = await getWebShellFiles(), filename = path.join(root, 'releases.sqlite'); for (const suffix of ['', '-wal', '-shm', '-journal']) { try { await regular(filename + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const db = new DatabaseSync(filename), owner = randomUUID(), handles = new Map(), operations = new Map(), operationContext = new AsyncLocalStorage(), closedActivities = new Set(); let closed = false, closing = false, closePromise;
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT,pid INTEGER);
    CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,execution_id TEXT NOT NULL,workspace TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,active INTEGER NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_release_project ON releases(project_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS current_release(project_id TEXT PRIMARY KEY,release_id TEXT NOT NULL,generation INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,active INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_release_intent ON intents(project_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS used_migrations(id TEXT PRIMARY KEY,release_id TEXT NOT NULL);`);
  function transaction(work) { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  try { transaction(() => {
    const old = db.prepare('SELECT * FROM owner WHERE id=1').get(); let alive = false; if (old?.token) { try { process.kill(old.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } } need(!alive, 'local_releases_owned');
    db.prepare("UPDATE releases SET state='reconciliation_required' WHERE active=1").run(); db.prepare("UPDATE intents SET status='reconciliation_required' WHERE active=1").run();
    db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid);
  }); } catch (error) { db.close(); throw error; }
  const owns = () => !closed && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner;
  const available = () => need(owns() && !closing, 'local_releases_closed');
  const select = releaseId => db.prepare('SELECT * FROM releases WHERE id=?').get(releaseId), pointer = projectId => db.prepare('SELECT * FROM current_release WHERE project_id=?').get(projectId);
  const actualActivity = projectId => !!db.prepare('SELECT 1 FROM releases WHERE project_id=? AND active=1').get(projectId) || !!db.prepare('SELECT 1 FROM intents WHERE project_id=? AND active=1').get(projectId);
  const hasActivity = projectId => closed ? closedActivities.has(projectId) : !(operations.get(projectId)?.active && operationContext.getStore() === operations.get(projectId)) && (operations.has(projectId) || actualActivity(projectId));
  const access = callback => { need(typeof callback === 'function', 'local_release_access_required'); need(callback() === true, 'local_release_access_revoked'); };
  const externalIdle = projectId => { const value = assertIdle(projectId); need(value !== false && !value?.then, 'local_release_busy'); };
  function rowFor(projectId, releaseId) { const row = select(releaseId); need(row?.project_id === projectId, 'local_release_not_found'); return row; }
  function publicRow(row) {
    const evidence = JSON.parse(row.record), current = pointer(row.project_id)?.release_id === row.id, state = handles.get(row.id); let authorized = false;
    try { access(state?.assertAccess); authorized = !state.stopRequested && !closing; } catch { if (state) void stopState(state).catch(() => {}); }
    return { id: row.id, projectId: row.project_id, runId: row.run_id, executionId: row.execution_id, candidateCommit: evidence.origin.candidateCommit, dataGeneration: row.generation, state: row.state, active: !!row.active, current, predecessorId: evidence.predecessorId ?? null,
      url: row.state === 'running' && authorized ? state.runtime?.url ?? null : null, sourceGeneration: evidence.origin.sourceGeneration,
      actions: { canStart: current && row.state === 'stopped' && !hasActivity(row.project_id) && !closing, canStop: !!state && !!row.active,
        canRollback: current && row.state === 'stopped' && !hasActivity(row.project_id) && !closing && !!evidence.predecessorId && evidence.activationFingerprint === evidence.stoppedFingerprint } };
  }
  function list(raw, { assertAccess } = {}) { const { projectId } = exact(raw, ['projectId']); need(id(projectId)); available(); access(assertAccess); return { releases: db.prepare('SELECT * FROM releases WHERE project_id=? ORDER BY created_at DESC,id DESC').all(projectId).map(publicRow) }; }
  function save(row, state, active, evidence, generation = row.generation) { need(owns()); db.prepare('UPDATE releases SET state=?,active=?,generation=?,record=?,updated_at=? WHERE id=?').run(state, active ? 1 : 0, generation, JSON.stringify(evidence), new Date().toISOString(), row.id); }
  function auditCode(row, files) { for (const file of [...files, ...shell]) need(hash(regularSync(path.join(row.workspace, file.path))) === hash(file.content), 'local_release_source_changed'); }
  async function codeCurrent(row) {
    const evidence = JSON.parse(row.record), files = await readProjectFiles(row.workspace); need(hash(files) === evidence.origin.sourceHash && (await verifyWebShell({ workspace: row.workspace })).hash === evidence.shellHash, 'local_release_source_changed'); return { evidence, files };
  }
  async function cloneSource(source, target, signal) {
    const run = args => runProcess('git', ['-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), '-c', 'core.fsmonitor=false', ...args], { cwd: root, signal, timeoutMs: 30000, maxOutputBytes: 262144, env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' } });
    for (const args of [['clone', '--quiet', '--no-local', '--no-hardlinks', '--', source.provenance.sourceWorkspace, target], ['-C', target, 'rev-parse', 'HEAD']]) {
      const result = await run(args); if (result.terminationConfirmed !== true) throw Object.assign(new Error('本机代码副本的Git进程停止尚未确认。'), { reconciliationRequired: true, result });
      need(result.exitCode === 0 && !result.stopReason && !result.truncated, 'local_release_clone_failed'); if (args[0] === '-C') need(result.stdout.trim() === source.provenance.sourceCommit, 'local_release_source_changed');
    }
    await directory(path.join(target, '.platform/tmp'), true);
  }
  function tracked(projectId, work, checkpoint = true) {
    available(); need(!operations.has(projectId) && !actualActivity(projectId), 'local_release_busy'); const controller = new AbortController(), token = { controller, done: null, active: true }; operations.set(projectId, token);
    token.done = Promise.resolve().then(() => operationContext.run(token, () => checkpoint ? withCheckpoint(projectId, () => { available(); need(operations.get(projectId) === token, 'local_release_busy'); externalIdle(projectId); return work(controller.signal); }) : work(controller.signal)));
    return token.done.finally(() => { token.active = false; if (operations.get(projectId) === token) operations.delete(projectId); });
  }
  function withProjectCheckpoint(projectId, work) {
    need(id(projectId) && typeof work === 'function');
    return tracked(projectId, async () => { available(); const intentId = randomUUID(); db.prepare("INSERT INTO intents VALUES(?,?,'checkpoint','preparing',1,?)").run(intentId, projectId, JSON.stringify({ projectId }));
      try { const value = await work(); available(); updateIntent(intentId, 'completed', false, { projectId }); return value; }
      catch (error) { updateIntent(intentId, closing || unknown(error) ? 'reconciliation_required' : 'failed', closing || unknown(error), { projectId }); throw error; }
    }, false);
  }
  function updateIntent(intentId, status, active, record) { if (owns()) db.prepare('UPDATE intents SET status=?,active=?,record=? WHERE id=?').run(status, active ? 1 : 0, JSON.stringify(record), intentId); }
  async function activate(raw, { assertAccess, migrationResult, datasetService, signal } = {}) {
    const input = exact(raw, ['projectId', 'runId', 'executionId', 'expectedReleaseId', 'expectedDataGeneration']); need(['projectId', 'runId', 'executionId'].every(key => id(input[key])) && (input.expectedReleaseId === null || id(input.expectedReleaseId)) && Number.isSafeInteger(input.expectedDataGeneration) && input.expectedDataGeneration >= 0 && (signal === undefined || signal instanceof AbortSignal)); available(); access(assertAccess);
    return tracked(input.projectId, async localSignal => {
      const previous = pointer(input.projectId), old = previous && rowFor(input.projectId, previous.release_id), frozenPointer = hash(previous ?? null), oldFrozen = old && hash(old);
      need((old?.id ?? null) === input.expectedReleaseId && (old?.generation ?? 0) === input.expectedDataGeneration && (!old || old.state === 'stopped' && !old.active), 'local_release_generation_changed');
      const baseCurrent = () => { available(); access(assertAccess); need(!signal?.aborted && !localSignal.aborted); externalIdle(input.projectId); need(hash(pointer(input.projectId) ?? null) === frozenPointer && (!old || hash(select(old.id)) === oldFrozen), 'local_release_generation_changed'); };
      let oldCode, oldData; if (old) { oldCode = await codeCurrent(old); baseCurrent(); oldData = await dataState(old.workspace); baseCurrent(); need(oldData.fingerprint === oldCode.evidence.stoppedFingerprint && stopped(oldCode.evidence.stop), 'local_release_data_changed'); }
      const intentId = randomUUID(); db.prepare("INSERT INTO intents VALUES(?,?,'activate','preparing',1,?)").run(intentId, input.projectId, JSON.stringify(input));
      const relay = () => operations.get(input.projectId)?.controller.abort(); signal?.addEventListener('abort', relay, { once: true }); if (signal?.aborted) relay();
      try {
        const grant = await authorizeExecution({ projectId: input.projectId, runId: input.runId, executionId: input.executionId }, { signal: localSignal, assertAccess }); baseCurrent();
        // The public execution ID selects authorization; source executionId is
        // the original core report identity and is independently checked below.
        const checkedOrigin = origin(grant.originBinding); need(['projectId', 'runId'].every(key => checkedOrigin[key] === input[key]));
        const current = () => { baseCurrent(); const value = grant.assertCurrent(); need(value !== false && !value?.then); if (old) { auditCode(old, oldCode.files); dataCurrent(old.workspace, oldData); } };
        current(); const source = assertPlannedSource(grant.sourceHandle, checkedOrigin, grant.files.map(file => file.path)); need(source.provenance.sourceCommit === checkedOrigin.candidateCommit && source.provenance.sourceHash === grant.sourceHash && grant.sourceHash === checkedOrigin.sourceHash && source.provenance.sourceExecutionId === checkedOrigin.executionId && source.provenance.sourceRunId === checkedOrigin.runId);
        let migrated; const readResult = datasetService?.readResult;
        if (grant.evolutionSource !== undefined) {
          const expected = grant.evolutionSource; need(old && migrationResult && typeof readResult === 'function', 'local_release_migration_required');
          need(hash(expected.originBinding) === hash(oldCode.evidence.origin) && expected.snapshot?.dataGeneration === old.generation, 'local_release_migration_changed');
          migrated = await readResult.call(datasetService, migrationResult); current();
          need(migrated.receipt.candidateCommit === checkedOrigin.candidateCommit && migrated.receipt.inputSnapshotHash === expected.snapshot.snapshotHash && migrated.receipt.migrationRevision === expected.migration?.revision && migrated.receipt.operationsHash === expected.migration?.operationsHash && migrated.receipt.terminationConfirmed === true && id(migrated.receipt.id), 'local_release_migration_changed');
          need(['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision'].every(key => migrated.receipt.binding?.[key] === checkedOrigin[key]) && !db.prepare('SELECT 1 FROM used_migrations WHERE id=?').get(migrated.receipt.id), 'local_release_migration_changed');
        } else need(!old && migrationResult === undefined && datasetService === undefined, 'local_release_data_loss_blocked');
        const object = await mkdtemp(path.join(root, 'objects/release-')), workspace = path.join(object, 'workspace'); current(); await cloneSource(source, workspace, localSignal); current();
        const target = { workspace, record: JSON.stringify({ origin: checkedOrigin, shellHash: grant.shellHash }) }, code = await codeCurrent(target); current();
        if (migrated) {
          need(datasetService.readResult === readResult, 'local_release_migration_changed'); const bytes = await regular(migrated.databasePath); current(); need(hash(bytes) === migrated.receipt.databaseHash);
          await writeFile(path.join(workspace, '.platform/tmp/app.sqlite'), bytes, { flag: 'wx', mode: 0o600 }); current();
          const last = await readResult.call(datasetService, migrationResult); current(); need(last.databasePath === migrated.databasePath && hash(last.receipt) === hash(migrated.receipt));
        }
        const data = await dataState(workspace); current(); need(!migrated || data.exists && data.files[0].hash === migrated.receipt.databaseHash);
        const releaseId = randomUUID(), now = new Date().toISOString(), evidence = { version: 1, origin: checkedOrigin, sourceProvenance: source.provenance, retainedPaths: source.files.map(file => file.path), shellHash: grant.shellHash,
          predecessorId: old?.id ?? null, predecessor: old ? { generation: old.generation, fingerprint: oldData.fingerprint } : null, activationFingerprint: data.fingerprint, stoppedFingerprint: data.fingerprint, dataExists: data.exists, migration: migrated?.receipt ?? null, stop: null };
        transaction(() => { current(); auditCode(target, code.files); dataCurrent(workspace, data);
          db.prepare("INSERT INTO releases VALUES(?,?,?,?,?,0,'stopped',0,?,?,?)").run(releaseId, input.projectId, input.runId, input.executionId, workspace, JSON.stringify(evidence), now, now);
          if (migrated) db.prepare('INSERT INTO used_migrations VALUES(?,?)').run(migrated.receipt.id, releaseId);
          db.prepare('INSERT INTO current_release VALUES(?,?,1) ON CONFLICT(project_id) DO UPDATE SET release_id=excluded.release_id,generation=current_release.generation+1').run(input.projectId, releaseId); updateIntent(intentId, 'completed', false, { ...input, releaseId });
        });
        return { release: publicRow(select(releaseId)) };
      } catch (error) { updateIntent(intentId, unknown(error) ? 'reconciliation_required' : 'failed', unknown(error), { ...input, error: '本机激活未完成，原代码和数据保留。' }); throw error; }
      finally { signal?.removeEventListener('abort', relay); }
    });
  }
  async function rollback(raw, { assertAccess } = {}) {
    const input = exact(raw, ['projectId', 'releaseId', 'expectedDataGeneration', 'reason']); need(id(input.projectId) && id(input.releaseId) && Number.isSafeInteger(input.expectedDataGeneration) && input.expectedDataGeneration >= 0 && typeof input.reason === 'string' && !!input.reason.trim() && input.reason.length <= 4000); available(); access(assertAccess);
    return tracked(input.projectId, async signal => {
      const row = rowFor(input.projectId, input.releaseId), frozen = hash(row), currentPointer = pointer(input.projectId); need(currentPointer?.release_id === row.id && row.state === 'stopped' && !row.active && row.generation === input.expectedDataGeneration, 'local_release_generation_changed');
      const record = JSON.parse(row.record); need(record.predecessorId && record.predecessor, 'local_release_rollback_unavailable'); const previous = rowFor(input.projectId, record.predecessorId), previousFrozen = hash(previous);
      const guard = () => { available(); access(assertAccess); externalIdle(input.projectId); need(!signal.aborted && hash(select(row.id)) === frozen && hash(select(previous.id)) === previousFrozen && hash(pointer(input.projectId)) === hash(currentPointer), 'local_release_generation_changed'); };
      const [code, oldCode] = await Promise.all([codeCurrent(row), codeCurrent(previous)]); guard(); const [data, oldData] = await Promise.all([dataState(row.workspace), dataState(previous.workspace)]); guard();
      need(data.fingerprint === record.activationFingerprint && data.fingerprint === record.stoppedFingerprint && previous.state === 'stopped' && !previous.active && previous.generation === record.predecessor.generation && oldData.fingerprint === record.predecessor.fingerprint && oldData.fingerprint === oldCode.evidence.stoppedFingerprint, 'local_release_rollback_data_changed');
      const intentId = randomUUID(); db.prepare("INSERT INTO intents VALUES(?,?,'rollback','preparing',1,?)").run(intentId, input.projectId, JSON.stringify(input));
      try { transaction(() => { guard(); auditCode(row, code.files); auditCode(previous, oldCode.files); dataCurrent(row.workspace, data); dataCurrent(previous.workspace, oldData);
        const restored = { ...oldCode.evidence, restoredFrom: row.id, rollbackReason: input.reason, restoredAt: new Date().toISOString() }; save(previous, 'stopped', false, restored, previous.generation + 1); save(row, 'rolled_back', false, record);
        db.prepare('UPDATE current_release SET release_id=?,generation=generation+1 WHERE project_id=?').run(previous.id, input.projectId); updateIntent(intentId, 'completed', false, { ...input, restoredReleaseId: previous.id });
      }); return { release: publicRow(select(previous.id)), replacedRelease: publicRow(select(row.id)) }; }
      catch (error) { updateIntent(intentId, 'failed', false, { ...input, error: '回滚未完成，两个版本均保留。' }); throw error; }
    });
  }
  async function finishStopped(state, result, pending) {
    if (!owns() || handles.get(state.id) !== state) return;
    if (state.finalizing) return state.finalizing;
    const row = select(state.id), evidence = JSON.parse(row.record);
    if (!state.preparedSettled || pending || state.spawnRequested && !stopped(result)) { save(row, 'reconciliation_required', true, evidence); return publicRow(select(state.id)); }
    state.finalizing = (async () => {
      try {
        const code = await codeCurrent(row), data = await dataState(row.workspace);
        if (!owns() || handles.get(state.id) !== state || select(state.id)?.generation !== row.generation) return;
        auditCode(row, code.files); dataCurrent(row.workspace, data); evidence.stop = result ?? null; evidence.dataExists = data.exists;
        const generation = row.generation + (data.fingerprint === evidence.stoppedFingerprint ? 0 : 1); evidence.stoppedFingerprint = data.fingerprint;
        save(row, 'stopped', false, evidence, generation); handles.delete(state.id); clearInterval(state.watch); return publicRow(select(state.id));
      } catch { if (owns() && handles.get(state.id) === state) save(select(state.id), 'reconciliation_required', true, evidence); return owns() ? publicRow(select(state.id)) : undefined; }
    })(); return state.finalizing;
  }
  async function stopState(state) {
    state.stopRequested = true; clearInterval(state.watch); state.controller.abort();
    if (owns() && handles.get(state.id) === state) { const row = select(state.id); if (row.active && !['stopping', 'reconciliation_required'].includes(row.state)) save(row, 'stopping', true, JSON.parse(row.record)); }
    if (!state.completion) {
      state.completion = (async () => {
        let failure; try { await state.prepared; } catch (error) { failure = error; }
        // A late runtime may be assigned just before role/owner/closing fails.
        // It still belongs to us and must be stopped, even after metadata closes.
        if (state.runtime) { try { return { result: await state.runtime.stop(), pending: false }; } catch (error) { return { result: error?.result, pending: unknown(error) }; } }
        return { result: failure?.result, pending: unknown(failure) };
      })();
      state.completion.then(value => finishStopped(state, value.result, value.pending)).catch(() => {});
    }
    const value = await bounded(state.completion); return finishStopped(state, value?.result, value === null || value.pending);
  }
  async function start(raw, { assertAccess } = {}) {
    const { projectId, releaseId, expectedDataGeneration } = exact(raw, ['projectId', 'releaseId', 'expectedDataGeneration']); need(id(projectId) && id(releaseId) && Number.isSafeInteger(expectedDataGeneration) && expectedDataGeneration >= 0); available(); access(assertAccess);
    return tracked(projectId, async signal => {
      const row = rowFor(projectId, releaseId), captured = hash(row), capturedPointer = hash(pointer(projectId)); need(pointer(projectId)?.release_id === releaseId && row.generation === expectedDataGeneration && row.state === 'stopped' && !row.active, 'local_release_generation_changed');
      const guard = () => { available(); access(assertAccess); externalIdle(projectId); need(!signal.aborted && hash(select(releaseId)) === captured && hash(pointer(projectId)) === capturedPointer, 'local_release_generation_changed'); };
      const code = await codeCurrent(row); guard(); const data = await dataState(row.workspace); guard(); need(data.fingerprint === code.evidence.stoppedFingerprint, 'local_release_data_changed'); auditCode(row, code.files); dataCurrent(row.workspace, data);
      const state = { id: releaseId, assertAccess, controller: new AbortController(), runtime: null, preparedSettled: false, spawnRequested: false, stopRequested: false }; handles.set(releaseId, state); save(row, 'starting', true, code.evidence);
      state.prepared = (async () => { try { need(!signal.aborted); state.spawnRequested = true; state.runtime = await startWebRuntime({ workspace: row.workspace, executable, signal: state.controller.signal, timeoutMs, maxOutputBytes: 262144 }); available(); access(assertAccess); need(!signal.aborted && !state.stopRequested && handles.get(releaseId) === state); save(select(releaseId), 'running', true, code.evidence);
        state.runtime.done.then(result => finishStopped(state, result, false), () => stopState(state)).catch(() => {});
        let checking = false; state.watch = setInterval(() => { if (checking || state.stopRequested) return; checking = true; Promise.resolve().then(async () => { available(); access(assertAccess); await codeCurrent(select(releaseId)); available(); access(assertAccess); }).catch(() => stopState(state)).finally(() => { checking = false; }); }, 250); state.watch.unref?.();
      } finally { state.preparedSettled = true; } })();
      try { await state.prepared; return { release: publicRow(select(releaseId)) }; } catch (error) { await stopState(state); throw error; }
    });
  }
  async function stop(raw, { assertAccess } = {}) {
    const { projectId, releaseId } = exact(raw, ['projectId', 'releaseId']); need(id(projectId) && id(releaseId)); available(); access(assertAccess); const row = rowFor(projectId, releaseId), state = handles.get(releaseId);
    if (!state && row.state === 'stopped' && !row.active) return { release: publicRow(row) };
    need(state, 'local_release_stop_unknown'); const result = await stopState(state); available(); access(assertAccess); return { release: result ?? publicRow(select(releaseId)) };
  }
  async function authorizeStoppedDataset(runtimeRef) {
    need(id(runtimeRef)); available(); const row = select(runtimeRef); need(row && row.state === 'stopped' && !row.active && pointer(row.project_id)?.release_id === row.id, 'local_release_not_stopped');
    const expected = hash(row), expectedPointer = hash(pointer(row.project_id));
    const assertCurrent = () => { available(); const live = select(row.id); need(live && hash(live) === expected && !live.active && live.state === 'stopped' && hash(pointer(row.project_id)) === expectedPointer, 'local_release_dataset_changed'); return true; };
    const code = await codeCurrent(row); assertCurrent(); const data = await dataState(row.workspace); assertCurrent(); need(data.exists && code.evidence.dataExists && data.fingerprint === code.evidence.stoppedFingerprint && stopped(code.evidence.stop), 'local_release_data_changed'); auditCode(row, code.files); dataCurrent(row.workspace, data); assertCurrent();
    return { kind: 'owned_dataset', workspace: row.workspace, origin: code.evidence.origin, dataGeneration: row.generation, stopEvidence: code.evidence.stop, sourceProvenance: code.evidence.sourceProvenance, retainedPaths: [...code.evidence.retainedPaths], assertCurrent };
  }
  function shutdown() { return closePromise ??= (async () => {
    if (closed) return; closing = true; for (const token of operations.values()) token.controller.abort();
    const work = Promise.allSettled([...handles.values()].map(stopState).concat([...operations.values()].map(token => token.done))); const settled = await bounded(work);
    for (const state of handles.values()) clearInterval(state.watch);
    if (owns()) { db.prepare("UPDATE releases SET state='reconciliation_required' WHERE active=1").run(); db.prepare("UPDATE intents SET status='reconciliation_required' WHERE active=1").run(); db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); }
    for (const row of db.prepare('SELECT project_id FROM releases WHERE active=1 UNION SELECT project_id FROM intents WHERE active=1').all()) closedActivities.add(row.project_id);
    for (const projectId of operations.keys()) closedActivities.add(projectId);
    const reconciliationRequired = !settled || actualActivityCount(); db.close(); closed = true; return { closed: true, reconciliationRequired };
  })(); }
  function actualActivityCount() { return !!db.prepare('SELECT 1 FROM releases WHERE active=1 UNION ALL SELECT 1 FROM intents WHERE active=1 LIMIT 1').get(); }
  return Object.freeze({ list, activate, rollback, start, stop, authorizeStoppedDataset, hasActivity, withProjectCheckpoint, shutdown });
}
