/**
 * SINGLE SOURCE OF TRUTH for the MCP tool surface.
 *
 * `TOOL_SCHEMAS` is the only place where a tool's name, description, JSON Schema and default values
 * are written down. Consequences that are enforced by `tools/index.js` at startup:
 *
 *   • `tools/list` is generated from this array,
 *   • `tools/call` dispatches through a table built from this same array,
 *   • argument validation + default application read the same schemas (so a default is declared once),
 *   • a schema without a handler, or a handler without a schema, is a fatal startup error.
 *
 * Defaults live in the JSON Schema (`default:`), validation lives in `validateToolArgs`.
 * Method names/payloads follow /root/.dsh/skills/dsh-agent-console/references/rpc-api.md.
 */

/** @typedef {{type:string,[k:string]:unknown}} JsonSchema */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });

const SESSION_ID = str('DSH session id, e.g. "session-1d91a912-32de-41bd-937f-95002ca37bf0".');

const PAGE_ARGS = {
	max: int('How many events to return from the history tail (default 20, max 500).', {
		default: 20,
		minimum: 1,
		maximum: 500,
	}),
	before: int('Return the page that ends *before* this seq (backwards paging). Omit for the newest page.', {
		minimum: 0,
	}),
	text_only: bool('Keep only user/assistant message text instead of raw event objects (default true).', { default: true }),
};

/** Non-blocking-by-design polling knobs shared by the wait-style tools. */
const WAIT_ARGS = {
	timeout_ms: int('How long to watch for the turn to settle before returning "still running" (default from DSH_WAIT_TIMEOUT_MS).', {
		minimum: 0,
	}),
	poll_interval_ms: int('Poll cadence for the running flag (default from DSH_POLL_INTERVAL_MS).', { minimum: 200 }),
	require_start: bool(
		'Wait for running=true first (true: the turn has not started yet; false: the turn already settled).',
		{ default: true },
	),
	start_grace_ms: int(
		'If require_start=true and the session stays idle/unchanged this long, report never_started instead of waiting out the whole budget (default 10000).',
		{ default: 10_000, minimum: 0 },
	),
	baseline_updated_at: int(
		'Optional updatedAt baseline (as returned by dsh_dispatch_task) that proves the turn moved. Defaults to the session updatedAt sampled at call time.',
		{ minimum: 0 },
	),
};

/**
 * @type {Array<{
 *   name: string,
 *   title: string,
 *   description: string,
 *   group: string,
 *   annotations: {readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean},
 *   inputSchema: {type:'object', properties: Record<string, JsonSchema>, required?: string[], additionalProperties?: boolean},
 * }>}
 */
