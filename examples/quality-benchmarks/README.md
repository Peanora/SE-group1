# 复杂业务质量基准合同 v1

这是公开需求和事先固定的业务预期，不是应用实现、规格/工程响应、模型响应或通过证据。禁止把builder输出冒充真实PM产物。仅限平台已有受控Node.js、SQLite、HTML/CSS/JavaScript与桌面/手机Edge；不含文件上传、邮件、支付、外网、定时任务或外部身份提供方。

| 案例 | 模块 | 后续演进 |
|---|---|---|
| service-desk | 登录/资产/工单/评论/流转/审计 | 字段：priority及真实旧行默认值 |
| inventory | 登录/库存目录/出库单/出库记账/流水/审计 | 权限：本人草稿仅memo可编辑 |
| reservations | 登录/资源/占位/确认/候补/审计 | 流程：取消后同事务自动提升最早候补 |
| procurement-holdout | 登录/供应商/采购明细/异人审批/部分收货/审计 | 留出评估，初次质量评分前不用于修改平台 |

输入真实规划的是`protocol.md`与对应案例MD的正文；V1是在同一项目将change文件中的明确替换应用到原需求后形成新完整版本。不得把尚未批准的V1当成V0实现。三条change合同中有独立owned旧数据准备要求；它们不是自动种入业务库的后门。每次规划必须真实模型生成规格和工程/任务，人工逐项语义审阅后确认；固定合同不能替代PM质量。记录澄清次数、遗漏、矛盾、人工修改量；用本地规则或手工spec替代则单独标为机制测试。

## 纯定义builder

`index.mjs`导出四个metadata对象及对应`*Definition({requirements,coverage,version})`；留出无version参数。requirements必须是本次真实确认规格的完整需求对象数组。coverage显式把metadata.keys的每个语义域映射到实际requirementIds数组；一个需求跨域可重复关联，每个实际ID必须被关联。不能仅按名称自动猜测、删除未映射需求、丢弃业务或根据候选结果更换断言。映射依据与人工审批另存私有运行证据，不写入公共夹具。纯builder不读文件、不执行应用/模型、不批准或产生可信manifest。

```js
const proposal = inventoryDefinition({ requirements: actualSpec.requirements,
  coverage: reviewedMapping, version: 0 });
// 然后使用正式服务的版本/角色/双确认/冻结联合定义门禁。
```

builder包含精确HTTP与Edge预期，没有预制spec、架构、task.md、候选文件、编码/Review响应。`withTaskScopes(proposal,taskScopes)`仅附人工审阅的真实任务分组，不生成任务：必须按真实模型计划的2..8任务与实际依赖选择有意义的直接HTTP/Edge断言，交编译器校验完整覆盖和exact task hash。缺少可独立验证的模块边界应退回工程修订，不能为省事把整图每项都塞给所有任务。完整集成仍执行原完整清单。

## 运行前边界

- 基础版HTTP与Edge各用独立空数据库；Edge每viewport共用该viewport数据库，各会话隔离Cookie，和HTTP数据不混用。界面`WEB-*`与HTTP`BENCH-*`数据不同，名称是公开数据。
- 演进版每个自检、HTTP、桌面、手机副本都从同一明确停止的旧owned数据快照独立迁移；该快照只含change约定的`KEPT-*`业务记录及初始主数据，不含本次BENCH/WEB验证写入。数据仅来自旧应用真实操作，STOP确认后再批准迁移，不能改旧源码/旧DB补fixture。
- HTTP可表达有序请求、8个Cookie会话、32个标量捕获、两会话并发状态多重集、JSON/文本断言和同库重启；限制40steps/80requests/200checks。并发组不捕获赢家，先约束状态多重集，再查询最终库存/状态/审计固定结果，避免假定调度顺序。
- Edge定义每例<=60操作、<=4隔离会话，在1440×900与390×844分别完整执行；支持goto/fill/click/text/value/count/visible。guard检查同源、无page/console错误、无弹窗/下载和页面横向溢出。界面测试均走正常操作；非法/越权/并发写入主要由HTTP检查，不能用隐藏按钮代替后端权限。
- DSL没有通用键盘/Escape、focus/selection、selectOption、任意JS/SQL、真实网络乱序或多写者屏障。焦点、Tab顺序、错误后草稿保留、禁用按钮语义、手机实际滚动需额外人工/独立浏览器检查并记录；并发请求并非证明任何数据库隔离级别，必须Review事务/约束。没有项目运行前不写业务通过。
- 供应商/资产/资源、公共演示账户和主数据仅在空库初始化；同库重启不能重置。用户数据只用传入databasePath，绝不访问宿主真实资料。源码下载不含数据库、会话或私有报告。

`contracts-lock.json`在免费纯编译完成后固定本目录需求/定义字节。`holdout-lock.json`单独固定采购合同及共享协议/工具，初次真实评估前保全。修改合同需新版本及依据，保留旧失败；不能针对当前候选放宽预期。完整执行、费用上限、质量评分与封存办法见本地output/quality-benchmark-preparation交接；尚未运行模型或应用。
