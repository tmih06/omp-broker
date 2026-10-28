import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildPreviewRequests } from "@/lib/preview-data";

export function RequestTable() {
	const requests = buildPreviewRequests();

	return (
		<Card className="mx-4 lg:mx-6">
			<CardHeader>
				<CardTitle>Recent requests</CardTitle>
				<CardDescription>Latest gateway traffic across virtual keys</CardDescription>
				<CardAction>
					<Badge variant="outline" className="text-muted-foreground">
						Preview
					</Badge>
				</CardAction>
			</CardHeader>
			<CardContent className="px-0">
				<div className="overflow-x-auto">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-20">Time</TableHead>
								<TableHead>Endpoint</TableHead>
								<TableHead className="w-20">Status</TableHead>
								<TableHead>Model</TableHead>
								<TableHead className="w-24 text-right">Tokens</TableHead>
								<TableHead className="w-24 text-right">Latency</TableHead>
								<TableHead className="w-24 text-right">Cost</TableHead>
								<TableHead className="w-24">Key</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{requests.map(request => (
								<TableRow key={`${request.at}-${request.path}`}>
									<TableCell className="text-muted-foreground tabular-nums">
										{new Date(request.at).toLocaleTimeString("en-US", {
											hour: "2-digit",
											minute: "2-digit",
										})}
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-2">
											<Badge variant="outline" className="px-1.5 text-muted-foreground">
												{request.method}
											</Badge>
											<span className="font-mono text-xs">{request.path}</span>
										</div>
									</TableCell>
									<TableCell>
										<Badge
											variant="outline"
											className={
												request.status < 400
													? "text-emerald-500"
													: request.status < 500
														? "text-amber-500"
														: "text-destructive"
											}
										>
											{request.status}
										</Badge>
									</TableCell>
									<TableCell>
										{request.model ? (
											<div className="grid">
												<span className="text-sm">{request.model}</span>
												<span className="text-xs text-muted-foreground">{request.provider}</span>
											</div>
										) : (
											<span className="text-muted-foreground">—</span>
										)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{request.tokens > 0 ? request.tokens.toLocaleString("en-US") : "—"}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{request.latencyMs.toLocaleString("en-US")} ms
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{request.costUsd > 0 ? `$${request.costUsd.toFixed(4)}` : "—"}
									</TableCell>
									<TableCell className="text-muted-foreground">{request.keyName}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</CardContent>
		</Card>
	);
}
