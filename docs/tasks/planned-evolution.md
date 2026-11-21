# F05：新需求版本对旧源码与已有 SQLite 数据的演进草稿

日期：2026-11-18。状态：**完整演进仍为设计，底层三模块已独立实现但未接入产品**。最初只新增本文及本地 `output/full-goal-20261118/planned-evolution-design/` 草稿；后续按根 Agent 明确授权新增 migration contract、dataset、固定 worker 三文件，作者证据见文末。没有修改 191 个冻结入口或新增默认测试/导入入口，没有本子任务模型调用。根 Agent 正在开发的 `planned-preview` 由其单独负责，本文不改该模块。

## 本轮可验证目标

给出可直接拆成实现任务的最小合同：同项目保存并应用新需求，重新确认规格、计划和联合验收；从已核对的旧源码与已登记旧数据库副本开始，生成新代码、迁移副本，独立检查新旧行为，最后形成新版本代码与数据成对的交付证据。旧需求、代码、数据库快照、Review 原始意见和费用历史全部保留。

首版支持范围限定为：平台管理的单机项目、受控运行器、单个 SQLite 数据集、停写后离线副本、顺序演进。数据迁移只支持本文列出的有界操作；无法证明兼容、来源或停止时拒绝准入，不用空数据库代替旧数据，不自动降低验收。

本轮没有实现上述能力。原 1096 项全量、v3 受影响 40 项及 v4 修复矩阵 11 项均属于各自历史冻结版本，不是本功能证据。

## 已核对的当前连接点和缺口

| 当前实现 | 可以复用的事实 | 需要新增或保持的边界 |
| --- | --- | --- |
| `source-change-service` / `requirement-changes` | pending→共同安全检查点→新 sourceRevision/generation；旧运行只读；保守全影响 | 目前只发布需求输入，不改目标代码、迁移数据库；同 hash 的新 generation 也必须重新准入 |
| `planned-source` | 真实 Git、原始回执、完整失败调用、来源链及所有历史 blocking 的只读核对 | `assertPlannedSource` 锁同 project/spec/plan，不能把新 run 冒充旧绑定；跨版必须另建能力，不放宽原函数 |
| `planned-web-executor` | 原预算、精确文件范围、固定提交、自检/独立 HTTP/Edge/Review、修复和全部调用 | 现有 initialSource 是同版修复；没有跨版 seed 或旧数据输入/迁移证据 |
| `planned-task-executor` / `planned-task-base` | 真实任务认领、独立 Git、合并及全图最终验收 | 当前图从空 seed 起步；新增跨版 seed 时不能把任何旧任务直接改为 completed |
| `planned-execution-service` | 当前 source/spec/plan/engineering/definition 绑定、项目活动槽、冻结预算、取消和来源修复 | repair 只允许 current 同规划；新演进是独立操作，不能借 repair 绕过新确认 |
| `planned-checkpoint` / `planned-delivery` | 私有 HMAC、同版本完整图/成本封存、恢复交付 | 不签旧通过给新版本；新封签还须覆盖演进来源、迁移及数据验收，不把数据塞进普通源码 ZIP |
| `web-runtime` / worker | 数据库固定为受控工作区 `.platform/tmp/app.sqlite`，候选源码只读 | 该路径是每个运行副本的数据库，不是全局业务数据源；不能从模型/HTTP 接受宿主数据库路径 |
| `http-scenarios` / `browser-scenarios` | 现有检查运行在独立源码快照 | 当前默认从空库开始；必须新增可信旧数据 seed，各检查各用新副本，不能顺序共享已被前一检查改坏的库 |
| `planned-preview`（正在另行开发） | 设计为独立演示副本、有限时长、真实停止和共同活动槽 | 当前演示预览没有正式业务数据集权威；预览库不能自动变成“用户已有数据” |

依据为 PRD 第四节变更协议及三类变更验收、F05/F08/F09/F10/F11、DESIGN 同版本测试/Review、现有 API 的 source 双版本和跨存储发布协议。规划 JSON 与多个 SQLite 的现有组合不能称为分布式事务。

## 最小可信对象

所有内容 hash 使用确定性纯数据编码；ID 是服务生成的不透明编号。前端只提交其见过的版本和已选择的 ID，不提供路径、SQL、密钥、进程、passed、旧审批或能力对象。

