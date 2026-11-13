# 模型正文 JSON 转义凭据回显修复

基准 `d0c4042`，独立分支 `codex/model-credential-guard`。目标为修复代码与 Review 适配器只检查原正文 `includes(apiKey)`，导致有效 JSON 字符串中的 Unicode/slash 等转义可还原配置密钥并被接收的问题。只改两个适配器及对应测试，按需增加共用正文检查器、专测及本文；不改传输、依赖、行号证据或历史报告。

## 设计与范围

新增 `guardModelContent(content, apiKey, maxBytes)`，输入只允许原始字符串和角色已有的有界预算。当前v2先检查字面回显，再对完整原文做一次已知JSON escapes解码，仅用于凭据匹配，不依赖整体引号配对。支持Unicode、slash、引号、反斜线及JSON控制字符短转义；未知/残缺转义原样保留，解码结果不再重扫或二次解码。不解析对象、不读取外部属性、不 eval 或递归；正文前后多余引号、非法或截断结构不能使其中同层转义失去检查。无命中保持原文逐字不变，不修复 JSON 或提案。

发现配置密钥时整正文替换为安全占位，两个适配器都先保存四字段回执和原有 usage/finish 枚举，再以 credential_response 拒绝，不归类为 JSON 格式重试。预算仍为编码512KiB、Review128KiB；正文检查器自身不接受超过硬上限的输入。Review policy hash 另外绑定检查器版本及实现源码 SHA256，未来检查器变化不能沿用旧策略哈希。

只识别实际配置密钥的字面值和一层合法 JSON 字符串转义；不解释 JS 代码、嵌套字符串里的再次解析、base64、拆分拼接或任意计算秘密。凭据仍须由平台保留在候选与模型输入之外；此检查不替代运行隔离或完整秘密扫描。

## 验收计划

全部使用合成密钥和 mock 响应，验证两适配器的转义值/键、混合转义、异常 finish、原回归、普通合法/非法 JSON 原文不变、极深及有界扫描、无 getter/代码执行、回执不能还原密钥、usage/枚举保留以及 Review policy 对 helper hash 的实际绑定。执行对应专测、语法和 diff 检查后固定提交，供另一 Agent 复验。

不调用真实 API/付费模型，不读取真实密钥，不执行模型代码，不修改旧5dc候选或任何私有历史。策略变化后的真实复验由根控制器另行决定。计划尚不构成完成证据。

## 第一固定版本实际检查（历史）

`node --test tests/model-content-guard.test.mjs tests/project-code-model.test.mjs tests/project-review-model.test.mjs`：49/49通过，无失败/跳过，所有模型响应均为本机内存 mock。共用检查器与两个适配器、三份测试共6个脚本逐一 `node --check`，以及 `git diff --check` 通过。

新增回归覆盖代码文件 content 与 Review summary 的完整 Unicode 转义、对象键转义、字面/转义混合、整体截断正文内的完整合法字符串；stop、length、content_filter及未知finish都以 credential_response 拒绝并保留真实 usage/finish。回执经 JSON 存储往返后只剩安全占位，不再保留可还原的原正文。未配置回执入口时也拒绝。原字面回显测试改为断言整正文占位，替代旧的逐处替换计数；这遵循本轮明确要求，不改变业务/证据门禁。

共用检查器另测 slash、引号、反斜线、控制字符、Unicode代理对、正常及非法非回显JSON逐字保留、60000层嵌套输入不占用递归栈、128/512KiB边界、非字符串拒绝且不触发转换/getter、不执行正文、短密钥不会出现在占位符中。源码hash直接与helper文件字节核对；三个独立模块mock进程证明改变helper实现hash或版本都改变Review policy hash。行号错位的advisory仍被严格拒绝，原10000行界限和所有传输/取消测试保持通过。

只改授权7文件，无依赖、配置或用户数据迁移。未运行真实 API、付费模型、目标业务重验或全仓集成回归；固定提交先交另一 Agent Review，新策略的真实recheck仍由根控制器单独触发。旧候选和报告未改写。

## 1bcb独立Review P2：leading stray quote

独立Review虽确认原49项通过，仍以P2阻止`1bcb325`放行：在合法含转义密钥的JSON前加一个多余双引号，旧扫描器把引号非重叠配对起点移位，保留了可还原token，并在两个适配器中仅报可纠正的invalid_model_response。原探针、报告和失败历史保持原样。

本次仅修检查器及对应测试/本文，不改两个适配器的传输或证据代码，也不同时修改`verification-model`工作区。版本升为`json-escape-credential-v2`，Review policy仍自动绑定helper版本和源码hash。检测解码的每次迭代消耗1、2或6个原输入UTF-16单元，最多固定4个前瞻字符；已消费单元不重新作为起点，也不检查已解码结果中的新转义。保留原文片段与解码单元的总长度不超过输入长度，最后只join一次并匹配。字节校验、字面匹配、检测解码及最终匹配均为固定次数的有界扫描，总时间/空间为O(正文长度)，受既有128/512KiB上限约束，不产生重叠候选的二次复杂度。

`node --test tests/model-content-guard.test.mjs tests/project-code-model.test.mjs tests/project-review-model.test.mjs`：54/54通过、无跳过。新增12种前缀×8种后缀错位矩阵及非回显原文对照；单双反斜线1至6个的奇偶结果与单次JSON.parse字符串解码对照；最大128KiB引号/escape噪声与60000层旧回归仍通过。两个适配器覆盖leading quote、前后slash/quote错位和单引号框架，stop/length/unknown全部credential_response、回执占位、usage/枚举保留，不能作为格式重试。6脚本语法及git diff --check通过。

本轮无真实密钥/API/付费模型，不执行模型代码，不更改旧5dc候选或任何报告。固定新版本交platform独立复验；依赖未放行前不升级下游结论，verification-model后续只能在根控制器安排下更新到已复验的新helper。
