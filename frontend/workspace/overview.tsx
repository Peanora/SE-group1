import { ArrowDown, ArrowRight, ArrowUpRight, ChevronDown, ClipboardCheck, FileText, FileUp, GitBranch, Play } from 'lucide-react';
import { Button } from '../components/button';

export function ProjectHeading() {
  return (
    <section className="workspace-heading" aria-labelledby="project-title">
      <div>
        <h1 id="project-title">需求编排工作台</h1>
        <p id="project-description" className="page-description">从需求规划到开发验收。</p>
      </div>
      <div className="heading-actions">
        <Button variant="outline" id="source-button" disabled><FileText aria-hidden="true" />查看需求</Button>
        <Button asChild variant="outline"><a id="factory-workbench-link" href="/factory.html" hidden>Factory 全流程<ArrowUpRight aria-hidden="true" /></a></Button>
      </div>
    </section>
  );
}

export function ProjectLaunch() {
  return (
    <section id="onboarding" className="onboarding" aria-labelledby="onboarding-title">
      <div className="launch-copy">
        <h2 id="onboarding-title">把一份需求，<br />变成可验收的软件</h2>
        <p>上传已有文档或写下要解决的问题。从规格确认开始，每一步都有可核对的成果。</p>
        <div className="onboarding-actions">
          <Button id="onboarding-import"><FileUp aria-hidden="true" />导入需求文档</Button>
          <Button variant="outline" id="onboarding-sample">载入示例需求<ArrowRight aria-hidden="true" /></Button>
        </div>
        <p className="launch-inputs">支持 Markdown、TXT 和 Word</p>
      </div>
      <ol className="launch-path" aria-label="研发流程">
        <li><FileText aria-hidden="true" /><div><strong>需求与规格</strong><span>澄清业务规则与验收条件</span></div></li>
        <li className="launch-connector" aria-hidden="true"><ArrowDown /></li>
        <li><GitBranch aria-hidden="true" /><div><strong>开发任务</strong><span>查看依赖、输入和预期产出</span></div></li>
        <li className="launch-connector" aria-hidden="true"><ArrowDown /></li>
        <li><ClipboardCheck aria-hidden="true" /><div><strong>验收与交付</strong><span>核对测试、审查与候选版本</span></div></li>
      </ol>
    </section>
  );
}

function DeliveryTimeline() {
  return (
    <details id="delivery-workflow" className="delivery-workflow">
      <summary aria-controls="delivery-steps">
        <span className="tf-flow-summary">
          <span className="tf-flow-label">项目流程</span>
          <span id="delivery-current-title">需求输入</span>
          <span id="delivery-current-state" aria-live="polite">尚未开始</span>
        </span>
        <span className="tf-flow-actions">
          <span id="delivery-done-count">0 / 9 完成</span>
          <span className="tf-flow-action">查看完整流程</span><ChevronDown className="flow-chevron" aria-hidden="true" />
        </span>
      </summary>
      <ol id="delivery-steps" aria-label="项目流程图" />
    </details>
  );
}

export function RunRail() {
  return (
    <aside className="run-rail" aria-label="运行进度和操作">
      <div className="run-card">
        <section id="workspace-context" className="workspace-context" aria-label="当前进度与下一步" hidden>
          <div className="run-card-top">
            <label htmlFor="run-select">选择运行记录</label>
            <select id="run-select" disabled><option>尚无运行记录</option></select>
          </div>
          <div className="run-card-action">
            <div className="run-context-meta"><span id="run-status" className="status-tag status-idle">尚未开始</span><span id="run-progress">导入需求后开始</span></div>
            <h2 id="workspace-context-title">先导入一份软件需求</h2>
            <p id="workspace-context-note">选择项目后，在这里查看当前步骤和需要处理的问题。</p>
            <div className="workspace-context-actions">
              <Button id="workspace-next-root" data-workspace-next>处理当前步骤</Button>
              <Button asChild><a id="automatic-download" hidden>下载已验收源码</a></Button>
            </div>
          </div>
        </section>
        <DeliveryTimeline />
        <details id="run-history" className="run-history" hidden>
          <summary>运行历史</summary>
          <ul id="run-history-list" aria-label="项目运行历史" />
        </details>
      </div>
      <section className="workspace-run-tools" aria-label="运行控制">
        <div className="workflow-controls">
          <Button id="start-automatic" hidden>自动开发并交付</Button>
          <Button variant="outline" id="stop-automatic" hidden>停止自动推进</Button>
          <label className="visually-hidden" htmlFor="mode-select">手动规划模式</label>
          <select id="mode-select">
            <option value="local">本地规则模式</option><option value="model" disabled>模型模式（未配置）</option>
          </select>
          <Button variant="outline" id="pause-button" hidden>暂停</Button>
          <Button variant="outline" id="start-run" disabled><Play aria-hidden="true" /><span>开始编排</span></Button>
          <Button asChild variant="outline"><a id="download-bundle" hidden>下载文档包</a></Button>
        </div>
        <p id="automatic-unavailable" className="workspace-charge-notice" hidden />
        <p id="planning-charge-notice" className="workspace-charge-notice" hidden />
        <details className="workspace-budget"><summary>模型预算与用量详情</summary><p id="planning-model-notice" role="status" hidden /></details>
      </section>
    </aside>
  );
}
