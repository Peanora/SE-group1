import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserManifest, createWebBrowserTestService, runWebBrowserTests } from '../lib/web-browser-tests.mjs';
import { webProfile } from '../lib/web-profile.mjs';
import { validateProjectFiles, readProjectFiles } from '../lib/project-files.mjs';
import { startWebRuntime } from '../lib/web-runtime.mjs';

const files = [{ path: 'src/app.mjs', content: 'export async function createApp(){throw new Error("ordinary tests never execute this")}\n' }];
const hash = value => createHash('sha256').update(value).digest('hex');
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-verifier-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function completeness(report) {
  assert.equal(report.checks.length, browserManifest.count);
  assert.deepEqual(report.checks.map(({ id, name }) => ({ id, name })), browserManifest.checks);
  assert.ok(report.checks.every(item => typeof item.passed === 'boolean'));
  assert.equal(report.manifestHash, browserManifest.hash);
  assert.equal(report.profileId, webProfile.id);
}

// These adapters only exercise infrastructure failure and cleanup. They never emulate a working business application.
function adapters({ launchError = false, unconfirmed = false, sourceChanged = false, runtimeExitCode = 0, runtimeStopAcknowledged = true, browserExitCode = 0, afterLaunch, onGoto } = {}) {
  const observed = { launched: 0, closed: 0, started: [], stopped: 0, contexts: [], requests: 0 };
  let connected = true;
  const session = {
    version: 'trusted-mock-engine',
    browser: {
      isConnected: () => connected,
      async newContext(options) {
        const handlers = new Map(), pageHandlers = new Map(), cdpHandlers = new Map();
        const context = {
          options, routeHandler: null, socketHandler: null, closed: false, cdpDetached: false, cdpHandlers,
          setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
          async route(_pattern, handler) { this.routeHandler = handler; },
          async routeWebSocket(_pattern, handler) { this.socketHandler = handler; },
          on(name, handler) { handlers.set(name, handler); },
          async newCDPSession() { return { on: (name, handler) => cdpHandlers.set(name, handler),
            off: name => cdpHandlers.delete(name), send: async () => ({}), detach: async () => { context.cdpDetached = true; } }; },
          async newPage() {
            const page = { on: (name, handler) => pageHandlers.set(name, handler),
              async goto() { await onGoto?.({ context, pageHandlers, cdpHandlers, origin: `http://localhost:${43000 + observed.started.length}` }); },
              getByTestId: () => ({ count: async () => 0 }),
              async close() {},
            };
            handlers.get('page')?.(page); return page;
          },
          async close() { this.closed = true; },
        };
        observed.contexts.push(context); return context;
      },
    },
    async close() {
      observed.closed++; connected = false;
      return { kind: 'browser', pid: 42, status: 'stopped', exitCode: browserExitCode, terminationConfirmed: true };
    },
  };
  const launchBrowser = async () => {
    observed.launched++;
    if (launchError) throw new Error('private provider or process details must not appear');
    afterLaunch?.(); return session;
  };
  const startRuntime = async options => {
    observed.started.push(options);
    const record = { pid: 100 + observed.started.length, status: sourceChanged ? 'failed' : 'stopped', exitCode: runtimeExitCode,
      stopAcknowledged: runtimeStopAcknowledged, terminationConfirmed: !unconfirmed, sourceUnchanged: !sourceChanged };
    return { url: `http://localhost:${43000 + observed.started.length}`, request: async () => { observed.requests++; throw new Error('Missing UI must never reach business APIs'); },
      async stop() { observed.stopped++; return record; } };
  };
  return { observed, service: createWebBrowserTestService({ launchBrowser, startRuntime }) };
}

