"use client";

import { Alert02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import type { ComponentPropsWithRef, ReactNode, Ref } from "react";
import { cn, Icon, useFocusRequest, type FocusRequest } from "../foundations";

export type AlertTone = "error" | "neutral";
export type AlertLive = "assertive" | "polite";

const TONE: Record<AlertTone, { box: string; title: string; icon: typeof Alert02Icon }> = {
	error: { box: "bg-magenta-50 text-magenta-600", title: "text-magenta-600", icon: Alert02Icon },
	neutral: { box: "bg-surface-2 text-text-2", title: "text-ink", icon: InformationCircleIcon },
};

export type AlertProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
	tone?: AlertTone;
	title?: ReactNode;
	actions?: ReactNode;
	focus?: FocusRequest;
};

function useRefs<T>(a: Ref<T> | undefined, b: (node: T | null) => void): (node: T | null) => void {
	return (node) => {
		b(node);
		if (typeof a === "function") a(node);
		else if (a) a.current = node;
	};
}

export function Alert({
	tone = "error",
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
	const refs = useRefs(ref, focusRef);
	const look = TONE[tone];
	return (
		<div
			ref={refs}
			tabIndex={tabIndex ?? (focus === undefined ? undefined : -1)}
			data-tone={tone}
			className={cn(
				"flex items-start gap-2 rounded-md px-3.5 py-2.5 text-sm outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)]",
				look.box,
				className,
			)}
			{...props}
		>
			<Icon icon={look.icon} size={16} className="mt-px flex-none" />
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
}: Omit<AlertProps, "id"> & { live?: AlertLive; id?: string }) {
	return (
		<div id={id} aria-live={live} aria-atomic="true" className={cn("empty:hidden", className)}>
			{isEmpty(children) ? null : <Alert {...alert}>{children}</Alert>}
		</div>
	);
}
