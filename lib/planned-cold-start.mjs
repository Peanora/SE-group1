import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { minimalEnv } from './managed-process.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { compiledManifestDefinition } from './verification-contract.mjs';
import { startWebRuntime } from './web-runtime.mjs';

const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const digest = files => createHash('sha256').update(JSON.stringify(files)).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };

function monitor(context, origin) {
  const faults = [];
  const add = code => { if (!faults.includes(code)) faults.push(code); };
  context.on('page', page => {
    page.on('pageerror', () => add('script_error'));
    page.on('console', message => { if (message.type() === 'error') add('console_error'); });
    page.on('dialog', dialog => { add('dialog'); void dialog.dismiss().catch(() => {}); });
    page.on('download', () => add('download'));
  });
  return { faults, allow: url => new URL(url).origin === origin || (add('external_request'), false) };
}

// The probe owns both delays. Browser requests can only reach the isolated app.
export async function probeCreateAtStartup({ context, origin, step, timeout = 8000 }) {
  const runtimeUrl = new URL(origin);
  check(runtimeUrl.origin === origin && runtimeUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(runtimeUrl.hostname), 'invalid_runtime_origin');
  const { faults, allow } = monitor(context, origin);
  const scriptSeen = deferred(), releaseScript = deferred(), loadSeen = deferred(), releaseLoad = deferred(), earlyNavigation = deferred();
  const observation = { blockedBeforeScript: null, blockedBeforeData: null, earlyNavigation: false, posted: 0, status: null };
  const target = origin + step.path, endpoint = origin + step.loadPath;
  let scriptReleased = false, heldLoad = false, entered = false, page;
  const wait = async (promise, code, duration = timeout) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), duration); })]); }
    finally { clearTimeout(timer); }
  };
  await context.routeWebSocket('**/*', socket => { faults.push('websocket'); socket.close(); });
  await context.route('**/*', async route => {
    const request = route.request();
    try {
      if (!allow(request.url())) { await route.abort(); return; }
      if (request.resourceType() === 'script' && !scriptReleased) { scriptSeen.resolve(); await releaseScript.promise; }
      if (request.url() === endpoint && request.method() === 'GET' && !heldLoad) { heldLoad = true; loadSeen.resolve(); await releaseLoad.promise; }
      await route.continue();
    } catch { /* Closing the browser may cancel a held route. */ }
  });
  page = await context.newPage();
  page.on('request', request => {
    if (request.url() === endpoint && request.method() === 'POST') observation.posted++;
    if (entered && request.isNavigationRequest() && request.frame() === page.mainFrame() && !scriptReleased) {
      observation.earlyNavigation = true; earlyNavigation.resolve();
    }
  });
  try {
    const response = await page.goto(target, { waitUntil: 'commit', timeout });
    check(response?.ok() && page.url() === target, 'initial_navigation');
    entered = true;
    const button = page.getByTestId(step.submitTestId), input = page.getByTestId(step.inputTestId);
    await button.waitFor({ timeout });
    await wait(scriptSeen.promise, 'script_not_observed');
    observation.blockedBeforeScript = await button.isDisabled({ timeout });
    if (!observation.blockedBeforeScript) {
      if (await input.isEditable({ timeout })) await input.fill(step.value, { timeout });
      await button.click({ timeout, noWaitAfter: true }).catch(() => {});
      await wait(earlyNavigation.promise, 'no_native_navigation', 500).catch(() => {});
      check(false, 'form_available_before_script');
    }
    if (await input.isEditable({ timeout })) {
      await input.fill(step.value, { timeout });
      await input.press('Enter', { timeout, noWaitAfter: true });
    }
    check(!observation.earlyNavigation && observation.posted === 0, 'submitted_before_script');
    scriptReleased = true; releaseScript.resolve();
    await wait(loadSeen.promise, 'initial_data_request_not_observed');
    observation.blockedBeforeData = await button.isDisabled({ timeout });
    check(observation.blockedBeforeData && observation.posted === 0, 'form_available_before_data');
    releaseLoad.resolve();
    await input.fill(step.value, { timeout });
    const posted = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST', { timeout });
    posted.catch(() => {});
    await button.click({ timeout });
    const result = await posted; observation.status = result.status();
    check(result.ok() && await result.finished() === null && observation.posted === 1, 'first_submission_failed');
    await assertCreatedValues(page, step, timeout);
    check(page.url() === target && faults.length === 0, 'browser_boundary_or_page_error');
    return { passed: true, ...observation, faults };
  } catch (error) {
    return { passed: false, code: error.code ?? error.name, ...observation, faults };
  } finally { releaseScript.resolve(); releaseLoad.resolve(); }
}

