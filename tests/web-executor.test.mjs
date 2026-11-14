import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { startWebExecution, isWebTaskAccepted } from '../lib/web-executor.mjs';
import { webProfile } from '../lib/web-profile.mjs';
import { databaseObserverHash, webManifest } from '../lib/web-tests.mjs';
import { browserManifest } from '../lib/web-browser-tests.mjs';
import { projectReviewPolicy } from '../lib/project-review-model.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

const binding = { projectId: 'test-project', runId: 'test-run', taskId: 'whole-web-project', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const review = async () => ({ summary: 'mock Review only', issues: [], resolutions: [] });
const real = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 60_000 };
const seedFiles = [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:503,body:"original seed"}}}}\n' },
  { path: 'docs/original.md', content: '# Preserve the original project\n' }];
const seedHash = files => createHash('sha256').update(JSON.stringify(validateProjectFiles(files))).digest('hex');
const initialSource = () => ({ files: structuredClone(seedFiles), sourceExecutionId: 'original-execution', sourceCommit: 'c'.repeat(40), sourceHash: seedHash(seedFiles),
  sourceReportHash: 'd'.repeat(64), reviewSourceExecutionId: 'blocking-review-execution', reviewSourceReportHash: 'e'.repeat(64) });
const seedIssues = () => [{ id: 'ISSUE-source-1', severity: 'blocking', status: 'open', file: 'src/app.mjs', line: 1,
  message: '原候选缺少完整业务；必须修复并重跑独立检查。', evidence: seedFiles[0].content.trim(), originCommit: 'c'.repeat(40) }];
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-web-executor-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function mockExecution(t, mode) {
  const directory = await fixture(t);
  const script = `
    import {mock} from 'node:test';import {readFile} from 'node:fs/promises';
    const directory=${JSON.stringify(directory)},mode=${JSON.stringify(mode)};
    mock.module(${JSON.stringify(new URL('../lib/windows-sandbox.mjs', import.meta.url).href)},{namedExports:{createWindowsSandbox:()=>({preflight:async()=>{
      if(mode==='preflight')throw Object.assign(new Error('owned probe did not stop'),{reconciliationRequired:true,
        probeDirectory:directory+'/owned-probe',result:{pid:424245,startedAt:'2026-01-01T00:00:00.000Z',terminationConfirmed:false,controlDirectory:directory+'/owned-control'}});
      return {kind:'trusted-test-only'};
    }})}});
    const {startWebExecution}=await import(${JSON.stringify(new URL('../lib/web-executor.mjs', import.meta.url).href)});
    let calls=0,abortTimer,lateReceipt=false;const controller=new AbortController();const started=Date.now();
    const execution=startWebExecution({outputDir:directory,binding:${JSON.stringify(binding)},reviewer:async()=>({}),signal:controller.signal,timeoutMs:mode==='deadline'?1500:5000,
      provider:async({onReceipt})=>{
        calls++;
        if(mode==='format'){
          await onReceipt({model:'trusted-mock',finishReason:'stop',usage:{inputTokens:10,outputTokens:20},content:'   '});
          throw Object.assign(new Error('invalid JSON'),{code:'invalid_model_response'});
        }
        if(mode==='cancel'||mode==='late-receipt')abortTimer=setTimeout(()=>controller.abort(),30);
        if(mode==='late-receipt'){
          await new Promise(resolve=>setTimeout(resolve,150));lateReceipt=true;
          await onReceipt({model:'trusted-mock',finishReason:'stop',usage:{inputTokens:10,outputTokens:20},content:'late'});
        }
        return new Promise(()=>{});
      }});
    const record=await execution.done;clearTimeout(abortTimer);
    const original=await readFile(record.reportPath,'utf8');
    if(mode==='late-receipt')await new Promise(resolve=>setTimeout(resolve,250));
    const persisted=JSON.parse(await readFile(record.reportPath,'utf8'));
    process.stdout.write(JSON.stringify({record,persisted,calls,duration:Date.now()-started,lateReceipt,unchanged:original===await readFile(record.reportPath,'utf8')}));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('trusted executor probe did not settle')); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stderr + stdout)); } } });
    child.stdin.end(script);
  });
}

async function repairExecution(t, mode = 'normal') {
  const directory = await fixture(t), originReport = path.join(directory, 'original-report.json');
  await writeFile(originReport, JSON.stringify({ initialSource: initialSource(), previousIssues: seedIssues(), status: 'failed' }));
  const before = await readFile(originReport);
  const script = `
    import {mock} from 'node:test';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';
    import {webManifest,databaseObserverHash} from ${JSON.stringify(new URL('../lib/web-tests.mjs', import.meta.url).href)};
    import {browserManifest} from ${JSON.stringify(new URL('../lib/web-browser-tests.mjs', import.meta.url).href)};
    const mode=${JSON.stringify(mode)},original=${JSON.stringify(initialSource())},issues=${JSON.stringify(seedIssues())},captured=[],reviewed=[],counts={http:0,browser:0};
    const digest=files=>createHash('sha256').update(JSON.stringify([...files].sort((a,b)=>a.path<b.path?-1:1))).digest('hex');
    const processProof=()=>({status:'stopped',exitCode:0,terminationConfirmed:true,stopAcknowledged:true,sourceUnchanged:true});
    const http=files=>({status:'passed',profileId:'library-web-v1',sourceHash:digest(files),manifestHash:webManifest.hash,terminationConfirmed:true,
      checks:webManifest.checks.map(c=>({...c,passed:true})),processes:[processProof(),processProof()],databasePreflights:[],databaseCommands:[0,1].map(()=>({kind:'database_observation',runnerHash:databaseObserverHash,sourceHash:digest(files),exitCode:0,terminationConfirmed:true,stopReason:null,truncated:false}))});
    mock.module(${JSON.stringify(new URL('../lib/windows-sandbox.mjs', import.meta.url).href)},{namedExports:{createWindowsSandbox:()=>({preflight:async()=>({kind:'trusted-test-only'})})}});
    mock.module(${JSON.stringify(new URL('../lib/web-tests.mjs', import.meta.url).href)},{namedExports:{webManifest,databaseObserverHash,runWebTests:async({files})=>{counts.http++;const r=http(files);if(mode==='self-failure'&&counts.http===1){r.status='failed';r.checks[0].passed=false;}if(mode==='unknown'){r.status='reconciliation_required';r.terminationConfirmed=false;r.processes[0].terminationConfirmed=false;}return r;}}});
    mock.module(${JSON.stringify(new URL('../lib/web-browser-tests.mjs', import.meta.url).href)},{namedExports:{browserManifest,runWebBrowserTests:async({files})=>{counts.browser++;return {status:'passed',profileId:'library-web-v1',sourceHash:digest(files),manifestHash:browserManifest.hash,terminationConfirmed:true,checks:browserManifest.checks.map(c=>({...c,passed:true})),browser:{closed:true,version:'157.0.1'},processes:[processProof(),processProof(),{kind:'browser',status:'stopped',exitCode:0,terminationConfirmed:true}]};}}});
    const {startWebExecution,isWebTaskAccepted}=await import(${JSON.stringify(new URL('../lib/web-executor.mjs', import.meta.url).href)});
    const controller=new AbortController();let code=0,reviews=0,lateReceipt=false;
    const execution=startWebExecution({outputDir:${JSON.stringify(directory)},binding:${JSON.stringify(binding)},initialSource:original,previousIssues:issues,signal:controller.signal,maxCalls:['carry','revert','self-failure','new-blocker'].includes(mode)?2:1,maxReviewCalls:2,timeoutMs:mode==='deadline'?2000:15000,
      assertCurrent:async()=>{if(mode==='late-current'&&reviews)throw new Error('current version expired');},
      provider:async({files,feedback,onReceipt})=>{code++;captured.push({files,feedback});
        if(mode==='cancel'||mode==='deadline'){if(mode==='cancel'){setTimeout(()=>controller.abort(),10);await new Promise(r=>setTimeout(r,100));lateReceipt=true;try{await onReceipt({model:'fake-code',finishReason:'stop',usage:{inputTokens:2,outputTokens:3},content:'late'});}catch{}}return new Promise(()=>{});}
        const replacements=mode==='noop'||mode==='revert'&&code===2?${JSON.stringify(seedFiles)}:[{path:'src/app.mjs',content:${JSON.stringify(seedFiles[0].content)}+'// actual model edit '+code+'\\n'}];
        await onReceipt({model:'fake-code',finishReason:'stop',usage:{inputTokens:2,outputTokens:3},content:JSON.stringify({files:replacements})});return {files:replacements,model:'fake-code',usage:{inputTokens:2,outputTokens:3}};
      },reviewer:async({previousIssues,onReceipt})=>{reviews++;reviewed.push(previousIssues);const value={summary:'Synthetic protocol fixture, not business acceptance',issues:[],resolutions:mode==='missing-resolution'?[]:previousIssues.map(i=>({id:i.id,status:mode==='open'||['carry','revert'].includes(mode)&&reviews===1?'open':'resolved',reason:'Synthetic current-code resolution evidence'}))};
        if(mode==='new-blocker'&&reviews===1)value.issues.push({severity:'blocking',file:'docs/original.md',line:1,message:'synthetic new blocker',evidence:'# Preserve the original project'});
        await onReceipt({model:'fake-review',finishReason:'stop',usage:{inputTokens:5,outputTokens:7},content:JSON.stringify(value)});return value;}});
    if(mode==='mutation'){original.files[0].content='caller mutation';issues[0].evidence='caller mutation';original.sourceCommit='f'.repeat(40);}
    const record=await execution.done;const saved=await readFile(record.reportPath,'utf8');if(mode==='cancel')await new Promise(r=>setTimeout(r,180));
    const baselineFiles=record.baseCommit?${JSON.stringify(seedFiles.map(f=>f.path))}.map(p=>({path:p,content:execFileSync('git',['--no-optional-locks','-C',record.workspace,'show',record.baseCommit+':'+p],{encoding:'utf8',windowsHide:true})})):[];
    process.stdout.write(JSON.stringify({record,captured,reviewed,counts,code,reviews,accepted:isWebTaskAccepted(record),baselineFiles,lateReceipt,unchanged:saved===await readFile(record.reportPath,'utf8')}));
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('trusted repair probe did not settle')); }, 25000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stderr + stdout)); } } }); child.stdin.end(script);
  });
  assert.deepEqual(await readFile(originReport), before); return result;
}

