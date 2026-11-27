import { memo, useId, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Grip } from 'lucide-react';
import {
  BaseEdge, getBezierPath, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type OnNodesChange, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/base.css';
import './task-canvas.css';

type Relation = 'muted' | 'upstream' | 'downstream';

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
};

type ExecutionNode = NodeIdentity & {
  status: string;
  statusLabel: string;
  dependencies: string;
  focused: boolean;
};

type PlanDependency = { relation: Relation; channel: number | null };
type DependencyData = PlanDependency | { focused: boolean; vertical: boolean };
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
  bands?: { count: number; top: number; height: number }[];
  onNodeMove?: (id: string, position: XYPosition) => void;
};

type TaskNode = Node<PlanNode | ExecutionNode, 'task'>;
type DependencyEdge = Edge<DependencyData, 'dependency'>;

const markerColors: Record<Relation, string> = {
  muted: '#7e8eae',
  upstream: '#197d79',
  downstream: '#3846ce',
};

const TaskCard = memo(function TaskCard({ data, sourcePosition, targetPosition }: NodeProps<TaskNode>) {
  if (!('status' in data)) {
    return (
      <>
        <PlanCard data={data} />
        <Handle id="input-top" type="target" position={Position.Top} isConnectable={false} />
        <Handle id="output-bottom" type="source" position={Position.Bottom} isConnectable={false} />
        <Handle id="input-left" type="target" position={Position.Left} isConnectable={false} />
        <Handle id="input-right" type="target" position={Position.Right} isConnectable={false} />
        <Handle id="output-left" type="source" position={Position.Left} isConnectable={false} />
        <Handle id="output-right" type="source" position={Position.Right} isConnectable={false} />
      </>
    );
  }
  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />
      <ExecutionCard data={data} />
      <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />
    </>
  );
});

function PlanCard({ data }: { data: PlanNode }) {
  return (
    <button type="button" className={`dev-task ${data.className}`} data-task={data.id}
      data-topology={data.topology} data-focus-key={`task-${data.id}`} aria-pressed={data.selected} title={data.title}>
      <span className="dev-task-top"><span><Grip className="dev-task-grip" aria-hidden="true" />{data.id}</span><span>{data.label}</span></span>
      <span className="dev-task-title">{data.title}</span>
      <span className="dev-task-meta">{data.meta}</span>
    </button>
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
  const { data, source, target, markerEnd, label } = props;
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
      data-from={source}
      data-to={target}
      label={label}
      labelX={label ? sourceX + 24 : undefined}
      labelY={label ? sourceY + 22 : undefined}
      labelStyle={{ fontSize: 11, fontWeight: 700, fill: '#314868' }}
      labelBgStyle={{ fill: '#f7f9fc', fillOpacity: .98 }}
      path={path}
    />
  );
});

const nodeTypes = { task: TaskCard };
const edgeTypes = { dependency: Dependency };
const proOptions = { hideAttribution: true };

function TaskCanvas({ model }: { model: CanvasModel }) {
  const id = useId();
  const { nodes, edges, width, height, nodeWidth, nodeHeight, vertical, zoom, variant, bands } = model;
  const planning = variant !== 'execution';
  const [moved, setMoved] = useState<{ model: CanvasModel; id: string; position: XYPosition; dragging: boolean }>();
  const moving = moved && (moved.model === model || moved.dragging && moved.model.key === model.key) ? moved : undefined;
  const flowNodes = useMemo<TaskNode[]>(() => nodes.map(node => ({
    id: node.id,
    type: 'task',
    data: node,
    position: moving?.id === node.id ? moving.position : node.position,
    width: nodeWidth,
    height: nodeHeight,
    dragHandle: planning ? '.dev-task' : undefined,
    zIndex: planning ? (moving?.id === node.id && moving.dragging ? 2 : node.selected ? 1 : 0) : undefined,
    sourcePosition: vertical ? variant === 'execution' ? Position.Left : Position.Bottom : Position.Right,
    targetPosition: vertical && variant !== 'execution' ? Position.Top : Position.Left,
  })), [nodes, nodeWidth, nodeHeight, vertical, variant, planning, moving]);
  const flowEdges = useMemo<DependencyEdge[]>(() => {
    const cardinality = new Map<string, number>();
    const nodePositions = new Map(flowNodes.map(node => [node.id, node.position]));
    const selected = nodes.find(node => node.selected)?.id;
    let splitLabeled = false;
    for (const edge of edges) cardinality.set(edge.source, (cardinality.get(edge.source) ?? 0) + 1);
    return edges.map(edge => {
      const { source, target } = edge;
      const plan = 'relation' in edge ? edge : null;
      const data = 'focused' in edge ? { focused: edge.focused, vertical } : { relation: edge.relation, channel: edge.channel };
      const color = 'focused' in edge ? edge.focused ? markerColors.downstream : '#aab5cf' : markerColors[edge.relation];
      let sourceHandle, targetHandle, label;
      if (plan) {
        const from = nodePositions.get(source), to = nodePositions.get(target);
        const dx = (to?.x ?? 0) - (from?.x ?? 0), dy = (to?.y ?? 0) - (from?.y ?? 0);
        const sideways = plan.channel === null && Math.abs(dy) < nodeHeight * .6 && Math.abs(dx) > nodeWidth;
        sourceHandle = sideways ? dx > 0 ? 'output-right' : 'output-left' : 'output-bottom';
        targetHandle = sideways ? dx > 0 ? 'input-left' : 'input-right' : 'input-top';
        const children = cardinality.get(source) ?? 0;
        if (!splitLabeled && source === selected && children > 1 && !sideways && plan.channel === null) {
          label = `分出 ${children} 路`;
          splitLabeled = true;
        }
      }
      return {
        id: JSON.stringify([source, target]), type: 'dependency', source, target, sourceHandle, targetHandle, data, label,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
      };
    });
  }, [edges, vertical, nodes, flowNodes, nodeHeight, nodeWidth]);
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
      {planning && bands && (
        <div className="task-levels" style={{ position: 'absolute', inset: '0 auto auto 0', width, height,
          transform: `scale(${zoom})`, transformOrigin: 'top left', pointerEvents: 'none' }}>
          {bands.map((band, index) => (
            <div className="task-level-band" key={index} style={{ top: band.top, height: band.height }}>
              <span className="task-level-caption">依赖层 {index + 1} <span>· {band.count} 项任务</span></span>
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
        onNodeDragStop={planning ? (_event, node) => model.onNodeMove?.(node.id, node.position) : undefined}
        nodeDragThreshold={5}
        nodeExtent={planning ? [[12, 12], [width - 12, height - 12]] : undefined}
        viewport={planning ? viewport : undefined}
        minZoom={planning ? .001 : undefined}
        maxZoom={2}
        nodesConnectable={false}
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