test('browser manifest is frozen, version bound to trusted source and profile, and distinct from HTTP checks', () => {
  assert.ok(Object.isFrozen(browserManifest) && Object.isFrozen(browserManifest.checks));
  assert.ok(browserManifest.checks.every(Object.isFrozen));
  assert.equal(browserManifest.count, 21);
  assert.equal(new Set(browserManifest.checks.map(item => item.id)).size, browserManifest.count);
  assert.ok(browserManifest.checks.every(item => item.id.startsWith('BROWSER-')));
  assert.match(browserManifest.hash, /^[a-f0-9]{64}$/u);
  assert.notEqual(hash(readFileSync(new URL('../lib/web-browser-tests.mjs', import.meta.url))), browserManifest.hash);
  assert.ok(readFileSync(new URL('../lib/web-browser-tests.mjs', import.meta.url), 'utf8').includes('task: webProfile.task'));
});

test('cancel before launch and malformed proposals never launch a browser or candidate', async t => {
  const rootDir = await setup(t), { service, observed } = adapters();
  const controller = new AbortController(); controller.abort('private cancellation reason');
  const cancelled = await service({ rootDir, files, signal: controller.signal });
  completeness(cancelled); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.terminationConfirmed, true);
  assert.ok(cancelled.checks.every(item => item.passed === false));
  assert.ok(!cancelled.error.includes('private'));
  for (const input of [{ files: [{ path: '../secret.txt', content: 'private' }] }, { timeoutMs: 0 }, { rootDir: '.' }]) {
    const rejected = await service({ rootDir, files, ...input });
    completeness(rejected); assert.equal(rejected.status, 'error');
  }
  assert.equal(observed.launched, 0); assert.equal(observed.started.length, 0);
  assert.deepEqual(await readdir(rootDir), []);
});

test('invalid cancellation signals return complete error reports without a cleanup TypeError', async t => {
  const rootDir = await setup(t), { service, observed } = adapters();
  for (const signal of [{}, { aborted: false }, null, 'invalid-signal', 0]) {
    const report = await service({ rootDir, files, signal });
    completeness(report); assert.equal(report.status, 'error');
    assert.equal(report.checks.length, 21); assert.ok(report.checks.every(item => item.passed === false));
    assert.match(report.error, /取消信号无效/u);
    assert.equal(report.terminationConfirmed, true); assert.equal(report.browser.closed, true);
    assert.deepEqual(report.processes, []);
  }
  assert.equal(observed.launched, 0); assert.equal(observed.started.length, 0);
  assert.deepEqual(await readdir(rootDir), []);
});

test('fresh desktop/mobile snapshots do not accept incomplete UI or outside passed declarations', async t => {
  const rootDir = await setup(t), { service, observed } = adapters();
  const report = await service({ rootDir, files, status: 'passed', checks: [{ passed: true }] });
  completeness(report); assert.equal(report.status, 'failed');
  assert.equal(observed.launched, 1); assert.equal(observed.closed, 1);
  assert.equal(observed.started.length, 2); assert.equal(observed.stopped, 2); assert.equal(observed.requests, 0);
  assert.notEqual(observed.started[0].workspace, observed.started[1].workspace);
  assert.deepEqual(await readProjectFiles(observed.started[0].workspace), validateProjectFiles(files));
  assert.deepEqual(await readProjectFiles(observed.started[1].workspace), validateProjectFiles(files));
  assert.equal(report.sourceHash, hash(JSON.stringify(validateProjectFiles(files))));
  assert.equal(report.processes.length, 3); assert.equal(report.terminationConfirmed, true); assert.equal(report.browser.closed, true);
  assert.equal(report.checks.find(item => item.id === 'BROWSER-CLOSE').passed, true, 'normal process cleanup is distinct from failed UI business checks');
  assert.ok(report.checks.filter(item => /LOGIN|BORROW|RETURN|LOGOUT|ADMIN|AUDIT|LAYOUT/u.test(item.id)).every(item => item.passed === false));
  assert.ok(observed.contexts.every(item => item.closed && item.options.serviceWorkers === 'block' && item.options.acceptDownloads === false));
  assert.deepEqual(observed.contexts.map(item => item.options.viewport), [{ width: 1365, height: 900 }, { width: 390, height: 844 }]);
});

