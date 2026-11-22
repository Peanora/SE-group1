import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { minimalEnv } from './managed-process.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { assertCompiledManifest, compiledManifestDefinition } from './verification-contract.mjs';
import { startWebRuntime } from './web-runtime.mjs';
import { runBrowserCreateRace } from './browser-create-race.mjs';
import { normalizeBrowserScenario, copyBrowserScenarioData, browserScenarioChecks, browserScenarioPolicyHash } from './browser-scenario-contract.mjs';
export { browserScenarioChecks, browserScenarioPolicyHash } from './browser-scenario-contract.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error('浏览器清单、来源、执行或停止证据未满足。'), { code }); };
const need = (condition, code = 'browser_assertion') => { if (!condition) fail(code); };
const views = [{ id: 'DESKTOP', width: 1365, height: 900 }, { id: 'MOBILE', width: 390, height: 844 }];
const bindingKeys = ['projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'candidateCommit', 'sourceHash', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash'];
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const replacedObserverContext = /^(?:cdpSession\.send: )?Protocol error \(Runtime\.callFunctionOn\): Cannot find context with specified id$/u;

async function confirmedRedirect(response, origin, requested, expected, waitForResponse) {
  if (response.url() !== expected) return false;
  let request = response.request();
  if (request.url() !== expected) return false;
  // Chromium bounds redirect chains at 20 hops. Require a server response
  // for every hop and trace the final navigation back to the declared URL.
  for (let hops = 0; hops <= 20; hops++) {
    const prior = request.redirectedFrom();
    if (!prior) return hops > 0 && request.url() === requested;
    if (hops === 20) return false;
    const target = new URL(prior.url());
    if (target.origin !== origin || target.username || target.password) return false;
    const redirect = await waitForResponse(prior.response());
    if (!redirect || redirect.url() !== prior.url() || !redirectStatuses.has(redirect.status())) return false;
    request = prior;
  }
  return false;
}

