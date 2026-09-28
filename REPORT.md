# T2 · DSH MCP Server — 设计决策、实测输出与坑位

**交付路径**：`/root/Aub/t2-dsh-mcp/`
**被控目标**：真实 DSH 宿主 `http://127.0.0.1:3080`（host version `0.0.1`，provider `local-gateway`）
**状态**：完成。MCP 协议测试 **13/13 通过**；对真实 DSH 的端到端测试 **26/26 通过**（合计 39 项，全部真跑）。

---

## 1. 交付了什么

一个**独立于 DSH 的 MCP server**，把「已有一个 URL 的 DSH 实例」的 `/api` RPC 面暴露成 MCP 工具。
任何 MCP host（Claude Desktop / Cursor / 另一个 DSH 会话 / 自研 host）挂上它之后，就能：

* 列会话 / 读事件级历史 / 读某会话模型清单 / 列工作区
* **新建会话**（工作区或 cwd）→ **派任务**（`session.prompt`）→ **等回合结束** → **取回最后一条 assistant 文本** → **archive 清理**
* 中断回合 / 重命名 / 分叉 / 切模型 / 建工作区
* 列 subagent、读 subagent 转录、给 subagent 发消息、中断 subagent
* 可选（默认关闭）的 `dsh_call`：透传任意 `/api` method

```
MCP host ──stdio 或 streamable HTTP(MCP)──▶ dsh-mcp ──POST /api/<method>──▶ DSH 宿主（URL 可配置）
```

## 2. 结构（严格按要求，另加 1 个配置文件）

```
t2-dsh-mcp/
├── package.json          type:module，依赖钉死 @modelcontextprotocol/sdk@1.30.0
├── README.md             安装/配置/23 个工具用法与示例/已知限制
├── src/
│   ├── index.js          MCP 入口：一份实现，两种传输（stdio 默认 / --http）
│   ├── client.js         唯一发 HTTP 的地方（信封、超时、重试、错误模型）
│   ├── config.js         配置解析：CLI > env > 默认；--print-config 打印来源
│   ├── schema.js         单一事实来源：全部 tool 的 name/description/JSON Schema/默认值/校验
│   └── tools/            index.js（派发表）+ host/session/workspace/subagent/raw + support.js
├── test/
│   ├── protocol.test.mjs MCP 协议一致性（13 项）
│   ├── e2e.test.mjs      对真实 DSH 的端到端（26 项）
│   └── output/           本次实测的原始输出（protocol.txt / e2e.txt / npm-test.txt）
└── REPORT.md             本文件
```

代码量：`src/` 2244 行 + `test/` 865 行（`wc -l`，见 §8）。零编译依赖，`node_modules` 29 MB（只有 MCP SDK 一个依赖）。

## 3. 关键设计决策

### 3.1 零重复：一个数组 + 一张派发表

`src/schema.js` 的 `TOOL_SCHEMAS` 是工具面的**唯一事实来源**：名字、描述、JSON Schema、默认值、参数校验
全部只写一遍。`src/tools/index.js` 把它与 handler 表合并成注册表：

* `tools/list` = `publicTools()`（直接从数组生成）；
* `tools/call` = 同一数组驱动的派发表 + 同一份 `validateToolArgs()`（默认值也在这里落地，不会与行为漂移）；
* **schema 有而 handler 无、或 handler 有而 schema 无 → 启动即抛错**（有测试专门断言 1:1）。

协议测试里加了一条"逐字节"断言：`tools/list` 返回的每个 `inputSchema` 与 `src/schema.js` 里的声明
`deepEqual` —— 把"单一来源"变成可验证事实，而不是口号。

### 3.2 两种传输，一份逻辑

`src/index.js` 里传输选择只出现一次（`startStdio` / `startHttp`），两者都调用同一个
`createDshMcpServer()`（后者内部再调 `buildRegistry()`）。HTTP 走 SDK 的 stateless 模式：
**每请求一对 server+transport**，共享同一个 `DshClient`，因此并发 MCP 客户端互不串味，
而工具实现仍然只有一份。协议测试用两种传输各跑一遍 `tools/list` 并断言工具名数组完全一致。

### 3.3 base URL 真的可配（这是任务的硬要求）

优先级 **CLI > env > 默认**：`--base` > `$DSH_BASE` > `$DSH_WEB_URL` > `http://127.0.0.1:3080`，
`http://` 与 `https://` 都支持，允许带路径前缀（反代场景），并支持 `--token`（`Authorization: Bearer`）
与可重复 `--header`。每个解析结果都记录来源（`sources`），`--print-config` 可查、`dsh_host_info`
会回显 `base_url` + `base_url_source`。

**实测证明（不是声称）**：e2e 的 S19 在进程内起了一个 TCP 转发器（`127.0.0.1:<随机端口>` → `127.0.0.1:3080`，
等价于 `socat`/`ssh -L`；本机没有 socat，所以用 node 自己实现），然后：

1. `DSH_BASE=http://127.0.0.1:37459` 起 server → `dsh_host_info` 回 `base_url=http://127.0.0.1:37459`，
   且 `version/provider` 与直连 3080 的另一个 client 完全一致（证明确实打到了同一台宿主）；
2. `--base http://127.0.0.1:37459` 且**故意把 `DSH_BASE` 污染成 `http://127.0.0.1:1`** →
   仍回 `base_url_source=cli:--base`，证明 CLI 覆盖 env；
3. 负向对照 S20：base 指向一个刚被释放的空闲端口 → `dsh_host_info` 返回 `isError:true`、
   `error.kind="transport"`、`code="ECONNREFUSED"`、消息里点名坏掉的 base。

### 3.4 错误模型：HTTP 200 也可能是失败

DSH 的业务错误在 `result.error`（`code` 是封闭集合），HTTP 状态只描述载体。`client.js` 把它转成
`DshRpcError{kind:'rpc', code, message, details}`，派发层再转成 MCP `isError:true`，**code/message/details
原样保留**，并附 `base_url`、`tool`、以及针对该 code 的 hint（例：`subagent-not-found` 会告诉你
one-shot 子 agent 为什么拒收 prompt、怎么还能读到转录）。

`kind` 共 6 种：`rpc`（业务错误）/ `carrier`（HTTP 非 2xx）/ `transport`（连不上）/ `timeout` /
`protocol`（信封坏了）/ `invalid-arguments`（本地校验失败）。

### 3.5 重试策略：只重试"确定安全"的失败

`session.prompt` 不幂等，盲目重试会**重复派任务**。因此：

* 只读方法（`session.list`/`session.history`/`host.describe`/…）遇 transport 失败或 `502/503/504/429` 才重试；
* 写方法**只在"请求确定没到达 DSH"时**重试（`ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`/bad port），
  超时与 reset 一律不重试。

### 3.6 长任务不给假错误

`dsh_dispatch_task`（非阻塞，立刻返回 `session_id` + `baseline_updated_at`）与 `dsh_wait_for_turn`
（轮询 `session.list` 的 `running`）组合，让调用方自己编排；`dsh_run_task` 是两者的便捷封装。
**预算用尽返回 `settled:false, timed_out:true` + `next_call` 续等提示，绝不报错**（S17 实测：
4 秒预算等 45 秒任务 → 拿到 pending 信封；随后 `dsh_cancel_turn` + `require_start=false` 续等等到静止）。

`dsh_wait_for_turn` 的判定条件比"`running` 翻转"更严：

```
settled ⇐ !running && ( 亲眼看到 running  ||  updatedAt 越过 baseline
                        ||  转录里已有"晚于最后一条 user 文本"的 assistant 回答 )
```

第三条是为了堵一个真实竞态：**快回合可能在两次轮询之间开始并结束**，`running` 永远读不到 true。
若上述条件在 `start_grace_ms`（默认 10s）内都不成立，则返回 `never_started` + 当前最后一条回答
（并给出 `require_start=false` 的续等建议）—— 不假装 settled，也不空转到预算耗尽。

### 3.7 安全边界：没有 shell

不给任何 tool 执行任意命令的能力（那是另一个很大的攻击面）：能力边界**就是 DSH 的 RPC 面**。
要跑命令，只能"让某个 DSH 会话去跑"，由宿主自己的 sandbox/审批策略治理。`dsh_call`（透传任意 method）
默认关闭，只有 `--allow-raw-call` / `DSH_ALLOW_RAW_CALL=1` 才出现；即便开启也不会 shell out。
HTTP 传输默认只绑 `127.0.0.1`，绑到外部地址会打 warning，并可用 `--http-token` 给 MCP 端点本身加 Bearer。

## 4. 与 `dsh-api.mjs` 的取舍

| 问题 | 决定 | 理由 |
|---|---|---|
| 直接调用共享 CLI？ | **不**。重新实现成可导入模块（`src/client.js`） | 红线：`/root/.dsh/skills/dsh-agent-console/` 只读；且 MCP server 需要可复用的库形态，不是 CLI 子进程 |
| 抄它的 `run` 子命令？ | 只借用**语义**（轮询 running、抽最后 assistant 文本、回调思路），代码重写 | MCP 场景要的是"工具返回值"而不是"回调唤醒主 agent"；回调机制在 README 里说明 |
| 它有的而我们没做 | `--detach` 孤儿进程 / 完成回调投递进 inbox / `stream`（`events.mux` WS）/ `skill.list` | MCP 客户端自己负责编排与唤醒；WS 下行流不在本轮最小集内（见 §7 未完成项） |
| 我们比它多做了 | `wait` 竞态兜底（updatedAt baseline + 转录兜底）、`subagent.history` → `session.history` 自动回落、结构化 `isError` 错误模型、重试安全策略、`--print-config` 来源追踪、HTTP 传输 | 都是在真实 DSH 上跑测试时暴露出来的问题，不是凭想象加的 |

**没碰过的东西**：DSH 自身源码（`/root/.nvm/.../@deepseek-ai/dsh/`）、
`/root/.dsh/skills/dsh-agent-console/`、`/root/Temp/.dsh/skills/`。全部只读引用。

## 5. Tools（23 个，`tools/list` 实际返回 23）

