import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectWorkerRepair, workerRepairEvidenceHash } from '../lib/planned-worker-contract.mjs';
import { inspectPlannedSource, assertPlannedSource } from '../lib/planned-source.mjs';
import { openPlannedWorkerStore } from '../lib/planned-worker-store.mjs';
import { verifyWorkerAuthorization } from '../lib/planned-worker-seals.mjs';

const native = process.env.TASKFLOW_TEST_REAL_SANDBOX === '1' && !!process.env.EXECUTION_SANDBOX_EXE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const proposal = {
  version: 1, id: 'same-version-repair', name: 'Fixed same-version repair joint checks', sessions: [],
  steps: [{ id: 'health', type: 'request', dependsOn: [], requirementIds: ['R'], request: { id: 'health', method: 'GET', path: '/health',
    assertions: [{ id: 'status', op: 'status', value: 200 }, { id: 'body', op: 'jsonEquals', path: '$.ok', value: true }] } }],
  browser: { version: 1, sessions: ['visitor'], steps: [
    { id: 'open', session: 'visitor', requirementIds: ['R'], op: 'goto', path: '/' },
    { id: 'heading', session: 'visitor', requirementIds: ['R'], op: 'text', testId: 'welcome', value: 'Worker repair fixture' },
  ] },
};
const app = `export async function createApp(){return {handle(request){const p=new URL(request.path,'http://localhost').pathname;if(p==='/favicon.ico')return{status:204,headers:{},body:''};if(p==='/health')return{status:200,headers:{'content-type':'application/json'},body:'{"ok":true}'};return{status:200,headers:{'content-type':'text/html'},body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><h1 data-testid="welcome">Worker repair fixture</h1>'}},close(){}}}`;
const note = 'Remove both fixture markers and preserve health and welcome.';

async function until(check, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, label);
    await delay(75);
  }
}

test('same-version repair recipe rejects unsafe paths and altered authority fields', () => {
  const repair = { sourceServiceExecutionId: 'source-job', sourceExecutionId: 'source-core', sourceReportPath: 'workers/jobs/source-job/planned-web-x/execution.json',
    sourceReportHash: 'a'.repeat(64), sourceRecordHash: 'b'.repeat(64), sourceCommit: 'c'.repeat(40), sourceHash: 'd'.repeat(64),
    sourceEvidenceHash: 'e'.repeat(64), repairNote: null };
  assert.deepEqual(inspectWorkerRepair(repair), repair);
  for (const sourceReportPath of ['../execution.json', 'C:/data/execution.json', '/data/execution.json', 'a\\execution.json', 'a/../execution.json',
    'a/file.json', 'a./execution.json', 'a/execution.json:stream']) {
    assert.throws(() => inspectWorkerRepair({ ...repair, sourceReportPath }), { code: 'worker_repair_source_invalid' });
  }
  assert.throws(() => inspectWorkerRepair({ ...repair, sourceRecordHash: 'incorrect' }), { code: 'worker_repair_source_invalid' });
  assert.throws(() => inspectWorkerRepair({ ...repair, repairNote: 'invalid\u0000diagnosis' }), { code: 'worker_repair_source_invalid' });
  assert.throws(() => inspectWorkerRepair({ ...repair, files: [] }));
});

