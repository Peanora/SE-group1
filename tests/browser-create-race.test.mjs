import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { runBrowserScenarios, createBrowserScenarioService } from '../lib/browser-scenarios.mjs';
import { browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';
import { readProjectFiles } from '../lib/project-files.mjs';
import { startWebRuntime } from '../lib/web-runtime.mjs';

// Real Edge/MXC tests are enabled with a non-secret executor path. They call no
// model and never modify the original public native case. Handwritten fixture
// fixes establish the regression gate, not a repaired model-generated delivery.
const native = process.platform === 'win32' && !!process.env.EXECUTION_SANDBOX_EXE;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const base = { projectId: 'race-gate-fixture', runId: 'approved-regression', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const race = { id: 'retained-create', op: 'createWithDelayedLoad', session: 'writer', requirementIds: ['R1'], path: '/notes.html', loadPath: '/api/notes', inputTestId: 'note-name', submitTestId: 'note-create', listTestId: 'note-list', countTestId: 'note-count', value: 'Created during load', expectedCount: 1 };
const scenario = (ordinary = false) => ({ version: 1, sessions: ['writer'], steps: ordinary ? [
  { id: 'ordinary-home', op: 'goto', session: 'writer', requirementIds: ['R1'], path: '/notes.html' },
  { id: 'ordinary-empty', op: 'text', session: 'writer', requirementIds: ['R1'], testId: 'note-count', value: '0' }, race,
  { id: 'ordinary-still-empty', op: 'text', session: 'writer', requirementIds: ['R1'], testId: 'note-count', value: '0' },
] : [race], limits: { timeoutMs: 30000, actionTimeoutMs: 6000 } });
function approved(browser = scenario()) {
  const proposal = { version: 1, id: 'race-joint', name: 'Approved delayed initial-load create regression', sessions: [],
    steps: [{ id: 'http-list', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'list', method: 'GET', path: '/api/notes', assertions: [{ id: 'list_ok', op: 'status', value: 200 }] } }], browser };
  const control = createVerificationControl(), args = { proposal, requirements: ['R1'], binding: base }, approval = control.approve(args), manifest = compileManifest({ ...args, approval }); control.beginCoding(approval); return { manifest, control, proposal, approval };
}
const app = `import{DatabaseSync}from'node:sqlite';import{readFile}from'node:fs/promises';export async function createApp({databasePath}){const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY,name TEXT NOT NULL)');return{async handle(req){const json=(status,data)=>({status,headers:{'content-type':'application/json'},body:JSON.stringify(data)});if(req.path==='/api/notes'){if(req.method==='GET')return json(200,{notes:db.prepare('SELECT id,name FROM notes ORDER BY id').all()});if(req.method==='POST'){const {name}=JSON.parse(req.body);const r=db.prepare('INSERT INTO notes(name) VALUES(?)').run(name);return json(201,{note:{id:Number(r.lastInsertRowid),name}})}}if(req.path==='/favicon.ico')return{status:204,headers:{},body:''};const routes={'/notes.html':['notes.html','text/html'],'/notes.js':['notes.js','text/javascript'],'/styles.css':['styles.css','text/css']};const item=routes[req.path];if(item)return{status:200,headers:{'content-type':item[1]},body:await readFile(new URL('../public/'+item[0],import.meta.url),'utf8')};return json(404,{error:'missing'})},close(){db.close()}}}`;
function fixture(mode) {
  const script = `const input=document.querySelector('[data-testid="note-name"]'),button=document.querySelector('[data-testid="note-create"]'),list=document.querySelector('[data-testid="note-list"]'),count=document.querySelector('[data-testid="note-count"]');let notes=[];const render=()=>{list.textContent='';for(const note of notes){const li=document.createElement('li');li.textContent=note.name;list.append(li)}count.textContent=String(notes.length)};${['disabled', 'locked', 'empty-disabled'].includes(mode) ? 'button.disabled=true;' : ''}${mode === 'locked' ? 'input.disabled=true;' : ''}${mode === 'empty-disabled' ? "input.addEventListener('input',()=>{button.disabled=!input.value.trim()});" : ''}let revision=0;const loadRevision=revision;fetch('/api/notes').then(r=>r.json()).then(data=>{${mode === 'generation' ? 'if(revision!==loadRevision)return;' : ''}notes=data.notes;render()}).finally(()=>{${['disabled', 'locked'].includes(mode) ? 'button.disabled=false;input.disabled=false;' : ''}});button.addEventListener('click',async()=>{const response=await fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:input.value})});const data=await response.json();revision++;notes.push(data.note);render()});render();`;
  return [{ path: 'src/app.mjs', content: app }, { path: 'public/notes.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><input data-testid="note-name"><button data-testid="note-create">Create</button><p data-testid="note-count">0</p><ul data-testid="note-list"></ul><script src="/notes.js"></script>' },
    { path: 'public/notes.js', content: script }, { path: 'public/styles.css', content: '*{box-sizing:border-box}body{margin:12px}input{max-width:55%}ul{overflow-wrap:anywhere}' }];
}
async function execute(files, { browser, service = runBrowserScenarios, configure, signal } = {}) {
  const output = path.resolve(process.env.TASKFLOW_BROWSER_RACE_EVIDENCE || 'output/browser-create-race-tests'); await mkdir(output, { recursive: true }); const rootDir = await mkdtemp(path.join(output, 'case-'));
  const f = approved(browser), binding = { ...base, taskId: 'test', attemptId: 'attempt', candidateCommit: 'c'.repeat(40), sourceHash: hash(files), manifestHash: f.manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: 'd'.repeat(64) };
  // Match the same normalized source order used by the real runner.
  const { validateProjectFiles } = await import('../lib/project-files.mjs'); binding.sourceHash = hash(validateProjectFiles(files));
  configure?.(f); const report = await service({ rootDir, files, manifest: f.manifest, binding, executable: process.env.EXECUTION_SANDBOX_EXE, ...(signal ? { signal } : {}) });
  await writeFile(path.join(rootDir, 'report.json'), JSON.stringify(report, null, 2)); return { ...f, report, rootDir };
}
for (const mode of ['disabled', 'locked', 'generation']) test(`native atomic regression accepts ${mode} fix, keeps ordinary runtime data isolated and counts every STOP`, { skip: !native, timeout: 45000 }, async () => {
  const { report } = await execute(fixture(mode), { browser: scenario(true) });
  assert.equal(report.status, 'passed', JSON.stringify(report)); assert.equal(report.coverage, 'structural_only'); assert.equal(report.processes.length, 5);
  assert.equal(report.processes.filter(item => item.kind === 'browser').length, 1); assert.equal(report.processes.filter(item => item.kind === 'runtime').length, 4);
  assert.ok(report.processes.every(item => item.status === 'stopped' && item.exitCode === 0 && item.terminationConfirmed));
  assert.equal(report.checks.find(item => item.id === 'BROWSER-DESKTOP-ordinary-still-empty').passed, true); assert.equal(report.checks.find(item => item.id === 'BROWSER-MOBILE-ordinary-still-empty').passed, true);
  const observation = JSON.parse(report.checks.find(item => item.id === 'BROWSER-DESKTOP-retained-create').actual); assert.equal(observation.branch, mode === 'generation' ? 'create-before-stale-load' : 'initial-load-create-disabled'); assert.equal(observation.afterReleaseCount.trim(), '1');
});
test('native atomic regression rejects the actual stale-load bug with all runtime stops confirmed', { skip: !native, timeout: 45000 }, async () => {
  const { report } = await execute(fixture('bug')); assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.equal(report.processes.length, 5);
  for (const view of ['DESKTOP', 'MOBILE']) { const check = report.checks.find(item => item.id === `BROWSER-${view}-retained-create`); assert.equal(check.passed, false); assert.match(check.actual, /afterReleaseCount/u); }
});
test('native empty-input disabled submit does not conceal a create-before-load race after valid input', { skip: !native, timeout: 45000 }, async () => {
  const { report } = await execute(fixture('empty-disabled')); assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true);
  for (const view of ['DESKTOP', 'MOBILE']) { const check = report.checks.find(item => item.id === `BROWSER-${view}-retained-create`); assert.equal(check.passed, false); assert.match(check.actual, /create-before-stale-load/u); assert.match(check.actual, /afterReleaseCount/u); }
});
test('native extra runtime stop unknown stays reconciliation and cannot run the next viewport', { skip: !native, timeout: 45000 }, async () => {
  let starts = 0; const service = createBrowserScenarioService({ startRuntime: async options => { const number = ++starts; const runtime = await startWebRuntime(options); return { ...runtime, stop: async () => { const actual = await runtime.stop(); return number === 2 ? { ...actual, status: 'reconciliation_required', terminationConfirmed: false } : actual; } }; } });
  const { report } = await execute(fixture('disabled'), { service }); assert.equal(report.status, 'reconciliation_required'); assert.equal(report.terminationConfirmed, false); assert.equal(starts, 2); assert.ok(report.processes.some(item => item.kind === 'runtime' && item.terminationConfirmed === false));
});
for (const fault of ['cancel', 'revoke', 'source-change']) test(`native atomic step ${fault} after actual POST cannot publish a pass`, { skip: !native, timeout: 45000 }, async () => {
  let starts = 0, control, approval, triggered = 0; const abort = new AbortController();
  const service = createBrowserScenarioService({ startRuntime: async options => { const number = ++starts;
    return startWebRuntime({ ...options, onEvent: event => { options.onEvent?.(event); if (number === 2 && event.type === 'response' && event.status === 201 && !triggered++) {
      if (fault === 'cancel') abort.abort(); else if (fault === 'revoke') control.revoke(approval); else appendFileSync(path.join(options.workspace, 'src/app.mjs'), '\n// trusted test changes only its isolated race snapshot\n');
    } } });
  } });
  const { report } = await execute(fixture('disabled'), { service, signal: abort.signal, configure: f => { control = f.control; approval = f.approval; } });
  assert.ok(triggered > 0); assert.notEqual(report.status, 'passed'); assert.equal(report.terminationConfirmed, true); assert.equal(report.checks.find(item => item.id === 'BROWSER-DESKTOP-retained-create').passed, false);
  assert.ok(report.processes.every(item => item.terminationConfirmed === true));
});
test('native atomic action deadline covers a missing initial GET with bounded cleanup', { skip: !native, timeout: 45000 }, async () => {
  const files = fixture('generation'); files.find(file => file.path === 'public/notes.js').content = files.find(file => file.path === 'public/notes.js').content.replace("fetch('/api/notes')", 'new Promise(()=>{})');
  const browser = scenario(); browser.limits.actionTimeoutMs = 300; const at = Date.now(), { report } = await execute(files, { browser });
  assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.ok(Date.now() - at < 15000); assert.ok(report.checks.filter(item => item.id.endsWith('-retained-create')).every(item => !item.passed));
});
test('native atomic page cannot access an external origin or launder a console/network failure', { skip: !native, timeout: 45000 }, async () => {
  const files = fixture('disabled'); files.find(file => file.path === 'public/notes.js').content += "\nfetch('https://external.invalid/forbidden').catch(()=>{});";
  const { report } = await execute(files); assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.ok(report.checks.some(item => !item.passed)); assert.doesNotMatch(JSON.stringify(report), /external\.invalid/u);
});
test('approved new regression turns the unchanged original v3 public candidate red', { skip: !native || !process.env.TASKFLOW_BROWSER_RACE_SOURCE_REPORT, timeout: 45000 }, async () => {
  const originalReport = path.resolve(process.env.TASKFLOW_BROWSER_RACE_SOURCE_REPORT), source = JSON.parse(await readFile(originalReport, 'utf8'));
  const record = source.profileId === 'planned-task-run-v1' ? source.tasks.find(task => task.id === 'FINAL').record : source;
  const files = await readProjectFiles(record.workspace), before = hash(files); assert.equal(before, record.versions.at(-1).sourceHash);
  const { report, rootDir } = await execute(files); assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.equal(hash(await readProjectFiles(record.workspace)), before);
  for (const view of ['DESKTOP', 'MOBILE']) { const check = report.checks.find(item => item.id === `BROWSER-${view}-retained-create`); assert.equal(check.passed, false); assert.match(check.actual, /afterReleaseCount/u); }
  await writeFile(path.join(rootDir, 'original-source-binding.json'), JSON.stringify({ candidateCommit: record.candidateCommit, sourceHash: before, originalReport, originalSourceUnchanged: true, newApprovedRegression: true, oldDefinitionOrResultModified: false, paidModelCalls: 0 }, null, 2));
});
