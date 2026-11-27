import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkflow, reorderWorkflow } from '../public/task-workflow-layout.js';

const tasks = [
  { id: 'base', title: '工程基础', dependsOn: [], category: '基础' },
  { id: 'left', title: '旧任务左', dependsOn: ['base'], workflowModule: { group: '预约', name: '发起预约' } },
  { id: 'right', title: '核对资格', dependsOn: ['base'], workflowModule: { group: '预约' } },
  { id: 'notice', title: '生成通知', dependsOn: ['base'], workflowModule: { group: '通知' } },
  { id: 'release', title: '发布检查', dependsOn: ['left', 'right', 'notice', 'base'], workflowModule: { group: '预约' } },
];
const commit = 'a'.repeat(40);

function diagram({ plan = tasks, states = {}, order } = {}) {
  const dependencies = new Map(plan.map(task => [task.id, task.dependsOn]));
  const edges = plan.flatMap(task => task.dependsOn.map(source => ({ source, target: task.id, relation: 'upstream' })));
  const nodes = plan.map(task => ({ id: task.id, title: task.id, gateState: 'planned', ...states[task.id] }));
  return projectWorkflow({ tasks: plan, graph: { dependencies }, nodes, edges, order });
}

const module = (diagram, taskId) => diagram.nodes.find(node => node.id === taskId);
const operation = (diagram, taskId, step) => module(diagram, taskId).operations.find(item => item.step === step);

test('real tasks appear once as named modules in functional lanes which continue across depth columns', () => {
  const plan = [...tasks, { id: '任务「任意 / ID」', title: '兼容旧任务', dependsOn: ['release'] }];
  const model = diagram({ plan });
  assert.deepEqual(model.nodes.map(node => node.id).sort(), plan.map(task => task.id).sort());
  assert.ok(model.nodes.every(node => node.kind === 'agent' && node.id === node.taskId));
  assert.deepEqual(model.laneOrder, ['基础', '预约', '通知', '工程开发']);
  assert.deepEqual(model.columns.map(column => column.count), [1, 3, 1, 1]);
  assert.equal(module(model, 'left').title, '发起预约');
  assert.equal(module(model, 'right').title, '核对资格');
  assert.equal(module(model, '任务「任意 / ID」').title, '兼容旧任务');
  assert.equal(module(model, 'release').group, '预约');
  assert.equal(module(model, 'left').position.y, module(model, 'release').position.y);
  assert.equal(module(model, 'left').position.x, module(model, 'notice').position.x);
  assert.ok(module(model, 'release').position.x > module(model, 'left').position.x);
  assert.deepEqual(module(model, 'left').operations.map(item => item.step), ['agent', 'self', 'http', 'browser', 'review']);
});

test('same-depth swaps update local slots or move whole lanes without changing ownership or depth', () => {
  const original = diagram();
  const withinLane = reorderWorkflow(original, 'left', 'right');
  const reordered = diagram({ order: withinLane });
  assert.deepEqual(reordered.laneOrder, original.laneOrder);
  assert.equal(module(reordered, 'left').position.y, module(original, 'right').position.y);
  assert.equal(module(reordered, 'right').position.y, module(original, 'left').position.y);
  assert.equal(module(reordered, 'left').position.x, module(original, 'left').position.x);
  const betweenLanes = reorderWorkflow(reordered, 'left', 'notice');
  const across = diagram({ order: betweenLanes });
  assert.deepEqual(across.laneOrder, ['基础', '通知', '预约']);
  assert.equal(module(across, 'left').group, '预约');
  assert.equal(module(across, 'notice').group, '通知');
  assert.equal(module(across, 'left').rank, module(across, 'notice').rank);
  assert.ok(module(across, 'release').position.y > module(across, 'notice').position.y);
  assert.equal(reorderWorkflow(across, 'base', 'left'), null);
  assert.deepEqual(original.orders[1], ['left', 'right', 'notice']);
});

test('saved order discards obsolete or cross-depth items and keeps stable business edge IDs', () => {
  const original = diagram();
  const input = { lanes: ['通知', '不存在', '通知'], ranks: [['right'], ['right', 'right', 'missing', 'base'], ['release']] };
  const model = diagram({ order: input });
  assert.deepEqual(model.orders, [['base'], ['notice', 'right', 'left'], ['release']]);
  assert.deepEqual(model.laneOrder, ['通知', '基础', '预约']);
  assert.deepEqual(model.edges.map(edge => edge.id), original.edges.map(edge => edge.id));
  assert.deepEqual(input, { lanes: ['通知', '不存在', '通知'], ranks: [['right'], ['right', 'right', 'missing', 'base'], ['release']] });
  assert.equal(new Set([...model.nodes, ...model.edges].map(item => item.id)).size, model.nodes.length + model.edges.length);
});

