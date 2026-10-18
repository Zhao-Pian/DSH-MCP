/**
 * Shared helper layer for tool handlers (DSH 0.2.x Typert Remote).
 *
 * Transport-agnostic glue: it only talks to DSH through `ctx.client` and never re-implements a
 * tool's validation. Event/page shapes follow `packages/api/session-controller/src/types.ts`:
 * `session/page` returns `{records:[{type:'event', event}], hasMore}`, and durable messages are
 * `user/message` (data is the message) and `assistant/message` (data.message is the message).
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Tool-level failure that is not a DSH RPC error (bad input, local validation, disabled feature). */
export class ToolError extends Error {
	constructor(message, { code = 'tool-error', details, hint } = {}) {
		super(message);
		this.name = 'ToolError';
		this.code = code;
		this.details = details;
		this.hint = hint;
	}
}

/** Concatenate the `text` blocks of a message content array (reasoning/tool blocks are dropped). */
export function textOf(content) {
	const blocks = Array.isArray(content) ? content : [];
	return blocks
		.filter((b) => b?.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text)
		.join('\n');
}

/** Message-shaped event from a session/page record (`user/message`, `assistant/message`, or legacy). */
function messageOf(event) {
	if (!event || typeof event !== 'object') return null;
	if (event.type === 'user/message') {
		const message = event.data;
		return message && message.role === 'user' ? message : null;
	}
	if (event.type === 'assistant/message') {
		const message = event.data?.message;
		return message && message.role === 'assistant' ? message : null;
	}
	const message = event?.data?.message ?? event?.data;
	if (!message || typeof message !== 'object') return null;
	if (message.role !== 'user' && message.role !== 'assistant') return null;
	return message;
}

/** Normalize a page (new `records` or legacy `events`) to a flat array of SessionEvent objects. */
export function eventsOf(page) {
	if (Array.isArray(page?.records)) return page.records.map((record) => record?.event ?? record).filter(Boolean);
	return (page?.events ?? []).map((entry) => entry?.event ?? entry).filter(Boolean);
}

/**
 * Compact digest of a history page. `turns` counts turn/end events, `toolCalls` counts tool/call
 * events, and `lastAssistantText` is the newest assistant text block.
 */
export function digest(page) {
	const kinds = {};
	const assistant = [];
	const users = [];
	let toolCalls = 0;
	for (const ev of eventsOf(page)) {
		kinds[ev.type] = (kinds[ev.type] ?? 0) + 1;
		if (ev.type === 'tool/call') toolCalls++;
		const message = messageOf(ev);
		if (!message) continue;
		const text = textOf(message.content);
		if (!text.trim()) continue;
		if (message.role === 'assistant') assistant.push({ seq: ev.seq, text });
		else users.push({ seq: ev.seq, text });
	}
	return {
		kinds,
		turns: kinds['turn/end'] ?? 0,
		toolCalls,
		lastAssistantText: assistant.at(-1)?.text ?? '',
		assistant,
		users,
	};
}

/**
 * Build the durable `SessionAddress` for an ordinary session or one direct subagent child.
 */
export function sessionAddress({ session_id: sessionId, parent_session_id: parentSessionId, mode }) {
	return parentSessionId
		? { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: mode ?? 'continuable' }
		: { kind: 'session', sessionId };
}

/** Cursor (`asOfSeq`) of the latest projected event for one session; 0 when unknown. */
async function sessionCursor(ctx, sessionId) {
	try {
		const projections = await ctx.client.call('session/projections', { request: { sessionId } });
		return { projections, cursor: typeof projections?.asOfSeq === 'number' ? projections.asOfSeq : 0 };
	} catch {
		return { projections: null, cursor: 0 };
	}
}

/**
 * Read history (session or subagent) via `session/page` and optionally flatten it to message text.
 */
