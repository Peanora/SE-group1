# 单控制器Web执行生命周期服务

## 自有代码与有效阻塞反馈修复（已实现及自测，待独立复验）

基准4df6c8d，新独立树web-owned-repair-service；正式复用独立FIX的F05 920+300（本树de5b227/d84f271）。唯一修改service/panel、两个对应测试及两个task记录，root维护HTTP精确收费allowlist和总API。新增action repair及“保留代码并修复”：当前同project/run/source/spec/plan/profile的服务自有failed记录，必须有当前合法completed model Review blocking；支持failed recheck通过私有snapshot回到原coded source，格式无效Review只能原recheck。HTTP不能提供files、路径、报告、binding、issues或budget。

list只核私有元数据，深准入在任何编码调用前由原inspector重新核真实Git/回执/报告，Finding报告必须在所选私有row根且bytes hash/JSON与SQLite完全匹配；canonical Review validator对原files逐issue核行号/证据及unique blocking open ID。新row固定source/finding服务ID、原core报告ID和哈希、当前contract及问题快照，原报告与代码不改。费用确认绑定当前profile/contract和独立本轮最多3编码/3Review/600秒预算；deadline从row建立包含准入，core只取得remaining，沿既有取消、清理等待及unknown source_history。

core可信initialSource={files,sourceExecutionId,sourceCommit,sourceHash,sourceReportHash,reviewSourceExecutionId?,reviewSourceReportHash?}、previousIssues由服务私有proof导出。core建立新真实Git baseline，再让模型在原files和blocking反馈上修改；新commit/sourceHash都必须不同，当前完整检查及逐个旧issue resolution通过才可accepted。旧失败和旧用量保留，新row只计本轮。修复为普通web_execution/repairSource，当前候选用原Git gate复核，旧源的known blocking继续阻止旧commit发布，不阻止新代码。core固定且独立FIX前不调用真实API；本树仅明确trusteddeps fixtures与真实平台Edge界面测试，不能冒称业务修复已验收。

正式依赖core f6684e3（本树45fb2d0）已由不同作者独立FIX；服务通过可信startExecution初始seed能力连接，不增加客户端能力注入。自有失败原编码记录可直接repair，失败recheck通过私有sourceServiceExecutionId回原编码；同当前binding/profile/current contract、完整Review身份/策略/清单绑定及合法blocking才有light许可，深准入还重验Review原issues/resolutions及旧问题ID集合、原源码行和证据、两个报告JSON与私有record及字节hash。每个编码/Review前的assertCurrent、完成发布与已验收预览/下载都重核私有proof，未知停止保留source_history中的source/finding根、报告、PID/control/probe/result；迟到成功不能覆盖取消/新来源/协调。费用预算覆盖深准入、core以及发布核对，最终以新候选sourceHash/commit和carried issue闭合及既有完整gate为准。

DTO仅增加actions.canRepair、repairBudget、repairContractRevision及修复记录的operation、原编码/意见服务UUID和原commit；kind仍web_execution，原始报告hash、files、receipt和路径均不透传。F05批次撤权包含canRepair。收费repair和retry/recheck同样必须显式回传当前profileId/contractRevision；无字段、旧contract、额外client provenance/预算均拒绝。模型调用及旧用量不合并，普通retry仍为全新生成；无有效blocking的格式失败不显示repair。

只读核对指定真实原候选与新的failed recheck：原编码和意见报告均与SQLite私有record一致，policy当前，4个允许源码文件及1个blocking通过canonical逐字行号核对，source lineage一致。前后两份报告SHA/size/mtime全同，无原件写入、无API/MXC。该只读准入不代替新修复候选的业务验收。

本轮最终自测：显式`TASKFLOW_TEST_REAL_SANDBOX=1`及已验证执行程序，服务专项**73/73通过、0失败/跳过**（40449.9496ms），其中原薄负例仍使用真实executor/Git/MXC及fixture模型传输，实际失败自检、关闭交付、未知用量保留；新增repair正向/预览/下载为明确可信注入与fabricated receipts，不能称为真实业务修复验收。新增10项分组回归包含原coded/selected recheck lineage、种子反馈/独立用量、重复请求原子槽、私有report/path/binding/policy/issue与当前contract拒绝、新hash/commit及逐项resolution、旧blocking不洗掉、失败及迟到cancel/current、共享deadline、未知停止与有界drain、source_history隐私、发布/下载期间原报告改动、F05批次repair撤权。

