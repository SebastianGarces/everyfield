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
import { useRef, useState } from "react";
import { PersonLink } from "../people/parts.tsx";
import {
	problemText,
	STATUS_LABEL,
	STATUS_TONE,
	TYPE_TONE,
	type MeetingStatus,
	type MeetingType,
	type Outcome,
} from "./model.ts";

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
 * Yes, No and Pending as one bar; `other` is a neutral rest when only the yes count is known. Each segment's width is
 * its share. The counts are written beside it, so the bar is decoration and never the only carrier of the numbers.
 */
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

/** The error line under a form or card. A live region: a screen reader hears the problem when it appears. */
export function Problem({ code, className }: { code: string | null | undefined; className?: string }) {
	return (
		<div aria-live="assertive" className={cn("empty:hidden", className)}>
			{code ? (
				<p className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
					<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
					{problemText(code)}
				</p>
			) : null}
		</div>
	);
}

export const problemOf = (o: Outcome<unknown>): string | null =>
	o.status === "ok" ? null : o.status === "lost" ? "lost" : o.code;

/**
 * One form's save. A request key belongs to one exact payload: a retry after a lost answer sends the same key, so the
 * producer replays a write that did commit; a changed payload gets a new key. `pending` blocks a double submit.
 */
export function useSave() {
	const last = useRef<{ key: string; body: string } | null>(null);
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	async function save<T>(payload: unknown, call: (key: string) => Promise<Outcome<T>>): Promise<Outcome<T> | null> {
		if (pending) return null;
		const body = JSON.stringify(payload);
		if (!last.current || last.current.body !== body) last.current = { key: crypto.randomUUID(), body };
		setPending(true);
		setProblem(null);
		const result: Outcome<T> = await call(last.current.key).catch(() => ({ status: "lost" }) as const);
		setPending(false);
		if (result.status !== "lost") last.current = null;
		setProblem(problemOf(result));
		return result;
	}
	return { save, pending, problem, setProblem };
}
