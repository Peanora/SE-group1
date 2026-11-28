import { memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ChevronDown, Code2, GitBranch, GitMerge, Grip, Shield } from 'lucide-react';
import {
  BaseEdge, getBezierPath, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnNodesChange, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/base.css';
import './task-canvas.css';

type Relation = 'muted' | 'upstream' | 'downstream';
type GateState = 'planned' | 'waiting' | 'checking' | 'passed' | 'failed';
type Side = 'bottom' | 'top' | 'left' | 'right';
type EdgeMotion = 'ambient' | 'selected' | 'active';

type NodeIdentity = {
  id: string;
  title: string;
  position: XYPosition;
  selected: boolean;
};

type PlanNode = NodeIdentity & {
  taskId: string;
  kind: 'agent';
  group: string;
  phaseId: string;
  roleLabel: string;
  roleHelp?: string;
  reviewState: GateState;
  reviewLabel: string;
  checkpoint?: { gateState: GateState; gateLabel: string; delivery: boolean; blocked: boolean };
  fork?: { count: number; gateState: GateState; gateLabel: string };
  join?: { count: number; gateState: GateState; gateLabel: string };
  label: string;
  className: string;
  meta: string;
  width?: number;
  height?: number;
  rank: number;
  movable: boolean;
  expanded?: boolean;
  movementBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  gateState?: GateState;
  gateLabel?: string;
};

type PlanTask = PlanNode & {
  editing: boolean;
  inputs: Side[];
  outputs: Side[];
  parents: string[];
};

type ExecutionNode = NodeIdentity & {
  status: string;
  statusLabel: string;
  dependencies: string;
  focused: boolean;
};

type PlanDependency = {
  relation: Relation;
  channel?: number | null;
  viaX?: number;
  targetChannel?: number;
  fromTask?: string;
  toTask?: string;
  caption?: string;
  internal: boolean;
  sourceSide?: Side;
  targetSide?: Side;
};
type DependencyData = (PlanDependency & { gateState: GateState; motion?: EdgeMotion }) | { focused: boolean; vertical: boolean };
type CanvasEdge = { id?: string; source: string; target: string } & (PlanDependency | { focused: boolean });
type PlanGroup = {
  id: string;
  title: string;
  rank: number;
  count: number;
  top: number;
  left: number;
  width: number;
  height: number;
  headerSide?: 'left';
  expanded?: boolean;
};
type PlanColumn = { rank: number; title: string; left: number; width: number };
type DetailBounds = XYPosition & { width: number; height: number };

type CanvasModel = {
  nodes: (PlanNode | ExecutionNode)[];
  edges: CanvasEdge[];
  vertical: boolean;
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  zoom: number;
  groups?: PlanGroup[];
  detailBounds?: DetailBounds | null;
  columns?: PlanColumn[];
  variant?: 'execution';
  key?: string;
  onNodeMove?: (id: string, position: XYPosition) => void;
  editing?: boolean;
  onConnect?: (source: string, target: string) => void;
};

type TaskNode = Node<PlanTask | ExecutionNode, 'task'>;
type DependencyEdge = Edge<DependencyData, 'dependency'>;
type Move = { model: CanvasModel; taskId: string; position: XYPosition; dragging: boolean };

const sidePositions: Record<Side, Position> = {
  top: Position.Top, bottom: Position.Bottom, left: Position.Left, right: Position.Right,
};
const planMarkerColors: Record<Relation, string> = {
  muted: '#7896bd',
  upstream: '#477bb6',
  downstream: '#336cba',
};
const gateHelp = '同一代码版本的自检、独立 HTTP、Edge 和 Review 均通过且完成代码集成后，才释放后续任务。';
const portSize = 6;
const editPortSize = 16;
const planSizing = {
  '--task-port-size': `${portSize}px`,
  '--task-edit-port-size': `${editPortSize}px`,
} as CSSProperties;

function planPort(side: Side, type: 'source' | 'target', width: number, height: number, editing: boolean) {
  const x = { left: 0, right: width, top: width / 2, bottom: width / 2 }[side];
  const y = { left: height / 2, right: height / 2, top: 0, bottom: height }[side];
  const editable = editing && side === (type === 'source' ? 'right' : 'left');
  const size = editable ? editPortSize : portSize;
  return {
    id: `${type === 'source' ? 'output' : 'input'}-${side}`,
    type, position: sidePositions[side], x: x - size / 2, y: y - size / 2, width: size, height: size,
  };
}

const stopCanvasPan = (event: PointerEvent) => event.stopPropagation();

const TaskCard = memo(function TaskCard({ data, sourcePosition, targetPosition }: NodeProps<TaskNode>) {
  if ('kind' in data) return <PlanCard data={data} />;
  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />
      <ExecutionCard data={data} />
      <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />
    </>
  );
});

