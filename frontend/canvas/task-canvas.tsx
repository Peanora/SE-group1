import { memo, useId, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  BaseEdge, getBezierPath, Handle, MarkerType, Position, ReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/base.css';
import './task-canvas.css';

type Relation = 'muted' | 'upstream' | 'downstream';

type NodeIdentity = {
  id: string;
  title: string;
  position: { x: number; y: number };
  selected: boolean;
};

type PlanNode = NodeIdentity & {
  label: string;
  className: string;
};

type ExecutionNode = NodeIdentity & {
  status: string;
  statusLabel: string;
  dependencies: string;
  focused: boolean;
};

type DependencyData = { relation: Relation } | { focused: boolean; vertical: boolean };
type CanvasEdge = { source: string; target: string } & ({ relation: Relation } | { focused: boolean });

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
};

type TaskNode = Node<PlanNode | ExecutionNode, 'task'>;
type DependencyEdge = Edge<DependencyData, 'dependency'>;

const markerColors: Record<Relation, string> = {
  muted: '#869b94',
  upstream: '#4e618b',
  downstream: '#08624e',
};

const TaskCard = memo(function TaskCard({ data, sourcePosition, targetPosition }: NodeProps<TaskNode>) {
  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />
      {'status' in data ? <ExecutionCard data={data} /> : <PlanCard data={data} />}
      <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />
    </>
  );
});

function PlanCard({ data }: { data: PlanNode }) {
  return (
    <button type="button" className={`dev-task ${data.className}`} data-task={data.id}
      data-focus-key={`task-${data.id}`} aria-pressed={data.selected}>
      <span className="dev-task-top"><span>{data.id}</span><span>{data.label}</span></span>
      <span className="dev-task-title">{data.title}</span>
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
      <small>{data.statusLabel}</small>
      <small className="pe-graph-dependencies">依赖：{data.dependencies}</small>
    </button>
  );
}

const Dependency = memo(function Dependency(props: EdgeProps<DependencyEdge>) {
  const { data, source, target, sourceX, sourceY, targetX, targetY, markerEnd } = props;
  const execution = data && 'focused' in data ? data : null;
  const relation = data && 'relation' in data ? data.relation : 'muted';
  // Route the narrow execution graph through a left gutter to keep dependencies clear of cards.
  const path = execution?.vertical ? `M${sourceX},${sourceY} H10 V${targetY} H${targetX}` : getBezierPath(props)[0];
  return (
    <BaseEdge
      className={execution ? 'pe-flow-edge' : `task-edge relation-${relation}`}
      interactionWidth={0}
      markerEnd={markerEnd}
      data-focus={execution?.focused}
      data-from={execution ? source : undefined}
      data-to={execution ? target : undefined}
      path={path}
    />
  );
});

const nodeTypes = { task: TaskCard };
const edgeTypes = { dependency: Dependency };
const proOptions = { hideAttribution: true };

function TaskCanvas({ model }: { model: CanvasModel }) {
  const id = useId();
  const { nodes, edges, width, height, nodeWidth, nodeHeight, vertical, zoom, variant } = model;
  const flowNodes = useMemo<TaskNode[]>(() => nodes.map(node => ({
    id: node.id,
    type: 'task',
    data: node,
    position: node.position,
    width: nodeWidth,
    height: nodeHeight,
    sourcePosition: vertical ? variant === 'execution' ? Position.Left : Position.Bottom : Position.Right,
    targetPosition: vertical && variant !== 'execution' ? Position.Top : Position.Left,
  })), [nodes, nodeWidth, nodeHeight, vertical, variant]);
  const flowEdges = useMemo<DependencyEdge[]>(() => edges.map(edge => {
    const { source, target } = edge;
    const data = 'relation' in edge ? { relation: edge.relation } : { focused: edge.focused, vertical };
    const color = 'relation' in edge ? markerColors[edge.relation] : edge.focused ? markerColors.downstream : '#b5c4bc';
    return {
      id: JSON.stringify([source, target]),
      type: 'dependency',
      source,
      target,
      data,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
    };
  }), [edges, vertical]);

  // Native workspace scrolling owns navigation and focus. Scale the whole flow so its
  // viewport matches the same scroll geometry at desktop and mobile breakpoints.
  return (
    <div className="task-flow-extent" style={{ width, height, transform: `scale(${zoom})` }}>
      <ReactFlow<TaskNode, DependencyEdge>
        id={id}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        preventScrolling={false}
        panOnDrag={false}
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