export const TOOL_SCHEMAS = [
	// ---------------------------------------------------------------- host
	{
		name: 'dsh_host_info',
		title: 'DSH host info',
		group: 'host',
		description:
			'Describe the target DSH host (version, cwd, provider, model, number of attached sessions). Also returns the base URL actually in use, so a misconfigured --base is visible immediately.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'dsh_ping',
		title: 'Ping the DSH host',
		group: 'host',
		description:
			'Liveness probe: returns whether the configured DSH base URL answers, how long it took, and the exact error when it does not.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},

	// ---------------------------------------------------------------- sessions
	{
		name: 'dsh_list_sessions',
		title: 'List DSH sessions',
		group: 'sessions',
		description:
			'List sessions known to the host (newest first), optionally filtered by working directory. Set include_titles=true to resolve titles (costs one history call per listed session).',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				cwd: str('Only sessions whose cwd equals this path, e.g. "/path/to/project".'),
				limit: int('Maximum number of sessions to return (default 20, max 200).', { default: 20, minimum: 1, maximum: 200 }),
				running_only: bool('Only sessions with an active turn (default false).', { default: false }),
				include_titles: bool('Resolve each session title from its history projection (default false).', { default: false }),
			},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_read_history',
		title: 'Read session history',
		group: 'sessions',
		description:
			'Read event-level history of a session (or of a subagent session via parent_session_id). Supports backwards paging with `before`. Reading history never wakes the agent.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				session_id: SESSION_ID,
				parent_session_id: str('Parent session id — set this (with session_id = the child id) to read a subagent transcript.'),
				mode: { type: 'string', enum: ['continuable'], description: 'Subagent access mode (only "continuable" exists today).' },
				...PAGE_ARGS,
			},
			required: ['session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_session_overview',
		title: 'Session overview',
		group: 'sessions',
		description:
			'One-stop overview of a session: its summary row (running/blank/cwd/parent), its title, the current model and a compact event histogram.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: { session_id: SESSION_ID, max: PAGE_ARGS.max },
			required: ['session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_create_session',
		title: 'Create session',
		group: 'sessions',
		description:
			'Create a session. Pass `workspace` (a path that is already registered, or a workspaceId) to make it show up inside that workspace — `cwd` alone creates an UNGROUPED session that no RPC can attach to a workspace afterwards.',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				workspace: str('Workspace path (e.g. "/path/to/project") or workspaceId. Creates the workspace if the path is not registered yet.'),
				cwd: str('Working directory for an ungrouped session. Mutually exclusive with workspace.'),
				session_id: str('Optional explicit session id to claim.'),
				agent_preset: str('Optional agent preset name.'),
			},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_send_message',
		title: 'Send message to session',
		group: 'sessions',
		description:
			'Post a user message into a session\'s inbox (session.prompt). mode="queue" starts the next turn once the current one settles; mode="steer" injects into the running turn. This is the core "make the other AI do work" primitive.',
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				session_id: SESSION_ID,
				text: str('The message text to deliver.'),
				mode: { type: 'string', enum: ['queue', 'steer'], description: 'Delivery mode (default "queue").', default: 'queue' },
				client_time_zone: str('Optional IANA time zone reported to the target agent, e.g. "Asia/Shanghai".'),
			},
			required: ['session_id', 'text'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_wait_for_turn',
		title: 'Wait for a turn to settle',
		group: 'sessions',
		description:
			'Watch a session\'s `running` flag until the turn settles, then return the last assistant text. NEVER fails on timeout: it returns settled=false plus a ready-to-call continuation hint.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				session_id: SESSION_ID,
				...WAIT_ARGS,
				max: int('How many trailing events to scan for the final assistant text (default 8).', { default: 8, minimum: 1, maximum: 100 }),
			},
			required: ['session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_dispatch_task',
		title: 'Dispatch a task (non-blocking)',
		group: 'sessions',
		description:
			'Create a session (optionally inside a workspace) and deliver a task to it, then return immediately with the session id. Poll it with dsh_wait_for_turn — the combination is how long jobs are orchestrated without holding an MCP request open.',
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				task: str('The task text handed to the new session.'),
				workspace: str('Workspace path or workspaceId to create the session in.'),
				cwd: str('Working directory for an ungrouped session (mutually exclusive with workspace).'),
				title: str('Optional title to pin on the new session right away.'),
				mode: { type: 'string', enum: ['queue', 'steer'], description: 'Delivery mode (default "queue").', default: 'queue' },
			},
			required: ['task'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_run_task',
		title: 'Dispatch a task and wait',
		group: 'sessions',
		description:
			'Convenience combination of dsh_dispatch_task + dsh_wait_for_turn with a hard budget. On budget exhaustion it returns the session id and a continuation hint instead of an error, so the caller can keep waiting later.',
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				task: str('The task text handed to the new session.'),
				workspace: str('Workspace path or workspaceId to create the session in.'),
				cwd: str('Working directory for an ungrouped session (mutually exclusive with workspace).'),
				title: str('Optional title to pin on the new session right away.'),
				timeout_ms: WAIT_ARGS.timeout_ms,
				poll_interval_ms: WAIT_ARGS.poll_interval_ms,
			},
			required: ['task'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_cancel_turn',
		title: 'Cancel the running turn',
		group: 'sessions',
		description:
			'Interrupt the current turn of a session (queued messages survive). Fire-and-return: {accepted:true} means the request was accepted, not that the agent is already idle — re-check with dsh_wait_for_turn.',
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: { session_id: SESSION_ID },
			required: ['session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_rename_session',
		title: 'Rename a session',
		group: 'sessions',
		description: 'Pin a title on a session (overrides the auto-generated title).',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: { session_id: SESSION_ID, title: str('New title (non-empty).') },
			required: ['session_id', 'title'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_fork_session',
		title: 'Fork a session',
		group: 'sessions',
		description:
			'Fork a session after a completed turn (session.fork). `at_seq` maps to the first turn/end at or after that seq; a still-open turn makes this fail with fork-unavailable.',
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				session_id: SESSION_ID,
				at_seq: int('Fork position (seq). Omit to fork the whole session.', { minimum: 0 }),
			},
			required: ['session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_archive_session',
		title: 'Archive a session',
		group: 'sessions',
		description:
			'Hide a session from every grouped view (workspace.archiveSession). There is no session.delete in DSH: logs and attachments are always preserved. Use this to clean up test sessions.',
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: { session_id: SESSION_ID },
			required: ['session_id'],
			additionalProperties: false,
		},
	},

	// ---------------------------------------------------------------- models
	{
		name: 'dsh_list_models',
		title: 'List models for a session',
		group: 'models',
		description:
			'List the current model plus every routable provider/model for a session, its provider groups and the per-entry failures.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: { session_id: SESSION_ID },
			required: ['session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_select_model',
		title: 'Select a model (GLOBAL side effect)',
		group: 'models',
		description:
			'Switch the model of a session. WARNING: session.selectModel also writes the DEPLOYMENT DEFAULT model (agent-default-model), so this affects other sessions too, not just the one you pass. Provider/model must come from dsh_list_models.',
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				session_id: SESSION_ID,
				provider: str('Provider id, e.g. "local-gateway".'),
				model: str('Model id, e.g. "deepseek-ai/DeepSeek-V4.1-Flash".'),
				reasoning_effort: str('Optional reasoning effort, e.g. "low" / "medium" / "high".'),
			},
			required: ['session_id', 'provider', 'model'],
			additionalProperties: false,
		},
	},

	// ---------------------------------------------------------------- workspaces
	{
		name: 'dsh_list_workspaces',
		title: 'List workspaces',
		group: 'workspaces',
		description: 'List the workspace ledger (workspaceId, path, title, accounted session ids) plus the count of archived sessions.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'dsh_create_workspace',
		title: 'Create / claim a workspace',
		group: 'workspaces',
		description:
			'Register a directory as a workspace (workspace.create). The directory MUST already exist — no mkdir happens. Idempotent: an already-registered path returns created=false.',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: { path: str('Absolute path of an existing directory, e.g. "/path/to/project".') },
			required: ['path'],
			additionalProperties: false,
		},
	},

	// ---------------------------------------------------------------- subagents
	{
		name: 'dsh_list_subagents',
		title: 'List subagents',
		group: 'subagents',
		description: 'List the direct children of a session (subagent.list): id, activity, mode, whether they have children, plus diagnostics for unreadable ones.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: { parent_session_id: str('The parent (owning) session id.') },
			required: ['parent_session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_message_subagent',
		title: 'Message a subagent',
		group: 'subagents',
		description:
			'Send a message to a continuable subagent (subagent.prompt — session.prompt is rejected with agent-busy for child sessions). Returns the delivery receipt (messageId).',
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				parent_session_id: str('The parent (owning) session id.'),
				child_session_id: str('The subagent session id.'),
				text: str('Message text (delivered as a single text content block).'),
				mode: { type: 'string', enum: ['continuable'], description: 'Access mode (default/only "continuable").', default: 'continuable' },
			},
			required: ['parent_session_id', 'child_session_id', 'text'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_interrupt_subagent',
		title: 'Interrupt a subagent',
		group: 'subagents',
		description: 'Interrupt a subagent\'s current turn (subagent.interrupt). Fire-and-return: re-check activity with dsh_list_subagents, or pass wait_ms to have this call watch the flip for you.',
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				parent_session_id: str('The parent (owning) session id.'),
				child_session_id: str('The subagent session id.'),
				mode: { type: 'string', enum: ['continuable'], description: 'Access mode (default/only "continuable").', default: 'continuable' },
				wait_ms: int('Optionally watch subagent activity until it leaves "running" (0 = return immediately).', {
					default: 0,
					minimum: 0,
					maximum: 120_000,
				}),
			},
			required: ['parent_session_id', 'child_session_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'dsh_read_subagent_history',
		title: 'Read subagent history',
		group: 'subagents',
		description: 'Read a subagent transcript (subagent.history) with the same paging/flattening options as dsh_read_history.',
		annotations: { readOnlyHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				parent_session_id: str('The parent (owning) session id.'),
				session_id: str('The subagent (child) session id.'),
				mode: { type: 'string', enum: ['continuable'], description: 'Access mode (default/only "continuable").', default: 'continuable' },
				...PAGE_ARGS,
			},
			required: ['parent_session_id', 'session_id'],
			additionalProperties: false,
		},
	},

	// ---------------------------------------------------------------- raw passthrough (opt-in)
	{
		name: 'dsh_call',
		title: 'Raw /api passthrough (opt-in)',
		group: 'raw',
		description:
			'DANGEROUS / OPT-IN: call any DSH /api method with an arbitrary payload, bypassing the curated tools. Only exposed when the server was started with --allow-raw-call (or DSH_ALLOW_RAW_CALL=1). Business errors are returned as isError payloads with the original code/details.',
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		inputSchema: {
			type: 'object',
			properties: {
				method: str('DSH RPC method, e.g. "session.list".'),
				payload: {
					type: 'object',
					description: 'Payload object for the method (default {}).',
					default: {},
				},
				raw: bool('Return the whole envelope (carrier status + echo + result) instead of just result (default false).', {
					default: false,
				}),
			},
			required: ['method'],
			additionalProperties: false,
		},
	},
];

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.name);