test('Web execution requires exact confirmed versions, roles and finite budgets before work starts', () => {
  const options = { outputDir: path.resolve('unused-output'), binding, provider: async () => {}, reviewer: review };
  for (const change of [{ binding: {} }, { binding: { ...binding, specRevision: '' } }, { providerKind: 'fixture-as-model' },
    { reviewer: null }, { maxCalls: 0 }, { maxReviewCalls: 6 }, { timeoutMs: 600_001 }, { outputDir: '.' }]) {
    assert.throws(() => startWebExecution({ ...options, ...change }));
  }
});

test('repair seed validates canonical files, source identity/hash and complete blocking evidence synchronously', () => {
  const options = { outputDir: path.resolve('unused-repair-output'), binding, provider: async () => {}, reviewer: review };
  assert.throws(() => startWebExecution({ ...options, previousIssues: seedIssues() }));
  assert.throws(() => startWebExecution({ ...options, previousIssues: [] }));
  for (const change of [{ sourceHash: 'a'.repeat(64) }, { sourceCommit: 'bad' }, { sourceCommit: ['c'.repeat(40)] }, { sourceReportHash: ['d'.repeat(64)] },
    { sourceExecutionId: '../source' }, { sourceExecutionId: ['source'] }, { sourceReportHash: '' }, { files: [] }, { files: [{ path: '../escape.mjs', content: 'x' }] },
    { files: [{ path: 'package.json', content: '{}' }] }, { files: [{ ...seedFiles[0], command: 'run' }] }, { sourceReportPath: 'C:/private/execution.json' },
    { reviewSourceExecutionId: null }]) assert.throws(() => startWebExecution({ ...options, initialSource: { ...initialSource(), ...change }, previousIssues: seedIssues() }));
  const partialReview = initialSource(); delete partialReview.reviewSourceReportHash; assert.throws(() => startWebExecution({ ...options, initialSource: partialReview }));
  for (const change of [{ id: '' }, { status: 'resolved' }, { severity: 'advisory' }, { file: 'src/missing.mjs' }, { line: 2 }, { evidence: 'invented evidence' },
    { originCommit: ['c'.repeat(40)] }, { message: '' }, { command: 'skip tests' }]) assert.throws(() => startWebExecution({ ...options, initialSource: initialSource(), previousIssues: [{ ...seedIssues()[0], ...change }] }));
  assert.throws(() => startWebExecution({ ...options, initialSource: initialSource(), previousIssues: [...seedIssues(), ...seedIssues()] }));
});

