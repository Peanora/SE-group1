# 本地原型接口约定

## 自动交付入口

`GET /api/health` 的 `automaticDelivery` 提供能力可用性、启动条件是否就绪和各阶段预算。 `POST /api/projects/:projectId/runs` 可在 `mode:"model"` 下携带 `automaticDelivery:{modelUsageConfirmed:true}`。仅接受本机请求，启用团队权限时须由负责人发起。省略该字段会使用人工确认。自动入口的规格、工程与验收清单预算分别为 4、5、3 次模型请求，系统更低的上限优先。开发仅启动一次，其整体或逐任务预算沿用研发服务。

`GET /api/projects/:projectId/runs/:runId/automatic-delivery` 返回 `enabled`，启用时还返回 `status`、`stage`、`message`、`updatedAt` 和 `downloadAvailable`。阶段使用首页节点 ID，状态为 `queued`、`running`、`needs_clarification`、`failed`、`interrupted` 或 `completed`。已启动的清单和开发分别返回 `proposalId`、`executionId`。业务澄清使用原有规划动作，提交后继续当前运行。下载仍走原研发下载接口，并核对当前执行的交付授权。

自动流程依次调用同版本规格、计划和验收定义的现有校验门禁，并记录自动确认依据。正在自动推进时，互斥的手工审批、发布和开发启动返回 409。工作台重启后继续核对已有开发执行，规划或清单阶段的未完成自动运行记为中断，保留历史和原请求状态。

规划预览保持最长三分钟的本机运行时限。工作台启动时会核对已记录输出超限、进程终止且源码完整的预览停止结果，恢复活动槽并保留原停止证据。停止未知的记录仍待协调。规划预览的交互输出总量由工作台配置为 4 MiB，独立验收和已验收源码的版本绑定沿用原规则。

## 代码审查历史与诊断

规划开发执行的公开记录新增 `reviewHistory`。每项包含 `taskId`、`attemptId`、`attempt`、`candidateCommit`、`sourceHash`、`status`、`summary`、`issues`、`resolutions`、`errors`、`error` 和 `diagnostic`。整体执行包含各候选版本，任务图执行还包含各任务的历史尝试，同一任务按尝试先后展示。原始意见保留 `originCommit`，复核结果带原问题 `id`、`checkedCommit` 和复核原因。工作台现有的 Review 详情展示这些历史，服务重启后可继续读取。

`modelCalls` 的审查调用附带 `id`、`candidateCommit` 及可选的受控 `reviewRejection`，后者只公开 `version`、`reason`、`field` 及可选 `position`。同一候选格式重试成功后，最初被拒绝的原因仍能在模型调用详情中读取。每个新提交按原 ID 重新复核全部历史阻塞问题，当前提交的关闭结论只适用于该提交。

新原生审查对同一文件、行号和问题说明的重复意见返回 `duplicate_issue` 诊断，`field` 指向对应的 `issues[i]`。已有问题应通过 `resolutions` 按原编号复核。缺少复核、未知编号和重复复核都拒绝结论。原有正常停止、回执保存及预算规则决定是否允许同一候选格式重试。耗尽格式重试或审查未完成时，验收记录标记 `incomplete`，保留历史阻塞并禁止交付。

独立预约演示入口为 `node scripts/review-reservations.mjs --fixture`，使用同一原生适配器校验和问题编号逻辑。`--model` 显式选择真实模型。演示报告记录 `kind`、固定 Git 提交、源码哈希、规则、问题、复核及完成状态，每个提交单独保存 JSON。

## 登录验收清单自动接续

当前计划确认后，`GET /api/projects/:projectId/runs/:runId/verification-plans` 的 `capabilities.canRecoverLogin` 表示负责人可以尝试接续专用的登录清单修订。旧认可清单、实际浏览器失败和当前计划的对应关系在保存前重新核对。

`POST /api/projects/:projectId/runs/:runId/verification-plans/recover-login` 接收 `{contractRevision,planRevision}`。提取并验证成功后创建待审阅草案，返回 `201 {proposal}`。若当前已有待审阅、认可或驳回记录，返回 `200 {proposal}`。无法可靠接续时返回 `200 {proposal:null,reason}`。版本不匹配或检查点在途时返回 409。接续不请求模型，原确认及验收结果保持历史归属。新清单核对通过并确认后才可开启开发。

## 现有工程接口请求和响应的人工修订

`POST /api/projects/:projectId/runs/:runId/action`，正文为 `{action:"revise_route_contracts",revision,changes:[{id,request?,response?,roles?}],feedback?}`。每项指定一个已存在的接口及至少一个可修字段。请求和响应说明是最多2000字符的非空文本，角色必须来自当前已确认规格。整个请求至少需要一处实质变化。方法、路径、错误结构、需求归属和可写文件范围由原方案确定。

操作沿用负责人的权限与安全检查点，旧计划版本、重复接口与未知字段均拒绝。成功后生成新计划版本、更新架构文档并重新运行计划审阅，原始工程结果和用量保留。计划须再次确认才能导出或进入开发。`GET /api/health` 的 `engineeringRouteContractRevision` 声明网页是否可编辑请求和响应。旧的角色修订动作仍支持。

## 工程接口允许角色的人工修订（i14已独立定向验收）

`POST /api/projects/:projectId/runs/:runId/action`，正文为`{action:"revise_route_roles",revision,changes:[{id,roles}],feedback?}`。`revision`必须是当前计划版本，`id`是已存在的工程接口ID，`roles`只能选已确认规格中的角色。仅负责人在当前来源、规格已确认且等待计划确认的安全检查点可修改；评审者、观察者、旧来源及执行中请求不得写入。

本操作只修改现有接口的允许角色集合，不增删接口、实体、视图、任务或可写文件。未知字段、未知或重复ID/角色、空修订及只有角色顺序变化均拒绝；校验失败不产生部分更新。成功后生成新计划版本并重做结构审阅，旧计划审批失效，必须再次确认后才能导出或执行。原工程模型结果、用量、预算和规格确认保留，不调用模型。

网页在计划确认区提供角色勾选与修订原因；未保存的权限改动阻止直接确认，失败及刷新保留草稿。`GET /api/health`的`engineeringRoleRevision:{available:true,version:1}`表示服务支持该候选接口；旧服务不显示编辑入口。权限修订仍需人核对业务语义，结构校验不能证明权限设计正确。

## 原生Review v2及失败反馈（i13完整Test，i14接线定向复验）

新原生Review请求显式使用wire v2：模型只返回`summary/issues[{severity,file,line,message}]/resolutions`。严格校验字段与固定候选的路径/行号后，由控制器从该源码行派生evidence，并标记`evidenceOrigin:'controller_fixed_source_line'`；位置仍由模型选择，不等于审查意见必然正确。旧v1回执继续用v1校验，不修补原JSON或追加缺失字段。

仅原生调用已完整停止、正常stop且回执已保存的格式/位置类`invalid_model_response`可在原Review次数、共享调用和原时限内重试同候选；每次独立计调用、usage和原回执。已知HTTP/浏览器失败优先实际编码修复，有效blocking必须在新代码关闭。length、未知终止、凭证、回执及传输等其它异常停止本次后续模型派发，显式另次修复仍保留原失败和账务。恢复时重新解码原回执并核对固定源码与历史问题，不能将有效blocking伪装成格式错误来抹除。

启动失败新增可信诊断枚举与允许的相对源码位置进入编码反馈；不转发任意stderr、异常message/stack、宿主路径或业务私有值。未执行检查保持失败/未执行，不因有位置诊断而变为通过。正式资格仍由同版自检、独立HTTP/Edge和Review共同控制。

## 编码模型控制配置（i11/i12已独立验收）

研发执行在服务创建时冻结受控thinking/JSON选项，首派与恢复Worker均经匿名stdin交接；配置纳入执行contract和作业configRevision。默认值也被冻结，进程环境后续变化不改变已建适配器或旧作业。`LLM_THINKING`接受enabled/disabled/留空，`LLM_JSON_MODE`接受0/1/留空；非法值不派发。密钥及其它环境不进入公开DTO、argv或Worker环境。改变控制选项不能沿旧作业配置恢复，也不重置项目/run的历史调用与尝试预算。

复杂工单真实输出在16384 token时只生成到第24个文件且JSON未结束，原失败与费用保留。i12只将编码单响应上限改为32768，Review仍4096、响应仍512KiB；单文件/总文件/路径门禁及完整正常stop资格不变，任何length响应均不应用文件。该容量调整不增加已冻结的3次attempt、18次调用或600秒时限。i12定向独立检查已通过，真实复杂案例仍以各自实际业务验收结果为准，不能把正常返回代码等同软件通过。

留空时不发送thinking且默认请求JSON。普通编码/Review、首派Worker及安全退休后的下一代使用同一快照。无显式选项的三字段旧配置保留原默认hash语义，不能覆盖显式false或disabled；选项不是HTTP请求可增加的权限字段。非法选项在预留/派发或换代之前拒绝。

## 安全暂停点恢复（W5候选，独立验收前）

`POST /api/projects/:projectId/runs/:runId/development-executions/:executionId/recover`，正文精确为`{}`，负责人权限，返回202。只在当前任务图的`actions.canRecover === true`时使用；普通`resume`继续同一执行进程，`recover`保存安全点、确认旧进程退出后换代继续。状态可能经过`recovery_requested`、`paused_recovery_ready`再到`running`；202不代表已经恢复或软件通过。旧源版本、未知停止或缺少签名证据返回409并保留记录。

恢复不新增开发attempt，不重置额度或绝对截止时间；已完成任务保留历史，不重做，剩余任务仍消耗原预留，最终集成重新验收。执行身份采用追加代次，当前上限8代，不能替换原注册或把JSON历史当原任务通过。此候选已有作者连续3代证据，独立固定版检查尚待完成。

