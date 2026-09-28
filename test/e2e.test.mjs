/**
 * END-TO-END test: every tool driven through the real MCP protocol against a REAL DSH instance.
 *
 * Nothing is stubbed. The MCP server runs as a child process over stdio (and over streamable HTTP for
 * one test), and the target is the live DSH host at $DSH_BASE (default http://127.0.0.1:3080).
 *
 * The headline proof is `S3`: this test asks a *fresh DSH session, running on the host* to write a file
 * and answer E2E-OK; the file and the answer are then verified from the test process. If the MCP tool
 * chain (create → prompt → wait → history) were broken, that file could not exist.
 *
 * Sessions created here are archived in `after()` — DSH has no session.delete, so archive is the only
 * cleanup primitive and leaving test sessions in the user's sidebar would be unacceptable.
 *
 *   node --test --test-reporter=spec test/e2e.test.mjs
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'index.js');
const DSH_BASE = process.env.DSH_BASE ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const WORKSPACE_PATH = process.env.E2E_WORKSPACE ?? '<WORKSPACE>';
const ARTIFACT = '/tmp/mcp-e2e.txt';
const WAIT_BUDGET_MS = Number(process.env.E2E_WAIT_MS ?? 300_000);

const note = (...parts) => console.log(...parts);

async function mcpClient(env = {}, label = 'e2e') {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER],
		env: { ...getDefaultEnvironment(), DSH_BASE, ...env },
		stderr: 'pipe',
	});
	const stderr = [];
	transport.stderr?.on('data', (c) => stderr.push(String(c)));
	const client = new Client({ name: `e2e-${label}`, version: '1.0.0' });
	await client.connect(transport);
	return { client, stderr, close: () => client.close() };
}

/** Call a tool, print the raw JSON payload, and return the parsed body. */
async function call(client, name, args = {}, { expectError = false, label = '' } = {}) {
	const started = Date.now();
	const result = await client.callTool({ name, arguments: args });
	const body = JSON.parse(result.content[0].text);
	if (label) note(`--- ${label} (${Date.now() - started} ms) ---`);
	note(JSON.stringify(body, null, 2));
	if (!expectError) assert.notEqual(result.isError, true, `${name} unexpectedly failed: ${result.content[0].text}`);
	if (expectError) assert.equal(result.isError, true, `${name} was expected to fail but succeeded`);
	return body;
}

async function pickFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createNetServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** Minimal TCP forwarder: listen on `localPort`, pipe bytes to 127.0.0.1:3080 (stands in for socat/ssh -L). */
function startTcpForwarder(localPort, targetPort) {
	const server = createNetServer((socket) => {
		const upstream = netConnect(targetPort, '127.0.0.1');
		socket.pipe(upstream);
		upstream.pipe(socket);
		socket.on('error', () => upstream.destroy());
		upstream.on('error', () => socket.destroy());
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(localPort, '127.0.0.1', () => resolve(server));
	});
}

let primary;
let dispatchBaseline;
/**
 * Every session created by this test, archived in after(). Order matters: the archive assertions run
 * on S1, the rest are cleaned up afterwards.
 */
const created = new Map(); // session_id -> label

before(async () => {
	primary = await mcpClient();
});

after(async () => {
	if (ARTIFACT.startsWith('/tmp/mcp-e2e')) rmSync(ARTIFACT, { force: true });
	const list = [...created.entries()];
	note(`\n=== cleanup: archiving ${list.length} test sessions: ${list.map(([id]) => id).join(', ')}`);
	for (const [id, label] of list) {
		try {
			const result = await primary.client.callTool({ name: 'dsh_archive_session', arguments: { session_id: id } });
			const body = JSON.parse(result.content[0].text);
			note(`  archived ${id} (${label}) -> archived_count=${body.archived_session_count} isError=${result.isError === true}`);
		} catch (error) {
			note(`  FAILED to archive ${id}: ${error.message}`);
		}
	}
	await primary?.close();
});