export async function readHistory(ctx, args) {
	const { client } = ctx;
	const { session_id: sessionId, parent_session_id: parentSessionId, max, before, text_only: textOnly } = args;
	const address = sessionAddress(args);
	const { projections, cursor } = await sessionCursor(ctx, sessionId);
	const request = {
		address,
		throughSeq: cursor,
		maxMessages: max,
		...(before !== undefined ? { beforeSeq: before } : {}),
	};

	let page;
	let method = 'session/page';
	let fallback = null;
	try {
		page = await client.call('session/page', { request });
	} catch (error) {
		// An empty session has no event at throughSeq; the Host answers gateway/bad-request.
		if (error?.code === 'gateway/bad-request' && /past cursor|through seq/i.test(error?.message ?? '')) {
			page = { records: [], hasMore: false };
		} else if (parentSessionId) {
			// A one-shot/unknown child may refuse the subagent address; fall back to the child's own log.
			const sessionRequest = { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages: max, ...(before !== undefined ? { beforeSeq: before } : {}) };
			try {
				page = await client.call('session/page', { request: sessionRequest });
				fallback = { attempted: 'session/page (subagent address)', reason: error?.code ?? 'error', message: error?.message ?? String(error) };
			} catch (again) {
				throw error?.code ? error : again;
			}
		} else {
			throw error;
		}
	}

	const events = eventsOf(page);
	const summary = digest(page);
	const title = projections?.values?.title ?? (await sessionTitle(ctx, sessionId));
	const base = {
		session_id: sessionId,
		method,
		...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
		...(fallback ? { fallback } : {}),
		max_messages: max,
		before_seq: before ?? null,
		events_returned: events.length,
		has_more: page.hasMore ?? false,
		first_seq: events[0]?.seq ?? null,
		last_seq: events.at(-1)?.seq ?? null,
		next_before: page.hasMore ? events[0]?.seq ?? null : null,
		title: title ?? null,
		as_of_seq: projections?.asOfSeq ?? null,
		turns: summary.turns,
		tool_calls: summary.toolCalls,
		event_kinds: summary.kinds,
		last_assistant_text: summary.lastAssistantText,
	};
	if (!textOnly) return { ...base, events: page.records ?? events };
	return {
		...base,
		messages: events.flatMap((ev) => {
			const message = messageOf(ev);
			if (!message) return [];
			const text = textOf(message.content);
			return text.trim() ? [{ seq: ev.seq, role: message.role, text }] : [];
		}),
	};
}

/** session/list row for one session (the authoritative place where `running` lives). */
export async function findSession(ctx, sessionId) {
	const { items } = await ctx.client.call('session/list', { request: {} });
	return items.find((s) => s.sessionId === sessionId) ?? null;
}

/** Exact projections of one session (`{kind, asOfSeq, values}` or null). */
export function sessionProjections(ctx, sessionId) {
	return ctx.client.call('session/projections', { request: { sessionId } });
}

export async function sessionTitle(ctx, sessionId) {
	try {
		const summary = await findSession(ctx, sessionId);
		const hinted = summary?.projections?.values?.title;
		if (hinted !== undefined) return hinted ?? null;
		const projections = await sessionProjections(ctx, sessionId);
		return projections?.values?.title ?? null;
	} catch {
		return null;
	}
}

/** Does the transcript already contain an assistant text produced after the last user text? */
async function answerAfterLastUser(ctx, sessionId) {
	const page = await ctx.client.call('session/page', {
		request: { address: { kind: 'session', sessionId }, throughSeq: (await sessionCursor(ctx, sessionId)).cursor, maxMessages: 10 },
	});
	const summary = digest(page);
	const lastUser = summary.users.at(-1)?.seq ?? -1;
	const lastAssistant = summary.assistant.at(-1)?.seq ?? -1;
	return { answered: lastAssistant > lastUser, last_user_seq: lastUser, last_assistant_seq: lastAssistant, last_assistant_text: summary.lastAssistantText };
}

/**
 * Wait for a session's `running` flag to flip true -> false.
 *
 * Settled ⇐ `!running && (we saw running || updatedAt advanced past the baseline || the transcript
 * already holds an assistant answer after the last user text)`. Never throws on budget exhaustion.
 */
export async function waitForSettle(ctx, sessionId, { timeoutMs, pollIntervalMs, requireStart = true, baselineUpdatedAt = null, startGraceMs = 10_000 } = {}) {
	const budget = timeoutMs ?? ctx.config.waitTimeoutMs;
	const interval = pollIntervalMs ?? ctx.config.pollIntervalMs;
	const startedAt = Date.now();
	const deadline = startedAt + budget;
	const graceDeadline = startedAt + Math.min(startGraceMs, budget);
	let polls = 0;
	let sawRunning = false;
	let moved = false;
	let summary = null;
	let historyProbe = null;

	for (;;) {
		polls++;
		summary = await findSession(ctx, sessionId);
		if (!summary) {
			return { settled: false, timed_out: false, missing: true, polls, session_id: sessionId, hint: `session ${sessionId} is not in session/list (wrong id, or a subagent child — use dsh_list_subagents / parent_session_id).` };
		}
		if (baselineUpdatedAt !== null && (summary.updatedAt ?? 0) > baselineUpdatedAt) moved = true;
		if (summary.running) {
			sawRunning = true;
			ctx.log?.('info', `turn started (${sessionId})`);
		}

		if (!summary.running) {
			if (sawRunning || moved || !requireStart) {
				return { settled: true, running: false, timed_out: false, polls, saw_running: sawRunning, moved, detected_by: sawRunning ? 'running-flag' : moved ? 'updatedAt' : 'require_start=false', summary };
			}
			historyProbe = await answerAfterLastUser(ctx, sessionId);
			if (historyProbe.answered) {
				return { settled: true, running: false, timed_out: false, polls, saw_running: sawRunning, moved, detected_by: 'history-tail', summary, historyProbe };
			}
			if (Date.now() >= graceDeadline) {
				return {
					settled: false,
					timed_out: false,
					never_started: true,
					running: false,
					polls,
					saw_running: false,
					summary,
					historyProbe,
					hint: `session stayed idle and unchanged for ${startGraceMs} ms: the message does not look picked up yet (still queued, or the turn never started). Re-call with require_start=false to accept the current idle state, or peek with dsh_read_history.`,
				};
			}
		}

		if (Date.now() >= deadline) {
			return { settled: false, timed_out: true, running: summary.running === true, polls, saw_running: sawRunning, moved, summary, historyProbe };
		}
		await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
	}
}

