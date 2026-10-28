import { useMemo } from "react";

import { Panel } from "@/components/instrument/Panel";
import { SparkBars, type SparkDatum } from "@/components/instrument/SparkBars";
import { buildPreviewDays } from "@/lib/preview-data";

const PROVIDERS = [
	{ name: "Anthropic", models: 14, shade: "var(--series-1)" },
	{ name: "Codex", models: 9, shade: "var(--series-2)" },
	{ name: "Copilot", models: 6, shade: "var(--series-5)" },
] as const;

function signed(value: number, suffix: string) {
	if (Math.abs(value) < 0.05) return `0.0${suffix}`;
	return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}${suffix}`;
}

export function SectionCards() {
	const days = useMemo(() => buildPreviewDays(31), []);
	const recent = days.slice(-14);
	const today = days.at(-1);
	const yesterday = days.at(-2);

	const requests = today?.requests ?? 0;
	const success = today ? 100 - (today.errors / today.requests) * 100 : 0;
	const previousSuccess = yesterday ? 100 - (yesterday.errors / yesterday.requests) * 100 : success;
	const previousRequests = yesterday?.requests ?? requests;
	const latency = today?.latencyMs ?? 0;
	const previousLatency = yesterday?.latencyMs ?? latency;
	const requestChange = previousRequests ? ((requests - previousRequests) / previousRequests) * 100 : 0;
	const latencyChange = previousLatency ? ((latency - previousLatency) / previousLatency) * 100 : 0;

	const requestSpark: SparkDatum[] = recent.map(day => ({
		values: [day.counts.chat, day.counts.messages, day.counts.responses, day.counts.other],
		error: day.errors,
	}));
	const successSpark: SparkDatum[] = recent.map(day => ({
		values: [day.requests - day.errors],
		error: day.errors,
	}));
	const latencySpark: SparkDatum[] = recent.map(day => ({ values: [day.latencyMs], error: 0 }));
	const providerTotal = PROVIDERS.reduce((sum, provider) => sum + provider.models, 0);

	return (
		<div className="metric-grid">
			<Panel index={0} className="metric-panel">
				<div className="metric-head">
					<h2 className="metric-title">Requests</h2>
					<div className="inst-kicker">01 / 24H</div>
				</div>
				<div className="metric-figure">
					<span className="metric-num">{requests.toLocaleString("en-US")}</span>
					<span className="metric-unit">requests</span>
				</div>
				<div className="metric-meta">
					<span className="metric-delta">
						<b>{signed(requestChange, "%")}</b> vs yesterday
					</span>
					<span>14D</span>
				</div>
				<SparkBars data={requestSpark} label="Requests by source, last 14 days, with errors below the baseline" />
			</Panel>

			<Panel index={1} className="metric-panel">
				<div className="metric-head">
					<h2 className="metric-title">Success rate</h2>
					<div className="inst-kicker">02 / 24H</div>
				</div>
				<div className="metric-figure">
					<span className="metric-num">{success.toFixed(1)}</span>
					<span className="metric-unit">%</span>
				</div>
				<div className="metric-meta">
					<span className="metric-delta">
						<b>{signed(success - previousSuccess, " pp")}</b> vs yesterday
					</span>
					<span>14D</span>
				</div>
				<SparkBars
					data={successSpark}
					tone={4}
					label="Successful requests, last 14 days, with errors below the baseline"
				/>
			</Panel>

			<Panel index={2} className="metric-panel">
				<div className="metric-head">
					<h2 className="metric-title">p95 latency</h2>
					<div className="inst-kicker">03 / 24H</div>
				</div>
				<div className="metric-figure">
					<span className="metric-num">{latency.toLocaleString("en-US")}</span>
					<span className="metric-unit">ms</span>
				</div>
				<div className="metric-meta">
					<span className="metric-delta">
						<b>{signed(latencyChange, "%")}</b> vs yesterday
					</span>
					<span>14D</span>
				</div>
				<SparkBars data={latencySpark} tone={3} label="p95 latency, last 14 days" />
			</Panel>

			<Panel index={3} className="metric-panel">
				<div className="metric-head">
					<h2 className="metric-title">Providers</h2>
					<div className="inst-kicker">04 / AUTH</div>
				</div>
				<div className="metric-figure">
					<span className="metric-num">{PROVIDERS.length}</span>
					<span className="metric-unit">authenticated</span>
				</div>
				<div className="metric-meta">
					<span className="metric-delta">
						<b>Stable</b> catalog
					</span>
					<span>{providerTotal} models</span>
				</div>
				<div>
					<div className="provider-strip" aria-hidden>
						{PROVIDERS.map(provider => (
							<span key={provider.name} style={{ flexGrow: provider.models, background: provider.shade }} />
						))}
					</div>
					<div className="provider-labels">
						{PROVIDERS.map(provider => (
							<span key={provider.name}>{provider.name}</span>
						))}
					</div>
				</div>
			</Panel>
		</div>
	);
}
