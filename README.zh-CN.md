# dsh-mcp — 从任意 MCP 客户端远程驱动一个已在运行的 DSH 实例

`dsh-mcp` 是一个 **MCP（Model Context Protocol）服务器**，它本身**不属于** DSH，而是 DSH 宿主的**远程控制客户端**。
把它挂载到任意支持 MCP 的 AI 客户端（Claude Desktop、Cursor、另一个 DSH 会话、自研 MCP 宿主）上，这个 AI 就能：
列出会话、读取事件级历史、**创建会话、把任务派发过去、等待该轮次结束、把答案取回来**，以及取消、重命名、
切换模型、管理工作区、驱动子代理——全部通过 HTTP(S) 访问一个 DSH 实例完成。

```
MCP 宿主  ──stdio/HTTP(MCP)──▶  dsh-mcp  ──POST /api/<method>（JSON-RPC 信封）──▶  DSH 宿主（URL 可配置）
```

* **23 个工具**，全部由单一 schema 数组（`src/schema.js`）生成。
* **stdio + streamable HTTP** 两种传输，共用一套实现——工具逻辑没有第二份拷贝。
* **Base URL 完全可配置**：`--base` > `$DSH_BASE` > `$DSH_WEB_URL` > `http://127.0.0.1:3080`；
  `http://` 与 `https://` 均支持，另可选 bearer token / 自定义请求头以适配反向代理。
* DSH 把业务错误**放在 HTTP 200 的响应体里**返回，本服务会将其转换为 MCP 的 `isError: true`，
  并原样保留 `code` / `message` / `details`。
* 长任务不会永久阻塞一次请求：`dsh_dispatch_task`（非阻塞）+ `dsh_wait_for_turn`
  （轮询；超时返回**续查提示**而不是错误）。

---

## 1. 安装

已发布到 npm，包名为 **`dsh-remote-mcp`**（裸名 `dsh-mcp` 已被他人的无关包占用）：

```bash
npx -y dsh-remote-mcp --base http://127.0.0.1:3080        # 免安装直接运行
npm install -g dsh-remote-mcp                              # 或全局安装
```

从源码运行：

```bash
cd dsh-mcp
npm install                       # 仅一个依赖：@modelcontextprotocol/sdk@1.30.0（已锁定版本）
node --version                    # 需 v20+（开发与测试环境为 v24.19.0）
```

无构建步骤、无原生模块、无需编译器。`node_modules` 约 29 MB。

## 2. 运行

```bash
# stdio（MCP 宿主的标准挂载方式）—— stdout 只承载协议，日志走 stderr
node src/index.js --base http://127.0.0.1:3080

# streamable HTTP（供远程挂载）；启动时会在 stderr 打印确切端点
node src/index.js --http --port 8765 --base http://127.0.0.1:3080
#   → [dsh-mcp] info: streamable HTTP transport ready — http://127.0.0.1:8765/mcp (23 tools, …)
#   → GET http://127.0.0.1:8765/healthz  可做存活与目标探活

node src/index.js --print-config   # 打印生效配置及每个值的来源（token 已脱敏）
node src/index.js --help
```

