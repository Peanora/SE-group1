# 首版验证记录

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
