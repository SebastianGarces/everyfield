import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { NUM } from "@/components/kit/kit";

// A still InsightCard (gradient surface) for the large product pictures. The animated panels use the same look through
// panels/parts.tsx with their stagger clock.

export function Insight({
	tone,
	icon,
	label,
	count,
	num,
	unit,
	unitMax = 180,
	title,
	text,
	footer,
	className,
}: {
	className?: string;
	tone: "g-dawn" | "g-lilac";
	icon: IconSvgElement;
	label: string;
	count: string;
	num: string;
	unit: string;
	unitMax?: number;
	title: string;
	text: string;
	footer: ReactNode;
}) {
	return (
		<div
			className={cn(
				"mk-gsurf relative flex flex-col rounded-[22px] px-6 py-[22px] text-[var(--on)] shadow-[0_18px_36px_-24px_var(--g-shadow)]",
				tone,
				className,
			)}
		>
			<div className="flex items-center justify-between gap-2.5">
				<span className="inline-flex h-[30px] items-center gap-[7px] rounded-full bg-[var(--pill-bg)] px-3 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--pill-edge)]">
					<Icon icon={icon} />
					{label}
				</span>
				<span className="text-[12.5px] text-[var(--on-3)]">{count}</span>
			</div>
			<div className="mt-5 flex items-end gap-3">
				<span className={cn(NUM, "text-[52px] leading-[.95]")}>{num}</span>
				<span className="pb-[3px] text-[13.5px] leading-[1.3] text-[var(--on-2)]" style={{ maxWidth: unitMax }}>
					{unit}
				</span>
			</div>
			<div className="mt-3.5 font-display text-[23px] leading-[1.18] font-medium tracking-[-0.02em]">{title}</div>
			<div className="mt-2.5 text-[14px] text-[var(--on-2)]">{text}</div>
			<div className="mt-auto flex flex-wrap gap-2 pt-5">{footer}</div>
		</div>
	);
}