| # | tool | 对应 DSH method | 只读 |
|---|---|---|---|
| 1 | `dsh_host_info` | `host.describe` | ✅ |
| 2 | `dsh_ping` | `host.describe`（探活，不抛错） | ✅ |
| 3 | `dsh_list_sessions` | `session.list` | ✅ |
| 4 | `dsh_read_history` | `session.history` | ✅ |
| 5 | `dsh_session_overview` | `session.list`+`history`+`models` | ✅ |
| 6 | `dsh_create_session` | `session.create` | |
| 7 | `dsh_send_message` | `session.prompt` | |
| 8 | `dsh_wait_for_turn` | 轮询 `session.list` | ✅ |
| 9 | `dsh_dispatch_task` | `session.create`+`prompt` | |
| 10 | `dsh_run_task` | dispatch+wait | |
| 11 | `dsh_cancel_turn` | `session.cancel` | |
| 12 | `dsh_rename_session` | `session.rename` | |
| 13 | `dsh_fork_session` | `session.fork` | |
| 14 | `dsh_archive_session` | `workspace.archiveSession` | |
| 15 | `dsh_list_models` | `session.models` | ✅ |
| 16 | `dsh_select_model` | `session.selectModel`（⚠️ 全局副作用） | |
| 17 | `dsh_list_workspaces` | `workspace.list` | ✅ |
| 18 | `dsh_create_workspace` | `workspace.create` | |
| 19 | `dsh_list_subagents` | `subagent.list` | ✅ |
| 20 | `dsh_read_subagent_history` | `subagent.history`（+`session.history` 回落） | ✅ |
| 21 | `dsh_message_subagent` | `subagent.prompt` | |
| 22 | `dsh_interrupt_subagent` | `subagent.interrupt` | |
| 23 | `dsh_call` | 任意 method（**默认关闭**） | |

> 任务书最小集 14 个，实际 23 个；`dsh_read_subagent_history`、`dsh_fork_session`、
> `dsh_session_overview`、`dsh_ping`、`dsh_run_task`、`dsh_call` 是额外补的。

## 6. 实测输出（原始）

命令与产物：

```bash
cd /root/Aub/t2-dsh-mcp
node --test --test-reporter=spec test/protocol.test.mjs   # → test/output/protocol.txt
node --test --test-reporter=spec test/e2e.test.mjs        # → test/output/e2e.txt  (2743 行 / 101 KB)
npm test                                                  # → test/output/npm-test.txt
```

### 6.1 `test/protocol.test.mjs` —— 完整原始输出（13/13 通过）

```text
serverInfo = {"name":"dsh-mcp","version":"0.1.0"}
capabilities = {"tools":{}}
protocolVersion = (sdk did not expose it)
✔ initialize handshake: server identity + tool capability (2165.649278ms)
tools/list returned 23 tools (src/schema.js declares 23)
names: dsh_host_info, dsh_ping, dsh_list_sessions, dsh_read_history, dsh_session_overview, dsh_create_session, dsh_send_message, dsh_wait_for_turn, dsh_dispatch_task, dsh_run_task, dsh_cancel_turn, dsh_rename_session, dsh_fork_session, dsh_archive_session, dsh_list_models, dsh_select_model, dsh_list_workspaces, dsh_create_workspace, dsh_list_subagents, dsh_message_subagent, dsh_interrupt_subagent, dsh_read_subagent_history, dsh_call
every wire inputSchema deep-equals the declaration in src/schema.js ✔
registry built: 23 dispatch entries
dispatch table size = 23, schema entries = 23
✔ tools/list is generated from src/schema.js (single source of truth) (28.108016ms)
✔ handler table and schema array are 1:1 (no orphan handler, no handler-less tool) (2.389115ms)
isError = true
payload =
{
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_read_history",
  "ok": false,
  "error": {
    "kind": "invalid-arguments",
    "message": "invalid arguments for dsh_read_history: missing required property \"session_id\"",
    "issues": [
      "missing required property \"session_id\""
    ]
  }
}
✔ tools/call with a missing required argument -> isError (not a transport crash) (18.476433ms)
isError = true
payload = {
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_host_info",
  "ok": false,
  "error": {
    "kind": "invalid-arguments",
    "message": "invalid arguments for dsh_host_info: unknown property \"nonsense\" (accepted: none)",
    "issues": [
      "unknown property \"nonsense\" (accepted: none)"
    ]
  }
}
✔ tools/call with an unknown property -> isError (4.475673ms)
payload = {
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_send_message",
  "ok": false,
  "error": {
    "kind": "invalid-arguments",
    "message": "invalid arguments for dsh_send_message: \"mode\" must be one of queue | steer",
    "issues": [
      "\"mode\" must be one of queue | steer"
    ]
  }
}
✔ tools/call with a bad enum value -> isError (4.932324ms)
payload (truncated) = {
  "ok": false,
  "error": {
    "kind": "unknown-tool",
    "message": "unknown tool \"dsh_no_such_tool\"",
    "available_tools": [
      "dsh_host_info",
      "dsh_ping",
      "dsh_list_sessions
✔ tools/call for an unknown tool name -> isError listing the real tools (4.44835ms)
payload = {
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_call",
  "ok": false,
  "error": {
    "kind": "raw-call-disabled",
    "message": "dsh_call is disabled on this server instance",
    "details": {
      "method": "session.list"
    }
  },
  "hint": "Restart the MCP server with --allow-raw-call (or DSH_ALLOW_RAW_CALL=1) to enable the raw /api passthrough. It is off by default because it bypasses every curated guard rail, including destructive-tool annotations and the selectModel warning."
}
✔ dsh_call is refused by default (--allow-raw-call is opt-in) (8.913464ms)
payload = {
  "base_url": "http://127.0.0.1:45917",
  "tool": "dsh_host_info",
  "ok": false,
  "error": {
    "kind": "transport",
    "method": "host.describe",
    "code": "ECONNREFUSED",
    "message": "cannot reach DSH at http://127.0.0.1:45917 (ECONNREFUSED): is the host running and is --base correct?",
    "base": "http://127.0.0.1:45917"
  },
  "hint": "Carrier-level failure: the DSH host was not reached. Check --base / DSH_BASE and that the host is running."
}
server stderr = [dsh-mcp] info: stdio transport ready — 23 tools, DSH base http://127.0.0.1:3080 (from env:DSH_BASE)
[dsh-mcp] warn: dsh_call failed: dsh_call is disabled on this server instance
✔ an unreachable DSH base surfaces as isError with kind=transport naming the base (67.177769ms)
✔ transport-level error text (stderr) stays off stdout: server logged the base it uses (1.943171ms)
healthz = {"ok":true,"server":{"name":"dsh-mcp","version":"0.1.0"},"tools":23,"dsh_base":"http://127.0.0.1:3080","dsh":{"ok":true,"base":"http://127.0.0.1:3080","elapsedMs":89,"value":{"version":"0.0.1","cwd":"/root","provider":"local-gateway","model":"deepseek-ai/DeepSeek-V4.1-Flash","attachedSessions":46,"canOpenPath":false}}}
server stderr = [dsh-mcp] info: DSH reachable at http://127.0.0.1:3080
[dsh-mcp] info: streamable HTTP transport ready — http://127.0.0.1:43295/mcp (23 tools, DSH base http://127.0.0.1:3080 from env:DSH_BASE)
HTTP tools/list returned 23 tools
HTTP dsh_host_info = { "base_url": "http://127.0.0.1:3080", "base_url_source": "env:DSH_BASE", "version": "0.0.1", "cwd": "/root", "provider": "local-gateway", "model": "deepseek-ai/DeepSeek-V4.1-Flash", "attachedSessions": 46, "canOpenPath": false }
HTTP dsh_call (disabled) isError = true
✔ streamable HTTP transport exposes the same surface and carries a real tools/call (1464.68209ms)
payload (truncated) = {"method":"host.describe","http_status":200,"attempts":1,"elapsed_ms":109,"base_url":"http://127.0.0.1:3080","ok":true,"envelope":{"type":"server-response","rpcId":"mcp-muebmwg9-1","result":{"ok":true,"value":{"version":"0.0.1","cwd":"/root","provider":"local-gateway","model":"deepseek-ai/DeepSeek-V4.1-Flash","attachedSessions":46,"canOpenPath":false}}}}
raw business error = {"method":"session.models","http_status":200,"attempts":1,"elapsed_ms":1351,"base_url":"http://127.0.0.1:3080","ok":false,"error":{"code":"session-not-found","message":"session \"session-does-not-exist\" not found","details":{"sessionId":"session-does-not-exist"}}}
config.dsh_call is advertised in tools/list even when disabled: true
✔ dsh_call works once --allow-raw-call is passed (opt-in path) (2405.052505ms)
unauthenticated POST /mcp -> HTTP 401
authenticated tools/list -> 23 tools
✔ --http-token protects the MCP endpoint when set (948.733328ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8033.164091
```

### 6.2 `test/e2e.test.mjs` —— 逐项结论清单（26/26 通过）

```text
✔ S1 dsh_host_info reports the live host and the base URL actually used (917.829256ms)
✔ S2 dsh_ping confirms reachability with latency (20.800868ms)
✔ S3 dsh_list_workspaces contains the Aub workspace (21.37086ms)
✔ S4 dsh_list_sessions filters by cwd and by running flag (8455.87542ms)
✔ S4b dsh_create_workspace is idempotent for the Aub path and rejects a missing directory (15.047266ms)
✔ S5 dsh_create_session + dsh_rename_session inside the Aub workspace (81.100371ms)
✔ S5b dsh_create_session with cwd yields an ungrouped session, and workspace+cwd is rejected (71.698243ms)
✔ S6 dsh_send_message delivers a real task to that session (20.962735ms)
✔ S7 dsh_wait_for_turn settles and returns the assistant answer (11911.160807ms)
✔ S8 the file the remote session wrote really exists (MCP-driven side effect) (3.609946ms)
✔ S9 dsh_read_history sees both the prompt and the answer (82.687869ms)
✔ S10 dsh_session_overview aggregates summary + title + models + history (3607.123534ms)
✔ S11 dsh_list_models + idempotent dsh_select_model round-trip (2166.388648ms)
✔ S12 dsh_select_model rejects a bogus provider as a structured DSH error (10.182814ms)
✔ S13 dsh_list_subagents on the test session (2208.319353ms)
✔ S13b dsh_fork_session forks the finished turn into a new session (2062.906698ms)
✔ S13c dsh_read_subagent_history reads a child transcript when one exists (10855.520796ms)
✔ S14 dsh_dispatch_task returns immediately (non-blocking) with a session id (2039.6876ms)
✔ S15 dsh_wait_for_turn with require_start=false collects the dispatched result (7617.235513ms)
✔ S16 dsh_run_task: dispatch + wait in one call (8833.125287ms)
✔ S17 a budget that is too small returns "still running" instead of an error (11409.672586ms)
✔ S18 dsh_archive_session hides the session and shows up in archivedSessionIds (68.25322ms)
✔ S19 a non-default base URL really moves the wire target (TCP forwarder on a random port) (1774.375692ms)
✔ S20 a wrong base URL fails loudly, naming the base (negative control) (832.358783ms)
✔ S21 the same tools over streamable HTTP drive the real DSH (3904.660963ms)
✔ S22 subagent tools on a child this test spawned itself (list / read / message / interrupt) (28605.14546ms)
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 108584.89367
```

### 6.3 一次 `npm test` 跑完整套（39/39 通过，raw）