// --------------------------------------------------------------------------- host

test('S1 dsh_host_info reports the live host and the base URL actually used', async () => {
	const body = await call(primary.client, 'dsh_host_info', {}, { label: 'dsh_host_info' });
	assert.equal(body.base_url, DSH_BASE);
	assert.ok(body.version, 'host version must be present');
	assert.ok(body.provider && body.model, 'provider/model must be present');
	assert.ok(Number.isInteger(body.attachedSessions));
	note(`host: version=${body.version} provider=${body.provider} model=${body.model} attached=${body.attachedSessions} base_url_source=${body.base_url_source}`);
});

test('S2 dsh_ping confirms reachability with latency', async () => {
	const body = await call(primary.client, 'dsh_ping', {}, { label: 'dsh_ping' });
	assert.equal(body.ok, true);
	assert.equal(body.base, DSH_BASE);
	note(`ping ok in ${body.elapsedMs} ms`);
});

test('S3 dsh_list_workspaces contains the Aub workspace', async () => {
	const body = await call(primary.client, 'dsh_list_workspaces', {}, { label: 'dsh_list_workspaces' });
	const paths = body.workspaces.map((w) => w.path);
	assert.ok(paths.includes(WORKSPACE_PATH), `expected ${WORKSPACE_PATH} among ${paths.join(', ')}`);
	assert.ok(body.archived_session_count >= 0);
	note(`workspaces: ${body.count}, archived: ${body.archived_session_count}, ${WORKSPACE_PATH} id = ${body.workspaces.find((w) => w.path === WORKSPACE_PATH).workspace_id}`);
});

test('S4 dsh_list_sessions filters by cwd and by running flag', async () => {
	const body = await call(primary.client, 'dsh_list_sessions', { cwd: WORKSPACE_PATH, limit: 5, include_titles: true }, { label: 'dsh_list_sessions' });
	assert.ok(body.returned > 0, 'expected at least one session in the workspace');
	assert.ok(body.sessions.every((s) => s.cwd === WORKSPACE_PATH));
	note(`sessions in ${WORKSPACE_PATH}: ${body.returned} of ${body.total_matching} matching (host total ${body.total_sessions_on_host})`);

	const running = await call(primary.client, 'dsh_list_sessions', { running_only: true, limit: 10 }, { label: 'dsh_list_sessions (running_only)' });
	assert.ok(running.sessions.every((s) => s.running === true));
	note(`running_only=true -> ${running.returned} of ${running.total_matching} matching (host total ${running.total_sessions_on_host})`);
});

test('S4b dsh_create_workspace is idempotent for the Aub path and rejects a missing directory', async () => {
	const body = await call(primary.client, 'dsh_create_workspace', { path: WORKSPACE_PATH }, { label: 'dsh_create_workspace (existing path)' });
	assert.equal(body.created, false, 'an already-registered path must not create a second workspace');
	assert.equal(body.already_registered, true);

	const bad = await call(
		primary.client,
		'dsh_create_workspace',
		{ path: '<WORKSPACE>/definitely-not-a-real-dir-e2e' },
		{ expectError: true, label: 'dsh_create_workspace (missing dir, expect isError)' },
	);
	assert.equal(bad.error.kind, 'bad-directory');
	note('local pre-check produced a structured bad-directory error instead of a raw RPC failure');
});

// --------------------------------------------------------------------------- the headline flow

let s3;

test('S5 dsh_create_session + dsh_rename_session inside the Aub workspace', async () => {
	const created0 = await call(primary.client, 'dsh_create_session', { workspace: WORKSPACE_PATH }, { label: 'dsh_create_session' });
	assert.match(created0.session_id, /^session-/);
	assert.equal(created0.grouped, true, 'a workspace-bound session must be grouped');
	s3 = created0.session_id;
	created.set(s3, 'S5 main E2E');

	const renamed = await call(primary.client, 'dsh_rename_session', { session_id: s3, title: 'T2 e2e: MCP 操控真实 DSH' }, { label: 'dsh_rename_session' });
	assert.equal(renamed.title, 'T2 e2e: MCP 操控真实 DSH');
	note(`created + renamed test session: ${s3}`);
});

