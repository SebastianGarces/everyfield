"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useId, useRef, useState } from "react";
import {
	idle,
	laneAnswer,
	laneCheck,
	laneDismiss,
	laneStart,
	sendTwice,
	settledOf,
	waitOf,
	WAIT_HINT,
	type Lane,
	type Wait,
} from "./lane.ts";
import { problemText, type Outcome } from "./model.ts";

type Answer<T> = Exclude<Outcome<T>, { status: "lost" }>;
type Pending = { what: string; run: () => Promise<Outcome<unknown>>; done: (r: Answer<unknown>) => void };

/**
 * One card's or dialog's save lane (lane.ts). `save` starts a save with its own new request key and returns false when
 * the lane is busy: the caller's Save is disabled then, so nothing is queued. `done` gets the server's answer, also
 * when it arrives later through Check again, so a closed form's result still lands on the card.
 */
export function useLane() {
	const ref = useRef<Lane>(idle);
	const pending = useRef<Pending | null>(null);
	const [lane, setLane] = useState<Lane>(idle);
	const apply = (next: Lane) => {
		ref.current = next;
		setLane(next);
	};
	async function save<T>(
		what: string,
		send: (requestKey: string) => Promise<Outcome<T>>,
		done: (r: Answer<T>) => void,
	): Promise<boolean> {
		const started = laneStart(ref.current, what);
		if (!started) return false;
		apply(started);
		const key = crypto.randomUUID();
		const run = () => send(key);
		const r = await sendTwice(run);
		apply(laneAnswer(ref.current, what, r));
		if (r.status === "lost") {
			pending.current = { what, run, done: done as Pending["done"] };
			return true;
		}
		done(r);
		return true;
	}
	/** Check again: the same request with the same key, once. */
	async function check() {
		const p = pending.current;
		const checking = laneCheck(ref.current);
		if (!p || !checking) return;
		apply(checking);
		const r = await p.run().then(settledOf, (): Outcome<unknown> => ({ status: "lost" }));
		apply(laneAnswer(ref.current, p.what, r));
		if (r.status === "lost") return;
		pending.current = null;
		p.done(r);
	}
	return { lane, wait: waitOf(lane), save, check, dismiss: () => apply(laneDismiss(ref.current)) };
}
export type LaneControl = ReturnType<typeof useLane>;

/**
 * The lane's notice: a save that may already be saved (with Check again, never Dismiss), or the server's refusal of the
 * last save. It is a live region, so it is announced without moving focus. A dialog renders its own copy inside it,
 * because an open modal hides the rest of the page from screen readers (C58 rule 7).
 */
export function LaneNotice({ control, className }: { control: LaneControl; className?: string }) {
	const { lane } = control;
	const text = lane.unknown
		? `${lane.unknown.what} may already be saved. We did not hear back from the server. Check again to find out; it will not be saved twice.`
		: lane.refused
			? `${lane.refused.what} was not saved. ${problemText(lane.refused.code)}`
			: null;
	return (
		<div aria-live="assertive" aria-atomic="true" className={className}>
			{text ? (
				<div className="flex flex-col items-start gap-2.5 rounded-md bg-magenta-50 px-3.5 py-3 text-sm text-magenta-600">
					<p className="flex items-start gap-2">
						<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
						<span>{text}</span>
					</p>
					{lane.unknown ? (
						<Button size="sm" variant="secondary" loading={lane.unknown.checking} onClick={control.check}>
							Check again
						</Button>
					) : (
						<Button size="sm" variant="ghost" onClick={control.dismiss}>
							Dismiss
						</Button>
					)}
				</div>
			) : null}
		</div>
	);
}

/** A form's Save while its lane waits: disabled, with the reason next to it. Never a refusal. */
export function SaveButton({
	wait,
	saving,
	blocked = null,
	children,
	variant = "primary",
	className,
}: {
	wait: Wait;
	saving: boolean;
	/** A local reason the form cannot be sent yet ("Choose at least one"). Shown as a hint, never as a refusal. */
	blocked?: string | null;
	children: string;
	variant?: "primary" | "danger";
	className?: string;
}) {
	const hint = useId();
	const why = saving ? null : wait ? WAIT_HINT[wait] : blocked;
	return (
		<>
			{why ? (
				<p id={hint} className="mr-auto text-xs text-text-2 max-app-sm:basis-full">
					{why}
				</p>
			) : null}
			<Button
				type="submit"
				variant={variant}
				loading={saving}
				disabled={wait !== null || blocked !== null}
				aria-describedby={why ? hint : undefined}
				className={className}
			>
				{children}
			</Button>
		</>
	);
}
