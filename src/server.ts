import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { corsHeaders, hasMisplacedBearer, json, withCors } from "@oh-my-pi/pi-ai/auth-gateway/http";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";
import {
	ApiKeyStore,
	apiKeyStatus,
	budgetWindowStart,
	isIpAllowed,
	isModelAllowed,
	parseApiKeyInput,
	parseApiKeyUpdate,
	type ApiKey,
} from "./api-keys";
import { DEFAULT_BIND, VERSION } from "./config";
import { createModelCatalog, storageProviderAvailability, type ModelCatalog } from "./models";
import type { RequestLog } from "./request-log";
import { captureUsage, usageCost, type CapturedUsage } from "./usage-capture";

export interface StartGatewayOptions {
	storage: AuthStorage;
	/** Admin `Authorization: Bearer` or Anthropic `x-api-key` values. Empty disables admin auth. */
	bearerTokens?: string[];
	bind?: string;
	/** Override the bundled catalog (tests, custom deployments). */
	models?: readonly Model<Api>[];
	providerOrder?: readonly string[];
	/** Upstream transport seam; defaults to global fetch. */
	fetch?: FetchImpl;
	/** Request history. Omit to disable logging and the `/v1/logs` routes. */
	requestLog?: RequestLog;
	/** Virtual API keys. Without a store, inference cannot be authorized. */
	apiKeys?: ApiKeyStore;
	version?: string;
}

/** Health probes and the log reads themselves would flood the history. */
function shouldLogRequest(method: string, pathname: string): boolean {
	if (method === "OPTIONS") return false;
	return pathname !== "/healthz" && pathname !== "/v1/logs" && pathname !== "/v1/logs/stats";
}

const MODEL_ROUTES: Record<string, true> = {
	"/v1/chat/completions": true,
	"/v1/messages": true,
	"/v1/responses": true,
	"/v1/pi/stream": true,
	"/v1/images": true,
	"/v1/images/generations": true,
	"/v1/images/edits": true,
	"/v1/audio/speech": true,
	"/v1/audio/transcriptions": true,
	"/v1/embeddings": true,
	"/v1/rerank": true,
	"/v1/videos": true,
	"/v1/systemone": true,
	"/alpha/decisions": true,
};
const ADMIN_PATHS: Record<string, true> = {
	"/v1/logs": true,
	"/v1/logs/stats": true,
	"/v1/usage": true,
	"/v1/credentials/check": true,
};

interface RequestMetadata {
	model: string | null;
	stream: boolean;
}

function isModelRoute(method: string, pathname: string): boolean {
	return method === "POST" && MODEL_ROUTES[pathname] === true;
}

function isAdminPath(pathname: string): boolean {
	return ADMIN_PATHS[pathname] === true || pathname === "/v1/keys" || pathname.startsWith("/v1/keys/");
}

function presentedToken(req: Request): string | undefined {
	const authorization = req.headers.get("authorization")?.trim();
	if (authorization) {
		const match = /^Bearer\s+(.+)$/i.exec(authorization);
		return match?.[1]?.trim();
	}
	return req.headers.get("x-api-key")?.trim() || undefined;
}

function publicKey(key: ApiKey, requestLog?: RequestLog): Record<string, unknown> {
	const usage = requestLog?.usageForKey(key.id, budgetWindowStart(key.budgetPeriod)) ?? null;
	return { ...key, status: apiKeyStatus(key), usage };
}