test('a missing browser is an explicit error, never a skipped or passed business report', async t => {
  const rootDir = await setup(t), { service, observed } = adapters({ launchError: true });
  const report = await service({ rootDir, files });
  completeness(report); assert.equal(report.status, 'error'); assert.equal(observed.started.length, 0);
  assert.equal(report.checks.find(item => item.id === 'BROWSER-ENGINE').passed, false);
  assert.ok(!report.error.includes('private')); assert.ok(report.checks.every(item => !('skipped' in item)));
});

test('external requests, websockets and downloads are denied and recorded without opening a network target', async t => {
  const rootDir = await setup(t);
  let aborted = 0, continued = 0, socketClosed = 0, downloadCancelled = 0;
  const { service } = adapters({ onGoto: async ({ context, pageHandlers }) => {
    for (const url of ['https://remote.invalid/secret', 'http://localhost:49999/other-app', 'file:///C:/secret']) {
      await context.routeHandler({ request: () => ({ url: () => url }), abort: async () => { aborted++; }, continue: async () => { continued++; } });
    }
    await context.socketHandler({ url: () => 'ws://localhost:43001/socket', close: async () => { socketClosed++; } });
    pageHandlers.get('download')({ cancel: async () => { downloadCancelled++; } });
  } });
  const report = await service({ rootDir, files });
  completeness(report); assert.equal(report.status, 'failed');
  assert.equal(aborted, 6); assert.equal(continued, 0); assert.equal(socketClosed, 2); assert.equal(downloadCancelled, 2);
  assert.equal(report.browser.blocked.length, 10);
  assert.ok(report.checks.filter(item => item.id.endsWith('-NETWORK')).every(item => item.passed === false));
});

test('console/page errors remain evidence and fail their fixed checks', async t => {
  const rootDir = await setup(t);
  const { service } = adapters({ onGoto: async ({ pageHandlers }) => {
    pageHandlers.get('console')({ type: () => 'error', text: () => 'bounded ' + 'x'.repeat(5000) });
    pageHandlers.get('pageerror')(new Error('candidate page failed'));
  } });
  const report = await service({ rootDir, files });
  completeness(report); assert.equal(report.browser.console.length, 2); assert.equal(report.browser.pageErrors.length, 2);
  assert.ok(report.browser.console.every(item => item.text.length <= 1000));
  assert.ok(report.checks.filter(item => item.id.endsWith('-CONSOLE')).every(item => item.passed === false));
});

const native401Text = 'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
// Trusted transport events only; these adapters still have no business controls, cookies, records or database.
function diagnosticEvents({ origin, cdpHandlers, pageHandlers }, options = {}) {
  const emit = (name, event) => cdpHandlers.get(name)?.(event);
  const url = `${origin}${options.path || '/api/me'}`, status = options.status ?? 401;
  const logUrl = options.logOrigin || (options.logPath ? `${origin}${options.logPath}` : url);
  const nativeText = `Failed to load resource: the server responded with a status of ${status} (${status === 401 ? 'Unauthorized' : 'Forbidden'})`;
  const login = () => {
    const loginUrl = `${origin}${options.loginPath || '/api/login'}`;
    emit('Network.requestWillBeSent', { requestId: 'login', type: 'XHR', timestamp: 3, request: { method: 'POST', url: loginUrl } });
    emit('Network.responseReceived', { requestId: 'login', type: 'XHR', timestamp: 4, response: { status: 200, url: loginUrl } });
  };
  if (options.afterLogin) login();
  for (let i = 0; i < (options.repeat || 1); i++) {
    const requestId = `probe-${i}`, time = options.afterLogin ? 5 : 1;
    emit('Network.requestWillBeSent', { requestId, type: options.type || 'Fetch', timestamp: time, request: { method: options.method || 'GET', url } });
    if (!options.noResponse) emit('Network.responseReceived', { requestId, type: options.type || 'Fetch', timestamp: time + 1, response: { status, url } });
    // Arrival can be later than login, while the correlated HTTP request/response were earlier.
    if (options.lateLog) login();
    if (!options.noCDP) emit('Log.entryAdded', { entry: { source: options.source || 'network', level: 'error', text: nativeText, url: logUrl,
      lineNumber: options.lineNumber ?? 0, networkRequestId: options.wrongId ? 'unrelated-request' : requestId } });
    pageHandlers.get('console')({ type: () => 'error', text: () => nativeText, args: () => [], location: () => ({ url: options.wrongLocation ? url + '?mismatch' : logUrl, lineNumber: options.wrongLine ? 999 : options.lineNumber ?? 0, columnNumber: 0 }) });
  }
  if (options.explicit) pageHandlers.get('console')({ type: () => 'error', text: () => nativeText,
    args: () => [{}], location: () => ({ url, lineNumber: 0, columnNumber: 0 }) });
}

