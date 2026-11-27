const STEPS = ['agent', 'self', 'http', 'browser', 'review', 'checkpoint'];
const TITLES = {
  self: '编码自检',
  http: 'HTTP 验收',
  browser: 'Edge 验收',
  review: '审查智能体',
  checkpoint: '验收检查点',
  fork: '分叉',
  join: '汇合',
};
const ROLE_HELP = {
  agent: '按当前计划和已集成的前置结果编写代码。',
  self: '执行编码自检并核对固定候选。',
  http: '按已批准清单核对接口及业务结果。',
  browser: '在 Edge 中验证已批准的可观察业务结果。',
  review: '在独立测试通过后审查同一候选。',
  checkpoint: '当前候选完成同版本验收并集成后才放行后继。',
  fork: '检查点放行后，后继任务仍须各自满足其直接依赖。',
  join: '任务须等全部直接前置任务通过检查点后才可派发。',
};
const ROLE_KIND = {
  agent: 'agent', self: 'tool', http: 'tool', browser: 'tool',
  review: 'review', checkpoint: 'checkpoint', fork: 'fork', join: 'join',
};
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
      agent: base.gateState === 'planned' ? planned : state('waiting', '等待派发'),
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

function rankTitle(rank, count, last, hasJoin, hasUnresolved) {
  if (hasUnresolved) return '任务关系待核对';
  if (rank === 0) return count > 1 ? '任务入口 · 多个分支' : '任务入口';
  if (last && hasJoin) return '交付汇合';
  if (hasJoin) return '依赖汇合';
  if (count > 1) return '并行分支';
  return last ? '任务收尾' : '任务工作流';
}

