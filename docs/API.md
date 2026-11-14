# 本地原型接口约定

本项目为需求规划与固定参考Web研发工具，单用户本地运行。后端默认监听127.0.0.1:4317，提供静态前端与JSON API。要求Node.js 22.21或以上，以锁定的playwright-core和系统Edge完成独立浏览器检查。

## 数据结构

- Project: `{ id, name, source: { filename, content }, createdAt, updatedAt, runs: Run[] }`
- Run: `{ id, projectId, mode: 'local'|'model', status: 'running'|'paused'|'awaiting_review'|'succeeded'|'failed', createdAt, updatedAt, stages: Stage[], spec: object|null, tasks: DevTask[], artifacts: Artifact[], events: Event[], review: object|null }`
- Stage: `{ id, title, dependsOn: string[], status: 'pending'|'running'|'succeeded'|'failed'|'blocked', attempt: number, startedAt: string|null, finishedAt: string|null, error: string|null }`
- Artifact: `{ name, title, stageId, content, createdAt }`，name 为 spec.md、architecture.md、task.md、review.md、handoff.md 或 plan.json。
- Event: `{ sequence, time, stageId: string|null, level: 'info'|'success'|'error', message }`
- DevTask: `{ id, title, description, category, dependsOn: string[], acceptance: string[], suggestedFiles: string[], requirementIds: string[] }`
- Spec: `{ title, summary, goals: string[], roles: string[], acceptanceScenarios: string[], requirements: [{id,title,description,acceptance:string[],sourceQuote,kind}], constraints:string[], assumptions:string[], questions:string[], stack:{frontend,backend,storage}, sourceMode }`

工作流阶段固定为 intake → spec → [architecture, tasks] → review → export。review 成功后进入 awaiting_review；用户确认后才运行 export。开发任务 DAG 是 tasks 阶段生成的业务产物，与工作流阶段区分展示。

新版运行`workflowVersion:2`在spec成功后增加`awaiting_spec`停点：当前规格确认前不执行architecture/tasks。review成功后的`awaiting_review`表示当前计划等待确认。阶段图仍为六阶段，确认是带版本的门禁。新版Run另有sourceSnapshot/sourceRevision、specRevision/specVersion、planRevision/planVersion、specQuestions、approvals、revisionHistory和decisions。

sourceSnapshot为本次运行不可变原文，导出requirements.md也使用该快照。内容revision采用按键排序的SHA256；问题答复位于spec.clarifications并参与规格标识。所有待确认问题先保守视为blocking，逐项非空回答并保存修订后才可确认。每类修订最多20版，历史仅追加已替换版本的完整快照，当前版本仍在Run本体。

执行服务默认通过ProjectStore.getPersistedRun读取最后成功发布至文件的深复制快照，不能使用尚在保存中的内存审批；写入失败不更新该快照。实时规划GET仍展示当前运行过程。此单控制器文件发布边界不是事务数据库或跨存储事务。

规划决定在同一项目内互斥，先等已进入驱动的停点保存完成再修改审批；其他运行的操作及新建不能保存该待决审批。retry/resume也不能越过同项目其他活动规划。失败回滚后保持原持久化批准状态，仍以当前版本门禁决定是否执行。

## 接口

- GET `/api/health` → `{ok:true, model:{configured:boolean,model:string}, modelPlanning:{engineeringMaxCalls,engineeringTimeoutMs}, supportedFormats:['.md','.txt','.docx']}`。工程规划预算来自当前编排器，不包含凭据。
- GET `/api/projects` → `{projects:[{id,name,createdAt,updatedAt,filename,lastRunStatus,runCount}]}`
- POST `/api/projects`，JSON `{name?,filename,content? ,fileBase64?}` → 201 `{project}`。文本使用 content，DOCX 使用 fileBase64。
- GET `/api/projects/:pid` → `{project}`
- POST `/api/projects/:pid/runs`，JSON `{mode:'local'|'model',failOnceStage?:'tasks'|'architecture'|'review'}` → 201 `{run}`，后台异步启动。单个项目同一时间只允许一个活动运行。
- GET `/api/projects/:pid/runs/:rid` → `{run}`
- POST `/api/projects/:pid/runs/:rid/action`，JSON `{action:'pause'|'resume'|'retry'|'approve',stageId?,feedback?}` → `{run}`。暂停为阶段边界暂停，运行中任务完成后不启动后继；失败运行结束后重试 failed 节点，保留成功分支。approve 仅在 awaiting_review 接受，可附审阅意见。
- GET `/api/projects/:pid/runs/:rid/artifacts/:name` → 文本文件，`?download=1` 添加下载头。
- GET `/api/projects/:pid/runs/:rid/download` → 成功运行的 ZIP 文档包。

