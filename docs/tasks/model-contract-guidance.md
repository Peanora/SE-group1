# 编码与Review的契约核对提示

基于i14采购真实首轮失败及独立只读核定，补充通用模型提示，不修改代码接纳、测试断言、问题关闭、凭据、模型次数或时限。原三个候选/六回执/首评分及失败均保留；原Review两条要求忽略原body.version的blocking是误报，但另有六类真实静态缺口，不能据此将候选改判通过。

根独占修改lib/project-code-model.mjs与lib/project-review-model.mjs，仅SYSTEM_PROMPT：区分保存的原命令版本与当前实体版本、完整body幂等、JSON数字与query字符串、字面子串与LIKE通配符、错误检查顺序、完整列表/详情字段与明细UI、唯一输入清空及正常登录交互。仅按当前批准任务范围与明确契约适用，不发明额外业务，不接受未提供测试编号/结果作为缺陷依据。Review wire v2/schema、原始回执、路径、用量及预算校验不变；源码策略hash自动换版，不以兼容白名单追认旧运行。

作者实际运行3文件相关测试62/62、0失败/取消/跳过，258.8289ms，日志output/review-semantic-guidance/author.tap，0收费。该结果仅验证适配器/传输/严格wire契约，不证明提示已经改善真实模型质量；新增真实验证仍须固定组合由非作者Test/Review放行。

并行浏览器作者仅修改browser-scenarios.mjs及其直接测试，补同一action额度内就绪等待、固定guard诊断；独占范围无交叉。两者合成i15后统一验收，不沿用作者回归或旧i14结果作为i15通过。当前仍不得提交/推送/部署、修改原data/.env或重启4317。
