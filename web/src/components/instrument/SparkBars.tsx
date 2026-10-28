import type { CSSProperties } from "react";

import { useSeen } from "@/hooks/use-seen";

export interface SparkDatum {
	values: number[];
	error: number;
}

const BASELINE = 6;
const ERROR_ROOM = 5;
const SEG_GAP = 1;

/** A miniature of the usage widget's stacked bars: series above the baseline, failures hatched below. */
export function SparkBars({
	data,
	label,
	height = 34,
	tone = 0,
}: {
	data: readonly SparkDatum[];
	label: string;
	height?: number;
	/** Series offset, so a single-series spark does not default to full ink. */
	tone?: number;
}) {
	const { ref, seen } = useSeen<HTMLDivElement>();
	const main = Math.max(1, height - BASELINE - 1);
	const maxSegments = Math.max(1, ...data.map(datum => datum.values.length));
	const totals = data.map(datum => datum.values.reduce((sum, value) => sum + value, 0));
	const maxTotal = Math.max(1, ...totals);
	const maxError = Math.max(1, ...data.map(datum => datum.error));
	const scale = Math.max(0, (main - SEG_GAP * (maxSegments - 1)) / maxTotal);

	return (
		<div ref={ref} className="spark" role="img" aria-label={label}>
			<span className="spark-base" aria-hidden />
			{data.map((datum, index) => {
				let offset = 0;
				const segments = datum.values.map((value, series) => {
					const barHeight = Math.max(1, value * scale);
					const bottom = BASELINE + offset;
					offset += barHeight + SEG_GAP;
					return { barHeight, bottom, series };
				});
				return (
					<div key={index} className="spark-col" aria-hidden style={{ ["--i" as string]: index } as CSSProperties}>
						{segments.map(segment => (
							<span
								key={segment.series}
								className="spark-seg"
								style={
									{
										height: seen ? segment.barHeight : 0,
										bottom: seen ? segment.bottom : BASELINE,
										background: `var(--series-${Math.min(segment.series + 1 + tone, 5)})`,
									} as CSSProperties
								}
							/>
						))}
						{datum.error > 0 ? (
							<span
								className="spark-esc"
								style={{
									top: BASELINE + 1,
									height: seen ? Math.max(1, (datum.error / maxError) * ERROR_ROOM) : 0,
								}}
							/>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
