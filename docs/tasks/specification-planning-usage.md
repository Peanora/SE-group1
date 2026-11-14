# F09规格调用回执与每运行预算

基准f17671f，独立codex/specification-usage。目标仅接通model规格阶段的私有四字段回执、metadata-only历史、每run默认3次尝试/单次90秒和停止归属；不是统一执行预算、远端服务取消确认或业务验收。保留F05项目锁/检查点/driveIdle以及工程规划路径。

新调用使用specificationCalls/specificationHistory；旧记录不补造用量/回执。规格适配器接收signal/timeoutMs/onReceipt。回执仅写store私有根下.private/specification-receipts/project/run/UUID.json，公开历史仅id/hash/bytes、model/usage/finish/status/code，不存正文/凭据/绝对路径。用既有真实adapter对内存Response纯重放以复用规范化和引用规则，零外部请求；回执与返回规格等价且正常stop、落盘成功、source/run仍当前才可发布。未知用量为null，失败不退回尝试预算。

取消/超时有界返回；非合作provider/writer登记为unconfirmed，晚结果不修改定稿历史、不发布规格，在同一controller内真正settle前阻止该项目检查点/新建和重试。重启保留尝试与未知状态，不自动重跑或假称远端已停。测试仅临时目录与可信mock。授权范围orchestrator、新helper/专测/本文；根额外授权3处旧可信fixtures仅适配正规回执，原断言保留。

实现字段：首次新model规格调用保存`specificationBudget:{maxCalls,timeoutMs}`，默认3/90000；以后取原run冻结预算与当前可信控制器上限的较小值。`specificationCalls`在派发前预留并持久化，失败或未知不返还；预算耗尽不创建新模型尝试。`specificationHistory`仅含id/attempt/sourceRevision/status/times/model/usage/finishReason/receipt{id,sha256,bytes}/receiptState/requestState/code，保存故障可附persistenceStatus。validated是回执校验通过但尚未发布规格的中间态，最终规格保存成功才为succeeded；保存失败恢复原spec/specRevision/specVersion/questions/artifacts且不补造批准。正常和异常finish的四字段回执均可存档，缺/重复/不等价/含凭据的回执不授权。

私有writer校验可信根和完整父链无链接，UUID分层、wx新文件、普通单链接文件、2MiB序列化上限；回执/返回值先descriptor纯数据快照，0 getter调用。回执原文上限512KiB，并再次复用v2已验证guard防已知配置凭据进入私有原文或公开model字段。JSON/围栏/trim/自动REQ编号/来源引用等价判定完全复用当前planner；内存重放fetch固定为Response，不做任何网络请求，不增加specificationCalls或模型usage。公开ProjectJSON和导出没有私有正文或绝对路径；plan.json白名单不携带这些调用历史/预算。

requestState的settled只表示本地适配器Promise结束，不宣称远端服务取消确认；unconfirmed明确保留未知。对忽略signal的可信provider/receipt writer，取消/超时可有界结束阶段且晚结果不修改历史；同controller内其真实Promise未settle前，项目检查点/新建/重试409。shutdown取消当前调用并等待阶段记录结束，不无限等待非合作回执；重启将真实未完成新尝试记service_restart/unknown，不自动重跑，不伪造旧history或用量。

兼容fixtures（根单独授权）：engineering-planning-integration、engineering-planning-browser和source-change-service三文件仅将旧只return spec的可信替身改用真实adapter+内存mock回执；两工程fixture的数据REQ引用对齐adapter原有R-001规范（未改生产ID校验或真实旧数据）。工程链接负例从.private调整至.private/engineering-receipts，因为正规规格调用已合法建立共享私有根；父链链接拒绝及其全部原断言保留。首轮联合136中135过、此fixture准备EEXIST失败，修正准备路径后通过，旧失败日志保留。

最终实际验证：`node --test --test-concurrency=4 tests/specification-planning-integration.test.mjs tests/orchestrator.test.mjs tests/planning-review.test.mjs tests/planning-project-actions.test.mjs tests/engineering-planning-integration.test.mjs tests/engineering-planning-browser.test.mjs tests/source-change-service.test.mjs tests/planner.test.mjs tests/specification-model-boundaries.test.mjs tests/model-config.test.mjs`为**140/140通过，0失败/取消/跳过**，4847.5563ms；其中新增规格集成39项（含子项）与原101项均实跑，工程规划UI使用真实Edge+可信API/provider fixture。新增覆盖正常/失败/未知用量、raw/fence规范化、私有hash/导出净化、异常finish、凭据转义遮蔽、缺/重复/getter/不等价/序列化超限回执、每run预算重启不可扩大、非合作provider/writer的超时/停止/晚结果、检查点/重试/新建、源/run失效与暂停、链接和writer故障、预留/校验/最终发布三处save失败、最后metadata保存await后的版本/模式变化、重启/旧local/v1。`npm run check`为97脚本通过，新增/修改入口语法及git diff --check通过。锁定依赖仅offline安装，未改package/lock。日志保存在ignored output/verification/specification-usage/。

未运行付费模型、真实规格质量/完整业务验收、MXC候选执行或全仓套件；没有接health/UI/API新披露（由根独立组件负责），没有用户数据迁移/推送/部署。该候选待非作者固定版本Review及根集成验证，不把作者自检当独立放行或F09全部完成。
