import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { brokerHome, resolveUserPath } from "./config";
import type { CapturedUsage } from "./usage-capture";

export type EndpointBucket = "chat" | "messages" | "responses" | "other";

export interface RequestLogEntry {
	id: number;
	at: number;
	method: string;
	path: string;
	status: number;
	durationMs: number;
	client: string | null;
	error: string | null;
	/** Model id requested by the client. */
	model: string | null;
	/** Provider resolved for that model, when the catalog knows it. */
	provider: string | null;
	/** Gateway-generated request id, shared with the response headers. */
	requestId: string | null;
	stream: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
	/** Notional catalog cost in USD; null when the model or usage is unknown. */
	costUsd: number | null;
}

export interface RequestLogInput {
	at?: number;
	method: string;
	path: string;
	status: number;
	durationMs: number;
	client?: string | null;
	error?: string | null;
	model?: string | null;
	provider?: string | null;
	requestId?: string | null;
	stream?: boolean;
	tokens?: CapturedUsage | null;
	costUsd?: number | null;
}

export interface RequestLogListOptions {
	limit?: number;
	before?: number;
}

export interface RequestLogSummary {
	requests: number;
	errors: number;
	/** Percentage of the last 24 hours that returned under 400. Null when no request was recorded. */
	successRate: number | null;
	/** 95th percentile handling time in milliseconds. Null when no request was recorded. */
	p95Ms: number | null;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
		total: number;
	};
	costUsd: number;
}

export interface RequestLogSeriesPoint {
	date: string;
	requests: number;
	errors: number;
}

export interface RequestLogUsagePoint {
	/** UTC midnight of the day. */
	at: number;
	counts: Record<EndpointBucket, number>;
	errors: number;
}

export interface RequestLogEndpoint {
	path: string;
	requests: number;
	errors: number;
}

export interface RequestLogStats {
	generatedAt: number;
	days: number;
	summary: RequestLogSummary;
	series: RequestLogSeriesPoint[];
	/** One entry per day for the last 30 days, oldest first. */
	usage: RequestLogUsagePoint[];
	endpoints: RequestLogEndpoint[];
}

