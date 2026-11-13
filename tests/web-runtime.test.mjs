import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startWebRuntime } from '../lib/web-runtime.mjs';
import { decodeWebResponse, filterWebRequestHeaders, filterWebResponseHeaders, MAX_WEB_BODY, normalizeWebRequest, WEB_CSP, WebLineDecoder } from '../lib/web-protocol.mjs';

async function fixture(t, source = 'export async function createApp(){throw new Error("not run by ordinary tests")}') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskflow-web-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'app.mjs'), source);
  return { root, workspace };
}

const real = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 40_000 };
const options = workspace => ({ workspace, timeoutMs: 20_000, requestTimeoutMs: 5000 });
function call(runtime, method, pathname, { headers = {}, body = '', host, origin } = {}) {
  const url = new URL(runtime.url);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: url.port, method, path: pathname,
      headers: { host: host ?? url.host, ...(origin ? { origin } : {}), ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('test HTTP timeout'))); request.end(body);
  });
}

test('web requests permit only local paths, known methods and bounded UTF-8 text', () => {
  assert.deepEqual(normalizeWebRequest({ method: 'POST', path: '/api/echo?x=1', body: '中文' }), {
    method: 'POST', path: '/api/echo?x=1', body: '中文', headers: {},
  });
  for (const value of ['https://example.com/x', '//example.com/x', '/\\example.com', '/a\r\nb', '/x#fragment']) {
    assert.throws(() => normalizeWebRequest({ method: 'GET', path: value }), { code: 'invalid_path' });
  }
  assert.throws(() => normalizeWebRequest({ method: 'CONNECT', path: '/' }), { code: 'invalid_method' });
  assert.throws(() => normalizeWebRequest({ method: 'GET', path: '/', body: 'x' }), { code: 'invalid_body' });
  assert.throws(() => normalizeWebRequest({ method: 'POST', path: '/', body: 'x'.repeat(MAX_WEB_BODY + 1) }), { code: 'body_limit' });
});

test('web request filtering drops platform credentials and unrelated headers', () => {
  assert.deepEqual(filterWebRequestHeaders({ 'Content-Type': 'application/json', accept: '*/*', authorization: 'secret',
    'x-platform-token': 'secret', cookie: 'session=platform; app_session=own; token=platform; app_theme=light' }), {
    'content-type': 'application/json', accept: '*/*', cookie: 'app_session=own; app_theme=light',
  });
  assert.throws(() => filterWebRequestHeaders({ accept: '*/*\r\nInjected: x' }), { code: 'invalid_headers' });
  assert.throws(() => filterWebRequestHeaders({ Accept: 'a', accept: 'b' }), { code: 'invalid_headers' });
});

test('web response filtering pins policy and rejects redirects, cookies and header injection', () => {
  assert.deepEqual(filterWebResponseHeaders({ 'content-type': 'text/html', location: '/login',
    'set-cookie': ['app_session=abc; HttpOnly; Path=/; SameSite=Strict'], 'content-security-policy': 'unsafe',
    'access-control-allow-origin': '*', 'x-platform-token': 'ignored' }), {
    'content-type': 'text/html', location: '/login', 'set-cookie': ['app_session=abc; HttpOnly; Path=/; SameSite=Strict'],
  });
  for (const location of ['https://example.com', '//example.com', '/\\example.com', '/a\r\nb']) {
    assert.throws(() => filterWebResponseHeaders({ location }));
  }
  for (const value of ['session=platform; HttpOnly', 'app_session=abc', 'app_session=abc; HttpOnly; Domain=localhost']) {
    assert.throws(() => filterWebResponseHeaders({ 'set-cookie': value }));
  }
  assert.match(WEB_CSP, /script-src 'self'/u); assert.match(WEB_CSP, /connect-src 'self'/u);
  assert.doesNotMatch(WEB_CSP, /unsafe-inline|unsafe-eval|https:/u);
});