1. `OriginRef`：`projectId, baseRunId, baseExecutionId, sourceRevision, sourceGeneration, specRevision, planRevision, candidateCommit, sourceHash, reportHash, receiptSetHash, historicalPolicyHash, graphHash?`。服务从自己的库与旧运行读取，核对旧 Git/原始回执/完整图/费用；历史签名仅证明来源，**不授予当前验收或下载通过**。
2. `TargetBinding`：`projectId, runId, sourceRevision, sourceGeneration, specRevision, planRevision, engineeringHash, contextHash, proposalId, definitionRevision, manifestHash, taskSetHash?, executorPolicyHash`。必须是当前新输入且规格、计划和联合定义分别已确认。
3. `DatasetSnapshotRef`：`datasetId, snapshotId, dataGeneration, originCommit, schemaHash, databaseHash, bytes, snapshotPolicyHash, createdAt, stopEvidenceHash, backupReceiptHash`。只由数据集服务在确认停写后创建；路径及私有备份不出 API/模型/源码包。
4. `EvolutionPlan`：`version:1, id, revision, changeId, origin, target, snapshotRef, impact, retainedPaths, writePathsByTask, migration, regressionManifestHash, blockerSetHash, budgetContractRevision`。impact 首版为 `conservative_all`、`reuseCode:true`、`reuseValidation:false`。retainedPaths 明确保留旧文件；写权限只取新确认任务，不以旧权限补大新范围。首版不支持删旧文件，遇到删除/改名须先返回 unsupported 供重新设计。
5. `EvolutionSeed`：进程内私有能力，绑定 origin+target+evolutionRevision；只提供已核对代码、只读迁移前快照引用、来源/费用/阻塞索引。普通 JSON、复制对象或旧 source handle 不能创建它。它不含 accepted 标记。
6. `MigrationReceipt`：`evolutionId, attemptId, candidateCommit, inputSnapshotHash, migrationRevision, operationsHash, policyHash, outputDatabaseHash, outputSchemaHash, integrityResult, rowInvariantHash, processes, terminationConfirmed`。控制器写入并核对原始受控 worker 结果，不接受候选自述。
7. `EvolutionAcceptance`：绑定上述对象、当前代码/定义/Review、每个独立数据副本的迁移结果、权限/流程/完整回归、所有旧 blocking 的新处置、当前新调用及历史费用引用。只由真实门禁生成，未完整通过不封签。

`receiptSetHash` 覆盖失败、格式重提、Review 和祖先调用，不能只取产生版本的那一次。历史用量和本轮新增用量分别列出，不能重复相加收费，也不能通过换版清零项目账本。任一未知用量保持 null；金额缺单价仍未知。

### 跨版来源准入

新增 `inspectPlannedEvolutionSeed({originRef,targetBinding,evolutionPlan,sourceResolver,datasetResolver,assertCurrent,signal})` 内部入口。sourceResolver 先按旧真实绑定调用原只读来源核对，再核对新计划明确允许保留的路径；新目标绑定通过另一个 WeakMap 能力关联，不能把旧 provenance 的 spec/plan 改写成新值。

旧 source 断言、同版 repair、旧历史封签均保持原义。重启后重新核对旧原文/报告/回执/Git、私有意图和快照，重新创建 source-only seed；不能反序列化能力或事后给旧记录补签。缺少可信旧数据来源时仅能说明“代码可复用、数据来源不可用”，不得自动降级为无数据的演进成功。

首版数据演进来源要求代码提交与数据集 `originCommit` 精确一致，且属于同项目最后登记的可用业务版本。失败代码可继续走同版 repair，但不得混用另一个候选的数据来声称跨版迁移完成。

## 数据集、迁移与回滚

### 明确数据的权威

新增独立 `planned-dataset` 服务。数据集仅由控制器管理的业务运行实例登记；登记保存源码来源、创建/最后停止证据和 dataGeneration。用户从下载 ZIP 外部启动的任意数据库、任意宿主路径、预览临时库或测试库不自动登记。当前尚无此能力；本验收须先用专用临时 V0 业务实例建立真实 SQLite 数据再登记，不能读取现有用户 data/ 作试验。

每次预览/正式本机运行须明确 `demo` 或 `owned_dataset`。demo 不写入权威数据；owned_dataset 才更新数据集代次，且在停止核对完成前不能取快照或迁移。运行异常、未知 PID、外部仍持有数据库或重启丢失句柄时进入 reconciliation_required，不猜测停止、不在线复制单个 SQLite 文件。

