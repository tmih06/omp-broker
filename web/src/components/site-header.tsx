import { SidebarTrigger } from "@/components/ui/sidebar";
import { gatewayUrl } from "@/hooks/use-gateway-health";

export function SiteHeader() {
	return (
		<header className="inst-header">
			<SidebarTrigger className="inst-icon-btn" />
			<div>
				<h1 className="inst-page-title">Dashboard</h1>
				<div className="inst-page-sub">gateway telemetry</div>
			</div>
			<div className="inst-header-right">
				<span className="inst-tag">Preview data</span>
				<span className="inst-address">{gatewayUrl.replace(/^https?:\/\//, "")}</span>
				<a
					className="inst-source"
					href="https://github.com/tmih06/omp-broker"
					rel="noopener noreferrer"
					target="_blank"
				>
					Source ↗
				</a>
			</div>
		</header>
	);
}
