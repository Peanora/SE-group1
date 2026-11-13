'use strict';
// Platform-owned observer. The parent runs this file in a bounded read-only MXC process.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const MAX_FILE = 8 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
let phase = 'metadata';
function requireThat(condition, code) { if (!condition) throw Object.assign(new Error('Database observation rejected.'), { code }); }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function parents(directory) {
  const workspace = path.resolve('.');
  for (let current = directory;; current = path.dirname(current)) {
    phase = 'parent_stat';
    const stat = fs.lstatSync(current);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_parent');
    // The host verifies the complete canonical parent chain before launch. MXC
    // deliberately denies realpath's ancestor traversal outside the workspace.
    if (samePath(current, workspace)) return;
    requireThat(path.dirname(current) !== current, 'unsafe_parent');
  }
}
function ordinary(filename, minimum = 0) {
  phase = 'file_stat';
  const stat = fs.lstatSync(filename, { bigint: true });
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size >= minimum && stat.size <= MAX_FILE, 'unsafe_file');
  return stat;
}
function observe() {
  const directory = path.resolve('.platform/tmp'); parents(directory);
  const filename = path.join(directory, 'app.sqlite');
  const before = ordinary(filename, 100);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { ordinary(filename + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    requireThat(opened.dev === before.dev && opened.ino === before.ino, 'file_changed');
    const bytes = Buffer.alloc(16); fs.readSync(descriptor, bytes, 0, 16, 0);
    requireThat(bytes.equals(Buffer.from('SQLite format 3\0')), 'invalid_header');
  } finally { fs.closeSync(descriptor); }
  let db;
  try {
    phase = 'open';
    db = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
    phase = 'pragmas';
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=200;');
    for (const table of ['books', 'loans', 'audit_events']) {
      phase = 'schema';
      // sqlite_master.type also calls virtual tables "table". Ask SQLite for
      // the actual object kind; SQL comments and spelling cannot change it.
      const entry = db.prepare(`PRAGMA main.table_list('${table}')`).all()
        .find(item => item.schema === 'main' && item.name === table);
      requireThat(entry?.type === 'table', 'invalid_table');
    }
    phase = 'integrity'; requireThat(db.prepare('PRAGMA integrity_check(1)').get().integrity_check === 'ok', 'integrity_failed');
    phase = 'queries';
    const books = db.prepare('SELECT id,title,copies FROM books ORDER BY id LIMIT 101').all();
    const loans = db.prepare('SELECT id,book_id AS bookId,user_id AS userId,status FROM loans ORDER BY id LIMIT 101').all();
    const events = db.prepare('SELECT action,actor_id AS actorId,target_id AS targetId,at FROM audit_events LIMIT 101').all();
    requireThat(books.length < 101 && loans.length < 101 && events.length < 101, 'record_limit');
    phase = 'final_metadata'; const after = ordinary(filename, 100);
    requireThat(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs, 'file_changed');
    return { ok: true, books, loans, events };
  } finally { db?.close(); }
}
let answer;
try {
  answer = JSON.stringify(observe());
  requireThat(Buffer.byteLength(answer) <= MAX_OUTPUT, 'output_limit');
} catch (error) {
  const known = new Set(['unsafe_parent', 'unsafe_file', 'file_changed', 'invalid_header', 'invalid_table', 'integrity_failed', 'record_limit', 'output_limit', 'ENOENT', 'EACCES', 'EPERM', 'EINVAL']);
  answer = JSON.stringify({ ok: false, code: known.has(error.code) ? error.code : 'observation_failed', phase });
  process.exitCode = 1;
}
process.stdout.write(answer);
