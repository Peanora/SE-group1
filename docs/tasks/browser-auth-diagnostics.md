# 匿名会话探测的浏览器诊断归类

基准`702d318`，分支`codex/browser-auth-diagnostics`；仅修改本记录、`lib/web-browser-tests.mjs`及其同名测试文件。不修改候选、不调用模型、不读取.env或用户data，不推送或部署。

业务理由：library-web-v1契约明确未登录GET /api/me返回401。独立Review对真实候选`5dc88cd31f0aa7649458a58ab386e23d3ff1e6a2`复现HTTP18/18、浏览器19/21，唯一问题为两个新视口在正常初始化探测各产生一次Chrome自动401网络诊断；显式console.error/pageerror均为空。原始独立观察保存在主工作区忽略的`output/auth-console-review-09Mkd2/auth-observation.json`。本轮不回改旧失败记录。

最小规则：每视口最多一次、首次成功POST /api/login 200之前、精确当前origin的GET /api/me、Fetch/XHR、真实401，且CDP Log.entryAdded source=network/level=error的networkRequestId与Network.requestWillBeSent/responseReceived一致。请求与响应URL一致、无重定向且资源类型相同。对应Playwright error必须原文、位置逐字段一致且argsCount=0；显式console.error、重复请求、其他URL/status、登录后的401、pageerror均不豁免。请求/响应时间而非晚到的日志时间用于登录边界判定；login路径附加query仍关闭匿名豁免窗口。原始console保持，另列expectedDiagnostics、networkDiagnostics及networkEvidence；CONSOLE名称与manifest hash更新，固定21项不变。

真实字段语义：Fetch原生诊断位置在/api/me，同步XHR则可指向发起脚本/fixture.js。因此CDP原生日志位置须是当前origin，Playwright位置须与该日志一致；不要求日志位置等于请求URI，也不武断要求脚本行号为0。请求归属由networkRequestId绑定真实GET /api/me 401，不能用位置或文案代替。首轮实测曾因额外强加位置等于请求URI而误拒XHR，保留失败现象，按观察修正字段含义；未改变业务门禁。

监听与缓冲统一有界：总共1000个诊断事件、256KiB计量字节、每类最多100条记录，原始大文本也计预算；CDP请求映射同样受总预算约束。预算为保守计量，部分元数据在采集及持久记录时分别计入。超过任何上限立即失败并关闭已有资源，停止确认仍另行核对。上下文关闭后才定案CONSOLE及NETWORK，移除CDP监听并detach；关闭等待未完成不得获得CONSOLE通过。全新Edge/上下文、精确origin网络限制和原有进程停止要求保持。

实际验证：

- `npm ci --ignore-scripts`安装仓库精确playwright-core，无依赖文件变更。
- `node --test tests/web-browser-tests.test.mjs`普通模式：新增前期验证15项通过、真实环境2项按原规则跳过；不是最终真实环境证据。
- 显式`TASKFLOW_TEST_REAL_SANDBOX=1`与本地可信MXC路径执行同一测试文件：27/27通过，无失败/跳过。真实系统Edge为157.0.4341.46。含原有隔离/取消/异常停止回归及9个新增真实薄fixture场景。Fetch、XHR两种bootstrap分别在两个视口各单列1条原生401，CONSOLE通过但整体业务仍failed；同文显式console.error、重复401、其他URL、403/404、登录后401及pageerror的CONSOLE仍失败，进程均停止确认。
- 可信mock覆盖晚到日志、同origin脚本非零行号位置、位置/行号不匹配、跨源日志位置、错误ID、无响应/无CDP、错误来源/资源类型/方法、带query的登录成功、原始证据保留、监听清理、console/blocked/CDP/大文本超限后关闭且失败。
- `npm run check`：55个脚本语法通过；`git diff --check`通过。

只修改了受控验收器和回归，不修改真实候选或原失败记录，不调用模型或读取真实配置/用户data。未运行全仓测试、未复验真实候选的完整业务链路、未取得该候选新版本验收结论、未推送/部署。下一步由独立Reviewer检查固定提交，主Agent集成后重新对同一候选运行新manifest验收；旧19/21结论不得直接转换为通过。
