# 首版验证记录

## 2026-11-21 开发总时限调整

- 重启原 4317 工作台后，从健康接口和超时项目的研发接口确认新尝试预算均为 `3600000` 毫秒。原超时记录保留 `600000` 毫秒，仍可从当前已确认计划启动或保留候选修复。未触发收费重试。
- `npm run check` 通过 268 个脚本。研发服务、整体执行器、Worker 和自动交付 HTTP 组 29 通过、2 项可选测试跳过。此前已确认计划的新尝试用一小时测试通过，旧记录、累计用量与预留勾稽均保持正确。
- 原生 Edge/MXC 自动交付端到端通过，实际独立 Worker 的研发执行冻结一小时，使用本机模型夹具。逐任务执行器回归 1/1，任务基准免费预检通过。前端回归 29 通过、1 项可选测试跳过，覆盖整体、分任务、旧时限和超限拒绝。未等待完整一小时或调用付费模型。

## 2026-11-21 自动交付

- `npm run check` 检查 268 个脚本通过。本轮集成后的 `npm test` 共 1381 项，1293 通过、88 条可选场景跳过、0 失败。随后对最终进度与就绪检查改动复验自动交付 HTTP 和原生浏览器。
- `node --test tests/automatic-delivery-http.test.mjs` 通过 4/4。覆盖本机与单次用量确认、保留手动路径、同一次运行澄清续跑、交付门禁和清单用量耗尽。
- 在本机 MXC 和 Edge 下设置 `TASKFLOW_TEST_REAL_SANDBOX=1`、`EXECUTION_SANDBOX_EXE` 后运行 `node --test tests/automatic-delivery-browser.test.mjs`。首次验证及后续复验均通过。小组公告需求从网页输入，仅提交一次业务答复。首个候选浏览器失败后自动修复，第二个候选收到审查阻塞，第三个候选关闭该问题。复验候选 `ded1bef9a4a266eb47b4498a822864f46af03193` 通过自检 5/5、HTTP 5/5、桌面/窄屏 Edge 9/9 和同版本独立代码审查。实际五个模型适配器共向本机夹具发送 9 次请求；候选通过后网页下载 ZIP，刷新仍能读取进度。未调用外部付费模型。
- 首次通过候选 `bc3851856fe2170680c50543e6bf68b576413f07` 的源码 ZIP 留在 `output/automatic-delivery-demo/automatic-announcement-source.zip`。用 `npm run planned:verify -- --archive output/automatic-delivery-demo/automatic-announcement-source.zip` 免费复验接口 5/5 和 Edge 9/9。全新解包后 `npm start`，验证公告 GET 200、POST 405、桌面及 390px 正文和正常停止。
- 原工作台、澄清、执行面板和清单等 Edge 回归 71 项通过，1 项可选原生测试跳过。模型服务故障、预算耗尽和停止未知均不得升级为完成；本轮没有变更现有项目存档或数据库结构。

## 2026-11-21 需求与验收可视化

- `npm run check` 通过，共 265 个脚本。
- 工作台、首页流程、任务修订、验收清单、角色证据及接口组合 40/40 通过。执行 `node --test --test-concurrency=3 tests/workspace-ui-browser.test.mjs tests/web-execution-browser.test.mjs tests/homepage-workflow-browser.test.mjs tests/visual-task-changes-browser.test.mjs tests/verification-planning-browser.test.mjs tests/planned-role-progress.test.mjs tests/source-change-http.test.mjs tests/planned-task-http.test.mjs tests/planned-record-data.test.mjs`。启用本机 MXC，使用本机模型夹具走通浏览器失败返工、Review 阻塞返工、同版本预览和源码下载。日志 `output/playwright/project-redesign/final-regression-confirmed.log`。
- `node --test --test-concurrency=2 tests/project-redesign-browser.test.mjs tests/planned-preview-panel.test.mjs` 通过 20/20。1440px 与 390px Edge 验证改动草稿存留、保存后折叠、检查点拒绝、应用读取确认、流程定位、键盘选择及同候选失败证据。测试还覆盖确认用量、历史通过、回执未确认及未知状态的交付门禁。日志 `output/ui-navigation/project-redesign/regression-final3.log`。
- 最后调整已生效阶段的导航后，需求流程桌面及手机补验 2/2 通过。定位重新规划按钮时保留原运行，显式启动后才创建绑定新需求的运行。原需求变更两组通过 29/29（`node --test --test-concurrency=2 tests/source-changes-panel.test.mjs tests/source-change-browser.test.mjs`）。
- 执行面板与任务面板原组件组（`planned-execution-panel.test.mjs`、`planned-task-panel.test.mjs`）通过 42/42。早期回归按旧文案等待“配置模型”，现按原有页面的“编码模型”定位。桌面图改为优先适配容器后，旧图测试验证节点可读且不重叠，仍检查任务与依赖、焦点和真实工具证据。
- 本地 4317 首页、入口脚本和两个新增样式文件均返回 HTTP 200。截图位于 `output/ui-navigation/project-redesign/`，页面使用测试数据。未运行全量套件及外部付费模型。

## 2026-11-21 工作台改版与设置分离

- `npm run check` 通过，共 264 个脚本。
- `node --test --test-concurrency=2 tests/workspace-ui-browser.test.mjs tests/visual-task-changes-browser.test.mjs tests/requirement-clarification-browser.test.mjs` 通过 17/17。真实 Edge 覆盖既有工作区、焦点和草稿保留、计划修订、需求澄清与九步展开后定位验收证据。日志 `output/workbench-redesign/workbench-final.log`。
- 启用本机当前 MXC 后，`node --test tests/homepage-workflow-browser.test.mjs` 通过 3/3，无跳过。覆盖桌面和 390px 的首屏摘要、键盘展开、刷新折叠，以及使用本机模型夹具的浏览器失败返工、Review 阻塞返工、预览、ZIP 下载及恢复。日志 `output/workbench-redesign/homepage-final.log`。
- `node --test tests/agent-settings-browser.test.mjs` 通过 3/3。真实 Edge 和临时配置存储验证两个入口的配置隔离、API 抽屉与焦点、跨页并发保护和密码保留、读取失败重试、未保存导航提示、长列表删除反馈和取消删除零写入。`node --test tests/agent-settings.test.mjs tests/agent-settings-http.test.mjs` 通过 14/14。日志 `output/workbench-redesign/settings-browser-final.log` 和 `settings-http.log`。
- 实际 Edge 截图放在 `output/workbench-redesign/`。工作台和两个设置入口分别检查 1440px 和 390px，工作台额外检查 320px。使用临时项目与测试配置，无异常横向溢出、页面错误或实际供应商模型请求。现有 4317 服务的首页、两个设置路由及主题 CSS 均返回 200。

回归覆盖本轮改动及相邻流程。完整 `npm test` 与真实外部模型未在本轮运行。

## 2026-11-21 网页多角色与 API 配置

基准 `631e2e055ff9a9400035e981908fbaf41f901b30`。用户原有 `docs/tasks/team-delivery-plan.md` 改动保留。实现记录见 [本轮任务](tasks/agent-api-settings.md)。模型调用仅发往本机夹具，未使用真实供应商密钥或付费 API。所有测试使用临时数据目录。

- 最终 `npm run check`：264 个脚本语法通过。
- `node --test tests/agent-settings.test.mjs tests/agent-settings-http.test.mjs`：14/14。多 API/五角色配置、CAS、密钥保留/清除/密文落盘、重启、链接拒绝、当前及历史凭据脱敏、本机来源与团队负责人权限；真实 HTTP 规格请求在换配置后保持原请求。
- `node --test tests/agent-settings-browser.test.mjs tests/planned-preview-panel.test.mjs`：16/16。实际 Edge 桌面/390px，真实配置 API 的增删改和角色分配，密码不回填、不进浏览器 storage，冲突保留草稿、焦点、无横向溢出及控制台错误。截图为 `output/agent-api/settings-desktop.png`、`settings-mobile.png`，交互摘要为 `ui-evidence.json`。
- 路由/适配器组合 47 项：46 通过、1 项可选原生检查跳过；固定参考服务组合 93 项：91 通过、2 项可选原生检查跳过。日志为 `routing-regression.log`、`fixed-role-regression.log`（均在 `output/agent-api/`）。
- 单独设置 `TASKFLOW_TEST_REAL_SANDBOX=1` 和本机当前 MXC 的 `EXECUTION_SANDBOX_EXE` 后，`node --test tests/agent-role-routing.test.mjs` 最终 5/5、零跳过。五个原生适配器分别请求不同本机端点；真实独立 Worker 的编码与 Review 使用不同 API，编码在途切换双角色配置后仍用原 Review 地址/模型/控制参数，独立 HTTP、桌面及手机 Edge 检查通过。已确认两份密钥不进入公开配置 hash、Worker argv 或环境。原旧路径不可用的失败保留，新安装路径的最终日志为 `native-role-routing-final.log`。
- `node --test tests/web-execution-http.test.mjs tests/agent-settings-http.test.mjs tests/source-change-http.test.mjs` 最终 17/17，覆盖初始化失败清理、本地配置目录兼容与来源门禁。规划执行 HTTP 单独复测 8/8。
- 首次 `npm test`：1365 项，1269 通过、10 失败、86 可选跳过，原日志 `full-tests.log` 保留；检查期间还有并行开发和测试，因此不作为最终固定代码全绿证据。发现并修复两个本轮集成问题（新私有目录的旧断言、配置初始化失败时注入服务清理），并改正三个既有测试设置/定位：任务卡描述与角色上下文都为 `p` 的选择器歧义；手动修复测试应通过 HTTP 预置失败草案，避免按钮自动修复提前完成；滚动应检查阅读点视口位置，前置流程图换行后浏览器原生锚定会改变绝对 scrollY。
- 手动清单修复单项复测 1/1；工作台桌面/窄屏完整组 10/10。滚动诊断有/无新增侧栏链接两组均为 scrollY +19px、输入框视口位置变化 0.0625px，焦点与选区保持。测试仍要求阅读点变化不超过 2px，未修改产品或放宽业务预期。
- 双模型费用确认面板 `node --test tests/planned-execution-panel.test.mjs tests/execution-panel.test.mjs` 最终 53/53，覆盖显示不同编码与审查模型、Review 配置变化撤销旧同意，以及旧服务无 Review 名称的兼容。日志 `dual-model-panels-verified.log`。
- 重型 Git 诊断：原生执行核心整组串行通过，178.7秒，`git-serial-final.log` 保留此前检查点120秒包装超时与任务30秒等待超时。任务图实际约43秒完成、首个完整交付恢复用例约130秒；仅在诊断副本延长等待、保留原断言后完整通过，见 `task-service-budget-diagnostic.log`。据此将测试任务等待调90秒、检查点等待调30秒，重型多用例子进程上限调300秒；不改生产预算或业务判据。正式任务服务 wrapper 1/1（内部3/3）通过，151.3秒，日志 `task-service-final.log`。检查点子模式原10秒等待下21/22，唯一失败也为Git候选等待超时，正式新等待复验单独记录。
- 最终正式检查点整组 wrapper 1/1（原22个子用例全部成功），146.8秒，`checkpoint-verified.log`；最终集成组合 `node --test --test-concurrency=2 tests/agent-settings.test.mjs tests/agent-settings-http.test.mjs tests/agent-role-routing.test.mjs tests/agent-settings-browser.test.mjs tests/planned-preview-panel.test.mjs tests/source-change-http.test.mjs tests/web-execution-http.test.mjs tests/planned-execution-http.test.mjs`：57 项，56 通过、1 项可选原生检查跳过、0 失败，`integration-final.log`。该原生检查已由前述显式启用的5/5专组补验。首次全量的失败项均已分别修复或经正式整组复跑关闭，未在最后再次整体运行 `npm test`，不宣称最终一次全量全绿。

原本机 `.env` 的 Windows 隔离程序路径已更新为实际验证通过的当前安装版本，API 密钥及其他配置保留，不提交 `.env`。现有 4317 服务未强制停止，重启本机工作台后加载新接口；之后网页修改 API 不需重启。没有推送或公网部署，未运行两家真实付费 API 的端到端业务验收。

## 2026-11-21 角色进度和证据回归

- `npm run check` 检查 257 个脚本，全部通过。
- 设置 `TASKFLOW_TEST_REAL_SANDBOX=1` 和本机 Windows 隔离执行程序后，运行 `node --test --test-concurrency=2 tests/planned-role-progress.test.mjs tests/planned-execution-panel.test.mjs tests/planned-task-panel.test.mjs tests/homepage-workflow-browser.test.mjs tests/reservation-review-demo.test.mjs`。52 项通过，零失败或跳过。日志见 `output/repair-diagnosis/role-progress-final-20261121-173508602.tap`。
- 真实 Edge 验证桌面和 390px 下的状态、候选提交、错误详情、轮询和键盘焦点。首页流程用本机固定模型响应，在 Windows 隔离环境完成浏览器检查失败及 Review 阻塞后的返工、预览和 ZIP 下载。本轮覆盖上述五个测试文件。

## 2026-11-21 预约候选同版诊断

