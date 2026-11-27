import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { CSSProperties, ReactNode } from 'react';
import './run-evidence.css';

type StageDefinition = {
  id: string;
  title: string;
  dependsOn: string[];
  description: string;
  output: string;
  x: number;
  y: number;
};
type Stage = {
  id: string;
  title: string;
  dependsOn: string[];
  status: string;
  attempt?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};
type StageFailure = {
  message: string;
  detail?: string;
  nextStep?: string;
  canRetry?: boolean;
  pending?: boolean;
  remaining?: number;
  canRevalidate?: boolean;
  attemptId?: string;
  canUseLocal?: boolean;
};
type Run = {
  status: string;
  workflowVersion?: number;
  stages?: Stage[];
  artifacts?: { stageId: string; name: string }[];
  specificationFailure?: StageFailure;
  engineeringFailure?: StageFailure;
};
type WorkflowProps = {
  run?: Run | null;
  stages: StageDefinition[];
  labels: Record<string, string>;
  stageId?: string | null;
  specWaiting: boolean;
};
type InspectorProps = WorkflowProps & {
  stageTitle: (id: string) => string;
  duration: (stage: Stage) => string;
  busy: boolean;
  readOnly: boolean;
};
type EventRecord = { sequence?: number; stageId?: string | null; level: string; time: string; message: string };
type EventProps = {
  events?: EventRecord[];
  stageTitle: (id: string) => string;
  formatTime: (value: string) => string;
};

const markerColors: Record<string, string> = {
  pending: '#a4b4da', running: '#3846ce', succeeded: '#6d9b85', failed: '#b46d62', blocked: '#b46d62',
};
const edges = [
  ['spec', 'M165 149H200'],
  ['architecture', 'M350 149H375V69H400'],
  ['tasks', 'M350 149H375V229H400'],
  ['review', 'M550 69H590V149H620'],
  ['review', 'M550 229H590V149'],
  ['export', 'M770 149H820'],
];
const engineeringStages = new Set(['architecture', 'tasks']);
const eventLevels: Record<string, string> = { success: '成功', error: '失败', warn: '提醒', warning: '提醒', info: '记录' };

function findStage(definition: StageDefinition, run?: Run | null): Stage {
  return run?.stages?.find(stage => stage.id === definition.id) ?? { ...definition, status: 'pending', attempt: 0 };
}

function waitingForStage(id: string, run: Run | null | undefined, specWaiting: boolean) {
  if (id === 'spec' && specWaiting) return '等待补充需求';
  if (id === 'export' && run?.status === 'awaiting_review') return '等待计划确认';
  if (engineeringStages.has(id) && run?.status === 'awaiting_spec') return specWaiting ? '等待补充需求' : '等待规格确认';
  return '';
}