function PlanCard({ data }: { data: PlanTask }) {
  const { taskId, selected, editing, movable, gateState = 'planned', checkpoint, join, fork } = data;
  const explanation = `直接前置：${data.parents.join('、') || '无'}。${checkpoint ? gateHelp : ''}`;
  const checkpointLabel = checkpoint?.gateState === 'failed' ? '检查点阻断' : checkpoint?.blocked ? '前置阻断'
    : checkpoint?.delivery ? '交付检查点' : '验收检查点';
  const status = data.label || { planned: '待开发', waiting: '等待中', checking: '执行中', passed: '已集成', failed: '未通过' }[gateState];
  return (
    <div className="plan-task-node" data-movable={movable} data-editing={editing} style={planSizing}>
      <button type="button" className={`task-flow-card dev-task ${data.className}`}
        data-flow-node={data.id} data-flow-part="agent" data-flow-role="coding" data-owner-task={taskId}
        data-flow-rank={data.rank} data-task={taskId} data-focus-key={`task-${taskId}`}
        data-workflow-module={taskId} data-workflow-group={data.group} data-phase-id={data.phaseId}
        data-gate-state={gateState}
        aria-pressed={selected} aria-expanded={Boolean(data.expanded)} aria-description={explanation}
        title={[data.title, data.group, data.roleLabel, data.reviewLabel, data.gateLabel, explanation].filter(Boolean).join(' · ')}>
        <span className="task-code-symbol"><Code2 aria-hidden="true" /></span>
        <span className="task-flow-card-kicker">
          <small>{taskId}</small>
          <span className="task-module-note" title={data.label || data.gateLabel}>{status}</span>
        </span>
        <span className="task-flow-card-title dev-task-title">{data.title}</span>
        <span className="task-card-foot">
          <span>编码任务</span>
          <span className="task-module-junctions">
            {join && <span data-module-join="" data-gate-state={join.gateState} title={`汇合 ${join.count} 项，${join.gateLabel}`}>
              <GitMerge aria-hidden="true" />{join.count}
            </span>}
            {fork && <span data-module-fork="" data-gate-state={fork.gateState} title={`分叉 ${fork.count} 路，${fork.gateLabel}`}>
              <GitBranch aria-hidden="true" />{fork.count}
            </span>}
            {checkpoint && <span className="task-module-checkpoint" data-module-checkpoint="" data-gate-state={checkpoint.gateState}
              data-blocked={checkpoint.blocked} title={`${checkpointLabel}，${checkpoint.gateLabel}`}>
              <Shield aria-hidden="true" />
            </span>}
          </span>
          {movable && <Grip className="dev-task-grip" aria-hidden="true" />}
          <ChevronDown className="task-card-chevron" aria-hidden="true" />
        </span>
      </button>
      {data.inputs.map(side => {
        const eligible = side === 'left';
        return <Handle key={side} id={`input-${side}`} type="target" position={sidePositions[side]}
          isConnectable={eligible && editing} isConnectableStart={false}
          data-task-connector={eligible ? 'input' : undefined} data-owner-task={eligible ? taskId : undefined}
          onPointerDown={eligible ? stopCanvasPan : undefined} />;
      })}
      {data.outputs.map(side => {
        const eligible = side === 'right';
        return <Handle key={side} id={`output-${side}`} type="source" position={sidePositions[side]}
          isConnectable={eligible && editing} isConnectableEnd={false}
          data-task-connector={eligible ? 'output' : undefined} data-owner-task={eligible ? taskId : undefined}
          onPointerDown={eligible ? stopCanvasPan : undefined} />;
      })}
    </div>
  );
}