/** The array as the client should see it: no handler, no internal fields. */
export function publicTools() {
	return TOOL_SCHEMAS.map(({ name, title, description, inputSchema, annotations }) => ({
		name,
		title,
		description,
		inputSchema,
		annotations,
	}));
}

export class ToolInputError extends Error {
	/** @param {string[]} issues */
	constructor(tool, issues) {
		super(`invalid arguments for ${tool}: ${issues.join('; ')}`);
		this.name = 'ToolInputError';
		this.tool = tool;
		this.issues = issues;
	}
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate raw arguments against a tool's inputSchema; also the place where JSON-Schema `default`
 * values are applied — so a declared default can never drift from the behavior.
 * @returns {{ok:true, value:Record<string,unknown>} | {ok:false, issues:string[]}}
 */
export function validateToolArgs(name, args) {
	const schema = TOOL_SCHEMAS.find((t) => t.name === name);
	if (!schema) return { ok: false, issues: [`unknown tool "${name}"`] };
	const input = args === undefined || args === null ? {} : args;
	if (!isPlainObject(input)) return { ok: false, issues: ['arguments must be a JSON object'] };

	const { properties = {}, required = [], additionalProperties } = schema.inputSchema;
	const issues = [];

	for (const key of required) {
		if (input[key] === undefined || input[key] === null) issues.push(`missing required property "${key}"`);
	}
	if (additionalProperties === false) {
		for (const key of Object.keys(input)) {
			if (!(key in properties)) issues.push(`unknown property "${key}" (accepted: ${Object.keys(properties).join(', ') || 'none'})`);
		}
	}

	const value = {};
	for (const [key, spec] of Object.entries(properties)) {
		let v = input[key];
		if (v === undefined || v === null) {
			if ('default' in spec && v === undefined) value[key] = structuredClone(spec.default);
			continue;
		}
		switch (spec.type) {
			case 'string':
				if (typeof v !== 'string') issues.push(`"${key}" must be a string`);
				else if (spec.enum && !spec.enum.includes(v)) issues.push(`"${key}" must be one of ${spec.enum.join(' | ')}`);
				else value[key] = v;
				break;
			case 'boolean':
				if (typeof v !== 'boolean') issues.push(`"${key}" must be a boolean`);
				else value[key] = v;
				break;
			case 'integer': {
				if (typeof v !== 'number' || !Number.isInteger(v)) {
					issues.push(`"${key}" must be an integer`);
					break;
				}
				if (spec.minimum !== undefined && v < spec.minimum) issues.push(`"${key}" must be >= ${spec.minimum}`);
				else if (spec.maximum !== undefined && v > spec.maximum) issues.push(`"${key}" must be <= ${spec.maximum}`);
				else value[key] = v;
				break;
			}
			case 'object':
				if (!isPlainObject(v)) issues.push(`"${key}" must be an object`);
				else value[key] = v;
				break;
			default:
				value[key] = v;
		}
	}
	return issues.length ? { ok: false, issues } : { ok: true, value };
}