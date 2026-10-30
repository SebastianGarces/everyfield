"use client";

import { CheckListIcon, Clock01Icon, Edit02Icon, StarIcon } from "@hugeicons/core-free-icons";
import { averageOf } from "@everyfield/contracts/meetings";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardInset,
	CardTitle,
	Checkbox,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	IntentLink,
	SegmentedControl,
	Select,
	Skeleton,
	Spinner,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { DeltaChip, StatusBadge } from "@everyfield/ui/display";
import { useEffect, useRef, useState } from "react";
import { DialogNotice, SaveNotice, useRowLanes, type RowSave, type SaveIntent } from "../../components/save/parts.tsx";
import { loadMeetingFollowUps } from "../followups/fetch.ts";
import { preferredOwner } from "../followups/model.ts";
import { ownerText } from "../tasks/model.ts";
import { assigneeOptions } from "../tasks/fetch.ts";
import { evaluationHistory, previewSettlement, setPresence } from "./actions.ts";
import {
	CLASSIFICATION_LABEL,
	dateText,
	deltaText,
	FACTORS,
	peopleText,
	PRESENCE_LABEL,
	PRESENCE_TONE,
	problemText,
	scoreText,
	type Analytics,
	type Attendance,
	type Classification,
	type Detail,
	type Evaluation,
	type Finalization,
	type Guest,
	type Outcome,
	type Presence,
	type Scores,
} from "./model.ts";
import { Problem } from "./parts.tsx";

// Attendance, finalization and the Vision evaluation on the meeting page (WP-022). Every save shows its change at once.
// A form closes as it saves and opens again with what was entered when the server refuses. A lost answer is sent once
// more with the same request key; when that answer is lost too, the page reads what is saved instead of guessing.

type Who = { personId: string; displayName: string };
type PresenceAnswer = Extract<Awaited<ReturnType<typeof setPresence>>, { status: "ok" }>["value"];

/**
 * A trigger held by a save in flight or unknown (C68). It stays focusable, so focus can return to it when its dialog
 * closes, but it starts nothing; it looks like a disabled button.
 */
export const HELD = "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:active:translate-y-0";

/**
 * Presence saves, one save lane per person (components/save useRowLanes, C68): marking people at the door never waits
 * for anyone else's answer, and one person takes no other change while their save is on its way or unknown. The row
 * shows the new presence at once and keeps it until the server answers; a lost answer is sent once more with the same
 * key, then Check again sends it again. A refusal puts the row back and says why.
 */
export function usePresence({
	meetingId,
	onSaved,
	onStale,
}: {
	meetingId: string;
	onSaved: (answer: PresenceAnswer) => void;
	onStale: () => void;
}) {
	const toast = useToast();
	const lanes = useRowLanes(problemText);
	// The presence each person asked for last; shown while their save is on its way or unknown.
	const [asked] = useState(() => new Map<string, Presence>());
	function set(who: Who, presence: Presence) {
		if (lanes.stateOf(who.personId)) return;
		asked.set(who.personId, presence);
		void lanes.save(who.personId, {
			what: `Attendance of ${who.displayName}`,
			send: (key) => setPresence(key, meetingId, who.personId, presence),
			ok: onSaved,
			refused: (code) => {
				if (code === "conflict" || code === "status_transition") onStale();
				toast({ message: `${who.displayName}: the attendance was not saved. ${problemText(code)}`, tone: "error" });
			},
		});
	}
	return {
		set,
		lanes,
		/** The save state of one person, or undefined when they take changes. */
		stateOf: lanes.stateOf,
		/** Guests as the person sees them: a save on its way or unknown shows what was asked. */
		shown: <G extends { person: { personId: string | null }; presence: Presence }>(list: G[]) =>
			list.map((g) => {
				const id = g.person.personId;
				return id && lanes.stateOf(id) ? { ...g, presence: asked.get(id) ?? g.presence } : g;
			}),
		/** A presence save is on its way or unknown: the attended set is not settled, so finalizing waits. */
		busy: lanes.busy,
	};
}

const attendedOf = (a: Attendance | null) => a?.items.filter((x) => x.presence === "attended") ?? [];
const classified = (a: Attendance | null) => {
	const out: Record<Classification, number> = { first_time: 0, returning: 0, core_group: 0 };
	for (const x of attendedOf(a)) if (x.classification) out[x.classification]++;
	return out;
};

/**
 * Attendance (REQ-MTG-010, REQ-MTG-012, REQ-MTG-016): who came, and once final, how each person counts and the work
 * it created. Unknown stays unknown: before finalizing there is no classification and no growth.
 */
