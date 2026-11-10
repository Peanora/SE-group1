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

规格和原始需求在运行中冻结。再次运行创建新 run_id，重试保持同一运行且递增 attempt。输出归属当前运行；只有成功的阶段发布产物。服务重启时将中断运行转为 failed，用户可重试，无自动恢复承诺。配置 `.env` 在启动时读取，密钥只保存在服务端。
