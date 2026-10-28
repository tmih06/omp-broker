import { describe, expect, test } from "bun:test";
import { captureUsage, usageCost } from "../src/usage-capture";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function sseResponse(events: string[]): Response {
	return new Response(events.map(event => `data: ${event}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("usage capture", () => {
	test("normalizes OpenAI chat usage including cached and reasoning tokens", async () => {
		const usage = await captureUsage(
			jsonResponse({
				usage: {
					prompt_tokens: 100,
					completion_tokens: 20,
					total_tokens: 120,
					prompt_tokens_details: { cached_tokens: 40 },
					completion_tokens_details: { reasoning_tokens: 5 },
				},
			}),
		);
		expect(usage).toEqual({
			input: 60,
			output: 20,
			cacheRead: 40,
			cacheWrite: 0,
			reasoningTokens: 5,
			totalTokens: 120,
		});
	});

	test("normalizes Anthropic cache read and cache write buckets", async () => {
		const usage = await captureUsage(
			jsonResponse({
				usage: {
					input_tokens: 30,
					output_tokens: 10,
					cache_read_input_tokens: 20,
					cache_creation_input_tokens: 5,
				},
			}),
		);
		expect(usage).toEqual({
			input: 30,
			output: 10,
			cacheRead: 20,
			cacheWrite: 5,
			reasoningTokens: undefined,
			totalTokens: 65,
		});
	});

	test("merges Anthropic message_start and message_delta stream usage", async () => {
		const usage = await captureUsage(
			sseResponse([
				JSON.stringify({
					type: "message_start",
					message: {
						usage: {
							input_tokens: 30,
							output_tokens: 0,
							cache_read_input_tokens: 20,
							cache_creation_input_tokens: 5,
						},
					},
				}),
				JSON.stringify({ type: "message_delta", usage: { output_tokens: 10 } }),
			]),
		);
		expect(usage).toEqual({
			input: 30,
			output: 10,
			cacheRead: 20,
			cacheWrite: 5,
			reasoningTokens: undefined,
			totalTokens: 65,
		});
	});

	test("reads OpenAI stream usage from the final chunk", async () => {
		const usage = await captureUsage(
			sseResponse([
				JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
				JSON.stringify({
					choices: [],
					usage: {
						prompt_tokens: 12,
						completion_tokens: 3,
						total_tokens: 15,
						prompt_tokens_details: { cached_tokens: 2 },
					},
				}),
			]),
		);
		expect(usage).toEqual({
			input: 10,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			reasoningTokens: undefined,
			totalTokens: 15,
		});
	});

	test("returns null without usage and for unknown models", async () => {
		expect(await captureUsage(jsonResponse({ choices: [] }))).toBeNull();
		expect(await captureUsage(new Response("not json"))).toBeNull();
		expect(
			usageCost(undefined, {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
			}),
		).toBeNull();
	});
});
