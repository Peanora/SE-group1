# 规划模型预算与未知传输门禁

状态：实现及作者相关验证完成，待root固定新版后非作者Test/Review。基线为主树 `codex/workspace-ui / 171aaa6` 的既有未提交集成；独立i3副本不修改。保留所有原UI/实现工作，不提交、推送、部署、重启主服务，不读真.env/用户data，不调用付费模型。

## 唯一验收目标

工程自动修正每run默认最多6次适配器尝试（可信配置1..20），规格保留3次；预算和已用计数跨重试、规格修订、服务重启不能扩张，工程原10分钟总时限不延长。两类原生适配器分别证明未发、完整响应、未知传输；未知远端或未核本地IO持久占用共同项目门禁，重启、晚Promise结束或普通错误字段不能解除，也不能发布迟到结果。

## 历史依据

更早 `docs/tasks/engineering-planning-integration.md` 明确默认3次、最高20次；a08319a将工程次数移除，c5b29b3同步不限次数文档。所查DESIGN/PRODUCT_REQUIREMENTS/ROADMAP及任务记录未发现可核对的“用户必须不限次数”原话；实现注释和提交标题不能代替用户授权。当前root已明确本轮改为默认6次。

## 修改范围与最小方案

- 独占 `lib/orchestrator.mjs`、`lib/engineering-model.mjs`、`lib/planner.mjs`、`lib/model-request-evidence.mjs`、server健康/可信options、public/app预算文案、相关planning/transport测试；README/API/STATUS由root维护。
- 复用规格已有的pending/回执和私有安全校验，但不照抄“本地Promise拒绝=已停”。共享WeakMap只读证据保持code/review默认语义，为规格/工程原生Promise和成功对象提供显式、不可JSON伪造的传输观察。
- 派发意图先落盘再调用适配器；持久history明确原生dispatched/responseComplete与待协调。完整错误响应读完才可判定已停，reset、截断、超限取消和无证替身均保守未知。未发送实际请求为0，但尝试预留不退回；未知用量保留null。
- 工程首次预留冻结 `{maxCalls,timeoutMs,totalTimeoutMs}`；以后只允许收紧。计数取旧计数/历史保守上界，失败和自动修正不清历史。首次startedAt保留，规格修订等不重置本run时间与次数。
- 共用门禁覆盖新model、retry/resume、源发布、删除及在途改规格；可以读取和保存待应用需求草稿。已经完整停止的旧回执仍允许免费revalidate，不新增调用。未知不提供客户强制清槽接口；无法通过现有服务核对远端时明确保留待协调。

## 必须运行的验证

1. 两adapter原生证据：未发送、完整非法JSON/HTTP错误、半响应reset、abort/timeout、完整响应后writer失败；伪造JSON/错误字段无证据。
2. 不同结构错误最多6次，第7次不会发送；同错无进展仍停止；并行架构/任务共享一次。配置1/20和非法0/21/null，重试/重启/规格修订和调高配置不扩张。
3. 持久reserved/dispatch-intent崩溃边界、unknown重启保留、sourceSuperseded旧run仍阻断；new run/retry/source apply/delete409，草稿保存可用。迟到回执与结果不发布，不改原成功/失败和用量历史。
4. 非合作provider/writer的有界关闭；完整原生响应与实际IO均核对后才能释放本地pending。没有新的事实不因轮询反复改状态。
5. 临时HTTP健康/options/预算披露和真实Edge桌面/390px，旧服务缺硬预算时模型启动禁用，local保持可用；现有规划/源变更/模型边界回归。全部模型为内存或localhost固定响应，费用0。

完成后记录实际命令与结果、未跑项、兼容与未知恢复限制，再由root固定新版本进行非作者Test/Review。本记录不把计划当实现。

## 实现与实际验证

- 工程默认6次，可信构造/createApp options支持1..20；规格默认3次不变。工程预算冻结maxCalls/timeoutMs/totalTimeoutMs，spec预算冻结与启动收紧；每run计数取计数/历史保守上界，重试、规格修订、重启不增加额度或延长首次工程时间。已有无时刻历史不假装取得新10分钟。
- 两adapter显式启用原生Promise/结果/回执opaque handle证据；原code/Review默认成功结果仍无该证据，原错误事实仍为冻结WeakMap记录。回执第二参数只用于可信控制器关联原始完整响应，不进入文件、JSON DTO或导出。完整HTTP错误正文也必须读完；不完整断线、取消和无证替身保留未知。
- 规格与工程都在派发前持久保存dispatch_intent。模型停止和实际writer分别核对；原失败/回执/用量不被迟到结果改写，必要时只新增独立coordination记录。未知跨API重开、旧source运行和已结束Promise仍占用共同门禁；原来完整停止的saved响应仍能在预算耗尽后免费revalidate。
- `/api/health`为engineeringCallLimit:true及真实实例maxCalls；界面展示次数/时间/冻结已用和明确“前次请求待核对”，旧服务不能证明硬上限时禁用model启动，local保留。其他项目删除不被当前项目未知锁误伤。

实际使用Node22.21执行：`scripts/check-syntax.mjs`为227脚本通过；限定改动文件`git diff --check`通过（仅CRLF提示）。最终19文件相关组合 `node --test --test-concurrency=4` 为 **319/319通过、失败/取消/跳过0，19645.7602ms**，原始日志 `output/planning-transport-budget/final-related-fixed.log`。文件集合为planning-transport-budget、orchestrator、planning-review、planning-project-actions、engineering-planning-integration、specification-planning-integration、engineering-model、specification-model-boundaries、planner、model-config、source-change-service、source-change-http、server、verification-model、verification-planning-service、project-code-model、project-review-model、engineering-planning-browser、specification-usage-browser。

新增9项专测含默认/边界cap、6次不同原生结构错误无第7次、重启调高不扩、调低再升不恢复、规格修订不重置、意图先落盘、未发送0/完整/unknown不可JSON伪造、真实localhost工程reset+HTTP共同门禁和重开、真实localhost规格半响应reset+旧source门禁。真实Edge检查1440/390（含模型缺预算、旧服务无hard cap、已确认规划及unknown控件），无console错误、无全页横向溢出，截图已目视，保留于同output目录。

前置失败日志保留：round1为168/178，round2为176/178，round3为94/95；包括旧unlimited/“本地settle后可重试”断言与无证synthetic需按新合同更新、原生proof转发未更新和一个新测试选错规格审阅停点。已改为原生内存Response并保持业务断言；已完整停止的旧回执免费恢复断言继续通过。最终第一次319组合为318/319，新增Edge用例在项目选择仍忙时提前断言其他项目已可操作；改为等待同控件真实结束忙态，原失败保留，随后同19文件319/319通过。不是删除失败项或放宽后端门禁。

未运行全仓、收费真实模型、真实外部供应商取消确认或原用户data迁移；无提交/推送/部署/主服务重启。兼容注意：启动会收紧已有预算，并把没有可核对完整响应的旧中断/传输失败保留待协调，不补造sent0。通用Chat Completions无法提供断线后远端终止凭据时，本轮没有客户强制清槽/自动恢复接口；没有新证据不能继续收费重试。下一项为新固定源的独立Test/Review及root统一回归。
