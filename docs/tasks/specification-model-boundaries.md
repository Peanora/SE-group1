# 规格模型适配器边界

基准 d5ffc75；独立分支 codex/specification-model-boundaries。本轮只修改 planner.mjs、原 planner 测试及新增专项测试/本记录，不改本地规则、编排器、产品 API/前端、共享凭据 guard 或其他模型适配器。

## 目标与最小契约

- 保留 analyzeWithModel(sourceText, projectName, options) -> Spec；正常 stop 的裸 JSON 和代码围栏继续兼容，原文引用仍经现有 checkModelSpec 校验。无格式自动重试。
- options 仅可信 config/fetchImpl/signal/timeoutMs/onReceipt；config 仅 baseUrl/model/apiKey，数据字段在 await 前检查自有 descriptor 并复制，函数只作为可信回调。源文原始及规范化后均最多100000字符，项目名最多1000字符。请求JSON最多768KiB。URL限HTTP/S且无userinfo/query/hash。
- 缺省 LLM_TIMEOUT_MS 仍按原先数值/90000默认及1000..120000夹取；显式 timeoutMs 为1..120000整数。总deadline覆盖fetch、真实字节流读取与可选receipt，即使工具不配合signal也停止等待；迟到响应取消body，迟到结果/receipt不被接受。
- 响应 envelope 最大1MiB（实际bytes，严格UTF8）；message.content 最大512KiB以复用现有guard v2硬上限。只接受finish_reason=stop，已知非stop及unknown均拒绝，length保留明确截断错误。异常不带配置地址、正文、凭据或底层cause。
- 配置已知凭据若出现在输入原文/项目名/模型名则拒绝发送，不静默修改文本。响应原文在解析、结构校验与finish拒绝前经过共用guard；字面/JSON转义/重复键/畸形内容命中时回执为安全占位且credential_response失败，无hook也拒绝。
- 可信可选onReceipt收到四字段{model,finishReason,usage,content}，usage已知非负安全整数或null；正文未回显时保留原样。回执保存失败不放行，取消后不开始新的回执。适配器停止等待并拒绝迟到结果，不能撤销已进入可信hook的外部副作用；控制器须协调其私有I/O，不把请求取消当成OS进程或落盘已停止。返回仍仅Spec，不宣称产品已记录元数据或完成整体预算。

## 基线实际复现

合成key和mock响应证据位于本地忽略目录 output/verification/specification-model-boundaries/baseline-probe.mjs/json，未用真实配置：密钥被写入Spec.summary；content_filter/tool_calls/unknown/missing finish被接受；1200429字节的UTF8响应全部读取并接受且未取消；显式25ms预算和外部signal均被忽略，100ms后仍等待。旧问题证据保留，不把它们记成修复后通过。

## 验收

保留原planner/local测试，仅将两项成功/引用失败的旧mock补合法stop元数据，不放宽原业务断言。新增mock覆盖input/config快照、finish、guard/输入拒发、UTF8/bytes、非合作fetch/read/receipt取消和timeout、latebodycancel、固定错误、receipt和unknown usage、无重试。完成后跑相关模型/规划测试、语法及diff检查，固定提交交非作者Review；0真实API/付费调用/用户data，尚待独立复验。

## 实际自检与交接

- 新增专项17项；原planner的13项本地/模型测试保留。相关联合命令为 `node --test --test-concurrency=4 tests/specification-model-boundaries.test.mjs tests/planner.test.mjs tests/model-config.test.mjs tests/model-content-guard.test.mjs tests/code-model.test.mjs tests/review-model.test.mjs tests/project-code-model.test.mjs tests/project-review-model.test.mjs tests/verification-model.test.mjs tests/orchestrator.test.mjs tests/planning-review.test.mjs tests/server.test.mjs`：**152/152通过，0失败/取消/跳过，1610.0529ms**。全部模型为mock，HTTP只用本地临时数据。日志见忽略目录 `output/verification/specification-model-boundaries/related-tests.log`。
- 三个变动/新增脚本分别 `node --check` 通过，`git diff --check` 通过。没有修改共用guard、其他适配器、编排器或产品接口；没有新增依赖。
- 只保存了合成基线复现和测试证据，没有真实密钥、模型正文或用户材料。未运行真实模型连通、MXC/浏览器、完整仓库回归或产品预算持久化。
- 候选固定后由非作者独立Review；本轮成功不证明规格业务语义完整，也不代表Spec的receipt/usage已经被产品存档或统一调用预算已经接通。
