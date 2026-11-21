# 库存 V1：本人草稿仅备注编辑权限

V0真实owned应用由alice创建reference=KEPT-D1、W1/SKU-A、quantity1、memo=kept-memo的draft，不过账；保留created审计，库存仍10/5/20，无其它业务单。STOP并一致备份后同项目新需求、新规格/工程/双确认，旧源码/数据/费用/Review保留。迁移plan=none，旧行/库存/流水/schema不改，不能通过改库替代权限实现。

仅替换V0“requester不能PATCH任何单据”：alice/bob现在可PATCH本人draft的memo，body仅{version,memo}；200且version+1/审计updated。任何quantity字段，即使数值未变，都403 forbidden；foreign404；posted/cancelled状态409。keeper原有精确写权限不变，auditor仍403。不能利用字段混合或body里的owner/role扩权。

requester本人draft详情出现outbound-memo-edit与outbound-save-memo，保存后outbound-memo-text为新文本；不出现outbound-quantity-edit、post控件。旧KEPT-D1的id/owner/quantity/草稿状态和历史审计可查，只有明确新操作后memo/version变化。HTTP验证旧memo、本人可改、本人数量仍拒/外人写拒；Edge验证旧单真实备注保存、隐藏数量编辑。原并发扣库、幂等/流水/审计/重启与全部非法状态完整重跑，绝不把旧通过继承给V1。平台快照、每副本独立验证及成对发布/数据后写回滚拒绝另验。