function WorkflowEvidence({ run, stages, labels, stageId, specWaiting }: WorkflowProps) {
  return (
    <>
      <svg className="flow-edges evidence-flow-edges" viewBox="0 0 1000 292" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          {Object.entries(markerColors).map(([status, color]) => (
            <marker key={status} id={`arrow-${status}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0 0L8 4L0 8Z" fill={color} />
            </marker>
          ))}
        </defs>
        {edges.map(([id, path]) => {
          const status = run?.stages?.find(stage => stage.id === id)?.status ?? 'pending';
          const marker = Object.hasOwn(markerColors, status) ? status : 'pending';
          return <path key={path} className={`flow-edge ${status}`} d={path} markerEnd={`url(#arrow-${marker})`} />;
        })}
      </svg>
      {stages.map((definition, index) => {
        const stage = findStage(definition, run);
        const waiting = waitingForStage(stage.id, run, specWaiting);
        const waitingOnQuestions = stage.id === 'spec' && specWaiting;
        const visualStatus = waitingOnQuestions ? 'awaiting_spec' : stage.status;
        const completed = stage.status === 'succeeded' && !waitingOnQuestions;
        const selected = stageId === stage.id;
        const label = waiting || labels[stage.status] || stage.status;
        const position = { '--x': `${definition.x}%`, '--y': `${definition.y}px` } as CSSProperties;
        return (
          <button key={stage.id} type="button"
            className={`flow-node ${visualStatus}${waiting ? ' awaiting-confirmation' : ''}${selected ? ' selected' : ''}`}
            style={position} data-stage={stage.id} data-focus-key={`stage-${stage.id}`}
            aria-pressed={selected} aria-label={`${stage.title}，${label}`}>
            <span className="node-top">
              <span className="node-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="node-status-dot">{completed ? '✓' : ''}</span>
            </span>
            <h3>{stage.title}</h3>
            <span className="node-meta">{label}{(stage.attempt ?? 0) > 1 ? ` / 第 ${stage.attempt} 次` : ''}</span>
          </button>
        );
      })}
    </>
  );
}

function inspectorNote(stage: Stage, run: Run | null | undefined, specWaiting: boolean) {
  if (run?.status === 'awaiting_spec' && (stage.id === 'spec' || engineeringStages.has(stage.id))) {
    return specWaiting ? '打开「查看问题」处理待确认的信息。' : '确认规格后才会生成架构和任务。';
  }
  if (stage.id === 'export' && run?.status === 'awaiting_review') {
    return `检查下方计划后，点击“${run.workflowVersion === 2 ? '确认计划并导出' : '确认并导出'}”继续。`;
  }
  if (stage.status === 'blocked') return '前置阶段尚未成功。解决失败并重试后，编排器会重新检查依赖。';
  if (stage.status === 'succeeded') return '本阶段结果已保存。后续重试会保留成功分支。';
  return '每个阶段成功后发布产物；下游只读取已成功的结果。';
}

function StageEvidence({ run, stages, labels, stageId, specWaiting, stageTitle, duration, busy, readOnly }: InspectorProps) {
  const definition = stages.find(stage => stage.id === stageId) ?? stages[0];
  if (!definition) return null;
  const stage = findStage(definition, run);
  const artifacts = run?.artifacts?.filter(artifact => artifact.stageId === stage.id) ?? [];
  const waitingOnQuestions = stage.id === 'spec' && specWaiting;
  const visualStatus = waitingOnQuestions ? 'awaiting_spec' : stage.status;
  const label = waitingOnQuestions ? '等待补充需求' : labels[stage.status] || stage.status;
  const failure = stage.id === 'spec' ? run?.specificationFailure : engineeringStages.has(stage.id) ? run?.engineeringFailure : undefined;
  const failureDetail = failure?.detail !== failure?.message ? failure?.detail : undefined;
  const failureText = failure ? [failure.message, failureDetail, failure.nextStep].filter(Boolean).join(' ') : stage.error;
  const actionsDisabled = busy || readOnly;
  const retryLabel = failure?.pending ? '前次请求待核对' : failure?.canRetry === false
    ? (failure.remaining === 0 ? '调用次数已用尽' : '工程总时长已用尽') : '重试此阶段';
  return (
    <>
      <div className="inspector-eyebrow">
        <span>阶段详情</span>
        <span className={`status-tag status-${visualStatus}`}>{label}</span>
      </div>
      <h3 className="inspector-title">{stage.title}</h3>
      <p className="inspector-description">{definition.description}</p>
      <dl className="inspector-info">
        <dt>前置依赖</dt><dd>{stage.dependsOn.length ? stage.dependsOn.map(stageTitle).join('、') : '无，可直接启动'}</dd>
        <dt>尝试次数</dt><dd>{stage.attempt || '尚未执行'}</dd>
        <dt>执行用时</dt><dd>{duration(stage)}</dd>
        <dt>输出产物</dt><dd>{waitingOnQuestions ? '等待补充后生成最终规格' : !artifacts.length ? definition.output
          : artifacts.map(artifact => (
            <button key={artifact.name} type="button" className="inspector-artifact-link"
              data-artifact={artifact.name} data-focus-key={`inspector-${artifact.name}`}>{artifact.name}</button>
          ))}</dd>
      </dl>
      {stage.error && (
        <div className="stage-error">
          {failureText}
          {failure?.canRevalidate && (stage.id === 'spec'
            ? <button type="button" className="button button-primary" data-revalidate-spec={failure.attemptId ?? ''} disabled={actionsDisabled}>
                重新校验已保存响应（不调用模型）
              </button>
            : <button type="button" className="button button-primary" data-revalidate-engineering="" disabled={actionsDisabled}>
                重新校验保存的工程草案（不调用模型）
              </button>)}
          {failure?.canUseLocal && <button type="button" className="button button-outline" data-use-local-engineering="" disabled={actionsDisabled}>
            改用本地规则生成架构与任务（不调用模型）
          </button>}
          {run?.status === 'failed' && stage.status === 'failed' && (
            <button type="button" className="button button-outline" data-retry={stage.id} data-focus-key={`retry-${stage.id}`}
              disabled={actionsDisabled || failure?.canRetry === false}>{retryLabel}</button>
          )}
        </div>
      )}
      <p className="inspector-note">{inspectorNote(stage, run, specWaiting)}</p>
    </>
  );
}

function EventEvidence({ events = [], stageTitle, formatTime }: EventProps) {
  if (!events.length) {
    return (
      <div className="empty-records">
        <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="4" width="22" height="25" rx="3" /><path d="M10 11h12M10 17h12M10 23h7" /></svg>
        <strong>每一步都将在这里留下记录</strong>
        <p>开始编排后，查看阶段执行、失败原因与操作结果。</p>
      </div>
    );
  }
  return (
    <ol className="event-list run-event-list" aria-label="执行记录">
      {events.slice(-200).map((event, index) => (
        <li key={event.sequence == null ? `record-${Math.max(0, events.length - 200) + index}` : `sequence-${event.sequence}`} className="event-row">
          <time className="event-time" dateTime={event.time}>{formatTime(event.time)}</time>
          <span className={`event-level ${event.level}`}>{eventLevels[event.level] || eventLevels.info}</span>
          <span className="event-stage">{event.stageId ? stageTitle(event.stageId) : '运行控制'}</span>
          <p className="event-message">{event.message}</p>
        </li>
      ))}
    </ol>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

function update(host: HTMLElement, content: ReactNode) {
  let root = roots.get(host);
  if (!root) {
    root = createRoot(host);
    roots.set(host, root);
  }
  const target = root;
  flushSync(() => target.render(content));
}

export function renderWorkflowEvidence(host: HTMLElement, props: WorkflowProps) {
  update(host, <WorkflowEvidence {...props} />);
}

export function renderStageEvidence(host: HTMLElement, props: InspectorProps) {
  update(host, <StageEvidence {...props} />);
}

export function renderEventEvidence(host: HTMLElement, props: EventProps) {
  const previous = host.querySelector<HTMLElement>('.event-list');
  const left = previous?.scrollLeft ?? 0;
  const top = previous?.scrollTop ?? 0;
  const following = !previous || previous.scrollHeight - top - previous.clientHeight < 45;
  update(host, <EventEvidence {...props} />);
  const list = host.querySelector<HTMLElement>('.event-list');
  if (list) {
    list.scrollLeft = left;
    list.scrollTop = following ? list.scrollHeight : top;
  }
}

export function clearEventEvidence(host: HTMLElement) {
  roots.get(host)?.unmount();
  roots.delete(host);
}
