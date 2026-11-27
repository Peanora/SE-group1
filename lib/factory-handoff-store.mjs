import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './documents.mjs';

async function present(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export function createFactoryHandoffStore(dataDir) {
  async function open(write, work) {
    if (write) await mkdir(dataDir, { recursive: true });
    const file = path.join(await realpath(dataDir), 'factory-handoffs.sqlite');
    const info = await present(file);
    if (!write && !info) return null;
    for (const item of [info, ...await Promise.all(['-journal', '-wal', '-shm'].map(suffix => present(file + suffix)))]) {
      if (item && (!item.isFile() || item.nlink !== 1)) throw new HttpError(503, 'Factory 交接记录必须保存在本地普通文件中。');
    }
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS handoffs (
          id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          spec_revision TEXT NOT NULL,
          workspace_key TEXT NOT NULL,
          objective_hash TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          native_id INTEGER,
          native_created_at TEXT,
          state TEXT NOT NULL CHECK(state IN ('submitted', 'unknown', 'linked'))
        );
        CREATE INDEX IF NOT EXISTS handoffs_run ON handoffs(project_id, run_id, workspace_key);`);
      return work(db);
    } finally { db.close(); }
  }
  return {
    reserve: receipt => open(true, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const unresolved = db.prepare("SELECT 1 FROM handoffs WHERE project_id=? AND run_id=? AND spec_revision=? AND workspace_key=? AND state<>'linked'")
          .get(receipt.projectId, receipt.runId, receipt.specRevision, receipt.workspaceKey);
        if (unresolved) throw new HttpError(409, '该规格的上次 Factory 交接仍待核对，请先在原生 Runs 中查看。');
        db.prepare("INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'submitted')").run(receipt.id, receipt.projectId, receipt.runId,
          receipt.specRevision, receipt.workspaceKey, receipt.objectiveHash, receipt.submittedAt);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    link: (id, nativeId, createdAt) => open(true, db => db.prepare("UPDATE handoffs SET native_id=?, native_created_at=?, state='linked' WHERE id=? AND state<>'linked'")
      .run(nativeId, createdAt, id)),
    unknown: id => open(true, db => db.prepare("UPDATE handoffs SET state='unknown' WHERE id=? AND state='submitted'").run(id)),
    reject: id => open(true, db => db.prepare("DELETE FROM handoffs WHERE id=? AND state='submitted'").run(id)),
    latest: (projectId, runId, workspaceKey) => open(false, db => db.prepare(`SELECT * FROM handoffs WHERE project_id=? AND run_id=?
      ORDER BY (workspace_key=?) DESC, rowid DESC LIMIT 1`).get(projectId, runId, workspaceKey ?? '') ?? null),
  };
}