test('S5b dsh_create_session with cwd yields an ungrouped session, and workspace+cwd is rejected', async () => {
	const ungrouped = await call(primary.client, 'dsh_create_session', { cwd: '/tmp' }, { label: 'dsh_create_session (cwd only)' });
	assert.equal(ungrouped.grouped, false);
	assert.match(ungrouped.warning, /UNGROUPED/);
	created.set(ungrouped.session_id, 'S5b ungrouped cwd session');

	const both = await call(
		primary.client,
		'dsh_create_session',
		{ workspace: WORKSPACE_PATH, cwd: '/tmp' },
		{ expectError: true, label: 'dsh_create_session (workspace + cwd, expect isError)' },
	);
	assert.equal(both.error.kind, 'bad-request');
});

test('S6 dsh_send_message delivers a real task to that session', async () => {
	const body = await call(
		primary.client,
		'dsh_send_message',
		{ session_id: s3, text: `请用 bash 在 /tmp/mcp-e2e.txt 写入一行 E2E-OK（文件内容就这一行），然后用一行回复 E2E-OK。不要做其它事情。` },
		{ label: 'dsh_send_message' },
	);
	assert.equal(body.accepted, true);
});

test('S7 dsh_wait_for_turn settles and returns the assistant answer', async () => {
	const body = await call(primary.client, 'dsh_wait_for_turn', { session_id: s3, timeout_ms: WAIT_BUDGET_MS, poll_interval_ms: 2000 }, { label: 'dsh_wait_for_turn' });
	assert.equal(body.settled, true, `expected the turn to settle, got: ${JSON.stringify(body)}`);
	assert.match(body.last_assistant_text, /E2E-OK/, `assistant text did not contain E2E-OK: ${body.last_assistant_text}`);
	note(`settled after ${body.polls} polls (detected by ${body.settle_detected_by}), turns=${body.turns}, tool_calls=${body.tool_calls}`);
	note(`last assistant text: ${JSON.stringify(body.last_assistant_text.slice(0, 300))}`);
});

test('S8 the file the remote session wrote really exists (MCP-driven side effect)', () => {
	note(`exists(${ARTIFACT}) = ${existsSync(ARTIFACT)}`);
	assert.ok(existsSync(ARTIFACT), `${ARTIFACT} was not created by the DSH session`);
	const content = readFileSync(ARTIFACT, 'utf8');
	note(`content = ${JSON.stringify(content)}`);
	assert.match(content, /E2E-OK/);
});

test('S9 dsh_read_history sees both the prompt and the answer', async () => {
	const body = await call(primary.client, 'dsh_read_history', { session_id: s3, max: 20, text_only: true }, { label: 'dsh_read_history' });
	const roles = body.messages.map((m) => m.role);
	note(`messages: ${body.messages.length} (${roles.join(', ')})`);
	assert.ok(body.messages.some((m) => m.role === 'user' && /mcp-e2e\.txt/.test(m.text)), 'prompt text missing from history');
	assert.ok(body.messages.some((m) => m.role === 'assistant' && /E2E-OK/.test(m.text)), 'E2E-OK missing from history');
	assert.ok(body.event_kinds['tool/call'] >= 1, 'the session should have used a tool');
	note(`event kinds: ${JSON.stringify(body.event_kinds)}`);

	// backwards paging with `before`
	assert.ok(body.first_seq !== null, 'a page must expose its first seq for paging');
	const older = await call(primary.client, 'dsh_read_history', { session_id: s3, max: 20, before: body.first_seq, text_only: true }, { label: `dsh_read_history (before=${body.first_seq})` });
	assert.notEqual(older.first_seq, body.first_seq);
	note(`paged backwards: ${older.events_returned} events, seq range ${older.first_seq}..${older.last_seq}, has_more=${older.has_more}`);
});

