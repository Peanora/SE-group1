# 模型正文 JSON 转义凭据回显修复

基准 `d0c4042`，独立分支 `codex/model-credential-guard`。目标为修复代码与 Review 适配器只检查原正文 `includes(apiKey)`，导致有效 JSON 字符串中的 Unicode/slash 等转义可还原配置密钥并被接收的问题。只改两个适配器及对应测试，按需增加共用正文检查器、专测及本文；不改传输、依赖、行号证据或历史报告。

## 设计与范围

新增 `guardModelContent(content, apiKey, maxBytes)`，输入只允许原始字符串和角色已有的有界预算。先检查字面回显，再线性扫描完整 JSON 字符串 token，使用无 reviver 的 JSON.parse 仅解码单个字符串，不解析对象、不读取属性、不 eval 或递归。检查字符串值和键的同一层 JSON 转义，支持 Unicode、slash、引号和反斜线；整体正文截断或非法但已包含完整合法字符串时，也会在保存回执前检查该字符串。无命中保持原文逐字不变，不修复 JSON 或提案。

发现配置密钥时整正文替换为安全占位，两个适配器都先保存四字段回执和原有 usage/finish 枚举，再以 credential_response 拒绝，不归类为 JSON 格式重试。预算仍为编码512KiB、Review128KiB；正文检查器自身不接受超过硬上限的输入。Review policy hash 另外绑定检查器版本及实现源码 SHA256，未来检查器变化不能沿用旧策略哈希。

只识别实际配置密钥的字面值和一层合法 JSON 字符串转义；不解释 JS 代码、嵌套字符串里的再次解析、base64、拆分拼接或任意计算秘密。凭据仍须由平台保留在候选与模型输入之外；此检查不替代运行隔离或完整秘密扫描。

## 验收计划

全部使用合成密钥和 mock 响应，验证两适配器的转义值/键、混合转义、异常 finish、原回归、普通合法/非法 JSON 原文不变、极深及有界扫描、无 getter/代码执行、回执不能还原密钥、usage/枚举保留以及 Review policy 对 helper hash 的实际绑定。执行对应专测、语法和 diff 检查后固定提交，供另一 Agent 复验。

不调用真实 API/付费模型，不读取真实密钥，不执行模型代码，不修改旧5dc候选或任何私有历史。策略变化后的真实复验由根控制器另行决定。计划尚不构成完成证据。

## 本轮实际检查

`node --test tests/model-content-guard.test.mjs tests/project-code-model.test.mjs tests/project-review-model.test.mjs`：49/49通过，无失败/跳过，所有模型响应均为本机内存 mock。共用检查器与两个适配器、三份测试共6个脚本逐一 `node --check`，以及 `git diff --check` 通过。

新增回归覆盖代码文件 content 与 Review summary 的完整 Unicode 转义、对象键转义、字面/转义混合、整体截断正文内的完整合法字符串；stop、length、content_filter及未知finish都以 credential_response 拒绝并保留真实 usage/finish。回执经 JSON 存储往返后只剩安全占位，不再保留可还原的原正文。未配置回执入口时也拒绝。原字面回显测试改为断言整正文占位，替代旧的逐处替换计数；这遵循本轮明确要求，不改变业务/证据门禁。

共用检查器另测 slash、引号、反斜线、控制字符、Unicode代理对、正常及非法非回显JSON逐字保留、60000层嵌套输入不占用递归栈、128/512KiB边界、非字符串拒绝且不触发转换/getter、不执行正文、短密钥不会出现在占位符中。源码hash直接与helper文件字节核对；三个独立模块mock进程证明改变helper实现hash或版本都改变Review policy hash。行号错位的advisory仍被严格拒绝，原10000行界限和所有传输/取消测试保持通过。

只改授权7文件，无依赖、配置或用户数据迁移。未运行真实 API、付费模型、目标业务重验或全仓集成回归；固定提交先交另一 Agent Review，新策略的真实recheck仍由根控制器单独触发。旧候选和报告未改写。