真实系统Edge平台UI fixture**23/23通过**（22场景及父项，15208.3013ms），桌面/390×844、费用与预算/双确认/当前scope、失败保留、源范围说明、crossrun token及文本安全回归通过，两种新增截图已实际查看；`npm run check`为87脚本、`git diff --check`通过。最后只更新两任务记录，不再修改被测脚本。完整Review结构、gate/Review所有绑定字段和当前policy另对指定真实旧报告只读验证成功，hash/size/mtime仍同。未执行真实正向repair模型调用、未改原QA/用户data、server或公共API入口；固定后由不同作者复验再由root串行接HTTP和实际修复，无推送/部署。

## F05执行侧项目检查点（已实现及自测，待独立复验）

基准27072ea，独立tree/branch execution-project-checkpoint，唯一修改本记录、lib/web-execution-service.mjs和tests/web-execution-service.test.mjs。新增可信内部`withProjectCheckpoint(projectId, async work)`，返回callback结果并透传原异常；HTTP不暴露函数或此动作。获取时同步设置同项目barrier，查询该项目所有run的SQLite活动/待协调/非none预览以及同步登记的start/action/download在途请求，忙则409、不等待、不强停；finally释放。barrier内同项目新start/retry/recheck/preview/download拒绝，不同项目独立；cancel/stop仍走原真实停止流程，其在途请求也阻止获取检查点。关闭拒绝新检查点，等待已进入callback结束。

异步规划读取、事务认领、源码核对和实际spawn前检查项目barrier及admission generation，旧准备不能跨过已完成的检查点而启动收费或预览。planningSnapshot新增当前来源判据：sourceSuperseded===true或项目存在currentSourceRevision且不等run.sourceRevision即拒绝；缺该项目字段的旧档案保持既有行为。新来源后旧accepted仅历史，不允许当前预览/交付。source-change服务由根未来以规划检查点外层、执行检查点内层组合；本组件不写规划JSON、不迁移旧hash、不提供通用Worker恢复。验证采用临时SQLite及明确可信依赖，并保留原48项显式MXC薄失败候选，0真实API/用户data写入。

已实现接口与错误：`await service.withProjectCheckpoint(projectId, work)`同步在任何await前放barrier并完成空闲检查；活动或在途为409/project_busy、重入为409/project_checkpoint、关闭为503/shutting_down，无等待队列或强停。仅该可信内部方法透传callback的原异常对象，其余HTTP可用方法仍净化错误；集成层不得直接向HTTP序列化内部callback异常。开始执行/各action/下载在异步规划、源码或归档核对前登记项目在途，结束finally移除；list只读不占用检查点，但generation变化或barrier使旧读取失去当前启动/验收许可。检查点已成功进入后关闭等待callback完成，不应在callback内await本服务shutdown（内部调用会自等待）。

本轮新增11项并发/metadata回归：同步barrier及同项目拒绝/跨项目独立、callback返回值和异常身份/finally、所有run SQL活动与unknown/四类预览状态不被擅自清除、start/retry/recheck挂起准备、预览源码/下载源码及归档阶段在途、cancel回执在停止后仍在途及预览真实停止等待、关闭、currentSourceRevision/sourceSuperseded/legacy兼容、迟到list不恢复旧许可、来源变更后编码断言与深recheck构造前0新调用。目标软件正向验收和需求服务JSON发布不由这些fixture证明。

