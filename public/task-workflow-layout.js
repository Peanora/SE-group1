const OPERATIONS = [
  { step: 'agent', title: '编码智能体', roleHelp: '按当前计划和已集成的前置结果编写代码。' },
  { step: 'self', title: '编码自检', roleHelp: '执行编码自检并核对固定候选。' },
  { step: 'http', title: 'HTTP 验收', roleHelp: '按已批准清单核对接口及业务结果。' },
  { step: 'browser', title: 'Edge 验收', roleHelp: '在 Edge 中验证已批准的可观察业务结果。' },
  { step: 'review', title: '审查智能体', roleHelp: '在独立测试通过后审查同一候选。' },
];

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function orderedRanks(ids, dependencies, dependants, savedOrder) {
  const pending = new Map(ids.map(id => [id, dependencies.get(id).length]));
  const levels = new Map();
  const queue = ids.filter(id => pending.get(id) === 0);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const next of dependants.get(id)) {
      levels.set(next, Math.max(levels.get(next) ?? 0, (levels.get(id) ?? 0) + 1));
      const remaining = pending.get(next) - 1;
      pending.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  const orders = [], ranks = new Map(), lanes = new Map(), unresolved = new Set();
  for (const id of ids) {
    // A rejected or imported cyclic graph is still useful to inspect.
    if (pending.get(id) !== 0) unresolved.add(id);
    const rank = unresolved.has(id) ? 0 : levels.get(id) ?? 0;
    ranks.set(id, rank);
    (orders[rank] ??= []).push(id);
  }
  for (let rank = 0; rank < orders.length; rank++) {
    const row = orders[rank];
    const centers = new Map(row.map(id => {
      const parents = dependencies.get(id).map(parent => lanes.get(parent)).filter(Number.isFinite);
      return [id, parents.length ? parents.reduce((sum, lane) => sum + lane, 0) / parents.length : 0];
    }));
    row.sort((a, b) => centers.get(a) - centers.get(b));
    const existing = new Set(row), saved = Array.isArray(savedOrder?.[rank]) ? savedOrder[rank] : [];
    const requested = saved.filter(id => existing.delete(id));
    orders[rank] = [...requested, ...row.filter(id => existing.has(id))];
    orders[rank].forEach((id, index) => lanes.set(id, index - (row.length - 1) / 2));
  }
  return { orders, ranks, unresolved };
}

function state(gateState, gateLabel) {
  return { gateState, gateLabel };
}

function joinState(parents, bases) {
  const gates = parents.map(id => bases.get(id)?.gateState ?? 'planned');
  const waitingCount = gates.filter(gate => gate !== 'passed').length;
  if (!waitingCount) return state('passed', '前置全部通过');
  if (gates.includes('failed')) return state('failed', '有前置未通过');
  if (gates.every(gate => gate === 'planned')) return state('planned', '须满足全部前置');
  return state('waiting', `等待 ${waitingCount} 项前置通过`);
}

function forkState(checkpoint) {
  if (checkpoint === 'passed') return state('passed', '后继各自核对依赖');
  if (checkpoint === 'failed') return state('failed', '源检查点未放行');
  if (checkpoint === 'planned' || !checkpoint) return state('planned', '检查点通过后分叉');
  return state('waiting', '等待源检查点通过');
}

function observedChecks(checks, { active, complete }) {
  if (!Array.isArray(checks) || !checks.length) return active ? state('checking', '进行中') : state('waiting', '待核对');
  const passed = checks.filter(check => check?.passed === true).length;
  const failed = checks.filter(check => check?.passed === false).length;
  if (failed) return state('failed', `${failed} 项未通过`);
  if (passed === checks.length && complete) return state('passed', `${passed} 项通过`);
  return state(active ? 'checking' : 'waiting', `${passed}/${checks.length} 项通过`);
}