- 在全新的临时目录中按原冻结清单复跑候选 `5342d192c37e80384db2283c5887f6a71874d07b`。清单 SHA256 为 `eb10c5089efb367fec0df5175491fc2c1ae724bbdfce3c661e09da4414dfc31b`。使用仓库 HTTP 和浏览器验证器串行执行。HTTP/SQLite 78/78，桌面和窄屏真实 Edge 103/103，两个进程组均确认停止。候选和原输入快照的哈希核对一致。摘要见 `output/repair-diagnosis/reservations-isolated-recheck-2026-11-21T09-28-41-113Z-14e2621f.json`。
- 同版源码复核定位到 `src/bookings.mjs` 的首次预约保存裁剪后的引用，幂等重放却比较请求原值。单独使用新临时库追加诊断，带首尾空格的合法引用第一次提交返回 201。使用同一键重发原 JSON，预期返回 200 和 `replayed: true`，实际是 409 `idempotency_conflict`。复现进程确认停止。摘要见 `output/repair-diagnosis/reservations-replay-probe-502b45c8.json`。
- 源码复核还发现 `src/waitlist.mjs` 在提升时更新既有审计行的内部预约关联，有待按只追加约定处理。两次运行均使用本地隔离验证器，模型调用为零。正式 Review 和源码包交付仍待修复后的候选通过完整验收。

## 2026-11-19 首页项目流程图

- 五个相关测试文件共 66 项通过，无失败或跳过。真实 Edge 检查 1440px 与 390px 流程图、键盘发起新建、节点跳转、清单修订后返回确认，以及输入草稿和焦点。使用本地固定模型响应与真实 Windows 隔离执行，完成一次浏览器检查失败及一次 Review 阻塞后的自动返工，最终预览并下载 ZIP。
- 调整流程图行高后，另跑首页图和清单修订两个用例，2 项通过。语法检查 253 项通过，`git diff --check` 通过。本次未运行全仓测试或请求付费模型。

## 2026-11-19 微信原项目正式同版验收与下载

- 原项目正式执行 `f1bfc569-deca-432d-8025-4a2bc46117fd` 复用失败候选 `5ff4767`，保留冻结清单 `06aec96f`。一轮真实编码和一次独立 Review 结算，候选 `aec80b359bc632994eb8f40f6c02f675ab9ad2fa` 自检及独立 HTTP 均 56/56、Edge 83/83，Review 完成且没有问题。
- 正式 ZIP 共 245229 字节，SHA256 `970882376f63cda368b1b854bba6cac821b7297862ac5a8e4227d0a633535310`。从交付包免费复验 HTTP 56/56、Edge 83/83、停止已确认。在干净目录用包内 `npm start` 实际打开 390px Edge 登录页，执行 `STOP` 确认正常退出。产物及报告位于本机 `output/wechat-formal-repair-20261119/`。
- 官方交互预览在 256 KiB 输出限制下异常退出，已确认进程结束及源码未变。通过单条终态恢复解除占用。再次正式下载相同字节，重新打开登录页返回 200，正常停止后同时恢复预览和下载。此前的异常结果保留。
- 同一个交付包复制到新受控工作区，以 4 MiB 预览预算跑桌面与手机双账号。两次建号 201，好友申请与接受、发文本、手机读回并清除未读、桌面显示已读均通过。使用页面刷新同步状态，排除 favicon 404 后无业务页面错误，无横向溢出；累计 stdout 280353 字节，正常停止及源码未变。32 项关联回归及 5 项终态恢复测试通过。没有新增模型调用或公网部署。

## 2026-11-19 微信连续建号与登录定位

- 正式执行 `783451d7` 结算三次编码并在重复失败后结束。最后两版 HTTP 检查 56/56，Edge 61/83，未进入 Review。两端浏览器验收数据库里均只有管理员和 Bob。空的建号状态元素有最小高度，旧清单仅检查可见就进入第二次建号，候选代码在上一笔保存成功后才清空表单。
- 对同一次正式执行末版 `b0c2738` 的隔离副本，建号期间禁用全部字段，提交完成才显示状态，零未读不渲染徽标。修订提交 `a25c91dc` 在原冻结清单同一摘要下通过 HTTP 56/56、Edge 83/83，两个运行器均确认停止。没有修改正式记录、调用模型或执行正式 Review。
- 新草案在每次建号提交后等待账号输入清空，再核对状态，保留全部原断言。11 项定向测试和 252 个脚本语法检查通过。未修改的正式失败候选按新 41 步清单诊断，两端均实际创建并登录 Alice，继续运行到原零未读徽标断言，Edge 81/87。修订候选首跑遇到一次桌面登录跳转观察波动，保留 50/87 原结果；同版本复跑 Edge 87/87，正常停止。

## 2026-11-19 登录清单自动接续与真实留言板交付

- 78 项定向测试及最终 16 项完整工作台浏览器回归通过。覆盖 HTTP、团队权限、桌面与窄屏、旧计划保留、当前审批、旧版本拒绝、模型额度耗尽、重复请求复用草案和并发人工导入互斥。252 个脚本语法检查通过。
- 本机模拟模型的引导端到端在真实 Windows 隔离和 Edge 中通过，实际触发浏览器失败以及独立代码审查阻塞，随后产生新候选并跑到预览和源码下载。
- 原微信历史清单自动生成 33 个 HTTP 步骤和 39 个浏览器步骤的待审阅草案。原断言保留。修正零未读徽标后的隔离代码用该清单复验 HTTP 56/56、桌面及窄屏 Edge 83/83，均确认停止。未正式 Review 或下载微信源码。
- 值班留言板使用真实模型。第二份模型清单草案经人工修订并正常确认。源码提交 `c2a65c3aca7f156508103bcababcfc191052012e` 通过 HTTP 40/40、Edge 29/29 和同版本 Review，阻塞项为零。下载 ZIP 后独立复验通过，并按 `START-HERE.md` 在新解包目录两次执行 `npm start`。两个视口均提交 201，重启后可读回并按新到旧显示。源码包位于本机 `output/duty-board-e2e-20261119/`，未发布公网。

## 2026-11-19 解除累计开发次数限制与清单修订入口

回归从原 `3` 次执行、`18` 次累计模型调用账本重新打开并连续执行至第 `11` 次。夹具结算 `22` 次模型调用，仍保留原账本和历史尝试，预留归零。未知状态阻塞与取消结算继续适用。执行器回归验证浏览器测试、HTTP 自检和审查问题自动返工，进度确实变化时继续本轮。连续同一失败停止重复派发，明确漏登录的清单在再次调用编码前要求修订。

HTTP 集成验证失败原因与权限绑定，旧清单不能再次收费执行，修订动作产生待确认计划和保留旧历史，重复的陈旧请求被拒绝。Edge 验证修订入口回到方案确认，未调用外部模型。确认原 4317 无活动开发、验收或预览后重启原数据目录。实际微信执行在 1440px 与 390px 的首页及技术详情显示 Alice 缺失登录、下一步和可操作按钮。该检查只读取原项目，旧验收结论保留。

## 2026-11-19 自动返工、浏览器引导与源码交付

从真实引导页输入需求并确认方案，验收草案的可确定问题自动恢复，用户确认草案后开始开发。本地固定模型依次提供浏览器定位错误候选、带独立审查阻塞的候选和修正候选。后端在同一执行自动返工两次。浏览器检查失败的版本没有请求模型审查，每个修订版本重新执行适用检查。Edge 在窄屏查看自动返工和阶段切换，最终打开目标预览并下载 ZIP。正式引导回归 2/2，源码包脱离界面复核 HTTP 5/5、Edge 9/9，均确认停止。

真实模型便笺基准 `node scripts/check-planned-execution.mjs --model` 共 3 次调用。第一次编码回执因引号格式无效未应用，第二次自动使用逐文件文本并形成提交 `2db5f861935bd7153da974a613bc8094d9251ea2`。同一版本独立 HTTP 13/13、Edge 27/27 和真实模型 Review 完成，遗留阻塞 0。实际交付包 `output/repair-diagnosis/Taskflow-便笺-实际交付源码.zip`，SHA256 `1136AA76D1BCA42E962482DE65D6BD87631B2C9064204B32D4FDEFE4671C1B3F`。对该包重新执行 `planned:verify` 得到 HTTP 13/13、Edge 27/27，进程停止确认，复验不调用模型。

另把实际交付包解压到独立目录，以包内启动器打开。桌面 Edge 添加便笺后正常停止，重启在 390px Edge 确认数据读回并检查横向溢出，两次启动均收到停止确认。截图位于 `output/repair-diagnosis/Taskflow-便笺-交付实跑.png`。

真实模型值班留言板保留未交付记录。其隔离演示最后一版 HTTP 35/35，Edge 33/63，独立场景与普通会话复用的数据前置条件有冲突。同一普通会话缺少创建步骤现可在确认清单前补上。后续跨会话预期条数仍需核对，现有记录未标记为通过。用户原 4317 工作区及微信数据未改动。新版代码用单独数据目录启动在 4318。

## 2026-11-19 开发期间的清单状态与微信浏览器复验

`node --test tests/guided-workspace-browser.test.mjs` 启用真实 Windows 隔离与 Edge 后 2 项通过。完整引导回归在实际开发请求受理后暂停夹具，确认服务端因锁定暂时隐藏当前清单。重新加载后，第 3 步保持完成，第 4 步显示开发中，原测试提案失败留在历史。释放夹具后继续到验收、预览和源码下载。相关清单、开发面板及工作区回归 54 项通过，247 个脚本语法检查通过。测试使用本地固定模型响应。实际项目 1440px 与 390px 只读检查均显示第 4 步失败及具体登录提示，接口结果为 56/56。

微信执行 `c84fa624-7566-4738-a436-da1893c925d2` 的原候选 `a3d82f4da69dc80671cee0f35e22b7f3f5d8f860` 通过 56 项接口检查，Edge 3/33。真实浏览器复现登录页内联样式触发内容安全策略。隔离副本将样式移入现有样式表后，原清单的页面检查到达 13/33，独立浏览器会话访问受保护页面前缺少登录前置操作。隔离清单补入管理员创建两名测试成员和各角色登录、核对初始未读数，原 HTTP 定义保持逐项相同。继续修复管理表单在初始化完成前可提交和聊天布局窄屏溢出。最终隔离候选 `05d69347a1a1dad98ff444749cb098129e0962a0` 与诊断清单摘要 `4c113a012d5db1f3e70fad6f328e29a1145d48d7e5467315f97c04efa4346eec` 复验 HTTP 56/56、Edge 79/79，两个验证进程组停止已确认。

本地报告和补丁位于 `output/repair-diagnosis/wechat-browser-20261119.json` 与同名 `.patch`，诊断清单位于 `output/repair-diagnosis/wechat-verification-draft-20261119.json`。原执行结果的文件摘要复核一致。本轮未保存或认可新的正式清单，未调用外部模型，未重启服务。隔离候选待新版本正式确认、运行同版本验收及 Review，尚无平台预览和下载资格。

## 2026-11-19 自然语言引导工作台

用本地固定模型响应，从真实工作台输入一句话、回答澄清、确认功能和计划、修复验收清单、认可、开发与测试，到启动预览、打开软件、停止预览、下载源码全部跑通。目标软件使用真实隔离运行、HTTP 检查及桌面和窄屏 Edge。额外生成一条失败的测试记录后，引导页仍选择之前可用的待审阅清单。流程全程用页面操作完成，常用步骤没有出现 JSON 编辑。未调用外部模型。

在正在运行的工作台对截图所示项目执行只读浏览器检查。1440px 与 390px 均选择同一份待审阅草案，显示 33 个接口步骤和 14 个页面步骤，确认按钮在初始视口，页面无横向溢出。此次未修改现场记录。

相关页面与组件回归分别为 92 项通过和 24 项通过，第二组有 1 项按配置跳过。247 个脚本语法检查通过。交互参考 GOV.UK Design System 的核对答案、USWDS 的步骤指示器及 Node-RED 的独立调试区。

## 2026-11-19 首版范围回答与验收清单恢复

规格、清单校验、清单服务与 HTTP 定向测试 127 项通过，2 项按配置跳过。桌面和窄屏 Edge 定向回归 34 项通过。245 个脚本语法检查通过。回归验证「都需要」确认列出的首版功能，互斥选项仍补问。验收草案可一键补齐已知前置依赖，改为整项目验收时保留步骤及预期。重复保存复用同一待审阅草案，缺漏测内容、旧版本或失去完整性的草案仍由原校验拦截。

对实际失败提案核对私有回执完整性，通过当前工作台的导入入口保存了第 2 条待审阅定义。保留原 33 个接口步骤、14 个浏览器步骤及所有预期，补齐一条会话编号的前置依赖，整项目执行取代无效的可选分组。未认可清单，未启动编码或测试，模型调用与原失败记录不变。工作台进程未重启。

## 2026-11-19 主项目全量回归

启用真实 Windows 隔离进程与 Edge，清除测试进程的模型配置，`node --test --test-concurrency=4 tests/*.test.mjs` 通过 1374 项，失败 0，跳过 1，用时 609 秒。单独补跑跳过的原 v3 创建竞态诊断，1/1 通过识别历史缺陷。两次结果单独记录。245 个脚本语法检查通过。

首轮回归暴露旧 CLI 模拟入口、网页测试定位及 Git 任务图夹具等待问题。修订后保留原业务断言，定向 31/31 通过，再执行上述全量确认。全量记录在 `output/repair-diagnosis/platform-full-regression-20261119.tap`。本轮未重启用户服务、未写用户数据、未调用付费模型，主仓库未提交或推送。

## 2026-11-19 便笺与标签冷启动诊断

使用已交付原包 `1b47272abb16794ef12184a2ade58c1bc7f2f64a` 与只修改四个页面文件的隔离候选 `f99b2e9daff9f0a75b6699c0bf5d622d8248fce4` 对照。真实 Edge 在 1440px 和 390px 分别延迟脚本及首次数据。原包四项均观察到默认导航、零 POST；候选四项等待就绪后均仅一次 POST、HTTP 201，重启后检查通过。候选原定义 HTTP 43/43、Edge 85/85，验收进程停止已确认。新增真实 Edge 回归覆盖脚本前默认导航、数据前过早启用和两个视口的正常提交。原 ZIP 校验值未变。这次零模型调用，未重发交付包或为新代码取得模型 Review。

