# 可信人工导入联合验收定义（后端范围）

2026-11-18。目标是在双确认后的当前规划中允许可信操作者导入已准备的定义作为新的draft；不调用模型、不编译、不执行、不自动批准，不把历史模型失败改成成功。

本Agent仅写lib/verification-planning-service.mjs及相关service测试。根负责server路由、完整规划/来源/角色门禁、UI与API文档。新服务函数精确为importDefinition({projectId,runId,contractRevision,proposal,feedback})；DTO origin=manual|model，旧DB新增origin列默认model。人工usage0/0、dispatchedfalse、receiptState=not_applicable，不造模型/回执来源。

复用现有operation/admission、双确认、来源、活动/unknown、检查点、frozen、DSL全REQ覆盖和密钥guard。manual单run最多20；模型maxAttempts只数origin=model；attempt序号统一MAX+1、事务内检查与插入，不能覆盖旧费用或预算。capabilities新增canImportDefinition与manualBudget{maxDefinitions,remainingDefinitions}及独立原因；未配置模型也可人工导入。原reject-manifest禁止再批准同定义的规则不变；编辑/审批/冻结/Worker流程兼容。

验收为0费service回归：失败模型后导入、未配置模型、unknown/活动/来源/双确认/检查点/frozen拒绝、密钥/恶意输入/DSL覆盖拒绝、旧DB迁移默认model、人工20上限及模型预算不退还、并发attempt唯一、来源/历史真实、编辑审批和Worker授权/冻结。完成后固定哈希交i9独立Test/Review，不提交/推送/部署。

实现完成：importDefinition沿现有operation/admission入口，先核当前规划、合同、密钥与DSL，再在事务中复核active/frozen/人工20上限并用MAX(attempt)+1插入新draft；无模型调用/编译/批准。新列在BEGIN IMMEDIATE中按PRAGMA table_info迁移，NOT NULL DEFAULT 'model'并CHECK来源枚举，旧行其它字段与原回执不改。capabilities提供canImportDefinition、manualBudget{maxDefinitions:20,remainingDefinitions}、manualReason；模型reason/budget独立。

实际作者检查：

- `node --test tests/verification-planning-service.test.mjs`最终47/47，0失败/取消/跳过，7593.362ms，包含8个新增人工来源业务回归。初轮46/47唯一失败是旧DB迁移测试的SQLite null-prototype行与普通对象严格比较；字段值未变，测试两侧都按普通数据对象比较后通过，原日志保留。没有放宽业务断言。
- `node --test --test-concurrency=2 tests/verification-model.test.mjs tests/verification-contract.test.mjs tests/verification-task-scopes.test.mjs tests/verification-planning-service.test.mjs`：131项，129通过/0失败/2原生可选跳过，8518.0308ms。
- 随后显式启用本机MXC执行 `verification-contract` 与 `planned-worker-subject`：22/22，0失败/取消/跳过，6526.8465ms，补验两个实际MXC拒绝分支及既有Worker授权/撤权。此批未调用外部模型，不能把两批拼成一次全仓零跳过。
- 新service回归保存原失败模型7/11用量及原字节、人工0/0/无回执；21并发人工导入仅20成功、序号1..20，随后模型3次序号21..23且预算不回退；旧DB默认model、原归属/费用/回执不变；unknown重开仍hold；人工导入不能洗去拒绝manifest；真实编辑审批后只能取得同版Worker能力且立即freeze。

日志与scope哈希在output/manual-definition。作者未改server/UI/HTTP测试或外部角色门禁；它们由根集成。未运行全仓套件、未运行收费模型验证、未做人工定义驱动的完整业务编码闭环。下一步根固定i9后由独立Test/Review验收。当前生产文件已停写，无提交/推送/部署或主服务操作。

## i9独立发现的跨实现版本拒绝失效 P2

独立Review用真实i8服务生成并reject，再以i9导入相同定义，实际approve错误成功。source/spec/plan/contextHash/DSL manifestHash均相同，仅service policyHash变化；原rejections查找依赖包含该实现policy的context_key，导致升级洗掉拒绝。i9原红日志与facts保留，本轮没有改i8/i9或它们的原件。

新修复保持原rejections表、主键、行及历史，新增manifest_hash索引，DTO与实际approve共用仅按manifest_hash查找。该哈希原本已包含project/run/spec/plan四字段binding、完整REQ集合与DSL policy，不能因平台service实现指纹变化而忘记原人工拒绝；真正不同定义或新的计划/来源运行有新manifest，不受旧记录误伤。未增加快照迁移表或放宽审批/执行/预算。

新增portable回归使用两个真实服务实例与不同实现指纹，先生成/拒绝并落盘，再由当前实现读取同库；manual/model再提案及编辑回退均拒绝，真实改定义/新计划/新来源运行允许，旧rejections行不变。另在output/rejection-policy-fix实际导入冻结i8创建的旧库，原实际错误approve反例先红后绿；原i9检查结果不拼成新全仓通过。具体最终检查结果在该目录新交接报告。