function roleStates(base) {
  const observed = base.observed;
  const planned = state('planned', '待执行');
  if (!observed) {
    return {
      agent: (base.gateState ?? 'planned') === 'planned' ? planned : state('waiting', '等待派发'),
      self: planned, http: planned, browser: planned, review: planned,
    };
  }
  const writing = ['generating', 'proposal_rejected'].includes(observed.stage);
  const active = observed.status === 'running';
  const fixed = !writing && COMMIT.test(observed.candidateCommit ?? '');
  // The latest task DTO may retain old checks while a revised candidate is written.
  const checks = !writing && (fixed || active && observed.stage === 'validating') ? observed.checks : undefined;
  const completedReview = checks?.review === 'completed';
  const tested = completedReview || fixed && ['completed', 'verified', 'accepted'].includes(observed.status);
  const testing = active && observed.stage === 'validating' && !completedReview;
  const blockers = completedReview && checks.issues?.some(issue => issue.severity === 'blocking' && issue.status !== 'resolved');
  let review = state('waiting', '等待独立测试');
  if (completedReview) review = blockers ? state('failed', '有阻塞意见') : state('passed', '审查完成');
  else if (checks?.review === 'checking') review = state('checking', '正在审查');
  else if (['error', 'reconciliation_required'].includes(checks?.review)) review = state('waiting', '审查结论待核对');
  const self = checks?.self?.length ? observedChecks(checks.self, { active: false, complete: fixed })
    : active && observed.stage === 'self_check' ? state('checking', '正在自检')
      : fixed || observed.stage === 'validating' ? state('waiting', '自检证据待回查') : state('waiting', '等待候选');
  return {
    agent: active && writing ? state('checking', '正在编码')
      : fixed ? state('passed', '候选已固定')
        : active ? state('checking', '正在准备候选') : state('waiting', '等待候选'),
    self,
    http: observedChecks(checks?.http, { active: testing, complete: tested }),
    browser: observedChecks(checks?.browser, { active: testing, complete: tested }),
    review,
  };
}

function label(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
}

function orderWithin(known, saved) {
  const remaining = new Set(known);
  const ordered = Array.isArray(saved) ? saved.filter(id => remaining.delete(id)) : [];
  return [...ordered, ...remaining];
}

