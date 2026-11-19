# 公共运行、数据与交互协议 v1

本协议与一个案例需求一起构成该案例输入。实现真正可用的本地Web系统，拆分登录/业务/持久化/交互模块，保持明确接口、任务依赖、允许修改文件和可独立验证边界。规划/规格由真实模型产生，本文不指定代码实现。所有页面、API和数据必须同一真实应用，不准返回只对测试输入成立的固定响应或伪造状态/流水。

## 运行与安全

沿平台createApp({databasePath})受控应用协议；只使用Node内置模块、原生前端和SQLite，同一传入库。不能依赖外网、安装新目标依赖、子进程或任意宿主路径。保护shell不改。业务文件真实写入Git候选，所有候选重新运行独立HTTP/SQLite、Edge和Review，后端真实结果驱动完成。

空库初始化一次公开账户与案例主数据。用户名就是稳定user.id，密码统一`用户名-demo`，仅公开假数据，禁止真实密码。密码使用加盐scrypt等内置单向派生，数据库不明文存密码。POST /api/login {username,password}成功200 {user:{id,roles:[...],site}}并设置名为app_session的随机不可预测会话Cookie（保护层仅允许app_前缀；HttpOnly、SameSite=Strict、Path=/；本地HTTP无需Secure），失败401 {error:{code:"invalid_credentials"}}。GET /api/me返回相同user；未登录API401 auth_required；POST /api/logout {}成功204，持有旧Cookie再访问401。会话写SQLite且应用同库重启有效；浏览器会话隔离。权限必须服务端检查，不能信任body的actor/role/site。成员在行边界外GET或写均404 not_found，不泄露记录存在；已可见行但操作角色不足403 forbidden。检查顺序：认证→可见性→操作权限→幂等重放→版本→合法状态→数据约束。禁用/隐藏控件不替代权限。JSON之外正文、未知字段/枚举/筛选、空白必填/错误类型返回400 invalid_input。

## 通用API形状

请求/响应为UTF-8 JSON（204无正文）；每项业务实体以`{item:{...}}`返回，列表为`{items:[...],total,page,pageSize}`。创建201，读取/修改/状态动作200；id为真实正整数（主数据字符串ID除外）。未知路径404，已知只读集合写方法405。所有错误JSON {error:{code}}，不带SQL/路径/栈。状态动作body须version，实体初建version=1，每个成功更新/状态动作恰加1；stale_version409，非法状态invalid_state409。失败、重放、GET不能变更实体、库存、审计或账目。

所有列表默认page=1/pageSize=2，范围page正整数、pageSize=1..50，超界400，超最后一页items=[]但total不变。所有过滤条件AND，q为trim后大小写不敏感子串；实体列表q匹配title/reference，主数据q匹配名称或ID；status/site/warehouse/resourceId/assetId/supplierId/reference精确匹配，未知字段400。按id升序，主数据按稳定字符串ID升序；过滤先于计数/分页，page与pageSize回显数字。不可见行在过滤和total之前排除。需要的精确query集合见各例。日期slot是固定业务标识，不依赖当前日期或真实计时器。

成功业务写事务与审计同事务，审计按单调id升序，只追加{ id,entityId,actorId,action,fromStatus,toStatus,version }，没有状态变化时from/to可同值，评论记所属工单；不能伪造时间。例外的system自动提升须真实actorId=system。用户不得PATCH/DELETE/POST审计。不可重复记账动作使用公开key，授权后同actor+同命令+同body的重放返回200 {replayed:true,...}，不再写账；key重用不同body409 idempotency_conflict。两个并发请求无论谁先到，事务/约束必须保持容量或库存及审计一致。取消不删除历史，禁止硬删已发生业务记录。

## 页面与固定可观察接口

GET /login返回200且保持URL，外链脚本/样式，包含data-testid="login-submit"。控件login-username/login-password为有可访问名称的输入，login-submit按钮；成功后actor-name精确显示用户名。每例工作区路径及query必须可直接打开且保持完整URL，query回填筛选；刷新从服务端重载，不能靠内存假状态。页面提供导航、当前角色、列表、分页、创建/编辑/详情/状态/审计，手机可正常使用。data-testid是稳定观察接口，同名-row可重复，其余观察控件必须唯一可见。筛选输入用有标签的可填写控件（可加datalist），输入不应强迫测试执行JS或访问内部状态。

所有列表默认2条，q改变/筛选按钮重置page=1；next到下一页。详情first-open打开当前页第一条真实数据；first-title/reference等是当前页首行真实字段。创建后清空唯一title/reference，保留已选资源/数量/备注以便连续录入；刷新不保留旧列表内存；q筛选继续生效。测试文本可包含<b>或<img>，全部按原文显示，禁止innerHTML执行；正常动作无console/page错误、跨源请求、弹窗或下载。错误有本地可读提示且保留输入，服务端失败不能显示成功。页面有label、键盘可达按钮、清晰焦点、可访问状态提示；1440×900和390×844无整页横向溢出，可内部表格滚动。

自动Edge检查只覆盖定义中的操作/断言与guard；额外人工检查Tab/焦点、错误草稿保留、手机滚动、返回列表位置。接口非法/并发路径由独立HTTP检查且Review真实SQLite约束；SQL完整性、全部原始回执、源Git/候选/版本和终止由平台可信门禁另行核对。上述手工、Review、环境检查不能被编译成功替代。
