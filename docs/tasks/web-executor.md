# 固定Web模型候选的保留源码修复入口

基线`4df6c8d0800390a638f10c7a3d858a2567b5e0b8`，独立分支`codex/web-repair-seed`。只修改`lib/web-executor.mjs`、`tests/web-executor.test.mjs`及本记录；不改service/UI、共享模型、Review validator或recheck，不调用付费API、不写原候选。

## 最小可信契约

`startWebExecution`新增可选`initialSource:{files,sourceExecutionId,sourceCommit,sourceHash,sourceReportHash,reviewSourceExecutionId?,reviewSourceReportHash?}`及`previousIssues`。Review来源两字段必须成对。来源不是审批凭证；仅可信服务完成原报告/Git/回执/停止与当前归属准入后注入，不向HTTP/CLI开放路径或原始绑定。源execution ID为控制器已核对的原核心报告id，Review来源id为提供新阻塞问题的核心报告id；服务自身row ID另由服务关联。

新数据在首次await前检查own data descriptor并深复制，有8MiB编码输入、20000节点和深度16上限，拒getter/函数/符号/循环/非纯对象。files每项精确path/content，走canonical validator并与sourceHash精确匹配；commit为40hex、hash为64hex、来源ID为标准字母数字下划线/短横线。previousIssues仅随seed，最多20项，id唯一、severity=blocking、status=open，file/line/evidence通过现有validateProjectReviewResponse核对。完整项保留id/status等及可选originCommit/checkedCommit/resolution，不放宽旧问题关闭要求。

新工作区装入完整seed和当前保护外壳，真实git init并提交新的baseline，不复制.git、不伪造原commit。record.baseCommit是新库真实提交；seed执行kind仍web_execution，repairSource只保存原commit/hash/report/Review来源及原问题，不放旧tokens、不使用recheck的provenance。provider看到原files和具体失败反馈；正常新模型回执和用量按原流程计。每个新候选的完整sourceHash必须不同于seed，旧blocking沿新Review的previousIssues/resolutions显式复验。自检、独立HTTP/browser/Review均全新运行，旧passed不继承。assertCurrent、取消和预算全程保留。

`repairSource`精确为initialSource去除files后加`previousIssues`的独立副本。已经在中间候选被判resolved的原seed问题，若还需下一候选，仍重新进入下一次Review的previousIssues；新open问题一起合并，超出20项则停止自动返工，不静默丢问题。最终候选必须再次逐项显式关闭原问题。模型若不改任何文件，或后续轮次完全回退成原seed的sourceHash，均不会进入该轮Review。

无seed时普通入口和原修复循环保持兼容。本轮仅提供核心能力，服务来源准入/收费确认/UI接入与真实模型修复验收另行进行；不能把可信mock通过说成真实目标软件已修复。

## 实际验证与交接

- 普通专项先运行19项：16通过、三个原生项明确跳过；随后显式指定已验证MXC程序和`TASKFLOW_TEST_REAL_SANDBOX=1`运行同一完整专项，**19/19通过、0失败/取消/跳过，24581.6242ms**。保留全部原12项并新增7项，包括两项输入边界与getter、真实新Git基线/原文件/问题/回执/仅新用量、无改动/回退、缺失或open resolution、多轮新阻塞与已关闭原问题重核、自检失败保留问题、取消/总预算/unknown/late current。
- 三个实际MXC项只运行受控失败候选；新增seed负例建立真实baseline与新candidate，重新运行18项HTTP/SQLite自检并失败，Review未调用，下载/验收未开放，0付费。正向完整门禁、浏览器分支和多轮问题关闭均为显式可信依赖mock，不能作为真实业务通过证据；没有宿主导入候选代码。
- `npm run check`为**87脚本通过**，两个变动脚本单独`node --check`通过，`git diff --check`通过。测试用临时目录及合成来源/问题，原report fixture字节保持不变，未触碰真实QA来源或其它工作树；未改package/共享module/CLI/service/UI，未跑全仓集成回归。
- 本地主工作区忽略证据为`output/verification/web-repair-seed/{ordinary-tests.log,real-tests.log,test-meta.json,check.log}`。固定后等待不同作者独立Review；再由根串行集成受控来源准入与收费UI，并单独授权必要的真实模型修复验收。
