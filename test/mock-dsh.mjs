/**
 * A self-contained mock of the DSH **0.2.x Typert Remote** HTTP + stream surface.
 *
 * The real suites drive a live DSH at `$DSH_BASE`. When no host is running we still want the whole
 * MCP server (transports, validation, dispatch, wait loop, error mapping, stream baseline) exercised
 * end-to-end. This mock speaks the exact wire contract from `packages/client/connection/src/rpc.ts`
 * and `packages/api/gateway/src/stream-protocol.ts`:
 *
 *   POST /api/<namespace>/<method>  { type:'client-request', rpcId, method, payload:{args} }
 *   -> { type:'server-response', rpcId, result:{ok,value|error:{code,message,details}} }
 *   WS   /api/remote.mux            { type:'open', streamId, endpoint, payload:{args} }
 *
 * It is test scaffolding under `test/`, deliberately outside `src/`.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const WORKSPACE = process.env.E2E_WORKSPACE ?? '/workspace';
const ARTIFACT = '/tmp/mcp-e2e.txt';
const MODEL = { provider: 'local-gateway', model: 'deepseek-ai/DeepSeek-V4.1-Flash' };

const ok = (value) => ({ ok: true, value });
const err = (code, message, details = {}) => ({ ok: false, error: { code, message, details } });

export function createMockDsh() {
	const sessions = new Map();
	const workspaces = [];
	const archivedSessionIds = [];
	const pinnedSessionIds = [];
	let seq = 0;
	const nextSeq = () => ++seq;

	const lastSeq = (s) => (s.events.length ? s.events[s.events.length - 1].seq : -1);

	function projectionValues(s) {
		return {
			title: s.title ?? null,
			agentPreset: s.agentPreset ?? null,
			modelSelection: { lastUsed: s.modelSelection ?? null, next: s.modelSelection ?? null },
			subagentCatalog: s.children.map((child) => ({
				id: child.id,
				createdAt: child.createdAt,
				mode: child.mode,
				...(child.label ? { label: child.label } : {}),
			})),
		};
	}

	function summary(s) {
		return {
			agentAvailable: true,
			sessionId: s.sessionId,
			updatedAt: s.updatedAt,
			running: s.running,
			blank: s.blank,
			...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
			...(s.origin ? { origin: s.origin } : {}),
			...(s.cwd ? { cwd: s.cwd } : {}),
			projections: { kind: 'sequenced', asOfSeq: lastSeq(s), values: projectionValues(s) },
		};
	}

	const wsView = (w) => ({ workspaceId: w.workspaceId, title: w.title, path: w.path, sessionIds: w.sessionIds, createdAt: w.createdAt, updatedAt: w.updatedAt });

	function newSession({ cwd = null, workspaceId = null, parentSessionId = null, origin = undefined, agentPreset = null, id = null } = {}) {
		const sessionId = id ?? `session-${randomUUID()}`;
		const s = {
			sessionId,
			updatedAt: Date.now(),
			running: false,
			blank: true,
			cwd,
			parentSessionId,
			origin,
			agentPreset,
			title: null,
			workspaceId,
			modelSelection: null,
			events: [],
			children: [],
			timers: [],
		};
		sessions.set(sessionId, s);
		if (workspaceId) {
			const w = workspaces.find((x) => x.workspaceId === workspaceId);
			if (w) w.sessionIds.push(sessionId);
		}
		return s;
	}

	function addEvent(s, type, data) {
		const event = { type, seq: nextSeq(), time: Date.now(), data };
		s.events.push(event);
		return event;
	}
	const addUser = (s, text) => addEvent(s, 'user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
	const addAssistant = (s, text, turn = 1) =>
		addEvent(s, 'assistant/message', {
			turn,
			step: 1,
			message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: MODEL.provider, model: MODEL.model } },
			stream: [],
		});

	function settleTurn(s, answer, { tool = false } = {}) {
		if (tool) addEvent(s, 'tool/call', { turn: 1, step: 1, callId: randomUUID(), name: 'bash', arguments: '{}' });
		addAssistant(s, answer);
		addEvent(s, 'turn/end', { turn: 1, reason: 'completed' });
		s.running = false;
		s.updatedAt = Date.now();
	}

	function startTurn(s, text) {
		s.running = true;
		s.blank = false;
		s.updatedAt = Date.now();
		addUser(s, text);
		const later = (fn, ms) => s.timers.push(setTimeout(fn, ms));

		if (/mcp-e2e\.txt/.test(text)) {
			later(() => {
				try {
					writeFileSync(ARTIFACT, 'E2E-OK\n');
				} catch {
					/* best effort */
				}
				addEvent(s, 'tool/call', { turn: 1, step: 1, callId: randomUUID(), name: 'bash', arguments: `{"command":"echo E2E-OK > ${ARTIFACT}"}` });
				settleTurn(s, 'E2E-OK');
			}, 300);
			return;
		}
		if (/subagent/i.test(text)) {
			later(() => {
				const child = newSession({ cwd: s.cwd, parentSessionId: s.sessionId, origin: 'subagent', id: randomUUID() });
				addUser(child, 'echo SUBAGENT-PROBE');
				addEvent(child, 'tool/call', { turn: 1, step: 1, callId: randomUUID(), name: 'bash', arguments: '{}' });
				settleTurn(child, 'SUBAGENT-PROBE');
				s.children.push({ id: child.sessionId, createdAt: Date.now(), mode: 'one-shot' });
				settleTurn(s, 'PARENT-DONE');
			}, 400);
			return;
		}
		if (/SLOW-OK|sleep 45/.test(text)) {
			later(() => settleTurn(s, 'SLOW-OK'), 45_000);
			return;
		}
		if (/DISPATCH-OK/.test(text)) {
			later(() => settleTurn(s, 'DISPATCH-OK'), 300);
			return;
		}
		if (/RUN-OK/.test(text)) {
			later(() => settleTurn(s, 'RUN-OK'), 300);
			return;
		}
		later(() => settleTurn(s, 'OK'), 300);
	}

	// seed the workspace + one session so list filters are non-empty
	const ws = { workspaceId: `workspace-${randomUUID()}`, title: WORKSPACE, path: WORKSPACE, sessionIds: [], createdAt: Date.now(), updatedAt: Date.now() };
	workspaces.push(ws);
	newSession({ cwd: WORKSPACE, workspaceId: ws.workspaceId });

	// --- RPC dispatch table (endpoint -> handler(args)) ------------------------------
	const handlers = {
		'session/list': () => ok({ items: [...sessions.values()].map(summary) }),

		'session/create': ({ request }) => {
			const workspace = request.workspaceId ? workspaces.find((w) => w.workspaceId === request.workspaceId) : null;
			const s = newSession({
				cwd: request.cwd ?? workspace?.path ?? null,
				workspaceId: request.workspaceId ?? null,
				agentPreset: request.agentPreset ?? null,
				id: request.sessionId ?? null,
			});
			return ok({ sessionId: s.sessionId, ...(s.agentPreset ? { agentPreset: s.agentPreset } : {}) });
		},

		'session/prompt': ({ request }) => {
			const s = sessions.get(request.sessionId);
			if (!s) return err('session/not-found', `session "${request.sessionId}" not found`, { sessionId: request.sessionId });
			const text = (request.content ?? []).map((b) => b?.text ?? '').join('\n');
			startTurn(s, text);
			return ok({ accepted: true });
		},

		'session/cancel': ({ request }) => {
			const s = sessions.get(request.sessionId);
			if (!s) return err('session/not-found', `session "${request.sessionId}" not found`, { sessionId: request.sessionId });
			for (const timer of s.timers) clearTimeout(timer);
			s.timers = [];
			s.running = false;
			s.updatedAt = Date.now();
			return ok({ accepted: true });
		},

		'session/rename': ({ request }) => {
			const s = sessions.get(request.sessionId);
			if (!s) return err('session/not-found', `session "${request.sessionId}" not found`, { sessionId: request.sessionId });
			s.title = request.title;
			s.updatedAt = Date.now();
			return ok({ title: s.title, seq: lastSeq(s) });
		},

		'session/fork': ({ request }) => {
			const s = sessions.get(request.sessionId);
			if (!s) return err('session/not-found', `session "${request.sessionId}" not found`, { sessionId: request.sessionId });
			const child = newSession({ cwd: s.cwd, workspaceId: s.workspaceId });
			child.title = s.title;
			return ok({ sessionId: child.sessionId });
		},

		'session/selectModel': ({ request }) => {
			const s = sessions.get(request.sessionId);
			if (!s) return err('session/not-found', `session "${request.sessionId}" not found`, { sessionId: request.sessionId });
			if (request.provider === 'no-such-provider' || request.model === 'no-such-model') {
				return err('model-unavailable', `model ${request.provider}/${request.model} is not available`, { provider: request.provider, model: request.model });
			}
			s.modelSelection = { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) };
			return ok({ selected: s.modelSelection });
		},

		'session/modelCatalog': () => ok({
			default: { ...MODEL },
			routableProviders: [MODEL.provider],
			groups: [{ id: MODEL.provider, name: 'Local Gateway', models: [{ id: MODEL.model, name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-ai/DeepSeek-V4.1', name: 'DeepSeek V4.1' }] }],
			failures: [],
		}),

		'session/canOpenWorkspacePath': () => ok(true),

		'session/projections': ({ request }) => {
			const s = sessions.get(request.sessionId);
			if (!s) return ok(null);
			return ok({ kind: 'sequenced', asOfSeq: lastSeq(s), values: projectionValues(s) });
		},

		'session/page': ({ request }) => {
			const address = request.address;
			const sessionId = address?.kind === 'subagent' ? address.childSessionId : address?.sessionId;
			const s = sessions.get(sessionId);
			if (!s) return err('session/not-found', `session "${sessionId}" not found`, { sessionId });
			const cursor = lastSeq(s);
			if (typeof request.throughSeq !== 'number' || request.throughSeq > cursor) {
				return err('gateway/bad-request', `session page through seq ${request.throughSeq} is past cursor ${cursor}`, {});
			}
			let list = s.events.filter((event) => event.seq <= request.throughSeq);
			if (request.beforeSeq !== undefined) list = list.filter((event) => event.seq < request.beforeSeq);
			const max = request.maxMessages ?? 20;
			const page = list.slice(-max);
			return ok({ records: page.map((event) => ({ type: 'event', event })), hasMore: list.length > page.length });
		},

		'workspace/create': ({ request }) => {
			const existing = workspaces.find((w) => w.path === request.path);
			if (existing) return ok({ workspace: wsView(existing), created: false });
			const w = { workspaceId: `workspace-${randomUUID()}`, title: request.path, path: request.path, sessionIds: [], createdAt: Date.now(), updatedAt: Date.now() };
			workspaces.push(w);
			return ok({ workspace: wsView(w), created: true });
		},

		'workspace/archiveSession': ({ request }) => {
			if (!archivedSessionIds.includes(request.sessionId)) archivedSessionIds.push(request.sessionId);
			return ok({ archivedSessionIds: archivedSessionIds.slice() });
		},

		'subagents/prompt': ({ request }) => {
			const parent = sessions.get(request.parentSessionId);
			const child = parent?.children.find((entry) => entry.id === request.childSessionId);
			if (!child) return err('subagent/not-found', 'subagent is unavailable', { childSessionId: request.childSessionId });
			if (child.mode !== 'continuable' || request.mode !== 'continuable') {
				return err('subagent/not-found', 'subagent is unavailable', { childSessionId: request.childSessionId });
			}
			const childSession = sessions.get(request.childSessionId);
			if (childSession) {
				const text = (request.content ?? []).map((block) => block?.text ?? '').join('\n');
				startTurn(childSession, text);
			}
			return ok({ messageId: randomUUID() });
		},

		'subagents/interruptByParent': ({ childSessionId, parentSessionId, mode }) => {
			if (mode !== 'continuable') return err('gateway/bad-request', 'mode must be continuable', {});
			const parent = sessions.get(parentSessionId);
			const child = parent?.children.find((entry) => entry.id === childSessionId);
			if (!child) return err('subagent/not-found', 'subagent is unavailable', { childSessionId });
			const childSession = sessions.get(childSessionId);
			if (childSession) {
				for (const timer of childSession.timers) clearTimeout(timer);
				childSession.timers = [];
				childSession.running = false;
				childSession.updatedAt = Date.now();
			}
			return ok({ accepted: true });
		},
	};

	const wss = new WebSocketServer({ noServer: true });

	const server = createServer((req, res) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			const send = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			const match = /^\/api\/([^/?]+)\/([^/?]+)/.exec(req.url ?? '');
			if (req.method !== 'POST' || !match) {
				send(404, { type: 'server-response', rpcId: null, result: err('gateway/not-found', `unknown path ${req.url}`, {}) });
				return;
			}
			const endpoint = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
			let envelope;
			try {
				envelope = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			} catch {
				send(400, { type: 'server-response', rpcId: null, result: err('gateway/bad-request', 'body is not JSON', {}) });
				return;
			}
			const handler = handlers[endpoint];
			if (!handler) {
				send(200, { type: 'server-response', rpcId: envelope.rpcId ?? null, result: err('gateway/not-found', `no such endpoint "${endpoint}"`, { endpoint }) });
				return;
			}
			let result;
			try {
				result = handler(envelope.payload?.args ?? {});
			} catch (error) {
				result = err('gateway/internal', String(error?.message ?? error), {});
			}
			send(200, { type: 'server-response', rpcId: envelope.rpcId ?? null, result });
		});
	});

	server.on('upgrade', (req, socket, head) => {
		if (!(req.url ?? '').startsWith('/api/remote.mux')) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (peer) => {
			peer.on('message', (raw) => {
				let message;
				try {
					message = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (message.type === 'open' && message.endpoint === 'workspace/follow') {
					peer.send(JSON.stringify({
						type: 'item',
						streamId: message.streamId,
						value: {
							type: 'baseline',
							value: {
								items: workspaces.map(wsView),
								archivedSessionIds: archivedSessionIds.slice(),
								pinnedSessionIds: pinnedSessionIds.slice(),
							},
						},
					}));
				} else if (message.type === 'open') {
					peer.send(JSON.stringify({ type: 'error', streamId: message.streamId, error: { code: 'gateway/not-found', message: `no such stream "${message.endpoint}"`, details: {} } }));
				}
			});
		});
	});

	return {
		server,
		sessions,
		workspaces,
		listen: (port = 3080, host = '127.0.0.1') =>
			new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, () => resolve(server.address()));
			}),
		close: () => new Promise((resolve) => {
			for (const client of wss.clients) client.terminate();
			wss.close();
			server.close(resolve);
		}),
	};
}

// Standalone entry point: `node test/mock-dsh.mjs [port]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const port = Number(process.argv[2] ?? process.env.MOCK_DSH_PORT ?? 3080);
	const mock = createMockDsh();
	const addr = await mock.listen(port);
	console.error(`[mock-dsh] listening on http://127.0.0.1:${addr.port} (workspace ${WORKSPACE})`);
}
