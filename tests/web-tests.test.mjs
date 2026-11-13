import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runWebTests, webManifest, databaseObserverHash } from '../lib/web-tests.mjs';
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
    import { writeFile,mkdir,link,copyFile } from 'node:fs/promises';
    import { DatabaseSync } from 'node:sqlite';
    import {runProcess} from ${JSON.stringify(new URL('../lib/managed-process.mjs', import.meta.url).href)};
    const controller = new AbortController();
    let calls=0, stops=0, requestCount=0;
    const runtimeUrl = ${JSON.stringify(new URL('../lib/web-runtime.mjs', import.meta.url).href)};
    const rootDir=${JSON.stringify(rootDir)}, mode=${JSON.stringify(mode)};
    const realObserver=mode.endsWith('-mxc');
    const files=${JSON.stringify(files)};
    if(mode.startsWith('valid'))files.push({path:'public/app.js',content:'document.title="Trusted test stub";'}, {path:'public/app.css',content:'body {color: black;}'},{path:'public/index.html',content:'<!doctype html><form><input name="username"><input name="password" type="password"></form><script src="/app.js"></script><link rel="stylesheet" href="/app.css">'});
    // Trusted acceptance-test double only. Never delivered or counted as generated software.
    const state={books:[{id:'book-1',title:mode==='valid-wrong-title'?'wrong title':'课程示例图书',copies:1,createdAt:'extra'}],loans:[],events:[]}, sessions=new Map();let nextSession=0,extra=0;
    const stamped=rows=>rows.map(row=>({...row,extraMetadata:String(++extra)}));
    function reply(status,json,headers={}){return {status,headers:{'content-type':'application/json',...headers},body:Buffer.from(JSON.stringify(json))};}
    function testRequest(request){
      if(request.path==='/'||request.path==='/app.js'||request.path==='/app.css'){
        const item=files.find(file=>file.path==='public'+(request.path==='/'?'/index.html':request.path));
        return {status:200,headers:{'content-type':request.path==='/'?'text/html':request.path.endsWith('.js')?'text/javascript':'text/css'},body:Buffer.from(item.content)};
      }
      const token=(request.headers.cookie||'').replace('app_session=',''), user=sessions.get(token);let body={};
      try{if(request.body)body=JSON.parse(request.body);}catch{return reply(400,{error:'Invalid JSON'});}
      const error=code=>reply(code,{error:'Rejected'});
      if(request.path==='/api/login'){
        if(!['admin','alice','bob'].includes(body.username)||body.password!==body.username+'-pass')return error(401);
        const token='session-'+(++nextSession);sessions.set(token,body.username);
        return reply(200,{user:{id:body.username,role:body.username==='admin'?'admin':'member',username:body.username,createdAt:'extra'}},{'set-cookie':['app_session='+token+'; HttpOnly; Path=/; SameSite=Lax']});
      }
      if(!user)return error(401);
      if(request.path==='/api/logout'){sessions.delete(token);return reply(200,{ok:true},{'set-cookie':['app_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax']});}
      if(request.path==='/api/me')return reply(200,{user:{id:user,role:user==='admin'?'admin':'member',username:user}});
      const available=book=>book.copies-state.loans.filter(loan=>loan.bookId===book.id&&loan.status==='active').length;
      const event=(action,targetId)=>state.events.push({id:'audit-'+state.events.length,action,actorId:user,targetId,at:'2026-11-14T00:00:00.000Z'});
      if(request.path==='/api/books'&&request.method==='GET')return reply(200,{books:stamped(state.books.map(book=>({...book,available:available(book)})))});
      if(request.path==='/api/books'){
        if(user!=='admin')return error(403);
        if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>120||!Number.isInteger(body.copies)||body.copies<1||body.copies>1000)return error(400);
        const book={id:'new-book',title:body.title.trim(),copies:body.copies,createdAt:'extra'};state.books.push(book);event('create_book',book.id);return reply(201,{book:{...book,available:book.copies}});
      }
      if(request.path==='/api/audit')return user==='admin'?reply(200,{events:stamped(state.events)}):error(403);
      if(request.path==='/api/loans'&&request.method==='GET')return reply(200,{loans:stamped(state.loans.filter(loan=>user==='admin'||loan.userId===user))});
      if(request.path==='/api/loans'){
        if(typeof body.bookId!=='string'||'userId'in body||'role'in body)return error(400);
        const book=state.books.find(book=>book.id===body.bookId);if(!book)return error(404);
        if(available(book)<1||state.loans.some(loan=>loan.bookId===book.id&&loan.userId===user&&loan.status==='active'))return error(409);
        const loan={id:'loan-'+state.loans.length,bookId:book.id,userId:user,status:'active',createdAt:'extra'};state.loans.push(loan);event('borrow',loan.id);return reply(201,{loan:{...loan}});
      }
      const parts=request.path.split('/');
      if(parts.length===5&&parts[1]==='api'&&parts[2]==='loans'&&parts[4]==='return'){
        const loan=state.loans.find(loan=>loan.id===decodeURIComponent(parts[3]));if(!loan)return error(404);
        if(user!=='admin'&&loan.userId!==user)return error(403);if(loan.status!=='active')return error(409);
        loan.status='returned';loan.returnedAt='extra return time';event('return',loan.id);return reply(200,{loan:{...loan}});
      }
      return error(404);
    }
    function saveTestDatabase(workspace){
      const db=new DatabaseSync(workspace+'/.platform/tmp/app.sqlite');
      db.exec('CREATE TABLE IF NOT EXISTS books(id TEXT,title TEXT,copies INTEGER);CREATE TABLE IF NOT EXISTS loans(id TEXT,book_id TEXT,user_id TEXT,status TEXT);CREATE TABLE IF NOT EXISTS audit_events(action TEXT,actor_id TEXT,target_id TEXT,at TEXT);BEGIN;DELETE FROM books;DELETE FROM loans;DELETE FROM audit_events;');
      for(const book of state.books)db.prepare('INSERT INTO books VALUES(?,?,?)').run(book.id,book.title,book.copies);
      for(const loan of state.loans)db.prepare('INSERT INTO loans VALUES(?,?,?,?)').run(loan.id,loan.bookId,loan.userId,loan.status);
      for(const item of state.events)db.prepare('INSERT INTO audit_events VALUES(?,?,?,?)').run(item.action,item.actorId,item.targetId,item.at);
      db.exec('COMMIT');db.close();
    }
    if(mode==='db-slow-cancel'||mode==='db-slow-mxc'){
      const db=new DatabaseSync(rootDir+'/slow.sqlite');db.exec('CREATE TABLE books(id TEXT,copies INTEGER);CREATE TABLE loans(id TEXT,book_id TEXT,user_id TEXT,status TEXT);CREATE TABLE audit_events(action TEXT,actor_id TEXT,target_id TEXT,at TEXT);BEGIN');
      for(let i=0;i<100;i++)db.prepare('INSERT INTO books VALUES(?,?)').run('b'+i,i);
      db.exec('COMMIT');let expression="printf('%.*c',65536+copies,97)";
      for(let i=0;i<40;i++)expression="replace("+expression+",'"+(i%2?'b':'a')+"','"+(i%2?'a':'b')+"')";
      db.exec('PRAGMA writable_schema=ON');db.prepare('UPDATE sqlite_master SET sql=? WHERE name=?').run('CREATE TABLE books(id TEXT,copies INTEGER,title TEXT GENERATED ALWAYS AS(substr('+expression+',1,1)) VIRTUAL)','books');db.close();
    }
    if(!realObserver)mock.module(${JSON.stringify(new URL('../lib/windows-sandbox.mjs', import.meta.url).href)},{namedExports:{createWindowsSandbox:()=>({
      preflight:async()=>{if(mode==='valid-preflight-unconfirmed')throw Object.assign(new Error('preflight unconfirmed'),{reconciliationRequired:true,probeDirectory:'retained-probe',result:{pid:12345,startedAt:'mock-preflight',terminationConfirmed:false,controlDirectory:'retained-control'}});return {kind:'trusted-test-stub'};},
      run:async options=>{const result=await runProcess(process.execPath,[options.runnerFile],{cwd:options.workspace,signal:options.signal,timeoutMs:options.timeoutMs,maxOutputBytes:options.maxOutputBytes});return mode==='valid-database-unconfirmed'?{...result,terminationConfirmed:false}:result;}
    })}});
    const record={pid:123456,startedAt:'mock',status:'stopped',terminationConfirmed:true,sourceUnchanged:true,exitCode:0,stopAcknowledged:true};
    mock.module(runtimeUrl,{namedExports:{startWebRuntime:async options=>{
      calls++;
      await mkdir(options.workspace+'/.platform/tmp',{recursive:true});
      if(mode.startsWith('db-')){
        const directory=options.workspace+'/.platform/tmp'; await mkdir(directory,{recursive:true});
        const filename=directory+'/app.sqlite';
        if(mode==='db-header') await writeFile(filename,'x'.repeat(4096));
        else if(mode==='db-oversize') await writeFile(filename,Buffer.alloc(8*1024*1024+1));
        else if(mode==='db-hardlink'){await writeFile(rootDir+'/other.sqlite','x'.repeat(4096));await link(rootDir+'/other.sqlite',filename);}
        else if(mode==='db-slow-cancel'||mode==='db-slow-mxc')await copyFile(rootDir+'/slow.sqlite',filename);
        else { const db=new DatabaseSync(filename);
          const booksSql=mode==='db-view'?'CREATE VIEW books AS SELECT 1 AS id;':mode.includes('commented-virtual')?'CREATE /* comment */ VIRTUAL TABLE books USING fts5(id,title,copies);':mode==='db-generated'?"CREATE TABLE books(id TEXT,copies INTEGER,title TEXT GENERATED ALWAYS AS('课程示例图书') VIRTUAL,created_at TEXT);INSERT INTO books(id,copies) VALUES('book-1',1);":'CREATE TABLE books(id TEXT,title TEXT,copies INTEGER);';
          db.exec('CREATE TABLE loans(id TEXT,book_id TEXT,user_id TEXT,status TEXT);CREATE TABLE audit_events(action TEXT,actor_id TEXT,target_id TEXT,at TEXT);'+booksSql);
          db.close();}
      }
      if(mode==='startup-timeout') await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('stopped'),{code:'cancelled'})),{once:true}));
      if(mode==='tampered') await writeFile(options.workspace+'/src/app.mjs','source externally changed');
      return {pid:123456,url:'http://localhost:1',request:async input=>{
        requestCount++;
        if(mode.startsWith('valid'))return testRequest(input);
        if(mode==='request-timeout') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('stopped'),{code:'cancelled'})),{once:true}));
        return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('{"passed":true,"status":"accepted","checks":[{"passed":true}]}')};
      },stop:async()=>{stops++;if(mode.startsWith('valid'))saveTestDatabase(options.workspace);return {...record,pid:123456+calls,startedAt:'mock-'+calls,...(mode==='unconfirmed'?{status:'reconciliation_required',terminationConfirmed:false}:{}),...(mode==='tampered'?{sourceUnchanged:false}:{})};}};
    }}});
    const {runWebTests}=await import(${JSON.stringify(new URL('../lib/web-tests.mjs', import.meta.url).href)});
    let observationStarting=false,heartbeatBeforeAbort=false,cancelledObservation=false,observationPulse=false;
    const pulse=setInterval(()=>{if(observationStarting)observationPulse=true;},5);
    const report=await runWebTests({rootDir,files,executable:realObserver?process.env.EXECUTION_SANDBOX_EXE:'unused-mock',timeoutMs:mode==='startup-timeout'||mode==='request-timeout'?80:5000,signal:controller.signal,manifest:{hash:'forged',checks:[{passed:true}]},onEvent:event=>{
      if(mode==='cancelled'&&event.id==='WEB-002')controller.abort();
      if(mode==='throw-observer')throw new Error('observer cannot grant or stop a verdict');
      if((mode==='db-slow-cancel'||mode==='db-slow-mxc')&&event.phase==='database_observation'&&event.type==='starting'){
        observationStarting=true;setTimeout(()=>{heartbeatBeforeAbort=observationPulse;cancelledObservation=true;controller.abort();},80);
      }
    }});
    clearInterval(pulse);process.stdout.write(JSON.stringify({report,calls,stops,requestCount,observationStarting,heartbeatBeforeAbort,cancelledObservation}));
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