实际验证：`node --test tests/web-execution-service.test.mjs`为58通过、原实际MXC项1明确跳过（22863.3393ms），按根的原生资源安排先仅运行普通专项；随后获准且资源空闲，显式`TASKFLOW_TEST_REAL_SANDBOX=1`及已验证执行程序，运行`node --test --test-name-pattern='real MXC' tests/web-execution-service.test.mjs`，**1/1通过、0跳过**（2411.7411ms），真实薄候选仍自检失败、源码下载关闭、用量未知、无付费模型。两次合计59个不同测试均已实际通过，未将第一轮skip写作执行成功。`npm run check`为85脚本通过，`git diff --check`通过。最终仅补本记录，不再改被测脚本；3个授权文件固定后待不同作者独立复验及根F05串行集成，未改原树、store/server/公共UI/真实QA或用户数据，未推送/部署。

### 92099dc独立审查P2：多记录批次统一撤回过期许可

旧版59项虽已独立执行通过，审查探针仍复现：list并行构建多行DTO时，第一行已完成、第二行等待规划读取，期间checkpoint发布实际新需求对象及contentRevision；旧list只撤capabilities.canStart，先完成行仍可返回taskAccepted和预览/下载许可。后端操作会重新拒绝，未证实旧源码实际交付，但该DTO宣称违反当前需求门禁，920因此未放行。

本修订在批次开始记录generation及admission是否开放，全部DTO结束后在无await的同一段同步核最终barrier/generation及初始准入结论。批次失效统一清所有行的taskAccepted、preview URL及retry/recheck/preview/download许可，真实cancel/stop句柄许可保留；不改原行status/检查历史/用量，也不永久废弃未变化内容。即使checkpoint已释放、callback失败未发布内容，或批次初始准入409后后续行读取暂时恢复，也先保守撤回，下一次完整当前读取可正常恢复许可。list在已开放barrier内开始、更新完成后旧规划读取才返回时，同样不能将旧批准重新发布。

新增四项回归：实际新source/hash发布的多row交错；checkpoint成功/失败后过期批次撤回且fresh读取恢复；初始准入错误清预览URL并保留真实cancel/stop；始于barrier的旧读取晚返回。先在920源码运行前三项，3/3均明确复现失败；修后四项定向通过。本轮仍仅原3文件，未改root/原服务322、原需求或独立审查证据，0API/付费。

本修订最终检查：普通服务专项63项为62通过、原真实项1显式跳过（23987.5837ms）；随后显式启用真实执行环境定向运行原薄MXC负例，1/1通过、0跳过（2570.3356ms）。两次合计63个不同测试均实际执行通过，原59项保留；真实负例仍为fixture传输、真实失败自检和关闭交付，不是正向业务验收。85脚本语法、git diff --check通过。之后只补本文，不再修改脚本；固定新提交后交原独立Reviewer复验，未推送或部署。

基准`9a07615`。独立分支`codex/web-execution-service`，仅新增服务模块、专测及本文。已授权的task-store提交在工作树作参考；本服务不依赖其接口。当前执行器自行生成attemptId并内部多轮候选，与task-store的租约/候选唯一发布模型不同，首版不拼接或伪造Worker语义。

目标：可信HTTP集成层可调用`await createWebExecutionService({rootDir,getPlanning,config?,executable?,budget?,previewTimeoutMs?,dependencies?})`，返回`list/start/action/download/shutdown`。getPlanning(projectId,runId)返回可信`{project,run}`；所有对外方法只接受ID、profileId/contractRevision或动作，不接受路径、报告、passed和预算。错误带status和code；DTO沿执行面板约定。HTTP路由及主网页由主Agent后续串行接入。

设计：专属root的SQLite事务日志及单控制器owner；每个project/run唯一活动槽原子拒重，历史尝试不覆盖。执行的规划source/spec/plan快照固定，使用当前hash与v2双审批校验。固定library-web-v1完整任务和验收清单共同形成contractRevision；这是用户显式选择的参考项目，不能声称任意上传业务已经实现。正常默认调用startWebExecution、编码模型和独立Review；taskAccepted只接受完整当前isWebTaskAccepted门禁。

所有执行、预览快照由服务在专属root内生成。预览及下载复核当前审批、候选Git提交/干净状态/源码哈希/保护外壳；预览是新独立受控runtime快照并受时间预算及停止确认约束，下载调用createWebDelivery。DTO仅白名单检查、问题、净化事件和用量，不返回凭据、宿主路径、原始收据或任意对象。

