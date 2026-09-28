#!/usr/bin/env node
/**
 * dsh-mcp entry point.
 *
 * ONE server implementation, TWO transports:
 *
 *   stdio (default)  — `new StdioServerTransport()`, how Claude Desktop / Cursor / DSH mount it.
 *   --http           — streamable HTTP on http://<host>:<port><path>, stateless mode, one
 *                      server+transport pair per request (the SDK's recommended stateless pattern).
 *
 * The transport choice happens in exactly one place (`startStdio` / `startHttp`), and both call the
 * same `createDshMcpServer()` + `buildRegistry()` pair — there is no second copy of any tool logic.
 *
 * stdout is protocol-only. Every log line goes to stderr.
 */
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DshClient } from './client.js';
import { HELP, ConfigError, redactedConfig, resolveConfig } from './config.js';
import { buildRegistry, callTool, listToolsResult } from './tools/index.js';
import { TOOL_NAMES } from './schema.js';

export const SERVER_INFO = { name: 'dsh-mcp', version: '0.1.0' };

function makeLogger(config) {
	return (level, message, meta) => {
		const line = `[dsh-mcp] ${level}: ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
		process.stderr.write(`${line}\n`);
	};
}

/**
 * Build the MCP server object. Transport-agnostic on purpose: the same instance shape is used by
 * stdio, by streamable HTTP and by the protocol test.
 */
export function createDshMcpServer(config, opts = {}) {
	const log = opts.logger ?? makeLogger(config);
	const client = opts.client ?? new DshClient(config, { logger: log });
	const ctx = { client, config, log };
	const registry = buildRegistry(ctx);

	const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: `Remote control for a DSH instance at ${client.base}. Use dsh_host_info first to confirm the target, then dsh_list_sessions / dsh_dispatch_task + dsh_wait_for_turn.` });

	// tools/list — straight from the single source of truth.
	server.setRequestHandler(ListToolsRequestSchema, async () => listToolsResult(registry));

	// tools/call — validation + dispatch both driven by that same array.
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params ?? {};
		return callTool(registry, name, args);
	});

	return { server, registry, client, config, log };
}

async function startStdio(config) {
	const log = makeLogger(config);
	const { server, registry } = createDshMcpServer(config, { logger: log });
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log('info', `stdio transport ready — ${registry.names.length} tools, DSH base ${config.base} (from ${config.sources.base})`);
	return { server, registry, close: () => server.close() };
}

async function startHttp(config) {
	const log = makeLogger(config);
	// fail fast with a clear message instead of a mysterious tool-level error later
	const probe = new DshClient(config, { logger: log });
	const status = await probe.probe();
	log(status.ok ? 'info' : 'warn', status.ok ? `DSH reachable at ${config.base}` : `DSH NOT reachable at ${config.base}: ${status.error?.message}`);

	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

		if (url.pathname === '/healthz') {
			const body = JSON.stringify({ ok: true, server: SERVER_INFO, tools: TOOL_NAMES.length, dsh_base: config.base, dsh: status });
			res.writeHead(200, { 'content-type': 'application/json' }).end(body);
			return;
		}
		if (url.pathname !== config.httpPath) {
			res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `not found; MCP endpoint is ${config.httpPath}` }));
			return;
		}
		if (config.httpToken) {
			const got = req.headers.authorization ?? '';
			if (got !== `Bearer ${config.httpToken}`) {
				res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(JSON.stringify({ error: 'unauthorized' }));
				return;
			}
		}

		// Stateless mode: a fresh server+transport pair per request keeps concurrent MCP clients isolated.
		const { server } = createDshMcpServer(config, { logger: log, client: probe });
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on('close', () => {
			transport.close().catch(() => {});
			server.close().catch(() => {});
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res);
		} catch (error) {
			log('error', `HTTP request failed: ${error?.message ?? error}`);
			if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error?.message ?? error) }));
		}
	});

	await new Promise((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(config.httpPort, config.httpHost, resolve);
	});
	const address = `http://${config.httpHost === '0.0.0.0' || config.httpHost === '::' ? '127.0.0.1' : config.httpHost}:${httpServer.address().port}${config.httpPath}`;
	log('info', `streamable HTTP transport ready — ${address} (${TOOL_NAMES.length} tools, DSH base ${config.base} from ${config.sources.base})`);
	if (config.httpHost !== '127.0.0.1' && config.httpHost !== 'localhost') {
		log('warn', `bound to ${config.httpHost}: the MCP endpoint is reachable from other hosts${config.httpToken ? '' : ' WITHOUT any token (--http-token is unset)'}. DSH itself has no auth layer.`);
	}
	return { httpServer, address, close: () => new Promise((r) => httpServer.close(r)) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	let config;
	try {
		config = resolveConfig(argv, env);
	} catch (error) {
		process.stderr.write(`[dsh-mcp] fatal: ${error.message}\n`);
		return 2;
	}
	if (config.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	if (config.version) {
		process.stdout.write(`${SERVER_INFO.name} ${SERVER_INFO.version}\n`);
		return 0;
	}
	if (config.printConfig) {
		process.stdout.write(`${JSON.stringify({ server: SERVER_INFO, tools: TOOL_NAMES.length, config: redactedConfig(config) }, null, 2)}\n`);
		return 0;
	}

	try {
		if (config.transport === 'http') await startHttp(config);
		else await startStdio(config);
		return 0;
	} catch (error) {
		process.stderr.write(`[dsh-mcp] fatal: ${error instanceof ConfigError ? error.message : (error?.stack ?? error)}\n`);
		return 1;
	}
}

// Run only when executed as the entry point. Comparing argv[1] to import.meta.url verbatim breaks under
// npm's bin symlinks and `npx`, where argv[1] is the link (node_modules/.bin/<name>) and import.meta.url is
// the resolved target — realpath both sides so both invocation styles agree.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
const invokedDirectly = entryPath && import.meta.url === pathToFileURL(entryPath).href;
if (invokedDirectly) {
	main().then(
		(code) => {
			if (code !== 0) process.exit(code);
		},
		(error) => {
			process.stderr.write(`[dsh-mcp] fatal: ${error?.stack ?? error}\n`);
			process.exit(1);
		},
	);
}