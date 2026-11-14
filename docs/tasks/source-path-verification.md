# Windows源码核对路径兼容修复

基准f094a4e（代码408064b），独立分支codex/source-path-verification，仅修改lib/web-execution-service.mjs、原服务专项及本记录。真实73020f7修复候选已完成1次编码、1次Review及18自检/18HTTP/21Edge，原报告accepted；预览在平台默认源码核对失败，SQL行撤为failed，不能改原SQL恢复许可。主Agent定位Git返回正斜杠根路径，而record.workspace为Windows反斜杠；samePath只转小写，误判真实同一根。本轮不修改原报告、源码、.git、QA进程或模型。

验收目标：严格文本路径比较按本机规范化，Windows兼容两种分隔符及大小写；类型、空路径、NUL及不绝对的路径不取得相等资格。逐层目录lstat/realpath、服务ownedRoot、当前完整gate、真实HEAD/status/tree blobs及保护外壳要求保留，规范化不能给予跨root或链接路径权限。

先新增真实Git/保护外壳的默认verifySource入口正例，在旧代码观察红灯；再最小修复比较，验证默认download和preview确实经过真实Git，而不是注入samePath或替换verifySource。完整accepted gate和下游runtime/delivery仍是显式可信测试fixture，并非真实业务或模型验收。补真实staged-dirty、错误HEAD、不同Git根、越界路径和父目录链接负例，保留全部原服务测试及原1薄MXC实测。完成后固定，待非作者Review，再由根对原7302正式新attempt零编码复验；不补造旧结论。

修复仅将samePath改为严格绝对文本/NUL检查后按path.normalize比较，Windows保留大小写无关语义，其他平台保留大小写；默认verifySource在path.resolve前另拒绝非文本、相对或NUL工作区。规范化只是路径写法比较，不代替真实文件系统检查。未改模型、验收清单、当前版本/义务pin、停止证据、目录防链接或Git工作树校验。

新增三项真实Git入口专项：Unicode及空格目录内安装真实保护壳、实际git init/add/commit，在原可信完整gate上绑定该真实HEAD。后续新控制器不注入verifySource或runProcess，download和preview实际运行默认源码校验；只mock上游gate和下游交付/预览句柄，不把薄503业务源码宣传为已验收应用。负例在工作区字节仍与gate一致时制造真实暂存区脏状态，另用空提交改变HEAD、core.worktree改变Git返回根，保证相应判断实际受检；字面四层../越界、父目录junction（非Windows用symlink）、对象、相对路径和NUL均拒绝，下游runtime/delivery调用为0，DTO当前通过撤回。

实际命令与结果：

- 修改生产代码前，`node --test --test-name-pattern="native Windows Git separator" tests/web-execution-service.test.mjs`明确失败1项，code=source_changed、消息为“候选提交或干净状态已经变化。”，保存在output/source-path-before.log。
- 修复后，`node --test --test-name-pattern="genuine clean Git|genuine Git staged|default verification rejects" tests/web-execution-service.test.mjs`为3/3通过，含全部上述实际正负例，日志output/source-path-targeted.log。
- 最终显式`TASKFLOW_TEST_REAL_SANDBOX=1`与已验证MXC程序执行`node --test tests/web-execution-service.test.mjs`：**88/88通过，0失败/取消/跳过，53413.5909ms**（85个顶层项及原有3个子项）。保留原全部专项，并实际执行原1个Git/MXC薄失败候选；它仍failed、未知用量、不开放下载，无付费模型。新Git路径正例是可信gate接线证据，不是新的业务验收结论。
- `npm run check`98脚本通过；改动两脚本显式`node --check`及`git diff --check`通过。仅执行锁定依赖安装`npm ci --ignore-scripts`，package及lock未改。

另外按授权只读核对原候选：HEAD=73020f7c1c5dcae8818f09f17aafcaae0b4ba8df，等于报告candidateCommit，真实status为空；Git正斜杠与workspace反斜杠使旧比较false、规范化比较true。原报告SHA256=9e72fdf579678cf4fb6317504039ec599fa630f8a6ff90101bd6b40bf2499ebb，读取前后hash/mtime一致，Git index size/mtime一致；命令禁可选锁、fsmonitor及hooks，未写SQL或源码。只保存元数据到忽略目录output/source-path-real-readonly.json，不复制原源码/报告或原始模型文本。

本修复尚待非作者独立Review及根集成；没有改变原失败行、报告或现有服务进程，没有发起模型请求/付费、推送或部署，也未做主页面或真实正向应用复验。下一步由根升级已正常关闭的QA服务后，从原7302候选走新的正式零编码recheck，重新完整验收并验证预览/交付；不能将旧accepted报告直接恢复为当前许可。
