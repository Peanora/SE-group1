# 测试提案产品组合验证

基线6c66a8e3f0e792366b5985f7f6e06a0ff2e3aa00，独立分支codex/verification-product-acceptance；仅新增本记录和tests/verification-planning-browser.test.mjs，不修改产品源码或其他测试。这里新增产品组合测试，作者不承担独立放行。

可验证目标：真实createApp/HTTP、ProjectStore JSON、执行/需求变更/提案三个SQLite及系统Edge连接；默认真实规格/工程/独立测试适配器只对synthetic主机接收可控Response，其他仅允许localhost，完整恢复环境和fetch。测试证明接线与规则，不把模拟模型当真实供应商，不启动目标业务代码/MXC，也不compile/beginCoding。

覆盖实际模型规划双确认、正规规格私密回执、费用确认与当前契约、草案JSON修订/驳回/再修订及definition_only认可；桌面/390宽、真实轮询焦点选区、JSON错误/反馈/重载保持；提案生成和未知回执阻止需求应用、待应用仍可保存、结束后发布新源撤旧权限/新run重新确认；私密回执不出现在DTO/JSON/导出，调用及已知用量按模拟fixture实计。使用入口信号和后端/浏览器状态等待，不依靠固定短延迟假定结果。

所有数据为本轮临时目录，截图/日志仅忽略output。明确产品缺陷应保存复现并交根修共享源码，不放宽断言。本轮固定后仍需组合全量与非作者独立验收。

## 实际覆盖

1. 默认createApp及规格/工程/测试三个真实模型适配器经过真实HTTP规划入口和双确认，然后网页单独费用勾选，以当前contractRevision生成提案。真实3秒轮询、390宽焦点/选区、非法JSON本地拒发、反馈与会话重载保持；加入JSON根断言后保存、驳回，同revision后端409且网页不可认可；再加入数组文本断言，保存并人工认可definition_only/executed:false。DTO不含原始私密回执或宿主定位；项目JSON/plan.json和实际规划ZIP另确认不夹带提案记录。执行SQLite没有任何编码执行。
2. 已认可的旧定义保留历史，另一次真实提案请求在synthetic fetch入口挂起；真实需求请求可保存pending，三个服务检查点阻止apply。释放模型并生成草案后，同一pending能成功应用；旧提案全部current/approved/actions撤销，历史批准id/revision保留。旧run只读，新run使用新source代次并重新规格/计划两次确认，测试提案预算和历史独立。
3. 唯一可信测试注入为真实VerificationPlanningService的500ms预算与不合作私密writer，模型仍走原适配器与HTTP；回执写入入口信号后等待真实deadline形成reconciliation_required/unknown，已知31/37用量保留、没有proposal。重开默认createApp/真实JSON和三个SQLite后，未知状态与已消耗尝试仍保留，释放迟到writer也不恢复许可或允许source apply。变更/提案/执行SQLite记录分别1/1/0。没有把未知停止宣称已取消。

最终运行3个case共12次synthetic响应：spec/engineering/verification各4次；这些是测试计数和预设usage，不是供应商调用或收费证明。每次spec17/19、engineering23/29、verification31/37只是可核对的fixture元数据。所有响应仅在synthetic主机截获，其他fetch只允许loopback；环境和全局fetch在每项完整恢复，Edge、服务及临时数据均经teardown关闭/清理。失败或未完成会在清理前保存完整临时项目/SQLite行、请求和截图到忽略output，避免丢失复现；没有写真实用户数据或QA。

## 验证结果

2026-11-14：`node --test tests/verification-planning-browser.test.mjs`实际系统Edge **3/3通过，失败/取消/跳过0，23089.7501ms**；`npm run check`通过104脚本，`git diff --check`通过。仅按锁文件离线执行`npm ci --offline --ignore-scripts`安装现有浏览器测试依赖，package/lock未变。

首轮初稿3项在工程确认前失败，原因是fixture使用R1，而真实规格适配器按既有契约规范化为R-001；只修测试数据映射，没有改产品或放宽门禁。首轮日志保留为browser-first.log；修正后的定向workflow/checkpoints日志以及最终browser-final.log、syntax.log分别保存在主工作区忽略目录output/verification/verification-product-acceptance-6c66a8e-20261114。截图和逐case临时JSON/SQLite行证据在本树output/verification/verification-product-acceptance。

本轮未发现确定产品阻塞；这是新增组合测试及作者执行结果，不能替代非作者固定组合验收。未运行全仓库suite、真实供应商、MXC、目标业务软件、compile或beginCoding，不能据此宣称通用业务测试通过或F04已全部实现。后续由根串行引入此两文件，运行完整组合并交独立Review。
