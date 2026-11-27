const NODE_HEIGHT = 100;
const ROW_STEP = 168;
const PADDING = 46;
const BAND_TOP = 16;
const POSITION_KEY = 'taskflow.canvas.positions';
const zoomLabel = zoom => `${Number((zoom * 100).toFixed(zoom < .01 ? 2 : zoom < .1 ? 1 : 0))}%`;
const sizerStyle = (width, height, zoom) => `width:${Math.ceil(width * zoom)}px;height:${Math.ceil(height * zoom)}px`;

function buildGraph(tasks) {
  const dependencies = new Map(tasks.map(task => [task.id, []]));
  const dependants = new Map(tasks.map(task => [task.id, []]));
  for (const task of tasks) {
    for (const id of new Set(task.dependsOn ?? [])) {
      if (!dependants.has(id)) continue;
      dependencies.get(task.id).push(id);
      dependants.get(id).push(task.id);
    }
  }
  return { dependencies, dependants };
}

function reached(graph, root) {
  const queue = [root];
  const ids = new Set(queue);
  for (let index = 0; index < queue.length; index++) {
    for (const id of graph.get(queue[index]) ?? []) {
      if (ids.has(id)) continue;
      ids.add(id);
      queue.push(id);
    }
  }
  return ids;
}

function placeTasks(tasks, { dependencies, dependants }, narrow) {
  const nodeWidth = narrow ? 216 : 228;
  const laneStep = nodeWidth + (narrow ? 48 : 66);
  const pending = new Map(tasks.map(task => [task.id, dependencies.get(task.id).length]));
  const levels = new Map();
  const queue = [...pending].filter(([, count]) => !count).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const next of dependants.get(id)) {
      levels.set(next, Math.max(levels.get(next) ?? 0, (levels.get(id) ?? 0) + 1));
      pending.set(next, pending.get(next) - 1);
      if (pending.get(next) === 0) queue.push(next);
    }
  }
  const columns = [];
  for (const task of tasks) {
    // Imported or draft graphs can contain cycles. Keep those nodes visible for inspection.
    const level = pending.get(task.id) ? 0 : levels.get(task.id) ?? 0;
    (columns[level] ??= []).push(task.id);
  }
  const rows = Math.max(...columns.map(column => column.length));
  const width = Math.max(narrow ? 318 : 524, PADDING * 2 + nodeWidth + (rows - 1) * laneStep);
  const height = Math.max(348, BAND_TOP * 2 + columns.length * ROW_STEP);
  const lanes = new Map();
  for (const column of columns) {
    // Keep branches near their immediate parents and use the input order to break ties.
    const rank = new Map(column.map(id => {
      const parents = dependencies.get(id).map(parent => lanes.get(parent)).filter(Number.isFinite);
      return [id, parents.length ? parents.reduce((sum, lane) => sum + lane, 0) / parents.length : 0];
    }));
    column.sort((a, b) => rank.get(a) - rank.get(b));
    column.forEach((id, index) => lanes.set(id, index - (column.length - 1) / 2));
  }
  const ranks = new Map();
  const positions = new Map(columns.flatMap((column, level) => column.map((id, row) => {
    const x = (width - nodeWidth) / 2 + (row - (column.length - 1) / 2) * laneStep;
    const y = BAND_TOP + 34 + level * ROW_STEP;
    ranks.set(id, level);
    return [id, { x, y }];
  })));
  return {
    positions, ranks, width, height, nodeWidth,
    bands: columns.map((column, index) => ({ count: column.length, top: BAND_TOP + index * ROW_STEP, height: ROW_STEP - 10 })),
  };
}