test('web protocol decoder handles split UTF-8 frames and rejects malformed or oversized output', () => {
  const messages = []; const decoder = new WebLineDecoder(message => messages.push(message));
  const buffer = Buffer.from('{"type":"例子"}\n{"type":"ready"}\n');
  for (const byte of buffer) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(messages, [{ type: '例子' }, { type: 'ready' }]);
  for (const bytes of [Buffer.from('not JSON\n'), Buffer.from('null\n'), Buffer.from('\n'), Buffer.from([0xff, 10])]) {
    assert.throws(() => new WebLineDecoder(() => {}).push(bytes), { code: 'protocol_error' });
  }
  assert.throws(() => new WebLineDecoder(() => {}, 4).push(Buffer.from('12345')), { code: 'protocol_error' });
  const partial = new WebLineDecoder(() => {}); partial.push(Buffer.from('{')); assert.throws(() => partial.end(), { code: 'protocol_error' });
});

test('web response envelopes require canonical bounded bytes and valid HTTP status', () => {
  const response = decodeWebResponse({ status: 200, headers: { 'content-type': 'application/octet-stream' }, bodyBase64: Buffer.from([0, 255]).toString('base64') });
  assert.deepEqual(response.body, Buffer.from([0, 255]));
  for (const value of [
    { status: 101, headers: {}, bodyBase64: '' }, { status: 200, headers: {}, bodyBase64: 'Zg' },
    { status: 200, headers: {}, bodyBase64: 'Zh==' }, { status: 204, headers: {}, bodyBase64: 'eA==' },
    { status: 200, headers: {}, bodyBase64: '', passed: true },
  ]) assert.throws(() => decodeWebResponse(value), { code: 'invalid_response' });
});