同一`cancel`入口可处理已确认的安全退休点：核实旧进程退出和历史费用后只结算已发生调用，取消剩余工作，不能授权源码交付。发起人撤权和时限到期禁止继续执行，不抹掉历史费用。停止或回执未知仍保留活动槽；该取消分支正在候选验证中。

## 本机业务版本与已有数据演进（2026-11-18，集成验收中）

这组入口仅管理平台持有的本机业务副本，不发布公网。演示预览库不登记为业务数据。`GET /api/health` 的 `localEvolution.available` 为服务能力开关；旧服务不提供时网页不请求新接口。下列身份均从路径取得，正文不得夹带 `projectId`、私有路径、通过标记、进程回执、能力句柄或数据库内容。

项目基础路径 `/api/projects/:pid/local-releases`：

| 方法和后缀 | 精确正文 | 行为 |
| --- | --- | --- |
| GET 基础路径 | 无 | 返回 `releases` 和 `capabilities.canActivate`；记录只有身份、提交、数据代次、状态、受控URL及actions |
| POST `/activate` | `{runId,executionId,expectedReleaseId,expectedDataGeneration}` | 首次显式启用已验收源码，首次expectedReleaseId为null、代次0；已有数据升级由演进控制器提供私有迁移结果，公共请求不能覆盖旧库 |
| POST `/:id/start` | `{expectedDataGeneration}` | 在共同检查点核对当前pair后启动MXC业务副本 |
| POST `/:id/stop` | `{}` | 停止并核对源码、进程及数据指纹；unknown保留槽 |
| POST `/:id/rollback` | `{expectedDataGeneration,reason}` | 仅恢复当前pair的直接前一代码与数据对；新写入、旧备份变动或代次不符拒绝 |

新pair准备文件后，以本机私有SQLite事务更新指针。不是跨文件系统和多个数据库的分布式事务。常规关闭停止业务应用；重开不自动启动。意图或进程未能确认时保留待协调，不按PID猜停。每次回滚创建新pair，不能用A→B→A复活旧数据许可。真实业务数据库、备份、控制密钥及私有路径不进入公共DTO或普通源码包。

演进基础路径 `/api/projects/:pid/runs/:rid/evolutions`（rid为新确认规划）：

| 方法和后缀 | 精确正文 | 行为 |
| --- | --- | --- |
| GET 基础路径 | 无 | 返回evolutions、能力和明确支持范围；只读状态，不发模型 |
| POST 基础路径 | `{releaseId,proposalId,definitionRevision,expectedSourceRevision,expectedSourceGeneration,requestKey,reason}` | 从当前已停止owned业务pair核源码/旧数据，私有快照后生成待确认迁移；同键同内容幂等 |
| POST `/:id/revise` | `{revision,migration,reason}` | 有界迁移实质修订，新revision使旧确认失效 |
| POST `/:id/approve` 或 `/reject` | `{revision,feedback}` | 精确迁移确认/驳回，不能替代规格、计划、联合定义确认；驳回后原文不能直接批准 |
| POST `/:id/start` | `{revision,contractRevision}` | 核对同一预算和当前确认，在真实grant内创建跨版私有seed，再整体修改并独立重验 |
| POST `/:id/activate` | `{revision}` | 必须新版本完整验收，再从旧快照另迁移新副本，fresh核对后交本机pair切换 |

`migration`只接受固定合同的`none`或`bounded_operations`，支持`addColumn`和`mapValues`，不接SQL或脚本。值映射显式列出所有旧值（包括保留原值的映射），未知旧值拒绝。当前演进走整体项目；多任务scope未适配时在收费前明确拒绝，不静默降级。每个自检、独立HTTP、每个浏览器视口/原子场景从同一冻结旧快照取得新的迁移副本；不是空库代替旧数据或共用测试写入。模型修复反馈不包含观察到的原始旧数据或私有路径。

团队模式：负责人可准备/修订/开发/启用/回滚；评审者可确认或驳回迁移；观察者只读。GET会按当前角色过滤actions和顶层能力，每次写入和异步完成点重新判权并审计。前端在POST后重新GET核对，读取待定或失败时撤下旧业务链接，保留草稿且不自动重发收费动作。这些接口的完整三类业务演进、激活后历史交付及故障恢复仍在验收，不能由单模块通过推断全部完成。

## 研发Worker持久作业（2026-11-18，候选待独立验收）

研发HTTP路径保持不变。默认正常开发使用独立Worker，DTO新增`executionEngine`和`recoverySupported`；私有持久审批、派发意图、原预算/绝对deadline、Worker身份/控制租约、签名原始证据和幂等结算联合约束。正常API关闭仅detach，重开先接回原作业；未确认派发/远端请求/Worker状态时保留活动和预留，不自动新派发。known失败或已确认取消的独立停止签名只授费用结算，不授源码交付；新用途验收封签不伪造原core/graph WeakMap身份。

同版source修复和跨版seed目前明确走进程内路径，不能承诺Worker重启恢复；有效暂停任务检查点后的故障续跑尚未实现。已有源码ZIP重启恢复与在途Worker保活分别记录。作者94/94专项是候选证据，仍需非作者同固定版本检查。

## 可选本地团队模式

`TASKFLOW_TEAM_MODE=1`启动账号门禁；默认关闭，保留单人本地行为。启用后首次在`/team.html`设置负责人，由负责人添加成员。团队共享本地工作区，不提供跨团队/租户隔离或外部发布授权。所有项目API启用后必须登录；负责人可操作，评审者仅可确认/驳回规格、计划及独立测试定义，观察者只读。撤销或改角色使该账号所有既有会话失效；已经合法派发的后台工作保留历史授权，不声称撤权瞬停远端服务。

| 接口 | 请求及权限 |
| --- | --- |
| GET `/api/team/session` | `{enabled,setupRequired,user}`；不返回密码/令牌。 |
| POST `/api/team/setup` | 首次精确`{name,password}`，创建负责人并登录；并发仅一次成功。 |
| POST `/api/team/login` | 精确`{name,password}`；密码12至128字符，5次失败锁定15分钟；实际发布会话前重查锁及账号版本。 |
| POST `/api/team/logout` | `{}`，清除当前会话。 |
| GET/POST `/api/team/members` | 负责人列出成员；创建精确`{name,password,role}`，role为owner/reviewer/observer，最多64个账号。 |
| PATCH `/api/team/members/:id` | 负责人精确`{role,active}`；至少保留一位有效负责人；修改即撤销该成员全部会话。 |
| GET `/api/team/audit?after=游标` | 负责人/评审者读取最多200项及后续cursor。 |

Cookie为8小时HttpOnly/SameSite=Strict的随机会话，数据库仅保存令牌哈希及随机盐密码哈希。受本机Host/端口/来源边界保护；body完整读取后再次核对账号，不能靠慢上传延后已撤销权限。操作响应由服务生成`X-Request-Id`，审计尝试、内部账号事件及结果关联该编号，不记录请求正文、查询字符串、密码或Cookie。`health.teamAccess.enabled`用于旧界面兼容；未登录时前端转登录页，失效时清空私有成员视图并将焦点放回账号输入。

## 按当前规划研发（planned-web-v1）

执行能力中的 `budget.unlimited` 为 `true`，`maxAttempts`、`remainingAttempts`、`totalModelCalls`、`remainingModelCalls` 在累计额度位置返回 `null`。单轮预算及每条执行的实际 `totalModelCalls` 继续按原字段记录。保留旧 SQLite 账本的记录和已有预留。开始新执行前仍需取得当前确认、项目检查点及正常停止证据。

`failureHelp` 可包含 `title`、`detail`、`nextStep` 与固定 `action`。`POST /:id/revise-checklist` 只接受空对象。当前负责人可以用最新同计划、已停止且已诊断出登录步骤缺失的失败执行准备新计划修订。回复 `{run}`。旧检查记录绑定旧版本，新的方案及验收清单仍需确认。已识别的旧清单不能触发重复付费开发。

执行读取的 `workflow` 提供首页流程图使用的阶段摘要，包含 `stage`、`testing`、`selfCheck`、`reviewPending`、`reworkCount`、`cause` 与 `errorCode`。自动返工在同一执行内记录 `automatic_rework` 事件及下轮编号。独立接口测试与浏览器测试在同一固定版本并发运行，两项通过后才请求该版本的独立 Review。测试失败或有效阻塞意见在原预算内触发新代码版本及完整复验。仅格式或位置不合法的已保存 Review 可以在同一版本重审。导出仍由同版本验收证据和封签决定。

已完整停止并保存回执的编码建议在原 JSON 格式错误时，可在原调用额度内改用带明确文件边界的文本格式。报告为本轮编码记录 `codeWireVersion: 2`。执行、回执核对与历史源码复核使用同一解码规则，逐字回执和精确可写路径校验继续适用。

本地执行边界与固定参考相同：Host/Origin/端口必须匹配当前本地服务，不接受外部模型端点、目录、源码、命令或客户端通过结论。项目/运行归属先核对。固定参考、测试提案、规划及真实研发共同阻止活动期间需求发布或删除；保存变更草稿仍可用。

基础路径`/api/projects/:projectId/runs/:runId/development-executions`：

| 方法/后缀 | 请求 | 行为 |
| --- | --- | --- |
| GET基础路径 | 无 | `capabilities`含冻结模型/规则的`contractRevision`、每角色3次、600秒、3尝试/18模型调用共享预算，及`executions`真实状态。 |
| POST `/start` | 精确`{proposalId,revision,contractRevision}` | 当前联合HTTP+浏览器定义已认可才202创建新记录。SQLite先预留预算，再进入共同检查点/冻结定义并启动编码；不自动开始。 |
| POST `/:id/cancel` | `{}` | 请求停止；本地结束不证明远端终止。未知保持活动及预算预留。 |
| POST `/:id/pause` | `{}` | 仅当前控制器持有的真实任务图：暂停新批次派发，返回`pause_requested`；在途结果保存后才`paused`。旧执行器/整体编码不支持则409。 |
| POST `/:id/resume` | `{}` | 仅当前任务图`pause_requested/paused`，继续同版本就绪任务；不直接把失败检查标为通过。 |
| POST `/:id/repair` | `{contractRevision}`，可加 `repairNote` | 仅服务自有、当前规划且正常停止候选；用私有DB定位报告，核对Git、回执和历史阻塞，在新工作区创建新执行。修复说明为1至2000字符，校验失败在预留预算前返回400。说明作为诊断资料随编码请求发送，并保存于新执行的私有记录。原代码范围、验收定义和独立Review依据由已确认版本决定。 |
| GET `/:id/download` | 无 | 当前版本全部验收、阻塞关闭且可信原始结论仍有效才返回源码ZIP；存储JSON或POST通过声明不能授权。 |

