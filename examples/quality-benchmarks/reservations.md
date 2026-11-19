# 资源预约、占位与候补系统 V0

与protocol.md合并。公司会议资源预约，不接日历/邮件、支付或外部身份。模块为认证/资源目录、唯一占位、确认/取消、FIFO候补、授权提升、审计和桌面手机界面。slot是业务标识YYYY-MM-DD-AM或PM（真实有效日期），不依赖系统今天，不自动超时释放，避免不可控计时测试。

## 角色、资源和行边界

alice/bob/carol/dave为member/east，scheduler为scheduler/all；密码均用户名-demo。member可看east资源、本人bookings/waitlist；scheduler可看全部并提升候补，但不能冒用成员确认。初始资源ROOM-A与ROOM-B（名称同ID，east、capacity=1），ROOM-W（west、capacity=1）。同resource/slot最多一个held或confirmed占位。新库无预约/候补/审计；capacity不能被请求改。成员外站资源404，访问别人预约/候补也404。

## 数据与状态协议

bookings(id,ownerId,resourceId,slot,reference,status,version,holdKey)，waitlist(id,ownerId,resourceId,slot,reference,status,version,sequence)，以及audit。reference trim1..80全局唯一。queued候补不在bookings列表，提升时新建同reference的held booking并关联原waiter，候补status=promoted。原waiter不可被反复提升或删历史。成员同resource/slot已有active booking或queued waiter时不能重复入队；queued只能在资源已满时加入，空位400 invalid_input。

| 路由 | 合同 |
|---|---|
| GET /api/resources；GET /api/resources/:id | q/site/page/pageSize、只读id/name/site/capacity |
| POST /api/holds | member {resourceId,slot,reference,key}→201 item(status=held,version1)，已满409 capacity_full；同命令同body重放200 replayed:true不新占位 |
| GET /api/bookings；GET /api/bookings/:id | 列表q/reference/status/resourceId/page/pageSize，先行边界；detail完整item |
| POST /api/bookings/:id/confirm | 本人member {version}，held→confirmed，version+1；stale优先409 |
| POST /api/bookings/:id/cancel | 本人member {version}，held/confirmed→cancelled，version+1、释放容量；cancelled再取消409 |
| POST /api/waitlist | member {resourceId,slot,reference}→201 item含id,position（目前queued的FIFO排名，从1） |
| GET /api/waitlist | resourceId/slot/page/pageSize，member只自己、scheduler全部；items按sequence升序 |
| POST /api/waitlist/:id/promote | V0仅scheduler {version}，要求该resource/slot已空且它是最早queued；200 item为新held booking。不能跳过更早waiter，非空/非首位409 |
| GET /api/availability | resourceId/slot，公开给有权看资源的成员，返回{held,confirmed,available,queued}数量，不泄露他人ID/姓名 |
| GET /api/audit | resourceId/slot；scheduler只读items升序，全站事件 |
| GET /api/bookings/:id/audit | 本人或scheduler，只读items；由候补提升的booking包括它原queued事件 |

V0取消只释放，不自动提升；这是未来流程演进边界，不能提前实现。held/queued/confirmed/cancelled/promoted按真实动作审计；提升actorId=scheduler，fromStatus=queued、toStatus=held。取消与释放、提升与占位、确认、排队均要求SQLite事务及唯一约束。两个member同时占同资源slot，必须201+409，最终held1/confirmed0/available0；不能同时拿到位置、先答成功再回滚或多记审计。同key不能绕过容量检查。重复排队409、stale409、越界404，失败不审计。

## 桌面手机验收

/bookings支持q/reference/status/resourceId的URL筛选，列表booking-row/booking-first-open，表单booking-resource/booking-slot/booking-reference/booking-hold/booking-wait，详情booking-status/booking-resource-id/booking-confirm/booking-cancel/audit-count；入队成功waitlist-position文本真实排名。/waitlist?resourceId&slot供scheduler查看FIFO列表，waitlist-first-promote提升第一条，waitlist-total数字字符串。其余分页/筛选提供有标签控件和真实total；没有权限的动作不显示。

Edge每viewport：alice在2030-05-02-AM占ROOM-A后确认；bob独立会话同slot候补第一，不能看到alice预约；alice取消；scheduler真实点提升；bob刷新看到held并确认，该booking含queued/promoted/confirmed共3审计。按WEB/status组合过滤、刷新状态一致。HTTP另在2030-05-01-AM争抢唯一位置；PM中alice占/确认，bob/carol顺序排队，取消后V0仍空1/queued2，再手动提升bob，最后confirmed，PM总7审计；分页/越界/stale/重复/非法slot/重启/logout全部固定。人工另核资源页、实际多页列表、取消重复按钮、候补非首位拒绝、焦点与手机操作。语义域auth/resources/bookings/waitlist/workflow/audit/consistency/ui/evolution。
