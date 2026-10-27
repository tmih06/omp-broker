import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { corsHeaders, hasMisplacedBearer, isAuthorized, json, withCors } from "@oh-my-pi/pi-ai/auth-gateway/http";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";
import { DEFAULT_BIND, VERSION } from "./config";
import { createModelCatalog, storageProviderAvailability, type ModelCatalog } from "./models";
import type { RequestLog } from "./request-log";

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

				return withCors(await router.route(request, peer), req);
			};

			try {
				response = await handle();
			} catch (error) {
				console.error("gateway request failed:", error);
				errorMessage = error instanceof Error ? error.message : String(error);
				response = withCors(json(500, { error: "internal error" }), req);
			}

			// Streaming responses are recorded once the route returns; the body's
			// duration is not tracked because it is consumed by the client.
			if (requestLog && shouldLogRequest(req.method, url.pathname)) {
				requestLog.record({
					method: req.method,
					path: url.pathname,
					status: response.status,
					durationMs: performance.now() - started,
					client: peer,
					error: errorMessage,
				});
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