export interface RequestLogOptions {
	/** SQLite path. Defaults to `$OMP_BROKER_LOG_DB` or `$OMP_BROKER_HOME/requests.db`. */
	dbPath?: string;
	/** Rows kept before old entries are pruned. Defaults to 10,000. */
	maxEntries?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX_ENTRIES = 10_000;

const SQL_COLUMNS =
	"id, at, method, path, status, duration_ms, client, error, model, provider, request_id, stream, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_usd";

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function startOfUtcDay(ms: number): number {
	const date = new Date(ms);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Groups API paths into the four stacks the usage widget draws. */
export function endpointBucket(pathname: string): EndpointBucket {
	if (pathname === "/v1/chat/completions") return "chat";
	if (pathname === "/v1/messages") return "messages";
	if (pathname === "/v1/responses") return "responses";
	return "other";
}

/**
 * SQLite-backed request history for the gateway. One write per handled
 * request; reads power the logs page and dashboard aggregates. The writer
 * never throws into the request path: a full disk or locked database only
 * logs a warning.
 */
export class RequestLog {
	readonly path: string;
	readonly #db: Database;
	readonly #insert: Statement;
	readonly #updateUsage: Statement;
	readonly #prune: Statement;
	readonly #maxEntries: number;
	#writes = 0;
	#closed = false;

	private constructor(dbPath: string, maxEntries: number) {
		this.path = dbPath;
		this.#maxEntries = maxEntries;
		mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		this.#db = new Database(dbPath, { create: true });
		try {
			chmodSync(dbPath, 0o600);
		} catch {
			// The parent directory is private; a filesystem without chmod still works.
		}
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS requests (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at INTEGER NOT NULL,
				method TEXT NOT NULL,
				path TEXT NOT NULL,
				status INTEGER NOT NULL,
				duration_ms INTEGER NOT NULL,
				client TEXT,
				error TEXT,
				model TEXT,
				provider TEXT,
				request_id TEXT,
				stream INTEGER NOT NULL DEFAULT 0,
				input_tokens INTEGER,
				output_tokens INTEGER,
				cache_read_tokens INTEGER,
				cache_write_tokens INTEGER,
				reasoning_tokens INTEGER,
				total_tokens INTEGER,
				cost_usd REAL
			);
			CREATE INDEX IF NOT EXISTS requests_at ON requests (at);
		`);
		const columns = new Set(
			(this.#db.query("PRAGMA table_info(requests)").all() as { name: string }[]).map(row => row.name),
		);
		const additions: readonly (readonly [string, string])[] = [
			["model", "TEXT"],
			["provider", "TEXT"],
			["request_id", "TEXT"],
			["stream", "INTEGER NOT NULL DEFAULT 0"],
			["input_tokens", "INTEGER"],
			["output_tokens", "INTEGER"],
			["cache_read_tokens", "INTEGER"],
			["cache_write_tokens", "INTEGER"],
			["reasoning_tokens", "INTEGER"],
			["total_tokens", "INTEGER"],
			["cost_usd", "REAL"],
		];
		for (const [name, declaration] of additions) {
			if (!columns.has(name)) this.#db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${declaration}`);
		}
		this.#insert = this.#db.query(
			`INSERT INTO requests (at, method, path, status, duration_ms, client, error, model, provider, request_id, stream,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_usd)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.#updateUsage = this.#db.query(
			`UPDATE requests SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
				reasoning_tokens = ?, total_tokens = ?, cost_usd = ? WHERE id = ?`,
		);
		this.#prune = this.#db.query("DELETE FROM requests WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM requests)");
	}

	/** Opens or creates the log. Throws only when the database cannot be opened. */
	static open(options: RequestLogOptions = {}): RequestLog {
		const configured = options.dbPath?.trim() || process.env.OMP_BROKER_LOG_DB?.trim();
		const dbPath = configured ? resolveUserPath(configured) : path.join(brokerHome(), "requests.db");
		const envMax = Number.parseInt(process.env.OMP_BROKER_LOG_MAX_ENTRIES ?? "", 10);
		const maxEntries = clamp(
			Math.round(options.maxEntries ?? (Number.isFinite(envMax) ? envMax : DEFAULT_MAX_ENTRIES)),
			100,
			100_000,
		);
		return new RequestLog(dbPath, maxEntries);
	}

	/** Records one handled request and returns its row id. Old rows are pruned every hundred writes. */
	record(entry: RequestLogInput): number | undefined {
		if (this.#closed) return undefined;
		const tokens = entry.tokens;
		try {
			const id = Number(
				this.#insert.run(
					entry.at ?? Date.now(),
					entry.method.slice(0, 16),
					entry.path.slice(0, 512),
					entry.status,
					Math.max(0, Math.round(entry.durationMs)),
					entry.client?.slice(0, 128) ?? null,
					entry.error?.slice(0, 500) ?? null,
					entry.model?.slice(0, 200) ?? null,
					entry.provider?.slice(0, 80) ?? null,
					entry.requestId?.slice(0, 128) ?? null,
					entry.stream ? 1 : 0,
					tokens?.input ?? null,
					tokens?.output ?? null,
					tokens?.cacheRead ?? null,
					tokens?.cacheWrite ?? null,
					tokens?.reasoningTokens ?? null,
					tokens?.totalTokens ?? null,
					entry.costUsd ?? null,
				).lastInsertRowid,
			);
			if (++this.#writes % 100 === 0) this.#prune.run(this.#maxEntries);
			return id;
		} catch (error) {
			console.error("request log write failed:", error instanceof Error ? error.message : error);
			return undefined;
		}
	}

	/** Fills token and cost columns once a streamed response has produced usage. */
	attachUsage(id: number, usage: CapturedUsage, costUsd?: number | null): void {
		if (this.#closed) return;
		try {
			this.#updateUsage.run(
				usage.input,
				usage.output,
				usage.cacheRead,
				usage.cacheWrite,
				usage.reasoningTokens ?? null,
				usage.totalTokens,
				costUsd ?? null,
				id,
			);
		} catch (error) {
			console.error("request log usage update failed:", error instanceof Error ? error.message : error);
		}
	}

	/** Newest first. `before` is exclusive, so pages do not repeat an entry. */
	list(options: RequestLogListOptions = {}): RequestLogEntry[] {
		if (this.#closed) return [];
		const limit = clamp(Math.round(options.limit ?? 50), 1, 200);
		const rows = options.before
			? this.#db
					.query(`SELECT ${SQL_COLUMNS} FROM requests WHERE id < ? ORDER BY id DESC LIMIT ?`)
					.all(options.before, limit)
			: this.#db.query(`SELECT ${SQL_COLUMNS} FROM requests ORDER BY id DESC LIMIT ?`).all(limit);
		return (rows as Record<string, unknown>[]).map(row => ({
			id: Number(row.id),
			at: Number(row.at),
			method: String(row.method),
			path: String(row.path),
			status: Number(row.status),
			durationMs: Number(row.duration_ms),
			client: row.client === null ? null : String(row.client),
			error: row.error === null ? null : String(row.error),
			model: row.model === null ? null : String(row.model),
			provider: row.provider === null ? null : String(row.provider),
			requestId: row.request_id === null ? null : String(row.request_id),
			stream: Number(row.stream) === 1,
			inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
			outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
			cacheReadTokens: row.cache_read_tokens === null ? null : Number(row.cache_read_tokens),
			cacheWriteTokens: row.cache_write_tokens === null ? null : Number(row.cache_write_tokens),
			reasoningTokens: row.reasoning_tokens === null ? null : Number(row.reasoning_tokens),
			totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
			costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
		}));
	}

	/**
	 * Aggregates the dashboard's widgets. `series` covers `days`; `usage` always
	 * covers 30 days so the stacked bars can switch between day and week view.
	 */
	stats(days = 7, now = Date.now()): RequestLogStats {
		const range = clamp(Math.round(days), 1, 30);
		const rangeStart = startOfUtcDay(now) - (range - 1) * DAY_MS;
		const last24 = now - DAY_MS;
		if (this.#closed) {
			return {
				generatedAt: now,
				days: range,
				summary: {
					requests: 0,
					errors: 0,
					successRate: null,
					p95Ms: null,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
					costUsd: 0,
				},
				series: [],
				usage: [],
				endpoints: [],
			};
		}

		const summaryRow = this.#db
			.query(
				`SELECT COUNT(*) AS requests,
					COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
					COALESCE(SUM(input_tokens), 0) AS input_tokens,
					COALESCE(SUM(output_tokens), 0) AS output_tokens,
					COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
					COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
					COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
					COALESCE(SUM(total_tokens), 0) AS total_tokens,
					COALESCE(SUM(cost_usd), 0) AS cost_usd
				FROM requests WHERE at >= ?`,
			)
			.get(last24) as {
			requests: number;
			errors: number;
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens: number;
			cache_write_tokens: number;
			reasoning_tokens: number;
			total_tokens: number;
			cost_usd: number;
		};
		const durations = this.#db
			.query("SELECT duration_ms FROM requests WHERE at >= ? ORDER BY duration_ms")
			.all(last24) as { duration_ms: number }[];
		const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
		const p95Ms = durations.length > 0 ? (durations[p95Index]?.duration_ms ?? null) : null;

		const rows = this.#db
			.query(
				`SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, path,
					COUNT(*) AS requests,
					COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
				FROM requests WHERE at >= ?
				GROUP BY day, path`,
			)
			.all(rangeStart) as { day: string; path: string; requests: number; errors: number }[];

		const seriesMap = new Map<string, { requests: number; errors: number }>();
		const endpointMap = new Map<string, { requests: number; errors: number }>();
		for (const row of rows) {
			const day = seriesMap.get(row.day) ?? { requests: 0, errors: 0 };
			day.requests += row.requests;
			day.errors += row.errors;
			seriesMap.set(row.day, day);
			const endpoint = endpointMap.get(row.path) ?? { requests: 0, errors: 0 };
			endpoint.requests += row.requests;
			endpoint.errors += row.errors;
			endpointMap.set(row.path, endpoint);
		}

		const series: RequestLogSeriesPoint[] = Array.from({ length: range }, (_, index) => {
			const date = isoDay(rangeStart + index * DAY_MS);
			const point = seriesMap.get(date);
			return { date, requests: point?.requests ?? 0, errors: point?.errors ?? 0 };
		});

		const usageStart = startOfUtcDay(now) - 29 * DAY_MS;
		const usageRows = this.#db
			.query(
				`SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, path,
					COUNT(*) AS requests,
					COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
				FROM requests WHERE at >= ?
				GROUP BY day, path`,
			)
			.all(usageStart) as { day: string; path: string; requests: number; errors: number }[];
		const usageIndex = new Map<string, number>();
		const usage: RequestLogUsagePoint[] = Array.from({ length: 30 }, (_, index) => {
			const at = usageStart + index * DAY_MS;
			usageIndex.set(isoDay(at), index);
			return { at, counts: { chat: 0, messages: 0, responses: 0, other: 0 }, errors: 0 };
		});
		for (const row of usageRows) {
			const index = usageIndex.get(row.day);
			const point = index === undefined ? undefined : usage[index];
			if (!point) continue;
			point.counts[endpointBucket(row.path)] += row.requests;
			point.errors += row.errors;
		}

		const total = summaryRow?.requests ?? 0;
		const errors = summaryRow?.errors ?? 0;
		const endpoints = [...endpointMap.entries()]
			.map(([pathname, value]) => ({ path: pathname, ...value }))
			.sort((a, b) => b.requests - a.requests)
			.slice(0, 20);

		return {
			generatedAt: now,
			days: range,
			summary: {
				requests: total,
				errors,
				successRate: total > 0 ? Math.round(((total - errors) / total) * 1000) / 10 : null,
				p95Ms,
				tokens: {
					input: Number(summaryRow?.input_tokens ?? 0),
					output: Number(summaryRow?.output_tokens ?? 0),
					cacheRead: Number(summaryRow?.cache_read_tokens ?? 0),
					cacheWrite: Number(summaryRow?.cache_write_tokens ?? 0),
					reasoning: Number(summaryRow?.reasoning_tokens ?? 0),
					total: Number(summaryRow?.total_tokens ?? 0),
				},
				costUsd: Number(summaryRow?.cost_usd ?? 0),
			},
			series,
			usage,
			endpoints,
		};
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}
}