服务是一个本机控制器，不是多Worker调度器。重启发现未完成执行或预览即reconciliation_required，保留活动槽及历史，不依据API重启猜测外部PID已停止，不自动重跑或取消成功。正常shutdown请求停止、等待既有句柄；失去owner后旧回调不能写入新控制器。task-store后续集成需明确映射外层任务租约与执行器内部候选轮次、独立可信收据、共享预算及停止证据。

## 接入契约

- `list({projectId,runId})`返回执行面板的`{capabilities,executions}`；capabilities含profiles/model/budget/reason。profile.contractRevision绑定完整参考任务及HTTP/browser/Review规则。各历史执行显示当次保存的contractRevision和预算。
- `start({projectId,runId,profileId,contractRevision})`返回`{execution}`。不接收路径、报告、任务内容、依赖注入或客户端预算。
- `action({projectId,runId,executionId,action})`支持`cancel/retry/preview/stop_preview`，返回`{execution,preview?}`。cancel先保存cancel_requested，等待真实done才转停止；retry新建UUID和attempt，保留原记录。
- `download({projectId,runId,executionId})`返回`{buffer,filename,contentType:'application/zip'}`。HTTP层负责发送Buffer，不接受调用方提供的来源路径或验收报告。
- `shutdown()`拒绝新启动、持久化取消请求，等待既有执行、预览及在途公共请求，释放owner再关闭SQLite；并发重复调用共用一个关闭Promise。真实执行器已有模型取消和进程终止预算，服务不把停止请求冒充终止确认。

getPlanning必须返回与ID匹配的project/run；run需有workflowVersion=2、冻结sourceSnapshot/sourceRevision、spec/specRevision、tasks、architecture.md、planRevision、specQuestions、两次approvals、passed且无issues的review及stages。仅succeeded或只有export在途的running可启动。工厂await即完成初始化；root须是专用绝对目录，不能是链接。config省略时模型工厂读取已有服务端LLM环境；显式提供config时须由服务端附带所需apiKey，不能从浏览器收取。

预览活跃TTL从runtime就绪后计算；到期先请求正常协议停止，runtime硬截止额外15秒作为启动/停止保护余量。PID、独立工作区、起止时间和停止证据仅保存在专属preview_history，不返回DTO。预览启动前后均复核当前版本；刷新发现审批失效时撤下并停止旧预览。源码核对失败会关闭当前通过权限，进程停止未知则保持reconciliation_required。

## 9bbd5d3初版证据（独立审查发现阻塞，保留历史）

- `npm ci --ignore-scripts`：安装精确依赖，无依赖清单修改。
- 普通专测`node --test tests/web-execution-service.test.mjs`最终为18项通过、真实MXC项1项按显式开关跳过；覆盖当前hash/审批、参考范围、事务重复启动及活owner拒绝、取消确认、新attempt历史、旧版本/旧owner拒绝、unknown用量、白名单净化、重启状态、预览复制与TTL、预览停止PID历史、源码核对/版本变化/危险URL、正常重启再次预览及启动竞态。通过收据及预览/下载正向均为显式可信测试依赖，不能作为真实业务验收或真实预览/交付成功的证据。
- 本轮仅运行一次实际MXC失败候选：显式`TASKFLOW_TEST_REAL_SANDBOX=1`及可信本地MXC路径执行专测，当时19/19通过无跳过。真实startWebExecution完成1次允许源码写入并固定候选，HTTP自检failed、任务未通过、编码调用计1、Review未调用、源码下载未开放，用量保持null。编码返回由薄可信fixture注入，没有付费模型调用。之后补充仅预览PID/停止历史、历史预算/contract和公共请求关闭管理；这些由最终普通专测覆盖，遵守最多1次真实失败候选未重复该MXC项，不能把早先实测冒充最终固定提交的独立复验。
- `npm run check`：62个脚本语法通过；`git diff --check`通过，最终仅提交本模块、专测和本文。

独立测试曾在9bb运行19/19（含真实MXC）通过，但随后两个只读Reviewer通过额外探针实证六项P2。因此该版本被阻塞，19项通过不能替代这些未覆盖行为正确的证据。旧提交和独立输出未修改。