function ExecutionCard({ data }: { data: ExecutionNode }) {
  const title = `${data.title}；依赖：${data.dependencies}`;
  return (
    <button type="button" className="pe-task-node" data-task-id={data.id} data-status={data.status}
      data-focus={data.focused} tabIndex={data.selected ? 0 : -1} aria-pressed={data.selected}
      title={title} aria-label={`${data.id}：${title}；${data.statusLabel}`}>
      <small>{data.id}</small>
      <span className="pe-graph-title">{data.title}</span>
      <small className="pe-task-status">{data.statusLabel}</small>
      <small className="pe-graph-dependencies">依赖：{data.dependencies}</small>
    </button>
  );
}

function roundedPath(points: XYPosition[]) {
  const along = (point: XYPosition, toward: XYPosition) => {
    const distance = Math.hypot(toward.x - point.x, toward.y - point.y);
    const fraction = distance ? Math.min(8 / distance, .5) : 0;
    return `${point.x + (toward.x - point.x) * fraction},${point.y + (toward.y - point.y) * fraction}`;
  };
  const pointAt = (point: XYPosition) => `${point.x},${point.y}`;
  return `M${pointAt(points[0])}` + points.slice(1, -1).map((point, index) =>
    `L${along(point, points[index])}Q${pointAt(point)} ${along(point, points[index + 2])}`).join('')
    + `L${pointAt(points[points.length - 1])}`;
}

function ExpandedGuide({ node, panel }: { node: TaskNode; panel: DetailBounds }) {
  // Keep the disclosure line separate from dependency ports at the card centre.
  const startX = node.position.x + (node.width ?? 0) * .75;
  const startY = node.position.y + (node.height ?? 0);
  const endX = Math.max(panel.x + 16, Math.min(startX, panel.x + panel.width - 16));
  const left = Math.min(startX, endX) - 2;
  const length = panel.y - startY;
  if (length <= 0) return null;
  const x1 = startX - left, x2 = endX - left;
  const d = x1 === x2 ? `M${x1} 0V${length}` : roundedPath([
    { x: x1, y: 0 }, { x: x1, y: length / 2 }, { x: x2, y: length / 2 }, { x: x2, y: length },
  ]);
  return <svg className="task-expanded-guide" data-detail-guide={node.id} aria-hidden="true"
    style={{ left, top: startY }} width={Math.abs(endX - startX) + 4} height={length}>
    <path d={d} />
  </svg>;
}

function outsideHandle(x: number, y: number, position: Position) {
  const offset = 14;
  return {
    x: x + (position === Position.Left ? -offset : position === Position.Right ? offset : 0),
    y: y + (position === Position.Top ? -offset : position === Position.Bottom ? offset : 0),
  };
}