`actions.canRepair/canCancel/canDownload`只表示当前后端能力。前端收费动作还需本次预算勾选；POST后通过GET核对新id及定义版本，不能先显示通过。JSON DTO不包含工作区、回执路径、配置凭据或数据库。

同版本交付恢复（当前实现仍在独立验收）：真实原始对象完整通过后，accepted行、私有HMAC封存及本次预算结算在同一SQLite事务保存。重启后的GET列表/下载可以在共同检查点惰性核对当前审批、代码/Git/原始回执/全部策略，再发行仅用于历史交付的私有许可；原任务品牌不重造、不新增模型调用或扣减预算。DTO `checkpoint:{sealed,restored,message}`区分；网页标明恢复历史资格，没有刚重跑测试。校核期间状态`restoring_delivery`持久占用项目槽，未知停止保留待协调；本会话失败不随轮询无变化重复Git。并发下载遇正在恢复可409，待列表核对后再试。

普通旧JSON、无封存历史、签名/完整行归属变化、当前来源/策略或代码不一致、私有凭据不可用均不授权下载，也不事后补签旧记录。密钥在执行私有根目录、候选工作区外，不进API/模型/源码包；丢失时不自动重新生成并追认旧记录。可信主机/程序/私有数据库属于基础边界，不承诺防同账户管理员同时复制密钥与整库、整套私有备份回滚。当前只恢复已结束的同版本交付，外部Worker续跑仍待实现。

无逐任务分组的定义继续整体按确认计划编码。开发任务图的模拟状态保持原义，不因真实路径新增而改造历史模拟结论。独立HTTP/浏览器定义的结构覆盖不证明业务充分。CLI `planned:verify`仅重新诊断包内定义，不认可历史Review或提供当前完成资格。

### 真实任务图候选（集成验收中）

联合提案可附`taskScopes:[{taskId,httpStepIds,browserStepIds}]`。必须精确匹配全部当前确认任务，各任务有明确非空writePaths，直接选择的HTTP请求与浏览器断言分别覆盖自己的REQ；HTTP依赖及浏览器同会话前序保留。完整任务集合及分组均参与父审批哈希，编码后不可变；可信派生绑定父清单、taskId和taskDefinitionHash。部分清单不能交付或封存整项目。确认定义仍不等于执行测试。

当前支持2至8项、单一基础任务及依赖全部前项的唯一末项，最多2个独立任务并行，各自Git克隆/认领/租约/原始回执。全部同批门禁和来源核对后，可信控制器实际Git合并，才事务完成并释放下游；末项重新运行完整父清单及Review。一个私有任务库只有一个控制器写入；批量完成是无await的连续事务，不声明跨外部Worker的批量原子提交。在途Worker重启续跑及完整代码/数据需求变更另行验收。

存在分组的批准定义时，GET预算新增`taskLimit/maxConcurrency/attemptModelCalls`，每任务最多3编码+3Review、整个图最多20分钟；初次冻结按当前可用定义的最大任务数预留（最多48调用），3次图尝试共享总调用上限。已有预算不自动扩大，选择超范围定义拒绝；`supportedProposalIds`指出可启动项。全图所有已发送模型调用计入用量，包括同批其它任务失败后的已用/未知，不能只结算最终任务。未派发确认0，已派发无完整回执保持未知。

执行DTO保持`kind:planned_web`，新增`executionMode:task_dag`及真实`tasks`、`maxConcurrentTasks`、`actions.canPause/canResume`。任务详情提供依赖、尝试/基础/候选提交、阶段、差异、独立检查及用量，不含私有目录/租约令牌/回执正文。客户端只依据GET核对状态。最终已验收包额外包含经封存绑定的`delivery/task-execution.json`和全任务用量；归档重检始终不认可历史完成。任务图封签覆盖整个执行记录及最终原始结论，恢复仅发行最终历史交付许可，不将解析JSON重新授予任务品牌。

当前返工候选增加每任务只读 `history`（旧尝试/候选、检查、调用和未知用量），源码包的任务历史同样保留旧失败，不覆盖计费。完整集成的可信原始检查发现唯一上游负责者的阻塞时，最多一次退回该任务及其依赖下游；所有 open blocking 必须属于该负责者，多个或混合负责者保留完整意见并停止，不扩大文件权限。当前图、每逻辑任务的累计编码/Review次数和绝对截止时间不重置，新的预留只允许收紧到剩余额度。该行为不新增客户端指定 owner/path/issue/passed 的接口。以本轮固定组合独立验收为准，不能用接口说明代替通过证据。

`costEstimate` 用 `known:false,amount:null,currency:null` 明示没有模型单价时金额未知；实际 `totalModelCalls` 与 token 用量另行显示。未知 token 保留 null，不补零。任务 `error/errorCode` 为安全提示，网页以文本显示。

## 工作区展示与通知

四个前端工作面复用原规划、任务、需求变更和执行接口，不新增后端端点或可信成功状态。工作面、document-v1整页滚动位置和未保存输入只在当前标签会话保存，不授予审批或执行权限；旧面板相对滚动坐标不复用，原草稿不迁移或删除。

「需求与功能」用当前输入、草稿、待应用和已生效四步定位正文、差异和版本记录。「代码与验收」的四个交付步骤继续读取规划、清单和开发记录。逐任务画布使用开发执行 DTO 的 `tasks` 和 `dependsOn`，验收矩阵按任务、尝试及候选提交展示已记录证据。接口没有提供的历史检查保留为未提供，同版交付仍以原先的后端许可为准。

需求变更面板可选`onReady({projectId})`布局回调，仅在当前项目、当前有效读取完成最终渲染后触发。工作区据此恢复整页阅读位置，避免初始化提示移除带偏坐标；迟到读取不触发，回调不改变需求状态或后端权限。

执行及模拟前端模块可选`onFailure({id,message,context:{projectId,runId}})`，仅从当前有效响应的真实失败状态派生、按记录与尝试去重。回调异常不改变后端状态；迟到响应与ABA切换仍须被各模块拒绝。模拟`onActionSuccess`仅表示操作请求被接受，不代表任务完成或验收。统一通知按项目/运行归属清理，定位按钮只改变工作面和阅读位置，不启动模型或执行恢复动作。

## 问答确认来源

控制器从已保存clarificationHistory派生C-轮次-问题序号来源。明确“都要/全部需要”等全选回答只授权对应列举选项；单一、无备选项的明确肯定可授权对应事项。否定不授权问题引用；含糊/多问句确认标记unresolved，并在规格中保留需进一步回答的问题。来源同时保留原问题、原回答、decision及quotes，不授予执行或审批权限。

规格请求可信options新增confirmedSources（有界文本数组，每项为带编号的来源JSON文本），不从HTTP接收该参数；与document一起作为模型输入数据。引用白名单由原文、回答及派生的confirmed选项组成，回执复核和人工修订相同。原planningSourceText不变，既有inputRevision仍能核对原问答；新规格clarificationSources/version=confirmed-qa-v1及需求sourceRefs保存来源，参与specRevision。客户端不能伪造来源记录或引用编号。已有失败仍走hash绑定私有回执免费重新校验，不新增调用或改写旧失败，恢复后仍需人工确认。


## 平台默认方案与项目删除

用户2026-11-16明确选择当前只使用平台统一Web方案。新版workflowVersion=2的本地规则、模型规格、修订和免费响应恢复，均由控制器设置stack={frontend:"HTML/CSS/JS",backend:"Node.js",storage:"SQLite"}及platformDefaults/web-v1，参与specRevision。模型技术栈缺失或客户端技术配置不能覆盖默认值；旧适配器默认行为与v1记录不补造新方案。纯粹技术选型问题不要求用户回答，审计、加密、数据保存及未知问题保留。页面和spec.md明确Web交付边界，不声称原生Windows安装包已实现。

`GET /api/health`增加platformDefaults说明和stack。规格确认前本地inspectEngineeringContext预检，失败返回具体字段/配置提示，不创建工程请求或新工程尝试。

运行action增加`{action:"use_platform_defaults",revision,spec?,answers?}`：仅当前来源、规格阶段成功且处于awaiting_spec/awaiting_review/failed的新版运行可用，无其他活动运行、在途模型/阶段或活动模拟；可一并保存当前业务修订/回答。免费产生新规格版本，保留旧规格/审批/失败和用量，清除旧审批及下游计划，回到awaiting_spec。需再次确认规格后才发起工程请求，不能靠更换方案自动继承审批。

`DELETE /api/projects/:id`需要本机请求及JSON `{confirmationName:"项目当前名称"}`。规划、模拟及固定执行服务共同检查点确认无实际在途工作；仍为running的规划、编码、预览、下载/停止/进程待核对等均409。返回`{deleted:true,projectId,runIds}`。名称不匹配409、重复删除404；失败不从内存隐藏项目。浏览器先确认项目名称，成功后切换到剩余项目或空工作台。

删除使用现有JSON的deletedAt标记保留完整本机恢复记录，不物理清理需求、回执、SQLite或源码；list/get及重启加载隐藏该项目，所有后续项目API失去入口，旧保存和旧输入发布不能将它复活。删除先阻止新保存，等已有队列，再以原子替换发布标记；写入失败保留原项目。单机存储事实不等于跨服务事务或完整账户级数据清除。用户项目未作为破坏性测试数据。


