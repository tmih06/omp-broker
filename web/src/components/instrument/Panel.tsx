import type { CSSProperties } from "react";
import { cn } from "cn";

export function Panel({
	className,
	children,
	index = 0,
	...props
}: React.ComponentProps<"section"> & { index?: number }) {
	return (
		<section
			className={cn("inst-panel reveal", className)}
			style={{ ["--i" as string]: index } as CSSProperties}
			{...props}
		>
			{children}
		</section>
	);
}

export interface SegmentOption<T extends string> {
	value: T;
	label: string;
}

export function Segmented<T extends string>({
	options,
	value,
	onChange,
	label,
}: {
	options: readonly SegmentOption<T>[];
	value: T;
	onChange: (value: T) => void;
	label: string;
}) {
	const active = Math.max(
		0,
		options.findIndex(option => option.value === value),
	);
	return (
		<div
			className="inst-seg"
			role="group"
			aria-label={label}
			style={{ ["--seg-n" as string]: options.length } as CSSProperties}
		>
			<span className="inst-seg-thumb" aria-hidden style={{ transform: `translateX(${active * 100}%)` }} />
			{options.map(option => (
				<button
					key={option.value}
					type="button"
					aria-pressed={option.value === value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