const Dependency = memo(function Dependency(props: EdgeProps<DependencyEdge>) {
  const { data, source, target, markerEnd } = props;
  const execution = data && 'focused' in data ? data : null;
  const plan = data && 'relation' in data ? data : null;
  // Handle coordinates can differ fractionally when the zoomed chart remounts.
  const coordinate = (value: number) => plan ? Math.round(value * 10) / 10 : value;
  const [sourceX, sourceY, targetX, targetY] = [props.sourceX, props.sourceY, props.targetX, props.targetY].map(coordinate);
  let path: string;
  let labelX: number | undefined;
  let labelY: number | undefined;
  if (plan && typeof plan.channel === 'number') {
    const sourceExit = outsideHandle(sourceX, sourceY, props.sourcePosition);
    const targetEntry = outsideHandle(targetX, targetY, props.targetPosition);
    const bypass = plan.viaX != null && plan.targetChannel != null
      ? [{ x: plan.viaX, y: plan.channel }, { x: plan.viaX, y: plan.targetChannel }] : [];
    const entryChannel = bypass.at(-1)?.y ?? plan.channel;
    path = roundedPath([{ x: sourceX, y: sourceY }, sourceExit, { x: sourceExit.x, y: plan.channel },
      ...bypass, { x: targetEntry.x, y: entryChannel }, targetEntry, { x: targetX, y: targetY }]);
    labelX = ((bypass[0]?.x ?? sourceExit.x) + targetEntry.x) / 2;
    labelY = entryChannel;
  } else if (plan) {
    [path, labelX, labelY] = getSmoothStepPath({ ...props, sourceX, sourceY, targetX, targetY, borderRadius: 9, offset: 12 });
  } else {
    path = execution?.vertical ? `M${sourceX},${sourceY} H10 V${targetY} H${targetX}` : getBezierPath(props)[0];
  }

  return (
    <>
        <BaseEdge
          className={execution ? 'pe-flow-edge' : plan?.internal ? 'task-flow-internal-edge' : `task-edge relation-${plan?.relation ?? 'muted'}`}
          interactionWidth={0}
          markerEnd={markerEnd}
          data-focus={execution?.focused}
          data-gate-state={plan?.internal ? undefined : plan?.gateState}
          data-from={execution ? source : plan?.fromTask}
          data-to={execution ? target : plan?.toTask}
          data-visual-from={plan ? source : undefined}
          data-visual-to={plan ? target : undefined}
          data-flow-internal={plan ? plan.internal : undefined}
          label={plan?.caption}
          labelX={labelX}
          labelY={labelY}
          labelShowBg={Boolean(plan?.caption)}
          labelBgPadding={[5, 3]}
          labelBgBorderRadius={4}
          path={path}
        />
        {plan?.motion && <path className="task-edge-motion" data-edge-motion={plan.motion} data-from={plan.fromTask}
          data-to={plan.toTask} d={path} aria-hidden="true" />}
    </>
  );
});

const nodeTypes = { task: TaskCard };
const edgeTypes = { dependency: Dependency };
const proOptions = { hideAttribution: true };

function getPlanningData(nodes: CanvasModel['nodes'], edges: CanvasEdge[]) {
  const planNodes = new Map<string, PlanNode>();
  const inputs = new Map<string, Set<Side>>();
  const outputs = new Map<string, Set<Side>>();
  const parents = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (!('kind' in node)) continue;
    planNodes.set(node.id, node);
    inputs.set(node.id, new Set());
    outputs.set(node.id, new Set());
  }
  for (const edge of edges) {
    if ('focused' in edge) continue;
    outputs.get(edge.source)?.add(edge.sourceSide ?? 'right');
    inputs.get(edge.target)?.add(edge.targetSide ?? 'left');
    if (edge.internal) continue;
    const from = edge.fromTask ?? planNodes.get(edge.source)?.taskId;
    const to = edge.toTask ?? planNodes.get(edge.target)?.taskId;
    if (!from || !to) continue;
    const direct = parents.get(to);
    if (direct) direct.add(from);
    else parents.set(to, new Set([from]));
  }
  return { planNodes, inputs, outputs, parents };
}

