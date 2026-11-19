# 预约 V1：取消后同事务自动提升最早候补

V0 owned应用由alice真实创建reference=KEPT-R1，ROOM-A，slot=2030-06-01-AM，hold key=kept-r1，随后confirm，保留held/confirmed审计。无其它业务记录。确认STOP/一致快照后新完整需求/规格/工程/联合定义，旧源/数据/费用/Review不改。migration=none，原schema及KEPT-R1保持confirmed与原version/id/owner。

替换V0取消与提升规则：本人成功cancel后，在同一SQLite事务先释放旧active位，再把同resource/slot中sequence最小的queued候补提升为held。一次取消至多提升一人，不能跳号/跨slot/跨资源；无候补则保持空位。提升新booking和候补状态、两条cancelled/promoted审计与原状态更新必须原子；promoted审计actorId=system。持有者取消期间另一个人抢占也不能夺走该已排队位置。

POST /api/waitlist/:id/promote在V1对有权scheduler统一409 automatic_promotion，不再手动提升；角色/行边界检查仍先执行，此禁用路由的拒绝不再检查旧version。UI去掉手动提升按钮，bob刷新即可看到held后自行confirm；不得在前端计时器中假装提升。原预约、容量唯一性、队序、鉴权、幂等、分页、非法状态/重启全部保留。固定定义替换cancel后available/held/queued及promotion actor期望，并检查旧KEPT-R1的confirmed；不得改动旧V0结论。

自动合同包含抢占唯一空位与FIFO取消主链，并同时派发alice取消与未入队dave抢占，必须200+409，bob仍获第一位；多个连续取消、非首位/跨slot及事务内部精确交错应另做独立HTTP故障/事务Review，现DSL不能设内部屏障，不据一次双请求证明全部交错。平台数据复制/哈希/终止/成对激活/回滚门禁另验。
