// The plan describes the route. Only the same-candidate projection supplies node results.
const stages = {
  code:   { title: '编码与自检', x: 14, y: 73, w: 120, icon: 'm5 5-4 4 4 4m8-8 4 4-4 4m-3-10-2 14' },
  freeze: { title: '固定候选', x: 171, y: 73, w: 115, icon: 'm9 1 7 4-7 4-7-4 7-4Zm-7 4v8l7 4 7-4V5M9 9v8' },
  http:   { title: 'HTTP 测试', x: 350, y: 12, w: 135, icon: 'M6 3H3v4L1 9l2 2v4h3m6-12h3v4l2 2-2 2v4h-3m-5-2 4-8' },
  edge:   { title: 'Edge 测试', x: 350, y: 73, w: 135, icon: 'M2 4h14v11H2zM2 7.5h14' },
  review: { title: '独立 Review', x: 350, y: 144, w: 135, icon: 'm9 2 6 2.5v4c0 3.4-2.4 5.7-6 7.5-3.6-1.8-6-4.1-6-7.5v-4L9 2Zm-3 7 2 2 4-4' },
  gate:   { title: '验收判定', x: 578, y: 73, w: 106, icon: 'm9 1 8 8-8 8-8-8 8-8Zm-3 8 2 2 4-4' },
  merge:  { title: '集成与放行', x: 737, y: 73, w: 113, icon: 'M4 4v11m10-11c0 5-10 2-10 9m-2 0 2 2 2-2m6-9 2-2 2 2' },
  repair: { title: '修订代码', x: 184, y: 168, w: 127, icon: 'm11 3 4 4M3 15l4-1 9-9-3-3-9 9-1 4Z' },
};
const width = 860, height = 218, cardHeight = 43;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const offset = value => Number.isFinite(value) ? value : 0;

function geometry(offsets) {
  return Object.fromEntries(Object.entries(stages).map(([key, stage]) => [key, {
    ...stage,
    x: clamp(stage.x + offset(offsets[key]?.x), 4, width - stage.w - 4),
    y: clamp(stage.y + offset(offsets[key]?.y), 4, height - cardHeight - 4),
  }]));
}

function rounded(points) {
  const corners = points.filter(([x, y], i) => !i || x !== points[i - 1][0] || y !== points[i - 1][1]);
  let d = 'M' + corners[0].join(' ');
  for (let i = 1; i < corners.length - 1; i++) {
    const [x, y] = corners[i], a = corners[i - 1], b = corners[i + 1];
    const radius = Math.min(7, Math.hypot(x - a[0], y - a[1]) / 2, Math.hypot(b[0] - x, b[1] - y) / 2);
    d += `L${x + Math.sign(a[0] - x) * radius} ${y + Math.sign(a[1] - y) * radius}Q${x} ${y} ${x + Math.sign(b[0] - x) * radius} ${y + Math.sign(b[1] - y) * radius}`;
  }
  return d + 'L' + corners.at(-1).join(' ');
}

function routeGeometry(nodes) {
  const port = (key, side) => {
    const { x, y, w } = nodes[key];
    if (side === 'bottom') return [x + w / 2, y + cardHeight];
    return [side === 'left' ? x - 3 : x + w, y + cardHeight / 2];
  };
  const connections = [];
  function wire(id, points, ink, caption) {
    connections.push({ id, d: rounded(points), ink, caption });
  }
  function join(from, to, ink, spine) {
    const s = port(from, 'right'), t = port(to, 'left');
    if (spine == null && t[0] < s[0] + 12) {
      const y = clamp(s[1] + (s[1] <= t[1] ? -32 : 32), 3, height - 3);
      wire(from + '-' + to, [s, [s[0] + 6, s[1]], [s[0] + 6, y], [t[0] - 6, y], [t[0] - 6, t[1]], t], ink);
    } else {
      const x = spine ?? (s[0] + t[0]) / 2;
      wire(from + '-' + to, [s, [x, s[1]], [x, t[1]], t], ink);
    }
  }
  const split = (port('freeze', 'right')[0] + Math.min(nodes.http.x, nodes.edge.x)) / 2;
  const gateInput = port('gate', 'left');
  const gather = (Math.max(port('http', 'right')[0], port('edge', 'right')[0]) + gateInput[0]) / 2;
  join('code', 'freeze', 'neutral');
  for (const key of ['http', 'edge']) {
    join('freeze', key, 'candidate', split);
    join(key, 'gate', 'neutral', gather);
  }
  // The review checks the same candidate, after both independent tests pass.
  const reviewTop = [nodes.review.x + nodes.review.w / 2, nodes.review.y - 3];
  const turnY = reviewTop[1] - 9;
  wire('tests-review', [[gather, gateInput[1]], [gather, turnY], [reviewTop[0], turnY], reviewTop],
    'candidate', label('两项通过后', gather, reviewTop[0], turnY));
  join('review', 'gate', 'neutral', (gather + gateInput[0]) / 2);
  join('gate', 'merge', 'candidate');
  const gate = port('gate', 'bottom'), fix = port('repair', 'right'), resume = port('repair', 'left'), code = port('code', 'bottom');
  function label(text, x1, x2, y) {
    return { text, x: (x1 + x2) / 2, y: y - 5, visible: Math.abs(x2 - x1) > 55 };
  }
  wire('gate-repair', [gate, [gate[0], fix[1]], [fix[0] + 3, fix[1]]],
    'revision', label('退回修订', gate[0], gate[0] + (fix[0] - gate[0]) * 0.4, fix[1]));
  wire('repair-code', [[resume[0] + 3, resume[1]], [code[0], resume[1]], [code[0], code[1] + 3]],
    'retry', label('新提交复验', resume[0], code[0], resume[1]));
  return connections;
}

