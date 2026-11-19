# 工程接口权限的人工修订

基线：codex/workspace-ui / 171aaa6 与现有未提交工作，固定 i12 已独立验收。用户要求继续完成完整目标，保留主界面改动，不提交推送部署、不动主data/.env/4317。

真实缺口：采购首次真实工程草案将不具收货角色的hybrid加入收货接口允许角色；现有revise_plan只允许任务编辑，不能保存接口权限修订。原工程结果、语义BLOCK、调用和首评保留，不能通过任务归并或私改JSON数据库绕过。

本轮只补负责人在当前待确认工程计划中修改已存在接口的允许角色。复用规格角色清单、工程校验/任务投影、版本/人工确认/检查点/权限及审计；不增删接口、实体、视图、业务需求或可写文件。语义无变化（包括仅重排角色）拒绝。保存后新planRevision、旧审批失效、重新结构审阅、再次确认才能下游；不调用模型、不改变模型预算或旧回执。

根独占范围：lib/engineering-planner.mjs、lib/orchestrator.mjs、server.mjs、public/planning-review.js（必要时app.js仅capability传递）、相关界面局部样式/测试及文档。其余作者分别处理Review wire/core/replay与startup诊断，不交叉改这些文件。

验收：有效权限修订闭环；未知route/role/重复/访问器/越界/无实际变化原子拒绝；旧规格/计划/历史source/执行中/非负责人/撤权拒绝；旧模型历史与预算不变，原审批不可继承。网页桌面/390px真实操作角色选择、草稿保留/错误/焦点和跨项目切换，无控制台错误。冻结组合后独立Test/Review，不能以此计划记录算完成。

## 作者实施结果（独立验收待执行）

后端复用当前review操作、工程校验、版本历史及负责人权限；新增`reviseEngineeringRouteRoles`，拒绝未知/访问器/重复/无变化输入并原子重建计划。网页新增局部角色选择模块，复用现有布局，不改用户整体界面；草稿保留、陈旧版本、提交错误、焦点恢复、只读角色及旧服务能力缺失均有覆盖。

作者最终关联验证：`node --test --test-concurrency=2 tests/engineering-route-roles.test.mjs tests/engineering-route-roles-http.test.mjs tests/engineering-route-roles-browser.test.mjs tests/engineering-planning-browser.test.mjs tests/visual-task-changes-browser.test.mjs`，10/10通过、0失败/取消/跳过，19418.223ms。日志`output/engineering-role-revision/final-related.tap`。其中真实Edge包含1440/390px交互、保存失败与刷新草稿、旧能力隐藏及评审者只读；本机mock模型，0收费，未使用原用户data。桌面及窄屏截图已人工查看，无横向溢出。语法与差异空白检查通过。

首次夹具失败分别为接口schema字段错误、run创建码201被误写202、重载期间等待了不该启用的开始按钮、响应读取误用body而实际为value；已修正测试驱动并复验。网页草稿恢复后确认按钮未及时禁用、只读角色误读负责人草稿等真实问题也在最终关联批前修复。旧失败输出保留，不算通过。

这不是通用架构编辑器；实体、接口其它字段、视图及业务变更仍走规格/计划相应流程。采购原始错误工程仍为BLOCK，尚未通过该API正式应用修订，未追认其业务验收。下一步冻结i13组合，由非作者Test和Review检查同版，再正式修订采购收货接口并重新确认。

冻结前追加：独立审查预备指出同run/同plan角色降级风险，真实Edge探针先复现owner未保存的勾选在reviewer视图仍残留（role-transition-before-v2.tap）；首探针曾被页面侧栏遮挡，作为驱动失败另存before.tap。修复仅将canEdit纳入角色编辑模块的render签名，降级重绘真实已保存角色，恢复owner时保留本地草稿；后端403门禁未改。最终5文件关联批升级为11/11，0失败/取消/跳过，17880.3477ms，日志`output/engineering-role-revision/final-related-v2.tap`。作者源码/测试至此停写，等待同固定源独立验收。

i13固定275文件后，非作者完整Test1357pass/0fail/1可选skip，但Review找到真实P2：等待driver保存时撤权，完整body仍获200并改计划。原红例与固定源保留，i13整体BLOCK，0后续收费。作者新增真实等待保存/另一owner撤权反例及未撤权正控，修前1失败/1通过（late-authority-before.tap）；窄修server传入可信assertAccess，orchestrator.action入口与await driveIdle后复核，拒绝发生在计划变更之前，最终finally仍释放项目操作锁。不从HTTP正文接收回调。

窄修后9文件关联53/53、0失败/取消/跳过，34001.1049ms；含原例撤权拒绝且revision/版本/decisions/审批/原模型历史不变，未撤权正控正常保存，以及真实桌面/390px、原编排/HTTP/团队权限。日志`output/engineering-role-revision/late-authority-after-related.tap`。作者不改i13原件，准备i14只含2生产/1既有测试文件变化的固定副本，独立原例复验；未声称i14已运行全仓或复杂业务。
