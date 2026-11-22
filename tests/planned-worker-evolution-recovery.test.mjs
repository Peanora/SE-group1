import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectPlannedArchive } from '../lib/planned-archive.mjs';

const native = process.platform === 'win32' && process.env.TASKFLOW_TEST_REAL_SANDBOX === '1' && !!process.env.EXECUTION_SANDBOX_EXE;
const fixturePath = path.join(import.meta.dirname, 'fixtures', 'planned-worker-api.mjs');
const app = evolved => [
  "import {DatabaseSync} from 'node:sqlite';",
  'export async function createApp({databasePath}) {',
  'const db=new DatabaseSync(databasePath);',
  "db.exec('CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY,value TEXT NOT NULL" + (evolved ? ',priority INTEGER NOT NULL DEFAULT 0' : '') + ")');",
  "const json=(status,body)=>({status,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});",
  'return {handle(request){',
  "const p=new URL(request.path,'http://localhost').pathname;",
  "if(p==='/favicon.ico') return {status:204,headers:{},body:''};",
  "if(p==='/health') return json(200,{ok:true});",
  "if(p==='/items' && request.method==='POST') {db.prepare('INSERT INTO items(value) VALUES(?)').run(JSON.parse(request.body).value);return json(201,{created:true});}",
  "const rows=db.prepare('SELECT * FROM items ORDER BY id').all();",
  "if(p==='/items')return json(200,{count:rows.length,rows});",
  "return {status:200,headers:{'Content-Type':'text/html'},body:'<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><h1 data-testid=welcome>Count '+rows.length+'</h1>'};",
  '},close(){db.close()}};',
  '}',
].join('\n');

function proposal(evolved) {
  return { version: 1, id: 'persisted-evolution', name: 'Fixed evolution joint checks', sessions: [], steps: [
    { id: 'items', type: 'request', dependsOn: [], requirementIds: ['R'], request: { id: 'rows', method: 'GET', path: '/items', assertions: [
      { id: 'status', op: 'status', value: 200 }, { id: 'count', op: 'jsonEquals', path: '$.count', value: evolved ? 2 : 0 },
      ...(evolved ? [{ id: 'old-default', op: 'jsonEquals', path: '$.rows[0].priority', value: 0 }] : []),
    ] } },
  ], browser: { version: 1, sessions: ['visitor'], steps: [
    { id: 'open', session: 'visitor', requirementIds: ['R'], op: 'goto', path: '/' },
    { id: 'count-text', session: 'visitor', requirementIds: ['R'], op: 'text', testId: 'welcome', value: evolved ? 'Count 2' : 'Count 0' },
  ] } };
}

async function until(check, description, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    assert.ok(Date.now() < end, description);
    await delay(100);
  }
}