test('独立只读数据库观察拒绝非SQLite、超限、硬链接、视图和注释虚拟表', async t => {
  for (const [mode, expected] of [['db-header', 'invalid_header'], ['db-oversize', 'unsafe_file'], ['db-hardlink', 'unsafe_file'], ['db-view', 'invalid_table'], ['db-commented-virtual', 'invalid_table'], ['db-empty', null], ['db-generated', null]]) {
    const { report } = await mocked(t, mode); complete(report);
    const observation = report.checks.find(check => check.id === 'WEB-017');
    assert.equal(observation.passed, false);
    const command=report.databaseCommands[0];
    assert.equal(command.runnerHash,databaseObserverHash);
    assert.equal(command.sourceHash,report.sourceHash);
    if(expected) {assert.equal(JSON.parse(command.stdout).code,expected);assert.equal(command.exitCode,1);}
    else {assert.equal(JSON.parse(command.stdout).ok,true);assert.ok(observation.expected.includes('完整重启'));if(mode==='db-generated')assert.equal(JSON.parse(command.stdout).books[0].title,'课程示例图书');}
  }
});

test('无效signal始终返回完整error报告，不在finally再抛异常', async t => {
  for(const signal of [null, {}, 1, {aborted:true,removeEventListener:0}]) {
    const report=await runWebTests({rootDir:await root(t),files,signal});complete(report);assert.equal(report.status,'error');assert.deepEqual(report.processes,[]);assert.deepEqual(report.databaseCommands,[]);
  }
});

