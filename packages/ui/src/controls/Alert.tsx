"use client";

import { Alert02Icon, CheckmarkCircle02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, Icon, useFocusRequest, type FocusRequest, type IconSvgElement } from "../foundations";

export type AlertTone = "error" | "warning" | "success" | "neutral";
export type AlertLive = "assertive" | "polite";

const TONE: Record<AlertTone, { box: string; title: string; icon: IconSvgElement }> = {
	error: { box: "bg-magenta-50 text-magenta-600", title: "text-magenta-600", icon: Alert02Icon },
	warning: { box: "bg-amber-50 text-amber-600", title: "text-amber-600", icon: Alert02Icon },
	success: { box: "bg-green-50 text-green-700", title: "text-green-700", icon: CheckmarkCircle02Icon },
	neutral: { box: "bg-surface-2 text-text-2", title: "text-ink", icon: InformationCircleIcon },
};

export type AlertProps = Omit<ComponentPropsWithRef<"div">, "title" | "ref"> & {
	tone?: AlertTone;
	icon?: IconSvgElement;
	title?: ReactNode;
	actions?: ReactNode;
} & ({ focus?: FocusRequest; ref?: never } | { ref?: ComponentPropsWithRef<"div">["ref"]; focus?: never });

export function Alert({
	tone = "error",
	icon,
	title,
	actions,
	focus,
	ref,
	tabIndex,
	className,
	children,
	...props
}: AlertProps) {
	const focusRef = useFocusRequest<HTMLDivElement>(focus);
	const look = TONE[tone];
	return (
		<div
			ref={ref ?? focusRef}
			tabIndex={tabIndex ?? (focus === undefined ? undefined : -1)}
			data-tone={tone}
			className={cn(
				"flex items-start gap-2 rounded-md px-3.5 py-2.5 text-sm outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)]",
				look.box,
				className,
			)}
			{...props}
		>
			<Icon icon={icon ?? look.icon} size={16} className="mt-px flex-none" />
			<div className="min-w-0 flex-1 text-pretty">
				{title ? <p className={cn("font-semibold", look.title)}>{title}</p> : null}
				{children}
				{actions ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	);
}

const isEmpty = (children: ReactNode) =>
	children === null || children === undefined || children === false || children === "";

export function InlineAlert({
	live = "assertive",
	id,
	className,
	children,
	...alert
}: AlertProps & { live?: AlertLive }) {
	return (
		<div id={id} aria-live={live} aria-atomic="true" className={cn("empty:sr-only", className)}>
			{isEmpty(children) ? null : <Alert {...alert}>{children}</Alert>}
		</div>
	);
}
