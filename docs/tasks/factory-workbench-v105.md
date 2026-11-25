# Factory v1.0.5 完整工作台接入

基线 `cc654b2`。目标是在 Taskflow 项目内打开同一套 Factory v1.0.5 引擎与工作台，覆盖该版本真正对外开放的功能。保留现有课程项目、规划审批和独立验收。Factory 通过独立回环端口提供原生网页、HTTP、SSE 与终端 WebSocket。

- 使用经 SHA-256 核对的 MIT 发布包。模型、CLI、GitHub 和 MCP 由 Factory 承载。
- 一次验证目标是项目独立 Git 工作区可启动原生工作台，明确确认后可将当前已确认规格交给 Planner，并沿原生路径运行、审查、集成和读回。验证使用本机夹具和临时仓库。
- 允许改动范围为独立运行时、安装命令、Taskflow 项目入口与版本交接、文档和定向回归。真实付费请求和 GitHub 外部交付需要明确授权。

## 实现与证据

- Windows 官方 ZIP 的 SHA-256 校验通过，实际安装到 `output/factory-runtime`。发布的二进制运行时提供原生界面与所有公开路由。Taskflow 入口、进程、权限和规格交接的改动见 [使用说明](../FACTORY_WORKBENCH.md) 和 [API](../API.md#factory-本机工作流)。
- `npm run check` 检查 301 个脚本，全部通过。
- `node --test --test-concurrency=2 tests/factory-workbench.test.mjs tests/factory-runtime-browser.test.mjs tests/factory-native-tools.test.mjs tests/factory-native-github.test.mjs tests/server.test.mjs tests/team-access-http.test.mjs tests/task-orchestration-browser.test.mjs` 通过 28/28。补充的嵌入页 390px、浏览器按钮交接、运行期间禁止删除项目分别经过对应专组复测。
- 实际运行了 Windows Factory 服务、真实 Edge、双向 WebSocket、会话 SSE、Git worktree 和本地 Git 分支集成。CLI 响应来自确定性夹具。原版 Review 退回后出现瞬时失败状态，测试等待最终运行结果并核对两次尝试。
- 实际 GitHub 路径使用模拟 gh 和文件协议远端，检查 Issue、草稿 PR 及重复交付，未连接 GitHub 账号。MCP 验证了本地的发现、缓存、删除，未调用外部工具。全量测试与真实付费模型未运行。
- 正常停止或关闭 Taskflow 后可以重启同一仓库查阅历史。Taskflow 被强制终止时需核对遗留原生进程，本次接入没有跨进程重连。无需数据库迁移。

下一项验收用真实登录的本机 Agent 和已授权的业务输入，核对工作流状态、实际用量和任务集成后的结果。
