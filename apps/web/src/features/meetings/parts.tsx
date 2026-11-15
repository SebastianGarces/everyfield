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
import { cn, Icon, useFocusRequest } from "@everyfield/ui/foundations";
import { useState, type ReactNode } from "react";
import { PersonLink } from "../people/parts.tsx";
import { statusView, TYPE_TONE, type MeetingStatus, type MeetingType } from "./model.ts";

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
	meeting,
	now,
	size,
	className,
}: {
	meeting: { status: MeetingStatus; startsAt: string };
	now: string;
	size?: "sm" | "md";
	className?: string;
}) {
	const { label, tone } = statusView(meeting.status, meeting.startsAt, now);
	return (
		<StatusBadge status={tone} size={size} className={className}>
			{label}
		</StatusBadge>
	);
}

export function RsvpBar({
	yes,
	no = 0,
	pending = 0,
	other = 0,
	size = "sm",
	className,
}: {
	yes: number;
	no?: number;
	pending?: number;
	other?: number;
	size?: "sm" | "lg";
	className?: string;
}) {
	const total = yes + no + pending + other;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex w-full gap-[3px] overflow-hidden rounded-pill",
				size === "lg" ? "h-3.5" : "h-1.5 max-w-[160px]",
				className,
			)}
		>
			{total === 0 ? <span className="flex-1 bg-surface-3" /> : null}
			{yes ? <span className="bg-green-500" style={{ flex: yes }} /> : null}
			{no ? <span className="bg-magenta-500" style={{ flex: no }} /> : null}
			{pending ? <span className="bg-amber-500" style={{ flex: pending }} /> : null}
			{other ? <span className="bg-surface-3" style={{ flex: other }} /> : null}
		</span>
	);
}

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

export function TabStack({
	active,
	panels,
	className,
	fit,
}: {
	active: string;
	panels: Record<string, ReactNode>;
	className?: string;
	fit?: boolean;
}) {
	const [shown, setShown] = useState({ active, switches: 0 });
	if (shown.active !== active) setShown({ active, switches: shown.switches + 1 });
	const focusShownPanel = useFocusRequest<HTMLDivElement>(shown.switches, (root) =>
		root.querySelector<HTMLElement>(`[data-panel="${active}"] :is(${FIRST_CONTROL})`),
	);
	return (
		<div ref={focusShownPanel} className="grid">
			{Object.entries(panels).map(([key, node]) => (
				<div
					key={key}
					data-panel={key}
					inert={key !== active}
					className={cn(
						"col-start-1 row-start-1 flex min-w-0 flex-col",
						className,
						key !== active && (fit ? "hidden" : "invisible"),
					)}
				>
					{node}
				</div>
			))}
		</div>
	);
}
