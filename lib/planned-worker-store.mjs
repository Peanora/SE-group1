import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { assertApprovedWorkerJob, workerCopy, workerExact, workerHash, workerNeed, WORKER_ID, WORKER_RESUME_PURPOSE, workerPolicyHash } from './planned-worker-contract.mjs';

const stores = new WeakSet(), leases = new WeakMap(), generations = new WeakMap(), same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function directory(raw, create) {
  workerNeed(typeof raw === 'string' && path.isAbsolute(raw) && !raw.includes('\0') && path.resolve(raw) !== path.parse(raw).root); const resolved = path.resolve(raw); let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); if (create) mkdirSync(current, { recursive: true, mode: 0o700 }); const stat = lstatSync(current); workerNeed(stat.isDirectory() && !stat.isSymbolicLink() && same(realpathSync(current), current)); } return resolved;
}
function regular(filename, size) { const info = lstatSync(filename); workerNeed(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (size === undefined || info.size === size) && same(realpathSync(filename), filename)); return info; }
function keyFile(root, name, history, create) {
  const filename = path.join(root, name); if (!existsSync(filename)) { workerNeed(create && !history, 'worker_key_missing'); writeFileSync(filename, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  const before = regular(filename, 32), fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let bytes;
  try { const actual = fstatSync(fd); workerNeed(actual.ino === before.ino && actual.dev === before.dev && actual.nlink === 1 && actual.size === 32); bytes = readFileSync(fd); } finally { closeSync(fd); }
  workerNeed(bytes.length === 32); return { filename, key: bytes, fingerprint: createHash('sha256').update(bytes).digest('hex') };
}

/** A private root holds only control/issuer keys. Model credentials are never passed here. */
export function openPlannedWorkerStore({ rootDir, create = true } = {}) {
  const root = directory(rootDir, create), database = path.join(root, 'workers.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(database + suffix)) regular(database + suffix);
  workerNeed(create || existsSync(database)); const db = new DatabaseSync(database);
  db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,execution_id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL,grant_hash TEXT NOT NULL,authorization TEXT NOT NULL,issuer TEXT NOT NULL,
      status TEXT NOT NULL,active INTEGER NOT NULL,dispatch_hash TEXT NOT NULL,registration TEXT,controller_id TEXT,epoch INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,
      command_seq INTEGER NOT NULL DEFAULT 0,event_seq INTEGER NOT NULL DEFAULT 0,event_hash TEXT NOT NULL,deadline INTEGER NOT NULL,max_calls INTEGER NOT NULL,settlement TEXT,result TEXT,created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS worker_active_project ON jobs(project_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS commands(job_id TEXT NOT NULL,epoch INTEGER NOT NULL,request_id TEXT NOT NULL,seq INTEGER NOT NULL,payload_hash TEXT NOT NULL,result TEXT,PRIMARY KEY(job_id,epoch,request_id));
    CREATE TABLE IF NOT EXISTS events(job_id TEXT NOT NULL,seq INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(job_id,seq));
    CREATE TABLE IF NOT EXISTS calls(job_id TEXT NOT NULL,call_id TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL,receipt_hash TEXT,usage TEXT,PRIMARY KEY(job_id,call_id));
    CREATE TABLE IF NOT EXISTS consumed(job_id TEXT PRIMARY KEY,envelope_hash TEXT NOT NULL,settlement TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observations(job_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,hash TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'active_generation')) db.exec('ALTER TABLE jobs ADD COLUMN active_generation INTEGER NOT NULL DEFAULT 1');
  db.exec(`CREATE TABLE IF NOT EXISTS generations(job_id TEXT NOT NULL,generation INTEGER NOT NULL,generation_id TEXT NOT NULL UNIQUE,authorization TEXT NOT NULL,dispatch_hash TEXT NOT NULL,status TEXT NOT NULL,registration TEXT,PRIMARY KEY(job_id,generation));
    CREATE TABLE IF NOT EXISTS worker_exit_observations(job_id TEXT NOT NULL,generation INTEGER NOT NULL,body TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(job_id,generation));
    CREATE TABLE IF NOT EXISTS paused_handoffs(job_id TEXT NOT NULL,generation INTEGER NOT NULL,checkpoint TEXT NOT NULL,retirement TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(job_id,generation));
    INSERT OR IGNORE INTO generations SELECT id,1,id,authorization,dispatch_hash,status,registration FROM jobs;`);
  const history = db.prepare('SELECT count(*) AS count FROM jobs').get().count > 0; let control, issuer, closed = false;
  try { control = keyFile(root, '.worker-control.key', history, create); issuer = keyFile(root, '.worker-issuer.key', history, create); } catch (error) { db.close(); throw error; }
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), issuer.key]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  const identity = workerHash({ root, control: control.fingerprint, issuer: issuer.fingerprint });
  function available() { workerNeed(!closed, 'worker_store_closed'); directory(root, false); workerNeed(createHash('sha256').update(readFileSync(control.filename)).digest('hex') === control.fingerprint && createHash('sha256').update(readFileSync(issuer.filename)).digest('hex') === issuer.fingerprint, 'worker_key_changed'); regular(control.filename, 32); regular(issuer.filename, 32); }
  const tx = work => { available(); db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const row = jobId => { available(); workerNeed(WORKER_ID.test(jobId ?? '')); return db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId); };
  const generationRow = (jobId, generation) => db.prepare('SELECT * FROM generations WHERE job_id=? AND generation=?').get(jobId, generation);
  const decode = item => { if (!item) return null; const active = generationRow(item.id, item.active_generation);
    return { ...item, authorization: JSON.parse(item.authorization), initialRegistration: item.registration ? JSON.parse(item.registration) : null,
      registration: active?.registration ? JSON.parse(active.registration) : null, generationAuthorization: active ? JSON.parse(active.authorization) : null,
      generationId: active?.generation_id ?? item.id, settlement: item.settlement ? JSON.parse(item.settlement) : null, result: item.result ? JSON.parse(item.result) : null }; };
  function mac(jobId, purpose, payload) { available(); workerNeed(row(jobId)); const key = createHmac('sha256', control.key).update(`taskflow.worker.control.v1\0${jobId}`).digest(); return createHmac('sha256', key).update(workerHash({ purpose, payload })).digest('hex'); }
  function verifyMac(jobId, purpose, payload, signature) { if (!/^[a-f0-9]{64}$/u.test(signature ?? '')) return false; try { return timingSafeEqual(Buffer.from(mac(jobId, purpose, payload), 'hex'), Buffer.from(signature, 'hex')); } catch { return false; } }
  const api = Object.freeze({ rootDir: root, identity, issuerPublicKey: publicKey,
    get(jobId) { return decode(row(jobId)); }, hasActivity(projectId) { available(); return !!db.prepare('SELECT 1 FROM jobs WHERE project_id=? AND active=1').get(projectId); },
    signAuthorization(job) { available(); const body = assertApprovedWorkerJob(job); workerNeed(body.rootIdentity === identity); return { body: workerCopy(body), signature: sign(null, Buffer.from(workerHash(body)), privateKey).toString('base64'), issuerPublicKey: publicKey }; },
    reserve(job, envelope) { const body = assertApprovedWorkerJob(job); workerNeed(body.rootIdentity === identity && workerHash(envelope.body) === workerHash(body) && envelope.issuerPublicKey === publicKey); const grantHash = workerHash(body);
      return tx(() => { const existing = row(body.jobId); if (existing) { workerNeed(existing.grant_hash === grantHash && existing.execution_id === body.executionId && existing.authorization === JSON.stringify(envelope), 'worker_job_conflict'); return decode(existing); }
        db.prepare("INSERT INTO jobs(id,execution_id,project_id,grant_hash,authorization,issuer,status,active,dispatch_hash,event_hash,deadline,max_calls,created_at) VALUES(?,?,?,?,?,?,'authorized',1,?,?,?,?,?)")
          .run(body.jobId, body.executionId, body.binding.projectId, grantHash, JSON.stringify(envelope), publicKey, body.dispatchNonceHash, '0'.repeat(64), body.deadlineAt, body.budget.maxModelCalls, new Date().toISOString());
        db.prepare("INSERT INTO generations VALUES(?,1,?,?,?,'authorized',NULL)").run(body.jobId, body.jobId, JSON.stringify(envelope), body.dispatchNonceHash); return decode(row(body.jobId)); }); },
    markDispatch(jobId) { return tx(() => { const old = row(jobId); workerNeed(old && old.status === 'authorized', 'worker_already_dispatched'); db.prepare("UPDATE jobs SET status='dispatch_intent' WHERE id=?").run(jobId); return decode(row(jobId)); }); },
    claim(jobId, nonce, registration) { return tx(() => { const old = row(jobId), active = old && generationRow(jobId, old.active_generation); workerNeed(old && old.status === 'dispatch_intent' && active && !active.registration && createHash('sha256').update(nonce).digest('hex') === active.dispatch_hash && old.deadline > Date.now(), 'worker_claim_refused');
      const value = workerExact(registration, ['instanceId', 'generation', 'publicKey', 'endpoint', 'pid']); workerNeed(WORKER_ID.test(value.instanceId) && value.generation === old.active_generation && typeof value.publicKey === 'string' && typeof value.endpoint === 'string' && Number.isSafeInteger(value.pid) && value.pid > 0);
      db.prepare("UPDATE generations SET registration=?,status='registered' WHERE job_id=? AND generation=?").run(JSON.stringify(value), jobId, value.generation);
      db.prepare("UPDATE jobs SET registration=CASE WHEN active_generation=1 THEN ? ELSE registration END,status='registered' WHERE id=?").run(JSON.stringify(value), jobId); const lease = Object.freeze({ kind: 'worker_process_lease', id: randomUUID() }); leases.set(lease, { jobId, instanceId: value.instanceId, generation: value.generation, store: api }); return lease; }); },
    assertWorker(lease) { const proof = leases.get(lease), value = proof?.store === api && decode(row(proof.jobId)); workerNeed(value && value.registration?.instanceId === proof.instanceId && value.active_generation === proof.generation && value.active && !['revoked', 'reconciliation_required', 'retired', 'resume_authorized'].includes(value.status) && value.deadline > Date.now(), 'worker_lease_stale'); return value; },
    assertTerminalWorker(lease) { const proof = leases.get(lease), value = proof?.store === api && decode(row(proof.jobId)); workerNeed(value && value.registration?.instanceId === proof.instanceId && value.active_generation === proof.generation && value.active && !['revoked', 'retired', 'resume_authorized'].includes(value.status), 'worker_lease_stale'); return value; },
    setStatus(lease, status) { const current = api.assertWorker(lease); workerNeed(['running', 'pause_requested', 'paused', 'cancel_requested'].includes(status)); db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, current.id); },
    generation(jobId, generation) { workerNeed(row(jobId)); const value = generationRow(jobId, generation); return value ? { ...value, authorization: JSON.parse(value.authorization), registration: value.registration ? JSON.parse(value.registration) : null } : null; },
    observedWorkerExit(jobId, generation) {
      const job = row(jobId), selected = api.generation(jobId, generation), saved = db.prepare('SELECT * FROM worker_exit_observations WHERE job_id=? AND generation=?').get(jobId, generation);
      if (!saved) return null; const body = JSON.parse(saved.body);
      workerNeed(body.version === 1 && body.purpose === 'taskflow/confirmed-worker-exit/v1' && body.jobId === jobId && body.generation === generation && body.grantHash === job.grant_hash
        && body.registrationHash === workerHash(selected?.registration) && verifyMac(jobId, 'confirmed-worker-exit', body, saved.signature), 'worker_exit_observation_changed'); return workerCopy(body);
    },
    async recordWorkerExit(permit, { jobId, generation }) {
      const { assertConfirmedWorkerExit } = await import('./planned-worker-seals.mjs');
      const body = assertConfirmedWorkerExit(permit, { store: api, jobId, generation });
      return tx(() => { const old = api.observedWorkerExit(jobId, generation); if (old) return old;
        workerNeed(body.registrationHash === workerHash(api.generation(jobId, generation)?.registration) && body.grantHash === row(jobId).grant_hash, 'worker_exit_observation_changed');
        db.prepare('INSERT INTO worker_exit_observations VALUES(?,?,?,?)').run(jobId, generation, JSON.stringify(body), mac(jobId, 'confirmed-worker-exit', body)); return workerCopy(body);
      });
    },
    generationChain(jobId) { const job = row(jobId); return db.prepare('SELECT generation FROM generations WHERE job_id=? ORDER BY generation').all(jobId).map(value => ({ ...api.generation(jobId, value.generation), ...(value.generation < job.active_generation ? { handoff: api.handoff(jobId, value.generation) } : {}) })); },
    handoff(jobId, generation) { workerNeed(row(jobId)); const value = db.prepare('SELECT * FROM paused_handoffs WHERE job_id=? AND generation=?').get(jobId, generation); return value ? { checkpoint: JSON.parse(value.checkpoint), retirement: JSON.parse(value.retirement), payload: JSON.parse(value.payload) } : null; },
    async saveHandoff(lease, { checkpoint, retirement, manifest }) {
      const { assertSignedWorkerHandoff } = await import('./planned-worker-seals.mjs');
      const signed = assertSignedWorkerHandoff({ checkpoint, retirement, manifest, store: api, lease });
      return tx(() => { const current = api.assertWorker(lease); workerNeed(!current.result && current.active_generation === signed.generation, 'worker_handoff_conflict');
        const old = api.handoff(current.id, signed.generation); if (old) workerNeed(workerHash(old) === workerHash(signed.handoff));
        else db.prepare('INSERT INTO paused_handoffs VALUES(?,?,?,?,?)').run(current.id, signed.generation, JSON.stringify(signed.handoff.checkpoint), JSON.stringify(signed.handoff.retirement), JSON.stringify(signed.handoff.payload));
        db.prepare("UPDATE generations SET status='retired' WHERE job_id=? AND generation=?").run(current.id, signed.generation);
        db.prepare("UPDATE jobs SET status='retired',controller_id=NULL,lease_until=0,epoch=epoch+1 WHERE id=?").run(current.id); return api.handoff(current.id, signed.generation);
      });
    },
    async prepareGeneration(permit, { jobId, manifest }) {
      const { assertVerifiedWorkerHandoff } = await import('./planned-worker-seals.mjs');
      const proof = assertVerifiedWorkerHandoff(permit, { store: api, jobId, manifest });
      return tx(() => { const old = row(jobId); workerNeed(old?.status === 'retired' && old.active_generation === proof.generation && old.deadline > Date.now() && !old.result, 'worker_handoff_conflict');
        proof.assertCurrent(); const generation = old.active_generation + 1, generationId = randomUUID(), nonce = randomBytes(32).toString('hex'); workerNeed(generation <= 8, 'worker_generation_limit');
        const body = { version: 1, purpose: WORKER_RESUME_PURPOSE, jobId, executionId: old.execution_id, grantHash: old.grant_hash, rootIdentity: identity,
          generation, generationId, previousGeneration: proof.generation, checkpointHash: workerHash(proof.handoff.checkpoint), retirementHash: workerHash(proof.handoff.retirement),
          payloadHash: workerHash(proof.handoff.payload), deadlineAt: old.deadline, maxModelCalls: old.max_calls, policyHash: workerPolicyHash(), subjectHash: workerHash(JSON.parse(old.authorization).body.subject), dispatchNonceHash: createHash('sha256').update(nonce).digest('hex') };
        const authorization = { body, signature: sign(null, Buffer.from(workerHash(body)), privateKey).toString('base64'), issuerPublicKey: publicKey };
        db.prepare("INSERT INTO generations VALUES(?,?,?,?,?,'authorized',NULL)").run(jobId, generation, generationId, JSON.stringify(authorization), body.dispatchNonceHash);
        db.prepare("UPDATE jobs SET active_generation=?,status='resume_authorized',controller_id=NULL,lease_until=0,epoch=epoch+1,command_seq=0 WHERE id=?").run(generation, jobId);
        const handle = Object.freeze({ kind: 'approved_worker_generation', id: generationId }); generations.set(handle, { store: api, jobId, generation, generationId, nonce, authorization }); return handle;
      });
    },
    dispatchGeneration(handle) { const proof = generations.get(handle); workerNeed(proof?.store === api); return tx(() => { const old = row(proof.jobId), active = generationRow(proof.jobId, proof.generation);
      workerNeed(old?.status === 'resume_authorized' && old.active_generation === proof.generation && active?.status === 'authorized' && !active.registration && workerHash(JSON.parse(active.authorization)) === workerHash(proof.authorization));
      db.prepare("UPDATE generations SET status='dispatch_intent' WHERE job_id=? AND generation=?").run(proof.jobId, proof.generation); db.prepare("UPDATE jobs SET status='dispatch_intent' WHERE id=?").run(proof.jobId);
      return { jobId: proof.jobId, generation: proof.generation, nonce: proof.nonce };
    }); },
    mac, verifyMac,
    acquire(jobId, controllerId) { workerNeed(WORKER_ID.test(controllerId ?? '')); return tx(() => { const old = row(jobId); workerNeed(decode(old)?.registration && !['revoked', 'reconciliation_required', 'retired', 'resume_authorized'].includes(old.status)); const now = Date.now(); workerNeed(!old.controller_id || old.controller_id === controllerId || old.lease_until <= now, 'worker_controller_busy');
      const epoch = old.controller_id === controllerId && old.lease_until > now ? old.epoch : old.epoch + 1; db.prepare('UPDATE jobs SET controller_id=?,epoch=?,lease_until=?,command_seq=CASE WHEN epoch=? THEN command_seq ELSE 0 END WHERE id=?').run(controllerId, epoch, now + 15000, epoch, jobId); return { epoch, expiresAt: now + 15000, commandSeq: row(jobId).command_seq }; }); },
    command(jobId, command) { return tx(() => { const old = row(jobId); workerNeed(old?.controller_id === command.controllerId && old.epoch === command.epoch && old.lease_until > Date.now(), 'worker_controller_fenced'); const payloadHash = workerHash(command), existing = db.prepare('SELECT * FROM commands WHERE job_id=? AND epoch=? AND request_id=?').get(jobId, command.epoch, command.requestId);
      if (existing) { workerNeed(existing.payload_hash === payloadHash, 'worker_command_conflict'); return { repeat: true, result: existing.result ? JSON.parse(existing.result) : { status: 'command_pending' } }; }
      workerNeed(command.seq === old.command_seq + 1, 'worker_command_sequence'); db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,NULL)').run(jobId, command.epoch, command.requestId, command.seq, payloadHash); db.prepare('UPDATE jobs SET command_seq=?,lease_until=? WHERE id=?').run(command.seq, Date.now() + 15000, jobId); return { repeat: false }; }); },
    acknowledge(jobId, command, result) { available(); db.prepare('UPDATE commands SET result=? WHERE job_id=? AND epoch=? AND request_id=? AND payload_hash=?').run(JSON.stringify(workerCopy(result)), jobId, command.epoch, command.requestId, workerHash(command)); return workerCopy(result); },
    release(jobId, controllerId, epoch) { available(); db.prepare('UPDATE jobs SET controller_id=NULL,lease_until=0 WHERE id=? AND controller_id=? AND epoch=?').run(jobId, controllerId, epoch); },
    event(lease, payload) { const current = api.assertWorker(lease); return tx(() => { const old = row(current.id), body = { seq: old.event_seq + 1, previousHash: old.event_hash, payload: workerCopy(payload) }, hash = workerHash(body); db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(current.id, body.seq, hash, JSON.stringify(body)); db.prepare('UPDATE jobs SET event_seq=?,event_hash=? WHERE id=?').run(body.seq, hash, current.id); return { ...body, hash }; }); },
    events(jobId, after = 0) { available(); workerNeed(Number.isSafeInteger(after) && after >= 0); return db.prepare('SELECT hash,body FROM events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 1000').all(jobId, after).map(value => ({ ...JSON.parse(value.body), hash: value.hash })); },
    observation(jobId) { workerNeed(row(jobId)); const value = db.prepare('SELECT seq,hash FROM observations WHERE job_id=?').get(jobId); return value ? { ...value } : { seq: 0, hash: '0'.repeat(64) }; },
    observeEvents(jobId, seq, hash) { return tx(() => { workerNeed(Number.isSafeInteger(seq) && seq >= 0); const old = api.observation(jobId); if (seq < old.seq) return old; workerNeed(seq === 0 ? hash === '0'.repeat(64) : db.prepare('SELECT hash FROM events WHERE job_id=? AND seq=?').get(jobId, seq)?.hash === hash); if (seq === old.seq) workerNeed(hash === old.hash); db.prepare('INSERT INTO observations VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET seq=excluded.seq,hash=excluded.hash').run(jobId, seq, hash); return { seq, hash }; }); },
    callIntent(lease, call) { const current = api.assertWorker(lease); workerNeed(call?.id && ['coding', 'review'].includes(call.role)); return tx(() => { const old = db.prepare('SELECT * FROM calls WHERE job_id=? AND call_id=?').get(current.id, call.id); const data = workerCopy(Object.fromEntries(['id', 'role', 'attempt', 'projectId', 'runId', 'taskId', 'attemptId', 'specRevision', 'planRevision', 'manifestHash', 'inputSourceHash'].map(key => [key, call[key]])));
      if (old) workerNeed(old.identity === JSON.stringify(data)); else { workerNeed(db.prepare('SELECT count(*) AS count FROM calls WHERE job_id=?').get(current.id).count < current.max_calls, 'worker_call_budget'); db.prepare("INSERT INTO calls VALUES(?,?,?,'dispatch_intent',NULL,NULL)").run(current.id, call.id, JSON.stringify(data)); } }); },
    callReceipt(lease, call) { const current = api.assertTerminalWorker(lease); workerNeed(call?.id); db.prepare('UPDATE calls SET state=?,receipt_hash=?,usage=? WHERE job_id=? AND call_id=?').run(call.receiptConfirmed ? 'receipt_complete' : call.dispatched === false ? 'not_dispatched' : 'unknown', call.receiptHash ?? null, JSON.stringify(call.usage ?? { inputTokens: null, outputTokens: null }), current.id, call.id); },
    calls(jobId) { available(); return db.prepare('SELECT * FROM calls WHERE job_id=? ORDER BY rowid').all(jobId).map(value => ({ ...value, identity: JSON.parse(value.identity), usage: value.usage ? JSON.parse(value.usage) : null })); },
    async consumeResult(permit, input) { const { assertVerifiedWorkerResult } = await import('./planned-worker-seals.mjs'); const value = assertVerifiedWorkerResult(permit, { ...input, store: api }); return tx(() => { const old = db.prepare('SELECT * FROM consumed WHERE job_id=?').get(input.jobId); if (old) { workerNeed(old.envelope_hash === value.envelopeHash, 'worker_result_replay_conflict'); return { applied: false, settlement: JSON.parse(old.settlement) }; } db.prepare('INSERT INTO consumed VALUES(?,?,?)').run(input.jobId, value.envelopeHash, JSON.stringify(value.settlement)); return { applied: true, settlement: value.settlement }; }); },
    async consumeOutcome(permit, input) { const { assertVerifiedWorkerOutcome } = await import('./planned-worker-seals.mjs'); const value = assertVerifiedWorkerOutcome(permit, { ...input, store: api }); return tx(() => { const old = db.prepare('SELECT * FROM consumed WHERE job_id=?').get(input.jobId); if (old) { workerNeed(old.envelope_hash === value.envelopeHash, 'worker_result_replay_conflict'); return { applied: false, settlement: JSON.parse(old.settlement) }; } db.prepare('INSERT INTO consumed VALUES(?,?,?)').run(input.jobId, value.envelopeHash, JSON.stringify(value.settlement)); return { applied: true, settlement: value.settlement }; }); },
    beginRetiredCancellation(jobId) { return tx(() => { const job = row(jobId); workerNeed(job && ['retired', 'retirement_cancel_pending', 'retirement_cancelled'].includes(job.status), 'worker_retirement_required'); if (job.status !== 'retirement_cancelled') db.prepare("UPDATE jobs SET status='retirement_cancel_pending',controller_id=NULL,lease_until=0,epoch=epoch+1 WHERE id=?").run(jobId); }); },
    async consumeRetiredCancellation(permit, { jobId }) {
      const { assertVerifiedRetiredWorkerCancellation } = await import('./planned-worker-seals.mjs');
      const { body } = assertVerifiedRetiredWorkerCancellation(permit, { store: api, jobId }), envelopeHash = workerHash(body);
      return tx(() => { const old = db.prepare('SELECT * FROM consumed WHERE job_id=?').get(jobId); if (old) workerNeed(old.envelope_hash === envelopeHash, 'worker_result_replay_conflict');
        else db.prepare('INSERT INTO consumed VALUES(?,?,?)').run(jobId, envelopeHash, JSON.stringify(body.settlement));
        db.prepare("UPDATE jobs SET status='retirement_cancelled',active=0,result=?,settlement=? WHERE id=?").run(JSON.stringify({ retirementCancellation: body }), JSON.stringify(body.settlement), jobId);
        return { applied: !old, settlement: body.settlement };
      });
    },
    finish(lease, result, settlement) { const current = api.assertTerminalWorker(lease); workerNeed(settlement && Number.isSafeInteger(settlement.actualCalls) && settlement.actualCalls >= 0 && settlement.actualCalls <= current.max_calls); return tx(() => { const old = row(current.id); workerNeed(!old.result, 'worker_terminal_exists'); const known = settlement.terminationConfirmed === true; db.prepare('UPDATE jobs SET status=?,active=?,result=?,settlement=? WHERE id=?').run(known ? 'terminal' : 'reconciliation_required', known ? 0 : 1, JSON.stringify(workerCopy(result)), JSON.stringify(workerCopy(settlement)), current.id); }); },
    markUnknown(jobId) { return tx(() => { const old = row(jobId); workerNeed(old); if (old.active && old.status !== 'revoked') db.prepare("UPDATE jobs SET status='reconciliation_required' WHERE id=?").run(jobId); }); },
    revoke(jobId) { return tx(() => { workerNeed(row(jobId)); db.prepare("UPDATE jobs SET status='revoked',active=1 WHERE id=?").run(jobId); }); },
    jobDirectory(jobId) { workerNeed(row(jobId)); return directory(path.join(root, 'jobs', jobId), true); },
    close() { if (!closed) { closed = true; control.key.fill(0); issuer.key.fill(0); db.close(); } },
  }); stores.add(api); return api;
}
export function assertPlannedWorkerStore(store) { workerNeed(stores.has(store), 'worker_private_store_required'); return store; }
