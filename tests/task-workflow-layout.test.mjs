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

function diagram({ plan = tasks, states = {}, ...layout } = {}) {
  const dependencies = new Map(plan.map(task => [task.id, task.dependsOn]));
  const edges = plan.flatMap(task => task.dependsOn.map(source => ({ source, target: task.id, relation: 'upstream' })));
  const nodes = plan.map(task => ({ id: task.id, title: task.id, gateState: 'planned', ...states[task.id] }));
  return projectWorkflow({ tasks: plan, graph: { dependencies }, nodes, edges, ...layout });
}

const module = (diagram, taskId) => diagram.nodes.find(node => node.id === taskId);
const operation = (diagram, taskId, step) => module(diagram, taskId).operations.find(item => item.step === step);

test('every real task starts collapsed in its functional phase, with siblings arranged from left to right', () => {
  const plan = [...tasks, { id: '任务「任意 / ID」', title: '兼容旧任务', dependsOn: ['release'] }];
  const model = diagram({ plan });
  assert.deepEqual(model.nodes.map(node => node.id).sort(), plan.map(task => task.id).sort());
  assert.ok(model.nodes.every(node => node.kind === 'agent' && node.id === node.taskId));
  assert.deepEqual(model.laneOrder, ['基础', '预约', '通知', '工程开发']);
  assert.equal(model.detailBounds, null);
  assert.ok(model.nodes.every(node => !node.expanded && node.movable));
  assert.deepEqual(model.groups.map(group => group.count), [1, 3, 1, 1]);
  assert.equal(module(model, 'left').title, '发起预约');
  assert.equal(module(model, 'right').title, '核对资格');
  assert.equal(module(model, '任务「任意 / ID」').title, '兼容旧任务');
  assert.equal(module(model, 'release').group, '预约');
  assert.equal(module(model, 'left').position.y, module(model, 'release').position.y);
  assert.equal(module(model, 'left').position.y, module(model, 'right').position.y);
  assert.ok(module(model, 'left').position.x + model.nodeWidth < module(model, 'right').position.x);
  assert.ok(module(model, 'right').position.x + model.nodeWidth < module(model, 'release').position.x);
  assert.ok(module(model, 'left').position.y < module(model, 'notice').position.y);
  assert.deepEqual(module(model, 'left').operations.map(item => item.step), ['agent', 'self', 'http', 'browser', 'review']);
});

