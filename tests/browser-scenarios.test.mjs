import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { normalizeBrowserScenario, browserScenarioChecks, browserScenarioPolicyHash } from '../lib/browser-scenario-contract.mjs';

const definition = () => ({ version: 1, sessions: ['reader', 'writer'], steps: [
  { id: 'home', session: 'reader', requirementIds: ['R1'], op: 'goto', path: '/' },
  { id: 'other-home', session: 'writer', requirementIds: ['R1'], op: 'goto', path: '/' },
  { id: 'input', session: 'reader', requirementIds: ['R1'], op: 'fill', testId: 'name', value: 'typed' },
  { id: 'typed', session: 'reader', requirementIds: ['R1'], op: 'value', testId: 'name', value: 'typed' },
  { id: 'isolated', session: 'writer', requirementIds: ['R1'], op: 'value', testId: 'name', value: '' },
  { id: 'click', session: 'reader', requirementIds: ['R1'], op: 'click', testId: 'submit' },
  { id: 'text', session: 'reader', requirementIds: ['R1'], op: 'text', testId: 'message', value: 'submitted' },
  { id: 'visible', session: 'reader', requirementIds: ['R1'], op: 'visible', testId: 'message', value: true },
  { id: 'count', session: 'reader', requirementIds: ['R1'], op: 'count', testId: 'message', value: 1 },
] });
const digest = value => createHash('sha256').update(value).digest('hex');