/** Project task and evidence data to a vertical, editable workflow without changing any inputs. */
export function projectWorkflow({ tasks, graph, narrow = false, nodes, edges, order }) {
  const ids = [...new Set(tasks.map(task => task.id))];
  const known = new Set(ids);
  const dependencies = new Map(ids.map(id => [id, [...new Set(graph.dependencies.get(id) ?? [])].filter(parent => known.has(parent))]));
  const dependants = new Map(ids.map(id => [id, []]));
  for (const [id, parents] of dependencies) {
    for (const parent of parents) dependants.get(parent).push(id);
  }
  const { orders, ranks, unresolved } = orderedRanks(ids, dependencies, dependants, order);
  const bases = new Map(nodes.map(node => [node.id, node]));
  const key = (...parts) => JSON.stringify(parts);
  const trueEdges = new Map(edges.map(edge => [key(edge.source, edge.target), edge]));
  const idPool = new Set(known);
  function identity(step, ...parts) {
    // Keep generated IDs safe for selectors and distinct from any real task ID.
    const encoded = key(...parts).replace(/[^a-zA-Z0-9-]/gu, char => `_${char.codePointAt(0).toString(16)}_`);
    let id = `workflow-${step}-${encoded}`;
    while (idPool.has(id)) id += '-';
    idPool.add(id);
    return id;
  }
  const byTask = new Map(ids.map(id => [id, Object.fromEntries([
    ['agent', id],
    ...STEPS.slice(1).map(step => [step, identity(step, id)]),
    ...(dependants.get(id).length > 1 ? [['fork', identity('fork', id)]] : []),
    ...(dependencies.get(id).length > 1 ? [['join', identity('join', id)]] : []),
  ])]));

  const nodeWidth = narrow ? 212 : 220, nodeHeight = 72;
  const laneGap = narrow ? 34 : 54, branchGap = narrow ? 14 : 16;
  const stepWidth = (nodeWidth - branchGap) / 2;
  const padding = narrow ? 48 : 54, topPadding = 18;
  const laneStep = nodeWidth + laneGap, junctionWidth = 124, junctionHeight = 30;
  const maximumSiblings = Math.max(1, ...orders.map(row => row.length));
  const width = Math.max(narrow ? 318 : 520, padding * 2 + nodeWidth + (maximumSiblings - 1) * laneStep);
  const visualNodes = [], visualEdges = [], groups = [];
  const byVisualId = new Map();
  let top = topPadding;
  orders.forEach((row, rank) => {
    const hasJoin = row.some(id => byTask.get(id).join !== undefined);
    const hasFork = row.some(id => byTask.get(id).fork !== undefined);
    const movableSiblings = row.filter(id => !unresolved.has(id)).length > 1;
    const headingHeight = 38, joinSpace = hasJoin ? junctionHeight + 10 : 0;
    const agentY = top + headingHeight + joinSpace;
    const selfY = agentY + nodeHeight + 10;
    const checksY = selfY + 36 + 14;
    const reviewY = checksY + 40 + 14;
    const checkpointY = reviewY + 40 + 10;
    const forkY = checkpointY + 40 + 10;
    const bottom = hasFork ? forkY + junctionHeight + 12 : checkpointY + 40 + 12;
    groups.push({ rank, title: rankTitle(rank, row.length, rank === orders.length - 1, hasJoin, row.some(id => unresolved.has(id))), top,
      height: bottom - top, left: 12, width: width - 24, count: row.length });
    row.forEach((id, index) => {
      const base = bases.get(id) ?? { id, title: id, gateState: 'planned', gateLabel: '验收通过后放行' };
      const parts = byTask.get(id), evidence = roleStates(base);
      const parents = dependencies.get(id), children = dependants.get(id);
      const x = (width - nodeWidth) / 2 + (index - (row.length - 1) / 2) * laneStep;
      const middle = x + (nodeWidth - junctionWidth) / 2;
      const internalRelation = base.className?.includes('relation-upstream') ? 'upstream'
        : base.className?.includes('relation-downstream') ? 'downstream' : 'muted';
      const relationClasses = (base.className ?? '').split(/\s+/u).filter(value => value.startsWith('relation-')).join(' ');
      function add(step, left, y, w, h, title, label, meta, evidenceState) {
        const node = {
          id: parts[step], taskId: id, kind: ROLE_KIND[step], step, role: step === 'agent' ? 'coding' : step,
          title, label, meta, roleHelp: ROLE_HELP[step], position: { x: left, y }, width: w, height: h,
          rank, movable: step === 'agent' && movableSiblings && !unresolved.has(id), selected: step === 'agent' && Boolean(base.selected),
          className: step === 'agent' ? base.className ?? '' : relationClasses, ...evidenceState,
        };
        if (step === 'agent') node.topology = base.topology;
        visualNodes.push(node);
        byVisualId.set(node.id, node);
      }
      if (parts.join !== undefined) {
        add('join', middle, top + headingHeight, junctionWidth, junctionHeight, TITLES.join, `${parents.length} 项前置`, '', joinState(parents, bases));
      }
      add('agent', x, agentY, nodeWidth, nodeHeight, base.title, base.label ?? '', base.meta ?? '', evidence.agent);
      add('self', x, selfY, nodeWidth, 36, TITLES.self, evidence.self.gateLabel, '', evidence.self);
      add('http', x, checksY, stepWidth, 40, TITLES.http, evidence.http.gateLabel, '', evidence.http);
      add('browser', x + stepWidth + branchGap, checksY, stepWidth, 40, TITLES.browser, evidence.browser.gateLabel, '', evidence.browser);
      add('review', x, reviewY, nodeWidth, 40, TITLES.review, evidence.review.gateLabel, '', evidence.review);
      add('checkpoint', x, checkpointY, nodeWidth, 40, TITLES.checkpoint, base.gateLabel ?? '验收通过后放行', '',
        state(base.gateState ?? 'planned', base.gateLabel ?? '验收通过后放行'));
      if (parts.fork !== undefined) {
        add('fork', middle, forkY, junctionWidth, junctionHeight, TITLES.fork, `${children.length} 项后继`, '', forkState(base.gateState));
      }
      const connect = (from, to, caption = '') => visualEdges.push({
        id: identity('internal', id, from, to), source: parts[from], target: parts[to],
        caption, relation: internalRelation, channel: null, internal: true, sourceSide: 'bottom', targetSide: 'top',
      });
      if (parts.join !== undefined) connect('join', 'agent');
      connect('agent', 'self');
      connect('self', 'http');
      connect('self', 'browser');
      connect('http', 'review');
      connect('browser', 'review');
      connect('review', 'checkpoint');
      if (parts.fork !== undefined) connect('checkpoint', 'fork');
    });
    top = bottom + 16;
  });
  const branchOrdinals = new Map();
  for (const [target, parents] of dependencies) {
    parents.forEach((source, index) => {
      const visualSource = byTask.get(source).fork ?? byTask.get(source).checkpoint;
      const visualTarget = byTask.get(target).join ?? byTask.get(target).agent;
      const original = trueEdges.get(key(source, target));
      const from = byVisualId.get(visualSource), to = byVisualId.get(visualTarget);
      const adjacent = to.rank === from.rank + 1;
      const left = from.position.x + from.width / 2 + to.position.x + to.width / 2 <= width;
      const rail = 20 + (index % 3) * 6;
      const channel = adjacent ? null : left ? rail : width - rail;
      const branching = from.step === 'fork';
      const incoming = to.step === 'join';
      const ordinal = branching ? (branchOrdinals.get(source) ?? 0) + 1 : 0;
      if (branching) branchOrdinals.set(source, ordinal);
      const caption = branching ? `分支 ${ordinal}${incoming ? ' · 汇入' : ''}`
        : incoming ? '汇入' : from.gateState === 'passed' ? '已放行' : '验收通过后';
      visualEdges.push({
        id: identity('dependency', source, target), source: visualSource, target: visualTarget,
        fromTask: source, toTask: target, caption: original?.caption || caption,
        relation: original?.relation ?? 'muted', channel, internal: false, sourceSide: 'bottom', targetSide: 'top',
      });
    });
  }
  return { nodes: visualNodes, edges: visualEdges, groups, width, height: Math.max(348, top), nodeWidth, nodeHeight, ranks, orders };
}