/** The model list is filtered through the key's allow/block policy. */
function modelsForKey(catalog: ModelCatalog, key: ApiKey): Record<string, unknown>[] {
	const seen = new Set<string>();
	const data: Record<string, unknown>[] = [];
	for (const model of catalog.list()) {
		if (!isModelAllowed(key, model.id, model.provider)) continue;
		const id = `${model.provider}/${model.id}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const row: Record<string, unknown> = {
			id,
			object: "model",
			owned_by: model.provider,
			api: model.api,
			display_name: model.name,
			input_modalities: model.input,
		};
		if (modelKind(model) !== "chat") row.kind = modelKind(model);
		if (model.contextWindow != null) row.context_length = model.contextWindow;
		if (model.maxTokens != null) row.max_output_tokens = model.maxTokens;
		if (model.supportsTools === false) row.supports_tools = false;
		data.push(row);
	}
	return data;
}

/** Reads only the model and stream hint from a JSON request body; the router still owns the original. */
async function readRequestMetadata(request: Request): Promise<RequestMetadata> {
	try {
		const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
		if (Number.isFinite(declared) && declared > 2_000_000) return { model: null, stream: false };
		const body = (await request.clone().json()) as Record<string, unknown>;
		return {
			model: typeof body.model === "string" ? body.model : null,
			stream: body.stream === true,
		};
	} catch {
		return { model: null, stream: false };
	}
}

export interface RunningGateway {
	url: string;
	hostname: string;
	port: number;
	catalog: ModelCatalog;
	close(): Promise<void>;
}

/**
 * Anthropic clients send `x-api-key`; OpenAI clients send a bearer. The
 * library router authenticates bearers only, so normalize the former into the
 * latter before it reaches the router.
 */
function normalizeAuthHeader(req: Request): Request {
	if (req.headers.has("authorization")) return req;
	const apiKey = req.headers.get("x-api-key")?.trim();
	if (!apiKey) return req;
	const headers = new Headers(req.headers);
	headers.set("authorization", `Bearer ${apiKey}`);
	return new Request(req, { headers });
}

/**
 * Serves the omp auth-gateway wire routes. The gateway is pure protocol
 * translation: OpenAI chat-completions / Responses and Anthropic Messages in,
 * pi-ai `streamSimple()` against the resolved provider out.
 */
export async function startGateway(options: StartGatewayOptions): Promise<RunningGateway> {
	const bind = parseBind(options.bind ?? DEFAULT_BIND);
	const tokens = new Set(options.bearerTokens ?? []);
	const requireAuth = tokens.size > 0;
	const version = options.version ?? VERSION;
	const requestLog = options.requestLog;
	const apiKeys = options.apiKeys;

	const catalog = createModelCatalog({
		models: options.models,
		isProviderAvailable: storageProviderAvailability(options.storage),
		providerOrder: options.providerOrder,
	});
	const router = createAuthGatewayRouter({
		storage: options.storage,
		resolveModel: modelId => catalog.resolve(modelId),
		listModels: () => catalog.list(),
		fetch: options.fetch,
	});

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req, server): Promise<Response> => {
			const started = performance.now();
			const url = new URL(req.url);
			const peer = server.requestIP(req)?.address ?? "unknown";
			let response: Response;
			let errorMessage: string | undefined;
			let apiKey: ApiKey | undefined;
			let metadata: RequestMetadata | undefined;

			const handle = async (): Promise<Response> => {
				if (req.method === "OPTIONS") {
					return new Response(null, { status: 204, headers: corsHeaders(req) });
				}
				if (req.method === "GET" && url.pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}

				if (url.search.includes("omp_sk_") || url.pathname.includes("omp_sk_")) {
					return withCors(json(400, { error: "API key outside Authorization" }), req);
				}

				const request = normalizeAuthHeader(req);
				if (hasMisplacedBearer(request, url, tokens)) {
					return withCors(json(400, { error: "gateway token outside Authorization" }), req);
				}

				const token = presentedToken(req);
				const admin = token !== undefined && tokens.has(token);
				if (token && !admin && apiKeys) {
					const candidate = apiKeys.lookup(token);
					if (candidate) {
						apiKey = candidate;
						const status = apiKeyStatus(candidate);
						if (status !== "active") {
							return withCors(json(401, { error: `API key ${status}` }), req);
						}
						if (!isIpAllowed(candidate, peer)) {
							return withCors(json(403, { error: "IP address not allowed for this API key" }), req);
						}
						apiKeys.touch(candidate.id);
					} else if (requireAuth) {
						return withCors(json(401, { error: "unauthorized" }), req);
					}
				}
				if (requireAuth && !admin && !apiKey) {
					return withCors(json(401, { error: "unauthorized" }), req);
				}

				const adminPath = isAdminPath(url.pathname);
				const modelsPath = req.method === "GET" && url.pathname === "/v1/models";
				const inference = isModelRoute(req.method, url.pathname);
				if (adminPath && requireAuth && !admin) {
					return withCors(json(403, { error: "administrator token required" }), req);
				}
				// Every non-admin route needs a virtual key; --no-auth only relaxes admin auth.
				if (!adminPath && !modelsPath && !apiKey) {
					return withCors(json(403, { error: "virtual API key required" }), req);
				}

				if (apiKey && !requestLog) {
					return withCors(json(503, { error: "request logging is required for API keys" }), req);
				}
				if (apiKey && requestLog) {
					const used = requestLog.usageForKey(apiKey.id, budgetWindowStart(apiKey.budgetPeriod));
					if (apiKey.requestLimit !== null && used.requests >= apiKey.requestLimit) {
						return withCors(json(429, { error: "API key request limit reached" }), req);
					}
					if (!modelsPath && apiKey.budgetUsd !== null && used.costUsd >= apiKey.budgetUsd) {
						return withCors(json(402, { error: "API key budget exhausted" }), req);
					}
				}

				if (url.pathname === "/v1/keys" || url.pathname.startsWith("/v1/keys/")) {
					if (!apiKeys) return withCors(json(503, { error: "API key store not configured" }), req);
					const match = /^\/v1\/keys(?:\/(\d+))?$/.exec(url.pathname);
					if (!match) return withCors(json(404, { error: "not found" }), req);
					const id = match[1] === undefined ? undefined : Number(match[1]);
					if (id !== undefined && (!Number.isInteger(id) || id < 1)) {
						return withCors(json(400, { error: "invalid API key id" }), req);
					}
					try {
						if (id === undefined && req.method === "GET") {
							return withCors(
								json(200, { object: "list", data: apiKeys.list().map(key => publicKey(key, requestLog)) }),
								req,
							);
						}
						if (id === undefined && req.method === "POST") {
							const created = apiKeys.create(parseApiKeyInput(await req.json()));
							return withCors(json(201, { ...publicKey(created.apiKey, requestLog), key: created.key }), req);
						}
						if (id !== undefined && req.method === "GET") {
							const key = apiKeys.get(id);
							if (!key) return withCors(json(404, { error: "API key not found" }), req);
							return withCors(json(200, publicKey(key, requestLog)), req);
						}
						if (id !== undefined && req.method === "PATCH") {
							const key = apiKeys.update(id, parseApiKeyUpdate(await req.json()));
							if (!key) return withCors(json(404, { error: "API key not found" }), req);
							return withCors(json(200, publicKey(key, requestLog)), req);
						}
						if (id !== undefined && req.method === "DELETE") {
							const key = apiKeys.revoke(id);
							if (!key) return withCors(json(404, { error: "API key not found" }), req);
							return withCors(json(200, publicKey(key, requestLog)), req);
						}
						return withCors(json(405, { error: "method not allowed" }), req);
					} catch (error) {
						return withCors(
							json(400, { error: error instanceof Error ? error.message : "invalid API key request" }),
							req,
						);
					}
				}

				if (req.method === "GET" && url.pathname === "/v1/logs/stats") {
					if (!requestLog) return withCors(json(503, { error: "request logging disabled" }), req);
					const daysRaw = url.searchParams.get("days");
					const days = daysRaw === null ? 7 : Number(daysRaw);
					if (!Number.isInteger(days) || days < 1 || days > 30) {
						return withCors(json(400, { error: "days must be an integer from 1 to 30" }), req);
					}
					return withCors(json(200, requestLog.stats(days)), req);
				}
				if (req.method === "GET" && url.pathname === "/v1/logs") {
					if (!requestLog) return withCors(json(503, { error: "request logging disabled" }), req);
					const limitRaw = url.searchParams.get("limit");
					const limit = limitRaw === null ? 50 : Number(limitRaw);
					const beforeRaw = url.searchParams.get("before");
					const before = beforeRaw === null ? undefined : Number(beforeRaw);
					if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
						return withCors(json(400, { error: "limit must be an integer from 1 to 200" }), req);
					}
					if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
						return withCors(json(400, { error: "before must be a positive integer" }), req);
					}
					return withCors(json(200, { object: "list", data: requestLog.list({ limit, before }) }), req);
				}

				if (req.method === "GET" && url.pathname === "/v1/models" && apiKey) {
					return withCors(json(200, { object: "list", data: modelsForKey(catalog, apiKey) }), req);
				}

				if (inference) {
					metadata = await readRequestMetadata(request);
					if (apiKey && (apiKey.allowedModels.length > 0 || apiKey.blockedModels.length > 0)) {
						if (!metadata.model) {
							return withCors(json(403, { error: "model is required to enforce this API key's model policy" }), req);
						}
						const resolved = catalog.resolve(metadata.model);
						if (!isModelAllowed(apiKey, metadata.model, resolved?.provider)) {
							return withCors(json(403, { error: "model is not allowed for this API key" }), req);
						}
					}
				}

				return withCors(await router.route(request, peer), req);
			};

			try {
				response = await handle();
			} catch (error) {
				console.error("gateway request failed:", error);
				errorMessage = error instanceof Error ? error.message : String(error);
				response = withCors(json(500, { error: "internal error" }), req);
			}

			const resolvedModel = metadata?.model ? catalog.resolve(metadata.model) : undefined;
			const streaming = (response.headers.get("content-type") ?? "").includes("text/event-stream");
			const durationMs = performance.now() - started;

			// The body clone is created before the response is returned. JSON
			// usage can be awaited; SSE usage updates the row when the stream ends.
			let usage: CapturedUsage | null = null;
			let usagePromise: Promise<CapturedUsage | null> | undefined;
			if (requestLog && isModelRoute(req.method, url.pathname) && response.ok && response.body) {
				if (streaming) usagePromise = captureUsage(response);
				else usage = await captureUsage(response);
			}
			const costHeader = response.headers.get("x-litellm-response-cost");
			const headerCost = costHeader === null ? null : Number(costHeader);
			const costUsd =
				headerCost !== null && Number.isFinite(headerCost)
					? headerCost
					: usage
						? usageCost(resolvedModel, usage)
						: null;

			if (requestLog && shouldLogRequest(req.method, url.pathname)) {
				const log = requestLog;
				const id = log.record({
					method: req.method,
					path: url.pathname,
					status: response.status,
					durationMs,
					client: peer,
					error: errorMessage,
					model: metadata?.model ?? null,
					provider: resolvedModel?.provider ?? null,
					requestId: response.headers.get("x-request-id"),
					stream: streaming || metadata?.stream === true,
					tokens: usage,
					costUsd,
					keyId: apiKey?.id ?? null,
					keyName: apiKey?.name ?? null,
				});
				if (id !== undefined && usagePromise) {
					void usagePromise.then(captured => {
						if (!captured) return;
						const streamCost =
							headerCost !== null && Number.isFinite(headerCost) ? headerCost : usageCost(resolvedModel, captured);
						log.attachUsage(id, captured, streamCost);
					});
				}
			}
			return response;
		},
		// Long thinking calls can sit idle before the first token.
		idleTimeout: 255,
	});

	const hostname = server.hostname ?? bind.hostname;
	const port = server.port ?? bind.port;
	return {
		url: `http://${hostname}:${port}`,
		hostname,
		port,
		catalog,
		close: async () => {
			server.stop(true);
			router.close();
		},
	};
}