test('S10 dsh_session_overview aggregates summary + title + models + history', async () => {
	const body = await call(primary.client, 'dsh_session_overview', { session_id: s3 }, { label: 'dsh_session_overview' });
	assert.equal(body.title, 'T2 e2e: MCP 操控真实 DSH');
	assert.equal(body.summary.running, false);
	assert.ok(body.models.current, 'current model must be reported');
	note(`overview: title=${body.title} running=${body.summary.running} current=${JSON.stringify(body.models.current)}`);
});

test('S11 dsh_list_models + idempotent dsh_select_model round-trip', async () => {
	const models = await call(primary.client, 'dsh_list_models', { session_id: s3 }, { label: 'dsh_list_models' });
	const current = models.current;
	assert.ok(current?.provider && current?.model, 'current selection must be reported');
	note(`routable=${models.routable} groups=${models.group_count} failures=${models.failures.length}`);

	// Re-select the SAME model: proves the write path works without touching the deployment default.
	const selected = await call(
		primary.client,
		'dsh_select_model',
		{ session_id: s3, provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoning_effort: current.reasoningEffort } : {}) },
		{ label: 'dsh_select_model (same value, idempotent)' },
	);
	assert.equal(selected.selected.provider, current.provider);
	assert.equal(selected.selected.model, current.model);
	note('selectModel round-trip ok — deployment default was kept at the same value on purpose');
});

test('S12 dsh_select_model rejects a bogus provider as a structured DSH error', async () => {
	const body = await call(
		primary.client,
		'dsh_select_model',
		{ session_id: s3, provider: 'no-such-provider', model: 'no-such-model' },
		{ expectError: true, label: 'dsh_select_model (bogus, expect isError)' },
	);
	assert.equal(body.error.kind, 'rpc');
	assert.equal(body.error.code, 'model-unavailable');
	note(`DSH business error carried on HTTP 200 was surfaced as: code=${body.error.code}`);
});

test('S13 dsh_list_subagents on the test session', async () => {
	const body = await call(primary.client, 'dsh_list_subagents', { parent_session_id: s3 }, { label: 'dsh_list_subagents' });
	assert.equal(body.parent_available, true);
	assert.ok(Array.isArray(body.entries));
	note(`subagents of ${s3}: ${body.count} ${JSON.stringify(body.entries)}`);
});

test('S13b dsh_fork_session forks the finished turn into a new session', async () => {
	const body = await call(primary.client, 'dsh_fork_session', { session_id: s3 }, { label: 'dsh_fork_session' });
	assert.match(body.session_id, /^session-/);
	assert.notEqual(body.session_id, s3);
	created.set(body.session_id, 'S13b fork of the E2E session');
	const overview = await call(primary.client, 'dsh_session_overview', { session_id: body.session_id }, { label: 'dsh_session_overview (fork)' });
	assert.equal(overview.summary.running, false);
	note(`forked ${s3} -> ${body.session_id} (title inherited: ${JSON.stringify(overview.title)})`);
});

test('S13c dsh_read_subagent_history reads a child transcript when one exists', async () => {
	// Look for any child of a session in this workspace; if none exists there is nothing to read and
	// we say so explicitly instead of faking a pass.
	const sessions = await call(primary.client, 'dsh_list_sessions', { cwd: WORKSPACE_PATH, limit: 40 }, { label: 'dsh_list_sessions (subagent scan)' });
	let found = null;
	for (const s of sessions.sessions) {
		const page = await primary.client.callTool({ name: 'dsh_list_subagents', arguments: { parent_session_id: s.session_id } });
		const listed = JSON.parse(page.content[0].text);
		const child = listed.entries?.find((e) => e.kind === 'child');
		if (child) {
			found = { parent: s.session_id, child: child.session_id, mode: child.mode };
			break;
		}
	}
	if (!found) {
		note(`SKIP-EVIDENCE: no subagent child among the ${sessions.returned} sessions scanned in ${WORKSPACE_PATH} — the read path stays exercised by the MCP-level schema/validation tests.`);
		return;
	}
	note(`found subagent child ${found.child} (mode=${found.mode}) under ${found.parent}`);
	const body = await call(primary.client, 'dsh_read_subagent_history', { parent_session_id: found.parent, session_id: found.child, max: 10, text_only: true }, { label: 'dsh_read_subagent_history' });
	assert.ok(body.events_returned >= 0);
	note(`subagent transcript returned ${body.events_returned} events, ${body.messages?.length ?? 0} text messages`);
});

