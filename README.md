# dsh-mcp — drive an already-running DSH instance from any MCP client

`dsh-mcp` is an **MCP (Model Context Protocol) server** that is *not* part of DSH. It is a **remote-control
client** for a DSH host: mount it in any MCP-capable AI client (Claude Desktop, Cursor, another DSH
session, a custom MCP host) and that AI can list sessions, read event-level history, **create sessions,
hand tasks to them, wait for the turn to settle, take the answer back**, cancel, rename, switch models,
manage workspaces, and drive subagents — all against a DSH instance reached over HTTP(S).

```
MCP host  ──stdio/HTTP(MCP)──▶  dsh-mcp  ──POST /api/<method> (JSON-RPC envelope)──▶  DSH host (URL configurable)
```

* **23 tools**, generated from a single schema array (`src/schema.js`).
* **stdio + streamable HTTP** transports, one implementation — no duplicated tool logic.
* **Base URL fully configurable**: `--base` > `$DSH_BASE` > `$DSH_WEB_URL` > `http://127.0.0.1:3080`;
  `http://` and `https://` both supported, plus optional bearer token / custom headers for a reverse proxy.
* Business errors that DSH returns **inside an HTTP 200** are converted to MCP `isError: true` with the
  original `code` / `message` / `details` preserved.
* Long tasks never block a request forever: `dsh_dispatch_task` (non-blocking) + `dsh_wait_for_turn`
  (polling, timeout returns a *continuation hint*, not an error).

---

## 1. Install

```bash
cd /root/Aub/t2-dsh-mcp
npm install                       # one dependency: @modelcontextprotocol/sdk@1.30.0 (pinned)
node --version                    # v20+ (developed and tested on v24.19.0)
```

No build step, no native modules, no compiler. `node_modules` is ~29 MB.

## 2. Run

```bash
# stdio (how MCP hosts mount it) — stdout carries protocol only, logs go to stderr
node src/index.js --base http://127.0.0.1:3080

# streamable HTTP (for remote mounting); prints the exact endpoint on stderr
node src/index.js --http --port 8765 --base http://127.0.0.1:3080
#   → [dsh-mcp] info: streamable HTTP transport ready — http://127.0.0.1:8765/mcp (23 tools, …)
#   → GET http://127.0.0.1:8765/healthz  for a liveness + target probe

node src/index.js --print-config   # resolved config + where every value came from (token redacted)
node src/index.js --help
```

### Claude Desktop / generic MCP host config (stdio)

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["/root/Aub/t2-dsh-mcp/src/index.js", "--base", "http://127.0.0.1:3080"],
      "env": { "DSH_TIMEOUT_MS": "60000" }
    }
  }
}
```

### Remote DSH behind a reverse proxy

```bash
node src/index.js --base https://dsh.example.com --token "$DSH_TOKEN" --header "X-Org: acme"
# equivalent: DSH_BASE=https://dsh.example.com DSH_TOKEN=… DSH_HEADERS='{"X-Org":"acme"}'
```

`--token` adds `Authorization: Bearer …`; `--header` (repeatable) adds anything else.
For a self-signed certificate use `NODE_EXTRA_CA_CERTS=/path/ca.pem` (preferred) or
`NODE_TLS_REJECT_UNAUTHORIZED=0` (blunt instrument, never in shared environments).

## 3. Configuration reference

Strict precedence: **CLI flag > environment variable > built-in default**. `--print-config` shows the
winner for every key.

| CLI | env | default | meaning |
|---|---|---|---|
| `--base <url>` | `DSH_BASE`, else `DSH_WEB_URL` | `http://127.0.0.1:3080` | DSH base URL (`http`/`https`, path prefix allowed) |
| `--token <t>` | `DSH_TOKEN` | – | `Authorization: Bearer <t>` |
| `--header "N: v"` | `DSH_HEADERS` | – | extra header (repeatable / JSON / `A: 1, B: 2`) |
| `--timeout-ms <n>` | `DSH_TIMEOUT_MS` | `30000` | per-RPC timeout |
| `--retries <n>` | `DSH_RETRIES` | `2` | retries for retryable failures (see §6) |
| `--wait-timeout-ms <n>` | `DSH_WAIT_TIMEOUT_MS` | `120000` | default budget of `dsh_wait_for_turn` / `dsh_run_task` |
| `--poll-interval-ms <n>` | `DSH_POLL_INTERVAL_MS` | `3000` | running-flag poll cadence |
| `--http` / `--stdio` | `DSH_MCP_HTTP=1` | `stdio` | MCP transport |
| `--host`, `--port`, `--path` | `DSH_HTTP_HOST`, `DSH_HTTP_PORT`, `DSH_HTTP_PATH` | `127.0.0.1`, `8765`, `/mcp` | HTTP transport binding |
| `--http-token <t>` | `DSH_HTTP_TOKEN` | – | require a bearer token on the MCP endpoint itself |
| `--allow-raw-call` | `DSH_ALLOW_RAW_CALL` | off | expose `dsh_call` (raw `/api` passthrough) |