test('repair inputs reject accessors, cycles, prototype tricks and budgets without invoking getters', () => {
  let getters = 0; const options = { outputDir: path.resolve('unused-repair-output'), binding, provider: async () => {}, reviewer: review };
  for (const key of ['initialSource', 'previousIssues']) { const value = { ...options }; Object.defineProperty(value, key, { enumerable: true, get() { getters++; return {}; } }); assert.throws(() => startWebExecution(value)); }
  for (const mutate of [value => Object.defineProperty(value.files[0], 'content', { enumerable: true, get() { getters++; return ''; } }),
    value => { value.extra = value; }, value => { value.extra = () => {}; }, value => { value[Symbol('x')] = 1; }, value => { Object.setPrototypeOf(value, { fake: true }); },
    value => { value.extra = 'x'.repeat(8 * 1024 * 1024); }, value => { value.files = new Array(2); }]) {
    const source = initialSource(); mutate(source); assert.throws(() => startWebExecution({ ...options, initialSource: source, previousIssues: seedIssues() }));
  }
  const issues = seedIssues(); Object.defineProperty(issues[0], 'evidence', { enumerable: true, get() { getters++; return ''; } });
  assert.throws(() => startWebExecution({ ...options, initialSource: initialSource(), previousIssues: issues })); assert.equal(getters, 0);
});