### Claude Desktop / 通用 MCP 宿主配置（stdio）

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["/path/to/dsh-mcp/src/index.js", "--base", "http://127.0.0.1:3080"],
      "env": { "DSH_TIMEOUT_MS": "60000" }
    }
  }
}
```

### 反向代理后面的远程 DSH

```bash
node src/index.js --base https://dsh.example.com --token "$DSH_TOKEN" --header "X-Org: acme"
# 等价写法：DSH_BASE=https://dsh.example.com DSH_TOKEN=… DSH_HEADERS='{"X-Org":"acme"}'
```

`--token` 会加上 `Authorization: Bearer …`；`--header`（可重复）用于追加任意请求头。
若使用自签名证书，优先用 `NODE_EXTRA_CA_CERTS=/path/ca.pem`，或用
`NODE_TLS_REJECT_UNAUTHORIZED=0`（粗放做法，切勿用于共享环境）。

## 3. 配置项参考

优先级严格为：**命令行参数 > 环境变量 > 内置默认值**。`--print-config` 会显示每个键的最终取值来源。

| 命令行 | 环境变量 | 默认值 | 含义 |
|---|---|---|---|
| `--base <url>` | `DSH_BASE`，其次 `DSH_WEB_URL` | `http://127.0.0.1:3080` | DSH base URL（支持 `http`/`https`，允许路径前缀） |
| `--token <t>` | `DSH_TOKEN` | – | `Authorization: Bearer <t>` |
| `--header "N: v"` | `DSH_HEADERS` | – | 追加请求头（可重复 / JSON / `A: 1, B: 2`） |
| `--timeout-ms <n>` | `DSH_TIMEOUT_MS` | `30000` | 单次 RPC 超时 |
| `--retries <n>` | `DSH_RETRIES` | `2` | 可重试失败的重试次数（见 §6） |
| `--wait-timeout-ms <n>` | `DSH_WAIT_TIMEOUT_MS` | `120000` | `dsh_wait_for_turn` / `dsh_run_task` 的默认预算 |
| `--poll-interval-ms <n>` | `DSH_POLL_INTERVAL_MS` | `3000` | running 标志的轮询间隔 |
| `--http` / `--stdio` | `DSH_MCP_HTTP=1` | `stdio` | MCP 传输方式 |
| `--host`, `--port`, `--path` | `DSH_HTTP_HOST`, `DSH_HTTP_PORT`, `DSH_HTTP_PATH` | `127.0.0.1`, `8765`, `/mcp` | HTTP 传输绑定参数 |
| `--http-token <t>` | `DSH_HTTP_TOKEN` | – | 要求 MCP 端点本身校验 bearer token |
| `--allow-raw-call` | `DSH_ALLOW_RAW_CALL` | 关闭 | 暴露 `dsh_call`（原始 `/api` 透传） |

## 4. 工具（23 个）

只读工具标记 `readOnlyHint`；任何会改动会话/工作区的工具标记 `destructiveHint`。
`dsh_run_task` 与 `dsh_wait_for_turn` 是仅有的长耗时调用，二者都必须显式给出预算。

### 宿主
| 工具 | DSH 方法 | 说明 |
|---|---|---|
| `dsh_host_info` | `host.describe` | 版本 / cwd / provider / model / 已挂载会话数 **+ 实际使用的 base URL** |
| `dsh_ping` | `host.describe` | 永不抛错；返回 `ok`、延迟，或确切错误 |

### 会话
| 工具 | DSH 方法 | 说明 |
|---|---|---|
| `dsh_list_sessions` | `session.list` | 按 `cwd`、`running_only` 过滤，可选解析标题 |
| `dsh_read_history` | `session.history` / `subagent.history` | 事件级读取，`max`/`before` 分页，`text_only` 扁平化 |
| `dsh_session_overview` | `session.list` + `history` + `models` | 一站式摘要：标题、运行状态、模型、事件直方图 |
| `dsh_create_session` | `session.create` | 传 `workspace`（路径或 id）*或* `cwd`（注意 §7 的坑） |
| `dsh_send_message` | `session.prompt` | `queue` / `steer`；这是"让另一个 AI 干活"的核心原语 |
| `dsh_wait_for_turn` | 轮询 `session.list` | 返回 `settled` **或** `timed_out` + `next_call`（永不报错） |
| `dsh_dispatch_task` | `session.create` + `prompt` | 非阻塞；返回 `session_id` + `baseline_updated_at` |
| `dsh_run_task` | dispatch + wait | 一次调用、硬预算，遵循同样的"超时不报错"约定 |
| `dsh_cancel_turn` | `session.cancel` | 发出即返回（`accepted` ≠ 已经空闲） |
| `dsh_rename_session` | `session.rename` | 固定一个标题 |
| `dsh_fork_session` | `session.fork` | 在已完成的一轮之后分叉 |
| `dsh_archive_session` | `workspace.archiveSession` | DSH 唯一的清理原语 |

