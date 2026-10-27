import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export const VERSION = "0.2.0";
export const DEFAULT_BIND = "127.0.0.1:4000";

/**
 * Subscription providers win bare-model lookups (e.g. two providers exposing
 * `claude-sonnet-4-5`), then everything else alphabetically.
 */
export const DEFAULT_PROVIDER_ORDER = [
	"anthropic",
	"openai-codex",
	"github-copilot",
	"google-antigravity",
	"google-gemini-cli",
] as const;

export function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
	return path.resolve(trimmed);
}

export function brokerHome(): string {
	const override = process.env.OMP_BROKER_HOME?.trim();
	return override ? resolveUserPath(override) : path.join(homedir(), ".omp-broker");
}

export function defaultDbPath(): string {
	return path.join(brokerHome(), "auth.db");
}

export function tokenFilePath(): string {
	return path.join(brokerHome(), "broker.token");
}

export function providerOrder(): string[] {
	const extra = (process.env.OMP_BROKER_PROVIDER_ORDER ?? "")
		.split(",")
		.map(value => value.trim())
		.filter(Boolean);
	return [...extra, ...DEFAULT_PROVIDER_ORDER];
}

export interface ResolvedToken {
	token: string;
	source: "flag" | "env" | "file";
	path?: string;
}

async function writeTokenFile(token: string): Promise<string> {
	const file = tokenFilePath();
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await writeFile(file, `${token}\n`, { mode: 0o600 });
	await chmod(file, 0o600);
	return file;
}

async function readTokenFile(): Promise<string | undefined> {
	try {
		const token = (await readFile(tokenFilePath(), "utf8")).trim();
		return token.length > 0 ? token : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Resolve the gateway bearer. Precedence: `--token`, `OMP_BROKER_TOKEN`, the
 * token file. A missing or empty file is created on first use.
 */
export async function resolveToken(
	options: {
		explicit?: string;
		regenerate?: boolean;
	} = {},
): Promise<ResolvedToken> {
	const explicit = options.explicit?.trim();
	if (explicit) {
		// Regeneration only owns the file; an explicit or env token still wins.
		if (options.regenerate) await writeTokenFile(randomBytes(32).toString("base64url"));
		return { token: explicit, source: "flag" };
	}

	const env = process.env.OMP_BROKER_TOKEN?.trim();
	if (env) {
		if (options.regenerate) await writeTokenFile(randomBytes(32).toString("base64url"));
		return { token: env, source: "env" };
	}

	let token = options.regenerate ? undefined : await readTokenFile();
	if (!token) token = randomBytes(32).toString("base64url");
	const file = await writeTokenFile(token);
	return { token, source: "file", path: file };
}

export function bindHost(bind: string): string {
	const trimmed = bind.trim();
	if (/^\d+$/.test(trimmed)) return "127.0.0.1";
	const colon = trimmed.lastIndexOf(":");
	let host = colon >= 0 ? trimmed.slice(0, colon) : trimmed;
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	return host;
}

export function bindPort(bind: string): number {
	const trimmed = bind.trim();
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	return Number.parseInt(trimmed.slice(trimmed.lastIndexOf(":") + 1), 10);
}

export function isLoopbackBind(bind: string): boolean {
	const host = bindHost(bind).toLowerCase();
	return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.");
}
