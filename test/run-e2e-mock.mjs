/**
 * Run the FULL test suite (protocol + e2e) without a real DSH host.
 *
 * Starts `test/mock-dsh.mjs` on 127.0.0.1:3080 (the default $DSH_BASE), then runs the exact same
 * `node --test` command the package uses, with DSH_BASE pointing at the mock and E2E_WORKSPACE set to
 * this checkout. Exit code is the test runner's exit code.
 *
 *   node test/run-e2e-mock.mjs
 *   DSH_BASE=http://127.0.0.1:3080 node test/run-e2e-mock.mjs   # use an already-running host instead
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockDsh } from './mock-dsh.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env.MOCK_DSH_PORT ?? 3080);
const WORKSPACE = process.env.E2E_WORKSPACE ?? ROOT;

let mock = null;
let base = process.env.DSH_BASE;

if (!base) {
	mock = createMockDsh();
	const addr = await mock.listen(PORT);
	base = `http://127.0.0.1:${addr.port}`;
	console.error(`[run-e2e-mock] mock DSH up at ${base}; workspace=${WORKSPACE}`);
}

const child = spawn(
	process.execPath,
	['--test', '--test-reporter=spec', 'test/protocol.test.mjs', 'test/e2e.test.mjs'],
	{
		cwd: ROOT,
		env: { ...process.env, DSH_BASE: base, E2E_WORKSPACE: WORKSPACE },
		stdio: 'inherit',
	},
);

const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
if (mock) await mock.close();
process.exit(code);
