import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { brokerHome, resolveUserPath } from "./config";

export type BudgetPeriod = "daily" | "monthly" | "total";
export type ApiKeyStatus = "active" | "revoked" | "expired";

export interface ApiKey {
	id: number;
	name: string;
	/** First characters of the secret, safe to display. */
	keyPrefix: string;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
	expiresAt: number | null;
	budgetUsd: number | null;
	budgetPeriod: BudgetPeriod;
	requestLimit: number | null;
	/** Empty means every model is allowed. `*` matches any run of characters. */
	allowedModels: string[];
	/** Applied after the allow list. */
	blockedModels: string[];
	/** Empty means every client address is allowed. */
	allowedIps: string[];
}

export interface ApiKeyInput {
	name: string;
	budgetUsd?: number | null;
	budgetPeriod?: BudgetPeriod;
	requestLimit?: number | null;
	allowedModels?: string[];
	blockedModels?: string[];
	allowedIps?: string[];
	expiresAt?: number | null;
}

export interface ApiKeyUpdate {
	name?: string;
	budgetUsd?: number | null;
	budgetPeriod?: BudgetPeriod;
	requestLimit?: number | null;
	allowedModels?: string[];
	blockedModels?: string[];
	allowedIps?: string[];
	expiresAt?: number | null;
}

export interface CreatedApiKey {
	apiKey: ApiKey;
	/** Shown once; only its SHA-256 hash is persisted. */
	key: string;
}

export interface ApiKeyOptions {
	dbPath?: string;
}

interface ApiKeyRow {
	id: number;
	name: string;
	key_prefix: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
	expires_at: number | null;
	budget_usd: number | null;
	budget_period: string;
	request_limit: number | null;
	allowed_models: string;
	blocked_models: string;
	allowed_ips: string;
}

const KEY_PREFIX = "omp_sk_";
const PERIODS: Record<string, true> = { daily: true, monthly: true, total: true };
const SQL_COLUMNS =
	"id, name, key_prefix, created_at, last_used_at, revoked_at, expires_at, budget_usd, budget_period, request_limit, allowed_models, blocked_models, allowed_ips";

function hashKey(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

function trimmedList(values: string[] | undefined, label: string): string[] {
	if (values === undefined) return [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) throw new Error(`${label} entries cannot be empty`);
		if (trimmed.length > 200) throw new Error(`${label} entries are too long`);
		seen.add(trimmed);
	}
	return [...seen];
}

function parseList(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function periodOf(value: string | undefined): BudgetPeriod {
	const period = (value ?? "monthly").toLowerCase();
	if (!Object.hasOwn(PERIODS, period)) throw new Error(`budget period must be daily, monthly, or total`);
	return period as BudgetPeriod;
}

function numberOrNull(value: number | null | undefined, label: string, integer = false): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
	return integer ? Math.round(value) : value;
}

function toApiKey(row: ApiKeyRow): ApiKey {
	return {
		id: row.id,
		name: row.name,
		keyPrefix: row.key_prefix,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
		expiresAt: row.expires_at,
		budgetUsd: row.budget_usd,
		budgetPeriod: periodOf(row.budget_period),
		requestLimit: row.request_limit,
		allowedModels: parseList(row.allowed_models),
		blockedModels: parseList(row.blocked_models),
		allowedIps: parseList(row.allowed_ips),
	};
}

export function apiKeyStatus(key: ApiKey, now = Date.now()): ApiKeyStatus {
	if (key.revokedAt !== null) return "revoked";
	if (key.expiresAt !== null && key.expiresAt <= now) return "expired";
	return "active";
}

