# 独立测试提案网页面板

基准8663d36，独立分支codex/verification-plans-panel。唯一写入public/verification-plans.js、tests/verification-plans-panel.test.mjs及本记录，不接主页面或修改HTTP/后端。目标是可独立挂载、可编辑和审阅的HTTP结构测试定义面板；不运行/编译测试，不修改固定图书验收门禁，不把人工认可定义宣传为软件通过。

组件契约：createVerificationPlans({api,getContext,onError?})返回mount(element)、refresh()、destroy()。getContext提供projectId/runId/specRevision/planRevision/planningStatus；3秒轮询。所有请求相对`/api/projects/:pid/runs/:rid/verification-plans`，propose仅contractRevision，revise仅revision/proposal/feedback，approve/reject仅revision/feedback，cancel仅空对象。仅后端DTO动作、当前上下文和当前revision授权，收费propose另需双确认、64hex契约、有界已知预算、模型和当前费用勾选。

项目/运行/规格/计划切换使用递增epoch与独占action token，最新GET才能发布；旧POST/GET/finally不能跨A→B→A覆盖当前视图。草稿按项目/运行/规划版本/提案revision隔离并保存标签会话；轮询不重建输入节点或覆盖正在编辑的内容。新revision到达保留旧草稿并撤旧保存/认可许可，需显式载入当前。保存修订与认可分离；POST成功后由相匹配的新GET确认，GET失败或未知结果只显示待核对，不自动重发。

全部正文、DSL JSON、错误和模型反馈按文本展示；独立局部样式沿既有白底蓝灰面板，无共享入口改动。真实系统Edge使用固定平台UI API fixture验证桌面/390×844、焦点/选区/details、费用及精确body、当前绑定/版本/迟到/ABA、失败恢复、未知用量和文本安全；不调用真实付费模型、不写真实QA。

已实现独立组件，尚未挂产品入口。mount/refresh返回Promise<boolean>，表示当前GET是否发布；destroy同步移除面板、终止轮询并撤销迟到发布资格。POST返回的proposal不直接成为当前操作权限；待确认意图独立保存，最新GET即使超越操作自己的确认GET，仍能按相同项目/运行/epoch、私有binding、revision及历史/definition_only审批确认。旧GET/finally和旧操作错误不能撤新许可或解锁新操作；POST失败还会撤销其之前GET的许可，须再取当前状态。请求未知不自动重发。

编辑区节点保持稳定；外部新revision不会覆盖旧编辑或选区，需明确载入当前。保存期间继续输入的内容会保留为旧revision草稿，不随返回值偷偷重设；propose完成也不抢走用户正在编辑的旧记录。标签会话按规划版本隔离，保留最多12份revision草稿、总计约1 MiB，超限先淘汰非当前草稿；浏览器禁止或耗尽会话存储时仅保留当前组件内存，不宣称跨刷新仍能恢复。费用勾选不持久化，模型、契约、预算和上下文变化均清空。未知用量和时限显示未知，不填零。

停止操作仅提交空对象。cancel_requested仍显示等待确认，reconciliation_required继续显示待核对；只有后端终态才显示确认取消等实际状态。历史详情及所有正文用textContent/textarea.value，无HTML注入、软件passed徽标、预览或下载链接；approved仅为定义被认可，不执行或编译测试。HTTP DSL的业务合法性、凭据净化、版本/审批和收费边界仍由后端权威校验，前端JSON解析及许可检查不能替代后端。

最终实际验证：`node --test tests/verification-plans-panel.test.mjs`为真实系统Edge固定平台UI fixture **21/21通过，失败/取消/跳过0，16809.4828ms**。覆盖桌面1440×1000及390×844、3秒真实轮询、焦点/选区/details、费用及精确POST字段、保存与认可分离、驳回和停止实态、当前binding/策略/revision、项目/同项目run/规格版本会话隔离、A→B→A和迟到finally、最新GET成功/失败、确认GET被超越、503后恢复、在途编辑及新记录不抢选、400/409/503/未知结果保留、XSS文本及销毁后不轮询。`npm run check`100脚本语法通过，新增两脚本显式语法和`git diff --check`通过。依赖仅执行锁定的`npm ci --ignore-scripts`，清单/锁文件未改。

日志保存在本树忽略目录output/verification-plans-edge.log与verification-plans-syntax.log。所有API响应均为可控薄UI fixture，未调用真实模型、未运行MXC或目标业务测试，未写真实QA、用户data或.env，未修改后端/共享入口，未推送或部署。固定后须由非作者独立Review，再由根Agent串行接路由/主页面及组合验证；本组件通过不代表产品接线或通用验收能力已交付。
