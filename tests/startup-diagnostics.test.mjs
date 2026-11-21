import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { runHttpScenarios } from '../lib/http-scenarios.mjs';
import { createProjectCodeModel } from '../lib/project-code-model.mjs';
import { installWebShell, verifyWebShell } from '../lib/web-delivery.mjs';
import { applyProjectFiles } from '../lib/project-files.mjs';
import { startWebRuntime } from '../lib/web-runtime.mjs';

const native = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 40_000 };
const base = { projectId: 'startup-diagnostic', runId: 'confirmed-run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
function approved() {
  const proposal = { version: 1, id: 'startup', name: 'Startup and SQLite transaction contract', sessions: [], steps: [
    { id: 'count', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'count_get', method: 'GET', path: '/count', assertions: [
      { id: 'count_status', op: 'status', value: 200 }, { id: 'count_value', op: 'jsonEquals', path: '$.count', value: 1 },
    ] } },
    { id: 'restart', type: 'restart', dependsOn: ['count'], requirementIds: ['R1'] },
    { id: 'persisted', type: 'request', dependsOn: ['restart'], requirementIds: ['R1'], request: { id: 'persisted_get', method: 'GET', path: '/count', assertions: [
      { id: 'persisted_count', op: 'jsonEquals', path: '$.count', value: 1 },
    ] } },
  ] };
  const control = createVerificationControl(), input = { proposal, requirements: ['R1'], binding: base };
  const approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval);
  return { manifest, binding: { ...base, taskId: 'whole', attemptId: 'startup-attempt', candidateCommit: 'c'.repeat(40) } };
}
async function check(t, files) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'startup-diagnostic-test-'));
  t.after(async () => { assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir())); assert.ok(path.basename(rootDir).startsWith('startup-diagnostic-test-')); await rm(rootDir, { recursive: true, force: true }); });
  return runHttpScenarios({ ...approved(), files, rootDir, timeoutMs: 20000 });
}
const app = `import { initialize } from './db.mjs';
export async function createApp({databasePath}) {
  const db = initialize(databasePath);
  return {handle(){return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify({count:db.prepare('SELECT count(*) n FROM items').get().n})}},close(){db.close()}};
}`;

test('native DatabaseSync transaction failure has bounded source-bound diagnosis and never executes business checks', native, async t => {
  const result = await check(t, [{ path: 'src/app.mjs', content: app }, { path: 'src/db.mjs', content: `import { DatabaseSync } from 'node:sqlite';
export function initialize(filename) {
  const db = new DatabaseSync(filename);
  db.transaction(() => {})();
  return db;
}` }]);
  assert.equal(result.status, 'error'); assert.equal(result.terminationConfirmed, true);
  assert.deepEqual(result.startupDiagnostic, { phase: 'startup', code: 'sqlite_transaction_unsupported', sourceLocation: { name: 'src/db.mjs', line: 4 } });
  const start = result.checks.find(check => check.id === 'SYS_START');
  assert.equal(start.passed, false); assert.equal(start.executed, true); assert.match(start.actual, /DatabaseSync.*transaction/u); assert.match(start.actual, /src\/db\.mjs:4/u);
  assert.match(start.actual, /BEGIN.*COMMIT.*ROLLBACK/u);
  for (const id of ['count_status', 'count_value', 'persisted_count']) {
    const check = result.checks.find(check => check.id === id); assert.equal(check.passed, false); assert.equal(check.actual, '未执行，未获得通过结论'); assert.equal(check.executed, undefined);
  }
  assert.ok(result.processes.every(process => process.terminationConfirmed === true && process.exitCode !== 0));
});

