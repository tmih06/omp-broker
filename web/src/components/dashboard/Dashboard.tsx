import { type CSSProperties, useMemo, useState } from "react";
import { Aperture, LayoutDashboard } from "lucide-react";
import { ActivityHeatmap } from "@/components/arc/activity-heatmap/activity-heatmap";
import { Badge } from "@/components/arc/badge/badge";
import { Breadcrumb } from "@/components/arc/breadcrumb/breadcrumb";
import { Card } from "@/components/arc/card/card";
import { LineChart } from "@/components/arc/line-chart/line-chart";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Timeline } from "@/components/arc/timeline/timeline";
import { StackedBars } from "@/components/bencho/StackedBars";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { useGatewayHealth, type GatewayHealth } from "@/hooks/use-gateway-health";
import { buildMetrics, buildPreviewDays, buildPreviewEvents, toLineChartData } from "@/lib/preview-data";
import styles from "./Dashboard.module.css";

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

type Range = "7d" | "30d";

function healthTone(health: GatewayHealth): "success" | "danger" | "neutral" {
	if (health === "online") return "success";
	if (health === "offline") return "danger";
	return "neutral";
}

function healthLabel(health: GatewayHealth): string {
	if (health === "online") return "Gateway online";
	if (health === "offline") return "Gateway offline";
	return "Checking gateway";
}

export function Dashboard() {
	const health = useGatewayHealth();
	const [range, setRange] = useState<Range>("7d");
	const [now] = useState(() => Date.now());
	const days = useMemo(() => buildPreviewDays(182), []);
	const recent = useMemo(() => days.slice(-30), [days]);
	const metrics = useMemo(() => buildMetrics(recent), [recent]);
	const chartData = useMemo(() => toLineChartData(recent, range === "7d" ? 7 : 30), [recent, range]);
	const events = useMemo(() => buildPreviewEvents(now), [now]);
	const heatmapDays = useMemo(
		() => days.map(day => ({ date: new Date(day.at).toISOString().slice(0, 10), count: day.requests })),
		[days],
	);

	return (
		<SidebarProvider style={{ "--sidebar-width": "244px" } as CSSProperties}>
			<Sidebar variant="inset" collapsible="icon">
				<SidebarHeader className={styles.brandHeader}>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton asChild className={styles.brandButton}>
								<a href="/" aria-label="omp-broker dashboard">
									<span className={styles.brandMark}>
										<Aperture size={17} strokeWidth={1.6} />
									</span>
									<span className={`${styles.brandText} group-data-[collapsible=icon]:hidden`}>
										<span className={styles.brandName}>omp-broker</span>
										<span className={styles.brandMeta}>Gateway console</span>
									</span>
								</a>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>

				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Workspace</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton asChild isActive tooltip="Dashboard">
										<a href="/" aria-current="page">
											<LayoutDashboard />
											<span className={styles.navLabel}>Dashboard</span>
										</a>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>

				<SidebarFooter>
					<div
						className={`${styles.gateway} group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-1`}
					>
						<span className={styles.dot} data-state={health} aria-hidden="true" />
						<span className={`${styles.gatewayText} group-data-[collapsible=icon]:hidden`}>
							<span className={styles.gatewayName}>Gateway</span>
							<span className={styles.gatewayState}>
								{health === "online" ? "Connected" : health === "offline" ? "Not running" : "Checking…"}
							</span>
						</span>
					</div>
				</SidebarFooter>
				<SidebarRail />
			</Sidebar>

			<SidebarInset className="md:border md:border-border">
				<header className={styles.topbar}>
					<div className={styles.topbarStart}>
						<SidebarTrigger className={styles.trigger} />
						<span className={styles.separator} aria-hidden="true" />
						<Breadcrumb items={[{ label: "Workspace" }, { label: "Dashboard" }]} />
					</div>
					<Badge tone={healthTone(health)} size="sm">
						{healthLabel(health)}
					</Badge>
				</header>

				<div className={styles.page}>
					<div className={styles.intro}>
						<div>
							<div className={styles.titleRow}>
								<h1>Dashboard</h1>
								<Badge tone="neutral" size="sm">
									Preview
								</Badge>
							</div>
							<p>Requests, usage, and recent gateway activity at a glance.</p>
						</div>
					</div>

					<section className={styles.metrics} aria-label="Key metrics">
						{metrics.map(metric => (
							<div key={metric.label} className={styles.metricCell}>
								<MetricCard {...metric} />
							</div>
						))}
					</section>

					<div className={styles.grid}>
						<Card title="Request volume" description="Requests handled per day" className={styles.chartCard}>
							<div className={styles.chartHead}>
								<SegmentedControl
									options={[
										{ value: "7d", label: "7d" },
										{ value: "30d", label: "30d" },
									]}
									value={range}
									onValueChange={value => setRange(value === "30d" ? "30d" : "7d")}
									label="Chart range"
								/>
							</div>
							<LineChart
								data={chartData}
								series={[{ key: "requests", label: "Requests", area: true }]}
								label="Requests handled per day"
								height={260}
								formatTick={value => compact.format(value)}
							/>
						</Card>

						<div className={styles.usage} data-stroke="on">
							<StackedBars
								colour="Mono"
								bars={14}
								title="Usage"
								unit="requests"
								categories={["Chat", "Messages", "Responses", "Other"]}
								errorLabel="Errors"
							/>
						</div>

						<Card title="Recent activity" description="Latest gateway events" className={styles.activityCard}>
							<Timeline events={events} now={now} label="Recent gateway activity" maxHeight={330} headingLevel={4} />
						</Card>

						<Card title="Daily activity" description="Requests per day" className={styles.heatmapCard}>
							<ActivityHeatmap
								days={heatmapDays}
								label="Requests per day"
								period="the last 6 months"
								unit={{ one: "request", other: "requests" }}
							/>
						</Card>
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