本地证据在 `output/repair-diagnosis/notes-cold-start-20261119.json` 和同名 `.patch`。完整源码包验收仍需新代码版本的 Review。

最终主项目再次使用原包执行默认复核，HTTP 43/43、Edge 85/85，正常停止。原包摘要仍为 `5f748cebde08315ea18052fb6a105df084819de01ddb89e63bee6fcbb10a5a96`。使用新增冷启动选项同一原包仍为 0/4，分别记录两份结论。默认复核记录在 `output/planned-delivery-checks/planned-delivery-quxSGd/revalidation.json`。

## 2026-11-19 预约候补提升复跑

保留历史候选 `afecba47b32642abff5635d5b8c6d4df4e406182` 和历史 Edge 81/103，按原批准的定义对隔离候选 `5342d192c37e80384db2283c5887f6a71874d07b` 执行 HTTP 78/78、Edge 103/103。两个视口都验证调度员实际提升、成员看到 held 并确认、该预约的审计数为 3。原回执与用量保留，两套检查停止已确认。诊断零模型调用，无新 Review 或交付资格。本地证据在 `output/repair-diagnosis/reservations-waitlist-20261119.json` 和同名 `.patch`。

## 2026-11-19 库存出库首条时序

保留历史候选 `88771bbe28a8e3ceaf71fa9bc9fff96aeeda4b53` 和历史 Edge 75/99。隔离候选 `3cb3aa00f5896d189a7c5e54f50cb533b7fef0ec` 仅修改出库列表两文件，使首次及查询期间只有有效目标时可打开首条。原批准定义 HTTP 82/82、Edge 99/99。两个视口均打开首条、保管员过账、库存显示 8、审计显示 2。两套检查停止已确认。诊断零模型调用，无新 Review 或交付资格。本地证据在 `output/repair-diagnosis/inventory-outbound-20261119.json` 和同名 `.patch`。

## 2026-11-19 工单登录、筛选与页面表单

历史版本 `97884f6d0ba80816bdb6ca814a9e2760654174e9` 的原清单以当前规则重新编译，清单摘要随规则变化、步骤没有修改。实际 Edge 复现两个视口在登录身份断言前触发 `/api/me` 401，HTTP 79/79、Edge 11/97。仅修登录的隔离候选通过身份断言，Edge 到状态筛选时因原填值步骤遇到只可选择的下拉框，停在 65/97。

隔离候选 `715428797031bd52df4718a13b0880d46cfdd006` 另提供可填可选的工单状态、页面内标题编辑和解决方案。按当前规则执行原步骤 HTTP 79/79、Edge 97/97。两视口各补验五次实际写入，从创建、改标题、分派、解决到关闭，均成功且无弹窗与控制台错误。所有检查进程已停止，诊断零模型调用。历史记录未改，新代码没有 Review 或交付资格。本地证据在 `output/repair-diagnosis/ticket-*.json` 和候选同名补丁。

## 2026-11-19 采购留出与运行器响应预算诊断

首评、原清单和历史代码保持。当前规则复跑隔离候选，先修登录到 Edge 83/111，再修收货表单可见性、就绪检查和连续录入到 104/111。候选 `9f2030ecc635c63e3c260cc330ce762291fcd69e` 的 HTTP 89/89。两个浏览器运行均完成两次收货，最终筛选页加载时中断，进程已确认停止。停止前各方向记录 stdout 269848 字节，stderr 169 字节，原因是正常应用响应计入 256 KiB 总输出额度。

隔离运行器使用独立的 4 MiB 响应协议累计预算，单帧、响应、日志、时间与停止约束仍有效。测试 12 次各 24000 字节响应，旧运行器完成 8 次后停止，新运行器完成 12 次且正常退出；另对 4096 字节日志额度验证 8192 字节日志被阻止、进程停止。采购同一候选在试验运行器上按原浏览器步骤 111/111。没有改主项目运行器、历史验收、模型账或原评分。相关补丁与记录在 `output/repair-diagnosis/procurement-*-20261119.*` 及 `runtime-response-budget-20261119.*`，仍需旧交付兼容和采购其他业务复验。

## 验收清单失败诊断与复用

清单服务、HTTP、研发门禁与团队权限定向测试72项通过，Edge定向测试5项通过，243个脚本语法检查通过。使用临时项目和模拟模型验证未通过的完整回包可定位漏测项、载入草案、保存失败后保留编辑、刷新恢复与另存待审阅记录。损坏回包和旧计划不能载入编辑，原失败与一次模型用量保持。针对用户第二次生成失败的记录进行了只读核对，可载入40个接口步骤和12个浏览器步骤，漏测R-006、R-007、R-009。未对现场项目保存修订或调用模型。

## 项目全流程、验收入口与已确认任务修订

规划、研发、验收定义和团队权限相关后端测试39项通过，Edge相关测试41项通过，242个脚本语法检查通过。Edge在1440px、390px验证了缺验收清单时可直接定位准备入口、已确认任务可编辑且保存前保留审批、保存后生成新计划并重新等待确认。另以版本绑定的模拟记录验证编码许可、测试进度、检查明细定位及交付入口。窄屏后台错误与状态刷新不抢焦点或改变阅读位置。真实HTTP回归覆盖活动编码期间拒绝保存已确认计划的修订。使用临时项目和模拟模型或执行记录，未为现场项目发起付费调用。

## 首轮集中澄清、旧问答复用与草案定位

Node.js 22.21 的规划、规格、团队权限和工作区相关定向测试159项通过。Edge 与通知定向测试20项通过，241个脚本语法检查通过。使用模拟模型在1440px、390px核对了引用失败的草案标题、内容和引用，确认仅追问本轮模糊原题、重复模糊提交不产生模型调用、草案待答时进度显示「等待补充需求」。首轮标点差异重复项去重和旧运行使用已有答复的恢复均有后端回归。

对截图中第七次运行做了只读回放。三个旧问题在新版问题区均已隐藏，可以用已保存的回答重新整理。真实运行未写入，验证期间未调用配置的模型 API。

## 逐题问答与自动追问

Node.js 22.21 运行规格、工程规划及团队权限相关后端测试112项，浏览器与通知测试20项，全部通过。241个脚本语法检查通过。两个视口（1440px、390px）使用真实 Edge 操作和模拟模型响应，覆盖打开「查看问题」自动生成、逐题表单、部分草稿刷新恢复、同一运行自动追问、新一轮焦点与最终人工规格确认。窄屏另验证了实际摘要校验产生的问题。相同问题再次打开复用已存结果，接口故障不会自动发起业务提问。工作台真实模型请求未纳入本轮验证。

## 模型规划不限次数与自然语言问题处理

Node.js 22.21 运行了115项后端相关测试与22项Edge和通知相关测试，全部通过。241个脚本语法检查通过。业务验证使用独立临时项目和可控模型响应，未调用真实模型。旧有限规格运行在同一编号下从第一次失败继续至第五次，保留首回执；工程第七次取得有效草案。有限配置、旧版本失效、传输结果未知时待核对等回归通过。

1440px与390px均通过「查看问题」定位、模型说明、保存回答、刷新恢复和从同一运行继续整理，结果停在待确认规格。390px另验证真表单摘要校验会给出可定位的问题；原规格未发布空摘要。模型解释单独记回执和用量，历史问题作为非需求上下文，原需求和用户原话用于引用。

## 2026-11-18 预约与库存原尝试结束

预约执行 `47832598-51f8-4cc1-aa66-8c37cc55c03e` 保留最后候选和原10次历史回执。新3编码、3 Review，381108输入、23502输出token。三个候选自检及独立HTTP各78/78，三次Edge均81/103。双视口 b39 到达 `/bookings?q=WEB`，b40 waiter 的预约行实际0、期望1，末版Review 0阻塞。b41及之后的相应步骤未执行。原3次尝试用尽，16真实调用、0预留，无ZIP。末提交 `afecba47b32642abff5635d5b8c6d4df4e406182`，审计和74个具名进程停止核对在 `output/quality-model-acceptance/reservations-v0/i20-repair2/`。

独立只读复核六个对应的浏览器数据库均为候补未提升，预期预约与promoted审计均未生成。源码存在角色和列表就绪前可点击提升且处理器直接返回的路径，后续还需按已确认语义显示实际queued数量。原浏览器记录缺请求证据，不能用源码路径断定唯一时序。报告同目录 `review-independent/RESULT.md` SHA `ADC30C194EEFC6122067467F1C2C09AFC3802C15CCB862816B8C40B92D98451A`。

库存执行 `70e221ae-77ec-4877-a86f-cb87f75485ef` 末提交 `88771bbe28a8e3ceaf71fa9bc9fff96aeeda4b53`。自检和独立HTTP各82/82，双视口Edge 75/99，b37 operator的过账控件实际计数0，守卫无错误。编码1及原始无效Review回包均有正常停止回执，共118617输入、10817输出token。编码2已派发并结束但无有效回执或用量，单独列未知。原3次尝试用尽，12真实调用、0预留，无ZIP。审计和28个具名进程停止核对在 `output/quality-model-acceptance/inventory-v0/i14-fresh-run/i20-repair2/`。

独立复核确认b13列表文字和b25筛选双视口通过。b37统计全部匹配节点计数为0，详情源码包含过账按钮；列表首行按钮已可点击但未取得ID时会静默返回，是现有源码的就绪缺口，原记录未捕获最终URL。原Review回包对历史问题编号漏一字符，经同版解码器复核仍无效。报告同目录 `review-independent/REPORT.md` SHA `2232DC55984FC1B81AC7B057D78D658FC31369B64854AA2146525BCFE04CCEDF`。

便笺与标签的独立验包逐项匹配同图、8回执和双ZIP，随后隔离干净副本离线安装和启动通过，首次桌面创建等待超时，停机后SQLite无便笺。为此副本保留原始红，该次未记录请求、导航，也未运行手机、标签和跨进程重启。独立报告 `output/i20/output/ngc2/REPORT.md` SHA `F9C9D07948AF4B081E5F01F7CB1E2C1067E1CFBE647D4E866B3D35B995A43EBB`。

对同一ZIP的新副本加请求和导航观测，普通桌面创建出现初始表单可点、脚本尚未就绪、默认GET导航以及0创建POST。另一个副本只延迟同源 `notes.js`，重现空表和默认GET。释放该脚本并确认真实列表加载完后，在桌面和手机各创建便笺与标签，4次POST均201；正常停机、同路径重开后，两表各2行和应用观察一致。全部包进程确认停止，源码、归档及旧报告字节保持。原失败当时的网络细节未知。报告 `output/i20/output/ngd/REPORT.md` SHA `4E17B6CB5AF757A83FC437C5993DC40DED0B09B2E247978A457B779DBCBEC489`，0模型调用。集成验收、两次控制服务重开同ZIP、干净包交互仍按各自记录判定。

## 2026-11-18 库存带诊断修复与真实四任务集成

库存保留源码修复 `2e4f9b47-d30c-43b9-a057-c74c0c49a7cf` 使用通过定向验收的i20。3编码、3 Review，337246输入、40137输出token；三个候选自检82/82和独立HTTP82/82。双视口Edge分别15/99、27/99、27/99，首版在 b7 控件隐藏处失败，后两版实际完成创建后 b13 文本不符。最终提交为 `7ab96689ee04a4057b7c0ea62b4416eabde07ee5`，末版有9条模型阻塞意见，未交付。原失败未改，预算2次尝试/9实际调用/0预留。真实记录和74个具名进程停止核对在 `output/quality-model-acceptance/inventory-v0/i14-fresh-run/i20-repair1/`。

i20四任务 `1d29a1ad-a624-4020-948f-8ea97e7716cb` 的前置规格、计划和定义是公开夹具。实际4编码及4 Review，131670输入、10904输出，共8次，尝试1、预留0。NOTES与TAGS共用真实基础提交、不同工作副本，实际编码区间重叠，2次Git合并的双亲关系逐项核对。FINAL `1b47272abb16794ef12184a2ade58c1bc7f2f64a` 自检和独立HTTP各43/43，桌面与手机Edge共85/85，4个延迟加载创建回归通过，真实Review完成且阻塞0。SQLite同时核对同一文件的便笺与标签。原基准 `output/i20/output/nt/notes-tags-wyLYwL/summary.json` 在重启首次读取仍显示历史通过、当前资格待复核时断言失败，保留原结论和记录。

独立运行的后续控制服务重开核对同一图两次均观察到待核对转为可下载，随后两个ZIP均281318字节、SHA `5F748CEBDE08315EA18052FB6A105DF084819DE01DDB89E63BEE6FCBB10A5A96`，0模型传输尝试、0预算变化、0原报告变化。报告 `output/repair-diagnosis/NOTES-GRAPH-RECOVERY.json`，此次使用真实控制服务的内部方法复核，未替代团队HTTP会话验证或修改原基准报告。后续脚本改用有界等待同一提交与恢复标记，比较两次下载，语法和免费夹具检查6/6。累计126次、2819826输入、676636输出token，金额未知。

## 2026-11-18 i20修复说明独立验收

固定276文件清单 `62C86B0D53E2F5464922EF03EFD41D98BFCF7C3E097F4B29E3ED08E07860505F`。非作者定向Test 13文件117/117，0失败、取消或跳过。真实原生修复确认5种非法说明在费用预留前拒绝，原失败和回执保持，仅新编码反馈收到有效说明，修复及两次重开下载三份相同77726字节ZIP。真实Edge界面21/21，核对说明焦点、刷新、候选切换、费用确认和旧请求兼容。239入口、13嵌套脚本语法通过，124个采样自有实例已结束，真实模型0。独立Review实际跑16项输入边界，核对定义与浏览器策略哈希不变、执行器及Worker按预期换版。报告分别为 `output/i20/output/nt20/REPORT.md` 和 `output/i20/output/ir-i20/REPORT.md`。本次未运行整仓全集。

