import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runWebTests, webManifest } from '../lib/web-tests.mjs';
import { webProfile } from '../lib/web-profile.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';

const files = [
  { path: 'src/app.mjs', content: 'export async function createApp(){return {handle(){return {status:500,headers:{"content-type":"application/json"},body:"{\\"error\\":\\"deliberately incomplete\\"}"}}}}' },
  { path: 'tests/forged.test.mjs', content: 'throw new Error("candidate tests must never be executed");' },
  { path: 'docs/result.json', content: '{"passed":true,"checks":[]}' },
];
async function root(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-acceptance-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function complete(report) {
  assert.equal(report.profileId, webProfile.id);
  assert.equal(report.manifestHash, webManifest.hash);
  assert.equal(report.checks.length, webManifest.count);
  assert.deepEqual(report.checks.map(({ id, name }) => ({ id, name })), webManifest.checks);
  assert.ok(report.checks.every(check => typeof check.passed === 'boolean' && typeof check.expected === 'string' && typeof check.actual === 'string'));
  assert.notEqual(report.status, 'passed');
}

async function mocked(t, mode) {
  const rootDir = await root(t);
  // This subprocess executes trusted test scaffolding only. Candidate source is never imported.
  const script = `
    import { mock } from 'node:test';
    import { writeFile,mkdir,link } from 'node:fs/promises';
    import { DatabaseSync } from 'node:sqlite';
    const controller = new AbortController();
    let calls=0, stops=0, requestCount=0;
    const runtimeUrl = ${JSON.stringify(new URL('../lib/web-runtime.mjs', import.meta.url).href)};
    const rootDir=${JSON.stringify(rootDir)}, mode=${JSON.stringify(mode)};
    const files=${JSON.stringify(files)};
    const record={pid:123456,startedAt:'mock',status:'stopped',terminationConfirmed:true,sourceUnchanged:true,exitCode:0,stopAcknowledged:true};
    mock.module(runtimeUrl,{namedExports:{startWebRuntime:async options=>{
      calls++;
      if(mode.startsWith('db-')){
        const directory=options.workspace+'/.platform/tmp'; await mkdir(directory,{recursive:true});
        const filename=directory+'/app.sqlite';
        if(mode==='db-header') await writeFile(filename,'x'.repeat(4096));
        else if(mode==='db-oversize') await writeFile(filename,Buffer.alloc(8*1024*1024+1));
        else if(mode==='db-hardlink'){await writeFile(rootDir+'/other.sqlite','x'.repeat(4096));await link(rootDir+'/other.sqlite',filename);}
        else { const db=new DatabaseSync(filename);db.exec('CREATE TABLE loans(id TEXT,book_id TEXT,user_id TEXT,status TEXT);CREATE TABLE audit_events(action TEXT,actor_id TEXT,target_id TEXT,at TEXT);'+(mode==='db-view'?'CREATE VIEW books AS SELECT 1 AS id;':'CREATE TABLE books(id TEXT,title TEXT,copies INTEGER);'));db.close();}
      }
      if(mode==='startup-timeout') await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('stopped'),{code:'cancelled'})),{once:true}));
      if(mode==='tampered') await writeFile(options.workspace+'/src/app.mjs','source externally changed');
      return {pid:123456,url:'http://localhost:1',request:async()=>{
        requestCount++;
        if(mode==='request-timeout') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('stopped'),{code:'cancelled'})),{once:true}));
        return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('{"passed":true,"status":"accepted","checks":[{"passed":true}]}')};
      },stop:async()=>{stops++;return {...record,...(mode==='unconfirmed'?{status:'reconciliation_required',terminationConfirmed:false}:{}),...(mode==='tampered'?{sourceUnchanged:false}:{})};}};
    }}});
    const {runWebTests}=await import(${JSON.stringify(new URL('../lib/web-tests.mjs', import.meta.url).href)});
    const report=await runWebTests({rootDir,files,executable:'unused-mock',timeoutMs:mode.includes('timeout')?80:5000,signal:controller.signal,manifest:{hash:'forged',checks:[{passed:true}]},onEvent:event=>{
      if(mode==='cancelled'&&event.id==='WEB-002')controller.abort();
      if(mode==='throw-observer')throw new Error('observer cannot grant or stop a verdict');
    }});
    process.stdout.write(JSON.stringify({report,calls,stops,requestCount}));
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('trusted mock test timed out')); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stderr + stdout)); } } });
    child.stdin.end(script);
  });
}

test('业务档案与验收清单冻结，版本绑定实现且不接受外部manifest', () => {
  assert.equal(webProfile.id, 'library-web-v1');
  assert.equal(webManifest.count, 18);
  assert.equal(new Set(webManifest.checks.map(check => check.id)).size, webManifest.count);
  assert.match(webManifest.hash, /^[a-f0-9]{64}$/u);
  assert.throws(() => { webManifest.checks[0].id = 'forged'; }, TypeError);
  assert.throws(() => { webProfile.task.accounts[0].role = 'member'; }, TypeError);
});

test('非法文件整体拒绝，固定清单仍完整且没有伪造进程记录', async t => {
  const report = await runWebTests({ rootDir: await root(t), files: [...files, { path: '../outside.mjs', content: '' }], executable: 'unused' });
  complete(report);
  assert.equal(report.checks[0].passed, false);
  assert.deepEqual(report.processes, []);
  assert.equal(report.terminationConfirmed, false);
});

test('取消先于工作区创建时不启动候选，全部清单明确失败', async t => {
  const controller = new AbortController(); controller.abort('do not disclose this reason');
  const report = await runWebTests({ rootDir: await root(t), files, signal: controller.signal });
  complete(report);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.workspace, null);
  assert.deepEqual(report.processes, []);
  assert.ok(report.checks.every(check => !check.passed));
  assert.ok(!JSON.stringify(report).includes('do not disclose'));
});

test('坏预算或缺少保护环境关闭验收，不执行候选tests/pass marker', async t => {
  const rootDir = await root(t);
  for (const timeoutMs of [0, 600001, NaN]) {
    const report = await runWebTests({ rootDir, files, timeoutMs }); complete(report); assert.equal(report.status, 'error');
  }
  const report = await runWebTests({ rootDir, files, executable: path.join(rootDir, 'does-not-exist.exe') });
  complete(report); assert.equal(report.status, 'error'); assert.equal(report.checks[0].passed, true); assert.equal(report.checks[1].passed, false);
  assert.equal(report.sourceHash, createHash('sha256').update(JSON.stringify(validateProjectFiles(files))).digest('hex'));
  assert.equal(await readFile(path.join(report.workspace, 'tests/forged.test.mjs'), 'utf8'), files[1].content);
});

test('候选声称passed不能通过，依赖失败不会变成跳过通过', async t => {
  const { report, calls, stops } = await mocked(t, 'claims-passed'); complete(report);
  assert.equal(calls, 1); assert.equal(stops, 1);
  assert.equal(report.checks[2].passed, false);
  assert.ok(report.checks.slice(3, 14).every(check => !check.passed));
  assert.equal(report.terminationConfirmed, true);
  assert.equal(report.status, 'failed');
});

test('观察器抛异常不能变更固定判定', async t => {
  const { report } = await mocked(t, 'throw-observer'); complete(report); assert.equal(report.status, 'failed');
});

test('运行中取消及时停止进程并保留完整失败清单', async t => {
  const { report, stops, requestCount } = await mocked(t, 'cancelled'); complete(report);
  assert.equal(report.status, 'cancelled'); assert.equal(stops, 1); assert.equal(requestCount, 0); assert.equal(report.terminationConfirmed, true);
});

test('启动及请求超时都保留固定清单，且停止已启动进程', async t => {
  for (const mode of ['startup-timeout', 'request-timeout']) {
    const { report, stops } = await mocked(t, mode); complete(report); assert.equal(report.status, 'timed_out');
    assert.equal(stops, mode === 'request-timeout' ? 1 : 0);
  }
});

test('源码篡改与无法确认停止均阻止验收', async t => {
  const tampered = (await mocked(t, 'tampered')).report; complete(tampered);
  assert.equal(tampered.checks.find(check => check.id === 'WEB-018').passed, false);
  const uncertain = (await mocked(t, 'unconfirmed')).report; complete(uncertain);
  assert.equal(uncertain.status, 'reconciliation_required'); assert.equal(uncertain.terminationConfirmed, false);
});

test('独立只读数据库观察拒绝非SQLite、超限、硬链接和伪装视图', async t => {
  for (const [mode, expected] of [['db-header', '真实SQLite文件头'], ['db-oversize', '8MiB以内'], ['db-hardlink', '8MiB以内'], ['db-view', 'books为真实普通表'], ['db-empty', '完整重启与API预期已建立']]) {
    const { report } = await mocked(t, mode); complete(report);
    const observation = report.checks.find(check => check.id === 'WEB-017');
    assert.equal(observation.passed, false);
    assert.ok(observation.expected.includes(expected), JSON.stringify(observation));
  }
});

const real = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 45_000 };
test('真实MXC运行错误业务候选：500/候选marker不能冒充Web业务验收', real, async t => {
  const report = await runWebTests({ rootDir: await root(t), files, timeoutMs: 30_000 });
  complete(report);
  assert.equal(report.checks[1].passed, true);
  assert.equal(report.checks[2].passed, false);
  assert.equal(report.status, 'failed');
  assert.equal(report.processes.length, 1);
  assert.equal(report.terminationConfirmed, true);
});
