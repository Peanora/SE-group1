# 交互式开发任务编排

- 基线 `b91f041`，保留已有交付计划改动。
- 目标是在「开发任务」里把已确认的规格、计划版本、任务依赖和后续验收入口连起来。借鉴 Factory 的图与详情联动，延续 Taskflow 的工作台主题。
- 范围是计划工作区、浏览器交互与定向回归。读取现有规划和模拟运行，不引入新的存储、执行器或审批入口。
- 验收使用免费分叉汇合夹具，核对规格和计划版本、关联路径、缩放与平移、节点详情、计划确认及桌面和窄屏操作。

## 实现与演示

在「开发任务」读取已保存的规划任务及依赖，按当前计划或模拟记录自动布局。点击节点可查看直接前置、后续、输入、产出、验收和需求条款。画布以两种颜色显示选中节点的上下游路径，在窄屏纵向排列。计划确认和验收准备使用既有操作及版本校验。普通项目使用 `npm start`，也可用 `npm start -- --demo` 启动 4320 端口的离线分叉示例。

## 实际验证

- `npm run check` 检查 293 个脚本，全部通过。
- `node --test tests/task-orchestration-browser.test.mjs` 真实 Edge 4/4 通过，包含窄屏 80 项长链及评审者确认。
- `node --test --test-concurrency=2 tests/engineering-planning-browser.test.mjs tests/visual-task-changes-browser.test.mjs tests/simulated-tasks-browser.test.mjs tests/specification-meeting-browser.test.mjs tests/project-redesign-browser.test.mjs tests/team-access-http.test.mjs` 通过 24/24，其中真实 Edge 12 项、团队权限 HTTP 12 项。
- 核对 1440px 和 390px 的画布、关键操作和控制台。新回归覆盖平移、缩放、依赖联动、规格预览和计划审批。实际提交只来自原计划确认按钮。
- 本轮使用离线夹具，未运行全量测试、外部模型或目标软件交付。现有数据可直接读取。本地截图保存在 `output/task-orchestration/`。

下一项验收用一份真实已确认设计规格，在已授权的 PM Agent 预算中生成计划，逐项对照来源、依赖与验收条件。
