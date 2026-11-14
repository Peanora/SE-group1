# F02 需求驱动工程设计草案组件

## 实际规格的技术栈别名修复（基线d669a70）

唯一修改本记录、`lib/engineering-plan.mjs`和`tests/engineering-plan.test.mjs`。真实规格已成功产生（根记录为1次规格API），但工程attempt1仅在本地技术栈准入失败，尚无工程API、usage为null；engineeringCalls是工程尝试计数，不能当收费API次数。原invalid_input历史与原规格/hash保留，不重新生成规格。

已只读复现原规格stack：frontend为`原生HTML/CSS/JavaScript，同源外置JS/CSS`，backend为`Node.js 22.21以上原生HTTP，ES Modules`，storage为`Node.js内置SQLite`。小范围正向语法识别将保留旧基础别名和版本校验，仅增加同源外置资源、原生HTTP/ES Modules/内置模块等明确限定与SQLite内置前缀。每个字段最多200字符，限定列表数量有界并消费整串；未知尾部、否定描述、旧Node版本、React/Vue/Express或混合数据库不自动改写或放行。校验只保留原spec文字与哈希，源码改变自动使纯策略和依赖它的模型策略hash变化。先补实际栈与冲突对照回归，再固定提交交非作者独立复验；本轮不调用真实API、不改用户数据、不接其他功能。

已实现的限定：frontend在旧HTML/CSS/JS语法后允许最多一项`同源外置JS/CSS`（CSS/JS顺序及JavaScript写法亦可）或`same-origin external JS/CSS`。backend保留Node/Node.js、版本及安全整数校验，允许>=/≥、以上/及以上及最多三项原生HTTP（可带服务器）、ES Modules/ESM、仅使用内置模块或built-in modules only；限定用中英文逗号/分号分隔，不识别任意描述。storage仅增加Node/Node.js内置、内置或built-in前缀，其SQLite显式版本仍须为3系列。正向语法不表示语义证明，未知或否定文字仍需控制器澄清而非转换。

实际验证：原30项纯校验/模型mock全部保留，新增四项回归后`node --test --test-concurrency=4 tests/engineering-plan.test.mjs tests/engineering-model.test.mjs`为34/34通过，0失败/取消/跳过，337.4733ms；两份修改脚本`node --check`与`git diff --check`通过。新增正向矩阵240组别名组合、实际stack保持原spec/hash，以及框架冲突/混合数据库/否定/未知尾部/明确旧版本/不安全版本分量/文本上限反例；矩阵是测试内部断言，不另算240个Node test。

只读真实原记录在修复前复现误拒，修复后准入成功；specRevision始终`f1385d160333dfdbe49774e9e09106c6ff6734c24ef2e5757be4e57459a90206`，整个原项目文件SHA256前后同为`b2bca00d6ed6094b93bbd3666bfc93124a2057fbd80755719bca5d76a6c5c5fb`。历史工程attempt计数仍1、状态failed、usage两项仍null，没有本轮工程API。证据在本地主工作区忽略的`output/verification/engineering-stack-compatibility/{before.json,after.json,tests.log}`。未运行真实模型重试、目标代码或全仓回归；固定后先独立审查，根控制器才可用同一原spec发起新的工程请求。

基准 `3cb8e70`，独立工作区 `teamwork-engineering-plan`、分支 `codex/engineering-plan`。仅新增 `lib/engineering-plan.mjs`、`lib/engineering-model.mjs`、两份专测及本文。不改 orchestrator/server/public/package，不依赖未放行的 verification-model，不调用真实模型或操作用户数据。

## 最小契约

- `inspectEngineeringContext({spec,binding})`：按own data descriptors复制有界纯JSON，返回固定规格/版本快照、原角色的确定性ROLE-001等定义及平台接口。binding为 `{projectId,runId,specRevision}`，specRevision必须等于现有contentRevision公式的规范JSON SHA256；这只是内容一致性，不证明规格已批准。
- `validateEngineeringPlan({proposal,spec,binding})`：返回 `{version:1,binding,specHash,requirements,roleDefinitions,platform,proposal,hash,policyHash,coverage:'structural_only'}`，所有内容为独立、冻结的普通数据，不提供批准、执行或passed。requirements及角色原文来自输入，不让模型重写。
- `createEngineeringModel({config?,fetchImpl?})` 返回单次函数 `async({spec,binding,signal?,onReceipt?})`，结果为上述草案加 `{model,usage,modelPolicyHash}`。模型只看当前规格、角色定义、binding和固定平台契约，不接收候选代码或测试结果。

proposal严格为 `{version:1,title,summary,entities,routes,views,tasks}`。实体字段采用string/integer/number/boolean/datetime，required必填，unique可选；references为 `{entityId,field}`，必须引用已存在的同类型unique字段。实体、接口、页面和任务id分别唯一；字段名在实体内唯一；testId全局唯一。