停写后由固定受控备份 worker 获得一致性副本，处理 WAL/附属状态，校验完整性和数据库/schema 指纹，再存只读基线快照与至少一份可恢复备份。备份路径不能来自模型；备份/文件副本的具体实现需真实原生负例验收，本文不将普通 copyFile 宣传为 SQLite 在线备份。

### 首版有界迁移合同

迁移描述与 HTTP/浏览器 DSL 分离，不修改既有 DSL 含义。描述是待审数据，确认后冻结到 migrationRevision；模型不能直接提供任意宿主 SQL/JS 命令。新增固定迁移 worker 只对**独立可写副本**执行平台编译的以下操作：

- `addColumn`：受约束普通表/列标识符，TEXT 或 INTEGER，固定 nullability 与有界默认文字/整数；先检查旧 schema/列是否存在，默认值和旧行回填必须可验证。
- `mapValues`：对声明的普通表/列按完整旧值→新值映射执行绑定参数更新；未知旧值拒绝，保留主键/行数及其他列。受既有 CHECK/索引等限制而无法安全执行时拒绝，不自动重建表。
- `none`：权限或业务规则只改代码时仍以真实旧数据执行全部回归，不跳过数据校验。

首版不支持 DROP/重命名/任意表重建、任意 SQL、附加数据库、扩展加载、虚拟表、外部路径或用户自定义函数。复杂迁移返回 `unsupported_migration`，需要下一份经过审阅的实现合同。所有 schema 修改/值映射由平台拥有的单连接事务执行；错误回滚该副本。迁移工单保存在私有状态库；候选能写业务库，因此库内迁移记录只作兼容信息，不能单独授予完成或幂等权限。

迁移 worker 的最小权限为只读当前固定源码/描述、可写当前数据库副本，无网络、无主库/备份写权限。候选启动前完成迁移；之后应用仍在原 MXC runtime 运行，平台不把生成迁移脚本加载到宿主。

自检、独立 HTTP、Edge、重启与回滚检查各从同一个冻结快照取得新副本，独立执行同迁移并比对 receipt。不能让自检对数据库的写入成为独立检查的初始条件。失败/修复新代码使用新的副本重新迁移，不在坏副本上继续叠改。

### 发布与回滚的准确含义

新代码通过并不自动替换原数据库或发布应用。首版新增显式本机激活：在同项目检查点核对目标完整验收、原 dataGeneration/hash 未变、全部运行已确认停止，预先落盘并校验不可变代码/数据对象后，以**单一私有 SQLite 事务**切换 `{releaseId,candidateCommit,datasetId,dataGeneration}` 指针。激活使用从原冻结快照重新迁移并核对 receipt 的全新候选数据副本，不能提升被测试或预览写入过的库。运行实例只通过此指针取成对版本；不声称跨多个库/文件系统原子提交。崩溃落在意图或启动边界时先核对指针与文件，未知状态不自动重放。

失败迁移/验收从未覆盖原主库，原代码+原库可恢复使用；原失败副本和日志保留。激活后尚无新增业务写入时，可由负责人明确请求回滚到已备份的旧代码+旧数据库对，并记录一次新的发布代次。不能仅切旧代码去读已迁移新库。回滚运行标明历史业务版本，不把旧通过赋给当前新需求。

激活后有新增业务数据时，默认拒绝自动恢复旧快照，避免丢失新数据。须另做新库备份、明确的反向/补偿迁移和人工决策；首版不承诺无损回滚。公网部署、跨机数据库迁移和生产恢复均不在本地演进动作内。

## 服务、接口与状态

优先复用现有双确认、冻结联合定义、研发服务和共同检查点；仅迁移描述增加精确额外确认，避免另造大型替代编排。下列 evolution 记录/路由为未来整合合同，不要求先实现一整套独立审批或服务。底层 dataset 只保存数据操作意图，未来必须通过当前服务的共同活动槽参与 source apply/delete，不能成为绕过检查点的平行入口。

拟议路径 `/api/projects/:pid/runs/:rid/evolutions`，pid/rid 为目标新运行：