## 规格失败说明与保存响应重新校验

失败的model规格GET（项目详情和单运行）可附加派生的`specificationFailure`：固定reason/label/message、可选requirementIndex/requirementTitle/field/detail、remaining、canRetry/canRevalidate、attemptId、nextStep及supplement。`repairable`表示当前失败可能由需求信息不足或规格条目无法追溯引起；`supplement.fields`给出固定字段（目标、使用者、首版范围、不包含、验收标准、依据说明、其他说明）及问题，`saved`来自最近保存的补充草稿或已提交的补充轮次，`canRetry`表示是否还有冻结预算。`detail`只来自控制器自己的校验说明；模型原始响应、私有路径和异常正文仍不公开。历史invalid_model_response可读取同源回执离线诊断，原历史不改写。

`{action:"revalidate_spec",attemptId}`仅支持当前输入、正常settled且saved的最后一次invalid_model_response失败回执。路径由服务器派生，验证文件类型/真实路径/链接、字节数及SHA256、sourceRevision与inputRevision；解析使用当前引用白名单，不调用模型、不增加预算。最终发布再次核对项目/运行/输入/规格和回执版本；保存失败撤回。新规格待确认，原调用失败及用量原样保留；单独追加specificationRevalidations，记录响应摘要、输入和新规格版本。重复、过期、其他活动运行、待核对请求、篡改/缺失回执均拒绝，不授予审批或执行许可。

引用允许逐字命中原文或用户回答。平台自己的上下文中若包含`答复：Windows`或完整问题加答复，可仅去除实际存在于合成输入的包装，再校验剩余答复是否逐字来自白名单；规格保存为规范化引用。纯模型问题和不存在于合成输入的伪造包装仍拒绝。

规格预算耗尽时，retry在操作入口返回409，不重新派发、不追加模型尝试；页面禁用重试并解释保留回答及免费重新校验（若可用）。真实引用错误、无效JSON等通过固定错误分类显示，不透传模型正文或未知异常。

### 补充规格信息并重新整理

新增运行action `{action:"supplement_spec",revision,answers,retry:false}`。仅新版model运行、规格阶段失败、无其他活动运行/阶段或在途规格请求时可用；revision必须是当前`sourceRevision`。answers只接受当前失败`supplement.fields`列出的字段，每项最多4000字符，至少一项非空；未知字段、空答复、超长或非文本拒绝。`retry:false`只把补充内容保存为`specificationRepair`草稿，不调用模型、不改状态、不增加预算，供页面刷新后继续编辑。`retry:true`先校验仍有冻结规格调用预算，再把补充内容作为`kind:"spec_repair"`的问答轮次写入`clarificationHistory`，清除草稿、重置规格及下游阶段并重新调度；新模型输入为原需求快照加已保存回答，原sourceSnapshot/sourceRevision不变，`inputRevision`变化。补充问题使用固定问题文本，不是用户需求原文；模型只能在用户答复正文或原文中逐字引用。新规格仍需人工确认，不自动审批或生成计划。预算耗尽时只能保存草稿；补充草稿在直接`retry`规格阶段时也会先提交，避免保存内容被忽略。

## 模糊需求澄清

新版model规格响应允许requirements为空且questions非空，解析器生成`spec.clarificationRequired:true`。Run仍使用`awaiting_spec`，页面显示“等待补充需求”，不发布规格审批、不生成下游计划；缺少问题、非法JSON、引用或结构错误仍拒绝。普通规格和旧版记录沿用原有确认契约。

沿用运行action接口，新增`{action:"clarify_spec",revision,answers:{"Q-001":"…"}}`：仅当前新版model澄清停点可用，全部问题须有非空答复。动作先保存回答与历史，再调度规格阶段；重复/过期/在途/已换需求/预算耗尽返回错误，不新增调用。`revise_spec`可单独保存回答，不调用模型。澄清与重试共享冻结的specificationBudget，不额外增加次数。

`clarificationHistory`保留问题编号、问题、答复、原规格revision和时间；模型输入为不可变sourceSnapshot正文加已保存回答，补充数据没有执行授权。新调用以inputRevision绑定合成输入，同时保留原sourceRevision。新规格的sourceClarifications由服务端历史派生并参与specRevision，原文引用可来自原文或补充回答；客户端不能通过修订覆盖该来源。原requirements.md不变，spec.md和plan.json保留补充信息。重新生成后仍需显式确认规格、确认计划。新调用失败保留回答与回执，可在原预算内重试；重启按已有中断规则处理，不自动调用模型。无需迁移旧数据，原失败记录不改写成功。


## 开发任务模拟编排

新增接口前缀：`/api/projects/:projectId/runs/:planningId/simulations`。它与规划运行`/runs/:id`和固定参考源码`/executions`独立。仅本机请求可读写；旧需求/未确认/未完成规划导出/非法图/未解决写入冲突不能启动。每项目一个活动模拟运行，活动期间拒绝规划修订和需求发布；已结束或中断记录保留原版本。

| 方法和后缀 | 返回或作用 |
| --- | --- |
| GET 前缀 | `{runs, canStart, reason}`，仅已保存的模拟快照及启动阻止原因 |
| POST 前缀 | 202 `{simulation}`；参数见下方 |
| POST `/:simulationId/action` | `{simulation}`，暂停、继续、失败重试或人工确认 |
| GET `/:simulationId/download` | JSON下载，外层`kind:simulation, realAcceptance:false`及完整模拟记录 |

启动JSON：`{planRevision, concurrency:2, durationMs:1200, failOnceIds:[], confirmationIds:[]}`。除planRevision外可省略；并发1至8，模拟时长0至10000毫秒；选项ID必须属于当前计划。首次失败选项只影响指定任务第一次尝试。任务定义的`requiresConfirmation:true`或confirmationIds指定的任务在结果产生后等待人工确认；这是该次模拟运行的选项，不修改计划定义或真实验收许可。未知字段和未知ID拒绝，不接受前端传入完成状态。

操作JSON：`{action:pause}`、`{action:resume}`、`{action:retry,taskId}`、`{action:confirm,taskId,attempt,reason}`（示意值为字符串）。confirm要求当前待确认任务的成功模拟尝试编号和1至5000字符的非空依据；保存时间、依据、尝试及计划版本。失败/阻塞任务、过期/重复确认、complete等普通完成操作均拒绝。暂停在派发边界生效，在途任务可结束；重试只重跑失败任务，成功分支和失败历史保留。

记录包含项目/规划ID、sourceRevision/sourceGeneration、specRevision、planRevision/planVersion、冻结spec和任务definition、并发/模拟选项、事件及时间。每任务保存status、reason、requiresConfirmation、attempts和history。

| 任务status | 页面含义 |
| --- | --- |
| pending | 待开始，等待依赖 |
| ready | 就绪，等待并发槽 |
| running | 后端模拟执行中 |
| awaiting_confirmation | 结果已产生，待人工确认 |
| completed | 模拟完成，非真实验收 |
| failed | 失败，可按版本重试 |
| blocked | 前置失败或阻塞，不允许人工强制完成 |

运行status另有paused和interrupted。重启后活动运行显式中断；在途尝试保存interrupted，任务转failed，未派发任务重新计算依赖。待确认结果仍可人工确认，但继续派发需人工resume；中断失败任务也可retry。默认不自动重跑。每次新计划启动创建全新任务状态，旧记录可读及导出，旧版本操作返回409。

执行器接口：`execute({task,attempt,failOnce,durationMs,signal}) → Promise<{outcome:'completed'|'failed',summary}>`。本轮仅SimulatedExecutor，不执行代码/命令或业务测试；替换接口不自动获得真实验收能力。状态在调度服务中更新，先保存后派发；保存失败停止该项目新派发并返回503，需重启核对。没有多Worker、事务数据库迁移或团队身份认证。所有模拟记录均标记`kind:simulation`、`realAcceptance:false`，不创建真实执行行、不放开预览/源码下载。

本项目为需求规划与固定参考Web研发工具，单用户本地运行。后端默认监听127.0.0.1:4317，提供静态前端与JSON API。要求Node.js 22.21或以上，以锁定的playwright-core和系统Edge完成独立浏览器检查。

## 数据结构

- Project: `{ id, name, source: { filename, content }, createdAt, updatedAt, runs: Run[] }`
- Run: `{ id, projectId, mode: 'local'|'model', status: 'running'|'paused'|'awaiting_review'|'succeeded'|'failed', createdAt, updatedAt, stages: Stage[], spec: object|null, tasks: DevTask[], artifacts: Artifact[], events: Event[], review: object|null }`
- Stage: `{ id, title, dependsOn: string[], status: 'pending'|'running'|'succeeded'|'failed'|'blocked', attempt: number, startedAt: string|null, finishedAt: string|null, error: string|null }`
- Artifact: `{ name, title, stageId, content, createdAt }`，name 为 spec.md、architecture.md、task.md、review.md、handoff.md 或 plan.json。
- Event: `{ sequence, time, stageId: string|null, level: 'info'|'success'|'error', message }`
- DevTask: `{ id, title, description, category, dependsOn: string[], acceptance: string[], suggestedFiles: string[], requirementIds: string[] }`
- Spec: `{ title, summary, goals: string[], roles: string[], acceptanceScenarios: string[], requirements: [{id,title,description,acceptance:string[],sourceQuote,kind}], constraints:string[], assumptions:string[], questions:string[], stack:{frontend,backend,storage}, sourceMode }`

工作流阶段固定为 intake → spec → [architecture, tasks] → review → export。review 成功后进入 awaiting_review；用户确认后才运行 export。开发任务 DAG 是 tasks 阶段生成的业务产物，与工作流阶段区分展示。

