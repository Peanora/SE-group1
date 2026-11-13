# 通用受控 HTTP 验收契约组件

## 目标与边界

基准 `702d318`。本轮只新增编译器、HTTP 场景运行器、专用测试与本文，不修改现有 profile/runtime/server/依赖，不接模型 API 或浏览器/SQL 验收，也不读取用户 data。

独立测试 Agent 后续可以提出纯数据 proposal；当前组件校验结构、版本、依赖、变量来源和需求编号覆盖，再由可信控制器在编码前批准。**需求编号覆盖只是结构证据，不证明业务语义完整或正确**，批准前仍需小组或独立 Review 核对内容。本组件不代表已接入通用测试 Agent 或任意软件已通过业务验收。

## 可信批准与接口

`createVerificationControl()` 返回只能由可信服务保留的能力句柄：

1. `control.approve({proposal,requirements,binding,feedback?})` 校验后建立当前批准记录。phase 固定由控制器内部记录为 before_coding，输入中写同名字符串不是批准来源证明。
2. `compileManifest({proposal,requirements,binding,approval})` 必须使用该进程中实际批准产生的对象；纯 JSON 的 approved 布尔、复制的 approval 和复制的 manifest 都不能取得执行能力。返回深冻结清单和确定的 manifestHash。
3. `control.beginCoding(approval)` 锁定该规格/计划版本，之后不能替换同版本的清单。模型编码/执行服务只能在这个步骤后开始。失败修复沿用固定清单；改变验收清单须形成新版本并重新批准。
4. `control.revoke(approval)` 使对应编译清单失效。运行器在步骤、请求、响应和最终门禁处重新核对批准仍有效；最终异步源码读取完成后及所有检查回调结束、发布结果前再次核对，撤销后的 SYS_FINAL 必须为 false。

binding 为 `{projectId,runId,specRevision,planRevision}`，两个 revision 都必须为 SHA256。manifestHash 绑定规范化 proposal、完整需求编号集合、binding 及编译器/运行器源码 policyHash；JSON 键顺序和 requirements 输入顺序不影响同一清单内容。

这是**进程内 WeakMap/对象品牌**，不是持久化审批、跨进程认证或 OS 隔离。不能直接反序列化批准恢复执行；后续接 TaskStore 时，须由可信恢复入口核对持久化审批记录及编码前的批准归属，再建立当前进程品牌和重新 compile。候选/Worker 不得到 control，也不能通过 HTTP 自授批准。

## DSL v1

proposal 为 `{version:1,id,name,sessions,steps,limits?}`。会话名字只是独立 Cookie jar 标识，不自动代表已登录或拥有某角色。

每个 step 必须有唯一 id、type、dependsOn、非空 requirementIds；REQ 必须属于可信 requirements 且全部被覆盖。步骤顺序固定，依赖只能指向前序，无未知依赖或循环。

- request：`{id,type:'request',dependsOn,requirementIds,request:{id,method,path,session?,body?,assertions,captures?}}`。
- concurrent：`{id,type:'concurrent',dependsOn,requirementIds,requests:[requestA,requestB],expectedStatuses:[201,409]}`。两个请求使用不同已声明 session，禁止捕获变量；固定 `GROUP_<stepId>` 断言核对响应状态多重集。它验证并发客户端请求，不证明多个 Worker 并行事务。
- restart：`{id,type:'restart',dependsOn,requirementIds}`。旧进程正常 exit0、stopAcknowledged、sourceUnchanged 和 terminationConfirmed 全部满足后，才在同一快照工作区重启，因而 runtime 仍使用同一 `.platform/tmp/app.sqlite`。固定断言为 `RESTART_<stepId>`。具体持久化行为由后续 HTTP 请求断言。Cookie jar 和捕获值保留；应用会话不跨重启时提案需安排重新登录。

request 支持 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS，GET/HEAD 不能有 body。path 必须是当前应用内以 `/` 开始的路径，不允许外部 URL、协议、`//`、反斜线、编码绕过、控制字符或点段。

断言编号全局唯一。操作为：

| op | 必需参数 | 含义 |
| --- | --- | --- |
| status | value:200..599 | 响应状态等于固定值 |
| statusIn | value:状态数组 | 响应状态属于固定集合 |
| jsonEquals | path,value | JSON 字段与固定 JSON/捕获值相等 |
| jsonExists | path | JSON 字段存在 |
| jsonLength | path,value | 数组或字符串长度等于固定值 |
| textIncludes | value:非空文本 | 响应文本包含固定片段 |

每个请求必须有非空断言。JSON 断言和捕获要求响应 Content-Type 为 application/json、正文可解析且整份 JSON 递归没有非有限数字。JavaScript 可把 `1e400` 解析成 Infinity，但此类响应不能用作 JSON 断言或捕获；规范 JSON 序列化也拒绝非有限数字，不把它们改写为 null。JSONPath 仅支持 `$`、`.field`、`[0]` 的小型自有解析器，最多 12 段和下标 1000；只读 own data descriptor，拒绝 prototype/constructor/__proto__、getter、通配、引号路径及表达式。

捕获为 `captures:[{name:'itemId',path:'$.id'}]`，固定检查编号 `CAP_<stepId>_<name>`。只有请求断言全部通过且值为有界 JSON 标量（数字必须有限）时才保存捕获。变量名唯一；capture.name 与 $var 必须是符合命名规则的字符串，布尔/数组等值不能隐式转换成变量名。使用步骤必须在依赖链上包含捕获来源。URL 写 `/items/${itemId}`，运行时逐变量 encodeURIComponent；JSON body 或 jsonEquals 期望值使用 `{$var:'itemId'}`，保持原始标量类型，不执行字符串。不存在任何 eval、JS 回调、SQL、Shell、任意请求头或任意网络地址能力。

