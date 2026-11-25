import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { minimalEnv } from '../lib/managed-process.mjs';
import { contentRevision } from '../lib/planning-review.mjs';
import { createProjectCodeModel } from '../lib/project-code-model.mjs';
import { readProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';

const files = validateProjectFiles([
  { path: 'src/app.mjs', content: `import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

export function createApp({ databasePath }) {
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE IF NOT EXISTS bookings (reference TEXT PRIMARY KEY, slot TEXT UNIQUE NOT NULL)');
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    async handle({ method, path, body }) {
      const route = new URL(path, 'http://local').pathname;
      if (route === '/api/bookings' && method === 'POST') {
        const { reference, slot } = JSON.parse(body);
        db.prepare('INSERT INTO bookings VALUES (?, ?)').run(reference, slot);
        return json(201, { reference, slot });
      }
      if (route === '/api/bookings') return json(200, { bookings: db.prepare('SELECT reference, slot FROM bookings').all() });
      if (route === '/favicon.ico') return { status: 204, headers: {}, body: '' };
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'] };
      if (!Object.hasOwn(assets, route)) return json(404, {});
      const [file, type] = assets[route];
      return { status: 200, headers: { 'content-type': type }, body: await readFile(new URL('../public/' + file, import.meta.url)) };
    },
    close() { db.close(); }
  };
}
` },
  { path: 'public/index.html', content: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>资源预约</title><main><form><label>预约编号 <input data-testid="reference" required></label><button data-testid="book">预约</button></form>
<p data-testid="bookings"></p></main><script src="/app.js" defer></script></html>` },
  { path: 'public/app.js', content: `const form = document.querySelector('form');
const output = document.querySelector('[data-testid="bookings"]');
async function showBookings() {
  const { bookings } = await (await fetch('/api/bookings')).json();
  const reference = new URLSearchParams(location.search).get('reference');
  const visible = reference ? bookings.filter(booking => booking.slot === reference) : bookings;
  output.textContent = visible.map(booking => booking.reference).join(', ');
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const body = JSON.stringify({ reference: form.elements[0].value, slot: '2030-05-02-AM' });
  await fetch('/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  await showBookings();
});
showBookings();
` },
]);
const browserFile = files.find(file => file.path === 'public/app.js');
const correction = { ...browserFile, content: browserFile.content.replace('booking.slot === reference', 'booking.reference === reference') };
const fixedFiles = files.map(file => file.path === correction.path ? correction : file);

async function assertFixture(workspace) {
  const candidate = await readProjectFiles(workspace);
  assert.deepEqual(candidate, candidate.find(file => file.path === browserFile.path)?.content === browserFile.content ? files : fixedFiles);
}

// The fallback transport runs only the exact checked-in fixture bytes. Production still requires MXC.
if (process.argv[2] === '--serve-reservation-fixture') {
  const workspace = process.cwd();
  await assertFixture(workspace);
  const { createApp } = await import(pathToFileURL(path.join(workspace, 'src', 'app.mjs')));
  const app = createApp({ databasePath: path.join(workspace, '.reservation-fixture.sqlite') });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const result = await app.handle({ method: request.method, path: request.url, body });
    response.writeHead(result.status, result.headers).end(result.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.send(`http://127.0.0.1:${server.address().port}`);
  process.once('message', () => server.close(() => { app.close(); process.disconnect(); }));
} else if (!process.env.TASKFLOW_RESERVATION_TEST_CHILD) {
  test('预约返工使用真实 Git、SQLite、HTTP 和 Edge', { skip: process.platform !== 'win32' }, t => {
    const env = { ...process.env, TASKFLOW_RESERVATION_TEST_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', import.meta.filename],
      { env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const line of result.stdout.split('\n')) if (line.startsWith('# 预约证据')) t.diagnostic(line.slice(2));
  });
} else {
  test('刷新读回后，预约编号筛选由失败转为通过', { timeout: 105000 }, async t => {
    const keepFrom = process.env.TASKFLOW_RESERVATION_EVIDENCE;
    const root = keepFrom ? path.resolve(keepFrom) : os.tmpdir();
    if (keepFrom) await mkdir(root, { recursive: true });
    const outputDir = await mkdtemp(path.join(root, 'taskflow-reservation-'));
    if (!keepFrom) t.after(() => {
      assert.equal(path.dirname(path.resolve(outputDir)), path.resolve(root));
      assert.match(path.basename(outputDir), /^taskflow-reservation-/u);
      return rm(outputDir, { recursive: true, force: true });
    });
    if (!process.env.EXECUTION_SANDBOX_EXE) {
      mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, { namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'trusted-reservation-fixture' }) }) } });
      mock.module(new URL('../lib/web-runtime.mjs', import.meta.url).href, { namedExports: { startWebRuntime: async ({ workspace, signal }) => {
        await assertFixture(workspace);
        const child = fork(import.meta.filename, ['--serve-reservation-fixture'], { cwd: workspace, env: minimalEnv(), execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        const done = once(child, 'close');
        t.after(() => { if (child.connected) child.kill(); });
        try {
          const [url] = await once(child, 'message', { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
          let stopping;
          return { url, pid: child.pid, async request({ path, body, ...options }) {
            const response = await fetch(url + path, { ...options, ...(body ? { body } : {}), signal });
            return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
          }, stop: () => stopping ??= (async () => {
            child.send('stop');
            const [exitCode] = await done;
            await assertFixture(workspace);
            return { pid: child.pid, status: 'stopped', terminationConfirmed: true, stopAcknowledged: exitCode === 0, sourceUnchanged: true, exitCode };
          })() };
        } catch (error) { child.kill(); await done; throw error; }
      } } });
    }
    const { startPlannedWebExecution } = await import('../lib/planned-web-executor.mjs');
    const requirements = ['R1'];
    const spec = '资源预约创建后刷新和重启仍可读回，也可按预约编号筛选。';
    const task = { title: '资源预约演示', requirements: [spec], tasks: [{ id: 'BOOK', title: '实现预约', dependsOn: [],
      description: spec, requirementIds: requirements, writePaths: files.map(file => file.path), inputs: [spec], outputs: ['预约页面和 SQLite 数据'], acceptance: [spec] }] };
    const base = { projectId: 'reservation-fixture', runId: 'approved-plan', specRevision: contentRevision(spec), planRevision: contentRevision(task) };
    const request = (id, method, dependsOn, status, body) => ({ id, type: 'request', dependsOn, requirementIds: requirements, request: {
      id: `${id}_request`, method, path: '/api/bookings', ...(body ? { body } : {}), assertions: [{ id: `${id}_status`, op: 'status', value: status },
        ...(method === 'GET' ? [{ id: 'kept_reference', op: 'jsonEquals', path: '$.bookings[0].reference', value: 'API-1' }] : [])],
    } });
    const step = (id, op, fields) => ({ id, op, session: 'visitor', requirementIds: requirements, ...fields });
    const proposal = { id: 'reservation-checks', version: 1, name: '预约与编号筛选', sessions: [], steps: [
      request('book', 'POST', [], 201, { reference: 'API-1', slot: '2030-05-01-AM' }),
      { id: 'restart', type: 'restart', dependsOn: ['book'], requirementIds: requirements }, request('reload', 'GET', ['restart'], 200),
    ], browser: { version: 1, sessions: ['visitor'], limits: { timeoutMs: 25000, actionTimeoutMs: 2000 }, steps: [
      step('home', 'goto', { path: '/' }), step('reference', 'fill', { testId: 'reference', value: 'WEB-1' }),
      step('book', 'click', { testId: 'book' }), step('created', 'text', { testId: 'bookings', value: 'WEB-1' }),
      step('refresh', 'goto', { path: '/' }), step('kept', 'text', { testId: 'bookings', value: 'WEB-1' }),
      step('search', 'goto', { path: '/?reference=WEB-1' }), step('filtered', 'text', { testId: 'bookings', value: 'WEB-1' }),
    ] } };
    const input = { proposal, requirements, binding: base }, control = createVerificationControl();
    const approval = control.approve({ ...input, feedback: '固定现场预约演示的验收清单' });
    const manifest = compileManifest({ ...input, approval }); control.beginCoding(approval);
    const calls = [];
    const provider = createProjectCodeModel({ config: { baseUrl: 'http://localhost:1/v1', model: 'reservation-fixture', apiKey: '' }, fetchImpl: async (_url, options) => {
      const call = JSON.parse(JSON.parse(options.body).messages[1].content);
      calls.push(call);
      if (calls.length === 2) {
        assert.deepEqual(call.files, files);
        const { browser } = JSON.parse(call.feedback);
        assert.deepEqual(browser.map(({ id, expected, actual }) => ({ id, expected, actual })), ['DESKTOP', 'MOBILE'].map(view => ({
          id: `BROWSER-${view}-filtered`, expected: 'WEB-1', actual: '',
        })));
      }
      const content = JSON.stringify({ files: calls.length === 1 ? files : [correction] });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    } });
    const execution = startPlannedWebExecution({ outputDir, binding: { ...base, taskId: 'BOOK' }, task, manifest, provider,
      reviewer: async ({ onReceipt }) => {
        const result = { summary: '离线演示', issues: [], resolutions: [] };
        await onReceipt({ model: 'reservation-review-fixture', finishReason: 'stop', content: JSON.stringify(result), usage: { inputTokens: 0, outputTokens: 0 } });
        return result;
      }, providerKind: 'trusted_fixture', reviewerKind: 'diagnostic',
      assertCurrent: () => true, maxCalls: 2, maxReviewCalls: 1, timeoutMs: 90000 });
    const record = await execution.done;
    const [first, second] = record.versions;
    const check = (version, view, id) => version.acceptance.browser.checks.find(item => item.id === `BROWSER-${view}-${id}`);
    assert.equal(record.status, 'diagnostic_passed', JSON.stringify({ status: record.status, error: record.error, report: record.reportPath }));
    assert.equal(record.versions.length, 2);
    assert.equal(record.terminationConfirmed, true);
    assert.equal(record.totalModelCalls, 0);
    assert.ok(record.modelCalls.every(call => call.receiptConfirmed && call.terminationConfirmed));
    assert.deepEqual(record.versions.map(version => version.selfCheck.status), ['passed', 'passed']);
    for (const view of ['DESKTOP', 'MOBILE']) {
      assert.equal(check(first, view, 'kept').actual, 'WEB-1');
      assert.equal(JSON.parse(check(first, view, 'filtered').actual).observed.text, '');
      assert.equal(check(second, view, 'filtered').actual, 'WEB-1');
    }
    assert.equal(first.acceptance.review, null);
    assert.equal(calls.length, 2);
    const feedback = JSON.parse(calls[1].feedback);
    assert.deepEqual(feedback.failedCandidate, first.acceptance.binding);
    assert.equal(second.acceptance.binding.manifestHash, feedback.failedCandidate.manifestHash);
    const saved = JSON.parse(await readFile(record.reportPath, 'utf8'));
    assert.deepEqual(saved.versions, record.versions);
    const git = args => execFileSync('git', args, { cwd: record.workspace, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(git(['rev-parse', `${second.commit}^`]), first.commit);
    assert.equal(git(['diff', '--name-only', first.commit, second.commit]), 'public/app.js');
    t.diagnostic(`预约证据 ${first.commit} → ${second.commit}，刷新读回 WEB-1，编号筛选由空变为 WEB-1。报告 ${record.reportPath}`);
  });
}