错误统一 `{error:'面向用户的原因'}`。用户输入错误为 400，未找到为 404，状态冲突为 409，服务错误为 500。请求 JSON 上限 6 MB，DOCX 文件上限 3 MB，解析后文本上限 100000 字符。

### 新版规划确认动作

仍使用同一action路由，所有动作服务端串行校验；过期/缺少revision、重复批准、在途阶段及无效状态返回409。`feedback`可选，驳回时必填。旧`approve`仅允许无workflowVersion的v1记录导出，新版必须两次确认。

- `approve_spec {revision,feedback?}`：仅awaiting_spec，当前全部阻塞问题已答且本版未被驳回。确认后才开始架构/任务。
- `revise_spec {revision,spec?,answers?:{问题id:答复},feedback?}`：可在两个等待停点修改；校验规格结构及原文引用，回答按服务端问题重建，不信任客户端clarifications。必须有实际内容变化；新版本清除两审批与当前下游结果并回awaiting_spec，历史保留。
- `reject_spec {revision,feedback}`：记录理由，本版不可再批准；须保存新修订。
- `approve_plan {revision,specRevision,feedback?}`：仅awaiting_review，规格确认有效、当前计划及结构检查一致后导出。
- `revise_plan {revision,tasks,feedback?}`：仅awaiting_review，校验真实依赖图、需求映射和非空验收，保存新计划并重新结构检查；非法任务原子拒绝，保留可编辑状态。
- `reject_plan {revision,feedback}`：记录理由并阻止批准同版，须实际修订后再确认。

approvals为`{spec:null|{revision,at,feedback},plan:null|{revision,specRevision,at,feedback}}`。specQuestions为`[{id,question,answer,blocking:true}]`；decisions记录`{action,revision,specRevision,at,feedback,newRevision?}`。revisionHistory.spec/plan为已替换版本`{version,revision,specRevision,at,spec,specQuestions,tasks,artifacts,stages,review,approvals}`。确认和修订不会把文档完成升级为代码完成。

仍未答复的既有blocking问题不能通过删掉或替换questions解除，必须先答复并保存处理依据。页面计划审阅可返回规格编辑；保存新规格后旧确认失效，重新经过规格确认和规划。尚未保存的草稿不是已批准规格。

### 新版模型工程规划

新版model运行在规格确认后，由architecture/tasks共享一次工程模型请求，生成经校验的实体、角色/接口、页面选择器和任务。DevTask增加writePaths/inputs/outputs，suggestedFiles与writePaths保持一致；计划版本另外绑定完整engineeringPlan，人工改任务同步更新草案/hash及架构。原接口、实体、页面及全图可写文件集合不能通过任务编辑改变；规格回修后重新规划。local/v1仍使用旧规则，无engineeringPlan时旧计划hash公式保持不变。

每运行默认最多3次工程适配器尝试，单次60秒；失败不静默回退规则。engineeringCalls记录尝试预留，不等于已证实收费请求数。engineeringHistory只公开版本、状态、模型/用量、结束枚举及回执摘要；原四字段回执仅保存在data/.private，不能进入导出包。用量未知为null；回执IO超时/取消后未确认标unconfirmed，迟到结果不能发布。最终保存失败撤回草案及成功状态，公开固定persistence_failed，不传播底层路径/异常。工程草案仍为structural_only、待开发且须计划确认，不授予执行权限。

## 内部规划函数

`lib/planner.mjs` 导出：

