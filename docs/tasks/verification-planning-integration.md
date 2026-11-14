# 独立HTTP测试提案规划接入

基准408064b（上一组合待独立全量），服务候选8b6dd56已串行引入但仍待独立Review。root仅负责server、app/index挂载、HTTP/API与完整浏览器组合；面板与后端各独立3文件。尚不compile/beginCoding或运行目标项目，approved只认可结构化定义，不是软件通过。

新增本地同源HTTP list/propose/revise/approve/reject/cancel，路径派生project/run/proposal身份，精确body不接配置、路径、文件、预算或passed。propose单独确认当前contractRevision并产生模型用量，其余动作绑定当前revision。服务初始化失败释放已建资源，关闭等待相关检查点。需求输入应用由规划、执行、测试提案三个服务共同检查点，任何提案准备/生成/未知回执均阻止新源发布，待应用请求保留。

root接线测试使用真实HTTP/存储和明确可信controller替身只证明路由及字段能力边界；服务自身的真实SQLite/模型adapter模拟另有专测。标准全量、非作者审查及真实模型试用在固定组合后进行，未完成不计产品已具备，也不放宽固定图书业务门禁。
