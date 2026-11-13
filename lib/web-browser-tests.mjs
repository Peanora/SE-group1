import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { minimalEnv } from './managed-process.mjs';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { startWebRuntime } from './web-runtime.mjs';
import { webProfile } from './web-profile.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const views = Object.freeze([{ id: 'DESKTOP', width: 1365, height: 900 }, { id: 'MOBILE', width: 390, height: 844 }].map(Object.freeze));
const flow = Object.freeze([
  ['LOGIN', '有标签及键盘焦点的登录表单，浏览器会话身份正确'],
  ['BORROW', '网页借阅book-1，独立HTTP会话观察真实记录和库存'],
  ['RETURN', '我的记录归还，独立HTTP会话观察归还及库存恢复'],
  ['LOGOUT', '网页退出后旧浏览器会话失效'],
  ['ADMIN', '管理员网页新增图书，独立HTTP核对馆藏'],
  ['AUDIT', '网页审计显示真实action/actorId/targetId'],
  ['LAYOUT', '所有已执行界面无横向溢出，固定输入有标签和焦点'],
  ['CONSOLE', '浏览器控制台无error且无pageerror'],
  ['NETWORK', '精确同源请求；禁止远程请求、WebSocket、下载及弹窗'],
].map(Object.freeze));
const definitions = Object.freeze([
  ['BROWSER-SOURCE', '两个视口使用独立源码快照和全新运行数据库'],
  ['BROWSER-ENGINE', '启动新的隔离headless Microsoft Edge浏览器'],
  ...views.flatMap(view => flow.map(([id, name]) => [`BROWSER-${view.id}-${id}`, name])),
  ['BROWSER-CLOSE', '浏览器和所有运行进程确认停止，源码保持原版本'],
].map(Object.freeze));
export const browserManifest = Object.freeze({
  hash: hash(JSON.stringify({ task: webProfile.task, definitions, implementation: hash(readFileSync(new URL(import.meta.url))) })),
  count: definitions.length,
  checks: Object.freeze(definitions.map(([id, name]) => Object.freeze({ id, name }))),
});

class BrowserServiceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const need = condition => { if (!condition) throw new BrowserServiceError('assertion', '固定浏览器业务断言未满足。'); };
const issue = (code, message) => new BrowserServiceError(code, message);
const bounded = value => String(value).slice(0, 1000);

async function trustedParent(directory) {
  need(typeof directory === 'string' && path.isAbsolute(directory) && !directory.includes('\0'));
  directory = path.resolve(directory);
  need(directory !== path.parse(directory).root);
  for (let current = directory;; current = path.dirname(current)) {
    const info = await lstat(current);
    const canonical = await realpath(current);
    need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ? canonical.toLowerCase() === current.toLowerCase() : canonical === current));
    if (current === path.dirname(current)) return directory;
  }
}