function projectSteps(flow) {
  const checks = [flow.http, flow.browser, flow.review];
  const failed = checks.some(s => s.state === 'failed');
  const uncertain = checks.some(s => s.state === 'unknown');
  const passed = checks.every(s => s.state === 'passed');
  const gate = failed ? { state: 'failed', label: '需修订' } : uncertain ? { state: 'unknown', label: '待核对' }
    : passed ? { state: 'passed', label: '验收通过' } : { state: flow.planned ? 'planned' : 'waiting', label: '等待验收' };
  const freeze = flow.commit ? { state: 'passed', label: flow.commit.slice(0, 8) }
    : { state: flow.planned ? 'planned' : 'waiting', label: '待固定' };
  return { code: flow.coding, freeze, http: flow.http, edge: flow.browser, review: flow.review,
    gate, merge: flow.release, repair: { state: failed ? 'failed' : 'planned', label: failed ? '需要修订' : '按需进入' } };
}

const explanations = {
  code: '按任务要求编码并自检。', freeze: 'HTTP 测试、Edge 测试及独立 Review 核对同一候选提交。',
  http: '核对当前候选的独立接口测试。', edge: '核对当前候选的独立浏览器测试。',
  review: '查看本候选的独立审查意见与历史记录。', gate: '汇总同一候选的测试与独立审查结论。',
  merge: '通过验收并完成集成后，再核对后继模块的全部前置条件。', repair: '依据失败证据修订代码，新候选须重新自检、测试和审查。',
};

export function renderExpandedFlow({ task, flow, offsets = {}, escape }) {
  const nodes = geometry(offsets), states = projectSteps(flow);
  const id = escape(task.id), title = escape(task.title);
  const prefix = 'tf-step-' + Array.from(String(task.id), ch => ch.codePointAt(0).toString(16)).join('-');
  const markers = ['neutral', 'candidate', 'revision', 'retry'].map(ink =>
    `<marker id="${prefix}-${ink}" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path class="ef-arrow ef-${ink}" d="m1 1 5.5 3L1 7"/></marker>`).join('');
  const wires = routeGeometry(nodes).map(({ id: wireId, ink, d, caption }, index) => {
    const loop = wireId === 'repair-code' ? ` data-review-loop="${states.gate.state === 'failed' ? 'blocked' : 'conditional'}"` : '';
    const showPulse = !['gate-repair', 'repair-code'].includes(wireId) || states.gate.state === 'failed';
    const label = caption ? `<text class="ef-caption" x="${caption.x}" y="${caption.y}" visibility="${caption.visible ? 'visible' : 'hidden'}">${caption.text}</text>` : '';
    return `<g class="ef-wire ef-${ink}" data-wire="${wireId}"${loop} aria-hidden="true"><path class="ef-base" d="${d}" marker-end="url(#${prefix}-${ink})"/>${showPulse ? `<path class="ef-pulse" d="${d}" pathLength="100" style="--stagger:${-index * 317}ms"/>` : ''}${label}</g>`;
  }).join('');
  const cards = Object.entries(nodes).map(([key, node]) => {
    const { state, label } = states[key], text = escape(label);
    const reviewAttrs = key === 'review' ? `data-task-review="${id}" data-review-state="${escape(state)}" aria-controls="task-review-flow"` : '';
    const body = explanations[key] + (key === 'freeze' && flow.commit ? ' ' + flow.commit : '');
    const statusWidth = node.w - 15;
    return `<g class="ef-stage" transform="translate(${node.x} ${node.y})" data-expanded-op="${key}" data-status="${escape(state)}" ${reviewAttrs} data-focus-key="expanded-${id}-${key}" tabindex="0" role="button" aria-label="${node.title}，${text}">
      <title>${node.title} · ${text}。 ${escape(body)}</title><desc>${escape(body)}</desc><rect class="ef-face" width="${node.w}" height="${cardHeight}" rx="8"/>
      <rect class="ef-icon-bg" x="7" y="6" width="17" height="17" rx="5"/><path class="ef-icon" transform="translate(10 9) scale(.62)" d="${node.icon}"/>
      <text class="ef-title" x="29" y="19">${node.title}</text><svg x="9" y="24" width="${statusWidth}" height="16"><text class="ef-state" y="12">${text}</text></svg></g>`;
  }).join('');
  return `<section class="task-expanded-flow" aria-label="${title} 执行详情" data-expanded-module="${id}">
    <header><code>${id}</code><strong>${title} · 执行详情</strong><button type="button" data-collapse-module="${id}" data-focus-key="collapse-${id}">收起</button></header>
    <svg class="ef-canvas" viewBox="0 0 ${width} ${height}" role="group" aria-label="任务验收与返工流程">
      <defs>${markers}</defs>${wires}${cards}</svg>
    <div class="ef-description" hidden><button type="button" aria-label="关闭节点说明">×</button><strong></strong><p></p></div></section>`;
}

