# 纯需求变更草案组件

基线`d5ffc75d31b5d89076cf3b4ef0e3b9af7072bed4`。本轮只新增本记录、`lib/requirement-changes.mjs`和对应测试，不接入store、编排器、HTTP或UI；不是产品F05已完成，也不执行代码、迁移或审批。

## 最小契约

`inspectRequirementChange({projectId,baseSource,source,baseRevision,reason,kind,previousPlan?})`同步安全复制纯数据并返回深冻结草案。source和baseSource严格为`{filename,content}`，接收已提取的MD/TXT/DOCX正文；文件名仅基本文件名、最多160字符，正文非空、最多现有MAX_DOCUMENT_CHARS（100000）字符。保留原文，不重新解码DOCX或规范化换行。版本直接复用`planning-review.contentRevision`；baseRevision必须精确等于旧source版本，文件名与内容均相同则拒绝。kind仅field/permission/workflow/other，是控制器标签，不是语义证明。

可选previousPlan只接受旧数据投影：`{requirements:[{id,text}],tasks:[{id,dependsOn,requirementIds,writePaths,validationStatus?}],writePaths:[相对路径],persistence?:'present'|'absent'|'unknown'}`。需求与task编号沿用现有planning-review的非空字符串trim契约，不强加REQ前缀、ASCII白名单或128字符限制；声明编号在trim后唯一，依赖和映射同样trim后去重并校验引用与无环图，不要求控制器改号。编号只是文本身份，不用作宿主路径。validationStatus仅可为unknown/not_run/passed/failed，作为历史保留，不转为当前通过；persistence和validationStatus缺失才默认unknown，显式null及非枚举类型拒绝，显式undefined也不是纯JSON。调用方须将旧spec/tasks/engineeringPlan投影为此schema，不接收完整不透明对象或额外命令。writePaths仅作为仓库相对元数据，不授予读写能力，拒绝绝对/宿主/遍历/链接式路径表达。

diff使用保持行结束符的线性共同前后缀单块比较，输出完整removed/added原文及1基行位置；不是最短LCS。重命名单独列出，filename-only的metadataOnly仍要求全量回归。保守影响覆盖全部旧REQ/task/writePaths及所有当前/未来下游；未知影响明确要求全量重新规划、双确认和回归，reusableValidation恒false，代码复用由后续控制器决定。field/workflow在持久化存在或未知时要求迁移审查；审查标记不表示已经迁移。

输入仅自有可枚举数据属性，拒getter/符号/伪原型/循环/非有限数，整个输入最多2MiB、40000节点、深度16；schema再限制1000项需求/task、每数组最多2000项、文本与路径长度。输出最多4MiB。策略版本requirement-change-v2的implementationHash是本模块可信固定源码字节的SHA256（模块加载时仅readFileSync自身URL），policyHash同时绑定此源码hash、版本、限额和保守规则；不读取输入指定文件，也不执行输入。hash为草案除hash字段的contentRevision；固定实现下重复同输入确定相同结果。所有输入立即复制，输出递归冻结。需求中的任何指令都只保留为文本。策略hash不是审批凭证；未来持久化准入仍须可信控制器重新验证。

## 验收

纯测试覆盖字段/权限/流程、增删改/文件重命名、错版本/空变更、快照/冻结/hash、旧通过不继承、图/路径/输入恶意数据及限额；新增文件单独语法检查和diff检查。固定后由非作者独立审查，不调用真实模型，不改用户data。

原f63c18b自测13/13通过，但独立Review发现合法非REQ前缀编号被拒的P2，以及显式null被默认的P3；旧独立BLOCK与原探针结果完整保留。本次修复仍限原三个文件，保留全部13旧测试并新增真实preparePlanningSpec/validatePlanningTasks四组合法编号保持、长编号/trim/非法身份、null/缺省/合法枚举、源码与策略hash变更证据。最终`node --test tests/requirement-changes.test.mjs`为17/17通过，0失败/取消/跳过，121.1921ms；两个脚本`node --check`和`git diff --check`通过。原P2探针另存fix-f63后按修复预期复跑，REQ-001/R1/READ/feature_1四组均通过原规划器及新草案，原文件未改。

新证据保存在本地主工作区忽略的`output/verification/requirement-change-contract/fix-f63/`，含tests.log、requirement-id-probe.mjs/json、policy-hashes.json。没有运行全仓测试、真实模型、目标程序、数据库迁移或产品UI；没有修改原需求、c16工作树、存储与编排代码。此版本固定后仍须非作者独立复验，不表示产品F05完成。
