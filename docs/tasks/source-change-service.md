# F05 输入版本服务

基准27072ea；纯契约依赖f63c18b/7645639，本树依赖提交e6e97c0/51e2429。本轮仅source-change-service、store、orchestrator及相关测试/记录，不改HTTP、前端、执行器或依赖。

## 契约

- `createSourceChangeService({rootDir,store,withCheckpoint})` 是可信单控制器工厂，返回 list/request/apply/shutdown；用户操作只传纯JSON编号、版本、source/reason/kind/requestKey，不接受路径、函数或原始报告。私有SQLite独立保存最多20条请求/项目，不与阶段JSON写入争抢字段。
- request只登记pending，可在规划执行中提交；同project/requestKey同body幂等，不同body409。请求不自动应用，不改代码、数据库或审批。
- 工厂异步，list/request同步返回数据，apply/shutdown返回Promise。Change字段为id/projectId/requestKey/baseRevision/source/reason/kind、generation（原输入代次）、sourceRevision（目标内容hash）、status、draft/projection、appliedDraft/appliedProjection/appliedGeneration、error/createdAt/updatedAt；不包含根目录或数据库路径。requestKey为1..128位字母数字下划线横线。状态仅pending/applying/applied/apply_interrupted；中断请求保留且不能重放，须显式提出新requestKey。
- apply要求changeId/baseRevision/generation精确匹配，安全停点由组合 `orchestrator.withProjectCheckpoint(pid,()=>executionService.withProjectCheckpoint(pid,work))` 提供。规划锁同步获取，任何阶段/drive/action/create在途均409；不等待模型结束、不强停进程。锁期间无新派发，旧排队闭包不得恢复旧源。
- 项目JSON发布字段为sourceVersions/currentSourceRevision/sourceGeneration/appliedChangeId，旧项目无字段按当前正文contentRevision及generation0解释。首次发布补genesis，版本最多20（含genesis）。SQLite先记applying意图，JSON副本先保存再同步发布原project及oldrun对象字段，最后补记applied；两库没有共同事务。
- 失败未发布则内存/审批/输入版本保持，意图记apply_interrupted；重启若JSON changeId/版本精确匹配则仅补记applied，否则保留中断，不自动重放。重复applied仅返回原记录，不重复写源。故障记录、旧请求和旧结果保留。
- JSON已发布但SQLite最终确认失败时返回503 publication_pending_confirmation并保留applying，阻止后续源应用覆盖尚待核对的标记；重启核对sourceVersions最后项changeHash等绑定后只补记。源JSON的原子rename不是跨库事务，也不证明fsync级断电耐久性。
- 所有旧run标sourceSuperseded只读，不改原spec/plan hash或审批，无法approve/resume/retry/dispatch；不再阻挡新run。已有sourceSnapshot不改，无快照legacy在首次变更时冻结旧正文作为历史回退来源。新run冻结新source及generation，plan.json对已知代次额外导出sourceGeneration，不继承任何旧通过结论。即使明确回退为旧文本、sourceRevision再次相同，generation及旧run标记也阻止审批/请求/旧save复活。
- previousPlan从当前同源最新run安全投影，apply时重新生成；无法精确表达则省略投影并标unknown/allDownstream。规划结构检查不冒充软件测试通过。影响保持conservative_all、全回归、新spec/plan确认；kind仅标签，迁移审查不执行迁移。

## 验收

仅临时JSON/SQLite与可信执行停点mock，0 API/用户data/模型/候选运行。验证pending与在途阶段不丢字段、双apply/幂等与旧base、checkpoint与create/审批/resume竞态、落盘失败和跨库恢复、旧queued save/dispatch、门禁等待可换源、历史快照与新run、链接/owner/纯输入/限额。固定提交后非作者Review，尚未接入产品F05或迁移执行。

实现自检已完成，候选固定后等待非作者独立Review，未接入产品。

## 集成依赖

执行侧checkpoint由并行固定92099dca提供，必须按规划外层、执行内层组合；本轮只用可信执行状态mock验证组合与错误净化，不改执行服务。root的项目action协调补丁4df6c8d正在独立审查，尚未pick本树；checkpoint已检查可选projectActions及actionBusy/active/driving/create在途。后续串行集成须保留该补丁的projectActions、driveIdle与回归，不把本轮JSON缓存/锁当成完整事务或用本候选覆盖新协调逻辑。

合并时还须将createRun及retry/resume的其他ACTIVE检查与sourceSuperseded保持一致，避免历史running/paused记录阻塞当前输入的新运行恢复。本候选未修根分支另报的同代次跨run审批写入问题，不能单独替代该协调补丁。

## 实际检查

- source-change-service专项17项（含两个真实可信控制器子进程分别在JSON发布前/后退出）；orchestrator新增2项checkpoint回归。只运行作者控制的测试程序，不运行生成业务代码。
- 联合命令：`node --test --test-concurrency=4 tests/source-change-service.test.mjs tests/store.test.mjs tests/orchestrator.test.mjs tests/planning-review.test.mjs tests/requirement-changes.test.mjs tests/engineering-planning-integration.test.mjs tests/server.test.mjs`，**91/91通过，0失败/取消/跳过，1724.5989ms**。覆盖真实SQLite/JSON、实际rename失败、SQLite最终确认故障、跨库退出恢复、pending/申请/审批/创建/恢复竞态、旧闭包/旧save、代次回退、owner/link/限额、原工程和HTTP回归。日志位于主工作区忽略目录output/verification/source-change-service-related.log。
- 五个变动脚本分别node --check通过，git diff --check通过。未运行付费API、MXC/浏览器、全仓回归或数据库迁移。
- 初轮source专项的外部测试SQLite连接晚于fixture目录删除才关闭，已统一登记清理先关连接；初轮联合中旧工程恢复fixture曾读到尚未落盘的running态，save保持原直接队列Promise时序后后续通过，root协调补丁另含该fixture先shutdown修正。旧失败日志保留，不将其计为通过。
- 接下来独立审查本固定组件，再串行合并已独立确认的规划协调/执行checkpoint并做服务接入集成验收；不据本轮自检宣称产品F05、三类迁移或多Worker事务已完成。
