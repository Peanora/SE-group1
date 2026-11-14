import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './documents.mjs';
import { contentRevision } from './planning-review.mjs';
import { inspectRequirementChange } from './requirement-changes.mjs';
import { validateProjectFiles } from './project-files.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/u, HASH = /^[a-f0-9]{64}$/u;
const serviceErrors = new WeakSet();
const fail = (status, code, message) => { const error = Object.assign(new HttpError(status, message), { code }); serviceErrors.add(error); throw error; };
const need = (value, status, code, message) => { if (!value) fail(status, code, message); };
function fields(raw, required, optional = []) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype && Object.getOwnPropertySymbols(raw).length === 0, 400, 'invalid_input', '变更输入必须为纯JSON对象。');
  const own = Object.getOwnPropertyDescriptors(raw), keys = Object.keys(own);
  need(keys.length <= required.length + optional.length && required.every(key => Object.hasOwn(own, key)) && keys.every(key => [...required, ...optional].includes(key) && own[key].enumerable && Object.hasOwn(own[key], 'value')), 400, 'invalid_input', '变更字段缺失、包含访问器或未授权字段。');
  return Object.fromEntries(keys.map(key => [key, own[key].value]));
}
const id = value => { need(typeof value === 'string' && ID.test(value), 400, 'invalid_id', '变更编号格式无效。'); return value; };
const revision = value => { need(typeof value === 'string' && HASH.test(value), 400, 'invalid_revision', '输入版本必须是SHA256。'); return value; };
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
async function directory(raw) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root, 500, 'invalid_root', '变更服务需要专用可信绝对目录。');
  const absolute = path.resolve(raw); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    need(info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(current), current), 500, 'invalid_root', '服务目录及父链不能使用链接。');
  }
  return absolute;
}
function previousPlan(project, currentRevision) {
  try {
    const run = project.runs.findLast(item => !item.sourceSuperseded && (item.sourceRevision ?? contentRevision(item.sourceSnapshot ?? project.source)) === currentRevision);
    if (!run?.spec?.requirements?.length || !run.tasks?.length) return { plan: undefined, status: 'unknown' };
    const exactPath = value => { const normalized = validateProjectFiles([{ path: value, content: '' }])[0].path; if (normalized !== value) throw new Error(); return value; };
    const tasks = run.tasks.map(task => ({ id: task.id, dependsOn: structuredClone(task.dependsOn), requirementIds: structuredClone(task.requirementIds),
      writePaths: (task.writePaths ?? task.suggestedFiles).map(exactPath), validationStatus: 'unknown' }));
    return { status: 'projected', plan: { requirements: run.spec.requirements.map(item => ({ id: item.id, text: item.description })), tasks,
      writePaths: [...new Set(tasks.flatMap(task => task.writePaths))], persistence: 'unknown' } };
  } catch { return { plan: undefined, status: 'unknown' }; }
}
function draftFor(project, current, request) {
  const projection = previousPlan(project, current.revision);
  const make = previous => inspectRequirementChange({ projectId: project.id, baseSource: current.source, source: request.source, baseRevision: request.baseRevision, reason: request.reason, kind: request.kind, ...(previous ? { previousPlan: previous } : {}) });
  try { return { draft: make(projection.plan), projection: projection.status }; }
  catch {
    try { return { draft: make(undefined), projection: 'unknown' }; }
    catch { fail(400, 'invalid_change', '需求变更不符合正文、版本、原因或分类契约。'); }
  }
}