test('branches and joins reflect only real dependencies with left-to-right ports and long-route separation', () => {
  const model = diagram();
  assert.deepEqual(model.edges.map(edge => [edge.fromTask, edge.toTask]), [
    ['base', 'left'], ['base', 'right'], ['base', 'notice'],
    ['left', 'release'], ['right', 'release'], ['notice', 'release'], ['base', 'release'],
  ]);
  assert.ok(model.edges.every(edge => !edge.internal && edge.sourceSide === 'right' && edge.targetSide === 'left'
    && edge.source === edge.fromTask && edge.target === edge.toTask));
  assert.deepEqual(model.edges.slice(0, 3).map(edge => edge.caption), ['分支 1', '分支 2', '分支 3']);
  const long = model.edges.at(-1);
  const source = module(model, 'base'), fromLane = model.groups.find(group => group.id === source.group);
  assert.ok(long.channel > fromLane.top + fromLane.height && long.channel < model.groups[1].top);
  assert.equal(source.fork.count, 4);
  assert.equal(module(model, 'release').join.count, 4);
  assert.equal(module(model, 'release').checkpoint.delivery, true);
  assert.equal(module(model, 'left').checkpoint, undefined);
});

test('candidate evidence states remain in expanded operations and old checks do not leak across rewrites', () => {
  const checks = { http: [{ passed: false }], browser: [], review: 'not_started' };
  const observed = { status: 'running', stage: 'validating', candidateCommit: commit, checks };
  const testing = diagram({ states: { base: { gateState: 'checking', observed } } });
  assert.equal(operation(testing, 'base', 'http').gateState, 'failed');
  assert.equal(operation(testing, 'base', 'browser').gateState, 'checking');
  assert.equal(module(testing, 'base').reviewState, 'waiting');

  const rewriting = diagram({ states: { base: { gateState: 'checking', observed: {
    ...observed, stage: 'generating', checks: { ...checks, browser: [{ passed: true }], review: 'completed' },
  } } } });
  assert.equal(operation(rewriting, 'base', 'agent').gateState, 'checking');
  for (const role of ['http', 'browser', 'review']) assert.equal(operation(rewriting, 'base', role).gateState, 'waiting');
});

test('a verified candidate waits for integration, while a failed ordinary module gains a visible checkpoint', () => {
  const observed = { status: 'verified', stage: 'validating', candidateCommit: commit, checks: {
    http: [{ passed: true }], browser: [{ passed: true }], review: 'completed', issues: [],
  } };
  const verified = diagram({ states: { base: { gateState: 'checking', gateLabel: '已有候选 · 待集成', observed } } });
  assert.equal(module(verified, 'base').reviewState, 'passed');
  assert.equal(module(verified, 'base').checkpoint.gateLabel, '已有候选 · 待集成');
  assert.equal(module(verified, 'base').fork.gateState, 'waiting');
  assert.equal(module(verified, 'release').join.gateState, 'waiting');

  const integrated = { gateState: 'passed', gateLabel: '已验收并集成', observed: { ...observed, status: 'completed' } };
  const blocked = diagram({ states: { base: integrated, left: integrated, notice: integrated, right: { gateState: 'failed' } } });
  assert.equal(module(blocked, 'release').join.gateState, 'failed');
  assert.equal(module(blocked, 'right').checkpoint.gateState, 'failed');
  assert.equal(module(blocked, 'release').checkpoint.blocked, true);
  const waiting = diagram({ states: { base: integrated, left: integrated, notice: integrated, right: { gateState: 'checking' } } });
  assert.equal(module(waiting, 'base').fork.gateState, 'passed');
  assert.equal(module(waiting, 'release').join.gateLabel, '等待 1 项前置通过');
  const released = diagram({ states: { base: integrated, left: integrated, notice: integrated, right: integrated } });
  assert.equal(module(released, 'release').join.gateState, 'passed');
  assert.equal(module(released, 'release').checkpoint.gateState, 'planned');
  assert.equal(module(released, 'release').checkpoint.blocked, false);
});

test('independent terminal tasks do not claim project delivery', () => {
  const model = diagram({ plan: [...tasks, { id: 'other', dependsOn: ['notice'] }] });
  assert.equal(module(model, 'release').checkpoint.delivery, false);
  assert.equal(module(model, 'other').checkpoint, undefined);
});