- `analyzeRequirements(sourceText, projectName)` → Spec（同步、本地模式）
- `analyzeWithModel(sourceText, projectName, options?)` → Promise<Spec>（模型模式）
- `generateTasks(spec)` → DevTask[]
- `renderSpec(spec)` → Markdown
- `renderArchitecture(spec)` → Markdown
- `renderTasks(spec,tasks)` → Markdown
- `reviewPlan(spec,tasks)` → `{passed:boolean,issues:string[],coverage:[{requirementId,taskIds:string[]}],summary:string}`
- `renderReview(review)` → Markdown
- `renderHandoff(spec,tasks,review,feedback='')` → Markdown
- `validateTaskGraph(tasks)` → void（非法依赖或环时抛 Error）
- `getModelConfig()` → `{configured,model,baseUrl}`（不返回密钥）

`analyzeWithModel`的可信options可含config/fetchImpl/signal/timeoutMs/onReceipt，不从HTTP注入函数或配置。保留裸JSON及JSON代码围栏的正常stop响应和原文引用校验；仅stop可接收，未知结束状态拒绝。请求最多768KiB、实际响应流1MiB、正文512KiB，总截止覆盖连接、读取和可选回执。已知配置凭据进入输入会拒发，正文回显先遮蔽再拒绝；错误不透传底层正文或路径。可选四字段私有回执不改变Spec返回结构；当前编排器尚未使用该hook记录规格用量，不据此宣称统一预算或完整停止已接通。

## 状态和持久化

### 独立编码试验的内部接口

本轮不新增 HTTP 路由，规划 Run、DevTask 和现有成功状态含义保持不变。命令入口为 `npm run execution:check -- --fixture|--model`。

`startTaskExecution({outputDir, provider, sandbox, reviewer?, reviewerKind?, providerKind?, signal?, maxCalls?, maxReviewCalls?, timeoutMs?, onEvent?})` 返回 `{id, cancel(), done}`，`done` 解析为持久化执行记录。该接口供平台可信代码调用，尚不接受网页上传任务或任意仓库。调用方不得把适配器注入接口直接暴露给客户端。

- 任务固定为 `library-borrow-v1`；模型只返回 `src/borrow.mjs` 的完整替换建议，不能设置命令、路径根、环境、验收和版本。
- 每次执行记录 taskId、attemptId、specRevision、planRevision、基础/候选提交、验证清单版本/用例及观察器哈希、平台源码标识/Node版本、每次候选检查、命令结果和用量。未知 token 数为 null。
- 状态为 preparing、checking_environment、generating、validating、awaiting_acceptance，以及终态 executed、accepted、failed、stopped、timed_out、reconciliation_required。accepted仅指固定任务的双结论门禁通过，不是完整软件交付。
- `cancel()` 幂等请求取消；候选进程是否停止依据适配器确认，无法确认时保持 reconciliation_required。
- 代码输出限制32KiB、各模型响应128KiB、进程输出64KiB；编码和Review各最多3次请求、总时长最多600秒。命令入口各默认2次、共180秒，单次候选执行最多15秒。调用按role/kind保存，共享总用量中任一实际请求无回执时为null；诊断调用不计入totalModelCalls。
- `execution.json` 与候选工作区在本地 output 中保留。进程意外中断后记录可能仍是运行状态，需要人工核对实际进程；本轮不提供后台恢复或多进程认领。

模型接口为 `createCodeModel({config?,fetchImpl?})` 返回的异步文件建议函数；沙箱接口为 `createWindowsSandbox({executable?,nodeExecutable?})` 的 `preflight` 和 `run`。生产入口预检失败关闭，不提供无保护执行选项。

### 同版本独立验收

命令入口默认启用双检查。`createReviewModel({config?,fetchImpl?})`返回独立Review函数，只接收`{task,files,previousIssues,signal}`，输出`{summary,issues,resolutions,model,usage}`；不传编码会话或测试结论。问题必须有blocking/advisory级别、当前文件行号及逐字代码证据；历史阻塞问题id必须逐项复验。响应无效不当作无问题。

`runCandidateAcceptance({rootDir,candidate,source,sandbox,reviewer,previousIssues?,assertCurrent,signal?,reviewKind?})`只供可信服务调用。`candidate`包含taskId、attemptId、specRevision、planRevision、candidateCommit、sourceHash；服务添加manifestHash、reviewPolicyHash、validationId并统一绑定两方记录。源码由执行器从Git对象读取并核对工作文件；测试与Review使用不同快照。固定测试入口不接受候选提供的命令、用例或passed标记。

