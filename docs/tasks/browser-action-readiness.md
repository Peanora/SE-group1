# 浏览器动作的就绪等待

基线：i14固定275文件及当前主树；本轮仅lib/browser-scenarios.mjs、tests/browser-scenarios.test.mjs和本记录/专属output可写。原采购execution 3cad9064-3110-4cb9-98c5-d9cd3e2cbb8a保留failed与全部费用，不改原候选、回执或审批。

真实线索：三版HTTP89/89，Edge在登录页首fill观察到count1/visiblefalse。候选初始隐藏登录视图，异步me检查后显示；执行器却在Playwright自动等待之前立即拒绝不可见目标。先固定原件指纹，用新受控副本/真实Edge验证，再窄修标准fill/click：原actionTimeout与全局deadline内等待唯一可见目标，同一action剩余时限交给实际操作；重复节点立即失败，不选择first，不放宽guard/期望/原预算，不加固定等待。

验收：真实延迟就绪fill/click红→绿；永不就绪、重复、取消/撤回/安全guard和总时限负例；等待与操作共享额度；原浏览器相关回归。记录新源码policyhash，不追认旧gate或诊断为软件通过。新固定组合还须非作者Test/Review，本轮作者不担任i15独立Test。

## 作者结果与限制

原采购v3的新受控副本在原policy下真实复现111项仅5通过，首fill count1/visiblefalse；原job含Git、源码、execution及6模型回执共369文件前后零漂移。新增真实Edge延迟页面fixture也在改执行器前按原成功期望得到1/1红，修后正常就绪/永不就绪/重复节点3/3通过，原红保留于output/browser-action-readiness-i15。

窄修将fill/click的action截止固定在第一次CDP观察之前；观察、条件轮询和真实Playwright操作共享剩余时限，不增加actionTimeout或总deadline。取消、审批撤回、安全guard及重复控件继续拒绝，未选择first或放宽预期。CDP观察也受相同截止，超时后的会话释放保持有界。只在已观察到真实guard阻塞后，增加控制器固定原因枚举及最多257的计数；无任意message/URL/query/stack进入新原因字段。

作者最终7文件关联批：89总/88通过/0失败/0取消/1原可选旧候选竞态诊断跳过，102059.4871ms；包含真实Edge和实际native Worker格式重试、显式修复及两次API恢复同ZIP。mock独立子进程直批26/26另报；两个修改脚本语法通过。均0收费，不是新平台全集或真实复杂业务验收。

采购同v3在等待修订后的诊断曾到visible=true而既有guard=false；最终增加安全枚举后明确console_error:1，仍111项仅5通过、正常停止。没有过滤401资源错误，也没有把诊断追认为旧执行通过。原369文件在每次及最终核对均零漂移。原候选还有独立业务Review问题，需新代码和完整复验，当前不能交付。

最后runner源码policy由原d56599ea…变为f48f7bf5…，常量/原DSL及原审批不修改；旧清单/候选资格不会因本修复自动继承。作者已停写生产/测试，等待根新固定i15的非作者Test/Review。范围和完整hash见output/browser-action-readiness-i15/scope-manifest.json及HANDOFF.md。