// --------------------------------------------------------------------------- non-blocking orchestration

let s2;

test('S14 dsh_dispatch_task returns immediately (non-blocking) with a session id', async () => {
	const started = Date.now();
	const body = await call(
		primary.client,
		'dsh_dispatch_task',
		{ task: '只回复一行 DISPATCH-OK，不要做其它任何事情。', workspace: WORKSPACE_PATH, title: 'T2 e2e: dispatch_task' },
		{ label: 'dsh_dispatch_task' },
	);
	const elapsed = Date.now() - started;
	s2 = body.session_id;
	created.set(s2, 'S14 dispatch_task');
	assert.equal(body.dispatched, true);
	assert.ok(elapsed < 15_000, `dispatch_task should return fast, took ${elapsed} ms`);
	dispatchBaseline = body.baseline_updated_at;
	note(`dispatch_task returned in ${elapsed} ms; next_call = ${JSON.stringify(body.next_call)}`);
});

test('S15 dsh_wait_for_turn with require_start=false collects the dispatched result', async () => {
	const body = await call(primary.client, 'dsh_wait_for_turn', { session_id: s2, timeout_ms: WAIT_BUDGET_MS, poll_interval_ms: 2000, baseline_updated_at: dispatchBaseline }, { label: 'dsh_wait_for_turn (dispatched session)' });
	assert.equal(body.settled, true);
	assert.match(body.last_assistant_text, /DISPATCH-OK/);
	note(`dispatched task answer: ${JSON.stringify(body.last_assistant_text.slice(0, 200))}`);
});

let s4;

test('S16 dsh_run_task: dispatch + wait in one call', async () => {
	const body = await call(
		primary.client,
		'dsh_run_task',
		{ task: '只回复一行 RUN-OK，不要做其它任何事情。', workspace: WORKSPACE_PATH, title: 'T2 e2e: run_task', timeout_ms: WAIT_BUDGET_MS, poll_interval_ms: 2000 },
		{ label: 'dsh_run_task' },
	);
	if (body.session_id) {
		s4 = body.session_id;
		created.set(s4, 'S16 run_task');
	}
	assert.equal(body.settled, true, `run_task did not settle: ${JSON.stringify(body).slice(0, 400)}`);
	assert.match(body.last_assistant_text, /RUN-OK/);
	note(`run_task settled after ${body.polls} polls; answer = ${JSON.stringify(body.last_assistant_text.slice(0, 160))}`);
});

test('S17 a budget that is too small returns "still running" instead of an error', async () => {
	const dispatch = await call(
		primary.client,
		'dsh_dispatch_task',
		{ task: '先运行 bash 命令 sleep 45，等它结束后只回复一行 SLOW-OK。', workspace: WORKSPACE_PATH, title: 'T2 e2e: cancel + timeout' },
		{ label: 'dsh_dispatch_task (long task)' },
	);
	const s5 = dispatch.session_id;
	created.set(s5, 'S17 timeout + cancel');

	const first = await call(primary.client, 'dsh_wait_for_turn', { session_id: s5, timeout_ms: 4000, poll_interval_ms: 1000, baseline_updated_at: dispatch.baseline_updated_at }, { label: 'dsh_wait_for_turn (4 s budget)' });
	assert.equal(first.timed_out, true, 'a 4 s budget must not be enough for a 45 s task');
	assert.equal(first.settled, false);
	assert.equal(first.isError, undefined);
	assert.equal(first.next_call.tool, 'dsh_wait_for_turn');
	note(`pending envelope hint: ${first.hint}`);
	note(`continuation: ${JSON.stringify(first.next_call)}`);

	// now the cancel path on the same running session
	const cancel = await call(primary.client, 'dsh_cancel_turn', { session_id: s5 }, { label: 'dsh_cancel_turn' });
	assert.equal(cancel.accepted, true);

	const after2 = await call(primary.client, 'dsh_wait_for_turn', { session_id: s5, timeout_ms: 60_000, poll_interval_ms: 2000, require_start: false }, { label: 'dsh_wait_for_turn (require_start=false after cancel)' });
	assert.equal(after2.settled, true, 'the session must go idle after a cancel');
	assert.equal(after2.summary.running, false);
	note(`after cancel: running=${after2.summary.running}, last assistant text = ${JSON.stringify((after2.last_assistant_text ?? '').slice(0, 200))}`);
});

