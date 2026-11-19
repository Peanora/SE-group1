import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { reconcileEndedPreviews } from '../lib/preview-output-recovery.mjs';

const state = 'reconciliation_required';
const stopped = { status: 'failed', terminationConfirmed: true, pid: 77532, exitCode: 1,
  stopAcknowledged: false, sourceUnchanged: true, errorCode: 'output_limit' };

async function temporaryDirectory(t) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'preview-output-recovery-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('preview-output-recovery-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function fixture(t, owner = { token: null, pid: null }) {
  const root = await temporaryDirectory(t);
  const filename = path.join(root, 'previews.sqlite');
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE previews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,execution_id TEXT NOT NULL,
        state TEXT NOT NULL,active INTEGER NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX active_preview_project ON previews(project_id) WHERE active=1;
      CREATE TABLE preview_owner(id INTEGER PRIMARY KEY,token TEXT,pid INTEGER);`);
    if (owner) db.prepare('INSERT INTO preview_owner VALUES (1,?,?)').run(owner.token, owner.pid);
  } finally { db.close(); }

  function open(readOnly, work) {
    const connection = new DatabaseSync(filename, { readOnly });
    try { return work(connection); }
    finally { connection.close(); }
  }

  function insert(id, mutate = () => {}) {
    const now = Date.now();
    const row = { id, projectId: `project-${id}`, runId: `run-${id}`, executionId: `execution-${id}`, state, active: 1,
      startedAt: new Date(now - 2000).toISOString(), updatedAt: new Date(now - 998).toISOString() };
    const record = { projectId: row.projectId, runId: row.runId, executionId: row.executionId, startedAt: row.startedAt,
      state, sourceHash: 'a'.repeat(64), shellHash: 'b'.repeat(64), spawnRequested: true, pid: stopped.pid,
      finishedAt: new Date(now - 1000).toISOString(), noProcessStarted: false, stop: { ...stopped },
      error: '预览停止或源码状态尚未确认，请保留现场。' };
    mutate(record, row);
    open(false, connection => connection.prepare('INSERT INTO previews VALUES (?,?,?,?,?,?,?,?,?)').run(
      id, row.projectId, row.runId, row.executionId, row.state, row.active, JSON.stringify(record), row.startedAt, row.updatedAt));
    return record;
  }

  return { root, filename, insert,
    records: () => open(true, connection => connection.prepare('SELECT * FROM previews ORDER BY id').all()),
    owner: () => open(true, connection => connection.prepare('SELECT token,pid FROM preview_owner WHERE id=1').get()) };
}

test('offline recovery releases only the confirmed output-limit slot and retains all stop evidence', async t => {
  const f = await fixture(t);
  const original = f.insert('known');
  for (const [id, mutate] of [
    ['unconfirmed', record => { record.stop.terminationConfirmed = false; }],
    ['changed-source', record => { record.stop.sourceUnchanged = false; }],
    ['different-error', record => { record.stop.errorCode = 'protocol_error'; }],
    ['invalid-exit', record => { record.stop.exitCode = 0; }],
    ['different-pid', record => { record.stop.pid++; }],
    ['unbound-run', record => { record.runId = 'foreign-run'; }],
    ['unbound-project', record => { record.projectId = 'foreign-project'; }],
    ['unbound-execution', record => { record.executionId = 'foreign-execution'; }],
    ['unbound-start', record => { record.startedAt = record.finishedAt; }],
    ['missing-finish', record => { delete record.finishedAt; }],
    ['invalid-finish', record => { record.finishedAt = 'invalid date'; }],
    ['future-finish', record => { record.finishedAt = new Date(Date.now() + 60000).toISOString(); }],
    ['running', (record, row) => { row.state = record.state = 'running'; }],
    ['inactive', (_record, row) => { row.active = 0; }],
  ]) f.insert(id, mutate);
  const unresolved = f.records().filter(row => row.id !== 'known');

  assert.deepEqual(await reconcileEndedPreviews(f.root), { recovered: 1 });
  const records = f.records();
  const row = records.find(item => item.id === 'known');
  assert.equal(row.state, 'stopped');
  assert.equal(row.active, 0);
  const record = JSON.parse(row.record);
  const { recovery, ...result } = record;
  assert.equal(recovery.at, row.updated_at);
  assert.equal(recovery.code, 'confirmed_output_limit_exit');
  assert.equal(recovery.previousError, original.error);
  assert.match(result.error, /输出超限退出.*已释放预览占用/u);
  assert.deepEqual({ ...result, state, error: original.error }, original);
  assert.deepEqual(records.filter(item => item.id !== 'known'), unresolved);

  assert.deepEqual(await reconcileEndedPreviews(f.root), { recovered: 0 });
  assert.deepEqual(f.records(), records);
});

test('the same proven record remains blocked while a controller still owns the database', async t => {
  const f = await fixture(t, { token: 'active-owner', pid: process.pid });
  f.insert('known');
  const before = f.records();

  assert.deepEqual(await reconcileEndedPreviews(f.root), { recovered: 0 });
  assert.deepEqual(f.records(), before);
  assert.deepEqual({ ...f.owner() }, { token: 'active-owner', pid: process.pid });
});

test('online maintenance requires the exact owner and preview pid confirmed absent', async t => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(child, 'close');
  const f = await fixture(t, { token: 'active-owner', pid: process.pid });
  const withPid = pid => record => { record.pid = record.stop.pid = pid; };
  const original = f.insert('requested', withPid(child.pid));
  f.insert('other', withPid(child.pid));
  f.insert('still-present', withPid(process.pid));
  assert.deepEqual(await reconcileEndedPreviews(f.root, { id: 'requested', ownerPid: child.pid }), { recovered: 0 });
  assert.deepEqual(await reconcileEndedPreviews(f.root, { id: 'still-present', ownerPid: process.pid }), { recovered: 0 });
  assert.deepEqual(await reconcileEndedPreviews(f.root, { id: 'requested', ownerPid: process.pid }), { recovered: 1 });
  const rows = f.records();
  const requested = rows.find(row => row.id === 'requested');
  assert.equal(requested.active, 0);
  assert.deepEqual(JSON.parse(requested.record).stop, original.stop);
  assert.ok(rows.filter(row => row.id !== 'requested').every(row => row.active === 1));
  assert.deepEqual({ ...f.owner() }, { token: 'active-owner', pid: process.pid });
});

test('a dead previous controller does not block recovery or have its owner evidence overwritten', async t => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  const owner = { token: 'old-owner', pid: child.pid };
  const f = await fixture(t, owner);
  f.insert('known');

  assert.deepEqual(await reconcileEndedPreviews(f.root), { recovered: 1 });
  assert.deepEqual({ ...f.owner() }, owner);
});

test('missing databases are not created and links are rejected before opening SQLite', async t => {
  const root = await temporaryDirectory(t);
  const missing = path.join(root, 'absent');
  assert.deepEqual(await reconcileEndedPreviews(missing), { recovered: 0 });
  assert.deepEqual(await reconcileEndedPreviews(root), { recovered: 0 });
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, 'previews.sqlite')), { code: 'ENOENT' });

  const f = await fixture(t);
  f.insert('known');
  const before = f.records();
  const alias = path.join(root, 'alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(reconcileEndedPreviews(alias), /不能使用链接/u);
  await link(f.filename, path.join(root, 'previews.sqlite'));
  await assert.rejects(reconcileEndedPreviews(root), /不能使用链接/u);
  assert.deepEqual(f.records(), before);
});
