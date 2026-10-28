import type { CSSProperties } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ChartAreaInteractive } from "@/components/chart-area-interactive";
import { RequestTable } from "@/components/request-table";
import { SectionCards } from "@/components/section-cards";
import { SiteHeader } from "@/components/site-header";
import { StackedBars } from "@/components/bencho/StackedBars";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function Dashboard() {
	return (
		<SidebarProvider
			style={
				{
					"--sidebar-width": "calc(var(--spacing) * 61)",
					"--header-height": "calc(var(--spacing) * 12)",
				} as CSSProperties
			}
		>
			<AppSidebar variant="inset" />
			<SidebarInset>
				<SiteHeader />
				<div className="flex flex-1 flex-col">
					<div className="@container/main flex flex-1 flex-col gap-2">
						<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
							<SectionCards />
							<div className="grid gap-4 px-4 lg:grid-cols-3 lg:px-6">
								<div className="lg:col-span-2">
									<ChartAreaInteractive />
								</div>
								<div className="flex items-start justify-center lg:justify-start" data-stroke="on">
									<StackedBars
										colour="Mono"
										bars={14}
										title="Usage"
										unit="requests"
										categories={["Chat", "Messages", "Responses", "Other"]}
										errorLabel="Errors"
									/>
								</div>
							</div>
							<RequestTable />
						</div>
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