test('web runtime rejects missing isolation and invalid configuration before launching code', async t => {
  const { workspace } = await fixture(t);
  await assert.rejects(startWebRuntime({ workspace, executable: '' }), { code: 'invalid_executable' });
  await assert.rejects(startWebRuntime({ workspace: '.', executable: process.execPath }), { code: 'invalid_workspace' });
  for (const invalid of [{ timeoutMs: 0 }, { requestTimeoutMs: 0 }, { maxOutputBytes: 0 }]) {
    await assert.rejects(startWebRuntime({ workspace, executable: process.execPath, ...invalid }), { code: 'invalid_budget' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startWebRuntime({ workspace, executable: process.execPath, signal: controller.signal }),
    process.platform === 'win32' ? { code: 'cancelled' } : { code: 'unsupported_environment' });
});

test('web runtime rejects linked workspaces and candidate-supplied workers before launching', { skip: process.platform !== 'win32' }, async t => {
  const { root, workspace } = await fixture(t);
  const linked = path.join(root, 'linked'); await symlink(workspace, linked, 'junction');
  await assert.rejects(startWebRuntime({ workspace: linked, executable: process.execPath }), { code: 'invalid_workspace' });
  await mkdir(path.join(workspace, '.platform')); await writeFile(path.join(workspace, '.platform', 'web-worker.cjs'), 'untrusted');
  await assert.rejects(startWebRuntime({ workspace, executable: process.execPath }), { code: 'invalid_worker' });
});

const echoSource = `import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
export async function createApp({databasePath}) {
 const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE IF NOT EXISTS messages(value TEXT NOT NULL)');
 return {async handle(req){
  if(req.path==='/write-source'){let denied=false;try{writeFileSync('src/app.mjs','changed')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}return {status:200,body:JSON.stringify({denied})};}
  if(req.method==='POST'){db.prepare('INSERT INTO messages(value) VALUES(?)').run(req.body);return {status:201,headers:{'content-type':'text/plain'},body:req.body};}
  return {status:200,headers:{'content-type':'application/json','content-security-policy':'unsafe','access-control-allow-origin':'*','set-cookie':'app_echo=ok; HttpOnly; Path=/'},body:JSON.stringify({rows:db.prepare('SELECT value FROM messages').all(),headers:req.headers})};
 },close(){db.close()}};
}`;

test('real web runtime proxies HTTP, preserves stdin and SQLite across restart, filters credentials and stops', real, async t => {
  const { workspace } = await fixture(t, echoSource);
  let runtime = await startWebRuntime(options(workspace)); t.after(async () => { await runtime.stop(); });
  const post = await call(runtime, 'POST', '/echo', { body: 'first', headers: { 'content-type': 'text/plain' } });
  assert.equal(post.status, 201); assert.equal(post.body, 'first');
  assert.match(post.headers['content-security-policy'], /script-src 'self'/u);
  await new Promise(resolve => setTimeout(resolve, 100));
  const observed = await runtime.request({ method: 'GET', path: '/messages', headers: { cookie: 'session=secret; app_echo=ok', authorization: 'secret', 'x-platform-token': 'secret' } });
  assert.deepEqual(JSON.parse(observed.body).headers, { cookie: 'app_echo=ok' });
  assert.equal(JSON.parse(observed.body).rows.length, 1);
  assert.equal(observed.headers['content-security-policy'], undefined);
  const httpGet = await call(runtime, 'GET', '/messages');
  assert.equal(httpGet.headers['access-control-allow-origin'], undefined);
  assert.equal(httpGet.headers['x-content-type-options'], 'nosniff'); assert.match(httpGet.headers['set-cookie'][0], /^tf_[a-f0-9]{48}_app_echo=/u);
  assert.equal((await call(runtime, 'GET', '/', { host: 'attacker.example' })).status, 403);
  assert.equal((await call(runtime, 'POST', '/', { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call(runtime, 'GET', '/messages', { origin: runtime.url })).status, 200);
  assert.equal((await call(runtime, 'POST', '/', { body: 'x'.repeat(MAX_WEB_BODY + 1) })).status, 413);
  assert.equal((await call(runtime, 'POST', '/', { headers: { 'transfer-encoding': 'chunked' } })).status, 400);
  assert.equal(JSON.parse((await runtime.request({ method: 'GET', path: '/write-source' })).body).denied, true);
  const firstDone = await runtime.stop(); assert.equal(firstDone.status, 'stopped'); assert.equal(firstDone.terminationConfirmed, true);
  assert.equal(firstDone.sourceUnchanged, true); assert.equal(await runtime.done, firstDone); assert.equal(await runtime.stop(), firstDone);
  assert.equal(await readFile(path.join(workspace, 'src', 'app.mjs'), 'utf8'), echoSource);
  await assert.rejects(call(runtime, 'GET', '/messages'));
  runtime = await startWebRuntime(options(workspace));
  assert.deepEqual(JSON.parse((await runtime.request({ method: 'GET', path: '/messages' })).body).rows, [{ value: 'first' }]);
  assert.equal((await runtime.stop()).terminationConfirmed, true);
});

test('real web runtime rejects unsolicited output and does not publish a response', real, async t => {
  const { workspace } = await fixture(t, `export async function createApp(){return {handle(){process.stdout.write('not-json\\n');return {status:200,body:'forged'}}}}`);
  const runtime = await startWebRuntime(options(workspace)); t.after(() => runtime.stop());
  await assert.rejects(runtime.request({ method: 'GET', path: '/' }));
  const result = await runtime.done; assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'protocol_error'); assert.equal(result.terminationConfirmed, true);
});

test('real web runtime detects host-side source changes and invalidates responses', real, async t => {
  const { workspace } = await fixture(t, echoSource);
  const runtime = await startWebRuntime(options(workspace)); t.after(() => runtime.stop());
  await writeFile(path.join(workspace, 'src', 'app.mjs'), `${echoSource}\n// changed`);
  await assert.rejects(runtime.request({ method: 'GET', path: '/' }), { code: 'source_changed' });
  const result = await runtime.done; assert.equal(result.status, 'failed'); assert.equal(result.sourceUnchanged, false); assert.equal(result.terminationConfirmed, true);
});

test('real web runtime bounds its queue and kills hung requests with confirmed termination', real, async t => {
  const { workspace } = await fixture(t, `export async function createApp(){return {async handle(){await new Promise(()=>{})}}}`);
  const runtime = await startWebRuntime({ ...options(workspace), requestTimeoutMs: 1500 }); t.after(() => runtime.stop());
  const requests = Array.from({ length: 32 }, () => runtime.request({ method: 'GET', path: '/' }));
  const settled = Promise.allSettled(requests);
  await assert.rejects(runtime.request({ method: 'GET', path: '/' }), { code: 'queue_limit' });
  const result = await runtime.done;
  assert.equal(result.status, 'timed_out'); assert.equal(result.stopReason, 'request_timeout'); assert.equal(result.terminationConfirmed, true);
  assert.ok((await settled).every(item => item.status === 'rejected'));
});

test('real web runtime obeys external cancellation and the total deadline', real, async t => {
  const { workspace } = await fixture(t, echoSource);
  const controller = new AbortController();
  const runtime = await startWebRuntime({ ...options(workspace), signal: controller.signal }); t.after(() => runtime.stop());
  controller.abort(); const stopped = await runtime.done;
  assert.equal(stopped.stopReason, 'cancelled'); assert.equal(stopped.terminationConfirmed, true);
  const next = await startWebRuntime({ ...options(workspace), timeoutMs: 1500 }); t.after(() => next.stop());
  const deadline = await next.done; assert.equal(deadline.status, 'timed_out'); assert.equal(deadline.stopReason, 'timed_out'); assert.equal(deadline.terminationConfirmed, true);
});

test('real startup cancellation before spawn, after spawn and during proxy listen always settles', real, async t => {
  for (const checkpoint of ['prepared', 'started', 'proxy_preparing', 'ready']) {
    const { workspace } = await fixture(t, echoSource);
    const controller = new AbortController(), events = [];
    let timer;
    try {
      await assert.rejects(Promise.race([
        startWebRuntime({ ...options(workspace), signal: controller.signal, onEvent(event) {
          events.push(event);
          if (event.type === checkpoint) {
            if (checkpoint === 'proxy_preparing') queueMicrotask(() => controller.abort());
            else controller.abort();
          }
        } }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('startup cancellation did not settle')), 8000); }),
      ]), cause => {
        assert.equal(cause.result?.stopReason, 'cancelled');
        assert.equal(cause.result.terminationConfirmed, true);
        assert.equal(cause.result.controlDirectory, null);
        assert.equal(cause.result.status, 'stopped');
        assert.equal(cause.result.sourceUnchanged, true);
        if (checkpoint === 'prepared') assert.equal(cause.result.pid, null);
        else assert.ok(Number.isInteger(cause.result.pid));
        return true;
      });
      assert.ok(events.some(event => event.type === checkpoint));
      if (checkpoint === 'prepared') assert.equal(events.some(event => event.type === 'started'), false);
      assert.equal(events.filter(event => event.type === 'closed').length, 1);
    } finally { clearTimeout(timer); controller.abort(); }
  }
});

