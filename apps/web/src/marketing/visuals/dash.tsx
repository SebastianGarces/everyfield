import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Mark } from "@/components/Logo";
import { Avatar, CardIcon, type Tone } from "@/components/kit/kit";
import { ICONS } from "../icons";

// The dashboard kit of the large product pictures (the Monday overview on home, the network dashboard in the /oversight
// hero): app frame, cards, key-value rows, deltas, list rows and the static InsightCard. Server only: no animation.

/** The app window: brand mark, the tabs with Overview on (or none), a slot on the right, the user's avatar, then the page head and body. */
export function AppFrame({
	tabs,
	title,
	sub,
	body,
	right,
	topRight,
	avatar = "DR",
	className,
}: {
	tabs?: boolean;
	title: ReactNode;
	sub: string;
	body: ReactNode;
	right?: ReactNode;
	topRight?: ReactNode;
	avatar?: string;
	className?: string;
}) {
	return (
		<div className={cn("ef-ui overflow-hidden rounded-frame border border-line bg-frame shadow-mk-app", className)}>
			<div className="flex items-center gap-3 px-4 py-3">
				<span className="grid size-10 flex-none place-items-center rounded-[12px] bg-green-500 text-ink">
					<Mark className="h-4 w-5" />
				</span>
				{tabs ? (
					<span className="flex gap-0.5 rounded-[13px] bg-surface-raised p-1 shadow-[0_0_0_1px_var(--color-line)]">
						{["Overview", "People", "Meetings", "Tasks"].map((x, i) => (
							<span
								key={x}
								className={cn(
									"rounded-sm px-[13px] py-[7px] text-[13px] font-medium whitespace-nowrap",
									i ? "text-text-2 max-mk-sm:hidden" : "bg-ink text-on-ink",
								)}
							>
								{x}
							</span>
						))}
					</span>
				) : null}
				<span className="flex-1" />
				{topRight}
				<Avatar tone="green">{avatar}</Avatar>
			</div>
			<div className="px-5 pt-2 pb-[22px] max-mk-sm:px-3 max-mk-sm:pt-1 max-mk-sm:pb-3.5">
				<div className="flex items-end justify-between gap-4 px-1 pt-1.5 pb-[18px]">
					<div>
						<div className="font-display text-[30px] leading-[1.05] font-medium tracking-[-0.035em] max-mk-sm:text-[24px]">
							{title}
						</div>
						<div className="mt-1.5 text-[13px] text-text-3">{sub}</div>
					</div>
					{right}
				</div>
				{body}
			</div>
		</div>
	);
}

/** A dashboard card. */
export function DashCard({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div
			className={cn(
				"relative flex min-w-0 flex-col rounded-[22px] border border-[color:var(--ef-card-edge)] bg-surface px-[22px] py-5 shadow-card",
				className,
			)}
		>
			{children}
		</div>
	);
}
/** Card header: title, optional description, optional control on the right. */
export function DashHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
	return (
		<div className="mb-3.5 flex items-start gap-3">
			<div className="min-w-0 flex-1">
				<div className="font-display text-[19px] leading-[1.2] font-medium tracking-[-0.02em]">{title}</div>
				{sub ? <div className="mt-[3px] text-[13px] text-text-3">{sub}</div> : null}
			</div>
			{right}
		</div>
	);
}
/** The card menu glyph (faint). */
export const More = () => <Icon icon={ICONS.more} className="text-text-3" />;

/** A key and its value on a ruled row; the first row of its group has no rule. */
export function Kv({ k, first, children }: { k: string; first?: boolean; children: ReactNode }) {
	return (
		<div className={cn("flex items-center justify-between gap-3 py-[11px]", !first && "border-t border-line")}>
			<span className="text-[13px] text-text-2">{k}</span>
			{children}
		</div>
	);
}
export const KV_V = "font-display text-[18px] font-medium tracking-[-0.02em] whitespace-nowrap";

/** A change against the prior period: white pill with an up (green) or down (magenta) triangle. */
export function Delta({ dir, children }: { dir: "up" | "down"; children: ReactNode }) {
	return (
		<span
			className={cn(
				"inline-flex h-[26px] items-center gap-1.5 rounded-full bg-surface-raised px-2.5 text-[12.5px] font-semibold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--color-line)]",
				"before:border-x-[5px] before:border-x-transparent before:content-['']",
				dir === "up"
					? "before:border-b-[7px] before:border-b-green-500"
					: "before:border-t-[7px] before:border-t-magenta-500",
			)}
		>
			{children}
		</span>
	);
}

/** A list row: tinted icon, title and line under it, optional end. first: no rule above (first child of its list). */
export function ListRow({
	tone,
	icon,
	title,
	sub,
	first,
	end,
}: {
	tone: Tone;
	icon: IconSvgElement;
	title: string;
	sub: string;
	first?: boolean;
	end?: ReactNode;
}) {
	return (
		<div className={cn("flex items-center gap-3 py-3", !first && "border-t border-line")}>
			<CardIcon tone={tone} icon={icon} />
			<div className="min-w-0 flex-1">
				<div className="text-[14px] font-semibold">{title}</div>
				<div className="mt-0.5 text-[12.5px] text-text-3">{sub}</div>
			</div>
			{end}
		</div>
	);
}
