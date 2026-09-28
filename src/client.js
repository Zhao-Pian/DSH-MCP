/**
 * DSH `/api` transport — the ONLY place in this project that performs network I/O against DSH.
 *
 * Wire contract (see /root/.dsh/skills/dsh-agent-console/references/rpc-api.md §1):
 *
 *   POST <base>/api/<method>   content-type: application/json
 *   { "type":"client-request", "rpcId":<ours>, "method":<method>, "payload":{…} }
 *   -> { "type":"server-response", "rpcId":<echo>, "result":
 *          { "ok":true,  "value":{…} }
 *        | { "ok":false, "error":{ "code":…, "message":…, "details":{…} } } }
 *
 * Two rules that shape this file:
 *   1. **HTTP 200 can still be a business failure.** `result.error` is the real error channel and its
 *      `code` is a closed set (bad-request / session-not-found / agent-busy / model-unavailable / …).
 *      We surface it as `DshRpcError` with kind `rpc` and keep code/message/details verbatim.
 *   2. **Not every failure may be retried.** `session.prompt` is not idempotent, so a blind retry can
 *      double-send a task. Retries therefore only apply to (a) read-only methods, or (b) failures that
 *      provably happened before the request reached DSH (connection refused / DNS).
 */
import { setTimeout as delay } from 'node:timers/promises';

/** Methods that are pure reads: safe to retry after any transient failure. */
export const READ_ONLY_METHODS = new Set([
	'host.describe',
	'host.listDirectory',
	'session.list',
	'session.history',
	'session.models',
	'session.search',
	'session.attachment',
	'session.export',
	'workspace.list',
	'skill.list',
	'subagent.list',
	'subagent.history',
	'llm.providers',
	'llm.models',
	'llm.discoverModels',
	'settings.describe',
	'credentials.describe',
	'agentPreset.list',
	'agentPreset.read',
]);

/** Errors thrown before any byte reached the server → always safe to retry. */
const PRE_FLIGHT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Dig a Node errno out of a fetch failure. `fetch` wraps the real reason in `cause`, and Happy
 * Eyeballs failures arrive as an AggregateError whose `errors[]` holds the per-family attempt.
 */
function errorCode(cause) {
	let node = cause;
	for (let depth = 0; depth < 4 && node; depth++) {
		if (typeof node.code === 'string') return node.code;
		node = Array.isArray(node.errors) && node.errors.length ? node.errors[0] : node.cause;
	}
	return undefined;
}

/** Carrier statuses a reverse proxy emits when the upstream was never reached / is restarting. */
const RETRYABLE_STATUS = new Set([502, 503, 504, 429]);

export class DshRpcError extends Error {
	/**
	 * @param {object} o
	 * @param {string} o.kind    'rpc' | 'carrier' | 'transport' | 'timeout' | 'protocol'
	 * @param {string} o.method
	 * @param {string} [o.code]  DSH business error code (kind === 'rpc')
	 * @param {string} [o.message]
	 * @param {object} [o.details]
	 * @param {number} [o.status] HTTP status (kind === 'carrier')
	 * @param {string} [o.base]
	 * @param {boolean}[o.retryable]
	 */
	constructor({ kind, method, code, message, details, status, base, cause, retryable = false, preFlight = false }) {
		super(message ?? `${method} failed (${kind})`);
		this.name = 'DshRpcError';
		this.kind = kind;
		this.method = method;
		this.code = code;
		this.details = details;
		this.status = status;
		this.base = base;
		this.retryable = retryable;
		/** true when the failure provably happened before the request reached DSH */
		this.preFlight = preFlight;
		if (cause) this.cause = cause;
	}

	/** Stable, machine-readable shape handed to the MCP client. */
	toJSON() {
		return {
			error: {
				kind: this.kind,
				method: this.method,
				...(this.code ? { code: this.code } : {}),
				message: this.message,
				...(this.details !== undefined ? { details: this.details } : {}),
				...(this.status !== undefined ? { http_status: this.status } : {}),
				...(this.base ? { base: this.base } : {}),
			},
		};
	}

	/** Human line that always names the target — the #1 debugging question for a remote DSH. */
	toString() {
		const parts = [`[${this.kind}] ${this.method}`];
		if (this.code) parts.push(`code=${this.code}`);
		if (this.status) parts.push(`http=${this.status}`);
		parts.push(this.message);
		if (this.base) parts.push(`(base: ${this.base})`);
		return parts.join(' ');
	}
}

export class DshClient {
	/**
	 * @param {object} config resolved config from config.js
	 * @param {{logger?: (level:string, msg:string, meta?:object)=>void}} [opts]
	 */
	constructor(config, opts = {}) {
		if (!config?.base) throw new Error('DshClient requires a resolved config with a base URL');
		this.base = String(config.base).replace(/\/+$/, '');
		this.token = config.token ?? null;
		this.headers = { ...(config.headers ?? {}) };
		this.timeoutMs = config.timeoutMs ?? 30_000;
		this.retries = config.retries ?? 0;
		this.log = opts.logger ?? (() => {});
		this.rpcCounter = 0;
	}

	urlFor(method) {
		return `${this.base}/api/${method}`;
	}

	/** Headers for one request: JSON content type, optional bearer, optional custom headers. */
	requestHeaders() {
		const headers = { 'content-type': 'application/json', accept: 'application/json', ...this.headers };
		if (this.token && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
			headers.authorization = `Bearer ${this.token}`;
		}
		return headers;
	}