### 模型
| 工具 | DSH 方法 | 说明 |
|---|---|---|
| `dsh_list_models` | `session.models` | 当前模型 + 可路由模型 + provider 分组 + 失败项 |
| `dsh_select_model` | `session.selectModel` | ⚠️ **同时会写入部署级默认模型**（见 §7） |

### 工作区
| 工具 | DSH 方法 | 说明 |
|---|---|---|
| `dsh_list_workspaces` | `workspace.list` | 账本 + 已归档会话数 |
| `dsh_create_workspace` | `workspace.create` | 幂等；**不会创建目录** |

### 子代理
| 工具 | DSH 方法 | 说明 |
|---|---|---|
| `dsh_list_subagents` | `subagent.list` | 子会话 + 诊断信息、`parentAvailable`、每个子会话的 `readable_via` / `messageable` |
| `dsh_read_subagent_history` | `subagent.history`，失败时自动回退到 `session.history` | 与会话历史相同的分页/扁平化；一次性子代理同样可读 |
| `dsh_message_subagent` | `subagent.prompt` | 与**可续接**子代理对话的唯一途径（`session.prompt` 会返回 `agent-busy`） |
| `dsh_interrupt_subagent` | `subagent.interrupt` | 可选 `wait_ms`，用于观察 `running → inactive` |

### 原始调用（需显式开启）
| 工具 | 说明 |
|---|---|
| `dsh_call` | ⚠️ **除非加 `--allow-raw-call`，否则禁用**。可用任意 payload 调用任意 `/api` 方法。 |

## 5. 用法示例

**A. 让另一个 DSH 会话干活并取回答案**

```
dsh_host_info                                                          # 确认目标
dsh_dispatch_task  { task: "在 /tmp 写 hello.txt 并回复 DONE", workspace: "/path/to/project" }
  → { session_id: "session-…", baseline_updated_at: 179…, next_call: { tool: "dsh_wait_for_turn", … } }
dsh_wait_for_turn  { session_id: "session-…", timeout_ms: 300000, baseline_updated_at: 179… }
  → { settled: true, last_assistant_text: "DONE", turns: 1, tool_calls: 1 }
dsh_archive_session { session_id: "session-…" }                        # 清理
```

**B. 长时间任务，但不占住 MCP 请求**

```
dsh_dispatch_task    → session_id …            （1 秒内返回）
… 之后，随时按需 ……
dsh_wait_for_turn { session_id, timeout_ms: 60000 }
  → settled=false, timed_out=true, "尚未结束 …… 请再次调用 dsh_wait_for_turn"
  → next_call: { tool: "dsh_wait_for_turn", arguments: { session_id, require_start: false } }
dsh_read_history  { session_id, max: 20 }      # 不等也能瞄一眼进展
```

**C. 查看某个会话究竟做了什么**

```
dsh_read_history { session_id, max: 10, text_only: true }        # 只看消息
dsh_read_history { session_id, max: 20, before: 1234 }           # 向前翻页
dsh_read_history { session_id, text_only: false }                # 原始事件对象（kind、seq、工具调用）
```

**D. 检查子代理**

```
dsh_list_subagents     { parent_session_id }
dsh_read_subagent_history { parent_session_id, session_id: child }
dsh_message_subagent   { parent_session_id, child_session_id: child, text: "继续，但跳过第 3 步" }
dsh_interrupt_subagent { parent_session_id, child_session_id: child, wait_ms: 20000 }
```

**E. 切换模型（请谨慎）**

```
dsh_list_models   { session_id }                       # provider/model id + 是否可路由
dsh_select_model  { session_id, provider: "local-gateway", model: "provider/model-name" }
```

