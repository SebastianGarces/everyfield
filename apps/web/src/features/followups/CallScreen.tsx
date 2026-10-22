"use client";

import { Call02Icon, CheckmarkCircle02Icon, Mail01Icon, Message01Icon } from "@hugeicons/core-free-icons";
import {
	Breadcrumb,
	buttonVariants,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	IntentLink,
} from "@everyfield/ui/controls";
import { Avatar, StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useRef, useState, useSyncExternalStore } from "react";
import { dueText } from "../tasks/model.ts";
import { recordOutcome } from "./actions.ts";
import { loadCall } from "./fetch.ts";
import { focusFirstProblem, OutcomeFields } from "./fields.tsx";
import {
	emptyDraft,
	OUTCOME_LABEL,
	OUTCOMES,
	outcomeInput,
	windowAt,
	type Draft,
	type DraftErrors,
	type OutcomeMutation,
} from "./model.ts";
import { EntryFacts, LastContact, OutcomeBadge } from "./parts.tsx";
import { LaneNotice, SaveButton, useLane } from "./save.tsx";
import type { CallData } from "./server.ts";

const OPEN = new Set(["not_started", "in_progress", "blocked"]);

/**
 * The follow-up call (REQ-MTG-022, REQ-MTG-021, REQ-TSK-004): who to reach and how, then what happened. Built for a
 * phone first; on a desktop it sits in the app frame. One save at a time. A saved outcome shows from the answer; the
 * follow-up stays here to record another try when it is still open.
 */
