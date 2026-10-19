import { LockKeyIcon, WifiDisconnected01Icon } from "@hugeicons/core-free-icons";
import type { ComponentPropsWithRef, CSSProperties, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";

/**
 * EmptyState (components.md): Art, Title, Text and Action for a list or card with nothing in it yet. Say what will
 * appear here and how to start; a failed load uses StatePanel tone="error" instead, never this.
 */
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
				className="relative mb-1.5 grid size-[72px] place-items-center rounded-[22px] bg-surface-2 after:absolute after:-inset-2 after:rounded-[28px] after:border-[1.5px] after:border-dashed after:border-line-2"
			>
				<Icon icon={icon} size={24} className="scale-125 text-text-2" />
			</div>
			<Heading className="font-display text-title-sm leading-[1.2] font-medium text-ink">{title}</Heading>
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
	/** error: a load failed (never shown as empty) · lock: no access · neutral: empty or first week. */
	tone?: StateTone;
	icon?: IconSvgElement;
	title: string;
	children: ReactNode;
	/** Try again, Report a problem, Ask for access and the like. */
	actions?: ReactNode;
	/** The reference line: "Last loaded today at 8:40 am · Error reference EF-7Q2K". */
	meta?: ReactNode;
	/** h1 when the panel is the whole page, as a refusal or a not-found page is. */
	headingLevel?: "h1" | "h2" | "h3";
	className?: string;
};

/**
 * StatePanel (components.md): the page-level state for error, no access and empty. An error panel is an alert, says
 * what failed, keeps the last known time in `meta` and offers Try again (foundations.md, Accessibility).
 */
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
				<div aria-hidden="true" className={cn("mb-1.5 grid size-16 place-items-center rounded-[20px]", ART[tone])}>
					<Icon icon={art} size={24} className="scale-[1.15]" />
				</div>
			) : null}
			<Heading className="font-display text-title-md leading-[1.2] font-medium tracking-[-0.02em] text-ink text-balance">
				{title}
			</Heading>
			<p className="max-w-[420px] text-text-2 text-pretty">{children}</p>
			{actions ? <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div> : null}
			{meta ? <p className="mt-1.5 text-xs text-text-3">{meta}</p> : null}
		</div>
	);
}

/**
 * Skeleton (components.md): a shimmering placeholder in the shape of the content to come. Placeholders are
 * decorative; wrap the loading region in an element with aria-busy and a visible or sr-only "Loading …" text.
 */
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
			className={cn(
				"ef-skel",
				shape === "circle" ? "rounded-full" : shape === "block" ? "rounded-md" : "rounded-[8px]",
				className,
			)}
			{...props}
		/>
	);
}
