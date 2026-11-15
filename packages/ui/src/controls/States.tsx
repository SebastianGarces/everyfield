import { LockKeyIcon, WifiDisconnected01Icon } from "@hugeicons/core-free-icons";
import type { ComponentPropsWithRef, CSSProperties, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";

export function EmptyState({
	icon,
	title,
	children,
	action,
	headingLevel = "h3",
	className,
}: {
	icon: IconSvgElement;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
	headingLevel?: "h2" | "h3" | "h4";
	className?: string;
}) {
	const Heading = headingLevel;
	return (
		<div className={cn("flex flex-col items-center gap-2.5 px-6 py-10 text-center", className)}>
			<div
				aria-hidden="true"
				className="relative mb-1.5 grid size-[72px] place-items-center rounded-card bg-surface-2 after:absolute after:-inset-2 after:rounded-card after:border-[1.5px] after:border-dashed after:border-line-2"
			>
				<Icon icon={icon} size={24} className="scale-125 text-text-2" />
			</div>
			<Heading className="font-title tracking-[-0.02em] text-title-sm leading-[1.2] text-ink">{title}</Heading>
			{children ? <p className="max-w-[320px] text-text-2 text-pretty">{children}</p> : null}
			{action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
		</div>
	);
}

export type StateTone = "neutral" | "error" | "lock";

const ART: Record<StateTone, string> = {
	neutral: "bg-surface-2 text-text-2",
	error: "bg-magenta-100 text-magenta-600",
	lock: "bg-violet-100 text-violet-600",
};
const DEFAULT_ICON: Partial<Record<StateTone, IconSvgElement>> = { error: WifiDisconnected01Icon, lock: LockKeyIcon };

type StatePanelProps = {
	tone?: StateTone;
	icon?: IconSvgElement;
	title: string;
	children: ReactNode;
	actions?: ReactNode;
	meta?: ReactNode;
	headingLevel?: "h1" | "h2" | "h3";
	className?: string;
};

export function StatePanel({
	tone = "neutral",
	icon,
	title,
	children,
	actions,
	meta,
	headingLevel = "h2",
	className,
}: StatePanelProps) {
	const Heading = headingLevel;
	const art = icon ?? DEFAULT_ICON[tone];
	return (
		<div
			role={tone === "error" ? "alert" : undefined}
			data-tone={tone}
			className={cn("flex flex-col items-center gap-2.5 px-6 py-16 text-center max-app-sm:py-10", className)}
		>
			{art ? (
				<div aria-hidden="true" className={cn("mb-1.5 grid size-16 place-items-center rounded-card", ART[tone])}>
					<Icon icon={art} size={24} className="scale-[1.15]" />
				</div>
			) : null}
			<Heading className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink text-balance">
				{title}
			</Heading>
			<p className="max-w-[420px] text-text-2 text-pretty">{children}</p>
			{actions ? <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div> : null}
			{meta ? <p className="mt-1.5 text-xs text-text-3">{meta}</p> : null}
		</div>
	);
}

export function Skeleton({
	shape = "line",
	width,
	height,
	className,
	style,
	...props
}: ComponentPropsWithRef<"div"> & {
	shape?: "line" | "block" | "circle";
	width?: CSSProperties["width"];
	height?: CSSProperties["height"];
}) {
	return (
		<div
			aria-hidden="true"
			style={{ width, height: height ?? (shape === "line" ? 14 : undefined), ...style }}
			className={cn("ef-skel", shape === "circle" ? "rounded-full" : "rounded-md", className)}
			{...props}
		/>
	);
}