async function trustedDirectory(raw) {
  need(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root, 'invalid_options');
  let current = path.parse(path.resolve(raw)).root;
  for (const segment of path.resolve(raw).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const info = await lstat(current), canonical = await realpath(current);
    need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ? canonical.toLowerCase() === current.toLowerCase() : canonical === current), 'invalid_options');
  }
  return path.resolve(raw);
}
async function launchEdge({ signal, timeoutMs }) {
  const { chromium } = await import('playwright-core'); need(!signal.aborted, 'cancelled');
  const server = await chromium.launchServer({ channel: 'msedge', headless: true, chromiumSandbox: true, env: minimalEnv(), timeout: Math.min(10000, timeoutMs),
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const child = server.process(); let exited = child.exitCode !== null || child.signalCode !== null, resolveExit, browser, closing;
  const exit = new Promise(resolve => { resolveExit = resolve; }); if (exited) resolveExit(); child.once('close', () => { exited = true; resolveExit(); });
  const close = () => closing ??= (async () => {
    const settle = async (pending, ms) => { let timer; try { await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), ms); })]); } finally { clearTimeout(timer); } };
    try { await settle((async () => { try { await browser?.close(); } finally { await server.close(); } await exit; })(), 5000); }
    catch { try { await settle(server.kill().then(() => exit), 3000); } catch { /* Confirmation below remains false. */ } }
    return { kind: 'browser', pid: child.pid ?? null, status: exited ? 'stopped' : 'reconciliation_required', exitCode: child.exitCode, terminationConfirmed: exited };
  })();
  try { need(!signal.aborted, 'cancelled'); browser = await chromium.connect(server.wsEndpoint(), { timeout: Math.min(5000, timeoutMs) }); need(!signal.aborted, 'cancelled'); return { browser, version: browser.version(), close }; }
  catch (cause) { const processRecord = await close(); throw Object.assign(cause, { processRecord }); }
}
function optionsData(raw) {
  need(raw && Object.getPrototypeOf(raw) === Object.prototype, 'invalid_options');
  const own = Object.getOwnPropertyDescriptors(raw), allowed = ['rootDir', 'files', 'manifest', 'binding', 'signal', 'executable', 'timeoutMs', 'datasetSeed'];
  need(Reflect.ownKeys(raw).every(key => typeof key === 'string' && allowed.includes(key) && own[key].enumerable && Object.hasOwn(own[key], 'value')), 'invalid_options');
  return Object.fromEntries(Object.keys(own).map(key => [key, own[key].value]));
}
/** Adapters exist only on this trusted factory; the production function accepts none. */
export function createBrowserScenarioService(adapters = {}) {
  need(adapters && Object.getPrototypeOf(adapters) === Object.prototype, 'invalid_options');
  const own = Object.getOwnPropertyDescriptors(adapters);
  need(Reflect.ownKeys(adapters).every(key => typeof key === 'string' && ['startRuntime', 'launchBrowser'].includes(key) && Object.hasOwn(own[key], 'value') && typeof own[key].value === 'function'), 'invalid_options');
  const startRuntime = own.startRuntime?.value ?? startWebRuntime, launchBrowser = own.launchBrowser?.value ?? launchEdge;
  return async function run(raw = {}) {
    const report = { status: 'error', binding: null, sourceHash: null, manifestHash: null, browserPolicyHash: browserScenarioPolicyHash, checks: [], processes: [], terminationConfirmed: false, browser: { version: null, closed: true }, coverage: 'structural_only', error: null, workspace: null };
    const controller = new AbortController(), resources = new Set(), contexts = new Set(), pending = new Set(), stops = new Map(), processes = [];
    let options, binding, definition, canonicalFiles, session, timer, deadline, datasetMethods, timedOut = false, diagnosticExceeded = false, uncertain = false, finishing = false, finished = false, browserStarted = false;
    const checks = new Map(), snapshots = [], abort = () => controller.abort();
    const remember = record => { if (record && !finished && !processes.includes(record)) processes.push(record); };
    const guard = () => {
      need(!uncertain, 'reconciliation_required');
      if (deadline && Date.now() >= deadline) { timedOut = true; controller.abort(); }
      need(!controller.signal.aborted, timedOut ? 'timed_out' : 'cancelled');
      assertCompiledManifest(options.manifest, Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]])));
    };
    const remaining = () => Math.max(1, deadline - Date.now());
    const bounded = async (promise, actionEnd = null) => {
      const work = Promise.resolve(promise); work.catch(() => {}); let listener, actionTimer;
      try {
        guard(); const waits = [work, new Promise((_, reject) => { listener = () => reject(Object.assign(new Error('interrupted'), { code: timedOut ? 'timed_out' : 'cancelled' })); controller.signal.addEventListener('abort', listener, { once: true }); if (controller.signal.aborted) listener(); })];
        if (actionEnd !== null) waits.push(new Promise((_, reject) => { actionTimer = setTimeout(() => reject(Object.assign(new Error('browser action timed out'), { code: 'browser_assertion' })), Math.max(0, actionEnd - Date.now())); }));
        return await Promise.race(waits);
      } finally { clearTimeout(actionTimer); controller.signal.removeEventListener('abort', listener); }
    };
    const cleanupBound = async (promise, ms = 2500) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup unconfirmed')), ms); })]); } finally { clearTimeout(timer); } };
    const stop = (resource, kind) => {
      if (!stops.has(resource)) stops.set(resource, (async () => {
        try { const record = await cleanupBound(Promise.resolve().then(() => kind === 'browser' ? resource.close() : resource.stop()), kind === 'browser' ? 9000 : 3500);
          uncertain ||= record?.terminationConfirmed !== true; remember({ ...record, pid: record?.pid ?? resource.pid ?? null, kind });
          if (kind === 'browser' && !finished) report.browser.closed = record?.terminationConfirmed === true; return record; }
        catch (cause) { uncertain = true; const result = cause?.result ?? cause?.processRecord;
          remember({ ...result, pid: result?.pid ?? resource.pid ?? null, kind, status: 'reconciliation_required', terminationConfirmed: false }); return null; }
      })()); return stops.get(resource);
    };
    const acquire = async (promise, kind) => {
      const work = Promise.resolve(promise); pending.add(work);
      work.then(resource => { pending.delete(work); resources.add(resource); if (finishing) void stop(resource, kind); }, cause => { pending.delete(work); remember(cause?.processRecord ?? cause?.result); });
      const value = await bounded(work); guard(); return value;
    };
    const prepareDataset = async (workspace, phase) => {
      if (options.datasetSeed === undefined) return;
      const work = Promise.resolve().then(() => datasetMethods.preparePlannedVerificationDataset(options.datasetSeed, { workspace, manifest: options.manifest, binding, phase, signal: controller.signal }));
      pending.add(work);
      work.then(receipt => { pending.delete(work); if (!finished) report.dataset.push(receipt); }, cause => {
        pending.delete(work); uncertain ||= cause?.reconciliationRequired === true || cause?.result?.terminationConfirmed === false || cause?.code === 'migration_stop_unknown';
      });
      await bounded(work); guard();
    };
    const mark = (id, passed, actual) => { const item = checks.get(id); if (item) { item.passed = passed; item.actual = actual; } };
    async function inspect(context, page, testId = null, actionEnd = null) {
      const acquiring = Promise.resolve().then(() => context.newCDPSession(page)); let cdp;
      const detach = resource => cleanupBound(Promise.resolve().then(() => resource.detach()), 500).catch(() => {});
      try {
        cdp = await bounded(acquiring, actionEnd);
        const { frameTree } = await bounded(cdp.send('Page.getFrameTree'), actionEnd);
        const { executionContextId } = await bounded(cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'taskflow-browser-observer' }), actionEnd);
        const response = await bounded(cdp.send('Runtime.callFunctionOn', { executionContextId, returnByValue: true, arguments: [{ value: testId }], functionDeclaration: `function(id) {
          const matches = id === null ? [] : Array.from(document.querySelectorAll('[data-testid]')).filter(node => node.getAttribute('data-testid') === id);
          const element = matches.length === 1 ? matches[0] : null, style = element && getComputedStyle(element);
          return { count: Math.min(matches.length,1001), visible: !!element && !!element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none',
            text: element ? String(element.innerText ?? '').slice(0,4097) : null, value: element && typeof element.value === 'string' ? element.value.slice(0,4097) : null,
            width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0) };
        }` }), actionEnd);
        need(!response.exceptionDetails && response.result?.value && typeof response.result.value === 'object'); return response.result.value;
      } finally { if (cdp) await detach(cdp); else void acquiring.then(detach).catch(() => {}); }
    }
    async function runView(view, workspace) {
      let runtime, violation = false, eventCount = 0, bytes = 0; const local = new Map(), pages = new Set(), guardFailures = {};
      const reason = code => { guardFailures[code] = Math.min(257, (guardFailures[code] ?? 0) + 1); };
      const security = code => { reason(code); violation = true; if (++eventCount > 256) { diagnosticExceeded = true; controller.abort(); } };
      const observed = value => { bytes += Math.min(100000, String(value).length); if (++eventCount > 256 || bytes > 32768) { reason('diagnostic_limit'); violation = true; diagnosticExceeded = true; controller.abort(); } };
      const observe = expectedOrigin => async (context, page, testId = null, actionEnd = Math.min(deadline, Date.now() + definition.limits.actionTimeoutMs)) => {
        const current = () => !violation && !page.isClosed() && new URL(page.url()).origin === expectedOrigin.origin;
        for (;;) {
          try { return await inspect(context, page, testId, actionEnd); }
          catch (cause) {
            guard();
            // A same-origin document can replace the isolated world between
            // its creation and the read. Retry only that read, never an action.
            if (!replacedObserverContext.test(cause?.message ?? '') || !current() || Date.now() >= actionEnd) throw cause;
            await bounded(new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, actionEnd - Date.now())))), actionEnd);
            guard(); need(current() && Date.now() < actionEnd);
          }
        }
      };
      async function newContext(origin) {
        guard(); const context = await bounded(session.browser.newContext({ viewport: { width: view.width, height: view.height }, serviceWorkers: 'block', acceptDownloads: false, permissions: [] })); contexts.add(context);
        context.setDefaultTimeout(Math.min(definition.limits.actionTimeoutMs, remaining())); context.setDefaultNavigationTimeout(Math.min(definition.limits.actionTimeoutMs, remaining()));
        await bounded(context.route('**/*', async route => {
          let allowed = false; try { const target = new URL(route.request().url()); allowed = target.origin === origin.origin && !target.username && !target.password; } catch { /* Deny malformed URLs. */ }
          if (allowed) await route.continue().catch(() => { security('route_failure'); }); else { security('external_request'); await route.abort().catch(() => {}); }
        }));
        await bounded(context.routeWebSocket(/.*/, async socket => { security('websocket'); await socket.close({ code: 1008, reason: 'Only declared HTTP browser actions are allowed' }).catch(() => {}); }));
        let pageSeen = false;
        context.on('page', page => {
          if (pageSeen) { security('unexpected_page'); void page.close().catch(() => {}); return; } pageSeen = true;
          page.on('pageerror', cause => { observed(cause.message); security('page_error'); });
          page.on('console', message => { observed(message.text()); if (message.type() === 'error') security('console_error'); });
          page.on('download', download => { security('download'); void download.cancel().catch(() => {}); });
          page.on('dialog', dialog => { security('dialog'); void dialog.dismiss().catch(() => {}); });
          page.on('framenavigated', frame => { try { if (frame.url() !== 'about:blank' && new URL(frame.url()).origin !== origin.origin) security('navigation'); } catch { security('navigation'); } });
        });
        return context;
      }
      try {
        await prepareDataset(workspace, `browser-${view.id}`); guard();
        guard(); runtime = await acquire(startRuntime({ workspace, executable: options.executable, signal: controller.signal, timeoutMs: remaining(), requestTimeoutMs: Math.min(definition.limits.actionTimeoutMs, remaining()), maxOutputBytes: 262144 }), 'runtime');
        guard(); const origin = new URL(runtime.url); need(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password && runtime.url === origin.origin);
        const observePage = observe(origin);
        for (const id of definition.sessions) {
          const context = await newContext(origin);
          const page = await bounded(context.newPage()); pages.add(page); local.set(id, { context, page }); guard();
        }
        for (const step of definition.steps) {
          const checkId = `BROWSER-${view.id}-${step.id}`;
          let observation = null;
          try {
            guard(); need(!violation); const { context, page } = local.get(step.session);
            if (step.op === 'createWithDelayedLoad') {
              let isolatedRuntime, isolatedContext, isolatedStop;
              try {
                guard(); const target = await bounded(mkdtemp(path.join(report.workspace, `race-${view.id.toLowerCase()}-`))); snapshots.push(target);
                need((await bounded(applyProjectFiles({ workspace: target, files: canonicalFiles }))).sourceHash === report.sourceHash); guard();
                await prepareDataset(target, `race-${view.id}-${step.id}`); guard();
                isolatedRuntime = await acquire(startRuntime({ workspace: target, executable: options.executable, signal: controller.signal, timeoutMs: remaining(), requestTimeoutMs: Math.min(definition.limits.actionTimeoutMs, remaining()), maxOutputBytes: 262144 }), 'runtime');
                const isolatedOrigin = new URL(isolatedRuntime.url); need(isolatedOrigin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(isolatedOrigin.hostname) && !isolatedOrigin.username && !isolatedOrigin.password && isolatedRuntime.url === isolatedOrigin.origin);
                isolatedContext = await newContext(isolatedOrigin);
                observation = await runBrowserCreateRace({ step, context: isolatedContext, origin: isolatedOrigin.origin, actionTimeoutMs: definition.limits.actionTimeoutMs, remaining, guard, bounded, inspect: observe(isolatedOrigin), violated: () => violation });
              } catch (cause) { observation = cause?.observation ?? observation; throw cause; }
              finally {
                if (isolatedContext) {
                  try { await cleanupBound(Promise.resolve().then(() => isolatedContext.close()), 1500); }
                  catch { security('context_close'); }
                  contexts.delete(isolatedContext);
                }
                if (isolatedRuntime) isolatedStop = await stop(isolatedRuntime, 'runtime');
              }
              guard(); need(!violation && isolatedStop?.terminationConfirmed === true && isolatedStop.status === 'stopped' && isolatedStop.exitCode === 0 && isolatedStop.stopAcknowledged === true && isolatedStop.sourceUnchanged === true);
              mark(checkId, true, JSON.stringify(observation));
            } else if (step.op === 'goto') {
              const expectedPath = step.expectedPath ?? step.path, requested = `${origin.origin}${step.path}`;
              const expected = `${origin.origin}${expectedPath}`, redirectExpected = expected !== requested;
              const timeout = Math.min(definition.limits.actionTimeoutMs, remaining()), actionEnd = Date.now() + timeout;
              const response = await bounded(page.goto(requested, { waitUntil: 'domcontentloaded', timeout }), actionEnd);
              observation = { status: response?.status() ?? null, sameTarget: page.url() === expected };
              need(response && response.status() < 400 && observation.sameTarget);
              if (redirectExpected) {
                observation.redirectConfirmed = await confirmedRedirect(response, origin.origin, requested, expected, pendingResponse => bounded(pendingResponse, actionEnd));
                need(observation.redirectConfirmed && page.url() === expected);
              }
              guard(); need(!violation); mark(checkId, true, expectedPath);
            } else {
              const actionEnd = Math.min(deadline, Date.now() + definition.limits.actionTimeoutMs);
              let actual = await observePage(context, page, step.testId, actionEnd); observation = actual; guard();
              if (['fill', 'click'].includes(step.op)) {
                while (actual.count !== 1 || !actual.visible) {
                  need(actual.count <= 1 && Date.now() < actionEnd);
                  await bounded(new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, actionEnd - Date.now())))), actionEnd); guard(); need(!violation);
                  actual = await observePage(context, page, step.testId, actionEnd); observation = actual; guard();
                }
              }
              if (['count', 'visible', 'text', 'value'].includes(step.op)) {
                const matches = state => step.op === 'count' ? state.count === step.value : step.op === 'visible' ? state.count <= 1 && state.visible === step.value : state.count === 1 && state[step.op] === step.value;
                while (!matches(actual)) {
                  need(Date.now() < actionEnd && (step.op === 'count' || actual.count <= 1));
                  await bounded(new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, actionEnd - Date.now())))), actionEnd); guard(); need(!violation);
                  actual = await observePage(context, page, step.testId, actionEnd); observation = actual; guard();
                }
              }
              if (step.op === 'count') { need(actual.count === step.value); mark(checkId, true, actual.count); }
              else if (step.op === 'visible') { need(actual.count <= 1 && actual.visible === step.value); mark(checkId, true, actual.visible); }
              else {
                need(actual.count === 1);
                if (step.op === 'fill' || step.op === 'click') {
                  guard(); need(!violation && actual.visible && Date.now() < actionEnd); const control = page.getByTestId(step.testId), timeout = Math.min(actionEnd - Date.now(), remaining()); need(timeout > 0);
                  await bounded(step.op === 'fill' ? control.fill(step.value, { timeout }) : control.click({ timeout }), actionEnd);
                  guard(); need(!violation && Date.now() <= actionEnd);
                  mark(checkId, true, step.op === 'fill' ? step.value : '已点击唯一可见控件');
                } else { const value = actual[step.op]; need(value === step.value); mark(checkId, true, value); }
              }
            }
            guard(); need(!violation);
          } catch (cause) {
            const boundedState = observation && Object.fromEntries(Object.entries(observation).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 512) : value]));
            mark(checkId, false, JSON.stringify({ operation: step.op, testId: step.testId ?? null, expected: step.value ?? step.expectedPath ?? step.path, observed: boundedState, currentGuardSatisfied: !controller.signal.aborted && !violation, guardFailures: { ...guardFailures } })); throw cause;
          }
        }
        for (const { context, page } of local.values()) { const state = await observePage(context, page); need(state.width === view.width && state.scroll <= state.width + 1); }
        need(!violation); mark(`BROWSER-${view.id}-GUARD`, true, '精确同源、无错误与溢出');
      } finally {
        for (const { context } of local.values()) { await cleanupBound(Promise.resolve().then(() => context.close()), 1500).catch(() => {}); contexts.delete(context); }
        if (runtime) await stop(runtime, 'runtime');
      }
    }
    try {
      options = optionsData(raw); binding = copyBrowserScenarioData(options.binding, 8192);
      need(binding && Object.keys(binding).length === bindingKeys.length && bindingKeys.every(key => typeof binding[key] === 'string'), 'invalid_binding');
      for (const key of ['projectId', 'runId', 'taskId', 'attemptId']) need(/^[A-Za-z0-9_-]{1,128}$/u.test(binding[key]), 'invalid_binding');
      for (const key of ['specRevision', 'planRevision', 'sourceHash', 'manifestHash', 'browserPolicyHash', 'reviewPolicyHash']) need(/^[a-f0-9]{64}$/u.test(binding[key]), 'invalid_binding');
      need(/^[a-f0-9]{40}$/u.test(binding.candidateCommit), 'invalid_binding');
      need(options.signal === undefined || options.signal instanceof AbortSignal, 'invalid_options');
      need(options.executable === undefined || typeof options.executable === 'string' && path.isAbsolute(options.executable) && !options.executable.includes('\0'), 'invalid_options');
      const manifest = compiledManifestDefinition(options.manifest);
      definition = normalizeBrowserScenario(manifest.browser, manifest.requirements);
      need(binding.manifestHash === manifest.manifestHash && binding.browserPolicyHash === browserScenarioPolicyHash, 'invalid_binding');
      canonicalFiles = validateProjectFiles(copyBrowserScenarioData(options.files, 4 * 1024 * 1024));
      need(canonicalFiles.some(file => file.path === 'src/app.mjs') && binding.sourceHash === hash(canonicalFiles), 'invalid_binding');
      const budget = options.timeoutMs ?? definition.limits.timeoutMs;
      need(Number.isSafeInteger(budget) && budget >= 1 && budget <= 120000, 'invalid_options');
      deadline = Date.now() + Math.min(budget, definition.limits.timeoutMs);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, deadline - Date.now()));
      options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
      report.binding = binding; report.sourceHash = binding.sourceHash; report.manifestHash = manifest.manifestHash;
      if (options.datasetSeed !== undefined) { report.dataset = []; datasetMethods = await bounded(import('./planned-verification-dataset.mjs')); guard(); }
      report.checks = browserScenarioChecks(definition).map(item => ({ ...item, actual: '未执行，未获得通过结论', passed: false })); report.checks.forEach(item => checks.set(item.id, item));
      guard();
      const root = await bounded(trustedDirectory(options.rootDir)); report.workspace = await bounded(mkdtemp(path.join(root, 'browser-scenario-'))); guard();
      for (const view of views) { const target = path.join(report.workspace, view.id.toLowerCase()); await bounded(mkdir(target)); need((await bounded(applyProjectFiles({ workspace: target, files: canonicalFiles }))).sourceHash === report.sourceHash); snapshots.push(target); guard(); }
      mark('BROWSER-SNAPSHOT', true, report.sourceHash);
      session = await acquire(launchBrowser({ signal: controller.signal, timeoutMs: remaining() }), 'browser'); browserStarted = true; report.browser.closed = false;
      need(typeof session.version === 'string' && session.version && session.browser.isConnected()); report.browser.version = session.version; mark('BROWSER-ENGINE', true, session.version);
      for (let index = 0; index < views.length; index++) { guard(); try { await runView(views[index], snapshots[index]); } catch { if (controller.signal.aborted || uncertain) throw new Error('interrupted'); } }
    } catch (cause) { uncertain ||= cause?.reconciliationRequired === true || cause?.result?.terminationConfirmed === false || cause?.code === 'migration_stop_unknown'; remember(cause?.processRecord ?? cause?.result); report.error = '浏览器执行未获得完整有效结论；请核对批准、来源、预算及停止证据。'; }
    finally {
      finishing = true;
      if (options?.datasetSeed !== undefined && pending.size > 0) controller.abort();
      await cleanupBound(Promise.allSettled([...pending]), 500).catch(() => { uncertain = true; });
      await Promise.allSettled([...contexts].map(context => cleanupBound(Promise.resolve().then(() => context.close()), 1500)));
      await Promise.allSettled([...resources].map(resource => stop(resource, resource === session || resource?.browser ? 'browser' : 'runtime')));
      try {
        const expectedRuntimes = 2 + 2 * definition.steps.filter(step => step.op === 'createWithDelayedLoad').length;
        guard(); need(browserStarted && report.browser.closed && processes.length === expectedRuntimes + 1);
        need(processes.filter(record => record.kind === 'browser').length === 1 && processes.filter(record => record.kind === 'runtime').length === expectedRuntimes);
        need(processes.every(record => record.terminationConfirmed === true && record.status === 'stopped' && record.exitCode === 0 && (record.kind === 'browser' || record.stopAcknowledged === true && record.sourceUnchanged === true)));
        for (const snapshot of snapshots) { need(hash(await readProjectFiles(snapshot)) === report.sourceHash); guard(); }
        if (options.datasetSeed !== undefined) {
          need(report.dataset.length === expectedRuntimes);
          for (const receipt of report.dataset) datasetMethods.assertPlannedVerificationDatasetReceipt(options.datasetSeed, receipt, { manifest: options.manifest, binding, phase: receipt.phase });
        }
        need(!uncertain && pending.size === 0); mark('BROWSER-FINAL', true, '同版本与正常停止已确认');
      } catch { mark('BROWSER-FINAL', false, '源码、批准或正常停止证据不完整'); }
      // No await or observer can revoke the manifest between this check and publication.
      try { guard(); if (options?.datasetSeed !== undefined) for (const receipt of report.dataset) datasetMethods.assertPlannedVerificationDatasetReceipt(options.datasetSeed, receipt, { manifest: options.manifest, binding, phase: receipt.phase }); } catch { mark('BROWSER-FINAL', false, '最终发布前批准、时间或取消状态已变化'); }
      clearTimeout(timer); if (options?.signal instanceof AbortSignal) options.signal.removeEventListener('abort', abort);
      report.processes = processes; report.terminationConfirmed = !uncertain && pending.size === 0 && processes.every(record => record.terminationConfirmed === true);
      report.status = !report.terminationConfirmed ? 'reconciliation_required' : diagnosticExceeded ? 'failed' : timedOut ? 'timed_out' : controller.signal.aborted ? 'cancelled' : report.checks.length > 0 && report.checks.every(item => item.passed) && !report.error ? 'passed' : browserStarted ? 'failed' : 'error';
      if (report.status !== 'passed') report.error ??= '浏览器清单未全部通过；结构覆盖不等于业务充分。'; finished = true;
    }
    return report;
  };
}
export const runBrowserScenarios = createBrowserScenarioService();
