import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { createModelCatalog, storageProviderAvailability } from "../src/models";

const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
const antigravity = getBundledModel("google-antigravity", "claude-sonnet-4-5");
const codex = getBundledModel("openai-codex", "gpt-5.6-sol");
const aiand = getBundledModel("aiand", "deepseek-ai/deepseek-v4-flash");

describe("model catalog", () => {
	test("prefers authenticated providers for a bare id", () => {
		const catalog = createModelCatalog({
			models: [anthropic, antigravity, codex],
			isProviderAvailable: provider => provider === "google-antigravity",
			providerOrder: ["anthropic", "openai-codex", "google-antigravity"],
		});

		expect(catalog.resolve("claude-sonnet-4-5")?.provider).toBe("google-antigravity");
		expect(catalog.list()).toEqual([antigravity]);
	});

	test("honors the provider order when both are authenticated", () => {
		const catalog = createModelCatalog({
			models: [anthropic, antigravity],
			isProviderAvailable: () => true,
			providerOrder: ["anthropic", "google-antigravity"],
		});
		expect(catalog.resolve("claude-sonnet-4-5")?.provider).toBe("anthropic");
	});

	test("resolves provider-qualified ids, including nested model slugs", () => {
		const catalog = createModelCatalog({
			models: [aiand, codex],
			isProviderAvailable: () => false,
		});
		expect(catalog.resolve("aiand/deepseek-ai/deepseek-v4-flash")).toBe(aiand);
		expect(catalog.resolve("openai-codex/gpt-5.6-sol")).toBe(codex);
		expect(catalog.resolve("openai-codex/nope")).toBeUndefined();
	});

	test("returns a known model on an unauthenticated provider so the gateway answers 401", () => {
		const catalog = createModelCatalog({
			models: [anthropic],
			isProviderAvailable: () => false,
		});
		expect(catalog.resolve("claude-sonnet-4-5")).toBe(anthropic);
		expect(catalog.list()).toEqual([]);
	});

	test("tolerates case differences and unknown ids", () => {
		const catalog = createModelCatalog({ models: [codex], isProviderAvailable: () => true });
		expect(catalog.resolve("GPT-5.6-SOL")).toBe(codex);
		expect(catalog.resolve("gpt-nope")).toBeUndefined();
		expect(catalog.resolve("")).toBeUndefined();
	});

	test("storage availability sees stored and runtime credentials", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-broker-models-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		try {
			storage.keys.setRuntime("aiand", "test");
			const available = storageProviderAvailability(storage);
			expect(available("aiand")).toBe(true);
			expect(available("anthropic")).toBe(false);
		} finally {
			storage.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
