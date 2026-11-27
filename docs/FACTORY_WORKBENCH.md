# Factory 工作流

Taskflow 的项目页提供「Factory 全流程」。该入口启动 Agentic Software Factory v1.0.5，并在新标签页打开官方原版工作台。Graph、Settings、Runs 和最终产物页面由原版程序提供。版本固定为发布提交 `f90f7be9406555980d733d81e57ad86f097f57ff`，安装器以已知 SHA-256 核对官方预编译包，并保存随包提供的 MIT 许可证。[原版文档](https://github.com/OmegaMc1331/agentic-software-factory/tree/v1.0.5)

## 启动和使用

1. 在 Taskflow 仓库运行 `npm run factory:install`，然后运行 `npm start`。已经有对应平台的官方压缩包时，可以执行 `npm run factory:install -- --archive <压缩包路径>`。也可以通过 `TASKFLOW_FACTORY_BINARY` 指向已安装的 v1.0.5 可执行文件。
2. 打开 Taskflow 项目，点「Factory 全流程」。留空仓库路径会创建该项目的专用 Git 仓库。若需要对已有仓库执行任务，填写有权限操作的 Git 仓库顶层绝对路径，确认本机 CLI 权限后启动。
3. 从原版 Settings 的 Roles 检查 Planner、Worker、Reviewer，或管理自定义角色。在同页 External Tools / MCP 配置工具服务器、测试连接并查看发现的工具。Factory 使用 CLI 自己的登录状态。缺少默认 OpenCode 时，可把已安装并登录的 Codex 或其他 Agent 分配给 Worker。GitHub Issue 导入与 PR 另需可用并已登录的 `gh` 及一个关联的 GitHub 仓库。
4. 可从当前已确认规格点击「交给 Factory 规划」，或在原生 Agent 图中从目标文字或 GitHub Issue 开始。规格交接时 Taskflow 服务校验当前已保存的规格版本，Factory 按其 Planner 创建自己的任务图。先在原生运行详情检查任务与依赖，再启动。已交接的待执行计划也可从 Taskflow 的「启动此 Factory 运行」调用同一原生入口。
5. 在 Factory 查看尝试、审查、产物、执行记录及集成分支。通过 Taskflow 交接的运行也可在项目启动页重新打开，并核对原生分支和提交。确需外部交付时，在原生页面预览并确认提交 PR。
6. 点击「停止本地 Factory」停止服务。正常停止后可以重新启动同一仓库，继续读取其 SQLite 历史及 Git 分支。使用 Taskflow 生成的独立验收和源码交付时，继续在「代码与验收」核对对应版本。

## 原生功能及入口

| 功能 | 入口与行为 |
| --- | --- |
| Agent Graph | 查看 Agent、角色、工作流和任务关系，保存图布局、便笺、分组及视觉连线 |
| 工作流 | 以目标或 Issue 生成依赖图，编辑运行团队，启动、取消、重试、查看角色产物 |
| Agent 与角色 | 管理 CLI、运行参数、自定义角色、优先分配和角色权限，按任务操作匹配 |
| 执行会话 | 已完成及在途会话证据、自动会话 SSE、交互终端和 WebSocket |
| 编码与 Review | Git worktree 中运行任务、收集变更和自检报告、逐次审查返工，通过后集成到运行分支 |
| 配方与上下文 | 保持内置与自定义配方、按运行冻结配置、为 Agent 提供本地仓库索引 |
| 性能与路由 | 查看成功率、返工和运行表现，使用 Round Robin 或按性能路由并记录决策 |
| MCP | 配置服务器、探测工具并审计授权调用，任务使用受控的原生 MCP 桥 |
| GitHub | 查看本机账号和远端、导入 Issue、生成 PR 预览、经用户操作推送运行分支并创建 PR |

v1.0.5 单次运行按顺序推进就绪任务，可存在多个并发运行。Git worktree 隔离分支和任务目录。原版存储层中的内部计划补丁和重规划函数在该发布版没有可调用的网页或公共 API，功能对照按实际提供的入口计算。

## 运行边界

默认 Git 工作区位于 `DATA_DIR/factory-workspaces/<项目编号>`，Factory 在仓库内的 `.factory/` 保存工作流。Windows x64、Linux x64、macOS x64 与 arm64 安装器选择对应官方包。本轮实际使用 Windows x64。

Taskflow 私有交接账本保存规格版本、工作区指纹、交接目标哈希、原生运行编号和创建时间。重启后核对同一 Factory 数据库，外部仓库须重新绑定同一目录。如果响应中断，会尝试通过原生 Runs 的原始目标识别同一交接。Planner 可能改写目标，证据不足时保留待核对记录，通过原生 Runs 查看或从原生界面明确启动新的工作流。

官方 v1.0.5 的 Graph 检查区在团队无附加角色时可能报错。该版本可以从原生 Runs 查看同一任务图与记录。Taskflow 交接区提供独立启动入口，原版页面与运行规则保持原样。

该原生服务使用独立回环端口和本机单人信任模式。Taskflow 只在本机项目入口启动，不代理 Factory 的命令、会话或凭据接口。团队登录模式关闭此入口。Factory 从允许的宿主环境变量取得平台环境，CLI 仍使用系统用户权限与各自的本机授权。绑定仓库时应选择可信的工作副本。含 `.env` 的外部仓库或上级目录不能绑定，因为原版 CLI 会自动读取它。

Factory 的执行、Review 和分支结果归属 Factory 工作流。Taskflow 的独立 HTTP、Edge 验收及源码交付按 Taskflow 本身的授权和候选版本记录。两个工作区的审批结果各自核对。