门禁记录在`acceptance/validation-*/acceptance.json`；状态为checking、passed、diagnostic_passed、changes_requested、error、invalidated、cancelled、reconciliation_required。任何一方出错也等两方结束后再决定返工。passed须独立测试通过、Review完成且全部阻塞意见关闭；diagnostic_passed不能计为真实验收。检查前后核对原候选和两份快照，陈旧结果无效。每个新候选重新检查，不继承旧通过结果。

执行记录的versions[].acceptance保存完整结论及历史，acceptanceStatus保存最近门禁状态。`isTaskAccepted(record)`只接受当前候选、当前清单/Review规则、完整角色绑定且passed的记录；兼容self_check模式、诊断、旧版本和缺少结论均返回false。底层省略reviewer仅用于兼容自检，不开放任务完成状态。

### 现有规划记录

规格和原始需求在运行中冻结。再次运行创建新 run_id，重试保持同一运行且递增 attempt。输出归属当前运行；只有成功的阶段发布产物。服务重启时将中断运行转为 failed，用户可重试，无自动恢复承诺。配置 `.env` 在启动时读取，密钥只保存在服务端。

### 多文件Web执行、复验与源码交付

以下为可信内部组件及命令入口；网页固定参考执行路由见下一节，既有规划download继续是文档包。

- `startWebExecution({outputDir,binding,provider,reviewer,providerKind?,reviewerKind?,executable?,signal?,maxCalls?,maxReviewCalls?,timeoutMs?,onEvent?,assertCurrent?})`返回`{id,cancel,done,snapshot}`。任务固定为`library-web-v1`，调用方提供project/run/task及spec/plan版本；候选增加attempt、Git提交、sourceHash、HTTP/browser清单与Review策略哈希。CLI为`npm run web:check -- --model`，默认编码/Review各3次、共600秒。
- 允许最多60个、单文件128KiB、合计2MiB的文本源码文件，仅开放`src/public/migrations/tests/docs`及根README。package、lock、server、runtime和平台入口由控制器保护。模型不提交Shell命令、环境或验收结论。应用仅导出受保护worker约定的`createApp/handle`；候选仅在MXC内运行，不在宿主导入。
- 新候选先完成18项HTTP/SQLite自检，再并行运行全新独立HTTP/SQLite、21项Edge和Review。每次修复形成新Git提交并重检。`isWebTaskAccepted`统一检查当前身份、完整清单、数据库观察、正常进程停止和Review阻塞；fixture/diagnostic不能通过真实验收。
- 编码和Review适配器支持私有`onReceipt({model,finishReason,usage,content})`。回执在结构检查前保存并有大小限制；异常结束、凭据回显、存储失败不升级为有效建议。仅纯格式错误允许在原次数预算内纠正一次；未知用量保持null。Review接收平台生成的逐行编号，返回行号及逐字证据必须一致。
- `inspectWebRecheckSource({executionRoot,sourceReportPath,sourceBinding?,signal?})`只读核对可信根内原`web-execution-*`记录、模型回执、当前Git blob/HEAD/干净状态、源码及保护外壳。可信sourceBinding仅含projectId/runId/taskId/specRevision/planRevision，逐项匹配原记录；省略时保持CLI固定规格校验。它不代表审批，服务另查当前双确认。`startWebRecheck({...上述来源,outputDir?,reviewer,reviewerKind?,executable?,signal?,timeoutMs?,maxReviewCalls?,onEvent?,assertCurrent?})`只建同源新快照，不改原Git或原报告；默认输出至executionRoot，也可由可信服务指定另一个自有根。快照无伪造.git，provenance记录原报告hash、原提交/回执和来源绑定。编码调用0，模型用量只计本次新Review；全部检查重跑，最后仍调用同一完整门禁。命令默认为只读，付费模式须同时`--run --model-review`，不开放新来源绑定参数。详见[复验协议](tasks/web-recheck.md)。
- `createWebDelivery({files,binding,report,requirements,spec,plan})`只接受当前同版本完整通过结论，返回`{zip,manifest}`。包包含源码、保护外壳、需求/规格/计划及白名单验收摘要；排除数据库、真实.env、原始模型回执和私有日志。manifest逐文件哈希，不把归档历史声明当作新验收。
- `inspectWebArchive(bytes)`有界检查平台ZIP格式、路径、CRC、清单与当前保护外壳；不在宿主导入包内代码。`revalidateWebArchive({archiveFile,outputDir,executable?,signal?,timeoutMs?})`在新副本执行固定HTTP/SQLite与Edge，默认120秒、上限600秒。成功为`checks_passed/taskAccepted:false/historicalAcceptanceVerified:false`，表示本次检查通过，未获得新的模型Review。命令为`npm run web:verify -- --archive <路径>`。

