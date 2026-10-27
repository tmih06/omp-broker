import * as path from "node:path";
import { mkdir } from "node:fs/promises";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { defaultDbPath, resolveUserPath } from "./config";

export interface StorageOptions {
	/** Explicit SQLite path. Implies local mode. */
	db?: string;
	/** Force the omp credential store (local agent.db or configured auth broker). */
	omp?: boolean;
	/** Use the gateway-owned SQLite store instead of omp's. */
	isolated?: boolean;
	/** omp profile directory for omp mode. */
	agentDir?: string;
}

export interface OpenedStorage {
	storage: AuthStorage;
	label: string;
	mode: "omp" | "local";
}

/**
 * Opens the credential store.
 *
 * Default is the same store `omp` uses: `discoverAuthStorage()` understands
 * `~/.omp/config.yml`, the remote auth-broker, and the local agent.db, so
 * existing subscription logins work without a second login. `--isolated` or
 * `--db` keeps the gateway on its own SQLite file instead.
 */
export async function openStorage(options: StorageOptions = {}): Promise<OpenedStorage> {
	const envDb = process.env.OMP_GATEWAY_DB?.trim();
	const db = options.db?.trim() || envDb || undefined;
	if (db) {
		const resolved = resolveUserPath(db);
		await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
		return { storage: await AuthStorage.create(resolved), label: `local ${resolved}`, mode: "local" };
	}

	const envMode = (process.env.OMP_GATEWAY_STORAGE ?? "").trim().toLowerCase();
	const isolated = options.isolated || (!options.omp && envMode === "local");
	if (isolated) {
		const resolved = defaultDbPath();
		await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
		return { storage: await AuthStorage.create(resolved), label: `local ${resolved}`, mode: "local" };
	}

	const agentDir = options.agentDir?.trim() || process.env.OMP_GATEWAY_AGENT_DIR?.trim() || undefined;
	const storage = await discoverAuthStorage(agentDir ? { agentDir: resolveUserPath(agentDir) } : {});
	return { storage, label: "omp credentials (local agent.db or configured auth broker)", mode: "omp" };
}
