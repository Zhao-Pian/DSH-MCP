/** session.* handlers: list / history / create / prompt / wait / dispatch / run / cancel / rename / fork / models. */
import { ToolError, findSession, localDirIssue, pendingEnvelope, readHistory, resolveWorkspace, sessionTitle, waitForSettle } from './support.js';

/** Create a session, resolving a workspace reference first when one was given. */
async function createSession(ctx, { workspace, cwd, session_id: sessionId, agent_preset: agentPreset }) {
	if (workspace && cwd) {
		throw new ToolError('pass either workspace or cwd, not both', {
			code: 'bad-request',
			hint: 'session.create accepts at most one of workspaceId and cwd.',
		});
	}
	const payload = {};
	if (sessionId) payload.sessionId = sessionId;
	if (agentPreset) payload.agentPreset = agentPreset;

	let workspaceInfo = null;
	if (workspace) {
		workspaceInfo = await resolveWorkspace(ctx, workspace);
		payload.workspaceId = workspaceInfo.workspaceId;
	} else if (cwd) {
		const issue = localDirIssue(ctx.client.base, cwd);
		if (issue) throw new ToolError(issue, { code: 'bad-directory', details: { cwd }, hint: 'The directory must exist on the DSH host before a session can use it as cwd.' });
		payload.cwd = cwd;
	}

	const created = await ctx.client.call('session.create', payload);
	return {
		session_id: created.sessionId,
		agent_preset: created.agentPreset ?? null,
		workspace: workspaceInfo,
		grouped: Boolean(workspaceInfo),
		...(workspaceInfo ? {} : { warning: cwd ? 'cwd-only creation yields an UNGROUPED session; no RPC can attach it to a workspace afterwards.' : undefined }),
	};
}

async function promptSession(ctx, sessionId, text, { mode = 'queue', clientTimeZone } = {}) {
	const receipt = await ctx.client.call('session.prompt', {
		sessionId,
		mode,
		content: [{ type: 'text', text }],
		...(clientTimeZone ? { clientTimeZone } : {}),
	});
	return receipt;
}

