export function PlanningPanel() {
  return (
    <>
      <section
        id="workspace-plan"
        className="workspace-panel"
        data-workspace-panel="plan"
        role="tabpanel"
        aria-labelledby="workspace-tab-plan"
        tabIndex={-1}
      >
        <section className="flow-panel" aria-labelledby="workflow-heading">
          <header className="panel-toolbar">
            <div className="panel-title">
              <span className="section-symbol" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <rect x="2" y="8" width="6" height="8" rx="2" />
                  <rect x="16" y="2" width="6" height="7" rx="2" />
                  <rect x="16" y="15" width="6" height="7" rx="2" />
                  <path d="M8 12h4V6h4M12 12v7h4" />
                </svg>
              </span>
              <div>
                <h2 id="workflow-heading">流程编排</h2>
                <span id="workflow-subtitle">
                  六个阶段，一份可追踪的开发计划
                </span>
              </div>
            </div>
          </header>
          <p
            id="source-history-notice"
            role="status"
            hidden
            style={{
              margin: "0",
              padding: "0 24px 12px",
              color: "var(--muted)",
            }}
          >
            此运行保留历史需求与审批记录，已停止推进。请基于当前需求重新编排并确认规格和计划；历史检查不会自动用于新版本。
          </p>
          <details id="workflow-details" className="workspace-process" open>
            <summary>查看规划过程与阶段详情</summary>
            <div className="flow-workspace">
              <div className="flow-canvas">
                <div className="canvas-label">
                  工作流依赖图 <span>点击节点查看详情</span>
                </div>
                <div className="workflow-graph-scroll">
                  <div
                    id="workflow-graph"
                    className="workflow-graph"
                    aria-label="规划工作流"
                  ></div>
                </div>
                <div className="canvas-footer">
                  <span>
                    <i className="legend-dot legend-parallel"></i>
                    规格确认后，架构与任务可并行生成
                  </span>
                  <span>
                    <i className="legend-dot legend-review"></i>
                    <span id="workflow-confirmation-legend">
                      先确认规格，再确认计划
                    </span>
                  </span>
                </div>
              </div>
              <aside
                id="stage-inspector"
                className="stage-inspector"
                aria-label="阶段详情"
              ></aside>
            </div>
            <details className="demo-options">
              <summary>演示选项</summary>
              <div className="demo-options-content">
                <label htmlFor="failure-select">注入一次性故障</label>
                <select id="failure-select">
                  <option value="">关闭</option>
                  <option value="tasks">任务拆解阶段</option>
                  <option value="architecture">架构设计阶段</option>
                  <option value="review">计划校验阶段</option>
                </select>
                <p>仅用于展示失败与重试。再次尝试该阶段时恢复正常。</p>
              </div>
            </details>
          </details>
          <section
            id="planning-issue-host"
            className="planning-issue"
            aria-labelledby="planning-issue-heading"
            hidden
          >
            <h3 id="planning-issue-heading" tabIndex={-1}>
              查看问题
            </h3>
            <p data-issue-message></p>
            <div className="planning-issue-draft" data-issue-draft hidden>
              <h4 data-issue-draft-title></h4>
              <p data-issue-draft-description></p>
              <p data-issue-draft-quote-row>
                模型尝试引用 <q data-issue-draft-quote></q>
              </p>
            </div>
            <div className="planning-issue-explanation">
              <p data-issue-explanation hidden></p>
              <button
                type="button"
                className="button button-outline"
                data-issue-retry
                hidden
              >
                重试生成问题
              </button>
            </div>
            <details hidden>
              <summary>上次保存的补充</summary>
              <p data-issue-previous></p>
            </details>
            <form hidden>
              <ol data-issue-fields></ol>
              <div className="spec-repair-actions">
                <button
                  type="button"
                  className="button button-outline"
                  data-issue-save
                >
                  保存草稿
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  data-issue-continue
                >
                  提交本轮回答
                </button>
              </div>
            </form>
            <button
              type="button"
              className="button button-primary"
              data-issue-recover
              hidden
            >
              用已保存的回答重新整理
            </button>
            <p data-issue-status role="status"></p>
          </section>
          <div id="review-home">
            <section
              id="specification-meeting-host"
              className="specification-meeting"
              hidden
            ></section>
            <section
              id="review-banner"
              className="review-banner"
              aria-labelledby="review-heading"
              hidden
            ></section>
          </div>
          <section
            id="spec-repair-host"
            className="spec-repair"
            aria-labelledby="spec-repair-heading"
            hidden
          ></section>
        </section>
      </section>
    </>
  );
}