## 本次六项审查返工

1. 停止启动中的预览统一调用一次runtime.stop并缓存其真实结果。晚返回runtime的PID、停止状态和证据先保存再拒绝预览URL；stop_preview和shutdown共用该结果。cleanStop规则未放宽，exitCode、ack、sourceUnchanged或termination不合格仍待协调。尚未请求spawn的路径单列not_started，不伪造进程停止结果。
2. 默认Git核对抛错保留phase、command及实际result。新增专属私有source_history，保存有界的PID、起止时间、control/probe目录、命令及阶段；不保存stdout/stderr/原始收据，不对DTO或HTTP错误公开。此历史与executions.record分开，复核未知源码进程需查询source_history，预览仍查询preview_history。
3. executions增加control_version，取消、预览控制、失效和完成发布推进代次。finish在异步规划查询结束后重读当前row/owner；取消及任何同run待协调状态优先，不能被迟到accepted覆盖。executor版本断言、DTO也在异步边界后重读。
4. acceptedSource在每个异步边界重验最新status、active、preview_state、owner、control_version及完整gate。实际调用startRuntime前另作同步guard，期间发现源码进程未知不得spawn或下载；预览URL发布前再检查当前预览句柄与停止状态。
5. 编码与预览共用同run活动槽。预览starting/running/stopping均占槽；必须正常停止后才可启动新attempt。初始化在owner核对通过后的事务内迁移旧索引：正常活动仍唯一，reconciliation历史允许同时保留多行，但所有新活动/权限查询均将任意待协调行视为阻塞。旧版“一条预览+一条编码”组合全部保留为待协调，不因唯一索引崩溃，也不推断任何旧PID已经死亡。
6. 所有非空已知API key均遮蔽，包括1至3字符配置；非文本key配置明确拒绝。DTO和公开错误仍按白名单发布。

以上为服务自检修复结论，仍须同两位独立Reviewer在新固定版本复验，不在本任务中自行关闭独立问题。

## 本次实际验证

- 普通专项：`node --test tests/web-execution-service.test.mjs`为28通过、真实项1显式跳过。新增10项回归覆盖上述六个问题，含晚runtime正常/四类不合格停止、启动中shutdown、默认Git错误元数据、source probe私有历史、finish/cancel与assertCurrent竞态、源码unknown后spawn次数0、双向活动槽、旧索引双历史迁移和短key。
- 按本轮新授权，显式`TASKFLOW_TEST_REAL_SANDBOX=1`与可信本地MXC路径执行同一专项：**29/29通过，无失败/跳过**。仅再次执行1个薄失败候选，真实文件写入与自检失败反馈保留，任务仍未验收，未开放源码下载；无付费模型调用。此次实测与最终代码相同，此后只更新本任务记录。
- `npm run check`：62个脚本语法通过；`git diff --check`通过。

未连接HTTP路由或主网页；未真实运行正向模型编码、独立Review、已验收候选预览/下载和全仓回归；未迁移用户JSON或data，未推送或部署。下一步由主Agent在新固定提交上独立Review/测试，再串行接入HTTP/UI并重新验证集成版本。task-store未成为运行依赖，主Agent可只cherry-pick服务提交，忽略参考依赖提交c78e0c1。

## E08：保留可复核的检查预期与观察结果

根集成的真实失败路径发现：固定HTTP检查用expected/actual保存失败原因，原checkDto仅保留error，导致HTTP 503与预期200的差异从网页DTO丢失。本小修仅为selfCheck、独立HTTP与browser的checks增加可选`expected?:string`、`actual?:string`；只接受现有验收器的文本类型，复用safe净化已知密钥及私有路径，每字段最多2000字符。对象、进程元数据和原始日志不被序列化或复制；缺省字段继续缺省，原error字段保持兼容。固定清单、hash、验收门禁及a60历史不变。

新增DTO回归同时覆盖三个检查分支：正常`HTTP 200`与`{"status":503}`保留，expected/actual中的已知key和Windows/Unix私有路径遮蔽，长文本截断，额外PID/stdout及非文本进程对象不透传，浏览器仅有error的旧形态继续兼容。

