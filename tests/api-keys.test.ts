import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import {
	ApiKeyStore,
	apiKeyStatus,
	budgetWindowStart,
	isIpAllowed,
	isModelAllowed,
	parseApiKeyInput,
	parseApiKeyUpdate,
} from "../src/api-keys";

async function withStore(run: (store: ApiKeyStore, dir: string) => void): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-broker-keys-"));
	const store = ApiKeyStore.open({ dbPath: path.join(dir, "keys.db") });
	try {
		run(store, dir);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
}

describe("API keys", () => {
	test("creates a hashed secret and returns plaintext once", async () => {
		await withStore((store, dir) => {
			const created = store.create({
				name: "laptop",
				budgetUsd: 20,
				budgetPeriod: "monthly",
				requestLimit: 500,
				allowedModels: ["anthropic/*"],
				blockedModels: ["anthropic/opus-*"],
				allowedIps: ["127.0.0.1", "::1"],
			});
			expect(created.key.startsWith("omp_sk_")).toBe(true);
			expect(created.apiKey).toMatchObject({
				name: "laptop",
				budgetUsd: 20,
				budgetPeriod: "monthly",
				requestLimit: 500,
				allowedModels: ["anthropic/*"],
				blockedModels: ["anthropic/opus-*"],
				allowedIps: ["127.0.0.1", "::1"],
			});

			const found = store.lookup(created.key);
			expect(found?.id).toBe(created.apiKey.id);
			expect(store.lookup("omp_sk_wrong")).toBeUndefined();

			const db = new Database(path.join(dir, "keys.db"));
			const raw = db.query("SELECT key_hash, key_prefix FROM api_keys").get() as {
				key_hash: string;
				key_prefix: string;
			};
			db.close();
			expect(raw.key_hash).not.toBe(created.key);
			expect(raw.key_hash).toHaveLength(64);
			expect(raw.key_prefix).toBe(created.key.slice(0, 12));
		});
	});

	test("updates policy, revokes, and reports expiry", async () => {
		await withStore(store => {
			const created = store.create({
				name: "desktop",
				expiresAt: Date.now() + 60_000,
				allowedIps: ["127.0.0.1"],
			});
			expect(apiKeyStatus(created.apiKey)).toBe("active");
			const updated = store.update(created.apiKey.id, {
				name: "desktop 2",
				budgetUsd: 4.5,
				budgetPeriod: "daily",
				requestLimit: 12,
				allowedModels: ["openai/*"],
				blockedModels: ["openai/o1*"],
				allowedIps: [],
			});
			expect(updated).toMatchObject({
				name: "desktop 2",
				budgetUsd: 4.5,
				budgetPeriod: "daily",
				requestLimit: 12,
				allowedModels: ["openai/*"],
				blockedModels: ["openai/o1*"],
				allowedIps: [],
			});

			const revoked = store.revoke(created.apiKey.id);
			expect(typeof revoked?.revokedAt).toBe("number");
			expect(revoked && apiKeyStatus(revoked)).toBe("revoked");
			expect(typeof store.lookup(created.key)?.revokedAt).toBe("number");

			const expired = store.create({ name: "expired", expiresAt: 1 });
			expect(apiKeyStatus(expired.apiKey)).toBe("expired");
		});
	});

	test("enforces model globs and exact IPs", () => {
		const key = {
			allowedModels: ["anthropic/*", "openai/gpt-5"],
			blockedModels: ["anthropic/opus-*"],
		};
		expect(isModelAllowed(key, "claude-sonnet-4-5", "anthropic")).toBe(true);
		expect(isModelAllowed(key, "opus-4", "anthropic")).toBe(false);
		expect(isModelAllowed(key, "gpt-5", "openai")).toBe(true);
		expect(isModelAllowed(key, "gpt-5-mini", "openai")).toBe(false);
		expect(isModelAllowed({ allowedModels: [], blockedModels: [] }, "anything", "x")).toBe(true);
		expect(
			isModelAllowed(
				{ allowedModels: ["anthropic/*"], blockedModels: ["anthropic/claude-*"] },
				"claude-sonnet-4-5",
				"anthropic",
			),
		).toBe(false);

		const ips = { allowedIps: ["127.0.0.1", "::1"] };
		expect(isIpAllowed(ips, "127.0.0.1")).toBe(true);
		expect(isIpAllowed(ips, "::ffff:127.0.0.1")).toBe(true);
		expect(isIpAllowed(ips, "::1")).toBe(true);
		expect(isIpAllowed(ips, "10.0.0.4")).toBe(false);
		expect(isIpAllowed({ allowedIps: [] }, "10.0.0.4")).toBe(true);
	});

	test("computes daily, monthly, and total budget windows", () => {
		const at = Date.UTC(2026, 9, 28, 15, 30);
		expect(budgetWindowStart("daily", at)).toBe(Date.UTC(2026, 9, 28));
		expect(budgetWindowStart("monthly", at)).toBe(Date.UTC(2026, 9, 1));
		expect(budgetWindowStart("total", at)).toBe(0);
	});

	test("validates API request bodies", () => {
		expect(parseApiKeyInput({ name: "phone", budgetUsd: 3, budgetPeriod: "daily" })).toEqual({
			name: "phone",
			budgetUsd: 3,
			budgetPeriod: "daily",
		});
		expect(() => parseApiKeyInput({ name: "" })).not.toThrow();
		expect(() => parseApiKeyInput({})).toThrow("name is required");
		expect(() => parseApiKeyInput({ name: "x", allowedModels: "y" })).toThrow("allowedModels");
		expect(() => parseApiKeyInput({ name: "x", budgetPeriod: "weekly" })).toThrow("budgetPeriod");
		expect(parseApiKeyUpdate({ budgetUsd: null, allowedIps: ["127.0.0.1"] })).toEqual({
			budgetUsd: null,
			allowedIps: ["127.0.0.1"],
		});
		expect(() => parseApiKeyUpdate({})).toThrow("no supported fields");
	});
});
