import { memo, useId, useMemo, useState, type CSSProperties, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Bot, ClipboardCheck, GitBranch, GitMerge, Grip, Shield } from 'lucide-react';
import {
  BaseEdge, getBezierPath, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnNodesChange, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/base.css';
import './task-canvas.css';

type Relation = 'muted' | 'upstream' | 'downstream';
type GateState = 'planned' | 'waiting' | 'checking' | 'passed' | 'failed';
type Side = 'bottom' | 'top' | 'left' | 'right';
type EdgeMotion = 'selected' | 'active';

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
  fromTask?: string;
  toTask?: string;
  caption?: string;
  internal: boolean;
  sourceSide?: Side;
  targetSide?: Side;
};
type DependencyData = (PlanDependency & { gateState: GateState; motion?: EdgeMotion }) | { focused: boolean; vertical: boolean };
type CanvasEdge = { id?: string; source: string; target: string } & (PlanDependency | { focused: boolean });
type PlanGroup = { id: string; rank: number; title: string; top: number; height: number; left: number; width: number; count: number };
type PlanColumn = { rank: number; title: string; left: number; width: number };

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
  columns?: PlanColumn[];
  variant?: 'execution';
  key?: string;
  onNodeMove?: (id: string, position: XYPosition) => void;
  editing?: boolean;
  onConnect?: (source: string, target: string) => void;
};

type TaskNode = Node<PlanTask | ExecutionNode, 'task'>;
type DependencyEdge = Edge<DependencyData, 'dependency'>;
type Move = { model: CanvasModel; taskId: string; y: number; dragging: boolean };

const sidePositions: Record<Side, Position> = {
  top: Position.Top, bottom: Position.Bottom, left: Position.Left, right: Position.Right,
};
const markerColors: Record<Relation, string> = {
  muted: '#7685a1',
  upstream: '#197d79',
  downstream: '#3846ce',
};
const gateHelp = '同一代码版本的自检、独立 HTTP、Edge 和 Review 均通过且完成代码集成后，才释放后续任务。';
const reviewHeight = 27;
const reviewGap = 6;
const portSize = 8;
const editPortSize = 16;
const planSizing = {
  '--task-review-height': `${reviewHeight}px`,
  '--task-review-gap': `${reviewGap}px`,
  '--task-port-size': `${portSize}px`,
  '--task-edit-port-size': `${editPortSize}px`,
} as CSSProperties;