```text
✔ S1 dsh_host_info reports the live host and the base URL actually used (1163.30307ms)
✔ S2 dsh_ping confirms reachability with latency (20.282883ms)
✔ S3 dsh_list_workspaces contains the Aub workspace (22.807524ms)
✔ S4 dsh_list_sessions filters by cwd and by running flag (9201.101164ms)
✔ S4b dsh_create_workspace is idempotent for the Aub path and rejects a missing directory (14.070399ms)
✔ S5 dsh_create_session + dsh_rename_session inside the Aub workspace (96.259511ms)
✔ S5b dsh_create_session with cwd yields an ungrouped session, and workspace+cwd is rejected (89.566921ms)
✔ S6 dsh_send_message delivers a real task to that session (15.821951ms)
✔ S7 dsh_wait_for_turn settles and returns the assistant answer (12703.36629ms)
✔ S8 the file the remote session wrote really exists (MCP-driven side effect) (1.756575ms)
✔ S9 dsh_read_history sees both the prompt and the answer (111.016167ms)
✔ S10 dsh_session_overview aggregates summary + title + models + history (2292.050498ms)
✔ S11 dsh_list_models + idempotent dsh_select_model round-trip (2226.134688ms)
✔ S12 dsh_select_model rejects a bogus provider as a structured DSH error (10.439316ms)
✔ S13 dsh_list_subagents on the test session (2188.395023ms)
✔ S13b dsh_fork_session forks the finished turn into a new session (2441.171877ms)
✔ S13c dsh_read_subagent_history reads a child transcript when one exists (12623.500697ms)
✔ S14 dsh_dispatch_task returns immediately (non-blocking) with a session id (2954.181068ms)
✔ S15 dsh_wait_for_turn with require_start=false collects the dispatched result (7992.815294ms)
✔ S16 dsh_run_task: dispatch + wait in one call (15989.898413ms)
✔ S17 a budget that is too small returns "still running" instead of an error (17550.016404ms)
✔ S18 dsh_archive_session hides the session and shows up in archivedSessionIds (60.807215ms)
✔ S19 a non-default base URL really moves the wire target (TCP forwarder on a random port) (2093.932097ms)
✔ S20 a wrong base URL fails loudly, naming the base (negative control) (782.712183ms)
✔ S21 the same tools over streamable HTTP drive the real DSH (3903.261906ms)
✔ S22 subagent tools on a child this test spawned itself (list / read / message / interrupt) (37448.804091ms)
✔ initialize handshake: server identity + tool capability (2100.997197ms)
✔ tools/list is generated from src/schema.js (single source of truth) (22.431524ms)
✔ handler table and schema array are 1:1 (no orphan handler, no handler-less tool) (2.636296ms)
✔ tools/call with a missing required argument -> isError (not a transport crash) (18.648673ms)
✔ tools/call with an unknown property -> isError (4.871172ms)
✔ tools/call with a bad enum value -> isError (6.19175ms)
✔ tools/call for an unknown tool name -> isError listing the real tools (6.322116ms)
✔ dsh_call is refused by default (--allow-raw-call is opt-in) (7.364717ms)
✔ an unreachable DSH base surfaces as isError with kind=transport naming the base (59.798039ms)
✔ transport-level error text (stderr) stays off stdout: server logged the base it uses (1.559335ms)
✔ streamable HTTP transport exposes the same surface and carries a real tools/call (1301.757355ms)
✔ dsh_call works once --allow-raw-call is passed (opt-in path) (3676.009654ms)
✔ --http-token protects the MCP endpoint when set (1176.268652ms)
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 135023.89473
```

### 6.4 端到端关键原始载荷（从 `test/output/e2e.txt` 原样摘录）

--- dsh_host_info (87 ms) ---
{
  "base_url": "http://127.0.0.1:3080",
  "base_url_source": "env:DSH_BASE",
  "version": "0.0.1",
  "cwd": "/root",
  "provider": "local-gateway",
  "model": "deepseek-ai/DeepSeek-V4.1-Flash",
  "attachedSessions": 46,
  "canOpenPath": false
}
host: version=0.0.1 provider=local-gateway model=deepseek-ai/DeepSeek-V4.1-Flash attached=46 base_url_source=env:DSH_BASE

--- dsh_ping (18 ms) ---
{
  "ok": true,
  "base": "http://127.0.0.1:3080",
  "elapsedMs": 12,
  "value": {
    "version": "0.0.1",
    "cwd": "/root",
    "provider": "local-gateway",
    "model": "deepseek-ai/DeepSeek-V4.1-Flash",
    "attachedSessions": 46,
    "canOpenPath": false
  },
  "timeout_ms": 30000,
  "retries": 2,
  "hint": "DSH answered host.describe — the configured base URL is live."
}
ping ok in 12 ms