| 操作 | 精确请求体（不含路径中的身份） | 行为 |
| --- | --- | --- |
| GET 基础路径 | 无 | 列出草案、来源摘要、能力与阻塞原因；不返回数据库内容/私有路径 |
| POST 基础路径 | `{baseRunId,baseExecutionId,datasetId,changeId,proposalId,definitionRevision,expectedSourceRevision,expectedSourceGeneration,requestKey,reason}` | 免费准备草案；同键同内容幂等，不同内容 409；所有关联从本项目私有记录解析 |
| POST `/:id/revise` | `{revision,migration,feedback}` | 负责人修改有界迁移描述；生成新 revision，旧确认失效 |
| POST `/:id/approve` 或 `/reject` | `{revision,feedback}` | 只确认/驳回精确迁移操作及其绑定；普通规格/计划/联合定义仍复用现有确认；驳回须实质修订 |
| POST `/:id/start` | `{revision,contractRevision}` | 负责人明确同意已展示预算；当前三确认及演进确认、快照和活动槽原子复核后预留，再实际执行 |
| POST `/:id/cancel` | `{}` | 负责人请求停止；unknown 不释放槽或预算，不自动重发 |
| POST `/:id/activate` | `{revision,releaseRevision,expectedDataGeneration}` | 负责人在已验收对上执行本机指针切换；不部署公网 |
| POST `/:id/rollback` | `{releaseRevision,expectedDataGeneration,reason}` | 负责人请求受限成对回滚；有新写入/不兼容时 409，不隐式删数据 |

400：结构/额外字段/类型错误；401/403：身份或角色；404：本项目不存在的 ID（不泄露他项目）；409：旧代次、未确认、忙、来源/快照变动、不兼容或预算不足；503：控制器停止/归属丢失。所有昂贵动作在发请求前失败时记录真实 0 发送；502/超时不能暗示远端已停。POST 返回 accepted 状态只表示请求已接收，不能代表软件验收完成。

团队模式延续 owner 可开发/变更，reviewer 只可 approve/reject，observer 只读；新路由必须显式加 reviewer 许可，不能因为请求叫 approve 就越权。单人模式保留本机 Host/端口/Origin 规则。异步解析后、外部调用前及发布前重新检查会话/角色和目标绑定，避免角色已撤销仍执行。操作审计只记 ID/hash/结果，不记密钥或业务库正文。

状态建议：`draft → awaiting_review → approved → reserved → preparing_seed → migrating → validating → accepted → activation_requested → active`；失败分为 `failed/cancel_requested/stopped/reconciliation_required`，回滚为 `rollback_requested/rolled_back/rollback_blocked`。accepted 是新目标完整门禁结果，active 是已切本机指针，两者不能混同。恢复只恢复可核对的已结束证据；在途迁移/Worker 不自动续跑。

每次结果发布比较 `{projectId,targetRunId,sourceRevision,sourceGeneration,specRevision,planRevision,definitionRevision,evolutionRevision,controlGeneration,attemptId,leaseGeneration?,inputSnapshotHash}`。A→B→A 同正文也拒绝旧 generation；旧 Worker 可以保留完成历史，但无法写新任务、封签、激活或结算第二次。模型、文件操作、验收和发布都有当前许可复核，事件只追加。

## 编码链路与一次完整实现的写入责任

1. 原 source apply 仍只发布新输入；旧 run 原文/审批/结果不变且撤权。新 run 重新生成规格/计划/联合定义，不自动确认。
2. evolution prepare 在共同检查点解析旧来源/登记数据，保守影响全任务并生成原始新旧差异、代码复用/测试重跑决定；不收费、不启动代码。
3. 新计划必须覆盖所有将保留的旧文件，并给写入/只读范围；无法映射则阻塞。旧 blocking 全部进入新 Review；需求确实删除导致旧义务不适用时另做绑定新规格的人工处置记录，不改旧 Review，不直接把当前检查设 passed。首版不自动消除此类冲突；超过现有 20 项完整复验上限则拒绝，不截断。
4. start 冻结新预算、数据和完整元数据，创建独立无硬链接 Git 工作区。单项目整体路径新增 evolutionSeed；原 initialSource 同版修复不变。模型只看旧源码、公开 schema/最小脱敏迁移事实和新要求，不看原始业务数据/备份/凭据。
5. 多任务图须在 `planned-task-base`/executor 正式接入新绑定 seed：所有任务 pending，依新范围编码、真实合并；不能自动把旧图任务标完成或从空 seed 丢掉旧模块。数据库迁移写入由唯一任务负责，最终完整集成才决定新数据兼容。未实现该适配器前，对 taskScopes 多任务演进返回明确 unsupported，不静默退回全项目或绕过分组。
6. 固定新候选后，各检查副本从冻结旧数据迁移，跑新增行为+权限/状态/持久化/全局回归，独立 Review 关闭全部当前 blocking。原格式重提、费用及历史意见照常保留。
7. 新检查点 payload 加 evolution/快照/迁移/回归/整个图/全费用索引 hash。没有新原始通过不能签。普通源码包只含代码、迁移描述及验证摘要，数据库/私有快照留本地；源包干净启动与已有数据兼容是两组证据，均需报告。

