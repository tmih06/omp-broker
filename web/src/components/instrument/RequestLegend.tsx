import { useMemo } from "react";

import { Panel } from "@/components/instrument/Panel";
import { buildPreviewDays } from "@/lib/preview-data";

const CATEGORIES = [
	{ key: "chat", label: "Chat", color: "var(--series-1)" },
	{ key: "messages", label: "Messages", color: "var(--series-2)" },
	{ key: "responses", label: "Responses", color: "var(--series-3)" },
	{ key: "other", label: "Other", color: "var(--series-4)" },
] as const;

export function RequestLegend() {
	const totals = useMemo(() => {
		const days = buildPreviewDays(30);
		const sums = CATEGORIES.map(category => days.reduce((sum, day) => sum + day.counts[category.key], 0));
		const total = sums.reduce((sum, value) => sum + value, 0);
		return { sums, total };
	}, []);

	return (
		<Panel index={5} className="legend-panel">
			<div className="inst-head">
				<h2 className="inst-title">Request mix</h2>
				<div className="inst-kicker">30D</div>
			</div>
			<div className="legend-grid">
				{CATEGORIES.map((category, index) => (
					<div className="legend-row" key={category.key}>
						<i style={{ background: category.color }} aria-hidden />
						<span>{category.label}</span>
						<b>{((totals.sums[index]! / totals.total) * 100).toFixed(0)}%</b>
					</div>
				))}
			</div>
		</Panel>
	);
}
