import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
	test("lists newest first with cursor paging", async () => {
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
			log.record({ at: now - 1_000, method: "POST", path: "/v1/responses", status: 201, durationMs: 250 });

			const page = log.list({ limit: 2 });
			expect(page.map(entry => entry.path)).toEqual(["/v1/responses", "/v1/messages"]);
			expect(page[1]).toEqual(expect.objectContaining({ status: 500, error: "upstream failed", durationMs: 500 }));

			const older = log.list({ limit: 10, before: page[1]?.id });
			expect(older.map(entry => entry.path)).toEqual(["/v1/chat/completions"]);
		});
	});

	test("aggregates the last 24 hours, a daily series, and 30-day usage", async () => {
		await withLog(log => {
			log.record({ at: now - 60_000, method: "POST", path: "/v1/chat/completions", status: 200, durationMs: 100 });
			log.record({ at: now - 30_000, method: "POST", path: "/v1/chat/completions", status: 200, durationMs: 300 });
			log.record({ at: now - 10_000, method: "POST", path: "/v1/messages", status: 500, durationMs: 500 });
			log.record({ at: now - 2 * DAY, method: "POST", path: "/v1/responses", status: 200, durationMs: 120 });

			const stats = log.stats(7, now);
			expect(stats.summary).toEqual({ requests: 3, errors: 1, successRate: 66.7, p95Ms: 500 });
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

	test("returns null percentiles for an empty window", async () => {
		await withLog(log => {
			const empty = log.stats(7, now + 365 * DAY);
			expect(empty.summary).toEqual({ requests: 0, errors: 0, successRate: null, p95Ms: null });
			expect(empty.series).toHaveLength(7);
			expect(empty.usage).toHaveLength(30);
		});
	});
});