test('repair starts from exact original files in a real new Git baseline, snapshots inputs and only counts new model calls', async t => {
  for (const mode of ['normal', 'mutation']) {
    const { record, captured, reviewed, counts, accepted, baselineFiles } = await repairExecution(t, mode);
    assert.equal(accepted, true); assert.equal(record.kind, 'web_execution'); assert.equal(record.provenance, undefined);
    assert.deepEqual(baselineFiles, seedFiles); assert.match(record.baseCommit, /^[a-f0-9]{40}$/u); assert.notEqual(record.baseCommit, initialSource().sourceCommit);
    assert.notEqual(record.candidateCommit, record.baseCommit); assert.notEqual(record.versions[0].sourceHash, initialSource().sourceHash);
    assert.deepEqual(captured[0].files, validateProjectFiles(seedFiles)); assert.deepEqual(JSON.parse(captured[0].feedback).issues, seedIssues());
    assert.deepEqual(reviewed[0], seedIssues()); assert.deepEqual(counts, { http: 2, browser: 1 });
    assert.deepEqual(record.repairSource.previousIssues, seedIssues()); assert.equal(record.repairSource.sourceCommit, initialSource().sourceCommit);
    assert.equal(record.repairSource.sourceReportHash, initialSource().sourceReportHash); assert.equal(record.repairSource.reviewSourceReportHash, initialSource().reviewSourceReportHash);
    assert.equal(record.calls, 1); assert.equal(record.reviewCalls, 1); assert.equal(record.totalModelCalls, 2); assert.deepEqual(record.usage, { inputTokens: 7, outputTokens: 10 });
    assert.equal(record.modelCalls.length, 2); assert.ok(record.modelCalls.every(call => /^[a-f0-9]{64}$/u.test(call.receiptHash)));
    assert.equal(record.versions[0].acceptance.issues[0].status, 'resolved'); assert.deepEqual(record.versions[0].acceptance.openIssues, []);
  }
});

