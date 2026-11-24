import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let deliverReservationsImpl;

export async function deliverReservations(outputRoot = path.join(root, 'output', 'reservation-delivery')) {
  if (!deliverReservationsImpl) throw new Error('离线演示需启用 --experimental-test-module-mocks 或通过 CLI 直接运行。');
  return deliverReservationsImpl(outputRoot);
}

// Self-bootstrap with module mocks so offline demo can stub only the Windows MXC
// sandbox transport while running real Git, SQLite, preview, delivery, and archive modules.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url && !process.env.TASKFLOW_DELIVERY_DEMO_CHILD) {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', import.meta.filename, ...process.argv.slice(2)], {
    env: { ...process.env, TASKFLOW_DELIVERY_DEMO_CHILD: '1' },
    stdio: 'inherit',
    timeout: 120000,
    windowsHide: true,
  });
  process.exitCode = result.status ?? 1;
} else {
  const { mock } = await import('node:test');
  const { browserScenarioChecks, browserScenarioPolicyHash } = await import('../lib/browser-scenario-contract.mjs');
  const { validateProjectFiles } = await import('../lib/project-files.mjs');
  const { contentRevision, planningRevision } = await import('../lib/planning-review.mjs');
  const { validateEngineeringPlan } = await import('../lib/engineering-plan.mjs');
  const { engineeringTasks } = await import('../lib/engineering-planner.mjs');
  const { readWebArchiveEntries } = await import('../lib/web-archive.mjs');
  const { inspectPlannedArchive } = await import('../lib/planned-archive.mjs');

  const sourceHash = files => createHash('sha256').update(JSON.stringify(validateProjectFiles(files))).digest('hex');
  const stopped = { status: 'stopped', exitCode: 0, terminationConfirmed: true, sourceUnchanged: true, stopAcknowledged: true };

  // Stub only the Windows MXC preflight / runner transport for cross-platform offline demo.
  mock.module(new URL('../lib/windows-sandbox.mjs', import.meta.url).href, {
    namedExports: { createWindowsSandbox: () => ({ preflight: async () => ({ kind: 'offline-delivery-demo' }) }) },
  });
  mock.module(new URL('../lib/http-scenarios.mjs', import.meta.url).href, {
    namedExports: {
      runHttpScenarios: async input => ({
        status: 'passed',
        binding: structuredClone(input.binding),
        sourceHash: sourceHash(input.files),
        manifestHash: input.manifest.manifestHash,
        policyHash: input.manifest.policyHash,
        terminationConfirmed: true,
        processes: [{ ...stopped, pid: 1001 }],
        checks: input.manifest.checks.map(rule => ({ ...rule, actual: rule.expected ?? rule.name, passed: true })),
      }),
    },
  });
  mock.module(new URL('../lib/browser-scenarios.mjs', import.meta.url).href, {
    namedExports: {
      runBrowserScenarios: async input => ({
        status: 'passed',
        binding: structuredClone(input.binding),
        sourceHash: sourceHash(input.files),
        manifestHash: input.manifest.manifestHash,
        browserPolicyHash: browserScenarioPolicyHash,
        terminationConfirmed: true,
        browser: { version: '130.0.0.0', closed: true },
        processes: [{ ...stopped, kind: 'runtime', pid: 1002 }, { ...stopped, kind: 'runtime', pid: 1003 }, { ...stopped, kind: 'browser', pid: 1004 }],
        checks: browserScenarioChecks(input.manifest.browser).map(rule => ({ ...rule, actual: rule.expected, passed: true })),
      }),
    },
  });

  const { createVerificationPlanningService } = await import('../lib/verification-planning-service.mjs');
  const { verificationModelPolicy } = await import('../lib/verification-model.mjs');
  const { createPlannedExecutionService } = await import('../lib/planned-execution-service.mjs');

  const RESERVATION_APP_SOURCE = `import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const USERS = {
  alice: { id: 'alice', role: 'member' },
  bob: { id: 'bob', role: 'member' },
  scheduler: { id: 'scheduler', role: 'scheduler' },
};
const RESOURCES = [
  { id: 'ROOM-A', name: 'ROOM-A', site: 'east', capacity: 1 },
  { id: 'ROOM-B', name: 'ROOM-B', site: 'east', capacity: 1 },
];
const json = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });

export async function createApp({ dataDir } = {}) {
  const dir = dataDir || path.resolve('.platform/tmp');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'app.sqlite'));
  db.exec(\`
    CREATE TABLE IF NOT EXISTS bookings(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      waiter_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS waitlist(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      sequence INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER,
      waiter_id INTEGER,
      resource_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL
    );
  \`);

  const mapBooking = r => r && ({ id: r.id, ownerId: r.owner_id, resourceId: r.resource_id, slot: r.slot, reference: r.reference, status: r.status, version: r.version, waiterId: r.waiter_id });
  const activeCount = (resourceId, slot) => db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE resource_id=? AND slot=? AND status IN ('held','confirmed')").get(resourceId, slot).n;

  async function handle(req) {
    const url = new URL(req.url, 'http://localhost');
    const actor = USERS[req.headers['x-demo-user'] ?? ''];
    const body = req.body ? JSON.parse(req.body) : {};

    if (req.method === 'GET' && url.pathname === '/') {
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8"><title>设备预约系统</title><main data-testid="bookings-app"><h1>设备预约系统</h1></main>' };
    }
    if (!actor) return json(401, { error: { code: 'unauthorized' } });

    if (req.method === 'GET' && url.pathname === '/api/resources') {
      return json(200, { total: RESOURCES.length, items: RESOURCES });
    }
    if (req.method === 'GET' && url.pathname === '/api/availability') {
      const resourceId = url.searchParams.get('resourceId'), slot = url.searchParams.get('slot');
      const held = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE resource_id=? AND slot=? AND status='held'").get(resourceId, slot).n;
      const confirmed = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE resource_id=? AND slot=? AND status='confirmed'").get(resourceId, slot).n;
      const queued = db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE resource_id=? AND slot=? AND status='queued'").get(resourceId, slot).n;
      return json(200, { held, confirmed, available: Math.max(0, 1 - held - confirmed), queued });
    }
    if (req.method === 'POST' && url.pathname === '/api/holds') {
      if (actor.role !== 'member') return json(403, { error: { code: 'forbidden' } });
      if (activeCount(body.resourceId, body.slot) >= 1) return json(409, { error: { code: 'capacity_full' } });
      const info = db.prepare("INSERT INTO bookings(owner_id,resource_id,slot,reference,status,version) VALUES(?,?,?,?,'held',1)").run(actor.id, body.resourceId, body.slot, body.reference);
      const id = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO audit(booking_id,resource_id,slot,actor_id,action,from_status,to_status) VALUES(?,?,?,?,'held',NULL,'held')").run(id, body.resourceId, body.slot, actor.id);
      return json(201, { item: mapBooking(db.prepare('SELECT * FROM bookings WHERE id=?').get(id)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/bookings') {
      const rows = actor.role === 'scheduler'
        ? db.prepare('SELECT * FROM bookings ORDER BY id ASC').all()
        : db.prepare('SELECT * FROM bookings WHERE owner_id=? ORDER BY id ASC').all(actor.id);
      return json(200, { total: rows.length, items: rows.map(mapBooking) });
    }
    const bookingMatch = url.pathname.match(/^\\/api\\/bookings\\/(\\d+)(?:\\/(confirm|cancel|audit))?$/u);
    if (bookingMatch) {
      const id = Number(bookingMatch[1]), action = bookingMatch[2];
      const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
      if (!row || (actor.role !== 'scheduler' && row.owner_id !== actor.id)) return json(404, { error: { code: 'not_found' } });
      if (req.method === 'GET' && !action) return json(200, { item: mapBooking(row) });
      if (req.method === 'GET' && action === 'audit') {
        const items = db.prepare('SELECT actor_id AS actorId, action, from_status AS fromStatus, to_status AS toStatus FROM audit WHERE booking_id=? OR (waiter_id IS NOT NULL AND waiter_id=?) ORDER BY id ASC').all(row.id, row.waiter_id ?? -1);
        return json(200, { items });
      }
      if (req.method === 'POST' && action === 'confirm') {
        if (actor.role !== 'member' || row.owner_id !== actor.id) return json(403, { error: { code: 'forbidden' } });
        if (row.version !== body.version || row.status !== 'held') return json(409, { error: { code: 'stale_version' } });
        db.prepare("UPDATE bookings SET status='confirmed',version=version+1 WHERE id=?").run(row.id);
        db.prepare("INSERT INTO audit(booking_id,waiter_id,resource_id,slot,actor_id,action,from_status,to_status) VALUES(?,?,?,?,?,'confirmed','held','confirmed')").run(row.id, row.waiter_id, row.resource_id, row.slot, actor.id);
        return json(200, { item: mapBooking(db.prepare('SELECT * FROM bookings WHERE id=?').get(row.id)) });
      }
      if (req.method === 'POST' && action === 'cancel') {
        if (actor.role !== 'member' || row.owner_id !== actor.id) return json(403, { error: { code: 'forbidden' } });
        if (row.version !== body.version || !['held', 'confirmed'].includes(row.status)) return json(409, { error: { code: 'stale_version' } });
        db.prepare("UPDATE bookings SET status='cancelled',version=version+1 WHERE id=?").run(row.id);
        db.prepare("INSERT INTO audit(booking_id,waiter_id,resource_id,slot,actor_id,action,from_status,to_status) VALUES(?,?,?,?,?,'cancelled',?,'cancelled')").run(row.id, row.waiter_id, row.resource_id, row.slot, actor.id, row.status);
        return json(200, { item: mapBooking(db.prepare('SELECT * FROM bookings WHERE id=?').get(row.id)) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/waitlist') {
      if (actor.role !== 'member') return json(403, { error: { code: 'forbidden' } });
      if (activeCount(body.resourceId, body.slot) < 1) return json(400, { error: { code: 'invalid_input' } });
      const seq = (db.prepare('SELECT COALESCE(MAX(sequence),0) AS m FROM waitlist WHERE resource_id=? AND slot=?').get(body.resourceId, body.slot).m) + 1;
      const info = db.prepare("INSERT INTO waitlist(owner_id,resource_id,slot,reference,status,version,sequence) VALUES(?,?,?,?,'queued',1,?)").run(actor.id, body.resourceId, body.slot, body.reference, seq);
      const id = Number(info.lastInsertRowid);
      const position = db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE resource_id=? AND slot=? AND status='queued' AND sequence<=?").get(body.resourceId, body.slot, seq).n;
      db.prepare("INSERT INTO audit(waiter_id,resource_id,slot,actor_id,action,from_status,to_status) VALUES(?,?,?,?,'queued',NULL,'queued')").run(id, body.resourceId, body.slot, actor.id);
      return json(201, { item: { id, ownerId: actor.id, resourceId: body.resourceId, slot: body.slot, reference: body.reference, status: 'queued', version: 1, sequence: seq, position } });
    }
    const promoteMatch = url.pathname.match(/^\\/api\\/waitlist\\/(\\d+)\\/promote$/u);
    if (req.method === 'POST' && promoteMatch) {
      if (actor.role !== 'scheduler') return json(403, { error: { code: 'forbidden' } });
      const id = Number(promoteMatch[1]);
      const waiter = db.prepare('SELECT * FROM waitlist WHERE id=?').get(id);
      if (!waiter || waiter.status !== 'queued' || waiter.version !== body.version) return json(409, { error: { code: 'invalid_waiter' } });
      if (activeCount(waiter.resource_id, waiter.slot) >= 1) return json(409, { error: { code: 'capacity_full' } });
      const head = db.prepare("SELECT id FROM waitlist WHERE resource_id=? AND slot=? AND status='queued' ORDER BY sequence ASC LIMIT 1").get(waiter.resource_id, waiter.slot);
      if (!head || head.id !== waiter.id) return json(409, { error: { code: 'not_fifo_head' } });
      db.prepare("UPDATE waitlist SET status='promoted',version=version+1 WHERE id=?").run(waiter.id);
      const info = db.prepare("INSERT INTO bookings(owner_id,resource_id,slot,reference,status,version,waiter_id) VALUES(?,?,?,?,'held',1,?)").run(waiter.owner_id, waiter.resource_id, waiter.slot, waiter.reference, waiter.id);
      const bookingId = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO audit(booking_id,waiter_id,resource_id,slot,actor_id,action,from_status,to_status) VALUES(?,?,?,?,?,'promoted','queued','held')").run(bookingId, waiter.id, waiter.resource_id, waiter.slot, actor.id);
      return json(200, { item: mapBooking(db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId)) });
    }
    return json(404, { error: { code: 'not_found' } });
  }

  return { handle, close() { db.close(); } };
}
`;

  async function startLocalAppRuntime({ workspace }) {
    const appPath = path.join(workspace, 'src', 'app.mjs');
    const dataDir = path.join(workspace, '.platform', 'tmp');
    const mod = await import(`${pathToFileURL(appPath).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const app = await mod.createApp({ dataDir });
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await app.handle({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(result.status, result.headers ?? {});
      res.end(result.body ?? '');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    let stopPromise;
    return {
      url,
      pid: process.pid,
      done,
      stop: () => (stopPromise ??= (async () => {
        await new Promise(resolve => server.close(resolve));
        app.close();
        const receipt = { ...stopped, pid: process.pid };
        resolveDone(receipt);
        return receipt;
      })()),
    };
  }

  async function apiRequest(baseUrl, user, method, route, body) {
    const response = await fetch(new URL(route, baseUrl), {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-demo-user': user } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  async function until(read, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error('等待执行完成超时。');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  deliverReservationsImpl = async function runDeliverReservations(outputRoot = path.join(root, 'output', 'reservation-delivery')) {
    await mkdir(outputRoot, { recursive: true });
    const realRoot = await realpath(outputRoot);
    const directory = await mkdtemp(path.join(realRoot, 'demo-'));
    const ids = { projectId: 'reservations-demo', runId: 'run-v0' };
    const config = { baseUrl: 'https://demo.synthetic.invalid/v1', model: 'offline-delivery-demo', apiKey: 'synthetic-demo-key' };

    const requirements = await readFile(path.join(root, 'examples/quality-benchmarks/reservations.md'), 'utf8');
    const source = { filename: 'reservations.md', content: requirements };
    const spec = {
      title: '设备预约与有序候补系统',
      summary: '成员预约、候补排队、取消后调度员提升与确认，重启保留数据。',
      goals: ['唯一占位', '有序候补与提升', 'SQLite 重启持久化'],
      roles: [],
      constraints: ['单时段容量为 1'],
      assumptions: [],
      questions: [],
      acceptanceScenarios: ['A 预约、B 候补、A 取消、调度员提升 B、B 确认，重启后数据仍在'],
      stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
      requirements: [{ id: 'R1', title: '设备预约与候补', description: '支持预约、候补、取消、提升、确认与持久化。', sourceQuote: 'slot是业务标识YYYY-MM-DD-AM或PM', acceptance: ['重启后保留预约与审计'] }],
    };
    const specRevision = contentRevision(spec);
    const engineeringPlan = validateEngineeringPlan({
      spec,
      binding: { ...ids, specRevision },
      proposal: {
        version: 1,
        title: '设备预约实现计划',
        summary: '单模块预约与候补服务',
        entities: [],
        routes: [{ id: 'bookings', method: 'GET', path: '/api/bookings', roles: [], request: '无', response: '预约列表', errors: [], requirementIds: ['R1'] }],
        views: [{ id: 'home', path: '/', title: '设备预约', requirementIds: ['R1'], selectors: [{ testId: 'bookings-app', role: 'main' }] }],
        tasks: [{ id: 'implement', title: '实现设备预约服务', description: '实现预约、候补、提升、确认和 SQLite 持久化', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['预约应用'], acceptance: ['主流程和重启持久化通过'] }],
      },
    });
    const run = {
      id: ids.runId, projectId: ids.projectId, workflowVersion: 2,
      sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0,
      status: 'succeeded', stages: [], spec, specRevision, specQuestions: [],
      engineeringPlan, tasks: engineeringTasks(engineeringPlan),
      artifacts: [{ name: 'architecture.md', content: '设备预约架构' }],
      review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } },
    };
    run.planRevision = planningRevision(run);
    run.approvals.plan = { revision: run.planRevision, specRevision };
    const planningData = { project: { id: ids.projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };

    const verificationProposal = {
      version: 1,
      id: 'reservations-delivery-v0',
      name: '设备预约验收清单',
      sessions: [],
      steps: [{ id: 'home', type: 'request', requirementIds: ['R1'], dependsOn: [], request: { id: 'bookings', method: 'GET', path: '/', assertions: [{ id: 'status', op: 'status', value: 200 }] } }],
      browser: { version: 1, sessions: ['visitor'], steps: [{ id: 'open', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' }, { id: 'visible', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'bookings-app', value: true }] },
    };

    let reviewShouldFail = false;
    const verification = await createVerificationPlanningService({
      rootDir: path.join(directory, 'verification'),
      getPlanning: () => planningData,
      getPlanningSync: () => planningData,
      config,
      timeoutMs: 5000,
      cleanupMs: 30,
      dependencies: {
        createModel: () => async input => {
          const usage = { inputTokens: 10, outputTokens: 10 };
          await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(verificationProposal) });
          return { proposal: verificationProposal, usage, model: config.model, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' };
        },
      },
    });

    const candidate = (await verification.propose({ ...ids, contractRevision: (await verification.list(ids)).capabilities.contractRevision })).proposal;
    const draft = await until(async () => (await verification.list(ids)).proposals.find(row => row.id === candidate.id && row.status === 'draft'));
    const approved = (await verification.approve({ ...ids, proposalId: draft.id, revision: draft.revision, feedback: '确认设备预约交付演示验收清单' })).proposal;

    const service = await createPlannedExecutionService({
      rootDir: path.join(directory, 'executions'),
      verificationService: verification,
      getPlanningSync: () => planningData,
      config,
      executable: process.execPath,
      withCheckpoint: async (_id, work) => work(),
      dependencies: {
        startPreviewRuntime: startLocalAppRuntime,
        createProvider: () => async input => {
          const body = { files: [{ path: 'src/app.mjs', content: RESERVATION_APP_SOURCE }] };
          await input.onReceipt({ model: config.model, finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 30 }, content: JSON.stringify(body) });
          return body;
        },
        createReviewer: () => async input => {
          const body = reviewShouldFail
            ? { summary: '故意阻塞以验证失败记录拦截。', issues: [{ file: 'src/app.mjs', line: 1, severity: 'blocking', message: '演示用阻塞问题：未通过代码审查。' }], resolutions: [] }
            : { summary: '预约、候补、提升、确认及 SQLite 持久化符合规则。', issues: [], resolutions: [] };
          await input.onReceipt({ model: config.model, finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 15 }, content: JSON.stringify(body) });
          return body;
        },
      },
    });

    try {
      const startInput = async () => ({ ...ids, proposalId: approved.id, revision: approved.revision, contractRevision: (await service.list(ids)).capabilities.contractRevision });

      // 1. Accepted execution: preview -> trial booking -> stop -> download
      const acceptedStart = await service.start(await startInput());
      const acceptedRow = await until(async () => {
        const row = (await service.list(ids)).executions.find(item => item.id === acceptedStart.execution.id);
        return row && row.status === 'accepted' && !row.active ? row : null;
      });
      const acceptedId = { ...ids, executionId: acceptedRow.id };

      const previewStarted = await service.preview(acceptedId);
      assert.equal(previewStarted.preview.state, 'running');
      assert.equal(previewStarted.preview.candidateCommit, acceptedRow.candidateCommit);
      assert.equal(previewStarted.execution.actions.canDownload, false);
      await assert.rejects(service.download(acceptedId), error => error.status === 409);

      // Trial booking in workbench preview
      const previewHold = await apiRequest(previewStarted.preview.url, 'alice', 'POST', '/api/holds', { resourceId: 'ROOM-A', slot: '2030-05-09-AM', reference: 'PREVIEW-TRY-1' });
      assert.equal(previewHold.status, 201);
      assert.equal(previewHold.json.item.status, 'held');

      const previewStopped = await service.stopPreview(acceptedId);
      assert.equal(previewStopped.preview.state, 'stopped');
      assert.equal(previewStopped.execution.actions.canDownload, true);

      // Download official delivery ZIP
      const downloaded = await service.download(acceptedId);
      const zipPath = path.join(directory, downloaded.filename);
      await writeFile(zipPath, downloaded.buffer);

      // 2. Inspect ZIP integrity and verify same-commit binding
      const inspected = await inspectPlannedArchive(downloaded.buffer);
      assert.equal(inspected.integrityVerified, true);
      assert.equal(inspected.startGuidePresent, true);
      assert.equal(inspected.binding.candidateCommit, acceptedRow.candidateCommit);
      assert.equal(inspected.binding.sourceHash, previewStarted.preview.sourceHash);

      // 3. Unpack ZIP into a brand-new clean directory and run full unified reservation scenario + restart
      const cleanDir = path.join(directory, 'clean-handoff');
      const { entries } = readWebArchiveEntries(downloaded.buffer);
      for (const [entryPath, entry] of entries) {
        const target = path.join(cleanDir, ...entryPath.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, entry.content, 'utf8');
      }
      const manifestJson = JSON.parse(await readFile(path.join(cleanDir, 'delivery', 'manifest.json'), 'utf8'));
      const verificationJson = JSON.parse(await readFile(path.join(cleanDir, 'delivery', 'verification.json'), 'utf8'));
      assert.equal(manifestJson.binding.candidateCommit, acceptedRow.candidateCommit);
      assert.equal(verificationJson.binding.candidateCommit, acceptedRow.candidateCommit);

      const firstRun = await startLocalAppRuntime({ workspace: cleanDir });
      let promotedBookingId;
      try {
        // Confirm clean data directory does NOT contain preview trial data
        const cleanInitial = await apiRequest(firstRun.url, 'alice', 'GET', '/api/bookings');
        assert.equal(cleanInitial.json.total, 0);

        // Member A holds & confirms ROOM-A 2030-05-01-PM
        const holdA = await apiRequest(firstRun.url, 'alice', 'POST', '/api/holds', { resourceId: 'ROOM-A', slot: '2030-05-01-PM', reference: 'DEMO-A' });
        assert.equal(holdA.status, 201);
        const confirmA = await apiRequest(firstRun.url, 'alice', 'POST', `/api/bookings/${holdA.json.item.id}/confirm`, { version: holdA.json.item.version });
        assert.equal(confirmA.status, 200);
        assert.equal(confirmA.json.item.status, 'confirmed');

        // Member B joins waitlist (position 1)
        const waitB = await apiRequest(firstRun.url, 'bob', 'POST', '/api/waitlist', { resourceId: 'ROOM-A', slot: '2030-05-01-PM', reference: 'DEMO-B' });
        assert.equal(waitB.status, 201);
        assert.equal(waitB.json.item.position, 1);

        // Member A cancels
        const cancelA = await apiRequest(firstRun.url, 'alice', 'POST', `/api/bookings/${holdA.json.item.id}/cancel`, { version: confirmA.json.item.version });
        assert.equal(cancelA.status, 200);
        assert.equal(cancelA.json.item.status, 'cancelled');

        // Scheduler promotes first waiter B -> held
        const promoteB = await apiRequest(firstRun.url, 'scheduler', 'POST', `/api/waitlist/${waitB.json.item.id}/promote`, { version: waitB.json.item.version });
        assert.equal(promoteB.status, 200);
        assert.equal(promoteB.json.item.status, 'held');
        promotedBookingId = promoteB.json.item.id;

        // Member B confirms -> confirmed
        const confirmB = await apiRequest(firstRun.url, 'bob', 'POST', `/api/bookings/${promotedBookingId}/confirm`, { version: promoteB.json.item.version });
        assert.equal(confirmB.status, 200);
        assert.equal(confirmB.json.item.status, 'confirmed');
      } finally {
        await firstRun.stop();
      }

      // Restart unpacked app in the same clean directory and verify persistence
      const restartedRun = await startLocalAppRuntime({ workspace: cleanDir });
      let persistedAuditActions = [];
      try {
        const afterRestart = await apiRequest(restartedRun.url, 'bob', 'GET', `/api/bookings/${promotedBookingId}`);
        assert.equal(afterRestart.status, 200);
        assert.equal(afterRestart.json.item.status, 'confirmed');
        assert.equal(afterRestart.json.item.reference, 'DEMO-B');
        const auditAfterRestart = await apiRequest(restartedRun.url, 'bob', 'GET', `/api/bookings/${promotedBookingId}/audit`);
        assert.equal(auditAfterRestart.status, 200);
        persistedAuditActions = auditAfterRestart.json.items.map(item => item.action);
        assert.deepEqual(persistedAuditActions, ['queued', 'promoted', 'confirmed']);
      } finally {
        await restartedRun.stop();
      }

      // 4. Failed execution: verify preview and download are strictly unavailable
      reviewShouldFail = true;
      const failedStart = await service.start(await startInput());
      const failedRow = await until(async () => {
        const row = (await service.list(ids)).executions.find(item => item.id === failedStart.execution.id);
        return row && row.status === 'failed' && !row.active ? row : null;
      });
      const failedId = { ...ids, executionId: failedRow.id };
      assert.equal(failedRow.accepted, false);
      assert.equal(failedRow.actions.canPreview, false);
      assert.equal(failedRow.actions.canDownload, false);
      await assert.rejects(service.preview(failedId), error => error.status === 409);
      await assert.rejects(service.download(failedId), error => error.status === 409);

      const summary = {
        directory,
        zipPath,
        cleanDir,
        acceptedExecutionId: acceptedRow.id,
        failedExecutionId: failedRow.id,
        candidateCommit: acceptedRow.candidateCommit,
        sourceHash: inspected.binding.sourceHash,
        archiveHash: inspected.archiveHash,
        previewTrialStatus: previewHold.status,
        cleanScenarioRestartVerified: true,
        persistedAuditActions,
        failedRecordBlocked: { canPreview: failedRow.actions.canPreview, canDownload: failedRow.actions.canDownload },
        startGuidePresent: inspected.startGuidePresent,
      };
      await writeFile(path.join(directory, 'delivery-demo-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
      return summary;
    } finally {
      await service.shutdown();
      await verification.shutdown();
    }
  }

  if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try {
      const summary = await deliverReservations();
      console.log('设备预约软件预览与源码交付演示完成');
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    }
  }
}
