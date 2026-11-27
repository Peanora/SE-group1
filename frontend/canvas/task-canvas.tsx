import { memo, useId, useMemo, useState, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CircleCheck, CircleDot, CircleX, Clock3, Grip, Shield } from 'lucide-react';
import {
  BaseEdge, getBezierPath, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnNodesChange, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/base.css';
import './task-canvas.css';

type Relation = 'muted' | 'upstream' | 'downstream';
type GateState = 'planned' | 'waiting' | 'checking' | 'passed' | 'failed';

const CHECKPOINT_HEIGHT = 36;

type NodeIdentity = {
  id: string;
  title: string;
  position: XYPosition;
  selected: boolean;
};

type PlanNode = NodeIdentity & {
  label: string;
  className: string;
  meta: string;
  topology: 'root' | 'task' | 'join' | 'finish';
  gateState?: GateState;
  gateLabel?: string;
  inputs?: number;
  outputs?: number;
};

type PlanTask = PlanNode & { editing: boolean; parents: string[]; children: number };

type ExecutionNode = NodeIdentity & {
  status: string;
  statusLabel: string;
  dependencies: string;
  focused: boolean;
};

type PlanDependency = { relation: Relation; channel: number | null };
type DependencyData = (PlanDependency & { gateState: GateState; motion?: 'selected' | 'active' }) | { focused: boolean; vertical: boolean };
type CanvasEdge = { source: string; target: string } & (PlanDependency | { focused: boolean });

type CanvasModel = {
  nodes: (PlanNode | ExecutionNode)[];
  edges: CanvasEdge[];
  vertical: boolean;
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  zoom: number;
  variant?: 'execution';
  key?: string;
  onNodeMove?: (id: string, position: XYPosition) => void;
  editing?: boolean;
  onConnect?: (source: string, target: string) => void;
};

type TaskNode = Node<PlanTask | ExecutionNode, 'task'>;
type DependencyEdge = Edge<DependencyData, 'dependency'>;

const markerColors: Record<Relation, string> = {
  muted: '#7e8eae',
  upstream: '#197d79',
  downstream: '#3846ce',
};

const gatePresentation = {
  planned: { label: '待验收', icon: Shield },
  waiting: { label: '待检查', icon: Clock3 },
  checking: { label: '检查中', icon: CircleDot },
  passed: { label: '通过并集成', icon: CircleCheck },
  failed: { label: '失败，后续阻断', icon: CircleX },
};

const stopCanvasPan = (event: PointerEvent) => event.stopPropagation();

const TaskCard = memo(function TaskCard({ data, sourcePosition, targetPosition }: NodeProps<TaskNode>) {
  if (!('status' in data)) return <PlanCard data={data} />;
  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />
      <ExecutionCard data={data} />
      <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />
    </>
  );
});