// Only this freshly launched server is connected. User browser sessions are never inspected.
async function launchEdge({ timeoutMs, signal }) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw issue('browser_dependency', '缺少固定版本playwright-core运行依赖，请按锁文件安装。'); }
  if (signal.aborted) throw issue('cancelled', '浏览器验收已取消。');
  let server;
  try {
    server = await chromium.launchServer({ channel: 'msedge', headless: true, chromiumSandbox: true,
      timeout: Math.min(timeoutMs, 10_000), env: minimalEnv(),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
  } catch { throw issue('browser_unavailable', '无法启动新的headless Microsoft Edge，请安装兼容浏览器并检查运行权限。'); }
  const child = server.process(), startedAt = new Date().toISOString();
  let exited = child.exitCode !== null || child.signalCode !== null;
  let exitResolve;
  const exit = new Promise(resolve => { exitResolve = resolve; });
  if (exited) exitResolve();
  child.once('close', () => { exited = true; exitResolve(); });
  let browser, closing;
  const close = () => closing ??= (async () => {
    let timer;
    try {
      const graceful = (async () => { try { await browser?.close(); } finally { await server.close(); } await exit; })();
      await Promise.race([graceful, new Promise((_, reject) => { timer = setTimeout(() => reject(issue('browser_stop', '浏览器停止未确认。')), 5000); })]);
    } catch {
      let forcedTimer;
      try { await Promise.race([server.kill().then(() => exit), new Promise((_, reject) => { forcedTimer = setTimeout(() => reject(issue('browser_stop', '浏览器强制停止未确认。')), 3000); })]); }
      catch { /* The close record, not a request to kill, determines confirmation. */ }
      finally { clearTimeout(forcedTimer); }
    } finally { clearTimeout(timer); }
    return { kind: 'browser', pid: child.pid ?? null, startedAt, finishedAt: new Date().toISOString(),
      exitCode: child.exitCode, terminationConfirmed: exited, status: exited ? 'stopped' : 'reconciliation_required' };
  })();
  try {
    if (signal.aborted) throw issue('cancelled', '浏览器验收已取消。');
    browser = await chromium.connect(server.wsEndpoint(), { timeout: Math.min(timeoutMs, 5000) });
    if (signal.aborted) throw issue('cancelled', '浏览器验收已取消。');
    return { browser, version: browser.version(), close };
  } catch (cause) {
    const record = await close();
    throw Object.assign(cause instanceof BrowserServiceError ? cause : issue('browser_unavailable', '新浏览器连接失败。'), { processRecord: record });
  }
}

/** Trusted adapters support deterministic failure tests; the public entry accepts no adapters or verdicts. */
export function createWebBrowserTestService({ startRuntime = startWebRuntime, launchBrowser = launchEdge } = {}) {
  return async function run({ rootDir, files, signal, executable = process.env.EXECUTION_SANDBOX_EXE, timeoutMs = 60_000 } = {}) {
    const checks = definitions.map(([id, name]) => ({ id, name, passed: false, error: '未执行，未获得通过结论。' }));
    const processes = [], contexts = new Set(), stopPromises = new Map(), contextClosures = new Map();
    const report = { status: 'error', profileId: webProfile.id, sourceHash: null, manifestHash: browserManifest.hash,
      checks, processes, terminationConfirmed: false, browser: { version: null, closed: true, console: [], pageErrors: [], blocked: [], layouts: [] }, error: null, workspace: null };
    const controller = new AbortController();
    let timer, timedOut = false, session = null, activeRuntime = null, closingBrowser = null, launched = false;
    let canonicalFiles, snapshots = [];
    const started = Date.now();
    const guard = () => { if (controller.signal.aborted) throw issue(timedOut ? 'timed_out' : 'cancelled', timedOut ? '浏览器验收总时长预算已耗尽。' : '浏览器验收已取消。'); };
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
    const remember = record => { if (record && !processes.includes(record)) processes.push(record); };
    const stopRuntime = current => {
      if (!current) return Promise.resolve();
      if (!stopPromises.has(current)) stopPromises.set(current, Promise.resolve().then(() => current.stop()).then(record => { remember(record); return record; }));
      return stopPromises.get(current);
    };
    const closeContext = context => {
      if (!contextClosures.has(context)) contextClosures.set(context, (async () => {
        let closeTimer;
        try { await Promise.race([Promise.resolve().then(() => context.close()), new Promise(resolve => { closeTimer = setTimeout(resolve, 1500); })]); }
        catch { /* Browser process termination below is the final confirmation for all its contexts. */ }
        finally { clearTimeout(closeTimer); }
      })());
      return contextClosures.get(context);
    };
    const closeBrowser = () => {
      if (!session) return Promise.resolve();
      return closingBrowser ??= Promise.resolve().then(() => session.close()).then(record => { remember(record); report.browser.closed = record?.terminationConfirmed === true; return record; });
    };
    const cancelResources = () => {
      for (const context of contexts) void closeContext(context);
      void stopRuntime(activeRuntime).catch(() => {});
      void closeBrowser().catch(() => {});
    };
    const abort = () => { controller.abort(); cancelResources(); };
    // Race operations that do not create processes. Launches themselves settle/clean up before returning.
    async function boundedOperation(promise) {
      if (controller.signal.aborted) { Promise.resolve(promise).catch(() => {}); guard(); }
      let rejectAbort;
      const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(issue(timedOut ? 'timed_out' : 'cancelled', '浏览器操作已停止。')); });
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      try { const value = await Promise.race([promise, interrupted]); guard(); return value; }
      finally { controller.signal.removeEventListener('abort', rejectAbort); }
    }
    async function check(id, dependencies, fn) {
      const entry = checks.find(item => item.id === id);
      try {
        guard(); need(dependencies.every(prior => checks.find(item => item.id === prior)?.passed));
        await fn(); guard(); entry.passed = true; delete entry.error;
      } catch (cause) {
        entry.passed = false;
        entry.error = controller.signal.aborted ? (timedOut ? '总时长预算耗尽。' : '验收已取消。')
          : cause?.code === 'assertion' ? '固定业务、界面或前置检查未满足。' : '固定浏览器操作失败或等待超时。';
      }
    }
    async function json(runtime, cookie, method, route, body, expected = 200) {
      guard();
      const response = await boundedOperation(runtime.request({ method, path: route, headers: { accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? '' : JSON.stringify(body) }));
      need(response.status === expected && /^application\/json(?:;|$)/iu.test(response.headers['content-type'] ?? ''));
      let data;
      try { data = JSON.parse(Buffer.from(response.body).toString('utf8')); } catch { need(false); }
      need(data && typeof data === 'object' && !Array.isArray(data));
      return { data, headers: response.headers };
    }
    async function loginHttp(runtime, name) {
      const account = webProfile.task.accounts.find(item => item.id === name);
      const response = await json(runtime, '', 'POST', '/api/login', { username: account.username, password: account.password });
      need(response.data.user?.id === account.id && response.data.user?.role === account.role);
      const cookie = response.headers['set-cookie']?.find(value => /^app_session=[^;]+;/u.test(value))?.split(';')[0];
      need(cookie); return cookie;
    }
    async function browserCookie(context, url) {
      const cookies = await boundedOperation(context.cookies(url));
      const own = cookies.filter(item => /^tf_[a-f0-9]{48}_app_session$/u.test(item.name));
      need(own.length === 1 && own[0].httpOnly && own[0].value);
      return `app_session=${own[0].value}`;
    }
    async function eventually(fn) {
      const end = Math.min(started + timeoutMs, Date.now() + 3500);
      for (;;) {
        guard();
        if (await fn()) return;
        need(Date.now() < end);
        await boundedOperation(new Promise(resolve => setTimeout(resolve, 75)));
      }
    }
    // CDP isolated worlds use platform intrinsics, rather than candidate-modifiable main-world observers.
    async function inspect(context, page, id = null) {
      const cdp = await boundedOperation(context.newCDPSession(page));
      try {
        const { frameTree } = await boundedOperation(cdp.send('Page.getFrameTree'));
        const { executionContextId } = await boundedOperation(cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: `taskflow-observer-${randomUUID()}` }));
        const result = await boundedOperation(cdp.send('Runtime.callFunctionOn', { executionContextId, returnByValue: true,
          functionDeclaration: `function(id) {
            const nodes = id === null ? [] : Array.from(document.querySelectorAll('[data-testid]')).filter(node => node.getAttribute('data-testid') === id);
            const node = nodes.length === 1 ? nodes[0] : null;
            const label = node && (node.getAttribute('aria-label')?.trim() || node.getAttribute('aria-labelledby')?.split(/\\s+/).some(key => document.getElementById(key)?.textContent.trim()) || Array.from(node.labels || []).some(item => item.textContent.trim()));
            return { width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0), count: nodes.length,
              control: node ? { tag: node.tagName, type: node.getAttribute('type'), labelled: !!label, focused: document.activeElement === node,
                named: !!(node.textContent.trim() || node.getAttribute('aria-label')?.trim() || node.getAttribute('value')?.trim()) } : null };
          }`, arguments: [{ value: id }] }));
        need(!result.exceptionDetails && result.result?.value);
        return result.result.value;
      } finally { await cdp.detach().catch(() => {}); }
    }
    async function control(context, page, id, input = false, password = false) {
      const locator = page.getByTestId(id);
      need(await boundedOperation(locator.count()) === 1);
      await boundedOperation(locator.waitFor({ state: 'visible', timeout: Math.min(2000, remaining()) }));
      await boundedOperation(locator.focus({ timeout: Math.min(2000, remaining()) }));
      const result = await inspect(context, page, id);
      need(result.count === 1 && result.control?.focused);
      if (input) need(result.control.tag === 'INPUT' && result.control.labelled && (!password || result.control.type === 'password'));
      else need(['BUTTON', 'INPUT'].includes(result.control.tag) && result.control.named);
      return locator;
    }
    async function runView(view, workspace) {
      let context, runtime;
      const prefix = `BROWSER-${view.id}-`, errors = [], blocked = [], layout = [];
      let page, adminCookie, oldBrowserCookie, loan, createdBook;
      const snapshotLayout = async () => { const state = await inspect(context, page); layout.push(state); observe('layouts', { width: state.width, scroll: state.scroll }); need(state.width === view.width && state.scroll <= state.width + 1); };
      const getList = async (who, route, key) => { const { data } = await json(runtime, who, 'GET', route); need(Array.isArray(data[key])); return data[key]; };
      const observe = (kind, value) => {
        const record = { viewport: view.id, ...value };
        const list = report.browser[kind];
        if (list.length < 100) list.push(record);
        else { blocked.push('diagnostic_limit'); abort(); }
      };
      try {
        guard();
        try { runtime = await startRuntime({ workspace, executable, signal: controller.signal, timeoutMs: remaining(), requestTimeoutMs: Math.min(3500, remaining()), maxOutputBytes: 4 * 1024 * 1024 }); }
        catch (cause) { remember(cause?.result); throw issue('runtime_start', '独立浏览器候选运行未能启动。'); }
        activeRuntime = runtime; guard();
        context = await session.browser.newContext({ viewport: { width: view.width, height: view.height }, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
        contexts.add(context); guard();
        context.setDefaultTimeout(Math.min(2500, remaining()));
        context.setDefaultNavigationTimeout(Math.min(4000, remaining()));
        await context.route(/.*/, async route => {
          let allowed = false;
          try { allowed = new URL(route.request().url()).origin === runtime.url; } catch { /* Invalid origins never reach the host network. */ }
          if (!allowed || controller.signal.aborted) {
            blocked.push('request'); observe('blocked', { kind: 'request', url: bounded(route.request().url()) });
            await route.abort().catch(() => {});
          } else await route.continue().catch(() => {});
        });
        await context.routeWebSocket(/.*/, async socket => { blocked.push('websocket'); observe('blocked', { kind: 'websocket', url: bounded(socket.url()) }); await socket.close({ code: 1008, reason: 'Platform preview disallows WebSockets' }).catch(() => {}); });
        let admittedPage = false;
        context.on('page', created => {
          if (admittedPage) { blocked.push('popup'); observe('blocked', { kind: 'popup' }); void created.close().catch(() => {}); return; }
          admittedPage = true;
          created.on('console', message => { observe('console', { type: message.type(), text: bounded(message.text()) }); if (message.type() === 'error') errors.push('console'); });
          created.on('pageerror', cause => { observe('pageErrors', { text: bounded(cause.message) }); errors.push('pageerror'); });
          created.on('download', download => { blocked.push('download'); observe('blocked', { kind: 'download' }); void download.cancel().catch(() => {}); });
          created.on('dialog', dialog => { blocked.push('dialog'); observe('blocked', { kind: 'dialog' }); void dialog.dismiss().catch(() => {}); });
        });
        page = await context.newPage(); guard();
        await boundedOperation(page.goto(`${runtime.url}/`, { waitUntil: 'domcontentloaded', timeout: Math.min(4000, remaining()) }));
        await check(`${prefix}LOGIN`, ['BROWSER-ENGINE'], async () => {
          const username = await control(context, page, 'login-username', true);
          const password = await control(context, page, 'login-password', true, true);
          await snapshotLayout();
          await boundedOperation(username.fill('alice')); await boundedOperation(password.fill('alice-pass'));
          await boundedOperation((await control(context, page, 'login-submit')).click());
          await boundedOperation(page.getByTestId('book-list').waitFor({ state: 'visible' }));
          oldBrowserCookie = await browserCookie(context, runtime.url);
          const user = (await json(runtime, oldBrowserCookie, 'GET', '/api/me')).data.user;
          need(user?.id === 'alice' && user.role === 'member');
          adminCookie = await loginHttp(runtime, 'admin');
          need((await getList(adminCookie, '/api/loans', 'loans')).length === 0);
          await snapshotLayout();
        });
        await check(`${prefix}BORROW`, [`${prefix}LOGIN`], async () => {
          await boundedOperation(page.getByTestId('book-book-1').waitFor({ state: 'visible' }));
          await boundedOperation((await control(context, page, 'borrow-book-1')).click());
          await eventually(async () => {
            const active = (await getList(adminCookie, '/api/loans', 'loans')).filter(item => item.bookId === 'book-1' && item.userId === 'alice' && item.status === 'active');
            loan = active[0];
            return active.length === 1 && (await getList(adminCookie, '/api/books', 'books')).find(item => item.id === 'book-1')?.available === 0;
          });
          need(typeof loan.id === 'string' && loan.id);
          await boundedOperation(page.getByTestId('my-loans').waitFor({ state: 'visible' }));
          await boundedOperation(page.getByTestId(`loan-${loan.id}`).waitFor({ state: 'visible' }));
          await snapshotLayout();
        });
        await check(`${prefix}RETURN`, [`${prefix}BORROW`], async () => {
          await boundedOperation((await control(context, page, `return-${loan.id}`)).click());
          await eventually(async () => (await getList(adminCookie, '/api/loans', 'loans')).find(item => item.id === loan.id)?.status === 'returned'
            && (await getList(adminCookie, '/api/books', 'books')).find(item => item.id === 'book-1')?.available === 1);
          await snapshotLayout();
        });
        await check(`${prefix}LOGOUT`, [`${prefix}RETURN`], async () => {
          await boundedOperation((await control(context, page, 'logout')).click());
          await boundedOperation(page.getByTestId('login-username').waitFor({ state: 'visible' }));
          await json(runtime, oldBrowserCookie, 'GET', '/api/me', undefined, 401);
          await snapshotLayout();
        });
        await check(`${prefix}ADMIN`, [`${prefix}LOGOUT`], async () => {
          await boundedOperation((await control(context, page, 'login-username', true)).fill('admin'));
          await boundedOperation((await control(context, page, 'login-password', true, true)).fill('admin-pass'));
          await boundedOperation((await control(context, page, 'login-submit')).click());
          await boundedOperation(page.getByTestId('audit-list').waitFor({ state: 'visible' }));
          const user = (await json(runtime, await browserCookie(context, runtime.url), 'GET', '/api/me')).data.user;
          need(user?.id === 'admin' && user.role === 'admin');
          const title = `浏览器验收图书-${view.id}`;
          await boundedOperation((await control(context, page, 'admin-book-title', true)).fill(title));
          await boundedOperation((await control(context, page, 'admin-book-copies', true)).fill('2'));
          await boundedOperation((await control(context, page, 'admin-book-submit')).click());
          // Finish UI mutations before a fresh observer login; single-session-per-user policies remain valid.
          await eventually(async () => (await boundedOperation(page.getByTestId('book-list').innerText())).includes(title)
            && (await boundedOperation(page.getByTestId('audit-list').innerText())).includes('create_book'));
          adminCookie = await loginHttp(runtime, 'admin');
          await eventually(async () => {
            const matches = (await getList(adminCookie, '/api/books', 'books')).filter(item => item.title === title);
            createdBook = matches[0]; return matches.length === 1 && createdBook.copies === 2 && createdBook.available === 2;
          });
          need(typeof createdBook.id === 'string' && createdBook.id);
          await boundedOperation(page.getByTestId(`book-${createdBook.id}`).waitFor({ state: 'visible' }));
          await snapshotLayout();
        });
        await check(`${prefix}AUDIT`, [`${prefix}ADMIN`], async () => {
          const expected = [{ action: 'borrow', actorId: 'alice', targetId: loan.id }, { action: 'return', actorId: 'alice', targetId: loan.id }, { action: 'create_book', actorId: 'admin', targetId: createdBook.id }];
          const events = await getList(adminCookie, '/api/audit', 'events');
          need(events.length === expected.length);
          for (const event of expected) need(events.filter(item => item.action === event.action && item.actorId === event.actorId && item.targetId === event.targetId && Number.isFinite(Date.parse(item.at))).length === 1);
          const audit = page.getByTestId('audit-list');
          await boundedOperation(audit.waitFor({ state: 'visible' }));
          await eventually(async () => { const text = await boundedOperation(audit.innerText()); return expected.every(event => Object.values(event).every(value => text.includes(value))); });
          await snapshotLayout();
        });
      } finally {
        await check(`${prefix}LAYOUT`, [`${prefix}AUDIT`], async () => need(layout.length >= 7 && layout.every(item => item.width === view.width && item.scroll <= view.width + 1)));
        await check(`${prefix}CONSOLE`, [], async () => need(page && errors.length === 0));
        await check(`${prefix}NETWORK`, [], async () => need(page && blocked.length === 0));
        if (context) await closeContext(context);
        if (runtime) await stopRuntime(runtime);
        if (activeRuntime === runtime) activeRuntime = null;
      }
    }
    try {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || signal !== undefined && !(signal instanceof AbortSignal)) throw issue('invalid_options', '浏览器验收预算或取消信号无效。');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
      guard();
      canonicalFiles = validateProjectFiles(files);
      need(canonicalFiles.some(file => file.path === 'src/app.mjs'));
      report.sourceHash = hash(JSON.stringify(canonicalFiles));
      const root = await trustedParent(rootDir); guard();
      report.workspace = await mkdtemp(path.join(root, 'browser-validation-')); guard();
      for (const view of views) {
        const workspace = path.join(report.workspace, view.id.toLowerCase());
        await mkdir(workspace); guard();
        need((await applyProjectFiles({ workspace, files: canonicalFiles })).sourceHash === report.sourceHash);
        snapshots.push(workspace); guard();
      }
      await check('BROWSER-SOURCE', [], async () => need(snapshots.length === views.length));
      session = await launchBrowser({ timeoutMs: remaining(), signal: controller.signal });
      launched = true; report.browser.closed = false; report.browser.version = session.version;
      guard(); need(typeof session.version === 'string' && session.version.trim());
      await check('BROWSER-ENGINE', ['BROWSER-SOURCE'], async () => need(session.browser.isConnected()));
      for (const [index, view] of views.entries()) {
        guard();
        try { await runView(view, snapshots[index]); }
        catch (cause) { if (controller.signal.aborted) throw cause; report.error = cause instanceof BrowserServiceError ? cause.message : '独立浏览器场景执行失败。'; }
      }
    } catch (cause) {
      remember(cause?.processRecord); remember(cause?.result);
      report.error = controller.signal.aborted ? (timedOut ? '浏览器验收总时长预算已耗尽。' : '浏览器验收已取消，未发布通过结论。')
        : cause instanceof BrowserServiceError ? cause.message : '浏览器验收初始化或执行失败，未发布通过结论。';
    } finally {
      await Promise.allSettled([...contexts].map(closeContext));
      await stopRuntime(activeRuntime).catch(() => {});
      await closeBrowser().catch(() => { report.browser.closed = false; });
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      report.terminationConfirmed = report.browser.closed && processes.every(item => item.terminationConfirmed === true);
      const closeCheck = checks.find(item => item.id === 'BROWSER-CLOSE');
      try {
        need(launched && report.browser.closed && report.terminationConfirmed && processes.length >= 3);
        need(processes.every(item => item.status === 'stopped' && (item.kind === 'browser' || item.sourceUnchanged === true)));
        for (const workspace of snapshots) need(hash(JSON.stringify(await readProjectFiles(workspace))) === report.sourceHash);
        guard(); closeCheck.passed = true; delete closeCheck.error;
      } catch { closeCheck.passed = false; closeCheck.error = '源码完整性或浏览器/运行进程停止未获得完整通过证据。'; }
      report.status = !report.terminationConfirmed ? 'reconciliation_required' : controller.signal.aborted ? (timedOut ? 'timed_out' : 'cancelled')
        : checks.every(item => item.passed === true) ? 'passed' : checks.find(item => item.id === 'BROWSER-ENGINE').passed ? 'failed' : 'error';
      if (report.status !== 'passed' && !report.error) report.error = '固定浏览器验收未全部通过；未执行项与失败项均保留。';
    }
    return report;
  };
}

export const runWebBrowserTests = createWebBrowserTestService();