function TaskCanvas({ model }: { model: CanvasModel }) {
  const id = useId();
  const { nodes, edges, width, height, nodeWidth, nodeHeight, vertical, zoom, variant, groups, columns } = model;
  const planning = variant !== 'execution';
  const editing = planning && model.editing === true && Boolean(model.onConnect);
  const { planNodes, inputs, outputs, parents } = useMemo(() => getPlanningData(nodes, edges), [nodes, edges]);
  const extentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const extent = extentRef.current;
    if (!extent || !planning) return;
    let inView = true;
    const update = () => { extent.dataset.motionPaused = String(document.hidden || !inView); };
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); });
    observer.observe(extent);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [planning]);
  const [moved, setMoved] = useState<Move>();
  const lastFree = useRef<{ key?: string; taskId: string; position: XYPosition } | null>(null);
  const moving = moved && (moved.model === model || moved.dragging && moved.model.key === model.key) ? moved : undefined;

  const flowNodes = useMemo<TaskNode[]>(() => nodes.map(node => {
    const plan = 'kind' in node ? node : null;
    const canMove = Boolean(plan?.movable);
    const movingPart = plan && moving?.taskId === plan.taskId ? moving : undefined;
    const inputSides = [...(inputs.get(node.id) ?? [])];
    const outputSides = [...(outputs.get(node.id) ?? [])];
    if (plan && editing) {
      if (!inputSides.includes('left')) inputSides.push('left');
      if (!outputSides.includes('right')) outputSides.push('right');
    }
    const width = plan?.width ?? nodeWidth;
    const height = plan?.height ?? nodeHeight;
    return {
      id: node.id,
      type: 'task',
      data: plan ? { ...plan, editing, inputs: inputSides, outputs: outputSides,
        parents: [...(parents.get(plan.taskId) ?? [])] } : node as ExecutionNode,
      position: movingPart?.position ?? node.position,
      width,
      height,
      // Fixed ports stay attached while React Flow receives updated module positions.
      handles: plan ? [
        ...inputSides.map(side => planPort(side, 'target', width, height, editing)),
        ...outputSides.map(side => planPort(side, 'source', width, height, editing)),
      ] : undefined,
      draggable: canMove,
      dragHandle: canMove ? '.dev-task' : undefined,
      zIndex: plan ? movingPart?.dragging ? 5 : plan.selected ? 3 : 2 : undefined,
      sourcePosition: vertical && variant === 'execution' ? Position.Left : Position.Right,
      targetPosition: Position.Left,
    };
  }), [nodes, nodeWidth, nodeHeight, vertical, variant, editing, inputs, outputs, parents, moving]);

  const flowEdges = useMemo<DependencyEdge[]>(() => {
    const gateByTask = new Map<string, GateState>();
    const selectedTask = nodes.find(node => 'kind' in node && node.selected) as PlanNode | undefined;
    for (const node of planNodes.values()) {
      if (node.gateState) gateByTask.set(node.taskId, node.gateState);
    }
    let pulseCount = 0;
    return edges.map(edge => {
      const { source, target } = edge;
      const execution = 'focused' in edge;
      const id = edge.id ?? JSON.stringify([source, target]);
      if (execution) return {
        id, type: 'dependency', source, target, data: { focused: edge.focused, vertical },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: edge.focused ? '#4a837a' : '#aab5cf' },
      };
      const fromTask = edge.internal ? undefined : edge.fromTask ?? planNodes.get(source)?.taskId;
      const toTask = edge.internal ? undefined : edge.toTask ?? planNodes.get(target)?.taskId;
      const gateState = fromTask ? gateByTask.get(fromTask) ?? 'planned' : 'planned';
      const targetGate = toTask ? gateByTask.get(toTask) : undefined;
      const related = selectedTask && (selectedTask.taskId === fromTask || selectedTask.taskId === toTask);
      let motion: EdgeMotion | undefined;
      if (!edge.internal && pulseCount < 32) {
        if (gateState === 'passed' && targetGate === 'checking') motion = 'active';
        else if (gateState === 'planned' && (related || edges.length <= 32)) motion = related ? 'selected' : 'ambient';
        if (motion) pulseCount++;
      }
      const color = { failed: '#a83245', checking: '#4279bd', waiting: '#75869e', passed: '#2f69aa', planned: planMarkerColors[edge.relation] }[gateState];
      return {
        id, type: 'dependency', source, target,
        sourceHandle: `output-${edge.sourceSide ?? 'right'}`, targetHandle: `input-${edge.targetSide ?? 'left'}`,
        data: { ...edge, fromTask, toTask, gateState, motion },
        markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: edge.internal ? '#92a0bb' : color },
      };
    });
  }, [edges, nodes, planNodes, vertical]);

  function clampMotion(node: PlanNode, point: XYPosition) {
    const bounds = node.movementBounds ?? { minX: 12, minY: 12,
      maxX: width - 12 - (node.width ?? nodeWidth), maxY: height - 12 - (node.height ?? nodeHeight) };
    const x = Math.max(bounds.minX, Math.min(bounds.maxX, point.x));
    const y = Math.max(bounds.minY, Math.min(bounds.maxY, point.y));
    const right = x + (node.width ?? nodeWidth), bottom = y + (node.height ?? nodeHeight);
    for (const peer of planNodes.values()) {
      if (peer.id === node.id || peer.group !== node.group) continue;
      if (x < peer.position.x + (peer.width ?? nodeWidth) + 6 && right + 6 > peer.position.x
          && y < peer.position.y + (peer.height ?? nodeHeight) + 6 && bottom + 6 > peer.position.y) {
        const previous = lastFree.current;
        return previous?.taskId === node.taskId && previous.key === model.key ? previous.position : node.position;
      }
    }
    lastFree.current = { key: model.key, taskId: node.taskId, position: { x, y } };
    return lastFree.current.position;
  }

  const onNodesChange: OnNodesChange<TaskNode> = changes => {
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue;
      const node = planNodes.get(change.id);
      if (!node?.movable) continue;
      setMoved({ model, taskId: node.taskId, position: clampMotion(node, change.position), dragging: change.dragging === true });
    }
  };

  function canConnect({ source, target, sourceHandle, targetHandle }: Connection | DependencyEdge) {
    const from = planNodes.get(source), to = planNodes.get(target);
    return !!from && !!to && from.taskId !== to.taskId
      && sourceHandle === 'output-right' && targetHandle === 'input-left';
  }

  const expandedNode = model.detailBounds && flowNodes.find(node => 'kind' in node.data && node.data.expanded);
  const viewport = useMemo(() => ({ x: 0, y: 0, zoom }), [zoom]);
  // React Flow owns node interaction and zoom. Native scroll owns panning.
  return (
    <div ref={extentRef} className="task-flow-extent" style={planning
      ? { width: Math.ceil(width * zoom), height: Math.ceil(height * zoom) }
      : { width, height, transform: `scale(${zoom})` }}>
      {planning && groups?.length && (
        <div className="task-flow-groups" style={{ width, height, transform: `scale(${zoom})` }}>
          {groups.map(group => (
            <div className="task-flow-group" data-header-side={group.headerSide} data-flow-group={group.id}
              data-phase-frame={group.id} data-phase-expanded={Boolean(group.expanded)} key={group.id}
              style={{ left: group.left, width: group.width, top: group.top, height: group.height }}>
              <div className="task-flow-group-heading">
                <i aria-hidden="true">{String(group.rank + 1).padStart(2, '0')}</i>
                <strong title={group.title}>{group.title}</strong>
                <span>{group.count} 个任务</span>
              </div>
            </div>
          ))}
          {columns?.map(column => (
            <div className="task-flow-column" data-flow-column={column.rank} key={column.rank}
              style={{ left: column.left - 10, width: column.width + 20, height: height - 9 }}>
              <span>{column.title}</span>
            </div>
          ))}
          {expandedNode && model.detailBounds && <ExpandedGuide node={expandedNode} panel={model.detailBounds} />}
        </div>
      )}
      <ReactFlow<TaskNode, DependencyEdge>
        id={id}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={planning}
        onNodesChange={planning ? onNodesChange : undefined}
        onNodeDragStart={planning ? () => { lastFree.current = null; } : undefined}
        onNodeDragStop={planning ? (_event, node) => {
          const original = planNodes.get(node.id);
          if (!original?.movable) return;
          model.onNodeMove?.(original.taskId, clampMotion(original, node.position));
        } : undefined}
        nodeDragThreshold={5}
        nodeExtent={planning ? [[12, 12], [width - 12, height - 12]] : undefined}
        viewport={planning ? viewport : undefined}
        minZoom={planning ? .001 : undefined}
        maxZoom={2}
        nodesConnectable={editing}
        isValidConnection={editing ? canConnect : undefined}
        onConnect={editing ? connection => {
          if (canConnect(connection)) model.onConnect?.(planNodes.get(connection.source)!.taskId, planNodes.get(connection.target)!.taskId);
        } : undefined}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        preventScrolling={false}
        panOnDrag={false}
        autoPanOnNodeDrag={false}
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        disableKeyboardA11y
        proOptions={proOptions}
      />
    </div>
  );
}

declare global {
  interface Window {
    taskflowTaskCanvas?: (element: HTMLElement) => {
      render(model: CanvasModel): void;
      destroy(): void;
    };
  }
}

export function installTaskCanvas() {
  window.taskflowTaskCanvas = element => {
    const root = createRoot(element);
    return {
      render(model) {
        flushSync(() => root.render(<TaskCanvas model={model} />));
      },
      destroy() {
        root.unmount();
      },
    };
  };
}