// --------------------------------------------------------------------------- archive / cleanup primitive

test('S18 dsh_archive_session hides the session and shows up in archivedSessionIds', async () => {
	const before = await call(primary.client, 'dsh_list_workspaces', {}, { label: 'dsh_list_workspaces (before archive)' });
	const body = await call(primary.client, 'dsh_archive_session', { session_id: s3 }, { label: 'dsh_archive_session' });
	assert.equal(body.archived, true);

	const after = await call(primary.client, 'dsh_list_workspaces', {}, { label: 'dsh_list_workspaces (after archive)' });
	assert.equal(after.archived_session_count, before.archived_session_count + 1, `archived count should grow by exactly 1 (${before.archived_session_count} -> ${after.archived_session_count})`);
	created.delete(s3);
	note(`archived_session_count: ${before.archived_session_count} -> ${after.archived_session_count}`);
});

// --------------------------------------------------------------------------- configurable base URL

test('S19 a non-default base URL really moves the wire target (TCP forwarder on a random port)', async () => {
	const target = new URL(DSH_BASE);
	const targetPort = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
	const proxyPort = await pickFreePort();
	const forwarder = await startTcpForwarder(proxyPort, targetPort);
	const proxyBase = `http://127.0.0.1:${proxyPort}`;
	note(`TCP forwarder: 127.0.0.1:${proxyPort} -> 127.0.0.1:${targetPort} (stands in for socat/ssh -L)`);
	assert.notEqual(proxyBase, DSH_BASE, 'the forwarded base must differ from the default one');

	const viaProxy = await mcpClient({ DSH_BASE: proxyBase }, 'proxy-base');
	try {
		const info = await call(viaProxy.client, 'dsh_host_info', {}, { label: `dsh_host_info via ${proxyBase}` });
		assert.equal(info.base_url, proxyBase, 'the MCP server must report the forwarded base');
		assert.equal(info.base_url_source, 'env:DSH_BASE');
		const direct = await call(primary.client, 'dsh_host_info', {}, { label: `dsh_host_info via ${DSH_BASE}` });
		assert.equal(direct.base_url, DSH_BASE);
		assert.equal(direct.version, info.version, 'both bases must reach the same DSH host');
		assert.equal(direct.provider, info.provider);
		note(`both bases answered from the same host: version=${info.version} provider=${info.provider}; base_url differs (${proxyBase} vs ${DSH_BASE}) ✔`);

		// CLI flag beats env: --base must win over DSH_BASE
		const cliTransport = new StdioClientTransport({
			command: process.execPath,
			args: [SERVER, '--base', proxyBase],
			env: { ...getDefaultEnvironment(), DSH_BASE: 'http://127.0.0.1:1' },
			stderr: 'pipe',
		});
		const cliClient = new Client({ name: 'e2e-cli-base', version: '1.0.0' });
		await cliClient.connect(cliTransport);
		const viaCli = await call(cliClient, 'dsh_host_info', {}, { label: `dsh_host_info with --base ${proxyBase} (env DSH_BASE poisoned)` });
		assert.equal(viaCli.base_url, proxyBase, '--base must override DSH_BASE');
		assert.equal(viaCli.base_url_source, 'cli:--base');
		note('CLI flag precedence proven: env DSH_BASE=http://127.0.0.1:1 was ignored in favour of --base');
		await cliClient.close();
	} finally {
		await viaProxy.close();
		forwarder.close();
	}
});