新版运行`workflowVersion:2`在spec成功后增加`awaiting_spec`停点：当前规格确认前不执行architecture/tasks。review成功后的`awaiting_review`表示当前计划等待确认。阶段图仍为六阶段，确认是带版本的门禁。新版Run另有sourceSnapshot/sourceRevision、specRevision/specVersion、planRevision/planVersion、specQuestions、approvals、revisionHistory和decisions。

sourceSnapshot为本次运行不可变原文，导出requirements.md也使用该快照。内容revision采用按键排序的SHA256；问题答复位于spec.clarifications并参与规格标识。所有待确认问题先保守视为blocking，逐项非空回答并保存修订后才可确认。每类修订最多20版，历史仅追加已替换版本的完整快照，当前版本仍在Run本体。

执行服务默认通过ProjectStore.getPersistedRun读取最后成功发布至文件的深复制快照，不能使用尚在保存中的内存审批；写入失败不更新该快照。实时规划GET仍展示当前运行过程。此单控制器文件发布边界不是事务数据库或跨存储事务。

规划决定在同一项目内互斥，先等已进入驱动的停点保存完成再修改审批；其他运行的操作及新建不能保存该待决审批。retry/resume也不能越过同项目其他活动规划。失败回滚后保持原持久化批准状态，仍以当前版本门禁决定是否执行。

## 接口

- GET `/api/health` 返回模型名称、配置状态、支持格式与 `modelPlanning`。规格和工程默认 `MaxCalls:null`、对应 `CallLimit:false`，并提供单次时限及工程每轮时限。
- GET `/api/projects` → `{projects:[{id,name,createdAt,updatedAt,filename,lastRunStatus,runCount}]}`
- POST `/api/projects`，JSON `{name?,filename,content? ,fileBase64?}` → 201 `{project}`。文本使用 content，DOCX 使用 fileBase64。
- GET `/api/projects/:pid` → `{project}`
- POST `/api/projects/:pid/runs`，JSON `{mode:'local'|'model',failOnceStage?:'tasks'|'architecture'|'review',expectedSourceRevision?,expectedSourceGeneration?}` → 201 `{run}`，后台异步启动。单个项目同一时间只允许一个活动运行；可选预期需求双版本成对提供，格式错误400、过期409且不创建运行或调用模型，详见同项目需求输入版本。
- GET `/api/projects/:pid/runs/:rid` → `{run}`
- POST `/api/projects/:pid/runs/:rid/action`，JSON `{action:'pause'|'resume'|'retry'|'approve',stageId?,feedback?}` → `{run}`。暂停为阶段边界暂停，运行中任务完成后不启动后继；失败运行结束后重试 failed 节点，保留成功分支。approve 仅在 awaiting_review 接受，可附审阅意见。
- GET `/api/projects/:pid/runs/:rid/artifacts/:name` → 文本文件，`?download=1` 添加下载头。
- GET `/api/projects/:pid/runs/:rid/download` → 成功运行的 ZIP 文档包。

错误统一 `{error:'面向用户的原因'}`。用户输入错误为 400，未找到为 404，状态冲突为 409，服务错误为 500。请求 JSON 上限 6 MB，DOCX 文件上限 3 MB，解析后文本上限 100000 字符。

### 新版规划确认动作

仍使用同一action路由，所有动作服务端串行校验；过期/缺少revision、重复批准、在途阶段及无效状态返回409。`feedback`可选，驳回时必填。旧`approve`仅允许无workflowVersion的v1记录导出，新版必须两次确认。

- `approve_spec {revision,feedback?}`：仅awaiting_spec，当前全部阻塞问题已答且本版未被驳回。确认后才开始架构/任务。
- `revise_spec {revision,spec?,answers?:{问题id:答复},feedback?}`：可在两个等待停点修改；校验规格结构及原文引用，回答按服务端问题重建，不信任客户端clarifications。必须有实际内容变化；新版本清除两审批与当前下游结果并回awaiting_spec，历史保留。
- `reject_spec {revision,feedback}`：记录理由，本版不可再批准；须保存新修订。
- `approve_plan {revision,specRevision,feedback?}`：仅awaiting_review，规格确认有效、当前计划及结构检查一致后导出。
- `revise_plan {revision,tasks,feedback?}`：仅awaiting_review，校验真实依赖图、需求映射和非空验收，保存新计划并重新结构检查；非法任务原子拒绝，保留可编辑状态。
- `reject_plan {revision,feedback}`：记录理由并阻止批准同版，须实际修订后再确认。

approvals为`{spec:null|{revision,at,feedback},plan:null|{revision,specRevision,at,feedback}}`。specQuestions为`[{id,question,answer,blocking:true}]`；decisions记录`{action,revision,specRevision,at,feedback,newRevision?}`。revisionHistory.spec/plan为已替换版本`{version,revision,specRevision,at,spec,specQuestions,tasks,artifacts,stages,review,approvals}`。确认和修订不会把文档完成升级为代码完成。

仍未答复的既有blocking问题不能通过删掉或替换questions解除，必须先答复并保存处理依据。页面计划审阅可返回规格编辑；保存新规格后旧确认失效，重新经过规格确认和规划。尚未保存的草稿不是已批准规格。

### 新版模型工程规划

新版model运行在规格确认后，由architecture/tasks共享一次工程模型请求，生成经校验的实体、角色/接口、页面选择器和任务。DevTask增加writePaths/inputs/outputs，suggestedFiles与writePaths保持一致；计划版本另外绑定完整engineeringPlan，人工改任务同步更新草案/hash及架构。原接口、实体、页面及全图可写文件集合不能通过任务编辑改变；规格回修后重新规划。local/v1仍使用旧规则，无engineeringPlan时旧计划hash公式保持不变。

工程规划默认不限调用次数，单次最多60秒，每轮自动修正最多10分钟。显式配置1–20时仍按有限预算执行；不限次数模式下手动重试或确认新规格开始新一轮工程时限。遇到传输、配置、凭据或取消等非结构错误，或连续出现相同校验说明时结束自动修正。`engineeringCalls` 记录预留尝试，`engineeringHistory` 公开状态、模型、用量、校验说明及回执摘要。私有回执保存在 `data/.private`。未知用量为 `null`，未确认停止的请求保留待核对状态。工程草案仍须计划确认。

模型常把路由参数写成OpenAPI风格的`{recordId}`、把纯文本选择器角色写成`text`；控制器在校验前把前者规范化为`:recordId`，把`text/image/textarea/select/dropdown/anchor/listbox`等常见别名映射到有效ARIA角色，并把规范化结果写回草案参与hash和文档渲染。路径仍必须是应用内相对路径，空段、点段、编码、重复参数和不安全字符继续拒绝。

模型草案未通过 `invalid_model_response` 时，控制器带上具体路由、页面、任务或文件的校验说明自动修正。每次尝试保存 `engineeringCalls` 和可核对的回执。自动修正沿用本轮时限；达到有限配置次数、发生非结构错误、遇到相同说明或页面停止时进入失败停点。

失败的architecture/tasks GET可附加`engineeringFailure`：固定code/attemptId、remaining、canRetry、canRevalidate、canUseLocal、message、可选detail及nextStep。`{action:"revalidate_engineering"}`仅用于新版model运行、规格已确认且architecture/tasks失败、无其他活动阶段/运行/规格请求；服务器按attempt从新到旧读取同当前specRevision/sourceRevision的私有工程回执，核对普通文件、字节数和SHA256，解析并重新执行当前结构校验。任一保存草案通过后发布其规范化engineeringPlan；只追加engineeringRevalidations（attemptId、hash、policyHash、时间），不改写原失败、用量或engineeringCalls，不调用模型。新草案不能引入规格外实体/接口/页面/可写文件；不授予计划确认或执行许可。若所有保存草案仍不符合规则，409返回当前校验说明；JSON、回执、运行版本或活动状态不匹配均拒绝。公开接口不返回私有回执正文、路径或异常。

`{action:"use_local_engineering"}`是显式兜底：仅新版model运行、规格已确认、architecture/tasks失败且没有engineeringPlan时可用。它不调用模型，写入`engineeringFallback{version,specRevision,at,reason}`，清除engineeringPlan，重置architecture/tasks/review/export并由本地确定性规则生成架构、任务和检查；任务仍须人工计划确认。架构/task文档和plan.json明确标注`本地规则生成`/`engineeringFallback`，不是模型工程草案，不授予执行许可。规格修订会清除该兜底，使新规格回到模型工程规划；预算耗尽仍可使用本地兜底。自动修正与本地兜底都不静默把模型失败当成成功。

## 内部规划函数

`lib/planner.mjs` 导出：

- `analyzeRequirements(sourceText, projectName)` → Spec（同步、本地模式）
- `analyzeWithModel(sourceText, projectName, options?)` → Promise<Spec>（模型模式）
- `generateTasks(spec)` → DevTask[]
- `renderSpec(spec)` → Markdown
- `renderArchitecture(spec)` → Markdown
- `renderTasks(spec,tasks)` → Markdown
- `reviewPlan(spec,tasks)` → `{passed:boolean,issues:string[],coverage:[{requirementId,taskIds:string[]}],summary:string}`
- `renderReview(review)` → Markdown
- `renderHandoff(spec,tasks,review,feedback='')` → Markdown
- `validateTaskGraph(tasks)` → void（非法依赖或环时抛 Error）
- `getModelConfig()` → `{configured,model,baseUrl}`（不返回密钥）

`analyzeWithModel`的可信options可含config/fetchImpl/signal/timeoutMs/onReceipt，不从HTTP注入函数或配置。保留裸JSON及JSON代码围栏的正常stop响应和原文引用校验；仅stop可接收，未知结束状态拒绝。请求最多768KiB、实际响应流1MiB、正文512KiB，总截止覆盖连接、读取和可选回执。已知配置凭据进入输入会拒发，正文回显先遮蔽再拒绝；错误不透传底层正文或路径。可选四字段私有回执不改变Spec返回结构；当前编排器尚未使用该hook记录规格用量，不据此宣称统一预算或完整停止已接通。

