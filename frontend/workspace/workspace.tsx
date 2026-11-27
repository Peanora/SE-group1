import { Cable, RefreshCw } from 'lucide-react';
import { WorkspaceDialogs } from './dialogs';
import { ProjectHeading, ProjectLaunch, RunOverview } from './overview';
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

function ProjectSidebar() {
  return (
    <aside className="sidebar" aria-label="项目导航">
      <a className="brand" href="/" aria-label="Taskflow 需求编排台首页">
        <span className="tf-brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span><strong>Taskflow</strong><small>研发工作台</small></span>
      </a>
      <button type="button" className="new-project-button" id="new-project"><span aria-hidden="true">＋</span> 新建项目</button>
      <div className="sidebar-section-title"><span>项目</span><span id="project-count">0</span></div>
      <nav id="project-list" className="project-list" aria-label="项目列表" />
      <div className="sidebar-bottom tf-sidebar-bottom">
        <nav className="tf-settings-links" aria-label="设置">
          <a id="workspace-agent-settings" href="/agent-settings.html" className="sidebar-help"><span className="tf-nav-icon tf-icon-roles" aria-hidden="true" />Agent 角色</a>
          <a id="workspace-api-settings" href="/api-settings.html" className="sidebar-help"><span className="tf-nav-icon tf-icon-api" aria-hidden="true" />API 服务</a>
          <a id="workspace-mcp-settings" href="/factory.html?view=mcp" className="sidebar-help" hidden><Cable aria-hidden="true" size={16} />MCP 工具</a>
        </nav>
        <button type="button" id="help-button" className="sidebar-help"><span className="tf-nav-icon tf-icon-help" aria-hidden="true">?</span>使用说明</button>
      </div>
    </aside>
  );
}

function ProjectTopbar() {
  return (
    <header className="topbar">
      <div className="breadcrumb"><span>工作台</span><span aria-hidden="true">/</span><strong id="breadcrumb-project">新项目</strong></div>
      <div className="topbar-right">
        <a id="team-link" href="/team.html" hidden>团队账号</a>
        <span className="connection-status" id="connection-status" role="status"><span />正在连接服务</span>
        <button type="button" className="icon-button" id="refresh-button" aria-label="刷新工作区" title="刷新工作区">
          <RefreshCw aria-hidden="true" />
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
      <ProjectSidebar />
      <div className="app-shell">
        <ProjectTopbar />
        <main id="main" className="workspace">
          <div id="error-banner" className="error-banner" role="alert" hidden>
            <span id="error-text" />
            <button type="button" id="dismiss-error" aria-label="关闭错误提示">×</button>
          </div>
          <ProjectHeading />
          <ProjectLaunch />
          <RunOverview />
          <WorkAreaNavigation />
          <WorkAreas />
          <details className="workspace-scope">
            <summary>平台范围</summary>
            <p className="field-note" id="platform-default-notice">统一按浏览器网页应用规划。平台提供技术方案，无需填写。</p>
          </details>
        </main>
      </div>
      <WorkspaceDialogs />
    </>
  );
}