if (!process.env.TASKFLOW_BROWSER_MOCK_CHILD) {
  async function nativeBrowserScenario(mode, files, browser) {
    const { createVerificationControl, compileManifest } = await import('../lib/verification-contract.mjs');
    const { runBrowserScenarios } = await import('../lib/browser-scenarios.mjs');
    const base = { projectId: 'readiness', runId: 'fixed', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
    const proposal = { version: 1, id: 'readiness', name: 'Browser fixture', sessions: [], steps: [{ id: 'http', type: 'request', dependsOn: [], requirementIds: ['R1'], request: { id: 'ready', method: 'GET', path: '/api/ready', assertions: [{ id: 'ok', op: 'status', value: 200 }] } }], browser }, control = createVerificationControl(), args = { proposal, requirements: ['R1'], binding: base }, approval = control.approve(args), manifest = compileManifest({ ...args, approval }); control.beginCoding(approval);
    const output = path.resolve('output/browser-action-readiness-tests'); await mkdir(output, { recursive: true }); const rootDir = await mkdtemp(path.join(output, mode + '-'));
    const report = await runBrowserScenarios({ rootDir, files, manifest, executable: process.env.EXECUTION_SANDBOX_EXE, binding: { ...base, taskId: 'fixture', attemptId: mode, candidateCommit: 'c'.repeat(40), sourceHash: digest(JSON.stringify(files)), manifestHash: manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: 'd'.repeat(64) } });
    await writeFile(path.join(rootDir, 'report.json'), JSON.stringify(report, null, 2)); return report;
  }
  async function nativeReadiness(mode) {
    const { validateProjectFiles } = await import('../lib/project-files.mjs');
    const app = `import{readFile}from'node:fs/promises';export async function createApp(){return{async handle(req){if(req.path==='/favicon.ico')return{status:204,headers:{},body:''};if(req.path==='/api/ready'||req.path==='/api/button-ready'){await new Promise(resolve=>setTimeout(resolve,150));return{status:200,headers:{'content-type':'application/json'},body:'{}'}}const file={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript']}[req.path];return file?{status:200,headers:{'content-type':file[1]},body:await readFile(new URL('../public/'+file[0],import.meta.url),'utf8')}:{status:404,headers:{},body:''}},close(){}}}`;
    const files = validateProjectFiles([{ path: 'src/app.mjs', content: app }, { path: 'public/index.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><section hidden><label>Name<input data-testid="name"></label>' + (mode === 'duplicate' ? '<input data-testid="name">' : '') + '</section><button hidden data-testid="submit">Submit</button><p data-testid="message"></p><script src="/app.js"></script>' },
      { path: 'public/app.js', content: `const panel=document.querySelector('section'),button=document.querySelector('button'),input=document.querySelector('input');fetch('/api/ready').then(()=>{${mode === 'never' ? '' : 'panel.hidden=false;'}});input.addEventListener('input',()=>{fetch('/api/button-ready').then(()=>{button.hidden=false})});button.addEventListener('click',()=>{document.querySelector('p').textContent=input.value})` }]);
    // Exercise normal native startup and navigation with the browser defaults.
    // The controlled mocks below verify small deadlines independently.
    const browser = { version: 1, sessions: ['reader'], steps: [
      { id: 'home', session: 'reader', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'name', session: 'reader', requirementIds: ['R1'], op: 'fill', testId: 'name', value: 'ready' },
      { id: 'submit', session: 'reader', requirementIds: ['R1'], op: 'click', testId: 'submit' }, { id: 'result', session: 'reader', requirementIds: ['R1'], op: 'text', testId: 'message', value: 'ready' }] };
    return nativeBrowserScenario(mode, files, browser);
  }
  const nativeReadinessOptions = { skip: process.env.TASKFLOW_TEST_REAL_SANDBOX !== '1' || !process.env.EXECUTION_SANDBOX_EXE, timeout: 75000 };
  test('native readiness waits for delayed hidden fill and then delayed hidden click in real Edge', nativeReadinessOptions, async () => {
    const report = await nativeReadiness('delayed'); assert.equal(report.status, 'passed', JSON.stringify(report)); assert.equal(report.checks.length, 13); assert(report.checks.every(c => c.passed)); assert.equal(report.terminationConfirmed, true);
  });
  for (const mode of ['never', 'duplicate']) test(`native readiness ${mode} fails without choosing another control`, nativeReadinessOptions, async () => {
    const report = await nativeReadiness(mode); assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true);
    for (const view of ['DESKTOP', 'MOBILE']) {
      const check = step => report.checks.find(item => item.id === `BROWSER-${view}-${step}`);
      assert.equal(check('home').passed, true, 'native setup and navigation must succeed before testing readiness');
      const action = check('name');
      assert.equal(action.passed, false);
      assert.notEqual(action.actual, '未执行，未获得通过结论', 'the readiness action must actually execute');
      const { observed, currentGuardSatisfied, guardFailures } = JSON.parse(action.actual);
      assert.equal(currentGuardSatisfied, true);
      assert.deepEqual(guardFailures, {});
      assert.equal(observed.count, mode === 'duplicate' ? 2 : 1);
      if (mode === 'never') assert.equal(observed.visible, false);
      assert.equal(check('submit').passed, false);
      assert.equal(check('submit').actual, '未执行，未获得通过结论');
    }
  });
  test('native Edge follows a declared same-origin HTTP redirect and asserts the destination in each viewport', nativeReadinessOptions, async () => {
    const { validateProjectFiles } = await import('../lib/project-files.mjs');
    const app = `export async function createApp() {
      return { handle(request) {
        if (request.path === '/tickets') return { status: 302, headers: { location: '/login' }, body: '' };
        if (request.path === '/login') return { status: 200, headers: { 'content-type': 'text/html' },
          body: '<!doctype html><meta name="viewport" content="width=device-width"><h1 data-testid="login">Sign in</h1>' };
        return { status: 204, headers: {}, body: '' };
      } };
    }`;
    const browser = { version: 1, sessions: ['guest'], steps: [
      { id: 'tickets', session: 'guest', requirementIds: ['R1'], op: 'goto', path: '/tickets', expectedPath: '/login' },
      { id: 'login', session: 'guest', requirementIds: ['R1'], op: 'text', testId: 'login', value: 'Sign in' },
    ] };
    const report = await nativeBrowserScenario('declared-redirect', validateProjectFiles([{ path: 'src/app.mjs', content: app }]), browser);
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.terminationConfirmed, true);
    for (const view of ['DESKTOP', 'MOBILE']) {
      assert.equal(report.checks.find(item => item.id === `BROWSER-${view}-tickets`).actual, '/login');
      assert.equal(report.checks.find(item => item.id === `BROWSER-${view}-login`).actual, 'Sign in');
    }
  });
  test('browser definition is normalized, detached, deeply frozen and creates a complete unique check list', () => {
    const raw = definition(), checked = normalizeBrowserScenario(raw, ['R1']); raw.steps[0].path = '/changed';
    assert.equal(checked.steps[0].path, '/'); assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.steps[0]) && Object.isFrozen(checked.limits));
    assert.deepEqual(checked.limits, { timeoutMs: 60000, actionTimeoutMs: 5000 });
    const checks = browserScenarioChecks(checked); assert.equal(checks.length, 5 + 2 * checked.steps.length); assert.equal(new Set(checks.map(item => item.id)).size, checks.length); assert.ok(checks.every(Object.isFrozen));
    assert.deepEqual(checks.filter(item => !item.id.startsWith('BROWSER-DESKTOP') && !item.id.startsWith('BROWSER-MOBILE')).map(item => item.id), ['BROWSER-SNAPSHOT', 'BROWSER-ENGINE', 'BROWSER-FINAL']);
  });
  test('browser policy hashes trusted contract, runner and delayed-load action implementation', () => {
    const bytes = Buffer.concat([readFileSync(new URL('../lib/browser-scenario-contract.mjs', import.meta.url)), readFileSync(new URL('../lib/browser-scenarios.mjs', import.meta.url)), readFileSync(new URL('../lib/browser-create-race.mjs', import.meta.url))]);
    assert.equal(browserScenarioPolicyHash, digest(bytes));
  });
  const race = () => ({ version: 1, sessions: ['writer'], steps: [{ id: 'create-race', session: 'writer', requirementIds: ['R1'], op: 'createWithDelayedLoad', path: '/items.html', loadPath: '/api/items', inputTestId: 'item-name', submitTestId: 'item-create', listTestId: 'item-list', countTestId: 'item-count', value: 'new item', expectedCount: 1 }] });
  test('delayed-load create is an approved frozen self-contained assertion and cannot navigate the ordinary session', () => {
    const raw = race(), normalized = normalizeBrowserScenario(raw, ['R1']); raw.steps[0].expectedCount = 2;
    assert.equal(normalized.steps[0].expectedCount, 1); assert.ok(Object.isFrozen(normalized.steps[0]));
    assert.deepEqual(browserScenarioChecks(normalized).find(check => check.id === 'BROWSER-DESKTOP-create-race').expected, { count: 1, listIncludes: 'new item', delayedGet: '/api/items' });
    const ordinary = race(); ordinary.steps.push({ id: 'unsafe-followup', session: 'writer', requirementIds: ['R1'], op: 'fill', testId: 'item-name', value: 'later' });
    assert.throws(() => normalizeBrowserScenario(ordinary, ['R1'])); ordinary.steps.splice(1, 0, { id: 'main-home', session: 'writer', requirementIds: ['R1'], op: 'goto', path: '/items.html' });
    assert.equal(normalizeBrowserScenario(ordinary, ['R1']).steps.length, 3);
  });
  test('delayed-load create rejects external/encoded paths, active input, unknown fields and unsupported expectations', () => {
    for (const mutate of [step => { step.path = '//external.invalid/'; }, step => { step.loadPath = 'https://external.invalid/'; }, step => { step.loadPath = '/a/%2e%2e/b'; }, step => { step.loadPath = '/a/../b'; }, step => { step.loadPath = '/a\\b'; }, step => { step.loadPath = '/a#hash'; }, step => { step.inputTestId = 'input[name=x]'; }, step => { step.submitTestId = step.inputTestId; }, step => { step.value = ''; }, step => { step.value = ' padded '; }, step => { step.value = 'x'.repeat(4097); }, step => { step.value = '\n'; }, step => { step.expectedCount = 0; }, step => { step.expectedCount = 1001; }, step => { step.expectedCount = '1'; }, step => { step.expectedCount = 1.5; }, step => { step.requestBody = { name: 'invented' }; }, step => { step.delayMs = 1; }, step => { step.requirementIds = ['UNKNOWN']; }]) {
      const raw = race(); mutate(raw.steps[0]); assert.throws(() => normalizeBrowserScenario(raw, ['R1']));
    }
    let invoked = 0; const raw = race(); Object.defineProperty(raw.steps[0], 'loadPath', { enumerable: true, get() { invoked++; return '/api/items'; } });
    assert.throws(() => normalizeBrowserScenario(raw, ['R1'])); assert.equal(invoked, 0);
  });
  for (const badPath of ['https://external.invalid/', '//external.invalid/', '/a/../b', '/%2e%2e/b', '/a%252fb', '/a\\b', '/a#b', '/ a', '/a\0', '/a:b', '/a/./b']) test(`browser goto rejects unsafe path ${JSON.stringify(badPath)}`, () => {
    const raw = definition(); raw.steps[0].path = badPath; assert.throws(() => normalizeBrowserScenario(raw, ['R1']));
    raw.steps[0].path = '/'; raw.steps[0].expectedPath = badPath; assert.throws(() => normalizeBrowserScenario(raw, ['R1']));
  });
  test('expectedPath is frozen, appears as the expected browser destination and applies only to goto', () => {
    const raw = definition(); raw.steps[0].path = '/tickets'; raw.steps[0].expectedPath = '/login';
    const normalized = normalizeBrowserScenario(raw, ['R1']); raw.steps[0].expectedPath = '/changed';
    assert.equal(normalized.steps[0].expectedPath, '/login');
    assert.equal(browserScenarioChecks(normalized).find(check => check.id === 'BROWSER-DESKTOP-home').expected, '/login');
    raw.steps[2].expectedPath = '/login';
    assert.throws(() => normalizeBrowserScenario(raw, ['R1']));
  });
  test('browser input rejects unsupported operations, JavaScript, arbitrary selectors and malformed references', () => {
    for (const mutate of [raw => { raw.steps[0].op = 'evaluate'; }, raw => { raw.steps[2].selector = 'input'; }, raw => { raw.steps[2].testId = 'input[name=x]'; }, raw => { raw.steps[0].session = 'unknown'; }, raw => { raw.steps[0].requirementIds = ['UNKNOWN']; }, raw => { raw.steps[0].id = 'GUARD'; }, raw => { raw.steps[1].id = raw.steps[0].id; }, raw => { raw.sessions = []; }, raw => { raw.steps = raw.steps.slice(0, 1); }, raw => { raw.steps[6].value = ''; }, raw => { raw.steps[7].value = 1; }, raw => { raw.steps[8].value = 1001; }, raw => { raw.steps[3].value = {}; }, raw => { raw.limits = { timeoutMs: null }; }, raw => { raw.limits = { timeoutMs: 120001 }; }, raw => { raw.limits = { actionTimeoutMs: 10001 }; }]) {
      const raw = definition(); mutate(raw); assert.throws(() => normalizeBrowserScenario(raw, ['R1']));
    }
  });
  test('browser input has bounded steps/sessions/text, and rejects active objects without invoking them', () => {
    const tooMany = definition(); tooMany.steps = Array.from({ length: 61 }, (_, i) => ({ ...tooMany.steps[7], id: `step${i}` })); assert.throws(() => normalizeBrowserScenario(tooMany, ['R1']));
    const sessions = definition(); sessions.sessions = ['a', 'b', 'c', 'd', 'e']; assert.throws(() => normalizeBrowserScenario(sessions, ['R1']));
    const text = definition(); text.steps[2].value = 'x'.repeat(4097); assert.throws(() => normalizeBrowserScenario(text, ['R1']));
    let invoked = 0; const accessor = definition(); Object.defineProperty(accessor.steps[0], 'path', { enumerable: true, get() { invoked++; return '/'; } });
    assert.throws(() => normalizeBrowserScenario(accessor, ['R1']));
    const jsonify = definition(); jsonify.toJSON = () => { invoked++; return {}; }; assert.throws(() => normalizeBrowserScenario(jsonify, ['R1']));
    const cycle = definition(); cycle.self = cycle; assert.throws(() => normalizeBrowserScenario(cycle, ['R1']));
    const sparse = definition(); delete sparse.steps[0]; assert.throws(() => normalizeBrowserScenario(sparse, ['R1'])); assert.equal(invoked, 0);
  });
  test('a missing element on about:blank cannot serve as a browser assertion', () => {
    assert.throws(() => normalizeBrowserScenario({ version: 1, sessions: ['reader'], steps: [{ id: 'absent', session: 'reader', requirementIds: ['R1'], op: 'visible', testId: 'missing', value: false }] }, ['R1']));
    const raw = definition(); raw.sessions.push('unused'); assert.throws(() => normalizeBrowserScenario(raw, ['R1']));
  });
  test('trusted infrastructure mocks are isolated from the production manifest module', () => {
    const environment = { ...process.env, TASKFLOW_BROWSER_MOCK_CHILD: '1' }; delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { env: environment, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/u);
  });
} else {
  // Only this child process brands synthetic manifests. Production still imports
  // the real WeakMap verifier and has no API for injected verdicts or adapters.
  const brands = new WeakSet(), revoked = new WeakSet();
  mock.module(new URL('../lib/verification-contract.mjs', import.meta.url).href, { namedExports: {
    compiledManifestDefinition: manifest => { assert.ok(brands.has(manifest)); return manifest; },
    assertCompiledManifest: (manifest, binding) => { assert.ok(brands.has(manifest) && !revoked.has(manifest)); assert.deepEqual(binding, manifest.binding); return manifest; },
  } });
  const { createBrowserScenarioService, runBrowserScenarios } = await import('../lib/browser-scenarios.mjs');
  const files = [{ path: 'src/app.mjs', content: 'export async function createApp(){ throw new Error("mock tests do not run candidate code") }\n' }];
  async function fixture(t, behavior = {}) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'browser-scenario-test-'));
    t.after(async () => { assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir())); assert.ok(path.basename(rootDir).startsWith('browser-scenario-test-')); await rm(rootDir, { recursive: true, force: true }); });
    const base = { projectId: 'project', runId: 'run', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
    const scenario = definition(); scenario.limits = { timeoutMs: 5000, actionTimeoutMs: behavior.actionTimeoutMs ?? 100 }; behavior.modifyScenario?.(scenario);
    const manifest = { binding: base, browser: normalizeBrowserScenario(scenario, ['R1']), requirements: ['R1'], manifestHash: 'c'.repeat(64) }; brands.add(manifest);
    const binding = { ...base, taskId: 'task', attemptId: 'attempt', candidateCommit: 'd'.repeat(40), sourceHash: digest(JSON.stringify(files)), manifestHash: manifest.manifestHash, browserPolicyHash: browserScenarioPolicyHash, reviewPolicyHash: 'e'.repeat(64) };
    const seen = { runtimes: [], stops: 0, launched: 0, closed: 0, contexts: [], worlds: 0, actions: [], inspections: [] }; let connected = true;
    const launchBrowser = async () => {
      seen.launched++; behavior.onLaunch?.(manifest);
      return { version: 'trusted-fixture-edge', browser: { isConnected: () => connected, newContext: async options => {
        const handlers = new Map(), pageHandlers = new Map();
        const context = { options, value: '', message: '', routeHandler: null, socketHandler: null, setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
          on: (name, handler) => handlers.set(name, handler), route: async (_pattern, handler) => { context.routeHandler = handler; }, routeWebSocket: async (_pattern, handler) => { context.socketHandler = handler; },
          close: async () => { context.closed = true; },
          newPage: async () => {
            const page = { current: 'about:blank', on: (name, handler) => pageHandlers.set(name, handler), url: () => page.current, isClosed: () => context.closed === true, close: async () => { context.closed = true; },
              goto: async target => { page.current = target; await context.routeHandler({ request: () => ({ url: () => target }), continue: async () => {}, abort: async () => {} });
                return await behavior.onGoto?.({ context, page, pageHandlers, manifest, target }) ?? { status: () => 200 }; },
              getByTestId: testId => ({ fill: async (value, options) => { seen.actions.push({ op: 'fill', testId, timeout: options.timeout }); context.value = value; await behavior.onFill?.({ context, manifest, timeout: options.timeout }); }, click: async options => { seen.actions.push({ op: 'click', testId, timeout: options.timeout }); assert.equal(testId, 'submit'); await behavior.onClick?.({ context, manifest, timeout: options.timeout }); if (behavior.delayedSubmit) setTimeout(() => { context.message = 'submitted'; }, 35); else context.message = 'submitted'; } }),
            }; context.page = page; handlers.get('page')?.(page); return page;
          },
          newCDPSession: async () => ({ detach: async () => {}, send: async (method, options) => {
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
            if (method === 'Page.createIsolatedWorld') { seen.worlds++; return { executionContextId: seen.worlds }; }
            const testId = options.arguments[0].value;
            const value = { count: testId === null ? 0 : behavior.duplicate ? 2 : 1, visible: testId !== null, text: behavior.wrongText ? 'different' : context.message, value: context.value, width: context.options.viewport.width, scroll: context.options.viewport.width + (behavior.overflow ? 100 : 0) };
            seen.inspections.push({ testId }); const override = await behavior.onInspect?.({ context, testId, value, manifest, pageHandlers });
            return { result: { value: { ...value, ...override } } };
          } }),
        }; seen.contexts.push(context); return context;
      } }, close: async () => { seen.closed++; connected = false; behavior.onClose?.(manifest); return { kind: 'browser', status: 'stopped', pid: 11, exitCode: behavior.browserExit ?? 0, terminationConfirmed: !behavior.browserUnknown }; } };
    };
    const startRuntime = async options => {
      seen.runtimes.push(options); behavior.onRuntime?.(); if (behavior.holdRuntime) await behavior.holdRuntime;
      if (behavior.changeSource) await writeFile(path.join(options.workspace, 'src/app.mjs'), '// modified\n');
      return { url: `http://localhost:${45000 + seen.runtimes.length}`, pid: 51, stop: async () => { seen.stops++;
        if (behavior.stopThrows) throw Object.assign(new Error('private stop failure'), { result: { pid: 51, stopReason: 'unknown', terminationConfirmed: false } });
        return { pid: 50 + seen.stops, status: 'stopped', exitCode: behavior.runtimeExit ?? 0, stopAcknowledged: !behavior.noAck, sourceUnchanged: true, terminationConfirmed: !behavior.runtimeUnknown }; } };
    };
    return { rootDir, manifest, binding, files, seen, service: createBrowserScenarioService({ startRuntime, launchBrowser }) };
  }
  const run = f => f.service({ rootDir: f.rootDir, files: f.files, manifest: f.manifest, binding: f.binding });
  test('trusted mock: complete checks bind both independent runtime snapshots, sessions, source and manifest', async t => {
    const f = await fixture(t), report = await run(f);
    assert.equal(report.status, 'passed', JSON.stringify(report)); assert.deepEqual(report.binding, f.binding); assert.equal(report.manifestHash, f.manifest.manifestHash); assert.equal(report.sourceHash, f.binding.sourceHash);
    assert.deepEqual(report.checks.map(item => item.id), browserScenarioChecks(f.manifest.browser).map(item => item.id)); assert.ok(report.checks.every(item => item.passed)); assert.equal(report.coverage, 'structural_only');
    assert.equal(f.seen.runtimes.length, 2); assert.notEqual(f.seen.runtimes[0].workspace, f.seen.runtimes[1].workspace); assert.equal(f.seen.contexts.length, 4); assert.ok(f.seen.worlds > 0);
    assert.equal(report.terminationConfirmed, true); assert.equal(report.browser.closed, true); assert.equal(f.seen.closed, 1); assert.equal(f.seen.stops, 2);
  });
  for (const mode of ['declared', 'legacy', 'wrong-destination', 'client-navigation', 'non-redirect-status', 'external-intermediate']) test(`trusted mock checks the exact approved server redirect (${mode})`, async t => {
    const f = await fixture(t, { modifyScenario: scenario => {
      scenario.steps[0].path = '/tickets';
      if (mode !== 'legacy') scenario.steps[0].expectedPath = '/login';
    }, onGoto: ({ page, target }) => {
      if (!target.endsWith('/tickets')) return;
      const responseOf = (url, status, from = null) => {
        const request = { url: () => url, redirectedFrom: () => from?.request() ?? null, response: async () => response };
        const response = { url: () => url, status: () => status, request: () => request };
        return response;
      };
      const initial = responseOf(target, mode === 'non-redirect-status' ? 200 : 302);
      const prior = mode === 'client-navigation' ? null : mode === 'external-intermediate' ? responseOf('http://blocked.invalid/private', 307, initial) : initial;
      page.current = new URL(mode === 'wrong-destination' ? '/other' : '/login', target).href;
      return responseOf(page.current, 200, prior);
    } });
    const report = await run(f);
    assert.equal(report.status, mode === 'declared' ? 'passed' : 'failed', JSON.stringify(report));
    assert.equal(report.terminationConfirmed, true);
    for (const view of ['DESKTOP', 'MOBILE']) assert.equal(report.checks.find(check => check.id === `BROWSER-${view}-home`).passed, mode === 'declared');
    assert.doesNotMatch(JSON.stringify(report), /blocked\.invalid|\/private/u);
  });
  for (const behavior of [{ wrongText: true }, { duplicate: true }, { overflow: true }, { runtimeExit: 1 }, { noAck: true }, { browserExit: 1 }, { changeSource: true }]) test(`trusted mock rejects failing actions or shutdown ${JSON.stringify(behavior)}`, async t => {
    const f = await fixture(t, behavior), report = await run(f); assert.equal(report.status, 'failed'); assert.ok(report.checks.some(item => !item.passed)); assert.equal(report.terminationConfirmed, true);
  });
  for (const behavior of [{ runtimeUnknown: true }, { browserUnknown: true }]) test(`trusted mock preserves unconfirmed stop ${JSON.stringify(behavior)}`, async t => {
    const f = await fixture(t, behavior), report = await run(f); assert.equal(report.status, 'reconciliation_required'); assert.equal(report.terminationConfirmed, false);
  });
  for (const behavior of [{ runtimeUnknown: true }, { stopThrows: true }]) test(`unknown runtime stop preserves PID and forbids the next viewport ${JSON.stringify(behavior)}`, async t => {
    const f = await fixture(t, behavior), report = await run(f);
    assert.equal(report.status, 'reconciliation_required'); assert.equal(report.terminationConfirmed, false);
    assert.equal(f.seen.runtimes.length, 1); assert.ok(report.processes.some(item => item.kind === 'runtime' && item.pid === 51 && item.terminationConfirmed === false));
    assert.doesNotMatch(JSON.stringify(report), /private stop failure/u);
  });
  test('trusted mock forbids public adapters, forged manifests and mismatched policies before resource allocation', async t => {
    const f = await fixture(t);
    for (const raw of [{ rootDir: f.rootDir, files, manifest: {}, binding: f.binding }, { rootDir: f.rootDir, files, manifest: f.manifest, binding: { ...f.binding, browserPolicyHash: 'f'.repeat(64) } }, { rootDir: f.rootDir, files, manifest: f.manifest, binding: { ...f.binding, sourceHash: 'f'.repeat(64) } }, { rootDir: f.rootDir, files, manifest: f.manifest, binding: f.binding, expected: true }, { runtimeFactory: () => {} }]) assert.notEqual((await f.service(raw)).status, 'passed');
    assert.equal(f.seen.launched, 0); assert.equal(f.seen.runtimes.length, 0);
    assert.notEqual((await runBrowserScenarios({ runtimeFactory: () => {} })).status, 'passed');
  });
  test('trusted mock rechecks approval after browser-close callbacks before final publication', async t => {
    const f = await fixture(t, { onClose: manifest => revoked.add(manifest) }), report = await run(f);
    assert.equal(report.status, 'failed'); assert.equal(report.checks.at(-1).passed, false); assert.equal(report.terminationConfirmed, true);
  });
  test('trusted mock waits within the declared action budget for asynchronous UI state', async t => {
    const f = await fixture(t, { delayedSubmit: true }), report = await run(f); assert.equal(report.status, 'passed');
  });
  const staleObservation = 'cdpSession.send: Protocol error (Runtime.callFunctionOn): Cannot find context with specified id';
  test('the first same-origin document observation can lose its context without repeating the click', async t => {
    const f = await fixture(t, { actionTimeoutMs: 250, onInspect: ({ context, testId }) => {
      if (testId !== 'message' || context.replaced) return;
      context.replaced = true;
      context.page.current = new URL('/after-submit', context.page.current).href;
      throw new Error(staleObservation);
    } });
    const report = await run(f);
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.terminationConfirmed, true);
    assert.equal(f.seen.actions.filter(action => action.op === 'click').length, 2);
    assert.equal(f.seen.contexts.filter(context => context.replaced).length, 2);
  });
  test('browser context recovery leaves closed pages, other origins, and other CDP errors failed', async t => {
    for (const failure of ['closed', 'origin', 'unexpected', 'different-protocol']) {
      let observations = 0;
      const f = await fixture(t, { actionTimeoutMs: 250, onInspect: ({ context, testId, pageHandlers }) => {
        if (testId !== 'message') return;
        observations++;
        if (failure === 'closed') context.closed = true;
        if (failure === 'origin') context.page.current = 'http://blocked.invalid/';
        if (failure === 'unexpected') pageHandlers.get('framenavigated')({ url: () => 'http://blocked.invalid/' });
        if (observations > 2) assert.fail('Failed observations may not repeat');
        throw new Error(failure === 'different-protocol' ? staleObservation.replace('Runtime.callFunctionOn', 'Page.getFrameTree') : staleObservation);
      } });
      assert.equal((await run(f)).status, 'failed', failure);
      assert.equal(observations, 2, failure);
    }
  });
  test('repeated stale browser contexts cannot exceed the original action deadline', async t => {
    let observations = 0;
    const actionTimeoutMs = 120;
    const f = await fixture(t, { actionTimeoutMs, onInspect: ({ testId }) => {
      if (testId === 'message') {
        observations++;
        throw new Error(staleObservation);
      }
    } });
    const report = await run(f);
    assert.equal(report.status, 'failed');
    assert.equal(report.terminationConfirmed, true);
    assert.ok(observations > 2 && observations <= 2 * Math.ceil(actionTimeoutMs / 25) + 2);
    assert.equal(f.seen.actions.filter(action => action.op === 'click').length, 2);
  });
  test('trusted mock fill and click wait for a unique visible control and give the operation only the remaining action budget', async t => {
    const f = await fixture(t, { actionTimeoutMs: 300, onInspect: ({ context, testId }) => {
      if (!['name','submit'].includes(testId)) return;
      context.probes ??= new Map(); const count = (context.probes.get(testId) ?? 0) + 1; context.probes.set(testId, count);
      return count === 1 ? { count: 0, visible: false } : count === 2 ? { visible: false } : {};
    } }), report = await run(f);
    assert.equal(report.status, 'passed'); assert.equal(f.seen.actions.length, 4); assert(f.seen.actions.every(a => a.timeout > 0 && a.timeout < 280));
  });
  test('trusted mock never-ready and duplicate hidden targets never dispatch fill or click', async t => {
    for (const duplicate of [false,true]) {
      const f = await fixture(t, { actionTimeoutMs: 60, onInspect: ({ testId }) => testId === 'name' ? { count: duplicate ? 2 : 1, visible: false } : {} }), report = await run(f);
      assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.equal(f.seen.actions.length, 0);
      if (duplicate) assert.equal(f.seen.inspections.filter(i => i.testId === 'name').length, 2, 'duplicates fail on the first probe in each viewport');
    }
  });
  test('trusted mock blocked readonly observation is bounded by the same action deadline', async t => {
    const f = await fixture(t, { actionTimeoutMs: 60, onInspect: ({ testId }) => testId === 'name' ? new Promise(() => {}) : {} }), started = performance.now(), report = await run(f);
    assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.equal(f.seen.actions.length, 0); assert(performance.now() - started < 2000);
  });
  test('trusted mock readiness wait and operation cannot each consume a fresh full action budget', async t => {
    const f = await fixture(t, { actionTimeoutMs: 140, onInspect: async ({ context, testId }) => {
      if (testId === 'name' && !context.probed) { context.probed = true; await new Promise(resolve => setTimeout(resolve, 35)); return { visible: false }; }
    }, onFill: async ({ timeout }) => { await new Promise(resolve => setTimeout(resolve, timeout + 25)); } }), report = await run(f);
    assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.equal(f.seen.actions.length, 2); assert(f.seen.actions.every(a => a.op === 'fill' && a.timeout > 0 && a.timeout < 110));
    assert.equal(report.checks.find(c => c.id === 'BROWSER-DESKTOP-input').passed, false);
  });
  test('trusted mock cancellation, revoked approval and console guard during readiness cannot dispatch actions', async t => {
    for (const kind of ['cancel','revoke','console']) {
      const controller = new AbortController(), f = await fixture(t, { onInspect: ({ testId, manifest, pageHandlers }) => {
        if (testId !== 'name') return;
        if (kind === 'cancel') controller.abort();
        if (kind === 'revoke') revoked.add(manifest);
        if (kind === 'console') pageHandlers.get('console')({ text: () => 'SECRET-console-url-query-business-stack', type: () => 'error' });
        return { visible: false };
      } }), report = await f.service({ rootDir: f.rootDir, files: f.files, manifest: f.manifest, binding: f.binding, signal: controller.signal });
      assert.equal(report.status, kind === 'cancel' ? 'cancelled' : 'failed'); assert.equal(report.terminationConfirmed, true); assert.equal(f.seen.actions.length, 0);
      assert.equal(JSON.stringify(report).includes('SECRET-'), false);
      if (kind === 'console') assert.deepEqual(JSON.parse(report.checks.find(c => c.id === 'BROWSER-DESKTOP-input').actual).guardFailures, { console_error: 1 });
    }
  });
  test('trusted mock total budget still terminates a longer declared action readiness wait', async t => {
    const f = await fixture(t, { actionTimeoutMs: 1000, onInspect: ({ testId }) => testId === 'name' ? { visible: false } : {} }), report = await f.service({ rootDir: f.rootDir, files: f.files, manifest: f.manifest, binding: f.binding, timeoutMs: 200 });
    assert.equal(report.status, 'timed_out'); assert.equal(report.terminationConfirmed, true); assert.equal(f.seen.actions.length, 0);
  });
  test('trusted mock guard diagnostics expose only fixed codes and bounded counts, never messages or URLs', async t => {
    for (const [event,code] of [['console','console_error'],['pageerror','page_error'],['dialog','dialog'],['download','download'],['framenavigated','navigation']]) {
      const f = await fixture(t, { onInspect: ({ testId, pageHandlers }) => {
        if (testId !== 'name') return;
        const privateText = 'SECRET-business-path-query-stack', value = event === 'console' ? { text:()=>privateText,type:()=> 'error' } : event === 'pageerror' ? { message:privateText } : event === 'framenavigated' ? { url:()=> 'https://external.invalid/'+privateText } : { dismiss:async()=>{},cancel:async()=>{} };
        pageHandlers.get(event)(value); return { visible:false };
      } }), report = await run(f);
      assert.equal(report.status,'failed'); assert.equal(JSON.stringify(report).includes('SECRET-'),false);
      assert.deepEqual(JSON.parse(report.checks.find(c=>c.id==='BROWSER-DESKTOP-input').actual).guardFailures,{[code]:1}); assert.equal(f.seen.actions.length,0);
    }
  });
  test('trusted mock diagnostic flood is a failure with bounded shutdown rather than user cancellation', async t => {
    const f = await fixture(t, { onGoto: ({ pageHandlers }) => { for (let index = 0; index < 300; index++) pageHandlers.get('console')({ text: () => 'diagnostic', type: () => 'log' }); } });
    const report = await run(f); assert.equal(report.status, 'failed'); assert.equal(report.terminationConfirmed, true); assert.equal(report.checks.at(-1).passed, false);
  });
  test('trusted mock blocks external routes, websocket, unexpected console and download events', async t => {
    for (const kind of ['request', 'websocket', 'console', 'download']) {
      const f = await fixture(t, { onGoto: async ({ context, pageHandlers }) => {
        if (kind === 'request') await context.routeHandler({ request: () => ({ url: () => 'https://external.invalid/' }), abort: async () => {} });
        if (kind === 'websocket') await context.socketHandler({ close: async () => {} });
        if (kind === 'console') pageHandlers.get('console')({ text: () => 'private candidate details', type: () => 'error' });
        if (kind === 'download') pageHandlers.get('download')({ cancel: async () => {} });
      } });
      const report = await run(f); assert.equal(report.status, 'failed'); assert.ok(report.checks.some(item => !item.passed)); assert.equal(JSON.stringify(report).includes('private candidate details'), false);
    }
  });
  test('trusted mock cancellation before launch and during a blocked action cannot pass', async t => {
    const controller = new AbortController(); controller.abort(); const f = await fixture(t);
    const before = await f.service({ rootDir: f.rootDir, manifest: f.manifest, binding: f.binding, files, signal: controller.signal }); assert.equal(before.status, 'cancelled'); assert.equal(f.seen.launched, 0);
    const during = new AbortController(); const g = await fixture(t, { onFill: async () => { during.abort(); await new Promise(() => {}); } });
    const report = await g.service({ rootDir: g.rootDir, manifest: g.manifest, binding: g.binding, files, signal: during.signal }); assert.equal(report.status, 'cancelled'); assert.equal(report.terminationConfirmed, true);
  });
  test('trusted mock late uncooperative runtime is stopped and cannot replace a returned unknown result', async t => {
    let release, entered; const held = new Promise(done => { release = done; }), ready = new Promise(done => { entered = done; });
    const f = await fixture(t, { holdRuntime: held, onRuntime: entered }), controller = new AbortController();
    const pending = f.service({ rootDir: f.rootDir, manifest: f.manifest, binding: f.binding, files, signal: controller.signal }); await ready; controller.abort(); const report = await pending;
    assert.equal(report.status, 'reconciliation_required'); const serialized = JSON.stringify(report);
    release(); await new Promise(done => setTimeout(done, 20)); assert.equal(JSON.stringify(report), serialized); assert.equal(f.seen.stops, 1);
  });
}
