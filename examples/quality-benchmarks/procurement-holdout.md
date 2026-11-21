# 留出需求：采购审批与部分收货 V0

本合同在首次真实质量评估前固定。与protocol.md一起输入真实模型规划；禁止平台在本轮针对它改变实现、先写目标应用、供应固定spec/工程/代码响应或用它反复调参。首次结果（包括失败/人工修订/调用/用量）封存后才可另立通用修复版本，旧首次得分不覆盖。它检验前三例以外的跨角色审批与累计明细收货泛化，不含付款、税务、邮件、附件、供应商外部接入。

## 角色、行边界与主数据

alice/bob是requester，approver是approver，buyer是buyer只读，receiver是receiver，hybrid同时requester+approver。所有site=main、密码用户名-demo。requester只看本人订单，其他业务角色看全公司；hybrid可看全公司但仍不能审批自己创建的订单。只有requester能创建/改本人draft/submit，approver只审批别人pending，receiver只给approved/part_received收货；buyer不能审批/收货，非creator requester跨行404。

供应商SUP-A/Supply-A、SUP-B/Supply-B只读启用；SKU PART-A、PART-B只读合法物料。新库没有采购单/收货/审计，同库重启不能重置。供应商、SKU非法400；不建立供应商管理或库存接口，采购收货累计独立于库存案例。

## API、明细和状态

orders(id,reference,ownerId,supplierId,description,status,version)，order_lines(orderId,sku,quantity,unitPriceCents)，receipts(orderId,key,sku,quantity,actorId)，audit。reference trim1..80唯一，description trim0..500，lines有1..10条、不重复SKU；quantity整数1..1000，unitPriceCents整数1..1000000，无浮点金额。totalCents为所有数量×分值之和，按SKU累计received，不得超每行订购量；receivedQuantity为全单累计。错误/越权/重放不写库。

| 路由 | 精确规则 |
|---|---|
| GET /api/suppliers | q/page/pageSize；id/name列表 |
| GET /api/orders；GET /api/orders/:id | 列表q/status/supplierId/page/pageSize；item含lines、totalCents、receivedQuantity、各line.receivedQuantity |
| POST /api/orders | requester {reference,supplierId,description,lines:[{sku,quantity,unitPriceCents}]}→201 draft/version1 item |
| PATCH /api/orders/:id | 本人draft {version,description?,lines?}至少一项，真更新后version+1，reference/supplier/owner不可改 |
| POST /api/orders/:id/submit | 本人draft {version}→pending/version+1 |
| POST /api/orders/:id/approve | approver且非creator {version}，pending→approved/version+1；本人403 self_approval，buyer403；stale409优先非法状态 |
| POST /api/orders/:id/receipts | receiver {version,key,sku,quantity}，仅approved/part_received；未知line400，超额409 over_receipt；成功201 {item:完整order}，version+1，部分part_received，全行收齐received |
| GET /api/orders/:id/receipts | 可见order的角色，items按id升序，含key/sku/quantity/actorId；不分页 |
| PATCH /api/orders/:id/receipts | 405；不准删改收货历史 |
| GET /api/orders/:id/audit | 可见order者只读items，不分页 |

审计created/updated/submitted/approved/received，只成功操作记一次。收货key按公共协议，不同body冲突409；匹配key同body即使订单已received也200 replayed:true，不能重复累计/审计。两个receiver独立会话对同order/version、同line剩余2各收2，必须201+409且最终仅增加2。事务同时约束各line累计、全单status/version和收货/审计，不能只查后写。received不可再收货，不支持反审批、撤销已收货或删除。draft之外编辑409，不得先提示成功再异步校验。

## 桌面与手机界面

/orders支持URL q/status/supplierId，重复order-row，order-first-open，筛选与真实分页/total；创建order-supplier/order-reference/order-description/order-sku/order-quantity/order-price/order-create。界面应支持1..10行增删，自动definition只填写第一行，不代表多行充分验收。详情order-description-text/order-supplier-id/order-total（分整数文本）/order-status/order-received/actor-name/audit-count。order-submit/order-approve和receipt-key/receipt-quantity/receipt-create只对有权角色可操作；单行默认该sku，多行必须能明确选择待收line（receipt-sku）。receipt-row为真实收货记录。

Edge每viewport完整链：alice创建WEB-A，PART-A qty2 price100，description按<b>public</b>原文显示，总200；提交，approver独立登录批准，receiver独立登录分两次各收1，part_received→received、两条收货、全单5审计；alice重载与组合过滤仍received/200。普通requester无approve控件。HTTP另验证空/非法行、本人改draft金额、越界行、买方无权审批、hybrid自审拒绝、多行合计、非法状态/stale/超收/并发最后份额/重放、分页及重启/logout。人工补测多行编辑及逐行收货、键盘焦点/错误保留/手机实际操作；独立Review查非负累计、权限/事务与金额整数安全。

语义域auth/suppliers/orders/approval/receiving/audit/consistency/ui/retention。不允许删去本人自审、重复收货或多行规则来适配生成模型。定义只取公开数据，首次模型质量评估由真实规格/工程/候选及原始回执证明。
