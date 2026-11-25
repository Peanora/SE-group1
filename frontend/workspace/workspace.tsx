import { Blocks, Cable, CircleHelp, FileText, FolderOpen, GitBranch, ListChecks, Plus, RefreshCw, Workflow } from 'lucide-react';
import { Button } from '../components/button';
import { WorkspaceDialogs } from './dialogs';
import { ProjectHeading, ProjectLaunch, RunRail } from './overview';
import { DeliveryPanel, PlanningPanel, RequirementsPanel, TaskPanel } from './panels';

function WorkAreaNavigation() {
  return (
    <nav id="workspace-nav" className="workspace-nav" role="tablist" aria-label="项目工作区" hidden>
      <button type="button" id="workspace-tab-source" role="tab" data-workspace-view="source"
        aria-controls="workspace-source" aria-selected="false"><FileText aria-hidden="true" />需求与功能</button>
      <button type="button" id="workspace-tab-plan" role="tab" data-workspace-view="plan"
        aria-controls="workspace-plan" aria-selected="true"><Workflow aria-hidden="true" />规划与确认</button>
      <button type="button" id="tab-tasks" role="tab" data-workspace-view="tasks"
        aria-controls="workspace-tasks" aria-selected="false"><GitBranch aria-hidden="true" />开发任务 <span id="task-count">0</span></button>
      <button type="button" id="workspace-tab-execution" role="tab" data-workspace-view="execution"
        aria-controls="workspace-execution" aria-selected="false"><ListChecks aria-hidden="true" />代码与验收</button>
    </nav>
  );
}

function CommandBar() {
  return (
    <header className="command-bar">
      <a className="command-brand" href="/" aria-label="Taskflow 研发工作台首页">
        <img src="/taskflow.svg" width="27" height="27" alt="" /><strong>Taskflow</strong>
      </a>
      <WorkAreaNavigation />
      <nav className="command-tools" aria-label="工作台工具">
        <a href="/agent-settings.html"><Blocks aria-hidden="true" />Agent 角色</a>
        <a href="/api-settings.html"><Cable aria-hidden="true" />API 服务</a>
        <a id="team-link" href="/team.html" hidden>团队账号</a>
        <button type="button" id="help-button" className="command-icon" aria-label="使用说明" title="使用说明">
          <CircleHelp aria-hidden="true" />
        </button>
      </nav>
    </header>
  );
}

function ProjectTabs() {
  return (
    <section className="project-dock" aria-label="项目导航">
      <span className="project-dock-label"><FolderOpen aria-hidden="true" />项目 <span id="project-count">0</span></span>
      <nav id="project-list" className="project-list" aria-label="项目列表" />
      <Button variant="outline" id="new-project"><Plus aria-hidden="true" />新建项目</Button>
    </section>
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
      <CommandBar />
      <main id="main" className="workspace">
        <div id="error-banner" className="error-banner" role="alert" hidden>
          <span id="error-text" />
          <button type="button" id="dismiss-error" aria-label="关闭错误提示">×</button>
        </div>
        <ProjectTabs />
        <div className="project-location">
          <div className="project-crumb"><span>项目</span><span aria-hidden="true">/</span><strong id="breadcrumb-project">新项目</strong></div>
          <div className="project-connection">
            <span className="connection-status" id="connection-status" role="status"><span />正在连接服务</span>
            <button type="button" className="command-icon" id="refresh-button" aria-label="刷新工作区" title="刷新工作区">
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </div>
        <ProjectHeading />
        <ProjectLaunch />
        <div className="workstation">
          <div className="workstation-core">
            <WorkAreas />
          </div>
          <RunRail />
        </div>
        <details className="workspace-scope">
          <summary>平台范围</summary>
          <p className="field-note" id="platform-default-notice">统一按浏览器网页应用规划。平台提供技术方案，无需填写。</p>
        </details>
      </main>
      <WorkspaceDialogs />
    </>
  );
}
