/**
 * Shared helper layer for tool handlers.
 *
 * Everything here is transport-agnostic glue: it only ever talks to DSH through `ctx.client`
 * (the single HTTP entry point) and it never re-implements a tool's validation.
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

/** Concatenate the `text` blocks of a message content array (reasoning blocks are dropped). */
export function textOf(content) {
	const blocks = Array.isArray(content) ? content : [];
	return blocks
		.filter((b) => b?.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text)
		.join('\n');
}

/** Message-shaped events from either session.history or subagent.history (identical shape). */
function messageOf(event) {
	const message = event?.data?.message ?? event?.data;
	if (!message || typeof message !== 'object') return null;
	if (message.role !== 'user' && message.role !== 'assistant') return null;
	return message;
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
	for (const entry of page?.events ?? []) {
		const ev = entry.event;
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
 * Read history (session or subagent) and optionally flatten it to message text.
 * `observe` is exposed so the wait/run tools can reuse one implementation.
 */
export async function readHistory(ctx, args) {
	const { client } = ctx;
	const { session_id: sessionId, parent_session_id: parentSessionId, mode, max, before, text_only: textOnly } = args;
	const paged = { maxMessages: max, ...(before !== undefined ? { beforeSeq: before } : {}) };
	const sessionPayload = { sessionId, ...paged };

	let page;
	let method = 'session.history';
	let fallback = null;
	if (parentSessionId) {
		try {
			page = await client.call('subagent.history', { parentSessionId, childSessionId: sessionId, mode: mode ?? 'continuable', ...paged });
			method = 'subagent.history';
		} catch (error) {
			// Hard-won detail (measured against host 0.0.1): subagent.history only serves *continuable*
			// direct children. A one-shot child (the usual product of the `subagent` tool) answers
			// `subagent-not-found`, yet its transcript is perfectly readable through session.history
			// because both methods share readSessionState(). Child ids are bare uuids (no "session-"
			// prefix), so the same id works verbatim.
			if (error?.code !== 'subagent-not-found') throw error;
			page = await client.call('session.history', sessionPayload);
			fallback = { attempted: 'subagent.history', reason: error.code, message: error.message };
		}
	} else {
		page = await client.call('session.history', sessionPayload);
	}

	const summary = digest(page);
	const base = {
		session_id: sessionId,
		method,
		...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
		...(fallback ? { fallback } : {}),
		max_messages: max,
		before_seq: before ?? null,
		events_returned: page.events?.length ?? 0,
		has_more: page.hasMore ?? false,
		first_seq: page.events?.[0]?.event?.seq ?? null,
		last_seq: page.events?.at(-1)?.event?.seq ?? null,
		next_before: page.hasMore ? page.events?.[0]?.event?.seq ?? null : null,
		title: page.projections?.values?.title ?? null,
		as_of_seq: page.asOfSeq ?? page.projections?.asOfSeq ?? null,
		turns: summary.turns,
		tool_calls: summary.toolCalls,
		event_kinds: summary.kinds,
		last_assistant_text: summary.lastAssistantText,
	};
	if (!textOnly) return { ...base, events: page.events };
	return {
		...base,
		messages: [
			...(page.events ?? []).flatMap((entry) => {
				const message = messageOf(entry.event);
				if (!message) return [];
				const text = textOf(message.content);
				return text.trim() ? [{ seq: entry.event.seq, role: message.role, text }] : [];
			}),
		],
	};
}

/** session.list row for one session (the authoritative place where `running` lives). */
export async function findSession(ctx, sessionId) {
	const { items } = await ctx.client.call('session.list', {});
	return items.find((s) => s.sessionId === sessionId) ?? null;
}

export async function sessionTitle(ctx, sessionId) {
	try {
		const page = await ctx.client.call('session.history', { sessionId, maxMessages: 1 });
		return page.projections?.values?.title ?? null;
	} catch {
		return null;
	}
}

/**
 * Does the transcript already contain an assistant text produced *after* the last user text?
 * This is the tie-breaker for the race where a fast turn starts AND finishes between two polls:
 * `running` never reads true, but the answer is already on the surface.
 */
async function answerAfterLastUser(ctx, sessionId) {
	const page = await ctx.client.call('session.history', { sessionId, maxMessages: 10 });
	const summary = digest(page);
	const lastUser = summary.users.at(-1)?.seq ?? -1;
	const lastAssistant = summary.assistant.at(-1)?.seq ?? -1;
	return { answered: lastAssistant > lastUser, last_user_seq: lastUser, last_assistant_seq: lastAssistant, last_assistant_text: summary.lastAssistantText };
}

/**
 * Wait for a session's `running` flag to flip true -> false.
 *
 * `requireStart` means "a turn is expected to *start* after this call" (we just handed a task over).
 * Because a fast turn can begin and end between two polls, the settle condition is not just
 * `running === false`:
 *   settled  ⇐  !running && ( we saw running  ||  updatedAt advanced past the baseline
 *                            ||  the transcript already holds an assistant answer after the last user text )
 * When none of those hold inside `startGraceMs`, the message was never picked up and we report
 * `never_started` instead of pretending it settled (or of hanging until the budget runs out).
 *
 * Never throws on budget exhaustion — by design it returns a plain object.
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
			return { settled: false, timed_out: false, missing: true, polls, session_id: sessionId, hint: `session ${sessionId} is not in session.list (wrong id, or a subagent child — use dsh_list_subagents / parent_session_id).` };
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
					hint: `the session stayed idle and unchanged for ${startGraceMs} ms: the message does not look picked up yet (still queued, or the turn never started). Re-call with require_start=false to accept the current idle state, or peek with dsh_read_history.`,
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
 * Resolve a workspace reference (path or workspaceId) to a workspaceId, creating the registration
 * for a path that is not registered yet. Deliberately does NO client-side filesystem check: the DSH
 * host may be remote, so only the host can decide whether a directory exists.
 */
export async function resolveWorkspace(ctx, ref) {
	const { items } = await ctx.client.call('workspace.list', {});
	const byId = items.find((w) => w.workspaceId === ref);
	if (byId) return { workspaceId: byId.workspaceId, path: byId.path, created: false, matched: 'id' };

	const wanted = isAbsolute(ref) ? ref : resolvePath(ref);
	const byPath = items.find((w) => resolvePath(w.path) === wanted || w.path === ref);
	if (byPath) return { workspaceId: byPath.workspaceId, path: byPath.path, created: false, matched: 'path' };

	const { workspace, created } = await ctx.client.call('workspace.create', { path: wanted });
	return { workspaceId: workspace.workspaceId, path: workspace.path, created, matched: 'created' };
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

/** Poll helper for the interrupt tools: watch a subagent's activity until it goes inactive. */
export async function waitForSubagentInactive(ctx, parentSessionId, childSessionId, { timeoutMs = 15_000, pollIntervalMs = 1_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	for (;;) {
		const page = await ctx.client.call('subagent.list', { parentSessionId });
		last = (page.entries ?? []).find((e) => e.id === childSessionId) ?? null;
		if (!last || last.activity !== 'running') return { activity: last?.activity ?? 'absent', entry: last };
		if (Date.now() >= deadline) return { activity: 'running', entry: last };
		await delay(pollIntervalMs);
	}
}