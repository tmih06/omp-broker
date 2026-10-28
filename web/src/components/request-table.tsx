import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { Panel, Segmented, type SegmentOption } from "@/components/instrument/Panel";
import { buildPreviewRequests } from "@/lib/preview-data";

type Filter = "all" | "errors";

const FILTERS: readonly SegmentOption<Filter>[] = [
	{ value: "all", label: "All" },
	{ value: "errors", label: "Errors" },
];

export function RequestTable() {
	const requests = useMemo(() => buildPreviewRequests(), []);
	const [filter, setFilter] = useState<Filter>("all");
	const filtered = filter === "errors" ? requests.filter(request => request.status >= 400) : requests;

	return (
		<Panel index={4} className="requests">
			<div className="inst-head">
				<div className="inst-titles">
					<h2 className="inst-title">Recent requests</h2>
					<div className="inst-sub">Latest gateway traffic across virtual keys</div>
				</div>
				<Segmented options={FILTERS} value={filter} onChange={setFilter} label="Filter requests" />
			</div>

			<div className="table-scroll" tabIndex={0} role="region" aria-label="Recent requests table, scroll horizontally">
				<table className="inst-table">
					<caption className="sr-only">Recent gateway requests</caption>
					<thead>
						<tr>
							<th scope="col">Time</th>
							<th scope="col">Endpoint</th>
							<th scope="col">Status</th>
							<th scope="col">Model</th>
							<th scope="col" className="right">
								Tokens
							</th>
							<th scope="col" className="right">
								Latency
							</th>
							<th scope="col" className="right">
								Cost
							</th>
							<th scope="col">Key</th>
						</tr>
					</thead>
					<tbody key={filter} className="row-enter">
						{filtered.map((request, index) => (
							<tr key={`${request.at}-${request.path}`} style={{ ["--i" as string]: index } as CSSProperties}>
								<td className="time">
									{new Date(request.at).toLocaleTimeString("en-US", {
										hour: "2-digit",
										minute: "2-digit",
									})}
								</td>
								<td>
									<span className="method">{request.method}</span> <span className="path">{request.path}</span>
								</td>
								<td>
									<span className="status" data-error={request.status >= 400 || undefined}>
										<i className="status-mark" aria-hidden />
										{request.status}
									</span>
								</td>
								<td>
									{request.model ? (
										<>
											{request.model}
											<span className="provider">{request.provider}</span>
										</>
									) : (
										<span className="key">—</span>
									)}
								</td>
								<td className="right">{request.tokens > 0 ? request.tokens.toLocaleString("en-US") : "—"}</td>
								<td className="right">{request.latencyMs.toLocaleString("en-US")} ms</td>
								<td className="right">{request.costUsd > 0 ? `$${request.costUsd.toFixed(4)}` : "—"}</td>
								<td className="key">{request.keyName}</td>
							</tr>
						))}
					</tbody>
				</table>
				{filtered.length === 0 ? <div className="empty-state">No matching requests in this preview.</div> : null}
			</div>

			<div className="inst-foot">
				<span>
					Showing {filtered.length} of {requests.length}
				</span>
				<span>UTC · preview dataset</span>
			</div>
		</Panel>
	);
}