function fallbackCanvas({ nodes, edges, bands, width, height, nodeWidth, zoom }, escape) {
  const positions = new Map(nodes.map(node => [node.id, node.position]));
  const paths = edges.map(({ source, target, relation }) => {
    const from = positions.get(source), to = positions.get(target);
    const x1 = from.x + nodeWidth / 2, x2 = to.x + nodeWidth / 2;
    const y1 = from.y + NODE_HEIGHT, y2 = to.y;
    const middle = (y1 + y2) / 2;
    return `<path class="task-edge relation-${relation}" d="M${x1} ${y1}V${middle}H${x2}V${y2}" marker-end="url(#task-arrow-${relation})"/>`;
  });
  const buttons = nodes.map(({ id, title, position: { x, y }, selected, className, label, meta, topology }) =>
    `<button type="button" class="dev-task ${escape(className)}" style="left:${x}px;top:${y}px;width:${nodeWidth}px;height:${NODE_HEIGHT}px" data-task="${escape(id)}" data-topology="${topology}" data-focus-key="task-${escape(id)}" aria-pressed="${selected}" title="${escape(title)}"><span class="dev-task-top"><span>${escape(id)}</span><span>${escape(label)}</span></span><span class="dev-task-title">${escape(title)}</span><span class="dev-task-meta">${escape(meta)}</span></button>`);
  const markers = ['muted', 'upstream', 'downstream'].map(relation =>
    `<marker id="task-arrow-${relation}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z"/></marker>`);
  return `<div class="task-graph" style="width:${width}px;height:${height}px;transform:scale(${zoom})">
    ${bands.map(({ count, top, height }, index) => `<div class="task-level-band" style="top:${top}px;height:${height}px"><span class="task-level-caption">依赖层 ${index + 1} · ${count} 项任务</span></div>`).join('')}
    <svg class="task-edges" width="${width}" height="${height}" aria-hidden="true"><defs>${markers.join('')}</defs>${paths.join('')}</svg>
    ${buttons.join('')}
  </div>`;
}

function loadPositions() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(POSITION_KEY));
    return new Map(Array.isArray(saved) ? saved : []);
  } catch { return new Map(); }
}

