import { BookOpenCheck, ChevronLeft, FileInput, FileStack, GitPullRequest, ListTree, Network, ScrollText, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DeliveryStationTabs } from './delivery-station';

function SurfaceHeader({ title, titleId, icon: Icon, children }: {
  title: string; titleId?: string; icon: LucideIcon; children?: ReactNode;
}) {
  return (
    <header className="studio-surface-header">
      <Icon aria-hidden="true" />
      <h2 id={titleId}>{title}</h2>
      {children}
    </header>
  );
}

function PlanningStages() {
  return (
    <details id="workflow-details" className="studio-stage-details" open>
      <summary><Workflow aria-hidden="true" />规划阶段与产物</summary>
      <div className="studio-stage-columns">
        <div>
          <div id="workflow-graph" className="studio-stage-index" aria-label="规划工作流" />
          <p className="studio-stage-legend" id="workflow-confirmation-legend">先确认规格，再确认计划</p>
        </div>
        <aside id="stage-inspector" className="studio-stage-inspector" tabIndex={-1} aria-label="阶段详情" />
      </div>
      <details className="studio-demo-control">
        <summary>演示选项</summary>
        <label htmlFor="failure-select">注入一次性故障</label>
        <select id="failure-select">
          <option value="">关闭</option><option value="tasks">任务拆解阶段</option>
          <option value="architecture">架构设计阶段</option><option value="review">计划校验阶段</option>
        </select>
        <p>重试该阶段时恢复正常。</p>
      </details>
    </details>
  );
}

function PlanningIssues() {
  return (
    <section id="planning-issue-host" className="planning-issue" aria-labelledby="planning-issue-heading" hidden>
      <h3 id="planning-issue-heading" tabIndex={-1}>查看问题</h3>
      <p data-issue-message />
      <div className="planning-issue-draft" data-issue-draft hidden>
        <h4 data-issue-draft-title /><p data-issue-draft-description />
        <p data-issue-draft-quote-row>模型尝试引用 <q data-issue-draft-quote /></p>
      </div>
      <div className="planning-issue-explanation">
        <p data-issue-explanation hidden />
        <button type="button" className="button button-outline" data-issue-retry hidden>重试生成问题</button>
      </div>
      <details hidden><summary>上次保存的补充</summary><p data-issue-previous /></details>
      <form hidden>
        <ol data-issue-fields />
        <div className="spec-repair-actions">
          <button type="button" className="button button-outline" data-issue-save>保存草稿</button>
          <button type="submit" className="button button-primary" data-issue-continue>提交本轮回答</button>
        </div>
      </form>
      <button type="button" className="button button-primary" data-issue-recover hidden>用已保存的回答重新整理</button>
      <p data-issue-status role="status" />
    </section>
  );
}

export function PlanningPanel() {
  return (
    <section id="workspace-plan" className="workspace-panel studio-surface" data-workspace-panel="plan"
      role="tabpanel" aria-labelledby="workspace-tab-plan" tabIndex={-1} hidden>
      <SurfaceHeader title="规格与计划审阅" titleId="workflow-heading" icon={BookOpenCheck}>
        <span id="workflow-subtitle" />
      </SurfaceHeader>
      <p id="source-history-notice" className="studio-history-notice" role="status" hidden>
        此运行属于历史需求版本。请在当前需求版本重新编排并确认规格和计划。
      </p>
      <PlanningIssues />
      <section id="spec-repair-host" className="spec-repair" aria-labelledby="spec-repair-heading" hidden />
      <div id="review-home">
        <section id="specification-meeting-host" className="specification-meeting" hidden />
        <section id="review-banner" className="review-banner" aria-labelledby="review-heading" hidden />
      </div>
      <PlanningStages />
    </section>
  );
}

const taskViews = [
  { id: 'tasks', tabId: 'records-tab-tasks', title: '模块依赖图', icon: Network },
  { id: 'schedule', tabId: 'tab-schedule', title: '计划清单', icon: ListTree },
  { id: 'artifacts', tabId: 'tab-artifacts', title: '规划文档', icon: FileStack, countId: 'artifact-count' },
  { id: 'events', tabId: 'tab-events', title: '规划事件', icon: ScrollText, countId: 'event-count' },
];