function PlanCard({ data }: { data: PlanTask }) {
  const checkpointId = useId();
  const gateState = data.gateState ?? 'planned';
  const { icon: GateIcon, label } = gatePresentation[gateState];
  const gateLabel = data.gateLabel || label;
  const inputs = data.inputs ?? data.parents.length;
  const outputs = data.outputs ?? data.children;
  const branch = [inputs > 1 ? `汇合 ${inputs} 项` : '', outputs > 1 ? `分叉 ${outputs} 路` : ''].filter(Boolean).join(' / ');
  const prerequisites = inputs ? `直接前置：${data.parents.join('、') || inputs}` : '无直接前置任务';
  const gateHelp = '确认同一代码版本的自检、独立 HTTP、Edge 和 Review 均通过且完成代码集成后，才释放后续任务。';
  return (
    <div className="plan-task-node" data-editing={data.editing} style={{ gridTemplateRows: `minmax(0, 1fr) ${CHECKPOINT_HEIGHT}px` }}>
      <button type="button" className={`dev-task ${data.className}`} data-task={data.id}
        data-topology={data.topology} data-focus-key={`task-${data.id}`} aria-pressed={data.selected}
        aria-describedby={checkpointId} title={data.title}>
        <span className="dev-task-top"><span><Grip className="dev-task-grip" aria-hidden="true" />{data.id}</span><span>{data.label}</span></span>
        <span className="dev-task-title">{data.title}</span>
        <span className="dev-task-meta">
          {branch && <span className="dev-task-topology" title={prerequisites}>{branch}</span>}
          <span className="dev-task-context" title={data.meta}>{data.meta}</span>
        </span>
      </button>
      <div className="task-checkpoint" data-gate-state={gateState} id={checkpointId}
        title={`验收检查点：${gateLabel}。${prerequisites}。${gateHelp}`}>
        <GateIcon aria-hidden="true" />
        <span>验收检查点</span>
        <span className="task-checkpoint-status"> {gateLabel}</span>
        <span className="visually-hidden">。{prerequisites}。{gateHelp}</span>
      </div>
      <Handle id="input-top" type="target" position={Position.Top} isConnectable={data.editing}
        isConnectableStart={false} data-task-connector="input" onPointerDown={stopCanvasPan} />
      <Handle id="output-bottom" type="source" position={Position.Bottom} isConnectable={data.editing}
        isConnectableEnd={false} data-task-connector="output" onPointerDown={stopCanvasPan} />
      <Handle id="input-left" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="input-right" type="target" position={Position.Right} isConnectable={false} />
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

const Dependency = memo(function Dependency(props: EdgeProps<DependencyEdge>) {
  const { data, source, target, markerEnd } = props;
  const execution = data && 'focused' in data ? data : null;
  const plan = data && 'relation' in data ? data : null;
  // Handle measurements can differ by a fraction of a pixel when a zoomed chart remounts.
  const coordinate = (value: number) => plan ? Math.round(value * 10) / 10 : value;
  const [sourceX, sourceY, targetX, targetY] = [props.sourceX, props.sourceY, props.targetX, props.targetY].map(coordinate);
  // Route the narrow execution graph through a left gutter to keep dependencies clear of cards.
  const channel = plan?.channel;
  const path = typeof channel === 'number' ? roundedPath([
    { x: sourceX, y: sourceY }, { x: sourceX, y: sourceY + 15 },
    { x: channel, y: sourceY + 15 }, { x: channel, y: targetY - 15 },
    { x: targetX, y: targetY - 15 }, { x: targetX, y: targetY },
  ]) : plan ? getSmoothStepPath({ ...props, sourceX, sourceY, targetX, targetY, borderRadius: 9, offset: 14 })[0]
    : execution?.vertical ? `M${sourceX},${sourceY} H10 V${targetY} H${targetX}` : getBezierPath(props)[0];
  return (
    <BaseEdge
      className={execution ? 'pe-flow-edge' : `task-edge relation-${plan?.relation ?? 'muted'}`}
      interactionWidth={0}
      markerEnd={markerEnd}
      data-focus={execution?.focused}
      data-gate-state={plan?.gateState}
      data-flow-motion={plan?.motion}
      data-from={source}
      data-to={target}
      path={path}
    />
  );
});

const nodeTypes = { task: TaskCard };
const edgeTypes = { dependency: Dependency };
const proOptions = { hideAttribution: true };

function canConnect({ source, target, sourceHandle, targetHandle }: Connection | DependencyEdge) {
  return source !== target && sourceHandle === 'output-bottom' && targetHandle === 'input-top';
}

function TaskCanvas({ model }: { model: CanvasModel }) {
  const id = useId();
  const { nodes, edges, width, height, nodeWidth, nodeHeight, vertical, zoom, variant } = model;
  const planning = variant !== 'execution';
  const editing = planning && model.editing === true && Boolean(model.onConnect);
  const taskLinks = useMemo(() => {
    const parents = new Map<string, string[]>();
    const children = new Map<string, number>();
    if (planning) for (const { source, target } of edges) {
      const direct = parents.get(target);
      if (direct) direct.push(source);
      else parents.set(target, [source]);
      children.set(source, (children.get(source) ?? 0) + 1);
    }
    return { parents, children };
  }, [edges, planning]);
  const [moved, setMoved] = useState<{ model: CanvasModel; id: string; position: XYPosition; dragging: boolean }>();
  const moving = moved && (moved.model === model || moved.dragging && moved.model.key === model.key) ? moved : undefined;
  const flowNodes = useMemo<TaskNode[]>(() => nodes.map(node => ({
    id: node.id,
    type: 'task',
    data: 'status' in node ? node : { ...node, editing, parents: taskLinks.parents.get(node.id) ?? [], children: taskLinks.children.get(node.id) ?? 0 },
    position: moving?.id === node.id ? moving.position : node.position,
    width: nodeWidth,
    height: nodeHeight + (planning ? CHECKPOINT_HEIGHT : 0),
    dragHandle: planning ? '.dev-task' : undefined,
    zIndex: planning ? (moving?.id === node.id && moving.dragging ? 2 : node.selected ? 1 : 0) : undefined,
    sourcePosition: vertical ? variant === 'execution' ? Position.Left : Position.Bottom : Position.Right,
    targetPosition: vertical && variant !== 'execution' ? Position.Top : Position.Left,
  })), [nodes, nodeWidth, nodeHeight, vertical, variant, planning, editing, taskLinks, moving]);
  const flowEdges = useMemo<DependencyEdge[]>(() => {
    const nodesById = new Map(flowNodes.map(node => [node.id, node]));
    return edges.map(edge => {
      const { source, target } = edge;
      const from = nodesById.get(source), to = nodesById.get(target);
      const sourceTask = from?.data, targetTask = to?.data;
      const gateState = sourceTask && !('status' in sourceTask) ? sourceTask.gateState ?? 'planned' : 'planned';
      const targetChecking = targetTask && !('status' in targetTask) && targetTask.gateState === 'checking';
      const motion: 'selected' | 'active' | undefined = gateState === 'planned' && (sourceTask?.selected || targetTask?.selected) ? 'selected'
        : gateState === 'passed' && targetChecking ? 'active' : undefined;
      const execution = 'focused' in edge;
      const data = execution ? { focused: edge.focused, vertical } : { relation: edge.relation, channel: edge.channel, gateState, motion };
      const color = execution ? edge.focused ? markerColors.downstream : '#aab5cf'
        : gateState === 'passed' ? '#19734f' : markerColors[edge.relation];
      let targetHandle;
      if (!execution) {
        const dx = (to?.position.x ?? 0) - (from?.position.x ?? 0);
        const dy = (to?.position.y ?? 0) - (from?.position.y ?? 0);
        const sideways = edge.channel === null && Math.abs(dy) < nodeHeight * .6 && Math.abs(dx) > nodeWidth;
        targetHandle = sideways ? dx > 0 ? 'input-left' : 'input-right' : 'input-top';
      }
      return {
        id: JSON.stringify([source, target]), type: 'dependency', source, target,
        sourceHandle: execution ? undefined : 'output-bottom', targetHandle, data,
        markerEnd: execution || gateState === 'planned' || gateState === 'passed'
          ? { type: MarkerType.ArrowClosed, width: 12, height: 12, color } : undefined,
      };
    });
  }, [edges, vertical, flowNodes, nodeHeight, nodeWidth]);
  const viewport = useMemo(() => ({ x: 0, y: 0, zoom }), [zoom]);
  const onNodesChange: OnNodesChange<TaskNode> = changes => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        setMoved({ model, id: change.id, position: change.position, dragging: change.dragging === true });
      }
    }
  };

  // Use the real React Flow zoom for draggable nodes. Outer native scroll still owns panning.
  return (
    <div className="task-flow-extent" style={planning
      ? { width: Math.ceil(width * zoom), height: Math.ceil(height * zoom) }
      : { width, height, transform: `scale(${zoom})` }}>
      <ReactFlow<TaskNode, DependencyEdge>
        id={id}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={planning}
        onNodesChange={planning ? onNodesChange : undefined}
        onNodeDragStop={planning ? (_event, node) => model.onNodeMove?.(node.id, node.position) : undefined}
        nodeDragThreshold={5}
        nodeExtent={planning ? [[12, 12], [width - 12, height - 12]] : undefined}
        viewport={planning ? viewport : undefined}
        minZoom={planning ? .001 : undefined}
        maxZoom={2}
        nodesConnectable={editing}
        isValidConnection={editing ? canConnect : undefined}
        onConnect={editing ? connection => {
          if (canConnect(connection)) model.onConnect?.(connection.source, connection.target);
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
