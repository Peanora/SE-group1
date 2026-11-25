import { ArrowUpRight, ChevronDown, FileUp, GitBranch, Play } from 'lucide-react';
import { Button } from '../components/button';

export function RunOverview() {
  return (
    <>
      <section className="workspace-heading" aria-labelledby="project-title">
        <div>
          <h1 id="project-title">需求编排工作台</h1>
          <p id="project-description" className="page-description">从需求规划到开发验收。</p>
        </div>
        <div className="heading-actions">
          <label className="visually-hidden" htmlFor="run-select">选择运行记录</label>
          <select id="run-select" disabled><option>尚无运行记录</option></select>
          <Button variant="outline" id="source-button" disabled>查看需求</Button>
          <Button asChild variant="outline"><a id="factory-workbench-link" href="/factory.html" hidden>Factory 全流程<ArrowUpRight aria-hidden="true" /></a></Button>
        </div>
      </section>
      <section id="onboarding" className="onboarding" aria-labelledby="onboarding-title">
        <div className="onboarding-copy">
          <h2 id="onboarding-title">从一份软件需求开始</h2>
          <p>导入 Markdown、TXT 或 Word 文档，整理规格与计划。开发启动后，在同一个项目里跟踪任务、验收与交付。</p>
          <div className="onboarding-actions">
            <Button id="onboarding-import"><FileUp aria-hidden="true" />导入需求文档</Button>
            <Button variant="ghost" id="onboarding-sample">载入示例需求</Button>
          </div>
        </div>
        <div className="onboarding-graphic" aria-hidden="true">
          <div className="graphic-path"><i /><i /><i /><i /></div>
          <div className="graphic-branch"><GitBranch strokeWidth={1.25} /></div>
        </div>
      </section>
      <section id="workspace-context" className="workspace-context" aria-label="当前进度与下一步" hidden>
        <div>
          <div className="run-context-meta"><span id="run-status" className="status-tag status-idle">尚未开始</span><span id="run-progress">导入需求后开始</span></div>
          <h2 id="workspace-context-title">先导入一份软件需求</h2>
          <p id="workspace-context-note">选择项目后，在这里查看当前步骤和需要处理的问题。</p>
        </div>
        <div className="workspace-context-actions">
          <Button id="workspace-next-root" data-workspace-next>处理当前步骤</Button>
          <Button asChild><a id="automatic-download" hidden>下载已验收源码</a></Button>
        </div>
      </section>
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
      <section className="workspace-run-tools" aria-label="运行控制">
        <div className="workflow-controls">
          <Button id="start-automatic" hidden>自动开发并交付</Button>
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
    </>
  );
}