/** Project real tasks into horizontal depth columns and stable functional lanes. */
export function projectWorkflow({ tasks, graph, narrow = false, nodes, edges, order }) {
  const definitions = new Map(tasks.map(task => [task.id, task]));
  const ids = [...definitions.keys()];
  const bases = new Map(nodes.map(node => [node.id, node]));
  const dependencies = new Map(ids.map(id => [id, [...new Set(graph.dependencies.get(id) ?? [])].filter(parent => definitions.has(parent))]));
  const dependants = new Map(ids.map(id => [id, []]));
  for (const [id, parents] of dependencies) {
    for (const parent of parents) dependants.get(parent).push(id);
  }
  const { orders: depthOrder, ranks, unresolved } = orderedRanks(ids, dependencies, dependants, Array.isArray(order) ? order : order?.ranks);
  const terminals = ids.filter(id => dependants.get(id).length === 0);
  const deliveryTask = unresolved.size === 0 && terminals.length === 1 ? terminals[0] : undefined;
  const groupByTask = new Map(ids.map(id => {
    const task = definitions.get(id);
    return [id, label(task.workflowModule?.group) || label(task.category) || '工程开发'];
  }));
  const laneOrder = orderWithin(depthOrder.flat().map(id => groupByTask.get(id)), order?.lanes);
  const nodeWidth = narrow ? 182 : 196, nodeHeight = 78;
  const columnGap = narrow ? 54 : 52, columnStep = nodeWidth + columnGap;
  const padding = narrow ? 22 : 24, laneGap = 9, stackGap = 9, headingHeight = 26;
  const width = Math.max(320, padding * 2 + (depthOrder.length ? depthOrder.length * columnStep - columnGap : 0));
  const rankLeft = rank => padding + rank * columnStep;
  const modules = [], groups = [];
  let top = 36;

  laneOrder.forEach((group, rank) => {
    const byDepth = depthOrder.map(row => row.filter(id => groupByTask.get(id) === group));
    const slots = Math.max(1, ...byDepth.map(row => row.length));
    const height = headingHeight + slots * nodeHeight + (slots - 1) * stackGap + 10;
    groups.push({ id: group, rank, title: group, top, height, left: 10, width: width - 20, count: byDepth.flat().length });
    byDepth.forEach((row, depth) => row.forEach((id, slot) => {
      const task = definitions.get(id), base = bases.get(id) ?? {};
      const parents = dependencies.get(id), children = dependants.get(id);
      const evidence = roleStates(base);
      const gateState = base.gateState ?? 'planned';
      const gateLabel = base.gateLabel ?? '验收通过后放行';
      const junction = children.length > 1 || parents.length > 1;
      const delivery = id === deliveryTask;
      const blocked = gateState !== 'passed'
        && (base.observed?.status === 'blocked' || parents.some(parent => bases.get(parent)?.gateState === 'failed'));
      modules.push({
        id, taskId: id, kind: 'agent', step: 'agent', role: 'coding', roleLabel: '编码智能体',
        title: label(task.workflowModule?.name) || task.title || base.title || id,
        label: base.label ?? '', meta: base.meta ?? '', roleHelp: OPERATIONS[0].roleHelp,
        group, rank: depth, movable: !unresolved.has(id) && depthOrder[depth].some(other => other !== id && !unresolved.has(other)),
        position: { x: rankLeft(depth), y: top + headingHeight + slot * (nodeHeight + stackGap) },
        width: nodeWidth, height: nodeHeight, selected: Boolean(base.selected), className: base.className ?? '',
        gateState, gateLabel, reviewState: evidence.review.gateState, reviewLabel: evidence.review.gateLabel,
        operations: OPERATIONS.map(operation => ({ ...operation, ...evidence[operation.step] })),
        ...(parents.length > 1 ? { join: { count: parents.length, ...joinState(parents, bases) } } : {}),
        ...(children.length > 1 ? { fork: { count: children.length, ...forkState(gateState) } } : {}),
        ...(junction || delivery || blocked || gateState === 'failed' ? { checkpoint: { gateState, gateLabel, delivery, blocked } } : {}),
      });
    }));
    top += height + laneGap;
  });

  const byId = new Map(modules.map(node => [node.id, node]));
  const laneById = new Map(groups.map(group => [group.id, group]));
  const orders = depthOrder.map(row => [...row].sort((a, b) => byId.get(a).position.y - byId.get(b).position.y));
  const columns = orders.map((row, rank) => ({
    rank, title: `第 ${rank + 1} 层`, left: rankLeft(rank), width: nodeWidth, count: row.length,
  }));
  const keys = (source, target) => JSON.stringify([source, target]);
  const originalEdges = new Map(edges.map(edge => [keys(edge.source, edge.target), edge]));
  const idsInUse = new Set(ids);
  const visualEdges = [...dependencies].flatMap(([target, parents]) => parents.map((source, index) => {
    const from = byId.get(source), to = byId.get(target);
    const original = originalEdges.get(keys(source, target));
    const branch = from.fork ? dependants.get(source).indexOf(target) + 1 : 0;
    const pendingTopology = unresolved.has(source) || unresolved.has(target);
    const caption = pendingTopology ? '依赖待核对' : branch ? `分支 ${branch}${to.join ? ' · 汇入' : ''}`
      : to.join ? '汇入' : from.gateState === 'passed' ? '已放行' : from.gateState === 'failed' ? '未放行' : '';
    const lane = laneById.get(from.group);
    const channel = to.rank === from.rank + 1 ? null : lane.top + lane.height + 2 + index % 3 * 2;
    let id = 'workflow-dependency-' + keys(source, target).replace(/[^a-zA-Z0-9-]/gu, character => `_${character.codePointAt(0).toString(16)}_`);
    while (idsInUse.has(id)) id += '-';
    idsInUse.add(id);
    return {
      id, source, target, fromTask: source, toTask: target, caption: original?.caption || caption,
      relation: original?.relation ?? 'muted', channel, internal: false, sourceSide: 'right', targetSide: 'left',
    };
  }));
  return { nodes: modules, edges: visualEdges, groups, columns, width, height: Math.max(260, top), nodeWidth, nodeHeight, ranks, orders, laneOrder };
}

/** Swap same-depth modules, preserving lane ownership and dependency depth. */
export function reorderWorkflow(layout, taskId, targetId) {
  if (taskId === targetId) return null;
  const source = layout.nodes.find(node => node.id === taskId);
  const target = layout.nodes.find(node => node.id === targetId);
  if (!source?.movable || !target?.movable || source.rank !== target.rank) return null;
  const ranks = layout.orders.map(row => [...row]);
  const lanes = [...layout.laneOrder];
  const order = source.group === target.group ? ranks[source.rank] : lanes;
  const from = order.indexOf(source.group === target.group ? taskId : source.group);
  const to = order.indexOf(source.group === target.group ? targetId : target.group);
  [order[from], order[to]] = [order[to], order[from]];
  return { lanes, ranks };
}
