import { projectWorkflow, reorderWorkflow } from './task-workflow-layout.js';
import { executionVersionEvidence } from './planned-execution.js';
import { projectTaskReview, renderTaskReview } from './task-review-flow.js';

const ORDER_KEY = 'taskflow.workflow.lanes.v1';
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

function fallbackCanvas(model, escape) {
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const paths = model.edges.map(edge => {
    const from = byId.get(edge.source), to = byId.get(edge.target);
    const x1 = from.position.x + from.width, x2 = to.position.x;
    const y1 = from.position.y + from.height - 13.5, y2 = to.position.y + (to.height - 33) / 2;
    const route = edge.channel == null ? `H${(x1 + x2) / 2} V${y2}` : `h8 V${edge.channel} H${x2 - 8} V${y2}`;
    return `<path d="M${x1} ${y1} ${route} H${x2}" fill="none" stroke="currentColor" marker-end="url(#taskflow-end)"/>`;
  });
  const cards = model.nodes.map(node => {
    const { x, y } = node.position;
    const agent = node.kind === 'agent';
    const id = escape(node.taskId);
    return `<button type="button" class="task-fallback-card ${agent ? 'dev-task' : ''} ${escape(node.className)}" style="left:${x}px;top:${y}px;width:${node.width}px;height:${node.height - 33}px" data-focus-key="task-${escape(node.id)}" data-flow-node="${escape(node.id)}" data-flow-part="${node.kind}" data-owner-task="${id}" data-task="${id}" aria-pressed="${node.selected}"><small>${escape(node.group)}</small><strong>${escape(node.title)}</strong></button>
      <button type="button" class="tr-fallback-gate" style="left:${x + 18}px;top:${y + node.height - 27}px;width:${node.width - 18}px" aria-label="${id} 独立 Review · ${escape(node.reviewLabel)}" data-task-review="${id}" data-review-state="${node.reviewState}" data-focus-key="review-${id}">独立 Review · ${escape(node.reviewLabel)}</button>`;
  });
  return `<div class="task-graph" style="width:${model.width}px;height:${model.height}px;transform:scale(${model.zoom})"><svg class="task-edges" width="${model.width}" height="${model.height}" aria-hidden="true"><defs><marker id="taskflow-end" viewBox="0 0 8 8" refX="7" refY="4" orient="auto" markerWidth="6" markerHeight="6"><path d="M0 0L8 4L0 8Z" fill="currentColor"/></marker></defs>${paths.join('')}</svg>${cards.join('')}</div>`;
}

function loadOrder() {
  try { return new Map(JSON.parse(sessionStorage.getItem(ORDER_KEY)) ?? []); }
  catch { return new Map(); }
}

