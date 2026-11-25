import { Cable, CircleHelp, GitBranch, ListChecks, Plus, RefreshCw, Blocks, FileText, Workflow } from 'lucide-react';
import { Button } from '../components/button';
import { WorkspaceDialogs } from './dialogs';
import { RunOverview } from './overview';
import { DeliveryPanel, PlanningPanel, RequirementsPanel, TaskPanel } from './panels';

function ProjectRail() {
  return (
    <aside className="sidebar" aria-label="项目导航">
      <a className="brand" href="/" aria-label="Taskflow 研发工作台首页">
        <img className="brand-mark" src="/taskflow.svg" width="36" height="36" alt="" />
        <span><strong>Taskflow</strong><small>软件研发工作台</small></span>
      </a>
      <Button className="new-project-button" id="new-project"><Plus aria-hidden="true" />新建项目</Button>
      <div className="sidebar-section-title"><span>项目</span><span id="project-count">0</span></div>
      <nav id="project-list" className="project-list" aria-label="项目列表" />
      <div className="sidebar-bottom tf-sidebar-bottom">
        <nav className="tf-settings-links" aria-label="模型设置">
          <a href="/agent-settings.html" className="sidebar-help"><Blocks aria-hidden="true" />Agent 角色</a>
          <a href="/api-settings.html" className="sidebar-help"><Cable aria-hidden="true" />API 服务</a>
        </nav>
        <button type="button" id="help-button" className="sidebar-help"><CircleHelp aria-hidden="true" />使用说明</button>
      </div>
    </aside>
  );
}

function Toolbar() {
  return (
    <header className="topbar">
      <div className="breadcrumb"><span>项目</span><span aria-hidden="true">/</span><strong id="breadcrumb-project">新项目</strong></div>
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
    <>
      <nav id="workspace-nav" className="workspace-nav" role="tablist" aria-label="项目工作区" hidden>
        <button type="button" id="workspace-tab-plan" role="tab" data-workspace-view="plan"
          aria-controls="workspace-plan" aria-selected="true"><Workflow aria-hidden="true" />规划与确认</button>
        <button type="button" id="tab-tasks" role="tab" data-workspace-view="tasks"
          aria-controls="workspace-tasks" aria-selected="false"><GitBranch aria-hidden="true" />开发任务 <span id="task-count">0</span></button>
        <button type="button" id="workspace-tab-source" role="tab" data-workspace-view="source"
          aria-controls="workspace-source" aria-selected="false"><FileText aria-hidden="true" />需求与功能</button>
        <button type="button" id="workspace-tab-execution" role="tab" data-workspace-view="execution"
          aria-controls="workspace-execution" aria-selected="false"><ListChecks aria-hidden="true" />代码与验收</button>
      </nav>
      <div id="workspace-panels" className="workspace-panels" hidden>
        <PlanningPanel />
        <TaskPanel />
        <RequirementsPanel />
        <DeliveryPanel />
      </div>
    </>
  );
}

export function Workspace() {
  return (
    <>
      <a className="skip-link" href="#main">跳到工作区</a>
      <ProjectRail />
      <div className="app-shell">
        <Toolbar />
        <main id="main" className="workspace">
          <div id="error-banner" className="error-banner" role="alert" hidden>
            <span id="error-text" />
            <button type="button" id="dismiss-error" aria-label="关闭错误提示">×</button>
          </div>
          <RunOverview />
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