	/**
	 * Execute one RPC with timeout + bounded retry.
	 * @template T
	 * @returns {Promise<T>} `result.value`
	 */
	async call(method, payload = {}, opts = {}) {
		const envelope = await this.callEnvelope(method, payload, opts);
		const result = envelope.envelope.result;
		if (!result.ok) {
			throw new DshRpcError({
				kind: 'rpc',
				method,
				code: result.error?.code ?? 'unknown',
				message: result.error?.message ?? 'DSH reported a business error',
				details: result.error?.details,
				base: this.base,
			});
		}
		return result.value;
	}

	/**
	 * Lowest-level entry point: returns `{ envelope, status, attempts, elapsedMs }` and never throws
	 * for a business error — callers that want the raw `result.error` (the `dsh_call` passthrough) use this.
	 */
	async callEnvelope(method, payload = {}, opts = {}) {
		const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
		const maxRetries = opts.retries ?? this.retries;
		const retryableMethod = READ_ONLY_METHODS.has(method);
		let attempt = 0;

		for (;;) {
			attempt++;
			const started = Date.now();
			try {
				const { envelope, status } = await this.#once(method, payload, timeoutMs, opts.signal);
				return { envelope, status, attempts: attempt, elapsedMs: Date.now() - started };
			} catch (error) {
				const hasBudget = attempt <= maxRetries;
				const mayRetry = error.retryable && hasBudget && (retryableMethod || error.preFlight);
				if (!mayRetry) throw error;
				const backoff = Math.min(250 * 2 ** (attempt - 1), 2_000);
				this.log('warn', `${method}: attempt ${attempt} failed (${error.kind}), retrying in ${backoff}ms`, {
					code: error.code,
					status: error.status,
				});
				await delay(backoff);
			}
		}
	}

	async #once(method, payload, timeoutMs, outerSignal) {
		const rpcId = `mcp-${Date.now().toString(36)}-${++this.rpcCounter}`;
		const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		if (outerSignal) {
			if (outerSignal.aborted) onAbort();
			else outerSignal.addEventListener('abort', onAbort, { once: true });
		}

		let response;
		try {
			response = await fetch(this.urlFor(method), {
				method: 'POST',
				headers: this.requestHeaders(),
				body,
				signal: controller.signal,
				redirect: 'manual',
			});
		} catch (cause) {
			const code = errorCode(cause?.cause ?? cause);
			// fetch wraps the real reason one level down; "bad port"/"invalid URL" never left the process
			const reason = cause?.cause?.message ?? cause?.message ?? String(cause);
			const preFlight = PRE_FLIGHT_CODES.has(code) || /bad port|invalid url|invalid argument/i.test(reason);
			if (timedOut) {
				throw new DshRpcError({
					kind: 'timeout',
					method,
					base: this.base,
					retryable: true,
					preFlight: false,
					cause,
					message: `timed out after ${timeoutMs} ms waiting for ${method} (base: ${this.base}). Raise --timeout-ms / DSH_TIMEOUT_MS if the target DSH is slow.`,
				});
			}
			throw new DshRpcError({
				kind: 'transport',
				method,
				base: this.base,
				cause,
				preFlight,
				retryable: true,
				code,
				message: preFlight
					? `cannot reach DSH at ${this.base} (${code ?? reason}): is the host running and is --base correct?`
					: `network failure calling ${method} at ${this.base}: ${reason}`,
			});
		} finally {
			clearTimeout(timer);
			if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
		}

		const text = await response.text();
		if (!response.ok) {
			throw new DshRpcError({
				kind: 'carrier',
				method,
				status: response.status,
				base: this.base,
				code: `http-${response.status}`,
				retryable: RETRYABLE_STATUS.has(response.status),
				preFlight: false,
				message: `HTTP ${response.status} from ${this.urlFor(method)}: ${text.slice(0, 300) || '<empty body>'}`,
			});
		}

		let envelope;
		try {
			envelope = JSON.parse(text);
		} catch (cause) {
			throw new DshRpcError({
				kind: 'protocol',
				method,
				status: response.status,
				base: this.base,
				cause,
				preFlight: false,
				message: `${this.urlFor(method)} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
			});
		}
		if (envelope?.type !== 'server-response') {
			throw new DshRpcError({
				kind: 'protocol',
				method,
				status: response.status,
				base: this.base,
				preFlight: false,
				message: `unexpected envelope type "${envelope?.type}" for ${method} (expected "server-response")`,
			});
		}
		if (envelope.rpcId !== rpcId) {
			this.log('warn', `${method}: rpcId mismatch (sent ${rpcId}, got ${envelope.rpcId})`);
		}
		if (!envelope.result || typeof envelope.result.ok !== 'boolean') {
			throw new DshRpcError({
				kind: 'protocol',
				method,
				base: this.base,
				preFlight: false,
				message: `malformed result for ${method}: ${text.slice(0, 200)}`,
			});
		}
		return { envelope, status: response.status };
	}

	/** Cheap liveness probe used by tools/tests: never throws, always reports the base it used. */
	async probe({ timeoutMs } = {}) {
		const started = Date.now();
		try {
			const value = await this.call('host.describe', {}, { timeoutMs: timeoutMs ?? Math.min(this.timeoutMs, 10_000) });
			return { ok: true, base: this.base, elapsedMs: Date.now() - started, value };
		} catch (error) {
			return {
				ok: false,
				base: this.base,
				elapsedMs: Date.now() - started,
				error: error instanceof DshRpcError ? error.toJSON().error : { kind: 'unknown', message: String(error?.message ?? error) },
			};
		}
	}
}