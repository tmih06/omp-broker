import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";

export interface CapturedUsage {
	/** Non-cached input tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens?: number;
	totalTokens: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function details(record: JsonRecord, key: string): JsonRecord | undefined {
	return asRecord(record[key]);
}

/**
 * Normalizes a usage payload from any of the gateway's client-facing wire
 * formats: OpenAI chat, OpenAI Responses, Anthropic Messages, or pi-native.
 * OpenAI's prompt/input count includes cached tokens; Anthropic's input count
 * does not, so cached tokens are subtracted only when the payload exposes them.
 */
function parseUsage(raw: unknown): CapturedUsage | null {
	const record = asRecord(raw);
	if (!record) return null;

	const nativeInput = asNumber(record.input);
	const nativeOutput = asNumber(record.output);
	if (nativeInput !== undefined && nativeOutput !== undefined) {
		const cacheRead = asNumber(record.cacheRead) ?? 0;
		const cacheWrite = asNumber(record.cacheWrite) ?? 0;
		return {
			input: nativeInput,
			output: nativeOutput,
			cacheRead,
			cacheWrite,
			reasoningTokens: asNumber(record.reasoningTokens),
			totalTokens: asNumber(record.totalTokens) ?? nativeInput + nativeOutput + cacheRead + cacheWrite,
		};
	}

	const prompt = asNumber(record.prompt_tokens);
	const inputRaw = asNumber(record.input_tokens);
	const output = asNumber(record.completion_tokens) ?? asNumber(record.output_tokens);
	const promptCached = asNumber(details(record, "prompt_tokens_details")?.cached_tokens);
	const inputCached = asNumber(details(record, "input_tokens_details")?.cached_tokens);
	const cacheRead = asNumber(record.cache_read_input_tokens) ?? promptCached ?? inputCached;
	const cacheWrite = asNumber(record.cache_creation_input_tokens) ?? 0;
	const reasoningTokens =
		asNumber(details(record, "completion_tokens_details")?.reasoning_tokens) ??
		asNumber(details(record, "output_tokens_details")?.reasoning_tokens) ??
		asNumber(record.reasoning_tokens);

	if (prompt === undefined && inputRaw === undefined && output === undefined) return null;

	const cached = cacheRead ?? 0;
	const input =
		prompt !== undefined
			? Math.max(0, prompt - cached)
			: inputRaw !== undefined
				? inputCached !== undefined
					? Math.max(0, inputRaw - cached)
					: inputRaw
				: 0;

	return {
		input,
		output: output ?? 0,
		cacheRead: cached,
		cacheWrite,
		reasoningTokens,
		totalTokens: asNumber(record.total_tokens) ?? input + (output ?? 0) + cached + cacheWrite,
	};
}

/** Finds the usage object in a complete response or one streamed event. */
function usageFromPayload(payload: unknown): CapturedUsage | null {
	const record = asRecord(payload);
	if (!record) return null;
	const candidates = [
		record.usage,
		asRecord(record.message)?.usage,
		asRecord(record.response)?.usage,
		asRecord(record.delta)?.usage,
	];
	for (const candidate of candidates) {
		const parsed = parseUsage(candidate);
		if (parsed) return parsed;
	}
	return parseUsage(record);
}

/**
 * Anthropic reports input/cache on `message_start` and output on
 * `message_delta`; OpenAI reports one final usage object. Taking the maximum of
 * each bucket merges both shapes without double counting.
 */
function mergeUsage(current: CapturedUsage | null, next: CapturedUsage): CapturedUsage {
	if (!current) return next;
	const input = Math.max(current.input, next.input);
	const output = Math.max(current.output, next.output);
	const cacheRead = Math.max(current.cacheRead, next.cacheRead);
	const cacheWrite = Math.max(current.cacheWrite, next.cacheWrite);
	const reasoningTokens = Math.max(current.reasoningTokens ?? 0, next.reasoningTokens ?? 0) || undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoningTokens,
		totalTokens: Math.max(current.totalTokens, next.totalTokens, input + output + cacheRead + cacheWrite),
	};
}

function sseEventUsage(event: string, current: CapturedUsage | null): CapturedUsage | null {
	const data = event
		.split("\n")
		.filter(line => line.startsWith("data:"))
		.map(line => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!data || data === "[DONE]") return current;
	try {
		const next = usageFromPayload(JSON.parse(data));
		return next ? mergeUsage(current, next) : current;
	} catch {
		return current;
	}
}

/** Reads an SSE clone without touching the response handed to the client. */
async function readStreamUsage(response: { body: ReadableStream<Uint8Array> | null }): Promise<CapturedUsage | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder();
	let buffer = "";
	let usage: CapturedUsage | null = null;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				usage = sseEventUsage(buffer.slice(0, boundary), usage);
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");
			}
		}
		buffer += decoder.decode().replace(/\r\n/g, "\n");
		if (buffer.trim()) usage = sseEventUsage(buffer, usage);
	} catch {
		// A client disconnect cancels the tee; keep whatever was captured.
	}
	return usage;
}

/**
 * Captures token usage from a client-facing response. The response is cloned,
 * so the caller must invoke this before returning it to the client. JSON
 * responses can be awaited; SSE responses must be awaited after the stream has
 * been consumed (or in the background) because the clone is the other tee.
 */
export async function captureUsage(response: Response): Promise<CapturedUsage | null> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		try {
			return await readStreamUsage(response.clone());
		} catch {
			return null;
		}
	}
	try {
		return usageFromPayload(await response.clone().json());
	} catch {
		return null;
	}
}

/** Catalog cost for a captured usage, in USD. Null when the model is unknown. */
export function usageCost(model: Model<Api> | undefined, usage: CapturedUsage): number | null {
	if (!model) return null;
	const priced: Usage = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		reasoningTokens: usage.reasoningTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	try {
		const cost = calculateCost(model, priced);
		return Number.isFinite(cost.total) ? cost.total : null;
	} catch {
		return null;
	}
}
