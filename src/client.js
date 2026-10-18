/**
 * DSH `/api` transport for the **0.2.x Typert Remote** interface.
 *
 * Wire contract (packages/client/connection/src/rpc.ts + packages/api/gateway/src/index.ts):
 *
 *   POST <base>/api/<namespace>/<method>        content-type: application/json
 *   { "type":"client-request", "rpcId":<ours>, "method":"<namespace>/<method>",
 *     "payload": { "args": { …named parameters… } } }
 *   -> { "type":"server-response", "rpcId":<echo>, "result":
 *          { "ok":true,  "value":{…} }
 *        | { "ok":false, "error":{ "code":…, "message":…, "details":{…} } } }
 *
 * Two rules that shape this file:
 *   1. **HTTP 200 can still be a business failure.** `result.error` is the real error channel;
 *      we surface it as `DshRpcError` with kind `rpc` and keep code/message/details verbatim.
 *   2. **Not every failure may be retried.** Prompts are not idempotent, so retries only apply to
 *      read-only endpoints, or to failures that provably happened before the request reached DSH.
 *
 * Streaming endpoints (`workspace/follow`, `session/follow`, `session/control`) use the Gateway
 * WebSocket mux at `/api/remote.mux`; `openStream` implements the small JSON message protocol from
 * `packages/api/gateway/src/stream-protocol.ts`.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

/** Endpoints that are pure reads: safe to retry after any transient failure. */
export const READ_ONLY_ENDPOINTS = new Set([
	'session/list',
	'session/page',
	'session/projections',
	'session/modelCatalog',
	'session/search',
	'session/canOpenWorkspacePath',
	'session/workspaceDesktop',
	'session/attachment',
	'workspace/follow',
	'skills/list',
]);

/** Errors thrown before any byte reached the server → always safe to retry. */
const PRE_FLIGHT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/** Carrier statuses a reverse proxy emits when the upstream was never reached / is restarting. */
const RETRYABLE_STATUS = new Set([502, 503, 504, 429]);

/** Dig a Node errno out of a fetch failure. */
function errorCode(cause) {
	let node = cause;
	for (let depth = 0; depth < 4 && node; depth++) {
		if (typeof node.code === 'string') return node.code;
		node = Array.isArray(node.errors) && node.errors.length ? node.errors[0] : node.cause;
	}
	return undefined;
}