例：

```json
{
  "version": 1,
  "id": "items-contract",
  "name": "新增后读取",
  "sessions": ["user"],
  "steps": [
    {
      "id": "create", "type": "request", "dependsOn": [], "requirementIds": ["REQ1"],
      "request": {
        "id": "post_item", "method": "POST", "path": "/items", "session": "user",
        "body": {"title": "输入示例"},
        "assertions": [{"id":"created","op":"status","value":201}],
        "captures": [{"name":"itemId","path":"$.id"}]
      }
    },
    {
      "id": "read", "type": "request", "dependsOn": ["create"], "requirementIds": ["REQ1"],
      "request": {
        "id":"get_item", "method":"GET", "path":"/items/${itemId}", "session":"user",
        "assertions":[{"id":"same_id","op":"jsonEquals","path":"$.id","value":{"$var":"itemId"}}]
      }
    }
  ]
}
```

例子是契约数据，不是完整软件实现或充分的业务验收集。

## 生产运行器

`runHttpScenarios({manifest,files,rootDir,binding,signal?,executable?,timeoutMs?,onEvent?})`。

执行 binding 额外要求 taskId、attemptId、40 位 candidateCommit。rootDir/executable 来自可信服务，不给客户端工厂或函数注入；实际程序入口固定为 startWebRuntime。普通测试通过模块 mock 提供可信替身，生产入口没有 transport/factory/command 参数。

运行器校验 manifest 品牌和当前批准/版本，使用 applyProjectFiles 创建独立快照，记录 `sourceHash=sha256(JSON.stringify(validateProjectFiles(files)))`，目标源码始终由现有 runtime 以只读、无网络权限运行。候选 tests 或 passed 标记不参与判定。

结果包含 `{status,binding,sourceHash,manifestHash,policyHash,checks,processes,workspace,terminationConfirmed,error,coverage:'structural_only'}`。binding 再关联源码/清单哈希；checks 按固定完整清单返回，每项有 id/name/stepId/passed/expected/actual。请求失败、前置未通过、取消和未执行检查均保留 false，不以 skipped 充当通过。未知退出进入 reconciliation_required，禁止启动后续程序。

系统检查 SYS_SNAPSHOT、SYS_START、SYS_FINAL 与所有业务断言、捕获、并发和重启检查共同组成清单；纯 JSON 伪造清单会直接拒绝，不从其自报内容构造可信清单。源码、批准和进程停止门禁都通过才可返回 passed。

会话仅接受 runtime.request 内部接口中的 app_ HttpOnly Cookie，不接受 DSL 自定义 header。jar 分离用户、限制 Cookie 大小/数量并遵守 Path、Secure、过期；不在结果里输出 Cookie 或捕获变量值。

## 固定上限

40 步、80 请求、总计 200 个断言/捕获/系统检查、32 个捕获、8 个会话；每请求最多 20 个断言。proposal 最多 256 KiB、结构深度 16；正文在变量展开前后均最多 16 KiB，响应最多 64 KiB，捕获标量最多 4096 字节。Cookie jar 最多 32 项、发送总量 8 KiB；单个值最多 2048 字符。

总时长默认 60 秒、硬上限 120 秒；单请求最多 5 秒。proposal 可缩小时间预算，外部调用只能进一步缩小。现有受控 runtime 的累计 stdout/stderr 上限固定 4 MiB；启动、请求和停止继续保留真实进程证据。硬上限失败会阻止通过，不自动放宽重试。

## 本轮验证与下一步

实际执行 `node --test tests/verification-contract.test.mjs`，显式开启真实 MXC 后 13/13 通过、无跳过；编译器/运行器/测试三个脚本语法检查通过。覆盖批准与编前锁定、清单/版本变化、纯 JSON 伪造、DAG/覆盖/上限、外部路径与任意命令拒绝、getter/数组方法伪装拒绝、安全变量、会话隔离、并发状态多重集、重启、错误/取消/超时/未知退出及实际错误候选拒绝。

可信 mock 的正向场景只说明验收器判定可工作，不代表生成软件通过。未运行真实独立测试 Agent、通用浏览器、任意 SQL、模型 API 或用户项目；没有配置/数据迁移。下一步先固定版本独立 Review，再把独立测试提案与可信审批记录接入服务，保留业务语义 Review 与真实应用集成验收。

### 独立 Review 三项 P2 修复

基于固定候选 `6b3e303` 修复非有限数字被规范化为 null、非字符串捕获名/$var 隐式别名，以及最终异步源码读取期间撤销审批仍可能返回 passed 的问题。最终检查回调本身撤销审批也不能发布 passed。编译器/运行器源码 policyHash 随修改改变；旧进程品牌或旧 manifest 不能作为本版本批准直接恢复，后续仍须由可信控制器重新批准/编译。

本轮实际执行三个脚本 `node --check`，以及显式真实 MXC 的 `node --test tests/verification-contract.test.mjs`：18/18 通过、无跳过。新增回归覆盖原始 `1e400` 与 `-1e400`、嵌套溢出、只有状态断言时的溢出捕获、正常有限数字/null 对照、布尔 true 与字符串 'true' 捕获别名、非字符串 $var，以及最终读取/发布回调两处撤销。真实 MXC 专项分别请求根溢出、负溢出标量捕获和嵌套溢出候选，均完整记录 false 检查且确认进程停止；未执行候选 tests 或通过标记。

只改原授权四文件；未调用真实模型、未触碰用户数据或主分支，也未接入通用 Agent 服务。新固定版本交另一 Agent 复验后再决定集成，旧 13 项记录保留为历史证据。