本小修实际运行`node --test tests/web-execution-service.test.mjs`：29通过、真实MXC项1显式跳过，无失败；`npm run check`为62脚本通过，`git diff --check`通过。按本轮范围未重复真实MXC或付费模型，未改根集成树及网页。需在固定提交后短只读Review，再由主Agent串行接入并验证网页展示。

## 自有原始候选的网页固定代码复验（本轮实现，待独立复验）

基准2365067，独立树codex/web-owned-recheck-service，仅修改服务/UI与其测试和两份任务记录。新增action:recheck、actions.canRecheck及“重新检查固定代码”，费用确认仍绑定当前双审批、范围及预算。新attempt不编码，仅使用原提交重新运行全部检查和新Review；旧失败及旧用量保留，新row只计新Review。list只作元数据准入，不周期运行Git。

来源路径及五字段sourceBinding只能从服务私有原始row导出；不接受HTTP路径、报告或绑定。深准入使用core inspector，在Review前核对原回执、Git、报告、停止证据及上下文，新快照存到新row根。复验来源禁止递归；已通过复验的无.git快照必须通过单独provenance分支复核当前快照、原报告哈希、原Git、原上下文及完整bytes，普通编码候选的Git要求不放宽。core扩展由独立Agent唯一写入，固定后作为依赖集成。本轮不写真实来源、不调用付费API。

已集成独立FIX的core c16e259（本树cherry-pick为7c2257d），API保持`inspectRecheckSource/startRecheck`仅可信构造注入。list的轻量资格仅解析私有元数据，实际Review前完整inspector必须与原SQLite record逐项JSON内容一致，summary的root、五字段context、report/hash、commit/sourceHash/shellHash也必须相符；新快照归属root/executions/新row，而原root从sourceServiceExecutionId派生。复验preview/download每次重新验证原报告哈希、Git及回执，再对当前无.git快照逐字节哈希和保护壳核对。

验收contract升级不阻止代码复用：原row的旧contract必须存在且为合法hash，profile/task和当前source/spec/plan上下文仍完全一致。新row使用当前contract、当前全部检查及新Review；原accepted行仍须当前contract及完整gate才可直接预览或下载。私有snapshot保存sourceContractRevision，旧通过结论不能转移。

当前收费动作契约收紧为`action({projectId,runId,executionId,action:'retry'|'recheck',profileId,contractRevision})`；缺当前两字段为400，旧版/错误值为409且不启动模型。非收费动作仍仅允许原四字段，客户端路径、binding、report、functions或budget全部拒绝。旧retry请求不再自动补当前contract，必须刷新重选并确认费用。新增DTO仅含kind、sourceExecutionId（服务UUID）、sourceCommit、recheckContractRevision（当前可选范围）、recheckBudget及actions.canRecheck；不暴露原始路径/收据。

服务专项的新增回归使用明确可信fake inspector/recheck及fabricated receipts，只证明生命周期/版本/完整门禁接线，不证明真实业务软件验收。覆盖0coding及只计新Review、原失败/用量/原文件保留、并发拒重、错误路径/回执/binding、旧contract新检但旧accepted不可下载、stale/cancel/unknown/重启、阻塞与新失败不继承旧passed、无.git预览/下载、快照或报告hash篡改。真实正向网页复验及付费Review由根在固定且独立通过后另行验收，本轮没有执行。

新增有效阻塞问题不能通过反复重审被清空：仅检查同project/run、相同commit和sourceHash的私有已结束复验元数据，要求完整model Review状态、版本/上下文/策略绑定和真实问题字段。原报告已有问题仍走core的previousIssues及显式resolution；复验新发现的open blocking在当前实现没有跨复验resolution通道，因此保守禁止该提交继续recheck，并撤下同代码早期accepted行当前taskAccepted、预览和下载权限，历史状态与原报告保持不变。可使用当前收费契约retry形成新代码版本；正式问题争议与修复入口尚未实现。格式错误的Review响应、不同提交的问题不会触发此限制，list不为此运行Git。

