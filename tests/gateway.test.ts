import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { RequestLog } from "../src/request-log";
import { startGateway, type RunningGateway } from "../src/server";

const model = getBundledModel("aiand", "deepseek-ai/deepseek-v4-flash");
const TOKEN = "test-gateway-token";
const upstreamCalls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

function sse(delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1,
		model: model.id,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	})}\n\n`;
}

const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
	upstreamCalls.push({ url, headers: new Headers(init?.headers), body });
	const stream = [
		sse({ role: "assistant", content: "Hello" }, null),
		sse({}, "stop", { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }),
		"data: [DONE]\n\n",
	].join("");
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

let dir: string;
let storage: AuthStorage;
let requestLog: RequestLog;
let gateway: RunningGateway;

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "omp-broker-test-"));
	storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("aiand", "upstream-key");
	requestLog = RequestLog.open({ dbPath: path.join(dir, "requests.db") });
	gateway = await startGateway({
		storage,
		bearerTokens: [TOKEN],
		bind: "127.0.0.1:0",
		models: [model],
		fetch: mockFetch,
		requestLog,
		version: "test",
	});
});

afterAll(async () => {
	await gateway?.close();
	requestLog?.close();
	storage?.close();
	await rm(dir, { recursive: true, force: true });
});

function chat(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${gateway.url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
		body: JSON.stringify(body),
	});
}

describe("gateway", () => {
	test("healthz is unauthenticated", async () => {
		const res = await fetch(`${gateway.url}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, version: "test" });
	});

	test("rejects missing or wrong credentials", async () => {
		const missing = await fetch(`${gateway.url}/v1/models`);
		expect(missing.status).toBe(401);
		const wrong = await fetch(`${gateway.url}/v1/models`, {
			headers: { authorization: "Bearer nope" },
		});
		expect(wrong.status).toBe(401);
	});

	test("lists models under provider/model ids", async () => {
		const res = await fetch(`${gateway.url}/v1/models`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { id: string; owned_by: string }[] };
		expect(body.data).toContainEqual(
			expect.objectContaining({ id: "aiand/deepseek-ai/deepseek-v4-flash", owned_by: "aiand" }),
		);
	});

	test("serves OpenAI chat completions with a bearer", async () => {
		const res = await chat({
			model: "deepseek-ai/deepseek-v4-flash",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			object: string;
			choices: { message: { content: string } }[];
			usage: { prompt_tokens: number; completion_tokens: number };
		};
		expect(body.object).toBe("chat.completion");
		expect(body.choices[0]?.message.content).toBe("Hello");
		expect(body.usage).toEqual(expect.objectContaining({ prompt_tokens: 5, completion_tokens: 1 }));

		const upstream = upstreamCalls.at(-1);
		expect(upstream?.url).toBe("https://api.aiand.com/v1/chat/completions");
		expect(upstream?.headers.get("authorization")).toBe("Bearer upstream-key");
	});

	test("streams OpenAI chat completions", async () => {
		const res = await chat({
			model: "deepseek-ai/deepseek-v4-flash",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain('"content":"Hello"');
		expect(text).toContain("data: [DONE]");
	});

	test("accepts the Anthropic x-api-key header and wire format", async () => {
		const res = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": TOKEN,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "deepseek-ai/deepseek-v4-flash",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			type: string;
			content: { type: string; text: string }[];
			usage: { input_tokens: number; output_tokens: number };
		};
		expect(body.type).toBe("message");
		expect(body.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(body.usage).toEqual(expect.objectContaining({ input_tokens: 5, output_tokens: 1 }));
	});

	test("streams Anthropic Messages", async () => {
		const res = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": TOKEN,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "deepseek-ai/deepseek-v4-flash",
				max_tokens: 64,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("event: content_block_delta");
		expect(text).toContain("Hello");
		expect(text).toContain("event: message_stop");
	});

	test("serves OpenAI Responses", async () => {
		const res = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({
				model: "deepseek-ai/deepseek-v4-flash",
				input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { object: string; output: unknown[] };
		expect(body.object).toBe("response");
		expect(JSON.stringify(body.output)).toContain("Hello");
	});

	test("unknown models return a 404 envelope", async () => {
		const res = await chat({ model: "does-not-exist", messages: [{ role: "user", content: "hi" }] });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("Unknown model");
	});

	test("records API requests and serves the log behind auth", async () => {
		const ok = await fetch(`${gateway.url}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(ok.status).toBe(200);

		const unauthorized = await fetch(`${gateway.url}/v1/logs`);
		expect(unauthorized.status).toBe(401);

		const list = await fetch(`${gateway.url}/v1/logs?limit=10`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(list.status).toBe(200);
		const body = (await list.json()) as {
			object: string;
			data: { method: string; path: string; status: number }[];
		};
		expect(body.object).toBe("list");
		expect(body.data).toContainEqual(expect.objectContaining({ method: "GET", path: "/v1/models", status: 200 }));
		expect(body.data.some(entry => entry.path === "/healthz")).toBe(false);

		const stats = await fetch(`${gateway.url}/v1/logs/stats?days=7`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(stats.status).toBe(200);
		const aggregate = (await stats.json()) as {
			days: number;
			series: unknown[];
			usage: unknown[];
			summary: { requests: number };
		};
		expect(aggregate.days).toBe(7);
		expect(aggregate.series).toHaveLength(7);
		expect(aggregate.usage).toHaveLength(30);
		expect(aggregate.summary.requests).toBeGreaterThan(0);

		const badDays = await fetch(`${gateway.url}/v1/logs/stats?days=0`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(badDays.status).toBe(400);
	});
});