## 2026-11-18 预约保留修复及库存新版首轮编码

预约修复在定向放行的i19首次取得202，新执行 `103b8175-ccce-4706-a2bf-3fa27b8eb38d` 保留原源码、4份历史回执与阻塞。三版自检和独立HTTP各78/78，Edge桌面和手机共103项，实际通过10、11、10，未执行91、90、91。原报告记录console守卫计数。将第一版Git `1997c661a88c634cc1642ae062c4940838267bb3` 原样复制到新隔离目录，复现公共登录导航先请求 `GET /api/me` 401，Edge记录对应资源错误，进程均停止。诊断 `output/rd/login-6lbDwq/DIAGNOSTIC.json`，并未运行整套业务用例。独立静态复核另发现三版审计会混合不同实体同ID的历史，第一版模型Review的0阻塞不能盖过断言失败和遗漏。原业务失败不开放ZIP。

库存新计划在同一i19实际首次编码 `6775773c-83b0-4ebe-bd77-7e2fd76f38eb`，3次编码、0 Review。第1次出界未应用，第2和3次形成Git候选，但均在q8返回401，自检16/82。独立复核两版各9处已有可信用户后仍使用空头再次认证，记录另有仓库授权和固定页面交互缺口。两份审计与STOP在 `reservations-v0/i19-repair1/` 和 `inventory-v0/i14-fresh-run/i19-api/` 的 `FINAL-AUDIT.json`、`STOP-CONFIRMATION.json`，根为 `output/quality-model-acceptance`。新预约6次377938输入、33738输出；新库存3次102515输入、54339输出。两运行预算分别2/10/0和1/3/0（尝试、实际调用、预留）。截至两轮结束总112次、2350910输入、625595输出，金额未知。

## 2026-11-18 i18接口修订与i19共享路径独立定向回归

i18固定276文件 `14C0E60B3FDA14814D83E365BB82CA75550CBDA79065DBAFCB0989961EAF75BE`，非作者195项定向通过，含独立HTTP、真实Edge和延后单独执行的原生用例，239入口与13嵌套脚本语法检查通过。窄Review通过，三类定义与工程策略哈希保持一致。Test报告 `output/i18/output/non-author-test/run-i18-20261118-staged-f6b2/REPORT.md`，Review报告 `output/i18/output/ir-i18/RESULT.md`。库存已按新版本正式修正工程接口、任务和确认记录。只调整定义中84处需求引用，保留37个HTTP步骤和47个Edge动作及断言。

i19固定276文件 `9C74B294EA27DCB12DE79F0440A3DD84204D8069795B07D6F2AC467CBE9DFC81`。首批独立定向87总、80通过、7失败，六个原生用例因运行目录过深在Git建基线前失败，另一个预览用例等待超时。按原断言在短工作目录复验9/9，含保留源码修复、原有费用记录、两次重开和同字节ZIP，预览原失败子项单独复验1/1。固定源五次零漂移，真实模型0。独立Review确认预约原平展24路径拒绝、精确并集22项通过来源检查，保留原Git、4回执和两条阻塞；审查期间固定源与12项原病例证据零漂移。Test报告 `output/i19/output/non-author-test/run-i19-20261118-native-short-9f20/REPORT.md`，Review报告 `output/i19/output/ir-i19/RESULT.md`。本次放行覆盖共享路径变更，未运行i19全集。原组合失败、预览负载下的稳定性和业务验收按各自证据记录。

## 2026-11-18 课堂规划闭环复验

在i19固定源分别输入图书借阅和工单示例，每个示例在独立临时数据中用本地规则运行两次。两者均生成规格、架构、任务、计划检查和可下载文档包，成对文档与计划投影可复现，0模型调用。报告位于 `output/i19/output/course-planning-library/acceptance.md` 和 `output/i19/output/course-planning-ticketing/acceptance.md`。本批验证课堂规划链路，真实浏览器交互与具体业务软件的检查另记。

## 2026-11-18 i17完整回归与预约首轮

i17固定275文件清单 `C6D715C7C317D086E59D2107868E330B71DE8F2A8D97035AA635551265FA234A`。非作者完整测试1363项，1362通过、0失败、0取消、1项原可选诊断跳过，528053.0042ms。238入口和13嵌套脚本语法通过，275文件首后核一致。三项真实浏览器就绪用例均在桌面和手机完成预期的观察与动作。独立窄Review通过，确认相对i16仅测试文件变化、生产预算和短时限断言未改。Test报告 `output/i17/output/non-author-test/run-i17-20261118-full-7e53/REPORT.md` SHA `FA4F9210952809C789B3D74C5472297AE23187FDA843E12B3E29CA07B9734856`，Review报告 `output/i17/output/ir-i17/RESULT.md` SHA `8E36ADA490A080C5FF948603DEA01DA8C742B75BB53FFE22087C29C04939B8E7`。i15和i16原失败保留。

预约采用原审批规格、原计划及人工独立审阅的固定33 HTTP/49 Edge定义。原计划在i17纯结构检查通过，正式导入并批准定义后只派发一次执行 `fd79ebab-3ed7-4ce6-9c7f-e86781eff5e9`。3编码、1 Review，4份回执均正常完成，148053输入/57867输出token。第1份建议未通过JSON或文件字段校验，第2份形成候选但自检失败。最后提交 `63b8b6724f47053f490bca84906d80ac0462b4ca` 自检78/78、独立HTTP78/78，浏览器10/103通过、2项失败、91项未执行，阻塞在登录操作附近的 `console_error`。Review另有两条候补转预约审计关联阻塞。没有通过或交付。临时host、Worker和测试环境均已确认停止。回执哈希、SQLite预算及同版本结果见 `output/quality-model-acceptance/reservations-v0/i17-api/FIRST-CODING-FINAL-AUDIT.json`。

库存仅在已放行i14续工程规划，从实际重新审阅通过的20需求规格开始。三次调用全部结算，26571输入/23792输出token。前两次分别因R-013覆盖遗漏及依赖循环被拒；第3次生成7任务/30文件，结构通过，登录/会话响应正文与确认规格冲突，计划未批准。回执和原始候选保存在 `output/quality-model-acceptance/inventory-v0/i14-fresh-run/resumed-engineering/`。截至预约首轮结束，累计103次真实调用、1870457输入/537518输出token，金额未知。

## 2026-11-18 i13独立完整Test通过但Review BLOCK，i14窄修复验中

固定275文件清单`50CFA347C941780EACD34E7D1061D1B2BE340352A07654DADBC1BE037A3AEC63`，新非作者Test运行完整`npm test`：1358总/1357pass/0fail/0cancel/1原可选竞态诊断skip，618461.8846ms；238入口及13嵌套脚本语法、Edge157预检通过。真实桌面/390px权限修订、角色降级、原生Review v2格式重试与跨代、安全启动诊断、源码恢复及逐字同ZIP均在本批实际通过。275文件前后/最终零漂移，23个记录进程最终均不存在，0收费。报告`output/i13/output/non-author-test/run-i13-20261118-1637-9c26/REPORT.md`，SHA256 `E82BFEBBA4F5E34151858FB7C62BFAEF57EA1A63128A33826F522967872D639A`。

输出封存器首次把作者范围中的两份docs也要求出现在275运行源码清单而报scope mismatch；文档按既定快照规则排除，所有生产/测试项匹配，修正仅输出封存器，原测试及首封存器错误保留，不重复或改写全集。

随后同源独立Review 44项相关检查通过，但真实异步撤权反例失败：完整body之后action等待真实store.save/driveIdle时被停用的owner仍200改计划，P2。正式报告`output/i13/output/ir-i13/RESULT.md` SHA256 `61C40B8019B4C644EF086959FCB1FF6F45F91B81708577B2082077FB4104B015`；原v3探针、TAP和facts保留，275零漂移。i13组合BLOCK，未建release，未追加收费或正式业务修订。

i14固定275文件`DD511AD1CFDBFC936CD77A8AF18F180B498693E8780C5D51BE1B0B2A2EC93B23`，只改2生产/1测试：可信assertAccess从server传入action，入口及await driveIdle后复核。作者原红1/正控1、修后9文件53/53及238语法；非作者15文件99/99、238+13语法及275零漂移，Test报告`output/i14/output/non-author-test/run-i14-20261118-targeted-a17b/REPORT.md` SHA `36256BB5062FDB703B398FA2D4312D46182A7E14F66FB65DCFA04DA7EE458094`。原例401且版本1→1与HTTP正负控共4/4，Review `output/i14/output/ir-i14/RESULT.md` SHA `2B46C5CDEB9A7E12784C05B9B6DF1D50B776914DD24E70A1BB56FB8FFD7964DE`；i14/i13各275及41旧原件零漂移。未跑i14全集，不沿用i13全仓为新结论；双门禁放行仅有限真实业务试跑。

库存旧定义因真实HTTP校验器政策换版而保持冻结/非current，GET即停止旧lastattempt脚本，0执行POST/0收费。隔离角色helper的实验虽95关联通过，但政策相等断言失败，未交付；主树已恢复逐275与i14一致。未改旧审批/预算，原host正常close0。正式同项目新run `f62faf4d-110c-4104-bef9-772232e2c4c5`：首规格引用错1字failed，正式补充原文证据后第二规格20REQ进入awaiting_spec，5问题待答/未批准/无工程编码。两原回执均stop、saved、responseComplete，总6418输入/11022输出；`output/quality-model-acceptance/inventory-v0/i14-fresh-run/CURRENT-CALLS-AUDIT.json`。当前累计90已结算/1399041输入/417895输出token，金额未知，无在途收费，规格语义Review中。历史88等累计仅对应各节检查点。

## 2026-11-18 i11完整、i12定向及随后真实失败

- i11固定267文件清单`A90F5F525ED5CD61CE36AF002F930DAF0533FD5710632E93BD76D0E63020E2DC`：非作者完整1330总/1329pass/0fail/0cancel/1可选旧竞态诊断skip，564845.1595ms；另外边界和跨代分别记录。报告`output/i11/output/worker-options-independent/run-i11-corrected-20261118-1254-3f80/REPORT.md`（SHA `5A0F1C72F690B80E090DB4B409F175BE1A348C29AA8DEFA257375D1D35DFDCFF`），Review `output/i11/output/ir-i11/RESULT.md`（`A555FAE8B0566905AC75F70FA7D5A3F123586BD8C553D7665487514B68472C60`）。原Path/PATH重复导致Git不可见的首次启动批标INVALID并保留，不能当源码失败或删除其日志。
- i12固定267文件`0BA7F603702D71FE96DECD387615BA3537E3C41BCC03EEE3E45D0F0B6F4E60F9`：非作者6文件88/88，另HTTP边界1/1、旧预算1/1和缺省native跨代3/3、11入口语法及267零漂移；Review边界6/6及policy/预算1/1。报告`output/i12/output/code-cap-independent/run-i12-20261118-1317-a2b4/REPORT.md`、Review `output/i12/output/ir-i12/RESULT.md`（`5ED1A9EBCE55511A3C1AA2FA69857E290F3D8D99E9636B7A6621A1F8B70E656B`）。未跑i12全集。
- i12真实工单第三attempt failed，6call/293195in/43196out，3候选HTTP79/79但Edge各11/97通过、Review格式/真实prompt阻塞。原3attempt耗尽、8call/reserved0、所有停止确认；`output/quality-model-acceptance/service-desk-v0-i12/REPORT.md`及只读FINAL-AUDIT保存精确绑定，不追认误报处置为候选通过。
- i12真实库存第二attempt failed，3coding/100725in/67708out；首响应多出可写范围外文件而拒绝，后两候选SYS_START失败，实际Node22 `.transaction()`不存在于src/db.mjs:48。未到独立HTTP/Edge/Review，余原attempt1。报告`output/quality-model-acceptance/inventory-v0/i12-continuation/REPORT.md`。
- i12真实notes图15call/270625in/20966out，实际NOTES/TAGS并行与合并已核；FINAL各自检43/HTTP43/Edge85通过但三Review原JSON失败，未交付。报告`output/i12/output/nt/benchmark-control/REPORT.md`，原延迟GET断言不改。所有费用都计入失败，0金额不能代替未知金额。

累计88真实已结算调用/1392623输入/406873输出token；上述免费回归和只读审计均不另计。i13候选尚未独立验收，不继承i11全仓或i12定向结论。以下为历史记录。

## 2026-11-18 i10定向修复与三次真实编码失败

- i10固定265文件清单 `9B08C758B81A84A6332CF7C44EB21EC1BF6395B18E2007655FA47EAEDFF55ABE`，相对i9仅验收定义驳回索引逻辑和回归测试变化。非作者146/146、8脚本语法及独立迁移/实际approve409/有效修订正控通过；原Reviewer使用原反例复验FIX/PASS，所有冻结文件零漂移。报告 `output/i10/output/rejection-independent/run-i10-20261118-1145-5e83/REPORT.md`、`output/i10/output/ir-i10/RESULT.md`。未运行i10完整全集；不覆盖原i9全仓和BLOCK。
- i10工单V0执行 `2fe4490b-2820-44a7-bcdc-f935667374c9`：1真实coding，23906输入/16384输出，finish length，原回执SHA256 `c3ac6b2d6432ff4e234cde472e70ff86924b35feffd8140da80c4bcb5f902958`、content0，versions0，terminationConfirmed=true。没有业务/Review/交付。原证据 `output/quality-model-acceptance/service-desk-v0-i10` 和独立Worker原记录保留。
- i10库存V0执行 `53c1f968-66d9-40e7-8575-cefc2eb1d946`：1真实coding，23685输入/16384输出、length/content0，无candidate；报告 `output/quality-model-acceptance/inventory-v0/i10-continuation/REPORT.md`。首轮默认Worker在边界检查后实际生成，但未进入业务验收；未作第二attempt。
- i10延迟GET任务图：BASE首coding1次，8217输入/16384输出、length/content0，后三任务pending，未到达双任务并行、集成或竞态验收。报告 `output/i10/output/nt/benchmark-control/REPORT.md`。原预算未增加，旧i7失败不追认，免费回归不代替该失败。