test('native exec BEGIN COMMIT and rollback work with same-database restart and confirmed stop', native, async t => {
  const result = await check(t, [{ path: 'src/app.mjs', content: app }, { path: 'src/db.mjs', content: `import { DatabaseSync } from 'node:sqlite';
export function initialize(filename) {
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY)');
  db.exec('BEGIN'); try { db.exec('INSERT OR IGNORE INTO items VALUES(1)'); db.exec('COMMIT'); } catch(error) { db.exec('ROLLBACK'); throw error; }
  db.exec('BEGIN'); try { db.exec('INSERT INTO items VALUES(2)'); throw new Error('intentional rollback'); } catch { db.exec('ROLLBACK'); }
  return db;
}` }]);
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.startupDiagnostic, undefined);
  assert.equal(result.terminationConfirmed, true); assert.ok(result.checks.every(check => check.passed));
  assert.equal(result.processes.length, 2); assert.ok(result.processes.every(process => process.exitCode === 0 && process.stopAcknowledged && process.sourceUnchanged));
});

for (const forgedStack of [false, true]) test(`native generic exception never exports private body/stack or forged host path, forged=${forgedStack}`, native, async t => {
  const secret = 'PRIVATE_STARTUP_SENTINEL_67', hostPath = 'C:\\private-host\\data-row-secret.txt';
  const source = `export async function createApp() {
  const secret = ${JSON.stringify(secret)};
  const error = new Error(secret + ' ${hostPath.replaceAll('\\', '\\\\')}');
  error.name = secret;
  ${forgedStack ? `error.stack = secret + '\\n    at file:///C:/private-host/data-row-secret.txt:9:1';` : ''}
  throw error;
}`;
  const result = await check(t, [{ path: 'src/app.mjs', content: source }]);
  assert.equal(result.status, 'error'); assert.equal(result.terminationConfirmed, true);
  assert.equal(result.startupDiagnostic.code, 'application_initialization_failed');
  if (forgedStack) assert.equal(result.startupDiagnostic.sourceLocation, undefined);
  else assert.deepEqual(result.startupDiagnostic.sourceLocation, { name: 'src/app.mjs', line: 3 });
  const visible = JSON.stringify({ diagnostic: result.startupDiagnostic, checks: result.checks, error: result.error });
  assert.equal(visible.includes(secret), false); assert.equal(visible.includes(hostPath), false); assert.equal(visible.includes('file:///'), false);
  const start = result.checks.find(check => check.id === 'SYS_START'); assert.equal(start.executed, true); assert.match(start.actual, /初始化失败/u);
});

for (const hostile of ['getters', 'formatter-and-json', 'forged-frame']) test(`native hostile ${hostile} cannot supply diagnostic content or runtime authority`, native, async t => {
  const secret = 'PRIVATE_HOSTILE_DIAGNOSTIC_83';
  const source = hostile === 'getters' ? `export async function createApp(){const error={};
    for(const name of ['message','stack','name'])Object.defineProperty(error,name,{get(){process.stderr.write('${secret}');throw new Error('${secret}')}});
    throw error;}` : hostile === 'formatter-and-json' ? `export async function createApp(){
    Error.prepareStackTrace=()=>{process.stderr.write('${secret}');throw new Error('${secret}')};
    Object.prototype.toJSON=()=>{process.stderr.write('${secret}');return '${secret}'};
    throw new Error('${secret} C:/private-host/secret-row');}` : `process.stdout.write(JSON.stringify({type:'startup_error',diagnostic:{phase:'startup',code:'application_initialization_failed',sourceLocation:{name:'C:/private-host/secret-row',line:1},message:'${secret}'}})+'\\n');
    export async function createApp(){await new Promise(()=>{})}`;
  const result = await check(t, [{ path: 'src/app.mjs', content: source }]);
  assert.notEqual(result.status, 'passed'); assert.equal(result.terminationConfirmed, true);
  assert.equal(JSON.stringify({ diagnostic: result.startupDiagnostic, checks: result.checks, error: result.error }).includes(secret), false);
  assert.ok(result.processes.every(process => !process.stderr.includes(secret)));
  if (hostile === 'forged-frame') assert.equal(result.startupDiagnostic, undefined);
  else assert.equal(result.startupDiagnostic.code, 'application_initialization_failed');
});