test('native same-version repair retains all historical blockers and resumes the same Worker across API restarts', { skip: !native, timeout: 160000 }, async t => {
  const output = path.resolve('output');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, 'wr-'));
  const requests = [], errors = [];
  let currentApi, repairing = false, release, phaseCoding = 0, phaseReview = 0;

  const model = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
      const role = Object.hasOwn(input, 'engineeringContract') ? 'definition' : Object.hasOwn(input, 'feedback') ? 'coding' : 'review';
      requests.push({ role, repairing, input });
      let result;
      if (role === 'definition') result = proposal;
      else if (role === 'coding') {
        if (repairing) await new Promise(resolve => { release = resolve; });
        const content = repairing ? app : `// original-iteration ${++phaseCoding}\n// first historical finding\n// second historical finding\n${app}`;
        result = { files: [{ path: 'src/app.mjs', content }] };
      } else {
        const iteration = repairing ? 0 : ++phaseReview;
        const issues = iteration >= 1 && iteration <= 2 ? [{ severity: 'blocking', file: 'src/app.mjs', line: iteration + 1, message: `Remove fixture marker ${iteration}.` }] : [];
        const resolutions = input.previousIssues.map(it => ({ id: it.id, status: repairing || it.line === 2 ? 'resolved' : 'open', reason: 'Rechecked this id on the current native fixture.' }));
        result = { summary: 'Controlled native Review', issues, resolutions };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^LLM_|^TASKFLOW_TEAM/iu.test(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, { LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, LLM_MODEL: 'synthetic-worker-repair',
    LLM_API_KEY: 'synthetic-local-worker-repair-key', LLM_JSON_MODE: '1', LLM_THINKING: 'disabled', TASKFLOW_TEAM_MODE: '0' });

  async function open(identity, label) {
    const processHandle = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'planned-worker-api.mjs')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    processHandle.stdout.on('data', chunk => { stdout += chunk; });
    processHandle.stderr.on('data', chunk => { stderr += chunk; });
    const exit = new Promise(resolve => processHandle.on('exit', resolve));
    processHandle.stdin.write(`${JSON.stringify({ directory, identity, seed: !identity })}\n`);
    const close = async () => {
      if (processHandle.exitCode === null) processHandle.stdin.end(`${JSON.stringify({ close: true })}\n`);
      const code = await exit;
      await writeFile(path.join(directory, `${label}.log`), `${stdout}\n${stderr}`);
      assert.equal(code, 0, stderr);
    };
    currentApi = { close, ready: null };
    currentApi.ready = await until(() => stdout.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row?.ready), `${label} ready`, 12000);
    return currentApi;
  }

  const request = async (route, body) => {
    const result = await fetch(currentApi.ready.origin + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bytes = Buffer.from(await result.arrayBuffer());
    let value;
    try { value = JSON.parse(bytes); } catch { value = null; }
    return { status: result.status, value, bytes };
  };
  const rootDir = path.join(directory, 'planned-executions'), workerRoot = path.join(rootDir, 'workers');
  const rows = (filename, query, ...args) => {
    const db = new DatabaseSync(filename, { readOnly: true });
    try { return db.prepare(query).all(...args); } finally { db.close(); }
  };
  const budget = () => rows(path.join(rootDir, 'planned.sqlite'), 'SELECT attempts,used_calls,reserved_calls FROM budgets').map(row => ({ ...row }))[0];
  const execution = id => JSON.parse(rows(path.join(rootDir, 'planned.sqlite'), 'SELECT record FROM executions WHERE id=?', id)[0].record);
  const worker = id => {
    const row = rows(path.join(workerRoot, 'workers.sqlite'), 'SELECT * FROM jobs WHERE id=?', id)[0];
    return row && { ...row, registration: JSON.parse(row.registration) };
  };
  t.after(async () => {
    release?.();
    try { await currentApi?.close(); }
    finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  });

  const api1 = await open(null, 'api1'), identity = api1.ready.identity;
  const base = `/api/projects/${identity.projectId}/runs/${identity.runId}`, definitions = `${base}/verification-plans`, route = `${base}/development-executions`;
  const proposed = await request(`${definitions}/propose`, { contractRevision: (await request(definitions)).value.capabilities.contractRevision });
  assert.equal(proposed.status, 202);
  const draft = await until(async () => (await request(definitions)).value.proposals.find(row => row.status === 'draft'), 'fixed definition');
  assert.equal((await request(`${definitions}/${draft.id}/approve`, { revision: draft.revision, feedback: 'Fixture approval' })).status, 200);
  const before = await request(route), first = await request(`${route}/start`, { proposalId: draft.id, revision: draft.revision, contractRevision: before.value.capabilities.contractRevision });
  assert.equal(first.status, 202);
  const firstId = first.value.execution.id;
  await until(async () => (await request(route)).value.executions.find(row => row.id === firstId && row.status === 'failed' && row.actions.canRepair), 'repairable original blocked candidate');
  const original = execution(firstId), originalBytes = await readFile(original.reportPath);
  const originalFiles = ['.git/HEAD', '.git/index', 'src/app.mjs'].map(file => path.join(original.workspace, file));
  const originalFileBytes = await Promise.all(originalFiles.map(file => readFile(file)));
  const binding = { projectId: identity.projectId, specRevision: original.specRevision, planRevision: original.planRevision }, writablePaths = ['src/app.mjs', 'docs/README.md'];
  const retained = assertPlannedSource(await inspectPlannedSource({ rootDir, reportPath: original.reportPath, expectedRecord: original, binding, writablePaths }), binding, writablePaths);
  const blockerIds = retained.previousIssues.map(issue => issue.id).sort();
  assert.equal(blockerIds.length, 2);
  const spent = budget().used_calls;
  assert.ok(spent >= 4);
  assert.equal((await request(`${route}/${firstId}/download`)).status, 409);

  // A changed owned report must not establish another paid reservation.
  try {
    await writeFile(original.reportPath, Buffer.concat([originalBytes, Buffer.from('\n '), Buffer.from('invalid source')]));
    const stale = await request(`${route}/${firstId}/repair`, { contractRevision: (await request(route)).value.capabilities.contractRevision, repairNote: note });
    assert.equal(stale.status, 409);
    assert.deepEqual(budget(), { attempts: 1, used_calls: spent, reserved_calls: 0 });
  } finally { await writeFile(original.reportPath, originalBytes); }

  repairing = true;
  const repair = await request(`${route}/${firstId}/repair`, { contractRevision: (await request(route)).value.capabilities.contractRevision, repairNote: note });
  assert.equal(repair.status, 202, JSON.stringify(repair.value));
  assert.equal(repair.value.execution.executionEngine, 'persistent_worker');
  assert.equal(JSON.stringify(repair.value).includes(original.reportPath), false);
  const id = repair.value.execution.id;
  await until(() => release, 'first repair request reached local model');
  const started = requests.find(row => row.repairing);
  assert.equal(started.role, 'coding');
  assert.deepEqual(JSON.parse(started.input.feedback).previousIssues.map(issue => issue.id).sort(), blockerIds);
  assert.equal(JSON.parse(started.input.feedback).operatorDiagnosis, note);
  const store = openPlannedWorkerStore({ rootDir: workerRoot, create: false });
  try {
    const grant = verifyWorkerAuthorization({ store, jobId: id });
    assert.equal(grant.repair.sourceServiceExecutionId, firstId);
    assert.equal(grant.repair.sourceReportHash, sha(originalBytes));
    assert.equal(grant.repair.sourceEvidenceHash, workerRepairEvidenceHash(retained));
    assert.equal(grant.binding.specRevision, original.specRevision);
    assert.equal(grant.binding.planRevision, original.planRevision);
    assert.equal(grant.proposalId, draft.id);
    assert.equal(grant.revision, draft.revision);
  } finally { store.close(); }
  const registered = worker(id), reserved = budget();
  assert.deepEqual(reserved, { attempts: 2, used_calls: spent, reserved_calls: 6 });

  await api1.close(); currentApi = null;
  process.kill(registered.registration.pid, 0);
  const api2 = await open(identity, 'api2');
  await until(async () => (await request(route)).value.executions.find(row => row.id === id && row.active && row.actions.canCancel), 'same repair Worker reconnected');
  assert.deepEqual(worker(id).registration, registered.registration);
  assert.equal(worker(id).deadline, registered.deadline);
  assert.deepEqual(budget(), reserved);
  assert.equal(requests.filter(row => row.repairing).length, 1);
  release();

  const accepted = await until(async () => {
    const row = (await request(route)).value.executions.find(row => row.id === id);
    if (row?.status === 'failed' || row?.status === 'reconciliation_required') assert.fail(JSON.stringify(row));
    return row?.accepted && row;
  }, 'repaired candidate passes full native checks and Review');
  assert.notEqual(accepted.candidateCommit, original.candidateCommit);
  assert.ok(accepted.checks.http.length && accepted.checks.http.every(check => check.passed));
  assert.ok(accepted.checks.browser.length && accepted.checks.browser.every(check => check.passed));
  assert.equal(accepted.checks.review, 'completed');
  const checked = requests.find(row => row.repairing && row.role === 'review');
  assert.deepEqual(checked.input.previousIssues.map(issue => issue.id).sort(), blockerIds);
  assert.deepEqual(requests.filter(row => row.repairing).map(row => row.role), ['coding', 'review']);
  assert.deepEqual(budget(), { attempts: 2, used_calls: spent + 2, reserved_calls: 0 });
  assert.deepEqual(await readFile(original.reportPath), originalBytes);
  assert.deepEqual(execution(firstId), original);
  const delivered = await request(`${route}/${id}/download`);
  assert.equal(delivered.status, 200);

  await api2.close(); currentApi = null;
  const workerDatabase = new DatabaseSync(path.join(workerRoot, 'workers.sqlite'));
  const authorization = workerDatabase.prepare('SELECT authorization FROM jobs WHERE id=?').get(id).authorization;
  try {
    const fake = JSON.parse(authorization);
    fake.body.repair.sourceEvidenceHash = '0'.repeat(64);
    workerDatabase.prepare('UPDATE jobs SET authorization=? WHERE id=?').run(JSON.stringify(fake), id);
    const verifier = openPlannedWorkerStore({ rootDir: workerRoot, create: false });
    try { assert.throws(() => verifyWorkerAuthorization({ store: verifier, jobId: id }), { code: 'worker_authorization_signature' }); }
    finally { verifier.close(); }
  } finally { workerDatabase.prepare('UPDATE jobs SET authorization=? WHERE id=?').run(authorization, id); workerDatabase.close(); }
  await open(identity, 'api3');
  await until(async () => (await request(route)).value.executions.find(row => row.id === id && row.accepted && row.checkpoint.restored), 'repaired historical delivery');
  const reopened = await request(`${route}/${id}/download`);
  assert.equal(reopened.status, 200);
  assert.equal(sha(reopened.bytes), sha(delivered.bytes));
  assert.deepEqual(budget(), { attempts: 2, used_calls: spent + 2, reserved_calls: 0 });
  assert.equal(requests.filter(row => row.repairing).length, 2);
  assert.deepEqual(await Promise.all(originalFiles.map(file => readFile(file))), originalFileBytes);
  assert.deepEqual(errors, []);
});
