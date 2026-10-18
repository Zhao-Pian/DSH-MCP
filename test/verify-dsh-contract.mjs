/**
 * Verify that every endpoint this MCP server calls still exists in the latest DSH source tree.
 *
 * DSH 0.2.x exposes Typert Remote methods through `@Remote` decorators on service classes. This
 * script parses those decorators (name override or method name) and checks the namespace + method
 * pairs used by src/tools/*. It also checks the unary wire envelope (`payload.args`) at its source.
 *
 *   DSH_SRC=/path/to/deepseek-harness node test/verify-dsh-contract.mjs
 *
 * Exits non-zero on any drift, so CI catches an interface change before the tools do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DSH_SRC = process.env.DSH_SRC ?? '/tmp/dsh-src';

/** namespace -> service source file (relative to DSH_SRC). */
const NAMESPACE_FILES = {
	session: 'packages/api/session-controller/src/index.ts',
	workspace: 'packages/api/workspace-controller/src/index.ts',
	subagents: 'packages/subagent/subagent/src/index.ts',
};

/** endpoint -> namespace */
const ENDPOINTS = [
	'session/list',
	'session/create',
	'session/prompt',
	'session/cancel',
	'session/rename',
	'session/fork',
	'session/selectModel',
	'session/modelCatalog',
	'session/canOpenWorkspacePath',
	'session/projections',
	'session/page',
	'workspace/create',
	'workspace/archiveSession',
	'workspace/follow',
	'subagents/prompt',
	'subagents/interruptByParent',
];

if (!existsSync(DSH_SRC)) {
	console.error(`[contract] DSH source not found at ${DSH_SRC}; set DSH_SRC to a deepseek-harness checkout.`);
	process.exit(2);
}

/**
 * Extract the remote-exposed method names of one service source file.
 * Supports `@Remote('name')`, `@Remote({ name: 'name', … })`, bare `@Remote`, and
 * `@Remote({ mode: 'stream' })` (which keeps the method name).
 */
function exposedMethods(source) {
	const exposed = new Set();
	const decorator = /@Remote(?:\(([^)]*)\))?\s*\n\s*(?:async\s+)?(?:\*\s*)?([A-Za-z0-9_]+)\s*\(/g;
	for (const match of source.matchAll(decorator)) {
		const args = match[1] ?? '';
		const method = match[2];
		const named = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(args);
		if (named) {
			exposed.add(named[1]);
			continue;
		}
		const positional = /^\s*['"]([^'"]+)['"]/.exec(args);
		exposed.add(positional ? positional[1] : method);
	}
	return exposed;
}

let failed = 0;
for (const [namespace, file] of Object.entries(NAMESPACE_FILES)) {
	const path = join(DSH_SRC, file);
	if (!existsSync(path)) {
		console.error(`[contract] missing service file for namespace "${namespace}": ${file}`);
		failed++;
		continue;
	}
	const source = readFileSync(path, 'utf8');
	if (!new RegExp(`namespace: '${namespace}'`).test(source) && !source.includes(`super(ctx, '${namespace}')`)) {
		console.error(`[contract] ${file} no longer declares namespace "${namespace}"`);
		failed++;
	}
	const methods = exposedMethods(source);
	console.log(`[contract] ${namespace}: ${[...methods].sort().join(', ')}`);
	for (const endpoint of ENDPOINTS.filter((value) => value.startsWith(`${namespace}/`))) {
		const method = endpoint.slice(namespace.length + 1);
		if (!methods.has(method)) {
			console.error(`[contract] MISSING ${endpoint} (not decorated with @Remote in ${file})`);
			failed++;
		} else {
			console.log(`[contract] ok ${endpoint}`);
		}
	}
}

// Unary envelope: the gateway requires exactly one plain-object `args` field in `payload`.
const gateway = readFileSync(join(DSH_SRC, 'packages/api/gateway/src/index.ts'), 'utf8');
if (!gateway.includes("Object.hasOwn(payload, 'args')")) {
	console.error('[contract] gateway no longer unwraps payload.args');
	failed++;
} else {
	console.log('[contract] ok unary envelope payload.args');
}

const connection = readFileSync(join(DSH_SRC, 'packages/client/connection/src/rpc.ts'), 'utf8');
for (const token of ["type: 'client-request'", "type: 'server-response'", 'readonly payload']) {
	if (!connection.includes(token)) {
		console.error(`[contract] connection rpc.ts lost ${JSON.stringify(token)}`);
		failed++;
	}
}
if (failed === 0) console.log('[contract] all endpoints match the latest DSH source');
process.exit(failed === 0 ? 0 : 1);