test('real web runtime rejects unknown and duplicate response identities and bounded output', real, async t => {
  const sources = [
    [`export async function createApp(){return {handle(){process.stdout.write(JSON.stringify({type:'response',id:'unknown',response:{status:200,headers:{},bodyBase64:''}})+'\\n');return {status:200,body:'unsafe'}}}}`, 'protocol_error'],
    [`let id;process.stdin.on('data',chunk=>{try{id=JSON.parse(chunk).id}catch{}});export async function createApp(){return {handle(){const line=JSON.stringify({type:'response',id,response:{status:200,headers:{},bodyBase64:''}})+'\\n';process.stdout.write(line+line);return new Promise(()=>{})}}}`, 'protocol_error'],
    [`export async function createApp(){return {handle(){process.stderr.write('x'.repeat(8192));return {status:200,body:'unsafe'}}}}`, 'output_limit'],
  ];
  for (const [source, code] of sources) {
    const { workspace } = await fixture(t, source);
    const runtime = await startWebRuntime({ ...options(workspace), maxOutputBytes: 4096 });
    t.after(() => runtime.stop());
    await assert.rejects(runtime.request({ method: 'GET', path: '/' }));
    const result = await runtime.done; assert.equal(result.errorCode, code); assert.equal(result.status, 'failed'); assert.equal(result.terminationConfirmed, true);
    assert.ok(Buffer.byteLength(result.stderr) <= 4096);
  }
});