const bindings = new WeakMap();
export function bindExpandedFlow(element, onMove) {
  if (!element) return;
  bindings.get(element)?.abort();
  const controller = new AbortController();
  bindings.set(element, controller);
  const options = { signal: controller.signal };
  const svg = element.querySelector('.ef-canvas'), popover = element.querySelector('.ef-description');
  const items = new Map(Array.from(svg.querySelectorAll('[data-expanded-op]'), el => [el.dataset.expandedOp, el]));
  const wires = new Map(Array.from(svg.querySelectorAll('[data-wire]'), el => [
    el.dataset.wire, { paths: el.querySelectorAll('path'), label: el.querySelector('text') },
  ]));
  const offsets = {};
  for (const [key, el] of items) {
    const { e, f } = el.transform.baseVal.getItem(0).matrix;
    offsets[key] = { x: e - stages[key].x, y: f - stages[key].y };
  }
  element.style.setProperty('--ef-clock', -(performance.now() % 5200) + 'ms');
  let gesture, suppressClick = false, inspected;
  const local = event => new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  function move(key, delta) {
    const nodes = geometry({ ...offsets, [key]: delta }), n = nodes[key];
    const collision = Object.entries(nodes).some(([other, v]) => other !== key && n.x < v.x + v.w + 5
      && n.x + n.w + 5 > v.x && n.y < v.y + cardHeight + 5 && n.y + cardHeight + 5 > v.y);
    if (collision) return;
    offsets[key] = { x: n.x - stages[key].x, y: n.y - stages[key].y };
    items.get(key).setAttribute('transform', `translate(${n.x} ${n.y})`);
    for (const wire of routeGeometry(nodes)) {
      const { paths, label } = wires.get(wire.id);
      for (const path of paths) path.setAttribute('d', wire.d);
      if (label) {
        label.setAttribute('x', wire.caption.x);
        label.setAttribute('y', wire.caption.y);
        label.setAttribute('visibility', wire.caption.visible ? 'visible' : 'hidden');
      }
    }
  }
  svg.addEventListener('pointerdown', event => {
    const node = event.target.closest('[data-expanded-op]');
    if (gesture || !node || event.button !== 0) return;
    const key = node.dataset.expandedOp;
    gesture = { key, node, pointer: event.pointerId, origin: local(event), start: offsets[key],
      screenX: event.clientX, screenY: event.clientY, moved: false };
    suppressClick = false;
    node.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }, options);
  svg.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const g = gesture;
    if (!g.moved && Math.hypot(event.clientX - g.screenX, event.clientY - g.screenY) < 4) return;
    g.moved = true;
    const pos = local(event);
    move(g.key, { x: g.start.x + pos.x - g.origin.x, y: g.start.y + pos.y - g.origin.y });
    event.stopPropagation();
  }, options);
  function finish(event) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const g = gesture;
    gesture = null;
    suppressClick = g.moved;
    if (g.node.hasPointerCapture(event.pointerId)) g.node.releasePointerCapture(event.pointerId);
    if (g.moved) onMove?.(g.key, { ...offsets[g.key] });
  }
  svg.addEventListener('pointerup', finish, options);
  svg.addEventListener('pointercancel', finish, options);
  svg.addEventListener('lostpointercapture', finish, options);
  svg.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const node = event.target.closest('[data-expanded-op]');
    if (!node || node.hasAttribute('data-task-review')) return;
    inspected = node;
    popover.querySelector('strong').textContent = node.getAttribute('aria-label');
    popover.querySelector('p').textContent = node.querySelector('desc').textContent;
    popover.hidden = false;
    popover.querySelector('button').focus({ preventScroll: true });
    event.stopPropagation();
  }, options);
  function closeNote() {
    popover.hidden = true;
    inspected?.focus({ preventScroll: true });
  }
  popover.querySelector('button').addEventListener('click', closeNote, options);
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popover.hidden) {
      closeNote();
      event.stopPropagation();
      return;
    }
    const node = event.target.closest('[data-expanded-op]');
    if (node && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }, options);
  return () => controller.abort();
}