--- dsh_list_workspaces (20 ms) ---
{
  "count": 7,
  "archived_session_count": 54,
  "workspaces": [
    {
      "workspace_id": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
      "title": "Aub",
      "path": "/root/Aub",
      "session_count": 28,
      "session_ids": [
        "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
        "session-13e257c8-0d39-4aac-92ac-a27acc34aabd",
        "session-4a38a158-4713-4e32-8361-4dfcea5e5521",
        "session-8b7dfa09-0349-45ff-a97d-efe65e85f6f8",
        "session-4581816d-7686-4b06-91f1-f78b33b9b3b3",
        "session-3c7f7b46-867f-423d-8a4b-8e1375ab627b",
        "session-36f1c4f3-0403-4d1d-b661-6110b25ff874",
        "session-6a07946a-3b1f-4058-8b10-aa67316e3caf",
        "session-ae1d84d8-a65f-4754-a3d9-a6da5680b48c",
        "session-9dee1c41-0505-472e-a9a6-93eb1a0d610b",
        "session-4d8f96ff-0090-4607-9b79-2d640e82bc87",
        "session-671dcb4a-2909-46a8-a1d3-ad9867d4b3c7",
        "session-4ebc764c-a8ad-48bf-8b21-dcc3ba366b7e",
        "session-01dc2df9-f66b-433a-b225-e16a09959325",
        "session-51efc307-4b7e-4e11-90ec-6c5a6b4674a0",
        "session-09f0dc13-7697-4f1e-84c4-428f640d8bc2",
        "session-1365a746-8939-40c1-9085-9a94aeb8abfe",
        "session-96b2cb2a-bb0d-4b67-a9cf-a7a14514a051",
        "session-58b8716f-1a11-40af-9540-204b39c2ced4",
        "session-6ecbcd4f-bc99-432b-8a40-15930d48d435",
        "session-2bc263c0-0cd7-43cf-ad51-dd08bbf48a65",
        "session-69dd0612-342d-48b9-8b7e-101530e96c93",
        "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
        "session-06e25024-01a5-49c6-9078-c4a8392e0c7d",
        "session-c76501ca-780c-4f42-9731-7e84d3d2e9b2",
        "session-1d91a912-32de-41bd-937f-95002ca37bf0",
        "session-66f97059-ff65-4df7-8585-64724acc2899",
        "session-2456fd15-3995-48ee-ab47-e646a275e685"
      ],
      "created_at": "2026-09-23T15:28:36.876Z",
      "updated_at": "2026-09-23T16:30:03.966Z"
    },
    {
      "workspace_id": "5f25cf7a-5950-4c28-9a25-3fad37dc35ca",
      "title": "EveryThing2API",
      "path": "/root/EveryThing2API",
      "session_count": 6,
      "session_ids": [
        "session-b21a9a99-88c1-4c75-9027-c3283a409e0f",
        "session-01368ab0-8124-4c51-9f6c-487eb339114f",
        "session-a5623935-de94-4246-936e-85580dcebc74",
        "session-b0e9f285-e23d-446a-b04b-1277a5c15686",
        "session-f42a4d0c-0a6f-48bd-b910-f23627d795e7",
        "session-e366ffe9-ad60-410f-b256-9aaf504d274b"
      ],
      "created_at": "2026-09-04T15:26:16.175Z",
      "updated_at": "2026-09-05T14:42:40.050Z"
    },
    {
      "worksp
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_list_sessions (5992 ms) ---
{
  "total_matching": 45,
  "returned": 5,
  "total_sessions_on_host": 668,
  "filter": {
    "cwd": "/root/Aub",
    "running_only": false
  },
  "sessions": [
    {
      "session_id": "d6e59e62-cd98-49c7-a619-7938d227a2ea",
      "updated_at": 1790181011282,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
      "origin": "subagent",
      "agent_preset": "standard",
      "title": "Run this exact bash command"
    },
    {
      "session_id": "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
      "updated_at": 1790181006607,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard",
      "title": "T2 e2e: subagent tools"
    },
    {
      "session_id": "session-13e257c8-0d39-4aac-92ac-a27acc34aabd",
      "updated_at": 1790180986617,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard",
      "title": "T2 e2e: cancel + timeout"
    },
    {
      "session_id": "session-4a38a158-4713-4e32-8361-4dfcea5e5521",
      "updated_at": 1790180975436,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard",
      "title": "T2 e2e: run_task"
    },
    {
      "session_id": "session-8b7dfa09-0349-45ff-a97d-efe65e85f6f8",
      "updated_at": 1790180963659,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard",
      "title": "T2 e2e: dispatch_task"
    }
  ]
}
sessions in /root/Aub: 5 of 45 matching (host total 668)

--- dsh_list_sessions (running_only) (2461 ms) ---
{
  "total_matching": 13,
  "returned": 10,
  "total_sessions_on_host": 668,
  "filter": {
    "cwd": null,
    "running_only": true
  },
  "sessions": [
    {
      "session_id": "7bcb01d7-f5f0-4b45-8020-da74fc1fb624",
      "updated_at": 1790180513275,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
      "origin": "subagent",
      "agent_preset": "standard"
    },
    {
      "session_id": "d6aabc38-a9ad-4b35-a592-03fef046751a",
      "updated_at": 1790180513262,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
      "origin": "subagent",
      "agent_preset": "standard"
    },
    {
      "session_id": "ada2e34c-3ef2-4a53-a227-055de9e10932",
      "updated_at": 1790180198256,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
      "origin": "subagent",
      "agent_preset": "standard"
    },
    {
      "session_id": "53cf16a2-1e7f-4039-bbaa-eacafea36823",
      "updated_at": 1790180198242,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
      "origin": "subagent",
      "agent_preset": "standard"
    },
    {
      "session_id": "6631f578-656b-4a6a-a1ba-4da82b13dfbf",
      "updated_at": 1790179770154,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-69dd0612-342d-48b9-8b7e-101530e96c93",
      "origin": "subagent",
      "agent_preset": "standard"
    },
    {
      "session_id": "679ffb78-9d36-4bd7-8de9-1aad8fea333e",
      "updated_at": 1790178949380,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
      "origin": "subagent",
      "agent_preset": "standard"
    },
    {
      "session_id": "session-69dd0612-342d-48b9-8b7e-101530e96c93",
      "updated_at": 1790178835490,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
      "updated_at": 1790178835373,
      "running": true,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": n
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_create_workspace (existing path) (11 ms) ---
{
  "created": false,
  "already_registered": true,
  "workspace_id": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
  "path": "/root/Aub",
  "title": "Aub",
  "session_ids": [
    "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
    "session-13e257c8-0d39-4aac-92ac-a27acc34aabd",
    "session-4a38a158-4713-4e32-8361-4dfcea5e5521",
    "session-8b7dfa09-0349-45ff-a97d-efe65e85f6f8",
    "session-4581816d-7686-4b06-91f1-f78b33b9b3b3",
    "session-3c7f7b46-867f-423d-8a4b-8e1375ab627b",
    "session-36f1c4f3-0403-4d1d-b661-6110b25ff874",
    "session-6a07946a-3b1f-4058-8b10-aa67316e3caf",
    "session-ae1d84d8-a65f-4754-a3d9-a6da5680b48c",
    "session-9dee1c41-0505-472e-a9a6-93eb1a0d610b",
    "session-4d8f96ff-0090-4607-9b79-2d640e82bc87",
    "session-671dcb4a-2909-46a8-a1d3-ad9867d4b3c7",
    "session-4ebc764c-a8ad-48bf-8b21-dcc3ba366b7e",
    "session-01dc2df9-f66b-433a-b225-e16a09959325",
    "session-51efc307-4b7e-4e11-90ec-6c5a6b4674a0",
    "session-09f0dc13-7697-4f1e-84c4-428f640d8bc2",
    "session-1365a746-8939-40c1-9085-9a94aeb8abfe",
    "session-96b2cb2a-bb0d-4b67-a9cf-a7a14514a051",
    "session-58b8716f-1a11-40af-9540-204b39c2ced4",
    "session-6ecbcd4f-bc99-432b-8a40-15930d48d435",
    "session-2bc263c0-0cd7-43cf-ad51-dd08bbf48a65",
    "session-69dd0612-342d-48b9-8b7e-101530e96c93",
    "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
    "session-06e25024-01a5-49c6-9078-c4a8392e0c7d",
    "session-c76501ca-780c-4f42-9731-7e84d3d2e9b2",
    "session-1d91a912-32de-41bd-937f-95002ca37bf0",
    "session-66f97059-ff65-4df7-8585-64724acc2899",
    "session-2456fd15-3995-48ee-ab47-e646a275e685"
  ],
  "hint": "The path was already registered — create is idempotent and nothing changed."
}

--- dsh_create_workspace (missing dir, expect isError) (3 ms) ---
{
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_create_workspace",
  "ok": false,
  "error": {
    "kind": "bad-directory",
    "message": "directory does not exist on the DSH host: /root/Aub/definitely-not-a-real-dir-e2e",
    "details": {
      "path": "/root/Aub/definitely-not-a-real-dir-e2e"
    }
  },
  "hint": "workspace.create never mkdirs: create the directory on the DSH host first (or let dsh_create_session / dsh_dispatch_task claim an existing one)."
}
local pre-check produced a structured bad-directory error instead of a raw RPC failure

--- dsh_create_session (67 ms) ---
{
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "agent_preset": "standard",
  "workspace": {
    "workspaceId": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
    "path": "/root/Aub",
    "created": false,
    "matched": "path"
  },
  "grouped": true
}

--- dsh_create_session (cwd only) (68 ms) ---
{
  "session_id": "session-9745a419-990d-4351-aa59-01406ef1b993",
  "agent_preset": "standard",
  "workspace": null,
  "grouped": false,
  "warning": "cwd-only creation yields an UNGROUPED session; no RPC can attach it to a workspace afterwards."
}

--- dsh_create_session (workspace + cwd, expect isError) (3 ms) ---
{
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_create_session",
  "ok": false,
  "error": {
    "kind": "bad-request",
    "message": "pass either workspace or cwd, not both"
  },
  "hint": "session.create accepts at most one of workspaceId and cwd."
}

--- dsh_send_message (20 ms) ---
{
  "accepted": true,
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "mode": "queue",
  "hint": "accepted=true means the message entered the session inbox; read the answer with dsh_wait_for_turn (blocking-ish) or dsh_read_history (peek)."
}

--- dsh_wait_for_turn (11906 ms) ---
{
  "settled": true,
  "running": false,
  "timed_out": false,
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "polls": 2,
  "saw_running": true,
  "settle_detected_by": "running-flag",
  "title": "T2 e2e: MCP 操控真实 DSH",
  "turns": 1,
  "tool_calls": 1,
  "event_kinds": {
    "permission/preset": 1,
    "sandbox/mode": 1,
    "approval/policy": 1,
    "session/title": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "step/start": 2,
    "user/message": 3,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 22,
    "assistant/message": 2,
    "tool/call": 1,
    "tool/result": 1,
    "step/end": 2,
    "turn/end": 1
  },
  "last_assistant_text": "E2E-OK",
  "last_seq": 42,
  "history_has_more": false,
  "summary": {
    "sessionId": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
    "updatedAt": 1790181164439,
    "running": false,
    "blank": false,
    "cwd": "/root/Aub",
    "agentPreset": "standard",
    "projections": {
      "asOfSeq": 42,
      "values": {
        "sessionStats": {
          "turns": 1,
          "steps": 2,
          "llmMs": 7527,
          "toolMs": 45,
          "ttftMs": 6655,
          "ttftSteps": 2,
          "decodeMs": 872,
          "decodeTokens": 94
        },
        "title": "T2 e2e: MCP 操控真实 DSH",
        "goal": null,
        "tokenUsage": {
          "uncachedInputTokens": 16304,
          "outputTokens": 94,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0
        },
        "contextPressure": {
          "pressureTokens": 8205,
          "projectedTokens": 8215,
          "contextWindow": 1000000
        },
        "contextBreakdown": {
          "systemTokens": 1515,
          "toolsTokens": 6376,
          "messageTokens": 539
        },
        "subagentTiming": {
          "settledMs": 0
        },
        "subagent": null,
        "permissions": {
          "options": [
            {
              "value": "read-only",
              "name": "read-only"
            },
            {
              "value": "workspace-write",
              "name": "workspace-write"
            },
            {
              "value": "danger-full-access",
              "name": "danger-full-access"
            }
          ],
          "currentValue": "danger-full-access"
        },
        "sessionListMetadata": {
          "blank": false,
          "lastPromptAt": 1790181164439
        },
        "imageLimits": {
          "maxImageBytes": 5242880,
          "maxImagesPerMessage": 20,
          "maxMessageImageBytes": 104857600
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_read_history (61 ms) ---
{
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "method": "session.history",
  "max_messages": 20,
  "before_seq": null,
  "events_returned": 43,
  "has_more": false,
  "first_seq": 0,
  "last_seq": 42,
  "next_before": null,
  "title": "T2 e2e: MCP 操控真实 DSH",
  "as_of_seq": 42,
  "turns": 1,
  "tool_calls": 1,
  "event_kinds": {
    "permission/preset": 1,
    "sandbox/mode": 1,
    "approval/policy": 1,
    "session/title": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "step/start": 2,
    "user/message": 3,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 22,
    "assistant/message": 2,
    "tool/call": 1,
    "tool/result": 1,
    "step/end": 2,
    "turn/end": 1
  },
  "last_assistant_text": "E2E-OK",
  "messages": [
    {
      "seq": 8,
      "role": "user",
      "text": "请用 bash 在 /tmp/mcp-e2e.txt 写入一行 E2E-OK（文件内容就这一行），然后用一行回复 E2E-OK。不要做其它事情。"
    },
    {
      "seq": 9,
      "role": "user",
      "text": "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.\n\nApproval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`)."
    },
    {
      "seq": 10,
      "role": "user",
      "text": "<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `cloud-subagent`: 把 ModelScope 上的 qwenpaw 云端实例当作远程 subagent 外包任务：判断哪些任务值得派、如何派、如何下载产物，并且每次都必须同时派一个本地监督 subagent 做定时巡检、成果验收与汇报。适用于需要真实浏览器/桌面 GUI 自动化、大容量磁盘中间产物、干净 Linux 环境装依赖跑长任务、或 docx/xlsx/pptx/pdf 产物的任务。\n- `cloud-webdav`: 用 OpenList/天翼云盘 的 WebDAV 网盘存放与取回云端 Agent 的产物，绕开本地 500 MB 磁盘限制。含局域网与公网两个入口的真实速度对比、各自的体积上限、分片/直传配方，以及\"HTTP 状态码不可信\"的验收纪律。也记录了 OpenList 侧所有相关配置项的实际效果（302 重定向、直连上传、上传并发、秒传）。\n- `dsh-agent-console`: 用命令行直接操控 DSH 宿主自身的 /api RPC 面：列会话、读事件级明细、创建/重命名/中断会话、发消息、切模型、管理工作区（含创建）、控制 subagent。核心是 `run` 子命令——新建一个对话把任务派出去，阻塞等它跑完，然后把完成报告回调投递进主 agent 的 inbox 唤醒主 agent；`--detach` 让它成为孤儿进程，从而绕开 DSH 后台 job 的第二条完成通知，保证只唤醒一次。含全部 method 的载荷/返回结构、源码位置与实测坑位。\n</available_skills>\n\nIf the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_read_history (before=0) (19 ms) ---
{
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "method": "session.history",
  "max_messages": 20,
  "before_seq": 0,
  "events_returned": 0,
  "has_more": false,
  "first_seq": null,
  "last_seq": null,
  "next_before": null,
  "title": null,
  "as_of_seq": null,
  "turns": 0,
  "tool_calls": 0,
  "event_kinds": {},
  "last_assistant_text": "",
  "messages": []
}
paged backwards: 0 events, seq range null..null, has_more=false

--- dsh_session_overview (3606 ms) ---
{
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "summary": {
    "sessionId": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
    "updatedAt": 1790181164439,
    "running": false,
    "blank": false,
    "cwd": "/root/Aub",
    "agentPreset": "standard",
    "projections": {
      "asOfSeq": 42,
      "values": {
        "sessionStats": {
          "turns": 1,
          "steps": 2,
          "llmMs": 7527,
          "toolMs": 45,
          "ttftMs": 6655,
          "ttftSteps": 2,
          "decodeMs": 872,
          "decodeTokens": 94
        },
        "title": "T2 e2e: MCP 操控真实 DSH",
        "goal": null,
        "tokenUsage": {
          "uncachedInputTokens": 16304,
          "outputTokens": 94,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0
        },
        "contextPressure": {
          "pressureTokens": 8205,
          "projectedTokens": 8215,
          "contextWindow": 1000000
        },
        "contextBreakdown": {
          "systemTokens": 1515,
          "toolsTokens": 6376,
          "messageTokens": 539
        },
        "subagentTiming": {
          "settledMs": 0
        },
        "subagent": null,
        "permissions": {
          "options": [
            {
              "value": "read-only",
              "name": "read-only"
            },
            {
              "value": "workspace-write",
              "name": "workspace-write"
            },
            {
              "value": "danger-full-access",
              "name": "danger-full-access"
            }
          ],
          "currentValue": "danger-full-access"
        },
        "sessionListMetadata": {
          "blank": false,
          "lastPromptAt": 1790181164439
        },
        "imageLimits": {
          "maxImageBytes": 5242880,
          "maxImagesPerMessage": 20,
          "maxMessageImageBytes": 104857600,
          "maxImagePixels": 40000000,
          "mediaTypes": [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif"
          ]
        },
        "todos": null,
        "plan": {
          "active": false,
          "pending": false
        }
      }
    }
  },
  "title": "T2 e2e: MCP 操控真实 DSH",
  "models": {
    "current": {
      "provider": "local-gateway",
      "model": "deepseek-ai/DeepSeek-V4.1-Flash"
    },
    "routable": true,
    "group_count": 2,
    "failures": []
  },
  "history": {
    "events_returned": 43,
    "has_more": false,
    "last_seq": 42,
    "turns": 1,
    "tool_calls": 1,
    "event_kinds": {
      "pe
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_list_models (9 ms) ---
{
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "current": {
    "provider": "local-gateway",
    "model": "deepseek-ai/DeepSeek-V4.1-Flash"
  },
  "routable": true,
  "group_count": 2,
  "groups": [
    {
      "provider": null,
      "models": [
        "deepseek-v4-flash",
        "deepseek-v4-pro"
      ],
      "routable": null
    },
    {
      "provider": null,
      "models": [
        "deepseek-ai/DeepSeek-V4.1-Flash",
        "zai-org/GLM-5.2",
        "Qwen/Qwen3.8-27B"
      ],
      "routable": null
    }
  ],
  "failures": []
}
routable=true groups=2 failures=0

--- dsh_select_model (same value, idempotent) (2156 ms) ---
{
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "selected": {
    "provider": "local-gateway",
    "model": "deepseek-ai/DeepSeek-V4.1-Flash"
  },
  "global_side_effect": true,
  "hint": "WARNING: session.selectModel also persisted this choice as the DEPLOYMENT DEFAULT (agent-default-model) — other sessions created later will inherit it."
}
selectModel round-trip ok — deployment default was kept at the same value on purpose

--- dsh_select_model (bogus, expect isError) (9 ms) ---
{
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_select_model",
  "ok": false,
  "error": {
    "kind": "rpc",
    "method": "session.selectModel",
    "code": "model-unavailable",
    "message": "no adapter registered for provider \"no-such-provider\"",
    "details": {
      "provider": "no-such-provider",
      "model": "no-such-model"
    },
    "base": "http://127.0.0.1:3080"
  },
  "hint": "DSH rejected the call with code \"model-unavailable\" — this is a business error carried on an HTTP 200 response; the payload above is verbatim."
}
DSH business error carried on HTTP 200 was surfaced as: code=model-unavailable

--- dsh_list_subagents (2208 ms) ---
{
  "parent_session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "parent_available": true,
  "count": 0,
  "entries": [],
  "hint": "Child ids from subagent.list are bare uuids (no \"session-\" prefix) — pass them verbatim. Only continuable children accept subagent.prompt; subagent.interrupt is accepted for one-shot children too, and every child transcript is readable (one-shot children via the session.history fallback)."
}
subagents of session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7: 0 []

--- dsh_fork_session (55 ms) ---
{
  "forked_from": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "session_id": "session-899f3937-1d7e-4586-8d26-6cb29d002085",
  "at_seq": null
}

--- dsh_session_overview (fork) (2007 ms) ---
{
  "session_id": "session-899f3937-1d7e-4586-8d26-6cb29d002085",
  "summary": {
    "sessionId": "session-899f3937-1d7e-4586-8d26-6cb29d002085",
    "updatedAt": 1790181184128,
    "running": false,
    "blank": false,
    "parentSessionId": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
    "cwd": "/root/Aub",
    "agentPreset": "standard",
    "projections": {
      "asOfSeq": 43,
      "values": {
        "sessionStats": {
          "turns": 1,
          "steps": 2,
          "llmMs": 7527,
          "toolMs": 45,
          "ttftMs": 6655,
          "ttftSteps": 2,
          "decodeMs": 872,
          "decodeTokens": 94
        },
        "title": "T2 e2e: MCP 操控真实 DSH",
        "goal": null,
        "tokenUsage": {
          "uncachedInputTokens": 16304,
          "outputTokens": 94,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0
        },
        "contextPressure": {
          "pressureTokens": 8205,
          "projectedTokens": 8215,
          "contextWindow": 1000000
        },
        "contextBreakdown": {
          "systemTokens": 1515,
          "toolsTokens": 6376,
          "messageTokens": 539
        },
        "subagentTiming": {
          "settledMs": 0
        },
        "subagent": null,
        "permissions": {
          "options": [
            {
              "value": "read-only",
              "name": "read-only"
            },
            {
              "value": "workspace-write",
              "name": "workspace-write"
            },
            {
              "value": "danger-full-access",
              "name": "danger-full-access"
            }
          ],
          "currentValue": "danger-full-access"
        },
        "sessionListMetadata": {
          "blank": false,
          "lastPromptAt": 1790181164439
        },
        "imageLimits": {
          "maxImageBytes": 5242880,
          "maxImagesPerMessage": 20,
          "maxMessageImageBytes": 104857600,
          "maxImagePixels": 40000000,
          "mediaTypes": [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif"
          ]
        },
        "todos": null,
        "plan": {
          "active": false,
          "pending": false
        }
      }
    }
  },
  "title": "T2 e2e: MCP 操控真实 DSH",
  "models": {
    "current": {
      "provider": "local-gateway",
      "model": "deepseek-ai/DeepSeek-V4.1-Flash"
    },
    "routable": true,
    "group_count": 2,
    "failures": []
  },
  "history": {
    "events_returned": 44,
    "has_more": false,
    "last
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_list_sessions (subagent scan) (2490 ms) ---
{
  "total_matching": 47,
  "returned": 40,
  "total_sessions_on_host": 671,
  "filter": {
    "cwd": "/root/Aub",
    "running_only": false
  },
  "sessions": [
    {
      "session_id": "session-899f3937-1d7e-4586-8d26-6cb29d002085",
      "updated_at": 1790181184128,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
      "updated_at": 1790181164439,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "d6e59e62-cd98-49c7-a619-7938d227a2ea",
      "updated_at": 1790181011282,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
      "origin": "subagent",
      "agent_preset": "standard"
    },
    {
      "session_id": "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
      "updated_at": 1790181006607,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-13e257c8-0d39-4aac-92ac-a27acc34aabd",
      "updated_at": 1790180986617,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-4a38a158-4713-4e32-8361-4dfcea5e5521",
      "updated_at": 1790180975436,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-8b7dfa09-0349-45ff-a97d-efe65e85f6f8",
      "updated_at": 1790180963659,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-4581816d-7686-4b06-91f1-f78b33b9b3b3",
      "updated_at": 1790180938626,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": "session-3c7f7b46-867f-423d-8a4b-8e1375ab627b",
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-3c7f7b46-867f-423d-
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_read_subagent_history (2776 ms) ---
{
  "session_id": "d6e59e62-cd98-49c7-a619-7938d227a2ea",
  "method": "session.history",
  "parent_session_id": "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
  "fallback": {
    "attempted": "subagent.history",
    "reason": "subagent-not-found",
    "message": "session \"d6e59e62-cd98-49c7-a619-7938d227a2ea\" is not a continuable direct child of \"session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9\""
  },
  "max_messages": 10,
  "before_seq": null,
  "events_returned": 45,
  "has_more": false,
  "first_seq": 0,
  "last_seq": 44,
  "next_before": null,
  "title": "Run this exact bash command",
  "as_of_seq": 44,
  "turns": 1,
  "tool_calls": 1,
  "event_kinds": {
    "sandbox/mode": 1,
    "approval/policy": 1,
    "permission/preset": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "subagent/descriptor": 1,
    "step/start": 2,
    "user/message": 3,
    "session/title": 1,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 23,
    "assistant/message": 2,
    "tool/call": 1,
    "tool/result": 1,
    "step/end": 2,
    "turn/end": 1
  },
  "last_assistant_text": "Raw stdout of `echo SUBAGENT-PROBE`:\n\n```\nSUBAGENT-PROBE\n```",
  "messages": [
    {
      "seq": 8,
      "role": "user",
      "text": "Run this exact bash command and report its stdout verbatim:\n\necho SUBAGENT-PROBE\n\nThen reply with the raw stdout of that command."
    },
    {
      "seq": 9,
      "role": "user",
      "text": "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.\n\nApproval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).\n\nYou are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it."
    },
    {
      "seq": 10,
      "role": "user",
      "text": "<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `cloud-subagent`: 把 ModelScope 上的 qwenpaw 云端实例当作远程 subagent 外包任务：判断哪些任务值得派、如何派、如何下载产物，并且每次都必须同时派一个本地监督 subagent 做定时巡检、成果验收与汇报。适用于需要真实浏览
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_dispatch_task (2039 ms) ---
{
  "dispatched": true,
  "session_id": "session-ad361774-092e-49a5-b3c1-20b7af2044ba",
  "workspace": {
    "workspaceId": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
    "path": "/root/Aub",
    "created": false,
    "matched": "path"
  },
  "grouped": true,
  "title": "T2 e2e: dispatch_task",
  "mode": "queue",
  "baseline_updated_at": 1790181197054,
  "next_call": {
    "tool": "dsh_wait_for_turn",
    "arguments": {
      "session_id": "session-ad361774-092e-49a5-b3c1-20b7af2044ba",
      "timeout_ms": 120000,
      "baseline_updated_at": 1790181197054
    }
  },
  "hint": "Non-blocking by design: nothing is held open on the MCP side. Call the tool in `next_call` (possibly several times) until settled=true."
}
dispatch_task returned in 2039 ms; next_call = {"tool":"dsh_wait_for_turn","arguments":{"session_id":"session-ad361774-092e-49a5-b3c1-20b7af2044ba","timeout_ms":120000,"baseline_updated_at":1790181197054}}

--- dsh_wait_for_turn (dispatched session) (7617 ms) ---
{
  "settled": true,
  "running": false,
  "timed_out": false,
  "session_id": "session-ad361774-092e-49a5-b3c1-20b7af2044ba",
  "polls": 2,
  "saw_running": true,
  "settle_detected_by": "running-flag",
  "title": "T2 e2e: dispatch_task",
  "turns": 1,
  "tool_calls": 0,
  "event_kinds": {
    "permission/preset": 1,
    "sandbox/mode": 1,
    "approval/policy": 1,
    "session/title": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "step/start": 1,
    "user/message": 3,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 5,
    "assistant/message": 1,
    "step/end": 1,
    "turn/end": 1
  },
  "last_assistant_text": "DISPATCH-OK",
  "last_seq": 20,
  "history_has_more": false,
  "summary": {
    "sessionId": "session-ad361774-092e-49a5-b3c1-20b7af2044ba",
    "updatedAt": 1790181199240,
    "running": false,
    "blank": false,
    "cwd": "/root/Aub",
    "agentPreset": "standard",
    "projections": {
      "asOfSeq": 20,
      "values": {
        "sessionStats": {
          "turns": 1,
          "steps": 1,
          "llmMs": 3075,
          "toolMs": 0,
          "ttftMs": 3034,
          "ttftSteps": 1,
          "decodeMs": 41,
          "decodeTokens": 6
        },
        "title": "T2 e2e: dispatch_task",
        "goal": null,
        "tokenUsage": {
          "uncachedInputTokens": 8071,
          "outputTokens": 6,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0
        },
        "contextPressure": {
          "pressureTokens": 8071,
          "projectedTokens": 8082,
          "contextWindow": 1000000
        },
        "contextBreakdown": {
          "systemTokens": 1515,
          "toolsTokens": 6376,
          "messageTokens": 476
        },
        "subagentTiming": {
          "settledMs": 0
        },
        "subagent": null,
        "permissions": {
          "options": [
            {
              "value": "read-only",
              "name": "read-only"
            },
            {
              "value": "workspace-write",
              "name": "workspace-write"
            },
            {
              "value": "danger-full-access",
              "name": "danger-full-access"
            }
          ],
          "currentValue": "danger-full-access"
        },
        "sessionListMetadata": {
          "blank": false,
          "lastPromptAt": 1790181199240
        },
        "imageLimits": {
          "maxImageBytes": 5242880,
          "maxImagesPerMessage": 20,
          "maxMessageImageBytes": 104857600,
          "maxImage
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_run_task (8832 ms) ---
{
  "settled": true,
  "timed_out": false,
  "dispatched": true,
  "session_id": "session-89feb4ba-88d8-43ae-9d55-8aaa0be40552",
  "workspace": {
    "workspaceId": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
    "path": "/root/Aub",
    "created": false,
    "matched": "path"
  },
  "grouped": true,
  "title": "T2 e2e: run_task",
  "polls": 2,
  "saw_running": true,
  "settle_detected_by": "running-flag",
  "turns": 1,
  "tool_calls": 0,
  "event_kinds": {
    "permission/preset": 1,
    "sandbox/mode": 1,
    "approval/policy": 1,
    "session/title": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "step/start": 1,
    "user/message": 3,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 5,
    "assistant/message": 1,
    "step/end": 1,
    "turn/end": 1
  },
  "last_assistant_text": "RUN-OK",
  "last_seq": 20
}
run_task settled after 2 polls; answer = "RUN-OK"

--- dsh_dispatch_task (long task) (2446 ms) ---
{
  "dispatched": true,
  "session_id": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
  "workspace": {
    "workspaceId": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
    "path": "/root/Aub",
    "created": false,
    "matched": "path"
  },
  "grouped": true,
  "title": "T2 e2e: cancel + timeout",
  "mode": "queue",
  "baseline_updated_at": 1790181215557,
  "next_call": {
    "tool": "dsh_wait_for_turn",
    "arguments": {
      "session_id": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
      "timeout_ms": 120000,
      "baseline_updated_at": 1790181215557
    }
  },
  "hint": "Non-blocking by design: nothing is held open on the MCP side. Call the tool in `next_call` (possibly several times) until settled=true."
}

--- dsh_wait_for_turn (4 s budget) (5737 ms) ---
{
  "settled": false,
  "timed_out": true,
  "still_running": true,
  "session_id": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
  "polls": 2,
  "running": true,
  "saw_running": true,
  "waited_ms": 4000,
  "hint": "not finished yet: the turn is still running (or has not started). Call dsh_wait_for_turn again with session_id=\"session-5f1942da-5eaa-408e-8506-d4f03f597373\" to keep waiting, or dsh_read_history to peek at progress.",
  "next_call": {
    "tool": "dsh_wait_for_turn",
    "arguments": {
      "session_id": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
      "timeout_ms": 4000,
      "require_start": false
    }
  }
}
pending envelope hint: not finished yet: the turn is still running (or has not started). Call dsh_wait_for_turn again with session_id="session-5f1942da-5eaa-408e-8506-d4f03f597373" to keep waiting, or dsh_read_history to peek at progress.
continuation: {"tool":"dsh_wait_for_turn","arguments":{"session_id":"session-5f1942da-5eaa-408e-8506-d4f03f597373","timeout_ms":4000,"require_start":false}}

--- dsh_cancel_turn (8 ms) ---
{
  "accepted": true,
  "session_id": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
  "hint": "Fire-and-return: accepted=true only means the request was received. Confirm idleness with dsh_wait_for_turn (require_start=false), or check dsh_list_sessions running."
}

--- dsh_wait_for_turn (require_start=false after cancel) (3215 ms) ---
{
  "settled": true,
  "running": false,
  "timed_out": false,
  "session_id": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
  "polls": 1,
  "saw_running": false,
  "settle_detected_by": "require_start=false",
  "title": "T2 e2e: cancel + timeout",
  "turns": 1,
  "tool_calls": 1,
  "event_kinds": {
    "permission/preset": 1,
    "sandbox/mode": 1,
    "approval/policy": 1,
    "session/title": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "step/start": 1,
    "user/message": 3,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 16,
    "assistant/message": 1,
    "tool/call": 1,
    "tool/result": 1,
    "step/end": 1,
    "turn/end": 1
  },
  "last_assistant_text": "I'll run the sleep command now.",
  "last_seq": 33,
  "history_has_more": false,
  "summary": {
    "sessionId": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
    "updatedAt": 1790181218162,
    "running": false,
    "blank": false,
    "cwd": "/root/Aub",
    "agentPreset": "standard",
    "projections": {
      "asOfSeq": 33,
      "values": {
        "sessionStats": {
          "turns": 1,
          "steps": 1,
          "llmMs": 3374,
          "toolMs": 2178,
          "ttftMs": 2918,
          "ttftSteps": 1,
          "decodeMs": 456,
          "decodeTokens": 85
        },
        "title": "T2 e2e: cancel + timeout",
        "goal": null,
        "tokenUsage": {
          "uncachedInputTokens": 8077,
          "outputTokens": 85,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0
        },
        "contextPressure": {
          "pressureTokens": 8077,
          "projectedTokens": 8136,
          "contextWindow": 1000000
        },
        "contextBreakdown": {
          "systemTokens": 1515,
          "toolsTokens": 6376,
          "messageTokens": 527
        },
        "subagentTiming": {
          "settledMs": 0
        },
        "subagent": null,
        "permissions": {
          "options": [
            {
              "value": "read-only",
              "name": "read-only"
            },
            {
              "value": "workspace-write",
              "name": "workspace-write"
            },
            {
              "value": "danger-full-access",
              "name": "danger-full-access"
            }
          ],
          "currentValue": "danger-full-access"
        },
        "sessionListMetadata": {
          "blank": false,
          "lastPromptAt": 1790181218162
        },
        "imageLimits": {
          "maxImageBytes": 5242880,
    
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_list_workspaces (before archive) (9 ms) ---
{
  "count": 7,
  "archived_session_count": 54,
  "workspaces": [
    {
      "workspace_id": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
      "title": "Aub",
      "path": "/root/Aub",
      "session_count": 33,
      "session_ids": [
        "session-5f1942da-5eaa-408e-8506-d4f03f597373",
        "session-89feb4ba-88d8-43ae-9d55-8aaa0be40552",
        "session-ad361774-092e-49a5-b3c1-20b7af2044ba",
        "session-899f3937-1d7e-4586-8d26-6cb29d002085",
        "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
        "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
        "session-13e257c8-0d39-4aac-92ac-a27acc34aabd",
        "session-4a38a158-4713-4e32-8361-4dfcea5e5521",
        "session-8b7dfa09-0349-45ff-a97d-efe65e85f6f8",
        "session-4581816d-7686-4b06-91f1-f78b33b9b3b3",
        "session-3c7f7b46-867f-423d-8a4b-8e1375ab627b",
        "session-36f1c4f3-0403-4d1d-b661-6110b25ff874",
        "session-6a07946a-3b1f-4058-8b10-aa67316e3caf",
        "session-ae1d84d8-a65f-4754-a3d9-a6da5680b48c",
        "session-9dee1c41-0505-472e-a9a6-93eb1a0d610b",
        "session-4d8f96ff-0090-4607-9b79-2d640e82bc87",
        "session-671dcb4a-2909-46a8-a1d3-ad9867d4b3c7",
        "session-4ebc764c-a8ad-48bf-8b21-dcc3ba366b7e",
        "session-01dc2df9-f66b-433a-b225-e16a09959325",
        "session-51efc307-4b7e-4e11-90ec-6c5a6b4674a0",
        "session-09f0dc13-7697-4f1e-84c4-428f640d8bc2",
        "session-1365a746-8939-40c1-9085-9a94aeb8abfe",
        "session-96b2cb2a-bb0d-4b67-a9cf-a7a14514a051",
        "session-58b8716f-1a11-40af-9540-204b39c2ced4",
        "session-6ecbcd4f-bc99-432b-8a40-15930d48d435",
        "session-2bc263c0-0cd7-43cf-ad51-dd08bbf48a65",
        "session-69dd0612-342d-48b9-8b7e-101530e96c93",
        "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
        "session-06e25024-01a5-49c6-9078-c4a8392e0c7d",
        "session-c76501ca-780c-4f42-9731-7e84d3d2e9b2",
        "session-1d91a912-32de-41bd-937f-95002ca37bf0",
        "session-66f97059-ff65-4df7-8585-64724acc2899",
        "session-2456fd15-3995-48ee-ab47-e646a275e685"
      ],
      "created_at": "2026-09-23T15:28:36.876Z",
      "updated_at": "2026-09-23T16:33:35.584Z"
    },
    {
      "workspace_id": "5f25cf7a-5950-4c28-9a25-3fad37dc35ca",
      "title": "EveryThing2API",
      "path": "/root/EveryThing2API",
      "session_count": 6,
      "session_ids": [
        "session-b21a9a99-88c1-4c75-9027-c3283a409e0f",
        "session-01368ab0-8124-4c51-9f6c-487eb339114f",
        "session-a5623935-de94-4246-936e-85580dcebc74",
 
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_archive_session (47 ms) ---
{
  "archived": true,
  "session_id": "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
  "archived_session_count": 55,
  "hint": "Archiving is registration-level only: logs, attachments and the workspace ledger entry are untouched, and this cannot be undone through the RPC surface."
}

--- dsh_list_workspaces (after archive) (9 ms) ---
{
  "count": 7,
  "archived_session_count": 55,
  "workspaces": [
    {
      "workspace_id": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
      "title": "Aub",
      "path": "/root/Aub",
      "session_count": 33,
      "session_ids": [
        "session-5f1942da-5eaa-408e-8506-d4f03f597373",
        "session-89feb4ba-88d8-43ae-9d55-8aaa0be40552",
        "session-ad361774-092e-49a5-b3c1-20b7af2044ba",
        "session-899f3937-1d7e-4586-8d26-6cb29d002085",
        "session-4657ba3b-bb26-4ad8-8f9d-643b4d9aebf7",
        "session-7b30886c-bf6b-4cf4-956a-bff3d8ec33a9",
        "session-13e257c8-0d39-4aac-92ac-a27acc34aabd",
        "session-4a38a158-4713-4e32-8361-4dfcea5e5521",
        "session-8b7dfa09-0349-45ff-a97d-efe65e85f6f8",
        "session-4581816d-7686-4b06-91f1-f78b33b9b3b3",
        "session-3c7f7b46-867f-423d-8a4b-8e1375ab627b",
        "session-36f1c4f3-0403-4d1d-b661-6110b25ff874",
        "session-6a07946a-3b1f-4058-8b10-aa67316e3caf",
        "session-ae1d84d8-a65f-4754-a3d9-a6da5680b48c",
        "session-9dee1c41-0505-472e-a9a6-93eb1a0d610b",
        "session-4d8f96ff-0090-4607-9b79-2d640e82bc87",
        "session-671dcb4a-2909-46a8-a1d3-ad9867d4b3c7",
        "session-4ebc764c-a8ad-48bf-8b21-dcc3ba366b7e",
        "session-01dc2df9-f66b-433a-b225-e16a09959325",
        "session-51efc307-4b7e-4e11-90ec-6c5a6b4674a0",
        "session-09f0dc13-7697-4f1e-84c4-428f640d8bc2",
        "session-1365a746-8939-40c1-9085-9a94aeb8abfe",
        "session-96b2cb2a-bb0d-4b67-a9cf-a7a14514a051",
        "session-58b8716f-1a11-40af-9540-204b39c2ced4",
        "session-6ecbcd4f-bc99-432b-8a40-15930d48d435",
        "session-2bc263c0-0cd7-43cf-ad51-dd08bbf48a65",
        "session-69dd0612-342d-48b9-8b7e-101530e96c93",
        "session-840eeaef-b779-4d4c-be5b-1e1c937b81a8",
        "session-06e25024-01a5-49c6-9078-c4a8392e0c7d",
        "session-c76501ca-780c-4f42-9731-7e84d3d2e9b2",
        "session-1d91a912-32de-41bd-937f-95002ca37bf0",
        "session-66f97059-ff65-4df7-8585-64724acc2899",
        "session-2456fd15-3995-48ee-ab47-e646a275e685"
      ],
      "created_at": "2026-09-23T15:28:36.876Z",
      "updated_at": "2026-09-23T16:33:35.584Z"
    },
    {
      "workspace_id": "5f25cf7a-5950-4c28-9a25-3fad37dc35ca",
      "title": "EveryThing2API",
      "path": "/root/EveryThing2API",
      "session_count": 6,
      "session_ids": [
        "session-b21a9a99-88c1-4c75-9027-c3283a409e0f",
        "session-01368ab0-8124-4c51-9f6c-487eb339114f",
        "session-a5623935-de94-4246-936e-85580dcebc74",
  
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_host_info via http://127.0.0.1:37459 (81 ms) ---
{
  "base_url": "http://127.0.0.1:37459",
  "base_url_source": "env:DSH_BASE",
  "version": "0.0.1",
  "cwd": "/root",
  "provider": "local-gateway",
  "model": "deepseek-ai/DeepSeek-V4.1-Flash",
  "attachedSessions": 52,
  "canOpenPath": false
}

--- dsh_host_info via http://127.0.0.1:3080 (8 ms) ---
{
  "base_url": "http://127.0.0.1:3080",
  "base_url_source": "env:DSH_BASE",
  "version": "0.0.1",
  "cwd": "/root",
  "provider": "local-gateway",
  "model": "deepseek-ai/DeepSeek-V4.1-Flash",
  "attachedSessions": 52,
  "canOpenPath": false
}
both bases answered from the same host: version=0.0.1 provider=local-gateway; base_url differs (http://127.0.0.1:37459 vs http://127.0.0.1:3080) ✔

--- dsh_host_info with --base http://127.0.0.1:37459 (env DSH_BASE poisoned) (76 ms) ---
{
  "base_url": "http://127.0.0.1:37459",
  "base_url_source": "cli:--base",
  "version": "0.0.1",
  "cwd": "/root",
  "provider": "local-gateway",
  "model": "deepseek-ai/DeepSeek-V4.1-Flash",
  "attachedSessions": 52,
  "canOpenPath": false
}
CLI flag precedence proven: env DSH_BASE=http://127.0.0.1:1 was ignored in favour of --base

--- dsh_ping (dead base, ok=false by design) (74 ms) ---
{
  "ok": false,
  "base": "http://127.0.0.1:38207",
  "elapsedMs": 44,
  "error": {
    "kind": "transport",
    "method": "host.describe",
    "code": "ECONNREFUSED",
    "message": "cannot reach DSH at http://127.0.0.1:38207 (ECONNREFUSED): is the host running and is --base correct?",
    "base": "http://127.0.0.1:38207"
  },
  "timeout_ms": 30000,
  "retries": 0,
  "hint": "DSH did not answer: check --base / DSH_BASE, that the host is running, and that any reverse proxy is reachable."
}

--- dsh_host_info (dead base, expect isError) (8 ms) ---
{
  "base_url": "http://127.0.0.1:38207",
  "tool": "dsh_host_info",
  "ok": false,
  "error": {
    "kind": "transport",
    "method": "host.describe",
    "code": "ECONNREFUSED",
    "message": "cannot reach DSH at http://127.0.0.1:38207 (ECONNREFUSED): is the host running and is --base correct?",
    "base": "http://127.0.0.1:38207"
  },
  "hint": "Carrier-level failure: the DSH host was not reached. Check --base / DSH_BASE and that the host is running."
}

--- dsh_host_info over streamable HTTP :33273 (73 ms) ---
{
  "base_url": "http://127.0.0.1:3080",
  "base_url_source": "cli:--base",
  "version": "0.0.1",
  "cwd": "/root",
  "provider": "local-gateway",
  "model": "deepseek-ai/DeepSeek-V4.1-Flash",
  "attachedSessions": 52,
  "canOpenPath": false
}

--- dsh_list_sessions over HTTP (2653 ms) ---
{
  "total_matching": 50,
  "returned": 3,
  "total_sessions_on_host": 674,
  "filter": {
    "cwd": "/root/Aub",
    "running_only": false
  },
  "sessions": [
    {
      "session_id": "session-5f1942da-5eaa-408e-8506-d4f03f597373",
      "updated_at": 1790181218162,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-89feb4ba-88d8-43ae-9d55-8aaa0be40552",
      "updated_at": 1790181209503,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    },
    {
      "session_id": "session-ad361774-092e-49a5-b3c1-20b7af2044ba",
      "updated_at": 1790181199240,
      "running": false,
      "blank": false,
      "cwd": "/root/Aub",
      "parent_session_id": null,
      "origin": null,
      "agent_preset": "standard"
    }
  ]
}
HTTP transport drove the real DSH: 3 sessions in /root/Aub

--- dsh_dispatch_task (spawn a subagent) (2533 ms) ---
{
  "dispatched": true,
  "session_id": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
  "workspace": {
    "workspaceId": "afa50b75-d7c4-4282-94ee-d07e7ece7eec",
    "path": "/root/Aub",
    "created": false,
    "matched": "path"
  },
  "grouped": true,
  "title": "T2 e2e: subagent tools",
  "mode": "queue",
  "baseline_updated_at": 1790181233612,
  "next_call": {
    "tool": "dsh_wait_for_turn",
    "arguments": {
      "session_id": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
      "timeout_ms": 120000,
      "baseline_updated_at": 1790181233612
    }
  },
  "hint": "Non-blocking by design: nothing is held open on the MCP side. Call the tool in `next_call` (possibly several times) until settled=true."
}

--- dsh_wait_for_turn (subagent parent) (19066 ms) ---
{
  "settled": true,
  "running": false,
  "timed_out": false,
  "session_id": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
  "polls": 4,
  "saw_running": true,
  "settle_detected_by": "running-flag",
  "title": "T2 e2e: subagent tools",
  "turns": 1,
  "tool_calls": 1,
  "event_kinds": {
    "permission/preset": 1,
    "sandbox/mode": 1,
    "approval/policy": 1,
    "session/title": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "step/start": 2,
    "user/message": 3,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 31,
    "assistant/message": 2,
    "tool/call": 1,
    "tool/result": 1,
    "step/end": 2,
    "turn/end": 1
  },
  "last_assistant_text": "PARENT-DONE",
  "last_seq": 51,
  "history_has_more": false,
  "summary": {
    "sessionId": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
    "updatedAt": 1790181236843,
    "running": false,
    "blank": false,
    "cwd": "/root/Aub",
    "agentPreset": "standard",
    "projections": {
      "asOfSeq": 51,
      "values": {
        "sessionStats": {
          "turns": 1,
          "steps": 2,
          "llmMs": 7901,
          "toolMs": 6924,
          "ttftMs": 7267,
          "ttftSteps": 2,
          "decodeMs": 634,
          "decodeTokens": 125
        },
        "title": "T2 e2e: subagent tools",
        "goal": null,
        "tokenUsage": {
          "uncachedInputTokens": 16330,
          "outputTokens": 125,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0
        },
        "contextPressure": {
          "pressureTokens": 8234,
          "projectedTokens": 8245,
          "contextWindow": 1000000
        },
        "contextBreakdown": {
          "systemTokens": 1515,
          "toolsTokens": 6376,
          "messageTokens": 591
        },
        "subagentTiming": {
          "settledMs": 0
        },
        "subagent": null,
        "permissions": {
          "options": [
            {
              "value": "read-only",
              "name": "read-only"
            },
            {
              "value": "workspace-write",
              "name": "workspace-write"
            },
            {
              "value": "danger-full-access",
              "name": "danger-full-access"
            }
          ],
          "currentValue": "danger-full-access"
        },
        "sessionListMetadata": {
          "blank": false,
          "lastPromptAt": 1790181236843
        },
        "imageLimits": {
          "maxImageBytes": 5242880,
          "maxImagesPerMessage": 20,
          "m
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_list_subagents (own parent) (1825 ms) ---
{
  "parent_session_id": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
  "parent_available": true,
  "count": 1,
  "entries": [
    {
      "kind": "child",
      "session_id": "5075b36f-5a09-4a07-9145-04f1ac21c93c",
      "activity": "inactive",
      "has_children": false,
      "mode": "one-shot",
      "label": "Run echo probe command",
      "readable_via": "dsh_read_subagent_history (one-shot children fall back to session.history)",
      "promptable": false,
      "interruptible": true
    }
  ],
  "hint": "Child ids from subagent.list are bare uuids (no \"session-\" prefix) — pass them verbatim. Only continuable children accept subagent.prompt; subagent.interrupt is accepted for one-shot children too, and every child transcript is readable (one-shot children via the session.history fallback)."
}
child discovered: 5075b36f-5a09-4a07-9145-04f1ac21c93c mode=one-shot activity=inactive label="Run echo probe command" readable_via=dsh_read_subagent_history (one-shot children fall back to session.history)

--- dsh_read_subagent_history (own child) (2031 ms) ---
{
  "session_id": "5075b36f-5a09-4a07-9145-04f1ac21c93c",
  "method": "session.history",
  "parent_session_id": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
  "fallback": {
    "attempted": "subagent.history",
    "reason": "subagent-not-found",
    "message": "session \"5075b36f-5a09-4a07-9145-04f1ac21c93c\" is not a continuable direct child of \"session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f\""
  },
  "max_messages": 10,
  "before_seq": null,
  "events_returned": 39,
  "has_more": false,
  "first_seq": 0,
  "last_seq": 38,
  "next_before": null,
  "title": "Run this exact bash command",
  "as_of_seq": 38,
  "turns": 1,
  "tool_calls": 1,
  "event_kinds": {
    "sandbox/mode": 1,
    "approval/policy": 1,
    "permission/preset": 1,
    "agent/inbox/spliced": 2,
    "turn/start": 1,
    "subagent/descriptor": 1,
    "step/start": 2,
    "user/message": 3,
    "session/title": 1,
    "request/header": 1,
    "request/context": 1,
    "assistant/chunk": 17,
    "assistant/message": 2,
    "tool/call": 1,
    "tool/result": 1,
    "step/end": 2,
    "turn/end": 1
  },
  "last_assistant_text": "SUBAGENT-PROBE",
  "messages": [
    {
      "seq": 8,
      "role": "user",
      "text": "Run this exact bash command and report its raw stdout verbatim:\n\necho SUBAGENT-PROBE\n\nThen reply with only the command's output."
    },
    {
      "seq": 9,
      "role": "user",
      "text": "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.\n\nApproval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).\n\nYou are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it."
    },
    {
      "seq": 10,
      "role": "user",
      "text": "<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `cloud-subagent`: 把 ModelScope 上的 qwenpaw 云端实例当作远程 subagent 外包任务：判断哪些任务值得派、如何派、如何下载产物，并且每次都必须同时派一个本地监督 subagent 做定时巡检、成果验收与汇报。适用于需要真实浏览器/桌面 GUI 自动化、大容量磁盘中间产物、干净 Linux 环境装依赖跑长
  … (payload truncated here; full JSON in test/output/e2e.txt)

--- dsh_message_subagent (one-shot child, expect isError) (1700 ms) ---
{
  "base_url": "http://127.0.0.1:3080",
  "tool": "dsh_message_subagent",
  "ok": false,
  "error": {
    "kind": "rpc",
    "method": "subagent.prompt",
    "code": "subagent-not-found",
    "message": "session \"5075b36f-5a09-4a07-9145-04f1ac21c93c\" is not a continuable direct child of \"session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f\"",
    "details": {
      "parentSessionId": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
      "childSessionId": "5075b36f-5a09-4a07-9145-04f1ac21c93c"
    },
    "base": "http://127.0.0.1:3080"
  },
  "hint": "The child is not a *continuable* direct child: subagent.prompt rejects one-shot children (subagent.interrupt is still accepted). Reading is no problem — dsh_read_subagent_history automatically falls back to session.history."
}

--- dsh_interrupt_subagent (one-shot child) (1445 ms) ---
{
  "accepted": true,
  "parent_session_id": "session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f",
  "child_session_id": "5075b36f-5a09-4a07-9145-04f1ac21c93c",
  "observed_activity": "inactive",
  "observed_entry": {
    "kind": "child",
    "id": "5075b36f-5a09-4a07-9145-04f1ac21c93c",
    "mode": "one-shot",
    "label": "Run echo probe command",
    "activity": "inactive",
    "hasChildren": false
  },
  "hint": "Fire-and-return. Pass wait_ms to also watch activity flip running -> inactive; otherwise re-check with dsh_list_subagents."
}
SKIP-EVIDENCE: this run produced a "one-shot" child, so the successful subagent.prompt path was not reachable; prompt returned the structured subagent-not-found error, interrupt was accepted (observed activity: inactive), and the transcript was read through the session.history fallback.

=== cleanup: archiving 6 test sessions: session-9745a419-990d-4351-aa59-01406ef1b993, session-899f3937-1d7e-4586-8d26-6cb29d002085, session-ad361774-092e-49a5-b3c1-20b7af2044ba, session-89feb4ba-88d8-43ae-9d55-8aaa0be40552, session-5f1942da-5eaa-408e-8506-d4f03f597373, session-cd410fd6-ed36-49f3-9f7d-bfb6b8ca7c0f

完整日志（含每个工具的完整 JSON 返回）见 `test/output/e2e.txt`。

## 7. 本轮在真实 DSH 上实测到的行为（值得回灌给 skill/文档）

1. **一句话证明端到端**：MCP 建会话 → 发"写 `/tmp/mcp-e2e.txt` 并回复 E2E-OK" → 等回合 →
   宿主里那个会话真的写出了 `content = "E2E-OK\n"`，且 `last_assistant_text = "E2E-OK"`。
   > 注：`/tmp/mcp-e2e.txt` 在测试收尾时被 `after()` 删掉了（避免留垃圾），但 S8 断言期间的
   > 原始输出 `exists(/tmp/mcp-e2e.txt) = true` / `content = "E2E-OK\n"` 已如实记录在 `test/output/e2e.txt`。
2. **`subagent.list` 的子会话 id 是裸 uuid**（`d6e59e62-…`，**没有** `session-` 前缀）；
   但它在 `session.list` 里就是以这个裸 id 出现的，所以照样能读。
3. **one-shot vs continuable 的不对称**（实测）：
   * `subagent.prompt` 对 one-shot 子会话 → `subagent-not-found: … is not a continuable direct child of …`；
   * `subagent.history` 同样拒绝 one-shot 子会话；
   * **`subagent.interrupt` 对 one-shot 子会话照收**（`{accepted:true}`）；
   * 但 one-shot 子会话的转录**能读**——`session.history` 与 `subagent.history` 共用 `readSessionState()`。
     于是 `dsh_read_subagent_history` 捕获 `subagent-not-found` 后自动回落到 `session.history`，
     结果里带 `method` + `fallback` 说明。实测读到了 45 个事件，含子 agent 的真实回答
     `SUBAGENT-PROBE` 的 stdout。
4. **`running` 翻转会漏拍**：快回合可能在两次轮询之间开始并结束。这是 `wait_for_turn` 加
   `baseline_updated_at` + 转录兜底的原因（§3.6）。
5. **`session.selectModel` 伪造 provider → `model-unavailable`**，且 HTTP 200；被我们转成
   `isError:true`（S12 实测），原 code/details 保留。
6. **`workspace.create` 幂等**：已注册目录返回 `created:false`（S4b）；目录不存在在本地 base 下会被
   预检拦成结构化 `bad-directory`（远端 base 不做本地文件系统检查，交给宿主判）。
7. **archive 语义**：`workspace.archiveSession` 让 `archivedSessionIds` 计数 +1，且**只隐藏分组面**，
   会话仍在 `session.list` 里（所以 e2e 里我用"计数 +1"来断言，而不是用"列表里消失"）。
8. **unreachable 端口用 `fetch` 报错时要挖两层**：Node 的 Happy Eyeballs 会把 `ECONNREFUSED` 埋成
   `AggregateError.errors[]`，只读 `cause.code` 会拿到 `undefined`（这是 protocol 测试第一次跑红的原因）。

## 8. 文件清单与行数

```text
README.md
REPORT.md
node_modules
package-lock.json
package.json
src
test
--- 行数/字节 ---
    24    759 package.json
   293  16105 README.md
  2192  84412 REPORT.md
   321  11037 src/client.js
   300  10924 src/config.js
   165   7157 src/index.js
   539  22003 src/schema.js
    20    634 src/tools/host.js
   132   5202 src/tools/index.js
    36   1580 src/tools/raw.js
   316  11558 src/tools/session.js
    72   3050 src/tools/subagent.js
   292  12130 src/tools/support.js
    51   1857 src/tools/workspace.js
   574  30997 test/e2e.test.mjs
   291  13434 test/protocol.test.mjs
  5618 232839 total
```

## 9. 未完成项 / 已知限制（如实列出）

1. **`events.mux` 实时下行流没做成 tool**。任务的 tool 清单没要求，但 `dsh-api.mjs stream` 有这个能力。
   影响：无法"订阅"会话事件，只能轮询。下一轮计划：`dsh_tail_events(session_id, seconds)`（WS 只读、有界时长）。
2. **没有 subagent 的"派发"tool**。`dsh-mcp` 只能操作**已存在**的子 agent（list/read/message/interrupt）；
   "让某会话派一个新子 agent"必须通过 `dsh_send_message` 请求那个会话自己去做（本轮 S22 就是这么造出
   one-shot 子 agent 的）。DSH 的 `/api` 面确实没有"创建子 agent"的 method，所以这是接口边界，不是偷懒。
3. **continuable 子会话的完整写路径本轮没跑到**。S22 造出来的是 one-shot 子会话，因此
   `dsh_message_subagent` 成功路径未被真实覆盖（工具被调用并断言了它返回结构化 `subagent-not-found`；
   `dsh_interrupt_subagent` 被真实调用并断言 `accepted:true`）。测试里已写明 `SKIP-EVIDENCE`，
   并在能拿到 continuable 子会话时自动跑完整路径。
4. **`https` + 自签证书**只做到"支持"，没有真实 https 目标可打（本机 DSH 是 http）。
   文档给了 `NODE_EXTRA_CA_CERTS` 路径；`--insecure` 开关故意没做。
5. **`session.search` 在本部署被禁用**（`internal: session search is disabled: … openAt "never"`），
   所以没有暴露搜索 tool —— 不是漏做，是接口不可用。
6. **测试会话清理靠 `archive`**（DSH 没有 `session.delete`）。e2e 的 `after()` 会把本轮新建的 6 个会话
   全部 archive（原始输出里有逐条 archive 回执）；archive 无法通过 RPC 撤销，这是接口限制。

## 10. 复现步骤

```bash
source /root/Aub/creds.env                 # DSH_BASE=http://127.0.0.1:3080
cd /root/Aub/t2-dsh-mcp && npm install
node src/index.js --print-config           # 看解析结果与来源
node --test --test-reporter=spec test/protocol.test.mjs
node --test --test-reporter=spec test/e2e.test.mjs
```

> e2e 会真建 6 个会话（S5/S5b/S13b/S14/S16/S17/S22），跑完自动 archive；
> 若中途 Ctrl-C，请手动 `node /root/.dsh/skills/dsh-agent-console/scripts/dsh-api.mjs sessions --cwd /root/Aub | grep "T2 e2e"` 后逐个 `archive --session <id>`。