## 4. Tools (23)

Read-only tools are marked `readOnlyHint`; anything that mutates a session/workspace is marked
`destructiveHint`. `dsh_run_task` and `dsh_wait_for_turn` are the only long-running calls, and both
take an explicit budget.

### Host
| tool | DSH method | notes |
|---|---|---|
| `dsh_host_info` | `host.describe` | version / cwd / provider / model / attached sessions **+ the base URL actually used** |
| `dsh_ping` | `host.describe` | never throws; returns `ok`, latency, or the exact error |

### Sessions
| tool | DSH method | notes |
|---|---|---|
| `dsh_list_sessions` | `session.list` | filter by `cwd`, `running_only`, optional title resolution |
| `dsh_read_history` | `session.history` / `subagent.history` | event-level, `max`/`before` paging, `text_only` flattening |
| `dsh_session_overview` | `session.list` + `history` + `models` | one-stop summary: title, running, model, event histogram |
| `dsh_create_session` | `session.create` | `workspace` (path or id) *or* `cwd` (see §7 caveat) |
| `dsh_send_message` | `session.prompt` | `queue` / `steer`; the core "make the other AI work" primitive |
| `dsh_wait_for_turn` | polls `session.list` | returns `settled` **or** `timed_out` + `next_call` (never an error) |
| `dsh_dispatch_task` | `session.create` + `prompt` | non-blocking; returns `session_id` + `baseline_updated_at` |
| `dsh_run_task` | dispatch + wait | one call, hard budget, same non-error timeout contract |
| `dsh_cancel_turn` | `session.cancel` | fire-and-return (`accepted` ≠ already idle) |
| `dsh_rename_session` | `session.rename` | pins a title |
| `dsh_fork_session` | `session.fork` | forks after a completed turn |
| `dsh_archive_session` | `workspace.archiveSession` | the only cleanup primitive DSH has |

### Models
| tool | DSH method | notes |
|---|---|---|
| `dsh_list_models` | `session.models` | current + routable + provider groups + failures |
| `dsh_select_model` | `session.selectModel` | ⚠️ **also writes the deployment default model** (see §8) |

### Workspaces
| tool | DSH method | notes |
|---|---|---|
| `dsh_list_workspaces` | `workspace.list` | ledger + archived session count |
| `dsh_create_workspace` | `workspace.create` | idempotent; **never mkdirs** |

### Subagents
| tool | DSH method | notes |
|---|---|---|
| `dsh_list_subagents` | `subagent.list` | children + diagnostics, `parentAvailable`, and per-child `readable_via` / `messageable` |
| `dsh_read_subagent_history` | `subagent.history`, with automatic `session.history` fallback | same paging/flattening as session history; works for one-shot children too |
| `dsh_message_subagent` | `subagent.prompt` | the only way to talk to a **continuable** child (`session.prompt` → `agent-busy`) |
| `dsh_interrupt_subagent` | `subagent.interrupt` | optional `wait_ms` to watch `running → inactive` |

### Raw (opt-in)
| tool | notes |
|---|---|
| `dsh_call` | ⚠️ **DISABLED unless `--allow-raw-call`**. Calls any `/api` method with an arbitrary payload. |

## 5. Usage examples

**A. Ask another DSH session to do a job and read the answer**

```
dsh_host_info                                                          # confirm the target
dsh_dispatch_task  { task: "在 /tmp 写 hello.txt 并回复 DONE", workspace: "/root/Aub" }
  → { session_id: "session-…", baseline_updated_at: 179…, next_call: { tool: "dsh_wait_for_turn", … } }
dsh_wait_for_turn  { session_id: "session-…", timeout_ms: 300000, baseline_updated_at: 179… }
  → { settled: true, last_assistant_text: "DONE", turns: 1, tool_calls: 1 }
dsh_archive_session { session_id: "session-…" }                        # clean up
```

