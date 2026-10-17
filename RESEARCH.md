# DSH-MCP 项目研究报告

> 研究对象：`/workspace`（npm 包名 `dsh-remote-mcp`，v0.1.0，MIT）
> 研究方法：通读 `src/` 全部 2244 行 + `test/` 865 行 + README/REPORT，并在本机实际执行
> `npm install`、`--version`/`--print-config`/`--help`、协议测试套件，以及一个自建的
> **桩 DSH 宿主** 跑通了「建会话 → 派任务 → 等回合 → 读回答案」的完整链路（证据见 §8）。
> 研究分支：`cline/rfpk8nwx`。

---

## 1. 一句话定位

`dsh-mcp` **不是 DSH 的一部分**，而是一个独立的 **MCP server**：把「已经跑起来的、URL 可配置的
DSH 实例」的 `/api` RPC 面包装成 **23 个 MCP 工具**，任何 MCP 客户端（Claude Desktop / Cursor /
另一个 DSH 会话 / 自研 host）挂上它就能远程操控那个 DSH：列会话、读事件级历史、建会话、派任务、
等回合、取回答案、中断、重命名、分叉、切模型、管工作区、驱动 subagent。

```
MCP host ──stdio / streamable HTTP(MCP)──▶ dsh-mcp ──POST /api/<method> (JSON-RPC 信封)──▶ DSH 宿主（URL 可配）
```

要解决的核心痛点：DSH 的 RPC 面只在进程内部可用、没有稳定的客户端库；这个项目把它做成
**可导入的库 + 可挂载的 MCP server**，并补上了官方 CLI 没有的等待/竞态兜底、结构化错误模型、
HTTP 传输等能力。

## 2. 运行时架构与数据流

```
src/index.js       MCP 入口：一份实现，两种传输（stdio 默认 / --http streamable HTTP）
   │  createDshMcpServer(config)  ── 传输入口只此一处
   ├─ src/tools/index.js  注册表：schema.js 的数组 + 各域 handler 合并 → 同时驱动 tools/list 与 tools/call
   │     ├─ tools/host.js        host.*        (2)
   │     ├─ tools/session.js     session.*     (12)
   │     ├─ tools/workspace.js   workspace.*   (2)
   │     ├─ tools/subagent.js    subagent.*    (4)
   │     ├─ tools/raw.js         dsh_call      (1，默认关闭)
   │     └─ tools/support.js     共享胶水：历史摘要 digest / 等待 waitForSettle / 工作区解析
   ├─ src/schema.js      单一事实来源：名称/描述/JSON Schema/默认值/参数校验
   └─ src/client.js      唯一发 HTTP 的地方：信封、超时、重试、错误模型、探活
        └─ POST <base>/api/<method>  { type:"client-request", rpcId, method, payload }
           ← { type:"server-response", rpcId, result: {ok:true,value} | {ok:false,error:{code,message,details}} }
```

关键点：**只有 `client.js` 会做网络 I/O**（README 与 REPORT 都强调），其余全部是纯逻辑，
因此可测试性极好——协议测试可以整体跑起来，只有 2 项真正需要活 DSH。

