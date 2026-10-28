const DAY_MS = 86_400_000;

export interface PreviewDay {
	/** UTC midnight for the day. */
	at: number;
	requests: number;
	errors: number;
	counts: { chat: number; messages: number; responses: number; other: number };
}

export interface PreviewMetric {
	label: string;
	value: number;
	context: string;
	change: string;
}

export interface PreviewRequest {
	at: number;
	method: string;
	path: string;
	status: number;
	model: string | null;
	provider: string | null;
	keyName: string;
	tokens: number;
	latencyMs: number;
	costUsd: number;
}

/** Deterministic sample traffic so the shell stays stable across reloads. */
export function buildPreviewDays(count = 30): PreviewDay[] {
	const now = new Date();
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return Array.from({ length: count }, (_, index) => {
		const at = today - (count - 1 - index) * DAY_MS;
		const weekday = new Date(at).getUTCDay();
		const weekend = weekday === 0 || weekday === 6 ? 0.62 : 1;
		const wave = 0.82 + 0.18 * Math.sin(index / 2.4) + (index % 7 === 0 ? 0.06 : 0);
		const counts = {
			chat: Math.round(720 * wave * weekend),
			messages: Math.round(460 * wave * weekend),
			responses: Math.round(260 * wave * weekend),
			other: Math.round(90 * wave * weekend),
		};
		const requests = counts.chat + counts.messages + counts.responses + counts.other;
		const errors = Math.max(1, Math.round(requests * (0.008 + (index % 5 === 0 ? 0.004 : 0))));
		return { at, requests, errors, counts };
	});
}

export function buildMetrics(days: PreviewDay[]): PreviewMetric[] {
	const today = days.at(-1);
	const previous = days.at(-2);
	if (!today || !previous) return [];
	const success = (1 - today.errors / today.requests) * 100;
	const previousSuccess = (1 - previous.errors / previous.requests) * 100;
	const change = ((today.requests - previous.requests) / previous.requests) * 100;
	const successChange = success - previousSuccess;
	return [
		{
			label: "Requests",
			value: today.requests,
			context: "Last 24 hours",
			change: Math.abs(change) < 0.05 ? "0.0%" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
		},
		{
			label: "Success rate",
			value: Number(success.toFixed(1)),
			context: "Last 24 hours",
			change:
				Math.abs(successChange) < 0.05 ? "0.0 pp" : `${successChange > 0 ? "+" : ""}${successChange.toFixed(1)} pp`,
		},
		{
			label: "p95 latency",
			value: 412,
			context: "Time to response",
			change: "8.1% faster",
		},
	];
}

/** Sample request rows for the dashboard table; deterministic apart from their timestamps. */
export function buildPreviewRequests(now = Date.now()): PreviewRequest[] {
	const minute = 60_000;
	return [
		{
			at: now - 2 * minute,
			method: "POST",
			path: "/v1/chat/completions",
			status: 200,
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			keyName: "laptop",
			tokens: 1842,
			latencyMs: 1210,
			costUsd: 0.0132,
		},
		{
			at: now - 7 * minute,
			method: "POST",
			path: "/v1/messages",
			status: 200,
			model: "gpt-5.6-sol",
			provider: "openai-codex",
			keyName: "desktop",
			tokens: 2964,
			latencyMs: 842,
			costUsd: 0.0218,
		},
		{
			at: now - 12 * minute,
			method: "POST",
			path: "/v1/responses",
			status: 200,
			model: "claude-sonnet-4.5",
			provider: "github-copilot",
			keyName: "ci",
			tokens: 1210,
			latencyMs: 640,
			costUsd: 0,
		},
		{
			at: now - 18 * minute,
			method: "POST",
			path: "/v1/chat/completions",
			status: 402,
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			keyName: "trial",
			tokens: 0,
			latencyMs: 3,
			costUsd: 0,
		},
		{
			at: now - 24 * minute,
			method: "GET",
			path: "/v1/models",
			status: 200,
			model: null,
			provider: null,
			keyName: "laptop",
			tokens: 0,
			latencyMs: 2,
			costUsd: 0,
		},
		{
			at: now - 31 * minute,
			method: "POST",
			path: "/v1/chat/completions",
			status: 200,
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			keyName: "laptop",
			tokens: 842,
			latencyMs: 398,
			costUsd: 0.0061,
		},
		{
			at: now - 43 * minute,
			method: "POST",
			path: "/v1/messages",
			status: 500,
			model: "gpt-5.6-sol",
			provider: "openai-codex",
			keyName: "desktop",
			tokens: 0,
			latencyMs: 2180,
			costUsd: 0,
		},
		{
			at: now - 58 * minute,
			method: "POST",
			path: "/v1/chat/completions",
			status: 429,
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			keyName: "ci",
			tokens: 0,
			latencyMs: 1,
			costUsd: 0,
		},
	];
}
