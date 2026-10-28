"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";

import { useIsMobile } from "@/hooks/use-mobile";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { buildPreviewDays } from "@/lib/preview-data";

export const description = "Requests handled per day";

const chartConfig = {
	requests: {
		label: "Requests",
		color: "var(--accent)",
	},
} satisfies ChartConfig;

export function ChartAreaInteractive() {
	const isMobile = useIsMobile();
	const [timeRange, setTimeRange] = React.useState("90d");

	React.useEffect(() => {
		if (isMobile) setTimeRange("7d");
	}, [isMobile]);

	const chartData = React.useMemo(
		() =>
			buildPreviewDays(90).map(day => ({
				date: new Date(day.at).toISOString().slice(0, 10),
				requests: day.requests,
			})),
		[],
	);

	const referenceDate = new Date(chartData.at(-1)?.date ?? Date.now());
	const filteredData = chartData.filter(item => {
		const date = new Date(item.date);
		let daysToSubtract = 90;
		if (timeRange === "30d") daysToSubtract = 30;
		else if (timeRange === "7d") daysToSubtract = 7;
		const startDate = new Date(referenceDate);
		startDate.setDate(startDate.getDate() - daysToSubtract);
		return date >= startDate;
	});

	return (
		<Card className="@container/card">
			<CardHeader>
				<CardTitle>Request volume</CardTitle>
				<CardDescription>
					<span className="hidden @[540px]/card:block">Requests handled per day</span>
					<span className="@[540px]/card:hidden">Last {timeRange.replace("d", " days")}</span>
				</CardDescription>
				<CardAction>
					<ToggleGroup
						type="single"
						value={timeRange}
						onValueChange={setTimeRange}
						variant="outline"
						className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
					>
						<ToggleGroupItem value="90d">Last 3 months</ToggleGroupItem>
						<ToggleGroupItem value="30d">Last 30 days</ToggleGroupItem>
						<ToggleGroupItem value="7d">Last 7 days</ToggleGroupItem>
					</ToggleGroup>
					<Select value={timeRange} onValueChange={setTimeRange}>
						<SelectTrigger
							className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
							size="sm"
							aria-label="Select a value"
						>
							<SelectValue placeholder="Last 3 months" />
						</SelectTrigger>
						<SelectContent className="rounded-xl">
							<SelectItem value="90d" className="rounded-lg">
								Last 3 months
							</SelectItem>
							<SelectItem value="30d" className="rounded-lg">
								Last 30 days
							</SelectItem>
							<SelectItem value="7d" className="rounded-lg">
								Last 7 days
							</SelectItem>
						</SelectContent>
					</Select>
				</CardAction>
			</CardHeader>
			<CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
				<ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
					<AreaChart data={filteredData}>
						<defs>
							<linearGradient id="fillRequests" x1="0" y1="0" x2="0" y2="1">
								<stop offset="5%" stopColor="var(--color-requests)" stopOpacity={0.75} />
								<stop offset="95%" stopColor="var(--color-requests)" stopOpacity={0.06} />
							</linearGradient>
						</defs>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="date"
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							minTickGap={32}
							tickFormatter={value => {
								const date = new Date(value);
								return date.toLocaleDateString("en-US", {
									month: "short",
									day: "numeric",
								});
							}}
						/>
						<ChartTooltip
							cursor={false}
							content={
								<ChartTooltipContent
									labelFormatter={value =>
										new Date(value).toLocaleDateString("en-US", {
											month: "short",
											day: "numeric",
										})
									}
									indicator="dot"
								/>
							}
						/>
						<Area dataKey="requests" type="natural" fill="url(#fillRequests)" stroke="var(--color-requests)" />
					</AreaChart>
				</ChartContainer>
			</CardContent>
		</Card>
	);
}