**B. Long job without holding an MCP request open**

```
dsh_dispatch_task    → session_id …            (returns in <1 s)
… later, as often as you like …
dsh_wait_for_turn { session_id, timeout_ms: 60000 }
  → settled=false, timed_out=true, "not finished yet … call dsh_wait_for_turn again"
  → next_call: { tool: "dsh_wait_for_turn", arguments: { session_id, require_start: false } }
dsh_read_history  { session_id, max: 20 }      # peek at progress without waiting
```

**C. Look at what a session actually did**

```
dsh_read_history { session_id, max: 10, text_only: true }        # messages only
dsh_read_history { session_id, max: 20, before: 1234 }           # page backwards
dsh_read_history { session_id, text_only: false }                # raw event objects (kinds, seq, tool calls)
```

**D. Inspect subagents**

```
dsh_list_subagents     { parent_session_id }
dsh_read_subagent_history { parent_session_id, session_id: child }
dsh_message_subagent   { parent_session_id, child_session_id: child, text: "continue, but skip step 3" }
dsh_interrupt_subagent { parent_session_id, child_session_id: child, wait_ms: 20000 }
```

**E. Switching model (be careful)**

```
dsh_list_models   { session_id }                       # provider/model ids + routable flag
dsh_select_model  { session_id, provider: "local-gateway", model: "deepseek-ai/DeepSeek-V4.1-Flash" }
```

## 6. Error model

DSH answers **HTTP 200 even for business failures**; the truth is `result.error`. `dsh-mcp` never hides it:

| failure | MCP result | payload |
|---|---|---|
| DSH business error (`result.error`) | `isError: true` | `error.kind="rpc"`, `code` (`session-not-found`, `agent-busy`, `model-unavailable`, …), `message`, `details` verbatim |
| unknown tool | `isError: true` | `error.kind="unknown-tool"` + the real tool list |
| bad arguments | `isError: true` | `error.kind="invalid-arguments"`, one issue per bad field |
| disabled feature | `isError: true` | `error.kind="raw-call-disabled"` + how to enable |
| timeout | `isError: true` | `error.kind="timeout"` naming the base URL and `--timeout-ms` |
| wrong/unreachable base | `isError: true` | `error.kind="transport"`, `code="ECONNREFUSED"`, and the offending `base` |
| reverse-proxy 5xx | `isError: true` | `error.kind="carrier"`, `http_status` |

Every payload also echoes `base_url` and the tool name, and the MCP result carries
`_meta["dsh/baseUrl"]` + `_meta["dsh/elapsedMs"]` — so a multi-DSH client can always tell which
instance answered.

**Retries** are deliberately narrow, because `session.prompt` is not idempotent:

* read-only methods (`session.list`, `session.history`, `host.describe`, …) retry on transport
  failures and `502/503/504/429`;
* mutating methods retry **only** when the failure provably happened before the request reached DSH
  (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, bad port) — never on a timeout or a reset after send,
  which could double-deliver a task.

**Timeout budget vs. long tasks:** `--timeout-ms` limits one RPC; `timeout_ms` on the
wait/run tools is a *budget*, and exhaustion yields `timed_out: true` + `next_call` instead of an error.

## 7. Known limitations / sharp edges

1. **`session.create` with `cwd` creates an UNGROUPED session.** DSH has no RPC that attaches an
   existing session to a workspace (`workspace.insertSessionBefore` rejects unaccounted sessions), so
   pass `workspace` when you want the session in the sidebar. The tool returns a `warning` when it
   falls back to `cwd`.
2. **No `session.delete`.** Cleanup is `dsh_archive_session` (registry-level archive; logs and
   attachments are kept forever). Archiving cannot be undone through the RPC surface.
3. **`dsh_select_model` is a global side effect.** `session.selectModel` also persists the choice as
   the *deployment default* (`agent-default-model`), so later sessions inherit it. The tool result
   carries `global_side_effect: true` and a warning.
4. **`session.search` is disabled on this deployment** (`internal: session search is disabled: … openAt
   "never"`), so no search tool is exposed.