停止请求与停止确认分开：源变化、预算耗尽或取消停止新阶段；未确认进程退出时保留PID和控制/预检目录，标为`reconciliation_required`。当前CLI仍无多Worker认领、后台恢复或任意需求执行承诺。

### 网页固定参考项目执行

入口为`/api/projects/:pid/runs/:rid/executions`。只允许实际回环连接、localhost/127.0.0.1/IPv6回环Host及当前监听端口，拒绝跨站访问与DNS重绑定Host；有Origin的更改还须与工作台同源。这是本机单用户边界，不是团队身份认证。

- GET基础路径 → `{capabilities:{canStart,profiles:[{id,title,description,contractRevision}],reason,model:{name},budget},executions:[ExecutionDTO]}`。模型名称不包含凭据，未知用量为null。
- POST基础路径`/start`，仅`{profileId,contractRevision}` → 202 `{execution}`。服务重新核对当前v2规格、计划、来源hash、双确认及结构检查，固定参考范围版本必须匹配；同一规划存在编码、预览或未确认停止时409。上传内容仅关联快照，不传给参考模型，不视为命令或完成范围。
- POST基础路径`/:eid/action` → `{execution,preview?}`。收费动作retry/recheck必须提交`{action,profileId,contractRevision}`，匹配当前明确选择的参考范围；缺少400、过期409，旧页面不能按新契约自动收费。cancel/preview/stop_preview只接受`{action}`。cancel先记录请求，再等真实停止；retry使用当前审批新建编码尝试，不覆盖原历史。recheck仅复用服务自有、已正常停止的原始模型候选，创建0编码的新检查尝试，完整重跑HTTP/SQLite、浏览器及最多2次Review；旧验收规则的代码可以重检，旧通过结论不能继承。preview仅为当前已验收源码建立独立数据副本，有期限且占用活动槽；启动中停止保留实际PID及停止结果。
- GET基础路径`/:eid/download` → `application/zip`。重新核对当前规划、源码文件/Git对象/保护外壳及完整验收门禁后才创建交付包；不接受客户端路径、报告、预算或通过标记。

ExecutionDTO包含执行编号、尝试、范围、状态、是否通过、调用次数、用量/预算、版本/差异、事件、错误、预览及服务端actions许可。检查项只公开id/name/passed和净化后的可选error/expected/actual文本，每字段最多2000字符；不公开工作区路径、模型原始回执、PID/control/probe或进程stdout。Review问题含相对文件/行号与处理记录，全部作为文本展示。

复验DTO另有kind:web_recheck、来源服务执行编号/提交、recheckBudget和当前复验范围版本；actions.canRecheck仅为轻量按钮条件，实际动作在模型调用前深查原私有报告/真实Git/回执和当前归属。来源根、输出根和绑定只由服务私有记录派生，客户端不能传。预览/下载对复验快照另外重验来源provenance和全部文件字节，不以缺少.git放宽原始编码候选的Git校验。

服务持久化在独立SQLite中，原规划JSON不迁移。owner与活动槽事务控制同run拒重；每次状态控制递增版本，异步结束重新核对，取消或待协调不能被迟到成功覆盖。`source_history`和`preview_history`私有保留正常及未知停止证据。旧双活存档迁移保留多个待协调历史而不撞唯一索引；未知进程不自动当作已停止，阻止新的活动。该单控制器生命周期不等于多Worker租约/可靠恢复，正式TaskStore及通用验收模型尚未接入此链路。

可信程序可`createApp({executionService?,executionRootDir?})`注入服务；`executionService:null`明确关闭网页执行。`startServer({loadEnv:false})`允许测试/嵌入宿主跳过本地.env读取，默认仍加载配置。这些选项不通过HTTP暴露。
