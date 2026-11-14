# 独立测试提案规划服务

基线`f17671f48caffcdf08a702671e2938989986b2be`。仅新增本记录、`lib/verification-planning-service.mjs`和对应测试；不接server/UI/编码执行，不调用真实API。

## 最小契约

`await createVerificationPlanningService({rootDir,getPlanning,config?,maxAttempts=3,timeoutMs=60000,cleanupMs=250,dependencies?})`。root是可信独占目录，`getPlanning(projectId,runId)`仅返回成功持久发布的`{project,run}`；可信dependencies仅createModel（默认createVerificationModel）、writeReceipt（默认0600/wx写入）、同步isProcessAlive。config仅baseUrl/model/apiKey?；省略时沿用现有LLM设置，显式null拒绝。maxAttempts可设1..3、timeoutMs可设1..60000、cleanupMs可设1..2000供可信测试降低预算。所有客户端方法检查own-data并在首次await前复制；不接收依赖、宿主路径、文件、通过标记或可信manifest。

- `list({projectId,runId})`返回capabilities及proposals；propose须`{projectId,runId,contractRevision}`精确匹配当前模型/端点/规则/预算契约。只公开契约hash，不公开端点或凭据。每run最多3次SQLite BEGIN IMMEDIATE原子预留，每项目跨run共享活动槽，不因失败/未知用量退还；预留后返回generating，后台完成才成为draft。attempt是尝试计数，不声称已发生收费API。页面只能以新list状态显示后台完成，不能按时间推断。
- `revise({projectId,runId,proposalId,revision,proposal,feedback})`验证纯DSL及真实内容变化；`approve/reject({projectId,runId,proposalId,revision,feedback})`绑定当前版本。拒绝过的同上下文相同manifest不能通过重提或重启洗掉；修订/拒绝会撤销当前批准，重复批准不重造记录。
- `cancel({projectId,runId,proposalId})`仅请求停止，后台确认后变cancelled，不能取消的未知写入/请求保留reconciliation_required；`shutdown()`拒新请求、取消在途读取/模型并有界等待模型与回执清理，同时等待已进入的可信checkpoint工作。
- `withProjectCheckpoint(projectId,work)`同步阻止同项目新收费/编辑/审批；项目任何run的generating/未知状态及入场async getPlanning都使获取失败，异项目不受影响。callback值/原异常透传，finally释放；关闭等已进入工作，callback不可await本服务shutdown形成自等待。根后续再组合规划/执行/提案三服务检查点。

必须workflow2当前source/hash/generation、spec与plan双确认、review通过且当前engineering草案/任务一致。没有工程草案仅可查看历史，不猜API。模型只收到确认spec摘要/需求、任务边界及工程实体/接口/页面/角色；不传上传原文、候选源码、实现输出或测试结果。当前绑定包含source代次、spec/plan、工程hash、上下文hash及策略，源变/旧owner/取消/超时不发布迟到提案。

project/run的sourceGeneration分别校验，显式值必须非负safe integer；仅缺失或undefined可按旧形状归0，然后两侧必须相等。null、负数、小数、非有限数、字符串或对象都不得补造有效归属；currentSourceRevision、sourceSuperseded和原来源hash的门禁继续保留。代次异常时不预留付费尝试，也不能批准已有定义。

原始四字段receipt仅保存到私有0600文件，不入DTO、项目JSON或导出；DTO只含回执状态及hash/bytes、模型名、finish枚举和integer/null用量。正常stop、原receipt与返回proposal一致、当前policy及inspectVerificationProposal全部通过才为draft。写失败不放行，未知写入保留活动槽及证据，迟到完成不自动清除未知或恢复批准。重开只保留已落盘人工决定，不重造控制器品牌；进行中的记录保守转待协调。

回执边界任一次重复、畸形或落盘错误均锁存本次失败，提供者即使捕获hook异常再返回首份等价proposal，也不能发布draft。最终异步规划核对后仍检查锁存状态。若首份已有效保存，其hash/bytes、model/finish与已知用量保留；异常后不接收“修复回执”覆盖历史，也不把已有回执改称未收到。取消、截止和未知清理的原优先规则保留。

SQLite owner用实际PID存活检查及随机token单控制器持有；重开不自动重发请求。非合作请求/写入在cleanupMs后不再拖延关闭，但对应记录保持活动的reconciliation_required，不宣称远端计费已停或写入已物理中断，也不自动释放尝试预算。迟到原始文件只保留私有证据，不更新新owner/恢复提案。当前没有自动协调、跨进程认证或Worker恢复接口；同进程依赖是可信控制器能力，不能从HTTP注入。

所有定义标structural_only，approved仅人工认可测试定义，绝不是passed或已运行。approve复用createVerificationControl校验，但不暴露其品牌、不compile、不beginCoding，也不提供acquireCompiled；未来执行器必须另定义受控准入/撤销/当前断言。本轮不制造可运行能力。

