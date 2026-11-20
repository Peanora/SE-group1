# 李文宇的代码审查模块

## 目标与基线

依据工作区的 `team-delivery-plan.md` 第 4 人要求，补齐固定源码审查、按原问题编号复核、阻塞交付、异常诊断和预约候补演示。

本轮刷新远端后，`main` 为 `171aaa6`，包含旧版固定图书执行流程。计划引用的预约清单、规划驱动执行器及原生 Review v2 位于 `codex/automatic-login-checklist` 的 `2a9d791`，该分支比 main 多 4 个提交。本轮在此版本检查集成行为，个人分支为 `codex/李文宇-code-review`。以 main 比较会包含这 4 个既有提交的差异。本轮模块改动可单独审阅并合入预约基线，也可在该基线进入 main 后调整 PR 目标。

## 修改范围与完成条件

- 审查模型校验同一快照的文件、行号、源码证据、严重程度和原问题 ID，重复意见有明确结果。
- 正式流程复用问题编号与状态处理，审查未完成或存在未核实阻塞时保留失败，测试与审查仍绑定同一候选。
- 工作台接口和现有审查详情保留逐提交审查历史，修复后的结论可与原始意见对照。
- 提供预约源码跳过队首候补的独立演示，在两个真实 Git 提交之间按同一 ID 复核。离线演示显式标注响应来源，真实模型调用由命令参数选择。
- 用回归测试检查重复、遗漏复核、格式错误、审查未完成、同版门禁与历史读取。完成后补充实际命令、结果及未运行项。

## 交付内容

| 要求 | 实现与验证入口 |
| --- | --- |
| 查看实际源码及确认规则，给出位置和影响 | `lib/project-review-model.mjs` 使用同一个行号索引发送、解码和绑定证据，正式执行传入完整确认规格 |
| 区分建议和阻塞 | `blocking` 与 `advisory` 保持独立，正式门禁检查全部阻塞在当前提交的关闭状态 |
| 按原 ID 复核 | `lib/planned-review-issues.mjs` 供正式执行和独立演示共同使用，三轮返工回归覆盖已关闭问题再次出现 |
| 格式错误、重复意见、未完成有明确结果 | 原生安全诊断、逐调用 `reviewRejection`、`acceptance.status=incomplete`，已有问题保留待复核 |
| 旧结果可查看 | 公开 `reviewHistory` 包含各任务历史尝试及各候选提交，原报告保持原始问题与证据 |
| 独立预约演示 | `scripts/review-reservations.mjs` 固定两个 Git 提交，展示队首插队问题及同一 ID 的复核关闭 |

## 现场演示

在仓库根目录使用 Node.js 22.21 及以上运行以下命令。

```text
node scripts/review-reservations.mjs --fixture
```

首版 `src/promote.mjs` 第 3 行按请求 ID 选人，后到的候补可以越过队首。修复版先选择同资源、同时段内最小 sequence 的 queued 记录，再比较请求 ID。终端显示相同问题 ID 从 `blocking/open` 变为 `blocking/resolved`，每个提交的完整 JSON 报告在本次新建的 `output/reservation-review/fixture-*` 目录中，候选 Git 仓库也在其中。

离线模式模拟提供商响应，仍经过正式适配器的源码编号、格式校验和证据派生。回归测试实际执行两个版本的队首函数，验证乱序输入下只有修复版拒绝插队。`--model` 使用本机 `LLM_*` 配置及可选 `.env`，最多进行两次真实模型请求，失败保留 `incomplete` 报告。独立演示专门审查队首选择函数，完整业务范围由正式集成流程审查。

正式流程在编码自检、独立 HTTP、桌面及窄屏浏览器检查通过后审查同一提交。修复后会形成新提交，全部历史阻塞都交给审查复核，编码反馈列出仍需修改的问题。工作台的 Review 详情可核对各候选的 `originCommit`、`checkedCommit`、原始意见及复核原因，模型调用详情可查看每次格式拒绝原因。

## 验证记录

最终组合回归为 20 个相关套件共 324 项，312 通过、12 跳过、0 失败、0 取消，耗时 273622.47 ms。日志为 `output/review-tests/final-suite-fixed.tap`。257 个脚本语法检查通过，日志为 `output/review-tests/syntax-final.log`。

