# 本地原型接口约定

本项目为软件开发需求规划工具，单用户本地运行。后端默认监听 127.0.0.1:4317，提供静态前端与 JSON API。无需安装运行依赖，要求 Node.js 22 或以上。

## 数据结构

- Project: `{ id, name, source: { filename, content }, createdAt, updatedAt, runs: Run[] }`
- Run: `{ id, projectId, mode: 'local'|'model', status: 'running'|'paused'|'awaiting_review'|'succeeded'|'failed', createdAt, updatedAt, stages: Stage[], spec: object|null, tasks: DevTask[], artifacts: Artifact[], events: Event[], review: object|null }`
- Stage: `{ id, title, dependsOn: string[], status: 'pending'|'running'|'succeeded'|'failed'|'blocked', attempt: number, startedAt: string|null, finishedAt: string|null, error: string|null }`
- Artifact: `{ name, title, stageId, content, createdAt }`，name 为 spec.md、architecture.md、task.md、review.md、handoff.md 或 plan.json。
- Event: `{ sequence, time, stageId: string|null, level: 'info'|'success'|'error', message }`
- DevTask: `{ id, title, description, category, dependsOn: string[], acceptance: string[], suggestedFiles: string[], requirementIds: string[] }`
- Spec: `{ title, summary, goals: string[], roles: string[], acceptanceScenarios: string[], requirements: [{id,title,description,acceptance:string[],sourceQuote,kind}], constraints:string[], assumptions:string[], questions:string[], stack:{frontend,backend,storage}, sourceMode }`

工作流阶段固定为 intake → spec → [architecture, tasks] → review → export。review 成功后进入 awaiting_review；用户确认后才运行 export。开发任务 DAG 是 tasks 阶段生成的业务产物，与工作流阶段区分展示。

## 接口

- GET `/api/health` → `{ok:true, model:{configured:boolean,model:string}, supportedFormats:['.md','.txt','.docx']}`
- GET `/api/projects` → `{projects:[{id,name,createdAt,updatedAt,filename,lastRunStatus,runCount}]}`
- POST `/api/projects`，JSON `{name?,filename,content? ,fileBase64?}` → 201 `{project}`。文本使用 content，DOCX 使用 fileBase64。
- GET `/api/projects/:pid` → `{project}`
- POST `/api/projects/:pid/runs`，JSON `{mode:'local'|'model',failOnceStage?:'tasks'|'architecture'|'review'}` → 201 `{run}`，后台异步启动。单个项目同一时间只允许一个活动运行。
- GET `/api/projects/:pid/runs/:rid` → `{run}`
- POST `/api/projects/:pid/runs/:rid/action`，JSON `{action:'pause'|'resume'|'retry'|'approve',stageId?,feedback?}` → `{run}`。暂停为阶段边界暂停，运行中任务完成后不启动后继；失败运行结束后重试 failed 节点，保留成功分支。approve 仅在 awaiting_review 接受，可附审阅意见。
- GET `/api/projects/:pid/runs/:rid/artifacts/:name` → 文本文件，`?download=1` 添加下载头。
- GET `/api/projects/:pid/runs/:rid/download` → 成功运行的 ZIP 文档包。

错误统一 `{error:'面向用户的原因'}`。用户输入错误为 400，未找到为 404，状态冲突为 409，服务错误为 500。请求 JSON 上限 6 MB，DOCX 文件上限 3 MB，解析后文本上限 100000 字符。

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
