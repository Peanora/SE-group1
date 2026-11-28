import {
  ArrowUpRight, ChevronDown, CircleDot, FileUp, GitBranch, History, Play,
  Settings2, Workflow,
} from 'lucide-react';
import { Button } from '../components/button';
import { NextStepPanel } from './tree-nav';

export function ProjectHeading() {
  return (
    <section className="workspace-heading studio-heading" aria-labelledby="project-title">
      <div className="studio-project-heading">
        <div className="studio-project-mark"><Workflow size={22} aria-hidden="true" /></div>
        <div>
          <h1 id="project-title">需求编排工作台</h1>
          <p id="project-description" className="page-description">从需求规划到开发验收。</p>
        </div>
      </div>
      <div className="heading-actions studio-heading-tools">
        <label className="visually-hidden" htmlFor="run-select">选择运行记录</label>
        <select id="run-select" disabled><option>尚无运行记录</option></select>
        <Button variant="outline" id="source-button" disabled>查看需求</Button>
        <Button asChild variant="outline"><a id="factory-workbench-link" href="/factory.html" hidden>
          Factory 全流程<ArrowUpRight size={14} aria-hidden="true" />
        </a></Button>
      </div>
    </section>
  );
}

function ProjectLaunch() {
  return (
    <section id="onboarding" className="studio-launch" aria-labelledby="onboarding-title">
      <div className="studio-launch-visual" aria-hidden="true"><span /><span /><span /></div>
      <div className="studio-launch-copy">
        <span className="studio-launch-eyebrow">快速开始</span>
        <div className="studio-launch-icon"><FileUp size={23} aria-hidden="true" /></div>
        <h2 id="onboarding-title">从一份软件需求开始</h2>
        <p>导入 Markdown、TXT、Word 文档，或粘贴需求正文。</p>
        <div className="studio-launch-actions">
          <Button id="onboarding-import"><FileUp size={16} aria-hidden="true" />导入需求文档</Button>
          <button type="button" className="text-button" id="onboarding-sample">载入示例需求</button>
        </div>
        <ol className="studio-launch-steps" aria-label="使用步骤">
          <li><b>1</b>创建项目</li>
          <li><b>2</b>编排任务</li>
          <li><b>3</b>确认并交付</li>
        </ol>
      </div>
    </section>
  );
}

export function RunOverview() {
  return (
    <details id="delivery-workflow" className="studio-workflow" open>
      <summary aria-controls="delivery-steps">
        <span className="studio-workflow-title"><GitBranch size={18} aria-hidden="true" />流程总览</span>
        <span id="studio-workflow-scope" className="studio-workflow-scope" hidden>旧版规划 · 仅至文档导出</span>
        <span className="studio-workflow-current">
          <span id="delivery-current-title">需求输入</span>
          <span id="delivery-current-state" aria-live="polite">尚未开始</span>
        </span>
        <span className="studio-workflow-tools">
          <span id="delivery-done-count">0 / 9 完成</span>
          <span className="studio-workflow-disclosure">
            <span className="studio-flow-expand">展开</span><span className="studio-flow-collapse">收起</span>
            <ChevronDown size={15} aria-hidden="true" />
          </span>
        </span>
      </summary>
      <ol id="delivery-steps" className="studio-route" aria-label="项目流程图" />
      <ul className="studio-map-legend" aria-label="流程图状态图例">
        <li data-tone="done">已完成</li>
        <li data-tone="working">执行中</li>
        <li data-tone="waiting">待处理</li>
        <li data-tone="failed">异常</li>
      </ul>
    </details>
  );
}

function RunControls() {
  return (
    <section id="studio-run-controls" className="workspace-run-tools studio-run-tools" aria-label="运行控制" tabIndex={-1}>
      <h2 className="studio-region-label"><Settings2 size={15} aria-hidden="true" />运行控制</h2>
      <div className="workflow-controls">
        <Button id="start-automatic" hidden>自动开发并交付</Button>
        <Button variant="outline" id="stop-automatic" hidden>停止自动推进</Button>
        <label className="visually-hidden" htmlFor="mode-select">手动规划模式</label>
        <select id="mode-select">
          <option value="local">本地规则模式</option><option value="model" disabled>模型模式（未配置）</option>
        </select>
        <Button variant="outline" id="pause-button" hidden>暂停</Button>
        <Button variant="outline" id="start-run" disabled><Play size={15} aria-hidden="true" /><span>开始编排</span></Button>
        <Button asChild variant="outline"><a id="download-bundle" hidden>下载文档包</a></Button>
      </div>
      <p id="automatic-unavailable" className="workspace-charge-notice" hidden />
      <p id="planning-charge-notice" className="workspace-charge-notice" hidden />
      <details className="workspace-budget"><summary>模型预算与用量详情</summary><p id="planning-model-notice" role="status" hidden /></details>
    </section>
  );
}

export function RunInspector() {
  return (
    <aside className="studio-inspector" aria-label="运行操作与历史">
      <NextStepPanel />
      <ProjectLaunch />
      <section id="workspace-context" className="workspace-context studio-current" aria-label="当前进度与下一步" hidden>
        <div className="studio-current-brief">
          <div className="studio-current-meta">
            <span className="studio-region-label"><CircleDot size={15} aria-hidden="true" />当前进度</span>
            <span id="run-status" className="status-tag status-idle">尚未开始</span>
          </div>
          <span id="run-progress" className="visually-hidden">导入需求后开始</span>
          <h2 id="workspace-context-title">先导入一份软件需求</h2>
          <p id="workspace-context-note">选择项目后查看当前步骤和需要处理的问题。</p>
        </div>
        <div className="workspace-context-actions">
          <Button id="workspace-next-root" data-workspace-next>处理当前步骤</Button>
          <Button asChild><a id="automatic-download" hidden>下载已验收源码</a></Button>
        </div>
      </section>
      <RunControls />
      <details id="run-history" className="run-history studio-run-history" hidden>
        <summary><History size={15} aria-hidden="true" />运行历史<ChevronDown className="studio-history-chevron" size={15} aria-hidden="true" /></summary>
        <ul id="run-history-list" aria-label="项目运行历史" />
      </details>
    </aside>
  );
}