本轮最终实际验证：显式启用`TASKFLOW_TEST_REAL_SANDBOX=1`并指定已验证本地执行程序，`node --test tests/web-execution-service.test.mjs`为**42/42通过、0跳过**。其中只有原有薄失败候选使用真实执行器/Git/MXC，模型返回由可信薄fixture提供，产生真实文件与失败自检，仍未验收、用量未知、下载关闭、0付费；新增正向复验及预览/下载路径使用可信依赖注入，不能称为真实业务全流程通过。`node --test tests/execution-panel.test.mjs`真实系统Edge平台UI fixture为**19/19通过**（18场景及父项），覆盖桌面与390×844；`npm run check`为77脚本通过，`git diff --check`通过。最后仅补本文及UI任务记录，不再更改被测脚本。

固定后待不同作者独立专项及根HTTP/UI串行集成回归；本树未写真实QA/data或主树，未发起真实API，未推送或部署。服务仍为单控制器SQLite生命周期，重启未知进程保留reconciliation_required；未新增多Worker恢复能力或task-store接入。

## 73532cc 独立审查两项 P2 的修订

旧版42项服务与19项Edge专项虽通过，独立探针仍实证两处遗漏，73532cc因此未放行：25ms预算在核对100ms后仍未abort、core重获25ms并可通过；canonical Review认可的README.md问题被局部路径过滤遗漏，旧accepted仍能下载及再次复验。本轮保持旧提交、原QA及审查证据不改，仅在原授权范围修复。

总deadline在新row事务建立时固定，私有snapshot保留开始时间、截止时间与用户确认的总预算。timer覆盖规划查询、来源inspector及core，所有准入异步边界和实际dispatch前另验elapsed，避免事件循环同步阻塞绕过timer；core只取得剩余整数毫秒，当前DTO仍展示原确认总预算。预算或取消触发后立即abort且禁止新Review，先保留活动槽等待已有核对停止，最多额外5500ms只用于清理（与managed-process的5秒停止确认上限对齐），不增加付费或执行预算。核对按期合作结束才可timed_out/stopped；未结束或有unknown-stop结果则reconciliation_required，不假定外部工具已死。

私有snapshot/source_history保存来源服务ID、原root/report/workspace、新输出目录、开始/deadline及已有PID/control/probe/result。超过清理等待后迟到的核对结果，在当前控制器仍拥有数据库时只追加证据且继续协调，不发起Review、不重新释放槽或发布成功；关闭或归属失效后的回调不能修改新控制器，已存未知记录保持需人工核对。单控制器服务不声称自动恢复或自动完成协调。运行中的core仍复用其停止与回收协议，service取消及总deadline也优先覆盖迟到accepted。

阻塞识别及问题DTO的文件位置改用现有validateProjectFiles的canonical路径校验，不再另写更窄的前缀/字符规则。README.md、docs/a..b.md及Unicode合法文件问题都保留定位并撤销同代码早期accepted的当前验收/预览/下载/再检；越界和保留路径仍由canonical规则拒绝。Review意见/证据的真实性仍由core validator核对源码行，服务不降低核心验收要求。

本修订实际验证：先运行新增定向回归，再显式启用`TASKFLOW_TEST_REAL_SANDBOX=1`及已验证本地执行程序运行完整服务专项，**48/48通过、0失败/跳过**，含原有真实Git/MXC薄失败候选；新增6项覆盖异步100ms/25ms预算与同步超时、部分预算传递、迟到core通过、超时及取消不合作核对/清理等待/迟到私有停止结果/重启、abort后unknown停止、三类canonical合法文件阻塞。真实系统Edge平台fixture **20/20通过**（19场景及父项），77脚本语法及`git diff --check`通过。最后只更新任务记录，不再修改被测脚本。新增正向及停止探针仍为可信依赖测试，0付费；原QA、core和其他工作树未改。本提交只修5个原授权文件，public组件代码不需改变；待不同作者重新复验，不把前版独立测试数量当作放行证据。

## 1c754e4 独立审查：修复入口必须保留同代码的所有已知阻塞意见