/** The "not finished yet, keep waiting" envelope — a result, not an error. */
export function pendingEnvelope(sessionId, { timeoutMs, extra = {} } = {}) {
	return {
		settled: false,
		timed_out: true,
		still_running: true,
		session_id: sessionId,
		...extra,
		hint: `not finished yet: the turn is still running (or has not started). Call dsh_wait_for_turn again with session_id="${sessionId}" to keep waiting, or dsh_read_history to peek at progress.`,
		next_call: { tool: 'dsh_wait_for_turn', arguments: { session_id: sessionId, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}), require_start: false } },
	};
}

/**
 * Resolve a workspace reference (path or workspaceId) to a workspaceId.
 *
 * `workspace/create` is idempotent: for a registered path it returns the existing row with
 * `created:false`, so one call resolves or creates without needing the `workspace/follow` stream.
 * A non-path reference is treated as an opaque workspaceId.
 */
export async function resolveWorkspace(ctx, ref) {
	const looksLikeId = /^workspace[-_]/i.test(ref) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(ref);
	if (looksLikeId) return { workspaceId: ref, path: null, created: false, matched: 'id' };
	const wanted = isAbsolute(ref) ? ref : resolvePath(ref);
	const { workspace, created } = await ctx.client.call('workspace/create', { request: { path: wanted } });
	return { workspaceId: workspace.workspaceId, path: workspace.path, created, matched: created ? 'created' : 'path' };
}

/**
 * Read the complete workspace registry.
 *
 * Preferred source: the opening `baseline` frame of the `workspace/follow` stream (the only place
 * `archivedSessionIds` / `pinnedSessionIds` live). If the runtime has no WebSocket (Node < 22), we
 * derive the active workspaces from the distinct `cwd`s in `session/list` via idempotent
 * `workspace/create` calls; archived ids are then unavailable.
 */
export async function listWorkspaces(ctx) {
	try {
		const frame = await ctx.client.firstStreamItem('workspace/follow', {}, { timeoutMs: Math.min(ctx.client.timeoutMs, 5_000) });
		const baseline = frame?.type === 'baseline' ? frame.value : frame;
		if (baseline && Array.isArray(baseline.items)) {
			return {
				items: baseline.items,
				archivedSessionIds: baseline.archivedSessionIds ?? [],
				pinnedSessionIds: baseline.pinnedSessionIds ?? [],
				source: 'workspace/follow',
			};
		}
	} catch {
		/* fall through to derivation */
	}
	const { items } = await ctx.client.call('session/list', { request: {} });
	const byCwd = new Map();
	for (const session of items) {
		if (typeof session.cwd !== 'string' || session.cwd.length === 0) continue;
		const row = byCwd.get(session.cwd) ?? { workspaceId: null, title: session.cwd, path: session.cwd, sessionIds: [], createdAt: null, updatedAt: null };
		row.sessionIds.push(session.sessionId);
		byCwd.set(session.cwd, row);
	}
	// Derivation is read-only: it never registers a workspace as a side effect of listing.
	return { items: [...byCwd.values()], archivedSessionIds: [], pinnedSessionIds: [], source: 'derived-from-cwd' };
}

/** True when the configured base points at the machine this process runs on. */
export function isLocalBase(base) {
	try {
		const host = new URL(base).hostname;
		return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
	} catch {
		return false;
	}
}

/** Best-effort existence check used only for *local* bases, to produce a nicer error message. */
export function localDirIssue(base, dir) {
	if (!isLocalBase(base)) return null;
	try {
		if (!existsSync(dir)) return `directory does not exist on the DSH host: ${dir}`;
		if (!statSync(dir).isDirectory()) return `not a directory: ${dir}`;
	} catch (error) {
		return `cannot stat ${dir}: ${error.message}`;
	}
	return null;
}

/**
 * Poll helper for the interrupt tools: watch a child's session `running` flag until it goes idle.
 * The child catalogue comes from the parent's `subagentCatalog` projection.
 */
export async function waitForSubagentInactive(ctx, parentSessionId, childSessionId, { timeoutMs = 15_000, pollIntervalMs = 1_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	for (;;) {
		const projections = await sessionProjections(ctx, parentSessionId).catch(() => null);
		last = (projections?.values?.subagentCatalog ?? []).find((e) => e.id === childSessionId) ?? null;
		const child = await findSession(ctx, childSessionId).catch(() => null);
		if (!last) return { activity: 'absent', entry: null };
		if (child && child.running === false) return { activity: 'inactive', entry: last };
		if (Date.now() >= deadline) return { activity: child?.running ? 'running' : 'unknown', entry: last };
		await delay(pollIntervalMs);
	}
}
