# 已停止失败调用的历史账务与当前候选验收

2026-11-18。本轮仅修复真实 i7 便笺图暴露的资格阻塞，未经新固定版本独立 Test/Review 不进行下一次真实调用。

反例：原图 BASE 的第一次 Review 是已完整保存/已停止的 length、4096 输出 token；第二版代码的正常 stop Review 为3665输出、blocking0，内层当前验收 passed，外层核心却要求所有历史调用 stop，从而永久拒绝通过。原失败、4调用及70,018token保留，不修改 i7/原回执/旧候选、不追认成功。

允许范围：lib/planned-web-executor.mjs、lib/planned-worker-seals.mjs、一个共享只读账务helper及直接相关tests。不改source、任务库、前端、接口、预算、用户数据、主服务。当前和各实际应用代码版本的coding必须stop；当前Review必须stop，任何缺回执/远端未知/终止未确认仍拒绝。历史异常finish只有完整保存且远端已停才能保留计费，不成为当前成功凭据。所有原始回执、身份/弱映射、同版约束、费用总额、Worker账本/签名、源码核对继续保留。

验收：先加免费反例，确认旧实现为红；修复核心、Worker完成签名与暂停/恢复核对的同类every-stop条件。覆盖当前异常仍拒、历史账务不能删除/改费/改receipt，真实本地默认native模型传输（localhost固定回复，零收费）、Git/HTTP/Edge/Worker暂停换代和API重开历史交付。按实际运行分别记录，原3次旧图与本次第4次收费图原件不动。

实现完成：新增只读 `planned-call-history.mjs` 区分完整已停止的模型调用与正常候选结论，纳入执行 policy 哈希；Worker policy 通过该执行哈希绑定依赖。`completeAcceptedRecord` 对所有历史调用要求完整回执/已派发/已停/完成状态，对每个实际应用版本要求对应 coding stop，对最终同 commit/sourceHash Review 要求 stop。Worker完成签名、结果验证、暂停检查点账务复用同一完整历史规则，原 journal/签名/费用核对保留。`unknown` finish标签仅指完整响应里的标签，`requestState=unknown` 继续拒绝。

同文件 `upstreamRework` 另有历史 every-stop 污染：FINAL先length、后正常Review报告真正上游blocking时，原代码不能生成返工能力。新增免费反例先红后修，同样保留全部历史费用与原回执，并仍要求所有应用coding和当前Review stop、逐文件hash/usage/原Review复验；不改source或任务库。

实际检查（2026-11-18）：

- 原核心新增反例先红，内部21通过/1失败，真实Git候选最终门禁passed但资格false，`output/planned-call-history/core-before.tap`保留。返工反例另先红1项，`rework-before.tap`保留。
- 核心初修后1外层通过（内部22项），新native历史支线4/4通过，随后发现并修上述返工同类条件；这些是中间版本证据，不冒充最终批次。
- 最终稳定版本执行13关联文件：planned-web-executor、planned-task-executor、planned-task-handoff、planned-task-merge、planned-checkpoint、planned-checkpoint-service、planned-worker-recovery、planned-worker-security、planned-worker-handoff、planned-worker-handoff-faults、planned-worker-cancellation-faults、planned-worker-history、planned-integration-rework；Node报告29/29，0失败/取消/跳过，161155.4673ms，exit0。部分外层测试内部另启动隔离子测试，未把不可见内部项加总进29。日志 `output/planned-call-history/final-related.tap`。
- 最终6个改动JS模块/测试脚本语法检查通过；生产3文件在最终批次期间未修改。
- 新native localhost固定传输链真实使用MXC/Edge/Git/HTTP，Review1 length4096→Review2 stop3665，实际代码有变更，BASE后暂停/旧Worker退休/新代只执行FINAL。原6calls及12输入/7773输出固定夹具token一次结算，预算/截止不重置；API进程重开后同ZIP。原失败receipt字节被加空格时缓存下载409；旧检查点费用被改时409；恢复原件后重开正常。未把这些本地固定回复当真实LLM质量。
- 当前code或Review非stop、截断当前Review均拒绝；完整unknown finish历史可留账，原非合作/远端unknown、同版/弱映射/权限撤销与回执篡改等原保护回归保持通过。

原收费 i7 图仍为BLOCK，4calls/45371输入/24647输出，后三task/延迟GET未跑；没有追认旧图或改其任何原件。下一步由根固定i8，再独立Test/Review；仅它们通过并有新授权时才可启动新的真实回归。未运行全仓套件和新的收费图。本轮无提交、推送、部署或新增真实收费。