async function assertCreatedValues(page, step, timeout) {
  await page.getByTestId(step.listTestId).filter({ hasText: step.value }).waitFor({ timeout });
  const count = await page.getByTestId(step.countTestId).textContent({ timeout });
  check(count?.trim() === String(step.expectedCount), 'unexpected_created_count');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'layout_overflow');
}

/** Additional diagnostics against fixed source. Does not grant delivery or reuse Review. */
export async function runPlannedColdStart({ manifest, files, rootDir, executable, signal }) {
  const definition = compiledManifestDefinition(manifest);
  const unique = new Map();
  for (const step of definition.browser?.steps ?? []) if (step.op === 'createWithDelayedLoad') unique.set(`${step.path}\n${step.loadPath}`, step);
  if (!unique.size) return { status: 'no_approved_create_steps', checks: [], taskAccepted: false, totalModelCalls: 0 };
  const approvedFiles = validateProjectFiles(files), sourceHash = digest(approvedFiles), checks = [];
  if (signal?.aborted) return { status: 'cancelled', checks, sourceHash, edgeStopped: true, taskAccepted: false, totalModelCalls: 0 };
  const server = await chromium.launchServer({ channel: 'msedge', headless: true, chromiumSandbox: true, env: minimalEnv(), timeout: 10000,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions'] });
  const process = server.process();
  let browser, stoppingUnconfirmed = false;
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
    for (const viewport of viewports) for (const step of unique.values()) {
      if (signal?.aborted || stoppingUnconfirmed) break;
      const workspace = await mkdtemp(path.join(rootDir, 'boot-'));
      await applyProjectFiles({ workspace, files: approvedFiles });
      const trial = { width: viewport.width, stepId: step.id, processes: [], startup: null, restart: { passed: false } };
      checks.push(trial);
      const recordStop = result => {
        trial.processes.push({ terminationConfirmed: result.terminationConfirmed, sourceUnchanged: result.sourceUnchanged, stopReason: result.stopReason });
        if (result.terminationConfirmed !== true) stoppingUnconfirmed = true;
      };
      async function withRuntime(work) {
        let app;
        try {
          app = await startWebRuntime({ workspace, executable, signal, timeoutMs: 35000, requestTimeoutMs: 8000 });
        } catch (error) {
          if (error.result) recordStop(error.result);
          throw error;
        }
        try {
          const context = await browser.newContext({ viewport, acceptDownloads: false, serviceWorkers: 'block' });
          try { await work(context, app.url); } finally { await context.close(); }
        } finally {
          try { recordStop(await app.stop()); }
          catch (error) { stoppingUnconfirmed = true; throw error; }
        }
      }
      try {
        await withRuntime(async (context, origin) => { trial.startup = await probeCreateAtStartup({ context, origin, step }); });
        if (trial.startup?.passed && !stoppingUnconfirmed) await withRuntime(async (context, origin) => {
          const { faults, allow } = monitor(context, origin);
          await context.routeWebSocket('**/*', socket => { faults.push('websocket'); socket.close(); });
          await context.route('**/*', route => allow(route.request().url()) ? route.continue() : route.abort());
          const page = await context.newPage(), target = origin + step.path;
          const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 8000 });
          check(response?.ok() && page.url() === target, 'restart_navigation');
          await assertCreatedValues(page, step, 8000);
          check(!faults.length, 'restart_browser_error');
          trial.restart.passed = true;
        });
      } catch (error) { trial.error = error.code ?? error.name; }
      trial.sourceUnchanged = digest(await readProjectFiles(workspace)) === sourceHash;
      trial.passed = trial.startup?.passed === true && trial.restart.passed && trial.sourceUnchanged
        && trial.processes.length === 2 && trial.processes.every(item => item.terminationConfirmed && item.sourceUnchanged && item.stopReason === 'stopped');
    }
  } finally {
    try { await browser?.close(); } finally { await server.close().catch(() => server.kill()); }
  }
  const edgeStopped = process.exitCode !== null || process.signalCode !== null;
  const passed = !signal?.aborted && edgeStopped && checks.length === unique.size * viewports.length && checks.every(item => item.passed);
  const status = !edgeStopped || stoppingUnconfirmed ? 'reconciliation_required' : signal?.aborted ? 'cancelled' : passed ? 'cold_start_passed' : 'cold_start_failed';
  return { status, checks, sourceHash, edgeStopped, taskAccepted: false, totalModelCalls: 0 };
}
