/**
 * MCP protocol-conformance test for dsh-mcp.
 *
 * Runs against the real server process over BOTH transports (stdio and streamable HTTP) and checks:
 *   • `initialize` handshake and declared capabilities
 *   • `tools/list` agrees with src/schema.js (single source of truth) and with the handler table
 *   • bad input, unknown tool, disabled feature and unreachable DSH all come back as `isError: true`
 *     *inside* a successful JSON-RPC response (never a transport-level crash)
 *   • both transports expose the identical tool surface
 *
 * It deliberately does NOT need a live DSH except for the HTTP transport test, which uses the real
 * base URL to prove the HTTP path carries calls through to the host.
 *
 *   node --test --test-reporter=spec test/protocol.test.mjs
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { TOOL_SCHEMAS, TOOL_NAMES } from '../src/schema.js';
import { HANDLERS, buildRegistry } from '../src/tools/index.js';
import { DshClient } from '../src/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'index.js');
const DSH_BASE = process.env.DSH_BASE ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
/** A port that is valid but closed → real ECONNREFUSED (chosen at runtime, see below). */
const DEAD_PORT = Number(process.env.PROTOCOL_DEAD_PORT ?? 0);

const note = (...parts) => console.log(...parts);

/** Start the server as a child process over stdio and return a connected MCP client + its stderr. */
async function stdioClient(env = {}, label = 'stdio') {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER],
		env: { ...getDefaultEnvironment(), ...env },
		stderr: 'pipe',
	});
	const stderrChunks = [];
	transport.stderr?.on('data', (chunk) => stderrChunks.push(String(chunk)));
	const client = new Client({ name: `protocol-test-${label}`, version: '1.0.0' });
	await client.connect(transport);
	return { client, stderrChunks, transport };
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

/** Spawn the server in --http mode and wait for /healthz to answer. */
async function httpServerProcess(port, env = {}) {
	const child = spawn(process.execPath, [SERVER, '--http', '--port', String(port), '--host', '127.0.0.1'], {
		env: { ...getDefaultEnvironment(), ...env },
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
			if (res.ok) return { child, health: await res.json(), stderr: () => stderr };
		} catch {
			/* not up yet */
		}
		if (Date.now() > deadline) throw new Error(`HTTP server did not become ready on port ${port}. stderr:\n${stderr}`);
		await delay(200);
	}
}

let primary; // stdio client bound to the real base
let dead; // stdio client bound to a port where nothing listens
let DEAD_BASE;

before(async () => {
	// A port that was free a moment ago and is now closed → real ECONNREFUSED on connect.
	const deadPort = DEAD_PORT || (await pickFreePort());
	DEAD_BASE = `http://127.0.0.1:${deadPort}`;
	primary = await stdioClient({ DSH_BASE });
	dead = await stdioClient({ DSH_BASE: DEAD_BASE, DSH_RETRIES: '0' }, 'dead-base');
});

after(async () => {
	await primary?.client.close();
	await dead?.client.close();
});

test('initialize handshake: server identity + tool capability', async () => {
	const info = primary.client.getServerVersion();
	const caps = primary.client.getServerCapabilities();
	note('serverInfo =', JSON.stringify(info));
	note('capabilities =', JSON.stringify(caps));
	note('protocolVersion =', primary.client.getNegotiatedProtocolVersion?.() ?? '(sdk did not expose it)');
	assert.equal(info.name, 'dsh-mcp');
	assert.match(info.version, /^\d+\.\d+\.\d+$/);
	assert.ok(caps.tools, 'server must advertise the tools capability');
});