test('only one request/response/CDP/zero-argument console match is classified, including a late native log', async t => {
  const rootDir = await setup(t);
  for (const options of [{}, { type: 'XHR', logPath: '/fixture.js', lineNumber: 23 }, { lateLog: true }]) {
    const { service, observed } = adapters({ onGoto: events => diagnosticEvents(events, options) });
    const report = await service({ rootDir, files }); completeness(report);
    assert.equal(report.status, 'failed', 'the incomplete fixture never passes business acceptance');
    assert.equal(report.browser.expectedDiagnostics.length, 2);
    assert.equal(report.browser.console.length, 2);
    assert.ok(report.browser.console.every(item => item.text === native401Text && item.expectedDiagnostic && item.argsCount === 0));
    assert.ok(report.checks.filter(item => item.id.endsWith('-CONSOLE')).every(item => item.passed));
    assert.ok(observed.contexts.every(item => item.cdpDetached && item.cdpHandlers.size === 0));
    assert.equal(report.terminationConfirmed, true);
  }
});

test('same text does not exempt explicit errors, repeated probes or incomplete/unrelated network proof', async t => {
  const rootDir = await setup(t);
  for (const options of [{ explicit: true }, { repeat: 2 }, { path: '/api/other' }, { status: 403 }, { status: 404 },
    { afterLogin: true }, { noCDP: true }, { wrongId: true }, { noResponse: true }, { type: 'Document' }, { method: 'POST' }, { source: 'javascript' },
    { logOrigin: 'https://remote.invalid/fixture.js' }, { wrongLocation: true }, { wrongLine: true }, { afterLogin: true, loginPath: '/api/login?cache=1' }]) {
    const { service, observed } = adapters({ onGoto: events => diagnosticEvents(events, options) });
    const report = await service({ rootDir, files }); completeness(report);
    assert.equal(report.status, 'failed');
    assert.ok(report.checks.filter(item => item.id.endsWith('-CONSOLE')).every(item => !item.passed), JSON.stringify(options));
    assert.equal(report.browser.expectedDiagnostics.length, options.explicit ? 2 : 0);
    assert.ok(observed.contexts.every(item => item.cdpDetached && item.cdpHandlers.size === 0));
  }
});

test('console, blocked and CDP metadata budgets fail closed and stop owned resources', async t => {
  const rootDir = await setup(t);
  for (const kind of ['console', 'blocked', 'cdp', 'bytes']) {
    const { service, observed } = adapters({ onGoto: async ({ pageHandlers, cdpHandlers, context }) => {
      for (let i = 0; i < (kind === 'bytes' ? 1 : 1100); i++) {
        if (kind === 'console' || kind === 'bytes') pageHandlers.get('console')({ type: () => 'log', text: () => kind === 'bytes' ? 'x'.repeat(300000) : 'event' });
        if (kind === 'cdp') cdpHandlers.get('Network.requestWillBeSent')?.({ requestId: `event-${i}`, type: 'Fetch', timestamp: i, request: { method: 'GET', url: 'http://localhost:43001/api/me' } });
        if (kind === 'blocked') await context.routeHandler({ request: () => ({ url: () => 'https://remote.invalid/' }), abort: async () => {}, continue: async () => {} });
      }
    } });
    const report = await service({ rootDir, files }); completeness(report);
    assert.equal(report.status, 'failed'); assert.equal(report.browser.diagnosticBudget.exceeded, true);
    assert.match(report.error, /预算已耗尽/u); assert.equal(report.terminationConfirmed, true);
    assert.ok(report.browser.diagnosticBudget.events <= report.browser.diagnosticBudget.maxEvents);
    assert.ok(report.browser.diagnosticBudget.bytes <= report.browser.diagnosticBudget.maxBytes);
    assert.ok(['console', 'blocked', 'networkDiagnostics', 'networkEvidence'].every(name => report.browser[name].length <= 100));
    assert.ok(observed.contexts.every(item => item.closed && item.cdpDetached && item.cdpHandlers.size === 0));
    assert.equal(observed.closed, 1); assert.ok(observed.stopped >= 1);
  }
});

