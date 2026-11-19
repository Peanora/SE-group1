# 服务工单 V1：新增priority字段

同项目、旧源码和旧owned数据库演进。先运行V0应用，由alice真实创建标题KEPT-T1、assetId=AS-E1的open工单并保留一次created审计；没有其它业务工单。确认STOP后记录源码commit/全部费用与Review、owned数据代次/SQLite一致快照，再发布新需求，重新真实规格/工程/验收定义双确认。旧需求/计划/数据不可改写，旧通过不继承。本文替换V0“没有priority/传它400”的规则。

SQLite tickets新增priority TEXT NOT NULL DEFAULT 'normal'。精确批准迁移为addColumn tickets.priority TEXT nullable=false default='normal'；不能删/改名/丢旧列，旧id/title/owner/asset/status/version/评论/审计不变。旧KEPT-T1读取priority=normal，所有旧业务规则、费用和历史阻塞继续保留。

POST /api/tickets可传priority，省略normal；仅normal/high，非法urgent或错误类型400；响应、列表、详情均包含该值。其它编辑/状态权限不变，不能借字段扩权。界面ticket-priority可填写normal/high，新建high真实保存，列表首行ticket-priority-summary显示实际priority；筛选KEPT-T1时为normal。迁移由平台在每独立验证副本先执行，应用启动不重复ALTER，新空库仍初始化完整新schema。

V1固定定义完整重跑V0语义（替换reserved-field断言），验证新建high、非法值拒绝、旧KEPT-T1默认normal、桌面/手机旧行展示。源快照不变、每副本迁移独立、原始SQLite完整性/旧行哈希、同候选验收、费用全账、已验收成对激活/恢复/回滚是额外平台门禁，不能用builder编译代替。演进前后owned库都不能直接编辑来“补数据”。