5. **One-shot vs. continuable children — measured asymmetry.** Against host 0.0.1:
   * child ids in `subagent.list` are **bare uuids** (`31bf59a5-…`, no `session-` prefix) — pass them verbatim;
   * `subagent.prompt` and `subagent.history` only serve **continuable** direct children; a one-shot child
     (the usual product of the model's own `subagent` tool) answers
     `subagent-not-found: … is not a continuable direct child of …`;
   * **`subagent.interrupt` is accepted for one-shot children too** (`{accepted:true}`);
   * a one-shot child's transcript **is** readable, because `session.history` and `subagent.history` share
     `readSessionState()`. `dsh_read_subagent_history` therefore catches `subagent-not-found` and retries
     through `session.history`, reporting `method` + `fallback` in the result — one read path, both child kinds;
   * `session.prompt` / `session.cancel` on a child answer `agent-busy` while it is alive and
     `session-not-found` once cold (implementation order in `api-proxy.js`), which is why the
     `subagent.*` tools exist at all.
6. **`dsh_ping`/`dsh_host_info` prove the base URL**, but everything else is only as reachable as the
   `Host` header rule of `/api` allows: DSH's own RPC gate accepts loopback or declared `trustedHosts`.
   Binding the MCP HTTP transport publicly is **your** responsibility — use `--http-token` and a proxy.
7. **No shell tool, by design.** The blast radius of `dsh-mcp` is exactly the DSH RPC surface; the only
   way to run a command is to *ask a DSH session* to run it (which the host's own sandbox/approval
   policy governs). `dsh_call` widens the surface to the whole `/api` and stays off unless requested.
8. Node ≥ 20 (uses global `fetch`); developed on Node v24.19.0 with `@modelcontextprotocol/sdk@1.30.0`.

## 8. Tests

```bash
npm test                       # both suites = 39 tests, all passing (last run: 135 s)
node --test --test-reporter=spec test/protocol.test.mjs   # 13 tests; only 2 of them touch a live DSH
node --test --test-reporter=spec test/e2e.test.mjs        # 26 tests against the real DSH at $DSH_BASE
```

Recorded raw output of the last runs: `test/output/protocol.txt`, `test/output/e2e.txt`,
`test/output/npm-test.txt`; the report quotes them in `REPORT.md` §6.

* `test/protocol.test.mjs` — real child-process server over **both** transports: `initialize`
  handshake, `tools/list` deep-equals `src/schema.js` (byte-level), handler/schema 1:1, bad
  arguments / bad enum / unknown tool / disabled `dsh_call` / unreachable DSH → `isError`, HTTP
  transport equivalence, `--http-token` 401, `--allow-raw-call` opt-in.
* `test/e2e.test.mjs` — drives every tool against the live host, including the headline proof: create a
  session → `dsh_send_message` ("写 /tmp/mcp-e2e.txt 并回复 E2E-OK") → `dsh_wait_for_turn` →
  **the file exists and the answer is `E2E-OK`** → `dsh_archive_session`. It also proves the base URL is
  really configurable with a TCP forwarder on a random port (equivalent to `socat`/`ssh -L`) and that
  `--base` beats a poisoned `DSH_BASE`. Sessions this test creates are archived in `after()`.

Raw output of the recorded runs lives in `test/output/` and is quoted in `REPORT.md`.

## 9. Layout

```
src/
  index.js     MCP entry: one server, stdio or streamable HTTP
  client.js    the ONLY place that talks HTTP to DSH (envelope, timeout, retry, error model)
  config.js    CLI/env/default resolution, --print-config, --help
  schema.js    SINGLE SOURCE OF TRUTH: names, descriptions, JSON Schemas, defaults, validation
  tools/
    index.js   dispatch table: merges schema.js + handlers, drives tools/list AND tools/call
    host.js sessions.js workspace.js subagent.js raw.js   thin handlers (no duplicated logic)
    support.js shared helpers (history digest, wait loop, workspace resolution)
test/
  protocol.test.mjs  e2e.test.mjs  output/*.txt
```

Related assets this project deliberately does **not** modify:
`/root/.dsh/skills/dsh-agent-console/` (the CLI console, source of the RPC contract) and the DSH
installation under `/root/.nvm/.../@deepseek-ai/dsh/`. See `REPORT.md` §"vs. dsh-api.mjs".