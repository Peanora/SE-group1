# Review v2与同候选有界格式重试

2026-11-18。目标来自i12真实notes-tags15calls失败：FINAL3次Review均完整stop但JSON非法，TAGS1次为合法JSON的evidence缩进不匹配；原费用和失败已封存。本轮只做通用修复与免费验证，不调用收费模型、不新图、不修改原v1/i12原件或追认通过。

独占范围：lib/project-review-model.mjs、lib/planned-web-executor.mjs、lib/planned-source.mjs及直接相关测试/本记录。必要Worker seal/helper若需改动先报根。复用现标准化validator、原native传输证据、预算、Git/source绑定及历史receipt链。

契约：native显式wire v2只收summary/issues[{severity,file,line,message}]/resolutions；严格decoder验证字段、候选位置、旧issue覆盖后由controller固定源码行派生literal evidence，清楚标记来源。最终validateProjectReviewResponse保留严格原样evidence验证供core/fixture。原v1 receipts维持v1；原JSON不修补/trim/拼接。新的policy/schema显式版本化。

只对native完整已停、回执已落盘、finish stop且invalid_model_response的格式/位置错误，原maxReviewCalls/全图calls/原deadline内同candidate重Review；独立callId/原receipt/usage全保留，无重编码。有效blocking继续编码真实修复，未知/取消/密钥/回执失败不可自动再派。新responseFeedback只带受控enum/字段位置/有界数字，不回传原模型字符串。既有同版独立HTTP/Edge/旧blocking全覆盖和Worker恢复/交付门禁不放宽。

预定验证：v2完整本地HTTP/引用派生/字段与旧ID负例；原v1负例不追认；真实Git同候选多Review/无多coding、原额度耗尽与unknown停止；source replay/篡改/历史保留；必要真实独立Worker及恢复。具体结果在完成后补记，固定新版本由独立Test/Review验收。

根后续明确的严格行为：所有非eligible Review异常（包括完整但非stop的length/unknown finish）停止本次后续模型派发，不能转成自动再coding；真实HTTP/browser失败与格式错误并存时先编码修复，不对已知坏候选重Review。旧自动length回归升级为“原图停止+正式显式新修复保留旧source/费用/额度”，原首红与i12旧测试/收费原件保留。

根另允许窄扩lib/planned-delivery.mjs（F11）：仅移除ZIP中运行时restoredHistoricalDelivery字段。实际whole+initialSource首下载与恢复包仅该标记false→true、索引bytes/hash变化，原两ZIP与entry-diff在output/review-wire-v2/delivery-before；该字段无授权消费者，API checkpoint.restored保持真实。修后仍按原逐字同ZIP断言复验，不硬写true或归一化包来通过。

作者收尾：生产最终范围为上述4文件；没有改Worker seal、账务、预算常量或服务数据库。测试范围为project-review-model、review-wire-v2、planned-web-executor、planned-proposal-repair、planned-integration-rework、planned-checkpoint-service、planned-worker-history、planned-worker-review-format及tests/fixtures/planned-worker-api.mjs（共9文件）。该共享测试helper按根授权显式loadEnv:false；此前沿用原helper时可能隐式加载本地配置，但所有模型端点/模型/key由测试固定为localhost或synthetic，无真实模型调用；原.env未修改。新的用例只用隔离output数据。

实际免费验证：final-related.tap为92项，90通过、0失败/取消、2项可选真实ZIP诊断未启用；随后archive-history-final.tap启用真实MXC/Edge，补跑两项ZIP诊断及whole历史修复/恢复/原回执篡改，共4/4。native-isolated-final.tap为5/5，实际独立Worker首派、格式重Review、暂停/跨代、API关闭重开、两次同ZIP及原length停止后正式同run修复/费用保留均通过。最后新增本地派发前错误停止断言local-predispatch.tap为1/1。以上有重叠，不相加为唯一全仓数量；本轮未跑全仓，独立固定版本Test/Review由根调度。

原始首红均保留：旧v1 native/自动length语义迁移；whole夹具误用图reservation及状态；F11首下载/恢复ZIP不一致。一次旧夹具超时退出关闭synthetic模型后留下隔离job reconciliation_required/usage未知（case-yfHNgC），原回执与私有库不修补、不造0；对应Worker PID已不存在。后续独立新case通过不能追认该旧case。真实收费i12/i10旧图仍失败，不修原JSON、不追认通过。费用为0，普通synthetic模型调用的模拟usage仍逐call保存。源范围/差异、各命令和原件完整性见output/review-wire-v2/HANDOFF.md及scope-manifest.json。完成源码和测试写入后由根冻结i13；没有提交、推送、部署或改主服务。
