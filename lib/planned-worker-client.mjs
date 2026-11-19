import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { minimalEnv } from './managed-process.mjs';
import { assertPlannedWorkerStore } from './planned-worker-store.mjs';
import { createWorkerAuthority, signWorkerAuthorization } from './planned-worker-seals.mjs';
import { assertApprovedWorkerJob, workerBootstrapNonce, workerCopy, workerHash, workerNeed, WORKER_ID, normalizeWorkerModelConfig, workerModelConfigRevision } from './planned-worker-contract.mjs';

function exchange(endpoint, frame, timeoutMs = 5000) {
  workerNeed(typeof endpoint === 'string' && (process.platform === 'win32' ? /^\\\\\.\\pipe\\taskflow-worker-[a-f0-9-]+$/u.test(endpoint) : endpoint.endsWith('/control.sock')), 'invalid_worker_endpoint');
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: endpoint, path: '/worker', method: 'POST', headers: { Host: 'worker.local', 'Content-Type': 'application/json' }, timeout: timeoutMs }, response => {
      const chunks = []; let bytes = 0; response.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
      response.on('end', () => { try { workerNeed(response.statusCode === 200, 'worker_protocol_rejected'); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Worker响应未通过认证或状态核对。'), { code: 'worker_protocol_rejected' })); } });
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => reject(Object.assign(new Error('已登记Worker暂不可连接，保留原任务且不重新派发。'), { code: 'worker_unreachable' })));
    request.end(JSON.stringify(frame));
  });
}

/** Only the endpoint/key already registered in the private root can be used. No URL/secret option exists. */
export async function attachPlannedWorker({ store, jobId, controllerId = randomUUID(), heartbeat = true } = {}) {
  assertPlannedWorkerStore(store); workerNeed(WORKER_ID.test(jobId ?? '') && WORKER_ID.test(controllerId));
  const registered = store.get(jobId); workerNeed(registered?.registration, 'worker_not_registered');
  function observe(result, starting) {
    let cursor = starting.seq, previous = starting.hash;
    for (const item of result.events ?? []) { workerNeed(item.seq === cursor + 1 && item.previousHash === previous && workerHash({ seq: item.seq, previousHash: item.previousHash, payload: item.payload }) === item.hash, 'worker_event_chain'); cursor = item.seq; previous = item.hash; }
    workerNeed(result.job.event_seq >= cursor && result.job.event_seq >= store.observation(jobId).seq, 'worker_event_regressed'); store.observeEvents(jobId, cursor, previous); return result;
  }
  if (registered.result) return Object.freeze({ jobId, instanceId: registered.registration.instanceId, terminal: true, async status() { const starting = store.observation(jobId); return observe({ job: store.get(jobId), events: store.events(jobId, starting.seq) }, starting); }, async detach() {}, close() {} });
  const identityHash = workerHash(registered.registration), endpoint = registered.registration.endpoint, clientNonce = randomBytes(32).toString('hex');
  const hello = { type: 'hello', jobId, controllerId, clientNonce }, acknowledgement = await exchange(endpoint, { ...hello, mac: store.mac(jobId, 'hello', hello) });
  const { mac, ...helloBody } = acknowledgement;
  workerNeed(store.verifyMac(jobId, 'hello_ack', helloBody, mac) && helloBody.clientNonce === clientNonce && helloBody.jobId === jobId && helloBody.instanceId === registered.registration.instanceId
    && helloBody.generation === registered.registration.generation && helloBody.grantHash === registered.grant_hash && typeof helloBody.sessionId === 'string' && typeof helloBody.serverNonce === 'string', 'worker_handshake_failed');
  let epoch = 0, seq = 0, closed = false, timer, queue = Promise.resolve(); const requests = new Map(), cursors = new Map();
  const run = async (op, requestId = randomUUID()) => {
    workerNeed(!closed && workerHash(store.get(jobId)?.registration) === identityHash, 'worker_client_closed');
    let command = requests.get(requestId);
    if (command) workerNeed(command.op === op, 'worker_command_conflict');
    else { const cursor = store.observation(jobId); command = { controllerId, epoch, seq: op === 'attach' ? 0 : ++seq, requestId, op, afterSeq: cursor.seq }; requests.set(requestId, command); cursors.set(requestId, cursor); }
    const frame = { type: 'command', jobId, instanceId: registered.registration.instanceId, generation: registered.registration.generation, grantHash: registered.grant_hash,
      sessionId: helloBody.sessionId, serverNonce: helloBody.serverNonce, command };
    const response = await exchange(endpoint, { ...frame, mac: store.mac(jobId, 'command', frame) }, op === 'recover' ? 65000 : 5000), { mac: signature, ...body } = response;
    workerNeed(store.verifyMac(jobId, 'response', body, signature) && body.sessionId === frame.sessionId && body.requestHash === workerHash(frame), 'worker_response_authentication');
    if (body.error) throw Object.assign(new Error('Worker控制命令未被接受，请核对当前租约和状态。'), { code: body.error });
    workerNeed(body.result?.job?.registration && workerHash(body.result.job.registration) === identityHash && body.result.job.deadline === registered.deadline && body.result.job.grant_hash === registered.grant_hash);
    if (op === 'attach') { epoch = body.result.controller.epoch; seq = body.result.controller.commandSeq; }
    return workerCopy(observe(body.result, cursors.get(requestId)));
  };
  const command = (op, options = {}) => { const next = queue.then(() => run(op, options.requestId)); queue = next.catch(() => {}); return next; };
  const initial = await command('attach');
  if (heartbeat) { timer = setInterval(() => { void command('status').catch(() => {}); }, 5000); timer.unref(); }
  return Object.freeze({ jobId, instanceId: registered.registration.instanceId, terminal: false, initial,
    status: options => command('status', options), pause: options => command('pause', options), resume: options => command('resume', options), recover: options => command('recover', options), cancel: options => command('cancel', options), acknowledge: options => command('ack_result', options),
    async detach(options) { if (closed) return; clearInterval(timer); try { await command('detach', options); } finally { closed = true; } },
    close() { clearInterval(timer); closed = true; },
  });
}