test('低内存生成列观察调用开始后80ms取消，宿主定时器保持响应', async t => {
  const {report,observationStarting,heartbeatBeforeAbort,cancelledObservation}=await mocked(t,'db-slow-cancel');complete(report);
  assert.equal(report.status,'cancelled');
  assert.equal(observationStarting,true);assert.equal(heartbeatBeforeAbort,true);assert.equal(cancelledObservation,true);
  assert.equal(report.databaseCommands.length,1);
  assert.equal(report.databaseCommands[0].stopReason,'cancelled',JSON.stringify(report.databaseCommands));
  assert.ok(report.databaseCommands[0].pid>0);
  assert.equal(report.databaseCommands[0].terminationConfirmed,true);
  assert.equal(report.terminationConfirmed,true);
});

test('可信业务替身附加字段不会误拒，数据库命令与runtime分开计量并绑定版本', async t => {
  const {report}=await mocked(t,'valid-extra-fields');
  assert.equal(report.status,'passed',JSON.stringify(report.checks.filter(check=>!check.passed)));
  assert.equal(report.checks.length,webManifest.count);
  assert.equal(report.databaseCommands.length,2);
  assert.equal(report.processes.length,2);
  assert.deepEqual(report.databasePreflights,[]);
  for(const command of report.databaseCommands){assert.equal(command.kind,'database_observation');assert.equal(command.runnerHash,databaseObserverHash);assert.equal(command.sourceHash,report.sourceHash);assert.equal(command.exitCode,0);assert.equal(command.terminationConfirmed,true);assert.equal(command.stopReason,null);assert.equal(command.truncated,false);assert.equal('stopAcknowledged' in command,false);}
  assert.equal(report.terminationConfirmed,true);
});