export const sessionTools = {
	async dsh_list_sessions(ctx, args) {
		const { items } = await ctx.client.call('session.list', {});
		let rows = items;
		if (args.cwd) rows = rows.filter((s) => s.cwd === args.cwd);
		if (args.running_only) rows = rows.filter((s) => s.running === true);
		const total = rows.length;
		const page = rows.slice(0, args.limit);
		const sessions = page.map((s) => ({
			session_id: s.sessionId,
			updated_at: s.updatedAt,
			running: s.running === true,
			blank: s.blank === true,
			cwd: s.cwd ?? null,
			parent_session_id: s.parentSessionId ?? null,
			origin: s.origin ?? null,
			agent_preset: s.agentPreset ?? null,
		}));
		if (args.include_titles) {
			for (const row of sessions) row.title = await sessionTitle(ctx, row.session_id);
		}
		return {
			total_matching: total,
			returned: sessions.length,
			total_sessions_on_host: items.length,
			filter: { cwd: args.cwd ?? null, running_only: args.running_only },
			sessions,
		};
	},

	async dsh_read_history(ctx, args) {
		return readHistory(ctx, args);
	},

	async dsh_session_overview(ctx, args) {
		const sessionId = args.session_id;
		const { items } = await ctx.client.call('session.list', {});
		const summary = items.find((s) => s.sessionId === sessionId) ?? null;
		const history = await readHistory(ctx, { session_id: sessionId, max: args.max, text_only: true });
		let models = null;
		try {
			const m = await ctx.client.call('session.models', { sessionId });
			models = { current: m.current, routable: m.routable, group_count: m.groups?.length ?? 0, failures: m.failures ?? [] };
		} catch (error) {
			models = { error: error.message, code: error.code ?? null };
		}
		return {
			session_id: sessionId,
			summary,
			title: history.title,
			models,
			history: {
				events_returned: history.events_returned,
				has_more: history.has_more,
				last_seq: history.last_seq,
				turns: history.turns,
				tool_calls: history.tool_calls,
				event_kinds: history.event_kinds,
				last_assistant_text: history.last_assistant_text,
			},
		};
	},

	async dsh_create_session(ctx, args) {
		return createSession(ctx, args);
	},

	async dsh_send_message(ctx, args) {
		const receipt = await promptSession(ctx, args.session_id, args.text, {
			mode: args.mode,
			clientTimeZone: args.client_time_zone,
		});
		return {
			accepted: receipt?.accepted === true,
			session_id: args.session_id,
			mode: args.mode,
			command: receipt?.command,
			hint: 'accepted=true means the message entered the session inbox; read the answer with dsh_wait_for_turn (blocking-ish) or dsh_read_history (peek).',
		};
	},

	async dsh_wait_for_turn(ctx, args) {
		// Baseline the session's updatedAt: an explicit baseline from dsh_dispatch_task, else sample now.
		// A change after the baseline proves the turn moved even if it started and ended between polls.
		const baseline = args.require_start
			? args.baseline_updated_at ?? (await findSession(ctx, args.session_id))?.updatedAt ?? null
			: null;
		const outcome = await waitForSettle(ctx, args.session_id, {
			timeoutMs: args.timeout_ms,
			pollIntervalMs: args.poll_interval_ms,
			requireStart: args.require_start,
			baselineUpdatedAt: baseline,
			startGraceMs: args.start_grace_ms,
		});
		const budget = args.timeout_ms ?? ctx.config.waitTimeoutMs;

		if (outcome.missing) {
			return {
				settled: false,
				timed_out: false,
				found: false,
				session_id: args.session_id,
				polls: outcome.polls,
				hint: outcome.hint,
			};
		}
		if (outcome.never_started) {
			return {
				settled: false,
				timed_out: false,
				never_started: true,
				session_id: args.session_id,
				polls: outcome.polls,
				running: false,
				waited_ms: args.start_grace_ms,
				last_assistant_text: outcome.historyProbe?.last_assistant_text ?? '',
				last_assistant_seq: outcome.historyProbe?.last_assistant_seq ?? null,
				hint: outcome.hint,
				next_call: { tool: 'dsh_wait_for_turn', arguments: { session_id: args.session_id, require_start: false, timeout_ms: budget } },
			};
		}
		if (!outcome.settled) {
			return pendingEnvelope(args.session_id, {
				timeoutMs: budget,
				extra: { polls: outcome.polls, running: outcome.running, saw_running: outcome.saw_running, waited_ms: budget },
			});
		}

		const history = await readHistory(ctx, { session_id: args.session_id, max: args.max, text_only: false });
		return {
			settled: true,
			running: false,
			timed_out: false,
			session_id: args.session_id,
			polls: outcome.polls,
			saw_running: outcome.saw_running,
			settle_detected_by: outcome.detected_by,
			title: history.title,
			turns: history.turns,
			tool_calls: history.tool_calls,
			event_kinds: history.event_kinds,
			last_assistant_text: history.last_assistant_text,
			last_seq: history.last_seq,
			history_has_more: history.has_more,
			summary: outcome.summary,
		};
	},

	async dsh_dispatch_task(ctx, args) {
		const created = await createSession(ctx, args);
		if (args.title) await ctx.client.call('session.rename', { sessionId: created.session_id, title: args.title });
		// baseline BEFORE the prompt, so the wait can prove the turn moved
		const baseline = (await findSession(ctx, created.session_id))?.updatedAt ?? null;
		const receipt = await promptSession(ctx, created.session_id, args.task, { mode: args.mode });
		const title = args.title ?? (await sessionTitle(ctx, created.session_id));
		return {
			dispatched: receipt?.accepted === true,
			session_id: created.session_id,
			workspace: created.workspace,
			grouped: created.grouped,
			title,
			mode: args.mode,
			baseline_updated_at: baseline,
			...(!created.grouped && created.warning ? { warning: created.warning } : {}),
			next_call: {
				tool: 'dsh_wait_for_turn',
				arguments: { session_id: created.session_id, timeout_ms: ctx.config.waitTimeoutMs, baseline_updated_at: baseline ?? undefined },
			},
			hint: 'Non-blocking by design: nothing is held open on the MCP side. Call the tool in `next_call` (possibly several times) until settled=true.',
		};
	},

	async dsh_run_task(ctx, args) {
		const created = await createSession(ctx, args);
		if (args.title) await ctx.client.call('session.rename', { sessionId: created.session_id, title: args.title });
		const baseline = (await findSession(ctx, created.session_id))?.updatedAt ?? null;
		await promptSession(ctx, created.session_id, args.task, { mode: 'queue' });
		const budget = args.timeout_ms ?? ctx.config.waitTimeoutMs;

		const outcome = await waitForSettle(ctx, created.session_id, {
			timeoutMs: budget,
			pollIntervalMs: args.poll_interval_ms,
			requireStart: true,
			baselineUpdatedAt: baseline,
		});
		if (!outcome.settled) {
			return pendingEnvelope(created.session_id, {
				timeoutMs: budget,
				extra: {
					dispatched: true,
					workspace: created.workspace,
					title: args.title ?? (await sessionTitle(ctx, created.session_id)),
					polls: outcome.polls,
					running: outcome.running,
					saw_running: outcome.saw_running,
				},
			});
		}
		const history = await readHistory(ctx, { session_id: created.session_id, max: 8, text_only: false });
		return {
			settled: true,
			timed_out: false,
			dispatched: true,
			session_id: created.session_id,
			workspace: created.workspace,
			grouped: created.grouped,
			title: args.title ?? history.title,
			polls: outcome.polls,
			saw_running: outcome.saw_running,
			settle_detected_by: outcome.detected_by,
			turns: history.turns,
			tool_calls: history.tool_calls,
			event_kinds: history.event_kinds,
			last_assistant_text: history.last_assistant_text,
			last_seq: history.last_seq,
		};
	},

	async dsh_cancel_turn(ctx, args) {
		const receipt = await ctx.client.call('session.cancel', { sessionId: args.session_id });
		return {
			accepted: receipt?.accepted === true,
			session_id: args.session_id,
			hint: 'Fire-and-return: accepted=true only means the request was received. Confirm idleness with dsh_wait_for_turn (require_start=false), or check dsh_list_sessions running.',
		};
	},

	async dsh_rename_session(ctx, args) {
		const value = await ctx.client.call('session.rename', { sessionId: args.session_id, title: args.title });
		return { session_id: args.session_id, title: value?.title ?? args.title, seq: value?.seq ?? null };
	},

	async dsh_fork_session(ctx, args) {
		const value = await ctx.client.call('session.fork', {
			sessionId: args.session_id,
			...(args.at_seq !== undefined ? { atSeq: args.at_seq } : {}),
		});
		return { forked_from: args.session_id, session_id: value?.sessionId, at_seq: args.at_seq ?? null };
	},

	async dsh_list_models(ctx, args) {
		const value = await ctx.client.call('session.models', { sessionId: args.session_id });
		const groups = (value.groups ?? []).map((g) => ({
			provider: g.provider ?? g.providerId ?? null,
			models: (g.models ?? []).map((m) => (typeof m === 'string' ? m : m?.model ?? m?.id ?? null)),
			routable: g.routable ?? null,
		}));
		return {
			session_id: args.session_id,
			current: value.current,
			routable: value.routable,
			group_count: groups.length,
			groups,
			failures: value.failures ?? [],
		};
	},

	async dsh_select_model(ctx, args) {
		const value = await ctx.client.call('session.selectModel', {
			sessionId: args.session_id,
			provider: args.provider,
			model: args.model,
			...(args.reasoning_effort ? { reasoningEffort: args.reasoning_effort } : {}),
		});
		return {
			session_id: args.session_id,
			selected: value?.selected ?? { provider: args.provider, model: args.model },
			global_side_effect: true,
			hint: 'WARNING: session.selectModel also persisted this choice as the DEPLOYMENT DEFAULT (agent-default-model) — other sessions created later will inherit it.',
		};
	},
};