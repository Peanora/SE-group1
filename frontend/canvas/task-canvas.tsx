import { memo, useId, useMemo, useState, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Bot, CircleCheck, CircleDot, CircleX, ClipboardCheck, Clock3, GitBranch, GitMerge, Globe, Grip, Monitor, Shield, Wrench,
} from 'lucide-react';
import {
  BaseEdge, getBezierPath, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnNodesChange, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/base.css';
import './task-canvas.css';

type Relation = 'muted' | 'upstream' | 'downstream';
type GateState = 'planned' | 'waiting' | 'checking' | 'passed' | 'failed';
type PlanKind = 'agent' | 'tool' | 'review' | 'checkpoint' | 'fork' | 'join';
type PlanRole = 'coding' | 'self' | 'http' | 'browser' | 'review' | 'checkpoint' | 'fork' | 'join';
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
  kind: PlanKind;
  role?: PlanRole;
  roleHelp?: string;
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
type PlanGroup = { rank: number; title: string; top: number; height: number; left: number; width: number; count: number };

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
  variant?: 'execution';
  key?: string;
  onNodeMove?: (id: string, position: XYPosition) => void;
  editing?: boolean;
  onConnect?: (source: string, target: string) => void;
};

type TaskNode = Node<PlanTask | ExecutionNode, 'task'>;
type DependencyEdge = Edge<DependencyData, 'dependency'>;
type Move = { model: CanvasModel; taskId: string; dx: number; dragging: boolean };