/** Start of the current budget window in epoch milliseconds. */
export function budgetWindowStart(period: BudgetPeriod, now = Date.now()): number {
	if (period === "total") return 0;
	const date = new Date(now);
	if (period === "daily") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function escapeRegex(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact match, with `*` matching any run of characters. */
function matches(pattern: string, value: string): boolean {
	if (!pattern.includes("*")) return pattern === value;
	return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`).test(value);
}

/** Checks the requested model id and its provider-qualified id against the key policy. */
export function isModelAllowed(
	key: Pick<ApiKey, "allowedModels" | "blockedModels">,
	modelId: string,
	provider?: string,
): boolean {
	const qualified = provider ? `${provider}/${modelId}` : modelId;
	const hit = (pattern: string) => matches(pattern, modelId) || matches(pattern, qualified);
	if (key.blockedModels.some(hit)) return false;
	if (key.allowedModels.length === 0) return true;
	return key.allowedModels.some(hit);
}

function normalizeIp(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

/** Exact address allowlisting. An empty list allows every peer. */
export function isIpAllowed(key: Pick<ApiKey, "allowedIps">, client: string): boolean {
	if (key.allowedIps.length === 0) return true;
	const address = normalizeIp(client);
	return key.allowedIps.some(entry => normalizeIp(entry) === address);
}

/**
 * SQLite-backed virtual API keys. The secret is SHA-256 hashed before storage;
 * only create returns the plaintext. Keys are soft-revoked so request history
 * keeps a stable attribution id.
 */
export class ApiKeyStore {
	readonly path: string;
	readonly #db: Database;
	readonly #insert: Statement;
	readonly #lookup: Statement;
	readonly #touch: Statement;
	readonly #revoke: Statement;
	#closed = false;

	private constructor(dbPath: string) {
		this.path = dbPath;
		mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		this.#db = new Database(dbPath, { create: true });
		try {
			chmodSync(dbPath, 0o600);
		} catch {
			// The parent directory is private; filesystems without chmod still work.
		}
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS api_keys (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				key_hash TEXT NOT NULL UNIQUE,
				key_prefix TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_used_at INTEGER,
				revoked_at INTEGER,
				expires_at INTEGER,
				budget_usd REAL,
				budget_period TEXT NOT NULL DEFAULT 'monthly',
				request_limit INTEGER,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				blocked_models TEXT NOT NULL DEFAULT '[]',
				allowed_ips TEXT NOT NULL DEFAULT '[]'
			);
		`);
		this.#insert = this.#db.query(
			`INSERT INTO api_keys (name, key_hash, key_prefix, created_at, expires_at, budget_usd, budget_period,
				request_limit, allowed_models, blocked_models, allowed_ips)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.#lookup = this.#db.query(`SELECT ${SQL_COLUMNS} FROM api_keys WHERE key_hash = ?`);
		this.#touch = this.#db.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?");
		this.#revoke = this.#db.query("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
	}

	static open(options: ApiKeyOptions = {}): ApiKeyStore {
		const configured = options.dbPath?.trim() || process.env.OMP_BROKER_KEYS_DB?.trim();
		const dbPath = configured ? resolveUserPath(configured) : path.join(brokerHome(), "keys.db");
		return new ApiKeyStore(dbPath);
	}

	create(input: ApiKeyInput): CreatedApiKey {
		if (this.#closed) throw new Error("API key store is closed");
		const name = input.name.trim();
		if (!name) throw new Error("API key name is required");
		if (name.length > 80) throw new Error("API key name is too long");
		const secret = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
		const period = periodOf(input.budgetPeriod);
		const budgetUsd = numberOrNull(input.budgetUsd, "budgetUsd");
		const requestLimit =
			input.requestLimit === undefined || input.requestLimit === null
				? null
				: Math.max(1, numberOrNull(input.requestLimit, "requestLimit", true) ?? 1);
		const expiresAt = numberOrNull(input.expiresAt, "expiresAt", true);
		const now = Date.now();
		const result = this.#insert.run(
			name,
			hashKey(secret),
			secret.slice(0, 12),
			now,
			expiresAt,
			budgetUsd,
			period,
			requestLimit,
			JSON.stringify(trimmedList(input.allowedModels, "allowedModels")),
			JSON.stringify(trimmedList(input.blockedModels, "blockedModels")),
			JSON.stringify(trimmedList(input.allowedIps, "allowedIps")),
		);
		const id = Number(result.lastInsertRowid);
		const apiKey = this.get(id);
		if (!apiKey) throw new Error("API key insert did not persist");
		return { apiKey, key: secret };
	}

	/** Finds a key by its presented secret, regardless of revocation or expiry. */
	lookup(secret: string): ApiKey | undefined {
		if (this.#closed) return undefined;
		const row = this.#lookup.get(hashKey(secret)) as ApiKeyRow | null;
		return row ? toApiKey(row) : undefined;
	}

	/** Best-effort last-used stamp; never throws into the request path. */
	touch(id: number, at = Date.now()): void {
		if (this.#closed) return;
		try {
			this.#touch.run(at, id);
		} catch {
			// Request history still identifies the key even if this stamp fails.
		}
	}

	get(id: number): ApiKey | undefined {
		if (this.#closed) return undefined;
		const row = this.#db.query(`SELECT ${SQL_COLUMNS} FROM api_keys WHERE id = ?`).get(id) as ApiKeyRow | null;
		return row ? toApiKey(row) : undefined;
	}

	list(): ApiKey[] {
		if (this.#closed) return [];
		const rows = this.#db.query(`SELECT ${SQL_COLUMNS} FROM api_keys ORDER BY id DESC`).all() as ApiKeyRow[];
		return rows.map(toApiKey);
	}

	update(id: number, patch: ApiKeyUpdate): ApiKey | undefined {
		if (this.#closed) return undefined;
		const current = this.get(id);
		if (!current) return undefined;
		const assignments: string[] = [];
		const values: (string | number | null)[] = [];
		const set = (column: string, value: string | number | null) => {
			assignments.push(`${column} = ?`);
			values.push(value);
		};
		if (patch.name !== undefined) {
			const name = patch.name.trim();
			if (!name) throw new Error("API key name is required");
			if (name.length > 80) throw new Error("API key name is too long");
			set("name", name);
		}
		if (patch.budgetUsd !== undefined) set("budget_usd", numberOrNull(patch.budgetUsd, "budgetUsd"));
		if (patch.budgetPeriod !== undefined) set("budget_period", periodOf(patch.budgetPeriod));
		if (patch.requestLimit !== undefined) {
			const limit =
				patch.requestLimit === null ? null : Math.max(1, numberOrNull(patch.requestLimit, "requestLimit", true) ?? 1);
			set("request_limit", limit);
		}
		if (patch.allowedModels !== undefined) {
			set("allowed_models", JSON.stringify(trimmedList(patch.allowedModels, "allowedModels")));
		}
		if (patch.blockedModels !== undefined) {
			set("blocked_models", JSON.stringify(trimmedList(patch.blockedModels, "blockedModels")));
		}
		if (patch.allowedIps !== undefined) {
			set("allowed_ips", JSON.stringify(trimmedList(patch.allowedIps, "allowedIps")));
		}
		if (patch.expiresAt !== undefined) set("expires_at", numberOrNull(patch.expiresAt, "expiresAt", true));
		if (assignments.length === 0) return current;
		values.push(id);
		this.#db.query(`UPDATE api_keys SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
		return this.get(id);
	}

	revoke(id: number, at = Date.now()): ApiKey | undefined {
		if (this.#closed) return undefined;
		this.#revoke.run(at, id);
		return this.get(id);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}
}

function objectOf(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("request body must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function optionalNumber(value: unknown, label: string, integer = false): number | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number`);
	if (value < 0) throw new Error(`${label} must be a non-negative number`);
	return integer ? Math.round(value) : value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new Error(`${label} must be an array of strings`);
	}
	return value;
}

function optionalPeriod(value: unknown): BudgetPeriod | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !Object.hasOwn(PERIODS, value)) {
		throw new Error("budgetPeriod must be daily, monthly, or total");
	}
	return value as BudgetPeriod;
}

