import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { openPlannedWorkerStore } from '../lib/planned-worker-store.mjs';
import { workerCopy, workerExact, workerHash, workerNeed, workerPolicyHash, WORKER_ID, normalizeWorkerModelConfig, workerModelConfigRevision } from '../lib/planned-worker-contract.mjs';
import { verifyWorkerAuthorization, createWorkerResultSigner, signCompletedWorkerResult, signStoppedWorkerResult, signPausedWorkerCheckpoint, signRetiredWorkerCheckpoint, verifyWorkerPausedTaskResume } from '../lib/planned-worker-seals.mjs';
import { createVerificationControl, compileManifest, compileTaskManifest } from '../lib/verification-contract.mjs';
import { startPlannedWebExecution } from '../lib/planned-web-executor.mjs';
import { startPlannedTaskExecution, plannedTaskIntegration, inspectPlannedTaskGraph, capturePausedTaskCheckpoint, retirePausedTaskCheckpoint } from '../lib/planned-task-executor.mjs';
import { createProjectCodeModel } from '../lib/project-code-model.mjs';
import { createProjectReviewModel } from '../lib/project-review-model.mjs';
import { validateProjectFiles } from '../lib/project-files.mjs';
import { getModelRequestEvidence, runModelRequestWithEvidence } from '../lib/model-request-evidence.mjs';
import { assertExecutionSubjectCurrent } from '../lib/team-access.mjs';