test('evolution Worker keeps the same migration, charge and delivery across API closure and termination',
  { skip: !native, timeout: 240000 }, async t => {
    await mkdir('output', { recursive: true });
    const directory = await mkdtemp(path.resolve('output/ew-'));
    const root = path.join(directory, 'planned-executions');
    const timeline = [], errors = [], values = ['PRIVATE_FIXTURE_ALPHA', 'PRIVATE_FIXTURE_BETA'];
    let evolved = false, releaseCoding, api, target, development;
    const model = http.createServer(async (request, response) => {
      try {
        let raw = '';
        for await (const part of request) raw += part;
        assert.ok(values.every(value => !raw.includes(value)), 'old data never enters a model request');
        const input = JSON.parse(JSON.parse(raw).messages.at(-1).content);
        const role = Object.hasOwn(input, 'feedback') ? 'coding' : 'review';
        timeline.push({ evolved, role });
        if (evolved && role === 'coding') await new Promise(resolve => { releaseCoding = resolve; });
        const value = role === 'coding' ? { files: [{ path: 'src/app.mjs', content: app(evolved) }] }
          : { summary: 'Fixture source Review', issues: [], resolutions: input.previousIssues.map(issue => ({ id: issue.id, status: 'resolved', reason: 'Verified fixture' })) };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
          usage: { prompt_tokens: 4, completion_tokens: 3 } }));
      } catch (failure) { errors.push(failure); response.writeHead(500); response.end(); }
    });
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^LLM_|^TASKFLOW_TEAM|^NODE_TEST_CONTEXT$/u.test(key)) delete env[key];
    Object.assign(env, { LLM_BASE_URL: 'http://127.0.0.1:' + model.address().port + '/v1', LLM_MODEL: 'local-ev-fixture',
      LLM_API_KEY: 'local-evolution-fixture-key', LLM_JSON_MODE: '1', LLM_THINKING: 'disabled' });

    async function startApi(label, options) {
      const child = spawn(process.execPath, [fixturePath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.on('exit', resolve));
      child.stdin.write(JSON.stringify({ directory, evolutionFixture: true, ...options }) + '\n');
      api = { ready: null, async close(abrupt = false) {
        if (child.exitCode === null && child.signalCode === null) {
          if (abrupt) child.kill('SIGKILL'); else child.stdin.end('{"close":true}\n');
        }
        const code = await exited;
        await writeFile(path.join(directory, label + '.log'), stdout + '\n' + stderr);
        if (!abrupt) assert.equal(code, 0, stderr);
      } };
      api.ready = await until(() => stdout.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.ready ? [value] : []; } catch { return []; } })[0],
        label + ' failed to become ready', 12000);
      return api.ready.identity;
    }

    async function request(route, body, status = 200) {
      const response = await fetch(api.ready.origin + route, body === undefined ? {} : { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, status, bytes.toString('utf8').slice(0, 1000));
      return response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes) : bytes;
    }

    function query(filename, sql, ...args) {
      const db = new DatabaseSync(filename, { readOnly: true });
      try { return db.prepare(sql).get(...args); } finally { db.close(); }
    }

    async function approvedDefinition(base, useOldData) {
      const route = base + '/verification-plans';
      const { capabilities } = await request(route);
      const draft = (await request(route + '/import', { contractRevision: capabilities.contractRevision, proposal: proposal(useOldData), feedback: 'Fixed fixture acceptance' }, 201)).proposal;
      await request(route + '/' + draft.id + '/approve', { revision: draft.revision, feedback: 'Confirmed frozen definition' });
      return draft;
    }
    const claimed = id => query(path.join(root, 'workers', 'workers.sqlite'), 'SELECT registration,status FROM jobs WHERE id=?', id);
    const nextExecution = async () => (await request(target + '/development-executions')).executions.find(row => row.id === development);
    t.after(async () => {
      releaseCoding?.();
      try {
        if (api?.ready && development) {
          const row = await nextExecution().catch(() => null);
          if (row?.actions.canCancel) await request(target + '/development-executions/' + development + '/cancel', {}).catch(() => {});
        }
        await api?.close();
      } finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
    });

    const before = await startApi('original', { seed: true });
    const project = '/api/projects/' + before.projectId, previousRun = project + '/runs/' + before.runId;
    const releaseRoute = project + '/local-releases';
    const previousDefinition = await approvedDefinition(previousRun, false);
    const previousRoute = previousRun + '/development-executions';
    const first = (await request(previousRoute + '/start', { proposalId: previousDefinition.id, revision: previousDefinition.revision,
      contractRevision: (await request(previousRoute)).capabilities.contractRevision }, 202)).execution;
    await until(async () => (await request(previousRoute)).executions.find(item => item.id === first.id && item.accepted), 'original accepted');
    const { release } = await request(releaseRoute + '/activate', { runId: before.runId, executionId: first.id, expectedReleaseId: null, expectedDataGeneration: 0 });
    const active = (await request(releaseRoute + '/' + release.id + '/start', { expectedDataGeneration: release.dataGeneration })).release;
    for (const value of values) assert.equal((await fetch(active.url + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) })).status, 201);
    const stopped = (await request(releaseRoute + '/' + release.id + '/stop', {})).release;
    const stoppedPath = query(path.join(root, 'local-releases', 'releases.sqlite'), 'SELECT workspace FROM releases WHERE id=?', release.id).workspace;
    const originalDatabase = path.join(stoppedPath, '.platform', 'tmp', 'app.sqlite'), beforeBytes = await readFile(originalDatabase);
    const { change } = await request(project + '/changes', { baseRevision: before.sourceRevision, source: { filename: 'evolved.md', content: 'Retain both items and show their default priority.' },
      kind: 'field', reason: 'Add priority to an owned existing dataset', requestKey: randomUUID() }, 201);
    await request(project + '/changes/' + change.id + '/apply', { baseRevision: before.sourceRevision, generation: change.generation });
    await api.close();
    const after = await startApi('worker-admission', { identity: before, successor: true });
    target = project + '/runs/' + after.runId;
    const definition = await approvedDefinition(target, true), evolutions = target + '/evolutions';
    const draft = (await request(evolutions, { releaseId: stopped.id, proposalId: definition.id, definitionRevision: definition.revision,
      expectedSourceRevision: after.sourceRevision, expectedSourceGeneration: 1, requestKey: randomUUID(), reason: 'Add default priority' })).evolution;
    const route = evolutions + '/' + draft.id;
    const migration = { version: 1, kind: 'bounded_operations', operations: [{ op: 'addColumn', table: 'items', column: 'priority', type: 'INTEGER', nullable: false, default: 0 }] };
    const revision = (await request(route + '/revise', { revision: draft.revision, migration, reason: 'Preserve prior rows' })).evolution.revision;
    await request(route + '/approve', { revision, feedback: 'Confirmed migration against stopped data' });
    evolved = true;
    const start = await request(route + '/start', { revision, contractRevision: (await request(target + '/development-executions')).capabilities.contractRevision }, 202);
    development = start.execution.id;
    assert.equal(start.execution.executionEngine, 'persistent_worker');
    await until(() => releaseCoding, 'old data preparation did not reach the coding call');
    const registration = claimed(development).registration;
    assert.ok(registration);
    await api.close();
    await startApi('abrupt-controller', { identity: after });
    await nextExecution();
    assert.equal(claimed(development).registration, registration);
    await api.close(true);
    await startApi('reattached-controller', { identity: after });
    assert.equal((await nextExecution()).id, development);
    assert.equal(claimed(development).registration, registration);
    releaseCoding();

    const accepted = await until(async () => {
      const result = await nextExecution();
      if (result?.status === 'failed' && !result.active) assert.fail(JSON.stringify(result));
      return result?.accepted && result;
    }, 'reattached evolution result not accepted', 100000);
    assert.equal(accepted.totalModelCalls, 2);
    assert.deepEqual(timeline.filter(item => item.evolved).map(item => item.role), ['coding', 'review']);
    assert.deepEqual(errors, []);
    const budget = query(path.join(root, 'planned.sqlite'), 'SELECT used_calls,reserved_calls FROM budgets WHERE project_id=? AND run_id=?', after.projectId, after.runId);
    assert.deepEqual({ ...budget }, { used_calls: 2, reserved_calls: 0 });
    const archivePath = target + '/development-executions/' + development + '/download';
    const archive = await request(archivePath);
    assert.equal((await inspectPlannedArchive(archive)).evolution.targetGeneration, 1);
    await until(async () => (await request(evolutions)).evolutions.find(row => row.id === draft.id && row.status === 'accepted'), 'accepted evolution DTO');
    const { release: successor } = await request(route + '/activate', { revision });
    const started = (await request(releaseRoute + '/' + successor.id + '/start', { expectedDataGeneration: successor.dataGeneration })).release;
    const items = await (await fetch(started.url + '/items')).json();
    assert.deepEqual(items.rows.map(row => [row.value, row.priority]), values.map(value => [value, 0]));
    await request(releaseRoute + '/' + successor.id + '/stop', {});
    await api.close();
    await startApi('historical-controller', { identity: after });
    await until(async () => (await nextExecution())?.actions.canDownload, 'archive readiness after activation');
    assert.deepEqual(await request(archivePath), archive);
    await api.close();
    const { record } = query(path.join(root, 'planned.sqlite'), 'SELECT record FROM executions WHERE id=?', development);
    const migrationId = JSON.parse(record).versions.at(-1).selfCheck.dataset.migrationId;
    const artifact = path.join(root, 'workers', 'jobs', development, 'ds', 'artifacts', migrationId + '.sqlite');
    const intact = await readFile(artifact), changed = Buffer.from(intact);
    changed[0] ^= 1;
    await chmod(artifact, 0o600);
    try {
      await writeFile(artifact, changed);
      await startApi('changed-migration-artifact', { identity: after });
      assert.equal((await nextExecution()).actions.canDownload, false);
      await request(archivePath, undefined, 409);
      await api.close();
    } finally { await writeFile(artifact, intact); await chmod(artifact, 0o400); }
    await startApi('restored-migration-artifact', { identity: after });
    await until(async () => (await nextExecution())?.actions.canDownload, 'archive readiness once original migration bytes are restored');
    assert.deepEqual(await request(archivePath), archive);
    assert.deepEqual(await readFile(originalDatabase), beforeBytes);
    assert.equal(timeline.length, 4, 'downloads and restarts do not dispatch');
  });
