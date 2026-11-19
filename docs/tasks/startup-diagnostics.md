# i13 受控应用启动诊断

目标是修复真实库存候选初始化异常被泛化隐藏、后续编码只收到未执行断言的问题。原两候选均能导入所需内置模块，在 `src/db.mjs:48` 调用 Node 22 `DatabaseSync` 不存在的 `transaction()` 方法而失败。原候选、数据库、费用、规划与验收定义保持。

本分支独占 `web-worker.cjs`、`web-runtime.mjs`、`http-scenarios.mjs`、`project-code-model.mjs` 及直接测试。另一个作者独占 core 编码反馈和 Review，本分支不修改 core、角色修订入口或 UI。

## 诊断契约

HTTP 检查报告可选 `startupDiagnostic`：

```json
{"phase":"startup","code":"sqlite_transaction_unsupported","sourceLocation":{"name":"src/db.mjs","line":48}}
```

`code` 仅允许 `sqlite_transaction_unsupported`、`application_module_failed`、`application_initialization_failed`、`invalid_application_factory`、`invalid_application_handler`。位置可缺省；只能来自本次验证过的候选 JS 模块和实际非空行。原生 V8 callsites 在平台 formatter 下读取，不运行候选 stack getter/formatter，不解析伪造 stack 文本。worker 仅序列化安全标量，runtime 再核启动阶段、枚举、位置，HTTP 再核当前文件内容。原始异常 message/stack、绝对宿主路径、数据与原始 stderr 不加入诊断或模型反馈。已有进程原始报告仍为本机私有证据。

`SYS_START` 实际失败时增加 `executed:true`，`passed:false`，`actual` 为固定原因/恢复建议及可选相对位置。其它未执行检查保留原失败事实，诊断不授予通过、不会放宽源码/绑定/停止检查。core 作者消费同一严格短对象并压缩未执行检查噪音。

编码系统契约补充 Node 22 `node:sqlite` 真实事务写法：`exec('BEGIN')`/`COMMIT`/异常 `ROLLBACK`，无 `db.transaction()`。同时明确不用 `alert/confirm/prompt`，使用页面表单与可访问状态提示；不预设任何业务实现。

## 验证与交接

新增测试使用真实 MXC：实际不支持 API 的启动反例、原生事务及回滚/同库重启正控、私有异常正文/伪宿主栈、敌意 getter/formatter/toJSON/伪协议帧、重新安装后的 protected runtime。普通测试捕获实际编码 adapter 请求中的通用契约。输出仅使用合成 fixture，无新收费或业务 attempt。

首原生批 3pass/2fail 已留在 `output/startup-diagnostics-i13/initial-native.*`：Node22 stack 为 lazy accessor，不能按普通字符串属性提取。修正为捕获原生 V8 frame 后原断言未放宽，首五项5/5通过。之后六个关联测试文件实际110/110（含新增9项；两原生开关均开启），新增的模块加载/缺少工厂/无效处理器/改源撤诊断四项另批4/4。两份原库存候选仅复制到新输出目录实际复测，仍失败且均定位 `src/db.mjs:48`，原源码与执行记录哈希未变。

与 core 作者的当前实现集成后，另有两个零费用合成案例通过真实 Git、MXC、HTTP 和 Edge：首候选分别为不支持的 `transaction()` 或含合成私有文本/伪宿主路径的初始化异常，下一次编码请求收到固定诊断，第二候选修订后完整验收通过，进程停止已确认且旧错误清除。首驱动曾将现有 JSON 字符串反馈误作对象，原失败断言与运行结果保留；仅对已保存证据按真实接口解析补核，不重新执行该案例。私有异常案例是另一次实际运行且退出码0，不向模型反馈异常正文。完整记录在 `output/startup-diagnostics-i13/`。

以上是本分支作者验证，不替代根固定组合版本后的非作者 Test/Review，也不追认旧库存候选或授权新收费。四个生产文件停止写入，不提交/推送/部署。