test('repair unchanged or reverted source cannot reach a fresh Review or reuse an earlier pass', async t => {
  const noop = await repairExecution(t, 'noop'); assert.equal(noop.record.status, 'failed'); assert.equal(noop.reviews, 0); assert.equal(noop.record.versions.length, 0); assert.equal(noop.accepted, false);
  const reverted = await repairExecution(t, 'revert'); assert.equal(reverted.record.status, 'failed'); assert.equal(reverted.code, 2); assert.equal(reverted.reviews, 1);
  assert.equal(reverted.record.versions.length, 1); assert.equal(reverted.accepted, false); assert.match(reverted.record.error, /原来源/u);
});

test('carried blocking issues cannot be omitted or left open and persist through self-check repair and repeated Review', async t => {
  for (const mode of ['missing-resolution', 'open']) { const result = await repairExecution(t, mode); assert.equal(result.accepted, false); assert.equal(result.reviews, 1); assert.equal(result.record.status, 'failed'); }
  const carried = await repairExecution(t, 'carry'); assert.equal(carried.accepted, true); assert.equal(carried.record.calls, 2); assert.equal(carried.reviews, 2);
  assert.equal(carried.reviewed[1][0].id, seedIssues()[0].id); assert.equal(carried.reviewed[1][0].status, 'open'); assert.deepEqual(carried.counts, { http: 4, browser: 2 });
  const self = await repairExecution(t, 'self-failure'); assert.equal(self.accepted, true); assert.equal(self.record.calls, 2); assert.equal(self.reviews, 1);
  assert.deepEqual(JSON.parse(self.captured[1].feedback).issues, seedIssues()); assert.deepEqual(self.reviewed[0], seedIssues()); assert.deepEqual(self.counts, { http: 3, browser: 1 });
  const renewed = await repairExecution(t, 'new-blocker'); assert.equal(renewed.accepted, true); assert.equal(renewed.reviewed[1].length, 2);
  assert.ok(renewed.reviewed[1].some(issue => issue.id === seedIssues()[0].id)); assert.equal(renewed.record.versions.at(-1).acceptance.review.resolutions.length, 2);
});

test('repair cancellation, total deadline, unknown stop and late current-version loss never publish acceptance', async t => {
  for (const mode of ['cancel', 'deadline', 'unknown', 'late-current']) {
    const result = await repairExecution(t, mode); assert.equal(result.accepted, false); assert.equal(result.unchanged, true);
    assert.equal(result.record.repairSource.sourceHash, initialSource().sourceHash);
    assert.equal(result.record.status, mode === 'cancel' ? 'stopped' : mode === 'deadline' ? 'timed_out' : mode === 'unknown' ? 'reconciliation_required' : 'failed');
    if (mode === 'cancel') { assert.equal(result.lateReceipt, true); assert.equal(result.record.modelCalls[0].receiptPath, undefined); }
    if (mode === 'unknown') assert.equal(result.reviews, 0);
  }
});

