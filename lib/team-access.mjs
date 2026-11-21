import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

const scrypt = promisify(derive), roles = new Set(['owner', 'reviewer', 'observer']), TTL = 8 * 3600000;
const hash = value => createHash('sha256').update(value).digest('hex');
const executionSubjects = new WeakMap();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const need = (ok, status, message) => { if (!ok) fail(status, message); };
const nameOf = value => { need(typeof value === 'string' && /^[\p{L}\p{N}_-]{1,48}$/u.test(value), 400, '账号使用1至48个汉字、字母、数字、下划线或连字符。'); return value.normalize('NFC'); };
const passwordOf = value => { need(typeof value === 'string' && value.isWellFormed() && value.length >= 12 && value.length <= 128 && !/[\x00-\x1f\x7f]/u.test(value), 400, '密码须为12至128个字符，不含控制字符。'); return value; };
const publicUser = row => row ? Object.freeze({ id: row.id, name: row.name, role: row.role, active: row.active === 1 }) : null;
function fields(raw, allowed) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw) && [Object.prototype, null].includes(Object.getPrototypeOf(raw)) && Object.getOwnPropertySymbols(raw).length === 0, 400, '账号请求格式无效。');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  need(Object.keys(descriptors).length === allowed.length && allowed.every(key => descriptors[key]?.enumerable && 'value' in descriptors[key]), 400, '账号请求字段无效。');
  return Object.fromEntries(allowed.map(key => [key, descriptors[key].value]));
}
function tokenOf(cookie) {
  if (typeof cookie !== 'string' || cookie.length > 8192) return null;
  const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith('taskflow_session='));
  return matches.length === 1 && /^taskflow_session=[A-Za-z0-9_-]{43}$/u.test(matches[0]) ? matches[0].slice(17) : null;
}
function subjectDirectory(root) {
  need(typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) !== path.parse(root).root, 403, '执行者权限权威无效。');
  for (let current = path.resolve(root);; current = path.dirname(current)) {
    const info = lstatSync(current), actual = realpathSync(current);
    need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current), 403, '执行者权限权威不可使用链接。');
    if (current === path.dirname(current)) break;
  }
  const filename = path.join(root, 'team.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) try {
    const info = lstatSync(filename + suffix), actual = realpathSync(filename + suffix);
    need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (process.platform === 'win32' ? actual.toLowerCase() === (filename + suffix).toLowerCase() : actual === filename + suffix), 403, '执行者权限权威无效。');
  } catch (error) { if (!suffix || error.code !== 'ENOENT') throw error; }
  return filename;
}
/** Private host capability. It contains no session token and cannot be made from JSON. */
export function createLocalExecutionSubject() {
  const handle = Object.freeze({ kind: 'local_execution_subject', id: randomUUID() });
  executionSubjects.set(handle, Object.freeze({ version: 1, kind: 'local' })); return handle;
}
export function assertExecutionSubjectCurrent(raw) {
  try {
    need(raw && typeof raw === 'object', 403, '执行者权限已失效。');
    const kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value;
    need(kind === 'local' || kind === 'team', 403, '执行者权限已失效。');
    const keys = kind === 'local' ? ['version', 'kind'] : ['version', 'kind', 'rootDir', 'authorityId', 'memberId', 'revision', 'role'];
    const value = fields(raw, keys); need(value.version === 1, 403, '执行者权限已失效。');
    if (value.kind === 'local') return true;
    need(typeof value.authorityId === 'string' && typeof value.memberId === 'string' && Number.isSafeInteger(value.revision) && value.revision >= 1 && value.role === 'owner', 403, '执行者权限已失效。');
    const filename = subjectDirectory(value.rootDir), initial = lstatSync(filename), db = new DatabaseSync(filename, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF');
      const authority = db.prepare('SELECT instance_id FROM execution_authority WHERE id=1').get(), member = db.prepare('SELECT role,active,revision FROM members WHERE id=?').get(value.memberId);
      need(authority?.instance_id === value.authorityId && member?.active === 1 && member.role === 'owner' && member.revision === value.revision, 403, '执行者权限已失效。');
      subjectDirectory(value.rootDir); const final = lstatSync(filename); need(initial.ino === final.ino && initial.dev === final.dev, 403, '执行者权限权威已变化。');
    } finally { db.close(); }
    return true;
  } catch { throw Object.assign(new Error('本作业启动者的执行权限已失效；未授予新的模型调用或交付。'), { status: 403, code: 'execution_subject_revoked' }); }
}
export function describeExecutionSubject(handle) {
  const value = executionSubjects.get(handle); need(value, 403, '缺少真实启动者的私有执行权限。'); assertExecutionSubjectCurrent(value); return value;
}

