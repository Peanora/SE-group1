import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createTeamAccess } from '../lib/team-access.mjs';

const evidenceRoot = path.resolve(import.meta.dirname, '../output/full-goal-20261117/team-independent');
const ownerPassword = 'Synthetic-Owner-Password-5381!';
const memberPassword = 'Synthetic-Member-Password-6932!';
const badPassword = 'Synthetic-Wrong-Password-1111!';
const token = cookie => cookie.split(';')[0].slice('taskflow_session='.length);
async function root() { await mkdir(evidenceRoot, { recursive: true }); return mkdtemp(path.join(evidenceRoot, 'case-')); }
async function service(t, options = {}) { const rootDir = await root(), team = await createTeamAccess({ rootDir, ...options }); t.after(() => team.close()); return { rootDir, team }; }
async function setup(t, options = {}) { const instance = await service(t, options), owner = await instance.team.setup({ name: '负责人', password: ownerPassword }); return { ...instance, owner }; }
const status = (expected, error) => error?.status === expected;

test('real SQLite stores salted scrypt hashes and only opaque hashed expiring sessions', async t => {
  let time = 1000; const { team, owner, rootDir } = await setup(t, { now: () => time });
  assert.deepEqual(Object.keys(owner.user), ['id', 'name', 'role', 'active']); assert.equal(owner.user.role, 'owner'); assert.equal(Object.isFrozen(owner.user), true);
  assert.match(owner.cookie, /^taskflow_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/u);
  const member = await team.createMember(owner.cookie, { name: '审阅者', password: ownerPassword, role: 'reviewer' });
  const db = new DatabaseSync(path.join(rootDir, 'team.sqlite'));
  try {
    const users = db.prepare('SELECT * FROM members ORDER BY name').all(); assert.equal(users.length, 2); assert.notEqual(users[0].salt, users[1].salt); assert.notEqual(users[0].password_hash, users[1].password_hash);
    for (const row of users) { assert.match(row.salt, /^[a-f0-9]{32}$/u); assert.match(row.password_hash, /^[a-f0-9]{64}$/u); assert.ok(!JSON.stringify(row).includes(ownerPassword)); assert.equal(scryptSync(ownerPassword, row.salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex'), row.password_hash); }
    const sessions = db.prepare('SELECT * FROM sessions').all(); assert.equal(sessions.length, 1); assert.equal(sessions[0].token_hash, createHash('sha256').update(token(owner.cookie)).digest('hex')); assert.equal(sessions[0].expires_at, time + 8 * 3600000);
    assert.ok(!JSON.stringify(sessions).includes(token(owner.cookie)));
  } finally { db.close(); }
  assert.equal(member.role, 'reviewer'); assert.deepEqual(team.identity(owner.cookie), owner.user); time += 8 * 3600000 - 1; assert.equal(team.identity(owner.cookie).id, owner.user.id); time++; assert.equal(team.identity(owner.cookie), null);
  const bytes = await readFile(path.join(rootDir, 'team.sqlite')); assert.ok(!bytes.includes(Buffer.from(ownerPassword))); assert.ok(!bytes.includes(Buffer.from(token(owner.cookie))));
});

test('owner/reviewer/observer permissions protect membership and audit without exposing passwords or session tokens', async t => {
  const { team, owner } = await setup(t);
  const reviewer = await team.createMember(owner.cookie, { name: 'reviewer', password: memberPassword, role: 'reviewer' });
  await team.createMember(owner.cookie, { name: 'observer', password: memberPassword, role: 'observer' });
  const reviewLogin = await team.login({ name: 'reviewer', password: memberPassword }), observerLogin = await team.login({ name: 'observer', password: memberPassword });
  assert.equal(team.listMembers(owner.cookie).length, 3); assert.equal(team.requireRole(reviewLogin.cookie, ['owner', 'reviewer']).id, reviewer.id);
  assert.throws(() => team.listMembers(reviewLogin.cookie), error => status(403, error)); assert.throws(() => team.events(observerLogin.cookie), error => status(403, error)); assert.throws(() => team.events(null), error => status(401, error));
  await assert.rejects(team.createMember(reviewLogin.cookie, { name: 'forbidden', password: memberPassword, role: 'owner' }), error => status(403, error));
  const first = team.events(reviewLogin.cookie), next = team.events(reviewLogin.cookie, first.cursor); assert.ok(first.events.length >= 5); assert.deepEqual(next.events, []); assert.equal(next.cursor, first.cursor);
  for (const secret of [ownerPassword, memberPassword, token(owner.cookie), token(reviewLogin.cookie)]) assert.equal(JSON.stringify(first).includes(secret), false);
});

test('role changes and disable/re-enable revoke all earlier sessions immediately and last enabled owner is retained', async t => {
  const { team, owner } = await setup(t); const user = await team.createMember(owner.cookie, { name: 'member', password: memberPassword, role: 'reviewer' });
  const a = await team.login({ name: 'member', password: memberPassword }), b = await team.login({ name: 'member', password: memberPassword });
  team.updateMember(owner.cookie, user.id, { role: 'observer', active: true }); assert.equal(team.identity(a.cookie), null); assert.equal(team.identity(b.cookie), null);
  const c = await team.login({ name: 'member', password: memberPassword }); assert.equal(c.user.role, 'observer');
  team.updateMember(owner.cookie, user.id, { role: 'observer', active: false }); assert.equal(team.identity(c.cookie), null); assert.deepEqual(await team.login({ name: 'member', password: memberPassword }), { rejected: true });
  team.updateMember(owner.cookie, user.id, { role: 'reviewer', active: true }); assert.equal(team.identity(c.cookie), null);
  assert.throws(() => team.updateMember(owner.cookie, owner.user.id, { role: 'observer', active: true }), error => status(409, error));
  assert.throws(() => team.updateMember(owner.cookie, owner.user.id, { role: 'owner', active: false }), error => status(409, error)); assert.equal(team.identity(owner.cookie).role, 'owner');
  const second = await team.createMember(owner.cookie, { name: 'second-owner', password: memberPassword, role: 'owner' });
  team.updateMember(owner.cookie, owner.user.id, { role: 'observer', active: true }); assert.equal(team.identity(owner.cookie), null);
  const secondLogin = await team.login({ name: second.name, password: memberPassword }); assert.throws(() => team.updateMember(secondLogin.cookie, second.id, { role: 'observer', active: true }), error => status(409, error));
});

test('opaque cookies reject duplicate, malformed and altered tokens; logout and TTL do not revive sessions', async t => {
  const { team, owner } = await setup(t);
  const original = token(owner.cookie); for (const value of ['', null, 'x'.repeat(8193), `taskflow_session=${original}; taskflow_session=${original}`, `taskflow_session=${original.slice(0, -1)}`, `taskflow_session=${original}!`, `taskflow_session=${original[0] === 'A' ? 'B' : 'A'}${original.slice(1)}`]) assert.equal(team.identity(value), null);
  assert.equal(team.identity(`other=present; taskflow_session=${original}; tail=present`).id, owner.user.id);
  const output = team.logout(owner.cookie); assert.match(output.cookie, /Max-Age=0$/u); assert.equal(team.identity(owner.cookie), null); assert.equal(team.identity(output.cookie), null); assert.throws(() => team.requireRole(owner.cookie, ['owner']), error => status(401, error));
});

test('five failed attempts lock both known and unknown names and persist through service restart', async t => {
  let time = 2000; const { team, owner, rootDir } = await setup(t, { now: () => time });
  for (const name of [owner.user.name, 'not-created']) {
    for (let index = 0; index < 5; index++) assert.deepEqual(await team.login({ name, password: badPassword }), { rejected: true });
    await assert.rejects(team.login({ name, password: ownerPassword }), error => status(429, error));
  }
  team.close(); const reopened = await createTeamAccess({ rootDir, now: () => time }); t.after(() => reopened.close()); assert.equal(reopened.setupRequired(), false);
  await assert.rejects(reopened.login({ name: owner.user.name, password: ownerPassword }), error => status(429, error));
  time += 900000; const restored = await reopened.login({ name: owner.user.name, password: ownerPassword }); assert.equal(restored.user.id, owner.user.id); assert.equal(reopened.identity(restored.cookie).role, 'owner');
});

test('session count is bounded without invalidating the newest authenticated login', async t => {
  let time = 1000; const { team, owner, rootDir } = await setup(t, { now: () => time }); let latest;
  for (let index = 0; index < 11; index++) { time++; latest = await team.login({ name: owner.user.name, password: ownerPassword }); }
  assert.equal(team.identity(owner.cookie), null); assert.equal(team.identity(latest.cookie).id, owner.user.id);
  const db = new DatabaseSync(path.join(rootDir, 'team.sqlite')); try { assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 10); } finally { db.close(); }
});

test('strict field and credential validation does not invoke getters or change users on malformed requests', async t => {
  const { team, owner } = await setup(t); let invoked = false;
  const getter = Object.defineProperty({ name: 'bad' }, 'password', { enumerable: true, get() { invoked = true; return memberPassword; } });
  for (const input of [getter, { name: 'bad', password: memberPassword, role: 'owner' }, { name: 'bad', password: 'short' }, { name: '../bad', password: memberPassword }, { name: 'bad', password: 'a'.repeat(12) + '\u0000' }, Object.assign(Object.create({}), { name: 'bad', password: memberPassword })]) await assert.rejects(team.login(input), error => status(400, error));
  assert.equal(invoked, false); await assert.rejects(team.setup({ name: 'other', password: memberPassword }), error => status(409, error));
  await assert.rejects(team.createMember(owner.cookie, { name: 'bad', password: memberPassword, role: 'admin' }), error => status(400, error)); assert.equal(team.listMembers(owner.cookie).length, 1);
});

test('parallel initialization on two real SQLite service connections creates exactly one initial owner', async t => {
  const rootDir = await root(), a = await createTeamAccess({ rootDir }), b = await createTeamAccess({ rootDir }); t.after(() => { a.close(); b.close(); });
  const results = await Promise.allSettled([a.setup({ name: 'owner-a', password: ownerPassword }), b.setup({ name: 'owner-b', password: memberPassword })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1); const rejected = results.find(value => value.status === 'rejected'); assert.equal(rejected.reason.status, 409);
  const winner = results.find(value => value.status === 'fulfilled').value; assert.equal(a.listMembers(winner.cookie).length, 1); assert.equal(b.identity(winner.cookie).id, winner.user.id);
});

test('closed service rejects all public operations consistently and close is idempotent', async t => {
  const { team, owner } = await setup(t); team.close(); team.close();
  for (const action of [() => team.setupRequired(), () => team.identity(owner.cookie), () => team.requireRole(owner.cookie, ['owner']), () => team.listMembers(owner.cookie), () => team.events(owner.cookie), () => team.logout(owner.cookie), () => team.updateMember(owner.cookie, owner.user.id, { role: 'owner', active: true })]) assert.throws(action, error => status(503, error));
  await assert.rejects(team.login({ name: owner.user.name, password: ownerPassword }), error => status(503, error)); await assert.rejects(team.createMember(owner.cookie, { name: 'new', password: memberPassword, role: 'observer' }), error => status(503, error));
});

test('linked account roots cannot receive a SQLite database', async () => {
  const rootDir = await root(), target = path.join(rootDir, 'target'); await mkdir(target); await symlink(target, path.join(rootDir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createTeamAccess({ rootDir: path.join(rootDir, 'alias', 'no-database') }), error => status(500, error));
});

test('an invalid clock cannot partially initialize an account or initial session', async t => {
  const { team } = await service(t, { now: () => NaN }); await assert.rejects(team.setup({ name: 'owner', password: ownerPassword }), error => status(500, error)); assert.equal(team.setupRequired(), true);
});

test('slow actual scrypt completion cannot publish after owner revocation, user revision change, close or a newer login lockout', async () => {
  const childRoot = await root();
  const script = `import assert from 'node:assert/strict';import {mock} from 'node:test';import * as crypto from 'node:crypto';import path from 'node:path';
  let shouldHold=()=>false,release,enteredResolve;let entered;function gate(predicate){shouldHold=predicate;entered=new Promise(resolve=>enteredResolve=resolve);}
  function scrypt(...args){const callback=args.pop(),hold=shouldHold(args[0]);crypto.scrypt(...args,(error,value)=>{if(hold){release=()=>callback(error,value);enteredResolve();}else callback(error,value);});}
  mock.module('node:crypto',{namedExports:{randomBytes:crypto.randomBytes,randomUUID:crypto.randomUUID,scrypt,timingSafeEqual:crypto.timingSafeEqual,createHash:crypto.createHash}});
  const {createTeamAccess}=await import(${JSON.stringify(new URL('../lib/team-access.mjs', import.meta.url).href)});const pw=${JSON.stringify(ownerPassword)},memberPw=${JSON.stringify(memberPassword)},badPw=${JSON.stringify(badPassword)};const results=[];
  async function fresh(label){shouldHold=()=>false;const service=await createTeamAccess({rootDir:path.join(${JSON.stringify(childRoot)},label)});const owner=await service.setup({name:'owner',password:pw});return {service,owner};}
  {const {service,owner}=await fresh('revoked-owner');try{await service.createMember(owner.cookie,{name:'backup',password:memberPw,role:'owner'});const backup=await service.login({name:'backup',password:memberPw});gate(value=>value===badPw);const pending=service.createMember(owner.cookie,{name:'must-not-exist',password:badPw,role:'owner'});await entered;service.updateMember(backup.cookie,owner.user.id,{role:'observer',active:true});release();let error;try{await pending;}catch(caught){error=caught;}assert.equal(error?.status,401);assert.equal(service.listMembers(backup.cookie).some(user=>user.name==='must-not-exist'),false);results.push({case:'owner-revoked-during-real-hash',passed:true});}finally{service.close();}}
  {const {service,owner}=await fresh('changed-user');try{const user=await service.createMember(owner.cookie,{name:'member',password:memberPw,role:'reviewer'});gate(value=>value===memberPw);const pending=service.login({name:'member',password:memberPw});await entered;service.updateMember(owner.cookie,user.id,{role:'observer',active:true});release();assert.deepEqual(await pending,{rejected:true});results.push({case:'revision-changed-during-real-hash',passed:true});}finally{service.close();}}
  {const {service,owner}=await fresh('closed');gate(value=>value===memberPw);const pending=service.createMember(owner.cookie,{name:'must-not-exist',password:memberPw,role:'observer'});await entered;service.close();release();let error;try{await pending;}catch(caught){error=caught;}assert.equal(error?.status,503);results.push({case:'closed-during-real-hash',passed:true});}
  {const {service,owner}=await fresh('locked');try{for(let index=0;index<3;index++)assert.deepEqual(await service.login({name:'owner',password:badPw}),{rejected:true});gate(value=>value===pw);const pending=service.login({name:'owner',password:pw});await entered;await service.login({name:'owner',password:badPw});await service.login({name:'owner',password:badPw});release();let error,result;try{result=await pending;}catch(caught){error=caught;}results.push({case:'newer-lockout-wins-over-late-real-hash',passed:error?.status===429,actual:{errorStatus:error?.status??null,sessionGranted:!!result?.cookie}});assert.equal(error?.status,429,'a late earlier login cannot clear a newly established lockout');}finally{service.close();}}
  process.stdout.write(JSON.stringify(results));`;
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  await writeFile(path.join(childRoot, 'slow-hash-stdout.txt'), child.stdout); await writeFile(path.join(childRoot, 'slow-hash-stderr.txt'), child.stderr);
  assert.equal(child.status, 0, child.stdout + child.stderr); const result = JSON.parse(child.stdout); assert.equal(result.length, 4); assert.ok(result.every(item => item.passed));
});

test('four in-flight actual password hashes bound work and closing cannot publish their later results', async () => {
  const childRoot = await root();
  const script = `import assert from 'node:assert/strict';import {mock} from 'node:test';import * as crypto from 'node:crypto';let held=false;const completions=[];let resolveAll;const all=new Promise(resolve=>resolveAll=resolve);function scrypt(...args){const callback=args.pop(),hold=held;crypto.scrypt(...args,(error,value)=>{if(hold){completions.push(()=>callback(error,value));if(completions.length===4)resolveAll();}else callback(error,value);});}mock.module('node:crypto',{namedExports:{randomBytes:crypto.randomBytes,randomUUID:crypto.randomUUID,scrypt,timingSafeEqual:crypto.timingSafeEqual,createHash:crypto.createHash}});const {createTeamAccess}=await import(${JSON.stringify(new URL('../lib/team-access.mjs', import.meta.url).href)});const team=await createTeamAccess({rootDir:${JSON.stringify(childRoot)}});await team.setup({name:'owner',password:${JSON.stringify(ownerPassword)}});held=true;const attempts=Array.from({length:4},()=>team.login({name:'owner',password:${JSON.stringify(badPassword)}}));await all;await assert.rejects(team.login({name:'owner',password:${JSON.stringify(ownerPassword)}}),error=>error.status===429);team.close();for(const release of completions)release();const results=await Promise.allSettled(attempts);assert.equal(results.every(result=>result.status==='rejected'&&result.reason.status===503),true);process.stdout.write(JSON.stringify({held:completions.length,latePublished:0,closedStatus:503,busyStatus:429}));`;
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  await writeFile(path.join(childRoot, 'bounded-hash-child.json'), JSON.stringify({ exitCode: child.status, output: child.stdout, error: child.status === 0 ? null : child.stderr }, null, 2)); assert.equal(child.status, 0, child.stdout + child.stderr);
});
