"use client";

import {
	Alert02Icon,
	Calendar03Icon,
	PresentationBarChart01Icon,
	UserGroupIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { Button, CardIcon } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useRef, useState, type ReactNode } from "react";
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
export function Problem({
	code,
	slot,
	onCheck,
	className,
}: {
	code: string | null | undefined;
	/** The form's save slot: while its answer is unknown, the notice with Check again shows instead. */
	slot?: Slot;
	onCheck?: () => void;
	className?: string;
}) {
	if ((slot === "unknown" || slot === "checking") && onCheck)
		return <Unconfirmed state={slot} onCheck={onCheck} className={className} />;
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

/** A save the form prepared; the caller decides when to run it and what the page shows meanwhile. */
export type SaveCall<T> = () => Promise<Outcome<T> | null>;

export const problemOf = (o: Outcome<unknown>): string | null =>
	o.status === "ok" ? null : o.status === "lost" ? "lost" : o.code;

/**
 * Sends one write with its request key. When no answer arrives, it sends the same key once more: the producer replays
 * a write that did commit, so the second answer is the true one. "lost" after that means nobody knows yet.
 * `undefined` is a redirect on its way (the action answered with a new page).
 */
export async function sendOnce<T>(
	key: string,
	call: (key: string) => Promise<Outcome<T>>,
): Promise<Outcome<T> | undefined> {
	const attempt = () => call(key).catch(() => ({ status: "lost" }) as const);
	const first = await attempt();
	return first?.status === "lost" ? attempt() : first;
}

/**
 * One form's save (C58, C68). Each submit is a new save intent with its own request key, also when the values are the
 * same as before. A lost answer is sent once more with that key; when that answer is lost too, the form stays held
 * ("unknown") with Check again, which resends the same key. The returned promise settles only with a server answer, so
 * a form never says "not saved" without one. `pending` is true while held, which blocks a second submit.
 */
export function useSave() {
	const slot = useSlot();
	const [problem, setProblem] = useState<string | null>(null);
	function save<T>(_payload: unknown, call: (key: string) => Promise<Outcome<T>>): Promise<Outcome<T> | null> {
		return new Promise((resolve) => {
			const started = slot.run(call, (r) => {
				setProblem(problemOf(r));
				resolve(r);
			});
			if (!started) return resolve(null);
			setProblem(null);
		});
	}
	return {
		save,
		pending: slot.state !== "idle",
		problem,
		setProblem,
		/** Props for <Problem>: the refusal, or the Check again notice while the answer is unknown. */
		problemProps: { code: problem, slot: slot.state, onCheck: slot.checkAgain },
	};
}

/**
 * A save slot's state (C68): free, a save on its way, a save whose answer never came, or that save sent again by
 * Check again. Every state but idle refuses a new save.
 */
export type Slot = "idle" | "pending" | "unknown" | "checking";
type Answer<T> = Exclude<Outcome<T>, { status: "lost" }>;

/**
 * One save at a time for one card, dialog or row (C68). A save keeps its request key. When no answer arrives, sendOnce
 * sends it once more; when that answer is lost too, the slot stays "unknown" and refuses new saves. Check again sends
 * the same request key again: the server returns what it recorded, or saves it now if it never arrived. Only that
 * answer frees the slot, so the page never claims a result it has not heard.
 */
export function useSlot() {
	const [state, setState] = useState<Slot>("idle");
	const held = useRef<(() => Promise<void>) | null>(null);
	/** Starts a save, or returns false when the slot is busy or unknown. `answered` gets only a server answer. */
	function run<T>(call: (key: string) => Promise<Outcome<T>>, answered: (r: Answer<T>) => void): boolean {
		if (held.current) return false;
		const key = crypto.randomUUID();
		const send = async (again: boolean) => {
			setState(again ? "checking" : "pending");
			const r = await sendOnce(key, call);
			if (r === undefined) return;
			if (r.status === "lost") return setState("unknown");
			held.current = null;
			setState("idle");
			answered(r);
		};
		held.current = () => send(true);
		void send(false);
		return true;
	}
	function checkAgain() {
		if (state === "unknown" && held.current) void held.current();
	}
	return { state, run, checkAgain };
}

/**
 * The notice for a save whose answer is unknown, with Check again. A polite live region, so a screen reader hears it
 * when it appears, also inside an open dialog.
 */
export function Unconfirmed({
	state,
	onCheck,
	children,
	className,
}: {
	state: Slot;
	onCheck: () => void;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div aria-live="polite" className={cn("empty:hidden", className)}>
			{state === "unknown" || state === "checking" ? (
				<div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-3.5 py-2.5 text-sm text-ink">
					<p className="min-w-0 flex-1 basis-[200px]">
						{children ?? "We did not hear back from the server, so we cannot tell whether it saved."} Nothing else here
						can change until it is checked.
					</p>
					<Button variant="secondary" size="sm" onClick={onCheck} loading={state === "checking"}>
						Check again
					</Button>
				</div>
			) : null}
		</div>
	);
}
