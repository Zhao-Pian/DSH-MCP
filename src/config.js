/**
 * Configuration resolution for the DSH MCP server.
 *
 * Precedence is strict and one-directional:  **CLI flag  >  environment variable  >  built-in default**
 * Every resolved value remembers where it came from (`sources`), which `--print-config` prints and the
 * e2e test asserts on when it proves that `--base` / `DSH_BASE` really move the wire target.
 *
 * Nothing here talks HTTP; the wire lives exclusively in `client.js`.
 */
import { readFileSync } from 'node:fs';

export const DEFAULTS = Object.freeze({
	base: 'http://127.0.0.1:3080',
	token: null,
	headers: {},
	/** per-RPC timeout for ordinary calls (ms) */
	timeoutMs: 30_000,
	/** how many times a *retryable* failure is retried (0 = no retry) */
	retries: 2,
	/** default budget for dsh_wait_for_turn / dsh_run_task (ms) */
	waitTimeoutMs: 120_000,
	/** poll cadence for the running-flag watch (ms) */
	pollIntervalMs: 3_000,
	/** MCP transport: 'stdio' (default) or 'http' */
	transport: 'stdio',
	httpHost: '127.0.0.1',
	httpPort: 8765,
	httpPath: '/mcp',
	/** optional bearer token protecting the MCP HTTP endpoint itself */
	httpToken: null,
	/** expose dsh_call (passthrough of any /api method) — off by default */
	allowRawCall: false,
	/** print the resolved configuration and exit */
	printConfig: false,
});

/** env var -> config key */
const ENV_MAP = Object.freeze({
	DSH_BASE: 'base',
	DSH_TOKEN: 'token',
	DSH_HEADERS: 'headers',
	DSH_TIMEOUT_MS: 'timeoutMs',
	DSH_RETRIES: 'retries',
	DSH_WAIT_TIMEOUT_MS: 'waitTimeoutMs',
	DSH_POLL_INTERVAL_MS: 'pollIntervalMs',
	DSH_HTTP_HOST: 'httpHost',
	DSH_HTTP_PORT: 'httpPort',
	DSH_HTTP_PATH: 'httpPath',
	DSH_HTTP_TOKEN: 'httpToken',
	DSH_ALLOW_RAW_CALL: 'allowRawCall',
});

/** CLI flag -> config key. Value-less flags are declared in BOOLEAN_FLAGS. */
const FLAG_MAP = Object.freeze({
	base: 'base',
	token: 'token',
	header: 'headers',
	'timeout-ms': 'timeoutMs',
	retries: 'retries',
	'wait-timeout-ms': 'waitTimeoutMs',
	'poll-interval-ms': 'pollIntervalMs',
	host: 'httpHost',
	port: 'httpPort',
	path: 'httpPath',
	'http-token': 'httpToken',
});

const BOOLEAN_FLAGS = Object.freeze({
	http: ['transport', 'http'],
	stdio: ['transport', 'stdio'],
	'allow-raw-call': ['allowRawCall', true],
	'print-config': ['printConfig', true],
	help: ['help', true],
	version: ['version', true],
});

const INT_KEYS = new Set(['timeoutMs', 'retries', 'waitTimeoutMs', 'pollIntervalMs', 'httpPort']);

export class ConfigError extends Error {}

/** `--flag value`, `--flag=value`, plus bare boolean flags. Returns {flags, positionals}. */
export function parseArgv(argv) {
	const flags = {};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) {
			positionals.push(token);
			continue;
		}
		const eq = token.indexOf('=');
		const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
		if (eq !== -1) {
			push(flags, key, token.slice(eq + 1));
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			push(flags, key, true);
		} else {
			push(flags, key, next);
			i++;
		}
	}
	return { flags, positionals };
}

function push(flags, key, value) {
	if (key === 'header') {
		flags.header = Array.isArray(flags.header) ? [...flags.header, value] : [value];
		return;
	}
	flags[key] = value;
}