export function createTaskOrchestration(host, { escape, onLayoutChange }) {
  const narrow = matchMedia('(max-width: 850px)');
  narrow.addEventListener('change', onLayoutChange);
  let contextKey = '';
  let zoom = 1;
  let focusRelations = false;
  let manualZoom = false;
  let centerPending = false;
  let model, focusedTaskKey, defaultPositions;
  const savedPositions = loadPositions();
  let surface, canvas, observedViewport;
  let navigatorFrame, navigatorMap, navigatorNodes;
  const viewportObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (!observedViewport?.isConnected) return;
      fitWidth(observedViewport);
      scheduleNavigator();
    }) : null;

  function render({ key, tasks, selected, simulation, preview, statusNames }) {
    const graph = buildGraph(tasks);
    const { positions, ranks, width, height, nodeWidth, bands } = placeTasks(tasks, graph, narrow.matches);
    const layoutKey = `${key}/${narrow.matches ? 'narrow' : 'wide'}/${preview ? 'draft' : 'saved'}`;
    defaultPositions = positions;
    const activeElement = document.activeElement;
    focusedTaskKey = layoutKey === contextKey && host.contains(activeElement) && activeElement.matches('.dev-task')
      ? activeElement.dataset.focusKey : null;
    if (layoutKey !== contextKey) {
      contextKey = layoutKey;
      zoom = 1;
      manualZoom = false;
      focusRelations = false;
      centerPending = true;
    }
    const upstream = reached(graph.dependencies, selected.id);
    const downstream = reached(graph.dependants, selected.id);
    const changed = new Set(preview?.changedIds);
    const affected = new Set(preview?.downstreamIds);
    const simulated = new Map((simulation?.tasks ?? []).map(task => [task.id, task.status]));
    const overrides = savedPositions.get(layoutKey) ?? {};
    const edges = tasks.flatMap(task => graph.dependencies.get(task.id).map((id, index) => ({
      source: id,
      target: task.id,
      channel: ranks.get(task.id) - ranks.get(id) === 1 ? null
        : (positions.get(id).x + positions.get(task.id).x + nodeWidth < width ? 20 + index % 3 * 6 : width - 20 - index % 3 * 6),
      relation: upstream.has(id) && upstream.has(task.id) ? 'upstream'
        : downstream.has(id) && downstream.has(task.id) ? 'downstream' : 'muted',
    })));
    const nodes = tasks.map(task => {
      const active = task.id === selected.id;
      const relation = active ? '' : upstream.has(task.id) ? 'relation-upstream' : downstream.has(task.id) ? 'relation-downstream' : 'relation-muted';
      const simulationStatus = simulated.get(task.id);
      const draftStatus = changed.has(task.id) ? 'draft-changed' : affected.has(task.id) ? 'draft-downstream' : '';
      const label = simulationStatus ? statusNames[simulationStatus] : changed.has(task.id) ? '未保存改动' : affected.has(task.id) ? '下游待核对' : task.category || '开发';
      const style = simulationStatus ? `sim-${simulationStatus}` : draftStatus;
      const parents = graph.dependencies.get(task.id).length, children = graph.dependants.get(task.id).length;
      const topology = parents > 1 ? 'join' : parents === 0 ? 'root' : children === 0 ? 'finish' : 'task';
      const refs = task.requirementIds ?? [];
      const requirementLabel = refs.length ? refs.slice(0, 2).join(' / ') + (refs.length > 2 ? ` +${refs.length - 2}` : '') : '';
      const meta = requirementLabel || (parents > 1 ? `汇合 ${parents} 条依赖` : children > 1 ? `分出 ${children} 条路径` : parents ? '1 项前置任务' : '起始任务');
      const override = Object.hasOwn(overrides, task.id) ? overrides[task.id] : null;
      const position = Number.isFinite(override?.x) && Number.isFinite(override?.y)
        ? { x: Math.max(12, Math.min(width - nodeWidth - 12, override.x)), y: Math.max(12, Math.min(height - NODE_HEIGHT - 12, override.y)) }
        : positions.get(task.id);
      return { id: task.id, title: task.title, position, label, meta, topology, selected: active,
        className: [style, relation, active && 'selected'].filter(Boolean).join(' ') };
    });
    model = { key: layoutKey, nodes, edges, bands, width, height, vertical: true, nodeWidth, nodeHeight: NODE_HEIGHT, zoom,
      onNodeMove: (id, position) => savePosition(layoutKey, id, position) };
    const enhanced = typeof window.taskflowTaskCanvas === 'function';
    const diagram = enhanced ? '<div class="task-flow-slot"></div>' : fallbackCanvas(model, escape);
    return {
      nextIds: graph.dependants.get(selected.id),
      html: `<div class="task-graph-zone" data-focus-relations="${focusRelations}">
        <div class="task-orchestration-bar">
          <div class="task-orchestration-heading"><h3>开发任务依赖图</h3><p>${tasks.length} 项任务 · ${edges.length} 条依赖 · ${bands.length} 层${simulation ? ' · 模拟运行，非真实验收' : ''}</p></div>
          <button type="button" class="task-canvas-relations" data-task-canvas="relations" data-focus-key="task-canvas-relations" aria-pressed="${focusRelations}">突出关联</button>
          <div class="task-orchestration-tools" role="group" aria-label="画布缩放">
            <button type="button" data-task-canvas="out" data-focus-key="task-canvas-out" aria-label="缩小">−</button>
            <span data-task-zoom-value>${zoomLabel(zoom)}</span>
            <button type="button" data-task-canvas="in" data-focus-key="task-canvas-in" aria-label="放大">+</button>
            <button type="button" data-task-canvas="fit" data-focus-key="task-canvas-fit">适应画布</button>
            ${enhanced ? '<button type="button" data-task-canvas="reset" data-focus-key="task-canvas-reset">恢复节点位置</button>' : ''}
          </div>
        </div>
        <div class="task-canvas-window">
          <div class="task-graph-scroll" data-plan-canvas role="region" aria-label="开发任务依赖画布" tabindex="0" data-focus-key="task-canvas" data-graph-context="${escape(layoutKey)}" data-graph-width="${width}" data-graph-height="${height}">
            <div class="task-graph-sizer" style="${sizerStyle(width, height, zoom)}">${diagram}</div>
          </div>
          <button type="button" class="task-navigator" data-focus-key="task-canvas-navigator" aria-label="任务图小地图，方向键平移，回车居中" title="点击定位，方向键平移，回车居中">
            <svg class="task-navigator-map" viewBox="0 0 ${width} ${height}" aria-hidden="true">
              <g class="task-navigator-nodes"></g>
              <path class="task-navigator-shade" fill-rule="evenodd"></path>
              <rect class="task-navigator-viewport" vector-effect="non-scaling-stroke"></rect>
            </svg>
          </button>
        </div>
        <div class="task-canvas-dock">
          <div class="task-canvas-legend" aria-label="任务图图例">
            <span class="task-legend-selected">当前任务</span><span class="task-legend-upstream">前置路径</span><span class="task-legend-downstream">后续路径</span>
          </div>
          ${enhanced ? '<span class="task-canvas-note">拖动节点调整位置，拖动空白平移。</span>' : ''}
        </div>
      </div>`,
    };
  }

  function persistPositions() {
    while (savedPositions.size > 12) savedPositions.delete(savedPositions.keys().next().value);
    try { sessionStorage.setItem(POSITION_KEY, JSON.stringify([...savedPositions])); } catch { /* In-memory positions remain usable. */ }
  }

  function savePosition(key, id, position) {
    if (key !== contextKey) return;
    const current = savedPositions.get(key) ?? {};
    savedPositions.delete(key);
    savedPositions.set(key, { ...current, [id]: position });
    persistPositions();
    model = { ...model, nodes: model.nodes.map(node => node.id === id ? { ...node, position } : node) };
    scheduleNavigator();
  }

  function viewportGeometry(viewport) {
    const bounds = viewport.getBoundingClientRect();
    const graph = viewport.firstElementChild.getBoundingClientRect();
    return { x: bounds.left + viewport.clientLeft - graph.left, y: bounds.top + viewport.clientTop - graph.top };
  }

  function drawNavigator() {
    const viewport = observedViewport;
    if (!viewport?.isConnected || !viewport.clientWidth) return;
    const map = viewport.parentElement.querySelector('.task-navigator-map');
    const { width, height, nodes, nodeWidth, nodeHeight } = model;
    if (map !== navigatorMap || nodes !== navigatorNodes) {
      navigatorMap = map;
      navigatorNodes = nodes;
      map.querySelector('.task-navigator-nodes').innerHTML = nodes.map(node => {
        const { x, y } = node.position;
        const state = node.selected ? 'selected' : node.className.includes('relation-upstream') ? 'upstream'
          : node.className.includes('relation-downstream') ? 'downstream' : 'other';
        return `<rect data-map-task="${escape(node.id)}" data-relation="${state}" x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="14"></rect>`;
      }).join('');
    }
    const visible = viewportGeometry(viewport);
    const clamp = (value, max) => Math.min(max, Math.max(0, value));
    const left = clamp(visible.x / zoom, width);
    const top = clamp(visible.y / zoom, height);
    const right = clamp((visible.x + viewport.clientWidth) / zoom, width);
    const bottom = clamp((visible.y + viewport.clientHeight) / zoom, height);
    map.querySelector('.task-navigator-shade').setAttribute('d', `M0 0H${width}V${height}H0Z M${left} ${top}H${right}V${bottom}H${left}Z`);
    const outline = map.querySelector('.task-navigator-viewport');
    outline.setAttribute('x', left);
    outline.setAttribute('y', top);
    outline.setAttribute('width', right - left);
    outline.setAttribute('height', bottom - top);
  }

  function scheduleNavigator() {
    if (navigatorFrame !== undefined) return;
    navigatorFrame = requestAnimationFrame(() => {
      navigatorFrame = undefined;
      drawNavigator();
    });
  }

  function sync() {
    const viewport = host.querySelector('.task-graph-scroll');
    if (viewport !== observedViewport) {
      if (observedViewport) viewportObserver?.unobserve(observedViewport);
      observedViewport = viewport;
      if (viewport) viewportObserver?.observe(viewport);
    }
    if (viewport) scheduleNavigator();
    const slot = host.querySelector('.task-flow-slot');
    if (!slot) {
      canvas?.destroy();
      surface = canvas = null;
      if (viewport) fitWidth(viewport);
      return;
    }
    if (!canvas) {
      surface = document.createElement('div');
      surface.className = 'task-flow-surface';
      surface.dataset.planCanvas = '';
      canvas = window.taskflowTaskCanvas(surface);
    }
    if (surface.parentElement !== slot) slot.append(surface);
    canvas.render(model);
    fitWidth(viewport);
    if (focusedTaskKey) {
      Array.from(surface.querySelectorAll('.dev-task')).find(node => node.dataset.focusKey === focusedTaskKey)?.focus({ preventScroll: true });
      focusedTaskKey = null;
    }
  }

  function fitWidth(viewport) {
    if (viewport.clientWidth < 3) return;
    if (!manualZoom && !narrow.matches) {
      const fit = Math.max(.8, Math.min(1, (viewport.clientWidth - 2) / model.width));
      if (Math.abs(fit - zoom) > .0005) setZoom(viewport, fit, true);
    }
    if (centerPending) {
      centerPending = false;
      const key = contextKey;
      // The workspace restores its previous scroll position after sync has returned.
      requestAnimationFrame(() => {
        const current = observedViewport;
        if (key !== contextKey || !current?.clientWidth) return;
        current.scrollLeft = (current.scrollWidth - current.clientWidth) / 2;
        scheduleNavigator();
      });
    }
  }

  function setZoom(viewport, requested, fit = false) {
    const oldZoom = zoom;
    zoom = Math.max(.001, Math.min(2, requested));
    const sizer = viewport.querySelector('.task-graph-sizer');
    const centerX = (viewport.scrollLeft + Math.min(viewport.clientWidth, sizer.offsetWidth) / 2) / oldZoom;
    const centerY = (viewport.scrollTop + Math.min(viewport.clientHeight, sizer.offsetHeight) / 2) / oldZoom;
    sizer.style.cssText = sizerStyle(model.width, model.height, zoom);
    model = { ...model, zoom };
    if (canvas) canvas.render(model);
    else sizer.firstElementChild.style.transform = `scale(${zoom})`;
    host.querySelector('[data-task-zoom-value]').textContent = zoomLabel(zoom);
    viewport.scrollLeft = fit ? (viewport.scrollWidth - viewport.clientWidth) / 2 : centerX * zoom - Math.min(viewport.clientWidth, sizer.offsetWidth) / 2;
    viewport.scrollTop = fit ? 0 : centerY * zoom - Math.min(viewport.clientHeight, sizer.offsetHeight) / 2;
    scheduleNavigator();
  }

  host.addEventListener('click', event => {
    const navigator = event.target.closest('.task-navigator');
    if (navigator) {
      const viewport = navigator.previousElementSibling;
      const { width, height } = model;
      const bounds = navigator.firstElementChild.getBoundingClientRect();
      const scale = Math.min(bounds.width / width, bounds.height / height);
      if (!scale) return;
      const x = event.detail ? (event.clientX - bounds.left - (bounds.width - width * scale) / 2) / scale : width / 2;
      const y = event.detail ? (event.clientY - bounds.top - (bounds.height - height * scale) / 2) / scale : height / 2;
      const visible = viewportGeometry(viewport);
      viewport.scrollBy(x * zoom - visible.x - viewport.clientWidth / 2, y * zoom - visible.y - viewport.clientHeight / 2);
      scheduleNavigator();
      return;
    }
    const action = event.target.closest('[data-task-canvas]');
    if (!action) return;
    const viewport = host.querySelector('.task-graph-scroll');
    if (!viewport) return;
    if (action.dataset.taskCanvas === 'relations') {
      focusRelations = !focusRelations;
      viewport.closest('.task-graph-zone').dataset.focusRelations = String(focusRelations);
      action.setAttribute('aria-pressed', String(focusRelations));
    } else if (action.dataset.taskCanvas === 'reset') {
      savedPositions.delete(contextKey);
      persistPositions();
      model = { ...model, nodes: model.nodes.map(node => ({ ...node, position: defaultPositions.get(node.id) })) };
      canvas?.render(model);
      scheduleNavigator();
    } else if (action.dataset.taskCanvas === 'fit') {
      manualZoom = true;
      const fit = Math.min(viewport.clientWidth / Number(viewport.dataset.graphWidth), viewport.clientHeight / Number(viewport.dataset.graphHeight), 1);
      setZoom(viewport, fit, true);
    } else {
      manualZoom = true;
      setZoom(viewport, zoom * (action.dataset.taskCanvas === 'in' ? 1.25 : .8));
    }
  });

  host.addEventListener('pointerdown', event => {
    const viewport = event.target.closest('.task-graph-scroll');
    if (!viewport || event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('button')) return;
    const bounds = viewport.getBoundingClientRect();
    if (event.clientX >= bounds.left + viewport.clientWidth || event.clientY >= bounds.top + viewport.clientHeight) return;
    const { clientX, clientY, pointerId } = event;
    const { scrollLeft, scrollTop } = viewport;
    const drag = new AbortController();
    viewport.setPointerCapture(pointerId);
    viewport.classList.add('is-panning');
    viewport.addEventListener('pointermove', move => {
      viewport.scrollLeft = scrollLeft + clientX - move.clientX;
      viewport.scrollTop = scrollTop + clientY - move.clientY;
    }, { signal: drag.signal });
    viewport.addEventListener('lostpointercapture', () => {
      viewport.classList.remove('is-panning');
      drag.abort();
    }, { once: true, signal: drag.signal });
  });

  host.addEventListener('scroll', event => {
    if (event.target === observedViewport) scheduleNavigator();
  }, true);

  host.addEventListener('keydown', event => {
    const navigator = event.target.closest('.task-navigator');
    if (navigator && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      const viewport = navigator.previousElementSibling;
      viewport.scrollBy(direction[0] * viewport.clientWidth / 3, direction[1] * viewport.clientHeight / 3);
      return;
    }
    const node = event.target.closest('.dev-task');
    if (!node || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const nodes = Array.from(node.closest('.task-graph-scroll').querySelectorAll('.dev-task'));
    let index = nodes.indexOf(node);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = nodes.length - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = Math.min(index + 1, nodes.length - 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = Math.max(index - 1, 0);
    else return;
    event.preventDefault();
    nodes[index].click();
    revealSelected();
  });

  function revealSelected() {
    const viewport = host.querySelector('.task-graph-scroll');
    const node = viewport?.querySelector('.dev-task.selected');
    if (!node) return;
    const view = viewport.getBoundingClientRect(), selected = node.getBoundingClientRect();
    if (selected.left < view.left || selected.right > view.left + viewport.clientWidth) {
      viewport.scrollLeft += selected.left - view.left - (viewport.clientWidth - selected.width) / 2;
    }
    if (selected.top < view.top || selected.bottom > view.top + viewport.clientHeight) {
      viewport.scrollTop += selected.top - view.top - (viewport.clientHeight - selected.height) / 2;
    }
    node.focus({ preventScroll: true });
  }

  return { render, revealSelected, sync };
}
