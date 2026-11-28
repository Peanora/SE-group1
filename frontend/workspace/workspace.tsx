import {
  Activity, Cable, ChevronDown, CircleHelp, ClipboardCheck, FileText, FolderOpen,
  GitBranch, Plus, RefreshCw, Settings2, ShieldCheck, Workflow,
} from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { WorkspaceDialogs } from './dialogs';
import { ProjectHeading, RunInspector, RunOverview } from './overview';
import { DeliveryPanel, PlanningPanel, RequirementsPanel, TaskPanel } from './panels';

const views = [
  { id: 'source', label: '需求版本', icon: FileText },
  { id: 'plan', label: '规格与计划', icon: ClipboardCheck },
  { id: 'tasks', label: '任务编排', icon: GitBranch },
  { id: 'execution', label: '执行验收', icon: ShieldCheck },
  { id: 'trace', label: '运行复盘', icon: Activity },
];

function WorkAreaNavigation() {
  return (
    <nav id="workspace-nav" className="workspace-nav studio-views" role="tablist" aria-label="项目工作区" hidden>
      {views.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" id={id === 'tasks' ? 'tab-tasks' : 'workspace-tab-' + id}
          role="tab" data-workspace-view={id} aria-controls={'workspace-' + id}
          aria-selected={id === 'source'} tabIndex={id === 'source' ? 0 : -1}>
          <Icon size={16} aria-hidden="true" />
          {label}
          {id === 'tasks' && <span id="task-count">0</span>}
        </button>
      ))}
    </nav>
  );
}

type TopMenuProps = {
  triggerId: string;
  className: string;
  label: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
};

function TopMenu({ triggerId, className, label, ariaLabel, children }: TopMenuProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);

  useEffect(() => {
    function dismissOutside(event: PointerEvent) {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    }
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, []);

  return (
    <details ref={menu} className={'studio-menu ' + className} onKeyDown={event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.open = false;
      trigger.current?.focus();
    }}>
      <summary ref={trigger} id={triggerId} aria-label={ariaLabel}>{label}</summary>
      <div className="studio-popover" onClick={event => {
        const selected = (event.target as Element).closest('a[href], button:not([data-delete-project])');
        if (!selected || !menu.current) return;
        menu.current.open = false;
        if (selected.hasAttribute('data-project')) trigger.current?.focus();
      }}>{children}</div>
    </details>
  );
}

function ProjectTopbar() {
  return (
    <header className="studio-appbar">
      <div className="studio-appbar-inner">
        <a className="studio-brand" href="/" aria-label="Taskflow 研发工作台首页">
          <span className="studio-brand-mark"><Workflow size={17} aria-hidden="true" /></span>
          <strong>Taskflow</strong>
        </a>
        <TopMenu triggerId="project-menu-trigger" className="studio-project-menu" label={<>
          <FolderOpen size={17} aria-hidden="true" />
          <strong id="breadcrumb-project">新项目</strong>
          <ChevronDown size={14} aria-hidden="true" />
        </>}>
          <div className="studio-popover-heading">项目 <span id="project-count">0</span></div>
          <nav id="project-list" className="project-list" aria-label="项目列表" />
        </TopMenu>
        <button type="button" className="studio-new-project" id="new-project">
          <Plus size={17} aria-hidden="true" /><span>新建项目</span>
        </button>
        <div className="studio-appbar-tools">
          <span className="connection-status studio-connection" id="connection-status" role="status"><span />正在连接服务</span>
          <a id="team-link" className="studio-account" href="/team.html" hidden>团队账号</a>
          <button type="button" className="studio-tool-button" id="refresh-button" aria-label="刷新工作区" title="刷新工作区">
            <RefreshCw size={17} aria-hidden="true" />
          </button>
          <TopMenu triggerId="settings-menu-trigger" className="studio-settings-menu" ariaLabel="设置" label={<>
            <Settings2 size={17} aria-hidden="true" /><span>设置</span>
          </>}>
            <nav className="studio-settings-links" aria-label="设置">
              <a id="workspace-agent-settings" href="/agent-settings.html"><GitBranch size={16} aria-hidden="true" />Agent 角色</a>
              <a id="workspace-api-settings" href="/api-settings.html"><Settings2 size={16} aria-hidden="true" />API 服务</a>
              <a id="workspace-mcp-settings" href="/factory.html?view=mcp" hidden><Cable size={16} aria-hidden="true" />MCP 工具</a>
              <button type="button" id="help-button"><CircleHelp size={16} aria-hidden="true" />使用说明</button>
            </nav>
          </TopMenu>
        </div>
      </div>
    </header>
  );
}

function WorkAreas() {
  return (
    <div id="workspace-panels" className="workspace-panels studio-panels" hidden>
      <RequirementsPanel />
      <PlanningPanel />
      <TaskPanel />
      <DeliveryPanel />
      <section id="workspace-trace" className="workspace-panel studio-trace" data-workspace-panel="trace"
        role="tabpanel" aria-labelledby="workspace-tab-trace" tabIndex={-1} hidden>
        <div id="studio-trace-host" />
      </section>
    </div>
  );
}

export function Workspace() {
  return (
    <>
      <a className="skip-link" href="#main">跳到工作区</a>
      <div className="app-shell studio-app">
        <ProjectTopbar />
        <main id="main" className="workspace studio-main" tabIndex={-1}>
          <div id="error-banner" className="error-banner" role="alert" hidden>
            <span id="error-text" />
            <button type="button" id="dismiss-error" aria-label="关闭错误提示">×</button>
          </div>
          <ProjectHeading />
          <div id="workspace-run-summary" className="studio-run-summary">
            <RunOverview />
            <RunInspector />
          </div>
          <WorkAreaNavigation />
          <WorkAreas />
          <details className="workspace-scope studio-scope">
            <summary>平台范围</summary>
            <p className="field-note" id="platform-default-notice">统一按浏览器网页应用规划。平台提供技术方案，无需填写。</p>
          </details>
        </main>
      </div>
      <WorkspaceDialogs />
    </>
  );
}
