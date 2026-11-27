import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { Blocks, CheckCheck, ClipboardList, FileInput, FileOutput, FilePenLine, ListChecks, ScrollText } from 'lucide-react';
import './run-evidence.css';

type StageDefinition = {
  id: string;
  title: string;
  dependsOn: string[];
  description: string;
  output: string;
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

const stageIcons = { intake: FileInput, spec: FilePenLine, architecture: Blocks, tasks: ClipboardList, review: ListChecks, export: FileOutput };
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
    <ol className="studio-stage-sequence" onClick={event => {
      if (event.detail > 0 && (event.target as Element).closest('[data-stage]') && window.matchMedia('(max-width: 720px)').matches) {
        requestAnimationFrame(() => document.getElementById('stage-inspector')?.focus());
      }
    }}>
      {stages.map(definition => {
        const stage = findStage(definition, run);
        const waiting = waitingForStage(stage.id, run, specWaiting);
        const visualStatus = stage.id === 'spec' && specWaiting ? 'awaiting_spec' : stage.status;
        const label = waiting || labels[stage.status] || stage.status;
        const Icon = stageIcons[stage.id as keyof typeof stageIcons] ?? FilePenLine;
        const dependencies = stage.dependsOn.map(id => run?.stages?.find(item => item.id === id)?.title
          ?? stages.find(item => item.id === id)?.title ?? id);
        return (
          <li key={stage.id}>
            <button type="button" className={`studio-stage-row ${visualStatus}${waiting ? ' awaiting-confirmation' : ''}`}
              data-stage={stage.id} data-focus-key={`stage-${stage.id}`} aria-pressed={stageId === stage.id}
              aria-label={`${stage.title}，${label}`}>
              <span className="studio-stage-symbol"><Icon aria-hidden="true" /></span>
              <span className="studio-stage-name"><strong>{stage.title}</strong>
                <small>{dependencies.length ? `前置 · ${dependencies.join('、')}` : '流程起点'}</small>
              </span>
              <span className="node-meta">{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
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
  return '阶段成功后发布产物，下游可读取已发布的结果。';
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
      <div className="studio-inspector-meta">
        <span><ScrollText aria-hidden="true" />阶段详情</span>
        <span className={`status-tag status-${visualStatus}`}>{label}</span>
      </div>
      <h3 className="inspector-title">{stage.title}</h3>
      <p className="inspector-description">{definition.description}</p>
      <dl className="inspector-info">
        <dt>前置依赖</dt><dd>{stage.dependsOn.length ? stage.dependsOn.map(stageTitle).join('、') : '无，可直接启动'}</dd>
        <dt>尝试次数</dt><dd>{stage.attempt || '尚未执行'}</dd>
        <dt>执行用时</dt><dd>{duration(stage)}</dd>
        <dt>{artifacts.length ? '已存产物' : '预计产物'}</dt><dd>{waitingOnQuestions ? '等待补充后生成最终规格' : !artifacts.length ? definition.output
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
      <button type="button" className="studio-return-stage"
        onClick={() => document.querySelector<HTMLElement>('#workflow-graph [aria-pressed="true"]')?.focus()}>
        返回阶段列表
      </button>
    </>
  );
}

function EventEvidence({ events = [], stageTitle, formatTime }: EventProps) {
  if (!events.length) {
    return (
      <div className="empty-records">
        <CheckCheck aria-hidden="true" />
        <strong>暂无规划事件</strong>
        <p>启动规划后可查看各阶段的操作和结果。</p>
      </div>
    );
  }
  return (
    <ol className="event-list run-event-list" aria-label="规划事件">
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
