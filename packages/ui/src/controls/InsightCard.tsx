import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";

export type InsightTone = "field" | "sky" | "sage" | "rose";

type InsightCardProps = ComponentPropsWithRef<"section"> & {
	/** field: default and growth · sky: neutral findings · sage: the top summary · rose: risk and needs attention. */
	tone?: InsightTone;
	size?: "md" | "sm";
};

/**
 * The gradient card (components.md, Insight card; foundations.md, Gradient cards). Use at most two per page, for one
 * finding the person should act on. All tones carry ink text and look the same in both themes: the card is a
 * light-token island, so nested buttons and text keep their light values in dark mode. Give it a Title so the
 * section has a name (aria-labelledby is set by the caller when the title has an id).
 */
export function InsightCard({ tone = "field", size = "md", className, ...props }: InsightCardProps) {
	return (
		<section
			data-tone={tone}
			data-size={size}
			className={cn(
				"ef-insight ef-light-island relative flex flex-col overflow-hidden rounded-card text-[var(--on)]",
				size === "md"
					? "min-h-[300px] px-[30px] py-7 max-app-sm:min-h-0 max-app-sm:px-[22px] max-app-sm:py-[22px]"
					: "px-6 py-[22px]",
				className,
			)}
			{...props}
		/>
	);
}

/** The top row: a Pill on the left and a Count or other small text on the right. */
export function InsightTop({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("flex flex-wrap items-center justify-between gap-2", className)} {...props} />;
}

export function InsightPill({ icon, children }: { icon?: IconSvgElement; children: ReactNode }) {
	return (
		<span className="inline-flex h-8 items-center gap-2 rounded-pill bg-[var(--pill-bg)] px-3.5 text-sm font-medium shadow-[inset_0_0_0_1px_var(--pill-edge)] backdrop-blur-[8px]">
			{icon ? <Icon icon={icon} size={16} /> : null}
			{children}
		</span>
	);
}

export function InsightCount({ className, ...props }: ComponentPropsWithRef<"span">) {
	return <span className={cn("text-sm text-[var(--on-3)]", className)} {...props} />;
}

/** The big number and its unit. `value` is display text, such as "+9" or "62%". */
export function InsightMetric({ value, unit, size = "md" }: { value: string; unit?: ReactNode; size?: "md" | "sm" }) {
	return (
		<p className="mt-[26px] flex items-end gap-3.5">
			<span className={cn("num leading-[.95]", size === "sm" ? "text-[46px]" : "text-[64px] max-app-sm:text-[46px]")}>
				{value}
			</span>
			{unit ? <span className="max-w-[170px] pb-1 text-md leading-[1.3] text-[var(--on-2)]">{unit}</span> : null}
		</p>
	);
}

export function InsightTitle({
	as: Comp = "h2",
	size = "md",
	className,
	...props
}: ComponentPropsWithRef<"h2"> & { as?: "h2" | "h3"; size?: "md" | "sm" }) {
	return (
		<Comp
			className={cn(
				"mt-[18px] max-w-[440px] leading-[1.18] tracking-[-0.02em] text-balance",
				size === "sm"
					? "font-title text-[21px]"
					: "font-display text-[27px] max-app-sm:font-title max-app-sm:text-[22px]",
				className,
			)}
			{...props}
		/>
	);
}

export function InsightText({ className, ...props }: ComponentPropsWithRef<"p">) {
	return <p className={cn("mt-3 max-w-[420px] text-[15px] text-[var(--on-2)] text-pretty", className)} {...props} />;
}

/**
 * A small bar sparkline; the last bar is the current period and is drawn darker. `label` describes the trend in
 * words for screen readers, because the bars alone carry no text.
 */
export function InsightSpark({ values, label }: { values: number[]; label: string }) {
	const max = Math.max(...values, 1);
	return (
		<div role="img" aria-label={label} className="mt-5 flex h-[54px] max-w-[62%] items-end gap-1.5">
			{values.map((v, i) => (
				<span
					key={i}
					style={{ height: `${Math.max((v / max) * 100, 4)}%` }}
					className={cn("flex-1 rounded-md", i === values.length - 1 ? "bg-[var(--spark-hi)]" : "bg-[var(--spark)]")}
				/>
			))}
		</div>
	);
}

/** The bottom row for actions. Use Button variant="light" for the main action and "glass" for a second one. */
export function InsightFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("mt-auto flex flex-wrap items-center gap-2.5 pt-[26px]", className)} {...props} />;
}
