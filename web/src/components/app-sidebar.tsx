import type { ComponentProps } from "react";
import { IconDashboard, IconInnerShadowTop } from "@tabler/icons-react";

import { useGatewayHealth } from "@/hooks/use-gateway-health";
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

export function AppSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
	const health = useGatewayHealth();
	const status = health === "online" ? "Connected" : health === "offline" ? "Not running" : "Checking";

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!">
							<a href="/">
								<IconInnerShadowTop className="size-5!" />
								<span className="text-base font-semibold group-data-[collapsible=icon]:hidden">omp-broker</span>
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
									<a href="/">
										<IconDashboard />
										<span>Dashboard</span>
									</a>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" className="hover:bg-transparent group-data-[collapsible=icon]:justify-center">
							<span
								className={`size-2 shrink-0 rounded-full ${
									health === "online"
										? "bg-emerald-500"
										: health === "offline"
											? "bg-destructive"
											: "bg-muted-foreground"
								}`}
							/>
							<div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
								<span className="truncate font-medium">Gateway</span>
								<span className="truncate text-xs text-muted-foreground">{status}</span>
							</div>
							<span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">v0.2.0</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