export function createTaskOrchestration(host, { escape, onLayoutChange, onChangeDependency, onSaveGraph, onError }) {
  const narrow = matchMedia('(max-width: 850px)');
  narrow.addEventListener('change', onLayoutChange);
  let contextKey = '';
  let zoom = 1;
  let focusRelations = false;
  let manualZoom = false;
  let centerPending = false;
  let editingKey = '', editing = false;
  let orderKey;
  let model, focusedTaskKey;
  const savedOrder = loadOrder();
  let surface, canvas, observedViewport;
  let navigatorFrame, navigatorMap, navigatorNodes;
  const viewportObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (!observedViewport?.isConnected) return;
      fitWidth(observedViewport);
      scheduleNavigator();
    }) : null;

  function render({ key, tasks, selected, simulation, preview, statusNames, execution, editable, dependencyExecution, engineeringReady }) {
    if (key !== editingKey) { editingKey = key; editing = false; }
    const editingGraph = editable && editing;
    const graph = buildGraph(tasks);
    const layoutKey = `${key}/${narrow.matches ? 'narrow' : 'wide'}/${preview ? 'draft' : 'saved'}`;
    orderKey = `${key}/${preview ? 'draft' : 'saved'}`;
    const activeElement = document.activeElement;
    focusedTaskKey = layoutKey === contextKey && host.contains(activeElement) && activeElement.matches('[data-flow-node]')
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
    const activeTasks = new Map((execution?.tasks ?? []).map(task => [task.id, task]));
    const reviews = new Map(tasks.map(task => [task.id, projectTaskReview(execution, task)]));
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
      const label = simulationStatus ? statusNames[simulationStatus] : changed.has(task.id) ? '未保存改动' : affected.has(task.id) ? '下游待核对' : '';
      const style = simulationStatus ? `sim-${simulationStatus}` : draftStatus;
      const parents = graph.dependencies.get(task.id).length, children = graph.dependants.get(task.id).length;
      const topology = parents > 1 ? 'join' : parents === 0 ? 'root' : children === 0 ? 'finish' : 'task';
      const refs = task.requirementIds ?? [];
      const requirementLabel = refs.length ? refs.slice(0, 2).join(' / ') + (refs.length > 2 ? ` +${refs.length - 2}` : '') : '';
      const meta = requirementLabel || (parents > 1 ? `汇合 ${parents} 条依赖` : children > 1 ? `分出 ${children} 条路径` : parents ? '1 项前置任务' : '起始任务');
      const observed = activeTasks.get(task.id);
      const status = observed?.status;
      const blocked = graph.dependencies.get(task.id).filter(id => activeTasks.get(id)?.status !== 'completed');
      const gateState = !execution ? 'planned' : status === 'completed' ? 'passed'
        : ['failed', 'stopped', 'timed_out', 'integration_rework'].includes(status) ? 'failed'
          : !status || ['pending', 'blocked', 'reconciliation_required'].includes(status) ? 'waiting' : 'checking';
      const gateLabel = gateState === 'passed' ? '已验收并集成'
        : gateState === 'failed' ? '未通过 · 后续阻断'
          : status === 'reconciliation_required' ? '停止或证据待核对'
            : status === 'verified' || status === 'accepted' ? '已有候选 · 待集成'
              : gateState === 'checking' ? '任务执行或验收中'
                : gateState === 'waiting' ? blocked.length ? `等待 ${blocked.join('、')} 通过` : '等待派发' : '验收通过后放行';
      const reviewFlow = reviews.get(task.id);
      const releasedWithoutEvidence = gateState === 'passed' && reviewFlow.release.state !== 'passed';
      return { id: task.id, title: task.title, label, meta, topology, selected: active, observed, reviewFlow,
        gateState: releasedWithoutEvidence ? 'waiting' : gateState, gateLabel: releasedWithoutEvidence ? reviewFlow.release.label : gateLabel,
        className: [style, relation].filter(Boolean).join(' ') };
    });
    const layout = projectWorkflow({ tasks, graph, nodes, edges, narrow: narrow.matches, order: savedOrder.get(orderKey) });
    const inspected = layout.nodes.find(node => node.id === selected.id);
    for (const node of layout.nodes) {
      node.selected = node === inspected;
      if (node.selected) node.className += ' selected';
    }
    const { width, height } = layout;
    model = { ...layout, key: layoutKey, vertical: false, zoom,
      editing: editingGraph, onNodeMove: (id, position) => reorderByPosition(layoutKey, id, position.y),
      onConnect: (from, to) => { if (layoutKey === contextKey) changeLink(from, to); } };
    const enhanced = typeof window.taskflowTaskCanvas === 'function';
    const diagram = enhanced ? '<div class="task-flow-slot"></div>' : fallbackCanvas(model, escape);
    const reviewContext = JSON.stringify([key, selected.id, execution?.id, Boolean(preview)]);
    const previousReview = host.querySelector('#task-review-flow');
    const historyOpen = previousReview?.dataset.reviewContext === reviewContext && previousReview.querySelector('[data-review-history]')?.open;
    return {
      inspected, observed: activeTasks.get(selected.id), nextIds: graph.dependants.get(selected.id),
      reviewChecks: reviews.get(selected.id).checks,
      reviewHtml: renderTaskReview(reviews.get(selected.id), { downstream: graph.dependants.get(selected.id),
        versions: execution ? executionVersionEvidence(execution) : [], escape, simulation, preview, contextKey: reviewContext, historyOpen }),
      html: `<div class="task-graph-zone" data-focus-relations="${focusRelations}">
        <div class="task-orchestration-bar">
          <div class="task-orchestration-heading"><h3>模块工作流</h3><p>${layout.groups.length} 个板块 · ${tasks.length} 个模块 · ${edges.length} 条依赖${simulation ? ' · 模拟运行' : execution ? ' · 正在查看执行记录' : dependencyExecution ? engineeringReady ? ' · 按图运行' : ' · 按图计划，待工程契约' : ' · 编排设计'}</p></div>
          ${editable ? `<button type="button" class="task-canvas-relations" data-task-canvas="edit-links" data-focus-key="task-canvas-edit-links" aria-pressed="${editingGraph}">编辑连线</button>` : ''}
          <button type="button" class="task-canvas-relations" data-task-canvas="relations" data-focus-key="task-canvas-relations" aria-pressed="${focusRelations}">突出关联</button>
          <div class="task-orchestration-tools" role="group" aria-label="画布缩放">
            <button type="button" data-task-canvas="out" data-focus-key="task-canvas-out" aria-label="缩小">−</button>
            <span data-task-zoom-value>${zoomLabel(zoom)}</span>
            <button type="button" data-task-canvas="in" data-focus-key="task-canvas-in" aria-label="放大">+</button>
            <button type="button" data-task-canvas="fit" data-focus-key="task-canvas-fit">适应画布</button>
            ${enhanced ? '<button type="button" data-task-canvas="reset" data-focus-key="task-canvas-reset">恢复节点位置</button>' : ''}
          </div>
        </div>
        ${editingGraph ? graphEditor(tasks, selected, graph.dependencies.get(selected.id), preview, dependencyExecution) : ''}
        <div class="task-canvas-window">
          <div class="task-graph-scroll" data-plan-canvas role="region" aria-label="开发任务依赖画布" tabindex="0" data-focus-key="task-canvas" data-graph-context="${escape(layoutKey)}" data-graph-width="${width}" data-graph-height="${height}">
            <div class="task-graph-sizer" style="${sizerStyle(width, height, zoom)}">${diagram}</div>
          </div>
        </div>
        <div class="task-canvas-dock">
          <div>
            <div class="task-canvas-legend" aria-label="任务图图例">
              <span class="task-legend-selected">当前模块</span><span class="task-legend-upstream">前置路径</span><span class="task-legend-downstream">集成后核对后继</span><span class="task-legend-repair">Review 阻塞时退回编码</span>
            </div>
            ${enhanced ? '<span class="task-canvas-note">同列模块可上下换位，或按 Alt + ↑ / ↓。点选查看详情。</span>' : ''}
          </div>
          <button type="button" class="task-navigator" data-focus-key="task-canvas-navigator" aria-label="任务图小地图，方向键平移，回车居中" title="点击定位，方向键平移，回车居中">
            <svg class="task-navigator-map" viewBox="0 0 ${width} ${height}" aria-hidden="true">
              <g class="task-navigator-nodes"></g>
              <path class="task-navigator-shade" fill-rule="evenodd"></path>
              <rect class="task-navigator-viewport" vector-effect="non-scaling-stroke"></rect>
            </svg>
          </button>
        </div>
      </div>`,
    };
  }

  function graphEditor(tasks, selected, parents, preview, dependencyExecution) {
    const options = (items, current) => items.map(task => `<option value="${escape(task.id)}" ${task.id === current ? 'selected' : ''}>${escape(task.id)} · ${escape(task.title)}</option>`).join('');
    const canEnableExecution = tasks.length >= 2 && tasks.length <= 8;
    return `<section class="task-link-editor" aria-label="编辑任务流程">
      <p>从模块右侧的出口拖到后继模块左侧的入口，或在下方选择两个模块。保存后重新确认计划和验收清单。</p>
      <form data-task-link-form class="task-link-fields">
        <label>起点<select name="source" data-focus-key="task-link-source">${options(tasks, selected.id)}</select></label>
        <label>后继<select name="target" data-focus-key="task-link-target">${options(tasks, tasks.find(task => task.id !== selected.id)?.id)}</select></label>
        <button type="submit" class="button button-outline">添加连线</button>
      </form>
      ${parents.length ? `<div class="task-link-parents"><span>${escape(selected.id)} 的前置</span>${parents.map(id =>
        `<button type="button" class="button button-outline" data-link-from="${escape(id)}" data-link-to="${escape(selected.id)}" aria-label="移除 ${escape(id)} 到 ${escape(selected.id)} 的连线">${escape(id)} ×</button>`).join('')}</div>` : ''}
      <div class="task-link-actions">
        <button type="button" class="button ${dependencyExecution ? 'button-primary' : 'button-outline'}" data-task-canvas="save-design" data-focus-key="task-canvas-save-design" ${!preview?.graphEdited ? 'disabled' : ''}>保存连线</button>
        ${canEnableExecution && !dependencyExecution ? '<button type="button" class="button button-primary" data-task-canvas="save-links" data-focus-key="task-canvas-save-links">保存为按图运行</button>' : ''}
        ${!canEnableExecution ? '<span>逐任务开发支持 2 至 8 个模块。当前图可以继续保存连线。</span>' : ''}
      </div>
      ${preview?.error ? `<p class="inline-error" role="alert">${escape(preview.error)}</p>` : ''}
    </section>`;
  }

  function changeLink(source, target, remove = false) {
    try { onChangeDependency(source, target, remove); } catch (error) { onError(error); }
  }

  host.addEventListener('submit', event => {
    if (!event.target.matches('[data-task-link-form]')) return;
    event.preventDefault();
    const form = new FormData(event.target);
    changeLink(form.get('source'), form.get('target'));
  });

  function persistOrder() {
    while (savedOrder.size > 12) savedOrder.delete(savedOrder.keys().next().value);
    try { sessionStorage.setItem(ORDER_KEY, JSON.stringify([...savedOrder])); } catch { /* Session storage is optional. */ }
  }

  function moveToSlot(id, targetIndex) {
    if (!model.nodes.some(node => node.id === id && node.movable)) return;
    const rank = model.ranks.get(id), slots = model.orders[rank];
    const next = reorderWorkflow(model, id, slots?.[targetIndex]);
    if (!next) return;
    savedOrder.delete(orderKey);
    savedOrder.set(orderKey, next);
    persistOrder();
  }

  function reorderByPosition(key, id, y) {
    if (key !== contextKey || !Number.isFinite(y)) return;
    const slots = model.orders[model.ranks.get(id)];
    if (!slots?.includes(id)) return;
    const byId = new Map(model.nodes.map(node => [node.id, node.position.y]));
    let nearest = slots.indexOf(id);
    slots.forEach((other, index) => {
      if (Math.abs(byId.get(other) - y) < Math.abs(byId.get(slots[nearest]) - y)) nearest = index;
    });
    moveToSlot(id, nearest);
    // Re-render even when a drop must snap back into its original slot.
    onLayoutChange();
  }

  function viewportGeometry(viewport) {
    const bounds = viewport.getBoundingClientRect();
    const graph = viewport.firstElementChild.getBoundingClientRect();
    return { x: bounds.left + viewport.clientLeft - graph.left, y: bounds.top + viewport.clientTop - graph.top };
  }

  function drawNavigator() {
    const viewport = observedViewport;
    if (!viewport?.isConnected || !viewport.clientWidth) return;
    const map = viewport.closest('.task-graph-zone').querySelector('.task-navigator-map');
    const { width, height, nodes } = model;
    if (map !== navigatorMap || nodes !== navigatorNodes) {
      navigatorMap = map;
      navigatorNodes = nodes;
      map.querySelector('.task-navigator-nodes').innerHTML = nodes.map(node => {
        const { x, y } = node.position;
        const state = node.selected ? 'selected' : node.className.includes('relation-upstream') ? 'upstream'
          : node.className.includes('relation-downstream') ? 'downstream' : 'other';
        return `<rect ${node.kind === 'agent' ? 'data-map-task' : 'data-map-flow'}="${escape(node.id)}" data-kind="${node.kind}" data-relation="${state}" x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="5"></rect>`;
      }).join('');
    }
    const visible = viewportGeometry(viewport);
    // Lane headings live in the scaled graph. Keep them readable while panning right.
    viewport.style.setProperty('--task-lane-scroll-x', `${Math.max(0, visible.x / zoom)}px`);
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
      Array.from(surface.querySelectorAll('[data-flow-node]')).find(node => node.dataset.focusKey === focusedTaskKey)?.focus({ preventScroll: true });
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
        current.scrollLeft = 0;
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
    const removeLink = event.target.closest('[data-link-from]');
    if (removeLink) {
      changeLink(removeLink.dataset.linkFrom, removeLink.dataset.linkTo, true);
      return;
    }
    const navigator = event.target.closest('.task-navigator');
    if (navigator) {
      const viewport = observedViewport;
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
    if (action.dataset.taskCanvas === 'edit-links') {
      editing = !editing;
      onLayoutChange();
    } else if (action.dataset.taskCanvas === 'save-links' || action.dataset.taskCanvas === 'save-design') {
      void onSaveGraph(action.dataset.taskCanvas === 'save-links').catch(onError);
    } else if (action.dataset.taskCanvas === 'relations') {
      focusRelations = !focusRelations;
      viewport.closest('.task-graph-zone').dataset.focusRelations = String(focusRelations);
      action.setAttribute('aria-pressed', String(focusRelations));
    } else if (action.dataset.taskCanvas === 'reset') {
      savedOrder.delete(orderKey);
      persistOrder();
      onLayoutChange();
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
    if (!viewport || event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('button,[data-task-connector]')) return;
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
      const viewport = observedViewport;
      viewport.scrollBy(direction[0] * viewport.clientWidth / 3, direction[1] * viewport.clientHeight / 3);
      return;
    }
    const node = event.target.closest('.dev-task');
    if (node && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const id = node.dataset.task;
      const index = model.orders[model.ranks.get(id)].indexOf(id);
      moveToSlot(id, index + (event.key === 'ArrowUp' ? -1 : 1));
      onLayoutChange();
      return;
    }
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
