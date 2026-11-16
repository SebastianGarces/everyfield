import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { Icon } from "../Icon";

export const NUM = "tracking-[-0.02em] whitespace-nowrap";

export type Tone = "green" | "blue" | "magenta" | "amber" | "violet" | "teal" | "ink";
const TONE: Record<Tone, string> = {
	green: "bg-green-100 text-green-700",
	blue: "bg-blue-100 text-blue-600",
	magenta: "bg-magenta-100 text-magenta-600",
	amber: "bg-amber-100 text-amber-600",
	violet: "bg-violet-100 text-violet-600",
	teal: "bg-teal-100 text-teal-600",
	ink: "bg-surface-2 text-ink-2",
};

export function CardIcon({
	tone,
	icon,
	size = 38,
	glyph = 18,
	className,
}: {
	tone: Tone;
	icon: IconSvgElement;
	size?: number;
	glyph?: number;
	className?: string;
}) {
	return (
		<span
			className={cn("grid flex-none place-items-center rounded-full", TONE[tone], className)}
			style={{ width: size, height: size }}
		>
			<Icon icon={icon} size={glyph} />
		</span>
	);
}

export function StageChip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center gap-1.5 px-[9px] type-xs font-semibold whitespace-nowrap before:size-1.5 before:rounded-full before:bg-current before:content-['']",
				TONE[tone],
				className,
			)}
		>
			{children}
		</span>
	);
}

export type Status = "positive" | "measured" | "risk" | "attention" | "unknown";
const DOT: Record<Status, string> = {
	positive: "before:bg-green-500",
	measured: "before:bg-blue-500",
	risk: "before:bg-magenta-500",
	attention: "before:bg-amber-500",
	unknown: "before:bg-transparent before:shadow-[inset_0_0_0_1.5px_var(--color-text-3)]",
};
export function Badge({
	status,
	size = "md",
	children,
	className,
}: {
	status: Status;
	size?: "sm" | "md";
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 bg-white font-semibold whitespace-nowrap text-text shadow-mk-badge before:size-[7px] before:rounded-full before:content-['']",
				size === "sm" ? "h-[22px] px-2 type-xs" : "h-[26px] px-2.5 type-sm",
				DOT[status],
				className,
			)}
		>
			{children}
		</span>
	);
}

export function Av({ children, small, who }: { children: ReactNode; small?: boolean; who?: boolean }) {
	return (
		<span
			className={cn(
				"grid flex-none place-items-center rounded-full font-bold tracking-[.02em]",
				who
					? "size-5 bg-amber-100 type-mk-pic-2xs text-amber-600"
					: small
						? "size-5 bg-green-100 type-mk-pic-2xs text-green-700"
						: "size-[22px] bg-green-100 type-mk-pic-2xs text-green-700",
			)}
		>
			{children}
		</span>
	);
}

export function Avatar({ tone, small, children }: { tone: Tone; small?: boolean; children: ReactNode }) {
	return (
		<span
			className={cn(
				"grid flex-none place-items-center rounded-full font-semibold",
				small ? "size-8 type-xs" : "size-[34px] type-xs",
				TONE[tone],
			)}
		>
			{children}
		</span>
	);
}

export function UiButton({
	variant,
	size = "md",
	className,
	children,
}: {
	variant: "primary" | "ghost" | "light" | "glass";
	size?: "md" | "sm" | "action";
	className?: string;
	children: ReactNode;
}) {
	const V = {
		primary: "bg-ink text-on-ink shadow-pill",
		ghost: "bg-transparent text-ink",
		light: "bg-ink text-cream shadow-mk-btn-light",
		glass: "bg-[var(--pill-bg)] text-[var(--on)] shadow-[0_0_0_1px_var(--pill-edge)_inset]",
	};
	return (
		<span
			className={cn(
				"pointer-events-none inline-flex items-center justify-center gap-1.5 leading-none font-semibold whitespace-nowrap",
				size === "sm" ? "h-8 px-3 type-sm" : size === "action" ? "h-[34px] px-3.5 type-sm" : "h-9 px-3.5 type-sm",
				V[variant],
				className,
			)}
		>
			{children}
		</span>
	);
}

export function PlaybackGlyph({ paused }: { paused: boolean }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="block size-3.5 flex-none">
			{paused ? (
				<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
			) : (
				<>
					<rect x="6" y="5" width="4" height="14" rx="1.2" />
					<rect x="14" y="5" width="4" height="14" rx="1.2" />
				</>
			)}
		</svg>
	);
}
