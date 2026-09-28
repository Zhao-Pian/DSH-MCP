/**
 * `dsh_call` — raw /api passthrough.
 *
 * Gated by `--allow-raw-call` / `DSH_ALLOW_RAW_CALL=1`. Even when enabled it does NOT shell out and
 * cannot execute anything: the blast radius is exactly the DSH RPC surface, which is the same surface
 * the curated tools use. It exists so that a new DSH method can be driven before a curated tool lands.
 */
import { ToolError } from './support.js';

export const rawTools = {
	async dsh_call(ctx, args) {
		if (!ctx.config.allowRawCall) {
			throw new ToolError('dsh_call is disabled on this server instance', {
				code: 'raw-call-disabled',
				details: { method: args.method },
				hint: 'Restart the MCP server with --allow-raw-call (or DSH_ALLOW_RAW_CALL=1) to enable the raw /api passthrough. It is off by default because it bypasses every curated guard rail, including destructive-tool annotations and the selectModel warning.',
			});
		}
		const { envelope, status, attempts, elapsedMs } = await ctx.client.callEnvelope(args.method, args.payload, {
			timeoutMs: ctx.config.timeoutMs,
		});
		const base = { method: args.method, http_status: status, attempts, elapsed_ms: elapsedMs, base_url: ctx.client.base, ok: envelope.result.ok === true };
		if (args.raw) return { ...base, envelope };
		if (!envelope.result.ok) {
			return {
				...base,
				ok: false,
				error: {
					code: envelope.result.error?.code ?? 'unknown',
					message: envelope.result.error?.message ?? null,
					details: envelope.result.error?.details ?? null,
				},
			};
		}
		return { ...base, ok: true, value: envelope.result.value };
	},
};