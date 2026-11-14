# 网页执行面板组件

## 本轮目标与边界

基准：`702d318`，独立工作区和分支 `codex/execution-panel`。仅修改本任务记录、`public/execution-panel.js`、`tests/execution-panel.test.mjs`。目标是提供可接入原工作台的执行面板；不修改共享入口、服务端或用户数据，不调用真实模型，不推送或部署。

验收：后端事实驱动的启动与操作权限、同版本检查/Review/历史展示、未知用量、停止等待、纯文本安全及预览地址限制；使用固定模拟API和真实Edge检查桌面、390×844窄屏、键盘焦点及失败后表单保留。测试页面只验证平台UI，不是业务项目生成验收。集成层实际路由及完整应用回归留给主Agent串行完成。

## 组件及最小HTTP契约

`createExecutionPanel({ api, getContext, onError })` 返回 `{ mount(element), refresh(), destroy() }`。`mount`创建独立区域并返回首次加载的Promise，`refresh`可等待，`destroy`停止轮询及后续结果发布。`api(path, options)`返回已解析JSON，失败抛出带`status`的Error；请求采用fetch兼容`method/body`。组件自己以3秒间隔读取状态，不请求任何真实模型专用入口。

`getContext()`返回`{ projectId, runId, planningStatus, specRevision, planRevision }`。只有`planningStatus === 'confirmed'`且两revision非空才可启动；集成层必须核对workflowVersion2当前规格/计划hash与两次审批精确匹配后派生confirmed，不能只看规划succeeded。重新执行也要求当前双确认及调用勾选。范围、模型或预算变化后清除旧勾选。上下文切换后旧请求不能覆盖新项目；状态读取使用cache:no-store。

基础路径：`/api/projects/:pid/runs/:rid/executions`。

- GET：`{ capabilities: { canStart, profiles: [{ id, title, description, contractRevision }], reason?, model?: { name }, budget?: { maxCalls, maxReviewCalls, maxDurationMs?, timeoutMs? } }, executions: [...] }`。
- POST `/start`：`{ profileId, contractRevision }`，返回`{ execution }`。用户需勾选按可见范围和预算调用配置模型。此确认不改变任何验收结论。
- POST `/:eid/action`：`{ action: 'cancel' | 'retry' | 'preview' | 'stop_preview' }`，返回`{ execution, preview?: { url, expiresAt } }`。
- GET `/:eid/download`：后端验证过的源码下载，组件只在`taskAccepted === true && actions.canDownload === true`时提供该固定路由链接。

execution：`{ id, status, taskAccepted, stage?, versions: [{ commit, sourceHash, diff?, selfCheck, acceptance: { test?, browser?, review?, issues?, openIssues? }, httpChecks?, browserChecks?, review? }], diff?, events: [{ sequence, time, message }], calls, reviewCalls, usage: { inputTokens, outputTokens }, budget, error, actions: { canCancel, canRetry, canPreview, canStopPreview?, canDownload }, preview?: null | { url, expiresAt } }`。`canStopPreview`为明确停止预览权限；旧DTO缺失时不擅自启用。GET显式preview:null撤销旧链接；POST顶层preview作为本次预览事实。原执行记录的`acceptance.test/browser/review/issues/openIssues`直接展示；可选HTTP/browser简化字段也支持。默认显示中文检查摘要及问题列表，原始纯文本证据折叠保存，前端不从检查计数自行推出验收通过。

首版固定示例范围永久可见，profile原文描述及contractRevision可核对；任意需求未支持时后端必须返回canStart:false及reason。budget缺失/用量null显示未知；错误可手动刷新恢复。取消请求、停止确认和状态待核对分别展示。预览仅接受带显式有效端口、无凭据的http localhost/127.0.0.1地址，拒绝任意远程、脚本、凭据及过期链接。

## 实施与验证记录

实现完成：稳定DOM保留执行范围、调用勾选、历史记录选择、焦点与证据展开状态；当前上下文及请求序号拒绝迟到结果。动作失败后保留选择并禁用执行操作，刷新核对后恢复，避免结果不确定时直接重复模型调用。只按后端taskAccepted声明固定示例通过，取消请求与停止确认分开展示；下载链接必须同时具备后端权限及任务通过结论。

已运行：

- `npm ci --ignore-scripts`：精确安装仓库锁定playwright-core，无依赖清单变更。
- `node --test tests/execution-panel.test.mjs`：真实系统Microsoft Edge Headless，14/14通过（13场景及父项），无失败/跳过。覆盖404、规格/计划门禁、范围版本请求、调用勾选、失败保留及恢复、真实定时轮询下选择/焦点/展开保留、XSS文本、HTTP/浏览器/Review及问题历史、未知/零用量区分、取消待确认/待核对/已停止、下载双门禁、危险及过期预览URL拒绝、服务器撤销链接、桌面及390×844无横向溢出、旧运行及旧GET迟到结果隔离、destroy。没有页面脚本异常或非预期控制台错误；模拟404/409/500引起的浏览器请求报错属于预期。
- `EXECUTION_PANEL_SCREENSHOTS=1`配合上述测试：生成忽略目录`output/playwright/execution-panel-1440.png`及`execution-panel-390.png`，实际查看确认布局与纯文本展示。截图属于固定平台UI模拟，不代表业务应用验收。
- `npm run check`：57个脚本语法通过；两份新增脚本也单独执行node --check通过。
- `git diff --check`：通过；最终只提交允许的三个文件。