/** Fixed executable and entry point; config travels once over an anonymous child stdin pipe. */
export async function launchPlannedWorker({ store, job, config, executable } = {}) {
  assertPlannedWorkerStore(store); const body = assertApprovedWorkerJob(job); workerNeed(body.rootIdentity === store.identity);
  const modelConfig = normalizeWorkerModelConfig(config);
  workerNeed(workerModelConfigRevision(modelConfig) === body.configRevision, 'worker_model_config_revision');
  const existing = store.get(body.jobId); if (existing) { workerNeed(existing.grant_hash === workerHash(body), 'worker_job_conflict'); return { jobId: body.jobId, alreadyDispatched: true, registration: existing.registration, status: existing.status }; }
  const authorization = signWorkerAuthorization({ authority: createWorkerAuthority({ store }), job }); store.reserve(job, authorization); store.markDispatch(body.jobId);
  const bootstrap = JSON.stringify({ version: 1, jobId: body.jobId, rootDir: store.rootDir, nonce: workerBootstrapNonce(job), executable, config: modelConfig });
  workerNeed(Buffer.byteLength(bootstrap) <= 1024 * 1024);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/planned-worker.mjs', import.meta.url)), '--job', body.jobId], { cwd: store.rootDir, env: minimalEnv({ PATH: process.env.PATH || '' }), windowsHide: true, detached: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
  let spawnError = false; child.on('error', () => { spawnError = true; }); child.stdin.on('error', () => {}); child.stdin.end(bootstrap); child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !spawnError) { const current = store.get(body.jobId); if (current.registration) return { jobId: body.jobId, alreadyDispatched: false, registration: current.registration, status: current.status }; await delay(25); }
  store.markUnknown(body.jobId); throw Object.assign(new Error('Worker启动状态尚未确认，原派发和预留保留，禁止自动重启。'), { code: 'worker_launch_unknown' });
}

/** Verified retirement and confirmed old-process exit precede a single new nonce. */
export async function launchResumedPlannedWorker({ store, jobId, permit, manifest, config, executable } = {}) {
  assertPlannedWorkerStore(store);
  const body = store.get(jobId)?.authorization.body;
  const modelConfig = normalizeWorkerModelConfig(config);
  workerNeed(workerModelConfigRevision(modelConfig) === body?.configRevision, 'worker_model_config_revision');
  const generation = await store.prepareGeneration(permit, { jobId, manifest }), dispatch = store.dispatchGeneration(generation);
  const bootstrap = JSON.stringify({ version: 1, jobId, rootDir: store.rootDir, nonce: dispatch.nonce, executable, config: modelConfig }); workerNeed(Buffer.byteLength(bootstrap) <= 1024 * 1024);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/planned-worker.mjs', import.meta.url)), '--job', jobId], { cwd: store.rootDir, env: minimalEnv({ PATH: process.env.PATH || '' }), windowsHide: true, detached: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
  let spawnError = false; child.on('error', () => { spawnError = true; }); child.stdin.on('error', () => {}); child.stdin.end(bootstrap); child.unref(); const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !spawnError) { const current = store.get(jobId); if (current.registration?.generation === dispatch.generation) return { jobId, registration: current.registration, status: current.status }; await delay(25); }
  store.markUnknown(jobId); throw Object.assign(new Error('下一代Worker派发状态尚未确认，保留原作业与预算，不重复派发。'), { code: 'worker_resume_launch_unknown' });
}