/** `"A: 1, B: 2"` or `'{"A":"1"}'` or repeatable `--header "A: 1"` -> plain object. */
function parseHeaders(raw) {
	if (raw === undefined || raw === null || raw === '') return {};
	if (Array.isArray(raw)) return raw.reduce((acc, item) => ({ ...acc, ...parseHeaders(item) }), {});
	const text = String(raw).trim();
	if (text.startsWith('{')) {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new ConfigError(`--header/DSH_HEADERS JSON is invalid: ${error.message}`);
		}
		return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
	}
	const out = {};
	for (const part of text.split(/[,\n]/)) {
		if (!part.trim()) continue;
		const idx = part.indexOf(':');
		if (idx === -1) throw new ConfigError(`header "${part.trim()}" is not "Name: value"`);
		out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
	}
	return out;
}

function coerceInt(key, value, source) {
	const n = Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
		throw new ConfigError(`${source} must be a non-negative integer, got ${JSON.stringify(value)}`);
	}
	return n;
}

function normalizeBase(raw, source) {
	let url;
	try {
		url = new URL(String(raw));
	} catch {
		throw new ConfigError(`${source} is not a valid URL: ${JSON.stringify(raw)}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new ConfigError(`${source} must be http:// or https://, got ${url.protocol}`);
	}
	// keep the path prefix (a DSH behind a reverse proxy may live under /dsh) but drop a trailing slash
	return url.toString().replace(/\/+$/, '');
}

/**
 * @param {string[]} argv      process.argv.slice(2)
 * @param {Record<string,string|undefined>} env
 * @param {{loadEnvFile?: string}} [opts] optional dotenv-style file loaded at *lowest* precedence
 */
export function resolveConfig(argv = [], env = process.env, opts = {}) {
	const fileVars = opts.loadEnvFile ? readEnvFile(opts.loadEnvFile) : {};
	const envValue = (key) => env[key] ?? fileVars[key];
	const { flags } = parseArgv(argv);

	for (const key of Object.keys(flags)) {
		if (!(key in FLAG_MAP) && !(key in BOOLEAN_FLAGS)) {
			throw new ConfigError(`unknown flag --${key} (see --help)`);
		}
	}

	/** @type {Record<string, unknown>} */
	const values = { ...DEFAULTS };
	/** @type {Record<string, string>} */
	const sources = {};

	// 3rd precedence: env (and the optional env file underneath it)
	for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
		const raw = envValue(envKey);
		if (raw === undefined || raw === '') continue;
		values[configKey] = configKey === 'headers' ? parseHeaders(raw) : raw;
		sources[configKey] = envKey === 'DSH_BASE' && env.DSH_BASE === undefined ? `env:DSH_BASE(file)` : `env:${envKey}`;
	}
	if (envValue('DSH_BASE') === undefined && envValue('DSH_WEB_URL')) {
		values.base = envValue('DSH_WEB_URL');
		sources.base = 'env:DSH_WEB_URL';
	}
	if (envValue('DSH_MCP_HTTP')) {
		values.transport = 'http';
		sources.transport = 'env:DSH_MCP_HTTP';
	}

	// 2nd precedence: CLI
	for (const [flag, value] of Object.entries(flags)) {
		if (flag in BOOLEAN_FLAGS) {
			const [key, v] = BOOLEAN_FLAGS[flag];
			if (value !== true && value !== 'true' && value !== 'false') {
				throw new ConfigError(`--${flag} is a boolean flag and takes no value`);
			}
			values[key] = value === true || value === 'true' ? v : typeof v === 'boolean' ? !v : v;
			sources[key] = `cli:--${flag}`;
			continue;
		}
		const key = FLAG_MAP[flag];
		values[key] = key === 'headers' ? parseHeaders(value) : value;
		sources[key] = `cli:--${flag}`;
	}

	// normalize / validate
	for (const key of INT_KEYS) {
		if (typeof values[key] === 'string') values[key] = coerceInt(key, values[key], sources[key] ?? key);
	}
	if (!values.headers || typeof values.headers !== 'object') values.headers = {};
	values.base = normalizeBase(values.base, sources.base ?? 'default');
	if (!sources.base) sources.base = 'default';
	for (const key of Object.keys(DEFAULTS)) {
		if (!(key in values)) values[key] = DEFAULTS[key];
		if (!(key in sources)) sources[key] = 'default';
	}
	if (!/^https?:$/.test(new URL(values.base).protocol)) throw new ConfigError('base must be http(s)');
	if (values.transport !== 'stdio' && values.transport !== 'http') {
		throw new ConfigError(`transport must be stdio or http, got ${values.transport}`);
	}
	if (!values.httpPath.startsWith('/')) throw new ConfigError('--path must start with "/"');
	// boolean-ish env/CLI values: "1"/"true"/"yes"/"on" enable, "0"/"false"/"no"/"off" disable
	for (const key of ['allowRawCall', 'printConfig', 'help', 'version']) {
		const raw = values[key];
		if (typeof raw === 'string') values[key] = /^(1|true|yes|on)$/i.test(raw.trim());
		else values[key] = Boolean(raw);
	}

	return { ...values, sources };
}

