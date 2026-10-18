# Testing dsh-mcp

This project ships two test suites that talk to a **live DSH host** at `$DSH_BASE`
(default `http://127.0.0.1:3080`). The adapter targets the **DSH 0.2.x Typert Remote** interface
(`/api/<namespace>/<method>` with a `{args:{…}}` payload), not the legacy dotted `/api/<method>` API.

| Suite | File | Tests | Needs a live DSH? |
| --- | --- | --- | --- |
| Protocol conformance | `test/protocol.test.mjs` | 13 | 2 of 13 (the HTTP-transport + raw-call cases) |
| End-to-end | `test/e2e.test.mjs` | 26 | all 26 |

The interface mapping from the legacy dotted API to DSH 0.2.x is documented in
[`DSH-0.2-MIGRATION.md`](DSH-0.2-MIGRATION.md).

## Run against a real DSH

```bash
npm install
DSH_BASE=http://127.0.0.1:3080 npm test
```

## Run with no DSH available (mock host)

`test/mock-dsh.mjs` is a self-contained mock of the DSH 0.2.x surface: it speaks the same
`client-request` → `server-response` envelope (`payload.args`) that `src/client.js` sends, implements the
unary endpoints the tools use, and serves the `/api/remote.mux` stream mux for `workspace/follow`.

```bash
npm run test:mock          # starts the mock on 127.0.0.1:3080, runs BOTH suites, exits with the test code
node test/mock-dsh.mjs     # or run the mock standalone (default port 3080)
```

`test/run-e2e-mock.mjs` starts the mock, then runs the exact same
`node --test test/protocol.test.mjs test/e2e.test.mjs` command with `DSH_BASE` pointed at it.

## Verify the adapter against the latest DSH source

`test/verify-dsh-contract.mjs` parses the `@Remote` decorators of the cloned `deepseek-harness` checkout
and checks every `namespace/method` used by `src/tools/*`, plus the `payload.args` envelope rule:

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git /tmp/dsh-src
DSH_SRC=/tmp/dsh-src npm run verify:dsh-contract
# -> [contract] all endpoints match the latest DSH source
```

## Result of the last complete run

```
ℹ tests 39
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 15215.22
```

Headline proofs that actually executed (not skipped):

* **S8** — the MCP-driven side effect is real: the session the test created wrote `/tmp/mcp-e2e.txt`
  (`exists(/tmp/mcp-e2e.txt) = true`, `content = "E2E-OK\n"`) and answered `E2E-OK`.
* **S9** — history contains both the prompt and the answer, with
  `event_kinds {"user/message":1,"tool/call":1,"assistant/message":1,"turn/end":1}`.
* **S18** — `workspace/follow`'s baseline reflects the archive: `archived_session_count: 0 -> 1`.
* **S22** — a child subagent was spawned, its transcript was read through `session/page`, and the
  one-shot write path (`subagents/prompt` refused with a structured `subagent/*` error,
  `subagents/interruptByParent` accepted) was proven.

Two lines are `SKIP-EVIDENCE` **by design**: S13c skips when no pre-existing child exists in the scanned
sessions, and S22 takes the one-shot-child branch. Both branches are explicit assertions, not silent passes.

## Scope of the mock

The mock is test scaffolding under `test/`; it is **not** part of the published package (see the
`files` allow-list in `package.json`). It models only the semantics the suites assert — sessions,
`session/page` history records, `subagentCatalog` projections, `workspace/follow` baselines, the
running-flag wait loop, model selection, and one-shot subagents — and it deliberately reproduces DSH's
quirks (business errors carried on HTTP 200, `subagent/not-found` for one-shot children).