## 状态和持久化

### 规格模型预算与回执

`GET /api/health` 的 `modelPlanning` 含 `specificationMaxCalls`、`specificationCallLimit`、`specificationTimeoutMs` 与对应工程策略。不限次数用 `null` 表示，规格单次默认90秒。可信服务构造选项可显式设置有限策略，网页根据健康响应显示调用策略。

旧运行启动后按当前不限次数策略继续，历史调用、回执及用量保留。显式有限策略与已保存有限预算同时存在时取较小值。规格尝试继续按预留计数；`specificationHistory` 保存版本、状态、时间、结束原因和回执摘要。未知 token 为 `null`。

### 查看问题与自然语言回答

当前模型运行的澄清停点、规划失败或确定的审阅输入错误可在 `GET` 运行响应中提供 `planningIssue`。其中 `id` 绑定当前问题、规格、计划和输入版本。`qa` 为当前轮的 `{id, question}` 数组，需补答的原题包含 `previousAnswer`。`answers` 为已存逐题草稿。引用失败且能验证同一尝试的回执时，`draftRequirement` 仅返回出错条目的 `index`、`title`、`description`、`sourceQuote`，均标为未确认草案。

- `{action:"explain_planning_issue",issueId,automatic:true}` 在 `autoExplain:true` 时调用配置的模型，返回简洁解释和最多二十个问题。已有规格问题或说明时直接复用。用量和私有回执记录在 `planningIssueHistory` 中，在途或未核对的请求会暂停后续派发。省略 `automatic` 可重试已结束的生成失败。
- `{action:"answer_planning_issue",issueId,answers:{"Q-001":"答复"},continue:false}` 保存逐题草稿，每题最多4000字符。`continue:true` 保存完整一轮并重新整理同一运行，清除失效审批。下一轮仅保留这轮仍待明确的原题。重复提交仍含糊的补答会返回400并保留输入，且不请求模型。旧客户端仍可通过 `answer` 提交单文本回答。
- `canRebuild:true` 的旧运行可用 `answers:{},continue:true` 重新整理，无需填写已过时的问题。引用失败用现有 `retry` 动作重跑规格。原输入和历轮答复保留，重整后仍须人工确认规格。

规格适配器取得受控signal/timeoutMs/onReceipt。正常stop、私有回执持久化、与返回规格按现有解析规则等价、当前source/run和最后保存都确认后才能发布规格；保存失败恢复原规格与文档，不发布审批。完整回执仅保存在私有目录，API 的失败诊断最多提供当前出错条目的有限摘录。导出plan.json不携带调用历史或私有路径。失败回执也可保留已知用量，安全回执缺失时保持未知。

本地适配器Promise结束不表示远端模型服务已确认停止。不合作provider或回执写入被标记unconfirmed，超时/关闭可有界结束阶段；同控制器真实在途任务settle前，项目检查点、新建和重试均拒绝。重启保留中断及未知历史，不自动重跑或声称远端已停。这不代表跨阶段共享费用预算或可靠外部Worker恢复。

### 同项目需求输入版本

基础路径`/api/projects/:pid/changes`要求本机回环、匹配监听端口的Host及同源变更请求。源文件、规划绑定和应用权限均由服务读取；客户端不能传工作区、执行报告、回调或审批状态。

- GET基础路径：`{current:{revision,generation,source},versions,changes,capabilities:{canApply,reason?}}`。旧项目视为第0代；读取异步变更列表后再读取当前已发布输入。canApply表示已配置双服务检查点，具体是否空闲仍由应用时检查，不保证立即可用。
- POST基础路径精确接受`{baseRevision,source:{filename,content},reason,kind,requestKey}`，返回201`{change}`。请求只保存待应用记录，不修改当前需求、不启动模型或新run。同一requestKey与正文幂等，改变正文复用键返回409。每项目最多20请求、最多20输入版本（含第0代）。
- POST`/parse`精确接受`{filename,content}`或`{filename,fileBase64}`，返回200`{source}`。使用与新建项目相同的MD/TXT/标准DOCX正文解析；只返回候选文本，不保存请求或应用新版本。
- POST`/:changeId/apply`精确接受`{baseRevision,generation}`，返回200`{change}`。规划项目检查点包裹执行服务项目检查点，核对所有run的活动、未知停止、预览及在途动作后，才发布新输入。检查点忙返回409并保留pending；协调能力缺失也只允许保存，不发布。

Change含`id/projectId/status/baseRevision/generation/sourceRevision/source/reason/kind/draft/appliedDraft/appliedGeneration`及时间与错误字段。状态为pending、applying、applied或apply_interrupted；503不意味着应用未发生，不能自动重放。差异与影响是结构化原文比较及conservative_all保守失效：新审批必须重新取得，旧测试不可复用，代码复用尚未判定；requiresMigrationReview仅表示需要迁移审查，未执行数据库迁移。

项目JSON保存currentSourceRevision/sourceGeneration/sourceVersions/appliedChangeId，作为输入发布的权威事实；变化请求另存`data/source-changes/changes.sqlite`。应用依次写入SQLite意图、发布完整JSON、确认SQLite。重启只依据完全匹配的JSON代次/hash/changeId核对结果，不自动重演发布。这是可核对的单控制器协议，不能称为跨存储事务。

应用后历史run保留原sourceSnapshot与审批，标记sourceSuperseded并拒绝继续、修改和确认；新run绑定新sourceGeneration与sourceRevision，重新生成和确认规格/计划。旧源执行的完成权限、复试/复验、预览和下载同时失效；实际停止操作仍允许。旧版本归档文档可作为历史下载，不能当作新需求已交付。

创建新run时可省略或传`inheritFromRunId`。省略时，若项目有多代输入且上一代存在带已回答问题/答复的运行，自动继承该运行；显式编号必须是本项目、上一输入版本的运行，未知或非上一版返回404/409。控制器把先前`specQuestions`答复和`clarificationHistory`答复去重后写成`kind:"inherited"`轮次，附带`inheritedFrom{runId,sourceRevision,specRevision,at,answerCount}`；这些回答参与新run的模型输入、引用白名单和规格来源，但不携带旧审批、任务、计划或验收。若新规格重复同一问题文本，`prepareSpec`会预填继承答案并标记`inherited`，同时更新`spec.clarifications`和`specRevision`；模板措辞不同的问题仍按新问题处理。新版正文优先，冲突须用户修改。`plan.json`包含`inheritedFrom`。旧`sourceSuperseded`运行仍只读。此机制只复用用户已提供的答案，不代表旧规格/代码可复用，保守影响分析不变。

网页保存草稿与幂等键；应用必须由后端GET确认同change、当前revision和代次后才显示完成。页面观察到其他请求应用新输入时，重新读取项目及历史run权限。需求正文、差异与模型文本只作为文本展示。

网页“新增功能”表单将名称、说明和验收条件追加到本地需求草稿，复用上述创建变更与应用接口，不新增直接执行模型的端点。步骤、应用和“重新规划”入口绑定本次所选变更与完整草稿，未保存功能及其他历史记录不能替代本次确认。后端确认当前版本后，用户点击“重新规划”才通过已有创建run接口启动；前端再次核对项目、sourceRevision与generation，规划仍执行原预算和双确认。任务图编辑同样沿用`revise_plan`，本地差异预览不授予保存或执行权限。

`revise_plan` 同时接受当前 `awaiting_review` 计划和已确认的 `succeeded` 计划。后者保存前检查开发、验收定义、预览和在途状态，冲突返回409。保存成功后将原计划与审批存为历史，作废当前计划确认，重新执行覆盖与依赖检查。旧验收定义和执行结果仍绑定原计划，新计划另行确认。

创建run可选提交`expectedSourceRevision`（64位小写十六进制）和`expectedSourceGeneration`（非负安全整数），必须成对提供，缺失或非法返回400。控制器在项目准入互斥的同步区内比较当前需求双版本；任一不符返回409，尚未创建运行、保存或调用模型。同正文hash但generation已改变也拒绝。网页创建和重新规划均附带用户所见双版本，消除按钮核对与请求处理之间的发布竞争；旧API调用不传两字段时维持原兼容行为。

### 独立编码试验的内部接口

规划驱动执行的可信内部task资料包含`requirements:[{id,text}]`，text由当前确认规格的标题、正文和完整验收组合，与版本、任务和工程契约共同传给整体、逐任务及持久Worker编码与Review。该字段来自服务核对的持久规划，不接受客户端替换或扩大权限。历史异常finish只作为完整响应、确认停止、原始回执/用量及版本可核对的历史账；实际应用版本coding和当前候选Review仍必须stop。未知远端状态、缺失或不一致回执不因此获得交付资格。

本轮不新增 HTTP 路由，规划 Run、DevTask 和现有成功状态含义保持不变。命令入口为 `npm run execution:check -- --fixture|--model`。

`startTaskExecution({outputDir, provider, sandbox, reviewer?, reviewerKind?, providerKind?, signal?, maxCalls?, maxReviewCalls?, timeoutMs?, onEvent?})` 返回 `{id, cancel(), done}`，`done` 解析为持久化执行记录。该接口供平台可信代码调用，尚不接受网页上传任务或任意仓库。调用方不得把适配器注入接口直接暴露给客户端。

- 任务固定为 `library-borrow-v1`；模型只返回 `src/borrow.mjs` 的完整替换建议，不能设置命令、路径根、环境、验收和版本。
- 每次执行记录 taskId、attemptId、specRevision、planRevision、基础/候选提交、验证清单版本/用例及观察器哈希、平台源码标识/Node版本、每次候选检查、命令结果和用量。未知 token 数为 null。
- 状态为 preparing、checking_environment、generating、validating、awaiting_acceptance，以及终态 executed、accepted、failed、stopped、timed_out、reconciliation_required。accepted仅指固定任务的双结论门禁通过，不是完整软件交付。
- `cancel()` 幂等请求取消；候选进程是否停止依据适配器确认，无法确认时保持 reconciliation_required。
- 代码输出限制32KiB、各模型响应128KiB、进程输出64KiB；编码和Review各最多3次请求、总时长最多600秒。命令入口各默认2次、共180秒，单次候选执行最多15秒。调用按role/kind保存，共享总用量中任一实际请求无回执时为null；诊断调用不计入totalModelCalls。
- `execution.json` 与候选工作区在本地 output 中保留。进程意外中断后记录可能仍是运行状态，需要人工核对实际进程；本轮不提供后台恢复或多进程认领。

