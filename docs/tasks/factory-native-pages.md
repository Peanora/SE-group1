# 原版 Factory 页面与交接结果

基线 `c2afb01`。验收目标是恢复 Taskflow 原布局，并从同一项目直接进入未经改版的 Factory 官方发布界面。以隔离仓库验证可编辑 Roles、发现 MCP 工具、执行有依赖的任务并最终读回集成分支。

## 集成方式

- Taskflow 主工作台恢复 `4536436` 的侧栏、运行标题、流程摘要和开发任务画布。项目的 Factory 入口与 Taskflow 执行配方仍可使用。
- 「Factory 全流程」启动官方发布的 v1.0.5 程序并链接原生路径。Agent Graph 为 `#/network`，Runs 为 `#/`，Settings 内有 Roles 与 External Tools / MCP。界面、布局、Git 工作树执行、审查及集成由同一上游发布程序提供。[固定官方发布](https://github.com/OmegaMc1331/agentic-software-factory/releases/tag/v1.0.5)
- Taskflow 在调用原生 Planner 前，将当前规格版本、项目运行、仓库与数据库指纹、交接号和目标哈希写入 `DATA_DIR/factory-handoffs.sqlite`。成功创建时核对原始目标，并保存原生运行编号和创建时间。Planner 可改写运行目标，因此之后按数据库与运行身份读取状态、分支、提交和集成任务数。提交结果未知时，只有找到原交接目标才自动关联。
- 外部仓库仍需显式选择和本机授权。Factory 结果按原生运行归属记录，Taskflow 的独立验收和源代码下载继续按 Taskflow 自身的执行记录核对。
- 官方 v1.0.5 的工作流检查区读取无附加角色的团队时会报错。Taskflow 交接区增加「启动此 Factory 运行」，版本、仓库与待启动状态一致才调用原生 Start。原版 Runs 可继续查看任务图与证据。

## 验证

测试使用官方 Windows 可执行文件、真实 Edge 和隔离 Git 仓库。Planner、Worker 和 Reviewer 响应来自本地 CLI 夹具。MCP 使用回环服务器，GitHub 路径使用模拟 `gh` 和本地远端。本轮无付费模型请求或外部 PR。

- `npm run check` 通过 TypeScript 和 306 个脚本检查，`npm run ui:build` 通过。
- Factory 运行、原生设置、GitHub、交接路由、服务器与团队 HTTP 合计 25 项通过。恢复布局后，首页、任务图和任务修订浏览器回归共 14 项通过。真实沙箱用例另行开启，继续使用离线模型夹具。
- Edge 使用原生 Graph 新建角色并在 Settings 修改，配置、探测和删除本地 MCP。原生运行的计划为两任务及一条依赖。Taskflow 交接区调用原版 Start，随后核对 Review 一次退回、两次批准，后继实际读取前置已集成文件。最终提交存在于 `factory/run-1`，主分支原样留存。
- 停止时交接可读，重启 Taskflow 并重新启动 Factory 后，原生 ID、角色和集成提交读回一致。本地截图及逐次尝试证据位于 `output/factory-workbench/`。