冻结解除后的拟议写入范围及唯一责任：

| 范围 | 负责人/整合顺序 | 必要连接 |
| --- | --- | --- |
| 新 `lib/planned-evolution.mjs`、`planned-dataset.mjs`、固定 migration worker | F05 单一作者 | 先纯合同/来源/快照与状态，再受控数据迁移；不写主用户数据 |
| `planned-source` 新跨版核对入口、core 新 seed 与数据 receipt | core/source 同一作者串行 | 原同版 guard 保留；policy hash 纳入新增执行器；每次候选重验 |
| `planned-task-base`/task executor | F06 writer 或串行集成人 | 后续新 seed，不与 F06 writer 同时改共享入口；未接前 fail closed |
| HTTP/Edge 验收器与 runtime 的可信 dataset seed | 独立验证 writer | seed 不能从 HTTP/候选自行注入，独立副本及迁移失败判据归验证服务 |
| planned service/checkpoint/delivery/server/team routes | root 串行集成 | 共用活动槽、权限、费用与新封签；与当前 preview writer 协商同一检查点接口 |
| 前端 source/planned panels、API/STATUS/VERIFICATION | 集成通过后 root | 后端真状态、费用、新旧数据与回滚边界；不提前展示已实现 |

当前阶段 191 个冻结入口禁止本作者修改；仅新 `planned-migration-contract`、`planned-dataset`、固定 worker 已获授权独立实现。未来正式接线仍须 root 解除相应冻结并串行整合。新增正式测试前先固定候选/独立检查，同版本修复后再验；只有新失败、接口变化或风险才扩大回归，不能复制旧数量。

## 固定业务验收样例与失败终点

本地草稿 `output/full-goal-20261118/planned-evolution-design/acceptance-fixtures.json` 不是现行 DSL、测试通过或可执行导入。基准为小型项目事项系统，先真实运行 V0 写入 SQLite 并正常停机快照，再依次经历三次新需求；不从空库验证三次变更。

| 版本 | 变更与旧数据 | 必过正例/回归 | 必过拒绝/回滚 |
| --- | --- | --- | --- |
| V0 | 用户 admin、alice(editor)、bob(editor)、reader；3 事项固定 id/owner/title，状态 draft/active/closed，原审计 3 条 | HTTP 建数据、重启、SQLite 实值和桌面/390px核对，记录代码+库+schema 指纹 | 库来源/停止/封签不完整先阻塞，不做迁移 |
| V1 field | 新增 priority INTEGER NOT NULL DEFAULT 0，范围 0..2；界面显示编辑；原 3 行回填 0 | 旧 id/owner/title/status/审计不变；改 priority 后重启保持；两独立副本从同旧快照得到同 schema/初始值 | -1/3/字符串拒绝且原值不变；迁移失败/重跑不能部分加列；旧代码+旧库可恢复 |
| V2 permission | editor 从可改全部变为只能改本人；admin 仍可改全部，reader 只读；已有用户/事项不丢 | alice 改自己的事项成功；admin 改任意事项成功；已有会话按当前服务规则重新判权 | alice 改 bob 返回403且数据/审计不产生成功记录；reader写403；伪造角色字段不能升级；旧 cookie 不保留已撤权限 |
| V3 workflow | active→approved，draft/closed 原值保留；新增 submitted；新流程 draft→submitted→approved→closed，审批仅admin | 原 active 行变 approved，主键/其他字段/原审计保留；owner提交、admin审批、重启后状态正确 | draft直接closed为409，editor审批403，closed重开409；未知旧状态拒迁移；激活后有新写入则自动旧快照回滚409 |

