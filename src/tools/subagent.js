/** subagent.* handlers — adapted to the 0.2.x Typert Remote interface. */
import { randomUUID } from 'node:crypto';
import { readHistory, sessionProjections, waitForSubagentInactive } from './support.js';

export const subagentTools = {
	async dsh_list_subagents(ctx, args) {
		// 0.2.x materializes the direct-child catalogue as the parent's `subagentCatalog` projection.
		let projections = null;
		try {
			projections = await sessionProjections(ctx, args.parent_session_id);
		} catch {
			projections = null;
		}
		const catalog = projections?.values?.subagentCatalog ?? [];
		return {
			parent_session_id: args.parent_session_id,
			parent_available: projections !== null,
			count: catalog.length,
			entries: catalog.map((entry) => ({
				kind: 'child',
				session_id: entry.id,
				created_at: entry.createdAt,
				mode: entry.mode,
				label: entry.label ?? null,
				/** `subagents/prompt` accepts only continuable children; interrupt requires the same mode. */
				promptable: entry.mode === 'continuable',
				interruptible: entry.mode === 'continuable',
				readable_via: 'dsh_read_subagent_history',
			})),
			hint:
				'Child ids from the subagentCatalog projection are bare session ids — pass them verbatim with parent_session_id. Only continuable children accept subagent.prompt/interrupt; every child transcript is readable.',
			...(projections === null ? { warning: 'the parent Session has no projections (unknown id, or the host does not hold it).' } : {}),
		};
	},

	async dsh_message_subagent(ctx, args) {
		const value = await ctx.client.call('subagents/prompt', {
			request: {
				requestId: randomUUID(),
				parentSessionId: args.parent_session_id,
				childSessionId: args.child_session_id,
				mode: 'continuable',
				delivery: args.mode === 'steer' ? 'steer' : 'queue',
				content: [{ type: 'text', text: args.text }],
			},
		});
		return {
			delivered: true,
			message_id: value?.messageId ?? null,
			parent_session_id: args.parent_session_id,
			child_session_id: args.child_session_id,
			mode: args.mode,
			hint: 'Read the answer with dsh_read_subagent_history (parent_session_id + session_id = child). session/prompt would be rejected for a child session — that is why this tool exists.',
		};
	},

	async dsh_interrupt_subagent(ctx, args) {
		const receipt = await ctx.client.call('subagents/interruptByParent', {
			childSessionId: args.child_session_id,
			parentSessionId: args.parent_session_id,
			mode: 'continuable',
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
			hint: 'Fire-and-return. Pass wait_ms to also watch the child session flip running -> idle; otherwise re-check with dsh_list_subagents / dsh_list_sessions.',
		};
	},

	async dsh_read_subagent_history(ctx, args) {
		return readHistory(ctx, args);
	},
};
