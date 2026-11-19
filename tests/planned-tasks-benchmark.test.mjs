import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preflightPlannedTasks } from '../scripts/check-planned-tasks.mjs';
import { plannedNotesTags } from '../examples/planned-notes-tags.mjs';
import { assertCompiledManifest, assertTaskCompiledManifest, compileTaskManifest } from '../lib/verification-contract.mjs';
import { assertEngineeringAlignment } from '../lib/engineering-planner.mjs';

// Free structural/approval probes only. No generated target app, real model,
// sandbox or browser is run, and no fixture is described as accepted software.
let preflight;
before(async () => { preflight = await preflightPlannedTasks(); });

test('public four-task fixture survives real specification normalization and full engineering/task projection alignment', () => {
  assert.equal(preflight.status, 'preflight_passed'); assert.equal(preflight.actualModelCalls, 0); assert.equal(preflight.operatorFixtureRequests, 1); assert.equal(preflight.taskAccepted, false);
  assert.deepEqual(preflight.spec.requirements.map(r => r.id), ['R-001', 'R-002', 'R-003', 'R-004']);
  for (const r of preflight.spec.requirements) assert.ok(plannedNotesTags.requirements.includes(r.sourceQuote));
  assertEngineeringAlignment({ id: preflight.binding.runId, projectId: preflight.binding.projectId, spec: preflight.spec, specRevision: preflight.binding.specRevision,
    engineeringPlan: preflight.engineeringPlan, tasks: preflight.engineeringPlan.proposal.tasks.map(t => ({ ...structuredClone(t), category: '工程开发', suggestedFiles: [...t.writePaths] })) });
  assert.deepEqual(preflight.task.tasks.map(t => [t.id, t.dependsOn]), [['BASE', []], ['NOTES', ['BASE']], ['TAGS', ['BASE']], ['FINAL', ['NOTES', 'TAGS']]]);
  const names = preflight.task.tasks.flatMap(t => t.writePaths); assert.equal(new Set(names).size, names.length); assert.equal(names.length, 10);
  assert.deepEqual(preflight.task.tasks.find(t => t.id === 'FINAL').writePaths, ['docs/usage.md']);
  assert.equal(preflight.task.tasks.filter(t => t.writePaths.includes('src/app.mjs')).length, 1);
  for (const task of preflight.task.tasks) assert.deepEqual(Object.keys(task).sort(), ['id', 'title', 'description', 'requirementIds', 'dependsOn', 'inputs', 'outputs', 'acceptance', 'writePaths'].sort());
});

test('approved child scopes isolate the base and two independent HTTP/browser dependency closures', () => {
  assert.equal(assertCompiledManifest(preflight.manifest, preflight.binding), preflight.manifest); assert.ok(Object.isFrozen(preflight.manifest));
  const children = new Map(preflight.children.map(x => [x.taskId, x.manifest]));
  const base = children.get('BASE'); assert.deepEqual(base.browser.sessions, ['shell']); assert.ok(base.steps.every(s => ['health', 'home', 'style', 'icon', 'icon_head'].includes(s.id)));
  assert.ok(!JSON.stringify(base.steps).includes('/api/')); assert.ok(base.browser.steps.every(s => !['click', 'fill'].includes(s.op)));
  for (const [id, prefix, other] of [['NOTES', 'notes', 'tags'], ['TAGS', 'tags', 'notes']]) {
    const child = children.get(id); assert.equal(assertTaskCompiledManifest(child, preflight.binding, id), child); assert.deepEqual(child.browser.sessions, [prefix]);
    assert.ok(child.steps.length > 5); assert.ok(child.steps.every(s => s.id.startsWith(prefix + '_'))); assert.ok(!child.steps.some(s => s.id.startsWith(other + '_') || s.id.startsWith('joint_')));
    assert.ok(child.steps.some(s => s.type === 'restart')); assert.ok(child.browser.steps.some(s => s.op === 'fill')); assert.ok(child.browser.steps.some(s => s.op === 'text' && s.value === '名称已存在'));
  }
});