基准为独立服务/UI版本1c754e4，其73项服务专项和23项Edge虽通过，独立issue-history探针发现确定P2，故未放行：原编码报告提出A，同代码复验称A已解决但新增B；选旧编码记录修复时只携带A，新候选仅关闭A即可错误通过。旧提交、原失败报告及独立证据全部保留。本轮仅修改原授权六个文件，沿用已独立FIX的checkpoint和core seed依赖，不修改core/server/存储/路由。

修复继续使用`action:'repair'`及当前`profileId/contractRevision`三字段收费契约，无客户端报告、路径、意见、预算或回调输入。新attempt独立计本轮编码/Review预算，原attempt和用量不覆盖。来源仍需自有当前绑定的终止失败记录、真实编码来源inspector和完整当前gate；普通Git候选要求、取消/总deadline/停止待协调及checkpoint门禁保持原规则。

现在按相同project/run、完整私有source/spec/plan绑定、当前contract和Review/检查清单策略、同一sourceHash聚合历史。只采用自有已结束记录中完整绑定的completed model Review，遍历其所有候选版本，包含原编码、复验和以前失败修复候选。真实coded报告的模型来源按core既有record.reviewerKind确认，不要求core未写入的review.kind；复验仍要求其原有review.kind=model，显式非模型类型不接受。相同字节上的后续“resolved”不删除历史义务：此次保守策略要求全部已知阻塞意见在真正改变的候选上重新逐项关闭，不实现意见争议或原地撤销。重复ID只有内容、位置、证据及originCommit一致才合并；冲突明确拒绝，不能静默覆盖。最多20个独立问题、64份候选意见证据，超过上限拒绝而不截断；单份合法Review的旧问题加新问题超过20时同样拒绝，不能忽略该份历史。

list只作私有元数据资格检查，不周期运行Git。实际收费前对每份聚合报告执行服务目录/普通文件/读取稳定性/原始字节hash/SQLite内容一致性核对；复验报告额外核对它的原编码row、五字段binding和provenance。每个Review复用canonical validator核对真实源文件、逐字行证据和先前问题resolution，阻塞列表必须完整对应其有效新意见或仍open的旧意见。聚合问题只按稳定ID排序，不把审查文本当指令。

私有repairProof新增`findingSetHash`及`findingReports:[{id,hash}]`，不进入DTO。集合固定后、每次模型assertCurrent和最终发布前均重新核对集合成员、所有报告hash和当前来源；发布阶段还重跑原始Git/回执inspector。期间新增或改变有效finding会撤回本次权限/发布，即使用户仍选旧入口。新候选若回到另一份已经有有效阻塞意见的相同字节，也不得凭新commit和随机通过结论放行。成功修复仍须实际新代码、新Git候选和全部原问题显式closed；未关B不能发布。该集合后续变化也撤回旧repair当前taskAccepted/preview/download，历史报告不改。旧版未带完整集合proof的repair不自动升级为通过。

本轮最终实际验证：`TASKFLOW_TEST_REAL_SANDBOX=1`、显式已验证MXC程序下完整服务专项 **81/81通过，失败/跳过0，46116.0316ms**，其中仍只有原有1个真实Git/MXC薄失败候选；全部正向修复/聚合/报告竞态使用可信注入和临时伪造回执，不能当作真实业务或模型修复验收。真实系统Edge平台UI专项 **23/23通过，0跳过，14611.3529ms**，含桌面、390×844、费用勾选、跨运行迟到、错误保留和新全量意见说明。87脚本语法、`git diff --check`通过。新增8项服务回归覆盖旧/新两个入口A+B全量传递、只关闭A拒发布、真实coded Review格式、重复身份冲突/合并与上限、报告/Review深查、准入/模型/发布/下载期间新finding、失败修复早期候选和相同bytes不同commit。

旧独立探针和helper复制到主树忽略目录`output/verification/owned-repair-issue-history-fix-20261114/`后复跑，原输入保持，修复版断言core收到A+B、两项显式resolution后才accepted；原独立失败证据未覆盖。该探针仍为trusted fixture、0付费。未重跑真实e312正向模型修复、主HTTP集成和全仓验收，未写原QA/.env/用户data，未推送或部署；固定后交非作者独立Review，再由主Agent集成及开展已授权的真实同源修复。