## DTO与版本

list为`{coverage:'structural_only',capabilities:{canPropose,contractRevision,budget:{maxAttempts,remainingAttempts,timeoutMs},model,reason},proposals:[row]}`，其余客户端方法均返回`{proposal:row}`。没有contractVersion别名，调用propose必须使用本次当前list中的contractRevision。

row公开字段为`id/projectId/runId/attempt/status/current/coverage/executed/approved/notice/binding/revision/proposal/manifestHash/policyHash/approval/history/model/usage/finishReason/dispatched/receiptState/receipt/error/errorCode/startedAt/finishedAt/actions`。proposal是普通HTTP DSL定义`{version,id,name,sessions,steps,limits}`或null；manifestHash仅结构hash，不能当可执行manifest。binding包含projectId/runId/specRevision/planRevision/sourceRevision/sourceGeneration/engineeringHash/contextHash/policyHash。revision绑定该定义、完整binding与当前策略；策略绑定本服务源码及复用校验/模型的源码策略。

approval为null或`{id,revision,approvedAt,feedback,phase:'definition_only',coverage:'structural_only'}`。history仅`{revision,manifestHash,status:'approve'|'reject'|'revised',feedback,at}`摘要，原定义版本在私有SQLite保留。拒绝集合按完整上下文永久保留，不能用先拒另一个定义覆盖旧拒绝，或用新attempt洗掉相同定义。结构变化不等于语义正确，仍需人工重新审阅。

usage固定`{inputTokens:integer|null,outputTokens:integer|null}`；receipt为null或`{sha256,bytes}`，不返回任何回执定位。dispatched只表示控制器已进入适配器请求，不保证供应商计费事实；未知用量不能显示零。status为generating/cancel_requested/draft/rejected/approved/superseded/cancelled/timed_out/stale/failed/reconciliation_required；receiptState为not_received/writing/saved/failed/unknown。

actions为`{canCancel,canRevise,canApprove,canReject}`。current和approved采用本次完整读取的当前版本、检查点代次和项目活动状态：检查点或活动请求使人审/批准许可全部撤销，真实在途cancel保留；不能把持久status:'approved'单独当作当前许可。新的批准会把同run先前批准标为superseded；重开读取不会重新生成批准。工程草案缺失/旧local计划仅可看历史，canPropose=false。

## 验证与未接入项

初版8b6dd56经非作者独立Review为BLOCK：捕获重复hook异常可继续发布draft，且legacy project缺代次时可绑定run负代次、显式null被默认0。原独立RESULT/probe证据保留。本轮仅修上述两P2及兼容undefined；新增4回归在旧实现4/4失败，修复后4/4通过，含final-read迟到重复、畸形后重新回执、已保存首份用量、双侧非法代次/人审拒绝及合法legacy/safe代次矩阵。最终相关联合及语法结果见下方新增记录，不以初版通过替代修复验证。

初版2026-11-14实际运行：`npm run check`通过97脚本；`TASKFLOW_TEST_REAL_SANDBOX=0 node --test --test-concurrency=4 tests/verification-planning-service.test.mjs tests/verification-model.test.mjs tests/verification-contract.test.mjs tests/model-content-guard.test.mjs tests/engineering-plan.test.mjs tests/planning-review.test.mjs`共100项，98通过、0失败/取消、2跳过，4784.0366ms。两项跳过仅为现有DSL底层真实MXC测试，本轮未启动目标代码；当时新增24项服务测试全部执行通过。初版日志保留在本地忽略output/verification/verification-planning-service-implementation-20261114，未提交回执或临时数据库。

两P2修复后同6文件联合命令共104项，102通过、0失败/取消、2项同样的既有真实MXC跳过，6561.9126ms；服务全部28项执行通过，原24项保留。`npm run check`仍通过97脚本。新日志独立保存output/verification/verification-planning-service-receipt-generation-fix-20261114/{before-fix-regressions.log,related-tests.log,syntax.log}，前项为旧码新增4回归的预期失败证据；旧独立Review目录未写入。本轮0真实API/MXC/Edge、未写原QA或用户数据，固定后仍待非作者复验。

专项覆盖持久重开、默认适配器接线、上下文/源/计划、原子预算与并发、跨run活动槽、拒后修订、哈希、人审/回执私密、getter零执行、超时/取消/不合作写入/旧owner及checkpoint关闭。`git diff --check`通过；固定后仍需非作者独立Review。

本轮未修改server/UI/orchestrator/package，也未组合三服务检查点、接统一计费账本、真实调用供应商或运行目标候选测试；没有执行结果、代码门禁或产品验收声明。后续先接只读list及精确版本的人审，再由控制器单独设计编码前批准定义的执行准入。