模型接口为 `createCodeModel({config?,fetchImpl?})` 返回的异步文件建议函数；沙箱接口为 `createWindowsSandbox({executable?,nodeExecutable?})` 的 `preflight` 和 `run`。生产入口预检失败关闭，不提供无保护执行选项。

### 同版本独立验收

命令入口默认启用双检查。`createReviewModel({config?,fetchImpl?})`返回独立Review函数，只接收`{task,files,previousIssues,signal}`，输出`{summary,issues,resolutions,model,usage}`；不传编码会话或测试结论。问题必须有blocking/advisory级别、当前文件行号及逐字代码证据；历史阻塞问题id必须逐项复验。响应无效不当作无问题。

`runCandidateAcceptance({rootDir,candidate,source,sandbox,reviewer,previousIssues?,assertCurrent,signal?,reviewKind?})`只供可信服务调用。`candidate`包含taskId、attemptId、specRevision、planRevision、candidateCommit、sourceHash；服务添加manifestHash、reviewPolicyHash、validationId并统一绑定两方记录。源码由执行器从Git对象读取并核对工作文件；测试与Review使用不同快照。固定测试入口不接受候选提供的命令、用例或passed标记。

门禁记录在`acceptance/validation-*/acceptance.json`；状态为checking、passed、diagnostic_passed、changes_requested、error、invalidated、cancelled、reconciliation_required。任何一方出错也等两方结束后再决定返工。passed须独立测试通过、Review完成且全部阻塞意见关闭；diagnostic_passed不能计为真实验收。检查前后核对原候选和两份快照，陈旧结果无效。每个新候选重新检查，不继承旧通过结果。

执行记录的versions[].acceptance保存完整结论及历史，acceptanceStatus保存最近门禁状态。`isTaskAccepted(record)`只接受当前候选、当前清单/Review规则、完整角色绑定且passed的记录；兼容self_check模式、诊断、旧版本和缺少结论均返回false。底层省略reviewer仅用于兼容自检，不开放任务完成状态。

### 现有规划记录

规格和原始需求在运行中冻结。再次运行创建新 run_id，重试保持同一运行且递增 attempt。输出归属当前运行；只有成功的阶段发布产物。服务重启时将中断运行转为 failed，用户可重试，无自动恢复承诺。配置 `.env` 在启动时读取，密钥只保存在服务端。

### 多文件Web执行、复验与源码交付

以下为可信内部组件及命令入口；网页固定参考执行路由见下一节，既有规划download继续是文档包。

- `startWebExecution({outputDir,binding,provider,reviewer,providerKind?,reviewerKind?,executable?,signal?,maxCalls?,maxReviewCalls?,timeoutMs?,onEvent?,assertCurrent?})`返回`{id,cancel,done,snapshot}`。任务固定为`library-web-v1`，调用方提供project/run/task及spec/plan版本；候选增加attempt、Git提交、sourceHash、HTTP/browser清单与Review策略哈希。CLI为`npm run web:check -- --model`，默认编码/Review各3次、共600秒。
- 允许最多60个、单文件128KiB、合计2MiB的文本源码文件，仅开放`src/public/migrations/tests/docs`及根README。package、lock、server、runtime和平台入口由控制器保护。模型不提交Shell命令、环境或验收结论。应用仅导出受保护worker约定的`createApp/handle`；候选仅在MXC内运行，不在宿主导入。
- 新候选先完成18项HTTP/SQLite自检，再并行运行全新独立HTTP/SQLite、21项Edge和Review。每次修复形成新Git提交并重检。`isWebTaskAccepted`统一检查当前身份、完整清单、数据库观察、正常进程停止和Review阻塞；fixture/diagnostic不能通过真实验收。
- 编码和Review适配器支持私有`onReceipt({model,finishReason,usage,content})`。回执在结构检查前保存并有大小限制；异常结束、凭据回显、存储失败不升级为有效建议。仅纯格式错误允许在原次数预算内纠正一次；未知用量保持null。Review接收平台生成的逐行编号，返回行号及逐字证据必须一致。
- `inspectWebRecheckSource({executionRoot,sourceReportPath,sourceBinding?,signal?})`只读核对可信根内原`web-execution-*`记录、模型回执、当前Git blob/HEAD/干净状态、源码及保护外壳。可信sourceBinding仅含projectId/runId/taskId/specRevision/planRevision，逐项匹配原记录；省略时保持CLI固定规格校验。它不代表审批，服务另查当前双确认。`startWebRecheck({...上述来源,outputDir?,reviewer,reviewerKind?,executable?,signal?,timeoutMs?,maxReviewCalls?,onEvent?,assertCurrent?})`只建同源新快照，不改原Git或原报告；默认输出至executionRoot，也可由可信服务指定另一个自有根。快照无伪造.git，provenance记录原报告hash、原提交/回执和来源绑定。编码调用0，模型用量只计本次新Review；全部检查重跑，最后仍调用同一完整门禁。命令默认为只读，付费模式须同时`--run --model-review`，不开放新来源绑定参数。详见[复验协议](tasks/web-recheck.md)。
- `createWebDelivery({files,binding,report,requirements,spec,plan})`只接受当前同版本完整通过结论，返回`{zip,manifest}`。包包含源码、保护外壳、需求/规格/计划及白名单验收摘要；排除数据库、真实.env、原始模型回执和私有日志。manifest逐文件哈希，不把归档历史声明当作新验收。
- `inspectWebArchive(bytes)`有界检查平台ZIP格式、路径、CRC、清单与当前保护外壳；不在宿主导入包内代码。`revalidateWebArchive({archiveFile,outputDir,executable?,signal?,timeoutMs?})`在新副本执行固定HTTP/SQLite与Edge，默认120秒、上限600秒。成功为`checks_passed/taskAccepted:false/historicalAcceptanceVerified:false`，表示本次检查通过，未获得新的模型Review。命令为`npm run web:verify -- --archive <路径>`。

停止请求与停止确认分开：源变化、预算耗尽或取消停止新阶段；未确认进程退出时保留PID和控制/预检目录，标为`reconciliation_required`。当前CLI仍无多Worker认领、后台恢复或任意需求执行承诺。

### 网页固定参考项目执行

入口为`/api/projects/:pid/runs/:rid/executions`。只允许实际回环连接、localhost/127.0.0.1/IPv6回环Host及当前监听端口，拒绝跨站访问与DNS重绑定Host；有Origin的更改还须与工作台同源。这是本机单用户边界，不是团队身份认证。

- GET基础路径 → `{capabilities:{canStart,profiles:[{id,title,description,contractRevision}],reason,model:{name},budget},executions:[ExecutionDTO]}`。模型名称不包含凭据，未知用量为null。
- POST基础路径`/start`，仅`{profileId,contractRevision}` → 202 `{execution}`。服务重新核对当前v2规格、计划、来源hash、双确认及结构检查，固定参考范围版本必须匹配；同一规划存在编码、预览或未确认停止时409。上传内容仅关联快照，不传给参考模型，不视为命令或完成范围。
- POST基础路径`/:eid/action` → `{execution,preview?}`。收费动作retry/recheck/repair必须提交`{action,profileId,contractRevision}`，匹配当前明确选择的参考范围；缺少400、过期409，旧页面不能按新契约自动收费。cancel/preview/stop_preview只接受`{action}`。cancel先记录请求，再等真实停止；retry使用当前审批新建编码尝试，不覆盖原历史。recheck仅复用服务自有、已正常停止的原始模型候选，创建0编码的新检查尝试，完整重跑HTTP/SQLite、浏览器及最多2次Review；旧验收规则的代码可以重检，旧通过结论不能继承。preview仅为当前已验收源码建立独立数据副本，有期限且占用活动槽；启动中停止保留实际PID及停止结果。
- GET基础路径`/:eid/download` → `application/zip`。重新核对当前规划、源码文件/Git对象/保护外壳及完整验收门禁后才创建交付包；不接受客户端路径、报告、预算或通过标记。

ExecutionDTO包含执行编号、尝试、范围、状态、是否通过、调用次数、用量/预算、版本/差异、事件、错误、预览及服务端actions许可。检查项只公开id/name/passed和净化后的可选error/expected/actual文本，每字段最多2000字符；不公开工作区路径、模型原始回执、PID/control/probe或进程stdout。Review问题含相对文件/行号与处理记录，全部作为文本展示。

复验DTO另有kind:web_recheck、来源服务执行编号/提交、recheckBudget和当前复验范围版本；actions.canRecheck仅为轻量按钮条件，实际动作在模型调用前深查原私有报告/真实Git/回执和当前归属。来源根、输出根和绑定只由服务私有记录派生，客户端不能传。预览/下载对复验快照另外重验来源provenance和全部文件字节，不以缺少.git放宽原始编码候选的Git校验。

repair用于当前失败候选具有有效、完整、同代码版本的阻塞Review时“保留代码并修复”。服务从自有记录派生原始编码来源和发现问题来源，深查原始Git/私有模型回执/源码hash/报告文件与SQLite记录及当前审批，拷贝源码与完整逐字行证据后，在独立工作区建立真实新Git基线。不得从客户端接收initialSource/previousIssues/来源路径/报告/预算。新记录kind仍为web_execution，私有operation为repair，DTO增加actions.canRepair、repairContractRevision、repairBudget、repairSourceExecutionId/repairSourceCommit及repairFindingExecutionId；这些公开编号不授予来源路径权限。