三次调用均已终止，累计61收费调用/694553输入/246784输出token、金额未知。本次发现Worker遗漏控制进程模型选项的配置交接缺口，修复与后续本地/真实验证必须另立固定源记录，当前不能记已修或完整目标完成。

## 2026-11-18 i3

244清单SHA `E3FA2B4B793F7993EA44E0995DC9954F27985A60CA7438BE1C3DCCE72EDC3CEB`，全量1283：1279pass/3fail/0cancel/1skip，424459ms。两个根失败，存储父子重计；报告见i3。Review 16/16、native7/7，但Edge0/2故BLOCK。i3f清单 `05CEAA69087B13CAE84BE8AF5A74960C3F2989B2DE54B8AA35CB00E176A8717B`，独立验证中。Windows重试7/7，不证明原原因；PM改动未验证。

## 2026-11-18 i2独立产品链与新历史许可

i2f最终补充：完整两文件42/42、0fail/cancel/skip、27777ms，原9取消项逐项实际执行；额外仅output对照2/2（真实慢writer150.7337ms仍unknown且拒late；派发前70ms超时实际0发送）。234前后及final零漂移，报告`output/i2f/output/regression-fixes-independent/run-20261118-081459-87843b/REPORT.md`。生产verification service字节不变。下方“独立定向中”为历史记录，本补充覆盖它；原i2全仓BLOCK不改。

固定源码234文件，`output/full-goal-20261118/integrated-frozen-i2.json` SHA256 `0EFC4212A1A8F23EDEB90C670A22F6144A1EAADBFFFB3FAE6C29A69328C7E8CF`，只导入`output/i2`。主树后续W5修改不能继承本节作为新策略结果。

- 独立产品Test：`output/evolution-product-independent/FINAL-REPORT.md`，run-hDLDPQ 443.239秒，6候选自检189/独立HTTP189/Edge302/Review6；默认编码6+Review6及公开spec/engineering/definition各6，30次localhost免费请求，0收费。三类需求变化、随机私有旧行、权限403/非法流程409、新写后拒绝回滚、独立无写入成对回滚均通过。49次同版下载、6次API历史恢复、11次业务STOP；post-audit7/7实际核20独立迁移原件、6预算attempt1/used2/reserved0、原Worker退出及234源码零漂移。3次前置夹具/驱动失败累计15免费请求原样保留，不计通过或收费；不作真实模型质量结论。
- 独立Review完成Worker原三项3/3（21.618秒）、并发prepare同键反例及F05新历史合同1/1（46.387秒）。原list脚本旧live=true字面断言仍失败并保留；新历史合同明确live task/seed=false，只授purpose3历史交付，默认源码授权含真实evolutionSource/recipe，实际迁移激活读旧行、关闭/重开同ZIP且模型新增0。正式`output/i2/output/ir-v2/F05-RESULT.md` SHA256 `7D94447C70F80CDC735C49E7C18D23D264A92F61499ED4E962872065255BE185`，`WORKER-RESULT.md` SHA256 `81BBEC63F3C5405CC0F54CC34108CFC219D300970D7C0D8047215F006BB04E3E`；234文件前后零漂移，原i1报告与两原探针字节保留，无新阻塞。
- 作者修复：18文件126/126，152960ms，0跳过/收费/源码漂移，`output/planned-worker-author/security-after-v2/HANDOFF.md`；历史专项5/5及6文件兼容59/59分别记录于`output/planned-evolution-history-author/REPORT.md`，不与Test/Review或旧1170/0/1相加。
- i2全仓独立218入口+3嵌套语法通过；1241项1230pass/1fail/9cancel/1skip，379730ms，234零漂移，报告`output/i2/output/integrated-independent/run-i2-20261118-075244-1dfa1c/REPORT.md`。旧服务cap路由实际失败；70ms用例实际报未决Promise取消，其后8项未执行；源码推断是writer入场前合法超时留下无界握手，原run没有时序跟踪，不能把推断写成实测。新i2f只覆盖2文件差异，清单`0DF5BC2162250B36DA32F869260D0C602CF9BBFAEEBA71A190E885A42921424B`，独立定向中；不改原i2、不拼全量PASS。
- 后续W5作者12/12真实native（111493ms，0费用/漂移），含连续三代6调用，原用量一次结算；当前仍缺cost-only取消及独立验收。任务库新历史核对55/55（3882ms）；UI恢复14/14（9634ms）和截图桌面/390已查，演进UI25/25（8165ms），后者改为启动捕获/结束校验实际字节，移除仅用于操作人的环境前置，全部业务断言保持。旧服务guard作者1/1（8141ms），受控70/15ms fixture整文件38/38（8774ms）；生产deadline未改。原暂停机制外层1/1含2子例后又新增拒绝JSON许可用例尚待新跑；不把这些合成i2或完整恢复通过。首轮fixture cleanup错误保存。

## 2026-11-18 新组合的实际证据（不同清单分开统计）

- 原工作树 212：200 脚本语法通过；全量 1170 pass、0 fail、1 skip，502503ms。唯一可选 v3 延迟加载诊断随后单独 1/1 通过识别真实软件失败。原候选、原 TAP 和源字节不变，不能写成同一次全量零跳过。`output/combined-foundations-independent/run-20261118-052048-1a74ded8/FINAL-REPORT.md`。
- 预览/重连修复副本 212（`63630851…`）：产品 12 首轮 11 pass/1 夹具 fail，保持原业务断言后单补 native 1/1；真实 HTTP9/Edge15、权限、共同槽、重启、停止、下载/零新预算验证。另非作者 preview 两个 late runtime 窗口 2/2，Worker 第129次及过期重连/旧连接 fenced 原反例修正夹具生命周期后 exit0，同 Worker4个免费 native 请求。`preview-worker-source-v2/output/preview-product-independent/V2-RESULT.md` 和同副本 `output/foundations-fix-independent/RESULT.md`，均位于完整目标 output 下。
- F05 v3 副本 216（`5E7F230F…`）：203入口及嵌套helper语法通过；18关联文件 200 tests=199 pass/1旧browser mock链接fail/0skip，149480ms。新core6/6、独立旧数据dataset2/2及8+4个真实迁移产物、原库不变核对通过；Review自写6/6与原seed8/8单列，不混作完整业务通过。原失败未删除。
- F05 v4 副本216（`CBDBDCAD…`）：仅HTTP/browser惰性加载和task子sourceRevision透传3源改动，旧测试字节不变；必要6文件58/58、0skip/fail/cancel，73715ms。额外三任务6调用的持久requestIdentity/真实sourceRevision独立探针和4个取消故障探针分别通过。另一个非作者Review PASS，自写4个伪cap例4/4（应用启动0）；前后216零漂移。证据 `output/e4/output/evolution-independent-v4/run-20261118-061508-084dad/REPORT.md`、`output/e4/output/ir/RESULT.md`。这只授予core+verification机制，不授予新service/UI/本机激活回滚产品完成。
- owned local release 作者：主测试9/9，故障wrapper内实际child4/4（有包含关系，不相加），34966.8ms；11文件零漂移。真实MXC写入/STOP、source/data不同目录、有界迁移新pair、整对回滚、拒绝有新写入后的旧快照回滚、role/来源/ABA/ALS与late runtime均覆盖。`output/planned-local-releases-author/verification-9Antdw/REPORT.md`；新220副本正在独立审查，尚不称产品验收。
- W4 作者新纵向及故障组6/6、23979ms：API1真实退出后API2同Worker继续，原4个免费native调用和同ZIP，known失败/401/cancel单结算、reset/Worker死亡unknown保持预留。前期四轮失误及原预算现场均保留；后续14文件兼容组进行中，未获非作者产品放行。
- root新演进控制器首个实际快照/审批/重启机制1/1、3997ms；新HTTP边界2/2、537ms，旧HTTP兼容6/6。来源/规划/执行权限适配器在这些测试中为明确fixture，不是完整业务生成证明。新网页首次独立真实Edge16项首轮9 pass/7 fail，其中6为真实交互问题、1为待修夹具前置，保留失败并继续修复。

所有本节新增检查使用本机固定模型回复或明确mock、临时数据与独立受控应用，真实收费调用新增0。持续开发已授权收费累计仍39次、486257输入/67766输出token，金额缺单价未知。原v3业务竞态仍阻塞，尚未产生修复后新的收费业务候选；后续各阶段必须重新保存自己的代码/清单与证据。

## 2026-11-18 当前真实 DAG 失败与格式修复

v5 来源 P2 修复后原 4 独立反例及预写 11 例复验通过，191 前后零漂移。随后真实图 v2（`notes-tags-qSaZDq`）15 个收费调用、233913 输入 / 28271 输出；NOTES/TAGS 真时间重叠、不同 clone 同基础、双亲 Git merge 已核；FINAL 两候选各 43 HTTP / 81 Edge 全过，但代码实际存在首次 GET 旧快照覆盖 POST append 的竞态，原阻塞持续 open，第 3 次越权文件提案未应用。因此结果是失败、0 封签/0 ZIP，24 预留结算 used15/reserved0。非作者只读事实 17/17，原 610 文件及 v1 原 111 文件不变：`output/full-goal-20261118/native-tasks-v2-independent/RESULT.md`。源码前核 v5 零漂移与之后新轮返工代码变化分开；该报告不批准新轮代码，亦未重新运行竞态动态复现。

最新完整与受影响组合证据分开记录：190 文件原组合非作者 1096/1096（0 fail/skip/cancel；259869.8178ms），报告 `output/full-goal-20261118/task-product-independent/REPORT.md`；后续图遗漏修复的 v3 受影响 40/40 与独立原 7/7 断言，不冒充重新全量。首次误设 LLM 值 `0` 的 998/1096 原失败保留，最终正确三空值环境不依赖 `.env` 付费。

首次真实四任务基准 `output/task-checks/notes-tags-ZI8idN` 正确失败：一次 BASE 编码回执 JSON 非法，实际 7544/3456 token，无候选、后续任务、Review 或交付。非作者只读 14/14 事实审计见 `output/full-goal-20261118/native-tasks-v1-independent/RESULT.md`，111 原始文件不变；该审计不声称业务通过。

v4 冻结 191 文件 `38C052EC05670E221EB81CD8993B7328B7C1626C2ADE465988D30D503DFF5BDE`：非作者预写 11/11 机制矩阵，作者/集成 15 文件 95/95 外层、179 脚本语法，通过且零漂移。独立 Review 原反例 4 项中 2 失败，阻塞未关闭；两项来源记账问题及证据详见 [修复记录](tasks/planned-proposal-repair.md)。不因既有通过而跳过该阻塞，也尚无新的收费业务重试。

## 2026-11-18 同版本历史交付恢复最终证据

固定清单`output/full-goal-20261117/checkpoint-frozen-source-final.json` SHA256 `B342F94185DF80ACAD8431D3437BCC676DD54B855461EBED3C06F30C2A99F8D6`，172文件前后零漂移，160脚本语法检查通过。非作者74测试文件、并发4、原生MXC/Edge，992/992通过、0失败/取消/跳过，204377.056ms；报告`output/full-goal-20261118/checkpoint-integrated-independent/REPORT.md` SHA256 `0CE03E8E951A074EA834FD4DD1A77893B5539731F4ACDC1E734F0C7F8DA454E8`，TAP SHA256 `C7BC9AA39E169AEF094E708C219E77D8ADA179D6E0FD1EA287E48A327E808279`。普通回归无付费调用，初始LLM开关关闭。

必要真实基准`node scripts/check-planned-recovery.mjs --model`，独立临时项目`output/recovery-checks/notes-8lLoiy`：当前候选`2f57ac40ca3fed3b4ad547986251e41532e41298`，自检/独立HTTP均14/14、桌面/390px Edge共27/27及真实模型Review通过，实际1编码+1Review、15111输入/4914输出。原子封存后两次关闭重开，同账号会话验证并恢复下载，两包均102245字节、字节一致，不新增调用，账本1尝试/2已用/0预留。私有位置原生拒读写记录保留。PM、工程和测试定义使用明确公开固定夹具，未测试真实规划质量。

非作者对该原始正例只读35/35核对通过：`output/full-goal-20261118/checkpoint-native-independent/RESULT.md`。原始118文件前后未改，只在副本打开三SQLite，核对HMAC、审批/当前策略、Git对象/完整源码/外壳、2私有模型回执、检查及停止、恢复包及私钥不入包；JSON不获原始任务资格，恢复许可关闭失效。该审计新增模型调用0，未重跑原生私钥拒读写，未给旧记录补签。

连同此前3次原生试跑，本轮必要真实模型累计12调用、87239输入/21009输出；没有单价配置，金额未知，不能写0。该证据只支持当前便笺和同版本已结束交付恢复，不支持复杂业务全覆盖、在途Worker续跑、逐任务并行或完整目标完成。后续F06改动须重新固定并验证，不能沿用本清单的通过。

## 2026-11-18 规划驱动执行及本地团队组合检查点