/** Optional local-team identity. Passwords/session tokens never leave this service. */
export async function createTeamAccess({ rootDir, now = Date.now } = {}) {
  need(typeof rootDir === 'string' && path.isAbsolute(rootDir) && path.resolve(rootDir) !== path.parse(rootDir).root && typeof now === 'function', 500, '团队账号目录配置无效。');
  const absolute = path.resolve(rootDir); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current), actual = await realpath(current);
    need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current), 500, '团队账号目录不可使用链接。');
  }
  const filename = path.join(absolute, 'team.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) try { const info = await lstat(filename + suffix); need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 500, '账号数据库不可使用链接。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(filename); db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,role TEXT NOT NULL,active INTEGER NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_limits(name TEXT PRIMARY KEY,failed INTEGER NOT NULL,window_start INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT,actor_id TEXT,actor_role TEXT,action TEXT NOT NULL,target TEXT NOT NULL,status INTEGER NOT NULL,at INTEGER NOT NULL);`);
  db.exec('CREATE TABLE IF NOT EXISTS execution_authority(id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL)');
  try {
    db.exec('BEGIN IMMEDIATE'); const authority = db.prepare('SELECT instance_id FROM execution_authority WHERE id=1').get();
    if (!authority) { need(db.prepare('PRAGMA user_version').get().user_version < 1, 503, '执行权限权威记录缺失，请恢复备份。'); db.prepare('INSERT INTO execution_authority VALUES(1,?)').run(randomUUID()); }
    db.exec('PRAGMA user_version=1; COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  let closed = false, pending = 0;
  const timestamp = () => { const value = now(); need(Number.isSafeInteger(value) && value >= 0, 500, '账号时钟无效。'); return value; };
  const available = () => need(!closed, 503, '账号服务正在停止。');
  const transaction = work => { available(); db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const setupRequired = () => { available(); return !db.prepare('SELECT 1 FROM members LIMIT 1').get(); };
  function identity(cookie) {
    available(); const token = tokenOf(cookie); if (!token) return null;
    return publicUser(db.prepare('SELECT m.* FROM members m JOIN sessions s ON s.user_id=m.id WHERE s.token_hash=? AND s.expires_at>? AND s.revision=m.revision AND m.active=1').get(hash(token), timestamp()));
  }
  function requireRole(cookie, allowed) { const user = identity(cookie); need(user, 401, '请先登录团队工作台。'); need(allowed.includes(user.role), 403, '当前账号没有执行此操作的权限。'); return user; }
  function audit({ requestId = '', actor = null, action, target = '', status = 0 }) {
    available(); need(typeof action === 'string' && action.length <= 100 && typeof target === 'string' && target.length <= 1000 && Number.isInteger(status), 500, '审计事件格式无效。');
    db.prepare('INSERT INTO audit(request_id,actor_id,actor_role,action,target,status,at) VALUES(?,?,?,?,?,?,?)').run(requestId, actor?.id ?? null, actor?.role ?? null, action, target, status, timestamp());
  }
  async function passwordHash(password, salt) {
    available(); need(pending < 4, 429, '登录请求较多，请稍后重试。'); pending++;
    try { return Buffer.from(await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })).toString('hex'); } finally { pending--; }
  }
  const cookieFor = token => `taskflow_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}`;
  function session(row) {
    const token = randomBytes(32).toString('base64url'); db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(timestamp());
    const count = db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id=?').get(row.id).count;
    if (count >= 10) db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at LIMIT ?)').run(row.id, count - 9);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token), row.id, row.revision, timestamp() + TTL); return { user: publicUser(row), cookie: cookieFor(token) };
  }
  async function setup(raw, context = {}) {
    const input = fields(raw, ['name', 'password']), name = nameOf(input.name), password = passwordOf(input.password);
    need(setupRequired(), 409, '团队负责人已经设置，请登录。'); const salt = randomBytes(16).toString('hex'), passwordDigest = await passwordHash(password, salt);
    return transaction(() => { need(setupRequired(), 409, '团队负责人已经设置，请登录。'); const id = randomUUID();
      db.prepare("INSERT INTO members VALUES(?,?,'owner',1,?,?,1,?)").run(id, name, salt, passwordDigest, timestamp()); const row = db.prepare('SELECT * FROM members WHERE id=?').get(id);
      audit({ requestId: context.requestId, actor: publicUser(row), action: 'team.setup', target: id, status: 201 }); return session(row); });
  }
  async function login(raw, context = {}) {
    const input = fields(raw, ['name', 'password']), name = nameOf(input.name), password = passwordOf(input.password); available();
    const time = timestamp(), limit = db.prepare('SELECT * FROM login_limits WHERE name=?').get(name);
    need(!limit || time - limit.window_start >= 900000 || limit.failed < 5, 429, '登录尝试较多，请十五分钟后重试。');
    const row = db.prepare('SELECT * FROM members WHERE name=?').get(name), revision = row?.revision;
    const actual = await passwordHash(password, row?.salt ?? 'taskflow-unknown-account-salt');
    return transaction(() => {
      const latestLimit = db.prepare('SELECT * FROM login_limits WHERE name=?').get(name);
      need(!latestLimit || timestamp() - latestLimit.window_start >= 900000 || latestLimit.failed < 5, 429, '登录尝试较多，请十五分钟后重试。');
      const fresh = db.prepare('SELECT * FROM members WHERE name=?').get(name), expected = typeof fresh?.password_hash === 'string' && /^[a-f0-9]{64}$/u.test(fresh.password_hash) ? fresh.password_hash : '0'.repeat(64);
      if (!fresh?.active || revision !== fresh.revision || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
        const old = db.prepare('SELECT * FROM login_limits WHERE name=?').get(name), start = old && timestamp() - old.window_start < 900000 ? old.window_start : timestamp();
        db.prepare('INSERT INTO login_limits VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET failed=excluded.failed,window_start=excluded.window_start').run(name, start === old?.window_start ? old.failed + 1 : 1, start);
        audit({ requestId: context.requestId, action: 'team.login_failed', target: name, status: 401 }); return { rejected: true };
      }
      db.prepare('DELETE FROM login_limits WHERE name=?').run(name); audit({ requestId: context.requestId, actor: publicUser(fresh), action: 'team.login', target: fresh.id, status: 200 }); return session(fresh);
    });
  }
  async function createMember(cookie, raw, context = {}) {
    requireRole(cookie, ['owner']); const input = fields(raw, ['name', 'password', 'role']), name = nameOf(input.name), password = passwordOf(input.password);
    need(roles.has(input.role), 400, '账号角色无效。'); const salt = randomBytes(16).toString('hex'), passwordDigest = await passwordHash(password, salt);
    return transaction(() => { const actor = requireRole(cookie, ['owner']); need(db.prepare('SELECT COUNT(*) count FROM members').get().count < 64, 409, '本地团队最多64个账号。');
      need(!db.prepare('SELECT 1 FROM members WHERE name=?').get(name), 409, '该账号名称已存在。'); const id = randomUUID();
      db.prepare('INSERT INTO members VALUES(?,?,?,1,?,?,1,?)').run(id, name, input.role, salt, passwordDigest, timestamp());
      audit({ requestId: context.requestId, actor, action: 'team.member_created', target: id, status: 201 }); return publicUser(db.prepare('SELECT * FROM members WHERE id=?').get(id)); });
  }
  function updateMember(cookie, id, raw, context = {}) {
    const input = fields(raw, ['role', 'active']); need(roles.has(input.role) && typeof input.active === 'boolean', 400, '账号角色或启用状态无效。');
    return transaction(() => { const actor = requireRole(cookie, ['owner']), old = db.prepare('SELECT * FROM members WHERE id=?').get(id); need(old, 404, '未找到该账号。');
      if (old.role === 'owner' && old.active && (input.role !== 'owner' || !input.active)) need(db.prepare("SELECT COUNT(*) count FROM members WHERE role='owner' AND active=1").get().count > 1, 409, '必须保留至少一位已启用负责人。');
      db.prepare('UPDATE members SET role=?,active=?,revision=revision+1 WHERE id=?').run(input.role, input.active ? 1 : 0, id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      audit({ requestId: context.requestId, actor, action: 'team.member_updated', target: id, status: 200 }); return publicUser(db.prepare('SELECT * FROM members WHERE id=?').get(id)); });
  }
  return Object.freeze({ setupRequired, identity, requireRole, audit, setup, login, createMember, updateMember,
    executionSubject(cookie) {
      available(); const token = tokenOf(cookie); need(token, 401, '请先登录团队工作台。');
      const row = db.prepare('SELECT m.id,m.role,m.active,m.revision FROM members m JOIN sessions s ON s.user_id=m.id WHERE s.token_hash=? AND s.expires_at>? AND s.revision=m.revision AND m.active=1').get(hash(token), timestamp());
      need(row, 401, '请先登录团队工作台。'); need(row.role === 'owner', 403, '当前账号没有执行权限。');
      const authorityId = db.prepare('SELECT instance_id FROM execution_authority WHERE id=1').get()?.instance_id;
      const value = Object.freeze({ version: 1, kind: 'team', rootDir: path.resolve(rootDir), authorityId, memberId: row.id, revision: row.revision, role: 'owner' });
      assertExecutionSubjectCurrent(value); const handle = Object.freeze({ kind: 'team_execution_subject', id: randomUUID() }); executionSubjects.set(handle, value); return handle;
    },
    listMembers(cookie) { requireRole(cookie, ['owner']); return db.prepare('SELECT * FROM members ORDER BY created_at,id').all().map(publicUser); },
    events(cookie, after = 0) { requireRole(cookie, ['owner', 'reviewer']); need(Number.isSafeInteger(after) && after >= 0, 400, '审计游标无效。'); const rows = db.prepare('SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 200').all(after); return { cursor: rows.at(-1)?.seq ?? after, events: rows }; },
    logout(cookie, context = {}) { const actor = identity(cookie), token = tokenOf(cookie); if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); audit({ requestId: context.requestId, actor, action: 'team.logout', status: 200 }); return { cookie: 'taskflow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' }; },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}