function readEnvFile(path) {
	const out = {};
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return out;
	}
	for (const line of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let value = m[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[m[1]] = value;
	}
	return out;
}

/** Config shape safe to print / log: the token is redacted, never echoed. */
export function redactedConfig(config) {
	const { sources, ...rest } = config;
	return { ...rest, token: config.token ? '***redacted***' : null, httpToken: config.httpToken ? '***redacted***' : null, sources };
}

export const HELP = `dsh-mcp — MCP server that drives an already-running DSH instance over its /api RPC surface

Usage:
  dsh-mcp [options]                # stdio transport (default; how MCP hosts mount it)
  dsh-mcp --http [options]         # streamable HTTP transport on http://<host>:<port><path>

Target (CLI beats env beats default):
  --base <url>             DSH base URL            (DSH_BASE, then DSH_WEB_URL, default ${DEFAULTS.base})
  --token <bearer>         Authorization: Bearer … (DSH_TOKEN)
  --header "Name: value"   extra request header, repeatable (DSH_HEADERS, JSON or "A: 1, B: 2")
  --timeout-ms <n>         per-RPC timeout         (DSH_TIMEOUT_MS, default ${DEFAULTS.timeoutMs})
  --retries <n>            retries for retryable failures (DSH_RETRIES, default ${DEFAULTS.retries})
  --wait-timeout-ms <n>    default budget for wait/run tools (DSH_WAIT_TIMEOUT_MS, default ${DEFAULTS.waitTimeoutMs})
  --poll-interval-ms <n>   running-flag poll cadence (DSH_POLL_INTERVAL_MS, default ${DEFAULTS.pollIntervalMs})

MCP transport:
  --http                   streamable HTTP instead of stdio (DSH_MCP_HTTP=1)
  --stdio                  force stdio
  --host <addr>            HTTP bind address (DSH_HTTP_HOST, default ${DEFAULTS.httpHost})
  --port <n>               HTTP port         (DSH_HTTP_PORT, default ${DEFAULTS.httpPort})
  --path <p>               HTTP endpoint path (DSH_HTTP_PATH, default ${DEFAULTS.httpPath})
  --http-token <token>     require "Authorization: Bearer <token>" on the MCP endpoint (DSH_HTTP_TOKEN)

Safety:
  --allow-raw-call         expose dsh_call (raw /api passthrough). OFF by default. See README warning.

Misc:
  --print-config           print the resolved config (token redacted) and exit
  --help, --version

Examples:
  node src/index.js --base http://127.0.0.1:3080
  node src/index.js --http --port 8765 --base https://dsh.example.com --token "$DSH_TOKEN"
  DSH_BASE=http://127.0.0.1:31811 node src/index.js        # base URL is fully configurable
`;