function planPort(side: Side, type: 'source' | 'target', width: number, height: number, editing: boolean) {
  const x = { left: 0, right: width, top: width / 2, bottom: width / 2 }[side];
  const y = { left: (height - reviewHeight - reviewGap) / 2, right: height - reviewHeight / 2, top: 0, bottom: height }[side];
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
  const reviewTitle = `${data.title}的代码审查 Review，${data.reviewLabel}`;
  return (
    <div className="plan-task-node" data-movable={movable} data-editing={editing} style={planSizing}>
      <button type="button" className={`task-flow-card dev-task ${data.className}`}
        data-flow-node={data.id} data-flow-part="agent" data-flow-role="coding" data-owner-task={taskId}
        data-flow-rank={data.rank} data-task={taskId} data-focus-key={`task-${taskId}`}
        data-workflow-module={taskId} data-workflow-group={data.group}
        data-gate-state={gateState}
        aria-pressed={selected} aria-description={explanation}
        title={[data.title, data.group, data.roleLabel, data.reviewLabel, data.gateLabel, explanation].filter(Boolean).join(' · ')}>
        <span className="task-flow-card-kicker">
          <Bot aria-hidden="true" />
          <small>{taskId}</small>
          <span className="task-module-note" title={data.label || data.roleLabel}>{data.label || '编码'}</span>
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
        </span>
        <span className="task-flow-card-title dev-task-title">{data.title}</span>
      </button>
      <span className="task-review-feed" aria-hidden="true" />
      <button type="button" className="task-review-gate nodrag" data-task-review={taskId} data-review-state={data.reviewState}
        data-focus-key={`review-${taskId}`} aria-label={reviewTitle} aria-controls="task-review-flow"
        title={`${reviewTitle}。出现阻塞意见时返回编码修订。同版验收通过且完成集成后放行。`}>
        <ClipboardCheck aria-hidden="true" />
        <strong>Review</strong>
        <span>{data.reviewLabel}</span>
      </button>
      <svg className="task-review-return" data-review-loop={data.reviewState === 'failed' ? 'blocked' : 'conditional'}
        width="18" height="36" viewBox="0 0 18 36" aria-hidden="true">
        <title>审查有阻塞意见时返回编码修订</title>
        <path d="M18 24H11Q5 24 5 18V4" />
        <path d="m2 7 3-3 3 3" />
      </svg>
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
    path = roundedPath([{ x: sourceX, y: sourceY }, sourceExit, { x: sourceExit.x, y: plan.channel },
      { x: targetEntry.x, y: plan.channel }, targetEntry, { x: targetX, y: targetY }]);
    labelX = (sourceExit.x + targetEntry.x) / 2;
    labelY = plan.channel;
  } else if (plan) {
    [path, labelX, labelY] = getSmoothStepPath({ ...props, sourceX, sourceY, targetX, targetY, borderRadius: 9, offset: 12 });
  } else {
    path = execution?.vertical ? `M${sourceX},${sourceY} H10 V${targetY} H${targetX}` : getBezierPath(props)[0];
  }

  return (
    <BaseEdge
      className={execution ? 'pe-flow-edge' : plan?.internal ? 'task-flow-internal-edge' : `task-edge relation-${plan?.relation ?? 'muted'}`}
      interactionWidth={0}
      markerEnd={markerEnd}
      data-focus={execution?.focused}
      data-gate-state={plan?.internal ? undefined : plan?.gateState}
      data-flow-motion={plan?.motion}
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
    inputs.set(node.id, new Set(['left']));
    outputs.set(node.id, new Set(['right']));
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
  const [moved, setMoved] = useState<Move>();
  const moving = moved && (moved.model === model || moved.dragging && moved.model.key === model.key) ? moved : undefined;

  const flowNodes = useMemo<TaskNode[]>(() => nodes.map(node => {
    const plan = 'kind' in node ? node : null;
    const canMove = Boolean(plan?.movable);
    const movingPart = plan && moving?.taskId === plan.taskId ? moving : undefined;
    const inputSides = [...(inputs.get(node.id) ?? [])];
    const outputSides = [...(outputs.get(node.id) ?? [])];
    const width = plan?.width ?? nodeWidth;
    const height = plan?.height ?? nodeHeight;
    return {
      id: node.id,
      type: 'task',
      data: plan ? { ...plan, editing, inputs: inputSides, outputs: outputSides,
        parents: [...(parents.get(plan.taskId) ?? [])] } : node as ExecutionNode,
      position: movingPart ? { x: node.position.x, y: movingPart.y } : node.position,
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
    return edges.map(edge => {
      const { source, target } = edge;
      const execution = 'focused' in edge;
      const id = edge.id ?? JSON.stringify([source, target]);
      if (execution) return {
        id, type: 'dependency', source, target, data: { focused: edge.focused, vertical },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: edge.focused ? markerColors.downstream : '#aab5cf' },
      };
      const fromTask = edge.internal ? undefined : edge.fromTask ?? planNodes.get(source)?.taskId;
      const toTask = edge.internal ? undefined : edge.toTask ?? planNodes.get(target)?.taskId;
      const gateState = fromTask ? gateByTask.get(fromTask) ?? 'planned' : 'planned';
      const targetGate = toTask ? gateByTask.get(toTask) : undefined;
      const related = selectedTask && (selectedTask.taskId === fromTask || selectedTask.taskId === toTask);
      const motion: EdgeMotion | undefined = gateState === 'planned' && related ? 'selected'
        : gateState === 'passed' && targetGate === 'checking' ? 'active' : undefined;
      const color = edge.internal ? '#92a0bb' : gateState === 'passed' ? '#19734f' : markerColors[edge.relation];
      return {
        id, type: 'dependency', source, target,
        sourceHandle: `output-${edge.sourceSide ?? 'right'}`, targetHandle: `input-${edge.targetSide ?? 'left'}`,
        data: { ...edge, fromTask, toTask, gateState, motion },
        markerEnd: edge.internal || gateState === 'planned' || gateState === 'passed'
          ? { type: MarkerType.ArrowClosed, width: 11, height: 11, color } : undefined,
      };
    });
  }, [edges, nodes, planNodes, vertical]);

  function clampMotion(node: PlanNode, y: number) {
    return Math.max(12, Math.min(height - 12 - (node.height ?? nodeHeight), y));
  }

  const onNodesChange: OnNodesChange<TaskNode> = changes => {
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue;
      const node = planNodes.get(change.id);
      if (!node?.movable) continue;
      setMoved({ model, taskId: node.taskId, y: clampMotion(node, change.position.y), dragging: change.dragging === true });
    }
  };

  function canConnect({ source, target, sourceHandle, targetHandle }: Connection | DependencyEdge) {
    const from = planNodes.get(source), to = planNodes.get(target);
    return !!from && !!to && from.taskId !== to.taskId
      && sourceHandle === 'output-right' && targetHandle === 'input-left';
  }

  const viewport = useMemo(() => ({ x: 0, y: 0, zoom }), [zoom]);
  // React Flow owns node interaction and zoom. Native scroll owns panning.
  return (
    <div className="task-flow-extent" style={planning
      ? { width: Math.ceil(width * zoom), height: Math.ceil(height * zoom) }
      : { width, height, transform: `scale(${zoom})` }}>
      {planning && groups?.length && (
        <div className="task-flow-groups" style={{ width, height, transform: `scale(${zoom})` }}>
          {groups.map(group => (
            <div className="task-flow-group" data-flow-group={group.id} key={group.id}
              style={{ left: group.left, width: group.width, top: group.top, height: group.height }}>
              <div className="task-flow-group-heading"><strong title={group.title}>{group.title}</strong><span>{group.count} 个模块</span></div>
            </div>
          ))}
          {columns?.map(column => (
            <div className="task-flow-column" data-flow-column={column.rank} key={column.rank}
              style={{ left: column.left - 10, width: column.width + 20, height: height - 9 }}>
              <span>{column.title}</span>
            </div>
          ))}
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
        onNodeDragStop={planning ? (_event, node) => {
          const original = planNodes.get(node.id);
          if (!original?.movable) return;
          model.onNodeMove?.(original.taskId, { x: original.position.x, y: clampMotion(original, node.position.y) });
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
