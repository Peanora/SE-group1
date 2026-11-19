# Worker模型控制配置冻结与传递

2026-11-18。本轮修复候选根因：控制进程读取根.env的thinking/JSON配置，但独立Worker仅经匿名stdin收到baseUrl/model/apiKey，minimalEnv去除LLM_*，子适配器回读进程环境时控制值丢失。原i10 length空content/1call失败及所有费用保留，未以此推断上游实际token消耗位置。

目标：仅将可信且校验后的thinking与JSON控制纳入冻结模型配置、configRevision及匿名stdin；普通执行、首Worker、下一代Worker读取同一配置，不透传.env或其它环境。未定义保持原行为，非法值派发前拒绝；coding16384/Review4096上限不变。真实localhost固定HTTP+独立Worker捕获出站body，验证同配置、跨API/Worker恢复及配置变化拒绝，0收费。

允许范围：lib/planner.mjs、project-code-model.mjs、project-review-model.mjs、planned-worker-client.mjs、planned-worker-contract.mjs、planned-execution-service.mjs，scripts/planned-worker.mjs及直接相关tests。根另明确授权planned-web-executor.mjs仅将planner.mjs加入policyHash依赖清单。复用现有安全复制、门禁、policy/config hash和测试夹具，不重写传输或预算；不提交推送部署、不修改旧trial或主服务。

实现：仅白名单thinking/jsonMode在创建adapter/service时快照，own undefined冻结缺省值，空环境兼容原默认；jsonMode false/0保留为false。Worker匿名stdin传递同一规范配置，首派/恢复均在reserve/markDispatch/prepareGeneration之前核configRevision；旧三字段仅在没有显式控制项时保持原hash。service contract加入controls，原budget主键/计数未变。Worker设置不可变而私有key可清理，清理失败也在finally关闭资源，避免静态预审发现的冻结key对象TypeError。

实际作者检查（2026-11-18，Node22.21，全部0收费）：

- 最终六文件关联批94/94 PASS（final-related.tap）；11个生产/测试文件语法通过，git diff --check通过。
- 真实localhost默认code/Review+独立Worker，JSON1/0两支6/6 PASS：初Worker、API实际退出/附着、pause/退休、下一代、Git/MXC/HTTP/Edge、两次API恢复同ZIP，8个出站body均disabled，JSON0无response_format，输出上限仍16384/4096。output-only全缺省同链3/3 PASS，4个body无thinking且默认json_object。
- i10原源码同链反例保留：JSON0实际丢thinking且错误带json_object，完整业务夹具结束后配置断言红；不追认旧收费图。
- output-only真实i10已失败Worker→新源码/config复开1/1 PASS，attempts1/used_calls1/reserved_calls0原样，旧failed不转成功，新cap可启动且未派第二请求。
- output-only实际独立Worker进程环境/argv只读检查1/1 PASS：LLM变量0、合成key不在环境或命令行、参数只有job bootstrap；其后正常结束。首探针错误读取jobs.pid而非registration.pid导致探针红，保留credential-worker-first.tap，修探针后通过，未改产品。

证据：output/worker-model-controls/HANDOFF.md、scope-manifest.json、i10-to-current.patch、final-audit.json。i10固定265文件、旧四个真实图1442文件、第五真实图121文件hash零漂移。i10→主树原文件仅8授权生产+1测试变化，另新增2测试与本记录；完整REQ/历史receipt/驳回历史模块未改。源码和tests已停写，由根冻结i11独立Test/Review；本轮作者结果不替代独立验收，也不证明真实LLM质量。独立全量首批环境红已由Test实证启动器Path/PATH遗漏Git，原红保留，修环境由独立Test调度，不在作者结果中拼接成全仓通过。
