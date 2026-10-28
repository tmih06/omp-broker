import { IconActivity, IconServer, IconTrendingDown, IconTrendingUp, type Icon } from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { buildMetrics, buildPreviewDays } from "@/lib/preview-data";

interface Stat {
	title: string;
	value: string;
	change: string;
	footer: string;
	note: string;
	icon: Icon;
}

export function SectionCards() {
	const days = buildPreviewDays(30);
	const metrics = buildMetrics(days);
	const requests = metrics[0];
	const success = metrics[1];
	const latency = metrics[2];

	const stats: Stat[] = [
		{
			title: "Requests",
			value: requests?.value.toLocaleString("en-US") ?? "—",
			change: requests?.change ?? "—",
			footer: "Traffic handled by the gateway",
			note: "Last 24 hours",
			icon: IconTrendingUp,
		},
		{
			title: "Success rate",
			value: success ? `${success.value}%` : "—",
			change: success?.change ?? "—",
			footer: "Successful responses",
			note: "Last 24 hours",
			icon: IconTrendingUp,
		},
		{
			title: "p95 latency",
			value: latency ? `${latency.value} ms` : "—",
			change: "8.1% faster",
			footer: "Time to response",
			note: "Across all providers",
			icon: IconActivity,
		},
		{
			title: "Providers",
			value: "3",
			change: "Stable",
			footer: "Anthropic · Codex · Copilot",
			note: "Authenticated providers",
			icon: IconServer,
		},
	];

	return (
		<div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
			{stats.map(stat => {
				const Trend = stat.change.startsWith("+")
					? IconTrendingUp
					: stat.change.startsWith("-")
						? IconTrendingDown
						: stat.icon;
				return (
					<Card key={stat.title} className="@container/card">
						<CardHeader>
							<CardDescription>{stat.title}</CardDescription>
							<CardTitle className="whitespace-nowrap text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
								{stat.value}
							</CardTitle>
							<CardAction>
								<Badge variant="outline">
									<Trend />
									{stat.change}
								</Badge>
							</CardAction>
						</CardHeader>
						<CardFooter className="flex-col items-start gap-1.5 text-sm">
							<div className="line-clamp-1 flex gap-2 font-medium">
								{stat.footer} <Trend className="size-4" />
							</div>
							<div className="text-muted-foreground">{stat.note}</div>
						</CardFooter>
					</Card>
				);
			})}
		</div>
	);
}