test('tools/list is generated from src/schema.js (single source of truth)', async () => {
	const { tools } = await primary.client.listTools();
	note(`tools/list returned ${tools.length} tools (src/schema.js declares ${TOOL_SCHEMAS.length})`);
	note('names:', tools.map((t) => t.name).join(', '));
	assert.equal(tools.length, TOOL_SCHEMAS.length, 'tool count must match the schema array');
	assert.deepEqual(
		tools.map((t) => t.name),
		TOOL_NAMES,
		'tool names and order must come from src/schema.js',
	);
	for (const tool of tools) {
		assert.equal(tool.inputSchema?.type, 'object', `${tool.name}: inputSchema must be a JSON Schema object`);
		assert.ok(tool.description?.length > 20, `${tool.name}: needs a real description`);
		assert.equal(typeof tool.title, 'string');
		assert.ok(tool.annotations, `${tool.name}: annotations missing`);
	}
	// BYTE-level proof that tools/list is the schema array: every property must round-trip.
	for (const declared of TOOL_SCHEMAS) {
		const wire = tools.find((t) => t.name === declared.name);
		assert.deepEqual(wire.inputSchema, declared.inputSchema, `${declared.name}: wire schema differs from src/schema.js`);
	}
	note('every wire inputSchema deep-equals the declaration in src/schema.js ✔');
});

test('handler table and schema array are 1:1 (no orphan handler, no handler-less tool)', () => {
	const registry = buildRegistry({ client: new DshClient({ base: DSH_BASE, timeoutMs: 5000, retries: 0 }), config: { base: DSH_BASE } });
	note(`registry built: ${registry.names.length} dispatch entries`);
	assert.deepEqual(registry.names, TOOL_NAMES);
	assert.deepEqual(Object.keys(HANDLERS).sort(), [...TOOL_NAMES].sort());
	const handlerCount = Object.keys(HANDLERS).length;
	note(`dispatch table size = ${handlerCount}, schema entries = ${TOOL_SCHEMAS.length}`);
	assert.equal(handlerCount, TOOL_SCHEMAS.length);
});

test('tools/call with a missing required argument -> isError (not a transport crash)', async () => {
	const result = await primary.client.callTool({ name: 'dsh_read_history', arguments: {} });
	note('isError =', result.isError);
	note('payload =\n' + result.content[0].text);
	assert.equal(result.isError, true);
	const body = JSON.parse(result.content[0].text);
	assert.equal(body.error.kind, 'invalid-arguments');
	assert.match(body.error.message, /session_id/);
});

test('tools/call with an unknown property -> isError', async () => {
	const result = await primary.client.callTool({ name: 'dsh_host_info', arguments: { nonsense: 1 } });
	note('isError =', result.isError);
	note('payload =', result.content[0].text);
	assert.equal(result.isError, true);
	assert.match(JSON.parse(result.content[0].text).error.issues.join(' '), /unknown property "nonsense"/);
});

test('tools/call with a bad enum value -> isError', async () => {
	const result = await primary.client.callTool({ name: 'dsh_send_message', arguments: { session_id: 'session-x', text: 'hi', mode: 'teleport' } });
	note('payload =', result.content[0].text);
	assert.equal(result.isError, true);
	assert.match(JSON.parse(result.content[0].text).error.issues.join(' '), /must be one of queue \| steer/);
});

test('tools/call for an unknown tool name -> isError listing the real tools', async () => {
	const result = await primary.client.callTool({ name: 'dsh_no_such_tool', arguments: {} });
	note('payload (truncated) =', result.content[0].text.slice(0, 200));
	assert.equal(result.isError, true);
	const body = JSON.parse(result.content[0].text);
	assert.equal(body.error.kind, 'unknown-tool');
	assert.equal(body.error.available_tools.length, TOOL_SCHEMAS.length);
});

test('dsh_call is refused by default (--allow-raw-call is opt-in)', async () => {
	const result = await primary.client.callTool({ name: 'dsh_call', arguments: { method: 'session.list' } });
	note('payload =', result.content[0].text);
	assert.equal(result.isError, true);
	const body = JSON.parse(result.content[0].text);
	assert.equal(body.error.kind, 'raw-call-disabled');
	assert.match(body.hint, /--allow-raw-call/);
});