test('late launch cancellation closes the browser and cannot start a candidate', async t => {
  const rootDir = await setup(t), controller = new AbortController();
  const { service, observed } = adapters({ afterLaunch: () => controller.abort() });
  const report = await service({ rootDir, files, signal: controller.signal });
  completeness(report); assert.equal(report.status, 'cancelled'); assert.equal(report.browser.closed, true);
  assert.equal(observed.closed, 1); assert.equal(observed.started.length, 0); assert.equal(report.terminationConfirmed, true);
  assert.ok(report.checks.every(item => item.id === 'BROWSER-SOURCE' || item.passed === false));
});

test('total time budget interrupts a hanging browser operation and still confirms owned process cleanup', async t => {
  const rootDir = await setup(t);
  const { service, observed } = adapters({ onGoto: () => new Promise(() => {}) });
  const report = await service({ rootDir, files, timeoutMs: 250 });
  completeness(report); assert.equal(report.status, 'timed_out');
  assert.equal(report.browser.closed, true); assert.equal(report.terminationConfirmed, true);
  assert.equal(observed.closed, 1); assert.ok(observed.stopped >= 1);
  assert.ok(report.checks.some(item => item.passed === false));
});

test('unconfirmed termination or source changes block the final gate', async t => {
  const rootDir = await setup(t);
  for (const options of [{ unconfirmed: true }, { sourceChanged: true }]) {
    const { service } = adapters(options), report = await service({ rootDir, files });
    completeness(report);
    assert.equal(report.status, options.unconfirmed ? 'reconciliation_required' : 'failed');
    assert.equal(report.checks.find(item => item.id === 'BROWSER-CLOSE').passed, false);
    if (options.unconfirmed) assert.equal(report.terminationConfirmed, false);
  }
});

test('confirmed but abnormal runtime or Edge exits cannot pass the close check', async t => {
  const rootDir = await setup(t);
  for (const options of [{ runtimeExitCode: 1 }, { runtimeStopAcknowledged: false }, { browserExitCode: 1 }]) {
    const { service } = adapters(options), report = await service({ rootDir, files });
    completeness(report); assert.equal(report.status, 'failed');
    assert.equal(report.terminationConfirmed, true); assert.equal(report.browser.closed, true);
    assert.equal(report.checks.find(item => item.id === 'BROWSER-CLOSE').passed, false);
  }
});

test('linked root directories are rejected without reading or launching candidate files', async t => {
  const root = await setup(t), actual = path.join(root, 'actual'), linked = path.join(root, 'linked');
  await mkdir(actual); await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const { service, observed } = adapters();
  const report = await service({ rootDir: linked, files });
  completeness(report); assert.equal(report.status, 'error'); assert.equal(observed.launched, 0);
  assert.deepEqual(await readdir(actual), []);
});

