/** workspace.* handlers. */
import { ToolError, localDirIssue } from './support.js';

export const workspaceTools = {
	async dsh_list_workspaces(ctx) {
		const { items, archivedSessionIds } = await ctx.client.call('workspace.list', {});
		return {
			count: items.length,
			archived_session_count: archivedSessionIds?.length ?? 0,
			workspaces: items.map((w) => ({
				workspace_id: w.workspaceId,
				title: w.title,
				path: w.path,
				session_count: w.sessionIds?.length ?? 0,
				session_ids: w.sessionIds ?? [],
				created_at: w.createdAt,
				updated_at: w.updatedAt,
			})),
		};
	},

	async dsh_create_workspace(ctx, args) {
		const issue = localDirIssue(ctx.client.base, args.path);
		if (issue) {
			throw new ToolError(issue, {
				code: 'bad-directory',
				details: { path: args.path },
				hint: 'workspace.create never mkdirs: create the directory on the DSH host first (or let dsh_create_session / dsh_dispatch_task claim an existing one).',
			});
		}
		const { workspace, created } = await ctx.client.call('workspace.create', { path: args.path });
		return {
			created,
			already_registered: !created,
			workspace_id: workspace.workspaceId,
			path: workspace.path,
			title: workspace.title,
			session_ids: workspace.sessionIds ?? [],
			hint: created ? 'New workspace registered.' : 'The path was already registered — create is idempotent and nothing changed.',
		};
	},

	async dsh_archive_session(ctx, args) {
		const archived = await ctx.client.call('workspace.archiveSession', { sessionId: args.session_id });
		return {
			archived: true,
			session_id: args.session_id,
			archived_session_count: archived?.archivedSessionIds?.length ?? null,
			hint: 'Archiving is registration-level only: logs, attachments and the workspace ledger entry are untouched, and this cannot be undone through the RPC surface.',
		};
	},
};