export class DshRpcError extends Error {
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
		this.preFlight = preFlight;
		if (cause !== undefined) this.cause = cause;
	}

	/** Wire-safe projection (used verbatim by the MCP error result and by `dsh_call`). */
	toJSON() {
		return {
			ok: false,
			error: {
				kind: this.kind,
				method: this.method,
				...(this.code !== undefined ? { code: this.code } : {}),
				...(this.message !== undefined ? { message: this.message } : {}),
				...(this.details !== undefined ? { details: this.details } : {}),
				...(this.base !== undefined ? { base: this.base } : {}),
				...(this.status !== undefined ? { http_status: this.status } : {}),
			},
		};
	}

	/** Human line that always names the target. */
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

	/** Absolute endpoint URL: `<base>/api/<namespace>/<method>`. */
	urlFor(endpoint) {
		return `${this.base}/api/${endpoint}`;
	}

	/** Stream mux URL (`/api/remote.mux`, ws/wss). */
	streamUrl() {
		const url = new URL(this.base);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/remote.mux`;
		return url.toString();
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
	 * @param {string} endpoint e.g. "session/list"
	 * @param {object} args named wire parameters, e.g. { request: { … } }
	 * @returns {Promise<any>} `result.value`
	 */
	async call(endpoint, args = {}, opts = {}) {
		const envelope = await this.callEnvelope(endpoint, args, opts);
		const result = envelope.envelope.result;
		if (!result.ok) {
			throw new DshRpcError({
				kind: 'rpc',
				method: endpoint,
				code: result.error?.code ?? 'unknown',
				message: result.error?.message ?? 'DSH reported a business error',
				details: result.error?.details,
				base: this.base,
			});
		}
		return result.value;
	}

	/**
	 * Lowest-level unary entry point: returns `{ envelope, status, attempts, elapsedMs }`
	 * and never throws for a business error (the raw `dsh_call` passthrough uses this).
	 */
	async callEnvelope(endpoint, args = {}, opts = {}) {
		const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
		const maxRetries = opts.retries ?? this.retries;
		const retryableEndpoint = READ_ONLY_ENDPOINTS.has(endpoint);
		let attempt = 0;

		for (;;) {
			attempt++;
			const started = Date.now();
			try {
				const { envelope, status } = await this.#once(endpoint, args, timeoutMs, opts.signal);
				return { envelope, status, attempts: attempt, elapsedMs: Date.now() - started };
			} catch (error) {
				const hasBudget = attempt <= maxRetries;
				const mayRetry = error.retryable && hasBudget && (retryableEndpoint || error.preFlight);
				if (!mayRetry) throw error;
				const backoff = Math.min(250 * 2 ** (attempt - 1), 2_000);
				this.log('warn', `${endpoint}: attempt ${attempt} failed (${error.kind}), retrying in ${backoff}ms`, {
					code: error.code,
					status: error.status,
				});
				await delay(backoff);
			}
		}
	}

	async #once(endpoint, args, timeoutMs, outerSignal) {
		const rpcId = `mcp-${Date.now().toString(36)}-${++this.rpcCounter}`;
		const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: args ?? {} } });
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		let response;
		try {
			response = await fetch(this.urlFor(endpoint), {
				method: 'POST',
				headers: this.requestHeaders(),
				body,
				signal: controller.signal,
				redirect: 'manual',
			});
		} catch (cause) {
			const code = errorCode(cause?.cause ?? cause);
			const reason = cause?.cause?.message ?? cause?.message ?? String(cause);
			const preFlight = PRE_FLIGHT_CODES.has(code) || /bad port|invalid url|invalid argument/i.test(reason);
			if (timedOut) {
				throw new DshRpcError({
					kind: 'timeout',
					method: endpoint,
					base: this.base,
					retryable: true,
					preFlight: false,
					cause,
					message: `timed out after ${timeoutMs} ms waiting for ${endpoint} (base: ${this.base}). Raise --timeout-ms / DSH_TIMEOUT_MS if the target DSH is slow.`,
				});
			}
			throw new DshRpcError({
				kind: 'transport',
				method: endpoint,
				base: this.base,
				cause,
				preFlight,
				retryable: true,
				code,
				message: preFlight
					? `cannot reach DSH at ${this.base} (${code ?? reason}): is the host running and is --base correct?`
					: `network failure calling ${endpoint} at ${this.base}: ${reason}`,
			});
		} finally {
			clearTimeout(timer);
		}

		const text = await response.text();
		if (!response.ok) {
			throw new DshRpcError({
				kind: 'carrier',
				method: endpoint,
				status: response.status,
				base: this.base,
				code: `http-${response.status}`,
				retryable: RETRYABLE_STATUS.has(response.status),
				preFlight: false,
				message: `HTTP ${response.status} from ${this.urlFor(endpoint)}: ${text.slice(0, 300) || '<empty body>'}`,
			});
		}

		let envelope;
		try {
			envelope = JSON.parse(text);
		} catch (cause) {
			throw new DshRpcError({
				kind: 'protocol',
				method: endpoint,
				status: response.status,
				base: this.base,
				cause,
				preFlight: false,
				message: `${this.urlFor(endpoint)} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
			});
		}
		if (envelope?.type !== 'server-response') {
			throw new DshRpcError({
				kind: 'protocol',
				method: endpoint,
				status: response.status,
				base: this.base,
				preFlight: false,
				message: `unexpected envelope type "${envelope?.type}" for ${endpoint} (expected "server-response")`,
			});
		}
		if (envelope.rpcId !== rpcId) {
			this.log('warn', `${endpoint}: rpcId mismatch (sent ${rpcId}, got ${envelope.rpcId})`);
		}
		if (!envelope.result || typeof envelope.result.ok !== 'boolean') {
			throw new DshRpcError({
				kind: 'protocol',
				method: endpoint,
				base: this.base,
				preFlight: false,
				message: `malformed result for ${endpoint}: ${text.slice(0, 200)}`,
			});
		}
		return { envelope, status: response.status };
	}

	/**
	 * Open one Gateway Remote stream and yield decoded item values.
	 *   client: {type:'open', streamId, endpoint, payload:{args}}
	 *   server: {type:'item', streamId, value} | {type:'error',…} | {type:'end', streamId}
	 */
	async *openStream(endpoint, args = {}, { timeoutMs = this.timeoutMs, signal } = {}) {
		if (typeof WebSocket !== 'function') {
			throw new DshRpcError({
				kind: 'transport',
				method: endpoint,
				base: this.base,
				message: `this Node runtime has no global WebSocket; cannot open stream ${endpoint} (Node >= 22 required)`,
			});
		}
		const url = this.streamUrl();
		const socket = new WebSocket(url);
		const streamId = randomUUID();
		const queue = [];
		let wake = null;
		let finished = false;
		let failure = null;
		const notify = () => {
			const resume = wake;
			wake = undefined;
			resume?.();
		};
		const finish = (error = null) => {
			finished = true;
			failure = error;
			notify();
		};

		socket.addEventListener('message', (event) => {
			let message;
			try {
				message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
			} catch {
				return;
			}
			if (message.streamId !== streamId) return;
			if (message.type === 'item') queue.push(message.value);
			else if (message.type === 'error') {
				finish(new DshRpcError({
					kind: 'rpc',
					method: endpoint,
					code: message.error?.code,
					message: message.error?.message,
					details: message.error?.details,
					base: this.base,
				}));
			} else if (message.type === 'end') finish();
		});
		socket.addEventListener('error', () => finish(new DshRpcError({
			kind: 'transport',
			method: endpoint,
			base: this.base,
			message: `WebSocket error while opening ${endpoint} at ${url}`,
		})));
		socket.addEventListener('close', () => finish());

		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new DshRpcError({
				kind: 'timeout',
				method: endpoint,
				base: this.base,
				message: `timed out after ${timeoutMs} ms opening stream ${endpoint} at ${url}`,
			})), timeoutMs);
			socket.addEventListener('open', () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
			socket.addEventListener('error', () => {
				clearTimeout(timer);
				reject(new DshRpcError({
					kind: 'transport',
					method: endpoint,
					base: this.base,
					message: `cannot open stream ${endpoint} at ${url}`,
				}));
			}, { once: true });
		});
		socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: args ?? {} } }));

		const onAbort = () => finish();
		signal?.addEventListener?.('abort', onAbort, { once: true });
		const deadline = Date.now() + timeoutMs;
		try {
			for (;;) {
				if (queue.length) {
					yield queue.shift();
					continue;
				}
				if (finished) {
					if (failure) throw failure;
					return;
				}
				if (Date.now() >= deadline) {
					throw new DshRpcError({
						kind: 'timeout',
						method: endpoint,
						base: this.base,
						message: `stream ${endpoint} produced no frame within ${timeoutMs} ms`,
					});
				}
				await new Promise((resolve) => {
					wake = resolve;
					setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
				});
			}
		} finally {
			signal?.removeEventListener?.('abort', onAbort);
			try {
				if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', streamId }));
			} catch {
				/* already closing */
			}
			try {
				socket.close();
			} catch {
				/* already closed */
			}
		}
	}

	/** Convenience: first item of a stream (used for the `workspace/follow` baseline). */
	async firstStreamItem(endpoint, args = {}, opts = {}) {
		for await (const value of this.openStream(endpoint, args, opts)) return value;
		return undefined;
	}

	/** Cheap liveness probe used by tools/tests: never throws, always reports the base it used. */
	async probe({ timeoutMs } = {}) {
		const started = Date.now();
		try {
			const value = await this.call('session/list', { request: {} }, { timeoutMs: timeoutMs ?? Math.min(this.timeoutMs, 10_000) });
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
