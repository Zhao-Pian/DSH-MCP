/** host.* handlers. */
export const hostTools = {
	async dsh_host_info(ctx) {
		const value = await ctx.client.call('host.describe', {});
		return {
			base_url: ctx.client.base,
			base_url_source: ctx.config.sources?.base ?? 'unknown',
			...value,
		};
	},

	async dsh_ping(ctx) {
		const probe = await ctx.client.probe();
		return {
			...probe,
			timeout_ms: ctx.client.timeoutMs,
			retries: ctx.client.retries,
			hint: probe.ok ? 'DSH answered host.describe — the configured base URL is live.' : 'DSH did not answer: check --base / DSH_BASE, that the host is running, and that any reverse proxy is reachable.',
		};
	},
};