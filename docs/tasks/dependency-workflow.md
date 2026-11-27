# 任务图与真实依赖执行

实现基线 `a68b3a6`。本轮目标是让负责人可以在任务图编辑前置关系，保存并确认流水线版本后，由现有逐任务 Worker 按图派发。检查点读取当前任务候选的独立 HTTP、Edge 和代码审查，再以实际 Git 集成完成作为下游放行条件。

- 保存连线采用现有计划修订入口，绑定规格、任务与执行模式，继续走审阅及联合验收定义确认。已有整项目运行保持自己的执行方式。正式逐任务图需要 2 至 8 个任务、明确可写范围、一个基础入口和一个可覆盖所有任务的最终集成节点。
- 逐任务调度逐个处理通过的候选。任务只等自己直接连接的前置验收，分叉共享并发额度，汇合等待全部直接输入。迟到的独立候选只在原始基础与当前集成历史、写入范围和实际 Git 结果一致时合入。
- 验收使用独立工作区与本机夹具。检查不同分支的真实启动顺序、失败阻断、同版证据、旧模式兼容和画布编辑产生的新版本。

## 参考与交接

借鉴参考项目的检查点、分支与汇合表达。画布连线直接修改后继任务的 `dependsOn`。一般计划可保存连线并重新审阅。需正式运行时，保存为按图运行，确认当前工程计划和匹配每项任务的联合清单。超过 8 项的计划仍可查看、拖动和保存连线。历史版本无需迁移。 [参考项目](https://github.com/ycwang-April/SE-TeamPrjoect/tree/main/workflow-orchestrator)

## 实际验证

| 命令或文件 | 实际结果 |
| --- | --- |
| `npm run ui:build`、`npm run check` | 构建、类型检查及 300 个脚本语法通过 |
| `node --test --test-concurrency=2 tests/task-orchestration-browser.test.mjs tests/simulated-tasks-browser.test.mjs tests/team-access-browser.test.mjs` | 真实 Edge 16 项通过 |
| `node --test tests/planned-task-parallel.test.mjs` | 隔离套件通过，包含真实 Git 与 SQLite 的 13 个子场景 |
| `node --test` 的 `engineering-planning-integration`、`planned-execution-service`、`verification-planning-service`、`verification-policy-renewal`、`verification-task-scopes`、`orchestrator` 和 `planned-execution-http` | 185 项通过 |
| `node --test tests/automatic-delivery-http.test.mjs` | 25 项通过 |
| `node --test tests/engineering-model.test.mjs tests/task-plan-view.test.mjs tests/planning-review.test.mjs` | 32 项通过 |
| `node --test --test-concurrency=2 tests/planned-task-merge.test.mjs tests/planned-source.test.mjs tests/planned-merge-source.test.mjs` | 23 项通过。旧来源套件的一条 30ms 计时用例在并行运行中超出派发时间窗，单独复跑 `node --test tests/planned-merge-source.test.mjs` 通过 |

独立 4327 示例通过 HTTP 创建、规格确认、标记按图、计划重批与 `plan.json` 导出。真实 Edge 在 1440px 与 390px 上读回图。示例规划由本地模拟响应生成，无外部请求。全量测试、真实付费编码和实盘业务交付本轮未运行。下一项验收以一份有独立联合用例的实际工程计划启动，记录同版候选、分支完工顺序和交付结论。
