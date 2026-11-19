import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { installWebShell, verifyWebShell } from './web-delivery.mjs';
import { startWebRuntime } from './web-runtime.mjs';

const HASH = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, code, message) => { if (!ok) throw Object.assign(new Error(message), { status: 409, code }); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const cleanStop = value => value?.terminationConfirmed === true && value.status === 'stopped' && value.exitCode === 0
  && value.stopAcknowledged === true && value.sourceUnchanged === true;
const fields = ['projectId', 'runId', 'executionId'];
function identity(raw) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.getOwnPropertySymbols(raw).length, 'invalid_preview_input', '预览请求格式无效。');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  need(Object.keys(descriptors).length === fields.length && fields.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value') && typeof descriptors[key].value === 'string' && ID.test(descriptors[key].value)),
    'invalid_preview_input', '预览仅接受当前项目、规划和执行编号。');
  return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
async function directory(raw) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root, 'invalid_preview_root', '预览需要专用目录。');
  const target = path.resolve(raw); let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(current), current), 'invalid_preview_root', '预览目录不能包含链接。');
  }
  return target;
}

/** Internal controller capability; no client verdict, path or process handle is accepted. */
export async function createPlannedPreviews({ rootDir, authorize, assertIdle, executable = process.env.EXECUTION_SANDBOX_EXE,
  timeoutMs = 180000, dependencies = {} } = {}) {
  need(typeof authorize === 'function' && typeof assertIdle === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000
    && Object.keys(dependencies).every(key => key === 'startRuntime' && typeof dependencies[key] === 'function'), 'invalid_preview_config', '预览控制器配置无效。');
  const root = await directory(rootDir), filename = path.join(root, 'previews.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { const target = filename + suffix, stat = await lstat(target); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && samePath(await realpath(target), target), 'invalid_preview_root', '预览数据库不能使用链接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(filename), handles = new Map(), owner = randomUUID(); let closed = false, closing = false, shutdownPromise;
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,execution_id TEXT NOT NULL,
      state TEXT NOT NULL,active INTEGER NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_preview_project ON previews(project_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS preview_owner(id INTEGER PRIMARY KEY,token TEXT,pid INTEGER);`);
  try {
    db.exec('BEGIN IMMEDIATE');
    const old = db.prepare('SELECT * FROM preview_owner WHERE id=1').get(); let alive = false;
    if (old?.token) { try { process.kill(old.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } }
    need(!alive, 'preview_owned', '此预览目录已有活动控制器。');
    db.prepare("UPDATE previews SET state='reconciliation_required' WHERE active=1").run();
    db.prepare('INSERT INTO preview_owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Original ownership failure is retained. */ } db.close(); throw error; }
  const owns = () => !closed && db.prepare('SELECT token FROM preview_owner WHERE id=1').get()?.token === owner;
  const available = () => need(owns() && !closing, 'preview_closed', '预览控制器正在停止。');
  const select = id => db.prepare('SELECT * FROM previews WHERE id=?').get(id);
  const hasActivity = projectId => !closed && !!db.prepare('SELECT 1 FROM previews WHERE project_id=? AND active=1').get(projectId);
  const rowFor = value => db.prepare('SELECT * FROM previews WHERE project_id=? AND run_id=? AND execution_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(value.projectId, value.runId, value.executionId);
  function save(state, status, active) {
    if (!owns() || handles.get(state.id) !== state) return;
    state.evidence.state = status;
    db.prepare('UPDATE previews SET state=?,active=?,record=?,updated_at=? WHERE id=?').run(status, active ? 1 : 0, JSON.stringify(state.evidence), new Date().toISOString(), state.id);
  }
  function dto(row) {
    if (!row) return null;
    const state = handles.get(row.id), evidence = JSON.parse(row.record);
    return { id: row.id, executionId: row.execution_id, state: row.state, active: !!row.active, startedAt: row.created_at,
      expiresAt: evidence.expiresAt ?? null, url: row.state === 'running' && !state?.controller.signal.aborted ? state?.runtime?.url ?? null : null,
      error: evidence.error ?? (row.state === 'reconciliation_required' ? '上次预览停止状态无法确认，项目保留待协调。' : null),
      actions: { canStop: !!state && !state.stopping && !!row.active } };
  }
  const read = raw => {
    available(); const value = identity(raw), row = rowFor(value), state = row && handles.get(row.id);
    if (row?.state === 'running' && state) guardRunning(state);
    return dto(row && select(row.id));
  };
  function assertCurrent(state, grant) {
    need(owns() && !closing && handles.get(state.id) === state && !state.controller.signal.aborted && select(state.id)?.active === 1, 'preview_cancelled', '预览已停止或准备状态变化。');
    need(typeof grant?.assertCurrent === 'function', 'preview_not_accepted', '缺少当前已验收源码资格。');
    const result = grant.assertCurrent(); need(result !== false && !result?.then, 'preview_not_accepted', '预览版本核对必须同步通过。');
  }
  function guardRunning(state) {
    try { assertCurrent(state, state.grant); }
    catch { void stopState(state).catch(() => {}); }
  }
  const runtimeStop = state => state.runtimeStop ??= Promise.resolve().then(() => state.runtime.stop()).then(result => (state.stopResult = result), error => { state.stopResult = error?.result; throw error; });
  function stopState(state) {
    if (state.stopping) return state.stopping;
    state.controller.abort(); clearInterval(state.watchTimer); save(state, 'stopping', true);
    state.stopping = (async () => {
      let result, timer;
      const wait = Promise.resolve(state.prepared).catch(error => { state.stopResult ??= error?.result; }).then(async () => {
        try { return state.runtime ? await runtimeStop(state) : state.stopResult; } catch (error) { return state.stopResult ?? error?.result; }
      });
      try { result = await Promise.race([wait, new Promise(resolve => { timer = setTimeout(() => resolve(null), 6000); })]); }
      finally { clearTimeout(timer); }
      clearTimeout(state.timer);
      const noProcessStarted = state.preparedSettled && !state.spawnRequested && !state.preparationUnknown, confirmed = noProcessStarted || cleanStop(result);
      state.evidence.finishedAt = new Date().toISOString();
      state.evidence.stop = result ? Object.fromEntries(['status', 'terminationConfirmed', 'pid', 'exitCode', 'stopAcknowledged', 'sourceUnchanged', 'errorCode'].map(key => [key, result[key] ?? null])) : null;
      state.evidence.noProcessStarted = noProcessStarted;
      if (!confirmed) state.evidence.error = '预览停止或源码状态尚未确认，请保留现场。';
      save(state, confirmed ? 'stopped' : 'reconciliation_required', !confirmed);
      if (confirmed) handles.delete(state.id);
      else void wait.then(late => {
        const noProcessStarted = state.preparedSettled && !state.spawnRequested && !state.preparationUnknown;
        if ((!noProcessStarted && !cleanStop(late)) || !owns() || handles.get(state.id) !== state) return;
        state.evidence.noProcessStarted = noProcessStarted;
        state.evidence.stop = late ? Object.fromEntries(['status', 'terminationConfirmed', 'pid', 'exitCode', 'stopAcknowledged', 'sourceUnchanged', 'errorCode'].map(key => [key, late[key] ?? null])) : null;
        state.evidence.finishedAt = new Date().toISOString(); state.evidence.error = null;
        save(state, 'stopped', false); handles.delete(state.id);
      }).catch(() => {});
      return dto(select(state.id));
    })();
    return state.stopping;
  }
  async function start(raw) {
    const value = identity(raw); available(); need(!assertIdle(value.projectId)?.then, 'invalid_preview_config', '项目活动检查必须为同步门禁。');
    need(!hasActivity(value.projectId), 'preview_active', '同项目已有预览或未知状态待协调。');
    const now = new Date().toISOString(), state = { id: randomUUID(), controller: new AbortController(), runtime: null, spawnRequested: false,
      prepared: null, preparedSettled: false, stopping: null, timer: null, evidence: { ...value, startedAt: now, state: 'preparing' } };
    db.prepare("INSERT INTO previews VALUES(?,?,?,?,'preparing',1,?,?,?)").run(state.id, value.projectId, value.runId, value.executionId, JSON.stringify(state.evidence), now, now);
    handles.set(state.id, state);
    state.prepared = (async () => {
      try {
        const grant = await authorize(value, { signal: state.controller.signal }); state.grant = grant; assertCurrent(state, grant);
        const files = validateProjectFiles(grant.files);
        need(HASH.test(grant.sourceHash ?? '') && hash(files) === grant.sourceHash && HASH.test(grant.shellHash ?? ''), 'preview_source_changed', '预览源码与验收版本不一致。');
        const workspace = await mkdtemp(path.join(root, 'preview-')); state.evidence.workspace = workspace;
        Object.assign(state.evidence, { sourceHash: grant.sourceHash, shellHash: grant.shellHash }); save(state, 'preparing', true);
        await installWebShell({ workspace }); await applyProjectFiles({ workspace, files });
        need(hash(await readProjectFiles(workspace)) === grant.sourceHash && (await verifyWebShell({ workspace })).hash === grant.shellHash, 'preview_source_changed', '预览副本校验失败。');
        assertCurrent(state, grant);
        state.spawnRequested = true; state.evidence.spawnRequested = true; save(state, 'starting', true);
        state.runtime = await (dependencies.startRuntime ?? startWebRuntime)({ workspace, executable, signal: state.controller.signal,
          timeoutMs: timeoutMs + 15000, requestTimeoutMs: Math.min(10000, timeoutMs), maxOutputBytes: 262144 });
        const runtime = state.runtime, url = new URL(runtime?.url);
        need(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !!url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
          && typeof runtime.stop === 'function' && typeof runtime.done?.then === 'function', 'preview_invalid_runtime', '预览缺少受控本机地址或停止句柄。');
        assertCurrent(state, grant);
        state.evidence.pid = runtime.pid ?? null; state.evidence.expiresAt = new Date(Date.now() + timeoutMs).toISOString(); save(state, 'running', true);
        state.timer = setTimeout(() => { void stopState(state).catch(() => {}); }, timeoutMs);
        state.watchTimer = setInterval(() => guardRunning(state), 500);
        void runtime.done.then(() => { if (handles.get(state.id) === state) void stopState(state).catch(() => {}); }, () => { if (handles.get(state.id) === state) void stopState(state).catch(() => {}); });
      } catch (error) {
        state.stopResult = error?.result;
        state.preparationUnknown = error?.reconciliationRequired === true || error?.result?.terminationConfirmed === false;
        state.evidence.error = '预览未能启动，请查看当前状态后重试。'; throw error;
      } finally { state.preparedSettled = true; }
    })();
    try { await state.prepared; available(); need(handles.get(state.id) === state && select(state.id)?.state === 'running' && !state.controller.signal.aborted, 'preview_cancelled', '预览已停止。'); return { preview: dto(select(state.id)) }; }
    catch { await stopState(state); throw Object.assign(new Error('预览未能启动，请刷新核对停止状态。'), { status: 409, code: 'preview_failed' }); }
  }
  async function stop(raw) {
    const value = identity(raw); available(); const row = rowFor(value), state = row && handles.get(row.id);
    need(state && row.active, 'preview_unknown', '当前控制器没有可确认停止的预览句柄。');
    return { preview: await stopState(state) };
  }
  function shutdown() { return shutdownPromise ??= (async () => {
    if (closed) return; closing = true;
    await Promise.allSettled([...handles.values()].map(stopState));
    if (owns()) db.prepare('UPDATE preview_owner SET token=NULL,pid=NULL WHERE token=?').run(owner);
    db.close(); closed = true;
  })(); }
  return Object.freeze({ start, stop, read, hasActivity, shutdown });
}
