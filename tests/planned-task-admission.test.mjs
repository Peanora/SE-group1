import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { inspectPlannedTaskGraph, startPlannedTaskExecution } from '../lib/planned-task-executor.mjs';
import { canonicalJSON, createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';

const message = '当前确认任务图不支持逐任务执行，请核对任务数量、依赖、文件范围与最终集成任务。';
const safe = error => error.code === 'unsupported_task_graph' && error.message === message && error.cause === undefined;
const task = (id, dependsOn, paths) => ({ id, title: id, description: `Implement ${id}`, dependsOn, writePaths: paths, requirementIds: ['R'], inputs: ['Approved input'], outputs: ['Observable output'], acceptance: ['Approved observation'] });
function graph() {
  return { title: 'Full confirmed context', constraints: ['retain exact task input'], engineeringContract: { routes: [{ id: 'read', path: '/' }] }, tasks: [
    task('base', [], ['src/app.mjs']), task('alpha', ['base'], ['src/alpha.mjs']), task('beta', ['base'], ['src/beta.mjs']), task('final', ['alpha', 'beta'], ['docs/final.md']),
  ] };
}
const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');

test('admission returns one deep-copied unchanged full context, exact ordered tasks/paths and final identity', () => {
  const input = graph(), before = structuredClone(input), beforeHash = digest(input.tasks), checked = inspectPlannedTaskGraph(input);
  assert.deepEqual(input, before); assert.deepEqual(checked.task, input); assert.equal(digest(checked.tasks), beforeHash);
  assert.equal(checked.tasks, checked.task.tasks); assert.notEqual(checked.task, input); assert.notEqual(checked.tasks, input.tasks); assert.notEqual(checked.tasks[0].writePaths, input.tasks[0].writePaths);
  assert.deepEqual(checked.allPaths, ['src/app.mjs', 'src/alpha.mjs', 'src/beta.mjs', 'docs/final.md']); assert.equal(checked.integrationTaskId, 'final');
  checked.tasks[0].title = 'Changed copied context'; checked.task.engineeringContract.routes[0].path = '/copy'; assert.deepEqual(input, before);
});
test('ordered shared writers and legacy suggestedFiles preserve their exact input shape', () => {
  const input = { title: 'legacy path alias', tasks: [task('first', [], ['src/app.mjs']), task('last', ['first'], ['src/app.mjs'])] };
  for (const item of input.tasks) { item.suggestedFiles = item.writePaths; delete item.writePaths; }
  const checked = inspectPlannedTaskGraph(input); assert.deepEqual(checked.task, input); assert.deepEqual(checked.allPaths, ['src/app.mjs']); assert.equal(Object.hasOwn(checked.tasks[0], 'writePaths'), false);
});
test('two-task minimum and eight-task maximum valid chains are admitted', () => {
  for (const count of [2, 8]) { const input = { tasks: Array.from({ length: count }, (_, i) => task(`T${i}`, i ? [`T${i - 1}`] : [], [i ? `src/module${i}.mjs` : 'src/app.mjs'])) }; assert.equal(inspectPlannedTaskGraph(input).integrationTaskId, `T${count - 1}`); }
});
test('exact existing 96000-byte context ceiling is retained without dropping fields', () => {
  const input = graph(); input.padding = ''; input.padding = 'x'.repeat(96000 - Buffer.byteLength(JSON.stringify(input)));
  assert.equal(Buffer.byteLength(JSON.stringify(input)), 96000); assert.deepEqual(inspectPlannedTaskGraph(input).task, input);
  input.padding += 'x'; assert.throws(() => inspectPlannedTaskGraph(input), safe);
});
const failures = [
  ['non-object', () => null],
  ['empty task list', value => { value.tasks = []; return value; }],
  ['only one task', value => { value.tasks = [value.tasks[0]]; return value; }],
  ['more than eight', () => ({ tasks: Array.from({ length: 9 }, (_, i) => task(`T${i}`, i ? [`T${i - 1}`] : [], [i ? `src/t${i}.mjs` : 'src/app.mjs'])) })],
  ['duplicate identity', value => { value.tasks[2].id = 'alpha'; return value; }],
  ['invalid identity', value => { value.tasks[1].id = 'PRIVATE_INPUT_../SECRET'; return value; }],
  ['cycle', value => { value.tasks[0].dependsOn = ['final']; return value; }],
  ['unknown dependency', value => { value.tasks[1].dependsOn = ['PRIVATE_UNKNOWN_TASK']; return value; }],
  ['multiple roots', value => { value.tasks[2].dependsOn = []; return value; }],
  ['no full integration task', value => { value.tasks.pop(); return value; }],
  ['entry belongs only to later task', value => { value.tasks[0].writePaths = ['src/base.mjs']; value.tasks[1].writePaths.push('src/app.mjs'); return value; }],
  ['empty domain', value => { value.tasks[1].writePaths = []; return value; }],
  ['unsafe path', value => { value.tasks[1].writePaths = ['../PRIVATE_OUTSIDE_FILE']; return value; }],
  ['unordered shared domain', value => { value.tasks[2].writePaths = ['src/alpha.mjs']; return value; }],
  ['case-colliding files', value => { value.tasks[2].writePaths = ['src/Alpha.mjs']; return value; }],
];
for (const [name, mutate] of failures) test('unsupported graph has fixed safe error: ' + name, () => { assert.throws(() => inspectPlannedTaskGraph(mutate(graph())), safe); });
test('input accessors and toJSON are never executed by pure admission', () => {
  let calls = 0; const getter = graph(); Object.defineProperty(getter, 'tasks', { enumerable: true, get() { calls++; return []; } }); assert.throws(() => inspectPlannedTaskGraph(getter), safe);
  const serialized = graph(); serialized.toJSON = () => { calls++; return {}; }; assert.throws(() => inspectPlannedTaskGraph(serialized), safe);
  const nested = graph(); Object.defineProperty(nested.tasks[0], 'writePaths', { enumerable: true, get() { calls++; return ['src/app.mjs']; } }); assert.throws(() => inspectPlannedTaskGraph(nested), safe); assert.equal(calls, 0);
});
const binding = { projectId: 'admission', runId: 'approved-plan', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
function approved(tasks) {
  const proposal = { version: 1, id: 'admission-contract', name: 'Approved fixture observations', sessions: [], steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R'], request: { id: 'get', method: 'GET', path: '/', assertions: [{ id: 'status', op: 'status', value: 200 }] } }], browser: { version: 1, sessions: ['u'], steps: [{ id: 'go', session: 'u', requirementIds: ['R'], op: 'goto', path: '/' }, { id: 'shown', session: 'u', requirementIds: ['R'], op: 'visible', testId: 'x', value: true }] }, taskScopes: tasks.map(item => ({ taskId: item.id, httpStepIds: ['read'], browserStepIds: ['shown'] })) };
  const control = createVerificationControl(), input = { proposal, tasks, requirements: ['R'], binding }, approval = control.approve(input), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval); return manifest;
}
for (const name of ['only one task', 'more than eight', 'multiple roots', 'no full integration task', 'entry belongs only to later task']) test('start uses the same admission and does no model call or output creation: ' + name, async () => {
  const unsupported = failures.find(([label]) => label === name)[1](graph()), manifest = approved(unsupported.tasks), outputDir = path.join(os.tmpdir(), 'unsupported-task-graph-' + randomUUID());
  let calls = 0; const provider = async () => { calls++; throw new Error('must never invoke a model'); };
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
  assert.throws(() => startPlannedTaskExecution({ task: unsupported, manifest, binding, outputDir, provider, reviewer: provider, assertCurrent: () => true }), safe);
  assert.equal(calls, 0); await assert.rejects(access(outputDir), { code: 'ENOENT' });
});
