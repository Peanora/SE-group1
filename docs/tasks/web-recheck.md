# 固定模型候选重新检查

## 本轮上下文与独立输出契约（基线2365067）

仅修改本记录、`lib/web-recheck.mjs`、`tests/web-recheck.test.mjs`。不改CLI、服务、UI、模型适配器或原执行数据，不调用付费模型。

- `inspectWebRecheckSource`和`startWebRecheck`增加可选`sourceBinding`，只接受五个自有、可枚举的数据字符串字段：`projectId/runId/taskId/specRevision/planRevision`。编号和SHA256格式严格校验，taskId须为library-web-v1，每项精确匹配原报告；首次await前复制绑定，拒绝getter、符号及额外字段，新选项自身的getter也不执行。不接受sourceRevision：上传快照版本由服务关联，这五字段元数据不是人工审批凭证，服务仍须提供可信当前规划与原持久row。
- 无sourceBinding时保留原canonical规格及新currentPlan逻辑。提供时新记录继承真实来源的五字段，新attemptId、当前HTTP/browser/Review policy绑定和全部fresh检查不变。
- `startWebRecheck`增加可选`outputDir`，默认executionRoot。先准入原来源并检查当前归属，再校验/创建独立输出根的完整无链接父链；拒绝文件系统根、原来源记录目录及工作区内的目标。新根下独占web-recheck-*内容快照不含.git，原真实commit、报告、Git和回执不写入。取消前后均检查信号。
- Inspector的summary增加sourceExecutionRoot和sourceBinding，连同已有原report路径/hash、sourceWorkspace/commit/hash、codingReceipts及files，供可信服务重核原来源与fresh快照；不把快照伪造成新Git仓库。

验收覆盖默认兼容、精确绑定与畸形输入、独立两根、路径链接/原workspace拒绝、来源不变、两根取消/未知停止和真实MXC错误候选。实现自检固定提交后交另一Agent独立审查；真实模型正向由根控制器另行授权执行。

返回结构明确为`inspect -> {source, summary, files}`，其中source是原报告副本、files是准入后的允许源码文本数组。summary包含`sourceExecutionRoot/sourceBinding/sourceExecutionId/sourceReport/sourceReportHash/sourceWorkspace/sourceCommit/sourceHash/sourceUsage/sourceCodingCalls/sourceModelCalls/codingReceipts/sourceShellHash`；codingReceipts各项为`{attempt, receiptPath, receiptHash, model}`。start新记录的provenance与此summary一致，record.workspace只指向新的无.git快照，candidateCommit仍为sourceCommit。服务应从其受控持久row与当前规划提供绑定，重跑inspect并比较来源报告hash、提交、源码和shell，再核对新快照；本接口不验证宿主目录所有权或代替未来跨进程认证。

本轮自检：`npm run check` 77脚本通过；显式真实MXC的`node --test --test-concurrency=4 tests/web-recheck.test.mjs`最终22/22通过，0失败/取消/跳过，73565.3128ms，含原默认与新独立两root真实错误候选各一项。另只读核对真实网页原候选`bcec69b2d700457398a997a9370cf98543b3e1b8`：默认canonical拒绝，精确上下文准入成功，4个允许源码文件及Git/blob/回执/停止证据通过；原报告仍failed、SHA256前后相同，无本轮Review。证据留在本地主工作区忽略的`output/verification/web-recheck-context/`。未运行付费模型、未修改原业务/QA数据、未运行全仓401回归，服务/UI接入与独立验收另行完成。

本组件只重新检查控制器已有的 `library-web-v1` 模型候选，不生成或修复代码、不继承旧成功或失败结论，也尚未接入浏览器规划服务。旧执行报告、原 Git 仓库、原模型用量全部保持原样。本轮实现和普通测试不调用真实模型。

## 可信入口与来源

`inspectWebRecheckSource({executionRoot, sourceReportPath, sourceBinding?, signal?})` 只读返回 `{source, summary, files}`。根目录须为可信服务拥有的现存绝对目录，记录必须是其下 `web-execution-*/execution.json`。首版不接受客户端报告对象、ZIP 或递归 recheck 链。宿主目录所有者主动伪造私有历史不在本组件威胁模型内；普通 JSON 的 `providerKind` 本身不是认证。

来源必须保留至少一次编码模型请求的四字段私有回执、实际内容哈希、正常结束与对应文件建议。校验原工作区是报告同级 `workspace`，当前 HEAD、干净状态、允许源码哈希、原提交的逐文件 Git blob 以及当前保护外壳完全匹配。所有路径父链、文件/目录拒绝链接与硬链接，读取有大小上限。Git 只读检查禁用可选锁、hooks、fsmonitor、系统和用户配置，不刷新原索引。来源运行必须已终止且保存了真实停止证据；未知停止不能复验。