test('real headless Edge and MXC reject simple missing-business HTML, and cancellation confirms cleanup', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 60_000,
}, async t => {
  const rootDir = await setup(t);
  // Deliberately incomplete, trusted transport fixture. It contains no library business implementation.
  const incomplete = [{ path: 'src/app.mjs', content: `export async function createApp(){return {handle(){return {status:200,headers:{'content-type':'text/html'},body:'<!doctype html><html><head><title>Incomplete fixture</title></head><body><h1>Business not implemented</h1><form><label for="u">Username</label><input id="u" name="username" data-testid="login-username"><label for="p">Password</label><input id="p" name="password" type="password" data-testid="login-password"><button type="button" data-testid="login-submit">Login</button></form></body></html>'}}}}` }];
  const report = await runWebBrowserTests({ rootDir, files: incomplete, timeoutMs: 30_000 });
  completeness(report); assert.equal(report.status, 'failed');
  assert.equal(report.browser.closed, true); assert.ok(report.browser.version);
  t.diagnostic(`New headless Edge ${report.browser.version}; incomplete business fixture status=${report.status}; process records=${report.processes.length}`);
  assert.equal(report.terminationConfirmed, true); assert.equal(report.processes.length, 3);
  assert.ok(report.checks.filter(item => /-LOGIN$/u.test(item.id)).every(item => item.passed === false));
  assert.deepEqual(report.browser.layouts.map(item => item.width), [1365, 390], 'real isolated observers checked the labelled, focusable incomplete form in both viewports');
  assert.ok(report.processes.every(item => item.terminationConfirmed));
  assert.equal(report.checks.find(item => item.id === 'BROWSER-CLOSE').passed, true);
  const controller = new AbortController();
  const service = createWebBrowserTestService({ startRuntime: options => startWebRuntime({ ...options, onEvent(event) { if (event.type === 'prepared') controller.abort(); } }) });
  const cancelled = await service({ rootDir, files: incomplete, signal: controller.signal, timeoutMs: 25_000 });
  completeness(cancelled); assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.browser.closed, true); assert.equal(cancelled.terminationConfirmed, true);
  assert.ok(cancelled.processes.every(item => item.terminationConfirmed));
});

test('real candidate close hang is terminated but cannot pass BROWSER-CLOSE', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 40_000,
}, async t => {
  const rootDir = await setup(t);
  // An unresolved Promise alone does not keep Node alive. This owned timer makes forced termination observable.
  const incomplete = [{ path: 'src/app.mjs', content: `export async function createApp(){return {handle(){return {status:200,headers:{'content-type':'text/html'},body:'<!doctype html><html><head><title>Close hang fixture</title></head><body><h1>No business implementation</h1></body></html>'}},close(){return new Promise(()=>{setInterval(()=>{},1000)})}}}` }];
  const report = await runWebBrowserTests({ rootDir, files: incomplete, timeoutMs: 30_000 });
  completeness(report); assert.equal(report.status, 'failed');
  assert.equal(report.browser.closed, true); assert.equal(report.terminationConfirmed, true);
  assert.equal(report.checks.find(item => item.id === 'BROWSER-CLOSE').passed, false);
  const runtimeStops = report.processes.filter(item => item.kind !== 'browser');
  assert.equal(runtimeStops.length, 2);
  assert.ok(runtimeStops.every(item => item.terminationConfirmed && item.sourceUnchanged && item.stopAcknowledged === false && item.exitCode !== 0));
  assert.ok(report.processes.filter(item => item.kind === 'browser').every(item => item.terminationConfirmed && item.exitCode === 0));
});

