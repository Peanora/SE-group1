# 王浩蒙的软件预览和源码交付模块

## 目标与基线

依据项目分工计划的第 5 人要求，补齐并验证「验收通过后可预览、可下载源码 ZIP、同提交强绑定、干净目录独立启动与复验、失败记录禁用预览和下载」全链路。

本模块基于 `main`（`15c2cd6`）切出个人分支 `codex/planned-delivery`。

## 修改范围与交付内容

| 要求 | 实现与验证入口 |
| --- | --- |
| 预览与交付绑定同一提交 | `lib/planned-preview.mjs` 在预览记录与公开 DTO 中透出 `candidateCommit` 与 `sourceHash`；`public/planned-execution.js` 在软件预览区展示当前预览提交短哈希，方便与执行记录和 ZIP 清单核对 |
| 交付包完整性与演进元信息兼容 | `lib/planned-archive.mjs` 补齐可选 `delivery/evolution.json` 元数据识别（修复含演进记录的 ZIP 复验失败问题），并解析只读 `verificationReport` 与 `startGuidePresent` 摘要（严格保持 `taskAccepted: false`、`historicalAcceptanceVerified: false`） |
| 接手人快速核对包内版本与验收报告 | `scripts/verify-planned-delivery.mjs` 新增 `--inspect` 模式（零模型调用、跨平台可用），输出 `archiveHash`、`binding`（含 `candidateCommit`/`sourceHash`/`manifestHash`）、`startGuidePresent`、`sourceFiles` 与 `verificationReport`；篡改任意字节返回退出码 `1` |
| 预约场景端到端预览与交付演示 | `scripts/deliver-reservations.mjs` 串联真实 Git、SQLite、`createPlannedExecutionService`、`createPlannedPreviews`、`createPlannedDelivery` 和 `inspectPlannedArchive`，完整演示预览试预约、停预览后下载 ZIP、解压到干净目录走完「A 预约 → B 候补 → A 取消 → 调度员提升 → B 确认 → 重启读回」，以及失败记录拒绝预览和下载 |
| 回归测试覆盖 | `tests/reservation-delivery-demo.test.mjs` 覆盖上述完整演示链路、`--inspect` 正负例（正常通过 / 篡改拒绝）及 `delivery/evolution.json` 归档核对 |

## 现场演示步骤

### 1. 一键运行预约预览与源码交付演示（跨平台、零模型费用）

在仓库根目录（Node.js >= 22.21.0）运行：

```bash
node scripts/deliver-reservations.mjs
```

命令将依次演示并校验：
1. 生成通过验收的预约候选提交，启动工作台预览，确认 `preview.candidateCommit === execution.candidateCommit`，在预览环境试做一次预约（HTTP 201），确认预览运行期间下载被 `409` 拦截；
2. 停止预览后下载正式源码 ZIP（保存至 `output/reservation-delivery/demo-*/planned-web-*.zip`）；
3. 将 ZIP 解压至全新的干净目录 `clean-handoff/`（使用独立 SQLite 数据目录 `.platform/tmp/app.sqlite`，不含预览试跑数据），核对 `START-HERE.md`、`delivery/manifest.json` 和 `delivery/verification.json` 均绑定同一 `candidateCommit`；
4. 在干净目录启动应用，完整走完 **A 预约确认 → B 候补第 1 位 → A 取消 → 调度员提升 B → B 确认 → 重启软件后 B 仍能看到 `confirmed` 预约与 `["queued","promoted","confirmed"]` 审计记录**；
5. 切换至一条审查阻塞的失败开发记录，确认 `canPreview: false`、`canDownload: false`，且直接调用预览与下载接口均返回 `409`。

### 2. 接手人核对交付包版本信息与验收报告

对上一步输出（或从工作台下载）的 ZIP 运行：

```bash
npm run planned:verify -- --archive <ZIP路径> --inspect
```

可零费用核对 ZIP 完整性和 SHA256 清单，直接查看 `candidateCommit`、`sourceHash`、`startGuidePresent` 和 `verificationReport`（自检 / HTTP / 浏览器通过数与审查阻塞数）。

若在配置好 Windows MXC 与 Edge 的 Windows 验收机上，可继续运行完整独立复验与冷启动检查：

```bash
npm run planned:verify -- --archive <ZIP路径>
npm run planned:verify -- --archive <ZIP路径> --cold-start
```

### 3. 工作台界面现场操作

1. 在工作台「代码与验收」打开已通过测试和审查的预约记录，点击「启动已验收软件预览」→ 核对显示的预览提交号 → 打开预览地址试做一次预约 → 点击「停止软件预览」；
2. 点击「下载当前已验收源码」保存 ZIP，交给另一位成员解压到干净目录，按包内 `START-HERE.md` 启动并完成预约主流程；
3. 切回一条失败的开发记录，确认预览入口和下载入口均不可用。

## 自测记录

- 运行环境：macOS，Node.js `v22.23.1`，Playwright `1.65.0`（`npm ci --ignore-scripts --no-audit --no-fund`）
- 语法检查：`npm run check` → **259 个脚本语法检查通过**
- 第 5 板块测试套件：

```bash
TMPDIR=/private/tmp node --test --test-reporter=spec \
  tests/planned-preview.test.mjs \
  tests/planned-preview-http.test.mjs \
  tests/planned-preview-service.test.mjs \
  tests/planned-archive.test.mjs \
  tests/planned-cold-start.test.mjs \
  tests/reservation-delivery-demo.test.mjs
```

结果：**35 项测试，33 通过，0 失败，2 跳过**（跳过的 2 项为需要 Windows MXC + Edge 的 `TASKFLOW_TEST_REAL_SANDBOX=1` 可选真机沙箱测试）。

> 注：macOS 默认 `os.tmpdir()` 为 `/var/folders/...`（`/var` 为指向 `/private/var` 的软链接），本地在 macOS 运行服务类测试时需指定 `TMPDIR=/private/tmp`；包内受保护启动器 `server.mjs`（见 `lib/web-delivery.mjs`）的正式受控运行仍面向 Windows MXC 环境。

## 提交信息

个人分支为 `codex/planned-delivery`，PR 标题使用 `王浩蒙 - 完成第5人软件预览和源码交付模块`，合入目标分支 `main`。
