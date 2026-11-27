# 需求到设计规格的分层 Review

基线 `4cb40bb`。验收目标是在手动规划的规格停点，用已有工单需求走完逐功能退回、同版复核、整份规格及阶段清单的审阅，最后停在用户对联合包确认。改动覆盖规格评审后端、原规格编辑字段、工作台和定向回归。

## 依据与取舍

- 继续使用 v0.2 的六个节点。逐条需求的业务提案与其他专业提案可并行。借鉴 HAMA 的独立提案、交叉核对、同版汇编和人工决策，已有需求输入继续复用 Taskflow 项目版本。[Workflow Orchestrator HAMA-Loop](https://raw.githubusercontent.com/ycwang-April/SE-TeamPrjoect/main/requirements-engineering/README.md)
- 检查按提案、阶段定义和整份规格逐级汇合。阻塞意见记录负责人、证据、复核条件和版本。修改后重走本规格当前轮，原阻塞继续由原审阅席复核。[NASA 软件同行评审指南](https://swehb.nasa.gov/spaces/7150/pages/16449965/7.10%2B-%2BPeer%2BReview%2Band%2BInspections%2BIncluding%2BChecklists)
- 主责提案与审阅使用独立请求，审阅有明确检查条件。业务分歧提交用户裁决。关闭条件基于已保存证据、同版产物和用户联合确认。[Anthropic evaluator–optimizer](https://www.anthropic.com/research/building-effective-agents#workflow-evaluator-optimizer)

## 验收

- F03 专业提案自查通过但独立席退回时，规格汇编保持等待，API 提前确认返回 409。修订项目外分派拒绝行为后，最新版带旧阻塞历史并由原席复核。此时架构仍未开始。
- 同版规格可读，逐条定义展示行为和格式，阶段定义显示主责、独立审阅、证据与返工。审阅者能在 1440px 与 390px 视口操作。减少动态效果设置适用。
- 隔离工单使用项目自带需求及本机夹具。真实模型模式验证用本机模拟服务。待供应商实测的是不同业务的语义质量和服务商计量。[验证记录](../VERIFICATION.md)
