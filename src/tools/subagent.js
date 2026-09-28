/** subagent.* handlers. */
import { readHistory, waitForSubagentInactive } from './support.js';

export const subagentTools = {
	async dsh_list_subagents(ctx, args) {
		const page = await ctx.client.call('subagent.list', { parentSessionId: args.parent_session_id });
		return {
			parent_session_id: args.parent_session_id,
			parent_available: page.parentAvailable === true,
			count: (page.entries ?? []).length,
			entries: (page.entries ?? []).map((e) =>
				e.kind === 'child'
					? {
							kind: 'child',
							session_id: e.id,
							activity: e.activity,
							has_children: e.hasChildren === true,
							mode: e.mode,
							label: e.label ?? null,
							/** which tool can read this child's transcript (see README §7.5) */
							readable_via: 'dsh_read_subagent_history (one-shot children fall back to session.history)',
							/** subagent.prompt is refused for one-shot children; subagent.interrupt is not */
							promptable: e.mode === 'continuable',
							interruptible: true,
						}
					: { kind: 'diagnostic', session_id: e.id, reason: e.reason },
			),
			hint:
				'Child ids from subagent.list are bare uuids (no "session-" prefix) — pass them verbatim. Only continuable children accept subagent.prompt; subagent.interrupt is accepted for one-shot children too, and every child transcript is readable (one-shot children via the session.history fallback).',
			...(page.parentAvailable === false ? { warning: 'parentAvailable=false: the host no longer holds this parent session in its registry.' } : {}),
		};
	},

	async dsh_message_subagent(ctx, args) {
		const value = await ctx.client.call('subagent.prompt', {
			parentSessionId: args.parent_session_id,
			childSessionId: args.child_session_id,
			mode: args.mode,
			content: [{ type: 'text', text: args.text }],
		});
		return {
			delivered: true,
			message_id: value?.messageId ?? null,
			parent_session_id: args.parent_session_id,
			child_session_id: args.child_session_id,
			mode: args.mode,
			hint: 'Read the answer with dsh_read_history (session_id = child, parent_session_id = parent). session.prompt would be rejected with agent-busy for a child session — that is why this tool exists.',
		};
	},

	async dsh_interrupt_subagent(ctx, args) {
		const receipt = await ctx.client.call('subagent.interrupt', {
			parentSessionId: args.parent_session_id,
			childSessionId: args.child_session_id,
			mode: args.mode,
		});
		const observed = args.wait_ms
			? await waitForSubagentInactive(ctx, args.parent_session_id, args.child_session_id, { timeoutMs: args.wait_ms })
			: null;
		return {
			accepted: receipt?.accepted === true,
			parent_session_id: args.parent_session_id,
			child_session_id: args.child_session_id,
			observed_activity: observed?.activity ?? null,
			observed_entry: observed?.entry ?? null,
			hint: 'Fire-and-return. Pass wait_ms to also watch activity flip running -> inactive; otherwise re-check with dsh_list_subagents.',
		};
	},

	async dsh_read_subagent_history(ctx, args) {
		return readHistory(ctx, args);
	},
};