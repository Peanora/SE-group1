import { CircleHelp, Plus, RefreshCw, Workflow } from 'lucide-react';
import { WorkspaceDialogs } from './dialogs';
import { ProjectHeading, RunOverview } from './overview';
import { DeliveryPanel, PlanningPanel, RequirementsPanel, TaskPanel } from './panels';

function WorkAreaNavigation() {
  return (
    <nav id="workspace-nav" className="workspace-nav" role="tablist" aria-label="项目工作区" hidden>
      <button type="button" id="workspace-tab-plan" role="tab" data-workspace-view="plan"
        aria-controls="workspace-plan" aria-selected="true">规划与确认</button>
      <button type="button" id="tab-tasks" role="tab" data-workspace-view="tasks"
        aria-controls="workspace-tasks" aria-selected="false">开发任务 <span id="task-count">0</span></button>
      <button type="button" id="workspace-tab-source" role="tab" data-workspace-view="source"
        aria-controls="workspace-source" aria-selected="false">需求与功能</button>
      <button type="button" id="workspace-tab-execution" role="tab" data-workspace-view="execution"
        aria-controls="workspace-execution" aria-selected="false">代码与验收</button>
    </nav>
  );
}

function ProjectStrip() {
  return (
    <aside className="project-strip" aria-label="项目导航">
      <span className="project-strip-label">项目 <span id="project-count">0</span></span>
      <nav id="project-list" className="project-list" aria-label="项目列表" />
      <button type="button" className="new-project-button" id="new-project"><Plus aria-hidden="true" /> 新建项目</button>
    </aside>
  );
}

function ProjectTopbar() {
  return (
    <header className="topbar">
      <a className="workbench-brand" href="/" aria-label="Taskflow 工作台首页"><Workflow aria-hidden="true" /> Taskflow</a>
      <nav className="workbench-links" aria-label="模型设置">
        <a href="/agent-settings.html">Agent 角色</a>
        <a href="/api-settings.html">API 服务</a>
      </nav>
      <div className="topbar-right">
        <a id="team-link" href="/team.html" hidden>团队账号</a>
        <span className="connection-status" id="connection-status" role="status"><span />正在连接服务</span>
        <button type="button" className="icon-button" id="refresh-button" aria-label="刷新工作区" title="刷新工作区">
          <RefreshCw aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" id="help-button" aria-label="使用说明" title="使用说明">
          <CircleHelp aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function WorkAreas() {
  return (
    <div id="workspace-panels" className="workspace-panels" hidden>
      <PlanningPanel />
      <TaskPanel />
      <RequirementsPanel />
      <DeliveryPanel />
    </div>
  );
}

export function Workspace() {
  return (
    <>
      <a className="skip-link" href="#main">跳到工作区</a>
      <div className="app-shell">
        <ProjectTopbar />
        <ProjectStrip />
        <main id="main" className="workspace">
          <div id="error-banner" className="error-banner" role="alert" hidden>
            <span id="error-text" />
            <button type="button" id="dismiss-error" aria-label="关闭错误提示">×</button>
          </div>
          <ProjectHeading />
          <RunOverview />
          <WorkAreaNavigation />
          <WorkAreas />
        </main>
      </div>
      <WorkspaceDialogs />
    </>
  );
}
