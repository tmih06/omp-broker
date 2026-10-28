import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { corsHeaders, hasMisplacedBearer, isAuthorized, json, withCors } from "@oh-my-pi/pi-ai/auth-gateway/http";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";
import { DEFAULT_BIND, VERSION } from "./config";
import { createModelCatalog, storageProviderAvailability, type ModelCatalog } from "./models";
import type { RequestLog } from "./request-log";
import { captureUsage, usageCost, type CapturedUsage } from "./usage-capture";

export interface StartGatewayOptions {
	storage: AuthStorage;
	/** Accepted `Authorization: Bearer` or Anthropic `x-api-key` values. Empty disables auth. */
	bearerTokens?: string[];
	bind?: string;
	/** Override the bundled catalog (tests, custom deployments). */
	models?: readonly Model<Api>[];
	providerOrder?: readonly string[];
	/** Upstream transport seam; defaults to global fetch. */
	fetch?: FetchImpl;
	/** Request history. Omit to disable logging and the `/v1/logs` routes. */
	requestLog?: RequestLog;
	version?: string;
}

/** Health probes and the log reads themselves would flood the history. */
function shouldLogRequest(method: string, pathname: string): boolean {
	if (method === "OPTIONS") return false;
	return pathname !== "/healthz" && pathname !== "/v1/logs" && pathname !== "/v1/logs/stats";
}

const MODEL_ROUTES = new Set(["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/pi/stream"]);

interface RequestMetadata {
	model: string | null;
	stream: boolean;
}

function isModelRoute(method: string, pathname: string): boolean {
	return method === "POST" && MODEL_ROUTES.has(pathname);
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
			let metadataPromise: Promise<RequestMetadata> | undefined;

			const handle = async (): Promise<Response> => {
				if (req.method === "OPTIONS") {
					return new Response(null, { status: 204, headers: corsHeaders(req) });
				}
				if (req.method === "GET" && url.pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}

				const request = normalizeAuthHeader(req);
				if (requireAuth && !isAuthorized(request, tokens)) {
					return withCors(json(401, { error: "unauthorized" }), req);
				}
				if (hasMisplacedBearer(request, url, tokens)) {
					return withCors(json(400, { error: "gateway token outside Authorization" }), req);
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

				if (requestLog && isModelRoute(req.method, url.pathname)) {
					metadataPromise = readRequestMetadata(request);
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

			const metadata = metadataPromise ? await metadataPromise : undefined;
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
