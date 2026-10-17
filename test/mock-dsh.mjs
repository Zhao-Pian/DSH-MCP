/**
 * A self-contained mock of the DSH `/api` RPC surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * The real `test/e2e.test.mjs` (and two cases in `test/protocol.test.mjs`) drive a *live* DSH host at
 * `$DSH_BASE` (default http://127.0.0.1:3080). When no DSH is running there is nothing to talk to, so
 * the suite cannot be exercised end-to-end. This file speaks the exact same wire contract as
 * `src/client.js` expects — `POST /api/<method>` carrying a `client-request` envelope and answering a
 * `server-response` envelope whose `result.ok` may be false (a business error on HTTP 200) — so the
 * full MCP server (transports, validation, dispatch, wait loop, error mapping) runs against it.
 *
 * It is *test scaffolding*, deliberately outside `src/`. It models only the semantics the tests
 * assert; it is not a DSH implementation.
 *
 * Standalone:  node test/mock-dsh.mjs [port]     (default 3080)
 * Programmatic: import { createMockDsh } from './mock-dsh.mjs'
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const WORKSPACE = process.env.E2E_WORKSPACE ?? '/workspace';
const ARTIFACT = '/tmp/mcp-e2e.txt';
const MODEL = { provider: 'local-gateway', model: 'deepseek-ai/DeepSeek-V4.1-Flash' };

const ok = (value) => ({ ok: true, value });
const err = (code, message, details) => ({ ok: false, error: { code, message, details } });

export function createMockDsh() {
	const sessions = new Map();
	const workspaces = [];
	const archivedSessionIds = [];
	let seq = 0;
	const nextSeq = () => ++seq;

	const view = (s) => ({
		sessionId: s.sessionId,
		updatedAt: s.updatedAt,
		running: s.running,
		blank: s.blank,
		cwd: s.cwd,
		parentSessionId: s.parentSessionId,
		origin: s.origin,
		agentPreset: s.agentPreset,
	});
	const wsView = (w) => ({
		workspaceId: w.workspaceId,
		title: w.title,
		path: w.path,
		sessionIds: w.sessionIds,
		createdAt: w.createdAt,
		updatedAt: w.updatedAt,
	});

	function newSession({ cwd = null, workspaceId = null, parentSessionId = null, origin = 'created', agentPreset = null, id = null } = {}) {
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
		const ev = { event: { type, seq: nextSeq(), data } };
		s.events.push(ev);
		return ev;
	}
	const addMessage = (s, role, text) => addEvent(s, 'message', { message: { role, content: [{ type: 'text', text }] } });

	/** Finish a running turn: emit an assistant answer + turn/end and drop the running flag. */
	function settleTurn(s, answer, { tool = false } = {}) {
		if (tool) addEvent(s, 'tool/call', { tool: 'bash', args: {} });
		addMessage(s, 'assistant', answer);
		addEvent(s, 'turn/end', {});
		s.running = false;
		s.updatedAt = Date.now();
	}

	/** Kick off an asynchronous turn (prompt returns immediately; the answer lands later). */
	function startTurn(s, text) {
		s.running = true;
		s.blank = false;
		s.updatedAt = Date.now();
		addMessage(s, 'user', text);
		const later = (fn, ms) => s.timers.push(setTimeout(fn, ms));

		if (/mcp-e2e\.txt/.test(text)) {
			later(() => {
				try {
					writeFileSync(ARTIFACT, 'E2E-OK\n');
				} catch {
					/* best effort: the test asserts the file, but never crash the host */
				}
				addEvent(s, 'tool/call', { tool: 'bash', args: { command: `echo E2E-OK > ${ARTIFACT}` } });
				settleTurn(s, 'E2E-OK');
			}, 300);
			return;
		}
		if (/subagent/i.test(text)) {
			later(() => {
				const child = newSession({ cwd: s.cwd, parentSessionId: s.sessionId, origin: 'subagent', id: randomUUID() });
				addMessage(child, 'user', 'echo SUBAGENT-PROBE');
				addEvent(child, 'tool/call', { tool: 'bash', args: {} });
				settleTurn(child, 'SUBAGENT-PROBE');
				s.children.push({ kind: 'child', id: child.sessionId, activity: 'inactive', hasChildren: false, mode: 'one-shot', label: null });
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

	// --- seed state the tests expect to already exist -------------------------------
	const ws = { workspaceId: `workspace-${randomUUID()}`, title: WORKSPACE, path: WORKSPACE, sessionIds: [], createdAt: Date.now(), updatedAt: Date.now() };
	workspaces.push(ws);
	newSession({ cwd: WORKSPACE, workspaceId: ws.workspaceId }); // so list_sessions(workspace) is non-empty

	// --- RPC dispatch table ---------------------------------------------------------
	const handlers = {
		'host.describe': () =>
			ok({ version: '0.0.1', cwd: WORKSPACE, provider: MODEL.provider, model: MODEL.model, attachedSessions: sessions.size, canOpenPath: false }),

		'session.list': () => ok({ items: [...sessions.values()].map(view) }),

		'session.history': (p) => {
			const s = sessions.get(p.sessionId);
			if (!s) return err('session-not-found', `session "${p.sessionId}" not found`, { sessionId: p.sessionId });
			let list = s.events;
			if (p.beforeSeq !== undefined && p.beforeSeq !== null) list = list.filter((e) => e.event.seq < p.beforeSeq);
			const max = p.maxMessages ?? 20;
			const hasMore = list.length > max;
			const page = list.slice(-max);
			const asOfSeq = s.events.length ? s.events[s.events.length - 1].event.seq : null;
			return ok({ events: page, hasMore, asOfSeq, projections: { values: { title: s.title } } });
		},

		'session.create': (p) => {
			const workspace = p.workspaceId ? workspaces.find((w) => w.workspaceId === p.workspaceId) : null;
			const s = newSession({
				cwd: p.cwd ?? workspace?.path ?? null,
				workspaceId: p.workspaceId ?? null,
				agentPreset: p.agentPreset ?? null,
				id: p.sessionId ?? null,
			});
			return ok({ sessionId: s.sessionId, agentPreset: s.agentPreset });
		},

		'session.prompt': (p) => {
			const s = sessions.get(p.sessionId);
			if (!s) return err('session-not-found', `session "${p.sessionId}" not found`, { sessionId: p.sessionId });
			const text = (p.content ?? []).map((b) => b?.text ?? '').join('\n');
			startTurn(s, text);
			return ok({ accepted: true, command: p.mode ?? 'queue', messageId: randomUUID() });
		},

		'session.models': (p) => {
			const s = sessions.get(p.sessionId);
			if (!s) return err('session-not-found', `session "${p.sessionId}" not found`, { sessionId: p.sessionId });
			return ok({
				current: { ...MODEL },
				routable: true,
				groups: [{ provider: MODEL.provider, models: [MODEL.model, 'deepseek-ai/DeepSeek-V4.1'], routable: true }],
				failures: [],
			});
		},

		'session.selectModel': (p) => {
			if (p.provider === 'no-such-provider' || p.model === 'no-such-model') {
				return err('model-unavailable', `model ${p.provider}/${p.model} is not available`, { provider: p.provider, model: p.model });
			}
			return ok({ selected: { provider: p.provider, model: p.model } });
		},

		'session.cancel': (p) => {
			const s = sessions.get(p.sessionId);
			if (!s) return err('session-not-found', `session "${p.sessionId}" not found`, { sessionId: p.sessionId });
			for (const t of s.timers) clearTimeout(t);
			s.timers = [];
			s.running = false;
			s.updatedAt = Date.now();
			return ok({ accepted: true });
		},

		'session.rename': (p) => {
			const s = sessions.get(p.sessionId);
			if (!s) return err('session-not-found', `session "${p.sessionId}" not found`, { sessionId: p.sessionId });
			s.title = p.title;
			s.updatedAt = Date.now();
			const lastSeq = s.events.length ? s.events[s.events.length - 1].event.seq : null;
			return ok({ title: s.title, seq: lastSeq });
		},

		'session.fork': (p) => {
			const s = sessions.get(p.sessionId);
			if (!s) return err('session-not-found', `session "${p.sessionId}" not found`, { sessionId: p.sessionId });
			const child = newSession({ cwd: s.cwd, workspaceId: s.workspaceId, origin: 'fork' });
			child.title = s.title;
			return ok({ sessionId: child.sessionId });
		},

		'workspace.list': () => ok({ items: workspaces.map(wsView), archivedSessionIds: archivedSessionIds.slice() }),

		'workspace.create': (p) => {
			const existing = workspaces.find((w) => w.path === p.path);
			if (existing) return ok({ workspace: wsView(existing), created: false });
			const w = { workspaceId: `workspace-${randomUUID()}`, title: p.path, path: p.path, sessionIds: [], createdAt: Date.now(), updatedAt: Date.now() };
			workspaces.push(w);
			return ok({ workspace: wsView(w), created: true });
		},

		'workspace.archiveSession': (p) => {
			if (!archivedSessionIds.includes(p.sessionId)) archivedSessionIds.push(p.sessionId);
			return ok({ archivedSessionIds: archivedSessionIds.slice() });
		},

		'subagent.list': (p) => {
			const s = sessions.get(p.parentSessionId);
			if (!s) return ok({ parentAvailable: false, entries: [] });
			return ok({ parentAvailable: true, entries: s.children });
		},

		// One-shot children are refused here on purpose, which is exactly what the real host does; the
		// reader then falls back to session.history (see src/tools/support.js readHistory).
		'subagent.prompt': (p) =>
			err('subagent-not-found', `continuable child "${p.childSessionId}" not found`, { parentSessionId: p.parentSessionId, childSessionId: p.childSessionId }),

		'subagent.history': (p) =>
			err('subagent-not-found', `continuable child "${p.childSessionId}" not found`, { childSessionId: p.childSessionId }),

		'subagent.interrupt': (p) => {
			const s = sessions.get(p.parentSessionId);
			const c = s?.children.find((e) => e.id === p.childSessionId);
			if (c) c.activity = 'inactive';
			return ok({ accepted: true });
		},
	};

	async function handle(method, payload) {
		const fn = handlers[method];
		if (!fn) return err('unknown-method', `no such method "${method}"`, { method });
		try {
			return fn(payload ?? {});
		} catch (error) {
			return err('internal', String(error?.message ?? error));
		}
	}

	const server = createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', async () => {
			const send = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			const url = req.url ?? '';
			const match = /^\/api\/([^/?]+)/.exec(url);
			if (req.method !== 'POST' || !match) {
				send(404, { type: 'server-response', rpcId: null, result: err('not-found', `unknown path ${url}`) });
				return;
			}
			let envelope;
			try {
				envelope = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			} catch {
				send(400, { type: 'server-response', rpcId: null, result: err('bad-request', 'body is not JSON') });
				return;
			}
			const method = decodeURIComponent(match[1]);
			const result = await handle(method, envelope.payload);
			send(200, { type: 'server-response', rpcId: envelope.rpcId ?? null, result });
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
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

// Standalone entry point: `node test/mock-dsh.mjs [port]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const port = Number(process.argv[2] ?? process.env.MOCK_DSH_PORT ?? 3080);
	const mock = createMockDsh();
	const addr = await mock.listen(port);
	console.error(`[mock-dsh] listening on http://127.0.0.1:${addr.port} (workspace ${WORKSPACE})`);
}

