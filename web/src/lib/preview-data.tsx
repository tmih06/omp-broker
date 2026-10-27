import { CircleCheck, KeyRound, RefreshCw, TriangleAlert, Waypoints } from "lucide-react";
import type { LineChartDatum } from "@/components/arc/line-chart/line-chart";
import type { TimelineEvent } from "@/components/arc/timeline/timeline";
import type { MetricCardProps } from "@/components/arc/metric-card/metric-card";

const DAY_MS = 86_400_000;
const dayLong = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});
const dayShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export interface PreviewDay {
	/** UTC midnight for the day. */
	at: number;
	requests: number;
	errors: number;
	counts: { chat: number; messages: number; responses: number; other: number };
}

function utcDay(ms: number): number {
	const date = new Date(ms);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Deterministic sample traffic so the shell stays stable across reloads. */
export function buildPreviewDays(count = 30): PreviewDay[] {
	const today = utcDay(Date.now());
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

export function toLineChartData(days: PreviewDay[], count: number): LineChartDatum[] {
	const slice = days.slice(-count);
	return slice.map((day, index) => ({
		key: new Date(day.at).toISOString(),
		label: dayLong.format(day.at),
		axisLabel: count <= 7 || index % 5 === 0 ? dayShort.format(day.at) : undefined,
		values: { requests: day.requests },
	}));
}

export function buildMetrics(days: PreviewDay[]): MetricCardProps[] {
	const today = days.at(-1);
	const previous = days.at(-2);
	if (!today || !previous) return [];
	const success = (1 - today.errors / today.requests) * 100;
	const previousSuccess = (1 - previous.errors / previous.requests) * 100;
	const change = ((today.requests - previous.requests) / previous.requests) * 100;
	const successChange = success - previousSuccess;
	const signed = (value: number, unit: string) =>
		Math.abs(value) < 0.05 ? `0.0${unit}` : `${value > 0 ? "+" : ""}${value.toFixed(1)}${unit}`;
	const rounded = (value: number) => Number(value.toFixed(1));
	return [
		{
			label: "Requests",
			value: today.requests,
			context: "Last 24 hours",
			change: signed(change, "%"),
		},
		{
			label: "Success rate",
			value: rounded(success),
			suffix: "%",
			context: "Last 24 hours",
			change: signed(successChange, " pp"),
		},
		{
			label: "p95 latency",
			value: 412,
			suffix: "ms",
			context: "Time to response",
			change: "8.1% faster",
		},
	];
}

export function buildPreviewEvents(now: number): TimelineEvent[] {
	return [
		{
			id: "health",
			at: now - 2 * 60_000,
			icon: <CircleCheck size={14} />,
			title: "Health check passed",
			meta: "127.0.0.1:4000 · 12 ms",
			tone: "success",
		},
		{
			id: "route",
			at: now - 14 * 60_000,
			icon: <Waypoints size={14} />,
			title: "Chat completion routed to anthropic",
			meta: "claude-sonnet-4-5 · 1.2 s",
		},
		{
			id: "credential",
			at: now - 38 * 60_000,
			icon: <KeyRound size={14} />,
			title: "Credential refreshed for openai-codex",
			meta: "Expires in 9 days",
		},
		{
			id: "copilot",
			at: now - 62 * 60_000,
			icon: <TriangleAlert size={14} />,
			title: "GitHub Copilot model unavailable",
			meta: "Enable it in the Copilot picker",
			tone: "danger",
		},
		{
			id: "catalog",
			at: now - 2 * 60 * 60_000,
			icon: <RefreshCw size={14} />,
			title: "Model catalog synced",
			meta: "42 models across 3 providers",
		},
	];
}
