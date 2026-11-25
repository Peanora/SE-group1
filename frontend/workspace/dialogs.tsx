export function WorkspaceDialogs() {
  return (
    <>
      <dialog
        id="task-edit-dialog"
        className="task-edit-dialog"
        aria-labelledby="task-edit-heading"
      >
        <header className="task-edit-header">
          <div>
            <span>当前开发计划</span>
            <h2 id="task-edit-heading">编辑开发任务</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            data-close-task-editor
            aria-label="关闭任务编辑"
          >
            ×
          </button>
        </header>
        <div id="task-edit-host" className="task-edit-body"></div>
        <footer className="task-edit-footer">
          <span>修改先保存，再单独确认；关闭会保留草稿。</span>
          <button
            type="button"
            className="button button-outline"
            data-close-task-editor
          >
            返回任务图
          </button>
        </footer>
      </dialog>

      <dialog
        id="project-dialog"
        className="project-dialog"
        aria-labelledby="import-title"
      >
        <form id="project-form">
          <header className="dialog-header">
            <div>
              <p className="page-context">新的需求快照</p>
              <h2 id="import-title">新建软件项目</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              data-close-dialog
              aria-label="关闭"
            >
              <span className="close-symbol">×</span>
            </button>
          </header>
          <div className="dialog-body">
            <label className="field-label" htmlFor="project-name-input">
              项目名称（选填）
            </label>
            <input
              id="project-name-input"
              name="name"
              type="text"
              maxLength={100}
              placeholder="例如：工单协作系统"
              autoComplete="off"
            />
            <div className="editor-label">
              <label className="field-label" htmlFor="source-input">
                你想做什么？
              </label>
              <button type="button" id="load-sample" className="text-button">
                载入示例
              </button>
            </div>
            <textarea
              id="source-input"
              rows={6}
              maxLength={100000}
              placeholder="例如：我想做个小组便笺网页，成员能记录待办，也能给便笺加标签。"
            ></textarea>
            <div id="drop-zone" className="drop-zone">
              <input
                id="file-input"
                className="visually-hidden"
                type="file"
                accept=".md,.txt,.docx"
              />
              <label htmlFor="file-input">
                <span className="upload-symbol" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />
                  </svg>
                </span>
                <strong>上传或拖入已有文档</strong>
                <span>Word、Markdown、TXT，最大 3 MB</span>
              </label>
            </div>
            <div id="selected-file" className="selected-file" hidden>
              <span id="selected-file-name"></span>
              <button type="button" id="clear-file" className="text-button">
                移除
              </button>
            </div>
            <p id="docx-note" className="field-note" hidden>
              Word
              正文将在创建项目时提取。若需修改内容，请先移除文件，改用粘贴文本。
            </p>
            <p
              id="import-error"
              className="inline-error"
              role="alert"
              hidden
            ></p>
          </div>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button button-outline"
              data-close-dialog
            >
              取消
            </button>
            <button
              type="submit"
              className="button button-primary"
              id="create-project-button"
            >
              创建项目
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        id="automatic-delivery-dialog"
        className="help-dialog"
        aria-labelledby="automatic-delivery-title"
      >
        <form id="automatic-delivery-form">
          <header className="dialog-header">
            <h2 id="automatic-delivery-title">启动自动交付</h2>
            <button
              type="button"
              className="icon-button"
              data-close-dialog
              aria-label="关闭"
            >
              <span className="close-symbol">×</span>
            </button>
          </header>
          <div className="dialog-body help-content">
            <p>
              系统会整理需求、拟订计划与验收清单，再自动编码、测试、审查和返工。遇到必须补充的业务信息时，会在工作台显示具体问题。完成后可下载当前通过验收的源码。
            </p>
            <p id="automatic-budget"></p>
            <label className="automatic-consent">
              <input type="checkbox" id="automatic-consent" required />
              <span>我同意本次运行按所示上限调用已配置的模型服务。</span>
            </label>
          </div>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button button-outline"
              data-close-dialog
            >
              取消
            </button>
            <button
              type="submit"
              className="button button-primary"
              id="confirm-automatic"
              disabled
            >
              启动自动交付
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        id="source-dialog"
        className="source-dialog"
        aria-labelledby="source-title"
      >
        <header className="dialog-header">
          <div>
            <p className="page-context">所选运行的需求快照</p>
            <h2 id="source-title">需求文档</h2>
          </div>
          <button className="icon-button" data-close-dialog aria-label="关闭">
            <span className="close-symbol">×</span>
          </button>
        </header>
        <div className="source-dialog-body">
          <pre id="source-content"></pre>
        </div>
        <footer className="dialog-footer">
          <button className="button button-outline" data-close-dialog>
            关闭
          </button>
          <button className="button button-primary" id="revise-source">
            修改当前项目需求
          </button>
        </footer>
      </dialog>

      <dialog
        id="help-dialog"
        className="help-dialog"
        aria-labelledby="help-title"
      >
        <header className="dialog-header">
          <h2 id="help-title">从想法到可试用软件</h2>
          <button className="icon-button" data-close-dialog aria-label="关闭">
            <span className="close-symbol">×</span>
          </button>
        </header>
        <div className="dialog-body help-content">
          <ol>
            <li>
              <strong>说需求。</strong>
              写一句话或上传文档。系统有问题时，按你的想法回答。
            </li>
            <li>
              <strong>启动自动交付。</strong>
              先核对并同意模型用量。使用手动编排可以逐版审阅规格、计划和验收清单。
            </li>
            <li>
              <strong>跟踪进度。</strong>
              打开流程图查看开发、独立测试、代码审查和返工。工作台会显示需要补充的需求问题。
            </li>
            <li>
              <strong>预览与下载。</strong>
              当前版本通过后，可以先试用，再拿到源码。
            </li>
          </ol>
          <p>
            点击首页流程图的节点可打开对应工作区。任务图、文档和日志在「开发任务」中查看。
          </p>
        </div>
        <footer className="dialog-footer">
          <button className="button button-primary" data-close-dialog>
            返回工作台
          </button>
        </footer>
      </dialog>
      <div id="toast" className="toast" role="status" hidden></div>
    </>
  );
}
