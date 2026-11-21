import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

// Only account identity, local planning and HTTP admission are exercised.
// Downstream development services are inert route sentinels; no paid model,
// generated application or claim of business acceptance is involved.
const password = 'Independent-test-password-2026', secret = 'HTTP-BODY-MUST-NOT-ENTER-AUDIT';
const specification = text => ({ title: '团队资源', summary: text, goals: ['查看资源'], roles: ['用户'], questions: [], constraints: [], assumptions: [], acceptanceScenarios: ['展示资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [{ id: 'R-001', title: '读取资源', description: text, sourceQuote: text, acceptance: ['显示列表'] }] });
const cookieOf = response => response.cookie?.split(';')[0] ?? '';
const post = (body, cookie = '') => ({ method: 'POST', body, cookie });
async function until(check) { const deadline = Date.now() + 7000; for (;;) { const result = await check(); if (result) return result; assert.ok(Date.now() < deadline, '等待真实本地状态超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }

async function fixture(t, { enabled = true, roles = true, omitSwitch = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-access-http-')), reached = [];
  const sentinel = kind => Object.freeze({
    list: async input => ({ kind, proposals: [], executions: [], input }),
    ...Object.fromEntries(['start', 'repair', 'cancel', 'action', 'propose', 'approve', 'reject', 'revise'].map(action => [action, async input => { reached.push({ kind, action, input }); return { execution: { id: 'inert-result' }, proposal: { id: input.proposalId ?? 'inert-proposal' } }; }])),
    withProjectCheckpoint: async (_id, work) => work(), shutdown: async () => {},
  });
  const options = { dataDir: directory, ...(omitSwitch ? {} : { teamEnabled: enabled }), stepDelayMs: 0, planner: { ...planner, analyzeRequirements: specification, getModelConfig: () => ({ configured: false, model: 'no-remote-http-test' }), analyzeWithModel: () => assert.fail('不得发起付费模型') }, executionService: sentinel('fixed'), verificationPlanningService: sentinel('verification'), plannedExecutionService: sentinel('planned') };
  let app = await createApp(options), origin; const apps = [app];
  t.after(async () => { for (const instance of [...apps].reverse()) await instance.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('team-access-http-')); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (target, { method = 'GET', body, cookie = '', headers = {} } = {}) => {
    const response = await fetch(origin + target, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text(); let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    return { status: response.status, body: parsed, cookie: response.headers.get('set-cookie'), requestId: response.headers.get('x-request-id') };
  };
  const f = { app, directory, origin, request, reached };
  f.restart = async () => { await app.close(); app = await createApp(options); apps.push(app); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`; f.app = app; f.origin = origin; };
  if (enabled && roles) {
    const owner = await request('/api/team/setup', post({ name: 'owner', password })); assert.equal(owner.status, 201); f.owner = { ...owner.body.user, cookie: cookieOf(owner) };
    for (const role of ['reviewer', 'observer']) {
      const created = await request('/api/team/members', post({ name: role, password, role }, f.owner.cookie)); assert.equal(created.status, 201);
      const login = await request('/api/team/login', post({ name: role, password })); assert.equal(login.status, 200); f[role] = { ...login.body.user, cookie: cookieOf(login) };
    }
  }
  f.project = async (cookie = f.owner?.cookie ?? '', name = '团队HTTP项目') => { const result = await request('/api/projects', post({ name, filename: 'r.md', content: '用户可以查看资源列表。' }, cookie)); assert.equal(result.status, 201); return result.body.project; };
  f.seedRun = async project => { const record = f.app.store.get(project.id), run = { id: randomUUID(), status: 'succeeded', stages: [], artifacts: [], tasks: [], workflowVersion: 1 }; record.runs.push(run); await f.app.store.save(record); await f.app.store.flush(); return run; };
  return f;
}

test('disabled team mode preserves unauthenticated local project APIs and advertises no team login', async t => {
  const old = process.env.TASKFLOW_TEAM_MODE; process.env.TASKFLOW_TEAM_MODE = '1'; t.after(() => { if (old === undefined) delete process.env.TASKFLOW_TEAM_MODE; else process.env.TASKFLOW_TEAM_MODE = old; });
  const f = await fixture(t, { enabled: false });
  assert.deepEqual((await f.request('/api/team/session')).body, { enabled: false, setupRequired: false, user: null });
  assert.equal((await f.request('/api/health')).body.teamAccess.enabled, false); await f.project();
  assert.equal((await f.request('/api/projects')).status, 200);
  assert.equal((await f.request('/api/team/setup', post({ name: 'unused', password }))).status, 404);
  delete process.env.TASKFLOW_TEAM_MODE;
  const defaults = await fixture(t, { enabled: false, roles: false, omitSwitch: true });
  assert.equal((await defaults.request('/api/team/session')).body.enabled, false); await defaults.project();
  process.env.TASKFLOW_TEAM_MODE = '1';
  const optedIn = await fixture(t, { enabled: true, roles: false, omitSwitch: true });
  assert.equal((await optedIn.request('/api/team/session')).body.enabled, true); assert.equal((await optedIn.request('/api/projects')).status, 401);
});

test('enabled mode keeps setup/session public but blocks every anonymous project read and write', async t => {
  const f = await fixture(t, { roles: false });
  assert.deepEqual((await f.request('/api/team/session')).body, { enabled: true, setupRequired: true, user: null });
  assert.equal((await f.request('/api/health')).body.teamAccess.enabled, true);
  for (const [target, options] of [['/api/projects', {}], ['/api/projects', post({ name: 'no', filename: 'r.md', content: 'no' })], ['/api/projects/foreign', {}], ['/api/projects/foreign/runs/foreign/download', {}], ['/api/team/members', {}], ['/api/team/audit', {}]]) assert.equal((await f.request(target, options)).status, 401, target);
  const [a, b] = await Promise.all(['first', 'second'].map(name => f.request('/api/team/setup', post({ name, password }))));
  assert.deepEqual([a.status, b.status].sort(), [201, 409]); const winner = a.status === 201 ? a : b;
  assert.match(winner.cookie, /HttpOnly/u); assert.match(winner.cookie, /SameSite=Strict/u); assert.match(winner.cookie, /Max-Age=28800/u); assert.equal(winner.body.user.role, 'owner');
  const db = new DatabaseSync(path.join(f.directory, 'team-access', 'team.sqlite')); try { assert.equal(db.prepare('SELECT COUNT(*) n FROM members').get().n, 1); } finally { db.close(); }
});

test('real HTTP accounts have distinct opaque sessions and only owner can administer members', async t => {
  const f = await fixture(t), cookies = [f.owner.cookie, f.reviewer.cookie, f.observer.cookie]; assert.equal(new Set(cookies).size, 3);
  for (const role of ['owner', 'reviewer', 'observer']) { const result = await f.request('/api/team/session', { cookie: f[role].cookie }); assert.equal(result.body.user.id, f[role].id); assert.equal(result.body.user.role, role); }
  assert.equal((await f.request('/api/team/members', { cookie: f.owner.cookie })).body.members.length, 3);
  for (const role of ['reviewer', 'observer']) {
    assert.equal((await f.request('/api/team/members', { cookie: f[role].cookie })).status, 403);
    assert.equal((await f.request('/api/team/members', post({ name: 'escalation', role: 'owner', password }, f[role].cookie))).status, 403);
    assert.equal((await f.request(`/api/team/members/${f.owner.id}`, { method: 'PATCH', cookie: f[role].cookie, body: { role: 'observer', active: true } })).status, 403);
  }
  const members = await f.request('/api/team/members', { cookie: f.owner.cookie }); assert.equal(members.body.members.length, 3);
  assert.equal(JSON.stringify(members.body).includes(password), false); assert.equal(JSON.stringify(members.body).includes('password_hash'), false); assert.equal(JSON.stringify(members.body).includes('salt'), false);
  assert.equal((await f.request('/api/team/login', post({ name: 'owner', password: 'wrong-password-2026' }))).status, 401);
  assert.equal((await f.request('/api/projects', { headers: { cookie: `${f.owner.cookie}; ${f.owner.cookie}` } })).status, 401);
});

test('observer can read project/run evidence while all project mutations are denied before downstream admission', async t => {
  const f = await fixture(t), project = await f.project(), run = await f.seedRun(project), base = `/api/projects/${project.id}/runs/${run.id}`;
  for (const target of ['/api/projects', `/api/projects/${project.id}`, base, `${base}/verification-plans`, `${base}/development-executions`, `${base}/executions`]) assert.equal((await f.request(target, { cookie: f.observer.cookie })).status, 200, target);
  for (const [target, method, body] of [['/api/projects', 'POST', {}], [`/api/projects/${project.id}`, 'DELETE', { confirmationName: project.name }], [`/api/projects/${project.id}/changes`, 'POST', {}], [`/api/projects/${project.id}/runs`, 'POST', {}], [`${base}/action`, 'POST', { action: 'approve_spec' }], [`${base}/development-executions/start`, 'POST', {}], [`${base}/development-executions/original/repair`, 'POST', {}], [`${base}/executions/start`, 'POST', {}], [`${base}/verification-plans/proposal/approve`, 'POST', {}]]) assert.equal((await f.request(target, { method, body, cookie: f.observer.cookie })).status, 403, target);
  assert.deepEqual(f.reached, []); assert.equal(f.app.store.list().length, 1);
});

test('reviewer approval whitelist cannot grant coding, source changes, plan edits or old generic approve', async t => {
  const f = await fixture(t), project = await f.project(), run = await f.seedRun(project), base = `/api/projects/${project.id}/runs/${run.id}`;
  for (const action of ['approve', 'revise_spec', 'revise_plan', 'clarify_spec', 'supplement_spec', 'resume', 'pause', 'retry', 'use_local_engineering']) assert.equal((await f.request(`${base}/action`, post({ action }, f.reviewer.cookie))).status, 403, action);
  for (const [tail, body] of [['development-executions/start', { proposalId: 'p', revision: 'a'.repeat(64), contractRevision: 'b'.repeat(64) }], ['development-executions/old/repair', { contractRevision: 'b'.repeat(64) }], ['executions/start', { profileId: 'library-web-v1', contractRevision: 'b'.repeat(64) }], ['verification-plans/propose', { contractRevision: 'b'.repeat(64) }], ['verification-plans/p/revise', { revision: 'a'.repeat(64), proposal: {}, feedback: 'no' }], ['verification-plans/p/cancel', {}]]) assert.equal((await f.request(`${base}/${tail}`, post(body, f.reviewer.cookie))).status, 403, tail);
  assert.equal((await f.request(`/api/projects/${project.id}/changes`, post({}, f.reviewer.cookie))).status, 403);
  assert.deepEqual(f.reached, []);
  for (const action of ['approve', 'reject']) assert.equal((await f.request(`${base}/verification-plans/p/${action}`, post({ revision: 'a'.repeat(64), feedback: 'review opinion' }, f.reviewer.cookie))).status, 200);
  assert.deepEqual(f.reached.map(x => [x.kind, x.action]), [['verification', 'approve'], ['verification', 'reject']]);
  assert.equal((await f.request(`${base}/development-executions/start`, post({ proposalId: 'p', revision: 'a'.repeat(64), contractRevision: 'b'.repeat(64) }, f.owner.cookie))).status, 202);
  assert.equal((await f.request(`${base}/executions/start`, post({ profileId: 'library-web-v1', contractRevision: 'b'.repeat(64) }, f.owner.cookie))).status, 202);
  assert.deepEqual(f.reached.slice(2).map(x => [x.kind, x.action]), [['planned', 'start'], ['fixed', 'start']], 'owner positive control reaches the same inert routes denied to reviewer');
});

test('reviewer can really approve current local spec then plan through the cached HTTP body', async t => {
  const f = await fixture(t), project = await f.project(), started = await f.request(`/api/projects/${project.id}/runs`, post({ mode: 'local' }, f.owner.cookie)); assert.equal(started.status, 201);
  const run = f.app.store.getRun(project.id, started.body.run.id).run, base = `/api/projects/${project.id}/runs/${run.id}`;
  await until(() => run.status === 'awaiting_spec' && !f.app.orchestrator.state(run).driving);
  const spec = await f.request(`${base}/action`, post({ action: 'approve_spec', revision: run.specRevision, feedback: '确认当前规格' }, f.reviewer.cookie)); assert.equal(spec.status, 200);
  await until(() => run.status === 'awaiting_review' && !f.app.orchestrator.state(run).driving);
  const plan = await f.request(`${base}/action`, post({ action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision, feedback: '确认当前计划' }, f.reviewer.cookie)); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  await until(() => run.status === 'succeeded' && !f.app.orchestrator.state(run).driving);
  assert.equal(run.approvals.spec.revision, run.specRevision); assert.equal(run.approvals.plan.revision, run.planRevision);
  assert.deepEqual(f.reached, [], 'local approval must not enter coding sentinels');
});

test('owner mutation audits correlate request attempt/result without request body, cookie or password', async t => {
  const f = await fixture(t), result = await f.request('/api/projects?ignored=' + secret, { ...post({ name: '审计项目', filename: 'r.md', content: secret }, f.owner.cookie), headers: { 'x-request-id': 'client-spoof' } }); assert.equal(result.status, 201);
  assert.match(result.requestId, /^[a-f0-9-]{36}$/u); assert.notEqual(result.requestId, 'client-spoof');
  const events = (await f.request('/api/team/audit', { cookie: f.reviewer.cookie })).body.events, chain = events.filter(x => x.request_id === result.requestId);
  assert.equal(chain.length, 2); assert.ok(chain.some(x => x.action === 'request.POST' && x.status === 0)); assert.ok(chain.some(x => x.action === 'request.finished' && x.status === 201));
  assert.ok(chain.every(x => x.actor_id === f.owner.id && x.actor_role === 'owner' && x.target === '/api/projects'));
  const serialized = JSON.stringify(events); assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes(password), false); assert.equal(serialized.includes(f.owner.cookie.split('=')[1]), false);
  assert.equal((await f.request('/api/team/audit', { cookie: f.observer.cookie })).status, 403);
  const page = await f.request('/api/team/audit', { cookie: f.owner.cookie }), next = await f.request(`/api/team/audit?after=${page.body.cursor}`, { cookie: f.owner.cookie }); assert.deepEqual(next.body.events, []); assert.equal(next.body.cursor, page.body.cursor);
  for (const cursor of ['-1', 'NaN', '1.5']) assert.equal((await f.request('/api/team/audit?after=' + cursor, { cookie: f.owner.cookie })).status, 400);
});

test('role changes, deactivation, logout and restart never restore an earlier account session', async t => {
  const f = await fixture(t), first = f.reviewer.cookie, second = cookieOf(await f.request('/api/team/login', post({ name: 'reviewer', password })));
  assert.equal((await f.request(`/api/team/members/${f.reviewer.id}`, { method: 'PATCH', cookie: f.owner.cookie, body: { role: 'observer', active: true } })).status, 200);
  for (const cookie of [first, second]) assert.equal((await f.request('/api/projects', { cookie })).status, 401);
  const login = await f.request('/api/team/login', post({ name: 'reviewer', password })); assert.equal(login.body.user.role, 'observer'); const fresh = cookieOf(login);
  assert.equal((await f.request(`/api/team/members/${f.reviewer.id}`, { method: 'PATCH', cookie: f.owner.cookie, body: { role: 'observer', active: false } })).status, 200);
  assert.equal((await f.request('/api/projects', { cookie: fresh })).status, 401); assert.equal((await f.request('/api/team/login', post({ name: 'reviewer', password }))).status, 401);
  assert.equal((await f.request(`/api/team/members/${f.reviewer.id}`, { method: 'PATCH', cookie: f.owner.cookie, body: { role: 'reviewer', active: true } })).status, 200); assert.equal((await f.request('/api/projects', { cookie: fresh })).status, 401);
  const out = await f.request('/api/team/logout', post({}, f.observer.cookie)); assert.equal(out.status, 200); assert.match(out.cookie, /Max-Age=0/u); assert.equal((await f.request('/api/projects', { cookie: f.observer.cookie })).status, 401);
  assert.equal((await f.request(`/api/team/members/${f.owner.id}`, { method: 'PATCH', cookie: f.owner.cookie, body: { role: 'owner', active: false } })).status, 409);
  assert.equal((await f.request('/api/projects', { cookie: f.owner.cookie })).status, 200);
  await f.restart();
  assert.equal((await f.request('/api/team/session')).body.setupRequired, false);
  assert.equal((await f.request('/api/projects', { cookie: f.owner.cookie })).status, 200, 'still-valid owner session persists across restart');
  for (const cookie of [first, second, fresh, f.observer.cookie]) assert.equal((await f.request('/api/projects', { cookie })).status, 401);
});

test('team mutations and denied project writes expose one server-generated audit correlation without secrets', async t => {
  const f = await fixture(t, { roles: false }), setup = await f.request('/api/team/setup', { ...post({ name: 'audit-owner', password }), headers: { 'x-request-id': 'forged-id' } }); assert.equal(setup.status, 201); const ownerCookie = cookieOf(setup);
  const member = await f.request('/api/team/members', post({ name: 'audit-observer', password, role: 'observer' }, ownerCookie)); assert.equal(member.status, 201);
  const login = await f.request('/api/team/login', post({ name: 'audit-observer', password })); assert.equal(login.status, 200); const observerCookie = cookieOf(login);
  const denied = await f.request('/api/projects', post({ name: secret, filename: 'r.md', content: secret }, observerCookie)); assert.equal(denied.status, 403);
  const failedLogin = await f.request('/api/team/login', post({ name: 'audit-observer', password: 'wrong-http-password-2026' })); assert.equal(failedLogin.status, 401);
  const updated = await f.request(`/api/team/members/${member.body.member.id}`, { method: 'PATCH', cookie: ownerCookie, body: { role: 'reviewer', active: true } }); assert.equal(updated.status, 200);
  const logout = await f.request('/api/team/logout', post({}, ownerCookie)); assert.equal(logout.status, 200);
  const renewed = await f.request('/api/team/login', post({ name: 'audit-owner', password })); assert.equal(renewed.status, 200);
  const events = (await f.request('/api/team/audit', { cookie: cookieOf(renewed) })).body.events;
  for (const [response, action] of [[setup, 'team.setup'], [member, 'team.member_created'], [login, 'team.login'], [failedLogin, 'team.login_failed'], [updated, 'team.member_updated'], [logout, 'team.logout']]) {
    assert.match(response.requestId, /^[a-f0-9-]{36}$/u); assert.notEqual(response.requestId, 'forged-id');
    const chain = events.filter(event => event.request_id === response.requestId);
    assert.ok(chain.some(event => event.status === 0), `${action} attempt must be recorded`);
    assert.ok(chain.some(event => event.action === action), `${action} internal outcome must use the HTTP id`);
    assert.ok(chain.some(event => event.action === 'request.finished' && event.status === response.status), `${action} HTTP result must correlate`);
  }
  assert.match(denied.requestId, /^[a-f0-9-]{36}$/u); const rejection = events.filter(event => event.request_id === denied.requestId);
  assert.ok(rejection.some(event => event.action === 'request.denied' && event.status === 403)); assert.ok(rejection.some(event => event.action === 'request.finished' && event.status === 403));
  const text = JSON.stringify(events); for (const value of [secret, password, 'wrong-http-password-2026', observerCookie.split('=')[1]]) assert.equal(text.includes(value), false);
});

test('reviewer can reject current spec or current plan without acquiring revision or coding authority', async t => {
  const f = await fixture(t);
  for (const kind of ['spec', 'plan']) {
    const project = await f.project(f.owner.cookie, 'reject-' + kind), started = await f.request(`/api/projects/${project.id}/runs`, post({ mode: 'local' }, f.owner.cookie)); assert.equal(started.status, 201);
    const run = f.app.store.getRun(project.id, started.body.run.id).run, endpoint = `/api/projects/${project.id}/runs/${run.id}/action`;
    await until(() => run.status === 'awaiting_spec' && !f.app.orchestrator.state(run).driving);
    if (kind === 'plan') { assert.equal((await f.request(endpoint, post({ action: 'approve_spec', revision: run.specRevision }, f.reviewer.cookie))).status, 200); await until(() => run.status === 'awaiting_review' && !f.app.orchestrator.state(run).driving); }
    const rejected = await f.request(endpoint, post({ action: `reject_${kind}`, revision: kind === 'spec' ? run.specRevision : run.planRevision, feedback: '需要实际修订' }, f.reviewer.cookie)); assert.equal(rejected.status, 200);
    assert.equal(run.decisions.at(-1).action, `reject_${kind}`); assert.equal(run.approvals[kind], null);
  }
  assert.deepEqual(f.reached, []);
});

test('loopback Host, exact port, Origin and cross-site headers protect login and authenticated projects', async t => {
  const f = await fixture(t), cases = [['/api/team/session', 'GET', undefined], ['/api/team/login', 'POST', { name: 'owner', password }], ['/api/projects', 'GET', undefined], ['/api/projects', 'POST', {}]];
  for (const [target, method, body] of cases) {
    assert.equal((await f.request(target, { method, body, cookie: f.owner.cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, target);
    for (const host of ['attacker.invalid', '127.0.0.1:1', `user@127.0.0.1:${f.app.server.address().port}`]) {
      const status = await new Promise((resolve, reject) => { const request = http.request(f.origin + target, { method, headers: { host, cookie: f.owner.cookie, ...(body ? { 'content-type': 'application/json' } : {}) } }, response => { response.resume(); resolve(response.statusCode); }); request.once('error', reject); request.end(body ? JSON.stringify(body) : undefined); }); assert.equal(status, 403, host);
    }
  }
  for (const origin of ['https://attacker.invalid', 'null', 'not an origin']) assert.equal((await f.request('/api/team/login', { ...post({ name: 'owner', password }), headers: { origin } })).status, 403);
  assert.equal((await f.request('/api/team/login', { ...post({ name: 'owner', password }), headers: { origin: f.origin } })).status, 200);
});

test('revoking an owner while its JSON body is pending prevents a late project mutation', async t => {
  const f = await fixture(t), secondCreated = await f.request('/api/team/members', post({ name: 'second-owner', password, role: 'owner' }, f.owner.cookie)); assert.equal(secondCreated.status, 201);
  const second = cookieOf(await f.request('/api/team/login', post({ name: 'second-owner', password }))), chunks = JSON.stringify({ name: 'revoked-late-write', filename: 'r.md', content: 'must not be saved' });
  let resolveResponse, rejectResponse; const completed = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; }); void completed.catch(() => {});
  const stream = http.request(f.origin + '/api/projects', { method: 'POST', headers: { cookie: f.owner.cookie, 'content-type': 'application/json' } }, response => { response.resume(); response.once('end', () => resolveResponse(response.statusCode)); }); stream.once('error', rejectResponse); t.after(() => stream.destroy());
  stream.setTimeout(7000, () => stream.destroy(new Error('slow-body regression timed out'))); stream.write(chunks.slice(0, 20));
  await until(async () => (await f.request('/api/team/audit', { cookie: second })).body.events.some(row => row.action === 'request.POST' && row.target === '/api/projects' && row.actor_id === f.owner.id));
  assert.equal((await f.request(`/api/team/members/${f.owner.id}`, { method: 'PATCH', cookie: second, body: { role: 'observer', active: false } })).status, 200);
  stream.end(chunks.slice(20)); const status = await completed;
  assert.ok([401, 403].includes(status), `a revoked pending request must be rejected, received ${status}`);
  assert.equal(f.app.store.list().some(p => p.name === 'revoked-late-write'), false);
});