const sidePositions: Record<Side, Position> = {
  top: Position.Top, bottom: Position.Bottom, left: Position.Left, right: Position.Right,
};
const markerColors: Record<Relation, string> = {
  muted: '#7685a1',
  upstream: '#197d79',
  downstream: '#3846ce',
};
const roles = {
  agent: { kicker: '编码智能体', icon: Bot },
  tool: { kicker: '工具步骤', icon: Wrench },
  review: { kicker: '审查智能体', icon: ClipboardCheck },
  checkpoint: { kicker: '验收检查点', icon: Shield },
  fork: { kicker: '分叉', icon: GitBranch },
  join: { kicker: '汇合', icon: GitMerge },
};
const toolRoles = {
  self: { kicker: '本地工具', icon: Wrench },
  http: { kicker: '接口工具', icon: Globe },
  browser: { kicker: '网页工具', icon: Monitor },
};
const gatePresentation = {
  planned: { label: '待验收', icon: Shield },
  waiting: { label: '待检查', icon: Clock3 },
  checking: { label: '检查中', icon: CircleDot },
  passed: { label: '通过并集成', icon: CircleCheck },
  failed: { label: '失败，后续阻断', icon: CircleX },
};
const gateHelp = '同一代码版本的自检、独立 HTTP、Edge 和 Review 均通过且完成代码集成后，才释放后续任务。';

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
  const { kind, taskId, selected, editing, movable, gateState = 'planned' } = data;
  const tool = data.role === 'self' || data.role === 'http' || data.role === 'browser' ? toolRoles[data.role] : null;
  const role = tool ?? roles[kind];
  const agent = kind === 'agent';
  const checkpoint = kind === 'checkpoint';
  const junction = kind === 'fork' || kind === 'join';
  const status = checkpoint ? data.gateLabel || gatePresentation[gateState].label
    : agent ? data.label || (gateState !== 'planned' ? data.gateLabel : '') : gateState !== 'planned' ? data.label : '';
  const PartIcon = checkpoint ? gatePresentation[gateState].icon : role.icon;
  const cardTitle = checkpoint ? '' : junction ? data.label : kind === 'review' ? '同版本代码审查' : data.title;
  const detail = agent ? data.meta : '';
  const explanation = checkpoint ? `直接前置：${data.parents.join('、') || '无'}。${gateHelp}` : data.roleHelp;
  const title = [role.kicker, cardTitle, status, data.meta, explanation].filter(Boolean).join(' · ');

  return (
    <div className="plan-task-node" data-movable={agent && movable} data-editing={editing}>
      <button
        type="button"
        className={`task-flow-card ${agent ? 'dev-task ' : ''}${data.className ?? ''}`}
        data-flow-node={data.id}
        data-flow-part={kind}
        data-flow-role={data.role}
        data-owner-task={taskId}
        data-flow-rank={data.rank}
        data-task={agent ? taskId : undefined}
        data-gate-state={gateState}
        data-focus-key={agent ? `task-${taskId}` : `task-flow-${data.id}`}
        aria-pressed={selected}
        aria-description={explanation}
        title={title}
      >
        <span className="task-flow-card-kicker">
          <PartIcon aria-hidden="true" />
          <span>{role.kicker}{agent && <small>{taskId}</small>}</span>
          {agent && movable && <Grip className="dev-task-grip" aria-hidden="true" />}
        </span>
        {cardTitle && <span className={`task-flow-card-title${agent ? ' dev-task-title' : ''}`}>{cardTitle}</span>}
        {(status || detail) && <span className="task-flow-card-meta">
          {status && <span className="task-flow-card-status">{status}</span>}
          {detail && <span className="task-flow-card-detail">{detail}</span>}
        </span>}
      </button>
      {data.inputs.map(side => {
        const eligible = agent && side === 'top';
        return <Handle key={side} id={`input-${side}`} type="target" position={sidePositions[side]}
          isConnectable={eligible && editing} isConnectableStart={false}
          data-task-connector={eligible ? 'input' : undefined} data-owner-task={eligible ? taskId : undefined}
          onPointerDown={eligible ? stopCanvasPan : undefined} />;
      })}
      {data.outputs.map(side => {
        const eligible = checkpoint && side === 'bottom';
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
    path = roundedPath([{ x: sourceX, y: sourceY }, sourceExit, { x: plan.channel, y: sourceExit.y },
      { x: plan.channel, y: targetEntry.y }, targetEntry, { x: targetX, y: targetY }]);
    labelX = plan.channel;
    labelY = (sourceExit.y + targetEntry.y) / 2;
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
  const byTask = new Map<string, PlanNode[]>();
  const parents = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (!('kind' in node)) continue;
    planNodes.set(node.id, node);
    inputs.set(node.id, new Set(node.kind === 'agent' ? ['top'] : []));
    outputs.set(node.id, new Set(node.kind === 'checkpoint' ? ['bottom'] : []));
    const parts = byTask.get(node.taskId);
    if (parts) parts.push(node);
    else byTask.set(node.taskId, [node]);
  }
  for (const edge of edges) {
    if ('focused' in edge) continue;
    outputs.get(edge.source)?.add(edge.sourceSide ?? 'bottom');
    inputs.get(edge.target)?.add(edge.targetSide ?? 'top');
    if (edge.internal) continue;
    const from = edge.fromTask ?? planNodes.get(edge.source)?.taskId;
    const to = edge.toTask ?? planNodes.get(edge.target)?.taskId;
    if (!from || !to) continue;
    const direct = parents.get(to);
    if (direct) direct.add(from);
    else parents.set(to, new Set([from]));
  }
  return { planNodes, inputs, outputs, byTask, parents };
}

function TaskCanvas({ model }: { model: CanvasModel }) {
  const id = useId();
  const { nodes, edges, width, height, nodeWidth, nodeHeight, vertical, zoom, variant, groups } = model;
  const planning = variant !== 'execution';
  const editing = planning && model.editing === true && Boolean(model.onConnect);
  const { planNodes, inputs, outputs, byTask, parents } = useMemo(() => getPlanningData(nodes, edges), [nodes, edges]);
  const [moved, setMoved] = useState<Move>();
  const moving = moved && (moved.model === model || moved.dragging && moved.model.key === model.key) ? moved : undefined;

  const flowNodes = useMemo<TaskNode[]>(() => nodes.map(node => {
    const plan = 'kind' in node ? node : null;
    const canMove = Boolean(plan?.movable && plan.kind === 'agent');
    const movingPart = plan && moving?.taskId === plan.taskId ? moving : undefined;
    return {
      id: node.id,
      type: 'task',
      data: plan ? { ...plan, editing, inputs: [...(inputs.get(node.id) ?? [])],
        outputs: [...(outputs.get(node.id) ?? [])], parents: [...(parents.get(plan.taskId) ?? [])] } : node as ExecutionNode,
      position: movingPart ? { x: node.position.x + movingPart.dx, y: node.position.y } : node.position,
      width: plan?.width ?? nodeWidth,
      height: plan?.height ?? nodeHeight,
      draggable: canMove,
      dragHandle: canMove ? '.dev-task' : undefined,
      zIndex: plan ? movingPart?.dragging ? canMove ? 5 : 4 : plan.selected ? 3 : plan.kind === 'agent' ? 2 : 1 : undefined,
      sourcePosition: vertical ? variant === 'execution' ? Position.Left : Position.Bottom : Position.Right,
      targetPosition: vertical && variant !== 'execution' ? Position.Top : Position.Left,
    };
  }), [nodes, nodeWidth, nodeHeight, vertical, variant, editing, inputs, outputs, parents, moving]);

  const flowEdges = useMemo<DependencyEdge[]>(() => {
    const gateByTask = new Map<string, GateState>();
    const selectedTask = nodes.find(node => 'kind' in node && node.selected) as PlanNode | undefined;
    for (const node of planNodes.values()) {
      if (node.gateState && (node.kind === 'checkpoint' || !gateByTask.has(node.taskId))) gateByTask.set(node.taskId, node.gateState);
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
        sourceHandle: `output-${edge.sourceSide ?? 'bottom'}`, targetHandle: `input-${edge.targetSide ?? 'top'}`,
        data: { ...edge, fromTask, toTask, gateState, motion },
        markerEnd: edge.internal || gateState === 'planned' || gateState === 'passed'
          ? { type: MarkerType.ArrowClosed, width: 11, height: 11, color } : undefined,
      };
    });
  }, [edges, nodes, planNodes, vertical]);

  function clampMotion(node: PlanNode, x: number) {
    const parts = byTask.get(node.taskId) ?? [node];
    const left = Math.min(...parts.map(part => part.position.x));
    const right = Math.max(...parts.map(part => part.position.x + (part.width ?? nodeWidth)));
    return Math.max(12 - left, Math.min(width - 12 - right, x - node.position.x));
  }

  const onNodesChange: OnNodesChange<TaskNode> = changes => {
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue;
      const node = planNodes.get(change.id);
      if (node?.kind !== 'agent' || !node.movable) continue;
      setMoved({ model, taskId: node.taskId, dx: clampMotion(node, change.position.x), dragging: change.dragging === true });
    }
  };

  function canConnect({ source, target, sourceHandle, targetHandle }: Connection | DependencyEdge) {
    const from = planNodes.get(source), to = planNodes.get(target);
    return from?.kind === 'checkpoint' && to?.kind === 'agent' && from.taskId !== to.taskId
      && sourceHandle === 'output-bottom' && targetHandle === 'input-top';
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
            <div className="task-flow-group" data-flow-group={group.rank} key={group.rank}
              style={{ left: group.left, width: group.width, top: group.top, height: group.height }}>
              <div className="task-flow-group-heading"><strong>{group.title}</strong><span>{group.count} 项任务</span></div>
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
          if (original?.kind !== 'agent' || !original.movable) return;
          const dx = clampMotion(original, node.position.x);
          model.onNodeMove?.(original.taskId, { x: original.position.x + dx, y: original.position.y });
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