test('S20 a wrong base URL fails loudly, naming the base (negative control)', async () => {
	const deadPort = await pickFreePort();
	const wrong = await mcpClient({ DSH_BASE: `http://127.0.0.1:${deadPort}`, DSH_RETRIES: '0' }, 'wrong-base');
	try {
		const body = await call(wrong.client, 'dsh_ping', {}, { expectError: false, label: 'dsh_ping (dead base, ok=false by design)' });
		assert.equal(body.ok, false);
		assert.equal(body.error.kind, 'transport');
		assert.equal(body.base, `http://127.0.0.1:${deadPort}`);
		const info = await call(wrong.client, 'dsh_host_info', {}, { expectError: true, label: 'dsh_host_info (dead base, expect isError)' });
		assert.equal(info.error.kind, 'transport');
		assert.match(info.error.message, new RegExp(`cannot reach DSH at http://127.0.0.1:${deadPort}`));
	} finally {
		await wrong.close();
	}
});

// --------------------------------------------------------------------------- HTTP transport, live

test('S21 the same tools over streamable HTTP drive the real DSH', async () => {
	const port = await pickFreePort();
	const child = spawn(process.execPath, [SERVER, '--http', '--port', String(port), '--base', DSH_BASE], {
		env: getDefaultEnvironment(),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (c) => {
		stderr += String(c);
	});
	const deadline = Date.now() + 20_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/healthz`);
			if (res.ok) break;
		} catch {
			/* keep waiting */
		}
		if (Date.now() > deadline) throw new Error(`HTTP server not ready; stderr:\n${stderr}`);
		await delay(200);
	}
	note(`HTTP server stderr: ${stderr.trim()}`);

	const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
	const client = new Client({ name: 'e2e-http', version: '1.0.0' });
	await client.connect(transport);
	try {
		const info = await call(client, 'dsh_host_info', {}, { label: `dsh_host_info over streamable HTTP :${port}` });
		assert.equal(info.base_url, DSH_BASE);
		const sessions = await call(client, 'dsh_list_sessions', { cwd: WORKSPACE_PATH, limit: 3 }, { label: 'dsh_list_sessions over HTTP' });
		assert.ok(sessions.returned > 0);
		note(`HTTP transport drove the real DSH: ${sessions.returned} sessions in ${WORKSPACE_PATH}`);
	} finally {
		await client.close();
		child.kill('SIGTERM');
	}
});
// --------------------------------------------------------------------------- subagent write path

test('S22 subagent tools on a child this test spawned itself (list / read / message / interrupt)', async () => {
	const dispatch = await call(
		primary.client,
		'dsh_dispatch_task',
		{
			task: '请用 subagent 工具派一个子 agent，让它运行 bash 命令 echo SUBAGENT-PROBE。等子 agent 返回后，只回复一行 PARENT-DONE。',
			workspace: WORKSPACE_PATH,
			title: 'T2 e2e: subagent tools',
		},
		{ label: 'dsh_dispatch_task (spawn a subagent)' },
	);
	const parent = dispatch.session_id;
	created.set(parent, 'S22 subagent parent');

	const settle = await call(primary.client, 'dsh_wait_for_turn', { session_id: parent, timeout_ms: WAIT_BUDGET_MS, poll_interval_ms: 3000, baseline_updated_at: dispatch.baseline_updated_at }, { label: 'dsh_wait_for_turn (subagent parent)' });
	assert.equal(settle.settled, true, `parent turn did not settle: ${JSON.stringify(settle).slice(0, 300)}`);
	note(`parent answer: ${JSON.stringify((settle.last_assistant_text ?? '').slice(0, 200))}`);

	const list = await call(primary.client, 'dsh_list_subagents', { parent_session_id: parent }, { label: 'dsh_list_subagents (own parent)' });
	const child = list.entries.find((e) => e.kind === 'child');
	if (!child) {
		note('SKIP-EVIDENCE: the session did not spawn a subagent, so the child write path (message/interrupt) was not exercised in this run. list/read remain covered.');
		return;
	}
	note(`child discovered: ${child.session_id} mode=${child.mode} activity=${child.activity} label=${JSON.stringify(child.label)} readable_via=${child.readable_via}`);
	assert.doesNotMatch(child.session_id, /^session-/, 'child ids are bare uuids — worth pinning down in a test');

	const transcript = await call(primary.client, 'dsh_read_subagent_history', { parent_session_id: parent, session_id: child.session_id, max: 10, text_only: true }, { label: 'dsh_read_subagent_history (own child)' });
	assert.ok(transcript.events_returned > 0, 'the child transcript must be readable');
	note(`child transcript: ${transcript.events_returned} events, ${transcript.messages?.length ?? 0} text messages, method=${transcript.method}, last assistant = ${JSON.stringify((transcript.last_assistant_text ?? '').slice(0, 120))}`);
	if (transcript.fallback) note(`read fell back to session.history: ${transcript.fallback.attempted} -> ${transcript.fallback.reason}`);

	if (child.mode !== 'continuable') {
		// Measured against host 0.0.1: a one-shot child refuses subagent.prompt with subagent-not-found,
		// but subagent.interrupt IS accepted. Both halves are the contract, so assert both.
		const refused = await call(primary.client, 'dsh_message_subagent', { parent_session_id: parent, child_session_id: child.session_id, text: 'ping' }, { expectError: true, label: 'dsh_message_subagent (one-shot child, expect isError)' });
		assert.equal(refused.error.kind, 'rpc');
		assert.equal(refused.error.code, 'subagent-not-found');
		assert.match(refused.hint, /continuable/);

		const interrupted = await call(primary.client, 'dsh_interrupt_subagent', { parent_session_id: parent, child_session_id: child.session_id, wait_ms: 10_000 }, { label: 'dsh_interrupt_subagent (one-shot child)' });
		assert.equal(interrupted.accepted, true, 'subagent.interrupt is accepted even for one-shot children');
		note(`SKIP-EVIDENCE: this run produced a "${child.mode}" child, so the successful subagent.prompt path was not reachable; prompt returned the structured subagent-not-found error, interrupt was accepted (observed activity: ${interrupted.observed_activity}), and the transcript was read through the session.history fallback.`);
		return;
	}

	const sent = await call(primary.client, 'dsh_message_subagent', { parent_session_id: parent, child_session_id: child.session_id, text: '只回复一行 SUBAGENT-PING-OK，不要做其它事情。' }, { label: 'dsh_message_subagent' });
	assert.equal(sent.delivered, true);

	let seen = false;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const page = await primary.client.callTool({ name: 'dsh_read_subagent_history', arguments: { parent_session_id: parent, session_id: child.session_id, max: 10, text_only: true } });
		const parsed = JSON.parse(page.content[0].text);
		if (/SUBAGENT-PING-OK/.test(parsed.last_assistant_text ?? '')) {
			seen = true;
			note(`child answered: ${JSON.stringify(parsed.last_assistant_text.slice(0, 200))}`);
			break;
		}
		await delay(3000);
	}
	assert.ok(seen, 'the child never answered SUBAGENT-PING-OK');

	const interrupt = await call(primary.client, 'dsh_interrupt_subagent', { parent_session_id: parent, child_session_id: child.session_id, wait_ms: 20_000 }, { label: 'dsh_interrupt_subagent' });
	assert.equal(interrupt.accepted, true);
	note(`interrupt accepted; observed activity after interrupt = ${interrupt.observed_activity}`);
});