## 3. 模块职责与规模

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/index.js` | 170 | MCP 入口：`createDshMcpServer()` 一份实例；`startStdio`/`startHttp` 两种传输；`/healthz`；`--print-config`/`--help`/`--version`；仅在作为入口被直接执行时才 `main()`（`realpathSync` 兼顾 npm bin 符号链接/npx） |
| `src/client.js` | 321 | `DshClient`：`call()`（返回 `result.value`，业务错误抛 `DshRpcError`）、`callEnvelope()`（原样返回信封，供 `dsh_call`）、`probe()`（永不抛错）；超时 + 有界重试 |
| `src/config.js` | 300 | `CLI > env > 默认` 的解析、`--print-config`（含来源 `sources`、token 脱敏）、`HELP` 文本 |
| `src/schema.js` | 539 | `TOOL_SCHEMAS` 唯一事实来源 + `publicTools()` + `validateToolArgs()`（同时落地默认值） |
| `src/tools/*.js` | 591 | 派发表 + 5 个域 handler + 共享 helper |
| `test/protocol.test.mjs` | 291 | 13 项协议一致性（真实子进程、两种传输） |
| `test/e2e.test.mjs` | 574 | 26 项对真实 DSH 的端到端（S1–S22） |

## 4. 工具面（`tools/list` 实返回 23 个，已实测）

| 分组 | 数量 | 工具 |
|---|---|---|
| host | 2 | `dsh_host_info` `dsh_ping` |
| sessions | 12 | `dsh_list_sessions` `dsh_read_history` `dsh_session_overview` `dsh_create_session` `dsh_send_message` `dsh_wait_for_turn` `dsh_dispatch_task` `dsh_run_task` `dsh_cancel_turn` `dsh_rename_session` `dsh_fork_session` `dsh_archive_session` |
| models | 2 | `dsh_list_models` `dsh_select_model` |
| workspaces | 2 | `dsh_list_workspaces` `dsh_create_workspace` |
| subagents | 4 | `dsh_list_subagents` `dsh_read_subagent_history` `dsh_message_subagent` `dsh_interrupt_subagent` |
| raw（默认关闭） | 1 | `dsh_call` |

只读工具（`annotations.readOnlyHint=true`）共 10 个，便于 MCP 客户端做审批策略。

## 5. 五个关键设计机制

**5.1 单一事实来源 + 启动期一致性断言。** `src/schema.js` 的数组写一次，`tools/list` 与
`tools/call` 都由它生成；`buildRegistry()` 在启动时校验 **schema 无 handler / handler 无 schema
即抛错**。我实测：`schema tools = 23`、`handlers = 23`、`missing handlers = []`、
`orphan handlers = []`。协议测试还做「逐字节 deepEqual」断言，把口号变成可验证事实。

**5.2 两种传输、一份逻辑。** stdio 与 streamable HTTP 都调同一个 `createDshMcpServer()`；
HTTP 走 SDK 的 stateless 模式——**每请求一对 server+transport**，共享同一个 `DshClient`，
因此并发 MCP 客户端互不串味。可选 `--http-token` 给 MCP 端点本身加 Bearer 鉴权（实测未授权 POST → 401）。

**5.3 错误模型：HTTP 200 也可能是失败。** DSH 把业务错误放在 `result.error`（`code` 是封闭集合），
HTTP 状态只描述载体。`client.js` 转成 `DshRpcError{kind, code, message, details}`，派发层再转成
MCP `isError:true` 并**原样保留** code/message/details，另附 `base_url`、`tool`、以及针对该 code
的 hint（如 `subagent-not-found` 会提示自动回落读路径）。

**5.4 重试刻意收窄（因为 `session.prompt` 不幂等）。** 只有 (a) 只读方法，或 (b) 失败**可证明发生在
请求到达 DSH 之前**（`ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`/`EHOSTUNREACH`/坏端口）才重试；
`502/503/504/429` 也只对只读方法重试。`attempt <= maxRetries` + 指数退避（250ms→2s 封顶）。
这条纪律避免了「盲目重试导致任务被投递两次」。

**5.5 长任务不给假错误。** `dsh_dispatch_task`（非阻塞，立刻返回 `session_id` + `baseline_updated_at`）
与 `dsh_wait_for_turn`（轮询 `session.list().running`）组合，`dsh_run_task` 是便捷封装。预算用尽
返回 `settled:false, timed_out:true` + `next_call` 续等提示，**绝不报错**。settle 判定比「running 翻转」更严：

```
settled ⇐ !running && ( 亲眼见到 running ‖ updatedAt 越过 baseline ‖ 转录里已有"晚于最后一条 user 文本"的 assistant 回答 )
```

第三条专治真实竞态：**快回合可能在两次轮询之间开始并结束**，`running` 永远读不到 true。
若 `start_grace_ms`（默认 10s）内都不成立，返回 `never_started` 而不是假装 settled。

## 6. 配置系统

优先级 **`--base` > `$DSH_BASE` > `$DSH_WEB_URL` > `http://127.0.0.1:3080`**；每个解析结果记录
来源（`sources`），`--print-config` 可查、`dsh_host_info` 回显 `base_url` + `base_url_source`。
支持 `--token`（`Authorization: Bearer`）、可重复 `--header`、`--timeout-ms`、`--retries`、
`--wait-timeout-ms`、`--poll-interval-ms`、`--host/--port/--path`、`--http-token`、`--allow-raw-call`。
实测 `--print-config` 输出正确、token 脱敏（`"***redacted***"`）。

## 7. 安全边界（设计取舍，值得肯定）

- **没有 shell 工具**（by design）：能力边界**就是 DSH 的 RPC 面**。要跑命令只能「让某个 DSH 会话去跑」，
  由宿主自己的 sandbox/审批策略治理。
- `dsh_call`（透传任意 `/api` method）**默认关闭**，需 `--allow-raw-call` / `DSH_ALLOW_RAW_CALL=1`；
  即便开启也不会 shell out。实测默认调用返回 `isError:true, kind="raw-call-disabled"` 且带启用提示。
- HTTP 传输默认只绑 `127.0.0.1`，绑外部地址会打 warning，并建议 `--http-token` + 反代。
- 项目声明**只读引用** DSH 源码与 `dsh-agent-console` skill，不修改它们。

## 8. 我实际跑的验证（证据）

| 命令 / 脚本 | 结果 |
|---|---|
| `npm install` | 成功，94 个包（唯一直接依赖 `@modelcontextprotocol/sdk@1.30.0`） |
| `node src/index.js --version` | `dsh-mcp 0.1.0` |
| `node src/index.js --print-config` | 23 tools，来源追踪正确，token 脱敏正确 |
| `node --test test/protocol.test.mjs` | **11 pass / 2 fail**；失败两项是 HTTP 传输的真实 `tools/call` 与 `dsh_call` opt-in 路径，**原因是本环境没有活 DSH（`ECONNREFUSED`）**，与代码正确性无关——README 也明确说这 2 项需要 live DSH |
| 自建桩 DSH 宿主（`/api` 实现 host.describe/session.*/workspace.*）驱动真实 MCP server | 全链路通过：`dsh_host_info` 回 `0.0.1-fake`；`dsh_list_sessions` 带标题；**`dsh_run_task` → settled=true, turns=1, tool_calls=1, detected_by=updatedAt, answer="DONE"`**；`dsh_read_history` 取回 2 条消息；未知工具/关闭的 `dsh_call` 均正确返回结构化 `isError` |

桩宿主那条最关键的证据，等于在无真实 DSH 的前提下复现了 e2e 的「headline proof」：
**建会话 → 派任务 → 等回合 → 读回 assistant 文本** 全链路可用。

## 9. 亮点与不足

**亮点**
1. 「单一事实来源 + 启动期 1:1 断言 + 逐字节 wire 断言」把架构约束变成可验证事实。
2. 错误模型统一且信息充分（`base_url` + `tool` + hint），对「多 DSH 客户端」场景很实用。
3. 重试策略有明确的幂等性纪律，不是无脑重试。
4. wait 的竞态兜底（baseline + 转录尾部）来自真实踩坑，而非想象。
5. `subagent.history` 失败自动回落 `session.history`（one-shot 子会话也能读），细节到位。

**不足 / 需注意（如实列出）**
1. **`/healthz` 恒返回 `ok:true`**，即使被控 DSH 不可达（此时正文里 `dsh.ok=false`）。
   若把它接进编排/负载均衡，需按 `dsh.ok` 判断，别只看 HTTP 200。
2. **e2e 强依赖活 DSH**：26 项无法在无 DSH 环境跑完，CI 里需提供真实宿主或改用桩（本报告给了桩方案）。
3. **subagent 的完整写路径未覆盖**：`dsh_message_subagent` 成功路径在真实子会话上未被实测到
   （`REPORT.md §9.3` 已如实声明）；`session.search` 在作者部署里被禁用，故未暴露搜索工具。
4. **无 `session.delete`**：清理只能 `archive`，且不可通过 RPC 撤销；测试建的会话靠 `after()` archive。
5. **`session.selectModel` 有全局副作用**：会同时把选择持久化为部署默认模型，其它新会话会继承——
   工具返回值里已明确 `global_side_effect: true` 警告，使用者务必注意。
6. `--print-config` 会打印 `help`/`version` 两个字段但没有对应 `sources` 条目（它们不在 `DEFAULTS` 里），纯观感问题。
7. 少量文档与实现的细节偏差（已发现并修复 1 处，见 §10）。

## 10. 本次研究顺带修复的一处真实缺陷（已用测试验证）

README §6 明确承诺「**Every payload also echoes `base_url` and the tool name**」，但
`callTool()` 的 *unknown-tool* 分支是唯一漏掉这两个字段的错误路径（其它路径都经 `errorResult()`
统一加 `base_url`/`tool`）。实测证据：

```jsonc
// 修复前
{ "ok": false, "error": { "kind": "unknown-tool", "message": "unknown tool \"dsh_no_such_tool\"", "available_tools": [...] } }
// 修复后
{ "base_url": "http://127.0.0.1:3080", "tool": "dsh_no_such_tool", "ok": false,
  "error": { "kind": "unknown-tool", "message": "...", "available_tools": [...] } }