`startWebRecheck({executionRoot, sourceReportPath, sourceBinding?, outputDir=executionRoot, reviewer, reviewerKind='model', executable=process.env.EXECUTION_SANDBOX_EXE, signal, timeoutMs=180000, maxReviewCalls=2, onEvent, assertCurrent})` 返回 `{id, cancel, done, snapshot}`。配置必须来自可信控制器。`assertCurrent(binding)` 在各阶段前后检查当前归属；它不是候选回调。总预算最大600秒，Review最多两次。

## 新记录与版本

新建独占 `web-recheck-*` 目录及新 id/attemptId。`workspace` 是只含同源允许文件与当前相同保护外壳的私有快照，不伪造 `.git` 或新提交。`candidateCommit` 始终指原真实 Git 提交；provenance 记录原执行编号、报告路径/哈希、原 Git 工作区、原提交、源码哈希、原用量、原编码调用数及私有回执路径/哈希。当前外壳变化时拒绝复用旧提交。

本次 `providerKind:'model'` 表示代码继承真实模型来源；`calls:0` 明确本次没有编码请求。`modelCalls`、`reviewCalls`、`totalModelCalls` 和 `usage` 只记录新 Review。未知 token 为 `null`，不记为零。原用量仅在 provenance，不能重复计量。

默认specRevision绑定当前`webProfile.task`的JSON SHA256，必须与来源相同；新planRevision绑定当前HTTP/browser清单。可信控制器明确提供sourceBinding时，spec/plan沿用精确匹配的原规划上下文。两种模式的所有新分支均绑定相同project/run/task、新attempt、原提交、sourceHash、spec/plan、当前HTTP/browser manifest和Review policy。每阶段前后重新检查原报告、原Git、原源码、快照和外壳。新源码不写原仓库；新验收文件只保存在新目录。

## 重新验收与停止

先运行新 HTTP/SQLite 自检；完整通过后，独立 HTTP/SQLite、真实浏览器和新 Review 并行，全部结束才判定。固定注册检查必须完整且通过，数据库观察命令、运行进程及浏览器必须有正常停止证据。原 report 的 passed、候选 tests 和完成标记都不能替代这些新结果。

Review 使用当前严格结构及逐字行号证据校验。合法历史阻塞问题须逐条给 resolution；无效旧 Review 不转成通过意见。响应结构或行号证据无效时，最多在剩余预算内对同一代码重核一次；不得改代码、不得对凭据/回执失败自动重试。模型回执使用 `{model, finishReason, usage, content}` 四字段、私有 `wx` 文件及 SHA256。收到的正常回执即使结论无效也记录真实用量；迟到取消回调不写文件或改结果。

最终模型身份必须满足现有 `isWebTaskAccepted(record)` 完整门禁，diagnostic 永不 accepted。业务失败或阻塞返回 failed/changes_requested，后续编码修复是另一任务。取消与总时长耗尽停止新阶段；真实进程未确认终止时保留 PID、控制目录/预检目录和结果，状态 reconciliation_required。组件不把请求取消说成 OS 已停止。

## 命令

默认仅查看，既不启动应用也不调用模型：

```text
node scripts/recheck-web.mjs --record <绝对execution.json> --execution-root <可信执行根>
```

只有明确的付费参数组合才运行新模型 Review；不能自动执行此模式：

```text
node scripts/recheck-web.mjs --record <绝对execution.json> --execution-root <可信执行根> --run --model-review
```

CLI 输出新结论、新 Review 用量与原来源说明，不输出源码或私有回执正文。真实模型正向复验仅由根控制器明确触发；普通测试的可信替身只验证控制器判定，不证明业务软件通过验收。

## 原组件历史检查

基于 `702d318`，依赖已固定的 Review 编号行策略 `bef5d66` 与浏览器匿名诊断修复 `f709edc`。本组件只新增本记录及三个授权入口/测试文件。

- `node --check` 检查 `lib/web-recheck.mjs`、`scripts/recheck-web.mjs`、`tests/web-recheck.test.mjs`，全部通过。
- `TASKFLOW_TEST_REAL_SANDBOX=1 node --test tests/web-recheck.test.mjs`：15/15 通过，0 skip；包括临时 Git 来源、边界/链接/篡改、当前完整门禁、旧结论不继承、0 编码、三方结束、格式重核、四字段回执、未知用量、合法历史问题、取消/总预算、未确认停止证据及真实 MXC 错误候选负例。
- 只读 CLI 核对原真实候选 `5dc88cd31f0aa7649458a58ab386e23d3ff1e6a2` 及源码 `00765b4558a856cd9d6cee773c2abaf41e4c24c37aac4f5ca0ebd89221d79211`，原报告仍为 failed，当前外壳匹配。此检查没有生成新结论，没有模型请求。

未执行新的真实模型 Review 或完整正向业务复验；也未将组件接入 server/规划 API。固定提交后先独立审查，再由根控制器按明确授权运行原候选的新一轮验收。
