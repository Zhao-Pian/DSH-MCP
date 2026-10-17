# Testing dsh-mcp

This project ships two test suites that talk to a **live DSH host** at `$DSH_BASE`
(default `http://127.0.0.1:3080`):

| Suite | File | Tests | Needs a live DSH? |
| --- | --- | --- | --- |
| Protocol conformance | `test/protocol.test.mjs` | 13 | 2 of 13 (the HTTP-transport + raw-call cases) |
| End-to-end | `test/e2e.test.mjs` | 26 | all 26 |

## Run against a real DSH

```bash
npm install
DSH_BASE=http://127.0.0.1:3080 npm test
```

## Run with no DSH available (mock host)

`test/mock-dsh.mjs` is a self-contained mock of the DSH `/api` RPC surface: it speaks the same
`client-request` → `server-response` envelope contract that `src/client.js` expects, so the whole MCP
server (both transports, schema/validation, dispatch, the wait loop, error mapping) is exercised
end-to-end without a real host.

```bash
npm run test:mock          # starts the mock on 127.0.0.1:3080, runs BOTH suites, exits with the test code
node test/mock-dsh.mjs     # or run the mock standalone (default port 3080)
```

`test/run-e2e-mock.mjs` starts the mock, then runs the exact same
`node --test test/protocol.test.mjs test/e2e.test.mjs` command with `DSH_BASE` pointed at it.

## Result of the last complete run

```
ℹ tests 39
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14388.78
```

Headline proofs that actually executed (not skipped):

* **S8** — the MCP-driven side effect is real: the session the test created wrote `/tmp/mcp-e2e.txt`
  (`exists(/tmp/mcp-e2e.txt) = true`, `content = "E2E-OK\n"`) and answered `E2E-OK`.
* **S9** — history contains both the prompt and the answer, with `event_kinds {"message":2,"tool/call":1,"turn/end":1}`.
* **S22** — a child subagent was spawned, its transcript was read (`session.history` fallback), and the
  one-shot write path (`subagent.prompt` refused with `subagent-not-found`, `subagent.interrupt` accepted) was proven.

Two lines are `SKIP-EVIDENCE` **by design** (identical to the recorded real-host run in
`test/output/e2e.txt`): S13c skips when no pre-existing child exists in the scanned sessions, and S22
takes the one-shot-child branch. Both branches are explicit assertions, not silent passes.

## Scope of the mock

The mock is test scaffolding under `test/`; it is **not** part of the published package (see the
`files` allow-list in `package.json`). It models only the semantics the suites assert — sessions,
history paging, workspaces, the running-flag wait loop, model selection, and one-shot subagents — and
it deliberately reproduces DSH's quirks (a business error carried on HTTP 200, `subagent-not-found`
for one-shot children forcing the `session.history` fallback).
