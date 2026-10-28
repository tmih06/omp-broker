import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animate, motion, useMotionValue } from "framer-motion";

import { Segmented, type SegmentOption } from "@/components/instrument/Panel";
import { useSeen } from "@/hooks/use-seen";
import { buildPreviewDays, type PreviewDay } from "@/lib/preview-data";

const RANGES: readonly SegmentOption<Range>[] = [
	{ value: "3M", label: "3M" },
	{ value: "30D", label: "30D" },
	{ value: "7D", label: "7D" },
];

type Range = "3M" | "30D" | "7D";
type VolumeBar = {
	values: number[];
	error: number;
	total: number;
	label: string;
	short: string;
};

const CATEGORIES = ["Chat", "Messages", "Responses", "Other"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CH = 198;
const BH = 22;
const LIFT = 2;
const SEG_GAP = 2;
const TIP_W = 164;
const SPRING = { type: "spring" as const, stiffness: 380, damping: 34 };
const DAY_MS = 86_400_000;

const fmt = (value: number) => Math.round(value).toLocaleString("en-US");

function dayLabel(ms: number) {
	const date = new Date(ms);
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function groupVolume(days: readonly PreviewDay[], range: Range): VolumeBar[] {
	if (range !== "3M") {
		const count = range === "30D" ? 30 : 7;
		return days.slice(-count).map(day => ({
			values: [day.counts.chat, day.counts.messages, day.counts.responses, day.counts.other],
			error: day.errors,
			total: day.requests,
			label: dayLabel(day.at),
			short: dayLabel(day.at),
		}));
	}

	const out: VolumeBar[] = [];
	for (let index = 0; index < days.length; index += 7) {
		const week = days.slice(index, index + 7);
		const first = week[0];
		const last = week.at(-1);
		if (!first || !last) continue;
		const values = [0, 1, 2, 3].map(series =>
			week.reduce(
				(sum, day) => sum + [day.counts.chat, day.counts.messages, day.counts.responses, day.counts.other][series]!,
				0,
			),
		);
		const error = week.reduce((sum, day) => sum + day.errors, 0);
		out.push({
			values,
			error,
			total: values.reduce((sum, value) => sum + value, 0),
			label: `${dayLabel(first.at)} – ${dayLabel(last.at)}`,
			short: dayLabel(first.at),
		});
	}
	return out;
}

function PopDigits({ value }: { value: number }) {
	const [generation, setGeneration] = useState(0);
	const last = useRef(value);
	useEffect(() => {
		if (last.current === value) return;
		last.current = value;
		setGeneration(current => current + 1);
	}, [value]);

	return (
		<span className="stb-num" aria-label={fmt(value)}>
			{fmt(value)
				.split("")
				.map((character, index) => (
					<span
						key={`${generation}-${index}`}
						className="stb-digit"
						data-pop={generation > 0 || undefined}
						style={{ ["--i" as string]: index } as CSSProperties}
						aria-hidden
					>
						{character}
					</span>
				))}
		</span>
	);
}

export function VolumePanel() {
	const [range, setRange] = useState<Range>("30D");
	const [at, setAt] = useState<number | null>(null);
	const [width, setWidth] = useState(0);
	const { ref: root, seen } = useSeen<HTMLDivElement>();
	const plot = useRef<HTMLDivElement | null>(null);

	const days = useMemo(() => buildPreviewDays(91), []);
	const data = useMemo(() => groupVolume(days, range), [days, range]);
	const n = data.length;

	useEffect(() => {
		setAt(null);
	}, [range]);

	useLayoutEffect(() => {
		const element = plot.current;
		if (!element) return;
		const measure = () => setWidth(element.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const cw = Math.max(160, width || 640);
	const gap = Math.max(1, Math.min(8, (cw - 3 * n) / Math.max(1, n - 1)));
	const barWidth = (cw - gap * (n - 1)) / n;
	const radius = Math.min(2.5, barWidth / 2);
	const totals = data.map(bar => bar.total);
	const maxTotal = Math.max(1, ...totals);
	const maxError = Math.max(1, ...data.map(bar => bar.error));
	const scale = (CH - LIFT - 2 - SEG_GAP * (CATEGORIES.length - 1)) / maxTotal;
	const layout = data.map(bar => {
		let offset = 0;
		const segments = bar.values.map(value => {
			const height = Math.max(2, value * scale);
			const segment = { bottom: offset, height };
			offset += height + SEG_GAP;
			return segment;
		});
		return {
			segments,
			top: offset - SEG_GAP,
			error: Math.max(2, (bar.error / maxError) * (BH - LIFT - 2)),
		};
	});

	const total = totals.reduce((sum, value) => sum + value, 0);
	const current = at !== null && at < n ? data[at] : null;

	const ringX = useMotionValue(0);
	const ringY = useMotionValue(0);
	const ringH = useMotionValue(0);
	const tipX = useMotionValue(0);
	const was = useRef<number | null>(null);

	useEffect(() => {
		if (at === null || at >= n) {
			was.current = null;
			return;
		}
		const bar = layout[at];
		if (!bar) {
			was.current = null;
			return;
		}
		const left = at * (barWidth + gap);
		const x = left - 3;
		const up = seen ? bar.top : 0;
		const down = seen ? bar.error : 0;
		const y = CH - LIFT - up - 3;
		const height = up + LIFT + 1 + LIFT + down + 6;
		const right = left + barWidth + 8;
		const rawTip = right + TIP_W <= cw || left - 8 - TIP_W < 0 ? Math.min(cw - TIP_W, right) : left - 8 - TIP_W;
		const tx = Math.max(0, rawTip);
		const go = (motionValue: typeof ringX, next: number) => {
			if (was.current === null) motionValue.set(next);
			else animate(motionValue, next, SPRING);
		};
		go(ringX, x);
		go(ringY, y);
		go(ringH, height);
		go(tipX, tx);
		was.current = at;
	}, [at, n, barWidth, gap, range, seen, cw, layout, ringH, ringX, ringY, tipX]);

	const pick = (event: React.PointerEvent<HTMLDivElement>) => {
		const bounds = plot.current?.getBoundingClientRect();
		if (!bounds || bounds.width === 0) return;
		const index = Math.floor(((event.clientX - bounds.left) / bounds.width) * n);
		setAt(Math.max(0, Math.min(n - 1, index)));
	};

	const subtitle = range === "3M" ? "Last 13 weeks" : range === "30D" ? "Last 30 days" : "Last 7 days";
	const period = range === "3M" ? "week" : "day";
	const first = data[0];
	const last = data.at(-1);
	const daysShown = range === "3M" ? 91 : range === "30D" ? 30 : 7;
	const lastDate = new Date(days[days.length - 1]?.at ?? Date.now());
	const firstDate = new Date(lastDate.getTime() - (daysShown - 1) * DAY_MS);

	return (
		<div
			ref={root}
			className="stb vol"
			data-colour="on"
			data-scrub={current ? "" : undefined}
			style={{ ["--stb-r" as string]: `${radius}px`, ["--stb-rr" as string]: `${radius + 3}px` } as CSSProperties}
		>
			<div className="stb-head">
				<div className="stb-titles">
					<h2 className="stb-title">Request volume</h2>
					<div className="stb-sub">
						{subtitle} · per {period}
					</div>
				</div>
				<Segmented options={RANGES} value={range} onChange={setRange} label="Request volume range" />
			</div>

			<div className="stb-figure">
				<PopDigits value={total} />
				<span className="stb-unit">requests</span>
			</div>

			<div
				ref={plot}
				className="stb-plot"
				role="img"
				aria-label={`Request volume, ${first ? dayLabel(firstDate.getTime()) : ""} to ${last ? dayLabel(lastDate.getTime()) : ""}, ${fmt(total)} requests`}
				style={{ height: CH + 1 + BH }}
				onPointerDown={event => {
					try {
						event.currentTarget.setPointerCapture(event.pointerId);
					} catch {
						/* scripted */
					}
					pick(event);
				}}
				onPointerMove={pick}
				onPointerUp={event => {
					try {
						event.currentTarget.releasePointerCapture(event.pointerId);
					} catch {
						/* scripted */
					}
					if (event.pointerType !== "mouse") setAt(null);
				}}
				onPointerCancel={() => setAt(null)}
				onPointerLeave={() => setAt(null)}
			>
				<span className="stb-base" style={{ top: CH }} />
				{data.map((_, index) => (
					<div
						key={`${range}-${index}`}
						className="stb-col"
						data-on={at === index || undefined}
						style={{ left: index * (barWidth + gap), width: barWidth, ["--i" as string]: index } as CSSProperties}
					>
						{layout[index]?.segments.map((segment, series) => (
							<span
								key={series}
								className="stb-bar"
								style={
									{
										["--c" as string]: `var(--stb-c${series + 1})`,
										bottom: BH + 1 + LIFT + (seen ? segment.bottom : 0),
										height: seen ? segment.height : 0,
									} as CSSProperties
								}
							/>
						))}
						<span
							className="stb-esc"
							style={{
								top: CH + 1 + LIFT,
								height: seen ? (layout[index]?.error ?? 0) : 0,
							}}
						/>
					</div>
				))}

				<motion.span
					className="stb-ring"
					aria-hidden
					style={{ x: ringX, y: ringY, height: ringH, width: barWidth + 6 }}
				/>

				<motion.div className="stb-tip" style={{ x: tipX, width: TIP_W }} aria-hidden={!current}>
					{current ? (
						<>
							<div className="stb-tip-head">
								<span>{current.label}</span>
								<b>{fmt(current.total)}</b>
							</div>
							{current.values.map((value, series) => (
								<div className="stb-tip-row" key={CATEGORIES[series]}>
									<i style={{ ["--c" as string]: `var(--stb-c${series + 1})` } as CSSProperties} />
									<span>{CATEGORIES[series]}</span>
									<b>{fmt(value)}</b>
								</div>
							))}
							<div className="stb-tip-row" data-esc="">
								<i />
								<span>Errors</span>
								<b>{current.error}</b>
							</div>
						</>
					) : null}
				</motion.div>
			</div>

			<div className="stb-axis">
				<span>{first?.short ?? ""}</span>
				<span>{last?.short ?? ""}</span>
			</div>
		</div>
	);
}
