# 单控制器Web执行生命周期服务

基准`9a07615`。独立分支`codex/web-execution-service`，仅新增服务模块、专测及本文。已授权的task-store提交在工作树作参考；本服务不依赖其接口。当前执行器自行生成attemptId并内部多轮候选，与task-store的租约/候选唯一发布模型不同，首版不拼接或伪造Worker语义。

目标：可信HTTP集成层可调用`await createWebExecutionService({rootDir,getPlanning,config?,executable?,budget?,previewTimeoutMs?,dependencies?})`，返回`list/start/action/download/shutdown`。getPlanning(projectId,runId)返回可信`{project,run}`；所有对外方法只接受ID、profileId/contractRevision或动作，不接受路径、报告、passed和预算。错误带status和code；DTO沿执行面板约定。HTTP路由及主网页由主Agent后续串行接入。

设计：专属root的SQLite事务日志及单控制器owner；每个project/run唯一活动槽原子拒重，历史尝试不覆盖。执行的规划source/spec/plan快照固定，使用当前hash与v2双审批校验。固定library-web-v1完整任务和验收清单共同形成contractRevision；这是用户显式选择的参考项目，不能声称任意上传业务已经实现。正常默认调用startWebExecution、编码模型和独立Review；taskAccepted只接受完整当前isWebTaskAccepted门禁。

所有执行、预览快照由服务在专属root内生成。预览及下载复核当前审批、候选Git提交/干净状态/源码哈希/保护外壳；预览是新独立受控runtime快照并受时间预算及停止确认约束，下载调用createWebDelivery。DTO仅白名单检查、问题、净化事件和用量，不返回凭据、宿主路径、原始收据或任意对象。

服务是一个本机控制器，不是多Worker调度器。重启发现未完成执行或预览即reconciliation_required，保留活动槽及历史，不依据API重启猜测外部PID已停止，不自动重跑或取消成功。正常shutdown请求停止、等待既有句柄；失去owner后旧回调不能写入新控制器。task-store后续集成需明确映射外层任务租约与执行器内部候选轮次、独立可信收据、共享预算及停止证据。

## 接入契约

- `list({projectId,runId})`返回执行面板的`{capabilities,executions}`；capabilities含profiles/model/budget/reason。profile.contractRevision绑定完整参考任务及HTTP/browser/Review规则。各历史执行显示当次保存的contractRevision和预算。
- `start({projectId,runId,profileId,contractRevision})`返回`{execution}`。不接收路径、报告、任务内容、依赖注入或客户端预算。
- `action({projectId,runId,executionId,action})`支持`cancel/retry/preview/stop_preview`，返回`{execution,preview?}`。cancel先保存cancel_requested，等待真实done才转停止；retry新建UUID和attempt，保留原记录。
- `download({projectId,runId,executionId})`返回`{buffer,filename,contentType:'application/zip'}`。HTTP层负责发送Buffer，不接受调用方提供的来源路径或验收报告。
- `shutdown()`拒绝新启动、持久化取消请求，等待既有执行、预览及在途公共请求，释放owner再关闭SQLite；并发重复调用共用一个关闭Promise。真实执行器已有模型取消和进程终止预算，服务不把停止请求冒充终止确认。

getPlanning必须返回与ID匹配的project/run；run需有workflowVersion=2、冻结sourceSnapshot/sourceRevision、spec/specRevision、tasks、architecture.md、planRevision、specQuestions、两次approvals、passed且无issues的review及stages。仅succeeded或只有export在途的running可启动。工厂await即完成初始化；root须是专用绝对目录，不能是链接。config省略时模型工厂读取已有服务端LLM环境；显式提供config时须由服务端附带所需apiKey，不能从浏览器收取。

预览活跃TTL从runtime就绪后计算；到期先请求正常协议停止，runtime硬截止额外15秒作为启动/停止保护余量。PID、独立工作区、起止时间和停止证据仅保存在专属preview_history，不返回DTO。预览启动前后均复核当前版本；刷新发现审批失效时撤下并停止旧预览。源码核对失败会关闭当前通过权限，进程停止未知则保持reconciliation_required。

## 实际验证与证据边界

- `npm ci --ignore-scripts`：安装精确依赖，无依赖清单修改。
- 普通专测`node --test tests/web-execution-service.test.mjs`最终为18项通过、真实MXC项1项按显式开关跳过；覆盖当前hash/审批、参考范围、事务重复启动及活owner拒绝、取消确认、新attempt历史、旧版本/旧owner拒绝、unknown用量、白名单净化、重启状态、预览复制与TTL、预览停止PID历史、源码核对/版本变化/危险URL、正常重启再次预览及启动竞态。通过收据及预览/下载正向均为显式可信测试依赖，不能作为真实业务验收或真实预览/交付成功的证据。
- 本轮仅运行一次实际MXC失败候选：显式`TASKFLOW_TEST_REAL_SANDBOX=1`及可信本地MXC路径执行专测，当时19/19通过无跳过。真实startWebExecution完成1次允许源码写入并固定候选，HTTP自检failed、任务未通过、编码调用计1、Review未调用、源码下载未开放，用量保持null。编码返回由薄可信fixture注入，没有付费模型调用。之后补充仅预览PID/停止历史、历史预算/contract和公共请求关闭管理；这些由最终普通专测覆盖，遵守最多1次真实失败候选未重复该MXC项，不能把早先实测冒充最终固定提交的独立复验。
- `npm run check`：62个脚本语法通过；`git diff --check`通过，最终仅提交本模块、专测和本文。

未连接HTTP路由或主网页；未真实运行正向模型编码、独立Review、已验收候选预览/下载和全仓回归；未迁移用户JSON或data，未推送或部署。下一步由主Agent在固定提交上独立Review/测试，再串行接入HTTP/UI并重新验证集成版本。task-store未成为运行依赖，主Agent可只cherry-pick本服务提交，忽略参考依赖提交c78e0c1。
