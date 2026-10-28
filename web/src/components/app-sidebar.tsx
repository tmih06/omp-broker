import type { ComponentProps } from "react";

import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useGatewayHealth } from "@/hooks/use-gateway-health";

export function AppSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
	const health = useGatewayHealth();
	const status = health === "online" ? "Connected" : health === "offline" ? "Not running" : "Checking";

	return (
		<Sidebar collapsible="icon" variant="floating" {...props}>
			<SidebarHeader className="rail-head">
				<a className="rail-brand" href="/" aria-label="omp-broker dashboard">
					<span className="rail-mark" aria-hidden>
						<i />
						<i />
						<i />
						<i />
					</span>
					<span className="rail-brand-text">
						<span className="rail-name">omp-broker</span>
						<span className="rail-kind">gateway console</span>
					</span>
				</a>
			</SidebarHeader>

			<SidebarContent>
				<SidebarGroup className="rail-group">
					<SidebarGroupLabel className="rail-label">Workspace</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton asChild isActive tooltip="Dashboard">
									<a className="rail-nav" href="/">
										<span className="nav-mark" aria-hidden>
											<i />
											<i />
											<i />
										</span>
										<span>Dashboard</span>
										<span className="rail-index">01</span>
									</a>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter className="rail-foot">
				<div className="rail-status" title={`${status} · v0.2.0`}>
					<span className="rail-status-mark" data-health={health} aria-hidden />
					<span className="rail-status-text">
						<span className="rail-status-name">Gateway</span>
						<span className="rail-status-value">{status}</span>
					</span>
					<span className="rail-version">v0.2.0</span>
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}
