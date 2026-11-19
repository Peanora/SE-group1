// Files, snapshots and SQLite are real; the runtime adapter is an explicit inert fixture.
// These mechanism tests do not prove candidate software acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPlannedPreviews } from '../lib/planned-preview.mjs';
import { getWebShellFiles } from '../lib/web-delivery.mjs';
import { readProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';

const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const identity = { projectId: 'p', runId: 'r', executionId: 'e' };
const files = validateProjectFiles([{ path: 'src/app.mjs', content: 'export async function handle(){return {status:200,body:"preview"};}\n' }, { path: 'public/index.html', content: '<!doctype html><title>Preview</title>' }]);
const shellHash = digest(await getWebShellFiles());
const stopReceipt = { terminationConfirmed: true, status: 'stopped', exitCode: 0, sourceUnchanged: true, stopAcknowledged: true, pid: 123 };
const evidenceRoot = path.resolve(import.meta.dirname, '../output/preview-mechanism'); await mkdir(evidenceRoot, { recursive: true });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(evidenceRoot, 'case-')), state = { current: true, authorizeCalls: 0, runtimeCalls: 0, stopCalls: 0, workspaces: [] };
  const service = await createPlannedPreviews({ rootDir: root, timeoutMs: options.timeoutMs ?? 10000,
    authorize: async value => { state.authorizeCalls++; assert.deepEqual(value, identity); await options.beforeAuthorize?.(state);
      return { files, sourceHash: options.sourceHash ?? digest(files), shellHash: options.shellHash ?? shellHash,
        assertCurrent: () => options.gate ? options.gate(state) : assert.equal(state.current, true, 'current acceptance revoked') }; },
    assertIdle: () => { if (options.busy) throw new Error('project busy'); },
    dependencies: { startRuntime: async args => {
      state.runtimeCalls++; state.workspaces.push(args.workspace); state.runtimeArgs = args;
      assert.deepEqual(await readProjectFiles(args.workspace), files); assert.ok(!args.workspace.includes('..'));
      const done = deferred();
      const runtime = { url: options.url ?? 'http://localhost:48931', pid: 123, done: done.promise,
        stop: async () => { state.stopCalls++; const result = options.stopReceipt ?? stopReceipt; done.resolve(result); return result; } };
      state.runtime = runtime; await options.beforeRuntimeReturn?.(state); return runtime;
    } } });
  return { root, service, state };
}