test('same-depth swaps update local slots or move whole lanes without changing ownership or depth', () => {
  const original = diagram();
  const withinLane = reorderWorkflow(original, 'left', 'right');
  const reordered = diagram({ order: withinLane });
  assert.deepEqual(reordered.laneOrder, original.laneOrder);
  assert.deepEqual(module(reordered, 'left').position, module(original, 'right').position);
  assert.deepEqual(module(reordered, 'right').position, module(original, 'left').position);
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

test('branches and joins follow actual dependency direction between and within phases', () => {
  const model = diagram();
  assert.deepEqual(model.edges.map(edge => [edge.fromTask, edge.toTask]), [
    ['base', 'left'], ['base', 'right'], ['base', 'notice'],
    ['left', 'release'], ['right', 'release'], ['notice', 'release'], ['base', 'release'],
  ]);
  assert.ok(model.edges.every(edge => !edge.internal && edge.source === edge.fromTask && edge.target === edge.toTask));
  assert.deepEqual(model.edges.map(edge => [edge.sourceSide, edge.targetSide]), [
    ['bottom','top'], ['bottom','top'], ['bottom','top'], ['bottom','bottom'],
    ['right','left'], ['top','bottom'], ['bottom','top'],
  ]);
  assert.deepEqual(model.edges.slice(0, 3).map(edge => edge.caption), ['分支 1', '分支 2', '分支 3']);
  const long = model.edges.find(edge => edge.fromTask === 'base' && edge.toTask === 'notice');
  const source = module(model, 'base'), fromLane = model.groups.find(group => group.id === source.group);
  assert.ok(long.channel < fromLane.rowBottom && long.targetChannel < model.groups[2].top);
  assert.ok(Number.isFinite(long.viaX));
  assert.equal(source.fork.count, 4);
  assert.equal(module(model, 'release').join.count, 4);
  assert.equal(module(model, 'release').checkpoint.delivery, true);
  assert.equal(module(model, 'left').checkpoint, undefined);
});

test('expanding reserves space in exactly one group; links skirt the detail frame in both directions', () => {
  const start = diagram();
  for (const id of tasks.map(task => task.id)) {
    const expanded = diagram({ expandedId: id });
    const detail = expanded.detailBounds;
    const lane = expanded.groups.find(group => group.expanded);
    assert.equal(lane.id, module(expanded, id).group);
    assert.deepEqual(expanded.nodes.filter(node => node.expanded).map(node => node.id), [id]);
    assert.ok(detail.width >= 860 && detail.height >= 250);
    assert.ok(detail.x >= lane.left && detail.x + detail.width <= lane.left + lane.width);
    assert.ok(detail.y >= lane.rowBottom && detail.y + detail.height < lane.top + lane.height);
    assert.deepEqual(expanded.edges.map(edge => edge.id), start.edges.map(edge => edge.id));
    for (const node of expanded.nodes.filter(node => node.group === lane.id)) {
      assert.ok(node.position.y + node.height < detail.y);
    }
    for (const edge of expanded.edges) {
      const from = module(expanded, edge.source), to = module(expanded, edge.target);
      if (Math.min(from.position.y, to.position.y) < detail.y && Math.max(from.position.y, to.position.y) > detail.y + detail.height) {
        assert.ok(edge.viaX < detail.x || edge.viaX > detail.x + detail.width);
      }
    }
  }
  assert.equal(diagram({ expandedId: 'missing' }).detailBounds, null);
});

test('saved two-axis offsets survive collapse, stay within their phase, and never modify logical order', () => {
  const original = diagram();
  const positions = { base: {x: 42, y: 16}, left: {x: Infinity, y: 1e7}, right: {x: 1e7, y: -1e7} };
  const moved = diagram({ positions }), expanded = diagram({ positions, expandedId: 'base' });
  const first = module(moved, 'base');
  assert.deepEqual(first.basePosition, module(original, 'base').position);
  assert.deepEqual(first.position, {x:first.basePosition.x + 42,y:first.basePosition.y + 16});
  for (const id of ['base','left','right']) {
    const current = module(moved, id), afterExpand = module(expanded, id);
    assert.equal(current.position.x, afterExpand.position.x);
    assert.equal(current.position.y - current.basePosition.y, afterExpand.position.y - afterExpand.basePosition.y);
    assert.ok(current.position.x >= current.movementBounds.minX && current.position.x <= current.movementBounds.maxX);
    assert.ok(current.position.y >= current.movementBounds.minY && current.position.y <= current.movementBounds.maxY);
  }
  assert.equal(module(moved, 'left').position.x, module(moved, 'left').basePosition.x);
  assert.deepEqual(moved.orders, original.orders);
  assert.deepEqual(moved.edges.map(edge => edge.id), original.edges.map(edge => edge.id));
});

test('cyclic and legacy tasks remain draggable and inspectable without a release claim', () => {
  const plan = [{id:'__proto__',dependsOn:['cycle']},{id:'cycle',dependsOn:['__proto__','cycle']}];
  const projected = diagram({plan,expandedId:'__proto__'});
  assert.ok(projected.nodes.every(node => node.movable && Number.isFinite(node.position.x)));
  assert.equal(projected.groups.length, 1);
  assert.ok(projected.edges.every(edge => edge.caption === '依赖待核对'));
  assert.ok(projected.nodes.every(node => !node.checkpoint?.delivery));
  assert.ok(projected.detailBounds);
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