routes为 `{id,method,path,roles,request,response,errors:[{status,reason}],requirementIds}`。roles引用原spec.roles顺序派生的ROLE-001等ID，roleDefinitions保留完整中文原文，[]为公开接口；不新增角色或把自然描述当机器ID。views为 `{id,path,title,requirementIds,selectors:[{testId,role}]}`，role为受支持的可访问性角色。相对REST路径只允许无歧义ASCII段及完整`:recordId`参数段，拒绝URL、编码、反斜线、点段、重复路径及仅参数名不同的重复路由；过滤条件写在request描述中。

tasks为 `{id,title,description,requirementIds,dependsOn,writePaths,inputs,outputs,acceptance}`。任务DAG无环、无未知依赖；所有需求必须由任务结构覆盖，接口/页面也只能引用已知REQ。writePaths是精确文件而非glob，复用validateProjectFiles允许路径及大小写/父文件冲突规则；全图最多60个唯一文件。同一文件由多个任务写时，每对写入任务都必须处在明确的依赖祖先链上，否则拒绝。DAG表示开发计划，不表示Agent已经执行或具备并行Worker。

描述、约束、请求和响应全部是惰性文本；schema没有SQL/JS/Shell、命令、安装依赖或可信测试入口字段，组件不执行文本。结构校验不能证明描述业务正确、没有遗漏或达到语义验收，仍须独立Review和后续人工计划确认。平台固定Node.js内置模块、SQLite、`src/app.mjs`的`createApp({databasePath})`、同源外置public HTML/CSS/JS；明示不兼容栈不能在本v1中被静默改写。技术栈接受HTML/CSS/JS的原生别名、Node/Node.js及SQLite；只写Node22主版本表示可选受支持minor，明示18或22.20等低版本拒绝，SQLite若明示版本则必须为3系列，版本分量必须是安全整数。

## 上限、模型与验证计划

context最多128KiB，proposal最多256KiB，纯JSON最多20000节点/深度16；最多40实体、每实体64字段、100接口、40页面、每页30选择器、80任务。对象键排序形成canonical哈希，writePaths复用项目文件规则排序，其余数组顺序保留；hash绑定完整规格摘要、原始需求/角色、绑定版本、平台、草案和校验策略源码/文件权限规则。

模型固定16384输出token、256KiB实际响应流、384KiB编码后请求；默认60秒，可信config.timeoutMs可设1..120000毫秒。沿用LLM配置/JSON mode/thinking，四字段私有回执先保存，未知用量null，finish严格白名单且只接受stop。复用已独立FIX的model-content-guard v2，原文检查及遮蔽先于JSON.parse，模型策略hash绑定helper版本/源码。格式错误不自动重试；取消、超时及迟到响应不得发布草案，错误不暴露地址、正文或凭据。

先运行纯校验和mock模型专测，覆盖合法不同业务、引用/角色/覆盖/任务图/共享文件、路径权限、输入getter/快照/哈希、固定模型上限、回执、取消/时长/凭据回显。只验证本组件边界，不执行候选业务，不把草案称为产品已接通。实际结果在完成后追加，固定提交供另一Agent独立Review。

## 本轮实际检查

`node --test tests/engineering-plan.test.mjs tests/engineering-model.test.mjs`：30/30通过，无失败/跳过（13纯校验、17模型mock）。四个新增脚本逐一 `node --check` 及 `git diff --check` 通过。模型传输均为内存mock，测试没有真实模型/API、MXC业务执行、用户数据或数据库操作。

纯校验分别用工单、静态展览及模型mock的资源预约草案验证不依赖固定业务；覆盖原文/角色快照、contentRevision等价与陈旧版本、规范哈希、实体外键/类型、角色/REQ覆盖、path及错误状态、DAG/前向依赖/共享写入、大小写与父文件冲突和各项上限。短只读自检发现并修复显式Node低版本被静默接受的问题，已加18/22.20/不安全大版本号反例及22.21/24对照；自检不是最终独立放行。

模型mock验证单请求16384token及数据范围、上下文/配置/回执隔离、严格输出拒绝、finish枚举/未知用量、HTTP/流字节上限/UTF8、网络/回执异常遮蔽、读取/网络/回执三阶段取消与截止、timer未执行时的实际时长截止、迟到body关闭和提案抑制。凭据字面/转义/重复键/畸形和leading stray quote均在保存回执前拒绝，四进程策略探针确认helper版本、helper实现hash或纯校验策略变化会改变modelPolicyHash。

仅新增授权五文件，无依赖/配置/数据迁移。未调用真实工程模型，未评定草案业务语义充分性，未接orchestrator、审批、编码或网页，也未跑全仓集成测试。固定提交后交另一Agent独立Review，后续才由可信服务接入规格确认与人工计划确认之间的流程。
