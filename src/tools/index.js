/**
 * The dispatch table.
 *
 * ONE array (schema.js `TOOL_SCHEMAS`) + ONE handler map (the domain modules below) are merged here
 * into the registry that drives BOTH `tools/list` and `tools/call`. Nothing about a tool is written
 * twice: if a schema has no handler, or a handler has no schema, `buildRegistry` throws at startup.
 */
import { TOOL_SCHEMAS, ToolInputError, publicTools, validateToolArgs } from '../schema.js';
import { DshRpcError } from '../client.js';
import { ToolError } from './support.js';
import { hostTools } from './host.js';
import { sessionTools } from './session.js';
import { subagentTools } from './subagent.js';
import { workspaceTools } from './workspace.js';
import { rawTools } from './raw.js';

/** name -> async (ctx, args) => payload  (payload is serialized into the MCP tool result) */
export const HANDLERS = Object.freeze({
	...hostTools,
	...sessionTools,
	...workspaceTools,
	...subagentTools,
	...rawTools,
});

/**
 * @param {{client: import('../client.js').DshClient, config: object, log?: Function}} ctx
 */
export function buildRegistry(ctx) {
	const byName = new Map();
	for (const schema of TOOL_SCHEMAS) {
		const run = HANDLERS[schema.name];
		if (typeof run !== 'function') throw new Error(`schema declares "${schema.name}" but no handler is registered`);
		byName.set(schema.name, schema.name);
	}
	const orphans = Object.keys(HANDLERS).filter((name) => !byName.has(name));
	if (orphans.length) throw new Error(`handlers without a schema entry: ${orphans.join(', ')}`);

	return {
		ctx,
		tools: publicTools(),
		names: TOOL_SCHEMAS.map((t) => t.name),
		/** the dispatch table itself: name -> tool view */
		byName: new Map(TOOL_SCHEMAS.map((t) => [t.name, t])),
	};
}

/** MCP `tools/list` result — generated from the same array the dispatcher uses. */
export function listToolsResult(registry) {
	return { tools: registry.tools };
}

function textResult(payload, { isError = false, meta } = {}) {
	const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
	const result = { content: [{ type: 'text', text }], isError };
	if (!isError && payload && typeof payload === 'object' && !Array.isArray(payload)) {
		result.structuredContent = payload;
	}
	if (meta) result._meta = meta;
	return result;
}

/** Turn any thrown thing into a structured `isError: true` MCP result (never a protocol-level crash). */
function errorResult(error, name, ctx) {
	const base = { base_url: ctx?.client?.base ?? null, tool: name };
	if (error instanceof ToolInputError) {
		return textResult({ ...base, ok: false, error: { kind: 'invalid-arguments', message: error.message, issues: error.issues } }, { isError: true });
	}
	if (error instanceof ToolError) {
		return textResult(
			{
				...base,
				ok: false,
				error: { kind: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
				...(error.hint ? { hint: error.hint } : {}),
			},
			{ isError: true },
		);
	}
	if (error instanceof DshRpcError) {
		const { error: body } = error.toJSON();
		const hint =
			body.code === 'subagent-not-found'
				? 'The child is not a *continuable* direct child: subagent.prompt rejects one-shot children (subagent.interrupt is still accepted). Reading is no problem — dsh_read_subagent_history automatically falls back to session.history.'
				: body.kind === 'rpc'
					? `DSH rejected the call with code "${body.code}" — this is a business error carried on an HTTP 200 response; the payload above is verbatim.`
					: body.kind === 'timeout'
						? 'The RPC itself timed out. Wait-style tools accept timeout_ms and never error on budget exhaustion; this timeout is the per-call limit (--timeout-ms).'
						: 'Carrier-level failure: the DSH host was not reached. Check --base / DSH_BASE and that the host is running.';
		return textResult(
			{
				...base,
				ok: false,
				error: body,
				hint,
			},
			{ isError: true },
		);
	}
	return textResult(
		{ ...base, ok: false, error: { kind: 'internal', message: String(error?.message ?? error), stack: error?.stack?.split('\n').slice(0, 4) } },
		{ isError: true },
	);
}

/**
 * MCP `tools/call` — validate from the schema, dispatch through the table, always answer.
 * @returns {Promise<{content: Array<{type:'text',text:string}>, isError?: boolean, structuredContent?: object}>}
 */
export async function callTool(registry, name, rawArgs, opts = {}) {
	const started = Date.now();
	const ctx = registry.ctx;
	if (!registry.byName.has(name)) {
		return textResult(
			{
				ok: false,
				error: { kind: 'unknown-tool', message: `unknown tool "${name}"`, available_tools: registry.names },
			},
			{ isError: true },
		);
	}
	const validation = validateToolArgs(name, rawArgs);
	if (!validation.ok) return errorResult(new ToolInputError(name, validation.issues), name, ctx);

	try {
		const payload = await HANDLERS[name](ctx, validation.value, opts);
		const meta = { 'dsh/baseUrl': ctx?.client?.base, 'dsh/elapsedMs': Date.now() - started, 'dsh/tool': name };
		return textResult(payload, { meta });
	} catch (error) {
		ctx?.log?.('warn', `${name} failed: ${error?.message ?? error}`);
		return errorResult(error, name, ctx);
	}
}