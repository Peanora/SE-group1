import { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { executionVersionEvidence } from '../../public/planned-execution.js';
import './run-trace.css';

type Approval = { revision?: string; at?: string; feedback?: string };
type Decision = Approval & { action: string; newRevision?: string };
type PlanningEvent = { sequence?: number; time?: string; level?: string; stageId?: string | null; message: string };
type Run = {
  id: string;
  workflowVersion?: number;
  sourceRevision?: string;
  sourceGeneration?: number;
  specRevision?: string;
  planRevision?: string;
  approvals?: { spec?: Approval | null; plan?: (Approval & { specRevision?: string }) | null };
  events?: PlanningEvent[];
  decisions?: Decision[];
};
type ExecutionEvent = {
  sequence?: number; at?: string; status?: string; type?: string; message: string;
  taskId?: string; attemptId?: string; candidateCommit?: string;
};
type Check = { passed?: boolean };
type Issue = { severity?: string; status?: string };
type Checks = { self?: Check[]; http?: Check[]; browser?: Check[]; review?: string | null; issues?: Issue[] };
type TaskAttempt = { attemptId?: string | null; candidateCommit?: string | null; status?: string; errorCode?: string | null };
type Execution = {
  id: string; projectId: string; runId: string; kind: string;
  current?: boolean;
  binding?: { planRevision?: string };
  events?: ExecutionEvent[];
  tasks?: (TaskAttempt & { id: string; title?: string; history?: TaskAttempt[] })[];
};
type Candidate = {
  taskId?: string; attemptId?: string; candidateCommit: string; checks?: Checks | null; status?: string;
  review?: { status?: string; issues?: Issue[]; summary?: string | null };
};
type TraceProps = {
  projectId?: string | null;
  run?: Run | null;
  executions?: Execution[];
  historical?: boolean;
  executionAvailable?: boolean;
  stageTitle: (id: string) => string;
  formatTime: (value: string, full?: boolean) => string;
};
type Origin = 'planning' | 'decision' | 'execution';
type Entry = {
  id: string;
  origin: Origin;
  title: string;
  at?: string;
  failed?: boolean;
  detail?: string;
  stageId?: string | null;
  executionId?: string;
  historicalExecution?: boolean;
  taskId?: string;
  attemptId?: string;
  revision?: string;
  commit?: string;
  candidate?: boolean;
};

const originNames: Record<Origin, string> = { planning: '规划过程', decision: '确认与修订', execution: '开发与验收' };
const decisions: Record<string, string> = {
  approve_spec: '确认规格', reject_spec: '退回规格', revise_spec: '修订规格',
  approve_plan: '确认计划', reject_plan: '退回计划', revise_plan: '修订计划',
  revise_route_roles: '修订接口职责', revise_route_contracts: '修订接口输入输出',
  clarify_spec: '补充规格信息', answer_planning_issue: '保存问题答复', supplement_spec: '补充规格资料',
  use_local_engineering: '改用本地规则生成计划', use_platform_defaults: '采用平台默认方案',
};
const attemptStates: Record<string, string> = {
  failed: '失败', stopped: '已停止', timed_out: '已超时', reconciliation_required: '待核对',
  rejected: '已退回', completed: '已完成', verified: '已验收', running: '执行中',
};
const reviewStates: Record<string, string> = {
  checking: '进行中', not_started: '未开始', completed: '已完成', changes_requested: '需修订',
  failed: '失败', error: '出错', reconciliation_required: '待核对',
};
const failedStatuses = new Set(['failed', 'stopped', 'timed_out', 'reconciliation_required', 'rejected']);
const failedEventTypes = new Set(['automatic_rework_blocked', 'automatic_rework', 'integration_rework', 'integration_rework_requested']);
const pageSize = 40;

function short(value: string) {
  return value.slice(0, 10);
}

function checkSummary(name: string, checks?: Check[]) {
  if (!checks?.length) return `${name}未记录结果`;
  const passed = checks.filter(check => check.passed === true).length;
  const failed = checks.filter(check => check.passed === false).length;
  return `${name} ${passed}/${checks.length} 通过${failed ? `，${failed} 项失败` : passed !== checks.length ? '，有待核对项' : ''}`;
}

function executionEntries(execution: Execution): Entry[] {
  const prefix = {
    origin: 'execution' as const, executionId: execution.id, revision: execution.binding?.planRevision,
    historicalExecution: execution.current === false,
  };
  const entries: Entry[] = (execution.events ?? []).filter(event => event.message).map((event, index) => ({
    ...prefix, id: `${execution.id}-event-${index}`, title: event.message, at: event.at,
    taskId: event.taskId, attemptId: event.attemptId, commit: event.candidateCommit,
    failed: failedStatuses.has(event.status ?? '') || failedEventTypes.has(event.type ?? ''),
  }));
  const versions: Candidate[] = executionVersionEvidence(execution);
  for (const version of versions) {
    const checks = version.checks;
    const reviewStatus = version.review?.status ?? checks?.review;
    const blockers = (version.review?.issues ?? checks?.issues ?? [])
      .filter(issue => issue.severity === 'blocking' && issue.status !== 'resolved').length;
    const testFailed = [checks?.self, checks?.http, checks?.browser].some(rows => rows?.some(check => check.passed === false));
    const review = reviewStatus ? `代码审查${reviewStates[reviewStatus] ?? '状态待核对'}${blockers ? `，${blockers} 项阻塞` : ''}` : '代码审查未记录';
    const detail = [
      checks?.self?.length && checkSummary('自检', checks.self),
      checkSummary('接口', checks?.http),
      checkSummary('浏览器', checks?.browser),
      review,
      version.review?.summary,
    ].filter(Boolean).join('。');
    entries.push({
      ...prefix, id: JSON.stringify([execution.id, 'candidate', version.taskId, version.attemptId, version.candidateCommit]),
      title: version.taskId ? `${version.taskId} 的候选与检查` : '项目候选与检查',
      taskId: version.taskId, attemptId: version.attemptId, commit: version.candidateCommit, detail,
      candidate: true,
      failed: testFailed || blockers > 0 || failedStatuses.has(version.status ?? '') ||
        ['changes_requested', 'failed', 'error', 'reconciliation_required'].includes(reviewStatus ?? ''),
    });
  }
  const candidates = new Set(versions.map(version => JSON.stringify([version.taskId, version.attemptId])));
  for (const task of execution.tasks ?? []) {
    // Keep distinct task attempts, including those that failed before a commit was saved.
    const recorded = new Set<string>();
    for (const attempt of [task, ...(task.history ?? [])]) {
      const id = attempt.attemptId;
      if (!id || recorded.has(id) || candidates.has(JSON.stringify([task.id, id]))) continue;
      recorded.add(id);
      entries.push({
        ...prefix, id: JSON.stringify([execution.id, 'attempt', task.id, id]),
        title: `${task.title || task.id}的任务尝试`,
        taskId: task.id, attemptId: id, commit: attempt.candidateCommit ?? undefined,
        detail: [attemptStates[attempt.status ?? ''] ?? '已记录', attempt.errorCode].filter(Boolean).join(' · '),
        failed: failedStatuses.has(attempt.status ?? ''),
      });
    }
  }
  return entries;
}

function traceEntries(projectId: string | null | undefined, run: Run | null | undefined, executions?: Execution[]) {
  if (!run) return [];
  const records: Entry[] = (run.events ?? []).filter(event => event.message).map((event, index) => ({
    id: `planning-${event.sequence ?? 'record'}-${index}`, origin: 'planning', title: event.message,
    at: event.time, stageId: event.stageId, failed: event.level === 'error',
  }));
  const recordedApprovals = new Set<string>();
  function decisionEntry(decision: Decision, id: string): Entry {
    return {
      id, origin: 'decision', title: decisions[decision.action] ?? '审阅操作',
      at: decision.at, revision: decision.revision,
      detail: [decision.newRevision && `修订版本 ${short(decision.newRevision)}`, decision.feedback].filter(Boolean).join('。'),
      failed: decision.action === 'reject_spec' || decision.action === 'reject_plan',
    };
  }
  for (const [index, decision] of (run.decisions ?? []).entries()) {
    recordedApprovals.add(JSON.stringify([decision.action, decision.revision, decision.at]));
    records.push(decisionEntry(decision, `decision-${index}`));
  }
  for (const kind of ['spec', 'plan'] as const) {
    const approval = run.approvals?.[kind];
    const action = `approve_${kind}`;
    if (approval?.revision && !recordedApprovals.has(JSON.stringify([action, approval.revision, approval.at]))) {
      records.push(decisionEntry({ action, ...approval }, action));
    }
  }
  for (const execution of executions ?? []) {
    if (execution.projectId !== projectId || execution.runId !== run.id || execution.kind !== 'planned_web') continue;
    records.push(...executionEntries(execution));
  }
  return records.map(entry => {
    const time = entry.at ? Date.parse(entry.at) : NaN;
    return { ...entry, at: Number.isFinite(time) ? entry.at : undefined, time: Number.isFinite(time) ? time : -Infinity };
  }).sort((a, b) => b.time === a.time ? 0 : b.time - a.time);
}

function TraceList({ rows, stageTitle, formatTime }: {
  rows: Entry[]; stageTitle: TraceProps['stageTitle']; formatTime: TraceProps['formatTime'];
}) {
  return (
    <ol className="run-trace-list">
      {rows.map(entry => (
        <li className="run-trace-row" key={entry.id} data-trace-origin={entry.origin} data-trace-failed={entry.failed || undefined}>
          <span className="run-trace-clock">
            {entry.at ? <time dateTime={entry.at} title={entry.at}>{formatTime(entry.at, true).split(' ')[0]} {formatTime(entry.at)}</time> : '时间未记录'}
          </span>
          <div className="run-trace-record">
            <span className="run-trace-origin">{originNames[entry.origin]}</span>
            {entry.failed && <span className="run-trace-failure">异常</span>}
            <p>{entry.title}</p>
            {entry.detail && <p className="run-trace-detail">{entry.detail}</p>}
            <div className="run-trace-references">
              {entry.stageId && <button type="button" data-trace-stage={entry.stageId}>{stageTitle(entry.stageId)}</button>}
              {entry.executionId && (
                <button type="button" data-trace-candidates={entry.executionId} data-trace-commit={entry.candidate ? entry.commit : undefined}
                  data-trace-task={entry.taskId} data-trace-attempt={entry.attemptId}>
                  {entry.candidate ? '查看候选证据' : `开发记录 ${short(entry.executionId)}`}
                </button>
              )}
              {entry.historicalExecution && <span>历史开发记录</span>}
              {entry.revision && <span title={entry.revision}>{entry.origin === 'execution' ? '计划' : '版本'} <code>{short(entry.revision)}</code></span>}
              {entry.commit && <span title={entry.commit}>提交 <code>{short(entry.commit)}</code></span>}
              {entry.attemptId && <span title={entry.attemptId}>尝试 <code>{short(entry.attemptId)}</code></span>}
              {entry.taskId && <span>任务 <code>{entry.taskId}</code></span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function TraceSection({ title, rows, stageTitle, formatTime }: {
  title: string; rows: Entry[]; stageTitle: TraceProps['stageTitle']; formatTime: TraceProps['formatTime'];
}) {
  const [limit, setLimit] = useState(pageSize);
  if (!rows.length) return null;
  return (
    <section className="run-trace-stream">
      <h3>{title} <span>{rows.length} 条</span></h3>
      <TraceList rows={rows.slice(0, limit)} stageTitle={stageTitle} formatTime={formatTime} />
      {rows.length > limit && <button type="button" className="run-trace-more" onClick={() => setLimit(value => value + pageSize)}>显示更多记录</button>}
    </section>
  );
}

function RunTrace({ projectId, run, executions, historical, executionAvailable, stageTitle, formatTime }: TraceProps) {
  const [origin, setOrigin] = useState<Origin | 'all'>('all');
  const [failedOnly, setFailedOnly] = useState(false);
  const entries = useMemo(() => traceEntries(projectId, run, executions), [projectId, run, executions]);
  if (!run) return <p className="run-trace-empty">开始一次编排后，可以回查对应的规划与开发记录。</p>;
  const filtered = entries.filter(entry => (origin === 'all' || entry.origin === origin) && (!failedOnly || entry.failed));
  const source = run.sourceRevision && short(run.sourceRevision);
  const spec = run.specRevision && short(run.specRevision);
  const plan = run.planRevision && short(run.planRevision);
  const specConfirmed = !!spec && run.approvals?.spec?.revision === run.specRevision;
  const planConfirmed = !!plan && specConfirmed && run.approvals?.plan?.revision === run.planRevision &&
    run.approvals?.plan?.specRevision === run.specRevision;
  const scope = historical ? '历史需求 · 只读' : run.workflowVersion === 2 ? '当前需求' : '旧版规划记录';
  const executionNote = executionAvailable === false ? '当前服务未提供开发记录。' : !executions ? '等待核对开发记录。' :
    executions.length === 0 ? '本次运行暂无开发记录。' : '';
  return (
    <section className="run-trace" aria-labelledby="run-trace-heading">
      <header className="run-trace-head">
        <div>
          <h2 id="run-trace-heading">运行复盘</h2>
          <p>按时间核对状态、审阅决定和开发证据。</p>
        </div>
        <div className="run-trace-binding">
          <code title={run.id}>{short(run.id)}</code>
          <span>{scope}</span>
        </div>
      </header>
      <dl className="run-trace-versions">
        <div><dt>需求快照</dt><dd title={run.sourceRevision}>{source || '未记录'}</dd></div>
        <div><dt>规格{specConfirmed ? ' · 已确认' : ''}</dt><dd title={run.specRevision}>{spec || '未记录'}</dd></div>
        <div><dt>开发计划{planConfirmed ? ' · 已确认' : ''}</dt><dd title={run.planRevision}>{plan || '未记录'}</dd></div>
      </dl>
      <div className="run-trace-filters">
        <label>记录来源
          <select value={origin} onChange={event => setOrigin(event.target.value as Origin | 'all')}>
            <option value="all">全部来源</option>
            {Object.entries(originNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={failedOnly} onChange={event => setFailedOnly(event.target.checked)} /> 仅异常</label>
        <span className="run-trace-count">{filtered.length} 条记录</span>
      </div>
      {(origin === 'all' || origin === 'execution') && executionNote && <p className="run-trace-notice">{executionNote}</p>}
      {!filtered.length && <p className="run-trace-empty">{entries.length ? '没有符合筛选条件的记录。' : '本次运行暂无可回查记录。'}</p>}
      <TraceSection key={`timeline-${origin}-${failedOnly}`} title="时间线" rows={filtered.filter(entry => entry.at)} stageTitle={stageTitle} formatTime={formatTime} />
      <TraceSection key={`undated-${origin}-${failedOnly}`} title="时间未记录的证据" rows={filtered.filter(entry => !entry.at)} stageTitle={stageTitle} formatTime={formatTime} />
    </section>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

export function renderRunTrace(host: HTMLElement, props: TraceProps) {
  let root = roots.get(host);
  if (!root) {
    root = createRoot(host);
    roots.set(host, root);
  }
  flushSync(() => root?.render(<RunTrace key={JSON.stringify([props.projectId, props.run?.id])} {...props} />));
}
