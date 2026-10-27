import { useEffect, useState } from "react";

export type GatewayHealth = "checking" | "online" | "offline";

const configured = (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.trim();
export const gatewayUrl = (configured && configured.length > 0 ? configured : "http://127.0.0.1:4000").replace(
	/\/+$/,
	"",
);

/** Polls the unauthenticated health endpoint so the shell can show a live gateway state. */
export function useGatewayHealth(intervalMs = 15_000): GatewayHealth {
	const [health, setHealth] = useState<GatewayHealth>("checking");

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		const check = async () => {
			try {
				const response = await fetch(`${gatewayUrl}/healthz`, { signal: controller.signal });
				if (!cancelled) setHealth(response.ok ? "online" : "offline");
			} catch {
				if (!cancelled) setHealth("offline");
			}
		};
		void check();
		const timer = window.setInterval(() => void check(), intervalMs);
		return () => {
			cancelled = true;
			controller.abort();
			window.clearInterval(timer);
		};
	}, [intervalMs]);

	return health;
}