test('错误初始书名即使库存正确也拒绝', async t => {
  const {report}=await mocked(t,'valid-wrong-title');complete(report);
  assert.equal(report.checks.find(check=>check.id==='WEB-005').passed,false);
});

test('数据库命令或预检停止未确认时保留真实记录且不再启动下一轮', async t=>{
  const command=(await mocked(t,'valid-database-unconfirmed')).report;complete(command);
  assert.equal(command.status,'reconciliation_required');assert.equal(command.terminationConfirmed,false);assert.equal(command.databaseCommands.length,1);assert.equal(command.processes.length,1);
  const preflight=(await mocked(t,'valid-preflight-unconfirmed')).report;complete(preflight);
  assert.equal(preflight.status,'reconciliation_required');assert.equal(preflight.terminationConfirmed,false);assert.equal(preflight.databaseCommands.length,0);assert.equal(preflight.processes.length,1);
  assert.equal(preflight.databasePreflights.length,1);const record=preflight.databasePreflights[0];
  assert.equal(record.pid,12345);assert.equal(record.startedAt,'mock-preflight');assert.equal(record.probeDirectory,'retained-probe');assert.equal(record.controlDirectory,'retained-control');assert.equal(record.kind,'database_preflight');assert.equal(record.sourceHash,preflight.sourceHash);assert.equal('result'in record,false);
});