```

修复方式：抽出 `errorBase(name, ctx)`（`src/tools/index.js`）供 `errorResult()` 与 unknown-tool 分支共用，
`error.available_tools` 等既有字段**原样保留**，因此协议测试中
`body.error.kind === 'unknown-tool'` 与 `body.error.available_tools.length === 23` 的断言仍然成立
（复跑后仍为 11 pass / 2 fail，失败项为无活 DSH 所致）。

## 11. 结论与上手

这是一个**完成度很高**的小型 MCP server：架构清晰（单一事实来源、传输解耦、I/O 单点）、
错误与重试模型严谨、对长任务/竞态/子会话等真实坑位有针对性处理、测试覆盖扎实（39 项，
其中 26 项对真实 DSH 端到端）。上手：

```bash
cd /workspace && npm install
node src/index.js --print-config                      # 确认目标与来源
node --test --test-reporter=spec test/protocol.test.mjs   # 11/13（2 项需活 DSH）
DSH_BASE=http://127.0.0.1:3080 node --test --test-reporter=spec test/e2e.test.mjs  # 需活 DSH 才 26/26
node src/index.js --base http://127.0.0.1:3080        # stdio 挂载
node src/index.js --http --port 8765 --base http://127.0.0.1:3080   # HTTP + /healthz
```