其中模型与 wire v2 用例验证实际本机 HTTP 传输及回执，页面用例使用真实 Edge 检查桌面和 390px 窄屏。正式执行器、跨任务返工、源码回放和重启交付机制使用真实 Git、SQLite 和私有回执，外部 HTTP/浏览器/模型检查由测试夹具提供。12 个可选真实场景随后另外补验，结果单独记录。

按锁文件安装 Playwright 1.65.0 后，使用正常模块解析重新运行服务及桌面、窄屏组，59/59 通过、0 跳过，日志为 `output/review-tests/pinned-ui.tap`。正常子进程测试入口也复验通过，2 个包装入口及其 29 个子用例全部通过，日志为 `output/review-tests/wrapper-entry-unrestricted.tap`。`npm run check` 为 257 脚本通过，日志为 `output/review-tests/npm-check-final.log`。这些结果包含与组合回归重叠的用例，不重复相加。

现成 Codex CLI 0.169.1 的 MXC 自检确认工作区内可写、越界读写被拒绝、联网被拒绝，日志为 `output/review-tests/mxc-preflight.json`。启用 `TASKFLOW_TEST_REAL_SANDBOX=1`、在测试进程指定 `EXECUTION_SANDBOX_EXE` 后，12 个真实场景及 3 个嵌套检查共 15/15 通过、0 跳过，耗时 115533.5634 ms，日志为 `output/review-tests/real-sandbox-serial.tap`。覆盖实际 Worker 审查格式重试、暂停及下一代恢复、原失败回执不可篡改、费用保留、同版本历史交付恢复，以及源码包重新启动与故意缺陷的拒绝。

首次并行补验为 13 通过、2 失败，失败场景的浏览器进程出现非零退出码或停止结果待核对。相同源码包场景隔离串行复测 2/2 通过，随后全部真实场景串行 15/15 通过。未改动浏览器检查或正常停止断言，首次失败报告保存在 `output/review-tests/real-sandbox.tap`。该并行运行现象仍作为环境稳定性限制记录，不能将首次失败追记为通过。

独立演示命令已运行成功。示例提交 `db3e3238` 至 `03cf59f0` 中，同一 `ISSUE-269140d0ad202bc4219f` 在 `src/promote.mjs:3` 从 open 复核为 resolved。日志为 `output/review-tests/reservation-demo.log`。

首次组合回归为 299 项，283 通过、4 失败、12 跳过。失败分别来自 Node.js 24 子进程默认报告格式与旧包装断言不匹配、返工夹具把原问题再次作为新意见、逐任务服务夹具仍断言已废弃的累计 72 次上限。修复测试数据以按原 ID 保持问题 open，更新预算断言以匹配既有 `unlimited` 契约。最终组合命令直接执行套件内实际用例，并为相关子进程包装入口显式设置 TAP 报告格式。业务断言逐项检查单次冻结预算、实际费用与未关闭问题。原始失败日志保存在 `output/review-tests/final-suite.tap`。

本机实际使用 Node.js 24.16.0。初轮安装请求被拒绝后，先用本机 Playwright 1.62.1 验证页面。用户要求继续收尾后，按锁文件成功执行 `npm ci --ignore-scripts --no-audit --no-fund`，安装 1.65.0，并在清除临时解析器后完成上述 59 项正常解析复验与真实沙箱补验。真实付费模型调用尚未运行，所有实际 HTTP 模型端点均为本机夹具。临时解析器、日志、演示 Git 仓库和报告位于忽略的 `output/`，本机运行时路径仅写入本地验证脚本。

Windows 的默认临时路径较长，Git 用例在较短的隔离临时目录验证。可用同一 Node 版本在仓库根目录运行以下核心自测，相关包装器会显式选择 TAP 格式。

```text
node --test --test-reporter=tap tests/project-review-model.test.mjs tests/review-wire-v2.test.mjs tests/reservation-review-demo.test.mjs tests/planned-web-executor.test.mjs tests/planned-source.test.mjs
```

## 提交信息

个人分支为 `codex/李文宇-code-review`，PR 标题使用 `李文宇 - 完成第4人代码审查模块`。本轮实现基于前述预约依赖分支，团队确定合入顺序后可以选择向该依赖分支提交，或等依赖进入 main 后向 main 提交。PR 正文应注明基线依赖及本轮实际验证范围。