export function AttendanceCard({
	meeting: m,
	attendance,
	analytics,
	canWrite,
	lane,
	blocked,
	headerFinalize,
	onSettle,
	onPrefetch,
}: {
	/** The page header already offers Finalize attendance; the card leaves its own button out. */
	headerFinalize?: boolean;
	meeting: Detail;
	attendance: Attendance | null;
	analytics: Analytics | null;
	canWrite: boolean;
	/** The finalize and correction lane: while its save is on its way or unknown, nothing here starts another. */
	lane: SaveIntent<SettleEditing>;
	/** Presence saves are on their way or unknown; finalizing waits for them. */
	blocked: boolean;
	onSettle: (mode: "finalize" | "reconcile") => void;
	onPrefetch: () => void;
}) {
	if (!attendance)
		return (
			<Card as="section" aria-labelledby="attendance-title">
				<CardTitle id="attendance-title">Attendance</CardTitle>
				<CardDescription>Did not load. Reload the page in a moment.</CardDescription>
			</Card>
		);
	const attended = attendedOf(attendance).length;
	const excused = attendance.items.filter((x) => x.presence === "excused").length;
	const final = attendance.finalized;
	const counts = classified(attendance);
	// A meeting can be finalized at any time, unless it is cancelled or voided.
	const open = m.status !== "cancelled" && !m.occurrence.voidedAt;
	const vision = m.type === "vision_meeting";
	const intent = { onPointerEnter: onPrefetch, onFocus: onPrefetch, onTouchStart: onPrefetch };
	const settling = lane.saving;
	const held = lane.wait !== null || blocked;
	return (
		<Card as="section" aria-labelledby="attendance-title" aria-busy={settling || undefined}>
			<CardHeader className="mb-3.5">
				<CardHeading>
					<CardTitle id="attendance-title">Attendance</CardTitle>
					<CardDescription>
						{settling ? (
							<span className="inline-flex items-center gap-2">
								<Spinner size={12} /> Saving…
							</span>
						) : final ? (
							`Final since ${dateText(final.at.slice(0, 10))}`
						) : open ? (
							"Not final yet"
						) : m.status === "cancelled" ? (
							"This meeting was cancelled"
						) : (
							"This meeting was voided"
						)}
					</CardDescription>
				</CardHeading>
				{final ? (
					<StatusBadge status="positive" size="sm">
						Final
					</StatusBadge>
				) : null}
			</CardHeader>
			<p className="flex items-end gap-3">
				<span className="font-display text-[40px] leading-none tracking-[-0.02em] text-ink tabular-nums">
					{attended}
				</span>
				<span className="pb-1.5 text-text-2">attended</span>
				<Growth analytics={final ? analytics : null} />
			</p>
			<p className="mt-2 text-sm text-text-3">
				{excused ? `${excused} excused · ` : ""}
				{attendance.items.length - attended - excused} not marked
			</p>
			{final ? (
				<dl className="mt-4 grid grid-cols-3 gap-2">
					{(Object.keys(CLASSIFICATION_LABEL) as Classification[]).map((k) => (
						<CardInset key={k} className="flex flex-col gap-0.5 px-3 py-2.5">
							<dt className="text-xs text-text-3">{CLASSIFICATION_LABEL[k]}</dt>
							<dd className="font-semibold text-ink tabular-nums">{counts[k]}</dd>
						</CardInset>
					))}
				</dl>
			) : null}
			{final && vision && analytics ? <Work tasks={analytics.tasks} /> : null}
			<SaveNotice {...lane.noticeProps} dialogOpen={lane.editing !== null} className="mt-4" />
			{canWrite ? (
				<div className="mt-auto flex flex-wrap items-center gap-2.5 pt-4">
					{final ? (
						<Button
							variant="secondary"
							size="sm"
							icon={Edit02Icon}
							aria-disabled={held || undefined}
							className={HELD}
							onClick={() => !held && onSettle("reconcile")}
							{...intent}
						>
							Correct attendance
						</Button>
					) : open && !headerFinalize ? (
						<Button
							variant="secondary"
							size="sm"
							icon={CheckListIcon}
							aria-disabled={held || undefined}
							className={HELD}
							onClick={() => !held && onSettle("finalize")}
							{...intent}
						>
							Finalize attendance
						</Button>
					) : null}
				</div>
			) : null}
		</Card>
	);
}