export function TaskPanel() {
  return (
    <section id="workspace-tasks" className="workspace-panel studio-surface" data-workspace-panel="tasks"
      role="tabpanel" aria-labelledby="tab-tasks" tabIndex={-1} hidden>
      <div className="task-view-heading">
        <SurfaceHeader title="开发任务编排" icon={Network}><span id="records-hint" className="visually-hidden">任务依赖与详情</span></SurfaceHeader>
        <nav className="tabs studio-subnav" role="tablist" aria-label="查看运行内容">
          {taskViews.map(({ id, tabId, title, icon: Icon, countId }) => (
            <button key={id} type="button" role="tab" id={tabId} data-tab={id}
              aria-selected={id === 'tasks'} aria-controls="records-body">
              <Icon aria-hidden="true" />{title}{countId && <span id={countId}>0</span>}
            </button>
          ))}
        </nav>
      </div>
      <div id="records-body" className="records-body studio-records" role="tabpanel" aria-labelledby="records-tab-tasks" />
      <details id="simulation-tools" className="studio-simulation">
        <summary>模拟调度实验</summary><div id="simulation-panel-host" className="simulation-panel" hidden />
      </details>
    </section>
  );
}

export function RequirementsPanel() {
  return (
    <section id="workspace-source" className="workspace-panel studio-surface" data-workspace-panel="source"
      role="tabpanel" aria-labelledby="workspace-tab-source" tabIndex={-1} hidden>
      <SurfaceHeader title="需求输入与版本" icon={FileInput}>
        <button type="button" className="studio-back" data-workspace-back><ChevronLeft aria-hidden="true" />返回上一工作区</button>
      </SurfaceHeader>
      <section id="source-changes-section" aria-label="需求变更工作区" hidden><div id="source-changes-host" /></section>
    </section>
  );
}

export function DeliveryPanel() {
  return (
    <section id="workspace-execution" className="workspace-panel studio-surface delivery-station"
      data-workspace-panel="execution" role="tabpanel" aria-labelledby="workspace-tab-execution" tabIndex={-1} hidden>
      <SurfaceHeader title="执行与验收" icon={GitPullRequest} />
      <div className="studio-delivery-layout">
        <DeliveryStationTabs />
        <div id="delivery-pane-overview" data-delivery-pane="overview" role="tabpanel" aria-labelledby="delivery-tab-overview">
          <div id="delivery-overview-host" />
          <nav className="execution-workspace-flow" aria-label="从验收清单到交付">
            <ol id="execution-workspace-steps" /><p id="execution-next-hint" hidden />
          </nav>
        </div>
        <div id="delivery-pane-checklist" data-delivery-pane="checklist" role="tabpanel" aria-labelledby="delivery-tab-checklist" hidden>
          <details id="verification-plans-section" className="workspace-secondary" hidden>
            <summary>准备验收清单</summary><div id="verification-plans-host" />
          </details>
          <p id="verification-plans-unavailable" className="delivery-empty" hidden>当前服务未开放验收清单。</p>
        </div>
        <div id="delivery-pane-candidates" data-delivery-pane="candidates" role="tabpanel" aria-labelledby="delivery-tab-candidates" hidden>
          <section id="planned-execution-section" hidden><div id="planned-execution-host" /></section>
          <p id="planned-execution-unavailable" className="delivery-empty" hidden>当前服务未开放研发执行记录。</p>
        </div>
        <div id="delivery-pane-releases" data-delivery-pane="releases" role="tabpanel" aria-labelledby="delivery-tab-releases" hidden>
          <section id="project-evolution-section" hidden><div id="project-evolution-host" /></section>
          <p id="local-delivery-unavailable" className="delivery-empty" hidden>当前服务未开放本机版本与需求演进。</p>
        </div>
        <div id="delivery-pane-reference" data-delivery-pane="reference" role="tabpanel" aria-labelledby="delivery-tab-reference" hidden>
          <details id="execution-tools" className="workspace-secondary">
            <summary>固定参考执行</summary><div id="execution-panel-host" />
          </details>
        </div>
      </div>
    </section>
  );
}
