import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../server.mjs';
import { inspectPlannedArchive } from '../lib/planned-archive.mjs';
import { applyProjectFiles, readProjectFiles } from '../lib/project-files.mjs';
import { startWebRuntime } from '../lib/web-runtime.mjs';

const [, , flag, input, extra] = process.argv;
if (!['--candidate', '--archive'].includes(flag) || !input || extra) {
  console.error('使用 --candidate Git工作区 或 --archive 源码ZIP 复验预约关键业务。');
  process.exit(2);
}
await loadEnv();
const target = path.resolve(input);
let files, candidateCommit;
if (flag === '--archive') {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('交付包无效。');
  const archive = await inspectPlannedArchive(await readFile(target));
  ({ files, binding: { candidateCommit } } = archive);
} else {
  const git = args => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain'])) throw new Error('请传入已固定且干净的候选工作区。');
  candidateCommit = git(['rev-parse', 'HEAD']);
  files = await readProjectFiles(target);
  for (const file of files) {
    const committed = execFileSync('git', ['-C', target, 'show', `${candidateCommit}:${file.path}`], { encoding: 'utf8' });
    if (committed.replace(/\r\n/gu, '\n') !== file.content.replace(/\r\n/gu, '\n')) throw new Error(`候选文件与 Git 提交不符：${file.path}`);
  }
}

const workspace = await mkdtemp(path.join(os.tmpdir(), 'tf-reservation-check-'));
await applyProjectFiles({ workspace, files });
const checks = [], processes = [], sessions = new Map();
let runtime;
function check(id, actual, expected) {
  const passed = isDeepStrictEqual(actual, expected);
  checks.push({ id, passed, ...(passed ? {} : { actual, expected }) });
  return passed;
}
function requireValue(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`缺少 ${label} 的有效 ID。`);
  return value;
}
async function request(actor, method, route, body) {
  const cookie = sessions.get(actor);
  const response = await runtime.request({
    method, path: route, headers: { accept: 'application/json', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : '',
  });
  const setCookie = response.headers['set-cookie']?.find(line => line.startsWith('app_session='));
  if (setCookie) sessions.set(actor, setCookie.split(';', 1)[0]);
  const content = Buffer.from(response.body).toString('utf8');
  return { status: response.status, data: content ? JSON.parse(content) : null };
}
async function stop() {
  if (!runtime) return;
  const result = await runtime.stop();
  runtime = null;
  processes.push({ status: result.status, terminationConfirmed: result.terminationConfirmed, exitCode: result.exitCode, sourceUnchanged: result.sourceUnchanged });
  if (!result.terminationConfirmed || result.exitCode !== 0 || !result.sourceUnchanged) throw new Error('候选进程停止或源码完整性无法确认。');
}
function auditRows() {
  const db = new DatabaseSync(path.join(workspace, '.platform', 'tmp', 'app.sqlite'), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND lower(name) LIKE '%audit%' ORDER BY name").all();
    if (!tables.length) throw new Error('无法在候选的 SQLite 中确认审计表。');
    return tables.map(({ name }) => {
      const table = `"${name.replaceAll('"', '""')}"`;
      return { name, rows: db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row })) };
    });
  } finally { db.close(); }
}