function authDiagnosticFixture(kind) {
  const status = kind === '403' ? 403 : kind === '404' ? 404 : 401;
  const probe = kind === 'other-url' ? '/api/not-me' : '/api/me';
  const request = `const request=(method,url)=>{const x=new XMLHttpRequest();x.open(method,url,false);x.send();return x.status;};`;
  const script = kind === 'fetch'
    ? `fetch('/api/me').then(()=>{document.getElementById('u').hidden=false;});`
    : `${request}${kind === 'after-login' ? "request('POST','/api/login');" : ''}request('GET',${JSON.stringify(probe)});${kind === 'duplicate' ? "request('GET','/api/me');" : ''}document.getElementById('u').hidden=false;${kind === 'explicit' ? `console.error(${JSON.stringify(native401Text)});` : ''}${kind === 'pageerror' ? 'throw new Error("deliberate thin-fixture page error");' : ''}`;
  // This deliberately lacks passwords, login behavior, books, loans, cookies and SQLite. It cannot pass the business suite.
  return [{ path: 'public/fixture.js', content: script }, { path: 'src/app.mjs', content: `import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../public/fixture.js',import.meta.url),'utf8');
export async function createApp(){return {handle(req){
if(req.path==='/fixture.js')return {status:200,headers:{'content-type':'application/javascript'},body:script};
if(req.path==='/api/login'&&req.method==='POST')return {status:200,headers:{'content-type':'application/json'},body:'{"user":{"id":"thin-fixture"}}'};
if(req.path==='/api/me'||req.path==='/api/not-me')return {status:${status},headers:{'content-type':'application/json'},body:'{"error":"anonymous thin transport fixture"}'};
if(req.path!=='/')return {status:204,body:''};
return {status:200,headers:{'content-type':'text/html'},body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thin authentication diagnostic fixture</title></head><body><h1>No business implementation</h1><label for="u">Username</label><input id="u" data-testid="login-username" hidden><script src="/fixture.js"></script></body></html>'};
}}}` }];
}

test('real Edge and MXC classify only the native bootstrap diagnostic and keep thin fixtures business-failed', {
  skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1', timeout: 240_000,
}, async t => {
  const rootDir = await setup(t);
  for (const kind of ['bootstrap', 'fetch', 'explicit', 'duplicate', 'other-url', '403', '404', 'after-login', 'pageerror']) {
    await t.test(kind, async () => {
      const report = await runWebBrowserTests({ rootDir, files: authDiagnosticFixture(kind), timeoutMs: 25_000 });
      completeness(report); assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true);
      assert.equal(report.browser.closed, true); assert.equal(report.processes.length, 3);
      assert.equal(report.browser.diagnosticBudget.exceeded, false);
      const expected = ['bootstrap', 'fetch', 'explicit', 'pageerror'].includes(kind) ? 2 : 0;
      if (report.browser.expectedDiagnostics.length !== expected) t.diagnostic(JSON.stringify({ kind,
        evidence: report.browser.networkEvidence.map(({ requestId, type, responseType, requestAt, responseAt, status, url, responseUrl }) => ({ requestId, type, responseType, requestAt, responseAt, status, sameUrl: url === responseUrl })),
        native: report.browser.networkDiagnostics.map(({ networkRequestId, source, level, lineNumber, columnNumber, text }) => ({ networkRequestId, source, level, lineNumber, columnNumber, textHash: hash(text) })),
        console: report.browser.console.map(({ argsCount, location, text }) => ({ argsCount, lineNumber: location.lineNumber, columnNumber: location.columnNumber, path: new URL(location.url).pathname, textHash: hash(text) })) }));
      assert.equal(report.browser.expectedDiagnostics.length, expected, `${kind}: expected=${report.browser.expectedDiagnostics.length}, native=${report.browser.networkDiagnostics.length}, console=${report.browser.console.length}`);
      const shouldPassConsole = kind === 'bootstrap' || kind === 'fetch';
      assert.ok(report.checks.filter(item => item.id.endsWith('-CONSOLE')).every(item => item.passed === shouldPassConsole), `${kind} console result`);
      assert.ok(report.checks.filter(item => item.id.endsWith('-LOGIN')).every(item => !item.passed));
      assert.ok(report.checks.filter(item => item.id.endsWith('-NETWORK')).every(item => item.passed));
      assert.equal(report.checks.find(item => item.id === 'BROWSER-CLOSE').passed, true);
      if (kind === 'explicit') assert.equal(report.browser.console.filter(item => item.type === 'error' && item.text === native401Text && item.argsCount === 1).length, 2);
      if (kind === 'pageerror') assert.equal(report.browser.pageErrors.length, 2);
      t.diagnostic(`${kind}: expectedDiagnostics=${expected}; CONSOLE=${shouldPassConsole}; overall=${report.status}; stopped=${report.terminationConfirmed}`);
    });
  }
});
