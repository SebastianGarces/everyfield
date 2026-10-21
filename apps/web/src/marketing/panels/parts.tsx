import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { CardIcon, NUM, type Tone } from "@/components/kit/kit";
import { Icon } from "@/components/Icon";
import { St } from "@/components/motion/scene";

// Server parts of the product panels: markup, copy and icons. The animated leaves (components/motion/fx.tsx) and each
// family's timing registry (*-fx.tsx) run in the browser.

/** Panel header: icon (or Evry), title, subtitle, and an optional control on the right. */
export function Head({
	i = 0,
	lead,
	title,
	sub,
	right,
	className,
}: {
	i?: number;
	lead: ReactNode;
	title: string;
	sub: ReactNode;
	right?: ReactNode;
	className?: string;
}) {
	return (
		<St i={i} className={cn("mb-3.5 flex items-center gap-3", className)}>
			{lead}
			<div className="min-w-0 flex-1">
				<div className="font-title type-title-sm leading-[1.2] tracking-[-0.02em]">{title}</div>
				<div className="mt-0.5 type-sm text-text-3">{sub}</div>
			</div>
			{right}
		</St>
	);
}
export function PIcon({ tone, icon }: { tone: Tone; icon: IconSvgElement }) {
	return <CardIcon tone={tone} icon={icon} size={36} glyph={17} />;
}
/** The common panel header with a tinted icon. */
export function PanelHead({
	tone,
	icon,
	title,
	sub,
	right,
}: {
	tone: Tone;
	icon: IconSvgElement;
	title: string;
	sub: string;
	right?: ReactNode;
}) {
	return <Head lead={<PIcon tone={tone} icon={icon} />} title={title} sub={sub} right={right} />;
}
export function Lab({ children, flush }: { children: ReactNode; flush?: boolean }) {
	return <span className={cn("block type-xs font-semibold text-text-2", !flush && "mb-1.5")}>{children}</span>;
}

/** A dashboard number. className sets the size and the serif: font-display at 24px and up, font-title below. */
export function Num({ className, children }: { className?: string; children: ReactNode }) {
	return <span className={cn(NUM, className)}>{children}</span>;
}

/* ---------- InsightCard parts (focus, top finding, where help could matter) ---------- */
/** The pill never wraps or shrinks (owner finding 00:52: "Where help could matter" broke onto two lines); when the row
 *  runs out of room, the count moves under it. */
export function InsightTop({
	i,
	icon,
	label,
	count,
}: {
	i: number;
	icon: IconSvgElement;
	label: string;
	count: string;
}) {
	return (
		<St i={i} className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5">
			<span className="inline-flex h-[30px] flex-none items-center gap-[7px] bg-[var(--pill-bg)] px-3 type-sm font-semibold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--pill-edge)]">
				<Icon icon={icon} />
				{label}
			</span>
			<span className="type-sm text-[var(--on-3)]">{count}</span>
		</St>
	);
}
export function InsightMetric({
	i,
	num,
	unit,
	numClassName,
	unitMax = 180,
}: {
	i: number;
	num: ReactNode;
	unit: string;
	numClassName?: string;
	unitMax?: number;
}) {
	return (
		<St i={i} className="mt-5 flex items-end gap-3">
			<span className={cn(NUM, "font-display type-display-md leading-[.95]", numClassName)}>{num}</span>
			<span className="pb-[3px] type-md leading-[1.3] text-[var(--on-2)]" style={{ maxWidth: unitMax }}>
				{unit}
			</span>
		</St>
	);
}
export const INSIGHT_TITLE = "mt-3.5 font-title type-title-md leading-[1.18] tracking-[-0.02em]";
export const INSIGHT_TEXT = "type-md text-[var(--on-2)]";
export const INSIGHT_FOOTER = "mt-auto flex flex-wrap gap-2 pt-5";