冻结清单`output/full-goal-20261117/integrated-native-source-v3.json` SHA256 **44EF7D55401071752901D7063F2A4BED86775841E23B56359A798421B3E11399**，167源码/配置/测试文件。Node.js22.21.0；语法156脚本通过。独立运行72个测试文件、并发4，启用真实MXC/Edge，测试子进程启动时移除全部LLM_*；**990/990通过，0失败/取消/跳过，184800.3862ms**，前后零漂移。报告`output/full-goal-20261117/integrated-independent/v3/REPORT.md`；无付费模型调用。

v1为990项988过2失败（模拟夹具重复独占目录、澄清夹具把pending禁用误当保存完成）；v2为989过1失败（超时夹具100ms在准备期耗尽而未覆盖已启动请求）。仅修3处测试夹具：第二控制器独立root；保存后同时等后续动作可用；超时预算留1000ms准备并加强启动/请求/停止断言。业务门禁未放宽，所有旧TAP与最小改动反向hash核对均保留。不能把多次结果累加成测试数量。

原生业务基准独立事实：首次便笺6模型调用后失败；精确验收输入修复后保留代码2调用通过`a65e357...`，13HTTP+27Edge+Review并关闭原blocking。该次8份来源/当前回执、Git、4验证快照、完整ID/停止和ZIP已由非作者核对，见`source-independent/NATIVE-AND-REPAIR-REVIEW.md`。实际解压发现自动favicon404后再限1编码+1Review修复为`c23ada4de3643335c0166b7ea9f7f300f5ae8e6e`，同定义13HTTP+27Edge+Review通过；干净包离线npm ci、两次npm start、实际桌面/390业务、独立SQLite、重启持久化及两个STOP确认11项通过（作者执行，非新的模型Review），证据`package-clean-start/result.json`。3次运行合计10真实模型调用、72128输入/16095输出token；未配置价格，金额未知，不能填零。

定义/HTTP/浏览器结构覆盖只说明所列场景通过，便笺不代表复杂业务平台全部达成。源码包免费独立复核是`checks_passed/taskAccepted:false`，不继承旧Review。原失败、用量、非阻塞建议及ZIP均保留。

本地团队模式：模块独立13项、HTTP独立12项、真实Edge网页8项及上述全量通过。已修迟到密码回调绕锁、慢body撤权、登录失效焦点3个P2；角色/会话/审计及桌面/390实测证据分别在`team-independent`、`team-http-independent`、`team-browser-independent`。默认不开启，不改用户现有账号/数据/服务。

此后开始的检查点恢复模块尚未纳入该冻结清单；990通过不能作为新代码的通过证据。F05增量代码/数据、F06实际并行、F08在途Worker、F11回滚及复杂留出评估仍未完成。

验证日期：2026 年 11 月 10 日。环境：Windows，Node.js v22.21.0，浏览器 Chromium。

## 自动化检查

- `npm run check` 通过：服务入口、规划器和前端脚本语法检查。
- `npm test` 通过：24 项测试，无失败或跳过；包含 DeepSeek 请求参数、非法配置和输出截断回归检查。
- 规划器测试覆盖不同软件需求、原文可追溯、需求到任务映射、待确认范围分类、角色和验收场景保留、依赖图错误、Markdown 文本转义，以及模拟模型响应的校验和错误处理。
- 编排器测试覆盖独立分支、下游阻塞、手动重试、成功阶段保留、暂停恢复、服务中断处理，以及人工审阅门禁。
- 接口测试覆盖真实 HTTP 上传和文档生成、单文件与 ZIP 下载、DOCX 正文提取、超限与非法输入，以及工作区路径边界。

## 浏览器操作验证

在桌面 1440 × 1000 和手机 390 × 844 视口检查了界面。手机页面没有文档整体横向溢出；宽依赖图在自身画布内滚动。

通过界面完成以下操作：

1. 载入工单软件需求示例，创建项目并启动本地规则规划。
2. 在工作流中看到真实阶段结果，生成 10 条编号需求及 14 个候选开发任务，停在等待审阅状态。
3. 查看 task.md，填写审阅意见，确认导出，运行达到成功状态。
4. 在同一项目新建一次运行，注入任务拆解阶段首次失败。架构阶段成功，下游检查与导出阻塞。
5. 点击重试，任务拆解第二次成功；架构阶段仍为第一次成功，继续进入人工审阅并完成导出。
6. 浏览器成功下载 task.md 和工单文档 ZIP 包。
7. 检查浏览器控制台，未记录错误或警告。

本地截图位于被 Git 忽略的 `output/playwright/`，交互日志与下载样本位于 `.playwright-cli/`。测试演示项目保存在被 Git 忽略的 `data/`，可在工作台继续查看。

## 尚未验证的范围

- DeepSeek 的长文档质量、复杂需求拆分效果及持续编码工具调用尚未验证；本次真实调用验证范围见下。
- 未进行多用户、生产部署、长期运行、性能或大规模文档测试。
- 本地模式使用可解释的章节与任务模板，需要人工确认语义、任务粒度及业务依赖。
- 生成 task.md 不代表已自动实现其中的软件开发任务。

## DeepSeek 接入增量验证

2026 年 11 月 10 日，使用用户在本地 `.env` 配置的密钥，执行 `npm run model:check`，向 `https://api.deepseek.com/chat/completions` 发起真实请求，模型名为 `deepseek-flash`。JSON 模式、非思考模式和输出长度配置均由服务端传入。

本次输入是一条包含新增及刷新后保留行为的待办需求。服务返回 2 条可追溯需求，通过本项目的 JSON 结构、验收字段和原文引用校验。终端仅打印模型名和成功概要，未输出密钥。

这项结果证明当前账号和模型能够用于规格整理；不证明所有长文档都能正确分析，也不代表代码生成、测试修复或需求变更闭环已经实现。

## 工作目录迁移与共享规范

2026 年 11 月 10 日，将完整源码与 Git 历史迁入用户指定的新工作目录，原目录保留作为恢复副本。停止旧服务后同步最新本地配置和数据，两份项目 JSON 的文件摘要与原目录逐项一致。

从新工作副本执行 `npm run check`、`npm test` 及 `node --check scripts/check-model.mjs`，全部通过，自动化测试为 24 项。服务从新工作副本启动，首页返回 HTTP 200，模型配置识别为 `deepseek-flash`；两份项目记录可查询，其中一份仍为等待审阅状态。没有将旧目录的预览作为迁移成功证据。

增加根目录 AGENTS.md 统一开发流程、agent.md 兼容入口和 STATUS 交接记录。检查 `.env`、环境变体和本地数据忽略规则；源码与规范公开共享，真实密钥及运行数据保留本地。本轮未重复真实模型请求，也未新增或声称完成目标软件的编码执行能力。

## 设计文档替换

2026 年 11 月 10 日，按用户要求将今天的设计文档替换为《软件项目 Agent 协作流程 开发编排新版.docx》。源文件与仓库副本 SHA-256 一致，Word 内容未修改；正文 22 个非空段落同步到 DESIGN.md，并对两页只读渲染结果完成检查。

原 DESIGN.md 的当前实现说明保存在 PROTOTYPE_DESIGN.md；旧 Word 从当前文件列表移除，可从 Git 历史恢复。README、Agent 规范和目标文档引用同步更新。本轮仅做文档替换及引用检查，未修改运行代码、未重新运行程序测试或模型请求；历史测试结果不代表新版开发编排已经实现。

## 首个受控编码任务执行入口

2026年11月14日，基于`main@b133109`新增独立编码试验，没有改变浏览器规划工作流。

主Agent实际执行：

- `npm run check`：24个脚本语法检查通过；检查范围由3个固定文件扩展到当前源码、脚本和测试。
- 配置本机MXC程序并显式设置`TASKFLOW_TEST_REAL_SANDBOX=1`后`npm test`：48项通过、0失败、0跳过。普通测试不会调用付费模型；未显式启用时真实MXC集成测试跳过。
- `npm run execution:check -- --fixture`：可信固定候选实际编辑和提交代码，10项当时的业务检查通过；不涉及模型生成。
- 首次`--model`：实际2次请求、2个候选提交；因“非空字符串数组”表述被理解为数组不可为空，第二候选7/10通过，达到预算后明确失败。失败记录保留。
- 明确空数组合法及字符串空白规则，新增3个对应边界检查后再次`--model`：实际1次请求，候选13/13通过。需求标识随任务内容变化，旧失败没有被改写。成功记录位于本地`output/executions/execution-tIgm8d/execution.json`；候选提交`b9321697bdd770207a3774f8069f54ef6a796e6b`，基础提交`cdd2f1b7dce8e10d3c1ee880d16bd6892740a1b7`，均属于独立试验仓库。

实际受限执行使用已安装现代原生Codex CLI的Windows MXC能力，不调用Codex模型。预检证明工作区内读写成功，工作区外自建非敏感文件的读写与外网连接被拒绝。真实集成检查覆盖中文stdin、ESM导入、候选源文件只读、超时/主动停止后心跳停止。模型凭证未进入候选进程环境，验证断言留在控制进程；候选只返回观察结果。

本轮真实模型共3次请求，未重复原有`model:check`；token记录来自服务响应，未知用量保留null，不推断费用。没有浏览器交互改动，因此未重复浏览器检查。没有验证完整目标软件、数据库、双Agent验收、多Worker恢复或全栈交付。

源码提交与同版本独立检查结论见`docs/tasks/execution-foundation.md`。本地`.env`补充执行器路径；不新增运行依赖，不迁移用户data，不推送或部署。

### 独立检查后的返工

候选`fb46a92`通过独立测试的48项检查，但Review真实复现了“候选替换JSON.stringify并原地修改输入，仍13/13通过”的P1问题。因此未放行该候选。

修复将同步纯函数候选置于独立JavaScript上下文，不授予Node进程、文件、网络、控制台或导入能力；宿主可信观察器通过属性描述符复制普通数据，不执行候选getter、toJSON或thenable。MXC仍是系统边界，JavaScript上下文不作为系统隔离替代。清单v2绑定用例与观察器哈希，记录平台源码标识和Node版本；预检停止未确认也保留待协调状态。

主Agent修复自检：25个脚本语法通过，51项自动化检查通过（显式启用真实MXC）。使用真实MXC重新执行先前实际模型产出的代码，13/13通过，记录`output/executions/execution-vfZiuu/execution.json`；独立Review所用的原地修改攻击现判失败、10/13，记录`output/executions/execution-63ZXYA/execution.json`。此次回放没有新增付费模型调用。

另有临时真实进程探针证明：detached且stdio ignore的后代进程在取消CLI、runner主动exit0两种场景都停止心跳，600ms后PID不存在。本机该受管执行方式未发现停止确认误报；不外推为其他Worker的可靠恢复。

独立测试在`23ca669`复验25个脚本、51/51测试和真实候选13/13通过；两项原失败判定回归也在真实MXC复核。随后补充逐次调用用量记录及未收到后续回执时的总量未知规则，主Agent最终运行显式真实MXC的`npm test`为52/52通过、0跳过。该补充不改变候选执行与验收逻辑，也不产生模型请求。

候选`49acfc9`同版本独立测试25个脚本、52/52通过，独立静态Review确认原P1关闭且无新增阻塞问题。末轮同时落实两项非阻塞建议：取消后停止尚未确认的文字保持待协调，模型文件建议无效时也保留已收到的用量。主Agent在真实MXC测试开启时复验53/53通过、0失败/跳过。

最终代码提交`eb2ee9fb004ac83202609e2c138042d63fac49fa`：独立测试再次运行`npm run check`及显式真实MXC的`npm test`，25个脚本、53/53测试通过、0跳过，`git diff --check`通过；同版本静态Review通过，无阻塞项。两方检查期间及结束时工作区干净。随后仅提交验证记录，无源码变化；未再次调用付费模型。

## 同候选版本独立测试与Review门禁

2026年11月14日，基于`05cd2a0`继续固定纯函数任务的正式验收门禁，未改变浏览器规划HTTP/界面。

主Agent执行`npm run check`：31个脚本通过；显式启用真实MXC后`npm test`：85/85通过、0失败/跳过。新回归覆盖独立测试重新执行、双副本与同候选绑定、缺失/错误Review、两分支全部收尾、候选/快照失效、取消及停止未确认、历史问题必须明确复验、新提交重跑两方、当前规则/角色校验、共享预算与未知用量。普通测试不请求付费服务；三个MXC测试为显式集成测试。

`npm run execution:check -- --fixture`真实执行固定候选，自检与独立测试通过，模拟Review诊断通过但taskAccepted:false。真实MXC回归另验证两候选返工、旧问题显式复验及测试/Review重新检查，仍标诊断。

`npm run execution:check -- --model`真实联调完成：1次编码、1次独立Review请求，候选提交`d905ed0776887f745eca85ce8c942dcd6bb1c282`，自检13/13、独立测试13/13，Review无阻塞意见，accepted/passed、taskAccepted:true。执行记录为本地`output/executions/execution-Fs5URC/execution.json`；两方独立结论为`acceptance/validation-g9YhCH/acceptance.json`，使用同一candidate binding和不同快照目录。此轮共2次真实模型请求，未重新调用model:check。

passed只表示固定`library-borrow-v1`在当前清单和Review规则下通过。测试侧是固定验证服务，不是自主生成测试的Agent；没有验证任意仓库、完整全栈、集成提交交付或多Worker恢复。浏览器无修改，未重复浏览器操作；无新增依赖、无数据迁移、未推送/部署。独立源码审查和提交后的复验另见本轮任务记录。

