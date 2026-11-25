const NODE_WIDTH = 196;
const NODE_HEIGHT = 88;
const COLUMN_STEP = 246;
const ROW_STEP = 122;
const MOBILE_ROW_STEP = 226;
const PADDING = 28;
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

function placeTasks(tasks, { dependencies, dependants }, vertical) {
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
  const positions = new Map(columns.flatMap((column, level) => column.map((id, row) => {
    const lane = (rows - column.length) / 2 + row;
    const x = PADDING + (vertical ? lane * MOBILE_ROW_STEP : level * COLUMN_STEP);
    const y = PADDING + (vertical ? level : lane) * ROW_STEP;
    return [id, { x, y }];
  })));
  return {
    positions,
    width: PADDING * 2 + NODE_WIDTH + (vertical ? (rows - 1) * MOBILE_ROW_STEP : (columns.length - 1) * COLUMN_STEP),
    height: PADDING * 2 + NODE_HEIGHT + (vertical ? columns.length - 1 : rows - 1) * ROW_STEP,
  };
}

function fallbackCanvas({ nodes, edges, width, height, vertical, zoom }, escape) {
  const positions = new Map(nodes.map(node => [node.id, node.position]));
  const paths = edges.map(({ source, target, relation }) => {
    const from = positions.get(source), to = positions.get(target);
    const x1 = from.x + NODE_WIDTH * (vertical ? .5 : 1), x2 = to.x + (vertical ? NODE_WIDTH / 2 : 0);
    const y1 = from.y + NODE_HEIGHT * (vertical ? 1 : .5), y2 = to.y + (vertical ? 0 : NODE_HEIGHT / 2);
    const offset = Math.max(26, (vertical ? y2 - y1 : x2 - x1) * .42);
    const control1 = vertical ? [x1, y1 + offset] : [x1 + offset, y1];
    const control2 = vertical ? [x2, y2 - offset] : [x2 - offset, y2];
    return `<path class="task-edge relation-${relation}" d="M${x1} ${y1}C${control1.join(' ')},${control2.join(' ')},${x2} ${y2}" marker-end="url(#task-arrow-${relation})"/>`;
  });
  const buttons = nodes.map(({ id, title, position: { x, y }, selected, className, label }) =>
    `<button type="button" class="dev-task ${escape(className)}" style="left:${x}px;top:${y}px" data-task="${escape(id)}" data-focus-key="task-${escape(id)}" aria-pressed="${selected}"><span class="dev-task-top"><span>${escape(id)}</span><span>${escape(label)}</span></span><span class="dev-task-title">${escape(title)}</span></button>`);
  const markers = ['muted', 'upstream', 'downstream'].map(relation =>
    `<marker id="task-arrow-${relation}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z"/></marker>`);
  return `<div class="task-graph" style="width:${width}px;height:${height}px;transform:scale(${zoom})">
    <svg class="task-edges" width="${width}" height="${height}" aria-hidden="true"><defs>${markers.join('')}</defs>${paths.join('')}</svg>
    ${buttons.join('')}
  </div>`;
}