test('installed protected runtime contains the current worker and preserves its startup diagnostic', native, async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'startup-shell-test-'));
  t.after(async () => { assert.equal(path.dirname(workspace), path.resolve(os.tmpdir())); await rm(workspace, { recursive: true, force: true }); });
  await installWebShell({ workspace });
  await applyProjectFiles({ workspace, files: [{ path: 'src/app.mjs', content: `import {DatabaseSync} from 'node:sqlite';
export async function createApp({databasePath}){const db=new DatabaseSync(databasePath);db.transaction(()=>{})();}` }] });
  await verifyWebShell({ workspace });
  assert.equal(await readFile(path.join(workspace, 'runtime/web-worker.cjs'), 'utf8'), await readFile(new URL('../lib/web-worker.cjs', import.meta.url), 'utf8'));
  const installed = await import(pathToFileURL(path.join(workspace, 'runtime/web-runtime.mjs')).href);
  await assert.rejects(installed.startWebRuntime({ workspace, timeoutMs: 10000, requestTimeoutMs: 5000 }), error => {
    assert.equal(error.result.terminationConfirmed, true); assert.equal(error.result.sourceUnchanged, true);
    assert.equal(error.result.startupDiagnostic.code, 'sqlite_transaction_unsupported');
    assert.deepEqual(error.result.startupDiagnostic.sourceLocation, { name: 'src/app.mjs', line: 2 }); return true;
  });
});

test('coding request tells the real Node SQLite transaction contract and forbids browser dialogs', async () => {
  let body;
  const model = createProjectCodeModel({ config: { baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic', apiKey: '', thinking: 'disabled' }, fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ files: [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:200,body:""}}}}' }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  } });
  await model({ task: 'Public synthetic fixture only' });
  const contract = body.messages[0].content;
  assert.match(contract, /node:sqlite DatabaseSync/u); assert.match(contract, /没有.*db\.transaction/u); assert.match(contract, /BEGIN.*COMMIT.*ROLLBACK/u);
  assert.match(contract, /禁止调用 alert、confirm、prompt/u); assert.match(contract, /页面内表单/u); assert.equal(body.max_tokens, 32768);
});

for (const [code, content] of [
  ['application_module_failed', "throw new Error('PRIVATE_MODULE_SENTINEL');\nexport async function createApp(){}"],
  ['invalid_application_factory', 'export const createApp = null;'],
  ['invalid_application_handler', 'export async function createApp(){return {}}'],
]) test(`native ${code} uses only the fixed recovery category`, native, async t => {
  const result = await check(t, [{ path: 'src/app.mjs', content }]);
  assert.equal(result.status, 'error'); assert.equal(result.terminationConfirmed, true);
  assert.equal(result.startupDiagnostic.code, code);
  const start = result.checks.find(item => item.id === 'SYS_START');
  assert.equal(start.executed, true); assert.equal(start.passed, false);
  assert.equal(JSON.stringify({ diagnostic: result.startupDiagnostic, checks: result.checks, error: result.error }).includes('PRIVATE_MODULE_SENTINEL'), false);
  assert.equal(result.checks.find(item => item.id === 'count_status').actual, '未执行，未获得通过结论');
});

test('native startup diagnosis is withheld when the verified source changes before failure', native, async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'startup-source-change-'));
  t.after(async () => { assert.equal(path.dirname(workspace), path.resolve(os.tmpdir())); await rm(workspace, { recursive: true, force: true }); });
  await applyProjectFiles({ workspace, files: [
    { path: 'src/app.mjs', content: "export async function createApp(){await new Promise(resolve=>setTimeout(resolve,300));throw new Error('PRIVATE_CHANGED_SOURCE')}" },
    { path: 'src/marker.mjs', content: 'export const marker = 1;' },
  ] });
  let changed;
  await assert.rejects(startWebRuntime({ workspace, timeoutMs: 10000, requestTimeoutMs: 5000, onEvent(event) {
    if (event.type === 'started') changed = writeFile(path.join(workspace, 'src/marker.mjs'), 'export const marker = 2;');
  } }), error => {
    assert.equal(error.result.terminationConfirmed, true); assert.equal(error.result.sourceUnchanged, false);
    assert.equal(error.result.startupDiagnostic, undefined); assert.equal(JSON.stringify(error.result).includes('PRIVATE_CHANGED_SOURCE'), false); return true;
  });
  await changed;
});