候选`dc2c463`由独立测试角色复验：31个脚本、真实MXC开启的85/85测试通过、无跳过；fixture实际独立测试13/13，两方同绑定，diagnostic_passed但taskAccepted:false、模型请求0。独立静态Review无阻塞项；其最后版本commit一致性建议随后补充判定及回归断言，不改变真实联调的通过条件或增加模型调用。

最终代码提交`37128acbc131f18805070e8bd22d0de71d6f9379`：独立测试再次执行`npm run check`及显式真实MXC的`npm test`，31个脚本通过、85/85通过、0失败/取消/跳过；同版本静态Review通过。检查前后HEAD一致、Git干净。后续提交仅保存本记录，源码不变；未新增付费请求。

## 网页规格与计划版本确认

2026年11月14日，基于223ac98连续推进，新增workflowVersion=2双确认、结构化问题回答、驳回/修订、不可变来源快照、审批与修订历史，旧记录按原义兼容。主Agent语法检查34个脚本通过，显式真实MXC下98/98测试通过、无跳过；新增HTTP测试验证旧revision/旧approve不能绕过、规格确认后才规划及ZIP冻结原文。

真实浏览器使用独立output数据：桌面＋390×844窄屏完整操作规格驳回、保存新规格及答复、单独确认、计划驳回、非法依赖错误后输入保留、修订新计划并单独确认。重载保留项目/运行和草稿；阶段与运行选框状态同步；窄屏无横向溢出；控制台error/warn为空。实际下载ZIP包含requirements/spec/architecture/task/review/handoff/plan七文件，核对需求正文后移动至`output/approval-browser-jZXEhK/browser-export.zip`。验收服务已停止，没有使用或破坏用户data。

浏览器先真实触发了标题包含“验收”时错误归类全部功能为验收场景的既有问题；修复普通标题不参与章节分类后，原失败记录保留，并从失败阶段重试成功。该缺陷有独立规划器回归，未通过改变输入逃避原失败。

本里程碑未调用付费模型，未宣称网页已执行目标软件；同版本独立测试和审查结论见持续任务记录。整体PRD仍在实施。

独立检查136981c虽然98/98通过，另58项真实HTTP检查也通过，但新复现证明执行中提前确认409会替换stage引用并导致后续失败，Review另发现删掉未答问题可绕过门禁和计划页缺少规格回修入口，因此该版未放行。修复仅在静止阶段保存回滚快照、禁止删改未答问题、增加规格回修表单路径。补在途HTTP和问题删除回归后，主Agent34个脚本语法及显式真实MXC的100/100测试通过。

修复后的浏览器第二运行：计划审阅返回规格修订时只有保存动作，两类草稿往返保留；保存后规格确认清空且旧计划失效；重新确认规格并生成新计划后，本地旧计划草稿禁止确认，载入新版本后才可确认导出。原已完成运行和历史保持可查看，控制台error/warn为空，没有新增模型调用。新提交独立复验结果见持续任务记录。
## 2026年11月14日：规格和计划双确认验收

固定代码版本：`456cb1a944bf5833a18e7098339f3748588d2c17`，`codex/platform-completion`，Node v22.21.0。检查期间未改候选，起止工作区干净。

- 主Agent与独立测试Agent分别运行`npm run check`，34个脚本通过；设置`TASKFLOW_TEST_REAL_SANDBOX=1`及本地有效MXC路径后分别运行`npm test`，100/100通过，无跳过。
- 独立HTTP回归确认提前`approve_spec`返回409且保留阶段引用，随后正常到`awaiting_spec`；删除/替换未答问题、伪造clarifications、提交答案并同时删除均400，版本和历史不变；先保存原问题答案后修订可行且旧版完整保留。
- 只读Review对同版本复核三项原阻塞问题，无新增阻塞。初始`136981c`虽98项通过，仍被独立检查驳回，保留于任务记录。
- 真实桌面/390×844浏览器：规格与计划各自驳回/修订/确认、非法依赖错误、草稿重载与两表单切换、从计划回修规格使旧确认失效、旧计划草稿版本拦截、实际下载7文件文档包。控制台无错误/警告，窄屏无横向溢出。
- 本轮未运行真实模型，未访问用户data；仅临时验收数据和下载在忽略的output下，所有临时服务已停止。当前文档ZIP仍是规划包，不是目标软件源码交付。

## 2026年11月14日：固定全栈参考项目与实际源码交付

具体所有尝试及修复理由见[tasks/platform-completion.md](tasks/platform-completion.md)。平台先后出现无有效JSON、输出8192截断、正常匿名401误报及Review行号无效；全部保留原失败记录，没有把旧失败改成通过。第三次真实编码生成的原提交为`5dc88cd31f0aa7649458a58ab386e23d3ff1e6a2`，四个源码文件由模型提出，经受控工作区应用及固定Git提交。

平台`9a07615`重新检查该原提交，新记录`output/web-executions/web-recheck-HSll13/execution.json`：自检18/18、独立HTTP/SQLite18/18、实际Edge浏览器21/21，独立模型Review完成、blocking0/advisory3，统一门禁accepted/taskAccepted:true。该次编码0/Review1，17628输入/510输出；原模型来源与旧用量只保存在provenance，不重复计量。所有实际应用及浏览器进程均正常停止。复验组件固定`254be25`曾由另一Agent独立运行15/15真实MXC专项及只读来源核对，未调用付费模型。

平台`9594fba`自检：`npm run check`61脚本；显式启用真实MXC的`npm test`267/267通过，fail/cancel/skip均0，60671.6563ms。前一固定集成`d1169c1`267项有1项测试失败，已按实际阶段修复可信超时测试，不改生产验收器或业务断言。原日志及复测日志分别为`output/verification/web-live-integrated-test.log`和`web-live-integrated-retest.log`。

实际源码包包含20文件及当前保护外壳，spec使用原webProfile.task对象，plan使用`{profileId,web,browser}`原始对象，与两个绑定hash一致。记录不包含真实密钥、用户数据库、私有绝对路径日志或原模型回执。首包`s3nCQJ`的源码已重新通过HTTP18/18与浏览器21/21，干净解压后安装和npm start退出0，真实浏览器登录→借阅→归还成功；停止得到STOP_CONFIRMED，端口61913无监听。该包计划元数据后来收敛为原始计划对象，最终包`output/live-web-delivery-3lVPQC/library-web-source.zip`，SHA256为`435f9d4fa02cb5edf31f68166a5cd064e4db7fdf3d3daf4c08c090124bedf682`；源码hash仍为`00765b4558a856cd9d6cee773c2abaf41e4c24c37aac4f5ca0ebd89221d79211`。

最终包实际`npm run web:verify -- --archive <路径>`再次HTTP18/18、Edge21/21通过，报告`output/delivery-verification/delivery-revalidation-e5rxxp/revalidation.json`。解压到新的clean-start目录，npm ci不运行安装脚本；npm start使用交付保护入口，7项实际检查通过：全部交付文件bytes/hash、规格/计划hash、HTML入口、alice登录、借阅库存减为0、归还恢复1、登出使会话401。记录`output/live-web-delivery-3lVPQC/clean-start-smoke.json`。输入STOP后STOP_CONFIRMED且启动进程退出0，端口49721不再监听；测试数据库仅留该忽略目录。未将目标模块导入宿主，未请求外网或新增模型调用。

归档复验命令不调用模型，`checks_passed/taskAccepted:false/historicalAcceptanceVerified:false`仅表示新检查，不相信ZIP中的历史通过声明，也不产生新Review。当前仍是固定图书借阅参考范围，不宣称通用执行、需求变更、多Agent集成或全部PRD完成。

固定主集成`a3e7de653d6d75adf0bba3345c28bfe9a06ca80e`独立复验完成：另一Agent运行61脚本语法检查、显式真实MXC的267/267测试，0失败/取消/跳过，60931.9237ms；只读Review检查新模块和计时回归，无新增阻塞。独立核对新accepted记录、私有Review正文及哈希、原Git准入和ZIP源码绑定，并再次在新副本实际执行HTTP18/18、Edge21/21，全部停止确认。检查前后HEAD一致、工作区干净；未付费调用或修改用户数据。完整本地记录`output/verification/independent-integration-a3e7de6-20261114/RESULT.md`。

## 2026年11月14日：网页固定参考执行接入及首轮真实试用

固定代码`23650670e2bb4775273abe54069b22683d0df515`：主Agent与另一独立Agent各自检查77脚本、显式真实MXC的401/401测试，fail/cancel/skip均0，耗时分别78030.9891ms和78177.3477ms。独立记录`output/verification/independent-execution-integration-2365067-20261114/RESULT.md`。原`f9f9561`独立400/401的归档停止待核对失败仍保留；测试文件并发上限4及失败完整报告保留已验证，不声称已确定或修复24并发下未知停止的根因。网页在途选择竞态等初始阻塞及修复见[tasks/web-execution-integration.md](tasks/web-execution-integration.md)。

真实网页首轮采用隔离数据`output/reference-web-ui-FYeJdW/data`，完成规格答复/修订/确认及计划确认，并在核对固定参考范围与预算后启动执行。服务执行`7fdca9cc-edad-4539-b706-efae65f5210c`，编码1次、Review1次，共17510输入/8566输出。模型生成4文件，固定候选`bcec69b2d700457398a997a9370cf98543b3e1b8`、源码hash`3c3cfa5f34432544b1771033dfe4d957762fc58109caeea9a6ebc1bcbdb01804`。自检18/18、独立HTTP/SQLite18/18及真实Edge21/21通过，但Review的JSON意见缺少必需evidence字段，严格校验拒绝；failed/taskAccepted:false，网页未开放预览/下载。该缺失不是格式通过或已解决的阻塞问题。原报告、Review回执及源码保留；随后只读核对原Git HEAD一致、status为空，没有修改原候选。

试用平台服务在localhost临时端口运行，结束收到QA_STOP_CONFIRMED、进程退出0；未重启用户已有4317服务，未写用户data。下一步在产品内提供保持原提交的新检查尝试，不将现有失败改为通过，也不重复计入旧编码用量。历史`5dc88cd`的通过只属于当时版本；凭据保护规则升级后的当前门禁不能直接沿用旧结论。

## 2026年11月14日：模型工程规划、网页固定复验与审批持久化

固定主代码4df6c8d0800390a638f10c7a3d858a2567b5e0b8：root与不同Agent分别87脚本、显式真实MXC/Edge516/516，fail/cancel/skip均0，耗时98639.8798ms和99050.8879ms；独立额外存储/项目动作6项通过。证据output/verification/independent-owned-recheck-integration-4df6c8d-20261114。a18的513/514、legacy测试准备竞态和跨run待决审批被另一save写盘的P2均保留；修复未放宽业务断言，也未把文件队列说成事务数据库。

4df网页实际对bcec原候选复验：新服务记录e312a9e4-86bc-4428-bd3e-95e1db6927f2，底层report为output/reference-web-ui-FYeJdW/data/executions/executions/e312a9e4-86bc-4428-bd3e-95e1db6927f2/web-recheck-dLlqy9/execution.json。编码0、Review2，共29897输入/924输出；第一Review格式无效，第二正常完成且有效。自检18/18、独立HTTP/SQLite18/18、Edge21/21，均停止确认；Review 1blocking、1advisory，统一failed，网页不提供继续复验、预览或下载。blocking ID ISSUE-2687a2edbe14c1090c3f，定位src/app.mjs279借阅检查/插入缺事务；advisory定位311归还条件更新。报告原文是审查意见，不把其并发推断当已实测的失败。下一轮按该意见修复新代码再验证。

原7fd源报告SHA256仍565f25d74b888d107a7656a4c7d5f9609f7fa27a0aa5e5fa7353cfc7f9be7aac，原源码hash仍3c3cfa5f34432544b1771033dfe4d957762fc58109caeea9a6ebc1bcbdb01804；没有覆盖旧失败或重复计量。临时平台79852的非PTY stdin已关闭，不能发送STOP；在只读核对活动0、无预览、PID/命令和端口归属后停止该已知QA进程，52086不再监听，applicationShutdownAcknowledged:false。停止证据second-trial-platform-stop.json保留，不宣称取得正常应答；此限制只涉及临时平台关闭，测试应用/浏览器在此前已正常收尾。用户4317服务未动。

实际工程规划另在独立FIX代码20363ee验证：原source/spec revision及规格字节不变，工程尝试1的invalid_input在历史保留；只重试工程阶段，新增规格0、实际工程1、3447输入/2406输出，生成17需求映射下2实体/4接口/2页面/6任务，确认并导出规划包。engineeringCalls=2是本地尝试总数，不能说两次收费；首次规格调用用量未记录。包SHA256 6adc95ead5e485650625fc898d65b6200e36f02fca9302d6abde54143707e22f、78070bytes；包内plan字节/engineering hash一致，私有回执摘要hash匹配，未发现配置密钥或私有回执标记。证据output/real-engineering-planning-9HYn7w/archive-proof.json。该次code0/businessAccepted:false，临时服务正常关闭。203与主集成工程策略hash已实核相同，仍不推导任意业务生成或整体F02充分性。
# 2026-11-14 同项目需求输入版本集成 f17671f

固定`f17671f48caffcdf08a702671e2938989986b2be`已集成。主检95脚本及显式真实MXC/Edge全量590/590，0失败/取消/跳过，102035.5745ms；非作者独立同版本95脚本、590/590，0失败/取消/跳过，101908.6853ms，前后Git干净。测试文件并发4；此前24文件并发未知停止的根因未确定，不据此宣称已解决。

