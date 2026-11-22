import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const need = ok => { if (!ok) throw Object.assign(new Error('研发账本原文件或目录发生变化。'), { code: 'worker_ledger_changed', status: 409 }); };

function ledgerIdentity(filename) {
  for (let parent = path.dirname(filename);; parent = path.dirname(parent)) {
    const info = lstatSync(parent);
    need(info.isDirectory() && !info.isSymbolicLink() && samePath(realpathSync(parent), parent));
    if (parent === path.dirname(parent)) break;
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const target = filename + suffix;
    try {
      const info = lstatSync(target);
      need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && samePath(realpathSync(target), target));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = lstatSync(filename);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && samePath(realpathSync(filename), filename));
  return info;
}

export function openPlannedReadonlyLedger(filename) {
  need(typeof filename === 'string' && path.isAbsolute(filename));
  const expected = ledgerIdentity(filename);
  const db = new DatabaseSync(filename, { readOnly: true });
  let closed = false;
  const assertCurrent = () => {
    need(!closed);
    const info = ledgerIdentity(filename);
    need(info.ino === expected.ino && info.dev === expected.dev && info.birthtimeMs === expected.birthtimeMs);
  };
  try { db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;'); assertCurrent(); }
  catch (error) { db.close(); throw error; }
  return { db, assertCurrent, close() { if (!closed) { closed = true; db.close(); } } };
}