/** Growth over the previous meeting of this type. Unavailable after a meeting nobody attended; unknown says nothing. */
function Growth({ analytics }: { analytics: Analytics | null }) {
	const g = analytics?.growth;
	if (!g || g.status === "unknown") return null;
	if (g.status === "unavailable")
		return (
			<span className="pb-1.5 text-sm text-text-3">
				{deltaPeople(g.difference)} on the last meeting, which had nobody
			</span>
		);
	if (g.difference === 0) return <span className="pb-1.5 text-sm text-text-3">Same as the last meeting</span>;
	return (
		<span className="inline-flex items-center gap-2 pb-1">
			<DeltaChip dir={g.difference > 0 ? "up" : "down"} size="sm">
				{Math.abs(Math.round(g.percent))}%
			</DeltaChip>
			<span className="text-sm text-text-3">{deltaPeople(g.difference)} on the last meeting</span>
		</span>
	);
}
const deltaPeople = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${peopleText(Math.abs(d))}`;

/** The work finalizing created: follow-up calls and the evaluation task, and what still needs an owner. */
function Work({ tasks }: { tasks: Analytics["tasks"] }) {
	const f = tasks.followUps;
	const e = tasks.evaluation;
	return (
		<div className="mt-4 flex flex-col gap-2 border-t border-line pt-3.5 text-sm">
			<p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
				<span className="text-text-2">Follow-up calls</span>
				<span className="text-ink tabular-nums">
					{f.total === 0
						? "None needed"
						: f.total === f.closed
							? `${f.closed} closed`
							: `${f.complete} of ${f.total - f.closed} done${f.closed ? ` · ${f.closed} closed` : ""}`}
				</span>
			</p>
			{f.needsOwner ? (
				<p className="flex items-center justify-between gap-3">
					<span className="text-text-2">Need an owner</span>
					<StatusBadge status="attention" size="sm">
						{f.needsOwner}
					</StatusBadge>
				</p>
			) : null}
			{e ? (
				<p className="flex items-center justify-between gap-3">
					<span className="text-text-2">Evaluation task</span>
					<span className="text-ink">{e.needsOwner ? "Needs owner" : e.status === "complete" ? "Done" : "Open"}</span>
				</p>
			) : null}
			<IntentLink href="/tasks" className="self-start font-medium text-ink underline underline-offset-4">
				Open Tasks
			</IntentLink>
		</div>
	);
}

// -------------------------------------------------------------------------------------------------------------
// Finalize and correct

type Seat = { accountId: string; displayName: string; role: string };
/** `items` are every seat (the evaluation owner's seated rule); `followUpItems` only those who may own a follow-up. */
type Seats = Outcome<{ items: Seat[]; followUpItems: Seat[] }>;
const NEEDS_OWNER = "none";

/**
 * The seats that can own generated work, read once per page when the person shows intent to finalize (pointer,
 * touch or keyboard focus on the button), so the dialog opens with its choices ready.
 */
export function useSeats() {
	const [seats, setSeats] = useState<Seats | null>(null);
	const asked = useRef(false);
	function load() {
		if (asked.current) return;
		asked.current = true;
		void Promise.all([assigneeOptions(), assigneeOptions("committed_follow_up")]).then(([all, owners]) => {
			if (all.status !== "ok" || owners.status !== "ok") asked.current = false;
			setSeats(
				all.status !== "ok"
					? all
					: owners.status !== "ok"
						? owners
						: { status: "ok", value: { items: all.value.items, followUpItems: owners.value.items } },
			);
		});
	}
	return { seats, load };
}

export type SettleInput = {
	attendeeIds: string[];
	followUpAssigneeId: string | null;
	evaluationAssigneeId: string | null;
	reason: string;
};
export type Settled = { result: Finalization; analytics: Analytics | null };
/** The open finalize or correction form, with what was chosen when a refusal opens it again. */
export type SettleEditing = { mode: "finalize" | "reconcile"; input: SettleInput | null; problem?: string };

/**
 * Finalize attendance (REQ-MTG-012, REQ-MTG-020) or correct it after it is final. The review names the exact people
 * and what finalizing creates; the result names what it created. A correction is reviewed by identity: who is added,
 * who is removed, and why.
 */
export function SettleDialog({
	open,
	mode,
	meeting,
	guests,
	attendance,
	seats,
	onSeats,
	initial,
	problem,
	onClose,
	onSubmit,
}: {
	open: boolean;
	mode: "finalize" | "reconcile";
	meeting: Detail;
	guests: Guest[];
	attendance: Attendance;
	seats: Seats | null;
	onSeats: () => void;
	initial: SettleInput | null;
	/** Why the last finalize or correction was refused, in words. */
	problem: string | undefined;
	onClose: () => void;
	onSubmit: (input: SettleInput) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			{open ? (
				<SettleForm
					mode={mode}
					meeting={meeting}
					guests={guests}
					attendance={attendance}
					seats={seats}
					onSeats={onSeats}
					initial={initial}
					problem={problem}
					onClose={onClose}
					onSubmit={onSubmit}
				/>
			) : null}
		</Dialog>
	);
}

function SettleForm({
	mode,
	meeting,
	guests,
	attendance,
	seats,
	onSeats,
	initial,
	problem,
	onClose,
	onSubmit,
}: Omit<Parameters<typeof SettleDialog>[0], "open">) {
	const current: string[] = attendedOf(attendance).map((a) => a.person.personId);
	const [ids, setIds] = useState<string[]>(initial?.attendeeIds ?? current);
	const [followUp, setFollowUpValue] = useState(initial?.followUpAssigneeId ?? NEEDS_OWNER);
	// Finalize starts at Needs owner: no one is picked for the person. Correct attendance starts at the owner the
	// meeting's follow-ups already have (D-b), unless the person already chose.
	const [chose, setChose] = useState(initial?.followUpAssigneeId !== undefined);
	const setFollowUp = (v: string) => {
		setChose(true);
		setFollowUpValue(v);
	};
	useEffect(() => {
		if (mode !== "reconcile" || chose) return;
		let live = true;
		void loadMeetingFollowUps(meeting.id).then((r) => {
			const current = r.status === "ok" ? preferredOwner(r.value.items) : null;
			if (live && current) setFollowUpValue(current);
		});
		return () => {
			live = false;
		};
	}, [mode, meeting.id, chose]);
	const [evaluation, setEvaluation] = useState(initial?.evaluationAssigneeId ?? NEEDS_OWNER);
	const [reason, setReason] = useState(initial?.reason ?? "");
	const listRef = useRef<HTMLFieldSetElement>(null);
	const reasonRef = useRef<HTMLTextAreaElement>(null);
	const [touched, setTouched] = useState(false);
	const vision = meeting.type === "vision_meeting";
	const reconcile = mode === "reconcile";
	const name = new Map<string, string>(attendance.items.map((a) => [a.person.personId, a.person.displayName]));
	for (const g of guests) name.set(g.person.personId, g.person.displayName);
	const added = ids.filter((id) => !current.includes(id));
	const removed = current.filter((id) => !ids.includes(id));
	const unchanged = reconcile && added.length === 0 && removed.length === 0;
	const reasonMissing = reconcile && reason.trim() === "";
	// Everyone who could count: the guest list, then anyone attended who is no longer on it.
	const choices = [
		...guests.filter((g) => g.person.state === "live" || current.includes(g.person.personId)).map((g) => g.person),
		...attendance.items.filter((a) => !guests.some((g) => g.id === a.guestId)).map((a) => a.person),
	];
	const optionsOf = (list: "items" | "followUpItems") => [
		{ value: NEEDS_OWNER, label: "Needs owner" },
		...(seats?.status === "ok" ? seats.value[list].map((s) => ({ value: s.accountId, label: s.displayName })) : []),
	];
	const followUpOptions = optionsOf("followUpItems");
	const evaluationOptions = optionsOf("items");
	// The exact effects of these choices, from the real command run and rolled back on the server (C73). A change of
	// people or owners asks again after a short pause; an answer for older choices is never shown.
	const choice = {
		meetingId: meeting.id,
		attendeeIds: [...ids].sort(),
		followUpAssigneeId: followUp === NEEDS_OWNER ? null : followUp,
		...(reconcile ? { reason: "Review" } : { evaluationAssigneeId: evaluation === NEEDS_OWNER ? null : evaluation }),
	};
	const choiceKey = JSON.stringify(choice);
	const [attempt, setAttempt] = useState(0);
	const [got, setGot] = useState<{ key: string; attempt: number; value: Outcome<Finalization> } | null>(null);
	const retryRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (unchanged) return;
		let live = true;
		const t = setTimeout(() => {
			previewSettlement(mode, attendance.attendanceRevision, JSON.parse(choiceKey))
				.catch(() => ({ status: "lost" }) as const)
				.then((value) => live && setGot({ key: choiceKey, attempt, value }));
		}, 250);
		return () => {
			live = false;
			clearTimeout(t);
		};
	}, [choiceKey, attempt, mode, attendance.attendanceRevision, unchanged]);
	const settled = got !== null && got.key === choiceKey && got.attempt === attempt;
	const effects: Outcome<Finalization> = settled ? got.value : { status: "lost" };
	const owner = (
		label: string,
		value: string,
		set: (v: string) => void,
		hint: string,
		options: { value: string; label: string }[],
	) => (
		<Field label={label} hint={hint}>
			{seats === null ? (
				<Skeleton className="h-10 rounded-md" />
			) : (
				<Select value={value} onValueChange={set} options={options} aria-label={label} />
			)}
		</Field>
	);
	return (
		<DialogContent size="md" onOpenAutoFocus={onSeats}>
			<form
				noValidate
				className="contents"
				onSubmit={(e) => {
					e.preventDefault();
					setTouched(true);
					// Focus goes to the first thing to fix (F5): who attended, then the reason.
					if (unchanged) return listRef.current?.querySelector<HTMLElement>('button[role="checkbox"]')?.focus();
					if (reasonMissing) return reasonRef.current?.focus();
					// Confirm only what the review shows: the exact effects of these choices (C73).
					if (!settled) return;
					if (effects.status !== "ok") return retryRef.current?.focus();
					onSubmit({
						attendeeIds: ids,
						followUpAssigneeId: followUp === NEEDS_OWNER ? null : followUp,
						evaluationAssigneeId: evaluation === NEEDS_OWNER ? null : evaluation,
						reason: reason.trim(),
					});
				}}
			>
				<DialogHeader
					icon={reconcile ? Edit02Icon : CheckListIcon}
					tone="green"
					title={reconcile ? "Correct attendance" : "Finalize attendance"}
					description={meeting.displayTitle}
				/>
				<DialogBody className="flex flex-col gap-5">
					<DialogNotice />
					{reconcile ? (
						<fieldset ref={listRef} className="flex flex-col">
							<legend className="mb-1 text-sm font-medium text-ink-2">Who attended</legend>
							<div className="max-h-[248px] overflow-y-auto rounded-md px-1">
								{choices.map((p) => (
									<Checkbox
										key={p.personId}
										label={p.displayName}
										description={
											added.includes(p.personId) ? "Added" : removed.includes(p.personId) ? "Removed" : undefined
										}
										checked={ids.includes(p.personId)}
										onCheckedChange={(on) =>
											setIds((all) => (on ? [...all, p.personId] : all.filter((x) => x !== p.personId)))
										}
										className="py-2"
									/>
								))}
							</div>
							{touched && unchanged ? (
								<p className="mt-1 text-xs font-medium text-magenta-600" role="alert">
									Add or remove at least one person, or close this.
								</p>
							) : null}
						</fieldset>
					) : (
						<section aria-labelledby="settle-who">
							<h3 id="settle-who" className="text-sm font-medium text-ink-2">
								{ids.length === 0 ? "Nobody is marked as attended" : `${peopleText(ids.length)} attended`}
							</h3>
							{ids.length ? (
								<p className="mt-1 text-md text-text-2">{ids.map((id) => name.get(id)).join(", ")}</p>
							) : (
								<p className="mt-1 text-md text-text-2">You can still finalize. Mark people first if anyone came.</p>
							)}
						</section>
					)}
					<section aria-labelledby="settle-effects" aria-live="polite" aria-busy={!settled || undefined}>
						<h3 id="settle-effects" className="text-sm font-medium text-ink-2">
							{reconcile ? "What this changes" : "What finalizing does"}
						</h3>
						{unchanged ? (
							<p className="mt-1.5 text-md text-text-3">Add or remove someone to see what changes.</p>
						) : !settled ? (
							<p role="status" className="mt-1.5 flex items-center gap-2 text-md text-text-3">
								<Spinner size={14} /> Working out exactly what this creates…
							</p>
						) : effects.status !== "ok" ? (
							<div role="alert" className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
								<p className="min-w-0 flex-1 text-md text-magenta-600">
									{effects.status === "lost"
										? "The list of what this creates did not load. Nothing was changed."
										: problemText(effects.code)}
								</p>
								<Button
									ref={retryRef}
									variant="secondary"
									size="sm"
									type="button"
									onClick={() => setAttempt((n) => n + 1)}
								>
									Try again
								</Button>
							</div>
						) : (
							<ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-md text-text-2">
								{effectLines(effects.value, meeting, name, mode).map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						)}
					</section>
					{vision ? (
						<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
							{owner(
								"Follow-up calls go to",
								followUp,
								setFollowUp,
								reconcile
									? "Only calls for people you add."
									: "Only people who can own follow-ups. Or leave it, and assign them later in Tasks.",
								followUpOptions,
							)}
							{reconcile
								? null
								: owner(
										"Evaluation task goes to",
										evaluation,
										setEvaluation,
										"Someone who was there.",
										evaluationOptions,
									)}
						</div>
					) : null}
					{seats && seats.status !== "ok" && vision ? (
						<p className="text-sm text-text-3">
							The list of people to assign did not load. The work will need an owner; assign it later in Tasks.
						</p>
					) : null}
					{reconcile ? (
						<Field
							label="Reason"
							hint="It stays in the history."
							error={touched && reasonMissing ? "Enter a reason." : null}
						>
							<Textarea
								ref={reasonRef}
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								maxLength={500}
								rows={2}
							/>
						</Field>
					) : null}
					<Problem text={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={!unchanged && !settled}>
						{reconcile ? "Save correction" : "Finalize"}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

const plusDays = (localDate: string, days: number) => {
	const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** The review's exact list: every follow-up call with its person, due day and owner, every advance and the task. */
function effectLines(
	r: Finalization,
	meeting: Detail,
	name: Map<string, string>,
	mode: "finalize" | "reconcile",
): string[] {
	if (r.outcome === "noop") return ["Attendance is already final with these people. Nothing changes."];
	const who = (id: string | null) => (id && name.get(id)) || "someone no longer on the list";
	// The same words as every other screen: a follow-up's owner with why they cannot own it, when they cannot.
	const owned = (w: Finalization["work"][number]) =>
		w.owner
			? `Owner: ${w.kind === "first_vision_follow_up" ? ownerText(w.owner) : w.owner.displayName}`
			: "Needs owner";
	const due = dateText(plusDays(meeting.localDate, 2));
	const counts = { first_time: 0, returning: 0, core_group: 0 };
	for (const c of r.classifications) counts[c.classification]++;
	const lines = [
		`Counts ${(Object.keys(counts) as Classification[]).map((k) => `${counts[k]} ${CLASSIFICATION_LABEL[k].toLowerCase()}`).join(", ")}.`,
		...r.work
			.filter((w) => w.kind === "first_vision_follow_up" && w.outcome !== "existing")
			.map((w) =>
				w.outcome === "closed"
					? `Follow-up call with ${who(w.personId)} closes as no longer needed. Work already done stays.`
					: w.meetingId !== meeting.id
						? `Follow-up call with ${who(w.personId)} for a later Vision meeting · ${owned(w)}`
						: `Follow-up call with ${who(w.personId)}, due ${due} · ${owned(w)}`,
			),
		...r.stageChanges.map((c) => `${who(c.personId)} moves from Prospect to Attendee.`),
		...r.work
			.filter((w) => w.kind === "meeting_evaluation" && w.outcome === "created")
			.map((w) => `Evaluation task for this meeting · ${owned(w)}`),
	];
	if (!r.work.some((w) => w.outcome !== "existing") && meeting.type !== "vision_meeting")
		lines.push("No tasks are created for this kind of meeting.");
	lines.push(
		mode === "reconcile"
			? "The history keeps the earlier list and your reason."
			: "The meeting status does not change.",
	);
	return lines;
}

/** One sentence for the result of a finalize or correction: what it created and what needs an owner. */
export function settledText(r: Finalization, title: string, mode: "finalize" | "reconcile") {
	const follow = r.work.filter((w) => w.kind === "first_vision_follow_up");
	const created = follow.filter((w) => w.outcome === "created").length;
	const closed = follow.filter((w) => w.outcome === "closed").length;
	const unowned = follow.filter((w) => w.outcome === "created" && w.needsOwner).length;
	const evaluation = r.work.find((w) => w.kind === "meeting_evaluation" && w.outcome === "created");
	if (r.outcome === "noop") return `${title}: attendance was already final with these people. Nothing changed.`;
	const parts = [
		mode === "finalize" ? `${title}: attendance is final.` : `${title}: attendance is corrected.`,
		created ? `${created} follow-up ${created === 1 ? "call" : "calls"} created.` : null,
		closed ? `${closed} closed as no longer needed.` : null,
		r.stageChanges.length ? `${peopleText(r.stageChanges.length)} moved to Attendee.` : null,
		unowned ? `${unowned} ${unowned === 1 ? "call needs" : "calls need"} an owner.` : null,
		evaluation ? `The evaluation task ${evaluation.needsOwner ? "needs an owner" : "is assigned"}.` : null,
	];
	return parts.filter(Boolean).join(" ");
}

/** The attendance list after a finalize or correction: the exact attended set and each person's classification. */
export function attendanceAfter(a: Attendance, r: Finalization): Attendance {
	const by = new Map(r.classifications.map((c) => [c.personId, c]));
	return {
		...a,
		attendanceRevision: r.attendanceRevision,
		finalized: { at: r.finalizedAt, revision: r.attendanceRevision },
		items: a.items.map((x) => {
			const c = by.get(x.person.personId);
			return c
				? { ...x, presence: "attended" as const, classification: c.classification, priorVisionId: c.priorVisionId }
				: r.removed.includes(x.person.personId)
					? { ...x, presence: "absent" as const, classification: null, priorVisionId: null }
					: x;
		}),
	};
}

// -------------------------------------------------------------------------------------------------------------
// Vision evaluation

/**
 * The Vision evaluation (REQ-MTG-014, REQ-MTG-015, REQ-MTG-016): eight human scores from 1 to 5, their average and
 * how it compares with the earlier meetings. It opens once attendance is final, because finalizing creates the task
 * the evaluation completes.
 */
export function EvaluationCard({
	evaluation,
	analytics,
	finalized,
	canWrite,
	lane,
	headerRecord,
	onRecord,
	onCorrect,
	onHistory,
	onPrefetchHistory,
}: {
	/** The page header already offers Record evaluation; the card leaves its own button out. */
	headerRecord?: boolean;
	evaluation: ShownEvaluation | null;
	analytics: Analytics | null;
	finalized: boolean;
	canWrite: boolean;
	/** The evaluation lane: while its save is on its way or unknown, nothing here starts another. */
	lane: SaveIntent<EvaluationEditing>;
	onRecord: () => void;
	onCorrect: () => void;
	onHistory: () => void;
	onPrefetchHistory: () => void;
}) {
	const compare = analytics?.evaluation ?? null;
	const saving = lane.saving;
	const held = lane.wait !== null;
	return (
		<Card as="section" aria-labelledby="evaluation-title" aria-busy={saving || undefined}>
			<CardHeader className="flex-wrap gap-y-3">
				<CardHeading className="min-w-[240px] flex-1">
					<CardTitle id="evaluation-title">Meeting evaluation</CardTitle>
					<CardDescription>
						{saving ? (
							<span className="inline-flex items-center gap-2">
								<Spinner size={12} /> Saving…
							</span>
						) : evaluation ? (
							<>
								8 factors · recorded {dateText(evaluation.evaluatedOn)}
								{evaluation.corrections.count
									? ` · corrected ${evaluation.corrections.count === 1 ? "once" : `${evaluation.corrections.count} times`}`
									: ""}
							</>
						) : (
							"8 factors, scored by people who were there"
						)}
					</CardDescription>
				</CardHeading>
				{evaluation ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="ghost"
							size="sm"
							icon={Clock01Icon}
							onClick={onHistory}
							onPointerEnter={onPrefetchHistory}
							onFocus={onPrefetchHistory}
							onTouchStart={onPrefetchHistory}
						>
							History
						</Button>
						{canWrite ? (
							<Button
								variant="secondary"
								size="sm"
								icon={Edit02Icon}
								onClick={() => !held && onCorrect()}
								aria-disabled={held || undefined}
								className={HELD}
							>
								Correct scores
							</Button>
						) : null}
					</div>
				) : null}
			</CardHeader>
			{evaluation ? (
				<>
					<div className="flex flex-wrap items-end gap-x-4 gap-y-2">
						<p className="flex items-end gap-2">
							<span className="font-display text-[40px] leading-none tracking-[-0.02em] text-ink tabular-nums">
								{scoreText(evaluation.average)}
							</span>
							<span className="pb-1.5 text-text-2">average of 5</span>
						</p>
						<Comparison compare={compare} />
					</div>
					<ul className="mt-4 grid grid-cols-4 gap-3 max-app-lg:grid-cols-2">
						{FACTORS.map((f) => (
							<li key={f.key}>
								<CardInset className="flex flex-col gap-2 px-3.5 py-3">
									<span className="flex items-baseline justify-between gap-3">
										<span className="text-sm text-text-2">{f.label}</span>
										<b className="font-semibold text-ink tabular-nums">
											{evaluation.scores[f.key]}
											<span className="sr-only"> of 5</span>
										</b>
									</span>
									<ScoreBar score={evaluation.scores[f.key]} />
								</CardInset>
							</li>
						))}
					</ul>
					{evaluation.notes ? <p className="mt-4 text-md whitespace-pre-line text-text-2">{evaluation.notes}</p> : null}
				</>
			) : !finalized ? (
				<p className="text-md text-text-3">
					The evaluation opens after attendance is final. Finalizing creates the evaluation task.
				</p>
			) : canWrite ? (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-md text-text-2">Score the meeting while it is fresh. It completes the evaluation task.</p>
					{headerRecord ? null : (
						<Button
							variant="secondary"
							size="sm"
							icon={StarIcon}
							onClick={() => !held && onRecord()}
							aria-disabled={held || undefined}
							className={HELD}
						>
							Record evaluation
						</Button>
					)}
				</div>
			) : (
				<p className="text-md text-text-3">Nobody has evaluated this meeting yet.</p>
			)}
			<SaveNotice {...lane.noticeProps} dialogOpen={lane.editing !== null} className="mt-4" />
		</Card>
	);
}

/** This evaluation against the average of up to 50 earlier ones. With none earlier, it says so instead of a 0. */
function Comparison({ compare }: { compare: Analytics["evaluation"] }) {
	if (!compare) return null;
	if (compare.baseline.status === "unknown" || compare.delta.status === "unknown")
		return <span className="pb-1.5 text-sm text-text-3">The first evaluation, so nothing to compare yet</span>;
	const d = compare.delta.value;
	const against = `the average of the last ${compare.baseline.count === 1 ? "meeting" : `${compare.baseline.count} meetings`} (${scoreText(compare.baseline.value)})`;
	return (
		<span className="inline-flex flex-wrap items-center gap-2 pb-1">
			{d === 0 ? null : (
				<DeltaChip dir={d > 0 ? "up" : "down"} size="sm">
					{deltaText(d).replace(/^[+−]/, "")}
				</DeltaChip>
			)}
			<span className="text-sm text-text-3">
				{d === 0 ? `Same as ${against}` : `${d > 0 ? "Above" : "Below"} ${against}`}
			</span>
		</span>
	);
}

/** A score from 1 to 5 as a bar; the number is written beside it, so the bar only repeats it. */
function ScoreBar({ score }: { score: number }) {
	const tone = score >= 4 ? "bg-green-500" : score === 3 ? "bg-blue-500" : "bg-amber-500";
	return (
		<span aria-hidden="true" className="flex h-1.5 overflow-hidden rounded-pill bg-surface-3">
			<span className={tone} style={{ width: `${score * 20}%` }} />
		</span>
	);
}

export type EvaluationInput = { scores: Partial<Scores>; notes: string; reason: string };
/** The open evaluation form, with what was entered when a refusal opens it again. */
export type EvaluationEditing = { input: EvaluationInput | null; problem?: string };
/** What the evaluation card shows: the saved evaluation, or the scores asked for while their save is on its way. */
export type ShownEvaluation = Pick<Evaluation, "scores" | "average" | "notes" | "evaluatedOn" | "corrections">;

/**
 * Record or correct the evaluation. The average shows as the scores are chosen; the server computes the one it keeps.
 * A correction sends only what changed, with a reason, at the revision the person saw.
 */
export function EvaluationDialog({
	open,
	evaluation,
	title,
	initial,
	problem,
	onClose,
	onSubmit,
}: {
	open: boolean;
	evaluation: Evaluation | null;
	title: string;
	initial: EvaluationInput | null;
	/** Why the last save was refused, in words. */
	problem: string | undefined;
	onClose: () => void;
	onSubmit: (input: EvaluationInput) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			{open ? (
				<EvaluationForm
					evaluation={evaluation}
					title={title}
					initial={initial}
					problem={problem}
					onClose={onClose}
					onSubmit={onSubmit}
				/>
			) : null}
		</Dialog>
	);
}

function EvaluationForm({
	evaluation,
	title,
	initial,
	problem,
	onClose,
	onSubmit,
}: Omit<Parameters<typeof EvaluationDialog>[0], "open">) {
	const correcting = evaluation !== null;
	const [scores, setScores] = useState<Partial<Scores>>(initial?.scores ?? evaluation?.scores ?? {});
	const [notes, setNotes] = useState(initial?.notes ?? evaluation?.notes ?? "");
	const [reason, setReason] = useState(initial?.reason ?? "");
	const [touched, setTouched] = useState(false);
	const missing = FACTORS.filter((f) => scores[f.key] === undefined);
	const complete = missing.length === 0;
	const changed =
		correcting &&
		(FACTORS.some((f) => scores[f.key] !== evaluation.scores[f.key]) || notes.trim() !== (evaluation.notes ?? ""));
	const first = useRef<HTMLDivElement>(null);
	const reasonRef = useRef<HTMLTextAreaElement>(null);
	return (
		<DialogContent size="lg">
			<form
				noValidate
				className="contents"
				onSubmit={(e) => {
					e.preventDefault();
					setTouched(true);
					if (!complete) {
						first.current?.querySelector<HTMLElement>(`[data-factor="${missing[0]!.key}"] button`)?.focus();
						return;
					}
					// Focus goes to the first thing to fix (F5): a score to change, then the reason.
					if (correcting && !changed)
						return first.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
					if (correcting && reason.trim() === "") return reasonRef.current?.focus();
					onSubmit({ scores, notes: notes.trim(), reason: reason.trim() });
				}}
			>
				<DialogHeader
					icon={correcting ? Edit02Icon : StarIcon}
					tone="green"
					title={correcting ? "Correct the evaluation" : "Evaluate the meeting"}
					description={title}
				/>
				<DialogBody className="flex flex-col gap-5">
					<DialogNotice />
					<div ref={first} className="flex flex-col">
						{FACTORS.map((f) => {
							const bad = touched && scores[f.key] === undefined;
							return (
								<div
									key={f.key}
									data-factor={f.key}
									className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0"
								>
									<div className="min-w-0 flex-1 basis-[220px]">
										<p id={`factor-${f.key}`} className="font-medium text-ink">
											{f.label}
										</p>
										<p className="text-sm text-text-3">{f.hint}</p>
										{bad ? (
											<p className="text-xs font-medium text-magenta-600" role="alert">
												Choose a score.
											</p>
										) : null}
									</div>
									<SegmentedControl
										label={`${f.label} score, 1 to 5`}
										value={String(scores[f.key] ?? "")}
										onValueChange={(v) => setScores((s) => ({ ...s, [f.key]: Number(v) }))}
										options={["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v }))}
									/>
								</div>
							);
						})}
					</div>
					<p className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-4 py-3" aria-live="polite">
						<span className="text-text-2">Average</span>
						<span className="font-semibold text-ink tabular-nums">
							{complete ? scoreText(averageOf(scores as Scores)) : `${8 - missing.length} of 8 scored`}
						</span>
					</p>
					<Field label="Notes" optional hint="What went well, and what to change next time.">
						<Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} rows={3} />
					</Field>
					{correcting ? (
						<Field
							label="Reason for the correction"
							hint="It stays in the history with the earlier scores."
							error={
								touched && !changed
									? "Change a score or the notes first."
									: touched && reason.trim() === ""
										? "Enter a reason."
										: null
							}
						>
							<Textarea
								ref={reasonRef}
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								maxLength={500}
								rows={2}
							/>
						</Field>
					) : null}
					<Problem text={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" type="submit">
						{correcting ? "Save correction" : "Save evaluation"}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

type History = Extract<Awaited<ReturnType<typeof evaluationHistory>>, { status: "ok" }>["value"];

/**
 * The evaluation's history, read when the person shows intent to open it. Each entry names what changed, the average
 * before and after, and the reason.
 */
export function useEvaluationHistory(meetingId: string) {
	const [got, setGot] = useState<{ revision: string; value: Outcome<History> } | null>(null);
	const asked = useRef<string | null>(null);
	function load(revision: string) {
		if (asked.current === revision) return;
		asked.current = revision;
		evaluationHistory(meetingId)
			.catch(() => ({ status: "lost" }) as const)
			.then((value) => {
				if (value.status !== "ok") asked.current = null;
				setGot({ revision, value });
			});
	}
	return { got, load };
}

export function HistoryDialog({
	open,
	onOpenChange,
	history,
	revision,
	onRetry,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	history: { revision: string; value: Outcome<History> } | null;
	revision: string;
	onRetry: () => void;
}) {
	const r = history?.revision === revision ? history.value : null;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md">
				<DialogHeader icon={Clock01Icon} title="Evaluation history" description="Oldest first" />
				<DialogBody aria-busy={r === null || undefined}>
					{r === null ? (
						<p role="status" className="flex items-center gap-2 py-4 text-sm text-text-3">
							<Spinner size={14} /> Loading the history…
						</p>
					) : r.status !== "ok" ? (
						<div role="alert" className="flex flex-col items-start gap-3 py-2">
							<p className="text-md text-text-2">The history did not load. Nothing was changed.</p>
							<Button variant="secondary" size="sm" onClick={onRetry}>
								Try again
							</Button>
						</div>
					) : (
						<ol className="flex flex-col">
							{r.value.entries.map((e) => (
								<li key={e.revision} className="flex flex-col gap-1.5 border-t border-line py-3.5 first:border-t-0">
									<p className="flex flex-wrap items-center justify-between gap-2">
										<span className="font-medium text-ink">
											{e.kind === "recorded" ? "Recorded" : "Corrected"}{" "}
											<span className="font-normal text-text-3">{dateText(e.at.slice(0, 10))}</span>
										</span>
										<span className="text-sm text-text-2 tabular-nums">
											Average{" "}
											{e.average.before === null
												? scoreText(e.average.after)
												: `${scoreText(e.average.before)} → ${scoreText(e.average.after)}`}
										</span>
									</p>
									{e.before ? (
										<p className="text-sm text-text-2">
											{FACTORS.filter((f) => e.after[f.key] !== undefined)
												.map((f) => `${f.label} ${e.before?.[f.key] ?? "–"} → ${e.after[f.key]}`)
												.join(" · ") || "Scores unchanged"}
											{e.notesChanged ? " · notes changed" : ""}
										</p>
									) : null}
									{e.reason ? <p className="text-sm text-text-3">Reason: {e.reason}</p> : null}
									{e.actor.kind === "former_account" ? (
										<p className="text-xs text-text-3">By someone who no longer has a seat</p>
									) : null}
								</li>
							))}
						</ol>
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

// -------------------------------------------------------------------------------------------------------------
// Attendee note

// -------------------------------------------------------------------------------------------------------------
// Small parts used by the guest list and the check-in screen

/** A guest's presence and, once final, how they counted. */
export function PresenceCell({
	presence,
	classification,
	final,
	state,
}: {
	presence: Presence;
	classification: Classification | null;
	/** Before attendance is final, absent only means nobody marked them yet. */
	final: boolean;
	state: RowSave | undefined;
}) {
	return (
		<div className="flex flex-col items-start gap-1">
			<StatusBadge status={PRESENCE_TONE[presence]} size="sm">
				{presence === "absent" && !final ? "Not marked" : PRESENCE_LABEL[presence]}
			</StatusBadge>
			{state === "saving" || state === "checking" ? (
				<span className="text-xs text-text-3">Saving…</span>
			) : state === "unknown" ? (
				<span className="text-xs font-medium text-ink">Not confirmed</span>
			) : classification ? (
				<span className="text-xs text-text-3">{CLASSIFICATION_LABEL[classification]}</span>
			) : null}
		</div>
	);
}