test('Web execution cancelled before starting creates no workspace or model call', async t => {
  const directory = await fixture(t), controller = new AbortController(); controller.abort();
  let calls = 0;
  const execution = startWebExecution({ outputDir: directory, binding, signal: controller.signal,
    provider: async () => { calls++; }, reviewer: review });
  const result = await execution.done;
  assert.equal(result.status, 'stopped'); assert.equal(result.calls, 0); assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []); assert.equal(isWebTaskAccepted(result), false);
});

test('Web execution rejects a changed confirmed version before creating work or calling the model', async t => {
  const directory = await fixture(t);
  const execution = startWebExecution({ outputDir: directory, binding, provider: async () => assert.fail('model must not run'), reviewer: review,
    assertCurrent: async received => { assert.deepEqual(received, binding); throw new Error('版本已经改变。'); } });
  const result = await execution.done;
  assert.equal(result.status, 'failed'); assert.match(result.error, /版本/); assert.equal(result.calls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('output directory links are rejected before creating a missing child through them', async t => {
  const directory = await fixture(t), target = path.join(directory, 'target'), alias = path.join(directory, 'alias');
  await mkdir(target); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await startWebExecution({ outputDir: path.join(alias, 'must-not-exist'), binding, provider: async () => assert.fail('model must not run'), reviewer: review }).done;
  assert.equal(result.status, 'failed'); assert.deepEqual(await readdir(target), []);
});

test('initial unconfirmed preflight retains process and workspace evidence in the durable record', async t => {
  const { record, persisted, calls } = await mockExecution(t, 'preflight');
  assert.equal(record.status, 'reconciliation_required'); assert.equal(calls, 0);
  assert.equal(persisted.environmentFailure.result.pid, 424245);
  assert.equal(persisted.environmentFailure.result.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(persisted.environmentFailure.result.terminationConfirmed, false);
  assert.match(persisted.environmentFailure.result.controlDirectory, /owned-control$/u);
  assert.match(persisted.environmentFailure.probeDirectory, /owned-probe$/u);
});

test('noncooperative model callback cannot keep execution alive after cancellation or total deadline', async t => {
  for (const mode of ['cancel', 'deadline']) {
    const { record, persisted, calls, duration } = await mockExecution(t, mode);
    assert.equal(record.status, mode === 'deadline' ? 'timed_out' : 'stopped');
    assert.equal(persisted.status, record.status); assert.equal(calls, 1);
    assert.equal(record.candidateCommit, null); assert.equal(record.versions.length, 0);
    assert.equal(record.modelCalls[0].usage.inputTokens, null);
    assert.ok(duration < 7000); assert.equal(isWebTaskAccepted(record), false);
  }
});

test('malformed responses retain private receipts and known usage, with at most one bounded format correction', async t => {
  const { record, persisted, calls } = await mockExecution(t, 'format');
  assert.equal(record.status, 'failed'); assert.equal(calls, 2);
  assert.equal(record.proposalFailures.length, 2); assert.equal(record.versions.length, 0);
  assert.deepEqual(persisted.usage, { inputTokens: 20, outputTokens: 40 });
  for (const call of persisted.modelCalls) {
    assert.equal(call.blankContent, true); assert.equal(call.contentBytes, 3);
    assert.match(call.receiptHash, /^[a-f0-9]{64}$/u);
    const receipt = JSON.parse(await readFile(call.receiptPath, 'utf8'));
    assert.equal(receipt.content, '   '); assert.equal(receipt.usage.inputTokens, 10);
  }
});

test('late model receipt after cancellation cannot write evidence or mutate the durable result', async t => {
  const { record, persisted, lateReceipt, unchanged } = await mockExecution(t, 'late-receipt');
  assert.equal(record.status, 'stopped'); assert.equal(lateReceipt, true); assert.equal(unchanged, true);
  assert.equal(persisted.modelCalls[0].receiptPath, undefined);
  assert.equal(persisted.usage.inputTokens, null);
  assert.deepEqual((await readdir(path.dirname(record.reportPath))).filter(name => name.startsWith('model-')), []);
});

test('missing controlled runtime fails closed before coding and persists the failure', async t => {
  const directory = await fixture(t);
  const result = await startWebExecution({ outputDir: directory, binding, executable: '',
    provider: async () => assert.fail('no unprotected fallback'), reviewer: review }).done;
  assert.equal(result.status, 'failed'); assert.equal(result.calls, 0); assert.equal(isWebTaskAccepted(result), false);
  const persisted = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(persisted.status, 'failed'); assert.deepEqual(persisted.usage, { inputTokens: null, outputTokens: null });
});

test('real Web execution rejects model paths outside source without executing or reviewing them', real, async t => {
  const directory = await fixture(t);
  let reviewCalls = 0;
  const result = await startWebExecution({ outputDir: directory, binding, maxCalls: 1,
    provider: async () => ({ files: [{ path: '../escape.mjs', content: 'unsafe' }] }),
    reviewer: async () => { reviewCalls++; return review(); } }).done;
  assert.equal(result.status, 'failed'); assert.equal(result.calls, 1); assert.equal(result.versions.length, 0);
  assert.equal(reviewCalls, 0); assert.equal(result.candidateCommit, null); assert.equal(isWebTaskAccepted(result), false);
});

test('real incomplete Web candidate fails fixed business checks, preserves evidence and stops at repair budget', real, async t => {
  const directory = await fixture(t);
  let calls = 0, reviews = 0;
  const result = await startWebExecution({ outputDir: directory, binding, maxCalls: 1, timeoutMs: 60_000,
    provider: async () => { calls++; return { files: [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:200,headers:{"content-type":"application/json"},body:"{}"}}}}' }] }; },
    reviewer: async () => { reviews++; return review(); } }).done;
  assert.equal(result.status, 'failed'); assert.equal(calls, 1); assert.equal(reviews, 0);
  assert.match(result.candidateCommit, /^[a-f0-9]{40}$/u); assert.notEqual(result.candidateCommit, result.baseCommit);
  const check = result.versions[0].selfCheck;
  assert.equal(check.status, 'failed'); assert.equal(check.checks.length, webManifest.count);
  assert.ok(check.checks.some(item => !item.passed)); assert.equal(check.terminationConfirmed, true);
  assert.equal(result.versions[0].acceptance, null); assert.equal(isWebTaskAccepted(result), false);
  assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).candidateCommit, result.candidateCommit);
});

test('real seeded repair makes a new Git candidate and fails fresh MXC business checks without Review or paid models', real, async t => {
  const directory = await fixture(t), source = initialSource(), issues = seedIssues(), before = structuredClone({ source, issues }); let reviews = 0;
  const record = await startWebExecution({ outputDir: directory, binding, initialSource: source, previousIssues: issues, maxCalls: 1, timeoutMs: 60000,
    provider: async ({ files, feedback, onReceipt }) => { assert.deepEqual(files, validateProjectFiles(seedFiles)); assert.deepEqual(JSON.parse(feedback).issues, issues);
      const changed = [{ path: seedFiles[0].path, content: seedFiles[0].content + '// model attempted a repair\n' }];
      await onReceipt({ model: 'synthetic-repair-test', finishReason: 'stop', usage: { inputTokens: null, outputTokens: null }, content: JSON.stringify({ files: changed }) }); return { files: changed }; },
    reviewer: async () => { reviews++; assert.fail('incomplete candidate cannot reach Review'); } }).done;
  assert.equal(record.status, 'failed'); assert.equal(record.calls, 1); assert.equal(record.reviewCalls, 0); assert.equal(reviews, 0); assert.equal(isWebTaskAccepted(record), false);
  assert.notEqual(record.baseCommit, source.sourceCommit); assert.notEqual(record.candidateCommit, record.baseCommit); assert.notEqual(record.versions[0].sourceHash, source.sourceHash);
  assert.equal(record.versions[0].selfCheck.status, 'failed'); assert.equal(record.versions[0].selfCheck.checks.length, webManifest.count); assert.equal(record.versions[0].selfCheck.terminationConfirmed, true);
  assert.deepEqual({ source, issues }, before); assert.deepEqual(record.usage, { inputTokens: null, outputTokens: null });
});

test('acceptance predicate rejects stale rules, mismatched branches, missing browser results and diagnostic identities', () => {
  const candidate = { ...binding, attemptId: 'attempt-1', candidateCommit: 'c'.repeat(40), sourceHash: 'd'.repeat(64),
    manifestHash: webManifest.hash, browserManifestHash: browserManifest.hash, reviewPolicyHash: projectReviewPolicy.hash };
  const process = { terminationConfirmed: true, sourceUnchanged: true, status: 'stopped', exitCode: 0, stopAcknowledged: true };
  const check = manifest => ({ status: 'passed', sourceHash: candidate.sourceHash, manifestHash: manifest.hash,
    checks: manifest.checks.map(item => ({ ...item, passed: true })), processes: [process], terminationConfirmed: true, binding: { ...candidate } });
  const http = { ...check(webManifest), profileId: webProfile.id, databasePreflights: [], databaseCommands: Array.from({ length: 2 }, () => ({
    kind: 'database_observation', runnerHash: databaseObserverHash, sourceHash: candidate.sourceHash, exitCode: 0, terminationConfirmed: true, stopReason: null, truncated: false,
  })) };
  const gate = { status: 'passed', binding: candidate, openIssues: [], issues: [], test: http,
    browser: { ...check(browserManifest), profileId: webProfile.id, browser: { version: 'predicate-test', closed: true },
      processes: [process, process, { kind: 'browser', terminationConfirmed: true, status: 'stopped', exitCode: 0 }] },
    review: { status: 'completed', policyHash: projectReviewPolicy.hash, openBlockingIssues: 0, issues: [], resolutions: [], binding: { ...candidate } } };
  const baseline = { ...binding, attemptId: candidate.attemptId, profileId: webProfile.id, providerKind: 'model', reviewerKind: 'model',
    status: 'accepted', acceptanceStatus: 'passed', candidateCommit: candidate.candidateCommit,
    versions: [{ commit: candidate.candidateCommit, sourceHash: candidate.sourceHash, selfCheck: structuredClone(http), acceptance: gate }] };
  assert.equal(isWebTaskAccepted(baseline), true, 'synthetic predicate contract only; no execution is asserted');
  for (const mutate of [
    record => { record.providerKind = 'trusted_fixture'; }, record => { record.reviewerKind = 'diagnostic'; },
    record => { record.specRevision = 'e'.repeat(64); }, record => { record.candidateCommit = 'e'.repeat(40); },
    record => { record.versions[0].acceptance.test.binding.candidateCommit = 'f'.repeat(40); },
    record => { record.versions[0].acceptance.binding.manifestHash = 'f'.repeat(64); },
    record => { record.versions[0].acceptance.review.policyHash = 'f'.repeat(64); },
    record => { record.versions[0].acceptance.test.checks.pop(); },
    record => { record.versions[0].acceptance.browser = null; },
    record => { record.versions[0].acceptance.browser.browser.closed = false; },
    record => { record.versions[0].acceptance.browser.checks[0].passed = false; },
    record => { record.versions[0].acceptance.test.processes[0].exitCode = 1; },
    record => { record.versions[0].acceptance.test.databaseCommands[0].runnerHash = 'f'.repeat(64); },
    record => { record.versions[0].selfCheck = null; },
    record => { record.versions[0].acceptance.review.openBlockingIssues = 1; },
    record => { record.versions[0].acceptance.openIssues.push({ id: 'not-resolved' }); },
  ]) { const record = structuredClone(baseline); mutate(record); assert.equal(isWebTaskAccepted(record), false); }
});