export function CallScreen({ initial, accountId, admin }: { initial: CallData; accountId: string; admin: boolean }) {
	const [call, setCall] = useState(initial);
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [errors, setErrors] = useState<DraftErrors>({});
	const [sent, setSent] = useState(false);
	const [saved, setSaved] = useState<OutcomeMutation | null>(null);
	const lane = useLane();
	const notice = useRef<HTMLDivElement>(null);
	const done = useRef<HTMLHeadingElement>(null);
	const { task, person, obligation } = call;
	const open = OPEN.has(task.status);
	const mine = task.assignee?.accountId === accountId;
	const canAct = (admin || mine) && person.live;
	// After a refusal or an unknown result the form stays, with the person's answers and the notice, even when a reload
	// shows the follow-up was finished in the meantime (C58 rules 5 and 6).
	const held = lane.lane.refused !== null || lane.lane.unknown !== null;
	const now = useNow();
	const left48 =
		now !== null && obligation?.kind === "first_vision_follow_up" && open ? windowAt(obligation.origin.at, now) : null;
	const due = dueText(task.due);

	async function submit(form: HTMLFormElement) {
		const parsed =
			!open && draft.outcome === "no_longer_needed"
				? ({ ok: false, errors: { outcome: "This follow-up is already finished. Choose what happened." } } as const)
				: outcomeInput(draft, { completable: open });
		if (!parsed.ok) {
			setErrors(parsed.errors);
			focusFirstProblem(form);
			return;
		}
		setErrors({});
		setSent(true);
		const input = { target: { kind: "task", taskId: task.id, expectedRevision: task.revision }, ...parsed.input };
		await lane.save(
			"The outcome",
			(key) => recordOutcome(key, input),
			async (r) => {
				setSent(false);
				if (r.status === "ok") {
					setSaved(r.value);
					setDraft(emptyDraft());
					setCall((c) => ({
						...c,
						task: r.value.task ?? c.task,
						recent: c.recent
							? {
									...c.recent,
									lastConfirmedContactAt: r.value.lastConfirmedContactAt,
									items: [r.value.record, ...c.recent.items].slice(0, 3),
								}
							: c.recent,
					}));
					requestAnimationFrame(() => done.current?.focus());
					return;
				}
				// The answers stay. Out of date: read the follow-up again so the next save uses its latest revision.
				if (r.code === "conflict") {
					const fresh = await loadCall(task.id);
					if (fresh.status === "ok" && fresh.value.kind === "call") setCall(fresh.value.call);
				}
				requestAnimationFrame(() => notice.current?.focus());
			},
		);
		setSent(false);
	}

	return (
		<div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
			<Breadcrumb items={[{ label: "Tasks", href: "/tasks" }, { label: "Follow-up" }]} />
			<Card className="gap-4">
				<div className="flex items-start gap-4">
					<Avatar name={person.label} size="lg" decorative />
					<div className="min-w-0 flex-1">
						<h1 className="text-title-lg leading-tight tracking-[-0.02em] text-ink text-balance">
							<IntentLink href={`/people/${person.id}`} className="underline-offset-[3px] hover:underline">
								{person.label}
							</IntentLink>
						</h1>
						<p className="mt-1 text-sm text-text-2">{task.title}</p>
						<div className="mt-2 flex flex-wrap items-center gap-1.5">
							{left48?.open ? (
								<StatusBadge status={left48.hoursLeft < 24 ? "risk" : "attention"} size="sm">
									{left48.hoursLeft < 1 ? "Under 1 h left of 48 h" : `${left48.hoursLeft} h left of 48 h`}
								</StatusBadge>
							) : null}
							{open && due ? (
								<StatusBadge status={task.overdue ? "risk" : "measured"} size="sm">
									{task.overdue ? `Overdue · due ${due}` : `Due ${due}`}
								</StatusBadge>
							) : null}
							{task.assignee ? (
								<StatusBadge status="measured" size="sm" plain>
									{mine ? "Assigned to you" : `Assigned to ${task.assignee.displayName}`}
								</StatusBadge>
							) : (
								<StatusBadge status="attention" size="sm">
									Needs owner
								</StatusBadge>
							)}
						</div>
					</div>
				</div>
				{person.phone || person.email ? (
					<div className="grid grid-cols-2 gap-2 max-app-sm:grid-cols-2">
						{person.phone ? (
							<>
								<a href={`tel:${person.phone}`} className={cn(buttonVariants({ variant: "primary" }), "w-full")}>
									<Icon icon={Call02Icon} size={18} />
									Call
								</a>
								<a href={`sms:${person.phone}`} className={cn(buttonVariants({ variant: "secondary" }), "w-full")}>
									<Icon icon={Message01Icon} size={18} />
									Text
								</a>
							</>
						) : null}
						{person.email ? (
							<a
								href={`mailto:${person.email}`}
								className={cn(buttonVariants({ variant: "secondary" }), "w-full", person.phone && "col-span-2")}
							>
								<Icon icon={Mail01Icon} size={18} />
								Email
							</a>
						) : null}
					</div>
				) : (
					<p className="text-sm text-text-3">No phone or email on file.</p>
				)}
				<p className="text-sm text-text-2">
					<LastContact at={call.recent?.lastConfirmedContactAt ?? null} />
				</p>
			</Card>

			{saved ? (
				<Card as="section" className="gap-3" aria-labelledby="followup-saved">
					<h2
						id="followup-saved"
						ref={done}
						tabIndex={-1}
						className="flex items-center gap-2 text-title-sm text-ink outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)]"
					>
						<Icon icon={CheckmarkCircle02Icon} size={20} className="text-green-600" />
						Saved: {OUTCOME_LABEL[saved.record.outcome]}
					</h2>
					<p className="text-sm text-text-2">
						{saved.task && !OPEN.has(saved.task.status)
							? saved.task.status === "no_longer_needed"
								? "The follow-up is closed as no longer needed. It earns no contact credit."
								: "The follow-up is done."
							: "The follow-up stays open on the list."}
						{saved.record.outcome === "contacted" ? " The contact counts toward their last contact date." : null}
					</p>
					<div className="flex flex-wrap gap-2">
						<IntentLink href="/tasks" className={buttonVariants({ variant: "secondary", size: "sm" })}>
							Back to tasks
						</IntentLink>
						<IntentLink href={`/people/${person.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
							Open {person.label}
						</IntentLink>
					</div>
				</Card>
			) : null}

			{canAct && (open || held) ? (
				<Card className="gap-4">
					<CardHeader>
						<CardHeading>
							<CardTitle size="sm">{saved ? "Record another try" : "How did it go?"}</CardTitle>
						</CardHeading>
					</CardHeader>
					{open ? null : (
						<p className="text-sm text-text-2">
							This follow-up was finished in the meantime. Your answers are kept: save them as an extra entry, or leave
							this page.
						</p>
					)}
					<form
						noValidate
						className="flex flex-col gap-5"
						onSubmit={(e) => {
							e.preventDefault();
							if (lane.wait) return;
							void submit(e.currentTarget);
						}}
					>
						<OutcomeFields
							draft={draft}
							onDraft={setDraft}
							errors={errors}
							completable={open}
							outcomes={open ? OUTCOMES : OUTCOMES.filter((o) => o !== "no_longer_needed")}
							personName={person.label.split(" ")[0] || person.label}
						/>
						<div ref={notice} tabIndex={-1} className="outline-none">
							<LaneNotice control={lane} />
						</div>
						<div className="flex flex-wrap items-center justify-end gap-3">
							<SaveButton wait={lane.wait} saving={sent} className="max-app-sm:w-full">
								Save
							</SaveButton>
						</div>
					</form>
				</Card>
			) : !saved ? (
				<Card>
					<p className="text-sm text-text-2">
						{!person.live
							? `${person.label} is no longer active. Their history stays, and new outcomes cannot be recorded.`
							: !open
								? task.status === "no_longer_needed"
									? "This follow-up is closed as no longer needed."
									: "This follow-up is done."
								: "Only the follow-up's owner, an Owner or an Admin can record what happened."}
					</p>
				</Card>
			) : null}

			{call.recent && call.recent.items.length ? (
				<Card className="gap-1">
					<CardHeader className="mb-1">
						<CardHeading>
							<CardTitle size="sm">Recent</CardTitle>
						</CardHeading>
						<IntentLink
							href={`/people/${person.id}#contact-log`}
							className="text-sm font-medium text-ink underline-offset-[3px] hover:underline"
						>
							Contact log
						</IntentLink>
					</CardHeader>
					<ul className="flex flex-col">
						{call.recent.items.map((item) => (
							<li key={item.id} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0">
								<OutcomeBadge item={item} />
								<EntryFacts item={item} />
							</li>
						))}
					</ul>
				</Card>
			) : null}
		</div>
	);
}

/** The time now in the browser, once a minute; null on the server and the first render, so hydration matches. */
const minute = (tick: () => void) => {
	const t = setInterval(tick, 60_000);
	return () => clearInterval(t);
};
const nowMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
function useNow(): number | null {
	return useSyncExternalStore(minute, nowMinute, () => null);
}