test('real web runtime stop also ends a detached descendant heartbeat', real, async t => {
  const { workspace } = await fixture(t, `import {spawn} from 'node:child_process';import path from 'node:path';
export async function createApp({databasePath}){const file=path.join(path.dirname(databasePath),'heartbeat');const script='const fs=require("node:fs");setInterval(()=>fs.appendFileSync('+JSON.stringify(file)+',"x"),25)';const child=spawn(process.execPath,['-e',script],{stdio:'ignore',windowsHide:true,detached:true});child.unref();return {handle(){return {status:200,body:JSON.stringify({pid:child.pid})}}}}`);
  const runtime = await startWebRuntime(options(workspace)); t.after(() => runtime.stop());
  const descendant = JSON.parse((await runtime.request({ method: 'GET', path: '/' })).body).pid;
  t.after(async () => {
    // The PID came from this exclusively owned probe. This cleanup also covers a failed assertion.
    if (!Number.isInteger(descendant)) return;
    const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(descendant), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    await new Promise(resolve => { killer.on('close', resolve); killer.on('error', resolve); });
  });
  const heartbeat = path.join(workspace, '.platform', 'tmp', 'heartbeat');
  let before = '';
  for (let attempt = 0; attempt < 30 && !before; attempt++) {
    try { before = await readFile(heartbeat, 'utf8'); } catch {}
    if (!before) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(before.length, 'descendant actually started');
  const result = await runtime.stop(); assert.equal(result.terminationConfirmed, true);
  const stopped = await readFile(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'no descendant writes after confirmed stop');
});

test('real simultaneous previews isolate browser cookies across localhost ports and restarts', real, async t => {
  const source = `export async function createApp(){return {handle(req){
 if(req.path==='/login')return {status:200,headers:{'set-cookie':'app_session='+req.body+'; HttpOnly; Path=/; SameSite=Strict'},body:'ok'};
 return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify({cookie:req.headers.cookie??null,headers:req.headers})};
}}}`;
  const first = await fixture(t, source), second = await fixture(t, source);
  let [a, b] = await Promise.all([startWebRuntime(options(first.workspace)), startWebRuntime(options(second.workspace))]);
  t.after(async () => { await Promise.all([a.stop(), b.stop()]); });
  const loginA = await call(a, 'POST', '/login', { body: 'A' });
  const loginB = await call(b, 'POST', '/login', { body: 'B' });
  assert.equal(loginA.status, 200); assert.equal(loginB.status, 200);
  const cookieA = loginA.headers['set-cookie'][0].split(';')[0];
  const cookieB = loginB.headers['set-cookie'][0].split(';')[0];
  assert.match(cookieA, /^tf_[a-f0-9]{48}_app_session=A$/u);
  assert.match(cookieB, /^tf_[a-f0-9]{48}_app_session=B$/u);
  assert.notEqual(cookieA.split('=')[0], cookieB.split('=')[0]);
  assert.match(loginA.headers['set-cookie'][0], /; HttpOnly;/u);
  assert.doesNotMatch(loginA.headers['set-cookie'][0], /Domain=/iu);
  const observe = async (runtime, cookie) => JSON.parse((await call(runtime, 'GET', '/who', {
    headers: { cookie, authorization: 'platform-secret', 'x-platform-token': 'platform-secret' },
  })).body);
  assert.deepEqual((await observe(a, cookieA)).headers, { cookie: 'app_session=A' });
  assert.equal((await observe(b, cookieA)).cookie, null);
  assert.equal((await observe(a, cookieB)).cookie, null);
  const combined = `${cookieA}; ${cookieB}; session=platform-secret; app_session=unscoped-secret`;
  assert.deepEqual((await observe(a, combined)).headers, { cookie: 'app_session=A' });
  assert.deepEqual((await observe(b, combined)).headers, { cookie: 'app_session=B' });
  const trusted = await a.request({ method: 'GET', path: '/who', headers: { cookie: 'app_session=trusted; session=platform' } });
  assert.equal(JSON.parse(trusted.body).cookie, 'app_session=trusted');
  const trustedLogin = await a.request({ method: 'POST', path: '/login', body: 'trusted' });
  assert.equal(trustedLogin.headers['set-cookie'][0], 'app_session=trusted; HttpOnly; Path=/; SameSite=Strict');
  assert.equal((await a.stop()).terminationConfirmed, true);
  a = await startWebRuntime(options(first.workspace));
  assert.equal((await observe(a, combined)).cookie, null, 'a restarted preview requires a fresh browser login');
  assert.equal((await observe(b, combined)).cookie, 'app_session=B', 'the other live preview is unaffected');
  const nextCookie = (await call(a, 'POST', '/login', { body: 'A2' })).headers['set-cookie'][0].split(';')[0];
  assert.notEqual(nextCookie.split('=')[0], cookieA.split('=')[0]);
  assert.equal((await observe(a, nextCookie)).cookie, 'app_session=A2');
  assert.ok((await Promise.all([a.stop(), b.stop()])).every(result => result.terminationConfirmed));
});