新增真实产品HTTP5项和Edge2项验证标准DOCX到草稿、保存/应用分离、双服务检查点、旧输入与审批只读、新run新sourceGeneration和重新双确认导出、外部发布轮询撤权、窄屏焦点/草稿保留；独立组合探针1项额外使用真实HTTP/JSON/双SQLite确认异步批量DTO全撤权和重开一致。独立FIX保留通知P3：父级刷新迟到可在另一项目显示旧成功toast，数据与权限未变。下一组合380f83a/620246d已有修复及实际Edge回归，组合尚未放行。证据`output/verification/independent-source-change-integration-f17671f-20261114/RESULT.md`，root日志在独立集成树的忽略输出中。

source-panel原4e2专项虽13/13，独立发现交错GET漏onApplied后BLOCK；63b修复经另一非作者16/16 Edge及原post503/overlap探针新副本FIX。repair service原1c754专项73/73真实MXC与23/23 Edge虽过，独立同源历史问题探针证实旧记录遗漏新blocking，仍BLOCK返工，未作真实模型修复。两次旧真实候选的报告/源码hash保持原样，修复前私有校验记录`output/reference-web-ui-FYeJdW/pre-repair-root-proof.json`不授予通过。此阶段零付费调用、未动4317用户服务，未推送或部署；需求输入发布不等于目标业务代码或迁移已执行。
## 2026-11-14 来源修复、需求版本与规格预算组合408064b

固定408064b2abad29e3f9356fad9bbbeac5d1aed939：root98脚本及显式真实MXC/Edge665/665，107208.1512ms；非作者同版98脚本及665/665，108116.0165ms，均0失败/取消/跳过。另5轻量探针：A+B完整义务才能accepted、只A失败、最后规划读取新增C时模型拒绝/下载不返回/预览0spawn。独立报告及源码前后校验在output/verification/independent-source-repair-408064b-20261114/；未修改原1c/f24 BLOCK证据，hash保持。此处正向依赖fixture不是实际模型修复通过。

原866整体659/660，唯一失败为shutdown测试等预留history而未等provider进入，合法not_started被误当unconfirmed。f24仅显式同步provider入口并补派发前停止0调用负例，完整661/661（106652.8354ms），但非作者又确认最后await缺少同步pin：模型可能多调旧上下文，下载可能返回27字节可信fixtureZIP后才fresh DTO撤权，仍BLOCK未放行。408在模型最终guard及acceptedRow补同步pin，保留sourceFailure证据；新增三个最终读取回归及原独立探针均通过。未为通过放宽停止或业务断言。

规格模型核心91d49由不同作者独立140/140（4829.3586ms）及4额外探针FIX，97语法；覆盖回执字节/hash、重启限额不可扩大、晚metadata隔离、连续保存失败无规格/批准。根预算health/UI另真实390px检查无规格预算不开始model、本地仍可用、可信2次/1秒披露且0模型请求，并随665组合复验。此阶段零真实API、未改用户data/4317、未推送部署；实际bcec/e312仍失败，下一步才启动已授权的真实seeded修复。测试文件并发仍4，旧24并发归档未知停止根因未确认。
## 2026-11-14 真实seeded修复与交付来源误判

408主线的实际网页修复生成服务行2616fc93-07c6-45d1-8002-ba464385b7c3、执行ef66015a-2853-49c8-996b-33286571e488，新提交73020f7c1c5dcae8818f09f17aafcaae0b4ba8df/sourceHash3d956af6f8aa14bd939caf2fa776995fbf26415eb4b84290e3fff47ae05b0e8a。实际1编码+1Review，26988输入/5241输出；同版本自检18/18、独立HTTP/SQLite18/18、Edge21/21全部停止确认；原ISSUE-2687a2edbe14c1090c3f为resolved并绑定7302，blocking0、3项advisory保留。不可变execution.json为accepted，SHA9e72fdf579678cf4fb6317504039ec599fa630f8a6ff90101bd6b40bf2499ebb。

随后实际网页preview被默认verifySource拦截，sourceFailure将服务SQL行置failed，不能继续下载或称当前交付通过。根只读Git确认7302 HEAD相等、status/diff均空；实际Git根返回正斜线，而服务samePath只比较大小写未规范化分隔符，误判Windows工作区。隔离候选正在修正该平台缺陷并加默认真实Git入口正负例；不修改原Git/报告/服务状态以绕门禁，也不重编码同代码。修复后必须正式新复验，不能直接继承原accepted报告。

本轮原件校验565f25d7与67ffc342保持；私有汇总repair-trial-summary.json明确currentServiceStatus=failed、immutableModelReportStatus=accepted、previewStarted/sourceDownloaded=false。正常PTY STOP后QA_STOP_CONFIRMED、退出0、端口62188关闭，证明文件repair-platform-stop-1794652092076.json。用户4317仍为原进程84732。实际模型用量与失败均保留，未推送部署；未获成功UI截图或源码包，不把历史5dc交付证据替代本轮7302。
## 2026-11-14 7302正式复验与真实网页交付

af093Windows默认来源核对修复经root/非作者同版98语法及显式668/668完整测试，耗时110485.2453ms/109575.5378ms，均0失败/取消/跳过；非作者3真实Git额外探针确认同前缀兄弟root及assume-unchanged隐藏状态仍被blob检查拒绝，原QA/SQL没被改写。主线合并5ec6e13生产文件与af一致。

实际新复验服务e820994a-1c6d-45a4-8dcc-2a83d04aed87、执行36c096d6-9bd4-4da3-9fea-5e3c3ef7e60b；仍为73020f7/sourceHash3d956a，自检18、独立HTTP/SQLite18、实际Edge21全部通过/停止确认，新Review completed/blocking0，3advisory保留。新增编码0、Review1，用量16190输入/426输出；原2616修复轮1code/1Review26988/5241保持失败服务状态与不可变accepted报告，不补造通过。

网页实际预览在独立localhost57843完成alice登录、借阅库存1→0及active记录、归还库存0→1及returned，已保存repair-preview-returned.png。UI停止取得实际pid3808正常停止/exit0/sourceUnchanged/ack，当前活动0。点击下载的20文件包117959bytes，SHA35c1395cbb938a2b2c58ded72a8587fd1b3dc8d7825908bddb28e234b7ae1be8；本地副本library-web-73020f7-verified.zip，工作台交付截图repair-workbench-delivery.png。

root实际web:verify对该包全新副本HTTP18/18+Edge21/21，report output/delivery-verification/delivery-revalidation-Bfnx6D/revalidation.json，status checks_passed、taskAccepted/historicalAcceptanceVerified均false（不把包内历史声明当证明）。干净解压离线npm ci退出0、npm start实际启动localhost51033，7项版本/隐私/匿名拒绝/登录/借阅库存/归还重复409/登出及原源码不变检查全过，STOP_CONFIRMED退出0；停止后全部20交付文件hash仍一致。配置凭据、私有回执、本地路径、数据库均未出现在交付内容，已知凭据扫描通过。汇总final-recheck-delivery-summary.json、clean-start-smoke-73020f7.json为本轮事实，截图存在不代替业务检查。

QA平台PTY正常STOP退出0；63820/57843/51033已无监听，4317仍原PID84732。旧两个报告565f25d7/67ffc342及修复报告9e72fdf5保持；e820 accepted/active0/preview none。此为固定参考软件交付，动态DSL、任意业务生成、团队/Worker能力不因此完成，未推送或部署。包的额外非作者复核另行保存，不把未跑的独立检查写成完成。

## 2026-11-17 规格失败定位与补充修改

基线`5aaae2e`，生产代码`33523f7`。`npm run check`为114脚本语法通过；`npm test`为698项，668通过、30跳过、0失败、0取消，98,836.1902ms。30项跳过均为未启用真实MXC或显式真实Edge环境的既有集成项；本功能另跑真实Edge 1440px/390px浏览器回归。

新增离线/编排回归4项：引用失败返回需求序号/标题及`evidence/scope/note`字段、保存草稿0模型调用、补充后1次预算内重试且不自动确认；直接重试带入已保存草稿；空需求且无问题返回补充字段、预算耗尽仍可保存但不能再次调用；已保存响应后置校验失败记录为`invalid_model_response`而非`stale_revision`。新增真实Edge回归2项覆盖诊断可见、免费保存、刷新恢复、显式重试进入待确认规格、无控制台错误/横向溢出。关联澄清、预算披露浏览器回归7/7通过。

真实用户失败回执仅只读离线核对：可派生`requirement_quote_not_found`、第20条需求“浏览器网页应用交付形态”、剩余1次、`evidence/scope/note`补充字段；未改写原运行、未新增付费调用、未验证真实模型下一轮采纳质量。证据见`docs/tasks/specification-repair.md`。

## 2026-11-17 工程草案免费重新校验

生产代码`a1d9dd8`。`npm run check`为114脚本语法通过；`npm test`为700项，670通过、30跳过、0失败、0取消，97,506.0123ms。30项跳过为未启用真实MXC或显式真实Edge的既有集成项。

新增单元回归：`{issueId}`路由参数规范化为`:parameter`并写回草案。新增集成回归：更早的saved工程回执在运行失败后可经`revalidate_engineering`复用，不新增模型调用、engineeringCalls不变，任务与检查恢复并停在计划确认。临时数据副本对真实`library-system`失败运行复演：failed→awaiting_review，10任务、review通过。

实际运行`library-system/4d3eb701-fd5f-4d4b-9e29-343836ad878a`已执行免费重新校验：使用第1次保存草案，`{recordId}`规范化后通过；architecture/tasks/review succeeded，engineeringCalls保持2，planRevision `9fc9de131e3880468e3a7a271338ad4985ae22c57cebeb189342a571614e6612`，审批为空。原两次失败、用量和回执未改写；未确认计划或导出，未新增付费调用。证据见`docs/tasks/engineering-draft-recovery.md`。

## 2026-11-17 可复现验收流程

生产代码`6729182`。`npm run check`为117脚本语法通过；`npm test`为701项，671通过、30跳过、0失败、0取消，98,240.1947ms。30项跳过为未启用真实MXC或显式真实Edge的既有集成项。新增验收测试两次本地规划产生相同文档和计划投影，模型调用0。

`npm run acceptance -- --out output/acceptance-smoke2`实际结果：`planning_passed_only`，规划通过、可复现、模型调用0；两次运行均8条需求、12个任务，文档哈希和计划投影一致，ZIP均含7个预期文件。`npm test`包含该验收回归。

`npm run acceptance -- --out output/acceptance-smoke-web --archive output/live-web-delivery-3lVPQC/library-web-source.zip`：规划通过；固定Web复核返回failed，原因是本地ZIP为旧独立验收规则生成，当前`manifestHash/browserManifestHash/reviewPolicyHash`不一致。没有把旧包历史Review当作新结论，未放宽规则；报告`complete:false`。需使用当前规则重新生成的源码包和本机MXC/Edge才能完成Web部分。证据见`docs/tasks/reproducible-acceptance.md`和`docs/ACCEPTANCE.md`。

## 2026-11-17 工程草案自动修正与本地兜底

生产代码`a08319a`。`npm run check`为117脚本语法通过；`npm test`为705项，675通过、30跳过、0失败、0取消，98,501.7928ms。30项跳过为未启用真实MXC或显式真实Edge的既有集成项。

新增回归：不同工程校验错误会持续自动带具体反馈重试直到成功，不设次数上限（测试第4次调用成功）；完全相同校验错误连续出现时停止；无效工程JSON自动修正后成功，engineeringCalls=2且两条私有回执保留；模型连续失败后显式`use_local_engineering`不新增模型调用，本地架构/任务/检查成功并停在计划确认，plan.json含engineeringFallback；`{resourceId}`路径和`text/image/textarea`等ARIA别名规范化并写回；原免费重校验、凭据/传输/取消边界保持通过。未调用真实付费模型，未修改用户运行。证据见`docs/tasks/engineering-auto-repair.md`。

## 2026-11-17 澄清停点阶段展示

生产代码`f20b458`。`npm run check`为117脚本语法通过；`npm test`为705项，675通过、30跳过、0失败、0取消，101,728.6256ms。`tests/requirement-clarification-browser.test.mjs`在1440px/390px均通过：等待补充时`spec`节点无`succeeded`样式/勾选，显示“等待补充需求”，阶段详情状态和输出文案正确，进度不把占位规格算完成；重新整理出正式规格后恢复已完成。只改前端展示和浏览器回归，未调用模型、未改存储或审批。当前4317服务PID 2772，静态文件刷新即可生效。

## 2026-11-17 需求变更继承已确认回答

生产代码`01e301e`。`npm run check`为117脚本语法通过；`npm test`为707项，677通过、30跳过、0失败、0取消，114,761.8115ms。30项跳过为未启用真实MXC/显式真实Edge的既有集成项。

新增回归：需求输入应用后创建新运行，自动继承上一版2条已保存回答，`inheritedFrom.runId`/`answerCount`正确，`clarificationHistory`全部为`kind:"inherited"`，旧审批不继承，sourceSnapshot为新正文；新版规格重复旧问题时预填答案并标记`inherited`，`spec.clarifications`同步、`specRevision`重新计算。既有澄清、工程自动修正、输入变更、导出和可复现验收回归全部通过。未调用真实付费模型，未修改用户现有运行数据。证据见`docs/tasks/requirement-answer-inheritance.md`。

## 2026-11-17 需求变更草稿保存按钮

生产代码`73d1bec`。`npm run check`为117脚本语法通过；`npm test`为708项，678通过、30跳过、0失败、0取消，118,349.5895ms。新增面板回归：注入只有baseRevision、缺少baseGeneration的旧草稿并刷新，前端按当前generation补齐后保存按钮可用、不显示旧版本警告；旧版本revision仍进入“基于当前版本重新编辑”分支。按钮下方增加可见禁用原因。未调用模型、未改存储或审批。当前4317服务监听12344，静态文件刷新即可生效。