export function createTaskOrchestration(host, { escape, onLayoutChange }) {
  const narrow = matchMedia('(max-width: 600px)');
  narrow.addEventListener('change', onLayoutChange);
  let contextKey = '';
  let zoom = 1;
  let focusRelations = false;
  let model, focusedTaskKey;
  let surface, canvas;

  function render({ key, tasks, selected, simulation, preview, statusNames }) {
    const vertical = narrow.matches;
    const layoutKey = `${key}/${vertical}`;
    const activeElement = document.activeElement;
    focusedTaskKey = layoutKey === contextKey && host.contains(activeElement) && activeElement.matches('.dev-task')
      ? activeElement.dataset.focusKey : null;
    if (layoutKey !== contextKey) {
      contextKey = layoutKey;
      zoom = 1;
      focusRelations = false;
    }
    const graph = buildGraph(tasks);
    const { positions, width, height } = placeTasks(tasks, graph, vertical);
    const upstream = reached(graph.dependencies, selected.id);
    const downstream = reached(graph.dependants, selected.id);
    const changed = new Set(preview?.changedIds);
    const affected = new Set(preview?.downstreamIds);
    const simulated = new Map((simulation?.tasks ?? []).map(task => [task.id, task.status]));
    const edges = tasks.flatMap(task => graph.dependencies.get(task.id).map(id => ({
      source: id,
      target: task.id,
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
      return { id: task.id, title: task.title, position: positions.get(task.id), label, selected: active,
        className: [style, relation, active && 'selected'].filter(Boolean).join(' ') };
    });
    model = { nodes, edges, width, height, vertical, nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, zoom };
    const enhanced = typeof window.taskflowTaskCanvas === 'function';
    const diagram = enhanced ? '<div class="task-flow-slot"></div>' : fallbackCanvas(model, escape);
    return {
      nextIds: graph.dependants.get(selected.id),
      html: `<div class="task-graph-zone" data-focus-relations="${focusRelations}">
        <div class="task-orchestration-bar">
          <div class="task-orchestration-heading"><h3>开发任务依赖图</h3><p>${tasks.length} 项任务 · ${edges.length} 条依赖${simulation ? ' · 模拟运行，非真实验收' : ''}</p></div>
          <div class="task-orchestration-tools" role="group" aria-label="画布工具">
            <button type="button" data-task-canvas="out" data-focus-key="task-canvas-out" aria-label="缩小">−</button>
            <span data-task-zoom-value>${zoomLabel(zoom)}</span>
            <button type="button" data-task-canvas="in" data-focus-key="task-canvas-in" aria-label="放大">＋</button>
            <button type="button" data-task-canvas="fit" data-focus-key="task-canvas-fit">适应画布</button>
            <button type="button" data-task-canvas="relations" data-focus-key="task-canvas-relations" aria-pressed="${focusRelations}">突出关联</button>
          </div>
        </div>
        <div class="task-graph-scroll" role="region" aria-label="开发任务依赖画布" tabindex="0" data-focus-key="task-canvas" data-graph-context="${escape(layoutKey)}" data-graph-width="${width}" data-graph-height="${height}">
          <div class="task-graph-sizer" style="${sizerStyle(width, height, zoom)}">${diagram}</div>
        </div>
      </div>`,
    };
  }

  function sync() {
    const slot = host.querySelector('.task-flow-slot');
    if (!slot) {
      canvas?.destroy();
      surface = canvas = null;
      return;
    }
    if (!canvas) {
      surface = document.createElement('div');
      surface.className = 'task-flow-surface';
      canvas = window.taskflowTaskCanvas(surface);
    }
    if (surface.parentElement !== slot) slot.append(surface);
    canvas.render(model);
    if (focusedTaskKey) {
      Array.from(surface.querySelectorAll('.dev-task')).find(node => node.dataset.focusKey === focusedTaskKey)?.focus({ preventScroll: true });
      focusedTaskKey = null;
    }
  }

  function setZoom(viewport, requested, fit = false) {
    const oldZoom = zoom;
    zoom = Math.max(.001, Math.min(2, requested));
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / oldZoom;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / oldZoom;
    const sizer = viewport.querySelector('.task-graph-sizer');
    sizer.style.cssText = sizerStyle(model.width, model.height, zoom);
    model = { ...model, zoom };
    if (canvas) canvas.render(model);
    else sizer.firstElementChild.style.transform = `scale(${zoom})`;
    host.querySelector('[data-task-zoom-value]').textContent = zoomLabel(zoom);
    viewport.scrollLeft = fit ? 0 : centerX * zoom - viewport.clientWidth / 2;
    viewport.scrollTop = fit ? 0 : centerY * zoom - viewport.clientHeight / 2;
  }

  host.addEventListener('click', event => {
    const action = event.target.closest('[data-task-canvas]');
    if (!action) return;
    const viewport = host.querySelector('.task-graph-scroll');
    if (!viewport) return;
    if (action.dataset.taskCanvas === 'relations') {
      focusRelations = !focusRelations;
      viewport.parentElement.dataset.focusRelations = String(focusRelations);
      action.setAttribute('aria-pressed', String(focusRelations));
    } else if (action.dataset.taskCanvas === 'fit') {
      const fit = Math.min(viewport.clientWidth / Number(viewport.dataset.graphWidth), viewport.clientHeight / Number(viewport.dataset.graphHeight), 1);
      setZoom(viewport, fit, true);
    } else {
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

  host.addEventListener('keydown', event => {
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
