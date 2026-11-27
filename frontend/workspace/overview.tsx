import { Button } from '../components/button';

export function ProjectHeading() {
  return (
    <section className="workspace-heading" aria-labelledby="project-title">
      <div>
        <p className="page-context">软件项目规划</p>
        <h1 id="project-title">需求编排工作台</h1>
        <p id="project-description" className="page-description">把需求整理成清晰的规格、开发任务与交接文档。</p>
      </div>
      <div className="heading-actions">
        <label className="visually-hidden" htmlFor="run-select">选择运行记录</label>
        <select id="run-select" disabled><option>尚无运行记录</option></select>
        <Button variant="outline" id="source-button" disabled>查看需求</Button>
        <Button asChild variant="outline"><a id="factory-workbench-link" href="/factory.html" hidden>Factory 全流程</a></Button>
      </div>
    </section>
  );
}

export function ProjectLaunch() {
  return (
    <section id="onboarding" className="onboarding" aria-labelledby="onboarding-title">
      <div className="document-illustration" aria-hidden="true">
        <svg viewBox="0 0 64 76"><path d="M12 2h28l14 15v55H12Z"/><path d="M40 2v17h14M22 32h22M22 43h22M22 54h14"/></svg>
        <span>.md</span>
      </div>
      <div className="onboarding-copy">
        <h2 id="onboarding-title">从一份软件需求开始</h2>
        <p>粘贴需求，或导入 Markdown、TXT、Word 文档。启动自动开发后，在这里跟踪进度和源码交付。</p>
        <div className="onboarding-actions">
          <Button id="onboarding-import">导入需求文档</Button>
          <button type="button" className="text-button" id="onboarding-sample">载入示例需求</button>
        </div>
      </div>
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
          <span className="tf-flow-action">查看完整流程</span>
        </span>
      </summary>
      <ol id="delivery-steps" aria-label="项目流程图" />
    </details>
  );
}

export function RunOverview() {
  return (
    <>
      <section id="workspace-context" className="workspace-context" aria-label="当前进度与下一步" hidden>
        <div>
          <span id="run-status" className="status-tag status-idle">尚未开始</span>
          <span id="run-progress">导入需求后开始</span>
          <h2 id="workspace-context-title">先导入一份软件需求</h2>
          <p id="workspace-context-note">选择项目后，在这里查看当前步骤和需要处理的问题。</p>
        </div>
        <div className="workspace-context-actions">
          <Button id="workspace-next-root" data-workspace-next>处理当前步骤</Button>
          <Button asChild><a id="automatic-download" hidden>下载已验收源码</a></Button>
        </div>
      </section>
      <DeliveryTimeline />
      <details id="run-history" className="run-history" hidden>
        <summary>运行历史</summary>
        <ul id="run-history-list" aria-label="项目运行历史" />
      </details>
      <section className="workspace-run-tools" aria-label="运行控制">
        <div className="workflow-controls">
          <Button id="start-automatic" hidden>自动开发并交付</Button>
          <Button variant="outline" id="stop-automatic" hidden>停止自动推进</Button>
          <label className="visually-hidden" htmlFor="mode-select">手动规划模式</label>
          <select id="mode-select">
            <option value="local">本地规则模式</option><option value="model" disabled>模型模式（未配置）</option>
          </select>
          <Button variant="outline" id="pause-button" hidden>暂停</Button>
          <Button variant="outline" id="start-run" disabled><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 8 6-8 6Z"/></svg><span>开始编排</span></Button>
          <Button asChild variant="outline"><a id="download-bundle" hidden>下载文档包</a></Button>
        </div>
        <p id="automatic-unavailable" className="workspace-charge-notice" hidden />
        <p id="planning-charge-notice" className="workspace-charge-notice" hidden />
        <details className="workspace-budget"><summary>模型预算与用量详情</summary><p id="planning-model-notice" role="status" hidden /></details>
      </section>
    </>
  );
}
