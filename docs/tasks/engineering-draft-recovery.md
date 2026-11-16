# 工程草案免费重新校验

## 问题

用户最新 `library-system` 运行在 architecture/tasks 阶段连续两次失败。只读检查私有工程回执确认：

- 第1次：合法JSON、3实体/8接口/4页面/10任务，但接口路径使用OpenAPI风格 `{recordId}`，平台只接受 `:recordId`；整份草案被拒。
- 第2次：JSON仍合法，但页面选择器使用无效ARIA角色 `text`；整份草案被拒。

两次失败共消耗2/3工程调用，页面只显示通用 `invalid_model_response`，无法复用第1次已保存的可用草案。验收临近，需要不新增模型调用的恢复路径。

生产代码提交 `a1d9dd8`。

## 实现

- `lib/engineering-plan.mjs`：校验路由前把 `{param}` 规范化为 `:param` 并写回草案；路径安全检查、空段/点段/编码/重复参数规则不变。规范化后的完整草案参与hash。
- `lib/orchestrator.mjs`：
  - 新增 `readEngineeringReceipt`：仅读取服务器自有、UUID命名、普通文件且字节/SHA256匹配的工程回执。
  - 新增 `revalidate_engineering`：仅失败的新版model运行、规格已确认、architecture/tasks失败且无其他活动工作；按attempt从新到旧读取同specRevision/sourceRevision的回执，解析并重新校验。任一草案通过即发布engineeringPlan，原失败/用量/engineeringCalls不变，单独追加engineeringRevalidations，然后重置architecture/tasks/review/export并继续。
  - `describeRun`新增 `engineeringFailure`（remaining、canRetry、canRevalidate、message、nextStep），不读取或公开回执正文。
- `public/app.js`：architecture/tasks失败时显示“重新校验保存的工程草案（不调用模型）”；成功提示并继续阶段；历史输入禁用。

## 验证

- `npm run check`：114脚本语法通过。
- `npm test`：700项，670通过、30跳过、0失败、0取消，97,506.0123ms。30项跳过为未启用真实MXC/显式真实Edge的既有集成项。
- 新增单元回归：`{issueId}` 路由参数规范化并写回。
- 新增集成回归：构造更早的已保存工程回执，运行失败后执行 `revalidate_engineering`，不新增模型调用、engineeringCalls不变，任务/检查恢复并停在计划确认。
- 真实用户运行只读复现后，在临时数据副本执行同一动作：failed → awaiting_review，架构/任务/检查成功，10个任务，工程调用仍为2。
- 实际 `library-system` 运行 `4d3eb701-fd5f-4d4b-9e29-343836ad878a` 已执行免费重新校验：使用第1次保存草案，规范化路由参数，未调用模型；状态 awaiting_review，architecture/tasks/review succeeded，10个任务，review通过，engineeringCalls仍2，planRevision `9fc9de13…`，审批仍为空，等待用户确认计划。
- 原两次失败记录、用量和回执保持；未自动确认计划或导出。

## 限制

- 只修复可机械规范化的路由参数写法；JSON损坏、共享文件并行写、无效ARIA角色等仍会拒绝，必须重试模型或修改实现规则。
- 重新校验使用旧模型响应，业务语义仍须人工审阅；不代表软件已编码或验收。
- 未验证真实模型下一轮输出；未修改用户规格、原失败历史或付费预算。
