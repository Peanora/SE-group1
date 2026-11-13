# SQLite 事务任务存储组件

## 本轮目标与边界

基准为 `255de18`，本轮只新增 `lib/task-store.mjs`、专用测试和本文。目标是用独立临时 SQLite 数据库验证任务认领、版本门禁、租约、预算和历史事件的事务一致性。旧规划 JSON、现有 `store.mjs`、HTTP 接口和执行器均未接入或迁移。本组件不代表平台已经接通多 Worker，也不启动或停止任何业务程序。

Node.js 要求沿用当前已验证的 >=22.21；使用内置 `node:sqlite`，不引入运行依赖。SQLite 开启 WAL、外键、5 秒 busy timeout；每个变更操作使用 `BEGIN IMMEDIATE`，认领与预留、完成与释放下游在同一事务中。

## 能力句柄与最小 API

`openTaskStore({filename,now?})` 返回 `{control,worker,query,close}`。filename 必须为存在可信父目录下的绝对数据库文件，数据库及附属文件、父目录拒绝链接。now 仅供可信控制器/确定性测试提供，生产默认 Date.now。返回对象不暴露 DatabaseSync 或任意 SQL。

control 句柄仅留给可信控制器。交给 Worker 的对象只有 worker；这种 Node 闭包分工不是跨进程身份认证，也不能替代候选程序的操作系统隔离。后续执行服务必须自行提供受控 IPC、数据库访问隔离、凭证与真正的进程停止证据。

- `control.createRun({projectId,runId,projectRevision,specRevision,planRevision,tasks,budget:{calls,tokens},deadlineAt})`：创建版本 1。
- `control.replacePlan({runId,expectedVersion,projectRevision,specRevision,planRevision,tasks})`：原子切换完整新版本。旧记录保留，不自动复用旧完成结论，预算仍为该 run 共享。
- `control.pause(runId)`、`resume(runId)`：只改变新派发；有效在途租约仍可保存、验证和完成。
- `control.sweepExpired()`：把过期租约标为 expired，任务可用独立新 attempt 重领，旧进程仍 unknown。
- `control.requestCancel(runId)`：保存 cancel_requested，不声称进程已停。
- `control.confirmStopped({attemptId,evidenceId})`：仅由已核实实际进程状态的可信控制器调用。组件只记录关联，不执行进程核查。
- `control.confirmCancel(runId)`：仍有未知尝试时返回 reconciliation_required，所有尝试停止已确认才为 cancelled。
- `control.recordValidation({lease,validationId,receipts})`：专属可信验证发布入口，见下文。
- `control.settle({attemptId,settlementId,usage:{calls:number|null,tokens:number|null}})`：仅使用可信调用账单结算；null 保留对应预留，不能自动当零；已确认值不可改写，已最终结算后不可换编号再记账。
- `worker.claim({runId,workerId,leaseMs?,reserve?})`：默认 30 秒，最多 600 秒；返回 `{lease,task}` 或 null。reserve 可省略；若提供必须与控制器固定的 task.reservation 完全一致，不能声明零或缩小预留。
- `worker.heartbeat({lease,leaseMs?})`：返回 `{current,lease}`，有效租约续期不越过 run.deadlineAt。
- `worker.publish({lease,publicationId,candidateCommit,sourceHash,artifacts?,resultHash?})`：固定当前尝试的唯一候选，只保存提案。resultHash 由平台按绑定和内容计算；客户端若声明必须相同。返回 `{duplicate,current,lease,resultHash}`。发布后调用方使用更新后的 lease。
- `worker.finish({lease,validationId,outcome?,reason?})`：默认 completed，必须引用最新、完整、同版本且通过的可信验证。failed 需原因，只关闭该尝试并允许新尝试，不释放下游。
- `query.getRun(runId)`、`getTask(runId,taskId,version?)`、`listAttempts(runId)`、`events({after?,limit?,runId?})`：返回数据副本。events 返回 `{cursor,events}`，seq 在整个数据库中全局递增且唯一。

所有输入错误带 code=`invalid_input`；身份/候选/状态冲突为 `stale_lease`、`stale_candidate`、`conflict`、`validation_required` 等明确错误。版本正确但过期、被替换或取消的晚结果可追加历史并返回 current:false，不能变更当前任务完成状态。重复有效回调不重复事件、计量或释放；同编号对应不同内容冲突。

