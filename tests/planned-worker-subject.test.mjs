import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createTeamAccess, createLocalExecutionSubject, describeExecutionSubject, assertExecutionSubjectCurrent } from '../lib/team-access.mjs';

const password = 'Synthetic-Worker-Subject-Password-123';
async function fixture(t) {
  const rootDir = await mkdtemp(path.resolve('output/subject-')); let team = await createTeamAccess({ rootDir });
  t.after(() => team.close()); const a = await team.setup({ name: 'ownerA', password });
  await team.createMember(a.cookie, { name: 'ownerB', password, role: 'owner' }); const b = await team.login({ name: 'ownerB', password });
  return { rootDir, a, b, get team() { return team; }, async reopen() { team.close(); team = await createTeamAccess({ rootDir }); } };
}
test('real session mints a private execution capability; DTO, descriptor JSON and getters cannot mint one', async t => {
  const f = await fixture(t), cap = f.team.executionSubject(f.a.cookie), value = describeExecutionSubject(cap);
  assert.equal(value.memberId, f.a.user.id); assert.equal(value.role, 'owner'); assert.equal(value.revision, 1); assert.equal(Object.isFrozen(value), true);
  assert.equal(JSON.stringify(value).includes(f.a.cookie), false); assert.equal(assertExecutionSubjectCurrent(value), true);
  for (const fake of [structuredClone(cap), structuredClone(value), f.a.user]) assert.throws(() => describeExecutionSubject(fake));
  let reads = 0; const fake = { version: 1, get kind() { reads++; return 'local'; } }; assert.throws(() => assertExecutionSubjectCurrent(fake)); assert.equal(reads, 0);
  const local = createLocalExecutionSubject(); assert.deepEqual(describeExecutionSubject(local), { version: 1, kind: 'local' });
});
test('persistent execution subject survives API close but disable/enable ABA never restores original authorization', async t => {
  const f = await fixture(t), cap = f.team.executionSubject(f.a.cookie), value = describeExecutionSubject(cap);
  await f.reopen(); assert.equal(assertExecutionSubjectCurrent(value), true);
  f.team.updateMember(f.b.cookie, f.a.user.id, { role: 'owner', active: false }); assert.throws(() => assertExecutionSubjectCurrent(value), { code: 'execution_subject_revoked' });
  f.team.updateMember(f.b.cookie, f.a.user.id, { role: 'owner', active: true }); const login = await f.team.login({ name: 'ownerA', password });
  assert.throws(() => assertExecutionSubjectCurrent(value), { code: 'execution_subject_revoked' });
  const fresh = describeExecutionSubject(f.team.executionSubject(login.cookie)); assert.equal(fresh.revision, 3); assert.equal(assertExecutionSubjectCurrent(fresh), true);
});
test('role demotion and authority replacement fence the signed subject without exposing raw database details', async t => {
  const f = await fixture(t), value = describeExecutionSubject(f.team.executionSubject(f.a.cookie));
  f.team.updateMember(f.b.cookie, f.a.user.id, { role: 'reviewer', active: true }); assert.throws(() => assertExecutionSubjectCurrent(value), { code: 'execution_subject_revoked' });
  const b = describeExecutionSubject(f.team.executionSubject(f.b.cookie)), db = new DatabaseSync(path.join(f.rootDir, 'team.sqlite'));
  db.prepare("UPDATE execution_authority SET instance_id='new-authority' WHERE id=1").run(); db.close();
  assert.throws(() => assertExecutionSubjectCurrent(b), error => error.code === 'execution_subject_revoked' && !error.message.includes(f.rootDir));
});
test('missing established authority is never silently recreated on API restart', async t => {
  const f = await fixture(t), db = new DatabaseSync(path.join(f.rootDir, 'team.sqlite')); db.prepare('DELETE FROM execution_authority').run(); db.close();
  await assert.rejects(f.reopen(), error => error.status === 503);
});
