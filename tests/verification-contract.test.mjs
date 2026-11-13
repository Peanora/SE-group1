import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createVerificationControl, compileManifest, readJsonPath, resolveScenarioPath, HTTP_LIMITS } from '../lib/verification-contract.mjs';
import { runHttpScenarios } from '../lib/http-scenarios.mjs';

const baseBinding = { projectId: 'project', runId: '1234-run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const execution = { ...baseBinding, taskId: 'task', attemptId: 'attempt', candidateCommit: 'c'.repeat(40) };
const files = [{ path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:500,headers:{"content-type":"application/json"},body:"{}"}}}}' }, { path: 'tests/forged.test.mjs', content: 'throw new Error("Never run candidate tests");' }, { path: 'docs/passed.json', content: '{"passed":true}' }];
const status = (id, value = 200) => ({ id, op: 'status', value });
function proposal() {
  return { version: 1, id: 'generic-demo', name: 'Controlled HTTP observations', sessions: ['alice', 'bob'], steps: [
    { id: 'alice_login', type: 'request', dependsOn: [], requirementIds: ['REQ1'], request: { id: 'login_a', method: 'POST', path: '/login', session: 'alice', body: { user: 'alice' }, assertions: [status('login_a_status')] } },
    { id: 'bob_login', type: 'request', dependsOn: [], requirementIds: ['REQ1'], request: { id: 'login_b', method: 'POST', path: '/login', session: 'bob', body: { user: 'bob' }, assertions: [status('login_b_status')] } },
    { id: 'create', type: 'request', dependsOn: ['alice_login'], requirementIds: ['REQ1'], request: { id: 'create_item', method: 'POST', path: '/items', session: 'alice', body: { title: 'contract data' }, assertions: [status('create_status', 201), { id: 'create_id', op: 'jsonExists', path: '$.id' }], captures: [{ name: 'itemId', path: '$.id' }] } },
    { id: 'race', type: 'concurrent', dependsOn: ['create', 'bob_login'], requirementIds: ['REQ2'], requests: ['alice', 'bob'].map((session, index) => ({ id: `race_${index}`, method: 'POST', path: '/claim', session, body: { itemId: { $var: 'itemId' } }, assertions: [{ id: `race_status_${index}`, op: 'statusIn', value: [201, 409] }] })), expectedStatuses: [201, 409] },
    { id: 'restart', type: 'restart', dependsOn: ['race'], requirementIds: ['REQ2'] },
    { id: 'persisted', type: 'request', dependsOn: ['restart'], requirementIds: ['REQ2'], request: { id: 'read_item', method: 'GET', path: '/items/${itemId}', session: 'alice', assertions: [status('read_status'), { id: 'read_id', op: 'jsonEquals', path: '$.id', value: { $var: 'itemId' } }, { id: 'read_names', op: 'jsonLength', path: '$.names', value: 1 }, { id: 'read_count', op: 'jsonEquals', path: '$.count', value: 1 }, { id: 'read_text', op: 'textIncludes', value: 'names' }] } },
  ] };
}
function approved(raw = proposal(), binding = baseBinding) {
  const control = createVerificationControl(), input = { proposal: raw, requirements: ['REQ1', 'REQ2'], binding };
  const approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval); return { control, input, approval, manifest };
}
async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'verification-contract-'));
  t.after(async () => { const relative = path.relative(path.resolve(os.tmpdir()), value); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(value, { recursive: true, force: true }); }); return value;
}
function complete(report, manifest) {
  assert.equal(report.manifestHash, manifest.manifestHash);
  assert.equal(report.checks.length, manifest.checks.length);
  assert.deepEqual(report.checks.map(check => check.id), manifest.checks.map(check => check.id));
  assert.ok(report.checks.every(check => typeof check.passed === 'boolean' && typeof check.actual === 'string'));
  assert.equal(report.coverage, 'structural_only');
}
async function mocked(t, mode, raw = proposal()) {
  const rootDir = await directory(t);
  const script = `
    import {mock} from 'node:test';import {writeFile} from 'node:fs/promises';
    const raw=${JSON.stringify(raw)},files=${JSON.stringify(files)},binding=${JSON.stringify(execution)},rootDir=${JSON.stringify(rootDir)},mode=${JSON.stringify(mode)};
    let starts=0,requests=[],workspaces=[],attempts=0,claimed=0;
    const controller=new AbortController();
    function response(status,json,headers={}){return {status,headers:{'content-type':'application/json',...headers},body:Buffer.from(JSON.stringify(json))};}
    mock.module(${JSON.stringify(new URL('../lib/web-runtime.mjs', import.meta.url).href)},{namedExports:{startWebRuntime:async options=>{
      const number=++starts;workspaces.push(options.workspace);options.onEvent?.({type:'ready'});
      return {pid:100+number,request:async request=>{
        requests.push(request);
        if(mode==='cancel'&&requests.length===1)queueMicrotask(()=>controller.abort());
        if(mode==='timeout'||mode==='cancel')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
        if(mode==='tamper')await writeFile(options.workspace+'/src/app.mjs','external edit');
        if(mode==='all-fail')return response(500,{passed:true});
        if(mode==='large-response')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.alloc(65537,97)};
        if(mode==='unsafe-cookie')return response(200,{},{'set-cookie':['external_cookie=bad; HttpOnly']});
        if(request.path==='/login'){const user=JSON.parse(request.body).user;return response(200,{user},{'set-cookie':['app_session='+user+'; HttpOnly; Path=/; SameSite=Lax']});}
        if(request.path==='/items')return response(201,{id:mode==='bad-capture'?{}:mode==='large-capture'?'x'.repeat(5000):mode==='expansion'?'x'.repeat(4090):'A/B?x=1'});
        if(request.path==='/claim')return response(++claimed===1?201:409,{ok:true});
        return response(200,{id:'A/B?x=1',names:['one'],count:mode==='lost-persistence'?0:1});
      },stop:async()=>({pid:100+number,startedAt:'mock-'+number,status:mode==='unknown-stop'?'reconciliation_required':'stopped',terminationConfirmed:mode!=='unknown-stop',exitCode:0,stopAcknowledged:mode!=='bad-stop',sourceUnchanged:mode!=='tamper'})};
    }}});
    const {createVerificationControl,compileManifest}=await import(${JSON.stringify(new URL('../lib/verification-contract.mjs', import.meta.url).href)});
    const control=createVerificationControl(),input={proposal:raw,requirements:['REQ1','REQ2'],binding:${JSON.stringify(baseBinding)}};
    const approval=control.approve(input),manifest=compileManifest({...input,approval});control.beginCoding(approval);
    const {runHttpScenarios}=await import(${JSON.stringify(new URL('../lib/http-scenarios.mjs', import.meta.url).href)});
    const report=await runHttpScenarios({manifest,files,rootDir,binding,signal:controller.signal,executable:'unused-mock',timeoutMs:mode==='timeout'?100:10000,onEvent:event=>{if(mode==='revoke'&&event.id==='login_a_status')control.revoke(approval);},runtimeFactory:()=>{throw new Error('client factory must not execute');}});
    process.stdout.write(JSON.stringify({report,starts,requests,workspaces,manifest}));
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('trusted scenario mock timed out')); }, 15000);
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; }); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(err)); else { try { resolve(JSON.parse(out)); } catch { reject(new Error(err + out)); } } }); child.stdin.end(script);
  });
}

test('控制器批准→编译→锁定编码阶段；哈希稳定且不含候选通过标记', () => {
  const a = approved(); assert.match(a.manifest.manifestHash, /^[a-f0-9]{64}$/u); assert.ok(Object.isFrozen(a.manifest.steps[0].request));
  assert.equal(compileManifest({ ...a.input, approval: a.approval }).manifestHash, a.manifest.manifestHash);
  assert.throws(() => a.control.approve(a.input), /编码开始/u);
  assert.throws(() => compileManifest({ ...a.input, approval: JSON.parse(JSON.stringify(a.approval)) }), /可信/u);
  assert.throws(() => compileManifest({ ...a.input, binding: { ...baseBinding, planRevision: 'd'.repeat(64) }, approval: a.approval }), /变化/u);
});

test('编前更换清单使旧审批失效，不接受candidate给的approved布尔', () => {
  const control = createVerificationControl(), input = { proposal: proposal(), requirements: ['REQ1', 'REQ2'], binding: baseBinding };
  const old = control.approve(input); const newer = structuredClone(input); newer.proposal.name = 'new contract'; control.approve(newer);
  assert.throws(() => compileManifest({ ...input, approval: old }), /当前可信/u);
  assert.throws(() => compileManifest({ ...input, approval: { ...old, approved: true, phase: 'before_coding' } }), /可信/u);
  const cap = control.approve(newer); assert.throws(() => compileManifest({ ...input, approval: cap }), /变化/u);
});

test('未知REQ、未覆盖REQ、环、未知依赖、前向依赖和空断言拒绝', () => {
  const mutations = [value => { value.steps.forEach(step => { step.requirementIds = ['REQ1']; }); }, value => { value.steps[0].requirementIds = ['UNKNOWN']; }, value => { value.steps[0].dependsOn = ['persisted']; }, value => { value.steps[0].dependsOn = ['unknown']; }, value => { value.steps[0].dependsOn = ['bob_login']; }, value => { value.steps[0].request.assertions = []; }, value => { value.steps[1].request.assertions[0].id = 'login_a_status'; }];
  for (const mutate of mutations) { const value = proposal(); mutate(value); assert.throws(() => approved(value), { code: 'invalid_contract' }); }
});

test('外部URL、编码绕过、任意头、JS/SQL/命令字段和非法JSONPath拒绝', () => {
  const badPaths = ['https://example.com/', '//example.com/a', '/\\example.com/a', '/%2f%2fexample.com', '/api/../secret', '/api#fragment'];
  for (const bad of badPaths) { const value = proposal(); value.steps[0].request.path = bad; assert.throws(() => approved(value)); }
  for (const key of ['headers', 'script', 'sql', 'command', 'passed']) { const value = proposal(); value.steps[0].request[key] = 'untrusted'; assert.throws(() => approved(value)); }
  for (const bad of ['$.constructor', '$.__proto__.value', '$.prototype', '$["field"]', '$.items[*]', '$.items[99999]']) assert.throws(() => readJsonPath({}, bad));
  let invoked = false; const object = {}; Object.defineProperty(object, 'x', { get() { invoked = true; return 1; } }); assert.throws(() => readJsonPath(object, '$.x')); assert.equal(invoked, false);
  assert.deepEqual(readJsonPath(JSON.parse('{"rows":[{"value":7}]}'), '$.rows[0].value'), { found: true, value: 7 });
});

test('只接收纯JSON，不运行getter或循环对象，不允许未依赖变量/并发捕获', () => {
  const value = proposal(); let invoked = false; Object.defineProperty(value, 'hidden', { enumerable: true, get() { invoked = true; throw new Error('must not run'); } }); assert.throws(() => approved(value)); assert.equal(invoked, false);
  const cycle = proposal(); cycle.loop = cycle; assert.throws(() => approved(cycle));
  const missing = proposal(); missing.steps[5].dependsOn = ['bob_login']; assert.throws(() => approved(missing));
  const concurrent = proposal(); concurrent.steps[3].requests[0].captures = [{ name: 'raceId', path: '$.id' }]; assert.throws(() => approved(concurrent));
  const sameSession = proposal(); sameSession.steps[3].requests[1].session = 'alice'; assert.throws(() => approved(sameSession));
  const arrayMethod = proposal(); let called = false; Object.defineProperty(arrayMethod.steps, 'map', { value() { called = true; return []; } }); assert.throws(() => approved(arrayMethod)); assert.equal(called, false);
  const customPrototype = proposal(); Object.setPrototypeOf(customPrototype.steps, { map() { called = true; } }); assert.throws(() => approved(customPrototype)); assert.equal(called, false);
});

test('步骤、正文、断言、变量及总预算都有硬上限', () => {
  const large = proposal(); large.steps[0].request.body = { value: 'x'.repeat(HTTP_LIMITS.bodyBytes) }; assert.throws(() => approved(large));
  const steps = proposal(); steps.steps = Array.from({ length: 41 }, (_, index) => ({ ...structuredClone(steps.steps[0]), id: 'step' + index })); assert.throws(() => approved(steps));
  const budget = proposal(); budget.limits = { timeoutMs: 120001 }; assert.throws(() => approved(budget));
  const huge = proposal(); huge.steps[0].request.assertions = Array.from({ length: 21 }, (_, index) => status('assert' + index)); assert.throws(() => approved(huge));
  assert.equal(resolveScenarioPath('/items/${id}', { id: 'http://external/a?b=1' }), '/items/http%3A%2F%2Fexternal%2Fa%3Fb%3D1');
  assert.throws(() => resolveScenarioPath('/items/${id}', { id: '..' }));
});

test('可信mock验证捕获、URL编码、两独立cookie jar、状态multiset和同目录重启', async t => {
  const { report, starts, requests, workspaces, manifest } = await mocked(t, 'pass'); complete(report, manifest);
  assert.equal(report.status, 'passed', JSON.stringify(report.checks.filter(check => !check.passed))); assert.equal(starts, 2); assert.equal(workspaces[0], workspaces[1]);
  assert.equal(requests.at(-1).path, '/items/A%2FB%3Fx%3D1');
  const race = requests.filter(request => request.path === '/claim'); assert.equal(race.length, 2); assert.equal(race[0].headers.cookie, 'app_session=alice'); assert.equal(race[1].headers.cookie, 'app_session=bob');
  assert.equal(JSON.parse(race[0].body).itemId, 'A/B?x=1'); assert.equal(report.binding.attemptId, execution.attemptId); assert.equal(report.terminationConfirmed, true);
});

test('错误候选、失败捕获、重启丢数据都保留完整断言且不能pass', async t => {
  for (const mode of ['all-fail', 'bad-capture', 'large-capture', 'lost-persistence', 'large-response', 'unsafe-cookie']) {
    const { report, manifest } = await mocked(t, mode); complete(report, manifest); assert.equal(report.status, 'failed'); assert.ok(report.checks.some(check => !check.passed));
  }
});

test('捕获展开后的请求正文仍受16KiB限制，错误后不再派发请求', async t=>{
  const raw=proposal();raw.steps[3].requests[0].body=Array.from({length:5},()=>({$var:'itemId'}));
  const {report,manifest,requests,starts}=await mocked(t,'expansion',raw);complete(report,manifest);
  assert.equal(report.status,'failed');assert.equal(requests.length,3);assert.equal(starts,1);
  assert.equal(report.checks.find(check=>check.id==='CAP_create_itemId').passed,true);
  assert.equal(report.checks.find(check=>check.id==='race_status_0').passed,false);
});

test('纯JSON清单/过期binding/未进入编码阶段不能启动，已知清单仍完整false', async t => {
  const { manifest } = approved();
  const forged = await runHttpScenarios({ manifest: JSON.parse(JSON.stringify(manifest)), files, rootDir: await directory(t), binding: execution }); assert.equal(forged.status, 'error'); assert.equal(forged.processes.length, 0);
  const stale = await runHttpScenarios({ manifest, files, rootDir: await directory(t), binding: { ...execution, specRevision: 'e'.repeat(64) } }); complete(stale, manifest); assert.ok(stale.checks.every(check => !check.passed));
  const control = createVerificationControl(), input = { proposal: proposal(), requirements: ['REQ1', 'REQ2'], binding: baseBinding }, approval = control.approve(input), before = compileManifest({ ...input, approval });
  const unstarted = await runHttpScenarios({ manifest: before, files, rootDir: await directory(t), binding: execution }); complete(unstarted, before); assert.equal(unstarted.processes.length, 0);
});

test('取消、超时、未知停止、撤销或源码变化禁止后续启动并保留false', async t => {
  for (const [mode, state] of [['cancel', 'cancelled'], ['timeout', 'timed_out'], ['unknown-stop', 'reconciliation_required'], ['revoke', 'failed'], ['tamper', 'failed'], ['bad-stop', 'failed']]) {
    const { report, starts, manifest } = await mocked(t, mode); complete(report, manifest); assert.equal(report.status, state, mode); assert.equal(starts, 1, mode); assert.ok(report.checks.some(check => !check.passed));
  }
});

test('非法signal或提前取消返回完整结果，不泄露取消原因', async t => {
  const { manifest } = approved();
  for (const signal of [null, {}, 1]) { const result = await runHttpScenarios({ manifest, files, rootDir: await directory(t), binding: execution, signal }); complete(result, manifest); assert.equal(result.status, 'error'); }
  const controller = new AbortController(); controller.abort('private cancellation reason');
  const result = await runHttpScenarios({ manifest, files, rootDir: await directory(t), binding: execution, signal: controller.signal }); complete(result, manifest); assert.equal(result.status, 'cancelled'); assert.equal(JSON.stringify(result).includes('private cancellation reason'), false);
});

const real = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 45000 };
test('真实MXC错误候选不能以源码tests/pass marker代替批准HTTP断言', real, async t => {
  const { manifest } = approved(); const result = await runHttpScenarios({ manifest, files, rootDir: await directory(t), binding: execution, timeoutMs: 30000 }); complete(result, manifest);
  assert.equal(result.status, 'failed'); assert.ok(result.checks.some(check => check.id === 'login_a_status' && !check.passed)); assert.equal(result.terminationConfirmed, true);
  assert.ok(result.processes.length >= 1); assert.ok(result.processes.every(process => process.terminationConfirmed));
});
