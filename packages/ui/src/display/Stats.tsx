import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { ComponentPropsWithRef, CSSProperties, ElementType, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { HUE, SOLID, TINT, type Tone } from "./tone";
import { formatCount, type Count } from "./values";

/**
 * Stat (components.md): Label, Value, Delta and Caption. `value` null means not recorded: it shows a dash and says
 * "Not recorded", never 0 (foundations.md: an empty count is not a zero).
 */
export function Stat({
	label,
	value,
	delta,
	caption,
	size = "md",
	className,
	children,
}: {
	label: ReactNode;
	value: Count | string;
	delta?: ReactNode;
	caption?: ReactNode;
	size?: "md" | "lg" | "xl";
	className?: string;
	/** A TargetBar or Progress under the caption. */
	children?: ReactNode;
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<div className="text-md text-text-3">{label}</div>
			<div className="mt-2.5 flex items-end gap-3">
				<StatValue value={value} size={size} />
				{delta ? <span className={size === "xl" ? "mb-2.5" : "mb-1"}>{delta}</span> : null}
			</div>
			{caption ? <div className="mt-2 text-md text-pretty text-text-2">{caption}</div> : null}
			{children}
		</div>
	);
}

const VALUE_SIZE = {
	md: "text-display-sm tracking-[-0.04em]",
	lg: "text-display-md tracking-[-0.04em]",
	xl: "text-display-lg tracking-[-0.05em]",
};

function StatValue({ value, size }: { value: Count | string; size: "md" | "lg" | "xl" }) {
	if (value === null) {
		return (
			<span className={cn("font-display leading-none font-medium text-text-3", VALUE_SIZE[size])}>
				<span aria-hidden="true">–</span>
				<span className="sr-only">Not recorded</span>
			</span>
		);
	}
	return (
		<span className={cn("num leading-none font-medium text-ink", VALUE_SIZE[size])}>
			{typeof value === "number" ? formatCount(value) : value}
		</span>
	);
}

/** StatStrip (components.md): stats side by side with a hairline between them. They stack below 640px. */
export function StatStrip({ className, ...props }: ComponentPropsWithRef<"div">) {
	return (
		<div
			className={cn(
				"grid auto-cols-fr grid-flow-col max-app-sm:grid-flow-row max-app-sm:gap-5",
				"*:border-l *:border-line *:px-[26px] *:py-0.5 *:first:border-l-0 *:first:pl-0",
				"max-app-sm:*:border-l-0 max-app-sm:*:px-0",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * Metric zero (components.md, Zero metric): a real recorded zero, in quiet type, with the sentence that explains what
 * will make it grow. Use it only for a known 0; a value that did not load is a StatePanel, never a zero.
 */
export function ZeroMetric({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={className}>
			<div className="font-display text-[44px] leading-none text-text-3">0</div>
			<p className="mt-3 text-pretty text-text-2">{children}</p>
		</div>
	);
}

function pct(value: number, max: number): number {
	if (!(max > 0)) return 0;
	return Math.min(100, Math.max(0, (value / max) * 100));
}

/**
 * TargetBar (components.md): a fill toward a benchmark mark, with a legend. Hatch (the default) is a planned or
 * estimated count; solid is a measured one. The bar is a meter with its own name and value text.
 */
export function TargetBar({
	label,
	value,
	max,
	target,
	targetLabel,
	tone = "green",
	solid,
	className,
}: {
	label: string;
	value: number;
	max: number;
	target?: number;
	targetLabel?: string;
	tone?: Extract<Tone, "green" | "blue" | "magenta">;
	solid?: boolean;
	className?: string;
}) {
	const mark = target === undefined ? null : pct(target, max);
	return (
		<div className={className}>
			<div
				role="meter"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={max}
				aria-valuenow={value}
				aria-valuetext={target === undefined ? `${value} of ${max}` : `${value}, ${targetLabel ?? `target ${target}`}`}
				className="relative h-3.5 rounded-full bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line)]"
			>
				<span
					className={cn("absolute inset-y-0.5 left-0.5 rounded-full", solid ? SOLID[tone] : "hatch")}
					style={{ width: `calc(${pct(value, max)}% - 4px)`, ["--hatch" as string]: HUE[tone] }}
				/>
				{mark === null ? null : (
					<span className="absolute -inset-y-[7px] w-0.5 rounded-[2px] bg-ink" style={{ left: `${mark}%` }} />
				)}
			</div>
			<div aria-hidden="true" className="relative mt-2.5 flex justify-between text-sm text-text-3">
				<span>0</span>
				{mark === null ? null : (
					<span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${mark}%` }}>
						{targetLabel ?? target}
					</span>
				)}
				<span>{mark === null ? max : null}</span>
			</div>
		</div>
	);
}

/** Progress (components.md): a thin bar. `label` names it for assistive technology. */
export function Progress({
	label,
	value,
	max = 100,
	tone = "green",
	size = "md",
	className,
}: {
	label: string;
	value: number;
	max?: number;
	tone?: Tone;
	size?: "md" | "sm";
	className?: string;
}) {
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={max}
			aria-valuenow={value}
			className={cn("overflow-hidden rounded-full bg-surface-2", size === "sm" ? "h-1.5" : "h-2", className)}
		>
			<span className={cn("block h-full rounded-full", SOLID[tone])} style={{ width: `${pct(value, max)}%` }} />
		</div>
	);
}

/** Meter (components.md): a hatched gauge inside an outlined track, as roles filled on a ministry card. */
export function Meter({
	label,
	value,
	max,
	valueText,
	tone = "green",
	className,
}: {
	label: string;
	value: number;
	max: number;
	valueText?: string;
	tone?: Tone;
	className?: string;
}) {
	return (
		<div
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={max}
			aria-valuenow={value}
			aria-valuetext={valueText ?? `${value} of ${max}`}
			className={cn(
				"relative h-3 overflow-hidden rounded-full bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line)]",
				className,
			)}
		>
			<span
				className="hatch absolute inset-y-0.5 left-0.5 rounded-full"
				style={{ width: `calc(${pct(value, max)}% - 4px)`, ["--hatch" as string]: HUE[tone] }}
			/>
		</div>
	);
}

/** Ring (components.md): a round gauge with its value in the middle ("71%", "4/10"). */
export function Ring({
	label,
	value,
	max = 100,
	display,
	tone = "green",
	className,
}: {
	label: string;
	value: number;
	max?: number;
	/** The text in the middle; defaults to the percentage. */
	display?: string;
	tone?: Tone;
	className?: string;
}) {
	const p = pct(value, max);
	const text = display ?? `${Math.round(p)}%`;
	return (
		<span
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={max}
			aria-valuenow={value}
			aria-valuetext={text}
			className={cn("grid size-14 flex-none place-items-center rounded-full", className)}
			style={{ background: `conic-gradient(${HUE[tone]} ${p}%, var(--ef-surface-2) 0)` }}
		>
			<span className="grid size-[calc(100%-12px)] place-items-center rounded-full bg-surface font-display text-sm font-semibold text-ink">
				{text}
			</span>
		</span>
	);
}

/** KeyValue (components.md): Key, Value and an optional Delta in a ruled list. */
export function KeyValue({
	k,
	value,
	delta,
	size = "md",
	className,
}: {
	k: ReactNode;
	value: Count | ReactNode;
	delta?: ReactNode;
	/** sm: a compact text row for side panels ("Based on · Everyfield global v4"). */
	size?: "md" | "sm";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-3 border-t border-line first:border-t-0",
				size === "sm" ? "py-2.5 text-sm" : "py-3.5",
				className,
			)}
		>
			<dt className="text-text-2">{k}</dt>
			<dd className="flex items-center gap-2">
				{value === null ? (
					<span className="text-text-3">Not recorded</span>
				) : (
					<span
						className={
							size === "sm" ? "text-right font-medium text-ink" : "num text-xl font-medium tracking-[-0.02em] text-ink"
						}
					>
						{typeof value === "number" ? formatCount(value) : value}
					</span>
				)}
				{delta}
			</dd>
		</div>
	);
}

/** A list of KeyValue rows. It is a description list, so each key names its value. */
export function KeyValueList({ className, ...props }: ComponentPropsWithRef<"dl">) {
	return <dl className={cn("flex flex-col", className)} {...props} />;
}

type ListRowProps = {
	title: ReactNode;
	subtitle?: ReactNode;
	/** An icon in a tone circle, or an Avatar passed as `leading`. */
	icon?: IconSvgElement;
	tone?: Tone;
	leading?: ReactNode;
	trailing?: ReactNode;
	/** A link row: it shows the chevron. Pass `linkAs` (next/link) for client navigation. */
	href?: string;
	linkAs?: ElementType;
	onClick?: () => void;
	/** The subtitle in magenta, for an overdue or failing item. */
	urgent?: boolean;
	className?: string;
};

/**
 * ListRow (components.md): Icon, Title, Subtitle and Trailing. With href it is a link, with onClick a button, else a
 * plain row. Rows are ruled by a hairline and draw the focus ring inside their edge.
 */
export function ListRow({
	title,
	subtitle,
	icon,
	tone = "ink",
	leading,
	trailing,
	href,
	linkAs,
	onClick,
	urgent,
	className,
}: ListRowProps) {
	const interactive = href !== undefined || onClick !== undefined;
	const Comp: ElementType = href !== undefined ? (linkAs ?? "a") : onClick ? "button" : "div";
	return (
		<Comp
			href={href}
			type={Comp === "button" ? "button" : undefined}
			onClick={onClick}
			data-focus-inset={interactive ? "" : undefined}
			className={cn(
				"flex w-full items-center gap-3.5 border-t border-line py-4 text-left text-ink first:border-t-0",
				interactive && "-mx-2 w-[calc(100%+16px)] cursor-pointer rounded-md px-2 transition-colors hover:bg-hover",
				className,
			)}
		>
			{leading ??
				(icon ? (
					<span aria-hidden="true" className={cn("grid size-11 flex-none place-items-center rounded-full", TINT[tone])}>
						<Icon icon={icon} size={20} />
					</span>
				) : null)}
			<span className="min-w-0 flex-1">
				<span className="block text-[15px] font-medium">{title}</span>
				{subtitle ? (
					<span className={cn("mt-0.5 block text-md", urgent ? "text-magenta-600" : "text-text-3")}>{subtitle}</span>
				) : null}
			</span>
			{trailing}
			{href !== undefined ? <Icon icon={ArrowRight01Icon} size={16} className="text-text-3" /> : null}
		</Comp>
	);
}

/** A list of ListRows, or of any rows ruled the same way. */
export function List({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("flex flex-col", className)} {...props} />;
}

export type LegendItem = { label: ReactNode; tone: Tone; count?: number; mark?: "dot" | "swatch" | "hatch" };

/**
 * Legend (components.md): Swatch or Dot and Label, with an optional count pill (Legend.Count). The labels carry the
 * meaning; the swatches only repeat the chart's hues.
 */
export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
	return (
		<ul className={cn("flex flex-wrap items-center gap-x-[18px] gap-y-2 text-md text-text-2", className)}>
			{items.map((item, i) => (
				<li key={i} className="inline-flex items-center gap-2">
					<LegendMark tone={item.tone} mark={item.mark ?? "dot"} />
					{item.label}
					{item.count === undefined ? null : <LegendCount>{item.count}</LegendCount>}
				</li>
			))}
		</ul>
	);
}

function LegendMark({ tone, mark }: { tone: Tone; mark: "dot" | "swatch" | "hatch" }) {
	if (mark === "dot") return <i aria-hidden="true" className={cn("size-[9px] rounded-full", SOLID[tone])} />;
	return (
		<i
			aria-hidden="true"
			className={cn("h-2.5 w-[22px] rounded-full", mark === "hatch" ? "hatch" : SOLID[tone])}
			style={mark === "hatch" ? ({ "--hatch": HUE[tone] } as CSSProperties) : undefined}
		/>
	);
}

/** Legend.Count: the count pill after an item name. */
export function LegendCount({ children }: { children: ReactNode }) {
	return (
		<span className="rounded-[7px] bg-surface-2 px-[7px] py-px text-[13px] font-semibold text-ink tabular-nums">
			{children}
		</span>
	);
}
Legend.Count = LegendCount;

/**
 * CoverageBar (components.md, Evidence coverage): Category, bar and "n of total". A plant that does not share a
 * category counts as unknown, never as zero, so the bar shows how much of the total the insight can see.
 */
export function CoverageBar({
	category,
	n,
	total,
	className,
}: {
	category: ReactNode;
	n: number;
	total: number;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-[130px_minmax(0,1fr)_54px] items-center gap-3 py-2 text-sm max-app-sm:grid-cols-[96px_minmax(0,1fr)_54px]",
				className,
			)}
		>
			<span className="truncate text-text-2">{category}</span>
			<span
				role="meter"
				aria-label={typeof category === "string" ? `${category} coverage` : "Coverage"}
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={n}
				aria-valuetext={`${n} of ${total}`}
				className="h-2 overflow-hidden rounded-full bg-surface-2"
			>
				<i className="block h-full rounded-full bg-blue-500" style={{ width: `${pct(n, total)}%` }} />
			</span>
			<b aria-hidden="true" className="text-right font-semibold text-ink tabular-nums">
				{n} of {total}
			</b>
		</div>
	);
}
