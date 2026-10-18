/** host.* handlers — adapted to the 0.2.x Typert Remote interface. */

export const hostTools = {
	async dsh_host_info(ctx) {
		// 0.2.x has no `host.describe`: compose the same facts from the session + model surfaces.
		const [{ items }, catalog, canOpenPath] = await Promise.all([
			ctx.client.call('session/list', { request: {} }),
			ctx.client.call('session/modelCatalog', {}).catch(() => null),
			ctx.client.call('session/canOpenWorkspacePath', {}).catch(() => null),
		]);
		return {
			base_url: ctx.client.base,
			base_url_source: ctx.config.sources?.base ?? 'unknown',
			// The Typert Remote surface deliberately exposes no host-version endpoint.
			version: null,
			api: 'typert-remote',
			cwd: items[0]?.cwd ?? null,
			provider: catalog?.default?.provider ?? null,
			model: catalog?.default?.model ?? null,
			attachedSessions: items.length,
			canOpenPath: canOpenPath === true,
		};
	},

	async dsh_ping(ctx) {
		const probe = await ctx.client.probe();
		return {
			...probe,
			timeout_ms: ctx.client.timeoutMs,
			retries: ctx.client.retries,
			hint: probe.ok
				? 'DSH answered session/list — the configured base URL is live.'
				: 'DSH did not answer: check --base / DSH_BASE, that the host is running, and that any reverse proxy is reachable.',
		};
	},
};