async function main() {
  workerNeed(process.argv.length === 4 && process.argv[2] === '--job' && WORKER_ID.test(process.argv[3])); const jobId = process.argv[3];
  let text = ''; for await (const chunk of process.stdin) { text += chunk; workerNeed(Buffer.byteLength(text) <= 1024 * 1024); }
  const bootstrap = workerExact(JSON.parse(text), ['version', 'jobId', 'rootDir', 'nonce', 'executable', 'config']); text = '';
  workerNeed(bootstrap.version === 1 && bootstrap.jobId === jobId); const selectedConfig = normalizeWorkerModelConfig(bootstrap.config);
  const config = { ...selectedConfig };
  const reviewConfig = selectedConfig.reviewConfig ? { ...selectedConfig.reviewConfig } : config;
  // Settings stay immutable, including absence; the private key remains
  // clearable on retirement/terminal cleanup and is never published.
  for (const name of ['baseUrl', 'model', 'thinking', 'jsonMode']) Object.defineProperty(config, name, { value: selectedConfig[name], enumerable: true, writable: false, configurable: false });
  if (selectedConfig.reviewConfig) {
    for (const name of ['baseUrl', 'model', 'thinking', 'jsonMode']) Object.defineProperty(reviewConfig, name, { value: selectedConfig.reviewConfig[name], enumerable: true, writable: false, configurable: false });
    config.reviewConfig = reviewConfig;
  }
  const store = openPlannedWorkerStore({ rootDir: bootstrap.rootDir, create: false }), grant = verifyWorkerAuthorization({ store, jobId });
  workerNeed(grant.deadlineAt > Date.now() && workerModelConfigRevision(config) === grant.configRevision);
  const signer = createWorkerResultSigner(), instanceId = randomUUID(), endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\taskflow-worker-${randomUUID()}` : path.join(store.jobDirectory(jobId), 'control.sock');
  const generation = store.get(jobId).active_generation;
  const registration = { instanceId, generation, publicKey: signer.publicKey, endpoint, pid: process.pid }, lease = store.claim(jobId, bootstrap.nonce, registration); bootstrap.nonce = '';
  const definition = grant.definition, proposal = Object.fromEntries(['version', 'id', 'name', 'sessions', 'steps', 'limits', 'browser', ...(definition.taskScopes ? ['taskScopes'] : [])].filter(key => definition[key] !== undefined).map(key => [key, definition[key]]));
  const control = createVerificationControl(), input = { proposal, requirements: definition.requirements, binding: definition.binding, ...(definition.taskScopes ? { tasks: grant.task.tasks } : {}) }, approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval);
  workerNeed(manifest.manifestHash === definition.manifestHash && (manifest.taskSetHash ?? null) === (definition.taskSetHash ?? null));
  const sessions = new Map(); let handle, finished = false, timer, handoffWork, startupCancelled = false;
  function pruneSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
  }
  const current = () => { const row = store.assertWorker(lease); workerNeed(!startupCancelled && row.grant_hash === workerHash(grant) && grant.policyHash === workerPolicyHash()); assertExecutionSubjectCurrent(grant.subject); return true; };
  const outputDir = store.jobDirectory(jobId);
  function status(after = 0) { return { job: store.get(jobId), snapshot: handle?.snapshot() ?? null, events: store.events(jobId, after) }; }
  async function action(command) {
    if (command.op === 'attach') return { ...status(command.afterSeq), controller: store.acquire(jobId, command.controllerId) };
    const prepared = store.command(jobId, command); if (prepared.repeat) return prepared.result;
    let result;
    try {
      if (command.op === 'pause') { current(); workerNeed(typeof handle?.pause === 'function', 'worker_pause_unsupported'); handle.pause(); store.setStatus(lease, 'pause_requested'); }
      else if (command.op === 'resume') { current(); workerNeed(typeof handle?.resume === 'function', 'worker_resume_unsupported'); handle.resume(); store.setStatus(lease, 'running'); }
      else if (command.op === 'cancel') { workerNeed(!finished); if (handle) handle.cancel(); else startupCancelled = true; store.setStatus(lease, 'cancel_requested'); }
      else if (command.op === 'recover') {
        current(); workerNeed(grant.mode === 'graph' && handle?.snapshot().status === 'paused' && !handoffWork, 'worker_checkpoint_unavailable');
        handoffWork = (async () => {
          const checkpoint = await capturePausedTaskCheckpoint({ handle, manifest }); current();
          const envelope = await signPausedWorkerCheckpoint({ signer, store, lease, manifest, checkpoint }); current();
          const retirement = await retirePausedTaskCheckpoint({ handle, checkpoint, manifest });
          const retired = signRetiredWorkerCheckpoint({ signer, store, lease, manifest, checkpoint, retirement, envelope });
          await store.saveHandoff(lease, { checkpoint: envelope, retirement: retired, manifest });
        })(); await handoffWork;
      }
      else workerNeed(['status', 'detach', 'ack_result'].includes(command.op));
      result = status(command.afterSeq); if (command.op === 'detach') store.release(jobId, command.controllerId, command.epoch);
    } catch (error) { result = { ...status(command.afterSeq), commandError: error?.code ?? 'worker_control_failed' }; }
    return store.acknowledge(jobId, command, result);
  }
  const server = http.createServer(async (request, response) => {
    let packet;
    const send = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      workerNeed(request.method === 'POST' && request.url === '/worker' && request.headers.host === 'worker.local' && !request.headers.origin && request.headers['content-type'] === 'application/json');
      let raw = ''; for await (const chunk of request) { raw += chunk; workerNeed(Buffer.byteLength(raw) <= 1024 * 1024); } packet = JSON.parse(raw);
      const { mac, ...unsigned } = packet; workerNeed(packet.jobId === jobId);
      if (packet.type === 'hello') {
        workerExact(unsigned, ['type', 'jobId', 'controllerId', 'clientNonce']); workerNeed(WORKER_ID.test(packet.controllerId ?? '') && /^[a-f0-9]{64}$/u.test(packet.clientNonce ?? '') && store.verifyMac(jobId, 'hello', unsigned, mac));
        pruneSessions(); workerNeed(sessions.size < 128); const sessionId = randomUUID(), serverNonce = randomBytes(32).toString('hex'); sessions.set(sessionId, { controllerId: packet.controllerId, serverNonce, expiresAt: Date.now() + 30000 });
        const result = { type: 'hello_ack', jobId, instanceId, generation, grantHash: workerHash(grant), clientNonce: packet.clientNonce, serverNonce, sessionId }; send({ ...result, mac: store.mac(jobId, 'hello_ack', result) }); return;
      }
      workerExact(unsigned, ['type', 'jobId', 'instanceId', 'generation', 'grantHash', 'sessionId', 'serverNonce', 'command']);
      pruneSessions(); const session = sessions.get(packet.sessionId); workerNeed(packet.type === 'command' && packet.instanceId === instanceId && packet.generation === generation && packet.grantHash === workerHash(grant)
        && session && session.expiresAt > Date.now() && session.serverNonce === packet.serverNonce && store.verifyMac(jobId, 'command', unsigned, mac));
      const command = workerExact(packet.command, ['controllerId', 'epoch', 'seq', 'requestId', 'op', 'afterSeq']);
      workerNeed(command.controllerId === session.controllerId && WORKER_ID.test(command.requestId ?? '') && Number.isSafeInteger(command.afterSeq) && command.afterSeq >= 0
        && Number.isSafeInteger(command.epoch) && Number.isSafeInteger(command.seq) && ['attach', 'status', 'pause', 'resume', 'recover', 'cancel', 'detach', 'ack_result'].includes(command.op)); session.expiresAt = Date.now() + 30000;
      let result, error; try { result = await action(command); } catch (failure) { error = failure?.code ?? 'worker_control_failed'; }
      const body = { sessionId: packet.sessionId, requestHash: workerHash(unsigned), ...(error ? { error } : { result }) }; send({ ...body, mac: store.mac(jobId, 'response', body) });
      if (command.op === 'detach' && !error && !result?.commandError) sessions.delete(packet.sessionId);
    } catch { send({ error: 'worker_authentication_failed' }, 403); }
  }); server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 16;
  const closeResources = () => { try { server.close(); server.closeAllConnections(); } finally { store.close(); } };
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  let resumePermit;
  try { resumePermit = generation > 1 ? await verifyWorkerPausedTaskResume({ store, lease, manifest, assertCurrent: current }) : undefined; }
  catch (error) {
    try { store.event(lease, { type: 'resume_validation_failed', ...(error?.result ? { process: error.result } : {}) }); store.markUnknown(jobId); } catch {}
    try { config.apiKey = ''; reviewConfig.apiKey = ''; } finally { closeResources(); } return;
  }
  store.setStatus(lease, 'running'); store.event(lease, { type: 'registered', instanceId, generation, deadlineAt: grant.deadlineAt });
  const integrationTaskId = grant.mode === 'graph' ? inspectPlannedTaskGraph(grant.task).integrationTaskId : 'whole';
  function preparedCall(input, role) {
    current(); const call = workerExact(input.requestIdentity, ['version', 'id', 'role', 'kind', 'attempt', 'projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'sourceRevision', 'manifestHash', 'inputSourceHash', 'candidateCommit']);
    const selected = JSON.parse(input.task).activeTask?.id ?? 'whole';
    const expectedManifest = grant.mode === 'graph' && selected !== integrationTaskId ? compileTaskManifest({ manifest, taskId: selected, tasks: grant.task.tasks }) : manifest;
    const previousCalls = store.calls(jobId);
    workerNeed(!previousCalls.some(prior => prior.state === 'unknown') && previousCalls.filter(prior => prior.identity.taskId === selected && prior.identity.role === role && prior.state !== 'not_dispatched').length < (role === 'coding' ? grant.budget.maxCalls : grant.budget.maxReviewCalls), 'worker_task_budget');
    workerNeed(call.version === 1 && call.kind === 'model' && call.role === role && WORKER_ID.test(call.id ?? '') && WORKER_ID.test(call.attemptId ?? '')
      && call.taskId === selected && (grant.mode !== 'graph' ? selected === 'whole' : grant.task.tasks.some(task => task.id === selected))
      && ['projectId', 'runId', 'specRevision', 'planRevision', 'sourceRevision'].every(key => call[key] === grant.binding[key])
      && call.manifestHash === expectedManifest.manifestHash && call.inputSourceHash === createHash('sha256').update(JSON.stringify(validateProjectFiles(input.files))).digest('hex')
      && Number.isInteger(call.attempt) && call.attempt >= 1 && call.attempt <= (role === 'coding' ? grant.budget.maxCalls : grant.budget.maxReviewCalls)
      && !previousCalls.some(prior => prior.call_id === call.id), 'worker_request_identity');
    current(); store.callIntent(lease, call); return call;
  }
  const wrap = (role, native) => async input => {
    // Only the local pre-dispatch validation is wrapped here. Native transport
    // failures retain the adapter's original evidence, including unknown sends.
    const prepared = await runModelRequestWithEvidence(() => preparedCall(input, role)), { requestIdentity, ...nativeInput } = input; let received = false;
    try { return await native({ ...nativeInput, onReceipt: async receipt => {
      current(); const proof = await input.onReceipt(receipt); current();
      workerNeed(proof?.callId === prepared.id && /^[a-f0-9]{64}$/u.test(proof.receiptHash ?? '') && proof.model === receipt.model && proof.finishReason === receipt.finishReason
        && workerHash(proof.usage) === workerHash(receipt.usage), 'worker_receipt_identity');
      store.callReceipt(lease, { ...prepared, dispatched: true, receiptConfirmed: true, receiptHash: proof.receiptHash, usage: proof.usage }); received = true;
    } }); } catch (error) {
      if (!received) { const evidence = getModelRequestEvidence(error); store.callReceipt(lease, { ...prepared, dispatched: evidence?.dispatched === false ? false : true, receiptConfirmed: false, usage: evidence?.dispatched === false ? { inputTokens: 0, outputTokens: 0 } : { inputTokens: null, outputTokens: null } }); } throw error;
    }
  };
  const fetchCurrent = (...args) => { current(); return fetch(...args); };
  const provider = wrap('coding', createProjectCodeModel({ config, fetchImpl: fetchCurrent })), reviewer = wrap('review', createProjectReviewModel({ config: reviewConfig, fetchImpl: fetchCurrent }));
  const options = { outputDir, binding: grant.binding, task: grant.task, manifest, provider, reviewer, executable: bootstrap.executable, maxCalls: grant.budget.maxCalls,
    maxReviewCalls: grant.budget.maxReviewCalls, maxConcurrency: grant.budget.maxConcurrency, timeoutMs: Math.max(1, grant.deadlineAt - Date.now()), deadlineAt: grant.deadlineAt, ...(resumePermit ? { resumePermit } : {}), assertCurrent: current,
    onEvent: event => { try { store.event(lease, event); } catch {} } };
  handle = grant.mode === 'graph' ? startPlannedTaskExecution(options) : startPlannedWebExecution({ ...options, binding: { ...grant.binding, taskId: 'whole' } });
  timer = setTimeout(() => handle.cancel(), Math.max(1, grant.deadlineAt - Date.now()));
  try {
    const actual = await handle.done; finished = true; clearTimeout(timer); const graph = grant.mode === 'graph' ? actual : undefined, record = graph?.status === 'accepted' ? plannedTaskIntegration(graph, manifest) : actual;
    if (actual.status === 'retired_for_recovery') { workerNeed(handoffWork); await handoffWork; return; }
    let envelope = null, outcome = null;
    if (actual.status === 'accepted') envelope = signCompletedWorkerResult({ signer, store, lease, manifest, record, graph });
    else if (actual.terminationConfirmed === true) outcome = signStoppedWorkerResult({ signer, store, lease, manifest, record, graph });
    store.finish(lease, { record, ...(graph ? { graph } : {}), envelope, outcome }, { actualCalls: actual.totalModelCalls, usage: actual.usage, terminationConfirmed: actual.terminationConfirmed === true });
  } catch { finished = true; clearTimeout(timer); try { store.markUnknown(jobId); } catch {} }
  finally { try { config.apiKey = ''; reviewConfig.apiKey = ''; } finally { setTimeout(closeResources, 1000); } }
}
main().catch(() => { process.exitCode = 1; });