## 任务与验收契约

任务必须有：id、description、非空 inputs/outputs/writablePaths/acceptance、dependsOn、40 位 baseCommit、固定 reservation，以及 manifests。依赖编号必须唯一存在且无环；可写范围为无越界的相对 POSIX 元数据，不作为实际文件写权限使用。

三份清单由控制器创建任务时固定：

```text
manifests = {
  test:    {hash: SHA256, checkIds: ['受控测试编号', ...]},
  browser: {hash: SHA256, checkIds: ['受控浏览器检查编号', ...]},
  review:  {hash: SHA256}
}
```

每次认领新建 attemptId、单任务递增 generation、随机 leaseToken 和唯一 workspaceKey，Worker 无权提供绝对工作区路径。租约绑定项目/运行/任务、project/spec/plan 版本、baseCommit 及三份清单哈希；候选固定后同时校验 candidateCommit/sourceHash。workspaceKey 只是标识，后续执行服务仍需真正创建独立受控工作区。

receipts 必须包含 test/browser/review，每份都有 `role`、`kind:'independent'`、`manifestHash` 和完整 binding。binding 包含 projectId/runId/taskId/attemptId/generation、projectRevision/specRevision/planRevision、baseCommit、manifestHash/browserManifestHash/reviewPolicyHash、candidateCommit/sourceHash；不向收据复制 leaseToken。

- test/browser：status 为 passed/failed/error，terminationConfirmed 为布尔；checks 必须精确覆盖固定 checkIds，每个唯一编号有布尔 passed。
- review：status 为 completed/error；issues 为有界列表，问题有唯一 id、severity blocking/advisory、status open/resolved、非空 evidence。
- 只有两份检查 status=passed、全部检查 passed=true、终止已确认、Review completed 且没有未关闭 blocking 问题时 eligible=true。
- 即使收据内容通过，过期或旧版本仍 current=false。有效未关闭尝试的新失败收据会成为最新结论，重复旧通过收据不能把它覆盖回通过。已完成、过期或被替换尝试的晚收据仅存历史，不改写完成时固定的收据；发现需要重新审查的业务问题应由控制器形成新版本/新尝试，不把晚回调当作自动撤销已释放下游的机制。

本组件核对的是可信验证入口所记录的完整绑定与结构，不自行运行测试，也不把任意调用者写入的 accepted/passed 布尔当作实际软件证据。执行服务接入时必须继续校验真实固定清单、进程、候选 Git 版本及验证来源，再调用 control。

## 表与数据流

- runs / run_versions：项目、当前版本、运行状态、截止时间和总预算；各版三份内容标识保留。
- tasks / dependencies：按 run/version 唯一的任务及 DAG。
- attempts：Worker、generation/token、到期时间、候选、workspaceKey、终止/取消状态和验证引用。
- publications / validations / finishes：唯一发布、不可变验收收据和完成回调；重复内容校验后幂等。
- reservations / settlements：认领先预留，实际已知用量只结算一次；失联、失败、过期与换版不释放未知预留。实际超出预留也保存实际值，后续认领按真实剩余预算拒绝。
- events：全局 AUTOINCREMENT seq，支持按游标补齐。

就绪任务 → 事务预留及租约 → 固定候选 → 控制器写独立收据 → 事务完成当前任务 → 依赖查询允许下游。超时与版本切换不更新实际进程状态，旧结果与未知消耗均保留。

## 验证与下一步

实际执行 `node --test tests/task-store.test.mjs`：19/19 通过，无跳过。测试使用临时数据库和可信测试子进程，不访问用户 data、不调用模型、不执行生成代码。两个真实子进程分别验证抢同任务和抢共享预算；其余覆盖完整门禁、幂等发布/完成/结算、过期晚结果、重启、版本切换、未知及部分已知用量、超预留实账、暂停取消、失败返工和事件游标。另执行 `node --check lib/task-store.mjs` 与 `node --check tests/task-store.test.mjs` 均通过。固定提交前检查暂存差异。

未运行现有执行服务的集成链路；没有迁移配置或数据。下一步是先独立审查本组件，再由控制器适配真实执行服务与独立验证结果，明确跨进程身份、实际工作区和停止核对，不直接把 worker 句柄暴露为 HTTP 接口。