每步重新确认需求/规格/计划/联合定义/演进合同，重新固定候选和完整测试/Review。新源输入代次、文件/回执/库字节、快照、迁移描述、角色或租约在检查期间变动必须撤权；迟到旧结果不能签新版本。停止未知、迁移异常、完整性/行不变量不符、权限/非法状态未通过或任一 blocking 未关闭均为明确失败终点。

上线验收还须覆盖：备份 WAL/崩溃/不重复迁移、重启意图核对、重复 start/activate/rollback 幂等、晚到回调、项目删除/输入应用共同忙状态、角色撤销、外来 ID/路径/能力伪造、全部失败调用/历史 Review 不遗漏、干净源码包及受限回滚。模拟模型与真实 HTTP/SQLite/Edge 的证据分开；真正收费业务验收另按已授权范围推进。

## 当前无法安全承诺的边界

- 不支持任意外部生产数据库导入、多个数据源的事务、在线迁移、跨租户/跨机发布或在途外部 Worker 可靠恢复。
- 不声称能自动精确判断不受影响任务；首版全重验，复用的是代码与已备份数据，不复用旧通过。
- 不自动删除/重命名文件、重建任意表或丢弃数据，不把数据库文件复制成功当业务迁移完成。
- 不承诺有新写入后的无损回滚；没有一致性快照、迁移验证器和真正业务回归前不开放激活。
- 单账户管理员可完整复制私钥/状态库、整库回滚或恶意宿主不在现有 HMAC 防护范围；不能把封签宣传成硬件信任或跨主机防重放。

下一项可独立验收的实现目标：在隔离临时 V0 数据集上完成“封存来源 → V1 新字段与 UI → 真实旧库副本迁移 → 独立 HTTP/SQLite/Edge/Review → 旧库保持原样 → 成对回滚拒绝/恢复”一条纵向链路，再按同合同验证 V2/V3。未解除冻结前不开始正式连接。

## 独立底层模块作者交接（尚未集成）

新增 `lib/planned-migration-contract.mjs`：纯 typed plan 规范化，控制器 approve/revoke、私有 compile/assert；普通 JSON、复制能力、旧 generation、撤销确认不能执行。只支持 addColumn/mapValues/none，默认值是数据而非 SQL，主键映射在 worker 拒绝。

新增 `lib/planned-dataset.mjs`：`createPlannedDatasetService({rootDir,sourceRootDir,executable,authorizeStoppedDataset})`。可信 resolver 根据内部 runtimeRef 提供 owned_dataset、旧代码来源、dataGeneration、真实停止证据及同步当前门禁；调用方不能直接交 workspace/stop JSON。提供 registerStoppedDataset、snapshot/readSnapshot、migrate/readResult、inspect/inspectIntents、hasActivity、close；signal 是内部第二 options 参数。业务库只读暂存后交固定 MXC worker 做一致备份/检查/事务迁移，原库保持不变；工单先持久化，未知停止保留活动。元数据 SQLite 仅管理私有状态，不在宿主加载候选数据库或模型 SQL。

新增 `lib/planned-migration-worker.cjs`：固定 worker，普通表/列、有界数据、完整性/外键检查、schema/每表行集合 hash；原生 SQLite backup、受控事务 ALTER 与一次性 CASE 映射。未知旧值会回滚之前 DDL；拒绝主键重写、视图/触发器/虚拟表等当前不支持对象。输出 receipt，不输出原始业务行。

作者最终仅运行 `output/planned-evolution-author/migration.test.mjs`：Node22.21、真实 MXC 应用创建已有 SQLite、正常停止及真实 Git，之后固定隔离 worker 备份/加字段/映射/none/失败回滚；16/16、失败/取消/跳过0，6618.5473ms。回滚库由第二次独立 worker 核对旧 schema/rows，SQL 样式默认文字未执行，snapshot 篡改拒绝，工作结束后撤权拒绝发布，快照重开不重放意图。三脚本语法通过；完整作者证据与限制见本地 `output/planned-evolution-author/REPORT.md`。这不是非作者验收或本功能完整通过。

尚未连接：跨版本 source seed、现有双确认/联合定义、共享活动槽、真实数据注入 HTTP/Edge、UI 权限/流程三类业务回归、新交付封签/激活/成对回滚。数据 resolver 的原执行身份与权限由未来集成层从真实持有的运行/停止句柄证明，不能把任意数据库/演示记录当旧业务。快照持久化不承诺在途 worker 自动续跑。模块不在原 191 清单内，不能把根当前 native DAG 的通过结论计入这些新增文件。
