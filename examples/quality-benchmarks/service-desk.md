# 服务工单、评论与资产系统 V0

与protocol.md合并作为完整需求。面向同公司不同站点的报修与维修，不接邮件/附件/外部资产系统。模块为认证、资产目录、工单及修改、评论、分派/解决/关闭、审计、响应式界面。应真实从需求形成规格与工程计划，不复用示例spec。

## 角色与主数据

公开账户alice（reporter，east）、bob（reporter，west）、tech（technician，east）、manager（manager，all），密码见公共协议。alice/bob只读写本人工单与同站点资产；tech只看分派给本人的工单及同站点资产；manager看全部并分派。所有成功API返回的ownerId/actorId来自会话。公开资产AS-E1/Pump-one/east、AS-E2/Pump-two/east、AS-W1/Pump-west/west；id/name/site只读。新库无工单/评论/审计；重启不重置。

## 数据、接口与业务规则

真实SQLite表tickets至少有id,ownerId,assetId,title,status,assigneeId,resolution,version，comments有id,ticketId,authorId,text。title trim后1..100字符，可重复；评论text trim后1..500字符。工单asset必须属于reporter站点，外站404。禁止传ownerId/actorId/未知字段。V0没有priority，传它400；它只是未来演进边界，不能提前实现。

| 路由 | 请求/响应与权限 |
|---|---|
| GET /api/assets；GET /api/assets/:id | 列表q/site/page/pageSize，按公共协议；成员不能看外站，manager全站 |
| GET /api/tickets | q/status/assetId/page/pageSize；先行边界后AND过滤与分页 |
| POST /api/tickets | reporter {title,assetId}→201 item含id,title,ownerId,assetId,status:open,assigneeId:null,version:1 |
| GET /api/tickets/:id | 200 item完整字段，越界404 |
| PATCH /api/tickets/:id | 本人reporter仅open状态可{version,title}；200且version+1，stale409；禁止改asset/owner |
| GET /api/tickets/:id/comments | 可见工单参与者，page/pageSize列表 |
| POST /api/tickets/:id/comments | 本人或当前分派tech {text}，仅open/assigned/resolved可发，closed409；201 item；子记录不改变ticket.version |
| POST /api/tickets/:id/assign | manager {version,assigneeId}，仅open→assigned，同站点tech，version+1 |
| POST /api/tickets/:id/resolve | 仅分派tech {version,resolution}，resolution trim1..500，仅assigned→resolved |
| POST /api/tickets/:id/close | 仅本人reporter {version}，仅resolved→closed |
| GET /api/tickets/:id/audit | 所有可见参与者；只读items，无分页，按id序 |
| POST /api/audit | 405，不允许伪造 |

每次创建、修改、评论、分派、解决、关闭分别审计created/updated/commented/assigned/resolved/closed。非法请求、越权、stale以及并发失败均不审计；并发两个同tech独立会话以同version解决，只能一个200、一个409，ticket.version恰加1且仅一条resolved审计，不能因顺序假设放宽结果。不能重开closed或删评论/工单。审计与工单更新同事务。列表total不得泄露外站他人记录。

## 桌面与手机实际流程

/tickets?q=...&status=...&assetId=...保留URL并回填过滤。创建表单ticket-title、ticket-asset、ticket-create；详情ticket-first-open，标题ticket-first-title、状态ticket-status；分派/解决控件ticket-assign/ticket-resolve仅有权用户可见。comment-text/comment-add，首条文本comment-first-text，详情audit-count是本工单真实审计条数。列表重复ticket-row、ticket-total数字字符串、ticket-query/ticket-status-filter/ticket-filter/ticket-next。V0列表contract-version为文本0。资产选择创建后保留；title清空。

独立Edge在两个viewport完整执行：alice创建WEB-<b>one</b>，原文显示；评论<img src=x>原文显示、无资源加载/注入；open态不能出现解决按钮，详情审计2。再建WEB-two/WEB-three，总3、首2条/下一页1条；q=WEB-two且status=open只有它。重载恢复3条；bob会话看不到alice条目和分派按钮。除登录/列表外也必须能实际查看资产、编辑本人open标题、manager分派、tech解决、reporter关闭，按钮权限和错误提示按后端规则；这些完整角色操作由人工补测，HTTP自动合同已核主链。

自动HTTP从空库创建BENCH-Pump-A/B/C和bob外站条目，验证title修改/stale、越界读写、评论、分派角色拒绝、非法提前关闭、并发解决、关闭后评论拒绝、AND组合查询与第二页、6条精确工单审计、重启closed/version5与logout旧Cookie失效。语义域为auth/assets/tickets/comments/workflow/audit/consistency/ui/evolution；应在真实规格中逐条映射，不删异常行为。
