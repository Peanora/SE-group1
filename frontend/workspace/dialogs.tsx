import { BookOpen, CloudUpload, FileText, FolderPlus, GitPullRequest, Play, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

function DialogTitle({ icon: Icon, title, id, editor = false }: {
  icon: LucideIcon; title: string; id: string; editor?: boolean;
}) {
  return (
    <header className={editor ? 'studio-dialog-title task-edit-header' : 'studio-dialog-title'}>
      <span className="studio-dialog-icon"><Icon aria-hidden="true" /></span>
      <h2 id={id}>{title}</h2>
      <button type="button" className="studio-dialog-close" aria-label={editor ? '关闭任务编辑' : '关闭'}
        {...(editor ? { 'data-close-task-editor': '' } : { 'data-close-dialog': '' })}>
        <X aria-hidden="true" />
      </button>
    </header>
  );
}

export function WorkspaceDialogs() {
  return (
    <>
      <dialog id="task-edit-dialog" className="task-edit-dialog studio-dialog" aria-labelledby="task-edit-heading">
        <DialogTitle icon={GitPullRequest} title="编辑开发任务" id="task-edit-heading" editor />
        <div id="task-edit-host" className="task-edit-body" />
        <footer className="task-edit-footer studio-dialog-actions">
          <span>保存修订后需重新确认计划。</span>
          <button type="button" className="button button-outline" data-close-task-editor>返回任务图</button>
        </footer>
      </dialog>

      <dialog id="project-dialog" className="studio-dialog studio-import" aria-labelledby="import-title">
        <form id="project-form">
          <DialogTitle icon={FolderPlus} title="从需求创建项目" id="import-title" />
          <div className="studio-import-body">
            <label className="studio-field" htmlFor="project-name-input">
              <span>项目名称 <small>选填</small></span>
              <input id="project-name-input" name="name" type="text" maxLength={100} autoComplete="off" placeholder="例如，设备预约系统" />
            </label>
            <div className="studio-import-columns">
              <div className="studio-import-text">
                <div className="studio-field-caption">
                  <label htmlFor="source-input">需求正文</label>
                  <button type="button" id="load-sample" className="text-button">载入示例</button>
                </div>
                <textarea id="source-input" rows={7} maxLength={100000} placeholder="描述使用者、需要完成的操作和验收条件…" />
                <p id="docx-note" className="field-note" hidden>创建项目时提取 Word 正文。移除文件后可编辑文本。</p>
              </div>
              <div className="studio-import-file">
                <div className="studio-field-caption">从文档导入</div>
                <div id="drop-zone" className="studio-upload">
                  <input id="file-input" className="visually-hidden" type="file" accept=".md,.txt,.docx" />
                  <label htmlFor="file-input">
                    <CloudUpload aria-hidden="true" /><strong>选择或拖入文档</strong>
                    <span>MD、TXT、DOCX<br />最大 3 MB</span>
                  </label>
                </div>
                <div id="selected-file" className="studio-selected-file" hidden>
                  <span id="selected-file-name" /><button type="button" id="clear-file" className="text-button">移除</button>
                </div>
              </div>
            </div>
            <p id="import-error" className="inline-error" role="alert" hidden />
          </div>
          <footer className="studio-dialog-actions">
            <button type="button" className="button button-outline" data-close-dialog>取消</button>
            <button type="submit" className="button button-primary" id="create-project-button">创建项目</button>
          </footer>
        </form>
      </dialog>

      <dialog id="automatic-delivery-dialog" className="studio-dialog" aria-labelledby="automatic-delivery-title">
        <form id="automatic-delivery-form">
          <DialogTitle icon={Play} title="启动自动交付" id="automatic-delivery-title" />
          <div className="dialog-body studio-dialog-body">
            <p>本次运行将依次准备规格、开发计划和验收清单，并推进编码、测试与审查。需要补充业务规则时，运行会等待你的答复。</p>
            <p id="automatic-budget" className="studio-budget-facts" />
            <label className="studio-consent">
              <input type="checkbox" id="automatic-consent" required />
              <span>我同意本次运行按所示上限调用已配置的模型服务。</span>
            </label>
          </div>
          <footer className="studio-dialog-actions">
            <button type="button" className="button button-outline" data-close-dialog>取消</button>
            <button type="submit" className="button button-primary" id="confirm-automatic" disabled>启动自动交付</button>
          </footer>
        </form>
      </dialog>

      <dialog id="source-dialog" className="studio-dialog studio-document" aria-labelledby="source-title">
        <DialogTitle icon={FileText} title="需求快照" id="source-title" />
        <div className="studio-document-body"><pre id="source-content" /></div>
        <footer className="studio-dialog-actions">
          <button type="button" className="button button-outline" data-close-dialog>关闭</button>
          <button type="button" className="button button-primary" id="revise-source">修改当前项目需求</button>
        </footer>
      </dialog>

      <dialog id="help-dialog" className="studio-dialog" aria-labelledby="help-title">
        <DialogTitle icon={BookOpen} title="工作流操作指南" id="help-title" />
        <ol className="studio-guide">
          <li><strong>导入与确认</strong><p>用文档或文字创建项目。手动规划会依次等待规格确认与计划确认。</p></li>
          <li><strong>编排与执行</strong><p>在任务图检查依赖与验收条件。确认清单、核对模型用量后启动开发。</p></li>
          <li><strong>检查与交付</strong><p>打开候选版本，核对接口、浏览器和审查结果。已验收的源码可预览和下载。</p></li>
          <li><strong>追溯与复盘</strong><p>选定一次运行，查看审批、阶段事件和候选检查，沿原记录核对失败与返工。</p></li>
        </ol>
        <footer className="studio-dialog-actions"><button type="button" className="button button-primary" data-close-dialog>返回工作台</button></footer>
      </dialog>
      <div id="toast" className="toast" role="status" hidden />
    </>
  );
}