## 6. 错误模型

DSH **即使业务失败也返回 HTTP 200**，真相在 `result.error` 里。`dsh-mcp` 从不隐藏它：

| 失败情形 | MCP 结果 | 载荷 |
|---|---|---|
| DSH 业务错误（`result.error`） | `isError: true` | `error.kind="rpc"`，`code`（`session-not-found`、`agent-busy`、`model-unavailable` 等）、`message`、`details` 原样透传 |
| 未知工具 | `isError: true` | `error.kind="unknown-tool"` + 真实工具列表 |
| 参数不合法 | `isError: true` | `error.kind="invalid-arguments"`，每个非法字段一条 issue |
| 功能未开启 | `isError: true` | `error.kind="raw-call-disabled"` + 开启方法 |
| 超时 | `isError: true` | `error.kind="timeout"`，指明 base URL 与 `--timeout-ms` |
| base 写错/不可达 | `isError: true` | `error.kind="transport"`，`code="ECONNREFUSED"`，以及出错的 `base` |
| 反向代理 5xx | `isError: true` | `error.kind="carrier"`，`http_status` |

每个载荷还会回显 `base_url` 与工具名，MCP 结果里带有
`_meta["dsh/baseUrl"]` + `_meta["dsh/elapsedMs"]`——因此多 DSH 客户端总能分辨是哪个实例应答的。

**重试**被刻意压得很窄，因为 `session.prompt` 并非幂等：

* 只读方法（`session.list`、`session.history`、`host.describe` 等）在传输失败及 `502/503/504/429` 时重试；
* 变更类方法**仅**在能证明失败发生在请求抵达 DSH 之前时才重试（`ECONNREFUSED`、`ENOTFOUND`、
  `EAI_AGAIN`、端口错误），**绝不在超时或发出后连接重置时重试**——那可能把任务重复投递。

**超时预算 vs. 长任务**：`--timeout-ms` 限制单次 RPC；wait/run 类工具上的 `timeout_ms` 是*预算*，
用尽时给出 `timed_out: true` + `next_call`，而不是错误。

## 7. 已知限制与坑

1. **用 `cwd` 调 `session.create` 会创建未分组会话。** DSH 没有能把既有会话挂到工作区的 RPC
   （`workspace.insertSessionBefore` 会拒绝未被记账的会话），所以想让会话出现在侧边栏就传 `workspace`。
   回退到 `cwd` 时，工具结果里会带 `warning`。
2. **没有 `session.delete`。** 清理手段是 `dsh_archive_session`（注册表级归档；日志与附件永久保留）。
   归档无法通过 RPC 面撤销。
3. **`dsh_select_model` 是全局副作用。** `session.selectModel` 同时会把所选模型持久化为
   *部署默认模型*（`agent-default-model`），后续会话会继承它。工具结果里带有
   `global_side_effect: true` 与警告。
4. **该部署上 `session.search` 被禁用**（`internal: session search is disabled: … openAt "never"`），
   因此没有暴露搜索类工具。
5. **一次性 vs. 可续接子代理——实测差异。** 针对宿主 0.0.1：
   * `subagent.list` 里的子 id 是**裸 uuid**（如 `31bf59a5-…`，不带 `session-` 前缀）——请原样传递；
   * `subagent.prompt` 与 `subagent.history` 只服务**可续接**的直接子代理；一次性子代理
     （模型自身 `subagent` 工具的常见产物）会回答
     `subagent-not-found: … is not a continuable direct child of …`；
   * **`subagent.interrupt` 对一次性子代理同样接受**（`{accepted:true}`）；
   * 一次性子代理的转录**确实可读**，因为 `session.history` 与 `subagent.history` 共享
     `readSessionState()`。因此 `dsh_read_subagent_history` 会捕获 `subagent-not-found` 并改走
     `session.history` 重试，并在结果中报告 `method` + `fallback`——一条读取路径覆盖两种子代理；
   * 对子代理调用 `session.prompt` / `session.cancel`：存活时返回 `agent-busy`，冷掉之后返回
     `session-not-found`（`api-proxy.js` 中的实现顺序），这正是 `subagent.*` 系列工具存在的原因。
