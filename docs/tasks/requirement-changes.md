# 纯需求变更草案组件

基线`d5ffc75d31b5d89076cf3b4ef0e3b9af7072bed4`。本轮只新增本记录、`lib/requirement-changes.mjs`和对应测试，不接入store、编排器、HTTP或UI；不是产品F05已完成，也不执行代码、迁移或审批。

## 最小契约

`inspectRequirementChange({projectId,baseSource,source,baseRevision,reason,kind,previousPlan?})`同步安全复制纯数据并返回深冻结草案。source和baseSource严格为`{filename,content}`，接收已提取的MD/TXT/DOCX正文；文件名仅基本文件名、最多160字符，正文非空、最多现有MAX_DOCUMENT_CHARS（100000）字符。保留原文，不重新解码DOCX或规范化换行。版本直接复用`planning-review.contentRevision`；baseRevision必须精确等于旧source版本，文件名与内容均相同则拒绝。kind仅field/permission/workflow/other，是控制器标签，不是语义证明。

可选previousPlan只接受旧数据投影：`{requirements:[{id,text}],tasks:[{id,dependsOn,requirementIds,writePaths,validationStatus?}],writePaths:[相对路径],persistence?:'present'|'absent'|'unknown'}`。REQ与task声明编号唯一；依赖、映射和路径去重，引用与无环图验证。validationStatus仅可为unknown/not_run/passed/failed，作为历史保留，不转为当前通过。调用方须将旧spec/tasks/engineeringPlan投影为此schema，不接收完整不透明对象或额外命令。路径仅作为仓库相对元数据，不授予读写能力，拒绝绝对/宿主/遍历/链接式路径表达。

diff使用保持行结束符的线性共同前后缀单块比较，输出完整removed/added原文及1基行位置；不是最短LCS。重命名单独列出，filename-only的metadataOnly仍要求全量回归。保守影响覆盖全部旧REQ/task/writePaths及所有当前/未来下游；未知影响明确要求全量重新规划、双确认和回归，reusableValidation恒false，代码复用由后续控制器决定。field/workflow在持久化存在或未知时要求迁移审查；审查标记不表示已经迁移。

输入仅自有可枚举数据属性，拒getter/符号/伪原型/循环/非有限数，整个输入最多2MiB、40000节点、深度16；schema再限制1000项REQ/task、每数组最多2000项、文本与路径长度。输出最多4MiB。policyHash绑定版本、限额和保守规则，hash为草案除hash字段的contentRevision；重复同输入确定相同结果。所有输入立即复制，输出递归冻结。需求中的任何指令都只保留为文本。

## 验收

纯测试覆盖字段/权限/流程、增删改/文件重命名、错版本/空变更、快照/冻结/hash、旧通过不继承、图/路径/输入恶意数据及限额；新增文件单独语法检查和diff检查。固定后由非作者独立审查，不调用真实模型，不改用户data。

本轮实际：`node --test tests/requirement-changes.test.mjs` 13/13通过，0失败/取消/跳过，115.2343ms；两个新增脚本分别`node --check`通过，`git diff --check`通过。证据保存在本地主工作区忽略的`output/verification/requirement-change-contract/tests.log`。没有运行全仓测试、真实模型、目标程序、数据库迁移或产品UI；没有修改原需求、c16工作树、存储与编排代码。此提交是待独立审查的纯组件候选。