test('final definition freezes all requirements, restart persistence and all browser sessions before any coding', () => {
  const final = preflight.children.find(x => x.taskId === 'FINAL').manifest;
  assert.deepEqual(final.steps, preflight.manifest.steps); assert.deepEqual(final.browser.steps, preflight.manifest.browser.steps); assert.deepEqual(final.browser.sessions, ['shell', 'notes', 'tags', 'integration']);
  assert.ok(final.browser.steps.length < 60); assert.ok(final.steps.length <= 40);
  assert.deepEqual(final.steps.find(s => s.id === 'joint_restart').dependsOn, ['notes_saved', 'tags_saved']);
  for (const many of ['notes', 'tags']) {
    const steps = final.steps.filter(s => s.id.startsWith(many + '_'));
    for (const suffix of ['duplicate', 'blank', 'long', 'invalid']) assert.ok(steps.some(s => s.id === `${many}_${suffix}`));
    assert.equal(steps.find(s => s.id === `${many}_long`).request.body.name.length, 101);
    assert.equal(steps.find(s => s.id === `${many}_duplicate`).request.assertions[0].value, 409);
    assert.equal(steps.find(s => s.id === `${many}_saved`).request.assertions.find(a => a.op === 'jsonLength').value, 1);
  }
  assert.equal(plannedNotesTags.files, undefined, 'benchmark must not provide target implementation or a fake coding adapter');
  const renamed = structuredClone(preflight.spec.requirements).reverse(); assert.deepEqual(plannedNotesTags.definitionFor(renamed), preflight.definition, 'semantic titles preserve IDs when incoming requirement order changes');
});

test('changed confirmed task fields and invented requirement mapping cannot recompile the prior approval', () => {
  const changed = structuredClone(preflight.task.tasks); changed[1].writePaths.push('src/app.mjs');
  assert.throws(() => compileTaskManifest({ manifest: preflight.manifest, taskId: 'NOTES', tasks: changed }));
  const reqs = structuredClone(preflight.spec.requirements); reqs[0].title = 'other'; assert.throws(() => plannedNotesTags.definitionFor(reqs));
  assert.throws(() => plannedNotesTags.definitionFor(preflight.spec.requirements.slice(1)));
  const contract = preflight.task.tasks.map(t => t.description).join('\n'); for (const expected of ['createApp({databasePath})', 'createModule({db})', '动态import', 'favicon.ico', 'text/javascript', '不fetch未来业务']) assert.ok(contract.includes(expected), expected);
});

test('CLI free preflight is explicit, imports no private configuration and rejects implicit or fixture execution modes', async () => {
  const evidence = path.resolve('output/full-goal-20261118/tasks-benchmark-author'); await mkdir(evidence, { recursive: true });
  const env = { ...process.env, LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: '', EXECUTION_SANDBOX_EXE: '' }; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['scripts/check-planned-tasks.mjs', '--preflight'], { encoding: 'utf8', env, timeout: 10000, windowsHide: true });
  await writeFile(path.join(evidence, 'preflight-cli.log'), child.stdout + child.stderr); assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.actualModelCalls, 0); assert.equal(result.taskAccepted, false); assert.equal(result.coverage, 'structural_only'); assert.deepEqual(result.taskIds, ['BASE', 'NOTES', 'TAGS', 'FINAL']);
  const data = JSON.parse(await readFile(path.join(result.root, 'preflight.json'), 'utf8')); assert.equal(data.taskAccepted, false); assert.ok(data.children.length === 4);
  for (const args of [[], ['--fixture'], ['--model', '--extra']]) {
    const rejected = spawnSync(process.execPath, ['scripts/check-planned-tasks.mjs', ...args], { encoding: 'utf8', env, timeout: 10000, windowsHide: true }); assert.equal(rejected.status, 2); assert.equal(rejected.stdout, '');
  }
});

test('new delayed-load benchmark freezes both creation regressions in each owner and final integration before coding', async () => {
  const base = await preflightPlannedTasks(), changed = await preflightPlannedTasks({ loadRace: true });
  assert.equal(changed.actualModelCalls, 0); assert.equal(changed.taskAccepted, false); assert.notEqual(changed.manifest.manifestHash, base.manifest.manifestHash);
  assert.equal(base.definition.browser.steps.some(step => step.op === 'createWithDelayedLoad'), false, 'old fixture remains unchanged');
  for (const [taskId, expected] of [['BASE', []], ['NOTES', ['note_delayed_create']], ['TAGS', ['tag_delayed_create']], ['FINAL', ['note_delayed_create', 'tag_delayed_create']]]) {
    const manifest = changed.children.find(item => item.taskId === taskId).manifest;
    assert.deepEqual(manifest.browser.steps.filter(step => step.op === 'createWithDelayedLoad').map(step => step.id), expected);
  }
});