准入从建立行时计入总时长，核心只取得剩余预算；未知停止继续占用活动槽。新候选至少一次编码、源码hash及提交变化，原阻塞问题跨轮保留并明确逐项resolved，自检、独立HTTP/SQLite、真实Edge及Review共同通过后才能accepted。恢复到完整原seed、遗漏原问题、来源中途变化、版本失效均不能发布通过。当前用量只记新调用，原失败及成本不覆盖；下载/预览再查来源与当前候选完整性。

修复义务按同规划绑定、当前规则及相同源码hash聚合所有合法Review中的历史open blocking，不因选择较早的失败记录、同代码的新提交或之后的重审而删除。模型输入和发布条件包含全部这些问题，私有proof固定发现记录与原报告hash集合，每次模型调用及发布再次核对；新发现、报告改变、重复ID内容冲突或超过20问题/64记录边界都保守拒绝，不能截断问题。普通编码Review允许当前core的缺省kind，但必须有record.reviewerKind=model的实际来源；复验Review仍要求kind=model，诊断不能授权。

服务持久化在独立SQLite中，原规划JSON不迁移。owner与活动槽事务控制同run拒重；每次状态控制递增版本，异步结束重新核对，取消或待协调不能被迟到成功覆盖。`source_history`和`preview_history`私有保留正常及未知停止证据。旧双活存档迁移保留多个待协调历史而不撞唯一索引；未知进程不自动当作已停止，阻止新的活动。该单控制器生命周期不等于多Worker租约/可靠恢复，正式TaskStore及通用验收模型尚未接入此链路。

可信程序可`createApp({executionService?,executionRootDir?})`注入服务；`executionService:null`明确关闭网页执行。`startServer({loadEnv:false})`允许测试/嵌入宿主跳过本地.env读取，默认仍加载配置。这些选项不通过HTTP暴露。

### 独立HTTP测试提案（定义阶段）

基础路径为`/api/projects/:pid/runs/:rid/verification-plans`，采用与网页代码执行相同的回环Host/端口、实际连接及同源边界。身份只取URL；请求不能指定执行目录、通过结论、审批对象或模型回执。

`GET /:proposalId/repair-draft` 对普通结束、回执完整的失败模型提案返回 `diagnostic`，包含校验说明和缺少接口覆盖的需求编号、标题。`?edit=1` 对当前计划的负责人另外返回可编辑的解析后清单。服务端验证归属、文件类型、长度与哈希。`POST /:proposalId/repair-draft` 接受 `{contractRevision,proposal,feedback}`，在当前计划检查点内校验联合清单并保存为新的待审阅人工记录。原失败记录保留，修订与另存均不发模型请求，后续仍须单独认可。

可确定修复还覆盖仅关联已确认入口页 `/`、已有该页新浏览器会话中的有效断言、且未关联业务 API 的漏标需求。修复补入同源入口访问检查，保留浏览器断言及现有步骤和预期。工作台只对刚明确发起且当前仍可修改的提案自动保存待审阅草案。

对于现有草案中可判定的列表条目与总数定位冲突，`repair-draft` 也提供恢复。拆开检查位置之后保存新的待审阅记录。冲突尚未修复时批准返回 409，已经冻结的历史版不变。两种诊断均可在保留数据与原断言的情况下检查补出的步骤。

当前计划的失败草案可自动修复时，`diagnostic.suggestedRepair` 给出修复说明。负责人可向同一 `POST` 仅提交 `{contractRevision}`，由服务器从核验过的原回执补齐可确定的前置依赖，必要时移除无效的可选逐任务分组。原接口步骤、浏览器步骤和各项预期保持。同绑定同内容的待审阅清单可以复用。修复结果必须通过既有联合校验才会保存。

`GET /api/health`增加`verificationPlanning:{available,phase:'definition_only'}`能力声明。前端仅在明确可用时挂载及读取提案；旧后端缺少声明或内部禁用时保留其余工作区，不向不存在接口轮询。

| 方法与后缀 | 精确JSON正文 | 返回 |
| --- | --- | --- |
| GET基础路径 | 无 | 200，`{coverage, capabilities, proposals}` |
| POST `/propose` | `{contractRevision}` | 202，`{proposal}`；预算内生成一次新提案 |
| POST `/import` | `{contractRevision,proposal,feedback}` | 201，人工定义草稿；0模型请求，仍须单独认可 |
| POST `/:id/revise` | `{revision, proposal, feedback}` | 200，实际内容修订后的定义 |
| POST `/:id/approve` | `{revision, feedback}` | 200，只认可当前测试定义 |
| POST `/:id/reject` | `{revision, feedback}` | 200，保留被驳回版本及依据 |
| POST `/:id/cancel` | `{}` | 200，请求停止，不代表远端已确认停止 |

`capabilities`含`canPropose/contractRevision/model/reason/budget`，预算为`maxAttempts/remainingAttempts/timeoutMs`；默认每run最多3次、每次60秒。未配置模型、未完成当前双确认、工程草案不一致、预算耗尽或项目在途均禁止新提案。未知用量为null。HTTP不接受预算、配置或依赖注入。

新增`canImportDefinition/manualBudget/manualReason`；人工定义每run最多20份，保存不调用模型，不占用或退还模型预算。`origin:'manual'|'model'`区分来源，旧存档迁移默认为model；`attempt`是统一记录序号，模型预算仅计origin=model。人工定义model/finishReason/receipt为null，usage为明确的0/0、dispatched=false、receiptState=not_applicable；原失败模型记录与费用不改。导入须当前双确认和有效工程，通过同一DSL/覆盖校验、凭据检查、项目检查点及冻结门禁；未知请求仍阻断。人工导入不是已运行或已通过，不能绕过已驳回内容的认可限制；编码后定义不可替换。未配置测试模型仍可导入已有定义，但不授予编码配置或执行许可。

提案绑定project/run、sourceRevision/sourceGeneration、specRevision/planRevision、engineeringHash/contextHash/policyHash。模型仅接收确认规格、任务和工程接口投影，不接收候选代码及测试结论。服务校验HTTP DSL结构、需求覆盖和依赖；`coverage:'structural_only'`不证明断言业务充分。

记录含`id/status/revision/manifestHash/policyHash/binding/proposal/approval/history/current/approved/executed/actions`，另含尝试、模型、用量、回执状态及净化错误。认可为`approval.phase:'definition_only'`，始终`executed:false`；不编译DSL、不启动编码、不调用验收器，也不产生软件passed。驳回后必须改变定义，重新生成相同被驳回定义也不能绕过。修订、来源/规格/计划/规则变化会撤销当前许可；旧记录保留且动作关闭。

定义与私有回执分别存于`data/verification-planning/verification.sqlite`及`receipts/`。记录的回执字段仅提供hash/字节数，原始模型回包和路径保留在服务端；规划JSON、文档和ZIP不嵌入提案或私有回执。恢复时活动或未知请求保留`reconciliation_required`，不推断远端结束。请求已派发且未收到完整回执时，取消/超时即使使本地HTTP Promise结束，也保留待协调活动槽；未派发的取消可以确认。当前没有自动核对远端或强行清除未知状态的接口。规划、代码执行、测试提案检查点共同保护需求发布；模拟活动沿用规划检查点拦截。项目删除也须通过提案检查点。保存待应用需求不受在途提案阻止。

`GET /api/health`新增`verificationPlanning:{available,phase:'definition_only'}`。前端只在服务明确声明支持后挂载并轮询提案；声明缺失或禁用时保留其他工作区，显示当前未开放，而不请求旧后端没有的接口。

可信内部可使用`createApp({verificationPlanningService?,verificationPlanningRootDir?})`注入；null禁用提案接口。不能确认提案检查点时禁止需求发布或项目删除，不降级绕过。服务初始化失败与close均关闭已创建的相关控制器；这些选项不通过HTTP暴露。
## 多角色 Agent 与 API 配置

网页 `/agent-settings.html` 编辑角色绑定，`/api-settings.html` 管理服务。两页分别读取同一份配置快照并提交整体版本，服务端以同一个 `revision` 拒绝跨页并发覆盖。

`GET /api/agent-settings` 返回 `{revision,providers,roles,roleDefinitions,environment}`。仅本机工作台可访问；启用团队账号后仅负责人可读写。`providers[]` 含 `id,name,baseUrl,model,hasKey,jsonMode,thinking`，不返回密钥。`roles` 使用 `spec,engineering,verification,coding,review` 五个角色，值为服务 id 或 `env`（沿用环境配置）。`environment` 仅含默认服务的公开配置。

`PUT /api/agent-settings` 接受整体 `{revision,providers,roles}`，成功返回新的脱敏视图。每个服务含 `id,name,baseUrl,model,jsonMode,thinking`，可另传 `apiKey` 与 `clearKey`。密钥省略或空白保留已有值；`clearKey:true` 显式清除。本机地址可无密钥，远程服务须有密钥。已绑定服务不能被删除。`revision` 过期返回 409，字段、地址、绑定或凭据无效返回 400，跨源或非本机请求拒绝。保存配置不请求外部模型。

支持的协议为 Chat Completions，`baseUrl` 不含 `/chat/completions`，不得带账号、密码、查询或片段。`jsonMode` 为布尔值；`thinking` 为 `enabled`、`disabled` 或空白（不发送该扩展）。每个角色的新调用使用当前服务配置；开发执行在 admission 固定编码与 Review 两份配置，通过匿名 stdin 交接 Worker，不进入环境变量或公开 DTO。Worker 的配置版本同时绑定两角色公开设置，旧作业不能改模型后直接恢复。规格及工程请求逐次取快照，不宣称跨多次人工确认锁定整条规划的同一服务。

私有 `DATA_DIR/agent-settings/agent-settings.json` 保存配置，密钥由同目录本机私有密钥加密；两者需一同保留以重启回读，不进入源码与规划交付包。此功能不改变软件验收结果，不提供任意新角色执行器或公网部署。