/** Validates the JSON body of `POST /v1/keys`. */
export function parseApiKeyInput(value: unknown): ApiKeyInput {
	const body = objectOf(value);
	if (typeof body.name !== "string") throw new Error("name is required");
	const input: ApiKeyInput = { name: body.name };
	const budgetUsd = optionalNumber(body.budgetUsd, "budgetUsd");
	if (budgetUsd !== undefined) input.budgetUsd = budgetUsd;
	const budgetPeriod = optionalPeriod(body.budgetPeriod);
	if (budgetPeriod !== undefined) input.budgetPeriod = budgetPeriod;
	const requestLimit = optionalNumber(body.requestLimit, "requestLimit", true);
	if (requestLimit !== undefined) input.requestLimit = requestLimit;
	const allowedModels = optionalStringArray(body.allowedModels, "allowedModels");
	if (allowedModels !== undefined) input.allowedModels = allowedModels;
	const blockedModels = optionalStringArray(body.blockedModels, "blockedModels");
	if (blockedModels !== undefined) input.blockedModels = blockedModels;
	const allowedIps = optionalStringArray(body.allowedIps, "allowedIps");
	if (allowedIps !== undefined) input.allowedIps = allowedIps;
	const expiresAt = optionalNumber(body.expiresAt, "expiresAt", true);
	if (expiresAt !== undefined) input.expiresAt = expiresAt;
	return input;
}

/** Validates the JSON body of `PATCH /v1/keys/:id`; only present fields change. */
export function parseApiKeyUpdate(value: unknown): ApiKeyUpdate {
	const body = objectOf(value);
	const patch: ApiKeyUpdate = {};
	if (Object.hasOwn(body, "name")) {
		if (typeof body.name !== "string") throw new Error("name must be a string");
		patch.name = body.name;
	}
	if (Object.hasOwn(body, "budgetUsd")) {
		const budgetUsd = optionalNumber(body.budgetUsd, "budgetUsd");
		patch.budgetUsd = budgetUsd === undefined ? null : budgetUsd;
	}
	if (Object.hasOwn(body, "budgetPeriod")) {
		const budgetPeriod = optionalPeriod(body.budgetPeriod);
		if (budgetPeriod === undefined) throw new Error("budgetPeriod must be daily, monthly, or total");
		patch.budgetPeriod = budgetPeriod;
	}
	if (Object.hasOwn(body, "requestLimit")) {
		const requestLimit = optionalNumber(body.requestLimit, "requestLimit", true);
		patch.requestLimit = requestLimit === undefined ? null : requestLimit;
	}
	if (Object.hasOwn(body, "allowedModels")) {
		patch.allowedModels = optionalStringArray(body.allowedModels, "allowedModels") ?? [];
	}
	if (Object.hasOwn(body, "blockedModels")) {
		patch.blockedModels = optionalStringArray(body.blockedModels, "blockedModels") ?? [];
	}
	if (Object.hasOwn(body, "allowedIps")) {
		patch.allowedIps = optionalStringArray(body.allowedIps, "allowedIps") ?? [];
	}
	if (Object.hasOwn(body, "expiresAt")) {
		const expiresAt = optionalNumber(body.expiresAt, "expiresAt", true);
		patch.expiresAt = expiresAt === undefined ? null : expiresAt;
	}
	if (Object.keys(patch).length === 0) throw new Error("no supported fields supplied");
	return patch;
}
