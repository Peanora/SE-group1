import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_PID = 0x7fff_ffff;
const RECOVERY_NOTE = '预览因输出超限退出。进程终止和源码完整性已确认，已释放预览占用。原停止记录保留。';
const validPid = value => Number.isInteger(value) && value > 0 && value <= MAX_PID;

function timestamp(value) {
  const instant = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(instant) && new Date(instant).toISOString() === value ? instant : NaN;
}

async function trustedEntry(filename, directory = false) {
  let entry;
  try { entry = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }

  const canonical = await realpath(filename);
  const samePath = process.platform === 'win32' ? canonical.toLowerCase() === filename.toLowerCase() : canonical === filename;
  if (!samePath || entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) {
    throw new Error('预览恢复目录及数据库必须是本地可信目录与普通文件，不能使用链接。');
  }
  return true;
}

function controllerIsOffline(owner) {
  if (!owner) return false;
  if (owner.token === null && owner.pid === null) return true;
  if (typeof owner.token !== 'string' || !IDENTIFIER.test(owner.token) || !validPid(owner.pid)) return false;
  return pidExited(owner.pid);
}

function pidExited(pid) {
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  return false;
}

function confirmedOutputExit(row) {
  let record;
  try { record = JSON.parse(row.record); } catch { return null; }
  if (!record || Array.isArray(record) || record.state !== row.state || record.startedAt !== row.created_at
    || record.projectId !== row.project_id || record.runId !== row.run_id || record.executionId !== row.execution_id
    || ![row.id, row.project_id, row.run_id, row.execution_id].every(id => typeof id === 'string' && IDENTIFIER.test(id))
    || !HASH.test(record.sourceHash ?? '') || !HASH.test(record.shellHash ?? '')
    || record.spawnRequested !== true || record.noProcessStarted !== false || !validPid(record.pid)) return null;

  const startedAt = timestamp(record.startedAt);
  const finishedAt = timestamp(record.finishedAt);
  const updatedAt = timestamp(row.updated_at);
  if (!(startedAt <= finishedAt && finishedAt <= updatedAt && updatedAt <= Date.now())) return null;

  const stop = record.stop;
  if (stop?.status !== 'failed' || stop.errorCode !== 'output_limit' || stop.terminationConfirmed !== true
    || stop.sourceUnchanged !== true || stop.pid !== record.pid || !Number.isInteger(stop.exitCode) || stop.exitCode === 0) return null;
  return record;
}

/** Recover recorded terminal results at startup, or one explicit preview of the current controller during maintenance. */
export async function reconcileEndedPreviews(rootDir, liveTarget = null) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir) || rootDir.includes('\0')) {
    throw new Error('预览恢复需要专用绝对目录。');
  }
  if (liveTarget && (typeof liveTarget.id !== 'string' || !IDENTIFIER.test(liveTarget.id) || !validPid(liveTarget.ownerPid))) {
    throw new Error('在线预览恢复需要明确的预览与控制器进程编号。');
  }
  const target = path.resolve(rootDir);
  let current = path.parse(target).root;
  if (current === target) throw new Error('预览恢复需要专用绝对目录。');
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (!await trustedEntry(current, true)) return { recovered: 0 };
  }

  const filename = path.join(target, 'previews.sqlite');
  if (!await trustedEntry(filename)) return { recovered: 0 };
  for (const suffix of ['-wal', '-shm', '-journal']) await trustedEntry(filename + suffix);

  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
    let recovered = 0;
    const owner = db.prepare('SELECT token, pid FROM preview_owner WHERE id=1').get();
    const offline = controllerIsOffline(owner);
    const live = liveTarget && !offline && owner?.pid === liveTarget.ownerPid && typeof owner.token === 'string' && IDENTIFIER.test(owner.token);
    if ((!liveTarget && offline) || live) {
      const read = db.prepare("SELECT * FROM previews WHERE state='reconciliation_required' AND active=1 AND (? IS NULL OR id=?)");
      const update = db.prepare("UPDATE previews SET state='stopped', active=0, record=?, updated_at=? WHERE id=? AND state='reconciliation_required' AND active=1");
      const requestedId = liveTarget?.id ?? null;
      for (const row of read.all(requestedId, requestedId)) {
        const record = confirmedOutputExit(row);
        // At this point the controller has already saved its terminal result. Its
        // completed stop promise cannot restart the preview or write a late clean stop.
        if (!record || (live && !pidExited(record.pid))) continue;
        const at = new Date().toISOString();
        const recoveredRecord = { ...record, state: 'stopped', error: RECOVERY_NOTE,
          recovery: { at, code: 'confirmed_output_limit_exit', previousError: record.error ?? null } };
        recovered += update.run(JSON.stringify(recoveredRecord), at, row.id).changes;
      }
    }
    db.exec('COMMIT');
    return { recovered };
  } finally {
    // Closing on a thrown error also rolls back an incomplete transaction.
    db.close();
  }
}