未运行真实模型、MXC业务执行、用户data迁移及全仓回归；本组件未自行创建服务端路由或接入主网页。集成层下一项验收：挂载组件，按当前审批精确派生confirmed，实现并独立验证上述HTTP权限/版本/预算/预览/下载契约，然后重新执行集成版本全仓及真实浏览器验证。后端必须净化凭据及非公开路径，不能把任意模型输出直接交给可信状态或动作权限。未推送或部署。

## 独立 Review P2：跨运行挂起 POST 的状态归属

基于固定候选 `88a28411cc4d28185726220810e6ba3b4bd6e7a6` 修复：旧运行 POST 未返回时，全局 busy 会挡住新运行 GET；直接重置 busy 又会让旧 finally 解锁新运行正在进行的 POST。

现在使用当前上下文独占的 activeAction 对象 token。syncContext 切换项目、运行或规格/计划版本时立即脱离旧 token，新上下文可正常读取状态，取得能力和重新勾选确认后可独立操作。响应发布、错误提示及 finally 清理均须仍持有同一 token；即使 A→B→A 返回相同上下文 key，旧 POST 也不能写入新记录、显示旧错误、发布旧预览/下载或解除新操作的锁定。当前上下文仍在操作时，重复点击和读取继续受阻，只有该操作结束才恢复。

这里只分离视图和请求归属，不取消或宣称旧后端工作已经停止；旧运行事实仍由后端保存及核对。没有新增路由、模型权限或调用。

验证记录：先在旧代码运行新增真实 Edge 回归，明确复现新运行没有 GET/记录的故障；修复后 `node --test tests/execution-panel.test.mjs` 为16/16通过（15场景及父项），无失败/跳过。新回归分别控制旧 POST 成功和失败，在旧请求仍未返回时切换运行并读取、启动新 POST，再结束旧请求并确认新 POST 仍锁定；同时覆盖 A→B→A 的成功/失败迟到边界、旧 finally 不触发多余 GET、新操作完成后才解锁、旧响应的错误/预览/验收下载不污染新视图。原桌面、390×844、焦点、轮询、调用确认、错误保留、纯文本安全及预览/下载门禁场景仍通过。测试使用固定平台 UI API 内存 Promise 和真实系统 Edge，不调用付费模型或业务执行服务。

仅修改原授权三个文件；两个脚本语法检查及 git diff --check 通过。固定新提交后交另一 Agent 独立复验；未改主分支、server、package 或用户数据，也未进行主应用集成回归。

## 自有固定代码重新检查入口

本轮基准2365067，独立树codex/web-owned-recheck-service。新增“重新检查固定代码”，只在后端actions.canRecheck、当前双确认、当前所选profile、完整契约版本、已知0coding/最多2次Review预算和费用勾选同时满足时启用。复验说明明确原提交不变、全部检查与Review全新执行、原失败和原用量保留，新row独立计费；实际调用和用量仍按服务端数值显示，null保持未知。

旧contract原代码可选择当前规则复验；UI以当前capabilities及execution.recheckContractRevision判断新操作范围，不拿旧历史contract冒充新授权。retry/recheck的POST均发送`{action,profileId,contractRevision}`，数据来自当前选择；非收费动作仍只发送action。profile/model/任一预算变更、上下文和所选执行变化均清除或重新要求费用确认。旧客户端的缺字段收费动作由后端拒绝，不静默补当前版本。

保留activeAction唯一token，复验旧POST成功/失败和finally在A→B→A后不能覆盖新运行、解除新操作锁或发布旧预览/下载。新增真实系统Edge固定平台UI fixture回归覆盖：费用/范围/预算门禁、旧contract新scope、失败后输入与选择保留、实际POST字段、0coding和unknown数值区分、原历史用量保留、桌面/390×844无溢出与焦点、复验跨运行迟到token。截图在忽略的output/playwright/recheck-panel-1440.png及recheck-panel-390.png，已实际查看窄屏布局。固定fixture不调用业务模型，也不是目标业务应用的浏览器验收。

本组件不实现HTTP路由；根维护server精确字段及API文档。只有服务完整当前gate、原来源provenance与快照核对通过，才沿用既有预览和源码下载权限；UI不自行由旧QA成功推出新任务成功。

最终实际检查：`node --test tests/execution-panel.test.mjs`真实系统Edge为19/19通过（18场景及父项），0失败/跳过；新增复验按钮的桌面/窄屏、旧contract当前scope、费用ack、失败保留与跨运行token场景通过。并行服务专项显式启用真实执行程序为42/42通过、0跳过，其中新增复验正向仍为可信依赖fixture；`npm run check`为77脚本通过，`git diff --check`通过。截图只作为布局证据，交互由断言验证。最后只更新任务记录，未更改被测脚本；固定后待不同作者和根集成复验，0付费、未推送/部署。

73532cc独立审查发现服务DTO漏掉合法README.md问题位置，本次服务改为canonical项目路径校验；组件本来按文本显示file:line，无需扩大渲染权限。新增真实Edge窄屏回归验证README.md:1、docs/a..b.md:1及Unicode文件定位可见、文本仍不执行、阻塞状态无下载、无横向溢出。等待停止和状态待核对继续使用既有真实后端状态显示，未知工具不由UI推断已停止。

本修订实际执行Edge专项20/20通过（19场景及父项），服务48/48且原有真实MXC项0跳过，77脚本语法及diff检查通过。原界面脚本未改，新增定位由服务DTO修复及真实浏览器断言共同覆盖；正向业务复验仍须根集成与独立验收，无真实API或付费调用。
