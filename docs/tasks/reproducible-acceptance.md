# 可复现验收流程

## 目标

为课程/项目验收提供一条可重复执行、证据可核对、不会因模型输出波动而随机失败的流程。默认覆盖规划闭环：

固定需求 → 创建快照 → 规格 → 待确认问题 → 规格确认 → 架构/任务 → 结构检查 → 计划确认 → 文档导出。

重复执行时比较文档哈希和计划投影；不调用模型，不接触用户 `data/`。固定参考 Web 交付作为可选复核步骤，只有提供与当前规则兼容的源码 ZIP 时才计入完整验收。

生产代码提交 `6729182`。

## 实现

- `lib/acceptance.mjs`：启动临时 `createApp`，通过真实 HTTP API 创建项目、启动 local run、自动回答示例问题、确认规格/计划、下载 ZIP；解析 ZIP 验证文件清单，比较两次运行的文档哈希和去除 runId/确认时间后的计划投影；写入 JSON/Markdown 报告和两个 ZIP。
- `scripts/acceptance.mjs`：CLI，支持 `--fixture`、`--out`、`--repetitions`、`--archive`；不调用模型。
- `package.json`：新增 `npm run acceptance`。
- `tests/acceptance.test.mjs`：两次本地规划必须产生相同文档/计划投影，模型调用为0。
- `docs/ACCEPTANCE.md`：命令、产物、手工界面验收、边界说明。

## 实际验证

- `npm run check`：117脚本语法通过。
- `npm test`：701项，671通过、30跳过、0失败、0取消，98,240.1947ms。30项跳过为未启用真实MXC/显式真实Edge的既有集成项。
- `npm run acceptance -- --out output/acceptance-smoke2`：状态 `planning_passed_only`，规划通过、可复现、模型调用0；报告在 `output/acceptance-smoke2/`。
- `npm run acceptance -- --out output/acceptance-smoke-web --archive output/live-web-delivery-3lVPQC/library-web-source.zip`：规划通过；固定Web复核被拒，原因是该ZIP由旧独立验收规则生成，当前清单/规则哈希不一致。报告没有把旧包历史通过当作本次通过。
- 两次规划均得到8条需求、12个任务，文档哈希一致；原失败/用户运行未改动。

## 边界

- 自动填写的待确认问题和自动确认仅用于可复现流程验证，不是真人业务审阅，报告明确标注。
- 默认 `planning_passed_only` 不等于完整软件验收；固定参考Web交付需要当前规则兼容的源码包、MXC和Edge。当前本地旧包被正确拒绝，需重新生成后才能把 `complete` 置为 true。
- ZIP包含运行编号/确认时间，跨运行整体哈希不要求相同；报告比较文档哈希和去时序计划投影。
- 不改变“规划文档/固定参考执行/任意上传业务”的范围区分。
