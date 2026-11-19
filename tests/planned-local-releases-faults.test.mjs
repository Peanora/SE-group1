import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupPlannedEvolutionFixture, nativeEvolutionAvailable } from './helpers/planned-evolution-fixture.mjs';

if (!process.env.TASKFLOW_LOCAL_FAULT_CHILD) {
  test('local lifecycle fault probes use real Git plus explicitly controlled runtime boundaries', { skip: !nativeEvolutionAvailable }, async () => {
    const env = { ...process.env, TASKFLOW_LOCAL_FAULT_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', import.meta.filename], { windowsHide: true, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024, env });
    const dir = path.resolve('output/planned-local-releases-author'); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, `fault-child-${Date.now()}.tap`), result.stdout + result.stderr); assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# tests 4\b/u); assert.match(result.stdout, /# fail 0\b/u);
  });
} else {
  let startBoundary;
  mock.module(new URL('../lib/web-runtime.mjs', import.meta.url).href, { namedExports: { startWebRuntime: (...args) => startBoundary(...args) } });
  const { createPlannedLocalReleases } = await import('../lib/planned-local-releases.mjs');
  const terminal = { status: 'stopped', terminationConfirmed: true, exitCode: 0, sourceUnchanged: true, stopAcknowledged: true };
  const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  test('controlled startup/stop/shutdown races preserve activity until real boundary evidence settles', { timeout: 60000 }, async t => {
    const f = await setupPlannedEvolutionFixture(t, { prefix: 'fault-', blocking: false }), projectId = f.originBinding.projectId;
    async function instance(name) {
      const state = { owner: true }; let service;
      const options = { rootDir: path.join(f.sourceRootDir, name), authorizeExecution: async () => ({ files: f.files, sourceHandle: f.sourceHandle, sourceRootDir: f.sourceRootDir, originBinding: f.originBinding, sourceHash: f.originBinding.sourceHash, shellHash: f.record.shellHash, assertCurrent: () => true }), withCheckpoint: async (pid, work) => { assert.equal(service.hasActivity(pid), false); return work(); }, assertIdle: () => true };
      service = await createPlannedLocalReleases(options); const release = (await service.activate({ projectId, runId: f.originBinding.runId, executionId: f.originBinding.executionId, expectedReleaseId: null, expectedDataGeneration: 0 }, { assertAccess: () => state.owner })).release;
      t.after(() => service.shutdown()); return { service, state, release, options, get: () => service.list({ projectId }, { assertAccess: () => true }).releases.find(row => row.current) };
    }
    await t.test('6s pending stop keeps project busy and later confirmation releases exactly once', async () => {
      const stopGate = deferred(), done = deferred(); let stops = 0; startBoundary = async () => ({ url: 'http://127.0.0.1:12345', done: done.promise, stop: () => { stops++; return stopGate.promise; } });
      const f = await instance('stop-pending'); await f.service.start({ projectId, releaseId: f.release.id, expectedDataGeneration: 0 }, { assertAccess: () => true });
      const began = Date.now(), result = await f.service.stop({ projectId, releaseId: f.release.id }, { assertAccess: () => true }); assert.ok(Date.now() - began >= 5800); assert.equal(result.release.state, 'reconciliation_required'); assert.equal(result.release.active, true); assert.equal(f.get().url, null); assert.equal(f.service.hasActivity(projectId), true);
      await assert.rejects(f.service.start({ projectId, releaseId: f.release.id, expectedDataGeneration: 0 }, { assertAccess: () => true }));
      stopGate.resolve(terminal); done.resolve(terminal); for (let i = 0; i < 100 && f.get().state !== 'stopped'; i++) await pause(20); assert.equal(f.get().state, 'stopped'); assert.equal(f.get().active, false); assert.equal(stops, 1); assert.equal(f.get().dataGeneration, 0);
    });
    await t.test('permission revoked during startup still stops the runtime assigned before the guard fails', async () => {
      const startup = deferred(), entered = deferred(), done = deferred(); let stops = 0; startBoundary = async () => { entered.resolve(); return startup.promise; };
      const f = await instance('role-during-start'), starting = f.service.start({ projectId, releaseId: f.release.id, expectedDataGeneration: 0 }, { assertAccess: () => f.state.owner }); starting.catch(() => {}); await entered.promise;
      f.state.owner = false; startup.resolve({ url: 'http://127.0.0.1:12346', done: done.promise, stop: async () => { stops++; done.resolve(terminal); return terminal; } }); await assert.rejects(starting); assert.equal(stops, 1); assert.equal(f.get().state, 'stopped'); assert.equal(f.get().url, null);
    });
    await t.test('shutdown during unresolved startup is bounded and a late runtime is stopped without erasing persisted unknown state', async () => {
      const startup = deferred(), entered = deferred(), done = deferred(); let stops = 0; startBoundary = async () => { entered.resolve(); return startup.promise; };
      const f = await instance('shutdown-start'), starting = f.service.start({ projectId, releaseId: f.release.id, expectedDataGeneration: 0 }, { assertAccess: () => true }); starting.catch(() => {}); await entered.promise;
      const ending = f.service.shutdown(); assert.strictEqual(f.service.shutdown(), ending); const closed = await ending; assert.equal(closed.reconciliationRequired, true); assert.equal(f.service.hasActivity(projectId), true, 'other services must still see a closed pending owner as busy');
      const reopened = await createPlannedLocalReleases({ ...f.options, withCheckpoint: async (pid, work) => work() });
      try { assert.equal(reopened.list({ projectId }, { assertAccess: () => true }).releases[0].state, 'reconciliation_required'); startup.resolve({ url: 'http://127.0.0.1:12347', done: done.promise, stop: async () => { stops++; done.resolve(terminal); return terminal; } }); await assert.rejects(starting); assert.equal(stops, 1); assert.equal(reopened.hasActivity(projectId), true); await assert.rejects(reopened.authorizeStoppedDataset(f.release.id)); }
      finally { startup.resolve(); await reopened.shutdown(); }
    });
  });
}
