"use client";

import {
	Alert02Icon,
	Calendar03Icon,
	PresentationBarChart01Icon,
	UserGroupIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { CardIcon } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, type ReactNode } from "react";
import { PersonLink } from "../people/parts.tsx";
import { STATUS_LABEL, STATUS_TONE, TYPE_TONE, type MeetingStatus, type MeetingType } from "./model.ts";

/** A link that prefetches on intent (pointer, touch, keyboard focus), never because it scrolled into view. */
export { PersonLink as IntentLink };

const TYPE_ICON = {
	vision_meeting: Calendar03Icon,
	orientation: UserMultipleIcon,
	team_meeting: UserGroupIcon,
	prelaunch_practice: PresentationBarChart01Icon,
} as const;

export function MeetingIcon({ type, size = 36 }: { type: MeetingType; size?: 36 | 44 }) {
	return <CardIcon icon={TYPE_ICON[type]} tone={TYPE_TONE[type]} size={size} />;
}

export function MeetingStatusBadge({
	status,
	size,
	className,
}: {
	status: MeetingStatus;
	size?: "sm" | "md";
	className?: string;
}) {
	return (
		<StatusBadge status={STATUS_TONE[status]} size={size} className={className}>
			{STATUS_LABEL[status]}
		</StatusBadge>
	);
}

/**
 * The yes count against the rest of the guest list as one bar. The counts are written beside it, so the bar is
 * decoration and never the only carrier of the numbers.
 */
export function RsvpBar({ yes, other, className }: { yes: number; other: number; className?: string }) {
	return (
		<span aria-hidden="true" className={cn("flex h-1.5 w-full max-w-[160px] gap-[3px] overflow-hidden rounded-pill", className)}>
			{yes + other === 0 ? <span className="flex-1 bg-surface-3" /> : null}
			{yes ? <span className="bg-green-500" style={{ flex: yes }} /> : null}
			{other ? <span className="bg-surface-3" style={{ flex: other }} /> : null}
		</span>
	);
}

/**
 * Why the last save of a form was refused, in words (the save lane's `problem`). A live region, so a screen reader hears
 * it when it appears. Forms in a RecordDialog get this from the dialog.
 */
export function Problem({ text, className }: { text: string | undefined; className?: string }) {
	return (
		<div aria-live="assertive" className={cn("empty:hidden", className)}>
			{text ? (
				<p className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
					<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
					{text}
				</p>
			) : null}
		</div>
	);
}

const FIRST_CONTROL = "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])";

/**
 * The panels of a tabbed dialog, drawn in one grid cell so the dialog is as tall as its tallest panel on every tab.
 * Switching tabs then changes neither the dialog height nor the tab control's position. The panels that are not shown
 * keep their state, stay invisible and take no focus or screen-reader reading (inert). A tab change moves focus to the
 * first control of the shown panel; opening the dialog leaves focus to the dialog.
 */
export function TabStack({
	active,
	panels,
	className,
}: {
	active: string;
	panels: Record<string, ReactNode>;
	className?: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	const first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		root.current?.querySelector<HTMLElement>(`[data-panel="${active}"] :is(${FIRST_CONTROL})`)?.focus();
	}, [active]);
	return (
		<div ref={root} className="grid">
			{Object.entries(panels).map(([key, node]) => (
				<div
					key={key}
					data-panel={key}
					inert={key !== active}
					className={cn("col-start-1 row-start-1 flex min-w-0 flex-col", className, key !== active && "invisible")}
				>
					{node}
				</div>
			))}
		</div>
	);
}
