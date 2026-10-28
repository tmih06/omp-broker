import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { RequestLog } from "../src/request-log";

const now = Date.UTC(2026, 9, 27, 12);
const DAY = 86_400_000;

async function withLog(run: (log: RequestLog) => void): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-broker-log-"));
	const log = RequestLog.open({ dbPath: path.join(dir, "requests.db"), maxEntries: 500 });
	try {
		run(log);
	} finally {
		log.close();
		await rm(dir, { recursive: true, force: true });
	}
}

describe("request log", () => {
	test("lists newest first with cursor paging and model metadata", async () => {
		await withLog(log => {
			log.record({ at: now - 3_000, method: "POST", path: "/v1/chat/completions", status: 200, durationMs: 100 });
			log.record({
				at: now - 2_000,
				method: "POST",
				path: "/v1/messages",
				status: 500,
				durationMs: 500,
				error: "upstream failed",
			});
			log.record({
				at: now - 1_000,
				method: "POST",
				path: "/v1/responses",
				status: 201,
				durationMs: 250,
				model: "anthropic/claude-sonnet-4-5",
				provider: "anthropic",
				requestId: "req_123",
				stream: true,
				tokens: {
					input: 100,
					output: 20,
					cacheRead: 50,
					cacheWrite: 10,
					reasoningTokens: 5,
					totalTokens: 180,
				},
				costUsd: 0.0042,
			});

			const page = log.list({ limit: 2 });
			expect(page.map(entry => entry.path)).toEqual(["/v1/responses", "/v1/messages"]);
			expect(page[0]).toMatchObject({
				model: "anthropic/claude-sonnet-4-5",
				provider: "anthropic",
				requestId: "req_123",
				stream: true,
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 50,
				cacheWriteTokens: 10,
				reasoningTokens: 5,
				totalTokens: 180,
				costUsd: 0.0042,
			});
			expect(page[1]).toEqual(expect.objectContaining({ status: 500, error: "upstream failed", durationMs: 500 }));

			const older = log.list({ limit: 10, before: page[1]?.id });
			expect(older.map(entry => entry.path)).toEqual(["/v1/chat/completions"]);
		});
	});

	test("fills token columns after a streamed usage capture", async () => {
		await withLog(log => {
			const id = log.record({
				at: now - 1_000,
				method: "POST",
				path: "/v1/messages",
				status: 200,
				durationMs: 900,
				model: "claude-sonnet-4-5",
				provider: "anthropic",
				requestId: "req_stream",
				stream: true,
			});
			expect(typeof id).toBe("number");
			log.attachUsage(
				id!,
				{ input: 12, output: 4, cacheRead: 8, cacheWrite: 2, reasoningTokens: 1, totalTokens: 26 },
				0.0015,
			);
			expect(log.list({ limit: 1 })[0]).toMatchObject({
				stream: true,
				inputTokens: 12,
				outputTokens: 4,
				cacheReadTokens: 8,
				cacheWriteTokens: 2,
				reasoningTokens: 1,
				totalTokens: 26,
				costUsd: 0.0015,
			});
		});
	});

	test("aggregates the last 24 hours, tokens, a daily series, and 30-day usage", async () => {
		await withLog(log => {
			log.record({
				at: now - 60_000,
				method: "POST",
				path: "/v1/chat/completions",
				status: 200,
				durationMs: 100,
				tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15 },
				costUsd: 0.001,
			});
			log.record({
				at: now - 30_000,
				method: "POST",
				path: "/v1/chat/completions",
				status: 200,
				durationMs: 300,
				tokens: { input: 20, output: 4, cacheRead: 5, cacheWrite: 1, totalTokens: 30 },
				costUsd: 0.002,
			});
			log.record({
				at: now - 10_000,
				method: "POST",
				path: "/v1/messages",
				status: 500,
				durationMs: 500,
				tokens: { input: 7, output: 1, cacheRead: 0, cacheWrite: 2, totalTokens: 10 },
				costUsd: 0.0005,
			});
			log.record({
				at: now - 2 * DAY,
				method: "POST",
				path: "/v1/responses",
				status: 200,
				durationMs: 120,
				tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000 },
			});

			const stats = log.stats(7, now);
			expect(stats.summary).toMatchObject({ requests: 3, errors: 1, successRate: 66.7, p95Ms: 500 });
			expect(stats.summary.tokens).toEqual({
				input: 37,
				output: 7,
				cacheRead: 8,
				cacheWrite: 3,
				reasoning: 0,
				total: 55,
			});
			expect(stats.summary.costUsd).toBeCloseTo(0.0035, 6);
			expect(stats.series).toHaveLength(7);
			expect(stats.series.at(-1)).toEqual({ date: "2026-10-27", requests: 3, errors: 1 });
			expect(stats.series[4]).toEqual({ date: "2026-10-25", requests: 1, errors: 0 });
			expect(stats.usage).toHaveLength(30);
			expect(stats.usage.at(-1)?.counts).toEqual({ chat: 2, messages: 1, responses: 0, other: 0 });
			expect(stats.usage.at(-1)?.errors).toBe(1);
			expect(stats.usage[27]?.counts).toEqual({ chat: 0, messages: 0, responses: 1, other: 0 });
			expect(stats.endpoints).toEqual(
				expect.arrayContaining([
					{ path: "/v1/chat/completions", requests: 2, errors: 0 },
					{ path: "/v1/messages", requests: 1, errors: 1 },
					{ path: "/v1/responses", requests: 1, errors: 0 },
				]),
			);
		});
	});

	test("returns an empty summary for an empty window", async () => {
		await withLog(log => {
			const empty = log.stats(7, now + 365 * DAY);
			expect(empty.summary).toEqual({
				requests: 0,
				errors: 0,
				successRate: null,
				p95Ms: null,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
				costUsd: 0,
			});
			expect(empty.series).toHaveLength(7);
			expect(empty.usage).toHaveLength(30);
		});
	});

	test("migrates a database created with the original schema", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-broker-log-migrate-"));
		const dbPath = path.join(dir, "requests.db");
		const db = new Database(dbPath, { create: true });
		db.exec(`
			CREATE TABLE requests (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at INTEGER NOT NULL,
				method TEXT NOT NULL,
				path TEXT NOT NULL,
				status INTEGER NOT NULL,
				duration_ms INTEGER NOT NULL,
				client TEXT,
				error TEXT
			);
			INSERT INTO requests (at, method, path, status, duration_ms) VALUES (${now - 1_000}, 'GET', '/v1/models', 200, 3);
		`);
		db.close();

		const log = RequestLog.open({ dbPath, maxEntries: 500 });
		try {
			expect(log.list({ limit: 1 })[0]).toMatchObject({
				path: "/v1/models",
				model: null,
				provider: null,
				stream: false,
				totalTokens: null,
			});
			log.record({
				at: now,
				method: "POST",
				path: "/v1/chat/completions",
				status: 200,
				durationMs: 10,
				model: "gpt-5",
				provider: "openai-codex",
				tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
			});
			expect(log.list({ limit: 1 })[0]).toMatchObject({
				model: "gpt-5",
				provider: "openai-codex",
				totalTokens: 5,
			});
		} finally {
			log.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