let error;
try {
  runtime = await startWebRuntime({ workspace, timeoutMs: 120000 });
  for (const actor of ['alice', 'bob', 'carol', 'scheduler']) {
    const login = await request(actor, 'POST', '/api/login', { username: actor, password: `${actor}-demo` });
    if (!check(`login-${actor}`, login.status, 200) || !sessions.has(actor)) throw new Error('公开演示账号登录失败。');
  }
  const resourceId = 'ROOM-A', slot = '2030-07-01-PM';
  const original = { resourceId, slot, reference: '  INVARIANTS-A  ', key: 'invariants-a' };
  const hold = await request('alice', 'POST', '/api/holds', original);
  check('hold-created', hold.status, 201);
  const booking = requireValue(hold.data?.item?.id, '首次预约');
  const replay = await request('alice', 'POST', '/api/holds', original);
  check('exact-whitespace-replay', { status: replay.status, replayed: replay.data?.replayed ?? null, id: replay.data?.item?.id ?? null }, { status: 200, replayed: true, id: booking });
  const conflict = await request('alice', 'POST', '/api/holds', { ...original, reference: original.reference.trim() });
  check('modified-command-conflict', { status: conflict.status, code: conflict.data?.error?.code }, { status: 409, code: 'idempotency_conflict' });
  const waiters = [];
  for (const [actor, reference] of [['bob', 'INVARIANTS-B'], ['carol', 'INVARIANTS-C']]) {
    const queued = await request(actor, 'POST', '/api/waitlist', { resourceId, slot, reference });
    check(`queued-${actor}`, { status: queued.status, position: queued.data?.item?.position }, { status: 201, position: waiters.length + 1 });
    waiters.push(requireValue(queued.data?.item?.id, '候补'));
  }
  const cancel = await request('alice', 'POST', `/api/bookings/${booking}/cancel`, { version: 1 });
  check('holder-cancelled', { status: cancel.status, itemStatus: cancel.data?.item?.status }, { status: 200, itemStatus: 'cancelled' });
  const priorAudit = auditRows();
  if (!priorAudit.some(table => table.rows.length >= 4)) throw new Error('提升前的审计记录不足。');
  const denied = await request('bob', 'POST', `/api/waitlist/${waiters[0]}/promote`, { version: 1 });
  check('member-cannot-promote', denied.status, 403);
  const skip = await request('scheduler', 'POST', `/api/waitlist/${waiters[1]}/promote`, { version: 1 });
  check('scheduler-cannot-skip-head', skip.status, 409);
  check('denied-actions-leave-audit-intact', auditRows(), priorAudit);
  const promoted = await request('scheduler', 'POST', `/api/waitlist/${waiters[0]}/promote`, { version: 1 });
  check('scheduler-promotes-head', { status: promoted.status, owner: promoted.data?.item?.ownerId, state: promoted.data?.item?.status }, { status: 200, owner: 'bob', state: 'held' });
  const promotedId = requireValue(promoted.data?.item?.id, '提升后预约');
  const afterAudit = auditRows();
  const preserved = priorAudit.every(table => isDeepStrictEqual(afterAudit.find(current => current.name === table.name)?.rows.slice(0, table.rows.length), table.rows));
  check('promotion-preserves-every-prior-audit-row', preserved, true);
  const confirmation = await request('bob', 'POST', `/api/bookings/${promotedId}/confirm`, { version: promoted.data.item.version });
  check('waiter-confirms', { status: confirmation.status, state: confirmation.data?.item?.status }, { status: 200, state: 'confirmed' });
  const audit = await request('bob', 'GET', `/api/bookings/${promotedId}/audit`);
  check('promotion-audit-is-exact', { status: audit.status, actions: audit.data?.items?.map(item => item.action) }, { status: 200, actions: ['queued', 'promoted', 'confirmed'] });
  const raceSlot = '2030-07-01-AM';
  const race = await Promise.all(['alice', 'carol'].map(actor => request(actor, 'POST', '/api/holds', { resourceId, slot: raceSlot, reference: `INVARIANTS-RACE-${actor}`, key: `invariants-race-${actor}` })));
  check('parallel-capacity', race.map(result => result.status).sort(), [201, 409]);
  const availability = await request('scheduler', 'GET', `/api/availability?resourceId=${resourceId}&slot=${raceSlot}`);
  check('parallel-capacity-persisted', { status: availability.status, held: availability.data?.held, available: availability.data?.available }, { status: 200, held: 1, available: 0 });
  await stop();
  runtime = await startWebRuntime({ workspace, timeoutMs: 30000 });
  const restarted = await request('bob', 'GET', `/api/bookings/${promotedId}`);
  check('booking-survives-restart', { status: restarted.status, state: restarted.data?.item?.status }, { status: 200, state: 'confirmed' });
  const persisted = await request('bob', 'GET', `/api/bookings/${promotedId}/audit`);
  check('audit-survives-restart', persisted.data?.items, audit.data?.items);
} catch (cause) {
  error = cause.message;
} finally {
  try { await stop(); } catch (cause) { error ??= cause.message; }
}
const passed = !error && checks.every(item => item.passed);
const report = { candidateCommit, sourceHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), checks, processes, passed, error: error ?? null };
const filename = path.join(workspace, 'reservation-invariants.json');
await writeFile(filename, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ candidateCommit, passed, checks: checks.length, failures: checks.filter(test => !test.passed), error: error ?? null, report: filename }));
if (!passed) process.exitCode = 1;