test('accepted snapshot uses a distinct protected copy and verifies an idempotent stop receipt', async () => {
  const f = await fixture(); try {
    const { preview } = await f.service.start(identity);
    assert.equal(preview.state, 'running'); assert.equal(preview.url, 'http://localhost:48931'); assert.equal(preview.active, true);
    assert.equal(f.service.hasActivity('p'), true); assert.equal(f.state.runtimeCalls, 1);
    assert.equal(f.state.runtimeArgs.timeoutMs, 25000); assert.equal(f.state.runtimeArgs.maxOutputBytes, 262144);
    assert.ok(!JSON.stringify(preview).includes(f.root)); assert.equal(Object.hasOwn(preview, 'pid'), false);
    assert.equal(JSON.parse(await readFile(path.join(f.state.workspaces[0], 'package.json'))).scripts.start, 'node server.mjs');
    const [a, b] = await Promise.all([f.service.stop(identity), f.service.stop(identity)]);
    assert.equal(a.preview.state, 'stopped'); assert.equal(b.preview.state, 'stopped'); assert.equal(f.state.stopCalls, 1);
    assert.equal(f.service.hasActivity('p'), false); assert.equal(f.service.read(identity).url, null);
  } finally { await f.service.shutdown(); }
});
test('preparing preview reserves project before asynchronous source checks', async () => {
  const held = deferred(), entered = deferred(), f = await fixture({ beforeAuthorize: () => { entered.resolve(); return held.promise; } });
  const starting = f.service.start(identity); try {
    await entered.promise; assert.equal(f.service.hasActivity('p'), true); assert.equal(f.service.read(identity).state, 'preparing');
    await assert.rejects(f.service.start(identity), e => e.code === 'preview_active');
    held.resolve(); await starting;
  } finally { held.resolve(); await starting.catch(() => {}); await f.service.shutdown(); }
});
test('request cannot carry path, verdict, getters or alternate project activity', async () => {
  const f = await fixture({ busy: true }); try {
    await assert.rejects(f.service.start({ ...identity, workspace: f.root }), e => e.code === 'invalid_preview_input');
    await assert.rejects(f.service.start({ ...identity, executionId: { toString() { throw new Error('coercion invoked'); } } }), e => e.code === 'invalid_preview_input');
    await assert.rejects(f.service.start({ projectId: 'p', runId: 'r', get executionId() { throw new Error('getter invoked'); } }), e => e.code === 'invalid_preview_input');
    await assert.rejects(f.service.start(identity), /project busy/); assert.equal(f.state.authorizeCalls, 0); assert.equal(f.state.runtimeCalls, 0);
  } finally { await f.service.shutdown(); }
});
for (const [name, options] of [['source', { sourceHash: 'a'.repeat(64) }], ['shell', { shellHash: 'b'.repeat(64) }]]) {
  test(`${name} mismatch never dispatches candidate process`, async () => {
    const f = await fixture(options); try { await assert.rejects(f.service.start(identity), e => e.code === 'preview_failed');
      assert.equal(f.state.runtimeCalls, 0); assert.equal(f.service.hasActivity('p'), false); assert.equal(f.service.read(identity).url, null);
    } finally { await f.service.shutdown(); }
  });
}
test('cancelling source preparation confirms no process was dispatched', async () => {
  const held = deferred(), entered = deferred(), f = await fixture({ beforeAuthorize: () => { entered.resolve(); return held.promise; } });
  const starting = f.service.start(identity); starting.catch(() => {});
  try { await entered.promise; const stopping = f.service.stop(identity); held.resolve(); await assert.rejects(starting);
    const result = await stopping; assert.equal(result.preview.state, 'stopped'); assert.equal(f.state.runtimeCalls, 0); assert.equal(f.service.hasActivity('p'), false);
  } finally { held.resolve(); await f.service.shutdown(); }
});
test('revocation after runtime startup stops it before publishing address', async () => {
  const f = await fixture({ beforeRuntimeReturn: state => { state.current = false; } }); try {
    await assert.rejects(f.service.start(identity)); assert.equal(f.state.runtimeCalls, 1); assert.equal(f.state.stopCalls, 1);
    assert.equal(f.service.read(identity).url, null); assert.equal(f.service.hasActivity('p'), false);
  } finally { await f.service.shutdown(); }
});
test('automatic expiration requests graceful stop and releases slot after receipt', async () => {
  const f = await fixture({ timeoutMs: 25 }); try { await f.service.start(identity);
    await new Promise(resolve => setTimeout(resolve, 90)); assert.equal(f.state.stopCalls, 1);
    assert.equal(f.service.hasActivity('p'), false); assert.equal(f.service.read(identity).state, 'stopped');
  } finally { await f.service.shutdown(); }
});
test('unconfirmed process remains blocked across controller restart', async () => {
  const f = await fixture({ stopReceipt: { ...stopReceipt, terminationConfirmed: false } });
  await f.service.start(identity); const result = await f.service.stop(identity);
  assert.equal(result.preview.state, 'reconciliation_required'); assert.equal(f.service.hasActivity('p'), true);
  assert.equal(f.service.read(identity).url, null); await f.service.shutdown();
  const restored = await createPlannedPreviews({ rootDir: f.root, authorize: () => { throw new Error('no automatic process restart'); }, assertIdle() {} });
  try { assert.equal(restored.hasActivity('p'), true); assert.equal(restored.read(identity).state, 'reconciliation_required');
    await assert.rejects(restored.start(identity), e => e.code === 'preview_active');
    await assert.rejects(restored.stop(identity), e => e.code === 'preview_unknown');
  } finally { await restored.shutdown(); }
});
test('another controller cannot take ownership of live preview database', async () => {
  const f = await fixture(); try {
    await f.service.start(identity);
    await assert.rejects(createPlannedPreviews({ rootDir: f.root, authorize() {}, assertIdle() {} }), e => e.code === 'preview_owned');
    assert.equal(f.service.read(identity).state, 'running'); assert.equal(f.state.stopCalls, 0);
  } finally { await f.service.shutdown(); }
});
test('explicit false authority never starts a runtime', async () => {
  const f = await fixture({ gate: () => false }); try {
    await assert.rejects(f.service.start(identity)); assert.equal(f.state.runtimeCalls, 0); assert.equal(f.service.read(identity).url, null);
  } finally { await f.service.shutdown(); }
});
test('read immediately revokes published address and stops after authority changes', async () => {
  const f = await fixture({ gate: state => state.current }); try {
    await f.service.start(identity); f.state.current = false;
    assert.equal(f.service.read(identity).url, null);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.state.stopCalls, 1); assert.equal(f.service.hasActivity('p'), false);
  } finally { await f.service.shutdown(); }
});
test('unknown source verification process is retained even though no preview runtime started', async () => {
  const f = await fixture({ beforeAuthorize: () => { throw Object.assign(new Error('private source check stop unknown'), { reconciliationRequired: true, result: { terminationConfirmed: false, pid: 4321 } }); } });
  try {
    await assert.rejects(f.service.start(identity)); assert.equal(f.state.runtimeCalls, 0);
    assert.equal(f.service.read(identity).state, 'reconciliation_required'); assert.equal(f.service.hasActivity('p'), true);
    assert.equal(f.service.read(identity).url, null);
  } finally { await f.service.shutdown(); }
});

for (const lateUnknown of [false, true]) test(`unsettled source preparation holds the project through stop timeout; late unknown=${lateUnknown}`, async () => {
  const held = deferred(), entered = deferred();
  const f = await fixture({ beforeAuthorize: async () => {
    entered.resolve(); await held.promise;
    if (lateUnknown) throw Object.assign(new Error('source checker termination unknown'), { reconciliationRequired: true, result: { terminationConfirmed: false } });
  } });
  const starting = f.service.start(identity); starting.catch(() => {});
  try {
    await entered.promise;
    const result = await f.service.stop(identity);
    assert.equal(result.preview.state, 'reconciliation_required'); assert.equal(result.preview.active, true);
    assert.equal(f.service.hasActivity('p'), true); assert.equal(f.state.runtimeCalls, 0); assert.equal(result.preview.url, null);
    await assert.rejects(f.service.start(identity), e => e.code === 'preview_active');
    held.resolve(); await assert.rejects(starting);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.hasActivity('p'), lateUnknown);
    assert.equal(f.service.read(identity).state, lateUnknown ? 'reconciliation_required' : 'stopped');
    assert.equal(f.state.runtimeCalls, 0);
  } finally { held.resolve(); await starting.catch(() => {}); await f.service.shutdown(); }
});
