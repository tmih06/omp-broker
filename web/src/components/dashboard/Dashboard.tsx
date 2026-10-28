import type { CSSProperties } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { StackedBars } from "@/components/bencho/StackedBars";
import { RequestLegend } from "@/components/instrument/RequestLegend";
import { VolumePanel } from "@/components/instrument/VolumePanel";
import { RequestTable } from "@/components/request-table";
import { SectionCards } from "@/components/section-cards";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function Dashboard() {
	return (
		<SidebarProvider
			style={
				{
					"--sidebar-width": "calc(var(--spacing) * 58)",
					"--header-height": "calc(var(--spacing) * 14)",
				} as CSSProperties
			}
		>
			<AppSidebar />
			<SidebarInset className="inst-main">
				<SiteHeader />
				<div className="inst-page">
					<SectionCards />
					<div className="inst-split">
						<VolumePanel />
						<div className="inst-side">
							<div className="inst-usage" data-stroke="on">
								<StackedBars
									colour="Colour"
									bars={14}
									title="Usage"
									unit="requests"
									categories={["Chat", "Messages", "Responses", "Other"]}
									errorLabel="Errors"
								/>
							</div>
							<RequestLegend />
						</div>
					</div>
					<RequestTable />
					<footer className="inst-footer">
						<span>omp-broker / gateway console</span>
						<span>preview dataset · generated locally</span>
					</footer>
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
