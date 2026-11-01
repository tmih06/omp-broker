#!/usr/bin/env bun
/**
 * Development orchestrator: starts the broker and the Vite console in one
 * foreground process, so `bun run dev` needs no second terminal.
 *
 * Contract:
 * - The broker owns `OMP_BROKER_BIND` (default `127.0.0.1:4000`); Vite is
 *   started with `--strictPort` on the next free port from 5173 so a silently
 *   different origin can never be reported as success.
 * - Vite proxies `/api` to the same broker address via `VITE_BROKER_PROXY_TARGET`,
 *   which `web/vite.config.ts` already understands; exports are inherited by
 *   both children.
 * - Both children inherit stdio, and `[broker]`/`[web]` are not prefixed: Vite's
 *   own output stays intact for the human reading it. Exit of either child
 *   tears the other down; Ctrl-C forwards SIGINT to both and exits 0.
 * - Extra args after `bun run dev --` go to the web dev server, so
 *   `bun run dev -- --host 0.0.0.0` exposes the console without touching the
 *   broker, whose exposure is governed by `OMP_BROKER_BIND` alone.
 */
import { type Subprocess } from "bun";
import { createServer } from "node:net";

const root = new URL("..", import.meta.url).pathname;
const webDir = new URL("../web", import.meta.url).pathname;

/** Split `host:port`, defaulting the host the way `src/config.ts` does. */
function splitBind(bind: string): { hostname: string; port: number } {
	const index = bind.lastIndexOf(":");
	const hostname = index === -1 ? "127.0.0.1" : bind.slice(0, index) || "127.0.0.1";
	const port = index === -1 ? Number(bind) : Number(bind.slice(index + 1));
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid OMP_BROKER_BIND "${bind}"; expected host:port.`);
	}
	return { hostname: hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname, port };
}

/** Resolve true when nothing accepts connections on the TCP endpoint. */
function portFree(hostname: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const server = createServer();
	server.once("error", () => resolve(false));
	server.once("listening", () => server.close(() => resolve(true)));
	server.listen(port, hostname);
	return promise;
}

/** First free port at or above `start`, probing at most `span` ports. */
async function freePort(hostname: string, start: number, span = 20): Promise<number> {
	for (let port = start; port < start + span; port++) {
		if (await portFree(hostname, port)) return port;
	}
	throw new Error(`No free web port in ${start}-${start + span - 1}; stop the process holding it.`);
}

const bind = splitBind(process.env.OMP_BROKER_BIND?.trim() || "127.0.0.1:4000");
const brokerOrigin = `http://${bind.hostname}:${bind.port}`;
const webPort = await freePort("127.0.0.1", Number(process.env.OMP_WEB_PORT?.trim() || 5173));

// Start checking before the children boot so a busy port is reported once,
// with both PIDs, instead of as two unrelated crash logs.
if (!(await portFree(bind.hostname, bind.port))) {
	console.error(`Broker port ${bind.hostname}:${bind.port} is already in use.`);
	console.error("Stop the other process or set OMP_BROKER_BIND to a free host:port.");
	process.exit(1);
}

const children: Subprocess<"inherit", "inherit", "inherit">[] = [];
let shuttingDown = false;

/** Stop both children, then exit with the code of whichever failed first. */
async function shutdown(code: number, signal?: NodeJS.Signals): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	if (signal) console.log(`\n${signal} received; shutting down`);
	for (const child of children) child.kill(signal ?? "SIGTERM");
	await Promise.all(
		children.map(child => Promise.race([child.exited, Bun.sleep(5_000).then(() => child.kill("SIGKILL"))])),
	);
	process.exit(code);
}

const broker = Bun.spawn(["bun", "run", "src/cli.ts", "serve", `--bind=${bind.hostname}:${bind.port}`], {
	cwd: root,
	env: { ...process.env, OMP_BROKER_BIND: `${bind.hostname}:${bind.port}` },
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
children.push(broker);
void broker.exited.then(code => {
	if (!shuttingDown) console.error(`\nbroker exited (${code})`);
	void shutdown(code ?? 0);
});

// Wait for the broker to answer `/healthz` so the console never opens against
// a dead proxy target. 15s covers first-run native-addon extraction.
const deadline = Date.now() + 15_000;
let healthy = false;
while (Date.now() < deadline) {
	if (broker.exitCode !== null) break;
	try {
		const response = await fetch(`${brokerOrigin}/healthz`, { signal: AbortSignal.timeout(1_000) });
		if (response.ok) {
			healthy = true;
			break;
		}
	} catch {
		// Not listening yet.
	}
	await Bun.sleep(200);
}
if (!healthy && !shuttingDown) {
	console.error(`\nbroker did not become healthy at ${brokerOrigin}/healthz within 15s.`);
	await shutdown(1);
}

console.log(`\n  web console  http://127.0.0.1:${webPort}`);
console.log(`  broker       ${brokerOrigin}`);
console.log(`  admin token  bun run token\n`);

const web = Bun.spawn(
	["bun", "run", "dev", "--", "--port", String(webPort), "--strictPort", ...process.argv.slice(2)],
	{
		cwd: webDir,
		env: { ...process.env, VITE_BROKER_PROXY_TARGET: brokerOrigin },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);
children.push(web);
void web.exited.then(code => {
	if (!shuttingDown) console.error(`\nweb console exited (${code})`);
	void shutdown(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => void shutdown(0, signal));
}
