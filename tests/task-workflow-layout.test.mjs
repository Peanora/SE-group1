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
  assert.deepEqual(model.groups.map(group => [group.group, group.count]), [
    ['基础', 1], ['预约', 2], ['通知', 1], ['预约', 1], ['工程开发', 1],
  ]);
  assert.equal(new Set(model.groups.map(g => g.id)).size, model.groups.length);
  assert.equal(model.groups[3].title, '预约（续）');
  assert.equal(module(model, 'left').title, '发起预约');
  assert.equal(module(model, 'right').title, '核对资格');
  assert.equal(module(model, '任务「任意 / ID」').title, '兼容旧任务');
  assert.equal(module(model, 'release').group, '预约');
  assert.equal(module(model, 'left').position.y, module(model, 'right').position.y);
  assert.ok(module(model, 'left').position.x + model.nodeWidth < module(model, 'right').position.x);
  assert.ok(module(model, 'right').position.y + model.nodeHeight < module(model, 'release').position.y);
  assert.ok(module(model, 'left').position.y < module(model, 'notice').position.y);
  assert.deepEqual(module(model, 'left').operations.map(item => item.step), ['agent', 'self', 'http', 'browser', 'review']);
});

test('a single-board chain gets three visible phases and expands immediately under the selected task', () => {
  const plan = Array.from({ length: 80 }, (_, i) => ({ id: 'T' + i, dependsOn: i ? ['T' + (i - 1)] : [] }));
  for (const narrow of [false, true]) {
    const model = diagram({ plan, narrow }), expanded = diagram({ plan, narrow, expandedId: 'T30' });
    assert.deepEqual(model.groups.map(({ title, count, inferred }) => [title, count, inferred]), [
      ['起始任务', 1, true], ['后续任务', 78, true], ['末层任务', 1, true],
    ]);
    assert.deepEqual(expanded.groups.map(group => group.id), model.groups.map(group => group.id));
    assert.ok(model.width <= (narrow ? 320 : 1120));
    assert.equal(new Set(model.nodes.map(n => n.position.x)).size, 1);
    for (const [i, n] of model.nodes.entries()) {
      const e = expanded.nodes[i];
      assert.deepEqual(e.position, i <= 30 ? n.position : { x: n.position.x, y: n.position.y + expanded.height - model.height });
      if (i) assert.ok(n.position.y > model.nodes[i - 1].position.y + model.nodeHeight);
    }
    assert.ok(expanded.detailBounds.y + expanded.detailBounds.height < module(expanded, 'T31').position.y);
  }
});

test('a single functional board preserves actual branch levels within three separate frames', () => {
  const plan = [
    { id: 'A', dependsOn: [] }, { id: 'B', dependsOn: ['A'] },
    { id: 'C', dependsOn: ['B'] }, { id: 'D', dependsOn: ['B'] },
    { id: 'E', dependsOn: ['C', 'D'] }, { id: 'F', dependsOn: ['D'] },
    { id: 'G', dependsOn: ['E', 'F', 'A'] },
  ].map(task => ({ ...task, workflowModule: { group: '业务开发' } }));
  const layout = diagram({ plan, expandedId: 'D' });
  assert.deepEqual(layout.laneOrder, ['业务开发']);
  assert.deepEqual(layout.groups.map(phase => layout.nodes
    .filter(node => node.phaseId === phase.id).map(node => node.id).sort()), [['A'], ['B', 'C', 'D', 'E', 'F'], ['G']]);
  assert.deepEqual(layout.edges.map(edge => [edge.source, edge.target]), plan.flatMap(task => task.dependsOn.map(id => [id, task.id])));
  const selected = layout.groups.find(phase => phase.id === module(layout, 'D').phaseId);
  assert.ok(selected.expanded && selected.top < layout.detailBounds.y);
  assert.ok(layout.detailBounds.y + layout.detailBounds.height < selected.top + selected.height);
});

test('wide independent sets wrap; their dependent starts below every row', () => {
  const roots = Array.from({ length: 9 }, (_, i) => ({ id: 'P' + i, dependsOn: [] }));
  const plan = [...roots, { id: 'merge', dependsOn: roots.map(task => task.id) }];
  for (const [narrow, capacity] of [[false, 3], [true, 2]]) {
    const model = diagram({ plan, narrow }), ys = new Map();
    for (const task of roots) {
      const n = module(model, task.id);
      ys.set(n.position.y, (ys.get(n.position.y) ?? 0) + 1);
      assert.ok(n.position.y + n.height < module(model, 'merge').position.y);
    }
    assert.equal(ys.size, Math.ceil(roots.length / capacity));
    assert.equal(Math.max(...ys.values()), capacity);
  }
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
  for (const edge of model.edges) {
    assert.deepEqual([edge.sourceSide, edge.targetSide], ['bottom', 'top']);
    assert.ok(module(model, edge.source).position.y + model.nodeHeight < module(model, edge.target).position.y);
  }
  assert.deepEqual(model.edges.slice(0, 3).map(edge => edge.caption), ['分支 1', '分支 2', '分支 3']);
  const long = model.edges.find(edge => edge.fromTask === 'base' && edge.toTask === 'notice');
  const source = module(model, 'base');
  assert.ok(long.channel > source.position.y + model.nodeHeight && long.targetChannel < module(model, 'notice').position.y);
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
    assert.equal(lane.group, module(expanded, id).group);
    assert.deepEqual(expanded.nodes.filter(node => node.expanded).map(node => node.id), [id]);
    assert.ok(detail.width >= 860 && detail.height >= 250);
    assert.ok(detail.x >= lane.left && detail.x + detail.width <= lane.left + lane.width);
    assert.ok(detail.y > module(expanded, id).position.y + expanded.nodeHeight && detail.y + detail.height < lane.top + lane.height);
    assert.deepEqual(expanded.edges.map(edge => edge.id), start.edges.map(edge => edge.id));
    assert.ok(expanded.nodes.every(node => node.position.y + node.height < detail.y || node.position.y > detail.y + detail.height));
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
  const positions = { base: {x: 42, y: 8}, left: {x: Infinity, y: 1e7}, right: {x: 1e7, y: -1e7} };
  const moved = diagram({ positions }), expanded = diagram({ positions, expandedId: 'base' });
  const first = module(moved, 'base');
  assert.deepEqual(first.basePosition, module(original, 'base').position);
  assert.deepEqual(first.position, {x:first.basePosition.x + 42,y:first.basePosition.y + 8});
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