const real = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 45_000 };
test('真实MXC运行错误业务候选：500/候选marker不能冒充Web业务验收', real, async t => {
  const partial = files.map(file => file.path === 'src/app.mjs' ? { path: file.path, content: 'import {DatabaseSync} from "node:sqlite";export async function createApp({databasePath}){const db=new DatabaseSync(databasePath);db.exec("CREATE TABLE books(id TEXT,title TEXT,copies INTEGER);CREATE TABLE loans(id TEXT,book_id TEXT,user_id TEXT,status TEXT);CREATE TABLE audit_events(action TEXT,actor_id TEXT,target_id TEXT,at TEXT);");return {handle(){return {status:500,headers:{"content-type":"application/json"},body:"{}"}},close(){db.close()}}}' } : file);
  const report = await runWebTests({ rootDir: await root(t), files: partial, timeoutMs: 30_000 });
  complete(report);
  assert.equal(report.checks[1].passed, true);
  assert.equal(report.checks[2].passed, false);
  assert.equal(report.status, 'failed');
  assert.equal(report.processes.length, 1);
  assert.equal(report.terminationConfirmed, true);
  assert.equal(report.databaseCommands.length,1);
  assert.ok(Number.isInteger(report.databaseCommands[0].pid) && report.databaseCommands[0].pid>0);
  assert.equal(report.databaseCommands[0].exitCode,0,JSON.stringify(report.databaseCommands[0]));
  assert.equal(report.databaseCommands[0].runnerHash,databaseObserverHash);
});

test('真实MXC观察调用开始后80ms可取消且进程停止得到确认', real, async t=>{
  const {report,observationStarting,heartbeatBeforeAbort,cancelledObservation}=await mocked(t,'db-slow-mxc');complete(report);
  assert.equal(report.status,'cancelled');assert.equal(report.databaseCommands.length,1);
  const command=report.databaseCommands[0];assert.equal(command.stopReason,'cancelled');assert.equal(command.terminationConfirmed,true);assert.ok(command.pid>0);assert.equal(command.runnerHash,databaseObserverHash);assert.equal(command.sourceHash,report.sourceHash);
  assert.equal(report.terminationConfirmed,true);assert.equal(observationStarting,true);assert.equal(heartbeatBeforeAbort,true);assert.equal(cancelledObservation,true);
});

test('真实MXC观察拒绝带注释的FTS虚拟表，SQLite对象类型不可用SQL文本伪装', real, async t=>{
  const {report}=await mocked(t,'db-commented-virtual-mxc');complete(report);
  assert.equal(report.databaseCommands.length,1);const command=report.databaseCommands[0];
  assert.ok(command.pid>0);assert.equal(command.terminationConfirmed,true);assert.equal(command.stopReason,null);assert.equal(command.exitCode,1);
  assert.equal(JSON.parse(command.stdout).code,'invalid_table');assert.equal(JSON.parse(command.stdout).phase,'schema');
});
