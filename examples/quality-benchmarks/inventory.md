# 仓库库存、出库单与流水系统 V0

与protocol.md合并。面向单公司多仓库领料，不含采购、财务、支付或外部物流。模块为认证/仓库SKU、出库草稿、授权过账/取消、库存流水、审计、桌面手机界面。

## 角色与初始数据

alice/bob为requester，仓库W1；keeper为keeper，仅W1；auditor为auditor，可读所有仓库且不可写。密码均用户名-demo。requester只看本人单据，可创建/读取/取消本人draft，V0不能PATCH任何单据；keeper可看/改/过账/取消W1单；auditor只读。库存目录按仓库权限显示，外仓请求404。新库W1:SKU-A(name=SKU-A,quantity=10)、SKU-B(5)，W2:SKU-X(20)；每SKU有且仅有一条opening正数流水，初始化不生成业务审计。没有出库单。不能重启重置库存。

## 数据、接口与一致性

outbounds(id,reference,ownerId,warehouseId,sku,quantity,memo,status,version,postKey)，stock(warehouseId,sku,quantity)和只追加ledger/audit。reference trim1..80、全局唯一；memo trim0..500；quantity整数1..1000。POST初始化draft/version1，不提前扣库存。sku/warehouse组合必须存在且有权，非法库存不会自动创建。不能提交owner/status/任意数量类型。keeper的PATCH draft可修改memo或quantity，version+1，reference/owner/sku/warehouse不可改。V0本人memo也不准改。

| 路由 | 合同 |
|---|---|
| GET /api/stock | warehouse/q/page/pageSize；items字段warehouseId,sku,name,quantity |
| GET /api/outbounds | q/status/warehouse/page/pageSize；item有上述全部单据字段，postKey仅已post时非null |
| POST /api/outbounds | requester {reference,warehouseId,sku,quantity,memo}→201 item |
| GET /api/outbounds/:id | 可见行详情 |
| PATCH /api/outbounds/:id | keeper {version,memo? ,quantity?}，必须至少一项，draft之外409 |
| POST /api/outbounds/:id/post | keeper {version,key}，仅draft且足量→200 item，原子扣库存、记一条delta=-quantity流水、status=posted、version+1并审计；不足409 insufficient_stock |
| POST /api/outbounds/:id/cancel | 本人或keeper {version}，仅draft→cancelled/version+1；不动库存/流水 |
| GET /api/ledger | warehouse/sku；只读{items:[{id,kind,delta,outboundId}],balance}按id序，不分页 |
| GET /api/audit | referencePrefix；仅keeper或auditor，只读items，不分页 |

过账key及同body重放按公共协议，必须先核角色，不能借replay让auditor写。重放不增加version/流水/审计，posted使用不同key409 invalid_state；posted/cancelled不可编辑/取消/重过账。审计created/updated/posted/cancelled。两个不同会话过账同SKU两份quantity6草稿，初始10，无论哪张成功，只能200+409，最终4、1张posted/1张draft、仅一笔-6流水；随后取消输家仍4。库存非负，单据/流水/审计要用同事务和唯一约束。未知筛选/超pageSize400，total不含他人单据。

## 页面合同与验收

/outbounds?q&status&warehouse保持URL；列表outbound-row/outbound-total/outbound-first-reference/outbound-first-open/outbound-next；过滤outbound-query/outbound-status-filter/outbound-filter。输入outbound-reference/outbound-sku/outbound-quantity/outbound-memo及outbound-create。W1成员默认仓库W1，真实可见仓库可选择。详情outbound-memo-text/outbound-status/stock-quantity/audit-count，keeper的outbound-post实际过账。V0没有outbound-save-memo，requester看不到outbound-post；auditor无任何创建/变更按钮。/ledger?warehouse=W1&sku=SKU-A给ledger-row与ledger-balance。

Edge每viewport：alice输入公开HTML样式文字作memo并原文显示，建WEB-A/B/C quantity2，列表3条分页2/1、AND筛选；keeper独立登录只过账WEB-A，真实stock8和该单audit2；alice重载看到posted；流水opening/+10及posted/-2两条、balance8。HTTP另覆盖负数量、外仓/越界行、无权过账、stale、两单分别memo修改到version2后并发扣减、原version2/key完整命令重复过账、posted编辑拒绝、分页顺序、共6条BENCH审计和重启。人工补测库存目录、取消、keeper编辑、auditor完整只读界面、焦点/错误草稿/手机。语义域auth/catalog/documents/workflow/ledger/audit/consistency/ui/evolution。
