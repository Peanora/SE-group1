# 流程默认展开与整页滚动

基线HEAD为`171aaa6`，继承并保留上一轮尚未提交的UI改动。本轮按用户截图与明确反馈调整：规划流程默认展开；主页面整体滚动，让下方任务、表单和文档可以自然滚到屏幕中部，解除固定视口底部小区域的阅读限制。继续不暂存、不提交、不推送，不修改用户数据或启动付费模型。

沿用当前蓝白样式及四工作区。页面采用自然高度，工作区导航吸顶；主正文取消竖向限高，图的横向滚动、输入框和原生对话框内部滚动保留。`workflow-details`默认open，新项目/运行重新默认展开，当前页面手动收起后普通轮询不反复强开。

阅读位置改为按项目/运行/工作区保存window坐标，`document-v1`标识隔离旧面板相对坐标；旧布局坐标不继承，草稿不变。用户明确点击修改需求/新增功能时定位对应表单，其余切换恢复各自阅读位置。错误提示仍处于当前视口，用实际测量的高度在文档底部及保存栏预留空间，避免遮住末尾操作；对话框中继续使用自身布局。

修改范围：`public/index.html`、`workspace.css`、`workspace-layout.js`、`workspace-notices.js`、`source-changes.js`的读取完成布局回调及`app.js`的对应连接/明确入口定位；相关浏览器回归和当前说明。改动前副本仅保存在本地`output/page-scroll/before/`。

验收：桌面1440和390×667/844的真实滚轮/文档滚动，默认展开和手动收起，工作区切换与刷新位置恢复，任务编辑打开/关闭位置及焦点，页面下方失败不抢滚动和输入、长错误/保存/关闭可普通指针命中。

验证中定位并修复两处实际问题：需求初始读取提示移除导致刷新后纵坐标少56px，改为当前有效读取完成最终渲染后才结束恢复；保留浏览器正常编辑时的滚动锚定。手机任务编辑框使用100vw时与页面稳定滚动条预留冲突，左侧被裁15px，改为可用宽度100%，并为对话框/标题/页脚增加横向边界断言。未放宽原4px阅读位置断言和原审批、收费、草稿业务断言。

最终验证：

- 冻结清单`output/page-scroll/frozen-source-v2.json`，SHA256 `71E2DD57FB1F658359B92D4D4EDF8C80085530673FEEA06155A68B6B0A93241F`，20份生产/测试文件，检查零漂移，HEAD仍为`171aaa6`，暂存区为空。
- `npm run check`：125脚本通过，日志`output/page-scroll/check.log`。
- `node --test tests/workspace-ui-browser.test.mjs`：最终9/9通过，0失败/跳过，33198.4234ms；日志`output/page-scroll/workspace-browser-final.tap`。桌面1440×1000和390×667/844真实Edge，包含完整验收项、付费/版本门禁与草稿原业务断言；截图`output/document-scroll/`和`output/workspace-ui/`已查看。
- `node --test --test-concurrency=2 tests/workspace-notices.test.mjs tests/spec-repair-browser.test.mjs tests/source-change-browser.test.mjs tests/engineering-planning-browser.test.mjs tests/visual-task-changes-browser.test.mjs tests/requirement-clarification-browser.test.mjs tests/simulated-tasks-browser.test.mjs tests/web-execution-browser.test.mjs tests/platform-defaults-and-delete.test.mjs`：34/34通过，0失败/跳过，47633.4372ms；日志`output/page-scroll/final-browser-related.log`。与上一条合计43项不同用例，没有累计重复执行。
- 非作者独立复核最终同清单FIX：`node output/page-scroll/independent/probe.mjs`三组真实Edge探针通过，1440×900/390×667，0真实模型调用、仅1次受控mock失败、pageErrors为0。默认展开/手收后3次真实轮询与后台失败保持，真实window wheel将下部保存带到中部（sourceY1242/1208），普通指针切面及刷新严格4px恢复，对话框草稿/Escape返回焦点与坐标、手机头尾边界均通过。下方503错误不抢焦点/选区/windowY，通知展开/定位/关闭及恢复保存按钮可普通指针命中。手机dialog为x0/宽375，无左侧裁切；通知y455/高200，未覆盖保存。无新需求记录，原source未改，首尾20文件哈希零漂移。证据`output/page-scroll/independent/results.json`、`review-1440.png`/`review-390.png`及脚本/日志；独立未重跑全仓库。首轮独立脚本sticky导航的locator自动滚动与短暂wheel时序导致检查超时，改为实际mouse与稳定后检查即通过，未因此改动产品或放宽断言。
- 补充面板回归35/35通过；手机边界补修前另11文件相关回归79项，78通过、1个真实隔离执行环境项跳过、失败0（`final-related-test.log`）；后续仅手机CSS宽度及新增对应边界断言变化，最终布局以9+34项新回归为准。未重跑全仓库，不复用上一轮固定视口全量结果，不调用真实付费模型。
- 本地4317健康HTTP200，index、app、workspace样式/布局/通知、source/simulated/execution共8文件HTTP200且哈希与本地一致，刷新生效，无需重启。`git diff --check`通过；未更改用户数据/.env或后端契约，无数据迁移，未暂存、提交或推送。

下一项实际验收：刷新现有工作台，默认展开流程图后向下滚到编辑与失败处，再切面/刷新确认阅读位置；继续保留本地改动。