export function TaskPanel() {
  return (
    <>
      <section
        id="workspace-tasks"
        className="workspace-panel"
        data-workspace-panel="tasks"
        role="tabpanel"
        aria-labelledby="tab-tasks"
        tabIndex={-1}
        hidden
      >
        <section className="records-panel" aria-label="运行详情">
          <header className="records-toolbar">
            <div className="tabs" role="tablist" aria-label="查看运行内容">
              <button
                role="tab"
                id="records-tab-tasks"
                data-tab="tasks"
                aria-selected="true"
                aria-controls="records-body"
              >
                任务图
              </button>
              <button
                role="tab"
                id="tab-artifacts"
                data-tab="artifacts"
                aria-selected="false"
                aria-controls="records-body"
              >
                生成文档 <span id="artifact-count">0</span>
              </button>
              <button
                role="tab"
                id="tab-events"
                data-tab="events"
                aria-selected="false"
                aria-controls="records-body"
              >
                执行记录 <span id="event-count">0</span>
              </button>
            </div>
            <span className="records-hint" id="records-hint">
              任务、文档与运行依据
            </span>
          </header>
          <div
            id="records-body"
            className="records-body"
            role="tabpanel"
            aria-labelledby="records-tab-tasks"
          ></div>
        </section>
        <details id="simulation-tools" className="workspace-secondary">
          <summary>模拟编排（可选）</summary>
          <div
            id="simulation-panel-host"
            className="simulation-panel"
            hidden
          ></div>
        </details>
      </section>
    </>
  );
}

export function RequirementsPanel() {
  return (
    <>
      <section
        id="workspace-source"
        className="workspace-panel"
        data-workspace-panel="source"
        role="tabpanel"
        aria-labelledby="workspace-tab-source"
        tabIndex={-1}
        hidden
      >
        <div className="workspace-section-heading">
          <h2>需求与功能</h2>
          <button type="button" className="text-button" data-workspace-back>
            返回上一工作区
          </button>
        </div>
        <section id="source-changes-section" aria-label="需求变更工作区" hidden>
          <div id="source-changes-host"></div>
        </section>
      </section>
    </>
  );
}

export function DeliveryPanel() {
  return (
    <>
      <section
        id="workspace-execution"
        className="workspace-panel"
        data-workspace-panel="execution"
        role="tabpanel"
        aria-labelledby="workspace-tab-execution"
        tabIndex={-1}
        hidden
      >
        <header className="workspace-section-heading">
          <h2>代码与验收</h2>
        </header>
        <nav className="execution-workspace-flow" aria-label="从验收清单到交付">
          <ol id="execution-workspace-steps"></ol>
          <p id="execution-next-hint">先准备验收清单，再开始开发。</p>
        </nav>
        <details
          id="verification-plans-section"
          className="workspace-secondary"
          hidden
        >
          <summary>准备验收清单</summary>
          <div id="verification-plans-host"></div>
        </details>
        <section id="planned-execution-section" hidden>
          <div id="planned-execution-host"></div>
        </section>
        <details id="execution-tools" className="workspace-secondary">
          <summary>其他工具与参考项目</summary>
          <section id="project-evolution-section" hidden>
            <div id="project-evolution-host"></div>
          </section>
          <div id="execution-panel-host"></div>
        </details>
        <p id="verification-plans-unavailable" hidden>
          当前服务未开放验收清单。
        </p>
      </section>
    </>
  );
}
