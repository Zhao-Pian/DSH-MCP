# 适配 DSH 0.2.x（Typert Remote）迁移说明

## 来源

* 仓库：`https://github.com/deepseek-ai/deepseek-harness`（DSH 官方仓库）
* 本次克隆：`master` @ `687f282e`，发布线 `dsh-0.2.1-rc.2`
* 对照代码：`packages/api/gateway/src/index.ts`、`packages/client/connection/src/rpc.ts`、
  `packages/api/session-controller/src/*`、`packages/api/workspace-controller/src/*`、
  `packages/subagent/subagent/src/*`

## 1. 传输层变化

| | 旧接口（dsh-mcp 0.1） | 新接口（DSH 0.2.x） |
|---|---|---|
| URL | `POST /api/<method>`，如 `/api/session.prompt` | `POST /api/<namespace>/<method>`，如 `/api/session/prompt` |
| 方法名 | 点号 `session.prompt` | 斜杠 `session/prompt` |
| 请求体 | `{type,rpcId,method,payload}`，`payload` 即参数 | `{type,rpcId,method,payload:{args:{…named parameters…}}}` |
| 响应 | `{type:'server-response',rpcId,result:{ok,value\|error}}` | 相同 |
| 流式 | 无 | WebSocket `/api/remote.mux`：`{type:'open',streamId,endpoint,payload:{args}}` |

命名参数按**方法形参名**传递。例如 `session/prompt(request, signal)` → `args:{request:{…}}`；
`subagents/interruptByParent(childSessionId, parentSessionId, mode)` → `args:{childSessionId,parentSessionId,mode}`。

## 2. 端点映射（23 个 MCP 工具）

| MCP 工具 | 新 DSH 端点 | 关键变化 |
|---|---|---|
| `dsh_host_info` | `session/list` + `session/modelCatalog` + `session/canOpenWorkspacePath` | 0.2.x **没有 host 命名空间**；`version` 为 `null` |
| `dsh_ping` | `session/list` | 原 `host.describe` 探活改为列会话 |
| `dsh_list_sessions` | `session/list` | 标题来自 `item.projections.values.title` |
| `dsh_read_history` | `session/page` | 新分页请求：`{address,throughSeq,maxMessages,beforeSeq?}`；返回 `{records,hasMore}` |
| `dsh_session_overview` | `session/list` + `session/page` + `session/modelCatalog` + `session/projections` | 模型选择来自 `values.modelSelection` |
| `dsh_create_session` | `session/create` | 入参改为 `{request:{workspaceId?,cwd?,sessionId?,agentPreset?}}` |
| `dsh_send_message` | `session/prompt` | **必须**带客户端生成的 `requestId`；返回 `{accepted:true}` |
| `dsh_wait_for_turn` | 轮询 `session/list` | 逻辑不变（`running` / `updatedAt`） |
| `dsh_dispatch_task` | `session/create` + `session/rename` + `session/prompt` | 逻辑不变 |
| `dsh_run_task` | 同上 + 轮询 | 逻辑不变 |
| `dsh_cancel_turn` | `session/cancel` | 入参 `{request:{sessionId}}` |
| `dsh_rename_session` | `session/rename` | 同上 |
| `dsh_fork_session` | `session/fork` | 可选 `atSeq` / `allowMigration` |
| `dsh_archive_session` | `workspace/archiveSession` | 返回完整 `archivedSessionIds` |
| `dsh_list_models` | `session/modelCatalog` + `session/projections` | 原 `session.models` 拆为全局目录 + 每会话投影 |
| `dsh_select_model` | `session/selectModel` | 入参 `{request:{sessionId,provider,model,reasoningEffort?}}` |
| `dsh_list_workspaces` | `workspace/follow` 首帧 `baseline` | 无一元 `workspace.list`；改读流的 baseline（含 archived/pinned） |
| `dsh_create_workspace` | `workspace/create` | 幂等，返回 `{workspace,created}` |
| `dsh_list_subagents` | `session/projections` → `values.subagentCatalog` | 无 `subagent.list`；子目录改为父会话投影 |
| `dsh_read_subagent_history` | `session/page` + 子代理 `SessionAddress` | 地址：`{kind:'subagent',parentSessionId,childSessionId,mode}` |
| `dsh_message_subagent` | `subagents/prompt` | 命名空间为 `subagents`；必须 `mode:'continuable'` + `requestId` |
| `dsh_interrupt_subagent` | `subagents/interruptByParent` | 形参 `{childSessionId,parentSessionId,mode}` |
| `dsh_call` | 任意 `<namespace>/<method>` | `method` 现在是端点字符串，`payload` 是命名参数对象 |

## 3. 关键事件结构变化

| 旧 | 新 |
|---|---|
| `session.history` 返回 `events:[{event}]` | `session/page` 返回 `records:[{type:'event',event}]` |
| 消息事件统一 `data.message` | `user/message` 的 `data` 就是消息；`assistant/message` 的 `data.message` 才是消息 |
| `event_kinds['tool/call']` | 不变（`tool/call`） |
| `turn/end` | 不变 |
| `subagent.list` 的 `activity/hasChildren` | `subagentCatalog` 只有 `{id,createdAt,mode,label?}`；子会话是否在跑需看 `session/list.running` |

## 4. 代码改动

* `src/client.js`：新信封 + `{args}` + `<namespace>/<method>`；新增 `openStream` / `firstStreamItem`
  （WebSocket `/api/remote.mux`，带超时与取消）。
* `src/tools/support.js`：`session/page` 读取 + 新事件 digest；`workspace/follow` baseline；
  `subagentCatalog`；`workspace/create` 幂等解析。
* `src/tools/{host,session,workspace,subagent,raw}.js`：全部改到新端点与入参/返回结构。
* `src/schema.js`：`dsh_call` 的 `method` 改为端点格式；子代理 `mode` 支持 `one-shot` / `unknown`。
* `test/mock-dsh.mjs`：mock 升级到 0.2.x（含 `payload.args` 与 WebSocket baseline）。
* `test/verify-dsh-contract.mjs`：直接解析最新 DSH 源码里的 `@Remote` 装饰器，校验我们调用的每个
  `namespace/method` 仍然存在，并校验 `payload.args` 规则。

## 5. 验证

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git /tmp/dsh-src
DSH_SRC=/tmp/dsh-src npm run verify:dsh-contract   # 全部端点匹配最新源码
npm run test:mock                                  # 39/39 通过（无需真实 DSH）
DSH_BASE=http://127.0.0.1:3080 npm test            # 有真实 DSH 时
```

## 6. 已知限制

1. 0.2.x 没有 host 版本端点，`dsh_host_info.version` 只能为 `null`。
2. `workspace/follow` 需要 WebSocket（Node ≥ 22 的全局 `WebSocket`）；更低版本会退化为按会话 `cwd`
   聚合（不产生注册副作用，但拿不到 archived/pinned 列表）。
3. `subagents/prompt` / `interruptByParent` 只接受 `continuable` 子代理；一次性子代理会返回结构化
   `subagent/*` 错误（读取转录不受影响）。