/** Trusted single-controller storage only; checkpoint composition is supplied by the service, never HTTP. */
export async function createSourceChangeService(options) {
  const { rootDir, store, withCheckpoint } = fields(options, ['rootDir', 'store', 'withCheckpoint']);
  need(store && typeof store.get === 'function' && typeof store.getSourceVersion === 'function' && typeof store.getPersistedProject === 'function' && typeof store.publishSourceChange === 'function' && typeof withCheckpoint === 'function', 500, 'invalid_config', '变更服务需要可信存储和项目检查点。');
  let db;
  const owner = randomUUID(); let closed = false, closing = false, shutdownPromise;
  const inFlight = new Set(), applying = new Set();
  try {
    const root = await directory(rootDir), filename = path.join(root, 'changes.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { const info = await lstat(filename + suffix); need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && samePath(await realpath(filename + suffix), filename + suffix), 500, 'invalid_root', '变更数据库及附属文件必须是无链接的普通文件。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    db = new DatabaseSync(filename); await chmod(filename, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT,pid INTEGER);');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM owner WHERE id=1').get();
      let alive = false;
      if (previous?.token) { try { process.kill(previous.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } }
      need(!alive, 409, 'service_owned', '变更目录已有运行中的控制器。');
      const schema = db.prepare('PRAGMA user_version').get().user_version;
      need(schema <= 1, 409, 'unsupported_schema', '变更数据库来自更新版本。');
      db.exec(`CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL,body_hash TEXT NOT NULL,request_json TEXT NOT NULL,
        base_revision TEXT NOT NULL,base_generation INTEGER NOT NULL,target_revision TEXT NOT NULL,draft_json TEXT NOT NULL,projection TEXT NOT NULL,
        status TEXT NOT NULL,apply_json TEXT,applied_projection TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_key)); PRAGMA user_version=1;`);
      // JSON is the publication authority. Recover evidence only; never replay an application.
      for (const row of db.prepare("SELECT * FROM changes WHERE status='applying'").all()) {
        let published = false;
        try {
          const project = store.getPersistedProject(row.project_id);
          const latest = project.sourceVersions?.at(-1);
          published = project.appliedChangeId === row.id && project.sourceGeneration === row.base_generation + 1 && project.currentSourceRevision === row.target_revision && contentRevision(project.source) === row.target_revision
            && latest?.changeId === row.id && latest.generation === project.sourceGeneration && latest.revision === row.target_revision && latest.changeHash === JSON.parse(row.apply_json)?.hash;
        } catch { /* Missing/corrupt project remains interrupted, never automatically applied. */ }
        db.prepare('UPDATE changes SET status=?,error=?,updated_at=? WHERE id=?').run(published ? 'applied' : 'apply_interrupted', published ? null : '应用在发布确认前中断；保留原请求，未自动重放。', new Date().toISOString(), row.id);
      }
      db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(owner, process.pid);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) {
    try { db?.close(); } catch {}
    if (serviceErrors.has(error)) throw error;
    fail(500, 'storage_failed', '变更服务初始化失败，请保留现场并检查本地存储。');
  }
  const own = () => { need(!closed && db.prepare('SELECT token FROM owner WHERE id=1').get()?.token === owner, 409, 'stale_owner', '变更控制器身份已失效。'); };
  const available = () => { own(); need(!closing, 503, 'shutting_down', '变更服务正在停止。'); };
  const selected = changeId => db.prepare('SELECT * FROM changes WHERE id=?').get(changeId);
  const result = row => ({ id: row.id, projectId: row.project_id, requestKey: row.request_key, ...JSON.parse(row.request_json), generation: row.base_generation,
    sourceRevision: row.target_revision, status: row.status, draft: JSON.parse(row.draft_json), projection: row.projection,
    appliedDraft: row.apply_json ? JSON.parse(row.apply_json) : null, appliedProjection: row.applied_projection, appliedGeneration: row.status === 'applied' ? row.base_generation + 1 : null,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at });
  const list = raw => {
    const { projectId } = fields(raw, ['projectId']); id(projectId); available(); store.get(projectId);
    return db.prepare('SELECT * FROM changes WHERE project_id=? ORDER BY rowid').all(projectId).map(result);
  };
  const request = raw => {
    const input = fields(raw, ['projectId', 'baseRevision', 'source', 'reason', 'kind', 'requestKey']);
    id(input.projectId); id(input.requestKey); revision(input.baseRevision);
    const source = fields(input.source, ['filename', 'content']);
    need(typeof source.filename === 'string' && source.filename.length <= 160 && source.filename.isWellFormed() && typeof source.content === 'string' && source.content.length <= 100000 && source.content.isWellFormed()
      && typeof input.reason === 'string' && input.reason.length <= 5000 && input.reason.isWellFormed() && ['field', 'permission', 'workflow', 'other'].includes(input.kind), 400, 'invalid_change', '变更正文、原因或分类格式无效。');
    const data = { projectId: input.projectId, baseRevision: input.baseRevision, source, reason: input.reason, kind: input.kind }, bodyHash = contentRevision(data);
    available(); const project = store.get(input.projectId);
    const existing = db.prepare('SELECT * FROM changes WHERE project_id=? AND request_key=?').get(input.projectId, input.requestKey);
    if (existing) { need(existing.body_hash === bodyHash, 409, 'request_conflict', '该请求编号已经绑定其他变更内容。'); return result(existing); }
    need(!applying.has(project.id) && !db.prepare("SELECT 1 FROM changes WHERE project_id=? AND status='applying'").get(project.id), 409, 'project_busy', '项目正在应用或核对输入变更。');
    const current = store.getSourceVersion(project.id);
    need(current.revision === input.baseRevision, 409, 'stale_revision', '旧输入版本已变化，请基于当前版本提出变更。');
    need(db.prepare('SELECT COUNT(*) AS count FROM changes WHERE project_id=?').get(project.id).count < 20, 409, 'request_limit', '该项目变更请求已达到20条上限。');
    const inspected = draftFor(project, current, data), now = new Date().toISOString(), changeId = randomUUID();
    db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(changeId, project.id, input.requestKey, bodyHash, JSON.stringify(data), current.revision, current.generation, inspected.draft.sourceRevision, JSON.stringify(inspected.draft), inspected.projection, 'pending', null, null, null, now, now);
    return result(selected(changeId));
  };
  async function apply(raw) {
    const input = fields(raw, ['projectId', 'changeId', 'baseRevision', 'generation']); id(input.projectId); id(input.changeId); revision(input.baseRevision);
    need(Number.isSafeInteger(input.generation) && input.generation >= 0, 400, 'invalid_generation', '输入代次无效。');
    available(); const row = selected(input.changeId);
    need(row && row.project_id === input.projectId, 404, 'not_found', '未找到该项目的变更请求。');
    need(input.baseRevision === row.base_revision && input.generation === row.base_generation, 409, 'stale_revision', '应用参数与原变更版本不一致。');
    if (row.status === 'applied') return result(row);
    need(row.status === 'pending' && !applying.has(input.projectId) && !db.prepare("SELECT 1 FROM changes WHERE project_id=? AND status='applying'").get(input.projectId), 409, 'project_busy', '变更不处于可应用状态，或项目已有应用待核对。');
    applying.add(input.projectId);
    const operation = (async () => {
      try { return await withCheckpoint(input.projectId, async () => {
        available(); const project = store.get(input.projectId), current = store.getSourceVersion(project.id);
        need(current.revision === row.base_revision && current.generation === row.base_generation, 409, 'stale_revision', '项目输入版本已变化，旧请求未应用。');
        need((project.sourceVersions?.length ?? 1) < 20, 409, 'version_limit', '输入版本已达到20版上限。');
        const inspected = draftFor(project, current, JSON.parse(row.request_json));
        db.prepare("UPDATE changes SET status='applying',apply_json=?,applied_projection=?,updated_at=? WHERE id=? AND status='pending'").run(JSON.stringify(inspected.draft), inspected.projection, new Date().toISOString(), row.id);
        try {
          await store.publishSourceChange(project.id, { baseRevision: row.base_revision, generation: row.base_generation, changeId: row.id, source: inspected.draft.source,
            impact: inspected.draft.impact, changeHash: inspected.draft.hash, policyHash: inspected.draft.policyHash });
          own(); db.prepare("UPDATE changes SET status='applied',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
          return result(selected(row.id));
        } catch (error) {
          const published = store.getPersistedProject(project.id).appliedChangeId === row.id;
          if (!published) { try { db.prepare("UPDATE changes SET status='apply_interrupted',error=?,updated_at=? WHERE id=?").run('输入发布未完成；旧输入及审批保留，请核对后提出新请求。', new Date().toISOString(), row.id); } catch {} }
          if (error?.status === 409 && !published) fail(409, 'stale_revision', '输入发布版本已失效，保留中断记录。');
          fail(503, published ? 'publication_pending_confirmation' : 'publication_failed', published ? '输入JSON已发布，变更记录待重启核对；请勿重复应用。' : '输入发布失败，旧输入和审批未改变。');
        }
      }); }
      catch (error) {
        if (serviceErrors.has(error)) throw error;
        if (error?.status === 409) fail(409, ['project_busy', 'project_checkpoint', 'reconciliation_required'].includes(error.code) ? error.code : 'project_busy', '执行、预览或待协调状态尚未到达项目安全检查点。');
        if (error?.status === 503) fail(503, 'shutting_down', '执行服务正在停止，未开始新的输入发布。');
        fail(500, 'checkpoint_failed', '项目检查点未完成，输入变更未获得完整发布确认。');
      }
      finally { applying.delete(input.projectId); }
    })();
    inFlight.add(operation); operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation));
    return await operation;
  }
  function shutdown() {
    if (!shutdownPromise) { closing = true; shutdownPromise = (async () => { await Promise.allSettled([...inFlight]); if (!closed) { db.prepare('UPDATE owner SET token=NULL,pid=NULL WHERE token=?').run(owner); db.close(); closed = true; } })(); }
    return shutdownPromise;
  }
  return Object.freeze({ list, request, apply, shutdown });
}