6. **`dsh_ping`/`dsh_host_info` 能证明 base URL**，但其余一切的可达性取决于 `/api` 的
   `Host` 头规则：DSH 自己的 RPC 网关只接受 loopback 或已声明的 `trustedHosts`。
   把 MCP 的 HTTP 传输绑定到公网是**你自己的责任**——请使用 `--http-token` 并置于代理之后。
7. **按设计不提供 shell 工具。** `dsh-mcp` 的影响面恰好等于 DSH 的 RPC 面；唯一执行命令的方式是
   *让某个 DSH 会话去执行*（受宿主机自身的沙箱/审批策略约束）。`dsh_call` 把影响面扩大到整个 `/api`，
   默认关闭。
8. 需要 Node ≥ 20（使用了全局 `fetch`）；开发环境为 Node v24.19.0 + `@modelcontextprotocol/sdk@1.30.0`。

## 8. 测试

```bash
npm test                       # 两个套件共 39 个测试，全部通过（上次耗时 135 秒）
node --test --test-reporter=spec test/protocol.test.mjs   # 13 个测试；其中仅 2 个需要活的 DSH
node --test --test-reporter=spec test/e2e.test.mjs        # 26 个测试，打真实 DSH（$DSH_BASE）
```

上次运行的原始输出记录在 `test/output/protocol.txt`、`test/output/e2e.txt`、`test/output/npm-test.txt`；
`REPORT.md` §6 引用了这些内容。

* `test/protocol.test.mjs` — 对真实子进程服务器跑**两种**传输：`initialize` 握手、
  `tools/list` 与 `src/schema.js` 深度相等（字节级）、handler/schema 一一对应、
  参数错误 / 枚举错误 / 未知工具 / `dsh_call` 被禁用 / DSH 不可达 → `isError`、
  HTTP 传输等价性、`--http-token` 401、`--allow-raw-call` 显式开启。
* `test/e2e.test.mjs` — 对活宿主驱动每一个工具，含标志性验证：创建会话 →
  `dsh_send_message`（"写 /tmp/mcp-e2e.txt 并回复 E2E-OK"）→ `dsh_wait_for_turn` →
  **文件确实存在且回答为 `E2E-OK`** → `dsh_archive_session`。它还用一个随机端口上的 TCP 转发器
  （等价于 `socat`/`ssh -L`）证明 base URL 真的可配置，并证明 `--base` 能压过被污染的环境变量。
  测试创建的会话会在 `after()` 中归档。

原始运行输出保存在 `test/output/`，并在 `REPORT.md` 中被引用。

> 注意：`test/e2e.test.mjs` 默认使用 `E2E_WORKSPACE`（缺省为一个示例工作区路径）来创建会话。
> 指向你自己的部署时，请通过环境变量覆盖它。

## 9. 目录结构

```
src/
  index.js     MCP 入口：一套服务器，stdio 或 streamable HTTP
  client.js    唯一与 DSH 做 HTTP 通信的地方（信封、超时、重试、错误模型）
  config.js    命令行/环境变量/默认值解析，--print-config，--help
  schema.js    唯一真相来源：名称、描述、JSON Schema、默认值、参数校验
  tools/
    index.js   分发表：合并 schema.js 与 handlers，驱动 tools/list 与 tools/call
    host.js sessions.js workspace.js subagent.js raw.js   各薄层 handler（无重复逻辑）
    support.js 共用辅助（历史摘要、等待循环、工作区解析）
test/
  protocol.test.mjs  e2e.test.mjs  output/*.txt
```

本项目的设计目的是只作为 DSH 的**外部客户端**运行，不修改 DSH 自身的安装目录或技能文件。