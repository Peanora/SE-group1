# 独立测试模型 DSL 提案适配器

## 目标、边界与接口

基准 `a3e7de6`，独立工作区 `teamwork-verification-model`、分支 `codex/verification-model`；先复用已独立复验的 DSL `6b3e303` 与三项修复 `af514a5`。仅新增本记录、`lib/verification-model.mjs`、`tests/verification-model.test.mjs`；允许在 `lib/verification-contract.mjs` 增加纯 `inspectVerificationProposal(input)` 导出，不改变既有校验、审批或运行规则。

`createVerificationModel({config?,fetchImpl?})` 返回一次模型调用函数：

```text
async ({task, requirements:[{id,text}], engineeringContract, binding, signal?, onReceipt?})
  => {proposal, model, usage, policyHash, coverage:'structural_only'}
```

task 和 engineeringContract 接受非空文本或非空纯 JSON 对象，requirements 为唯一、非空编号和正文；binding 沿 DSL 的 projectId/runId/specRevision/planRevision。仅这四类资料进入模型输入，不接受候选代码、测试结果、批准对象或通过标记。可信服务负责冻结规格、工程接口和版本之间的实际关联；结构校验不能证明这种业务语义关联。

输入先按 own data descriptors 复制为有界纯 JSON，不调用 getter、toJSON 或自定义数组方法，拒绝循环、非有限数字、未知顶层字段与不合法数据类型。返回 proposal 只经过既有 DSL 结构、覆盖、依赖、变量和路径校验，不自动修补期望值或补全缺失的需求。inspect 返回未带品牌的普通定义；不调用 approve/compile/runner，也不产生运行能力。模型输出不代表 passed，后续须经可信控制器在编码前核对语义、批准和 compile 才能运行。

## 调用与故障契约

沿用 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY、LLM_JSON_MODE 与 LLM_THINKING；可信显式 config 字段仅 baseUrl/model/apiKey?/timeoutMs?，传入后立即复制。模型只提出 DSL v1。固定最大 8192 输出 token、256 KiB 实际响应流、128 KiB 总上下文、384 KiB 编码后请求；单次调用默认60秒，可信 config.timeoutMs 可设置1至120000毫秒。一次请求，没有内部格式重试，控制器另行掌握预算。响应上限以实际读取字节为准，不信任 Content-Length。等待网络、读取和回执期间都有截止处理，最终发布前也检查实际已过时长，不依赖 timer 回调是否已经运行。

四字段回执 `{model,finishReason,usage,content}` 沿现有适配器契约：finish 白名单外值记 unknown，只接收 stop 的正常提案；用量缺失或非法为 null。成功读取的模型正文在严格格式/契约拒绝前交私有 onReceipt 保存；回执是独立副本，不进入请求，保存失败不放行。HTTP、读取、超限、凭据回显、取消和超时错误使用固定消息，不传播服务地址、正文、取消原因或底层异常。配置密钥不会进入提示词；检测回显时遮蔽回执并拒绝提案。取消或截止后不发布提案、不调用迟到回执；可信回执写入器仍须负责自身写入的取消和持久化。

policyHash 绑定固定提示、适配器源码和当前 DSL policyHash。coverage 固定 structural_only：需求编号覆盖不等于充分业务覆盖，仍需要独立 Review 或人工核对。此组件尚未接入通用 Agent 服务，不构成通用软件自动验收完成。

## 本轮验收计划

普通 mock 测试覆盖合法提案与输入快照、无运行/审批能力、未知字段/命令/passed/外部路径/覆盖/变量依赖/非有限数字拒绝，以及 abort/timeout/HTTP/finish/读取超限/回执失败/密钥回显/未知用量。只运行可信测试，不执行模型候选或用户数据。新增模块/测试和 DSL 导出做语法检查、专测及 diff 检查，固定提交后交另一 Agent Review；不调用付费模型，不改主分支、server、package 或依赖。

## 本轮完成证据

- 新适配器普通 mock 专测 `node --test tests/verification-model.test.mjs`：19/19通过，无跳过；所有模型传输都使用可信 mock，不请求真实服务。
- 显式启用真实 MXC 后，联合执行 `node --test tests/verification-model.test.mjs tests/verification-contract.test.mjs`：37/37通过，无跳过。真实执行仅来自原 DSL 错误候选/非有限数字负例，新适配器不运行提案或候选代码。
- `node --check` 检查新增适配器、新测试和纯导出所在 DSL 模块；`git diff --check` 均通过。

覆盖纯检查定义仍无品牌、控制器独立批准/开始编码后才可执行、输入与配置快照、访问器/toJSON/循环/原型/数组伪装拒绝、固定上下文/请求/响应上限、未知需求/缺覆盖/路径/命令/伪造 passed/变量依赖/非有限数字拒绝、finish 白名单、单次请求、四字段私有回执及真实/未知用量、保存失败、字面/Unicode转义/混合拼写密钥回显、过大遮蔽回执、网络/读取/回执三阶段超时、原始取消原因遮蔽、迟到响应关闭与迟到提案抑制。新控制器导出只增加 inspect 包装，没有改现有判定规则。

未运行付费模型、真实独立测试 Agent 生成或语义覆盖评审，未接入服务/网页，也未修改主分支、server、依赖或用户数据。纯结构提案通过不能称为目标业务通过；固定提交后仍需另一 Agent 独立 Review，再由控制器决定后续接入和真实调用。