test('an unreachable DSH base surfaces as isError with kind=transport naming the base', async () => {
	const result = await dead.client.callTool({ name: 'dsh_host_info', arguments: {} });
	note('payload =', result.content[0].text);
	assert.equal(result.isError, true);
	const body = JSON.parse(result.content[0].text);
	assert.equal(body.error.kind, 'transport');
	assert.equal(body.error.base, DEAD_BASE);
	assert.equal(body.error.code, 'ECONNREFUSED');
	assert.match(body.error.message, /cannot reach DSH at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
	assert.equal(body.base_url, DEAD_BASE);
});

test('transport-level error text (stderr) stays off stdout: server logged the base it uses', async () => {
	const line = primary.stderrChunks.join('');
	note('server stderr =', line.trim());
	assert.match(line, /stdio transport ready/);
	assert.match(line, /DSH base http/);
});

test('streamable HTTP transport exposes the same surface and carries a real tools/call', async () => {
	const port = await pickFreePort();
	const child = await httpServerProcess(port, { DSH_BASE });
	note('healthz =', JSON.stringify(child.health));
	note('server stderr =', child.stderr().trim().split('\n').join('\n'));

	const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
	const client = new Client({ name: 'protocol-test-http', version: '1.0.0' });
	await client.connect(transport);
	try {
		const { tools } = await client.listTools();
		note(`HTTP tools/list returned ${tools.length} tools`);
		assert.deepEqual(
			tools.map((t) => t.name),
			TOOL_NAMES,
			'HTTP transport must expose the identical tool list',
		);

		// a real call through HTTP: same dispatch table, real DSH hop
		const info = await client.callTool({ name: 'dsh_host_info', arguments: {} });
		note('HTTP dsh_host_info =', info.content[0].text.replace(/\s+/g, ' ').slice(0, 240));
		assert.notEqual(info.isError, true);
		assert.equal(JSON.parse(info.content[0].text).base_url, DSH_BASE);

		// and the same structured error path works over HTTP too
		const bad = await client.callTool({ name: 'dsh_call', arguments: { method: 'session.list' } });
		note('HTTP dsh_call (disabled) isError =', bad.isError);
		assert.equal(bad.isError, true);
		assert.equal(JSON.parse(bad.content[0].text).error.kind, 'raw-call-disabled');
	} finally {
		await client.close();
		child.child.kill('SIGTERM');
	}
});

test('dsh_call works once --allow-raw-call is passed (opt-in path)', async () => {
	const opted = await stdioClient({ DSH_BASE, DSH_ALLOW_RAW_CALL: '1' }, 'raw-call-on');
	try {
		const result = await opted.client.callTool({ name: 'dsh_call', arguments: { method: 'host.describe', raw: true } });
		const body = JSON.parse(result.content[0].text);
		note('payload (truncated) =', JSON.stringify(body).slice(0, 400));
		assert.notEqual(result.isError, true);
		assert.equal(body.ok, true);
		assert.equal(body.method, 'host.describe');
		assert.equal(body.envelope.type, 'server-response');
		assert.ok(body.envelope.result.value.version, 'raw envelope must carry the host version');

		// a business error through the passthrough is reported, not thrown
		const bad = await opted.client.callTool({ name: 'dsh_call', arguments: { method: 'session.models', payload: { sessionId: 'session-does-not-exist' } } });
		const badBody = JSON.parse(bad.content[0].text);
		note('raw business error =', JSON.stringify(badBody).slice(0, 300));
		assert.equal(badBody.ok, false);
		assert.equal(badBody.error.code, 'session-not-found');
		note('config.dsh_call is advertised in tools/list even when disabled:', (await opted.client.listTools()).tools.some((t) => t.name === 'dsh_call'));
	} finally {
		await opted.client.close();
	}
});

test('--http-token protects the MCP endpoint when set', async () => {
	const port = await pickFreePort();
	const child = await httpServerProcess(port, { DSH_BASE, DSH_HTTP_TOKEN: 'sekret' });
	try {
		const unauth = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		note(`unauthenticated POST /mcp -> HTTP ${unauth.status}`);
		assert.equal(unauth.status, 401);

		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
			requestInit: { headers: { authorization: 'Bearer sekret' } },
		});
		const client = new Client({ name: 'protocol-test-http-auth', version: '1.0.0' });
		await client.connect(transport);
		const { tools } = await client.listTools();
		note(`authenticated tools/list -> ${tools.length} tools`);
		assert.equal(tools.length, TOOL_SCHEMAS.length);
		await client.close();
	} finally {
		child.child.kill('SIGTERM');
	}
});