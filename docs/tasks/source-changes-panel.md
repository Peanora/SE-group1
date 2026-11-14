# 需求输入变更面板

基准3c3bd66，独立分支codex/source-changes-panel。只新增public/source-changes.js、tests/source-changes-panel.test.mjs和本文；不修改服务端、公共入口或样式表。

目标：为同项目的需求输入提供可保存的待应用请求，展示后端差异/影响/历史，在安全检查点应用新输入版本。保存和解析无模型调用；应用只更新输入、使旧运行只读，必须重新确认规格/计划，未执行代码或数据库迁移。

接口：createSourceChanges({api,getContext:()=>({projectId}),onApplied?,onError?})返回mount(element)/refresh()/destroy()。api沿平台JSON调用约定。项目/epoch/action token隔离所有异步结果；草稿与请求幂等键按项目保存在sessionStorage，刷新不重建编辑控件。后端current变化时保留旧草稿但阻止保存/应用，需明确载入当前版本；不明POST结果通过刷新核对，重试同body复用requestKey。applied必须经后端GET再次证实后通知父级。

验收使用本机真实Edge与受控平台API fixture，覆盖桌面/390宽、焦点选区、session草稿、文件解析、错误/不明结果、跨项目/ABA/旧finally、current stale、安全文本、缺能力字段及真实状态通知；无真实模型或用户data。实现完成后记录实际检查与限制，固定版本交非作者复验。此组件尚未挂入产品入口。

实际实现：所有正文、差异、原因和错误通过textContent显示；不执行HTML、命令或模型内容。编辑控件只构建一次，周期GET不重置正文/focus/selection/details；首次版本尚未读到时不开放编辑。当前版本与草稿版本/代次不同时保留旧草稿、阻止保存及应用，明确载入后才能改用新base。缺capabilities、非布尔canApply、缺版本、GET失败、旧base/gen及非pending历史都不会开放应用。保存相同body失败重试（包括重载、无实际变化的input事件）保留requestKey；正文真正变化时生成新key。在途保存先记录结果不明，切项目/重载后可刷新核对，不自动重发。

保存/解析/应用动作按project+epoch+对象token归属。旧项目的响应、错误、finally及ABA晚结果不能改写或解锁当前项目；同项目读序号阻止较早GET覆盖较新GET。应用响应即使声称applied，也必须另一次GET同时证明对应change为applied、sourceRevision与当前revision相同、appliedGeneration与当前generation相同，才调用onApplied。busy409保留正文和错误；未知结果不自行更改历史、审批或迁移状态。父回调可异步完成，回调失败不会撤销已确认的应用事实。

实际检查：锁定依赖通过`npm ci --ignore-scripts --offline --no-audit --no-fund`在新工作树本地安装，没有改变package/lock。最终`node --test tests/source-changes-panel.test.mjs`为**13/13通过，0失败/取消/跳过**（11557.0323ms），真实系统Edge、同源静态测试页和可信mock API。覆盖字段精确body、XSS原文、400/409/503与幂等/结果不明、applied双重确认、stale/capabilities/legacy、1440和390宽焦点选区/轮询/details/session重载、TXT/DOCX parse传输与失败/过大文件/解析期间编辑、跨项目和ABA旧POST/旧finally、乱序GET/销毁、applied/interrupted/unknown历史与晚应用通知。测试全部读取合成数据，不提供业务完成结论。两个新增JS文件的node --check及暂存diff --check通过；截图390/1440已生成并检查窄屏无横向溢出。日志和截图留在被忽略的output/verification/source-changes-panel/。

未执行：真实需求/密钥/付费模型、实际DOCX后端解析（本轮测既定parse接口传输）、真实source-change存储/HTTP与app组合、全仓测试、目标业务迁移。未修改server/app/index/styles/API，也未接入产品；后续由根集成与非作者固定版本Review/真实HTTP浏览器验收。未推送或部署。

## 4e2独立P2后的确认通知修订（自检完成，待新固定版独立复验）

原4e2的13项通过未覆盖这一交错：apply后确认GET①挂起，手动GET②先返回applied/current一致，再释放①；①的readId已旧而返回false，perform将其误当没有确认，父onApplied永久未通知。原独立证据保持不变。另补POST503结果不明、后续GET已证实applied却未通知的恢复缺口。

修订只在当前project/epoch记录真正发起的apply意图（changeId、baseRevision、baseGeneration、sourceRevision与GET序号起点）；不从任意历史applied创建通知。每个最新成功GET统一对照同项目/同change/base/gen、目标revision、appliedGeneration=base+1及当前revision/generation，任何字段不匹配都不通知。POST响应不是应用事实的来源；即使POST503，后续手动/轮询GET完整确认也可通知。特定GET被较新GET取代不再被当作负面事实。通知在任何await前同步去重并释放该意图的旧apply锁，旧GET/finally不能清除之后的新操作；父回调失败只提示刷新，保留applied事实且不重复通知。切项目、ABA或destroy清除该epoch意图，重载后的历史不自动通知；父级首次载入仍应自行读取当前项目。

新增三组真实Edge回归，先将其中两组放在4e2源码运行，明确0/2失败复现（4e2-regression-red.log）；修订后完整16/16通过、0失败/取消/跳过（12465.3895ms，confirmation-fixed-tests.log）。新增覆盖两次确认GET乱序、确认后新save仍受独立action锁、503后有效GET恢复、8类身份/版本不匹配拒绝、通知去重、父async回调拒绝以及ABA历史不通知。原13项输入/focus/窄屏/错误/幂等/import全部保留。

还将原独立probes.mjs复制到本树ignored output/verification/source-changes-panel/confirmation-probe/，只调整新预期和独立输出位置，0源报告改写：post-503和overlapping-get两种均onApplied=1，重叠场景无错误；两种UI均不再声称应用未确认，原503错误历史仍保留。两个新增脚本node --check及diff --check通过。此为作者自检与原探针复跑，仍需非作者对新提交复验；未改server/app或真实需求，0API/paid/spawn。
