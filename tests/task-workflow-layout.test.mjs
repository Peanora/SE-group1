import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkflow } from '../public/task-workflow-layout.js';

const tasks = [
  { id: 'base', dependsOn: [] },
  { id: 'left', dependsOn: ['base'] },
  { id: 'right', dependsOn: ['base'] },
  { id: 'release', dependsOn: ['left', 'right', 'base'] },
];
const commit = 'a'.repeat(40);

function diagram({ plan = tasks, states = {}, order } = {}) {
  const dependencies = new Map(plan.map(task => [task.id, task.dependsOn]));
  const edges = plan.flatMap(task => task.dependsOn.map(source => ({ source, target: task.id, relation: 'upstream' })));
  const nodes = plan.map(task => ({ id: task.id, title: task.id, gateState: 'planned', ...states[task.id] }));
  return projectWorkflow({ tasks: plan, graph: { dependencies }, nodes, edges, order });
}

const step = (diagram, taskId, name) => diagram.nodes.find(node => node.taskId === taskId && node.step === name);

test('saved order is restricted to same-rank tasks and visual IDs remain stable and unique', () => {
  const base = diagram();
  const reservedId = step(base, 'base', 'self').id;
  const plan = [...tasks, { id: reservedId, dependsOn: ['release'] }, { id: '任务「任意 / ID」', dependsOn: ['release'] }];
  const original = diagram({ plan });
  const inputOrder = [['right'], ['right', 'right', 'missing', 'base'], ['release']];
  const ordered = diagram({ plan, order: inputOrder });

  assert.deepEqual(ordered.orders, [['base'], ['right', 'left'], ['release'], [reservedId, '任务「任意 / ID」']]);
  assert.deepEqual(ordered.groups.map(group => group.count), [1, 2, 1, 2]);
  assert.deepEqual(ordered.groups, original.groups);
  assert.deepEqual(diagram({ plan, order: inputOrder }), ordered);
  assert.deepEqual(inputOrder, [['right'], ['right', 'right', 'missing', 'base'], ['release']]);
  assert.deepEqual(ordered.nodes.filter(node => node.movable).map(node => node.id), ['right', 'left', reservedId, '任务「任意 / ID」']);
  assert.equal(step(ordered, reservedId, 'agent').id, reservedId);
  const identities = model => [...model.nodes, ...model.edges].map(item => item.id).sort();
  assert.deepEqual(identities(ordered), identities(original));
  assert.equal(new Set(identities(ordered)).size, ordered.nodes.length + ordered.edges.length);
});

test('only real dependencies connect a fork or checkpoint to a join or agent', () => {
  const model = diagram();
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  const direct = model.edges.filter(edge => !edge.internal);
  assert.deepEqual(direct.map(edge => [edge.fromTask, edge.toTask, nodes.get(edge.source).step, nodes.get(edge.target).step]), [
    ['base', 'left', 'fork', 'agent'],
    ['base', 'right', 'fork', 'agent'],
    ['left', 'release', 'checkpoint', 'join'],
    ['right', 'release', 'checkpoint', 'join'],
    ['base', 'release', 'fork', 'join'],
  ]);
  assert.deepEqual(direct.slice(0, 2).map(edge => edge.caption), ['分支 1', '分支 2']);
  assert.ok(Number.isFinite(direct.at(-1).channel), 'direct edge spanning another rank needs a routing channel');
  for (const edge of model.edges.filter(edge => edge.internal)) {
    assert.equal(Object.hasOwn(edge, 'fromTask'), false);
    assert.equal(Object.hasOwn(edge, 'toTask'), false);
    assert.equal(nodes.get(edge.source).taskId, nodes.get(edge.target).taskId);
  }
});

test('partial work shows only observed roles and hides stale results while rewriting the candidate', () => {
  const checks = { http: [{ passed: false }], browser: [], review: 'not_started' };
  const observed = { status: 'running', stage: 'validating', candidateCommit: commit, checks };
  const testing = diagram({ states: { base: { gateState: 'checking', observed } } });
  assert.equal(step(testing, 'base', 'http').gateState, 'failed');
  assert.equal(step(testing, 'base', 'browser').gateState, 'checking');
  assert.equal(step(testing, 'base', 'review').gateState, 'waiting');

  const rewriting = diagram({ states: { base: { gateState: 'checking', observed: {
    ...observed, stage: 'generating', checks: { ...checks, browser: [{ passed: true }], review: 'completed' },
  } } } });
  assert.equal(step(rewriting, 'base', 'agent').gateState, 'checking');
  for (const role of ['http', 'browser', 'review']) assert.equal(step(rewriting, 'base', role).gateState, 'waiting');
});

test('verified evidence leaves successors blocked until its checkpoint and all join parents are integrated', () => {
  const observed = { status: 'verified', stage: 'validating', candidateCommit: commit, checks: {
    http: [{ passed: true }], browser: [{ passed: true }], review: 'completed', issues: [],
  } };
  const base = { gateState: 'checking', gateLabel: '已有候选 · 待集成', observed };
  const verified = diagram({ states: { base } });
  assert.equal(step(verified, 'base', 'review').gateState, 'passed');
  assert.equal(step(verified, 'base', 'checkpoint').gateLabel, '已有候选 · 待集成');
  assert.equal(step(verified, 'base', 'fork').gateState, 'waiting');
  assert.equal(step(verified, 'release', 'join').gateState, 'waiting');

  const integrated = { gateState: 'passed', gateLabel: '已验收并集成', observed: { ...observed, status: 'completed' } };
  const blocked = diagram({ states: { base: integrated, left: integrated, right: { gateState: 'failed' } } });
  assert.equal(step(blocked, 'release', 'join').gateState, 'failed');
  const waiting = diagram({ states: { base: integrated, left: integrated, right: { gateState: 'checking' } } });
  assert.equal(step(waiting, 'base', 'fork').gateState, 'passed');
  assert.equal(step(waiting, 'release', 'join').gateLabel, '等待 1 项前置通过');
  const released = diagram({ states: { base: integrated, left: integrated, right: integrated } });
  assert.equal(step(released, 'release', 'join').gateState, 'passed');
  assert.equal(step(released, 'release', 'checkpoint').gateState, 'planned');
});
